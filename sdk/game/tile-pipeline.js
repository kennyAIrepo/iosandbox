/**
 * sdk/game/tile-pipeline.js — PROPOSED per-tile tracking unit for the Teams twin (research copy, 2026-09-18).
 * ═══════════════════════════════════════════════════════════════════════════
 * One TilePipeline = one participant <video> (their own camera or a remote stream) → hands (+ optional body)
 * as WORLD-space packs with a stable id, ready for HoloHandRig / HandBody / PropBall. Built ONLY from public
 * SDK seams; nothing frozen is touched:
 *   createHandLandmarker / createPoseLandmarker share ONE memoized WASM fileset (tracking.js:46-63, :119-143)
 *   PlayerPipeline = crop → landmarker → remap → One-Euro, emitting the SAME {img mirrored, world raw} shape
 *     tracking.js emits (player-pipeline.js:1-22, :97-248); fullFrame:true skips the crop (:106-107)
 *   HandViews.resolve = the ONLY mirror/flip authority; chirality is MEASURED, labels never read (hand-views.js:8-31, :199-220)
 *   HandBody slot strings must be unique per player or grab logic aliases hands (mpgames.html:652-655)
 *
 * Two topologies (see multi-person.md):
 *   A. ONE camera, N people in it  → use initMultiplayerTracking (multiplayer.js:37) instead of this class;
 *      MoveNet hands out stable ids and crop boxes, PlayerPipelines run per crop.
 *   B. N tiles, each its own video → one TilePipeline per tile (this class). Ids are the tile ids (stable by
 *      construction). Budget: every landmarker holds a WebGL context (player-pipeline.js:66-69) — 3 tiles ×
 *      (hands + pose) + three.js + MoveNet is near the browser ceiling; pass withPose:false on non-primary tiles.
 */
import * as THREE from 'three';
import { PlayerPipeline } from '../core/player-pipeline.js';   // player-pipeline.js:29
import { HandViews } from '../core/hand-views.js';             // hand-views.js:138
import { HoloHandRig } from '../core/hand-rig.js';             // hand-rig.js:152
import { HandBody } from '../core/game-physics.js';            // game-physics.js:54
import { REST_R42, REST_L42 } from '../core/hands.js';         // hands.js:19-20

export class TilePipeline {
  /**
   * @param {string} id        stable tile id ('tile-1', a participant name…) — becomes the HandBody slot suffix
   * @param {HTMLVideoElement} video  the tile's video (must be playing; readyState >= 2 before detect)
   * @param {object} opts
   *   scene       THREE.Scene to add the two rigs to (null = no rigs, physics only)
   *   camera      THREE.Camera the packs are resolved against (mirror mode: at the origin, no rotation)
   *   withPose    false → hands only (default false; true only on the tile that needs BodyBody collision)
   *   predMs      render-side prediction lead (handlab uses 40); physics reads the same packs (the page does too)
   *   style       'smooth' | 'slim' | 'full' | 'lowpoly' (hand-rig.js:242)
   *   occluder    true in mirror mode (hand-rig.js:290-313)
   *   cover       {x, y} cover-fit fraction of THIS tile's video (hand-views.js:98-103)
   */
  constructor(id, video, opts = {}) {
    this.id = id;
    this.video = video;
    this.opts = opts;
    this.pipe = new PlayerPipeline({ withPose: !!opts.withPose, eagerPose: !!opts.withPose, predMs: opts.predMs ?? 40 });
    this.views = new HandViews({ mode: 'mirror' });
    if (opts.cover) { this.views.cfg.cover.x = opts.cover.x; this.views.cfg.cover.y = opts.cover.y; }
    // rigs keyed by MESH chirality, physics keyed by SCREEN slot, slot strings unique per tile
    this.rigR = opts.scene ? new HoloHandRig(REST_R42, opts.scene, { style: opts.style || 'smooth' }).build() : null;
    this.rigL = opts.scene ? new HoloHandRig(REST_L42, opts.scene, { style: opts.style || 'smooth' }).build() : null;
    if (this.rigR && opts.occluder !== false) { this.rigR.setOccluder(true); this.rigL.setOccluder(true); }
    this.handL = new HandBody('left#' + id);
    this.handR = new HandBody('right#' + id);
    this.frameCount = 0;
    this.seen = { left: 0, right: 0 };
    this.packs = { R: null, L: null, hands: [] };
    this.body = null;            // { img, world } when withPose
    this.hands = { left: null, right: null };   // raw PlayerPipeline output {left:{img,world}, right:{img,world}} for the wire encoder (hand-stream.js)
    this.ready = false;
  }

  /** Load this tile's landmarkers (shares the page-wide WASM fileset; models come from CacheStorage after the first load). */
  async init() { await this.pipe.init(); this.ready = true; return this; }

  /** Cover-fit: call on the tile's loadedmetadata / resize with the tile's CSS box (handlab.html:467-472). */
  setCover(boxW, boxH) {
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const A = boxW / boxH, Av = vw / vh;
    this.views.cfg.cover.x = Math.min(1, A / Av);
    this.views.cfg.cover.y = Math.min(1, Av / A);
  }

  /**
   * One frame. Order = handlab.html:885-992 / mpbrowser.html:3103-3104, :3402-3406.
   * @param {number} now   performance.now()
   * @param {number} dt    seconds
   * @param {Array} cols   conform colliders for the rigs ([ball.collider, …]) or null
   * @returns {{ packs, handL, handR, body }}  packs = { R, L, hands:[{mesh, slot, points, img}] } world space
   */
  detect(now, dt, cols = null) {
    if (!this.ready || this.video.readyState < 2) return this._drop(now);
    this.frameCount++;
    const size = { w: this.video.videoWidth, h: this.video.videoHeight };
    // fullFrame:true → no crop, no intruder mask: this video contains ONE person by construction
    const out = this.pipe.detect(this.video, { x: 0, y: 0, w: 1, h: 1 }, size, now, {
      fullFrame: true, wantPose: !!this.opts.withPose, poseEvery: 2, frameCount: this.frameCount, predMs: this.opts.predMs ?? 40 });
    this.hands = out.hands;
    // hands are ALREADY One-Euro filtered + predicted in full-frame mirrored units (player-pipeline.js:203-208) — do not filter again
    for (const slot of ['left', 'right']) { if (out.hands[slot]) this.seen[slot] = now; }
    for (const slot of ['left', 'right']) {                                   // handlab.html:912-916 — reset latches after 400 ms
      if (!out.hands[slot] && this.seen[slot] && now - this.seen[slot] > 400) { this.views.dropSlot(slot); this.seen[slot] = 0; }
    }
    this.packs = this.views.resolve([out.hands.left, out.hands.right], this.opts.camera);
    if (this.rigR) { this.rigR.tick(now * 0.001); this.rigR.pose(this.packs.R, cols); }
    if (this.rigL) { this.rigL.tick(now * 0.001); this.rigL.pose(this.packs.L, cols); }
    for (const slot of ['left', 'right']) {                                   // physics from the SAME packs the rigs render
      const h = this.packs.hands.find(x => x.slot === slot);
      const hb = slot === 'left' ? this.handL : this.handR;
      if (h) hb.update(h.points, dt, h.img); else hb.drop();
    }
    this.body = out.bodyImg ? { img: out.bodyImg, world: out.bodyWorld } : null;
    return { packs: this.packs, handL: this.handL, handR: this.handR, body: this.body };
  }

  _drop(now) {
    this.packs = { R: null, L: null, hands: [] };
    this.hands = { left: null, right: null };
    if (this.rigR) this.rigR.pose(null); if (this.rigL) this.rigL.pose(null);
    this.handL.drop(); this.handR.drop();
    return { packs: this.packs, handL: this.handL, handR: this.handR, body: null };
  }

  dispose() {
    this.pipe.dispose();
    if (this.rigR) this.rigR.dispose(); if (this.rigL) this.rigL.dispose();
  }
}

/**
 * Solo-tester helper: split ONE webcam into N tile videos without N getUserMedia calls (single-camera devices
 * refuse a second grab, tracking.js:271-273). Each tile gets stream.clone(); the SAME person appears in every
 * tile, so ids are trivially stable — it exercises layout, physics and the pass game, not id swaps.
 * For genuinely different people per tile use CompositeCam.useFile(clipUrl) per tile (test-source.js:83-86).
 */
export function cloneStreamToTiles(stream, videoEls) {
  return videoEls.map(v => { const s = stream.clone(); v.srcObject = s; v.muted = true; v.playsInline = true; v.play().catch(() => {}); return s; });
}

export { THREE };
