// debug: which joints does the ball's grab gate see touching, frame by frame
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 900 });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 }); await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await new Promise(r => setTimeout(r, 500));
await page.click('#slimeBtn');
await page.waitForFunction(() => window.__lab.slime.on && window.__lab.slime.mesh, { timeout: 30000 });
const out = await page.evaluate(async () => {
  const G = window.__lab.slime, T3 = window.__lab.THREE;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  await wait(1600);
  const B = G.sphere.pos.clone(), r = 0.16;
  const around = (side, fingersOn) => {
    const p = mk(V(B.x, B.y - 0.3, B.z + 0.5));
    p[9] = V(B.x, B.y, B.z + r + 0.022 * side); p[0] = V(B.x, B.y - 0.204, B.z + r + 0.022 * side);
    p[5] = V(B.x + 0.04, B.y, B.z + r + 0.022 * side); p[13] = V(B.x - 0.04, B.y, B.z + r + 0.022 * side); p[17] = V(B.x - 0.08, B.y, B.z + r + 0.022 * side);
    const fz = fingersOn ? -(r + 0.013) : (r + 0.013) * side + 0.12;
    p[8] = V(B.x + 0.04, B.y, B.z + fz); p[12] = V(B.x, B.y, B.z + fz); p[16] = V(B.x - 0.04, B.y, B.z + fz);
    p[7] = V(B.x + 0.04, B.y + 0.03, B.z + (fingersOn ? -(r + 0.015) : fz)); p[11] = V(B.x, B.y + 0.03, B.z + (fingersOn ? -(r + 0.015) : fz));
    for (const i of [6, 10, 14]) p[i] = V(B.x, B.y + r + 0.05, B.z);
    for (const i of [1, 2, 3, 4]) p[i] = V(B.x + r + 0.08, B.y - 0.05, B.z + 0.02);
    return p;
  };
  const dump = (label) => {
    const pk = window.__lab.AVSYNC.packs.L;
    G.mesh.updateWorldMatrix(true, false);
    const g = G._wrapGrab(pk, 0.006);
    const T = Array.from(G._gT).map((t, i) => t ? i : -1).filter(i => i >= 0);
    const H = G.hull.begin(G.mesh); const gaps = {};
    for (let i = 0; i < 21; i++) gaps[i] = +(H.closest(new T3.Vector3(pk[i].x, pk[i].y, pk[i].z), null, null)).toFixed(3);
    return { label, gate: g, touching: T, held: !!G.hold, type: G.hold && G.hold.type, pos: G.sphere.pos.toArray().map(v => +v.toFixed(3)), gaps, p9: pk[9], p8: pk[8] };
  };
  const res = [];
  window.__lab.AVSYNC.ovPose = null;
  window.__lab.AVSYNC.ovPacks = { L: around(1, false), R: null };
  for (let k = 0; k < 6; k++) { await wait(60); res.push(dump('away' + k)); }
  window.__lab.AVSYNC.ovPacks = { L: null, R: null }; await wait(300);
  window.__lab.AVSYNC.ovPacks = { L: around(1, true), R: null };
  for (let k = 0; k < 3; k++) { await wait(60); res.push(dump('wrap' + k)); }
  return { B: B.toArray(), floor: G.floorY(), res };
});
await browser.close();
console.log(JSON.stringify(out, null, 1));
