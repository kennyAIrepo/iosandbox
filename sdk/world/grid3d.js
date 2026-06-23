/**
 * hopeOS SDK — Spatial Grid Canvas (neon "Matrix" 3D coordinate space)
 * ═══════════════════════════════════════════════════════════════
 * A persistent, walk-through 3D coordinate canvas: neon-green lines + clickable
 * dots at every node, measured from the ground (y=0) up through the whole space.
 * It follows the camera in a snapped window (LOD) so it feels infinite and the
 * lines stream toward you as you move, while only what's near you is ever built.
 *
 * Every node is a real world coordinate you can click to read, and four selection
 * modes let you author intent the agent can act on:
 *   • dot        — mark individual coordinates
 *   • trajectory — click nodes in order → a connected path (for moving/animating)
 *   • surface    — two corners → a flat 2D region (crop a plane)
 *   • volume     — two corners → a 3D box (crop a space for manipulation)
 * Chosen geometry is highlighted in solid neon green; getSelection() hands the
 * exact coordinates to the AI.
 *
 *   const grid = new SpatialGrid(scene, { ground: 0 });
 *   grid.update(camera);                 // each frame — recenters the window
 *   const node = grid.pickNode(raycaster);
 *   grid.setMode('trajectory'); grid.addPick(node);
 *   world.gridSelection = grid.getSelection();   // agent reads this
 */
import * as THREE from 'three';

// A soft round dot sprite (radial gradient) so grid nodes read as glowing dots,
// not the default square points. Built once, tinted by each material's colour.
let _dotTex = null;
function dotTexture() {
  if (_dotTex) return _dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.30, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.65, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.fill();
  _dotTex = new THREE.CanvasTexture(c);
  return _dotTex;
}

export class SpatialGrid {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.cfg = {
      color:    0x39ff5a,   // neon matrix green (lines + dots)
      hi:       0x9dff4d,   // brighter green for chosen marks
      step:     2,          // metres per cell
      radius:   9,          // cells out from the camera (the LOD window)
      height:   7,          // cells up from the ground
      ground:   0,
      ...opts,
    };
    this.step = this.cfg.step;
    this.groundY = this.cfg.ground;

    this.group = new THREE.Group(); this.group.name = 'grid_canvas'; this.scene.add(this.group);
    this.hiGroup = new THREE.Group(); this.hiGroup.name = 'grid_selection'; this.scene.add(this.hiGroup);
    this.dotsObj = null;
    this._cell = null;                  // last snapped centre cell {x,z}

    this.sel = { mode: 'off', dots: [], traj: [], cornerA: null, rect: null, box: null };
    this._buildAt(new THREE.Vector3());
  }

  setVisible(v) { this.group.visible = !!v; this.hiGroup.visible = !!v; }
  get visible() { return this.group.visible; }
  setGround(y) { this.groundY = y; this._cell = null; }

  // ── LOD window: rebuild only when the camera crosses into a new cell ──
  update(camera) {
    if (!this.group.visible) return;
    const s = this.step;
    const cx = Math.round(camera.position.x / s), cz = Math.round(camera.position.z / s);
    if (!this._cell || this._cell.x !== cx || this._cell.z !== cz) {
      this._cell = { x: cx, z: cz };
      this._buildAt(camera.position);
    }
  }

  _clear(group) { for (const c of [...group.children]) { group.remove(c); c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); } }

  _line(positions, opacity, color) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const m = new THREE.LineBasicMaterial({ color: color ?? this.cfg.color, transparent: true, opacity, depthWrite: false });
    const o = new THREE.LineSegments(g, m); o.renderOrder = 996; return o;
  }

  _buildAt(center) {
    this._clear(this.group);
    const s = this.step, R = this.cfg.radius;
    const cx = Math.round(center.x / s) * s, cz = Math.round(center.z / s) * s;
    const x0 = cx - R * s, x1 = cx + R * s, z0 = cz - R * s, z1 = cz + R * s;
    const y0 = this.groundY, y1 = this.groundY + this.cfg.height * s;

    const ground = [];                               // bright ground plane
    for (let x = x0; x <= x1; x += s) ground.push(x, y0, z0, x, y0, z1);
    for (let z = z0; z <= z1; z += s) ground.push(x0, y0, z, x1, y0, z);
    this.group.add(this._line(ground, 0.42));

    const vert = [];                                 // faint "rain" columns
    for (let x = x0; x <= x1; x += s) for (let z = z0; z <= z1; z += s) vert.push(x, y0, z, x, y1, z);
    this.group.add(this._line(vert, 0.10));

    const layers = [];                               // faint horizontal layers above ground
    for (let y = y0 + s; y <= y1; y += s) {
      for (let x = x0; x <= x1; x += s) layers.push(x, y, z0, x, y, z1);
      for (let z = z0; z <= z1; z += s) layers.push(x0, y, z, x1, y, z);
    }
    this.group.add(this._line(layers, 0.07));

    const dots = [];                                 // clickable nodes (every coordinate)
    for (let x = x0; x <= x1; x += s) for (let z = z0; z <= z1; z += s) for (let y = y0; y <= y1; y += s) dots.push(x, y, z);
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
    // Normal blending (not additive) so dots stay visible on bright skies AND dark interiors.
    const dm = new THREE.PointsMaterial({ color: this.cfg.color, map: dotTexture(), size: s * 0.085, sizeAttenuation: true,
      transparent: true, opacity: 0.92, alphaTest: 0.02, depthWrite: false });
    this.dotsObj = new THREE.Points(dg, dm); this.dotsObj.renderOrder = 996;
    this.group.add(this.dotsObj);
  }

  /** Nearest grid node under a ray (snapped world coordinate), or null. */
  pickNode(raycaster) {
    if (!this.dotsObj) return null;
    const prev = raycaster.params.Points ? raycaster.params.Points.threshold : 1;
    raycaster.params.Points = { threshold: this.step * 0.4 };
    const hit = raycaster.intersectObject(this.dotsObj, false);
    raycaster.params.Points = { threshold: prev };
    if (!hit.length) return null;
    const i = hit[0].index, a = this.dotsObj.geometry.getAttribute('position');
    return new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i));
  }

  // ── Selection modes ──────────────────────────────────────────────
  setMode(mode) { this.sel.mode = mode; this.sel.cornerA = null; this.clearSelection(); }
  clearSelection() { this.sel.dots = []; this.sel.traj = []; this.sel.cornerA = null; this.sel.rect = null; this.sel.box = null; this._render(); }

  /** Feed a clicked node into the current mode. Returns the picked node. */
  addPick(node) {
    if (!node) return null;
    const m = this.sel.mode;
    if (m === 'dot') {
      const k = this._key(node), i = this.sel.dots.findIndex(d => this._key(d) === k);
      if (i >= 0) this.sel.dots.splice(i, 1); else this.sel.dots.push(node.clone());
    } else if (m === 'trajectory') {
      this.sel.traj.push(node.clone());
    } else if (m === 'surface') {
      if (!this.sel.cornerA) this.sel.cornerA = node.clone();
      else { this.sel.rect = this._corners(this.sel.cornerA, node, true); this.sel.cornerA = null; }
    } else if (m === 'volume') {
      if (!this.sel.cornerA) this.sel.cornerA = node.clone();
      else { this.sel.box = this._corners(this.sel.cornerA, node, false); this.sel.cornerA = null; }
    }
    this._render();
    return node;
  }

  _key(v) { return `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`; }
  _corners(a, b, flat) {
    const min = new THREE.Vector3(Math.min(a.x, b.x), flat ? a.y : Math.min(a.y, b.y), Math.min(a.z, b.z));
    const max = new THREE.Vector3(Math.max(a.x, b.x), flat ? a.y : Math.max(a.y, b.y), Math.max(a.z, b.z));
    return { min, max };
  }

  // ── Highlight rendering (solid neon green) ──
  _render() {
    this._clear(this.hiGroup);
    const C = this.cfg.hi;
    const markDots = (arr, size) => {
      if (!arr.length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr.flatMap(v => [v.x, v.y, v.z]), 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ color: C, map: dotTexture(), size, sizeAttenuation: true,
        transparent: true, opacity: 1, alphaTest: 0.02, depthWrite: false, blending: THREE.AdditiveBlending }));
      o.renderOrder = 998; this.hiGroup.add(o);
    };
    // pending corner shows as a single bright dot
    if (this.sel.cornerA) markDots([this.sel.cornerA], this.step * 0.16);
    markDots(this.sel.dots, this.step * 0.14);

    if (this.sel.traj.length) {
      markDots(this.sel.traj, this.step * 0.12);
      if (this.sel.traj.length > 1) {
        const g = new THREE.BufferGeometry().setFromPoints(this.sel.traj);
        const o = new THREE.Line(g, new THREE.LineBasicMaterial({ color: C, transparent: true, opacity: 0.95, depthWrite: false, linewidth: 2 }));
        o.renderOrder = 998; this.hiGroup.add(o);
      }
    }
    if (this.sel.rect) this._box(this.sel.rect.min, this.sel.rect.max, true);
    if (this.sel.box) this._box(this.sel.box.min, this.sel.box.max, false);
  }

  _box(min, max, flat) {
    const C = this.cfg.hi;
    if (flat) {
      const w = Math.max(max.x - min.x, 0.05), d = Math.max(max.z - min.z, 0.05);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: C, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      plane.rotation.x = -Math.PI / 2; plane.position.set((min.x + max.x) / 2, min.y + 0.02, (min.z + max.z) / 2);
      plane.renderOrder = 997; this.hiGroup.add(plane);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(plane.geometry), new THREE.LineBasicMaterial({ color: C, transparent: true, opacity: 0.95, depthWrite: false }));
      edges.rotation.copy(plane.rotation); edges.position.copy(plane.position); edges.renderOrder = 998; this.hiGroup.add(edges);
    } else {
      const box = new THREE.Box3(min, max);
      const helper = new THREE.Box3Helper(box, C); helper.material.transparent = true; helper.material.opacity = 0.95; helper.material.depthWrite = false; helper.renderOrder = 998;
      this.hiGroup.add(helper);
      const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
      const fill = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05)), new THREE.MeshBasicMaterial({ color: C, transparent: true, opacity: 0.10, depthWrite: false }));
      fill.position.copy(ctr); fill.renderOrder = 997; this.hiGroup.add(fill);
    }
  }

  /** Serialised selection the AI reads (rounded world coordinates). */
  getSelection() {
    const r = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
    const s = this.sel;
    return {
      mode: s.mode,
      dots: s.dots.map(r),
      trajectory: s.traj.map(r),
      surface: s.rect ? { min: r(s.rect.min), max: r(s.rect.max) } : null,
      volume: s.box ? { min: r(s.box.min), max: r(s.box.max) } : null,
    };
  }
}
