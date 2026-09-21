/**
 * sdk/game/body-layer.js — T9 (stretch): the FULL BODY on the LOCAL tile + body support for props (CONTRACTS §3.15).
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * One BodyLayer = one pose landmarker on the local tile (the only tile that needs body collision; every landmarker holds
 * a WebGL context, tile-pipeline.js:18). It re-creates the tile's TilePipeline with withPose:true, forges ONE HoloBodyRig
 * (front bind = the mirror overlay) and feeds a BodyBody(BODY_RADII) from the SAME posed points the rig renders, exactly
 * the handlab.html:937-984 recipe (dropins §3.10):
 *
 *   frame.img (33 image points, filtered + predicted by PlayerPipeline)
 *     -> views.mirrorPoint(img[i], tile.cam, pts[i])        the tile's OWN HandViews: same ray projection as its hands
 *     -> bodyPose.stabilizeMirror(pts, vis, dt)             out-of-frame joints settle to rest instead of flailing
 *     -> posed = rig.pose(pts)                              37 points (extendPose adds HIP_MID/CHEST/HEAD_C/HEAD_TOP)
 *     -> body.update(posed, dt)                             BodyBody: joints + radii + 10 virtual in-between colliders
 *
 * The BodyBody goes to PropBall.update(..., extraBodies) as SUPPORT ONLY ([D7]): hull.pushOut vs its joint spheres, never a
 * grab (BodyBody.openness is pinned 1, pinch 0 — game-physics.js:974-975). Chirality: nothing here flips or relabels; the
 * pose is projected through HandViews.mirrorPoint like the hands (hand-views.js is the only mirror authority).
 *
 * Seam: tick(frame, dt, now, override) — `override` (S.ovBody: >= 33 world-space {x,y,z} points of this tile) replaces the
 * projected points BEFORE the rig and the BodyBody read them, so probes exercise the production chain with a synthetic pose
 * (the same idea as S.ovPacks for hands, CONTRACTS §0). Chrome's fake camera shows no person, so that is how [D7] is tested.
 */
import * as THREE from 'three';
import { HoloBodyRig, BodyPose, BODY_RADII } from '../core/body-rig.js';   // body-rig.js:175, :562, :40
import { BodyBody } from '../core/game-physics.js';                        // game-physics.js:951
import { TilePipeline } from './tile-pipeline.js';

const _hip = new THREE.Vector3();

export class BodyLayer {
  /**
   * @param {object} o
   *   scene   THREE.Scene (the stage's)
   *   tile    the LOCAL tile record: { clientId, video, cam, layer, rect, pipe (TilePipeline), handL, handR }
   *   stage   StageRenderer (assignLayer / registerContext)
   *   look    'ghost' | 'shadow' (default ghost, alpha 0.42 — handlab.html:1067)
   *   style   'standard' | 'lite' (default lite: the twin's script budget, BUILD-PLAN T9 p50 < 45 ms)
   *   hands   show the body rig's own coarse hands (default false: the tile's holohands already render the hands)
   *   dropMs  no pose for this long -> banks dropped, rig hidden, body absent (default 900, handlab.html:942)
   *   predMs  render-side lead the re-created pipe uses (default: the old pipe's, else 40)
   */
  constructor({ scene, tile, stage, look = 'ghost', alpha = 0.42, style = 'lite', hands = false, dropMs = 900, predMs = null } = {}) {
    if (!tile) throw new Error('BodyLayer: a local tile is required');
    this.scene = scene || null;
    this.tile = tile;
    this.stage = stage || null;
    this.opts = { look, alpha, style, hands, dropMs, predMs };
    this.rig = null;                                  // HoloBodyRig (front bind) — built in init()
    this.bodyPose = new BodyPose();
    this.body = new BodyBody(BODY_RADII);             // the collider the props support against; never grabs
    this.pts = [];                                    // mirror-projection pool (extends to 37 in the rig)
    for (let i = 0; i < 33; i++) this.pts.push(new THREE.Vector3());
    this.vis = new Float32Array(33).fill(1);          // per-landmark visibility, EMA'd (PlayerPipeline's filtered img carries no v -> 1)
    this.posed = null;                                // the last 37-point array the rig rendered, or null
    this.seen = 0;                                    // local ms of the last live pose
    this.source = 'none';                             // 'pose' | 'override' | 'none' — what fed the last tick
    this.size = 1; this.lift = 0;                     // fit controls (handlab S.bodySize / S.bodyY)
    this.ready = false;
    this.recreated = false;                           // init() swapped the tile's pipe (true) or found pose already on it (false)
    this._sig = null; this._sigAt = 0;                // stale-pose detector: PlayerPipeline keeps its last body when the person leaves
    this._disposed = false;
    this.stats = { poseMs: NaN, tickMs: 0, tracked: false, present: false, frames: 0 };   // poseMs = the pose landmarker's detectForVideo (EMA)
  }

  /** Time the pose landmarker (every poseEvery-th frame) without touching player-pipeline.js: wrap the instance method. */
  _wrapPoseTimer(pipe) {
    const lm = pipe && pipe.pipe && pipe.pipe.poseLM;
    if (!lm || lm.__t9wrapped || typeof lm.detectForVideo !== 'function') return;
    const orig = lm.detectForVideo.bind(lm), st = this.stats;
    lm.detectForVideo = (src, ts) => { const a = performance.now(); const r = orig(src, ts); const ms = performance.now() - a; st.poseMs = Number.isFinite(st.poseMs) ? st.poseMs + (ms - st.poseMs) * 0.2 : ms; return r; };
    lm.__t9wrapped = true;
  }

  /**
   * Re-create tile.pipe with withPose:true (ONE pose landmarker, eager so failures surface here), swap it in between frames,
   * forge the body rig on the tile's render layer. Contexts: the old hand landmarker is closed (-1), the new pipe brings a
   * hand (+1) and a pose (+1) landmarker -> stage.registerContext(+1).
   */
  async init() {
    const t = this.tile, old = t.pipe;
    if (old && old.pipe && old.pipe.poseLM) {
      this.recreated = false;                         // pose landmarker already loaded on this pipe (a previous enable): reuse it
    } else if (old) {
      const opts = { ...old.opts, withPose: true, predMs: this.opts.predMs ?? old.opts.predMs ?? 40 };
      const pipe = new TilePipeline(t.clientId, t.video, opts);
      try { await pipe.init(); } catch (e) { pipe.dispose(); throw e; }
      if (this._disposed) { pipe.dispose(); return this; }
      if (!pipe.pipe.poseLM) { pipe.dispose(); throw new Error('BodyLayer: the pose landmarker did not load'); }
      // swap (JS is single-threaded: this runs between frames, never inside one)
      old.dispose();
      if (this.stage) { this.stage.assignLayer(pipe.rigR, t.layer); this.stage.assignLayer(pipe.rigL, t.layer); this.stage.registerContext(1); }
      if (t.rect) pipe.setCover(t.rect.width, t.rect.height);
      const handsOn = !!(old.rigR && old.rigR.grp ? old.rigR.grp.visible : true);
      for (const rig of [pipe.rigR, pipe.rigL]) if (rig && rig.grp) rig.grp.visible = handsOn;
      t.pipe = pipe; t.handL = pipe.handL; t.handR = pipe.handR;
      this.recreated = true;
    }
    if (t.pipe && t.pipe.opts) t.pipe.opts.withPose = true;   // detect() asks for the pose again after a disable()
    this._wrapPoseTimer(t.pipe);
    if (!this.rig) {
      this.rig = new HoloBodyRig(this.scene, { alpha: this.opts.alpha, look: this.opts.look }).build(this.opts.style);
      if (this.stage) this.stage.assignLayer(this.rig, t.layer);
      this.setHands(this.opts.hands);
    }
    this.ready = true;
    return this;
  }

  /** The body rig's own coarse hands (the holohands already render the hands; off by default). */
  setHands(on) {
    this.opts.hands = !!on;
    const H = this.rig && this.rig._hands;
    if (H) for (const h of Object.values(H)) { if (h.mesh) h.mesh.visible = !!on; if (h.aura) h.aura.visible = !!on && this.rig.look === 'shadow'; }
  }

  setLook(look) { this.opts.look = look; if (this.rig) { this.rig.setLook(look); this.setHands(this.opts.hands); } }
  setVisible(on) { if (this.rig && this.rig.grp) this.rig.grp.visible = !!on && !!this.posed; }

  /**
   * One frame (after the tile's detect, before props / the game ball read extraBodies).
   * @param {{img:Array, world:Array}|{body:{img,world}}|null} frame  tile.pipe.body (33 filtered image points) or the detect result
   * @param {number} dt        seconds
   * @param {number} now       performance.now()
   * @param {Array|null} override  S.ovBody: >= 33 world-space {x,y,z} points of this tile (probe seam); replaces the projection
   * @returns {BodyBody} the collider (read .present); pass it in extraBodies
   */
  tick(frame, dt, now = (typeof performance !== 'undefined' ? performance.now() : Date.now()), override = null) {
    const t = this.tile, body = this.body, cfg = this.opts, st = this.stats, t0 = now;
    if (!this.ready || !this.rig) { body.drop(); st.tracked = st.present = false; return body; }
    const fb = frame && frame.body !== undefined ? frame.body : frame;
    const img = fb && fb.img && fb.img.length >= 33 ? fb.img : null;
    let live = false;
    if (override && override.length >= 33 && override[0] && override[32]) {
      for (let i = 0; i < 33; i++) { const p = override[i]; this.pts[i].set(p.x, p.y, p.z); }
      for (let i = 0; i < 33; i++) this.vis[i] += (1 - this.vis[i]) * 0.3;
      this.source = 'override'; live = true;
    } else if (img && !this._stale(img, now)) {
      const views = t.pipe && t.pipe.views;
      if (views && t.cam) {
        for (let i = 0; i < 33; i++) views.mirrorPoint(img[i], t.cam, this.pts[i]);        // hand-views.js:241 — the tile's own projection
        for (let i = 0; i < 33; i++) this.vis[i] += ((img[i].v ?? 1) - this.vis[i]) * 0.3;
        this.bodyPose.stabilizeMirror(this.pts, this.vis, dt);                              // body-rig.js:781
        this.source = 'pose'; live = true;
      }
    }
    if (live) {
      this.seen = now;
      if (this.size !== 1 || this.lift !== 0) {                                            // fit controls (handlab.html:955-963)
        _hip.copy(this.pts[23]).add(this.pts[24]).multiplyScalar(0.5);
        for (let i = 0; i < 33; i++) { this.pts[i].sub(_hip).multiplyScalar(this.size).add(_hip); this.pts[i].y += this.lift; }
      }
      this.rig.tick(now * 0.001);
      this.posed = this.rig.pose(this.pts);                                                // 37 points or null (degenerate frame)
    } else if (this.seen && now - this.seen > cfg.dropMs) {
      this.bodyPose.drop(); this.rig.pose(null); this.posed = null; this.seen = 0; this.source = 'none';
    }
    if (this.posed) body.update(this.posed, dt); else body.drop();                        // game-physics.js:990 — same points the rig renders
    st.tracked = this.source === 'pose' && !!this.posed; st.present = body.present; st.frames++;
    st.tickMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return body;
  }

  /** PlayerPipeline caches its last body forever when the person leaves: identical points for dropMs = no pose. */
  _stale(img, now) {
    const a = img[0], b = img[23], c = img[24];
    const sig = a.x + a.y * 7 + b.x * 13 + b.y * 17 + c.x * 19 + c.y * 23;
    if (sig !== this._sig) { this._sig = sig; this._sigAt = now; return false; }
    return now - this._sigAt > this.opts.dropMs;
  }

  /** Stop asking the pipe for a pose (the landmarker stays loaded for a fast re-enable); the body is absent from now on. */
  disable() {
    const t = this.tile;
    if (t.pipe && t.pipe.opts) t.pipe.opts.withPose = false;
    if (t.pipe) t.pipe.body = null;
    this.bodyPose.drop(); if (this.rig) this.rig.pose(null); this.posed = null; this.seen = 0; this.source = 'none';
    this.body.drop();
    this.stats.tracked = this.stats.present = false; this.stats.poseMs = NaN;
    this.ready = false;
  }

  /** Plain numbers for HUDs / probes. */
  snapshot(out = {}) {
    out.present = this.body.present; out.source = this.source; out.ready = this.ready;
    out.contexts = this.stage ? this.stage.contexts() : null;
    if (this.posed) {
      const c = this.body.joints[34], h = this.body.joints[33];
      out.chest = { x: c.x, y: c.y, z: c.z, r: this.body.radii[34] };
      out.hips = { x: h.x, y: h.y, z: h.z, r: this.body.radii[33] };
      out.scale = this.body.scale;
    } else out.chest = out.hips = null;
    return out;
  }

  /** Body rig + banks; the pipe keeps its (already loaded) pose landmarker unless the tile itself is torn down. */
  dispose() {
    this._disposed = true;
    this.disable();
    if (this.rig) { this.rig.dispose(); this.rig = null; }
  }
}

export { BodyBody, BODY_RADII };
