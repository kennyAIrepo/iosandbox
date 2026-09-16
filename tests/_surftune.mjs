import * as THREE from 'three';
import { SlimeSim, SlimeSurface } from '../sdk/core/slime-sim.js';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
const R = 0.16;
const sim = new SlimeSim().spawn(new THREE.Vector3(0, 0, 0), R);
for (let i = 0; i < 20; i++) sim.step(1 / 30, [], null);           // let it settle (no gravity: rigid 0 but g pulls... use no floor)
const c = sim.centroid(new THREE.Vector3());
for (const res of [32]) for (const kernel of [2.4, 2.8, 3.2]) for (const iso of [300, 420, 560]) {
  const surf = new SlimeSurface(MarchingCubes, new THREE.MeshBasicMaterial(), res);
  surf.kernel = kernel; surf.mc.isolation = iso;
  const t0 = performance.now(); surf.update(sim); const ms = performance.now() - t0;
  const P = surf.mc.positionArray, n = surf.mc.count; let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) { const x = P[i * 3] * surf.H + surf.center.x - c.x, y = P[i * 3 + 1] * surf.H + surf.center.y - c.y, z = P[i * 3 + 2] * surf.H + surf.center.z - c.z; const d = Math.hypot(x, y, z); sum += d; sum2 += d * d; }
  const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  console.log(`res ${res} kernel ${kernel} iso ${iso}: tris ${surf.tris} ms ${ms.toFixed(1)} volRatio ${(surf.volume() / (4 / 3 * Math.PI * R ** 3)).toFixed(2)} meanR ${(mean / R).toFixed(3)} bump ${(std / mean * 100).toFixed(1)}%`);
}
