/**
 * wrist ROM clamp smoke test — rebuilds the REAL brunette skeleton
 * (tests/fixtures/brunette_graph.json world rest positions) as THREE bones,
 * binds the actual BipedDriver, then feeds synthetic hand world landmarks
 * crafted to demand IMPOSSIBLE wrist poses (180° twist, folded-flat 170°
 * flexion, 80° deviation — the artifacts humanlab showed) and asserts the
 * solved wrist stays inside human range:
 *
 *   twist ≤ twistDeg (palm never candy-wrapper twisted vs the forearm)
 *   flexion/extension ≤ 90° each way, never past (no flat/knotted wrist)
 *   radial/ulnar deviation ≤ devDeg
 *   ...while a LEGAL 40° flexion still moves the wrist (clamp ≠ freeze).
 *
 *   node tests/wrist-clamp-smoke.mjs   (needs npm i — three is a devDep)
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { BipedDriver } from '../sdk/interaction/body-drive.js';

const readJson = u => JSON.parse(readFileSync(u, 'utf8').replace(/^﻿/, ''));
const graph = readJson(new URL('./fixtures/brunette_graph.json', import.meta.url));

// ── rebuild the skeleton: identity rotations, local pos = world − parent world ──
const scene = new THREE.Group();
const byName = {};
for (const n of graph) { const b = new THREE.Bone(); b.name = n.name; byName[n.name] = b; }
for (const n of graph) {
  const b = byName[n.name];
  const pw = n.parent ? graph.find(g => g.name === n.parent).pos : [0, 0, 0];
  b.position.set(n.pos[0] - pw[0], n.pos[1] - pw[1], n.pos[2] - pw[2]);
  (n.parent ? byName[n.parent] : scene).add(b);
}
scene.updateMatrixWorld(true);

const driver = new BipedDriver().bind(scene);
const st = driver._hand.R;

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}${detail ? '  (' + detail + ')' : ''}`);
  else { console.error(`FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); fails++; }
};

ok('hand R bound', !!st && st.bone === 'RightHand', st?.bone);
ok('palm axes captured at bind', !!(st?.axX && st?.axY && st?.axZ));

// ── same palm-basis formula as the driver (test-side reference copy) ──
function palmQuat(W, I, M, P) {
  const y = new THREE.Vector3().subVectors(M, W).normalize();
  const z = new THREE.Vector3().crossVectors(y, new THREE.Vector3().subVectors(I, P)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
const wpos = n => new THREE.Vector3().setFromMatrixPosition(byName[n].matrixWorld);

// avatar rest palm basis (world) — targets are rotations OF this basis
const qRest0 = palmQuat(wpos('RightHand'), wpos(st.index), wpos(st.middle), wpos(st.pinky));

// hand world landmarks whose MAPPED palm basis equals qRest0 ∘ R.
// mapPoint scales by mapSigns*zScale, so emit mapped-space points and unmap.
const s = driver.opts.mapSigns, zs = driver.opts.zScale;
const unmap = p => ({ x: p.x / s[0], y: p.y / s[1], z: p.z / (s[2] * zs) });
function makeHand(R, thumbFz = THUMB_FZ) {
  const q = qRest0.clone().multiply(R);
  const X = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const Y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const Z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const at = (fy, fx, fz = 0) => unmap(new THREE.Vector3()
    .addScaledVector(Y, fy * 0.1).addScaledVector(X, fx * 0.1).addScaledVector(Z, fz * 0.1));
  const lm = Array.from({ length: 21 }, () => at(0, 0));
  // _palmQuat bases always carry index−pinky along −x (z = y×(I−P), x = y×z),
  // so index sits at NEGATIVE x — +x here builds a 180°-twisted hand (the
  // first run of this test did exactly that, and the clamp caught it)
  const F = { thumb: -0.5, index: -0.25, middle: 0, ring: 0.25, pinky: 0.5 };
  const chains = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12],
                   ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
  for (const [f, pts] of Object.entries(chains)) {
    // thumb rides off-plane (volar, like a real thumb) — the z-convention
    // calibration needs a non-planar palm block to measure chirality
    pts.forEach((p, i) => { lm[p] = at(0.9 + i * 0.25, F[f], f === 'thumb' ? thumbFz : 0); });
  }
  return lm;
}
// pick the thumb side that gives the synthetic cloud the avatar hand's own
// chirality under the CORRECT z convention (same measure the driver uses)
const sv = (p0, a, b, c) => {
  const A = [a.x - p0.x, a.y - p0.y, a.z - p0.z], B = [b.x - p0.x, b.y - p0.y, b.z - p0.z],
        C = [c.x - p0.x, c.y - p0.y, c.z - p0.z];
  return (A[1] * B[2] - A[2] * B[1]) * C[0] + (A[2] * B[0] - A[0] * B[2]) * C[1] +
         (A[0] * B[1] - A[1] * B[0]) * C[2];
};
const cloudSign = lm => Math.sign((sv(lm[0], lm[5], lm[17], lm[1]) +
  sv(lm[0], lm[5], lm[17], lm[2])) * Math.sign(s[0] * s[1] * s[2]));
const THUMB_FZ = cloudSign(makeHand(new THREE.Quaternion(), 0.5)) === st.chirSign ? 0.5 : -0.5;

// drive one crafted hand to convergence (handTau smoothing needs frames);
// handedness 'Left' = human L → avatar R under the default selfie mirror.
// xform mutates the feed (e.g. simulate a device with a flipped z axis).
function solve(R, xform = l => l) {
  st.lastT = 0; driver._hfilt.drop('R');       // fresh solve per case
  st.zAcc = 0; st.zs = 1;                      // fresh z-convention calibration
  for (const b of Object.values(byName)) if (driver.rest[b.name]) b.quaternion.copy(driver.rest[b.name]);
  scene.updateMatrixWorld(true);
  let now = performance.now();
  for (let i = 0; i < 90; i++) {
    now += 16.7;
    driver.update(null, {}, null, null, 1 / 60, now, [xform(makeHand(R))], ['Left']);
  }
}

// decompose the SOLVED wrist local rotation-from-rest about the palm axes
function measure() {
  const hb = byName['RightHand'];
  const r = driver.rest['RightHand'].clone().invert().multiply(hb.quaternion);
  if (r.w < 0) { r.x *= -1; r.y *= -1; r.z *= -1; r.w *= -1; }
  const proj = r.x * st.axY.x + r.y * st.axY.y + r.z * st.axY.z;
  const twist = 2 * Math.atan2(proj, r.w);
  const yNew = st.axY.clone().applyQuaternion(r);
  return {
    twist: twist / Math.PI * 180,
    flex: Math.asin(Math.min(1, Math.max(-1, yNew.dot(st.axZ)))) / Math.PI * 180,
    dev: Math.asin(Math.min(1, Math.max(-1, yNew.dot(st.axX)))) / Math.PI * 180,
    past90: yNew.dot(st.axY) < -1e-6,
    total: 2 * Math.acos(Math.min(1, Math.abs(r.w))) / Math.PI * 180
  };
}
const rot = (x, y, z, deg) =>
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z), deg * Math.PI / 180);
const W = driver.opts.wrist, EPS = 1.5;   // deg tolerance (smoothing tail)

// 1 · sane input passes through ≈ unchanged
solve(new THREE.Quaternion());
let m = measure();
ok('identity → wrist stays at rest', m.total < EPS, `total ${m.total.toFixed(2)}°`);

// 2 · 180° axial twist (the candy-wrapper knot) → clamped to twistDeg
solve(rot(0, 1, 0, 180));
m = measure();
ok(`180° twist clamped ≤ ${W.twistDeg}°`, Math.abs(m.twist) <= W.twistDeg + EPS,
   `twist ${m.twist.toFixed(1)}°`);
ok('twisted input never bends past 90°', !m.past90);

// 3 · 170° flexion (hand folded flat on forearm) → SATURATES at 90°
solve(rot(1, 0, 0, 170));
m = measure();
ok('170° flexion saturates at 90° (never flat/knot)',
   !m.past90 && Math.abs(m.flex) >= 90 - EPS && Math.abs(m.flex) <= 90 + EPS,
   `flex ${m.flex.toFixed(1)}°`);

// 4 · 80° deviation → clamped to devDeg
solve(rot(0, 0, 1, 80));
m = measure();
ok(`80° deviation clamped ≤ ${W.devDeg}°`, Math.abs(m.dev) <= W.devDeg + EPS,
   `dev ${m.dev.toFixed(1)}°`);

// 5 · LEGAL 40° flexion still tracks — the clamp must not freeze the wrist
solve(rot(1, 0, 0, 40));
m = measure();
ok('legal 40° flexion still moves the wrist', Math.abs(m.flex) > 20 && Math.abs(m.flex) <= 90,
   `flex ${m.flex.toFixed(1)}°`);
const flexSign = Math.sign(m.flex), flexMag = Math.abs(m.flex);
ok('correct-convention feed keeps zs=+1', st.zs === 1);

// 6 · palm-flip glitch (edge-on misdetect: normal inverted + twisted) stays sane
solve(rot(0, 1, 0, 180).multiply(rot(1, 0, 0, 170)));
m = measure();
ok('flip glitch stays inside ROM', !m.past90 && Math.abs(m.twist) <= W.twistDeg + EPS &&
   Math.abs(m.dev) <= W.devDeg + EPS, `twist ${m.twist.toFixed(1)}° dev ${m.dev.toFixed(1)}°`);

// 7 · DEVICE WITH FLIPPED WORLD-Z (the humanlab palm-out bug): identical
// poses arrive with z negated — without measured-chirality calibration the
// palm basis inverts and the avatar hand locks palm-out with mirrored bends.
const zflip = lm => lm.map(p => ({ x: p.x, y: p.y, z: -p.z }));
solve(new THREE.Quaternion(), zflip);
m = measure();
ok('flipped-z device: zs latches −1', st.zs === -1);
ok('flipped-z device: identity stays at rest (no palm-out)', m.total < EPS,
   `total ${m.total.toFixed(2)}°`);

solve(rot(1, 0, 0, 40), zflip);
m = measure();
ok('flipped-z device: 40° flexion tracks with the SAME sign (bends not mirrored)',
   Math.sign(m.flex) === flexSign && Math.abs(Math.abs(m.flex) - flexMag) < EPS,
   `flex ${m.flex.toFixed(1)}° vs ${flexSign * flexMag}°`);

// 8 · ARM MOTION must not corrupt the hand: same hand feed, arm rotated
// mid-stream — the wrist's WORLD orientation must stay glued to the palm
// basis. (The old code smoothed a delta against a live avatar reference;
// the moving arm turned stale deltas into claw poses.)
{
  solve(new THREE.Quaternion());                 // converge, arm at rest
  byName['RightShoulder'].quaternion.multiply(rot(1, 0, 0, 15));   // pose-lane "moves"
  const fixed = makeHand(new THREE.Quaternion());
  let t = performance.now() + 1e6;
  for (let i = 0; i < 30; i++) { t += 16.7; driver.update(null, {}, null, null, 1 / 60, t, [fixed], ['Left']); }
  const qDes = qRest0.clone().multiply(st.qOff);   // absolute target: palm ∘ bind offset
  const qGot = byName['RightHand'].getWorldQuaternion(new THREE.Quaternion());
  const err = 2 * Math.acos(Math.min(1, Math.abs(qGot.dot(qDes)))) / Math.PI * 180;
  ok('arm moved mid-stream: hand WORLD orientation stays glued to the palm basis',
     err < EPS, `err ${err.toFixed(2)}°`);
  byName['RightShoulder'].quaternion.copy(driver.rest['RightShoulder']);
}

// finger bones stayed finite through the palm-space retarget
const badFinger = Object.values(driver.fingers.R).flat()
  .some(n => [...byName[n].quaternion].some(c => !Number.isFinite(c)));
ok('finger quats finite after palm-space retarget', !badFinger);

if (fails) { console.error(`\n${fails} FAILURES`); process.exit(1); }
console.log('\nall green — wrist stays inside human ROM under impossible inputs, tracks legal ones');
