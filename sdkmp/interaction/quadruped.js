/**
 * hopeOS SDK — Quadruped Driver
 * ═══════════════════════════════════════════════════════════════
 * The PUPPET half of the body movement contract, executable — consumes
 * contract-keyed body values (BodyProbe) + gesture events
 * (BodyGestureDetector) and drives a rigged quadruped GLB.
 *
 * Everything asset-specific comes from the contract JSON (fox.body.
 * contract.json): joint names, clip names, per-channel bone/axis/sign/
 * gain/clamp, gait rules, speed caps. This class is the generic machine.
 *
 * TRANSLATION MODEL (stance mapping: standing-drives-crawl):
 *   standing human           = fox neutral on all fours
 *   arm/leg raise channels   → additive bone lift (give-paw)
 *   raise→lower CYCLES       → gait steps; cadence → Walk weight,
 *                              playbackRate, forward speed
 *   body.lean                → steering (heading yaw rate)
 *   body.crouch              → root drop + spine curl
 *   head.rot (face contract) → neck bone — the face stack merges here
 *   jump/squat/dash/kick     → pounce / crouch / gallop / hind-kick
 *
 * ADDITIVE-OVER-CLIP: the AnimationMixer writes the clip pose each
 * frame, THEN per-limb offsets are added on top, faded out as Walk
 * weight rises so manual lifts never fight the gait animation.
 *
 * Usage (see foxlab.html):
 *   const fox = new QuadrupedDriver(contractJson);
 *   fox.bind(gltf.scene, gltf.animations);        // after GLTFLoader
 *   fox.pounce(); fox.kick('L', 1); fox.dash(true);   // gesture events
 *   fox.update(bodyValues, headState, dt);        // per frame
 */

import * as THREE from 'three';
import { graphFromScene, classifySkeleton, alignBodyContract } from './skeleton-align.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const LIMB_CHANNELS = ['limb.armL.raise', 'limb.armR.raise', 'limb.legL.raise', 'limb.legR.raise'];

export class QuadrupedDriver {
  constructor(contract) {
    this.c = contract;
    this.root = null;          // the object we translate/steer (glb scene)
    this.mixer = null;
    this.actions = {};         // idle | walk | run
    this.bones = {};           // name → THREE.Bone
    this.heading = 0;          // radians, world yaw
    this.foxLen = 1;           // world length along forward axis
    this.baseY = 0;

    // gait state
    this._limbUp = {};         // channel id → currently past threshold
    this._steps = [];          // timestamps of completed steps
    this.cadence = 0;
    this.speed = 0;            // world units/s
    this.mode = 'idle';

    // gesture timers
    this._pounceT = -1;
    this._kick = { L: -1, R: -1, str: { L: 1, R: 1 } };
    this._dodge = { t: -1, dir: 1 };
    this._dashUntil = 0;
    this._lastStepAt = 0;
  }

  /** Bind to a loaded GLB. Call once after GLTFLoader resolves. */
  bind(scene, animations) {
    this.root = scene;
    this.mixer = new THREE.AnimationMixer(scene);
    const clips = this.c.puppet.clips;
    for (const key of ['idle', 'walk', 'run']) {
      const clip = animations.find(a => a.name === clips[key]);
      if (clip) {
        this.actions[key] = this.mixer.clipAction(clip);
        this.actions[key].play();
        this.actions[key].setEffectiveWeight(key === 'idle' ? 1 : 0);
      }
    }
    scene.traverse(o => { if (o.isBone) this.bones[o.name] = o; });

    // ── AUTO-ALIGN (skeleton-align.js): detect the rig's landmarks from
    // structure+names, fill any joints the contract left null, and VERIFY
    // the authored ones. Authored entries always win (frozen handshake);
    // this.alignment.verify/conflicts carry the evidence for panels.
    this.alignment = alignBodyContract(this.c,
      classifySkeleton(graphFromScene(scene), { forwardHint: this.c.puppet.forward_axis_local }));
    this.c.puppet.joints = this.alignment.joints;

    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const fwd = new THREE.Vector3(...this.c.puppet.forward_axis_local);
    this.foxLen = Math.abs(size.dot(fwd)) || size.length() * 0.6;
    this.baseY = scene.position.y;
    return this;
  }

  // ── Gesture events (wire from BodyGestureDetector) ──
  pounce() { if (this._pounceT < 0) this._pounceT = 0; }
  kick(side, strength = 1) { this._kick[side] = 0; this._kick.str[side] = clamp(strength, 0.4, 2); }
  dodge(dir = 1) { this._dodge.t = 0; this._dodge.dir = dir; }
  dash(active) { if (active) this._dashUntil = performance.now() + 600; }

  /**
   * @param {Object} v         BodyProbe.values (contract-keyed)
   * @param {Object|null} head PuppetInput.state.head (deg) — face contract merge
   * @param {number} dt        seconds
   */
  update(v, head, dt) {
    if (!this.mixer || !dt) return;
    const now = performance.now();
    const gait = this.c.gait;

    // ── steps: raise threshold crossings per limb ──
    for (const ch of LIMB_CHANNELS) {
      const up = (v[ch] ?? -1) > gait.step_threshold_raise;
      if (this._limbUp[ch] && !up) {        // completed a cycle = one step
        this._steps.push(now);
        this._lastStepAt = now;
      }
      this._limbUp[ch] = up;
    }
    const win = gait.cadence_window_s * 1000;
    this._steps = this._steps.filter(t => now - t < win);
    this.cadence = this._steps.length / gait.cadence_window_s;

    // ── mode + clip weights ──
    const dashing = now < this._dashUntil;
    const pouncing = this._pounceT >= 0;
    const idleFor = now - this._lastStepAt;
    let walkW = clamp(this.cadence / gait.walk_full_weight_at_cadence, 0, 1);
    if (idleFor > gait.idle_after_ms) walkW = 0;
    let runW = 0;
    if (dashing) { runW = 1; walkW = 0; }
    if (pouncing) { runW = Math.max(runW, 0.8); }
    this.mode = pouncing ? 'pounce' : dashing ? 'gallop' : walkW > 0.05 ? 'walk' : 'idle';
    this._weight('walk', walkW, dt);
    this._weight('run', runW, dt);
    this._weight('idle', clamp(1 - walkW - runW, 0, 1), dt);
    if (this.actions.walk) {
      this.actions.walk.timeScale = clamp(this.cadence / 1.9, 0.5, 1.6);
    }

    // ── steering from lean ──
    const leanCh = this.c.channels.find(ch => ch.id === 'body.lean');
    const lean = v['body.lean'] ?? 0;
    const dz = leanCh.map.deadzone_deg;
    if (Math.abs(lean) > dz) {
      const f = clamp((Math.abs(lean) - dz) / (35 - dz), 0, 1) * Math.sign(lean);
      // mirrored embodiment: lean left steers the away-facing fox left
      this.heading -= f * leanCh.map.deg_per_sec_at_full * D2R * dt;
    }
    this.root.rotation.y = this.heading;

    // ── forward motion ──
    const caps = this.c.constraints.speed_caps;
    let fl = Math.min(this.cadence * 0.32, caps.forward_fox_lengths_s);   // fox-lengths/s
    if (dashing) fl *= 2.2;
    this.speed = fl * this.foxLen;
    if (this.speed > 1e-4 || pouncing) {
      const fwd = new THREE.Vector3(...this.c.puppet.forward_axis_local)
        .applyQuaternion(this.root.quaternion);
      let dist = this.speed * dt;
      if (pouncing) dist += (0.5 * this.foxLen) * (dt / 0.6);   // lunge
      this.root.position.addScaledVector(fwd, dist);
    }

    // ── clip pose first, then additive offsets on top ──
    this.mixer.update(dt);

    for (const ch of this.c.channels) {
      const t = ch.puppet.target;
      if (!t) continue;
      if (t.kind === 'bone_rot_additive' && !t.axes) {
        const raw = v[ch.id];
        if (raw === undefined) continue;
        const dz2 = ch.map.deadzone ?? 0;
        const rest = ch.map.rest_offset ?? 0;
        const val = Math.max(0, (raw - rest) - dz2);
        if (val <= 0) continue;
        const deg = clamp(val * ch.map.gain_deg, ch.map.clamp_deg[0], ch.map.clamp_deg[1]);
        // fade manual lift as the gait owns the legs (constraints.additive_over_clip)
        const w = 1 - walkW;
        this._addRot(t.bone, t.axis, deg * (t.sign ?? 1) * w);
      } else if (t.kind === 'composite' && ch.id === 'body.crouch') {
        const cr = v['body.crouch'] ?? 0;
        for (const part of t.parts) {
          if (part.kind === 'root_translate') {
            this.root.position.y = this.baseY + cr * part.gain * this.foxLen * 0.4;
          } else if (part.kind === 'bone_rot_additive') {
            this._addRot(part.bone, part.axis, cr * part.gain_deg * (part.sign ?? 1));
          }
        }
      }
    }

    // head from the FACE contract (deg, mirrored-view convention)
    if (head?.seen) {
      const hc = this.c.channels.find(ch => ch.id === 'head.rot');
      const g = hc.map.gain, [lo, hi] = hc.map.clamp_deg;
      const b = this.bones[hc.puppet.target.bone];
      if (b) {
        b.rotation.y += clamp(-head.yaw * g, lo, hi) * D2R;   // mirror: fox faces away
        b.rotation.x += clamp(-head.pitch * g, lo, hi) * D2R;
        b.rotation.z += clamp(head.roll * g, lo, hi) * D2R;
      }
    }

    // ── gesture bursts ──
    if (pouncing) {
      this._pounceT += dt;
      const p = this._pounceT / 0.6;
      if (p >= 1) { this._pounceT = -1; this.root.position.y = this.baseY; }
      else this.root.position.y = this.baseY + Math.sin(p * Math.PI) * 0.35 * this.foxLen * 0.45;
    }
    for (const side of ['L', 'R']) {
      if (this._kick[side] < 0) continue;
      this._kick[side] += dt;
      const p = this._kick[side] / 0.35;
      if (p >= 1) { this._kick[side] = -1; continue; }
      const chain = this.c.puppet.joints['hind' + side];
      this._addRot(chain[0], 'x', Math.sin(p * Math.PI) * 55 * this._kick.str[side]);
    }
    if (this._dodge.t >= 0) {
      this._dodge.t += dt;
      const p = this._dodge.t / 0.25;
      if (p >= 1) this._dodge.t = -1;
      else {
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
        this.root.position.addScaledVector(side, this._dodge.dir * 0.25 * this.foxLen * dt / 0.25);
      }
    }
  }

  _weight(key, target, dt) {
    const a = this.actions[key];
    if (!a) return;
    const w = a.getEffectiveWeight();
    a.setEffectiveWeight(w + clamp(target - w, -dt * 4, dt * 4));  // ~250ms fade
  }

  _addRot(boneName, axis, deg) {
    const b = this.bones[boneName];
    if (b) b.rotation[axis] += deg * D2R;
  }
}
