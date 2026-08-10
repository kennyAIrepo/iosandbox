/**
 * hopeOS lab — HumanCapture component (contract stage 1: GET)
 * ═══════════════════════════════════════════════════════════════
 * Boots the stage-1 stack (camera → FaceLandmarker @ faceEvery:1 +
 * head matrix → PuppetInput smoothing) and emits, per tick, the
 * CONTRACT-KEYED channel values — the only vocabulary that crosses
 * stage boundaries:
 *
 *   values['mouth.open']   0..1   calibrated MAR
 *   values['tongue.out']   0..1   calibrated red-ratio (pixel probe)
 *   values['eye.blink.L']  0..1   1 = closed (calibrated, inverted EAR)
 *   values['eye.blink.R']  0..1
 *   values['head.rot']     {yaw,pitch,roll} degrees, mirrored-view
 *
 * Raw (uncalibrated) measures ride alongside for meters/ritual.
 * Shared by riglab / taplab / pipeline — one implementation, one truth.
 */

import { initCamera, initTracking } from '../core/tracking.js';
import { PuppetInput } from '../interaction/puppet.js';
import { probeHuman, normalize } from '../interaction/face-measures.js';

export class HumanCapture {
  /** @param {HTMLVideoElement} videoEl  hidden or visible detection video */
  constructor(videoEl) {
    this.vid = videoEl;
    this.tracker = null;
    this.puppet = null;
    this.faceMs = 0;
    this._lastFace = 0;
    this.landmarks = null;      // last raw 478 (unmirrored video coords)
    this.raw = {};              // uncalibrated measures
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

    if (this._lastFace) this.faceMs = this.faceMs * 0.9 + (t - this._lastFace) * 0.1;
    this._lastFace = t;
    this.landmarks = lm;

    const aspect = (this.vid.videoWidth || 4) / (this.vid.videoHeight || 3);
    const raw = probeHuman(lm, aspect);
    raw['tongue.out'] = s.mouth.tongueAmount;
    this.raw = raw;

    this.values = {
      'mouth.open': normalize(raw['mouth.open'], cal['mouth.open']),
      'tongue.out': normalize(raw['tongue.out'], cal['tongue.out']),
      'eye.blink.L': 1 - normalize(raw['eye.blink.L'], { neutral: cal['eye.L'].closed, max: cal['eye.L'].open }),
      'eye.blink.R': 1 - normalize(raw['eye.blink.R'], { neutral: cal['eye.R'].closed, max: cal['eye.R'].open }),
      'head.rot': { yaw: s.head.yaw, pitch: s.head.pitch, roll: s.head.roll }
    };
    return true;
  }
}
