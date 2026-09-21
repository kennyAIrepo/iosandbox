/**
 * room.js — PRESENCE roster, host election, seat-map authoring and clock cadence for the Teams twin (Node + browser).
 * ─────────────────────────────────────────────────────────────────────────────
 * One `Room` per client, on the SAME transport as `BallNet` (sdk/game/ball-net.js) and `RemoteHands`
 * (sdk/net/remote-consumer.js). It owns exactly three things:
 *
 *   1. PRESENCE 0x21 (CONTRACTS §7): 8-byte wire header + UTF-8 JSON `{v, clientId, name, tracked, aspect, handSpan, kind}`,
 *      sent reliably on join, on every `{joined}` relay hint, once in reply to a peer we have never seen (so a room converges
 *      in one round trip instead of one presence period), then every `presenceMs`. A peer silent for `pruneMs` is removed.
 *      `BallNet._onPacket` and `RemoteHands.onMessage` ignore 0x21 (their `default:` branch / type check) — checkpoint [W2].
 *   2. Host election: the roster is sorted by clientId (plain string compare) and the LOWEST id is the host on every client
 *      (relay ids `c-001…` and loopback ids `c-<zero-padded joinedAt>-<rand>` are lexically sortable; `?host=1` forces
 *      `c-000000-`). The host republishes the seat map (`buildSeatMap`, `v` = last seen `v` + 1) on every roster change:
 *      a join, a field change (tracked / handSpan / aspect / name / kind), a prune, a `bye`.
 *   3. Clock cadence (CONTRACTS §7 row 0x01/0x02): CLOCK_PING at 1 Hz until the SharedClock holds 8 samples, then 0.1 Hz.
 *      On the WebSocket relay the SERVER answers pings (tools/relay-server.mjs) — `isRelay: true`. On the broadcast
 *      transports (MemHub, LoopbackTransport) the HOST answers CLOCK_PING with CLOCK_PONG so everyone converges on the
 *      host's local clock and the host is `clockReady()` at once. Because those transports fan every packet out to every
 *      peer, a pong for someone else's ping would reach my `BallNet`, which samples every CLOCK_PONG unconditionally; the
 *      Room therefore makes the ping's `t0` a nonce — it records the `t0` of each ping it sent and installs a filter on
 *      `clock.sample` that discards a pong whose `t0` is not one of mine (see `_guardClock`). The relay path is untouched.
 *
 * No timers, no wall-clock reads, no DOM: everything advances from `tick(nowLocal)` and the injected clock, so the same code
 * runs headless (tests/bot-pass-smoke.mjs on a virtual clock through MemHub) and in the page's rAF loop.
 *
 * Derived from R/game/examples/relay-server.mjs (hello / joined / left, CLOCK_PING answered), R/gaps/wire-protocol/stage.html
 * :183-222 (host election, presence cadence, seat map publish), R/game/examples/court-map.mjs::buildSeatMap and
 * R/gaps/wire-protocol/ball-net.mjs::encodeSeatMap / ping / kickoff.
 */
import { PK, readHeader, writeHeader, encodeClockPing, encodeClockPong } from '../game/ball-net.js';
import { buildSeatMap } from '../game/court-map.js';

export const PK_PRESENCE = PK.PRESENCE;          // 0x21 (also PK.PRESENCE in ball-net.js)
export const PRESENCE_VER = 1;
const LE = true;
const HEADER_BYTES = 8;
const PING_BYTES = 12;
const PING_NONCES = 32;                          // outstanding ping t0s remembered on a broadcast transport

let _enc = null, _dec = null;
const enc = () => _enc || (_enc = new TextEncoder());
const dec = () => _dec || (_dec = new TextDecoder());

/**
 * PRESENCE 0x21: header (type, flags 0, seq, t) + UTF-8 JSON `{v:1, clientId, name, tracked, aspect, handSpan, kind}`.
 * Extra fields carried by the Room (ignored by anyone else): `mapV` (the sender's current seat-map version, so a host that
 * (re)joins mid-session keeps `v` monotonic) and `bye` (the sender is leaving: prune it at once).
 */
export function encodePresence(p, seq, t) {
  const body = { v: PRESENCE_VER, clientId: p.clientId, name: p.name, tracked: !!p.tracked, aspect: p.aspect ?? 16 / 9,
    handSpan: p.handSpan ?? null, kind: p.kind || 'remote' };
  if (p.mapV != null) body.mapV = p.mapV;
  if (p.bye) body.bye = true;
  const json = enc().encode(JSON.stringify(body));
  const buf = new ArrayBuffer(HEADER_BYTES + json.byteLength);
  writeHeader(new DataView(buf), PK.PRESENCE, seq, t, 0);
  new Uint8Array(buf, HEADER_BYTES).set(json);
  return buf;
}
export function decodePresence(buf) {
  const hd = readHeader(buf);
  const body = JSON.parse(dec().decode(new Uint8Array(buf, HEADER_BYTES)));
  return { ...hd, ...body };
}

const byId = (a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0);
const PRESENCE_FIELDS = ['name', 'tracked', 'aspect', 'handSpan', 'kind'];

export class Room extends EventTarget {
  /**
   * @param {object} o
   * @param {{id?:string, send:Function, onMessage:Function, ready?:Promise, inner?:object}} o.transport
   * @param {import('../game/ball-net.js').SharedClock} o.clock
   * @param {import('../game/ball-net.js').BallNet} o.net         its `hooks.onSeatMap` is WRAPPED (never replaced); `isHost` is kept in sync
   * @param {import('../game/court-map.js').CourtMap} o.court     the same CourtMap the BallNet uses (its `map.v` seeds the next version)
   * @param {{clientId?:string, name?:string, tracked?:boolean, aspect?:number, handSpan?:number|null, kind?:string}} o.me
   * @param {number} o.presenceMs   PRESENCE period (2000)
   * @param {number} o.pruneMs      silence after which a peer is dropped (6000)
   * @param {boolean} o.isRelay     true for WsRelayTransport (the relay answers CLOCK_PING); false for Loopback / Mem (the host answers)
   * @param {number} o.pingMs       ping period until `pingSamples` samples (1000); `pingSlowMs` afterwards (10000)
   */
  constructor({ transport, clock, net = null, court = null, me = {}, presenceMs = 2000, pruneMs = 6000, isRelay = false,
    pingMs = 1000, pingSlowMs = 10000, pingSamples = 8 } = {}) {
    super();
    this.tr = transport; this.clock = clock; this.net = net; this.court = court || (net && net.court) || null;
    this.me = { clientId: me.clientId ?? transport?.id ?? null, name: me.name || 'me', tracked: !!me.tracked, aspect: me.aspect ?? 16 / 9,
      handSpan: me.handSpan ?? null, kind: me.kind || 'local' };
    this.presenceMs = presenceMs; this.pruneMs = pruneMs; this.isRelay = !!isRelay;
    this.pingMs = pingMs; this.pingSlowMs = pingSlowMs; this.pingSamples = pingSamples;
    this.roster = [];
    this.joined = false; this.left = false;
    this.hostId = null;
    this._seq = 0;
    this._lastPresence = -Infinity; this._lastPing = -Infinity; this._lastTick = -Infinity;
    this._peerMapV = 0;                          // highest seat-map version any peer reported (PRESENCE.mapV)
    this._nonces = [];                           // t0 of my outstanding pings (broadcast transports only)
    this._unguard = null;
    this.stats = { presenceSent: 0, presenceSeen: 0, pings: 0, pongsAnswered: 0, pongsDropped: 0, publishes: 0, pruned: 0 };
    this._wrapSeatMapHook();
    this.tr.onMessage(buf => this._onPacket(buf));
    const inner = this.tr.inner || this.tr;
    if (inner && ('ws' in inner || typeof inner.ready?.then === 'function')) {   // WsRelayTransport (possibly behind gated())
      const prev = typeof inner.onControl === 'function' ? inner.onControl : null;
      inner.onControl = m => { prev?.(m); this._onControl(m); };
    }
  }

  // ── public ────────────────────────────────────────────────────────────────
  /** WsRelay: awaits `transport.ready` (hello → clientId, peers, serverNow). Loopback / Mem: clientId = me.clientId. Sends PRESENCE at once. */
  async join() {
    let peers = [];
    if (this.tr.ready && typeof this.tr.ready.then === 'function') {
      const hello = await this.tr.ready;
      this.me.clientId = hello.clientId;
      peers = (hello.peers || []).filter(id => id !== this.me.clientId);
      if (typeof hello.serverNow === 'number' && this.isRelay && !this.clock.samples.length) this.clock.adoptGlobal(hello.serverNow);   // first estimate; the median replaces it
    }
    if (!this.me.clientId) this.me.clientId = this.tr.id || ('c-' + Math.random().toString(36).slice(2, 8));
    if (this.net && this.net.clientId !== this.me.clientId) this.net.clientId = this.me.clientId;   // hello is the identity authority (BallNet built before it)
    const now = this.clock.local();
    this.joined = true; this.left = false;
    this._upsert({ ...this.me }, now);           // me, first
    if (!this.isRelay) this._guardClock();
    this._recomputeHost(true);
    this._sendPresence(now);
    this._lastTick = now;
    return { clientId: this.me.clientId, peers };
  }

  /** lowest clientId in the roster is the host — on every client (stage.html:207, sync-protocol.md §2) */
  get isHost() { return this.roster.length > 0 && this.roster[0].clientId === this.me.clientId; }

  /** relay: 8 clock samples; broadcast transports: the host is the clock, everyone else needs 8 pongs from it */
  clockReady() {
    const n = this.clock.samples.length;
    return this.isRelay ? n >= this.pingSamples : (this.isHost || n >= this.pingSamples);
  }

  /** Presence cadence, pings, prune; host: republish on roster change. Call once per frame / sim step with `clock.local()`. */
  tick(nowLocal = this.clock.local()) {
    if (!this.joined || this.left) return;
    const now = nowLocal;
    this._lastTick = now;
    const mine = this._entry(this.me.clientId); if (mine) mine.lastSeenMs = now;
    if (now - this._lastPresence >= this.presenceMs) this._sendPresence(now);
    if (this._shouldPing()) {
      const period = this.clock.samples.length >= this.pingSamples ? this.pingSlowMs : this.pingMs;
      if (now - this._lastPing >= period) this._ping(now);
    }
    let changed = false;
    for (let i = this.roster.length - 1; i >= 0; i--) {
      const p = this.roster[i];
      if (p.clientId === this.me.clientId) continue;
      if (now - p.lastSeenMs > this.pruneMs) { this.roster.splice(i, 1); this.stats.pruned++; changed = true; this._emit('peer-left', { ...p, reason: 'silence' }); }
    }
    if (changed) this._rosterChanged();
  }

  /** `buildSeatMap(roster, {cols: n, wrap: n > 1 ? 'row' : 'none', outer: 'wall', goal: prev.goal, kickoff: 0, v: prev.v + 1, ballR: prev.ballR, shelf: prev.shelf})`
   *  — the host-tuned ball radius / shelf line travel with every republish (late joiners get them, not the defaults). */
  buildMap() {
    const prev = (this.court && this.court.map) || { v: 0, goal: -1 };
    const n = this.roster.length;
    const v = Math.max(prev.v ?? 0, this._peerMapV) + 1;
    const opts = { cols: Math.max(1, n), wrap: n > 1 ? 'row' : 'none', outer: 'wall', goal: prev.goal ?? -1, kickoff: 0, v };
    if (prev.ballR > 0) opts.ballR = prev.ballR;
    if (prev.shelf > 0) opts.shelf = prev.shelf;
    return buildSeatMap(this.roster, opts);
  }

  /**
   * Host only: `net.publishSeatMap({...buildMap(), ...mapPatch})`. The host's own map is not echoed back to it, so the same
   * `onSeatMap` hook (page / BallGame) and the 'seatmap' event fire here — one code path on every client. Returns the map.
   */
  publish(mapPatch = {}) {
    if (!this.isHost || !this.net) return null;
    const map = { ...this.buildMap(), ...mapPatch };
    this.net.publishSeatMap(map);
    this.net.seat = this.court ? this.court.seatOfClient(this.me.clientId) : this.net.seat;
    this.stats.publishes++;
    this.net.hooks.onSeatMap?.(map);             // the wrapper: page hook + 'seatmap'
    return map;
  }

  /** `on('roster' | 'host' | 'seatmap' | 'peer-joined' | 'peer-left', fn)` — fn receives the detail; returns an unsubscribe fn */
  on(type, fn) { const h = e => fn(e.detail, e); this.addEventListener(type, h); return () => this.removeEventListener(type, h); }

  setTracked(tracked) { this.me.tracked = !!tracked; this._meChanged(); }
  setHandSpan(units) { this.me.handSpan = units ?? null; this._meChanged(); }
  setName(name) { this.me.name = String(name || this.me.name); this._meChanged(); }

  /** Sends a `bye` PRESENCE (peers prune at once), stops the cadence, restores the clock guard. */
  leave() {
    if (!this.joined || this.left) return;
    this._send(encodePresence({ ...this.me, mapV: this.court?.map?.v ?? 0, bye: true }, this._seq++, this.clock.now()), true);
    this.left = true;
    if (this._unguard) { this._unguard(); this._unguard = null; }
  }

  // ── internals ─────────────────────────────────────────────────────────────
  _entry(id) { for (const p of this.roster) if (p.clientId === id) return p; return null; }
  _emit(type, detail) {
    const ev = typeof CustomEvent === 'function' ? new CustomEvent(type, { detail }) : Object.assign(new Event(type), { detail });
    this.dispatchEvent(ev);
  }
  _send(bytes, reliable) { this.tr.send(bytes, { reliable }); }
  _shouldPing() { return this.isRelay || !this.isHost; }     // on a broadcast transport the host IS the clock

  _sendPresence(now) {
    this._lastPresence = now; this.stats.presenceSent++;
    this._send(encodePresence({ ...this.me, mapV: this.court?.map?.v ?? 0 }, this._seq++, this.clock.now()), true);
  }
  _meChanged() {
    const mine = this._entry(this.me.clientId);
    if (mine) Object.assign(mine, { name: this.me.name, tracked: this.me.tracked, aspect: this.me.aspect, handSpan: this.me.handSpan, kind: this.me.kind });
    if (this.joined && !this.left) { this._sendPresence(this.clock.local()); this._rosterChanged(); }
  }

  _ping(now) {
    const t0 = now >>> 0;
    if (!this.isRelay) { this._nonces.push(t0); if (this._nonces.length > PING_NONCES) this._nonces.shift(); }
    this._lastPing = now; this.stats.pings++;
    this._send(encodeClockPing(t0, this._seq++), false);
  }
  /**
   * Broadcast transports: `BallNet._onPacket` feeds EVERY CLOCK_PONG to `clock.sample`, including the host's answers to other
   * peers' pings (whose t0 is on THEIR local clock). Filter by nonce: a pong is accepted only if its t0 is one I sent.
   */
  _guardClock() {
    if (this._unguard) return;
    const clock = this.clock, orig = clock.sample, self = this;
    clock.sample = function (t0, t1, t2, t3) {
      const i = self._nonces.indexOf(t0 >>> 0);
      if (i < 0) { self.stats.pongsDropped++; return; }
      self._nonces.splice(i, 1);
      return orig.call(clock, t0, t1, t2, t3);
    };
    this._unguard = () => { if (clock.sample !== orig) clock.sample = orig; };
  }

  /** `{joined}` → greet at once (the newcomer learns me without waiting a presence period); `{left}` → prune at once */
  _onControl(m) {
    if (!m || !this.joined || this.left) return;
    if (m.joined && m.joined !== this.me.clientId) this._sendPresence(this.clock.local());
    if (m.left) this._remove(m.left, 'left');
  }

  _onPacket(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES) return;
    const type = new Uint8Array(buf)[0];
    if (type === PK.PRESENCE) { this._onPresence(buf); return; }
    if (type === PK.CLOCK_PING && buf.byteLength >= PING_BYTES && !this.isRelay && this.joined && !this.left && this.isHost) {
      // host answers on a broadcast transport (relay-server.mjs:39-48 does the same on the socket): t1 = t2 = my session now
      const t0 = new DataView(buf).getUint32(8, LE), t1 = this.clock.now();
      this.stats.pongsAnswered++;
      this._send(encodeClockPong(t0, t1, this.clock.now(), this._seq++), false);
    }
  }

  _onPresence(buf) {
    let p; try { p = decodePresence(buf); } catch { return; }
    if (!p || p.v !== PRESENCE_VER || !p.clientId) return;
    this.stats.presenceSeen++;
    if (p.clientId === this.me.clientId) return;                     // own echo (some transports)
    if (typeof p.mapV === 'number' && p.mapV > this._peerMapV) this._peerMapV = p.mapV;
    if (p.bye) { this._remove(p.clientId, 'bye'); return; }
    const now = this.clock.local();
    const r = this._upsert(p, now);
    if (r.added) {
      this._emit('peer-joined', { ...r.entry });
      if (this.joined && !this.left) this._sendPresence(now);          // reply once: converge in one round trip
    }
    if (r.added || r.changed) this._rosterChanged();
  }

  _upsert(p, now) {
    let e = this._entry(p.clientId), added = false, changed = false;
    if (!e) {
      e = { clientId: p.clientId, name: p.name ?? '', tracked: !!p.tracked, aspect: p.aspect ?? 16 / 9, handSpan: p.handSpan ?? null, kind: p.kind || 'remote', lastSeenMs: now };
      this.roster.push(e); this.roster.sort(byId); added = true;
    } else {
      for (const k of PRESENCE_FIELDS) {
        const v = k === 'tracked' ? !!p[k] : k === 'aspect' ? (p[k] ?? 16 / 9) : k === 'handSpan' ? (p[k] ?? null) : k === 'kind' ? (p[k] || 'remote') : (p[k] ?? '');
        if (e[k] !== v) { e[k] = v; changed = true; }
      }
      e.lastSeenMs = now;
    }
    return { added, changed, entry: e };
  }

  _remove(id, reason) {
    const i = this.roster.findIndex(p => p.clientId === id);
    if (i < 0) return;
    const [p] = this.roster.splice(i, 1);
    this._emit('peer-left', { ...p, reason });
    this._rosterChanged();
  }

  _rosterChanged() {
    this.roster.sort(byId);
    this._emit('roster', this.roster.map(p => ({ ...p })));
    this._recomputeHost(false);
    if (this.isHost && this.joined && !this.left && this.net) this.publish();
  }

  _recomputeHost(initial) {
    const hostId = this.roster.length ? this.roster[0].clientId : null;
    const wasHost = this.net ? !!this.net.isHost : (this.hostId === this.me.clientId);
    const isHost = hostId === this.me.clientId;
    const changed = hostId !== this.hostId || wasHost !== isHost;
    this.hostId = hostId;
    if (this.net) this.net.isHost = isHost;
    if (changed || initial) this._emit('host', { isHost, hostId });
  }

  /** wrap `net.hooks.onSeatMap` so the page / BallGame hook still runs and 'seatmap' fires — even if the page assigns its hook later */
  _wrapSeatMapHook() {
    if (!this.net) return;
    const hooks = this.net.hooks || (this.net.hooks = {});
    let inner = typeof hooks.onSeatMap === 'function' ? hooks.onSeatMap : null;
    const wrapper = map => { inner?.(map); this._emit('seatmap', map); };
    Object.defineProperty(hooks, 'onSeatMap', { configurable: true, enumerable: true, get: () => wrapper, set: fn => { inner = typeof fn === 'function' ? fn : null; } });
  }
}
