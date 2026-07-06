/**
 * hopeOS SDK — Hand Forge
 * ═══════════════════════════════════════════════════════════════
 * Procedurally builds a smooth, full, realistic 3D hand mesh in
 * three.js — no external GLB download. The mesh is generated FROM
 * the 21-landmark rest skeleton itself, so the bind pose matches
 * tracking exactly (zero rig-fit misalignment by construction).
 *
 * Technique (the "well-solved" pipeline):
 *   1. Model the hand as a signed-distance field: tapered round
 *      capsules for each finger bone, a fused capsule slab for the
 *      palm/thenar/wrist, blended with polynomial smooth-min so
 *      knuckles, webbing and the palm merge into ONE organic
 *      surface (Inigo Quilez SDF modeling).
 *   2. Polygonize once with three's MarchingCubes addon.
 *   3. Weld vertices, Taubin-smooth (λ/μ — smooths without
 *      shrinking fingers), recompute normals.
 *   4. Bind: 2 bone influences per vertex from distance-to-bone-
 *      segment (NOT distance-to-landmark-point — this is what
 *      kills the old K-nearest "wrinkle/shimmer").
 *
 * Output plugs into HoloHandRig (hand-rig.js) or, positions-only,
 * into the legacy RiggedHand.
 *
 *   const { geometry, skin } = await forgeHand({ rest: REST_R42, style: 'smooth' });
 */

import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// ── Skeleton topology (MediaPipe 21-pt) ──
// 20 bones: 4 thumb + 4×(metacarpal + 3 phalanges).
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb (CMC→tip)
  [0, 5], [5, 6], [6, 7], [7, 8],          // index (metacarpal→tip)
  [0, 9], [9, 10], [10, 11], [11, 12],     // middle
  [0, 13], [13, 14], [14, 15], [15, 16],   // ring
  [0, 17], [17, 18], [18, 19], [19, 20],   // pinky
];

// Fingers as landmark chains (for SDF + roll references).
const FINGERS = [
  [1, 2, 3, 4],       // thumb
  [5, 6, 7, 8],       // index
  [9, 10, 11, 12],    // middle
  [13, 14, 15, 16],   // ring
  [17, 18, 19, 20],   // pinky
];

// Per-finger base radius as a fraction of hand span (wrist→middle-MCP),
// from hand anthropometry (finger Ø ≈ 0.14–0.18 of palm length).
const FINGER_R = [0.106, 0.092, 0.095, 0.088, 0.074];   // thumb..pinky
const TAPER = [1.0, 0.94, 0.87, 0.72];                   // radius factor along the chain

const STYLES = {
  smooth:   { res: 96, radius: 1.0,  blend: 1.0,  taubin: 4 },
  slim:     { res: 96, radius: 0.94, blend: 1.0, taubin: 4 },   // 0.94 is the thinnest that stays genus-0 (thinner reopens web tunnels)
  full:     { res: 88, radius: 1.12, blend: 1.2,  taubin: 3 },
  lowpoly:  { res: 44, radius: 1.0,  blend: 1.0,  taubin: 0 },
};

function smin(a, b, k) {
  // Polynomial smooth-min: organic blends between primitives.
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

/** Plain distance to segment AB minus lerped radius (used by the skinner). */
function sdSeg(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * t);
}

/**
 * Anatomical hand SDF from 21 rest landmarks.
 *
 * Realism comes from three things the naive capsule-hand lacked:
 *   1. ELLIPTICAL cross-sections — every primitive is flattened along the
 *      palm normal (real palms are slabs ~2× wider than thick, fingers
 *      slightly wider than deep). Implemented by scaling the palm-normal
 *      coordinate before measuring distance.
 *   2. Anatomy masses: palm slab + thenar (ball of thumb) + hypothenar
 *      pads on the PALMAR side, thin web membranes between finger bases,
 *      and a FLAT wrist cut (no more boxing-glove heel).
 *   3. Tight, per-pair blend radii — big k only where flesh actually
 *      fuses (palm), small k between fingers so they stay distinct.
 *
 * Returns f(x,y,z) → signed distance (negative inside), with per-primitive
 * AABB culling so high-res sampling stays fast.
 * (Exported for offline tooling/diagnostics.)
 */
export function buildSDF(lm, style = STYLES.smooth) {
  const w = lm[0];
  const span = Math.hypot(lm[9][0] - w[0], lm[9][1] - w[1], lm[9][2] - w[2]);   // hand scale unit
  const R = (r) => r * span * style.radius;
  const mid = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Palm frame. PALMAR side = toward the camera in the captured rest pose
  // (rest hands face the selfie camera, camera looks down −z).
  const yD = norm(sub(lm[9], w));
  let pn = norm(cross(sub(lm[5], w), sub(lm[17], w)));
  if (pn[2] > 0) pn = [-pn[0], -pn[1], -pn[2]];          // palmar: z < 0
  const palmar = pn;

  // ── Primitive soup: tapered capsules with per-prim frame + flatten ──
  // {a, b, ra, rb, flat (z-scale ≥1 → thinner along palm normal), group}
  const prims = [];
  const kMax = 0.13 * span * style.blend;
  function prim(a, b, ra, rb, flat, group) {
    const ax = a[0], ay = a[1], az = a[2];
    const abv = sub(b, a);
    const len = Math.hypot(abv[0], abv[1], abv[2]);
    const yb = len > 1e-9 ? [abv[0] / len, abv[1] / len, abv[2] / len] : [yD[0], yD[1], yD[2]];
    let zb = [palmar[0] - yb[0] * dot(palmar, yb), palmar[1] - yb[1] * dot(palmar, yb), palmar[2] - yb[2] * dot(palmar, yb)];
    const zl = Math.hypot(zb[0], zb[1], zb[2]);
    zb = zl > 1e-6 ? [zb[0] / zl, zb[1] / zl, zb[2] / zl] : cross(yb, [1, 0, 0]);
    const xb = cross(yb, zb);
    const rMax = Math.max(ra, rb);
    prims.push({
      ax, ay, az, len, ra, rb, flat, group,
      xx: xb[0], xy: xb[1], xz: xb[2],
      yx: yb[0], yy: yb[1], yz: yb[2],
      zx: zb[0], zy: zb[1], zz: zb[2],
      // AABB (expanded by radius + blend reach — beyond it the prim can't matter).
      // Must exceed the largest smooth-min reach (~3k) or the skip boundary
      // creates a hairline field discontinuity → pinholes in the surface.
      minx: Math.min(a[0], b[0]) - rMax - 4 * kMax, maxx: Math.max(a[0], b[0]) + rMax + 4 * kMax,
      miny: Math.min(a[1], b[1]) - rMax - 4 * kMax, maxy: Math.max(a[1], b[1]) + rMax + 4 * kMax,
      minz: Math.min(a[2], b[2]) - rMax - 4 * kMax, maxz: Math.max(a[2], b[2]) + rMax + 4 * kMax,
    });
  }
  const off = (p, dir, amt) => [p[0] + dir[0] * amt, p[1] + dir[1] * amt, p[2] + dir[2] * amt];

  // Rounded-triangle prism (IQ udTriangle − r): one smooth membrane sheet.
  function triPrim(a, b, c, r, group) {
    prims.push({
      type: 'tri', a, b, c, r, group,
      ba: sub(b, a), cb: sub(c, b), ac: sub(a, c),
      nor: cross(sub(b, a), sub(a, c)),
      minx: Math.min(a[0], b[0], c[0]) - r - 3 * kMax, maxx: Math.max(a[0], b[0], c[0]) + r + 3 * kMax,
      miny: Math.min(a[1], b[1], c[1]) - r - 3 * kMax, maxy: Math.max(a[1], b[1], c[1]) + r + 3 * kMax,
      minz: Math.min(a[2], b[2], c[2]) - r - 3 * kMax, maxz: Math.max(a[2], b[2], c[2]) + r + 3 * kMax,
    });
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  function triDist(P, px, py, pz) {
    const pa = [px - P.a[0], py - P.a[1], pz - P.a[2]];
    const pb = [px - P.b[0], py - P.b[1], pz - P.b[2]];
    const pc = [px - P.c[0], py - P.c[1], pz - P.c[2]];
    const sgn = (e, n, p) =>
      Math.sign((e[1] * n[2] - e[2] * n[1]) * p[0] + (e[2] * n[0] - e[0] * n[2]) * p[1] + (e[0] * n[1] - e[1] * n[0]) * p[2]);
    if (sgn(P.ba, P.nor, pa) + sgn(P.cb, P.nor, pb) + sgn(P.ac, P.nor, pc) < 2) {
      // outside the prism side walls → distance to nearest edge segment
      const edge = (e, p) => {
        const t = clamp01(dot(e, p) / dot(e, e));
        const dx = e[0] * t - p[0], dy = e[1] * t - p[1], dz = e[2] * t - p[2];
        return dx * dx + dy * dy + dz * dz;
      };
      return Math.sqrt(Math.min(edge(P.ba, pa), edge(P.cb, pb), edge(P.ac, pc)));
    }
    // above/below the face → distance to the plane
    const dn = dot(P.nor, pa);
    return Math.abs(dn) / Math.sqrt(dot(P.nor, P.nor));
  }

  // ── PALM SLAB (group 0): flat, wide, thin — metacarpal rays + bars ──
  const FLAT_PALM = 1.55;
  prim(w, lm[5],  R(0.105), R(0.098), FLAT_PALM, 0);
  prim(w, lm[9],  R(0.115), R(0.104), FLAT_PALM, 0);
  prim(w, lm[13], R(0.110), R(0.100), FLAT_PALM, 0);
  prim(w, lm[17], R(0.100), R(0.090), FLAT_PALM, 0);
  prim(lm[5], lm[9],   R(0.095), R(0.095), FLAT_PALM, 0);   // knuckle bar
  prim(lm[9], lm[13],  R(0.093), R(0.093), FLAT_PALM, 0);
  prim(lm[13], lm[17], R(0.090), R(0.085), FLAT_PALM, 0);
  prim(mid(w, lm[5], 0.5), mid(w, lm[17], 0.5), R(0.120), R(0.106), FLAT_PALM, 0);   // mid-palm
  prim(mid(w, lm[9], 0.35), mid(w, lm[9], 0.68), R(0.128), R(0.118), FLAT_PALM, 0);  // palm core
  // PALM PLATE: a solid triangular sheet spanning the whole palm. The
  // capsule grid above (rays + bars) can enclose small windows between
  // members — genuine topological tunnels that render as dark see-through
  // specks. One plate fills every window structurally (genus 0 by design).
  triPrim(w, lm[5], lm[17], R(0.070), 0);

  // ── PADS (group 0, palmar side): thenar (ball of thumb) + hypothenar ──
  // Centred ON the palm skeleton (no palmar offset): offset pads create
  // kissing tangent sheets with the slab → marching-cubes pinch points that
  // shade as dark specks. Bigger radii still read as pad masses.
  prim(mid(w, lm[1], 0.3), lm[2], R(0.108), R(0.085), 1.3, 0);
  prim(mid(w, lm[17], 0.18), mid(w, lm[17], 0.72), R(0.078), R(0.068), 1.45, 0);

  // ── FINGERS (groups 1–5): smooth elliptical columns, gentle taper ──
  // Big within-chain blend melts the segment junctions into one column —
  // small k left visible capsule lobes ("bamboo fingers", the v2 regression).
  const dorsal = [-palmar[0], -palmar[1], -palmar[2]];
  for (let f = 0; f < FINGERS.length; f++) {
    const chain = f === 0 ? [1, 2, 3, 4] : FINGERS[f];
    const base = R(FINGER_R[f]);
    const flat = f === 0 ? 1.08 : 1.12;                    // fingers a touch wider than deep
    for (let s = 0; s < chain.length - 1; s++) {
      const ra = base * TAPER[s];
      const rb = base * TAPER[s + 1] * (s === chain.length - 2 ? 0.9 : 1); // soft tip
      prim(lm[chain[s]], lm[chain[s + 1]], ra, rb, flat, 1 + f);
    }
    // Dorsal knuckle bumps at PIP/IP + DIP: small spheres proud of the
    // finger column so joints read in the silhouette (real knuckle relief).
    for (const s of f === 0 ? [1, 2] : [1, 2]) {
      const J = lm[chain[s]];
      const rj = base * TAPER[s];
      const c = off(J, dorsal, rj * 0.62);
      prim(c, c, rj * 0.66, rj * 0.66, 1.0, 1 + f);
    }
  }

  // ── WEBS (group 6): membranes between finger bases ──
  // Each web is a triangle sheet ROOTED IN THE PALM (a capsule floating
  // between two phalanges encloses a window against the knuckle bar — a
  // genuine topological tunnel; thickness must also stay ≥ ~3 voxels or
  // marching cubes shreds the sheet).
  const webTri = (ca, cb, t, r) => triPrim(
    mid(lm[ca[0]], lm[ca[1]], t),
    mid(lm[cb[0]], lm[cb[1]], t),
    mid(mid(w, lm[ca[0]], 0.85), mid(w, lm[cb[0]], 0.85), 0.5),   // rooted below the knuckle line
    r, 6
  );
  // Web thickness is NOT scaled by style.radius: slimmer fingers widen the
  // inter-finger gap, and a thinner sheet then reopens tunnels.
  const RW = (r) => r * span;
  webTri([5, 6], [9, 10], 0.20, RW(0.047));                // index–middle
  webTri([9, 10], [13, 14], 0.22, RW(0.047));              // middle–ring
  webTri([13, 14], [17, 18], 0.22, RW(0.044));             // ring–pinky

  // ── THUMB WEB: one SMOOTH triangle sheet, not ribs ──
  // Real first-web-space is a continuous wedge of flesh from the thumb's
  // proximal phalanx to the index base, rooted in the thenar. A fan of
  // capsule ribs reads as straight lines and crumples in motion (v4
  // regression); a rounded triangular prism deforms as one surface.
  // The root corner is buried DEEP in the mid-palm mass: a sheet whose
  // chord floats over the domed palm leaves a see-through lens gap — a
  // genuine topological tunnel (genus > 0) that renders as a dark slit.
  // Kept LOW and THIN: attached high up the thumb/index it stretches into a
  // visible hard-edged plate when the thumb abducts wide — the web should
  // read as a shallow curved valley, not an extra triangle of flesh.
  triPrim(
    mid(lm[2], lm[3], 0.32),                               // low on the thumb
    mid(lm[5], lm[6], 0.08),                               // at the index base
    mid(w, lm[9], 0.42),                                   // buried mid-palm root
    span * 0.044, 6                                         // thickness pinned (see webs)
  );

  // ── Blend radii per group pairing ──
  const kPalm = 0.115 * span * style.blend;   // palm fuses into one slab
  const kChain = 0.06 * span * style.blend;   // within a finger — one smooth column
  const kJoin = 0.05 * span * style.blend;    // finger → palm
  const kWeb = 0.035 * span * style.blend;    // webs melt onto both

  // Wrist cut plane: slightly below the wrist, smooth-intersected → flat end.
  const wristP = off(w, yD, -0.06 * span);
  const kCut = 0.05 * span;

  const NG = 7;   // groups: 0 palm, 1–5 fingers, 6 webs
  const gd = new Float64Array(NG);
  const skip = style.debugSkipGroups || null;   // diagnostics: exclude prim groups

  return function sdf(x, y, z) {
    for (let g = 0; g < NG; g++) gd[g] = 1e9;
    for (let i = 0; i < prims.length; i++) {
      const P = prims[i];
      if (skip && skip.includes(P.group)) continue;
      if (x < P.minx || x > P.maxx || y < P.miny || y > P.maxy || z < P.minz || z > P.maxz) continue;
      let d;
      if (P.type === 'tri') {
        d = triDist(P, x, y, z) - P.r;
      } else {
        const qx = x - P.ax, qy = y - P.ay, qz = z - P.az;
        // local frame coords (y along bone)
        const ly = qx * P.yx + qy * P.yy + qz * P.yz;
        const lx = qx * P.xx + qy * P.xy + qz * P.xz;
        const lz = (qx * P.zx + qy * P.zy + qz * P.zz) * P.flat;   // flatten
        let t = P.len > 1e-9 ? ly / P.len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dy = ly - t * P.len;
        d = Math.sqrt(lx * lx + dy * dy + lz * lz) - (P.ra + (P.rb - P.ra) * t);
      }
      const g = P.group;
      // within-group smooth union
      const k = g === 0 ? kPalm : g === 6 ? kWeb : kChain;
      gd[g] = smin(gd[g], d, k);
    }
    // compose: palm ∪ fingers (kJoin) ∪ webs (kWeb)
    let d = gd[0];
    for (let f = 1; f <= 5; f++) d = smin(d, gd[f], f === 1 ? kJoin * 1.9 : kJoin);
    d = smin(d, gd[6], kWeb * 3.2);   // webs melt smoothly — no crease fins, no lens gaps
    // flat wrist cut (smooth intersection with half-space above the cut plane)
    const cut = -((x - wristP[0]) * yD[0] + (y - wristP[1]) * yD[1] + (z - wristP[2]) * yD[2]);
    d = -smin(-d, -cut, kCut);
    return d;
  };
}

// ── Taubin smoothing (λ/μ) — smooths without shrinkage ──
function taubinSmooth(geometry, passes = 4, lambda = 0.5, mu = -0.53) {
  if (passes <= 0) return;
  const pos = geometry.getAttribute('position');
  const idx = geometry.index.array;
  const n = pos.count;
  const p = pos.array;
  // adjacency
  const nbr = new Array(n);
  for (let i = 0; i < n; i++) nbr[i] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
  }
  const tmp = new Float32Array(n * 3);
  const step = (f) => {
    for (let i = 0; i < n; i++) {
      const nb = nbr[i];
      if (!nb.length) { tmp[i * 3] = p[i * 3]; tmp[i * 3 + 1] = p[i * 3 + 1]; tmp[i * 3 + 2] = p[i * 3 + 2]; continue; }
      let ax = 0, ay = 0, az = 0;
      for (let j = 0; j < nb.length; j++) { const k = nb[j] * 3; ax += p[k]; ay += p[k + 1]; az += p[k + 2]; }
      const inv = 1 / nb.length, i3 = i * 3;
      tmp[i3] = p[i3] + f * (ax * inv - p[i3]);
      tmp[i3 + 1] = p[i3 + 1] + f * (ay * inv - p[i3 + 1]);
      tmp[i3 + 2] = p[i3 + 2] + f * (az * inv - p[i3 + 2]);
    }
    p.set(tmp);
  };
  for (let it = 0; it < passes; it++) { step(lambda); step(mu); }
  pos.needsUpdate = true;
}

/**
 * Bind vertices to bones: 3 influences from distance-to-bone-SEGMENT.
 * Three influences matter at the junction regions (thumb web, finger
 * bases): with two, a membrane binds to e.g. thumb + palm-ray only and
 * crumples into straight creases the moment the splay changes.
 * Works for ANY landmark skeleton — pass `bones` (defaults to the hand).
 * Returns { index: Uint8Array(vc*3), weight: Float32Array(vc*3), stride: 3 }.
 */
export function computeBoneWeights(geometry, lm, bones = HAND_BONES) {
  const pos = geometry.getAttribute('position');
  const vc = pos.count;
  const index = new Uint8Array(vc * 3);
  const weight = new Float32Array(vc * 3);
  const nb = bones.length;
  const segs = bones.map(([a, b]) => [lm[a][0], lm[a][1], lm[a][2], lm[b][0], lm[b][1], lm[b][2]]);

  for (let v = 0; v < vc; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    let b0 = 0, d0 = 1e9, b1 = 0, d1 = 1e9, b2 = 0, d2 = 1e9;
    for (let b = 0; b < nb; b++) {
      const s = segs[b];
      const d = sdSeg(x, y, z, s[0], s[1], s[2], s[3], s[4], s[5], 0, 0);
      if (d < d0) { b2 = b1; d2 = d1; b1 = b0; d1 = d0; b0 = b; d0 = d; }
      else if (d < d1) { b2 = b1; d2 = d1; b1 = b; d1 = d; }
      else if (d < d2) { b2 = b; d2 = d; }
    }
    // Inverse-distance² falloff; drop negligible influences (keeps the
    // mid-phalanx rigid while joints and webs blend smoothly).
    let w0 = 1 / (d0 * d0 + 1e-8), w1 = 1 / (d1 * d1 + 1e-8), w2 = 1 / (d2 * d2 + 1e-8);
    let s = w0 + w1 + w2;
    if (w2 / s < 0.08) { w2 = 0; s = w0 + w1; }
    if (w1 / s < 0.08) { w1 = 0; s = w0 + w2; }
    index[v * 3] = b0; index[v * 3 + 1] = b1; index[v * 3 + 2] = b2;
    weight[v * 3] = w0 / s; weight[v * 3 + 1] = w1 / s; weight[v * 3 + 2] = w2 / s;
  }
  return { index, weight, stride: 3 };
}

/**
 * Per-vertex DETAIL MASKS for the ghost shader, packed into an 'aDetail'
 * vec3 attribute: x = nail plate, y = palmar crease lines, z = knuckle
 * emphasis. All are derived from the landmark skeleton in rest space, so
 * they ride along with skinning for free and cost nothing per frame.
 * This is what makes the ghost read as a volumetric x-ray of a real hand
 * instead of a flat blue cut-out.
 */
export function computeDetailAttribute(geometry, lmIn) {
  const lm = lmIn.slice(0, 21).map(p => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const vc = pos.count;
  const det = new Float32Array(vc * 3);

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  const w = lm[0];
  const span = Math.hypot(lm[9][0] - w[0], lm[9][1] - w[1], lm[9][2] - w[2]);
  let pn = norm(cross(sub(lm[5], w), sub(lm[17], w)));
  if (pn[2] > 0) pn = [-pn[0], -pn[1], -pn[2]];            // palmar: z < 0 (rest faces camera)
  const palmar = pn;
  const dorsal = [-pn[0], -pn[1], -pn[2]];

  // ── nail frames: per finger, on the dorsal side of the distal phalanx ──
  const nails = FINGERS.map((chain, f) => {
    const D = lm[chain[chain.length - 2]], T = lm[chain[chain.length - 1]];
    const dir = norm(sub(T, D));
    const side = norm(cross(dir, dorsal));
    const dorF = norm(cross(side, dir));                   // finger-local dorsal
    return { T, dir, side, dorF, rF: FINGER_R[f] * span, nailLen: Math.hypot(...sub(T, D)) * 0.55 };
  });

  // ── palmar crease polylines (heart / head / life lines) ──
  const CREASES = [
    [lerp(w, lm[17], 0.80), lerp(w, lm[13], 0.78), lerp(w, lm[9], 0.74), lerp(w, lm[5], 0.66)],
    [lerp(w, lm[17], 0.52), lerp(w, lm[13], 0.53), lerp(w, lm[9], 0.52), lerp(w, lm[5], 0.44)],
    [lerp(w, lm[5], 0.50), lerp(lerp(w, lm[9], 0.30), lm[1], 0.42), lerp(w, lm[1], 0.25)],
  ];
  const sigma = 0.022 * span;

  // ── knuckle centres (dorsal emphasis): MCP row + PIP/DIP + thumb.
  // r0 = expected skin offset from the joint centre — the falloff measures
  // distance from the SKIN SHELL, not the joint, or the mask never reaches
  // the surface.
  const KNUCKS = [];
  for (const j of [5, 9, 13, 17]) KNUCKS.push({ c: lm[j], r0: 0.10 * span, s: 0.075 * span });
  for (const chain of FINGERS) for (const idx of [1, 2]) {
    KNUCKS.push({ c: lm[chain[idx]], r0: 0.075 * span, s: 0.055 * span });
  }

  const p = [0, 0, 0], n = [0, 0, 0];
  for (let v = 0; v < vc; v++) {
    p[0] = pos.getX(v); p[1] = pos.getY(v); p[2] = pos.getZ(v);
    n[0] = nrm.getX(v); n[1] = nrm.getY(v); n[2] = nrm.getZ(v);

    // nails
    let nail = 0;
    for (const N of nails) {
      const q = sub(p, N.T);
      const u = dot(q, N.dir);
      if (u < -N.nailLen * 1.5 || u > N.rF) continue;
      const lat = Math.abs(dot(q, N.side));
      const dor = dot(q, N.dorF);
      const m =
        ss(-N.nailLen * 1.15, -N.nailLen * 0.7, u) * (1 - ss(N.rF * 0.15, N.rF * 0.6, u)) *
        (1 - ss(N.rF * 0.5, N.rF * 0.78, lat)) *
        ss(N.rF * 0.05, N.rF * 0.38, dor) *
        ss(0.1, 0.5, dot(n, N.dorF));
      if (m > nail) nail = m;
    }

    // palmar crease lines (distance measured IN the palm plane — the
    // polylines live on the skeleton mid-plane, the skin sits ~half a
    // thickness above it)
    let crease = 0;
    const palmGate = ss(0.12, 0.45, dot(n, palmar));
    if (palmGate > 0) {
      for (const line of CREASES) {
        for (let s = 0; s < line.length - 1; s++) {
          const a = line[s], b = line[s + 1];
          const ab = sub(b, a), ap = sub(p, a);
          let t = dot(ap, ab) / (dot(ab, ab) || 1);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dv = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
          const dpal = dot(dv, palmar);
          const dx = dv[0] - palmar[0] * dpal, dy = dv[1] - palmar[1] * dpal, dz = dv[2] - palmar[2] * dpal;
          const d2 = dx * dx + dy * dy + dz * dz;
          const m = Math.exp(-d2 / (sigma * sigma)) * palmGate;
          if (m > crease) crease = m;
        }
      }
    }

    // knuckle emphasis (dorsal only)
    let knk = 0;
    const dorGate = ss(0.0, 0.4, dot(n, dorsal));
    if (dorGate > 0) {
      for (const K of KNUCKS) {
        const dx = p[0] - K.c[0], dy = p[1] - K.c[1], dz = p[2] - K.c[2];
        const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - K.r0);
        const m = Math.exp(-(d * d) / (K.s * K.s)) * dorGate;
        if (m > knk) knk = m;
      }
    }

    det[v * 3] = nail; det[v * 3 + 1] = crease; det[v * 3 + 2] = knk;
  }
  geometry.setAttribute('aDetail', new THREE.BufferAttribute(det, 3));
  return geometry;
}

/**
 * Polygonize ANY signed-distance field into a welded, cleaned, smoothed
 * BufferGeometry — the shared back half of the forge pipeline (hand AND
 * body forges use this exact implementation).
 *
 * @param {Function} sdf        f(x,y,z) → signed distance (negative inside)
 * @param {Object}   o          { min:[3], max:[3], margin, res, taubin, label }
 */
export function polygonizeSDF(sdf, { min, max, margin = 0, res = 96, taubin = 4, label = 'forge' } = {}) {
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + margin * 2;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  const half = size / 2;

  // Fill the MC field: value = −distance (positive inside), isosurface at 0.
  const mc = new MarchingCubes(res, new THREE.MeshBasicMaterial(), false, false, 500000);
  mc.isolation = 0;
  const field = mc.field, halfRes = res / 2;
  for (let z = 0; z < res; z++) {
    const wz = cz + ((z - halfRes) / halfRes) * half;
    const zo = res * res * z;
    for (let y = 0; y < res; y++) {
      const wy = cy + ((y - halfRes) / halfRes) * half;
      const yo = zo + res * y;
      for (let x = 0; x < res; x++) {
        const wx = cx + ((x - halfRes) / halfRes) * half;
        field[yo + x] = -sdf(wx, wy, wz);
      }
    }
  }
  mc.update();

  // Extract the valid triangle soup, map [-1,1] → rest space, weld, smooth.
  const count = mc.count;
  if (!count) throw new Error(`[${label}] marching cubes produced no surface`);
  const posArr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    posArr[i * 3]     = cx + mc.positionArray[i * 3] * half;
    posArr[i * 3 + 1] = cy + mc.positionArray[i * 3 + 1] * half;
    posArr[i * 3 + 2] = cz + mc.positionArray[i * 3 + 2] * half;
  }
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo = BufferGeometryUtils.mergeVertices(geo, size * 1e-4);
  // Marching cubes emits duplicate/degenerate triangles at exact grid
  // crossings; after welding they become non-manifold shading pinch-points
  // (dark dots on the palm). Drop them.
  {
    const idx = geo.index.array;
    const seen = new Set();
    const clean = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (a === b || b === c || c === a) continue;
      const key = Math.min(a, b, c) + '_' + (a + b + c - Math.min(a, b, c) - Math.max(a, b, c)) + '_' + Math.max(a, b, c);
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(a, b, c);
    }
    geo.setIndex(clean);
  }
  taubinSmooth(geo, taubin);
  geo.computeVertexNormals();
  mc.geometry.dispose();
  return geo;
}

/**
 * Forge a hand mesh from 21 rest landmarks (array of [x,y,z]).
 * Pass REST_R42/REST_L42 (first 21 rows used) — chirality comes from
 * the landmarks themselves, so left/right both Just Work.
 *
 * @returns { geometry, skin: {index, weight}, stats }
 */
export function forgeHand({ rest, style = 'smooth' } = {}) {
  const t0 = performance.now();
  // style: name string, or an object of overrides on 'smooth' (diagnostics)
  const st = typeof style === 'object' ? { ...STYLES.smooth, ...style } : (STYLES[style] || STYLES.smooth);
  const lm = rest.slice(0, 21).map(p => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const sdf = buildSDF(lm, st);

  // Cubic sample volume around the hand (uniform axes keep MC mapping exact).
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of lm) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  const span = Math.hypot(lm[9][0] - lm[0][0], lm[9][1] - lm[0][1], lm[9][2] - lm[0][2]);
  const margin = 0.30 * span * Math.max(1, st.radius);
  const geo = polygonizeSDF(sdf, { min, max, margin, res: st.res, taubin: st.taubin, label: 'hand-forge' });

  computeDetailAttribute(geo, lm);   // nails / creases / knuckles for the shader
  const skin = computeBoneWeights(geo, lm);
  const stats = { verts: geo.getAttribute('position').count, tris: geo.index.count / 3, ms: Math.round(performance.now() - t0), style: typeof style === 'object' ? 'custom' : style };
  return { geometry: geo, skin, stats };
}

/**
 * Rig ANY external hand geometry (e.g. a scraped/downloaded GLB) to the
 * rest skeleton: recenters + uniformly scales the geometry onto the rest
 * landmark bounds (assumes an open, fingers-up hand pose roughly aligned),
 * then computes segment-distance bone weights. Best-effort fit — meant for
 * experimenting with alternative base models in the lab.
 */
export function rigExternalGeometry(geometry, rest, { fit = true } = {}) {
  const lm = rest.slice(0, 21).map(p => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const geo = geometry.index ? geometry.clone() : BufferGeometryUtils.mergeVertices(geometry.clone(), 1e-5);
  if (fit) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (const p of lm) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
    const srcSize = new THREE.Vector3(); bb.getSize(srcSize);
    const srcMax = Math.max(srcSize.x, srcSize.y, srcSize.z) || 1;
    const dstMax = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const s = dstMax / srcMax;
    const srcC = new THREE.Vector3(); bb.getCenter(srcC);
    geo.translate(-srcC.x, -srcC.y, -srcC.z);
    geo.scale(s, s, s);
    geo.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const skin = computeBoneWeights(geo, lm);
  return { geometry: geo, skin };
}
