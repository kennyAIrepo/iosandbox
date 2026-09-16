/**
 * hopeOS SDK — slime-sim.js: a LIVE POINT-CLOUD slime.
 * ═══════════════════════════════════════════════════════════════════════════
 * The blob is not a mesh that gets bent — it is N mass particles carrying the
 * ball's volume (particle-based viscoelastic fluid, Clavet–Beaudoin–Poulin
 * 2005, with XSPH viscosity). Every frame the cloud IS the shape:
 *   · double-density relaxation keeps the volume (incompressible + anti-clump)
 *   · plastic springs between neighbours give the goo its pull: stretch it
 *     between two hands and the bonds creep (yield γ, plasticity α) into a
 *     ribbon; thin it far enough and the bonds break — it separates
 *   · gravity takes whatever is not supported: it drips off the fingers
 *   · the hands are CAPSULES per finger bone (the 21 joint spheres joined),
 *     with an adhesion skin: slime within the skin clings, takes the hand's
 *     velocity (friction) and is dragged along — so it wraps the fingers, lies
 *     flat on the palm and stretches when the hands move apart
 *   · a rigid "shape-match" weight w (1 = glass sphere … 0 = free fluid) is
 *     what MAKES IT SLIME: the ball melts as w ramps down, and re-solidifies
 *     as it ramps up, mass and position untouched
 * SlimeSurface turns the cloud into a smooth mesh every frame (metaballs +
 * marching cubes, field-gradient normals), sized to the cloud's live bounds —
 * so the vertex/poly count follows the shape, and thin drips stay smooth.
 *
 * API
 *   sim = new SlimeSim({ n, gravity, ... })
 *   sim.spawn(center:Vector3, R, vel?)      fill a sphere of radius R with n particles
 *   sim.step(dt, hands, floorY)             hands: [{ joints:[Vector3×21], radii:[21], vel:[Vector3×21] }]
 *   sim.x (Float32Array n×3)                THE live point cloud (world metres)
 *   sim.rigid                               0…1 shape-match weight (1 = rigid ball)
 *   sim.stats()                             centroid, bbox, stretch, stuck/dripping counts, bonds, speed
 *   sim.centroid(out)
 */
import * as THREE from 'three';

// finger bones (MediaPipe topology) → capsules; palm web included
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

const _c = new THREE.Vector3();

/** spawn the cloud at R × this so the re-meshed SURFACE comes out at R (the field sits outside the particles) */
export const CLOUD_R = 0.94;

export class SlimeSim {
  constructor(opts = {}) {
    this.o = {
      n: 520,
      hMul: 2.3,        // interaction radius = hMul × particle spacing
      gravity: 2.5,     // m/s² (slime-scale: a 32cm blob would look frantic at 9.8)
      k: 0,             // density (pressure) stiffness — 0: the bonds carry the volume
      kNear: 40,        // near-density stiffness (anti-clump)
      kSpring: 0.8,     // bond stiffness 0…1 (fraction of the bond error closed per substep)
      alpha: 5,         // plasticity rate (1/s): how fast a stretched bond creeps
      gamma: 0.15,      // yield ratio: bonds creep only beyond ±γ·L
      visc: 0.85,       // XSPH velocity blend per substep (0 water … 0.9 goo)
      maxSub: 1 / 60,   // substep cap
      skin: 0.006,      // contact skin over the finger capsule (m)
      band: 0.03,       // adhesion band beyond the skin (m): slime this close clings
      adhesion: 0.85,   // pull toward the skin per substep inside the band
      friction: 0.9,    // tangential slip removed on contact (positional)
      stickDrag: 0.7,   // slip/velocity taken from the hand inside the band
      maxPull: 0.5,     // adhesion pull cap per substep, in particle spacings (a fast yank detaches)
      breakAt: 2.0,     // a bond stretched past breakAt·h snaps
      formAt: 1.35,     // new bonds only form within formAt·spacing (close contact)
      maxSpeed: 4.0,    // m/s clamp (stability)
      ...opts,
    };
    this.n = 0; this.h = 0; this.spacing = 0; this.R = 0; this.rho0 = 0;
    this.rigid = 0;
    this.x = new Float32Array(0); this.xp = new Float32Array(0); this.v = new Float32Array(0);
    this.rest = new Float32Array(0);           // rest offsets from the centroid (shape match)
    this.stuck = new Uint8Array(0);            // 1 = in contact / adhesion band this step
    this.MAXB = 40;                            // bonds per particle (typed lists — no Map churn)
    this.bN = new Uint8Array(0); this.bJ = new Int32Array(0); this.bL = new Float32Array(0);
    this.bonds = 0;
    this._pairs = null;                        // Int32Array of (i, j) for the current substep
    this._nPairs = 0;
    this._rho = new Float32Array(0); this._rhoN = new Float32Array(0);
    this._caps = [];                           // capsules built per step
    this.time = 0;
  }

  /** Fill a sphere: jittered lattice, spacing from the volume / n. */
  spawn(center, R, vel = null) {
    const o = this.o, n = o.n;
    this.R = R;
    const s = Math.cbrt((4 / 3) * Math.PI * R * R * R / n);
    this.spacing = s; this.h = o.hMul * s;
    const pts = [];
    const m = Math.ceil(R / s) + 1;
    for (let i = -m; i <= m; i++) for (let j = -m; j <= m; j++) for (let k = -m; k <= m; k++) {
      const x = i * s, y = j * s, z = k * s;
      if (x * x + y * y + z * z <= R * R) pts.push([x, y, z]);
    }
    // trim / pad to exactly n (drop the outermost first)
    pts.sort((a, b) => (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) - (b[0] ** 2 + b[1] ** 2 + b[2] ** 2));
    while (pts.length > n) pts.pop();
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    while (pts.length < n) { const p = pts[Math.floor(Math.abs(rnd()) * 2 * pts.length) % pts.length]; pts.push([p[0] + rnd() * s, p[1] + rnd() * s, p[2] + rnd() * s]); }
    this.n = n;
    this.x = new Float32Array(n * 3); this.xp = new Float32Array(n * 3); this.v = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 3); this.stuck = new Uint8Array(n);
    this._rho = new Float32Array(n); this._rhoN = new Float32Array(n);
    this._acc = new Float32Array(n * 3); this._cnt = new Uint16Array(n);
    this._vacc = new Float32Array(n * 3); this._wsum = new Float32Array(n);
    this._cx = new Int32Array(n); this._cy = new Int32Array(n); this._cz = new Int32Array(n); this._mark = new Int32Array(n);
    this._NB = 4096; this._cellOf = new Int32Array(n); this._cellStart = new Int32Array(this._NB + 1); this._cellFill = new Int32Array(this._NB); this._cellIdx = new Int32Array(n);
    this.bN = new Uint8Array(n); this.bJ = new Int32Array(n * this.MAXB); this.bL = new Float32Array(n * this.MAXB); this.bonds = 0;
    this._pairs = new Int32Array(n * 64 * 2);
    for (let i = 0; i < n; i++) {
      const p = pts[i], j = i * 3;
      const jx = rnd() * s * 0.25, jy = rnd() * s * 0.25, jz = rnd() * s * 0.25;
      this.rest[j] = p[0] + jx; this.rest[j + 1] = p[1] + jy; this.rest[j + 2] = p[2] + jz;
      this.x[j] = center.x + this.rest[j]; this.x[j + 1] = center.y + this.rest[j + 1]; this.x[j + 2] = center.z + this.rest[j + 2];
      this.xp[j] = this.x[j]; this.xp[j + 1] = this.x[j + 1]; this.xp[j + 2] = this.x[j + 2];
      if (vel) { this.v[j] = vel.x; this.v[j + 1] = vel.y; this.v[j + 2] = vel.z; }
    }
    this.bN.fill(0); this.bonds = 0;
    // calibrate the rest density on the interior (top half of the densities)
    this._buildPairs();
    this._densities();
    const d = Array.from(this._rho).sort((a, b) => b - a);
    let acc = 0; const half = Math.max(1, d.length >> 1);
    for (let i = 0; i < half; i++) acc += d[i];
    this.rho0 = acc / half;
    this.time = 0;
    return this;
  }

  centroid(out = _c) {
    out.set(0, 0, 0); const x = this.x, n = this.n;
    for (let i = 0; i < n; i++) { out.x += x[i * 3]; out.y += x[i * 3 + 1]; out.z += x[i * 3 + 2]; }
    return out.multiplyScalar(1 / Math.max(1, n));
  }

  // ── spatial hash + neighbour pairs (r < h) ──
  _buildPairs() {
    // counting-sort spatial hash (fixed bucket table, no allocation): bucket =
    // hash(cell) & (NB-1); collisions only cost extra distance checks
    const n = this.n, h = this.h, x = this.x, inv = 1 / h, NB = this._NB, mask = NB - 1;
    const cx = this._cx, cy = this._cy, cz = this._cz, cellOf = this._cellOf, start = this._cellStart, fill = this._cellFill, idx = this._cellIdx;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(x[i * 3] * inv), b = Math.floor(x[i * 3 + 1] * inv), c = Math.floor(x[i * 3 + 2] * inv);
      cx[i] = a; cy[i] = b; cz[i] = c;
      const hc = ((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) & mask;
      cellOf[i] = hc; start[hc + 1]++;
    }
    for (let k = 0; k < NB; k++) start[k + 1] += start[k];
    fill.set(start.subarray(0, NB));
    for (let i = 0; i < n; i++) idx[fill[cellOf[i]]++] = i;
    let np = 0; const P = this._pairs, h2 = h * h, cap = P.length / 2;
    for (let i = 0; i < n && np < cap; i++) {
      const ix = x[i * 3], iy = x[i * 3 + 1], iz = x[i * 3 + 2], a0 = cx[i], b0 = cy[i], c0 = cz[i];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const hc = (((a0 + a) * 73856093) ^ ((b0 + b) * 19349663) ^ ((c0 + c) * 83492791)) & mask;
        for (let k = start[hc], e = start[hc + 1]; k < e; k++) {
          const j = idx[k]; if (j <= i) continue;
          const dx = x[j * 3] - ix, dy = x[j * 3 + 1] - iy, dz = x[j * 3 + 2] - iz;
          if (dx * dx + dy * dy + dz * dz < h2 && np < cap) { P[np * 2] = i; P[np * 2 + 1] = j; np++; }
        }
      }
    }
    this._nPairs = np;
  }

  _densities() {
    const x = this.x, h = this.h, P = this._pairs, np = this._nPairs, rho = this._rho, rhoN = this._rhoN;
    rho.fill(0); rhoN.fill(0);
    for (let p = 0; p < np; p++) {
      const i = P[p * 2], j = P[p * 2 + 1];
      const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
      const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / h; if (q >= 1) continue;
      const a = 1 - q, a2 = a * a, a3 = a2 * a;
      rho[i] += a2; rho[j] += a2; rhoN[i] += a3; rhoN[j] += a3;
    }
  }

  /** Build the finger capsules for this step from the hand joint clouds. */
  _capsules(hands) {
    const caps = this._caps; caps.length = 0;
    if (!hands) return caps;
    for (const hb of hands) {
      if (!hb || !hb.joints || !hb.joints[0] || hb.present === false) continue;
      const J = hb.joints, Rr = hb.radii, V = hb.vel;
      for (const [a, b] of HAND_BONES) {
        const A = J[a], B = J[b]; if (!A || !B) continue;
        caps.push({ ax: A.x, ay: A.y, az: A.z, bx: B.x, by: B.y, bz: B.z,
                    ra: Rr ? Rr[a] : 0.014, rb: Rr ? Rr[b] : 0.014,
                    vax: V && V[a] ? V[a].x : 0, vay: V && V[a] ? V[a].y : 0, vaz: V && V[a] ? V[a].z : 0,
                    vbx: V && V[b] ? V[b].x : 0, vby: V && V[b] ? V[b].y : 0, vbz: V && V[b] ? V[b].z : 0 });
      }
    }
    return caps;
  }

  /**
   * Advance the cloud. hands = [{joints, radii, vel}], floorY = ground plane or null.
   * Extra rigid spheres can be passed via opts.spheres = [{p:Vector3, r}].
   */
  step(dt, hands, floorY = null, extra = null) {
    if (!this.n) return;
    const o = this.o;
    const dtc = Math.min(dt, 1 / 30);
    const nsub = Math.max(1, Math.ceil(dtc / o.maxSub));
    const hs = dtc / nsub;
    const caps = this._capsules(hands);
    const spheres = extra && extra.spheres ? extra.spheres : null;
    for (let s = 0; s < nsub; s++) this._substep(hs, caps, floorY, spheres);
    this.time += dt;
  }

  _substep(dt, caps, floorY, spheres) {
    const n = this.n, x = this.x, xp = this.xp, v = this.v, o = this.o, h = this.h;
    const g = o.gravity * (1 - this.rigid);
    const dt2 = dt * dt;
    // gravity
    for (let i = 0; i < n; i++) v[i * 3 + 1] -= g * dt;
    this._buildPairs();
    const P = this._pairs, np = this._nPairs;
    // XSPH viscosity: blend toward the neighbour-mean velocity (unconditionally stable)
    if (o.visc > 0) {
      const acc = this._vacc, wsum = this._wsum; acc.fill(0); wsum.fill(0);
      for (let p = 0; p < np; p++) {
        const i = P[p * 2], j = P[p * 2 + 1];
        const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
        const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / h; if (q >= 1) continue;
        const w = 1 - q;
        acc[i * 3] += v[j * 3] * w; acc[i * 3 + 1] += v[j * 3 + 1] * w; acc[i * 3 + 2] += v[j * 3 + 2] * w; wsum[i] += w;
        acc[j * 3] += v[i * 3] * w; acc[j * 3 + 1] += v[i * 3 + 1] * w; acc[j * 3 + 2] += v[i * 3 + 2] * w; wsum[j] += w;
      }
      const c = o.visc;
      for (let i = 0; i < n; i++) if (wsum[i] > 0) {
        const iw = 1 / wsum[i];
        v[i * 3] += (acc[i * 3] * iw - v[i * 3]) * c; v[i * 3 + 1] += (acc[i * 3 + 1] * iw - v[i * 3 + 1]) * c; v[i * 3 + 2] += (acc[i * 3 + 2] * iw - v[i * 3 + 2]) * c;
      }
    }
    // predict
    const vmax = o.maxSpeed;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const sp = Math.hypot(v[j], v[j + 1], v[j + 2]); if (sp > vmax) { const f = vmax / sp; v[j] *= f; v[j + 1] *= f; v[j + 2] *= f; }
      xp[j] = x[j]; xp[j + 1] = x[j + 1]; xp[j + 2] = x[j + 2];
      x[j] += v[j] * dt; x[j + 1] += v[j + 1] * dt; x[j + 2] += v[j + 2] * dt;
    }
    // plastic bonds — (1) creep / form, walking the pair list (grouped by i)
    const MAXB = this.MAXB, bN = this.bN, bJ = this.bJ, bL = this.bL, mark = this._mark;
    const alpha = o.alpha, gamma = o.gamma, ks = o.kSpring, formAt = o.formAt * this.spacing;
    let curI = -1;
    for (let p = 0; p < np; p++) {
      const i = P[p * 2], j = P[p * 2 + 1];
      if (i !== curI) {                                         // new i: mark its bond slots (mark[j] = slot+1)
        if (curI >= 0) for (let b = 0; b < bN[curI]; b++) mark[bJ[curI * MAXB + b]] = 0;
        curI = i; for (let b = 0; b < bN[i]; b++) mark[bJ[i * MAXB + b]] = b + 1;
      }
      const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let slot = mark[j] - 1;
      if (slot < 0) {                                           // new bond only on CLOSE contact
        if (r > formAt || bN[i] >= MAXB) continue;              // (self-adhesion / merging — never a
        slot = bN[i]++; bJ[i * MAXB + slot] = j; bL[i * MAXB + slot] = r; mark[j] = slot + 1; this.bonds++;   // stretched pair re-bonding)
        continue;
      }
      let L = bL[i * MAXB + slot];
      const d = gamma * L;
      if (r > L + d) L += dt * alpha * (r - L - d);
      else if (r < L - d) L -= dt * alpha * (L - d - r);
      bL[i * MAXB + slot] = L;
    }
    if (curI >= 0) for (let b = 0; b < bN[curI]; b++) mark[bJ[curI * MAXB + b]] = 0;
    // (2) apply the bonds as averaged (Jacobi) distance constraints: each particle
    // moves by the MEAN of what its bonds ask, scaled by kSpring (0…1) — stable
    // whatever the neighbour count, so the goo can be genuinely stiff
    const acc = this._acc, cnt = this._cnt; acc.fill(0); cnt.fill(0);
    const breakAt = h * o.breakAt;
    for (let i = 0; i < n; i++) {
      const base = i * MAXB;
      for (let b = 0; b < bN[i]; b++) {
        const j = bJ[base + b], L = bL[base + b];
        const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > breakAt || r < 1e-7) {                          // torn apart: the bond breaks (swap-remove)
          const last = --bN[i]; bJ[base + b] = bJ[base + last]; bL[base + b] = bL[base + last]; this.bonds--; b--; continue;
        }
        const D = (r - L) / r * 0.5;                            // each side closes half the error
        acc[i * 3] += dx * D; acc[i * 3 + 1] += dy * D; acc[i * 3 + 2] += dz * D; cnt[i]++;
        acc[j * 3] -= dx * D; acc[j * 3 + 1] -= dy * D; acc[j * 3 + 2] -= dz * D; cnt[j]++;
      }
    }
    for (let i = 0; i < n; i++) if (cnt[i]) {
      const f = ks * 1.5 / cnt[i];                              // SOR-style over-relaxation
      x[i * 3] += acc[i * 3] * f; x[i * 3 + 1] += acc[i * 3 + 1] * f; x[i * 3 + 2] += acc[i * 3 + 2] * f;
    }
    // double density relaxation (volume)
    this._densities();
    const rho = this._rho, rhoN = this._rhoN, k = o.k, kn = o.kNear, rho0 = this.rho0;
    for (let p = 0; p < np; p++) {
      const i = P[p * 2], j = P[p * 2 + 1];
      const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz), q = r / h; if (q >= 1 || r < 1e-7) continue;
      const a = 1 - q;
      const Pi = k * (rho[i] - rho0) + k * (rho[j] - rho0), Pn = kn * (rhoN[i] + rhoN[j]);
      const D = dt2 * h * (Pi * a + Pn * a * a) * 0.25 / r;      // symmetric: each side gets half of the pair term
      x[i * 3] -= dx * D; x[i * 3 + 1] -= dy * D; x[i * 3 + 2] -= dz * D;
      x[j * 3] += dx * D; x[j * 3 + 1] += dy * D; x[j * 3 + 2] += dz * D;
    }
    // shape matching (glass ↔ slime): pull toward centroid + rest offset
    const w = this.rigid;
    if (w > 0) {
      const c = this.centroid(_c), R = this.rest;
      const f = w * w;                                           // eases: stays fluid-looking until nearly solid
      for (let i = 0; i < n; i++) {
        const j = i * 3;
        x[j] += (c.x + R[j] - x[j]) * f; x[j + 1] += (c.y + R[j + 1] - x[j + 1]) * f; x[j + 2] += (c.z + R[j + 2] - x[j + 2]) * f;
      }
    }
    // collisions: finger capsules (with adhesion), extra spheres, floor
    const skin = o.skin, band = o.band, adh = o.adhesion, fr = o.friction, sd = o.stickDrag, stuck = this.stuck;
    stuck.fill(0);
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      let px = x[j], py = x[j + 1], pz = x[j + 2];
      let vx = (px - xp[j]) / dt, vy = (py - xp[j + 1]) / dt, vz = (pz - xp[j + 2]) / dt;
      for (let ci = 0; ci < caps.length; ci++) {
        const C = caps[ci];
        const ex = C.bx - C.ax, ey = C.by - C.ay, ez = C.bz - C.az, ee = ex * ex + ey * ey + ez * ez;
        let t = ee > 1e-9 ? ((px - C.ax) * ex + (py - C.ay) * ey + (pz - C.az) * ez) / ee : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = C.ax + ex * t, qy = C.ay + ey * t, qz = C.az + ez * t;
        const rr = C.ra + (C.rb - C.ra) * t;
        let nx = px - qx, ny = py - qy, nz = pz - qz;
        const d = Math.sqrt(nx * nx + ny * ny + nz * nz); if (d < 1e-7) continue;
        const surf = rr + skin;
        if (d >= surf + band) continue;
        nx /= d; ny /= d; nz /= d;
        const hvx = C.vax + (C.vbx - C.vax) * t, hvy = C.vay + (C.vby - C.vay) * t, hvz = C.vaz + (C.vbz - C.vaz) * t;
        stuck[i] = 1;
        // where the hand would have CARRIED this particle this substep; the
        // tangential slip relative to that is what friction/adhesion removes —
        // POSITIONALLY (the spring/density passes move positions directly, so a
        // velocity-only friction would still let the slime slide off the skin)
        const cxp = xp[j] + hvx * dt, cyp = xp[j + 1] + hvy * dt, czp = xp[j + 2] + hvz * dt;
        let sx = px - cxp, sy = py - cyp, sz = pz - czp;
        const sn = sx * nx + sy * ny + sz * nz; sx -= sn * nx; sy -= sn * ny; sz -= sn * nz;   // tangential slip
        if (d < surf) {
          // CONTACT: never inside the finger — project to the skin, kill the
          // inward relative velocity, stick tangentially
          const pen = surf - d; px += nx * pen; py += ny * pen; pz += nz * pen;
          px -= sx * fr; py -= sy * fr; pz -= sz * fr;
          let rvx = vx - hvx, rvy = vy - hvy, rvz = vz - hvz;
          const vn = rvx * nx + rvy * ny + rvz * nz;
          if (vn < 0) { rvx -= vn * nx; rvy -= vn * ny; rvz -= vn * nz; }
          rvx *= (1 - fr); rvy *= (1 - fr); rvz *= (1 - fr);
          vx = hvx + rvx; vy = hvy + rvy; vz = hvz + rvz;
        } else {
          // ADHESION BAND: cling toward the skin (falls off across the band) and
          // be dragged with the hand — this is what lets it hang and stretch
          // sticky: pulled back onto the skin (a strong, saturating pull — it
          // behaves as pinned while the hand moves at slime speed), but a hand
          // that yanks away faster than the slime can follow leaves the band
          // and the slime lets go
          const u = Math.min(1, 2 * (1 - (d - surf) / band));   // 1 across the inner half … 0 at the band edge
          const pull = Math.min((d - surf) * adh, o.maxPull * this.spacing) * u;
          px -= nx * pull; py -= ny * pull; pz -= nz * pull;
          const c = sd * u;
          px -= sx * c; py -= sy * c; pz -= sz * c;
          vx += (hvx - vx) * c; vy += (hvy - vy) * c; vz += (hvz - vz) * c;
        }
      }
      if (spheres) for (const sp of spheres) {
        let nx = px - sp.p.x, ny = py - sp.p.y, nz = pz - sp.p.z;
        const d = Math.sqrt(nx * nx + ny * ny + nz * nz); if (d < 1e-7 || d >= sp.r) continue;
        nx /= d; ny /= d; nz /= d; const pen = sp.r - d; px += nx * pen; py += ny * pen; pz += nz * pen;
        const vn = vx * nx + vy * ny + vz * nz; if (vn < 0) { vx -= vn * nx; vy -= vn * ny; vz -= vn * nz; }
      }
      if (floorY !== null && py < floorY) { py = floorY; if (vy < 0) vy = 0; vx *= 0.6; vz *= 0.6; }
      x[j] = px; x[j + 1] = py; x[j + 2] = pz;
      xp[j] = px - vx * dt; xp[j + 1] = py - vy * dt; xp[j + 2] = pz - vz * dt;
    }
    // velocities from positions (Verlet)
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      v[j] = (x[j] - xp[j]) / dt; v[j + 1] = (x[j + 1] - xp[j + 1]) / dt; v[j + 2] = (x[j + 2] - xp[j + 2]) / dt;
    }
  }

  /** Live shape numbers off the cloud. */
  stats() {
    const n = this.n, x = this.x, v = this.v;
    if (!n) return null;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    let cx = 0, cy = 0, cz = 0, vmax = 0, stuck = 0, falling = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 3, px = x[j], py = x[j + 1], pz = x[j + 2];
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; if (pz < minz) minz = pz; if (pz > maxz) maxz = pz;
      cx += px; cy += py; cz += pz;
      const sp = Math.hypot(v[j], v[j + 1], v[j + 2]); if (sp > vmax) vmax = sp;
      if (this.stuck[i]) stuck++; else if (v[j + 1] < -0.25) falling++;
    }
    const vol = (4 / 3) * Math.PI * this.R ** 3;
    return { n, h: +this.h.toFixed(4), spacing: +this.spacing.toFixed(4), rigid: +this.rigid.toFixed(3),
             centroid: [cx / n, cy / n, cz / n].map(a => +a.toFixed(4)),
             bbox: [maxx - minx, maxy - miny, maxz - minz].map(a => +a.toFixed(4)),
             stretch: +((maxy - miny) / (2 * this.R)).toFixed(3), lowest: +miny.toFixed(4),
             volume_m3: +vol.toFixed(5), bonds: this.bonds, stuck, dripping: falling, maxSpeed: +vmax.toFixed(3) };
  }
}

/**
 * SlimeSurface — the cloud → a smooth mesh, every frame.
 * Metaballs on a marching-cubes grid that is re-fitted to the cloud's bounds
 * each frame (fine cells when compact, wider when stretched across two hands).
 */
export class SlimeSurface {
  /**
   * @param MarchingCubes  the three/addons class (injected so the sim stays testable in node)
   * @param material       the glass material
   * @param res            grid resolution (28 low · 36 medium · 44 high)
   */
  constructor(MarchingCubes, material, res = 36) {
    this.res = res;
    this.mc = new MarchingCubes(res, material, false, false, 120000);
    this.mc.isolation = 420;         // with the wide kernel: the surface sits ~12% beyond the outer particles (smooth, not lumpy)
    this.mc.frustumCulled = false;
    this.kernel = 2.8;             // metaball radius in particle SPACINGS (bigger = smoother, fatter)
    this.subtract = 12;
    this.H = 1; this.center = new THREE.Vector3();
    this.tris = 0;
  }
  setResolution(res) {
    if (res === this.res) return;
    const mat = this.mc.material; this.res = res;
    this.mc.init(res); this.mc.material = mat;
  }
  /** Rebuild the surface from the sim's cloud. */
  update(sim) {
    const mc = this.mc, x = sim.x, n = sim.n; if (!n) { mc.geometry.setDrawRange(0, 0); return; }
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = x[i * 3], py = x[i * 3 + 1], pz = x[i * 3 + 2];
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; if (pz < minz) minz = pz; if (pz > maxz) maxz = pz;
    }
    const rk = this.kernel * sim.spacing;
    // the grid never polygonizes its outer 2 cells, so pad by the kernel + 3 cells
    let H = Math.max(maxx - minx, maxy - miny, maxz - minz) * 0.5 + rk;
    H = H / (1 - 6 / this.res) + 1e-4;
    this.H = H; this.center.set((minx + maxx) * 0.5, (miny + maxy) * 0.5, (minz + maxz) * 0.5);
    mc.position.copy(this.center); mc.scale.setScalar(H);
    mc.reset();
    const inv = 1 / (2 * H), cx = this.center.x, cy = this.center.y, cz = this.center.z;
    const strength = this.subtract * (rk * inv) * (rk * inv);
    for (let i = 0; i < n; i++) {
      mc.addBall((x[i * 3] - cx) * inv + 0.5, (x[i * 3 + 1] - cy) * inv + 0.5, (x[i * 3 + 2] - cz) * inv + 0.5, strength, this.subtract);
    }
    mc.update();
    this.tris = mc.count / 3;
    mc.updateMatrixWorld(true);
  }
  /** Mesh volume (m³) by the divergence theorem over the live triangles. */
  volume() {
    const mc = this.mc, P = mc.positionArray, cnt = mc.count, H = this.H; let vol = 0;
    for (let t = 0; t < cnt; t += 3) {
      const a = t * 3, b = a + 3, c = a + 6;
      const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
      vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    return Math.abs(vol) / 6 * H * H * H;
  }
}
