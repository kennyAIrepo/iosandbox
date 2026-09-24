// the marginal cost of the collider conform pass, measured directly
import puppeteer from 'puppeteer-core';
const URL = process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1300,900','--no-sandbox','--use-gl=angle','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
const p = await b.newPage();
await p.setViewport({ width: 1300, height: 900 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#startBtn', { timeout: 30000 });
await p.click('#startBtn');
await p.waitForFunction(() => window.__lab?.S?.running, { timeout: 120000 });
await sleep(800);
await p.click('#basketBtn');
await p.waitForFunction(() => window.__lab.basket.on && window.__lab.basket.ball, { timeout: 60000 });
await sleep(1200);

const out = await p.evaluate(() => {
  const L = window.__lab, THREE = L.THREE;
  const rig = L.rigR; if (!rig) return { err: 'no rig' };
  const c = L.basket.ball.sphere.pos;
  const pack = Array.from({ length: 21 }, (_, i) => new THREE.Vector3(c.x + (i % 5) * 0.015 - 0.03, c.y + Math.floor(i / 5) * 0.015, c.z));
  const cols = [L.slimeCol, L.bowCol, L.arrowCol, L.nockCol, L.basket.ball.collider];
  const N = 120;
  const run = (cs) => { const t0 = performance.now(); for (let i = 0; i < N; i++) rig.pose(pack, cs); return (performance.now() - t0) / N; };
  const far = pack.map(p => p.clone().setX(p.x + 1.2));   // the same hand, 1.2 m from the ball
  run(null); run(cols);                                   // warm
  const off = run(null), on = run(cols);
  const runFar = (cs) => { const t0 = performance.now(); for (let i = 0; i < N; i++) rig.pose(far, cs); return (performance.now() - t0) / N; };
  runFar(null); runFar(cols);
  const offF = runFar(null), onF = runFar(cols);
  return { vc: rig.vc, pose_no_cols_ms: +off.toFixed(3), pose_with_cols_ms: +on.toFixed(3),
           marginal_ms_per_rig: +(on - off).toFixed(3), marginal_ms_both_hands: +((on - off) * 2).toFixed(3),
           FAR_marginal_ms_per_rig: +(onF - offF).toFixed(3),
           ballColliderActive: L.basket.ball.collider.active, activeCols: cols.filter(x => x && x.active).length };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
