import * as THREE from 'three';
import { SlimeSim } from '../sdk/core/slime-sim.js';
const sim = new SlimeSim().spawn(new THREE.Vector3(0, 0.5, 0), 0.16);
// monkey-patch section timers
const T = {}; const tm = (k, f) => { const t = performance.now(); const r = f(); T[k] = (T[k] || 0) + performance.now() - t; return r; };
const bp = sim._buildPairs.bind(sim), dn = sim._densities.bind(sim), cp = sim._capsules.bind(sim);
sim._buildPairs = () => tm('pairs', bp); sim._densities = () => tm('dens', dn);
const t0 = performance.now();
for (let i = 0; i < 90; i++) sim.step(1 / 30, [], 0);
const total = performance.now() - t0;
console.log('total/step', (total / 90).toFixed(2), 'pairs/step', (T.pairs / 90).toFixed(2), 'dens/step', (T.dens / 90).toFixed(2), 'nPairs', sim._nPairs, 'bonds', sim.bonds);
