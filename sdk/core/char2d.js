/**
 * hopeOS SDK — Char2D  (2D skeletal character rig — Live2D / Kalidokit class)
 * ═══════════════════════════════════════════════════════════════════════
 * A hand-drawn 2D character (Shakti) rigged to the SAME 37-point MediaPipe
 * pose skeleton as the 3D body (REST_BODY / BODY_BONES) — so it drops into
 * the identical `pose(landmarks)` stream the shadow-silhouette body uses.
 *
 * The problem this solves (the reason we DON'T use rigid cut-out quads):
 *   Rigid per-bone sprites tear at the joints — gaps open on the outside of
 *   a bend, sprites overlap on the inside ("morph bleeding"), and the elbow
 *   reads as a hinge, not an arm. Live2D / Spine / Kalidokit all solve it the
 *   same way and so do we:
 *
 *   • MESH DEFORMATION, not sprite swapping. Each part is ONE continuous
 *     triangle mesh (a grid clipped to the painted silhouette) skinned across
 *     ALL of its bones with SMOOTH weights. Near the elbow BOTH the upper-arm
 *     and forearm bones have weight, so linear-blend skinning bends the arm as
 *     a smooth curve — no hinge, no gap. Same LBS the hand/body rigs use, in 2D.
 *   • REGION MASKING kills cross-part bleed. A torso vertex is only ever
 *     skinned to torso bones (trunk/clavicle/pelvis), never to an arm bone —
 *     so raising the arm cannot drag torso pixels. Each part lists exactly the
 *     bones it may bind to.
 *   • DEPTH LAYERS keep overlaps clean. Parts are independent layers with a
 *     fixed render order (cape behind → legs → torso → arms → head), so a
 *     raised arm crossing the torso resolves by depth, never by bridging
 *     triangles. Art is painted with overlap margins so joints tuck under
 *     their neighbour and never gap.
 *   • BIND = TRACKING by construction. The art is painted in the REST_BODY
 *     A-pose coordinate frame (metres, y-up), so the bind pose is the rest
 *     skeleton exactly — zero rig-fit misalignment, the hopeOS invariant.
 *
 *   const char = new Char2D(scene).build();
 *   char.pose(landmarks37);   // per frame — Vector3[] in scene space (or {x,y})
 *   char.tick(elapsedSec);    // idle breathing / cape sway when not tracking
 */

import * as THREE from 'three';
import { REST_BODY, BODY_BONES, HIP_MID, CHEST, HEAD_C, HEAD_TOP, extendPose } from './body-forge.js';

// ── palette ─────────────────────────────────────────────────────────────
const C = {
  skin:      '#c98a5e', skinHi: '#e6b489', skinLo: '#9c6440', skinLine: '#7c4d30',
  hair:      '#2b1e18', hairHi: '#6a4630', hairLo: '#170f0b',
  kurta:     '#ab3f68', kurtaHi: '#cf6892', kurtaLo: '#7c2a49', trim: '#8f2b3a',
  cape:      '#2f8f6d', capeHi: '#57b892', capeLo: '#1c6349', capeGold: '#d8b24a',
  pants:     '#6c4a30', pantsHi: '#8a6544', pantsLo: '#48301e',
  eye:       '#37b3c6', eyeDk: '#1c6f7d', gold: '#d9b24a', white: '#f4ecdf',
  brow:      '#241812', mouth: '#8f4a44', shadow: 'rgba(10,8,14,0.28)',
};

// Rest landmarks as flat {x,y} for drawing in metre space (y up).
const L = REST_BODY.map(p => ({ x: p[0], y: p[1] }));

// ── geometry helpers ─────────────────────────────────────────────────────
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Per-bone capture radius (metres) — how far a bone's influence reaches.
// Thick trunk/head, thin limbs. Wider = softer blend at that joint.
const CAP_R = [
  0.20,        // 0 trunk core
  0.11,        // 1 neck
  0.15,        // 2 head
  0.15, 0.15,  // 3/4 clavicles
  0.10, 0.10,  // 5/6 upper arms
  0.095, 0.095,// 7/8 forearms
  0.075, 0.075,// 9/10 hands
  0.15, 0.15,  // 11/12 pelvis wings
  0.12, 0.12,  // 13/14 thighs
  0.10, 0.10,  // 15/16 shins
  0.09, 0.09,  // 17/18 feet
];

/**
 * Part table. Each part is an independent skinned layer.
 *   bbox   [x0,y0,x1,y1] rest-metre bounds of the painted art (with overlap)
 *   bones  the ONLY BODY_BONES ids this part's verts may skin to (region mask)
 *   z      depth layer (higher = in front); also the flat plane z
 *   draw   paints the art in metre space (ctx pre-transformed, y-up)
 *   res    grid cells across the LONGER bbox axis (mesh density)
 * Order = paint/build order; render order follows z.
 */
const PARTS = [
  { name: 'cape',  bbox: [-0.34, 0.30, 0.30, 1.52], bones: [0, 1, 3, 4, 11, 12], z: -0.06, res: 40, draw: drawCape },
  { name: 'legR',  bbox: [ 0.02, 0.00, 0.26, 0.98], bones: [12, 14, 16, 18],     z: -0.02, res: 40, draw: c => drawLeg(c, +1) },
  { name: 'legL',  bbox: [-0.26, 0.00, 0.02, 0.98], bones: [11, 13, 15, 17],     z: -0.02, res: 40, draw: c => drawLeg(c, -1) },
  { name: 'torso', bbox: [-0.30, 0.72, 0.30, 1.56], bones: [0, 1, 3, 4, 11, 12], z:  0.00, res: 44, draw: drawTorso },
  { name: 'armL',  bbox: [-0.46, 0.62, -0.14, 1.50], bones: [3, 5, 7, 9],        z:  0.02, res: 40, draw: c => drawArm(c, -1) },
  { name: 'head',  bbox: [-0.20, 1.44, 0.20, 1.86], bones: [1, 2],               z:  0.03, res: 40, draw: drawHead },
  { name: 'armR',  bbox: [ 0.14, 1.35, 0.52, 2.06], bones: [4, 6, 8, 10],        z:  0.05, res: 40, draw: c => drawArm(c, +1) },
];

// ═══════════════════════════════════════════════════════════════════════
export class Char2D {
  constructor(scene, opts = {}) {
    this.ppm = opts.ppm ?? 1024;               // texture pixels per metre
    this.grp = new THREE.Group();
    this.grp.visible = false;
    if (scene) scene.add(this.grp);
    this.parts = [];
    this._sEma = 0;
    this._restShoulder = Math.hypot(L[12].x - L[11].x, L[12].y - L[11].y);

    // precompute constant rest bone frames (A0, along u0, perp n0, length L0)
    this._rf = BODY_BONES.map(([i, j]) => {
      const a = L[i], b = L[j];
      let ux = b.x - a.x, uy = b.y - a.y;
      const l = Math.hypot(ux, uy) || 1e-6; ux /= l; uy /= l;
      return { ax: a.x, ay: a.y, ux, uy, nx: -uy, ny: ux, len: l };
    });
    this._lf = this._rf.map(() => ({}));       // live frames, filled per pose()

    // idle pose = A-pose with the right arm raised (matches the reference)
    this.displayPose = buildDisplayPose();
  }

  build() {
    for (const spec of PARTS) this.parts.push(this._buildPart(spec));
    this.pose(this.displayPose);               // land on the reference pose
    return this;
  }

  _buildPart(spec) {
    const [x0, y0, x1, y1] = spec.bbox;
    const bw = x1 - x0, bh = y1 - y0;
    const long = Math.max(bw, bh);
    const cw = Math.round(bw * this.ppm), ch = Math.round(bh * this.ppm);

    // paint art in metre space (y-up)
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.save();
    ctx.translate(0, ch);
    ctx.scale(this.ppm, -this.ppm);
    ctx.translate(-x0, -y0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    spec.draw(ctx);
    ctx.restore();

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;

    // alpha for clipping the mesh to the silhouette
    const img = ctx.getImageData(0, 0, cw, ch).data;
    const alphaAt = (u, v) => {
      const px = Math.min(cw - 1, Math.max(0, (u * cw) | 0));
      const py = Math.min(ch - 1, Math.max(0, ((1 - v) * ch) | 0));
      return img[(py * cw + px) * 4 + 3];
    };

    // build a grid over the bbox, keep only cells that touch painted pixels
    const nx = Math.max(2, Math.round((bw / long) * spec.res));
    const ny = Math.max(2, Math.round((bh / long) * spec.res));
    const gx = nx + 1, gy = ny + 1;
    const idOf = new Int32Array(gx * gy).fill(-1);
    const rest = [];   // packed x,y metre
    const uvs = [];
    const push = (ix, iy) => {
      const k = iy * gx + ix;
      if (idOf[k] >= 0) return idOf[k];
      const u = ix / nx, v = iy / ny;
      const id = rest.length / 2;
      idOf[k] = id;
      rest.push(x0 + u * bw, y0 + v * bh);
      uvs.push(u, v);
      return id;
    };
    const tris = [];
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const u0 = ix / nx, v0 = iy / ny, u1 = (ix + 1) / nx, v1 = (iy + 1) / ny;
        // keep the cell if any corner (or its centre) is painted
        const covered =
          alphaAt(u0, v0) > 8 || alphaAt(u1, v0) > 8 ||
          alphaAt(u0, v1) > 8 || alphaAt(u1, v1) > 8 ||
          alphaAt((u0 + u1) / 2, (v0 + v1) / 2) > 8;
        if (!covered) continue;
        const a = push(ix, iy), b = push(ix + 1, iy), c = push(ix, iy + 1), d = push(ix + 1, iy + 1);
        tris.push(a, c, b, b, c, d);
      }
    }

    // skin each vertex to this part's allowed bones (smooth 2D weights)
    const nv = rest.length / 2;
    const skinIdx = new Int32Array(nv * 3);
    const skinWt = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const px = rest[v * 2], py = rest[v * 2 + 1];
      const cand = [];
      for (const b of spec.bones) {
        const [i, j] = BODY_BONES[b];
        const d = distSeg(px, py, L[i].x, L[i].y, L[j].x, L[j].y);
        const sig = CAP_R[b] * 0.7;
        const w = Math.exp(-(d * d) / (2 * sig * sig));
        if (w > 1e-4) cand.push([w, b]);
      }
      cand.sort((a, b) => b[0] - a[0]);
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        if (k < cand.length) { skinIdx[v * 3 + k] = cand[k][1]; skinWt[v * 3 + k] = cand[k][0]; sum += cand[k][0]; }
        else { skinIdx[v * 3 + k] = cand.length ? cand[0][1] : spec.bones[0]; skinWt[v * 3 + k] = 0; }
      }
      if (sum > 0) for (let k = 0; k < 3; k++) skinWt[v * 3 + k] /= sum;
      else skinWt[v * 3] = 1;   // orphan → pin to first bone
    }

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) { pos[v * 3] = rest[v * 2]; pos[v * 3 + 1] = rest[v * 2 + 1]; pos[v * 3 + 2] = spec.z; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(tris);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.02,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = Math.round((spec.z + 1) * 100);
    this.grp.add(mesh);

    return { spec, mesh, geo, rest: new Float32Array(rest), skinIdx, skinWt, nv, z: spec.z };
  }

  /** Drive the whole character from 37 scene-space points (Vector3 or {x,y}). */
  pose(lm) {
    if (!lm || !this.parts.length) { this.grp.visible = false; return; }
    // global body scale from the shoulder span (EMA — no per-frame jitter)
    const sRaw = Math.hypot(lm[12].x - lm[11].x, lm[12].y - lm[11].y) / this._restShoulder || 1;
    this._sEma = this._sEma > 0 ? this._sEma + (sRaw - this._sEma) * 0.25 : sRaw;
    const gs = Math.max(0.2, Math.min(6, this._sEma));

    // live bone frames: land endpoints exactly (stretch along bone), uniform
    // body scale across — the 2D analogue of the hand/body rig's _boneBasis
    for (let b = 0; b < BODY_BONES.length; b++) {
      const [i, j] = BODY_BONES[b], rf = this._rf[b], lf = this._lf[b];
      const ax = lm[i].x, ay = lm[i].y;
      let ux = lm[j].x - ax, uy = lm[j].y - ay;
      const l = Math.hypot(ux, uy) || 1e-6; ux /= l; uy /= l;
      const sA = l / rf.len;
      lf.ax = ax; lf.ay = ay;
      lf.ux = ux * sA; lf.uy = uy * sA;   // along-bone axis (stretched)
      lf.nx = -uy * gs; lf.ny = ux * gs;  // perpendicular axis (uniform scale)
    }

    // LBS every part
    for (const part of this.parts) {
      const p = part.geo.getAttribute('position').array;
      const rest = part.rest, si = part.skinIdx, sw = part.skinWt, rf = this._rf, lf = this._lf;
      for (let v = 0; v < part.nv; v++) {
        const px = rest[v * 2], py = rest[v * 2 + 1];
        let ox = 0, oy = 0;
        for (let k = 0; k < 3; k++) {
          const w = sw[v * 3 + k]; if (w === 0) continue;
          const b = si[v * 3 + k], r = rf[b], f = lf[b];
          const a = (px - r.ax) * r.ux + (py - r.ay) * r.uy;   // local along
          const n = (px - r.ax) * r.nx + (py - r.ay) * r.ny;   // local perp
          ox += w * (f.ax + a * f.ux + n * f.nx);
          oy += w * (f.ay + a * f.uy + n * f.ny);
        }
        p[v * 3] = ox; p[v * 3 + 1] = oy;   // z stays the layer value
      }
      part.geo.getAttribute('position').needsUpdate = true;
    }
    this.grp.visible = true;
  }

  /** Idle animation when not tracking: breathing + gentle cape/arm sway. */
  tick(t) {
    const pose = this.displayPose.map(p => ({ x: p.x, y: p.y, z: p.z }));
    const breathe = Math.sin(t * 1.6) * 0.006;
    const sway = Math.sin(t * 0.8) * 0.012;
    for (const i of [11, 12, CHEST, 0, 1, 2, 3, 4, 5, 6]) { pose[i].y += breathe; }
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { pose[i].x += sway; }   // upper body drift
    // raised right-arm hand wave
    const wave = Math.sin(t * 1.1) * 0.02;
    for (const i of [14, 16, 18, 20, 22]) { pose[i].x += wave; }
    extendPose(pose, () => ({ x: 0, y: 0, z: 0 }));
    this.pose(pose);
  }

  dispose() {
    for (const part of this.parts) { part.geo.dispose(); part.mesh.material.map?.dispose(); part.mesh.material.dispose(); }
    this.grp.removeFromParent();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Display pose — REST_BODY A-pose with the person's RIGHT arm (+x) raised
// high and open, matching the reference panel. Returns 37 {x,y,z} points.
function buildDisplayPose() {
  const p = REST_BODY.map(q => ({ x: q[0], y: q[1], z: q[2] }));
  const set = (i, x, y) => { p[i].x = x; p[i].y = y; };
  // raised right arm — up and slightly out, hand open at the top
  set(14, 0.33, 1.63); set(16, 0.40, 1.90);
  set(18, 0.44, 1.99); set(20, 0.40, 2.01); set(22, 0.33, 1.98);
  // left arm eased a touch inward / relaxed along the body
  set(13, -0.27, 1.15); set(15, -0.30, 0.90);
  set(17, -0.33, 0.81); set(19, -0.31, 0.80); set(21, -0.28, 0.83);
  // slight contrapposto
  set(23, -0.115, 0.955); set(24, 0.115, 0.945);
  extendPose(p, () => ({ x: 0, y: 0, z: 0 }));
  return p;
}

// ═══════════════════════════════════════════════════════════════════════
// ART — painted in metre space (y-up). Each fn draws one part; the mesh is
// clipped to whatever is opaque here. Overlap margins let joints tuck under.
// ───────────────────────────────────────────────────────────────────────
function lg(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}
function rg(ctx, x, y, r, stops) {
  const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}
/** rounded tapered limb tube from a→b, half-widths ra→rb */
function tube(ctx, ax, ay, bx, by, ra, rb, fill, line, lw) {
  let dx = bx - ax, dy = by - ay; const l = Math.hypot(dx, dy) || 1e-6; dx /= l; dy /= l;
  const nx = -dy, ny = dx;
  ctx.beginPath();
  ctx.moveTo(ax + nx * ra, ay + ny * ra);
  ctx.lineTo(bx + nx * rb, by + ny * rb);
  ctx.arc(bx, by, rb, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
  ctx.lineTo(ax - nx * ra, ay - ny * ra);
  ctx.arc(ax, ay, ra, Math.atan2(-ny, -nx), Math.atan2(ny, nx), false);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (line) { ctx.strokeStyle = line; ctx.lineWidth = lw ?? 0.006; ctx.stroke(); }
}

function drawTorso(ctx) {
  const sL = L[11], sR = L[12], hL = L[23], hR = L[24];
  const chestY = 1.42, hipY = 0.95;
  // kurta body — shoulders down past the hips, gentle waist, flared hem
  ctx.beginPath();
  ctx.moveTo(sL.x - 0.03, chestY + 0.02);
  ctx.bezierCurveTo(sL.x - 0.08, 1.30, -0.175, 1.16, -0.16, 1.02);   // left side + waist
  ctx.bezierCurveTo(-0.20, 0.86, -0.235, 0.78, -0.225, 0.70);        // flare to hem
  ctx.lineTo(0.225, 0.70);
  ctx.bezierCurveTo(0.235, 0.78, 0.20, 0.86, 0.16, 1.02);
  ctx.bezierCurveTo(0.175, 1.16, sR.x + 0.08, 1.30, sR.x + 0.03, chestY + 0.02);
  ctx.bezierCurveTo(0.10, 1.47, -0.10, 1.47, sL.x - 0.03, chestY + 0.02);
  ctx.closePath();
  ctx.fillStyle = lg(ctx, -0.2, 1.5, 0.2, 0.7, [[0, C.kurtaHi], [0.5, C.kurta], [1, C.kurtaLo]]);
  ctx.fill();
  // form shading — centre light, side shadow
  ctx.fillStyle = rg(ctx, -0.02, 1.15, 0.34, [[0, 'rgba(255,220,235,0.28)'], [0.6, 'rgba(255,220,235,0)'], [1, 'rgba(255,220,235,0)']]);
  ctx.fill();
  ctx.save(); ctx.clip();
  ctx.fillStyle = 'rgba(90,20,50,0.35)';
  ctx.fillRect(0.10, 0.68, 0.20, 0.9);        // right side shadow band
  ctx.fillRect(-0.30, 0.68, 0.09, 0.9);       // left rim shadow
  // soft vertical fold lines
  ctx.strokeStyle = 'rgba(120,30,66,0.30)'; ctx.lineWidth = 0.007;
  for (const fx of [-0.09, 0.02, 0.11]) { ctx.beginPath(); ctx.moveTo(fx, 1.28); ctx.lineTo(fx + 0.01, 0.74); ctx.stroke(); }
  ctx.restore();
  // neckline + red trim
  ctx.strokeStyle = C.trim; ctx.lineWidth = 0.014;
  ctx.beginPath(); ctx.moveTo(-0.075, 1.44); ctx.quadraticCurveTo(0, 1.37, 0.075, 1.44); ctx.stroke();
  // hem trim
  ctx.lineWidth = 0.016; ctx.strokeStyle = C.trim;
  ctx.beginPath(); ctx.moveTo(-0.225, 0.705); ctx.lineTo(0.225, 0.705); ctx.stroke();
  ctx.strokeStyle = C.gold; ctx.lineWidth = 0.006;
  ctx.beginPath(); ctx.moveTo(-0.225, 0.715); ctx.lineTo(0.225, 0.715); ctx.stroke();
  // short sleeve caps (kurta covers the shoulder onto the upper arm)
  for (const s of [sL, sR]) {
    ctx.beginPath(); ctx.ellipse(s.x, 1.40, 0.085, 0.11, 0, 0, Math.PI * 2);
    ctx.fillStyle = lg(ctx, s.x - 0.08, 1.5, s.x + 0.08, 1.28, [[0, C.kurtaHi], [1, C.kurtaLo]]); ctx.fill();
  }
}

function drawArm(ctx, side) {
  // side +1 = person's right (raised), -1 = person's left (down)
  const S = side > 0 ? L[12] : L[11];
  const E = side > 0 ? { x: 0.33, y: 1.63 } : { x: -0.27, y: 1.15 };
  const W = side > 0 ? { x: 0.40, y: 1.90 } : { x: -0.30, y: 0.90 };
  // sleeve (kurta) over the upper arm, skin forearm + hand
  const sleeveEnd = { x: S.x + (E.x - S.x) * 0.62, y: S.y + (E.y - S.y) * 0.62 };
  tube(ctx, S.x, S.y - 0.02, sleeveEnd.x, sleeveEnd.y, 0.072, 0.055,
    lg(ctx, S.x - 0.07, S.y, S.x + 0.07, S.y, [[0, C.kurtaHi], [1, C.kurtaLo]]), null);
  // sleeve gold cuff
  tube(ctx, sleeveEnd.x, sleeveEnd.y, sleeveEnd.x + (E.x - S.x) * 0.02, sleeveEnd.y + (E.y - S.y) * 0.02, 0.056, 0.055, C.gold, null);
  // forearm skin
  tube(ctx, sleeveEnd.x, sleeveEnd.y, W.x, W.y, 0.052, 0.04,
    lg(ctx, sleeveEnd.x - 0.05, sleeveEnd.y, sleeveEnd.x + 0.05, sleeveEnd.y, [[0, C.skinHi], [0.5, C.skin], [1, C.skinLo]]), C.skinLine, 0.004);
  // wrist bangle
  tube(ctx, W.x - (W.x - E.x) * 0.06, W.y - (W.y - E.y) * 0.06, W.x, W.y, 0.043, 0.042, C.gold, C.skinLine, 0.003);
  // open hand — palm + splayed fingers, pointing along the forearm
  let dx = W.x - E.x, dy = W.y - E.y; const l = Math.hypot(dx, dy) || 1e-6; dx /= l; dy /= l;
  const px = -dy, py = dx;
  ctx.save();
  ctx.fillStyle = lg(ctx, W.x - 0.05, W.y, W.x + 0.05, W.y, [[0, C.skinHi], [1, C.skinLo]]);
  ctx.strokeStyle = C.skinLine; ctx.lineWidth = 0.004;
  ctx.beginPath(); ctx.ellipse(W.x + dx * 0.03, W.y + dy * 0.03, 0.05, 0.045, Math.atan2(dy, dx), 0, Math.PI * 2); ctx.fill();
  for (let f = -2; f <= 2; f++) {
    const sp = f * 0.24;                       // finger spread angle
    const fx = dx * Math.cos(sp) - px * Math.sin(sp), fy = dy * Math.cos(sp) - py * Math.sin(sp);
    const len = f === 0 ? 0.075 : 0.062 - Math.abs(f) * 0.006;
    const bx = W.x + dx * 0.045 + px * f * 0.018, by = W.y + dy * 0.045 + py * f * 0.018;
    tube(ctx, bx, by, bx + fx * len, by + fy * len, 0.016, 0.012,
      lg(ctx, bx - 0.02, by, bx + 0.02, by, [[0, C.skinHi], [1, C.skin]]), C.skinLine, 0.003);
  }
  // thumb
  const tx = dx * Math.cos(-1.1) - px * Math.sin(-1.1) * side, ty = dy * Math.cos(-1.1) - py * Math.sin(-1.1) * side;
  const tbx = W.x + px * side * 0.04, tby = W.y + py * side * 0.04;
  tube(ctx, tbx, tby, tbx + tx * 0.05, tby + ty * 0.05, 0.018, 0.013,
    lg(ctx, tbx - 0.02, tby, tbx + 0.02, tby, [[0, C.skinHi], [1, C.skin]]), C.skinLine, 0.003);
  ctx.restore();
}

function drawLeg(ctx, side) {
  const H = side > 0 ? L[24] : L[23];
  const K = side > 0 ? L[26] : L[25];
  const A = side > 0 ? L[28] : L[27];
  const T = side > 0 ? L[32] : L[31];
  // brown leggings/pants — thigh to ankle
  tube(ctx, H.x, H.y + 0.02, K.x, K.y, 0.10, 0.072,
    lg(ctx, H.x - 0.1, H.y, H.x + 0.1, H.y, [[0, C.pantsHi], [0.5, C.pants], [1, C.pantsLo]]), null);
  tube(ctx, K.x, K.y, A.x, A.y, 0.072, 0.05,
    lg(ctx, K.x - 0.07, K.y, K.x + 0.07, K.y, [[0, C.pantsHi], [0.5, C.pants], [1, C.pantsLo]]), C.pantsLo, 0.004);
  // knee shading
  ctx.fillStyle = 'rgba(50,32,18,0.35)';
  ctx.beginPath(); ctx.ellipse(K.x, K.y, 0.05, 0.06, 0, 0, Math.PI * 2); ctx.fill();
  // wrap/legging seam lines near the ankle
  ctx.strokeStyle = C.pantsLo; ctx.lineWidth = 0.006;
  for (let k = 0; k < 4; k++) {
    const t = 0.05 + k * 0.06;
    ctx.beginPath();
    ctx.moveTo(A.x - 0.05, A.y + 0.02 + t); ctx.lineTo(A.x + 0.05, A.y + 0.05 + t); ctx.stroke();
  }
  // foot / sandal
  const fx = T.x - A.x, fy = T.y - A.y;
  tube(ctx, A.x, A.y, A.x + fx * 1.1, A.y + fy * 1.1, 0.05, 0.03,
    lg(ctx, A.x, A.y + 0.03, A.x, A.y - 0.03, [[0, C.skinHi], [1, C.skinLo]]), C.skinLine, 0.004);
}

function drawCape(ctx) {
  // green dupatta — over the left shoulder, sweeping across and down the body
  ctx.beginPath();
  ctx.moveTo(-0.30, 1.46);
  ctx.bezierCurveTo(-0.34, 1.20, -0.30, 0.90, -0.24, 0.62);   // left outer edge falls
  ctx.bezierCurveTo(-0.10, 0.44, 0.10, 0.42, 0.22, 0.50);     // hem sweep
  ctx.bezierCurveTo(0.20, 0.78, 0.10, 1.05, 0.02, 1.30);      // inner edge rises across chest
  ctx.bezierCurveTo(-0.05, 1.44, -0.20, 1.50, -0.30, 1.46);
  ctx.closePath();
  ctx.fillStyle = lg(ctx, -0.30, 1.5, 0.15, 0.5, [[0, C.capeHi], [0.45, C.cape], [1, C.capeLo]]);
  ctx.fill();
  // cloth folds
  ctx.save(); ctx.clip();
  ctx.strokeStyle = 'rgba(15,70,52,0.5)'; ctx.lineWidth = 0.01;
  for (const [x0, y0, x1, y1] of [[-0.24, 1.3, -0.10, 0.55], [-0.14, 1.34, 0.0, 0.5], [-0.02, 1.28, 0.12, 0.52]]) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0 + x1) / 2 - 0.03, (y0 + y1) / 2, x1, y1); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(120,220,180,0.35)'; ctx.lineWidth = 0.006;
  for (const [x0, y0, x1, y1] of [[-0.28, 1.28, -0.16, 0.6], [-0.06, 1.24, 0.06, 0.55]]) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0 + x1) / 2 + 0.02, (y0 + y1) / 2, x1, y1); ctx.stroke();
  }
  ctx.restore();
  // gold dotted border along the two long edges
  ctx.fillStyle = C.capeGold;
  const border = (pts) => { for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 0.008, 0, Math.PI * 2); ctx.fill(); } };
  const edgeA = []; for (let t = 0; t <= 1.001; t += 0.05) { const y = 1.46 - t * 0.84; edgeA.push([-0.30 - Math.sin(t * 3.14) * 0.03 - 0.005, y]); }
  const edgeB = []; for (let t = 0; t <= 1.001; t += 0.05) { edgeB.push([0.02 + (0.20) * t * 0.9, 1.30 - t * 0.8]); }
  border(edgeA); border(edgeB);
}

function drawHead(ctx) {
  const cx = 0, faceY = 1.615;
  // hair back mass
  ctx.beginPath();
  ctx.moveTo(-0.15, 1.66);
  ctx.bezierCurveTo(-0.17, 1.80, -0.09, 1.85, cx, 1.845);
  ctx.bezierCurveTo(0.09, 1.85, 0.17, 1.80, 0.15, 1.66);
  ctx.bezierCurveTo(0.17, 1.54, 0.12, 1.46, 0.10, 1.45);
  ctx.lineTo(-0.10, 1.45);
  ctx.bezierCurveTo(-0.12, 1.46, -0.17, 1.54, -0.15, 1.66);
  ctx.closePath();
  ctx.fillStyle = lg(ctx, -0.15, 1.84, 0.15, 1.48, [[0, C.hairHi], [0.4, C.hair], [1, C.hairLo]]);
  ctx.fill();
  // neck
  tube(ctx, cx, 1.44, cx, 1.55, 0.048, 0.05,
    lg(ctx, -0.05, 1.5, 0.05, 1.5, [[0, C.skinHi], [0.5, C.skin], [1, C.skinLo]]), null);
  ctx.fillStyle = 'rgba(120,70,40,0.35)'; ctx.fillRect(-0.05, 1.44, 0.10, 0.05);   // jaw shadow on neck
  // face
  ctx.beginPath();
  ctx.moveTo(-0.088, 1.66);
  ctx.bezierCurveTo(-0.092, 1.60, -0.07, 1.53, cx, 1.508);       // left cheek → chin
  ctx.bezierCurveTo(0.07, 1.53, 0.092, 1.60, 0.088, 1.66);
  ctx.bezierCurveTo(0.086, 1.71, 0.05, 1.745, cx, 1.745);        // forehead
  ctx.bezierCurveTo(-0.05, 1.745, -0.086, 1.71, -0.088, 1.66);
  ctx.closePath();
  ctx.fillStyle = lg(ctx, -0.09, 1.7, 0.09, 1.5, [[0, C.skinHi], [0.45, C.skin], [1, C.skinLo]]);
  ctx.fill();
  // cheek/side shading
  ctx.fillStyle = rg(ctx, 0.05, 1.60, 0.09, [[0, 'rgba(120,70,40,0)'], [1, 'rgba(120,70,40,0.30)']]);
  ctx.fill();
  // hair front — centre part framing the face
  ctx.fillStyle = lg(ctx, -0.13, 1.82, 0.13, 1.60, [[0, C.hairHi], [0.5, C.hair], [1, C.hairLo]]);
  ctx.beginPath();  // left sweep
  ctx.moveTo(cx - 0.004, 1.74); ctx.bezierCurveTo(-0.06, 1.76, -0.11, 1.72, -0.128, 1.62);
  ctx.bezierCurveTo(-0.135, 1.54, -0.11, 1.50, -0.10, 1.49);
  ctx.bezierCurveTo(-0.115, 1.58, -0.10, 1.66, -0.072, 1.70);
  ctx.bezierCurveTo(-0.05, 1.725, -0.02, 1.735, cx - 0.004, 1.735);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();  // right sweep (mirror)
  ctx.moveTo(cx + 0.004, 1.74); ctx.bezierCurveTo(0.06, 1.76, 0.11, 1.72, 0.128, 1.62);
  ctx.bezierCurveTo(0.135, 1.54, 0.11, 1.50, 0.10, 1.49);
  ctx.bezierCurveTo(0.115, 1.58, 0.10, 1.66, 0.072, 1.70);
  ctx.bezierCurveTo(0.05, 1.725, 0.02, 1.735, cx + 0.004, 1.735);
  ctx.closePath(); ctx.fill();
  // hair strands
  ctx.strokeStyle = 'rgba(15,10,7,0.5)'; ctx.lineWidth = 0.003;
  for (const s of [-0.09, -0.05, 0.05, 0.09]) { ctx.beginPath(); ctx.moveTo(s * 0.6, 1.73); ctx.quadraticCurveTo(s * 1.1, 1.62, s, 1.50); ctx.stroke(); }
  // gold hair pin (left)
  ctx.strokeStyle = C.gold; ctx.lineWidth = 0.008;
  ctx.beginPath(); ctx.moveTo(-0.085, 1.70); ctx.lineTo(-0.055, 1.685); ctx.stroke();
  ctx.fillStyle = C.gold; ctx.beginPath(); ctx.arc(-0.085, 1.70, 0.009, 0, Math.PI * 2); ctx.fill();
  // gold forehead tikka
  ctx.beginPath(); ctx.arc(cx, 1.712, 0.007, 0, Math.PI * 2); ctx.fill();
  // eyes — teal
  for (const s of [-1, 1]) {
    const ex = s * 0.042, ey = 1.648;
    ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.ellipse(ex, ey, 0.026, 0.016, s * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.eyeDk;
    ctx.beginPath(); ctx.arc(ex + s * 0.004, ey, 0.013, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.eye;
    ctx.beginPath(); ctx.arc(ex + s * 0.004, ey, 0.009, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath(); ctx.arc(ex + s * 0.004, ey, 0.004, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.arc(ex + s * 0.004 - 0.004, ey + 0.005, 0.0025, 0, Math.PI * 2); ctx.fill();
    // upper lid / lashes
    ctx.strokeStyle = C.brow; ctx.lineWidth = 0.004;
    ctx.beginPath(); ctx.moveTo(ex - s * 0.028, ey + 0.012); ctx.quadraticCurveTo(ex, ey + 0.022, ex + s * 0.028, ey + 0.01); ctx.stroke();
    // brow
    ctx.lineWidth = 0.006;
    ctx.beginPath(); ctx.moveTo(ex - s * 0.03, ey + 0.03); ctx.quadraticCurveTo(ex, ey + 0.042, ex + s * 0.028, ey + 0.032); ctx.stroke();
  }
  // nose
  ctx.strokeStyle = 'rgba(120,70,40,0.5)'; ctx.lineWidth = 0.004;
  ctx.beginPath(); ctx.moveTo(cx - 0.004, 1.635); ctx.lineTo(cx - 0.008, 1.585); ctx.quadraticCurveTo(cx, 1.575, cx + 0.006, 1.582); ctx.stroke();
  // mouth
  ctx.strokeStyle = C.mouth; ctx.lineWidth = 0.006;
  ctx.beginPath(); ctx.moveTo(-0.022, 1.558); ctx.quadraticCurveTo(cx, 1.55, 0.022, 1.558); ctx.stroke();
  ctx.strokeStyle = 'rgba(150,80,72,0.5)'; ctx.lineWidth = 0.003;
  ctx.beginPath(); ctx.moveTo(-0.02, 1.567); ctx.quadraticCurveTo(cx, 1.575, 0.02, 1.567); ctx.stroke();
}
