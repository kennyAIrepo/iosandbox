/**
 * _ballvisprobe.mjs — headless probe for sdk/game/ball-visuals.js + ball-fx.js through tests/_ballvis.html (ONE renderer,
 * three scissored views of one tennis ball at r = 0.05: 2x zoom ~200 px, tile size ~22 px, small tile ~13 px).
 *   (1) page boots, one canvas / one WebGL context, textures generated in < 3 s
 *   (2) fps over 2.5 s with the FX running (trail, squash, catch pulse, puffs, shadow) > 50; draw calls per frame small
 *   (3) seam visible: pixels along the projected seam vs felt pixels — luminance gap, seam off-white, felt optic yellow — per view
 *   (4) FX observable in the page: trail points while fast, pulse after catchPulse(), 6 puff sprites after missPuff()
 *   (5) screenshots: tennis-ball.png (all three sizes), tennis-ball-2x/-tile/-small.png, tennis-ball-fx.png, ball-kinds.png
 * Run from the repo root: node tests/_ballvisprobe.mjs   (reuses :3333 when it serves the fixture, else spawns tools/dev-server.mjs)
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1280,600'];
const FILTER = /favicon|XNNPACK|404|GPU stall|WebGL warning|GL_INVALID|OpenGL ES|deprecated/i;

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? '  ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function serves(port) { try { const r = await fetch(`http://localhost:${port}/tests/_ballvis.html`); return r.ok && (await r.text()).includes('ball visuals'); } catch { return false; } }
function busy(port) { return new Promise(res => { const s = net.createServer(); s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false))); s.listen(port, '127.0.0.1'); }); }
let PORT = +(process.env.HOPEOS_PORT || 3333), server = null;
if (!(await serves(PORT))) {
  while (await busy(PORT)) PORT++;
  server = spawn(process.execPath, [path.join(REPO, 'tools/dev-server.mjs'), String(PORT)], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await serves(PORT)); i++) await sleep(100);
  console.log(`  (spawned dev server on :${PORT})`);
} else console.log(`  (reusing dev server on :${PORT})`);

const lum = p => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
const mean = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : NaN;
const r1 = v => +v.toFixed(1);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ARGS });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 420 });
  page.on('console', m => { if (m.type() === 'error' && !FILTER.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  console.log('(1) boot');
  await page.goto(`http://localhost:${PORT}/tests/_ballvis.html?fixedstep=1&kind=tennis&r=0.05`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bv && window.__bv.ready, { timeout: 30000 });
  const boot = await page.evaluate(() => ({ textureMs: window.__bv.textureMs, contexts: window.__bv.contexts, kind: window.__bv.kind, r: window.__bv.r }));
  ok(boot.kind === 'tennis' && boot.r === 0.05, `tennis ball r = ${boot.r}`);
  ok(boot.contexts === 1, `one canvas / one WebGL context (${boot.contexts})`);
  ok(boot.textureMs < 3000, `textures generated in ${boot.textureMs.toFixed(0)} ms (< 3000)`);

  console.log('(2) fps with the FX running');
  await sleep(1500);                                   // warm-up: shader compiles + texture uploads land in the first second
  await page.evaluate(() => window.__bv.resetStats());
  await sleep(3000);                                   // measure: 3 s of rAF with trail / squash / pulse / puffs / shadow live
  const perf = await page.evaluate(() => ({ fps: window.__bv.fps, frames: window.__bv.frames, frameMs: window.__bv.frameMs, info: window.__bv.info, fx: window.__bv.fx }));
  ok(perf.fps > 50, `fps ${r1(perf.fps)} > 50 over ${perf.frames} frames after a 1.5 s warm-up; CPU ${perf.frameMs.p50.toFixed(2)} ms p50 / ${perf.frameMs.p95.toFixed(2)} ms p95 per frame (step + 3 renders)`);
  ok(perf.info.calls > 0 && perf.info.calls <= 40, `draw calls per frame ${perf.info.calls} (3 views x {shelf, ball, trail, halo, puffs, shadow})`);
  ok(perf.fx && typeof perf.fx.trail === 'number', `fx state readable: trail ${perf.fx.trail}, squash ${perf.fx.squash.active}, puffs ${perf.fx.puffs}, shadow ${perf.fx.shadowVisible}`);

  console.log('(3) seam visible at three sizes');
  // park the ball mid-air, still, so the samples and the shots show a clean sphere
  await page.evaluate(() => { window.__bv.pause(); window.__bv.setState({ pos: { x: 0, y: -0.1, z: -2 }, vel: { x: 0, y: 0, z: 0 }, held: false, onSurface: false, phase: 'flight', quat: 'identity' }); });
  // visibility = LOCAL luminance step (each seam pixel vs the felt pixels within 0.45 rad of it on the sphere, so the
  // matcap's light-to-shadow gradient cancels) AND colour distance (cream on lime: the blue channel carries most of it)
  const NAMES = ['2x zoom', 'tile', 'small'], MIN_GAP = [20, 14, 8], MIN_DIST = [120, 80, 40];
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const perView = [];
  for (let v = 0; v < 3; v++) {
    const s = await page.evaluate(v => window.__bv.samples(v), v);
    const seamL = mean(s.seam, lum), feltL = mean(s.felt, lum);
    const seam = { r: mean(s.seam, p => p.r), g: mean(s.seam, p => p.g), b: mean(s.seam, p => p.b) };
    const felt = { r: mean(s.felt, p => p.r), g: mean(s.felt, p => p.g), b: mean(s.felt, p => p.b) };
    const dist = Math.hypot(seam.r - felt.r, seam.g - felt.g, seam.b - felt.b);
    const gaps = [];
    for (const p of s.seam) { const near = s.felt.filter(f => ang(p.d, f.d) < 0.45); if (near.length >= 2) gaps.push(lum(p) - mean(near, lum)); }
    const localGap = mean(gaps, x => x);
    perView.push({ v, seamL, feltL, localGap, pairs: gaps.length, dist, seam, felt, n: [s.seam.length, s.felt.length], ballPx: s.ballPx });
    const tag = `${NAMES[v]} (ball ${r1(s.ballPx)} px, ${s.seam.length} seam / ${s.felt.length} felt samples)`;
    ok(s.seam.length >= 20 && s.felt.length >= 20 && gaps.length >= 15, `${tag}: enough front-facing samples (${gaps.length} seam pixels with felt neighbours)`);
    ok(localGap > MIN_GAP[v] && dist > MIN_DIST[v], `${tag}: seam visible — local luminance +${r1(localGap)} (> ${MIN_GAP[v]}), RGB distance ${r1(dist)} (> ${MIN_DIST[v]}); global means seam ${r1(seamL)}, felt ${r1(feltL)}`);
    ok(felt.g > 120 && felt.b < felt.g * 0.6 && felt.r < felt.g + 10, `${tag}: felt reads optic yellow-green (${r1(felt.r)},${r1(felt.g)},${r1(felt.b)})`);
    if (v < 2) ok(seam.b > felt.b + 40 && Math.abs(seam.r - seam.g) < 40, `${tag}: seam reads off-white (${r1(seam.r)},${r1(seam.g)},${r1(seam.b)})`);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'tennis-ball.png'), clip: { x: 0, y: 0, width: 1200, height: 420 } });
  await page.screenshot({ path: path.join(SHOT_DIR, 'tennis-ball-2x.png'), clip: { x: 0, y: 0, width: 400, height: 420 } });
  await page.screenshot({ path: path.join(SHOT_DIR, 'tennis-ball-tile.png'), clip: { x: 400, y: 0, width: 400, height: 420 } });
  await page.screenshot({ path: path.join(SHOT_DIR, 'tennis-ball-small.png'), clip: { x: 800, y: 0, width: 400, height: 420 } });
  ok(fs.existsSync(path.join(SHOT_DIR, 'tennis-ball.png')), `screenshots -> ${SHOT_DIR}/tennis-ball*.png`);

  console.log('(4) FX observable');
  // a fast ball for the trail, then a catch pulse and a puff in the same frame for the FX shot
  await page.evaluate(() => { window.__bv.setState({ pos: { x: -0.4, y: 0.1, z: -2 }, vel: { x: 2.2, y: 1.2, z: 0 }, held: false, onSurface: false, phase: 'flight', nextCatch: 1e9 }); for (let i = 0; i < 14; i++) window.__bv.stepOnce(1 / 60); });
  let st = await page.evaluate(() => window.__bv.fx);
  ok(st.trail >= 10 && st.trailVisible, `trail ${st.trail} points while |v| > 2 m/s`);
  await page.evaluate(() => { window.__bv.catchPulse(); window.__bv.missPuff(); window.__bv.stepOnce(1 / 60); });
  st = await page.evaluate(() => window.__bv.fx);
  ok(st.pulse > 0.7 && st.haloVisible, `catch pulse ${r1(st.pulse)} with the halo visible`);
  ok(st.puffs === 6, `${st.puffs} puff sprites live`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'tennis-ball-fx.png'), clip: { x: 0, y: 0, width: 1200, height: 420 } });
  // the bounce: drop it from 0.4 m onto the shelf and watch the squash go through 0.8 -> 1
  const squash = await page.evaluate(() => {
    window.__bv.setState({ pos: { x: 0, y: -0.2, z: -2 }, vel: { x: 0.9, y: -3.0, z: 0 }, held: false, onSurface: false, phase: 'flight' });
    const ks = []; for (let i = 0; i < 40; i++) { window.__bv.stepOnce(1 / 60); const s = window.__bv.fx; if (s.squash.active) ks.push(+s.squash.k.toFixed(3)); }
    return ks;
  });
  ok(squash.length >= 4 && Math.min(...squash) < 0.9 && squash[squash.length - 1] > Math.min(...squash), `squash on the shelf bounce: k ${squash.slice(0, 6).join(' ')}${squash.length > 6 ? ' ...' : ''} (${squash.length} frames)`);

  console.log('(5) kinds line-up');
  await page.goto(`http://localhost:${PORT}/tests/_ballvis.html?kinds=1&r=0.05`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bv && window.__bv.ready, { timeout: 30000 });
  await sleep(600);
  const kinds = await page.evaluate(() => ({ contexts: window.__bv.contexts, textureMs: window.__bv.textureMs, calls: window.__bv.info.calls }));
  ok(kinds.contexts === 1 && kinds.textureMs < 4000, `four kinds on one context, textures in ${kinds.textureMs.toFixed(0)} ms`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'ball-kinds.png'), clip: { x: 0, y: 0, width: 1200, height: 420 } });
  ok(fs.existsSync(path.join(SHOT_DIR, 'ball-kinds.png')), 'ball-kinds.png written');

  ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  console.log('\n  per-view numbers: ' + JSON.stringify(perView.map(p => ({ view: NAMES[p.v], ballPx: r1(p.ballPx), localGap: r1(p.localGap), pairs: p.pairs, dist: r1(p.dist), seamL: r1(p.seamL), feltL: r1(p.feltL), n: p.n }))));
} catch (e) {
  fail++; console.error('  FAIL probe threw: ' + (e && e.stack || e));
  if (errors.length) console.error('  page errors: ' + errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
  if (server) server.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
