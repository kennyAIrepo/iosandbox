/**
 * hopeOS SDK — Lip Contour Alignment (human lip EDGE → creature lip EDGE)
 * ═══════════════════════════════════════════════════════════════
 * Runtime, engine-side, no Blender round-trip. Given a skinned muzzle whose
 * auto-rig smears the jaw / upper-lip weights across the whole snout, it:
 *
 *   1. FINDS THE LIP LINE in bind space: per angle bin around the jaw pivot,
 *      the height where upper-lip and jaw influence cross 50/50 — on a
 *      proximity-weighted auto-rig that crossing sits on the mouth crease.
 *   2. SHARPENS the skin weights on both sides of that line (upper bones
 *      above, jaw chain below, a 1–2 cm blend), so the jaw HINGES at the
 *      mouth instead of bending a soft blob — the RuntimeJawRig idea.
 *   3. PARAMETRIZES the lip edge: every vertex near the line gets
 *      u ∈ [−1, 1] (0 = snout tip, ±1 = the corners), a side (upper /
 *      lower), a tangent along the mouth line toward its corner, its
 *      outward normal, and a falloff weight.
 *   4. ALIGNS per frame: the user's outer-lip contour (20 landmarks) is
 *      parametrized the same way (0 = lip centre, ±1 = corners); each fox
 *      lip vertex samples the human delta at its u and moves ALONG THE
 *      FOX'S OWN MOUTH LINE: human "toward the corner" → fox toward its
 *      corner (backward along the muzzle), human up/down → up/down, pucker
 *      → out along the normal, strongest at the tip. That is the basis
 *      change a long muzzle needs: a human mouth line runs sideways, a
 *      fox's runs front-to-back.
 *
 * Offsets are written into the bind-space POSITION attribute (before
 * skinning), so they ride the jaw and head bones for free.
 */

import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// MediaPipe outer-lip contour, subject-RIGHT corner (61) → subject-LEFT corner (291)
export const LIP_UPPER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291];
export const LIP_LOWER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291];

export class LipSeam {
  /**
   * @param {THREE.SkinnedMesh} mesh
   * @param {object} o  { upperBones: string[], lowerBones: string[], upperFill: string, lowerFill: string,
   *                      pivot: THREE.Vector3 (model frame, behind the mouth), bonePos: name → Vector3 (model frame) }
   */
  constructor(mesh, o) {
    this.mesh = mesh; this.o = o;
    const g = mesh.geometry;
    this.pos = g.getAttribute('position'); this.nrm = g.getAttribute('normal');
    this.orig = this.pos.array.slice();
    const bones = mesh.skeleton.bones.map(b => b.name);
    const bi = n => bones.indexOf(n);
    this.upperIdx = new Set(o.upperBones.map(bi).filter(i => i >= 0));
    this.lowerIdx = new Set(o.lowerBones.map(bi).filter(i => i >= 0));
    this.upperFill = bi(o.upperFill); this.lowerFill = bi(o.lowerFill);
    this.stats = this._build();
  }

  _build() {
    const g = this.mesh.geometry, si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    const P = this.orig, N = this.nrm.array, n = this.pos.count, piv = this.o.pivot;
    const UL = v => { let u = 0, l = 0; for (let k = 0; k < 4; k++) { const j = si.getComponent(v, k), w = sw.getComponent(v, k); if (this.upperIdx.has(j)) u += w; else if (this.lowerIdx.has(j)) l += w; } return [u, l]; };
    // ── zone: any mouth-bone influence, in front of the pivot ──
    const zone = [];
    for (let v = 0; v < n; v++) { const [u, l] = UL(v); if (u + l > 0.08 && P[v * 3 + 2] > piv.z + 0.03) zone.push(v); }
    const th = v => Math.atan2(P[v * 3] - piv.x, P[v * 3 + 2] - piv.z);
    // seam band (near 50/50) → angular range + tip angle (front-most band vertex)
    let thMin = Infinity, thMax = -Infinity, tipV = -1, tipZ = -Infinity;
    for (const v of zone) { const [u, l] = UL(v); if (Math.abs(u - l) < 0.35 && u + l > 0.3) { const t = th(v); thMin = Math.min(thMin, t); thMax = Math.max(thMax, t); if (P[v * 3 + 2] > tipZ) { tipZ = P[v * 3 + 2]; tipV = v; } } }
    if (tipV < 0) return { ok: false };
    const thTip = th(tipV);
    // ── lip line height per angle bin: weighted mean y of the 50/50 vertices ──
    const B = 28, ys = new Float64Array(B), ws = new Float64Array(B);
    const bin = t => clamp(Math.floor((t - thMin) / (thMax - thMin + 1e-9) * B), 0, B - 1);
    for (const v of zone) { const [u, l] = UL(v); const w = Math.max(0, 0.35 - Math.abs(u - l)) * (u + l); if (w > 0) { const b = bin(th(v)); ys[b] += P[v * 3 + 1] * w; ws[b] += w; } }
    const line = new Float64Array(B); let last = null;
    for (let b = 0; b < B; b++) { if (ws[b] > 1e-6) { line[b] = ys[b] / ws[b]; last = line[b]; } else line[b] = last ?? NaN; }
    for (let b = B - 1; b >= 0; b--) if (Number.isNaN(line[b])) line[b] = line[b + 1];
    for (let pass = 0; pass < 2; pass++) for (let b = 1; b < B - 1; b++) line[b] = (line[b - 1] + 2 * line[b] + line[b + 1]) / 4;   // smooth
    const lipY = t => { const x = clamp((t - thMin) / (thMax - thMin + 1e-9) * B - 0.5, 0, B - 1); const b = Math.floor(x), f = x - b; return line[b] * (1 - f) + line[Math.min(B - 1, b + 1)] * f; };
    // ── sharpen: hinge at the line ──
    const bandHalf = 0.012;
    let sharpened = 0;
    for (const v of zone) {
      const t = th(v); if (t < thMin - 0.05 || t > thMax + 0.05) continue;
      const f = smoothstep(lipY(t) - bandHalf, lipY(t) + bandHalf, P[v * 3 + 1]);   // 1 = upper
      let U = 0, L = 0, minK = 0, minW = Infinity;
      for (let k = 0; k < 4; k++) { const j = si.getComponent(v, k), w = sw.getComponent(v, k); if (this.upperIdx.has(j)) U += w; else if (this.lowerIdx.has(j)) L += w; if (w < minW) { minW = w; minK = k; } }
      const tot = U + L; if (tot < 0.05) continue;
      const tU = tot * f, tL = tot * (1 - f);
      const w4 = [0, 1, 2, 3].map(k => sw.getComponent(v, k)), j4 = [0, 1, 2, 3].map(k => si.getComponent(v, k));
      for (let k = 0; k < 4; k++) { if (this.upperIdx.has(j4[k])) w4[k] = U > 1e-6 ? w4[k] * tU / U : 0; else if (this.lowerIdx.has(j4[k])) w4[k] = L > 1e-6 ? w4[k] * tL / L : 0; }
      if (U < 1e-6 && tU > 0.01) { j4[minK] = this.upperFill; w4[minK] = tU; }        // no upper influence yet → the fill bone
      else if (L < 1e-6 && tL > 0.01) { j4[minK] = this.lowerFill; w4[minK] = tL; }
      const s = w4.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < 4; k++) { si.setComponent(v, k, j4[k]); sw.setComponent(v, k, w4[k] / s); }
      sharpened++;
    }
    si.needsUpdate = true; sw.needsUpdate = true;
    // ── lip-edge vertices: u, side, tangent-to-corner, normal, falloff ──
    const edge = [];
    for (const v of zone) {
      const t = th(v); if (t < thMin || t > thMax) continue;
      const dy = P[v * 3 + 1] - lipY(t), ad = Math.abs(dy);
      if (ad > 0.13) continue;
      // (cavity walls ride along too: the pout direction is radial, so the mouth
      // bag moves coherently with the outer lips instead of being left behind)
      const w = ad < 0.03 ? 1 : 1 - smoothstep(0.03, 0.13, ad);
      const span = t >= thTip ? (thMax - thTip) : (thTip - thMin);
      const u = clamp((t - thTip) / Math.max(1e-6, span), -1, 1);
      const rx = P[v * 3] - piv.x, rz = P[v * 3 + 2] - piv.z, rl = Math.hypot(rx, rz) || 1;
      const sgn = u >= 0 ? 1 : -1;                                   // toward this vertex's corner
      // pout direction = radial from the pivot, horizontal: the same for every
      // duplicate of a UV-seam vertex (their normals differ and would tear the nose)
      edge.push({ v, u, dy, upper: dy >= 0, w, tx: sgn * rz / rl, tz: -sgn * rx / rl, nx: rx / rl, ny: 0, nz: rz / rl });
    }
    return { ok: true, zone: zone.length, sharpened, edge: edge.length, thMin, thMax, thTip, line: Array.from(line), edgeList: edge };
  }

  /**
   * Per-frame alignment.
   * @param {(u:number, upper:boolean) => [along, up]} sample  human contour delta at |u| (face units):
   *        along = toward the corner (+), up = +
   * @param {number} K        scale: face units → model units (creature face width × gain)
   * @param {number} pout     0..1 protrusion (pucker / funnel)
   * @param {number} poutAmt  model units of pout at the tip
   */
  apply(sample, K, pout = 0, poutAmt = 0) {
    if (!this.stats.ok) return;
    const A = this.pos.array, O = this.orig;
    for (const e of this.stats.edgeList) {
      const [along, up] = sample(e.u, e.upper);
      const p = pout * poutAmt * (1 - Math.abs(e.u)) * (1 - Math.abs(e.u));
      const ox = (e.tx * along * K + e.nx * p) * e.w, oy = (up * K + e.ny * p) * e.w, oz = (e.tz * along * K + e.nz * p) * e.w;
      const i = e.v * 3;
      A[i] = O[i] + ox; A[i + 1] = O[i + 1] + oy; A[i + 2] = O[i + 2] + oz;
    }
    this.pos.needsUpdate = true;
  }

  reset() { this.pos.array.set(this.orig); this.pos.needsUpdate = true; }
}

/** Parametrize the human outer-lip contour by its NEUTRAL positions: u = (x − centre) / half-width. */
export function lipContourParams(neutral, local) {           // neutral: idx → [x,y] face-frame
  const cR = neutral[61], cL = neutral[291];
  const cx = (cR[0] + cL[0]) / 2, hw = Math.max(1e-4, Math.abs(cL[0] - cR[0]) / 2);
  const side = arr => arr.map(i => ({ i, u: clamp((neutral[i][0] - cx) / hw, -1, 1) }));
  return { upper: side(LIP_UPPER), lower: side(LIP_LOWER), cx, hw };
}
