// ARP FACE DRIVER contract smoke — pure node with three: rebuilds the foxfull_face.glb
// bone hierarchy (no mesh needed: every check reads bone positions), binds the
// ArpFaceDriver, feeds synthetic MediaPipe faces and checks:
//   · the contract matches (every named facial bone present), signs measured
//   · NEUTRAL closes the modelled-open mouth (tip gap shrinks ≥ 75 %)
//   · OPEN drops the chin and grows the tip gap past rest
//   · SMILE pulls the commissures BACK along the muzzle (−z) and up; upper ring lifts
//   · PUCKER pouts the lip tips forward (+z) and pulls the commissures toward the tip
//   · BROWS raise the four brow bones; BLINK drops the upper lids toward the lower lids
//   · GAZE rotates the eye bones; HEAD turn moves the nose (mirror → user left = fox right)
//   · face lost → everything eases back; reset exact
//   node tests/facerig-arp-smoke.mjs
import fs from 'node:fs';
import * as THREE from 'three';
import { ArpFaceDriver, FOX_ARP, arpContractMatches } from '../sdk/interaction/arp-face-driver.js';
import { LIP_UPPER, LIP_LOWER } from '../sdk/interaction/lip-contour.js';

const buf = fs.readFileSync(new URL('../sdk/assets/avatars/foxfull_face.glb', import.meta.url));
const len = buf.readUInt32LE(12); const json = JSON.parse(buf.toString('utf8', 20, 20 + len));
const nodes = json.nodes.map(n => { const b = new THREE.Bone(); b.name = n.name; if (n.translation) b.position.fromArray(n.translation); if (n.rotation) b.quaternion.fromArray(n.rotation); if (n.scale) b.scale.fromArray(n.scale); return b; });
const joints = json.skins[0].joints;
json.nodes.forEach((n, i) => (n.children || []).forEach(c => { if (joints.includes(c) && joints.includes(i)) nodes[i].add(nodes[c]); }));
const scene = new THREE.Group(); for (const j of joints) if (!nodes[j].parent) scene.add(nodes[j]);
scene.updateMatrixWorld(true);

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };
const chk = arpContractMatches(scene);
check('contract matches (all facial bones present)', chk.ok, chk.ok ? `${chk.bones} bones` : 'missing ' + chk.missing.join(','));
const d = new ArpFaceDriver(FOX_ARP, { mirror: true }).bind(scene);
check('signs measured: jaw + head + ears', Math.abs(d.sign.jawOpen) === 1 && Math.abs(d.sign.headLeft) === 1 && Math.abs(d.sign.earLPerk) === 1, JSON.stringify(d.sign));
check('rest slot between the lips is known (> 2 mm) and closeDeg > 0', d.ring.gapTip > 0.002 && d.closeDeg > 0, `slot ${(d.ring.gapTip * 1000).toFixed(1)} mm, closeDeg ${d.closeDeg.toFixed(2)}`);
const P = n => d.modelPos(n).clone();
const gap = () => P('lips_top.x').y - P('lips_bot.x').y;
const rest = { gap: gap(), chin: P('chin_01.x'), cL: P('lips_smile.l'), cR: P('lips_smile.r'), top: P('lips_top.x'), bot: P('lips_bot.x'), brow: P('eyebrow_02.l'), lidT: P('eyelid_top_02.l'), lidB: P('eyelid_bot_02.l'), nose: P('nose_tip.x'), top01: P('lips_top_01.l') };

const BS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPucker', 'mouthFunnel', 'cheekPuff', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'noseSneerLeft', 'noseSneerRight'];
function face({ open = 0, lips = 0, smile = 0, pucker = 0, browUp = 0, blinkL = 0, yaw = 0, gaze = 0 } = {}) {
  const lo = open * 0.05 + Math.max(0, lips - open) * 0.018;       // open = jaw + lips (chin drops); lips alone = parted ~0.05 face-widths over a shut jaw (ee)
  const lm = new Array(478).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  const cx = 0.5, yawS = yaw / 90 * 0.5;
  set(234, 0.35, 0.5); set(454, 0.65, 0.5); set(10, cx, 0.30); set(152, cx, 0.72 + open * 0.05); set(1, cx + yawS * 0.3 * 0.6, 0.52); set(168, cx, 0.45); set(33, 0.42, 0.45); set(263, 0.58, 0.45);
  set(50, 0.42, 0.56 - smile * 0.015); set(280, 0.58, 0.56 - smile * 0.015); set(105, 0.43, 0.40 - browUp * 0.03); set(334, 0.57, 0.40 - browUp * 0.03);
  for (const [i, x] of [[107, 0.46], [66, 0.44], [105, 0.43], [63, 0.41]]) set(i, x, 0.40 - browUp * 0.03);
  for (const [i, x] of [[336, 0.54], [296, 0.56], [334, 0.57], [293, 0.59]]) set(i, x, 0.40 - browUp * 0.03);
  set(13, cx, 0.615); set(14, cx, 0.625 + lo);
  const hw = 0.05 + smile * 0.03 - pucker * 0.03;
  LIP_UPPER.forEach((i, k) => { const t = k / (LIP_UPPER.length - 1) * 2 - 1; set(i, cx + t * hw, 0.60 + 0.02 * t * t - smile * 0.02 * t * t); });
  LIP_LOWER.forEach((i, k) => { const t = k / (LIP_LOWER.length - 1) * 2 - 1; const o = Math.abs(t) > 0.99 ? lo * 0.24 : lo; set(i, cx + t * hw, 0.645 + o - 0.025 * t * t - smile * 0.02 * t * t); });   // corners drop only a little with the jaw
  const scores = { jawOpen: open, mouthSmileLeft: smile, mouthSmileRight: smile, mouthPucker: pucker, browInnerUp: browUp, eyeBlinkLeft: blinkL,
    eyeLookOutLeft: Math.max(0, gaze), eyeLookInLeft: Math.max(0, -gaze), eyeLookInRight: Math.max(0, gaze), eyeLookOutRight: Math.max(0, -gaze) };
  return { landmarks: lm, blendshapes: BS.map(n => ({ categoryName: n, score: scores[n] || 0 })), matrix: null };
}
const run = (f, n) => { for (let i = 0; i < n; i++) d.update(f, 1 / 30, { aspect: 1 }); scene.updateMatrixWorld(true); };

run(face(), 60);
check('neutral captured', d.calibrated && d.lipU && d.lipU.upper.length === 11);
const gN = gap();
check('neutral → the modelled slot CLOSES (lip bones move together by ≥ 75 % of the slot)', rest.gap - gN > d.ring.gapTip * 0.75, `${(rest.gap * 1000).toFixed(1)} → ${(gN * 1000).toFixed(1)} mm (slot ${(d.ring.gapTip * 1000).toFixed(1)})`);
check('neutral → commissures stay put (no penetration)', P('lips_smile.l').distanceTo(rest.cL) < 0.004 && P('lips_smile.r').distanceTo(rest.cR) < 0.004, (P('lips_smile.l').distanceTo(rest.cL) * 1000).toFixed(1) + ' mm');
const chinN = P('chin_01.x');
run(face({ open: 0.9 }), 40);
check('open → chin drops', P('chin_01.x').y < chinN.y - 0.015, `${((P('chin_01.x').y - chinN.y) * 1000).toFixed(1)} mm`);
check('open → tip gap wider than the modelled rest gap', gap() > rest.gap * 1.3, `${(gap() * 1000).toFixed(1)} mm`);
check('open → commissures follow half the jaw (down, not up)', P('lips_smile.l').y < rest.cL.y - 0.002 && P('lips_smile.l').y > chinN.y, ((P('lips_smile.l').y - rest.cL.y) * 1000).toFixed(1) + ' mm');
run(face(), 40); run(face({ lips: 1 }), 40);
check('lips parted over a shut jaw (ee) → rings part, chin barely moves', gap() > rest.gap * 0.8 && P('chin_01.x').y > chinN.y - 0.012, `gap ${(gap() * 1000).toFixed(1)} mm chin ${((P('chin_01.x').y - chinN.y) * 1000).toFixed(1)} mm`);
run(face(), 40); run(face({ smile: 1 }), 40);
check('smile → commissures BACK along the muzzle (−z) and up', P('lips_smile.l').z < rest.cL.z - 0.004 && P('lips_smile.r').z < rest.cR.z - 0.004 && P('lips_smile.l').y > rest.cL.y + 0.002,
  `dz ${((P('lips_smile.l').z - rest.cL.z) * 1000).toFixed(1)} mm dy ${((P('lips_smile.l').y - rest.cL.y) * 1000).toFixed(1)} mm`);
check('smile → mid upper ring moves back too', P('lips_top_01.l').z < rest.top01.z - 0.001, ((P('lips_top_01.l').z - rest.top01.z) * 1000).toFixed(1) + ' mm');
run(face(), 40); run(face({ pucker: 1 }), 40);
check('pucker → lip tips pout forward (+z)', P('lips_top.x').z > rest.top.z + 0.003 && P('lips_bot.x').z > rest.bot.z + 0.003, `top dz ${((P('lips_top.x').z - rest.top.z) * 1000).toFixed(1)} mm`);
check('pucker → commissures toward the tip (+z)', P('lips_smile.l').z > rest.cL.z + 0.002, ((P('lips_smile.l').z - rest.cL.z) * 1000).toFixed(1) + ' mm');
run(face(), 40); run(face({ browUp: 1, blinkL: 1 }), 40);
const browRest = Object.fromEntries(['01', '02', '03', '04'].map(n => [n, d.rest['eyebrow_' + n + '.l'].p.y]));
check('brows → all four bones rise', ['01', '02', '03', '04'].every(n => d.bones['eyebrow_' + n + '.l'].position.y > browRest[n] + 0.003), ((d.bones['eyebrow_02.l'].position.y - browRest['02']) * 1000).toFixed(1) + ' mm');
// human LEFT blink → mirror → fox RIGHT lid
const lidDropR = d.rest['eyelid_top_02.r'].p.y - d.bones['eyelid_top_02.r'].position.y, lidDropL = d.rest['eyelid_top_02.l'].p.y - d.bones['eyelid_top_02.l'].position.y;
check('blink (human left) → fox RIGHT upper lid drops, left lid stays', lidDropR > 0.004 && lidDropL < 0.002, `R ${(lidDropR * 1000).toFixed(1)} mm, L ${(lidDropL * 1000).toFixed(1)} mm`);
run(face(), 40); run(face({ gaze: 1 }), 40);
const eyeQ = d.bones['eye.l'].quaternion.clone(), restQ = d.rest['eye.l'].q;
check('gaze → eye bones rotate', eyeQ.angleTo(restQ) > 5 * Math.PI / 180, (eyeQ.angleTo(restQ) * 180 / Math.PI).toFixed(1) + '°');
run(face(), 40); run(face({ yaw: 30 }), 50);
check('head turn (user left) → mirror: nose moves to the fox RIGHT (−x)', P('nose_tip.x').x < rest.nose.x - 0.01, ((P('nose_tip.x').x - rest.nose.x) * 1000).toFixed(1) + ' mm');
run(null, 120);
check('face lost → jaw eases back (gap returns toward rest)', Math.abs(gap() - rest.gap) < 0.004 && Math.abs(P('nose_tip.x').x - rest.nose.x) < 0.003, `gap ${(gap() * 1000).toFixed(1)} mm`);
d._reset(); scene.updateMatrixWorld(true);
check('reset exact', P('lips_top.x').distanceTo(rest.top) < 1e-9 && P('chin_01.x').distanceTo(rest.chin) < 1e-9);
console.log(fails ? `\n${fails} FAILED` : '\nall ARP face contracts hold');
process.exit(fails ? 1 : 0);
