/** Node smoke test for the game layer: hand physics, grab/spin/throw,
 *  beat pattern + beat map + onset analysis, spawn geometry. No browser. */
import * as THREE from 'three';
import { HandBody, GrabbableSphere, GrabbableBox, JOINT_RADII } from '../sdk/core/game-physics.js';
import { buildSynthPattern, buildBeatMap, analyzeSignal, DIFFICULTY, SYNTH_BPM } from '../sdk/core/beat-audio.js';
import { GAME_GEOM } from '../sdk/core/beat-game.js';
import { REST_R42 } from '../sdk/core/hands.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.error(`  ✘ FAIL: ${name} ${extra}`); }
};

const DT = 1 / 60;
// FP-scale hand (rest skeleton × povHandScale) as world points
const baseHand = () => REST_R42.slice(0, 21).map(p => new THREE.Vector3(p[0] * 0.6, p[1] * 0.6 + 1.3, p[2] * 0.6));
const openImg = () => {   // normalized landmarks, thumb/index apart
  const img = [];
  for (let i = 0; i < 21; i++) img.push({ x: 0.5, y: 0.5 });
  img[0] = { x: 0.5, y: 0.6 }; img[9] = { x: 0.5, y: 0.4 };
  img[4] = { x: 0.42, y: 0.5 }; img[8] = { x: 0.58, y: 0.5 };
  return img;
};
const pinchImg = () => { const img = openImg(); img[4] = { x: 0.5, y: 0.49 }; img[8] = { x: 0.5, y: 0.5 }; return img; };

// ── 1. HandBody kinematics ──
console.log('\n[hand body]');
{
  const hb = new HandBody('right');
  const pts = baseHand();
  hb.update(pts, DT, openImg());
  ok(hb.present && hb.scale > 0.5 && hb.scale < 2, `present, scale=${hb.scale.toFixed(2)}`);
  ok(Math.abs(hb.palmQ.length() - 1) < 1e-6, 'palm quaternion normalized');
  ok(hb.pinch < 0.5, `open hand: pinch=${hb.pinch.toFixed(2)}`);

  // rigid translation at 1.2 m/s → palm velocity converges to it
  for (let f = 0; f < 30; f++) {
    for (const p of pts) p.x += 1.2 * DT;
    hb.update(pts, DT, openImg());
  }
  ok(Math.abs(hb.palmVel.x - 1.2) < 0.25 && Math.abs(hb.palmVel.y) < 0.15,
    `linear velocity tracked: vx=${hb.palmVel.x.toFixed(2)} (want 1.2)`);
  ok(hb.punchSpeed > 0.8, `punch speed registers a swing: ${hb.punchSpeed.toFixed(2)} m/s`);

  // rigid rotation about Y at 2 rad/s → angular velocity ≈ (0, 2, 0)
  const hb2 = new HandBody('right');
  const pts2 = baseHand();
  const c = new THREE.Vector3();
  for (const p of pts2) c.add(p); c.divideScalar(21);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2 * DT);
  hb2.update(pts2, DT, openImg());
  for (let f = 0; f < 40; f++) {
    for (const p of pts2) p.sub(c).applyQuaternion(q).add(c);
    hb2.update(pts2, DT, openImg());
  }
  ok(Math.abs(hb2.angVel.y - 2) < 0.5 && Math.abs(hb2.angVel.x) < 0.4,
    `angular velocity tracked: ωy=${hb2.angVel.y.toFixed(2)} rad/s (want 2)`);
  const pi = new HandBody('right');
  pi.update(baseHand(), DT, pinchImg());
  ok(pi.pinch > 0.7, `pinch detected: ${pi.pinch.toFixed(2)}`);
}

// ── 2. GrabbableSphere: gravity + floor ──
console.log('\n[ball free flight]');
{
  const ball = new GrabbableSphere(0.13, {});
  ball.reset(new THREE.Vector3(0, 1.5, 0));
  for (let f = 0; f < 600; f++) ball.update(DT, [], 0);
  ok(Math.abs(ball.pos.y - 0.13) < 0.02, `settles on the floor at r: y=${ball.pos.y.toFixed(3)}`);
  ok(ball.vel.length() < 0.2, `at rest: |v|=${ball.vel.length().toFixed(3)}`);
}

// ── 3. Grab → rotation-follow → throw ──
console.log('\n[grab / spin / throw]');
{
  const hb = new HandBody('right');
  const pts = baseHand();
  hb.update(pts, DT, pinchImg());
  hb.update(pts, DT, pinchImg());
  const ball = new GrabbableSphere(0.13, {});
  ball.reset(hb.pinchPoint.clone());       // ball at the pinch point
  ball.update(DT, [hb], -5);
  ok(ball.grabbed(), 'pinch grab engages');

  // rotate the hand rigidly 90° about Z — the ball must rotate with it
  const c = hb.palm.clone();
  const step = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (Math.PI / 2) / 45);
  for (let f = 0; f < 45; f++) {
    for (const p of pts) p.sub(c).applyQuaternion(step).add(c);
    hb.update(pts, DT, pinchImg());
    ball.update(DT, [hb], -5);
  }
  const angle = 2 * Math.acos(Math.min(1, Math.abs(ball.quat.w)));
  ok(ball.grabbed(), 'still held through the rotation');
  ok(angle > THREE.MathUtils.degToRad(60), `ball rotated with the hand: ${THREE.MathUtils.radToDeg(angle).toFixed(0)}° (want →90°)`);

  // carry at 1.5 m/s then let go → throw inherits the carry velocity
  for (let f = 0; f < 20; f++) {
    for (const p of pts) p.x += 1.5 * DT;
    hb.update(pts, DT, pinchImg());
    ball.update(DT, [hb], -5);
  }
  for (const p of pts) p.y += 5;           // hand vanishes upward + pinch opens
  hb.update(pts, DT, openImg());
  ball.update(DT, [hb], -5);
  ok(!ball.grabbed(), 'released when the grip opens');
  ok(ball.vel.x > 0.7 && ball.vel.x < 2.5, `throw velocity inherited: vx=${ball.vel.x.toFixed(2)} (carried at 1.5)`);
}

// ── 4. Hand collision avoidance (no interpenetration) ──
console.log('\n[hand collision]');
{
  const hb = new HandBody('right');
  const pts = baseHand();
  hb.update(pts, DT, openImg());
  const ball = new GrabbableSphere(0.13, { gravity: 0 });
  ball.reset(hb.palm.clone());             // spawn INSIDE the hand
  ball.update(DT, [hb], -5);
  let minSep = Infinity;
  for (let i = 0; i < 21; i++) {
    minSep = Math.min(minSep, ball.pos.distanceTo(hb.joints[i]) - (0.13 + hb.radii[i]));
  }
  ok(minSep > -0.005, `pushed out of every joint collider: worst overlap ${(minSep * 1000).toFixed(1)}mm`);
}

// ── 5. Synth pattern + beat map ──
console.log('\n[beat pattern / map]');
{
  const pat = buildSynthPattern();
  ok(pat.bpm === SYNTH_BPM && pat.duration > 100 && pat.duration < 140,
    `pattern: ${pat.events.length} events · ${pat.duration.toFixed(1)}s @ ${pat.bpm}bpm`);
  let sorted = true;
  for (let i = 1; i < pat.events.length; i++) if (pat.events[i].t < pat.events[i - 1].t) sorted = false;
  ok(sorted, 'events time-sorted');
  const spb = 60 / pat.bpm;
  const offGrid = pat.events.filter(e => e.kind === 'kick')
    .filter(e => { const m = e.t % (spb / 2); return Math.min(m, spb / 2 - m) > 1e-3; });
  ok(offGrid.length === 0, 'every kick sits on the 8th-note grid');

  for (const diff of ['chill', 'rush', 'insane']) {
    const map = buildBeatMap(pat, diff);
    const gaps = [];
    for (let i = 1; i < map.notes.length; i++) {
      const g = map.notes[i].time - map.notes[i - 1].time;
      if (g > 1e-6) gaps.push(g);          // 0 = intentional double
    }
    const minGap = Math.min(...gaps);
    ok(map.notes.length > 60, `${diff}: ${map.notes.length} notes · ${map.walls.length} walls`);
    ok(minGap >= DIFFICULTY[diff].minGap - 1e-6, `${diff}: min gap ${minGap.toFixed(2)}s ≥ ${DIFFICULTY[diff].minGap}`);
    ok(map.notes.every(n => n.lane >= 0 && n.lane <= 3 && (n.row === 0 || n.row === 1)), `${diff}: lanes/rows valid`);
    ok(map.notes.every(n => (n.lane < 2) === (n.hand === 'left')), `${diff}: hand matches lane side`);
    // THE SYNC CONTRACT: every note's arrival time sits ON the musical
    // 8th-note grid of the track — spawn = time − travel, z(t) is a pure
    // function of song time, so arrival at the hit plane IS the beat.
    const offG = map.notes.filter(n => {
      const m = n.time % (spb / 2);
      return Math.min(m, spb / 2 - m) > 2e-3;
    });
    ok(offG.length === 0, `${diff}: every note ON the 8th-note musical grid`);
    const during = map.notes.filter(n => map.walls.some(w => n.time > w.time - 0.4 && n.time < w.time + w.dur + 0.4));
    ok(during.length === 0, `${diff}: no notes while a wall passes`);
  }
}

// ── 6. Onset/BPM analysis on a synthetic click track ──
console.log('\n[audio analysis]');
{
  const sr = 22050, secs = 30, bpm = 120;
  const data = new Float32Array(sr * secs);
  const period = Math.round(sr * 60 / bpm);
  for (let t = 0; t < data.length; t += period) {
    for (let i = 0; i < 400 && t + i < data.length; i++) {
      data[t + i] += Math.sin(i * 0.35) * Math.exp(-i / 90);
    }
  }
  const a = analyzeSignal(data, sr);
  ok(Math.abs(a.bpm - bpm) <= 3, `BPM recovered: ${a.bpm} (want ${bpm})`);
  ok(a.onsets.length >= 45 && a.onsets.length <= 75, `onsets found: ${a.onsets.length} (want ~60)`);
}

// ── 7. Spawn geometry: notes arrive at the hit plane ON the beat ──
console.log('\n[spawn geometry]');
{
  const { SPEEDS, SPAWN_Z, HIT_Z } = GAME_GEOM;
  for (const [diff, speed] of Object.entries(SPEEDS)) {
    const travel = (HIT_Z - SPAWN_Z) / speed;
    const noteTime = 10.0, tSpawn = noteTime - travel;
    const zAtSpawn = HIT_Z - (noteTime - tSpawn) * speed;
    const zAtBeat = HIT_Z - (noteTime - noteTime) * speed;
    ok(Math.abs(zAtSpawn - SPAWN_Z) < 1e-9 && Math.abs(zAtBeat - HIT_Z) < 1e-9 && travel > 2,
      `${diff}: spawn→${zAtSpawn.toFixed(1)}m, beat→${zAtBeat.toFixed(2)}m, travel ${travel.toFixed(1)}s`);
  }
  ok(GAME_GEOM.LANES_X.length === 4 && GAME_GEOM.ROWS_DY.length === 2, 'lane grid 4×2');
}

// ── 8. GrabbableBox (Rubik's cube): tumble, settle flat, grab, push-out ──
console.log('\n[rubiks box]');
{
  // drop with spin from 1.2m → must come to rest ON the table, FACE FLAT
  const box = new GrabbableBox(0.085, {});
  box.reset(new THREE.Vector3(0, 1.2, 0));
  box.quat.setFromAxisAngle(new THREE.Vector3(1, 0.3, 0.2).normalize(), 0.7);
  box.angVel.set(2, 1, 3);
  for (let f = 0; f < 900; f++) box.update(DT, [], 0);
  ok(Math.abs(box.pos.y - 0.085) < 0.012, `rests with a face on the table: y=${box.pos.y.toFixed(3)} (want 0.085)`);
  ok(box.vel.length() < 0.15 && box.angVel.length() < 0.6,
    `at rest: |v|=${box.vel.length().toFixed(3)} |ω|=${box.angVel.length().toFixed(2)}`);
  let flat = 0;
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const n = new THREE.Vector3(...ax).applyQuaternion(box.quat);
    flat = Math.max(flat, Math.abs(n.y));
  }
  ok(flat > 0.99, `settled FLAT, not on a corner: best face·up=${flat.toFixed(3)}`);

  // pinch-grab off the table → rigid rotation-follow → release throws
  const hb = new HandBody('right');
  const pts = baseHand();
  hb.update(pts, DT, pinchImg());
  hb.update(pts, DT, pinchImg());
  const cube = new GrabbableBox(0.085, {});
  cube.reset(hb.pinchPoint.clone());
  cube.update(DT, [hb], -5);
  ok(cube.grabbed(), 'pinch grab engages on the box surface');
  const c = hb.palm.clone();
  const step = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (Math.PI / 2) / 45);
  for (let f = 0; f < 45; f++) {
    for (const p of pts) p.sub(c).applyQuaternion(step).add(c);
    hb.update(pts, DT, pinchImg());
    cube.update(DT, [hb], -5);
  }
  const angle = 2 * Math.acos(Math.min(1, Math.abs(cube.quat.w)));
  ok(cube.grabbed() && angle > THREE.MathUtils.degToRad(60),
    `cube rotates with the hand: ${THREE.MathUtils.radToDeg(angle).toFixed(0)}° (want →90°)`);
  for (const p of pts) p.y += 5;             // hand vanishes + pinch opens
  hb.update(pts, DT, openImg());
  cube.update(DT, [hb], -5);
  ok(!cube.grabbed(), 'released when the grip opens');

  // avoidance: spawn INSIDE an open hand → pushed out of every joint collider
  const hb2 = new HandBody('right');
  const pts2 = baseHand();
  hb2.update(pts2, DT, openImg());
  const box2 = new GrabbableBox(0.085, { gravity: 0 });
  box2.reset(hb2.palm.clone());
  for (let f = 0; f < 30; f++) box2.update(DT, [hb2], -5);
  // every joint must be OUTSIDE the box surface by (radius − small tolerance)
  let worstPen = Infinity;
  for (let i = 0; i < 21; i++) {
    worstPen = Math.min(worstPen, box2.surfaceDistance(hb2.joints[i]) - hb2.radii[i]);
  }
  ok(worstPen > -0.005, `pushed out of every joint collider: worst overlap ${(worstPen * 1000).toFixed(1)}mm`);
  ok(!box2.grabbed(), 'push-out never turned into a spurious grab');
}

// ── 8b. Dead bounce: a plastic cube THUDS, it never bounces ──
console.log('\n[rubiks dead drop]');
{
  const dead = new GrabbableBox(0.085, {});
  dead.reset(new THREE.Vector3(0, 0.8, 0));      // flat drop, no spin
  let landed = false, apex = 0;
  for (let f = 0; f < 300; f++) {
    dead.update(DT, [], 0);
    if (!landed && dead.pos.y <= 0.087) landed = true;
    else if (landed) apex = Math.max(apex, dead.pos.y);
  }
  ok(landed && apex < 0.11, `no desk bounce: post-impact apex ${apex.toFixed(3)} (rest = 0.085)`);
}

// ── 9. GrabbableBox grip physicality: no sticky proximity, palm = tray ──
console.log('\n[rubiks grip physicality]');
{
  // a single fingertip TOUCHING one face (no thumb opposition) must NOT
  // grab — this is the "sticks to the back of the fingertips" bug
  const hb = new HandBody('right');
  const pts = baseHand();
  hb.update(pts, DT, openImg());
  hb.update(pts, DT, openImg());
  const cube = new GrabbableBox(0.085, { gravity: 0 });
  const tip = hb.joints[8];                    // index fingertip
  cube.reset(tip.clone().add(new THREE.Vector3(0.085 + hb.radii[8] + 0.002, 0, 0)));
  for (let f = 0; f < 20; f++) cube.update(DT, [hb], -5);
  ok(!cube.grabbed(), 'single-side touch does NOT stick (no opposing grip)');

  // hovering NEAR the hand (2cm off every joint) must do nothing at all
  const cube2 = new GrabbableBox(0.085, { gravity: 0 });
  cube2.reset(hb.palm.clone().add(new THREE.Vector3(0.085 + 0.06, 0, 0)));
  const before = cube2.pos.clone();
  for (let f = 0; f < 20; f++) cube2.update(DT, [hb], -5);
  ok(!cube2.grabbed(), 'near-miss hover does NOT stick');

  // PALM = TRAY: rotate the hand palm-up, set the cube on it, gravity ON
  // → it RESTS on the hand (supported), it is NOT palm-frame-grabbed
  const hb3 = new HandBody('right');
  const pts3 = baseHand();
  hb3.update(pts3, DT, openImg());
  const pn = new THREE.Vector3(0, 0, 1).applyQuaternion(hb3.palmQ);   // palm normal
  const rot = new THREE.Quaternion().setFromUnitVectors(pn, new THREE.Vector3(0, 1, 0));
  const pc = hb3.palm.clone();
  for (const p of pts3) p.sub(pc).applyQuaternion(rot).add(pc);
  // settle the joint-velocity EMA — the rotation is a teleport, not motion
  for (let i = 0; i < 12; i++) hb3.update(pts3, DT, openImg());
  const tray = new GrabbableBox(0.085, {});
  tray.reset(hb3.palm.clone().add(new THREE.Vector3(0, 0.085 + 0.03, 0)));
  let minY = Infinity, maxDrift = 0;
  for (let f = 0; f < 240; f++) {              // 4 seconds of gravity
    tray.update(DT, [hb3], -5);                // no floor to save it
    minY = Math.min(minY, tray.pos.y);
    maxDrift = Math.max(maxDrift, Math.hypot(tray.pos.x - hb3.palm.x, tray.pos.z - hb3.palm.z));
  }
  ok(!tray.grabbed(), 'resting on an open palm is SUPPORT, not a grab');
  ok(minY > hb3.palm.y - 0.06, `stays ON the palm under gravity: lowest y-palm.y=${(minY - hb3.palm.y).toFixed(3)}`);
  ok(maxDrift < 0.3, `doesn't slide off a level palm: drift=${maxDrift.toFixed(3)}m`);

  // GRAVITY-AWARE LATCH: a hand draped OVER the cube whose fingers
  // oppose across the UPPER edges must NOT latch — nothing is under the
  // cube to carry its weight, so it falls (no hanging beneath the hand)
  {
    const hbT = new HandBody('right');
    const ptsT = baseHand();
    const ov = new GrabbableBox(0.085, {});
    ov.reset(new THREE.Vector3(0, 1.3, 0));
    for (const p of ptsT) p.y += 0.4;              // hand parked ABOVE
    hbT.update(ptsT, DT, openImg());
    for (const i of [2, 3, 4]) {                   // thumb → -x face, UPPER half
      ptsT[i].copy(ov.pos).add(new THREE.Vector3(-(0.085 + hbT.radii[i] * 0.4), 0.05, 0));
    }
    for (const i of [6, 7, 8, 10, 11, 12]) {       // fingers → +x face, UPPER half
      ptsT[i].copy(ov.pos).add(new THREE.Vector3(0.085 + hbT.radii[i] * 0.4, 0.03 + (i % 4) * 0.008, 0.01));
    }
    for (let s = 0; s < 12; s++) hbT.update(ptsT, DT, openImg());
    for (let f = 0; f < 60; f++) ov.update(DT, [hbT], 0);
    ok(!ov.grabbed(), 'top-side opposition does NOT latch (nothing bears the weight)');
    ok(ov.pos.y < 1.0, `gravity wins — the cube falls away: y=${ov.pos.y.toFixed(2)} (from 1.30)`);
  }

  // SQUEEZE: two hands close on the cube from OPPOSITE sides → it must
  // NOT pop up out of the grip (watermelon-seed ejection) — a two-hand
  // clamp IS a grab, and the cube stays pinned between the palms
  {
    const hbL = new HandBody('left'), hbR = new HandBody('right');
    const ptsL = baseHand(), ptsR = baseHand();
    const sq = new GrabbableBox(0.085, {});
    sq.reset(new THREE.Vector3(0, 1.3, 0));
    // hands parked to the sides; fingertip chains pressed onto the ±x faces
    for (const p of ptsL) p.x -= 0.45;
    for (const p of ptsR) p.x += 0.45;
    hbL.update(ptsL, DT, openImg()); hbR.update(ptsR, DT, openImg());
    for (const i of [4, 8, 12, 16]) {
      ptsL[i].copy(sq.pos).add(new THREE.Vector3(-(0.085 + hbL.radii[i] * 0.4), (i % 8) * 0.015 - 0.03, 0.01));
      ptsR[i].copy(sq.pos).add(new THREE.Vector3(0.085 + hbR.radii[i] * 0.4, (i % 8) * 0.015 - 0.03, -0.01));
    }
    for (let s = 0; s < 12; s++) { hbL.update(ptsL, DT, openImg()); hbR.update(ptsR, DT, openImg()); }
    const y0 = sq.pos.y;
    for (let f = 0; f < 90; f++) sq.update(DT, [hbL, hbR], -5);
    ok(sq.grabbed(), 'two-hand squeeze CLAMPS the cube (counts as a grab)');
    ok(sq.pos.y - y0 < 0.06, `not ejected upward: Δy=${(sq.pos.y - y0).toFixed(3)}m`);
    ok(Math.abs(sq.pos.x) < 0.12 && Math.abs(sq.pos.z) < 0.12,
      `stays pinned between the palms: |x|=${Math.abs(sq.pos.x).toFixed(3)} |z|=${Math.abs(sq.pos.z).toFixed(3)}`);
  }

  // GRIP: curl fingers AROUND the cube (thumb one side, fingers opposite)
  // → wraps → grabbed; carried when the hand moves
  const hb4 = new HandBody('right');
  const pts4 = baseHand();
  hb4.update(pts4, DT, openImg());
  const grip = new GrabbableBox(0.085, { gravity: 0 });
  grip.reset(hb4.palm.clone());
  // synthesize a wrap: pull thumb + fingertips onto opposite cube faces
  const centre = grip.pos;
  for (const i of [2, 3, 4]) {                 // thumb chain → -x face
    pts4[i].copy(centre).add(new THREE.Vector3(-(0.085 + hb4.radii[i] * 0.5), (i - 3) * 0.02, 0));
  }
  for (const i of [6, 7, 8, 10, 11, 12]) {     // index+middle chains → +x face
    pts4[i].copy(centre).add(new THREE.Vector3(0.085 + hb4.radii[i] * 0.5, (i % 4) * 0.02 - 0.02, 0.01));
  }
  hb4.update(pts4, DT, openImg());
  hb4.update(pts4, DT, openImg());
  grip.update(DT, [hb4], -5);
  ok(grip.grabbed(), 'opposing thumb/finger wrap DOES grab');
  const startX = grip.pos.x;
  for (let f = 0; f < 30; f++) {
    for (const p of pts4) p.x += 1.0 * DT;
    hb4.update(pts4, DT, openImg());
    grip.update(DT, [hb4], -5);
  }
  ok(grip.grabbed() && grip.pos.x - startX > 0.3, `carried with the moving hand: Δx=${(grip.pos.x - startX).toFixed(2)}m`);

  // HARD SURFACES while held: shove the cube INTO the palm — the holding
  // hand's colliders must push it back out (and the grab offset adapts),
  // so hand mesh and cube surface never stay interpenetrated
  grip.pos.copy(hb4.palm);
  for (let f = 0; f < 90; f++) {
    hb4.update(pts4, DT, openImg());
    grip.update(DT, [hb4], -5);
  }
  ok(grip.grabbed(), 'still held after the overlap shove');
  let worstIn = Infinity;
  for (let i = 0; i < 21; i++) {
    worstIn = Math.min(worstIn, grip.surfaceDistance(hb4.joints[i]) - hb4.radii[i]);
  }
  ok(worstIn > -0.02, `holding hand resolves out of the cube: worst overlap ${(worstIn * 1000).toFixed(1)}mm`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
