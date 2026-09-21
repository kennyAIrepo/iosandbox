/**
 * stage-renderer.js — design S: ONE transparent WebGL surface over the whole gallery, one scene, one scissored
 * viewport + one PerspectiveCamera per tile (research/gaps/render-budget/decision.md §1-§4, render-budget.html
 * "three.js: per design" block). Browser only (three.js via the page importmap).
 *
 *   - world = stage space (court-space.js): camera i sits at the world position of tile i's centre, looking down -z,
 *     `PerspectiveCamera(FOV, tw/th, 0.01, 50)` with `setViewOffset(tw, th, -gap/2, -gap/2, tw+gap, th+gap)` — the
 *     viewport is the tile grown by gap/2 on every side, so adjacent viewports tile the stage without overlap and a ball
 *     in the gutter is drawn by BOTH halves at the same th/U px per metre (no pop by construction, decision.md §2);
 *   - layers: rigs of tile i on layer 1+i (`assignLayer` — mesh AND occluder twin, the judge fix), ball / ghost / props /
 *     lights on layer 0, which every camera sees; every surface mesh is frustumCulled=false (HoloHandRig already is);
 *   - the ball is a MeshMatcapMaterial (`ballMaterial()`): shading indexed by the view-space normal, identical from every
 *     eye, so the two half-gutter passes agree pixel for pixel (decision.md §2 "shading rule");
 *   - contexts: this renderer is exactly ONE WebGL context; landmarkers register theirs (`registerContext`) so the page
 *     can keep the sum under Chrome's 16-context eviction cap (decision.md §4);
 *   - context loss: `webglcontextlost` → preventDefault, dispose, rebuild the renderer on a FRESH canvas (a context lost
 *     through WEBGL_lose_context on the same canvas only comes back via restoreContext(), never via a new renderer), then
 *     the page's callback re-registers what it needs.
 */
import * as THREE from 'three';
import { FOV, D, U } from './court-space.js';

const MATCAP_STOPS = [[0, '#dfe1ff'], [0.35, '#8b90f2'], [0.85, '#3d41a8'], [1, '#22245c']];   // render-budget.html:187-193

/**
 * Stale / ghost cue on a HoloHandRig without touching the occluder twin: the ghost shader ignores Material.opacity, so the
 * rig's own `uAlpha` uniform is scaled from the value it was built with (remembered on first call); `material.opacity` and
 * `transparent` are set as well so any plain material (a 'flesh' look, an external mesh) fades the same way.
 */
export function setRigAlpha(rig, alpha) {
  if (!rig || !rig.mesh) return;
  const a = Math.max(0, Math.min(1, +alpha || 0));
  const m = rig.mesh.material;
  if (m) { m.transparent = true; m.opacity = a; }
  if (rig.uniforms && rig.uniforms.uAlpha) {
    if (rig._stageBaseAlpha === undefined) rig._stageBaseAlpha = rig.uniforms.uAlpha.value;
    rig.uniforms.uAlpha.value = rig._stageBaseAlpha * a;
  }
  rig.alpha = a;
}

export class StageRenderer {
  /**
   * @param {HTMLCanvasElement} canvas   the stage-sized surface (position:absolute over the gallery, pointer-events:none)
   * @param {{fov?:number, d?:number, gap?:number, maxDpr?:number}} o
   */
  constructor(canvas, { fov = FOV, d = D, gap = 8, maxDpr = 1.5 } = {}) {
    this.canvas = canvas;
    this.fov = fov; this.d = d; this.gap = gap; this.maxDpr = maxDpr;
    this.stageW = canvas.clientWidth || canvas.width || 1; this.stageH = canvas.clientHeight || canvas.height || 1;
    this.th = 0; this.tw = 0;
    this.tiles = new Map();                 // i -> { cam, uvCam, vp, layer, rect }
    this.scene = new THREE.Scene();
    this._lights();
    this._matcap = null; this._ballMat = null;
    this._extraContexts = 0;
    this._lostCb = null; this._lost = 0; this.rebuilds = 0;
    this.renderer = null;
    this._onLost = (e) => this._handleLost(e);
    this._build();
  }

  // ── renderer lifecycle ────────────────────────────────────────────────────
  _build() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setClearColor(0, 0);
    r.autoClear = false;
    r.info.autoReset = false;
    r.setScissorTest(true);
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    this._applySize();
    this.canvas.addEventListener('webglcontextlost', this._onLost, false);
  }

  _applySize() {
    if (!this.renderer) return;
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, this.maxDpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.stageW, this.stageH, true);
  }

  _handleLost(e) {
    if (e && e.preventDefault) e.preventDefault();
    this._lost++;
    const old = this.canvas;
    old.removeEventListener('webglcontextlost', this._onLost, false);
    try { this.renderer && this.renderer.dispose(); } catch (_) { /* a lost context may throw on dispose */ }
    this.renderer = null;
    // a fresh canvas in the old one's place: same id / class / inline style, so the CSS stacking and size carry over
    const fresh = document.createElement('canvas');
    if (old.id) fresh.id = old.id;
    if (old.className) fresh.className = old.className;
    if (old.getAttribute('style')) fresh.setAttribute('style', old.getAttribute('style'));
    for (const a of ['aria-hidden', 'role', 'data-layer']) if (old.hasAttribute(a)) fresh.setAttribute(a, old.getAttribute(a));
    fresh.width = old.width; fresh.height = old.height;
    if (old.parentNode) old.parentNode.replaceChild(fresh, old);
    this.canvas = fresh;
    this._build();
    this.rebuilds++;
    if (this._lostCb) { try { this._lostCb(this); } catch (err) { console.error('[stage] onContextLost callback', err); } }
  }

  /** Register the page's rebuild hook (re-register landmarker contexts, re-read `stage.canvas`). */
  onContextLost(cb) { this._lostCb = cb; }

  _lights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 1.2);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(1, 2, 1);
    hemi.layers.set(0); dir.layers.set(0);
    this.scene.add(hemi, dir);
    this.lights = { hemi, dir };
  }

  // ── layout ────────────────────────────────────────────────────────────────
  /** The stage element's CSS size and the gallery rule's tile size (one th per viewer, layout-spec s2). */
  resize(stageW, stageH, th, tw) {
    this.stageW = Math.max(1, stageW | 0); this.stageH = Math.max(1, stageH | 0);
    if (th) this.th = th;
    if (tw) this.tw = tw;
    this._applySize();
    for (const [i, t] of this.tiles) this.tileCamera(i, t.rect);     // cameras follow the stage size
  }

  /**
   * Camera + viewport for tile i whose DOM rect (relative to the stage element, CSS px) is `rect`.
   * @returns {{cam:THREE.PerspectiveCamera, uvCam:THREE.PerspectiveCamera, vp:{x,y,w,h}, layer:number}}
   */
  tileCamera(i, rect) {
    const tw = rect.width, th = rect.height, gap = this.gap;
    const scaleTh = this.th || th;                                  // px per court unit (= tile height)
    const cx = rect.left + tw / 2, cy = rect.top + th / 2;
    const wx = (cx - this.stageW / 2) / scaleTh * U, wy = (this.stageH / 2 - cy) / scaleTh * U;
    let t = this.tiles.get(i);
    if (!t) {
      t = { cam: new THREE.PerspectiveCamera(this.fov, tw / th, 0.01, 50), uvCam: new THREE.PerspectiveCamera(this.fov, tw / th, 0.01, 50), vp: { x: 0, y: 0, w: 0, h: 0 }, layer: 1 + i, rect: null, i };
      this.tiles.set(i, t);
    }
    t.rect = { left: rect.left, top: rect.top, width: tw, height: th };
    const { cam, uvCam } = t;
    cam.fov = this.fov; cam.aspect = tw / th;
    cam.position.set(wx, wy, 0);
    cam.rotation.set(0, 0, 0);
    // half-gutter extension: the frustum grows with the viewport, the tile rect itself still maps u,v in [0,1]
    cam.setViewOffset(tw, th, -gap / 2, -gap / 2, tw + gap, th + gap);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    cam.layers.set(0); cam.layers.enable(1 + i);
    // the uv camera: same fov / aspect / position, NO view offset — CourtMap.worldToTile / packToHands read this one
    uvCam.fov = this.fov; uvCam.aspect = tw / th; uvCam.near = 0.01; uvCam.far = 50;
    if (uvCam.view) uvCam.clearViewOffset();
    uvCam.position.set(wx, wy, 0);
    uvCam.rotation.set(0, 0, 0);
    uvCam.updateProjectionMatrix();
    uvCam.updateMatrixWorld(true);
    // GL viewport / scissor: y from the bottom
    t.vp.x = rect.left - gap / 2;
    t.vp.y = this.stageH - (rect.top - gap / 2) - (th + gap);
    t.vp.w = tw + gap;
    t.vp.h = th + gap;
    t.layer = 1 + i;
    return t;
  }

  releaseTile(i) { this.tiles.delete(i); }

  // ── layers / looks ────────────────────────────────────────────────────────
  /** Rigs of tile i → layer 1+i: the ghost mesh AND its depth-only occluder twin (both live in rig.grp). */
  assignLayer(rig, layer) {
    if (!rig || !rig.grp) return;
    rig.grp.traverse(o => o.layers.set(layer));
  }

  setRigAlpha(rig, alpha) { setRigAlpha(rig, alpha); }

  /** The radial-gradient matcap (render-budget.html:187-193): the same disc from every eye. Cached; one per stage. */
  ballMaterial() {
    if (this._ballMat) return this._ballMat;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(96, 88, 8, 128, 128, 128);
    for (const [k, col] of MATCAP_STOPS) g.addColorStop(k, col);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._matcap = tex;
    this._ballMat = new THREE.MeshMatcapMaterial({ matcap: tex });
    return this._ballMat;
  }

  /** A ready-to-add ball mesh on layer 0, never frustum culled (radius in metres = court.R · U). */
  ballMesh(radius, segments = 32) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.75)), this.ballMaterial());
    m.frustumCulled = false;
    m.layers.set(0);
    return m;
  }

  // ── frame ─────────────────────────────────────────────────────────────────
  /**
   * One frame: full-stage scissor+viewport clear, then per tile setViewport/setScissor(vp) + render(scene, cam).
   * @param {Iterable<{cam, vp}>} [tiles]   defaults to every tile registered through tileCamera()
   */
  render(tiles) {
    const r = this.renderer;
    if (!r) return;
    const list = tiles || this.tiles.values();
    r.info.reset();
    r.setViewport(0, 0, this.stageW, this.stageH);
    r.setScissor(0, 0, this.stageW, this.stageH);
    r.clear();
    for (const t of list) {
      if (!t || !t.cam || !t.vp) continue;
      const vp = t.vp;
      r.setViewport(vp.x, vp.y, vp.w, vp.h);
      r.setScissor(vp.x, vp.y, vp.w, vp.h);
      r.render(this.scene, t.cam);
    }
  }

  // ── budget ────────────────────────────────────────────────────────────────
  /** Live WebGL contexts on the page that this stage knows about: its renderer + registered landmarkers. */
  contexts() { return (this.renderer ? 1 : 0) + this._extraContexts; }
  registerContext(n = 1) { this._extraContexts = Math.max(0, this._extraContexts + n); return this.contexts(); }

  info() {
    const i = this.renderer ? this.renderer.info.render : { calls: 0, triangles: 0 };
    return { calls: i.calls, triangles: i.triangles, contexts: this.contexts(), rebuilds: this.rebuilds };
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost, false);
    if (this._ballMat) { this._ballMat.dispose(); this._ballMat = null; }
    if (this._matcap) { this._matcap.dispose(); this._matcap = null; }
    if (this.renderer) { try { this.renderer.dispose(); } catch (_) { /* lost */ } this.renderer = null; }
    this.tiles.clear();
  }
}

export { THREE };
