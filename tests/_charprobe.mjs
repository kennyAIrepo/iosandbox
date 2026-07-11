/** Screenshot the 2D character rig (character.html). Needs the static
 *  server on :3333. Shots land in the OS tmp dir (or $SHOT_DIR). */
import puppeteer from 'puppeteer-core';
import { tmpdir } from 'os';

const SHOT_DIR = (process.env.SHOT_DIR || tmpdir()).replace(/\\/g, '/');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=900,1100', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 820, height: 1080 });
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));

const shots = [
  ['char-idle', ''],
];
for (const [name, params] of shots) {
  await page.goto(`http://localhost:3333/character.html?${params}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 900));
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  console.log(`shot ${name}`);
}
console.log('\n─ console problems ─');
logs.slice(0, 25).forEach(l => console.log('  ' + l));
if (!logs.length) console.log('  (none)');
await browser.close();
console.log('done → ' + SHOT_DIR);
