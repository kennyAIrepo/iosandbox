/**
 * sdk/game/prop-body.js — PropBody: a PropBall whose visual is ANY THREE object (a normalised GLB group, a labelled
 * placeholder cube, a procedural catalog mesh) and whose collision shape is ANY PropHull (capsule chain from
 * PropHull.fromObject / buildHull, or an exact sphere). Needed because PropBall assumes one sphere Mesh in dispose()
 * (mesh.geometry / mesh.material) and the executor's colour / glow / resize paths assume material.color / emissive and a
 * SphereGeometry. Nothing in the doctrine lane changes: PropBall.update runs unmodified — wrap / clip / cradle tests and
 * hand support all query `this.hull.begin(this.mesh)`, which is why the hull lives in the wrapper group's local frame
 * (metres, identity at bake time) and follows position, rotation AND scale through matrixWorld.
 *
 *   const body = new PropBody(scene, { radius: built.r, gravity: -5.2, restitution: 0.58, home, floorY, built });
 *   body.setModel(builtFromFetcher)   // hot-swap visuals + hull in place (position, velocity, hold state kept)
 *   body.setRadius(0.06)              // absolute resize: inner model + hull segments scale together
 *   body.setColor('gold'); body.setGlow('gold'); body.setGlow(null); body.dispose()
 *
 * `radius` stays "half the largest dimension": it sizes the GrabbableSphere (floor / bounds integration) and the
 * holohand conform collider; the PropHull is what hands actually touch.
 */
import * as THREE from 'three';
import { PropBall } from './prop-ball.js';
import { PropHull } from '../core/prop-hull.js';

const _c = new THREE.Color();

/** THREE.Color.set() only WARNS on an unknown name (and leaves the colour untouched), so validate the style first:
 *  #hex, rgb()/hsl(), or a CSS colour name. Writes into out and returns true, or returns false. */
export function parseCss(css, out) {
  const s = String(css ?? '').trim().toLowerCase();
  if (!s) return false;
  const named = THREE.Color.NAMES && THREE.Color.NAMES[s] !== undefined;
  if (!(named || /^#[0-9a-f]{3,8}$/.test(s) || /^(rgb|hsl)a?\(/.test(s))) return false;
  try { out.set(s); } catch { return false; }
  return Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b);
}

export class PropBody extends PropBall {
  /**
   * @param {THREE.Scene|null} scene
   * @param {object} opts   PropBall opts (radius, gravity, restitution, home, spawnOffset, floorY, boundsR, onGrab, onRelease)
   *                        plus `built`: { object, inner?, hull?, sphere?, r, color? } from model-fetch.js
   */
  constructor(scene, opts = {}) {
    const built = opts.built || {};
    if (!built.object) throw new Error('PropBody needs built.object');
    super(scene, { ...opts, radius: opts.radius ?? built.r ?? 0.045, mesh: built.object });
    this.inner = built.inner || null;
    this.hull = built.hull || PropHull.sphere(this.radius);
    this.sphereHull = built.sphere !== false;
    this.tier = built.tier || null;
    this.name = built.name || null;
    this.color = built.color || null;
    this._glow = null;
    this.mesh.renderOrder = 30;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(0);
  }

  /** Every material under the visual (arrays flattened). */
  materials() {
    const out = [];
    this.mesh.traverse(m => {
      if (!m.isMesh) return;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) if (mat) out.push(mat);
    });
    return out;
  }

  /** Replace the visual + hull in place. Keeps sphere pos / vel / quat, hold and cradle; re-applies colour and glow. */
  setModel(built) {
    if (!built || !built.object) return false;
    const old = this.mesh, parent = old.parent, next = built.object;
    disposeObject(old);
    old.removeFromParent();
    next.renderOrder = 30; next.frustumCulled = false; next.layers.set(0);
    if (parent) parent.add(next);                                   // the same parent the old visual had (the scene)
    this.mesh = next;
    this.inner = built.inner || null;
    this.hull = built.hull || PropHull.sphere(built.r || this.radius);
    this.sphereHull = built.sphere !== false;
    this.tier = built.tier || this.tier;
    this.name = built.name || this.name;
    if (built.r > 0) this.radius = built.r;
    this.setScale(this.userS);                                    // sphere.radius, collider.radius, mesh.scale
    if (this.sphere.pos.y < this.floorY + this.sphere.radius) this.sphere.pos.y = this.floorY + this.sphere.radius;
    this.mesh.position.copy(this.sphere.pos); this.mesh.quaternion.copy(this.sphere.quat); this.mesh.updateMatrixWorld(true);
    if (this.color && !built.color) this.setColor(this.color); else if (built.color) this.color = built.color;
    if (this._glow) this.setGlow(this._glow);
    return true;
  }

  /** Absolute resize to radius r (half the largest dimension): the inner model and every hull segment scale by r/radius. */
  setRadius(r) {
    if (!(r > 0)) return false;
    const k = r / this.radius;
    if (Math.abs(k - 1) < 1e-9) return true;
    if (this.inner) { this.inner.scale.multiplyScalar(k); this.inner.position.multiplyScalar(k); }
    else this.mesh.children.forEach(ch => { ch.scale.multiplyScalar(k); ch.position.multiplyScalar(k); });
    for (const s of this.hull.segs) { s.a.multiplyScalar(k); s.b.multiplyScalar(k); s.ra *= k; s.rb *= k; }
    this.radius = r;
    this.setScale(this.userS);
    if (this.sphere.pos.y < this.floorY + this.sphere.radius) this.sphere.pos.y = this.floorY + this.sphere.radius;   // a grown prop never starts inside the floor
    this.mesh.position.copy(this.sphere.pos); this.mesh.updateMatrixWorld(true);
    return true;
  }

  /** Tint every material (a textured model is multiplied by the colour). Unknown CSS colours -> false, never thrown. */
  setColor(css) {
    if (!parseCss(css, _c)) return false;
    let n = 0;
    for (const mat of this.materials()) {
      if (!mat.color) continue;
      mat.color.copy(_c);
      mat.userData.baseColor = _c.clone();
      n++;
    }
    if (!n) return false;
    this.color = css;
    if (this._glow) this.setGlow(this._glow);
    return true;
  }

  /** Glow on (css colour) / off (null). Emissive materials use emissive; matcap / unlit ones brighten toward the colour. */
  setGlow(css) {
    let n = 0;
    for (const mat of this.materials()) {
      if (mat.emissive) {
        if (css) { mat.emissive.set(css); mat.emissiveIntensity = 0.8; } else { mat.emissive.set(0x000000); mat.emissiveIntensity = 1; }
        n++;
      } else if (mat.color) {
        const base = mat.userData.baseColor || (mat.userData.baseColor = mat.color.clone());
        if (css) { if (!parseCss(css, _c)) _c.set(0xffffff); mat.color.copy(base).lerp(_c, 0.5).multiplyScalar(1.4); }
        else mat.color.copy(base);
        n++;
      } else if (mat.uniforms && mat.uniforms.uGlow) { mat.uniforms.uGlow.value = css ? 0.6 : 0; n++; }
    }
    this._glow = css || null;
    return n > 0;
  }

  dispose() {
    disposeObject(this.mesh);
    this.mesh.removeFromParent();
  }
}

/** Dispose what the visual owns: geometries unless they are shared with a fetch template, every material, own label maps. */
export function disposeObject(obj) {
  if (!obj) return;
  const shared = !!(obj.userData && obj.userData.shared);
  obj.traverse(m => {
    if (!m.isMesh) return;
    if (!shared && m.geometry && m.geometry.dispose) m.geometry.dispose();
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
      if (!mat) continue;
      if (mat.map && mat.map.userData && mat.map.userData.own && mat.map.dispose) mat.map.dispose();
      if (mat.dispose) mat.dispose();
    }
  });
}
