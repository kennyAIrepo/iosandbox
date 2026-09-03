// verify the engine view's IMPORT SDK wedge: toggling it boots the lab tracking stack
// (fake camera), forces the beat-game POV framing + mesh isolation, composites the lab
// canvas over the engine, part-switching is instant, and toggling off / leaving the
// engine restores the lab exactly. Needs the dev server on :3333.
import puppeteer from 'puppeteer-core';
import os from 'node:os';
const SP = process.env.PROBE_SHOTS || os.tmpdir();   // screenshot output dir
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
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));

// toggle IMPORT SDK on — boots camera + trackers (fake device); models come from CDN
await page.click('#engSdkChk');
await page.waitForFunction(() => document.body.classList.contains('eng-sdk'), { timeout: 120000 });
await new Promise(r => setTimeout(r, 600));
// engine input must keep working with the SDK on: canvases click-transparent,
// and an engine panel action (spawn) must land
await page.click('#engSpawnRow [data-sp="box"]');
await new Promise(r => setTimeout(r, 300));
const inputOk = await page.evaluate(() => ({
  cPE: getComputedStyle(document.getElementById('c')).pointerEvents,
  ovPE: getComputedStyle(document.getElementById('ov')).pointerEvents,
  spawned: document.querySelectorAll('.engRow').length,          // 3 anchors + 1 box
  trackers: [...document.querySelectorAll('.engRow .nm')].filter(n => n.textContent.includes('tracked')).length,
}));
// anchor gizmo → live tracking offset: nudge the body anchor up, expect TRACK_OFF to follow
const offSync = await page.evaluate(async () => {
  const body = window.__eng.objects.find(o => o.userData.eng && o.userData.eng.sub === 'body');
  body.position.y = body.userData.eng.home[1] + 0.4;
  body.scale.setScalar(1.3);
  body.rotation.y = Math.PI / 2;                                 // rotate the tracked figure 90°
  await new Promise(r => setTimeout(r, 150));                    // a few engLoop ticks
  const off = window.__lab.TRACK_OFF.body;
  const res = { y: +off.y.toFixed(2), s: +off.s.toFixed(2), qy: +off.qy.toFixed(3), qw: +off.qw.toFixed(3) };
  body.position.y = body.userData.eng.home[1]; body.scale.setScalar(1); body.rotation.y = 0;
  await new Promise(r => setTimeout(r, 150));
  return res;
});
// BODY POV CONTRACT: raw MediaPipe world pose (left wrist raised) through
// retarget + the MEASURED povFaceAway normalizer must come out PROPER (real
// left on screen-left, raise on the left limb, shoulder-frame facing agreeing
// with the nose facing) and FACING AWAY from the dolly — whatever convention
// retarget emits. The full 4-state input matrix lives in tests/_povprobe.mjs.
const chirality = await page.evaluate(() => {
  const { bodyPose, povFaceAway, THREE, camera } = window.__lab;
  // raw convention: +x = camera-right = subject's LEFT, +y = down, +z = toward camera
  const P = (x, y, z) => ({ x, y, z });
  const w = new Array(33).fill(0).map(() => P(0, -0.3, 0));
  w[23] = P(0.1, 0, 0); w[24] = P(-0.1, 0, 0);                    // hips (L,R)
  w[11] = P(0.16, -0.5, 0); w[12] = P(-0.16, -0.5, 0);            // shoulders
  w[13] = P(0.34, -0.6, 0); w[14] = P(-0.3, -0.3, 0);             // elbows
  w[15] = P(0.44, -0.8, 0.05); w[16] = P(-0.32, -0.1, 0.05);      // LEFT wrist RAISED, right hangs
  for (const i of [17, 19, 21]) w[i] = P(0.48, -0.85, 0.05);
  for (const i of [18, 20, 22]) w[i] = P(-0.34, -0.05, 0.05);
  w[0] = P(0, -0.68, 0.12);                                        // nose toward camera
  for (const i of [1,2,3,4,5,6,9,10]) w[i] = P(0, -0.66, 0.1);
  w[7] = P(0.06, -0.7, 0.04); w[8] = P(-0.06, -0.7, 0.04);         // ears BEHIND the nose
  w[25] = P(0.1, 0.45, 0); w[26] = P(-0.1, 0.45, 0);
  w[27] = P(0.1, 0.85, 0); w[28] = P(-0.1, 0.85, 0);
  w[29] = P(0.1, 0.9, -0.02); w[30] = P(-0.1, 0.9, -0.02);
  w[31] = P(0.1, 0.9, 0.1); w[32] = P(-0.1, 0.9, 0.1);
  const img = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const vis = new Float32Array(33).fill(1);
  const spawn = new THREE.Vector3(0, 0, 0);
  let pts = null;
  for (let k = 0; k < 12; k++) {                                   // fresh retarget per pass —
    pts = bodyPose.retarget(w, img, spawn, 0, vis, k / 10);        // the normalizer's decision
    povFaceAway(pts);                                              // latch settles over frames
  }
  const up = new THREE.Vector3(0, 1, 0);
  const hip = pts[23].clone().lerp(pts[24], 0.5);
  const away = hip.clone().sub(camera.position); away.y = 0; away.normalize();
  const nose = pts[0].clone().sub(pts[7].clone().lerp(pts[8], 0.5)).normalize();
  const shoulderFwd = pts[11].clone().sub(pts[12]).cross(up).normalize();
  bodyPose.drop();
  return {
    leftOnScreenLeft: pts[15].x < pts[16].x,
    leftRaised: pts[15].y > pts[16].y,
    proper: +shoulderFwd.dot(nose).toFixed(2),
    facesAway: +nose.dot(away).toFixed(2),
  };
});
// hand↔body PROPORTION: welded hands must RESIZE to the figure (palm = 0.40 ×
// the body's forearm), at any body scale — a shrunken/distant figure must not
// wear giant real-metric hands
const prop = await page.evaluate(() => {
  const { THREE, weldHandsToBody } = window.__lab;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const mkBody = (s) => {
    const pts = new Array(33).fill(0).map(() => V(0, 0, 0));
    pts[13] = V(0.30 * s, 0.9 * s, 0); pts[15] = V(0.45 * s, 0.7 * s, 0);    // L elbow→wrist
    pts[14] = V(-0.30 * s, 0.9 * s, 0); pts[16] = V(-0.45 * s, 0.7 * s, 0);  // R elbow→wrist
    return pts;
  };
  const mkPack = (x) => {                    // real-metric-ish pack: palm 0.18
    const p = new Array(21).fill(0).map((_, i) => V(x + i * 0.01, 0, 0));
    p[0] = V(x, 0, 0); p[9] = V(x, 0.18, 0);
    return p;
  };
  const run = (s) => {
    const pts = mkBody(s);
    const packs = { R: mkPack(-0.5), L: mkPack(0.5) };
    weldHandsToBody(packs, pts);
    const fore = pts[13].distanceTo(pts[15]);
    return {
      palmL: +(packs.L[0].distanceTo(packs.L[9]) / fore).toFixed(3),
      palmR: +(packs.R[0].distanceTo(packs.R[9]) / fore).toFixed(3),
      seated: packs.L[0].distanceTo(pts[15]) < 1e-6 && packs.R[0].distanceTo(pts[16]) < 1e-6,
    };
  };
  return { full: run(1), half: run(0.45) };
});
// snapshots must not persist anchors
const snapLen = await page.evaluate(() => {
  localStorage.setItem('__probe_snap', 'x');
  return (window.__eng && window.__eng.objects.filter(o => o.userData.eng.type !== 'tracker').length);
});
// progressive disclosure: hand part hides BODY SUITE, body part hides the skin row
await page.click('#engSdkParts [data-part="hand"]');
const foldHand = await page.evaluate(() => ({
  suite: document.getElementById('engBodySuite').style.display,
  skin: document.getElementById('engSdkSkin').style.display,
}));
await page.click('#engSdkParts [data-part="body"]');
const foldBody = await page.evaluate(() => ({
  suite: document.getElementById('engBodySuite').style.display,
  skin: document.getElementById('engSdkSkin').style.display,
}));
await page.click('#engSdkParts [data-part="hand"]');
await page.click('#engClear');
const on = await page.evaluate(() => ({
  mode: window.__lab.S.mode, display: window.__lab.S.display,
  running: window.__lab.S.running,
  bgNull: window.__lab.scene.background === null && window.__lab.scene.fog === null,
  cShown: getComputedStyle(document.getElementById('c')).display !== 'none',
  cZ: getComputedStyle(document.getElementById('c')).zIndex,
  partsShown: document.getElementById('engSdkParts').style.display !== 'none',
}));
await page.screenshot({ path: SP + '/engine-sdk.png' });

// part switch: both → instant display change
await page.click('#engSdkParts [data-part="both"]');
await new Promise(r => setTimeout(r, 300));
const both = await page.evaluate(() => window.__lab.S.display);

// BODY SUITE presets drive the lab's own pathways
const suite = {};
await page.click('#engBodySuite [data-bs="body3d"]');
await new Promise(r => setTimeout(r, 400));
suite.body3d = await page.evaluate(() => ({ mode: window.__lab.S.mpMode, disp: window.__lab.S.display, mp: window.__lab.S.mp }));
await page.click('#engBodySuite [data-bs="fast2d"]');
await new Promise(r => setTimeout(r, 400));
suite.fast2d = await page.evaluate(() => ({ mode: window.__lab.S.mpMode, disp: window.__lab.S.display }));
await page.click('#engBodySuite [data-bs="multiId"]');
await page.waitForFunction(() => window.__lab.S.display === 'skeletons', { timeout: 90000 });
suite.multiId = await page.evaluate(() => ({ disp: window.__lab.S.display, mp: window.__lab.S.mp }));
await page.click('#engBodySuite [data-bs="handsBody"]');
await new Promise(r => setTimeout(r, 400));
suite.handsBody = await page.evaluate(() => ({ mode: window.__lab.S.mpMode, disp: window.__lab.S.display, mp: window.__lab.S.mp }));

// VIEW row: mirror = the lab's camera-overlay experience inside the engine
await page.click('#engSdkView [data-view="mirror"]');
await new Promise(r => setTimeout(r, 400));
const viewMirror = await page.evaluate(() => ({
  mode: window.__lab.S.mode,
  cls: document.body.classList.contains('eng-mirror'),
  bgVid: getComputedStyle(document.getElementById('bgVid')).display !== 'none',
  engcHidden: getComputedStyle(document.getElementById('engc')).display === 'none',
}));
await page.click('#engSdkView [data-view="pov"]');
await new Promise(r => setTimeout(r, 400));
const viewPov = await page.evaluate(() => ({
  mode: window.__lab.S.mode,
  cls: document.body.classList.contains('eng-mirror'),
  bgNull: window.__lab.scene.background === null,
}));

// TRACKED FIGURE = GAME OBJECT: the 🧍 anchor's pick-box hugs the LIVE
// skeleton, so clicking the figure itself selects it, the selection box wraps
// it, and the gizmo attaches — same UX as the avatar
const figPrep = await page.evaluate(async () => {
  const V = (x, y, z) => ({ x, y, z });
  // clear the stage around the figure, then feed a known synthetic figure
  for (const o of window.__eng.objects)
    if (o.userData.eng.type !== 'tracker') o.position.set(8, 0.5, 8);
  window.__eng.sel = null; window.__eng.tc.detach();
  window.__eng.ovBodyPts = [V(-0.35, 0.15, -0.5), V(0.35, 1.62, -0.35), V(0.05, 0.9, -0.42)];
  await new Promise(r => setTimeout(r, 300));
  const T3 = window.__lab.THREE;
  const p = new T3.Vector3(0.05, 0.9, -0.42).project(window.__eng.camera);
  return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight };
});
await page.mouse.click(figPrep.x, figPrep.y);          // click the figure itself
await new Promise(r => setTimeout(r, 250));
const figure = await page.evaluate(() => {
  const T3 = window.__lab.THREE;
  const body = window.__eng.objects.find(o => o.userData.eng && o.userData.eng.sub === 'body');
  const bb = window.__eng.box.box;
  const out = {
    hasProxy: !!body.userData.pickProxy,
    selected: window.__eng.sel === body,
    gizmo: window.__eng.tc.object === body,
    boxHugs: bb.containsPoint(new T3.Vector3(0.05, 0.9, -0.42))
      && (bb.max.y - bb.min.y) > 1.2 && (bb.max.y - bb.min.y) < 2.1,
  };
  window.__eng.ovBodyPts = null;
  window.__eng.sel = null; window.__eng.tc.detach();
  return out;
});

// FACE row: runtime landmarker enable + mode state
await page.click('#engFaceRow [data-face="simple"]');
await page.waitForFunction(() => window.__lab.faceReady === true, { timeout: 90000 });
const faceSimple = await page.evaluate(() => window.__eng.sdk.face);
await page.click('#engFaceRow [data-face="full"]');
const faceFull = await page.evaluate(() => window.__eng.sdk.face);
await page.click('#engFaceRow [data-face="off"]');
const faceOff = await page.evaluate(() => window.__eng.sdk.face);

// toggle off → lab state restored, canvas hidden again
await page.click('#engSdkChk');
await new Promise(r => setTimeout(r, 300));
const off = await page.evaluate(() => ({
  engSdk: document.body.classList.contains('eng-sdk'),
  display: window.__lab.S.display, mode: window.__lab.S.mode,
  cHidden: getComputedStyle(document.getElementById('c')).display === 'none',
}));

// on again, then ↩ LAB must auto-restore
await page.click('#engSdkChk');
await page.waitForFunction(() => document.body.classList.contains('eng-sdk'), { timeout: 30000 });
await page.click('#engBack');
await new Promise(r => setTimeout(r, 300));
const back = await page.evaluate(() => ({
  engSdk: document.body.classList.contains('eng-sdk'),
  mode: window.__lab.S.mode,
  checked: document.getElementById('engSdkChk').checked,
}));
await browser.close();

console.log(JSON.stringify({ on, inputOk, offSync, chirality, prop, figure, foldHand, foldBody, both, suite, viewMirror, viewPov, faceSimple, faceFull, faceOff, off, back }, null, 2));
const fail = [];
if (!on.running) fail.push('tracking stack did not boot');
if (on.mode !== 'firstPerson') fail.push('POV mode not applied');
if (on.display !== 'hands') fail.push('hand isolation not applied, got ' + on.display);
if (!on.bgNull) fail.push('lab canvas not transparent (background/fog not nulled)');
if (!on.cShown || on.cZ !== '6') fail.push('lab canvas not composited over engine');
if (!on.partsShown) fail.push('part row not revealed');
if (inputOk.cPE !== 'none' || inputOk.ovPE !== 'none') fail.push('tracking canvases still eat pointer events');
if (inputOk.spawned !== 4) fail.push('expected 3 anchors + 1 spawned box, got ' + inputOk.spawned);
if (inputOk.trackers !== 3) fail.push('tracked anchors missing from OBJECTS: ' + inputOk.trackers);
if (Math.abs(offSync.y - 0.4) > 0.02 || Math.abs(offSync.s - 1.3) > 0.02) fail.push('anchor gizmo not driving TRACK_OFF: ' + JSON.stringify(offSync));
if (Math.abs(offSync.qy - 0.707) > 0.01 || Math.abs(offSync.qw - 0.707) > 0.01) fail.push('anchor ROTATION not driving TRACK_OFF: ' + JSON.stringify(offSync));
if (!chirality.leftOnScreenLeft || !chirality.leftRaised) fail.push('POV chirality wrong (left limb not on screen-left): ' + JSON.stringify(chirality));
if (chirality.proper < 0.05 || chirality.facesAway < 0.05) fail.push('povFaceAway broken (must land proper + facing away): ' + JSON.stringify(chirality));
const okProp = r => Math.abs(r.palmL - 0.4) < 0.01 && Math.abs(r.palmR - 0.4) < 0.01 && r.seated;
if (!okProp(prop.full) || !okProp(prop.half)) fail.push('HAND/BODY PROPORTION broken (palm should be 0.40× forearm at any body scale): ' + JSON.stringify(prop));
if (!figure.hasProxy || !figure.selected || !figure.gizmo || !figure.boxHugs) fail.push('TRACKED FIGURE not a clickable game object (hugger/selection/gizmo): ' + JSON.stringify(figure));
if (foldHand.suite !== 'none' || foldHand.skin === 'none') fail.push('hand-part fold wrong: ' + JSON.stringify(foldHand));
if (foldBody.suite === 'none' || foldBody.skin !== 'none') fail.push('body-part fold wrong: ' + JSON.stringify(foldBody));
if (both !== 'handsBody') fail.push('part switch to both failed, got ' + both);
if (suite.body3d.mode !== 'B' || suite.body3d.disp !== 'handsBody') fail.push('body3d preset wrong: ' + JSON.stringify(suite.body3d));
if (suite.fast2d.mode !== 'A' || suite.fast2d.disp !== 'handsBody') fail.push('fast2d preset wrong: ' + JSON.stringify(suite.fast2d));
if (suite.multiId.disp !== 'skeletons') fail.push('multiId preset wrong: ' + JSON.stringify(suite.multiId));
if (suite.handsBody.mode !== 'auto' || suite.handsBody.disp !== 'handsBody') fail.push('handsBody preset wrong: ' + JSON.stringify(suite.handsBody));
if (suite.handsBody.mp !== false) fail.push('Full preset did not force single-person (MediaPipe) pipeline');
if (viewMirror.mode !== 'mirror' || !viewMirror.cls || !viewMirror.bgVid || !viewMirror.engcHidden) fail.push('mirror view wrong: ' + JSON.stringify(viewMirror));
if (viewPov.mode !== 'firstPerson' || viewPov.cls || !viewPov.bgNull) fail.push('pov view wrong: ' + JSON.stringify(viewPov));
if (faceSimple !== 'simple' || faceFull !== 'full' || faceOff !== 'off') fail.push('face row states wrong');
if (off.engSdk || !off.cHidden) fail.push('toggle off did not hide the overlay');
if (off.display !== 'lab' || off.mode !== 'mirror') fail.push('lab state not restored: ' + off.mode + '/' + off.display);
if (back.engSdk || back.checked) fail.push('leaving engine did not auto-restore');
if (back.mode !== 'mirror') fail.push('lab mode wrong after exit: ' + back.mode);
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ IMPORT SDK works — screenshot: engine-sdk.png');
process.exit(fail.length ? 1 : 0);
