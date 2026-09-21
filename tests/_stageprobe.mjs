/**
 * _stageprobe.mjs — headless probe for T2 (stage renderer, court space, remote tiles, hand sources).
 * Page: tests/_stageprobe.html?tiles=9 (no landmarkers; Chrome's fake camera is not even opened).
 *   node tests/_stageprobe.mjs            (starts tools/dev-server.mjs on :3333 itself when nothing answers there)
 * Checks (BUILD-PLAN T2 acceptance):
 *   1. stage.contexts() === 1
 *   2. [M2] a matcap ball at every gutter mid-point renders the same projected radius (±0.5 px) on both sides — read via
 *      stagePxFromWorld + a 1-px column (row) scan 2 px into each half, against sqrt((R·th)² - 2²)
 *   3. assignLayer puts rig.mesh AND rig.occluder of tile i on layer 1+i (traverse), and only camera i sees that layer
 *   4. a RemoteTile fed a `cup` pack through packToHands → encodeHandStream → RemoteHands.read poses a rig
 *      (rigR.mesh.visible === true; the MEASURED chirality's grp visible; packs.hands.length === 1) with its own views
 *   5. WEBGL_lose_context.loseContext() → onContextLost fired, renderer rebuilt, render calls > 0 afterwards
 *   6. ClipSource (tiny generated webm, mp4 fixture fallback) reaches readyState >= 2
 *   7. KeyboardSource writes S.ovPacks[id].R as a `flat` pack, `cup` while Space is down, `open` for one frame on release,
 *      arrows move it at 0.6 m/s inside the tile's world rect
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const PORT = +(process.env.PORT || 3333);
const URL_ = `http://localhost:${PORT}/tests/_stageprobe.html?tiles=${process.env.TILES || 9}`;

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? ' ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── dev server (reuse a running one) ────────────────────────────────────────
let server = null;
async function alive() { try { const r = await fetch(`http://localhost:${PORT}/tests/_stageprobe.html`); return r.ok; } catch { return false; } }
if (!(await alive())) {
  server = spawn(process.execPath, ['tools/dev-server.mjs', String(PORT)], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await alive()); i++) await sleep(100);
  console.log(`(started tools/dev-server.mjs on :${PORT})`);
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1100,800'],
});
const logs = [];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh/;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 });
  page.on('console', m => { const t = m.type(); if ((t === 'error' || t === 'warning') && !FILTER.test(m.text())) logs.push(`[${t}] ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => { if (!FILTER.test(r.url())) logs.push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`); });

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__twin && window.__twin.ready && window.__twin.frames > 5, { timeout: 30000 });
  await sleep(300);

  console.log('\n[1] surface + layout');
  const basics = await page.evaluate(() => ({
    contexts: __twin.stage.contexts(), N: __twin.N, cols: __twin.cols, rows: __twin.rows, tw: __twin.tw, th: __twin.th,
    calls: __twin.stage.info().calls, tris: __twin.stage.info().triangles, frames: __twin.frames, renderErrors: __twin.renderErrors,
    canvas: [__twin.stage.canvas.width, __twin.stage.canvas.height], surfaceInDom: __twin.surfaceInDom(),
    court: __twin.courtInfo(),
    camsDistinct: new Set(__twin.tiles.map(t => t.cam.position.x + ',' + t.cam.position.y)).size,
    viewOffset: __twin.tiles.map(t => t.cam.view && [t.cam.view.fullWidth, t.cam.view.fullHeight, t.cam.view.offsetX, t.cam.view.offsetY, t.cam.view.width, t.cam.view.height]),
    uvNoOffset: __twin.tiles.every(t => t.uvCam.view === null && t.uvCam.fov === 50 && Math.abs(t.uvCam.aspect - __twin.tw / __twin.th) < 1e-12),
    vp: __twin.tiles.map(t => [t.vp.x, t.vp.y, t.vp.w, t.vp.h]),
  }));
  ok(basics.contexts === 1, `stage.contexts() === 1 (got ${basics.contexts}); ${basics.N} tiles ${basics.cols}x${basics.rows} ${basics.tw}x${basics.th}`);
  ok(basics.calls > 0 && basics.renderErrors === 0, `render calls ${basics.calls}, triangles ${basics.tris}, frames ${basics.frames}, render errors ${basics.renderErrors}`);
  ok(basics.canvas[0] === 994 && basics.canvas[1] === 678 && basics.surfaceInDom, `surface canvas ${basics.canvas.join('x')} over the stage`);
  ok(basics.camsDistinct === basics.N, `${basics.camsDistinct} distinct camera positions (one per tile centre)`);
  ok(basics.viewOffset.every(v => v && v[0] === basics.tw && v[1] === basics.th && v[2] === -4 && v[3] === -4 && v[4] === basics.tw + 8 && v[5] === basics.th + 8), 'setViewOffset(tw, th, -gap/2, -gap/2, tw+gap, th+gap) on every tile camera');
  ok(basics.uvNoOffset, 'uvCam: FOV 50, aspect tw/th, no view offset');
  const vpTile = basics.vp.every(v => v[2] === basics.tw + 8 && v[3] === basics.th + 8);
  ok(vpTile, `viewports = tile + gap (${basics.vp[0].join(',')} …)`);
  await page.screenshot({ path: `${SHOT_DIR}/stage-0-layout.png` });

  console.log('\n[2] [M2] gutter radius: same projected radius on both sides of every gutter');
  const gm = await page.evaluate(() => __twin.measureGutters());
  const worstDiff = Math.max(...gm.gutters.map(g => g.diff)), worstErr = Math.max(...gm.gutters.map(g => Math.max(g.errA, g.errB)));
  for (const g of gm.gutters) console.log(`     gutter ${g.kind} ${g.a}->${g.b} @(${g.px},${g.py}) halfA ${g.halfA.toFixed(2)} halfB ${g.halfB.toFixed(2)} expect ${g.expect.toFixed(2)}`);
  ok(gm.gutters.length >= 6, `${gm.gutters.length} gutters measured (R·th = ${gm.Rpx.toFixed(2)} px, chord half at 2 px = ${gm.expect.toFixed(2)})`);
  ok(gm.gutters.every(g => g.halfA > 0 && g.halfB > 0), 'the ball is painted on both sides of every gutter (two viewports, two cameras)');
  ok(worstDiff <= 0.5, `both halves agree within 0.5 px (worst ${worstDiff.toFixed(3)})`);
  ok(worstErr <= 1.0, `chord vs sqrt((R·th)² - 4) within 1 px (worst ${worstErr.toFixed(3)}; antialiased edge)`);
  await page.evaluate(() => { const g = __twin.court.rects[0]; __twin.placeBallCourt(g.x0 + g.w + __twin.court.map.gutter / 2, g.y0 + 0.5); });
  await sleep(120);
  await page.screenshot({ path: `${SHOT_DIR}/stage-1-gutter.png` });

  console.log('\n[3] layers');
  const lr = await page.evaluate(() => __twin.layerReport());
  ok(lr.every(r => r.okAll && r.meshes === 4 && r.hasOccluder && r.hasMain), `every tile: 4 rig meshes (2 ghost + 2 occluder) on layer 1+i (masks ${lr.map(r => r.want).join(',')})`);
  ok(lr.every(r => r.cameraSees && !r.otherCamSees), 'camera i sees layer 1+i, no other camera does');

  console.log('\n[4] remote tile: cup pack through the wire');
  const sent = await page.evaluate(() => __twin.sendCup(1));
  ok(sent.accepted && sent.bytes === 264 && sent.decodedSeat === 1, `HAND_STREAM ${sent.bytes} B accepted for seat 1`);
  await page.evaluate(() => __twin.sleepFrames(3));
  const rr = await page.evaluate(() => __twin.remoteReport(1));
  const rr0 = await page.evaluate(() => __twin.remoteReport(0));
  ok(rr.handsLen === 1 && rr.slot === 'right', `packs.hands.length === 1 (slot ${rr.slot}, measured mesh key ${rr.key})`);
  ok(rr.rigRMeshVisible === true && rr.posedGrpVisible === true, `rigR.mesh.visible === ${rr.rigRMeshVisible}; the measured rig (${rr.key}) grp.visible === ${rr.posedGrpVisible}`);
  ok(rr.viewsDistinct, 'tile 1 views !== every other tile\'s views (chirality measured per tile)');
  const wErr = rr.wrist ? Math.hypot(rr.wrist[0] - sent.pack[0].x, rr.wrist[1] - sent.pack[0].y, rr.wrist[2] - sent.pack[0].z) : Infinity;
  ok(wErr < 2e-3, `received world wrist within 2 mm of the sent pack (${(wErr * 1e3).toFixed(2)} mm, wire i16 + img f32)`);
  ok(rr.ageMs !== null && rr.ageMs < 200 && rr.alpha === 1, `ageMs ${rr.ageMs} < 200, alpha ${rr.alpha}`);
  ok(rr.handR.present === true && rr.handL.present === false, 'HandBody right present, left absent');
  ok(rr0.handsLen === 0 && rr0.posedGrpVisible === false, 'tile 0 (nothing received) has no hands and no posed rig');
  await page.screenshot({ path: `${SHOT_DIR}/stage-2-remote-cup.png` });
  // stale cue: stop sending, age grows → alpha drops toward 0.5 (handAgeAlpha), then drop after the slot rule
  await sleep(450);
  const stale = await page.evaluate(() => __twin.remoteReport(1));
  ok(stale.ageMs > 400 && stale.alpha <= 0.5 + 1e-9 && stale.alpha >= 0.5, `after ${stale.ageMs} ms silence alpha = ${stale.alpha} (stale cue), rig uAlpha scaled to ${stale.rigAlphaUniform?.toFixed(3)}`);

  console.log('\n[5] context loss → rebuild');
  const before = await page.evaluate(() => ({ rebuilds: __twin.stage.rebuilds, cb: __twin.lostCbCalls }));
  const lost = await page.evaluate(() => __twin.loseContext());
  ok(lost, 'WEBGL_lose_context.loseContext() issued');
  await page.waitForFunction(() => __twin.stage.rebuilds >= 1, { timeout: 5000 }).catch(() => {});
  await sleep(300);
  const after = await page.evaluate(() => ({ rebuilds: __twin.stage.rebuilds, cb: __twin.lostCbCalls, calls: __twin.stage.info().calls, contexts: __twin.stage.contexts(), inDom: __twin.surfaceInDom(), errors: __twin.renderErrors, frames: __twin.frames }));
  ok(after.cb === before.cb + 1 && after.rebuilds === before.rebuilds + 1, `onContextLost fired (${after.cb}) and the renderer was rebuilt (${after.rebuilds})`);
  ok(after.calls > 0 && after.inDom && after.contexts === 1, `render calls after rebuild ${after.calls}, surface back in the DOM, contexts ${after.contexts}`);
  await page.evaluate(() => __twin.sendNone(1));                       // hide tile 1's posed rig so only the ball is on the scan lines
  await page.evaluate(() => __twin.sleepFrames(2));
  const gm2 = await page.evaluate(() => __twin.measureGutters());
  const gm2ok = gm2.gutters.every(g => g.halfA > 0 && g.halfB > 0 && g.diff <= 0.5);
  if (!gm2ok) for (const g of gm2.gutters) console.log(`     gutter ${g.kind} ${g.a}->${g.b} @(${g.px},${g.py}) halfA ${g.halfA.toFixed(2)} halfB ${g.halfB.toFixed(2)}`);
  ok(gm2ok, 'the rebuilt renderer paints the same gutter discs');
  await page.screenshot({ path: `${SHOT_DIR}/stage-3-after-loss.png` });

  console.log('\n[6] ClipSource');
  const clip = await page.evaluate(() => __twin.startClip('webm'));
  ok(clip.readyState >= 2, `ClipSource(${clip.kind}) video.readyState = ${clip.readyState} (>= 2) after ${clip.ms} ms, kind '${clip.kindField}', stream track ${clip.hasStream}, ${clip.w}x${clip.h}`);
  ok(clip.isClip && clip.kindField === 'clip', 'makeHandSource("clip") → ClipSource');

  console.log('\n[7] KeyboardSource');
  await page.evaluate(() => { __twin.kb.toggle(true); });
  await page.evaluate(() => __twin.sleepFrames(2));
  const k0 = await page.evaluate(() => __twin.kbReport());
  ok(k0.active && k0.hasOv && k0.L === null && k0.hasR && k0.len === 21, `S.ovPacks.me = {L:null, R:pack21} (active ${k0.active})`);
  ok(k0.isFlat && k0.shape === 'flat' && k0.z === -2, `pack is PackGen.flat at (${k0.x.toFixed(3)}, ${k0.y.toFixed(3)}, ${k0.z}) — the hand plane`);
  ok(k0.x > k0.rect.x0 && k0.x < k0.rect.x1 && k0.y > k0.rect.y0 && k0.y < k0.rect.y1, 'inside tile 0\'s world rect');
  await page.keyboard.down('Space');
  await page.evaluate(() => __twin.sleepFrames(2));
  const k1 = await page.evaluate(() => __twin.kbReport());
  ok(k1.closed && k1.isCup && k1.shape === 'cup', 'Space down → PackGen.cup (wrap pickup shape)');
  await page.keyboard.up('Space');
  // the very next tick emits `open` for one frame (release), then flat
  const seen = await page.evaluate(async () => {
    const shapes = [];
    for (let i = 0; i < 4; i++) { await __twin.sleepFrames(1); shapes.push(__twin.kb.shape); }
    return shapes;
  });
  ok(seen[0] === 'open' && seen.slice(1).every(s => s === 'flat'), `Space up → ${seen.join(' → ')}`);
  const x0 = k1.x;
  await page.keyboard.down('ArrowRight');
  await sleep(500);
  await page.keyboard.up('ArrowRight');
  const k2 = await page.evaluate(() => __twin.kbReport());
  ok(k2.x - x0 > 0.15 && k2.x - x0 < 0.45, `ArrowRight 0.5 s moved +x by ${(k2.x - x0).toFixed(3)} m (0.6 m/s)`);
  await page.keyboard.down('ArrowDown');
  await sleep(2500);
  await page.keyboard.up('ArrowDown');
  const k3 = await page.evaluate(() => __twin.kbReport());
  ok(k3.y >= k3.rect.y0 && k3.y <= k3.rect.y0 + 0.06, `clamped at the tile bottom (y ${k3.y.toFixed(3)} vs floor ${k3.rect.y0.toFixed(3)})`);
  await page.evaluate(() => { __twin.kb.toggle(false); });
  await page.evaluate(() => __twin.sleepFrames(2));
  const k4 = await page.evaluate(() => __twin.kbReport());
  ok(!k4.active && !k4.hasOv, 'toggle(false) removes the ovPacks entry');
  await page.screenshot({ path: `${SHOT_DIR}/stage-4-final.png` });

  console.log('\n─ console problems ─');
  logs.slice(0, 30).forEach(l => console.log('  ' + l));
  if (!logs.length) console.log('  (none)');
  ok(logs.filter(l => /PAGEERROR|\[error\]/.test(l)).length === 0, 'no page errors / console errors beyond the filter');
} catch (e) {
  fail++; console.error('  FAIL probe threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  if (server) server.kill();
}
console.log(`\n=== ${pass} passed, ${fail} failed === (shots in ${SHOT_DIR})`);
process.exit(fail ? 1 : 0);
