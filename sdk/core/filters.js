/**
 * hopeOS SDK — Landmark Filters
 * ═══════════════════════════════════════════════════════════════
 * One-Euro filtering + clamped velocity prediction for MediaPipe
 * landmarks. Replaces the old deadband stabilizer (which traded
 * stair-step quantization for jitter and still lagged).
 *
 * Why One-Euro (the field standard for hand tracking):
 *   at low speed → low cutoff → jitter removed;
 *   at high speed → cutoff rises with velocity → almost zero lag.
 * Tuning: lower minCutoff to kill slow-motion jitter;
 *         raise beta to kill fast-motion lag.
 *
 * Prediction: visible layers may extrapolate landmarks by the
 * pipeline latency (camera + inference ≈ 40–70 ms) using the
 * filter's own velocity estimate, clamped so overshoot never
 * exceeds `maxLead` in normalized units. Physics / alignment
 * should consume MEASURED (non-predicted) output — predicted
 * points fight ground truth (see HOPEOS_ENGINE_BRIEF §6.5).
 *
 * Usage:
 *   const bank = new HandFilterBank({ minCutoff: 1.4, beta: 0.08 });
 *   const smooth = bank.apply('Right', rawLandmarks21, tMs);       // measured
 *   const shown  = bank.predicted('Right', leadMs);                 // for rendering
 *   bank.drop('Right');                                             // on hand lost
 */

const TWO_PI = Math.PI * 2;

/** Single-channel One-Euro filter. */
export class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;      // filtered value
    this.dx = 0;        // filtered velocity (units/sec)
  }

  _alpha(cutoff, dt) {
    const tau = 1 / (TWO_PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() { this.x = null; this.dx = 0; }

  /** Filter one sample. dt in seconds. Returns the filtered value. */
  filter(v, dt) {
    if (this.x === null || !(dt > 0)) { this.x = v; this.dx = 0; return v; }
    const rawDx = (v - this.x) / dt;
    this.dx += this._alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this._alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

/**
 * Filters a full landmark set (21-pt hand by default; pass count: 33 for
 * a MediaPipe pose skeleton), keyed by side/slot. Output objects are
 * reused every frame — treat them as read-only snapshots, do not store
 * references across frames.
 */
export class HandFilterBank {
  constructor(opts = {}) {
    this.count = opts.count ?? 21;
    this.params = {
      minCutoff: opts.minCutoff ?? 1.4,
      beta:      opts.beta      ?? 0.08,
      dCutoff:   opts.dCutoff   ?? 1.0,
      maxLead:   opts.maxLead   ?? 0.08,   // max predicted offset (normalized units)
    };
    this._sides = {};   // side → { f:[count*3 OneEuro], out:[count pts], pred:[count pts], t:lastSec }
  }

  /** Live-tune filter params (sliders). Applies to all existing channels. */
  setParams(p = {}) {
    Object.assign(this.params, p);
    for (const s of Object.values(this._sides)) {
      for (const f of s.f) {
        f.minCutoff = this.params.minCutoff;
        f.beta = this.params.beta;
        f.dCutoff = this.params.dCutoff;
      }
    }
  }

  _slot(side) {
    let s = this._sides[side];
    if (!s) {
      const f = [], out = [], pred = [];
      for (let i = 0; i < this.count * 3; i++) f.push(new OneEuro(this.params.minCutoff, this.params.beta, this.params.dCutoff));
      for (let i = 0; i < this.count; i++) { out.push({ x: 0, y: 0, z: 0 }); pred.push({ x: 0, y: 0, z: 0 }); }
      s = this._sides[side] = { f, out, pred, t: -1 };
    }
    return s;
  }

  /** Reset a side (call when its hand is lost so re-entry doesn't smear). */
  drop(side) {
    const s = this._sides[side];
    if (s) { for (const f of s.f) f.reset(); s.t = -1; }
  }

  /**
   * Filter 21 raw landmarks ({x,y,z}) at time tMs (performance.now()).
   * Returns the measured (filtered, non-predicted) landmark array.
   */
  apply(side, lm, tMs) {
    const s = this._slot(side);
    const tSec = tMs * 0.001;
    let dt = s.t < 0 ? 0 : tSec - s.t;
    if (dt > 0.25) { for (const f of s.f) f.reset(); dt = 0; }   // long gap → reseed
    s.t = tSec;
    for (let i = 0; i < this.count; i++) {
      const p = lm[i], o = s.out[i], k = i * 3;
      o.x = s.f[k].filter(p.x, dt);
      o.y = s.f[k + 1].filter(p.y, dt);
      o.z = s.f[k + 2].filter(p.z || 0, dt);
    }
    return s.out;
  }

  /**
   * Extrapolate the last filtered pose forward by leadMs using filter
   * velocities, clamped to maxLead. For RENDERING only.
   */
  predicted(side, leadMs) {
    const s = this._sides[side];
    if (!s || s.t < 0) return null;
    if (!(leadMs > 0)) return s.out;
    const lead = leadMs * 0.001, cap = this.params.maxLead;
    const clamp = (v) => (v > cap ? cap : v < -cap ? -cap : v);
    for (let i = 0; i < this.count; i++) {
      const o = s.out[i], p = s.pred[i], k = i * 3;
      p.x = o.x + clamp(s.f[k].dx * lead);
      p.y = o.y + clamp(s.f[k + 1].dx * lead);
      p.z = o.z + clamp(s.f[k + 2].dx * lead);
    }
    return s.pred;
  }

  /** Speed (normalized units/sec) of a landmark — handy for hit logic. */
  speed(side, idx = 8) {
    const s = this._sides[side];
    if (!s) return 0;
    const k = idx * 3;
    return Math.hypot(s.f[k].dx, s.f[k + 1].dx, s.f[k + 2].dx);
  }
}
