// verify the 🏹 BOW game object: BowRig morph in-engine (string peak, limb flex,
// bit-exact integrity at rest), the SPACE draw→loose keyboard loop, arrow
// ballistics, and the draw meter. Dev server on :3333 required.
import os from 'node:os';
import puppeteer from 'puppeteer-core';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));

await page.click('#engSpawnRow [data-sp="bow"]');
await page.waitForFunction(() => window.__eng.bows && window.__eng.bows.size === 1, { timeout: 60000 });
// the real arrow asset (76MB scan) loads in the background — wait so the shot
// uses it rather than the stick fallback
await page.waitForFunction(() => !!window.__eng.arrowTpl, { timeout: 120000 });
await new Promise(r => setTimeout(r, 300));

// ── morph contracts via the external draw seam (the future gesture input) ──
const morph = await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  const b = window.__eng.bows.get(bow.userData.eng.id);
  const rig = b.rig;
  const P = b.mesh.geometry.getAttribute('position');
  const rest = rig.rest;
  let midV = -1, qV = -1, tipW = -1, gripW = -1;
  for (let v = 0; v < P.count; v++) {
    const t = rig.t[v], w = rig.w[v];
    if (w > 0.9 && Math.abs(t - 0.5) < 0.02 && midV < 0) midV = v;
    if (w > 0.9 && Math.abs(t - 0.25) < 0.02 && qV < 0) qV = v;
    if (w < 0.05 && t > 0.95 && tipW < 0) tipW = v;
    if (w < 0.05 && Math.abs(t - 0.5) < 0.03 && gripW < 0) gripW = v;
  }
  const along = v => (P.array[v * 3] - rest[v * 3]) * rig.drawDir.x
    + (P.array[v * 3 + 1] - rest[v * 3 + 1]) * rig.drawDir.y
    + (P.array[v * 3 + 2] - rest[v * 3 + 2]) * rig.drawDir.z;
  const mag = v => Math.hypot(P.array[v * 3] - rest[v * 3], P.array[v * 3 + 1] - rest[v * 3 + 1], P.array[v * 3 + 2] - rest[v * 3 + 2]);
  window.__eng.bowSetDraw(bow, 0.8);
  const out = {
    classified: rig.stats.stringVerts > 300 && rig.stats.woodVerts > 3000,
    span: +rig.stats.span.toFixed(2),
    midPull: +along(midV).toFixed(3),
    quarterPull: +along(qV).toFixed(3),
    tipFlex: +along(tipW).toFixed(3),
    gripStill: mag(gripW) < 0.005,
  };
  out.peak = out.midPull > 0.4 && out.midPull > out.quarterPull * 1.4;
  out.flexOk = out.tipFlex > 0.03 && out.tipFlex < 0.2;
  // integrity: back to zero must restore the asset bit-exact
  window.__eng.bowSetDraw(bow, 0);
  let maxErr = 0;
  for (let i = 0; i < P.array.length; i++) maxErr = Math.max(maxErr, Math.abs(P.array[i] - rest[i]));
  out.integrity = maxErr === 0;
  window.__eng.bowSetDraw(bow, 0.7);                       // pose for the screenshot
  return out;
});
await new Promise(r => setTimeout(r, 250));
await page.screenshot({ path: SP + '/bow-drawn.png' });
await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  window.__eng.bowSetDraw(bow, 0);
});

// ── keyboard loop: select bow → HOLD SPACE draws → release looses an arrow ──
await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  window.__eng.objects && window.__eng;
  const row = [...document.querySelectorAll('.engRow')].find(r => r.textContent.includes('🏹'));
  row.click();
});
const hintShown = await page.evaluate(() => document.getElementById('engBowHint').style.display !== 'none');
await page.keyboard.down('Space');
await new Promise(r => setTimeout(r, 700));
const during = await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  const b = window.__eng.bows.get(bow.userData.eng.id);
  return { draw: +b.draw.toFixed(2), nocked: !!b.nocked, pct: document.getElementById('engBowPct').textContent };
});
await page.keyboard.up('Space');
await new Promise(r => setTimeout(r, 250));
const shot = await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  const b = window.__eng.bows.get(bow.userData.eng.id);
  return { flying: b.flying.length, draw: +b.draw.toFixed(2),
           realArrow: b.flying[0] ? b.flying[0].mesh.userData.src === 'asset' : false,
           arrowPos: b.flying[0] ? b.flying[0].mesh.position.toArray().map(v => +v.toFixed(2)) : null };
});
await new Promise(r => setTimeout(r, 600));
const after = await page.evaluate(() => {
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  const b = window.__eng.bows.get(bow.userData.eng.id);
  const a = b.flying[0];
  return { draw: +b.draw.toFixed(2), nocked: !!b.nocked,
           moved: a ? +a.mesh.position.distanceTo(new window.__lab.THREE.Vector3(...(window.__probeP0 || a.mesh.position.toArray()))).toFixed(2) : 0,
           arrowPos: a ? a.mesh.position.toArray().map(v => +v.toFixed(2)) : null };
});
// ═══ GESTURE ARCHERY: left fist grabs (bow follows the hand, 6-DoF), open
// hand → gravity drops it to the floor; re-grab; right pinch at the nock →
// drag back = draw; open pinch = loose along where the bow points ═══
const gest = await page.evaluate(async () => {
  const T3 = window.__lab.THREE;
  const bow = window.__eng.objects.find(o => o.userData.eng.type === 'bow');
  const b = window.__eng.bows.get(bow.userData.eng.id);
  const V = (x, y, z) => ({ x, y, z });
  bow.position.set(0, 0, 0); bow.quaternion.identity();
  window.__eng.bowSetDraw(bow, 0); b.hold = false;
  window.__lab.AVSYNC.ovPose = null;                       // activate the override seam
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  const fist = (cx, cy, cz) => {
    const p = mk(V(cx, cy, cz));
    p[0] = V(cx, cy - 0.05, cz); p[9] = V(cx, cy + 0.05, cz);
    p[5] = V(cx + 0.035, cy + 0.04, cz); p[17] = V(cx - 0.035, cy + 0.04, cz);
    for (const i of [8, 12, 16, 20]) p[i] = V(cx + 0.02, cy - 0.02, cz + 0.02);   // curled in
    p[4] = V(cx + 0.06, cy, cz);   // thumb clear of the tips — a fist is NOT a pinch
    return p;
  };
  const open = (cx, cy, cz) => {
    const p = fist(cx, cy, cz);
    for (const i of [8, 12, 16, 20]) p[i] = V(cx, cy + 0.16, cz);                 // extended
    return p;
  };
  b.mesh.updateWorldMatrix(true, false);
  const gl = b.rig.gripLocal.clone().applyMatrix4(b.mesh.matrixWorld);
  // 1. fist at the grip → grab
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: null };
  await new Promise(r => setTimeout(r, 400));
  const grabbed = b.held;
  // 2. raise the hand → the bow follows
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y + 0.35, gl.z), R: null };
  await new Promise(r => setTimeout(r, 500));
  const rose = +bow.position.y.toFixed(2);
  // 3. open the fist → released → gravity drops it to the floor
  window.__lab.AVSYNC.ovPacks = { L: open(gl.x, gl.y + 0.35, gl.z), R: null };
  await new Promise(r => setTimeout(r, 900));
  const dropped = { held: b.held, y: +bow.position.y.toFixed(3) };
  // 4. re-grab, then RIGHT pinch on the string at the nock
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: null };
  await new Promise(r => setTimeout(r, 350));
  b.mesh.updateWorldMatrix(true, false);
  const nr = b.rig.nockRest(new T3.Vector3()); b.mesh.localToWorld(nr);
  const pinch = (px, py, pz) => {
    const p = mk(V(px, py, pz));
    p[0] = V(px, py - 0.05, pz); p[9] = V(px, py + 0.05, pz);
    p[4] = V(px, py, pz); p[8] = V(px + 0.005, py, pz);
    return p;
  };
  const openPinch = (px, py, pz) => { const p = pinch(px, py, pz); p[8] = V(px + 0.09, py, pz); return p; };
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: pinch(nr.x, nr.y, nr.z) };
  await new Promise(r => setTimeout(r, 350));
  const nocked = b.nockPin;
  // 5. drag back along the pull axis → draw follows the pull distance
  const pullW = b.rig.drawDir.clone().transformDirection(b.mesh.matrixWorld);
  const back = nr.clone().addScaledVector(pullW, 0.45);
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: pinch(back.x, back.y, back.z) };
  await new Promise(r => setTimeout(r, 400));
  const draw = +b.draw.toFixed(2);
  const flyBefore = b.flying.length;
  // 6. open the pinch → loose — the arrow flies where the bow points
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: openPinch(back.x, back.y, back.z) };
  await new Promise(r => setTimeout(r, 400));
  const loosed = b.flying.length - flyBefore;
  const aim = loosed ? +b.flying[b.flying.length - 1].vel.clone().normalize()
    .dot(pullW.clone().negate()).toFixed(2) : 0;
  const snapHome = +b.draw.toFixed(2);
  // 7. grip conform collider streams to the lab while the SDK is on, and the
  // hand DEPTH OCCLUDERS stand in for the tracked hands in the engine pass
  window.__eng.sdk.on = true;
  await new Promise(r => setTimeout(r, 150));
  b.mesh.updateWorldMatrix(true, false);
  const glNow = b.rig.gripLocal.clone().applyMatrix4(b.mesh.matrixWorld);
  const colOk = window.__lab.bowCol.active && window.__lab.bowCol.center.distanceTo(glNow) < 0.05;
  // hand depth-occluders are RETIRED (they punched black hand-holes in the
  // sky) — the contract is now that they stay dark
  const occ = !window.__eng.handOcc.grp || !window.__eng.handOcc.grp.visible;
  window.__eng.sdk.on = false;
  // 8. TWO-HAND PINCH = SCALE (DEI basketball gesture) on the engine bow:
  // release it first, then both pinches near the grip, pull apart → bigger
  window.__lab.AVSYNC.ovPacks = { L: open(gl.x, gl.y, gl.z), R: null };
  await new Promise(r => setTimeout(r, 500));
  b.mesh.updateWorldMatrix(true, false);
  const gl2 = b.rig.gripLocal.clone().applyMatrix4(b.mesh.matrixWorld);
  window.__lab.AVSYNC.ovPacks = { L: pinch(gl2.x, gl2.y, gl2.z), R: pinch(gl2.x + 0.3, gl2.y, gl2.z) };
  await new Promise(r => setTimeout(r, 250));
  window.__lab.AVSYNC.ovPacks = { L: pinch(gl2.x, gl2.y, gl2.z), R: pinch(gl2.x + 0.45, gl2.y, gl2.z) };
  await new Promise(r => setTimeout(r, 350));
  const scaled = +bow.scale.x.toFixed(2);
  window.__lab.AVSYNC.ovPacks = null;
  return { grabbed, rose, dropped, nocked, draw, loosed, aim, snapHome, colOk, occ, scaled };
});

// ═══ INTERFACE: tracked user = located presence → 🏹 toggle spawns a floating
// bow+arrow HOLOGRAM within arm's reach → touch grabs the bow (lenient), pinch
// takes the arrow → carry to the string = nock → drag = draw → open = loose;
// pull/aim/shot/landing all land in the world log (the in-process telemetry) ═══
const holo = await page.evaluate(async () => {
  const T3 = window.__lab.THREE;
  const E = window.__eng;
  const V = (x, y, z) => ({ x, y, z });
  const v3 = (x, y, z) => new T3.Vector3(x, y, z);
  // synthetic tracked user at the origin, facing +Z ((L−R shoulder)×up = +Z),
  // wrists in front — the hologram must land AT the hands, sized to the figure
  const P = new Array(33).fill(null);
  P[11] = v3(0.18, 1.42, 0); P[12] = v3(-0.18, 1.42, 0);
  P[23] = v3(0.10, 0.92, 0); P[24] = v3(-0.10, 0.92, 0);
  P[13] = v3(0.30, 1.20, 0.05); P[15] = v3(0.45, 1.05, 0.15);   // L elbow + wrist
  P[14] = v3(-0.30, 1.20, 0.05); P[16] = v3(-0.45, 1.05, 0.15); // R elbow + wrist
  E.ovBodyPts = P;
  await new Promise(r => setTimeout(r, 250));
  const user = { on: E.user.on, pos: E.user.pos.toArray().map(n => +n.toFixed(2)),
                 fwd: E.user.fwd.toArray().map(n => +n.toFixed(2)),
                 height: +E.user.height.toFixed(2),
                 posLogged: E.world.log.some(e => e.npc === 'user' && e.kind === 'pos') };
  // 🏹 spawn with the user live → hologram grip AT the left hand, arrow at the
  // right hand, bow scaled to ~¾ the measured figure height
  const g = await E.spawnBow();
  const b = E.bows.get(g.userData.eng.id);
  b.mesh.updateWorldMatrix(true, false);
  const grip0 = b.rig.gripLocal.clone().applyMatrix4(b.mesh.matrixWorld);
  const spawn = { gripAtLeftHand: +grip0.distanceTo(P[15]).toFixed(2),
                  arrowAtRightHand: b.free ? +b.free.grp.position.distanceTo(P[16]).toFixed(2) : 9,
                  scale: +g.scale.x.toFixed(2), holo: !!b.holo,
                  freeArrow: !!b.free, arrowHolo: !!(b.free && b.free.holo),
                  ghost: (() => { let n = 0; g.traverse(o => { if (o.userData._holoOrig) n++; }); return n > 0; })() };
  await new Promise(r => setTimeout(r, 800));   // first frames stall on GPU upload of the scans
  spawn.floats = Math.abs(g.position.y) > 0.3;                        // elevated, not grounded
  spawn.animates = !!(b.holo && b.holo.t > 0.15);
  const hintDuringHolo = document.getElementById('engBowHint').style.display !== 'none';
  // hand shapes (same synthesis as the gest section)
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  const hand = (cx, cy, cz, tips) => {
    const p = mk(V(cx, cy, cz));
    p[0] = V(cx, cy - 0.05, cz); p[9] = V(cx, cy + 0.05, cz);
    p[5] = V(cx + 0.035, cy + 0.04, cz); p[17] = V(cx - 0.035, cy + 0.04, cz);
    for (const i of [8, 12, 16, 20]) p[i] = tips(cx, cy, cz);
    p[4] = V(cx + 0.06, cy, cz);   // thumb clear of the tips — a fist is NOT a pinch
    return p;
  };
  const fist = (x, y, z) => hand(x, y, z, (cx, cy, cz) => V(cx + 0.02, cy - 0.02, cz + 0.02));
  const reach = (x, y, z) => hand(x, y, z, (cx, cy, cz) => V(cx, cy + 0.083, cz));   // half-open ~0.45
  const pinch = (px, py, pz) => {
    const p = mk(V(px, py, pz));
    p[0] = V(px, py - 0.05, pz); p[9] = V(px, py + 0.05, pz);
    p[4] = V(px, py, pz); p[8] = V(px + 0.005, py, pz);
    return p;
  };
  const openPinch = (px, py, pz) => { const p = pinch(px, py, pz); p[8] = V(px + 0.11, py, pz); return p; };
  // 1. GRAB: a real FIST wrap at the hologram grip takes it (an open or
  // half-open hand must not — the no-glue doctrine)
  b.mesh.updateWorldMatrix(true, false);
  const gl = b.rig.gripLocal.clone().applyMatrix4(b.mesh.matrixWorld);
  window.__lab.AVSYNC.ovPose = null;
  window.__lab.AVSYNC.ovPacks = { L: reach(gl.x, gl.y, gl.z), R: null };   // half-open: no grab
  await new Promise(r => setTimeout(r, 300));
  const notGlued = !b.held;
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: null };
  await new Promise(r => setTimeout(r, 400));
  const touched = { notGlued, held: b.held, holoOff: !b.holo,
                    restored: (() => { let n = 0; g.traverse(o => { if (o.userData._holoOrig) n++; }); return n === 0; })() };
  // 2. RIGHT pinch at the floating arrow's mid → arrow in hand
  const ar = b.free && b.free.grp;
  const mid = ar.position.clone().add(v3(0, 1, 0).applyQuaternion(ar.quaternion).multiplyScalar(0.4 * ar.scale.x));
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: pinch(mid.x, mid.y, mid.z) };
  await new Promise(r => setTimeout(r, 400));
  const arrowHeld = { held: !!(b.free && b.free.held), holoOff: !(b.free && b.free.holo) };
  // 3. carry the pinch to the string → the carried arrow nocks
  b.mesh.updateWorldMatrix(true, false);
  const nw = b.rig.nock(new T3.Vector3()); b.mesh.localToWorld(nw);
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: pinch(nw.x, nw.y, nw.z) };
  await new Promise(r => setTimeout(r, 450));
  const nocked = { pin: b.nockPin, carried: b.nocked === ar, freeCleared: !b.free };
  { // DEBUG: live geometry at the nock step
    b.mesh.updateWorldMatrix(true, false);
    const nk = b.rig.nock(new T3.Vector3()); b.mesh.localToWorld(nk);
    nocked.dbg = { held: b.held, fHeld: !!(b.free && b.free.held),
      pinchToLiveNock: +nw.distanceTo(nk).toFixed(3),
      arrowPos: b.free ? b.free.grp.position.toArray().map(n => +n.toFixed(2)) : null,
      bowPos: g.position.toArray().map(n => +n.toFixed(2)),
      packs: !!(window.__lab.AVSYNC.packs && window.__lab.AVSYNC.packs.R),
      aligned: window.__lab.AVSYNC.packsAligned };
  }
  // 4. drag back along the pull axis → draw + in-process draw log
  const nr = b.rig.nockRest(new T3.Vector3()); b.mesh.localToWorld(nr);
  const pullW = b.rig.drawDir.clone().transformDirection(b.mesh.matrixWorld);
  const back = nr.clone().addScaledVector(pullW, 0.3);      // 0.3m pull on the FIGURE-SCALED bow
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: pinch(back.x, back.y, back.z) };
  await new Promise(r => setTimeout(r, 500));
  const draw = +b.draw.toFixed(2);
  const hudLive = document.getElementById('engBowHint').textContent.includes('draw');
  const flyBefore = b.flying.length;
  // 5. open the fingers → loose; the CARRIED arrow flies; shot + landing logged
  window.__lab.AVSYNC.ovPacks = { L: fist(gl.x, gl.y, gl.z), R: openPinch(back.x, back.y, back.z) };
  await new Promise(r => setTimeout(r, 1400));
  const loosed = b.flying.length - flyBefore >= 1;
  const flew = b.flying.find(a => a.mesh === ar);
  const kinds = k => E.world.log.filter(e => e.npc === 'user' && e.kind === k).length;
  const logs = { grabBow: kinds('grab') >= 2, nock: kinds('nock') >= 1, draw: kinds('draw') >= 1,
                 shot: kinds('shot') >= 1, land: kinds('land') >= 1,
                 tail: E.world.log.slice(-6).map(e => e.npc + '/' + e.kind + ': ' + e.msg) };
  window.__lab.AVSYNC.ovPacks = null;
  E.ovBodyPts = null;
  return { user, spawn, hintDuringHolo, touched, arrowHeld, nocked, draw, hudLive,
           loosed: !!loosed, carriedFlew: !!flew, logs };
});
await browser.close();

console.log(JSON.stringify({ morph, hintShown, during, shot, after, gest, holo }, null, 2));
const fail = [];
if (!holo.user.on || !holo.user.posLogged) fail.push('USER PRESENCE: tracked user not located/logged: ' + JSON.stringify(holo.user));
if (holo.spawn.gripAtLeftHand > 0.25) fail.push('bow grip did not materialize AT the left hand: ' + holo.spawn.gripAtLeftHand + 'm away');
if (holo.spawn.arrowAtRightHand > 0.25) fail.push('arrow did not materialize AT the right hand: ' + holo.spawn.arrowAtRightHand + 'm away');
if (holo.spawn.scale < 0.4 || holo.spawn.scale > 0.9) fail.push('bow not scaled to the figure (expected ~0.71 for a 1.8-unit figure): ' + holo.spawn.scale);
if (!holo.spawn.holo || !holo.spawn.ghost) fail.push('bow did not spawn as a hologram: ' + JSON.stringify(holo.spawn));
if (!holo.spawn.freeArrow || !holo.spawn.arrowHolo) fail.push('no floating arrow at the right hand');
if (!holo.spawn.floats || !holo.spawn.animates) fail.push('hologram not floating/animating: ' + JSON.stringify(holo.spawn));
if (!holo.hintDuringHolo) fail.push('no reach-out hint while the hologram floats');
if (!holo.touched.notGlued) fail.push('GLUE: half-open hand at the hologram grip must take nothing');
if (!holo.touched.held || !holo.touched.holoOff || !holo.touched.restored)
  fail.push('FIST-GRAB failed (held/holoOff/materials): ' + JSON.stringify(holo.touched));
if (!holo.arrowHeld.held || !holo.arrowHeld.holoOff) fail.push('right pinch did not take the floating arrow: ' + JSON.stringify(holo.arrowHeld));
if (!holo.nocked.pin || !holo.nocked.carried || !holo.nocked.freeCleared)
  fail.push('carried arrow did not nock on the string: ' + JSON.stringify(holo.nocked));
if (holo.draw < 0.35 || holo.draw > 0.75) fail.push('hologram-flow draw does not track the pull: ' + holo.draw);
if (!holo.hudLive) fail.push('HUD hint does not show live draw/aim during the gesture draw');
if (!holo.loosed || !holo.carriedFlew) fail.push('sudden release did not shoot the CARRIED arrow');
for (const k of ['grabBow', 'nock', 'draw', 'shot', 'land'])
  if (!holo.logs[k]) fail.push('world log missing "' + k + '" telemetry — tail: ' + holo.logs.tail.join(' | '));
if (!gest.grabbed) fail.push('GRAB: left fist at the grip did not take the bow');
if (gest.rose < 0.25) fail.push('held bow did not follow the hand up: ' + gest.rose);
if (gest.dropped.held || gest.dropped.y !== 0) fail.push('GRAVITY: released bow did not fall to the floor: ' + JSON.stringify(gest.dropped));
if (!gest.nocked) fail.push('right pinch at the nock did not take the string');
if (gest.draw < 0.5 || gest.draw > 0.75) fail.push('gesture draw does not track the pull distance: ' + gest.draw);
if (gest.loosed !== 1) fail.push('opening the pinch did not loose an arrow');
if (gest.aim < 0.9) fail.push('arrow did not fly where the bow points: aim dot ' + gest.aim);
if (gest.snapHome > 0.05) fail.push('string did not snap home after the gesture loose: ' + gest.snapHome);
if (!gest.colOk) fail.push('grip conform collider not streamed to the lab');
if (!gest.occ) fail.push('retired hand depth-occluders came back (black hand-holes in the sky)');
if (gest.scaled < 1.3 || gest.scaled > 1.8) fail.push('engine two-hand pinch scale failed (expected ~1.5): ' + gest.scaled);
if (!morph.classified) fail.push('string/wood classification failed');
if (!morph.peak) fail.push('STRING PEAK wrong: mid ' + morph.midPull + ' vs quarter ' + morph.quarterPull);
if (!morph.flexOk) fail.push('limb flex wrong: ' + morph.tipFlex);
if (!morph.gripStill) fail.push('grip moved — middle must stay put');
if (!morph.integrity) fail.push('INTEGRITY: draw 0 did not restore the asset bit-exact');
if (!hintShown) fail.push('bow hint not shown on select');
if (during.draw < 0.3 || !during.nocked) fail.push('SPACE hold did not draw/nock: ' + JSON.stringify(during));
if (during.pct === '0%') fail.push('draw meter not updating');
if (shot.flying !== 1) fail.push('release did not loose an arrow');
if (!shot.realArrow) fail.push('shot used the stick fallback, not the arrow asset');
if (after.draw > 0.05) fail.push('string did not snap home after release: ' + after.draw);
if (shot.arrowPos && after.arrowPos && shot.arrowPos.every((v, i) => v === after.arrowPos[i])) fail.push('arrow did not fly');
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ bow works — screenshot: bow-drawn.png');
process.exit(fail.length ? 1 : 0);
