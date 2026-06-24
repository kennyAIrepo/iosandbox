/**
 * hopeOS SDK — Asset Manipulator (world-space hand grab)
 * ═══════════════════════════════════════════════════════════════
 * Makes EVERY L5 asset (imported GLBs, primitives) grabbable, movable and
 * scalable with the bare holo-hands — the exact same feel as the basketball
 * in the AR scene, ported to the navigable world:
 *
 *   • TWO-HAND PINCH on/near an object → move it to the midpoint between the
 *     hands and scale it by how far you spread/close them (pinch-zoom an object).
 *   • ONE-HAND PROXIMITY GRAB → close your hand around an object and it sticks
 *     to your palm (palm-follow); open / pull away to let go.
 *
 * It reads the SAME world-space hand landmarks that drive the holo-hand mesh
 * (EmbodimentManager.resolveHands → {right,left}), so the grab volume lines up
 * exactly with what the user sees. Each transform re-syncs the Rapier collider
 * through WorldTemplate, so a grabbed/scaled object stays solid and walkable.
 *
 *   import { AssetManipulator } from './sdk/world/asset-grab.js';
 *   const manip = new AssetManipulator(world, { onSay });
 *   // each frame, in PLAY mode, after embody.resolveHands():
 *   manip.update({ right, left }, dt);
 */
import * as THREE from 'three';
import { palmCenter, pinchPoint } from '../interaction/grab.js';

const DEFAULTS = {
  pinchDist:  0.05,   // metres between thumb+index tip → counts as a pinch (world space)
  reach:      0.12,   // fingertips must be within this of the object SURFACE to grab —
                      // real arm-length scale: you have to walk up and actually touch it
  minTouch:   3,      // fingertips that must be touching to start a one-hand grab
  releaseAdd: 0.25,   // let go once the palm pulls this far past the surface
  scaleMin:   0.1,
  scaleMax:   8.0,
};

// fingertips + wrist — the parts that realistically make contact
const TIPS = [4, 8, 12, 16, 20, 0];

// thumb-tip(4) ↔ index-tip(8) distance in metres
function isPinchW(lm, dist) { return lm[4].distanceTo(lm[8]) < dist; }

export class AssetManipulator {
  constructor(world, opts = {}) {
    this.world = world;
    this.cfg = { ...DEFAULTS, ...opts };
    this.onSay = opts.onSay || (() => {});
    this.enabled = true;

    this.held = null;     // one-hand grab: { id, side, offset:Vector3, radius }
    this.twoHand = null;  // two-hand size: { id, startDist, startScale }
    this._box = new THREE.Box3();
  }

  /** World-space bounding sphere of an asset's mesh (recomputed live — scale-safe). */
  _sphere(a) {
    this._box.setFromObject(a.mesh);
    const center = this._box.getCenter(new THREE.Vector3());
    const radius = this._box.getSize(new THREE.Vector3()).length() * 0.5 || 0.3;
    return { center, radius };
  }

  /** Count fingertips within `reach` of the object's SURFACE (sphere shell). */
  _touch(lm, s, reach) {
    let n = 0;
    for (const i of TIPS) if (lm[i].distanceTo(s.center) - s.radius < reach) n++;
    return n;
  }

  /** Nearest asset whose SURFACE is within reach of `point` (null if none — you
   *  must physically be next to it; nothing grabs from across the room). */
  _pick(point, reach) {
    let best = null, bestD = Infinity;
    for (const a of this.world.assets) {
      if (a.locked) continue;                                    // locked objects can't be hand-grabbed
      const s = this._sphere(a);
      const surfD = point.distanceTo(s.center) - s.radius;       // <0 = inside the object
      if (surfD < reach && surfD < bestD) { best = { a, s }; bestD = surfD; }
    }
    return best;
  }

  /**
   * @param {{right:THREE.Vector3[]|null, left:THREE.Vector3[]|null}} hands
   *        world-space landmark arrays (from EmbodimentManager.resolveHands)
   */
  update(hands, dt) {
    if (!this.enabled || !this.world) return;

    const list = [];
    if (hands && hands.right) list.push({ side: 'R', lm: hands.right });
    if (hands && hands.left)  list.push({ side: 'L', lm: hands.left });
    for (const h of list) {
      h.palm = palmCenter(h.lm);
      h.pinch = isPinchW(h.lm, this.cfg.pinchDist);
      h.pinchPt = pinchPoint(h.lm);
    }

    // ── TWO-HAND PINCH: move to midpoint + scale by spread (basketball-style) ──
    if (list.length === 2 && list[0].pinch && list[1].pinch) {
      const mid = list[0].pinchPt.clone().add(list[1].pinchPt).multiplyScalar(0.5);
      const dist = list[0].pinchPt.distanceTo(list[1].pinchPt);
      if (!this.twoHand) {
        // both pinch points must straddle the object — i.e. you're holding it, up close
        const pick = this._pick(mid, this.cfg.reach + 0.15);
        if (pick) { this.twoHand = { id: pick.a.id, startDist: Math.max(dist, 1e-3), startScale: pick.a.mesh.scale.x }; this.onSay('sizing ' + pick.a.label); }
      }
      if (this.twoHand) {
        const a = this.world._find(this.twoHand.id);
        if (a) {
          const factor = THREE.MathUtils.clamp(dist / this.twoHand.startDist, 0.15, 12);
          const s = THREE.MathUtils.clamp(this.twoHand.startScale * factor, this.cfg.scaleMin, this.cfg.scaleMax);
          a.mesh.scale.setScalar(s);
          a.mesh.position.copy(mid);
          this.world._syncCollider(a);
        }
        this.held = null;     // two-hand supersedes one-hand
        return;
      }
    } else {
      this.twoHand = null;
    }

    // ── ONE-HAND GRAB: palm-follow an object already held ──
    if (this.held) {
      const h = list.find(x => x.side === this.held.side);
      const a = h && this.world._find(this.held.id);
      if (!h || !a) { this._release(); }
      else {
        const target = h.palm.clone().add(this.held.offset);
        a.mesh.position.lerp(target, 0.6);               // ease toward palm (kills jitter)
        this.world._syncCollider(a);
        // let go when the palm pulls clear of the object surface
        const s = this._sphere(a);
        if (h.palm.distanceTo(s.center) - s.radius > this.cfg.releaseAdd) this._release();
        return;
      }
    }

    // ── ONE-HAND GRAB: start one only when fingertips are actually ON the object ──
    for (const h of list) {
      const pick = this._pick(h.palm, this.cfg.reach);
      if (!pick) continue;
      if (this._touch(h.lm, pick.s, this.cfg.reach) >= this.cfg.minTouch) {
        this.held = { id: pick.a.id, side: h.side, offset: pick.a.mesh.position.clone().sub(h.palm) };
        this.onSay('holding ' + pick.a.label);
        break;
      }
    }
  }

  _release() { this.held = null; }

  /** True while a hand is actively moving/sizing an object (host can suppress nav). */
  get active() { return !!(this.held || this.twoHand); }
}
