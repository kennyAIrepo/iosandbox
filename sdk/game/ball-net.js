/**
 * ball-net.mjs — ownership-authoritative ball sync (codec + shared clock + owner/receiver/host state machine).
 * ─────────────────────────────────────────────────────────────────────────────
 * One owner simulates; everyone else dead-reckons and renders. A throw publishes
 * the scheduled boundary crossing (tEdge on the shared clock); the receiving
 * tile claims ownership when that time passes — no round trip at the boundary.
 *
 * Precedents (verified 2026-09-18):
 *   Gaffer on Games, Networked Physics in VR — "Once a cube is owned by a player, no other player could
 *   take ownership until that player reliquished ownership"; "Ownership sequence increments each time a
 *   player grabs a cube. Ownership is stronger than authority, such that an increase in ownership sequence
 *   wins over an increase in authority sequence number" (https://gafferongames.com/post/networked_physics_in_virtual_reality/).
 *   Unity Netcode 2.11 — "In a distributed authority topology, the owner of a NetworkObject is always the
 *   authority for that NetworkObject"; ChangeOwnership / RequestOwnership / RemoveOwnership / SetOwnershipLock
 *   (https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@2.11/manual/components/core/networkobject-ownership.html).
 *   Live Share LiveEvent.isNewer() — "When the received event has the same timestamp as the current event, each
 *   events clientId will be used as a tie breaker. The clientId containing the lower sort order wins any ties"
 *   (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveevent) — our equal-ownerSeq tie-break.
 *
 * Wire format: sync-protocol.md §6 (little-endian DataView). Transport: any object with
 * { id, send(bytes, {reliable}), onMessage(cb) } — see transports.mjs. Court: CourtMap (court-map.mjs).
 * No browser APIs and no timers: everything advances from tick()/tickOwner() and the injected clock,
 * so the same code runs headless (smoke-test.mjs) and in a rAF loop.
 */
import { EDGE, SEAT_NONE, integrateCourt } from './court-map.js';   // PATCHED (wire-protocol gap): canonical court-map, unchanged

// ── packet types & enums ─────────────────────────────────────────────────────
export const PK = Object.freeze({
  CLOCK_PING: 0x01, CLOCK_PONG: 0x02,
  BALL_STATE: 0x10, LAUNCH: 0x11, CLAIM: 0x12, ACK: 0x13, GOAL: 0x14,
  SEAT_MAP: 0x20, PRESENCE: 0x21, HAND_STREAM: 0x30,   // PRESENCE 0x21: roster JSON consumed by sdk/net/room.js; _onPacket default: ignores it
  SCORE: 0x31, REACTION: 0x32,                         // SCORE (sdk/net/score-packet.js, host leaderboard) and REACTION (sdk/net/hand-stream.js, gestures): BallNet ignores both
});
export const HOLD = Object.freeze({ FREE: 0, CRADLE: 1, WRAP: 2, CLIP: 3 });
export const REASON = Object.freeze({ THROW: 0, ROLL: 1, BAT: 2, RESPAWN: 3, PORTAL: 4 });
export const CLAIM_REASON = Object.freeze({ BOUNDARY: 0, TOUCH: 1, PROXY: 2, RECOVERY: 3, RESPAWN: 4 });
export const FLAG = Object.freeze({ FROM_HOST: 1, PROXY: 2 });
export const TUNING = Object.freeze({
  MIN_LEAD_MS: 80,            // boundary stretch floor: the ball never appears sooner than this after the receiver learned of it
  HANDOFF_TIMEOUT_MS: 250,    // thrower gives up ownership this long after tEdge even without a CLAIM
  OWNER_SILENCE_MS: 1000,     // host recovers a vanished owner after this silence
  REST_TO_GUTTER_MS: 8000,    // a ball resting on a floor this long sinks to the gutter and respawns
  RESPAWN_TRANSIT_MS: 600,    // gutter travel time of a respawn
  LAUNCH_REPEATS: 3, LAUNCH_REPEAT_GAP_MS: 16,   // extra unreliable copies of a LAUNCH (belt and braces on a TCP relay)
});
const PROTO_VER = 1;
const LE = true;

// ── quantization helpers (symmetric on both ends, so extrapolation matches) ──
const q1000 = v => Math.max(-32768, Math.min(32767, Math.round(v * 1000)));
const q10000 = v => Math.max(-32768, Math.min(32767, Math.round(v * 10000)));
const q100 = v => Math.max(-32768, Math.min(32767, Math.round(v * 100)));
const u32 = t => (t >>> 0);                       // session clock ms, wraps ~49.7 days
/** wrap-safe "a is newer than b" for u16 / u8 sequence numbers */
export const seqNewer16 = (a, b) => a !== b && ((a - b) & 0xffff) < 0x8000;
export const seqNewer8 = (a, b) => a !== b && ((a - b) & 0xff) < 0x80;
/** wrap-safe signed difference of u32 clocks (a - b) in ms */
export const dt32 = (a, b) => ((a - b) | 0);

// PATCHED (wire-protocol gap): the 8-byte header writer is exported as `writeHeader` so hand-stream.mjs shares it
// (the canonical file keeps it module-private, ball-net.mjs:59). `PROTO_VER` is exported for the same reason.
export { PROTO_VER };
export function writeHeader(view, type, seq, t, flags = 0) { return header(view, type, seq, t, flags); }
function header(view, type, seq, t, flags = 0) {
  view.setUint8(0, type);
  view.setUint8(1, (flags & 0x0f) | (PROTO_VER << 4));
  view.setUint16(2, seq & 0xffff, LE);
  view.setUint32(4, u32(t), LE);
}
export function readHeader(buf) {
  const v = new DataView(buf);
  return { type: v.getUint8(0), flags: v.getUint8(1) & 0x0f, ver: v.getUint8(1) >> 4, seq: v.getUint16(2, LE), t: v.getUint32(4, LE) };
}

// ── BALL_STATE 0x10 (34 B + optional 14 B hold trailer) ──────────────────────
export function encodeBallState(s, seq, flags = 0) {
  const h = s.hold || { mode: HOLD.FREE, slot: 0 };
  const held = h.mode !== HOLD.FREE;
  const buf = new ArrayBuffer(34 + (held ? 14 : 0));
  const v = new DataView(buf);
  header(v, PK.BALL_STATE, seq, s.t, flags);
  v.setUint8(8, s.owner);
  v.setUint8(9, s.ownerSeq & 0xff);
  v.setUint8(10, (h.mode & 3) | ((h.slot ? 1 : 0) << 2) | ((s.atRest ? 1 : 0) << 3) | ((s.inTransit ? 1 : 0) << 4) | ((s.onFloor ? 1 : 0) << 5));
  v.setUint8(11, s.seat);
  v.setInt16(12, q1000(s.x), LE); v.setInt16(14, q1000(s.y), LE); v.setInt16(16, q10000(s.d ?? 0), LE);
  v.setInt16(18, q1000(s.vx), LE); v.setInt16(20, q1000(s.vy), LE); v.setInt16(22, q1000(s.vd ?? 0), LE);
  v.setInt16(24, q100(s.wx ?? 0), LE); v.setInt16(26, q100(s.wy ?? 0), LE); v.setInt16(28, q100(s.wz ?? 0), LE);
  v.setUint16(30, Math.round(s.radius * 10000), LE);
  v.setUint8(32, s.launchSeq & 0xff);
  v.setUint8(33, held ? 1 : 0);
  if (held) {
    // palm-local offset in hand-span units + smallest-three quaternion (largest component dropped, kept positive)
    v.setInt16(34, q10000(h.ox), LE); v.setInt16(36, q10000(h.oy), LE); v.setInt16(38, q10000(h.oz), LE);
    const q = [h.qx, h.qy, h.qz, h.qw];
    let big = 0; for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[big])) big = i;
    const sign = q[big] < 0 ? -1 : 1;
    const rest = q.map(c => c * sign).filter((_, i) => i !== big);
    v.setInt16(40, q10000(rest[0]), LE); v.setInt16(42, q10000(rest[1]), LE); v.setInt16(44, q10000(rest[2]), LE);
    v.setUint8(46, big); v.setUint8(47, 0);
  }
  return buf;
}
export function decodeBallState(buf) {
  const v = new DataView(buf), hd = readHeader(buf);
  const hb = v.getUint8(10);
  const s = {
    ...hd, owner: v.getUint8(8), ownerSeq: v.getUint8(9), seat: v.getUint8(11),
    hold: { mode: hb & 3, slot: (hb >> 2) & 1 }, atRest: !!(hb & 8), inTransit: !!(hb & 16), onFloor: !!(hb & 32),
    x: v.getInt16(12, LE) / 1000, y: v.getInt16(14, LE) / 1000, d: v.getInt16(16, LE) / 10000,
    vx: v.getInt16(18, LE) / 1000, vy: v.getInt16(20, LE) / 1000, vd: v.getInt16(22, LE) / 1000,
    wx: v.getInt16(24, LE) / 100, wy: v.getInt16(26, LE) / 100, wz: v.getInt16(28, LE) / 100,
    radius: v.getUint16(30, LE) / 10000, launchSeq: v.getUint8(32),
  };
  if (v.getUint8(33) && buf.byteLength >= 48) {
    const h = s.hold;
    h.ox = v.getInt16(34, LE) / 10000; h.oy = v.getInt16(36, LE) / 10000; h.oz = v.getInt16(38, LE) / 10000;
    const r = [v.getInt16(40, LE) / 10000, v.getInt16(42, LE) / 10000, v.getInt16(44, LE) / 10000];
    const big = v.getUint8(46);
    const q = []; let k = 0;
    for (let i = 0; i < 4; i++) q[i] = i === big ? 0 : r[k++];
    q[big] = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2] - q[3] * q[3]));
    [h.qx, h.qy, h.qz, h.qw] = q;
  }
  if (s.atRest) s.vx = s.vy = s.vd = s.wx = s.wy = s.wz = 0;   // Gaffer's at-rest rule: no velocities for resting objects
  return s;
}

// ── LAUNCH 0x11 (42 B) ───────────────────────────────────────────────────────
export function encodeLaunch(l, seq, flags = 0) {
  const buf = new ArrayBuffer(42), v = new DataView(buf);
  header(v, PK.LAUNCH, seq, l.t, flags);
  v.setUint8(8, l.from); v.setUint8(9, l.to); v.setUint8(10, l.ownerSeq & 0xff); v.setUint8(11, l.launchSeq & 0xff);
  v.setUint8(12, l.reason); v.setUint8(13, l.edge);
  v.setInt16(14, q1000(l.x), LE); v.setInt16(16, q1000(l.y), LE); v.setInt16(18, q10000(l.d ?? 0), LE);
  v.setInt16(20, q1000(l.vx), LE); v.setInt16(22, q1000(l.vy), LE); v.setInt16(24, q1000(l.vd ?? 0), LE);
  v.setInt16(26, q100(l.wx ?? 0), LE); v.setInt16(28, q100(l.wy ?? 0), LE); v.setInt16(30, q100(l.wz ?? 0), LE);
  v.setUint32(32, u32(l.tEdge), LE);
  v.setInt16(36, q1000(l.cEdge), LE);
  v.setUint16(38, Math.round(l.radius * 10000), LE);
  v.setUint8(40, l.ownerSeat); v.setUint8(41, 0);
  return buf;
}
export function decodeLaunch(buf) {
  const v = new DataView(buf), hd = readHeader(buf);
  return {
    ...hd, from: v.getUint8(8), to: v.getUint8(9), ownerSeq: v.getUint8(10), launchSeq: v.getUint8(11),
    reason: v.getUint8(12), edge: v.getUint8(13),
    x: v.getInt16(14, LE) / 1000, y: v.getInt16(16, LE) / 1000, d: v.getInt16(18, LE) / 10000,
    vx: v.getInt16(20, LE) / 1000, vy: v.getInt16(22, LE) / 1000, vd: v.getInt16(24, LE) / 1000,
    wx: v.getInt16(26, LE) / 100, wy: v.getInt16(28, LE) / 100, wz: v.getInt16(30, LE) / 100,
    tEdge: v.getUint32(32, LE), cEdge: v.getInt16(36, LE) / 1000, radius: v.getUint16(38, LE) / 10000,
    ownerSeat: v.getUint8(40),
  };
}

// ── CLAIM 0x12 (30 B), ACK 0x13 (12 B), GOAL 0x14 (16 B) ─────────────────────
export function encodeClaim(c, seq, flags = 0) {
  const buf = new ArrayBuffer(30), v = new DataView(buf);
  header(v, PK.CLAIM, seq, c.t, flags);
  v.setUint8(8, c.seat); v.setUint8(9, c.ownerSeq & 0xff); v.setUint8(10, c.reason); v.setUint8(11, c.launchSeq & 0xff);
  v.setInt16(12, q1000(c.x), LE); v.setInt16(14, q1000(c.y), LE); v.setInt16(16, q10000(c.d ?? 0), LE);
  v.setInt16(18, q1000(c.vx), LE); v.setInt16(20, q1000(c.vy), LE); v.setInt16(22, q1000(c.vd ?? 0), LE);
  v.setUint32(24, u32(c.tState), LE);
  v.setUint8(28, c.simSeat ?? c.seat); v.setUint8(29, 0);
  return buf;
}
export function decodeClaim(buf) {
  const v = new DataView(buf), hd = readHeader(buf);
  return { ...hd, seat: v.getUint8(8), ownerSeq: v.getUint8(9), reason: v.getUint8(10), launchSeq: v.getUint8(11),
    x: v.getInt16(12, LE) / 1000, y: v.getInt16(14, LE) / 1000, d: v.getInt16(16, LE) / 10000,
    vx: v.getInt16(18, LE) / 1000, vy: v.getInt16(20, LE) / 1000, vd: v.getInt16(22, LE) / 1000, tState: v.getUint32(24, LE),
    simSeat: v.getUint8(28) };
}
export function encodeAck(a, seq) {
  const buf = new ArrayBuffer(12), v = new DataView(buf);
  header(v, PK.ACK, seq, a.t); v.setUint8(8, a.ownerSeq & 0xff); v.setUint8(9, a.accepted ? 1 : 0); v.setUint8(10, a.bySeat); v.setUint8(11, 0);
  return buf;
}
export function decodeAck(buf) { const v = new DataView(buf), hd = readHeader(buf); return { ...hd, ownerSeq: v.getUint8(8), accepted: !!v.getUint8(9), bySeat: v.getUint8(10) }; }
export function encodeGoal(g, seq, flags = 0) {
  const buf = new ArrayBuffer(16), v = new DataView(buf);
  header(v, PK.GOAL, seq, g.t, flags); v.setUint8(8, g.goalSeat); v.setUint8(9, g.scorerSeat); v.setUint8(10, g.ownerSeq & 0xff); v.setUint8(11, g.goalNo & 0xff);
  v.setUint32(12, u32(g.tGoal), LE);
  return buf;
}
export function decodeGoal(buf) {
  const v = new DataView(buf), hd = readHeader(buf);
  return { ...hd, goalSeat: v.getUint8(8), scorerSeat: v.getUint8(9), ownerSeq: v.getUint8(10), goalNo: v.getUint8(11), tGoal: v.getUint32(12, LE) };
}
export function encodeSeatMap(map, seq, t) {
  const json = new TextEncoder().encode(JSON.stringify(map));
  const buf = new ArrayBuffer(8 + json.byteLength); const v = new DataView(buf);
  header(v, PK.SEAT_MAP, seq, t, FLAG.FROM_HOST); new Uint8Array(buf, 8).set(json);
  return buf;
}
export function decodeSeatMap(buf) { return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8))); }
export function encodeClockPing(t0, seq) { const b = new ArrayBuffer(12), v = new DataView(b); header(v, PK.CLOCK_PING, seq, 0); v.setUint32(8, u32(t0), LE); return b; }
export function encodeClockPong(t0, t1, t2, seq) { const b = new ArrayBuffer(20), v = new DataView(b); header(v, PK.CLOCK_PONG, seq, 0); v.setUint32(8, u32(t0), LE); v.setUint32(12, u32(t1), LE); v.setUint32(16, u32(t2), LE); return b; }
export function decodeClockPong(buf) { const v = new DataView(buf); return { t0: v.getUint32(8, LE), t1: v.getUint32(12, LE), t2: v.getUint32(16, LE) }; }

// ── shared clock (NTP-style offset, median of N) ─────────────────────────────
// Racer: "We poll the server multiple times, taking the median result. This gets us within 10ms of the actual
// difference between device and server." (https://web.dev/racer). Cristian: set to T + RTT/2, error-free only
// if the RTT is split equally (https://en.wikipedia.org/wiki/Cristian%27s_algorithm).
export class SharedClock {
  /** @param {{samples?:number, localNow?:()=>number}} o  localNow defaults to performance.now(); inject a virtual clock for tests */
  constructor({ samples = 8, localNow } = {}) {
    this.n = samples; this.samples = []; this.offset = 0; this.rtt = 0;
    this.localNow = localNow || (() => performance.now());
  }
  /** local monotonic ms */
  local() { return this.localNow(); }
  /** session clock ms (u32 domain) */
  now() { return u32(this.local() + this.offset); }
  /** feed one ping/pong: t0 local send, t1 server recv, t2 server send, t3 local recv */
  sample(t0, t1, t2, t3) {
    const off = ((t1 - t0) + (t2 - t3)) / 2;
    const rtt = (t3 - t0) - (t2 - t1);
    this.samples.push({ off, rtt }); if (this.samples.length > this.n) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a.off - b.off);
    this.offset = sorted[sorted.length >> 1].off;      // median: robust to one slow round trip
    this.rtt = sorted.reduce((s, x) => s + x.rtt, 0) / sorted.length;
  }
  /** Live Share: adopt the host's global time (INtpTimeInfo.ntpTimeInUTC or ILiveEvent.timestamp) instead of pinging. */
  adoptGlobal(globalNowMs) { this.offset = globalNowMs - this.local(); }
}

// ── BallNet: the owner / receiver / host state machine ───────────────────────
/**
 * @param {object} o
 * @param {object} o.transport   { id, send(bytes,{reliable}), onMessage(cb) }
 * @param {SharedClock} o.clock
 * @param {import('./court-map.js').CourtMap} o.court
 * @param {number} o.seat        my seat index
 * @param {string} o.clientId
 * @param {boolean} o.isHost     proxy owner for untracked seats + recovery + seat-map author
 * @param {number} o.rateHz      BALL_STATE rate while owner (20 on relay / Live Share, 30 on WebRTC)
 * @param {object} o.hooks       { onBecameOwner(claim), onLostOwner(), onOwnerChanged(claim), onLaunchSeen(launch, mine),
 *                                 onRemoteState(state), onWall(edge, ball), onGoal(goal), onSeatMap(map), onRespawnLocal(ball) }
 */
export class BallNet {
  constructor({ transport, clock, court, seat, clientId, isHost = false, rateHz = 20, hooks = {} }) {
    this.tr = transport; this.clock = clock; this.court = court; this.seat = seat; this.clientId = clientId;
    this.isHost = isHost; this.rateMs = 1000 / rateHz; this.hooks = hooks;
    this.seq = 0;
    this.owner = -1;                 // seat index of the OWNING CLIENT (-1 = nobody yet)
    this.ownerSimSeat = -1;          // seat whose rect the owner simulates in (differs from owner when the host proxies)
    this.ownerSeq = 0; this.launchSeq = 0;
    this.proxyFor = -1;              // when I own as the host's proxy: the untracked seat I simulate
    this.inTransit = false;
    this.lastLaunch = null;          // last LAUNCH seen (any sender), with tEdgeEff
    this.ghost = null; this.ghostSeat = -1;
    this.lastRemote = null; this.lastRemoteAt = -Infinity;
    this._lastSend = -Infinity; this._pendingClaimUntil = 0; this._restSince = 0; this._repeats = [];
    this.stats = { launches: 0, claims: 0, conflicts: 0, earlyStates: 0, timeouts: 0, recoveries: 0, stretches: 0, stretchMsLast: 0, oneWayMs: 0, packetAgeMs: 0 };
    this.tr.onMessage(buf => this._onPacket(buf));
  }
  get isOwner() { return this.owner === this.seat; }
  /** the seat rect my physics runs in: my own, or the untracked seat I proxy */
  get simSeat() { return this.proxyFor >= 0 ? this.proxyFor : this.seat; }
  getStats() { return { ...this.stats, owner: this.owner, ownerSeq: this.ownerSeq, inTransit: this.inTransit }; }

  // ── OWNER: call every frame with the local physics ball (court units) ──
  /**
   * @param {object} ball { x,y,d,vx,vy,vd,wx,wy,wz,radius, hold?:{mode,slot,ox,oy,oz,qx,qy,qz,qw}, atRest, onFloor, reason? }
   */
  tickOwner(ball) {
    if (!this.isOwner) return;
    const now = this.clock.now(), tl = this.clock.local();
    if (tl - this._lastSend >= this.rateMs) {
      this._lastSend = tl;
      const flags = (this.isHost ? FLAG.FROM_HOST : 0) | (this.proxyFor >= 0 ? FLAG.PROXY : 0);
      this.tr.send(encodeBallState({ ...ball, t: now, owner: this.seat, ownerSeq: this.ownerSeq, seat: this.inTransit ? SEAT_NONE : this.simSeat,
        launchSeq: this.launchSeq, inTransit: this.inTransit }, this.seq++, flags), { reliable: false });
    }
    if (this.inTransit) return;                                   // launched: keep simulating until CLAIM / timeout, never re-launch
    if (ball.hold && ball.hold.mode !== HOLD.FREE) { this._restSince = 0; return; }
    // rest → gutter → respawn
    if (ball.atRest) {
      if (!this._restSince) this._restSince = tl;
      else if (tl - this._restSince > TUNING.REST_TO_GUTTER_MS) { this._restSince = 0; this.respawn(ball); return; }
    } else this._restSince = 0;
    // exit test → LAUNCH (throw / roll / bat all route here; the ThrowDetector already shaped the velocity)
    const seat = this.simSeat;
    const edge = this.court.exitEdge(seat, ball.x, ball.y, ball.radius);
    if (edge === EDGE.NONE) return;
    const c = edge === EDGE.T ? ball.x : ball.y;
    const nb = this.court.neighbourAt(seat, edge, c);
    if (nb.seat < 0) { this.hooks.onWall?.(edge, ball); return; }   // outer rule (wall / out) is local: still my ball
    const along = edge === EDGE.T ? Math.abs(ball.vy) : Math.abs(ball.vx);
    const tEdge = now + Math.round(this.court.map.gutter / Math.max(0.2, along) * 1000);   // gutter crossing on the shared clock
    this._sendLaunch(ball, edge, ball.reason ?? REASON.THROW, nb.seat, c, tEdge);
  }

  _sendLaunch(ball, edge, reason, to, cEdge, tEdge) {
    const now = this.clock.now(), tl = this.clock.local();
    this.launchSeq = (this.launchSeq + 1) & 0xff;
    const l = { t: now, from: this.simSeat, to, ownerSeq: this.ownerSeq, launchSeq: this.launchSeq, reason, edge, ownerSeat: this.seat,
      x: ball.x, y: ball.y, d: ball.d ?? 0, vx: ball.vx, vy: ball.vy, vd: ball.vd ?? 0, wx: ball.wx ?? 0, wy: ball.wy ?? 0, wz: ball.wz ?? 0,
      tEdge, cEdge, radius: ball.radius };
    const bytes = encodeLaunch(l, this.seq++, this.isHost ? FLAG.FROM_HOST : 0);
    this.tr.send(bytes, { reliable: true });
    for (let i = 1; i <= TUNING.LAUNCH_REPEATS; i++) this._repeats.push({ at: tl + TUNING.LAUNCH_REPEAT_GAP_MS * i, bytes });
    l.tEdgeEff = tEdge;
    this.lastLaunch = l; this.inTransit = true; this.stats.launches++;
    this._pendingClaimUntil = tl + dt32(tEdge, now) + TUNING.HANDOFF_TIMEOUT_MS;
    // SELF-DESTINATION (ring wrap in a 2-3 seat court, or the host proxying both the from- and the to-seat):
    // my own LAUNCH is filtered as an echo in _onPacket, so seed the ghost here and let tick() claim at tEdge
    // exactly like a remote receiver would. Everyone else still sees the LAUNCH and the CLAIM. (sync-protocol.md §7 rule 10)
    const toMe = to === this.seat || (this.isHost && to !== SEAT_NONE && !this.court.isTracked(to));
    if (toMe) {
      const nb = edge === EDGE.NONE ? { wrapDx: 0 } : this.court.neighbourAt(this.simSeat, edge, cEdge);
      this.ghost = { x: l.x + (nb.wrapDx || 0), y: l.y, d: l.d, vx: l.vx, vy: l.vy, vd: l.vd, frozen: reason === REASON.RESPAWN, _tl: tl };
      this.ghostSeat = to;
    }
    this.hooks.onLaunchSeen?.(l, true);
  }

  /** Ball rested too long (or sank through an untracked floor): back to the kick-off seat. */
  respawn(ball) {
    const k = this.court.map.kickoff ?? 0, r = this.court.rectOf(k), R = ball.radius;
    const target = { x: r.x0 + r.w / 2, y: r.y0 + R + 0.4, d: 0, vx: 0, vy: 0, vd: 0, wx: 0, wy: 0, wz: 0, radius: R };
    if (k === this.seat || k === this.simSeat) {
      if (k === this.seat) this.proxyFor = -1;
      Object.assign(ball, target); ball.atRest = false;
      this._claim(CLAIM_REASON.RESPAWN, target, this.clock.now(), this.proxyFor);   // tells everyone the ball is back at kick-off
      this.hooks.onRespawnLocal?.(ball);
      return;
    }
    this._sendLaunch(target, EDGE.NONE, REASON.RESPAWN, k, target.x, this.clock.now() + TUNING.RESPAWN_TRANSIT_MS);
  }

  // ── EVERYONE: per-frame housekeeping (claims, recovery, ghost) ──
  tick() {
    const now = this.clock.now(), tl = this.clock.local();
    while (this._repeats.length && this._repeats[0].at <= tl) this.tr.send(this._repeats.shift().bytes, { reliable: false });
    // thrower: time out the handoff — assume the receiver has it; the host's silence timer covers a dead receiver
    if (this.isOwner && this.inTransit && tl > this._pendingClaimUntil) { this.stats.timeouts++; this._loseOwnership(this.lastLaunch ? this.lastLaunch.to : -1); }
    // receiver / proxy: claim at tEdge' if a launch is headed to me (or to an untracked seat I proxy)
    const l = this.lastLaunch;
    if (l && this.ghost && (!this.isOwner || this.inTransit) && dt32(now, l.tEdgeEff) >= 0) {
      if (l.to === this.seat) this._claim(CLAIM_REASON.BOUNDARY, this.ghost, l.tEdgeEff, -1);
      else if (this.isHost && l.to !== SEAT_NONE && !this.court.isTracked(l.to)) this._claim(CLAIM_REASON.PROXY, this.ghost, l.tEdgeEff, l.to);
    }
    // host: recover a vanished owner (no BALL_STATE for OWNER_SILENCE_MS)
    if (this.isHost && this.owner >= 0 && !this.isOwner && tl - this.lastRemoteAt > TUNING.OWNER_SILENCE_MS) {
      const r = this.court.rectOf(this.seat), R = this.court.R;
      this.stats.recoveries++;
      this._claim(CLAIM_REASON.RECOVERY, { x: r.x0 + r.w / 2, y: r.y0 + R + 0.4, d: 0, vx: 0, vy: 0, vd: 0 }, now, -1);
    }
    if (this.ghost && !this.ghost.frozen) this._integrateGhost(tl);
  }

  _claim(reason, st, tState, proxyFor) {
    this.ownerSeq = (this.ownerSeq + 1) & 0xff;
    this.owner = this.seat; this.ownerSimSeat = proxyFor >= 0 ? proxyFor : this.seat; this.proxyFor = proxyFor;
    this.inTransit = false; this._restSince = 0; this.ghost = null; this.stats.claims++;
    const c = { t: this.clock.now(), seat: this.seat, ownerSeq: this.ownerSeq, reason, launchSeq: this.lastLaunch ? this.lastLaunch.launchSeq : this.launchSeq,
      x: st.x, y: st.y, d: st.d ?? 0, vx: st.vx, vy: st.vy, vd: st.vd ?? 0, tState, simSeat: this.simSeat };
    const flags = (this.isHost ? FLAG.FROM_HOST : 0) | (proxyFor >= 0 ? FLAG.PROXY : 0);
    this.tr.send(encodeClaim(c, this.seq++, flags), { reliable: true });
    this.hooks.onBecameOwner?.(c);
  }
  _loseOwnership(assumedOwner) {
    this.owner = assumedOwner; this.ownerSimSeat = assumedOwner; this.inTransit = false; this.proxyFor = -1;
    this.lastRemoteAt = this.clock.local();                        // start the silence timer from here
    this.hooks.onLostOwner?.();
  }
  _integrateGhost(tl) {
    const g = this.ghost; let remain = (tl - g._tl) / 1000; g._tl = tl;
    const fy = (this.ghostSeat >= 0 && this.ghostSeat !== SEAT_NONE) ? this.court.floorY(this.ghostSeat) : undefined;
    while (remain > 1e-6) { const dt = Math.min(1 / 60, remain); integrateCourt(g, dt, fy, this.court.R); remain -= dt; }
  }

  // ── inbound ──
  _onPacket(buf) {
    const hd = readHeader(buf);
    switch (hd.type) {
      case PK.BALL_STATE: {
        const s = decodeBallState(buf);
        if (s.owner === this.seat) return;                                             // my own echo
        if (this.lastRemote && s.owner === this.lastRemote.owner && !seqNewer16(s.seq, this.lastRemote.seq)) return;   // newest-wins
        if (seqNewer8(this.ownerSeq, s.ownerSeq)) return;                              // older ownership epoch
        if (seqNewer8(s.ownerSeq, this.ownerSeq)) {                                    // a newer epoch I have not seen the CLAIM for yet
          if (this.isOwner) { if (this.inTransit) this.stats.earlyStates++; else this.stats.conflicts++; this._loseOwnership(s.owner); }
          this.owner = s.owner; this.ownerSeq = s.ownerSeq;
        } else if (s.owner !== this.owner) return;                                     // equal epoch, different sender: wait for the CLAIM to settle it
        this.ownerSimSeat = s.seat === SEAT_NONE ? this.ownerSimSeat : s.seat;
        this.lastRemote = s; this.lastRemoteAt = this.clock.local();
        this.stats.packetAgeMs = dt32(this.clock.now(), s.t);
        this.hooks.onRemoteState?.(s);
        return;
      }
      case PK.LAUNCH: {
        const l = decodeLaunch(buf);
        if (this.lastLaunch && l.from === this.lastLaunch.from && l.launchSeq === this.lastLaunch.launchSeq) return;   // repeat copy
        if (seqNewer8(this.ownerSeq, l.ownerSeq)) return;                              // stale epoch
        if (seqNewer8(l.ownerSeq, this.ownerSeq)) { this.ownerSeq = l.ownerSeq; this.owner = l.ownerSeat; }
        this.stats.oneWayMs = dt32(this.clock.now(), l.t);
        // boundary stretch: never sooner than MIN_LEAD_MS after I learned about it (latency-feel.md §3)
        const minEdge = this.clock.now() + TUNING.MIN_LEAD_MS;
        l.tEdgeEff = dt32(l.tEdge, minEdge) < 0 ? minEdge : l.tEdge;
        if (l.tEdgeEff !== l.tEdge) { this.stats.stretches++; this.stats.stretchMsLast = dt32(l.tEdgeEff, l.tEdge); }
        this.lastLaunch = l;
        const forMe = l.to === this.seat, forProxy = this.isHost && l.to !== SEAT_NONE && !this.court.isTracked(l.to);
        if (forMe || forProxy) {
          const nb = l.edge === EDGE.NONE ? { wrapDx: 0 } : this.court.neighbourAt(l.from, l.edge, l.cEdge);
          this.ghost = { x: l.x + (nb.wrapDx || 0), y: l.y, d: l.d, vx: l.vx, vy: l.vy, vd: l.vd, frozen: l.reason === REASON.RESPAWN,
            _tl: this.clock.local() - Math.max(0, dt32(this.clock.now(), l.t)) };
          this.ghostSeat = l.to;
          if (!this.ghost.frozen) this._integrateGhost(this.clock.local());
        }
        this.hooks.onLaunchSeen?.(l, false);
        return;
      }
      case PK.CLAIM: {
        const c = decodeClaim(buf);
        const newer = seqNewer8(c.ownerSeq, this.ownerSeq);
        const equal = c.ownerSeq === this.ownerSeq && c.seat !== this.owner;
        let accept = newer;
        if (equal) {
          // tile-owner rule, then lower clientId (string sort) wins — Live Share's isNewer() tie-break
          const at = this.court.seatAt(c.x, c.y);
          const inTheirs = at === c.simSeat, inMine = this.isOwner && at === this.simSeat;
          accept = (inTheirs && !inMine) ? true : (!inTheirs && inMine) ? false : (this.court.map.seats[c.seat]?.clientId ?? '') < this.clientId;
          this.stats.conflicts++;
        }
        if (!accept) { this.tr.send(encodeAck({ t: this.clock.now(), ownerSeq: this.ownerSeq, accepted: false, bySeat: this.seat }, this.seq++), { reliable: true }); return; }
        if (this.isOwner) this._loseOwnership(c.seat);
        this.owner = c.seat; this.ownerSimSeat = c.simSeat; this.ownerSeq = c.ownerSeq; this.ghost = null; this.inTransit = false;
        this.lastRemoteAt = this.clock.local();
        if (this.lastLaunch && (c.reason === CLAIM_REASON.BOUNDARY || c.reason === CLAIM_REASON.PROXY)) this.lastLaunch.tEdgeEff = c.tState;   // everyone re-times to the claimant
        this.tr.send(encodeAck({ t: this.clock.now(), ownerSeq: c.ownerSeq, accepted: true, bySeat: this.seat }, this.seq++), { reliable: true });
        this.hooks.onOwnerChanged?.(c);
        return;
      }
      case PK.ACK: return;                                                             // informational (the CLAIM already won by sequence)
      case PK.GOAL: {
        const g = decodeGoal(buf);
        const goalSeat = this.court.map.goal;
        if (g.goalSeat !== goalSeat) return;                                           // not the current goal tile
        // only the ball's owner may declare: the goal seat itself (tracked keeper) or the host proxy for an untracked goal
        const fromProxy = !!(hd.flags & FLAG.PROXY), fromHost = !!(hd.flags & FLAG.FROM_HOST);
        const legit = g.ownerSeq === this.ownerSeq && (this.owner === goalSeat || (fromProxy && fromHost && !this.court.isTracked(goalSeat)));
        if (!legit) return;
        this.hooks.onGoal?.(g);
        return;
      }
      case PK.SEAT_MAP: {
        if (!(hd.flags & FLAG.FROM_HOST)) return;                                      // host only
        const map = decodeSeatMap(buf);
        if (this.court.map && map.v <= this.court.map.v) return;
        this.court.set(map); this.seat = this.court.seatOfClient(this.clientId);
        this.hooks.onSeatMap?.(map);
        return;
      }
      case PK.CLOCK_PONG: { const p = decodeClockPong(buf); this.clock.sample(p.t0, p.t1, p.t2, this.clock.local()); return; }
      default: return;                                                                 // HAND_STREAM 0x30 is consumed by remote-consumer.mjs on the same transport (hopeos-wire.md §2)
    }
  }

  /** Host: publish the seat map (reliable). */
  publishSeatMap(map) { this.court.set(map); this.tr.send(encodeSeatMap(map, this.seq++, this.clock.now()), { reliable: true }); }
  /** Goal-tile owner (tracked keeper) or host proxy: declare a goal. Returns false if I am not allowed to. */
  declareGoal(scorerSeat, goalNo) {
    if (!this.isOwner || this.simSeat !== this.court.map.goal) return false;
    const g = { t: this.clock.now(), goalSeat: this.simSeat, scorerSeat, ownerSeq: this.ownerSeq, goalNo, tGoal: this.clock.now() };
    const flags = (this.isHost ? FLAG.FROM_HOST : 0) | (this.proxyFor >= 0 ? FLAG.PROXY : 0);
    this.tr.send(encodeGoal(g, this.seq++, flags), { reliable: true });
    this.hooks.onGoal?.(g);
    return true;
  }
  /** Clock ping (relay / WebRTC time master answers with CLOCK_PONG). */
  ping() { this.tr.send(encodeClockPing(this.clock.local(), this.seq++), { reliable: false }); }
  /** Take initial ownership (kick-off) — host only. */
  kickoff(ball) { if (!this.isHost) return false; this._claim(CLAIM_REASON.RESPAWN, ball, this.clock.now(), -1); return true; }
}
