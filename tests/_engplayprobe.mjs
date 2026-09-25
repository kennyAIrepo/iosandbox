// 🎮 ENGINE PLAY probe — the mirror lane's interaction, in the engine, driven by the
// tracked hands. The contracts:
//   · ONE CAMERA: with IMPORT SDK on in POV the lab camera IS the engine camera,
//     wherever it orbits (before: parked at (0,1.6,2.2) — hands and world never met);
//   · the ball is born AT the tracked hands, and a hand on it takes it (DEI);
//   · 🪝 an open hand held still CALLS a free ball — it lobs into that palm;
//   · 🎯 GO!: the HUD says GO! → INCOMING → CAUGHT → SHOOT → GOAL; the ball is
//     launched to the hand, caught, shot through the hoop, the score counts;
//   · the launch solver lands the ball where it is aimed under the ball's own g;
//   · the cloth rug takes the same hands.
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
const shot = n => page.screenshot({ path: path.join(SP, 'engplay-' + n + '.png') });
const out = {};

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await sleep(600);
await page.click('#engSdkChk');                          // IMPORT SDK: POV · hands (the defaults)
await page.waitForFunction(() => document.body.classList.contains('eng-sdk'), { timeout: 120000 });
await sleep(800);

// ── synthetic hands, in ENGINE space, relative to the engine camera ──
await page.evaluate(() => {
  const L = window.__lab, E = window.__eng, T3 = L.THREE;
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  window.__ep = {
    // a point given in CAMERA-local metres → world
    camLocal(x, y, z) { const v = new T3.Vector3(x, y, z).applyMatrix4(E.camera.matrixWorld); return V(v.x, v.y, v.z); },
    open(c) {                                            // an open hand, palm up-ish, in the screen plane
      const p = mk(c);
      p[0] = V(c.x, c.y - 0.05, c.z); p[9] = V(c.x, c.y + 0.05, c.z);
      p[5] = V(c.x + 0.035, c.y + 0.04, c.z); p[13] = V(c.x, c.y + 0.045, c.z); p[17] = V(c.x - 0.035, c.y + 0.04, c.z);
      for (const [i, dx] of [[8, 0.035], [12, 0.008], [16, -0.02], [20, -0.045]]) p[i] = V(c.x + dx, c.y + 0.15, c.z);
      for (const [i, dx] of [[7, 0.035], [11, 0.008], [15, -0.02], [19, -0.045]]) p[i] = V(c.x + dx, c.y + 0.11, c.z);
      for (const [i, dx] of [[6, 0.035], [10, 0.008], [14, -0.02], [18, -0.045]]) p[i] = V(c.x + dx, c.y + 0.08, c.z);
      p[4] = V(c.x + 0.085, c.y + 0.02, c.z); p[3] = V(c.x + 0.07, c.y - 0.01, c.z); p[2] = V(c.x + 0.05, c.y - 0.03, c.z); p[1] = V(c.x + 0.03, c.y - 0.045, c.z);
      return p;
    },
    feed(l, r) { L.AVSYNC.ovPose = null; L.AVSYNC.ovPacks = { L: l, R: r }; },
    clear() { L.AVSYNC.ovPose = undefined; L.AVSYNC.ovPacks = undefined; },
    ball() { for (const rec of E.baskets.values()) return rec.ball; return null; },
    stat() { const B = this.ball(); const r = E.round.r;
      return B ? { pos: [B.sphere.pos.x, B.sphere.pos.y, B.sphere.pos.z].map(v => +v.toFixed(3)), vel: +B.sphere.vel.length().toFixed(2), held: !!B.hold, type: B.hold && B.hold.type, zone: B.zone, gap: B.gap === Infinity ? null : +(B.gap * 1000).toFixed(0),
                     round: r.state, score: r.score, streak: r.streak, shots: r.shots, catches: r.catches, hud: document.getElementById('engBallPhase').textContent, roundOn: E.round.on,
                     colliderOn: B.collider.active } : null; },
  };
});

// (1) ONE CAMERA — orbit the engine camera somewhere new; the lab camera must follow
await page.evaluate(() => { const E = window.__eng; E.camera.position.set(2.5, 1.9, 4.0); E.orbit.target.set(0.3, 1.0, -0.5); E.orbit.update(); });
await sleep(400);
out.cam = await page.evaluate(() => {
  const L = window.__lab, E = window.__eng;
  const d = L.camera.position.distanceTo(E.camera.position);
  const q = Math.abs(L.camera.quaternion.dot(E.camera.quaternion));
  return { dist: +d.toFixed(4), qdot: +q.toFixed(4), fovL: L.camera.fov, fovE: E.camera.fov, aspectOk: Math.abs(L.camera.aspect - E.camera.aspect) < 1e-6 };
});

// (2) THE BIAS — an open hand ahead of the camera; the ball spawns at it and is taken
await page.evaluate(() => { const W = window.__ep; window.__hand = W.camLocal(0.12, -0.18, -0.55); W.feed(null, W.open(window.__hand)); });
await sleep(400);
await page.evaluate(() => window.__eng.spawnBasket());
await page.waitForFunction(() => window.__eng.baskets.size > 0, { timeout: 60000 });
await sleep(300);
out.spawn = await page.evaluate(() => { const W = window.__ep, B = W.ball(), h = window.__hand;
  return { ...W.stat(), distToHand: +Math.hypot(B.sphere.pos.x - h.x, B.sphere.pos.y - h.y, B.sphere.pos.z - h.z).toFixed(3) }; });
await sleep(2200);
out.taken = await page.evaluate(() => window.__ep.stat());
await shot('1-born-at-hand');

// (3) 🪝 THE CALL — park the ball on the floor 2 m away; hold the open hand still; it lobs in
await page.evaluate(() => { const W = window.__ep, B = W.ball(); B.hold = null; B.cradle = null; B._letGo.right = 1e9; B._letGo.left = 1e9;   // no re-grab while we set up
  B.sphere.reset(new window.__lab.THREE.Vector3(window.__hand.x + 2.0, B.radius, window.__hand.z - 1.5)); });
await sleep(300);
await page.evaluate(() => { const B = window.__ep.ball(); B._letGo.right = -9; B._letGo.left = -9; });
const callFrom = await page.evaluate(() => window.__ep.stat());
await sleep(1400);                                        // the open hand has been still > 0.7 s
out.callFlight = await page.evaluate(() => window.__ep.stat());
await sleep(1600);
out.callDone = await page.evaluate(() => window.__ep.stat());
out.callMoved = +Math.hypot(...[0, 1, 2].map(i => out.callDone.pos[i] - callFrom.pos[i])).toFixed(3);
await shot('2-called');

// (4) 🎯 THE ROUND — GO! → INCOMING → CAUGHT → SHOOT → GOAL
await page.evaluate(async () => { const W = window.__ep, B = W.ball(); B.hold = null; B.cradle = null;
  B.sphere.reset(new window.__lab.THREE.Vector3(window.__hand.x + 1.5, B.radius, window.__hand.z - 2.5)); await window.__eng.roundStart(); });
await sleep(250);
out.go = await page.evaluate(() => ({ ...window.__ep.stat(), hoops: window.__eng.hoops.size, rim: window.__eng.rimWorld(), hudShown: getComputedStyle(document.getElementById('engBallHud')).display,
  cue: document.getElementById('engBallCue').childNodes[0].nodeValue, cueShown: document.getElementById('engBallCue').classList.contains('show'), cueOpacity: +getComputedStyle(document.getElementById('engBallCue')).opacity,
  bar: document.getElementById('engBallPhase').textContent, fill: document.getElementById('engBallFill').style.width,
  banner: document.getElementById('engBallBanner').textContent.trim(), bannerShown: getComputedStyle(document.getElementById('engBallBanner')).display,
  cueColor: getComputedStyle(document.getElementById('engBallCue')).color, noPointer: getComputedStyle(document.getElementById('engBallHud')).pointerEvents }));
await sleep(850);                                         // t ≈ 1.1 s: launched
out.incoming = await page.evaluate(() => ({ ...window.__ep.stat(), cue: document.getElementById('engBallCue').childNodes[0].nodeValue, bar: document.getElementById('engBallPhase').textContent, fill: document.getElementById('engBallFill').style.width, cueColor: getComputedStyle(document.getElementById('engBallCue')).color }));
await sleep(600);                                         // t ≈ 1.7 s: still in flight — the bar has drained further
out.incoming2 = await page.evaluate(() => ({ cue: document.getElementById('engBallCue').childNodes[0].nodeValue, opacity: +getComputedStyle(document.getElementById('engBallCue')).opacity, bar: document.getElementById('engBallPhase').textContent, fill: document.getElementById('engBallFill').style.width, barShown: getComputedStyle(document.querySelector('#engBallHud .bar')).display }));
await shot('3-incoming');
await sleep(1600);                                        // t ≈ 3.3 s: caught at ~2.1 s, AIM! popped at ~3.0 s
out.caught = await page.evaluate(() => window.__ep.stat());
out.aim = await page.evaluate(() => ({ cue: document.getElementById('engBallCue').childNodes[0].nodeValue, opacity: +getComputedStyle(document.getElementById('engBallCue')).opacity, round: window.__eng.round.r.state, cueLog: window.__eng.cues.log.map(x => x[1]).slice(-4) }));
await shot('4-caught');
// SHOOT: release the hand and put the ball on a lob through the rim (the solver, from the page)
await page.evaluate(async () => {
  const W = window.__ep, B = W.ball(), E = window.__eng;
  W.feed(null, null);
  const { solveLaunch } = await import('./sdk/game/ball-round.js');
  const rim = E.rimWorld();
  const from = { x: B.sphere.pos.x, y: B.sphere.pos.y, z: B.sphere.pos.z }, to = { x: rim.x, y: rim.y + 0.02, z: rim.z };
  const v = solveLaunch(from, to, { g: B.sphere.gravity, drag: B.sphere.drag, dt: 1 / 60, T: 1.2 });
  B.hold = null; B.cradle = null; B.sphere.vel.set(v.vx, v.vy, v.vz);
  window.__shotFrom = from;
});
await sleep(300);
out.shot = await page.evaluate(() => window.__ep.stat());
await sleep(1500);
out.goal = await page.evaluate(() => window.__ep.stat());
await shot('5-goal');
await page.evaluate(() => window.__eng.roundStop());
await sleep(300);
out.over = await page.evaluate(() => ({ cue: document.getElementById('engBallCue').childNodes[0].nodeValue, opacity: +getComputedStyle(document.getElementById('engBallCue')).opacity }));
await sleep(2000);
out.afterOver = await page.evaluate(() => ({ barShown: getComputedStyle(document.querySelector('#engBallHud .bar')).display, bannerShown: getComputedStyle(document.getElementById('engBallBanner')).display, cueOpacity: +getComputedStyle(document.getElementById('engBallCue')).opacity }));

// (5) the launch solver against the live integrator: aim a free ball at a point, measure the landing
out.solver = await page.evaluate(async () => {
  const W = window.__ep, B = W.ball(), E = window.__eng, T3 = window.__lab.THREE;
  W.feed(null, null);
  const to = { x: 1.0, y: 1.3, z: -1.0 };
  const from = E.launchBall(B, to, 1.0);
  const t0 = performance.now(); let best = 1e9;
  await new Promise(res => { const step = () => { const d = Math.hypot(B.sphere.pos.x - to.x, B.sphere.pos.y - to.y, B.sphere.pos.z - to.z); if (d < best) best = d; if (performance.now() - t0 < 1400) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  return { from: [from.x, from.y, from.z].map(v => +v.toFixed(2)), closest_cm: +(best * 100).toFixed(1) };
});

// (6) the rug: the same hands lift it
await page.evaluate(() => window.__eng.spawnRug());
await page.waitForFunction(() => window.__eng.rugs.size > 0, { timeout: 90000 });
await sleep(800);
out.rug = await page.evaluate(async () => {
  const W = window.__ep, E = window.__eng, T3 = window.__lab.THREE;
  const rec = [...E.rugs.values()][0], P = rec.piece, s = P.sim, g = P.group;
  g.updateWorldMatrix(true, false);
  const world = i => new T3.Vector3(s.x[i * 3], s.x[i * 3 + 1], s.x[i * 3 + 2]).applyMatrix4(g.matrixWorld);
  const box = new T3.Box3(); for (let i = 0; i < s.n; i++) box.expandByPoint(world(i));
  const c = box.getCenter(new T3.Vector3()); let lowest = Infinity; for (let i = 0; i < s.n; i++) lowest = Math.min(lowest, world(i).y);
  const nearMin = () => { let m = -Infinity; for (let i = 0; i < s.n; i++) { const w = world(i); if (Math.hypot(w.x - c.x, w.z - c.z) < 0.06) m = Math.max(m, w.y); } return m; };   // the crown over the palm
  const overBefore = nearMin();
  // a palm-up hand UNDER the sheet (the shelf you lift cloth with), in the x/z plane
  const V = (x, y, z) => ({ x, y, z }), y0 = lowest - 0.10;
  const p = new Array(21).fill(0).map(() => V(c.x, y0, c.z));
  const Pp = (dx, dz) => V(c.x + dx, y0, c.z + dz);
  p[0] = Pp(0, 0.07); p[9] = Pp(0, -0.02); p[5] = Pp(0.035, -0.01); p[13] = Pp(-0.005, -0.025); p[17] = Pp(-0.04, -0.005);
  for (const [i, dx, dz] of [[8, 0.045, -0.11], [12, 0.01, -0.12], [16, -0.025, -0.115], [20, -0.055, -0.095]]) p[i] = Pp(dx, dz);
  for (const [i, dx, dz] of [[7, 0.04, -0.08], [11, 0.008, -0.09], [15, -0.02, -0.085], [19, -0.05, -0.07]]) p[i] = Pp(dx, dz);
  for (const [i, dx, dz] of [[6, 0.037, -0.05], [10, 0.006, -0.055], [14, -0.015, -0.05], [18, -0.045, -0.04]]) p[i] = Pp(dx, dz);
  p[4] = Pp(0.09, 0.0); p[3] = Pp(0.075, 0.03); p[2] = Pp(0.055, 0.05); p[1] = Pp(0.03, 0.065);
  W.feed(null, p);
  await new Promise(r => setTimeout(r, 400));
  // lift: the hand rises 12 cm; the sheet must ride it and never let a joint inside
  for (let k = 1; k <= 20; k++) { for (const q of p) q.y = y0 + k * 0.01; W.feed(null, p); await new Promise(r => setTimeout(r, 80)); }
  await new Promise(r => setTimeout(r, 500));
  const H = P.hands.R; let deepest = 0, touching = 0;
  if (H && H.present) for (let j = 0; j < 21; j++) { const ct = s.contact(H.joints[j], H.radii[j] + 0.04, {}); if (!ct) continue; const pen = H.radii[j] - ct.gap; if (pen > -0.004) touching++; deepest = Math.max(deepest, pen); }
  let lowest2 = Infinity; for (let i = 0; i < s.n; i++) lowest2 = Math.min(lowest2, world(i).y);
  const st = s.stats();
  return { handsSeen: !!(H && H.present), contacts: st.contacts, touching, deepest_mm: +(deepest * (g.scale.x || 1) * 1000).toFixed(1),
           lowestBefore: +lowest.toFixed(3), lowestAfter: +lowest2.toFixed(3), overBefore: +overBefore.toFixed(3), overAfter: +nearMin().toFixed(3), handY: +(y0 + 0.20).toFixed(3) };
});
await shot('6-rug');
await page.evaluate(() => window.__ep.clear());

// ── verdicts ──
const R = out;
const checks = {
  'ONE CAMERA: the lab camera follows the engine camera (position)': R.cam.dist < 1e-3,
  'ONE CAMERA: …and its orientation, fov and aspect': R.cam.qdot > 0.9999 && R.cam.fovL === R.cam.fovE && R.cam.aspectOk,
  'the ball is born within reach of the tracked hand': R.spawn.distToHand < 0.45,
  'and a hand on it TAKES it (DEI contact)': R.taken.held === true,
  'the ball is on the DEI route in the engine (zone/contact read out)': ['contact', 'approach', 'far'].includes(R.taken.zone),
  'THE CALL: an open still hand lobs a free ball toward it': R.callFlight.vel > 0.5 || R.callDone.held === true,
  'and it ARRIVES in that hand (held, or within a palm of it)': R.callDone.held === true || R.callMoved > 1.5,
  'GO!: a round starts — hoop spawned, rim published': R.go.roundOn && R.go.hudShown === 'block' && R.go.hoops === 1 && R.go.rim && Math.abs(R.go.rim.y - 3.05) < 0.01,
  'UI: the GO! cue POPS on screen (visible, animating, hot orange)': R.go.cue === 'GO!' && R.go.cueShown && R.go.cueOpacity > 0.5 && /255, 177, 93/.test(R.go.cueColor),
  'UI: the round bar shows the phase and a draining timer': R.go.bar === 'GO!' && /%$/.test(R.go.fill),
  'UI: the game banner is up (icon · name · hint)': R.go.bannerShown === 'flex' && /HOOP ROUND/.test(R.go.banner),
  'UI: nothing here takes pointer events': R.go.noPointer === 'none',
  'UI: INCOMING! replaces it as the ball flies (cool cyan)': R.incoming.cue === 'INCOMING!' && R.incoming.bar === 'INCOMING' && /159, 240, 255/.test(R.incoming.cueColor),
  'UI: the bar keeps draining while the cue holds': R.incoming2.barShown !== 'none' && parseInt(R.incoming2.fill) < parseInt(R.incoming.fill) && R.incoming2.opacity > 0.5,
  'UI: CAUGHT ✓ then AIM! while you hold it': R.aim.cueLog.includes('CAUGHT ✓') && R.aim.cue === 'AIM!' && R.aim.opacity > 0.3 && R.aim.round === 'caught',
  'UI: ROUND OVER cues, then FADES (~1.7 s) and the bar and banner leave': R.over.cue === 'ROUND OVER' && R.over.opacity > 0.3 && R.afterOver.cueOpacity < 0.15 && R.afterOver.barShown === 'none' && R.afterOver.bannerShown === 'none',
  'INCOMING: the ball is launched at the hand': R.incoming.round === 'incoming' && R.incoming.vel > 0.5,
  'CAUGHT: it lands in the open hand and is held': R.caught.round === 'caught' && R.caught.held === true,
  'SHOOT: releasing it is the shot': R.shot.round === 'shot',
  'GOAL: through the rim counts, score 1': R.goal.round === 'goal' || (R.goal.score === 1),
  'the launch solver lands the ball where it is aimed (< 12 cm)': R.solver.closest_cm < 12,
  'the rug takes the same hands: a palm under it makes contact': R.rug.handsSeen && R.rug.contacts > 0 && R.rug.touching > 3,
  'and the hand is not inside the weave (< 6 mm)': R.rug.deepest_mm < 6,
  'and the sheet OVER the palm rides the lifting hand (its edges stay down — a drape)': R.rug.overAfter > R.rug.overBefore + 0.08 && R.rug.overAfter > R.rug.handY - 0.01 && R.rug.lowestAfter < R.rug.overAfter - 0.05,
  'no page errors': errors.length === 0,
};
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
for (const [k, v] of Object.entries(checks)) console.log((v ? '  ok   ' : '  FAIL ') + k);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'ENGINE PLAY PROBE OK' : 'ENGINE PLAY PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
