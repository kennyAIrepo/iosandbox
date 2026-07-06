/** Node smoke test for the full-body stack: forge integrity + topology,
 *  skin weights, rig bind identity, rigid follow, world→avatar retarget,
 *  grounding/crouch, body colliders. No browser needed. */
import * as THREE from 'three';
import { forgeBody, extendPose, REST_BODY, BODY_BONES, BODY_RADII, HIP_MID, CHEST, HEAD_C, HEAD_TOP } from '../sdk/core/body-forge.js';
import { HoloBodyRig, BodyPose } from '../sdk/core/body-rig.js';
import { BodyBody } from '../sdk/core/game-physics.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.error(`  ✘ FAIL: ${name} ${extra}`); }
};

// ── 1. forge: surface, topology, weights ──
console.log('\n[body forge]');
let forged;
for (const style of ['standard', 'lite']) {
  const t0 = performance.now();
  const out = forgeBody({ style });
  if (style === 'standard') forged = out;
  const { geometry, skin, stats } = out;
  const vc = geometry.getAttribute('position').count;
  ok(vc > 2000, `${style}: verts=${vc} tris=${stats.tris}`, `(${Math.round(performance.now() - t0)}ms)`);
  const pos = geometry.getAttribute('position').array;
  let nan = 0, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < pos.length; i += 3) {
    if (!isFinite(pos[i]) || !isFinite(pos[i + 1]) || !isFinite(pos[i + 2])) nan++;
    minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
  }
  ok(nan === 0, `${style}: no NaN positions`);
  ok(minY > -0.05 && maxY > 1.7 && maxY < 2.0, `${style}: human-scale (y ${minY.toFixed(2)}…${maxY.toFixed(2)}m)`);
  // Euler characteristic — genus-0 single closed shell (no tunnels)
  const idx = geometry.index.array;
  const edges = new Set();
  for (let t = 0; t < idx.length; t += 3) {
    for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
      edges.add(Math.min(a, b) + '_' + Math.max(a, b));
    }
  }
  const chi = vc - edges.size + idx.length / 3;
  ok(chi === 2, `${style}: Euler χ = ${chi} (2 = genus-0, no tunnels)`);
  // weights normalized
  let wBad = 0;
  for (let v = 0; v < vc; v++) {
    const s = skin.weight[v * 3] + skin.weight[v * 3 + 1] + skin.weight[v * 3 + 2];
    if (Math.abs(s - 1) > 1e-4) wBad++;
  }
  ok(wBad === 0, `${style}: skin weights normalized`);
}

// ── 2. rig bind identity ──
console.log('\n[rig identity]');
const rig = new HoloBodyRig(null, {}).build('lite');
const restPts = REST_BODY.map(p => new THREE.Vector3(p[0], p[1], p[2]));
const bind = rig._restPos.slice();
rig.pose(restPts.map(p => p.clone()));
{
  const pos = rig.mesh.geometry.getAttribute('position').array;
  let maxDev = 0;
  for (let i = 0; i < pos.length; i++) maxDev = Math.max(maxDev, Math.abs(pos[i] - bind[i]));
  ok(maxDev < 1e-4, `identity pose deviation = ${maxDev.toExponential(2)}`);
}

// ── 3. rigid follow ──
console.log('\n[rig rigid-follow]');
{
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.7, -0.15));
  const t = new THREE.Vector3(0.8, 0.1, -1.4);
  rig.pose(restPts.map(p => p.clone().applyQuaternion(q).add(t)));
  const pos = rig.mesh.geometry.getAttribute('position').array;
  let maxDev = 0;
  const v = new THREE.Vector3();
  for (let i = 0; i < rig.vc; i += 53) {
    v.set(bind[i * 3], bind[i * 3 + 1], bind[i * 3 + 2]).applyQuaternion(q).add(t);
    maxDev = Math.max(maxDev,
      Math.abs(pos[i * 3] - v.x), Math.abs(pos[i * 3 + 1] - v.y), Math.abs(pos[i * 3 + 2] - v.z));
  }
  ok(maxDev < 2e-3, `rigid motion deviation = ${maxDev.toExponential(2)}`);
  ok(rig.anchors.chest.distanceTo(new THREE.Vector3(0, 1.42, 0).applyQuaternion(q).add(t)) < 1e-3, 'chest anchor follows');
}

// ── 4. extendPose synthetics ──
console.log('\n[extendPose]');
{
  const pts = REST_BODY.slice(0, 33).map(p => ({ x: p[0], y: p[1], z: p[2] }));
  extendPose(pts);
  ok(pts.length === 37, '33 → 37 points');
  ok(Math.abs(pts[HIP_MID].x) < 1e-9 && Math.abs(pts[HIP_MID].y - 0.95) < 1e-9, 'hip-mid centred');
  ok(Math.abs(pts[CHEST].y - 1.42) < 1e-9, 'chest at shoulder line');
  ok(pts[HEAD_TOP].y > pts[HEAD_C].y + 0.1, 'head-top above head-centre');
}

// ── 5. world → avatar retarget (Kinect spawn) ──
console.log('\n[retarget]');
{
  // synthesize MediaPipe-convention world landmarks from the rest pose:
  // origin at hips, x = person's left (+), y DOWN, z toward camera (nose < 0)
  const world = REST_BODY.slice(0, 33).map(p => ({ x: -p[0], y: -(p[1] - 0.95), z: -p[2] }));
  const img = REST_BODY.slice(0, 33).map(p => ({ x: 0.5 + p[0] * 0.3, y: 0.9 - p[1] * 0.45, z: 0 }));
  const bp = new BodyPose();
  const spawn = new THREE.Vector3(0, 0, 0);
  let out;
  for (let i = 0; i < 3; i++) out = bp.retarget(world, img, spawn, 0);
  ok(!!out && out.length === 37, 'produces 37 joints');
  let nan = 0;
  for (const p of out) if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) nan++;
  ok(nan === 0, 'no NaN joints');
  // bone lengths = the rig's own rest lengths (FK retarget contract)
  let maxLenErr = 0;
  for (let b = 0; b < BODY_BONES.length; b++) {
    const [i, j] = BODY_BONES[b];
    const live = out[i].distanceTo(out[j]);
    const rest = Math.hypot(REST_BODY[j][0] - REST_BODY[i][0], REST_BODY[j][1] - REST_BODY[i][1], REST_BODY[j][2] - REST_BODY[i][2]);
    maxLenErr = Math.max(maxLenErr, Math.abs(live - rest));
  }
  ok(maxLenErr < 1e-6, `bone lengths preserved (max err ${maxLenErr.toExponential(1)})`);
  // seen from behind: person's RIGHT wrist (16) on screen-right (+x)
  ok(out[16].x > 0.2 && out[15].x < -0.2, `right wrist at +x (${out[16].x.toFixed(2)}), left at −x (${out[15].x.toFixed(2)})`);
  // facing away: nose z smaller (further from camera) than chest z
  ok(out[0].z < out[CHEST].z + 1e-6, `faces −Z (nose z ${out[0].z.toFixed(3)} ≤ chest z ${out[CHEST].z.toFixed(3)})`);
  // grounded: feet near the floor
  let minY = 1e9; for (const fi of [29, 30, 31, 32]) minY = Math.min(minY, out[fi].y);
  ok(Math.abs(minY) < 0.12, `feet on the floor (min y ${minY.toFixed(3)})`);
  ok(out[HEAD_C].y > 1.45, `head at height (${out[HEAD_C].y.toFixed(2)}m)`);

  // crouch: a real squat BENDS the knees (thighs pitch forward, shins fold
  // back) — uniform y-scaling keeps legs straight and rest-length FK rightly
  // refuses to compress them, which is the correct predictive behaviour.
  const crouch = world.map((p) => ({ ...p }));
  for (const [K, A, HE, T] of [[25, 27, 29, 31], [26, 28, 30, 32]]) {
    crouch[K].y = 0.20; crouch[K].z = -0.30;     // knees rise + drive forward
    crouch[A].y = 0.42; crouch[A].z = -0.05;     // ankles tuck under the hips
    crouch[HE].y = 0.46; crouch[HE].z = -0.02;
    crouch[T].y = 0.44; crouch[T].z = -0.16;
  }
  for (let i = 0; i < 25; i++) out = bp.retarget(crouch, img, spawn, 0);
  ok(out[HIP_MID].y < 0.75, `squat lowers the hips (${out[HIP_MID].y.toFixed(2)}m < 0.95m rest)`);

  // lateral steer: step right in the image → avatar shifts +x
  const bp2 = new BodyPose();
  const imgR = img.map(p => ({ x: p.x + 0.22, y: p.y, z: 0 }));
  let out2;
  for (let i = 0; i < 3; i++) out2 = bp2.retarget(world, imgR, spawn, 0);
  ok(out2[HIP_MID].x > 0.15, `image step steers the avatar (+${out2[HIP_MID].x.toFixed(2)}m)`);
}

// ── 6. body collider ──
console.log('\n[body collider]');
{
  const bb = new BodyBody(BODY_RADII);
  const pts = REST_BODY.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  bb.update(pts, 1 / 60);
  ok(bb.present && Math.abs(bb.scale - 1) < 0.05, `present, scale=${bb.scale.toFixed(2)}`);
  ok(bb.jointsWithin(new THREE.Vector3(0, 1.2, 0), 0.05) > 0, 'torso point collides');
  ok(bb.jointsWithin(new THREE.Vector3(2, 1.2, 0), 0.05) === 0, 'far point clear');
  ok(bb.openness === 1 && bb.pinch === 0, 'never grabs (interface pinned open)');
  const snap = bb.snapshot({});
  ok(Math.abs(snap.chest.y - 1.42) < 1e-6, 'chest snapshot exposed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
