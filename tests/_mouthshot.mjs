// screenshot the mouth preset at its CLOSED phase for a visual check
import puppeteer from 'puppeteer-core';
const SHOT = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/d1691736-d038-4eac-b4a5-2f5470f754f5/scratchpad';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1400,900', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto('http://localhost:3333/riglab', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /playing|rig points/.test(document.getElementById('status').textContent), { timeout: 60000 });
await page.evaluate(() => {
  const R = window.__riglab;
  R.puppet.showMarkers(false);
  R.setCamera([-2.4, 1.5, 2.5], [-0.4, 1.0, 1.05]);
  R.setScript(R.buildPreset('mouth', R.rig));
  R.puppet.pause();
  R.puppet.time = 0.5;                       // hold at the "closed" phase
});
await new Promise(r => setTimeout(r, 300));
await page.screenshot({ path: `${SHOT}/mouth_closed.png`, clip: { x: 360, y: 60, width: 1020, height: 800 } });
console.log('shot: mouth_closed');
await browser.close();
