/** Browser probe for the FULL-BODY SILHOUETTE: boots handlab with a fake
 *  camera, verifies the shadow rig forges + shaders compile, checks the
 *  first-person shadow (rest-pose stand-in), exercises the new UI controls,
 *  and screenshots each state. Needs the static server on :3333. */
import puppeteer from 'puppeteer-core';

const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/c5373976-e297-4fe9-a13b-cbfde369d2c6/scratchpad';
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
await new Promise(r => setTimeout(r, 12000));
await page.screenshot({ path: `${SHOT_DIR}/b0-mirror.png` });

// third-person: rest-pose shadow must be standing at spawn
await page.evaluate(() => document.querySelector('[data-v="thirdPerson"]').click());
await new Promise(r => setTimeout(r, 2000));
await page.screenshot({ path: `${SHOT_DIR}/b1-thirdp-shadow.png` });
console.log('TP ' + JSON.stringify(await page.evaluate(() => ({
  metrics: document.querySelector('#metrics')?.textContent,
  airY: window.HOPEOS_STATE?.body?.airY,
}))));

// first-person: the NEW shadow-in-the-scene framing (rest-pose stand-in)
await page.evaluate(() => document.querySelector('[data-v="firstPerson"]').click());
await new Promise(r => setTimeout(r, 2000));
await page.screenshot({ path: `${SHOT_DIR}/b2-firstp-shadow.png` });

// UI: size + height sliders, look toggle
const ui = await page.evaluate(() => {
  const fire = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input')); };
  fire('bodySizeSld', 1.4);
  fire('bodyYSld', 0.3);
  return {
    sizeLabel: document.getElementById('bodySizeVal').textContent,
    yLabel: document.getElementById('bodyYVal').textContent,
  };
});
console.log('UI ' + JSON.stringify(ui));
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: `${SHOT_DIR}/b3-firstp-big-high.png` });

// look toggle → ghost, then back to shadow
await page.evaluate(() => document.querySelector('#bodyLookOpts [data-l="ghost"]').click());
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: `${SHOT_DIR}/b4-firstp-ghost.png` });
const look = await page.evaluate(() => document.querySelector('#bodyLookOpts .sel')?.dataset.l);
console.log('LOOK after toggle: ' + look);
await page.evaluate(() => document.querySelector('#bodyLookOpts [data-l="shadow"]').click());

// sanity: rig internals
console.log('RIG ' + JSON.stringify(await page.evaluate(() => {
  const m = document.querySelector('#metrics')?.textContent;
  return { metrics: m };
})));

console.log('\n─ console problems ─');
logs.slice(0, 30).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (none)');
await browser.close();
console.log('done');
