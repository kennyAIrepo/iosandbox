/**
 * gesture-reactions.js — gesture → Teams-reaction detectors over a tile's RESOLVED packs (Node + browser; three.js
 * math only, through prop-ball.js palmPose / closure).
 * ─────────────────────────────────────────────────────────────────────────────
 * Input per frame: the `{ R, L, hands:[{ mesh, slot, points, img }] }` object every tile already produces
 * (TilePipeline.packs / RemoteTile.packs = HandViews.resolve, hand-views.js:199-220): `points` = 21 world points in
 * metres, mirror space, y up; `img` = the 21 normalised selfie-mirrored landmarks (y down, 0 = tile top). When the
 * body layer runs, its 33 mirrored world points (BodyLayer.pts, body-layer.js:140) give the shoulder line instead
 * of the fixed tile fraction. Nothing here reads a handedness label or hard-codes a z sign: the inner-palm side is
 * MEASURED per pack exactly as PropBall._holdPose does (prop-ball.js:200-224 — thumb column volar of the knuckle
 * plane + fingertip curl, decay-latched), and chirality never enters the maths.
 *
 * Detectors (all with hysteresis, hold times and a per-kind cooldown, so nothing fires by accident):
 *   RAISE_HAND  open hand (closure < 0.25) · palm facing the camera · wrist in the tile's upper 38 % (img y < 0.38)
 *               or above the shoulder line when a pose is given · wrist still (< 0.3 m/s) · held 2.5 s
 *               -> { kind:'raise', on:true }; lowered / lost for 1.5 s -> { kind:'raise', on:false } (never cooled down)
 *   CLAP        both hands · palm-centre distance falls below 0.09 m from above 0.22 m and back, >= 2 times in 1.6 s
 *               -> { kind:'applause' }
 *   THUMBS_UP   thumb tip (4) the highest joint by >= 2 cm · other fingers closed (closure > 0.7) · held 0.8 s -> { kind:'like' }
 *   WAVE        open hand (closure < 0.35) · wrist lateral velocity reverses >= 3 times in 1.5 s, each swing > 0.08 m
 *               -> { kind:'wave' }  (a fast-moving wrist also resets the raise hold, so a high wave is never a raise)
 *   HEART       two hands · index tips within 5 cm · thumb tips within 5 cm · palm centres >= 0.10 m apart (not a clap)
 *               · held 0.3 s -> { kind:'love' }
 * Cooldown 3 s per kind. The per-frame path allocates nothing (state is preallocated per slot; the event object and
 * its `origin` are the only allocations and are rate-limited by the cooldown). Cost: tests/gesture-smoke.mjs (< 0.1 ms).
 *
 * Origin (emoji-origin, 2026-09-21): every event carries `origin = { x, y }` in TILE-NORMALISED coordinates (0..1, x
 * right, y down, from the `img` landmarks the detector already has — clamped to the tile): heart = midpoint of the two
 * index tips (img[8]), applause = midpoint of the two palm centres ((img[0]+img[9])/2 per hand), thumbs-up = thumb tip
 * (img[4]), wave and raise = wrist (img[0]); a lowered raise reuses the last wrist seen. `origin` is null when the hand
 * entry carries no `img` (synthetic packs) — reaction-fx.js then floats from the tile's bottom-left as before.
 * None of this needs the HoloHands overlay: the detector reads landmarks, never the rigs (docs/teams/GESTURES.md §0).
 *
 * Wire: events map 1:1 onto REACTION 0x32 (sdk/net/hand-stream.js encodeReaction / decodeReaction, RX_KIND codes;
 * origin travels as two u8, 0..255). Teams: docs/teams/GESTURES.md maps each kind onto ACS RaiseHand / Reaction.
 */
import * as THREE from 'three';
import { palmPose, closure } from './prop-ball.js';
import { RX_KIND, RX_KIND_NAME } from '../net/hand-stream.js';

export { RX_KIND, RX_KIND_NAME };

export const GESTURE_DEFAULTS = Object.freeze({
  // raise hand
  raiseHoldMs: 2500, raiseLowerMs: 1500,
  raiseOpen: 0.25, raiseOpenHyst: 0.35,           // closure gate (enter / keep)
  raiseTop: 0.38, raiseTopHyst: 0.44,             // img y fraction from the tile top (enter / keep)
  raiseFacing: 0.30, raiseFacingHyst: 0.10,       // inner-normal · to-camera (enter / keep)
  raiseStill: 0.30,                               // m/s — a faster wrist resets the hold (a wave is not a raise)
  shoulderMargin: 0.02,                           // m above the shoulder line when a pose is given
  fovDeg: 60, mirrorDist: 2.0,                    // fallback raise line when a hand entry carries no img and no pose
  // clap
  clapNear: 0.09, clapFar: 0.22, clapWindowMs: 1600, clapCount: 2,
  // thumbs up
  likeHoldMs: 800, likeClosure: 0.70, likeThumbLead: 0.02,
  // wave
  waveOpen: 0.35, waveReversals: 3, waveWindowMs: 1500, waveAmp: 0.08, waveDeadband: 0.12,   // deadband in m/s
  // heart
  loveTouch: 0.05, loveApart: 0.10, loveHoldMs: 300,
  // all
  cooldownMs: 3000,
});

const RING = 8;
const _cam = new THREE.Vector3(), _v = new THREE.Vector3();

const slotState = () => ({
  present: false, seen: 0, pack: null,             // seen = frames since entry; pack = the current points (no copy)
  x: 0, y: 0, z: 0, vx: 0, vy: 0, imgY: NaN,
  img: null, ox: NaN, oy: NaN,                     // img = the 21 tile-normalised landmarks (no copy); ox/oy = last wrist img seen
  closure: 0, facing: 0, sign: 0, evi: 0,
  pc: new THREE.Vector3(), q: new THREE.Quaternion(), n: new THREE.Vector3(),
  raiseSince: -1, raiseHi: false,
  likeSince: -1,
  wave: { sign: 0, lastX: 0, times: new Float64Array(RING), n: 0 },
});

/** Inner-palm side, MEASURED (the maths of prop-ball.js _holdPose:207-220): thumb column + fingertip curl volar of the
 *  knuckle plane, normalised by the palm span, decay-latched per slot. Writes S.pc, S.n (unit inner normal) and
 *  S.sign (0 = side not yet known). Returns false on a degenerate pack. */
function innerNormal(S, pack) {
  if (!palmPose(pack, S.pc, S.q)) { S.sign = 0; return false; }
  S.n.set(0, 0, 1).applyQuaternion(S.q);                       // makeBasis z column = cross(wrist->middle, pinky->index)
  const p0 = pack[0], span = _v.set(pack[9].x - p0.x, pack[9].y - p0.y, pack[9].z - p0.z).length();
  if (span < 1e-4) { S.sign = 0; return false; }
  let volar = 0;
  for (let i = 1; i <= 2; i++) { const q = pack[i]; volar += (q.x - p0.x) * S.n.x + (q.y - p0.y) * S.n.y + (q.z - p0.z) * S.n.z; }
  for (let i = 8; i <= 20; i += 4) { const q = pack[i]; volar += ((q.x - S.pc.x) * S.n.x + (q.y - S.pc.y) * S.n.y + (q.z - S.pc.z) * S.n.z) * 0.5; }
  volar /= span;
  S.evi = S.sign === 0 ? volar : S.evi * 0.85 + volar * 0.15;
  if (S.sign === 0 || Math.abs(S.evi) > 0.04) S.sign = S.evi >= 0 ? 1 : (S.evi < 0 ? -1 : 0);
  if (S.sign !== 0) S.n.multiplyScalar(S.sign);
  return true;
}

function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

// ── origin helpers: tile-normalised { x, y } (0..1, y down) from the img landmarks; null when no img ─────────────
const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : (v === v ? v : 0));
const _pa = { x: 0, y: 0 }, _pb = { x: 0, y: 0 };               // scratch palm centres (no per-frame allocation)
/** The one allocation per event: a fresh { x, y } clamped into the tile; null for a missing / NaN point. */
export function makeOrigin(x, y) { return (x != null && y != null && x === x && y === y) ? { x: clamp01(+x), y: clamp01(+y) } : null; }
function pointOrigin(img, i) { const p = img && img[i]; return p ? makeOrigin(p.x, p.y) : null; }
function wristOrigin(S) { return pointOrigin(S.img, 0); }
function lastWristOrigin(S) { return S.img ? wristOrigin(S) : makeOrigin(S.ox, S.oy); }
/** Palm centre in the image = midpoint of the wrist (0) and the middle MCP (9) — the same pair palmPose spans in 3D. */
function palmImg(img, out) { if (!img || !img[0] || !img[9]) return null; out.x = (img[0].x + img[9].x) * 0.5; out.y = (img[0].y + img[9].y) * 0.5; return out; }
function midOrigin(a, b) { if (!a || !b) return a ? makeOrigin(a.x, a.y) : b ? makeOrigin(b.x, b.y) : null; return makeOrigin((a.x + b.x) * 0.5, (a.y + b.y) * 0.5); }

export class GestureDetector {
  /**
   * @param {object} opts   any GESTURE_DEFAULTS key; plus
   *   camera   the tile camera (its position is the "facing" target); default: the origin (the pack-gen convention:
   *            camera at 0 looking down -z, hand plane at z = -mirrorDist)
   *   onEvent  (ev) => void   ev = { kind, code, on, slot, t, origin }  kind = RX_KIND_NAME, code = RX_KIND, slot 'left'|'right'|null,
   *            origin = { x, y } tile-normalised (0..1, y down) at the gesture's landmark, or null (no img on the hand entry)
   */
  constructor(opts = {}) {
    this.cfg = Object.assign({}, GESTURE_DEFAULTS, opts);
    this.camera = opts.camera || null;
    this.onEvent = opts.onEvent || null;
    this.S = { left: slotState(), right: slotState() };
    this.raised = false; this.raisedSlot = null; this.lowerSince = -1;
    this.clap = { armed: false, times: new Float64Array(RING), n: 0, d: Infinity };
    this.loveSince = -1;
    this._last = new Float64Array(16).fill(-Infinity);          // last fire per kind code (cooldown)
    this._raiseLineY = (0.5 - this.cfg.raiseTop) * 2 * Math.tan(this.cfg.fovDeg * 0.5 * Math.PI / 180) * this.cfg.mirrorDist;
    this._t = -1;
    this.events = 0; this.suppressed = 0;
    this._listeners = [];
  }
  /** Extra listener (besides opts.onEvent). Returns an unsubscribe function. */
  listen(fn) { this._listeners.push(fn); return () => { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); }; }

  reset() {
    this._drop(this.S.left); this._drop(this.S.right);
    this.S.left.present = this.S.right.present = false;
    this.raised = false; this.raisedSlot = null; this.lowerSince = -1;
    this.clap.armed = false; this.clap.n = 0; this.clap.d = Infinity; this.loveSince = -1;
    this._last.fill(-Infinity); this._t = -1;
  }

  /**
   * One frame.
   * @param {number} tMs   session-clock ms
   * @param {{R,L,hands:Array<{slot,points,img}>}|null} packs   the tile's resolved packs (null / empty = no hands)
   * @param {Array<{x,y,z}>|null} body   33 mirrored world pose points (BodyLayer.pts) or null
   * @returns {number} events emitted this frame
   */
  update(tMs, packs, body = null) {
    const dt = this._t < 0 ? 1 / 30 : Math.max(1e-3, (tMs - this._t) * 0.001);
    this._t = tMs;
    const before = this.events;
    const L = this.S.left, R = this.S.right;
    L.present = false; R.present = false;
    const hands = packs && packs.hands;
    if (hands) for (let k = 0; k < hands.length && k < 2; k++) {
      const h = hands[k]; if (!h || !h.points || !h.points[0]) continue;
      this._measure(h.slot === 'left' ? L : R, h, dt);
    }
    if (!L.present) this._drop(L); if (!R.present) this._drop(R);
    this._raise(tMs, L, R, body);
    this._like(tMs, L, 'left'); this._like(tMs, R, 'right');
    this._wave(tMs, L, 'left'); this._wave(tMs, R, 'right');
    this._clap(tMs, L, R);
    this._love(tMs, L, R);
    return this.events - before;
  }

  _measure(S, h, dt) {
    const p = h.points, w = p[0];
    if (S.seen === 0) { S.vx = 0; S.vy = 0; S.wave.lastX = w.x; S.wave.sign = 0; S.wave.n = 0; S.sign = 0; S.evi = 0; }
    else { S.vx = (w.x - S.x) / dt; S.vy = (w.y - S.y) / dt; }
    S.present = true; S.seen++; S.pack = p;
    S.x = w.x; S.y = w.y; S.z = w.z;
    S.img = (h.img && h.img[0]) ? h.img : null;
    S.imgY = S.img ? S.img[0].y : NaN;
    if (S.img) { S.ox = S.img[0].x; S.oy = S.img[0].y; }
    S.closure = closure(p);
    if (innerNormal(S, p)) {
      if (this.camera) _cam.copy(this.camera.position); else _cam.set(0, 0, 0);
      _v.subVectors(_cam, S.pc); const l = _v.length();
      S.facing = l > 1e-6 ? S.n.dot(_v) / l : 0;
      if (S.sign === 0) S.facing = Math.abs(S.facing);         // side not yet latched: the palm PLANE faces the camera
    } else S.facing = 0;
  }
  _drop(S) { S.seen = 0; S.pack = null; S.img = null; S.raiseSince = -1; S.raiseHi = false; S.likeSince = -1; S.wave.n = 0; S.wave.sign = 0; S.closure = 0; S.facing = 0; S.imgY = NaN; S.sign = 0; S.evi = 0; }

  _high(S, body, hyst) {
    if (body && body[11] && body[12]) return S.y > (body[11].y + body[12].y) * 0.5 + this.cfg.shoulderMargin;
    if (S.imgY === S.imgY) return S.imgY < (hyst ? this.cfg.raiseTopHyst : this.cfg.raiseTop);   // (NaN check)
    const camY = this.camera ? this.camera.position.y : 0;
    return S.y - camY > this._raiseLineY * (hyst ? 0.85 : 1);
  }
  _raiseOk(S, body) {
    if (!S.present) return false;
    const c = this.cfg, hyst = S.raiseHi;
    if (S.closure >= (hyst ? c.raiseOpenHyst : c.raiseOpen)) return false;
    if (S.facing < (hyst ? c.raiseFacingHyst : c.raiseFacing)) return false;
    if (Math.abs(S.vx) > c.raiseStill || Math.abs(S.vy) > c.raiseStill) return false;
    return this._high(S, body, hyst);
  }
  _raise(t, L, R, body) {
    const c = this.cfg; let anyHi = false, hiSlot = null;
    for (let k = 0; k < 2; k++) {
      const S = k ? R : L, slot = k ? 'right' : 'left';
      if (this._raiseOk(S, body)) {
        if (!S.raiseHi) { S.raiseHi = true; S.raiseSince = t; }
        anyHi = true; if (!hiSlot) hiSlot = slot;
        if (!this.raised && t - S.raiseSince >= c.raiseHoldMs && this._fire(t, 'raise', true, slot, wristOrigin(S))) { this.raised = true; this.raisedSlot = slot; this.lowerSince = -1; }
      } else { S.raiseHi = false; S.raiseSince = -1; }
    }
    if (!this.raised) return;
    if (anyHi) { this.lowerSince = -1; this.raisedSlot = hiSlot; return; }
    if (this.lowerSince < 0) this.lowerSince = t;
    else if (t - this.lowerSince >= c.raiseLowerMs) {
      const S = this.raisedSlot === 'left' ? L : R;                // the hand may be gone: last wrist seen (ox/oy survive _drop)
      this.raised = false; this._emit(t, 'raise', false, this.raisedSlot, lastWristOrigin(S)); this.raisedSlot = null; this.lowerSince = -1;
    }
  }
  _like(t, S, slot) {
    const c = this.cfg, p = S.pack;
    let ok = S.present && !!p && S.closure > c.likeClosure;
    if (ok) { const ty = p[4].y - c.likeThumbLead; for (let i = 0; i < 21; i++) { if (i !== 4 && p[i].y > ty) { ok = false; break; } } }
    if (!ok) { S.likeSince = -1; return; }
    if (S.likeSince < 0) S.likeSince = t;
    else if (t - S.likeSince >= c.likeHoldMs) { S.likeSince = this._fire(t, 'like', true, slot, pointOrigin(S.img, 4)) ? -1 : t; }
  }
  _wave(t, S, slot) {
    const c = this.cfg, W = S.wave;
    if (!S.present || S.seen < 2) return;
    if (S.closure >= c.waveOpen) { W.n = 0; W.sign = 0; W.lastX = S.x; return; }
    const v = S.vx;
    if (Math.abs(v) > c.raiseStill) { S.raiseSince = -1; S.raiseHi = false; }
    if (W.n && t - W.times[(W.n - 1) % RING] > c.waveWindowMs) W.n = 0;
    if (Math.abs(v) <= c.waveDeadband) return;
    const O = S === this.S.left ? this.S.right : this.S.left;    // the other hand moving AGAINST this one = clapping, not waving
    if (O.present && O.seen > 1 && Math.abs(O.vx) > c.waveDeadband && O.vx * v < 0) { W.n = 0; W.sign = 0; W.lastX = S.x; return; }
    const s = v > 0 ? 1 : -1;
    if (W.sign !== 0 && s !== W.sign) {                          // a reversal of the lateral velocity
      if (Math.abs(S.x - W.lastX) > c.waveAmp) { W.times[W.n % RING] = t; W.n++; } else W.n = 0;
      W.lastX = S.x;
      let cnt = 0; for (let i = Math.max(0, W.n - RING); i < W.n; i++) if (t - W.times[i % RING] <= c.waveWindowMs) cnt++;
      if (cnt >= c.waveReversals && this._fire(t, 'wave', true, slot, wristOrigin(S))) W.n = 0;
    }
    W.sign = s;
  }
  _clap(t, L, R) {
    const c = this.cfg, C = this.clap;
    if (!L.present || !R.present) { C.armed = false; C.d = Infinity; return; }
    const d = C.d = L.pc.distanceTo(R.pc);
    if (C.n && t - C.times[(C.n - 1) % RING] > c.clapWindowMs) C.n = 0;
    if (d > c.clapFar) C.armed = true;
    else if (d < c.clapNear && C.armed) {
      C.armed = false; C.times[C.n % RING] = t; C.n++;
      let cnt = 0; for (let i = Math.max(0, C.n - RING); i < C.n; i++) if (t - C.times[i % RING] <= c.clapWindowMs) cnt++;
      if (cnt >= c.clapCount && this._fire(t, 'applause', true, null, midOrigin(palmImg(L.img, _pa), palmImg(R.img, _pb)))) C.n = 0;
    }
  }
  _love(t, L, R) {
    const c = this.cfg, a = L.pack, b = R.pack;
    const ok = L.present && R.present && !!a && !!b
      && dist(a[8], b[8]) < c.loveTouch && dist(a[4], b[4]) < c.loveTouch && L.pc.distanceTo(R.pc) >= c.loveApart;
    if (!ok) { this.loveSince = -1; return; }
    if (this.loveSince < 0) this.loveSince = t;
    else if (t - this.loveSince >= c.loveHoldMs) { this.loveSince = this._fire(t, 'love', true, null, midOrigin(L.img && L.img[8], R.img && R.img[8])) ? -1 : t; }
  }
  /** cooldown-gated emit; returns true when the event went out */
  _fire(t, kind, on, slot, origin = null) {
    const code = RX_KIND[kind];
    if (t - this._last[code] < this.cfg.cooldownMs) { this.suppressed++; return false; }
    this._last[code] = t;
    this._emit(t, kind, on, slot, origin);
    return true;
  }
  _emit(t, kind, on, slot, origin = null) {
    const ev = { kind, code: RX_KIND[kind], on, slot, t, origin };
    this.events++;
    if (this.onEvent) this.onEvent(ev);
    for (let i = 0; i < this._listeners.length; i++) this._listeners[i](ev);
  }
}

/** Reaction kinds Teams itself can show (ACS Features.Reaction) vs the ones only the in-tile overlay shows. */
export const TEAMS_REACTIONS = Object.freeze(['like', 'love', 'applause', 'laugh', 'surprised']);
export const OVERLAY_ONLY = Object.freeze(['wave']);
