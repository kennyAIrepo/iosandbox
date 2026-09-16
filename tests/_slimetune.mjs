// parameter sweep for the slime: rest-on-hand + stretch, one line per config
import * as THREE from 'three';
import { SlimeSim } from '../sdk/core/slime-sim.js';
const R = 0.16, dt = 1 / 30;
function hand(origin, dir = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 1, 0), curl = 0) {
  const side = new THREE.Vector3().crossVectors(dir, up).normalize();
  const J = [], V = [];
  const fingers = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const zoff = [-0.05, -0.03, -0.01, 0.012, 0.034], base = [0.03, 0.09, 0.095, 0.09, 0.08], seg = [0.035, 0.03, 0.025];
  for (let i = 0; i < 21; i++) { J.push(new THREE.Vector3()); V.push(new THREE.Vector3()); }
  J[0].copy(origin);
  fingers.forEach((f, fi) => {
    let p = origin.clone().addScaledVector(dir, base[fi]).addScaledVector(side, zoff[fi]); let d = dir.clone(); J[f[0]].copy(p);
    for (let k = 1; k < 4; k++) { d.applyAxisAngle(side, -curl * 0.9).normalize(); p = p.clone().addScaledVector(d, seg[k - 1]); J[f[k]].copy(p); }
  });
  const radii = [0.034, 0.024, 0.02, 0.017, 0.015, 0.022, 0.017, 0.015, 0.013, 0.022, 0.017, 0.015, 0.013, 0.021, 0.016, 0.014, 0.012, 0.019, 0.015, 0.013, 0.011];
  return { joints: J, radii, vel: V, present: true, move(d, dt) { for (let i = 0; i < 21; i++) { J[i].add(d); V[i].copy(d).divideScalar(dt); } }, still() { for (const v of V) v.set(0, 0, 0); } };
}
function run(opts) {
  // rest on hand (half under)
  const sim = new SlimeSim({ ...opts }).spawn(new THREE.Vector3(0, 0.3, 0), R);
  const H = hand(new THREE.Vector3(-0.19, 0.3 - R - 0.02, 0));
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) sim.step(dt, [H], -0.6);
  const ms = (performance.now() - t0) / 120;
  let onHand = 0, low = 0; for (let i = 0; i < sim.n; i++) { const y = sim.x[i * 3 + 1]; if (y > 0.3 - R - 0.05) onHand++; if (y < 0.3 - R - 0.2) low++; }
  const s = sim.stats();
  // stretch
  const sim2 = new SlimeSim({ ...opts }).spawn(new THREE.Vector3(0, 0.3, 0), R);
  const Hb = hand(new THREE.Vector3(-0.16, 0.3 - R - 0.02, 0));
  const Ht = hand(new THREE.Vector3(-0.1, 0.3 + R * 0.55, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), 0.55);
  for (let i = 0; i < 30; i++) sim2.step(dt, [Hb, Ht], -0.6);
  const s1 = sim2.stats();
  const lift = new THREE.Vector3(0, 0.25 * dt / 1.2, 0);
  for (let i = 0; i < 36; i++) { Ht.move(lift, dt); sim2.step(dt, [Hb, Ht], -0.6); }
  Ht.still(); for (let i = 0; i < 15; i++) sim2.step(dt, [Hb, Ht], -0.6);
  const s2 = sim2.stats();
  const ys = []; for (let i = 0; i < sim2.n; i++) ys.push(sim2.x[i * 3 + 1]);
  const lo = Math.min(...ys), hi = Math.max(...ys); const bins = new Array(Math.ceil((hi - lo) / 0.03)).fill(0);
  for (const y of ys) bins[Math.min(bins.length - 1, Math.floor((y - lo) / 0.03))]++;
  const gaps = bins.filter(b => b === 0).length, thin = Math.min(...bins);
  return { onHand, low, stuck: s.stuck, hLow: s.lowest, h0: s1.bbox[1], h1: s2.bbox[1], gaps, thin, bonds2: s2.bonds, low2: s2.lowest, ms: +ms.toFixed(1) };
}
const base = { n: 520, gravity: 2.5, alpha: 5, gamma: 0.15, kSpring: 0.8, visc: 0.85, band: 0.03, adhesion: 0.85, friction: 0.9, stickDrag: 0.7, maxSub: 1 / 60, breakAt: 2.0, k: 0, kNear: 40 };
const sets = [
  { name: 'base', ...base },
  { name: 'a1', ...base, alpha: 1 },
  { name: 'a2', ...base, alpha: 2 },
  { name: 'a12', ...base, alpha: 12 },
  { name: 'gam.05', ...base, gamma: 0.05 },
  { name: 'gam.3', ...base, gamma: 0.3 },
  { name: 'g4', ...base, gravity: 4 },
  { name: 'form1.1', ...base, formAt: 1.1 },
];
for (const s of sets) { const r = run(s); console.log(s.name.padEnd(10), JSON.stringify(r)); }
