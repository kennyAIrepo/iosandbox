/**
 * tests/ball-visuals-smoke.mjs — Node verification of sdk/game/ball-visuals.js + sdk/game/ball-fx.js (no DOM, no
 * node-canvas: the canvas is a recording STUB injected through opts.createCanvas). Run from the repo root:
 *   node tests/ball-visuals-smoke.mjs
 *
 *   (1) the seam curve: unit sphere, closed, 4 equator crossings, lobes 50..72° high, no self-intersection
 *   (2) seamDistance: ~0 on the curve, (90° - max elevation) at the pole
 *   (3) renderTennisPixels: seam band coverage in range, seam texels off-white, felt texels optic yellow, fuzz present,
 *       bump has a groove at the seam edge; 1024x512 generation under 2.5 s
 *   (4) makeTennisBallMesh (stub canvas): MeshMatcapMaterial with map + matcap + bumpMap, 48x32 sphere, layer 0, frustumCulled false
 *   (5) makeBallMesh kinds: tennis | basketball (orange, black grooves) | apple (stem child, dimple) | glass (translucent)
 *   (6) BallFx state machine on fake ball states: trail length / retract / jump reset, squash 0.8 -> 1 in 90 ms with the
 *       transform handed back, auto-bounce from a velocity flip, catch pulse decay, held transition, 6-sprite puff, spin
 *       only without a caller quat, dispose
 */
import * as THREE from 'three';
import { SEAM, TENNIS, seamPoint, seamSamples, seamDistance, renderTennisPixels, renderBasketballPixels, renderApplePixels,
  makeTennisBallMesh, makeBallMesh, BALL_KINDS, paintMatcap, MATCAP_STYLES, noise3, curveDistanceField, circleSamples } from '../sdk/game/ball-visuals.js';
import { BallFx, FX } from '../sdk/game/ball-fx.js';

let passed = 0, failed = 0;
function ok(cond, label) { if (cond) { passed++; console.log('  ok   ' + label); } else { failed++; console.log('  FAIL ' + label); } }
const deg = r => r * 180 / Math.PI;

// ── stub canvas: records 2D calls, keeps putImageData pixels ─────────────────────────────────────────────────────────
const CALLS = [];
function stubCanvas(w, h) {
  const cv = { width: w, height: h, stub: true, pixels: null, calls: [] };
  const grad = () => ({ addColorStop() {} });
  const ctx = {
    fillStyle: null,
    createImageData: (W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }),
    putImageData: (img) => { cv.pixels = img.data; cv.calls.push('putImageData'); },
    createRadialGradient: () => { cv.calls.push('radial'); return grad(); },
    fillRect: () => cv.calls.push('fillRect'), clearRect: () => {}, beginPath: () => {}, arc: () => cv.calls.push('arc'), fill: () => cv.calls.push('fill'),
  };
  cv.getContext = () => ctx;
  CALLS.push(cv);
  return cv;
}

// ── (1) seam curve ───────────────────────────────────────────────────────────────────────────────────────────────────
console.log('(1) seam curve');
{
  const N = 2048, s = seamSamples(N);
  let maxErr = 0, maxY = 0, crossings = 0;
  for (let i = 0; i < N; i++) {
    const x = s[i * 3], y = s[i * 3 + 1], z = s[i * 3 + 2];
    maxErr = Math.max(maxErr, Math.abs(Math.hypot(x, y, z) - 1));
    maxY = Math.max(maxY, Math.abs(y));
    const yn = s[((i + 1) % N) * 3 + 1];
    if ((y >= 0) !== (yn >= 0)) crossings++;
  }
  ok(maxErr < 1e-6, `samples on the unit sphere (max |len-1| = ${maxErr.toExponential(2)})`);
  const p0 = seamPoint(0), p1 = seamPoint(Math.PI * 2);
  ok(Math.hypot(p0.x - p1.x, p0.y - p1.y, p0.z - p1.z) < 1e-9, 'closed curve (p(0) == p(2pi))');
  ok(crossings === 4, `4 equator crossings (${crossings})`);
  const elev = deg(Math.asin(maxY));
  ok(elev > 50 && elev < 72, `lobe peak elevation ${elev.toFixed(1)}° in 50..72`);
  // no self-intersection: min distance between samples more than N/16 apart along the curve
  let minSep = 9;
  for (let i = 0; i < N; i += 4) for (let j = i + N / 16; j < i + N - N / 16; j += 4) {
    const k = j % N; const d = Math.hypot(s[i * 3] - s[k * 3], s[i * 3 + 1] - s[k * 3 + 1], s[i * 3 + 2] - s[k * 3 + 2]); if (d < minSep) minSep = d;
  }
  ok(minSep > 0.3, `no self-intersection: min chord between far samples ${minSep.toFixed(3)} > 0.3 (lobes ${deg(2 * Math.asin(minSep / 2)).toFixed(0)}° apart)`);
  // symmetry: rotating 180° about y maps the curve onto itself
  let symErr = 0;
  for (let i = 0; i < N; i += 16) { const d = seamDistance({ x: -s[i * 3], y: s[i * 3 + 1], z: -s[i * 3 + 2] }, s); symErr = Math.max(symErr, d); }
  ok(symErr < 0.01, `180° symmetry about the lobe axis (max ${symErr.toExponential(1)} rad)`);
}

// ── (2) seamDistance ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log('(2) seamDistance');
{
  const s = seamSamples();
  const on = seamPoint(1.234);
  ok(seamDistance(on, s) < 2e-3, `on-curve point: ${seamDistance(on, s).toExponential(2)} rad`);
  const pole = seamDistance({ x: 0, y: 1, z: 0 }, s);
  let maxY = 0; for (let i = 1; i < s.length; i += 3) maxY = Math.max(maxY, s[i]);
  ok(Math.abs(pole - (Math.PI / 2 - Math.asin(maxY))) < 2e-3, `pole distance ${deg(pole).toFixed(1)}° == 90° - peak elevation`);
  ok(Math.abs(seamDistance({ x: 1, y: 0, z: 0 }, s)) < 2e-3, 'the +x equator point is on the seam');
  ok(Math.abs(noise3(1.5, 2.5, 3.5) - noise3(1.5, 2.5, 3.5)) === 0 && noise3(0.2, 0.3, 0.4) >= 0 && noise3(0.2, 0.3, 0.4) <= 1, 'noise3 deterministic, in 0..1');
}

// ── (3) tennis pixels ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('(3) renderTennisPixels');
{
  const W = 512, H = 256;
  const t0 = performance.now();
  const px = renderTennisPixels(W, H);
  const ms = performance.now() - t0;
  ok(px.data.length === W * H * 4 && px.bump.length === W * H * 4 && px.dist.length === W * H, `buffers sized (${ms.toFixed(0)} ms at ${W}x${H})`);
  let seamN = 0, feltN = 0, sr = 0, sg = 0, sb = 0, fr = 0, fg = 0, fb = 0, fmin = 255, fmax = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (px.seamMask[i]) { seamN++; sr += px.data[o]; sg += px.data[o + 1]; sb += px.data[o + 2]; }
    else if (px.dist[i] > 0.3) { feltN++; fr += px.data[o]; fg += px.data[o + 1]; fb += px.data[o + 2]; fmin = Math.min(fmin, px.data[o + 1]); fmax = Math.max(fmax, px.data[o + 1]); }
  }
  const frac = seamN / (W * H);
  ok(frac > 0.06 && frac < 0.2, `seam band covers ${(frac * 100).toFixed(1)} % of texels (6..20 %)`);
  sr /= seamN; sg /= seamN; sb /= seamN; fr /= feltN; fg /= feltN; fb /= feltN;
  ok(sr > 190 && sg > 185 && sb > 165 && Math.abs(sr - sg) < 20, `seam texels off-white (${sr.toFixed(0)},${sg.toFixed(0)},${sb.toFixed(0)})`);
  ok(fg > 200 && fr > 150 && fr < 235 && fb < 90, `felt texels optic yellow (${fr.toFixed(0)},${fg.toFixed(0)},${fb.toFixed(0)})`);
  ok(fmax - fmin > 30, `felt fuzz modulation: green channel spread ${fmax - fmin}`);
  // bump: groove darker just outside the band than deep in the felt
  let groove = 0, gN = 0, felt = 0, fN = 0;
  const hw = TENNIS.seamWidth * Math.PI;
  for (let i = 0; i < W * H; i++) { const d = px.dist[i]; if (d > hw && d < hw * 1.2) { groove += px.bump[i * 4]; gN++; } else if (d > 0.3) { felt += px.bump[i * 4]; fN++; } }
  ok(groove / gN < felt / fN - 25, `bump groove at the seam edge (${(groove / gN).toFixed(0)} vs felt ${(felt / fN).toFixed(0)})`);
  // the seam is seamless across the u wrap: column 0 and column W-1 masks agree on most rows
  let agree = 0; for (let y = 0; y < H; y++) if (px.seamMask[y * W] === px.seamMask[y * W + W - 1]) agree++;
  ok(agree / H > 0.97, `u-wrap continuity: ${agree}/${H} rows agree at the seam of the map`);
  // flat felt when fuzz = 0
  const flat = renderTennisPixels(64, 32, { fuzz: 0 });
  let lo = 255, hi = 0; for (let i = 0; i < 64 * 32; i++) if (flat.dist[i] > 0.3) { lo = Math.min(lo, flat.data[i * 4 + 1]); hi = Math.max(hi, flat.data[i * 4 + 1]); }
  ok(hi - lo <= 1, `fuzz 0 -> flat felt (spread ${hi - lo})`);
  // full-size timing
  const t1 = performance.now(); const full = renderTennisPixels(1024, 512); const ms1 = performance.now() - t1;
  ok(full.width === 1024 && ms1 < 2500, `1024x512 generated in ${ms1.toFixed(0)} ms (< 2500)`);
  // seamWidth scales the band
  const wide = renderTennisPixels(256, 128, { seamWidth: 0.06 }), thin = renderTennisPixels(256, 128, { seamWidth: 0.02 });
  const cover = p => p.seamMask.reduce((a, b) => a + b, 0) / p.seamMask.length;
  ok(cover(wide) > cover(thin) * 2, `seamWidth scales the band (${(cover(wide) * 100).toFixed(1)} % vs ${(cover(thin) * 100).toFixed(1)} %)`);
}

// ── (4) makeTennisBallMesh with the stub canvas ──────────────────────────────────────────────────────────────────────
console.log('(4) makeTennisBallMesh');
let tennis;
{
  CALLS.length = 0;
  tennis = makeTennisBallMesh(0.05, { createCanvas: stubCanvas, width: 256, height: 128 });
  const m = tennis.material;
  ok(tennis.isMesh && m.isMeshMatcapMaterial, 'THREE.Mesh with MeshMatcapMaterial');
  ok(m.map && m.map.isCanvasTexture && m.map.colorSpace === THREE.SRGBColorSpace, 'map = sRGB CanvasTexture');
  ok(m.matcap && m.matcap.isCanvasTexture && m.matcap.colorSpace === THREE.SRGBColorSpace, 'matcap = sRGB CanvasTexture');
  ok(m.bumpMap && m.bumpMap.isCanvasTexture && m.bumpScale > 0 && m.bumpMap.colorSpace === THREE.NoColorSpace, `bumpMap set, bumpScale ${m.bumpScale}`);
  ok(m.map.image.pixels && m.map.image.pixels.length === 256 * 128 * 4, 'pixels reached the injected canvas via putImageData');
  const g = tennis.geometry; g.computeBoundingSphere();
  ok(g.parameters.widthSegments === 48 && g.parameters.heightSegments === 32, `sphere 48x32 (${g.parameters.widthSegments}x${g.parameters.heightSegments})`);
  ok(Math.abs(g.boundingSphere.radius - 0.05) < 1e-3, `radius ${g.boundingSphere.radius.toFixed(4)} ~ 0.05`);
  ok(tennis.frustumCulled === false && tennis.layers.mask === 1 && tennis.renderOrder === 30, 'frustumCulled false, layer 0, renderOrder 30');
  ok(tennis.userData.kind === 'tennis' && tennis.userData.radius === 0.05 && tennis.name === 'tennisBall', 'userData.kind / radius / name');
  const matcapCv = CALLS.find(c => c.width === 256 && c.height === 256);
  ok(matcapCv && matcapCv.calls.includes('radial') && matcapCv.calls.includes('arc'), 'matcap painted with radial gradients + arcs');
  const noFuzz = makeTennisBallMesh(0.05, { createCanvas: stubCanvas, width: 64, height: 32, fuzz: 0 });
  ok(noFuzz.material.bumpMap === null && noFuzz.material.bumpScale === 0, 'fuzz 0 -> no bumpMap');
  let threw = null; try { makeTennisBallMesh(0.05, { width: 32, height: 16 }); } catch (e) { threw = e; }
  ok(threw && /createCanvas/.test(threw.message), 'no canvas + no factory -> clear error');
  const shared = makeTennisBallMesh(0.07, { createCanvas: stubCanvas, pixels: tennis.userData.pixels });
  ok(shared.userData.pixels === tennis.userData.pixels, 'opts.pixels reuses a generated map');
  for (const k of Object.keys(MATCAP_STYLES)) { const cv = stubCanvas(64, 64); paintMatcap(cv.getContext('2d'), 64, MATCAP_STYLES[k]); ok(cv.calls.filter(c => c === 'fill').length >= 1, `paintMatcap '${k}' fills the disc`); }
}

// ── (5) kinds ────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('(5) makeBallMesh kinds');
{
  ok(BALL_KINDS.length === 4, 'four kinds');
  const meshes = {};
  for (const k of BALL_KINDS) {
    const m = makeBallMesh(k, 0.06, { createCanvas: stubCanvas, width: 128, height: 64 });
    meshes[k] = m;
    m.geometry.computeBoundingSphere();
    ok(m.isMesh && m.material.isMeshMatcapMaterial && m.frustumCulled === false && m.layers.mask === 1, `${k}: matcap mesh, layer 0, frustumCulled false`);
    ok(Math.abs(m.geometry.boundingSphere.radius - 0.06) < 0.06 * 0.12, `${k}: bounding radius ${m.geometry.boundingSphere.radius.toFixed(4)} ~ 0.06`);
    ok(m.userData.kind === k && typeof m.userData.dispose === 'function', `${k}: userData.kind + dispose()`);
  }
  const bb = renderBasketballPixels(256, 128);
  let gr = 0, gN = 0, br = 0, bg = 0, bbl = 0, bN = 0;
  for (let i = 0; i < 256 * 128; i++) { const o = i * 4; if (bb.seamMask[i]) { gr += bb.data[o] + bb.data[o + 1] + bb.data[o + 2]; gN++; } else { br += bb.data[o]; bg += bb.data[o + 1]; bbl += bb.data[o + 2]; bN++; } }
  ok(gN > 0 && gr / gN / 3 < 40, `basketball grooves black (mean ${(gr / gN / 3).toFixed(0)})`);
  ok(br / bN > 180 && bg / bN > 90 && bg / bN < 150 && bbl / bN < 80, `basketball rubber orange (${(br / bN).toFixed(0)},${(bg / bN).toFixed(0)},${(bbl / bN).toFixed(0)})`);
  ok(gN / (256 * 128) > 0.03 && gN / (256 * 128) < 0.16, `basketball groove coverage ${(gN / (256 * 128) * 100).toFixed(1)} %`);
  const ap = renderApplePixels(128, 64);
  let ar = 0, ag = 0, ab = 0; for (let i = 0; i < 128 * 64; i++) { ar += ap.data[i * 4]; ag += ap.data[i * 4 + 1]; ab += ap.data[i * 4 + 2]; }
  ar /= 128 * 64; ag /= 128 * 64; ab /= 128 * 64;
  ok(ar > 150 && ag < 140 && ab < 90 && ar > ag + 40, `apple skin red (${ar.toFixed(0)},${ag.toFixed(0)},${ab.toFixed(0)})`);
  const stem = meshes.apple.children.find(c => c.name === 'stem');
  ok(stem && stem.isMesh && stem.position.y > 0.06 * 0.6, 'apple has a stem child above the crown');
  const pos = meshes.apple.geometry.attributes.position; let topY = -1; for (let i = 0; i < pos.count; i++) topY = Math.max(topY, pos.getY(i));
  const polar = pos.getY(0);
  ok(polar < topY - 0.003, `apple dimple: pole y ${polar.toFixed(4)} below the shoulders ${topY.toFixed(4)}`);
  ok(meshes.glass.material.transparent && meshes.glass.material.opacity < 1 && meshes.glass.material.depthWrite === false, `glass translucent (opacity ${meshes.glass.material.opacity})`);
  ok(makeBallMesh('glass_ball', 0.06, { createCanvas: stubCanvas }).userData.kind === 'glass' && makeBallMesh('zebra', 0.06, { createCanvas: stubCanvas }).userData.kind === 'glass', 'glass_ball / unknown -> glass');
  ok(meshes.tennis.material.map !== meshes.basketball.material.map && meshes.tennis.material.matcap !== meshes.basketball.material.matcap, 'kinds carry their own map + matcap');
  const cs = circleSamples({ x: 0, y: 0, z: 1 }, 0.32, 64); let e = 0; for (let i = 0; i < 64; i++) e = Math.max(e, Math.abs(cs[i * 3 + 2] - 0.32), Math.abs(Math.hypot(cs[i * 3], cs[i * 3 + 1], cs[i * 3 + 2]) - 1));
  ok(e < 1e-6, 'circleSamples: unit-sphere circle in the plane z = 0.32');
  const df = curveDistanceField(64, 32, [circleSamples({ x: 0, y: 1, z: 0 }, 0, 256)], 0.4);
  ok(df[16 * 64 + 5] < 0.06 && df[2 * 64 + 5] >= 0.4, 'curveDistanceField: equator row ~0, pole row untouched');
}

// ── (6) BallFx state machine ─────────────────────────────────────────────────────────────────────────────────────────
console.log('(6) BallFx');
{
  const scene = new THREE.Scene();
  const mesh = makeTennisBallMesh(0.05, { createCanvas: stubCanvas, width: 64, height: 32 });
  scene.add(mesh);
  const fx = new BallFx(scene, mesh, { createCanvas: stubCanvas });
  ok(scene.children.includes(fx.group) && fx.trail.parent === fx.group && fx.puffs.length === FX.PUFF_N, 'trail / halo / 6 puff sprites live in one group on the scene');
  ok(fx.trail.material.isMeshBasicMaterial && fx.trail.geometry.attributes.color.itemSize === 4 && fx.trail.layers.mask === 1, 'trail: unlit ribbon with RGBA vertex colours on layer 0');
  const dt = 1 / 60;
  const st = (x, y, vx, vy, extra = {}) => Object.assign({ pos: { x, y, z: -2 }, vel: { x: vx, y: vy, z: 0 }, r: 0.05, phase: 'flight', onSurface: false }, extra);
  // trail grows while fast
  let x = 0;
  for (let i = 0; i < 30; i++) { x += 1.2 * dt; mesh.position.set(x, 0, -2); fx.update(dt, st(x, 0, 1.2, 0)); }
  ok(fx.state.trail === FX.TRAIL_N && fx.trail.visible, `trail holds ${fx.state.trail} points while |v| = 1.2 m/s`);
  ok(fx.trail.geometry.drawRange.count === (FX.TRAIL_N - 1) * 6, 'trail draw range = (N-1) quads');
  const col = fx.trail.geometry.attributes.color.array;
  ok(col[3] > col[(FX.TRAIL_N - 1) * 8 + 3] && col[(FX.TRAIL_N - 1) * 8 + 3] < 0.05, `trail alpha fades head ${col[3].toFixed(2)} -> tail ${col[(FX.TRAIL_N - 1) * 8 + 3].toFixed(3)}`);
  // slow: retracts
  let frames = 0; while (fx.state.trail > 0 && frames < 20) { fx.update(dt, st(x, 0, 0.2, 0)); frames++; }
  ok(fx.state.trail === 0 && !fx.trail.visible && frames <= FX.TRAIL_N / FX.TRAIL_RETRACT + 1, `trail retracts at |v| = 0.2 (gone after ${frames} frames)`);
  // below the threshold never starts
  for (let i = 0; i < 10; i++) fx.update(dt, st(x, 0, 0.59, 0));
  ok(fx.state.trail === 0, 'no trail at 0.59 m/s');
  // jump reset
  for (let i = 0; i < 10; i++) { x += 1.2 * dt; fx.update(dt, st(x, 0, 1.2, 0)); }
  fx.update(dt, st(x + 1.5, 0, 1.2, 0));
  ok(fx.state.trail === 1, `teleport > ${FX.TRAIL_JUMP_RESET} m resets the trail (${fx.state.trail})`);
  // held: no trail
  fx.update(dt, st(x, 0, 2, 0, { held: true }));
  ok(fx.state.trail === 0, 'held ball carries no trail');
  // squash timing
  const fx2 = new BallFx(scene, mesh, { createCanvas: stubCanvas, autoBounce: false, autoPuff: false, spin: 'off' });
  mesh.position.set(0.1, -0.4, -2);
  fx2.bounce({ x: 0, y: 1, z: 0 });
  fx2.update(0, st(0.1, -0.4, 0, 0));
  ok(Math.abs(fx2.state.squash.k - FX.SQUASH_SCALE) < 1e-6 && fx2.state.squash.active, `squash k = ${fx2.state.squash.k.toFixed(3)} at t = 0`);
  ok(mesh.matrixAutoUpdate === false && Math.abs(mesh.matrix.elements[5] - FX.SQUASH_SCALE) < 1e-6 && Math.abs(mesh.matrix.elements[0] - 1.1) < 1e-6, `mesh.matrix y-scale ${mesh.matrix.elements[5].toFixed(3)}, x bulge ${mesh.matrix.elements[0].toFixed(3)} (composed, PropBall transform kept)`);
  ok(Math.abs(mesh.matrix.elements[12] - 0.1) < 1e-9 && Math.abs(mesh.matrix.elements[13] + 0.4) < 1e-9, 'squashed matrix keeps the ball position');
  fx2.update(0.045, st(0.1, -0.4, 0, 0));
  const mid = fx2.state.squash.k;
  ok(mid > FX.SQUASH_SCALE && mid < 1 && fx2.state.squash.active, `mid squash k = ${mid.toFixed(3)} at 45 ms`);
  fx2.update(0.05, st(0.1, -0.4, 0, 0));
  ok(!fx2.state.squash.active && fx2.state.squash.k === 1 && mesh.matrixAutoUpdate === true, 'squash over after 95 ms, matrixAutoUpdate restored');
  // strength + wall normal
  fx2.bounce({ x: 1, y: 0, z: 0 }, 0.5); fx2.update(0, st(0.1, -0.4, 0, 0));
  ok(Math.abs(mesh.matrix.elements[0] - 0.9) < 1e-6 && mesh.matrix.elements[5] > 1, `wall bounce squashes x (${mesh.matrix.elements[0].toFixed(2)}), bulges y (${mesh.matrix.elements[5].toFixed(2)})`);
  fx2.update(0.2, st(0.1, -0.4, 0, 0));
  // auto bounce: landing flip
  const fx3 = new BallFx(scene, mesh, { createCanvas: stubCanvas, spin: 'off' });
  fx3.update(dt, st(0, -0.3, 0, -1.5));
  fx3.update(dt, st(0, -0.32, 0, -1.6));
  fx3.update(dt, st(0, -0.35, 0, 0.9, { onSurface: true }));
  ok(fx3.state.squash.active && fx3.state.squash.t <= 17, `landing (vy -1.6 -> +0.9, onSurface) triggers the squash (t = ${fx3.state.squash.t.toFixed(1)} ms)`);
  ok(fx3.state.puffs === FX.PUFF_N, `hard landing (vy < ${FX.PUFF_AUTO_VY}) puffs ${fx3.state.puffs} sprites`);
  for (let i = 0; i < 40; i++) fx3.update(dt, st(0, -0.35, 0, 0, { onSurface: true }));
  ok(fx3.state.puffs === 0 && !fx3.state.squash.active, 'puff gone after 660 ms, squash finished');
  // wall flip
  fx3.update(dt, st(0.5, -0.35, 1.2, 0)); fx3.update(dt, st(0.55, -0.35, 1.2, 0)); fx3.update(dt, st(0.55, -0.35, -0.8, 0));
  ok(fx3.state.squash.active && Math.abs(fx3._squash.n.x) === 1, 'vx sign flip triggers a wall squash along x');
  for (let i = 0; i < 12; i++) fx3.update(dt, st(0.5, -0.35, -0.8, 0));
  // catch pulse
  const fx4 = new BallFx(scene, mesh, { createCanvas: stubCanvas, spin: 'off', autoBounce: false });
  const base = mesh.material.color.clone();
  fx4.update(dt, st(0, 0, 0, 0));
  fx4.update(dt, st(0, 0, 0, 0, { held: true }));
  ok(fx4.state.pulse > 0.8 && fx4.state.haloVisible && mesh.material.color.r > base.r * 1.2, `held transition -> pulse ${fx4.state.pulse.toFixed(2)}, halo visible, colour flash`);
  ok(Math.abs(fx4.halo.scale.x - 0.05 * (1.03 + 0.15 * fx4.state.pulse)) < 1e-6, 'halo scaled to the ball radius');
  let t = 0; while (fx4.state.pulse > 0.05 && t < 1) { fx4.update(dt, st(0, 0, 0, 0, { held: true })); t += dt; }
  ok(t < 0.5, `pulse decays below 0.05 in ${(t * 1000).toFixed(0)} ms (< 500)`);
  for (let i = 0; i < 60; i++) fx4.update(dt, st(0, 0, 0, 0, { held: true }));
  ok(!fx4.state.haloVisible && mesh.material.color.equals(base), 'halo hidden and colour restored once the pulse is spent');
  fx4.catchPulse(); ok(fx4.state.pulse === 1, 'catchPulse() re-arms');
  // miss puff explicit
  fx4.missPuff({ x: 0.2, y: -0.4, z: -2 });
  ok(fx4.state.puffs === 6 && fx4.puffs.every(p => Math.abs(p.position.x - 0.2) < 1e-9), 'missPuff(pos): 6 sprites at pos');
  fx4.update(dt, st(0, 0, 0, 0));
  ok(fx4.puffs.every(p => p.position.distanceTo(new THREE.Vector3(0.2, -0.4, -2)) > 1e-4) && fx4.puffs.some(p => p.userData.vel.y > 0), 'puffs spread (upward bias)');
  // spin: synthesized roll without a quat; untouched with one
  for (let i = 0; i < 60; i++) fx4.update(dt, st(0, 0, 0, 0));        // spend fx4's re-armed pulse so the colour is at rest
  const base5 = mesh.material.color.clone();                             // one BallFx per mesh in production; stacked ones capture the current colour
  const fx5 = new BallFx(scene, mesh, { createCanvas: stubCanvas, autoBounce: false });
  mesh.quaternion.identity();
  const q0 = mesh.quaternion.clone();
  for (let i = 0; i < 10; i++) fx5.update(dt, st(0, -0.35, 0.5, 0, { onSurface: true }));
  ok(mesh.quaternion.angleTo(q0) > 0.5 && fx5.state.spinRate > 5, `roll synthesized on the shelf: ${mesh.quaternion.angleTo(q0).toFixed(2)} rad over 10 frames (omega ${fx5.state.spinRate.toFixed(1)} rad/s = v/r)`);
  const q1 = mesh.quaternion.clone();
  for (let i = 0; i < 10; i++) fx5.update(dt, st(0, 0, 0.5, 0, { quat: q1 }));
  ok(mesh.quaternion.equals(q1), 'with a caller quat (PropBall owns spin) BallFx leaves mesh.quaternion alone');
  fx5.update(dt, st(0, 0, 0.5, 0, { angVel: { x: 0, y: 0, z: 3 } }));
  ok(Math.abs(fx5.state.spinRate - 3) < 1e-6, 'explicit angVel drives the spin rate');
  // shadow
  fx5.update(dt, st(0, -0.4, 0, 0, { floorY: -0.45 }));
  ok(fx5.state.shadowVisible && fx5.shadow.material.opacity > 0.3, `contact shadow at the foot (opacity ${fx5.shadow.material.opacity.toFixed(2)})`);
  fx5.update(dt, st(0, 0.5, 0, 0, { floorY: -0.45 }));
  ok(!fx5.state.shadowVisible, 'shadow gone 0.9 m up');
  // update without a state keeps timers moving
  fx5.catchPulse(); for (let i = 0; i < 5; i++) fx5.update(0.1, null);
  ok(fx5.state.pulse < 0.05, 'update(dt, null) still advances timers');
  // settle: mid-squash + trail + pulse -> all cleared, transform handed back
  for (let i = 0; i < 12; i++) fx5.update(dt, st(i * 0.03, 0, 1.8, 0));
  fx5.bounce({ x: 1, y: 0, z: 0 }); fx5.catchPulse(); fx5.update(0.02, st(0.36, 0, 1.8, 0));
  ok(fx5.state.squash.active && mesh.matrixAutoUpdate === false && fx5.state.trail === FX.TRAIL_N && fx5.state.pulse > 0.5, 'pre-settle: squash live, trail full, pulse live');
  fx5.settle();
  const cl = { squashOff: !fx5.state.squash.active, autoMatrix: mesh.matrixAutoUpdate === true, trail0: fx5.state.trail === 0, trailHidden: !fx5.trail.visible, pulse0: fx5.state.pulse === 0, haloHidden: !fx5.state.haloVisible, colourBack: mesh.material.color.equals(base5) };
  ok(Object.values(cl).every(Boolean), 'settle(): squash ended (auto matrix back), trail cleared, pulse cleared, colour restored ' + JSON.stringify(cl));
  const sc = new THREE.Vector3().setFromMatrixScale(mesh.matrix);
  ok(Math.abs(sc.x - 1) < 1e-9 && Math.abs(sc.y - 1) < 1e-9 && Math.abs(sc.z - 1) < 1e-9, `settle(): mesh.matrix recomposed unsquashed (scale ${sc.x.toFixed(3)}, ${sc.y.toFixed(3)}, ${sc.z.toFixed(3)})`);
  // dispose
  const before = scene.children.length;
  fx.dispose(); fx2.dispose(); fx3.dispose(); fx4.dispose(); fx5.dispose();
  ok(scene.children.length === before - 5 && mesh.matrixAutoUpdate === true, 'dispose removes the groups and hands the transform back');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
