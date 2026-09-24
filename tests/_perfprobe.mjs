// where the frame time goes: baseline vs cube vs ball vs both
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

await p.evaluate(() => {
  const L = window.__lab;
  const mk = (cx, cy, cz) => Array.from({length:21}, (_,i) => ({ x: cx + (i%5)*0.02, y: cy + Math.floor(i/5)*0.02, z: cz }));
  L.AVSYNC.ovPose = 0;
  L.AVSYNC.packs = { L: mk(-0.12, 0, -2), R: mk(0.12, 0, -2) };
});
await sleep(400);
console.log('rig vertex counts:', JSON.stringify(await p.evaluate(() => ({ vcR: window.__lab.rigR?.vc ?? null, vcL: window.__lab.rigL?.vc ?? null }))));

const sample = async label => {
  await sleep(2200);
  const r = await p.evaluate(async () => {
    const L = window.__lab;
    const ts = []; let last = performance.now();
    await new Promise(res => { let n = 0;
      const step = () => { const t = performance.now(); ts.push(t - last); last = t;
        if (++n < 60) requestAnimationFrame(step); else res(); };
      requestAnimationFrame(step); });
    ts.sort((a,b)=>a-b);
    const hud = (document.getElementById('metrics')||{}).innerText || '';
    const pose = /pose\s+([\d.]+)\s*ms/.exec(hud);
    return { frame_med: +ts[ts.length>>1].toFixed(2), frame_p90: +ts[Math.floor(ts.length*0.9)].toFixed(2),
             pose_ms: pose ? +pose[1] : null,
             ballCol: !!(L.basket?.ball && L.basket.ball.collider.active), ballOn: !!L.basket?.on };
  });
  console.log(label.padEnd(16), JSON.stringify(r));
  return r;
};
const base = await sample('baseline');
await p.click('#cubeBtn'); await sleep(1500);
const cube = await sample('cube on');
await p.click('#basketBtn'); await p.waitForFunction(() => window.__lab.basket.on && window.__lab.basket.ball, { timeout: 60000 });
const both = await sample('cube + ball');
await p.click('#cubeBtn'); await sleep(1200);
const ball = await sample('ball only');
console.log('\nmedian frame ms — base', base.frame_med, '| cube', cube.frame_med, '| ball', ball.frame_med, '| both', both.frame_med);
console.log('pose ms        — base', base.pose_ms, '| cube', cube.pose_ms, '| ball', ball.pose_ms, '| both', both.pose_ms);
await b.close();
