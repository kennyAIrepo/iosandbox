// verify a runtime-added rig point actually DEFORMS the mesh (skeleton
// rebuild + skinIndex/skinWeight edits reach the GPU)
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
  R.puppet.stop();                                      // rest pose
  const p = R.puppet.getWorldPos('Bone_030').toArray(); // mid-tail
  R.addPointAt('Deform_Test', p);
});
await new Promise(r => setTimeout(r, 300));
const a = await page.screenshot({ clip: { x: 360, y: 100, width: 900, height: 700 } });
await page.evaluate(() => window.__riglab.puppet.setPose({ Deform_Test: { px: 0.35, py: 0.2, pz: 0 } }));
await new Promise(r => setTimeout(r, 300));
const b = await page.screenshot({ clip: { x: 360, y: 100, width: 900, height: 700 } });
let diff = 0;
for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
await page.screenshot({ path: `${SHOT}/riglab_addpoint.png` });
console.log(`pixel diff after posing new point: ${diff} ${diff > 800 ? '(DEFORMS ok)' : '(NO DEFORMATION — broken!)'}`);
await browser.close();
process.exit(diff > 800 ? 0 : 1);
