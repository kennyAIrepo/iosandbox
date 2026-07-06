/** Node smoke test for the Rubik's cube model: build contract, layer
 *  twist → snap → bake (lattice + 24-group + grid re-tag), twist math. */
import * as THREE from 'three';
import { buildRubiksCube, RubiksModel, twistAngleAbout, snapQuat24 } from '../sdk/core/rubiks-cube.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.error(`  ✘ FAIL: ${name} ${extra}`); }
};
const DT = 1 / 60;
const HALF_PI = Math.PI / 2;

// ── 1. Build contract ──
console.log('\n[build]');
const built = buildRubiksCube({ edge: 0.17 });
{
  ok(built.cubelets.length === 27, `27 cubelets (${built.cubelets.length})`);
  // sticker census: 6 centres ×1 + 12 edges ×2 + 8 corners ×3 + core ×0 = 54
  let stickers = 0;
  const byCount = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const c of built.cubelets) {
    const n = c.children.length - 1;              // minus the body mesh
    stickers += n; byCount[n]++;
  }
  ok(stickers === 54, `54 stickers (${stickers})`);
  ok(byCount[0] === 1 && byCount[1] === 6 && byCount[2] === 12 && byCount[3] === 8,
    `core/centres/edges/corners = 1/6/12/8 (${byCount[0]}/${byCount[1]}/${byCount[2]}/${byCount[3]})`);
  const grids = new Set(built.cubelets.map(c => `${c.userData.grid.i},${c.userData.grid.j},${c.userData.grid.k}`));
  ok(grids.size === 27, 'all 27 grid slots unique');
}

// ── 2. Twist math helpers ──
console.log('\n[twist math]');
{
  const axis = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, 0.6);
  ok(Math.abs(twistAngleAbout(q, axis) - 0.6) < 1e-6, 'twistAngleAbout recovers a pure twist');
  // swing about x must contribute ZERO twist about y
  const swing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8);
  ok(Math.abs(twistAngleAbout(swing, axis)) < 1e-6, 'pure swing → zero twist');
  const qn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.02, 0.99, 0.05).normalize(), HALF_PI + 0.03);
  snapQuat24(qn);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(qn).elements;
  const clean = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
    .every(v => Math.abs(v) < 1e-9 || Math.abs(Math.abs(v) - 1) < 1e-9);
  ok(clean, 'snapQuat24 lands exactly on a cube rotation');
}

// ── 3. Live twist → release → snap → bake ──
console.log('\n[layer twist]');
const model = new RubiksModel(built);
{
  ok(!model.beginTwist(1, [0]), 'middle slice alone is REFUSED (core stays)');
  ok(!model.beginTwist(1, [-1, 0, 1]), 'all three layers = whole cube — refused');
  ok(model.isSolved(), 'starts solved');

  const topBefore = built.cubelets.filter(c => c.userData.grid.j === 1)
    .map(c => `${c.userData.grid.i},${c.userData.grid.k}`).sort().join(';');
  ok(model.beginTwist(1, [1]), 'top-layer twist engages');
  ok(model.pivot.children.length === 9, `9 cubelets ride the pivot (${model.pivot.children.length})`);
  model.setTwistAngle(HALF_PI * 0.83);            // hands got ~75° of the way
  model.releaseTwist();                           // → eases to 90°, then bakes
  let frames = 0;
  while (model.twisting() && frames++ < 120) model.update(DT);
  ok(!model.twisting() && frames < 120, `snap animation completes (${frames} frames)`);
  ok(model.pivot.children.length === 0, 'cubelets re-parented off the pivot');
  ok(!model.isSolved(), 'one quarter turn → no longer solved');

  // bake exactness: every cubelet on the lattice, 24-group orientation,
  // grids a permutation of the 27 slots, top layer still 9 members
  const pitch = built.edge / 3;
  let onLattice = true, cleanQuat = true;
  for (const c of built.cubelets) {
    for (const v of [c.position.x, c.position.y, c.position.z]) {
      const r = Math.abs(v / pitch - Math.round(v / pitch));
      if (r > 1e-6) onLattice = false;
    }
    const m = new THREE.Matrix4().makeRotationFromQuaternion(c.quaternion).elements;
    for (const v of [m[0], m[1], m[2], m[4], m[5], m[6]]) {
      if (Math.abs(v) > 1e-6 && Math.abs(Math.abs(v) - 1) > 1e-6) cleanQuat = false;
    }
  }
  ok(onLattice, 'all positions exactly on the lattice');
  ok(cleanQuat, 'all orientations exactly in the 24-group');
  const grids = new Set(built.cubelets.map(c => `${c.userData.grid.i},${c.userData.grid.j},${c.userData.grid.k}`));
  ok(grids.size === 27, 'grids still a permutation of 27 slots');
  const topAfter = built.cubelets.filter(c => c.userData.grid.j === 1)
    .map(c => `${c.userData.grid.i},${c.userData.grid.k}`).sort().join(';');
  ok(topAfter === topBefore, 'top layer footprint preserved (rotated within itself)');

  // undo: three more quarter turns → solved again
  for (let t = 0; t < 3; t++) {
    model.beginTwist(1, [1]);
    model.setTwistAngle(HALF_PI * 0.9);
    model.releaseTwist();
    let f = 0;
    while (model.twisting() && f++ < 120) model.update(DT);
  }
  ok(model.isSolved(), 'four quarter turns → solved again');
}

// ── 4. Cross-axis sequence keeps the state consistent ──
console.log('\n[cross-axis]');
{
  const seq = [[0, 1], [1, -1], [2, 1], [0, -1], [1, 1], [2, -1]];
  for (const [ax, layer] of seq) {
    ok(model.beginTwist(ax, [layer]), `twist axis ${ax} layer ${layer} engages`);
    model.setTwistAngle(HALF_PI * (Math.sign(layer) || 1) * 0.8);
    model.releaseTwist();
    let f = 0;
    while (model.twisting() && f++ < 120) model.update(DT);
  }
  const grids = new Set(built.cubelets.map(c => `${c.userData.grid.i},${c.userData.grid.j},${c.userData.grid.k}`));
  ok(grids.size === 27, 'scrambled: grids remain a 27-slot permutation');
  let counts = true;
  for (const ax of ['i', 'j', 'k']) {
    for (const l of [-1, 0, 1]) {
      if (built.cubelets.filter(c => c.userData.grid[ax] === l).length !== 9) counts = false;
    }
  }
  ok(counts, 'every layer of every axis still has exactly 9 cubelets');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
