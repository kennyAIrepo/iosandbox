/**
 * hopeOS SDK — Wing Drive (human arms → dragon wings) + flap-to-fly control
 * ═══════════════════════════════════════════════════════════════
 * The HUMAN half of the "become the dragon" contract, pure math (node-
 * testable, no three.js): consumes raw MediaPipe BlazePose-33 WORLD
 * landmarks (x image-right = the user's anatomical LEFT, y DOWN, z toward
 * the camera negative — the same raw feed the avatar live-drive reads) and
 * turns each arm into wing ANGLES, never positions:
 *
 *   shoulder landmark  → the wing's attachment (defines the body frame:
 *                        lateral = shoulderL−shoulderR, up = hips→shoulders,
 *                        forward = lateral × up)
 *   upper arm          → first half of the wing (arm → elbow "drum")
 *   forearm            → second half (elbow → wrist → fingers "flat")
 *
 * Per arm: elev  = elevation of the segment above the shoulder line
 *                  (0 = straight out, +90 = up, −90 = hanging down)
 *          sweep = forward/back of the segment (+ = toward the camera)
 * measured in the user's own body frame — invariant to where they stand,
 * how far from the camera, and how tall they are (angles, not lengths:
 * body-measures doctrine). Hands are NOT needed; wrists come from the pose.
 * Every channel is One-Euro smoothed (pose jitter never reaches a bone).
 *
 * FLAP DETECTION — a hysteresis stroke counter on the mean upper-arm
 * elevation around its running centre (so a tired low flap counts like a
 * high one): rate (cycles/s) + amplitude over a short window.
 *
 * FLIGHT CONTROL (Kinect Adventures' flying grammar — flap to rise, arms
 * out to hold, lean to steer — with a charging ring as the decision cue):
 *   ground  : fast flapping (≥ fastHz for chargeSec) fills the meter →
 *             LIFT OFF event. Slow / no flapping drains it.
 *   flying  : flapping = climb (rate-scaled) · arms out & still = glide
 *             (slow sink) · arms down = descend · touchdown → LANDED event.
 *   steer   : torso FACING (turn your body left → the dragon turns left);
 *             shoulder lean only flavours the bank.
 *   dive    : bend the torso forward → the dragon noses down and dives;
 *             straighten up → back to glide.
 *   head    : read whenever the face is seen, independent of the arms.
 *
 * Usage:
 *   const wings = new WingDrive(), ctl = new DragonFlightControl();
 *   const st = wings.update(poseWorld, dt);       // per frame (null = no pose)
 *   dragonDriver.setUserWings(st);
 *   const c = ctl.update(st, dt, dragonDriver.altitude);
 *   // c.event: 'liftoff' | 'landed' | null · c.phase · c.meter · c.climb · c.turn
 */

import { OneEuro } from '../core/filters.js';

const R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const LM = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, hipL: 23, hipR: 24 };

const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

export const WING_CFG = {
  minVis: 0.5,             // landmark visibility floor for a valid read
  smooth: { minCutoff: 2.0, beta: 0.06 },   // One-Euro: quick on flaps, calm at rest
  headYawGain: 1.4, headPitchGain: 1.0,
};

export class WingDrive {
  constructor(cfg = WING_CFG) {
    this.cfg = cfg;
    this._f = {};             // channel → OneEuro
    this.state = this._blank();
    this._prevElev = null;
  }
  _blank() {
    return { valid: false, L: { elev: 0, sweep: 0, elevF: 0, sweepF: 0, bend: 0 }, R: { elev: 0, sweep: 0, elevF: 0, sweepF: 0, bend: 0 },
             elev: 0, elevVel: 0, roll: 0, facing: 0, bend: 0, head: { yaw: 0, pitch: 0, roll: 0, seen: false }, torso: 0,
             armsSeen: 0, hipsSeen: false };
  }
  _flt(key, v, dt) {
    const f = this._f[key] || (this._f[key] = new OneEuro(this.cfg.smooth.minCutoff, this.cfg.smooth.beta));
    return f.filter(v, dt);
  }
  _fltSlow(key, v, dt) {                       // depth-derived channels: calmer cutoff, z is the noisy axis
    const f = this._f[key] || (this._f[key] = new OneEuro(0.9, 0.03));
    return f.filter(v, dt);
  }
  reset() { for (const f of Object.values(this._f)) f.reset(); this.state = this._blank(); this._prevElev = null; this._bendRef = null; }

  /**
   * @param {Array|null} w  33 raw world landmarks ({x,y,z,visibility}) or null
   * @param {number} dt     seconds
   * @returns {object} state (also this.state) — angles in degrees
   */
  update(w, dt) {
    const s = this.state;
    const vis = i => (w && w[i] && (w[i].visibility ?? 1)) || 0;
    // ── head FIRST, independent of the arms: ear-mid → nose protrusion (same
    //    lane the avatar uses). A user who only turns their head still turns
    //    the dragon's head, even with the arms out of frame.
    const H = s.head;
    if (vis(LM.nose) >= this.cfg.minVis && vis(LM.earL) >= this.cfg.minVis && vis(LM.earR) >= this.cfg.minVis) {
      const eL = w[LM.earL], eR = w[LM.earR], n = w[LM.nose];
      const fx = n.x - (eL.x + eR.x) / 2, fy = n.y - (eL.y + eR.y) / 2, fz = n.z - (eL.z + eR.z) / 2;
      const ex = eL.x - eR.x, ey = eL.y - eR.y, ez = eL.z - eR.z;
      if (Math.hypot(fx, fy, fz) > 1e-9) {
        H.yaw = this._flt('hy', clamp(Math.atan2(fx, -fz) * R2D * this.cfg.headYawGain, -70, 70), dt);       // nose toward +x (user's LEFT) → +
        H.pitch = this._flt('hp', clamp((Math.atan2(-fy, Math.hypot(fx, fz)) * R2D + 8) * this.cfg.headPitchGain, -35, 35), dt);
        H.roll = this._flt('hr', Math.atan2(-ey, Math.hypot(ex, ez)) * R2D, dt);
        H.seen = true;
      }
    } else H.seen = false;
    // ── WHAT IS REQUIRED: the two shoulders + at least ONE full arm (shoulder,
    //    elbow, wrist). Hips and legs are OPTIONAL — an upper-body framing
    //    (head + spread arms) drives everything: flap, glide, steer, dive.
    const mv = this.cfg.minVis;
    const armOk = side => vis(LM['sh' + side]) >= mv && vis(LM['el' + side]) >= mv && vis(LM['wr' + side]) >= mv;
    const okL = !!w && armOk('L'), okR = !!w && armOk('R');
    const shouldersOk = !!w && vis(LM.shL) >= mv && vis(LM.shR) >= mv;
    if (!shouldersOk || (!okL && !okR)) {
      s.valid = false; s.elevVel = 0; this._prevElev = null;
      return s;
    }
    s.armsSeen = (okL ? 1 : 0) + (okR ? 1 : 0);
    // ── body frame ──
    const shL = w[LM.shL], shR = w[LM.shR];
    const shM = mid(shL, shR);
    const Lat = norm(sub(shL, shR));                 // user's left
    const hipsOk = vis(LM.hipL) >= mv && vis(LM.hipR) >= mv;
    const headOk = H.seen;
    // up: hips→shoulders when the hips are seen; otherwise the camera vertical
    // (raw y is down) — arm elevation then reads against the horizon, which is
    // what a flap is anyway
    let Up;
    if (hipsOk) { const hipM = mid(w[LM.hipL], w[LM.hipR]); Up = norm(sub(shM, hipM)); s.torso = Math.hypot(...sub(shM, hipM)); }
    else { Up = [0, -1, 0]; s.torso = Math.hypot(...sub(shL, shR)) * 1.4; }
    // keep Up orthogonal to the shoulder line so a lean doesn't leak into elevation
    const k = dot(Up, Lat); Up = norm([Up[0] - k * Lat[0], Up[1] - k * Lat[1], Up[2] - k * Lat[2]]);
    const Fwd = norm(cross(Lat, Up));                // toward the camera
    s.hipsSeen = hipsOk;
    // ── per arm: elevation / sweep of upper arm and forearm ──
    for (const side of ['L', 'R']) {
      if (!(side === 'L' ? okL : okR)) continue;
      const out = side === 'L' ? Lat : [-Lat[0], -Lat[1], -Lat[2]];
      const sh = w[LM['sh' + side]], el = w[LM['el' + side]], wr = w[LM['wr' + side]];
      const a = sub(el, sh), b = sub(wr, el);
      const la = Math.hypot(...a) || 1e-6, lb = Math.hypot(...b) || 1e-6;
      // outward component floored so an arm crossed over the chest can't wrap
      const ao = Math.max(dot(a, out), 0.15 * la), bo = Math.max(dot(b, out), 0.15 * lb);
      const S = s[side];
      S.elev = this._flt(side + 'e', Math.atan2(dot(a, Up), ao) * R2D, dt);
      S.sweep = this._flt(side + 's', Math.atan2(dot(a, Fwd), ao) * R2D, dt);
      S.elevF = this._flt(side + 'ef', Math.atan2(dot(b, Up), bo) * R2D, dt);
      S.sweepF = this._flt(side + 'sf', Math.atan2(dot(b, Fwd), bo) * R2D, dt);
      S.bend = this._flt(side + 'b', Math.acos(clamp(dot(a, b) / (la * lb), -1, 1)) * R2D, dt);
    }
    // one arm out of frame → it mirrors the visible one (the game never stalls on a lost wrist)
    if (okL !== okR) { const from = okL ? s.L : s.R, to = okL ? s.R : s.L; Object.assign(to, from); }
    const elev = (s.L.elev + s.R.elev) / 2;
    s.elevVel = this._prevElev === null || !(dt > 0) ? 0 : (elev - this._prevElev) / dt;
    this._prevElev = elev;
    s.elev = elev;
    // ── lean: shoulder-line roll, + = user leans to THEIR left ──
    s.roll = this._flt('roll', Math.atan2(shL.y - shR.y, Math.abs(shL.x - shR.x) || 1e-6) * R2D, dt);
    // ── facing: where the torso points, + = turned to the user's LEFT. The
    //    shoulder line swings in depth when the body rotates about the vertical:
    //    left shoulder AWAY from the camera (+z) = turned left. Hips corroborate
    //    when seen; the shoulders alone are enough.
    const yawS = Math.atan2(Lat[2], Math.abs(Lat[0]) || 1e-6) * R2D;
    let facing = yawS;
    if (hipsOk) { const latH = sub(w[LM.hipL], w[LM.hipR]); facing = yawS * 0.7 + Math.atan2(latH[2], Math.abs(latH[0]) || 1e-6) * R2D * 0.3; }
    s.facing = this._fltSlow('face', clamp(facing, -80, 80), dt);
    // ── bend: torso pitched toward the camera, + = forward. With hips: the
    //    hips→shoulders axis. Without: the shoulders→head axis tips the same way
    //    when the body folds forward (spine and neck lean together).
    let bend = 0;
    if (hipsOk) { bend = Math.atan2(-Up[2], Math.max(-Up[1], 1e-3)) * R2D; this._bendRef = null; }
    else if (headOk) {
      const eM = mid(w[LM.earL], w[LM.earR]); const v = sub(eM, shM);
      const raw = Math.atan2(-v[2], Math.max(-v[1], 1e-3)) * R2D;
      // the ears sit wherever this person's neck puts them: the first reading
      // (standing normally when the dragon is taken) is the upright reference,
      // which then only follows slow, small drift — a held dive is never absorbed
      if (this._bendRef === null || this._bendRef === undefined) this._bendRef = raw;
      else if (Math.abs(raw - this._bendRef) < 18) this._bendRef += (raw - this._bendRef) * Math.min(1, dt / 6);
      bend = raw - this._bendRef;
    }
    s.bend = this._fltSlow('bend', clamp(bend, -60, 80), dt);
    s.valid = true;
    return s;
  }
}

export const FLIGHT_CFG = {
  strokeHyst: 12,          // deg above/below the running centre to count a stroke
  minAmp: 26,              // deg peak-to-peak over the window to be a real flap
  window: 1.6,             // s — rate window
  fastHz: 1.25,            // cycles/s that count as "fast" flapping
  chargeSec: 2.4,          // sustained fast flapping needed to lift off
  drainSec: 1.2,           // meter empties this fast without fast flapping
  climbHz: 0.45,           // in flight: any flapping above this climbs
  glideElev: 32,           // |elev| under this with no strokes = arms out → glide
  downElev: -50,           // both arms below this = come down
  glideSink: -0.22, downSink: -1.0,
  leanDead: 6, leanFull: 26,   // deg of shoulder roll → bank feel (visual)
  faceDead: 8, faceFull: 40,   // deg of torso facing → turn 0 … ±1 (the steering channel)
  bendDead: 12, bendFull: 45,  // deg of forward torso bend → dive 0 … 1
  diveSink: -1.3,
};

export class DragonFlightControl {
  constructor(cfg = FLIGHT_CFG) {
    this.cfg = cfg;
    this.phase = 'ground';   // ground | flying
    this.meter = 0;          // 0..1 take-off charge
    this.rate = 0;           // flap cycles/s
    this.amp = 0;            // deg peak-to-peak (window)
    this.climb = 0;          // −1..1 requested vertical
    this.turn = 0;           // −1..1 (+ = left) — from torso FACING
    this.bank = 0;           // −1..1 (+ = left) — from shoulder lean (visual feel)
    this.dive = 0;           // 0..1 — forward torso bend
    this.event = null;
    this.t = 0;
    this._centre = null; this._dir = 0; this._strokes = []; this._hist = [];
    this._lastStroke = -1e9;
  }
  reset() { this.phase = 'ground'; this.meter = 0; this.rate = 0; this.amp = 0; this.climb = 0; this.turn = 0; this.bank = 0; this.dive = 0; this._strokes = []; this._hist = []; this._centre = null; this._dir = 0; }

  _strokeTrack(elev, dt) {
    const c = this.cfg;
    this.t += dt;
    if (this._centre === null) this._centre = elev;
    this._centre += (elev - this._centre) * Math.min(1, dt / 1.5);     // slow running centre
    const hi = this._centre + c.strokeHyst, lo = this._centre - c.strokeHyst;
    const dir = elev > hi ? 1 : elev < lo ? -1 : this._dir;
    if (dir !== this._dir && this._dir !== 0) { this._strokes.push(this.t); this._lastStroke = this.t; }
    this._dir = dir;
    this._hist.push([this.t, elev]);
    while (this._strokes.length && this.t - this._strokes[0] > c.window) this._strokes.shift();
    while (this._hist.length && this.t - this._hist[0][0] > 1.0) this._hist.shift();
    let mn = 1e9, mx = -1e9;
    for (const [, e] of this._hist) { mn = Math.min(mn, e); mx = Math.max(mx, e); }
    this.amp = this._hist.length ? mx - mn : 0;
    this.rate = this._strokes.length / 2 / c.window;
  }

  /**
   * @param {object} st  WingDrive state
   * @param {number} dt  seconds
   * @param {number} altitude  the dragon's current height above ground (model units)
   */
  update(st, dt, altitude = 0) {
    const c = this.cfg;
    this.event = null;
    if (!st || !st.valid) {                       // lost the body: hold, drain slowly
      this.climb = 0; this.turn = 0; this.bank = 0; this.dive = 0; this.rate = 0;
      if (this.phase === 'ground') this.meter = Math.max(0, this.meter - dt / (c.drainSec * 2));
      return this;
    }
    this._strokeTrack(st.elev, dt);
    const flapping = this.amp >= c.minAmp && this.rate > 0;
    const fast = flapping && this.rate >= c.fastHz;
    // steer: the torso FACING decides the direction (turn your body → the dragon turns);
    // shoulder lean only flavours the bank; a forward bend is a dive (in flight)
    const ramp = (v, dead, full) => { const a = Math.abs(v); return a < dead ? 0 : clamp((a - dead) / (full - dead), 0, 1) * Math.sign(v); };
    this.turn = ramp(st.facing, c.faceDead, c.faceFull);
    this.bank = ramp(st.roll, c.leanDead, c.leanFull);
    this.dive = this.phase === 'flying' ? Math.max(0, ramp(st.bend, c.bendDead, c.bendFull)) : 0;
    if (this.phase === 'ground') {
      this.meter = clamp(this.meter + (fast ? dt / c.chargeSec : -dt / c.drainSec), 0, 1);
      this.climb = 0;
      if (this.meter >= 1) { this.phase = 'flying'; this.event = 'liftoff'; this.climb = 1; }
      return this;
    }
    // flying
    const still = this.t - this._lastStroke > 0.9;
    const armsDown = st.L.elev < c.downElev && st.R.elev < c.downElev;
    const armsOut = still && Math.abs(st.L.elev) < c.glideElev && Math.abs(st.R.elev) < c.glideElev;
    if (this.dive > 0) this.climb = c.diveSink * this.dive;                 // bend forward → dive
    else if (flapping && this.rate >= c.climbHz) this.climb = clamp(this.rate / c.fastHz, 0.35, 1);
    else if (armsDown) this.climb = c.downSink;
    else if (armsOut) this.climb = c.glideSink;
    else this.climb = c.glideSink * 0.6;          // arms somewhere in between: gentle sink
    if (this.climb < 0 && altitude <= 0.05) { this.phase = 'ground'; this.meter = 0; this.event = 'landed'; this.climb = 0; }
    return this;
  }
}
