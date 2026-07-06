/** End-to-end MP3 flow probe: boots handlab with a fake camera, uploads a
 *  real audio file through the picker (pre-game analysis), starts the round,
 *  verifies the beat conductor + note stream. Needs :3333.
 *  Usage: node tests/_mp3probe.mjs [path-to-audio]
 */
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

// pass "baked" to test the embedded ⭐ Beat It track instead of an upload
const AUDIO = process.argv[2] || 'C:/Users/hanna/Downloads/Micheal_Jackson_-_Beat_It_(mp3.pm).mp3';
const BAKED = AUDIO === 'baked';
if (!BAKED && !existsSync(AUDIO)) { console.error('audio file not found: ' + AUDIO); process.exit(1); }
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
page.on('pageerror', e => logs.push('[PAGEERROR] ' + e.message));
page.on('console', m => { if (m.type() === 'error') logs.push('[error] ' + m.text().slice(0, 200)); });

await page.goto('http://localhost:3333/handlab', { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 2000));
await page.click('#startBtn');
await new Promise(r => setTimeout(r, 11000));

if (BAKED) {
  await page.evaluate(() => document.querySelector('[data-t="baked"]').click());
  console.log('ANALYZED  (baked) ' + await page.evaluate(() => document.querySelector('#trackName').textContent));
} else {
  // upload the real MP3 through the hidden picker — the exact user flow
  const input = await page.$('#mp3File');
  await input.uploadFile(AUDIO);
  // wait for the pre-game analysis to land in the track label
  await page.waitForFunction(
    () => /BPM/.test(document.querySelector('#trackName')?.textContent || ''),
    { timeout: 60000 });
  console.log('ANALYZED  ' + await page.evaluate(() => document.querySelector('#trackName').textContent));
}

// start the round — should be instant (analysis is cached)
const t0 = Date.now();
await page.click('#gameBtn');
await page.waitForFunction(() => window.HOPEOS_STATE?.game?.running === true, { timeout: 10000 });
console.log(`START LATENCY ${Date.now() - t0}ms (should be near-instant: analysis was pre-done)`);

await new Promise(r => setTimeout(r, 9000));   // countdown + first bars
await page.screenshot({ path: `${SHOT_DIR}/mp3-midgame.png` });
const state = await page.evaluate(() => {
  const s = window.HOPEOS_STATE;
  return { songTime: +s.game.songTime.toFixed(2), notesLive: s.game.notesLive,
           beat: +s.game.beat.toFixed(2), score: s.game.score,
           prog: document.querySelector('#brProg .nm')?.textContent };
});
console.log('MIDGAME  ' + JSON.stringify(state));

await new Promise(r => setTimeout(r, 6000));
const state2 = await page.evaluate(() => ({
  songTime: +window.HOPEOS_STATE.game.songTime.toFixed(2),
  notesLive: window.HOPEOS_STATE.game.notesLive,
}));
console.log('LATER    ' + JSON.stringify(state2));
await page.screenshot({ path: `${SHOT_DIR}/mp3-later.png` });

console.log('\n─ problems ─');
logs.slice(0, 20).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (none)');
await browser.close();
