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
import { forgeHand } from './hand-forge.js';
import { REST_R42, REST_L42 } from './hands.js';
import { forgeBody, extendPose, REST_BODY, BODY_BONES, BODY_RADII, HIP_MID, CHEST, HEAD_C, HEAD_TOP } from './body-forge.js';

const _v = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _x = new THREE.Vector3();
const _n = new THREE.Vector3(), _m = new THREE.Matrix4();

export { REST_BODY, BODY_BONES, BODY_RADII, HIP_MID, CHEST, HEAD_C, HEAD_TOP };

// ── SHADOW silhouette shader — the Kinect read ──────────────────
// Dark smoky mass + electric aura at the contour (Fruit-Ninja-on-Kinect:
// the player is a translucent shadow with a glowing edge). The body is
// ONE closed mesh with depthWrite ON, so normal blending resolves to a
// single flat alpha layer — no capsule double-blend, no sorting artifacts
// (the standard fix for the "uniformly transparent multi-part body").
// The aura halo is an inverted hull: the same geometry re-drawn pushed
// out along its normals, BackSide + additive — order-independent glow
// with zero post-processing.
const SIL_VERT = /* glsl */`
varying vec3 vN, vV, vW;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;

const SIL_FRAG = /* glsl */`
uniform float uTime, uGlow, uAlpha;
uniform vec3 uCore, uAura;
varying vec3 vN, vV, vW;
void main() {
  vec3 N = normalize(vN), V = normalize(vV);
  float ndv = abs(dot(N, V));
  float rim  = pow(1.0 - ndv, 2.2);                    // colored aura band
  float edge = pow(1.0 - ndv, 6.0);                    // white-hot contour line
  // living smoke: two drifting world-anchored interference fields
  float smoke = sin(vW.y * 9.0 + uTime * 0.9) * sin(vW.x * 7.0 - uTime * 0.7)
              + sin((vW.y + vW.x) * 4.0 - uTime * 0.55);
  smoke *= 0.5;
  vec3 c = uCore * (0.55 + 0.30 * (1.0 - ndv) + smoke * 0.10);   // dark heart, denser center
  c += uAura * (rim * 0.95 + uGlow * 0.55);
  c += vec3(1.0) * edge * 0.80;
  // dark-glass alpha: face-on stays deep and smoky, the edge densifies
  float a = uAlpha * (1.45 + smoke * 0.12) + rim * 0.30 + edge * 0.25 + uGlow * 0.15;
  gl_FragColor = vec4(c, clamp(a, 0.12, 0.96));
}`;

const AURA_VERT = /* glsl */`
uniform float uWidth;
varying float vF;
void main() {
  vec3 p = position + normal * uWidth;                 // inverted hull
  vec3 n = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vF = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 1.6);
  gl_Position = projectionMatrix * mv;
}`;

const AURA_FRAG = /* glsl */`
uniform float uTime, uGlow;
uniform vec3 uAura;
varying float vF;
void main() {
  float pulse = 0.82 + 0.18 * sin(uTime * 2.3);
  gl_FragColor = vec4(uAura * (vF * (0.55 + uGlow * 0.5) * pulse), vF * 0.55);
}`;

export function makeSilhouetteMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: SIL_VERT,
    fragmentShader: SIL_FRAG,
    uniforms,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: true,        // single alpha layer + self-occlusion (flat shadow)
    side: THREE.FrontSide,
  });
}

export function makeAuraMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: AURA_VERT,
    fragmentShader: AURA_FRAG,
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,   // order-independent halo
    depthWrite: false,
    side: THREE.BackSide,               // far shell = glow AROUND the contour
  });
}

// ── Body hands: REAL forged hand meshes at the body wrists ─────
// Individual fingers are ~1 voxel at the body forge's grid resolution
// (they'd shred — hand-forge lesson: nothing under ~3 voxels), so the
// body SDF ends in wrist stubs and the hands come from the hand forge
// itself — its own grid at hand scale — rigidly frame-mapped onto the
// live hand-paddle bone (wrist / pinky-MCP / index-MCP) and scaled to
// the body's proportions. Forged once per page, shared by every rig.
const BODY_HAND_STYLE = { res: 64, radius: 1.05, blend: 1.1, taubin: 4 };
let _handGeo = null;
function bodyHandGeometries() {
  if (!_handGeo) {
    _handGeo = {
      right: forgeHand({ rest: REST_R42, style: BODY_HAND_STYLE }).geometry,
      left: forgeHand({ rest: REST_L42, style: BODY_HAND_STYLE }).geometry,
    };
  }
  return _handGeo;
}

/** Paddle frame of a hand REST pack (wrist l0, index-MCP l5, pinky-MCP
 *  l17): y along wrist→MCP-mid, x along pinky→index, z = x×y. The SAME
 *  frame built from the live body landmarks maps the mesh into place —
 *  chirality comes out right because each side uses its own rest pack
 *  (REST_BODY and the packs share the mirror-space convention). */
function handRestFrame(pack) {
  const P = (i) => new THREE.Vector3(pack[i][0], pack[i][1], pack[i][2]);
  const w = P(0);
  const mid = P(5).add(P(17)).multiplyScalar(0.5);
  const y = mid.clone().sub(w);
  const span = y.length();
  y.normalize();
  const x = P(5).sub(P(17));
  x.addScaledVector(y, -y.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return { inv: new THREE.Matrix4().makeBasis(x, y, z).setPosition(w).invert(), span };
}

// Reflect forged geometry through z=0: positions + normals negate z,
// triangle winding reverses so faces stay outward. Skin weights are
// reused verbatim (reflection is an isometry — segment distances match).
function reflectGeometryZ(geo) {
  const pos = geo.getAttribute('position').array;
  const nrm = geo.getAttribute('normal').array;
  for (let i = 2; i < pos.length; i += 3) { pos[i] = -pos[i]; nrm[i] = -nrm[i]; }
  const idx = geo.index.array;
  for (let t = 0; t < idx.length; t += 3) { const b = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = b; }
  return geo;
}

export class HoloBodyRig {
  /**
   * opts.back — BACK-VIEW BIND (first/third-person avatar). The mirror
   * overlay drives the front bind directly, but the POV retarget shows
   * the person FROM BEHIND: its skeleton is a z-REFLECTION of the
   * mirror-space rest pose, and LBS built on proper rotations cannot
   * follow a reflection — every horizontal bone (clavicles, pelvis
   * wings) is forced to roll 180° about its own axis, collapsing the
   * shoulder/hip masses into a pinched bowtie. Same root cause the
   * HANDS solved with two chirality meshes (hand-views.js): the body
   * gets a dedicated reflected bind instead — reflected rest skeleton,
   * reflected forged geometry, hand packs chirality-swapped — so the
   * retargeted pose is a PROPER motion of its own bind pose.
   */
  constructor(scene, opts = {}) {
    const rows = opts.back ? REST_BODY.map(p => [p[0], p[1], -p[2]]) : REST_BODY;
    this.rest = rows.map(p => new THREE.Vector3(p[0], p[1], p[2]));
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
      // shadow-silhouette look (Kinect): dark core + electric aura
      uCore: { value: new THREE.Color(opts.core ?? 0x0a0e18) },
      uAura: { value: new THREE.Color(opts.aura ?? 0x9df1ff) },
      uWidth: { value: opts.auraWidth ?? 0.035 },
    };
    this.look = opts.look ?? 'ghost';   // 'ghost' (holo) | 'shadow' (Kinect silhouette)

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
    if (this._aura) {
      this.grp.remove(this._aura);
      this._aura.material.dispose();   // geometry is shared with the mesh — already disposed
      this._aura = null;
    }
    const out = forgeBody({ style: style || this.opts.style || 'standard' });
    if (this.opts.back) reflectGeometryZ(out.geometry);   // mirror-image bind (see constructor)
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

    this.mesh = new THREE.Mesh(geometry, this._makeMat(this.look));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;   // just under the hands
    this.grp.add(this.mesh);
    // Aura halo — SAME geometry (deforms with the body for free), inverted
    // hull pushed out along the live normals. Only shown in 'shadow' look.
    this._aura = new THREE.Mesh(geometry, makeAuraMaterial(this.uniforms));
    this._aura.frustumCulled = false;
    this._aura.renderOrder = 8;   // under the body core
    this._aura.visible = this.look === 'shadow';
    this.grp.add(this._aura);
    this._buildHands();
    return this;
  }

  _buildHands() {
    if (this._hands) {
      for (const h of Object.values(this._hands)) this.grp.remove(h.mesh, h.aura);
    }
    const geos = bodyHandGeometries();
    this._hands = {};
    for (const side of ['left', 'right']) {
      // chirality: mirror-space front bind → left side is L-pack; the
      // reflected back bind swaps chirality per side (a reflection turns
      // a left cloud into a right one)
      const useL = (side === 'left') !== !!this.opts.back;
      const geo = useL ? geos.left : geos.right;
      const mesh = new THREE.Mesh(geo, this.mesh.material);       // shared material — look/alpha in lockstep
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 9;
      const aura = new THREE.Mesh(geo, this._aura.material);
      aura.matrixAutoUpdate = false;
      aura.frustumCulled = false;
      aura.renderOrder = 8;
      aura.visible = this.look === 'shadow';
      this.grp.add(mesh, aura);
      const frame = handRestFrame(useL ? REST_L42 : REST_R42);
      // anatomical scale: the body skeleton's own wrist→MCP span over the
      // hand pack's — the live estimate may only deviate ±35% from this
      const W = side === 'left' ? 15 : 16, PK = W + 2, IX = W + 4;
      const bodySpan = this.rest[PK].clone().add(this.rest[IX]).multiplyScalar(0.5).distanceTo(this.rest[W]);
      this._hands[side] = { mesh, aura, s: 0, base: bodySpan / frame.span, ...frame };
    }
  }

  /** Rigid-map the forged hand meshes onto the live paddle frames. */
  _poseHands(lm) {
    if (!this._hands) return;
    for (const side of ['left', 'right']) {
      const A = side === 'left' ? 15 : 16;   // wrist; +2 pinky MCP; +4 index MCP
      const h = this._hands[side];
      const w = lm[A], pk = lm[A + 2], ix = lm[A + 4];
      _v.set((pk.x + ix.x) / 2 - w.x, (pk.y + ix.y) / 2 - w.y, (pk.z + ix.z) / 2 - w.z);
      const span = _v.length();
      if (span < 1e-5) continue;                       // degenerate frame → hold last pose
      _y.copy(_v).divideScalar(span);
      _x.set(ix.x - pk.x, ix.y - pk.y, ix.z - pk.z);
      _x.addScaledVector(_y, -_y.dot(_x));
      if (_x.lengthSq() < 1e-8) continue;
      _x.normalize();
      _z.crossVectors(_x, _y);
      // live uniform scale: body wrist→MCP span vs the pack's — but hands
      // can NEVER outgrow the body: clamped to ±35% of the anatomical
      // proportion at the rig's live global scale, then EMA'd
      const sBody = Math.max(0.1, Math.min(8, this._sEma || 1));
      const sExpect = h.base * sBody;
      const sRaw = Math.max(sExpect * 0.65, Math.min(sExpect * 1.35, span / h.span));
      h.s = h.s > 0 ? h.s + (sRaw - h.s) * 0.25 : sRaw;
      _m.makeBasis(_x.multiplyScalar(h.s), _y.multiplyScalar(h.s), _z.multiplyScalar(h.s));
      _m.setPosition(w.x, w.y, w.z);
      h.mesh.matrix.multiplyMatrices(_m, h.inv);
      h.aura.matrix.copy(h.mesh.matrix);
      h.mesh.matrixWorldNeedsUpdate = true;
      h.aura.matrixWorldNeedsUpdate = true;
    }
  }

  _makeMat(look) {
    return look === 'shadow' ? makeSilhouetteMaterial(this.uniforms) : makeGhostMaterial(this.uniforms);
  }

  /** Swap the body look live: 'ghost' (holo substrate) | 'shadow' (Kinect). */
  setLook(look) {
    if (look === this.look && this.mesh) return this;
    this.look = look;
    if (this.mesh) {
      this.mesh.material.dispose();
      this.mesh.material = this._makeMat(look);
      if (this._aura) this._aura.visible = look === 'shadow';
      if (this._hands) {
        for (const h of Object.values(this._hands)) {
          h.mesh.material = this.mesh.material;
          h.aura.visible = look === 'shadow';
        }
      }
    }
    return this;
  }

  setGhost({ alpha, body, rim, core, aura, auraWidth } = {}) {
    if (alpha !== undefined) this.uniforms.uAlpha.value = alpha;
    if (body !== undefined) this.uniforms.uBody.value.set(body);
    if (rim !== undefined) this.uniforms.uRim.value.set(rim);
    if (core !== undefined) this.uniforms.uCore.value.set(core);
    if (aura !== undefined) this.uniforms.uAura.value.set(aura);
    if (auraWidth !== undefined) this.uniforms.uWidth.value = auraWidth;
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
    this._poseHands(lm);
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
const REST_TRUNK = Math.hypot(
  REST_BODY[CHEST][0] - REST_BODY[HIP_MID][0],
  REST_BODY[CHEST][1] - REST_BODY[HIP_MID][1],
  REST_BODY[CHEST][2] - REST_BODY[HIP_MID][2]);
const REST_DIR = BODY_BONES.map(([i, j]) => new THREE.Vector3(
  REST_BODY[j][0] - REST_BODY[i][0], REST_BODY[j][1] - REST_BODY[i][1], REST_BODY[j][2] - REST_BODY[i][2]).normalize());

// AUX points the FK skeleton doesn't cover — face ring, pinky/thumb MCPs,
// heels. BODY_BONES only writes its CHILD joints, so these landmarks were
// never placed by retarget(): they sat at the origin, extendPose rebuilt
// the head from origin-ears (→ the head smeared into a vertical beam down
// the body core) and the hand paddle frames used an origin pinky (→ giant,
// crossed hands). Resolved parent-first AFTER the FK pass with the same
// contract: LIVE direction, REST length.
const AUX_POINTS = (() => {
  const pairs = [];
  for (let f = 0; f <= 10; f++) pairs.push([HEAD_C, f]);          // face ring off the head centre
  pairs.push([15, 17], [15, 21], [16, 18], [16, 22]);             // pinky + thumb MCPs off the wrists
  pairs.push([27, 29], [28, 30]);                                 // heels off the ankles
  return pairs.map(([i, j]) => ({
    i, j,
    len: Math.hypot(REST_BODY[j][0] - REST_BODY[i][0], REST_BODY[j][1] - REST_BODY[i][1], REST_BODY[j][2] - REST_BODY[i][2]),
    dir: new THREE.Vector3(REST_BODY[j][0] - REST_BODY[i][0], REST_BODY[j][1] - REST_BODY[i][1], REST_BODY[j][2] - REST_BODY[i][2]).normalize(),
  }));
})();

// Parent → child pairs walked (parent-first) by the mirror stabilizer —
// arm chains from the shoulders, leg chains from the hips. Face/torso
// points are the detection anchor; if THEY are gone there is no body.
const MIRROR_CHAIN = [
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22],
  [23, 25], [25, 27], [27, 29], [27, 31],
  [24, 26], [26, 28], [28, 30], [28, 32],
];

// Per-landmark visibility gates (field consensus: Kalidokit drops arms at
// vis<0.23 and legs at 0.63; iR Engine uses 0.6/0.75; MediaPipe's own
// drawing utils gate at 0.5). Legs get the strictest gate — hallucinated
// legs read worst — arms the loosest (the tracker is confident there).
function visThresh(j) {
  if (j >= 25 && j <= 32) return 0.55;   // knees / ankles / feet
  if (j >= 13 && j <= 22) return 0.25;   // elbows / wrists / hand paddles
  return 0.5;
}

export class BodyPose {
  constructor(opts = {}) {
    this.cfg = {
      steer: opts.steer ?? 1.5,        // image-hip x → lateral metres across the stage
      steerClamp: opts.steerClamp ?? 0.85,
      // jump inference: hips rising faster than this (m/s, converted via
      // the live trunk span) arms the airborne state — a stand-from-crouch
      // is legwork the FK already tracks, a jump is a launch.
      jumpVel: opts.jumpVel ?? 1.0,
      jumpMax: opts.jumpMax ?? 1.4,    // ceiling on inferred air height (m)
      ...opts,
    };
    this.size = 1;                     // silhouette scale (UI slider)
    this.airY = 0;                     // live inferred jump height (m) — read-only
    this._out = [];
    for (let i = 0; i < 37; i++) this._out.push(new THREE.Vector3());
    this._w = [];                       // converted world points (37)
    for (let i = 0; i < 37; i++) this._w.push(new THREE.Vector3());
    this._zAcc = { sum: 0, zs: 1 };
    this._dir = new Float32Array(37 * 3);   // per-JOINT incoming bone dir (for clamps + hold)
    this._gate = new Float32Array(37).fill(1);   // per-joint smoothed visibility gate 0..1
    this._hipYEma = REST_HIP_Y;
    this._lastT = -1;
    this._air = { on: false, base: -1, lastY: -1, vel: 0 };
    this._mir = null;                  // mirror-mode inference store (lazy)
  }

  drop() {
    this._zAcc.sum = 0; this._zAcc.zs = 1; this._hipYEma = REST_HIP_Y;
    this._lastT = -1; this.airY = 0;
    this._air.on = false; this._air.base = -1; this._air.lastY = -1; this._air.vel = 0;
    this._gate.fill(1);
    if (this._mir) for (const s of this._mir) if (s) s.has = false;
  }

  /**
   * JUMP / AIR inference. worldLandmarks are hip-origin — a jump is
   * INVISIBLE in them. The signal lives in the IMAGE hips: track their
   * y velocity, convert to metres with the live trunk span (self-
   * calibrating to camera distance), and hold a standing baseline that
   * only adapts while grounded. Launch-speed gating separates a jump
   * from stand-up/step-closer drift (both are slow).
   */
  _updateAir(img, dt) {
    const a = this._air;
    if (!img || !img[23] || !img[24] || !img[11] || !img[12]) {
      this.airY *= Math.max(0, 1 - dt * 6);
      return this.airY;
    }
    const hy = (img[23].y + img[24].y) / 2;                    // image y is DOWN
    const cy = (img[11].y + img[12].y) / 2;
    const trunk = Math.max(0.04, hy - cy);                     // image trunk span
    const mpu = (REST_TRUNK * this.size) / trunk;              // metres per image unit
    if (a.lastY < 0) { a.base = hy; a.lastY = hy; return 0; }
    if (dt > 0) {
      const v = -(hy - a.lastY) / dt;                          // up = positive
      a.vel += (v - a.vel) * Math.min(1, dt * 12);             // ~80ms EMA
    }
    a.lastY = hy;
    const rise = (a.base - hy) * mpu;                          // metres above baseline
    if (!a.on) {
      a.base += (hy - a.base) * Math.min(1, dt / 1.2);         // baseline drifts while grounded
      if (a.vel * mpu > this.cfg.jumpVel && rise > 0.05) a.on = true;
    } else if (rise <= 0.02) {
      a.on = false;                                            // landed
    }
    const target = a.on ? Math.min(this.cfg.jumpMax, Math.max(0, rise)) : 0;
    this.airY += (target - this.airY) * Math.min(1, dt * (a.on ? 18 : 10));
    return this.airY;
  }

  /**
   * Rebuild the avatar-space pose from MediaPipe pose worldLandmarks.
   * @param {Array} world 33 raw worldLandmarks ({x,y,z}, metres, hip origin)
   * @param {Array} img   33 normalized image landmarks (mirrored) — steering + jump
   * @param {THREE.Vector3} spawn avatar root position (feet ≈ this point)
   * @param {number} yaw avatar yaw around +Y (0 = faces −Z, back to camera)
   * @param {Array|Float32Array} vis per-landmark visibility 0..1 (33) or null
   * @param {number} tSec clock for velocity/decay (defaults to performance.now())
   * @returns 37 Vector3 world points for HoloBodyRig.pose()
   */
  retarget(world, img, spawn, yaw = 0, vis = null, tSec = null) {
    if (!world || world.length < 33) return null;
    const t = tSec ?? performance.now() * 0.001;
    const dt = this._lastT < 0 ? 1 / 30 : Math.max(1e-3, Math.min(0.1, t - this._lastT));
    this._lastT = t;
    // 1. convert to scene axes (y up), viewed FROM BEHIND: Ry(π) folded in
    //    ⇒ (x, y, z)world → (−x, −y, z·zs)scene, zs self-calibrated below.
    const zs = this._zSign(world);
    const W = this._w;
    for (let i = 0; i < 33; i++) {
      W[i].set(-world[i].x, -world[i].y, world[i].z * zs);
    }
    extendPose(W, () => new THREE.Vector3());

    // per-joint visibility gates, EMA'd (MediaPipe itself smooths visibility
    // with a heavy alpha≈0.1 low-pass before anyone thresholds it — the same
    // idea: no single frame may flip a limb between live and inferred)
    const G = this._gate;
    if (vis) {
      const k = Math.min(1, dt * 6);   // ~0.25s reacquire/release blend
      for (let j = 0; j < 33; j++) G[j] += ((vis[j] >= visThresh(j) ? 1 : 0) - G[j]) * k;
      G[HIP_MID] = Math.min(G[23], G[24]);
      G[CHEST] = Math.min(G[11], G[12]);
      G[HEAD_C] = G[HEAD_TOP] = Math.max(G[0], Math.min(G[7], G[8]));
    }

    // 2. FK: rest bone lengths + live directions, parent-first, with clamps.
    //    Low-visibility joints are PREDICTED, not tracked: their bone keeps
    //    its last confident direction and relaxes toward the rest pose (the
    //    Kalidokit/VTuber consensus — a frozen stale limb reads worse than
    //    one settling to neutral, and MediaPipe still hallucinates coords
    //    for out-of-frame joints, which must never drive the mesh).
    const out = this._out;
    const D = this._dir;
    const relax = Math.min(1, dt * 1.6);
    const L0 = this.size;
    out[HIP_MID].set(0, 0, 0);
    for (let b = 0; b < BODY_BONES.length; b++) {
      const [i, j] = BODY_BONES[b];
      let dx = W[j].x - W[i].x, dy = W[j].y - W[i].y, dz = W[j].z - W[i].z;
      let len = Math.hypot(dx, dy, dz);
      if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
      else {
        dx = REST_DIR[b].x; dy = REST_DIR[b].y; dz = REST_DIR[b].z;
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
      // visibility blend: gate 1 → pure live (zero added lag); gate 0 →
      // held direction easing home to rest
      const g = vis ? G[j] : 1;
      if (g < 0.999) {
        let hx = D[j3], hy2 = D[j3 + 1], hz = D[j3 + 2];
        if (hx * hx + hy2 * hy2 + hz * hz < 0.25) { hx = REST_DIR[b].x; hy2 = REST_DIR[b].y; hz = REST_DIR[b].z; }
        const rr = relax * (1 - g);
        hx += (REST_DIR[b].x - hx) * rr; hy2 += (REST_DIR[b].y - hy2) * rr; hz += (REST_DIR[b].z - hz) * rr;
        dx = hx + (dx - hx) * g; dy = hy2 + (dy - hy2) * g; dz = hz + (dz - hz) * g;
        const il = 1 / (Math.hypot(dx, dy, dz) || 1);
        dx *= il; dy *= il; dz *= il;
      }
      D[j3] = dx; D[j3 + 1] = dy; D[j3 + 2] = dz;
      const L = REST_LEN[b] * L0;
      out[j].set(out[i].x + dx * L, out[i].y + dy * L, out[i].z + dz * L);
    }

    // 2b. AUX landmarks (face ring, pinky/thumb MCPs, heels) — every one
    //     of the 37 points must be real before placement: extendPose and
    //     the attached hand frames read them.
    for (const a of AUX_POINTS) {
      // direction measured in W-space (extendPose(W) above filled its
      // synthetics, so HEAD_C parents are valid there); anchored at the
      // FK-resolved parent in out-space
      let dx = W[a.j].x - W[a.i].x, dy = W[a.j].y - W[a.i].y, dz = W[a.j].z - W[a.i].z;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
      else { dx = a.dir.x; dy = a.dir.y; dz = a.dir.z; }
      const L = a.len * L0;
      out[a.j].set(out[a.i].x + dx * L, out[a.i].y + dy * L, out[a.i].z + dz * L);
    }

    // 3. ground the feet: hip height = −(lowest foot y), smoothed (crouch
    //    tracks through; single-frame foot glitches don't bounce the body).
    //    Feet out of frame → FREEZE the ground estimate (their hallucinated
    //    positions must not bob the body up and down). RAW visibility, not
    //    the smoothed gate: the freeze must engage the frame the feet leave.
    const feetGate = vis ? Math.max(vis[27], vis[28], vis[31], vis[32]) : 1;
    if (feetGate >= 0.55) {
      let minY = 0;
      for (const fi of [27, 28, 29, 30, 31, 32]) minY = Math.min(minY, out[fi].y);
      const hipY = Math.max(0.45 * L0, Math.min(1.08 * REST_HIP_Y * L0, -minY + 0.02));
      this._hipYEma += (hipY - this._hipYEma) * 0.2;
    }

    // 3b. jump — image-hip launch velocity → inferred air height
    const airY = this._updateAir(img, dt);

    // 4. lateral steer from the mirrored image hips (step side → avatar steps)
    let steerX = 0;
    if (img && img[23] && img[24]) {
      const hx = (img[23].x + img[24].x) / 2;
      steerX = Math.max(-this.cfg.steerClamp, Math.min(this.cfg.steerClamp, (hx - 0.5) * this.cfg.steer));
    }

    // 5. place in the world: yaw, then spawn offset (+ air)
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rootY = this._hipYEma + airY;
    for (let i = 0; i < 37; i++) {
      const p = out[i];
      const x = p.x + steerX, yv = p.y + rootY, z = p.z;
      p.set(x * cy + z * sy + spawn.x, yv + spawn.y, -x * sy + z * cy + spawn.z);
    }
    return out;
  }

  /**
   * MIRROR-MODE partial-body stabilizer. Operates IN PLACE on the 33
   * ray-projected scene points. MediaPipe hallucinates coordinates for
   * out-of-frame joints (its own issue tracker: "will always predict all
   * outputs") — so every low-visibility child joint is re-hung from its
   * parent: it keeps its last confident offset and relaxes toward the
   * rest-pose offset (scaled to the live shoulder span), instead of
   * flailing wherever the tracker guesses.
   */
  stabilizeMirror(pts, vis, dt = 1 / 60) {
    if (!vis) return pts;
    if (!this._mir) {
      this._mir = [];
      for (let i = 0; i < 33; i++) this._mir.push({ off: new THREE.Vector3(), g: 1, has: false });
    }
    // live scale: shoulder span is the most reliably visible dimension
    const span = pts[11].distanceTo(pts[12]);
    const restSpan = Math.hypot(REST_BODY[12][0] - REST_BODY[11][0], REST_BODY[12][1] - REST_BODY[11][1], REST_BODY[12][2] - REST_BODY[11][2]);
    if (span > 1e-3) this._mirScale = span / restSpan;
    const sc = this._mirScale || 1;
    const k = Math.min(1, dt * 6);          // gate blend (≈0.25s)
    const relax = Math.min(1, dt * 1.6);    // settle-to-rest rate
    for (const [par, ch] of MIRROR_CHAIN) {
      const s = this._mir[ch];
      s.g += ((vis[ch] >= visThresh(ch) ? 1 : 0) - s.g) * k;
      _v.subVectors(pts[ch], pts[par]);     // live offset (may be hallucinated)
      if (!s.has) { s.off.copy(_v); s.has = true; }
      if (s.g >= 0.999) {
        s.off.copy(_v);                     // fully live → refresh the memory
      } else {
        // held memory NEVER absorbs gated data — it only relaxes toward the
        // scaled rest offset (A-pose hang); the output blends for a smooth
        // handoff, but hallucinated frames can't pollute what's remembered.
        _y.set((REST_BODY[ch][0] - REST_BODY[par][0]) * sc,
               (REST_BODY[ch][1] - REST_BODY[par][1]) * sc,
               (REST_BODY[ch][2] - REST_BODY[par][2]) * sc);
        s.off.lerp(_y, relax);
        _v.lerpVectors(s.off, _v, s.g);     // gate: live ↔ inferred
        pts[ch].copy(pts[par]).add(_v);
      }
    }
    return pts;
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
