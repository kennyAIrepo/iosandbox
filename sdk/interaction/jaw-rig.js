/**
 * hopeOS SDK — Runtime Jaw Rig + Procedural Strike Tongue
 * ═══════════════════════════════════════════════════════════════
 * ENGINE-SIDE rigging: no Blender round-trip. Give it a loaded GLB whose
 * skinned head is one rigid piece (head/headend joints, no jaw) and it:
 *
 *   1. DETECTS the lower-jaw region in BIND space (the geometry attribute
 *      positions ARE the bind pose — no world math, no pose dependency):
 *      verts skinned to head/headend, inside the snout span, below the
 *      skull axis, with a smooth falloff band so the seam doesn't tear.
 *   2. INJECTS a runtime THREE.Bone ('jaw') as a child of the head bone,
 *      rebuilds the Skeleton (bones + boneInverses + bind), and REWRITES
 *      skinIndex/skinWeight for the detected verts — migrating weight
 *      from head/headend to the jaw with the falloff fraction.
 *   3. DECOUPLED ANIMATION: the authored clip has no tracks for 'jaw',
 *      so the AnimationMixer never touches it — the crawl cycle plays
 *      underneath while setOpen() drives the jaw on top. Same pattern
 *      for the tongue socket (child of jaw).
 *
 * The TONGUE: this model has no tongue geometry (island-scan confirmed),
 * so the tongue is PROCEDURAL — a tapered tube rebuilt from a curve each
 * frame, attached to the jaw's mouth socket:
 *      poke(amount)      — user tongue partially out (red-ratio channel)
 *      strike(targetPos) — shoot to a world point (~120ms out, 180ms back)
 * Straight when striking (curve tightens to a line), droops on a slow poke.
 */

import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class RuntimeJawRig {
  constructor(opts = {}) {
    this.opts = {
      headName: 'head', snoutName: 'headend',
      maxOpenDeg: 26,
      // detection band, in snout-lengths (validated on lizardwalking.glb:
      // same fractions selected 2.6k lower-jaw verts of the 132k mesh)
      tMin: 0.02, tMax: 1.15, dStart: 0.04, dFull: 0.16,
      minWeight: 0.05,
      ...opts
    };
    this.jaw = null;
    this.socket = null;       // mouth-interior anchor for the tongue
    this.stats = null;
    this._axisLocal = new THREE.Vector3(1, 0, 0);
    this._q = new THREE.Quaternion();
  }

  /** Rig a loaded GLB scene in place. Call BEFORE the first mixer.update. */
  rig(root) {
    const o = this.opts;
    let sk = null;
    root.traverse(n => {
      if (n.isSkinnedMesh &&
          (!sk || n.geometry.attributes.position.count > sk.geometry.attributes.position.count)) sk = n;
    });
    if (!sk) return null;
    const skel = sk.skeleton;
    const headIdx = skel.bones.findIndex(b => b.name === o.headName);
    const snoutIdx = skel.bones.findIndex(b => b.name === o.snoutName);
    if (headIdx < 0) return null;

    // bind-space bone positions from the inverse bind matrices
    const bindOf = i => new THREE.Vector3()
      .setFromMatrixPosition(new THREE.Matrix4().copy(skel.boneInverses[i]).invert());
    const h = bindOf(headIdx);
    const he = snoutIdx >= 0 ? bindOf(snoutIdx) : h.clone().add(new THREE.Vector3(0, 0, 1));
    const axis = he.clone().sub(h);
    const snout = Math.max(axis.length(), 1e-6);
    axis.normalize();
    let down = new THREE.Vector3(0, -1, 0);           // glTF bind space is y-up
    down.addScaledVector(axis, -down.dot(axis)).normalize();
    const lat = axis.clone().cross(down).normalize();

    // ── detect + migrate weights (bind space, pure attribute math) ──
    const pos = sk.geometry.attributes.position;
    const sIdx = sk.geometry.attributes.skinIndex;
    const sWt = sk.geometry.attributes.skinWeight;
    const jawIdx = skel.bones.length;                  // the index the new bone will take
    const rel = new THREE.Vector3();
    let selected = 0, moved = 0;
    for (let v = 0; v < pos.count; v++) {
      let wHead = 0;
      for (let k = 0; k < 4; k++) {
        const bi = sIdx.getComponent(v, k);
        if (bi === headIdx || bi === snoutIdx) wHead += sWt.getComponent(v, k);
      }
      if (wHead < o.minWeight) continue;
      rel.fromBufferAttribute(pos, v).sub(h);
      const t = rel.dot(axis);
      if (t < o.tMin * snout || t > o.tMax * snout) continue;
      const d = rel.dot(down);
      if (d <= o.dStart * snout) continue;
      const f = clamp((d - o.dStart * snout) / ((o.dFull - o.dStart) * snout), 0, 1);

      // move f of the head/headend weight into one slot pointed at the jaw:
      // shrink head slots by (1-f), then claim the smallest slot for the jaw
      let jawW = 0;
      for (let k = 0; k < 4; k++) {
        const bi = sIdx.getComponent(v, k);
        if (bi === headIdx || bi === snoutIdx) {
          const w = sWt.getComponent(v, k);
          jawW += w * f;
          sWt.setComponent(v, k, w * (1 - f));
        }
      }
      let slot = 0, slotW = Infinity;
      for (let k = 0; k < 4; k++) {
        const w = sWt.getComponent(v, k);
        if (w < slotW) { slotW = w; slot = k; }
      }
      sIdx.setComponent(v, slot, jawIdx);
      sWt.setComponent(v, slot, sWt.getComponent(v, slot) + jawW);
      selected++; moved += jawW;
    }
    sIdx.needsUpdate = true;
    sWt.needsUpdate = true;

    // ── inject the bone + rebuild the skeleton ──
    const headBone = skel.bones[headIdx];
    const jaw = new THREE.Bone();
    jaw.name = 'jaw';
    // hinge just below/forward of the skull pivot (bind space → head-local)
    const hingeBind = h.clone().addScaledVector(axis, 0.12 * snout).addScaledVector(down, 0.08 * snout);
    const headBindInv = skel.boneInverses[headIdx];
    jaw.position.copy(hingeBind.applyMatrix4(headBindInv));   // head-local
    headBone.add(jaw);
    // tongue socket a bit deeper in the mouth, on the jaw
    this.socket = new THREE.Object3D();
    this.socket.name = 'tongueSocket';
    this.socket.position.copy(
      h.clone().addScaledVector(axis, 0.45 * snout).addScaledVector(down, 0.10 * snout)
        .applyMatrix4(headBindInv)).sub(jaw.position);
    jaw.add(this.socket);

    jaw.updateMatrixWorld(true);
    const jawInverse = new THREE.Matrix4().copy(jaw.matrixWorld).invert()
      .multiply(sk.matrixWorld);   // consistent with how three builds boneInverses
    sk.bind(new THREE.Skeleton([...skel.bones, jaw], [...skel.boneInverses, jawInverse]),
            sk.bindMatrix);

    // hinge axis in jaw-local space = the bind lateral axis carried into head-local
    this._axisLocal.copy(lat).transformDirection(headBindInv).normalize();
    this._rest = jaw.quaternion.clone();
    this.jaw = jaw;
    this.stats = { selected, moved: +moved.toFixed(1), snout, headIdx, jawIdx };
    return this;
  }

  /** amount 0..1 → jaw opens (call every frame AFTER mixer.update) */
  setOpen(amount) {
    if (!this.jaw) return;
    this.jaw.quaternion.copy(this._rest).multiply(
      this._q.setFromAxisAngle(this._axisLocal,
        clamp(amount, 0, 1) * this.opts.maxOpenDeg * Math.PI / 180));
  }
}

/* ─────────────────────────────────────────────────────────────── */

export class ProceduralTongue {
  /** @param {THREE.Object3D} parentScene  scene (tube lives in world space)
   *  @param {THREE.Object3D} socket       mouth anchor (RuntimeJawRig.socket) */
  constructor(parentScene, socket, opts = {}) {
    this.opts = { color: 0xd6455f, pokeLen: 0.16, radius: 0.016,
                  outMs: 120, backMs: 180, ...opts };
    this.socket = socket;
    this.mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 8, 8),      // placeholder, rebuilt per frame
      new THREE.MeshStandardMaterial({ color: this.opts.color, roughness: 0.35 }));
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    parentScene.add(this.mesh);
    this._poke = 0;
    this._strike = null;        // { target, t0 }
    this._from = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /** continuous partial protrusion 0..1 (user tongue red-ratio channel) */
  poke(amount) { this._poke = clamp(amount, 0, 1); }

  /** shoot to a world-space point; straight line out, then retract */
  strike(targetWorld) { this._strike = { target: targetWorld.clone(), t0: performance.now() }; }

  get striking() { return !!this._strike; }

  update() {
    if (!this.socket) return;
    this.socket.getWorldPosition(this._from);
    this.socket.getWorldDirection(this._fwd);          // socket +z ≈ out of the mouth

    let tip = null, sag = 0, radiusK = 1;
    if (this._strike) {
      const o = this.opts;
      const el = performance.now() - this._strike.t0;
      const k = el < o.outMs ? el / o.outMs
        : el < o.outMs + o.backMs ? 1 - (el - o.outMs) / o.backMs
        : null;
      if (k === null) this._strike = null;
      else {
        // STRAIGHT when striking: pure lerp to the target, no droop
        tip = this._from.clone().lerp(this._strike.target, k * k * (3 - 2 * k));
        radiusK = 0.8;
      }
    }
    if (!tip && this._poke > 0.05) {
      tip = this._from.clone().addScaledVector(this._fwd, this._poke * this.opts.pokeLen);
      sag = this._poke * this.opts.pokeLen * 0.35;     // relaxed tongue droops
    }
    if (!tip) { this.mesh.visible = false; return; }

    const mid = this._from.clone().lerp(tip, 0.55);
    mid.y -= sag;
    const curve = new THREE.CatmullRomCurve3([this._from, mid, tip]);
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(
      curve, 10, this.opts.radius * radiusK, 6, false);
    this.mesh.visible = true;
  }
}
