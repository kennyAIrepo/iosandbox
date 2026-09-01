// verify mpbrowser.html's 🧩 ENGINE VIEW: button enters it without needing a camera,
// clean environment builds (sky dome + endless grid, no neon), spawn/select/save works,
// and ↩ LAB returns. Needs the dev server on :3333 (npm run serve).
import puppeteer from 'puppeteer-core';
import os from 'node:os';
const SP = process.env.PROBE_SHOTS || os.tmpdir();   // screenshot output dir
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1400,900', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');                                   // straight from the entry screen — no camera needed
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));                   // addons + first frames

// spawn a couple of objects and read back the scene state
await page.click('#engSpawnRow [data-sp="box"]');
await page.click('#engSpawnRow [data-sp="sphere"]');
await new Promise(r => setTimeout(r, 400));
const state = await page.evaluate(() => ({
  engineView: document.body.classList.contains('engine-view'),
  labHidden: getComputedStyle(document.getElementById('hudL')).display === 'none',
  entryHidden: getComputedStyle(document.getElementById('entry')).display === 'none',
  objRows: document.querySelectorAll('.engRow').length,
  selRows: document.querySelectorAll('.engRow.sel').length,
}));
await page.screenshot({ path: SP + '/engine-view.png' });

// EXACT transform: numeric whole-object scale + move-N-units-along-axis
const exact = await page.evaluate(() => {
  const sel = window.__eng.sel;
  const p0 = sel.position.clone(), s0 = sel.scale.x;
  document.getElementById('engExactVal').value = '2.5';
  document.getElementById('engExactScale').click();               // ×whole
  const scaled = { x: sel.scale.x, y: sel.scale.y, z: sel.scale.z };
  document.querySelector('#engExactRow [data-ax="z"]').click();   // pick Z
  document.getElementById('engExactVal').value = '-1.5';
  document.getElementById('engExactMove').click();                // → move
  // measure SYNCHRONOUSLY — the auto-collision resolver may legitimately push
  // the object on the next frame if the move lands it inside another object
  const movedZ = Math.abs(sel.position.z - (p0.z - 1.5)) < 1e-6;
  const xyUntouched = sel.position.x === p0.x && sel.position.y === p0.y;
  // settle a few frames: engLoop fits the box BEFORE the collision tick, so a
  // move that lands inside another object leaves the box one frame behind
  const boxFits = new Promise(r => setTimeout(() =>
    r(Math.abs(window.__eng.box.box.getCenter(new window.__lab.THREE.Vector3()).z - sel.position.z) < 0.5), 150));
  return boxFits.then(bf => ({
    uniform: Math.abs(scaled.x - s0 * 2.5) < 1e-6 && scaled.x === scaled.y && scaled.y === scaled.z,
    movedZ, xyUntouched,
    boxFollows: bf,
  }));
});

// save → clear → load round-trip
await page.click('#engSave');
await page.click('#engClear');
const afterClear = await page.evaluate(() => document.querySelectorAll('.engRow').length);
await page.click('#engLoad');
await new Promise(r => setTimeout(r, 400));
const afterLoad = await page.evaluate(() => document.querySelectorAll('.engRow').length);

// back to lab
await page.click('#engBack');
const backInLab = await page.evaluate(() => !document.body.classList.contains('engine-view')
  && getComputedStyle(document.getElementById('hudL')).display !== 'none');
await browser.close();

console.log(JSON.stringify({ ...state, exact, afterClear, afterLoad, backInLab }, null, 2));
const fail = [];
if (!state.engineView) fail.push('did not enter engine view');
if (!state.labHidden || !state.entryHidden) fail.push('lab/entry chrome still visible');
if (state.objRows !== 2) fail.push('expected 2 object rows, got ' + state.objRows);
if (state.selRows !== 1) fail.push('spawn did not select');
if (!exact.uniform) fail.push('×whole did not scale uniformly');
if (!exact.movedZ || !exact.xyUntouched) fail.push('exact move-along-axis wrong: ' + JSON.stringify(exact));
if (!exact.boxFollows) fail.push('selection box did not follow the exact transform');
if (afterClear !== 0) fail.push('clear left rows');
if (afterLoad !== 2) fail.push('save/load round-trip failed, got ' + afterLoad);
if (!backInLab) fail.push('↩ LAB did not return');
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ engine view works — screenshot: engine-view.png');
process.exit(fail.length ? 1 : 0);
