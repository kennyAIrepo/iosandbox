/**
 * hopeOS SDK — cloth-sim.js: a RIGID SCAN becomes CLOTH.
 * ═══════════════════════════════════════════════════════════════════════════
 * A scanned prop (rug.glb: 1.0 M triangles, one welded shell) cannot be made
 * flexible by adding vertices — it already has 2.4 mm edges, and no solver
 * touches half a million particles in a frame. Flexibility is TOPOLOGY, and it
 * has to be coarse:
 *
 *   LATTICE  a regular quad grid over the prop's own mid-surface (45 × 64,
 *            30 mm cells for the rug — the measured ceiling for 8 XPBD
 *            substeps inside a tracked frame, tools/cloth/bench_xpbd.mjs).
 *            Structural + shear + bend constraints; XPBD, small substeps, one
 *            Gauss-Seidel sweep each (Macklin et al.) — stiff along the weave,
 *            soft in bend, so it folds instead of stretching.
 *   SKIN     the prop's real surface (90 k triangles, its fringes and braid)
 *            EMBEDDED in the lattice: every vertex keeps the cell it sits in
 *            and its offset in that cell's frame, and rides the cell. The
 *            deformation runs in the VERTEX SHADER off a lattice texture, so
 *            71 k vertices cost the CPU nothing.
 *
 * The hands are the same finger CAPSULES the slime uses (HAND_BONES), inflated
 * by the cloth's half-thickness: the sheet drapes over a palm, folds round the
 * fingers, and is pushed — never passed through. A closing hand on the cloth
 * GRABS it (the nodes under the grip ride the palm frame; opening lets go with
 * the hand's velocity), and everything unheld keeps falling.
 *
 * API
 *   const piece = buildCloth(gltfScene, spec, opts)    // → { group, sim, skin }
 *   sim.step(dt, hands, floorY)     hands: [{ slot, joints[21], radii[21], vel[21], grip }]
 *   sim.x (Float32Array n×3, LOCAL)  the live lattice — that grid IS the shape
 *   skin.update()                    push the lattice to the GPU
 */
import * as THREE from 'three';
import { HAND_BONES } from './slime-sim.js';
import { JOINT_RADII } from './game-physics.js';   // the SAME radii the HoloHands render with — no gap by construction

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _cp = new THREE.Vector3(), _ct = {}, _ct2 = {};

/** closest point on triangle (a,b,c of a flat position array) to p → distance */
function _triClosest(X, ia, ib, ic, p, out) {
  const ax = X[ia], ay = X[ia + 1], az = X[ia + 2];
  const abx = X[ib] - ax, aby = X[ib + 1] - ay, abz = X[ib + 2] - az;
  const acx = X[ic] - ax, acy = X[ic + 1] - ay, acz = X[ic + 2] - az;
  const apx = p.x - ax, apy = p.y - ay, apz = p.z - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u = 0, v = 0;
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
  else {
    const bpx = p.x - X[ib], bpy = p.y - X[ib + 1], bpz = p.z - X[ib + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
    else {
      const cpx = p.x - X[ic], cpy = p.y - X[ic + 1], cpz = p.z - X[ic + 2];
      const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - w; v = w; }
            else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den; }
          }
        }
      }
    }
  }
  out.set(ax + abx * u + acx * v, ay + aby * u + acy * v, az + abz * u + acz * v);
  _bw[0] = 1 - u - v; _bw[1] = u; _bw[2] = v;       // barycentric weights of `out`
  return Math.hypot(p.x - out.x, p.y - out.y, p.z - out.z);
}
const _bw = new Float64Array(3);

/* ═══════════════════ the solver ═══════════════════ */

export class ClothSim {
  /**
   * @param {{nx:number, ny:number, rest:Float32Array}} lat  lattice rest positions, row-major (j*nx+i)
   */
  constructor(lat, opts = {}) {
    this.nx = lat.nx; this.ny = lat.ny;
    const n = this.n = this.nx * this.ny;
    this.rest = lat.rest;
    this.x = new Float32Array(lat.rest);          // live (LOCAL space)
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.w = new Float32Array(n).fill(1);         // inverse mass; 0 = kinematic
    this.o = {
      gravity: 9.0,        // m/s² (cloth reads heavy at full g on a short drop)
      substeps: 5,
      damping: 0.02,       // velocity bleed per step
      drag: 0.9,           // air drag on the normal component (keeps it from flapping)
      stretch: 0,          // XPBD compliance — 0 = inextensible along the weave
      shear: 2e-7,
      bend: 3e-6,          // a rug is stiff-ish in bend
      thickness: 0.009,    // half the slab: what a finger actually touches
      friction: 0.6,
      gripR: 0.055,        // grip radius (local units) round the pinch point
      weaveIters: 2,       // extra sweeps over the structural weave per substep
      maxStretch: 1.02,    // hard limit: a cell may never exceed this × rest
      limitIters: 3,       // passes of that clamp
      minStretch: 0.5,     // …nor crush past this (folds still close fully)
      scale: 1,            // local unit → metres (the group's uniform scale)
      ...opts,
    };
    // ── constraint arrays: structural, shear, bend ──
    // STRUCTURAL FIRST, then shear, then bend — the order is load-bearing: the
    // weave gets extra sweeps (a hanging sheet must not creep) and the stretch
    // limiter walks only that prefix.
    const G = [[], [], []];
    const id = (i, j) => j * this.nx + i;
    const push = (g, a, b, compliance) => {
      const ka = a * 3, kb = b * 3;
      const dx = this.rest[ka] - this.rest[kb], dy = this.rest[ka + 1] - this.rest[kb + 1], dz = this.rest[ka + 2] - this.rest[kb + 2];
      G[g].push(a, b, Math.hypot(dx, dy, dz), compliance);
    };
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      if (i + 1 < this.nx) push(0, id(i, j), id(i + 1, j), this.o.stretch);
      if (j + 1 < this.ny) push(0, id(i, j), id(i, j + 1), this.o.stretch);
      if (i + 1 < this.nx && j + 1 < this.ny) {
        push(1, id(i, j), id(i + 1, j + 1), this.o.shear);
        push(1, id(i + 1, j), id(i, j + 1), this.o.shear);
      }
      if (i + 2 < this.nx) push(2, id(i, j), id(i + 2, j), this.o.bend);
      if (j + 2 < this.ny) push(2, id(i, j), id(i, j + 2), this.o.bend);
    }
    const flat = [...G[0], ...G[1], ...G[2]], m = flat.length / 4;
    this.nStruct = G[0].length / 4;
    this.cA = new Int32Array(m); this.cB = new Int32Array(m);
    this.cL = new Float32Array(m); this.cC = new Float32Array(m);
    for (let c = 0; c < m; c++) {
      this.cA[c] = flat[c * 4]; this.cB[c] = flat[c * 4 + 1];
      this.cL[c] = flat[c * 4 + 2]; this.cC[c] = flat[c * 4 + 3];
    }
    this.cell = Math.min(this.cL[0] || 0.03, 1);   // one structural rest length
    // ── holds: a closing hand carries the nodes under it ──
    this.holds = { L: null, R: null };
    // ── collision scratch ──
    this._cand = new Int32Array(n);
    this._nc = 0;
    this.contacts = 0; this.grabbed = 0;
    this._lraDirty = true;
  }

  /** pin / unpin a node (kinematic): the anchor map rebuilds on the next step */
  pin(i, on = true) { this.w[i] = on ? 0 : 1; this._lraDirty = true; }

  /**
   * The rest lattice's own plane frame — origin, row/column directions and the
   * cell frame (T, B, N) built the same way the vertex shader builds the live
   * one. Everything that binds to this cloth works in THIS frame, so a lattice
   * fitted to an arbitrary prop (clothify.js) needs no special casing.
   */
  frame() {
    if (this._planeFrame) return this._planeFrame;
    const R = this.rest, k = this.nx * 3;
    const o = new THREE.Vector3(R[0], R[1], R[2]);
    const pu = new THREE.Vector3(R[3], R[4], R[5]).sub(o);          // node (1,0) − (0,0)
    const pv = new THREE.Vector3(R[k], R[k + 1], R[k + 2]).sub(o);  // node (0,1) − (0,0)
    const du = pu.length() || 1, dv = pv.length() || 1;
    const T = pu.clone().divideScalar(du), Bt = pv.clone().divideScalar(dv);
    const N = new THREE.Vector3().crossVectors(Bt, T).normalize();
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    return (this._planeFrame = { o, u: T, v: Bt, T, B, N, du, dv });
  }

  /** drop every node back on the rest lattice (optionally translated) */
  reset(offset) {
    this.x.set(this.rest); this.v.fill(0); this.w.fill(1);
    this.holds.L = this.holds.R = null; this._lraDirty = true;
    if (offset) for (let k = 0; k < this.x.length; k += 3) {
      this.x[k] += offset.x; this.x[k + 1] += offset.y; this.x[k + 2] += offset.z;
    }
  }

  /** move the WHOLE free sheet (the mirror-mode depth bias: z only, gravity untouched) */
  shift(dx, dy, dz) {
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue;
      const k = i * 3; this.x[k] += dx; this.x[k + 1] += dy; this.x[k + 2] += dz;
    }
  }

  centroid(out) {
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < this.x.length; k += 3) { sx += this.x[k]; sy += this.x[k + 1]; sz += this.x[k + 2]; }
    return out.set(sx / this.n, sy / this.n, sz / this.n);
  }

  bounds(box) {
    box.makeEmpty();
    for (let k = 0; k < this.x.length; k += 3) box.expandByPoint(_a.set(this.x[k], this.x[k + 1], this.x[k + 2]));
    return box;
  }

  /** nearest lattice node to a LOCAL point → index, or -1 beyond `within` */
  nearest(pt, within = Infinity) {
    let best = -1, bd = within * within;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3, dx = this.x[k] - pt.x, dy = this.x[k + 1] - pt.y, dz = this.x[k + 2] - pt.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /**
   * One frame. `hands` carry LOCAL-space joints/radii/velocities (see toLocalHands).
   * `floorY` is the local y the sheet lands on (null = no floor).
   */
  step(dt, hands, floorY = null) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 30);
    const S = this.o, subs = Math.max(1, S.substeps | 0), h = dt / subs;
    const g = -S.gravity / (S.scale || 1);
    const { x, p, v, w, cA, cB, cL, cC } = this;
    this.contacts = 0; this.grabbed = 0;

    this._grip(hands, dt);                       // attach / release / carry
    this._candidates(hands);                     // which nodes are near a hand at all

    for (let s = 0; s < subs; s++) {
      // ── predict ──
      const damp = Math.max(0, 1 - S.damping);
      for (let i = 0; i < this.n; i++) {
        const k = i * 3;
        if (w[i] === 0) { p[k] = x[k]; p[k + 1] = x[k + 1]; p[k + 2] = x[k + 2]; continue; }
        v[k] *= damp; v[k + 1] = v[k + 1] * damp + g * h; v[k + 2] *= damp;
        p[k] = x[k] + v[k] * h; p[k + 1] = x[k + 1] + v[k + 1] * h; p[k + 2] = x[k + 2] + v[k + 2] * h;
      }
      // ── XPBD: one Gauss-Seidel sweep over everything, then the weave alone
      //    again (and a hard stretch limit) — cloth that creeps reads as rubber ──
      const h2 = h * h;
      const sweep = (from, to, limit) => {
        for (let c = from; c < to; c++) {
          const ia = cA[c], ib = cB[c], wa = w[ia], wb = w[ib];
          const wsum = wa + wb;
          if (wsum === 0) continue;
          const a3 = ia * 3, b3 = ib * 3;
          const dx = p[a3] - p[b3], dy = p[a3 + 1] - p[b3 + 1], dz = p[a3 + 2] - p[b3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-9) continue;
          const rest = limit ? Math.min(Math.max(d, cL[c] * S.minStretch), cL[c] * limit) : cL[c];
          if (limit && d === rest) continue;
          const k = (d - rest) / (d * (wsum + (limit ? 0 : cC[c]) / h2));
          if (wa !== 0) { p[a3] -= dx * k * wa; p[a3 + 1] -= dy * k * wa; p[a3 + 2] -= dz * k * wa; }
          if (wb !== 0) { p[b3] += dx * k * wb; p[b3 + 1] += dy * k * wb; p[b3 + 2] += dz * k * wb; }
        }
      };
      sweep(0, cA.length, 0);
      for (let it = 0; it < S.weaveIters; it++) sweep(0, this.nStruct, 0);
      // …and a hard length clamp, swept a few times: Gauss-Seidel fixes one edge
      // by breaking its neighbour, so a single pass leaves the tension corners long
      for (let it = 0; it < S.limitIters; it++) sweep(0, this.nStruct, S.maxStretch);
      this._lra();      // LONG-RANGE ATTACHMENT: what actually kills the creep
      // ── the hands: joint SPHERES against the cloth's triangles (sub-cell
      //    contact) plus finger CAPSULES against the nodes (deep contact) ──
      if (hands && hands.length) { this._collideJoints(hands, h); this._collide(hands, h); }
      // ── floor ──
      if (floorY != null) {
        for (let i = 0; i < this.n; i++) {
          if (w[i] === 0) continue;
          const k = i * 3 + 1;
          if (p[k] < floorY + S.thickness) {
            p[k] = floorY + S.thickness;
            p[i * 3] += (x[i * 3] - p[i * 3]) * 0.5;          // ground friction
            p[i * 3 + 2] += (x[i * 3 + 2] - p[i * 3 + 2]) * 0.5;
          }
        }
      }
      // ── commit ──
      const ih = 1 / h;
      for (let i = 0; i < this.n; i++) {
        const k = i * 3;
        if (w[i] === 0) { x[k] = p[k]; x[k + 1] = p[k + 1]; x[k + 2] = p[k + 2]; v[k] = v[k + 1] = v[k + 2] = 0; continue; }
        v[k] = (p[k] - x[k]) * ih; v[k + 1] = (p[k + 1] - x[k + 1]) * ih; v[k + 2] = (p[k + 2] - x[k + 2]) * ih;
        x[k] = p[k]; x[k + 1] = p[k + 1]; x[k + 2] = p[k + 2];
      }
    }
    this._rehash();          // the surface index the hand-stop queries this frame
  }

  /* ── grabbing: a CLOSING hand on the cloth takes it (doctrine: nothing sticks
        to an open hand); the held nodes ride the palm frame; opening lets go ── */
  _grip(hands, dt) {
    for (const slot of ['L', 'R']) {
      const hand = hands && hands.find(x => x.slot === slot);
      const hold = this.holds[slot];
      if (!hand || !hand.present) {
        if (hold) this._release(slot, null);
        continue;
      }
      const grip = hand.grip || 0;               // 0 open … 1 closed (fist or pinch)
      if (hold) {
        if (grip < 0.35) { this._release(slot, hand); continue; }
        _m.compose(hand.palmP, hand.palmQ, _a.set(1, 1, 1));
        for (let t = 0; t < hold.idx.length; t++) {
          const i = hold.idx[t], k = i * 3;
          _b.fromArray(hold.off, t * 3).applyMatrix4(_m);
          this.x[k] = _b.x; this.x[k + 1] = _b.y; this.x[k + 2] = _b.z;
          this.w[i] = 0;
        }
        this.grabbed += hold.idx.length;
        continue;
      }
      if (grip < 0.55) continue;                 // an open hand only ever pushes
      const at = hand.gripP || hand.palmP;
      const near = this.nearest(at, this.o.gripR * 1.6);
      if (near < 0) continue;
      const idx = [], off = [];
      _q.copy(hand.palmQ).invert();
      const r2 = this.o.gripR * this.o.gripR;
      for (let i = 0; i < this.n; i++) {
        const k = i * 3, dx = this.x[k] - at.x, dy = this.x[k + 1] - at.y, dz = this.x[k + 2] - at.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        idx.push(i);
        _b.set(this.x[k], this.x[k + 1], this.x[k + 2]).sub(hand.palmP).applyQuaternion(_q);
        off.push(_b.x, _b.y, _b.z);
      }
      if (!idx.length) continue;
      this.holds[slot] = { idx, off: Float32Array.from(off) };
      for (const i of idx) { this.w[i] = 0; const k = i * 3; this.v[k] = this.v[k + 1] = this.v[k + 2] = 0; }
      this.grabbed += idx.length; this._lraDirty = true;
    }
  }

  _release(slot, hand) {
    const hold = this.holds[slot];
    if (!hold) return;
    for (const i of hold.idx) {
      this.w[i] = 1;
      if (hand && hand.palmV) {                  // leaves with the hand's motion
        const k = i * 3;
        this.v[k] = hand.palmV.x; this.v[k + 1] = hand.palmV.y; this.v[k + 2] = hand.palmV.z;
      }
    }
    this.holds[slot] = null; this._lraDirty = true;
  }

  /* ── broad phase: only nodes inside a hand's padded box can ever touch it ── */
  _candidates(hands) {
    this._nc = 0;
    if (!hands || !hands.length) return;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const H of hands) {
      if (!H.present) continue;
      const pad = (H.radii[0] || 0.02) * 2 + this.o.thickness + this.cell;
      for (let i = 0; i < 21; i++) {
        const j = H.joints[i]; if (!j) continue;
        x0 = Math.min(x0, j.x - pad); y0 = Math.min(y0, j.y - pad); z0 = Math.min(z0, j.z - pad);
        x1 = Math.max(x1, j.x + pad); y1 = Math.max(y1, j.y + pad); z1 = Math.max(z1, j.z + pad);
      }
    }
    if (x0 > x1) return;
    const x = this.x;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      if (x[k] < x0 || x[k] > x1 || x[k + 1] < y0 || x[k + 1] > y1 || x[k + 2] < z0 || x[k + 2] > z1) continue;
      this._cand[this._nc++] = i;
    }
  }

  /* ── narrow phase: node vs finger capsule, push out + friction ── */
  _collide(hands, h) {
    const { p, w, x } = this, S = this.o;
    for (const H of hands) {
      if (!H.present) continue;
      const held = this.holds[H.slot];
      for (const [ba, bb] of HAND_BONES) {
        const A = H.joints[ba], B = H.joints[bb];
        if (!A || !B) continue;
        const ax = A.x, ay = A.y, az = A.z;
        const ex = B.x - ax, ey = B.y - ay, ez = B.z - az;
        const elen2 = ex * ex + ey * ey + ez * ez;
        const ra = H.radii[ba], rb = H.radii[bb];
        for (let t = 0; t < this._nc; t++) {
          const i = this._cand[t];
          if (w[i] === 0) continue;
          const k = i * 3;
          const dx = p[k] - ax, dy = p[k + 1] - ay, dz = p[k + 2] - az;
          let s = elen2 > 1e-12 ? (dx * ex + dy * ey + dz * ez) / elen2 : 0;
          s = s < 0 ? 0 : s > 1 ? 1 : s;
          const cx = dx - ex * s, cy = dy - ey * s, cz = dz - ez * s;
          const r = (ra + (rb - ra) * s) + S.thickness;
          const d2 = cx * cx + cy * cy + cz * cz;
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          let nx, ny, nz;
          if (d > 1e-7) { nx = cx / d; ny = cy / d; nz = cz / d; }
          else { nx = 0; ny = 1; nz = 0; }       // dead centre: push up
          const push = r - d;
          p[k] += nx * push; p[k + 1] += ny * push; p[k + 2] += nz * push;
          this.contacts++;
          if (held) continue;                     // the carrying hand does not also rub
          // friction: the contact drags with the finger (its velocity), so the
          // cloth lies on the hand instead of skating off it
          const V = H.vel && H.vel[ba];
          if (V && S.friction > 0) {
            const tx = (x[k] + V.x * h) - p[k], ty = (x[k + 1] + V.y * h) - p[k + 1], tz = (x[k + 2] + V.z * h) - p[k + 2];
            const tn = tx * nx + ty * ny + tz * nz;
            p[k] += (tx - nx * tn) * S.friction;
            p[k + 1] += (ty - ny * tn) * S.friction;
            p[k + 2] += (tz - nz * tn) * S.friction;
          }
        }
      }
    }
  }

  /* ── LONG-RANGE ATTACHMENTS (Müller 2012). A sheet hanging from two fingers
        funnels its whole weight through one chain of edges, and sequential
        Gauss-Seidel always leaves that chain a few percent long — cloth that
        creeps reads as rubber. So every node also knows its GEODESIC rest
        distance to the nearest anchor, and may never exceed it: one O(n) pass
        against kinematic nodes, which nothing downstream can undo. ── */
  _rebuildLRA() {
    const n = this.n, nx = this.nx;
    if (!this.lraD) { this.lraD = new Float32Array(n); this.lraA = new Int32Array(n); this._q = new Int32Array(n * 4); }
    const D = this.lraD, A = this.lraA, Q = this._q;
    D.fill(Infinity); A.fill(-1);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (this.w[i] === 0) { D[i] = 0; A[i] = i; Q[tail++] = i; }
    this._lraOn = tail > 0;
    if (!this._lraOn) return;
    const R = this.rest;
    while (head < tail) {
      const i = Q[head++ % Q.length];
      const ii = i % nx, jj = (i / nx) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ii + di, nj = jj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= this.ny) continue;
        const m = nj * nx + ni;
        const k = i * 3, l = m * 3;
        const step = Math.hypot(R[k] - R[l], R[k + 1] - R[l + 1], R[k + 2] - R[l + 2]);
        if (D[i] + step < D[m] - 1e-9) {
          D[m] = D[i] + step; A[m] = A[i];
          Q[tail++ % Q.length] = m;
          if (tail - head > Q.length) return;        // safety: never spin
        }
      }
    }
  }

  _lra() {
    if (this._lraDirty) { this._rebuildLRA(); this._lraDirty = false; }
    if (!this._lraOn) return;
    const { p, w, lraD: D, lraA: A } = this, lim = this.o.maxStretch;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) continue;
      const a = A[i];
      if (a < 0 || !(D[i] < Infinity)) continue;
      const k = i * 3, ka = a * 3;
      const dx = p[k] - p[ka], dy = p[k + 1] - p[ka + 1], dz = p[k + 2] - p[ka + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz), max = D[i] * lim;
      if (d <= max || d < 1e-9) continue;
      const s = max / d;
      p[k] = p[ka] + dx * s; p[k + 1] = p[ka + 1] + dy * s; p[k + 2] = p[ka + 2] + dz * s;
    }
  }

  /* ── a uniform grid over the LIVE lattice: the broad phase for "is this
        fingertip touching the sheet", rebuilt once per frame ── */
  _rehash() {
    const g = this.cell * 1.6;                   // one bucket ≈ one and a half cells
    const inv = 1 / g;
    if (!this._hb) { this._hb = new Map(); this._qstamp = new Int32Array((this.nx - 1) * (this.ny - 1)); this._frame = 0; }
    const H = this._hb; H.clear();
    this._hg = g; this._hinv = inv;
    const x = this.x;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      const key = ((Math.floor(x[k] * inv) * 73856093) ^ (Math.floor(x[k + 1] * inv) * 19349663) ^ (Math.floor(x[k + 2] * inv) * 83492791)) | 0;
      let b = H.get(key);
      if (!b) H.set(key, b = []);
      b.push(i);
    }
    this._frame++;
  }

  /**
   * Closest point on the cloth SURFACE (the lattice sheet offset by its
   * half-thickness) to a LOCAL point. Returns the penetration for a sphere of
   * `radius`, or null when it is clear — this is what makes contact flush:
   * the sheet is a surface, not a cloud of node spheres, so a fingertip meets
   * it wherever it lands, not only where a node happens to be.
   */
  /** every lattice triangle whose cell is near `pt` → cb(ia, ib, ic) (flat indices) */
  _eachTri(pt, reach, cb) {
    if (!this._hb) this._rehash();
    const inv = this._hinv;
    const i0 = Math.floor((pt.x - reach) * inv), i1 = Math.floor((pt.x + reach) * inv);
    const j0 = Math.floor((pt.y - reach) * inv), j1 = Math.floor((pt.y + reach) * inv);
    const k0 = Math.floor((pt.z - reach) * inv), k1 = Math.floor((pt.z + reach) * inv);
    const stamp = ++this._frame, QS = this._qstamp, nx = this.nx, qw = nx - 1;
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) for (let c = k0; c <= k1; c++) {
      const bucket = this._hb.get(((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) | 0);
      if (!bucket) continue;
      for (const m of bucket) {
        const ii = m % nx, jj = (m / nx) | 0;
        for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) {
          const qi = ii + di, qj = jj + dj;
          if (qi < 0 || qj < 0 || qi >= qw || qj >= this.ny - 1) continue;
          const q = qj * qw + qi;
          if (QS[q] === stamp) continue;
          QS[q] = stamp;
          const p00 = (qj * nx + qi) * 3, p10 = p00 + 3, p01 = ((qj + 1) * nx + qi) * 3, p11 = p01 + 3;
          cb(p00, p10, p11); cb(p00, p11, p01);
        }
      }
    }
  }

  /**
   * THE contact that matters at 30 mm cells: a fingertip is smaller than a
   * cell, so pushing NODES out of capsules leaves it slipping between them.
   * Every joint SPHERE is resolved against the cloth's TRIANGLES instead, and
   * the correction is spread over the triangle's corners by barycentric
   * weight — the sheet meets the finger wherever it lands, flush.
   */
  _collideJoints(hands, h) {
    const { p, w, x } = this, S = this.o;
    for (const H of hands) {
      if (!H.present) continue;
      const held = this.holds[H.slot];
      for (let j = 0; j < 21; j++) {
        const J = H.joints[j]; if (!J) continue;
        const r = H.radii[j] + S.thickness;
        const V = H.vel && H.vel[j];
        this._eachTri(J, r + this.cell, (ia, ib, ic) => {
          const d = _triClosest(p, ia, ib, ic, J, _cp);
          if (d >= r || d < 1e-9) return;
          const wa = w[ia / 3 | 0], wb = w[ib / 3 | 0], wc = w[ic / 3 | 0];
          const b0 = _bw[0], b1 = _bw[1], b2 = _bw[2];
          const denom = b0 * b0 * wa + b1 * b1 * wb + b2 * b2 * wc;
          if (denom < 1e-9) return;
          const nx = (J.x - _cp.x) / d, ny = (J.y - _cp.y) / d, nz = (J.z - _cp.z) / d;
          const k = -(r - d) / denom;             // move the SURFACE away from the joint
          const B = [b0, b1, b2], I = [ia, ib, ic], W = [wa, wb, wc];
          for (let t = 0; t < 3; t++) {
            const s2 = k * B[t] * W[t];
            if (!s2) continue;
            p[I[t]] += nx * s2; p[I[t] + 1] += ny * s2; p[I[t] + 2] += nz * s2;
            // friction: the contact travels with the finger, so cloth lies on
            // the hand and is carried by it instead of skating off
            if (V && S.friction > 0 && !held) {
              const q = I[t];
              const tx = (x[q] + V.x * h) - p[q], ty = (x[q + 1] + V.y * h) - p[q + 1], tz = (x[q + 2] + V.z * h) - p[q + 2];
              const tn = tx * nx + ty * ny + tz * nz, f = S.friction * B[t];
              p[q] += (tx - nx * tn) * f; p[q + 1] += (ty - ny * tn) * f; p[q + 2] += (tz - nz * tn) * f;
            }
          }
          this.contacts++;
        });
      }
    }
  }

  contact(pt, radius, out) {
    if (!this._hb) this._rehash();
    const reach = radius + this.o.thickness + this.cell;
    const inv = this._hinv, g = this._hg;
    const i0 = Math.floor((pt.x - reach) * inv), i1 = Math.floor((pt.x + reach) * inv);
    const j0 = Math.floor((pt.y - reach) * inv), j1 = Math.floor((pt.y + reach) * inv);
    const k0 = Math.floor((pt.z - reach) * inv), k1 = Math.floor((pt.z + reach) * inv);
    const stamp = ++this._frame, QS = this._qstamp, nx = this.nx, qw = nx - 1;
    let best = Infinity, bx = 0, by = 0, bz = 0, bq = -1;
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) for (let c = k0; c <= k1; c++) {
      const bucket = this._hb.get(((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) | 0);
      if (!bucket) continue;
      for (const m of bucket) {
        const ii = m % nx, jj = (m / nx) | 0;
        for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) {
          const qi = ii + di, qj = jj + dj;
          if (qi < 0 || qj < 0 || qi >= qw || qj >= this.ny - 1) continue;
          const q = qj * qw + qi;
          if (QS[q] === stamp) continue;
          QS[q] = stamp;
          const p00 = (qj * nx + qi) * 3, p10 = p00 + 3, p01 = ((qj + 1) * nx + qi) * 3, p11 = p01 + 3;
          for (const tri of [[p00, p10, p11], [p00, p11, p01]]) {
            const d = _triClosest(this.x, tri[0], tri[1], tri[2], pt, _cp);
            if (d < best) { best = d; bx = _cp.x; by = _cp.y; bz = _cp.z; bq = q; }
          }
        }
      }
    }
    if (bq < 0) return null;
    const r = radius + this.o.thickness;
    if (best >= r) return null;
    out = out || {};
    out.depth = r - best;
    out.px = bx; out.py = by; out.pz = bz;
    const dx = pt.x - bx, dy = pt.y - by, dz = pt.z - bz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-7) { out.nx = dx / len; out.ny = dy / len; out.nz = dz / len; }
    else { out.nx = 0; out.ny = 1; out.nz = 0; }
    out.gap = best - this.o.thickness;           // surface-to-point clearance
    return out;
  }

  /** min surface clearance of a whole hand (local joints) — the "is it touching" gate */
  handGap(joints, radii) {
    let g = Infinity;
    for (let i = 0; i < 21; i++) {
      const c = this.contact(joints[i], radii[i] + 0.05, _ct);
      if (c) g = Math.min(g, c.gap - radii[i]);
    }
    return g;
  }

  stats() {
    const b = this.bounds(new THREE.Box3());
    let vmax = 0;
    for (let k = 0; k < this.v.length; k += 3) vmax = Math.max(vmax, Math.hypot(this.v[k], this.v[k + 1], this.v[k + 2]));
    return { nodes: this.n, contacts: this.contacts, grabbed: this.grabbed,
             held: { L: !!this.holds.L, R: !!this.holds.R },
             size: b.getSize(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)),
             speed: +vmax.toFixed(3) };
  }
}

/* ═══════════════════ the embedded skin ═══════════════════ */

/**
 * The prop's real surface, carried by the lattice IN THE VERTEX SHADER.
 * Each vertex keeps its rest cell (u, v) and its offset in that cell's rest
 * frame; the shader rebuilds the cell frame from the live lattice texture and
 * replays the offset. Nothing per-vertex touches the CPU after bind.
 */
export class ClothSkin {
  constructor(mesh, sim) {
    this.mesh = mesh; this.sim = sim;
    const nx = sim.nx, ny = sim.ny, rest = sim.rest;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const n = pos.count;
    // The binding is expressed in the REST CELL FRAME, whatever that frame is:
    // the lattice may lie in any plane at any orientation (clothify.js fits one
    // to an arbitrary prop), so nothing here may assume world axes. Both the
    // offset and the rest normal are written in (T₀, B₀, N₀), and the shader
    // replays them in the live cell's (T, B, N) — so rest reproduces exactly
    // and the sheet carries its own shading with it.
    const F = sim.frame();
    const du = F.du, dv = F.dv;
    const cell = new Float32Array(n * 2), off = new Float32Array(n * 3), nb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      _a.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(F.o);
      const u = Math.min(Math.max(_a.dot(F.u) / du, 0), nx - 1.0001);
      const v = Math.min(Math.max(_a.dot(F.v) / dv, 0), ny - 1.0001);
      cell[i * 2] = u; cell[i * 2 + 1] = v;
      const ci = u | 0, cj = v | 0, a = u - ci, b = v - cj;
      const at = (ii, jj, c) => rest[(jj * nx + ii) * 3 + c];
      const bx = at(ci, cj, 0) * (1 - a) * (1 - b) + at(ci + 1, cj, 0) * a * (1 - b) + at(ci, cj + 1, 0) * (1 - a) * b + at(ci + 1, cj + 1, 0) * a * b;
      const by = at(ci, cj, 1) * (1 - a) * (1 - b) + at(ci + 1, cj, 1) * a * (1 - b) + at(ci, cj + 1, 1) * (1 - a) * b + at(ci + 1, cj + 1, 1) * a * b;
      const bz = at(ci, cj, 2) * (1 - a) * (1 - b) + at(ci + 1, cj, 2) * a * (1 - b) + at(ci, cj + 1, 2) * (1 - a) * b + at(ci + 1, cj + 1, 2) * a * b;
      _b.set(pos.getX(i) - bx, pos.getY(i) - by, pos.getZ(i) - bz);
      off[i * 3] = _b.dot(F.T); off[i * 3 + 1] = _b.dot(F.B); off[i * 3 + 2] = _b.dot(F.N);
      if (nrm) {
        _c.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
        nb[i * 3] = _c.dot(F.T); nb[i * 3 + 1] = _c.dot(F.B); nb[i * 3 + 2] = _c.dot(F.N);
      } else nb[i * 3 + 2] = 1;
    }
    g.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
    g.setAttribute('aOff', new THREE.BufferAttribute(off, 3));
    g.setAttribute('aNrm', new THREE.BufferAttribute(nb, 3));
    // the lattice, as a texture the vertex shader can read
    this.data = new Float32Array(nx * ny * 4);
    this.tex = new THREE.DataTexture(this.data, nx, ny, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this._patch(mesh.material, nx, ny);
    this.update();
    // the sheet moves far from where it was authored — never frustum-cull it
    mesh.frustumCulled = false;                 // the sheet leaves its authored box
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius *= 3;   // room to fold/hang, still pickable
  }

  _patch(mat, nx, ny) {
    const uni = { uLat: { value: this.tex }, uLatSize: { value: new THREE.Vector2(nx, ny) } };
    this.uniforms = uni;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const M of mats) {
      M.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uni);
        sh.vertexShader = `
          uniform sampler2D uLat;
          uniform vec2 uLatSize;
          attribute vec2 aCell;
          attribute vec3 aOff;
          attribute vec3 aNrm;
          vec3 latAt(vec2 ij) {
            return texture2D(uLat, (clamp(ij, vec2(0.0), uLatSize - 1.0) + 0.5) / uLatSize).xyz;
          }
        ` + sh.vertexShader.replace(
          '#include <beginnormal_vertex>',
          `
          vec2 cIJ = floor(aCell);
          vec2 cAB = aCell - cIJ;
          vec3 q00 = latAt(cIJ), q10 = latAt(cIJ + vec2(1.0, 0.0));
          vec3 q01 = latAt(cIJ + vec2(0.0, 1.0)), q11 = latAt(cIJ + vec2(1.0, 1.0));
          vec3 clothBase = mix(mix(q00, q10, cAB.x), mix(q01, q11, cAB.x), cAB.y);
          // the LIVE cell frame, built exactly as the rest frame was at bind time,
          // so aOff / aNrm (which are written in that frame) replay without
          // assuming anything about which way the lattice lies in the world
          vec3 clothT = normalize(mix(q10 - q00, q11 - q01, cAB.y) + vec3(1e-9, 0.0, 0.0));
          vec3 clothBt = normalize(mix(q01 - q00, q11 - q10, cAB.x) + vec3(0.0, 0.0, 1e-9));
          vec3 clothN = normalize(cross(clothBt, clothT));
          vec3 clothB = normalize(cross(clothT, clothN));
          vec3 objectNormal = normalize(aNrm.x * clothT + aNrm.y * clothB + aNrm.z * clothN);
          `
        ).replace(
          '#include <begin_vertex>',
          'vec3 transformed = clothBase + aOff.x * clothT + aOff.y * clothB + aOff.z * clothN;'
        );
      };
      M.needsUpdate = true;
      M.side = THREE.DoubleSide;
    }
  }

  /** push the live lattice to the GPU (one 45×64 texture upload) */
  update() {
    const x = this.sim.x, d = this.data;
    for (let i = 0, k = 0, t = 0; i < this.sim.n; i++, k += 3, t += 4) {
      d[t] = x[k]; d[t + 1] = x[k + 1]; d[t + 2] = x[k + 2];
    }
    this.tex.needsUpdate = true;
  }

  dispose() { this.tex.dispose(); }
}

/* ═══════════════════ loading a cloth prop ═══════════════════ */

/**
 * Pull `RugSim` (the lattice) and `RugSkin` (the surface) out of a loaded glTF
 * scene and wire them together. The lattice indexing is RE-DERIVED from the
 * node positions (never trusted to survive the exporter), and verified.
 */
export function buildCloth(gltfScene, spec = {}, opts = {}) {
  let latMesh = null, skinMesh = null;
  gltfScene.traverse(o => {
    if (!o.isMesh) return;
    if (/sim|lattice|cloth/i.test(o.name)) latMesh = o;
    else if (/skin|render/i.test(o.name) || !skinMesh) skinMesh = o;
  });
  if (!latMesh || !skinMesh) throw new Error('cloth: need a lattice mesh and a skin mesh (RugSim / RugSkin)');
  const nx = spec.nx | 0, ny = spec.ny | 0;
  // normalise the sheet to LOCAL y = 0: the asset carries whatever height the
  // scan's mid-surface happened to sit at, and every floor/seat calculation
  // downstream would have to know it
  {
    const lp0 = latMesh.geometry.attributes.position;
    let sy = 0; for (let i = 0; i < lp0.count; i++) sy += lp0.getY(i);
    const dy = -sy / lp0.count;
    if (Math.abs(dy) > 1e-9) { latMesh.geometry.translate(0, dy, 0); skinMesh.geometry.translate(0, dy, 0); }
  }
  const lp = latMesh.geometry.attributes.position;
  if (!nx || !ny || nx * ny !== lp.count) throw new Error(`cloth: spec ${nx}x${ny} does not match the lattice (${lp.count} nodes)`);
  // re-derive row/column from the rest positions: the rest lattice is a regular
  // axis-aligned grid, so (i, j) comes straight off the bounding box
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < lp.count; i++) {
    x0 = Math.min(x0, lp.getX(i)); x1 = Math.max(x1, lp.getX(i));
    z0 = Math.min(z0, lp.getZ(i)); z1 = Math.max(z1, lp.getZ(i));
  }
  const dx = (x1 - x0) / (nx - 1), dz = (z1 - z0) / (ny - 1);
  const rest = new Float32Array(nx * ny * 3);
  const seen = new Uint8Array(nx * ny);
  for (let t = 0; t < lp.count; t++) {
    const i = Math.round((lp.getX(t) - x0) / dx), j = Math.round((lp.getZ(t) - z0) / dz);
    if (i < 0 || i >= nx || j < 0 || j >= ny) throw new Error('cloth: lattice node off the grid');
    const k = (j * nx + i) * 3;
    rest[k] = lp.getX(t); rest[k + 1] = lp.getY(t); rest[k + 2] = lp.getZ(t);
    seen[j * nx + i] = 1;
  }
  for (let i = 0; i < seen.length; i++) if (!seen[i]) throw new Error('cloth: lattice is not a regular grid');
  const sim = new ClothSim({ nx, ny, rest }, opts);
  const skin = new ClothSkin(skinMesh, sim);
  latMesh.visible = false;
  const group = new THREE.Group();
  group.name = 'ClothPiece';
  group.add(skinMesh);
  // a wireframe of the live lattice, for the debug view
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(latMesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x5de8ff, transparent: true, opacity: 0.6, depthTest: false }));
  wire.visible = false; wire.frustumCulled = false;
  group.add(wire);
  return { group, sim, skin, wire, size: [Math.abs(x1 - x0), Math.abs(z1 - z0)] };
}

/** the live lattice → the debug wireframe (only while it is visible) */
export function updateClothWire(wire, sim) {
  if (!wire || !wire.visible) return;
  const pos = wire.geometry.attributes.position, src = wire.geometry.userData.pairs;
  if (!src) {                                   // index the wireframe against the lattice once
    const rest = sim.rest, map = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      let best = -1, bd = Infinity;
      for (let j = 0; j < sim.n; j++) {
        const d = (rest[j * 3] - pos.getX(i)) ** 2 + (rest[j * 3 + 1] - pos.getY(i)) ** 2 + (rest[j * 3 + 2] - pos.getZ(i)) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      map[i] = best;
    }
    wire.geometry.userData.pairs = map;
    return updateClothWire(wire, sim);
  }
  for (let i = 0; i < pos.count; i++) {
    const k = src[i] * 3;
    pos.setXYZ(i, sim.x[k], sim.x[k + 1], sim.x[k + 2]);
  }
  pos.needsUpdate = true;
}

/**
 * HAND RESISTANCE against cloth (the if/else contact clamp, sheet edition).
 * Whatever penetration is left after the cloth has yielded — it is pinned, it
 * is pressed against the other hand, the finger came through between two
 * nodes — is taken out of the HAND: the whole pack is translated back along
 * the deepest contact normal, in place, BEFORE the rigs render. So the drawn
 * fingers stop ON the rug's surface instead of sinking into it.
 *
 * Mutates `pack` (world space). Returns the resolved depth in metres.
 * `gate` is the clearance at which avoidance switches on (metres, world).
 */
export function clothResistHand(sim, obj, pack, radii, { share = 1, gate = 0.004 } = {}) {
  if (!pack || !pack[0] || !sim._hb) return 0;
  obj.updateWorldMatrix(true, false);
  _m.copy(obj.matrixWorld).invert();
  const s = obj.getWorldScale(_e).x || 1;
  let prev = _prevPack.get(pack);
  if (!prev) _prevPack.set(pack, prev = new Float32Array(63).fill(NaN));
  let depth = 0, dnx = 0, dny = 0, dnz = 0;
  for (let i = 0; i < 21; i++) {
    const src = pack[i];
    if (!src) continue;
    _a.copy(src).applyMatrix4(_m);
    // SWEPT capture: a fast finger must not tunnel through a 30 mm sheet between
    // frames, so the search radius grows by however far this joint just moved
    const moved = Number.isNaN(prev[i * 3]) ? 0 : Math.min(0.06, Math.hypot(_a.x - prev[i * 3], _a.y - prev[i * 3 + 1], _a.z - prev[i * 3 + 2]));
    prev[i * 3] = _a.x; prev[i * 3 + 1] = _a.y; prev[i * 3 + 2] = _a.z;
    const rad = radii[i] / s;
    const c = sim.contact(_a, rad + (gate / s) + moved, _ct2);
    if (!c) continue;
    // FLUSH: the stop resolves to skin-on-skin — the gate only widens the
    // search, it is never an offset the hand floats on
    const pen = rad - c.gap;
    if (pen > depth) { depth = pen; dnx = c.nx; dny = c.ny; dnz = c.nz; }
  }
  if (depth <= 0) return 0;
  // one rigid translation for the whole pack: the hand keeps its shape, the
  // contact resolves, and every gesture reads the STOPPED hand
  _b.set(dnx, dny, dnz).transformDirection(obj.matrixWorld).normalize();
  const push = Math.min(depth * s, 0.08) * share;
  for (let i = 0; i < 21; i++) {           // component-wise: a pack may be plain {x,y,z}
    const p = pack[i]; if (!p) continue;
    p.x += _b.x * push; p.y += _b.y * push; p.z += _b.z * push;
  }
  return push;
}

/**
 * World hand packs → the LOCAL-space hands the sim wants. `obj` is the cloth
 * group (its inverse world matrix is the frame), `prev` caches joint positions
 * so per-joint velocity is a difference, not a guess.
 */
export function toLocalHands(packs, obj, dt, cache) {
  const out = [];
  if (!packs) return out;
  obj.updateWorldMatrix(true, false);
  _m.copy(obj.matrixWorld).invert();
  const scale = obj.getWorldScale(_e).x || 1;
  const idt = 1 / Math.max(dt, 1e-3);
  for (const slot of ['L', 'R']) {
    const pack = packs[slot];
    let C = cache[slot];
    if (!pack || !pack[0] || !pack[9]) { if (C) C.present = false; continue; }
    if (!C) {
      C = cache[slot] = { slot, joints: [], vel: [], radii: new Float32Array(21), present: false,
                          palmP: new THREE.Vector3(), palmQ: new THREE.Quaternion(), palmV: new THREE.Vector3(),
                          gripP: new THREE.Vector3(), grip: 0, _pp: new THREE.Vector3() };
      for (let i = 0; i < 21; i++) { C.joints.push(new THREE.Vector3()); C.vel.push(new THREE.Vector3()); }
    }
    // joints into the cloth's frame
    for (let i = 0; i < 21; i++) {
      const src = pack[i] || pack[0];
      _a.copy(src).applyMatrix4(_m);
      if (C.present) C.vel[i].set((_a.x - C.joints[i].x) * idt, (_a.y - C.joints[i].y) * idt, (_a.z - C.joints[i].z) * idt).clampLength(0, 6);
      else C.vel[i].set(0, 0, 0);
      C.joints[i].copy(_a);
    }
    // radii: the palm ruler, in local units
    const palm = Math.max(0.02, C.joints[0].distanceTo(C.joints[9]));
    for (let i = 0; i < 21; i++) C.radii[i] = JOINT_RADII[i] * (palm / 0.204);
    // palm frame (hands.js basis doctrine)
    _a.copy(C.joints[9]).sub(C.joints[0]).normalize();
    _b.copy(C.joints[5]).sub(C.joints[17]);
    _c.crossVectors(_a, _b);
    if (_c.lengthSq() < 1e-10) { C.present = false; continue; }
    _c.normalize(); _d.crossVectors(_a, _c).normalize();
    _m2.makeBasis(_d, _a, _c);
    C.palmQ.setFromRotationMatrix(_m2);
    C.palmP.copy(C.joints[0]).lerp(C.joints[9], 0.5);
    if (C.present) C.palmV.subVectors(C.palmP, C._pp).multiplyScalar(idt).clampLength(0, 6);
    else C.palmV.set(0, 0, 0);
    C._pp.copy(C.palmP);
    // grip: a fist OR a pinch closes it; the pinch point is where a pinch grabs
    let reach = 0;
    for (const i of [8, 12, 16, 20]) reach += C.joints[i].distanceTo(C.joints[0]);
    const fist = Math.min(1, Math.max(0, (1.6 - (reach / 4) / palm) / 0.6));
    const pinch = Math.min(1, Math.max(0, (0.55 - C.joints[4].distanceTo(C.joints[8]) / palm) / 0.3));
    C.fist = fist; C.pinch = pinch;
    C.grip = Math.max(fist, pinch);
    C.gripP.copy(C.joints[4]).lerp(C.joints[8], 0.5);
    C.scale = scale;
    C.present = true;
    out.push(C);
  }
  return out;
}
const _m2 = new THREE.Matrix4();
const _prevPack = new WeakMap();   // last local joint positions per pack — the swept-capture memory
