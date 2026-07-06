/**
 * hopeOS SDK — Holo Body Rig
 * ═══════════════════════════════════════════════════════════════
 * Full-body deformation driven directly by MediaPipe pose landmarks —
 * the HoloHandRig recipe scaled to 19 bones / 37 joints:
 *
 *   • Bone frames are BUILT FROM the live landmarks (per-bone stretch
 *     along the bone, uniform body scale across) → joints land EXACTLY
 *     on the tracked points, misalignment ≈ 0 by construction.
 *   • Rotations proper (det > 0): the mesh can never mirror-twist.
 *     Roll is stabilized by the TORSO FORWARD normal (hips×shoulders,
 *     sign-locked toward the nose so the face always faces front),
 *     with per-bone temporal fallback when a limb points along it.
 *   • Ghost shader shared with the hands (one material family — the
 *     body IS the same holo substrate; zeroed aDetail attribute).
 *
 * Also here: BodyPose — the view adapter for the body:
 *   • mirror(pts): image landmarks already ray-projected by the caller
 *     (HandViews.mirrorPoint) — passthrough convenience.
 *   • retarget(world, img): PREDICTIVE avatar reconstruction from
 *     MediaPipe pose worldLandmarks (true metric 3D) — FK with the
 *     rig's OWN rest bone lengths + live bone directions (kalidokit's
 *     insight, minus the fragile Euler decomposition), rotated 180°
 *     about vertical so you see the avatar's BACK (Kinect Sports
 *     framing), anchored at a spawn point with feet on the floor,
 *     lateral steer from the image hips, crouch from live leg span,
 *     z-convention self-calibrated (nose must face away) and latched
 *     with decay. Elbow/knee anatomical clamps bound tracker garbage.
 */

import * as THREE from 'three';
import { makeGhostMaterial } from './hand-rig.js';
import { forgeBody, extendPose, REST_BODY, BODY_BONES, BODY_RADII, HIP_MID, CHEST, HEAD_C, HEAD_TOP } from './body-forge.js';

const _v = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _x = new THREE.Vector3();
const _n = new THREE.Vector3(), _m = new THREE.Matrix4();

export { REST_BODY, BODY_BONES, BODY_RADII, HIP_MID, CHEST, HEAD_C, HEAD_TOP };

export class HoloBodyRig {
  constructor(scene, opts = {}) {
    this.rest = REST_BODY.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    this.opts = opts;
    this.grp = new THREE.Group();
    this.grp.visible = false;
    if (scene) scene.add(this.grp);

    this.uniforms = {
      uTime: { value: 0 },
      uGlow: { value: 0 },
      uAlpha: { value: opts.alpha ?? 0.42 },
      uBody: { value: new THREE.Color(opts.body ?? 0x6fb0dc) },
      uRim: { value: new THREE.Color(opts.rim ?? 0xaeeaff) },
    };

    // Rest bone data (same construction as the hand rig)
    const nb = BODY_BONES.length;
    this._restInv = [];
    this._prevZ = [];
    this._restShoulder = this.rest[11].distanceTo(this.rest[12]);
    this._restTrunk = this.rest[HIP_MID].distanceTo(this.rest[CHEST]);
    this._restHips = this.rest[23].distanceTo(this.rest[24]);
    this._sEma = 0;
    const zRef = this._forward(this.rest, new THREE.Vector3());
    for (let b = 0; b < nb; b++) {
      const [i, j] = BODY_BONES[b];
      const m = new THREE.Matrix4();
      const zStore = new THREE.Vector3();
      this._boneBasis(this.rest[i], this.rest[j], zRef, 1, m, zStore);
      this._restInv.push(m.invert());
      this._prevZ.push(zStore);
    }
    this._skinFlat = new Float32Array(nb * 12);

    this.mesh = null;
    this.vc = 0;
    this._restPos = null;
    this._restNrm = null;
    this._skin = null;
    this.stats = null;
    // key anchor points for game logic (world, updated by pose())
    this.anchors = { chest: new THREE.Vector3(), hips: new THREE.Vector3(), head: new THREE.Vector3() };
  }

  /**
   * Torso forward normal — sign-locked toward the face so the mesh's
   * front (chest, face wedge) always tracks the person's front, in
   * BOTH data conventions (mirror overlay and retargeted avatar).
   */
  _forward(lm, out) {
    _y.set(lm[CHEST].x - lm[HIP_MID].x, lm[CHEST].y - lm[HIP_MID].y, lm[CHEST].z - lm[HIP_MID].z);   // up
    _v.set(lm[24].x - lm[23].x, lm[24].y - lm[23].y, lm[24].z - lm[23].z);                            // hip axis
    out.crossVectors(_v, _y).normalize();                                                             // a horizontal normal
    // orient toward the nose (the face side IS the front)
    _v.set(lm[0].x - lm[CHEST].x, lm[0].y - lm[CHEST].y, lm[0].z - lm[CHEST].z);
    if (out.dot(_v) < 0) out.multiplyScalar(-1);
    return out;
  }

  _boneBasis(a, b, zRef, scaleXZ, outM, zStore) {
    _y.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = _y.length();
    if (len < 1e-6) return false;
    _v.copy(_y).divideScalar(len);
    _z.copy(zRef).addScaledVector(_v, -zRef.dot(_v));
    if (_z.lengthSq() < 1e-4) {
      if (!zStore || zStore.lengthSq() < 0.5) return false;
      _z.copy(zStore).addScaledVector(_v, -zStore.dot(_v));
      if (_z.lengthSq() < 1e-6) return false;
    }
    _z.normalize();
    if (zStore) zStore.copy(_z);
    _x.crossVectors(_v, _z);
    outM.makeBasis(_x.multiplyScalar(scaleXZ), _y, _z.multiplyScalar(scaleXZ));
    outM.setPosition(a.x, a.y, a.z);
    return true;
  }

  /** Forge (or re-forge) the body mesh. style: 'standard' | 'lite'. */
  build(style) {
    if (this.mesh) {
      this.grp.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    const out = forgeBody({ style: style || this.opts.style || 'standard' });
    const geometry = out.geometry;
    this.stats = out.stats;
    this.vc = geometry.getAttribute('position').count;
    this._restPos = geometry.getAttribute('position').array.slice();
    this._restNrm = geometry.getAttribute('normal').array.slice();
    this._skin = out.skin;
    geometry.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    geometry.getAttribute('normal').setUsage(THREE.DynamicDrawUsage);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    // ghost shader expects aDetail (nail/crease/knuckle masks) — zero for the body
    geometry.setAttribute('aDetail', new THREE.BufferAttribute(new Float32Array(this.vc * 3), 3));

    this.mesh = new THREE.Mesh(geometry, makeGhostMaterial(this.uniforms));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;   // just under the hands
    this.grp.add(this.mesh);
    return this;
  }

  setGhost({ alpha, body, rim } = {}) {
    if (alpha !== undefined) this.uniforms.uAlpha.value = alpha;
    if (body !== undefined) this.uniforms.uBody.value.set(body);
    if (rim !== undefined) this.uniforms.uRim.value.set(rim);
  }

  /**
   * Pose the body to 33+ world-space points ({x,y,z} or Vector3 — the
   * 4 synthetic joints are computed here if missing). null → hide.
   */
  pose(lm) {
    if (!this.mesh || !lm) { this.grp.visible = false; return null; }
    extendPose(lm, () => new THREE.Vector3());
    const nb = BODY_BONES.length;

    const zRef = this._forward(lm, _n);
    if (!isFinite(zRef.x)) { this.grp.visible = false; return null; }

    // Orientation-robust body scale: max of three near-orthogonal cues.
    const s1 = Math.hypot(lm[12].x - lm[11].x, lm[12].y - lm[11].y, lm[12].z - lm[11].z) / this._restShoulder;
    const s2 = Math.hypot(lm[CHEST].x - lm[HIP_MID].x, lm[CHEST].y - lm[HIP_MID].y, lm[CHEST].z - lm[HIP_MID].z) / this._restTrunk;
    const s3 = Math.hypot(lm[24].x - lm[23].x, lm[24].y - lm[23].y, lm[24].z - lm[23].z) / this._restHips;
    const sRaw = Math.max(s1, s2, s3);
    this._sEma = this._sEma > 0 ? this._sEma + (sRaw - this._sEma) * 0.2 : sRaw;
    const sGlobal = Math.max(0.1, Math.min(8, this._sEma));

    const F = this._skinFlat;
    for (let b = 0; b < nb; b++) {
      const [i, j] = BODY_BONES[b];
      if (!this._boneBasis(lm[i], lm[j], zRef, sGlobal, _m, this._prevZ[b])) continue;
      _m.multiply(this._restInv[b]);
      const e = _m.elements, o = b * 12;
      F[o] = e[0]; F[o + 1] = e[4]; F[o + 2] = e[8]; F[o + 3] = e[12];
      F[o + 4] = e[1]; F[o + 5] = e[5]; F[o + 6] = e[9]; F[o + 7] = e[13];
      F[o + 8] = e[2]; F[o + 9] = e[6]; F[o + 10] = e[10]; F[o + 11] = e[14];
    }
    this.grp.visible = true;

    // LBS — identical inner loop to the hand rig
    const pos = this.mesh.geometry.getAttribute('position').array;
    const nrm = this.mesh.geometry.getAttribute('normal').array;
    const rp = this._restPos, rn = this._restNrm;
    const si = this._skin.index, sw = this._skin.weight;
    for (let v = 0; v < this.vc; v++) {
      const v3 = v * 3;
      const px = rp[v3], py = rp[v3 + 1], pz = rp[v3 + 2];
      const o0 = si[v3] * 12, w0 = sw[v3];
      const o1 = si[v3 + 1] * 12, w1 = sw[v3 + 1];
      const o2 = si[v3 + 2] * 12, w2 = sw[v3 + 2];
      let x = w0 * (F[o0] * px + F[o0 + 1] * py + F[o0 + 2] * pz + F[o0 + 3]);
      let y = w0 * (F[o0 + 4] * px + F[o0 + 5] * py + F[o0 + 6] * pz + F[o0 + 7]);
      let z = w0 * (F[o0 + 8] * px + F[o0 + 9] * py + F[o0 + 10] * pz + F[o0 + 11]);
      if (w1 > 0) {
        x += w1 * (F[o1] * px + F[o1 + 1] * py + F[o1 + 2] * pz + F[o1 + 3]);
        y += w1 * (F[o1 + 4] * px + F[o1 + 5] * py + F[o1 + 6] * pz + F[o1 + 7]);
        z += w1 * (F[o1 + 8] * px + F[o1 + 9] * py + F[o1 + 10] * pz + F[o1 + 11]);
      }
      if (w2 > 0) {
        x += w2 * (F[o2] * px + F[o2 + 1] * py + F[o2 + 2] * pz + F[o2 + 3]);
        y += w2 * (F[o2 + 4] * px + F[o2 + 5] * py + F[o2 + 6] * pz + F[o2 + 7]);
        z += w2 * (F[o2 + 8] * px + F[o2 + 9] * py + F[o2 + 10] * pz + F[o2 + 11]);
      }
      pos[v3] = x; pos[v3 + 1] = y; pos[v3 + 2] = z;
      const nx = rn[v3], ny = rn[v3 + 1], nz = rn[v3 + 2];
      let ox = w0 * (F[o0] * nx + F[o0 + 1] * ny + F[o0 + 2] * nz);
      let oy = w0 * (F[o0 + 4] * nx + F[o0 + 5] * ny + F[o0 + 6] * nz);
      let oz = w0 * (F[o0 + 8] * nx + F[o0 + 9] * ny + F[o0 + 10] * nz);
      if (w1 > 0) {
        ox += w1 * (F[o1] * nx + F[o1 + 1] * ny + F[o1 + 2] * nz);
        oy += w1 * (F[o1 + 4] * nx + F[o1 + 5] * ny + F[o1 + 6] * nz);
        oz += w1 * (F[o1 + 8] * nx + F[o1 + 9] * ny + F[o1 + 10] * nz);
      }
      if (w2 > 0) {
        ox += w2 * (F[o2] * nx + F[o2 + 1] * ny + F[o2 + 2] * nz);
        oy += w2 * (F[o2 + 4] * nx + F[o2 + 5] * ny + F[o2 + 6] * nz);
        oz += w2 * (F[o2 + 8] * nx + F[o2 + 9] * ny + F[o2 + 10] * nz);
      }
      const il = 1 / (Math.sqrt(ox * ox + oy * oy + oz * oz) + 1e-9);
      nrm[v3] = ox * il; nrm[v3 + 1] = oy * il; nrm[v3 + 2] = oz * il;
    }
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.getAttribute('normal').needsUpdate = true;

    this.anchors.chest.set(lm[CHEST].x, lm[CHEST].y, lm[CHEST].z);
    this.anchors.hips.set(lm[HIP_MID].x, lm[HIP_MID].y, lm[HIP_MID].z);
    this.anchors.head.set(lm[HEAD_C].x, lm[HEAD_C].y, lm[HEAD_C].z);
    return lm;
  }

  tick(elapsed) { this.uniforms.uTime.value = elapsed; }

  dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
    this.grp.removeFromParent();
  }
}

// ── BodyPose: world-landmark → avatar-space retarget ────────────
// Bones whose child direction is clamped against its parent bone
// (elbows/knees/neck can't bend past anatomy — occlusion garbage in
// the tracker must not fold an arm through the torso).
const CLAMP = {   // boneIdx → { parent: boneIdx, maxBend: rad }
  7: { parent: 5, maxBend: 2.62 },   // forearm L vs upper arm
  8: { parent: 6, maxBend: 2.62 },
  15: { parent: 13, maxBend: 2.44 }, // shin L vs thigh
  16: { parent: 14, maxBend: 2.44 },
  1: { parent: 0, maxBend: 0.9 },    // neck vs trunk
  2: { parent: 1, maxBend: 0.7 },    // head vs neck
};
const REST_LEN = BODY_BONES.map(([i, j]) => Math.hypot(
  REST_BODY[j][0] - REST_BODY[i][0], REST_BODY[j][1] - REST_BODY[i][1], REST_BODY[j][2] - REST_BODY[i][2]));
const REST_HIP_Y = REST_BODY[HIP_MID][1];

export class BodyPose {
  constructor(opts = {}) {
    this.cfg = {
      steer: opts.steer ?? 1.5,        // image-hip x → lateral metres across the stage
      steerClamp: opts.steerClamp ?? 0.85,
      ...opts,
    };
    this._out = [];
    for (let i = 0; i < 37; i++) this._out.push(new THREE.Vector3());
    this._w = [];                       // converted world points (37)
    for (let i = 0; i < 37; i++) this._w.push(new THREE.Vector3());
    this._zAcc = { sum: 0, zs: 1 };
    this._dir = new Float32Array(37 * 3);   // per-JOINT incoming bone dir (for clamps)
    this._hipYEma = REST_HIP_Y;
  }

  drop() { this._zAcc.sum = 0; this._zAcc.zs = 1; this._hipYEma = REST_HIP_Y; }

  /**
   * Rebuild the avatar-space pose from MediaPipe pose worldLandmarks.
   * @param {Array} world 33 raw worldLandmarks ({x,y,z}, metres, hip origin)
   * @param {Array} img   33 normalized image landmarks (mirrored) — steering
   * @param {THREE.Vector3} spawn avatar root position (feet ≈ this point)
   * @param {number} yaw avatar yaw around +Y (0 = faces −Z, back to camera)
   * @returns 37 Vector3 world points for HoloBodyRig.pose()
   */
  retarget(world, img, spawn, yaw = 0) {
    if (!world || world.length < 33) return null;
    // 1. convert to scene axes (y up), viewed FROM BEHIND: Ry(π) folded in
    //    ⇒ (x, y, z)world → (−x, −y, z·zs)scene, zs self-calibrated below.
    const zs = this._zSign(world);
    const W = this._w;
    for (let i = 0; i < 33; i++) {
      W[i].set(-world[i].x, -world[i].y, world[i].z * zs);
    }
    extendPose(W, () => new THREE.Vector3());

    // 2. FK: rest bone lengths + live directions, parent-first, with clamps
    const out = this._out;
    const D = this._dir;
    out[HIP_MID].set(0, 0, 0);
    for (let b = 0; b < BODY_BONES.length; b++) {
      const [i, j] = BODY_BONES[b];
      let dx = W[j].x - W[i].x, dy = W[j].y - W[i].y, dz = W[j].z - W[i].z;
      let len = Math.hypot(dx, dy, dz);
      if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
      else {
        dx = REST_BODY[j][0] - REST_BODY[i][0]; dy = REST_BODY[j][1] - REST_BODY[i][1]; dz = REST_BODY[j][2] - REST_BODY[i][2];
        len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
      }
      // anatomical clamp against the parent bone direction
      const cl = CLAMP[b];
      if (cl) {
        const pj = BODY_BONES[cl.parent][1] * 3;
        const px = D[pj], py = D[pj + 1], pz = D[pj + 2];
        const c = dx * px + dy * py + dz * pz;
        const cMax = Math.cos(cl.maxBend);
        if (c < cMax) {
          let ex = dx - px * c, ey = dy - py * c, ez = dz - pz * c;
          const el = Math.hypot(ex, ey, ez);
          if (el > 1e-6) {
            const sa = Math.sin(cl.maxBend);
            ex /= el; ey /= el; ez /= el;
            dx = px * cMax + ex * sa; dy = py * cMax + ey * sa; dz = pz * cMax + ez * sa;
          } else { dx = px; dy = py; dz = pz; }
        }
      }
      const j3 = j * 3;
      D[j3] = dx; D[j3 + 1] = dy; D[j3 + 2] = dz;
      const L = REST_LEN[b];
      out[j].set(out[i].x + dx * L, out[i].y + dy * L, out[i].z + dz * L);
    }

    // 3. ground the feet: hip height = −(lowest foot y), smoothed (crouch
    //    tracks through; single-frame foot glitches don't bounce the body)
    let minY = 0;
    for (const fi of [27, 28, 29, 30, 31, 32]) minY = Math.min(minY, out[fi].y);
    const hipY = Math.max(0.45, Math.min(1.08 * REST_HIP_Y, -minY + 0.02));
    this._hipYEma += (hipY - this._hipYEma) * 0.2;

    // 4. lateral steer from the mirrored image hips (step side → avatar steps)
    let steerX = 0;
    if (img && img[23] && img[24]) {
      const hx = (img[23].x + img[24].x) / 2;
      steerX = Math.max(-this.cfg.steerClamp, Math.min(this.cfg.steerClamp, (hx - 0.5) * this.cfg.steer));
    }

    // 5. place in the world: yaw, then spawn offset
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let i = 0; i < 37; i++) {
      const p = out[i];
      const x = p.x + steerX, yv = p.y + this._hipYEma, z = p.z;
      p.set(x * cy + z * sy + spawn.x, yv + spawn.y, -x * sy + z * cy + spawn.z);
    }
    return out;
  }

  /**
   * z-convention latch: after conversion the avatar must FACE −Z (we
   * see its back) ⇒ the nose sits at smaller z than the chest. Decay
   * accumulator — single noisy frames can't flip it.
   */
  _zSign(world) {
    const a = this._zAcc;
    // evidence with zs=+1: nose z minus shoulder-mid z (converted: z·1)
    const sz = (world[11].z + world[12].z) / 2;
    a.sum = a.sum * 0.98 + (world[0].z - sz);
    if (Math.abs(a.sum) > 1e-9) a.zs = a.sum < 0 ? 1 : -1;   // nose in front (smaller z) → keep
    return a.zs;
  }
}
