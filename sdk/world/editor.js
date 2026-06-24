/**
 * hopeOS SDK — Object Editor (Unity/Blender-style scene editing)
 * ═══════════════════════════════════════════════════════════════
 * The pointer-driven manipulation layer for L5 assets, the counterpart to the
 * bare-hand AssetManipulator. While CREATE mode is on it gives you:
 *
 *   • CLICK to select an object (raycast).
 *   • A transform GIZMO with XYZ handles — translate / rotate / scale
 *     (three.js TransformControls, the same widget Unity/Blender give you).
 *   • DRAG the object (or its gizmo handles) to move/rotate/scale it.
 *   • BOX/MARQUEE select: left-drag across empty space to rubber-band a group of
 *     objects, then transform them ALL together around their shared pivot.
 *   • Shift-click to add/remove from the selection. Delete removes, Esc clears.
 *
 * Pointer arbitration: this layer owns the LEFT mouse button in create mode;
 * looking around is the RIGHT button (see AvatarNavigator). The gizmo's own
 * handles take priority over select/marquee. Every committed edit re-syncs the
 * Rapier collider so the avatar still collides, and the BVH hand-colliders are
 * geometry-local so they follow moves/scales with no rebuild.
 *
 *   const editor = new ObjectEditor({ scene, camera, domElement, world, onSay });
 *   editor.setEnabled(true);          // on entering CREATE mode
 *   editor.setMode('rotate');         // 'translate' | 'rotate' | 'scale'
 *   editor.update();                  // per-frame (keeps selection boxes in sync)
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export class ObjectEditor {
  constructor({ scene, camera, domElement, world, onSay, onSelect }) {
    this.scene = scene;
    this.camera = camera;
    this.dom = domElement;
    this.world = world;
    this.onSay = onSay || (() => {});
    this.onSelect = onSelect || (() => {});   // fired with selection count whenever it changes

    this.enabled = false;
    this.selected = [];        // asset objects
    this.single = null;        // the asset when exactly one is selected
    this.pivot = null;         // temp group for multi-object transforms
    this.helpers = [];         // BoxHelper per selected mesh
    this._marquee = null;      // { x0, y0 } while rubber-banding

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // ── Transform gizmo ──
    this.tc = new TransformControls(camera, domElement);
    this.tc.setSize(0.9);
    this.tc.enabled = false;
    scene.add(this.tc);
    this.tc.addEventListener('objectChange', () => {
      if (this.single && this.single.isSky) this.world._skybox.position.copy(this.world._sceneCenter());  // sky stays centred, scale only
      else if (this.single && !this.single.isScene) this.world._syncCollider(this.single);
      this._updateHelpers();
    });
    this.tc.addEventListener('dragging-changed', (e) => {
      this._dragging = e.value;
      if (!e.value && this.single && this.single.isSky) this.world.syncSkyboxScaleFromMesh();   // persist + clamp sky scale after a gizmo drag
      if (!e.value && this.single && this.single.isScene) this.world.onSceneEdited();   // rebuild env colliders after moving/scaling the world
      if (!e.value && this.pivot) {           // a group drag just ended → bake + rebuild pivot
        this._bakeGroup();
        if (this.selected.length > 1) { this._makePivot(); this.tc.attach(this.pivot); }
      }
      this._updateHelpers();
    });

    // ── Marquee overlay (DOM rubber-band rectangle) ──
    this._rect = document.createElement('div');
    this._rect.style.cssText = 'position:fixed;border:1px solid #d4a843;background:rgba(212,168,67,.12);' +
      'z-index:40;pointer-events:none;display:none';
    document.body.appendChild(this._rect);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onKey = this._onKey.bind(this);
  }

  /** True while a gizmo handle or marquee is in active use (host suppresses hand-grab). */
  get busy() { return !!(this._dragging || this._marquee); }

  // on=true enables interaction. opts.selectOnly = click-to-select but no gizmo /
  // box-select (used in PLAY mode so you can select any object anytime without it
  // fighting navigation). Full editing (gizmo, marquee, drag) is create mode.
  setEnabled(on, opts = {}) {
    const selectOnly = !!(opts && opts.selectOnly);
    // Always re-bind cleanly — the mode can flip between full-edit and select-only.
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('keydown', this._onKey);
    this.enabled = on; this.selectOnly = selectOnly;
    this.tc.enabled = on && !selectOnly;
    this.tc.visible = on && !selectOnly && this.selected.length > 0;
    if (on) {
      this.dom.addEventListener('pointerdown', this._onDown);
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
      window.addEventListener('keydown', this._onKey);
    } else {
      this._clear();
      this._hideMarquee();
      this._marquee = null;
    }
  }

  setMode(mode) { this.tc.setMode(mode); this.onSay('gizmo: ' + mode); }

  /** Per-frame: keep selection boxes glued to objects (camera/objects may move). */
  update() { if (this.enabled) this._updateHelpers(); }

  // ── Selection ──────────────────────────────────────────────────
  _setSelection(assets) {
    this._clear();
    this.selected = assets.slice();
    if (!assets.length) return;
    this.world._ensureAssetLayer();
    if (assets.length === 1) { this.single = assets[0]; this.tc.attach(assets[0].mesh); if (assets[0].isSky) this.tc.setMode('scale'); }
    else { this._makePivot(); this.tc.attach(this.pivot); }
    this.tc.visible = !this.selectOnly;             // play mode: highlight only, no gizmo
    this._setHelpers();
    this.onSay(assets.length === 1 ? 'selected ' + assets[0].label : `selected ${assets.length} objects`);
    this.onSelect(this.selected.length);
  }

  get selectionCount() { return this.selected.length; }
  get selectedIds() { return this.selected.map(a => a.id); }

  /** Select a specific object by id (from the object-list sidebar). Works in play + create. */
  selectById(id) {
    let asset = this.world.assets.find(a => a.id === id);
    if (!asset && id === '__scene__' && this.world.model) { this.world.sceneIsObject = true; asset = this._sceneAsset(); }
    if (!asset && id === '__sky__' && this.world._skybox) asset = this._skyAsset();
    if (!asset) return false;
    this._setSelection([asset]);
    return true;
  }
  clearSelection() { this._clear(); }

  /** Duplicate the current selection and select the copies. */
  duplicateSelection() {
    const ids = this.selected.filter(a => !a.isScene).map(a => a.id);
    if (!ids.length) { this.onSay('nothing to duplicate'); return []; }
    const nids = ids.map(id => this.world.duplicateObject(id)).filter(Boolean);
    const assets = nids.map(id => this.world.assets.find(a => a.id === id)).filter(Boolean);
    if (assets.length) this._setSelection(assets);
    this.onSay('duplicated ' + nids.length + ' object' + (nids.length > 1 ? 's' : ''));
    return nids;
  }

  /** Delete the current selection (used by the Delete key and the Delete button). */
  deleteSelection() {
    const targets = this.selected.filter(a => !a.isScene);   // never delete the world itself
    if (!targets.length) { if (this.selected.some(a => a.isScene)) this.onSay("can't delete the world itself"); return 0; }
    const n = targets.length, ids = targets.map(a => a.id);
    this._clear();
    ids.forEach(id => this.world.deleteObject(id));
    this.onSay(`removed ${n} object${n > 1 ? 's' : ''}`);
    return n;
  }

  _toggle(asset) {
    const i = this.selected.indexOf(asset);
    const next = i >= 0 ? this.selected.filter(a => a !== asset) : [...this.selected, asset];
    this._setSelection(next);
  }

  _clear() {
    if (this.pivot) this._bakeGroup();
    this.tc.detach();
    this.single = null;
    this.selected = [];
    this._clearHelpers();
    this.onSelect(0);
  }

  // ── Group pivot (multi-object transform around a shared centre) ──
  _makePivot() {
    const c = new THREE.Vector3(), tmp = new THREE.Vector3(), box = new THREE.Box3();
    for (const a of this.selected) { box.setFromObject(a.mesh); c.add(box.getCenter(tmp)); }
    c.divideScalar(this.selected.length);
    this.pivot = new THREE.Group();
    this.pivot.position.copy(c);
    this.scene.add(this.pivot);
    this.pivot.updateMatrixWorld(true);
    for (const a of this.selected) this.pivot.attach(a.mesh);   // preserves each world transform
  }

  /** Bake group transforms back into the asset layer (identity space) + re-sync colliders. */
  _bakeGroup() {
    const layer = this.world._ensureAssetLayer();
    for (const a of this.selected) { layer.attach(a.mesh); this.world._syncCollider(a); }
    if (this.pivot) { this.scene.remove(this.pivot); this.pivot = null; }
  }

  // ── Selection highlight boxes ──
  _setHelpers() {
    this._clearHelpers();
    for (const a of this.selected) {
      const h = new THREE.BoxHelper(a.mesh, 0xd4a843);
      h.material.depthTest = false; h.renderOrder = 998;
      this.scene.add(h); this.helpers.push(h);
    }
  }
  _updateHelpers() { for (const h of this.helpers) h.update(); }
  _clearHelpers() { for (const h of this.helpers) { this.scene.remove(h); h.geometry.dispose(); } this.helpers = []; }

  // ── Pointer handlers ───────────────────────────────────────────
  _setNDC(e) {
    const r = this.dom.getBoundingClientRect();
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _pickAsset(e) {
    const layer = this.world.assetLayer;
    if (!layer || !layer.children.length) return null;
    this._setNDC(e);
    this._ray.setFromCamera(this._ndc, this.camera);
    const hits = this._ray.intersectObjects(layer.children, true);
    if (!hits.length) return null;
    return this._assetFromObject(hits[0].object);
  }

  _assetFromObject(obj) {
    for (let o = obj; o; o = o.parent) {
      if (o.userData && o.userData.id) return this.world.assets.find(a => a.id === o.userData.id) || null;
    }
    return null;
  }

  // A placed object first; otherwise the base world model — but ONLY once it's been
  // promoted to a game object (world.sceneIsObject). By default the environment is a
  // fixed backdrop you can't accidentally select or grab.
  _pick(e) {
    const a = this._pickAsset(e);
    if (a) return a;
    if (this.world.model && this.world.sceneIsObject) {
      this._setNDC(e);
      this._ray.setFromCamera(this._ndc, this.camera);
      if (this._ray.intersectObject(this.world.model, true).length) return this._sceneAsset();
    }
    return null;
  }

  // Synthetic selectable wrapping the whole environment (selected like any object).
  _sceneAsset() {
    if (!this._scene) this._scene = { id: '__scene__', label: 'world (environment)', mesh: this.world.model, isScene: true };
    this._scene.mesh = this.world.model;
    return this._scene;
  }

  // Synthetic selectable wrapping the sky shell — scale-only, locked to world centre.
  _skyAsset() {
    if (!this._sky) this._sky = { id: '__sky__', label: 'sky', mesh: this.world._skybox, isSky: true };
    this._sky.mesh = this.world._skybox;
    return this._sky;
  }

  _onDown(e) {
    if (!this.enabled || e.button !== 0) return;     // left button only; right = look
    if (this.tc.axis || this._dragging) return;       // a gizmo handle is grabbed → let it work
    const asset = this._pick(e);
    if (this.selectOnly) {                             // play mode: click selects, empty deselects
      if (asset) this._setSelection([asset]); else this._clear();
      return;
    }
    if (asset) {
      // The environment is always a solo selection (never grouped/reparented).
      if (asset.isScene || !e.shiftKey) this._setSelection([asset]); else this._toggle(asset);
      return;
    }
    // empty space → begin a marquee box-select (shift keeps the current set)
    if (!e.shiftKey) this._clear();
    this._marquee = { x0: e.clientX, y0: e.clientY };
    this._showMarquee(e.clientX, e.clientY, e.clientX, e.clientY);
  }

  _onMove(e) { if (this._marquee) this._showMarquee(this._marquee.x0, this._marquee.y0, e.clientX, e.clientY); }

  _onUp(e) {
    if (!this._marquee) return;
    const { x0, y0 } = this._marquee;
    this._marquee = null;
    this._hideMarquee();
    if (Math.abs(e.clientX - x0) < 4 && Math.abs(e.clientY - y0) < 4) return;  // a click, not a drag
    const picks = this._assetsInRect(x0, y0, e.clientX, e.clientY);
    if (picks.length) {
      const merged = e.shiftKey ? [...this.selected, ...picks.filter(p => !this.selected.includes(p))] : picks;
      this._setSelection(merged);
    }
  }

  _onKey(e) {
    if (!this.enabled || !this.selected.length) return;
    const t = e.target;                                    // ignore Delete/Esc while typing in a field
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.code === 'Delete') {
      this.deleteSelection();
    } else if (e.code === 'Escape') {
      this._clear();
    }
  }

  // ── Marquee helpers ──
  _showMarquee(x0, y0, x1, y1) {
    const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    Object.assign(this._rect.style, { display: 'block', left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
  }
  _hideMarquee() { this._rect.style.display = 'none'; }

  /** Assets whose projected centre falls inside the screen rectangle. */
  _assetsInRect(x0, y0, x1, y1) {
    const r = this.dom.getBoundingClientRect();
    const lx = Math.min(x0, x1), rx = Math.max(x0, x1), ty = Math.min(y0, y1), by = Math.max(y0, y1);
    const c = new THREE.Vector3(), box = new THREE.Box3();
    const out = [];
    for (const a of this.world.assets) {
      box.setFromObject(a.mesh); box.getCenter(c); c.project(this.camera);
      if (c.z < -1 || c.z > 1) continue;                          // behind the camera
      const sx = r.left + (c.x * 0.5 + 0.5) * r.width;
      const sy = r.top + (-c.y * 0.5 + 0.5) * r.height;
      if (sx >= lx && sx <= rx && sy >= ty && sy <= by) out.push(a);
    }
    return out;
  }
}
