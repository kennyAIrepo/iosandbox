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
const before = await p.evaluate(() => ({ calls: window.__lab.renderInfo?.() ?? null }));
await p.click('#basketBtn');
await p.waitForFunction(() => window.__lab.basket.on && window.__lab.basket.ball, { timeout: 60000 });
await sleep(1500);
const out = await p.evaluate(async () => {
  const L = window.__lab, THREE = L.THREE;
  const B = L.basket.ball;
  let tris = 0, verts = 0, mats = [], texs = [];
  B.mesh.traverse(m => { if (m.isMesh && m.geometry) {
    const g = m.geometry, pos = g.getAttribute('position');
    verts += pos.count; tris += (g.index ? g.index.count : pos.count) / 3;
    const mm = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of mm) { mats.push(mt.type);
      for (const k of ['map','normalMap','roughnessMap','metalnessMap','aoMap'])
        if (mt[k] && mt[k].image) texs.push(k + ':' + mt[k].image.width + 'x' + mt[k].image.height); } } });
  // time basketLab.update with hands right on the ball
  const c = B.sphere.pos;
  const mk = dx => Array.from({length:21}, (_,i) => new THREE.Vector3(c.x + dx + (i%5)*0.015, c.y + Math.floor(i/5)*0.015 - 0.03, c.z));
  const packs = { L: mk(-0.06), R: mk(0.06) };
  const N = 200;
  const t0 = performance.now(); for (let i=0;i<N;i++) L.basket.update(1/60, packs); const upd = (performance.now()-t0)/N;
  return { tris, verts, mats: [...new Set(mats)], texs: [...new Set(texs)],
           basketLab_update_ms: +upd.toFixed(3),
           renderTriangles: L.rendererInfo ? L.rendererInfo() : null };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
