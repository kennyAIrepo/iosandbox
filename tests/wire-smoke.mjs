/**
 * wire-smoke.mjs — headless verification of the hopeOS wire (hopeos-wire.md). Node ≥ 18, no browser, no network.
 *   node research/gaps/wire-protocol/wire-smoke.mjs        (from the scratchpad root, or from anywhere — paths are module-relative)
 *
 *   (i)   HAND_STREAM codec: 2-hand round trip, quantisation bounds, byte sizes ≤ 600, header via ball-net.readHeader, wrap, clamps
 *   (ii)  one MemHub, one transport per peer, BallNet + RemoteHands demuxed by readHeader(buf).type; the HOLD_OFFSET trailer of
 *         BALL_STATE is resolved onto the RECEIVED hand of the owner's seat through the real chain
 *         (RemoteHands.read → sdk/core/hand-views.js HandViews.resolve → prop-ball.js palmPose), and the receiver's measured
 *         chirality equals the sender's — no label crosses the wire
 *   (iii) 3 senders at 30 Hz through MemHub with 5 % loss and ±40 ms jitter (reordering): latest-wins, monotone seq per seat,
 *         seq wrap at 0xffff, decoded hand equals the sent hand within the quantisation bound
 *   (iv)  static greps over hand-stream.mjs / remote-consumer.mjs with comments stripped: no handedness, no categoryName,
 *         no `1 - x` flips, no hard-coded z sign, no mirror/flip/swap identifiers
 *   (v)   BroadcastChannel('hopeos-room') envelope: presence messages ignored, wire messages delivered with the ArrayBuffer intact
 *   (vi)  handAgeAlpha copy == latency-cues.mjs:127; patched stage.html parses (node --check) and no longer sends the JSON packet
 *   (vii) court-bridge.mjs: PropBall world exit → CourtMap (mirrored=true) → BallNet LAUNCH; hold ↔ HOLD_OFFSET round trip
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = (...p) => path.join(here, '..', ...p);
// research copies (stage.html prototype, plan section 6) are NOT in the repo; (vi) checks them only when reachable
const RESEARCH = process.env.HOPEOS_RESEARCH || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/research';
const R = (...p) => path.join(RESEARCH, 'gaps', 'wire-protocol', ...p);

import {
  encodeHandStream, decodeHandStream, handStreamBytes, selfCheck, HS, HS_MAX_BYTES, HS_BUDGET_BYTES, HS_IMG_ERR, HS_WORLD_ERR,
  wrapRoom, unwrapRoom, ROOM_CHANNEL, bytesToB64, b64ToBytes,
} from '../sdk/net/hand-stream.js';
import { RemoteHands, RemoteSeat, REMOTE, handAgeAlpha } from '../sdk/net/remote-consumer.js';
import { BallNet, SharedClock, HOLD, PK, readHeader, seqNewer16, dt32, FLAG, encodeBallState, decodeBallState } from '../sdk/game/ball-net.js';
import { MemHub, LoopbackTransport } from '../sdk/net/transports.js';
import { CourtMap, buildSeatMap } from '../sdk/game/court-map.js';

const THREE = await import('three');
const { palmPose } = await import('../sdk/game/prop-ball.js');
// sdk/interaction/colliders.js:21 warns (async, console.warn) that its https: BVH import cannot load in Node — expected, harmless
const warn = console.warn; console.warn = (...a) => { if (!String(a[0]).includes('BVH not available')) warn(...a); };
const { HandViews } = await import('../sdk/core/hand-views.js');

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b} (±${eps})`);
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let failures = 0;
async function section(name, fn) {
  try { const info = await fn(); console.log('ok   ', name, info ? JSON.stringify(info) : ''); }
  catch (e) { failures++; console.log('FAIL ', name, '\n      ', e.stack || e.message); }
}

// ── synthetic hands: a plausible 21-point hand (metric, hand-centred) + its mirrored image projection ─────────
// Not anatomically exact; what matters is a NON-degenerate palm block (wrist 0, index MCP 5, pinky MCP 17, thumb base 1/2)
// so hand-views.js chirVol has a sign, and fingers that are not coplanar with the palm.
function worldHand(t, side = 1, cx = 0, cy = 0, cz = 0) {
  const P = new Array(21);
  const v = (x, y, z) => ({ x: cx + x * side, y: cy + y, z: cz + z });
  P[0] = v(0, -0.04, 0);                                   // wrist
  P[1] = v(0.02, -0.03, 0.012); P[2] = v(0.045, -0.015, 0.02); P[3] = v(0.065, 0.005, 0.024); P[4] = v(0.08, 0.02, 0.026);   // thumb
  const mcp = [[0.03, 0.03], [0.01, 0.035], [-0.01, 0.033], [-0.03, 0.028]];
  for (let f = 0; f < 4; f++) {
    const [mx, my] = mcp[f], base = 5 + f * 4, curl = 0.25 + 0.2 * Math.sin(t * 1.7 + f);
    P[base] = v(mx, my, 0);
    P[base + 1] = v(mx, my + 0.035, -0.01 * curl);
    P[base + 2] = v(mx, my + 0.06, -0.03 * curl);
    P[base + 3] = v(mx, my + 0.08, -0.05 * curl);
  }
  return P;
}
// player-pipeline.js:175 — img.x = 1 - raw, y raw, z = raw z × crop width (1): a pinhole-ish projection of the world hand
function imgFromWorld(W, u0, v0, k = 1.6) { return W.map(p => ({ x: 1 - (u0 + p.x * k), y: v0 + p.y * k, z: p.z * k })); }
function handsAt(t, { left = true, right = true } = {}) {
  const hands = { left: null, right: null };
  if (left) { const W = worldHand(t, -1); hands.left = { img: imgFromWorld(W, 0.72 + 0.04 * Math.sin(t), 0.55 + 0.03 * Math.cos(t * 0.8)), world: W }; }
  if (right) { const W = worldHand(t, 1); hands.right = { img: imgFromWorld(W, 0.28 + 0.05 * Math.sin(t * 1.1), 0.5 + 0.04 * Math.cos(t)), world: W }; }
  return hands;
}
const maxErr = (a, b) => { let e = 0; for (let i = 0; i < 21; i++) for (const c of ['x', 'y', 'z']) e = Math.max(e, Math.abs(a[i][c] - b[i][c])); return e; };
function makeCamera() { const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100); c.position.set(0, 0, 0); c.updateMatrixWorld(true); return c; }

// ── (i) codec ────────────────────────────────────────────────────────────────
await section('(i) codec: 2-hand round trip within bounds, 516 B ≤ 600, one hand 138/264 B, heartbeat 12 B, header via ball-net.readHeader, wrap/clamp/POSE33', () => {
  const sc = selfCheck();
  const hands = handsAt(1.234);
  const buf = encodeHandStream(3, hands, 65535, 4294967295, { hold: { mode: HOLD.CRADLE, slot: 'left' }, flags: FLAG.FROM_HOST });
  assert.equal(buf.byteLength, 516); assert.equal(HS_MAX_BYTES, 516); assert.ok(HS_MAX_BYTES <= HS_BUDGET_BYTES);
  assert.equal(handStreamBytes(hands), 516);
  const hd = readHeader(buf);                                                        // the SAME reader BallNet demuxes with
  assert.deepEqual(hd, { type: PK.HAND_STREAM, flags: FLAG.FROM_HOST, ver: 1, seq: 65535, t: 4294967295 });
  const d = decodeHandStream(buf);
  assert.equal(d.seat, 3); assert.equal(d.hflags, HS.PRESENT_L | HS.PRESENT_R | HS.WORLD_L | HS.WORLD_R);
  assert.deepEqual(d.hold, { mode: HOLD.CRADLE, slot: 0 });
  const eImg = Math.max(maxErr(d.hands.left.img, hands.left.img), maxErr(d.hands.right.img, hands.right.img));
  const eWorld = Math.max(maxErr(d.hands.left.world, hands.left.world), maxErr(d.hands.right.world, hands.right.world));
  assert.ok(eImg <= HS_IMG_ERR + 1e-12, 'img error ' + eImg); assert.ok(eWorld <= HS_WORLD_ERR + 1e-12, 'world error ' + eWorld);
  // one hand, no world / heartbeat
  const one = encodeHandStream(0, { left: null, right: { img: hands.right.img, world: null } }, 1, 10);
  assert.equal(one.byteLength, 138); const d1 = decodeHandStream(one);
  assert.equal(encodeHandStream(0, { left: null, right: hands.right }, 1, 10).byteLength, 264); assert.equal(d1.hands.left, null); assert.equal(d1.hands.right.world, null);
  const hb = encodeHandStream(254, { left: null, right: null }, 2, 11); assert.equal(hb.byteLength, 12);
  assert.deepEqual(decodeHandStream(hb).hands, { left: null, right: null });
  // wrap-safe seq, clamps, reserved bits
  assert.ok(seqNewer16(0, 65535) && !seqNewer16(65535, 0) && seqNewer16(1, 65535));
  const wild = { left: { img: hands.left.img.map(p => ({ x: 1.5, y: -2, z: p.z })), world: hands.left.world.map(p => ({ x: 40, y: p.y, z: NaN })) }, right: null };
  const dw = decodeHandStream(encodeHandStream(1, wild, 0, 0));
  near(dw.hands.left.img[0].x, 1, 1e-9, 'clamp +'); near(dw.hands.left.img[0].y, -1.00003, 1e-4, 'clamp -'); near(dw.hands.left.world[0].x, 32.767, 1e-9, 'world clamp'); assert.equal(dw.hands.left.world[0].z, 0);
  const bad = new Uint8Array(buf.slice(0)); bad[9] |= HS.POSE33; assert.throws(() => decodeHandStream(bad.buffer), /POSE33/);
  assert.throws(() => encodeHandStream(255, hands, 0, 0), RangeError);
  assert.throws(() => decodeHandStream(encodeBallState({ t: 0, owner: 0, ownerSeq: 0, seat: 0, x: 0, y: 0, vx: 0, vy: 0, radius: 0.07, launchSeq: 0 }, 0)), /not a HAND_STREAM/);
  // base64 path (Live Share) is lossless
  assert.deepEqual(new Uint8Array(b64ToBytes(bytesToB64(buf))), new Uint8Array(buf));
  return { twoHandsBytes: buf.byteLength, oneHandNoWorldBytes: 138, oneHandBytes: 264, heartbeatBytes: 12, imgErr: +eImg.toExponential(2), worldErr: eWorld, selfCheck: sc };
});

// ── (ii) demux + HOLD_OFFSET on the received hand ─────────────────────────────
await section('(ii) BallNet + RemoteHands on one MemHub transport; HOLD_OFFSET resolved onto the RECEIVED hand via HandViews.resolve + palmPose; measured chirality agrees', () => {
  let T = 0; const now = () => T; const rng = mulberry32(3);
  const hub = new MemHub({ now, rng });
  const roster = [0, 1].map(i => ({ clientId: 'c-' + i, name: 'P' + i, tracked: true, aspect: 16 / 9, handSpan: 0.16 }));
  const map = buildSeatMap(roster, { cols: 2, wrap: 'row', kickoff: 0 });
  const peers = [0, 1].map(i => {
    const tr = hub.join('c-' + i);
    const clock = new SharedClock({ localNow: now });
    const net = new BallNet({ transport: tr, clock, court: new CourtMap(map), seat: i, clientId: 'c-' + i, isHost: i === 0, rateHz: 20, hooks: {} });
    const remote = new RemoteHands({ localNow: now });
    tr.onMessage(buf => remote.onMessage(buf));                                          // second listener on the SAME transport = the demux
    return { tr, clock, net, remote, views: new HandViews(), camera: makeCamera(), hseq: 0 };
  });
  hub.link('c-0', 'c-1', { latencyMs: 90, jitterMs: 20, lossPct: 5 });
  const A = peers[0], B = peers[1];
  const r0 = A.net.court.rectOf(0);
  assert.ok(A.net.kickoff({ x: r0.x0 + 0.9, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }));
  // the owner holds the ball in the pocket of its RIGHT screen slot: palm-local offset, palm-relative rotation
  const offLocal = new THREE.Vector3(0.05, 0.35, 0.55);                                 // hand-span units (sync-protocol.md §6)
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), tmp = new THREE.Vector3();
  let senderBall = null, senderMesh = null, senderSpan = 0, sends = 0;
  const step = (ms) => {
    T += ms;
    // A: local frame → HAND_STREAM + ball state with the hold trailer (what a TilePipeline + PropBall host page does per frame)
    if (T % 33 === 0) {
      const hands = handsAt(T / 1000);
      const packs = A.views.resolve([hands.left, hands.right], A.camera);
      const h = packs.hands.find(x => x.slot === 'right');
      assert.ok(palmPose(h.points, P, Q)); senderSpan = tmp.copy(h.points[9]).sub(h.points[0]).length(); senderMesh = h.mesh;
      senderBall = tmp.copy(offLocal).multiplyScalar(senderSpan).applyQuaternion(Q).add(P).clone();
      const rel = Q.clone().invert();                                                     // ball orientation (identity) relative to the palm
      const hold = { mode: HOLD.WRAP, slot: 1, ox: offLocal.x, oy: offLocal.y, oz: offLocal.z, qx: rel.x, qy: rel.y, qz: rel.z, qw: rel.w };
      A.tr.send(encodeHandStream(0, hands, A.hseq++, A.clock.now(), { hold: { mode: HOLD.WRAP, slot: 'right' } }), { reliable: false }); sends++;
      A.net.tickOwner({ x: r0.x0 + 0.9, y: r0.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0, wx: 0, wy: 0, wz: 0, radius: A.net.court.R, hold, atRest: false, onFloor: false });
    }
    for (const p of peers) p.net.tick();
    hub.flush();
  };
  for (let i = 0; i < 1500; i++) step(1);
  // B: BallNet saw the ball state with the trailer; RemoteHands saw the hand stream; neither consumed the other's packets
  assert.equal(B.net.owner, 0); assert.ok(B.net.lastRemote && B.net.lastRemote.hold.mode === HOLD.WRAP && B.net.lastRemote.hold.slot === 1);
  const hold = B.net.lastRemote.hold; assert.ok(typeof hold.ox === 'number' && typeof hold.qw === 'number', 'HOLD_OFFSET trailer decoded');
  assert.ok(B.remote.ignored > 0, 'RemoteHands ignored BALL_STATE/CLAIM/ACK packets: ' + B.remote.ignored);
  const seatA = B.remote.seat(0); assert.ok(seatA.stats.accepted > 20, 'hand packets accepted: ' + seatA.stats.accepted);
  assert.ok(A.remote.list().length === 0, 'A received no hand stream (B sent none) — its RemoteHands has no seats');
  // resolve the hold on the RECEIVED hand with the receiver's OWN HandViews (measured chirality, its own latches)
  const rd = B.remote.read(0, B.clock.now());
  assert.ok(rd.hands.right && rd.hands.left && rd.hold.mode === HOLD.WRAP && rd.hold.slot === 1);
  assert.ok(rd.ageMs >= 70 && rd.ageMs <= 200, 'age on the shared clock ≈ one-way latency: ' + rd.ageMs);
  const packsB = B.views.resolve([rd.hands.left, rd.hands.right], B.camera);
  const hB = packsB.hands.find(x => x.slot === 'right');
  assert.ok(palmPose(hB.points, P, Q)); const spanB = tmp.copy(hB.points[9]).sub(hB.points[0]).length();
  const off = new THREE.Vector3(hold.ox, hold.oy, hold.oz).multiplyScalar(spanB);
  const ballB = off.applyQuaternion(Q).add(P);
  const relB = new THREE.Quaternion(hold.qx, hold.qy, hold.qz, hold.qw), ballQ = Q.clone().multiply(relB);
  // the sender's ball of the SAME packet seq: replay the sender-side computation at that packet's capture time
  const tCap = rd.t; const handsS = handsAt(tCap / 1000);
  const viewsS = new HandViews(); const packsS = viewsS.resolve([handsS.left, handsS.right], A.camera); const hS = packsS.hands.find(x => x.slot === 'right');
  palmPose(hS.points, P, Q); const spanS = tmp.copy(hS.points[9]).sub(hS.points[0]).length();
  const ballS = tmp.copy(offLocal).multiplyScalar(spanS).applyQuaternion(Q).add(P).clone();
  const posErr = ballB.distanceTo(ballS);
  assert.ok(posErr < 0.002, 'ball reconstructed on the received hand within 2 mm: ' + posErr);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(ballQ.w)));                              // ballQ should be ≈ identity
  assert.ok(ang < 0.01, 'ball orientation within 0.01 rad: ' + ang);
  assert.equal(hB.mesh, hS.mesh, 'receiver measured the same mesh chirality from the packet as the sender (no label on the wire)');
  return { handPacketsSent: sends, accepted: seatA.stats.accepted, stale: seatA.stats.stale, lost: seatA.stats.gaps, ignoredByRemoteHands: B.remote.ignored,
    ageMs: rd.ageMs, alpha: rd.alpha, ballPosErrMm: +(posErr * 1000).toFixed(3), ballAngErr: +ang.toFixed(5), mesh: hB.mesh, hub: hub.stats };
});

// ── (iii) 3 senders at 30 Hz with loss + reordering ───────────────────────────
await section('(iii) 3 senders @ 30 Hz over MemHub (60±40 ms, 5 % loss): latest-wins, monotone seq per seat, wrap at 0xffff, decoded == sent within bounds', () => {
  let T = 0; const now = () => T; const rng = mulberry32(21);
  const hub = new MemHub({ now, rng });
  const N = 3, peers = [];
  for (let i = 0; i < N; i++) {
    const tr = hub.join('c-' + i); for (let j = 0; j < i; j++) hub.link('c-' + i, 'c-' + j, { latencyMs: 60, jitterMs: 40, lossPct: 5 });
    const remote = new RemoteHands({ localNow: now, predMs: 0 });
    const maxSeen = new Map(), chain = new Map(), sent = new Map();
    tr.onMessage(buf => {
      const hd = readHeader(buf); if (hd.type !== PK.HAND_STREAM) return;
      const seat = new DataView(buf).getUint8(8);
      if (!maxSeen.has(seat) || seqNewer16(hd.seq, maxSeen.get(seat))) maxSeen.set(seat, hd.seq);
      const before = remote.seat(seat).stats.lastSeq;
      if (remote.onMessage(buf)) { const c = chain.get(seat) || []; if (c.length) assert.ok(seqNewer16(hd.seq, before), 'accepted seq is newer than the previous accepted'); c.push(hd.seq); chain.set(seat, c); }
    });
    peers.push({ tr, remote, maxSeen, chain, sent, seq: 65400, next: i * 7 });   // seq starts near the wrap; senders are phase-shifted
  }
  const last = new Map();                                                                 // seat → { seq, hands } of the newest packet SENT
  for (T = 0; T < 12000; T++) {
    for (let i = 0; i < N; i++) {
      const p = peers[i];
      if (T >= p.next) {
        p.next += 1000 / 30;
        const hands = handsAt(T / 1000 + i, { left: (T >> 10) % 3 !== i, right: true });   // a slot goes absent now and then
        const seqNow = p.seq & 0xffff; p.seq++;
        p.tr.send(encodeHandStream(i, hands, seqNow, T), { reliable: false });
        last.set(i, { seq: seqNow, hands: JSON.parse(JSON.stringify(hands)) });
      }
    }
    hub.flush();
  }
  for (let k = 0; k < 400; k++) { T++; hub.flush(); }                                      // drain
  const out = { pairs: 0, stale: 0, lost: 0, accepted: 0, wrapped: false };
  for (let r = 0; r < N; r++) for (let s = 0; s < N; s++) {
    if (r === s) continue; out.pairs++;
    const rs = peers[r].remote.seat(s), chain = peers[r].chain.get(s);
    assert.ok(chain && chain.length > 250, `receiver ${r} accepted from ${s}: ${chain && chain.length}`);
    for (let i = 1; i < chain.length; i++) assert.ok(seqNewer16(chain[i], chain[i - 1]), 'monotone (wrap-safe) accepted seq chain');
    if (chain.some((x, i) => i > 0 && x < chain[i - 1])) out.wrapped = true;              // numeric drop = the u16 wrap happened
    assert.equal(rs.cur.seq, peers[r].maxSeen.get(s), 'latest-wins: current packet is the newest ever delivered');
    out.stale += rs.stats.stale; out.lost += rs.stats.gaps; out.accepted += rs.stats.accepted;
    const rd = rs.read(T);
    const L = last.get(s); assert.equal(rd.seq, L.seq, 'after the drain the newest SENT packet is the one held');
    for (const slot of ['left', 'right']) {
      if (!L.hands[slot]) { assert.equal(rd.hands[slot], null); continue; }
      assert.ok(maxErr(rd.hands[slot].img, L.hands[slot].img) <= HS_IMG_ERR + 1e-12); assert.ok(maxErr(rd.hands[slot].world, L.hands[slot].world) <= HS_WORLD_ERR + 1e-12);
    }
    assert.ok(rd.sinceArrivalMs <= 400 + 200, 'sinceArrival counts local time since the last accepted packet');
  }
  assert.ok(out.wrapped, 'seq wrapped through 0xffff during the run');
  assert.ok(out.stale > 0, 'reordering happened and stale packets were rejected');
  const lossShare = hub.stats.dropped / hub.stats.sent;                                   // exact: the hub's own drop count
  assert.ok(lossShare > 0.03 && lossShare < 0.07, 'hub loss ≈ 5 %: ' + lossShare.toFixed(3));
  assert.ok(out.lost >= out.stale, 'gaps count losses AND reorderings (a reordered packet is a gap first, then stale)');
  // extrapolation: predMs lead moves the point along the last two packets' velocity, capped, and holds when stale
  const rs = peers[1].remote.seat(0);
  const a = JSON.parse(JSON.stringify(rs.read(T).hands.right.img[8]));
  const b = rs.read(T, { predMs: 50 }).hands.right.img[8];
  const c = rs.read(T, { predMs: 500 }).hands.right.img[8];                                // capped at 100 ms
  const dtPk = dt32(rs.cur.t, rs.prev.t); const vx = (rs.cur.hands.right.img[8].x - rs.prev.hands.right.img[8].x) / dtPk;
  const ageNow = rs.read(T).ageMs;
  if (ageNow <= REMOTE.HOLD_MS && dtPk > 0 && dtPk <= REMOTE.MAX_STEP_MS) {
    near(b.x - a.x, vx * 50, 1e-9, 'linear extrapolation by predMs'); near(c.x - a.x, vx * REMOTE.MAX_PRED_MS, 1e-9, 'cap');
  }
  const heldOld = rs.read(T + 5000, { predMs: 50 }).hands.right.img[8];
  near(heldOld.x, a.x, 1e-12, 'stale (> HOLD_MS): hold, no extrapolation');
  assert.equal(rs.read(T + 5000).alpha, 0.5, 'alpha floor 0.5 when very stale'); assert.equal(rs.read(rs.cur.t + 100).alpha, 1);
  return { ...out, lossShare: +lossShare.toFixed(3), hub: hub.stats };
});

// ── (iv) static doctrine greps ───────────────────────────────────────────────
await section('(iv) static: sdk/net/hand-stream.js + remote-consumer.js (comments stripped) — no handedness / categoryName / `1 - x` / z-sign / mirror-flip-swap', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const forbidden = [
    [/handedness/i, 'handedness'], [/categoryName/, 'categoryName'],
    [/\b1(?:\.0+)?\s*-\s*[\w$.\[\]]*\b(?:x|u)\b/, '`1 - x` / `1 - u` flip'],
    [/\.z\s*\*=\s*-/, 'z *= -'], [/(?<![\w$.\]\)]\s*)-\s*[\w$.\[\]]+\.z\b/, 'unary-negated .z'], [/\bzs\s*=\s*-?1\b/, 'hard-coded zSign'], [/zSign/, 'zSign'],
    [/\b(mirror|flip|swap)\w*\s*[(=]/i, 'mirror/flip/swap function'],
  ];
  const report = {};
  for (const f of ['hand-stream.js', 'remote-consumer.js']) {
    const code = strip(fs.readFileSync(REPO('sdk', 'net', f), 'utf8'));
    for (const [re, label] of forbidden) { const m = code.match(re); assert.ok(!m, `${f}: forbidden ${label}: "${m && m[0]}"`); }
    report[f] = code.split('\n').length + ' code lines clean';
  }
  return report;
});

// ── (v) hopeos-room envelope over BroadcastChannel (Node has it) ─────────────
await section('(v) BroadcastChannel(hopeos-room): kind:presence ignored, kind:wire delivered with the ArrayBuffer intact, own echo dropped', async () => {
  const a = new LoopbackTransport({ id: 'tile-a' }), b = new LoopbackTransport({ id: 'tile-b' });
  const legacy = new BroadcastChannel(ROOM_CHANNEL);                                       // the frozen page's presence poster (mpbrowser.html:3266)
  const got = [];
  b.onMessage(bytes => got.push(bytes));
  a.onMessage(() => assert.fail('own echo delivered'));
  legacy.postMessage({ v: 1, kind: 'presence', t: 1, cut: false, cal: false, profile: 'general', players: [], balls: [] });
  const pkt = encodeHandStream(2, handsAt(0.5), 42, 1000);
  a.send(pkt, { reliable: false });
  a.send(encodeBallState({ t: 1, owner: 0, ownerSeq: 1, seat: 0, x: 1, y: 0.5, vx: 0, vy: 0, radius: 0.07, launchSeq: 0 }, 5), { reliable: true });
  await new Promise(res => setTimeout(res, 60));
  assert.equal(got.length, 2); assert.ok(got[0] instanceof ArrayBuffer); assert.equal(got[0].byteLength, 516);
  assert.equal(readHeader(got[0]).type, PK.HAND_STREAM); assert.equal(readHeader(got[1]).type, PK.BALL_STATE);
  assert.equal(decodeHandStream(got[0]).seat, 2);
  assert.equal(b.stats.ignored, 1, 'the presence message was ignored');
  assert.equal(unwrapRoom({ v: 1, kind: 'presence' }), null); assert.equal(unwrapRoom(wrapRoom('me', pkt), 'me'), null); assert.ok(unwrapRoom(wrapRoom('you', pkt), 'me') === pkt);
  a.close(); b.close(); legacy.close();
  return { delivered: got.length, ignoredPresence: b.stats.ignored, bytes: got.map(x => x.byteLength) };
});

// ── (vi) copies and patched files agree with their sources ───────────────────
await section('(vi) handAgeAlpha == sdk/game/latency-cues.js:127; (research copy, when present) patched stage.html module parses and no longer sends the JSON {seq,tile,hand} packet', () => {
  const src = fs.readFileSync(REPO('sdk', 'game', 'latency-cues.js'), 'utf8');
  const m = src.match(/export function handAgeAlpha\(ageMs\)\s*\{([^}]*)\}/); assert.ok(m, 'canonical handAgeAlpha found');
  const canonical = new Function('ageMs', m[1]);
  for (const age of [0, 100, 150, 151, 200, 275, 400, 401, 900, 5000]) assert.equal(handAgeAlpha(age), canonical(age), 'alpha at ' + age);
  if (!fs.existsSync(R('stage.html'))) return { alphaSamples: 10, stageModule: 'skipped (research copy not reachable; set HOPEOS_RESEARCH)' };
  const stage = fs.readFileSync(R('stage.html'), 'utf8');
  const mod = stage.match(/<script type="module">([\s\S]*?)<\/script>/); assert.ok(mod, 'stage.html has one module script');
  const tmp = path.join(os.tmpdir(), '_stage-module.check.mjs'); fs.writeFileSync(tmp, mod[1]);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' }); fs.unlinkSync(tmp);
  assert.equal(res.status, 0, 'node --check: ' + res.stderr);
  assert.ok(!/\{\s*seq:\s*\+\+seq,\s*tile:\s*myTile,\s*hand\s*\}/.test(stage), 'old JSON packet gone');
  assert.ok(/encodeHandStream\(/.test(stage) && /readHeader\(/.test(stage) && /BallNet\(/.test(stage), 'stage uses the codec, the header demux and BallNet');
  const sec6 = fs.readFileSync(R('ball-extraction-plan.section6.md'), 'utf8');
  const live = sec6.slice(sec6.indexOf('\n## 6.'));                                        // after the quoted "SUPERSEDED" block
  assert.ok(live.length > 500 && !/kind:\s*'ball'/.test(live) && /BallNet/.test(live), 'section 6 copy no longer specifies the kind:ball envelope');
  return { alphaSamples: 10, stageModuleLines: mod[1].split('\n').length };
});

// ── (vii) owner bridge: PropBall world → court → BallNet launch; hold ↔ HOLD_OFFSET round trip ─────────────
const bridgeCase = (mirroredInput) => async () => {
  const { toCourtBall, onPropExit, holdFromProp, ballFromHold, worldToCourt } = await import('../sdk/game/court-bridge.js');
  const { EDGE } = await import('../sdk/game/court-map.js');
  const opt = { mirroredInput }, expEdge = mirroredInput ? EDGE.L : EDGE.R, expTo = mirroredInput ? 0 : 2, edgeName = mirroredInput ? 'L' : 'R';
  let T = 0; const now = () => T; const hub = new MemHub({ now, rng: mulberry32(9) });
  const roster = [0, 1, 2].map(i => ({ clientId: 'c-' + i, name: 'P' + i, tracked: true, aspect: 16 / 9, handSpan: 0.16 }));
  const map = buildSeatMap(roster, { cols: 3, wrap: 'row', kickoff: 1 });
  const court = new CourtMap(map), camera = makeCamera();
  const net = new BallNet({ transport: hub.join('c-1'), clock: new SharedClock({ localNow: now }), court, seat: 1, clientId: 'c-1', isHost: true, rateHz: 30, hooks: {} });
  const r1 = court.rectOf(1);
  net.kickoff({ x: r1.x0 + 0.9, y: r1.y0 + 0.5, d: 0, vx: 0, vy: 0, vd: 0 }); assert.ok(net.isOwner);
  // a ball at the hand plane (mirrorDist 2), moving toward world +x = the RIGHT of the mirrored display
  const cb = toCourtBall(court, 1, camera, { pos: { x: 0.3, y: 0.1, z: -2 }, vel: { x: 1.2, y: 0.4, z: 0 }, angVel: { x: 0, y: 0, z: 3 } }, null, {}, opt);
  const c0 = worldToCourt(court, 1, camera, { x: 0.3, y: 0.1, z: -2 }, {}, mirroredInput);
  if (mirroredInput) assert.ok(c0.x < r1.x0 + r1.w / 2, 'world +x lands in the LEFT half of the un-mirrored court tile');
  else assert.ok(c0.x > r1.x0 + r1.w / 2, 'world +x lands in the RIGHT half of the (display-space) court tile');
  if (mirroredInput) assert.ok(cb.vx < 0 && cb.vy > 0, 'court velocity: x sign flipped by the position conversion, y up: ' + JSON.stringify([cb.vx, cb.vy]));
  else assert.ok(cb.vx > 0 && cb.vy > 0, 'court velocity: x sign kept (no flip), y up: ' + JSON.stringify([cb.vx, cb.vy]));
  near(Math.abs(cb.vx), 1.2 / (2 * 0.9326) * (1 / 1) , 0.05, '|vx| ≈ m/s over the tile height at that depth');   // tile height at depth 2 = 2·tan(25°)·2 = 1.865 m
  assert.equal(cb.radius, court.R); assert.equal(cb.d, 0); assert.equal(cb.wz, 3);
  // the safety-net exit: PropBall.onExit fires beyond boundsR at world x = +1.9 (past the frustum edge) → court EDGE.L → LAUNCH to seat 0
  const ex = onPropExit(net, court, camera, { pos: { x: 1.9, y: 0.0, z: -2 }, vel: { x: 1.5, y: 0.2, z: 0 }, angVel: { x: 0, y: 0, z: 0 } }, null, opt);
  assert.equal(ex.edge, expEdge); assert.equal(ex.neighbour, expTo);
  assert.equal(net.stats.launches, 1); assert.equal(net.lastLaunch.to, expTo); assert.equal(net.lastLaunch.edge, expEdge); assert.ok(net.inTransit);
  // a non-court exit (straight toward the camera) is EDGE.NONE: recentre locally, ownership unchanged
  const ex2 = onPropExit(net, court, camera, { pos: { x: 0.1, y: 0.05, z: -0.3 }, vel: { x: 0, y: 0, z: 2 }, angVel: { x: 0, y: 0, z: 0 } }, null, opt);
  assert.equal(ex2.edge, EDGE.NONE); assert.equal(net.stats.launches, 1);
  // hold trailer: PropBall hold + holder's palm frame → offset/quat → back onto the (same) hand
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.7)), P = new THREE.Vector3(0.1, -0.2, -1.9), span = 0.09;
  const ballPos = new THREE.Vector3(0.14, -0.15, -1.86), ballQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(1, 0.2, -0.3));
  const h = holdFromProp({ type: 'wrap', slot: 'right' }, ballPos, ballQ, P, q, span);
  assert.equal(h.mode, HOLD.WRAP); assert.equal(h.slot, 1);
  const back = ballFromHold(h, P, q, span);
  near(back.pos.x, ballPos.x, 1e-9); near(back.pos.y, ballPos.y, 1e-9); near(back.pos.z, ballPos.z, 1e-9);
  const qb = new THREE.Quaternion(back.quat.x, back.quat.y, back.quat.z, back.quat.w); near(Math.abs(qb.dot(ballQ)), 1, 1e-9, 'orientation');
  const viaThree = new THREE.Vector3(h.ox, h.oy, h.oz).multiplyScalar(span).applyQuaternion(q).add(P);   // plain qApply == THREE.applyQuaternion
  near(viaThree.distanceTo(new THREE.Vector3(back.pos.x, back.pos.y, back.pos.z)), 0, 1e-9);
  const enc = decodeBallState(encodeBallState({ t: 1, owner: 1, ownerSeq: 1, seat: 1, hold: h, x: 1, y: 0.5, vx: 0, vy: 0, radius: court.R, launchSeq: 0 }, 1));
  assert.equal(enc.byteLength ?? 48, 48); for (const k of ['ox', 'oy', 'oz']) near(enc.hold[k], h[k], 1e-4, k); for (const k of ['qx', 'qy', 'qz', 'qw']) near(enc.hold[k], h[k], 3e-4, k);
  return { mirroredInput, courtVel: [+cb.vx.toFixed(3), +cb.vy.toFixed(3)], exitEdge: edgeName, launchedTo: net.lastLaunch.to, hold: { ox: +h.ox.toFixed(3), oy: +h.oy.toFixed(3), oz: +h.oz.toFixed(3) } };
};
await section('(vii) court-bridge mirroredInput:true (research): world +x exit in the mirror scene → court EDGE.L (flip only via tileToCourt), velocity sign inherited, BallNet launches; hold trailer round trip', bridgeCase(true));
await section('(vii) court-bridge mirroredInput:false (twin, court-space.MIRRORED_INPUT): world +x exit → court EDGE.R (no flip), velocity sign kept, BallNet launches; hold trailer round trip', bridgeCase(false));

console.log(failures ? `\n${failures} section(s) FAILED` : '\nall sections passed');
process.exit(failures ? 1 : 0);
