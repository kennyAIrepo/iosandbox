/** Node smoke test for the new hand stack (no browser/webcam needed). */
import * as THREE from 'three';
import { forgeHand } from '../sdk/core/hand-forge.js';
import { HoloHandRig } from '../sdk/core/hand-rig.js';
import { HandFilterBank, OneEuro } from '../sdk/core/filters.js';
import { HandViews } from '../sdk/core/hand-views.js';
import { REST_R42, REST_L42 } from '../sdk/core/hands.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.error(`  ✘ FAIL: ${name} ${extra}`); }
};

// ── 1. Forge all styles ──
console.log('\n[forge]');
for (const style of ['smooth', 'full', 'slim', 'lowpoly']) {
  const t0 = performance.now();
  const { geometry, skin, stats } = forgeHand({ rest: REST_R42, style });
  const vc = geometry.getAttribute('position').count;
  ok(vc > 500, `${style}: verts=${vc} tris=${stats.tris}`, `(${Math.round(performance.now() - t0)}ms)`);
  // weights sum to 1 (3 influences per vertex)
  let wBad = 0;
  for (let v = 0; v < vc; v++) {
    const s = skin.weight[v * 3] + skin.weight[v * 3 + 1] + skin.weight[v * 3 + 2];
    if (Math.abs(s - 1) > 1e-4) wBad++;
  }
  ok(wBad === 0, `${style}: skin weights normalized`);
  // no NaNs
  const pos = geometry.getAttribute('position').array;
  let nan = 0;
  for (let i = 0; i < pos.length; i++) if (!isFinite(pos[i])) nan++;
  ok(nan === 0, `${style}: no NaN positions`);
}

// ── 2. Rig identity: posing with the rest skeleton must reproduce bind pose ──
console.log('\n[rig identity]');
const rig = new HoloHandRig(REST_R42, null, { style: 'smooth' }).build();
const restLm = REST_R42.slice(0, 21).map(p => new THREE.Vector3(p[0], p[1], p[2]));
const bind = rig._restPos.slice();
rig.pose(restLm);
{
  const pos = rig.mesh.geometry.getAttribute('position').array;
  let maxDev = 0;
  for (let i = 0; i < pos.length; i++) maxDev = Math.max(maxDev, Math.abs(pos[i] - bind[i]));
  ok(maxDev < 1e-4, `identity pose deviation = ${maxDev.toExponential(2)}`);
}

// ── 3. Rigid motion: rotate+translate landmarks → mesh follows exactly ──
console.log('\n[rig rigid-follow]');
{
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.9, -0.3));
  const t = new THREE.Vector3(1.5, -0.7, 2.1);
  const lm2 = restLm.map(p => p.clone().applyQuaternion(q).add(t));
  rig.pose(lm2);
  const pos = rig.mesh.geometry.getAttribute('position').array;
  let maxDev = 0;
  const v = new THREE.Vector3();
  for (let i = 0; i < rig.vc; i += 97) {   // sample
    v.set(bind[i * 3], bind[i * 3 + 1], bind[i * 3 + 2]).applyQuaternion(q).add(t);
    maxDev = Math.max(maxDev,
      Math.abs(pos[i * 3] - v.x), Math.abs(pos[i * 3 + 1] - v.y), Math.abs(pos[i * 3 + 2] - v.z));
  }
  ok(maxDev < 1e-3, `rigid follow deviation = ${maxDev.toExponential(2)}`);
}

// ── 4. Scale: fingertip vertices land on scaled landmark tips ──
console.log('\n[rig fingertip alignment]');
{
  const lm3 = restLm.map(p => p.clone().multiplyScalar(2.2));
  rig.pose(lm3);
  const pos = rig.mesh.geometry.getAttribute('position').array;
  // nearest-vertex-to-tip distance should stay within ~1 fingertip radius × scale
  for (const tipIdx of [8, 12]) {
    const tip = lm3[tipIdx];
    let best = 1e9;
    for (let i = 0; i < rig.vc; i++) {
      const d = Math.hypot(pos[i * 3] - tip.x, pos[i * 3 + 1] - tip.y, pos[i * 3 + 2] - tip.z);
      if (d < best) best = d;
    }
    ok(best < 0.09 * 2.2, `tip ${tipIdx} → nearest vertex ${best.toFixed(4)}`);
  }
}

// ── 5. Fist pose (degenerate roll test): curl fingers toward palm, no NaN ──
console.log('\n[rig fist / roll fallback]');
{
  const palmN = new THREE.Vector3().crossVectors(
    restLm[5].clone().sub(restLm[0]), restLm[17].clone().sub(restLm[0])).normalize();
  const lmFist = restLm.map((p, i) => {
    if (i >= 6 && ![9, 13, 17, 5].includes(i)) return p.clone().addScaledVector(palmN, 0.25); // crude curl
    return p.clone();
  });
  rig.pose(lmFist);
  const pos = rig.mesh.geometry.getAttribute('position').array;
  let nan = 0;
  for (let i = 0; i < pos.length; i++) if (!isFinite(pos[i])) nan++;
  ok(nan === 0, 'fist pose: no NaN, roll fallback held');
}

// ── 6. Left chirality rig ──
console.log('\n[left hand]');
{
  const rigL = new HoloHandRig(REST_L42, null, { style: 'lowpoly' }).build();
  const lmL = REST_L42.slice(0, 21).map(p => new THREE.Vector3(p[0], p[1], p[2]));
  rigL.pose(lmL);
  const pos = rigL.mesh.geometry.getAttribute('position').array;
  let maxDev = 0;
  for (let i = 0; i < pos.length; i++) maxDev = Math.max(maxDev, Math.abs(pos[i] - rigL._restPos[i]));
  ok(maxDev < 1e-4, `left identity deviation = ${maxDev.toExponential(2)}`);
}

// ── 7. Pose speed ──
console.log('\n[perf]');
{
  const lm = restLm.map(p => p.clone());
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) {
    lm.forEach((p, i) => p.set(restLm[i].x + Math.sin(k * 0.1) * 0.02, restLm[i].y, restLm[i].z));
    rig.pose(lm);
  }
  const ms = (performance.now() - t0) / 200;
  ok(ms < 4, `pose = ${ms.toFixed(2)}ms/frame for ${rig.vc} verts`);
}

// ── 8. Filters ──
console.log('\n[filters]');
{
  const f = new OneEuro(1.4, 0.08);
  let x = f.filter(1, 0);
  for (let i = 0; i < 200; i++) x = f.filter(1 + (Math.random() - 0.5) * 0.002, 1 / 30);
  ok(Math.abs(x - 1) < 0.01, `one-euro jitter settles: ${x.toFixed(4)}`);
  const bank = new HandFilterBank();
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  let t = 0;
  for (let i = 0; i < 60; i++) { t += 33; lm.forEach(p => p.x += 0.004); bank.apply('Right', lm, t); }
  const meas = bank.apply('Right', lm, t + 33);
  const pred = bank.predicted('Right', 50);
  ok(pred[0].x > meas[0].x, `prediction leads motion: ${(pred[0].x - meas[0].x).toFixed(4)} ahead`);
}

// ── Synthetic physical RIGHT hand, palm toward camera, fingers up ──
// RAW image lm: x right, y down, z negative = closer to camera.
// Raw camera view of a right palm: thumb appears image-RIGHT.
function syntheticRightHand(cx = 0.30) {
  const rawPts = Array.from({ length: 21 }, (_, i) => ({ x: cx + i * 1e-4, y: 0.55 + i * 1e-4, z: 0 }));
  rawPts[0]  = { x: cx + 0.00, y: 0.70, z: 0 };
  rawPts[1]  = { x: cx + 0.05, y: 0.66, z: -0.008 };  // thumb CMC (rigid palm block, index side, slightly palmar)
  rawPts[2]  = { x: cx + 0.09, y: 0.61, z: -0.02 };   // thumb MCP
  rawPts[4]  = { x: cx + 0.12, y: 0.55, z: -0.04 };   // thumb tip
  rawPts[5]  = { x: cx + 0.06, y: 0.52, z: -0.01 };
  rawPts[9]  = { x: cx + 0.00, y: 0.50, z: 0 };
  rawPts[13] = { x: cx - 0.05, y: 0.52, z: 0 };
  rawPts[17] = { x: cx - 0.09, y: 0.55, z: 0.01 };
  rawPts[12] = { x: cx + 0.00, y: 0.30, z: -0.02 };
  return rawPts;
}
const mirrorImg = (raw) => raw.map(p => ({ x: 1 - p.x, y: p.y, z: p.z }));
const toWorld = (raw, cx) => raw.map(p => ({ x: (p.x - cx) * 0.5, y: (p.y - 0.55) * 0.5, z: (p.z || 0) * 0.5 }));
const chi = (pts, a, b, c, d) => {
  const A = new THREE.Vector3(pts[b].x - pts[a].x, pts[b].y - pts[a].y, pts[b].z - pts[a].z);
  const B = new THREE.Vector3(pts[c].x - pts[a].x, pts[c].y - pts[a].y, pts[c].z - pts[a].z);
  const C = new THREE.Vector3(pts[d].x - pts[a].x, pts[d].y - pts[a].y, pts[d].z - pts[a].z);
  return Math.sign(A.cross(B).dot(C));
};

// ── 9. View adapter: LABEL-FREE routing (measured chirality + screen slots) ──
console.log('\n[views]');
{
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 100);
  cam.position.set(0, 0, 0); cam.updateMatrixWorld();
  const views = new HandViews({ mode: 'mirror' });
  // physical right hand at raw x≈0.3 → mirrored to screen-right (x≈0.7).
  // REST_R42 is stored MIRROR-SPACE, so in the mirror the right hand
  // measures 'R' (same chirality as that rest mesh); in POV it drives 'L'.
  const rawR = syntheticRightHand(0.30);
  const imgR = mirrorImg(rawR);
  ok(views.imageChirality(imgR) === 'R', 'measured: right hand reads R in the mirror (REST_R42 is mirror-space)');
  let packs = views.resolve([{ img: imgR, world: null }], cam);
  ok(packs.R && packs.R[0].x > 0, `mirror: right hand → R mesh at screen-right (x=${packs.R?.[0].x.toFixed(2)})`);
  views.setMode('firstPerson');
  cam.position.set(0, 1.6, 2.2); cam.lookAt(0, 1.25, -2); cam.updateMatrixWorld();
  packs = views.resolve([{ img: imgR, world: null }], cam);
  ok(packs.L && packs.L[0].x > cam.position.x, `firstPerson: right hand → L mesh right of camera (x=${packs.L?.[0].x.toFixed(2)})`);
  views.setMode('thirdPerson');
  packs = views.resolve([{ img: imgR, world: null }], cam);
  ok(packs.L && packs.L[0].x > 0, `thirdPerson: right hand → L mesh at avatar right (x=${packs.L?.[0].x.toFixed(2)})`);
}

// ── 10. Predictive POV: FK preset retarget shows the OPPOSITE side ──
console.log('\n[predictive pov]');
{
  const rawPts = syntheticRightHand(0.30);
  const img = mirrorImg(rawPts);
  const world = toWorld(rawPts, 0.30);

  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 100);
  cam.position.set(0, 1.6, 0); cam.lookAt(0, 1.6, -2); cam.updateMatrixWorld();
  const views = new HandViews({ mode: 'firstPerson' });
  const packs = views.resolve([{ img, world }], cam);
  const P = packs.L;   // physical right hand → L mesh in POV (see naming pitfall)
  ok(!!P, 'pov: world path resolved to L mesh (measured chirality)');
  if (P) {
    // Eye looks along −z. Palm faced the CAMERA → eye must see the BACK.
    const u = P[5].clone().sub(P[0]), v = P[17].clone().sub(P[0]);
    const palmarN = u.clone().cross(v);
    const eyeFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    ok(palmarN.dot(eyeFwd) > 0, `pov: dorsum toward eye (palmar·fwd=${palmarN.dot(eyeFwd).toFixed(3)} > 0)`);
    // Right hand seen from behind: thumb on the LEFT of that hand.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const thumbSide = P[4].clone().sub(P[9]).dot(right);
    ok(thumbSide < 0, `pov: thumb on hand's left from behind (${thumbSide.toFixed(3)} < 0)`);
    ok(P[12].y > P[0].y, 'pov: fingers up stay up');
    const phys = rawPts.map(p => ({ x: p.x, y: -p.y, z: -(p.z || 0) }));   // chirality-true camera frame
    ok(chi(phys, 0, 5, 17, 4) === chi(P, 0, 5, 17, 4), 'pov: chirality preserved (no mirror)');
    // FK preset proportions: every bone has EXACT rest length × povHandScale.
    const restLen = Math.hypot(REST_R42[9][0] - REST_R42[0][0], REST_R42[9][1] - REST_R42[0][1], REST_R42[9][2] - REST_R42[0][2]);
    const got = P[9].distanceTo(P[0]);
    const want = restLen * views.cfg.povHandScale;
    ok(Math.abs(got - want) < 1e-6, `pov: preset skeleton span exact (${got.toFixed(4)} = ${want.toFixed(4)})`);
  }
}

// ── 11. TWO HANDS NEVER CROSS (slot clamping) ──
console.log('\n[no crossing]');
{
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 100);
  cam.position.set(0, 1.6, 0); cam.lookAt(0, 1.6, -2); cam.updateMatrixWorld();
  const views = new HandViews({ mode: 'firstPerson' });
  // physical right at raw x 0.3 (screen-right mirrored), physical left = mirror of it at raw x 0.7
  const rawR = syntheticRightHand(0.30);
  const rawL = rawR.map(p => ({ x: 1 - p.x, y: p.y, z: p.z }));      // true left hand raw
  const handR = { img: mirrorImg(rawR), world: toWorld(rawR, 0.30) };
  const handL = { img: mirrorImg(rawL), world: toWorld(rawL, 0.70) };
  const packs = views.resolve([handL, handR], cam);                   // order shouldn't matter
  ok(packs.R && packs.L, 'both meshes driven');
  if (packs.R && packs.L) {
    const bySlot = (p, s) => p.hands.find(h => h.slot === s);
    const rSlot = bySlot(packs, 'right'), lSlot = bySlot(packs, 'left');
    ok(rSlot.points[0].x > lSlot.points[0].x,
      `right-slot hand stays right of left-slot hand (${rSlot.points[0].x.toFixed(2)} > ${lSlot.points[0].x.toFixed(2)})`);
    // physical right (screen-right) drives mesh L in POV; physical left drives R
    const meta = packs.hands.map(h => h.mesh + ':' + h.slot).join(' ');
    ok(rSlot.mesh === 'L' && lSlot.mesh === 'R', `POV chirality per slot correct (${meta})`);
    // EXTREME wrists (both shoved toward centre) still cannot cross
    const squeeze = (h, x) => ({ img: h.img.map((p, i) => (i === 0 ? { x, y: p.y, z: p.z } : p)), world: h.world });
    const p2 = views.resolve([squeeze(handL, 0.62), squeeze(handR, 0.38)], cam);
    const r2 = bySlot(p2, 'right'), l2 = bySlot(p2, 'left');
    if (r2 && l2) ok(r2.points[0].x > l2.points[0].x, `clamped: still uncrossed when wrists overlap centre (${r2.points[0].x.toFixed(2)} > ${l2.points[0].x.toFixed(2)})`);
    else ok(false, 'clamped resolve missing packs');
  }
}

// ── 11b. Z-calibration self-correction: inverted-depth entry converges ──
console.log('\n[z self-correction]');
{
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 100);
  cam.position.set(0, 1.6, 0); cam.lookAt(0, 1.6, -2); cam.updateMatrixWorld();
  const views = new HandViews({ mode: 'firstPerson' });
  const rawPts = syntheticRightHand(0.30);
  const img = mirrorImg(rawPts);
  // world cloud with the OPPOSITE z convention (the case that once latched
  // a hand permanently palm-out) — calibration must flip it back
  const worldInv = toWorld(rawPts, 0.30).map(p => ({ x: p.x, y: p.y, z: -p.z }));
  let P = null;
  for (let f = 0; f < 6; f++) P = views.resolve([{ img, world: worldInv }], cam).L;
  ok(!!P, 'zcal: resolved');
  if (P) {
    const u = P[5].clone().sub(P[0]), v = P[17].clone().sub(P[0]);
    const palmarN = u.clone().cross(v);
    const eyeFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    ok(palmarN.dot(eyeFwd) > 0, `zcal: dorsum toward eye despite inverted input (${palmarN.dot(eyeFwd).toFixed(3)} > 0)`);
  }
}

// ── 12. Anatomical clamps: impossible fist can't fold through the palm ──
console.log('\n[joint clamps]');
{
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 100);
  cam.position.set(0, 1.6, 0); cam.lookAt(0, 1.6, -2); cam.updateMatrixWorld();
  const views = new HandViews({ mode: 'firstPerson' });
  const rawPts = syntheticRightHand(0.30);
  // corrupt the middle finger like occluded-fist tracking: fold PIP ~175°
  // (through the palm) — physically impossible
  rawPts[9]  = { x: 0.30, y: 0.50, z: 0 };       // MCP
  rawPts[10] = { x: 0.30, y: 0.40, z: 0 };       // PIP: proximal points up
  rawPts[11] = { x: 0.30, y: 0.495, z: 0.005 };  // DIP: folded ~175° back down
  rawPts[12] = { x: 0.30, y: 0.59, z: 0.01 };    // tip: deep "through the palm"
  const img = mirrorImg(rawPts);
  const world = toWorld(rawPts, 0.30);
  const packs = views.resolve([{ img, world }], cam);
  const P = packs.L;
  ok(!!P, 'clamp: resolved');
  if (P) {
    const dir = (a, b) => P[b].clone().sub(P[a]).normalize();
    const bendPIP = dir(9, 10).angleTo(dir(10, 11));
    const bendDIP = dir(10, 11).angleTo(dir(11, 12));
    ok(bendPIP <= 1.96, `clamp: PIP bend bounded (${(bendPIP * 180 / Math.PI).toFixed(0)}° ≤ 112°)`);
    ok(bendDIP <= 1.46, `clamp: DIP bend bounded (${(bendDIP * 180 / Math.PI).toFixed(0)}° ≤ 83°)`);
  }
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
