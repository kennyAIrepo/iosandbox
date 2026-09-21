/**
 * sdk/game/ball-visuals.js — procedural ball looks for the Teams twin. NO downloads, NO extra WebGL contexts.
 *
 *   makeTennisBallMesh(r, opts) -> THREE.Mesh     optic-yellow felt + the real tennis seam, MeshMatcapMaterial (+ bumpMap fuzz)
 *   makeBallMesh(kind, r, opts) -> THREE.Mesh     kinds: 'tennis' | 'basketball' | 'apple' | 'glass'  (the command agent's spawns)
 *
 * Render-budget rule (CONTRACTS §3.3): props cross tiles, so every ball is a MeshMatcapMaterial — shading is indexed by
 * the view-space normal and every tile camera looks down -z, so the two half-gutter passes agree pixel for pixel.
 * three 0.160's MeshMatcapMaterial supports `map`, `bumpMap`/`bumpScale` and `normalMap` (src/materials/MeshMatcapMaterial.js:24-31),
 * so the felt fuzz is a bump map on the same material — no lights, no second pass.
 *
 * Node-safe: the pixel generators are pure (`renderTennisPixels`, `renderBasketballPixels`, `renderApplePixels`,
 * `seamPoint`, `seamSamples`, `seamDistance`); the canvas is INJECTED (`opts.createCanvas(w, h)`), so
 * tests/ball-visuals-smoke.mjs builds every mesh with a stub canvas and asserts on the raw pixels and the material config.
 *
 * Texture mapping (three SphereGeometry, r160): direction n = (x, y, z) on the unit sphere <-> theta = acos(y) (0 at +y),
 * phi = atan2(z, -x); u = phi / 2pi, v = 1 - theta / pi; CanvasTexture.flipY = true so canvas row 0 is the +y pole.
 */
import * as THREE from 'three';

// ── the classic tennis seam (the "baseball curve"): p(t) = normalize(a cos t + b cos 3t, c sin 2t, a sin t - b sin 3t) ─
// Lobes peak at +y / -y (the texture poles are the seam's symmetry axis, 26° clear of the pole so no equirect blow-up);
// a, b, c chosen so the two north lobes sit ~53° apart and the seam crosses the equator four times — reads as a tennis
// ball at 13 px, still right at 200 px.
export const SEAM = Object.freeze({ a: 1.0, b: 0.25, c: 1.5, samples: 1024 });

/** One point of the seam curve at parameter t (0..2pi) on the UNIT sphere; `out` = {x,y,z} or a THREE.Vector3. */
export function seamPoint(t, out = { x: 0, y: 0, z: 0 }, P = SEAM) {
  const x = P.a * Math.cos(t) + P.b * Math.cos(3 * t);
  const y = P.c * Math.sin(2 * t);
  const z = P.a * Math.sin(t) - P.b * Math.sin(3 * t);
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out.x = x * inv; out.y = y * inv; out.z = z * inv;
  return out;
}

/** `n` evenly-spaced (in t) seam points as a Float32Array [x0,y0,z0, x1,...] (cached per n). */
const _seamCache = new Map();
export function seamSamples(n = SEAM.samples, P = SEAM) {
  const key = n + ':' + P.a + ':' + P.b + ':' + P.c;
  let s = _seamCache.get(key);
  if (s) return s;
  s = new Float32Array(n * 3);
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) { seamPoint(i / n * Math.PI * 2, p, P); s[i * 3] = p.x; s[i * 3 + 1] = p.y; s[i * 3 + 2] = p.z; }
  _seamCache.set(key, s);
  return s;
}

/** Angular distance (radians) from unit direction `d` to the seam (min over the samples). */
export function seamDistance(d, samples = seamSamples()) {
  let best = -1;
  for (let i = 0; i < samples.length; i += 3) {
    const dot = d.x * samples[i] + d.y * samples[i + 1] + d.z * samples[i + 2];
    if (dot > best) best = dot;
  }
  return Math.acos(Math.max(-1, Math.min(1, best)));
}

// ── 3D value noise on the sphere (seamless, no pole stretch) ─────────────────────────────────────────────────────────
function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const _sm = t => t * t * (3 - 2 * t);
/** value noise at (x,y,z) in lattice units, 0..1 */
export function noise3(x, y, z, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = _sm(x - x0), fy = _sm(y - y0), fz = _sm(z - z0);
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  const c000 = hash3(x0, y0, z0, seed), c100 = hash3(x1, y0, z0, seed), c010 = hash3(x0, y1, z0, seed), c110 = hash3(x1, y1, z0, seed);
  const c001 = hash3(x0, y0, z1, seed), c101 = hash3(x1, y0, z1, seed), c011 = hash3(x0, y1, z1, seed), c111 = hash3(x1, y1, z1, seed);
  const a = c000 + (c100 - c000) * fx, b = c010 + (c110 - c010) * fx, c = c001 + (c101 - c001) * fx, d = c011 + (c111 - c011) * fx;
  const e = a + (b - a) * fy, f = c + (d - c) * fy;
  return e + (f - e) * fz;
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function hexRgb(h) { const n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

/**
 * Direction of texel (px, py) on a W x H equirect map (three SphereGeometry convention, canvas row 0 = +y pole).
 * Writes cosPhi/sinPhi tables once per width (cached).
 */
const _phiCache = new Map();
function phiTables(W) {
  let t = _phiCache.get(W);
  if (t) return t;
  const c = new Float32Array(W), s = new Float32Array(W);
  for (let px = 0; px < W; px++) { const phi = (px + 0.5) / W * Math.PI * 2; c[px] = Math.cos(phi); s[px] = Math.sin(phi); }
  t = { c, s }; _phiCache.set(W, t);
  return t;
}

/**
 * Angular distance field to a set of curves on a W x H equirect map: Float32Array(W*H) of radians, painted only within
 * `reach` radians of the curve samples (everything farther reads as `reach`). Curves = array of Float32Array [x,y,z,...]
 * unit-sphere polylines (closed or open; the samples must be dense: step << reach).
 */
export function curveDistanceField(W, H, curves, reach, fill = Math.PI) {
  const dist = new Float32Array(W * H).fill(fill);
  const { c: cosPhi, s: sinPhi } = phiTables(W);
  const cosReach = Math.cos(reach);
  for (const s of curves) {
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      const theta = Math.acos(Math.max(-1, Math.min(1, y)));
      const phi = Math.atan2(z, -x);
      const r0 = Math.max(0, Math.floor((theta - reach) / Math.PI * H - 1));
      const r1 = Math.min(H - 1, Math.ceil((theta + reach) / Math.PI * H + 1));
      for (let py = r0; py <= r1; py++) {
        const th = (py + 0.5) / H * Math.PI, st = Math.sin(th), ct = Math.cos(th);
        const span = st < 1e-3 ? Math.PI : Math.min(Math.PI, reach / st + 2 * Math.PI / W);
        const c0 = Math.floor((phi - span) / (2 * Math.PI) * W), c1 = Math.ceil((phi + span) / (2 * Math.PI) * W);
        const row = py * W;
        for (let cc = c0; cc <= c1; cc++) {
          const px = ((cc % W) + W) % W;
          const nx = -cosPhi[px] * st, ny = ct, nz = sinPhi[px] * st;
          const dot = nx * x + ny * y + nz * z;
          if (dot <= cosReach) continue;
          const d = Math.acos(dot > 1 ? 1 : dot);
          if (d < dist[row + px]) dist[row + px] = d;
        }
      }
    }
  }
  return dist;
}

/** Circle on the unit sphere in the plane n·p = k, as a dense polyline (for the basketball's grooves). */
export function circleSamples(n, k, count = 720) {
  const nl = Math.hypot(n.x, n.y, n.z); const ax = n.x / nl, ay = n.y / nl, az = n.z / nl;
  // two tangents
  let tx, ty, tz;
  if (Math.abs(ax) < 0.9) { tx = 0; ty = -az; tz = ay; } else { tx = az; ty = 0; tz = -ax; }
  const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
  const bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;
  const rr = Math.sqrt(Math.max(0, 1 - k * k));
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = i / count * Math.PI * 2, ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
    out[i * 3] = ax * k + tx * ca + bx * sa; out[i * 3 + 1] = ay * k + ty * ca + by * sa; out[i * 3 + 2] = az * k + tz * ca + bz * sa;
  }
  return out;
}

// ── TENNIS pixels ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const TENNIS = Object.freeze({ felt: '#ccff00', seam: '#f9f6ec', seamWidth: 0.03, fuzz: 1, width: 1024, height: 512, seed: 7 });

/**
 * Pure: felt + seam RGBA pixels of a W x H equirect tennis map, plus the seam distance field and a height (bump) map.
 *   seamWidth  full width of the seam band as a fraction of the circumference (0.035 -> 12.6° of arc)
 *   fuzz       0 (flat felt) .. 1 (full fuzz modulation + pores)
 * -> { data: Uint8ClampedArray(W*H*4), bump: Uint8ClampedArray(W*H*4) (grey), dist: Float32Array(W*H), seamMask: Uint8Array(W*H), width, height }
 */
export function renderTennisPixels(W = TENNIS.width, H = TENNIS.height, o = {}) {
  const seamWidth = o.seamWidth ?? TENNIS.seamWidth, fuzz = o.fuzz ?? TENNIS.fuzz, seed = o.seed ?? TENNIS.seed;
  const felt = hexRgb(o.felt || TENNIS.felt), seamCol = hexRgb(o.seam || TENNIS.seam);
  const hw = seamWidth * Math.PI;                       // half width in radians (fraction of 2pi -> *2pi/2)
  const edge = hw * 0.4;                                // the shadow / pile-up ring outside the band
  const aa = Math.PI / H * 1.1;                         // ~1 texel anti-aliasing
  const dist = curveDistanceField(W, H, [seamSamples(SEAM.samples * (W >= 1024 ? 2 : 1))], hw + edge + aa * 3);
  const data = new Uint8ClampedArray(W * H * 4), bump = new Uint8ClampedArray(W * H * 4), seamMask = new Uint8Array(W * H);
  const { c: cosPhi, s: sinPhi } = phiTables(W);
  const F1 = 26, F2 = 58, F3 = 120;                     // noise lattice frequencies on the unit sphere
  for (let py = 0; py < H; py++) {
    const th = (py + 0.5) / H * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      const nx = -cosPhi[px] * st, ny = ct, nz = sinPhi[px] * st;
      const n1 = noise3(nx * F1 + 3.1, ny * F1 + 7.7, nz * F1 + 1.3, seed);
      const n2 = noise3(nx * F2 + 11.2, ny * F2 + 4.4, nz * F2 + 9.8, seed + 1);
      const n3 = noise3(nx * F3 + 5.5, ny * F3 + 2.2, nz * F3 + 8.1, seed + 2);
      // felt: broad tone variation + fibre grain + dark pores
      const pore = smooth(0.36, 0.2, n3);
      let v = 1 + fuzz * (0.12 * (n1 - 0.5) + 0.08 * (n2 - 0.5) + 0.10 * (n3 - 0.5)) - fuzz * 0.16 * pore;
      const grey = fuzz * 0.10 * (n2 - 0.5);             // slight desaturation wobble (fibre catch light)
      let r = felt[0] * v + 255 * grey * 0.5, g = felt[1] * v, b = felt[2] * v + 255 * Math.max(0, grey) * 1.2;
      // seam band + its shadow edge
      const d = dist[i];
      const band = 1 - smooth(hw - aa, hw + aa, d);
      const inner = 1 - 0.12 * smooth(hw * 0.6, hw + aa, d);            // the strip is slightly recessed at its edges
      const shadow = smooth(hw + edge, hw + aa * 0.5, d) * (1 - band);  // felt piles up dark around the strip
      const grime = 1 - 0.05 * n2 - 0.04 * pore;
      const sr = seamCol[0] * inner * grime, sg = seamCol[1] * inner * grime, sb = seamCol[2] * inner * grime;
      r = (r + (sr - r) * band) * (1 - 0.32 * shadow);
      g = (g + (sg - g) * band) * (1 - 0.32 * shadow);
      b = (b + (sb - b) * band) * (1 - 0.32 * shadow);
      const o4 = i * 4;
      data[o4] = r; data[o4 + 1] = g; data[o4 + 2] = b; data[o4 + 3] = 255;
      seamMask[i] = band > 0.5 ? 1 : 0;
      // height: felt fuzz (fine grain) + the seam groove profile
      let h = 0.5 + fuzz * (0.28 * (n3 - 0.5) + 0.12 * (n2 - 0.5) - 0.18 * pore);
      h = h + (0.5 - h) * band;                                            // strip is smooth
      h -= 0.32 * smooth(hw + edge * 0.6, hw, d) * (1 - band) + 0.18 * band * smooth(hw * 0.5, hw, d);   // groove at the edge
      const hb = clamp01(h) * 255;
      bump[o4] = hb; bump[o4 + 1] = hb; bump[o4 + 2] = hb; bump[o4 + 3] = 255;
    }
  }
  return { data, bump, dist, seamMask, width: W, height: H };
}

// ── BASKETBALL pixels: orange pebbled rubber, black grooves (equator + meridian + the two channel circles) ─────────────
export const BASKETBALL = Object.freeze({ base: '#e0762b', groove: '#141210', grooveWidth: 0.009, width: 1024, height: 512, seed: 21 });
export function renderBasketballPixels(W = BASKETBALL.width, H = BASKETBALL.height, o = {}) {
  const base = hexRgb(o.base || BASKETBALL.base), groove = hexRgb(o.groove || BASKETBALL.groove), seed = o.seed ?? BASKETBALL.seed;
  const hw = (o.grooveWidth ?? BASKETBALL.grooveWidth) * Math.PI, aa = Math.PI / H * 1.1;
  // seams in the ball frame: equator (plane y=0), meridian (plane x=0), channels (planes z = ±0.32)
  const curves = [circleSamples({ x: 0, y: 1, z: 0 }, 0, 1440), circleSamples({ x: 1, y: 0, z: 0 }, 0, 1440),
    circleSamples({ x: 0, y: 0, z: 1 }, 0.32, 1440), circleSamples({ x: 0, y: 0, z: 1 }, -0.32, 1440)];
  const dist = curveDistanceField(W, H, curves, hw + aa * 4);
  const data = new Uint8ClampedArray(W * H * 4), bump = new Uint8ClampedArray(W * H * 4), seamMask = new Uint8Array(W * H);
  const { c: cosPhi, s: sinPhi } = phiTables(W);
  for (let py = 0; py < H; py++) {
    const th = (py + 0.5) / H * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const i = py * W + px, nx = -cosPhi[px] * st, ny = ct, nz = sinPhi[px] * st;
      const n1 = noise3(nx * 30 + 1.1, ny * 30 + 2.2, nz * 30 + 3.3, seed);
      const n2 = noise3(nx * 140 + 5.1, ny * 140 + 6.2, nz * 140 + 7.3, seed + 1);   // pebble grain
      const pebble = smooth(0.4, 0.75, n2);
      const v = 0.93 + 0.10 * (n1 - 0.5) + 0.10 * pebble;
      const d = dist[i], band = 1 - smooth(hw - aa, hw + aa, d);
      const o4 = i * 4;
      data[o4] = base[0] * v + (groove[0] - base[0] * v) * band; data[o4 + 1] = base[1] * v + (groove[1] - base[1] * v) * band;
      data[o4 + 2] = base[2] * v + (groove[2] - base[2] * v) * band; data[o4 + 3] = 255;
      seamMask[i] = band > 0.5 ? 1 : 0;
      const hb = clamp01(0.5 + 0.25 * (n2 - 0.5) - 0.45 * band) * 255;
      bump[o4] = hb; bump[o4 + 1] = hb; bump[o4 + 2] = hb; bump[o4 + 3] = 255;
    }
  }
  return { data, bump, dist, seamMask, width: W, height: H };
}

// ── APPLE pixels: red skin with a yellow-green blush toward the stem, lenticel speckles ────────────────────────────────
export const APPLE = Object.freeze({ base: '#c81e28', blush: '#e9c33a', width: 512, height: 256, seed: 33 });
export function renderApplePixels(W = APPLE.width, H = APPLE.height, o = {}) {
  const base = hexRgb(o.base || APPLE.base), blush = hexRgb(o.blush || APPLE.blush), seed = o.seed ?? APPLE.seed;
  const data = new Uint8ClampedArray(W * H * 4), bump = new Uint8ClampedArray(W * H * 4);
  const { c: cosPhi, s: sinPhi } = phiTables(W);
  for (let py = 0; py < H; py++) {
    const th = (py + 0.5) / H * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const i = py * W + px, nx = -cosPhi[px] * st, ny = ct, nz = sinPhi[px] * st;
      const n1 = noise3(nx * 6 + 1.5, ny * 6 + 2.5, nz * 6 + 3.5, seed);
      const n2 = noise3(nx * 90 + 4.5, ny * 90 + 5.5, nz * 90 + 6.5, seed + 1);
      const streak = noise3(Math.atan2(nz, nx) * 9, ny * 5, 0.5, seed + 2);         // vertical stripes toward the stem
      const k = clamp01(0.55 * (n1 - 0.25) + 0.35 * Math.max(0, ny) * streak + 0.25 * Math.max(0, ny - 0.5));
      const speck = smooth(0.78, 0.9, n2) * 0.6;
      const o4 = i * 4;
      data[o4] = (base[0] + (blush[0] - base[0]) * k) * (1 - 0.15 * (n2 - 0.5)) + 255 * speck * 0.5;
      data[o4 + 1] = (base[1] + (blush[1] - base[1]) * k) * (1 - 0.15 * (n2 - 0.5)) + 210 * speck * 0.5;
      data[o4 + 2] = (base[2] + (blush[2] - base[2]) * k) * (1 - 0.15 * (n2 - 0.5)) + 150 * speck * 0.5;
      data[o4 + 3] = 255;
      const hb = clamp01(0.5 + 0.08 * (n2 - 0.5) + 0.12 * speck) * 255;
      bump[o4] = hb; bump[o4 + 1] = hb; bump[o4 + 2] = hb; bump[o4 + 3] = 255;
    }
  }
  return { data, bump, width: W, height: H };
}

// ── matcaps: soft studio key light from the upper left + a faint rim; the disc is multiplied by the map colour ────────
export const MATCAP_STYLES = Object.freeze({
  felt:   { key: [0.40, 0.38], stops: [[0, '#ffffff'], [0.42, '#f7f7f7'], [0.78, '#b6b6b6'], [0.94, '#6f6f6f'], [1, '#4c4c4c']], rim: 0.22, spec: 0.0 },
  rubber: { key: [0.40, 0.38], stops: [[0, '#ffffff'], [0.25, '#efefef'], [0.68, '#9e9e9e'], [0.92, '#4d4d4d'], [1, '#2e2e2e']], rim: 0.16, spec: 0.35 },
  wax:    { key: [0.38, 0.36], stops: [[0, '#ffffff'], [0.22, '#f0f0f0'], [0.66, '#9a9a9a'], [0.92, '#464646'], [1, '#262626']], rim: 0.26, spec: 0.8 },
  glass:  { key: [0.36, 0.34], stops: [[0, '#ffffff'], [0.20, '#dfe9f2'], [0.60, '#8fb3c9'], [0.88, '#7aa8c8'], [1, '#e6f3ff']], rim: 0.9, spec: 1.0 },
});

/** Paint a matcap disc onto a 2D context of `size` px. Pure canvas-2D calls (radial gradients + arcs). */
export function paintMatcap(ctx, size, style = MATCAP_STYLES.felt) {
  const S = size, c = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, S, S);
  const g = ctx.createRadialGradient(style.key[0] * S, style.key[1] * S, S * 0.03, c, c, c);
  for (const [k, col] of style.stops) g.addColorStop(k, col);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
  if (style.spec > 0) {   // a tighter specular dot at the key
    const sg = ctx.createRadialGradient(style.key[0] * S - S * 0.02, style.key[1] * S - S * 0.02, 0, style.key[0] * S, style.key[1] * S, S * 0.13);
    sg.addColorStop(0, `rgba(255,255,255,${0.75 * style.spec})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
  }
  if (style.rim > 0) {    // faint rim: brighter ring at the silhouette (view-space normal almost tangent)
    const rg = ctx.createRadialGradient(c, c, S * 0.40, c, c, c);
    rg.addColorStop(0, 'rgba(255,255,255,0)'); rg.addColorStop(0.82, 'rgba(255,255,255,0)');
    rg.addColorStop(0.95, `rgba(255,255,255,${style.rim})`); rg.addColorStop(1, `rgba(255,255,255,${style.rim * 0.5})`);
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
  }
}

// ── canvas plumbing (injected for Node) ───────────────────────────────────────────────────────────────────────────────
function canvasFactory(o) {
  if (o && o.createCanvas) return o.createCanvas;
  if (typeof document !== 'undefined') return (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  throw new Error('ball-visuals: no canvas — pass opts.createCanvas(w, h) outside the browser');
}
function pixelsToTexture(createCanvas, pixels, W, H, srgb) {
  const cv = createCanvas(W, H); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
const _matcapCache = new Map();
export function makeMatcapTexture(styleName = 'felt', o = {}) {
  const key = styleName + (o.createCanvas ? ':inj' : '');
  if (!o.createCanvas && _matcapCache.has(key)) return _matcapCache.get(key);
  const createCanvas = canvasFactory(o), S = o.matcapSize || 256;
  const cv = createCanvas(S, S); cv.width = S; cv.height = S;
  paintMatcap(cv.getContext('2d'), S, MATCAP_STYLES[styleName] || MATCAP_STYLES.felt);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  if (!o.createCanvas) _matcapCache.set(key, tex);
  return tex;
}

function finishMesh(mesh, kind, r, tint) {
  mesh.name = kind + 'Ball';
  mesh.frustumCulled = false;
  mesh.layers.set(0);
  mesh.renderOrder = 30;
  mesh.userData.kind = kind; mesh.userData.radius = r; mesh.userData.tint = tint;
  mesh.userData.dispose = () => {
    mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); const m = o.material; if (m) { for (const k of ['map', 'bumpMap', 'matcap']) if (m[k] && m[k] !== mesh.material.matcap) m[k].dispose(); m.dispose(); } });
  };
  return mesh;
}

/**
 * makeTennisBallMesh(r, { seamWidth = 0.035, fuzz = 1, segments = 48, width = 1024, height = 512, bumpScale = 0.035, createCanvas, pixels })
 * -> THREE.Mesh (SphereGeometry 48x32, MeshMatcapMaterial { map, matcap, bumpMap }), frustumCulled false, layer 0, renderOrder 30.
 * `pixels` = a precomputed renderTennisPixels() result (shared between balls); the generator runs once (~0.3 s at 1024x512).
 */
export function makeTennisBallMesh(r, o = {}) {
  const createCanvas = canvasFactory(o);
  const W = o.width || TENNIS.width, H = o.height || TENNIS.height;
  const px = o.pixels || renderTennisPixels(W, H, o);
  const map = pixelsToTexture(createCanvas, px.data, px.width, px.height, true);
  const fuzz = o.fuzz ?? TENNIS.fuzz;
  const bumpMap = fuzz > 0 ? pixelsToTexture(createCanvas, px.bump, px.width, px.height, false) : null;
  const mat = new THREE.MeshMatcapMaterial({ map, matcap: makeMatcapTexture('felt', o), bumpMap, bumpScale: bumpMap ? (o.bumpScale ?? 0.035) : 0 });
  const seg = o.segments || 48;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 2 / 3)), mat);
  mesh.userData.pixels = px;
  return finishMesh(mesh, 'tennis', r, '#d8ff3a');
}

export function makeBasketballMesh(r, o = {}) {
  const createCanvas = canvasFactory(o);
  const px = o.pixels || renderBasketballPixels(o.width || BASKETBALL.width, o.height || BASKETBALL.height, o);
  const map = pixelsToTexture(createCanvas, px.data, px.width, px.height, true);
  const bumpMap = pixelsToTexture(createCanvas, px.bump, px.width, px.height, false);
  const mat = new THREE.MeshMatcapMaterial({ map, matcap: makeMatcapTexture('rubber', o), bumpMap, bumpScale: o.bumpScale ?? 0.03 });
  const seg = o.segments || 48;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 2 / 3)), mat);
  mesh.userData.pixels = px;
  return finishMesh(mesh, 'basketball', r, '#ff9a4a');
}

/** Apple: a sphere squashed to 0.9 with a dimple at the stem end, a tilted brown stem (child mesh). Hull radius stays r. */
export function makeAppleMesh(r, o = {}) {
  const createCanvas = canvasFactory(o);
  const px = o.pixels || renderApplePixels(o.width || APPLE.width, o.height || APPLE.height, o);
  const map = pixelsToTexture(createCanvas, px.data, px.width, px.height, true);
  const bumpMap = pixelsToTexture(createCanvas, px.bump, px.width, px.height, false);
  const mat = new THREE.MeshMatcapMaterial({ map, matcap: makeMatcapTexture('wax', o), bumpMap, bumpScale: o.bumpScale ?? 0.012 });
  const seg = o.segments || 40;
  const geo = new THREE.SphereGeometry(r, seg, Math.round(seg * 2 / 3));
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ny = y / r;
    const dimple = ny > 0.5 ? Math.pow((ny - 0.5) / 0.5, 2.5) * 0.45 * r : 0;   // stem cavity (~8 % of the height)
    const bottom = ny < -0.6 ? Math.pow((-ny - 0.6) / 0.4, 2) * 0.10 * r : 0;   // flatter base
    const bulge = 1 + 0.06 * Math.max(0, 1 - ny * ny);                           // shoulders
    pos.setXYZ(i, x * bulge, y * 0.92 - dimple + bottom, z * bulge);
  }
  pos.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  const stemMat = new THREE.MeshMatcapMaterial({ color: 0x5a3a1c, matcap: mat.matcap });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.045, r * 0.07, r * 0.55, 8), stemMat);
  stem.position.set(0, r * 0.725, 0); stem.rotation.z = 0.28; stem.name = 'stem';   // foot in the cavity, tip at the crown
  stem.frustumCulled = false; stem.layers.set(0); stem.renderOrder = 30;
  mesh.add(stem);
  mesh.userData.pixels = px;
  return finishMesh(mesh, 'apple', r, '#ff5a5a');
}

/** Glass: the old translucent look as a matcap — bluish-white disc with a bright rim (fresnel baked in), 55 % opaque. */
export function makeGlassMesh(r, o = {}) {
  const mat = new THREE.MeshMatcapMaterial({ color: new THREE.Color(o.color || '#a8ecd2'), matcap: makeMatcapTexture('glass', o), transparent: true, opacity: o.opacity ?? 0.55, depthWrite: false });
  const seg = o.segments || 40;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 2 / 3)), mat);
  return finishMesh(mesh, 'glass', r, '#bfe6ff');
}

export const BALL_KINDS = Object.freeze(['tennis', 'basketball', 'apple', 'glass']);

/** makeBallMesh(kind, r, opts) — 'tennis' | 'basketball' | 'apple' | 'glass' ('glass_ball' and unknown kinds fall back to glass). */
export function makeBallMesh(kind, r, o = {}) {
  switch (String(kind || '').toLowerCase()) {
    case 'tennis': case 'tennis_ball': case 'ball': return makeTennisBallMesh(r, o);
    case 'basketball': return makeBasketballMesh(r, o);
    case 'apple': return makeAppleMesh(r, o);
    default: return makeGlassMesh(r, o);
  }
}
