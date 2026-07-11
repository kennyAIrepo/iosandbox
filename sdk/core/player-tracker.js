/**
 * hopeOS SDK — Player Tracker
 * ═══════════════════════════════════════════════════════════════
 * Turns MoveNet's raw tracked poses into stable per-player state:
 *   • a CALM square crop box per player (EMA-smoothed, RAW space) —
 *     the per-player MediaPipe pipelines run inside it, and a jittery
 *     box would make VIDEO-mode landmark tracking wander, so this is
 *     load-bearing;
 *   • join / leave debouncing (ids don't flicker games in and out);
 *   • the A/B mode decision with hysteresis (≤2 players → B / 3D,
 *     >2 → A / latency), never thrashing at the boundary;
 *   • the SINGLE mirror-at-emit step: crop boxes stay RAW (to cut from
 *     the un-flipped video MediaPipe needs), while everything a game
 *     RENDERS (bbox, body2D, wrists) is emitted selfie-mirrored to match
 *     the convention tracking.js has always used.
 *
 * Crop boxes come from BODY keypoints only — never from hand landmarks
 * (that feedback loop amplifies wobble).
 */

const UPPER = [0, 5, 6, 7, 8, 9, 10, 11, 12];   // nose, shoulders, elbows, wrists, hips
const L_WRIST = 9, R_WRIST = 10;

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const mirrorBox = (b) => ({ x: 1 - (b.x + b.w), y: b.y, w: b.w, h: b.h });
const mirrorPt  = (p) => ({ x: 1 - p.x, y: p.y, score: p.score ?? 0 });

export class PlayerTracker {
  constructor(opts = {}) {
    this.tracks = new Map();          // moveNet id -> track
    this.joinFrames = opts.joinFrames ?? 4;   // frames present before a player is "active"
    this.leaveMs    = opts.leaveMs    ?? 1500; // absence before a track is dropped
    this.pad        = opts.pad        ?? 0.25;  // box padding (fraction of extent)
    this.ema        = opts.ema        ?? 0.3;   // steady-state box smoothing
    this.resnapEma  = opts.resnapEma  ?? 0.5;   // faster catch-up on big moves
    this.resnap     = opts.resnap     ?? 0.15;  // drift (frac of box size) that triggers catch-up
    this.minScore   = opts.minScore   ?? 0.3;

    // A/B hysteresis
    this._mode = 'B';
    this._pendMode = 'B';
    this._pendSince = -1;
    this.enterAms = opts.enterAms ?? 500;   // ≥3 players must hold this long → A
    this.enterBms = opts.enterBms ?? 1000;  // ≤2 players must hold this long → B (slower, avoids thrash)
    this.onModeChange = opts.onModeChange || null;
  }

  get mode() { return this._mode; }

  _boxFromKp(kp) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, any = false;
    const grow = (x, y) => {
      any = true;
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    };
    for (const i of UPPER) {
      const k = kp[i]; if (!k || k.score < this.minScore) continue;
      grow(k.x, k.y);
    }
    // FINGERS EXTEND PAST THE WRIST: body keypoints end at the wrist, but the
    // hand reaches ~a forearm-length further. Extrapolate elbow→wrist so a
    // raised hand's fingertips are never clipped at the crop edge (clipped
    // fingers = flat/vanishing hand landmarks downstream).
    for (const [e, w] of [[7, 9], [8, 10]]) {
      const ke = kp[e], kw = kp[w];
      if (!ke || !kw || ke.score < this.minScore || kw.score < this.minScore) continue;
      grow(kw.x + (kw.x - ke.x) * 0.9, kw.y + (kw.y - ke.y) * 0.9);
    }
    if (!any) return null;
    let w = x1 - x0, h = y1 - y0;
    // pad
    x0 -= w * this.pad; x1 += w * this.pad; y0 -= h * this.pad; y1 += h * this.pad;
    w = x1 - x0; h = y1 - y0;
    // square around centre (expand the smaller axis)
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, s = Math.max(w, h);
    return { x: clamp01(cx - s / 2), y: clamp01(cy - s / 2),
             w: Math.min(s, 1), h: Math.min(s, 1) };
  }

  _updateTrack(t, pose, tMs) {
    t.kp = pose.keypoints;
    t.score = pose.score;
    t.lastSeen = tMs;
    t.seenFrames++;
    const box = this._boxFromKp(pose.keypoints);
    if (box) {
      if (!t.box) { t.box = { ...box }; }
      else {
        const drift = Math.max(Math.abs(box.x - t.box.x), Math.abs(box.y - t.box.y),
                               Math.abs(box.w - t.box.w)) / Math.max(t.box.w, 1e-3);
        const a = drift > this.resnap ? this.resnapEma : this.ema;
        t.box.x += (box.x - t.box.x) * a;
        t.box.y += (box.y - t.box.y) * a;
        t.box.w += (box.w - t.box.w) * a;
        t.box.h += (box.h - t.box.h) * a;
      }
    }
  }

  update(poses, tMs) {
    const live = new Set();
    for (const p of poses) {
      live.add(p.id);
      let t = this.tracks.get(p.id);
      if (!t) { t = { id: p.id, box: null, kp: null, score: 0, seenFrames: 0, lastSeen: tMs }; this.tracks.set(p.id, t); }
      this._updateTrack(t, p, tMs);
    }
    for (const [id, t] of this.tracks) {
      if (!live.has(id) && tMs - t.lastSeen > this.leaveMs) this.tracks.delete(id);
    }
    this._updateMode(tMs);
    return this.activePlayers();
  }

  activeCount() {
    let n = 0;
    for (const t of this.tracks.values()) if (t.seenFrames >= this.joinFrames && t.box) n++;
    return n;
  }

  /** Active players with RAW crop box + MIRRORED display fields. */
  activePlayers() {
    const out = [];
    for (const t of this.tracks.values()) {
      if (t.seenFrames < this.joinFrames || !t.box) continue;
      const wr = [];
      for (const i of [L_WRIST, R_WRIST]) {
        const k = t.kp[i];
        wr.push(k && k.score >= this.minScore ? mirrorPt(k) : null);
      }
      wr.sort((a, b) => (a ? a.x : 2) - (b ? b.x : 2));   // screen-left first
      out.push({
        id: t.id,
        bboxRaw: { ...t.box },                             // for cropping the un-flipped video
        bbox: mirrorBox(t.box),                            // for rendering
        body2D: t.kp.map(mirrorPt),                        // for rendering
        wrists: wr,                                        // [screenLeft|null, screenRight|null]
        score: t.score
      });
    }
    return out;
  }

  _updateMode(tMs) {
    const want = this.activeCount() > 2 ? 'A' : 'B';
    if (want === this._mode) { this._pendMode = want; this._pendSince = tMs; return; }
    if (this._pendMode !== want) { this._pendMode = want; this._pendSince = tMs; }
    const hold = want === 'A' ? this.enterAms : this.enterBms;
    if (tMs - this._pendSince >= hold) {
      this._mode = want;
      if (this.onModeChange) this.onModeChange(want);
    }
  }

  reset() { this.tracks.clear(); this._mode = 'B'; this._pendSince = -1; }
}
