// CLOTH contracts (node): the lattice solves, the skin rides it exactly, the
// hands push it, grab it and are STOPPED by it. No browser needed.
import * as THREE from 'three';
import { ClothSim, buildCloth, clothResistHand, toLocalHands } from '../sdk/core/cloth-sim.js';

let fails = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) fails++; };

// ── a synthetic cloth prop: NX×NY lattice + a two-sided skin with thickness ──
const NX = 24, NY = 34, D = 0.03, TH = 0.009;
function makeScene() {
  const lat = new Float32Array(NX * NY * 3);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const k = (j * NX + i) * 3;
    lat[k] = -0.5 + i * D; lat[k + 1] = 0; lat[k + 2] = 0.6 - j * D;     // v runs toward −Z (as the exporter leaves it)
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(lat, 3));
  const latMesh = new THREE.Mesh(lg, new THREE.MeshBasicMaterial()); latMesh.name = 'RugSim';
  // skin: 2× finer, top and bottom shells, jittered so the binding is non-trivial
  const sv = [], sn = [];
  for (let side of [1, -1]) for (let j = 0; j < NY * 2 - 1; j++) for (let i = 0; i < NX * 2 - 1; i++) {
    const x = -0.5 + i * D / 2, z = 0.6 - j * D / 2;
    sv.push(x + Math.sin(i * 1.7) * 0.002, side * TH + Math.cos(j * 2.1) * 0.001, z + Math.cos(i * 0.9) * 0.002);
    sn.push(0, side, 0);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
  sg.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
  const skinMesh = new THREE.Mesh(sg, new THREE.MeshStandardMaterial()); skinMesh.name = 'RugSkin';
  const scene = new THREE.Group(); scene.add(latMesh, skinMesh);
  return { scene, latMesh, skinMesh };
}

const { scene, skinMesh } = makeScene();
const piece = buildCloth(scene, { nx: NX, ny: NY }, { thickness: TH, substeps: 5 });
const { sim, skin } = piece;

console.log('CLOTH — lattice + embedded skin');
ok('lattice rebuilt from the glTF node order', sim.n === NX * NY && sim.nx === NX && sim.ny === NY);
ok('rest lattice is the regular grid', Math.abs(sim.rest[3] - sim.rest[0] - D) < 1e-6, 'dx=' + (sim.rest[3] - sim.rest[0]).toFixed(4));
ok('skin bound', !!skinMesh.geometry.attributes.aCell && !!skinMesh.geometry.attributes.aOff);

// the SHADER's reconstruction, in JS: at rest it must reproduce the mesh exactly
function replay(latX) {
  const g = skinMesh.geometry, cell = g.attributes.aCell.array, off = g.attributes.aOff.array;
  const out = new Float32Array(g.attributes.position.count * 3);
  const sgn = skin.sgn;
  const at = (i, j) => { const k = (j * NX + i) * 3; return [latX[k], latX[k + 1], latX[k + 2]]; };
  for (let t = 0; t < g.attributes.position.count; t++) {
    const u = cell[t * 2], v = cell[t * 2 + 1];
    const ci = u | 0, cj = v | 0, a = u - ci, b = v - cj;
    const q00 = at(ci, cj), q10 = at(ci + 1, cj), q01 = at(ci, cj + 1), q11 = at(ci + 1, cj + 1);
    const mix = (p, q, s) => p.map((x, i2) => x + (q[i2] - x) * s);
    const base = mix(mix(q00, q10, a), mix(q01, q11, a), b);
    const norm = w => { const L = Math.hypot(...w) || 1; return w.map(x => x / L); };
    const T = norm(mix(q10.map((x, i2) => x - q00[i2]), q11.map((x, i2) => x - q01[i2]), b)).map(x => x * sgn.x);
    const Bt = norm(mix(q01.map((x, i2) => x - q00[i2]), q11.map((x, i2) => x - q10[i2]), a)).map(x => x * sgn.y);
    const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const N = norm(cross(Bt, T)), B = norm(cross(T, N));
    for (let c = 0; c < 3; c++) out[t * 3 + c] = base[c] + off[t * 3] * T[c] + off[t * 3 + 1] * B[c] + off[t * 3 + 2] * N[c];
  }
  return out;
}
{
  const p = skinMesh.geometry.attributes.position.array, r = replay(sim.rest);
  let e = 0; for (let i = 0; i < p.length; i++) e = Math.max(e, Math.abs(p[i] - r[i]));
  ok('skin replays its rest shape through the lattice', e < 1e-5, 'max error ' + (e * 1000).toFixed(4) + ' mm');
}
{ // a rigid translation of the lattice must translate the skin by exactly that
  const moved = Float32Array.from(sim.rest);
  for (let k = 0; k < moved.length; k += 3) { moved[k] += 0.3; moved[k + 1] += 0.7; moved[k + 2] -= 0.2; }
  const p = skinMesh.geometry.attributes.position.array, r = replay(moved);
  let e = 0; for (let i = 0; i < p.length; i += 3) e = Math.max(e, Math.abs(r[i] - p[i] - 0.3), Math.abs(r[i + 1] - p[i + 1] - 0.7), Math.abs(r[i + 2] - p[i + 2] + 0.2));
  ok('skin follows a rigid lattice move', e < 1e-5, 'max error ' + (e * 1000).toFixed(4) + ' mm');
}

// ── physics ──
const obj = new THREE.Object3D(); obj.add(piece.group); obj.updateMatrixWorld(true);
sim.reset();
for (let i = 0; i < 30; i++) sim.step(1 / 60, [], null);
const c0 = sim.centroid(new THREE.Vector3());
ok('gravity: the free sheet falls', c0.y < -0.5, 'y=' + c0.y.toFixed(3));
ok('no NaN after 30 frames', [...sim.x].every(Number.isFinite));

sim.reset();
sim.pin(0); sim.pin(NX - 1);                          // two corners pinned
for (let i = 0; i < 90; i++) sim.step(1 / 60, [], null);
ok('pinned corners hold', Math.abs(sim.x[1]) < 1e-6 && Math.abs(sim.x[(NX - 1) * 3 + 1]) < 1e-6);
const lowest = Math.min(...Array.from({ length: sim.n }, (_, i) => sim.x[i * 3 + 1]));
ok('the rest of the sheet hangs off them', lowest < -0.4, 'lowest ' + lowest.toFixed(2) + ' m');
{
  let worst = 0;
  for (let c = 0; c < sim.nStruct; c++) {          // the WEAVE (bend spans are meant to give)
    const a = sim.cA[c] * 3, b = sim.cB[c] * 3;
    const d = Math.hypot(sim.x[a] - sim.x[b], sim.x[a + 1] - sim.x[b + 1], sim.x[a + 2] - sim.x[b + 2]);
    worst = Math.max(worst, d / sim.cL[c]);
  }
  ok('the weave does not stretch', worst < 1.04, 'worst structural edge ×' + worst.toFixed(3));
}

// ── hands: a flat palm under the sheet, fingers spread ──
function hand(slot, cx, cy, cz, grip = 0) {
  const J = [], V = [];
  for (let i = 0; i < 21; i++) { J.push(new THREE.Vector3()); V.push(new THREE.Vector3()); }
  const lay = (i, x, y, z) => J[i].set(cx + x, cy + y, cz + z);
  lay(0, 0, 0, 0.09); lay(9, 0, 0, -0.01);
  lay(5, -0.035, 0, 0.0); lay(17, 0.035, 0, 0.0);
  for (let f = 0; f < 5; f++) for (let s = 1; s <= 4; s++) {
    const i = f * 4 + s, bend = grip * 0.06 * s;
    lay(i, -0.04 + f * 0.02, bend, 0.06 - s * 0.03);
  }
  const radii = new Float32Array(21).fill(0.012); radii[0] = 0.026;
  return { slot, joints: J, vel: V, radii, present: true, grip,
           palmP: new THREE.Vector3(cx, cy, cz), palmQ: new THREE.Quaternion(), palmV: new THREE.Vector3(),
           gripP: new THREE.Vector3(cx, cy, cz) };
}
sim.reset(); sim.o.substeps = 6;
const H = hand('L', 0, -0.25, 0.1);
for (let i = 0; i < 120; i++) sim.step(1 / 60, [H], -0.6);
{
  let worst = Infinity, touched = 0;
  for (let i = 0; i < sim.n; i++) {
    const p = new THREE.Vector3(sim.x[i * 3], sim.x[i * 3 + 1], sim.x[i * 3 + 2]);
    for (let j = 0; j < 21; j++) {
      const d = p.distanceTo(H.joints[j]) - (H.radii[j] + TH);
      if (d < 0.004) touched++;
      worst = Math.min(worst, d);
    }
  }
  ok('the sheet drapes ON the hand, not through it', worst > -0.0015, 'deepest ' + (worst * 1000).toFixed(2) + ' mm');
  ok('it actually lands on the fingers (flush contact)', touched > 0, touched + ' node/joint contacts');
  ok('and it kept falling round them', Math.min(...Array.from({ length: sim.n }, (_, i) => sim.x[i * 3 + 1])) < -0.5);
}

// ── grab: a closing hand takes the cloth, carries it, drops it ──
sim.reset();
const G = hand('R', 0, 0, 0, 1);
G.palmP.set(0, 0, 0); G.gripP.set(0, 0, 0);
sim.step(1 / 60, [G], null);
ok('a closed hand ON the cloth grabs nodes', sim.grabbed > 0, sim.grabbed + ' nodes');
for (let i = 0; i < 40; i++) {
  G.palmP.y += 0.01; G.gripP.y += 0.01;
  for (const j of G.joints) j.y += 0.01;
  sim.step(1 / 60, [G], null);
}
const held = sim.holds.R.idx[0];
ok('the held nodes ride the hand', sim.x[held * 3 + 1] > 0.3, 'y=' + sim.x[held * 3 + 1].toFixed(2));
ok('the rest of the sheet hangs from the grip', Math.min(...Array.from({ length: sim.n }, (_, i) => sim.x[i * 3 + 1])) < 0, 'it drapes');
G.grip = 0;
sim.step(1 / 60, [G], null);
ok('opening the hand lets go', !sim.holds.R && sim.w[held] === 1);

// ── the hand is STOPPED by the cloth (no gap, no pass-through) ──
sim.reset();
for (let i = 0; i < 5; i++) sim.step(1 / 60, [], null);       // settle + build the surface index
{
  const pack = [];
  for (let i = 0; i < 21; i++) pack.push(new THREE.Vector3(0, sim.x[1] - 0.005, 0.05));   // a fingertip 5 mm through the sheet
  const radii = new Array(21).fill(0.012);
  const before = pack[0].clone();
  const d = clothResistHand(sim, piece.group, pack, radii, { share: 1, gate: 0.004 });
  ok('the hand-stop fires inside the sheet', d > 0.01, 'pushed ' + (d * 1000).toFixed(1) + ' mm');
  ok('the whole pack moved rigidly', pack.every(p => Math.abs(p.distanceTo(before) - d) < 1e-6));
  const c = sim.contact(pack[0], 0.012 + 0.02, {});
  const pen = 0.012 - (c ? c.gap : 9);
  ok('and it ends up FLUSH — touching, no gap, not inside', Math.abs(pen) < 0.0015, 'residual ' + (pen * 1000).toFixed(2) + ' mm');
  const far = [];
  for (let i = 0; i < 21; i++) far.push(new THREE.Vector3(0, sim.x[1] + 0.4, 0.05));
  ok('a hand nowhere near it is untouched', clothResistHand(sim, piece.group, far, radii) === 0);
}

// ── toLocalHands: world packs → the sim's frame, with grip + palm ──
{
  const o = new THREE.Object3D(); o.position.set(0.4, 1.2, -2); o.scale.setScalar(0.5); o.updateMatrixWorld(true);
  const pk = { L: [], R: null };
  for (let i = 0; i < 21; i++) pk.L.push(new THREE.Vector3(0.4, 1.2, -2));
  pk.L[0].set(0.4, 1.1, -2); pk.L[9].set(0.4, 1.3, -2); pk.L[5].set(0.3, 1.25, -2); pk.L[17].set(0.5, 1.25, -2);
  pk.L[4].set(0.42, 1.28, -2); pk.L[8].set(0.42, 1.29, -2);
  const cache = {};
  const hs = toLocalHands(pk, o, 1 / 60, cache);
  ok('toLocalHands returns the present hand in local space', hs.length === 1 && Math.abs(hs[0].joints[0].y + 0.2) < 1e-5, 'wrist y=' + hs[0].joints[0].y.toFixed(3));
  ok('a pinched thumb/index reads as grip', hs[0].grip > 0.6, 'grip ' + hs[0].grip.toFixed(2));
}

// ── budget ──
{
  sim.reset(); sim.o.substeps = 8;
  const hs = [hand('L', 0, -0.2, 0.1), hand('R', 0.2, -0.2, 0.1)];
  for (let i = 0; i < 10; i++) sim.step(1 / 60, hs, -0.6);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 60; i++) sim.step(1 / 60, hs, -0.6);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 60;
  console.log(`  info  ${sim.n} nodes, 8 substeps, two hands: ${ms.toFixed(2)} ms/frame`);
  ok('inside the frame budget', ms < 8, ms.toFixed(2) + ' ms');
}

console.log(fails ? `\n${fails} CLOTH CONTRACT(S) BROKEN` : '\nall CLOTH contracts hold');
process.exit(fails ? 1 : 0);
