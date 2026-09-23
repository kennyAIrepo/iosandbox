/**
 * hopeOS SDK — ARP Face Driver (human face → Auto-Rig-Pro-style facial deform rig)
 * ═══════════════════════════════════════════════════════════════════════
 * Drives a creature whose face was authored by tools/facerig (headless
 * Blender): named deform bones at Auto-Rig-Pro facial-marker positions —
 *
 *   jaw.x (pivot → chin) ← lips_bot.x, lips_bot_01..03.l/r, chin_01.x, teeth_bot.x, tongue_01/02.x
 *   head  ← lips_top.x, lips_top_01..03.l/r, lips_smile.l/r (commissures), nose_01..03.x, nose_tip.x,
 *           nostril.l/r, cheek_smile.l/r, cheek_inflate.l/r, eyebrow_01..04.l/r, eyelid_top/bot_01..03.l/r,
 *           eyelid_corner_01/02.l/r, eye.l/r, ear_01/02.l/r, teeth_top.x
 *
 * MAPPING (research: ARP lips ring + Rigify jaw/lip blend, MediaPipe outer-lip contour):
 *   RING → RING   the fox lip ring is parametrized u ∈ [−1, 1] (right commissure → nose tip →
 *                 left commissure) exactly like the human 20-point outer-lip contour; every fox
 *                 lip bone samples the human delta at its u and moves ALONG THE FOX'S OWN MOUTH
 *                 LINE (toward its commissure = back along the muzzle), up/down, and out (pout).
 *   CLOSED AT NEUTRAL  the Meshy fox is modelled with its mouth ajar; at the user's neutral the
 *                 rig CLOSES it (jaw closes half the tip gap, the lower ring lifts the rest,
 *                 the upper ring drops a little) so bilabials (m / b / p) read as a shut mouth.
 *   JAW           a hinge at the authored pivot: open × jawMaxDeg (sign measured at bind).
 *   COMMISSURES   head children that follow the jaw's OPENING by half (Rigify / ARP "lips
 *                 elasticity"), plus the human corner delta (smile: back + up).
 *   EYES          blink / wide close the lid rings toward each other; gaze from the eyeLook*
 *                 blendshapes rotates the eye bones (the painted eyes follow).
 *   BROWS         four bones per brow follow four human brow landmarks (inner → outer).
 *   CHEEKS / NOSE / EARS / HEAD as in FaceRigDriver (deltas, blendshapes, matrix, reactions).
 *
 * Signs are measured at bind through child bones (dragon-driver doctrine). Mirror default on.
 */

import * as THREE from 'three';
import { FaceRigDriver, FACE_LM } from './face-rig-driver.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const bs = (arr, name) => { if (!arr) return 0; const c = arr.find(b => b.categoryName === name); return c ? c.score : 0; };

// MediaPipe brow landmarks, inner → outer, subject's right / left
const BROW_R = [107, 66, 105, 63], BROW_L = [336, 296, 334, 293];

export const FOX_ARP = {
  name: 'fox-arp-face',
  // three.js frame after GLTFLoader: +z = face forward, +y up, +x = the fox's anatomical LEFT
  joints: {
    head: 'head', neck: ['neck'], jaw: 'jaw.x', chin: 'chin_01.x', noseTip: 'nose_tip.x',
    nose: ['nose_01.x', 'nose_02.x', 'nose_03.x'], nostrilL: 'nostril.l', nostrilR: 'nostril.r',
    // lip rings: [bone, u]  (u: −1 right commissure … 0 tip … +1 left commissure)
    lipsTop: [['lips_smile.r', -1], ['lips_top_03.r', -0.85], ['lips_top_02.r', -0.6], ['lips_top_01.r', -0.3], ['lips_top.x', 0],
              ['lips_top_01.l', 0.3], ['lips_top_02.l', 0.6], ['lips_top_03.l', 0.85], ['lips_smile.l', 1]],
    lipsBot: [['lips_smile.r', -1], ['lips_bot_03.r', -0.85], ['lips_bot_02.r', -0.6], ['lips_bot_01.r', -0.3], ['lips_bot.x', 0],
              ['lips_bot_01.l', 0.3], ['lips_bot_02.l', 0.6], ['lips_bot_03.l', 0.85], ['lips_smile.l', 1]],
    cornerL: 'lips_smile.l', cornerR: 'lips_smile.r',
    cheekL: 'cheek_smile.l', cheekR: 'cheek_smile.r', puffL: 'cheek_inflate.l', puffR: 'cheek_inflate.r',
    browL: ['eyebrow_01.l', 'eyebrow_02.l', 'eyebrow_03.l', 'eyebrow_04.l'], browR: ['eyebrow_01.r', 'eyebrow_02.r', 'eyebrow_03.r', 'eyebrow_04.r'],
    lidTopL: ['eyelid_top_01.l', 'eyelid_top_02.l', 'eyelid_top_03.l'], lidBotL: ['eyelid_bot_01.l', 'eyelid_bot_02.l', 'eyelid_bot_03.l'],
    lidTopR: ['eyelid_top_01.r', 'eyelid_top_02.r', 'eyelid_top_03.r'], lidBotR: ['eyelid_bot_01.r', 'eyelid_bot_02.r', 'eyelid_bot_03.r'],
    eyeL: 'eye.l', eyeR: 'eye.r',
    earL: 'ear_01.l', earLTip: 'ear_02.l', earR: 'ear_01.r', earRTip: 'ear_02.r',
  },
  optional: ['tongue_01.x', 'tongue_02.x', 'teeth_top.x', 'teeth_bot.x', 'chin_02.x', 'eyelid_corner_01.l', 'eyelid_corner_02.l', 'eyelid_corner_01.r', 'eyelid_corner_02.r'],
  eyeSpanFaceUnits: 0.42,       // human eye-centre distance ≈ 0.42 of the cheek-to-cheek width → the fox's face unit
  jawMaxDeg: 17,
  close: { jawShare: 0.5, lowerShare: 0.2, upperShare: 0.3, gap: 0.0035 },   // how the rest gap is shut at neutral (sums to 1); gap = the modelled
                                                                            // slot between the lips (the rebuilt head is cut with a 3.5 mm slit; markers sit 14 mm apart)
  cornerJawShare: 0.5,
  head: { yawMax: 40, pitchMax: 25, rollMax: 20, damp: 9, neckShare: 0.35 },
  gain: { lip: 1.3, corner: 1.5, cheek: 1.0, brow: 1.2, protrude: 0.05, pout: 0.035, snarl: 0.02 },
  lids: { topShare: 0.85, botShare: 0.25, wideLift: 0.2 },
  eyeLookDeg: 16,
  reactions: { earPerk: 20, earFlat: 28, earLag: 0.5, tongueOut: 0.0 },
};

// three.js GLTFLoader sanitizes node names (PropertyBinding: spaces → '_', and [ ] . : / are DROPPED), so the
// authored 'jaw.x' / 'lips_smile.l' arrive as 'jawx' / 'lips_smilel' in the browser while node-side parsers
// keep the raw glTF names. The contract keeps the readable ARP names; both spellings resolve.
export const sanitizeBoneName = n => n.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
export function arpContractMatches(scene, contract = FOX_ARP) {
  const names = new Set(); scene.traverse(o => { if (o.isBone) { names.add(o.name); names.add(sanitizeBoneName(o.name)); } });
  const need = new Set();
  for (const v of Object.values(contract.joints)) {
    if (typeof v === 'string') need.add(v);
    else for (const e of v) need.add(Array.isArray(e) ? e[0] : e);
  }
  const missing = [...need].filter(n => !names.has(n) && !names.has(sanitizeBoneName(n)));
  return { ok: missing.length === 0, missing, bones: names.size };
}

export class ArpFaceDriver extends FaceRigDriver {
  constructor(contract = FOX_ARP, opts = {}) {
    super(contract, opts);
    for (const i of [...BROW_R, ...BROW_L]) if (!this.keys.includes('c' + i)) this.keys.push('c' + i);
    this.ring = null;                // bind-time lip ring geometry
  }

  bind(scene) {
    this.root = scene;
    scene.traverse(o => { if (o.isBone) { this.bones[o.name] = o; this.rest[o.name] = { q: o.quaternion.clone(), p: o.position.clone(), s: o.scale.clone() }; } });
    // alias every contract name onto its sanitized twin so 'jaw.x' works in the browser too
    for (const v of Object.values(this.c.joints)) for (const e of (typeof v === 'string' ? [v] : v)) {
      const n = Array.isArray(e) ? e[0] : e, sn = sanitizeBoneName(n);
      if (!this.bones[n] && this.bones[sn]) { this.bones[n] = this.bones[sn]; this.rest[n] = this.rest[sn]; }
    }
    for (const n of this.c.optional || []) { const sn = sanitizeBoneName(n); if (!this.bones[n] && this.bones[sn]) { this.bones[n] = this.bones[sn]; this.rest[n] = this.rest[sn]; } }
    const chk = arpContractMatches(scene, this.c);
    if (!chk.ok) throw new Error('arp-face contract mismatch — missing ' + chk.missing.join(','));
    this._captureAxes();
    this._calibrateSigns();
    const j = this.c.joints;
    this.faceUnit = Math.max(1e-3, this.modelPos(j.eyeL).distanceTo(this.modelPos(j.eyeR, this._v2)) / this.c.eyeSpanFaceUnits);
    this.jawPivot = this.modelPos(j.jaw).clone();
    this._buildRing();
    this._addMouthLight();
    return this;
  }

  bindMesh() { return null; }        // authored weights: no runtime lip seam needed

  _calibrateSigns() {
    const j = this.c.joints, S = this.sign;
    S.jawOpen = -this._probe(j.jaw, 'x', 10, j.chin, 'y');              // + → chin DOWN
    S.headLeft = this._probe(j.head, 'y', 10, j.noseTip, 'x');          // + → nose to +x (its left)
    S.headUp = this._probe(j.head, 'x', 10, j.noseTip, 'y');            // + → nose up
    S.headRollL = -this._probe(j.head, 'z', 10, j.earLTip, 'y');        // + → left ear DOWN
    S.earLPerk = this._probe(j.earL, 'x', 10, j.earLTip, 'z');          // + → ear tip forward
    S.earRPerk = this._probe(j.earR, 'x', 10, j.earRTip, 'z');
    S.earLYaw = this._probe(j.earL, 'y', 10, j.earLTip, 'x');
    S.earRYaw = this._probe(j.earR, 'y', 10, j.earRTip, 'x');
    this.root.updateWorldMatrix(true, true);
  }

  // per lip bone: rest position, tangent toward its commissure (horizontal), outward radial, gap to its partner
  _buildRing() {
    const j = this.c.joints, piv = this.jawPivot;
    const pos = n => this.modelPos(n).clone();
    const mk = (list, upper) => list.map(([name, u]) => {
      const p = pos(name);
      const cornerP = pos(u >= 0 ? j.cornerL : j.cornerR);
      let t;
      if (Math.abs(u) === 1) { const prev = list.find(e => Math.abs(e[1] - u * 0.85) < 1e-6); t = p.clone().sub(pos(prev[0])); }
      else t = cornerP.clone().sub(p);
      t.y = 0; if (t.lengthSq() < 1e-10) t.set(u >= 0 ? 1 : -1, 0, 0); t.normalize();
      const n = p.clone().sub(piv); n.y = 0; n.normalize();
      return { name, u, upper, p, t, n, gap: 0, corner: Math.abs(u) === 1 };
    });
    const top = mk(j.lipsTop, true), bot = mk(j.lipsBot, false);
    const tipBot = bot.find(e => e.u === 0), tipTop = top.find(e => e.u === 0);
    const gapTip = this.c.close.gap !== undefined ? this.c.close.gap : Math.max(0, tipTop.p.y - tipBot.p.y);
    // closing gap per bone: the measured top/bottom marker distance capped by a WEDGE prior (the mouth opening
    // is widest at the tip and shut at the commissures) — a front-view marker pair can straddle the whole cavity
    // height plus the chin crease, and lifting a lower-ring bone by that would fold the cheek fur
    for (const b of bot) { const partner = top.find(e => Math.abs(e.u - b.u) < 1e-6); const meas = partner ? Math.max(0, partner.p.y - b.p.y) : 0; b.gap = Math.min(meas, gapTip * Math.pow(1 - Math.abs(b.u), 1.5)); }
    for (const t of top) { const partner = bot.find(e => Math.abs(e.u - t.u) < 1e-6); t.gap = partner ? partner.gap : 0; }
    this.ring = { top, bot, gapTip };
    // closing the jaw's share of the tip gap: the angle that lifts the lower tip by that much about the pivot
    const r = Math.hypot(tipBot.p.z - piv.z, tipBot.p.y - piv.y) || 1e-3;
    this.closeDeg = Math.asin(clamp(this.c.close.jawShare * this.ring.gapTip / r, 0, 0.99)) / D2R;
    // lid gaps per eye ring index
    this.lidGap = {};
    for (const s of ['L', 'R']) {
      const T = j['lidTop' + s], B = j['lidBot' + s];
      this.lidGap[s] = T.map((n, k) => Math.max(0.004, pos(n).y - pos(B[k]).y));
    }
  }

  _addMouthLight() {
    const j = this.c.joints, U = this.faceUnit;
    const tip = this.modelPos(j.noseTip).clone(), piv = this.jawPivot;
    const light = new THREE.PointLight(0xffd2b0, 0.35, 0.12, 2); light.name = 'mouthLight';   // inside the mouth only (no shadows: a bigger radius floods the face)
    const head = this.bones[j.head]; head.add(light);
    const p = new THREE.Vector3(tip.x, tip.y - 0.12 * U, piv.z + (tip.z - piv.z) * 0.6);
    this.root.updateWorldMatrix(true, true);
    light.position.copy(head.worldToLocal(this.root.localToWorld(p)));
    this.mouthLight = light;
  }

  // displacement of a rest point p when the jaw rotates by deg about the pivot (model frame, about +x with the measured sign)
  _jawDisp(p, deg, out) {
    const q = this._q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.sign.jawOpen * deg * D2R);
    return out.copy(p).sub(this.jawPivot).applyQuaternion(q).add(this.jawPivot).sub(p);
  }

  _pose(dt) {
    const j = this.c.joints, S = this.sign, G = this.c.gain, C = this.ch, D = this.delta, U = this.faceUnit;
    const m = this.mirror ? -1 : 1;
    const side = key => this.mirror ? (key.endsWith('L') ? key.slice(0, -1) + 'R' : key.slice(0, -1) + 'L') : key;
    const H = this.c.head, k = 1 - Math.exp(-H.damp * dt);
    this.head.yaw += (this.headTarget.yaw - this.head.yaw) * k;
    this.head.pitch += (this.headTarget.pitch - this.head.pitch) * k;
    this.head.roll += (this.headTarget.roll - this.head.roll) * k;
    this._reset();
    const dl = key => D[key] || { x: 0, y: 0 };
    // ── head + neck ──
    const yaw = m * this.head.yaw, pitch = this.head.pitch, roll = m * this.head.roll;
    const ns = H.neckShare, neck = j.neck;
    this._rot(j.head, 'y', S.headLeft * yaw * (1 - ns)); this._rot(j.head, 'x', S.headUp * pitch * (1 - ns)); this._rot(j.head, 'z', S.headRollL * roll * (1 - ns));
    for (let i = 0; i < neck.length; i++) { const w = ns / neck.length; this._rot(neck[i], 'y', S.headLeft * yaw * w); this._rot(neck[i], 'x', S.headUp * pitch * w); this._rot(neck[i], 'z', S.headRollL * roll * w); }
    // ── jaw: closes the rest gap at neutral, opens with the user ──
    // two channels: JAW (chin travel) hinges the mandible, APERTURE (lip gap) seals / parts the lips
    const open = clamp(C.open, 0, 1), jaw = clamp(C.jaw, 0, 1), presence = this.presence;
    const thOpen = jaw * this.c.jawMaxDeg, thClose = (1 - jaw) * this.closeDeg * presence;
    this._rot(j.jaw, 'x', S.jawOpen * (thOpen - thClose));
    // ── lip rings ──
    const R = this.ring, pout = clamp(C.pucker * 0.9 + C.funnel * 0.6, 0, 1), chin = dl('chin');
    const closeL = this.c.close, v = this._v, v2 = this._v2;
    const drive = (e) => {
      if (e.corner) return;                                            // commissures below
      const [along, up] = this._lipSample(e.u, e.upper);              // human delta at u (face units)
      let dx = e.t.x * along * U * G.lip, dy = (e.upper ? up : up - chin.y) * U * G.lip, dz = e.t.z * along * U * G.lip;
      const po = pout * U * G.protrude * (1 - Math.abs(e.u)) * (1 - Math.abs(e.u));
      dx += e.n.x * po; dz += e.n.z * po;
      // closing at neutral: the upper ring drops upperShare of its gap, the lower ring lifts what the jaw did not
      // SEAL: with the lips together the rings meet — the lower ring lifts what the jaw's closing share did
      // not cover (plus a sticky-lips reach when the jaw hangs while the lips stay sealed), the upper ring drops a little
      const shut = (1 - open) * presence;
      if (e.upper) dy -= shut * e.gap * closeL.upperShare;
      else { const jd = this._jawDisp(e.p, -thClose, v); dy += shut * (e.gap * (closeL.jawShare + closeL.lowerShare) + jaw * e.gap * 0.6) - jd.y; }
      this._move(e.name, dx, dy, dz);
    };
    for (const e of R.top) drive(e);
    for (const e of R.bot) drive(e);
    // commissures: half of the jaw's OPENING + the human corner delta (toward the corner = back along the muzzle, up)
    for (const e of R.top) {
      if (!e.corner) continue;
      const jd = this._jawDisp(e.p, Math.max(0, thOpen), v).multiplyScalar(this.c.cornerJawShare);
      const [along, up] = this._lipSample(e.u, true);
      const back = along * U * G.corner - pout * U * G.pout;           // pucker pulls the corners toward the tip
      // the human corner delta already contains the jaw-driven drop: keep only the half the jaw share did not cover
      const upC = up - chin.y * this.c.cornerJawShare;
      this._move(e.name, jd.x + e.t.x * back, jd.y + upC * U * G.corner, jd.z + e.t.z * back);
    }
    // ── nose: sneer lifts the nose bones, nostrils flare ──
    const sneer = clamp(Math.max(bs(this._shapes, 'noseSneerLeft'), bs(this._shapes, 'noseSneerRight')) + Math.max(0, dl('upperOuter').y) * 4, 0, 1);
    this._move(j.nose[2], 0, sneer * U * G.snarl, 0); this._move(j.noseTip, 0, sneer * U * G.snarl * 0.6, 0);
    this._move(j.nostrilL, sneer * U * 0.01, 0, 0); this._move(j.nostrilR, -sneer * U * 0.01, 0, 0);
    // ── cheeks ──
    for (const [hk, fk, pk] of [['cheekL', 'cheekL', 'puffL'], ['cheekR', 'cheekR', 'puffR']]) {
      const d = dl(hk), fb = j[side(fk)], pb = j[side(pk)];
      this._move(fb, m * d.x * U * G.cheek * 0.5, d.y * U * G.cheek + C.smile * 0.03 * U, C.smile * 0.01 * U);
      this._scale(pb, 1 + C.puff * 0.3, 1 + C.puff * 0.15, 1 + C.puff * 0.3);
      const out = fk === 'cheekL' ? 1 : -1;                            // fk is already the fox side
      this._move(pb, (side(fk) === 'cheekL' ? 1 : -1) * C.puff * 0.02 * U, 0, C.puff * 0.01 * U); void out;
    }
    // ── brows: four landmarks → four bones (inner → outer) ──
    const browUp = C.browInner, browDn = (bs(this._shapes, 'browDownLeft') + bs(this._shapes, 'browDownRight')) / 2;
    for (const [hlist, fk] of [[BROW_L, 'browL'], [BROW_R, 'browR']]) {
      const bones = j[side(fk)];
      hlist.forEach((li, i) => {
        const d = dl('c' + li);
        const inner = 1 - i / 3;
        this._move(bones[i], m * d.x * U * G.brow * 0.4, d.y * U * G.brow + (browUp * 0.012 - browDn * 0.01) * inner * U, 0);
      });
    }
    // ── eyelids: blink closes the ring, wide lifts the top lid ──
    for (const [bl, wd, fs] of [['blinkL', 'wideL', 'L'], ['blinkR', 'wideR', 'R']]) {
      const s = side('x' + fs).slice(-1);                              // fox side for this human eye
      const blink = C[bl], wide = C[wd], gaps = this.lidGap[s], L = this.c.lids;
      j['lidTop' + s].forEach((n, i) => this._move(n, 0, -blink * gaps[i] * L.topShare + wide * gaps[i] * L.wideLift, 0));
      j['lidBot' + s].forEach((n, i) => this._move(n, 0, blink * gaps[i] * L.botShare, 0));
    }
    // ── gaze: eyeLook* blendshapes rotate the eye bones (about the eye centre) ──
    const sh = this._shapes;
    const gYaw = ((bs(sh, 'eyeLookOutLeft') - bs(sh, 'eyeLookInLeft')) + (bs(sh, 'eyeLookInRight') - bs(sh, 'eyeLookOutRight'))) / 2;   // + = toward the subject's left
    const gPitch = ((bs(sh, 'eyeLookUpLeft') + bs(sh, 'eyeLookUpRight')) - (bs(sh, 'eyeLookDownLeft') + bs(sh, 'eyeLookDownRight'))) / 2;
    const ey = this._flt('gazeYaw', gYaw, dt, 2.0, 0.05), ep = this._flt('gazePitch', gPitch, dt, 2.0, 0.05);
    for (const n of [j.eyeL, j.eyeR]) { this._rot(n, 'y', m * ey * this.c.eyeLookDeg); this._rot(n, 'x', -ep * this.c.eyeLookDeg * 0.7); }
    // ── ears: reactions + lag ──
    const Rx = this.c.reactions;
    const perk = C.surprise * Rx.earPerk - C.anger * Rx.earFlat - open * 4;
    this._earYaw += (yaw - this._earYaw) * (1 - Math.exp(-dt / Math.max(0.05, Rx.earLag)));
    const earLag = clamp(yaw - this._earYaw, -25, 25) * 0.6;
    this._rot(j.earL, 'x', S.earLPerk * perk); this._rot(j.earR, 'x', S.earRPerk * perk);
    this._rot(j.earL, 'y', S.earLYaw * -earLag); this._rot(j.earR, 'y', S.earRYaw * -earLag);
    this._commit();
  }

  // keep the last blendshape list for channels the base class does not smooth
  _read(lm, shapes, matrix, aspect, dt) { this._shapes = shapes; super._read(lm, shapes, matrix, aspect, dt); }
  _decay(dt) { this._shapes = null; super._decay(dt); }
}
