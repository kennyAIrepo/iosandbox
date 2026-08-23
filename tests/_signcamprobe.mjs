/** CAMERA-path ground-truth test: Chrome's fake webcam plays a real ASL
 *  Citizen clip (--use-file-for-fake-video-capture), so signlab's ACTUAL
 *  camera code path (getUserMedia → initCamera → mirrored display → live
 *  rAF loop) runs against footage with a known gloss. The file-adapter
 *  clip test (tests/_signclipprobe.mjs) already proved the model+featurizer;
 *  this isolates anything camera-specific. Server on :3333 required.
 *
 *    node tests/_signcamprobe.mjs <clip.y4m> <TRUTH_GLOSS>
 */
import puppeteer from 'puppeteer-core';

const [y4m, truth] = process.argv.slice(2);
if (!y4m || !truth) { console.error('usage: node tests/_signcamprobe.mjs <clip.y4m> <TRUTH>'); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--use-fake-ui-for-media-stream',
    '--window-size=1400,900', '--no-sandbox',
  ],
});
const page = await browser.newPage();
const logs = [];
page.on('console', m => { const t = m.text(); if (t.startsWith('[signlab]')) logs.push(t); });
await page.goto('http://localhost:3333/signlab.html?autostart=1',
  { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 26000));   // model load + clip loops as "webcam"
const toks = await page.evaluate(() => document.getElementById('tokens')?.textContent || '');
await browser.close();

const lines = toks.split('\n').filter(Boolean);
console.log(`═══ CAMERA path, fake webcam = ${y4m} (truth: ${truth}) ═══`);
logs.filter(l => /boot ok|featurizer|classifier|tracker/.test(l)).forEach(l => console.log('  ' + l));
lines.slice(0, 10).forEach(l => console.log('   token: ' + l));
if (!lines.length) console.log('   (no tokens emitted)');
const hit = new RegExp(`\\b${truth}\\d?\\b`, 'i').test(lines.join(' '));
console.log(`\nverdict: ${hit ? 'HIT ✓ — camera path recognizes ground truth' : 'MISS ✗ — camera path differs from file path'}`);
process.exit(hit ? 0 : 1);
