/**
 * hopeOS SDK — Biped Driver v4: FK retargeting + palm-basis hands + human constraints
 * ═══════════════════════════════════════════════════════════════
 * Local (no-cloud) body sync for humanoid avatars.
 *
 * v3 fixed the mirror mapping (signs in ONE tunable, ghost-verified) and
 * the solve dynamics (full delta from rest + One-Euro on directions,
 * hold-then-fade on dropouts). v4 adds the two things the lab showed
 * still wrong:
 *
 * 1. REAL HANDS (the problem this stack solved long ago — hands.js
 *    buildFrame() — now ported to bones). Scalar curls can't represent
 *    which finger is up or which way the palm faces. v4:
 *      · palm ORIENTATION (handlab/HoloHandRig doctrine): One-Euro the 21
 *        hand points (HandFilterBank — POINTS are what gets smoothed,
 *        never orientations), build the palm basis fresh each frame from
 *        the filtered points (y = wrist→middleMCP, z = y × (indexMCP−
 *        pinkyMCP) [palm normal, chirality-correct for either hand],
 *        x = y × z), and set the wrist bone ABSOLUTELY: palm basis ∘ a
 *        bind-time constant offset (avatar palm basis⁻¹ ∘ bone world quat
 *        captured ONCE at bind). No live-measured avatar reference, no
 *        quaternion smoothing — a smoothed delta against a reference that
 *        moves with the arm was how the hand melted into claw poses.
 *      · z-convention CALIBRATION (hand-views.js _zSign, the convention
 *        authority): worldLandmarks' z sign varies by build/device and a
 *        wrong sign mirrors the cloud → inverted palm normal → hands
 *        locked palm-out with mirrored finger bends. The mapped cloud's
 *        palm-block signed volume is measured against the avatar hand's
 *        own chirality (decay-latched) and z is flipped when they
 *        disagree. NEVER hard-code hand z signs or trust handedness
 *        labels for chirality — measure it.
 *      · per-FINGER FK: each avatar finger bone aligns to its human
 *        finger-segment direction (MCP→PIP→DIP→TIP), same direction-
 *        alignment solve as the limbs. Scalar curls remain the fallback
 *        when hand world landmarks are absent.
 *
 * 2. HUMAN-POSSIBLE CONSTRAINTS (research-annotated): raw MediaPipe z is
 *    the noisiest channel; unconstrained it synthesizes impossible poses
 *    (arms bent backwards through the chest). Applied to every target
 *    direction BEFORE the solve:
 *      · z attenuation (opts.zScale) — Kalidokit-style depth damping
 *      · ROM cone clamps around rest per joint, from standard clinical
 *        range-of-motion values (AAOS-style): shoulder ~110° cone,
 *        hip ~100°, spine ~25°
 *      · hinge bend limit: elbow/knee flexion ≤ ~150° relative to the
 *        parent segment (no hyperextension synthesis)
 *      · back-plane clamp: arm directions may not point far behind the
 *        torso plane (dir.z ≥ backPlaneZ) — kills the arms-through-
 *        chest-backwards artifact caused by z noise
 *      · WRIST ROM clamp: the palm-basis delta is swing-twist decomposed
 *        about the bind-pose palm axes and clamped to human range —
 *        flexion/extension ≤ ±90°, radial/ulnar deviation ≤ ±30°, axial
 *        twist ≤ ±20°. Twist is the critical one: pronation/supination
 *        is a FOREARM rotation, not a wrist DOF, so unclamped every
 *        pose-lane (forearm dir) vs hand-lane (palm basis) disagreement
 *        rendered as the candy-wrapper wrist knot. A hemisphere cap
 *        additionally forbids folding past 90° — the hand can never lie
 *        flat against the forearm. Fingers retarget in PALM space
 *        (human dir → human-palm-local → avatar's clamped palm), so
 *        they ride the clamped wrist instead of twisting to chase
 *        world-absolute targets.
 *    Full capsule self-collision (hand-vs-hand, hand-vs-torso contact)
 *    is BODY_SYNC_ROADMAP P1 — these clamps remove the impossible-pose
 *    class; capsules add contact realism later.
 */

import * as THREE from 'three';
import { graphFromScene, classifySkeleton, alignBodyContract } from './skeleton-align.js';
import { OneEuro, HandFilterBank } from '../core/filters.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const MP = { shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
             hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28 };
// MediaPipe 21-pt hand: per finger [MCP, PIP, DIP, TIP]
const HAND_PTS = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12],
                   ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };

// ── palm-block signed volume — the pose-invariant CHIRALITY cue ──
// (hand-views.js pattern, THE convention authority for hand mapping.)
// Tetrahedra of wrist / index MCP / pinky MCP vs the two thumb-base points:
// opposite signs for left/right hands in any pose. MediaPipe worldLandmarks'
// z sign VARIES by build/device (hand-views.js _zSign — a hard-coded sign
// once locked hands permanently palm-out), so chirality must be MEASURED,
// never assumed from mapSigns or the flaky handedness labels.
const signedVol = (p0, a, b, c) => {
  const ax = a.x - p0.x, ay = a.y - p0.y, az = a.z - p0.z;
  const bx = b.x - p0.x, by = b.y - p0.y, bz = b.z - p0.z;
  const cx = c.x - p0.x, cy = c.y - p0.y, cz = c.z - p0.z;
  return (ay * bz - az * by) * cx + (az * bx - ax * bz) * cy + (ax * by - ay * bx) * cz;
};
const chirVol = P => signedVol(P(0), P(5), P(17), P(1)) + signedVol(P(0), P(5), P(17), P(2));

const RX_FINGER = {
  thumb: /thumb/i, index: /index|point/i, middle: /middle|mid/i,
  ring: /ring/i, pinky: /pinky|little/i
};
const FINGER_ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky'];

const DEFAULTS = {
  mirror: true,
  mapSigns: [-1, -1, -1],       // world→avatar signs; verify with the ghost
  zScale: 0.85,                 // depth attenuation (z is the noisy axis)
  minVis: 0.55,
  holdMs: 400, fadeMs: 350,
  crouchDropFrac: 0.12,
  head: { yaw: 0.7, pitch: 0.6, roll: 0.35, max: 26 },
  // constraint layer (deg) — lab-tunable. Cones are measured from the REST
  // direction (arms hanging), so they must span the full ROM arc: shoulder
  // flexion reaches ~170° from hanging (overhead) — 110 here was clamping
  // arm raises mid-way. Cones now only cut the impossible wraparound zone;
  // the back-plane + hinge limits do the real anti-bizarre work.
  cone: { uarm: 175, thigh: 130, spine: 25 },
  hingeMaxDeg: 150,             // elbow/knee max flexion vs parent segment
  backPlaneZ: -0.35,            // arm dirs may not point this far behind torso
  // wrist ROM (deg, symmetric about rest). flexDeg ≤ 90 — the hemisphere
  // cap forbids folding past the forearm line regardless. twistDeg ≈ 0:
  // pronation/supination belongs to the forearm; keeping the wrist near
  // rest twist keeps the palm facing wherever the rig's rest pose points
  // it (bodyward on standard A/T-pose rigs).
  wrist: { flexDeg: 90, devDeg: 30, twistDeg: 20 },
  // smoothing — POINTS ONLY (handlab doctrine): One-Euro the landmarks,
  // derive every orientation FRESH from filtered points. Orientations are
  // never smoothed — smoothing a delta whose reference moves with the arm
  // melts the hand into claw poses.
  dirCutoff: 1.2, dirBeta: 0.6,
  handCutoff: 1.5, handBeta: 0.5,   // One-Euro on the 21 hand points (metres)
  fingerAxis: 'x', fingerSign: -1, fingerCurlDeg: 65   // scalar-curl fallback
};

export class BipedDriver {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts,
      cone: { ...DEFAULTS.cone, ...(opts.cone || {}) },
      head: { ...DEFAULTS.head, ...(opts.head || {}) },
      wrist: { ...DEFAULTS.wrist, ...(opts.wrist || {}) } };
    this.root = null;
    this.bones = {};
    this.rest = {};
    this.alignment = null;
    this.segs = [];
    this._hand = { L: null, R: null };   // per-avatar-side hand solve state
    // shared landmark filter bank (handlab's HandFilterBank), keyed by side
    this._hfilt = new HandFilterBank({
      count: 21, minCutoff: this.opts.handCutoff, beta: this.opts.handBeta });
    this._v = { a: new THREE.Vector3(), b: new THREE.Vector3(), t: new THREE.Vector3(),
                x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion(); this._qp = new THREE.Quaternion();
    this._qd = new THREE.Quaternion(); this._qh = new THREE.Quaternion();
    // wrist-clamp + palm-frame finger scratch (own quats — _q/_qd/_qp are
    // _alignBone's, and aliasing scratch already bit this file once)
    this._qr = new THREE.Quaternion(); this._qs = new THREE.Quaternion();
    this._qt = new THREE.Quaternion(); this._qhi = new THREE.Quaternion();
    this._qpost = new THREE.Quaternion();
  }

  bind(scene, contract = null) {
    this.root = scene;
    scene.updateMatrixWorld(true);
    scene.traverse(o => { if (o.isBone) this.bones[o.name] = o; });
    const cls = classifySkeleton(graphFromScene(scene));
    this.alignment = contract
      ? alignBodyContract(contract, cls)
      : { joints: cls.roles, matches: null, verify: {}, conflicts: cls.conflicts,
          stance: cls.stance, axes: cls.axes };
    const j = this.alignment.joints;

    const arm = (c, i) => Array.isArray(c) ? c[c.length >= 4 ? i + 1 : i] ?? null : null;
    const leg = (c, i) => Array.isArray(c) ? c[i] ?? null : null;
    const M = this.opts.mirror;
    const hs = side => M ? (side === 'L' ? 'R' : 'L') : side;
    const defs = [];
    for (const side of ['L', 'R']) {
      const ac = side === 'L' ? j.frontL : j.frontR;
      const lc = side === 'L' ? j.hindL : j.hindR;
      defs.push(
        { id: 'uarm' + side, kind: 'uarm', side, bone: arm(ac, 0), child: arm(ac, 1),
          lm: [MP['shoulder' + hs(side)], MP['elbow' + hs(side)]] },
        { id: 'farm' + side, kind: 'farm', side, parentSeg: 'uarm' + side,
          bone: arm(ac, 1), child: arm(ac, 2),
          lm: [MP['elbow' + hs(side)], MP['wrist' + hs(side)]] },
        { id: 'thigh' + side, kind: 'thigh', side, bone: leg(lc, 0), child: leg(lc, 1),
          lm: [MP['hip' + hs(side)], MP['knee' + hs(side)]] },
        { id: 'shin' + side, kind: 'shin', side, parentSeg: 'thigh' + side,
          bone: leg(lc, 1), child: leg(lc, 2),
          lm: [MP['knee' + hs(side)], MP['ankle' + hs(side)]] });
    }
    if (j.spine?.length && (j.neck?.length || j.spine.length > 1)) {
      defs.unshift({ id: 'spine', kind: 'spine', bone: j.spine[0],
        child: (Array.isArray(j.neck) && j.neck[0]) || j.spine.at(-1),
        lm: 'spineMid' });
    }
    this.segs = defs.filter(s => s.bone && s.child && this.bones[s.bone] && this.bones[s.child]);
    for (const s of this.segs) {
      const bp = new THREE.Vector3().setFromMatrixPosition(this.bones[s.bone].matrixWorld);
      const cp = new THREE.Vector3().setFromMatrixPosition(this.bones[s.child].matrixWorld);
      s.restDir = cp.sub(bp).normalize();
      s.f = [new OneEuro(this.opts.dirCutoff, this.opts.dirBeta),
             new OneEuro(this.opts.dirCutoff, this.opts.dirBeta),
             new OneEuro(this.opts.dirCutoff, this.opts.dirBeta)];
      s.last = null;
      s.applied = new THREE.Vector3();   // dir actually used this frame (hinge parent lookup)
      s.appliedOk = false;
    }

    scene.traverse(o => { if (o.isBone) this.rest[o.name] = o.quaternion.clone(); });
    this.drive = { neck: Array.isArray(j.neck) ? j.neck[0] : j.neck,
                   armL: arm(j.frontL, 0), legL: leg(j.hindL, 0) };

    // finger chains + hand solve state per side
    this.fingers = { L: {}, R: {} };
    for (const side of ['L', 'R']) {
      const chain = side === 'L' ? j.frontL : j.frontR;
      const handName = Array.isArray(chain) ? chain.at(-1) : null;
      const hand = handName && this.bones[handName];
      if (!hand) continue;
      const found = [];
      for (const child of hand.children) {
        if (!child.isBone) continue;
        const fchain = [];
        let cur = child;
        while (cur) { fchain.push(cur.name); cur = cur.children.find(c => c.isBone) || null; }
        found.push(fchain);
      }
      for (const fchain of found) {
        const label = FINGER_ORDER.find(f => RX_FINGER[f].test(fchain[0]))
          || FINGER_ORDER[found.indexOf(fchain)] || null;
        if (label) this.fingers[side][label] = fchain;
      }
      const fg = this.fingers[side];
      if (fg.index && fg.middle && fg.pinky) {
        // bind-pose palm basis expressed in the hand bone's LOCAL frame —
        // the wrist ROM clamp decomposes about these fixed axes:
        //   axY = along the fingers (twist axis), axZ = palm normal
        //   (flexion/extension axis), axX = lateral (deviation axis)
        const bp = n => new THREE.Vector3().setFromMatrixPosition(this.bones[n].matrixWorld);
        const qPalm0 = this._palmQuat(bp(handName), bp(fg.index[0]), bp(fg.middle[0]),
                                      bp(fg.pinky[0]), new THREE.Quaternion());
        let axX = null, axY = null, axZ = null, qOff = null;
        if (qPalm0) {
          const qb = hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qPalm0);
          axX = new THREE.Vector3(1, 0, 0).applyQuaternion(qb);
          axY = new THREE.Vector3(0, 1, 0).applyQuaternion(qb);
          axZ = new THREE.Vector3(0, 0, 1).applyQuaternion(qb);
          // CONSTANT bind offset palm-basis → bone orientation. Per frame the
          // wrist is qHumanPalm ∘ qOff, absolute from live points (HoloHandRig
          // style: rest reference captured ONCE, never re-measured live).
          qOff = qb.clone().invert();
        }
        // avatar hand's own chirality sign — the reference the incoming
        // cloud must match (needs a thumb chain; without one, calibration
        // is off and the hard-coded mapSigns z is trusted as before)
        let chirSign = 0;
        if (fg.thumb) {
          const t0 = bp(fg.thumb[0]), t1 = fg.thumb[1] ? bp(fg.thumb[1]) : t0;
          const pts = { 0: bp(handName), 5: bp(fg.index[0]), 17: bp(fg.pinky[0]), 1: t0, 2: t1 };
          chirSign = Math.sign(chirVol(i => pts[i])) || 0;
        }
        this._hand[side] = {
          bone: handName,
          index: fg.index[0], middle: fg.middle[0], pinky: fg.pinky[0],
          axX, axY, axZ, qOff,
          chirSign, zs: 1, zAcc: 0,                   // measured z-convention latch
          lastT: 0
        };
      }
    }

    const box = new THREE.Box3().setFromObject(scene);
    this.height = box.getSize(new THREE.Vector3()).y || 1;
    this.baseY = scene.position.y;
    return this;
  }

  /** World-landmark point → avatar space (shared with ghost views). */
  mapPoint(p, out) {
    const s = this.opts.mapSigns;
    return out.set(p.x * s[0], p.y * s[1], p.z * s[2] * this.opts.zScale);
  }

  // clamp `dir` into a cone of `maxDeg` around `axis` (both unit)
  _cone(dir, axis, maxDeg) {
    const max = maxDeg * D2R;
    const ang = dir.angleTo(axis);
    if (ang <= max) return dir;
    this._v.x.crossVectors(axis, dir);
    if (this._v.x.lengthSq() < 1e-10) return dir;
    this._v.x.normalize();
    return dir.copy(axis).applyQuaternion(this._q.setFromAxisAngle(this._v.x, max));
  }

  // full world-space alignment: rotate `bone` so bone→child points along `dir`
  _alignBone(bone, child, dir) {
    bone.updateWorldMatrix(true, false);
    child.updateWorldMatrix(true, false);
    this._v.a.setFromMatrixPosition(bone.matrixWorld);
    this._v.b.setFromMatrixPosition(child.matrixWorld);
    const cur = this._v.b.sub(this._v.a);
    if (cur.lengthSq() < 1e-10) return;
    this._qd.setFromUnitVectors(cur.normalize(), dir);
    bone.parent.getWorldQuaternion(this._qp);
    bone.quaternion.premultiply(
      this._q.copy(this._qp).invert().multiply(this._qd).multiply(this._qp));
  }

  // palm basis (hands.js buildFrame formula) from three points relative to a wrist
  // y = wrist→middle, z = y × (index−pinky) [palm normal], x = y × z
  _palmQuat(wrist, index, middle, pinky, out) {
    this._v.y.subVectors(middle, wrist);
    if (this._v.y.lengthSq() < 1e-10) return null;
    this._v.y.normalize();
    this._v.a.subVectors(index, pinky);
    this._v.z.crossVectors(this._v.y, this._v.a);
    if (this._v.z.lengthSq() < 1e-10) return null;
    this._v.z.normalize();
    this._v.x.crossVectors(this._v.y, this._v.z).normalize();
    this._m.makeBasis(this._v.x, this._v.y, this._v.z);
    return out.setFromRotationMatrix(this._m);
  }

  /**
   * @param {Array|null} poseWorld   pose world landmarks (held by caller)
   * @param {Object} v       BodyProbe.values
   * @param {Object|null} head   PuppetInput.state.head
   * @param {Object|null} hv     HandProbe.values (curl fallback + seen flags)
   * @param {number} dt      seconds
   * @param {number} now     ms
   * @param {Array|null} handsWorld  tracker frame.handsWorld (per-hand 21×3D)
   * @param {Array|null} handedness  tracker frame.handedness ('Left'/'Right')
   */
  update(poseWorld, v = {}, head = null, hv = null, dt = 1 / 60, now = performance.now(),
         handsWorld = null, handedness = null) {
    if (!this.root) return;
    const o = this.opts;

    for (const s of this.segs) this.bones[s.bone].quaternion.copy(this.rest[s.bone]);

    const vis = i => poseWorld?.[i]?.visibility ?? (poseWorld ? 1 : 0);
    for (const s of this.segs) {
      s.appliedOk = false;
      let fresh = false;
      if (poseWorld) {
        if (s.lm === 'spineMid') {
          if ([MP.hipL, MP.hipR, MP.shoulderL, MP.shoulderR].every(i => vis(i) >= o.minVis)) {
            this._v.a.set(
              (poseWorld[MP.shoulderL].x + poseWorld[MP.shoulderR].x - poseWorld[MP.hipL].x - poseWorld[MP.hipR].x) / 2,
              (poseWorld[MP.shoulderL].y + poseWorld[MP.shoulderR].y - poseWorld[MP.hipL].y - poseWorld[MP.hipR].y) / 2,
              (poseWorld[MP.shoulderL].z + poseWorld[MP.shoulderR].z - poseWorld[MP.hipL].z - poseWorld[MP.hipR].z) / 2);
            fresh = true;
          }
        } else if (vis(s.lm[0]) >= o.minVis && vis(s.lm[1]) >= o.minVis) {
          const a = poseWorld[s.lm[0]], b = poseWorld[s.lm[1]];
          this._v.a.set(b.x - a.x, b.y - a.y, b.z - a.z);
          fresh = true;
        }
      }

      let dir = null;
      if (fresh && this._v.a.lengthSq() > 1e-8) {
        this.mapPoint(this._v.a, this._v.t).normalize();
        this._v.t.set(s.f[0].filter(this._v.t.x, dt),
                      s.f[1].filter(this._v.t.y, dt),
                      s.f[2].filter(this._v.t.z, dt)).normalize();
        s.last = s.last || { dir: new THREE.Vector3() };
        s.last.dir.copy(this._v.t); s.last.t = now;
        dir = s.last.dir;
      } else if (s.last) {
        const age = now - s.last.t;
        if (age < o.holdMs) dir = s.last.dir;
        else if (age < o.holdMs + o.fadeMs) {
          const f = (age - o.holdMs) / o.fadeMs;
          dir = this._v.t.copy(s.last.dir).lerp(s.restDir, f).normalize();
        } else s.last = null;
      }
      if (!dir) continue;

      // ── CONSTRAINT LAYER: keep the target humanly possible ──
      // work on the seg's OWN vector: _v.b is _alignBone's scratch — aliasing
      // it here made target === current inside the align (identity → frozen body)
      const c = s.applied.copy(dir);
      if (o.cone[s.kind]) this._cone(c, s.restDir, o.cone[s.kind]);
      if (s.parentSeg) {                        // elbow/knee flexion limit
        const p = this.segs.find(x => x.id === s.parentSeg);
        if (p?.appliedOk) {
          const bend = c.angleTo(p.applied);
          if (bend > o.hingeMaxDeg * D2R) {
            this._v.x.crossVectors(p.applied, c);
            if (this._v.x.lengthSq() > 1e-10) {
              c.copy(p.applied).applyQuaternion(
                this._q.setFromAxisAngle(this._v.x.normalize(), o.hingeMaxDeg * D2R));
            }
          }
        }
      }
      if (s.kind === 'uarm' || s.kind === 'farm') {   // arms never far behind the torso
        if (c.z < o.backPlaneZ) { c.z = o.backPlaneZ; c.normalize(); }
      }
      s.appliedOk = true;

      this._alignBone(this.bones[s.bone], this.bones[s.child], c);
    }

    this.root.position.y = this.baseY - (v['body.crouch'] ?? 0) * o.crouchDropFrac * this.height;

    // ── HANDS: palm-basis orientation + per-finger FK (curl fallback) ──
    const solved = { L: false, R: false };
    if (handsWorld && handedness) {
      for (let h = 0; h < handsWorld.length; h++) {
        if (!handsWorld[h]) continue;
        const humanSide = handedness[h] === 'Right' ? 'R' : 'L';
        const side = o.mirror ? (humanSide === 'L' ? 'R' : 'L') : humanSide;
        if (this._solveHand(side, humanSide, handsWorld[h], dt, now)) solved[side] = true;
      }
    }
    for (const side of ['L', 'R']) {
      if (solved[side]) continue;
      const st = this._hand[side];
      if (st?.lastT && now - st.lastT < o.holdMs) continue;     // hold last pose
      this._fingerCurlFallback(side, hv, now);
    }

    const nb = this.drive.neck && this.bones[this.drive.neck];
    if (nb && this.rest[this.drive.neck]) {
      nb.quaternion.copy(this.rest[this.drive.neck]);
      if (head?.seen) {
        const H = o.head;
        const eu = new THREE.Euler(
          -clamp(head.pitch * H.pitch, -H.max, H.max) * D2R,
          -clamp(head.yaw * H.yaw, -H.max, H.max) * D2R,
          clamp(head.roll * H.roll, -H.max, H.max) * D2R);
        nb.quaternion.multiply(this._q.setFromEuler(eu));
      }
    }
  }

  // returns true when the hand was solved from world landmarks.
  // ARCHITECTURE (handlab/studio/mpgames doctrine — do not regress):
  //   1. POINTS are the interface: One-Euro the 21 landmarks, then derive
  //      every orientation FRESH from the filtered points each frame.
  //      Orientations are NEVER smoothed and NEVER computed as a delta
  //      against a live-measured avatar basis — that reference moves with
  //      the arm, and smoothing across a moving reference melts the hand.
  //   2. The wrist orientation is ABSOLUTE: human palm basis ∘ a bind-time
  //      constant offset (HoloHandRig keeps rest bases the same way).
  //   3. Chirality is MEASURED (hand-views.js), never assumed from labels.
  _solveHand(side, humanSide, lm, dt, now) {
    const st = this._hand[side];
    if (!st) return false;
    const o = this.opts;
    const hb = this.bones[st.bone];
    if (!hb || !st.qOff) return false;

    // One-Euro the raw points (same HandFilterBank as handlab)
    const flm = this._hfilt.apply(side, lm, now);

    // ── Z-CONVENTION CALIBRATION (ported from hand-views.js _zSign) ──
    // The mapped cloud must have the avatar hand's chirality or the palm
    // basis inverts (palm-out hands, mirrored finger bends). A diagonal map
    // scales signed volumes by its determinant, so measure on the RAW cloud
    // and multiply by sign(det(mapSigns)); decay-accumulate (single frames
    // are unreliable in a self-occluded fist) and latch the z flip.
    if (st.chirSign) {
      const s = this.opts.mapSigns;
      st.zAcc = st.zAcc * 0.98 + chirVol(i => flm[i]) * Math.sign(s[0] * s[1] * s[2]);
      if (Math.abs(st.zAcc) > 1e-12) st.zs = Math.sign(st.zAcc) === st.chirSign ? 1 : -1;
    }
    const mp = (p, out) => { this.mapPoint(p, out); out.z *= st.zs; return out; };

    // human palm basis (mapped into avatar space) from FILTERED points
    const W = mp(flm[0], new THREE.Vector3());
    const I = mp(flm[5], new THREE.Vector3());
    const Md = mp(flm[9], new THREE.Vector3());
    const P = mp(flm[17], new THREE.Vector3());
    const qHuman = this._palmQuat(W, I, Md, P, this._qh);
    if (!qHuman) return false;
    this._qhi.copy(qHuman).invert();   // human palm frame⁻¹ (finger retarget)

    // ── ABSOLUTE wrist orient: palm basis ∘ bind offset, made local ──
    hb.parent.getWorldQuaternion(this._qp);
    hb.quaternion.copy(this._qp).invert().multiply(qHuman).multiply(st.qOff);

    // ── WRIST ROM CLAMP: pose-lane (forearm) vs hand-lane (palm)
    // disagreement lands in this ONE joint — clamp the local rotation-
    // from-rest to human range (see _clampWrist).
    if (st.axY) this._clampWrist(hb, st);
    st.lastT = now;

    // avatar palm basis AFTER the clamp — fingers must ride the CLAMPED
    // palm, not chase world targets the wrist was forbidden to reach
    hb.updateWorldMatrix(true, false);
    const wp = new THREE.Vector3().setFromMatrixPosition(hb.matrixWorld);
    const gp = n => { const b = this.bones[n]; b.updateWorldMatrix(true, false);
      return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld); };
    const qPalm = this._palmQuat(wp, gp(st.index), gp(st.middle), gp(st.pinky), this._qpost);

    // fingers: per-segment direction alignment in PALM space (contract
    // principle — a finger dir relative to its own palm is a measure,
    // invariant to arm pose), from the SAME filtered points
    for (const [finger, fchain] of Object.entries(this.fingers[side])) {
      const pts = HAND_PTS[finger];
      const nSeg = Math.min(fchain.length - 0, 3);
      for (let i = 0; i < nSeg; i++) {
        const bone = this.bones[fchain[i]];
        const child = this.bones[fchain[i + 1]];
        if (!bone || !child) break;
        bone.quaternion.copy(this.rest[fchain[i]]);   // absolute from rest
        const a = flm[pts[i]], b = flm[pts[i + 1]];
        this._v.a.set(b.x - a.x, b.y - a.y, b.z - a.z);
        if (this._v.a.lengthSq() < 1e-10) break;
        mp(this._v.a, this._v.t).normalize();                 // zs-calibrated map
        if (qPalm) {
          this._v.t.applyQuaternion(this._qhi);               // → human palm frame
          this._v.t.applyQuaternion(qPalm);                   // → avatar clamped palm
        }
        this._alignBone(bone, child, this._v.t);
      }
    }
    return true;
  }

  // ── WRIST ROM: swing-twist clamp of the hand bone's rotation-from-rest ──
  // Anatomy: the wrist itself has ~90° flexion/extension, ~20-45° radial/
  // ulnar deviation, and essentially ZERO axial twist — pronation/supination
  // happens along the forearm (radius over ulna), a bone this driver aims by
  // direction only (rest roll). Decompose the local delta about the
  // bind-captured palm axes, clamp each DOF; yPar ≥ 0 is the hemisphere cap:
  // the hand can never fold past 90° flat against or through the forearm.
  _clampWrist(hb, st) {
    const w = this.opts.wrist;
    // r: rotation from rest in the bone's local frame (qLocal = rest ∘ r)
    const r = this._qr.copy(this.rest[st.bone]).invert().multiply(hb.quaternion);
    if (r.w < 0) { r.x = -r.x; r.y = -r.y; r.z = -r.z; r.w = -r.w; }
    const a = st.axY;
    // signed twist about the finger axis = projection of r onto a
    const proj = r.x * a.x + r.y * a.y + r.z * a.z;
    const twist = clamp(2 * Math.atan2(proj, r.w),
                        -w.twistDeg * D2R, w.twistDeg * D2R);
    // swing: where the finger axis actually points (twist leaves a fixed).
    // Elliptical cone clamp with SATURATION: the swing angle φ is capped at
    // the ellipse radius for its direction (flexDeg along the palm normal,
    // devDeg laterally), so a 170° fold pins at the 90° boundary instead of
    // reflecting back. flex/dev ≤ 90 ⇒ φmax ≤ 90 ⇒ hemisphere cap for free.
    const yNew = this._v.a.copy(a).applyQuaternion(r);
    const cosP = clamp(yNew.dot(a), -1, 1);
    const u = this._v.b.copy(yNew).addScaledVector(a, -cosP);   // ⊥ a
    let phi = 0;
    if (u.lengthSq() < 1e-12) {
      if (cosP < 0) { u.copy(st.axZ); phi = Math.PI; }          // exact 180° fold
    } else { phi = Math.atan2(u.length(), cosP); u.normalize(); }
    if (phi > 1e-6) {
      const uD = u.dot(st.axX) / (Math.min(w.devDeg, 90) * D2R);
      const uF = u.dot(st.axZ) / (Math.min(w.flexDeg, 90) * D2R);
      phi = Math.min(phi, 1 / Math.sqrt(uD * uD + uF * uF));
    }
    this._v.a.copy(a).multiplyScalar(Math.cos(phi)).addScaledVector(u, Math.sin(phi));
    this._qs.setFromUnitVectors(a, this._v.a.normalize());
    hb.quaternion.copy(this.rest[st.bone])
      .multiply(this._qs)
      .multiply(this._qt.setFromAxisAngle(a, twist));
  }

  // scalar-curl fallback (no hand world landmarks): local-axis curls
  _fingerCurlFallback(side, hv, now) {
    const o = this.opts;
    const st = this._hand[side];
    if (st) { st.zAcc = 0; this._hfilt.drop(side); }   // hand lost — re-seed on re-entry
    if (st && this.bones[st.bone]) this.bones[st.bone].quaternion.copy(this.rest[st.bone]);
    const human = o.mirror ? (side === 'L' ? 'R' : 'L') : side;
    const seen = hv?.[`hand.${human}.seen`];
    for (const [finger, fchain] of Object.entries(this.fingers[side])) {
      const curl = seen ? (hv[`finger.${human}.${finger}.curl`] ?? 0) : 0;
      for (let i = 0; i < fchain.length; i++) {
        const b = this.bones[fchain[i]];
        if (!b || !this.rest[fchain[i]]) continue;
        b.quaternion.copy(this.rest[fchain[i]]);
        const deg = curl * o.fingerCurlDeg * (i === 0 ? 0.6 : 1) * o.fingerSign;
        if (deg) {
          this._v.a.set(+(o.fingerAxis === 'x'), +(o.fingerAxis === 'y'), +(o.fingerAxis === 'z'));
          b.quaternion.multiply(this._q.setFromAxisAngle(this._v.a, deg * D2R));
        }
      }
    }
  }
}
