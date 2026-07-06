/**
 * hopeOS SDK — Holo Hand Rig
 * ═══════════════════════════════════════════════════════════════
 * Bone-based hand deformation driven directly by 21 MediaPipe
 * landmarks. Replaces K-nearest-landmark translation skinning
 * (RiggedHand) — the source of the wrinkle/shimmer/candy-wrap
 * artifacts — with 20 rigid bone transforms + linear blend skinning:
 *
 *   • Every bone frame is BUILT FROM the live landmarks, so there is
 *     no FK drift: fingertips land EXACTLY on the tracked points
 *     (per-bone stretch along the bone axis, uniform hand scale on
 *     the cross axes). Misalignment ≈ 0 by construction.
 *   • Rotations are proper (det > 0 always): the mesh can never be
 *     mirror-twisted by the deformer. Chirality is chosen once, by
 *     which rest skeleton you build with (see hand-views.js).
 *   • Roll is stabilized by the palm normal, with per-bone temporal
 *     fallback when a finger points along it (fist toward camera).
 *   • No per-frame allocation, no computeVertexNormals — normals
 *     rotate with their dominant bone.
 *
 * Collider conforming (fingers wrap on contact) is ported unchanged
 * from the classic holohand so grab/occlusion design keeps working.
 *
 *   const rig = new HoloHandRig(REST_R42, scene, { style: 'smooth' });
 *   rig.build();
 *   rig.pose(landmarks21WorldVec3, colliders);   // per frame (null → hide)
 */

import * as THREE from 'three';
import { forgeHand, rigExternalGeometry, computeBoneWeights, computeDetailAttribute, HAND_BONES } from './hand-forge.js';
import { getFaceNormal } from '../interaction/colliders.js';

// ── Ghost shader — semi-translucent blue holo hand ──────────────
// Normal blending (NOT additive: additive vanished over bright rooms),
// depthWrite ON so the hand self-occludes and occludes scene objects
// behind fingers — the depth buffer does the occlusion design for free.
const GHOST_VERT = /* glsl */`
attribute vec3 aDetail;      // x = nail, y = palm crease, z = knuckle (see hand-forge)
varying vec3 vN, vV, vW, vDet;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  vDet = aDetail;
  gl_Position = projectionMatrix * mv;
}`;

const GHOST_FRAG = /* glsl */`
uniform float uTime, uGlow, uAlpha;
uniform vec3 uBody, uRim;
varying vec3 vN, vV, vW, vDet;
void main() {
  vec3 N = normalize(vN), V = normalize(vV);
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 1.6);                        // silhouette density
  float side = pow(1.0 - ndv, 4.0);                        // profile fullness
  // Pale glowing hologram body: half-Lambert wrap shading gives the rounded
  // volumetric read (a fresnel-only ghost looks like a flat clip-out and
  // goes invisible where the surface faces the eye).
  vec3 L = normalize(vec3(0.35, 0.85, 0.55));
  float dif = 0.42 + 0.58 * pow(0.5 + 0.5 * dot(N, L), 1.4);
  float up = 0.5 + 0.5 * N.y;
  vec3 base = uBody * (0.62 + 0.85 * dif);                 // shaded pale-blue flesh
  base += uBody * up * 0.22;                               // soft sky fill
  vec3 c = base
         + uRim * (fres * 0.85 + side * 0.45)              // cyan edge glow
         + vec3(0.85, 0.97, 1.0) * fres * 0.30             // icy white rim bloom
         + vec3(0.95, 0.55, 0.25) * uGlow;                 // contact heat

  // ── anatomical detail (x-ray read: this is a REAL 3D hand, not a decal) ──
  // (nail mask vDet.x is still baked, but unshaded — the white tip chips
  // read as painted decals rather than x-ray matter, so they're off.)
  float crease = vDet.y, knk = vDet.z;
  // the three palmar crease lines: denser fold shadows
  c *= 1.0 - crease * 0.30;
  // knuckle caps: subtle bone-dense glow under the skin
  c += (uBody * 0.28 + uRim * 0.14) * knk;

  c *= 1.0 + sin(vW.y * 60.0 + uTime * 1.8) * 0.04;        // faint holo scan
  // +0.06 floor: end-on convex bumps (fingertip at the camera, knuckle
  // domes) must never go transparent enough to read as punctures.
  float a = uAlpha * (0.58 + 0.42 * dif) + fres * 0.28 + uGlow * 0.15 + 0.06
          + crease * 0.10 + knk * 0.05;                    // details are denser matter
  gl_FragColor = vec4(c, clamp(a, 0.08, 0.95));
}`;

export function makeGhostMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: GHOST_VERT,
    fragmentShader: GHOST_FRAG,
    uniforms,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: true,
    side: THREE.FrontSide,
  });
}

// ── Rig ─────────────────────────────────────────────────────────
const _v = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _x = new THREE.Vector3();
const _n = new THREE.Vector3(), _m = new THREE.Matrix4();
const _wp = new THREE.Vector3(), _wq = new THREE.Quaternion(), _ws = new THREE.Vector3();
const _lv = new THREE.Vector3();
const TIP_IDS = [4, 8, 12, 16, 20];

export class HoloHandRig {
  /**
   * @param {Array} rest - 21+ rest landmarks ([x,y,z] rows) — REST_R42 or REST_L42
   * @param {THREE.Scene} scene
   * @param {Object} opts - { style, geometry, skin, alpha, body, rim }
   */
  constructor(rest, scene, opts = {}) {
    this.rest = rest.slice(0, 21).map(p => new THREE.Vector3(p[0], p[1], p[2]));
    this.opts = opts;
    this.grp = new THREE.Group();
    this.grp.visible = false;
    if (scene) scene.add(this.grp);

    this.uniforms = {
      uTime: { value: 0 },
      uGlow: { value: 0 },
      uAlpha: { value: opts.alpha ?? 0.46 },
      uBody: { value: new THREE.Color(opts.body ?? 0x6fb0dc) },   // pale glowing blue
      uRim: { value: new THREE.Color(opts.rim ?? 0xaeeaff) },
    };

    // Rest bone data
    const nb = HAND_BONES.length;
    this._restLen = new Float32Array(nb);
    this._restInv = [];
    this._prevZ = [];
    this._restSpan = this.rest[0].distanceTo(this.rest[9]);
    // Orientation-robust sizing cues (see pose()): rest lengths of three
    // roughly orthogonal hand dimensions.
    this._restKnuck = this.rest[5].distanceTo(this.rest[17]);
    this._restRing = this.rest[0].distanceTo(this.rest[13]);
    this._sEma = 0;
    const zRef = this._palmNormal(this.rest, new THREE.Vector3());
    for (let b = 0; b < nb; b++) {
      const [i, j] = HAND_BONES[b];
      const m = new THREE.Matrix4();
      const zStore = new THREE.Vector3();
      this._boneBasis(this.rest[i], this.rest[j], zRef, 1, m, zStore);
      this._restLen[b] = this.rest[i].distanceTo(this.rest[j]);
      this._restInv.push(m.invert());
      this._prevZ.push(zStore);
    }
    this._skinFlat = new Float32Array(nb * 12);   // row-major 3×4 per bone

    this.mesh = null;
    this.vc = 0;
    this._restPos = null;   // Float32Array bind positions
    this._restNrm = null;
    this._skin = null;      // { index, weight }
    this.tips = TIP_IDS.map(() => new THREE.Vector3());   // fingertip world pos (thumb..pinky)
    this.stats = null;
  }

  /** Palm normal — chirality-consistent as long as rest & live data match. */
  _palmNormal(lm, out) {
    _y.subVectors(lm[5], lm[0]);
    _v.subVectors(lm[17], lm[0]);
    return out.crossVectors(_y, _v).normalize();
  }

  /**
   * Orthonormal bone basis: Y column = full bone vector (stretch → exact
   * joint alignment), X/Z columns unit × scaleXZ. det > 0 always.
   * Returns false if zRef is degenerate for this bone (caller falls back).
   */
  _boneBasis(a, b, zRef, scaleXZ, outM, zStore) {
    _y.subVectors(b, a);
    const len = _y.length();
    if (len < 1e-6) return false;
    _v.copy(_y).divideScalar(len);                       // ydir
    _z.copy(zRef).addScaledVector(_v, -zRef.dot(_v));    // project out
    if (_z.lengthSq() < 1e-4) {
      if (!zStore || zStore.lengthSq() < 0.5) return false;
      _z.copy(zStore).addScaledVector(_v, -zStore.dot(_v));   // temporal fallback
      if (_z.lengthSq() < 1e-6) return false;
    }
    _z.normalize();
    if (zStore) zStore.copy(_z);
    _x.crossVectors(_v, _z);                             // unit, right-handed
    outM.makeBasis(
      _x.multiplyScalar(scaleXZ),
      _y,                                                 // full bone vector
      _z.multiplyScalar(scaleXZ)
    );
    outM.setPosition(a.x, a.y, a.z);   // plain {x,y,z} landmarks welcome
    return true;
  }

  /** Build (or rebuild) the mesh. style: smooth|slim|full|lowpoly, or pass opts.geometry. */
  build(style) {
    if (this.mesh) {
      this.grp.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.occluder) {
      this.grp.remove(this.occluder);
      this.occluder.material.dispose();   // geometry was the mesh's — already disposed
      this.occluder = null;
    }
    let geometry, skin;
    if (this.opts.geometry) {
      // geometryFit:false → the external mesh is already in rest-landmark space
      // (e.g. holohand.glb, pre-aligned to REST_R42/L42); bbox-fitting it again
      // would shrink it slightly (flesh extends past the tip landmarks).
      ({ geometry, skin } = rigExternalGeometry(this.opts.geometry, this.rest.map(p => [p.x, p.y, p.z]),
        { fit: this.opts.geometryFit ?? true }));
      this.stats = { verts: geometry.getAttribute('position').count, style: 'external' };
    } else {
      const rest = this.rest.map(p => [p.x, p.y, p.z]);
      const out = forgeHand({ rest, style: style || this.opts.style || 'smooth' });
      geometry = out.geometry; skin = out.skin; this.stats = out.stats;
    }
    this.vc = geometry.getAttribute('position').count;
    // Detail masks (nails/creases/knuckles) — external meshes get them here.
    if (!geometry.getAttribute('aDetail')) {
      try { computeDetailAttribute(geometry, this.rest.map(p => [p.x, p.y, p.z])); }
      catch (e) { geometry.setAttribute('aDetail', new THREE.BufferAttribute(new Float32Array(this.vc * 3), 3)); }
    }
    this._restPos = geometry.getAttribute('position').array.slice();
    this._restNrm = geometry.getAttribute('normal').array.slice();
    this._skin = skin;
    geometry.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    geometry.getAttribute('normal').setUsage(THREE.DynamicDrawUsage);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // we own culling

    this.mesh = new THREE.Mesh(geometry, makeGhostMaterial(this.uniforms));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;   // draw after the scene so blending reads it
    this.grp.add(this.mesh);
    if (this._occlude) this._buildOccluder();
    return this;
  }

  /**
   * VIDEO-HAND OCCLUSION (mirror mode). The ghost writes depth, but it
   * draws AFTER scene objects — a finger in front of the cube only tints
   * it. This twin shares the skinned geometry and writes DEPTH ONLY,
   * BEFORE the scene (renderOrder -5): objects behind the fingers fail
   * the depth test, the transparent canvas shows the camera feed, and
   * your REAL fingers cover the object — the screenshots' occlusion.
   * Only correct in mirror mode (elsewhere it would punch holes in the
   * environment) — toggle per view mode.
   */
  setOccluder(on) {
    this._occlude = !!on;
    if (this._occlude && this.mesh && !this.occluder) this._buildOccluder();
    if (this.occluder) this.occluder.visible = this._occlude;
  }

  _buildOccluder() {
    this.occluder = new THREE.Mesh(this.mesh.geometry,
      new THREE.MeshBasicMaterial({ colorWrite: false }));
    this.occluder.renderOrder = -5;
    this.occluder.frustumCulled = false;
    this.occluder.visible = this._occlude;
    this.grp.add(this.occluder);
  }

  /** Live ghost look tuning. */
  setGhost({ alpha, body, rim } = {}) {
    if (alpha !== undefined) this.uniforms.uAlpha.value = alpha;
    if (body !== undefined) this.uniforms.uBody.value.set(body);
    if (rim !== undefined) this.uniforms.uRim.value.set(rim);
  }

  /**
   * Pose the hand to 21 world-space landmarks (THREE.Vector3 or {x,y,z}).
   * Pass null/undefined to hide. `cols` = collider array (sphere | mesh+bvh).
   */
  pose(lm, cols) {
    if (!this.mesh || !lm) { this.grp.visible = false; return null; }
    const nb = HAND_BONES.length;

    // ── Bone skinning matrices from live landmarks ──
    const zRef = this._palmNormal(lm, _n);
    if (!isFinite(zRef.x)) { this.grp.visible = false; return null; }
    // MODEL INTEGRITY: hand THICKNESS must not depend on orientation. Any
    // single projected span foreshortens when the hand tilts toward the
    // camera (fingers collapsed to sticks) — so take the LARGEST of three
    // near-orthogonal dimension cues (at least one is always broadside),
    // smoothed so size only follows real distance changes.
    const s1 = _v.subVectors(lm[9], lm[0]).length() / this._restSpan;
    const s2 = _v.subVectors(lm[17], lm[5]).length() / this._restKnuck;
    const s3 = _v.subVectors(lm[13], lm[0]).length() / this._restRing;
    const sRaw = Math.max(s1, s2, s3);
    this._sEma = this._sEma > 0 ? this._sEma + (sRaw - this._sEma) * 0.22 : sRaw;
    const sGlobal = Math.max(0.2, Math.min(6, this._sEma));
    const F = this._skinFlat;
    for (let b = 0; b < nb; b++) {
      const [i, j] = HAND_BONES[b];
      if (!this._boneBasis(lm[i], lm[j], zRef, sGlobal, _m, this._prevZ[b])) {
        continue;   // keep last frame's matrix for this bone
      }
      _m.multiply(this._restInv[b]);
      const e = _m.elements, o = b * 12;
      F[o] = e[0];  F[o + 1] = e[4]; F[o + 2] = e[8];  F[o + 3] = e[12];
      F[o + 4] = e[1]; F[o + 5] = e[5]; F[o + 6] = e[9];  F[o + 7] = e[13];
      F[o + 8] = e[2]; F[o + 9] = e[6]; F[o + 10] = e[10]; F[o + 11] = e[14];
    }
    this.grp.visible = true;

    // ── LBS: 3 influences per vertex (webs/joints blend across 3 bones) ──
    const pos = this.mesh.geometry.getAttribute('position').array;
    const nrm = this.mesh.geometry.getAttribute('normal').array;
    const rp = this._restPos, rn = this._restNrm;
    const si = this._skin.index, sw = this._skin.weight;
    for (let v = 0; v < this.vc; v++) {
      const v3 = v * 3, vs = v * 3;
      const px = rp[v3], py = rp[v3 + 1], pz = rp[v3 + 2];
      const o0 = si[vs] * 12, w0 = sw[vs];
      const o1 = si[vs + 1] * 12, w1 = sw[vs + 1];
      const o2 = si[vs + 2] * 12, w2 = sw[vs + 2];
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
      // Normal: blend across ALL influences (dominant-only rotation drew
      // visible crease seams along weight boundaries under strong splay).
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

    // ── Collider conform (unchanged holohand contact design) ──
    let contacts = 0;
    if (cols && cols.length) contacts = this._conform(pos, cols);

    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    this.mesh.geometry.getAttribute('normal').needsUpdate = true;
    this.uniforms.uGlow.value += ((contacts > 12 ? 0.5 : 0) - this.uniforms.uGlow.value) * 0.15;

    // Fingertips + palm for game logic
    for (let t = 0; t < 5; t++) {
      const p = lm[TIP_IDS[t]];
      this.tips[t].set(p.x, p.y, p.z);
    }
    return lm;
  }

  _conform(pos, cols) {
    let cc = 0;
    const _tgt = this._tgt || (this._tgt = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 });
    for (let v = 0; v < this.vc; v++) {
      const v3 = v * 3;
      _v.set(pos[v3], pos[v3 + 1], pos[v3 + 2]);
      let moved = false;
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        if (!col.active) continue;
        if (col.type === 'sphere') {
          const d = _v.distanceTo(col.center);
          if (d < col.radius && d > 1e-4) {
            // +3mm epsilon: conformed skin sits just OFF the shell, so an
            // opaque depth-writing object never z-fights the wrapped fingers
            _v.sub(col.center).multiplyScalar((col.radius + 0.003) / d).add(col.center);
            moved = true; cc++;
          }
        } else if (col.type === 'box') {
          // OBB { center, quat, half } (the Rubik's cube): vertices inside
          // exit through the NEAREST face, +3mm epsilon like the sphere.
          _lv.copy(_v).sub(col.center).applyQuaternion(_wq.copy(col.quat).invert());
          const px = col.half.x - Math.abs(_lv.x);
          if (px > 0) {
            const py = col.half.y - Math.abs(_lv.y), pz = col.half.z - Math.abs(_lv.z);
            if (py > 0 && pz > 0) {
              if (px <= py && px <= pz)  _lv.x = (_lv.x >= 0 ? 1 : -1) * (col.half.x + 0.003);
              else if (py <= pz)         _lv.y = (_lv.y >= 0 ? 1 : -1) * (col.half.y + 0.003);
              else                       _lv.z = (_lv.z >= 0 ? 1 : -1) * (col.half.z + 0.003);
              _v.copy(_lv).applyQuaternion(col.quat).add(col.center);
              moved = true; cc++;
            }
          }
        } else if (col.type === 'mesh' && col.bvh) {
          col.mesh.updateMatrixWorld();
          col.boundCenter.setFromMatrixPosition(col.mesh.matrixWorld);
          col.mesh.matrixWorld.decompose(_wp, _wq, _ws);
          const worldR = col.boundRadius * Math.max(_ws.x, _ws.y, _ws.z);
          if (_v.distanceTo(col.boundCenter) > worldR + 0.05) continue;
          col._invMat.copy(col.mesh.matrixWorld).invert();
          _lv.copy(_v).applyMatrix4(col._invMat);
          _tgt.distance = Infinity;
          const r = col.bvh.closestPointToPoint(_lv, _tgt, 0, 0.08);
          if (r && _tgt.distance < 0.025) {
            const fn = getFaceNormal(col.mesh.geometry, _tgt.faceIndex);
            _x.copy(_lv).sub(_tgt.point);
            if (_x.dot(fn) < 0) {
              _v.copy(_tgt.point).applyMatrix4(col.mesh.matrixWorld)
                .addScaledVector(_z.copy(fn).transformDirection(col.mesh.matrixWorld), 0.003);
              moved = true; cc++;
            }
          }
        }
      }
      if (moved) { pos[v3] = _v.x; pos[v3 + 1] = _v.y; pos[v3 + 2] = _v.z; }
    }
    return cc;
  }

  tick(elapsed) { this.uniforms.uTime.value = elapsed; }

  dispose() {
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
    if (this.occluder) this.occluder.material.dispose();
    this.grp.removeFromParent();
  }
}

export { HAND_BONES, computeBoneWeights };
