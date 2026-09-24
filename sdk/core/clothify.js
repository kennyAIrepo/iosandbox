/**
 * hopeOS SDK — clothify.js: make ANY prop cloth, at runtime, in one call.
 * ═══════════════════════════════════════════════════════════════════════════
 * The rug pipeline (tools/cloth) does this offline in Blender and bakes the
 * result into a GLB. This is the same idea as a COMPONENT: point it at an
 * object already in the scene and it fits a simulation lattice to that object
 * and embeds its surface in it — no Blender, no re-export, no authored spec.
 *
 *   const piece = clothify(obj, { cell: 0.03 })   // → { group, sim, skins, wire }
 *
 * What it does, in order:
 *   1. PLANE FIT — principal axes of the vertex cloud. The smallest-variance
 *      axis is the sheet normal; the other two are the row/column directions.
 *      So a rug lying flat, a banner standing up and a scanned prop that came
 *      in at some arbitrary angle all fit the same way.
 *   2. LATTICE — a regular grid over that plane's footprint, cell size chosen
 *      from `cell` but capped by `maxNodes` so the solver always fits a frame.
 *   3. UNBOW — a scan is never flat. The mean surface offset per node is
 *      measured, smoothed and subtracted from the vertices, so the REST state
 *      is a flat sheet (otherwise the cloth for ever remembers the scan's bow)
 *      while the silhouette keeps every bump.
 *   4. EMBED — every vertex of every mesh is bound into its cell and rides it
 *      in the vertex shader (ClothSkin). Multi-mesh props share one lattice.
 *
 * `unclothify(piece)` puts the object back exactly as it was.
 */
import * as THREE from 'three';
import { ClothSim, ClothSkin, updateClothWire } from './cloth-sim.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();

/**
 * A prop can only fold as finely as it has vertices: a BoxGeometry has 24, so
 * however good the lattice is, the visible surface would stay a flat cage. Split
 * every triangle 1→4 (shared edges through a midpoint cache, so it stays
 * watertight) until the surface is finer than the lattice it rides.
 */
export function tessellate(geo, target, maxPasses = 5) {
  let g = geo.index ? geo : geo.clone();
  if (!g.index) {                                // give it an index so edges can be shared
    const n = g.attributes.position.count;
    g.setIndex(Array.from({ length: n }, (_, i) => i));
  }
  const lerpable = ['position', 'normal', 'uv', 'uv1', 'uv2', 'color'];
  for (let pass = 0; pass < maxPasses && g.attributes.position.count < target; pass++) {
    const idx = g.index.array, tri = idx.length / 3;
    const attrs = lerpable.filter(k => g.attributes[k]).map(k => ({ k, a: g.attributes[k], out: [...g.attributes[k].array] }));
    let count = g.attributes.position.count;
    const mid = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let m = mid.get(key);
      if (m !== undefined) return m;
      m = count++;
      for (const { a: at, out } of attrs) {
        const it = at.itemSize;
        for (let c = 0; c < it; c++) out.push((at.array[a * it + c] + at.array[b * it + c]) / 2);
      }
      mid.set(key, m);
      return m;
    };
    const out = [];
    for (let t = 0; t < tri; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    const ng = new THREE.BufferGeometry();
    for (const { k, a, out: arr } of attrs) ng.setAttribute(k, new THREE.BufferAttribute(Float32Array.from(arr), a.itemSize));
    ng.setIndex(out);
    if (g !== geo) g.dispose();
    g = ng;
  }
  if (g.attributes.normal) {                     // midpoint normals are averages — renormalise
    const nA = g.attributes.normal;
    for (let i = 0; i < nA.count; i++) {
      const L = Math.hypot(nA.getX(i), nA.getY(i), nA.getZ(i)) || 1;
      nA.setXYZ(i, nA.getX(i) / L, nA.getY(i) / L, nA.getZ(i) / L);
    }
  }
  return g;
}

/** the flattest plane through a point cloud: {o, u, v, n, extent} (3×3 Jacobi PCA) */
export function fitPlane(pts, stride = 1) {
  const n = pts.length / 3;
  let cx = 0, cy = 0, cz = 0, c = 0;
  for (let i = 0; i < n; i += stride) { cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2]; c++; }
  cx /= c; cy /= c; cz /= c;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i += stride) {
    const dx = pts[i * 3] - cx, dy = pts[i * 3 + 1] - cy, dz = pts[i * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const A = [[xx / c, xy / c, xz / c], [xy / c, yy / c, yz / c], [xz / c, yz / c, zz / c]];
  // Jacobi eigen-decomposition of a symmetric 3×3 — small, exact enough, no deps
  let V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let p = 0, q = 1, best = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > best) { best = Math.abs(A[0][2]); p = 0; q = 2; }
    if (Math.abs(A[1][2]) > best) { best = Math.abs(A[1][2]); p = 1; q = 2; }
    if (best < 1e-14) break;
    const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
    for (let k = 0; k < 3; k++) {
      const akp = A[k][p], akq = A[k][q];
      A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = A[p][k], aqk = A[q][k];
      A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk;
      const vkp = V[k][p], vkq = V[k][q];
      V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq;
    }
  }
  const ev = [A[0][0], A[1][1], A[2][2]];
  const order = [0, 1, 2].sort((a, b) => ev[b] - ev[a]);          // largest spread first
  const axis = k => new THREE.Vector3(V[0][k], V[1][k], V[2][k]).normalize();
  const u = axis(order[0]), v = axis(order[1]);
  const nrm = new THREE.Vector3().crossVectors(v, u).normalize();  // matches the cell frame's N
  return { o: new THREE.Vector3(cx, cy, cz), u, v, n: nrm,
           spread: order.map(k => Math.sqrt(Math.max(0, ev[k]))) };
}

/**
 * Turn `obj` (a Mesh, or a Group of meshes) into cloth in place.
 * @returns {{group:THREE.Group, sim:ClothSim, skins:ClothSkin[], wire:THREE.LineSegments, info:object}}
 */
export function clothify(obj, opts = {}) {
  const {
    cell = 0.03,            // target lattice cell, metres of the object's own frame
    maxNodes = 4200,        // hard cap: the solver must still fit a frame
    minNodes = 120,
    thickness = null,       // half-thickness for contact; default = measured
    unbow = true,
    margin = 0.0,           // grow the lattice past the footprint (fringes etc.)
    minSkin = 3,            // target skin vertices PER LATTICE NODE (0 = never tessellate)
    maxSkin = 200000,       // …but never past this
    ...simOpts
  } = opts;

  // ── 1. collect the meshes, in the object's own local frame ──
  obj.updateWorldMatrix(true, true);
  const meshes = [];
  obj.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  if (!meshes.length) throw new Error('clothify: nothing to clothify (no meshes)');
  // The prop's own SCALE is baked into the geometry and reset to 1. A cloth
  // solved inside a non-uniform scale is a lie — a sheet hanging a metre in the
  // local frame of a prop squashed to 0.02 in y renders as a 2 cm twitch. After
  // this the local frame is world-proportioned and gravity means what it says.
  const objScale = obj.scale.clone();
  const toObj = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const bakeScale = new THREE.Matrix4().makeScale(objScale.x, objScale.y, objScale.z);
  const bakes = [];
  let total = 0;
  for (const m of meshes) {
    const geo = m.geometry.clone();
    _m.multiplyMatrices(bakeScale, _m.multiplyMatrices(toObj, m.matrixWorld));
    if (!_m.equals(new THREE.Matrix4())) geo.applyMatrix4(_m);     // child transform + the prop's scale
    if (!geo.attributes.normal) geo.computeVertexNormals();
    bakes.push({ mesh: m, geo });
    total += geo.attributes.position.count;
  }

  // ── 2. fit the plane over a sample of every mesh ──
  const sample = [];
  const stride = Math.max(1, Math.floor(total / 40000));
  for (const { geo } of bakes) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i += stride) sample.push(p.getX(i), p.getY(i), p.getZ(i));
  }
  // the geometry now carries the prop's scale, so the sheet a viewer SEES is the
  // sheet the fit measures — a squashed cube reads as the sheet it looks like
  const F = fitPlane(Float32Array.from(sample));

  // ── 3. footprint in the plane, and the lattice over it ──
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, h0 = Infinity, h1 = -Infinity;
  for (let i = 0; i < sample.length; i += 3) {
    _v.set(sample[i], sample[i + 1], sample[i + 2]).sub(F.o);
    const a = _v.dot(F.u), b = _v.dot(F.v), h = _v.dot(F.n);
    if (a < u0) u0 = a; if (a > u1) u1 = a;
    if (b < v0) v0 = b; if (b > v1) v1 = b;
    if (h < h0) h0 = h; if (h > h1) h1 = h;
  }
  u0 -= margin; u1 += margin; v0 -= margin; v1 += margin;
  const W = Math.max(1e-3, u1 - u0), H = Math.max(1e-3, v1 - v0);
  let step = Math.max(cell, 1e-3);
  let nx = Math.max(2, Math.round(W / step) + 1), ny = Math.max(2, Math.round(H / step) + 1);
  if (nx * ny > maxNodes) {                       // keep the frame budget, whatever the prop's size
    const k = Math.sqrt(maxNodes / (nx * ny));
    nx = Math.max(2, Math.round(nx * k)); ny = Math.max(2, Math.round(ny * k));
    step = Math.max(W / (nx - 1), H / (ny - 1));
  }
  if (nx * ny < minNodes) {                       // …and enough nodes to fold at all
    const k = Math.sqrt(minNodes / (nx * ny));
    nx = Math.max(2, Math.round(nx * k)); ny = Math.max(2, Math.round(ny * k));
  }
  const du = W / (nx - 1), dv = H / (ny - 1);
  const rest = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    _v.copy(F.o).addScaledVector(F.u, u0 + i * du).addScaledVector(F.v, v0 + j * dv);
    const k = (j * nx + i) * 3;
    rest[k] = _v.x; rest[k + 1] = _v.y; rest[k + 2] = _v.z;
  }

  // ── 4. UNBOW: the rest sheet must be flat, the silhouette must not change ──
  const field = new Float32Array(nx * ny), wsum = new Float32Array(nx * ny);
  const hs = [];                                  // |offset from the sheet| per sampled vertex
  if (unbow) {
    for (const { geo } of bakes) {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        _v.set(p.getX(i), p.getY(i), p.getZ(i)).sub(F.o);
        const a = (_v.dot(F.u) - u0) / du, b = (_v.dot(F.v) - v0) / dv, h = _v.dot(F.n);
        const ci = Math.min(Math.max(Math.round(a), 0), nx - 1), cj = Math.min(Math.max(Math.round(b), 0), ny - 1);
        field[cj * nx + ci] += h; wsum[cj * nx + ci]++;
      }
    }
    for (let i = 0; i < field.length; i++) field[i] = wsum[i] ? field[i] / wsum[i] : NaN;
    // fill the empty cells, then smooth — a bow is low frequency, bumps are not
    for (let pass = 0; pass < 8; pass++) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!Number.isNaN(field[k])) continue;
        let s = 0, c = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const q = (j + dj) * nx + (i + di);
          if (i + di < 0 || i + di >= nx || j + dj < 0 || j + dj >= ny || Number.isNaN(field[q])) continue;
          s += field[q]; c++;
        }
        if (c) field[k] = s / c;
      }
    }
    for (let i = 0; i < field.length; i++) if (Number.isNaN(field[i])) field[i] = 0;
    const tmp = new Float32Array(field.length);
    for (let pass = 0; pass < 12; pass++) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue;
          s += field[jj * nx + ii]; c++;
        }
        tmp[j * nx + i] = s / c;
      }
      field.set(tmp);
    }
    const at = (a, b) => {                        // bilinear sample of the bow field
      const i0 = Math.min(Math.max(Math.floor(a), 0), nx - 1), j0 = Math.min(Math.max(Math.floor(b), 0), ny - 1);
      const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1);
      const fa = Math.min(Math.max(a - i0, 0), 1), fb = Math.min(Math.max(b - j0, 0), 1);
      return field[j0 * nx + i0] * (1 - fa) * (1 - fb) + field[j0 * nx + i1] * fa * (1 - fb)
           + field[j1 * nx + i0] * (1 - fa) * fb + field[j1 * nx + i1] * fa * fb;
    };
    h0 = Infinity; h1 = -Infinity;               // re-measured on the FLAT sheet
    for (const { geo } of bakes) {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        _v.set(p.getX(i), p.getY(i), p.getZ(i)).sub(F.o);
        const a = (_v.dot(F.u) - u0) / du, b = (_v.dot(F.v) - v0) / dv;
        const h = _v.dot(F.n) - at(a, b);
        if (h < h0) h0 = h; if (h > h1) h1 = h;
        if ((i % stride) === 0) hs.push(Math.abs(h));   // the half-thickness distribution
        _w.copy(F.n).multiplyScalar(-at(a, b));
        p.setXYZ(i, p.getX(i) + _w.x, p.getY(i) + _w.y, p.getZ(i) + _w.z);
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  // ── 4b. TESSELLATE: a surface coarser than the lattice cannot show a fold ──
  if (minSkin > 0) {
    for (const bk of bakes) {
      const have = bk.geo.attributes.position.count;
      const want = Math.min(maxSkin, Math.round(nx * ny * minSkin / bakes.length));
      if (have >= want) continue;
      const fine = tessellate(bk.geo, want);
      if (fine !== bk.geo) { bk.geo.dispose(); bk.geo = fine; }
    }
  }

  // ── 5. the sim + the embedded skins ──
  // the slab's half-thickness IS the contact skin — measured after unbowing, so
  // a scan's curvature is never mistaken for a 10 cm thick rug
  // The contact skin is the slab's HALF-THICKNESS, taken as the MEDIAN distance
  // from the sheet: a two-shell slab puts half its vertices on each face, so the
  // median lands on the face — where min/max would be inflated by whatever bow
  // the unbow could not remove, and by stray fringe geometry.
  hs.sort((a, b) => a - b);
  const measured = hs.length ? hs[hs.length >> 1] : (h1 - h0) / 2;
  const half = thickness != null ? thickness : Math.min(0.03, Math.max(0.002, measured));
  const sim = new ClothSim({ nx, ny, rest }, { thickness: half, ...simOpts });
  const group = obj;                              // the prop's OWN frame is the cloth frame
  const skins = [], restore = [];
  for (const { mesh, geo } of bakes) {
    restore.push({ mesh, geometry: mesh.geometry, matrix: mesh.matrix.clone(),
                   frustumCulled: mesh.frustumCulled, material: mesh.material,
                   objScale: mesh === obj ? objScale : null });
    mesh.geometry = geo;
    if (mesh !== obj) { mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1); }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone();
    skins.push(new ClothSkin(mesh, sim));
  }
  const wire = new THREE.LineSegments(
    latticeWireframe(nx, ny, rest),
    new THREE.LineBasicMaterial({ color: 0x5de8ff, transparent: true, opacity: 0.6, depthTest: false }));
  wire.visible = false; wire.frustumCulled = false; wire.name = 'ClothLattice';
  obj.add(wire);
  obj.scale.set(1, 1, 1);                         // …the scale now lives in the geometry


  const info = { nodes: nx * ny, nx, ny, cell: +((du + dv) / 2).toFixed(4),
                 size: [+W.toFixed(3), +H.toFixed(3)], thickness: +half.toFixed(4),
                 verts: total, meshes: bakes.length, flat: +(F.spread[2] / Math.max(F.spread[0], 1e-6)).toFixed(3) };
  return { group, sim, skins, skin: skins[0], wire, info, restore, source: obj, objScale };
}

/**
 * The lattice as LINE SEGMENTS whose vertices ARE the lattice nodes, in order —
 * so the live update is a straight copy, not a nearest-node search.
 */
export function latticeWireframe(nx, ny, rest) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(rest), 3));
  const idx = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * nx + i;
    if (i + 1 < nx) idx.push(a, a + 1);
    if (j + 1 < ny) idx.push(a, a + nx);
  }
  g.setIndex(idx);
  const pairs = new Int32Array(nx * ny);
  for (let i = 0; i < pairs.length; i++) pairs[i] = i;
  g.userData.pairs = pairs;                      // identity: vertex i IS node i
  return g;
}

/** put the meshes back exactly as they were before clothify() */
export function unclothify(piece) {
  if (!piece || !piece.restore) return;
  for (const r of piece.restore) {
    r.mesh.geometry.dispose();
    r.mesh.geometry = r.geometry;
    r.mesh.material = r.material;
    r.mesh.matrix.copy(r.matrix);
    r.mesh.matrix.decompose(r.mesh.position, r.mesh.quaternion, r.mesh.scale);
    r.mesh.frustumCulled = r.frustumCulled;
  }
  if (piece.objScale) piece.source.scale.copy(piece.objScale);
  if (piece.wire.parent) piece.wire.parent.remove(piece.wire);
  piece.skins.forEach(s => s.dispose());
  piece.wire.geometry.dispose(); piece.wire.material.dispose();
  piece.restore = null;
}

/** one frame of a clothified piece (the lattice moves, the skins follow) */
export function clothifyTick(piece) {
  for (const s of piece.skins) s.update();
  updateClothWire(piece.wire, piece.sim);
}
