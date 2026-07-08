/** Screenshot regression for the body mesh via tests/_bodyview.html:
 *  rest + arms-up (waist-shard check), hand/foot/head close-ups.
 *  Needs the static server on :3333. Shots land in the OS tmp dir. */
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'os';

const SHOT_DIR = (process.env.SHOT_DIR || tmpdir()).replace(/\\/g, '/');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1100,1100', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1100 });
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text().slice(0, 200)}`); });
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));

const shots = [
  ['v0-rest', 'pose=rest'],
  ['v1-arms-up', 'pose=up'],
  ['v2-hand', 'pose=rest&cam=hand'],
  ['v3-foot', 'pose=rest&cam=foot'],
  ['v4-head', 'pose=rest&cam=head'],
  ['v5-ghost-up', 'pose=up&look=ghost'],
  ['v6-retarget', 'pose=retarget'],          // the LIVE first/third-person path
  ['v7-retarget-up', 'pose=retarget-up'],
];
for (const [name, params] of shots) {
  await page.goto(`http://localhost:3333/tests/_bodyview.html?${params}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  console.log(`shot ${name}`);
}
console.log('\n─ console problems ─');
logs.slice(0, 20).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (none)');
await browser.close();
console.log('done → ' + SHOT_DIR);
