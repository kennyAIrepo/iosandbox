/**
 * hopeOS SDK — Face Rig Driver (human face → rigged creature bust)
 * ═══════════════════════════════════════════════════════════════
 * Drives a rigged head/bust GLB (UniRig auto-rig: generic Bone_NNN, NO
 * morph targets) from the MediaPipe Face Landmarker feed — 478 landmarks
 * + 52 blendshapes + optional facial transform — so a user's lips,
 * expressions and head turns land on the creature live. First puppet:
 * the fox bust (FOXBUST_UNIRIG), whose auto-rig turned out to carry a
 * real jaw hinge, a lower-lip chain, a snout/upper-lip bone, muzzle-side
 * corner bones, cheeks, eye/brow regions, forehead, ears and jowls
 * (regions measured from the skin weights, see the contract comments).
 *
 * DESIGN — a hybrid, chosen from the rig + the retargeting literature:
 *
 *   JAW            a hinge → ROTATION of the jaw bone from mouth.open =
 *                  max(jawOpen blendshape, geometric MAR) — MAR stays
 *                  linear where the blendshape saturates.
 *   LIP ALIGNMENT  human lip / corner / cheek / brow LANDMARKS are aligned
 *                  to the fox's SAME-ROLE BONES: each landmark's
 *                  displacement from that person's own NEUTRAL, measured
 *                  in the face's rigid frame (cheek-to-cheek = 1 unit),
 *                  becomes a translation of the matched bone scaled by the
 *                  fox's face width. Deltas, never positions, cross the
 *                  human→puppet boundary (face-measures doctrine), so any
 *                  face maps onto the fox's rest.
 *   BLENDSHAPES    for what 2-D positions cannot say: blink / wide (eye
 *                  region squash), cheek puff (cheek scale), pucker and
 *                  funnel (lip protrusion along the snout), inner brow.
 *   HEAD           yaw / pitch / roll from the facial transform matrix
 *                  (landmark geometry as fallback), split head:neck 70:30,
 *                  damped and clamped.
 *   REACTIONS      ears perk on surprise and flatten on anger, lag the
 *                  head turn; chest breathes; auto-blink when the face is
 *                  lost; every channel eases to rest without a face.
 *
 * SIGNS ARE MEASURED at bind (dragon-driver doctrine): rotation channels
 * nudge the bone and read the tip; translation channels apply model-frame
 * deltas through each bone's parent frame, so no sign is assumed.
 *
 * MIRROR (default on): the bust faces the user like a mirror — the user's
 * left mouth corner drives the fox's RIGHT corner (same side of the
 * screen), head yaw / roll flip. mirror:false gives the POV mapping.
 *
 * Usage:
 *   const fr = new FaceRigDriver().bind(gltf.scene);
 *   fr.update(frame.face, dt, { aspect: vid.videoWidth / vid.videoHeight });
 *   fr.calibrate();            // re-capture the neutral face (optional)
 */

import * as THREE from 'three';
import { OneEuro } from '../core/filters.js';
import { LipSeam, LIP_UPPER, LIP_LOWER } from './lip-contour.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// MediaPipe canonical face mesh indices (raw video coords: x image-right =
// the subject's LEFT, y down). Verified sets from face-measures / mouth.js.
export const FACE_LM = {
  faceR: 234, faceL: 454, forehead: 10, chin: 152, noseTip: 1, noseBridge: 168,
  upperOuter: 0, lowerOuter: 17, upperInner: 13, lowerInner: 14,
  innerCornerR: 78, innerCornerL: 308, cornerR: 61, cornerL: 291,
  cheekR: 50, cheekL: 280, browR: 105, browL: 334,
  eyeOutR: 33, eyeOutL: 263,
};

export const FOXBUST_UNIRIG = {
  name: 'foxbust-unirig',
  // +z = face forward, +y up, +x = the fox's anatomical LEFT
  joints: {
    root: 'Bone_000', chest: 'Bone_003',
    neck: ['Bone_012', 'Bone_011', 'Bone_020'], head: 'Bone_019',
    jaw: 'Bone_044', jawTip: 'Bone_043',                 // hinge under the head → chin
    lipLower: 'Bone_054', lipLowerTip: 'Bone_051',       // lower-lip centre chain (471 verts at the tip)
    snout: 'Bone_038', snoutTip: 'Bone_037',             // upper lip / nose (front-most verts)
    cornerL: 'Bone_042', cornerR: 'Bone_040',            // muzzle sides = mouth corners
    cheekL: 'Bone_034', cheekR: 'Bone_036',
    browL: 'Bone_030', browR: 'Bone_032',                // eye + brow regions
    forehead: 'Bone_028',
    earL: 'Bone_047', earLTip: 'Bone_045', earR: 'Bone_050', earRTip: 'Bone_048',
    jowlL: 'Bone_023', jowlR: 'Bone_026',
  },
  faceWidthBones: ['Bone_034', 'Bone_036'],  // cheek-to-cheek = the fox's face unit
  jawMaxDeg: 15,          // crisp hinge on a long muzzle: 15° reads wide open
  head: { yawMax: 40, pitchMax: 25, rollMax: 20, damp: 9, neckShare: 0.3 },
  gain: { lipUpper: 1.2, lipLower: 1.2, corner: 1.6, cheek: 1.2, brow: 1.3, protrude: 0.045 },
  reactions: { earPerk: 22, earFlat: 30, earLag: 0.5, breathe: 0.012 },
};

export function faceRigContractMatches(scene, contract = FOXBUST_UNIRIG) {
  const names = new Set(); scene.traverse(o => { if (o.isBone) names.add(o.name); });
  const need = Object.values(contract.joints).flat();
  const missing = need.filter(n => !names.has(n));
  return { ok: missing.length === 0, missing, bones: names.size };
}

const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// tracked landmark keys: named anchors + the outer-lip contour ('c<index>')
const KEYS = ['upperOuter', 'lowerOuter', 'cornerR', 'cornerL', 'cheekR', 'cheekL', 'browR', 'browL', 'chin', 'noseTip',
  ...[...new Set([...LIP_UPPER, ...LIP_LOWER])].map(i => 'c' + i)];
const bs = (arr, name) => { if (!arr) return 0; const c = arr.find(b => b.categoryName === name); return c ? c.score : 0; };

export class FaceRigDriver {
  constructor(contract = FOXBUST_UNIRIG, opts = {}) {
    this.c = contract;
    this.mirror = opts.mirror !== undefined ? !!opts.mirror : true;
    this.keys = KEYS.slice();          // tracked landmark keys (subclasses append their own before the first update)
    this.root = null; this.bones = {}; this.rest = {}; this.local = {}; this.plocal = {}; this.sign = {};
    this._acc = {}; this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._m = new THREE.Matrix4();
    this._f = {};                    // OneEuro per channel
    this.faceUnit = 1;               // fox face width (model units)
    // ── neutral capture ──
    this.neutral = null;             // landmark id → [x,y] in the face frame
    this._nAcc = null; this._nT = 0; this.calibrated = false;
    // ── live channels (smoothed) ──
    this.ch = { open: 0, jaw: 0, pucker: 0, funnel: 0, puff: 0, blinkL: 0, blinkR: 0, wideL: 0, wideR: 0, browInner: 0, surprise: 0, anger: 0, smile: 0 };
    this.delta = {};                 // landmark key → {x,y} smoothed deltas (face units)
    this.head = { yaw: 0, pitch: 0, roll: 0 };
    this.headTarget = { yaw: 0, pitch: 0, roll: 0 };
    this.seen = false; this.lostFor = 0; this.t = 0; this.presence = 0;
    this._earYaw = 0; this._blinkT = 2 + Math.random() * 3; this._blink = 0;
    // ── lip contour alignment (needs bindMesh) ──
    this.seam = null;                // LipSeam over the skinned muzzle
    this.lipU = null;                // { upper: [{key,u}], lower: [{key,u}] } human contour parametrized at neutral
  }

  bind(scene) {
    this.root = scene;
    scene.traverse(o => { if (o.isBone) { this.bones[o.name] = o; this.rest[o.name] = { q: o.quaternion.clone(), p: o.position.clone(), s: o.scale.clone() }; } });
    const chk = faceRigContractMatches(scene, this.c);
    if (!chk.ok) throw new Error('face-rig contract mismatch — missing ' + chk.missing.join(','));
    this._captureAxes();
    this._calibrateSigns();
    const [a, b] = this.c.faceWidthBones;
    this.faceUnit = Math.max(1e-3, this.modelPos(a).distanceTo(this.modelPos(b, this._v2)));
    // virtual jaw hinge: behind and below the rig's jaw root, level with the lips
    const jr = this.modelPos(this.c.joints.jaw).clone(), jt = this.modelPos(this.c.joints.jawTip).clone();
    this.jawHinge = new THREE.Vector3(jr.x, jt.y + 0.35 * (jr.y - jt.y), jr.z - 0.25 * this.faceUnit);
    return this;
  }
  /** Attach the skinned mesh: finds the lip line, sharpens the jaw hinge, parametrizes the lip edge. */
  bindMesh(skinnedMesh) {
    const j = this.c.joints;
    const upper = [j.snoutTip, j.snout, j.head, 'Bone_041', 'Bone_039', j.cornerL, j.cornerR];
    const lower = [j.jaw, j.jawTip, j.lipLower, 'Bone_053', 'Bone_052', j.lipLowerTip, 'Bone_056', 'Bone_055', 'Bone_058', 'Bone_057'];
    this.root.updateWorldMatrix(true, true);
    const pivot = this.modelPos(j.jaw).clone();
    this.seam = new LipSeam(skinnedMesh, { upperBones: upper, lowerBones: lower, upperFill: j.snoutTip, lowerFill: j.lipLowerTip, pivot });
    if (!this.seam.stats.ok) this.seam = null;
    if (this.seam && !this.tongue) this._addTongue(skinnedMesh);
    return this.seam ? this.seam.stats : null;
  }
  // a black mouth bag reads as "nothing happened": a pink tongue on the jaw
  // floor makes every opening legible (the lizard lane's procedural-tongue idea)
  _addTongue(skinnedMesh) {
    const j = this.c.joints, U = this.faceUnit, st = this.seam.stats;
    const lipMid = st.line[Math.round(st.line.length / 2)];
    const tip = this.modelPos(j.snoutTip).clone(), root = this.modelPos(j.lipLower).clone();
    const geo = new THREE.SphereGeometry(1, 20, 12); geo.scale(U * 0.24, U * 0.075, U * 0.42);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd85d7a, roughness: 0.55, metalness: 0 });
    const m = new THREE.Mesh(geo, mat); m.name = 'tongue'; m.frustumCulled = false;
    const anchor = this.bones['Bone_053'] || this.bones[j.lipLower];
    const p = new THREE.Vector3(tip.x, lipMid - U * 0.09, root.z + U * 0.55);   // on the jaw floor, filling the front of the mouth
    this.root.updateWorldMatrix(true, true);
    anchor.add(m); m.position.copy(anchor.worldToLocal(this.root.localToWorld(p)));
    this.tongue = m;
    // a dim warm light inside the mouth: the bag's texture is near-black, so an
    // open mouth otherwise renders as a void from the front
    const light = new THREE.PointLight(0xffc9a8, 0.9, 0.32, 2); light.name = 'mouthLight';
    const head = this.bones[j.head]; head.add(light);
    light.position.copy(head.worldToLocal(this.root.localToWorld(new THREE.Vector3(tip.x, lipMid + U * 0.02, root.z + U * 0.5))));
    this.mouthLight = light;
  }
  _captureAxes() {
    this.root.updateWorldMatrix(true, true);
    const rootQ = new THREE.Quaternion(); this.root.getWorldQuaternion(rootQ);
    const rootInv = rootQ.clone().invert(), wq = new THREE.Quaternion();
    for (const [name, b] of Object.entries(this.bones)) {
      b.getWorldQuaternion(wq);
      const rel = rootInv.clone().multiply(wq).invert();
      this.local[name] = { x: AXIS.x.clone().applyQuaternion(rel), y: AXIS.y.clone().applyQuaternion(rel), z: AXIS.z.clone().applyQuaternion(rel) };
      // model axes in the PARENT's frame — translations live there
      const par = b.parent;
      if (par && par.isBone) { par.getWorldQuaternion(wq); const prel = rootInv.clone().multiply(wq).invert();
        this.plocal[name] = { x: AXIS.x.clone().applyQuaternion(prel), y: AXIS.y.clone().applyQuaternion(prel), z: AXIS.z.clone().applyQuaternion(prel) }; }
      else this.plocal[name] = { x: AXIS.x.clone(), y: AXIS.y.clone(), z: AXIS.z.clone() };
    }
  }
  modelPos(name, out = new THREE.Vector3()) {
    const b = this.bones[name]; b.updateWorldMatrix(true, false);
    this._m.copy(this.root.matrixWorld).invert();
    return out.setFromMatrixPosition(b.matrixWorld).applyMatrix4(this._m);
  }
  _rot(name, axis, deg) {
    if (!deg) return; const L = this.local[name]; if (!L) return;
    const q = this._acc[name] || (this._acc[name] = new THREE.Quaternion());
    q.multiply(this._q.setFromAxisAngle(L[axis], deg * D2R));
  }
  // rotate a bone about a model-frame point c instead of its own origin: the
  // origin moves to c + R(o − c); the delta is applied through the parent frame
  _rotAbout(name, axis, deg, c) {
    this._rot(name, axis, deg);
    const b = this.bones[name], L = this.local[name]; if (!b || !L || !deg) return;
    const o = this.modelPos(name, this._v);                            // rest origin (model frame)
    const q = this._q.setFromAxisAngle(AXIS[axis], deg * D2R);
    const r = this._v2.copy(o).sub(c).applyQuaternion(q).add(c).sub(o); // model-frame delta of the origin
    this._move(name, r.x, r.y, r.z);
  }
  _move(name, dx, dy, dz) {                    // model-frame delta → parent-local position offset
    const b = this.bones[name], P = this.plocal[name]; if (!b || !P) return;
    b.position.addScaledVector(P.x, dx).addScaledVector(P.y, dy).addScaledVector(P.z, dz);
  }
  _scale(name, sx, sy, sz) { const b = this.bones[name]; if (b) b.scale.set(this.rest[name].s.x * sx, this.rest[name].s.y * sy, this.rest[name].s.z * sz); }
  _reset() { for (const [n, r] of Object.entries(this.rest)) { const b = this.bones[n]; b.quaternion.copy(r.q); b.position.copy(r.p); b.scale.copy(r.s); } for (const q of Object.values(this._acc)) q.identity(); }
  _commit() { for (const [n, q] of Object.entries(this._acc)) if (q.w !== 1) this.bones[n].quaternion.copy(this.rest[n].q).multiply(q); }
  _probe(name, axis, deg, tip, comp) {
    this._reset(); this.root.updateWorldMatrix(true, true);
    const p0 = this.modelPos(tip, this._v).clone();
    this._rot(name, axis, deg); this._commit(); this.root.updateWorldMatrix(true, true);
    const d = this.modelPos(tip, this._v2)[comp] - p0[comp];
    this._reset();
    return Math.abs(d) < 1e-7 ? 1 : Math.sign(d);
  }
  _calibrateSigns() {
    const j = this.c.joints, S = this.sign;
    S.jawOpen = -this._probe(j.jaw, 'x', 10, j.lipLowerTip, 'y');       // + → lower lip DOWN
    S.headLeft = this._probe(j.head, 'y', 10, j.snoutTip, 'x');          // + → snout to +x (its left)
    S.headUp = this._probe(j.head, 'x', 10, j.snoutTip, 'y');            // + → snout up
    S.headRollL = -this._probe(j.head, 'z', 10, j.earLTip, 'y');         // + → left ear DOWN (tilt left)
    S.earLPerk = this._probe(j.earL, 'x', 10, j.earLTip, 'z');           // + → ear tip forward
    S.earRPerk = this._probe(j.earR, 'x', 10, j.earRTip, 'z');
    S.earLYaw = this._probe(j.earL, 'y', 10, j.earLTip, 'x');
    S.earRYaw = this._probe(j.earR, 'y', 10, j.earRTip, 'x');
    S.snoutUp = this._probe(j.snout, 'x', 10, j.snoutTip, 'y');          // + → nose up (sneer)
    this.root.updateWorldMatrix(true, true);
  }

  /** Re-capture the user's neutral face over the next ~1.2 s. */
  calibrate() { this.neutral = null; this._nAcc = null; this._nT = 0; this.calibrated = false; this.marRest = null; this.chinRest = null; }

  _flt(key, v, dt, cut = 2.5, beta = 0.08) {
    const f = this._f[key] || (this._f[key] = new OneEuro(cut, beta));
    return f.filter(v, dt);
  }

  // ── the face frame: rigid, from cheek edges + forehead/chin; unit = face width ──
  _frame(lm, aspect) {
    const P = i => ({ x: lm[i].x * aspect, y: lm[i].y, z: lm[i].z * aspect });
    const R = P(FACE_LM.faceR), L = P(FACE_LM.faceL), T = P(FACE_LM.forehead), B = P(FACE_LM.chin);
    const O = { x: (R.x + L.x) / 2, y: (R.y + L.y) / 2 };
    let X = [L.x - R.x, L.y - R.y]; const W = Math.hypot(X[0], X[1]) || 1e-6; X = [X[0] / W, X[1] / W];
    let Y = [T.x - B.x, T.y - B.y]; const k = Y[0] * X[0] + Y[1] * X[1]; Y = [Y[0] - k * X[0], Y[1] - k * X[1]]; const ly = Math.hypot(Y[0], Y[1]) || 1e-6; Y = [Y[0] / ly, Y[1] / ly];
    const local = i => { const p = P(i); const dx = p.x - O.x, dy = p.y - O.y; return [(dx * X[0] + dy * X[1]) / W, (dx * Y[0] + dy * Y[1]) / W]; };
    return { local, W, P };
  }

  /**
   * @param {object|null} face  { landmarks, blendshapes, matrix } from tracking.js (or null)
   * @param {number} dt         seconds
   * @param {object} o          { aspect: videoWidth/videoHeight }
   */
  update(face, dt, o = {}) {
    dt = clamp(dt, 0, 0.1); this.t += dt;
    const aspect = o.aspect || 1;
    const lm = face && face.landmarks && face.landmarks.length >= 468 ? face.landmarks : null;
    this.seen = !!lm;
    this.lostFor = lm ? 0 : this.lostFor + dt;
    this.presence += clamp((lm ? 1 : 0) - this.presence, -dt * 3, dt * 3);
    if (lm) this._read(lm, face.blendshapes, face.matrix, aspect, dt);
    else this._decay(dt);
    this._pose(dt);
    return this;
  }

  _read(lm, shapes, matrix, aspect, dt) {
    const F = this._frame(lm, aspect);
    const keys = this.keys;
    const cur = {}; for (const k of keys) cur[k] = F.local(FACE_LM[k] ?? +k.slice(1));
    // ── geometric measures ──
    const d2 = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
    // lip gap over the RIGID face width (not mouth width: a pucker narrows the
    // mouth and would read as opening) — personal rest subtracted below
    const mar = d2(FACE_LM.upperInner, FACE_LM.lowerInner) / Math.max(1e-6, F.W);
    // MAR is PERSONAL (closed mouths read 0.02–0.11 depending on the lips):
    // open is measured against this face's own resting ratio
    if (this.marRest === undefined || this.marRest === null) this.marRest = mar;
    const openGeo = clamp((mar - this.marRest) / 0.22, 0, 1);
    const jawBs = bs(shapes, 'jawOpen');
    const openRaw = Math.max(openGeo, jawBs * 1.15);          // lip APERTURE (gap between the lips)
    // JAW DROP from chin travel (chin 152 below the nose tip 1, rigid frame, personal rest): a dropped jaw with
    // sealed lips (b / p / m) and parted lips over a shut jaw (ee) are different mouths — the lip gap alone
    // cannot tell them apart. ~0.12 face-widths of extra chin travel = fully open (research: FACS AU26/27).
    const chinTravel = cur.noseTip[1] - cur.chin[1];                 // +y is UP in the face frame → chin below the nose
    if (this.chinRest === undefined || this.chinRest === null) this.chinRest = chinTravel;
    const jawGeo = clamp((chinTravel - this.chinRest) / 0.12, 0, 1);
    const jawRaw = Math.max(jawGeo, (jawBs - 0.15) * 1.2, openGeo * 0.25);   // a wide lip gap implies some jaw even if the chin tracker under-reads
    const smileRaw = (bs(shapes, 'mouthSmileLeft') + bs(shapes, 'mouthSmileRight')) / 2;
    const calm = openRaw < 0.12 && smileRaw < 0.25 && bs(shapes, 'browInnerUp') < 0.3 && bs(shapes, 'mouthPucker') < 0.3;
    // ── neutral: fast capture over the first 1.2 s of a calm face, then slow drift while calm ──
    if (!this.neutral) {
      if (!this._nAcc) { this._nAcc = {}; for (const k of keys) this._nAcc[k] = [cur[k][0], cur[k][1]]; this._nT = 0; }
      else { const a = clamp(dt / 0.4, 0, 1); for (const k of keys) { this._nAcc[k][0] += (cur[k][0] - this._nAcc[k][0]) * a; this._nAcc[k][1] += (cur[k][1] - this._nAcc[k][1]) * a; } }
      this._nT += dt;
      this.marRest += (mar - this.marRest) * clamp(dt / 0.4, 0, 1);
      this.chinRest += (chinTravel - this.chinRest) * clamp(dt / 0.4, 0, 1);
      if (this._nT >= 1.2) { this.neutral = this._nAcc; this._nAcc = null; this.calibrated = true; this._lipParametrize(); }
    } else if (calm) {
      const a = clamp(dt / 25, 0, 1);
      this.marRest += (mar - this.marRest) * a;
      this.chinRest += (chinTravel - this.chinRest) * a;
      for (const k of keys) { this.neutral[k][0] += (cur[k][0] - this.neutral[k][0]) * a; this.neutral[k][1] += (cur[k][1] - this.neutral[k][1]) * a; }
    }
    const N = this.neutral || this._nAcc;
    // ── landmark deltas (face units; +x = subject's left, +y = up) ──
    for (const k of keys) {
      const dx = cur[k][0] - N[k][0], dy = cur[k][1] - N[k][1];
      this.delta[k] = { x: this._flt(k + 'x', dx, dt), y: this._flt(k + 'y', dy, dt) };
    }
    // ── blendshape channels ──
    const C = this.ch;
    C.open = this._flt('open', openRaw, dt, 3.0, 0.1);
    C.jaw = this._flt('jaw', jawRaw, dt, 3.0, 0.5);
    C.smile = this._flt('smile', smileRaw, dt);
    C.pucker = this._flt('pucker', bs(shapes, 'mouthPucker'), dt);
    C.funnel = this._flt('funnel', bs(shapes, 'mouthFunnel'), dt);
    C.puff = this._flt('puff', bs(shapes, 'cheekPuff'), dt);
    C.blinkL = this._flt('blinkL', bs(shapes, 'eyeBlinkLeft'), dt, 4, 0.2);
    C.blinkR = this._flt('blinkR', bs(shapes, 'eyeBlinkRight'), dt, 4, 0.2);
    C.wideL = this._flt('wideL', bs(shapes, 'eyeWideLeft'), dt);
    C.wideR = this._flt('wideR', bs(shapes, 'eyeWideRight'), dt);
    C.browInner = this._flt('browInner', bs(shapes, 'browInnerUp'), dt);
    C.surprise = this._flt('surprise', Math.max(bs(shapes, 'browInnerUp'), (bs(shapes, 'eyeWideLeft') + bs(shapes, 'eyeWideRight')) / 2), dt);
    C.anger = this._flt('anger', Math.max((bs(shapes, 'browDownLeft') + bs(shapes, 'browDownRight')) / 2, (bs(shapes, 'mouthFrownLeft') + bs(shapes, 'mouthFrownRight')) / 2, (bs(shapes, 'noseSneerLeft') + bs(shapes, 'noseSneerRight')) / 2), dt);
    // ── head pose ──
    let yaw, pitch, roll;
    if (matrix && matrix.length === 16) {
      // column-major camera-space transform: x right (= subject's left), y up, z toward the viewer
      const m = matrix; const r00 = m[0], r01 = m[4], r02 = m[8], r10 = m[1], r11 = m[5], r12 = m[9], r20 = m[2], r21 = m[6], r22 = m[10];
      yaw = Math.atan2(r02, r22) * R2D;                       // + = turned to the subject's left
      pitch = -Math.asin(clamp(-r12, -1, 1)) * R2D;           // + = nose up
      roll = -Math.atan2(r10, r11) * R2D;                     // + = tilt to the subject's left
      void r00; void r01; void r20; void r21;
    } else {                                                  // landmark geometry fallback:
      // the nose tip's displacement from the person's OWN neutral, in the
      // rigid cheek frame — zero at rest by construction, so no chin bias
      // (a chin-based pitch tilts the head whenever the jaw opens)
      const dn = this.delta.noseTip || { x: 0, y: 0 };
      yaw = dn.x * 240;                                       // nose toward the subject's left cheek → left turn
      pitch = dn.y * 240;                                     // nose rises toward the cheek line → looking up
      roll = Math.atan2(lm[FACE_LM.eyeOutL].y - lm[FACE_LM.eyeOutR].y, (lm[FACE_LM.eyeOutL].x - lm[FACE_LM.eyeOutR].x) * aspect) * R2D;
    }
    const H = this.c.head;
    this.headTarget.yaw = clamp(yaw, -H.yawMax, H.yawMax);
    this.headTarget.pitch = clamp(pitch, -H.pitchMax, H.pitchMax);
    this.headTarget.roll = clamp(roll, -H.rollMax, H.rollMax);
  }

  // human outer-lip contour by its NEUTRAL x: u = (x − centre) / half-width (subject's left = +)
  _lipParametrize() {
    const N = this.neutral; if (!N || !N.c61 || !N.c291) return;
    const cx = (N.c61[0] + N.c291[0]) / 2, hw = Math.max(1e-4, Math.abs(N.c291[0] - N.c61[0]) / 2);
    const side = arr => arr.map(i => ({ key: 'c' + i, u: clamp((N['c' + i][0] - cx) / hw, -1, 1) })).sort((a, b) => a.u - b.u);
    this.lipU = { upper: side(LIP_UPPER), lower: side(LIP_LOWER) };
  }
  // human contour delta at parameter u: [toward-the-corner, up] in face units
  _lipSample(u, upper) {
    if (!this.lipU) return [0, 0];
    const arr = upper ? this.lipU.upper : this.lipU.lower;
    const uh = this.mirror ? -u : u;
    let a = arr[0], b = arr[arr.length - 1];
    for (let i = 0; i < arr.length - 1; i++) if (uh >= arr[i].u && uh <= arr[i + 1].u) { a = arr[i]; b = arr[i + 1]; break; }
    const f = b.u > a.u ? clamp((uh - a.u) / (b.u - a.u), 0, 1) : 0;
    const da = this.delta[a.key] || { x: 0, y: 0 }, db = this.delta[b.key] || { x: 0, y: 0 };
    const dx = da.x + (db.x - da.x) * f, dy = da.y + (db.y - da.y) * f;
    const chin = this.delta.chin || { x: 0, y: 0 };
    const sgn = uh >= 0 ? 1 : -1;                                   // outward for THIS corner's side
    // the upper flews lift a little as the jaw opens so the opening reads from the front
    const lift = upper ? this.ch.open * 0.035 * (1 - Math.abs(uh)) : 0;
    return [dx * sgn, upper ? dy + lift : dy - chin.y];      // the jaw already carries the lower lip
  }

  _decay(dt) {                                  // no face: everything eases to rest
    const k = clamp(dt * 2.5, 0, 1);
    for (const key of Object.keys(this.ch)) this.ch[key] += (0 - this.ch[key]) * k;
    for (const d of Object.values(this.delta)) { d.x += (0 - d.x) * k; d.y += (0 - d.y) * k; }
    this.headTarget.yaw += (0 - this.headTarget.yaw) * k; this.headTarget.pitch += (0 - this.headTarget.pitch) * k; this.headTarget.roll += (0 - this.headTarget.roll) * k;
    // idle blink so a lost face never looks dead
    this._blinkT -= dt;
    if (this._blinkT <= 0) { this._blink = 1; this._blinkT = 2.5 + Math.random() * 3; }
    this._blink = Math.max(0, this._blink - dt * 6);
    this.ch.blinkL = Math.max(this.ch.blinkL, this._blink); this.ch.blinkR = Math.max(this.ch.blinkR, this._blink);
  }

  _pose(dt) {
    const j = this.c.joints, S = this.sign, G = this.c.gain, C = this.ch, D = this.delta, U = this.faceUnit;
    const m = this.mirror ? -1 : 1;             // mirror flips lateral deltas, yaw and roll
    const side = key => this.mirror ? (key.endsWith('L') ? key.slice(0, -1) + 'R' : key.slice(0, -1) + 'L') : key;
    const H = this.c.head, k = 1 - Math.exp(-H.damp * dt);
    this.head.yaw += (this.headTarget.yaw - this.head.yaw) * k;
    this.head.pitch += (this.headTarget.pitch - this.head.pitch) * k;
    this.head.roll += (this.headTarget.roll - this.head.roll) * k;
    this._reset();
    // ── head + neck ──
    const yaw = m * this.head.yaw, pitch = this.head.pitch, roll = m * this.head.roll;
    const ns = H.neckShare, neck = j.neck;
    this._rot(j.head, 'y', S.headLeft * yaw * (1 - ns)); this._rot(j.head, 'x', S.headUp * pitch * (1 - ns)); this._rot(j.head, 'z', S.headRollL * roll * (1 - ns));
    for (let i = 0; i < neck.length; i++) { const w = ns / neck.length; this._rot(neck[i], 'y', S.headLeft * yaw * w); this._rot(neck[i], 'x', S.headUp * pitch * w); this._rot(neck[i], 'z', S.headRollL * roll * w); }
    // ── jaw hinge ──
    // the auto-rig's jaw root sits at the head centre; a real jaw hinges at the
    // back of the mandible, level with the mouth — so the chin DROPS instead of
    // thrusting forward
    this._rotAbout(j.jaw, 'x', S.jawOpen * C.open * this.c.jawMaxDeg, this.jawHinge);
    // ── LIP ALIGNMENT: human landmark deltas → same-role fox bones ──
    const dl = key => D[key] || { x: 0, y: 0 };
    const up = dl('upperOuter'), lo = dl('lowerOuter'), chin = dl('chin');
    // a little nose lift on a snarl (upper lip raised)
    this._rot(j.snout, 'x', S.snoutUp * clamp(up.y * U * 60, -6, 10));
    const pout = clamp(C.pucker * 0.9 + C.funnel * 0.6, 0, 1);
    if (this.seam) {
      // LIP EDGE ALIGNMENT: the human outer-lip contour drives the fox lip edge
      // along the fox's OWN mouth line (toward its corners = back along the
      // muzzle); pucker pouts the tip out along the normal
      this.seam.apply((uu, upper) => this._lipSample(uu, upper), U * G.corner, pout, U * G.protrude * 1.6);
    } else {
      // no mesh bound (bones-only): coarse bone fallback along the muzzle
      this._move(j.snoutTip, 0, up.y * U * G.lipUpper, pout * U * G.protrude);
      this._move(j.lipLower, 0, (lo.y - chin.y) * U * G.lipLower, pout * U * G.protrude);
      for (const [hk, fk] of [['cornerL', 'cornerL'], ['cornerR', 'cornerR']]) {
        const d = dl(hk), fb = j[side(fk)], out = d.x * (hk === 'cornerL' ? 1 : -1);   // outward along the human mouth line
        this._move(fb, 0, d.y * U * G.corner, -out * U * G.corner);                    // → backward along the fox's
      }
    }
    void lo; void chin;
    // cheeks: landmark lift + puff
    for (const [hk, fk] of [['cheekL', 'cheekL'], ['cheekR', 'cheekR']]) {
      const d = dl(hk), fb = j[side(fk)];
      this._move(fb, m * d.x * U * G.cheek, d.y * U * G.cheek + C.smile * 0.03 * U, 0);
      this._scale(fb, 1 + C.puff * 0.28, 1 + C.puff * 0.12, 1 + C.puff * 0.28);
    }
    // brows + eyes: landmark lift; blink / wide squash the eye region
    for (const [hk, fk, bl, wd] of [['browL', 'browL', 'blinkL', 'wideL'], ['browR', 'browR', 'blinkR', 'wideR']]) {
      const d = dl(hk), fb = j[side(fk)];
      const blink = C[bl], wide = C[wd];          // human-side channels; fb is already the mirrored bone
      this._move(fb, m * d.x * U * G.brow * 0.5, d.y * U * G.brow, 0);
      this._scale(fb, 1 + wide * 0.08, 1 - blink * 0.55 + wide * 0.18, 1);
    }
    this._move(j.forehead, 0, C.browInner * 0.03 * U, 0);
    // ── reactions: ears, jowls, breathing ──
    const R = this.c.reactions;
    const perk = C.surprise * R.earPerk - C.anger * R.earFlat - C.open * 4;
    this._earYaw += (yaw - this._earYaw) * (1 - Math.exp(-dt / Math.max(0.05, R.earLag)));
    const earLag = clamp(yaw - this._earYaw, -25, 25) * 0.6;
    this._rot(j.earL, 'x', S.earLPerk * perk); this._rot(j.earR, 'x', S.earRPerk * perk);
    this._rot(j.earL, 'y', S.earLYaw * -earLag); this._rot(j.earR, 'y', S.earRYaw * -earLag);
    this._move(j.jowlL, 0, -C.open * 0.02 * U, 0); this._move(j.jowlR, 0, -C.open * 0.02 * U, 0);
    const br = 1 + Math.sin(this.t * 1.1) * R.breathe;
    this._scale(j.chest, br, 1, br);
    this._commit();
  }
}
