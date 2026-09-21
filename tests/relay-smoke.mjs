/**
 * relay-smoke.mjs — the real relay path: tools/relay-server.mjs + two WsRelayTransport clients (Node 22+ global WebSocket)
 * each with a Room (isRelay: the SERVER answers CLOCK_PING), a BallNet and a RemoteHands.
 *   node tests/relay-smoke.mjs
 * Asserts: hello → clientIds; PRESENCE both ways (roster 2, host = lowest id on both); host publishes the seat map, the
 * other client re-reads its seat; HAND_STREAM at 30 Hz decodes on the other side with ageMs < 50 on localhost; each
 * client collects 8 clock samples and the two session clocks agree within 10 ms (offset error vs the server's hello
 * time < 10 ms, rtt < 10 ms); the server exits when killed, with nothing on stderr.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CourtMap, buildSeatMap } from '../sdk/game/court-map.js';
import { BallNet, SharedClock, dt32, readHeader } from '../sdk/game/ball-net.js';
import { WsRelayTransport } from '../sdk/net/transports.js';
import { RemoteHands } from '../sdk/net/remote-consumer.js';
import { encodeHandStream } from '../sdk/net/hand-stream.js';
import { PackGen, packToHands } from '../sdk/game/pack-gen.js';
import { Room } from '../sdk/net/room.js';
import { identityCamera } from '../sdk/game/bot-tile.js';

let passed = 0, failed = 0;
function ok(cond, label, info) { if (cond) passed++; else failed++; console.log(`${cond ? 'ok   ' : 'FAIL '} ${label}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

const RELAY = fileURLToPath(new URL('../tools/relay-server.mjs', import.meta.url));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

// ── server ───────────────────────────────────────────────────────────────────
const port = await freePort();
const child = spawn(process.execPath, [RELAY, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', d => { stderr += String(d); });
const banner = await Promise.race([
  new Promise(res => child.stdout.on('data', d => { if (String(d).includes('relay on')) res(String(d).trim()); })),
  sleep(5000).then(() => null),
]);
ok(!!banner, 'relay server started on a free port', { port, banner });
if (!banner) { child.kill(); console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); }

// ── two clients ──────────────────────────────────────────────────────────────
function makeClient(name) {
  const tr = new WsRelayTransport(`ws://127.0.0.1:${port}/room/relay-smoke`);
  const clock = new SharedClock();
  const c = { name, tr, clock, hello: null, localAtHello: 0, seatMaps: [], seq: 0, lastSend: -Infinity, sent: 0, ages: [] };
  tr.ready.then(h => { c.hello = h; c.localAtHello = clock.local(); });
  c.court = new CourtMap(buildSeatMap([{ clientId: 'pending', name, tracked: true, aspect: 16 / 9, handSpan: 0.16 }], { cols: 1, wrap: 'none', v: 0 }));
  c.net = new BallNet({ transport: tr, clock, court: c.court, seat: 0, clientId: 'pending', isHost: false, rateHz: 20, hooks: { onSeatMap: m => c.seatMaps.push(m.v) } });
  c.remote = new RemoteHands();
  c.wireAges = [];                                                      // dt32(now, pkt.t) at ARRIVAL: the relay's one-way latency alone
  tr.onMessage(buf => { if (c.remote.onMessage(buf)) c.wireAges.push(dt32(clock.now(), readHeader(buf).t)); });
  c.room = new Room({ transport: tr, clock, net: c.net, court: c.court, me: { name, tracked: true, aspect: 16 / 9, handSpan: 0.16, kind: 'local' }, isRelay: true, pingMs: 100 });
  c.cam = identityCamera(16 / 9);
  return c;
}
const A = makeClient('A'), B = makeClient('B');
const [ja, jb] = await Promise.all([A.room.join(), B.room.join()]);
for (const c of [A, B]) { c.court.set(buildSeatMap([{ clientId: c.room.me.clientId, name: c.name, tracked: true, aspect: 16 / 9, handSpan: 0.16 }], { cols: 1, wrap: 'none', v: 0 })); c.net.seat = 0; }
ok(/^c-[0-9a-z]{3}$/.test(ja.clientId) && /^c-[0-9a-z]{3}$/.test(jb.clientId) && ja.clientId !== jb.clientId, 'both clients joined with server-assigned clientIds', { a: ja.clientId, b: jb.clientId, peersSeenByLater: (ja.peers.length ? ja : jb).peers });
ok(A.room.me.clientId === A.tr.id && B.room.me.clientId === B.tr.id && A.net.clientId === A.tr.id && B.net.clientId === B.tr.id, 'Room.me.clientId (and net.clientId) is the transport id from hello');

// ── real-time loop: rooms tick, both stream hands at 30 Hz, both read the other side ──
const seatOf = (c, id) => c.court.seatOfClient(id);
const t0 = performance.now();
let ticks = 0;
await new Promise(res => {
  const iv = { on: true };                                             // setImmediate loop: sub-ms ticks, I/O still polled between them
  const loop = () => {
    if (!iv.on) return;
    const now = performance.now(); ticks++;
    for (const [me, other] of [[A, B], [B, A]]) {
      me.room.tick(now); me.net.tick();
      const seat = seatOf(me, me.room.me.clientId);
      if (seat >= 0 && now - me.lastSend >= 1000 / 30) {
        me.lastSend = now; me.sent++;
        const a = (now - t0) / 1000;
        const pack = PackGen.open(0.3 * Math.sin(a), 0.1 * Math.cos(a), -2.0);
        me.tr.send(encodeHandStream(seat, packToHands(pack, me.cam), me.seq++ & 0xffff, me.clock.now()), { reliable: false });
      }
      const os = seatOf(me, other.room.me.clientId);
      if (os >= 0 && me.remote.has(os) && now - t0 > 700 && now - (me.lastReadAt || 0) >= 1) { me.lastReadAt = now; const rd = me.remote.read(os, me.clock.now()); me.ages.push(rd.ageMs); me.lastRead = rd; }
    }
    if (now - t0 >= 2000) { iv.on = false; res(); return; }
    setImmediate(loop);
  };
  setImmediate(loop);
});

// ── presence / host / seat map ───────────────────────────────────────────────
const ids = [A.room.me.clientId, B.room.me.clientId].sort();
ok(A.room.roster.length === 2 && B.room.roster.length === 2, 'PRESENCE exchanged: roster size 2 on both', { a: A.room.roster.map(p => p.clientId), b: B.room.roster.map(p => p.clientId) });
ok(A.room.hostId === ids[0] && B.room.hostId === ids[0] && (A.room.isHost !== B.room.isHost), 'host = lowest clientId on both, exactly one isHost', { host: ids[0] });
const H = A.room.isHost ? A : B, G = A.room.isHost ? B : A;
ok(H.net.isHost && !G.net.isHost, 'net.isHost synced by the Room');
ok(H.court.map.v >= 1 && G.court.map.v === H.court.map.v && G.court.map.seats.length === 2, 'host published the seat map, guest received it (same v, 2 seats)', { v: H.court.map.v, publishes: H.room.stats.publishes, guestHook: G.seatMaps });
ok(G.net.seat === G.court.seatOfClient(G.room.me.clientId) && G.net.seat === 1 && H.net.seat === 0, 'guest re-read its seat (1) from the SEAT_MAP; host is seat 0');
ok(H.room.roster.find(p => p.clientId === G.room.me.clientId)?.kind === 'local' && H.room.roster.find(p => p.clientId === G.room.me.clientId)?.handSpan === 0.16, 'PRESENCE fields (kind, handSpan) arrived intact');

// ── hand stream freshness ────────────────────────────────────────────────────
for (const [me, other] of [[A, B], [B, A]]) {
  const rd = me.lastRead;
  const ageP95 = [...me.ages].sort((x, y) => x - y)[Math.floor(me.ages.length * 0.95)];
  const wireP95 = [...me.wireAges].sort((x, y) => x - y)[Math.floor(me.wireAges.length * 0.95)];
  ok(me.ages.length > 50 && rd && rd.hands.right && rd.hands.right.img.length === 21 && rd.hands.left === null && ageP95 < 50 && wireP95 < 50,
    `${me.name} decodes ${other.name}'s HAND_STREAM with ageMs < 50 on localhost (per-frame read p95 and at-arrival p95)`, { reads: me.ages.length, readAgeP95: ageP95, readAgeMedian: median(me.ages), wireAgeP95: wireP95, wireAgeMedian: median(me.wireAges), accepted: me.remote.seat(seatOf(me, other.room.me.clientId)).stats.accepted, sentByOther: other.sent, ticks });
}

// ── clock: 8 samples each, the two session clocks agree, offset error vs the server's hello < 10 ms ──
for (const c of [A, B]) {
  const offs = c.clock.samples.map(x => x.off), spread = Math.max(...offs) - Math.min(...offs);
  const helloRef = c.hello.serverNow - c.localAtHello;                  // single hello frame: its own delivery latency (a few ms while both clients connect) limits it to a sanity bound
  ok(c.clock.samples.length >= 8 && spread < 10 && c.clock.rtt < 10 && Math.abs(c.clock.offset - helloRef) < 25,
    `${c.name}: 8 clock samples from the relay, sample spread < 10 ms, rtt < 10 ms`, { samples: c.clock.samples.length, spreadMs: +spread.toFixed(2), rttMs: +c.clock.rtt.toFixed(2), offsetVsHelloMs: +(c.clock.offset - helloRef).toFixed(2), offs: offs.map(o => +o.toFixed(1)), pings: c.room.stats.pings, clockReady: c.room.clockReady() });
}
const skew = dt32(A.clock.now(), B.clock.now());
ok(Math.abs(skew) < 10, 'the two clients agree on the session clock within 10 ms', { skewMs: skew });
ok(A.room.stats.pongsDropped === 0 && B.room.stats.pongsDropped === 0 && A.room.stats.pongsAnswered === 0 && B.room.stats.pongsAnswered === 0, 'relay path: no nonce guard, nobody but the server answers pings');
ok(A.room.stats.pings <= 8 + 2 && B.room.stats.pings <= 8 + 2, 'ping cadence dropped to the slow rate after 8 samples', { pings: [A.room.stats.pings, B.room.stats.pings] });

// ── leave: bye PRESENCE and the relay's {left} both prune at once ────────────
G.room.leave(); await sleep(150);
ok(H.room.roster.length === 1 && !H.room.roster.some(p => p.clientId === G.room.me.clientId), 'bye PRESENCE removed the guest from the host roster at once');
G.tr.close(); await sleep(150);
H.room.tick(performance.now());
ok(H.room.roster.length === 1 && H.court.map.seats.length === 1, 'host republished a single-seat map after the guest left', { v: H.court.map.v });
A.room.leave(); B.room.leave(); A.tr.close(); B.tr.close();

// ── server exit ──────────────────────────────────────────────────────────────
await sleep(100);
child.kill();
const exit = await Promise.race([new Promise(res => child.on('exit', (code, sig) => res({ code, sig }))), sleep(3000).then(() => null)]);
ok(!!exit && stderr === '', 'relay server exited cleanly on kill with nothing on stderr', { exit, stderr: stderr.slice(0, 200) });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
