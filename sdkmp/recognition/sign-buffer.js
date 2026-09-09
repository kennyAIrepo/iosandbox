/**
 * hopeOS SDK — Sign Buffer + Segmenter
 * ═══════════════════════════════════════════════════════════════
 * Ring buffer of SignFeaturizer frames resampled to a fixed rate
 * (default 15 Hz — the rate Google's own sign-language work found
 * sufficient, and what the classifier trains at), plus the motion-energy
 * state machine that finds isolated-sign boundaries in a continuous
 * stream. Isolated-sign training data never teaches a model where signs
 * start and end — this segmenter carries that load.
 *
 * Motion energy = mean per-second displacement of wrist + fingertips of
 * every visible hand, in torso-units/s (scale-free, same invariance
 * doctrine as body-measures velocities).
 *
 * FSM: idle —energy>start && a hand seen→ active (window opens with
 * PREROLL slots of lead-in) —energy<stop for quietMs, or maxSignMs→
 * close → onSegment({data, length, durMs, …}) if ≥ minSignMs.
 * Hand dropouts shorter than holdMs (300 — the HandProbe idiom) do not
 * end a segment; tracking blips must not split signs.
 *
 * Window layout for the classifier: Float32Array [T × FEATURE_DIM],
 * zero-padded to T (fixed-shape ONNX export — pad+mask, never dynamic
 * axes), NaN → 0 at assembly.
 */

import { FEATURE_DIM, HAND_L_OFF, HAND_R_OFF, N_HAND } from './sign-landmarks.js';

// wrist + fingertips, the motion-reading points of a 21-pt hand
const MOTION_PTS = [0, 4, 8, 12, 16, 20];

export class SignBuffer {
  constructor(opts = {}) {
    this.opts = {
      rateHz: 15,
      windowT: 64,        // classifier sequence length (fixed ONNX shape)
      preroll: 3,         // lead-in slots included before the trigger
      startEnergy: 0.6,   // torso-units/s — opens a segment
      stopEnergy: 0.22,   // below this counts as quiet
      quietMs: 400,       // quiet this long closes the segment
      minSignMs: 250,     // shorter → discarded as a twitch
      maxSignMs: 4000,    // hard cap → force-close
      holdMs: 300,        // hand-dropout tolerance inside a segment
      onSegment: null,    // ({data, length, t0, t1, durMs, peakEnergy}) => {}
      ...opts
    };
    const cap = this.opts.windowT + this.opts.preroll + 8;
    this._slots = Array.from({ length: cap }, () => new Float32Array(FEATURE_DIM));
    this._slotT = new Float64Array(cap);
    this._head = -1;            // index of most recent committed slot
    this._count = 0;
    this._nextT = -1;           // slot clock
    this._latest = null;        // most recent feature frame (pre-commit)
    this._prevSlot = null;
    this._lastHandT = -Infinity;

    // live values (contract-keyed by SignRecognizer)
    this.energy = 0;
    this.active = false;
    this._activeSince = 0;
    this._quietSince = 0;
    this._segStart = -1;        // absolute slot number where segment opened
    this._absSlot = -1;         // absolute committed-slot counter
    this.peakEnergy = 0;
  }

  /** Feed every featurizer frame (call once per detect()). */
  push(feat, tMs) {
    this._latest = feat;
    if (feat.handL || feat.handR) this._lastHandT = tMs;
    const period = 1000 / this.opts.rateHz;
    if (this._nextT < 0) this._nextT = tMs + period;
    // commit slots on the fixed clock; latest sample wins, gaps repeat it
    while (tMs >= this._nextT) {
      this._commit(feat, this._nextT);
      this._nextT += period;
    }
  }

  _commit(feat, slotT) {
    const cap = this._slots.length;
    this._head = (this._head + 1) % cap;
    this._absSlot++;
    this._count = Math.min(this._count + 1, cap);
    const slot = this._slots[this._head];
    slot.set(feat.f);
    this._slotT[this._head] = slotT;

    // ── motion energy vs previous committed slot ──
    const prev = this._prevSlot;
    let energy = 0;
    if (prev) {
      let sum = 0, n = 0;
      for (const off of [HAND_L_OFF, HAND_R_OFF]) {
        for (const p of MOTION_PTS) {
          const i = (off + p) * 2;
          const dx = slot[i] - prev[i], dy = slot[i + 1] - prev[i + 1];
          if (Number.isFinite(dx) && Number.isFinite(dy)) { sum += Math.hypot(dx, dy); n++; }
        }
      }
      if (n) energy = (sum / n) * this.opts.rateHz;   // per-second, torso units
    }
    this._prevSlot = this._slots[this._head];
    this.energy = energy;

    // ── segmentation FSM ──
    const handHeld = slotT - this._lastHandT < this.opts.holdMs;
    if (!this.active) {
      if (energy > this.opts.startEnergy && handHeld) {
        this.active = true;
        this._activeSince = slotT;
        this._quietSince = 0;
        this.peakEnergy = energy;
        this._segStart = Math.max(this._absSlot - this.opts.preroll, this._absSlot - this._count + 1);
      }
    } else {
      this.peakEnergy = Math.max(this.peakEnergy, energy);
      const quiet = energy < this.opts.stopEnergy;
      if (quiet && handHeld) {
        if (!this._quietSince) this._quietSince = slotT;
      } else if (!quiet) {
        this._quietSince = 0;
      }
      // a dropout past holdMs also winds the segment down via quiet clock
      if (!handHeld && !this._quietSince) this._quietSince = slotT;
      const dur = slotT - this._activeSince;
      if ((this._quietSince && slotT - this._quietSince >= this.opts.quietMs) ||
          dur >= this.opts.maxSignMs) {
        this._close(slotT);
      }
    }
  }

  _close(slotT) {
    this.active = false;
    const durMs = slotT - this._activeSince;
    const segLen = Math.min(this._absSlot - this._segStart + 1, this.opts.windowT, this._count);
    if (durMs >= this.opts.minSignMs && segLen >= 2 && this.opts.onSegment) {
      const { windowT } = this.opts;
      const data = new Float32Array(windowT * FEATURE_DIM);   // zero-padded
      const cap = this._slots.length;
      const firstAbs = this._absSlot - segLen + 1;
      for (let k = 0; k < segLen; k++) {
        const ring = (this._head - (segLen - 1 - k) + cap * 2) % cap;
        const src = this._slots[ring];
        const dst = k * FEATURE_DIM;
        for (let i = 0; i < FEATURE_DIM; i++) {
          const v = src[i];
          data[dst + i] = Number.isFinite(v) ? v : 0;
        }
      }
      this.opts.onSegment({
        data, length: segLen,
        t0: slotT - durMs, t1: slotT, durMs,
        peakEnergy: this.peakEnergy, firstAbs
      });
    }
    this._segStart = -1;
    this._quietSince = 0;
    this.peakEnergy = 0;
  }

  /** 0..1 — how much of a full window the current segment has consumed. */
  get fill() {
    if (!this.active) return 0;
    return Math.min(1, (this._absSlot - this._segStart + 1) / this.opts.windowT);
  }
}
