// LIP SEAM contract smoke — pure node with three: rebuilds the fox bust as a real
// SkinnedMesh (positions, normals, skinIndex/skinWeight from the GLB), binds the
// driver + seam, and checks:
//   · the lip line is found across the muzzle, weights get sharpened, an edge band exists
//   · the tip of the edge is the front-most point; corners are the extremes
//   · a pucker contour pouts the tip vertices OUT (+z) and does not pinch the mid-muzzle
//   · a smile contour moves lip-edge vertices BACK along the muzzle (−z) near the corners
//   · reset restores bind positions; no NaN
//   node tests/lipseam-smoke.mjs
import fs from 'node:fs';
import * as THREE from 'three';
import { FaceRigDriver, FOXBUST_UNIRIG } from '../sdk/interaction/face-rig-driver.js';
import { LIP_UPPER, LIP_LOWER } from '../sdk/interaction/lip-contour.js';

const buf = fs.readFileSync(new URL('../sdk/assets/avatars/foxbust.glb', import.meta.url));
const len = buf.readUInt32LE(12); const json = JSON.parse(buf.toString('utf8', 20, 20 + len));
const bin = buf.subarray(20 + len + 8);
const acc = i => { const a = json.accessors[i], bv = json.bufferViews[a.bufferView]; const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]; const off = (bv.byteOffset || 0) + (a.byteOffset || 0); const T = a.componentType === 5126 ? Float32Array : a.componentType === 5123 ? Uint16Array : a.componentType === 5121 ? Uint8Array : Uint32Array; return { arr: new T(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + a.count * n * T.BYTES_PER_ELEMENT)), n }; };
const nodes = json.nodes.map(n => { const b = new THREE.Bone(); b.name = n.name; if (n.translation) b.position.fromArray(n.translation); if (n.rotation) b.quaternion.fromArray(n.rotation); if (n.scale) b.scale.fromArray(n.scale); return b; });
const joints = json.skins[0].joints;
json.nodes.forEach((n, i) => (n.children || []).forEach(c => { if (joints.includes(c) && joints.includes(i)) nodes[i].add(nodes[c]); }));
const scene = new THREE.Group(); for (const j of joints) if (!nodes[j].parent) scene.add(nodes[j]);
const prim = json.meshes[0].primitives[0];
const g = new THREE.BufferGeometry();
const P = acc(prim.attributes.POSITION), N = acc(prim.attributes.NORMAL), J = acc(prim.attributes.JOINTS_0), W = acc(prim.attributes.WEIGHTS_0), I = acc(prim.indices);
g.setAttribute('position', new THREE.BufferAttribute(P.arr, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N.arr, 3));
g.setAttribute('skinIndex', new THREE.BufferAttribute(J.arr, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(W.arr, 4)); g.setIndex(new THREE.BufferAttribute(I.arr, 1));
const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
const bones = joints.map(j => nodes[j]);
mesh.bind(new THREE.Skeleton(bones)); scene.add(mesh); scene.updateMatrixWorld(true);

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };

const d = new FaceRigDriver(FOXBUST_UNIRIG, { mirror: true }).bind(scene);
d.c.reactions.breathe = 0;
const st = d.bindMesh(mesh);
check('lip line found + weights sharpened', st && st.ok && st.sharpened > 300, st && `${st.sharpened} re-weighted, zone ${st.zone}`);
check('lip-edge band parametrized', st && st.edge > 150, st && `${st.edge} edge verts`);
const E = d.seam.stats.edgeList, O = d.seam.orig;
const tipVerts = E.filter(e => Math.abs(e.u) < 0.12), cornerVerts = E.filter(e => Math.abs(e.u) > 0.75);
check('tip verts sit ahead of corner verts (+z)', tipVerts.length > 5 && cornerVerts.length > 5 && avg(tipVerts, 'z') > avg(cornerVerts, 'z') + 0.15, `tip z ${avg(tipVerts, 'z').toFixed(2)} corner z ${avg(cornerVerts, 'z').toFixed(2)}`);
check('both upper and lower edge sides present', E.some(e => e.upper) && E.some(e => !e.upper));
function avg(list, c) { const k = { x: 0, y: 1, z: 2 }[c]; return list.reduce((s, e) => s + O[e.v * 3 + k], 0) / list.length; }
// weights after sharpening: a vertex clearly above the line has no jaw weight, one clearly below has no snout weight
const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight'), names = bones.map(b => b.name);
const wOf = (v, set) => { let s = 0; for (let k = 0; k < 4; k++) if (set.has(names[si.getComponent(v, k)])) s += sw.getComponent(v, k); return s; };
const LOWER = new Set(['Bone_044', 'Bone_043', 'Bone_054', 'Bone_053', 'Bone_052', 'Bone_051', 'Bone_056', 'Bone_055', 'Bone_058', 'Bone_057']);
const aboveV = E.filter(e => e.dy > 0.015 && e.w === 1).map(e => e.v), belowV = E.filter(e => e.dy < -0.015 && e.w === 1).map(e => e.v);
const leakAbove = aboveV.filter(v => wOf(v, LOWER) > 0.3).length / Math.max(1, aboveV.length);
const leakBelow = belowV.filter(v => wOf(v, LOWER) < 0.7).length / Math.max(1, belowV.length);
check('hinge is crisp: upper edge verts ≈ no jaw weight, lower ≈ all jaw', leakAbove < 0.25 && leakBelow < 0.25, `leak above ${(leakAbove * 100).toFixed(0)}% below ${(leakBelow * 100).toFixed(0)}%`);

// ── synthetic face with a full outer-lip contour ──
const BS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPucker', 'mouthFunnel', 'cheekPuff', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp'];
function face({ open = 0, smile = 0, pucker = 0 } = {}) {
  const lm = new Array(478).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  const cx = 0.5; set(234, 0.35, 0.5); set(454, 0.65, 0.5); set(10, cx, 0.30); set(152, cx, 0.72 + open * 0.05); set(1, cx, 0.52); set(33, 0.42, 0.45); set(263, 0.58, 0.45);
  set(50, 0.42, 0.56); set(280, 0.58, 0.56); set(105, 0.43, 0.40); set(334, 0.57, 0.40); set(13, cx, 0.615); set(14, cx, 0.625 + open * 0.05);
  // outer lip contour: half-width 0.05 (+ smile, − pucker), corners rise on a smile, lower arc drops with open
  const hw = 0.05 + smile * 0.03 - pucker * 0.03;
  LIP_UPPER.forEach((i, k) => { const t = k / (LIP_UPPER.length - 1) * 2 - 1; set(i, cx + t * hw, 0.60 + 0.02 * t * t - smile * 0.02 * t * t); });
  LIP_LOWER.forEach((i, k) => { const t = k / (LIP_LOWER.length - 1) * 2 - 1; set(i, cx + t * hw, 0.645 + open * 0.05 - 0.025 * t * t - smile * 0.02 * t * t); });
  const scores = { jawOpen: open, mouthSmileLeft: smile, mouthSmileRight: smile, mouthPucker: pucker };
  return { landmarks: lm, blendshapes: BS.map(n => ({ categoryName: n, score: scores[n] || 0 })), matrix: null };
}
const run = (f, n) => { for (let i = 0; i < n; i++) d.update(f, 1 / 30, { aspect: 1 }); };
const Pn = g.getAttribute('position').array;
const meanOff = (list, c) => { const k = { x: 0, y: 1, z: 2 }[c]; return list.reduce((s, e) => s + (Pn[e.v * 3 + k] - O[e.v * 3 + k]), 0) / Math.max(1, list.length); };
run(face(), 60);
check('neutral → contour parametrized', d.calibrated && d.lipU && d.lipU.upper.length === 11 && Math.abs(d.lipU.upper[0].u + 1) < 1e-6, d.lipU && d.lipU.upper.map(p => p.u.toFixed(2)).join(' '));
check('neutral → lip edge at rest', Math.abs(meanOff(E, 'z')) < 1e-3 && Math.abs(meanOff(E, 'y')) < 1e-3);
run(face({ pucker: 1 }), 40);
const midMuzzle = E.filter(e => Math.abs(e.u) > 0.35 && Math.abs(e.u) < 0.7);
check('pucker → tip pouts forward (+z)', meanOff(tipVerts, 'z') > 0.004, meanOff(tipVerts, 'z').toFixed(4));
check('pucker → lip edge slides toward the tip, never pinching the mid-muzzle sideways', Math.abs(meanOff(midMuzzle, 'x')) < 0.012 && meanOff(cornerVerts, 'z') > 0.002, `mid x ${meanOff(midMuzzle, 'x').toFixed(4)} corner z ${meanOff(cornerVerts, 'z').toFixed(4)}`);
run(face(), 40); run(face({ smile: 1 }), 40);
check('smile → corner-side edge moves BACK along the muzzle (−z) and up', meanOff(cornerVerts, 'z') < -0.004 && meanOff(cornerVerts, 'y') > 0.002, `corner z ${meanOff(cornerVerts, 'z').toFixed(4)} y ${meanOff(cornerVerts, 'y').toFixed(4)}`);
run(face(), 40); run(face({ open: 0.8 }), 40);
check('open → lower edge verts stay on the lip line (jaw carries them), no double drop', Math.abs(meanOff(E.filter(e => !e.upper), 'y')) < 0.006, meanOff(E.filter(e => !e.upper), 'y').toFixed(4));
run(null, 90);
check('face lost → edge returns to bind', Math.abs(meanOff(E, 'z')) < 5e-4 && Math.abs(meanOff(E, 'y')) < 5e-4);
d.seam.reset();
check('reset restores bind positions exactly', Pn.every((v, i) => v === O[i]));
check('no NaN in positions', !Pn.some(Number.isNaN));
console.log(fails ? `\n${fails} FAILED` : '\nall lip-seam contracts hold');
process.exit(fails ? 1 : 0);
