/**
 * sdk/core/ball-physics.js — REAL BALL PHYSICS: free flight, bounce, surfaces, and a flight recorder.
 * ─────────────────────────────────────────────────────────────────────────────
 * One simulator for any ball. Per frame it substeps so no step moves the ball more
 * than `maxStep` (3 cm: the rim's contact shell is 13 cm, a 60 fps frame at 8 m/s
 * is 13 cm — a single step could jump the iron), integrates gravity + QUADRATIC air
 * drag (k = ½ ρ C_d A / m — real drag is ~8 % of g at 6 m/s and nothing at 1 m/s;
 * a per-frame multiplier is neither, and depends on the frame rate), then resolves
 * every registered SURFACE: closest point → normal → depth → positional correction
 * → an impulse on the RELATIVE velocity with that surface's restitution e and
 * friction μ (a moving hand is a kinematic surface: the ball leaves at ~(1+e)× the
 * hand's speed along the contact normal). The bounce law falls out: a drop from h
 * hits at √(2gh) and rebounds to e²·h; only the normal part is scaled, so bounces
 * flatten and skid like a real ball.
 *
 *   Surface.plane / rect / ring / capsule / spheres   the floor, a backboard, the rim, a pole, hands + bodies
 *   MATERIALS                                          per-surface { e, mu } (the "weight map": material + normal)
 *   BallSim                                            step(dt, surfaces) → contacts, impacts, sleep
 *   FlightRecorder                                     release / apex / impact / rest events, live stats,
 *                                                      and the self-check: measured rebound vs e²·h
 *   solveLaunch(from, to, {g, k, T})                   initial velocity that lands at `to` under THIS integrator
 *
 * Node-safe (three math only). Tests: tests/ball-physics-smoke.mjs.
 */
import * as THREE from 'three';

export const MATERIALS = {
  floor: { e: 0.87, mu: 0.35 },   // regulation: from 1.8 m a basketball rebounds to 1.2–1.4 m WITH air (drag costs ~5 %) → e 0.87
  board: { e: 0.72, mu: 0.25 },
  rim:   { e: 0.62, mu: 0.20 },
  pole:  { e: 0.50, mu: 0.30 },
  wall:  { e: 0.75, mu: 0.40 },   // a gym wall / ceiling (plaster, brick): duller than the wood
  hand:  { e: 0.45, mu: 0.60 },
  body:  { e: 0.40, mu: 0.50 },
};

/** ½ ρ C_d A / m, per metre: a = −k·|v|·v. Basketball: m 0.62 kg, r 0.12 m, C_d 0.5 → 0.0219 */
export function dragK({ mass = 0.62, radius = 0.12, cd = 0.5, rho = 1.2 } = {}) {
  return 0.5 * rho * cd * Math.PI * radius * radius / mass;
}

const V = (p) => (p && p.isVector3) ? p : new THREE.Vector3(p.x, p.y, p.z);
const _q = new THREE.Quaternion(), _ax = new THREE.Vector3(), _vr = new THREE.Vector3(), _vt = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export const Surface = {
  /** infinite plane through `point` with outward `normal` */
  plane(id, point, normal, mat = MATERIALS.floor) { return { type: 'plane', id, p: V(point).clone(), n: V(normal).clone().normalize(), mat, active: true }; },
  /** finite rectangle (a backboard): centre, normal, in-plane axis `u`, half sizes, thickness (a slab) */
  rect(id, center, normal, u, halfU, halfV, mat = MATERIALS.board, thickness = 0.04) {
    const n = V(normal).clone().normalize(), uu = V(u).clone().addScaledVector(n, -V(u).dot(n)).normalize();
    return { type: 'rect', id, c: V(center).clone(), n, u: uu, v: new THREE.Vector3().crossVectors(n, uu), hu: halfU, hv: halfV, th: thickness, mat, active: true };
  },
  /** a ring (the rim): centre, axis (normal of the ring's plane), ring radius, wire radius */
  ring(id, center, axis, radius, tube = 0.012, mat = MATERIALS.rim) { return { type: 'ring', id, c: V(center).clone(), axis: V(axis).clone().normalize(), R: radius, tube, mat, active: true }; },
  /** a capsule (pole, arm): segment a→b with radius */
  capsule(id, a, b, radius, mat = MATERIALS.pole) { return { type: 'capsule', id, a: V(a).clone(), b: V(b).clone(), r: radius, mat, active: true }; },
  /** kinematic sphere set (a hand's 21 joints, a body's joints): points {x,y,z}[], radii[], vel Vector3[] | null */
  spheres(id, points, radii, vel = null, mat = MATERIALS.hand) { return { type: 'spheres', id, pts: points, radii, vel, mat, active: true }; },
};

/** every contact of the ball (centre `pos`, radius `R`) with surface `s` → pushed onto `out` (records are pooled per call) */
export function collect(s, pos, R, out) {
  const push = (n, depth, point, vs) => { out.push({ n, depth, point, vs, mat: s.mat, id: s.id }); };
  if (s.type === 'plane') {
    const d = _a.copy(pos).sub(s.p).dot(s.n);
    if (d < R) push(s.n.clone(), R - d, _b.copy(pos).addScaledVector(s.n, -d).clone(), _c.set(0, 0, 0).clone());
  } else if (s.type === 'rect') {
    _a.copy(pos).sub(s.c);
    const du = Math.max(-s.hu, Math.min(s.hu, _a.dot(s.u))), dv = Math.max(-s.hv, Math.min(s.hv, _a.dot(s.v)));
    const dn = _a.dot(s.n), side = dn >= 0 ? 1 : -1, face = Math.max(0, Math.abs(dn) - s.th * 0.5);   // distance beyond the slab face
    _b.copy(s.c).addScaledVector(s.u, du).addScaledVector(s.v, dv).addScaledVector(s.n, side * Math.min(Math.abs(dn), s.th * 0.5));   // closest point on the slab
    _c.copy(pos).sub(_b); const dist = _c.length();
    if (dist < R) { const n = dist > 1e-6 ? _c.divideScalar(dist).clone() : s.n.clone().multiplyScalar(side); push(n, R - dist, _b.clone(), _d.set(0, 0, 0).clone()); }
    void face;
  } else if (s.type === 'ring') {
    _a.copy(pos).sub(s.c);
    const h = _a.dot(s.axis); _b.copy(_a).addScaledVector(s.axis, -h);   // radial part
    const rl = _b.length();
    if (rl < 1e-6) _b.set(1, 0, 0).addScaledVector(s.axis, -s.axis.x).normalize(); else _b.divideScalar(rl);
    _c.copy(s.c).addScaledVector(_b, s.R);                               // nearest point on the wire's centre line
    _d.copy(pos).sub(_c); const dist = _d.length();
    if (dist < R + s.tube) { const n = dist > 1e-6 ? _d.divideScalar(dist).clone() : s.axis.clone(); push(n, R + s.tube - dist, _c.clone().addScaledVector(n, s.tube), new THREE.Vector3()); }
  } else if (s.type === 'capsule') {
    _a.copy(s.b).sub(s.a); const L2 = _a.lengthSq();
    const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, _b.copy(pos).sub(s.a).dot(_a) / L2));
    _c.copy(s.a).addScaledVector(_a, t); _d.copy(pos).sub(_c); const dist = _d.length();
    if (dist < R + s.r) { const n = dist > 1e-6 ? _d.divideScalar(dist).clone() : new THREE.Vector3(0, 1, 0); push(n, R + s.r - dist, _c.clone().addScaledVector(n, s.r), new THREE.Vector3()); }
  } else if (s.type === 'spheres') {
    const al = (s.sweep && s.prevPts && s.alpha != null) ? s.alpha : 1;   // a swept hand: where the joints are at this substep
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i]; if (!p) continue;
      let px = p.x, py = p.y, pz = p.z;
      if (al < 1) { const q = s.prevPts[i]; if (q) { px = q.x + (p.x - q.x) * al; py = q.y + (p.y - q.y) * al; pz = q.z + (p.z - q.z) * al; } }
      const jr = s.radii ? s.radii[i] : 0;
      _a.set(pos.x - px, pos.y - py, pos.z - pz); const dist = _a.length();
      if (dist >= R + jr) continue;
      const n = dist > 1e-6 ? _a.divideScalar(dist).clone() : new THREE.Vector3(0, 1, 0);
      push(n, R + jr - dist, new THREE.Vector3(px, py, pz).addScaledVector(n, jr), s.vel && s.vel[i] ? V(s.vel[i]).clone() : new THREE.Vector3());
    }
  }
  return out;
}

export class BallSim {
  /**
   * @param o { pos, vel, angVel, quat (shared Vector3/Quaternion or omitted), radius, mass, gravity, dragK,
   *            maxStep (m per substep), maxSub, settle (m/s: a rebound slower than this on a static support stops),
   *            onImpact(c) }
   */
  constructor(o = {}) {
    this.pos = o.pos || new THREE.Vector3(); this.vel = o.vel || new THREE.Vector3();
    this.angVel = o.angVel || new THREE.Vector3(); this.quat = o.quat || new THREE.Quaternion();
    this.r = o.radius ?? 0.12; this.mass = o.mass ?? 0.62;
    this.g = o.gravity ?? -9.81;
    this.k = o.dragK ?? dragK({ mass: this.mass, radius: this.r });
    this.maxStep = o.maxStep ?? 0.03; this.maxSub = o.maxSub ?? 8;
    this.settle = o.settle ?? 0.3;
    this.lowE = o.lowE ?? 0.4;   // restitution falls at low impact speed (viscoelastic contact): e(v) = e·(1 − lowE·exp(−v/0.7))
    this.onImpact = o.onImpact || null;
    this.asleep = false; this._restT = 0; this.time = 0; this.contacts = 0; this.support = false;
    this._cbuf = [];
  }
  wake() { this.asleep = false; this._restT = 0; this.support = false; }   // a woken ball is not supported until a step says so
  /** one frame: substeps, drag, every surface. Returns the number of contacts. */
  step(dt, surfaces = []) {
    this.contacts = 0;
    let sweep = 0;                                              // the fastest swept surface (a hand between two tracker samples) sets substeps too
    for (const s of surfaces) { if (s && s.type === 'spheres' && s.sweep && s.stepLen > sweep) sweep = s.stepLen; }
    const speed = this.vel.length();
    const n = Math.min(this.maxSub, Math.max(1, Math.ceil(Math.max(speed * dt, sweep) / this.maxStep)));
    if (this.asleep) {                                          // a resting ball still answers a surface that moves into it — or being moved (reset, launched)
      let hit = 0;
      for (let i = 0; i < n; i++) { for (const s of surfaces) if (s && s.type === 'spheres') s.alpha = (i + 1) / n; hit += this._resolve(surfaces, dt / n, true); if (!this.asleep) break; }
      for (const s of surfaces) if (s && s.type === 'spheres') s.alpha = 1;
      if (!this._touching(surfaces) || this.vel.lengthSq() > 0.05 * 0.05) this.wake(); else { this.time += dt; return hit; }
      if (!this.asleep && this.vel.lengthSq() > 0.05 * 0.05) { this.time += dt; return hit; }   // it was hit: it flies from the next frame
    }
    const h = dt / n; let support = false;
    for (let i = 0; i < n; i++) {
      for (const s of surfaces) if (s && s.type === 'spheres') s.alpha = (i + 1) / n;
      this.pos.addScaledVector(this.vel, h); this.pos.y += 0.5 * this.g * h * h;   // exact under constant g (no O(h) drift between frame rates)
      this.vel.y += this.g * h;
      const s = this.vel.length();
      if (s > 1e-6) this.vel.multiplyScalar(Math.max(0, 1 - this.k * s * h));   // quadratic drag
      support = this._resolve(surfaces, h, false) || support;
      const w = this.angVel.length();
      if (w > 1e-4) { _q.setFromAxisAngle(_ax.copy(this.angVel).normalize(), w * h); this.quat.premultiply(_q).normalize(); this.angVel.multiplyScalar(Math.max(0, 1 - 0.35 * h)); }
    }
    for (const s of surfaces) if (s && s.type === 'spheres') s.alpha = 1;
    this.support = support;
    this.time += dt;
    if (support && this.vel.lengthSq() < 0.15 * 0.15) { this._restT += dt; if (this._restT > 0.3) { this.asleep = true; this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0); } }
    else this._restT = 0;
    return this.contacts;
  }
  /** any surface within 3 mm of the skin (a resting ball sits exactly at its radius) */
  _touching(surfaces) {
    for (const s of surfaces) { if (!s || s.active === false) continue; this._cbuf.length = 0; collect(s, this.pos, this.r + 0.003, this._cbuf); if (this._cbuf.length) return true; }
    return false;
  }
  _resolve(surfaces, h, sleeping) {
    let support = false;
    for (let pass = 0; pass < 2; pass++) for (const s of surfaces) {
      if (!s || s.active === false) continue;
      this._cbuf.length = 0;
      collect(s, this.pos, this.r, this._cbuf);
      for (const c of this._cbuf) {
        this.contacts++;
        this.pos.addScaledVector(c.n, c.depth);                    // positional: never inside
        if (c.n.y > 0.7) support = true;
        _vr.copy(this.vel).sub(c.vs);
        const vn = _vr.dot(c.n);
        if (vn >= 0) continue;                                     // separating already
        const mu = c.mat.mu, moving = c.vs.lengthSq() > 1e-4;
        const e = c.mat.e * (1 - this.lowE * Math.exp(vn / 0.7));   // vn < 0: full e at speed, softer for the last hops
        let vnOut = -e * vn;
        if (!moving && vnOut < this.settle && c.n.y > 0.7) vnOut = 0;   // the last hops settle on a static support
        _vt.copy(_vr).addScaledVector(c.n, -vn); const vt = _vt.length();
        const jn = vnOut - vn;                                     // normal impulse (per unit mass)
        const fric = Math.min(vt, mu * jn);                        // Coulomb: tangential impulse ≤ μ·jn
        if (vt > 1e-6) _vt.divideScalar(vt);
        this.vel.copy(c.vs).addScaledVector(c.n, vnOut).addScaledVector(_vt, vt - fric);
        _ax.crossVectors(c.n, _vt).multiplyScalar((vt - fric) / this.r);   // contact spin (rolling)
        this.angVel.lerp(_ax, 0.5);
        if (sleeping) this.wake();
        if (-vn > 0.25 && this.onImpact) this.onImpact({ id: c.id, t: this.time, n: c.n, point: c.point, y: this.pos.y, vin: -vn, vout: vnOut, vt, vs: Math.sqrt(c.vs.lengthSq()), e, eEff: vnOut / -vn });
      }
    }
    return support;
  }
  snapshot() { return { pos: this.pos.toArray(), vel: this.vel.toArray(), speed: this.vel.length(), asleep: this.asleep, t: this.time }; }
}

/** initial velocity that lands the ball at `to` after T s under gravity + quadratic drag (Newton on the landing error) */
export function solveLaunch(from, to, { g = -9.81, k = 0, T = 1.1, dt = 1 / 120 } = {}) {
  const v = { x: (to.x - from.x) / T, y: (to.y - from.y) / T - 0.5 * g * T, z: (to.z - from.z) / T };   // ballistic seed
  const fly = () => { const p = { x: from.x, y: from.y, z: from.z }, u = { x: v.x, y: v.y, z: v.z }; const n = Math.max(1, Math.round(T / dt)), h = T / n;
    for (let i = 0; i < n; i++) { p.x += u.x * h; p.y += u.y * h + 0.5 * g * h * h; p.z += u.z * h; u.y += g * h; const s = Math.hypot(u.x, u.y, u.z); const f = Math.max(0, 1 - k * s * h); u.x *= f; u.y *= f; u.z *= f; }   // the same integrator as BallSim.step
    return p; };
  for (let it = 0; it < 6; it++) {
    const p = fly(); const ex = to.x - p.x, ey = to.y - p.y, ez = to.z - p.z;
    if (Math.hypot(ex, ey, ez) < 0.001) break;
    v.x += ex / T; v.y += ey / T; v.z += ez / T;
  }
  return { vx: v.x, vy: v.y, vz: v.z };
}

/** the arc ahead: ballistic + drag, no surfaces, until the floor (for the dotted prediction line) */
export function predictArc(sim, { T = 2.5, dt = 1 / 40, floorY = 0 } = {}) {
  const pts = []; const p = sim.pos.clone(), u = sim.vel.clone(); const n = Math.round(T / dt);
  for (let i = 0; i < n; i++) {
    p.addScaledVector(u, dt); p.y += 0.5 * sim.g * dt * dt; u.y += sim.g * dt; const s = u.length(); if (s > 1e-6) u.multiplyScalar(Math.max(0, 1 - sim.k * s * dt));
    pts.push([p.x, p.y, p.z]);
    if (p.y < floorY + sim.r) break;
  }
  return pts;
}

/** the flight recorder: what happened to the ball, as numbers a HUD, a probe and a tuner can read */
export class FlightRecorder {
  constructor(o = {}) {
    this.gravity = o.gravity ?? -9.81; this.max = o.max ?? 300;
    this.events = []; this.live = { state: 'idle', y: 0, h: 0, speed: 0, elev: 0, azim: 0, apex: null, impact: null, check: null, release: null };
    this._prevVy = 0; this._release = null; this._pendingApex = null; this._rested = false;
  }
  push(ev) { this.events.push(ev); if (this.events.length > this.max) this.events.shift(); return ev; }
  clear() { this.events.length = 0; this._pendingApex = null; this._release = null; this.live.impact = null; this.live.apex = null; this.live.check = null; this.live.release = null; }
  /** the ball left a hand / a launcher */
  release(sim, info = {}) {
    const v = sim.vel, speed = v.length();
    const ev = this.push({ type: 'release', t: sim.time, pos: sim.pos.toArray(), vel: v.toArray(), speed,
      elev: Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI, azim: Math.atan2(v.x, -v.z) * 180 / Math.PI, spin: sim.angVel.length(), ...info });
    this._release = { t: sim.time, y: sim.pos.y }; this.live.release = ev; this._rested = false; this._prevVy = v.y;
    return ev;
  }
  /** BallSim.onImpact → here */
  impact(sim, c) {
    const predicted = c.vout > 0 ? c.vout * c.vout / (2 * -this.gravity) : 0;
    const ev = this.push({ type: 'impact', t: c.t, surface: c.id, point: c.point.toArray(), n: c.n.toArray(), y: c.y, vin: c.vin, vout: c.vout, vt: c.vt, surfaceSpeed: c.vs,
      e: c.e, eEff: +c.eEff.toFixed(3), predictedRebound: predicted, energyLost: 0.5 * sim.mass * (c.vin * c.vin - c.vout * c.vout) });
    if (c.n.y > 0.7 && predicted > 0.02) this._pendingApex = ev;
    this.live.impact = ev; this._rested = false;
    return ev;
  }
  /** every frame after sim.step */
  tick(sim) {
    const vy = sim.vel.y, L = this.live;
    if (!sim.asleep && this._prevVy > 0 && vy <= 0) {
      const ev = this.push({ type: 'apex', t: sim.time, y: sim.pos.y, hAboveRelease: this._release ? sim.pos.y - this._release.y : null });
      if (this._pendingApex) {
        ev.measuredRebound = sim.pos.y - this._pendingApex.y; ev.predictedRebound = this._pendingApex.predictedRebound;
        ev.check = ev.predictedRebound > 0.02 ? +(ev.measuredRebound / ev.predictedRebound).toFixed(3) : null;
        L.check = ev.check; this._pendingApex = null;
      }
      L.apex = ev;
    }
    this._prevVy = vy;
    if (sim.asleep && !this._rested) { this.push({ type: 'rest', t: sim.time, pos: sim.pos.toArray() }); this._rested = true; }
    L.state = sim.asleep ? 'rest' : 'flight'; L.y = sim.pos.y; L.h = this._release ? sim.pos.y - this._release.y : 0;
    L.speed = sim.vel.length(); L.elev = L.speed > 0.05 ? Math.atan2(vy, Math.hypot(sim.vel.x, sim.vel.z)) * 180 / Math.PI : 0;
    L.azim = L.speed > 0.05 ? Math.atan2(sim.vel.x, -sim.vel.z) * 180 / Math.PI : 0;
    return L;
  }
  /** events of one type */
  of(type) { return this.events.filter(e => e.type === type); }
}
