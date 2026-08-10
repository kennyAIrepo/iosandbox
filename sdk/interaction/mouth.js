/**
 * hopeOS SDK — Mouth Trigger Module
 * ═══════════════════════════════════════════════════════════════
 * SIMPLE-CV trigger layer: "is the mouth open?" and "is the tongue
 * visible?" — nothing else. Built for games where these are INPUTS
 * (arm/fire), not cosmetics. Geometry + pixel statistics only; no
 * extra neural nets beyond the FaceLandmarker the stack already runs.
 *
 * Research basis (annotations):
 *  · MOUTH OPEN = Mouth Aspect Ratio (MAR): vertical inner-lip gap over
 *    horizontal inner-lip width. Direct descendant of the Eye Aspect
 *    Ratio blink metric (Soukupová & Čech 2016, "Real-Time Eye Blink
 *    Detection using Facial Landmarks"); MAR is the standard yawn /
 *    mouth-open metric in the drowsiness-detection literature
 *    (e.g. arXiv:2604.22479 uses personalized EAR/MAR thresholds).
 *    Ratio of distances → invariant to face size and camera distance.
 *  · LANDMARKS (MediaPipe canonical face mesh): 13 = upper inner-lip
 *    center, 14 = lower inner-lip center, 78/308 = inner mouth corners.
 *    The inner-lip loop (INNER_LIP below) is the FACEMESH_LIPS inner
 *    contour from the official mesh topology.
 *  · TONGUE = red-pixel ratio inside the inner-lip polygon. MediaPipe's
 *    52 blendshapes have NO tongueOut (the one ARKit shape it lacks), so
 *    tongue must come from pixels. The visual-speech literature's cue:
 *    "the only available cue is its red color — the ratio of red color
 *    to the size of the mouth ROI represents the appearance of the
 *    tongue" (arXiv:1409.1411, Visual Speech Recognition survey; same
 *    red-dominance segmentation used in tongue-diagnosis CV systems).
 *    Open dark cavity → dark pixels. Teeth → bright but grey (r≈g≈b).
 *    Tongue → bright AND red-dominant. Three-way separation is cheap.
 *
 * Both signals pass through hysteresis (separate on/off thresholds) so
 * triggers don't chatter at the boundary, and One-Euro smoothing
 * (sdk/core/filters.js) so slow jitter dies without adding strike lag.
 *
 * Game integration (generic script, no Three.js dependency):
 *   import { initCamera, initTracking } from '../core/tracking.js';
 *   import { MouthTriggers } from '../interaction/mouth.js';
 *   const tracker = await initTracking(vid, { enableHands: false, enablePose: false, faceEvery: 1 });
 *   const mouth = new MouthTriggers(vid);
 *   mouth.on('mouthOpen',  amt => lizard.armTongue());
 *   mouth.on('mouthClose', ()  => lizard.disarm());
 *   mouth.on('tongueOut',  amt => lizard.fire(mouth.state.tongueTip));
 *   // per frame:
 *   mouth.update(tracker.detect().face, performance.now());
 *
 * Coordinate note: FaceLandmarker landmarks arrive in RAW video coords
 * (tracking.js does not selfie-mirror the face, unlike hands). Pixel
 * sampling therefore reads the video directly with no un-mirroring.
 * Outputs that games consume (state.tongueTip, getMouthPolygon()) ARE
 * selfie-mirrored (x → 1-x) to match the SDK hand convention.
 */

import { OneEuro } from '../core/filters.js';

// Inner-lip contour, ordered as a closed loop (canonical mesh indices).
// Upper arc left→right, then lower arc right→left.
const INNER_LIP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308,
                   324, 318, 402, 317, 14, 87, 178, 88, 95];
const UPPER_MID = 13, LOWER_MID = 14, CORNER_L = 78, CORNER_R = 308;

const DEFAULTS = {
  // MAR hysteresis (closed face ≈ 0.02–0.08, wide open ≈ 0.6–0.9)
  openAbove: 0.28,
  closeBelow: 0.15,
  marFull: 0.7,          // MAR mapped to mouthOpenAmount 1.0
  // Tongue-pixel classification (8-bit RGB)
  redDominance: 1.12,    // r must exceed g AND b by this factor (rejects teeth: r≈g≈b)
  minBrightness: 62,     // (r+g+b)/3 above this (rejects dark open-mouth cavity)
  // Tongue-ratio hysteresis (fraction of mouth ROI that is tongue-colored)
  tongueAbove: 0.38,
  tongueBelow: 0.20,
  sampleWidth: 64,       // mouth ROI is downscaled to ≤ this many px wide
  // One-Euro tuning (signal is at face-detection rate, ~20–60 Hz)
  minCutoff: 2.0,
  beta: 0.15
};

export class MouthTriggers {
  /**
   * @param {HTMLVideoElement} videoEl - the DETECTION video (raw, unmirrored);
   *        same element passed to initTracking. Needed for tongue pixels.
   *        Pass null to disable tongue detection (MAR-only mode).
   */
  constructor(videoEl, opts = {}) {
    this.videoEl = videoEl;
    this.opts = { ...DEFAULTS, ...opts };
    this._listeners = {};

    this._marFilter = new OneEuro(this.opts.minCutoff, this.opts.beta);
    this._tongueFilter = new OneEuro(this.opts.minCutoff, this.opts.beta);
    this._lastT = 0;

    // Offscreen canvas for mouth-ROI sampling (willReadFrequently keeps
    // getImageData off the GPU readback slow path).
    this._cv = videoEl ? document.createElement('canvas') : null;
    this._ctx = this._cv ? this._cv.getContext('2d', { willReadFrequently: true }) : null;

    this._poly = null;       // last mouth polygon, mirrored normalized coords

    this.state = {
      faceSeen: false,
      mouthOpen: false,
      mouthOpenAmount: 0,    // 0..1 (MAR / marFull, clamped)
      mar: 0,                // raw smoothed MAR
      jawOpen: 0,            // blendshape passthrough when available (corroboration)
      tongueOut: false,
      tongueAmount: 0,       // 0..1 smoothed red-ratio in mouth ROI
      tongueTip: null        // {x,y} mirrored normalized, or null
    };
  }

  on(name, cb) {
    (this._listeners[name] = this._listeners[name] || []).push(cb);
    return this;
  }

  off(name, cb) {
    const l = this._listeners[name];
    if (l) this._listeners[name] = l.filter(f => f !== cb);
  }

  _emit(name, ...args) {
    for (const cb of (this._listeners[name] || [])) cb(...args);
  }

  /**
   * Feed the face result each frame (tracker.detect().face — may be null
   * on frames where face detection didn't run; state is held, not reset).
   * @param {Object|null} faceResult - { landmarks, blendshapes }
   * @param {number} tMs - performance.now()
   * @returns {Object} this.state
   */
  update(faceResult, tMs = performance.now()) {
    if (!faceResult || !faceResult.landmarks) return this.state;
    const lm = faceResult.landmarks;
    const dt = this._lastT ? (tMs - this._lastT) / 1000 : 0;
    this._lastT = tMs;
    this.state.faceSeen = true;

    // Aspect correction: normalized coords are per-axis, so x-distances and
    // y-distances live on different scales unless we restore the pixel aspect.
    const vw = this.videoEl?.videoWidth || 4, vh = this.videoEl?.videoHeight || 3;
    const ax = vw / vh;
    const dist = (a, b) => Math.hypot((lm[a].x - lm[b].x) * ax, lm[a].y - lm[b].y);

    // ── MAR: vertical gap / mouth width, smoothed, with hysteresis ──
    const width = dist(CORNER_L, CORNER_R);
    const mar = width > 1e-6 ? dist(UPPER_MID, LOWER_MID) / width : 0;
    const smar = this._marFilter.filter(mar, dt);
    this.state.mar = smar;
    this.state.mouthOpenAmount = Math.min(1, Math.max(0, smar / this.opts.marFull));
    if (faceResult.blendshapes) {
      const jaw = faceResult.blendshapes.find?.(b => b.categoryName === 'jawOpen');
      this.state.jawOpen = jaw ? jaw.score : this.state.jawOpen;
    }

    const wasOpen = this.state.mouthOpen;
    if (!wasOpen && smar > this.opts.openAbove) {
      this.state.mouthOpen = true;
      this._emit('mouthOpen', this.state.mouthOpenAmount);
    } else if (wasOpen && smar < this.opts.closeBelow) {
      this.state.mouthOpen = false;
      this._emit('mouthClose');
    }

    // ── Tongue: red-ratio in the inner-lip polygon (mouth open only) ──
    let ratio = 0, tip = null;
    if (this.state.mouthOpen && this._ctx && this.videoEl.readyState >= 2) {
      ({ ratio, tip } = this._sampleTongue(lm, vw, vh));
    } else {
      this._poly = null;
    }
    const sRatio = this._tongueFilter.filter(ratio, dt);
    this.state.tongueAmount = sRatio;
    this.state.tongueTip = tip;

    const hadTongue = this.state.tongueOut;
    if (!hadTongue && sRatio > this.opts.tongueAbove) {
      this.state.tongueOut = true;
      this._emit('tongueOut', sRatio);
    } else if (hadTongue && (sRatio < this.opts.tongueBelow || !this.state.mouthOpen)) {
      this.state.tongueOut = false;
      this._emit('tongueIn');
    }

    return this.state;
  }

  /** Last inner-lip polygon as [{x,y}...] in MIRRORED normalized coords
   *  (matches SDK hands / tongueTip space) — for HUD/debug overlays. */
  getMouthPolygon() { return this._poly; }

  // Downscale the mouth bbox from the video, classify each pixel inside the
  // inner-lip polygon, return { ratio: tongue-colored fraction, tip: centroid }.
  _sampleTongue(lm, vw, vh) {
    const o = this.opts;

    // Polygon in video-pixel coords + bbox
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const poly = INNER_LIP.map(i => {
      const x = lm[i].x * vw, y = lm[i].y * vh;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      return [x, y];
    });
    this._poly = INNER_LIP.map(i => ({ x: 1 - lm[i].x, y: lm[i].y }));
    const bw = maxX - minX, bh = maxY - minY;
    if (bw < 4 || bh < 2) return { ratio: 0, tip: null };

    // Downscale bbox into the sampling canvas
    const scale = Math.min(1, o.sampleWidth / bw);
    const cw = Math.max(2, Math.round(bw * scale));
    const ch = Math.max(2, Math.round(bh * scale));
    this._cv.width = cw; this._cv.height = ch;
    this._ctx.drawImage(this.videoEl, minX, minY, bw, bh, 0, 0, cw, ch);
    let data;
    try { data = this._ctx.getImageData(0, 0, cw, ch).data; }
    catch { return { ratio: 0, tip: null }; }  // canvas tainted / video gone

    const sPoly = poly.map(([x, y]) => [(x - minX) * scale, (y - minY) * scale]);

    let inside = 0, tongue = 0, cx = 0, cy = 0;
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        if (!pointInPoly(px + 0.5, py + 0.5, sPoly)) continue;
        inside++;
        const k = (py * cw + px) * 4;
        const r = data[k], g = data[k + 1], b = data[k + 2];
        if ((r + g + b) / 3 > o.minBrightness &&
            r > g * o.redDominance && r > b * o.redDominance) {
          tongue++; cx += px; cy += py;
        }
      }
    }
    if (inside < 8 || tongue === 0) return { ratio: 0, tip: null };

    // Centroid of tongue pixels → back to video coords → mirrored normalized
    const tipVx = (minX + (cx / tongue) / scale) / vw;
    const tipVy = (minY + (cy / tongue) / scale) / vh;
    return { ratio: tongue / inside, tip: { x: 1 - tipVx, y: tipVy } };
  }
}

// Even-odd ray-cast point-in-polygon.
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
