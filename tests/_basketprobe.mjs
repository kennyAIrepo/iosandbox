// 🏀 BASKETBALL probe — both lanes of mpbrowser, in a real browser.
// MIRROR: spawn the scanned ball · an OPEN hand held over it brings it to
// contact DEPTH and never grabs it · a hand driven INTO it is STOPPED (the
// drawn pack moves, the fingers end up ON the surface, never inside) · the
// avoidance skin is 5 SCREEN PIXELS, measured at the ball's own depth · a WRAP
// picks it up, moving the hand carries it, opening throws it · both hands
// pinching resize it.  ENGINE: 🏀 Ball spawns, is listed, gets its strip, falls
// to the floor and settles.   needs: npm run serve
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const URL = process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK|404|Failed to load resource/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = n => page.screenshot({ path: path.join(SP, 'basket-' + n + '.png') });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 });
await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await sleep(600);

// ───────────────────────── MIRROR ─────────────────────────
await page.click('#basketBtn');
await page.waitForFunction(() => window.__lab.basket.on && window.__lab.basket.ball, { timeout: 60000 });
await sleep(1400);

await page.evaluate(() => {
  const L = window.__lab;
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  window.__bp = {
    // fingers extended, in the screen plane (closure ≈ 0) — an open hand
    open(x, y, z) {
      const p = mk(V(x, y, z));
      p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
      p[5] = V(x + 0.035, y + 0.04, z); p[17] = V(x - 0.035, y + 0.04, z);
      for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.16, z);
      p[4] = V(x + 0.1, y, z);
      return p;
    },
    // palm on one side, fingers closed round the far side — a real WRAP
    wrap(c, r, side = 1) {
      const p = mk(V(c.x, c.y - 0.3, c.z + 0.5));
      p[9] = V(c.x, c.y, c.z + (r + 0.022) * side); p[0] = V(c.x, c.y - 0.204, c.z + (r + 0.022) * side);
      p[5] = V(c.x + 0.04, c.y, c.z + (r + 0.022) * side); p[13] = V(c.x - 0.04, c.y, c.z + (r + 0.022) * side);
      p[17] = V(c.x - 0.08, c.y, c.z + (r + 0.022) * side);
      const fz = -(r + 0.013);
      p[8] = V(c.x + 0.04, c.y, c.z + fz); p[12] = V(c.x, c.y, c.z + fz); p[16] = V(c.x - 0.04, c.y, c.z + fz);
      p[7] = V(c.x + 0.04, c.y + 0.03, c.z - (r + 0.015)); p[11] = V(c.x, c.y + 0.03, c.z - (r + 0.015));
      for (const i of [6, 10, 14]) p[i] = V(c.x, c.y + r + 0.05, c.z);
      for (const i of [1, 2, 3, 4]) p[i] = V(c.x + r + 0.08, c.y - 0.05, c.z + 0.02);
      return p;
    },
    pinch(x, y, z) {
      const p = mk(V(x, y, z));
      p[0] = V(x, y - 0.1, z); p[9] = V(x, y - 0.02, z);
      p[5] = V(x + 0.035, y - 0.03, z); p[17] = V(x - 0.035, y - 0.03, z);
      p[4] = V(x, y, z); p[8] = V(x + 0.004, y, z);
      for (const i of [12, 16, 20]) p[i] = V(x, y - 0.06, z + 0.03);
      return p;
    },
    clone(p) { return p ? p.map(q => ({ x: q.x, y: q.y, z: q.z })) : null; },
    feed(l, r) { L.AVSYNC.ovPose = null; L.AVSYNC.ovPacks = { L: this.clone(l), R: this.clone(r) }; },
    ballPos() { const b = window.__lab.basket.ball; return { x: b.sphere.pos.x, y: b.sphere.pos.y, z: b.sphere.pos.z }; },
    radius() { const b = window.__lab.basket.ball; return b.radius * b.userS; },
  };
});
const stat = () => page.evaluate(() => {
  const B = window.__lab.basket, s = B.stats();
  const p = B.ball.sphere.pos;
  return { ...s, pos: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)], on: B.on,
           r: +(B.ball.radius * B.ball.userS).toFixed(3),
           tris: B.ball.mesh.geometry.index ? B.ball.mesh.geometry.index.count / 3 : B.ball.mesh.geometry.attributes.position.count / 3,
           textured: !!B.ball.mesh.material.map };
});
const out = {};
await sleep(900);
out.rest = await stat();
await shot('1-rest');

// (a) an OPEN hand held over it: REACH brings it to contact depth, and it is NOT grabbed
await page.evaluate(() => {
  const W = window.__bp, c = W.ballPos();
  window.__o = { x: c.x + 0.01, y: c.y, z: c.z + 0.35 };
  W.feed(W.open(window.__o.x, window.__o.y, window.__o.z), null);
});
await sleep(1100);
out.reach = await stat();
out.reachDetail = await page.evaluate(() => {
  const B = window.__lab.basket.ball, L = window.__lab;
  return { gapToHand: +Math.abs(B.sphere.pos.z - window.__o.z).toFixed(3), seek: B.seek,
           held: !!B.hold, cradle: B.cradle,
           handMovedZ: +Math.abs(L.AVSYNC.packs.L[0].z - window.__o.z).toFixed(3) };
});
await shot('2-reach');

// (b) a hand driven INTO the ball is STOPPED — flush, never inside
await page.evaluate(() => { window.__bp.feed(null, null); });
await sleep(700);
await page.evaluate(() => {
  const W = window.__bp, c = W.ballPos();
  window.__pen = { x: c.x, y: c.y, z: c.z, r: W.radius() };
  window.__maxPush = 0; window.__sawAvoid = false;
});
for (let k = 1; k <= 20; k++) {
  await page.evaluate(k => {
    const W = window.__bp, p = window.__pen;
    const depth = Math.min(1, k / 10) * (p.r + 0.04);            // walk the palm through the centre
    W.feed(W.open(p.x, p.y, p.z + p.r + 0.06 - depth), null);
    const L = window.__lab, B = L.basket.ball;
    const drawn = L.AVSYNC.packs && L.AVSYNC.packs.L, fed = L.AVSYNC.ovPacks.L;
    if (drawn && fed) window.__maxPush = Math.max(window.__maxPush, Math.abs(drawn[0].z - fed[0].z));
    if (B.avoiding) window.__sawAvoid = true;
  }, k);
  await sleep(55);
}
await sleep(300);
out.stop = await page.evaluate(() => {
  const L = window.__lab, B = L.basket.ball;
  const pack = L.AVSYNC.packs.L;
  const c = B.sphere.pos, R = B.radius * B.userS;
  let deepest = 0, closest = Infinity;
  const RAD = [0.034, 0.024, 0.020, 0.017, 0.015, 0.022, 0.017, 0.015, 0.013, 0.022, 0.017, 0.015, 0.013, 0.021, 0.016, 0.014, 0.012, 0.019, 0.015, 0.013, 0.011];
  const palm = Math.hypot(pack[0].x - pack[9].x, pack[0].y - pack[9].y, pack[0].z - pack[9].z) || 0.204;
  for (let i = 0; i < 21; i++) {
    const d = Math.hypot(pack[i].x - c.x, pack[i].y - c.y, pack[i].z - c.z) - R - RAD[i] * (palm / 0.204);
    deepest = Math.min(deepest, d); closest = Math.min(closest, d);
  }
  return { pushed_mm: +(window.__maxPush * 1000).toFixed(1), deepest_mm: +(deepest * 1000).toFixed(2),
           clearance_mm: +(closest * 1000).toFixed(2), skin_mm: +(B.resistSkin * 1000).toFixed(2),
           skin_px: 5, avoiding: window.__sawAvoid };
});
await shot('3-hand-stopped');

// (c) the 5-PIXEL gate: the skin tracks the ball's depth, not a constant
out.gate = await page.evaluate(() => {
  const L = window.__lab, B = L.basket.ball, cam = L.camera;
  const H = L.renderer ? (L.renderer.domElement.clientHeight || 900) : 900;
  const at = (dist) => {
    const worldH = 2 * Math.tan(cam.fov * Math.PI / 360) * dist;
    return 5 * worldH / H;
  };
  const dist = cam.position.distanceTo(B.sphere.pos);
  return { live_mm: +(B.resistSkin * 1000).toFixed(2), expect_mm: +(at(dist) * 1000).toFixed(2),
           at1m_mm: +(at(1) * 1000).toFixed(2), at4m_mm: +(at(4) * 1000).toFixed(2), dist: +dist.toFixed(2) };
});

// (d) a WRAP picks it up; lifting carries it; opening throws it
await page.evaluate(() => { window.__bp.feed(null, null); });
await sleep(900);
await page.evaluate(() => {
  const W = window.__bp, c = W.ballPos();
  window.__w = { c, r: W.radius() };
  W.feed(W.wrap(c, W.radius()), null);
});
await sleep(400);
out.grab = await stat();
for (let k = 1; k <= 15; k++) {
  await page.evaluate(k => {
    const W = window.__bp, w = window.__w;
    W.feed(W.wrap({ x: w.c.x, y: w.c.y + 0.22 * k / 15, z: w.c.z }, w.r), null);
  }, k);
  await sleep(40);
}
await sleep(200);
out.carry = await stat();
await shot('4-carried');
await page.evaluate(() => {
  const W = window.__bp, w = window.__w;
  W.feed(W.open(w.c.x, w.c.y + 0.22, w.c.z + w.r + 0.3), null);
});
await sleep(700);
out.release = await stat();

// (e) both hands pinching = resize
await page.evaluate(() => { window.__bp.feed(null, null); });
await sleep(600);
const beforeScale = (await stat()).scale;
await page.evaluate(() => {
  const W = window.__bp, c = W.ballPos();
  window.__p = c;
  W.feed(W.pinch(c.x - 0.1, c.y, c.z), W.pinch(c.x + 0.1, c.y, c.z));
});
await sleep(300);
for (let k = 1; k <= 12; k++) {
  await page.evaluate(k => {
    const W = window.__bp, p = window.__p, d = 0.1 + 0.12 * k / 12;
    W.feed(W.pinch(p.x - d, p.y, p.z), W.pinch(p.x + d, p.y, p.z));
  }, k);
  await sleep(45);
}
await sleep(300);
out.scaled = await stat();
await page.evaluate(() => { window.__bp.feed(null, null); });
await shot('5-resized');

// ───────────────────────── ENGINE ─────────────────────────
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 60000 });
await sleep(700);
await page.click('#engSpawnRow [data-sp="ball"]');
await page.waitForFunction(() => window.__eng && window.__eng.baskets && window.__eng.baskets.size > 0, { timeout: 90000 });
await sleep(1800);
out.engine = await page.evaluate(() => {
  const E = window.__eng, g = E.objects.find(o => o.userData.eng.type === 'ball');
  const rec = E.baskets.get(g.userData.eng.id);
  E.select(g);
  return { spawned: !!g, listed: [...document.querySelectorAll('.engRow')].some(r => /🏀/.test(r.textContent)),
           y: +rec.ball.sphere.pos.y.toFixed(3), r: +(rec.ball.radius * rec.ball.userS).toFixed(3),
           resting: Math.abs(rec.ball.sphere.pos.y - rec.ball.radius * rec.ball.userS) < 0.02,
           skin_mm: +(rec.ball.resistSkin * 1000).toFixed(2) };
});
await sleep(300);
out.engineStrip = await page.evaluate(() => ({
  label: document.getElementById('engAvCtlLbl').textContent,
  buttons: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent),
}));
await page.evaluate(() => {
  const E = window.__eng, g = E.objects.find(o => o.userData.eng.type === 'ball');
  const rec = E.baskets.get(g.userData.eng.id), V = window.__lab.THREE.Vector3;
  const c = rec.ball.sphere.pos;
  E.orbit.target.copy(c); E.camera.position.copy(c).add(new V(0.7, 0.45, 0.9)); E.camera.lookAt(c); E.orbit.update();
});
await sleep(300);
await shot('6-engine');

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const R = out;
const checks = {
  'the scanned ball spawns (textured, ~4.5k tris)': R.rest.on && R.rest.textured && R.rest.tris > 3000,
  'at a real basketball size': Math.abs(R.rest.r - 0.12) < 0.005,
  'REACH: an open hand over it brings it to contact depth': R.reach.pos[2] > R.rest.pos[2] + 0.05 && R.reachDetail.gapToHand < R.rest.r + 0.09,
  'and it was never LIFTED to get there': Math.abs(R.reach.pos[1] - R.rest.pos[1]) < 0.02,
  'and an open hand never grabs it': !R.reachDetail.held,
  'the hand is not moved by the reach': R.reachDetail.handMovedZ < 0.01,
  'a hand pushed into it is STOPPED': R.stop.pushed_mm > 5,
  'it ends flush — never inside the surface': R.stop.deepest_mm > -1.5,
  'avoidance was in charge': R.stop.avoiding === true,
  'the skin is 5 px at the ball depth': Math.abs(R.gate.live_mm - R.gate.expect_mm) < 0.05,
  'and it is a PIXEL gate, not a constant': R.gate.at4m_mm > R.gate.at1m_mm * 3.5,
  'a WRAP picks it up': !!R.grab.held,
  'carrying lifts it': R.carry.pos[1] > R.grab.pos[1] + 0.1,
  'opening the hand releases it': !R.release.held,
  'both hands pinching resize it': R.scaled.scale > beforeScale * 1.3,
  'engine: spawns, listed, rests on the floor': R.engine.spawned && R.engine.listed && R.engine.resting,
  'engine: its strip appears': /BASKETBALL/.test(R.engineStrip.label) && R.engineStrip.buttons.some(t => /drop/.test(t)),
  'no page errors': errors.length === 0,
};
for (const [k, v] of Object.entries(checks)) console.log((v ? '  ok   ' : '  FAIL ') + k);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'BASKETBALL PROBE OK' : 'BASKETBALL PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
