// DRAGON DRIVER contract smoke — pure node (three math only, no browser).
// Rebuilds the dragon's bone hierarchy from the GLB's JSON chunk, binds the
// procedural driver and checks the ANATOMICAL contract the engine relies on:
//   · authored bone map matches the asset
//   · measured signs: look-left turns the snout to +x, look-up raises it
//   · walk translates the host forward and lifts feet during swing
//   · fly climbs, wings stroke above AND below the shoulder line, tip whips
//   · landing returns to ground and fires the callback; never a NaN
//   node tests/dragon-smoke.mjs
import fs from 'node:fs';
import * as THREE from 'three';
import { DragonDriver, DRAGON_UNIRIG, dragonContractMatches } from '../sdk/interaction/dragon-driver.js';

const buf = fs.readFileSync(new URL('../sdk/assets/avatars/dragon.glb', import.meta.url));
const len = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + len));
const nodes = json.nodes.map(n => {
  const b = new THREE.Bone(); b.name = n.name;
  if (n.translation) b.position.fromArray(n.translation);
  if (n.rotation) b.quaternion.fromArray(n.rotation);
  if (n.scale) b.scale.fromArray(n.scale);
  return b;
});
const joints = new Set(json.skins[0].joints);
json.nodes.forEach((n, i) => (n.children || []).forEach(c => { if (joints.has(c) && joints.has(i)) nodes[i].add(nodes[c]); }));
const scene = new THREE.Group();
for (const j of joints) if (!nodes[j].parent) scene.add(nodes[j]);
scene.updateMatrixWorld(true);

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };

const chk = dragonContractMatches(scene);
check('contract bones present', chk.ok && chk.bones === 69, JSON.stringify(chk));

const d = new DragonDriver().bind(scene);
const J = DRAGON_UNIRIG.joints;
const snout = J.head[J.head.length - 1];
const pos = (n) => { scene.updateMatrixWorld(true); return d.modelPos(n).clone(); };
const noNaN = () => { let ok = true; scene.traverse(o => { if (o.isBone && ([...o.quaternion.toArray(), ...o.position.toArray()].some(v => Number.isNaN(v)))) ok = false; }); return ok; };

// ── head look sign contract (left = +x, up = +y) ──
const s0 = pos(snout);
d.look.yaw = 40; d.look.pitch = 0; d._reset(); d._poseHead(); d._commit();
const sL = pos(snout);
d.look.yaw = 0; d.look.pitch = 25; d._reset(); d._poseHead(); d._commit();
const sU = pos(snout);
check('look-left moves the snout to +x (anatomical left)', sL.x - s0.x > 0.15, (sL.x - s0.x).toFixed(3));
check('look-up raises the snout', sU.y - s0.y > 0.1, (sU.y - s0.y).toFixed(3));
d.look.yaw = 0; d.look.pitch = 0;

// ── walk: host translates along its heading, feet lift in swing ──
const host = new THREE.Group();
d.auto = false; d.input.fwd = 1; d.setMode('walk');
const footRest = pos(J.hindL[4]).y;
let footMax = -1e9, footMin = 1e9;
for (let i = 0; i < 240; i++) {                   // 4 s at 60 Hz
  d.update(1 / 60, host);
  if (i > 90) { const fy = pos(J.hindL[4]).y; footMax = Math.max(footMax, fy); footMin = Math.min(footMin, fy); }
}
check('walk moves the host forward (+z at heading 0)', host.position.z > 1.5 && Math.abs(host.position.x) < 0.05, host.position.toArray().map(v => v.toFixed(2)).join(','));
check('walking feet lift during swing', footMax - footRest > 0.03, `rest ${footRest.toFixed(3)} max ${footMax.toFixed(3)} min ${footMin.toFixed(3)}`);
check('walk stays grounded', host.position.y === 0);
// steering: turn input curves the heading to the LEFT (+x)
d.input.turn = 1;
for (let i = 0; i < 120; i++) d.update(1 / 60, host);
check('turn=+1 swings heading left (+x drift)', d.heading > 0.3 && host.position.x > 0.1, `heading ${d.heading.toFixed(2)} x ${host.position.x.toFixed(2)}`);
d.input.turn = 0;

// ── run: faster stride, still grounded ──
d.setMode('run');
const z0 = host.position.z;
for (let i = 0; i < 120; i++) d.update(1 / 60, host);
check('run outpaces walk', (host.position.z - z0) > 2.0 || d.speed > 2.0, `speed ${d.speed.toFixed(2)}`);

// ── fly: climbs, wings stroke around the shoulder line ──
d.setMode('fly');
const shoulderY = pos(J.wingL.arm).y;
const tip = J.wingL.fingers[1][1];
let tipMax = -1e9, tipMin = 1e9, alt = 0;
for (let i = 0; i < 360; i++) {                   // 6 s
  d.update(1 / 60, host);
  if (i > 180) { const ty = pos(tip).y; tipMax = Math.max(tipMax, ty); tipMin = Math.min(tipMin, ty); }
  alt = Math.max(alt, d.altitude);
}
check('fly climbs toward cruise altitude', d.altitude > 2.0 && host.position.y > 2.0, `alt ${d.altitude.toFixed(2)}`);
check('wing tip strokes ABOVE the shoulder', tipMax > shoulderY + 0.3, `tipMax ${tipMax.toFixed(2)} shoulder ${shoulderY.toFixed(2)}`);
check('wing tip strokes BELOW the shoulder (downstroke)', tipMin < shoulderY - 0.2, `tipMin ${tipMin.toFixed(2)}`);
check('flap amplitude is a real stroke', tipMax - tipMin > 1.0, (tipMax - tipMin).toFixed(2));
// both wings mirror: right tip y within 10% of left tip y at the same instant
const ly = pos(tip).y, ry = pos(J.wingR.fingers[1][1]).y;
check('wings stroke symmetrically', Math.abs(ly - ry) < 0.12, `L ${ly.toFixed(2)} R ${ry.toFixed(2)}`);
// legs tuck in flight: hind foot higher than its standing rest height (relative to root)
const footFly = pos(J.hindL[4]).y;
check('legs tuck up in flight', footFly - footRest > 0.15, `rest ${footRest.toFixed(2)} fly ${footFly.toFixed(2)}`);

// ── look at a world point while flying: yaw target computed in host frame ──
const target = new THREE.Vector3(host.position.x + 5, host.position.y, host.position.z);  // world +x
host.rotation.y = 0; d.heading = 0;
d.lookAt(target);
for (let i = 0; i < 60; i++) d.update(1 / 60, host);
const snoutNow = pos(snout);
check('lookAt(world +x) turns the snout to +x', d.look.yaw > 20 && snoutNow.x > 0.15, `yaw ${d.look.yaw.toFixed(1)} snout.x ${snoutNow.x.toFixed(2)}`);
d.lookAhead();

// ── land: leaving the air descends to the floor and fires the callback ──
let landedFired = false; d.landed = () => { landedFired = true; };
d.setMode('idle');
for (let i = 0; i < 300; i++) d.update(1 / 60, host);
check('landing returns to the ground', d.altitude === 0 && host.position.y === 0, `alt ${d.altitude.toFixed(2)}`);
check('landed callback fires', landedFired);
check('idle comes to rest (speed ≈ 0)', Math.abs(d.speed) < 0.02, d.speed.toFixed(3));
check('no NaN in any bone', noNaN());

// ── external transform adoption (gizmo rotates / restore places the host) ──
host.rotation.y = 1.2; d.update(1 / 60, host);
check('driver adopts an external host rotation', Math.abs(d.heading - 1.2) < 1e-6, d.heading.toFixed(3));

console.log(fails ? `\n${fails} FAILED` : '\nall dragon contracts hold');
process.exit(fails ? 1 : 0);
