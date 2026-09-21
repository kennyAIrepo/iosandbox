/**
 * throw-detect.mjs — classify a release under the prop doctrine and build the launch.
 * ─────────────────────────────────────────────────────────────────────────────
 * Release is NOT a gesture. It is the grab gate failing: mpbrowser.html re-checks
 * `_wrapGrab(pack, 0.03, slot)` every frame (30 mm keep-skin vs the 6 mm grab
 * skin — hysteresis, mpbrowser.html:1598-1602 / 1620-1628) and the cradle drops
 * when the palm normal's y falls below 0.3 (:1638-1639). This module only decides
 * what the release WAS (drop / throw / clamped throw) and produces v0, w0 in
 * court units for the LAUNCH packet.
 *
 * Inputs are duck-typed to the stack's HandBody (sdk/core/game-physics.js):
 *   hand.present, hand.vel[i] (21 × {x,y,z} m/s), hand.angVel ({x,y,z} rad/s)
 * and the ball's palm-follow velocity history — the same 6-frame `_velHist`
 * mean that GrabbableSphere (game-physics.js:268-271) and the glass-ball lane
 * (mpbrowser.html:1603-1607) already turn into the throw. No three.js import:
 * plain {x,y,z} math so this runs headless.
 */
import { integrateCourt } from './court-map.js';

export const THROW = Object.freeze({
  V_DROP: 0.25,          // below: a drop (units/s, 1 unit = tile height)
  V_MAX_OUT: 3.0,        // above: clamped (excess → cosmetic spin)
  V_MAX_IN: 2.0,         // entry cap in the receiving tile (latency-feel.md §3)
  DIR_COHERENCE: 0.8,    // pairwise dot of the last 3 normalized velocity samples
  PALM_COHERENCE: 0.7,   // mean pairwise dot of palm-joint velocities
  SPIN_SCALE: 0.85,      // GrabbableSphere: angVel × 0.85 on release (game-physics.js:272)
  LOB_VD: -1.5,          // a throw TOWARD the camera faster than this becomes a lob (space-mapping.md §6)
});
// MediaPipe wrist, thumb CMC, index/middle/ring/pinky MCP — the engine's PALM_JOINTS (game-physics.js:419)
export const PALM_JOINTS = [0, 1, 5, 9, 13, 17];

const len = v => Math.hypot(v.x, v.y, v.z);
const norm = v => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

export class ThrowDetector {
  /**
   * @param {object} o
   * @param {(v:{x:number,y:number,z:number})=>{x:number,y:number}} o.worldVelToCourt  tile-world velocity → court units/s (x right, y up); z is kept separately as `vd`
   * @param {number} o.hist  history length (6 = the stack's window)
   */
  constructor({ worldVelToCourt, hist = 6 }) {
    this.toCourt = worldVelToCourt;
    this.hist = hist;
    this.samples = [];          // [{v:{x,y,z}, t}]
  }
  reset() { this.samples.length = 0; }

  /** Feed one frame while the ball is held/cradled: the ball's palm-follow velocity (world units/s). */
  push(followVel, tMs) {
    this.samples.push({ v: { x: followVel.x, y: followVel.y, z: followVel.z }, t: tMs });
    if (this.samples.length > this.hist) this.samples.shift();
  }

  /**
   * Called on the frame the grab gate fails (wrap/clip opened, cradle tilted off, hand lost).
   * @param {{present:boolean, vel:Array<{x,y,z}>, angVel:{x,y,z}}|null} hand  the releasing hand (null if it vanished)
   * @param {'wrap'|'clip'|'cradle'|'lost'} how
   * @returns {{kind:'drop'|'throw', clamped:boolean, vx:number, vy:number, vd:number, wx:number, wy:number, wz:number, coherent:boolean}}
   */
  release(hand, how) {
    // 1. launch velocity = mean of the last N follow velocities (identical to the stack)
    const mean = { x: 0, y: 0, z: 0 };
    for (const s of this.samples) { mean.x += s.v.x; mean.y += s.v.y; mean.z += s.v.z; }
    if (this.samples.length) { mean.x /= this.samples.length; mean.y /= this.samples.length; mean.z /= this.samples.length; }

    // 2. coherence gate — tracking jitter yields incoherent directions; a throw does not
    let coherent = this.samples.length >= 3;
    if (coherent) {
      const last = this.samples.slice(-3).map(s => norm(s.v));
      for (let i = 0; i < 3 && coherent; i++) for (let j = i + 1; j < 3; j++) if (dot(last[i], last[j]) < THROW.DIR_COHERENCE) { coherent = false; break; }
    }
    if (coherent && hand && hand.present && hand.vel) {
      let acc = 0, n = 0;
      for (let i = 0; i < PALM_JOINTS.length; i++) for (let j = i + 1; j < PALM_JOINTS.length; j++) {
        acc += dot(norm(hand.vel[PALM_JOINTS[i]]), norm(hand.vel[PALM_JOINTS[j]])); n++;
      }
      if (n && acc / n < THROW.PALM_COHERENCE) coherent = false;
    }
    if (how === 'lost') coherent = false;     // a hand that vanished did not throw

    // 3. to court units + classify
    const c = this.toCourt(mean);
    let vx = c.x, vy = c.y, vd = mean.z;      // vd stays in tile-world units (a hint only, never routes)
    let speed = Math.hypot(vx, vy);
    let kind = 'throw', clamped = false;
    if (!coherent) { const k = speed > 0.3 ? 0.3 / speed : 1; vx *= k; vy *= k; speed *= k; kind = 'drop'; }
    else if (speed < THROW.V_DROP) kind = 'drop';
    if (vd < THROW.LOB_VD) { vy += 0.5 * Math.abs(vd); vd = 0; speed = Math.hypot(vx, vy); }   // lob rule
    let spinBoost = 0;
    if (speed > THROW.V_MAX_OUT) { const k = THROW.V_MAX_OUT / speed; spinBoost = (speed - THROW.V_MAX_OUT) * 4; vx *= k; vy *= k; clamped = true; }

    // 4. spin: hand angular velocity × 0.85 (wrap/clip); cradle tilt-off gives the same (palm angVel)
    let wx = 0, wy = 0, wz = 0;
    if (hand && hand.present && hand.angVel) { wx = hand.angVel.x * THROW.SPIN_SCALE; wy = hand.angVel.y * THROW.SPIN_SCALE; wz = hand.angVel.z * THROW.SPIN_SCALE + spinBoost; }

    this.reset();
    return { kind, clamped, vx, vy, vd, wx, wy, wz, coherent };
  }

  /**
   * Roll-out / push-across: a FREE ball that the support step or the floor
   * physics carried over an edge (no hold). The velocity is whatever the frozen
   * lane left it with (mpbrowser.html:1680-1694); we only cap it.
   */
  static rollLaunch(ballVelWorld, worldVelToCourt) {
    const c = worldVelToCourt(ballVelWorld);
    const speed = Math.hypot(c.x, c.y);
    const k = speed > THROW.V_MAX_OUT ? THROW.V_MAX_OUT / speed : 1;
    return { kind: 'roll', clamped: k < 1, vx: c.x * k, vy: c.y * k, vd: 0, wx: 0, wy: 0, wz: 0, coherent: true };
  }

  /** Entry shaping for the receiving tile: cap speed (the 100 ms blend is applied by the caller, latency-feel.md §5.5). */
  static shapeEntry(vx, vy, cap = THROW.V_MAX_IN) {
    const s = Math.hypot(vx, vy);
    if (s <= cap) return { vx, vy };
    const k = cap / s;
    return { vx: vx * k, vy: vy * k };
  }

  /** Time (ms) a ball at speed v (units/s) spends crossing a hand of width w (units): the catch window. */
  static catchWindowMs(v, w = 0.15) { return v > 1e-3 ? (w / v) * 1000 : Infinity; }

  /** Predict flight for the arrival cue: {x,y,t} samples until tMaxMs (same integrator as everyone). */
  static predictPath(x, y, vx, vy, tMaxMs = 1500, stepMs = 33, floorY, R) {
    const out = [], b = { x, y, vx, vy }, dt = stepMs / 1000;
    for (let t = 0; t <= tMaxMs; t += stepMs) { out.push({ x: b.x, y: b.y, t }); integrateCourt(b, dt, floorY, R); }
    return out;
  }
}
