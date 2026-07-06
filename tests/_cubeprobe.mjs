/** Browser probe for the RUBIK'S CUBE sandbox: boots handlab with a fake
 *  camera, clicks 🧊 SPAWN CUBE, verifies the cube drops onto the table,
 *  dumps HOPEOS_STATE.cube + console errors, screenshots to the OS tmp dir.
 *  Needs a static server on :3333 (same as _gameprobe.mjs). */
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'os';

const SHOT_DIR = tmpdir().replace(/\\/g, '/');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1400,900',
    '--no-sandbox',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
page.on('requestfailed', r => logs.push(`[REQFAIL] ${r.url().slice(0, 110)} ${r.failure()?.errorText}`));

await page.goto('http://localhost:3333/handlab', { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 2500));

// boot (fake camera)
await page.click('#startBtn').catch(e => logs.push('startBtn: ' + e.message));
await new Promise(r => setTimeout(r, 11000));
await page.screenshot({ path: `${SHOT_DIR}/c0-booted.png` });

// spawn the cube — the user's exact click
await page.click('#cubeBtn').catch(e => logs.push('cubeBtn: ' + e.message));
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: `${SHOT_DIR}/c1-spawned.png` });
console.log('AFTER CLICK ' + JSON.stringify(await page.evaluate(() => ({
  btn: document.querySelector('#cubeBtn')?.textContent,
  cube: window.HOPEOS_STATE?.cube,
  toast: document.querySelector('#toast')?.textContent,
}))));

// let it drop + settle on the table
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: `${SHOT_DIR}/c2-settled.png` });
const state = await page.evaluate(() => {
  const s = window.HOPEOS_STATE;
  return { mode: s?.mode, cube: s?.cube, floorY: s?.floorY,
           metrics: document.querySelector('#metrics')?.textContent };
});
console.log('SETTLED ' + JSON.stringify(state, null, 1));

// remove + respawn round-trips cleanly
await page.click('#cubeBtn');
await new Promise(r => setTimeout(r, 300));
await page.click('#cubeBtn');
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: `${SHOT_DIR}/c3-respawned.png` });
console.log('RESPAWN ' + JSON.stringify(await page.evaluate(() => window.HOPEOS_STATE?.cube)));

// the "nothing comes up" repro: spawn while SHOW=🖐 Hands (mesh isolation
// hides props) — the toggle must auto-exit isolation so the cube SHOWS
await page.click('#cubeBtn');                                       // off
await new Promise(r => setTimeout(r, 200));
await page.evaluate(() => document.querySelector('[data-disp="hands"]').click());
await new Promise(r => setTimeout(r, 200));
await page.click('#cubeBtn');                                       // spawn from isolation
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: `${SHOT_DIR}/c4-from-isolation.png` });
console.log('FROM ISOLATION ' + JSON.stringify(await page.evaluate(() => ({
  disp: document.querySelector('#dispOpts .sel')?.dataset.disp,     // must be back to 'lab'
  cube: window.HOPEOS_STATE?.cube,
}))));

console.log('\n─ console problems ─');
logs.slice(0, 30).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (none)');
await browser.close();
console.log('done');
