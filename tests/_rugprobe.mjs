// 🧶 CLOTH RUG probe — both lanes of mpbrowser, in a real browser.
// MIRROR: spawn → it lies flat on the holo table · a palm UNDER it lifts and
// DRAPES it (the lattice bends round the fingers, flush, never through) · a
// closing hand carries it and opening drops it · both hands pinching resize it
// · a hand driven into the sheet is STOPPED (the pack moves, not the cloth).
// ENGINE: 🧶 Rug spawns, is listed, its strip appears, 📌 hang makes it fall
// into folds. Screenshots per beat in PROBE_SHOTS.   needs: npm run serve
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const URL = process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html';   // PROBE_URL: check a PUBLISHED copy too
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
const shot = n => page.screenshot({ path: path.join(SP, 'rug-' + n + '.png') });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 });
await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await sleep(600);

// ───────────────────────── MIRROR ─────────────────────────
await page.click('#rugBtn');
await page.waitForFunction(() => window.__lab.rug.on && window.__lab.rug.piece, { timeout: 60000 });
await sleep(1200);

await page.evaluate(() => {
  const L = window.__lab, T3 = L.THREE, R = L.rug;
  window.__rug = {
    world(i) { const s = R.piece.sim; return new T3.Vector3(s.x[i * 3], s.x[i * 3 + 1], s.x[i * 3 + 2]).applyMatrix4(R.piece.group.matrixWorld); },
    box() { const b = new T3.Box3(); const s = R.piece.sim; for (let i = 0; i < s.n; i++) b.expandByPoint(this.world(i)); return b; },
    centre() { return this.box().getCenter(new T3.Vector3()); },
    lowest() { let y = Infinity; const s = R.piece.sim; for (let i = 0; i < s.n; i++) y = Math.min(y, this.world(i).y); return y; },
    // a palm-up hand lying in the x/z plane, fingers spread — the shelf you lift cloth with
    flat(x, y, z, closure = 0, k = 1) {
      const V = (a, b, c) => ({ x: a, y: b, z: c });
      const p = new Array(21).fill(0).map(() => V(x, y, z));
      const P = (dx, dz, dy = 0) => V(x + dx * k, y + dy, z + dz * k);
      p[0] = P(0, 0.07); p[9] = P(0, -0.02, closure * 0.05);
      p[1] = P(-0.045, 0.045); p[2] = P(-0.075, 0.025); p[3] = P(-0.095, 0.005); p[4] = P(-0.105, -0.015, closure * 0.05);
      const xs = [-0.045, -0.018, 0.009, 0.036];
      [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach((f, q) => {
        p[f[0]] = P(xs[q], -0.01); p[f[1]] = P(xs[q], -0.045, closure * 0.02);
        p[f[2]] = P(xs[q], -0.07 + closure * 0.03, closure * 0.045); p[f[3]] = P(xs[q], -0.09 + closure * 0.06, closure * 0.07);
      });
      return p;
    },
    pinch(x, y, z) {
      const V = (a, b, c) => ({ x: a, y: b, z: c });
      const p = new Array(21).fill(0).map(() => V(x, y, z));
      p[0] = V(x, y - 0.1, z); p[9] = V(x, y - 0.02, z);
      p[5] = V(x + 0.035, y - 0.03, z); p[17] = V(x - 0.035, y - 0.03, z);
      p[4] = V(x, y, z); p[8] = V(x + 0.004, y, z);          // thumb tip on index tip
      for (const i of [12, 16, 20]) p[i] = V(x, y - 0.06, z + 0.03);
      return p;
    },
    clone(p) { return p ? p.map(q2 => ({ x: q2.x, y: q2.y, z: q2.z })) : null; },
    feed(L2, R2) { window.__lab.AVSYNC.ovPose = null; window.__lab.AVSYNC.ovPacks = { L: this.clone(L2), R: this.clone(R2) }; },
    // a real FIST: fingertips curled back to the palm (closure → 1)
    fist(x, y, z) {
      const V = (a, b, c) => ({ x: a, y: b, z: c });
      const p = new Array(21).fill(0).map(() => V(x, y, z));
      p[0] = V(x, y, z + 0.05); p[9] = V(x, y, z - 0.02);
      p[5] = V(x - 0.04, y, z - 0.015); p[13] = V(x + 0.012, y, z - 0.02); p[17] = V(x + 0.038, y, z - 0.015);
      const cols = [-0.04, -0.014, 0.012, 0.038];
      [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach((f, k) => {
        p[f[1]] = V(x + cols[k], y + 0.02, z - 0.045);
        p[f[2]] = V(x + cols[k], y + 0.035, z - 0.03);
        p[f[3]] = V(x + cols[k], y + 0.03, z + 0.005);      // tip back over the palm
      });
      p[1] = V(x - 0.05, y, z + 0.02); p[2] = V(x - 0.06, y + 0.01, z - 0.005);
      p[3] = V(x - 0.05, y + 0.02, z - 0.02); p[4] = V(x - 0.035, y + 0.025, z - 0.03);
      return p;
    },
  };
});

const stat = () => page.evaluate(() => {
  const R = window.__lab.rug, s = R.piece.sim, W = window.__rug;
  const b = W.box(), sz = b.getSize(new window.__lab.THREE.Vector3());
  return { on: R.on, nodes: s.n, contacts: s.contacts, grabbed: s.grabbed, held: { L: !!s.holds.L, R: !!s.holds.R },
           scale: +R.piece.group.scale.x.toFixed(3), resist_mm: +(R.resistD * 1000).toFixed(1),
           lowest: +W.lowest().toFixed(3), centre: W.centre().toArray().map(v => +v.toFixed(3)),
           size: sz.toArray().map(v => +v.toFixed(3)), tableY: +R.tableY.toFixed(3),
           wire: R.piece.wire.visible, skinVerts: R.piece.skin.mesh.geometry.attributes.position.count };
});
const out = {};
out.rest = await stat();
await shot('1-rest');

// (a) a flat palm UNDER the rug, rising: the sheet must DRAPE over it
await page.evaluate(() => {
  const W = window.__rug, c = W.centre();
  window.__start = { x: c.x, y: W.lowest() - 0.12, z: c.z };
  W.feed(W.flat(window.__start.x, window.__start.y, window.__start.z, 0));
});
await sleep(500);
for (let k = 1; k <= 14; k++) {
  await page.evaluate(k => { const W = window.__rug, s = window.__start; W.feed(W.flat(s.x, s.y + 0.16 * k / 14, s.z, 0)); }, k);
  await sleep(60);
}
await sleep(700);
out.drape = await stat();
out.drapeDepth = await page.evaluate(() => {
  // in the SIM's own frame and with its own radii: how deep does any joint sit
  // inside the sheet, and how many joints are actually touching it
  const R = window.__lab.rug, P = R.piece, s = P.sim, H = P.hands.L;
  if (!H || !H.present) return null;
  const sc = P.group.scale.x || 1;
  let worst = 0, touch = 0;
  for (let j = 0; j < 21; j++) {
    const c = s.contact(H.joints[j], H.radii[j] + 0.04, {});
    if (!c) continue;
    const pen = H.radii[j] - c.gap;                 // > 0 = inside the surface
    if (pen > -0.004) touch++;
    worst = Math.max(worst, pen);
  }
  return { deepest_mm: +(worst * sc * 1000).toFixed(1), touching: touch };
});
await shot('2-drape');

// (b) a CLOSING hand on the sheet grabs it; lifting carries it; opening drops it
await page.evaluate(() => {
  const W = window.__rug, c = W.centre();
  window.__g = { x: c.x, y: W.lowest() + 0.005, z: c.z };
  W.feed(W.fist(window.__g.x, window.__g.y, window.__g.z));
});
await sleep(400);
out.grab = await stat();
for (let k = 1; k <= 16; k++) {
  await page.evaluate(k => { const W = window.__rug, g = window.__g; W.feed(W.fist(g.x, g.y + 0.3 * k / 16, g.z)); }, k);
  await sleep(50);
}
await sleep(500);
out.carry = await stat();
await shot('3-carry');
await page.evaluate(() => { const W = window.__rug, g = window.__g; W.feed(W.flat(g.x, g.y + 0.3, g.z, 0)); });   // fingers open = let go
await sleep(700);
out.drop = await stat();

// (c) BOTH HANDS PINCHING = resize
await page.evaluate(() => { window.__rug.feed(null, null); });
await sleep(900);
const before = await stat();
await page.evaluate(() => {
  const W = window.__rug, c = W.centre();
  window.__p = { y: c.y + 0.02, z: c.z, x: c.x };
  W.feed(W.pinch(c.x - 0.12, window.__p.y, c.z), W.pinch(c.x + 0.12, window.__p.y, c.z));
});
await sleep(400);
for (let k = 1; k <= 12; k++) {
  await page.evaluate(k => { const W = window.__rug, p = window.__p; const d = 0.12 + 0.16 * k / 12; W.feed(W.pinch(p.x - d, p.y, p.z), W.pinch(p.x + d, p.y, p.z)); }, k);
  await sleep(50);
}
await sleep(400);
out.scaleUp = await stat();
await shot('4-pinch-scale');
await page.evaluate(() => { window.__rug.feed(null, null); });
await sleep(400);

// (d) a hand pressed DOWN onto the rug where it cannot yield (it is on the
//     table) is STOPPED — the drawn pack moves, the cloth does not sink
await page.click('#rugDropBtn');                       // flat on the table again, known geometry
await sleep(900);
await page.evaluate(() => {
  const W = window.__rug, c = W.centre();
  window.__pen = { x: c.x, y: c.y + 0.12, z: c.z };
  W.feed(W.flat(window.__pen.x, window.__pen.y, window.__pen.z, 0));
});
await sleep(400);
await page.evaluate(() => { window.__maxResist = 0; window.__maxMoved = 0; });
for (let k = 1; k <= 26; k++) {
  await page.evaluate(k => {
    const W = window.__rug, p = window.__pen, y = p.y - 0.15 * Math.min(1, k / 12);
    W.feed(W.flat(p.x, y, p.z, 0));
    const L = window.__lab, drawn = L.AVSYNC.packs && L.AVSYNC.packs.L;
    window.__maxResist = Math.max(window.__maxResist, L.rug.resistD);
    if (drawn) window.__maxMoved = Math.max(window.__maxMoved, drawn[9].y - y);
  }, k);
  await sleep(45);
}
await sleep(200);
out.stop = await page.evaluate(() => {
  // the DRAWN hand (what the rigs render) must not be inside the cloth
  const L = window.__lab, R = L.rug, P = R.piece, s = P.sim, sc = P.group.scale.x || 1;
  const pk = L.AVSYNC.packs.L;
  const inv = new L.THREE.Matrix4().copy(P.group.matrixWorld).invert();
  let deepest = 0;
  for (let j = 0; j < 21; j++) {
    const lp = new L.THREE.Vector3(pk[j].x, pk[j].y, pk[j].z).applyMatrix4(inv);
    const c = s.contact(lp, P.hands.L.radii[j] + 0.04, {});
    if (c) deepest = Math.max(deepest, (P.hands.L.radii[j] - c.gap) * sc);
  }
  return { packMoved_mm: +(window.__maxMoved * 1000).toFixed(1), deepest_mm: +(deepest * 1000).toFixed(1),
           sheetY: +s.x[1].toFixed(4) };
});
await shot('5-hand-stopped');
await page.evaluate(() => { window.__rug.feed(null, null); });

// (e) UI: lattice toggle
await page.click('#rugWireBtn'); await sleep(300);
out.wireOn = await page.evaluate(() => window.__lab.rug.piece.wire.visible);
await shot('6-lattice');
await page.click('#rugWireBtn'); await sleep(200);

// ───────────────────────── ENGINE ─────────────────────────
try {
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 60000 });
await sleep(700);
await page.click('#engSpawnRow [data-sp="rug"]');
await page.waitForFunction(() => window.__eng && window.__eng.rugs && window.__eng.rugs.size > 0, { timeout: 90000 });
await sleep(1400);
out.engine = await page.evaluate(() => {
  const E = window.__eng, g = E.objects.find(o => o.userData.eng.type === 'rug');
  const rec = E.rugs.get(g.userData.eng.id);
  return { spawned: !!g, listed: [...document.querySelectorAll('.engRow')].some(r => /🧶/.test(r.textContent)),
           nodes: rec.piece.sim.n, y: +g.position.y.toFixed(3), skinTris: rec.piece.skin.mesh.geometry.index ? rec.piece.skin.mesh.geometry.index.count / 3 : 0 };
});
await page.evaluate(() => { const E = window.__eng; E.select(E.objects.find(o => o.userData.eng.type === 'rug')); });
await sleep(400);
out.engineStrip = await page.evaluate(() => ({
  label: document.getElementById('engAvCtlLbl').textContent,
  buttons: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent),
}));
await shot('7-engine');
// 📌 hang: pin the far edge and let it fold under its own weight
await page.evaluate(() => { [...document.querySelectorAll('#engAvCtl .opt')].find(b => /hang/.test(b.textContent)).click(); });
await sleep(2200);
out.engineHang = await page.evaluate(() => {
  const E = window.__eng, g = E.objects.find(o => o.userData.eng.type === 'rug');
  const s = E.rugs.get(g.userData.eng.id).piece.sim;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < s.n; i++) { lo = Math.min(lo, s.x[i * 3 + 1]); hi = Math.max(hi, s.x[i * 3 + 1]); }
  let worst = 0;
  for (let c = 0; c < s.nStruct; c++) {
    const a = s.cA[c] * 3, b = s.cB[c] * 3;
    worst = Math.max(worst, Math.hypot(s.x[a] - s.x[b], s.x[a + 1] - s.x[b + 1], s.x[a + 2] - s.x[b + 2]) / s.cL[c]);
  }
  return { drop: +(hi - lo).toFixed(3), stretch: +worst.toFixed(3) };
});
await page.evaluate(() => {
  const E = window.__eng, g = E.objects.find(o => o.userData.eng.type === 'rug');
  const b = new window.__lab.THREE.Box3().setFromObject(E.rugs.get(g.userData.eng.id).piece.group);
  const c = b.getCenter(new window.__lab.THREE.Vector3());
  E.orbit.target.copy(c); E.camera.position.copy(c).add(new window.__lab.THREE.Vector3(1.4, 0.8, 1.8)); E.camera.lookAt(c); E.orbit.update();
});
await sleep(300);
await shot('8-engine-hanging');
} catch (e) { out.engineError = String(e).slice(0, 300); }

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const R = out;
const checks = {
  'spawns with the 2880-node lattice + 71k skin': R.rest.on && R.rest.nodes === 2880 && R.rest.skinVerts > 60000,
  'starts FLAT on the table': R.rest.size[1] < 0.02,
  'a palm under it makes contact': R.drape.contacts > 0,
  'flush: the hand is not inside the weave': R.drapeDepth && R.drapeDepth.deepest_mm < 6,
  'many joints actually touching': R.drapeDepth && R.drapeDepth.touching > 4,
  'the hand LIFTS it': R.drape.lowest > R.rest.lowest + 0.005 || R.drape.size[1] > 0.02,
  'a closing hand grabs it': R.grab.grabbed > 0,
  'it is carried': R.carry.held.L && R.carry.size[1] > 0.12,
  'opening lets go': !R.drop.held.L,
  'both hands pinching resize it': R.scaleUp.scale > before.scale * 1.3,
  'a hand pressed into it is STOPPED': R.stop.packMoved_mm > 3,
  'and ends up flush, not inside': R.stop.deepest_mm < 4,
  'lattice toggle': R.wireOn,
  'engine: spawns + listed + same lattice': R.engine.spawned && R.engine.listed && R.engine.nodes === 2880,
  'engine: selection strip': /RUG/.test(R.engineStrip.label) && R.engineStrip.buttons.some(t => /lattice/.test(t)),
  'engine: hangs in folds without stretching': R.engineHang.drop > 0.25 && R.engineHang.stretch < 1.08,
  'no page errors': errors.length === 0 && !out.engineError,
};
for (const [k, v] of Object.entries(checks)) console.log((v ? '  ok   ' : '  FAIL ') + k);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'RUG PROBE OK' : 'RUG PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
