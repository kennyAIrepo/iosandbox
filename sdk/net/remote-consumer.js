/**
 * remote-consumer.mjs — RemoteHands: the packet consumer that replaces a remote seat's TilePipeline
 * (research/codebase/multi-person.md §2.2). DOM-free, no three.js, no timers.
 * ─────────────────────────────────────────────────────────────────────────────
 * Per seat it keeps the LATEST accepted HAND_STREAM packet (wrap-safe `seqNewer16`, stale packets dropped —
 * sync-protocol.md §7 rule 4) and `read(nowMs)` returns the PlayerPipeline output shape
 *   { hands: { left: {img, world}|null, right: {img, world}|null } }
 * plus ageMs / seq / alpha, so the receiving tile runs the unchanged chain of tile-pipeline.js:86-97:
 *   views.dropSlot(slot) after 400 ms absence  →  views.resolve([left, right], camera)  →  rig.pose / HandBody.update / PropBall.update.
 *
 * Rules (hopeos-wire.md §1):
 *   • NEVER flips, mirrors, relabels or re-filters a coordinate. `img` stays in the SENDER's mirrored space, `world`
 *     stays raw metric. Chirality and z-sign are measured by the receiver's own HandViews on these points.
 *   • No One-Euro here: the sender's pipeline already filtered and predicted (player-pipeline.js:203-208). What the
 *     network adds is jitter/latency, so the only smoothing knob is `predMs`: an OPTIONAL linear extrapolation from the
 *     last two accepted packets, default 0 (off), capped at REMOTE.MAX_PRED_MS = 100 (the memo: "a missing third packet
 *     extrapolates for up to 100 ms and then holds"), disabled once the newest packet is older than REMOTE.HOLD_MS.
 *   • alpha = handAgeAlpha(ageMs) from research/game/examples/latency-cues.mjs:127 (1 until 150 ms, then linear to 0.5 at
 *     400 ms). That module imports 'three' (browser-only), so the function is COPIED verbatim below and wire-smoke.mjs
 *     asserts the copy against the canonical source text; in the browser pass `{ alpha: handAgeAlpha }` from latency-cues.
 *   • ageMs = dt32(nowMs, packet.t): both must be on the SAME session clock (SharedClock.now() / Live Share global time —
 *     hopeos-wire.md §5). Before the clock is synced the age is meaningless; `sinceArrivalMs` (local) is exposed for HUDs.
 *
 * Output arrays are reused between reads (like HandFilterBank.predicted, sdk/core/filters.js:128-140): copy them if you
 * keep references across frames.
 */
import { PK, readHeader, seqNewer16, dt32 } from '../game/ball-net.js';
import { decodeHandStream, SLOTS } from './hand-stream.js';

export const REMOTE = Object.freeze({
  MAX_PRED_MS: 100,     // extrapolation cap (memo: up to 100 ms, then hold)
  HOLD_MS: 250,         // newest packet older than this → hold, never extrapolate
  MAX_STEP_MS: 200,     // two packets further apart than this are not a usable velocity sample
  DROP_SLOT_MS: 400,    // the tile-pipeline.js:87-88 / handlab.html:912-916 rule: reset HandViews latches after this absence
});

/** Verbatim copy of latency-cues.mjs:127 (browser-only module). 1 until 150 ms, then linear to 0.5 at 400 ms. */
export function handAgeAlpha(ageMs) { return ageMs <= 150 ? 1 : Math.max(0.5, 1 - (ageMs - 150) / 500); }

function fresh21() { const a = new Array(21); for (let i = 0; i < 21; i++) a[i] = { x: 0, y: 0, z: 0 }; return a; }
function newTarget() { return { hands: { left: null, right: null }, _b: { left: null, right: null } }; }

export class RemoteSeat {
  /**
   * @param {number} seat
   * @param {{alpha?:(ageMs:number)=>number, predMs?:number, localNow?:()=>number}} o
   */
  constructor(seat, { alpha = handAgeAlpha, predMs = 0, localNow = null } = {}) {
    this.seat = seat; this.alpha = alpha; this.predMs = predMs;
    this.localNow = localNow || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.cur = null; this.prev = null;
    this._ring = [newTarget(), newTarget(), newTarget()]; this._k = 0;   // 3 decode targets: cur, prev, next
    this._out = { left: { img: fresh21(), world: fresh21() }, right: { img: fresh21(), world: fresh21() } };
    this._hands = { left: null, right: null };
    this.lastSeen = { left: -Infinity, right: -Infinity };               // session-clock t of the last packet with that slot
    this.arrivedAt = -Infinity;                                          // local clock of the last ACCEPTED packet
    this.stats = { accepted: 0, stale: 0, gaps: 0, lastSeq: -1 };
  }

  /** Decode + accept an ArrayBuffer (already known to be HAND_STREAM for this seat). */
  pushBytes(buf) {
    const target = this._ring[this._k];
    const pkt = decodeHandStream(buf, { out: target });
    if (!this._accept(pkt)) return false;
    this._k = (this._k + 1) % 3;                                         // the accepted target is now `cur`; keep rotating
    return true;
  }
  /** Accept an already-decoded packet object (kept by reference). */
  push(pkt) { return this._accept(pkt); }

  _accept(pkt) {
    if (this.cur && !seqNewer16(pkt.seq, this.cur.seq)) { this.stats.stale++; return false; }   // latest-wins
    if (this.cur) { const gap = (pkt.seq - this.cur.seq) & 0xffff; if (gap > 1) this.stats.gaps += gap - 1; }
    this.prev = this.cur; this.cur = pkt;
    this.stats.accepted++; this.stats.lastSeq = pkt.seq;
    this.arrivedAt = this.localNow();
    for (const s of SLOTS) if (pkt.hands[s]) this.lastSeen[s] = pkt.t;
    return true;
  }

  /** ms since this slot was last present, on the session clock (Infinity if never). Feed the DROP_SLOT_MS rule. */
  slotAbsentMs(slot, nowMs) { const t = this.lastSeen[slot]; return t === -Infinity ? Infinity : Math.max(0, dt32(nowMs, t)); }

  /**
   * @param {number} nowMs   session clock (the same clock that stamped packet.t)
   * @param {{predMs?:number}} o
   * @returns {{hands:{left,right}, ageMs:number, sinceArrivalMs:number, seq:number, t:number, alpha:number,
   *            present:{left:boolean,right:boolean}, hold:{mode,slot}|null, extrapolatedMs:number, seat:number}}
   */
  read(nowMs, { predMs } = {}) {
    const cur = this.cur, hands = this._hands;
    if (!cur) {
      hands.left = hands.right = null;
      return { hands, ageMs: Infinity, sinceArrivalMs: Infinity, seq: -1, t: 0, alpha: 0, present: { left: false, right: false }, hold: null, extrapolatedMs: 0, seat: this.seat };
    }
    const ageMs = Math.max(0, dt32(nowMs, cur.t));
    const lead = Math.min(REMOTE.MAX_PRED_MS, Math.max(0, predMs ?? this.predMs));
    const prev = this.prev;
    const dtPk = prev ? dt32(cur.t, prev.t) : 0;
    const canPred = lead > 0 && ageMs <= REMOTE.HOLD_MS && prev && dtPk > 0 && dtPk <= REMOTE.MAX_STEP_MS;
    let applied = 0;
    for (const s of SLOTS) {
      const h = cur.hands[s];
      if (!h) { hands[s] = null; continue; }
      const o = this._out[s], p = canPred && prev.hands[s] ? prev.hands[s] : null;
      const k = p ? lead / dtPk : 0;
      copyOrExtrapolate(o.img, h.img, p ? p.img : null, k);
      let world = null;
      if (h.world) { copyOrExtrapolate(o.world, h.world, p && p.world ? p.world : null, k); world = o.world; }
      if (p) applied = lead;
      hands[s] = { img: o.img, world };
    }
    return { hands, ageMs, sinceArrivalMs: Math.max(0, this.localNow() - this.arrivedAt), seq: cur.seq, t: cur.t, alpha: this.alpha(ageMs),
      present: { left: !!hands.left, right: !!hands.right }, hold: cur.hold || null, extrapolatedMs: applied, seat: this.seat };
  }
}

/** out[i] = cur[i] + (cur[i] - prev[i]) * k  (k = 0 or prev = null → plain copy). Same for every axis: no axis is treated specially. */
function copyOrExtrapolate(out, cur, prev, k) {
  for (let i = 0; i < 21; i++) {
    const c = cur[i], o = out[i];
    if (prev && k > 0) { const p = prev[i]; o.x = c.x + (c.x - p.x) * k; o.y = c.y + (c.y - p.y) * k; o.z = c.z + (c.z - p.z) * k; }
    else { o.x = c.x; o.y = c.y; o.z = c.z; }
  }
}

/** All remote seats on one transport. `onMessage(buf)` is the demux entry: returns true when the packet was ours. */
export class RemoteHands {
  constructor(opts = {}) { this.opts = opts; this.seats = new Map(); this.ignored = 0; }
  seat(seat) { let s = this.seats.get(seat); if (!s) { s = new RemoteSeat(seat, this.opts); this.seats.set(seat, s); } return s; }
  has(seat) { return this.seats.has(seat); }
  forget(seat) { this.seats.delete(seat); }
  list() { return [...this.seats.keys()]; }
  /**
   * @param {ArrayBuffer|object} pktOrBuf  raw bytes from the transport, or a decoded HAND_STREAM packet
   * @returns {boolean} accepted (false: stale, or not a HAND_STREAM packet)
   */
  push(pktOrBuf) {
    if (pktOrBuf instanceof ArrayBuffer) {
      if (pktOrBuf.byteLength < 12 || readHeader(pktOrBuf).type !== PK.HAND_STREAM) { this.ignored++; return false; }
      const seat = new DataView(pktOrBuf).getUint8(8);
      return this.seat(seat).pushBytes(pktOrBuf);
    }
    if (!pktOrBuf || pktOrBuf.type !== PK.HAND_STREAM) { this.ignored++; return false; }
    return this.seat(pktOrBuf.seat).push(pktOrBuf);
  }
  /** transport.onMessage(buf => remote.onMessage(buf)) — BallNet has its own listener on the same transport. */
  onMessage(buf) { return this.push(buf); }
  read(seat, nowMs, o) { const s = this.seats.get(seat); return s ? s.read(nowMs, o) : new RemoteSeat(seat, this.opts).read(nowMs, o); }
  /** slots whose absence crossed DROP_SLOT_MS since the last call — call views.dropSlot(slot) for each (tile-pipeline.js:87-88) */
  slotsToDrop(seat, nowMs) {
    const s = this.seats.get(seat); if (!s) return [];
    const out = [];
    s._dropped = s._dropped || { left: true, right: true };
    for (const slot of SLOTS) {
      const present = !!(s.cur && s.cur.hands[slot]);
      if (present) s._dropped[slot] = false;
      else if (!s._dropped[slot] && s.slotAbsentMs(slot, nowMs) > REMOTE.DROP_SLOT_MS) { s._dropped[slot] = true; out.push(slot); }
    }
    return out;
  }
}
