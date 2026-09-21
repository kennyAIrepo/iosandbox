/**
 * smoke-test.mjs — headless verification of the ball protocol (Node 18+, no npm deps).
 *   node smoke-test.mjs
 * Runs: codec round-trips, SharedClock median offset, CourtMap adjacency + ring wrap + predictExit,
 * ThrowDetector classification, and a VIRTUAL-TIME simulation of three BallNets over MemHub
 * (120 ± 30 ms one-way, 5 % loss on the unreliable bus, seeded RNG): scheduled handoff A→B→C→A (ring),
 * host proxy ownership for an untracked goal seat + GOAL, thrower timeout + host recovery for a dead
 * receiver, rest → respawn, and a 60-throw fuzz asserting the ownership invariants.
 */
import assert from 'node:assert/strict';
import { CourtMap, buildSeatMap, EDGE, SEAT_NONE, integrateCourt, DEFAULT_BALL_RADIUS_M, UNIT_M } from '../sdk/game/court-map.js';
import {
  BallNet, SharedClock, TUNING, HOLD, REASON, CLAIM_REASON,
  encodeBallState, decodeBallState, encodeLaunch, decodeLaunch, encodeClaim, decodeClaim, encodeGoal, decodeGoal,
  encodeSeatMap, decodeSeatMap, encodeClockPong, decodeClockPong, readHeader, seqNewer16, seqNewer8, dt32,
} from '../sdk/game/ball-net.js';
import { MemHub } from '../sdk/net/transports.js';
import { ThrowDetector, THROW } from '../sdk/game/throw-detect.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
let failures = 0;
function section(name, fn) {
  try { const info = fn(); console.log('ok   ', name, info ? JSON.stringify(info) : ''); }
  catch (e) { failures++; console.log('FAIL ', name, '\n      ', e.stack || e.message); }
}

// ── 1. codecs ────────────────────────────────────────────────────────────────
section('codec: BALL_STATE + HOLD_OFFSET trailer, LAUNCH 42B, CLAIM 30B, GOAL 16B, SEAT_MAP, CLOCK_PONG', () => {
  const qw = Math.sqrt(1 - (0.1 ** 2 + 0.2 ** 2 + 0.3 ** 2));
  const s = { t: 4000000000, owner: 1, ownerSeq: 7, seat: 1, hold: { mode: HOLD.WRAP, slot: 1, ox: 0.12, oy: -0.05, oz: 0.3, qx: 0.1, qy: 0.2, qz: 0.3, qw },
    atRest: false, inTransit: false, onFloor: true, x: 1.234, y: 0.567, d: -0.25, vx: 2.5, vy: -1.25, vd: 0.1, wx: 1, wy: -2, wz: 3.5, radius: 0.072, launchSeq: 3 };
  const b = encodeBallState(s, 65535);
  assert.equal(b.byteLength, 48);
  const d = decodeBallState(b);
  assert.equal(d.seq, 65535); assert.equal(d.t, 4000000000); assert.equal(d.owner, 1); assert.equal(d.ownerSeq, 7); assert.equal(d.seat, 1);
  assert.equal(d.hold.mode, HOLD.WRAP); assert.equal(d.hold.slot, 1); assert.equal(d.onFloor, true); assert.equal(d.inTransit, false);
  near(d.x, 1.234, 1e-3); near(d.y, 0.567, 1e-3); near(d.d, -0.25, 1e-4); near(d.vx, 2.5, 1e-3); near(d.vy, -1.25, 1e-3); near(d.wz, 3.5, 1e-2); near(d.radius, 0.072, 1e-4);
  near(d.hold.ox, 0.12, 1e-4); near(d.hold.oz, 0.3, 1e-4);
  for (const k of ['qx', 'qy', 'qz', 'qw']) near(d.hold[k], s.hold[k], 3e-4, k);
  const free = decodeBallState(encodeBallState({ ...s, hold: { mode: HOLD.FREE }, atRest: true }, 1));
  assert.equal(free.hold.mode, HOLD.FREE); assert.equal(free.vx, 0);                        // at-rest → velocities zeroed
  const l = { t: 1000, from: 0, to: 1, ownerSeq: 3, launchSeq: 9, reason: REASON.THROW, edge: EDGE.R, ownerSeat: 0, x: 1.9, y: 0.6, d: 0, vx: 2.1, vy: 0.9, vd: 0, wx: 0, wy: 0, wz: 12.5, tEdge: 1040, cEdge: 0.61, radius: 0.072 };
  const lb = encodeLaunch(l, 5); assert.equal(lb.byteLength, 42);
  const ld = decodeLaunch(lb); assert.equal(ld.to, 1); assert.equal(ld.tEdge, 1040); near(ld.cEdge, 0.61, 1e-3); assert.equal(ld.ownerSeat, 0); near(ld.wz, 12.5, 1e-2);
  const cb = encodeClaim({ t: 1050, seat: 1, ownerSeq: 4, reason: CLAIM_REASON.BOUNDARY, launchSeq: 9, x: 2.0, y: 0.55, d: 0, vx: 2, vy: 0.5, vd: 0, tState: 1040, simSeat: 1 }, 6, 0);
  assert.equal(cb.byteLength, 30); const cd = decodeClaim(cb); assert.equal(cd.simSeat, 1); assert.equal(cd.tState, 1040); assert.equal(cd.reason, CLAIM_REASON.BOUNDARY);
  const gb = encodeGoal({ t: 1, goalSeat: 2, scorerSeat: 0, ownerSeq: 4, goalNo: 1, tGoal: 2 }, 7, 3); assert.equal(gb.byteLength, 16);
  const gd = decodeGoal(gb); assert.equal(gd.goalSeat, 2); assert.equal(gd.flags, 3);
  const map = buildSeatMap([{ clientId: 'a', name: 'A', tracked: true }], { v: 3 });
  assert.deepEqual(decodeSeatMap(encodeSeatMap(map, 1, 0)), map); assert.equal(readHeader(encodeSeatMap(map, 1, 0)).flags & 1, 1);
  const p = decodeClockPong(encodeClockPong(10, 20, 21, 2)); assert.deepEqual(p, { t0: 10, t1: 20, t2: 21 });
  assert.ok(seqNewer16(1, 65535) && !seqNewer16(65535, 1) && seqNewer8(0, 255) && !seqNewer8(255, 0));
  assert.equal(dt32(5, 4294967295), 6);
  return { ballStateBytes: 34, holdTrailerBytes: 14, launchBytes: 42, claimBytes: 30, goalBytes: 16 };
});

// ── 2. shared clock ──────────────────────────────────────────────────────────
section('clock: median of 8 NTP-style samples lands within 10 ms under ±40 ms asymmetric jitter', () => {
  const rng = mulberry32(7);
  const trueOffset = 123456.7;                  // server = local + offset
  let local = 1000;
  const c = new SharedClock({ samples: 8, localNow: () => local });
  for (let i = 0; i < 8; i++) {
    const up = 60 + rng() * 40, down = 60 + rng() * 40;   // asymmetric one-way delays
    const t0 = local, t1 = t0 + trueOffset + up, t2 = t1 + 1, t3 = t0 + up + 1 + down;
    local = t3; c.sample(t0, t1, t2, t3); local += 500;
  }
  near(c.offset, trueOffset, 10, 'offset');
  return { offsetErrMs: +(c.offset - trueOffset).toFixed(1), meanRttMs: +c.rtt.toFixed(1) };
});

// ── 3. court ─────────────────────────────────────────────────────────────────
section('court: 3-in-a-row rects, ring wrap, floor-not-exit, predictExit reproducible', () => {
  const map = buildSeatMap([0, 1, 2].map(i => ({ clientId: 'c-' + i, name: 'P' + i, tracked: true, handSpan: 0.16 })), { cols: 3, wrap: 'row' });
  const cm = new CourtMap(map);
  near(cm.R, DEFAULT_BALL_RADIUS_M / UNIT_M, 1e-9);        // B1: R is DERIVED from the world radius (the 0.45 x hand-span rule is gone)
  near(cm.rects[1].x0, 16 / 9 + 0.08, 1e-9); near(cm.rects[2].x0, 2 * (16 / 9 + 0.08), 1e-9);
  assert.equal(cm.neighbourAt(0, EDGE.R, 0.5).seat, 1);
  assert.equal(cm.neighbourAt(1, EDGE.L, 0.5).seat, 0);
  const wrap = cm.neighbourAt(2, EDGE.R, 0.5); assert.equal(wrap.seat, 0); near(wrap.wrapDx, -3 * (16 / 9 + 0.08), 1e-9);
  assert.equal(cm.neighbourAt(0, EDGE.L, 0.5).seat, 2);
  assert.equal(cm.neighbourAt(0, EDGE.T, 0.5).seat, -1);           // no row above → wall
  assert.equal(cm.exitEdge(0, 0.5, -0.5), EDGE.NONE);              // bottom is a floor, never an exit
  assert.equal(cm.exitEdge(0, 16 / 9 + 0.073, 0.5), EDGE.R);
  const t = cm.tileToCourt(1, 0.25, 0.5, true); near(t.x, cm.rects[1].x0 + 0.75 * 16 / 9, 1e-9); near(t.y, 0.5, 1e-9);   // mirrored u → 1-u
  const px = cm.courtToViewerPx(cm.rects[0].x0 + 16 / 9 + 0.04, 0.5, [{ left: 0, top: 0, width: 320, height: 180 }, { left: 330, top: 0, width: 320, height: 180 }, { left: 660, top: 0, width: 320, height: 180 }]);
  assert.ok(px.px > 320 && px.px < 330, 'gutter point lands between the tiles in px');
  const e1 = cm.predictExit(0, 0.9, 0.5, 2.0, 0.8, 1000), e2 = cm.predictExit(0, 0.9, 0.5, 2.0, 0.8, 1000);
  assert.deepEqual(e1, e2); assert.equal(e1.edge, EDGE.R); assert.equal(e1.to, 1);
  assert.equal(cm.predictExit(0, 0.9, 0.2, 0.05, 0, 0), null);       // dribble: rests inside
  return { R: cm.R, exitExample: e1 };
});

// ── 4. throw detector ────────────────────────────────────────────────────────
section('throw-detect: coherent → throw, jitter → drop, fast → clamped, lob rule', () => {
  const toCourt = v => ({ x: v.x / 0.5, y: v.y / 0.5 });          // tile height = 0.5 m at the hand plane
  const hand = { present: true, vel: Array.from({ length: 21 }, () => ({ x: 1, y: 0.3, z: 0 })), angVel: { x: 0, y: 0, z: 2 } };
  let td = new ThrowDetector({ worldVelToCourt: toCourt });
  for (let i = 0; i < 6; i++) td.push({ x: 0.9 + 0.02 * i, y: 0.3, z: 0 }, i * 16);
  let r = td.release(hand, 'wrap'); assert.equal(r.kind, 'throw'); assert.ok(r.coherent); near(r.vx, 1.95, 0.05); near(r.wz, 1.7, 1e-9);
  td = new ThrowDetector({ worldVelToCourt: toCourt });
  [[0.5, 0, 0], [-0.4, 0.3, 0], [0.1, -0.5, 0]].forEach(([x, y, z], i) => td.push({ x, y, z }, i * 16));
  r = td.release(hand, 'wrap'); assert.equal(r.kind, 'drop'); assert.ok(!r.coherent); assert.ok(Math.hypot(r.vx, r.vy) <= 0.3 + 1e-9);
  td = new ThrowDetector({ worldVelToCourt: toCourt });
  for (let i = 0; i < 6; i++) td.push({ x: 2.5, y: 0.2, z: 0 }, i * 16);
  r = td.release(hand, 'clip'); assert.ok(r.clamped); near(Math.hypot(r.vx, r.vy), THROW.V_MAX_OUT, 1e-9); assert.ok(r.wz > 1.7);
  td = new ThrowDetector({ worldVelToCourt: toCourt });
  for (let i = 0; i < 6; i++) td.push({ x: 0.2, y: 0.1, z: -2.0 }, i * 16);
  r = td.release(hand, 'cradle'); assert.equal(r.vd, 0); assert.ok(r.vy > 1.0, 'lob converted vd into vy');
  assert.equal(td.release(null, 'lost').kind, 'drop');
  near(ThrowDetector.catchWindowMs(2.0), 75, 1e-9);
  return { catchWindowAt2ups: 75 };
});

// ── 5–8. virtual-time simulation over MemHub ─────────────────────────────────
function makeWorld({ seed = 1, latencyMs = 120, jitterMs = 30, lossPct = 5, tracked = [true, true, true], goal = 2 } = {}) {
  let T = 0; const now = () => T; const rng = mulberry32(seed);
  const hub = new MemHub({ now, rng });
  const roster = [0, 1, 2].map(i => ({ clientId: 'c-' + i, name: 'P' + i, tracked: tracked[i], role: tracked[i] ? 'player' : 'goal', aspect: 16 / 9, handSpan: 0.16 }));
  const map = buildSeatMap(roster, { cols: 3, wrap: 'row', outer: 'wall', goal, kickoff: 0, v: 1 });
  const nets = [null, null, null], balls = [null, null, null], log = [], alive = [true, true, true];
  for (let i = 0; i < 3; i++) {
    if (!tracked[i]) { alive[i] = false; continue; }
    const tr = hub.join('c-' + i);
    for (let j = 0; j < i; j++) if (tracked[j]) hub.link('c-' + i, 'c-' + j, { latencyMs, jitterMs, lossPct });
    const court = new CourtMap(map), clock = new SharedClock({ localNow: now });
    nets[i] = new BallNet({ transport: tr, clock, court, seat: i, clientId: 'c-' + i, isHost: i === 0, rateHz: 20, hooks: {
      onBecameOwner: c => { balls[i] = { x: c.x, y: c.y, d: c.d, vx: c.vx, vy: c.vy, vd: c.vd, wx: 0, wy: 0, wz: 0, radius: court.R, atRest: false }; log.push({ t: T, ev: 'own', seat: i, reason: c.reason, ownerSeq: c.ownerSeq, simSeat: c.simSeat, tState: c.tState }); },
      onLostOwner: () => { balls[i] = null; log.push({ t: T, ev: 'lost', seat: i }); },
      onLaunchSeen: (l, mine) => log.push({ t: T, ev: 'launch', seat: i, mine, from: l.from, to: l.to, tEdge: l.tEdge, tEdgeEff: l.tEdgeEff, launchSeq: l.launchSeq }),
      onWall: (edge, b) => { if (edge === EDGE.T) b.vy = -Math.abs(b.vy) * 0.5; else b.vx = -b.vx * 0.5; },
      onGoal: g => log.push({ t: T, ev: 'goal', seat: i, scorer: g.scorerSeat, goalNo: g.goalNo }),
      onRespawnLocal: () => log.push({ t: T, ev: 'respawnLocal', seat: i }),
    } });
  }
  let overlapSince = -1, maxOverlapMs = 0, maxInTileOwners = 0;
  function step(ms = 4) {
    T += ms; const dt = ms / 1000;
    for (let i = 0; i < 3; i++) {
      const n = nets[i]; if (!n || !alive[i]) continue;
      if (n.isOwner && balls[i]) {
        const b = balls[i], fy = n.court.floorY(n.simSeat);
        integrateCourt(b, dt, fy, b.radius);
        if (b.y > fy + 1.6) b.vy = -Math.abs(b.vy) * 0.5;            // crude ceiling so a wild throw cannot fly away
        b.atRest = b.y <= fy + b.radius + 1e-3 && Math.hypot(b.vx, b.vy) < 0.1;   // the stack's _resting rule: lengthSq < 0.01
        n.tickOwner(b);
      }
      n.tick();
    }
    hub.flush();
    const owners = nets.filter((n, i) => n && alive[i] && n.isOwner);
    maxInTileOwners = Math.max(maxInTileOwners, owners.filter(n => !n.inTransit).length);
    if (owners.length >= 2) { if (overlapSince < 0) overlapSince = T; maxOverlapMs = Math.max(maxOverlapMs, T - overlapSince); } else overlapSince = -1;
  }
  const run = (ms, s = 4) => { for (let t = 0; t < ms; t += s) step(s); };
  const runUntil = (pred, maxMs, s = 4) => { const t0 = T; while (T - t0 < maxMs) { step(s); if (pred()) return T - t0; } return -1; };
  const kill = i => { alive[i] = false; nets[i].tr.close(); };
  const inTileOwner = () => nets.findIndex((n, i) => n && alive[i] && n.isOwner && !n.inTransit);
  return { nets, balls, hub, step, run, runUntil, log, now, map, kill, inTileOwner, inv: () => ({ maxOverlapMs, maxInTileOwners }), rng };
}
const LAT = 120, JIT = 30;

section('sim: scheduled handoff A→B→C→A (ring wrap), spectators agree, thrower never corrected', () => {
  const w = makeWorld({ seed: 11, latencyMs: LAT, jitterMs: JIT, lossPct: 5 });
  const r0 = w.nets[0].court.rectOf(0);
  assert.ok(w.nets[0].kickoff({ x: r0.x0 + 0.9, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }));
  w.run(400);
  assert.equal(w.nets[1].owner, 0); assert.equal(w.nets[2].owner, 0); assert.equal(w.nets[1].ownerSeq, w.nets[0].ownerSeq);
  const hops = [[0, 1, +1], [1, 2, +1], [2, 0, +1]], out = [];
  for (const [from, to, dir] of hops) {
    const b = w.balls[from]; b.y = w.nets[from].court.floorY(from) + 0.5; b.vx = 2.0 * dir; b.vy = 0.8; b.atRest = false;   // thrown from hand height, not from the floor (floor friction would stop a floor roll short of the far edge)
    const t0 = w.now();
    const dtOwn = w.runUntil(() => w.nets[to].isOwner, 4000); assert.ok(dtOwn > 0, `seat ${to} claimed`);
    const launch = [...w.log].reverse().find(e => e.ev === 'launch' && e.mine && e.seat === from);
    const recv = [...w.log].reverse().find(e => e.ev === 'launch' && !e.mine && e.seat === to);
    const own = [...w.log].reverse().find(e => e.ev === 'own' && e.seat === to);
    assert.equal(launch.to, to); assert.equal(own.reason, CLAIM_REASON.BOUNDARY);
    assert.ok(own.t >= recv.tEdgeEff - 4, 'claimed no earlier than the stretched tEdge');
    assert.ok(recv.tEdgeEff - recv.t >= TUNING.MIN_LEAD_MS - 1, 'ball never appears sooner than MIN_LEAD after the LAUNCH arrived');
    const rTo = w.nets[to].court.rectOf(to);
    assert.ok(own.simSeat === to && w.balls[to].x >= rTo.x0 - w.balls[to].radius && w.balls[to].x <= rTo.x0 + rTo.w + w.balls[to].radius, 'claim state lies at the receiver\'s edge (wrap shift applied)');
    w.run(LAT + JIT + TUNING.HANDOFF_TIMEOUT_MS + 100);
    assert.ok(!w.nets[from].isOwner, 'thrower released ownership');
    for (let i = 0; i < 3; i++) { assert.equal(w.nets[i].owner, to); assert.equal(w.nets[i].ownerSeq, w.nets[to].ownerSeq); }
    out.push({ from, to, launchToClaimMs: own.t - launch.t, gutterMs: launch.tEdge - launch.t, stretchMs: recv.tEdgeEff - recv.tEdge, thrownAt: t0 });
    w.run(200);
  }
  assert.equal(w.nets[0].stats.conflicts + w.nets[1].stats.conflicts + w.nets[2].stats.conflicts, 0);
  const inv = w.inv(); assert.ok(inv.maxInTileOwners <= 1); assert.ok(inv.maxOverlapMs <= LAT + JIT + TUNING.HANDOFF_TIMEOUT_MS + 8);
  return { hops: out, ...inv, hub: w.hub.stats };
});

section('sim: untracked goal seat — host proxies the ball, declares GOAL, everyone accepts it', () => {
  const w = makeWorld({ seed: 5, tracked: [true, true, false], goal: 2 });
  const r0 = w.nets[0].court.rectOf(0), r2 = w.nets[0].court.rectOf(2);
  w.nets[0].kickoff({ x: r0.x0 + 0.9, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }); w.run(400);
  w.balls[0].y = r0.y0 + 0.5; w.balls[0].vx = 2.2; w.balls[0].vy = 0.9; w.balls[0].atRest = false;
  assert.ok(w.runUntil(() => w.nets[1].isOwner && !w.nets[1].inTransit, 4000) > 0); w.run(500);
  w.balls[1].y = w.nets[1].court.floorY(1) + 0.5; w.balls[1].vx = 2.4; w.balls[1].vy = 1.0; w.balls[1].atRest = false;                   // toward the untracked goal seat
  assert.ok(w.runUntil(() => w.nets[0].isOwner && w.nets[0].proxyFor === 2, 4000) > 0, 'host claimed as proxy for seat 2');
  const own = [...w.log].reverse().find(e => e.ev === 'own' && e.seat === 0); assert.equal(own.reason, CLAIM_REASON.PROXY); assert.equal(own.simSeat, 2);
  // game rule: the ball is free inside the goal tile beyond its last third → goal for the last thrower
  let declared = false;
  const dtGoal = w.runUntil(() => { const b = w.balls[0]; if (!declared && b && w.nets[0].proxyFor === 2 && b.x > r2.x0 + r2.w * 0.66) declared = w.nets[0].declareGoal(1, 1); return declared && w.log.some(e => e.ev === 'goal' && e.seat === 1); }, 3000);
  assert.ok(dtGoal > 0, 'seat 1 accepted the proxy GOAL');
  assert.ok(w.log.filter(e => e.ev === 'goal').length >= 2);
  // the ball then rests on the goal floor and respawns to the kick-off seat (host = seat 0: local respawn + CLAIM)
  const dtRespawn = w.runUntil(() => w.log.some(e => e.ev === 'respawnLocal'), TUNING.REST_TO_GUTTER_MS + 4000);
  assert.ok(dtRespawn > 0, 'respawned'); w.run(400);
  assert.equal(w.nets[0].proxyFor, -1); assert.equal(w.nets[1].owner, 0); assert.equal(w.nets[1].ownerSimSeat, 0);
  return { goalAfterMs: dtGoal, respawnAfterMs: dtRespawn, hostStats: w.nets[0].getStats() };
});

section('sim: receiver dead — thrower times out, host recovers after the silence window', () => {
  const w = makeWorld({ seed: 3 });
  const r0 = w.nets[0].court.rectOf(0);
  w.nets[0].kickoff({ x: r0.x0 + 0.9, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }); w.run(400);
  w.kill(1);
  w.balls[0].vx = 2.0; w.balls[0].vy = 0.8; w.balls[0].atRest = false;
  const tLaunch = w.runUntil(() => w.log.some(e => e.ev === 'launch' && e.mine), 3000); assert.ok(tLaunch > 0);
  const dtLost = w.runUntil(() => !w.nets[0].isOwner, 3000); assert.ok(dtLost > 0, 'thrower timed out');
  assert.equal(w.nets[0].owner, 1, 'assumes the receiver has it');
  const dtRec = w.runUntil(() => w.nets[0].isOwner, 3000); assert.ok(dtRec > 0, 'host recovered');
  const own = [...w.log].reverse().find(e => e.ev === 'own' && e.seat === 0); assert.equal(own.reason, CLAIM_REASON.RECOVERY);
  near(dtRec, TUNING.OWNER_SILENCE_MS, 12, 'recovery after OWNER_SILENCE_MS');
  w.run(400); assert.equal(w.nets[2].owner, 0);
  return { timeoutAfterMs: dtLost, recoveryAfterMs: dtRec, stats: w.nets[0].getStats() };
});

section('fuzz: 60 random throws at 120±30 ms / 5 % loss — one in-tile owner at all times, every handoff completes', () => {
  const w = makeWorld({ seed: 42 });
  const r0 = w.nets[0].court.rectOf(0);
  w.nets[0].kickoff({ x: r0.x0 + 0.9, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }); w.run(400);
  const handoffMs = [], stretchMs = []; let completed = 0, rested = 0;
  for (let n = 0; n < 60; n++) {
    const from = w.inTileOwner(); assert.ok(from >= 0, 'exactly one in-tile owner before each throw');
    const b = w.balls[from]; const dir = w.rng() < 0.5 ? -1 : 1;
    b.x = w.nets[from].court.rectOf(from).x0 + 0.9; b.y = w.nets[from].court.floorY(from) + 0.5;
    b.vx = dir * (1.5 + w.rng() * 1.5); b.vy = 0.2 + w.rng() * 1.0; b.atRest = false;
    const launched = w.runUntil(() => [...w.log].reverse().find(e => e.ev === 'launch' && e.mine && e.seat === from && e.t > w.now() - 8) != null, 2500);
    if (launched < 0) { rested++; continue; }
    const launch = [...w.log].reverse().find(e => e.ev === 'launch' && e.mine && e.seat === from);
    const to = launch.to;
    const dt = w.runUntil(() => w.nets[to].isOwner && !w.nets[to].inTransit, 4000);
    assert.ok(dt > 0, `handoff ${from}→${to} completed`);
    const own = [...w.log].reverse().find(e => e.ev === 'own' && e.seat === to);
    const recv = [...w.log].reverse().find(e => e.ev === 'launch' && !e.mine && e.seat === to && e.launchSeq === launch.launchSeq);
    handoffMs.push(own.t - launch.t); stretchMs.push(recv.tEdgeEff - recv.tEdge); completed++;
    w.run(LAT + JIT + TUNING.HANDOFF_TIMEOUT_MS + 60);
    for (let i = 0; i < 3; i++) assert.equal(w.nets[i].owner, to, 'all clients agree on the owner');
  }
  const inv = w.inv();
  assert.ok(inv.maxInTileOwners <= 1, 'never two in-tile owners');
  assert.ok(inv.maxOverlapMs <= LAT + JIT + TUNING.HANDOFF_TIMEOUT_MS + 8, 'transit overlap bounded by L + timeout');
  const conflicts = w.nets.reduce((s, n) => s + n.stats.conflicts, 0);
  assert.equal(conflicts, 0);
  return { completed, rested, conflicts, handoffMs: { p50: pct(handoffMs, 0.5), p95: pct(handoffMs, 0.95), max: Math.max(...handoffMs) },
    stretchMs: { p50: pct(stretchMs, 0.5), p95: pct(stretchMs, 0.95) }, ...inv, hub: w.hub.stats, timeouts: w.nets.map(n => n.stats.timeouts) };
});

console.log(failures ? `\n${failures} section(s) FAILED` : '\nall sections passed');
process.exit(failures ? 1 : 0);
