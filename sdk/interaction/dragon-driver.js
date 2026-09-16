/**
 * hopeOS SDK — Dragon Driver (procedural winged-quadruped locomotion)
 * ═══════════════════════════════════════════════════════════════
 * Drives a rigged dragon GLB with NO baked clips: head look, walk, run
 * and flapping flight are all generated from a few gait parameters and
 * written straight onto the bones every frame (additive over the rest
 * pose, like RigPuppet). The group that hosts the model is moved by the
 * driver too (heading / forward speed / altitude), so the dragon is a
 * self-propelled game object.
 *
 * CONTRACT — the bone map is AUTHORED (DRAGON_UNIRIG below). UniRig names
 * every bone Bone_NNN and the structural auto-classifier in
 * skeleton-align.js misreads a winged body (wings → "front legs", a front
 * leg → "neck"), so the handshake is frozen by hand, from measured
 * rest-pose bone positions:
 *   forward = +Z, up = +Y, anatomical LEFT = +X (up × forward).
 *
 * AXIS DOCTRINE — every channel is a rotation about a MODEL-FRAME axis
 * (X = lateral → pitch, Y = up → yaw, Z = forward → roll / flap) expressed
 * in each bone's local space from its rest world rotation. No Euler-channel
 * guessing per bone. SIGNS ARE MEASURED at bind (never assumed): each chain
 * is nudged, the tip displacement is read back, and the sign that produces
 * the anatomical meaning (hip swings the foot FORWARD, knee LIFTS the foot,
 * neck yaw turns the snout LEFT, shoulder RAISES the wing tip…) is latched.
 *
 * GAIT MODEL (research: quadruped footfall literature, bird flap kinematics):
 *   walk — lateral sequence, leg phase offsets LH 0 · LF .25 · RH .5 · RF .75,
 *          duty factor .65 (three feet down most of the time)
 *   run  — trot, diagonal pairs in phase (LF+RH 0, RF+LH .5), duty .5,
 *          body bounce at 2× stride rate
 *   fly  — shoulder drives the stroke; elbow, wrist and wing fingers follow
 *          with increasing phase lag (tip whip); the upstroke tucks the
 *          elbow (span shrinks), the downstroke is broad; body bobs and
 *          pitches with the stroke; legs tuck; tail streams.
 *   head — yaw/pitch target damped and distributed over the neck chain,
 *          clamped (±70° yaw · ±35° pitch); look at a world point, ahead,
 *          or a slow scan.
 *
 * Usage (see mpbrowser.html engine view):
 *   const d = new DragonDriver().bind(gltf.scene);
 *   d.setMode('fly');               // idle | walk | run | fly | glide
 *   d.lookAt(camera.position);      // or d.look = { yaw, pitch } (deg)
 *   d.update(dt, hostGroup);        // per frame — poses bones, moves host
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = x => x * x * (3 - 2 * x);

export const DRAGON_UNIRIG = {
  name: 'dragon-unirig',
  axes: { forward: [0, 0, 1], up: [0, 1, 0], left: [1, 0, 0] },
  joints: {
    root: 'Bone_000',
    spine: ['Bone_001', 'Bone_004', 'Bone_003', 'Bone_002'],
    neck: ['Bone_030', 'Bone_029', 'Bone_028', 'Bone_027'],
    head: ['Bone_026', 'Bone_025', 'Bone_024'],          // 024 = snout tip
    tail: ['Bone_023', 'Bone_022', 'Bone_021', 'Bone_020', 'Bone_019', 'Bone_018', 'Bone_017', 'Bone_016', 'Bone_015'],
    // legs: [shoulder/hip, upper, lower, ankle, foot] — x>0 is LEFT
    frontL: ['Bone_042', 'Bone_041', 'Bone_040', 'Bone_039', 'Bone_038'],
    frontR: ['Bone_036', 'Bone_035', 'Bone_034', 'Bone_033', 'Bone_032'],
    hindL: ['Bone_009', 'Bone_008', 'Bone_007', 'Bone_006', 'Bone_005'],
    hindR: ['Bone_014', 'Bone_013', 'Bone_012', 'Bone_011', 'Bone_010'],
    wingL: { shoulder: 'Bone_050', arm: 'Bone_049', elbow: 'Bone_048', wrist: 'Bone_047',
             fingers: [['Bone_062', 'Bone_061', 'Bone_060'], ['Bone_065', 'Bone_064', 'Bone_063'], ['Bone_068', 'Bone_067', 'Bone_066']] },
    wingR: { shoulder: 'Bone_046', arm: 'Bone_045', elbow: 'Bone_044', wrist: 'Bone_043',
             fingers: [['Bone_053', 'Bone_052', 'Bone_051'], ['Bone_056', 'Bone_055', 'Bone_054'], ['Bone_059', 'Bone_058', 'Bone_057']] },
  },
  // model-unit tuning (mesh is ~3.3 long nose→tail, 1.7 tall, 4.1 span)
  strideLen: 0.9,          // model units per stride (walk)
  gait: {
    walk: { speed: 0.9, freq: 1.1, duty: 0.65, hip: 22, knee: 36, lift: 1.0, bob: 0.012, offsets: { hindL: 0, frontL: 0.25, hindR: 0.5, frontR: 0.75 } },
    run:  { speed: 3.2, freq: 2.2, duty: 0.5,  hip: 34, knee: 50, lift: 1.4, bob: 0.03,  offsets: { frontL: 0, hindR: 0, frontR: 0.5, hindL: 0.5 } },
    fly:  { speed: 3.6, freq: 1.6, flap: 38, elbow: 22, finger: 18, tuck: 26, bob: 0.06, climb: 1.4, alt: 2.6 },
    glide: { speed: 4.5, freq: 0.35, flap: 6, elbow: 4, finger: 6, tuck: 26, bob: 0.02, climb: 1.0, alt: 2.6 },
  },
  turnRate: 0.9,           // rad/s at full steer
  look: { yawMax: 70, pitchMax: 35, damp: 6 },
};

/** Structural sanity check used by the host before binding (a wrong GLB
 *  must fail loudly, not silently pose the wrong bones). */
export function dragonContractMatches(scene, contract = DRAGON_UNIRIG) {
  const names = new Set();
  scene.traverse(o => { if (o.isBone) names.add(o.name); });
  const j = contract.joints;
  const need = [j.root, ...j.spine, ...j.neck, ...j.head, ...j.tail, ...j.frontL, ...j.frontR, ...j.hindL, ...j.hindR,
    j.wingL.shoulder, j.wingL.arm, j.wingL.elbow, j.wingL.wrist, j.wingR.shoulder, j.wingR.arm, j.wingR.elbow, j.wingR.wrist];
  const missing = need.filter(n => !names.has(n));
  return { ok: missing.length === 0, missing, bones: names.size };
}

const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

export class DragonDriver {
  constructor(contract = DRAGON_UNIRIG) {
    this.c = contract;
    this.root = null;
    this.bones = {};
    this.rest = {};          // name → { q, p }
    this.local = {};         // name → { x, y, z } model axes in bone-local space (rest)
    this.sign = {};          // measured channel signs — see _calibrate
    this._acc = {};          // name → THREE.Quaternion accumulated this frame
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._m = new THREE.Matrix4();

    // ── state ──
    this.mode = 'idle';      // idle | walk | run | fly | glide
    this.auto = true;        // roam: steer itself in a wide loop
    this.input = { fwd: 0, turn: 0, climb: 0 };   // manual drive, −1..1
    this.speed = 0;          // current forward speed (model units/s)
    this.heading = 0;        // rad, world yaw of the host
    this.altitude = 0;       // model units above ground
    this.cruiseAlt = contract.gait.fly.alt;   // where flight levels off (R/F nudge it)
    this.airborne = 0;       // 0 ground … 1 flying (blend)
    this.w = { walk: 0, run: 0, fly: 0, glide: 0 };   // blend weights
    this.phase = 0;          // gait phase 0..1
    this.flapPhase = 0;      // wing stroke phase 0..1
    this.t = 0;
    this.look = { yaw: 0, pitch: 0 };          // current (damped), deg, yaw>0 = left
    this.lookTarget = { yaw: 0, pitch: 0 };
    this.lookMode = 'ahead'; // ahead | point | scan | user
    this._lookPt = new THREE.Vector3();
    this.landed = null;      // callback when a landing completes
    // ── user embodiment (WingDrive state: arm angles → wing angles) ──
    this.user = null;        // latest WingDrive state or null
    this.userW = 0;          // 0 procedural wings … 1 user's arms are the wings
    this.restWing = {};      // wingL/wingR → rest elevation/sweep of arm + forearm (deg)
    this.climbMul = 1;       // multiplies the gait climb rate (user flight climbs harder)
    this.dive = 0;           // 0..1 — nose-down dive (speed up, pitch down, tail up)
    this.bank = 0;           // −1..1 extra bank flavour (user lean)
  }

  /** Bind to a loaded GLB scene (in bind pose). Captures rest, measures signs. */
  bind(scene) {
    this.root = scene;
    scene.traverse(o => {
      if (o.isBone) {
        this.bones[o.name] = o;
        this.rest[o.name] = { q: o.quaternion.clone(), p: o.position.clone() };
      }
    });
    const chk = dragonContractMatches(scene, this.c);
    if (!chk.ok) throw new Error('dragon contract mismatch — missing ' + chk.missing.join(','));
    this._captureAxes();
    this._calibrate();
    return this;
  }

  // model-frame axes in each bone's rest-local space: a_local = W⁻¹·a with W the
  // bone's rest rotation relative to the model root
  _captureAxes() {
    this.root.updateWorldMatrix(true, true);
    const rootQ = new THREE.Quaternion(); this.root.getWorldQuaternion(rootQ);
    const rootInv = rootQ.clone().invert();
    const wq = new THREE.Quaternion();
    for (const [name, b] of Object.entries(this.bones)) {
      b.getWorldQuaternion(wq);
      const rel = rootInv.clone().multiply(wq).invert();   // model → bone-local
      this.local[name] = {
        x: AXIS.x.clone().applyQuaternion(rel).normalize(),
        y: AXIS.y.clone().applyQuaternion(rel).normalize(),
        z: AXIS.z.clone().applyQuaternion(rel).normalize(),
      };
    }
  }

  /** Model-frame position of a bone (root-relative, rest scale). */
  modelPos(name, out = new THREE.Vector3()) {
    const b = this.bones[name];
    b.updateWorldMatrix(true, false);
    this._m.copy(this.root.matrixWorld).invert();
    return out.setFromMatrixPosition(b.matrixWorld).applyMatrix4(this._m);
  }

  _rot(name, axis, deg) {                       // accumulate a model-axis rotation on a bone
    if (!deg) return;
    const L = this.local[name]; if (!L) return;
    const q = this._acc[name] || (this._acc[name] = new THREE.Quaternion());
    q.multiply(this._q.setFromAxisAngle(L[axis], deg * D2R));
  }
  _reset() {
    for (const [name, r] of Object.entries(this.rest)) {
      const b = this.bones[name];
      b.quaternion.copy(r.q); b.position.copy(r.p);
    }
    for (const q of Object.values(this._acc)) q.identity();
  }
  _commit() {
    for (const [name, q] of Object.entries(this._acc)) {
      if (q.w === 1) continue;
      this.bones[name].quaternion.copy(this.rest[name].q).multiply(q);
    }
  }

  // ── SIGN CALIBRATION — nudge, measure the tip, latch the anatomical sign ──
  _probe(name, axis, deg, tip, comp) {
    this._reset();
    this.root.updateWorldMatrix(true, true);
    const p0 = this.modelPos(tip, this._v).clone();
    this._rot(name, axis, deg); this._commit();
    this.root.updateWorldMatrix(true, true);
    const p1 = this.modelPos(tip, this._v2);
    this._reset();
    const d = p1[comp] - p0[comp];
    return Math.abs(d) < 1e-7 ? 1 : Math.sign(d);
  }
  _calibrate() {
    const j = this.c.joints, S = this.sign;
    for (const leg of ['frontL', 'frontR', 'hindL', 'hindR']) {
      const [, upper, lower, , foot] = j[leg];
      S[leg] = {
        hipFwd: this._probe(upper, 'x', 10, foot, 'z'),   // + → foot forward
        kneeUp: this._probe(lower, 'x', 10, foot, 'y'),   // + → foot lifts
      };
    }
    const snout = j.head[j.head.length - 1];
    S.neckLeft = this._probe(j.neck[1], 'y', 10, snout, 'x');   // + → snout to +x (LEFT)
    S.neckUp = this._probe(j.neck[1], 'x', 10, snout, 'y');     // + → snout up
    S.tailLeft = this._probe(j.tail[0], 'y', 10, j.tail[j.tail.length - 1], 'x');
    S.tailUp = this._probe(j.tail[0], 'x', 10, j.tail[j.tail.length - 1], 'y');
    for (const side of ['wingL', 'wingR']) {
      const W = j[side], tip = W.fingers[1][1];
      S[side] = {
        raise: this._probe(W.arm, 'z', 10, tip, 'y'),           // + → wing tip up
        elbowRaise: this._probe(W.elbow, 'z', 10, tip, 'y'),
        wristRaise: this._probe(W.wrist, 'z', 10, tip, 'y'),
        tuckBack: this._probe(W.elbow, 'y', 10, tip, 'z') * -1, // + → tip sweeps BACK (−z)
        armBack: this._probe(W.arm, 'y', 10, tip, 'z') * -1,    // + → whole wing sweeps back
      };
      // rest geometry of the wing "arm" (drum) and "forearm" (flat) in the
      // user's angle language, so a user holding the dragon's own rest pose
      // maps to zero offset: elev = above the shoulder line, sweep = forward
      this._reset(); this.root.updateWorldMatrix(true, true);
      const p0 = this.modelPos(W.arm).clone(), p1 = this.modelPos(W.elbow).clone(), p2 = this.modelPos(W.wrist).clone();
      const seg = (a, b) => { const dx = Math.abs(b.x - a.x) || 1e-6; return { elev: Math.atan2(b.y - a.y, dx) / D2R, sweep: Math.atan2(b.z - a.z, dx) / D2R }; };
      this.restWing[side] = { arm: seg(p0, p1), fore: seg(p1, p2) };
    }
    S.spineUp = this._probe(j.spine[1], 'x', 10, snout, 'y');   // + → chest pitches up
    this.root.updateWorldMatrix(true, true);
  }

  // ── public controls ──
  setMode(m) {
    if (!['idle', 'walk', 'run', 'fly', 'glide'].includes(m)) return;
    this.mode = m;
  }
  /** Look at a world-space point (host frame resolved in update). */
  lookAt(worldPt) { this.lookMode = 'point'; this._lookPt.copy(worldPt); }
  lookAhead() { this.lookMode = 'ahead'; }
  lookScan() { this.lookMode = 'scan'; }
  lookUser() { this.lookMode = 'user'; }
  /** Feed a WingDrive state (or null to hand the wings back to the gait). */
  setUserWings(st) { this.user = st || null; }   // head applies whenever seen; wings only while st.valid

  /**
   * @param {number} dt seconds
   * @param {THREE.Object3D|null} host object to move (heading / position / altitude)
   */
  update(dt, host = null) {
    dt = clamp(dt, 0, 0.1);
    this.t += dt;
    const g = this.c.gait, m = this.mode;

    // ── mode blend weights (~250 ms crossfades) ──
    const want = { walk: m === 'walk' ? 1 : 0, run: m === 'run' ? 1 : 0, fly: m === 'fly' ? 1 : 0, glide: m === 'glide' ? 1 : 0 };
    for (const k of Object.keys(this.w)) this.w[k] += clamp(want[k] - this.w[k], -dt * 4, dt * 4);
    const wantAir = (m === 'fly' || m === 'glide') ? 1 : 0;

    // ── locomotion: speed / heading / altitude ──
    const airMode = m === 'fly' ? g.fly : m === 'glide' ? g.glide : null;
    const targetSpeed = (m === 'walk' ? g.walk.speed : m === 'run' ? g.run.speed : airMode ? airMode.speed : 0) * (1 + 0.55 * this.dive);
    const drive = this.auto ? 1 : this.input.fwd;
    this.speed += clamp(targetSpeed * drive - this.speed, -dt * 3, dt * 3);
    const steer = this.auto ? (m === 'idle' ? 0 : 0.42) : this.input.turn;
    if (Math.abs(this.speed) > 0.02 || !this.auto) this.heading += steer * this.c.turnRate * dt * Math.min(1, Math.abs(this.speed) / 0.5 + (this.auto ? 0 : 0.5));
    // altitude: fly/glide climb toward the cruise height (manual climb overrides);
    // leaving the air descends until touchdown, which hands the mode back to idle
    if (airMode) {
      // cruise height: the gait's default, nudged by the manual climb input (R/F)
      if (!this.auto && this.input.climb) this.cruiseAlt = clamp(this.cruiseAlt + this.input.climb * airMode.climb * dt, 0.4, 12);
      const cr = airMode.climb * this.climbMul;
      this.altitude += clamp(this.cruiseAlt - this.altitude, -cr * dt, cr * dt);
    } else if (this.altitude > 0) {
      this.altitude = Math.max(0, this.altitude - 1.6 * dt);
      if (this.altitude === 0 && this.landed) { const f = this.landed; this.landed = null; f(); }
    }
    this.airborne += clamp((wantAir || this.altitude > 0.05 ? 1 : 0) - this.airborne, -dt * 2.5, dt * 2.5);
    this.userW += clamp((this.user && this.user.valid ? 1 : 0) - this.userW, -dt * 4, dt * 4);

    if (host) {
      const s = host.scale.x || 1;
      // the gizmo / a scene restore may have rotated or lifted the host since
      // we last wrote it — adopt that as the new heading / altitude
      if (this._hostY !== undefined && Math.abs(host.rotation.y - this._hostY) > 1e-6) this.heading = host.rotation.y;
      if (this._hostAlt !== undefined && Math.abs(host.position.y - this._hostAlt) > 1e-6) this.altitude = Math.max(0, host.position.y / s);
      host.rotation.y = this.heading;
      host.position.x += Math.sin(this.heading) * this.speed * s * dt;
      host.position.z += Math.cos(this.heading) * this.speed * s * dt;
      host.position.y = this.altitude * s;
      this._hostY = host.rotation.y; this._hostAlt = host.position.y;
    }

    // ── phases ──
    const groundW = this.w.walk + this.w.run;
    const gaitFreq = groundW > 0 ? (g.walk.freq * this.w.walk + g.run.freq * this.w.run) / groundW : 0;
    const paceRatio = targetSpeed > 0 ? Math.abs(this.speed) / targetSpeed : 1;
    if (gaitFreq > 0 && Math.abs(this.speed) > 0.02) this.phase = (this.phase + gaitFreq * dt * Math.max(0.35, paceRatio)) % 1;
    const flapFreq = this.w.fly * g.fly.freq + this.w.glide * g.glide.freq;
    if (flapFreq > 0) this.flapPhase = (this.flapPhase + flapFreq * dt / Math.max(0.05, this.w.fly + this.w.glide)) % 1;

    // ── head look target ──
    this._updateLook(dt, host);

    // ── pose ──
    this._reset();
    this._poseHead();
    this._poseLegs(groundW);
    this._poseWings();
    this._poseBodyTail();
    this._commit();
  }

  _updateLook(dt, host) {
    const L = this.c.look, T = this.lookTarget;
    if (this.lookMode === 'point' && host) {
      const p = this._v.copy(this._lookPt);
      host.worldToLocal(p);                                   // model frame: +z ahead, +x left
      const eye = this.modelPos(this.c.joints.neck[2], this._v2);
      p.sub(eye);
      T.yaw = Math.atan2(p.x, p.z) / D2R;
      T.pitch = Math.atan2(p.y, Math.hypot(p.x, p.z)) / D2R;
    } else if (this.lookMode === 'scan') {
      T.yaw = Math.sin(this.t * 0.7) * 45; T.pitch = Math.sin(this.t * 1.1) * 12;
    } else if (this.lookMode === 'user') {          // the user's tracked head turns the dragon's
      const H = this.user && this.user.head;
      if (H && H.seen) { T.yaw = H.yaw; T.pitch = H.pitch; } else { T.yaw = 0; T.pitch = 0; }
    } else { T.yaw = 0; T.pitch = 0; }
    // while walking the head tracks the turn a little (lead the body)
    if (this.lookMode === 'ahead' && !this.auto) T.yaw += this.input.turn * 25;
    T.yaw = clamp(T.yaw, -L.yawMax, L.yawMax); T.pitch = clamp(T.pitch, -L.pitchMax, L.pitchMax);
    const k = 1 - Math.exp(-L.damp * dt);
    this.look.yaw += (T.yaw - this.look.yaw) * k;
    this.look.pitch += (T.pitch - this.look.pitch) * k;
  }

  _poseHead() {
    const j = this.c.joints, S = this.sign;
    const chain = [...j.neck, ...j.head];
    // distribute: neck bones carry most of the yaw, head bones finish it
    const wts = [0.16, 0.2, 0.22, 0.18, 0.12, 0.08, 0.04];
    const air = this.airborne;
    const flap = Math.sin(this.flapPhase * Math.PI * 2);
    for (let i = 0; i < chain.length; i++) {
      const w = wts[i] || 0;
      this._rot(chain[i], 'y', S.neckLeft * this.look.yaw * w);
      this._rot(chain[i], 'x', S.neckUp * this.look.pitch * w);
      // flight: neck stretches forward (raise), bobs against the stroke
      if (air > 0.001 && i < 4) this._rot(chain[i], 'x', S.neckUp * air * (5 - flap * 2.5 * this.w.fly));
      // walking: gentle head nod at stride rate
      if (this.w.walk + this.w.run > 0.001 && i < 4)
        this._rot(chain[i], 'x', S.neckUp * Math.sin(this.phase * Math.PI * 4) * (1.5 * this.w.walk + 2.5 * this.w.run));
    }
  }

  // stance: hip sweeps foot back linearly; swing: eased return forward + knee lift
  _legCycle(p, duty) {
    if (p < duty) { const s = p / duty; return { hip: 1 - 2 * s, knee: 0 }; }
    const s = (p - duty) / (1 - duty);
    return { hip: -1 + 2 * smooth(s), knee: Math.sin(s * Math.PI) };
  }
  _poseLegs(groundW) {
    const j = this.c.joints, S = this.sign, g = this.c.gait, air = this.airborne;
    for (const leg of ['frontL', 'frontR', 'hindL', 'hindR']) {
      const [, upper, lower, ankle, foot] = j[leg], sg = S[leg];
      let hip = 0, knee = 0;
      for (const k of ['walk', 'run']) {
        const w = this.w[k]; if (w < 0.001) continue;
        const G = g[k], c = this._legCycle((this.phase + G.offsets[leg]) % 1, G.duty);
        hip += w * c.hip * G.hip;
        knee += w * c.knee * G.knee * G.lift;
      }
      // flight tuck: legs draw up under the body, knees folded
      const front = leg.startsWith('front');
      const tuck = air * (front ? 1 : 1.15);
      this._rot(upper, 'x', sg.hipFwd * (hip * (1 - air) + tuck * (front ? -24 : 30)));
      this._rot(lower, 'x', sg.kneeUp * (knee * (1 - air) + tuck * 55));
      this._rot(ankle, 'x', sg.kneeUp * (-knee * 0.3 * (1 - air) - tuck * 25));
      this._rot(foot, 'x', sg.kneeUp * (-knee * 0.4 * (1 - air)));
    }
  }

  _poseWings() {
    const j = this.c.joints, S = this.sign, g = this.c.gait;
    const fw = this.w.fly, gw = this.w.glide, ground = 1 - this.airborne;
    const ph = this.flapPhase * Math.PI * 2;
    // asymmetric stroke: quick, broad downstroke — slower tucked upstroke
    const stroke = (lag) => {
      const x = ph - lag;
      const s = Math.sin(x);
      return s > 0 ? Math.pow(s, 0.8) : -Math.pow(-s, 1.3);   // + = up
    };
    for (const side of ['wingL', 'wingR']) {
      const W = j[side], sg = S[side];
      // ground: wings rest half-folded (tucked back, slightly lowered), breathing
      const breathe = Math.sin(this.t * 1.3) * 1.5;
      const restDrop = ground * (-8 + breathe);
      const restTuck = ground * 34;
      let arm = restDrop, elbow = 0, wrist = 0, fing = 0, tuck = restTuck;
      for (const [w, G] of [[fw, g.fly], [gw, g.glide]]) {
        if (w < 0.001) continue;
        const s0 = stroke(0), s1 = stroke(0.35), s2 = stroke(0.7), s3 = stroke(1.0);
        arm += w * (G.flap * s0 + 6);                      // slight dihedral bias
        elbow += w * G.elbow * s1;
        wrist += w * G.elbow * 0.6 * s2;
        fing += w * G.finger * s3;
        // upstroke folds the span (elbow sweeps the tip back), downstroke opens
        tuck += w * G.tuck * clamp(-s1, 0, 1);
      }
      let armSweep = 0;
      // ── USER EMBODIMENT: the tracked upper arm IS the wing's drum, the forearm
      //    its flat. Angles are offsets from each segment's REST elevation/sweep
      //    (measured at bind), so a user mirroring the dragon's spread pose maps
      //    to zero and arms held straight out lay the wing flat.
      const uw = this.userW;
      if (uw > 0.001 && this.user && this.user.valid) {
        const U = this.user[side === 'wingL' ? 'L' : 'R'], R = this.restWing[side];
        const uArm = U.elev - R.arm.elev;
        const uElbow = clamp((U.elevF - U.elev) - (R.fore.elev - R.arm.elev), -70, 110);
        const uSweepA = -(U.sweep - R.arm.sweep) * 0.5;                          // + = back
        const uTuck = clamp(-((U.sweepF - U.sweep) - (R.fore.sweep - R.arm.sweep)) * 0.5, -40, 60);
        arm = arm + (uArm - arm) * uw;
        elbow = elbow + (uElbow - elbow) * uw;
        wrist = wrist + (uElbow * 0.25 - wrist) * uw;
        fing = fing + (uElbow * 0.15 - fing) * uw;
        tuck = tuck + (uTuck - tuck) * uw;
        armSweep = uSweepA * uw;
      }
      this._rot(W.arm, 'z', sg.raise * arm);
      this._rot(W.arm, 'y', sg.armBack * armSweep);
      this._rot(W.elbow, 'z', sg.elbowRaise * elbow);
      this._rot(W.elbow, 'y', sg.tuckBack * tuck);
      this._rot(W.wrist, 'z', sg.wristRaise * wrist);
      this._rot(W.wrist, 'y', sg.tuckBack * tuck * 0.5);
      for (const chain of W.fingers) {
        this._rot(chain[0], 'z', sg.wristRaise * fing * 0.6);
        this._rot(chain[1], 'z', sg.wristRaise * fing * 0.4);
      }
    }
  }

  _poseBodyTail() {
    const j = this.c.joints, S = this.sign, g = this.c.gait, air = this.airborne;
    const root = this.bones[j.root];
    const flap = Math.sin(this.flapPhase * Math.PI * 2 - 0.6);   // body follows the stroke a beat late
    // vertical bob
    let bob = 0;
    bob += this.w.walk * g.walk.bob * Math.sin(this.phase * Math.PI * 4);
    bob += this.w.run * g.run.bob * Math.sin(this.phase * Math.PI * 4);
    bob += (this.w.fly * g.fly.bob + this.w.glide * g.glide.bob) * flap * (1 - this.userW);
    // user wings: the body heaves with the real stroke (downstroke lifts)
    if (this.userW > 0.001 && this.user && this.user.valid) bob += this.userW * clamp(-this.user.elevVel / 300, -1, 1) * 0.05 * Math.max(air, 0.3);
    root.position.y += bob;
    // body pitch: run leans in, flight noses up (more while climbing), turns bank
    const climbing = air > 0.5 && (this.mode === 'fly' || this.mode === 'glide') ? clamp((this.c.gait.fly.alt - this.altitude) * 6, -10, 12) : 0;
    const pitchUp = -this.w.run * 4 + air * (6 + climbing) + this.w.fly * flap * 2.5 - air * this.dive * 24;   // dive: nose down
    for (const sp of j.spine) this._rot(sp, 'x', S.spineUp * pitchUp * 0.25);
    const bank = air * this.speed * ((this.auto ? 0.42 : this.input.turn) + this.bank * 0.5) * 5;
    for (const sp of j.spine) this._rot(sp, 'z', bank * 0.25);
    // tail: side wave on the ground (counter-swing to the stride), streaming in flight
    const n = j.tail.length;
    for (let i = 0; i < n; i++) {
      const f = (i + 1) / n;
      const sway = (this.w.walk * 4 + this.w.run * 6) * Math.sin(this.phase * Math.PI * 2 - f * 1.8);
      const idle = (1 - air) * 2.2 * Math.sin(this.t * 0.9 - f * 1.6);
      const stream = air * (5 * f + flap * 3 * f * this.w.fly);
      const steerSwish = (this.auto ? 0.42 : this.input.turn) * (this.w.walk + this.w.run + air) * 6 * f;
      this._rot(j.tail[i], 'y', S.tailLeft * (sway + idle + steerSwish));
      this._rot(j.tail[i], 'x', S.tailUp * (stream - climbing * 0.4 * f + air * this.dive * 10 * f));
    }
  }
}
