// 🏀 BASKETBALL probe — the DEI route (dei_full.html), both lanes of mpbrowser.
// The rules it enforces are the ones that always worked on a webcam:
//   · a camera cannot measure depth, so the BALL closes the gap — reach toward
//     it from anywhere in the approach zone and it comes to your palm;
//   · a hand ON it takes it. No pose, no curl threshold, no wrap to discover;
//   · OPEN your hand and it falls — gravity is on, and a hand that is not
//     reaching for it never drags it around;
//   · your fingers never pass through it: the ball yields first, then whatever
//     is left STOPS the hand (5 screen pixels of skin, measured at its depth);
//   · the hand straddles it in depth, so the parts behind it are hidden.
// ENGINE: 🏀 Ball spawns, rests on the floor, gets its strip, same approach.
//   needs: npm run serve
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

await page.click('#basketBtn');
await page.waitForFunction(() => window.__lab.basket.on && window.__lab.basket.ball, { timeout: 60000 });
await sleep(1400);

// ── synthetic hands, fed through the overlay seam the page already supports ──
await page.evaluate(() => {
  const L = window.__lab;
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  window.__bp = {
    // a plain OPEN hand, fingers extended in the screen plane
    open(x, y, z) {
      const p = mk(V(x, y, z));
      p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
      p[5] = V(x + 0.035, y + 0.04, z); p[13] = V(x, y + 0.045, z); p[17] = V(x - 0.035, y + 0.04, z);
      for (const [i, dx] of [[8, 0.035], [12, 0.008], [16, -0.02], [20, -0.045]]) p[i] = V(x + dx, y + 0.15, z);
      for (const [i, dx] of [[7, 0.035], [11, 0.008], [15, -0.02], [19, -0.045]]) p[i] = V(x + dx, y + 0.11, z);
      for (const [i, dx] of [[6, 0.035], [10, 0.008], [14, -0.02], [18, -0.045]]) p[i] = V(x + dx, y + 0.08, z);
      p[4] = V(x + 0.085, y + 0.02, z); p[3] = V(x + 0.07, y - 0.01, z);
      p[2] = V(x + 0.05, y - 0.03, z); p[1] = V(x + 0.03, y - 0.045, z);
      return p;
    },
    // a hand CUPPED round a ball of radius r centred on c
    cup(c, r) {
      const p = mk(V(c.x, c.y, c.z));
      p[0] = V(c.x, c.y - r - 0.06, c.z + r * 0.5);
      p[9] = V(c.x, c.y - r * 0.2, c.z + r * 0.75);
      p[5] = V(c.x + r * 0.55, c.y - r * 0.1, c.z + r * 0.6);
      p[13] = V(c.x - r * 0.2, c.y - r * 0.1, c.z + r * 0.75);
      p[17] = V(c.x - r * 0.6, c.y - r * 0.15, c.z + r * 0.55);
      for (const [i, a] of [[8, 0.75], [12, 0.25], [16, -0.25], [20, -0.7]]) p[i] = V(c.x + r * a, c.y + r * 0.55, c.z - r * 0.35);
      for (const [i, a] of [[7, 0.75], [11, 0.25], [15, -0.25], [19, -0.7]]) p[i] = V(c.x + r * a, c.y + r * 0.3, c.z + r * 0.1);
      for (const [i, a] of [[6, 0.7], [10, 0.25], [14, -0.25], [18, -0.65]]) p[i] = V(c.x + r * a, c.y, c.z + r * 0.45);
      p[4] = V(c.x + r * 0.85, c.y - r * 0.1, c.z - r * 0.2);
      p[3] = V(c.x + r * 0.9, c.y - r * 0.35, c.z + r * 0.15);
      p[2] = V(c.x + r * 0.8, c.y - r * 0.55, c.z + r * 0.4);
      p[1] = V(c.x + r * 0.5, c.y - r * 0.7, c.z + r * 0.5);
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
    // the SAME pixel at a different depth — exactly what a webcam hands you
    samePixel(target, dz) {
      const cam = window.__lab.camera;
      const d0 = target.z - cam.position.z, d1 = d0 + dz, k = d0 === 0 ? 1 : d1 / d0;
      return { x: cam.position.x + (target.x - cam.position.x) * k,
               y: cam.position.y + (target.y - cam.position.y) * k, z: target.z + dz };
    },
    clone(p) { return p ? p.map(q => ({ x: q.x, y: q.y, z: q.z })) : null; },
    feed(l, r) { L.AVSYNC.ovPose = null; L.AVSYNC.ovPacks = { L: this.clone(l), R: this.clone(r) }; },
    ball() { const b = window.__lab.basket.ball; return { x: b.sphere.pos.x, y: b.sphere.pos.y, z: b.sphere.pos.z }; },
    radius() { const b = window.__lab.basket.ball; return b.radius * b.userS; },
    palmDist(pack) {
      const b = window.__lab.basket.ball, c = b.sphere.pos;
      let n = 0, x = 0, y = 0, z = 0;
      for (const i of [0, 5, 9, 17]) { x += pack[i].x; y += pack[i].y; z += pack[i].z; n++; }
      return Math.hypot(x / n - c.x, y / n - c.y, z / n - c.z);
    },
  };
});
const stat = () => page.evaluate(() => {
  const B = window.__lab.basket, s = B.stats(), p = B.ball.sphere.pos;
  return { ...s, pos: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)], on: B.on,
           r: +(B.ball.radius * B.ball.userS).toFixed(3), authored: B.ball.radius,
           tris: B.ball.mesh.geometry.index ? B.ball.mesh.geometry.index.count / 3 : B.ball.mesh.geometry.attributes.position.count / 3,
           textured: !!B.ball.mesh.material.map };
});
const out = {};
out.band = await page.evaluate(() => {
  const L = window.__lab;
  // the collider the hand mesh conforms to — its band is what stops a finger
  // deep inside the ball being flung onto the surface and smeared flat
  const c = L.basket.ball.collider;
  return c && c.band;
});
out.rest = await stat();
await shot('1-rest');

// (a) FAR: a hand well outside the approach zone must not disturb it
await page.evaluate(() => {
  const W = window.__bp, c = W.ball();
  W.feed(W.open(c.x + 1.4, c.y - 0.5, c.z + 0.2), null);
});
await sleep(900);
out.far = await stat();

// (a2) PRESENT BUT NOT REACHING: a hand parked inside the zone must not drag
//      the ball to itself — that half of the glue was the worst of it
await page.evaluate(() => {
  const W = window.__bp, c = W.ball();
  window.__park = W.samePixel({ x: c.x + 0.24, y: c.y - 0.1, z: c.z }, 0.3);
  W.feed(W.open(window.__park.x, window.__park.y, window.__park.z), null);
});
await sleep(300);
const parkFrom = await stat();
await sleep(1400);
out.parked = await stat();
out.parkedMoved = +Math.hypot(out.parked.pos[0] - parkFrom.pos[0], out.parked.pos[1] - parkFrom.pos[1],
                              out.parked.pos[2] - parkFrom.pos[2]).toFixed(3);
await page.evaluate(() => { window.__bp.feed(null, null); });
await sleep(600);

// (b) REACH: the hand actually travels toward it (from outside the zone, 35 cm
//     off in depth — the case the screenshot shows). The ball closes the gap.
out.approachStart = await page.evaluate(() => {
  const W = window.__bp, c = W.ball();
  window.__reach0 = W.samePixel({ x: c.x + 0.55, y: c.y - 0.3, z: c.z }, 0.35);
  window.__reach1 = W.samePixel({ x: c.x + 0.12, y: c.y - 0.06, z: c.z }, 0.35);
  const pack = W.open(window.__reach0.x, window.__reach0.y, window.__reach0.z);
  const gap = W.palmDist(pack);                 // measured BEFORE the ball can react
  W.feed(pack, null);
  return { gap: +gap.toFixed(3), zone: window.__lab.basket.ball.zone };
});
for (let k = 1; k <= 18; k++) {
  await page.evaluate(k => {
    const W = window.__bp, a = window.__reach0, b = window.__reach1, t = k / 18;
    W.feed(W.open(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t), null);
  }, k);
  await sleep(45);
}
await sleep(900);
out.approachEnd = await page.evaluate(() => ({
  gap: +window.__bp.palmDist(window.__lab.AVSYNC.packs.L).toFixed(3), zone: window.__lab.basket.ball.zone,
  held: !!window.__lab.basket.ball.hold }));
await shot('2-came-to-hand');

// (c) a hand ON it takes it — no pose; then it travels with the hand
await page.evaluate(() => {
  const W = window.__bp, c = W.ball();
  window.__c0 = c;
  W.feed(W.cup(c, W.radius()), null);
});
await sleep(500);
out.grab = await stat();
out.grabDetail = await page.evaluate(() => {
  const B = window.__lab.basket.ball, pack = window.__lab.AVSYNC.packs.L;
  const c = B.sphere.pos, R = B.radius * B.userS;
  let behind = 0, front = 0, on = 0;
  for (let i = 0; i < 21; i++) {
    const q = pack[i]; if (!q) continue;
    const dz = q.z - c.z;
    if (dz < -R * 0.15) behind++; else if (dz > R * 0.15) front++;
    if (Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) < R + 0.03) on++;
  }
  return { held: !!B.hold, type: B.hold && B.hold.type, zone: B.zone, behind, front, on };
});
await shot('3-held');
for (let k = 1; k <= 16; k++) {
  await page.evaluate(k => {
    const W = window.__bp, c = window.__c0;
    W.feed(W.cup({ x: c.x - 0.26 * k / 16, y: c.y + 0.2 * k / 16, z: c.z }, W.radius()), null);
  }, k);
  await sleep(45);
}
await sleep(200);
out.carry = await page.evaluate(() => {
  const B = window.__lab.basket.ball, c = B.sphere.pos;
  return { held: !!B.hold, moved: +Math.hypot(c.x - window.__c0.x, c.y - window.__c0.y).toFixed(3),
           gap: +window.__bp.palmDist(window.__lab.AVSYNC.packs.L).toFixed(3) };
});
await shot('4-carried');
await page.evaluate(() => { window.__beforeY = window.__lab.basket.ball.sphere.pos.y; });

// (d) OPEN YOUR HAND IN PLACE → it drops (gravity), and it does not jump back
const beforeOpen = await page.evaluate(() => {
  const B = window.__lab.basket.ball;
  return { y: +B.sphere.pos.y.toFixed(3), held: !!B.hold };
});
await page.evaluate(() => {
  const W = window.__bp, B = window.__lab.basket.ball, c = B.sphere.pos;
  // take the hand off it — dei_full.html releases the moment the contact test fails
  W.feed(W.open(c.x + 0.55, c.y - 0.35, c.z + 0.1), null);
});
await sleep(250);
out.opened = await page.evaluate(() => ({ held: !!window.__lab.basket.ball.hold }));
await sleep(900);
out.release = await page.evaluate(() => {
  const B = window.__lab.basket.ball;
  return { held: !!B.hold, y: +B.sphere.pos.y.toFixed(3), fell: +(window.__beforeY - B.sphere.pos.y).toFixed(3) };
});
await shot('4b-dropped');

// (e) THE HAND-STOP: with one hand carrying it, drive the OTHER through it
await page.evaluate(() => { window.__bp.feed(null, null); });
await sleep(700);
await page.evaluate(() => {
  const W = window.__bp, c = W.ball();
  window.__hold = c;
  W.feed(W.cup(c, W.radius()), null);
});
await sleep(600);
await page.evaluate(() => { window.__maxPush = 0; window.__sawAvoid = false; });
for (let k = 1; k <= 22; k++) {
  await page.evaluate(k => {
    const W = window.__bp, c = W.ball(), r = W.radius();
    const depth = Math.min(1, k / 12) * (r + 0.05);
    W.feed(W.cup(window.__hold, r), W.open(c.x, c.y, c.z + r + 0.07 - depth));
    const L = window.__lab, B = L.basket.ball;
    const drawn = L.AVSYNC.packs && L.AVSYNC.packs.R, fed = L.AVSYNC.ovPacks.R;
    if (drawn && fed) window.__maxPush = Math.max(window.__maxPush, Math.abs(drawn[0].z - fed[0].z));
    if (B.avoiding || B.avoidingHold) window.__sawAvoid = true;
  }, k);
  await sleep(50);
}
await sleep(250);
out.stop = await page.evaluate(() => {
  const L = window.__lab, B = L.basket.ball, pack = L.AVSYNC.packs.R;
  const c = B.sphere.pos, R = B.radius * B.userS;
  const RAD = [0.034, 0.024, 0.020, 0.017, 0.015, 0.022, 0.017, 0.015, 0.013, 0.022, 0.017, 0.015, 0.013, 0.021, 0.016, 0.014, 0.012, 0.019, 0.015, 0.013, 0.011];
  const palm = Math.hypot(pack[0].x - pack[9].x, pack[0].y - pack[9].y, pack[0].z - pack[9].z) || 0.204;
  let deepest = 0;
  for (let i = 0; i < 21; i++) deepest = Math.min(deepest, Math.hypot(pack[i].x - c.x, pack[i].y - c.y, pack[i].z - c.z) - R - RAD[i] * (palm / 0.204));
  return { pushed_mm: +(window.__maxPush * 1000).toFixed(1), deepest_mm: +(deepest * 1000).toFixed(2),
           skin_mm: +(B.resistSkin * 1000).toFixed(2), avoiding: window.__sawAvoid };
});
await shot('5-other-hand-stopped');

// (f) the 5-PIXEL gate tracks depth, it is not a constant
out.gate = await page.evaluate(() => {
  const L = window.__lab, B = L.basket.ball, cam = L.camera;
  const H = L.renderer ? (L.renderer.domElement.clientHeight || 900) : 900;
  const at = d => 5 * (2 * Math.tan(cam.fov * Math.PI / 360) * d) / H;
  return { live_mm: +(B.resistSkin * 1000).toFixed(2),
           expect_mm: +(at(cam.position.distanceTo(B.sphere.pos)) * 1000).toFixed(2),
           at1m_mm: +(at(1) * 1000).toFixed(2), at4m_mm: +(at(4) * 1000).toFixed(2) };
});

// (g) OCCLUSION: markers in the same depth buffer — red ones sit behind the ball
out.occlusion = await page.evaluate(() => {
  const L = window.__lab, T3 = L.THREE, B = L.basket.ball, pack = L.AVSYNC.packs.L;
  let grp = L.scene.getObjectByName('__probeJoints');
  if (!grp) { grp = new T3.Group(); grp.name = '__probeJoints'; L.scene.add(grp); }
  grp.clear();
  const c = B.sphere.pos, R = B.radius * B.userS;
  let behind = 0, front = 0, on = 0;
  for (let i = 0; i < 21; i++) {
    const q = pack[i]; if (!q) continue;
    const dz = q.z - c.z;
    const mm = new T3.Mesh(new T3.SphereGeometry(0.016, 12, 8), new T3.MeshBasicMaterial({ color: dz < 0 ? 0xff3b6b : 0x40e0ff }));
    mm.position.set(q.x, q.y, q.z); grp.add(mm);
    if (dz < -R * 0.15) behind++; else if (dz > R * 0.15) front++;
    if (Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z) < R + 0.04) on++;
  }
  L.camera.position.set(c.x + 0.3, c.y + 0.18, c.z + 0.8); L.camera.lookAt(c); L.camera.updateMatrixWorld();
  return { behind, front, on };
});
await sleep(400);
await shot('6-occlusion-markers');
await page.evaluate(() => {
  const L = window.__lab, g = L.scene.getObjectByName('__probeJoints');
  if (g) { g.clear(); L.scene.remove(g); }
  window.__bp.feed(null, null);
});
await sleep(300);

// (h) both hands pinching = resize
const beforeScale = (await stat()).scale;
await page.evaluate(() => {
  const W = window.__bp, c = W.ball();
  window.__p = c;
  W.feed(W.pinch(c.x - 0.12, c.y, c.z), W.pinch(c.x + 0.12, c.y, c.z));
});
await sleep(300);
for (let k = 1; k <= 12; k++) {
  await page.evaluate(k => {
    const W = window.__bp, p = window.__p, d = 0.12 + 0.14 * k / 12;
    W.feed(W.pinch(p.x - d, p.y, p.z), W.pinch(p.x + d, p.y, p.z));
  }, k);
  await sleep(45);
}
await sleep(300);
out.scaled = await stat();
await page.evaluate(() => { window.__bp.feed(null, null); });
await shot('7-resized');

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
           resting: Math.abs(rec.ball.sphere.pos.y - rec.ball.radius * rec.ball.userS) < 0.02,
           attract: !!rec.ball.attract, grabNear: !!rec.ball.grabNear };
});
await sleep(300);
out.engineStrip = await page.evaluate(() => ({
  label: document.getElementById('engAvCtlLbl').textContent,
  buttons: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent),
}));
await shot('8-engine');

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const R = out;
const checks = {
  'the scanned ball spawns (textured, 4.5k tris)': R.rest.on && R.rest.textured && R.rest.tris > 3000,
  'authored at a real basketball radius': Math.abs(R.rest.authored - 0.12) < 0.005,
  'gravity is on: it rests on its floor': Math.abs(R.rest.pos[1] - R.far.pos[1]) < 0.01 && R.rest.vel.y === 0,
  'a hand parked near it does NOT drag it around': R.parkedMoved < 0.02,
  'a hand outside the approach zone leaves it alone': R.far.zone === 'far' && Math.hypot(R.far.pos[0] - R.rest.pos[0], R.far.pos[1] - R.rest.pos[1]) < 0.02,
  'REACH: the ball closes the gap to the hand itself': R.approachEnd.gap < R.approachStart.gap - 0.15,
  'even though the hand is 35 cm off in depth': R.approachEnd.gap < R.rest.r + 0.14,
  'a hand ON it takes it — no pose required': R.grabDetail.held && R.grabDetail.type === 'near',
  'it is really in the hand (joints on the ball)': R.grabDetail.on >= 5,
  'the hand straddles it in depth, so parts are hidden': R.occlusion.behind >= 2 && R.occlusion.front >= 2,
  'it travels with the hand': R.carry.held && R.carry.moved > 0.15 && R.carry.gap < R.rest.r + 0.14,
  'take your hand off it and it lets go': beforeOpen.held && !R.release.held,
  'and it FALLS — gravity, not glue': R.release.fell > 0.05,
  'and it does not jump straight back into the hand': !R.release.held,
  'the conform only wraps the outer skin (no splattered fingers)': R.rest.collider === true && R.band === 0.022,
  'the OTHER hand is STOPPED by it': R.stop.pushed_mm > 5,
  'and ends flush, never inside': R.stop.deepest_mm > -2,
  'avoidance was in charge': R.stop.avoiding === true,
  'the skin is 5 px at the ball depth': Math.abs(R.gate.live_mm - R.gate.expect_mm) < 0.05,
  'and it is a PIXEL gate, not a constant': R.gate.at4m_mm > R.gate.at1m_mm * 3.5,
  'both hands pinching resize it': R.scaled.scale > beforeScale * 1.25,
  'the live sphere is published as a game object': !!R.rest.shape && R.rest.shape.type === 'sphere' && R.rest.shape.radius > 0,
  'engine: spawns, listed, rests on the floor': R.engine.spawned && R.engine.listed && R.engine.resting,
  'engine: runs the same DEI approach + contact': R.engine.attract && R.engine.grabNear,
  'engine: its strip appears': /BASKETBALL/.test(R.engineStrip.label) && R.engineStrip.buttons.some(t => /drop/.test(t)),
  'no page errors': errors.length === 0,
};
for (const [k, v] of Object.entries(checks)) console.log((v ? '  ok   ' : '  FAIL ') + k);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'BASKETBALL PROBE OK' : 'BASKETBALL PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
