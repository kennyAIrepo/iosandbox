/** signlab headless probe — boots signlab.html with the fake webcam, runs the
 *  ORT toy-model latency bench (?toy=1) and the tracker (autostart=1), and
 *  prints the console stream. Needs a static server on :3333 (same as
 *  _browserprobe.mjs). Shots land in $SHOT_DIR or the OS tmp dir. */
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'node:os';

const SHOT_DIR = process.env.SHOT_DIR || tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--window-size=1400,900',
    '--no-sandbox',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'log') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
page.on('requestfailed', r => logs.push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));

await page.goto('http://localhost:3333/signlab.html?toy=1&autostart=1',
  { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 22000));   // MediaPipe WASM + ORT warmup
await page.screenshot({ path: `${SHOT_DIR}/signlab.png` });

// float-captions button: Puppeteer's click is CDP-dispatched (trusted),
// which sometimes satisfies transient-activation requirements that a
// synthetic .click() call would not — worth actually trying, not just
// asserting feature-detection.
const floatState = await page.evaluate(() => ({
  available: 'documentPictureInPicture' in window,
  disabled: document.getElementById('float')?.disabled
}));
console.log('float-captions feature detect:', JSON.stringify(floatState));
if (floatState.available && !floatState.disabled) {
  await page.click('#float').catch(e => console.log('  float click failed: ' + e.message));
  await new Promise(r => setTimeout(r, 1500));
  const after = await page.evaluate(() => document.getElementById('float')?.textContent);
  console.log('float button after click:', after);
}

console.log('═══ signlab (?toy=1&autostart=1) ═══');
logs.slice(0, 50).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (no console output)');

const verdict = {
  boot: logs.some(l => l.includes('boot ok')),
  toy: logs.some(l => l.includes('toy ok')),
  tracker: logs.some(l => l.includes('tracker live')),
  pageError: logs.some(l => l.includes('PAGEERROR')),
};
console.log('\nverdict:', JSON.stringify(verdict));
await browser.close();
process.exit(verdict.boot && verdict.toy && verdict.tracker && !verdict.pageError ? 0 : 1);
