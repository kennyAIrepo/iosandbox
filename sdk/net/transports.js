/**
 * transports.mjs — interchangeable transports for BallNet.
 * ─────────────────────────────────────────────────────────────────────────────
 * Interface every transport implements:
 *   id: string                          // this client's id (stable for the session)
 *   send(bytes: ArrayBuffer, { reliable: boolean })
 *   onMessage(cb: (bytes: ArrayBuffer) => void)
 *   close()
 *
 * 0. MemHub / MemTransport — in-process hub with per-link latency / jitter / loss and a
 *                            virtual clock; runs in Node (smoke-test.mjs) and in the browser.
 * 1. LoopbackTransport     — BroadcastChannel('hopeos-room'); two windows in one browser (the local Teams twin),
 *                            injectable latency / jitter / loss for the tolerance bands in latency-feel.md.
 *                            PATCHED (wire-protocol gap, hopeos-wire.md §6): rides the frozen page's channel with the
 *                            envelope { v:1, kind:'wire', from, reliable, bytes } next to its { v:1, kind:'presence', ... }.
 * 2. WsRelayTransport      — plain WebSocket to relay-server.mjs (two laptops; LAN) or the hosted tools/relay_modal.py (same
 *                            protocol, wss://). Auto-reconnects (1/2/4/8 s backoff), emits 'state' events, keeps its first
 *                            clientId across reconnects (see the class comment). Room codes / invite links: sdk/net/room-link.js.
 * 3. RtcTransport          — WebRTC RTCDataChannel pair: 'ball' unordered+unreliable, 'state' ordered.
 * 4. LiveShareTransport    — inside a Teams meeting only: LiveEvent for the unreliable bus,
 *                            LiveState for the reliable keys. Payloads must be JSON → base64.
 *                            PATCHED (wire-protocol gap, hopeos-wire.md §3): the unreliable bus is BUNDLED — one LiveEvent
 *                            per 50 ms carrying the latest packet of EACH type ({ f:[b64, ...] }), so HAND_STREAM and
 *                            BALL_STATE no longer throttle each other (the canonical :221 throttle was per transport).
 *
 * API names verified 2026-09-18 against:
 *   MDN createDataChannel — `ordered` default true; `maxPacketLifeTime` / `maxRetransmits` default null,
 *     "You may specify a non-null value for only one of these" (SyntaxError otherwise):
 *     https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
 *   Live Share — `new LiveShareClient(host: ILiveShareHost, options?)`, `joinContainer(fluidContainerSchema, onContainerFirstCreated?)
 *     → Promise<ILiveShareJoinResults>` (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveshareclient);
 *     `LiveShareHost.create()` from "@microsoft/teams-js" ("Ensure that the Teams Client SDK is initialized before calling
 *     LiveShareHost.create()") and `TestLiveShareHost.create()` for local dev
 *     (https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities,
 *      https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/testlivesharehost);
 *     `LiveEvent.initialize(allowedRoles?)`, `send(evt) → Promise<ILiveEvent>` ("The event will be queued for delivery if the
 *     client isn't currently connected"; "Events aren't guaranteed to be delivered"), `on('received', (evt, local) => {})`,
 *     "You should register `received` event listeners before calling this function"
 *     (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveevent);
 *     `LiveState.initialize(initialState, allowedRoles?)`, `set(state)`, `on('stateChanged', (state, local, clientId))`,
 *     "the state value in LiveState is reset after all the users disconnect from a session"
 *     (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/livestate, capabilities page);
 *     `ILiveEvent.timestamp` = "Global timestamp of when the event was sent", `ILiveEvent.clientId`
 *     (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/iliveevent);
 *     `INtpTimeInfo.ntpTimeInUTC` = "Server time expressed as the number of milliseconds since the ECMAScript epoch"
 *     (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/intptimeinfo);
 *     `UserMeetingRole` = organizer | presenter | attendee | guest
 *     (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/usermeetingrole).
 *   Live Share limits — "debounce changes emitted through Live Share to one message per 50 milliseconds or more";
 *     "Features in @microsoft/live-share ... don't work outside Microsoft Teams"; max 100 attendees; data up to 24 h;
 *     no Teams Rooms; GCC only among gov clouds (https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq).
 */

import { ROOM_CHANNEL, wrapRoom, unwrapRoom, bytesToB64, b64ToBytes } from './hand-stream.js';

const randId = () => 'c-' + Math.random().toString(36).slice(2, 8);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── 0. in-memory hub (tests, headless smoke test, single-page "three tiles in one window") ──
export class MemHub {
  /** @param {{now?:()=>number, rng?:()=>number}} o  inject a virtual clock and a seeded RNG for deterministic tests */
  constructor({ now = nowMs, rng = Math.random } = {}) {
    this.now = now; this.rng = rng;
    this.peers = new Map(); this.queue = []; this.links = new Map(); this._seq = 0; this._lastRel = new Map();
    this.stats = { sent: 0, dropped: 0, delivered: 0 };
  }
  /** Symmetric link profile between two peer ids (LAN 20±5/0 %, WAN 90±20/1 %, bad Wi-Fi 250±80/5 %). */
  link(a, b, opts) { const o = { latencyMs: 0, jitterMs: 0, lossPct: 0, ...opts }; this.links.set(a + '>' + b, o); this.links.set(b + '>' + a, o); }
  join(id) { const t = new MemTransport(this, id); this.peers.set(id, t); return t; }
  _send(from, bytes, reliable) {
    for (const [to] of this.peers) {
      if (to === from) continue;
      const L = this.links.get(from + '>' + to) || { latencyMs: 0, jitterMs: 0, lossPct: 0 };
      this.stats.sent++;
      if (!reliable && this.rng() * 100 < L.lossPct) { this.stats.dropped++; continue; }   // loss only on the unreliable bus
      let at = this.now() + L.latencyMs + (this.rng() * 2 - 1) * L.jitterMs;
      if (reliable) { const k = from + '>' + to; at = Math.max(at, this._lastRel.get(k) || 0); this._lastRel.set(k, at); }   // ordered per link
      this.queue.push({ at, to, bytes: bytes.slice(0), seq: this._seq++ });
    }
  }
  /** Deliver everything due at the current (virtual) time. Call once per frame / per simulated step. */
  flush() {
    const now = this.now();
    this.queue.sort((p, q) => p.at - q.at || p.seq - q.seq);
    while (this.queue.length && this.queue[0].at <= now) { const ev = this.queue.shift(); this.stats.delivered++; this.peers.get(ev.to)?._deliver(ev.bytes); }
  }
}
export class MemTransport {
  constructor(hub, id) { this.hub = hub; this.id = id; this.cbs = []; }
  send(bytes, { reliable = false } = {}) { this.hub._send(this.id, bytes, reliable); }
  onMessage(cb) { this.cbs.push(cb); }
  _deliver(bytes) { for (const cb of this.cbs) cb(bytes); }
  close() { this.hub.peers.delete(this.id); }
}

// ── 1. loopback (same browser, two windows) ─────────────────────────────────
export class LoopbackTransport {
  /** @param {{channel?:string, id?:string, latencyMs?:number, jitterMs?:number, lossPct?:number, rng?:()=>number}} o */
  constructor({ channel = ROOM_CHANNEL, id = null, latencyMs = 0, jitterMs = 0, lossPct = 0, rng = Math.random } = {}) {
    this.id = id || randId();
    this.sim = { latencyMs, jitterMs, lossPct }; this.rng = rng;
    this.bc = new BroadcastChannel(channel);          // https://developer.mozilla.org/docs/Web/API/BroadcastChannel (Node 18+ has it too)
    this.cbs = []; this.stats = { sent: 0, delivered: 0, ignored: 0, dropped: 0 };
    this.bc.onmessage = ev => {
      const bytes = unwrapRoom(ev.data, this.id);     // null: presence (or any other kind), other version, own echo
      if (!bytes) { this.stats.ignored++; return; }
      const reliable = !!ev.data.reliable;
      if (!reliable && this.rng() * 100 < this.sim.lossPct) { this.stats.dropped++; return; }
      const delay = this.sim.latencyMs + (this.rng() * 2 - 1) * this.sim.jitterMs;
      const deliver = () => { this.stats.delivered++; this.cbs.forEach(cb => cb(bytes)); };
      if (delay > 0) setTimeout(deliver, delay); else deliver();
    };
  }
  send(bytes, { reliable = false } = {}) { this.stats.sent++; this.bc.postMessage(wrapRoom(this.id, bytes.slice(0), reliable)); }   // structured clone carries the ArrayBuffer
  onMessage(cb) { this.cbs.push(cb); }
  close() { this.bc.close(); }
}

// ── 2. WebSocket relay ───────────────────────────────────────────────────────
/**
 * Plain WebSocket to tools/relay-server.mjs or the hosted tools/relay_modal.py (same protocol), with AUTO-RECONNECT
 * (1 s, 2 s, 4 s, then 8 s between attempts, forever until close()) and a 'state' event:
 *
 *   tr.on('state', ({ state, attempt, delayMs, willReconnect, reconnected }) => ...)   // state: 'connecting' | 'open' | 'closed'
 *   tr.state                    // the current one
 *   tr.stats                    // { connects, reconnects, attempts, droppedUnreliable, queued }
 *
 * Identity across reconnects: the relay assigns a clientId per SOCKET (hello), so a reconnect gets a fresh relay id.
 * `tr.id` keeps the FIRST hello's id for the whole session — every packet carries the app-level clientId in its payload
 * (PRESENCE / seat map / claims), the relay only uses ids for its hello / joined / left hints, so peers see us `left`
 * (pruned) and then re-added by our next PRESENCE under the same id; host election (lowest id) stays stable. Hello
 * semantics on reconnect: `onControl({ hello, reconnected: true })` and then `onControl({ joined: <new relay id>,
 * reconnected: true })` — Room._onControl answers a `joined` with an immediate PRESENCE, so the roster converges in one
 * round trip instead of one presence period.
 *
 * Sends while the socket is down: before the FIRST hello everything is queued (short window, the old behaviour);
 * during a reconnect only `reliable` sends are queued (bounded to 64, oldest dropped) — stale unreliable presence /
 * hand-stream packets are counted in `stats.droppedUnreliable` and dropped, newer ones replace them anyway.
 *
 * `ready` resolves with the first hello; it rejects after `connectTimeoutMs` (default 10 s) without ever having
 * connected, while the reconnect loop keeps trying in the background (the connection chip shows it).
 */
export class WsRelayTransport {
  /**
   * @param {string} url e.g. ws://192.168.1.20:8787/room/demo  or  wss://<workspace>--hopeos-relay.modal.run/room/KRT7Q
   * @param {{reconnect?:boolean, delaysMs?:number[], connectTimeoutMs?:number, maxQueue?:number, WebSocketImpl?:any}} o
   */
  constructor(url, { reconnect = true, delaysMs = [1000, 2000, 4000, 8000], connectTimeoutMs = 10000, maxQueue = 64, WebSocketImpl = null } = {}) {
    this.url = url;
    this.id = null;                                     // assigned by the server's FIRST hello, kept for the session
    this.relayId = null;                                // the relay's id for the CURRENT socket (== id until a reconnect)
    this.hello = null;
    this.ws = null;
    this.cbs = []; this.queue = [];
    this.state = 'connecting';
    this.stats = { connects: 0, reconnects: 0, attempts: 0, droppedUnreliable: 0, queued: 0 };
    this._opts = { reconnect, delaysMs, connectTimeoutMs, maxQueue };
    this._WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this._WS) throw new Error('WsRelayTransport: no WebSocket implementation (Node 22+ has a global one)');
    this._listeners = { state: [] };
    this._closed = false; this._timer = null; this._attempt = 0;
    this._readyRes = null; this._readyRej = null;
    this.ready = new Promise((res, rej) => { this._readyRes = res; this._readyRej = rej; });
    this.ready.catch(() => {});                          // callers that never await ready must not see an unhandled rejection
    if (connectTimeoutMs > 0) this._readyTimer = setTimeout(() => { if (!this.hello) this._readyRej(new Error(`relay: no hello from ${url} within ${connectTimeoutMs} ms`)); }, connectTimeoutMs);
    this._connect();
  }

  /** `on('state', fn)` → unsubscribe */
  on(type, fn) { (this._listeners[type] ||= []).push(fn); return () => { const a = this._listeners[type]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }; }
  _emit(type, detail) { for (const fn of this._listeners[type] || []) { try { fn(detail); } catch (e) { console.error('[ws-relay] listener', e); } } }
  _setState(state, extra = {}) { this.state = state; this._emit('state', { state, attempt: this._attempt, ...extra }); }

  _connect() {
    if (this._closed) return;
    this._attempt++; this.stats.attempts++;
    this._setState('connecting', { reconnecting: this.stats.connects > 0 });
    let ws;
    try { ws = new this._WS(this.url); } catch (e) { this._scheduleReconnect(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = ev => {
      if (ws !== this.ws) return;
      if (typeof ev.data === 'string') {                // JSON control frames: {hello:{clientId, peers, serverNow}}, {joined}, {left}
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.hello) this._onHello(m.hello); else this.onControl?.(m);
        return;
      }
      const bytes = ev.data instanceof ArrayBuffer ? ev.data : (ev.data?.buffer ? ev.data.buffer.slice(ev.data.byteOffset, ev.data.byteOffset + ev.data.byteLength) : ev.data);
      this.cbs.forEach(cb => cb(bytes));
    };
    ws.onerror = () => { /* the close that follows drives the reconnect */ };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this._opts.reconnect && !this._closed) this._scheduleReconnect();   // emits ONE 'closed' {willReconnect:true, delayMs}
      else this._setState('closed', { willReconnect: false });
    };
  }

  _onHello(h) {
    const first = !this.hello;
    this.relayId = h.clientId;
    if (first) { this.id = h.clientId; this.hello = h; this.stats.connects++; clearTimeout(this._readyTimer); }
    else { this.stats.connects++; this.stats.reconnects++; }
    this._attempt = 0;
    this._setState('open', { hello: h, reconnected: !first });
    if (first) { this._readyRes(h); this.onControl?.({ hello: h }); }
    else { this.onControl?.({ hello: h, reconnected: true }); this.onControl?.({ joined: h.clientId, reconnected: true }); }   // re-announce: Room answers `joined` with PRESENCE at once
    const q = this.queue.splice(0); this.stats.queued = 0;
    for (const b of q) { try { this.ws?.send(b); } catch { /* socket went away again; the next hello flushes */ } }
  }

  _scheduleReconnect() {
    if (this._closed || this._timer) return;
    const d = this._opts.delaysMs;
    const delayMs = d[Math.min(Math.max(this._attempt - 1, 0), d.length - 1)];
    this._setState('closed', { willReconnect: true, delayMs });
    this._timer = setTimeout(() => { this._timer = null; this._connect(); }, delayMs);
  }

  /** TCP: both buses share one ordered socket. `reliable` only matters while the socket is down (see the class comment). */
  send(bytes, { reliable = false } = {}) {
    if (this.ws && this.ws.readyState === this._WS.OPEN && this.relayId) { this.ws.send(bytes); return; }
    if (!this.hello || reliable) {
      this.queue.push(bytes);
      if (this.queue.length > this._opts.maxQueue) this.queue.shift();
      this.stats.queued = this.queue.length;
    } else this.stats.droppedUnreliable++;
  }
  onMessage(cb) { this.cbs.push(cb); }
  /** stop for good: no reconnect, `state` -> 'closed' with willReconnect:false */
  close() {
    this._closed = true;
    clearTimeout(this._timer); this._timer = null; clearTimeout(this._readyTimer);
    if (!this.hello) this._readyRej(new Error('relay: closed before hello'));
    const ws = this.ws; this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this._setState('closed', { willReconnect: false });
  }
}

// ── 3. WebRTC data channels (mesh of 2–4) ────────────────────────────────────
export class RtcTransport {
  /**
   * @param {object} o
   * @param {(msg:object)=>void} o.signalSend         send {sdp}|{candidate} to the peer (any tiny signaling path)
   * @param {(cb:(msg:object)=>void)=>void} o.signalOn receive the peer's messages
   * @param {boolean} o.polite                         perfect-negotiation role
   * @param {RTCIceServer[]} o.iceServers              include a TURN server for the pairs STUN cannot connect
   */
  constructor({ signalSend, signalOn, polite, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }] }) {
    this.id = randId();
    this.pc = new RTCPeerConnection({ iceServers });
    this.cbs = [];
    // presence bus: newest-wins, drop instead of retransmit (maxRetransmits:0; never also set maxPacketLifeTime)
    this.chBall = this.pc.createDataChannel('ball', { ordered: false, maxRetransmits: 0 });
    // state bus: reliable + ordered (the defaults)
    this.chState = this.pc.createDataChannel('state', { ordered: true });
    for (const ch of [this.chBall, this.chState]) { ch.binaryType = 'arraybuffer'; ch.onmessage = ev => this.cbs.forEach(cb => cb(ev.data)); }
    this.pc.ondatachannel = ev => { ev.channel.binaryType = 'arraybuffer'; ev.channel.onmessage = e => this.cbs.forEach(cb => cb(e.data)); };
    this.pc.onicecandidate = ev => ev.candidate && signalSend({ candidate: ev.candidate });
    // perfect negotiation (https://developer.mozilla.org/docs/Web/API/WebRTC_API/Perfect_negotiation)
    let makingOffer = false;
    this.pc.onnegotiationneeded = async () => { try { makingOffer = true; await this.pc.setLocalDescription(); signalSend({ sdp: this.pc.localDescription }); } finally { makingOffer = false; } };
    signalOn(async msg => {
      if (msg.sdp) {
        const collision = msg.sdp.type === 'offer' && (makingOffer || this.pc.signalingState !== 'stable');
        if (!polite && collision) return;
        await this.pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') { await this.pc.setLocalDescription(); signalSend({ sdp: this.pc.localDescription }); }
      } else if (msg.candidate) { try { await this.pc.addIceCandidate(msg.candidate); } catch (e) { if (!polite) throw e; } }
    });
  }
  send(bytes, { reliable = false } = {}) {
    const ch = reliable ? this.chState : this.chBall;
    if (ch.readyState === 'open') ch.send(bytes);
  }
  onMessage(cb) { this.cbs.push(cb); }
  close() { this.pc.close(); }
}

// ── 4. Live Share (inside Teams only) ────────────────────────────────────────
/**
 * Usage (bundled app; these packages are npm, not CDN — peer deps `fluid-framework`,
 * `@fluidframework/azure-client`, and `@microsoft/teams-js` >= 2.23.0):
 *
 *   import { LiveShareClient, LiveEvent, LiveState, TestLiveShareHost, UserMeetingRole } from '@microsoft/live-share';
 *   import { LiveShareHost } from '@microsoft/teams-js';           // after app.initialize()
 *   const host = inTeams ? LiveShareHost.create() : TestLiveShareHost.create();
 *   const t = await LiveShareTransport.create(host, { LiveShareClient, LiveEvent, LiveState,
 *                 allowedRoles: [UserMeetingRole.organizer, UserMeetingRole.presenter] });
 *   clock.adoptGlobal((await host.getNtpTime()).ntpTimeInUTC);     // the session clock IS Live Share's global time
 *
 * Constraints (FAQ, verified): Teams-only (TestLiveShareHost is for dev); "one message per 50 milliseconds or
 * more" → BALL_STATE at ≤ 20 Hz; LiveEvent delivery is not guaranteed → LAUNCH/CLAIM/GOAL/SEAT_MAP go through
 * LiveState keys (last-writer-wins, reset when everyone leaves); payloads are JSON → base64 the bytes.
 */
export class LiveShareTransport {
  static async create(host, { LiveShareClient, LiveEvent, LiveState, allowedRoles } = {}) {
    const client = new LiveShareClient(host);
    const schema = { initialObjects: { ballEvent: LiveEvent, launch: LiveState, claim: LiveState, goal: LiveState, seatMap: LiveState } };
    const { container } = await client.joinContainer(schema);      // ILiveShareJoinResults
    const t = new LiveShareTransport(container.initialObjects, allowedRoles);
    await t._init();
    return t;
  }
  constructor(objs, allowedRoles, { bundleMs = 50 } = {}) { this.o = objs; this.roles = allowedRoles; this.cbs = []; this.id = null; this._pending = new Map(); this._timer = null; this.bundleMs = bundleMs; }
  async _init() {
    const { ballEvent, launch, claim, goal, seatMap } = this.o;
    // register listeners BEFORE initialize() (docs: received events are not emitted until after initialize)
    ballEvent.on('received', (evt, local) => { if (!local) this._deliver(evt); });
    for (const st of [launch, claim, goal, seatMap]) st.on('stateChanged', (value, local, clientId) => { if (!local && value) this._deliver(value); });
    await ballEvent.initialize();                       // anyone may send presence
    await launch.initialize(null); await claim.initialize(null); await goal.initialize(null);
    await seatMap.initialize(null, this.roles);         // host-only key: e.g. [UserMeetingRole.organizer, UserMeetingRole.presenter]
    // clientId + global timestamp come back on the sent ILiveEvent {name, clientId, timestamp, data}
    const sent = await ballEvent.send({ hello: 1 });
    this.id = sent.clientId; this.globalNow = sent.timestamp;
    this._timer = setInterval(() => this._flush(), this.bundleMs);   // FAQ: one message per ≥ 50 ms — a bundle counts as one
  }
  _deliver(payload) {
    if (!payload) return;
    if (typeof payload.b === 'string') { const buf = b64ToBytes(payload.b); this.cbs.forEach(cb => cb(buf)); return; }   // single (reliable keys)
    if (Array.isArray(payload.f)) for (const b of payload.f) { if (typeof b !== 'string') continue; const buf = b64ToBytes(b); this.cbs.forEach(cb => cb(buf)); }   // bundle
  }
  _flush() {
    if (!this._pending.size) return;
    const f = [...this._pending.values()].map(bytesToB64); this._pending.clear();
    this.o.ballEvent.send({ f });                        // latest packet of each type, one signal
  }
  send(bytes, { reliable = false } = {}) {
    const type = new Uint8Array(bytes)[0];
    if (!reliable) { this._pending.set(type, bytes.slice(0)); return; }   // latest-wins per type until the next 50 ms flush
    const b = bytesToB64(bytes);
    const key = type === 0x11 ? 'launch' : type === 0x12 ? 'claim' : type === 0x14 ? 'goal' : type === 0x20 ? 'seatMap' : 'launch';
    this.o[key].set({ b, n: Date.now() });              // `n` makes each set a new value even if the bytes repeat
  }
  onMessage(cb) { this.cbs.push(cb); }
  close() { if (this._timer) clearInterval(this._timer); this._timer = null; /* the container's lifetime is managed by Live Share */ }
}

// ── gated(): the sharing gate (twin: nothing leaves this client while the user is not sharing) ─────────────────
/**
 * Wrap a transport so `send()` is a no-op while `isSharing()` is false (counted in `stats.suppressed`); `onMessage`
 * passes straight through (you still SEE the room), `id` / `ready` / `onControl` / `close` are forwarded.
 * @param {{id?:string, send:Function, onMessage:Function, close:Function}} transport
 * @param {() => boolean} isSharing
 */
export function gated(transport, isSharing) {
  const stats = { sent: 0, suppressed: 0 };
  const g = {
    get id() { return transport.id; },
    get ready() { return transport.ready; },
    get inner() { return transport; },
    stats,
    send(bytes, opts) { if (!isSharing()) { stats.suppressed++; return; } stats.sent++; return transport.send(bytes, opts); },
    onMessage(cb) { return transport.onMessage(cb); },
    onControl(cb) { return transport.onControl?.(cb); },
    close() { return transport.close(); },
  };
  return g;
}
