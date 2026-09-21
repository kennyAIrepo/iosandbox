/**
 * tests/model-fetch-smoke.mjs — Node smoke test for sdk/game/model-fetch.js + sdk/game/prop-body.js (B4: voice -> real 3D model).
 * No browser, no token: the catalog + bundled tiers run offline; the Sketchfab tier runs against a MOCKED /api/sketchfab
 * (search JSON -> uid -> resolve URL -> a tiny local GLB fixture served by the mocked fetch); CacheStorage is a mock.
 * A LIVE check (network permitting, no token needed) hits api.sketchfab.com search and, if a sandbox proxy can bind a
 * port, the proxy's /api/sketchfab passthrough; both are reported as skipped (not failed) when offline.
 *
 *   node tests/model-fetch-smoke.mjs      (from the repo root)
 */
import * as THREE from 'three';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ModelFetcher, classifyKind, normaliseKind, slugKind, sizeFor, normaliseModel, buildHull, toMatcap, makePlaceholder, matcapTexture,
  sketchfabApi, disposeBuilt, DEFAULT_SIZE_M, CATALOG, BUNDLED,
} from '../sdk/game/model-fetch.js';
import { PropBody } from '../sdk/game/prop-body.js';
import { PropBall } from '../sdk/game/prop-ball.js';
import { PropHull } from '../sdk/core/prop-hull.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
let pass = 0, fail = 0, skipped = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + ' ' + extra); } else { fail++; console.error('  FAIL ' + name + ' ' + extra); } };
const skip = (name, why) => { skipped++; console.log('  skip ' + name + ' (' + why + ')'); };

// ── Node shims so GLTFLoader can parse TEXTURED GLBs here (images become 1x1 stubs; geometry is what we test) ───────
globalThis.self = globalThis.self || globalThis;
if (typeof document === 'undefined') {
  const fakeImage = () => {
    const l = {};
    return { width: 1, height: 1, complete: true, naturalWidth: 1,
      addEventListener(t, f) { l[t] = f; }, removeEventListener(t) { delete l[t]; },
      set src(v) { this._src = v; setTimeout(() => l.load && l.load.call(this), 0); }, get src() { return this._src; } };
  };
  globalThis.document = { createElementNS: () => fakeImage(), createElement: () => fakeImage() };
}
if (typeof Image === 'undefined') {                                  // EXT_texture_webp / avif detectSupport() probes `new Image()`
  globalThis.Image = class { constructor() { this.width = 1; this.height = 1; } set src(v) { this._src = v; setTimeout(() => { if (this.onload) this.onload(); }, 0); } get src() { return this._src; } };
}

// ── the tiny GLB fixture: a 2 x 1 x 0.5 box centred at (3, 0, 0) (off-centre on purpose), yellow material ──────────
export function makeTinyGlb() {
  const sx = 1, sy = 0.5, sz = 0.25, cx = 3;
  const P = [];
  for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) P.push(x + cx, y, z);
  const I = [0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7, 0, 4, 1, 1, 4, 5, 2, 3, 6, 3, 7, 6, 0, 2, 4, 2, 6, 4, 1, 5, 3, 3, 5, 7];
  const pos = new Float32Array(P), idx = new Uint16Array(I);
  const binLen = pos.byteLength + idx.byteLength, pad = (4 - binLen % 4) % 4;
  const json = { asset: { version: '2.0', generator: 'tests/model-fetch-smoke.mjs' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'tiny_box' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.8, 0.1, 1] } }],
    buffers: [{ byteLength: binLen + pad }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [cx - sx, -sy, -sz], max: [cx + sx, sy, sz] }, { bufferView: 1, componentType: 5123, count: I.length, type: 'SCALAR' }] };
  let js = JSON.stringify(json);
  while (js.length % 4) js += ' ';
  const jsonBuf = Buffer.from(js, 'utf8');
  const total = 12 + 8 + jsonBuf.length + 8 + binLen + pad;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546C67, o); o += 4; out.writeUInt32LE(2, o); o += 4; out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonBuf.length, o); o += 4; out.writeUInt32LE(0x4E4F534A, o); o += 4; jsonBuf.copy(out, o); o += jsonBuf.length;
  out.writeUInt32LE(binLen + pad, o); o += 4; out.writeUInt32LE(0x004E4942, o); o += 4;
  Buffer.from(pos.buffer).copy(out, o); o += pos.byteLength; Buffer.from(idx.buffer).copy(out, o);
  return out;
}
const FIXTURE = join(here, 'fixtures', 'tiny_cube.glb');
if (!existsSync(FIXTURE)) { mkdirSync(dirname(FIXTURE), { recursive: true }); writeFileSync(FIXTURE, makeTinyGlb()); }
const fixtureBytes = readFileSync(FIXTURE);
const toAB = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// ── [K] kind normalisation, classification, size defaults ───────────────────────────────────────────────────────
console.log('\n[K] words -> tiers / sizes');
{
  ok(normaliseKind('  A Rubber  Duck! ') === 'rubber duck' && normaliseKind('the tennis_ball') === 'tennis ball' && normaliseKind('') === '', 'normaliseKind strips articles, punctuation, underscores');
  ok(slugKind('Rubber Duck') === 'rubber_duck' && slugKind('   ') === 'thing', 'slugKind -> id-safe');
  const c = w => classifyKind(w).tier + ':' + classifyKind(w).key;
  ok(c('tennis ball') === 'catalog:tennis' && c('a basketball') === 'catalog:basketball' && c('glass ball') === 'catalog:glass_ball' && c('red apple') === 'catalog:apple' && c('ball') === 'catalog:ball' && c('dice') === 'catalog:cube',
    `catalog tier: tennis ball -> ${c('tennis ball')}, basketball -> ${c('a basketball')}, glass ball -> ${c('glass ball')}`);
  ok(c('butterfly') === 'bundled:butterfly' && c('a sparrow') === 'bundled:bird' && c('katana') === 'bundled:sword' && c('arrow') === 'bundled:arrow' && c('bow') === 'bundled:bow',
    `bundled tier: sparrow -> ${c('a sparrow')}, katana -> ${c('katana')}, arrow -> ${c('arrow')}`);
  ok(c('rubber duck') === 'sketchfab:rubber duck' && c('coffee mug') === 'sketchfab:coffee mug', `sketchfab tier: rubber duck -> ${c('rubber duck')}`);
  ok(Math.abs(sizeFor('tennis ball') - 0.067) < 1e-9 && Math.abs(sizeFor('coffee mug') - 0.10) < 1e-9 && sizeFor('rubber duck') === 0.09 && sizeFor('zorblax') === DEFAULT_SIZE_M && sizeFor('sword') === 0.9,
    `sizes: tennis ball ${sizeFor('tennis ball')}, mug ${sizeFor('coffee mug')}, duck ${sizeFor('rubber duck')}, unknown ${sizeFor('zorblax')}`);
  ok(CATALOG.length === 6 && BUNDLED.every(b => existsSync(join(ROOT, b[2]))), `every bundled GLB exists on disk (${BUNDLED.map(b => b[2]).join(', ')})`);
}

// ── [N] normalisation + hull on synthetic objects ───────────────────────────────────────────────────────────────
console.log('\n[N] normaliseModel / buildHull / toMatcap / placeholder');
{
  const raw = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 0.5, 4, 2, 2), new THREE.MeshStandardMaterial({ color: 0x3366ff, map: null }));
  m.position.set(3, 1, -2); raw.add(m);
  raw.add(new THREE.PointLight(0xffffff, 1)); raw.add(new THREE.PerspectiveCamera());
  raw.scale.set(2, 2, 2); raw.rotation.y = Math.PI / 2;               // a non-identity root transform (rotated 90 deg: 2 m along world z)
  const n = normaliseModel(raw, 0.09);
  const box = new THREE.Box3().setFromObject(n.object), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  ok(Math.abs(Math.max(size.x, size.y, size.z) - 0.09) < 1e-6, `largest dimension = 0.09 (${size.toArray().map(v => v.toFixed(4)).join(' x ')})`);
  ok(c.length() < 1e-6, `centred at the origin (|c| = ${c.length().toExponential(2)})`);
  let lights = 0, cams = 0; n.object.traverse(o => { if (o.isLight) lights++; if (o.isCamera) cams++; });
  ok(lights === 0 && cams === 0 && n.inner === raw && n.object.children[0] === raw, 'lights + cameras stripped; wrapper Group holds the raw scene');
  ok(Math.abs(n.dims[2] - 0.09) < 1e-6 && Math.abs(n.dims[0] - 0.0225) < 1e-6, `dims follow the rotated root: ${n.dims.map(v => v.toFixed(4)).join(' x ')}`);
  toMatcap(n.object);
  ok(m.material.type === 'MeshMatcapMaterial' && m.material.matcap === matcapTexture() && m.material.color.getHexString() === '3366ff' && m.layers.mask === 1 && m.frustumCulled === false, 'materials -> MeshMatcapMaterial (colour kept, shared matcap), layer 0, never culled');
  const tex = matcapTexture();
  ok(tex.isDataTexture && tex.image.width === 128 && tex.image.data[(64 * 128 + 64) * 4] > tex.image.data[(2 * 128 + 2) * 4], 'procedural matcap: lit centre brighter than the corner');
  const h = buildHull(n.object, n.r);
  ok(!h.sphere && h.hull instanceof PropHull && h.hull.segs.length > 0 && h.samples >= 8, `box -> capsule chain with ${h.hull.segs.length} segments from ${h.samples} samples`);
  const H = h.hull.begin(n.object);
  ok(H.surfaceDistance(new THREE.Vector3(0, 0, 0)) < 0 && H.surfaceDistance(new THREE.Vector3(0, 0, 0.3)) > 0.2 && Math.abs(H.surfaceDistance(new THREE.Vector3(0, 0, 0.3)) - H.surfaceDistance(new THREE.Vector3(0, 0, -0.3))) < 0.01, 'hull: origin inside, +-30 cm along the long axis symmetric and outside');
  // a sphere-like cloud -> EXACT sphere hull (a capsule chain baked from a sphere over-reaches)
  const sph = normaliseModel(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16)), 0.067);
  const hs = buildHull(sph.object, sph.r);
  ok(hs.sphere && hs.hull.segs.length === 1 && Math.abs(hs.hull.segs[0].ra - 0.0335) < 1e-3, `sphere mesh -> exact sphere hull r=${hs.hull.segs[0].ra.toFixed(4)}`);
  // an apple-ish cloud (radius wobble 12 %) still counts as a sphere
  const ag = new THREE.SphereGeometry(1, 24, 16), ap = ag.getAttribute('position');
  for (let i = 0; i < ap.count; i++) { const k = 1 + 0.08 * Math.sin(i * 1.7); ap.setXYZ(i, ap.getX(i) * k, ap.getY(i) * k, ap.getZ(i) * k); }
  const apple = normaliseModel(new THREE.Mesh(ag), 0.08);
  ok(buildHull(apple.object, apple.r).sphere, 'a lumpy apple-like cloud -> sphere hull');
  const deg = buildHull(new THREE.Group(), 0.05);
  ok(deg.sphere && deg.hull.segs[0].ra === 0.05 && deg.samples === 0, 'an empty object -> bounding sphere fallback, never null');
  const p = makePlaceholder('rubber duck', 0.09);
  let pm = null; p.object.traverse(o => { if (o.isMesh) pm = o; });
  ok(p.tier === 'placeholder' && pm && pm.geometry.type === 'BoxGeometry' && pm.geometry.parameters.width === 0.09 && pm.material.type === 'MeshMatcapMaterial' && pm.material.map === null && p.hull.segs[0].ra === 0.09 * 0.6 && p.r === 0.045,
    'placeholder: 9 cm matcap cube (label texture skipped in Node), sphere hull 0.6 x side');
  disposeBuilt(p);
  ok(p.object.parent === null, 'disposeBuilt detaches');
}

// ── [C] catalog tier: synchronous, offline, ball-visuals.js optional ────────────────────────────────────────────
console.log('\n[C] catalog tier');
{
  const f = new ModelFetcher({ fetch: () => { throw new Error('offline'); }, caches: null });
  const vis = await f.preload();
  console.log('    ball-visuals.js (B2): ' + (vis ? 'present -> makeBallMesh used' : 'absent -> fallback makers'));
  const tb = f.local('tennis ball');
  let mesh = null; tb.object.traverse(o => { if (o.isMesh) mesh = o; });
  ok(tb && tb.tier === 'catalog' && tb.name === 'tennis' && Math.abs(tb.size_m - 0.067) < 1e-9 && Math.abs(tb.r - 0.0335) < 1e-9 && tb.hull.segs.length === 1 && tb.hull.segs[0].ra === tb.r && mesh && mesh.layers.mask === 1,
    `local('tennis ball') -> ${tb.name} r=${tb.r} sphere hull, mesh ${mesh && mesh.geometry.type}`);
  ok(f.local('rubber duck') === null && f.local('sparrow') === null, 'local() is null for non-catalog words');
  const st = [];
  const b = await f.resolve('a big basketball', { size_m: 0.3, onStatus: s => st.push(s.phase + ':' + s.tier) });
  ok(b.tier === 'catalog' && b.name === 'basketball' && b.size_m === 0.3 && st.length === 1 && st[0] === 'ready:catalog', `resolve('a big basketball', 0.3) -> catalog, one status ${st[0]}`);
  const cube = f.local('a box', 0.1);
  let cm = null; cube.object.traverse(o => { if (o.isMesh) cm = o; });
  ok(cube.name === 'cube' && cm && (cm.geometry.type === 'BoxGeometry' || vis), 'cube -> box geometry (fallback maker)');
  ok(f.stats.searches === 0 && f.stats.downloads === 0, 'no network touched');
}

// ── [B] bundled tier: a real GLB from disk through GLTFLoader (Node image shim), normalised + hull ─────────────
console.log('\n[B] bundled tier (offline)');
{
  const f = new ModelFetcher({ fetch: () => { throw new Error('offline'); }, caches: null, assetBase: ROOT + '/',
    loadBytes: async (url, { onProgress }) => { const b = readFileSync(url); onProgress(0.5); onProgress(1); return toAB(b); } });
  const st = [];
  const t0 = Date.now();
  const origErr = console.error; console.error = () => {};               // GLTFLoader texture stubs are noisy in Node
  const a = await f.resolve('an arrow', { onStatus: s => st.push(s) });
  console.error = origErr;
  ok(a.tier === 'bundled' && a.name === 'arrow' && a.url === 'sdk/assets/props/arrow.glb' && !a.error, `resolve('an arrow') -> bundled ${a.url} in ${Date.now() - t0} ms (bytes ${a.bytes})`);
  if (a.tier === 'bundled') {
    const box = new THREE.Box3().setFromObject(a.object), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    ok(Math.abs(Math.max(size.x, size.y, size.z) - 0.7) < 1e-4 && c.length() < 1e-4, `arrow normalised to 0.7 m (${size.toArray().map(v => v.toFixed(3)).join(' x ')}), centred`);
    ok(a.hull.segs.length > 3 && !a.sphere, `long thin prop -> capsule chain with ${a.hull.segs.length} segments (${a.hullSamples} samples)`);
    let mats = 0, matcap = 0; a.object.traverse(o => { if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) { mats++; if (m.type === 'MeshMatcapMaterial') matcap++; } });
    ok(mats > 0 && matcap === mats, `${mats} material(s), all matcap`);
    const phases = st.map(s => s.phase);
    ok(phases[0] === 'downloading' && phases.includes('parsing') && phases[phases.length - 1] === 'ready' && st.some(s => s.progress === 1), `status phases: ${phases.join(' -> ')}`);
    const t1 = Date.now();
    const a2 = await f.resolve('arrow', { size_m: 0.2 });
    ok(a2.object !== a.object && Math.abs(a2.size_m - 0.2) < 1e-9 && f.templates.size === 1, `second spawn clones the parsed template (${Date.now() - t1} ms), own size 0.2`);
    disposeBuilt(a); disposeBuilt(a2);
  } else console.log('    error: ' + a.error);
}

// ── [S] Sketchfab tier against a MOCKED /api/sketchfab: search -> uid -> resolve -> tiny GLB; cache by uid ─────
console.log('\n[S] Sketchfab tier (mocked /api)');
{
  const calls = [];
  const jsonRes = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  const mockFetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('op=search')) {
      const q = new URL(u, 'http://x').searchParams.get('q');
      if (q === 'nothing here') return jsonRes({ results: [], nextCursor: null });
      return jsonRes({ results: [
        { uid: 'heavy00000000000000000000000000', name: 'Heavy Duck', isDownloadable: true, faceCount: 900000, thumbnails: { images: [{ url: 'x', width: 256 }] }, user: { displayName: 'a' } },
        { uid: 'nodl000000000000000000000000000', name: 'No Download', isDownloadable: false, faceCount: 100, thumbnails: { images: [{ url: 'x', width: 256 }] } },
        { uid: 'duck0000000000000000000000000000', name: 'Rubber Duck', isDownloadable: true, faceCount: 1200, thumbnails: { images: [{ url: 'x', width: 256 }] }, user: { username: 'quack' } },
      ], nextCursor: null });
    }
    if (u.includes('op=resolve')) {
      const uid = new URL(u, 'http://x').searchParams.get('uid');
      if (uid === 'broken') return new Response(JSON.stringify({ error: 'SKETCHFAB_TOKEN is not set on the server' }), { status: 500 });
      return jsonRes({ glb: { url: 'https://s3.example/models/' + uid + '.glb', size: fixtureBytes.length, expires: 30 }, gltf: { url: 'https://s3.example/models/' + uid + '.zip' } });
    }
    if (u.startsWith('https://s3.example/')) return new Response(fixtureBytes, { status: 200, headers: { 'content-type': 'model/gltf-binary', 'content-length': String(fixtureBytes.length) } });
    return new Response('nope', { status: 404 });
  };
  const store = new Map();
  const mockCaches = { open: async () => ({ match: async k => store.get(k) ? new Response(store.get(k)) : undefined, put: async (k, r) => { store.set(k, await r.arrayBuffer()); } }) };
  const f = new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab', fetch: mockFetch, caches: mockCaches });
  const st = [];
  const d = await f.resolve('rubber duck', { onStatus: s => st.push(s) });
  ok(d.tier === 'sketchfab' && d.uid === 'duck0000000000000000000000000000' && d.name === 'Rubber Duck' && !d.error, `picked the light downloadable hit: ${d.uid} (${d.name}, ${d.faces} faces)`);
  ok(calls.some(u => u.includes('op=search&q=rubber%20duck&count=12')) && calls.some(u => u.includes('op=resolve&uid=duck0000000000000000000000000000')) && calls.some(u => u.startsWith('https://s3.example/models/duck')),
    'query contract: op=search&q=&count= -> op=resolve&uid= -> the resolved glb url');
  const box = new THREE.Box3().setFromObject(d.object), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  ok(Math.abs(size.x - 0.09) < 1e-6 && Math.abs(size.y - 0.045) < 1e-6 && Math.abs(size.z - 0.0225) < 1e-6 && c.length() < 1e-6, `fixture box (2 x 1 x 0.5 at x=3) normalised to ${size.toArray().map(v => v.toFixed(4)).join(' x ')}, centred`);
  ok(d.hull.segs.length > 0 && !d.sphere && d.r === 0.045 && Math.abs(d.size_m - 0.09) < 1e-9, `hull built: ${d.hull.segs.length} segments; r 0.045`);
  let mat = null; d.object.traverse(o => { if (o.isMesh) mat = o.material; });
  ok(mat && mat.type === 'MeshMatcapMaterial' && mat.color.getHexString() === 'ffe759', `material matcap, glb baseColorFactor [1,.8,.1] kept (linear -> sRGB hex ${mat && mat.color.getHexString()})`);
  const phases = st.map(s => s.phase);
  ok(phases[0] === 'searching' && phases.includes('downloading') && phases.includes('parsing') && phases[phases.length - 1] === 'ready' && st.filter(s => s.phase === 'downloading').some(s => s.progress > 0 && s.progress <= 1),
    `status phases: ${[...new Set(phases)].join(' -> ')} (download progress reported)`);
  ok(store.size === 1 && [...store.keys()][0] === '/_models/duck0000000000000000000000000000.glb', `cached in CacheStorage keyed by uid: ${[...store.keys()][0]}`);
  // second fetcher, same cache: no download, no resolve
  const calls2Before = calls.length;
  const f2 = new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab', fetch: mockFetch, caches: mockCaches });
  const d2 = await f2.resolve('rubber duck');
  const newCalls = calls.slice(calls2Before);
  ok(d2.tier === 'sketchfab' && f2.stats.cacheHits === 1 && f2.stats.downloads === 0 && newCalls.length === 1 && newCalls[0].includes('op=search'), `cache hit: only the search call went out (${newCalls.length} call)`);
  // same fetcher, same word again -> in-memory template, zero network
  const before = calls.length;
  const d3 = await f.resolve('rubber duck', { size_m: 0.2 });
  ok(calls.length === before + 1 && d3.object !== d.object && Math.abs(d3.size_m - 0.2) < 1e-9, 'template reused per uid (one search call, no download)');
  // failure paths -> placeholder, never silent
  const st4 = [];
  const p4 = await f.resolve('nothing here', { onStatus: s => st4.push(s) });
  ok(p4.tier === 'placeholder' && /no downloadable model/.test(p4.error) && st4[st4.length - 1].phase === 'fallback' && p4.object && p4.hull, `no hits -> placeholder + status fallback (${p4.error})`);
  const fb = new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab', caches: null,
    fetch: async u => String(u).includes('op=search') ? jsonRes({ results: [{ uid: 'broken', name: 'x', isDownloadable: true, faceCount: 1 }] }) : mockFetch(u) });
  const p5 = await fb.resolve('anything');
  ok(p5.tier === 'placeholder' && /download 500|SKETCHFAB_TOKEN/.test(p5.error), `resolve without a token -> placeholder (${p5.error})`);
  const fc = new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab', caches: null, fetch: async u => String(u).startsWith('https://s3.example/') ? new Response(Buffer.from('not a glb'), { status: 200 }) : mockFetch(u) });
  const p6 = await fc.resolve('rubber duck');
  ok(p6.tier === 'placeholder' && p6.error, `an unparsable download -> placeholder (${String(p6.error).slice(0, 60)})`);
  // abort -> null + 'cancelled'
  const ctrl = new AbortController(), st7 = [];
  const slow = new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab', caches: null, fetch: async (u, o) => { await new Promise(r => setTimeout(r, 20)); if (o && o.signal && o.signal.aborted) throw new Error('aborted'); return mockFetch(u); } });
  const pr = slow.resolve('rubber duck', { signal: ctrl.signal, onStatus: s => st7.push(s.phase) });
  setTimeout(() => ctrl.abort(), 5);
  const p7 = await pr;
  ok(p7 === null && st7[st7.length - 1] === 'cancelled', `abort -> null, last status '${st7[st7.length - 1]}'`);
  // CORS-blocked S3 link -> proxy op=fetch fallback
  const calls8 = [];
  const f8 = new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab', caches: null, fetch: async u => { calls8.push(String(u)); if (String(u).startsWith('https://s3.example/')) throw new TypeError('Failed to fetch'); if (String(u).includes('op=fetch')) return new Response(fixtureBytes, { status: 200 }); return mockFetch(u); } });
  const d8 = await f8.resolve('rubber duck');
  ok(d8.tier === 'sketchfab' && calls8.some(u => u.includes('op=fetch&url=https%3A%2F%2Fs3.example')), 'a CORS-refused direct download retries through ?op=fetch&url= on the proxy');
  // the sdk/world/sketchfab.js pair is used for the default endpoint with the global fetch
  const saved = globalThis.fetch;
  globalThis.fetch = async u => { calls.push('sdk:' + u); return mockFetch(u); };
  try {
    const fs2 = new ModelFetcher({ caches: null });
    ok(fs2.sketchfab !== null && fs2.endpoint === '/api/sketchfab', 'default endpoint -> sdk/world/sketchfab.js searchModels / resolveGLB');
    const d9 = await fs2.resolve('rubber duck');
    ok(d9.tier === 'sketchfab' && calls.some(u => u.startsWith('sdk:/api/sketchfab?op=search')) && calls.some(u => u.startsWith('sdk:/api/sketchfab?op=resolve&uid=')), 'sdk path: /api/sketchfab?op=search then ?op=resolve&uid=');
  } finally { globalThis.fetch = saved; }
  const api = sketchfabApi('http://x/api/sketchfab', mockFetch);
  const hits = await api.search('rubber duck');
  ok(hits.length === 3 && hits[2].uid.startsWith('duck') && hits[1].downloadable === false && hits[0].faces === 900000 && (await api.resolve('abc')).endsWith('/abc.glb'), 'sketchfabApi maps results like sdk/world/sketchfab.js and resolves glb.url');
  disposeBuilt(d); disposeBuilt(d2); disposeBuilt(d3); disposeBuilt(p4); disposeBuilt(d8);
}

// ── [P] PropBody: doctrine lane on a fetched body (no scene needed) ─────────────────────────────────────────────
console.log('\n[P] PropBody');
{
  const scene = new THREE.Scene();
  const p = makePlaceholder('mug', 0.1);
  const body = new PropBody(scene, { radius: p.r, gravity: -5.2, restitution: 0.58, home: new THREE.Vector3(0, 0.5, -1), spawnOffset: new THREE.Vector3(), floorY: -0.5, built: p });
  ok(body instanceof PropBall && body.mesh === p.object && p.object.parent === scene && body.hull === p.hull && body.sphere.gravity < 0 && body.radius === 0.05, 'PropBody is a PropBall with the built visual + hull on the scene');
  const raw = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 0.5, 4, 2, 2), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
  const n = normaliseModel(raw, 0.1); toMatcap(n.object); const h = buildHull(n.object, n.r);
  body.sphere.pos.set(0.1, 0.2, -1); body.sphere.vel.set(0.3, 0, 0);
  const oldWrap = body.mesh;
  body.setModel({ tier: 'sketchfab', object: n.object, inner: n.inner, hull: h.hull, sphere: h.sphere, r: n.r, size_m: 0.1, name: 'box' });
  ok(body.mesh === n.object && n.object.parent === scene && oldWrap.parent === null && body.hull === h.hull && body.sphere.pos.x === 0.1 && body.sphere.vel.x === 0.3 && body.mesh.position.x === 0.1, 'setModel swaps visual + hull in place, keeps pos / vel');
  const ra0 = body.hull.segs[0].ra;
  body.setRadius(0.1);
  const bb = new THREE.Box3().setFromObject(body.mesh), bs = bb.getSize(new THREE.Vector3());
  ok(Math.abs(bs.x - 0.2) < 1e-6 && Math.abs(body.hull.segs[0].ra - 2 * ra0) < 1e-12 && body.sphere.radius === 0.1 && body.collider.radius === 0.1, `setRadius(0.1): visual 0.2 m, hull x2, sphere / collider radius 0.1`);
  ok(body.setColor('gold') && body.materials().every(m => m.color.getHexString() === 'ffd700') && body.setColor('not-a-colour-xyz') === false, 'setColor tints every material; an unknown colour returns false');
  ok(body.setGlow('gold') && body.materials()[0].color.getHexString() !== 'ffd700' && body.setGlow(null) && body.materials()[0].color.getHexString() === 'ffd700', 'setGlow brightens matcap materials and restores the base colour');
  const far = new THREE.Vector3(body.pos.x + 0.5, body.pos.y, body.pos.z);
  const ext1 = 0.5 - body.hull.begin(body.mesh).surfaceDistance(far);       // hull reach along +x before the pinch scale
  body.setScale(1.5);
  const ext2 = 0.5 - body.hull.begin(body.mesh).surfaceDistance(far);
  const bb2 = new THREE.Box3().setFromObject(body.mesh), bs2 = bb2.getSize(new THREE.Vector3());
  ok(Math.abs(bs2.x - 0.3) < 1e-6 && ext1 > 0.1 && Math.abs(ext2 - 1.5 * ext1) < 0.002, `two-hand pinch scale (setScale 1.5) scales visual (0.3 m) and hull reach together (${ext1.toFixed(4)} -> ${ext2.toFixed(4)}, cone segments: 2 mm tolerance)`);
  // free fall + floor on the doctrine lane, no hands
  for (let i = 0; i < 120; i++) body.update(1 / 60, { L: null, R: null }, null);
  ok(body.pos.y <= -0.5 + body.sphere.radius + 1e-3 && body.pos.y >= -0.5 - 1e-6, `falls to the floor and rests (y ${body.pos.y.toFixed(3)}, floor -0.5)`);
  body.dispose();
  ok(n.object.parent === null && scene.children.length === 0, 'dispose removes the visual');
}

// ── [L] live checks (network permitting; skipped, not failed, when offline) ─────────────────────────────────────
console.log('\n[L] live');
{
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + ' ms')), ms))]);
  try {
    const r = await timeout(fetch('https://api.sketchfab.com/v3/search?type=models&q=tennis%20ball&downloadable=true&count=3'), 15000);
    const j = await r.json();
    const first = j.results && j.results[0];
    ok(r.ok && first && first.uid, `GET api.sketchfab.com search (no token): ${j.results.length} results, first uid ${first && first.uid} "${first && first.name}" downloadable=${first && first.isDownloadable}`);
  } catch (e) { skip('live Sketchfab search', e.message); }
  // the sandbox proxy's /api/sketchfab passthrough on a scratch port
  const port = 3390 + Math.floor(Math.random() * 100);
  const proxy = spawn(process.execPath, [join(ROOT, 'tools', 'sandbox-proxy.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SKETCHFAB_TOKEN: '' } });
  try {
    await timeout(new Promise((res, rej) => { proxy.stdout.on('data', d => { if (/sandbox proxy/.test(String(d))) res(); }); proxy.on('exit', c => rej(new Error('proxy exited ' + c))); }), 8000);
    const rs = await timeout(fetch(`http://localhost:${port}/api/sketchfab?op=resolve&uid=abc`), 8000);
    const js = await rs.json();
    ok(rs.status === 500 && /SKETCHFAB_TOKEN/.test(js.error), `proxy /api/sketchfab?op=resolve without a token -> 500 ${JSON.stringify(js.error)}`);
    const rf = await timeout(fetch(`http://localhost:${port}/api/sketchfab?op=fetch&url=https://evil.example/x.glb`), 8000);
    ok(rf.status === 403, 'proxy ?op=fetch refuses hosts outside sketchfab / amazonaws / cloudfront (403)');
    const opt = await timeout(fetch(`http://localhost:${port}/api/sketchfab?op=search&q=x`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3333' } }), 8000);
    ok(opt.status === 204 && /GET/.test(opt.headers.get('access-control-allow-methods')) && opt.headers.get('access-control-allow-origin') === 'http://localhost:3333', 'CORS preflight allows GET from the dev page origin');
    try {
      const r2 = await timeout(fetch(`http://localhost:${port}/api/sketchfab?op=search&q=tennis%20ball&count=2`), 15000);
      const j2 = await r2.json();
      ok(r2.ok && Array.isArray(j2.results) && j2.results.length > 0 && j2.results[0].uid, `proxy ?op=search passthrough (no token): ${j2.results.length} results, first uid ${j2.results[0] && j2.results[0].uid}`);
    } catch (e) { skip('proxy live search', e.message); }
  } catch (e) { skip('sandbox proxy passthrough', e.message); }
  finally { proxy.kill(); }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
