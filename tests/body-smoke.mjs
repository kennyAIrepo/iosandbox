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

  // COMPLETENESS: every one of the 37 points must be real. The FK only
  // writes bone children — face ring, pinky/thumb MCPs and heels come
  // from the AUX pass (regression: they sat at the ORIGIN, so extendPose
  // rebuilt the head from origin-ears — the head smeared into a vertical
  // beam through the body core — and the attached hand frames used an
  // origin pinky — giant, crossed hands).
  for (let i = 0; i < 3; i++) out = bp.retarget(world, img, spawn, 0);
  let faceBad = 0;
  for (let j = 0; j <= 10; j++) if (out[j].distanceTo(out[HEAD_C]) > 0.25) faceBad++;
  ok(faceBad === 0, 'face ring rides the head (no origin landmarks)');
  ok(out[7].y > out[11].y, `ears above the shoulder line (${out[7].y.toFixed(2)} > ${out[11].y.toFixed(2)})`);
  ok(out[17].distanceTo(out[15]) < 0.16 && out[21].distanceTo(out[15]) < 0.16, 'pinky/thumb MCPs ride the left wrist');
  ok(out[18].distanceTo(out[16]) < 0.16 && out[22].distanceTo(out[16]) < 0.16, 'pinky/thumb MCPs ride the right wrist');
  ok(out[29].distanceTo(out[27]) < 0.12 && out[30].distanceTo(out[28]) < 0.12, 'heels ride the ankles');

  // lateral steer: step right in the image → avatar shifts +x
  const bp2 = new BodyPose();
  const imgR = img.map(p => ({ x: p.x + 0.22, y: p.y, z: 0 }));
  let out2;
  for (let i = 0; i < 3; i++) out2 = bp2.retarget(world, imgR, spawn, 0);
  ok(out2[HIP_MID].x > 0.15, `image step steers the avatar (+${out2[HIP_MID].x.toFixed(2)}m)`);
}

// ── 4b. skin-weight regions: torso skin must NEVER bind arm bones ──
// (the waist-shard bug: A-pose wrists hang beside the hips, raw inverse-d²
// weights let forearm/hand bones capture waist/chest skin — raising the
// arms then dragged torso shards up with them)
console.log('\n[weight regions]');
{
  const { geometry, skin } = forged;
  const pos = geometry.getAttribute('position');
  const ARM_BONES = new Set([5, 6, 7, 8, 9, 10]);   // upper arms, forearms, hand paddles
  let leaks = 0, checked = 0;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v), y = pos.getY(v);
    // torso core band — BELOW the deltoid/armpit junction (y>1.2 is the
    // anatomical shoulder blend, where arm influence is the point)
    if (Math.abs(x) > 0.19 || y < 0.8 || y > 1.2) continue;
    checked++;
    for (let k = 0; k < 3; k++) {
      if (skin.weight[v * 3 + k] > 0.01 && ARM_BONES.has(skin.index[v * 3 + k])) leaks++;
    }
  }
  ok(checked > 300, `torso-core band sampled (${checked} verts)`);
  ok(leaks === 0, `no arm-bone influence on torso skin (${leaks} leaks)`);
}

// ── 4c. arms raised: waist and head stay put ──
console.log('\n[arms-up rigidity]');
{
  const up = restPts.map(p => p.clone());
  // Y-pose: both arms overhead; every trunk/leg point untouched
  up[13].set(-0.32, 1.62, 0.01); up[14].set(0.32, 1.62, 0.01);      // elbows
  up[15].set(-0.36, 1.88, 0.02); up[16].set(0.36, 1.88, 0.02);      // wrists
  up[17].set(-0.375, 1.985, 0.018); up[18].set(0.375, 1.985, 0.018);
  up[19].set(-0.355, 1.99, 0.05); up[20].set(0.355, 1.99, 0.05);
  up[21].set(-0.325, 1.96, 0.05); up[22].set(0.325, 1.96, 0.05);
  rig.pose(restPts.map(p => p.clone()));   // re-bind reference
  const bindPos = rig.mesh.geometry.getAttribute('position').array.slice();
  rig.pose(up);
  const pos = rig.mesh.geometry.getAttribute('position').array;
  let waistMax = 0, headMax = 0;
  for (let v = 0; v < rig.vc; v++) {
    const bx = bindPos[v * 3], by = bindPos[v * 3 + 1], bz = bindPos[v * 3 + 2];
    const d = Math.hypot(pos[v * 3] - bx, pos[v * 3 + 1] - by, pos[v * 3 + 2] - bz);
    if (Math.abs(bx) < 0.2 && by > 0.8 && by < 1.1) waistMax = Math.max(waistMax, d);
    if (by > 1.55 && Math.abs(bx) < 0.15) headMax = Math.max(headMax, d);
  }
  ok(waistMax < 0.03, `arms overhead: waist stays put (max drift ${(waistMax * 100).toFixed(1)}cm)`);
  ok(headMax < 0.02, `arms overhead: head stays put (max drift ${(headMax * 100).toFixed(1)}cm)`);
}

// ── 4d. attached hand meshes (the real hand forge at the wrists) ──
console.log('\n[body hands]');
{
  rig.pose(restPts.map(p => p.clone()));
  ok(!!rig._hands && !!rig._hands.left.mesh && !!rig._hands.right.mesh, 'hand meshes attached');
  const map = (pack, i, side) => new THREE.Vector3(pack[i][0], pack[i][1], pack[i][2])
    .applyMatrix4(rig._hands[side].mesh.matrix);
  const { REST_R42: R42, REST_L42: L42 } = await import('../sdk/core/hands.js');
  // wrist lands exactly on the body wrist landmark
  ok(map(L42, 0, 'left').distanceTo(restPts[15]) < 1e-3, 'left hand wrist seated on body wrist');
  ok(map(R42, 0, 'right').distanceTo(restPts[16]) < 1e-3, 'right hand wrist seated on body wrist');
  // chirality: the pack's thumb tip lands nearer the body THUMB landmark than the pinky
  const lThumb = map(L42, 4, 'left'), rThumb = map(R42, 4, 'right');
  ok(lThumb.distanceTo(restPts[21]) < lThumb.distanceTo(restPts[17]),
    'left hand chirality (thumb on the thumb side)');
  ok(rThumb.distanceTo(restPts[22]) < rThumb.distanceTo(restPts[18]),
    'right hand chirality (thumb on the thumb side)');
  // proportion: hand span mapped to the body's wrist→MCP span
  const lMid = new THREE.Vector3((L42[5][0] + L42[17][0]) / 2, (L42[5][1] + L42[17][1]) / 2, (L42[5][2] + L42[17][2]) / 2)
    .applyMatrix4(rig._hands.left.mesh.matrix);
  const bodyMid = restPts[17].clone().add(restPts[19]).multiplyScalar(0.5);
  ok(lMid.distanceTo(bodyMid) < 0.01, `hand scaled to body proportions (MCP err ${(lMid.distanceTo(bodyMid) * 1000).toFixed(1)}mm)`);
  ok(rig._hands.left.mesh.material === rig.mesh.material, 'hands share the body material (look/alpha in lockstep)');

  // LIVE PATH: pose the BACK-BIND rig straight from a retarget output.
  // The retarget skeleton is a z-REFLECTION of the mirror-space rest pose
  // (person seen from behind) — a front-bound LBS cannot follow it
  // (horizontal bones roll 180° → pinched bowtie torso), so the POV rig
  // binds to the reflected rest. Rest-fed retarget must then be a near-
  // IDENTITY of that bind.
  const world = REST_BODY.slice(0, 33).map(p => ({ x: -p[0], y: -(p[1] - 0.95), z: -p[2] }));
  const img = REST_BODY.slice(0, 33).map(p => ({ x: 0.5 + p[0] * 0.3, y: 0.9 - p[1] * 0.45, z: 0 }));
  const bpLive = new BodyPose();
  let outLive, t = 0;
  for (let i = 0; i < 30; i++) { outLive = bpLive.retarget(world, img, new THREE.Vector3(0, 0, 0), 0, null, t); t += 1 / 30; }
  const rigB = new HoloBodyRig(null, { back: true }).build('lite');
  const bindB = rigB._restPos.slice();
  rigB.pose(outLive);
  {
    const pos = rigB.mesh.geometry.getAttribute('position').array;
    // rest-fed retarget ≈ bind (grounding may shift y a few mm — allow 3cm)
    let maxDev = 0;
    for (let i = 0; i < pos.length; i++) maxDev = Math.max(maxDev, Math.abs(pos[i] - bindB[i]));
    ok(maxDev < 0.03, `back bind: rest retarget ≈ identity (max dev ${(maxDev * 100).toFixed(1)}cm — no torso pinch)`);
    // shoulder width preserved (the pinch collapsed it before)
    ok(rigB.anchors.chest.distanceTo(new THREE.Vector3(0, 1.42, 0)) < 0.05, 'chest anchor at rest height');
  }
  const hL = rigB._hands.left;
  ok(hL.s > hL.base * 0.6 && hL.s < hL.base * 1.4,
    `retargeted hand scale anatomical (${hL.s.toFixed(3)} ≈ base ${hL.base.toFixed(3)})`);
  // chirality on the back bind: the left SIDE uses the R pack (reflection
  // swaps chirality) — its mapped thumb must land on the body's thumb side
  const map2 = (pack, i) => new THREE.Vector3(pack[i][0], pack[i][1], pack[i][2]).applyMatrix4(rigB._hands.left.mesh.matrix);
  const thumbW = map2(R42, 4);
  ok(thumbW.distanceTo(outLive[21]) < thumbW.distanceTo(outLive[17]),
    'back-bind left hand chirality (thumb on the thumb side)');
}

// ── 4e. feet are wedges, not nubs ──
console.log('\n[foot shape]');
{
  const pos = forged.geometry.getAttribute('position');
  let minZ = 1e9, maxZ = -1e9, maxY = -1e9;
  for (let v = 0; v < pos.count; v++) {
    if (pos.getY(v) > 0.12 || pos.getX(v) > 0) continue;   // left foot region
    minZ = Math.min(minZ, pos.getZ(v)); maxZ = Math.max(maxZ, pos.getZ(v));
    maxY = Math.max(maxY, pos.getY(v));
  }
  ok(maxZ - minZ > 0.19, `foot has heel→toe length (${((maxZ - minZ) * 100).toFixed(0)}cm)`);
  ok(maxZ > REST_BODY[31][2] + 0.005, 'toe cap extends past the toe landmark');
}

// ── 5b. shadow silhouette look (Kinect read) ──
console.log('\n[silhouette look]');
{
  const rig2 = new HoloBodyRig(null, { look: 'shadow' }).build('lite');
  ok(rig2.mesh.material.fragmentShader.includes('uCore'), 'shadow look builds the silhouette material');
  ok(!!rig2._aura && rig2._aura.visible, 'aura hull present + visible in shadow look');
  ok(rig2._aura.geometry === rig2.mesh.geometry, 'aura shares the deforming geometry');
  ok(rig2._aura.material.blending === THREE.AdditiveBlending && rig2._aura.material.side === THREE.BackSide,
    'aura = additive inverted hull (order-independent halo)');
  ok(rig2.mesh.material.depthWrite === true, 'core writes depth (single flat alpha layer)');
  rig2.pose(restPts.map(p => p.clone()));
  let nan = 0;
  const pos2 = rig2.mesh.geometry.getAttribute('position').array;
  for (let i = 0; i < pos2.length; i++) if (!isFinite(pos2[i])) nan++;
  ok(nan === 0, 'poses cleanly under the silhouette material');
  rig2.setLook('ghost');
  ok(!rig2.mesh.material.fragmentShader.includes('uCore') && !rig2._aura.visible, 'setLook swaps back to holo');
  rig2.setLook('shadow');
  ok(rig2.mesh.material.fragmentShader.includes('uCore') && rig2._aura.visible, 'and forward again, live');
}

// ── 5c. silhouette size (UI scale) ──
console.log('\n[retarget size]');
{
  const world = REST_BODY.slice(0, 33).map(p => ({ x: -p[0], y: -(p[1] - 0.95), z: -p[2] }));
  const img = REST_BODY.slice(0, 33).map(p => ({ x: 0.5 + p[0] * 0.3, y: 0.9 - p[1] * 0.45, z: 0 }));
  const bp = new BodyPose();
  bp.size = 1.3;
  const spawn = new THREE.Vector3(0, 0, 0);
  let out, t = 0;
  for (let i = 0; i < 25; i++) { out = bp.retarget(world, img, spawn, 0, null, t); t += 1 / 30; }
  let maxLenErr = 0;
  for (let b = 0; b < BODY_BONES.length; b++) {
    const [i, j] = BODY_BONES[b];
    const rest = Math.hypot(REST_BODY[j][0] - REST_BODY[i][0], REST_BODY[j][1] - REST_BODY[i][1], REST_BODY[j][2] - REST_BODY[i][2]);
    maxLenErr = Math.max(maxLenErr, Math.abs(out[i].distanceTo(out[j]) - rest * 1.3));
  }
  ok(maxLenErr < 1e-6, `bone lengths scale with size (max err ${maxLenErr.toExponential(1)})`);
  ok(out[HEAD_C].y > 1.9, `1.3× body is taller (head ${out[HEAD_C].y.toFixed(2)}m)`);
  let minY = 1e9; for (const fi of [29, 30, 31, 32]) minY = Math.min(minY, out[fi].y);
  ok(Math.abs(minY) < 0.15, `feet still grounded at 1.3× (min y ${minY.toFixed(3)})`);
}

// ── 5d. jump inference (image hips launch ⇒ body lifts) ──
console.log('\n[jump inference]');
{
  const world = REST_BODY.slice(0, 33).map(p => ({ x: -p[0], y: -(p[1] - 0.95), z: -p[2] }));
  const mkImg = (lift) => REST_BODY.slice(0, 33).map(p => ({ x: 0.5 + p[0] * 0.3, y: 0.9 - p[1] * 0.45 - lift, z: 0 }));
  const bp = new BodyPose();
  const spawn = new THREE.Vector3(0, 0, 0);
  let out, t = 0;
  const step = (lift) => { out = bp.retarget(world, mkImg(lift), spawn, 0, null, t); t += 1 / 30; };
  for (let i = 0; i < 30; i++) step(0);                       // stand — baseline settles
  const baseHip = out[HIP_MID].y;
  ok(bp.airY < 0.02, `grounded: airY ${bp.airY.toFixed(3)}m`);
  for (let i = 1; i <= 6; i++) step(i * 0.05);                // LAUNCH: hips rise fast in the image
  for (let i = 0; i < 4; i++) step(0.30);                     // hang at apex
  ok(bp.airY > 0.15, `launch detected: airY ${bp.airY.toFixed(2)}m`);
  ok(out[HIP_MID].y > baseHip + 0.15, `body lifted (hip ${out[HIP_MID].y.toFixed(2)} vs ${baseHip.toFixed(2)})`);
  for (let i = 5; i >= 0; i--) step(i * 0.05);                // fall back
  for (let i = 0; i < 30; i++) step(0);                       // stand again
  ok(bp.airY < 0.05, `landing settles: airY ${bp.airY.toFixed(3)}m`);
  // slow rise (stand up from crouch / drift) must NOT trigger air
  const bp2 = new BodyPose();
  t = 0; let out2;
  const step2 = (lift) => { out2 = bp2.retarget(world, mkImg(lift), spawn, 0, null, t); t += 1 / 30; };
  for (let i = 0; i < 30; i++) step2(0);
  for (let i = 0; i < 60; i++) step2(i * 0.002);              // 0.06 units over 2s — slow drift
  ok(bp2.airY < 0.05, `slow drift stays grounded: airY ${bp2.airY.toFixed(3)}m`);
}

// ── 5e. visibility-gated limb inference (out-of-frame ⇒ settle to rest) ──
console.log('\n[visibility inference]');
{
  const world = REST_BODY.slice(0, 33).map(p => ({ x: -p[0], y: -(p[1] - 0.95), z: -p[2] }));
  const img = REST_BODY.slice(0, 33).map(p => ({ x: 0.5 + p[0] * 0.3, y: 0.9 - p[1] * 0.45, z: 0 }));
  const bp = new BodyPose();
  const spawn = new THREE.Vector3(0, 0, 0);
  const vis = new Float32Array(33).fill(1);
  let out, t = 0;
  const step = (w) => { out = bp.retarget(w, img, spawn, 0, vis, t); t += 1 / 30; };
  for (let i = 0; i < 10; i++) step(world);
  const restWrist = out[16].clone();          // person's right wrist (screen +x from behind)
  // corrupt the arm the way MediaPipe hallucinates an out-of-frame limb:
  // fold it through the torso to garbage coordinates, visibility ≈ 0
  const bad = world.map(p => ({ ...p }));
  bad[14].x = 0.3; bad[14].y = 0.5; bad[14].z = 0.4;    // elbow garbage
  bad[16].x = -0.4; bad[16].y = 0.6; bad[16].z = -0.3;  // wrist garbage
  for (const j of [14, 16, 18, 20, 22]) vis[j] = 0.02;
  for (let i = 0; i < 45; i++) step(bad);               // 1.5s of hallucinated data
  ok(out[16].distanceTo(restWrist) < 0.25,
    `invisible arm settles near rest, ignores hallucination (drift ${out[16].distanceTo(restWrist).toFixed(2)}m)`);
  // reacquire: visibility back → live tracking resumes smoothly
  for (const j of [14, 16, 18, 20, 22]) vis[j] = 1;
  for (let i = 0; i < 30; i++) step(world);
  ok(out[16].distanceTo(restWrist) < 0.05, `reacquired arm tracks live again (${out[16].distanceTo(restWrist).toFixed(3)}m)`);
  // feet lost → ground estimate freezes (no bobbing on hallucinated feet)
  const hipBefore = out[HIP_MID].y;
  const badFeet = world.map(p => ({ ...p }));
  for (const j of [27, 28, 29, 30, 31, 32]) { badFeet[j].y = -0.2; vis[j] = 0.02; }   // feet "rise" nonsense
  for (const j of [25, 26]) vis[j] = 0.02;
  for (let i = 0; i < 30; i++) step(badFeet);
  ok(Math.abs(out[HIP_MID].y - hipBefore) < 0.08,
    `lost feet freeze the ground estimate (hip moved ${Math.abs(out[HIP_MID].y - hipBefore).toFixed(3)}m)`);
}

// ── 5f. mirror partial-body stabilizer ──
console.log('\n[mirror stabilizer]');
{
  const bp = new BodyPose();
  const vis = new Float32Array(33).fill(1);
  const mk = () => REST_BODY.slice(0, 33).map(p => new THREE.Vector3(p[0], p[1], p[2]));
  // fully visible: passthrough
  let pts = mk();
  for (let i = 0; i < 5; i++) bp.stabilizeMirror(pts, vis, 1 / 30);
  ok(pts[25].distanceTo(new THREE.Vector3(REST_BODY[25][0], REST_BODY[25][1], REST_BODY[25][2])) < 1e-6,
    'fully visible: stabilizer is a passthrough');
  // legs leave the frame: garbage in, anatomy out
  for (const j of [25, 26, 27, 28, 29, 30, 31, 32]) vis[j] = 0.02;
  const restKnee = new THREE.Vector3(REST_BODY[25][0], REST_BODY[25][1], REST_BODY[25][2]);
  for (let i = 0; i < 45; i++) {
    pts = mk();
    pts[25].set(2.0, 3.0, -1.0); pts[27].set(-2.5, 2.8, 1.2);   // hallucinated flail
    bp.stabilizeMirror(pts, vis, 1 / 30);
  }
  ok(pts[25].distanceTo(restKnee) < 0.2, `invisible knee re-hung anatomically (${pts[25].distanceTo(restKnee).toFixed(2)}m from rest)`);
  ok(pts[27].y < pts[25].y, 'ankle hangs below the knee');
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
