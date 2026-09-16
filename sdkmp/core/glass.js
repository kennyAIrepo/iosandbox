/**
 * hopeOS SDK — glass.js: physically-based GLASS + SOFT-BODY "slime", built
 * straight in three.js (no Blender round-trip needed).
 * ═══════════════════════════════════════════════════════════════════════════
 * makeGlass(opts) → MeshPhysicalMaterial with the same numbers Blender's
 *   Principled glass exports (transmission + IOR + volume attenuation): real
 *   screen-space refraction of whatever is RENDERED behind the object, tinted
 *   by path length through the volume (thicker = greener, like real glass).
 *   lens: 'window' | 'magnifier' | 'ball-lens' — an onBeforeCompile hook on the
 *   transmission sample. A solid glass sphere shows the world behind it
 *   upside-down + magnified; three's single-surface model alone cannot, so
 *   'ball-lens' flips the sample through the object's screen centre.
 *   Feed the centre each frame with updateLens().
 *
 * attachEnv(mat, texture) — equirect-map a LIVE texture (the webcam frame,
 *   the sky) as the reflection environment: cheap, live, reads as glass.
 *
 * SoftBody(mesh, radius, opts) — the "vertex count" idea from Blender, made
 *   live: every vertex is a mass point. Softness 0 = rigid glass (vertices
 *   only dent under a pressing finger and spring back); softness → 1 = slime:
 *   shape-springs weaken, GRAVITY takes over, the blob sags, pools on the
 *   floor and drips between the hand's joint spheres — collision runs against
 *   the same joint spheres the hands already log, so it never passes through
 *   a finger. The physics sphere (grab/throw) still owns the centroid, so it
 *   stays a solid grabbable object however soft it looks.
 *   detail = sphere segments (vertex density): more vertices = smoother melt.
 */
import * as THREE from 'three';

const LENS = { window: 0, magnifier: 1, 'ball-lens': 2 };

export function makeGlass(opts = {}) {
  const o = { tint: 0x8cf5b8, ior: 1.45, roughness: 0.05, thickness: 0.3, transmission: 1.0,
              attenuationDistance: 0.35, lens: 'window', magnify: 1.6, rim: 0.32, ...opts };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: o.roughness, transmission: o.transmission,
    ior: o.ior, thickness: o.thickness, attenuationColor: new THREE.Color(o.tint),
    attenuationDistance: o.attenuationDistance, envMapIntensity: 1.0,
    clearcoat: 1.0, clearcoatRoughness: 0.04, specularIntensity: 1.0, transparent: false,
  });
  mat.userData.lens = { mode: new THREE.Uniform(LENS[o.lens] ?? 0), centre: new THREE.Uniform(new THREE.Vector2(0.5, 0.5)),
                        radius: new THREE.Uniform(0.2), magnify: new THREE.Uniform(o.magnify), rim: new THREE.Uniform(o.rim) };
  mat.onBeforeCompile = (sh) => {
    const L = mat.userData.lens;
    sh.uniforms.uLensMode = L.mode; sh.uniforms.uLensC = L.centre; sh.uniforms.uLensR = L.radius; sh.uniforms.uLensMag = L.magnify; sh.uniforms.uRim = L.rim;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <transmission_pars_fragment>',
        '#include <transmission_pars_fragment>\nuniform int uLensMode; uniform vec2 uLensC; uniform float uLensR; uniform float uLensMag; uniform float uRim;')
      // FRESNEL RIM: glass edges catch the light — the silhouette reads as a
      // solid volume instead of a flat tinted cut-out
      .replace('#include <opaque_fragment>',
        `float hopeRim = pow( 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) ), 3.0 );
         outgoingLight += uRim * hopeRim * vec3( 0.85, 1.0, 0.9 );
         #include <opaque_fragment>`)
      .replace('vec4 transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );',
        `vec2 lensUv = refractionCoords;
         if (uLensMode > 0) {
           vec2 d = (lensUv - uLensC);
           if (uLensMode == 2) d = -d;            // ball-lens: inverted through the centre
           lensUv = uLensC + d / uLensMag;        // magnified: sample a smaller patch
         }
         vec4 transmittedLight = getTransmissionSample( lensUv, roughness, ior );`);
  };
  mat.customProgramCacheKey = () => 'hopeos-glass-lens';
  mat.setLens = (mode) => { mat.userData.lens.mode.value = LENS[mode] ?? 0; mat.userData.lensName = mode; };
  mat.userData.lensName = o.lens;
  return mat;
}

const _c = new THREE.Vector3(), _e = new THREE.Vector3();
/** Feed the object's screen centre + apparent radius to the lens (per frame). */
export function updateLens(mat, mesh, camera, worldRadius) {
  const L = mat.userData.lens; if (!L) return;
  mesh.getWorldPosition(_c);
  _e.copy(_c).project(camera);
  L.centre.value.set(_e.x * 0.5 + 0.5, _e.y * 0.5 + 0.5);
  _c.add(camera.up.clone().multiplyScalar(worldRadius)).project(camera);
  L.radius.value = Math.abs(_c.y - _e.y) * 0.5;
}

/** Live equirect environment from any texture (webcam VideoTexture, sky). */
export function attachEnv(mat, texture) {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  mat.envMap = texture; mat.needsUpdate = true;
  return texture;
}

/** Vertex density presets — the Blender "poly count" knob, live. */
export const SOFT_DETAIL = { low: [48, 24], medium: [72, 36], high: [112, 56] };
export const SOFT_PRESETS = { glass: 0.0, jelly: 0.35, slime: 0.7, melt: 0.95 };

export class SoftBody {
  constructor(mesh, radius, opts = {}) {
    this.mesh = mesh; this.r = radius;
    this.o = { kRigid: 260, kSoft: 6, damp: 7, gravity: 4.5, friction: 0.55, maxStretch: 2.2, substeps: 2, ...opts };
    this.softness = 0;                        // 0 rigid glass … 1 melting slime
    this.rebind();
    this._w = new THREE.Vector3(); this._n = new THREE.Vector3(); this._g = new THREE.Vector3();
    this._inv = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
  }
  /** (Re)take the current geometry as the rest shape (after a detail change). */
  rebind() {
    const pos = this.mesh.geometry.getAttribute('position');
    this.n = pos.count;
    this.rest = pos.array.slice();
    this.p = pos.array.slice();
    this.v = new Float32Array(this.n * 3);
  }
  setSoftness(s) { this.softness = Math.min(1, Math.max(0, s)); }
  /**
   * @param presses   [{p:Vector3 (world), r}] hand joint spheres (and anything else) touching the blob
   * @param floorY    world floor height (null = none)
   * @returns {squash, sag}  squash = deepest dent (local units); sag = how far the lowest point dropped below rest
   */
  update(dt, presses, floorY = null) {
    const pos = this.mesh.geometry.getAttribute('position'), P = pos.array, R = this.rest, p = this.p, v = this.v;
    const s = this.softness, o = this.o;
    const k = o.kRigid + (o.kSoft - o.kRigid) * s;             // spring to the rest shape
    const g = o.gravity * s * s;                                // gravity only as it softens
    const mw = this.mesh.matrixWorld; this._inv.copy(mw).invert();
    this.mesh.getWorldQuaternion(this._q); const sc = this.mesh.getWorldScale(this._s).x || 1;
    this._g.set(0, -g, 0).applyQuaternion(this._q.clone().invert());   // world gravity → local
    const local = [];
    for (const pr of presses) local.push({ x: 0, y: 0, z: 0, r: pr.r / sc, w: this._w.copy(pr.p).applyMatrix4(this._inv).clone() });
    for (const l of local) { l.x = l.w.x; l.y = l.w.y; l.z = l.w.z; }
    const floorLocal = floorY === null ? null : this._w.set(0, floorY, 0).applyMatrix4(this._inv).y;   // approx (no tilt)
    const h = dt / o.substeps, maxD = this.r * o.maxStretch;
    let squash = 0, sag = 0;
    for (let st = 0; st < o.substeps; st++) {
      for (let i = 0; i < this.n; i++) {
        const j = i * 3;
        // spring toward rest + gravity, damped
        let ax = (R[j] - p[j]) * k - v[j] * o.damp + this._g.x;
        let ay = (R[j + 1] - p[j + 1]) * k - v[j + 1] * o.damp + this._g.y;
        let az = (R[j + 2] - p[j + 2]) * k - v[j + 2] * o.damp + this._g.z;
        v[j] += ax * h; v[j + 1] += ay * h; v[j + 2] += az * h;
        p[j] += v[j] * h; p[j + 1] += v[j + 1] * h; p[j + 2] += v[j + 2] * h;
        // stay a blob: clamp stretch from the rest point
        const dx = p[j] - R[j], dy = p[j + 1] - R[j + 1], dz = p[j + 2] - R[j + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d > maxD) { const f = maxD / d; p[j] = R[j] + dx * f; p[j + 1] = R[j + 1] + dy * f; p[j + 2] = R[j + 2] + dz * f; }
        // collide with the hand joint spheres: push out, kill inward velocity, friction
        for (const l of local) {
          const ox = p[j] - l.x, oy = p[j + 1] - l.y, oz = p[j + 2] - l.z;
          const dd = Math.hypot(ox, oy, oz);
          if (dd < l.r && dd > 1e-6) {
            const nx = ox / dd, ny = oy / dd, nz = oz / dd, pen = l.r - dd;
            p[j] += nx * pen; p[j + 1] += ny * pen; p[j + 2] += nz * pen;
            const vn = v[j] * nx + v[j + 1] * ny + v[j + 2] * nz;
            if (vn < 0) { v[j] -= vn * nx; v[j + 1] -= vn * ny; v[j + 2] -= vn * nz; }
            v[j] *= (1 - o.friction * h * 30); v[j + 2] *= (1 - o.friction * h * 30);
            if (pen > squash) squash = pen;
          }
        }
        if (floorLocal !== null && p[j + 1] < floorLocal) { p[j + 1] = floorLocal; if (v[j + 1] < 0) v[j + 1] = 0; v[j] *= 0.9; v[j + 2] *= 0.9; }
      }
    }
    for (let i = 0; i < this.n; i++) {
      const j = i * 3; P[j] = p[j]; P[j + 1] = p[j + 1]; P[j + 2] = p[j + 2];
      const drop = R[j + 1] - p[j + 1]; if (R[j + 1] < -this.r * 0.7 && drop > sag) sag = drop;   // bottom cap sag
      if (s < 0.05) { const dent = Math.hypot(R[j] - p[j], R[j + 1] - p[j + 1], R[j + 2] - p[j + 2]); if (dent > squash) squash = dent; }
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
    return { squash, sag };
  }
}
