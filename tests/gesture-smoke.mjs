/**
 * gesture-smoke.mjs — headless verification of sdk/game/gesture-reactions.js + the REACTION 0x32 packet. Node, no browser.
 *   node tests/gesture-smoke.mjs        (from C:/Users/hanna/iosandbox — three resolves from node_modules)
 *
 *   (i)   confusion matrix: five scripted sequences built from sdk/game/pack-gen.js, each run on a fresh detector;
 *         every detector fires on its own script and on no other (off-diagonal all zero)
 *   (ii)  hold times: raise held 2.4 s does not fire, 2.6 s does; like held 0.7 s does not, 0.9 s does; raise lowers
 *         after 1.5 s; one clap alone is not applause
 *   (iii) cooldown: a second like within 3 s is suppressed, a third after 3 s fires
 *   (iv)  wire: encodeReaction / decodeReaction round trip, 16 B, header demux via readHeader, decodeHandStream and
 *         RemoteHands reject / ignore it, BallNet-style unknown-type fall-through
 *   (v)   timing: two-hand scene, µs per update() frame (< 100 µs), zero events during the bench
 *   (vi)  reaction-fx.js parses and its pure exports (EMOJI, announcement) are sane
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackGen, packToHands } from '../sdk/game/pack-gen.js';
import { GestureDetector, GESTURE_DEFAULTS, RX_KIND, RX_KIND_NAME } from '../sdk/game/gesture-reactions.js';
import { encodeReaction, decodeReaction, decodeHandStream, readHeader, PK_REACTION, RX_BYTES, RX_BYTES_LEGACY, RX_ORIGIN_STEP, PK, FLAG } from '../sdk/net/hand-stream.js';
import { RemoteHands } from '../sdk/net/remote-consumer.js';
import { EMOJI, announcement, originToCss, FX_DEFAULTS } from '../sdk/game/reaction-fx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name} ${extra}`); } else { fail++; console.error(`  FAIL ${name} ${extra}`); } };
const section = (title) => console.log('\n' + title);

// ── synthetic scene ─────────────────────────────────────────────────────────────────────────────────────────────
const FPS = 30, DT = 1000 / FPS, D = 2.0;
const CAM = { fov: 60, aspect: 16 / 9, matrixWorldInverse: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } };   // camera at the origin, looking down -z
const V = (x, y, z) => ({ x, y, z });
/** An open hand whose INNER palm faces the camera: PackGen.open with the thumb column and fingertips nudged toward the camera
 *  (+z here) — the measured volar side (prop-ball.js _holdPose maths) then points at the camera. */
function facingOpen(x, y, z = -D) {
  const p = PackGen.open(x, y, z);
  p[1] = V(x + 0.03, y - 0.02, z + 0.02); p[2] = V(x + 0.06, y, z + 0.025); p[3] = V(x + 0.085, y, z + 0.02);
  for (const i of [8, 12, 16, 20]) p[i].z += 0.01;
  return p;
}
/** A fist with the thumb up (closure > 0.7, thumb tip the highest joint). */
function thumbsUp(x, y, z = -D) {
  const p = PackGen.open(x, y, z);
  for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.02, z + 0.04);
  for (const i of [6, 7, 10, 11, 14, 15, 18, 19]) p[i] = V(x, y + 0.03, z + 0.03);
  p[1] = V(x + 0.03, y, z); p[2] = V(x + 0.04, y + 0.04, z); p[3] = V(x + 0.035, y + 0.08, z); p[4] = V(x + 0.03, y + 0.12, z);
  return p;
}
/** hands entry for the resolved-pack shape: { slot, points, img } with img from the SAME projection the bots use (packToHands) */
function entry(pack, slot) { const h = packToHands(pack, CAM, { slot, mirrorDist: D }); return { mesh: slot === 'left' ? 'R' : 'L', slot, points: pack, img: h[slot].img }; }
const packs = (...entries) => ({ R: null, L: null, hands: entries.filter(Boolean) });
const NONE = packs();

/** run a script (frame index -> packs|null) for `ms` on a detector; returns the events in order */
function run(det, script, ms, t0 = 0) {
  const evs = []; const un = det.listen(ev => evs.push(ev));
  const n = Math.round(ms / DT);
  for (let i = 0; i < n; i++) det.update(t0 + i * DT, script(i, t0 + i * DT) || NONE);
  un();
  return evs;
}
const RAISE_POS = { x: 0.12, y: 0.5 };                      // wrist img y ≈ 0.28 (< 0.38): the tile's upper 38 %
const SCRIPTS = {
  raise: (i, t) => t < 3000 ? packs(entry(facingOpen(RAISE_POS.x, RAISE_POS.y), 'right')) : NONE,                    // 3 s up, then lowered
  applause: (i, t) => {                                                                                            // 2.5 Hz clap for 1.2 s, hands centred
    if (t > 1200) return NONE;
    const d = 0.15 + 0.15 * Math.cos(2 * Math.PI * 2.5 * t / 1000);                                                // palm distance 0 .. 0.30 m
    return packs(entry(facingOpen(-d / 2, 0), 'left'), entry(facingOpen(d / 2, 0), 'right'));
  },
  like: (i, t) => t < 1200 ? packs(entry(thumbsUp(0.1, 0.05), 'right')) : NONE,                                    // 1.2 s thumbs up
  wave: (i, t) => t < 1500 ? packs(entry(facingOpen(0.15 * Math.sin(2 * Math.PI * 2 * t / 1000), 0), 'right')) : NONE,   // 2 Hz, ±0.15 m
  love: (i, t) => {                                                                                                // heart: tips touching, palms 0.14 m apart
    if (t > 800) return NONE;
    const a = facingOpen(-0.07, 0), b = facingOpen(0.07, 0);
    a[8] = V(0, 0.16, -D); b[8] = V(0, 0.16, -D); a[4] = V(0, -0.02, -D); b[4] = V(0, -0.02, -D);
    return packs(entry(a, 'left'), entry(b, 'right'));
  },
};
const KINDS = ['raise', 'applause', 'like', 'wave', 'love'];
const TOTAL_MS = { raise: 6000, applause: 2500, like: 2500, wave: 2500, love: 2500 };   // each script + a silent tail

// ── (i) confusion matrix ─────────────────────────────────────────────────────────────────────────────────────────
section('(i) confusion matrix — rows: scripted gesture, cols: events fired (raise = on-events)');
const M = {}; let offDiag = 0, diagMissing = 0;
for (const s of KINDS) {
  const det = new GestureDetector();
  const evs = run(det, SCRIPTS[s], TOTAL_MS[s]);
  M[s] = {}; for (const k of KINDS) M[s][k] = evs.filter(e => e.kind === k && (k !== 'raise' || e.on)).length;
  for (const k of KINDS) { if (k !== s && M[s][k]) offDiag += M[s][k]; }
  if (!M[s][s]) diagMissing++;
  if (s === 'raise') { const off = evs.find(e => e.kind === 'raise' && !e.on); M.raiseOff = off ? off.t : null; }
}
const W = 10, cell = (v) => String(v).padStart(W);
console.log('  ' + cell('script \\ fired') + KINDS.map(cell).join(''));
for (const s of KINDS) console.log('  ' + cell(s) + KINDS.map(k => cell(M[s][k])).join(''));
ok(offDiag === 0, 'off-diagonal all zero', `(off-diagonal sum ${offDiag})`);
ok(diagMissing === 0, 'every detector fires on its own script', `(diagonal ${KINDS.map(k => M[k][k]).join(',')})`);
ok(M.raiseOff !== null && M.raiseOff >= 3000 + GESTURE_DEFAULTS.raiseLowerMs - DT && M.raiseOff <= 3000 + GESTURE_DEFAULTS.raiseLowerMs + 2 * DT, 'raise: lowered event 1.5 s after the hand left', `(off at ${M.raiseOff} ms; lowered at 3000)`);

// ── (ii) hold times ──────────────────────────────────────────────────────────────────────────────────────────────
section('(ii) hold times');
{
  const up = (ms) => run(new GestureDetector(), (i, t) => t < ms ? packs(entry(facingOpen(RAISE_POS.x, RAISE_POS.y), 'right')) : NONE, ms).filter(e => e.kind === 'raise' && e.on);
  const r24 = up(2400), r26 = up(2600);
  ok(r24.length === 0, 'raise held 2.4 s does NOT fire');
  ok(r26.length === 1 && r26[0].t >= 2500 - 1e-6 && r26[0].t < 2500 + DT, 'raise held 2.6 s fires at the 2.5 s hold', `(t = ${r26[0] && r26[0].t.toFixed(1)} ms)`);
  const lk = (ms) => run(new GestureDetector(), (i, t) => t < ms ? packs(entry(thumbsUp(0.1, 0.05), 'right')) : NONE, ms + 500).filter(e => e.kind === 'like');
  ok(lk(700).length === 0, 'like held 0.7 s does NOT fire');
  const l9 = lk(900); ok(l9.length === 1 && l9[0].t >= 800 - 1e-6 && l9[0].t < 800 + DT, 'like held 0.9 s fires at the 0.8 s hold', `(t = ${l9[0] && l9[0].t.toFixed(1)} ms)`);
  // one clap only (far -> near -> far once) is not applause
  const one = run(new GestureDetector(), (i, t) => { if (t > 1500) return NONE; const d = t < 200 ? 0.30 : t < 400 ? 0.04 : 0.30; return packs(entry(facingOpen(-d / 2, 0), 'left'), entry(facingOpen(d / 2, 0), 'right')); }, 2000);
  ok(one.filter(e => e.kind === 'applause').length === 0, 'a single clap is NOT applause', `(${one.length} events)`);
  // a raised hand that is waving does not count as a raise
  const wv = run(new GestureDetector(), (i, t) => t < 3200 ? packs(entry(facingOpen(0.15 * Math.sin(2 * Math.PI * 2 * t / 1000), RAISE_POS.y), 'right')) : NONE, 4000);
  ok(wv.filter(e => e.kind === 'raise').length === 0 && wv.some(e => e.kind === 'wave'), 'waving in the upper tile = wave, never raise', `(${wv.map(e => e.kind).join(',')})`);
  // shoulder line from a pose: wrist below the shoulders is not raised even when high in the tile
  const body = new Array(33).fill(0).map(() => V(0, 0, -D)); body[11] = V(-0.2, 0.7, -D); body[12] = V(0.2, 0.7, -D);
  const det = new GestureDetector(); const evs = []; det.listen(e => evs.push(e));
  for (let i = 0; i < 90; i++) det.update(i * DT, packs(entry(facingOpen(RAISE_POS.x, RAISE_POS.y), 'right')), body);
  ok(evs.length === 0, 'pose given: wrist under the shoulder line does NOT raise');
  for (let i = 90; i < 180; i++) det.update(i * DT, packs(entry(facingOpen(RAISE_POS.x, 0.8), 'right')), body);
  ok(evs.some(e => e.kind === 'raise' && e.on), 'pose given: wrist above the shoulder line raises');
}

// ── (iii) cooldown ───────────────────────────────────────────────────────────────────────────────────────────────
section('(iii) cooldown 3 s per kind');
{
  const holds = [[0, 900], [1100, 2000], [3400, 4300]];        // three thumbs-up holds; the second is inside the 3 s cooldown of the first
  const det = new GestureDetector();
  const evs = run(det, (i, t) => holds.some(([a, b]) => t >= a && t < b) ? packs(entry(thumbsUp(0.1, 0.05), 'right')) : NONE, 5000).filter(e => e.kind === 'like');
  ok(evs.length === 2 && evs[0].t < 1000 && evs[1].t >= evs[0].t + GESTURE_DEFAULTS.cooldownMs, 'second like within 3 s suppressed, third after 3 s fires', `(fired at ${evs.map(e => e.t.toFixed(0)).join(', ')} ms; suppressed ${det.suppressed})`);
  ok(det.suppressed >= 1, 'suppressed counter counts the cooled-down attempt');
}

// ── (iv) wire ────────────────────────────────────────────────────────────────────────────────────────────────────
section('(iv) REACTION 0x32 packet');
{
  const buf = encodeReaction(5, 'applause', 4000000000, 65535, 4000000200, { on: true, slot: 'left', flags: FLAG.FROM_HOST });
  ok(buf.byteLength === RX_BYTES && RX_BYTES === 18 && RX_BYTES_LEGACY === 16, 'encodeReaction = 18 B (16 B legacy layout + origin x, y u8)');
  const hd = readHeader(buf);
  ok(hd.type === PK_REACTION && PK_REACTION === 0x32 && hd.seq === 65535 && hd.t === 4000000200 && hd.ver === 1 && hd.flags === FLAG.FROM_HOST, 'header via ball-net readHeader: type 0x32, seq, t, ver, flags', JSON.stringify(hd));
  const d = decodeReaction(buf);
  ok(d.kind === RX_KIND.applause && d.name === 'applause' && d.seat === 5 && d.on === true && d.slot === 0 && d.ts === 4000000000, 'decodeReaction fields round trip', JSON.stringify({ kind: d.kind, name: d.name, seat: d.seat, on: d.on, slot: d.slot, ts: d.ts }));
  const off = decodeReaction(encodeReaction(0, RX_KIND.raise, 12, 1, 13, { on: false, slot: 1 }));
  ok(off.name === 'raise' && off.on === false && off.slot === 1 && off.seat === 0, 'raise off / right slot round trip');
  for (const k of ['raise', 'applause', 'like', 'wave', 'love', 'laugh', 'surprised']) assert.equal(RX_KIND_NAME[RX_KIND[k]], k);
  ok(true, 'RX_KIND <-> RX_KIND_NAME consistent for 7 kinds');
  let rej = false; try { decodeHandStream(buf); } catch (e) { rej = e instanceof TypeError; }
  ok(rej, 'decodeHandStream rejects a REACTION packet (TypeError)');
  const rh = new RemoteHands(); const took = rh.onMessage(buf);
  ok(took === false && rh.ignored === 1, 'RemoteHands.onMessage ignores 0x32', `(ignored ${rh.ignored})`);
  ok(PK.HAND_STREAM === 0x30 && PK_REACTION !== PK.HAND_STREAM, 'HAND_STREAM stays 0x30; REACTION is the next free code after the reserved POSE33 0x31');
  let bad = 0; try { encodeReaction(255, 'like', 0, 0, 0); } catch { bad++; } try { encodeReaction(0, 'nope', 0, 0, 0); } catch { bad++; }
  ok(bad === 2, 'encodeReaction rejects seat 255 and an unknown kind');
  ok(Object.keys(EMOJI).length === 7 && announcement({ kind: 'raise', on: true }, 'Ana') === 'Ana raised a hand' && announcement({ kind: 'applause' }, 'Bo') === 'Bo is clapping', 'reaction-fx: EMOJI map + announcement strings');
}

// ── (v) timing ───────────────────────────────────────────────────────────────────────────────────────────────────
section('(v) timing — two hands present every frame, clapping-distance scene, 20 000 frames');
{
  const det = new GestureDetector();
  const frames = 20000, N = 60;
  const scene = []; for (let i = 0; i < N; i++) { const d = 0.20 + 0.05 * Math.cos(i / N * Math.PI * 2); scene.push(packs(entry(facingOpen(-d / 2, 0.05), 'left'), entry(facingOpen(d / 2, 0.05), 'right'))); }
  for (let i = 0; i < 300; i++) det.update(i * DT, scene[i % N]);          // warm up
  const ev0 = det.events;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) det.update(10000 + i * DT, scene[i % N]);
  const us = (performance.now() - t0) * 1000 / frames;
  console.log(`  timing: ${us.toFixed(2)} us per update() frame (${frames} frames, 2 hands)`);
  ok(us < 100, 'per-frame cost < 0.1 ms', `(${us.toFixed(2)} us)`);
  ok(det.events === ev0, 'no events during the bench scene (hands apart 0.15-0.25 m, still, mid-tile)', `(${det.events - ev0})`);
}

// ── (vi) reaction-fx parses ──────────────────────────────────────────────────────────────────────────────────────
section('(vi) reaction-fx.js');
{
  const r = spawnSync(process.execPath, ['--check', path.join(here, '..', 'sdk', 'game', 'reaction-fx.js')], { encoding: 'utf8' });
  ok(r.status === 0, 'node --check sdk/game/reaction-fx.js', r.stderr && r.stderr.trim());
}

// ── (vii) emoji origin: every event carries { x, y } in tile-normalised coordinates at the expected landmark ─────
section('(vii) event origin (tile-normalised 0..1, y down) at the gesture\'s own landmark');
{
  const inside = (o) => !!o && Number.isFinite(o.x) && Number.isFinite(o.y) && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1;
  const near = (o, p, tol = 1e-9) => inside(o) && Math.abs(o.x - p.x) <= tol && Math.abs(o.y - p.y) <= tol;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const palm = (img) => mid(img[0], img[9]);
  const hand = (pk, slot) => pk.hands.find(h => h.slot === slot);
  // expected landmark per kind, recomputed from the SAME script at the event's t (the scripts are pure functions of t)
  const EXPECT = {
    raise: (pk, ev) => hand(pk, ev.slot).img[0],                                  // wrist
    like: (pk, ev) => hand(pk, ev.slot).img[4],                                   // thumb tip
    wave: (pk, ev) => hand(pk, ev.slot).img[0],                                   // wrist
    applause: (pk) => mid(palm(hand(pk, 'left').img), palm(hand(pk, 'right').img)), // midpoint of the two palm centres
    love: (pk) => mid(hand(pk, 'left').img[8], hand(pk, 'right').img[8]),         // midpoint of the two index tips
  };
  let checked = 0, bad = [];
  for (const s of KINDS) {
    const evs = run(new GestureDetector(), SCRIPTS[s], TOTAL_MS[s]).filter(e => e.kind === s && (s !== 'raise' || e.on));
    for (const ev of evs) {
      const pk = SCRIPTS[s](0, ev.t), exp = EXPECT[s](pk, ev);
      checked++;
      if (!near(ev.origin, exp)) bad.push(`${s}: got ${JSON.stringify(ev.origin)} exp ${JSON.stringify(exp)}`);
    }
  }
  ok(checked === 5 && bad.length === 0, 'five kinds: origin inside 0..1 and equal to the expected landmark (wrist / thumb tip / wrist / palm-centre midpoint / index-tip midpoint)', bad.join('; ') || `(${checked} events)`);
  // the heart sits between the hands, above the palms; the clap at the palm-centre midpoint; the thumbs-up above the wrist (y down)
  const love = run(new GestureDetector(), SCRIPTS.love, TOTAL_MS.love).find(e => e.kind === 'love');
  const lovePk = SCRIPTS.love(0, love.t), lw = hand(lovePk, 'left').img[0], rw = hand(lovePk, 'right').img[0];
  ok(love.origin.x > Math.min(lw.x, rw.x) && love.origin.x < Math.max(lw.x, rw.x) && love.origin.y < Math.min(lw.y, rw.y), 'heart origin lies between the two wrists in x and above them (smaller y)', JSON.stringify(love.origin));
  const like = run(new GestureDetector(), SCRIPTS.like, TOTAL_MS.like).find(e => e.kind === 'like');
  ok(like.origin.y < hand(SCRIPTS.like(0, like.t), 'right').img[0].y, 'thumbs-up origin (thumb tip) is above the wrist', JSON.stringify(like.origin));
  // lowered raise: the hand is gone (NONE for 1.5 s) -> the last wrist seen, still inside the tile
  const raiseEvs = run(new GestureDetector(), SCRIPTS.raise, TOTAL_MS.raise).filter(e => e.kind === 'raise');
  const onEv = raiseEvs.find(e => e.on), offEv = raiseEvs.find(e => !e.on);
  ok(offEv && inside(offEv.origin) && near(offEv.origin, onEv.origin), 'raise lowered (hand already gone) reuses the last wrist seen (same point as the raise)', JSON.stringify(offEv && offEv.origin));
  // no img on the hand entry (synthetic packs: teamslab.html bots) -> origin null, never NaN
  const noImg = run(new GestureDetector(), (i, t) => t < 1200 ? packs({ mesh: 'L', slot: 'right', points: thumbsUp(0.1, 0.05), img: null }) : NONE, 2500).find(e => e.kind === 'like');
  ok(noImg && noImg.origin === null, 'hand entry without img -> origin null (reaction-fx falls back to bottom-left)', JSON.stringify(noImg && noImg.origin));
  // out-of-frame prediction overshoot clamps into the tile
  const over = run(new GestureDetector(), (i, t) => { if (t >= 1200) return NONE; const e = entry(thumbsUp(0.1, 0.05), 'right'); e.img = e.img.map(p => ({ x: p.x - 2, y: p.y + 2, z: p.z })); return packs(e); }, 2500).find(e => e.kind === 'like');
  ok(over && over.origin.x === 0 && over.origin.y === 1, 'img beyond the tile clamps to 0..1', JSON.stringify(over && over.origin));

  // wire: origin round trip (two u8, <= half a step), no origin -> null, legacy 16 B -> null
  const o = { x: 0.3125, y: 0.71 };
  const b = encodeReaction(4, 'love', 1000, 7, 1010, { origin: o });
  const d = decodeReaction(b);
  ok(b.byteLength === 18 && d.origin && Math.abs(d.origin.x - o.x) <= RX_ORIGIN_STEP / 2 + 1e-12 && Math.abs(d.origin.y - o.y) <= RX_ORIGIN_STEP / 2 + 1e-12 && d.name === 'love' && d.seat === 4 && d.ts === 1000, 'packet WITH origin: 18 B, origin round trip within 1/510 of the tile, other fields intact', JSON.stringify(d.origin));
  const dn = decodeReaction(encodeReaction(4, 'love', 1000, 7, 1010));
  ok(dn.byteLength === 18 && dn.origin === null, 'packet WITHOUT origin: still 18 B, origin decodes as null');
  const dl = decodeReaction(b.slice(0, RX_BYTES_LEGACY));
  ok(dl.byteLength === 16 && dl.origin === null && dl.name === 'love' && dl.seat === 4 && dl.on === true && dl.ts === 1000, 'legacy 16 B packet (pre-origin sender) decodes with origin null and every other field');
  let trunc = false; try { decodeReaction(b.slice(0, 15)); } catch (e) { trunc = e instanceof RangeError; }
  ok(trunc, '15 B is still truncated (RangeError)');
  const de = decodeReaction(encodeReaction(0, 'like', 0, 0, 0, { origin: { x: 0, y: 1 } })), dc = decodeReaction(encodeReaction(0, 'like', 0, 0, 0, { origin: { x: -3, y: 9 } }));
  ok(de.origin.x === 0 && de.origin.y === 1 && dc.origin.x === 0 && dc.origin.y === 1, 'origin corners survive exactly; out-of-range origins clamp on encode');
  ok(decodeReaction(encodeReaction(0, 'like', 0, 0, 0, { origin: { x: NaN, y: 0.5 } })).origin === null, 'a NaN origin is sent as "no origin"');
  const detEv = run(new GestureDetector(), SCRIPTS.love, TOTAL_MS.love).find(e => e.kind === 'love');
  const rt = decodeReaction(encodeReaction(2, detEv.kind, detEv.t, 1, detEv.t, detEv));
  ok(Math.abs(rt.origin.x - detEv.origin.x) <= RX_ORIGIN_STEP / 2 + 1e-12 && Math.abs(rt.origin.y - detEv.origin.y) <= RX_ORIGIN_STEP / 2 + 1e-12, 'a detector event passed straight as the options bag ({ on, slot, origin }) round-trips its origin');

  // reaction-fx placement (pure): null -> bottom-left 12 px; origin -> centred on the point, kept inside the overlay
  const c0 = originToCss(null, 320, 180);
  ok(c0.left === 12 && c0.bottom === 12 && c0.fromOrigin === false, 'originToCss(null) = bottom-left fallback (12 px)');
  const c1 = originToCss({ x: 0.5, y: 0.5 }, 320, 180);
  ok(c1.fromOrigin && c1.left === 144 && c1.bottom === 74, 'origin (0.5, 0.5) on 320x180 -> centred 32 px glyph at left 144, bottom 74', JSON.stringify(c1));
  const c2 = originToCss({ x: 0, y: 0 }, 320, 180), c3 = originToCss({ x: 1, y: 1 }, 320, 180);
  ok(c2.left === 12 && c2.bottom === 180 - 12 - 32 && c3.left === 320 - 12 - 32 && c3.bottom === 12, 'corners stay 12 px inside the overlay (top-left / bottom-right)', JSON.stringify([c2, c3]));
  ok(FX_DEFAULTS.riseFromOrigin < FX_DEFAULTS.rise && FX_DEFAULTS.edgePx === 12, 'from an origin the rise is shorter than the bottom-left rise (stays near the hands)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
