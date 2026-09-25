/**
 * sdk/game/hand-intent.js — what the hands MEAN for the ball, from the tracked landmarks.
 * ─────────────────────────────────────────────────────────────────────────────
 *   CLAW  two palms facing each other a ball's width apart, fingers curled toward each
 *         other (or one curled hand around the ball) → take it
 *   PUSH  the holding palm accelerates along its normal and opens → the ball LEAVES at the
 *         palm's PEAK velocity, the instant the palm decelerates / opens / slows — an open
 *         hand cannot pull a ball, so that instant is the physical release
 *   DROP  the holding palm is open and no longer faces the ball upward → it rolls off
 *   after a PUSH the approach zone is blocked (refractory), and while any hand recedes
 *   from the ball fast — a shooting hand is never the hand the ball comes back to
 *
 * Pure (three math only), Node-tested (tests/hand-intent-smoke.mjs). Chirality-free:
 * "facing" is |n·d| on both palms plus fingertips pointing at the other hand.
 * Every frame's features are logged (closure, speed, arm/claw counters) for tuning.
 *
 *   const I = new HandIntent();
 *   const r = I.update(hands, { pos, r, held, holdSlot }, dt, t);   // hands = [['left', pack], ['right', pack]]
 *   r.claw {slot, two, conf} · r.release {slot, vel, speed, dir, conf, why} · r.drop {slot} · r.blockAttract
 */
import * as THREE from 'three';

export const INTENT_DEFAULTS = {
  pushSpeed: 1.2,       // m/s the palm must reach to be a shot (a real shooting push is 1–2.5 m/s)
  pushDecel: -4,        // m/s² along the motion: the palm braking = the ball is gone
  clawSpan: [0.16, 0.40],
  clawClosure: [0.15, 0.85],
  clawFrames: 3,
  refractory: 0.7,      // s after a push with no approach
  awaySpeed: 0.8,       // a hand receding faster than this cannot call the ball
  dropFrames: 12,       // a FLAT hand (closure < 0.15) that does not face up, for ~0.2 s: the ball rolls off
};
const _pc = new THREE.Vector3(), _n = new THREE.Vector3(), _td = new THREE.Vector3(), _v = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Vector3();

export function palmCentre(p, out) { out.set(0, 0, 0); let n = 0; for (const i of [0, 5, 9, 17]) { const q = p[i]; if (!q) continue; out.x += q.x; out.y += q.y; out.z += q.z; n++; } return n ? out.multiplyScalar(1 / n) : out; }
export function palmNormal(p, out) { _a.set(p[9].x - p[0].x, p[9].y - p[0].y, p[9].z - p[0].z); _b.set(p[5].x - p[17].x, p[5].y - p[17].y, p[5].z - p[17].z); return out.crossVectors(_a, _b).normalize(); }
/** 0 open … 1 fist (mean fingertip→wrist over palm length) */
export function closure(p) { const palm = Math.hypot(p[9].x - p[0].x, p[9].y - p[0].y, p[9].z - p[0].z); if (palm < 1e-6) return 0; let d = 0; for (const i of [8, 12, 16, 20]) { const q = p[i] || p[0]; d += Math.hypot(q.x - p[0].x, q.y - p[0].y, q.z - p[0].z); } return Math.min(1, Math.max(0, (1.6 - (d / 4) / palm) / 0.6)); }
/** where the fingertips point, from the knuckle row */
export function tipsDir(p, out) { _a.set(0, 0, 0); _b.set(0, 0, 0); for (const i of [8, 12, 16, 20]) { const q = p[i] || p[0]; _a.x += q.x / 4; _a.y += q.y / 4; _a.z += q.z / 4; } for (const i of [5, 9, 13, 17]) { const q = p[i] || p[0]; _b.x += q.x / 4; _b.y += q.y / 4; _b.z += q.z / 4; } return out.subVectors(_a, _b).normalize(); }

const handState = () => ({ seen: false, stale: false, tLast: 0, pc: new THREE.Vector3(), pcPrev: new THREE.Vector3(), n: new THREE.Vector3(), tips: new THREE.Vector3(), v: new THREE.Vector3(), vInst: new THREE.Vector3(), a: new THREE.Vector3(),
  closure: 0, prevC: 0, dClosure: 0, speed: 0, pushArm: 0, peak: 0, peakV: new THREE.Vector3(), clawFrames: 0, dropFrames: 0 });

export class HandIntent {
  constructor(o = {}) {
    Object.assign(this, INTENT_DEFAULTS, o);
    this.state = 'idle'; this.conf = 0; this.t = 0; this.blockUntil = -1; this.blockAttract = false;
    this.release = null; this.claw = null; this.drop = null; this.lastRelease = null;
    this._h = { left: handState(), right: handState() }; this._two = 0;
    this.log = []; this.logMax = o.logMax ?? 300;
  }
  _feat(slot, pack, dt, forcedStale = false) {
    const H = this._h[slot];
    palmCentre(pack, _pc); palmNormal(pack, _n); tipsDir(pack, _td); const c = closure(pack);
    // a 30 Hz tracker on a 60 Hz loop repeats the last pack: that is a STALE frame, not a hand that stopped —
    // velocity is measured between fresh samples, and the state machine does not decide on stale ones
    if (H.seen && (forcedStale || (_pc.distanceToSquared(H.pc) < 1e-8 && Math.abs(c - H.prevC) < 1e-6))) { H.stale = true; H.v.multiplyScalar(0.9); H.a.set(0, 0, 0); H.speed = H.v.length(); return H; }   // the last velocity, bleeding off
    H.stale = false;
    const ds = H.seen ? Math.max(this.t - H.tLast, 1e-3) : Math.max(dt, 1e-3);
    if (H.seen) {
      _v.copy(_pc).sub(H.pc).divideScalar(ds);
      if (_v.lengthSq() > 64) _v.setLength(8);
      H.a.copy(_v).sub(H.v).divideScalar(ds);
      H.vInst.copy(_v);                                              // the palm's velocity between the last two fresh samples: no lag — the release reads THIS
      H.v.lerp(_v, 0.8);                                             // fast: the release must read the palm's peak, not a lagging mean
      H.closure = H.closure * 0.5 + c * 0.5; H.dClosure = c - H.prevC;
    } else { H.v.set(0, 0, 0); H.vInst.set(0, 0, 0); H.a.set(0, 0, 0); H.closure = c; H.dClosure = 0; }
    H.pcPrev.copy(H.seen ? H.pc : _pc); H.pc.copy(_pc); H.n.copy(_n); H.tips.copy(_td); H.prevC = c; H.speed = H.v.length(); H.seen = true; H.tLast = this.t;
    return H;
  }
  /** @param hands [[slot, pack]] · ball { pos, r, held, holdSlot } | null · dt s · t s (the caller's clock) */
  /** staleMap: { slot: true } from the caller when it knows a pack is a re-seen sample (PropBall passes its kinematics verdict) */
  update(hands, ball, dt, t, staleMap = null) {
    this.t = t != null ? t : this.t + dt;
    this.release = null; this.claw = null; this.drop = null;
    const F = {}, seen = new Set();
    for (const [slot, pack] of hands || []) { if (!pack || !pack[0] || !pack[9] || !pack[5] || !pack[17]) continue; seen.add(slot); F[slot] = this._feat(slot, pack, dt, !!(staleMap && staleMap[slot])); }
    for (const slot of ['left', 'right']) if (!seen.has(slot)) { const H = this._h[slot]; H.seen = false; H.clawFrames = 0; H.pushArm = 0; H.peak = 0; H.dropFrames = 0; }
    // ── CLAW, two hands: facing, a ball apart, fingers curled toward each other, still
    let claw = null;
    if (F.left && F.right) {
      const L = F.left, Rr = F.right;
      _d.copy(Rr.pc).sub(L.pc); const d = _d.length(); if (d > 1e-6) _d.divideScalar(d);
      const facing = Math.abs(L.n.dot(_d)) > 0.5 && Math.abs(Rr.n.dot(_d)) > 0.5;
      const tipsIn = L.tips.dot(_d) > 0.15 && Rr.tips.dot(_d) < -0.15;
      const curled = L.closure >= this.clawClosure[0] && L.closure <= this.clawClosure[1] && Rr.closure >= this.clawClosure[0] && Rr.closure <= this.clawClosure[1];
      const still = L.speed < 0.9 && Rr.speed < 0.9;
      const span = d >= this.clawSpan[0] && d <= this.clawSpan[1];
      this._two = (facing && tipsIn && curled && still && span) ? Math.min(12, this._two + 1) : 0;   // a still hand repeats its pack: stillness counts
      if (this._two >= this.clawFrames && ball) {
        _m.copy(L.pc).add(Rr.pc).multiplyScalar(0.5);
        if (_m.distanceTo(ball.pos) < ball.r * 1.2 + 0.05) {
          const slot = L.pc.distanceTo(ball.pos) <= Rr.pc.distanceTo(ball.pos) ? 'left' : 'right';
          claw = { slot, two: true, conf: Math.min(1, this._two / 6), span: +d.toFixed(3) };
        }
      }
    } else this._two = 0;
    // ── CLAW, one hand curled around the ball
    if (!claw && ball) for (const slot of Object.keys(F)) {
      const H = F[slot];
      const near = H.pc.distanceTo(ball.pos) < ball.r + 0.09, curled = H.closure >= 0.3 && H.closure <= 0.85;
      H.clawFrames = (near && curled && H.speed < 0.9) ? Math.min(12, H.clawFrames + 1) : 0;
      if (H.clawFrames >= this.clawFrames) claw = { slot, two: false, conf: Math.min(1, H.clawFrames / 6) };
    }
    this.claw = claw;
    // ── PUSH (the holding hand) and DROP
    let release = null, drop = null;
    for (const slot of Object.keys(F)) {
      const H = F[slot];
      const holdingThis = !!(ball && ball.held && ball.holdSlot === slot);
      if (!holdingThis) { H.pushArm = 0; H.peak = 0; H.dropFrames = 0; continue; }
      // palm → ball, the palm's pushing side. The ball is carried AFTER this runs, so on a fresh frame it still sits on the
      // PREVIOUS palm position: measure from there, or a push reads as moving away from the ball
      _b.copy(ball.pos).sub(H.stale ? H.pc : H.pcPrev); const tb = _b.length(); if (tb > 1e-6) _b.divideScalar(tb);
      // DROP: open, slow, and the ball's side of the palm no longer points up → it rolls off (time counts, stale or not)
      H.dropFrames = (H.closure < 0.15 && H.speed < 0.6 && _b.y < 0.2) ? Math.min(30, H.dropFrames + 1) : 0;
      if (H.dropFrames >= this.dropFrames) drop = { slot };
      if (H.stale) continue;                                                       // the PUSH decides on fresh samples only
      const along = H.speed > 1e-6 ? H.v.dot(_b) / H.speed : 0;
      const opening = H.closure < 0.45 || H.dClosure < -0.02;
      if (H.speed > this.pushSpeed && along > 0.3 && opening) {
        H.pushArm = Math.min(10, H.pushArm + 1);
        const inst = H.vInst.length(); if (inst > H.peak && inst < 8) { H.peak = inst; H.peakV.copy(H.vInst); }   // the peak of the instantaneous palm velocity
      } else if (H.pushArm > 0 && H.speed < this.pushSpeed * 0.5) { H.pushArm = 0; H.peak = 0; }
      if (H.pushArm >= 2) {
        const decel = H.a.dot(H.v) / Math.max(H.speed, 1e-6);
        const opened = H.closure < 0.25, slowed = H.speed < H.peak * 0.75;
        if (decel < this.pushDecel || opened || slowed) {
          release = { slot, vel: H.peakV.clone(), speed: +H.peak.toFixed(3), dir: H.peakV.clone().normalize(), conf: Math.min(1, H.pushArm / 4), why: decel < this.pushDecel ? 'decel' : opened ? 'open' : 'slowed' };
          H.pushArm = 0; H.peak = 0; drop = null; H.dropFrames = 0;
        }
      }
    }
    if (release) { this.release = release; this.lastRelease = { ...release, t: this.t }; this.blockUntil = this.t + this.refractory; }
    this.drop = drop;
    // ── ATTRACT BLOCK: after a push, or while a hand recedes from the ball fast
    let away = false;
    if (ball) for (const slot of Object.keys(F)) { const H = F[slot]; if (H.speed < this.awaySpeed) continue; _b.copy(H.pc).sub(ball.pos); if (_b.lengthSq() > 1e-6 && H.v.dot(_b.normalize()) / H.speed > 0.5) away = true; }
    this.blockAttract = this.t < this.blockUntil || away;
    const Hs = Object.values(F);
    this.state = release ? 'push' : claw ? 'claw' : drop ? 'drop' : Hs.some(H => H.pushArm > 0) ? 'push-arm' : Hs.some(H => H.closure < 0.25 && H.speed < 0.5) ? 'open' : 'idle';
    this.conf = claw ? claw.conf : release ? release.conf : 0;
    const row = { t: +this.t.toFixed(3), state: this.state, block: this.blockAttract };
    for (const slot of Object.keys(F)) { const H = F[slot]; row[slot] = { c: +H.closure.toFixed(2), s: +H.speed.toFixed(2), arm: H.pushArm, claw: H.clawFrames, drop: H.dropFrames }; }
    this.log.push(row); if (this.log.length > this.logMax) this.log.shift();
    return { state: this.state, claw, release, drop, blockAttract: this.blockAttract };
  }
}
