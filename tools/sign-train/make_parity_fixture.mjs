/** Generates parity_fixture.json: a synthetic raw-camera landmark sequence
 *  plus the CANONICAL features computed by the JS featurizer (the serve-side
 *  truth). test_parity.py must reproduce these bit-close from the same raw
 *  input — run both whenever either featurizer changes:
 *
 *    node tools/sign-train/make_parity_fixture.mjs
 *    python tools/sign-train/test_parity.py
 */
import { writeFileSync } from 'node:fs';
import { SignFeaturizer, FEATURE_DIM } from '../../sdk/recognition/sign-landmarks.js';

const ASPECT = 0.75, T = 20;

// raw-camera (UNmirrored) synthetic body — R hand sweeps, L hand absent
const rawPose = [], rawHandR = [];
for (let t = 0; t < T; t++) {
  const s = t / T;
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.35, v: 0 }));
  const set = (i, x, y) => { pose[i] = { x, y, v: 1 }; };
  set(0, 0.5, 0.23);
  set(11, 0.40, 0.35); set(12, 0.60, 0.35);            // anatomical L is image-right in raw
  set(13, 0.36, 0.50); set(14, 0.64, 0.50);
  set(15, 0.35, 0.63); set(16, 0.65, 0.63);
  set(23, 0.43, 0.65); set(24, 0.57, 0.65);
  rawPose.push(pose.map(p => [p.x, p.y, p.v]));
  const wx = 0.62 + 0.1 * Math.sin(2 * Math.PI * s), wy = 0.45;
  rawHandR.push(Array.from({ length: 21 },
    (_, i) => [wx + (i % 5) * 0.012, wy + ((i / 5) | 0) * 0.012]));
}

// serve side sees the selfie-MIRRORED stream (tracking.js x → 1-x).
// Handedness: this hand must land in the R slot (python puts rawHandR in
// hand_r). Training slots follow MediaPipe's RAW category ('Right' → hand_r);
// tracking.js flips that category, so the flipped label the featurizer
// receives for this hand is 'Left' — and the featurizer un-flips it back.
const ft = new SignFeaturizer();
const expected = [];
for (let t = 0; t < T; t++) {
  const frame = {
    pose: rawPose[t].map(([x, y, v]) => ({ x: 1 - x, y, v })),
    hands: [rawHandR[t].map(([x, y]) => ({ x: 1 - x, y, z: 0 }))],
    handedness: ['Left'],
    handsWorld: null, face: null
  };
  const out = ft.update(frame, t * 66.7, ASPECT);
  expected.push([...out.f].map(v => Number.isFinite(v) ? v : null));
}

writeFileSync(new URL('./parity_fixture.json', import.meta.url), JSON.stringify({
  aspect: ASPECT, featureDim: FEATURE_DIM,
  rawPose, rawHandR, expected
}));
console.log(`parity_fixture.json written: T=${T}, F=${FEATURE_DIM}, aspect=${ASPECT}`);
