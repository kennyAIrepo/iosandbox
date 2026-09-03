// Unit-test BowRig math against the real bow.glb (manual GLB parse → Mesh)
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { BowRig } from '../sdk/core/bow-rig.js';

const buf = readFileSync(new URL('../bow.glb', import.meta.url));
const jsonLen = buf.readUInt32LE(12);
const g = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const acc = i => {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const CT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[a.componentType];
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  return new CT(buf.buffer, buf.byteOffset + binStart + (bv.byteOffset || 0) + (a.byteOffset || 0), a.count * NC);
};
const prim = g.meshes[0].primitives[0];
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc(prim.attributes.POSITION)), 3));
if (prim.indices !== undefined) geo.setIndex(new THREE.BufferAttribute(acc(prim.indices).slice(), 1));
geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 3), 3));
const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());

const rig = new BowRig(mesh);
console.log('stats:', rig.stats, 'drawDir:', rig.drawDir.toArray().map(v => +v.toFixed(3)),
  'stringRest:', +rig.stringRest.toFixed(3));

const P = geo.getAttribute('position');
const rest = rig.rest.slice();
// pick probes: mid-string vert (w>0.9 near t=0.5), quarter-string (t≈0.25), a tip-region wood vert, a grip wood vert
let midV = -1, qV = -1, tipW = -1, gripW = -1;
for (let v = 0; v < P.count; v++) {
  const t = rig.t[v], w = rig.w[v];
  if (w > 0.9 && Math.abs(t - 0.5) < 0.02 && midV < 0) midV = v;
  if (w > 0.9 && Math.abs(t - 0.25) < 0.02 && qV < 0) qV = v;
  if (w < 0.05 && Math.abs(t - 0.97) < 0.02 && tipW < 0) tipW = v;
  if (w < 0.05 && Math.abs(t - 0.5) < 0.03 && gripW < 0) gripW = v;
}
console.log('probe verts:', { midV, qV, tipW, gripW });
const disp = (v) => {
  const dx = P.array[v * 3] - rest[v * 3], dy = P.array[v * 3 + 1] - rest[v * 3 + 1], dz = P.array[v * 3 + 2] - rest[v * 3 + 2];
  return { alongDraw: +(dx * rig.drawDir.x + dy * rig.drawDir.y + dz * rig.drawDir.z).toFixed(4), mag: +Math.hypot(dx, dy, dz).toFixed(4) };
};

rig.setDraw(0.8);
const dm = disp(midV), dq = disp(qV), dt2 = disp(tipW), dg = disp(gripW);
console.log('draw 0.8 → mid-string', dm, 'quarter-string', dq, 'tip-wood', dt2, 'grip-wood', dg);
const nock = rig.nock(new THREE.Vector3());
console.log('nock:', nock.toArray().map(v => +v.toFixed(3)));

rig.setDraw(0);
let maxErr = 0;
for (let i = 0; i < P.array.length; i++) maxErr = Math.max(maxErr, Math.abs(P.array[i] - rest[i]));
console.log('integrity: max restore error =', maxErr);

const fail = [];
if (rig.stats.stringVerts < 300 || rig.stats.woodVerts < 3000) fail.push('classification off: ' + JSON.stringify(rig.stats));
if (dm.alongDraw < 0.4) fail.push('mid-string not pulled enough: ' + dm.alongDraw);
if (!(dm.alongDraw > dq.alongDraw * 1.4)) fail.push('no peak (mid should lead quarter): ' + dm.alongDraw + ' vs ' + dq.alongDraw);
if (dt2.alongDraw < 0.03) fail.push('tip wood not flexed: ' + dt2.alongDraw);
if (dg.mag > 0.01) fail.push('grip moved (middle must stay put): ' + dg.mag);
if (maxErr > 1e-6) fail.push('INTEGRITY: draw 0 does not restore, err ' + maxErr);
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ bow rig math checks out');
process.exit(fail.length ? 1 : 0);
