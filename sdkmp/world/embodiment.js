/**
 * hopeOS SDK — Embodiment Manager
 * ═══════════════════════════════════════════════════════════════
 *
 * Controls HOW the user inhabits the world template. Two modes:
 *
 * ── MODE 1: 'bodyEmbedded' (you SEE yourself in the scene) ──────────
 *   The holo-body skeleton + holo hands are placed into the navigable
 *   3D scene and viewed from a 3rd-person follow camera — "there I am,
 *   standing in the gallery." Optional SAM2 silhouette billboard can
 *   replace the skeleton with the actual segmented body image
 *   (integration hook provided; SAM2 runs as a separate worker).
 *   Tracking + collision + grab all work as in the AR overlay, just
 *   set inside the templated space.
 *
 * ── MODE 2: 'firstPerson' (you ARE the avatar) ─────────────────────
 *   The camera sits at the avatar's eyes. Holo hands float in front,
 *   backs toward camera, extending into the scene — classic VR/FPS.
 *   MediaPipe is selfie-mirrored, so we DOUBLE-mirror: un-flip X and
 *   swap handedness so your real left hand drives the on-screen left
 *   hand in first-person. Hands are predicted holo meshes, never flesh.
 *
 * The holo-hand RENDERING is reused unchanged — we only transform the
 * landmark coordinates we feed into RiggedHand.deform(). That keeps the
 * Fresnel shader, collision-conforming, and grab logic identical.
 */

import * as THREE from 'three';
import { REST_R42, REST_L42 } from '../core/hands.js';

const EMB_DEFAULTS = {
  // First-person hand placement (camera-local metres; −Z = forward)
  fpForward:      -0.46,   // how far in front of the eyes the hands sit
  fpDown:         -0.34,   // sit low in frame and reach up/forward (see reference)
  fpSideSpread:    0.20,   // left/right hand horizontal offset — keeps them apart
  fpHandScale:     1.15,   // metres per unit of normalised landmark span
  fpDepth:         0.4,    // how much real hand depth bends into the scene
  fpReachTilt:     0.5,    // tilt hands so fingers reach up+forward into the scene
  mirrorHands:     false,  // false = natural (your right hand → on-screen right). Flip if reversed.
  restLerp:        0.10,   // ease toward rest pose when a hand is untracked
  trackLerp:       0.55,   // ease tracked hands (kills jitter)

  // Body-embedded follow camera
  followDistance: 2.4,
  followHeight:   1.4,
  followYaw:      0,
};

// 21-point neutral hand shapes (wrist-relative), reused from the SDK rest pose
// so the "always visible" idle hands match the holo mesh exactly.
function restLocalHand(rest42) {
  const w = rest42[0];
  const out = [];
  for (let i = 0; i < 21; i++) {
    out.push(new THREE.Vector3(rest42[i][0] - w[0], rest42[i][1] - w[1], rest42[i][2] - w[2]));
  }
  return out;
}
const REST_LOCAL_R = restLocalHand(REST_R42);
const REST_LOCAL_L = restLocalHand(REST_L42);

export class EmbodimentManager {
  constructor(opts = {}) {
    this.cfg = { ...EMB_DEFAULTS, ...opts };
    this.mode = opts.mode || 'firstPerson';
    this.samProvider = opts.samProvider || null; // optional SAM2 silhouette source

    // Smoothed world-space landmark buffers per side (so hands never pop/jitter)
    this._smooth = { Right: null, Left: null };
  }

  setMode(mode) { this.mode = mode; }

  /**
   * Resolve which holo hands to draw and where, for the current mode.
   * Returns { right, left } — each is an array of 21 world-space Vector3
   * landmarks ready for RiggedHand.deform(), or null to hide that hand.
   *
   * In first-person mode a hand is drawn ONLY while it is actually tracked
   * (raised in front of the camera); lower it and it disappears.
   */
  resolveHands(frame, world, camera) {
    if (this.mode === 'firstPerson') {
      return this._firstPersonHands(frame, camera);
    }
    // bodyEmbedded: tracked hands only, in their natural scene placement.
    const out = { right: null, left: null };
    for (let h = 0; h < Math.min(frame.handCount, 2); h++) {
      const sl = frame.sceneLandmarks[h];
      if (!sl) continue;
      const side = frame.handedness[h] === 'Right' ? 'right' : 'left';
      out[side] = sl;
    }
    return out;
  }

  /**
   * First-person hands, built fresh in CAMERA-LOCAL space from raw normalised
   * landmarks (not the tiny AR-plane mp2s scale), then transformed to world.
   *
   * Each hand: take landmark offsets from the wrist (x = right, y = up after a
   * flip, z = depth into the scene), scale to metres, anchor at
   * (±side, down, forward) in front of the eyes, rotate by the camera and add
   * the camera position. Untracked hands fall back to a resting pose so a holo
   * pair is always present; everything is eased per-side to remove jitter/pops.
   */
  _firstPersonHands(frame, camera) {
    const camPos = camera.position;
    const camQuat = camera.quaternion;
    const S = this.cfg;

    // Map each tracked hand to its on-screen side. Default is NATURAL/non-mirrored:
    // the user's right hand → on-screen right, left → left, so they never cross.
    // (mirrorHands flips this if a given rig/camera ends up reversed.)
    const live = { Right: null, Left: null };
    for (let h = 0; h < Math.min(frame.handCount, 2); h++) {
      const lm = frame.hands[h];
      if (!lm) continue;
      let side = frame.handedness[h];                  // 'Left' | 'Right' (user's hand)
      if (S.mirrorHands) side = side === 'Left' ? 'Right' : 'Left';
      if (!live[side]) live[side] = lm;
    }

    // Tilt that lifts a flat (fingers-up) hand so fingers reach up+forward into
    // the scene — the natural FPS/casting pose, backs of hands toward the camera.
    const reach = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -S.fpReachTilt);

    const build = (side) => {
      const lm = live[side];
      if (!lm) { this._smooth[side] = null; return null; }   // hand down → hide it
      const sign = side === 'Right' ? 1 : -1;
      const anchor = new THREE.Vector3(sign * S.fpSideSpread, S.fpDown, S.fpForward);

      // Local 21-pt hand shape, wrist at origin, camera basis (+x right, +y up, −z fwd)
      const local = new Array(21);
      const w = lm[0];
      for (let i = 0; i < 21; i++) {
        local[i] = new THREE.Vector3(
          (lm[i].x - w.x) * S.fpHandScale,
          -(lm[i].y - w.y) * S.fpHandScale,
          -((lm[i].z || 0) - (w.z || 0)) * S.fpHandScale * S.fpDepth
        ).applyQuaternion(reach);                    // reach up+forward
      }

      // Camera-local → world
      const world = local.map(p =>
        p.clone().add(anchor).applyQuaternion(camQuat).add(camPos)
      );

      // Ease to kill jitter (re-seed if the hand just reappeared)
      const prev = this._smooth[side];
      if (!prev || prev.length !== 21) this._smooth[side] = world;
      else for (let i = 0; i < 21; i++) prev[i].lerp(world[i], S.trackLerp);
      return this._smooth[side];
    };

    return { right: build('Right'), left: build('Left') };
  }

  /**
   * Position the camera for the current mode.
   *   firstPerson  → eyes of the avatar (world.applyToCamera already did this)
   *   bodyEmbedded → 3rd-person follow behind the avatar
   */
  updateCamera(world, camera) {
    if (this.mode === 'firstPerson') {
      world.applyToCamera(camera); // eyes
      return;
    }
    // Body-embedded follow camera
    const avatar = world.getAvatarPosition();
    const yaw = world.yaw + this.cfg.followYaw;
    const back = new THREE.Vector3(
      Math.sin(yaw) * this.cfg.followDistance,
      0,
      Math.cos(yaw) * this.cfg.followDistance
    );
    camera.position.set(
      avatar.x + back.x,
      avatar.y + this.cfg.followHeight,
      avatar.z + back.z
    );
    camera.lookAt(avatar.x, avatar.y + 0.8, avatar.z);
  }

  /**
   * SAM2 silhouette hook. If a samProvider is supplied (a worker that returns
   * a segmented RGBA body mask per frame), this billboards it into the scene
   * at the avatar position for the body-embedded "see yourself" effect.
   * Without a provider, body-embedded mode falls back to the holo skeleton.
   */
  async updateBodySilhouette(world, frame) {
    if (this.mode !== 'bodyEmbedded' || !this.samProvider) return null;
    // samProvider.segment(videoFrame) → { texture, width, height } | null
    return this.samProvider.segment(frame);
  }
}
