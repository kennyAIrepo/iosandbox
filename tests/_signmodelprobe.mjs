/** Real-model probe: loads the trained signnet.onnx (not the toy latency
 *  model) via signlab's ?model=&labels= params and confirms the ORT session
 *  actually initializes end-to-end with the real 12.5MB weights file —
 *  the toy-model probe only proves the ORT plumbing, not that our exported
 *  checkpoint itself loads. Needs a static server on :3333. */
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'node:os';

const SHOT_DIR = process.env.SHOT_DIR || tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--window-size=1400,900', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'log') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
page.on('requestfailed', r => logs.push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));

const url = 'http://localhost:3333/signlab.html?model=/assets/models/signnet.onnx&labels=/assets/models/labels.json&autostart=1';
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 20000));   // MediaPipe WASM + ORT model load warmup
await page.screenshot({ path: `${SHOT_DIR}/signmodelprobe.png` });

console.log(`═══ signlab real model (${url}) ═══`);
logs.slice(0, 60).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (no console output)');

const verdict = {
  boot: logs.some(l => l.includes('boot ok')),
  classifierReady: logs.some(l => l.includes('classifier ready')),
  loadFailed: logs.some(l => l.includes('classifier load failed')),
  tracker: logs.some(l => l.includes('tracker live')),
  pageError: logs.some(l => l.includes('PAGEERROR')),
};
console.log('\nverdict:', JSON.stringify(verdict));
await browser.close();
process.exit(verdict.boot && verdict.classifierReady && verdict.tracker && !verdict.loadFailed && !verdict.pageError ? 0 : 1);
