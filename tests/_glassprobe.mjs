// GLASS SLIME probe — mpbrowser mirror lane. Contracts:
//   · spawns as GLASS: rigid transmission sphere, softness 0, mirror BACKDROP, env map
//   · MESH-TRUE shape: PropHull + stats() (mass, volume, bbox, hull json) any moment;
//     conform collider streams so fingers wrap it
//   · SEEK: z-bias to contact depth; a cupping hand draws it into the pocket; hand never pushed
//   · RESISTANCE: an open hand cannot pass into it and does not grab it
//   · SCALE: UI ± drives mesh, physics radius, collider radius and mass (∝ s³)
//   · MAKE IT SLIME: the SAME mass at the SAME spot becomes a particle CLOUD (cloud()
//     = every particle, every frame), rigidity RAMPS (no cut), the surface is re-meshed
//     live (thousands of tris), it drapes onto a hand under it and clings when that hand
//     lifts, drips where nothing holds it, keeps the glass transmission
//   · MAKE IT GLASS: the cloud pulls back into the sphere lane · lens uniform · no errors
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK|404/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 }); await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await new Promise(r => setTimeout(r, 500));
await page.click('#slimeBtn');
await page.waitForFunction(() => window.__lab.slime.on && window.__lab.slime.mesh, { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));
const shotDir = process.env.SHOT_DIR || 'tests/out'; import('fs').then(f => f.mkdirSync(shotDir, { recursive: true }));
const shots = (async () => { const seen = new Set(); while (true) { await new Promise(r => setTimeout(r, 150)); let tag = null; try { tag = await page.evaluate(() => window.__probeShot); } catch { break; } if (tag && !seen.has(tag)) { seen.add(tag); await page.screenshot({ path: shotDir + '/glass_' + tag + '.png' }); } if (tag === 'done') break; } })();
const out = await page.evaluate(async () => {
  const T3 = window.__lab.THREE, G = window.__lab.slime, S = window.__lab.S;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  const open = (x, y, z) => {                                  // closure ~0 (fingers extended, in the screen plane)
    const p = mk(V(x, y, z));
    p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
    p[5] = V(x + 0.035, y + 0.04, z); p[17] = V(x - 0.035, y + 0.04, z);
    for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.16, z);
    p[4] = V(x + 0.1, y, z);
    return p;
  };
  const cup = (x, y, z) => {                                   // fingers curling to wrap (closure ~0.5)
    const p = mk(V(x, y, z));
    p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
    p[5] = V(x + 0.035, y + 0.04, z); p[17] = V(x - 0.035, y + 0.04, z);
    for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.075, z + 0.06);
    p[4] = V(x + 0.07, y, z + 0.02);
    return p;
  };
  const flat = (x, y, z, k = 2.2) => {                         // palm-up hand lying in the x/z plane (a shelf); k = workspace hand scale
    const p = mk(V(x, y, z));
    const xs = [-0.045, -0.02, 0.005, 0.03];                   // index…pinky columns across x
    const P = (dx, dz) => V(x + dx * k, y, z + dz * k);
    p[0] = P(0, 0.06);
    p[1] = P(-0.04, 0.04); p[2] = P(-0.07, 0.02); p[3] = P(-0.09, 0); p[4] = P(-0.105, -0.02);
    [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach((f, q) => {
      p[f[0]] = P(xs[q], -0.02); p[f[1]] = P(xs[q], -0.055); p[f[2]] = P(xs[q], -0.085); p[f[3]] = P(xs[q], -0.11);
    });
    return p;
  };
  const shift = (pack, dx, dy, dz) => pack.map(q => V(q.x + dx, q.y + dy, q.z + dz));
  const glass = { transmission: G.mat.transmission, ior: +G.mat.ior.toFixed(2), softness: G.softness, state: G.state, phase: G.phase,
                  verts: G.mesh.geometry.getAttribute('position').count, backdrop: !!(G.backdrop && G.backdrop.visible && S.mode === 'mirror'), envMap: !!G.mat.envMap,
                  collider: window.__lab.slimeCol ? window.__lab.slimeCol.active : 'n/a', cloud: G.cloud() };
  // ── SHAPE + STATS any moment ──
  const st = G.stats();
  const r = 0.16, vIdeal = 4 / 3 * Math.PI * r ** 3;
  const stats = { mass: st.mass_kg, volume: st.volume_m3, volErr: +Math.abs(st.volume_m3 - vIdeal) / vIdeal, hullSegs: st.hull && st.hull.segs,
                  hullJson: !!(st.hull && st.hull.json && st.hull.json.segs && st.hull.json.segs.length), bbox: st.bbox };
  // ── BALL DOCTRINE ── let it come to rest on the floor first (gravity is always on)
  await wait(1400);
  const s0 = G.sphere.pos.clone();
  const rest = { onFloor: +Math.abs(s0.y - (G.floorY() + 0.16)).toFixed(3), held: !!G.hold };
  window.__lab.AVSYNC.ovPose = null;
  // (a) an OPEN hand over the ball on screen, 0.35 m nearer: no float, no grab, no depth pull (it is not closing)
  window.__lab.AVSYNC.ovPacks = { L: open(s0.x + 0.02, s0.y, s0.z + 0.35), R: null };
  await wait(700);
  const openHover = { rose: +(G.sphere.pos.y - s0.y).toFixed(3), held: !!G.hold, dz: +Math.abs(G.sphere.pos.z - s0.z).toFixed(3), seek: G.seek };
  // (b) a CLOSING hand over it, 0.35 m nearer: depth (z only) comes to contact distance; the hand never moved; still no grab, no lift
  window.__lab.AVSYNC.ovPacks = { L: cup(s0.x + 0.02, s0.y, s0.z + 0.35), R: null };
  await wait(900);
  const Lz = window.__lab.AVSYNC.packs.L;
  const zBias = { gapNow: +Math.abs(G.sphere.pos.z - (s0.z + 0.35)).toFixed(3), seek: G.seek, handMoved: +Math.abs(Lz[0].z - (s0.z + 0.35)).toFixed(3),
                  rose: +(G.sphere.pos.y - s0.y).toFixed(3), held: !!G.hold };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null }; await wait(300);
  // (c) BACK OF HAND / fingers curled AWAY: palm-region joints touch one side, fingertips curl off the other way → nothing
  const B = G.sphere.pos.clone();                              // r = 0.16 from the stats block above
  const around = (side, fingersOn) => {                        // palm joints on +z of the ball; fingers on −z (wrapping) or curled away
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
  window.__lab.AVSYNC.ovPacks = { L: around(1, false), R: null };
  await wait(500);
  const backHand = { held: !!G.hold, hold: G.hold ? G.hold.type : null, moved: +G.sphere.pos.distanceTo(B).toFixed(3) };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null }; await wait(200);
  // (d) WRAP: palm on one side, fingers closed round the far side → held; lift the hand → it comes; open the fingers → released, falls
  const B2 = G.sphere.pos.clone(); B.copy(B2);
  let wrapPack = around(1, true);
  window.__lab.AVSYNC.ovPacks = { L: wrapPack, R: null };
  await wait(300);
  const wrapGrab = { held: !!G.hold, type: G.hold ? G.hold.type : null };
  for (let k = 1; k <= 15; k++) { window.__lab.AVSYNC.ovPacks = { L: shift(wrapPack, 0, 0.18 * k / 15, 0), R: null }; await wait(33); }
  wrapPack = shift(wrapPack, 0, 0.18, 0);
  await wait(400);
  const wrapLift = { rose: +(G.sphere.pos.y - B2.y).toFixed(3), held: !!G.hold };
  // open: the finger joints leave the far side (palm joints STAY touching)
  const opened = wrapPack.map((q, i) => ([6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20].includes(i) ? V(q.x, q.y, q.z - 0.15) : q));
  window.__lab.AVSYNC.ovPacks = { L: opened, R: null };
  await wait(120);
  const yOpen = G.sphere.pos.y, heldAfterOpen = !!G.hold;
  await wait(500);
  const release = { heldAfterOpen, fell: +(yOpen - G.sphere.pos.y).toFixed(3), heldLater: !!G.hold };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null }; await wait(900);
  // (e) HOLDING POSE → CRADLE: a palm held UP beside the ball (fingers out, slightly curled,
  //     thumb up) draws it across into the pocket; it rides the hand up; tilt the palm
  //     sideways and move off → it falls
  const cupHand = (x, y, z, upAxis) => {                       // palm-up hand: fingers forward (−z), 'up' = the inner-palm side
    const p = mk(V(x, y, z + 0.1));
    const U = (dx, dz, up) => upAxis === 'y' ? V(x + dx, y + up, z + dz) : V(x - up, y + dx, z + dz);   // 'x': rolled 90° — palm faces −x
    p[0] = U(0, 0.1, 0); p[9] = U(0, -0.1, 0); p[5] = U(0.045, -0.09, 0); p[13] = U(-0.02, -0.095, 0); p[17] = U(-0.06, -0.085, 0);
    const cols = { 6: 0.045, 10: 0, 14: -0.02, 18: -0.06 };
    for (const [pip, dx] of Object.entries(cols)) { const b = +pip; p[b] = U(dx, -0.13, 0.03); p[b + 1] = U(dx, -0.16, 0.06); p[b + 2] = U(dx, -0.18, 0.09); }
    p[1] = U(0.05, 0.06, 0.01); p[2] = U(0.08, 0.02, 0.03); p[3] = U(0.1, -0.02, 0.05); p[4] = U(0.11, -0.05, 0.07);
    return p;
  };
  const F = G.floorY(), Bc = G.sphere.pos.clone();
  const hx = Bc.x + 0.28, hy = F + 0.03, hz = Bc.z - 0.06;
  let cupPack = cupHand(hx, hy, hz, 'y');
  window.__lab.AVSYNC.ovPacks = { L: cupPack, R: null };
  await wait(1200);
  const pocket = G._pose.left.pocket.clone();
  const cradle = { pose: G._pose.left.pose, ny: +G._pose.left.n.y.toFixed(2), closure: +G._pose.left.closure.toFixed(2),
                   dxz: +Math.hypot(G.sphere.pos.x - pocket.x, G.sphere.pos.z - pocket.z).toFixed(3), dy: +(G.sphere.pos.y - pocket.y).toFixed(3),
                   cradle: G.cradle, held: !!G.hold, seek: G.seek, y0: +G.sphere.pos.y.toFixed(3) };
  const liftTrace = [];
  for (let k = 1; k <= 15; k++) { window.__lab.AVSYNC.ovPacks = { L: shift(cupPack, 0, 0.2 * k / 15, 0), R: null }; await wait(33); if (k % 3 === 0) liftTrace.push({ k, pocketY: +G._pose.left.pocket.y.toFixed(3), ballY: +G.sphere.pos.y.toFixed(3), cradle: G.cradle, seek: G.seek, held: !!G.hold }); }
  cupPack = shift(cupPack, 0, 0.2, 0);
  await wait(400);
  const cradleLift = { rose: +(G.sphere.pos.y - cradle.y0).toFixed(3), cradle: G.cradle, held: !!G.hold, pocketY: +G._pose.left.pocket.y.toFixed(3), ballY: +G.sphere.pos.y.toFixed(3), liftTrace };
  // tilt the palm sideways (inner side now +x) and move the hand off
  let sidePack = cupHand(hx, hy + 0.2, hz, 'x');
  window.__lab.AVSYNC.ovPacks = { L: sidePack, R: null };
  await wait(100);
  const cradleAfterTilt = G.cradle, yTiltStart = G.sphere.pos.y;
  for (let k = 1; k <= 10; k++) { window.__lab.AVSYNC.ovPacks = { L: shift(sidePack, 0.35 * k / 10, 0, 0), R: null }; await wait(33); }
  await wait(600);
  const cradleRelease = { cradleAfterTilt, fell: +(cradleLift.ballY - G.sphere.pos.y).toFixed(3), yTiltStart: +yTiltStart.toFixed(3), cradleLater: G.cradle, held: !!G.hold, yEnd: +G.sphere.pos.y.toFixed(3), floor: +G.floorY().toFixed(3) };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null }; await wait(900);
  // (f) CLIP: shrink it, thumb tip and index tip on opposite sides → held; open the thumb → released
  document.getElementById('slimeSizeDn').click(); document.getElementById('slimeSizeDn').click();
  await wait(600);
  const rc = 0.16 * G.userS, C = G.sphere.pos.clone();
  const clipPack = (() => {
    const p = mk(V(C.x, C.y - 0.3, C.z + 0.4));
    p[0] = V(C.x, C.y - rc - 0.25, C.z); p[9] = V(C.x, C.y - rc - 0.05, C.z);      // palm BELOW the ball (outside it)
    p[4] = V(C.x + rc + 0.015, C.y, C.z); p[3] = V(C.x + rc + 0.05, C.y - 0.01, C.z);
    p[8] = V(C.x - rc - 0.013, C.y, C.z); p[7] = V(C.x - rc - 0.045, C.y + 0.01, C.z);
    return p;
  })();
  window.__lab.AVSYNC.ovPacks = { L: clipPack, R: null };
  await wait(300);
  const clipGrab = { held: !!G.hold, type: G.hold ? G.hold.type : null, userS: +G.userS.toFixed(2) };
  window.__lab.AVSYNC.ovPacks = { L: clipPack.map((q, i) => (i === 3 || i === 4 ? V(q.x + 0.08, q.y, q.z) : q)), R: null };
  await wait(120);
  const clipRelease = { held: !!G.hold };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null }; await wait(300);
  document.getElementById('slimeSizeUp').click(); document.getElementById('slimeSizeUp').click();
  await wait(900);
  // ── RESISTANCE: an OPEN hand pressed into the ball is stopped at its surface (and pushes it, never enters it) ──
  const c0 = G.sphere.pos.clone();
  window.__lab.AVSYNC.ovPacks = { L: open(c0.x, c0.y, c0.z), R: null };     // palm centre AT the ball centre
  await wait(600);
  G.mesh.updateWorldMatrix(true, false); G.hull.begin(G.mesh);
  const Lp = window.__lab.AVSYNC.packs.L; let minGap = 9;
  for (let i = 0; i < 21; i++) { const g = G.hull.surfaceDistance(new T3.Vector3(Lp[i].x, Lp[i].y, Lp[i].z)); if (g < minGap) minGap = g; }
  const resist = { minGap: +minGap.toFixed(3), grabbed: !!G.hold };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  await wait(300);
  // ── SCALE by UI ──
  document.getElementById('slimeSizeUp').click();
  await wait(200);
  const st2 = G.stats();
  const scale = { userS: +G.userS.toFixed(3), mesh: +G.mesh.scale.x.toFixed(3), physR: +G.sphere.radius.toFixed(4),
                  colR: window.__lab.slimeCol ? +window.__lab.slimeCol.radius.toFixed(4) : null, massRatio: +(st2.mass_kg / st.mass_kg).toFixed(3) };
  document.getElementById('slimeSizeDn').click();
  await wait(200);
  // ── MAKE IT SLIME onto a flat hand held under the ball (ball lifted back to
  // the workspace first — it has been resting on the floor since the tests above) ──
  G.recenter(); await wait(100);
  const p0 = G.sphere.pos.clone();
  let shelf = flat(p0.x, p0.y - 0.16 - 0.03, p0.z);
  window.__lab.AVSYNC.ovPacks = { L: shelf, R: null };
  await wait(300);
  const p1 = G.sphere.pos.clone();
  shelf = flat(p1.x, p1.y - 0.16 - 0.03, p1.z);                // re-seat the shelf under wherever it is now
  window.__lab.AVSYNC.ovPacks = { L: shelf, R: null };
  G.sphere.vel.set(0, 0, 0); G.sphere.pos.copy(p1);            // at rest, so "moved" measures the hand-over itself
  document.getElementById('slimeMorphBtn').click();
  const meltTrace = [];
  for (let k = 0; k < 5; k++) { await wait(30); const st = G.stats(); meltTrace.push({ t: k, d: +Math.hypot(st.pos[0] - p1.x, st.pos[1] - p1.y, st.pos[2] - p1.z).toFixed(3), seek: G.seek, pose: G._pose.left.pose, rigid: +(1 - G.softness).toFixed(2) }); }
  const e = G.stats();
  const early = { phase: G.phase, state: G.state, softness: +G.softness.toFixed(2), particles: e.particles, cloud: e.cloud, tris: e.tris,
                  moved: +Math.hypot(e.pos[0] - p1.x, e.pos[1] - p1.y, e.pos[2] - p1.z).toFixed(3), sphereHidden: !G.mesh.visible, surfVisible: G.surf.mc.visible, meltTrace };
  await wait(2600);
  const m = G.stats();
  window.__probeShot = 'slime-on-hand';
  // frame cost of the cloud lane: real frames over ~1 s
  const tf = performance.now(); await new Promise(r => { let k = 0; const f = () => (++k < 30 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
  const fps = +(30 / ((performance.now() - tf) / 1000)).toFixed(1);
  const slime = { phase: G.phase, state: G.state, softness: +G.softness.toFixed(2), particles: m.particles, tris: m.tris, verts: m.verts,
                  stuck: m.stuck, stretch: m.stretch, lowest: +m.lowest.toFixed(3), palmY: +(p1.y - 0.19).toFixed(3), centroidY: +m.pos[1].toFixed(3), spanZ: +m.bbox[2].toFixed(3),
                  floorY: +G.floorY().toFixed(3), volume: m.volume_m3, mass: m.mass_kg, transmission: G.mat.transmission, cloudLen: G.cloud().length, fps, ms: m.ms };
  // lift the hand 12 cm over 1 s — the slime clinging to it must come along
  const cy0 = m.pos[1];
  for (let k = 1; k <= 30; k++) { window.__lab.AVSYNC.ovPacks = { L: shift(shelf, 0, 0.12 * k / 30, 0), R: null }; await wait(33); }
  await wait(400);
  const m2 = G.stats();
  window.__probeShot = 'slime-lifted';
  const lift = { centroidRise: +(m2.pos[1] - cy0).toFixed(3), stuck: m2.stuck, lowest: +m2.lowest.toFixed(3) };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  // no hand: it must FALL (gravity owns whatever nothing holds)
  const c1 = G.stats().pos[1];
  await wait(1500);
  const m3 = G.stats();
  const fall = { drop: +(c1 - m3.pos[1]).toFixed(3), lowest: +m3.lowest.toFixed(3), floorY: +G.floorY().toFixed(3) };
  document.querySelector('#slimeLensRow [data-lens="ball-lens"]').click();
  const lens = G.mat.userData.lens.mode.value;
  // ── MAKE IT GLASS ──
  document.getElementById('slimeMorphBtn').click();
  await wait(3500);
  const reglass = { phase: G.phase, state: G.state, softness: +G.softness.toFixed(3), sphereVisible: G.mesh.visible, surfVisible: G.surf.mc.visible, cloud: G.cloud() };
  window.__probeShot = 'done';
  return { glass, stats, rest, openHover, zBias, backHand, wrapGrab, wrapLift, release, cradle, cradleLift, cradleRelease, clipGrab, clipRelease, resist, scale, early, slime, lift, fall, lens, reglass };
});
await shots;
await browser.close();
console.log(JSON.stringify(out, null, 1));
const fail = [];
const g = out.glass;
if (g.transmission < 0.99 || g.softness !== 0 || g.state !== 'glass' || g.phase !== 'sphere' || g.cloud !== null) fail.push('did not spawn as rigid transmission glass: ' + JSON.stringify(g));
if (!g.backdrop) fail.push('mirror backdrop plane not showing (room cannot pass through)');
if (!g.envMap) fail.push('no live reflection env map');
if (g.collider !== true) fail.push('conform collider not streaming (fingers cannot wrap the ball): ' + g.collider);
if (!out.stats.hullJson || !(out.stats.mass > 0)) fail.push('no live shape/mass stats: ' + JSON.stringify(out.stats));
if (out.stats.volErr > 0.15) fail.push('stats volume off from a sphere by ' + (out.stats.volErr * 100).toFixed(0) + '%');
if (out.rest.onFloor > 0.02 || out.rest.held) fail.push('ball did not come to rest on the floor under gravity: ' + JSON.stringify(out.rest));
if (out.openHover.rose > 0.01 || out.openHover.held || out.openHover.dz > 0.02) fail.push('an OPEN hand over the ball floated / grabbed / pulled it: ' + JSON.stringify(out.openHover));
if (Math.abs(out.zBias.gapNow - 0.18) > 0.05) fail.push('DEPTH BIAS: a closing hand should bring the ball to contact depth (0.18), got ' + out.zBias.gapNow);
if (out.zBias.handMoved > 0.01) fail.push('DEPTH BIAS pushed the HAND instead: ' + out.zBias.handMoved);
if (out.zBias.rose > 0.01 || out.zBias.held) fail.push('DEPTH BIAS lifted or grabbed the ball (must be z only): ' + JSON.stringify(out.zBias));
if (out.backHand.held || out.backHand.moved > 0.02) fail.push('BACK OF HAND / fingers curled away must not grab or carry: ' + JSON.stringify(out.backHand));
if (!out.wrapGrab.held || out.wrapGrab.type !== 'wrap') fail.push('fingers WRAPPED round the ball did not pick it up: ' + JSON.stringify(out.wrapGrab));
if (out.wrapLift.rose < 0.1 || !out.wrapLift.held) fail.push('a wrapped ball did not come with the lifting hand: ' + JSON.stringify(out.wrapLift));
if (out.release.heldAfterOpen || out.release.heldLater || out.release.fell < 0.08) fail.push('OPENING the fingers did not release the ball (must drop): ' + JSON.stringify(out.release));
if (!out.cradle.pose) fail.push('HOLDING POSE not recognised (palm up, fingers out): ' + JSON.stringify(out.cradle));
if (out.cradle.dxz > 0.05 || out.cradle.cradle !== 'left') fail.push('ball did not come across into the held-up palm pocket: ' + JSON.stringify(out.cradle));
if (out.cradleLift.rose < 0.12 || out.cradleLift.cradle !== 'left') fail.push('cradled ball did not ride the hand up: ' + JSON.stringify(out.cradleLift));
if (out.cradleRelease.cradleAfterTilt || (out.cradleRelease.fell < 0.08 && out.cradleRelease.yEnd - (out.cradleRelease.floor + 0.16) > 0.02)) fail.push('tilting the palm away did not let the ball roll off / fall: ' + JSON.stringify(out.cradleRelease));
if (!out.clipGrab.held || out.clipGrab.type !== 'clip') fail.push('thumb+finger CLIP did not pick it up: ' + JSON.stringify(out.clipGrab));
if (out.clipRelease.held) fail.push('opening the clip did not release the ball');
if (out.resist.minGap < -0.006) fail.push('RESISTANCE: open hand passed INTO the ball: minGap ' + out.resist.minGap);
if (out.resist.grabbed) fail.push('an OPEN hand must not grab the ball');
if (Math.abs(out.scale.userS - 1.25) > 0.01 || Math.abs(out.scale.mesh - 1.25) > 0.01) fail.push('UI scale did not apply: ' + JSON.stringify(out.scale));
if (Math.abs(out.scale.physR - 0.2) > 0.002 || (out.scale.colR !== null && Math.abs(out.scale.colR - 0.2) > 0.002)) fail.push('scale did not reach physics/conform radius: ' + JSON.stringify(out.scale));
if (Math.abs(out.scale.massRatio - 1.953) > 0.05) fail.push('mass did not scale with volume (expected ×1.953): ' + out.scale.massRatio);
if (out.early.phase !== 'cloud' || !out.early.sphereHidden || !out.early.surfVisible) fail.push('MAKE IT SLIME did not hand over to the cloud: ' + JSON.stringify(out.early));
if (out.early.meltTrace[0].d > 0.02) fail.push('the mass jumped on melt (must start where the ball was): first frame ' + out.early.meltTrace[0].d);
if (out.early.softness > 0.6) fail.push('rigidity CUT instead of ramping (' + out.early.softness + ' at 150ms)');
if (out.early.cloud !== out.early.particles || out.early.particles < 300) fail.push('cloud() is not the full particle set: ' + JSON.stringify(out.early));
if (out.slime.softness < 0.9 || out.slime.state !== 'slime') fail.push('did not reach slime: ' + JSON.stringify(out.slime));
if (out.slime.tris < 1500) fail.push('surface too coarse / not re-meshed: ' + out.slime.tris + ' tris');
if (out.slime.stuck < 15) fail.push('slime is not clinging to the hand under it: stuck ' + out.slime.stuck);
if (out.slime.centroidY < out.slime.palmY - 0.05) fail.push('slime fell through/off the hand: ' + JSON.stringify(out.slime));
if (out.slime.transmission < 0.99) fail.push('lost the glass transparency while slime');
if (out.slime.cloudLen !== out.slime.particles * 3) fail.push('cloud() length mismatch');
if (out.lift.centroidRise < 0.03) fail.push('slime did not come along with the lifting hand (adhesion): rose ' + out.lift.centroidRise);
if (out.fall.drop < 0.08) fail.push('with no hand, gravity did not take it: dropped ' + out.fall.drop);
if (out.lens !== 2) fail.push('ball-lens mode not applied to the shader: ' + out.lens);
if (out.reglass.phase !== 'sphere' || out.reglass.state !== 'glass' || !out.reglass.sphereVisible || out.reglass.surfVisible || out.reglass.cloud !== null) fail.push('MAKE IT GLASS did not hand back to the sphere: ' + JSON.stringify(out.reglass));
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ glass slime works — stats, conform, seek, resistance, scale, melt→cloud, drape+cling+lift, drip, re-glass, lens');
