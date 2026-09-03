import os from 'node:os';
import puppeteer from 'puppeteer-core';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1100,1000', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1000 });
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await new Promise(r => setTimeout(r, 600));
await page.click('#engSpawnRow [data-sp="bow"]');
await page.waitForFunction(() => window.__eng.bows && window.__eng.bows.size === 1, { timeout: 60000 });
await page.waitForFunction(() => !!window.__eng.arrowTpl, { timeout: 120000 });
const lights = await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  bow.position.set(0, 0, 0);
  window.__eng.sel = null; window.__eng.tc.detach(); window.__eng.box.visible = false;
  // side-on close-up: bow draw-plane is world XY → camera on +Z
  window.__eng.orbit.target.set(0, 0.95, 0);
  window.__eng.camera.position.set(0.35, 0.95, 3.2);
  window.__eng.orbit.update();
  const L = [];
  window.__eng.scene.traverse(o => { if (o.isLight) L.push(o.type + ' i=' + o.intensity); });
  return L;
});
console.log('lights:', lights);
await new Promise(r => setTimeout(r, 300));
await page.screenshot({ path: SP + '/bow-rest.png' });
await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  window.__eng.bowSetDraw(bow, 0.85);
});
await new Promise(r => setTimeout(r, 300));
await page.screenshot({ path: SP + '/bow-full.png' });
await browser.close();
console.log('done');
