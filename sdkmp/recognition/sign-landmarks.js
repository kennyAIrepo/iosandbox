/**
 * hopeOS SDK — Sign Featurizer
 * ═══════════════════════════════════════════════════════════════
 * The FRAME half of the sign-dictation lane (assets/sign.contract.json):
 * tracker.detect() output → one fixed-width, signer-normalized feature
 * vector per frame. Same doctrine as body-measures.js — what crosses the
 * boundary is a NORMALIZED quantity, never a raw camera position: every
 * point is re-expressed relative to the mid-shoulder origin and divided
 * by the torso scale, aspect-corrected, so the vector is invariant to
 * camera distance, framing, and body size.
 *
 * Point set (v1) — the Kaggle-winner "130 subset" philosophy minus face
 * (face lane lands later; enableFace stays off in v1):
 *   [0..20]  hand L, 21 pts (image space, anatomical slot via handedness)
 *   [21..41] hand R, 21 pts
 *   [42..50] pose: nose, shoulders, elbows, wrists, hips (9 pts)
 * → 51 points × (x, y) = FEATURE_DIM 102. Missing points are NaN
 * (the Kaggle parquet convention; sign-buffer.js zeros them at window
 * assembly and tracks per-hand validity separately).
 *
 * SPACES: consumes tracker's selfie-MIRRORED `hands` + `pose` (the only
 * pair that shares one image space — handsWorld is hand-centred metric,
 * it carries no global position). Anatomical L/R comes from
 * frame.handedness, which tracking.js already un-flips. Training-side
 * extraction must reproduce this exact layout + normalization.
 *
 * Scale fallback: signers are usually framed chest-up, hips off-screen.
 * When hips fail visibility, scale falls back to shoulderWidth × 1.35
 * (≈ torso). Scale is EMA-smoothed; the origin is NOT (position must
 * track the body frame-by-frame).
 */

// bumped on every serve-convention change; labs log it on boot so a stale
// cached build is visible in the UI instead of silently masking fixes
export const FEATURIZER_VERSION = 'v2 slot-fix 2026-08-17';

export const SIGN_POSE_IDX = [0, 11, 12, 13, 14, 15, 16, 23, 24];
export const N_HAND = 21;
export const N_POSE = SIGN_POSE_IDX.length;
export const N_POINTS = N_HAND * 2 + N_POSE;      // 51
export const FEATURE_DIM = N_POINTS * 2;          // 102
export const HAND_L_OFF = 0;                      // slot offsets (points)
export const HAND_R_OFF = N_HAND;
export const POSE_OFF = N_HAND * 2;

const SHOULDER_TO_TORSO = 1.35;   // shoulderWidth → torso-length estimate
const SCALE_EMA = 0.2;            // per-update blend toward the new scale

export class SignFeaturizer {
  constructor(opts = {}) {
    this.opts = { minVis: 0.5, ...opts };
    this._scale = 0;                       // EMA'd torso scale (aspect-corrected units)
    this._origin = { x: 0.5, y: 0.5 };     // mid-shoulder, tracks every pose frame
    this._originSeen = false;
    this.out = {
      f: new Float32Array(FEATURE_DIM),
      handL: false, handR: false, poseSeen: false,
      scale: 0, t: 0
    };
  }

  /**
   * @param {Object} frame   tracker.detect() result (raw: true recommended)
   * @param {number} tMs     performance.now()
   * @param {number} aspect  videoW/videoH (restores pixel aspect on x)
   * @returns the reused feature-frame object (read-only snapshot)
   */
  update(frame, tMs, aspect = 4 / 3) {
    const o = this.out;
    o.f.fill(NaN);
    o.handL = o.handR = o.poseSeen = false;
    o.t = tMs;

    // ── origin + scale from pose (held from last pose frame — pose runs
    //    every poseEvery-th detect(), hands every frame) ──
    const pose = frame.pose;
    if (pose && pose.length >= 33) {
      const sL = pose[11], sR = pose[12], hL = pose[23], hR = pose[24];
      const vis = p => (p.v ?? 1) >= this.opts.minVis;
      if (vis(sL) && vis(sR)) {
        this._origin.x = (sL.x + sR.x) / 2;
        this._origin.y = (sL.y + sR.y) / 2;
        this._originSeen = true;
        const shoulderW = Math.hypot((sL.x - sR.x) * aspect, sL.y - sR.y);
        let scale;
        if (vis(hL) && vis(hR)) {
          const hx = (hL.x + hR.x) / 2, hy = (hL.y + hR.y) / 2;
          scale = Math.hypot((this._origin.x - hx) * aspect, this._origin.y - hy);
        } else {
          scale = shoulderW * SHOULDER_TO_TORSO;    // chest-up framing
        }
        if (scale > 1e-4) {
          this._scale = this._scale ? this._scale + SCALE_EMA * (scale - this._scale) : scale;
        }
      }
    }
    o.scale = this._scale;
    if (!this._originSeen || this._scale < 1e-4) return o;   // all-NaN until a body is seen

    const ox = this._origin.x, oy = this._origin.y, s = this._scale;
    const put = (ptIdx, p) => {
      o.f[ptIdx * 2] = ((p.x - ox) * aspect) / s;
      o.f[ptIdx * 2 + 1] = (p.y - oy) / s;
    };

    // ── hands into TRAINING-CONVENTION slots (not tracking.js's labels) ──
    // tracking.js flips MediaPipe's handedness category for its selfie
    // consumers; the training extractor (modal_train.py extract_batch) uses
    // MediaPipe's raw category_name directly. Both stacks feed the
    // landmarker identical RAW frames, so tracking.js's flip put every hand
    // in the OPPOSITE slot from training — an inconsistent combination the
    // model never saw (mirror augmentation always flips slots AND coords
    // together). Proven causally 2026-08-17 with ground-truth val clips
    // (tests/_signclipprobe.mjs): 0/5 recognized with the flipped
    // convention. The un-flip below restores the training convention:
    // frame.handedness 'Right' (= MediaPipe raw 'Left') → L slot.
    // Slot semantics follow MediaPipe-raw-category, not verified anatomy —
    // consistent with the standing hand-conventions rule: never trust the
    // label's anatomical truth, only its train/serve consistency.
    if (frame.hands) {
      for (let h = 0; h < frame.hands.length; h++) {
        let side = frame.handedness?.[h] === 'Right' ? 'L' : 'R';
        // two same-label detections → second one takes the free slot
        if (side === 'L' && o.handL) side = 'R';
        else if (side === 'R' && o.handR) side = 'L';
        if ((side === 'L' && o.handL) || (side === 'R' && o.handR)) continue;
        const off = side === 'L' ? HAND_L_OFF : HAND_R_OFF;
        const lm = frame.hands[h];
        for (let i = 0; i < N_HAND; i++) put(off + i, lm[i]);
        if (side === 'L') o.handL = true; else o.handR = true;
      }
    }

    // ── pose subset ──
    if (pose && pose.length >= 33) {
      o.poseSeen = true;
      for (let i = 0; i < N_POSE; i++) {
        const p = pose[SIGN_POSE_IDX[i]];
        if (p && (p.v ?? 1) >= this.opts.minVis) put(POSE_OFF + i, p);
      }
    }
    return o;
  }
}
