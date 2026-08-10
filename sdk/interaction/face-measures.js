/**
 * hopeOS SDK — Canonical Face Measures
 * ═══════════════════════════════════════════════════════════════
 * The HUMAN half of the face-puppet contract, executable.
 *
 * PRINCIPLE — measures, not positions.
 * Raw landmark positions never cross the human→puppet boundary: a human
 * mouth and a gecko slit share no coordinate frame. What transfers is a
 * dimensionless MEASURE (a ratio of distances, or an angle), evaluated
 * with the same formula on both sides:
 *
 *   human 478-mesh indices ──┐
 *                            ├─→ same formula ─→ normalized 0..1 ─→ contract
 *   puppet marked vertices ──┘
 *
 * Every formula here is therefore written to be evaluable on EITHER a
 * MediaPipe landmark array or an array of puppet vertex positions —
 * pass any array of {x,y,z} points plus the index map.
 *
 * Ratio measures are invariant to face size, camera distance, and (for
 * in-plane features) translation — the same property that makes MAR/EAR
 * the standard in the blink/yawn literature (Soukupová & Čech 2016).
 *
 * INDEX SETS (MediaPipe canonical face mesh, 478 pts):
 *   Verified against sdk/interaction/mouth.js (13/14/78/308 in production)
 *   and puppet.js (1/10/152/33/263). EAR sets are the standard 6-point
 *   sets used across the MediaPipe EAR literature.
 *
 * ASPECT CORRECTION: normalized video coords are per-axis, so x- and
 * y-distances live on different scales unless the pixel aspect is
 * restored. Pass aspect = videoWidth/videoHeight for human landmarks;
 * pass aspect = 1 for puppet vertices (already metric).
 */

// ── Index maps: WHERE the ruler touches the human face ──────────
export const HUMAN_POINTS = {
  mouth: {
    upperInner: 13,    // inner upper-lip mid
    lowerInner: 14,    // inner lower-lip mid
    cornerL: 78,       // inner mouth corner (subject right in raw video)
    cornerR: 308,      //                    (subject left)
    upperOuter: 0,     // reserved: pucker/funnel channels (v2)
    lowerOuter: 17,
    outerCornerL: 61,
    outerCornerR: 291
  },
  // 6-pt EAR sets, order [corner, up1, up2, corner, low2, low1]
  eyeR: [33, 160, 158, 133, 153, 144],
  eyeL: [362, 385, 387, 263, 373, 380],
  irisR: 468,          // iris centers exist because tracking.js runs the
  irisL: 473,          // 478-pt refined model — gaze channel is available
  head: { noseTip: 1, forehead: 10, chin: 152, cheekR: 234, cheekL: 454 }
};

const d = (pts, a, b, aspect) =>
  Math.hypot((pts[a].x - pts[b].x) * aspect, pts[a].y - pts[b].y);

/**
 * MAR — Mouth Aspect Ratio: vertical inner-lip gap / mouth width.
 * Human closed ≈ 0.02–0.08, wide open ≈ 0.6–0.9 (mouth.js hysteresis
 * thresholds are tuned on exactly this formula — do not fork it).
 * @param {Array<{x,y}>} pts   landmark/vertex array
 * @param {Object} ix          {upperInner, lowerInner, cornerL, cornerR}
 * @param {number} aspect      videoW/videoH for human, 1 for puppet
 */
export function mar(pts, ix = HUMAN_POINTS.mouth, aspect = 1) {
  const w = d(pts, ix.cornerL, ix.cornerR, aspect);
  return w > 1e-6 ? d(pts, ix.upperInner, ix.lowerInner, aspect) / w : 0;
}

/** Mouth width, normalized by inter-cheek distance (smile/stretch, v2). */
export function mouthWidth(pts, aspect = 1) {
  const m = HUMAN_POINTS.mouth, h = HUMAN_POINTS.head;
  const face = d(pts, h.cheekR, h.cheekL, aspect);
  return face > 1e-6 ? d(pts, m.outerCornerL, m.outerCornerR, aspect) / face : 0;
}

/**
 * EAR — Eye Aspect Ratio (Soukupová & Čech 2016).
 * (‖p2−p6‖ + ‖p3−p5‖) / (2‖p1−p4‖). Open ≈ 0.25–0.35, closed < 0.1.
 * Landmark-only alternative to the eyeBlink blendshapes puppet.js uses;
 * the contract carries both so either can drive or corroborate.
 */
export function ear(pts, set, aspect = 1) {
  const [p1, p2, p3, p4, p5, p6] = set;
  const den = 2 * d(pts, p1, p4, aspect);
  return den > 1e-6 ? (d(pts, p2, p6, aspect) + d(pts, p3, p5, aspect)) / den : 0;
}

/**
 * Normalize a raw measure into contract space 0..1 given a per-user
 * calibration {neutral, max}. This is where "your wide-open" and
 * "my wide-open" become the same number.
 */
export function normalize(raw, cal) {
  const span = cal.max - cal.neutral;
  return span > 1e-6 ? Math.min(1, Math.max(0, (raw - cal.neutral) / span)) : 0;
}

/**
 * Evaluate every human-side channel probe in one pass.
 * @param {Array} lm   478 landmarks (tracker.detect().face.landmarks)
 * @param {number} aspect  videoWidth/videoHeight
 * @returns raw (uncalibrated) measures keyed by channel id
 */
export function probeHuman(lm, aspect) {
  return {
    "mouth.open": mar(lm, HUMAN_POINTS.mouth, aspect),
    "mouth.width": mouthWidth(lm, aspect),
    "eye.blink.L": ear(lm, HUMAN_POINTS.eyeL, aspect),   // NB: open=high; blink maps inverted
    "eye.blink.R": ear(lm, HUMAN_POINTS.eyeR, aspect)
    // tongue.* comes from pixel statistics (mouth.js), not landmarks:
    // MediaPipe has no tongue landmark — by design the contract allows
    // probe type "pixel_stat" for exactly this case.
    // head.* comes from the transform matrix (puppet.js _updateHead).
  };
}
