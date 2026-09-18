// FACE RIG DRIVER contract smoke — pure node: rebuilds the fox bust's bones from
// the GLB JSON, binds the driver, feeds synthetic MediaPipe faces (478 raw
// landmarks + 52 blendshapes) and checks the anatomical contract:
//   · jaw open lowers the lower lip · smile spreads + lifts the corners
//   · pucker pulls the corners in · brows lift the brow bones · blink squashes an eye
//   · head yaw: mirror → fox turns the OTHER way (screen-same side); POV → same way
//   · no face → everything eases back to rest, no NaN
//   node tests/facerig-smoke.mjs
import fs from 'node:fs';
import * as THREE from 'three';
import { FaceRigDriver, FOXBUST_UNIRIG, faceRigContractMatches } from '../sdk/interaction/face-rig-driver.js';

const buf = fs.readFileSync(new URL('../sdk/assets/avatars/foxbust.glb', import.meta.url));
const len = buf.readUInt32LE(12); const json = JSON.parse(buf.toString('utf8', 20, 20 + len));
const nodes = json.nodes.map(n => { const b = new THREE.Bone(); b.name = n.name; if (n.translation) b.position.fromArray(n.translation); if (n.rotation) b.quaternion.fromArray(n.rotation); if (n.scale) b.scale.fromArray(n.scale); return b; });
const joints = new Set(json.skins[0].joints);
json.nodes.forEach((n, i) => (n.children || []).forEach(c => { if (joints.has(c) && joints.has(i)) nodes[i].add(nodes[c]); }));
const scene = new THREE.Group(); for (const j of joints) if (!nodes[j].parent) scene.add(nodes[j]);
scene.updateMatrixWorld(true);

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };

// ── synthetic face (raw video coords: x image-right = subject's LEFT, y down) ──
const BS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPucker', 'mouthFunnel', 'cheekPuff', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'mouthFrownLeft', 'mouthFrownRight', 'noseSneerLeft', 'noseSneerRight'];
function face({ open = 0, smile = 0, pucker = 0, browUp = 0, blinkL = 0, yaw = 0, roll = 0, puff = 0 } = {}) {
  const lm = new Array(478).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  const W = 0.3, cx = 0.5, yawS = yaw / 90 * 0.5;              // yaw squeezes the far cheek toward the nose
  set(234, cx - W / 2, 0.5); set(454, cx + W / 2, 0.5);
  set(10, cx, 0.30); set(152, cx, 0.72 + open * 0.05);
  set(1, cx + yawS * W * 0.6, 0.52); set(168, cx, 0.45);
  set(33, cx - 0.08, 0.45 - roll * 0.002); set(263, cx + 0.08, 0.45 + roll * 0.002);
  const sm = smile * 0.03, pk = pucker * 0.03;
  set(61, cx - 0.05 - sm + pk, 0.62 - sm * 0.6); set(291, cx + 0.05 + sm - pk, 0.62 - sm * 0.6);
  set(78, cx - 0.045 - sm + pk, 0.62); set(308, cx + 0.045 + sm - pk, 0.62);
  set(0, cx, 0.60); set(13, cx, 0.615); set(14, cx, 0.625 + open * 0.05); set(17, cx, 0.645 + open * 0.05);
  set(50, cx - 0.08, 0.56 - sm * 0.5); set(280, cx + 0.08, 0.56 - sm * 0.5);
  set(105, cx - 0.07, 0.40 - browUp * 0.03); set(334, cx + 0.07, 0.40 - browUp * 0.03);
  const scores = { jawOpen: open, mouthSmileLeft: smile, mouthSmileRight: smile, mouthPucker: pucker, cheekPuff: puff, eyeBlinkLeft: blinkL, browInnerUp: browUp };
  return { landmarks: lm, blendshapes: BS.map(n => ({ categoryName: n, score: scores[n] || 0 })), matrix: null };
}
const DT = 1 / 30;
const run = (d, f, n) => { for (let i = 0; i < n; i++) d.update(f, DT, { aspect: 1 }); };
const pos = (d, n) => { scene.updateMatrixWorld(true); return d.modelPos(n).clone(); };
const noNaN = () => { let ok = true; scene.traverse(o => { if (o.isBone && [...o.quaternion.toArray(), ...o.position.toArray(), ...o.scale.toArray()].some(v => Number.isNaN(v))) ok = false; }); return ok; };
const J = FOXBUST_UNIRIG.joints;

check('contract bones present', faceRigContractMatches(scene).ok);
const d = new FaceRigDriver(FOXBUST_UNIRIG, { mirror: true }).bind(scene);
d.c.reactions.breathe = 0;                                     // hold the chest still: rest comparisons below are exact
check('face unit measured (cheek to cheek)', d.faceUnit > 0.15 && d.faceUnit < 0.6, d.faceUnit.toFixed(3));
run(d, face(), 60);                                            // 2 s neutral → calibrated
check('neutral captured from a calm face', d.calibrated);
const rest = { lip: pos(d, J.lipLowerTip), snout: pos(d, J.snoutTip), cL: pos(d, J.cornerL), cR: pos(d, J.cornerR), bL: pos(d, J.browL), bR: pos(d, J.browR) };

run(d, face({ open: 0.8 }), 40);
const lipOpen = pos(d, J.lipLowerTip);
check('jaw open → lower lip drops', lipOpen.y < rest.lip.y - 0.02, `Δy ${(lipOpen.y - rest.lip.y).toFixed(3)} open ${d.ch.open.toFixed(2)}`);
check('jaw open leaves the snout tip put', Math.abs(pos(d, J.snoutTip).y - rest.snout.y) < 0.01);

run(d, face(), 40); run(d, face({ smile: 1 }), 40);
const sL = pos(d, J.cornerL), sR = pos(d, J.cornerR);
check('smile → corner bones slide BACK along the muzzle (−z)', sL.z < rest.cL.z - 0.01 && sR.z < rest.cR.z - 0.01, `L ${(sL.z - rest.cL.z).toFixed(3)} R ${(sR.z - rest.cR.z).toFixed(3)}`);
check('smile → corners lift', sL.y > rest.cL.y + 0.005 && sR.y > rest.cR.y + 0.005);

run(d, face(), 40); run(d, face({ pucker: 1 }), 40);
const pL = pos(d, J.cornerL), pR = pos(d, J.cornerR), pS = pos(d, J.snoutTip);
check('pucker → corner bones slide FORWARD along the muzzle (+z)', pL.z > rest.cL.z + 0.005 && pR.z > rest.cR.z + 0.005, `L +${(pL.z - rest.cL.z).toFixed(3)} R +${(pR.z - rest.cR.z).toFixed(3)}`);
check('pucker → snout tip protrudes (+z)', pS.z > rest.snout.z + 0.005, (pS.z - rest.snout.z).toFixed(3));

run(d, face(), 40); run(d, face({ browUp: 1 }), 40);
check('brows up → brow bones lift', pos(d, J.browL).y > rest.bL.y + 0.01 && pos(d, J.browR).y > rest.bR.y + 0.01);

run(d, face(), 40); run(d, face({ blinkL: 1 }), 30);
check('user LEFT blink → (mirror) fox RIGHT eye region squashes', d.bones[J.browR].scale.y < 0.6 && d.bones[J.browL].scale.y > 0.9, `R ${d.bones[J.browR].scale.y.toFixed(2)} L ${d.bones[J.browL].scale.y.toFixed(2)}`);

run(d, face(), 40); run(d, face({ yaw: 30 }), 60);
const snoutMirror = pos(d, J.snoutTip);
check('user turns LEFT → mirror fox snout goes to fox RIGHT (−x)', d.head.yaw > 10 && snoutMirror.x < rest.snout.x - 0.02, `yaw ${d.head.yaw.toFixed(1)} Δx ${(snoutMirror.x - rest.snout.x).toFixed(3)}`);
d.mirror = false; run(d, face({ yaw: 30 }), 60);
check('POV mode → snout goes to fox LEFT (+x)', pos(d, J.snoutTip).x > rest.snout.x + 0.02);
d.mirror = true;

run(d, face({ smile: 1, open: 0.5 }), 30);
run(d, null, 90);                                             // face lost 3 s
const back = { lip: pos(d, J.lipLowerTip), cL: pos(d, J.cornerL) };
check('face lost → eases back to rest', Math.abs(back.lip.y - rest.lip.y) < 0.004 && Math.abs(back.cL.x - rest.cL.x) < 0.004 && Math.abs(d.head.yaw) < 1, `lip Δ ${(back.lip.y - rest.lip.y).toFixed(4)}`);
check('no NaN anywhere', noNaN());
// matrix head-pose path: a pure yaw rotation about +y (camera space)
const th = 25 * Math.PI / 180, mtx = [Math.cos(th), 0, -Math.sin(th), 0, 0, 1, 0, 0, Math.sin(th), 0, Math.cos(th), 0, 0, 0, 0, 1];
const fm = face(); fm.matrix = mtx; run(d, fm, 60);
check('matrix yaw +25° reads as a left turn', d.headTarget.yaw > 20, d.headTarget.yaw.toFixed(1));

console.log(fails ? `\n${fails} FAILED` : '\nall face-rig contracts hold');
process.exit(fails ? 1 : 0);
