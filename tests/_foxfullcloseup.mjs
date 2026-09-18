// close-up shots of the full fox in the engine: neutral / open / smile, front-low and side, jaw region only
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle'] });
const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 900 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 }); await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 }); await sleep(500);
await page.evaluate(async () => {
  const g = await window.__eng.spawnFox({ kind: 'full' });
  const UP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], LO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291];
  const BS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPucker', 'browInnerUp', 'eyeBlinkLeft'];
  window.__face = ({ open = 0, smile = 0 } = {}) => {
    const lm = new Array(478).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 })); const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
    const cx = 0.5; set(234, 0.35, 0.5); set(454, 0.65, 0.5); set(10, cx, 0.30); set(152, cx, 0.72 + open * 0.05); set(1, cx, 0.52); set(168, cx, 0.45); set(33, 0.42, 0.45); set(263, 0.58, 0.45);
    set(13, cx, 0.615); set(14, cx, 0.625 + open * 0.05); set(50, 0.42, 0.56); set(280, 0.58, 0.56);
    for (const [i, x] of [[107, 0.46], [66, 0.44], [105, 0.43], [63, 0.41], [336, 0.54], [296, 0.56], [334, 0.57], [293, 0.59]]) set(i, x, 0.40);
    const hw = 0.05 + smile * 0.03;
    UP.forEach((i, k) => { const t = k / 10 * 2 - 1; set(i, cx + t * hw, 0.60 + 0.02 * t * t - smile * 0.02 * t * t); });
    LO.forEach((i, k) => { const t = k / 10 * 2 - 1; const o = Math.abs(t) > 0.99 ? open * 0.012 : open * 0.05; set(i, cx + t * hw, 0.645 + o - 0.025 * t * t - smile * 0.02 * t * t); });
    const sc = { jawOpen: open, mouthSmileLeft: smile, mouthSmileRight: smile };
    return { landmarks: lm, blendshapes: BS.map(n => ({ categoryName: n, score: sc[n] || 0 })), matrix: null };
  };
  window.__feed = p => { window.__lab.AVSYNC.ovFace = window.__face(p); window.__lab.AVSYNC.faceAspect = 1; };
  window.__feed({});
  await window.__eng.foxSetLive(g, true, { sdk: false });
});
await sleep(2000);
const cam = (view) => page.evaluate((view) => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); const rec = window.__eng.foxes.get(g.userData.eng.id); const F = rec.driver;
  const V = window.__lab.THREE.Vector3; const nose = new V().setFromMatrixPosition(F.bones['nose_tip.x'].matrixWorld); const chin = new V().setFromMatrixPosition(F.bones['chin_01.x'].matrixWorld);
  const c = nose.clone().lerp(chin, 0.5); const fwd = new V(0, 0, 1).applyQuaternion(g.quaternion); const right = new V(1, 0, 0).applyQuaternion(g.quaternion);
  const E = window.__eng; E.orbit.target.copy(c);
  if (view === 'frontlow') E.camera.position.copy(c).addScaledVector(fwd, 0.28).add(new V(0, -0.06, 0));
  if (view === 'side') E.camera.position.copy(c).addScaledVector(right, 0.28).addScaledVector(fwd, 0.06);
  if (view === 'three') E.camera.position.copy(c).addScaledVector(fwd, 0.22).addScaledVector(right, 0.16).add(new V(0, 0.03, 0));
  E.camera.lookAt(c); E.orbit.update();
}, view);
for (const [name, p] of [['neutral', {}], ['open', { open: 0.9 }], ['smile', { smile: 1 }], ['half', { open: 0.4 }]]) {
  await page.evaluate(p => window.__feed(p), p); await sleep(900);
  for (const view of ['frontlow', 'side', 'three']) { await cam(view); await sleep(120); await page.screenshot({ path: path.join(SP, `cu-${name}-${view}.png`) }); }
}
await browser.close();
console.log('CLOSEUPS OK');
