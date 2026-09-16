// verify the REAL "🐲 become dragon" chip path: with the tracking SDK off, the
// chip boots the lab's camera + trackers (fake device), lands on the full-3D
// body suite, embodies the dragon (HUD up, overlays hidden, dolly on), and the
// chip again releases everything with the SDK still live. Models come from the
// CDN — allow ~2 min. Dev server on :3333.
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
await page.click('#engSpawnRow [data-sp="dragon"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'dragon'), { timeout: 90000 });
await sleep(400);

// the real chip
await page.evaluate(() => [...document.querySelectorAll('#engAvCtl .opt')].find(b => b.textContent.includes('become dragon')).click());
await page.waitForFunction(() => document.body.classList.contains('eng-dragon') && window.__eng.sdk.on, { timeout: 150000 });
await sleep(1500);
const on = await page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = window.__eng.dragons.get(g.userData.eng.id);
  return {
    sdkOn: window.__eng.sdk.on, part: window.__eng.sdk.part, view: window.__eng.sdk.view,
    suite: document.querySelector('#engBodySuite .opt.sel')?.dataset.bs,
    sdkChk: document.getElementById('engSdkChk').checked,
    embodied: !!rec.user, dolly: rec.dolly, orbit: window.__eng.orbit.enabled,
    hud: getComputedStyle(document.getElementById('engFlapHud')).display,
    overlayHidden: getComputedStyle(document.getElementById('ov')).display === 'none' && getComputedStyle(document.getElementById('c')).display === 'none',
    hudBig: document.getElementById('engFlapBig').textContent,
    chip: [...document.querySelectorAll('#engAvCtl .opt')].find(b => /dragon/.test(b.textContent))?.textContent,
    pip: (() => { const p = document.getElementById('engCamPip'); const cs = getComputedStyle(p);
      return { shown: cs.display, live: !!p.srcObject && p.srcObject === document.getElementById('vid').srcObject, playing: !p.paused && p.readyState >= 2,
               rect: (r => [r.left, r.top, r.right, r.bottom].map(Math.round))(p.getBoundingClientRect()), win: [innerWidth, innerHeight], bottomRight: (r => r.right > innerWidth * 0.8 && r.bottom > innerHeight * 0.8)(p.getBoundingClientRect()) }; })(),
  };
});
await page.screenshot({ path: path.join(SP, 'dragon-sdk-embodied.png') });
// release via the chip
await page.evaluate(() => [...document.querySelectorAll('#engAvCtl .opt')].find(b => b.textContent.includes('you are the dragon')).click());
await sleep(800);
const off = await page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = window.__eng.dragons.get(g.userData.eng.id);
  return { sdkOn: window.__eng.sdk.on, embodied: !!rec.user, dolly: rec.dolly, orbit: window.__eng.orbit.enabled,
           hud: getComputedStyle(document.getElementById('engFlapHud')).display,
           pipGone: getComputedStyle(document.getElementById('engCamPip')).display === 'none' && !document.getElementById('engCamPip').srcObject,
           overlayBack: getComputedStyle(document.getElementById('ov')).display !== 'none' };
});
console.log(JSON.stringify({ on, off }, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const ok = on.sdkOn && on.sdkChk && on.suite === 'body3d' && on.view === 'pov' && on.embodied && on.dolly && !on.orbit
  && on.hud === 'flex' && on.overlayHidden && /FLAP|ARMS/.test(on.hudBig) && /you are the dragon/.test(on.chip)
  && on.pip.shown === 'block' && on.pip.live && on.pip.playing && on.pip.bottomRight
  && off.sdkOn && !off.embodied && !off.dolly && off.orbit && off.hud === 'none' && off.overlayBack && off.pipGone && errors.length === 0;
console.log(ok ? 'DRAGON SDK PROBE OK' : 'DRAGON SDK PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
