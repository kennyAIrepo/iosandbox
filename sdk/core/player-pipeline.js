/**
 * hopeOS SDK — Player Pipeline (per-player MediaPipe bundle)
 * ═══════════════════════════════════════════════════════════════
 * One instance PER player. Given that player's RAW crop box, it:
 *   1. cuts the crop from the un-flipped video into a 256² canvas;
 *   2. runs its OWN HandLandmarker (VIDEO, numHands:2) on the crop —
 *      a single-person region, so MediaPipe works reliably (no
 *      "hands in a crowd" drop, no cross-player confusion);
 *   3. (Mode B) runs its OWN PoseLandmarker for a 3D body;
 *   4. remaps crop→full-frame, mirrors to selfie space, and One-Euro
 *      filters via the existing HandFilterBank — so downstream sees
 *      EXACTLY the {img mirrored, world raw metric} convention that
 *      tracking.js emits today. hand-views.js / hand-rig.js consume it
 *      unchanged.
 *
 * REMAP FIRST, FILTER SECOND: full-frame position is crop-invariant,
 * so filtering there means a still hand stays still even as the crop
 * box drifts. Filtering in crop space would smear it.
 *
 * VIDEO-mode timestamp rule: each landmarker instance needs strictly
 * increasing timestamps; a per-pipeline monotonic guard enforces it.
 */

import { HandFilterBank } from './filters.js';
import { createHandLandmarker, createPoseLandmarker } from './tracking.js';

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

export class PlayerPipeline {
  constructor(opts = {}) {
    // 512, not 256: MediaPipe's internal hand-ROI crop can only be as sharp as
    // the canvas we hand it — 256² leaves a hand ~80px and fingers turn to mush.
    this.cropPx = opts.cropPx || 512;
    // numHands MUST stay 2: the palm detector only stops searching once
    // numHands hands are locked, so numHands:4 with 2 visible hands re-ran
    // full detection EVERY frame (the 2-player 110ms regression). Intruder
    // hands are excluded by PIXEL MASKING other players out of the crop
    // (see detect()), with the wrist-ownership gate as second line.
    this.numHands = opts.numHands || 2;
    this.withPose = opts.withPose !== false;
    this.predMs = opts.predMs ?? 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.cropPx;
    this.ctx = this.canvas.getContext('2d');   // GPU-backed: written by drawImage, uploaded by MediaPipe

    // Same filter params handlab uses (hands + full-body pose).
    this.imgBank   = new HandFilterBank({ count: 21, minCutoff: 1.4, beta: 0.08 });
    this.worldBank = new HandFilterBank({ count: 21, minCutoff: 1.4, beta: 0.08, maxLead: 0.05 });
    this.poseImgBank   = new HandFilterBank({ count: 33, minCutoff: 0.08, beta: 30 });
    this.poseWorldBank = new HandFilterBank({ count: 33, minCutoff: 0.1, beta: 40, maxLead: 0.05 });

    this.handLM = null;
    this.poseLM = null;
    this.ready = false;
    this._lastTs = 0;
    this._lastBody = null;   // cached between poseEvery frames
  }

  async init() {
    this.handLM = await createHandLandmarker({ numHands: this.numHands });
    if (this.withPose) this.poseLM = await createPoseLandmarker({ numPoses: 1 });
    this.ready = true;
    return this;
  }

  _ts(tMs) {
    let ts = tMs <= this._lastTs ? this._lastTs + 1 : tMs;
    this._lastTs = ts;
    return ts;
  }

  /**
   * @param video     source HTMLVideoElement (un-flipped)
   * @param box       RAW normalized crop box {x,y,w,h}
   * @param size      { w, h } video pixel dimensions
   * @param tMs       performance.now()
   * @param o         { wantPose, poseEvery=2, frameCount=0, predMs }
   * @returns { hands:{left,right}, bodyImg, bodyWorld }
   */
  detect(video, box, size, tMs, o = {}) {
    const out = { hands: { left: null, right: null }, bodyImg: null, bodyWorld: null };
    if (!this.ready || !size.w || !size.h) return out;

    // ── source select ────────────────────────────────────────────
    // SINGLE PLAYER: crops exist only to separate people — with one player,
    // run straight on the raw video element (full native resolution, zero
    // drawImage). This is byte-for-byte the old single-player stack's path.
    let src, bx, by, bw, bh;
    if (o.fullFrame) {
      src = video; bx = 0; by = 0; bw = 1; bh = 1;
    } else {
      bx = clamp01(box.x); by = clamp01(box.y);
      bw = Math.min(box.w, 1 - bx); bh = Math.min(box.h, 1 - by);
      if (bw <= 0 || bh <= 0) return out;
      const px = this.cropPx;
      this.ctx.drawImage(video, bx * size.w, by * size.h, bw * size.w, bh * size.h, 0, 0, px, px);
      src = this.canvas;

      // ── INTRUDER MASK ─────────────────────────────────────────
      // Black out other players' box regions inside OUR crop so the
      // landmarker never sees their hands (keeps numHands:2 in cheap
      // steady-state tracking). Punch peepholes around OUR OWN wrists
      // so a crossed-over own hand isn't erased with the intruder.
      if (o.otherBoxes && o.otherBoxes.length) {
        let masked = false;
        for (const ob of o.otherBoxes) {
          const ix0 = Math.max(ob.x, bx), iy0 = Math.max(ob.y, by);
          const ix1 = Math.min(ob.x + ob.w, bx + bw), iy1 = Math.min(ob.y + ob.h, by + bh);
          if (ix1 <= ix0 || iy1 <= iy0) continue;
          this.ctx.fillStyle = '#101418';
          this.ctx.fillRect((ix0 - bx) / bw * px, (iy0 - by) / bh * px,
                            (ix1 - ix0) / bw * px, (iy1 - iy0) / bh * px);
          masked = true;
        }
        if (masked && o.wrists) {
          this.ctx.save();
          this.ctx.beginPath();
          const holeR = 0.22 * px;
          for (const w of o.wrists) {
            if (!w) continue;
            const hx = ((1 - w.x) - bx) / bw * px, hy = (w.y - by) / bh * px;  // wrists are mirrored → un-mirror
            this.ctx.moveTo(hx + holeR, hy);
            this.ctx.arc(hx, hy, holeR, 0, Math.PI * 2);
          }
          this.ctx.clip();
          this.ctx.drawImage(video, bx * size.w, by * size.h, bw * size.w, bh * size.h, 0, 0, px, px);
          this.ctx.restore();
        }
      }
    }

    const ts = this._ts(tMs);
    const predMs = o.predMs ?? this.predMs;

    // ── HANDS (every frame) ──────────────────────────────────────
    const hr = this.handLM.detectForVideo(src, ts);
    if (hr.landmarks && hr.landmarks.length) {
      // remap to full-frame mirrored + measure wrist distances for ownership
      const own = (o.wrists || []).filter(Boolean);
      const oth = (o.otherWrists || []).filter(Boolean);
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const cands = [];
      for (let h = 0; h < hr.landmarks.length; h++) {
        const img = hr.landmarks[h].map(p => ({ x: 1 - (bx + p.x * bw), y: by + p.y * bh, z: p.z }));
        const w0 = img[0];
        cands.push({
          img, world: hr.worldLandmarks?.[h] || null,
          dOwn: own.length ? Math.min(...own.map(w => dist(w0, w))) : Infinity,
          dOth: oth.length ? Math.min(...oth.map(w => dist(w0, w))) : Infinity
        });
      }

      // OWNERSHIP GATE: overlapping crops see other players' hands, and the
      // landmarker happily spends its slots on them (the pic-2 bug: a bigger,
      // closer intruder hand outranks the player's own hand). A hand is OURS
      // if its wrist is near OUR MoveNet wrist and not nearer someone else's.
      const gateR = Math.min(0.25, Math.max(0.10, 0.3 * Math.max(bw, bh)));
      let keep;
      if (own.length) {
        keep = cands.filter(c => c.dOwn < gateR && c.dOwn <= c.dOth);
        if (keep.length < 2) {   // fill from hands that are at least NOT someone else's
          const extra = cands.filter(c => !keep.includes(c) && c.dOth > gateR)
                             .sort((a, b) => a.dOwn - b.dOwn).slice(0, 2 - keep.length);
          keep = keep.concat(extra);
        }
      } else {
        keep = cands.filter(c => c.dOth > gateR);
      }
      keep = keep.slice(0, 2).sort((a, b) => a.img[0].x - b.img[0].x);

      const cxm = 1 - (bx + bw / 2);   // mirrored box centre — side split for a lone hand
      for (let k = 0; k < keep.length; k++) {
        const slot = keep.length === 1 ? (keep[k].img[0].x >= cxm ? 'right' : 'left') : (k === 0 ? 'left' : 'right');
        this.imgBank.apply(slot, keep[k].img, tMs);
        let world = null;
        if (keep[k].world) { this.worldBank.apply(slot, keep[k].world, tMs); world = this.worldBank.predicted(slot, predMs); }
        out.hands[slot] = { img: this.imgBank.predicted(slot, predMs), world };
      }
    }

    // ── BODY (Mode B, every poseEvery-th frame; cached between) ──
    // posePhase staggers players so at most ONE pose model runs per frame
    // (both firing on the same frame made 110ms spike frames at 2p).
    const poseEvery = o.poseEvery || 2;
    if (o.wantPose && this.poseLM) {
      if (((o.frameCount || 0) + (o.posePhase || 0)) % poseEvery === 0) {
        // pose reads an UNMASKED crop — the intruder mask can cover parts of
        // OUR body too (overlap region belongs to both players).
        let poseSrc = src;
        if (!o.fullFrame && o.otherBoxes && o.otherBoxes.length) {
          if (!this.poseCanvas) {
            this.poseCanvas = document.createElement('canvas');
            this.poseCanvas.width = this.poseCanvas.height = this.cropPx;
            this.poseCtx = this.poseCanvas.getContext('2d');
          }
          this.poseCtx.drawImage(video, bx * size.w, by * size.h, bw * size.w, bh * size.h, 0, 0, this.cropPx, this.cropPx);
          poseSrc = this.poseCanvas;
        }
        const pr = this.poseLM.detectForVideo(poseSrc, ts);
        if (pr.landmarks && pr.landmarks.length) {
          const img = pr.landmarks[0].map(p => ({ x: 1 - (bx + p.x * bw), y: by + p.y * bh, z: p.z || 0, v: p.visibility ?? 1 }));
          this.poseImgBank.apply('body', img, tMs);
          let world = null;
          if (pr.worldLandmarks && pr.worldLandmarks.length) { this.poseWorldBank.apply('body', pr.worldLandmarks[0], tMs); world = this.poseWorldBank.predicted('body', predMs); }
          this._lastBody = { img: this.poseImgBank.predicted('body', predMs), world };
        }
      }
      if (this._lastBody) { out.bodyImg = this._lastBody.img; out.bodyWorld = this._lastBody.world; }
    }

    return out;
  }

  /** Reset filter state (call on player-leave / pool release). */
  drop() {
    for (const s of ['left', 'right']) { this.imgBank.drop(s); this.worldBank.drop(s); }
    this.poseImgBank.drop('body'); this.poseWorldBank.drop('body');
    this._lastBody = null;
    this._lastTs = 0;
  }

  dispose() {
    this.handLM?.close?.(); this.poseLM?.close?.();
    this.handLM = this.poseLM = null; this.ready = false;
  }
}
