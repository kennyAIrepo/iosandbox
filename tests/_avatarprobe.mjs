// verify the engine AVATAR class: spawns as a real game object (OBJECTS list, gizmo),
// clips rebuilt from the reusable .anim.json packages actually animate bones, the
// Animator-lite strip appears on select, and avatars survive a save/clear/load
// round-trip with their clip choice. Dev server on :3333 required.
import puppeteer from 'puppeteer-core';
import os from 'node:os';
const SP = process.env.PROBE_SHOTS || os.tmpdir();   // screenshot output dir
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

// spawn via the SPAWN row button (the real user path)
await page.click('#engSpawnRow [data-sp="avatar"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'avatar'), { timeout: 60000 });
await new Promise(r => setTimeout(r, 400));

const spawned = await page.evaluate(async () => {
  const av = window.__eng.objects.find(o => o.userData.eng.type === 'avatar');
  const rec = window.__eng.avatars.get(av.userData.eng.id);
  // STILLNESS CONTRACT: a fresh avatar spawns idle — no clip auto-play, no
  // self-motion. (Auto-playing walk read as "the avatar trembles by itself".)
  let bone = null;
  av.traverse(o => { if (o.isBone && o.name === 'LeftArm') bone = o; });
  const q0 = bone.quaternion.toArray().map(v => +v.toFixed(4));
  await new Promise(r => setTimeout(r, 400));
  const q1 = bone.quaternion.toArray().map(v => +v.toFixed(4));
  // …and clips still animate when explicitly chosen
  window.__eng.avatarSetClip(av, 0);
  await new Promise(r => setTimeout(r, 300));
  const w0 = bone.quaternion.toArray().map(v => +v.toFixed(4));
  await new Promise(r => setTimeout(r, 350));
  const w1 = bone.quaternion.toArray().map(v => +v.toFixed(4));
  return {
    label: av.userData.eng.label,
    listedIcon: [...document.querySelectorAll('.engRow')].some(r => r.textContent.includes('🧍')),
    clips: rec.clips.map(c => c.name),
    spawnedIdle: JSON.stringify(q0) === JSON.stringify(q1),
    boneAnimates: JSON.stringify(w0) !== JSON.stringify(w1),
    playing: rec.clipIdx,
    bones: (() => { let n = 0; av.traverse(o => { if (o.isBone) n++; }); return n; })(),
  };
});

// select → Animator strip; switch to run; gizmo attaches
const strip = await page.evaluate(() => {
  const av = window.__eng.objects.find(o => o.userData.eng.type === 'avatar');
  window.__eng.objects && window.__eng;
  const ENG = window.__eng;
  // select via the same path the UI uses
  const row = [...document.querySelectorAll('.engRow')].find(r => r.textContent.includes('🧍'));
  row.click();
  return {
    stripShown: document.getElementById('engAvCtl').style.display !== 'none',
    chips: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent),
    gizmoAttached: ENG.tc.object === av,
  };
});
await page.evaluate(() => {
  const av = window.__eng.objects.find(o => o.userData.eng.type === 'avatar');
  window.__eng.avatarSetClip(av, 1);                       // ▶ run
});
const afterRun = await page.evaluate(() => {
  const av = window.__eng.objects.find(o => o.userData.eng.type === 'avatar');
  return window.__eng.avatars.get(av.userData.eng.id).clipIdx;
});
await page.screenshot({ path: SP + '/avatar-engine.png' });

// snapshot round-trip: save → clear → load → avatar back with clip choice
await page.click('#engSave');
await page.click('#engClear');
const cleared = await page.evaluate(() => window.__eng.objects.filter(o => o.userData.eng.type === 'avatar').length);
await page.click('#engLoad');
await page.waitForFunction(() => {
  const av = window.__eng.objects.find(o => o.userData.eng.type === 'avatar');
  const rec = av && window.__eng.avatars.get(av.userData.eng.id);
  return rec && rec.clips.length === 2;
}, { timeout: 60000 });
const restored = await page.evaluate(() => {
  const av = window.__eng.objects.find(o => o.userData.eng.type === 'avatar');
  const rec = window.__eng.avatars.get(av.userData.eng.id);
  return { clips: rec.clips.length, clip: rec.clipIdx, label: av.userData.eng.label };
});
// ═══ ROLES + LIVE-DRIVE + COLLISION ═══
// second avatar → promote to USER; first stays NPC on its clip (parallel classes)
await page.click('#engSpawnRow [data-sp="avatar"]');
await page.waitForFunction(() => window.__eng.objects.filter(o => o.userData.eng.type === 'avatar').length === 2, { timeout: 60000 });
await new Promise(r => setTimeout(r, 300));
const roles = await page.evaluate(async () => {
  const avs = window.__eng.objects.filter(o => o.userData.eng.type === 'avatar');
  const rec1 = window.__eng.avatars.get(avs[1].userData.eng.id);
  // set avatar 2 walking, then promote via the REAL 🎮 chip — promotion must
  // STOP the clip (a running mixer fights the driver: it owns hips/shoulders/
  // feet the driver doesn't, so the body swings even with the user static)
  window.__eng.avatarSetClip(avs[1], 0);
  [...document.querySelectorAll('.engRow')].filter(r => /🧍|🎮/.test(r.textContent)).at(-1).click();
  [...document.querySelectorAll('#engAvCtl .opt')].find(b => b.textContent.includes('make user')).click();
  const clipStopped = rec1.clipIdx === -1;
  // synthetic RAW MediaPipe world pose: LEFT wrist raised high (chirality contract)
  const P = (x, y, z) => ({ x, y, z, visibility: 1 });
  const w = new Array(33).fill(0).map(() => P(0, 0.3, 0));
  w[23] = P(0.1, 0, 0); w[24] = P(-0.1, 0, 0);
  w[11] = P(0.16, -0.5, 0); w[12] = P(-0.16, -0.5, 0);
  w[13] = P(0.34, -0.6, 0); w[14] = P(-0.3, -0.3, 0);
  w[15] = P(0.44, -0.8, 0.05); w[16] = P(-0.32, -0.1, 0.05);
  w[0] = P(0, -0.68, 0.12);
  for (const i of [1,2,3,4,5,6,7,8,9,10]) w[i] = P(0, -0.66, 0.1);
  w[25] = P(0.1, 0.45, 0); w[26] = P(-0.1, 0.45, 0);
  w[27] = P(0.1, 0.85, 0); w[28] = P(-0.1, 0.85, 0);
  w[29] = P(0.1, 0.9, -0.02); w[30] = P(-0.1, 0.9, -0.02);
  w[31] = P(0.1, 0.9, 0.1); w[32] = P(-0.1, 0.9, 0.1);
  window.__lab.AVSYNC.ovPose = w;
  await new Promise(r => setTimeout(r, 500));
  const bones = {};
  avs[1].traverse(o => { if (o.isBone && /^(LeftHand|RightHand|LeftArm|RightArm|Hips)$/.test(o.name)) bones[o.name] = o; });
  const inv = avs[1].matrixWorld.clone().invert();
  const lp = new window.__lab.THREE.Vector3().setFromMatrixPosition(bones.LeftHand.matrixWorld).applyMatrix4(inv);
  const rp = new window.__lab.THREE.Vector3().setFromMatrixPosition(bones.RightHand.matrixWorld).applyMatrix4(inv);
  const q = bones.LeftArm.quaternion.toArray();
  // T-POSE SPREAD (lateral chirality contract). The bug class this guards:
  // a reflection in mapSigns leaves verticals correct (raise test passes!)
  // while folding every lateral target across the chest — the arm knot.
  // Self-calibrating: each hand must land OUTSIDE its own shoulder, judged
  // against the avatar's measured shoulder span, no facing assumption.
  const sp = new Array(33).fill(0).map(() => P(0, 0.3, 0));
  sp[23] = P(0.1, 0, 0); sp[24] = P(-0.1, 0, 0);
  sp[11] = P(0.16, -0.5, 0); sp[12] = P(-0.16, -0.5, 0);
  sp[13] = P(0.36, -0.5, 0); sp[14] = P(-0.36, -0.5, 0);
  sp[15] = P(0.58, -0.5, 0); sp[16] = P(-0.58, -0.5, 0);
  sp[0] = P(0, -0.68, 0.12);
  for (const i of [1,2,3,4,5,6,7,8,9,10]) sp[i] = P(0, -0.66, 0.1);
  sp[25] = P(0.1, 0.45, 0); sp[26] = P(-0.1, 0.45, 0);
  sp[27] = P(0.1, 0.85, 0); sp[28] = P(-0.1, 0.85, 0);
  sp[29] = P(0.1, 0.9, -0.02); sp[30] = P(-0.1, 0.9, -0.02);
  sp[31] = P(0.1, 0.9, 0.1); sp[32] = P(-0.1, 0.9, 0.1);
  window.__lab.AVSYNC.ovPose = sp;
  await new Promise(r => setTimeout(r, 700));
  const pt = b => new window.__lab.THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv);
  const lpS = pt(bones.LeftHand), rpS = pt(bones.RightHand);
  const laS = pt(bones.LeftArm), raS = pt(bones.RightArm);
  const shoulderSpan = laS.x - raS.x;                       // signed: which side is "left"
  const handSpan = lpS.x - rpS.x;
  const armsSpread = Math.sign(handSpan) === Math.sign(shoulderSpan)
    && Math.abs(handSpan) > Math.abs(shoulderSpan) + 0.3;   // crossed arms: sign flips or span collapses
  // STILLNESS CONTRACT: static user (same pose latched) → static avatar. Any
  // residual motion means something is fighting the driver (a live mixer bobbing
  // hips/shoulders was the "trembling by itself" bug).
  const still0 = { hand: pt(bones.LeftHand), hips: pt(bones.Hips) };
  await new Promise(r => setTimeout(r, 400));
  const stillHand = still0.hand.distanceTo(pt(bones.LeftHand));
  const stillHips = still0.hips.distanceTo(pt(bones.Hips));
  const userStill = stillHand < 0.03 && stillHips < 0.01;
  // ── SPINE DISTRIBUTION (Kalidokit doctrine): lean forward → the bend spreads
  // down Spine/Spine01/Spine02 with declining angles, never one sharp hinge
  const lean = sp.map(p => ({ ...p }));
  for (const i of [11, 12]) lean[i] = { ...lean[i], z: lean[i].z - 0.3 };
  window.__lab.AVSYNC.ovPose = lean;
  await new Promise(r => setTimeout(r, 600));
  const sb = {};
  avs[1].traverse(o => { if (o.isBone && /^(Spine|Spine01|Spine02|Head|headfront)$/.test(o.name)) sb[o.name] = o; });
  const ang = n => sb[n].quaternion.angleTo(rec1.driver.rest[n]) * 180 / Math.PI;
  const spineAngles = ['Spine', 'Spine01', 'Spine02'].map(n => +ang(n).toFixed(2));
  const spineDistributed = spineAngles[0] > spineAngles[1] && spineAngles[1] > spineAngles[2]
    && spineAngles[2] > 0.2 && spineAngles[0] < 30;
  // ── HEAD LANE: turn toward the user's LEFT → the avatar's face (Head→headfront)
  // swings toward ITS left (+x). Sign contract on real bones, not assumptions.
  const T3 = window.__lab.THREE;
  const faceDir = () => {
    sb.Head.updateWorldMatrix(true, false); sb.headfront.updateWorldMatrix(true, false);
    return new T3.Vector3().setFromMatrixPosition(sb.headfront.matrixWorld)
      .sub(new T3.Vector3().setFromMatrixPosition(sb.Head.matrixWorld));
  };
  const neutral = lean.map(p => ({ ...p }));
  neutral[7] = { x: 0.07, y: -0.66, z: 0.02, visibility: 1 };
  neutral[8] = { x: -0.07, y: -0.66, z: 0.02, visibility: 1 };
  neutral[0] = { x: 0, y: -0.67, z: -0.10, visibility: 1 };
  window.__lab.AVSYNC.ovPose = neutral;
  await new Promise(r => setTimeout(r, 350));
  const f0 = faceDir();
  const turn = neutral.map(p => ({ ...p }));
  turn[0] = { x: 0.09, y: -0.67, z: -0.06, visibility: 1 };   // nose swung to the user's left
  window.__lab.AVSYNC.ovPose = turn;
  await new Promise(r => setTimeout(r, 450));
  const f1 = faceDir();
  const headTurnsLeft = (f1.x - f0.x) > 0.01;
  // ── HAND GRAFT: 21-pt clouds → flesh rigs visible at the wrists, sized to the
  // forearm, stumps collapsed; feed loss → rigs hide, stumps restore
  await new Promise(r => { const t0 = Date.now(); (function wait() {
    if (rec1.avHands || Date.now() - t0 > 20000) r(); else setTimeout(wait, 150); })(); });
  const R42 = window.__lab.REST_R42;
  const invMap = (x, y, z) => ({ x, y: -y, z: -z / 0.85, visibility: 1 });   // inverse of mapSigns [1,-1,-1]·zScale
  const handR = R42.slice(0, 21).map(p => invMap(p[0], p[1], p[2]));
  const handL = R42.slice(0, 21).map(p => invMap(-p[0], p[1], p[2]));        // mirrored = a left hand
  window.__lab.AVSYNC.ovHands = [handR, handL];
  window.__lab.AVSYNC.ovHanded = ['Right', 'Left'];
  await new Promise(r => setTimeout(r, 500));
  const HH = rec1.avHands;
  const wristR = rec1.driver.bones.RightHand;
  if (HH && HH.R) HH.R.mesh.geometry.computeBoundingBox();   // pose() leaves bounds stale
  const hbox = HH && HH.R ? new T3.Box3().setFromObject(HH.R.grp) : null;
  // the graft must sit at the VISUAL hand (skinned-mesh anchor), inside the
  // avatar's visual body bounds (pickProxy) — NOT at the bone origin, which
  // this rig keeps in a ~2.3× larger frame than the rendered mesh
  const proxyBox = new T3.Box3().setFromObject(avs[1].userData.pickProxy).expandByScalar(0.6);
  const handGraft = !HH ? { rigsBuilt: false } : {
    rigsBuilt: !!(HH.R && HH.L),
    visR: HH.R.grp.visible, visL: HH.L.grp.visible,
    nearWrist: hbox.getCenter(new T3.Vector3()).distanceTo(HH.seat.R) < 0.3,
    inBodyBounds: proxyBox.containsPoint(HH.seat.R) && proxyBox.containsPoint(HH.seat.L),
    stumpCollapsed: Math.abs(wristR.scale.x - 1e-4) < 1e-9,
    handSpanWorld: +hbox.getSize(new T3.Vector3()).length().toFixed(3),
    // POV orientation: the pack must be the mapped cloud flipped 180° about its
    // own wrist→knuckle axis (axis kept, palm normal reversed → back to dolly)
    ...(() => {
      const pkR = HH.pack.R;
      const vsub = (a, b) => new T3.Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
      const palmN = P => new T3.Vector3().crossVectors(vsub(P(5), P(0)), vsub(P(17), P(0))).normalize();
      const rPt = i => ({ x: R42[i][0], y: R42[i][1], z: R42[i][2] });
      return {
        axisKept: vsub(pkR[9], pkR[0]).normalize().dot(vsub(rPt(9), rPt(0)).normalize()) > 0.9,
        backToCam: palmN(i => pkR[i]).dot(palmN(rPt)) < -0.5,
      };
    })(),
  };
  window.__lab.AVSYNC.ovHands = null; window.__lab.AVSYNC.ovHanded = null;
  await new Promise(r => setTimeout(r, 250));
  const stumpRestored = Math.abs(wristR.scale.x - 1) < 1e-6 && !(HH && HH.R.grp.visible);
  // NPC (avatar 1) still animates its clip in parallel
  const npcRec = window.__eng.avatars.get(avs[0].userData.eng.id);
  let npcBone = null;
  avs[0].traverse(o => { if (o.isBone && o.name === 'LeftArm') npcBone = o; });
  const nq0 = npcBone.quaternion.toArray().map(v => +v.toFixed(4));
  await new Promise(r => setTimeout(r, 350));
  const nq1 = npcBone.quaternion.toArray().map(v => +v.toFixed(4));
  // FEED-DEATH contract (the T-pose-freeze bug class): the pose lane dying
  // while promoted must fade the avatar to rest — the old forever-latch kept a
  // stale pose while the skeleton lane moved on, desyncing avatar from skeleton
  window.__lab.AVSYNC.ovPose = null;
  await new Promise(r => setTimeout(r, 1300));                 // holdMs 400 + fadeMs 350 + margin
  const fadeAng = bones.LeftArm.quaternion.angleTo(rec1.driver.rest.LeftArm) * 180 / Math.PI;
  const fadesToRest = fadeAng < 2;
  // ...and the next live pose picks the drive back up (no permanent starve)
  window.__lab.AVSYNC.ovPose = sp;
  await new Promise(r => setTimeout(r, 500));
  const revives = pt(bones.LeftHand).x - pt(bones.RightHand).x > 0.5;
  window.__lab.AVSYNC.ovPose = null;
  const userRole = rec1.role, driveWasOn = rec1.driveOn;
  // demote via the chip → the clip it had before promotion resumes
  [...document.querySelectorAll('#engAvCtl .opt')].find(b => b.textContent === '🎮 user').click();
  const demoteRestores = rec1.role === 'npc' && !rec1.driveOn && rec1.clipIdx === 0;
  return {
    userRole, driveWasOn, clipStopped, demoteRestores, npcRole: npcRec.role,
    leftHandRaised: lp.y > rp.y + 0.08,
    noNaN: q.every(v => Number.isFinite(v)),
    npcStillAnimating: JSON.stringify(nq0) !== JSON.stringify(nq1) && npcRec.clipIdx >= 0,
    armsSpread, handSpan: +handSpan.toFixed(3), shoulderSpan: +shoulderSpan.toFixed(3),
    spreadLevel: Math.abs(lpS.y - rpS.y) < 0.2,
    userStill, stillHand: +stillHand.toFixed(4), stillHips: +stillHips.toFixed(4),
    spineAngles, spineDistributed, headTurnsLeft, faceDx: +(f1.x - f0.x).toFixed(4),
    handGraft, stumpRestored, fadesToRest, fadeAng: +fadeAng.toFixed(2), revives,
  };
});

// ═══ NPC MIND: interaction loops — approach→flee (clip stacked over idle +
// real locomotion + stat deltas), touch→hp hit via the hand sensor, settle
// pops the stack, and the lineage (reaction→avatar stats→world) hits the log
const mind = await page.evaluate(async () => {
  const T3 = window.__lab.THREE;
  const avs = window.__eng.objects.filter(o => o.userData.eng.type === 'avatar');
  const npc = avs[0], user = avs[1];
  const nrec = window.__eng.avatars.get(npc.userData.eng.id);
  const urec = window.__eng.avatars.get(user.userData.eng.id);
  for (const r of window.__eng.avatars.values()) { r.driveOn = false; if (r.role === 'user') r.role = 'npc'; }
  urec.driveOn = true; urec.role = 'user';
  window.__eng.avatarSetClip(user, -1); window.__eng.avatarSetClip(npc, -1);
  npc.position.set(0, 0, 0); user.position.set(5, 0, 5);
  window.__eng.mindSet(npc, 'skittish');
  await new Promise(r => setTimeout(r, 300));             // near-state seeds FAR
  user.position.set(0, 0, 1.2);                           // step inside 1.4 → approach
  // (approach along +z: the T-pose arms span ±x, so no accidental hand-touch)
  await new Promise(r => setTimeout(r, 600));
  const duringClip = nrec.clipIdx >= 0 ? nrec.clips[nrec.clipIdx].name : 'idle';
  const d1 = Math.hypot(npc.position.x - user.position.x, npc.position.z - user.position.z);
  await new Promise(r => setTimeout(r, 1400));            // reaction settles
  const restored = nrec.clipIdx === -1;
  const statsAfterFlee = { ...nrec.mind.stats };
  // TOUCH: park the NPC's volume on the user avatar's hand bone
  let hand = null; user.traverse(o => { if (o.isBone && o.name === 'RightHand') hand = o; });
  hand.updateWorldMatrix(true, false);
  const hpos = new T3.Vector3().setFromMatrixPosition(hand.matrixWorld);
  npc.position.set(hpos.x, 0, hpos.z);
  await new Promise(r => setTimeout(r, 500));
  const touched = nrec.mind.stats.hp < statsAfterFlee.hp && window.__eng.world.stats.touches > 0;
  npc.position.set(-2, 0, -2); user.position.set(5, 0, 5);
  // UI: selecting the NPC shows the role chips + the live stat line
  [...document.querySelectorAll('.engRow')].filter(r => /🧍|🎮/.test(r.textContent))[0].click();
  const ui = {
    chips: [...document.querySelectorAll('#engMindRow .opt')].map(b => b.textContent),
    sel: (document.querySelector('#engMindRow .opt.sel') || {}).textContent,
    info: document.getElementById('engMindInfo').textContent,
  };
  window.__eng.mindSet(npc, 'none');                      // quiet for the collision section
  return {
    fled: duringClip === 'run' && d1 > 1.15, d1: +d1.toFixed(2),
    restored, touched,
    statsDropped: statsAfterFlee.energy < 100 && statsAfterFlee.mood < 50,
    logKinds: [...new Set(window.__eng.world.log.map(e => e.kind))],
    log: window.__eng.world.log.map(e => e.t + ' ' + e.kind + ' ' + e.msg),
    interactions: window.__eng.world.stats.interactions,
    ui,
  };
});

// COLLISION: a dragged box cannot sit inside another box, nor inside an avatar
const collide = await page.evaluate(async () => {
  const avs = window.__eng.objects.filter(o => o.userData.eng.type === 'avatar');
  const T = window.__lab.THREE;
  // two boxes forced to the same spot → resolver must separate them
  window.__eng.objects.filter(o => o.userData.eng.type === 'box').forEach(o => { o.position.set(9, 0.5, 9); });
  const spawnBtns = document.querySelectorAll('#engSpawnRow .opt');
  spawnBtns[0].click(); spawnBtns[0].click();
  await new Promise(r => setTimeout(r, 250));
  const boxes = window.__eng.objects.filter(o => o.userData.eng.type === 'box').slice(-2);
  boxes[0].position.set(3, 0.5, 3); boxes[1].position.set(3, 0.5, 3);
  await new Promise(r => setTimeout(r, 250));
  const bA = new T.Box3().setFromObject(boxes[0]), bB = new T.Box3().setFromObject(boxes[1]);
  const separated = !bA.intersectsBox(bB) || (bA.getCenter(new T.Vector3()).distanceTo(bB.getCenter(new T.Vector3())) > 0.9);
  // box dragged into the NPC avatar → pushed out of its body volume
  boxes[0].position.copy(avs[0].position).setY(0.8);
  await new Promise(r => setTimeout(r, 250));
  const avBox = new T.Box3().setFromObject(avs[0].userData.pickProxy);
  const bA2 = new T.Box3().setFromObject(boxes[0]);
  const outOfAvatar = !avBox.intersectsBox(bA2) || dxOverlap(avBox, bA2) < 0.12;
  function dxOverlap(A, B) {
    const ox = Math.min(A.max.x - B.min.x, B.max.x - A.min.x);
    const oy = Math.min(A.max.y - B.min.y, B.max.y - A.min.y);
    const oz = Math.min(A.max.z - B.min.z, B.max.z - A.min.z);
    return Math.max(0, Math.min(ox, oy, oz));
  }
  return { separated, outOfAvatar };
});
await browser.close();

console.log(JSON.stringify({ spawned, strip, afterRun, cleared, restored, roles, mind, collide }, null, 2));
const fail = [];
if (spawned.bones !== 24) fail.push('expected 24 bones, got ' + spawned.bones);
if (JSON.stringify(spawned.clips) !== '["walk","run"]') fail.push('clips wrong: ' + JSON.stringify(spawned.clips));
if (!spawned.spawnedIdle) fail.push('SELF-MOTION AT SPAWN: avatar animates before any clip is chosen');
if (spawned.playing !== 0) fail.push('explicit clip select failed');
if (!spawned.boneAnimates) fail.push('mixer not animating bones when a clip is chosen');
if (!spawned.listedIcon) fail.push('avatar missing from OBJECTS list');
if (!strip.stripShown || strip.chips.length !== 4) fail.push('Animator strip wrong: ' + JSON.stringify(strip.chips));
if (!strip.gizmoAttached) fail.push('gizmo did not attach to avatar');
if (afterRun !== 1) fail.push('clip switch to run failed');
if (cleared !== 0) fail.push('clear did not remove avatar');
if (restored.clips !== 2 || restored.clip !== 1) fail.push('snapshot round-trip lost clips/choice: ' + JSON.stringify(restored));
if (roles.userRole !== 'user' || roles.npcRole !== 'npc' || !roles.driveWasOn) fail.push('role separation broken: ' + JSON.stringify(roles));
if (!roles.clipStopped) fail.push('promotion left the clip running (mixer fights the driver → self-swing)');
if (!roles.userStill) fail.push('SELF-MOTION WITH STATIC USER: hand drift ' + roles.stillHand + ', hips drift ' + roles.stillHips);
if (!roles.demoteRestores) fail.push('demote did not restore the NPC clip');
if (!roles.spineDistributed) fail.push('SPINE bend not distributed down the chain: ' + JSON.stringify(roles.spineAngles));
if (!roles.headTurnsLeft) fail.push('HEAD yaw wrong (user-left did not turn avatar its-left): faceDx ' + roles.faceDx);
if (!roles.handGraft.rigsBuilt || !roles.handGraft.visR || !roles.handGraft.visL) fail.push('hand rigs not built/visible: ' + JSON.stringify(roles.handGraft));
if (roles.handGraft.rigsBuilt && (!roles.handGraft.nearWrist || !roles.handGraft.inBodyBounds || !roles.handGraft.stumpCollapsed)) fail.push('hand graft not seated at the visual hand: ' + JSON.stringify(roles.handGraft));
if (roles.handGraft.rigsBuilt && roles.handGraft.handSpanWorld > 0.5) fail.push('grafted hand oversized (bone-frame leak): span ' + roles.handGraft.handSpanWorld);
if (roles.handGraft.rigsBuilt && (!roles.handGraft.axisKept || !roles.handGraft.backToCam)) fail.push('HAND POV ORIENTATION wrong (palm should face away from the dolly): ' + JSON.stringify(roles.handGraft));
if (!roles.stumpRestored) fail.push('feed loss did not restore stump hands / hide rigs');
if (!roles.fadesToRest) fail.push('FEED DEATH froze a stale pose (should fade to rest): ' + roles.fadeAng + '°');
if (!roles.revives) fail.push('drive did not revive after the pose lane came back');
if (!roles.leftHandRaised) fail.push('DRIVE CHIRALITY WRONG: raised real-left did not raise avatar left hand');
if (!roles.armsSpread) fail.push('LATERAL CHIRALITY WRONG: T-pose spread rendered crossed/knotted (hand span ' + roles.handSpan + ' vs shoulder span ' + roles.shoulderSpan + ')');
if (!roles.spreadLevel) fail.push('spread arms not level (asymmetric heights)');
if (!roles.noNaN) fail.push('driver produced NaN quaternions');
if (!roles.npcStillAnimating) fail.push('NPC clip stopped while user avatar synced (classes not parallel)');
if (!mind.fled) fail.push('NPC MIND: approach did not trigger flee (run + move away): d1 ' + mind.d1);
if (!mind.restored) fail.push('NPC MIND: reaction did not restore the idle clip (stack pop broken)');
if (!mind.statsDropped) fail.push('NPC MIND: reaction did not route stat deltas to avatar stats');
if (!mind.touched) fail.push('NPC MIND: hand-touch sensor did not fire / reach hp');
if (!mind.logKinds.includes('approach') || !mind.logKinds.includes('settle') || !mind.logKinds.includes('touch')) fail.push('NPC MIND: log missing lineage entries: ' + mind.logKinds);
if (mind.interactions < 2) fail.push('NPC MIND: world aggregate not counting: ' + mind.interactions);
if (mind.ui.chips.length !== 4 || mind.ui.sel !== '😨 skittish' || !/hp \d+/.test(mind.ui.info)) fail.push('NPC MIND UI wrong: ' + JSON.stringify(mind.ui));
if (!collide.separated) fail.push('coincident boxes were not separated');
if (!collide.outOfAvatar) fail.push('box allowed to interpenetrate avatar');
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ avatar class works — screenshot: avatar-engine.png');
process.exit(fail.length ? 1 : 0);
