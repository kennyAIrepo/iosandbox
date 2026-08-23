/**
 * sign-dictation smoke test — pure Node, no browser, no camera, no ORT.
 * Exercises the recognition lane the way wrist-clamp-smoke exercises the
 * driver: synthetic landmark frames crafted to be adversarial, asserted
 * against the contract's promises:
 *
 *   featurizer  — mid-shoulder origin, torso scale, camera-distance
 *                 invariance, anatomical hand slots, NaN for missing
 *   segmenter   — no segments from stillness; one segment per motion
 *                 burst; ≤300ms hand dropouts do NOT split a sign
 *   recognizer  — contract-keyed values, segment events with no model
 *                 (nothing faked), per-gloss token cooldown
 *   toy model   — ONNX bytes well-formed (ir_version, ops, IO names)
 *   pip captions — feature-detects false in Node (no `documentPictureInPicture`),
 *                 push()/close() are safe no-ops before open() ever succeeds
 *                 (the real open()/window behavior needs a real browser —
 *                 see tests/_signprobe.mjs)
 *
 *   node tests/sign-smoke.mjs
 */
import { SignFeaturizer, FEATURE_DIM, N_HAND, HAND_R_OFF, POSE_OFF } from '../sdk/recognition/sign-landmarks.js';
import { SignBuffer } from '../sdk/recognition/sign-buffer.js';
import { SignRecognizer } from '../sdk/recognition/sign-recognizer.js';
import { buildToyModel } from '../sdk/recognition/toy-model.js';
import { PipCaptions } from '../sdk/recognition/pip-captions.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name} ${extra}`); }
  else { fail++; console.error(`  ✘ FAIL: ${name} ${extra}`); }
};
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

// ── synthetic body: shoulders 0.2 apart, torso 0.3 tall, all visible ──
function makePose(cx = 0.5, cy = 0.35) {
  const pts = Array.from({ length: 33 }, () => ({ x: cx, y: cy, z: 0, v: 0 }));
  pts[0] = { x: cx, y: cy - 0.12, z: 0, v: 1 };                       // nose
  pts[11] = { x: cx + 0.10, y: cy, z: 0, v: 1 };                      // shoulders
  pts[12] = { x: cx - 0.10, y: cy, z: 0, v: 1 };
  pts[13] = { x: cx + 0.14, y: cy + 0.15, z: 0, v: 1 };               // elbows
  pts[14] = { x: cx - 0.14, y: cy + 0.15, z: 0, v: 1 };
  pts[15] = { x: cx + 0.15, y: cy + 0.28, z: 0, v: 1 };               // wrists
  pts[16] = { x: cx - 0.15, y: cy + 0.28, z: 0, v: 1 };
  pts[23] = { x: cx + 0.07, y: cy + 0.30, z: 0, v: 1 };               // hips
  pts[24] = { x: cx - 0.07, y: cy + 0.30, z: 0, v: 1 };
  return pts;
}
const makeHand = (wx, wy) =>
  Array.from({ length: 21 }, (_, i) => ({ x: wx + (i % 5) * 0.012, y: wy + ((i / 5) | 0) * 0.012, z: 0 }));
const frameOf = (pose, hands = null, handedness = []) =>
  ({ pose, hands, handsWorld: null, handedness, handCount: hands?.length || 0, face: null });

// ═══ featurizer ═══
console.log('\n[featurizer]');
{
  const ft = new SignFeaturizer();
  const out = ft.update(frameOf(makePose()), 0, 1);
  ok(out.f.length === FEATURE_DIM, `feature dim ${FEATURE_DIM}`);
  ok(out.poseSeen && !out.handL && !out.handR, 'pose seen, no hands');
  // mid-shoulder → origin: shoulder slots average to (0,0)
  const sx = (out.f[(POSE_OFF + 1) * 2] + out.f[(POSE_OFF + 2) * 2]) / 2;
  const sy = (out.f[(POSE_OFF + 1) * 2 + 1] + out.f[(POSE_OFF + 2) * 2 + 1]) / 2;
  ok(near(sx, 0) && near(sy, 0), 'mid-shoulder is the origin', `(${sx.toFixed(5)}, ${sy.toFixed(5)})`);
  ok(out.f[(POSE_OFF + 0) * 2 + 1] < 0, 'nose above origin (y negative)');
  ok(Number.isNaN(out.f[0]) && Number.isNaN(out.f[HAND_R_OFF * 2]), 'missing hands are NaN');

  // camera-distance invariance: same body scaled 0.55× about frame centre.
  // Handedness 'Left' here = tracking.js's flipped label for MediaPipe raw
  // 'Right' → lands in the R slot (training convention; see sign-landmarks.js)
  const k = 0.55, c = 0.5;
  const scale = p => ({ ...p, x: c + k * (p.x - c), y: c + k * (p.y - c) });
  const hand = makeHand(0.62, 0.45);
  const a = new SignFeaturizer().update(frameOf(makePose(), [hand], ['Left']), 0, 1);
  const fA = Float32Array.from(a.f);
  const b = new SignFeaturizer().update(
    frameOf(makePose().map(scale), [hand.map(scale)], ['Left']), 0, 1);
  let maxErr = 0;
  for (let i = 0; i < FEATURE_DIM; i++) {
    if (Number.isFinite(fA[i]) || Number.isFinite(b.f[i])) {
      maxErr = Math.max(maxErr, Math.abs(fA[i] - b.f[i]));
    }
  }
  ok(maxErr < 1e-4, 'invariant to camera distance', `maxErr ${maxErr.toExponential(1)}`);
  ok(a.handR && !a.handL, "tracking.js 'Left' label → training-convention R slot");
  ok(Number.isFinite(fA[HAND_R_OFF * 2]) && Number.isNaN(fA[0]), 'R slot filled, L slot NaN');
}

// ═══ segmenter ═══
console.log('\n[segmenter]');
{
  const segs = [];
  const ft = new SignFeaturizer();
  const buf = new SignBuffer({ onSegment: s => segs.push(s) });
  const FPS = 60, DT = 1000 / FPS;
  let t = 0;
  const drive = (seconds, handAt) => {
    for (let i = 0; i < seconds * FPS; i++, t += DT) {
      const wx = handAt ? handAt(t / 1000) : null;
      const f = ft.update(frameOf(makePose(), wx === null ? null : [makeHand(wx, 0.4)],
                                  wx === null ? [] : ['Right']), t, 1);
      buf.push(f, t);
    }
  };
  drive(1.0, () => 0.62);                                   // still hand
  ok(segs.length === 0 && !buf.active, 'stillness produces no segment');
  drive(1.0, s => 0.5 + 0.25 * Math.sin(2 * Math.PI * 2 * s));   // 2 Hz wave
  ok(buf.active, 'motion opens a segment', `energy ${buf.energy.toFixed(2)}`);
  drive(0.8, () => 0.62);                                   // rest → quiet close
  ok(segs.length === 1, 'one burst → one segment', `got ${segs.length}`);
  const seg = segs[0];
  ok(seg && seg.length >= 10 && seg.length <= 64, 'plausible slot count', `${seg?.length} slots`);
  ok(seg && seg.durMs > 600 && seg.durMs < 2500, 'plausible duration', `${seg?.durMs.toFixed(0)}ms`);
  ok(seg && seg.data.length === 64 * FEATURE_DIM, 'window is fixed-shape T×F');
  ok(seg && [...seg.data].every(Number.isFinite), 'window has no NaN (zero-padded)');
  ok(seg && [...seg.data].some(v => v !== 0), 'window carries real data');

  // ≤300ms dropout must not split the sign
  const segs2 = [];
  const ft2 = new SignFeaturizer();
  const buf2 = new SignBuffer({ onSegment: s => segs2.push(s) });
  let t2 = 0;
  const drive2 = (seconds, handAt) => {
    for (let i = 0; i < seconds * FPS; i++, t2 += DT) {
      const wx = handAt ? handAt(t2 / 1000) : null;
      const f = ft2.update(frameOf(makePose(), wx === null ? null : [makeHand(wx, 0.4)],
                                   wx === null ? [] : ['Right']), t2, 1);
      buf2.push(f, t2);
    }
  };
  const wave = s => 0.5 + 0.25 * Math.sin(2 * Math.PI * 2 * s);
  drive2(0.5, wave);
  drive2(0.2, null);                                        // 200ms tracking blip
  ok(buf2.active, 'segment survives a 200ms dropout');
  drive2(0.5, wave);
  drive2(0.8, () => 0.62);
  ok(segs2.length === 1, 'dropout did not split the sign', `got ${segs2.length}`);
}

// ═══ recognizer facade ═══
console.log('\n[recognizer]');
{
  const signer = new SignRecognizer();                      // features-only: no model
  let segEvents = 0, tokens = 0;
  signer.on('segment', () => segEvents++);
  signer.on('token', () => tokens++);
  const FPS = 60, DT = 1000 / FPS;
  let t = 0;
  const drive = (seconds, handAt) => {
    for (let i = 0; i < seconds * FPS; i++, t += DT) {
      const wx = handAt ? handAt(t / 1000) : null;
      signer.update(frameOf(makePose(), wx === null ? null : [makeHand(wx, 0.4)],
                            wx === null ? [] : ['Left']), t, 1);
    }
  };
  drive(0.5, () => 0.62);
  const v = signer.values;
  for (const key of ['sign.segment.active', 'sign.motion', 'sign.buffer.fill',
                     'sign.hand.L.seen', 'sign.hand.R.seen', 'sign.confidence']) {
    ok(key in v, `contract channel present: ${key}`);
  }
  ok(v['sign.hand.R.seen'] === true && v['sign.hand.L.seen'] === false,
     "hand flags follow training-convention slots ('Left' label → R slot)");
  drive(1.0, s => 0.5 + 0.25 * Math.sin(2 * Math.PI * 2 * s));
  drive(0.8, () => 0.62);
  ok(segEvents === 1, 'segment event fires with no model', `got ${segEvents}`);
  ok(tokens === 0, 'no model → no tokens (nothing faked)');

  // per-gloss cooldown
  let emitted = 0;
  signer.on('token', () => emitted++);
  signer._emitToken('HELLO', 0.9, {});
  signer._emitToken('HELLO', 0.9, {});
  ok(emitted === 1, 'token cooldown gates same-gloss repeat');
  signer._emitToken('THANKS', 0.9, {});
  ok(emitted === 2, 'different gloss passes the gate');
  ok(signer.values['sign.confidence'] === 0.9, 'sign.confidence tracks last token');
}

// ═══ toy ONNX bytes ═══
console.log('\n[toy-model]');
{
  const small = buildToyModel({ T: 8, F: 6, H: 8, layers: 2, C: 4 });
  ok(small[0] === 0x08 && small[1] === 0x08, 'ir_version 8 header');
  const txt = new TextDecoder('latin1').decode(small);
  ok(txt.includes('MatMul') && txt.includes('Relu'), 'MatMul + Relu ops present');
  ok(txt.includes('logits') && txt.includes('signlab-toy'), 'IO names + graph name present');
  const full = buildToyModel();
  ok(full.length > 2e6 && full.length < 4e6, 'default build ≈ 0.7M params',
     `${(full.length / 1e6).toFixed(2)} MB`);
}

// ═══ pip captions ═══
console.log('\n[pip-captions]');
{
  const pip = new PipCaptions();
  ok(pip.available === false, 'unavailable in Node (no documentPictureInPicture)');
  ok(pip.open_ === false, 'not open before open() is called');
  pip.push('HELLO', {});                                  // must not throw pre-open
  ok(true, 'push() before open() is a safe no-op');
  pip.close();                                             // must not throw when never opened
  ok(true, 'close() before open() is a safe no-op');
  let threw = false;
  try { await pip.open(); } catch { threw = true; }
  ok(threw, 'open() rejects cleanly when unavailable');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
