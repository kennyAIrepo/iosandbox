/**
 * hopeOS SDK — Hand Views
 * ═══════════════════════════════════════════════════════════════
 * THE single source of truth for how tracked hands map into the 3D
 * scene per view mode. Every mirror/flip decision in the engine
 * lives here and nowhere else.
 *
 * ROUTING IS LABEL-FREE (this is the fix for "hands crossed").
 * MediaPipe's Left/Right handedness labels are unreliable on many
 * cameras, and anything keyed off them (which mesh, which side)
 * crosses over the moment a label is wrong. So nothing here uses
 * labels:
 *
 *   • WHICH MESH (chirality) is MEASURED from the landmark cloud
 *     itself — the signed volume of the rigid palm-block tetrahedron
 *     (wrist, index MCP, pinky MCP, thumb base) has opposite signs
 *     for left/right hands, in any pose.
 *
 *     NAMING PITFALL (do not "fix" this): REST_R42 is stored in
 *     MIRRORED screen space — mesh 'R' is the shape a physical RIGHT
 *     hand presents IN THE MIRROR (geometrically left-chirality).
 *     So: mirror mode → right hand drives mesh 'R' (as it always
 *     visually did); POV modes (un-mirrored) → right hand drives
 *     mesh 'L'. The measurement below encodes exactly this, keyed to
 *     REST_R42's own measured sign — no anatomical labels anywhere.
 *
 *   • WHICH SIDE (screen slot) comes from where the wrist actually
 *     is on screen: hands are sorted by x and assigned to preset
 *     left/right anchor slots, each clamped to its own half of the
 *     view — two hands can NEVER render crossed.
 *
 * POV modes are PRESET-DRIVEN (predictive): live landmarks supply
 * bone DIRECTIONS only; bone LENGTHS come from the rig's own rest
 * skeleton (FK retarget). Proportions are always the mesh's own,
 * morphs stay smooth (no per-bone stretch mush), and the hand is
 * placed at a realistic preset size/position for the scene.
 *
 * Input convention (what sdk/core/tracking.js emits):
 *   img landmarks are SELFIE-MIRRORED normalized coords (x = 1 − raw);
 *   world landmarks are RAW MediaPipe metric 3D (camera-view axes).
 *
 * Output of resolve(): { R, L, hands:[{mesh, slot, points}] } —
 * R/L keyed by MESH chirality (which HoloHandRig to drive), world
 * space; `hands` carries slot metadata for game logic.
 */

import * as THREE from 'three';
import { REST_R42 } from './hands.js';

// ── Preset skeleton (rest proportions) for the POV FK retarget ──
// 20 bones, parent-first: thumb chain, then metacarpal + phalanges per finger.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
];
const REST_LEN = BONES.map(([i, j]) => Math.hypot(
  REST_R42[j][0] - REST_R42[i][0], REST_R42[j][1] - REST_R42[i][1], REST_R42[j][2] - REST_R42[i][2]));
const REST_SPAN = REST_LEN[8] + 0;   // wrist→middle-MCP (bone [0,9])

// Anatomical joint limits (radians): max deviation of a bone from its
// PARENT bone's direction. When a fist self-occludes, MediaPipe's world
// landmarks can fold fingers THROUGH the palm — a real finger can't, so
// the preset skeleton refuses too (predictive model: live data triggers
// motion, anatomy bounds it). Indexed by bone position in its chain
// (0 = metacarpal, unclamped).
const MAX_BEND = BONES.map((_, b) => {
  const pos = b % 4;
  if (b < 4) return [0, 0.9, 0.95, 1.35][pos];   // thumb: CMC→MP→IP
  return [0, 1.62, 1.95, 1.45][pos];             // fingers: MCP, PIP, DIP
});
const COS_MAX = MAX_BEND.map(a => Math.cos(a));

// Chirality measurement. The tetrahedron must be built from POSE-RIGID
// points or its sign flips with finger motion (a thumb-TIP tetrahedron
// reads differently for a thumb-up vs thumb-out pose of the SAME hand).
// Wrist + index MCP + pinky MCP + thumb CMC/MCP are all part of the rigid
// palm block, and the thumb base is anatomically always on the index side
// — their signed volumes are a rotation- and pose-invariant chirality cue.
function signedVol(p0, p5, p17, pX) {
  const ax = p5.x - p0.x, ay = p5.y - p0.y, az = p5.z - p0.z;
  const bx = p17.x - p0.x, by = p17.y - p0.y, bz = p17.z - p0.z;
  const cx = pX.x - p0.x, cy = pX.y - p0.y, cz = pX.z - p0.z;
  return (ay * bz - az * by) * cx + (az * bx - ax * bz) * cy + (ax * by - ay * bx) * cz;
}
function chirVol(P) {
  return signedVol(P(0), P(5), P(17), P(1)) + signedVol(P(0), P(5), P(17), P(2));
}
const _rv = (i) => ({ x: REST_R42[i][0], y: REST_R42[i][1], z: REST_R42[i][2] });
const RIGHT_SIGN = Math.sign(chirVol(_rv));

const VIEW_DEFAULTS = {
  // mirror mode: plane distance in front of the camera + working span
  mirrorDist: 2.0,
  mirrorDepth: 1.0,        // landmark z → ray depth, in x-normalized units (see mirrorPoint)
  // Cover-fit correction: when the mirrored video backdrop is object-fit:cover
  // it crops the frame, but landmarks are normalized to the FULL frame — a
  // constant misprojection unless divided out (HOPEOS_ENGINE_BRIEF §5 scene.js).
  // Set to the visible fraction of the video: x = min(1, screenAspect/videoAspect),
  // y = min(1, videoAspect/screenAspect).
  cover: { x: 1, y: 1 },

  // Vertical hand-height offset (metres) for POV modes — raise/lower where
  // the hands sit on screen so any screen+camera setup can be tuned to a
  // comfortable level (see handlab HAND HEIGHT slider). Applied to the POV
  // anchor's vertical axis (screen-up in first-person, world-up in third),
  // and the BEAT RUSH note plane is shifted by the SAME amount so notes keep
  // arriving exactly where the hands are drawn. Mirror mode ignores it (there
  // the mesh must stay glued to your real hand in the video).
  yOffset: 0,

  // first-person anchoring (camera-local metres, −Z forward). PRESET slots:
  // each hand lives in its own half of the view and can never cross over.
  fpForward: -0.50,
  fpDown: -0.22,
  fpSide: 0.16,            // preset lateral offset per slot
  fpScale: 1.15,           // fallback path: metres per normalized-landmark unit
  fpDepth: 0.55,           // fallback path: how much image z reaches into the scene
  fpTilt: 0.45,            // lift fingers up+forward (natural FPS pose)
  fpFollow: 0.55,          // 0..1 — wrist screen position steers within the slot
  fpClamp: [0.05, 0.40],   // slot lateral range (min/max from centre) — no crossing
  // Realistic preset hand size for POV: rest-skeleton units → scene metres.
  // Rest span (wrist→middle MCP) ≈ 0.34 units; ×0.6 ≈ 0.20 m — a natural
  // FPS hand at half-arm distance (the old metric-cloud path rendered giants).
  povHandScale: 0.6,

  // third-person anchoring (avatar-local metres, avatar faces −Z at yaw 0)
  tpForward: -0.42,
  tpUp: 1.28,              // chest height
  tpSide: 0.20,
  tpScale: 0.9,            // fallback path scale
  tpFollow: 0.6,
  tpHandScale: 0.5,
};

export class HandViews {
  constructor(opts = {}) {
    this.cfg = { ...VIEW_DEFAULTS, ...opts };
    this.cfg.cover = { ...this.cfg.cover };   // own copy — mutated per video size
    this.mode = opts.mode || 'mirror';
    // avatar anchor for thirdPerson: { position: Vector3, yaw: number }
    this.avatar = opts.avatar || { position: new THREE.Vector3(), yaw: 0 };

    // Preallocated output buffers (one 21-pack per mesh chirality)
    this._out = { R: this._pack(), L: this._pack() };
    this._fkPts = this._pack();
    this._q = new THREE.Quaternion();
    this._tilt = new THREE.Quaternion();
    this._a = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this.swapSlots = false;   // manual override for exotic camera setups
  }

  _pack() { const a = []; for (let i = 0; i < 21; i++) a.push(new THREE.Vector3()); return a; }

  setMode(m) { this.mode = m; }

  /**
   * MEASURED mesh key for a (selfie-mirrored) image cloud: 'R' | 'L'.
   * Compares the cloud's palm-block signed volume against REST_R42's own —
   * i.e. "does this data have the same chirality as the 'R' rest mesh?"
   * Your physical right hand in the mirrored feed measures 'R' (REST_R42
   * is stored mirror-space); geometry, not MediaPipe's flaky classifier.
   */
  imageChirality(lm) {
    const P = (i) => ({ x: lm[i].x, y: -lm[i].y, z: -(lm[i].z || 0) });
    return Math.sign(chirVol(P)) === RIGHT_SIGN ? 'R' : 'L';
  }

  /**
   * Accumulated chirality per slot: single-frame volumes can be shallow
   * (palm dead-on to the camera → the cue rides on noisy z), so integrate
   * signed evidence with a slow decay (~50-frame window). The sign settles
   * fast, never flickers frame-to-frame, and still self-corrects if the
   * initial frames were misleading.
   */
  _chirality(slot, lm) {
    const acc = this._chiAcc || (this._chiAcc = {});
    let a = acc[slot];
    if (!a) a = acc[slot] = { sum: 0 };
    const P = (i) => ({ x: lm[i].x, y: -lm[i].y, z: -(lm[i].z || 0) });
    a.sum = a.sum * 0.98 + chirVol(P);
    return Math.sign(a.sum) === RIGHT_SIGN ? 'R' : 'L';
  }

  /**
   * Map tracked hands into world space. LABEL-FREE:
   *   mesh   ← measured cloud chirality (mirror: as seen; POV: physical)
   *   slot   ← wrist screen position, sorted → preset left/right anchors
   *
   * @param {Array} handsArr - up to 2 of { img, world } where
   *   img   = 21 normalized SELFIE-MIRRORED image landmarks ({x,y,z})
   *   world = 21 raw MediaPipe worldLandmarks (metres) or null
   * @param {THREE.Camera} camera - current view camera (matrixWorld current).
   * @returns {{R, L, hands: [{mesh, slot, points}]}} — R/L keyed by mesh chirality.
   */
  resolve(handsArr, camera) {
    const res = { R: null, L: null, hands: [] };
    const list = (handsArr || []).filter(h => h && h.img);
    list.sort((a, b) => a.img[0].x - b.img[0].x);   // screen left → right
    for (let k = 0; k < list.length && k < 2; k++) {
      const h = list[k];
      let slot = list.length === 1
        ? (h.img[0].x >= 0.5 ? 'right' : 'left')
        : (k === 0 ? 'left' : 'right');
      if (this.swapSlots) slot = slot === 'left' ? 'right' : 'left';
      const imgChi = this._chirality(slot, h.img);   // latched measurement, no flicker
      const mesh = this.mode === 'mirror' ? imgChi : (imgChi === 'R' ? 'L' : 'R');
      const key = res[mesh] ? (mesh === 'R' ? 'L' : 'R') : mesh;   // both hands, one chirality → borrow
      const out = this._out[key];
      if (this.mode === 'mirror') this._mirror(h.img, camera, out);
      else if (this.mode === 'firstPerson') this._povHand(h, slot, key, camera, null, out);
      else this._povHand(h, slot, key, null, this.avatar, out);
      res[key] = out;
      res.hands.push({ mesh: key, slot, points: out, img: h.img });
    }
    return res;
  }

  /**
   * MIRROR — hands live on a camera-facing plane sized to the view frustum
   * at mirrorDist, exactly matching the mirrored camera feed behind them.
   * Data stays mirrored (left-chirality for the right hand) → routed to the
   * opposite-chirality mesh by chiralityFor(); no axis surgery, no twist.
   */
  _mirror(lm, camera, out) {
    for (let i = 0; i < 21; i++) this.mirrorPoint(lm[i], camera, out[i]);
  }

  /**
   * Map ONE normalized (selfie-mirrored) landmark onto the mirror view.
   *
   * RAY-BASED: MediaPipe x/y ARE the on-screen projection of the real hand,
   * so the 3D point must sit ON the camera ray through that pixel — we slide
   * it along the ray by its depth. Placing x/y on a fixed plane and offsetting
   * z separately (the old way) re-projects to a DIFFERENT pixel, which showed
   * up as a constant outward drift of the mesh fingers vs the video hand.
   */
  mirrorPoint(p, camera, out) {
    const d = this.cfg.mirrorDist, cov = this.cfg.cover;
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * d;
    const sH = halfH * 2, sW = sH * camera.aspect;
    // Depth scales with sW: MediaPipe z is normalized like x (image WIDTH).
    // Scaling by sH compressed depth ~2× on wide screens, which flattened
    // any finger bending toward the camera into a thin pancake.
    const depth = d + (p.z || 0) * sW * this.cfg.mirrorDepth;   // z<0 → closer
    const s = depth / d;                                        // stay on the pixel ray
    return out.set(
      (p.x - 0.5) * sW / (cov.x || 1) * s,
      -(p.y - 0.5) * sH / (cov.y || 1) * s,
      -depth
    ).applyMatrix4(camera.matrixWorld);
  }

  /**
   * FIRST/THIRD PERSON — PREDICTIVE POV RECONSTRUCTION.
   *
   * The webcam sees your hand from the FRONT; your eyes see it from the
   * BACK. So POV modes cannot reuse the camera image geometry — they must
   * re-render the hand's true 3D pose from the opposite viewpoint:
   *
   *   1. SHAPE comes from MediaPipe worldLandmarks — genuine metric 3D,
   *      viewpoint-independent (the "prediction model": landmarks drive the
   *      bone morph, the mesh supplies what the camera can't see).
   *   2. Chirality is SELF-CALIBRATED per hand: fit the world cloud to the
   *      image cloud (cross-covariance determinant); a negative det means
   *      the z convention is flipped for this build/device → flip once and
   *      latch. No reliance on MediaPipe axis docs or handedness labels.
   *   3. Viewpoint retarget = rotate 180° about the vertical axis (camera
   *      and eyes face each other): image-right ↔ eye-left, toward-camera ↔
   *      away-from-eye. A PROPER rotation — the pose can never be mirrored.
   *      Palm faces the camera → you see the back of your hand. ✓
   *   4. POSITION (where in view) comes from the mirrored image wrist, so
   *      your right hand stays on your right, exactly where you hold it.
   *
   * Falls back to the old image-space transform when worldLandmarks are
   * missing.
   */
  _povHand(h, slot, meshKey, camera, avatar, out) {
    const S = this.cfg;
    const first = !avatar;
    const img = h.img, world = h.world;
    const w = img[0];
    const sign = slot === 'right' ? 1 : -1;

    // ── PRESET slot anchor, steered by the wrist but CLAMPED to its own
    // half of the view — two hands can never render crossed. ──
    const follow = first ? S.fpFollow : S.tpFollow;
    let ax = sign * (first ? S.fpSide : S.tpSide) + (w.x - 0.5) * follow;
    const [lo, hi] = S.fpClamp;
    ax = sign > 0 ? Math.min(hi, Math.max(lo, ax)) : Math.max(-hi, Math.min(-lo, ax));
    if (first) {
      // yOffset in camera-local Y == straight up the screen (screen-vertical
      // IS the camera's local up), independent of the camera's pitch.
      this._a.set(ax, S.fpDown + S.yOffset - (w.y - 0.5) * follow * 0.85, S.fpForward);
    } else {
      this._q.setFromAxisAngle(_Y_AXIS, avatar.yaw);
      // yaw is about Y, so the vertical component survives the rotation.
      this._a.set(ax, S.tpUp + S.yOffset - (w.y - 0.5) * follow * 0.8, S.tpForward)
        .applyQuaternion(this._q).add(avatar.position);
    }
    // Reach tilt applies ONLY to the image-space fallback (which has no real
    // orientation). The FK path IS the hand's true orientation — a preset
    // tilt there meant "point your hand up, mesh still pitches forward".
    const hasWorld = world && world.length === 21;
    this._tilt.setFromAxisAngle(_X_AXIS, hasWorld ? 0 : -S.fpTilt * (first ? 1 : 0.6));

    if (hasWorld) {
      // ── PRESET-SKELETON FK RETARGET (the predictive morph) ──
      // Live landmarks contribute bone DIRECTIONS only; bone LENGTHS are the
      // rig's rest skeleton. Proportions stay the mesh's own (no giant palms,
      // no per-bone stretch mush from noisy metric estimates), and the pose
      // morph is smooth by construction.
      const zs = this._zSign(slot, meshKey, world);
      const hs = first ? S.povHandScale : S.tpHandScale;
      const p = this._fkPts;
      const D = this._fkDir || (this._fkDir = new Float32Array(63));   // unit bone dir ending at joint j
      p[0].set(0, 0, 0);
      for (let b = 0; b < BONES.length; b++) {
        const [i, j] = BONES[b];
        // camera-axes Δ → eye view: conv (x,−y,−z·zs) then Ry(π) ⇒ (−Δx, −(−Δy)…)
        let dx = -(world[j].x - world[i].x);
        let dy = -(world[j].y - world[i].y);
        let dz = (world[j].z - world[i].z) * zs;
        let len = Math.hypot(dx, dy, dz);
        if (len > 1e-6) {
          dx /= len; dy /= len; dz /= len;
        } else {
          // degenerate frame (never happens on real hands) — hold rest dir
          const m = meshKey === 'L' ? -1 : 1;
          dx = (REST_R42[j][0] - REST_R42[i][0]) * m;
          dy = REST_R42[j][1] - REST_R42[i][1];
          dz = REST_R42[j][2] - REST_R42[i][2];
          len = Math.hypot(dx, dy, dz) || 1;
          dx /= len; dy /= len; dz /= len;
        }
        // ── ANATOMICAL CLAMP: a joint cannot bend past its real range, so
        // occlusion-garbage tracking can never fold fingers through the palm.
        if (b % 4 !== 0) {
          const i3 = i * 3;
          const px = D[i3], py = D[i3 + 1], pz = D[i3 + 2];
          const c = dx * px + dy * py + dz * pz;
          if (c < COS_MAX[b]) {
            // rotate back to the cone edge around the parent direction
            let ex = dx - px * c, ey = dy - py * c, ez = dz - pz * c;
            const el = Math.hypot(ex, ey, ez);
            if (el > 1e-6) {
              const ca = COS_MAX[b], sa = Math.sin(MAX_BEND[b]);
              ex /= el; ey /= el; ez /= el;
              dx = px * ca + ex * sa; dy = py * ca + ey * sa; dz = pz * ca + ez * sa;
            } else { dx = px; dy = py; dz = pz; }
          }
        }
        const j3 = j * 3;
        D[j3] = dx; D[j3 + 1] = dy; D[j3 + 2] = dz;
        const s = REST_LEN[b] * hs;
        p[j].set(p[i].x + dx * s, p[i].y + dy * s, p[i].z + dz * s);
      }
      for (let i = 0; i < 21; i++) out[i].copy(p[i]);
    } else {
      // ── fallback: image-space approximation (no worldLandmarks) ──
      const scale = first ? S.fpScale : S.tpScale;
      for (let i = 0; i < 21; i++) {
        out[i].set(
          (img[i].x - w.x) * scale,
          -(img[i].y - w.y) * scale,
          -((img[i].z || 0) - (w.z || 0)) * scale * S.fpDepth
        );
      }
    }

    // Common: reach tilt, anchor, then into the world.
    for (let i = 0; i < 21; i++) {
      out[i].applyQuaternion(this._tilt);
      if (first) out[i].add(this._a).applyQuaternion(camera.quaternion).add(camera.position);
      else out[i].applyQuaternion(this._q).add(this._a);
    }
  }

  /**
   * Z-convention calibration for worldLandmarks. The world cloud converted
   * with (x, −y, −z·zs) must have the hand's PHYSICAL chirality — which in
   * POV modes is exactly the mesh it drives (meshKey). Measure the cloud's
   * palm-block volume, accumulated with a decay window (single frames are
   * unreliable when a fist self-occludes — a one-shot latch here once locked
   * a hand permanently palm-out), and pick zs to make the signs agree.
   * Self-correcting: bad entry frames get outvoted within ~a second.
   */
  _zSign(slot, meshKey, world) {
    const acc = this._zAcc || (this._zAcc = {});
    let a = acc[slot];
    if (!a) a = acc[slot] = { sum: 0, zs: 1 };
    const P = (i) => ({ x: world[i].x, y: -world[i].y, z: -world[i].z });
    a.sum = a.sum * 0.98 + chirVol(P);
    const expected = meshKey === 'R' ? RIGHT_SIGN : -RIGHT_SIGN;
    // significant evidence → set; near-zero → hold previous (no flicker)
    if (Math.abs(a.sum) > 1e-9) a.zs = Math.sign(a.sum) === expected ? 1 : -1;
    return a.zs;
  }

  /** Call when a slot's hand is lost so calibration re-runs on re-entry. */
  dropSlot(key) {
    if (this._zAcc) delete this._zAcc[key];
    if (this._chiAcc) delete this._chiAcc[key];
  }
  dropSide(key) { this.dropSlot(key); }   // legacy alias

  /** Rough center of the hand workspace (for spawning game objects). */
  workspaceCenter(camera, out) {
    out = out || new THREE.Vector3();
    if (this.mode === 'mirror') {
      return out.set(0, 0, -this.cfg.mirrorDist).applyMatrix4(camera.matrixWorld);
    }
    if (this.mode === 'firstPerson') {
      return out.set(0, this.cfg.fpDown * 0.5, this.cfg.fpForward - 0.25)
        .applyQuaternion(camera.quaternion).add(camera.position);
    }
    this._q.setFromAxisAngle(_Y_AXIS, this.avatar.yaw);
    return out.set(0, this.cfg.tpUp, this.cfg.tpForward - 0.3)
      .applyQuaternion(this._q).add(this.avatar.position);
  }
}

const _X_AXIS = new THREE.Vector3(1, 0, 0);
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
