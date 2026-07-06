/**
 * hopeOS SDK — Game Physics
 * ═══════════════════════════════════════════════════════════════
 * The hand as a PHYSICS BODY, and objects that respond to it.
 * Replaces the DEI-route interaction scripts (dei_full.html basketball
 * lane) with a proper, reusable engine layer:
 *
 *   HandBody — per-frame kinematic state of one tracked hand:
 *     • 21 joint colliders (per-joint radii, scaled to live hand size)
 *     • per-joint velocities + max punch speed (EMA-smoothed)
 *     • palm frame (position + PROPER quaternion) and its angular
 *       velocity — so held objects rotate 1:1 with the hand's twist
 *     • grip metrics: openness/curl + pinch, for grab intent
 *
 *   GrabbableSphere — a game object with the full interaction loop:
 *     • collision avoidance vs the hand: sphere-vs-joint resolution
 *       with velocity impulse + tangential spin transfer (bat, dribble,
 *       roll off the fingers — the object can never sink through the
 *       hand mesh; the mesh conform in hand-rig.js handles the last
 *       few millimetres of visual contact)
 *     • grab: enough joints inside the grab shell with a curled hand
 *       (or a pinch) → the object rigidly sticks to the PALM FRAME,
 *       keeping its grab-moment offset + orientation, so hand rotation
 *       spins the object at exactly the hand's angular speed
 *     • release → inherits linear velocity (throw) AND angular velocity
 *       (spin), then free flight: gravity, drag, floor bounce with
 *       roll/friction — pick it back up off the ground
 *
 * All spatial state is exposed as plain numbers (see snapshot()) so
 * game code / external tooling can read live avatar+hand coordinates.
 * No allocation per frame anywhere in the hot path.
 */

import * as THREE from 'three';

// Per-joint collider radii (metres at rest-hand scale ~0.2m span).
// Wrist fat, knuckles medium, fingertips slim.
export const JOINT_RADII = [
  0.034,                          // 0 wrist
  0.024, 0.020, 0.017, 0.015,     // thumb
  0.022, 0.017, 0.015, 0.013,     // index
  0.022, 0.017, 0.015, 0.013,     // middle
  0.021, 0.016, 0.014, 0.012,     // ring
  0.019, 0.015, 0.013, 0.011,     // pinky
];
const KNUCKLES = [5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const REST_SPAN = 0.34;   // wrist→middle-MCP of the rest skeleton (hand-forge units → FP ~0.2m after povHandScale)

const _v = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export class HandBody {
  constructor(slot) {
    this.slot = slot;                 // 'left' | 'right' (screen slot)
    this.present = false;
    this.joints = [];                 // 21 × Vector3 (world)
    this.vel = [];                    // 21 × Vector3 (m/s, EMA)
    for (let i = 0; i < 21; i++) { this.joints.push(new THREE.Vector3()); this.vel.push(new THREE.Vector3()); }
    this.radii = JOINT_RADII.slice();  // live radii (scaled by hand size)
    this.scale = 1;                    // live span / rest span
    this.palm = new THREE.Vector3();   // palm centre (world)
    this.palmQ = new THREE.Quaternion();
    this.palmVel = new THREE.Vector3();
    this.angVel = new THREE.Vector3(); // rad/s, world axis × magnitude
    this.speed = 0;                    // palm speed (m/s)
    this.punchSpeed = 0;               // max knuckle/palm speed — the punch metric
    this.openness = 1;                 // 1 = open flat, 0 = tight fist
    this.pinch = 0;                    // 0..1 (1 = closed pinch)
    this.pinchPoint = new THREE.Vector3();
    this._prevQ = new THREE.Quaternion();
    this._hasPrev = false;
  }

  drop() { this.present = false; this._hasPrev = false; }

  /**
   * Feed one frame. `points` = 21 world-space Vector3 (the same pack the
   * rig renders — physics matches pixels). `img` = normalized landmarks
   * for scale-free pinch measurement (optional).
   */
  update(points, dt, img) {
    if (!points) { this.drop(); return; }
    this.present = true;
    const idt = 1 / Math.max(dt, 1e-3);

    // joints + velocities
    for (let i = 0; i < 21; i++) {
      const p = points[i];
      if (this._hasPrev) {
        _v.set(p.x, p.y, p.z).sub(this.joints[i]).multiplyScalar(idt);
        this.vel[i].lerp(_v, 0.5);
      } else this.vel[i].set(0, 0, 0);
      this.joints[i].copy(p);
    }

    // live hand scale → collider radii
    const span = this.joints[0].distanceTo(this.joints[9]);
    this.scale = Math.max(0.2, Math.min(4, span / (REST_SPAN * 0.6)));   // 0.6 = povHandScale ref
    for (let i = 0; i < 21; i++) this.radii[i] = JOINT_RADII[i] * this.scale;

    // palm centre + frame (proper rotation, chirality-agnostic)
    this.palm.copy(this.joints[0]).add(this.joints[5]).add(this.joints[9])
      .add(this.joints[13]).add(this.joints[17]).multiplyScalar(0.2);
    _y.subVectors(this.joints[9], this.joints[0]).normalize();            // wrist → middle MCP
    _u.subVectors(this.joints[5], this.joints[17]);                       // across the knuckles
    _z.crossVectors(_y, _u).normalize();                                  // palm normal
    _x.crossVectors(_y, _z);                                              // right-handed, det > 0
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);

    if (this._hasPrev) {
      // palm linear velocity
      _v.copy(this.palm).sub(this._prevPalm || (this._prevPalm = this.palm.clone())).multiplyScalar(idt);
      this.palmVel.lerp(_v, 0.5);
      // angular velocity from the quaternion delta: dq = q · prevQ⁻¹
      _q2.copy(this._prevQ).invert().premultiply(_q);
      if (_q2.w < 0) { _q2.x *= -1; _q2.y *= -1; _q2.z *= -1; _q2.w *= -1; }
      const s = Math.sqrt(Math.max(0, 1 - _q2.w * _q2.w));
      const angle = 2 * Math.acos(Math.min(1, _q2.w));
      if (s > 1e-5) {
        _v.set(_q2.x / s, _q2.y / s, _q2.z / s).multiplyScalar(angle * idt);
        // clamp: tracking glitches can report absurd spins
        if (_v.length() > 30) _v.setLength(30);
        this.angVel.lerp(_v, 0.4);
      } else this.angVel.multiplyScalar(0.8);
    } else {
      this._prevPalm = this._prevPalm || this.palm.clone();
      this.palmVel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    }
    this._prevPalm.copy(this.palm);
    this._prevQ.copy(_q);
    this.palmQ.copy(_q);
    this._hasPrev = true;

    this.speed = this.palmVel.length();
    let mx = this.speed;
    for (const k of KNUCKLES) mx = Math.max(mx, this.vel[k].length());
    this.punchSpeed += (mx - this.punchSpeed) * 0.6;

    // grip metrics
    let tipD = 0;
    for (const t of TIPS) tipD += this.joints[t].distanceTo(this.palm);
    tipD /= TIPS.length * Math.max(span, 1e-4);
    this.openness = Math.max(0, Math.min(1, (tipD - 0.45) / 0.55));       // tips near palm → 0

    if (img) {
      const s = Math.hypot(img[9].x - img[0].x, img[9].y - img[0].y) + 1e-6;
      const d = Math.hypot(img[4].x - img[8].x, img[4].y - img[8].y) / s;
      this.pinch = Math.max(0, Math.min(1, 1 - (d - 0.18) / 0.5));
      this.pinchPoint.copy(this.joints[4]).add(this.joints[8]).multiplyScalar(0.5);
    } else this.pinch = 0;
  }

  /** Nearest joint distance to a point (world) minus that joint's radius. */
  nearestSurface(p) {
    let best = Infinity, idx = -1;
    for (let i = 0; i < this.joints.length; i++) {
      const d = this.joints[i].distanceTo(p) - this.radii[i];
      if (d < best) { best = d; idx = i; }
    }
    return { distance: best, joint: idx };
  }

  /** Count joints whose collider touches a sphere shell (for grab intent). */
  jointsWithin(center, dist) {
    let n = 0;
    for (let i = 0; i < this.joints.length; i++) if (this.joints[i].distanceTo(center) < dist + this.radii[i]) n++;
    return n;
  }

  /** Plain-number state for external/live-game consumption. */
  snapshot(out = {}) {
    out.present = this.present;
    out.palm = out.palm || {}; out.vel = out.vel || {}; out.quat = out.quat || {}; out.angVel = out.angVel || {};
    out.palm.x = this.palm.x; out.palm.y = this.palm.y; out.palm.z = this.palm.z;
    out.vel.x = this.palmVel.x; out.vel.y = this.palmVel.y; out.vel.z = this.palmVel.z;
    out.quat.x = this.palmQ.x; out.quat.y = this.palmQ.y; out.quat.z = this.palmQ.z; out.quat.w = this.palmQ.w;
    out.angVel.x = this.angVel.x; out.angVel.y = this.angVel.y; out.angVel.z = this.angVel.z;
    out.speed = this.speed; out.punchSpeed = this.punchSpeed;
    out.openness = this.openness; out.pinch = this.pinch;
    out.tips = out.tips || [];
    for (let t = 0; t < 5; t++) {
      const tip = this.joints[TIPS[t]];
      const o = out.tips[t] || (out.tips[t] = {});
      o.x = tip.x; o.y = tip.y; o.z = tip.z;
    }
    return out;
  }
}

// ── Grabbable object ────────────────────────────────────────────
const GRAB_JOINTS_NEED = 5;     // joints inside the grab shell to close a grab
const HOLD_JOINTS_NEED = 3;     // fewer → the hand has opened → release
const _rel = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3();
const _imp = new THREE.Vector3(), _axis = new THREE.Vector3();

export class GrabbableSphere {
  /**
   * @param {number} radius metres
   * @param {Object} opts { gravity, restitution, drag, home:Vector3 }
   */
  constructor(radius, opts = {}) {
    this.radius = radius;
    this.gravity = opts.gravity ?? -5.2;
    this.restitution = opts.restitution ?? 0.58;
    this.drag = opts.drag ?? 0.996;
    this.home = opts.home ? opts.home.clone() : new THREE.Vector3();
    this.pos = this.home.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.held = null;                 // { slot, posOff:Vector3(palm-local), quatOff:Quaternion }
    this._velHist = [];               // recent palm-follow velocities → throw
    this._resting = 0;
  }

  grabbed() { return !!this.held; }

  reset(home) {
    if (home) this.home.copy(home);
    this.pos.copy(this.home);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this.quat.identity(); this.held = null; this._velHist.length = 0;
  }

  /**
   * Step the object. hands = iterable of HandBody. floorY = ground plane.
   * Returns nothing; read .pos/.quat for rendering.
   */
  update(dt, hands, floorY) {
    const r = this.radius;

    if (this.held) {
      const hand = this._hand(hands, this.held.slot);
      const holding = hand && hand.present &&
        (hand.jointsWithin(this.pos, r + 0.16 * hand.scale) >= HOLD_JOINTS_NEED ||
         (this.held.byPinch && hand.pinch > 0.45));
      if (!holding) {
        // RELEASE → throw with averaged follow velocity + hand spin
        const v = _v.set(0, 0, 0);
        for (const h of this._velHist) v.add(h);
        if (this._velHist.length) v.divideScalar(this._velHist.length);
        this.vel.copy(v);
        if (hand) this.angVel.copy(hand.angVel).multiplyScalar(0.85);
        this.held = null; this._velHist.length = 0;
      } else {
        // STICK to the palm frame: position offset + orientation offset are
        // both palm-local, so the object translates AND rotates with the hand
        // — rotate your hand clockwise, the object rotates clockwise, at the
        // hand's own speed.
        _v.copy(this.held.posOff).applyQuaternion(hand.palmQ).add(hand.palm);
        _u.copy(this.pos);
        this.pos.lerp(_v, 0.6);
        _q.copy(hand.palmQ).multiply(this.held.quatOff);
        this.quat.slerp(_q, 0.5);
        // follow-velocity history for the throw
        _w.copy(this.pos).sub(_u).divideScalar(Math.max(dt, 1e-3));
        this._velHist.push(_w.clone());
        if (this._velHist.length > 6) this._velHist.shift();
        // never interpenetrate the OTHER hand while carried
        for (const other of hands) {
          if (other && other.present && other.slot !== this.held.slot) this._pushOut(other, null, dt);
        }
        return;
      }
    }

    // ── free flight ──
    // try to grab first (a resting or flying object can be caught)
    for (const hand of hands) {
      if (!hand || !hand.present) continue;
      const shell = r + 0.055 * hand.scale;
      const nIn = hand.jointsWithin(this.pos, shell);
      const byGrip = nIn >= GRAB_JOINTS_NEED && hand.openness < 0.72;
      const byPinch = hand.pinch > 0.7 && hand.pinchPoint.distanceTo(this.pos) < r + 0.12 * hand.scale;
      if (byGrip || byPinch) {
        this.held = {
          slot: hand.slot,
          byPinch: !byGrip,
          posOff: _v.copy(this.pos).sub(hand.palm).applyQuaternion(_q.copy(hand.palmQ).invert()).clone(),
          quatOff: _q.copy(hand.palmQ).invert().multiply(this.quat).clone(),
        };
        this._velHist.length = 0;
        return;
      }
    }

    // integrate
    this.vel.y += this.gravity * dt;
    this.vel.multiplyScalar(this.drag);
    this.pos.addScaledVector(this.vel, dt);
    // spin
    const w = this.angVel.length();
    if (w > 1e-4) {
      _q.setFromAxisAngle(_axis.copy(this.angVel).normalize(), w * dt);
      this.quat.premultiply(_q).normalize();
      this.angVel.multiplyScalar(0.995);
    }

    // hand collision — the avoidance layer: the object is pushed OUT of the
    // hand colliders and picks up the hand's velocity (bat / dribble / roll)
    for (const hand of hands) {
      if (hand && hand.present) this._pushOut(hand, this.vel, dt);
    }

    // floor
    if (this.pos.y < floorY + r) {
      this.pos.y = floorY + r;
      if (this.vel.y < 0) {
        this.vel.y = Math.abs(this.vel.y) > 0.35 ? -this.vel.y * this.restitution : 0;
        this.vel.x *= 0.92; this.vel.z *= 0.92;
        // rolling: ground contact converts slide into spin (ω = v/r about the side axis)
        _n.set(0, 1, 0);
        _t.copy(this.vel); _t.y = 0;
        _axis.crossVectors(_n, _t).divideScalar(Math.max(r, 1e-4));
        this.angVel.lerp(_axis, 0.5);
      }
    }
    this._resting = (this.pos.y <= floorY + r + 1e-3 && this.vel.lengthSq() < 0.01) ? this._resting + dt : 0;
  }

  /** Sphere-vs-joint-collider resolution (hand OR body). vel=null → position-only. */
  _pushOut(hand, vel, dt) {
    const r = this.radius;
    for (let i = 0; i < hand.joints.length; i++) {
      const jr = hand.radii[i];
      _rel.copy(this.pos).sub(hand.joints[i]);
      const d = _rel.length(), minD = r + jr;
      if (d >= minD || d < 1e-5) continue;
      _n.copy(_rel).divideScalar(d);                       // contact normal (joint → object)
      this.pos.addScaledVector(_n, minD - d);              // positional correction — never sink in
      if (!vel) continue;
      // impulse: object velocity relative to the (kinematic) hand joint
      _imp.copy(vel).sub(hand.vel[i]);
      const vn = _imp.dot(_n);
      if (vn < 0) {
        vel.addScaledVector(_n, -(1.4) * vn);              // bounce off the hand (e ≈ 0.4)
        // tangential: hand motion drags the surface → spin + slight carry
        _t.copy(hand.vel[i]).sub(_n.clone().multiplyScalar(hand.vel[i].dot(_n)));
        vel.addScaledVector(_t, 0.35);
        _axis.crossVectors(_n, _t).divideScalar(Math.max(r, 1e-4));
        this.angVel.addScaledVector(_axis, 0.5);
        if (this.angVel.length() > 40) this.angVel.setLength(40);
      }
    }
  }

  _hand(hands, slot) { for (const h of hands) if (h && h.slot === slot) return h; return null; }

  snapshot(out = {}) {
    out.pos = out.pos || {}; out.vel = out.vel || {}; out.quat = out.quat || {};
    out.pos.x = this.pos.x; out.pos.y = this.pos.y; out.pos.z = this.pos.z;
    out.vel.x = this.vel.x; out.vel.y = this.vel.y; out.vel.z = this.vel.z;
    out.quat.x = this.quat.x; out.quat.y = this.quat.y; out.quat.z = this.quat.z; out.quat.w = this.quat.w;
    out.held = this.held ? this.held.slot : null;
    out.spin = this.angVel.length();
    return out;
  }
}

// ── Grabbable box (OBB) — the Rubik's-cube body ─────────────────
// Same interaction loop shape as the sphere (avoidance → grab → stick to
// the palm frame → throw), but with oriented-box contact AND a PHYSICAL
// grip model (ported from the DEI basketball loop's tight proximity
// design, then made contact-exact):
//   • hand joints resolve against the box SURFACE (closest point on the
//     OBB), and every contact applies TORQUE — a fingertip on an edge
//     nudges it into a tumble, a flat palm slides it
//   • GRAB requires a REAL grip: a thumb-side contact and a finger-side
//     contact pressing on OPPOSING faces (or a full-fist wrap, or a true
//     pinch ON the surface). The back of the fingertips, the side of the
//     hand, a near-miss hover — none of those stick.
//   • an open palm never grabs — SUPPORT contacts (joints underneath)
//     are near-inelastic with strong friction, so the cube RESTS on the
//     hand like a tray: place it, carry it, tilt and it slides off,
//     throw it up and catch it, pass it hand to hand.
//   • the floor works corner-by-corner: corner impulse with rotational
//     effective mass → the box TUMBLES onto a face, then a settle pass
//     lays it flat on the table (a cube doesn't balance on a corner)
const _bl = new THREE.Vector3(), _bc = new THREE.Vector3(), _br = new THREE.Vector3();
const _bv = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bn = new THREE.Vector3();
const _corner = new THREE.Vector3(), _cn = new THREE.Vector3(), _tn = new THREE.Vector3();
const _pn = new THREE.Vector3();
const _sqN = []; for (let i = 0; i < 24; i++) _sqN.push(new THREE.Vector3());
const _c8 = []; for (let i = 0; i < 8; i++) _c8.push(new THREE.Vector3());
const _UP = new THREE.Vector3(0, 1, 0), _DOWN = new THREE.Vector3(0, -1, 0);
const _grip = { n: 0, thumb: false, finger: false, opposing: false };
// joint groups for the grip test (MediaPipe hand landmark ids)
const THUMB_JOINTS = [2, 3, 4];
const FINGER_JOINTS = [6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
const PALM_JOINTS = [0, 1, 5, 9, 13, 17];
const HOLD_GRACE_FRAMES = 4;   // webcam tracking flicker must not fling it

export class GrabbableBox extends GrabbableSphere {
  /**
   * @param {THREE.Vector3|number} half half-extents (one number → cube)
   * @param {Object} opts { gravity, restitution, drag, home:Vector3 }
   */
  constructor(half, opts = {}) {
    const h = half && half.isVector3 ? half.clone() : new THREE.Vector3(half, half, half);
    // restitution 0.05: a plastic cube is DEAD — it thuds and tumbles, it
    // never bounces off the desk or the hand (the ball keeps its 0.58)
    super(h.length(), { restitution: 0.05, ...opts });   // .radius = bounding sphere
    this.half = h;
    // unit-mass cuboid, scalar inertia (mean of the three axis inertias)
    this.invI = 4.5 / Math.max(h.x * h.x + h.y * h.y + h.z * h.z, 1e-8);
    this._lost = 0;            // frames since the grip was last confirmed
    // set true while a TWIST gesture owns the second hand — its joints are
    // intentionally pressed into the cube and must not shove it around
    this.suppressOtherHand = false;
    this._squeezed = false;    // contacts pressing from OPPOSING sides
    this._clampSlot = null;    // two-hand clamp → this slot holds the cube
    this._clampGrace = 0;      // frames the clamp survives tracking flicker
    this._sqCounts = { left: 0, right: 0, body: 0 };
  }

  /**
   * SQUEEZE detection — contacts pressing from OPPOSING sides. While
   * squeezed: (a) support contacts stop converting to vertical lift (that
   * conversion is exactly the watermelon-seed pump that ratchets the cube
   * UP and out of a closing grip); opposing pushes then CANCEL and the
   * cube stays pinned — the hard-surface resistance: hands closing past
   * the faces can't inject motion, the fingers just stop at the mesh via
   * the conform. (b) A TWO-HAND CLAMP counts as a grab — squeezing the
   * cube between both hands IS holding it.
   */
  _updateSqueeze(hands) {
    let n = 0;
    const counts = this._sqCounts;
    counts.left = counts.right = counts.body = 0;
    _bq.copy(this.quat).invert();
    for (const hand of hands) {
      if (!hand || !hand.present) continue;
      // scale-aware shell: cupping hands must LOCK from a natural hover,
      // not only at millimetre-perfect contact (webcam z-noise makes that
      // flicker) — opposition still keeps the clamp honest
      const shell = 0.004 + 0.012 * hand.scale;
      for (let i = 0; i < hand.joints.length && n < _sqN.length; i++) {
        if (this._contactGap(hand.joints[i], hand.radii[i]) < shell) {
          _sqN[n++].copy(_cn);
          counts[hand.slot] = (counts[hand.slot] || 0) + 1;
        }
      }
    }
    this._squeezed = false;
    for (let a = 0; a < n && !this._squeezed; a++) {
      for (let b = a + 1; b < n; b++) {
        if (_sqN[a].dot(_sqN[b]) < -0.35) { this._squeezed = true; break; }
      }
    }
    // sticky clamp: once both hands hold it, a few dropped frames of
    // tracking must not break the lock (crucial for the twist gesture)
    if (this._squeezed && counts.left >= 2 && counts.right >= 2) {
      this._clampSlot = counts.left >= counts.right ? 'left' : 'right';
      this._clampGrace = 10;
    } else if (this._clampGrace > 0) {
      this._clampGrace--;                        // keep the last clamp slot
    } else {
      this._clampSlot = null;
    }
  }

  /** Live resize (two-hand pinch scale). Mass stays 1; inertia follows. */
  setHalf(half) {
    if (half && half.isVector3) this.half.copy(half);
    else this.half.set(half, half, half);
    this.radius = this.half.length();
    this.invI = 4.5 / Math.max(this.half.x ** 2 + this.half.y ** 2 + this.half.z ** 2, 1e-8);
  }

  /** Signed distance from a world point to the box surface (< 0 inside). */
  surfaceDistance(p) {
    _bl.copy(p).sub(this.pos).applyQuaternion(_bq.copy(this.quat).invert());
    const dx = Math.abs(_bl.x) - this.half.x;
    const dy = Math.abs(_bl.y) - this.half.y;
    const dz = Math.abs(_bl.z) - this.half.z;
    const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
    return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  }

  /** Gap between a joint sphere and the box surface (< 0 = pressing).
   *  Leaves the box-space contact normal (surface → joint) in _cn.
   *  REQUIRES _bq to already hold quat⁻¹. */
  _contactGap(p, jr) {
    _bl.copy(p).sub(this.pos).applyQuaternion(_bq);
    _bc.set(
      Math.max(-this.half.x, Math.min(this.half.x, _bl.x)),
      Math.max(-this.half.y, Math.min(this.half.y, _bl.y)),
      Math.max(-this.half.z, Math.min(this.half.z, _bl.z))
    );
    _rel.copy(_bl).sub(_bc);
    const d = _rel.length();
    if (d > 1e-6) { _cn.copy(_rel).divideScalar(d); return d - jr; }
    // joint centre inside → nearest face
    const px = this.half.x - Math.abs(_bl.x);
    const py = this.half.y - Math.abs(_bl.y);
    const pz = this.half.z - Math.abs(_bl.z);
    if (px <= py && px <= pz) { _cn.set(_bl.x >= 0 ? 1 : -1, 0, 0); return -px - jr; }
    if (py <= pz)             { _cn.set(0, _bl.y >= 0 ? 1 : -1, 0); return -py - jr; }
    _cn.set(0, 0, _bl.z >= 0 ? 1 : -1); return -pz - jr;
  }

  /**
   * Contact-based grip analysis. A real grip WRAPS the cube: a finger
   * contact must press against an OPPOSING contact from the thumb OR the
   * palm (normals dot < -0.15, box space) — palm-under + fingers-over is
   * how a hand actually holds a cube. `slop` widens the contact shell —
   * grab tight, hold looser so a carried cube doesn't flicker out.
   */
  _gripState(hand, slop, out) {
    out.n = 0; out.thumb = false; out.finger = false; out.opposing = false;
    out.below = false;           // any contact BELOW the cube's midline?
    _bq.copy(this.quat).invert();
    const yGate = this.pos.y - 0.05 * Math.min(this.half.x, Math.min(this.half.y, this.half.z));
    const mark = () => {         // contact point world height (uses _bc of the last gap test)
      _bv.copy(_bc).applyQuaternion(this.quat).add(this.pos);
      if (_bv.y < yGate) out.below = true;
    };
    let tBest = Infinity, pBest = Infinity, hasPalm = false;
    for (const i of THUMB_JOINTS) {
      const g = this._contactGap(hand.joints[i], hand.radii[i]);
      if (g < slop) { out.n++; out.thumb = true; mark(); if (g < tBest) { tBest = g; _tn.copy(_cn); } }
    }
    for (const i of PALM_JOINTS) {
      const g = this._contactGap(hand.joints[i], hand.radii[i]);
      if (g < slop) { out.n++; mark(); if (g < pBest) { pBest = g; hasPalm = true; _pn.copy(_cn); } }
    }
    for (const i of FINGER_JOINTS) {
      const g = this._contactGap(hand.joints[i], hand.radii[i]);
      if (g < slop) {
        out.n++; out.finger = true; mark();
        if ((out.thumb && _tn.dot(_cn) < -0.15) ||
            (hasPalm && _pn.dot(_cn) < -0.15)) out.opposing = true;
      }
    }
    return out;
  }

  update(dt, hands, floorY) {
    this._updateSqueeze(hands);
    if (this.held) {
      const hand = this._hand(hands, this.held.slot);
      let gripped = false;
      if (hand && hand.present) {
        if (this.held.byPinch) gripped = hand.pinch > 0.45;
        else {
          const g = this._gripState(hand, 0.06 * hand.scale, _grip);
          gripped = (g.thumb && g.finger) || g.n >= 5;
        }
        gripped = gripped || this._clampSlot !== null;   // a live clamp keeps it held
      }
      this._lost = gripped ? 0 : this._lost + 1;
      // pinch release is intentional → instant; grip gets a few grace
      // frames so one bad tracking frame doesn't fling the cube
      const stillHeld = hand && hand.present &&
        (gripped || (!this.held.byPinch && this._lost <= HOLD_GRACE_FRAMES));
      if (!stillHeld) {
        // RELEASE → throw with averaged follow velocity + hand spin
        const v = _v.set(0, 0, 0);
        for (const h of this._velHist) v.add(h);
        if (this._velHist.length) v.divideScalar(this._velHist.length);
        this.vel.copy(v);
        if (hand) this.angVel.copy(hand.angVel).multiplyScalar(0.85);
        this.held = null; this._velHist.length = 0;
      } else {
        // SEAT the grab: decay the capture offset until the palm skin
        // MEETS the face (max half-extent + palm-skin radius) — the hand
        // must visually touch the cube, and the conform then wraps the
        // fingers onto it. No hover gap, ever. NOT while two hands CLAMP
        // it: then it's pinned between the palms and stays put.
        if (!this._clampSlot) {
          const L = this.held.posOff.length();
          const maxL = Math.max(this.half.x, Math.max(this.half.y, this.half.z))
                     + 0.025 * hand.scale;
          if (L > maxL) this.held.posOff.multiplyScalar(Math.max(maxL / L, 1 - dt * 5));
        }
        // STICK to the palm frame (position + orientation offsets are
        // palm-local → the cube rotates 1:1 with the wrist)
        _v.copy(this.held.posOff).applyQuaternion(hand.palmQ).add(hand.palm);
        _u.copy(this.pos);
        this.pos.lerp(_v, 0.6);
        _q.copy(hand.palmQ).multiply(this.held.quatOff);
        this.quat.slerp(_q, 0.5);
        _w.copy(this.pos).sub(_u).divideScalar(Math.max(dt, 1e-3));
        this._velHist.push(_w.clone());
        if (this._velHist.length > 6) this._velHist.shift();
        // HARD SURFACES: the HOLDING hand's colliders push the cube out
        // too (capped, squeeze-aware), and the grab offset ADAPTS to the
        // corrected pose — held means resting ON the palm and fingers,
        // never interpenetrating them. Skin and cube stay mutually solid.
        this._pushOut(hand, null, dt);
        _v.copy(this.pos).sub(hand.palm).applyQuaternion(_q.copy(hand.palmQ).invert());
        this.held.posOff.lerp(_v, 0.35);
        // the OTHER hand still collides while carried (two-hand hold) —
        // unless it's the twisting hand of an active layer-turn gesture
        if (!this.suppressOtherHand) {
          for (const other of hands) {
            if (other && other.present && other.slot !== this.held.slot) this._pushOut(other, null, dt);
          }
        }
        return;
      }
    }

    // ── free: GRAB — only a REAL grip takes it. An open palm doesn't
    // grab; the cube just rests on it via support contacts below. ──
    for (const hand of hands) {
      if (!hand || !hand.present) continue;
      let take = false, byPinch = false;
      if (hand.pinch > 0.75 && this.surfaceDistance(hand.pinchPoint) < 0.04 * hand.scale) {
        take = true; byPinch = true;               // pinched ON the surface
      } else if (hand.openness < 0.85) {
        const g = this._gripState(hand, 0.035 * hand.scale, _grip);
        // GRAVITY-AWARE LATCH: a grip only takes the cube if it reaches
        // BELOW the midline — a real carrying grip wraps under the widest
        // point, because that's what bears the weight. A hand draped over
        // the TOP whose fingers straddle the upper edges must NOT latch:
        // the cube stays governed by gravity and falls away.
        take = (g.opposing || (g.n >= 6 && hand.openness < 0.55)) && g.below;
      }
      if (take) {
        this.held = {
          slot: hand.slot,
          byPinch,
          posOff: _v.copy(this.pos).sub(hand.palm).applyQuaternion(_q.copy(hand.palmQ).invert()).clone(),
          quatOff: _q.copy(hand.palmQ).invert().multiply(this.quat).clone(),
        };
        this._velHist.length = 0;
        this._lost = 0;
        return;
      }
    }
    // two-hand CLAMP = a grab: both hands pressing opposing faces
    if (this._clampSlot) {
      const hand = this._hand(hands, this._clampSlot);
      if (hand) {
        this.held = {
          slot: hand.slot,
          byPinch: false,
          posOff: _v.copy(this.pos).sub(hand.palm).applyQuaternion(_q.copy(hand.palmQ).invert()).clone(),
          quatOff: _q.copy(hand.palmQ).invert().multiply(this.quat).clone(),
        };
        this._velHist.length = 0;
        this._lost = 0;
        return;
      }
    }

    // integrate
    this.vel.y += this.gravity * dt;
    this.vel.multiplyScalar(this.drag);
    this.pos.addScaledVector(this.vel, dt);
    const w = this.angVel.length();
    if (w > 1e-4) {
      _q.setFromAxisAngle(_axis.copy(this.angVel).normalize(), w * dt);
      this.quat.premultiply(_q).normalize();
      this.angVel.multiplyScalar(0.99);
    }

    // hand collision — avoidance: pushed out of every joint collider
    for (const hand of hands) {
      if (hand && hand.present) this._pushOut(hand, this.vel, dt);
    }

    this._floor(floorY, dt);
  }

  /** Joint-sphere vs OBB resolution with torque. vel=null → position-only.
   *  `hand` is any joints/radii/vel body — HandBody or BodyBody.
   *
   *  Multi-contact needs GAUSS-SEIDEL passes: resting on a palm touches a
   *  MIXED contact set (clean vertical normals under the face, diagonal
   *  normals at the fat wrist near a corner). A single sequential pass
   *  lets whichever joint fires first shove the box sideways and block
   *  the vertical contacts — gravity then leaks into velocity while the
   *  position stays pinned, until a torque spike flings the cube off the
   *  hand. Three passes settle all contacts against each other. */
  _pushOut(hand, vel, dt) {
    // CONTACT SHELL: the velocity solve runs while a joint is within a few
    // mm of the surface, not only on penetration frames. Positional
    // correction resolves penetration to gap ≥ 0 — if the impulse only ran
    // when gap < 0, a RESTING cube would alternate no-contact frames where
    // gravity silently accumulates in vel, then fire one huge bounce with
    // the saved-up speed and fling itself off the palm.
    const SHELL = 0.006;
    for (let pass = 0; pass < 3; pass++) {
      _bq.copy(this.quat).invert();
      let touched = false;
      for (let i = 0; i < hand.joints.length; i++) {
        const jr = hand.radii[i];
        _bl.copy(hand.joints[i]).sub(this.pos).applyQuaternion(_bq);   // joint, box space
        _bc.set(                                                        // closest point on/in the box
          Math.max(-this.half.x, Math.min(this.half.x, _bl.x)),
          Math.max(-this.half.y, Math.min(this.half.y, _bl.y)),
          Math.max(-this.half.z, Math.min(this.half.z, _bl.z))
        );
        _rel.copy(_bl).sub(_bc);
        let d = _rel.length();
        if (d >= jr + SHELL) continue;
        touched = true;
        let support = false;
        if (d > 1e-6) {
          _rel.divideScalar(d);                        // normal: surface → joint (box space)
          _n.copy(_rel).applyQuaternion(this.quat);    // world normal: box → joint
          support = _n.y < -0.35;                      // joint UNDERNEATH the box
          if (d < jr) {                                // real penetration → resolve position
            // corrections are CAPPED per frame: converging fingers closing
            // on the cube must squeeze it, not rocket it out of the hand
            if (support && !this._squeezed) {
              // support corrections lift STRAIGHT UP: a diagonal edge-contact
              // push would walk the box sideways off the palm frame by frame.
              // NOT while squeezed — that lift is the watermelon-seed pump
              // that ejects the cube out of a closing two-hand grip.
              this.pos.y += Math.min((jr - d) / -_n.y, (jr - d) * 2.5, 0.012);
            } else {
              this.pos.addScaledVector(_n, -Math.min(jr - d, 0.01));
            }
          }
        } else {
          // joint centre INSIDE the box. Two very different cases:
          const px = this.half.x - Math.abs(_bl.x);
          const py = this.half.y - Math.abs(_bl.y);
          const pz = this.half.z - Math.abs(_bl.z);
          let pen;
          if (px <= py && px <= pz) { _rel.set(_bl.x >= 0 ? 1 : -1, 0, 0); pen = px; }
          else if (py <= pz)        { _rel.set(0, _bl.y >= 0 ? 1 : -1, 0); pen = py; }
          else                      { _rel.set(0, 0, _bl.z >= 0 ? 1 : -1); pen = pz; }
          _n.copy(_rel).applyQuaternion(this.quat);
          if (_n.y < -0.35 && pen <= jr + 0.02) {
            // SHALLOW SUPPORT — a curled fingertip poked through the BOTTOM
            // face (big cube resting on the palm). This is a real face
            // contact: resolve it WITH the velocity impulse below — a
            // position-only escape silently swallows gravity frame after
            // frame until the accumulated velocity flings the cube.
            d = -pen;
            _bc.copy(_bl).addScaledVector(_rel, pen);          // point on the face
            support = true;
            if (!this._squeezed) this.pos.y += Math.min((jr - d) / -_n.y, (jr - d) * 2.5, 0.012);
            else this.pos.addScaledVector(_n, -Math.min(jr - d, 0.01));
          } else {
            // DEEP (spawn overlap / tracking jump). Per-joint nearest-face
            // exits FIGHT each other when joints sit on both sides of the
            // centre — instead every deep joint pushes the box the SAME way,
            // away from the palm, in capped steps, and kills the approach
            // velocity so the escape actually converges.
            _n.copy(this.pos).sub(hand.palm);
            if (_n.lengthSq() < 1e-8) _n.copy(_rel).applyQuaternion(this.quat);
            else _n.normalize();
            this.pos.addScaledVector(_n, Math.min(jr + pen, 0.03));
            if (vel) {
              const vesc = _v.copy(vel).sub(hand.vel[i]).dot(_n);
              if (vesc < 0) vel.addScaledVector(_n, -vesc);
            }
            continue;
          }
        }
        if (!vel) continue;
        _br.copy(_bc).applyQuaternion(this.quat);      // lever arm (world, from centre)
        // box surface velocity at the contact, relative to the (kinematic) joint
        _imp.copy(this.angVel).cross(_br).add(vel).sub(hand.vel[i]);
        const vn = _imp.dot(_n);
        if (vn > 0) {                                  // surface moving INTO the joint
          // Momentum-consistent impulse with ROTATIONAL EFFECTIVE MASS —
          // the same solve the floor uses. (Scaling velocity and torque by
          // independent fudge factors let multi-contact sets PUMP energy
          // into spin across passes until the cube launched itself.)
          // SUPPORT contact (joint underneath): the hand is a tray — near-
          // inelastic + friction, so the cube RESTS on an open palm, rides
          // it, and slides off when tilted. Other contacts bounce (e≈0.4).
          _axis.crossVectors(_br, _n);
          const k = 1 + this.invI * _axis.lengthSq();
          // the cube NEVER bounces off a hand — contacts only STOP the
          // approach (e≈0, with a tiny threshold residue on hard hits);
          // repelled-while-grabbing was exactly this bounce
          const e = vn > 0.4 ? 0.08 : 0;
          const j = -(1 + e) * vn / k;
          vel.addScaledVector(_n, j);
          this.angVel.addScaledVector(_axis, this.invI * j);
          // FRICTION on EVERY contact: resist tangential slip relative to
          // the hand. This is what makes the palm a tray (it rests, rides
          // the hand), and a fast brush-past a physical flick — the torque
          // comes from the friction impulse itself, momentum-consistent.
          _t.copy(vel).sub(hand.vel[i]);
          _t.addScaledVector(_n, -_t.dot(_n));           // tangential slip
          _t.multiplyScalar(support ? -0.35 : -0.10);    // friction impulse
          vel.add(_t);
          this.angVel.addScaledVector(_axis.crossVectors(_br, _t), this.invI * 0.5);
          this.angVel.multiplyScalar(support ? 0.94 : 0.975);   // contact spin drag
          if (this.angVel.length() > 14) this.angVel.setLength(14);
        }
      }
      if (!touched) break;                             // no contacts → done
    }
  }

  _floor(floorY, dt) {
    const h = this.half;
    let minY = Infinity, ci = 0;
    for (let cx = -1; cx <= 1; cx += 2)
      for (let cy = -1; cy <= 1; cy += 2)
        for (let cz = -1; cz <= 1; cz += 2) {
          _c8[ci].set(cx * h.x, cy * h.y, cz * h.z).applyQuaternion(this.quat).add(this.pos);
          minY = Math.min(minY, _c8[ci].y); ci++;
        }
    if (minY < floorY) {
      this.pos.y += floorY - minY;
      // contact patch = MEAN of all touching corners: 1 → corner tumble,
      // 2 → edge pivot, 3-4 → face contact (lever ≈ 0, so a resting box
      // gets NO torque injection from gravity — it just sits)
      _corner.set(0, 0, 0);
      let nc = 0;
      for (let i = 0; i < 8; i++) {
        if (_c8[i].y < minY + 0.004) { _corner.add(_c8[i]); nc++; }
      }
      _corner.divideScalar(nc);
      _corner.y = floorY;
      _br.copy(_corner).sub(this.pos);                    // lever arm to the lowest corner
      _bv.copy(this.angVel).cross(_br).add(this.vel);     // corner velocity
      if (_bv.y < 0) {
        // corner impulse along +Y with rotational effective mass:
        // most of the energy goes into ROTATION → tumble, not bounce
        _axis.crossVectors(_br, _UP);
        const k = 1 + this.invI * _axis.lengthSq();
        const j = -(1 + this.restitution) * _bv.y / k;
        this.vel.y += j;
        this.angVel.addScaledVector(_axis, this.invI * j);
        // dead-contact clamp: a face landing under-cancels through one
        // corner — kill the residual so it can't pump up frame-to-frame
        if (this.vel.y < 0 && this.vel.y > -0.5) this.vel.y = 0;
        this.vel.x *= 0.86; this.vel.z *= 0.86;           // ground friction
        this.angVel.multiplyScalar(0.90);
      }
      // low energy in contact → settle FLAT on the nearest face
      if (this.vel.lengthSq() < 0.05 && this.angVel.lengthSq() < 4) {
        let best = -2, ax = 0, sg = 1;
        for (let a = 0; a < 3; a++) for (let s = -1; s <= 1; s += 2) {
          _bn.set(a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0).applyQuaternion(this.quat);
          if (-_bn.y > best) { best = -_bn.y; ax = a; sg = s; }
        }
        _bn.set(ax === 0 ? sg : 0, ax === 1 ? sg : 0, ax === 2 ? sg : 0).applyQuaternion(this.quat);
        _q.setFromUnitVectors(_bn, _DOWN);
        _q2.identity().slerp(_q, Math.min(1, dt * 6));
        this.quat.premultiply(_q2).normalize();
        this.angVel.multiplyScalar(Math.max(0, 1 - dt * 5));
        this.vel.x *= 0.9; this.vel.z *= 0.9;
      }
    }
    this._resting = (minY <= floorY + 2e-3 && this.vel.lengthSq() < 0.01) ? this._resting + dt : 0;
  }
}

// ── Body collider ───────────────────────────────────────────────
/**
 * The FULL BODY as a physics body — the HandBody interface (joints +
 * radii + velocities) over the 37-point pose skeleton, so every system
 * that collides with hands (GrabbableSphere push-out, game contact
 * checks) collides with the body for free. It never grabs (openness
 * pinned open, pinch 0) — it's a kinematic obstacle: balls bounce off
 * your chest, notes/walls can test against your torso.
 *
 *   const body = new BodyBody(BODY_RADII);   // radii from body-forge
 *   body.update(posedPoints37, dt);          // same points the rig renders
 */
export class BodyBody {
  // Virtual in-between colliders: the 37 landmarks leave gaps along the
  // trunk and long limb bones — a ball could sail through mid-thigh or
  // the belly. Each entry lerps two joints: [a, b, t, radius].
  static VIRTUALS = [
    [33, 34, 0.40, 0.15], [33, 34, 0.75, 0.14],   // belly, lower chest
    [11, 13, 0.5, 0.055], [12, 14, 0.5, 0.055],   // mid upper arms
    [13, 15, 0.5, 0.045], [14, 16, 0.5, 0.045],   // mid forearms
    [23, 25, 0.5, 0.078], [24, 26, 0.5, 0.078],   // mid thighs
    [25, 27, 0.5, 0.056], [26, 28, 0.5, 0.056],   // mid shins
  ];

  constructor(baseRadii) {
    this.slot = 'body';
    this.present = false;
    const nV = BodyBody.VIRTUALS.length;
    this.baseRadii = new Float32Array(baseRadii.length + nV);
    this.baseRadii.set(baseRadii);
    for (let k = 0; k < nV; k++) this.baseRadii[baseRadii.length + k] = BodyBody.VIRTUALS[k][3];
    this._nReal = baseRadii.length;
    this.joints = []; this.vel = []; this.radii = new Float32Array(this.baseRadii.length);
    for (let i = 0; i < this.baseRadii.length; i++) { this.joints.push(new THREE.Vector3()); this.vel.push(new THREE.Vector3()); }
    this.scale = 1;
    this.openness = 1;                    // interface: never closes a grab
    this.pinch = 0;
    this.pinchPoint = new THREE.Vector3();
    this.palm = new THREE.Vector3();      // interface alias → chest
    this.palmVel = new THREE.Vector3();
    this.palmQ = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.speed = 0; this.punchSpeed = 0;
    this._hasPrev = false;
  }

  drop() { this.present = false; this._hasPrev = false; }

  /** Feed the SAME posed points the body rig renders (33 or 37). */
  update(points, dt) {
    if (!points) { this.drop(); return; }
    this.present = true;
    const idt = 1 / Math.max(dt, 1e-3);
    const n = Math.min(points.length, this._nReal);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (this._hasPrev) {
        _v.set(p.x, p.y, p.z).sub(this.joints[i]).multiplyScalar(idt);
        this.vel[i].lerp(_v, 0.5);
      } else this.vel[i].set(0, 0, 0);
      this.joints[i].copy(p);
    }
    // virtual in-between colliders ride the real joints
    for (let k = 0; k < BodyBody.VIRTUALS.length; k++) {
      const [a, b, t] = BodyBody.VIRTUALS[k];
      const i = this._nReal + k;
      this.joints[i].lerpVectors(this.joints[a], this.joints[b], t);
      this.vel[i].lerpVectors(this.vel[a], this.vel[b], t);
    }
    // live scale from shoulder width (rest 0.40m)
    const sw = this.joints[11].distanceTo(this.joints[12]);
    this.scale = Math.max(0.2, Math.min(5, sw / 0.40));
    for (let i = 0; i < this.radii.length; i++) this.radii[i] = this.baseRadii[i] * this.scale;
    this.palm.copy(this.joints[34] || this.joints[11]);   // chest
    this.palmVel.copy(this.vel[34] || this.vel[11]);
    this.speed = this.palmVel.length();
    this._hasPrev = true;
  }

  jointsWithin(center, dist) {
    let c = 0;
    for (let i = 0; i < this.joints.length; i++) if (this.joints[i].distanceTo(center) < dist + this.radii[i]) c++;
    return c;
  }

  snapshot(out = {}) {
    out.present = this.present;
    for (const [k, i] of [['chest', 34], ['hips', 33], ['head', 35], ['wristL', 15], ['wristR', 16]]) {
      const o = out[k] || (out[k] = {});
      o.x = this.joints[i].x; o.y = this.joints[i].y; o.z = this.joints[i].z;
    }
    out.scale = this.scale;
    return out;
  }
}
