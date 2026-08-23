// throwaway: simulate a user annotating in riglab, verify journal + replay
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1400,900', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('dialog', d => { console.log('DIALOG:', d.type(), d.message()); d.accept('tongue bend should peak HERE'); });
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:3333/riglab', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /playing|rig points/.test(document.getElementById('status').textContent), { timeout: 60000 });

await page.click('#annoBtn');                       // annotate mode on
// ink stroke: circle-ish around the head area
await page.mouse.move(700, 350);
await page.mouse.down();
for (let a = 0; a <= 12; a++) {
  await page.mouse.move(700 + Math.cos(a / 2) * 60, 350 + Math.sin(a / 2) * 45);
  await new Promise(r => setTimeout(r, 25));
}
await page.mouse.up();
// text note via dbl-click — synthetic DOM event (CDP mouse clicks don't
// accumulate clickCount, so no native dblclick in headless)
await page.evaluate(() => {
  const r = document.getElementById('anno').getBoundingClientRect();
  document.getElementById('anno').dispatchEvent(new MouseEvent('dblclick',
    { clientX: r.left + 420, clientY: r.top + 200, bubbles: true }));
});
// orbit is disabled in annotate mode, so also nudge camera off? skip — flush
await new Promise(r => setTimeout(r, 1800));        // > journal flush interval
console.log('annotated + flushed');
await browser.close();
