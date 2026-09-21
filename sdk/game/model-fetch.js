/**
 * sdk/game/model-fetch.js — VOICE -> REAL 3D MODEL (B4). Turns a free-text object word ("tennis ball", "rubber duck",
 * "coffee mug") into a doctrine-ready prop body: a THREE object (centred, scaled so its largest dimension = size_m,
 * lights / cameras stripped, materials forced to MeshMatcapMaterial so it renders the same on every tile with no scene
 * lights — the cross-tile rule) plus a PropHull for SHAPE-vs-SHAPE collision. Node-safe (no DOM needed; the placeholder
 * label texture is browser-only and silently skipped elsewhere).
 *
 * Resolution order (ModelFetcher.resolve):
 *   1. local catalog (tennis | ball | basketball | apple | cube | glass_ball) -> procedural makers: ball-visuals.js
 *      makeBallMesh(kind, r) when that module exists (B2), else the tiny fallback makers below. Synchronous (local()).
 *   2. bundled GLBs by keyword (assets/*.glb, sdk/assets/props/*.glb)
 *   3. Sketchfab: search -> pick a downloadable model -> resolve the GLB URL -> download (with progress) -> parse.
 *      Goes through sdk/world/sketchfab.js (searchModels / resolveGLB, i.e. /api/sketchfab) by default; a custom
 *      { endpoint, fetch } (the dev proxy on :3334) uses the same query contract in-module. Resolved GLBs are cached in
 *      CacheStorage keyed by uid, and parsed templates are kept in memory (cloned per spawn).
 *   4. a labelled placeholder cube with the word on it — never a silent failure (status 'fallback').
 *
 * Status callbacks: onStatus({ kind, phase:'searching'|'downloading'|'parsing'|'ready'|'fallback'|'cancelled',
 *                              progress?:0..1, tier?, name?, uid?, error?, size_m?, dims? })
 *
 *   const fetcher = new ModelFetcher({ endpoint: proxyBase + '/api/sketchfab', onStatus: st => ui.modelStatus(st) });
 *   fetcher.preload();                                  // loads ball-visuals.js if present (optional)
 *   const built = await fetcher.resolve('rubber duck', { size_m: 0.09, signal, onStatus });
 *   // built = { tier, object, inner, hull, sphere, r, size_m, dims, name, uid?, url?, error? }
 */
import * as THREE from 'three';
import { PropHull } from '../core/prop-hull.js';
import { searchModels, resolveGLB } from '../world/sketchfab.js';

export const DEFAULT_ENDPOINT = '/api/sketchfab';
export const REPO_BASE = new URL('../../', import.meta.url).href;   // sdk/game/ -> the repo root (bundled GLB paths hang off it)
export const DEFAULT_SIZE_M = 0.09;                   // a hand prop
export const SIZE_MIN = 0.02, SIZE_MAX = 2.0;         // tools.json size_m range
export const MAX_FACES = 200000;                      // Sketchfab pick: prefer models at or under this
export const MAX_BYTES = 30e6;                        // refuse downloads bigger than this
export const SEARCH_COUNT = 12;
export const PLACEHOLDER_COLOR = '#9aa3ad';
export const CACHE_NAME = 'hopeos-models-v1';
export const HULL_SAMPLES = 6000;
export const SPHERE_TOL = 0.12;                       // radial spread / mean radius below this = an exact sphere hull

/** Category size defaults (largest dimension, metres) for known words; first match wins. */
export const SIZE_DEFAULTS = [
  [/tennis/, 0.067], [/basket ?ball/, 0.24], [/soccer|football/, 0.22], [/base ?ball/, 0.074], [/golf/, 0.043],
  [/ping ?pong|table tennis/, 0.04], [/bowling/, 0.22], [/beach ?ball/, 0.4], [/\bball\b|\borb\b|sphere/, 0.10],
  [/apple|orange|peach|pear|tomato|onion|lemon|lime|plum/, 0.08], [/banana/, 0.18], [/pineapple|melon|coconut/, 0.25],
  [/strawberry|cherry|grape|egg\b/, 0.05], [/duck/, 0.09], [/mug|cup|glass\b/, 0.10], [/bottle|can\b/, 0.24],
  [/phone|remote/, 0.15], [/book|tablet|laptop/, 0.25], [/\bkey\b|ring\b/, 0.06], [/coin/, 0.03], [/dice|\bdie\b/, 0.02],
  [/hammer|wrench|screwdriver|knife|spoon|fork/, 0.28], [/sword|katana|blade|lightsaber/, 0.9], [/\bbow\b/, 1.2],
  [/arrow/, 0.7], [/teddy|bear|plush|doll/, 0.25], [/shoe|sneaker|boot/, 0.28], [/butterfly|moth/, 0.06],
  [/bird|sparrow|robin|parrot|pigeon|crow|owl/, 0.15], [/\bcat\b|\bdog\b|puppy|kitten|rabbit|bunny|frog|turtle/, 0.3],
  [/\bcar\b|truck|bus\b|train/, 0.2], [/plane|airplane|rocket|drone/, 0.3], [/donut|doughnut|cookie|burger|pizza|cake/, 0.12],
  [/flower|rose|tulip/, 0.15], [/guitar|violin/, 1.0], [/chair|table|desk/, 0.9], [/lamp|vase|pot\b/, 0.35],
  [/skull|head|helmet|hat|cap\b/, 0.2], [/cube|box|block|crate/, 0.1], [/dinosaur|dragon/, 0.35], [/robot/, 0.3],
];
/** Tier 1: procedural makers (ball-visuals.js kinds). Order matters: tennis and basketball before the bare ball. */
export const CATALOG = [
  ['glass_ball', /\b(glass|crystal)\b.*\b(ball|orb|sphere)\b|\bslime\b|\borb\b/],
  ['basketball', /basket ?ball|b-ball/],
  ['tennis', /tennis/],
  ['apple', /\bapple\b/],
  ['cube', /\b(cube|box|block|dice|die)\b/],
  ['ball', /\bball\b/],
];
/** Tier 2: bundled GLBs by keyword (paths relative to the page / repo root). */
export const BUNDLED = [
  ['butterfly',  /butterfl|moth/,                                   'assets/butterfly.glb'],
  ['bird',       /\b(bird|sparrow|robin|parrot|pigeon|crow|owl)\b/, 'assets/bird.glb'],
  ['sword',      /sword|katana|blade|lightsaber/,                   'assets/utrm_3_0_sword.glb'],
  ['bow',        /\bbow\b/,                                         'sdk/assets/props/bow.glb'],
  ['arrow',      /\barrow\b/,                                       'sdk/assets/props/arrow.glb'],
  ['basketball', /basket ?ball/,                                    'assets/basketball.glb'],
];
const CATALOG_COLORS = { tennis: '#d4e94a', ball: '#f2f2f2', basketball: '#e0762b', apple: '#d7263d', cube: '#3ddc97', glass_ball: '#b3e5fc' };

const clampSize = s => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Number(s) || DEFAULT_SIZE_M));

/** 'A Rubber  Duck!' -> 'rubber duck'; '' when nothing is left. */
export function normaliseKind(kind) {
  return String(kind ?? '').toLowerCase().replace(/[^a-z0-9 _-]+/g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(a|an|the|some|my) /, '').trim();
}
/** id-safe slug: 'rubber duck' -> 'rubber_duck'. */
export function slugKind(kind) { return normaliseKind(kind).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'thing'; }

/** Which tier a word resolves through: { tier:'catalog'|'bundled'|'sketchfab', key, path? }. */
export function classifyKind(kind, bundled = BUNDLED) {
  const w = normaliseKind(kind);
  for (const [key, rx] of CATALOG) if (rx.test(w)) return { tier: 'catalog', key };
  for (const [key, rx, path] of bundled) if (rx.test(w)) return { tier: 'bundled', key, path };
  return { tier: 'sketchfab', key: w };
}
/** Largest-dimension default (metres) for a word. */
export function sizeFor(kind) {
  const w = normaliseKind(kind);
  for (const [rx, s] of SIZE_DEFAULTS) if (rx.test(w)) return s;
  return DEFAULT_SIZE_M;
}

// ── matcap: one procedurally shaded sphere texture shared by every fetched prop (no scene lights needed) ─────
let _matcap = null;
export function matcapTexture() {
  if (_matcap) return _matcap;
  const N = 128, data = new Uint8Array(N * N * 4);
  const L = new THREE.Vector3(-0.35, 0.55, 0.75).normalize();
  const H = L.clone().add(new THREE.Vector3(0, 0, 1)).normalize();
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N * 2 - 1, v = (j + 0.5) / N * 2 - 1, r2 = u * u + v * v;
    let shade = 0.2;
    if (r2 <= 1) {
      const nz = Math.sqrt(1 - r2);
      const ndl = Math.max(0, u * L.x + v * L.y + nz * L.z), ndh = Math.max(0, u * H.x + v * H.y + nz * H.z);
      shade = 0.34 + 0.6 * ndl + 0.28 * Math.pow(ndh, 30) + 0.12 * Math.pow(1 - nz, 3);
    }
    const c = Math.round(Math.min(1, Math.pow(Math.min(1.4, shade), 1 / 2.2)) * 255);
    const o = (j * N + i) * 4; data[o] = c; data[o + 1] = c; data[o + 2] = c; data[o + 3] = 255;
  }
  _matcap = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _matcap.colorSpace = THREE.SRGBColorSpace;
  _matcap.needsUpdate = true;
  return _matcap;
}
/** Every mesh material -> MeshMatcapMaterial (colour + albedo map kept, lighting dropped); layer 0, never culled. */
export function toMatcap(obj) {
  const tex = matcapTexture();
  obj.traverse(m => {
    if (!m.isMesh) return;
    const conv = src => {
      const mat = new THREE.MeshMatcapMaterial({
        matcap: tex,
        color: src && src.color ? src.color.clone() : new THREE.Color(PLACEHOLDER_COLOR),
        map: (src && src.map) || null,
        transparent: !!(src && src.transparent && src.opacity < 1),
        opacity: src && src.opacity != null ? src.opacity : 1,
        side: src && src.side != null ? src.side : THREE.FrontSide,
        alphaTest: (src && src.alphaTest) || 0,
        vertexColors: !!(src && src.vertexColors),
      });
      mat.userData.baseColor = mat.color.clone();
      return mat;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    m.frustumCulled = false; m.layers.set(0); m.renderOrder = 30; m.castShadow = false; m.receiveShadow = false;
  });
  return obj;
}

/** Centre the object, scale it so the largest bbox dimension = size_m, strip lights / cameras. Returns the wrapper
 *  Group (the prop's `mesh`) with the raw object inside it: { object, inner, size_m, dims, r }. */
export function normaliseModel(raw, size_m) {
  size_m = clampSize(size_m);
  const junk = [];
  raw.traverse(o => { if (o.isLight || o.isCamera) junk.push(o); });
  for (const o of junk) o.removeFromParent();
  raw.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(raw);
  const dims = box.isEmpty() ? new THREE.Vector3(size_m, size_m, size_m) : box.getSize(new THREE.Vector3());
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(dims.x, dims.y, dims.z);
  const s = maxDim > 1e-9 ? size_m / maxDim : 1;
  raw.scale.multiplyScalar(s);
  raw.position.multiplyScalar(s).addScaledVector(c, -s);          // world' = s * (world - centre)
  const wrap = new THREE.Group();
  wrap.add(raw);
  wrap.frustumCulled = false; wrap.layers.set(0);
  wrap.updateMatrixWorld(true);
  return { object: wrap, inner: raw, size_m, dims: [dims.x * s, dims.y * s, dims.z * s], r: size_m / 2 };
}

/** PropHull for a normalised object: an EXACT sphere when the vertex cloud is spherical (a capsule chain baked from a
 *  sphere over-reaches along its primary axis), else PropHull.fromObject's capsule chain. Falls back to a sphere of the
 *  bounding radius for degenerate clouds. Returns { hull, sphere, r, samples }. */
export function buildHull(object, r, { sphereTol = SPHERE_TOL, maxSamples = HULL_SAMPLES, bins = 14 } = {}) {
  object.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const pts = [];
  object.traverse(m => {
    if (!m.isMesh || !m.geometry) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / maxSamples));
    for (let v = 0; v < pos.count; v += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(m.matrixWorld).applyMatrix4(inv));
  });
  if (pts.length < 8) return { hull: PropHull.sphere(r), sphere: true, r, samples: pts.length };
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  let mean = 0;
  const d = pts.map(p => p.distanceTo(c));
  for (const v of d) mean += v;
  mean /= d.length;
  let sd = 0;
  for (const v of d) sd += (v - mean) * (v - mean);
  sd = Math.sqrt(sd / d.length);
  const box = new THREE.Box3().setFromPoints(pts), dims = box.getSize(new THREE.Vector3());
  const aspect = Math.min(dims.x, dims.y, dims.z) / Math.max(1e-9, dims.x, dims.y, dims.z);
  if (mean > 1e-6 && sd / mean < sphereTol && aspect > 0.8) {
    const hull = new PropHull([{ a: c.clone(), b: c.clone(), ra: mean, rb: mean }]);
    return { hull, sphere: true, r: mean, samples: pts.length };
  }
  const chain = PropHull.fromPoints(pts, { bins });
  if (chain) return { hull: chain, sphere: false, r, samples: pts.length };
  return { hull: PropHull.sphere(r), sphere: true, r, samples: pts.length };
}

// ── tier 4: the labelled placeholder cube ───────────────────────────────────────────────────────────────────
function labelTexture(word, sub = 'loading model…') {
  if (typeof document === 'undefined') return null;
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = PLACEHOLDER_COLOR; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#5b6570'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 246);
    g.fillStyle = '#161a1f'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const words = word.split(' '), lines = [];
    let line = '';
    for (const w of words) { if ((line + ' ' + w).trim().length > 12 && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim(); }
    if (line) lines.push(line);
    let size = lines.length > 1 ? 40 : 46;
    g.font = `bold ${size}px system-ui, sans-serif`;
    while (lines.some(l => g.measureText(l).width > 216) && size > 14) { size -= 3; g.font = `bold ${size}px system-ui, sans-serif`; }
    const y0 = 128 - (lines.length - 1) * size * 0.6;
    lines.forEach((l, i) => g.fillText(l, 128, y0 + i * size * 1.2));
    g.font = '22px system-ui, sans-serif'; g.fillStyle = '#2f3740';
    if (sub) g.fillText(sub, 128, 222);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.userData.own = true;
    return tex;
  } catch { return null; }
}
/** A cube with the word written on every face; sphere hull (0.6 x side: between the inscribed and circumscribed
 *  spheres) so hands stop at it like any prop until the real model replaces it. */
export function makePlaceholder(word, size_m) {
  const s = clampSize(size_m);
  const geo = new THREE.BoxGeometry(s, s, s);
  const mat = new THREE.MeshMatcapMaterial({ matcap: matcapTexture(), color: new THREE.Color(PLACEHOLDER_COLOR), map: labelTexture(word) });
  mat.userData.baseColor = mat.color.clone();
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false; m.layers.set(0); m.renderOrder = 30;
  m.userData.placeholder = true;
  const wrap = new THREE.Group();
  wrap.add(m);
  wrap.frustumCulled = false; wrap.layers.set(0); wrap.updateMatrixWorld(true);
  return { tier: 'placeholder', object: wrap, inner: m, hull: PropHull.sphere(s * 0.6), sphere: true, r: s / 2, size_m: s, dims: [s, s, s], name: word, color: PLACEHOLDER_COLOR };
}
/** Redraw a placeholder's label (e.g. after a fallback: 'no model found'). Browser only; returns false elsewhere / no cube. */
export function relabelPlaceholder(object, word, sub) {
  let cube = null;
  if (object) object.traverse(o => { if (o.isMesh && o.userData.placeholder) cube = o; });
  if (!cube) return false;
  const tex = labelTexture(word, sub);
  if (!tex) return false;
  const mats = Array.isArray(cube.material) ? cube.material : [cube.material];
  for (const mat of mats) {
    if (mat.map && mat.map.userData && mat.map.userData.own) mat.map.dispose();
    mat.map = tex; mat.needsUpdate = true;
  }
  return true;
}

// ── tier 1 fallback makers (ball-visuals.js replaces these when present) ────────────────────────────────────
function fallbackCatalogMesh(key, r) {
  const color = new THREE.Color(CATALOG_COLORS[key] || PLACEHOLDER_COLOR);
  const mat = new THREE.MeshMatcapMaterial({ matcap: matcapTexture(), color, transparent: key === 'glass_ball', opacity: key === 'glass_ball' ? 0.75 : 1 });
  mat.userData.baseColor = color.clone();
  const geo = key === 'cube' ? new THREE.BoxGeometry(2 * r, 2 * r, 2 * r) : new THREE.SphereGeometry(r, 28, 20);
  return new THREE.Mesh(geo, mat);
}
/** Free the GPU side of a Built (a placeholder or a fetched instance that was never spawned). */
export function disposeBuilt(b) {
  if (!b || !b.object) return;
  const shared = !!b.object.userData.shared;
  b.object.traverse(m => {
    if (!m.isMesh) return;
    if (!shared && m.geometry) m.geometry.dispose();
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
      if (!mat) continue;
      if (mat.map && mat.map.userData && mat.map.userData.own) mat.map.dispose();
      mat.dispose();
    }
  });
  b.object.removeFromParent();
}

/** Same query contract as api/sketchfab.js, bound to a custom endpoint / fetch (dev proxy on :3334, tests). */
export function sketchfabApi(endpoint = DEFAULT_ENDPOINT, fetchFn = globalThis.fetch) {
  return {
    async search(q, count = SEARCH_COUNT) {
      const res = await fetchFn(`${endpoint}?op=search&q=${encodeURIComponent(q)}&count=${count}`);
      if (!res.ok) throw new Error(`search ${res.status}`);
      const data = await res.json();
      return (data.results || []).map(m => ({ uid: m.uid, name: m.name || 'untitled', downloadable: m.isDownloadable !== false, faces: m.faceCount || 0, author: (m.user && (m.user.displayName || m.user.username)) || '' }));
    },
    async resolve(uid) {
      const res = await fetchFn(`${endpoint}?op=resolve&uid=${encodeURIComponent(uid)}`);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const d = await res.json();
      const link = d.glb && d.glb.url;
      if (!link) throw new Error(d.error || 'no glb in response');
      return link;
    },
  };
}
/** The sdk/world/sketchfab.js pair (relative /api/sketchfab, global fetch) — the deployed-page path. */
export const sdkSketchfab = {
  async search(q, count = SEARCH_COUNT) { const r = await searchModels(q, { count }); return r.results; },
  async resolve(uid) { return resolveGLB(uid); },
};

export class ModelFetcher {
  /**
   * @param {object} o
   *   endpoint   '/api/sketchfab' (default: sdk/world/sketchfab.js is used) or e.g. 'http://localhost:3334/api/sketchfab'
   *   fetch      fetch implementation (tests); with the default endpoint it also swaps sdkSketchfab for the bound pair
   *   sketchfab  { search(q,count) -> [{uid,name,downloadable,faces}], resolve(uid) -> url }  full override
   *   loadBytes  (url, { onProgress, signal }) => ArrayBuffer   override for Node (bundled GLBs from disk)
   *   assetBase  prefix for bundled paths (default REPO_BASE = the repo root, resolved from this module's URL)
   *   bundled    keyword table (default BUNDLED)
   *   caches     CacheStorage-like (default: globalThis.caches when present); cacheName null disables the cache
   *   onStatus   status sink for every request (per-request onStatus is called too)
   *   parse      (arrayBuffer) => Promise<{ scene }>  override for the GLTF parse (tests)
   */
  constructor(o = {}) {
    this.endpoint = o.endpoint || DEFAULT_ENDPOINT;
    this.fetch = o.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.sketchfab = o.sketchfab || ((this.endpoint === DEFAULT_ENDPOINT && !o.fetch) ? sdkSketchfab : sketchfabApi(this.endpoint, this.fetch));
    this.loadBytes = o.loadBytes || null;
    this.assetBase = o.assetBase || REPO_BASE;             // bundled paths resolve against the repo root, whatever page imports us
    this.bundled = o.bundled || BUNDLED;
    this.caches = o.caches !== undefined ? o.caches : (typeof caches !== 'undefined' ? caches : null);
    this.cacheName = o.cacheName === undefined ? CACHE_NAME : o.cacheName;
    this.onStatus = o.onStatus || null;
    this.maxFaces = o.maxFaces || MAX_FACES;
    this.maxBytes = o.maxBytes || MAX_BYTES;
    this.parse = o.parse || null;
    this.templates = new Map();                       // key -> Promise<{ scene, skinned }>: parsed once, cloned per spawn
    this.visuals = null; this._visualsP = null;       // ball-visuals.js (B2) when present
    this._loaderP = null;
    this.stats = { searches: 0, downloads: 0, cacheHits: 0, fallbacks: 0 };
  }

  /** Load ball-visuals.js (B2) if it exists; resolves to the module or null. Safe to call many times. */
  preload() {
    if (!this._visualsP) this._visualsP = import('./ball-visuals.js').then(m => { this.visuals = m; return m; }).catch(() => null);
    return this._visualsP;
  }
  sizeFor(kind) { return sizeFor(kind); }
  classify(kind) { return classifyKind(kind, this.bundled); }

  /** Tier 1, synchronous: a procedural catalog prop or null when the word is not a catalog kind. */
  local(kind, size_m) {
    const k = this.classify(kind);
    if (k.tier !== 'catalog') return null;
    const s = clampSize(size_m == null ? this.sizeFor(kind) : size_m), r = s / 2;
    let m = null;
    const b2 = { tennis: 'tennis', ball: 'tennis', basketball: 'basketball', apple: 'apple', glass_ball: 'glass' }[k.key];   // ball-visuals.js kinds (cube: fallback box)
    if (b2 && this.visuals && typeof this.visuals.makeBallMesh === 'function') { try { m = this.visuals.makeBallMesh(b2, r) || null; } catch { m = null; } }
    if (!m) m = fallbackCatalogMesh(k.key, r);
    m.frustumCulled = false; m.layers.set(0); m.renderOrder = 30;
    const wrap = new THREE.Group();
    wrap.add(m);
    wrap.frustumCulled = false; wrap.layers.set(0); wrap.updateMatrixWorld(true);
    const color = CATALOG_COLORS[k.key] || PLACEHOLDER_COLOR;
    return { tier: 'catalog', object: wrap, inner: m, hull: PropHull.sphere(r), sphere: true, r, size_m: s, dims: [s, s, s], name: k.key, color };
  }

  /**
   * Tiers 1-4. Never rejects: a failure resolves to the placeholder (tier 'placeholder', status 'fallback'); an abort
   * resolves to null (status 'cancelled').
   */
  async resolve(kind, opts = {}) {
    const word = normaliseKind(kind) || 'thing';
    const size_m = clampSize(opts.size_m == null ? this.sizeFor(word) : opts.size_m);
    const emit = st => {
      const s = { kind: word, ...st };
      try { if (opts.onStatus) opts.onStatus(s); } catch { /* UI errors never break the fetch */ }
      try { if (this.onStatus) this.onStatus(s); } catch { /* same */ }
    };
    const k = this.classify(word);
    if (k.tier === 'catalog') {
      const b = this.local(word, size_m);
      emit({ phase: 'ready', tier: 'catalog', name: k.key, size_m, dims: b.dims, progress: 1 });
      return b;
    }
    try {
      if (k.tier === 'bundled') {
        emit({ phase: 'downloading', tier: 'bundled', name: k.key, progress: 0 });
        const tpl = await this._template('bundled:' + k.path, () =>
          this._bytes(this.assetBase + k.path, { signal: opts.signal, onProgress: p => emit({ phase: 'downloading', tier: 'bundled', name: k.key, progress: p }) }));
        this._checkAbort(opts.signal);
        return this._instance(tpl, size_m, { tier: 'bundled', name: k.key, url: k.path }, emit);
      }
      emit({ phase: 'searching', tier: 'sketchfab', progress: 0 });
      this.stats.searches++;
      const pick = await this._pick(word);
      this._checkAbort(opts.signal);
      if (!pick) throw new Error(`no downloadable model for "${word}"`);
      emit({ phase: 'searching', tier: 'sketchfab', uid: pick.uid, name: pick.name, progress: 1 });
      const tpl = await this._template('sf:' + pick.uid, async () => {
        const hit = await this._cacheGet(pick.uid);
        if (hit) { this.stats.cacheHits++; emit({ phase: 'downloading', tier: 'sketchfab', uid: pick.uid, name: pick.name, progress: 1, cached: true }); return hit; }
        const url = await this.sketchfab.resolve(pick.uid);
        this._checkAbort(opts.signal);
        this.stats.downloads++;
        const bytes = await this._bytes(url, { signal: opts.signal, proxyFallback: true, onProgress: p => emit({ phase: 'downloading', tier: 'sketchfab', uid: pick.uid, name: pick.name, progress: p }) });
        await this._cachePut(pick.uid, bytes);
        return bytes;
      });
      this._checkAbort(opts.signal);
      return this._instance(tpl, size_m, { tier: 'sketchfab', name: pick.name, uid: pick.uid, author: pick.author, faces: pick.faces }, emit);
    } catch (e) {
      if (opts.signal && opts.signal.aborted) { emit({ phase: 'cancelled' }); return null; }
      const error = (e && e.message) || String(e);
      this.stats.fallbacks++;
      emit({ phase: 'fallback', tier: 'placeholder', error, size_m });
      return { ...makePlaceholder(word, size_m), error };
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────────
  _checkAbort(signal) { if (signal && signal.aborted) throw new Error('cancelled'); }
  /** Best search hit: downloadable, at or under maxFaces if any qualify, else the lightest. */
  async _pick(word) {
    const list = (await this.sketchfab.search(word, SEARCH_COUNT)) || [];
    const dl = list.filter(m => m && m.uid && m.downloadable !== false);
    if (!dl.length) return null;
    const fit = dl.filter(m => !(m.faces > this.maxFaces));
    return fit.length ? fit[0] : dl.slice().sort((a, b) => (a.faces || 0) - (b.faces || 0))[0];
  }
  _template(key, getBytes) {
    if (!this.templates.has(key)) {
      const p = (async () => {
        const bytes = await getBytes();
        const gltf = await this._parse(bytes);
        const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!scene) throw new Error('empty glb');
        let skinned = false;
        scene.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
        return { scene, skinned, bytes: bytes.byteLength };
      })().catch(e => { this.templates.delete(key); throw e; });
      this.templates.set(key, p);
    }
    return this.templates.get(key);
  }
  async _loader() {
    if (!this._loaderP) this._loaderP = Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/utils/SkeletonUtils.js')])
      .then(([g, s]) => ({ loader: new g.GLTFLoader(), cloneSkinned: s.clone }));
    return this._loaderP;
  }
  async _parse(bytes) {
    if (this.parse) return this.parse(bytes);
    const { loader } = await this._loader();
    return new Promise((res, rej) => { try { loader.parse(bytes, '', res, rej); } catch (e) { rej(e); } });
  }
  async _instance(tpl, size_m, meta, emit) {
    emit({ phase: 'parsing', ...meta, progress: 1 });
    let raw;
    if (tpl.skinned) { const { cloneSkinned } = await this._loader(); raw = cloneSkinned(tpl.scene); }
    else raw = tpl.scene.clone(true);
    const n = normaliseModel(raw, size_m);
    toMatcap(n.object);
    n.object.userData.shared = true;                  // geometries belong to the template: dispose materials only
    const h = buildHull(n.object, n.r);
    const built = { tier: meta.tier, object: n.object, inner: n.inner, hull: h.hull, sphere: h.sphere, r: n.r, size_m: n.size_m, dims: n.dims,
      name: meta.name, uid: meta.uid || null, url: meta.url || null, author: meta.author || '', faces: meta.faces || 0, bytes: tpl.bytes, hullSamples: h.samples };
    emit({ phase: 'ready', ...meta, size_m: n.size_m, dims: n.dims, sphere: h.sphere, progress: 1 });
    return built;
  }
  /** Download with progress; direct first, then the proxy's op=fetch passthrough when the S3 link is CORS-restricted. */
  async _bytes(url, { onProgress, signal, proxyFallback = false } = {}) {
    if (this.loadBytes) return this.loadBytes(url, { onProgress, signal });
    if (!this.fetch) throw new Error('no fetch');
    let res;
    try { res = await this.fetch(url, { signal }); }
    catch (e) {
      if (!proxyFallback || (signal && signal.aborted)) throw e;
      res = await this.fetch(`${this.endpoint}?op=fetch&url=${encodeURIComponent(url)}`, { signal });
    }
    if (!res.ok) throw new Error(`download ${res.status}`);
    const total = +(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
    if (total > this.maxBytes) throw new Error(`model too large (${Math.round(total / 1e6)} MB)`);
    if (!res.body || typeof res.body.getReader !== 'function') { const ab = await res.arrayBuffer(); if (onProgress) onProgress(1); return ab; }
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.byteLength;
      if (got > this.maxBytes) { try { reader.cancel(); } catch { /* stream already closed */ } throw new Error('model too large'); }
      if (onProgress) onProgress(total ? Math.min(0.99, got / total) : 0.5);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    if (onProgress) onProgress(1);
    return out.buffer;
  }
  _cacheKey(uid) { return `/_models/${encodeURIComponent(uid)}.glb`; }
  async _cacheGet(uid) {
    if (!this.caches || !this.cacheName) return null;
    try { const c = await this.caches.open(this.cacheName); const r = await c.match(this._cacheKey(uid)); return r ? await r.arrayBuffer() : null; }
    catch { return null; }
  }
  async _cachePut(uid, bytes) {
    if (!this.caches || !this.cacheName) return false;
    try { const c = await this.caches.open(this.cacheName); await c.put(this._cacheKey(uid), new Response(bytes, { headers: { 'content-type': 'model/gltf-binary' } })); return true; }
    catch { return false; }
  }
}
