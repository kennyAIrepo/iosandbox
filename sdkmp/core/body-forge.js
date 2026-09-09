/**
 * hopeOS SDK — Body Forge
 * ═══════════════════════════════════════════════════════════════
 * Procedurally builds a smooth, realistic FULL-BODY mesh in three.js
 * from the MediaPipe 33-landmark pose skeleton — the exact recipe
 * that made the holo hands work, scaled up:
 *
 *   1. Canonical REST_BODY skeleton (A-pose, metres, feet on y=0):
 *      the 33 BlazePose points + 4 synthetic trunk joints (hip-mid,
 *      chest, head-centre, head-top) = 37 landmarks. The mesh is
 *      generated FROM this skeleton, so the bind pose matches
 *      tracking exactly — zero rig-fit misalignment by construction.
 *      (This is also why we forge instead of fitting a rigged GLB:
 *      a downloaded model brings its own proportions, rest pose and
 *      bone names, and every mismatch becomes wobble/misalignment.
 *      A GLB path stays open via rigExternalGeometry-style fitting.)
 *   2. Anatomical SDF: flattened tapered capsules for limbs, fused
 *      slab masses for pelvis/torso/chest, deltoid + glute pads,
 *      neck, head + face ellipsoid — polynomial smooth-min blends,
 *      so shoulders, hips and neck merge into ONE organic surface.
 *   3. Shared polygonize pipeline (hand-forge.polygonizeSDF):
 *      MarchingCubes → weld → dedupe → Taubin smooth.
 *   4. Bind: 3 bone influences per vertex from distance-to-bone-
 *      segment (hand-forge.computeBoneWeights, generic bone list).
 *
 * Output plugs into HoloBodyRig (body-rig.js).
 *
 *   const { geometry, skin, stats } = forgeBody({ style: 'standard' });
 */

import { polygonizeSDF, computeBoneWeights } from './hand-forge.js';

// ── MediaPipe pose landmark ids (33) + synthetic trunk joints ──
// 0 nose · 1-3 L eye(inner/c/outer) · 4-6 R eye · 7/8 ears · 9/10 mouth
// 11/12 shoulders · 13/14 elbows · 15/16 wrists · 17/18 pinky · 19/20 index
// 21/22 thumb · 23/24 hips · 25/26 knees · 27/28 ankles · 29/30 heels ·
// 31/32 foot_index — then synthetics:
export const HIP_MID = 33, CHEST = 34, HEAD_C = 35, HEAD_TOP = 36;

/**
 * Canonical rest skeleton — A-pose, metres, y-up, feet at y = 0,
 * FACING the viewer (+z is toward the camera, like the mirrored feed:
 * the person's physical RIGHT side sits at +x, exactly what the
 * selfie-mirrored tracking emits — same convention story as REST_R42).
 * lm11 = person's LEFT shoulder → −x side.
 */
export const REST_BODY = (() => {
  const P = new Array(37);
  const M = (i, x, y, z) => { P[i] = [x, y, z]; };
  // face
  M(0, 0, 1.620, 0.105);                      // nose
  M(1, -0.022, 1.652, 0.085); M(2, -0.036, 1.653, 0.080); M(3, -0.051, 1.652, 0.072);
  M(4, 0.022, 1.652, 0.085);  M(5, 0.036, 1.653, 0.080);  M(6, 0.051, 1.652, 0.072);
  M(7, -0.076, 1.628, 0.018); M(8, 0.076, 1.628, 0.018);  // ears
  M(9, -0.020, 1.578, 0.088); M(10, 0.020, 1.578, 0.088); // mouth corners
  // torso
  M(11, -0.200, 1.420, 0); M(12, 0.200, 1.420, 0);        // shoulders
  M(23, -0.115, 0.950, 0); M(24, 0.115, 0.950, 0);        // hips
  // arms (A-pose: down + slightly out)
  M(13, -0.295, 1.140, 0.010); M(14, 0.295, 1.140, 0.010);   // elbows
  M(15, -0.355, 0.880, 0.025); M(16, 0.355, 0.880, 0.025);   // wrists
  M(17, -0.392, 0.788, 0.022); M(18, 0.392, 0.788, 0.022);   // pinky MCP
  M(19, -0.372, 0.780, 0.052); M(20, 0.372, 0.780, 0.052);   // index MCP
  M(21, -0.338, 0.808, 0.055); M(22, 0.338, 0.808, 0.055);   // thumb
  // legs
  M(25, -0.130, 0.520, 0.012); M(26, 0.130, 0.520, 0.012);   // knees
  M(27, -0.142, 0.092, -0.012); M(28, 0.142, 0.092, -0.012); // ankles
  M(29, -0.148, 0.048, -0.062); M(30, 0.148, 0.048, -0.062); // heels
  M(31, -0.146, 0.022, 0.118); M(32, 0.146, 0.022, 0.118);   // toes
  // synthetic trunk joints — MUST be the exact extendPose() formulas, or
  // the rig's bind pose and a live rest pose disagree (identity deviation)
  const tmp = P.slice(0, 33).map(p => ({ x: p[0], y: p[1], z: p[2] }));
  extendPose(tmp);
  for (let i = 33; i < 37; i++) P[i] = [tmp[i].x, tmp[i].y, tmp[i].z];
  return P;
})();

/**
 * 19 bones over the 37-point skeleton (parent-first order matters for
 * the FK retarget in body-rig.js). Trunk first, then limbs.
 */
export const BODY_BONES = [
  [HIP_MID, CHEST],      // 0 trunk core
  [CHEST, HEAD_C],       // 1 neck
  [HEAD_C, HEAD_TOP],    // 2 head
  [CHEST, 11],           // 3 clavicle L
  [CHEST, 12],           // 4 clavicle R
  [11, 13],              // 5 upper arm L
  [12, 14],              // 6 upper arm R
  [13, 15],              // 7 forearm L
  [14, 16],              // 8 forearm R
  [15, 19],              // 9 hand paddle L (wrist → index MCP)
  [16, 20],              // 10 hand paddle R
  [HIP_MID, 23],         // 11 pelvis wing L
  [HIP_MID, 24],         // 12 pelvis wing R
  [23, 25],              // 13 thigh L
  [24, 26],              // 14 thigh R
  [25, 27],              // 15 shin L
  [26, 28],              // 16 shin R
  [27, 31],              // 17 foot L (ankle → toes)
  [28, 32],              // 18 foot R
];

// Per-landmark collider radii (metres) — physics + game interaction.
// Indexed like the 37-point skeleton.
export const BODY_RADII = (() => {
  const r = new Float32Array(37).fill(0.05);
  r[0] = 0.09;                                    // head via nose
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) r[i] = 0.07;
  r[11] = r[12] = 0.075;                          // shoulders
  r[13] = r[14] = 0.052;                          // elbows
  r[15] = r[16] = 0.042;                          // wrists
  for (const i of [17, 18, 19, 20, 21, 22]) r[i] = 0.035;
  r[23] = r[24] = 0.10;                           // hips
  r[25] = r[26] = 0.062;                          // knees
  r[27] = r[28] = 0.046;                          // ankles
  for (const i of [29, 30, 31, 32]) r[i] = 0.042; // feet
  r[HIP_MID] = 0.135; r[CHEST] = 0.135;           // trunk masses
  r[HEAD_C] = 0.105; r[HEAD_TOP] = 0.09;
  return r;
})();

const STYLES = {
  // res 152 + taubin 6: the silhouette look draws a bright contour line
  // right on the mesh edge, so faceting reads as "jagged linework" — the
  // extra resolution + smoothing passes are what make the outline clean.
  standard: { res: 152, radius: 1.0, blend: 1.0, taubin: 6 },
  lite:     { res: 100, radius: 1.0, blend: 1.0, taubin: 4 },
};

function smin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

/**
 * Anatomical body SDF from the 37-point rest skeleton. Same idioms as
 * the hand: ELLIPTICAL cross-sections (torso is a slab ~1.35× wider
 * than deep, limbs slightly), pad masses (deltoids, glutes, calves,
 * chest), tight per-pair blends, AABB culling per primitive.
 */
export function buildBodySDF(lm, style = STYLES.standard) {
  const H = lm[CHEST][1] - lm[HIP_MID][1];          // trunk height ≈ 0.47 — scale unit
  const R = (r) => r * style.radius;
  const mid = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const off = (p, d) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];

  // Body frame: forward = +z (faces the viewer in rest space)
  const FWD = [0, 0, 1];
  const prims = [];
  const kMax = 0.28 * H * style.blend;

  /** Tapered capsule, flattened along `flatDir` by factor `flat` (≥1 = thinner). */
  function prim(a, b, ra, rb, flat, group, flatDir = FWD) {
    const abv = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(abv[0], abv[1], abv[2]);
    const yb = len > 1e-9 ? [abv[0] / len, abv[1] / len, abv[2] / len] : [0, 1, 0];
    let zb = [
      flatDir[0] - yb[0] * (flatDir[0] * yb[0] + flatDir[1] * yb[1] + flatDir[2] * yb[2]),
      flatDir[1] - yb[1] * (flatDir[0] * yb[0] + flatDir[1] * yb[1] + flatDir[2] * yb[2]),
      flatDir[2] - yb[2] * (flatDir[0] * yb[0] + flatDir[1] * yb[1] + flatDir[2] * yb[2]),
    ];
    const zl = Math.hypot(zb[0], zb[1], zb[2]);
    zb = zl > 1e-6 ? [zb[0] / zl, zb[1] / zl, zb[2] / zl] : [1, 0, 0];
    const xb = [yb[1] * zb[2] - yb[2] * zb[1], yb[2] * zb[0] - yb[0] * zb[2], yb[0] * zb[1] - yb[1] * zb[0]];
    const rMax = Math.max(ra, rb);
    prims.push({
      ax: a[0], ay: a[1], az: a[2], len, ra, rb, flat, group,
      xx: xb[0], xy: xb[1], xz: xb[2],
      yx: yb[0], yy: yb[1], yz: yb[2],
      zx: zb[0], zy: zb[1], zz: zb[2],
      minx: Math.min(a[0], b[0]) - rMax - 3 * kMax, maxx: Math.max(a[0], b[0]) + rMax + 3 * kMax,
      miny: Math.min(a[1], b[1]) - rMax - 3 * kMax, maxy: Math.max(a[1], b[1]) + rMax + 3 * kMax,
      minz: Math.min(a[2], b[2]) - rMax - 3 * kMax, maxz: Math.max(a[2], b[2]) + rMax + 3 * kMax,
    });
  }

  // Groups: 0 trunk/head · 1 arm L · 2 arm R · 3 leg L · 4 leg R
  const FLAT_T = 1.35;   // torso slab: wider than deep

  // ── PELVIS + TORSO (group 0) — natural proportions, not superhero:
  // reference is a plain standing human silhouette (slim taper, hips
  // narrower than shoulders, no exaggerated chest V) ──
  prim(lm[23], lm[24], R(0.215 * H), R(0.215 * H), FLAT_T, 0);                       // pelvis bar
  prim(mid(lm[23], lm[24], 0.5), mid(lm[11], lm[12], 0.5), R(0.235 * H), R(0.215 * H), 1.42, 0);  // trunk core (waist taper via smaller mid prim below)
  prim(off(mid(lm[23], lm[24], 0.5), [0, 0.16 * H, 0.01]), off(mid(lm[11], lm[12], 0.5), [0, -0.30 * H, 0.012]), R(0.20 * H), R(0.195 * H), 1.5, 0);  // waist
  prim(off(lm[11], [0.02, -0.06 * H, 0.012]), off(lm[12], [-0.02, -0.06 * H, 0.012]), R(0.185 * H), R(0.185 * H), 1.55, 0);  // chest plate
  prim(lm[11], lm[12], R(0.145 * H), R(0.145 * H), 1.35, 0);                          // shoulder bar
  // glutes (behind pelvis)
  prim(off(lm[23], [0.01, -0.02, -0.055]), off(lm[24], [-0.01, -0.02, -0.055]), R(0.15 * H), R(0.15 * H), 1.1, 0);
  // deltoid caps
  prim(lm[11], lm[11], R(0.135 * H), R(0.135 * H), 1.05, 0);
  prim(lm[12], lm[12], R(0.135 * H), R(0.135 * H), 1.05, 0);

  // ── NECK + HEAD (group 0) ──
  prim(mid(lm[11], lm[12], 0.5), off(lm[HEAD_C], [0, -0.05, 0.005]), R(0.115 * H), R(0.105 * H), 1.1, 0);
  prim(lm[HEAD_C], off(lm[HEAD_TOP], [0, -0.055, 0]), R(0.225 * H), R(0.195 * H), 1.08, 0);   // cranium
  prim(off(lm[HEAD_C], [0, -0.015, 0.045]), off(lm[HEAD_C], [0, -0.075, 0.052]), R(0.155 * H), R(0.115 * H), 1.15, 0);  // face/jaw wedge
  prim(off(lm[0], [0, -0.006, -0.035]), off(lm[0], [0, -0.006, -0.035]), R(0.075 * H), R(0.075 * H), 1.0, 0);           // nose mound

  // ── ARMS (groups 1/2): shoulder → elbow → wrist stub ──
  // The hand itself is NOT sculpted here: real forged hand meshes (the
  // same forge the interactive hands use) attach at the wrist in the rig,
  // frame-mapped to the hand-paddle bone. Individual fingers are thinner
  // than the body voxel grid (~1 voxel — they'd shred; hand-forge lesson:
  // nothing under ~3 voxels), so the mitt is gone and the arm just ends
  // in a clean stub the hand mesh overlaps.
  for (const [S, E, W, PK, IX, g] of [[11, 13, 15, 17, 19, 1], [12, 14, 16, 18, 20, 2]]) {
    prim(lm[S], lm[E], R(0.105 * H), R(0.085 * H), 1.06, g);                          // upper arm
    prim(lm[E], lm[W], R(0.08 * H), R(0.062 * H), 1.06, g);                           // forearm
    prim(lm[W], mid(lm[W], mid(lm[PK], lm[IX], 0.5), 0.35), R(0.058 * H), R(0.052 * H), 1.25, g);  // wrist stub
  }

  // ── LEGS (groups 3/4): hip → knee → ankle → foot ──
  for (const [Hp, K, A, HE, T, g] of [[23, 25, 27, 29, 31, 3], [24, 26, 28, 30, 32, 4]]) {
    prim(lm[Hp], lm[K], R(0.165 * H), R(0.115 * H), 1.05, g);                         // thigh
    prim(lm[K], lm[A], R(0.105 * H), R(0.07 * H), 1.0, g);                            // shin
    prim(mid(lm[K], lm[A], 0.28), mid(lm[K], lm[A], 0.55), R(0.115 * H), R(0.098 * H), 1.0, g);  // calf bulge
    // FOOT — a real wedge, not a nub: heel block → instep ramp → wide
    // ball pad → toe cap slightly past the toe landmark. All chunky
    // (≥3 voxels) so nothing shreds at body grid resolution.
    prim(lm[A], lm[HE], R(0.078 * H), R(0.072 * H), 1.0, g);                          // heel block
    prim(lm[HE], mid(lm[HE], lm[T], 1.08), R(0.082 * H), R(0.058 * H), 1.6, g, [0, 1, 0]);  // sole wedge (flat, tapers to toe)
    prim(mid(lm[A], mid(lm[HE], lm[T], 0.45), 0.35), mid(lm[HE], lm[T], 0.5), R(0.075 * H), R(0.068 * H), 1.3, g, [0, 1, 0]);  // instep ramp
    prim(mid(lm[HE], lm[T], 0.68), mid(lm[HE], lm[T], 0.92), R(0.072 * H), R(0.062 * H), 1.45, g, [0, 1, 0]);  // ball of the foot (widest)
    prim(mid(lm[HE], lm[T], 0.96), mid(lm[HE], lm[T], 1.12), R(0.055 * H), R(0.042 * H), 1.5, g, [0, 1, 0]);   // toe cap
  }

  // Blend radii
  const kTrunk = 0.16 * H * style.blend;    // trunk masses fuse into one body
  const kChain = 0.085 * H * style.blend;   // within a limb
  const kJoin = 0.065 * H * style.blend;    // limb → trunk (tight: no waist-to-forearm webbing)

  const NG = 5;
  const gd = new Float64Array(NG);

  function groupDist(x, y, z, out) {
    for (let g = 0; g < NG; g++) out[g] = 1e9;
    for (let i = 0; i < prims.length; i++) {
      const P = prims[i];
      if (x < P.minx || x > P.maxx || y < P.miny || y > P.maxy || z < P.minz || z > P.maxz) continue;
      const qx = x - P.ax, qy = y - P.ay, qz = z - P.az;
      const ly = qx * P.yx + qy * P.yy + qz * P.yz;
      const lx = qx * P.xx + qy * P.xy + qz * P.xz;
      const lz = (qx * P.zx + qy * P.zy + qz * P.zz) * P.flat;
      let t = P.len > 1e-9 ? ly / P.len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dy = ly - t * P.len;
      const d = Math.sqrt(lx * lx + dy * dy + lz * lz) - (P.ra + (P.rb - P.ra) * t);
      const g = P.group;
      out[g] = smin(out[g], d, g === 0 ? kTrunk : kChain);
    }
    return out;
  }

  const sdf = function (x, y, z) {
    groupDist(x, y, z, gd);
    let d = gd[0];
    for (let g = 1; g < NG; g++) d = smin(d, gd[g], kJoin);
    return d;
  };
  sdf.groups = groupDist;   // per-part distances — drives skin-weight region masking
  return sdf;
}

// Which SDF group each BODY_BONES entry animates (0 trunk/head · 1 arm L ·
// 2 arm R · 3 leg L · 4 leg R) — must match buildBodySDF's prim groups.
const BONE_GROUP = [0, 0, 0, 0, 0, 1, 2, 1, 2, 1, 2, 0, 0, 3, 4, 3, 4, 3, 4];

// Per-bone capture radius (metres) for radius-normalized weight
// competition: thick trunk bones out-pull thin limb bones passing close.
const BONE_CAPTURE_R = new Float32Array([
  0.14,          // 0 trunk core
  0.09,          // 1 neck
  0.11,          // 2 head
  0.09, 0.09,    // 3/4 clavicles
  0.065, 0.065,  // 5/6 upper arms
  0.05, 0.05,    // 7/8 forearms
  0.045, 0.045,  // 9/10 hand paddles
  0.12, 0.12,    // 11/12 pelvis wings
  0.085, 0.085,  // 13/14 thighs
  0.06, 0.06,    // 15/16 shins
  0.05, 0.05,    // 17/18 feet
]);

/**
 * Forge the body mesh from a rest skeleton (defaults to REST_BODY).
 * @returns { geometry, skin: {index, weight}, stats }
 */
export function forgeBody({ rest = REST_BODY, style = 'standard' } = {}) {
  const t0 = performance.now();
  const st = typeof style === 'object' ? { ...STYLES.standard, ...style } : (STYLES[style] || STYLES.standard);
  const lm = rest.map(p => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const sdf = buildBodySDF(lm, st);

  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of lm) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  const H = lm[CHEST][1] - lm[HIP_MID][1];
  const geo = polygonizeSDF(sdf, { min, max, margin: 0.45 * H, res: st.res, taubin: st.taubin, label: 'body-forge' });

  // Region mask from the SDF's own part groups: each vertex may only bind
  // to bones of the part(s) whose surface it actually belongs to. A waist
  // vertex is trunk-only even though the A-pose forearm passes 15cm away;
  // only the true junction bands (|gd_a − gd_b| < margin: deltoid, armpit,
  // hip crease) blend across parts.
  const pos = geo.getAttribute('position');
  const vc = pos.count;
  const allow = new Uint32Array(vc);
  const gdV = new Float64Array(5);
  const JOIN_MARGIN = 0.13 * H;   // ≈ 6cm — the anatomical blend band
  for (let v = 0; v < vc; v++) {
    sdf.groups(pos.getX(v), pos.getY(v), pos.getZ(v), gdV);
    let g0 = 0;
    for (let g = 1; g < 5; g++) if (gdV[g] < gdV[g0]) g0 = g;
    let mask = 0;
    for (let b = 0; b < BODY_BONES.length; b++) {
      if (gdV[BONE_GROUP[b]] < gdV[g0] + JOIN_MARGIN) mask |= (1 << b);
    }
    allow[v] = mask;
  }
  const skin = computeBoneWeights(geo, lm, BODY_BONES, { radii: BONE_CAPTURE_R, allow });
  const stats = {
    verts: geo.getAttribute('position').count,
    tris: geo.index.count / 3,
    ms: Math.round(performance.now() - t0),
    style: typeof style === 'object' ? 'custom' : style,
  };
  return { geometry: geo, skin, stats };
}

/** Extend a 33-point pose to the 37-point rig skeleton (in place-ish:
 *  returns the same array with synthetics appended/updated). Works on
 *  {x,y,z} objects or THREE.Vector3 — anything with x/y/z fields the
 *  caller can mutate. `make` creates a point when the slot is empty. */
export function extendPose(pts, make = () => ({ x: 0, y: 0, z: 0 })) {
  const set = (i, x, y, z) => {
    if (!pts[i]) pts[i] = make();
    pts[i].x = x; pts[i].y = y; pts[i].z = z;
  };
  const L = pts;
  set(HIP_MID, (L[23].x + L[24].x) / 2, (L[23].y + L[24].y) / 2, (L[23].z + L[24].z) / 2);
  set(CHEST, (L[11].x + L[12].x) / 2, (L[11].y + L[12].y) / 2, (L[11].z + L[12].z) / 2);
  const ecx = (L[7].x + L[8].x) / 2, ecy = (L[7].y + L[8].y) / 2, ecz = (L[7].z + L[8].z) / 2;
  set(HEAD_C, ecx, ecy, ecz);
  // head-top = head centre pushed away from the chest along the neck axis
  let ux = ecx - L[CHEST].x, uy = ecy - L[CHEST].y, uz = ecz - L[CHEST].z;
  const ul = Math.hypot(ux, uy, uz) || 1;
  const headLen = ul * 0.85;
  set(HEAD_TOP, ecx + (ux / ul) * headLen, ecy + (uy / ul) * headLen, ecz + (uz / ul) * headLen);
  return pts;
}
