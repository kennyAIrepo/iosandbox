// node unit: the particle slime — puddle, rest on a hand, drip past the edge, stretch between two hands
import * as THREE from 'three';
import { SlimeSim } from '../sdk/core/slime-sim.js';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { SlimeSurface } from '../sdk/core/slime-sim.js';

const R = 0.16;
// a flat hand: wrist at origin, fingers along +x, spread across z; span 0.2
function hand(origin, dir = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 1, 0), curl = 0) {
  const side = new THREE.Vector3().crossVectors(dir, up).normalize();
  const J = [], V = [];
  const fingers = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const zoff = [-0.05, -0.03, -0.01, 0.012, 0.034], base = [0.03, 0.09, 0.095, 0.09, 0.08], seg = [0.035, 0.03, 0.025];
  for (let i = 0; i < 21; i++) { J.push(new THREE.Vector3()); V.push(new THREE.Vector3()); }
  J[0].copy(origin);
  fingers.forEach((f, fi) => {
    let p = origin.clone().addScaledVector(dir, base[fi]).addScaledVector(side, zoff[fi]);
    let d = dir.clone();
    J[f[0]].copy(p);
    for (let k = 1; k < 4; k++) {
      d.applyAxisAngle(side, -curl * 0.9).normalize();      // curl toward the palm (−up)
      p = p.clone().addScaledVector(d, seg[k - 1]); J[f[k]].copy(p);
    }
  });
  const radii = [0.034, 0.024, 0.02, 0.017, 0.015, 0.022, 0.017, 0.015, 0.013, 0.022, 0.017, 0.015, 0.013, 0.021, 0.016, 0.014, 0.012, 0.019, 0.015, 0.013, 0.011];
  return { joints: J, radii, vel: V, present: true, move(d, dt) { for (let i = 0; i < 21; i++) { J[i].add(d); V[i].copy(d).divideScalar(dt); } }, still() { for (const v of V) v.set(0, 0, 0); } };
}
const out = {}, fail = [];
const dt = 1 / 30;

// 1 · free fall onto the floor → a puddle, stable
{
  const sim = new SlimeSim().spawn(new THREE.Vector3(0, 0.5, 0), R);
  const s0 = sim.stats();
  let t0 = performance.now();
  for (let i = 0; i < 90; i++) sim.step(dt, [], 0);
  const ms = (performance.now() - t0) / 90;
  const s = sim.stats();
  out.puddle = { rho0: +sim.rho0.toFixed(3), h: s.h, spacing: s.spacing, bbox0: s0.bbox, bbox: s.bbox, lowest: s.lowest, maxSpeed: s.maxSpeed, bonds: s.bonds, msPerStep: +ms.toFixed(2), nan: Number.isNaN(s.centroid[0]) };
  if (out.puddle.nan) fail.push('NaN in puddle');
  if (s.lowest < -0.01) fail.push('sank through the floor: ' + s.lowest);
  if (s.bbox[1] > 2 * R * 0.85) fail.push('did not flatten on the floor: height ' + s.bbox[1]);
  if (s.bbox[0] < 2 * R * 1.05) fail.push('did not spread on the floor: width ' + s.bbox[0]);
}
// 2 · rest on a flat hand held half under the blob: stays up on the hand, the overhang drips
{
  const sim = new SlimeSim().spawn(new THREE.Vector3(0, 0.3, 0), R);
  const H = hand(new THREE.Vector3(-0.19, 0.3 - R - 0.02, 0));           // palm top ≈ under the ball's bottom, covering x∈[-0.19, -0.02]
  for (let i = 0; i < 120; i++) sim.step(dt, [H], -0.6);
  const s = sim.stats();
  // how much of the cloud is still above the palm plane vs dripped low
  let onHand = 0, low = 0; for (let i = 0; i < sim.n; i++) { const y = sim.x[i * 3 + 1]; if (y > 0.3 - R - 0.05) onHand++; if (y < 0.3 - R - 0.2) low++; }
  out.onHand = { stuck: s.stuck, onHand, dripped: low, lowest: s.lowest, bbox: s.bbox, dripping: s.dripping, maxSpeed: s.maxSpeed };
  if (s.stuck < 40) fail.push('slime is not clinging to the hand: stuck ' + s.stuck);
  if (onHand < sim.n * 0.2) fail.push('slime did not stay on the hand: ' + onHand + '/' + sim.n);
  if (low < 20) fail.push('overhang did not drip past the hand edge: ' + low);
  if (low > sim.n * 0.6) fail.push('too runny — most of it left the hand in 4 s: ' + low + '/' + sim.n);
}
// 3 · stretch: gripped from above by curled fingers, resting on a palm below; lift the top hand
{
  const sim = new SlimeSim().spawn(new THREE.Vector3(0, 0.3, 0), R);
  const Hb = hand(new THREE.Vector3(-0.1, 0.3 - R - 0.02, 0));
  const Ht = hand(new THREE.Vector3(-0.1, 0.3 + R * 0.55, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), 0.55);  // fingers curl DOWN into the top of the blob
  for (let i = 0; i < 30; i++) sim.step(dt, [Hb, Ht], -0.6);
  const s1 = sim.stats();
  const lift = new THREE.Vector3(0, 0.25 * dt / 1.2, 0);                 // 25 cm in 1.2 s
  for (let i = 0; i < 36; i++) { Ht.move(lift, dt); sim.step(dt, [Hb, Ht], -0.6); }
  Ht.still();
  const s2 = sim.stats();
  // connectivity: bins along y — every 3cm band between top and bottom should hold particles
  const ys = []; for (let i = 0; i < sim.n; i++) ys.push(sim.x[i * 3 + 1]);
  const lo = Math.min(...ys), hi = Math.max(...ys); const bins = new Array(Math.ceil((hi - lo) / 0.03)).fill(0);
  for (const y of ys) bins[Math.min(bins.length - 1, Math.floor((y - lo) / 0.03))]++;
  const gaps = bins.filter(b => b === 0).length;
  out.stretch = { heightBefore: s1.bbox[1], heightAfter: s2.bbox[1], ratio: +(s2.bbox[1] / s1.bbox[1]).toFixed(2), topStuck: s2.stuck, gaps, bonds: s2.bonds, maxSpeed: s2.maxSpeed, bins };
  if (s2.bbox[1] < s1.bbox[1] * 1.5) fail.push('did not stretch between the hands: ' + s1.bbox[1] + ' → ' + s2.bbox[1]);
  if (gaps > 0) fail.push('the stretched slime tore: ' + gaps + ' empty bands');
}
// 4 · surface: metaballs → mesh, volume tracks the cloud, triangle count sane
{
  const sim = new SlimeSim().spawn(new THREE.Vector3(0, 0, 0), R * 0.94);   // CLOUD_R: the surface should come out at R
  const surf = new SlimeSurface(MarchingCubes, new THREE.MeshBasicMaterial(), 32);
  let t0 = performance.now(); surf.update(sim); const ms = performance.now() - t0;
  const vol = surf.volume(), v0 = (4 / 3) * Math.PI * R ** 3;
  out.surface = { tris: surf.tris, ms: +ms.toFixed(1), volume: +vol.toFixed(5), sphereVol: +v0.toFixed(5), ratio: +(vol / v0).toFixed(2), H: +surf.H.toFixed(3) };
  if (surf.tris < 2000) fail.push('surface too coarse: ' + surf.tris + ' tris');
  if (vol / v0 < 0.85 || vol / v0 > 1.25) fail.push('surface volume off the ball volume: ×' + (vol / v0).toFixed(2));
}
console.log(JSON.stringify(out, null, 1));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ slime sim — puddle, rests + drips off a hand, stretches between hands, smooth surface');
process.exit(fail.length ? 1 : 0);
