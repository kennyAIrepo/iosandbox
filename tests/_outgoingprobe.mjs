/**
 * _outgoingprobe.mjs — headless probe for T8 (OutgoingSink crop popup, C1 via OBS). BUILD-PLAN T8 acceptance:
 *   page A  teamslab.html?auto=1&consent=1&fixedstep=1&outgoing=1 (+ room/nosfx/agent=local for isolation)
 *   (1) the sink canvas is 1280x720; stream.getVideoTracks()[0].readyState === 'live'
 *   (2) stats.fps >= 20 over 3 s (frames counted through the stage.render wrapper)
 *   (3) the centre pixel is non-black
 *   (4) the video is drawn UN-mirrored: sink pixels match the raw <video> frame at the same x (not at w-1-x)
 *   (5) a magenta marker at world +x (right of the local tile in the surface) appears on the LEFT of the sink canvas
 *   (6) stage.contexts() is unchanged by disabling / enabling the sink (2D canvas only)
 *   page B  teamslab.html?outgoing=1&sinkview=1 (the popup viewer): the twin never boots (no window.__twin, no .tw-frame,
 *           no consent dialog), frames arrive on BroadcastChannel 'hopeos-outgoing', the canvas is 1280x720 and its centre
 *           pixel is non-black — while page A is the foreground tab (a popup behind the meeting is a background tab)
 *   (0) ?outgoing=1 is popup mode: with --disable-popup-blocking the page opens the viewer at boot (it paints; closed again)
 *   (7) openWindow() targets ?outgoing=1&sinkview=1 (opened with --disable-popup-blocking; the window paints too)
 *   (8) no console errors on either page beyond the filter; screenshots + the sink canvas PNG in SHOT_DIR
 * Run from the repo root: node tests/_outgoingprobe.mjs   (reuses :3333 when it serves teamslab.html, else spawns tools/dev-server.mjs)
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1280,800', '--disable-popup-blocking'];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh|Autoplay|GPU stall|WebGL warning|TensorFlow|INFO: Created TensorFlow|GL_INVALID|OpenGL ES|Overriding|deprecated/i;
const QUERY = process.env.TWIN_QUERY || 'auto=1&consent=1&fixedstep=1&outgoing=1&transport=loopback&room=t8&agent=local&nosfx=1';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? '  ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => (typeof v === 'number' ? +v.toFixed(1) : v);

// ── server ────────────────────────────────────────────────────────────────────
async function serves(port) { try { const r = await fetch(`http://localhost:${port}/teamslab.html`); return r.ok && (await r.text()).includes('tw-frame tw-meeting'); } catch { return false; } }
function busy(port) { return new Promise(res => { const s = net.createServer(); s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false))); s.listen(port, '127.0.0.1'); }); }
let PORT = +(process.env.HOPEOS_PORT || 3333), server = null;
if (!(await serves(PORT))) {
  while (await busy(PORT)) PORT++;
  server = spawn(process.execPath, [path.join(REPO, 'tools/dev-server.mjs'), String(PORT)], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await serves(PORT)); i++) await sleep(100);
  console.log(`  (spawned dev server on :${PORT})`);
} else console.log(`  (reusing dev server on :${PORT})`);
const URL_A = `http://localhost:${PORT}/teamslab.html?${QUERY}`;
const URL_B = `http://localhost:${PORT}/teamslab.html?outgoing=1&sinkview=1`;

// interval polling: rAF polling never fires in a background tab
const waitFor = (page, fn, timeout = 30000) => page.waitForFunction(fn, { polling: 100, timeout });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const logs = [], logsB = [];
let exitCode = 1;
const wire = (page, sink) => {
  page.on('console', m => { const t = m.type(), text = m.text(); if (text.startsWith('AUTOTEST ')) return; if ((t === 'error' || t === 'warning') && !FILTER.test(text)) sink.push(`[${t}] ${text.slice(0, 300)}`); });
  page.on('pageerror', e => sink.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => { if (!FILTER.test(r.url())) sink.push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`); });
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  wire(page, logs);

  console.log(`\n[boot] ${URL_A}`);
  await page.goto(URL_A, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(page, () => window.__twin && window.__twin.ready === true, 120000);
  await waitFor(page, () => window.__twin.outgoing && window.__twin.outgoing.enabled && window.__twin.frames > 30, 30000);
  const boot = await page.evaluate(() => ({ error: __twin.S.boot.error, stage: __twin.S.boot.stage, me: __twin.S.me.clientId, contexts: __twin.stage.contexts() }));
  ok(!boot.error && boot.stage === 'loop', `booted: stage=${boot.stage} error=${boot.error} me=${boot.me} contexts=${boot.contexts}`);

  // ── (0) popup mode: ?outgoing=1 opened the viewer at boot ───────────────
  console.log('\n[0] popup mode (?outgoing=1 opens the viewer at boot)');
  let auto = null;
  try { auto = await browser.waitForTarget(t => t.url().includes('sinkview=1'), { timeout: 5000 }); } catch { auto = null; }
  const autoOpen = await page.evaluate(() => ({ open: __twin.outgoing.open, enabled: __twin.outgoing.enabled }));
  ok(auto && autoOpen.open && autoOpen.enabled, `boot popup: target ${auto ? auto.url() : 'none'}, outgoing.open=${autoOpen.open}, enabled=${autoOpen.enabled}`);
  if (auto) {
    const ap = await auto.page();
    if (ap) {
      await page.bringToFront();
      try { await waitFor(ap, () => window.__sinkview && window.__sinkview.stats && window.__sinkview.stats.frames >= 3, 10000); } catch { /* reported below */ }
      const as = await ap.evaluate(() => ({ frames: window.__sinkview && window.__sinkview.stats ? window.__sinkview.stats.frames : -1, twin: typeof window.__twin }));
      ok(as.frames >= 3 && as.twin === 'undefined', `boot popup painted ${as.frames} frames (no twin boot: __twin ${as.twin})`);
      await ap.close().catch(() => {});
      await sleep(300);
    }
  }
  const afterAuto = await page.evaluate(() => ({ open: __twin.outgoing.open, viewers: __twin.outgoing.stats.viewers }));
  ok(!afterAuto.open, `open=${afterAuto.open} after closing the boot popup (viewers ${afterAuto.viewers})`);

  // ── (1) canvas + stream ──────────────────────────────────────────────────
  console.log('\n[1] sink canvas + captureStream');
  const s1 = await page.evaluate(() => {
    const o = __twin.outgoing, c = o.canvas, st = o.stream, tr = st && st.getVideoTracks()[0];
    return { w: c.width, h: c.height, tracks: st ? st.getVideoTracks().length : 0, state: tr ? tr.readyState : null, settings: tr && tr.getSettings ? tr.getSettings() : null, stats: { ...o.stats }, url: o.viewerUrl };
  });
  ok(s1.w === 1280 && s1.h === 720, `sink canvas ${s1.w}x${s1.h}`);
  ok(s1.tracks === 1 && s1.state === 'live', `stream: ${s1.tracks} video track, readyState '${s1.state}'`, s1.settings ? `settings ${s1.settings.width || '?'}x${s1.settings.height || '?'}@${s1.settings.frameRate || '?'}` : '');
  ok(s1.stats.videoOk && s1.stats.overlayOk, `draw sources: video ${s1.stats.videoOk}, surface crop ${s1.stats.overlayOk}`, `drawMs ${r1(s1.stats.drawMs)}`);
  ok(/outgoing=1&sinkview=1$/.test(s1.url), `viewerUrl = ${s1.url}`);

  // ── (2) fps over 3 s ─────────────────────────────────────────────────────
  console.log('\n[2] fps over 3 s');
  const f0 = await page.evaluate(() => ({ frames: __twin.outgoing.stats.frames, t: performance.now() }));
  await sleep(3000);
  const f1 = await page.evaluate(() => ({ frames: __twin.outgoing.stats.frames, t: performance.now(), fps: __twin.outgoing.stats.fps, pageFps: __twin.S.fps, drawMs: __twin.outgoing.stats.drawMs }));
  const fps = (f1.frames - f0.frames) * 1000 / (f1.t - f0.t);
  ok(fps >= 20, `sink fps ${r1(fps)} over ${r1((f1.t - f0.t) / 1000)} s (stats.fps ${r1(f1.fps)}, page fps ${r1(f1.pageFps)}, drawMs ${r1(f1.drawMs)}) >= 20`);

  // ── (3) centre pixel + (4) un-mirrored video ────────────────────────────
  console.log('\n[3] centre pixel, [4] un-mirrored video');
  const px = await page.evaluate(() => {
    const tw = __twin, o = tw.outgoing; tw.pause(true); tw.step(1 / 60);      // one frame, then read everything in this task
    const c = o.canvas, ctx = c.getContext('2d'), w = c.width, h = c.height;
    const centre = Array.from(ctx.getImageData(w >> 1, h >> 1, 1, 1).data);
    // the raw camera frame, cover-fitted the way the sink does it (drawImage never sees the tile's CSS mirror)
    const v = tw.tiles.get(tw.S.me.clientId).video, vw = v.videoWidth, vh = v.videoHeight;
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h; const t2 = tmp.getContext('2d');
    const s = Math.max(w / vw, h / vh), sw = w / s, sh = h / s; t2.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
    const A = ctx.getImageData(0, 0, w, h).data, B = t2.getImageData(0, 0, w, h).data;
    let same = 0, flipped = 0, n = 0, varSum = 0;
    const close = (i, j) => Math.abs(A[i] - B[j]) <= 10 && Math.abs(A[i + 1] - B[j + 1]) <= 10 && Math.abs(A[i + 2] - B[j + 2]) <= 10;
    for (const y of [24, 48, 72, 96]) for (let x = 40; x < w - 40; x += 20) {
      const i = (y * w + x) * 4, j = (y * w + (w - 1 - x)) * 4; n++;
      if (close(i, i)) same++; if (close(i, j)) flipped++;
      varSum += Math.abs(B[i] - B[j]) + Math.abs(B[i + 1] - B[j + 1]) + Math.abs(B[i + 2] - B[j + 2]);
    }
    tw.pause(false);
    return { centre, same, flipped, n, video: [vw, vh], asym: varSum / n, readyState: v.readyState };
  });
  ok(px.centre[0] + px.centre[1] + px.centre[2] > 30, `centre pixel rgb(${px.centre.slice(0, 3).join(',')}) non-black`);
  ok(px.same > px.flipped && px.same >= 0.7 * px.n, `video un-mirrored: ${px.same}/${px.n} samples match the raw frame at the same x, ${px.flipped} at the mirrored x`, `video ${px.video.join('x')} readyState ${px.readyState}, frame asymmetry ${r1(px.asym)}`);

  // ── (5) marker at world +x → LEFT of the sink ──────────────────────────
  console.log('\n[5] world +x marker lands on the LEFT of the sink (and on the right of the tile in the surface)');
  const mk = await page.evaluate(() => {
    const tw = __twin, THREE = tw.THREE, o = tw.outgoing, me = tw.tiles.get(tw.S.me.clientId), stage = tw.stage;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 16), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
    mesh.position.set(me.cam.position.x + 0.8, me.cam.position.y, -2.0);   // hand plane z = -D, 0.8 m to the RIGHT of the tile centre
    stage.scene.add(mesh);
    tw.pause(true); tw.step(1 / 60);
    // the surface, my tile's rect only (same task as the render: the back buffer is still there)
    const surf = stage.renderer.domElement, dpr = stage.renderer.getPixelRatio(), r = me.rect;
    const sc = document.createElement('canvas'); sc.width = Math.round(r.width); sc.height = Math.round(r.height);
    const sctx = sc.getContext('2d'); sctx.drawImage(surf, r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr, 0, 0, sc.width, sc.height);
    const S = sctx.getImageData(0, 0, sc.width, sc.height).data;
    const c = o.canvas, ctx = c.getContext('2d'), K = ctx.getImageData(0, 0, c.width, c.height).data;
    const halves = (data, w, h) => { let left = 0, right = 0; for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const i = (y * w + x) * 4; if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] > 180) { if (x < w / 2) left++; else right++; } } return { left, right }; };
    const surface = halves(S, sc.width, sc.height), sink = halves(K, c.width, c.height);
    const png = c.toDataURL('image/png');
    stage.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose();
    tw.step(1 / 60); tw.pause(false);
    return { surface, sink, tile: [r.left, r.top, r.width, r.height], dpr, png };
  });
  fs.writeFileSync(path.join(SHOT_DIR, 't8-sink-marker.png'), Buffer.from(mk.png.split(',')[1], 'base64'));
  ok(mk.surface.right > 20 && mk.surface.left === 0, `surface (tile ${mk.tile.map(Math.round).join(',')} @dpr ${mk.dpr}): magenta right ${mk.surface.right}, left ${mk.surface.left}`);
  ok(mk.sink.left > 20 && mk.sink.right === 0, `sink: magenta LEFT ${mk.sink.left}, right ${mk.sink.right} (overlay flipped to the un-mirrored video)`);

  // ── (6) contexts unchanged ───────────────────────────────────────────────
  console.log('\n[6] stage.contexts() unchanged by the sink');
  const cx = await page.evaluate(() => {
    const tw = __twin, o = tw.outgoing; const c0 = tw.stage.contexts(); o.disable(); const c1 = tw.stage.contexts(); const off = o.enabled; o.enable(); const c2 = tw.stage.contexts();
    const land = [...tw.tiles.values()].filter(t => t.pipe && t.pipe.ready).length;
    return { c0, c1, c2, off, on: o.enabled, land };
  });
  ok(cx.c0 === cx.c1 && cx.c1 === cx.c2 && cx.c0 === 1 + cx.land, `contexts ${cx.c0} → disable ${cx.c1} (enabled=${cx.off}) → enable ${cx.c2} (enabled=${cx.on}); renderer + ${cx.land} landmarker(s)`);
  await waitFor(page, () => window.__twin.outgoing.stats && window.__twin.outgoing.stats.frames > 10, 10000);
  await page.screenshot({ path: path.join(SHOT_DIR, 't8-page-a.png') });

  // ── page B: the popup viewer ─────────────────────────────────────────────
  console.log(`\n[B] viewer ${URL_B}`);
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  wire(pageB, logsB);
  await pageB.goto(URL_B, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(pageB, () => window.__sinkview && (window.__sinkview.ready || window.__sinkview.error), 20000);
  await page.bringToFront();                                            // the meeting page runs in front; the viewer paints in the background
  const t0 = Date.now(); let vb = null;
  while (Date.now() - t0 < 10000) {
    vb = await pageB.evaluate(() => { const s = window.__sinkview; return { ready: s.ready, error: s.error, stats: s.stats ? { ...s.stats } : null }; });
    if (vb.stats && vb.stats.frames >= 5) break;
    await sleep(200);
  }
  const vbx = await pageB.evaluate(() => {
    const c = document.getElementById('sinkview'), ctx = c.getContext('2d'), centre = Array.from(ctx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data);
    return { w: c.width, h: c.height, centre, twin: typeof window.__twin, frame: !!document.querySelector('.tw-frame'), consent: !!document.querySelector('#consent'), scripts: document.scripts.length, title: document.title, ready: document.readyState, note: document.getElementById('sinkview-note').hidden };
  });
  ok(vb && vb.ready && !vb.error, `viewer ready (error=${vb && vb.error})`, `mode ${vb && vb.stats && vb.stats.mode}, readyState ${vbx.ready}`);
  ok(vbx.twin === 'undefined' && !vbx.frame && !vbx.consent, `the twin never booted in the viewer: __twin ${vbx.twin}, .tw-frame ${vbx.frame}, #consent ${vbx.consent}, scripts ${vbx.scripts}`);
  ok(vb.stats && vb.stats.frames >= 5 && vb.stats.connected, `viewer received ${vb.stats && vb.stats.frames} frames (${r1(vb.stats && vb.stats.fps)} fps, connected ${vb.stats && vb.stats.connected})`);
  ok(vbx.w === 1280 && vbx.h === 720, `viewer canvas ${vbx.w}x${vbx.h}`);
  ok(vbx.centre[0] + vbx.centre[1] + vbx.centre[2] > 30, `viewer centre pixel rgb(${vbx.centre.slice(0, 3).join(',')}) non-black`, `note hidden ${vbx.note}`);
  const sv = await page.evaluate(() => ({ viewers: __twin.outgoing.stats.viewers, sent: __twin.outgoing.stats.sent }));
  ok(sv.viewers >= 1 && sv.sent >= 5, `sink sees ${sv.viewers} viewer(s), sent ${sv.sent} frames`);
  await pageB.bringToFront(); await sleep(300);
  await pageB.screenshot({ path: path.join(SHOT_DIR, 't8-page-b.png') });
  await page.bringToFront();

  // ── (7) openWindow() ─────────────────────────────────────────────────────
  console.log('\n[7] openWindow()');
  const before = new Set((await browser.targets()).map(t => t._targetId || t.url()));
  const opened = await page.evaluate(() => { const w = __twin.outgoing.openWindow(); return { got: !!w, open: __twin.outgoing.open }; });
  let popup = null;
  try { popup = await browser.waitForTarget(t => t.url().includes('sinkview=1') && !before.has(t._targetId || t.url()), { timeout: 5000 }); } catch { popup = null; }
  ok(opened.got && popup, `openWindow() → ${opened.got ? 'Window' : 'null (blocked)'}, open=${opened.open}, target ${popup ? popup.url() : 'none'}`);
  if (popup) {
    const pp = await popup.page();
    if (pp) {
      try { await waitFor(pp, () => window.__sinkview && window.__sinkview.stats && window.__sinkview.stats.frames >= 3, 10000); } catch { /* reported below */ }
      const ps = await pp.evaluate(() => ({ frames: window.__sinkview && window.__sinkview.stats ? window.__sinkview.stats.frames : -1, twin: typeof window.__twin }));
      ok(ps.frames >= 3 && ps.twin === 'undefined', `popup painted ${ps.frames} frames (no twin boot: __twin ${ps.twin})`);
      await pp.close().catch(() => {});
    }
  }
  await sleep(300);
  const after = await page.evaluate(() => ({ open: __twin.outgoing.open }));
  ok(!after.open, `open=${after.open} after the popup closed`);

  // ── (8) console ──────────────────────────────────────────────────────────
  console.log('\n[8] console');
  ok(logs.length === 0, `page A console clean (${logs.length})`, logs.slice(0, 5).join(' | '));
  ok(logsB.length === 0, `page B console clean (${logsB.length})`, logsB.slice(0, 5).join(' | '));
  await pageB.close().catch(() => {});
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('  PROBE ERROR', e && e.stack || e); fail++;
} finally {
  console.log(`\n${pass} passed, ${fail} failed   (shots: ${SHOT_DIR})`);
  await browser.close().catch(() => {});
  if (server) server.kill();
}
process.exit(exitCode);
