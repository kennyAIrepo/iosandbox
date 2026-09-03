// verify LABBOW — grab-based bow & arrow mirror overlay on MESH-TRUE touch
// (PropHull capsule chains vs the hand's 21 joint spheres — the basketball
// doctrine). Contracts:
//   · NO GLUE: an open hand attaches nothing; released objects stay put
//   · NO TELE-GRAB: a closed fist NEAR but not TOUCHING the surface takes
//     nothing (shape-true gating — the old anchor-radius would have grabbed)
//   · TOUCH RESPONSE: joints pressing into the free prop SHOVE it (bounded)
//   · real grabs anywhere on the wood / shaft; tail→string nocks; curled
//     fingers at the nock = draw grip; opening the curl shoots instantly
//   · two-hand pinch = scale (DEI basketball gesture); hull json portable
// Dev server on :3333 required.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1400,900', '--no-sandbox', '--use-gl=angle',
         '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 });
await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await new Promise(r => setTimeout(r, 500));
await page.click('#bowBtn');
await page.waitForFunction(() => window.__lab.labBow.on && window.__lab.labBow.grp && window.__lab.labBow.arrow, { timeout: 120000 });
const btnOn = await page.evaluate(() => document.getElementById('bowBtn').textContent);

const out = await page.evaluate(async () => {
  const T3 = window.__lab.THREE;
  const B = window.__lab.labBow;
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  const hand = (cx, cy, cz, tips) => {
    const p = mk(V(cx, cy, cz));
    p[0] = V(cx, cy - 0.05, cz); p[9] = V(cx, cy + 0.05, cz);
    p[5] = V(cx + 0.035, cy + 0.04, cz); p[17] = V(cx - 0.035, cy + 0.04, cz);
    for (const i of [8, 12, 16, 20]) p[i] = tips(cx, cy, cz);
    p[4] = V(cx + 0.06, cy, cz);   // thumb clear of the tips — a fist is NOT a pinch
    return p;
  };
  const fist = (x, y, z) => hand(x, y, z, (cx, cy, cz) => V(cx + 0.02, cy - 0.02, cz + 0.02));   // closure ~1
  const open = (x, y, z) => {                                    // closure ~0, pinch wide
    const p = hand(x, y, z, (cx, cy, cz) => V(cx, cy + 0.16, cz));
    p[8] = V(x + 0.1, y + 0.16, z);                              // index far from thumb
    return p;
  };
  const gripW = () => {
    B.mesh.updateWorldMatrix(true, false);
    return B.rig.gripLocal.clone().applyMatrix4(B.mesh.matrixWorld);
  };
  window.__lab.AVSYNC.ovPose = null;
  // ── 0. PRE-LOADED: the arrow arrives already ON the string ──
  B.mesh.updateWorldMatrix(true, false);
  const nk0 = B.rig.nock(new T3.Vector3()); B.mesh.localToWorld(nk0);
  const preLoaded = { nocked: B.nocked, atNock: +B.arrow.position.distanceTo(nk0).toFixed(3),
                      hookCollider: window.__lab.nockCol.active };
  // ── HULL: the shape json travels with the props ──
  const hull = {
    bowSegs: B.hull ? B.hull.segs.length : 0,
    arrSegs: B.aHull ? B.aHull.segs.length : 0,
    json: !!(B.hull && B.hull.toJSON().segs.length >= 6),
    gripInside: B.hull ? +B.hull.begin(B.mesh).surfaceDistance(gripW()).toFixed(3) : 9,
  };
  // ── 1. NO-GLUE + TOUCH RESPONSE (bow): an OPEN hand on the grip attaches
  // nothing — but its joints pressing the wood SHOVE the bow (bounded) ──
  const g0 = gripW();
  const p0 = B.grp.position.clone();
  window.__lab.AVSYNC.ovPacks = { L: open(g0.x, g0.y, g0.z), R: null };
  await new Promise(r => setTimeout(r, 450));
  const noGlue = { held: B.held, moved: +B.grp.position.distanceTo(p0).toFixed(3) };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  await new Promise(r => setTimeout(r, 200));
  // ── 2. NO TELE-GRAB: a full FIST 12cm OFF the surface takes NOTHING ──
  const g1 = gripW();
  window.__lab.AVSYNC.ovPacks = { L: fist(g1.x, g1.y, g1.z + 0.12), R: null };
  await new Promise(r => setTimeout(r, 400));
  const noTeleGrab = !B.held;
  // ── 3. GRAB: the FIST ON the wood takes the bow; it follows the hand ──
  window.__lab.AVSYNC.ovPacks = { L: fist(g1.x, g1.y, g1.z), R: null };
  await new Promise(r => setTimeout(r, 400));
  const grabbed = B.held;
  const pG = B.grp.position.clone();
  window.__lab.AVSYNC.ovPacks = { L: fist(g1.x + 0.14, g1.y + 0.08, g1.z), R: null };
  await new Promise(r => setTimeout(r, 450));
  const followed = +B.grp.position.distanceTo(pG).toFixed(3);
  // ── 4. RELEASE: open the fist → let go; bow STAYS where released ──
  window.__lab.AVSYNC.ovPacks = { L: open(g1.x + 0.14, g1.y + 0.28, g1.z), R: null };
  await new Promise(r => setTimeout(r, 350));
  const released = !B.held;
  const pRel = B.grp.position.clone();
  window.__lab.AVSYNC.ovPacks = { L: open(g1.x + 0.6, g1.y + 0.28, g1.z), R: null };
  await new Promise(r => setTimeout(r, 400));
  const stayedPut = +B.grp.position.distanceTo(pRel).toFixed(3);
  // ── 5. arrow: NO-GLUE + TOUCH RESPONSE, then GRAB the shaft. (The arrow
  // ships nocked, so take it off the string first — the free-carry lane is
  // still reachable via the un-nock gesture.) ──
  const A = B.arrow;
  B.nocked = false; B.stringHeld = false;
  A.position.copy(B.arrHome); A.quaternion.identity();
  await new Promise(r => setTimeout(r, 150));
  const a0 = A.position.clone();
  window.__lab.AVSYNC.ovPacks = { L: null, R: open(a0.x, a0.y, a0.z) };
  await new Promise(r => setTimeout(r, 450));
  const arrowNoGlue = { held: B.aHeld, moved: +A.position.distanceTo(a0).toFixed(3) };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  await new Promise(r => setTimeout(r, 200));
  const a1 = A.position.clone();
  window.__lab.AVSYNC.ovPacks = { L: null, R: fist(a1.x, a1.y, a1.z) };
  await new Promise(r => setTimeout(r, 400));
  const arrowGrabbed = B.aHeld;
  window.__lab.AVSYNC.ovPacks = { L: null, R: fist(a1.x, a1.y + 0.12, a1.z) };
  await new Promise(r => setTimeout(r, 450));
  const arrowFollowed = +A.position.distanceTo(a1).toFixed(3);
  // ── 6. NOCK: carry the tail to the string ──
  B.mesh.updateWorldMatrix(true, false);
  const nw = B.rig.nock(new T3.Vector3()); B.mesh.localToWorld(nw);
  window.__lab.AVSYNC.ovPacks = { L: null, R: fist(nw.x, nw.y, nw.z) };
  await new Promise(r => setTimeout(r, 500));
  const nocked = { pin: B.nocked, freed: !B.aHeld, stringHeld: B.stringHeld };
  // ── 7. DRAW: the closed fist at the nock IS the draw grip — pull back ──
  const nr = B.rig.nockRest(new T3.Vector3()); B.mesh.localToWorld(nr);
  const pullW = B.rig.drawDir.clone().transformDirection(B.mesh.matrixWorld);
  const back = nr.clone().addScaledVector(pullW, 0.45 * B.rig.opts.drawMax * B.rig.span * B.s);
  window.__lab.AVSYNC.ovPacks = { L: null, R: fist(back.x, back.y, back.z) };
  await new Promise(r => setTimeout(r, 500));
  const draw = +B.draw.toFixed(2);
  const hudDraw = ((document.getElementById('labBowHud') || {}).textContent || '').includes('draw');
  // STICK: the string's live nock must sit AT the hooking fingers — no gap
  B.mesh.updateWorldMatrix(true, false);
  const nockL = B.rig.nockLive(new T3.Vector3()); B.mesh.localToWorld(nockL);
  const RpD = window.__lab.AVSYNC.packs.R;
  const hookPt = new T3.Vector3(RpD[8].x, RpD[8].y, RpD[8].z)
    .lerp(new T3.Vector3(RpD[12].x, RpD[12].y, RpD[12].z), 0.5);
  const stick = +nockL.distanceTo(hookPt).toFixed(3);
  // ── 8. LOOSE: open the curl → instant shot; fresh arrow floats back in ──
  window.__lab.AVSYNC.ovPacks = { L: null, R: open(back.x, back.y, back.z) };
  await new Promise(r => setTimeout(r, 300));
  const loosed = B.flying.length;
  await new Promise(r => setTimeout(r, 900));
  // the NEXT arrow arrives pre-nocked too — shoot again without re-loading
  B.mesh.updateWorldMatrix(true, false);
  const nk2 = B.rig.nock(new T3.Vector3()); B.mesh.localToWorld(nk2);
  const fresh = { nocked: B.nocked, atNock: B.arrow ? +B.arrow.position.distanceTo(nk2).toFixed(3) : 9 };
  // ── 9. TWO-HAND PINCH = SCALE (the DEI basketball / cube gesture) ──
  const pinchP = (x, y, z) => { const p = mk(V(x, y, z));
    p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
    p[4] = V(x, y, z); p[8] = V(x + 0.005, y, z); return p; };
  const s0 = B.s;
  const g2 = gripW();
  window.__lab.AVSYNC.ovPacks = { L: pinchP(g2.x, g2.y, g2.z), R: pinchP(g2.x + 0.36, g2.y, g2.z) };
  await new Promise(r => setTimeout(r, 300));
  window.__lab.AVSYNC.ovPacks = { L: pinchP(g2.x - 0.09, g2.y, g2.z), R: pinchP(g2.x + 0.45, g2.y, g2.z) };
  await new Promise(r => setTimeout(r, 500));
  const scaleUp = { userS: +B.userS.toFixed(2), grew: B.s > s0 * 1.2, notGrabbed: !B.held && !B.aHeld };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  await new Promise(r => setTimeout(r, 250));
  const scalePersist = B.scal === null && Math.abs(B.userS - scaleUp.userS) < 0.05;
  // ── 10. ON-HANDS EVERYWHERE: the lane stays LIVE in engine POV — the blue
  // holo hands and the bow share the lab scene in every view ──
  const E2 = window.__eng;
  const prev = { on: E2.on, sdk: E2.sdk.on, view: E2.sdk.view };
  E2.on = true; E2.sdk.on = true; E2.sdk.view = 'pov';
  await new Promise(r => setTimeout(r, 250));
  const liveInPov = B.grp.visible && window.__lab.bowCol.active;
  E2.on = prev.on; E2.sdk.on = prev.sdk; E2.sdk.view = prev.view;
  await new Promise(r => setTimeout(r, 200));
  // ── 11. DOUBLE-FIST SUMMON (pic-3): both fists → bow SEATS into the left
  // grasp (grip in the fist, string toward the draw hand); arrow tail-first
  // into the right fist ──
  const zH = B.bowHome.z;
  const FL = { x: -0.1, y: 0.12, z: zH }, FR = { x: -0.1, y: 0.12, z: zH + 0.42 };
  window.__lab.AVSYNC.ovPacks = { L: fist(FL.x, FL.y, FL.z), R: fist(FR.x, FR.y, FR.z) };
  await new Promise(r => setTimeout(r, 450));
  B.mesh.updateWorldMatrix(true, false);
  const gS = B.rig.gripLocal.clone().applyMatrix4(B.mesh.matrixWorld);
  const dS = B.rig.drawDir.clone().transformDirection(B.mesh.matrixWorld);
  const summon = {
    held: B.held, stillLoaded: B.nocked,
    gripAtFist: +gS.distanceTo(new T3.Vector3(FL.x, FL.y, FL.z)).toFixed(3),
    stringToDraw: +dS.dot(new T3.Vector3(0, 0, 1)).toFixed(2),   // toward the RIGHT fist (+z)
  };
  // ── 12. RESISTANCE: an open hand pressed INTO the held bow's wood is
  // STOPPED at the mesh — the rendered hand can never pass through, and the
  // anchored bow stays in the fist instead of being shoved away ──
  window.__lab.AVSYNC.ovPacks = { L: fist(FL.x, FL.y, FL.z), R: open(gS.x, gS.y, gS.z) };
  await new Promise(r => setTimeout(r, 450));
  B.mesh.updateWorldMatrix(true, false);
  B.hull.begin(B.mesh);
  const Rp = window.__lab.AVSYNC.packs.R;
  let minGap = 9;
  for (let i = 0; i < 21; i++) {
    const g = B.hull.surfaceDistance(Rp[i]);
    if (g < minGap) minGap = g;
  }
  const gS2 = B.rig.gripLocal.clone().applyMatrix4(B.mesh.matrixWorld);
  const resist = { minGap: +minGap.toFixed(3), held: B.held,
                   bowStayed: +gS2.distanceTo(new T3.Vector3(FL.x, FL.y, FL.z)).toFixed(3) };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  await new Promise(r => setTimeout(r, 200));
  const colOk = window.__lab.bowCol.active;
  let lights = 0; window.__lab.scene.traverse(o => { if (o.isLight) lights++; });
  const depthOk = B.bowHome.z < -1 && Math.abs(B.arrHome.z - B.bowHome.z) < 0.3;
  const scaleOk = B.s > 0.2 && B.s < 1.2;
  const kinds = k => window.__eng.world.log.filter(e => e.npc === 'user' && e.kind === k).length;
  const logs = { grab: kinds('grab') >= 2, nock: kinds('nock') >= 1, hold: kinds('hold') >= 1,
                 draw: kinds('draw') >= 1, shot: kinds('shot') >= 1,
                 tail: window.__eng.world.log.slice(-5).map(e => e.npc + '/' + e.kind + ': ' + e.msg) };
  window.__lab.AVSYNC.ovPacks = null;
  return { preLoaded, hull, noGlue, noTeleGrab, grabbed, followed, released, stayedPut,
           arrowNoGlue, arrowGrabbed, arrowFollowed, nocked, draw, stick, hudDraw, loosed, fresh,
           colOk, scaleUp, scalePersist, liveInPov, summon, resist, lit: lights >= 2, depthOk, scaleOk,
           scale: +B.s.toFixed(2), logs };
});
await browser.close();

console.log(JSON.stringify({ btnOn, ...out }, null, 2));
const fail = [];
if (!btnOn.includes('REMOVE')) fail.push('lab 🏹 button did not switch to REMOVE state: ' + btnOn);
if (!out.preLoaded.nocked || out.preLoaded.atNock > 0.05) fail.push('arrow not PRE-LOADED on the string at spawn: ' + JSON.stringify(out.preLoaded));
if (!out.preLoaded.hookCollider) fail.push('string/nock hook collider not streaming (fingers slide through the string)');
if (out.hull.bowSegs < 6 || out.hull.arrSegs < 1) fail.push('PropHull not baked (bow/arrow segs): ' + JSON.stringify(out.hull));   // a straight stick bakes to ONE capsule — correct
if (!out.hull.json) fail.push('hull shape-json not serializable');
if (out.hull.gripInside > 0.01) fail.push('hull does not contain the grip point (not mesh-true): ' + out.hull.gripInside);
if (out.noGlue.held) fail.push('GLUE: open hand on the grip must attach NOTHING');
if (out.noGlue.moved < 0.004 || out.noGlue.moved > 0.2) fail.push('TOUCH RESPONSE: open-hand contact should SHOVE the bow (bounded): moved ' + out.noGlue.moved);
if (!out.noTeleGrab) fail.push('TELE-GRAB: a fist 12cm OFF the surface must take nothing (shape-true gating)');
if (!out.grabbed) fail.push('fist ON the wood did not take the bow');
if (out.followed < 0.1) fail.push('held bow did not follow the hand: moved ' + out.followed);
if (!out.released) fail.push('opening the fist did not release the bow');
if (out.stayedPut > 0.03) fail.push('GLUE: released bow must STAY PUT, moved ' + out.stayedPut);
if (out.arrowNoGlue.held) fail.push('GLUE: open hand at the shaft must attach NOTHING');
if (out.arrowNoGlue.moved < 0.004 || out.arrowNoGlue.moved > 0.2) fail.push('TOUCH RESPONSE: open-hand contact should shove the arrow: moved ' + out.arrowNoGlue.moved);
if (!out.arrowGrabbed) fail.push('fist on the shaft did not take the arrow');
if (out.arrowFollowed < 0.08) fail.push('held arrow did not follow the hand: moved ' + out.arrowFollowed);
if (!out.nocked.pin || !out.nocked.freed) fail.push('carrying the tail to the string did not nock: ' + JSON.stringify(out.nocked));
if (out.draw < 0.3 || out.draw > 0.65) fail.push('draw does not track the pull (expected ~0.45): ' + out.draw);
if (!out.hudDraw) fail.push('HUD does not show live draw');
if (out.stick > 0.05) fail.push('GAP: the string peak is not stuck to the pulling fingers: ' + out.stick + 'm off');
if (out.loosed < 1) fail.push('opening the curl did not shoot instantly');
if (!out.fresh.nocked || out.fresh.atNock > 0.05) fail.push('the NEXT arrow did not arrive pre-nocked: ' + JSON.stringify(out.fresh));
if (!out.colOk) fail.push('grip conform collider not streaming');
if (!out.lit) fail.push('LAB UNLIT: flat black silhouettes (no lights)');
if (!out.depthOk) fail.push('DEPTH: props not at the hands\' working depth');
if (!out.scaleOk) fail.push('bow not framing-scaled: s=' + out.scale);
if (out.scaleUp.userS < 1.25 || !out.scaleUp.grew || !out.scaleUp.notGrabbed)
  fail.push('two-hand pinch scale failed: ' + JSON.stringify(out.scaleUp));
if (!out.scalePersist) fail.push('pinch-scale multiplier did not persist after release');
if (!out.liveInPov) fail.push('ON-HANDS: the lane must stay LIVE in engine POV (blue holo hands own the bow)');
if (!out.summon.held || !out.summon.stillLoaded) fail.push('DOUBLE-FIST SUMMON did not seat+hold the loaded bow: ' + JSON.stringify(out.summon));
if (out.summon.gripAtFist > 0.06) fail.push('SUMMON: grip not IN the left fist: ' + out.summon.gripAtFist + 'm off');
if (out.summon.stringToDraw < 0.6) fail.push('SUMMON: string side not facing the draw hand: dot ' + out.summon.stringToDraw);
if (out.resist.minGap < -0.006) fail.push('RESISTANCE: the hand passed INTO the held bow mesh: minGap ' + out.resist.minGap);
if (!out.resist.held || out.resist.bowStayed > 0.12)
  fail.push('RESISTANCE: the anchored bow was shoved/dropped by the pressing hand: ' + JSON.stringify(out.resist));
for (const k of ['grab', 'nock', 'hold', 'draw', 'shot'])
  if (!out.logs[k]) fail.push('world log missing "' + k + '" — tail: ' + out.logs.tail.join(' | '));
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ LABBOW mesh-true touch works — hull contact, no glue, no tele-grab, shove, grab, nock, draw, loose');
process.exit(fail.length ? 1 : 0);
