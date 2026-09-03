// visual check: LABBOW mirror overlay — lit bow + arrow floating at the
// hands' working depth. Screenshot only (labbow-view.png).
import os from 'node:os';
import puppeteer from 'puppeteer-core';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1100,900', '--no-sandbox', '--use-gl=angle',
         '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 });
await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await new Promise(r => setTimeout(r, 400));
await page.click('#bowBtn');
await page.waitForFunction(() => window.__lab.labBow.on && window.__lab.labBow.arrow, { timeout: 120000 });
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: SP + '/labbow-view.png' });
await browser.close();
console.log('shot: ' + SP + '/labbow-view.png');
