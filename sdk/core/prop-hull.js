/**
 * hopeOS SDK — PropHull: mesh-true capsule-chain collision shape for props.
 * ═══════════════════════════════════════════════════════════════════════════
 * The basketball doctrine generalized. The ball's collision shape was a SPHERE
 * matched to its visual mesh; the cube's an OBB (game-physics.js) — and the
 * hand is 21 joint spheres, so touch is computed SHAPE against SHAPE. Long
 * thin props (a bow stave, an arrow) fit neither primitive: their true outer
 * shape is a CHAIN OF CAPSULES baked from the actual GLB vertex cloud:
 *
 *   · primary axis = the extreme-vertex pair of the cloud (the arrow-scan
 *     trick — no assumption about how the asset lies in its own frame)
 *   · vertices are binned along that axis; each bin → centroid + outer
 *     radius (95th-percentile radial spread, so one stray vert can't fatten
 *     the shape); consecutive centroids → capsule segments {a, b, ra, rb}
 *   · a CURVED prop (the strung stave) follows automatically: bin centroids
 *     trace the arc, the chain bends with it
 *
 * The chain is the prop's portable "shape json" (toJSON / fromJSON). It lives
 * in the object's LOCAL frame; begin(object3D) poses every query through the
 * live matrixWorld — position, rotation AND scale, in motion.
 *
 * Queries (world space, zero allocation in the hot path):
 *   begin(obj)                     pose the hull on the live object
 *   surfaceDistance(p)             signed distance to the outer surface
 *   closest(p, outPoint, outNormal)  surface point + outward normal
 *   handGap(joints, radii)         min gap between 21 joint SPHERES and the
 *                                  hull — gap ≤ 0 is REAL surface touch
 *   pushOut(joints, radii, out)    min-translation accumulation to shove the
 *                                  prop out of penetrating joints (the
 *                                  avoidance response — bat it, nudge it)
 */

import * as THREE from 'three';

const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3(), _w = new THREE.Vector3();
const _inv = new THREE.Matrix4();

export class PropHull {
  /** @param {Array<{a:THREE.Vector3,b:THREE.Vector3,ra:number,rb:number}>} segs local-frame capsules */
  constructor(segs) {
    this.segs = segs;
    this._scale = 1;
    this._obj = null;
  }

  /** Bake a hull from a local-frame point cloud. */
  static fromPoints(pts, { bins = 14, pct = 0.95, minR = 0.004 } = {}) {
    if (!pts || pts.length < 8) return null;
    // primary axis from the extreme pair
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    c.multiplyScalar(1 / pts.length);
    const far = from => { let best = -1, out = pts[0];
      for (const p of pts) { const d = p.distanceToSquared(from); if (d > best) { best = d; out = p; } }
      return out; };
    const eA = far(c), eB = far(eA);
    const axis = new THREE.Vector3().subVectors(eB, eA);
    const len = axis.length();
    if (len < 1e-6) return null;
    axis.normalize();
    // bin along the axis: centroid + sorted radial spreads
    const cent = [], rad = [], cnt = [];
    for (let i = 0; i < bins; i++) { cent.push(new THREE.Vector3()); rad.push([]); cnt.push(0); }
    for (const p of pts) {
      const t = Math.min(bins - 1, Math.max(0, Math.floor(_p.copy(p).sub(eA).dot(axis) / len * bins)));
      cent[t].add(p); cnt[t]++;
    }
    for (let i = 0; i < bins; i++) if (cnt[i]) cent[i].multiplyScalar(1 / cnt[i]);
    for (const p of pts) {
      const t = Math.min(bins - 1, Math.max(0, Math.floor(_p.copy(p).sub(eA).dot(axis) / len * bins)));
      if (!cnt[t]) continue;
      _d.copy(p).sub(cent[t]);
      _d.addScaledVector(axis, -_d.dot(axis));            // radial component only
      rad[t].push(_d.length());
    }
    // 95th-pct radius per bin; empty bins interpolate from neighbours
    const R = new Array(bins).fill(0);
    for (let i = 0; i < bins; i++) {
      if (!cnt[i]) continue;
      rad[i].sort((a, b) => a - b);
      R[i] = Math.max(minR, rad[i][Math.min(rad[i].length - 1, Math.floor(rad[i].length * pct))]);
    }
    const segs = [];
    let prev = -1;
    for (let i = 0; i < bins; i++) {
      if (!cnt[i]) continue;
      if (prev >= 0) segs.push({ a: cent[prev].clone(), b: cent[i].clone(), ra: R[prev], rb: R[i] });
      prev = i;
    }
    return segs.length ? new PropHull(segs) : null;
  }

  /** Bake from a THREE object (all mesh verts, sampled, in the OBJECT's local frame). */
  static fromObject(obj, { maxSamples = 6000, ...opts } = {}) {
    obj.updateMatrixWorld(true);
    _inv.copy(obj.matrixWorld).invert();
    const pts = [];
    obj.traverse(m => {
      if (!m.isMesh || !m.geometry) return;
      const pos = m.geometry.getAttribute('position');
      if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / maxSamples));
      for (let v = 0; v < pos.count; v += step) {
        pts.push(new THREE.Vector3().fromBufferAttribute(pos, v)
          .applyMatrix4(m.matrixWorld).applyMatrix4(_inv));
      }
    });
    return PropHull.fromPoints(pts, opts);
  }

  toJSON() {
    return { v: 1, segs: this.segs.map(s => ({ a: s.a.toArray(), b: s.b.toArray(), ra: s.ra, rb: s.rb })) };
  }
  static fromJSON(j) {
    return new PropHull(j.segs.map(s => ({
      a: new THREE.Vector3().fromArray(s.a), b: new THREE.Vector3().fromArray(s.b), ra: s.ra, rb: s.rb })));
  }

  /** Pose all queries on this live object for the current frame. */
  begin(obj) {
    this._obj = obj;
    obj.updateWorldMatrix(true, false);
    _inv.copy(obj.matrixWorld).invert();
    this._invM = this._invM || new THREE.Matrix4();
    this._invM.copy(_inv);
    _w.setFromMatrixScale(obj.matrixWorld);
    this._scale = Math.max(1e-6, Math.max(_w.x, Math.max(_w.y, _w.z)));
    return this;
  }

  /** Signed world-space distance from p to the hull surface (< 0 inside). */
  surfaceDistance(p) {
    return this._closestLocal(p) * this._scale;
  }

  /** World surface point + outward normal nearest to p; returns the signed distance. */
  closest(p, outPoint, outNormal) {
    const d = this._closestLocal(p, _c, _n);
    if (outPoint) outPoint.copy(_c).applyMatrix4(this._obj.matrixWorld);
    if (outNormal) outNormal.copy(_n).transformDirection(this._obj.matrixWorld);
    return d * this._scale;
  }

  /** Min gap between joint spheres and the hull (gap ≤ 0 = real touch).
   *  Returns { gap, joint }. `radii` are world-space joint radii. */
  handGap(joints, radii) {
    let best = Infinity, idx = -1;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (!j) continue;
      const g = this.surfaceDistance(j) - (radii ? radii[i] : 0);
      if (g < best) { best = g; idx = i; }
    }
    return { gap: best, joint: idx };
  }

  /** Accumulate the min-translation (world) that shoves the prop out of every
   *  penetrating joint sphere. Returns the number of contacts. */
  pushOut(joints, radii, out) {
    let n = 0;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (!j) continue;
      const g = this.closest(j, null, _n) - (radii ? radii[i] : 0);
      if (g < 0) { out.addScaledVector(_n, g); n++; }     // push OPPOSITE the outward normal
    }
    return n;
  }

  // ── local-frame closest query over the capsule chain ──
  _closestLocal(pWorld, outPoint, outNormal) {
    _p.copy(pWorld).applyMatrix4(this._invM);
    let best = Infinity;
    for (const s of this.segs) {
      _d.subVectors(s.b, s.a);
      const L2 = _d.lengthSq();
      const t = L2 < 1e-12 ? 0 : Math.min(1, Math.max(0, _w.subVectors(_p, s.a).dot(_d) / L2));
      _w.copy(s.a).addScaledVector(_d, t);                // axis point
      const r = s.ra + (s.rb - s.ra) * t;
      const dAxis = _p.distanceTo(_w);
      const d = dAxis - r;
      if (d < best) {
        best = d;
        if (outPoint || outNormal) {
          if (dAxis > 1e-6) _n.copy(_p).sub(_w).divideScalar(dAxis);
          else _n.set(0, 0, 1);
          if (outNormal) outNormal.copy(_n);
          if (outPoint) outPoint.copy(_w).addScaledVector(_n, r);
        }
      }
    }
    return best;
  }
}
