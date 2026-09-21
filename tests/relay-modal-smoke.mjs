/**
 * relay-modal-smoke.mjs — protocol check of the HOSTED relay (tools/relay_modal.py on Modal) with two raw `ws` clients.
 *   node tests/relay-modal-smoke.mjs                       # against RELAY_DEFAULT from sdk/net/room-link.js
 *   node tests/relay-modal-smoke.mjs wss://host            # against any relay base URL (argv or RELAY_URL env)
 *   node tests/relay-modal-smoke.mjs --local               # spawns tools/relay-server.mjs on a free port instead (same protocol)
 * Asserts (docs/teams/MULTIUSER.md §protocol): hello {clientId, room:'/room/smoke', peers, serverNow}; B's hello lists A and
 * A gets {joined:B}; a binary frame from A reaches B unchanged and never echoes back to A; CLOCK_PING (0x01) is answered with
 * a 20-byte CLOCK_PONG (0x02) within 1 s that echoes seq/header/t0 and carries two u32 server times; B closing gives A {left:B}.
 * Prints the ping RTT. Exit code 1 on any failure.
 */
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { RELAY_DEFAULT } from '../sdk/net/room-link.js';

let passed = 0, failed = 0;
const ok = (c, label, info) => { if (c) passed++; else failed++; console.log(`${c ? 'ok   ' : 'FAIL '} ${label}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${ms} ms: ${what}`); })]);

const argv = process.argv.slice(2);
const LOCAL = argv.includes('--local');
let base = argv.find(a => /^wss?:\/\//.test(a)) || process.env.RELAY_URL || RELAY_DEFAULT;
let child = null;
if (LOCAL || !base) {
  if (!base) console.log('(RELAY_DEFAULT is empty — falling back to a local tools/relay-server.mjs)');
  const port = await new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
  child = spawn(process.execPath, [fileURLToPath(new URL('../tools/relay-server.mjs', import.meta.url)), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await withTimeout(new Promise(res => child.stdout.on('data', d => { if (String(d).includes('relay on')) res(); })), 5000, 'local relay banner');
  base = `ws://127.0.0.1:${port}`;
}
base = base.replace(/\/+$/, '');
const ROOM = 'smoke-' + Math.random().toString(36).slice(2, 7);   // a fresh room per run: peers[] must start with just A
const url = `${base}/room/${ROOM}`;
console.log(`relay: ${url}${LOCAL ? '  (local tools/relay-server.mjs)' : '  (hosted)'}`);

class Client {
  constructor(name) {
    this.name = name; this.text = []; this.bin = []; this.waiters = [];
    this.ws = new WebSocket(url); this.ws.binaryType = 'nodebuffer';
    this.t0 = performance.now();
    this.open = new Promise((res, rej) => { this.ws.once('open', () => res(performance.now() - this.t0)); this.ws.once('error', rej); });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) this.bin.push(Buffer.from(data)); else { try { this.text.push(JSON.parse(String(data))); } catch { this.text.push({ raw: String(data) }); } }
      this.waiters = this.waiters.filter(w => !w());
    });
  }
  /** resolve when a received frame satisfies pred (checks the backlog first) */
  wait(pred, ms, what) {
    const scan = () => { for (const m of this.text) if (pred(m, null)) return m; for (const b of this.bin) if (pred(null, b)) return b; return null; };
    const hit = scan(); if (hit) return Promise.resolve(hit);
    return withTimeout(new Promise(res => this.waiters.push(() => { const h = scan(); if (h) { res(h); return true; } return false; })), ms, `${this.name} ${what}`);
  }
  hello() { return this.wait(m => m && m.hello, 10000, 'hello').then(m => m.hello); }
  close() { this.ws.close(); }
}

try {
  // ── A joins: hello with itself as the only peer ──
  const A = new Client('A');
  const openMsA = await withTimeout(A.open, 20000, 'A open (cold start can take a few seconds)');
  const ha = await A.hello();
  ok(typeof ha.clientId === 'string' && /^c-[0-9a-z]{3,}$/.test(ha.clientId), 'A hello.clientId is a relay id (c-xxx)', { clientId: ha.clientId, openMs: +openMsA.toFixed(0) });
  ok(ha.room === `/room/${ROOM}`, 'A hello.room is the path string', { room: ha.room });
  ok(Array.isArray(ha.peers) && ha.peers.length === 1 && ha.peers[0] === ha.clientId, 'A hello.peers = [A] (fresh room)', { peers: ha.peers });
  ok(Number.isInteger(ha.serverNow) && ha.serverNow >= 0 && ha.serverNow < 2 ** 32, 'A hello.serverNow is a u32 ms clock', { serverNow: ha.serverNow });

  // ── B joins: its hello lists A; A gets {joined: B} ──
  const B = new Client('B');
  await withTimeout(B.open, 20000, 'B open');
  const hb = await B.hello();
  ok(hb.clientId !== ha.clientId && hb.clientId > ha.clientId, 'B got a distinct, lexically later clientId (lowest id = host)', { a: ha.clientId, b: hb.clientId });
  ok(hb.peers.includes(ha.clientId) && hb.peers.includes(hb.clientId) && hb.peers.length === 2, 'B hello.peers lists A and B', { peers: hb.peers });
  const joined = await A.wait(m => m && m.joined === hb.clientId, 3000, '{joined:B}');
  ok(!!joined, 'A received {joined: B}', joined);
  ok(!B.text.some(m => m.joined), 'B did not receive its own joined notice');

  // ── binary fan-out: A -> B unchanged, no echo to A ──
  const payload = Buffer.alloc(24); payload[0] = 0x30; for (let i = 1; i < 24; i++) payload[i] = (i * 37 + 11) & 0xff;
  A.ws.send(payload, { binary: true });
  const got = await B.wait((_, b) => b && b.length === 24 && b[0] === 0x30, 3000, 'binary frame from A');
  ok(Buffer.compare(got, payload) === 0, 'B received A\'s binary frame byte-for-byte', { bytes: got.length });
  await sleep(150);
  ok(!A.bin.some(b => b[0] === 0x30), 'A did not get its own frame echoed back');
  ok(!A.text.some(m => m.raw) && !B.text.some(m => m.raw), 'every text frame was JSON');

  // ── CLOCK_PING -> CLOCK_PONG within 1 s ──
  const ping = Buffer.alloc(12); ping[0] = 0x01; ping[1] = 0x7a; ping.writeUInt16LE(0x1234, 2); ping.writeUInt32LE(0xdeadbeef, 4); ping.writeUInt32LE(123456789, 8);
  const tSend = performance.now();
  A.ws.send(ping, { binary: true });
  const pong = await A.wait((_, b) => b && b[0] === 0x02, 1000, 'CLOCK_PONG');
  const rtt = performance.now() - tSend;
  const t1 = pong.readUInt32LE(12), t2 = pong.readUInt32LE(16);
  ok(pong.length === 20, 'CLOCK_PONG is 20 bytes', { len: pong.length });
  ok(pong[1] === 0x7a && pong.readUInt16LE(2) === 0x1234 && pong.readUInt32LE(4) === 0xdeadbeef, 'pong echoes ping[1], seq and header t');
  ok(pong.readUInt32LE(8) === 123456789, 'pong echoes the client t0 at [8..12)');
  ok(t2 >= t1 && t2 - t1 < 50 && t1 >= ha.serverNow, 'pong carries server receive (t1) <= send (t2) u32 ms on the session clock', { t1, t2, helloServerNow: ha.serverNow });
  ok(rtt < 1000, `CLOCK_PING round trip ${rtt.toFixed(1)} ms (< 1 s)`, { rttMs: +rtt.toFixed(1) });
  await sleep(100);
  ok(!B.bin.some(b => b[0] === 0x01 || b[0] === 0x02), 'B saw neither the ping nor the pong (answered to the sender only)');

  // a few more pings for a median RTT
  const rtts = [rtt];
  for (let i = 0; i < 4; i++) {
    A.bin.length = 0; const p = Buffer.alloc(12); p[0] = 0x01; p.writeUInt16LE(i, 2); const ts = performance.now();
    A.ws.send(p, { binary: true }); await A.wait((_, b) => b && b[0] === 0x02, 1000, 'pong ' + i); rtts.push(performance.now() - ts);
  }
  const sorted = [...rtts].sort((x, y) => x - y);
  console.log(`RTT ms: min ${sorted[0].toFixed(1)}  median ${sorted[sorted.length >> 1].toFixed(1)}  max ${sorted[sorted.length - 1].toFixed(1)}  (${rtts.length} pings)`);

  // ── B leaves: A gets {left: B} ──
  B.close();
  const left = await A.wait(m => m && m.left === hb.clientId, 3000, '{left:B}');
  ok(!!left, 'A received {left: B} after B closed', left);
  A.close();

  // ── WsRelayTransport reconnect (always against a LOCAL relay so the server can be killed and restarted on the same port) ──
  if (!argv.includes('--no-reconnect')) {
    console.log('\nreconnect: WsRelayTransport vs a local tools/relay-server.mjs that dies and comes back');
    const { WsRelayTransport } = await import('../sdk/net/transports.js');
    const RELAY = fileURLToPath(new URL('../tools/relay-server.mjs', import.meta.url));
    const port = await new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
    const start = async () => { const c = spawn(process.execPath, [RELAY, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] }); await withTimeout(new Promise(res => c.stdout.on('data', d => { if (String(d).includes('relay on')) res(); })), 5000, 'local relay banner'); return c; };
    let srv = await start();
    const events = [], controls = [];
    const tr = new WsRelayTransport(`ws://127.0.0.1:${port}/room/reconnect`, { delaysMs: [300, 600, 1200, 2400] });
    tr.on('state', e => events.push({ state: e.state, r: !!e.willReconnect, rc: !!e.reconnected, at: performance.now() }));
    tr.onControl = m => controls.push(m);
    const h1 = await withTimeout(tr.ready, 5000, 'first hello');
    ok(tr.id === h1.clientId && tr.state === 'open', 'first hello sets id and state open', { id: tr.id });
    const peer = new WebSocket(`ws://127.0.0.1:${port}/room/reconnect`);   // a peer to observe left/joined + fan-out after the reconnect
    await withTimeout(new Promise(r => peer.once('open', r)), 3000, 'peer open');
    await sleep(100);
    srv.kill(); await withTimeout(new Promise(r => srv.on('exit', r)), 3000, 'server exit');
    await sleep(200);
    ok(tr.state === 'closed' && events.some(e => e.state === 'closed' && e.r), 'server death -> state closed with willReconnect', { events: events.map(e => e.state + (e.r ? '+r' : '')) });
    tr.send(new Uint8Array([0x40, 1, 2, 3]).buffer, { reliable: true });   // queued while down
    tr.send(new Uint8Array([0x41, 1, 2, 3]).buffer, { reliable: false });  // dropped while down
    ok(tr.stats.queued === 1 && tr.stats.droppedUnreliable === 1, 'while down: reliable sends queue, unreliable ones drop', { queued: tr.stats.queued, dropped: tr.stats.droppedUnreliable });
    await sleep(800);                                                       // let >= 1 attempt fail against the dead port
    srv = await start();
    const peer2 = new WebSocket(`ws://127.0.0.1:${port}/room/reconnect`); peer2.binaryType = 'nodebuffer';
    const peerBin = []; peer2.on('message', (d, isBin) => { if (isBin) peerBin.push(Buffer.from(d)); });
    await withTimeout(new Promise(r => peer2.once('open', r)), 3000, 'peer2 open');
    const tOpen = await withTimeout(new Promise(res => { const iv = setInterval(() => { if (tr.state === 'open' && tr.stats.reconnects >= 1) { clearInterval(iv); res(performance.now()); } }, 20); }), 8000, 'reconnect');
    const re = events.find(e => e.state === 'open' && e.rc);
    ok(!!re && tr.stats.reconnects === 1 && tr.stats.attempts >= 2, 'reconnected: state open (reconnected:true) after >= 2 attempts with backoff', { attempts: tr.stats.attempts, reconnects: tr.stats.reconnects, states: events.map(e => e.state + (e.r ? '+r' : '') + (e.rc ? '*' : '')) });
    ok(tr.id === h1.clientId && tr.relayId !== h1.clientId, 'session id kept across the reconnect; the relay id is new', { id: tr.id, relayId: tr.relayId });
    ok(controls.some(m => m.hello && m.reconnected) && controls.some(m => m.joined === tr.relayId && m.reconnected), 'onControl got {hello, reconnected} then {joined:<new relay id>} (Room re-sends PRESENCE)', { controls: controls.map(m => Object.keys(m)[0]) });
    await sleep(150);
    ok(peerBin.some(b => b[0] === 0x40) && !peerBin.some(b => b[0] === 0x41), 'the queued reliable frame was flushed to the new socket, the dropped one never sent', { peerFrames: peerBin.map(b => b[0]) });
    tr.close(); peer2.close(); try { peer.close(); } catch { /* already dead */ }
    ok(tr.state === 'closed' && events.at(-1).state === 'closed' && !events.at(-1).r, 'close() -> closed without reconnect');
    await sleep(50); srv.kill();
  }
} catch (e) {
  failed++; console.log('FAIL  ' + (e && e.message || e));
} finally {
  if (child) { child.kill(); await sleep(50); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
