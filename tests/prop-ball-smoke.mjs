/** Node smoke test for the EXTRACTED ball doctrine lane (sdk/game/prop-ball.js) — no browser, no webcam.
 *  The scenarios and thresholds are the rigid-ball contracts of tests/_glassprobe.mjs (repo), which drives
 *  the FROZEN page through window.__lab.AVSYNC.ovPacks with the SAME synthetic packs (generators copied
 *  from _glassprobe.mjs:32-60, :89-99, :125-133, :161-167; assertions from :254-273). Wall-clock waits
 *  become frames at dt = 1/60. Packs are the same objects every frame, as in the page (hand-stop mutates them).
 *
 *  Run from the sandbox-skeleton folder:  node tests/prop-ball-smoke.mjs
 *  (three resolves from the node_modules junction, ../core/* through the sdk/core junction to the repo.) */
import * as THREE from 'three';
import { PropBall } from '../sdk/game/prop-ball.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name} ${extra}`); }
  else { fail++; console.error(`  FAIL ${name} ${extra}`); }
};
const DT = 1 / 60;
const frames = (ms) => Math.max(1, Math.round(ms / 1000 / DT));

// ── synthetic packs (verbatim generators from tests/_glassprobe.mjs) ──
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
const shift = (pack, dx, dy, dz) => pack.map(q => V(q.x + dx, q.y + dy, q.z + dz));
const r = 0.16;
const around = (B, side, fingersOn) => {                     // palm joints on +z of the ball; fingers on -z (wrapping) or curled away
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
const cupHand = (x, y, z, upAxis) => {                       // palm-up hand: fingers forward (-z), 'up' = the inner-palm side
  const p = mk(V(x, y, z + 0.1));
  const U = (dx, dz, up) => upAxis === 'y' ? V(x + dx, y + up, z + dz) : V(x - up, y + dx, z + dz);   // 'x': rolled 90 deg — palm faces -x
  p[0] = U(0, 0.1, 0); p[9] = U(0, -0.1, 0); p[5] = U(0.045, -0.09, 0); p[13] = U(-0.02, -0.095, 0); p[17] = U(-0.06, -0.085, 0);
  const cols = { 6: 0.045, 10: 0, 14: -0.02, 18: -0.06 };
  for (const [pip, dx] of Object.entries(cols)) { const b = +pip; p[b] = U(dx, -0.13, 0.03); p[b + 1] = U(dx, -0.16, 0.06); p[b + 2] = U(dx, -0.18, 0.09); }
  p[1] = U(0.05, 0.06, 0.01); p[2] = U(0.08, 0.02, 0.03); p[3] = U(0.1, -0.02, 0.05); p[4] = U(0.11, -0.05, 0.07);
  return p;
};

// ── the module under test: same constants as the page (SLIME_R 0.16, gravity -4.2, restitution 0.42, home (0,0,-2)) ──
const ball = new PropBall(null, { radius: 0.16 });
const step = (pk, n) => { for (let i = 0; i < n; i++) ball.update(DT, pk); };
const pos = () => ball.pos.clone();

// 1. rest: gravity always on
console.log('\n[rest on the floor]');
step({ L: null, R: null }, frames(1400));
const s0 = pos();
ok(Math.abs(s0.y - (ball.floorY + r)) <= 0.02 && !ball.hold, `at rest on the floor: y=${s0.y.toFixed(3)} floor+r=${(ball.floorY + r).toFixed(3)}`);

// 2. OPEN hand over it, 0.35 m nearer: no float, no grab, no on-screen pull; REACH brings z to contact depth on its own side
console.log('\n[open hand hover -> reach in depth only]');
{
  const pk = { L: open(s0.x + 0.02, s0.y, s0.z + 0.35), R: null };
  step(pk, frames(700));
  const p = pos();
  const rose = p.y - s0.y, xyMoved = Math.hypot(p.x - s0.x, p.y - s0.y), gap = Math.abs(p.z - (s0.z + 0.35));
  ok(rose <= 0.01 && !ball.hold && xyMoved <= 0.02, `no float / grab / on-screen pull: rose=${rose.toFixed(3)} xy=${xyMoved.toFixed(3)} held=${!!ball.hold}`);
  ok(gap <= 0.26 && gap >= 0.1, `REACH: ball came to contact depth on its side (~0.19): gap=${gap.toFixed(3)} seek=${ball.seek}`);
}
// 3. CLOSING hand over it: z only, hand never moved, no lift, no grab
console.log('\n[depth bias with a cupping hand]');
{
  const pk = { L: cup(s0.x + 0.02, s0.y, s0.z + 0.35), R: null };
  step(pk, frames(900));
  const p = pos(), gapNow = Math.abs(p.z - (s0.z + 0.35)), handMoved = Math.abs(pk.L[0].z - (s0.z + 0.35));
  ok(Math.abs(gapNow - 0.18) <= 0.05, `closing hand -> contact depth 0.18: gap=${gapNow.toFixed(3)}`);
  ok(handMoved <= 0.01, `the HAND was not pushed by the bias: ${handMoved.toFixed(3)}`);
  ok(p.y - s0.y <= 0.01 && !ball.hold, `z only: rose=${(p.y - s0.y).toFixed(3)} held=${!!ball.hold}`);
  step({ L: null, R: null }, frames(300));
}
// 4. BACK OF HAND / fingers curled away: nothing
console.log('\n[back of hand]');
const B = pos();
{
  const pk = { L: around(B, 1, false), R: null };
  step(pk, frames(500));
  ok(!ball.hold && pos().distanceTo(B) <= 0.02, `no grab, not carried: held=${!!ball.hold} moved=${pos().distanceTo(B).toFixed(3)}`);
  step({ L: null, R: null }, frames(200));
}
// 5. WRAP: palm one side, fingers closed round the far side -> held; lift -> comes; open fingers -> released, falls
console.log('\n[wrap grab / lift / release]');
{
  const B2 = pos(); B.copy(B2);
  let wrapPack = around(B, 1, true);
  step({ L: wrapPack, R: null }, frames(300));
  ok(!!ball.hold && ball.hold.type === 'wrap', `wrap picks it up: ${JSON.stringify(ball.hold && ball.hold.type)}`);
  for (let k = 1; k <= 15; k++) step({ L: shift(wrapPack, 0, 0.18 * k / 15, 0), R: null }, 2);
  wrapPack = shift(wrapPack, 0, 0.18, 0);
  step({ L: wrapPack, R: null }, frames(400));
  const rose = pos().y - B2.y;
  ok(rose >= 0.1 && !!ball.hold, `wrapped ball rides the lifting hand: rose=${rose.toFixed(3)} held=${!!ball.hold}`);
  const opened = wrapPack.map((q, i) => ([6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20].includes(i) ? V(q.x, q.y, q.z - 0.15) : q));
  step({ L: opened, R: null }, frames(120));
  const yOpen = pos().y, heldAfterOpen = !!ball.hold;
  step({ L: opened, R: null }, frames(500));
  ok(!heldAfterOpen && !ball.hold && (yOpen - pos().y) >= 0.08, `open fingers -> released that frame, falls: fell=${(yOpen - pos().y).toFixed(3)}`);
  step({ L: null, R: null }, frames(900));
}
// 6. HOLDING POSE -> CRADLE: palm up beside it draws it across; rides the hand up; tilt + move off -> falls
console.log('\n[holding pose cradle]');
{
  const F = ball.floorY, Bc = pos();
  const hx = Bc.x + 0.28, hy = F + 0.03, hz = Bc.z - 0.06;
  let cupPack = cupHand(hx, hy, hz, 'y');
  step({ L: cupPack, R: null }, frames(1200));
  const P = ball._pose.left, pocket = P.pocket.clone();
  const dxz = Math.hypot(pos().x - pocket.x, pos().z - pocket.z);
  ok(P.pose, `holding pose recognised: n.y=${P.n.y.toFixed(2)} closure=${P.closure.toFixed(2)}`);
  ok(dxz <= 0.05 && ball.cradle === 'left', `ball came across into the pocket: dxz=${dxz.toFixed(3)} cradle=${ball.cradle}`);
  const y0 = pos().y;
  for (let k = 1; k <= 15; k++) step({ L: shift(cupPack, 0, 0.2 * k / 15, 0), R: null }, 2);
  cupPack = shift(cupPack, 0, 0.2, 0);
  step({ L: cupPack, R: null }, frames(400));
  ok(pos().y - y0 >= 0.12 && ball.cradle === 'left', `cradled ball rides the hand up: rose=${(pos().y - y0).toFixed(3)}`);
  const yTop = pos().y;
  const sidePack = cupHand(hx, hy + 0.2, hz, 'x');
  step({ L: sidePack, R: null }, frames(100));
  const cradleAfterTilt = ball.cradle;
  for (let k = 1; k <= 10; k++) step({ L: shift(sidePack, 0.35 * k / 10, 0, 0), R: null }, 2);
  step({ L: shift(sidePack, 0.35, 0, 0), R: null }, frames(600));
  const fell = yTop - pos().y, yEnd = pos().y;
  ok(!cradleAfterTilt && !(fell < 0.08 && yEnd - (F + r) > 0.02), `tilt away -> rolls off / falls: cradleAfterTilt=${cradleAfterTilt} fell=${fell.toFixed(3)}`);
  step({ L: null, R: null }, frames(900));
}
// 7. CLIP: shrink it; thumb tip + index tip on opposite sides -> held; open the thumb -> released
console.log('\n[clip grab]');
{
  ball.setScale(ball.userS / 1.25 / 1.25);                   // two UI "size down" clicks (page factor 1.25)
  step({ L: null, R: null }, frames(600));
  const rc = 0.16 * ball.userS, C = pos();
  const clipPack = (() => {
    const p = mk(V(C.x, C.y - 0.3, C.z + 0.4));
    p[0] = V(C.x, C.y - rc - 0.25, C.z); p[9] = V(C.x, C.y - rc - 0.05, C.z);   // palm BELOW the ball (outside it)
    p[4] = V(C.x + rc + 0.015, C.y, C.z); p[3] = V(C.x + rc + 0.05, C.y - 0.01, C.z);
    p[8] = V(C.x - rc - 0.013, C.y, C.z); p[7] = V(C.x - rc - 0.045, C.y + 0.01, C.z);
    return p;
  })();
  step({ L: clipPack, R: null }, frames(300));
  ok(!!ball.hold && ball.hold.type === 'clip', `thumb+finger clip picks it up: ${JSON.stringify(ball.hold && ball.hold.type)} userS=${ball.userS.toFixed(2)}`);
  step({ L: clipPack.map((q, i) => (i === 3 || i === 4 ? V(q.x + 0.08, q.y, q.z) : q)), R: null }, frames(120));
  ok(!ball.hold, 'opening the clip releases it');
  step({ L: null, R: null }, frames(300));
  ball.setScale(ball.userS * 1.25 * 1.25);
  step({ L: null, R: null }, frames(900));
}
// 8. RESISTANCE: an open hand pressed into the ball is stopped at the surface (hull gap >= -6 mm), never grabs
console.log('\n[hand resistance]');
{
  const c0 = pos();
  const pk = { L: open(c0.x, c0.y, c0.z), R: null };           // palm centre AT the ball centre
  step(pk, frames(600));
  ball.mesh.updateWorldMatrix(true, false); ball.hull.begin(ball.mesh);
  let minGap = 9;
  for (let i = 0; i < 21; i++) { const g = ball.hull.surfaceDistance(new THREE.Vector3(pk.L[i].x, pk.L[i].y, pk.L[i].z)); if (g < minGap) minGap = g; }
  ok(minGap >= -0.006, `open hand stopped at the surface: minGap=${minGap.toFixed(3)}`);
  ok(!ball.hold, 'an open hand does not grab');
  step({ L: null, R: null }, frames(300));
}
// 9. SCALE: userS drives mesh, physics radius and conform radius together
console.log('\n[scale]');
{
  ball.setScale(1.25);
  ok(Math.abs(ball.userS - 1.25) < 0.01 && Math.abs(ball.mesh.scale.x - 1.25) < 0.01, `userS/mesh = ${ball.userS}/${ball.mesh.scale.x}`);
  ok(Math.abs(ball.sphere.radius - 0.2) < 0.002 && Math.abs(ball.collider.radius - 0.2) < 0.002, `physics/conform radius = ${ball.sphere.radius}/${ball.collider.radius}`);
  ball.setScale(1);
}
// 9b. [D7] BODY SUPPORT (T9, CONTRACTS §3.11): a BodyBody (the 37-point rest pose + its 10 virtual colliders, game-physics.js:951)
//     standing under the ball supports it on the chest — hull-vs-joint-spheres, never inside the body, never a grab.
console.log('\n[body support — D7]');
{
  const { BodyBody } = await import('../sdk/core/game-physics.js');
  const { BODY_RADII, REST_BODY } = await import('../sdk/core/body-forge.js');
  step({ L: null, R: null }, frames(300));
  const c0 = pos();
  // REST_BODY is upright (head right above the chest): the body LIES ON ITS BACK along x — a proper rotation (rest x,y,z -> world
  // z,x,y; head toward +x, front facing up) so the chest (34) is the top surface and its centre sits under the ball's column
  const chest = { x: c0.x, y: ball.floorY + 0.45, z: c0.z };
  const C = REST_BODY[34];
  const posed = REST_BODY.map(p => new THREE.Vector3(chest.x + (p[1] - C[1]), chest.y + (p[2] - C[2]), chest.z + (p[0] - C[0])));
  const body = new BodyBody(BODY_RADII); body.update(posed, DT); body.update(posed, DT);
  const Rc = body.radii[34], contactY = chest.y + Rc + r;
  ball.sphere.pos.set(chest.x, contactY + 0.2, chest.z); ball.sphere.vel.set(0, 0, 0);   // 20 cm drop onto the chest
  ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
  const gapNow = () => {                                                              // min (hull surface distance - joint radius) over all 47 colliders
    ball.mesh.updateWorldMatrix(true, false); ball.hull.begin(ball.mesh);
    let g = Infinity; for (let i = 0; i < body.joints.length; i++) { const d = ball.hull.surfaceDistance(body.joints[i]) - body.radii[i]; if (d < g) g = d; }
    return g;
  };
  let minGap = Infinity; const ys = []; const N = frames(2000);
  for (let i = 0; i < N; i++) {
    body.update(posed, DT);
    ball.update(DT, { L: null, R: null }, null, [body]);                             // hands absent: only the body can hold it up
    const g = gapNow(); if (g < minGap) minGap = g;
    if (i >= N - 60) ys.push(ball.pos.y);
  }
  const rest = ball.pos.y - contactY, spread = Math.max(...ys) - Math.min(...ys), off = Math.hypot(ball.pos.x - chest.x, ball.pos.z - chest.z), gapRest = gapNow();
  const grabbed = !!ball.hold || !!ball.cradle;
  body.drop();
  step({ L: null, R: null }, frames(1500));                                          // body gone -> gravity takes it back to the floor
  const fell = Math.abs(pos().y - (ball.floorY + r)) <= 0.02 && !ball.hold;
  ok(rest >= -0.006 && rest <= 0.01 && spread <= 0.006 && !grabbed && off < 0.02 && minGap >= -0.02 && gapRest >= -0.006 && fell,
    `[D7] body sphere supports the ball: rests at chest + R_chest + r ${(rest * 1000).toFixed(1)} mm (>= -6 skin), stable ${(spread * 1000).toFixed(1)} mm over 60 frames, ` +
    `xz drift ${(off * 1000).toFixed(1)} mm; never inside: min gap ${(minGap * 1000).toFixed(1)} mm during the drop (>= -20 = the 2 cm/frame yield), ${(gapRest * 1000).toFixed(1)} mm at rest; ` +
    `never grabbed (hold ${JSON.stringify(ball.hold)}, cradle ${ball.cradle}); body dropped -> back on the floor (${fell}, y=${pos().y.toFixed(3)})`);
}
// 10. static doctrine grep: the sphere is never given a hand list; no jointsWithin / pinch grab in the module
console.log('\n[static doctrine]');
{
  const src = await (await import('node:fs/promises')).readFile(new URL('../sdk/game/prop-ball.js', import.meta.url), 'utf8');
  ok(/sphere\.update\(dt, \[\], this\.floorY\)/.test(src), 'GrabbableSphere.update is called with an EMPTY hand list');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // CODE only: the doctrine header comment names the forbidden calls
  ok(!/jointsWithin|GrabState|countNearLandmarks|gravity\s*[:=]\s*0/.test(code), 'no jointsWithin / GrabState / gravity-off in the module (comments stripped)');
  const posY = src.split('\n').filter(l => /sphere\.pos\.y\s*[+\-]?=/.test(l));
  // the ONE allowed write: the camera-ray depth mock, which moves x, y and z
  // together by the factor that keeps the ball on its own pixel (see "ALONG THE
  // CAMERA RAY"). Anything else that touches y is the old lift bug coming back.
  const rayY = posY.filter(l => /G\.target\.y - this\.sphere\.pos\.y/.test(l));
  ok(posY.length === rayY.length && rayY.length <= 1,
     `the only sphere.pos.y write is the camera-ray move (found ${posY.length}, allowed ${rayY.length})`);
  const rayBlock = /ALONG THE CAMERA RAY[\s\S]{0,400}?G\.target\.z - this\.sphere\.pos\.z/.test(src);
  ok(rayBlock || rayY.length === 0, 'the ray move changes x, y and z together (pixel preserved)');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
