/**
 * hopeOS SDK — Canonical Body Measures
 * ═══════════════════════════════════════════════════════════════
 * The HUMAN half of the body-puppet contract, executable — the body
 * sibling of face-measures.js. Same PRINCIPLE: measures, not positions.
 * Raw keypoints never cross the human→puppet boundary; what transfers is
 * a dimensionless measure (torso-normalized ratio, angle, or torso/s
 * velocity), evaluated by formula over a NAMED point map.
 *
 * DUAL TRACKER SPACES — the formulas take an index map, so the same
 * probe runs on either estimator:
 *   MEDIAPIPE_POSE_33  — BlazePose 33-pt (in-stack: tracking.js, mature,
 *                        has z + per-point visibility)
 *   MOVENET_17         — MoveNet / COCO-17 (TF.js Lightning/Thunder;
 *                        2D-only, no visibility on some builds — fastest
 *                        option if a page ever swaps estimators)
 * The contract names its space; nothing downstream changes.
 *
 * SCALE REFERENCE: the torso segment (shoulder-mid ↔ hip-mid). Every
 * length is divided by it, every velocity is torso-lengths/second —
 * invariant to camera distance and body size, the body-side analogue of
 * MAR/EAR ratio invariance (Soukupová & Čech lineage).
 *
 * GESTURES (jump / squat / dash / kick …) are EVENTS derived from these
 * continuous measures over time. The mature detector already in-stack
 * (interaction/body-gestures.js: jump, squat, kick, dodge, lean, turn,
 * runInPlace…) stays the discrete-event source; this module supplies the
 * continuous, contract-keyed channels a puppet consumes every frame.
 * Same split as the face stack: face-measures (continuous) + face.js
 * events. Research context: crawl-scheme direct limb mapping — human
 * arms → quadruped forelimbs — is the standard intuitive scheme in
 * quadruped-embodiment work ("Become the Beast" exergame study,
 * arXiv:2603.15428; Creature Features online puppetry; Dog Code
 * SIGGRAPH MIG '24 uses rule-based IK retarget before its codebook).
 *
 * Sides are ANATOMICAL throughout (player's own left/right).
 */

import { OneEuro } from '../core/filters.js';

const R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ── Index maps: WHERE the ruler touches the body ────────────────
export const MEDIAPIPE_POSE_33 = {
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  hipL: 23, hipR: 24,
  kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28
};

export const MOVENET_17 = {
  shoulderL: 5, shoulderR: 6,
  elbowL: 7, elbowR: 8,
  wristL: 9, wristR: 10,
  hipL: 11, hipR: 12,
  kneeL: 13, kneeR: 14,
  ankleL: 15, ankleR: 16
};

// limb id → the three joints of its kinematic chain (keys into a map above)
export const LIMB_CHAINS = {
  armL: ['shoulderL', 'elbowL', 'wristL'],
  armR: ['shoulderR', 'elbowR', 'wristR'],
  legL: ['hipL', 'kneeL', 'ankleL'],
  legR: ['hipR', 'kneeR', 'ankleR']
};

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dd = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/** Interior angle at joint b (degrees, 0–180), aspect-corrected. */
export function chainAngle(a, b, c, aspect = 1) {
  const r = Math.atan2(c.y - b.y, (c.x - b.x) * aspect) -
            Math.atan2(a.y - b.y, (a.x - b.x) * aspect);
  let deg = Math.abs(r * R2D);
  return deg > 180 ? 360 - deg : deg;
}

/**
 * Evaluate every instantaneous body measure in one pass.
 * @param {Array<{x,y,v?}>} pts  keypoint array (either tracker space)
 * @param {Object} map           MEDIAPIPE_POSE_33 or MOVENET_17
 * @param {number} aspect        videoW/videoH (1 if coords are metric)
 * @returns raw measures keyed by contract channel id, or null if the
 *          torso is not visible enough to establish scale
 */
export function probeBody(pts, map = MEDIAPIPE_POSE_33, aspect = 1, minVis = 0.5) {
  const P = k => pts[map[k]];
  const core = ['shoulderL', 'shoulderR', 'hipL', 'hipR'];
  if (core.some(k => !P(k) || (P(k).v ?? 1) < minVis)) return null;

  const sh = mid(P('shoulderL'), P('shoulderR'));
  const hp = mid(P('hipL'), P('hipR'));
  const torso = dd(sh, hp, aspect);
  if (torso < 1e-4) return null;

  const raw = {
    torso,
    // spine tilt from vertical, signed: + = leaning toward anatomical left
    // (y grows downward in image space, hence the -dy)
    'body.lean': Math.atan2((sh.x - hp.x) * aspect, -(sh.y - hp.y)) * R2D,
    // vertical hip→ankle span in torso units: standing ≈ 1.7–2.2,
    // deep squat ≈ 0.7–1.1 (calibration inverts it into crouch 0..1)
    'body.legspan': null,
    'hip.y': hp.y, 'hip.x': hp.x   // for velocity probes (torso/s downstream)
  };

  const ankL = P('ankleL'), ankR = P('ankleR');
  if (ankL && ankR && (ankL.v ?? 1) >= minVis && (ankR.v ?? 1) >= minVis) {
    raw['body.legspan'] = (mid(ankL, ankR).y - hp.y) / torso;
  }

  for (const [id, [rk, mk, tk]] of Object.entries(LIMB_CHAINS)) {
    const root = P(rk), m = P(mk), tip = P(tk);
    const seen = [root, m, tip].every(p => p && (p.v ?? 1) >= minVis);
    raw[`limb.${id}.seen`] = seen;
    if (!seen) continue;
    const isArm = id[0] === 'a';
    // raise: height of the intent joint vs the limb root, torso units.
    // Arms read the wrist; legs read the KNEE (a high step lifts the knee
    // long before the ankle) — same choice puppet.js made.
    const ref = isArm ? tip : m;
    raw[`limb.${id}.raise`] = (root.y - ref.y) / torso;
    // extend: interior chain angle in DEGREES (contract cal maps it 0..1
    // via bent_deg/straight_deg — angles are already scale-free)
    raw[`limb.${id}.extend`] = chainAngle(root, m, tip, aspect);
    raw[`limb.${id}.tip`] = { x: tip.x, y: tip.y };
  }
  return raw;
}

/** Map an extend angle (deg) to 0..1 given contract {bent_deg, straight_deg}. */
export function normalizeExtend(deg, cal = { bent_deg: 50, straight_deg: 172 }) {
  return clamp((deg - cal.bent_deg) / (cal.straight_deg - cal.bent_deg), 0, 1);
}

/** Map legspan to crouch 0..1 given contract {standing, deep}. Inverted. */
export function normalizeCrouch(legspan, cal = { standing: 1.9, deep: 1.0 }) {
  if (legspan === null || legspan === undefined) return 0;
  return clamp((cal.standing - legspan) / (cal.standing - cal.deep), 0, 1);
}

/**
 * BodyProbe — stateful wrapper: probeBody every frame + One-Euro on each
 * scalar + velocity channels (torso/s) from frame-to-frame hip motion.
 * Output is the contract-keyed value dict a puppet driver consumes.
 *
 *   const probe = new BodyProbe();
 *   const v = probe.update(tracker.detect().pose, performance.now(), aspect);
 *   // v['limb.armL.raise'], v['body.crouch'], v['vel.hip.x'], …
 */
export class BodyProbe {
  constructor(opts = {}) {
    this.opts = {
      map: MEDIAPIPE_POSE_33,
      extendCal: { bent_deg: 50, straight_deg: 172 },
      crouchCal: { standing: 1.9, deep: 1.0 },
      minCutoff: 1.8, beta: 0.12,
      ...opts
    };
    this._f = {};
    this._prev = null;      // { hipX, hipY, tips: {id:{x,y}}, torso, t }
    this.values = {};
    this.raw = null;
  }

  _flt(id, v, dt) {
    const f = this._f[id] || (this._f[id] = new OneEuro(this.opts.minCutoff, this.opts.beta));
    return f.filter(v, dt);
  }

  /** @returns the value dict (held from last good frame if pose is null) */
  update(pose, tMs, aspect = 1) {
    if (!pose) return this.values;
    const raw = probeBody(pose, this.opts.map, aspect);
    if (!raw) return this.values;
    this.raw = raw;
    const dt = this._prev ? (tMs - this._prev.t) / 1000 : 0;
    const v = this.values;

    v['body.lean'] = this._flt('lean', raw['body.lean'], dt);
    v['body.crouch'] = this._flt('crouch',
      normalizeCrouch(raw['body.legspan'], this.opts.crouchCal), dt);

    for (const id of Object.keys(LIMB_CHAINS)) {
      if (!raw[`limb.${id}.seen`]) { v[`limb.${id}.seen`] = false; continue; }
      v[`limb.${id}.seen`] = true;
      v[`limb.${id}.raise`] = this._flt(id + 'r', clamp(raw[`limb.${id}.raise`], -1.5, 1.5), dt);
      v[`limb.${id}.extend`] = this._flt(id + 'e',
        normalizeExtend(raw[`limb.${id}.extend`], this.opts.extendCal), dt);
      v[`limb.${id}.tip`] = raw[`limb.${id}.tip`];
    }

    // Velocities in torso-lengths/second: jump reads vel.hip.y < 0 (up),
    // dash reads |vel.hip.x|; limb tip speeds feed kick strength.
    if (this._prev && dt > 1e-3) {
      const t = raw.torso;
      v['vel.hip.x'] = this._flt('vhx', ((raw['hip.x'] - this._prev.hipX) * aspect) / t / dt, dt);
      v['vel.hip.y'] = this._flt('vhy', (raw['hip.y'] - this._prev.hipY) / t / dt, dt);
      for (const id of ['legL', 'legR']) {
        const tip = raw[`limb.${id}.tip`], p = this._prev.tips[id];
        v[`vel.${id}.tip`] = (tip && p)
          ? this._flt('vt' + id, dd(tip, p, aspect) / t / dt, dt) : 0;
      }
    }

    this._prev = {
      t: tMs, hipX: raw['hip.x'], hipY: raw['hip.y'],
      tips: { legL: raw['limb.legL.tip'], legR: raw['limb.legR.tip'] }
    };
    return v;
  }
}
