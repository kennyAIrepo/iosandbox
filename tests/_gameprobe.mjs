/** Browser probe for BEAT RUSH: boots handlab with a fake camera, runs a
 *  synth round, dumps HOPEOS_STATE + results, screenshots to the OS tmp dir.
 *  Needs a static server on :3333 (same as _browserprobe.mjs). */
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
await page.screenshot({ path: `${SHOT_DIR}/g0-entry.png` });

// boot (fake camera)
await page.click('#startBtn').catch(e => logs.push('startBtn: ' + e.message));
await new Promise(r => setTimeout(r, 11000));
await page.screenshot({ path: `${SHOT_DIR}/g1-booted.png` });

// Third-P: the Kinect-style avatar view — with no live pose the body
// stands at spawn in rest pose, so the mesh is visually verifiable
await page.evaluate(() => document.querySelector('[data-v="thirdPerson"]').click());
await new Promise(r => setTimeout(r, 2500));
await page.screenshot({ path: `${SHOT_DIR}/g1b-avatar.png` });
console.log('AVATAR ' + JSON.stringify(await page.evaluate(() => ({
  body: window.HOPEOS_STATE?.body, metrics: document.querySelector('#metrics')?.textContent,
}))));

// start a synth round (forces first-person)
await page.click('#gameBtn').catch(e => logs.push('gameBtn: ' + e.message));
await new Promise(r => setTimeout(r, 5500));   // countdown 3.2s + a bit of play
await page.screenshot({ path: `${SHOT_DIR}/g2-countdown-over.png` });
await new Promise(r => setTimeout(r, 7000));
await page.screenshot({ path: `${SHOT_DIR}/g3-midgame.png` });

const state = await page.evaluate(() => {
  const s = window.HOPEOS_STATE;
  return {
    mode: s?.mode, game: s?.game, ball: s?.ball,
    hudVisible: getComputedStyle(document.querySelector('#brTop')).display,
    scoreText: document.querySelector('#brScore')?.textContent,
    progText: document.querySelector('#brProg .nm')?.textContent,
    metrics: document.querySelector('#metrics')?.textContent,
  };
});
console.log('STATE ' + JSON.stringify(state, null, 1));

// stop → results screen
await page.click('#gameBtn').catch(e => logs.push('stop: ' + e.message));
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: `${SHOT_DIR}/g4-results.png` });
const results = await page.evaluate(() => ({
  shown: getComputedStyle(document.querySelector('#brResults')).display,
  text: document.querySelector('#brResults')?.textContent?.replace(/\s+/g, ' ').slice(0, 200),
}));
console.log('RESULTS ' + JSON.stringify(results));

console.log('\n─ console problems ─');
logs.slice(0, 30).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (none)');
await browser.close();
console.log('done');
