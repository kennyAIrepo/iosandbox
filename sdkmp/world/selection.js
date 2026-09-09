/**
 * hopeOS SDK — Spatial Selection (L5 marking)
 * ═══════════════════════════════════════════════════════════════
 * Marks a region of space — a free grid box, or a rectangle snapped onto a
 * wall / floor / ceiling — and exposes its full spatial matrix (centre,
 * surface normal, tangent basis, size, area, type). This is the precise
 * coordinate handle the AI and the hand-gesture tools edit against, so the
 * agent can reason like a game-engine: "fill THIS wall", "place on THIS spot".
 */
import * as THREE from 'three';

export class SelectionManager {
  constructor(scene) {
    this.scene = scene;
    this.model = null;           // world mesh to raycast against
    this.selection = null;       // internal {center, normal, tangent, bitangent, size, area, type, kind}
    this.gizmo = null;
    this.raycaster = new THREE.Raycaster();
  }
  setModel(m) { this.model = m; }

  /** Mark the surface a ray hits (origin + direction). size = rect edge in metres. */
  markFromRay(origin, dir, size = 2.0) {
    if (!this.model) return null;
    this.raycaster.set(origin, dir.clone().normalize());
    const hits = this.raycaster.intersectObject(this.model, true);
    if (!hits.length) return null;
    const h = hits[0];
    let n = new THREE.Vector3(0, 1, 0);
    if (h.face) n = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
    return this._set(h.point.clone(), n, size, 'surface');
  }

  /** Mark a free box region floating in space at a grid point. */
  markRegion(center, size = 2.0) {
    return this._set(new THREE.Vector3(center.x, center.y, center.z), new THREE.Vector3(0, 1, 0), size, 'region');
  }

  _set(point, normal, size, kind) {
    const ref = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(ref, normal).normalize();
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const type = normal.y > 0.6 ? 'floor' : normal.y < -0.6 ? 'ceiling' : 'wall';
    this.selection = { center: point, normal, tangent, bitangent, size, area: size * size, type, kind };
    this._drawGizmo();
    return this.get();
  }

  /** Serialisable spatial matrix the AI reads. */
  get() {
    const s = this.selection;
    if (!s) return null;
    const r = v => v.toArray().map(n => +n.toFixed(2));
    return {
      kind: s.kind, type: s.type, size: s.size, area: +s.area.toFixed(2),
      center: r(s.center), normal: r(s.normal),
      basis: { tangent: r(s.tangent), bitangent: r(s.bitangent) },
    };
  }
  clear() { this.selection = null; if (this.gizmo) { this.scene.remove(this.gizmo); this.gizmo = null; } }
  has() { return !!this.selection; }

  /** A world point inside the marked rect at (u,v) ∈ [-0.5,0.5], lifted off the surface. */
  pointAt(u = 0, v = 0, lift = 0) {
    const s = this.selection; if (!s) return null;
    return s.center.clone()
      .addScaledVector(s.tangent, u * s.size)
      .addScaledVector(s.bitangent, v * s.size)
      .addScaledVector(s.normal, lift);
  }
  /** Outward surface normal (so callers can lift objects off walls/floors). */
  normal() { return this.selection ? this.selection.normal.clone() : new THREE.Vector3(0, 1, 0); }

  _drawGizmo() {
    if (this.gizmo) this.scene.remove(this.gizmo);
    const s = this.selection;
    const g = new THREE.Group();
    const m = new THREE.Matrix4().makeBasis(s.tangent, s.bitangent, s.normal);
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);
    const pos = s.center.clone().addScaledVector(s.normal, 0.02);

    const geo = new THREE.PlaneGeometry(s.size, s.size);
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x4a7fb5, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
    fill.quaternion.copy(quat); fill.position.copy(pos);
    g.add(fill);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xd4a843 }));
    edges.quaternion.copy(quat); edges.position.copy(pos);
    g.add(edges);

    // subdivision grid (4×4) so the region reads as an editable matrix
    const grid = new THREE.GridHelper(s.size, 4, 0xd4a843, 0x4a7fb5);
    grid.material.transparent = true; grid.material.opacity = 0.35;
    grid.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.tangent, s.normal, s.bitangent));
    grid.position.copy(pos);
    g.add(grid);

    g.renderOrder = 999;
    this.gizmo = g; this.scene.add(g);
  }
}
