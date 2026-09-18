// verify the REAL "🎭 mirror me" chip path: with the tracking SDK off, the chip
// boots the lab's camera + trackers (fake device), switches the face lane to
// FULL, marks the fox live (PiP up, camera framed on its face) and the chip
// again releases it with the SDK still live. Models come from the CDN — allow
// ~2 min. Dev server on :3333.
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await sleep(500);
await page.click('#engSpawnRow [data-sp="fox"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'fox'), { timeout: 90000 });
await sleep(400);
await page.evaluate(() => [...document.querySelectorAll('#engAvCtl .opt')].find(b => b.textContent.includes('mirror me')).click());
await page.waitForFunction(() => document.body.classList.contains('eng-fox') && window.__eng.sdk.on, { timeout: 150000 });
await sleep(2500);
const on = await page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox');
  const rec = window.__eng.foxes.get(g.userData.eng.id);
  const cam = window.__eng.camera.position, tgt = window.__eng.orbit.target;
  return { sdkOn: window.__eng.sdk.on, face: window.__eng.sdk.face, faceSel: document.querySelector('#engFaceRow .opt.sel')?.dataset.face,
           live: rec.live, seen: rec.driver.seen, chip: [...document.querySelectorAll('#engAvCtl .opt')].find(b => /mirror/.test(b.textContent))?.textContent,
           pip: getComputedStyle(document.getElementById('engCamPip')).display, pipLive: !!document.getElementById('engCamPip').srcObject,
           framed: cam.distanceTo(tgt) < 3 && Math.abs(tgt.y - (g.position.y + rec.headY * g.scale.x)) < 0.05,
           row: [...document.querySelectorAll('.engRow')].some(r => r.textContent.includes('🎭')) };
});
await page.screenshot({ path: path.join(SP, 'fox-sdk-live.png') });
// a face OBJECT through the live path (outline + puppet) — the shape the tracker
// really emits; this is what crashed the loop once the face lane was on
await page.waitForFunction(() => window.__lab.faceReady, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => {
  const lm = new Array(478).fill(0).map((_, i) => ({ x: 0.5 + Math.sin(i) * 0.1, y: 0.5 + Math.cos(i) * 0.1, z: -0.02, visibility: 0 }));
  window.__lab.AVSYNC.ovFace = { landmarks: lm, blendshapes: [{ categoryName: 'jawOpen', score: 0.2 }], matrix: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,-0.5,1]) };
});
await sleep(1500);
const fed = await page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); const r = window.__eng.foxes.get(g.userData.eng.id); const s = { seen: r.driver.seen, faceReady: window.__lab.faceReady }; window.__lab.AVSYNC.ovFace = undefined; return s; });
on.fed = fed;
await page.evaluate(() => [...document.querySelectorAll('#engAvCtl .opt')].find(b => b.textContent.includes('mirroring you')).click());
await sleep(600);
const off = await page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox');
  return { sdkOn: window.__eng.sdk.on, live: window.__eng.foxes.get(g.userData.eng.id).live, pip: getComputedStyle(document.getElementById('engCamPip')).display, cls: document.body.classList.contains('eng-fox') };
});
console.log(JSON.stringify({ on, off }, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const ok = on.sdkOn && on.face === 'full' && on.faceSel === 'full' && on.live && /mirroring you/.test(on.chip) && on.pip === 'block' && on.pipLive && on.framed && on.row
  && on.fed.seen && on.fed.faceReady
  && off.sdkOn && !off.live && off.pip === 'none' && !off.cls && errors.length === 0;
console.log(ok ? 'FOX SDK PROBE OK' : 'FOX SDK PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
