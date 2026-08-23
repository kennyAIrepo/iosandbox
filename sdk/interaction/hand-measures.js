/**
 * hopeOS SDK — Canonical Hand Measures
 * ═══════════════════════════════════════════════════════════════
 * The HAND lane of the body-puppet contract: MediaPipe HandLandmarker's
 * 21 points → per-finger CURL measures. Same principle as face/body
 * measures: dimensionless ratios only, no positions across the boundary.
 *
 * CURL formula (per finger): tip-to-MCP distance over summed segment
 * lengths. Straight finger → tip sits one full finger-length from the
 * MCP → ratio ≈ 1 → curl 0. Fully curled → tip returns next to the
 * MCP → ratio ≈ 0.3 → curl 1. Distance-ratio form is invariant to hand
 * size, camera distance, AND mirroring (distances don't care), so it
 * runs on raw or mirrored landmarks unchanged.
 *
 * Channels (contract vocabulary):
 *   finger.<side>.<thumb|index|middle|ring|pinky>.curl   0..1
 *   hand.<side>.grip                                     mean 4-finger curl
 *   hand.<side>.seen
 *
 * Sides are ANATOMICAL ('L'/'R') — tracking.js already flips MediaPipe's
 * selfie-mirrored handedness labels, pass its `handedness` through.
 */

import { OneEuro } from '../core/filters.js';

// MediaPipe 21-pt hand: per finger [MCP, PIP, DIP, TIP] (thumb: CMC..TIP)
export const FINGER_POINTS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20]
};
export const FINGERS = Object.keys(FINGER_POINTS);

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Raw curl 0..1 for one finger of one 21-pt landmark array. */
export function fingerCurl(lm, finger) {
  const [m, p, q, t] = FINGER_POINTS[finger].map(i => lm[i]);
  const len = d(m, p) + d(p, q) + d(q, t);
  if (len < 1e-6) return 0;
  const ratio = d(m, t) / len;                    // 1 straight … ~0.3 curled
  // thumb never folds as far — its ratio floor is higher
  const lo = finger === 'thumb' ? 0.55 : 0.35;
  return clamp((1 - ratio) / (1 - lo), 0, 1);
}

/** All finger measures for one hand. @returns {thumb..pinky, grip} */
export function probeHand(lm) {
  const out = {};
  let sum = 0;
  for (const f of FINGERS) {
    out[f] = fingerCurl(lm, f);
    if (f !== 'thumb') sum += out[f];
  }
  out.grip = sum / 4;
  return out;
}

/**
 * HandProbe — stateful: consumes tracker.detect()'s hands+handedness each
 * frame, One-Euro per channel, emits contract-keyed values for BOTH hands.
 *
 *   const hands = new HandProbe();
 *   const hv = hands.update(frame.hands, frame.handedness, t);
 *   // hv['finger.L.index.curl'], hv['hand.R.grip'], hv['hand.L.seen'] …
 */
export class HandProbe {
  constructor(opts = {}) {
    this.opts = { minCutoff: 2.2, beta: 0.18, holdMs: 300, ...opts };
    this._f = {};
    this._lastSeen = { L: 0, R: 0 };
    this._lastT = 0;
    this.values = { 'hand.L.seen': false, 'hand.R.seen': false };
  }

  _flt(id, v, dt) {
    const f = this._f[id] || (this._f[id] = new OneEuro(this.opts.minCutoff, this.opts.beta));
    return f.filter(v, dt);
  }

  update(hands, handedness, tMs) {
    const dt = this._lastT ? (tMs - this._lastT) / 1000 : 0;
    this._lastT = tMs;
    const v = this.values;
    if (hands) {
      for (let h = 0; h < hands.length; h++) {
        const side = handedness?.[h] === 'Right' ? 'R' : 'L';
        const m = probeHand(hands[h]);
        for (const f of FINGERS) {
          v[`finger.${side}.${f}.curl`] = this._flt(side + f, m[f], dt);
        }
        v[`hand.${side}.grip`] = this._flt(side + 'g', m.grip, dt);
        this._lastSeen[side] = tMs;
      }
    }
    // hold briefly through dropouts, then flag unseen (drivers ease to rest)
    v['hand.L.seen'] = tMs - this._lastSeen.L < this.opts.holdMs;
    v['hand.R.seen'] = tMs - this._lastSeen.R < this.opts.holdMs;
    return v;
  }
}
