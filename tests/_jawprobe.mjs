// which bones hinge the jaws, which axis+sign opens/closes? pose candidates
// and screenshot the head region for visual comparison.
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

// side-on view of the head, close up
await page.evaluate(() => {
  const R = window.__riglab;
  R.puppet.stop();
  R.puppet.showMarkers(false);
  R.setCamera([-2.4, 1.5, 2.5], [-0.4, 1.0, 1.05]);
});
await new Promise(r => setTimeout(r, 250));

const poses = [
  ['rest', {}],
  ['B043_rx+30', { Bone_043: { rx: 30 } }],
  ['B043_rx-30', { Bone_043: { rx: -30 } }],
  ['B049_rx+30', { Bone_049: { rx: 30 } }],
  ['B049_rx-30', { Bone_049: { rx: -30 } }],
  ['B043_rz+30', { Bone_043: { rz: 30 } }],
  ['B011_rx+20', { Bone_011: { rx: 20 } }],
];
for (const [name, pose] of poses) {
  await page.evaluate(p => window.__riglab.puppet.setPose(p), pose);
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: `${SHOT}/jaw_${name}.png`, clip: { x: 360, y: 60, width: 1020, height: 800 } });
  console.log('shot:', name);
}
await browser.close();
