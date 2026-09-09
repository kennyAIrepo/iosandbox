/**
 * hopeOS SDK — Puppet Input Module
 * ═══════════════════════════════════════════════════════════════
 * ONE access point for driving a rigged character ("puppet") from the
 * player's body — the full channel set for I-AM-LIZARD-style embodiment
 * games, composed from trackers the stack already runs:
 *
 *   mouth  open/close + degree ─┐  MouthTriggers (interaction/mouth.js):
 *   tongue out/in + tip        ─┘  MAR geometry + red-ratio pixels
 *   eyes   per-eye open degree ──  eyeBlink blendshapes (identity-free)
 *   head   yaw/pitch/roll deg  ──  face transform matrix, else landmark
 *                                  geometry (nose offset / eye-line tilt)
 *   limbs  4× raise + extend   ──  PoseLandmarker (33 pts, already mature
 *                                  in-stack — BodyGestureDetector lineage;
 *                                  reuses its POSE_LANDMARKS + jointAngle)
 *
 * Every analog channel is One-Euro smoothed; every boolean trigger has
 * hysteresis (separate on/off thresholds) so it can't chatter.
 *
 * Game integration (generic script):
 *   const tracker = await initTracking(vid, {
 *     enableHands: false, faceEvery: 1, faceMatrix: true, poseEvery: 2 });
 *   const puppet = new PuppetInput(vid);
 *   puppet.on('mouthOpen', a => lizard.armTongue(a));
 *   puppet.on('tongueOut', r => lizard.fire());
 *   puppet.on('eyeClose', side => lizard.blink(side));
 *   puppet.on('limbRaise', id => lizard.limb(id).step());   // armL|armR|legL|legR
 *   // per frame:
 *   const s = puppet.update(tracker.detect(), performance.now());
 *   lizard.head.aim(s.head.yaw, s.head.pitch, s.head.roll);
 *
 * Coordinate/side conventions:
 *  · Limb + eye sides are ANATOMICAL (the player's own left/right). In the
 *    SDK's mirrored selfie space the player's left limb appears screen-LEFT
 *    (mirror behavior), so anatomical-left → puppet's screen-left limb is
 *    the natural embodiment mapping.
 *  · Head angles are reported in mirrored-view terms: yaw > 0 = nose
 *    toward screen-right, pitch > 0 = looking up, roll > 0 = clockwise
 *    on screen. Verify signs live in puppetlab.html; per-axis multipliers
 *    are exposed in opts.signs for rig-convention mismatches.
 *  · Pose runs every `poseEvery` frames (tracking.js); limb state HOLDS
 *    between pose frames. Use poseEvery: 2 when limbs are gameplay.
 */

import { MouthTriggers } from './mouth.js';
import { OneEuro } from '../core/filters.js';
import { POSE_LANDMARKS as LM, jointAngle } from './body-gestures.js';

const R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Face-mesh anchors for the geometric head-pose fallback
const NOSE_TIP = 1, FOREHEAD = 10, CHIN = 152;
const CHEEK_R = 234, CHEEK_L = 454;          // subject-right / subject-left edge
const EYE_R_OUT = 33, EYE_L_OUT = 263;       // outer eye corners

const LIMBS = {
  armL: { root: LM.LEFT_SHOULDER,  mid: LM.LEFT_ELBOW,  tip: LM.LEFT_WRIST },
  armR: { root: LM.RIGHT_SHOULDER, mid: LM.RIGHT_ELBOW, tip: LM.RIGHT_WRIST },
  legL: { root: LM.LEFT_HIP,  mid: LM.LEFT_KNEE,  tip: LM.LEFT_ANKLE },
  legR: { root: LM.RIGHT_HIP, mid: LM.RIGHT_KNEE, tip: LM.RIGHT_ANKLE }
};

const DEFAULTS = {
  // Eyes: blendshape score 0=open 1=closed; hysteresis on the CLOSED test
  eyeCloseAbove: 0.55,
  eyeOpenBelow: 0.40,
  // Limbs: raise = height of wrist-vs-shoulder (arms) / knee-vs-hip (legs),
  // in torso-lengths, positive = above. Hysteresis per limb type.
  armRaiseAbove: 0.05,  armLowerBelow: -0.10,
  legRaiseAbove: -0.35, legLowerBelow: -0.50,
  minVisibility: 0.5,
  // extend: joint angle (deg) mapped bent→straight
  extendBentDeg: 50, extendStraightDeg: 172,
  // Smoothing (head angles benefit from a slightly lazier filter)
  minCutoff: 1.6, beta: 0.1,
  signs: { yaw: 1, pitch: 1, roll: 1 },
  mouth: {}                     // forwarded to MouthTriggers
};

export class PuppetInput {
  /** @param {HTMLVideoElement|null} videoEl - detection video (null = no tongue pixels) */
  constructor(videoEl, opts = {}) {
    this.opts = { ...DEFAULTS, ...opts, signs: { ...DEFAULTS.signs, ...(opts.signs || {}) } };
    this._listeners = {};
    this._lastT = 0;

    this.mouth = new MouthTriggers(videoEl, this.opts.mouth);
    for (const ev of ['mouthOpen', 'mouthClose', 'tongueOut', 'tongueIn']) {
      this.mouth.on(ev, (...a) => this._emit(ev, ...a));
    }

    this._f = {
      yaw: new OneEuro(this.opts.minCutoff, this.opts.beta),
      pitch: new OneEuro(this.opts.minCutoff, this.opts.beta),
      roll: new OneEuro(this.opts.minCutoff, this.opts.beta),
      eyeL: new OneEuro(2.2, 0.2), eyeR: new OneEuro(2.2, 0.2)
    };
    this._limbF = {};
    for (const id of Object.keys(LIMBS)) {
      this._limbF[id] = { raise: new OneEuro(1.8, 0.12), extend: new OneEuro(1.8, 0.12) };
    }

    this.state = {
      mouth: this.mouth.state,
      eyes: {
        left:  { open: true, openAmount: 1 },   // anatomical left
        right: { open: true, openAmount: 1 }
      },
      head: { seen: false, yaw: 0, pitch: 0, roll: 0 },
      limbs: {
        armL: mkLimb(), armR: mkLimb(), legL: mkLimb(), legR: mkLimb()
      }
    };
  }

  on(name, cb) { (this._listeners[name] = this._listeners[name] || []).push(cb); return this; }
  off(name, cb) { const l = this._listeners[name]; if (l) this._listeners[name] = l.filter(f => f !== cb); }
  _emit(name, ...args) { for (const cb of (this._listeners[name] || [])) cb(...args); }

  /**
   * Feed a whole tracker frame (tracker.detect()) once per rAF.
   * Face/pose may be null on off-cadence frames — channels hold state.
   * @returns {Object} this.state
   */
  update(frame, tMs = performance.now()) {
    const dt = this._lastT ? (tMs - this._lastT) / 1000 : 0;
    this._lastT = tMs;
    if (!frame) return this.state;

    this.mouth.update(frame.face, tMs);
    if (frame.face) {
      this._updateEyes(frame.face, dt);
      this._updateHead(frame.face, dt);
    }
    if (frame.pose) this._updateLimbs(frame.pose, dt);
    return this.state;
  }

  // ── Eyes: 1 - eyeBlink score = openness, hysteresis per eye ──
  _updateEyes(face, dt) {
    if (!face.blendshapes) return;
    let blinkL = null, blinkR = null;
    for (const b of face.blendshapes) {
      if (b.categoryName === 'eyeBlinkLeft') blinkL = b.score;
      else if (b.categoryName === 'eyeBlinkRight') blinkR = b.score;
    }
    const o = this.opts;
    for (const [side, blink, filt] of [['left', blinkL, this._f.eyeL], ['right', blinkR, this._f.eyeR]]) {
      if (blink === null) continue;
      const s = filt.filter(blink, dt);
      const eye = this.state.eyes[side];
      eye.openAmount = clamp(1 - s, 0, 1);
      if (eye.open && s > o.eyeCloseAbove) { eye.open = false; this._emit('eyeClose', side); }
      else if (!eye.open && s < o.eyeOpenBelow) { eye.open = true; this._emit('eyeOpen', side); }
    }
  }

  // ── Head: matrix (true angles) if faceMatrix:true, else landmark geometry ──
  _updateHead(face, dt) {
    let yaw, pitch, roll;
    if (face.matrix) {
      // 4×4 column-major canonical-face→camera transform. Forward = 3rd
      // column (face normal), up = 2nd column. Angle conventions verified
      // visually in puppetlab; flip via opts.signs if a rig disagrees.
      const d = face.matrix;
      const fx = d[8], fy = d[9], fz = d[10];
      yaw = Math.atan2(fx, fz) * R2D;
      pitch = Math.atan2(fy, Math.hypot(fx, fz)) * R2D;
      roll = Math.atan2(d[4], d[5]) * R2D;
    } else if (face.landmarks) {
      // Geometric approximation (RAW video coords, then mirrored signs):
      // yaw   — nose offset between cheek edges (turn compresses one side)
      // pitch — nose height in the forehead↔chin span
      // roll  — tilt of the outer-eye-corner line (exact)
      const lm = face.landmarks;
      const ax = 4 / 3; // aspect factor only affects mixed-axis distances mildly; roll dominates
      const d2 = (a, b) => Math.hypot((lm[a].x - lm[b].x) * ax, lm[a].y - lm[b].y);
      const dR = d2(NOSE_TIP, CHEEK_R), dL = d2(NOSE_TIP, CHEEK_L);
      yaw = -Math.asin(clamp((dR - dL) / (dR + dL + 1e-6), -1, 1)) * R2D;
      const faceH = d2(FOREHEAD, CHIN);
      const midY = (lm[FOREHEAD].y + lm[CHIN].y) / 2;
      pitch = Math.asin(clamp((midY - lm[NOSE_TIP].y) / (faceH * 0.5 + 1e-6), -1, 1)) * R2D * 0.7;
      roll = -Math.atan2(lm[EYE_L_OUT].y - lm[EYE_R_OUT].y,
                         (lm[EYE_L_OUT].x - lm[EYE_R_OUT].x) * ax) * R2D;
    } else return;

    const s = this.opts.signs, h = this.state.head;
    h.seen = true;
    h.yaw = this._f.yaw.filter(yaw * s.yaw, dt);
    h.pitch = this._f.pitch.filter(pitch * s.pitch, dt);
    h.roll = this._f.roll.filter(roll * s.roll, dt);
  }

  // ── Limbs: raise (height vs root joint, torso-normalized) + extend ──
  _updateLimbs(pose, dt) {
    const o = this.opts;
    // Torso length = shoulder-mid to hip-mid, the scale reference
    const sh = mid(pose[LM.LEFT_SHOULDER], pose[LM.RIGHT_SHOULDER]);
    const hp = mid(pose[LM.LEFT_HIP], pose[LM.RIGHT_HIP]);
    const torso = Math.hypot(sh.x - hp.x, sh.y - hp.y) || 1e-6;

    for (const [id, j] of Object.entries(LIMBS)) {
      const limb = this.state.limbs[id];
      const root = pose[j.root], m = pose[j.mid], tip = pose[j.tip];
      const seen = [root, m, tip].every(p => p && (p.v ?? 1) >= o.minVisibility);
      limb.seen = seen;
      if (!seen) continue;

      const isArm = id[0] === 'a';
      // Arms: wrist height vs shoulder. Legs: knee height vs hip (ankle
      // stays low even in a high step — the knee is the intent signal).
      const hRef = isArm ? tip : m;
      const raiseRaw = (root.y - hRef.y) / torso;    // y grows downward → invert
      limb.raise = this._limbF[id].raise.filter(clamp(raiseRaw, -1.5, 1.5), dt);

      const ang = jointAngle(root, m, tip);
      limb.extend = this._limbF[id].extend.filter(
        clamp((ang - o.extendBentDeg) / (o.extendStraightDeg - o.extendBentDeg), 0, 1), dt);

      limb.tip = { x: tip.x, y: tip.y };

      const upAt = isArm ? o.armRaiseAbove : o.legRaiseAbove;
      const downAt = isArm ? o.armLowerBelow : o.legLowerBelow;
      if (!limb.raised && limb.raise > upAt) { limb.raised = true; this._emit('limbRaise', id, limb.raise); }
      else if (limb.raised && limb.raise < downAt) { limb.raised = false; this._emit('limbLower', id); }
    }
  }
}

function mkLimb() {
  return { seen: false, raised: false, raise: 0, extend: 0, tip: null };
}
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
