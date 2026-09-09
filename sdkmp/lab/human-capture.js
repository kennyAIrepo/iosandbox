/**
 * hopeOS lab — HumanCapture component (contract stage 1: GET)
 * ═══════════════════════════════════════════════════════════════
 * Boots the stage-1 stack (camera → FaceLandmarker @ faceEvery:1 +
 * head matrix → PuppetInput smoothing) and emits, per tick, the
 * CONTRACT-KEYED channel values — the only vocabulary that crosses
 * stage boundaries.
 *
 * v2 channel set — all from the SAME single inference call:
 *   geometry (calibrated ratios):  mouth.open, mouth.width, eye.blink.L/R
 *   pixel probe:                   tongue.out
 *   matrix:                        head.rot {yaw,pitch,roll}
 *   blendshapes (identity-free):   smile L/R, pucker, brows ×5,
 *                                  cheek raise L/R + puff, eye wide L/R,
 *                                  nose sneer L/R   (BLEND_CHANNELS)
 *   gaze (from eyeLook* scores):   gaze.yaw, gaze.pitch  (signed)
 *
 * LATENCY CONTRACT: expanding channels adds arithmetic only — no new
 * model, no extra inference. `probeUs` reports the measured per-frame
 * cost of ALL channel math so the claim is verifiable in the HUD.
 * Every scalar channel gets its own One-Euro filter (µs each).
 */

import { initCamera, initTracking } from '../core/tracking.js';
import { PuppetInput } from '../interaction/puppet.js';
import { probeHuman, normalize, BLEND_CHANNELS, blendDict, gazeFromBlend }
  from '../interaction/face-measures.js';
import { OneEuro } from '../core/filters.js';

export class HumanCapture {
  /** @param {HTMLVideoElement} videoEl  hidden or visible detection video */
  constructor(videoEl) {
    this.vid = videoEl;
    this.tracker = null;
    this.puppet = null;
    this.faceMs = 0;
    this.probeUs = 0;           // measured channel-math cost (µs, EMA)
    this._lastFace = 0;
    this._lastT = 0;
    this._filters = {};         // channel id → OneEuro
    this.landmarks = null;      // last raw 478 (unmirrored video coords)
    this.raw = {};              // uncalibrated measures
    this.blend = {};            // raw blendshape dict (name → score)
    this.values = {};           // contract-keyed calibrated channel values
  }

  async boot() {
    await initCamera(null, this.vid);
    this.tracker = await initTracking(this.vid, {
      enableHands: false, enablePose: false, faceEvery: 1, faceMatrix: true
    });
    this.puppet = new PuppetInput(this.vid);
    return this;
  }

  get booted() { return !!this.tracker; }

  _f(id, v, dt) {
    const f = this._filters[id] || (this._filters[id] = new OneEuro(1.8, 0.12));
    return f.filter(v, dt);
  }

  /**
   * @param {number} t   performance.now()
   * @param {Object} cal CalStore.cal (per-user calibration)
   * @returns {boolean}  true if a face frame landed this tick
   */
  tick(t, cal) {
    const frame = this.tracker.detect();
    const s = this.puppet.update(frame, t);
    const lm = frame?.face?.landmarks || null;
    this.state = s;
    this.hasMatrix = !!frame?.face?.matrix;
    if (!lm) return false;

    const dt = this._lastT ? (t - this._lastT) / 1000 : 0;
    this._lastT = t;
    if (this._lastFace) this.faceMs = this.faceMs * 0.9 + (t - this._lastFace) * 0.1;
    this._lastFace = t;
    this.landmarks = lm;

    const p0 = performance.now();

    const aspect = (this.vid.videoWidth || 4) / (this.vid.videoHeight || 3);
    const raw = probeHuman(lm, aspect);
    raw['tongue.out'] = s.mouth.tongueAmount;
    this.raw = raw;
    const bd = this.blend = blendDict(frame.face.blendshapes);

    const v = this.values;
    // geometry-calibrated core
    v['mouth.open'] = this._f('mo', normalize(raw['mouth.open'], cal['mouth.open']), dt);
    // lateral opening toward the cheeks — one geometric width measure fans
    // out to both corner-stretch channels (asymmetric L/R split can come
    // later from per-corner geometry without touching the contract shape)
    const wv = this._f('mw',
      cal['mouth.width'] ? normalize(raw['mouth.width'], cal['mouth.width']) : 0, dt);
    v['mouth.stretch.L'] = wv;
    v['mouth.stretch.R'] = wv;
    v['tongue.out'] = normalize(raw['tongue.out'], cal['tongue.out']);   // pre-smoothed in mouth.js
    v['eye.blink.L'] = this._f('bl',
      1 - normalize(raw['eye.blink.L'], { neutral: cal['eye.L'].closed, max: cal['eye.L'].open }), dt);
    v['eye.blink.R'] = this._f('br',
      1 - normalize(raw['eye.blink.R'], { neutral: cal['eye.R'].closed, max: cal['eye.R'].open }), dt);
    v['head.rot'] = { yaw: s.head.yaw, pitch: s.head.pitch, roll: s.head.roll }; // smoothed upstream
    // blendshape fringe — already 0..1, smooth only
    for (const [ch, name] of Object.entries(BLEND_CHANNELS)) {
      v[ch] = this._f(ch, bd[name] || 0, dt);
    }
    // gaze (signed)
    const g = gazeFromBlend(bd);
    v['gaze.yaw'] = this._f('gy', g.yaw, dt);
    v['gaze.pitch'] = this._f('gp', g.pitch, dt);

    this.probeUs = this.probeUs * 0.9 + (performance.now() - p0) * 1000 * 0.1;
    return true;
  }
}
