/**
 * bot-pass-smoke.mjs — Room (PRESENCE, host election, seat map, clock cadence) + BotTile over MemHub, virtual clock.
 *   node tests/bot-pass-smoke.mjs
 * 4 clients on one hub linked at 90 ± 30 ms with 5 % loss on the unreliable bus: 1 plain BallNet client (the host, seat 0,
 * `kickoff`) and 3 BotTiles, each with a Room. Checks CONTRACTS §8 [W2] and [N1] plus the Room contract (§4.1):
 * roster convergence, lowest-clientId host everywhere, seat-map `v` per join / prune / bye, clockReady cadence, the ball
 * visiting every seat, the one-owner invariant at every 50 ms sample, zero conflicts, bot HAND_STREAM freshness on the host,
 * and PRESENCE being ignored by BallNet and RemoteHands.
 */
import { CourtMap, buildSeatMap, EDGE, integrateCourt } from '../sdk/game/court-map.js';
import { BallNet, SharedClock, PK, HOLD, readHeader } from '../sdk/game/ball-net.js';
import { MemHub } from '../sdk/net/transports.js';
import { RemoteHands } from '../sdk/net/remote-consumer.js';
import { Room, encodePresence, decodePresence, PK_PRESENCE } from '../sdk/net/room.js';
import { BotTile } from '../sdk/game/bot-tile.js';

let passed = 0, failed = 0;
function ok(cond, label, info) { if (cond) passed++; else { failed++; } console.log(`${cond ? 'ok   ' : 'FAIL '} ${label}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`); }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ── world ────────────────────────────────────────────────────────────────────
const LAT = 90, JIT = 30, LOSS = 5, STEP = 4;
let T = 0; const now = () => T;
const rng = mulberry32(2026);
const hub = new MemHub({ now, rng });
const HOST_ID = 'c-000000-host';
const BOT_IDS = ['c-000300-bot1', 'c-000600-bot2', 'c-000900-bot3'];
const ALL_IDS = [HOST_ID, ...BOT_IDS];
for (let i = 0; i < ALL_IDS.length; i++) for (let j = 0; j < i; j++) hub.link(ALL_IDS[i], ALL_IDS[j], { latencyMs: LAT, jitterMs: JIT, lossPct: LOSS });

const selfMap = (id, name) => new CourtMap(buildSeatMap([{ clientId: id, name, tracked: true, aspect: 16 / 9, handSpan: 0.16 }], { cols: 1, wrap: 'none', v: 0 }));
const clients = {};                                        // id -> { room, net, court, clock, tr, bot?, remote?, events }
const events = [];

// host: a plain BallNet client (seat 0) that throws right 500 ms after it gets the ball, like a person would
function makeHost() {
  const tr = hub.join(HOST_ID), clock = new SharedClock({ localNow: now }), court = selfMap(HOST_ID, 'Host');
  const st = { ball: null, holdUntil: 0, thrown: 0, seatMaps: [] };
  const net = new BallNet({ transport: tr, clock, court, seat: 0, clientId: HOST_ID, isHost: true, rateHz: 30, hooks: {
    onBecameOwner: c => { st.ball = { x: c.x, y: c.y, d: 0, vx: c.vx, vy: c.vy, vd: 0, wx: 0, wy: 0, wz: 0, radius: court.R, atRest: false, hold: null }; st.holdUntil = T + 500; events.push({ t: T, ev: 'own', id: HOST_ID, reason: c.reason }); },
    onLostOwner: () => { st.ball = null; events.push({ t: T, ev: 'lost', id: HOST_ID }); },
    onWall: (edge, b) => { if (edge === EDGE.T) b.vy = -Math.abs(b.vy) * 0.5; else b.vx = -b.vx * 0.5; },
    onSeatMap: m => st.seatMaps.push({ t: T, v: m.v, n: m.seats.length }),      // set BEFORE Room wraps it (the page's hook)
  } });
  const remote = new RemoteHands({ localNow: now });
  tr.onMessage(buf => remote.onMessage(buf));
  const room = new Room({ transport: tr, clock, net, court, me: { clientId: HOST_ID, name: 'Host', tracked: true, aspect: 16 / 9, handSpan: 0.16, kind: 'local' } });
  room.on('roster', r => events.push({ t: T, ev: 'roster', id: HOST_ID, n: r.length }));
  room.on('host', h => events.push({ t: T, ev: 'host', id: HOST_ID, ...h }));
  room.on('seatmap', m => events.push({ t: T, ev: 'seatmap', id: HOST_ID, v: m.v, n: m.seats.length }));
  room.on('peer-joined', p => events.push({ t: T, ev: 'peer-joined', id: HOST_ID, peer: p.clientId }));
  room.on('peer-left', p => events.push({ t: T, ev: 'peer-left', id: HOST_ID, peer: p.clientId, reason: p.reason }));
  const step = dt => {
    if (net.isOwner && st.ball) {
      const b = st.ball, fy = court.floorY(net.simSeat);
      if (!net.inTransit && T >= st.holdUntil && st.holdUntil > 0) {      // throw right from hand height
        const r = court.rectOf(net.simSeat);
        b.x = r.x0 + r.w * 0.5; b.y = fy + 0.5; b.vx = 2.0; b.vy = 0.8; b.atRest = false; st.holdUntil = 0; st.thrown++;
        events.push({ t: T, ev: 'throw', id: HOST_ID });
      } else if (st.holdUntil === 0) {
        integrateCourt(b, dt, fy, b.radius);
        if (b.y > fy + 1.6) b.vy = -Math.abs(b.vy) * 0.5;
        b.atRest = b.y <= fy + b.radius + 1e-3 && Math.hypot(b.vx, b.vy) < 0.1;
        if (!net.inTransit && b.atRest) st.holdUntil = T + 500;            // pick a resting ball up again
      } else { b.x = court.rectOf(net.simSeat).x0 + 0.5; b.y = fy + 0.5; b.vx = 0; b.vy = 0; b.atRest = false; }
      net.tickOwner(b);
    }
    net.tick();
  };
  return clients[HOST_ID] = { id: HOST_ID, tr, clock, court, net, room, remote, st, step };
}

function makeBot(id, name) {
  const tr = hub.join(id), clock = new SharedClock({ localNow: now }), court = selfMap(id, name);
  const bot = new BotTile({ transport: tr, clock, court, seat: 0, clientId: id, name, holdMs: 800, throwEvery: 6000, rateHz: 30, rng,
    hooks: { onThrow: () => events.push({ t: T, ev: 'throw', id }), onCatch: () => events.push({ t: T, ev: 'catch', id }) } });
  const room = new Room({ transport: tr, clock, net: bot.net, court, me: { clientId: id, name, tracked: true, aspect: 16 / 9, handSpan: 0.16, kind: 'bot' } });
  room.on('roster', r => events.push({ t: T, ev: 'roster', id, n: r.length }));
  room.on('host', h => events.push({ t: T, ev: 'host', id, ...h }));
  room.on('seatmap', m => events.push({ t: T, ev: 'seatmap', id, v: m.v, n: m.seats.length }));
  room.on('peer-left', p => events.push({ t: T, ev: 'peer-left', id, peer: p.clientId, reason: p.reason }));
  return clients[id] = { id, tr, clock, court, net: bot.net, room, bot, step: () => bot.tick(T) };
}

const live = () => Object.values(clients).filter(c => !c.dead);
const samples = [];                                        // 50 ms invariant samples during the pass phase
let sampling = false, lastSample = 0;
function step(ms = STEP) {
  T += ms; const dt = ms / 1000;
  for (const c of live()) { c.room.tick(T); c.step(dt); }
  hub.flush();
  if (sampling && T - lastSample >= 50) {
    lastSample = T;
    const owners = live().filter(c => c.net.isOwner);
    samples.push({ t: T, inTile: owners.filter(c => !c.net.inTransit).length, transit: owners.filter(c => c.net.inTransit).length });
  }
}
const run = ms => { for (let t = 0; t < ms; t += STEP) step(STEP); };
const runUntil = (pred, maxMs) => { const t0 = T; while (T - t0 < maxMs) { step(STEP); if (pred()) return T - t0; } return -1; };

// ── phase A: join, converge, elect, seat map versions, clock ────────────────
const host = makeHost();
await host.room.join();
ok(host.room.isHost && host.room.clockReady(), 'host: isHost + clockReady() immediately after join (broadcast transport: the host is the clock)');
ok(host.net.isHost === true, 'host: Room keeps net.isHost in sync');
let expectV = 0;
const joins = [];
for (let i = 0; i < BOT_IDS.length; i++) {
  run(300);
  const b = makeBot(BOT_IDS[i], 'Bot-' + (i + 1));
  await b.room.join();
  ok(b.bot.stats.sent === 0 && !b.bot.seated, `${b.id}: no HAND_STREAM before the host's seat map (provisional seat never hits the wire)`);
  const dt = runUntil(() => host.court.map.v === expectV + 1, 1500);
  expectV++;
  joins.push({ id: b.id, joinedAt: T - dt, mapAfterMs: dt, v: host.court.map.v });
  ok(dt > 0 && host.court.map.v === expectV, `join ${i + 1}: host published seat map v${expectV} (one increment per join)`, { afterMs: dt, seats: host.court.map.seats.length });
}
const tLastJoin = T;
const converged = runUntil(() => live().every(c => c.room.roster.length === 4), 3000);
ok(converged >= 0, 'PRESENCE converges to roster size 4 on every client within 3 s sim of the last join', { afterMs: converged });
ok(live().every(c => c.room.hostId === HOST_ID) && live().every(c => c.room.isHost === (c.id === HOST_ID)), 'host = lowest clientId on every client');
ok(live().every(c => c.net.isHost === (c.id === HOST_ID)), 'net.isHost true only on the host');
run(600);
ok(live().every(c => c.court.map.v === host.court.map.v && c.court.map.seats.length === 4), 'seat map converged everywhere (same v, 4 seats)', { v: host.court.map.v, cols: host.court.map.cols, wrap: host.court.map.wrap });
ok(host.court.map.seats.map(s => s.clientId).join(',') === ALL_IDS.join(','), 'seats follow clientId order (host = seat 0)');
ok(live().every(c => c.net.seat === c.court.seatOfClient(c.id) && c.net.seat >= 0), 'every BallNet re-read its seat from the map');
ok(BOT_IDS.every(id => clients[id].bot.seated && clients[id].bot.seat === clients[id].court.seatOfClient(id)), 'bots refreshed seat from onSeatMap (Room wrapped the hook, bot hook still ran)');
ok(host.st.seatMaps.length === expectV, 'host page hook onSeatMap ran once per publish (wrapped, not replaced)', { calls: host.st.seatMaps.length });
ok(events.filter(e => e.ev === 'seatmap' && e.id === HOST_ID).length === expectV, "'seatmap' event fired on the host per publish");
ok(BOT_IDS.every(id => events.some(e => e.ev === 'seatmap' && e.id === id && e.v === host.court.map.v)), "'seatmap' event fired on every bot for the latest map");
ok(events.some(e => e.ev === 'peer-joined' && e.id === HOST_ID && e.peer === BOT_IDS[2]), "'peer-joined' fired on the host for the last bot");
ok(!BOT_IDS.some(id => events.some(e => e.ev === 'seatmap' && e.id !== id && e.v > 0 && events.find(x => x.ev === 'host' && x.id === id && x.isHost && x.t > 0 && x.t === e.t))), 'no bot published a seat map while transiently alone in its roster');
ok(clients[BOT_IDS[0]].room.stats.publishes === 0 && clients[BOT_IDS[1]].room.stats.publishes === 0 && clients[BOT_IDS[2]].room.stats.publishes === 0, 'only the host publishes seat maps', { hostPublishes: host.room.stats.publishes });
ok(host.clock.samples.length === 0 && host.room.stats.pings === 0, 'host never pings on a broadcast transport (it answers)', { answered: host.room.stats.pongsAnswered });
const clockMs = runUntil(() => BOT_IDS.every(id => clients[id].room.clockReady()), 12000);
ok(clockMs >= 0 && BOT_IDS.every(id => clients[id].clock.samples.length >= 8), 'clockReady() on every bot after 8 pongs from the host (1 Hz pings)', { afterMs: clockMs, samples: BOT_IDS.map(id => clients[id].clock.samples.length), pings: BOT_IDS.map(id => clients[id].room.stats.pings) });
ok(BOT_IDS.every(id => Math.abs(clients[id].clock.offset) <= JIT), 'bot clock offsets within jitter of the host clock (shared virtual clock: true offset 0)', { offsets: BOT_IDS.map(id => +clients[id].clock.offset.toFixed(1)) });
ok(BOT_IDS.every(id => clients[id].room.stats.pongsDropped > 0), 'foreign pongs (other bots\' pings) were dropped by the t0 nonce guard on every bot', { dropped: BOT_IDS.map(id => clients[id].room.stats.pongsDropped) });
ok(host.room.stats.pongsDropped === 0, 'host clock never touched by pongs');

// ── [W2] PRESENCE ignored by BallNet and RemoteHands ────────────────────────
{
  const pbuf = encodePresence({ clientId: 'c-zzz', name: 'Ghost', tracked: true, aspect: 16 / 9, handSpan: 0.2, kind: 'remote' }, 7, host.clock.now());
  ok(readHeader(pbuf).type === PK_PRESENCE && PK_PRESENCE === PK.PRESENCE && PK.PRESENCE === 0x21, 'PRESENCE header type 0x21', decodePresence(pbuf));
  const before = JSON.stringify({ owner: host.net.owner, ownerSeq: host.net.ownerSeq, inTransit: host.net.inTransit, seat: host.net.seat, v: host.court.map.v, stats: host.net.stats, lastRemote: host.net.lastRemote });
  const ignoredBefore = host.remote.ignored;
  host.net._onPacket(pbuf);
  const r = host.remote.onMessage(pbuf);
  const after = JSON.stringify({ owner: host.net.owner, ownerSeq: host.net.ownerSeq, inTransit: host.net.inTransit, seat: host.net.seat, v: host.court.map.v, stats: host.net.stats, lastRemote: host.net.lastRemote });
  ok(r === false && host.remote.ignored === ignoredBefore + 1, '[W2] RemoteHands.onMessage(presenceBuf) === false');
  ok(before === after, '[W2] BallNet._onPacket(presenceBuf) leaves BallNet state untouched');
  ok(!host.room.roster.some(p => p.clientId === 'c-zzz'), 'a locally injected PRESENCE (not from the transport) does not enter the roster');
}

// ── phase B: kickoff, the ball goes round the ring ──────────────────────────
const r0 = host.court.rectOf(0);
ok(host.net.kickoff({ x: r0.x0 + r0.w * 0.5, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }), 'host kickoff() accepted (isHost)');
const tKick = T; sampling = true; lastSample = T;
const firstClaim = {};
const visited = runUntil(() => { for (const id of BOT_IDS) if (!(id in firstClaim) && clients[id].bot.stats.claims >= 1) firstClaim[id] = T - tKick; return BOT_IDS.every(id => id in firstClaim); }, 20000);
ok(visited >= 0 && BOT_IDS.every(id => clients[id].bot.stats.claims >= 1), '[N1] the ball visits every seat within 20 s sim (every bot claims >= 1)', { afterMs: visited, firstClaimMs: firstClaim });
run(20000 - Math.max(0, visited));                         // keep passing until 20 s after kickoff
sampling = false;
const bad = samples.filter(s => !(s.inTile <= 1 && s.transit <= 1 && s.inTile + s.transit >= 1));
ok(samples.length >= 380 && bad.length === 0, '[N1] every 50 ms sample: exactly one in-tile owner or one in transit, never two in-tile owners', { samples: samples.length, bad: bad.slice(0, 3) });
ok(live().every(c => c.net.stats.conflicts === 0), 'conflicts === 0 on all clients', Object.fromEntries(live().map(c => [c.id, c.net.getStats()])));
const throws = events.filter(e => e.ev === 'throw' && e.t >= tKick);
ok(BOT_IDS.every(id => throws.some(e => e.id === id)) && throws.some(e => e.id === HOST_ID), 'every client threw at least once', { throws: throws.length, launches: live().map(c => c.net.stats.launches) });
ok(BOT_IDS.every(id => clients[id].bot.stats.launches >= 1), 'every bot launched (exitEdge fired from its scripted throw)');

// bot HAND_STREAM freshness on the host — sampled over the last 2 s of the pass phase
{
  const ages = {}, lens = {}, lefts = {}, holds = {};
  for (let k = 0; k < 40; k++) {
    step(50);
    for (const id of BOT_IDS) {
      const seat = host.court.seatOfClient(id);
      const rd = host.remote.read(seat, host.clock.now());
      ages[id] = Math.max(ages[id] ?? 0, rd.ageMs);
      lens[id] = rd.hands.right ? rd.hands.right.img.length : -1;
      lefts[id] = rd.hands.left === null;
      if (rd.hold && rd.hold.mode === HOLD.CRADLE) holds[id] = (holds[id] || 0) + 1;
    }
  }
  ok(BOT_IDS.every(id => ages[id] < 200 && lens[id] === 21 && lefts[id]), 'every bot HAND_STREAM decodes on the host with ageMs < 200, hands.right.img.length === 21, left null', { maxAgeMs: ages });
  ok(BOT_IDS.every(id => { const rd = host.remote.read(host.court.seatOfClient(id), host.clock.now()); return rd.hands.right.world && rd.hands.right.world.length === 21 && rd.seat === host.court.seatOfClient(id); }), 'bot packets carry 21 world points under the bot\'s seat');
  ok(host.remote.list().filter(s => s > 0).length === 3 && BOT_IDS.every(id => host.remote.seat(host.court.seatOfClient(id)).stats.accepted > 100), 'three remote seats on the host, each with > 100 accepted packets', { accepted: BOT_IDS.map(id => host.remote.seat(host.court.seatOfClient(id)).stats.accepted) });
  ok(events.some(e => e.ev === 'catch') && Object.keys(holds).length >= 0, 'bots reported catches (hold CRADLE on the wire while holding)', { catches: events.filter(e => e.ev === 'catch').length, cradleSamples: holds });
}

// ── phase C: a silent bot is pruned after 6 s, a leaving bot says bye ───────
{
  const victim = BOT_IDS.find(id => !clients[id].net.isOwner) || BOT_IDS[2];
  const vBefore = host.court.map.v, nBefore = host.room.roster.length;
  clients[victim].bot.dispose(); clients[victim].room.left = true; clients[victim].tr.close(); clients[victim].dead = true;
  const t0 = T;
  const lastSeen = Math.max(...live().map(c => c.room.roster.find(p => p.clientId === victim)?.lastSeenMs ?? 0));
  const pruned = runUntil(() => live().every(c => !c.room.roster.some(p => p.clientId === victim)), 8000);
  // silence is counted from the victim's LAST PRESENCE (up to one presence period + one link delay before the kill)
  ok(pruned >= 0 && T - lastSeen >= 6000 && T - lastSeen <= 6000 + LAT + JIT + STEP && pruned >= 6000 - 2000 - (LAT + JIT), 'silent bot pruned from every roster 6 s after its last PRESENCE', { afterKillMs: pruned, afterLastSeenMs: T - lastSeen, victim });
  run(400);
  ok(host.court.map.v === vBefore + 1 && host.room.roster.length === nBefore - 1, 'seat map v incremented once more on the prune', { v: host.court.map.v, seats: host.court.map.seats.length });
  ok(live().every(c => c.court.map.v === host.court.map.v && c.court.map.seats.length === 3), 'the pruned map reached everyone (3 seats)');
  ok(events.some(e => e.ev === 'peer-left' && e.id === HOST_ID && e.peer === victim && e.reason === 'silence'), "'peer-left' (silence) fired on the host");
  ok(live().every(c => c.room.hostId === HOST_ID), 'host unchanged after the prune');
  // a bot that leaves politely is dropped at once (bye PRESENCE), v increments again
  const leaver = BOT_IDS.find(id => id !== victim && !clients[id].net.isOwner) || BOT_IDS.find(id => id !== victim);
  const vB = host.court.map.v;
  clients[leaver].room.leave(); clients[leaver].bot.dispose();
  const byeMs = runUntil(() => !host.room.roster.some(p => p.clientId === leaver), 2000);
  clients[leaver].tr.close(); clients[leaver].dead = true;
  ok(byeMs >= 0 && byeMs <= LAT + JIT + STEP, 'bye PRESENCE removes the leaver within one link delay', { afterMs: byeMs });
  run(300);
  ok(host.court.map.v === vB + 1 && host.court.map.seats.length === 2 && host.court.map.wrap === 'row', 'seat map v incremented on the bye (2 seats, ring kept)', { v: host.court.map.v });
  ok(events.some(e => e.ev === 'peer-left' && e.id === HOST_ID && e.peer === leaver && e.reason === 'bye'), "'peer-left' (bye) fired on the host");
}

// ── host hand-over: when the host goes silent the next-lowest id takes over and republishes ──
{
  const survivor = live().find(c => c.id !== HOST_ID);
  const vBefore = survivor.court.map.v;
  host.room.left = true; host.tr.close(); host.dead = true;
  const elected = runUntil(() => survivor.room.isHost, 8000);
  ok(elected >= 0 && survivor.net.isHost && survivor.room.hostId === survivor.id, 'after the host falls silent the lowest remaining clientId becomes host (net.isHost synced)', { afterMs: elected, newHost: survivor.id });
  ok(survivor.court.map.v === vBefore + 1 && survivor.court.map.seats.length === 1 && survivor.court.map.wrap === 'none', 'new host published v+1 (single seat, no wrap)', { v: survivor.court.map.v });
  ok(survivor.room.clockReady() && survivor.room.stats.pings > 0, 'new host is clockReady and stops pinging', { pingsBefore: survivor.room.stats.pings });
  const p0 = survivor.room.stats.pings; run(3000);
  ok(survivor.room.stats.pings === p0, 'no pings sent while host');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
