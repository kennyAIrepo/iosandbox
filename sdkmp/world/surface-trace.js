/**
 * hopeOS SDK — Surface Tracer
 * ═══════════════════════════════════════════════════════════════
 * Precise surface targeting for build mode. Toggle it on and the mouse rides the
 * ACTUAL mesh surface of any model in the scene (the base environment AND every
 * placed/AI-made object): a neon ring cursor sits exactly on the surface, aligned
 * to the surface normal, and the mesh under the pointer lights up as a wireframe so
 * you can SEE the geometry you're working against.
 *
 * Why: without surface exposure, "is the pointer ON this panel or just pointing in
 * its direction?" is ambiguous, and dropping objects onto a wall/floor is guesswork.
 * The tracer makes the hit point explicit and publishes it as `world.surfaceHit`
 * { point:[x,y,z], normal:[x,y,z], id }, so other tools — place-on-surface, and a
 * future paint brush — can build exactly where you point.
 *
 *   const tracer = new SurfaceTracer({ scene, camera, domElement, world });
 *   tracer.setEnabled(true);                 // ring rides the surface, mesh highlights
 *   world.surfaceHit                         // live { point, normal, id } | null
 *   tracer.onPaint = (hit) => { ... };       // called on click/drag over a surface
 */
import * as THREE from 'three';

export class SurfaceTracer {
  constructor({ scene, camera, domElement, world, grid }) {
    this.scene = scene; this.camera = camera; this.dom = domElement; this.world = world;
    this.grid = grid || null;         // SpatialGrid — when gridSnap is on, nodes trace like a surface
    this.gridSnap = false;            // set true while the 3D grid is shown → free-space drawing
    this.enabled = false;
    this.painting = false;            // when true, click/drag over a surface paints
    this.erasing = false;             // when true, click/drag over painted strokes erases them
    this.onPaint = null;              // host hook: (hit) => {}  — per move while dragging
    this.onPaintStart = null;         // host hook: (hit) => {}  — pointer down on a surface
    this.onPaintEnd = null;           // host hook: () => {}      — stroke released
    this.onErase = null;              // host hook: (hit) => {}  — erase the stroke under the cursor
    this.picking = false;             // one-shot pick mode (e.g. place the spawn halo)
    this.onPick = null;               // host hook: (hit) => {}  — fired once on click
    this.hit = null;                  // { point:Vector3, normal:Vector3, pressure, object, id }

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._down = false;

    // ── Surface cursor: ring (faces +Z) + centre dot + a short normal pin ──
    this.cursor = new THREE.Group();
    const neon = 0x39ff5a;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: neon, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 14, 12),
      new THREE.MeshBasicMaterial({ color: neon, depthTest: false }));
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8),
      new THREE.MeshBasicMaterial({ color: neon, transparent: true, opacity: 0.8, depthTest: false }));
    pin.rotation.x = Math.PI / 2;     // cylinder runs along local +Z (the normal)
    pin.position.z = 0.7;
    this.cursor.add(ring, dot, pin);
    this.cursor.visible = false;
    this.cursor.renderOrder = 999;
    this.cursor.userData.system = true;     // never auto-adopted as a game object
    this.cursor.traverse(o => { o.renderOrder = 999; o.userData.system = true; });
    scene.add(this.cursor);

    this._wire = null; this._wireFor = null;   // wireframe highlight of the hovered mesh

    this._onMove = this._onMove.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp   = this._onUp.bind(this);
  }

  /** Toggle the tracer. Returns the new state. */
  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled) {
      this.dom.addEventListener('pointermove', this._onMove);
      this.dom.addEventListener('pointerdown', this._onDown);
      window.addEventListener('pointerup', this._onUp);
    } else {
      this.dom.removeEventListener('pointermove', this._onMove);
      this.dom.removeEventListener('pointerdown', this._onDown);
      window.removeEventListener('pointerup', this._onUp);
      this.cursor.visible = false;
      this._clearWire();
      this.hit = null; this.world.surfaceHit = null; this._down = false;
    }
    return this.enabled;
  }

  /** Enable click/drag painting (host supplies onPaint). */
  setPainting(on) { this.painting = !!on; if (on) this.erasing = false; }
  /** Enable click/drag erasing (host supplies onErase). */
  setErasing(on) { this.erasing = !!on; if (on) this.painting = false; }
  /** Enable a one-shot pick (host supplies onPick) — e.g. placing the spawn halo. */
  setPicking(on) { this.picking = !!on; if (on) { this.painting = false; this.erasing = false; } }

  // Everything the ray can land on: the base environment + every placed/AI-made object.
  _targets() {
    const t = [];
    if (this.world.model) t.push(this.world.model);
    if (this.world.assetLayer) t.push(this.world.assetLayer);
    return t;
  }

  _idOf(object) {
    for (let o = object; o; o = o.parent) {
      if (o.userData && o.userData.id) return o.userData.id;
      if (o === this.world.model) return '__scene__';
    }
    return null;
  }

  _raycast(e) {
    const r = this.dom.getBoundingClientRect();
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    // GRID FREE-SPACE: snap to the nearest 3D grid node and treat it exactly like a surface
    // point — a camera-facing normal — so the cursor + paint + sketch pipeline works in open
    // space identically to drawing on a real mesh. (Falls through to mesh if no node is hit.)
    const hits = this._ray.intersectObjects(this._targets(), true);
    if (this.gridSnap && this.grid && this.grid.visible) {
      // Depth: if aiming at a mesh, draw at THAT depth on the lattice; otherwise reach a
      // sensible distance into open space. Snap the target to the nearest grid node so it
      // sits exactly on the lattice. Normal faces the camera (so the cursor/blob reads in 3D).
      const meshD = (hits.length && hits[0].distance < 40) ? hits[0].distance : (this.gridDepth || 4);
      const target = this._ray.ray.origin.clone().addScaledVector(this._ray.ray.direction, meshD);
      const node = this.grid.snapPoint(target);
      const n = this.camera.position.clone().sub(node).normalize();
      return { point: node, normal: n, object: null, id: '__grid__', onGrid: true };
    }
    for (const h of hits) {
      if (h.object === this._wire || h.object.parent === this.cursor || h.object === this.cursor) continue;  // ignore our own helpers
      if (!h.face) continue;                                   // need a face for the normal
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
      return { point: h.point.clone(), normal: n, object: h.object, id: this._idOf(h.object) };
    }
    return null;
  }

  // Pointer pressure 0..1 (real for pen/touch; mouse reports ~0.5 while a button is down).
  _pressure(e) { return (e && e.pressure > 0) ? e.pressure : 0.5; }

  _onMove(e) {
    const hit = this._raycast(e);
    if (!hit) { this.cursor.visible = false; this._clearWire(); this.hit = null; this.world.surfaceHit = null; return; }
    hit.pressure = this._pressure(e);
    this.hit = hit;
    this.world.surfaceHit = { point: hit.point.toArray().map(n => +n.toFixed(3)), normal: hit.normal.toArray().map(n => +n.toFixed(3)), id: hit.id };

    // Sit the cursor on the surface, +Z aligned to the surface normal, scaled by distance.
    this.cursor.position.copy(hit.point);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    const d = this.camera.position.distanceTo(hit.point);
    this.cursor.scale.setScalar(THREE.MathUtils.clamp(d * 0.035, 0.12, 3));
    this.cursor.visible = true;
    this._highlight(hit.object);

    if (this._down) {
      if (this.painting && this.onPaint) this.onPaint(this.hit);
      else if (this.erasing && this.onErase) this.onErase(this.hit);
    }
  }

  _onDown(e) {
    if (e.button !== 0) return;       // left button paints/erases; right is look-around
    this._down = true;
    if (this.hit) this.hit.pressure = this._pressure(e);
    if (this.picking && this.hit) { if (this.onPick) this.onPick(this.hit); return; }
    if (this.painting && this.hit) {
      if (this.onPaintStart) this.onPaintStart(this.hit);
      if (this.onPaint) this.onPaint(this.hit);
    } else if (this.erasing && this.hit && this.onErase) {
      this.onErase(this.hit);
    }
  }
  _onUp() {
    if (this._down && this.painting && this.onPaintEnd) this.onPaintEnd();
    this._down = false;
  }

  // Wireframe overlay of the hovered mesh, parented to it so it tracks transforms.
  _highlight(object) {
    if (this._wireFor === object) return;
    this._clearWire();
    if (!object || !object.geometry) return;     // grid free-space hit → no mesh to wireframe
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(object.geometry),
      new THREE.LineBasicMaterial({ color: 0x39ff5a, transparent: true, opacity: 0.22, depthTest: false }));
    wire.renderOrder = 998;
    object.add(wire);                 // child → inherits the mesh's live world transform
    this._wire = wire; this._wireFor = object;
  }
  _clearWire() {
    if (this._wire) { if (this._wire.parent) this._wire.parent.remove(this._wire); this._wire.geometry.dispose(); }
    this._wire = null; this._wireFor = null;
  }
}

export default SurfaceTracer;
