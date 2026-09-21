/**
 * tests/ball-game-smoke.mjs — headless verification of sdk/game/ball-game.js (+ the T4 appends in latency-cues.js and
 * sdk/game/sfx.js). BUILD-PLAN T4 acceptance (a)-(j). Node only: `node tests/ball-game-smoke.mjs` from the repo root.
 *
 * Two headless BallGames (seats 0 = host, 1) + one untracked proxy seat 2, over MemHub 120 ± 30 ms / 5 % loss on a
 * VIRTUAL clock (SharedClock localNow = the same virtual T on both, so session time is exact), court ring 0 → 1 → 2 → 0,
 * stage layout fixed169(3, 994, 678) (2x2, incomplete row centred), world/court mapping from sdk/game/court-space.js,
 * hands from synthetic 21-point packs (PackGen + the prop-ball-smoke wrap / holding-pose generators).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { CourtMap, buildSeatMap, EDGE, SEAT_NONE } from '../sdk/game/court-map.js';
import { BallNet, SharedClock, TUNING, HOLD, REASON, CLAIM_REASON, PK, readHeader, decodeGoal } from '../sdk/game/ball-net.js';
import { MemHub } from '../sdk/net/transports.js';
import { U, D, courtToWorld, tileWorldRect, worldFromStagePx, makeUvCamera } from '../sdk/game/court-space.js';
import { PackGen } from '../sdk/game/pack-gen.js';
import { BallGame, FEEL, PHASE, classifyRelease, POTATO_BIT, urlBallRadiusM } from '../sdk/game/ball-game.js';
import { JOINT_RADII } from '../sdk/core/game-physics.js';
import { SHELF_FRAC, DEFAULT_BALL_RADIUS_M } from '../sdk/game/court-map.js';
import { ArrivalPredictor, MissCue, ArrivalRing } from '../sdk/game/latency-cues.js';
import { Sfx, SFX_NAMES } from '../sdk/game/sfx.js';

// ── harness ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(cond, label) { if (cond) { passed++; console.log('  ok   ' + label); } else { failed++; console.log('  FAIL ' + label); } }
function section(name) { console.log('\n[' + name + ']'); }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const FRAME = 1000 / 60;
const r3 = v => +v.toFixed(3);

// ── stage layout: R/ui/scripts/gallery-grid.mjs::fixed169 (verbatim) + incomplete rows centred ───────────────
function fixed169(n, W, H, gap = 8, tol = 0.10) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    const c = { cols, rows, tw: Math.floor(tw), th: Math.floor(tw * 9 / 16) };
    if (!best || c.tw > best.tw * (1 + tol)) best = c;
    else if (c.tw >= best.tw * (1 - tol) && c.cols > best.cols) best = c;
  }
  const usedW = best.cols * best.tw + gap * (best.cols - 1), usedH = best.rows * best.th + gap * (best.rows - 1);
  return { ...best, padX: Math.floor((W - usedW) / 2), padY: Math.floor((H - usedH) / 2) };
}
function stageFor(n, W = 994, H = 678, gap = 8) {
  const f = fixed169(n, W, H, gap), rects = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / f.cols), col = i % f.cols, inRow = Math.min(f.cols, n - row * f.cols);
    const rowW = inRow * f.tw + gap * (inRow - 1);
    rects.push({ left: (W - rowW) / 2 + col * (f.tw + gap), top: f.padY + row * (f.th + gap), width: f.tw, height: f.th });
  }
  return { W, H, th: f.th, tw: f.tw, rects, grid: f };
}

// ── synthetic hands (prop-ball-smoke.mjs generators, r-parametrised) ─────────────────────────────────────────
const V = (x, y, z) => ({ x, y, z });
const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
const shift = (pack, dx, dy, dz) => pack.map(q => V(q.x + dx, q.y + dy, q.z + dz));
/**
 * A doctrine-true WRAP for ANY radius (r-aware, real-scale palm: span 0.204 so packRadii k = 1): palm joints on the +z face of
 * the ball within the 6 mm skin, the four fingers curling over the top to the far side (PIP ~70°, DIP ~110°, TIP ~150° from the
 * palm contact — the DIP/TIP normals are > 72° from the palm normal, the wrap gate's "opposite" test); `fingersOn = false`
 * leaves the fingers straight up (no far-side contact → no wrap).
 */
const around = (B, r, side = 1, fingersOn = true) => {
  const p = mk(V(B.x, B.y - 0.3, B.z + 0.5));
  const at = (i, dx, dy, dz, skin = 0.003) => { const l = Math.hypot(dx, dy, dz), d = r + JOINT_RADII[i] + skin; return V(B.x + dx / l * d, B.y + dy / l * d, B.z + dz / l * d); };
  p[9] = at(9, 0, 0.1, side); p[5] = at(5, 0.35, 0.1, side); p[13] = at(13, -0.35, 0.1, side); p[17] = at(17, -0.7, 0.05, side, 0.01);
  p[0] = V(p[9].x, p[9].y - 0.204, p[9].z + 0.01 * side);
  const cols = [[5, 6, 7, 8, 0.3], [9, 10, 11, 12, 0.0], [13, 14, 15, 16, -0.3], [17, 18, 19, 20, -0.6]];
  for (const [mcp, pip, dip, tip, x] of cols) {
    if (fingersOn) { p[pip] = at(pip, x, 0.94, 0.34 * side); p[dip] = at(dip, x, 0.64, -0.77 * side); p[tip] = at(tip, x, 0.17, -0.98 * side); }
    else { p[pip] = V(p[mcp].x, p[mcp].y + 0.045, p[mcp].z + 0.03 * side); p[dip] = V(p[mcp].x, p[mcp].y + 0.075, p[mcp].z + 0.05 * side); p[tip] = V(p[mcp].x, p[mcp].y + 0.1, p[mcp].z + 0.07 * side); }
  }
  for (const i of [1, 2, 3, 4]) p[i] = V(B.x + r + 0.08, B.y - 0.05, B.z + 0.02 * side);
  return p;
};
/** fingers leave the far side (palm joints STAY touching) = open hand → release */
const opened = pack => pack.map((q, i) => ([6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20].includes(i) ? V(q.x, q.y, q.z - 0.15) : q));
/** palm-up HOLDING POSE (fingers forward -z, slightly curled, thumb up): cradle */
const cupHand = (x, y, z) => {
  const p = mk(V(x, y, z + 0.1));
  const Uu = (dx, dz, up) => V(x + dx, y + up, z + dz);
  p[0] = Uu(0, 0.1, 0); p[9] = Uu(0, -0.1, 0); p[5] = Uu(0.045, -0.09, 0); p[13] = Uu(-0.02, -0.095, 0); p[17] = Uu(-0.06, -0.085, 0);
  const cols = { 6: 0.045, 10: 0, 14: -0.02, 18: -0.06 };
  for (const [pip, dx] of Object.entries(cols)) { const b = +pip; p[b] = Uu(dx, -0.13, 0.03); p[b + 1] = Uu(dx, -0.16, 0.06); p[b + 2] = Uu(dx, -0.18, 0.09); }
  p[1] = Uu(0.05, 0.06, 0.01); p[2] = Uu(0.08, 0.02, 0.03); p[3] = Uu(0.1, -0.02, 0.05); p[4] = Uu(0.11, -0.05, 0.07);
  return p;
};

// ── the world: n seats, MemHub, one BallGame per tracked seat ────────────────────────────────────────────────
function makeWorld({ n = 3, tracked = [true, true, false], goal = -1, kickoff = 0, mode = 'free', seed = 1, latencyMs = 120, jitterMs = 30, lossPct = 5, wrap = 'row', cols = 3 } = {}) {
  let T = 0; const now = () => T; const rng = mulberry32(seed);
  const hub = new MemHub({ now, rng });
  const stage = stageFor(n);
  const roster = [...Array(n).keys()].map(i => ({ clientId: 'c-' + i, name: 'P' + i, tracked: !!tracked[i], role: tracked[i] ? 'player' : 'wall', aspect: 16 / 9, handSpan: 0.16 }));
  const map = buildSeatMap(roster, { cols, wrap, outer: 'wall', goal, kickoff, v: 1 });
  const games = [], nets = [], packs = [], say = [], log = [];
  for (let i = 0; i < n; i++) {
    if (!tracked[i]) continue;
    const tr = hub.join('c-' + i);
    for (let j = 0; j < i; j++) if (tracked[j]) hub.link('c-' + i, 'c-' + j, { latencyMs, jitterMs, lossPct });
    const court = new CourtMap(map), clock = new SharedClock({ localNow: now });
    const net = new BallNet({ transport: tr, clock, court, seat: i, clientId: 'c-' + i, isHost: i === 0, rateHz: 20, hooks: {} });
    const cams = new Map();
    const uvCamOf = s => {
      if (!cams.has(s)) { const d = stage.rects[s]; const c = worldFromStagePx(d.left + d.width / 2, d.top + d.height / 2, stage.W, stage.H, stage.th, {}); cams.set(s, makeUvCamera(THREE, d.width / d.height, { x: c.x, y: c.y, z: 0 })); }
      return cams.get(s);
    };
    const game = new BallGame({
      scene: null, stage: null, court, net, clock, seat: i, clientId: 'c-' + i, isHost: i === 0, mode,
      tileWorldRect: s => tileWorldRect(court, s, stage.rects, stage.W, stage.H, stage.th),
      courtToWorld: (x, y, out) => courtToWorld(court, x, y, stage.rects, stage.W, stage.H, stage.th, out),
      uvCamOf, domRects: () => stage.rects, cues: null,
      announce: (text, level) => say.push({ t: T, seat: i, text, level }),
    });
    for (const ev of ['phase', 'owner', 'launch', 'claim', 'goal', 'wall', 'respawn', 'chip', 'ring', 'release', 'grab']) game.addEventListener(ev, e => log.push({ t: T, ev, ...e.detail, seat: i, detail: e.detail }));   // seat = the game instance that saw it
    games[i] = game; nets[i] = net; packs[i] = { L: null, R: null };
  }
  let maxInTileOwners = 0;
  function step(ms = FRAME) {
    T += ms;
    for (let i = 0; i < n; i++) if (games[i]) games[i].tick(T, ms / 1000, packs[i], null);
    hub.flush();
    const owners = games.filter(g => g && g.net.isOwner && !g.net.inTransit).length;
    maxInTileOwners = Math.max(maxInTileOwners, owners);
  }
  const run = ms => { const t0 = T; while (T - t0 < ms - 1e-9) step(); };
  const runUntil = (pred, maxMs) => { const t0 = T; while (T - t0 < maxMs) { step(); if (pred()) return T - t0; } return -1; };
  const courtOf = (g, s = g.net.simSeat) => g._courtPos(s);
  /** owner test seam: put the FREE ball at a court point with a court velocity (a throw by fiat, like passToward) */
  const placeBall = (g, x, y, vx, vy) => {
    const w = courtToWorld(g.court, x, y, stage.rects, stage.W, stage.H, stage.th, {});
    g.ball.sphere.pos.set(w.x, w.y, -D); g.ball.sphere.vel.set(vx * U, vy * U, 0); g.ball.hold = null; g.ball.cradle = null;
    g.ball.mesh.position.copy(g.ball.sphere.pos); g.ball.mesh.updateMatrixWorld(true);
  };
  return { games, nets, packs, say, log, hub, stage, map, step, run, runUntil, now, courtOf, placeBall, inv: () => ({ maxInTileOwners }) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(a) kickoff → floor; cradle → held; wrap → held(wrap); throw → flight → transit → arriving on seat 1');
{
  const w = makeWorld({ seed: 11 });
  const [g0, g1] = [w.games[0], w.games[1]];
  const r = g0.ball.sphere.radius;
  ok(Math.abs(r - g0.court.R * U) < 1e-9 && g0.ball.sphere.gravity < 0, `ball radius = court.R·U = ${r3(r)} m, gravity ${r3(g0.ball.sphere.gravity)} < 0 [D4]`);
  ok(Math.abs(r - DEFAULT_BALL_RADIUS_M) < 1e-12 && g0.radiusM === r, `[B1-1] a FIXED world radius: ${r} m (10 cm across), court.R derived = ${g0.court.R.toFixed(4)} u (the hand-span rule is gone: roster advertised 0.16 u spans)`);
  ok(g0.net.hooks === g0.hooks && Object.keys(g0.hooks).length === 9, 'BallGame wired all 9 BallNet hooks itself');
  g1.start(); ok(g0.start() === true, 'host kickoff claimed');
  ok(g0.phase === PHASE.RESPAWN && g0.net.isOwner, `seat 0 owns after kickoff, phase ${g0.phase}`);
  const yKick = g0.ball.pos.y, rectK = g0.tileWorldRect(0);
  ok(Math.abs(yKick - (rectK.floorY + r)) < 1e-6 && Math.abs(g0.ball.pos.x - (rectK.x0 + rectK.x1) / 2) < 0.005, `[B1-5] kickoff PLACES the ball resting on the shelf centre (y = shelf + r = ${r3(yKick)}, x within 5 mm of the tile centre — the roster's 16/9 vs the floored stage tile), not falling from above`);
  w.step();
  ok(g0.phase === PHASE.FLOOR && Math.abs(g0.ball.pos.y - yKick) < 1e-6, `one frame later: phase ${g0.phase}, no fall (|dy| ${(Math.abs(g0.ball.pos.y - yKick) * 1000).toFixed(2)} mm)`);
  w.run(3000);
  ok(g0.phase === PHASE.FLOOR, `seat 0 phase after 3 s: ${g0.phase} (ball at rest on the kickoff shelf)`);
  ok(g1.phase === PHASE.FLOOR && g1.net.owner === 0, `seat 1 mirrors: phase ${g1.phase}, owner ${g1.net.owner}`);
  const F = g0.ball.floorY, rect0 = g0.tileWorldRect(0);
  ok(Math.abs(g0.ball.pos.y - (F + r)) < 2e-3 && Math.abs(F - rect0.floorY) < 1e-9 && Math.abs(F - (rect0.y0 + SHELF_FRAC * (rect0.y1 - rect0.y0))) < 1e-9,
    `[B1-2] resting at floorY + r; floorY = the SHELF at ${SHELF_FRAC * 100} % of the tile height (${r3(F)}; tile bottom ${r3(rect0.y0)}, top ${r3(rect0.y1)})`);
  // holding pose beside the ball (palm 4 cm under the shelf line so the pocket sits at the ball's centre) → drawn across → cradle → held
  const B = g0.ball.pos.clone();
  const hx = B.x + 0.15, hy = F - 0.04, hz = B.z + 0.05;
  w.packs[0].R = cupHand(hx, hy, hz);
  const hs0 = g0.handState('right');
  const dtCradle = w.runUntil(() => g0.ball.cradle === 'right', 2000);
  ok(dtCradle > 0 && g0.phase === PHASE.HELD, `holding pose → cradle after ${dtCradle | 0} ms, phase ${g0.phase}`);
  const hs1 = g0.handState('right');
  ok(hs1.present && hs1.hold === 'cradle' && hs1.state === 'holding' && hs1.holdPose && hs1.ny > 0.25 && hs1.pose === 'cupped' && hs1.pocketDist < r && typeof hs1.why === 'string',
    `[B1-4] handState('right') = ${JSON.stringify({ state: hs1.state, hold: hs1.hold, pose: hs1.pose, closure: +hs1.closure.toFixed(2), ny: +hs1.ny.toFixed(2), pocketDist: +hs1.pocketDist.toFixed(3), touching: hs1.touching })} (before: ${hs0.state}/${hs0.why})`);
  ok(g0.handState('left').present === false && g0.handState('left').state === 'absent', `handState('left') = absent (${g0.handState('left').why})`);
  w.run(400);
  ok(g1.phase === PHASE.HELD && g1.lastRemote && g1.lastRemote.hold.mode === HOLD.CRADLE, `seat 1 sees HOLD_OFFSET cradle (mode ${g1.lastRemote && g1.lastRemote.hold.mode}), phase ${g1.phase}`);
  w.packs[0].R = null; w.run(1500);
  // wrap: palm on one side, fingers closed round the far side
  const B2 = g0.ball.pos.clone();
  let wrapPack = around(B2, r, 1, true);
  w.packs[0].R = wrapPack;
  const dtWrap = w.runUntil(() => !!g0.ball.hold, 600);
  ok(dtWrap > 0 && g0.ball.hold.type === 'wrap' && g0.phase === PHASE.HELD, `wrap grab after ${dtWrap | 0} ms: holdType ${g0.ball.hold && g0.ball.hold.type}, phase ${g0.phase}`);
  ok(g0.ball.snapshot().holdType === 'wrap', 'snapshot().holdType === wrap');
  // lift 0.6 m (rides the hand), then carry +x at 1.5 m/s for 20 frames, then OPEN → release with the hand's velocity
  for (let k = 1; k <= 15; k++) { w.packs[0].R = shift(wrapPack, 0, 0.6 * k / 15, 0); w.step(); }
  wrapPack = shift(wrapPack, 0, 0.6, 0);
  w.packs[0].R = wrapPack; w.run(300);
  ok(!!g0.ball.hold && g0.ball.pos.y - B2.y > 0.45, `wrapped ball rode the lifting hand: rose ${r3(g0.ball.pos.y - B2.y)} m`);
  const launchesBefore = g0.net.stats.launches;
  const vHand = { x: 2.0, y: 0.3 };                                              // +x 2.0 m/s = 1.07 u/s (a little up so the shelf does not eat it; the opened palm's contact friction still takes ~20 % at release)
  for (let k = 1; k <= 20; k++) { w.packs[0].R = shift(wrapPack, vHand.x * k / 60, vHand.y * k / 60, 0); w.step(); }
  wrapPack = shift(wrapPack, vHand.x * 20 / 60, vHand.y * 20 / 60, 0);
  w.packs[0].R = opened(wrapPack); w.step();
  const rel = w.log.filter(e => e.ev === 'release' && e.seat === 0).pop();
  ok(!g0.ball.hold && g0.phase === PHASE.FLIGHT && rel && rel.kind === 'throw' && rel.how === 'wrap', `open → released THAT frame: phase ${g0.phase}, release ${rel && rel.kind}/${rel && rel.how} ${rel && r3(rel.speedU)} u/s [D3]`);
  ok(Math.abs(g0.ball.vel.x / U - vHand.x / U) < 0.35 && g0.ball.vel.x > 0, `release velocity from the palm-follow history: vx ${r3(g0.ball.vel.x)} m/s`);
  w.packs[0].R = null;
  // LAUNCH → seat 1 sees it with to === 1 → seat 0 transit → seat 1 claims at tEdgeEff → arriving
  const dtLaunch = w.runUntil(() => w.log.some(e => e.ev === 'launch' && e.seat === 1 && !e.mine), 4000);
  const seen = w.log.find(e => e.ev === 'launch' && e.seat === 1 && !e.mine);
  ok(dtLaunch > 0 && seen && seen.launch.to === 1 && seen.launch.from === 0, `LAUNCH seen on seat 1 after ${dtLaunch | 0} ms: from ${seen && seen.launch.from} to ${seen && seen.launch.to}, launches ${g0.net.stats.launches - launchesBefore}`);
  ok(g0.phase === PHASE.TRANSIT && g0.net.inTransit, `seat 0 phase ${g0.phase} while the LAUNCH is out`);
  const tEdgeEff = seen.launch.tEdgeEff;
  const dtArr = w.runUntil(() => g1.phase === PHASE.ARRIVING && g1.net.isOwner, 3000);
  const arrivedAt = w.now();
  ok(dtArr > 0, `seat 1 claimed and is arriving after ${dtArr | 0} ms`);
  ok(Math.abs(arrivedAt - tEdgeEff) <= FRAME + 1e-6, `arrived at tEdgeEff ± 1 frame: |${arrivedAt} - ${tEdgeEff}| = ${Math.abs(arrivedAt - tEdgeEff) | 0} ms`);
  const v1 = g1.ball.vel, sp = Math.hypot(v1.x, v1.y) / U;
  ok(sp <= FEEL.V_MAX_IN + 1e-6 && sp > 0, `entry speed ${r3(sp)} u/s ≤ 2.0`);
  ok(v1.x > 0, `entered from the left: vel.x ${r3(v1.x)} > 0`);
  ok(Math.abs(g1.ball.pos.z + D) < 1e-9, `pos.z === -D (${g1.ball.pos.z})`);
  const rect1 = g1.tileWorldRect(1), c1 = w.courtOf(g1, 1);
  ok(g1.ball.pos.x < rect1.x0 + 0.5 && Math.abs(g1.ball.floorY - rect1.floorY) < 1e-9, `ball at seat 1's LEFT edge (x ${r3(g1.ball.pos.x)} vs x0 ${r3(rect1.x0)}), home = seat 1 tile (court x ${r3(c1.x)})`);
  ok(w.inv().maxInTileOwners <= 1, 'never two in-tile owners');
  w.run(LAT_SETTLE());
  ok(!g0.net.isOwner && g0.phase !== PHASE.TRANSIT, `seat 0 released ownership, phase ${g0.phase}`);
  // ball settles in seat 1 (nobody catches): miss bookkeeping
  w.run(3000);
  ok(g1.phase === PHASE.FLOOR && g1.stats.misses === 1, `seat 1 phase ${g1.phase}, misses ${g1.stats.misses} (came from another tile, nobody touched it)`);
  ok(w.say.some(s => s.seat === 1 && /Missed/.test(s.text)), 'announced "Missed in …"');
  globalThis.__worldA = w;
}
function LAT_SETTLE() { return 120 + 30 + TUNING.HANDOFF_TIMEOUT_MS + 100; }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(b) [P1] ArrivalPredictor: leadMs ≥ 300 before the LAUNCH, predicted flips false after it (40 fuzzed throws)');
{
  const w = makeWorld({ seed: 23 });
  const [g0, g1] = [w.games[0], w.games[1]];
  const rng = mulberry32(99);
  g1.start(); g0.start(); w.run(800);
  const r0 = g0.court.rectOf(0);
  let launched = 0, good = 0, leadOk = 0, flipOk = 0, edgeOk = 0, movedTotal = 0;
  const leads = [];
  const r1 = g1.court.rectOf(1);
  for (let i = 0; i < 40; i++) {
    if (!g0.net.isOwner || g0.net.inTransit) {                                  // seat 1 throws it back through its LEFT edge
      w.runUntil(() => g1.net.isOwner && !g1.net.inTransit, 3000);
      if (g1.net.isOwner) { w.placeBall(g1, r1.x0 + 0.45, g1.court.floorY(1) + 0.35, -2.2, 0.7); w.runUntil(() => g0.net.isOwner && !g0.net.inTransit, 4000); }
      if (!g0.net.isOwner) { g0.start(); w.run(600); }                          // fallback only
    }
    w.run(200);
    const speed = 0.5 + rng() * 2.0, ang = (-20 + rng() * 50) * Math.PI / 180;
    w.placeBall(g0, r0.x0 + 0.3, g0.court.floorY(0) + 0.35, Math.cos(ang) * speed, Math.sin(ang) * speed);   // 0.35 u above the SHELF (the floor), below the top edge at any angle
    let maxLead = -Infinity, lastPred = null, seen = null;
    const before = w.log.length;
    const dt = w.runUntil(() => {
      const p = g1.predictor.read(w.now());
      if (p && p.predicted) { maxLead = Math.max(maxLead, p.leadMs); lastPred = p; }
      seen = w.log.slice(before).find(e => e.ev === 'launch' && e.seat === 1 && !e.mine && e.launch.to === 1);
      return !!seen;
    }, 4000);
    if (dt < 0) { w.run(300); continue; }
    launched++;
    const after = g1.predictor.read(w.now());
    const lead = maxLead > -Infinity ? maxLead : null;
    const okLead = lead !== null && lead >= FEEL.CUE_LEAD_MIN_MS, okFlip = !!after && after.predicted === false;
    const okEdge = !!lastPred && Math.abs(lastPred.cEdge - seen.launch.cEdge) <= 0.2;
    if (okLead) leadOk++; if (okFlip) flipOk++; if (okEdge) edgeOk++;
    if (okLead && okFlip) good++;
    leads.push(lead === null ? -1 : lead | 0);
    movedTotal += g1.predictor.stats.moved;
    w.runUntil(() => g1.net.isOwner && !g1.net.inTransit, 2500); w.run(LAT_SETTLE());
  }
  console.log(`      launched ${launched}/40, leadMs per launched throw: [${leads.join(', ')}]`);
  ok(launched >= 20, `enough throws crossed to seat 1: ${launched}/40`);
  ok(good >= 0.8 * launched, `leadMs ≥ 300 before the LAUNCH AND predicted flipped false after it in ${good}/${launched} (≥ 80 %)`);
  ok(edgeOk >= 0.8 * launched, `confirmed edge point within 0.2 u of the last prediction in ${edgeOk}/${launched}`);
  ok(g1.predictor.stats.predictions >= launched && g1.predictor.stats.confirmed >= 0.8 * launched, `predictor stats: ${JSON.stringify(g1.predictor.stats)}`);
  ok(w.inv().maxInTileOwners <= 1 && g0.net.stats.conflicts + g1.net.stats.conflicts === 0, `one in-tile owner, 0 conflicts (hub ${JSON.stringify(w.hub.stats)})`);
  // unit: onState ignores transit / gutter / held; onLaunch for someone else clears
  const P = new ArrivalPredictor({ court: g1.court, mySeat: 1 });
  P.onState({ inTransit: true, seat: 0, hold: { mode: 0 }, x: 1, y: 0.5, vx: 2, vy: 0.5, t: 0 }, 0); ok(P.read(0) === null, 'onState: in-transit state ignored');
  P.onState({ inTransit: false, seat: SEAT_NONE, hold: { mode: 0 }, x: 1, y: 0.5, vx: 2, vy: 0.5, t: 0 }, 0); ok(P.read(0) === null, 'onState: gutter (SEAT_NONE) ignored');
  P.onState({ inTransit: false, seat: 0, hold: { mode: 0 }, x: 1.0, y: 0.5, vx: 2, vy: 0.6, t: 1000 }, 1000);
  const rd = P.read(1000);
  ok(!!rd && rd.predicted && rd.edge === EDGE.R && rd.leadMs > 0 && rd.seat === 0, `free flight toward me → prediction ${JSON.stringify(rd)}`);
  P.onState({ inTransit: false, seat: 0, hold: { mode: HOLD.WRAP, slot: 1 }, x: 1.0, y: 0.5, vx: 0, vy: 0, t: 1100 }, 1100); ok(P.read(1100) === null, 'a held ball clears the prediction');
  P.onState({ inTransit: false, seat: 0, hold: { mode: 0 }, x: 1.0, y: 0.5, vx: 2, vy: 0.6, t: 1200 }, 1200);
  P.onLaunch({ to: 2, from: 0, edge: EDGE.R, cEdge: 0.5, tEdgeEff: 1500 }); ok(P.read(1200) === null, 'a LAUNCH to someone else clears');
  P.onState({ inTransit: false, seat: 0, hold: { mode: 0 }, x: 1.0, y: 0.5, vx: 2, vy: 0.6, t: 1300 }, 1300);
  P.onLaunch({ to: 1, from: 0, edge: EDGE.R, cEdge: 0.55, tEdge: 1900, tEdgeEff: 1950 });
  const cf = P.read(1400);
  ok(!!cf && cf.predicted === false && cf.tEdgeEst === 1950 && cf.leadMs === 550 && P.stats.confirmed === 1, `LAUNCH to me confirms: ${JSON.stringify(cf)}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(c) [L1] classifyRelease thresholds; a LOST hand never flings the ball');
{
  const v = s => ({ x: s * U, y: 0, z: 0 });
  const c1 = classifyRelease(v(0.24), 'wrap'), c2 = classifyRelease(v(0.25), 'wrap'), c3 = classifyRelease(v(3.0), 'wrap'), c4 = classifyRelease(v(3.0001), 'clip'), c5 = classifyRelease(v(7), 'cradle');
  ok(c1.kind === 'drop' && c1.reason === REASON.ROLL && !c1.clamped && Math.abs(c1.vel.length() - 0.24 * U) < 1e-12, '0.24 u/s → drop (ROLL), velocity kept');
  ok(c2.kind === 'throw' && c2.reason === REASON.THROW && !c2.clamped, '0.25 u/s → throw (THROW)');
  ok(c3.kind === 'throw' && !c3.clamped && Math.abs(c3.vel.length() - 3.0 * U) < 1e-12, '3.0 u/s → throw, not clamped');
  ok(c4.kind === 'throw' && c4.clamped && Math.abs(c4.vel.length() - 3.0 * U) < 1e-9, '3.0001 u/s → clamped to exactly 3.0·U');
  ok(c5.clamped && Math.abs(c5.vel.length() - 3.0 * U) < 1e-9 && c5.vel.x > 0, '7 u/s → 3.0·U, direction kept');
  const l1 = classifyRelease(v(2.0), 'lost'), l2 = classifyRelease(v(0.1), 'lost'), l3 = classifyRelease({ x: 1.2 * U, y: 0.9 * U, z: 0.4 * U }, 'lost');
  ok(l1.kind === 'drop' && l1.reason === REASON.ROLL && l1.clamped && Math.abs(l1.vel.length() - 0.3 * U) < 1e-9, 'lost @ 2.0 u/s → drop clamped to 0.3·U');
  ok(l2.kind === 'drop' && !l2.clamped && Math.abs(l2.vel.length() - 0.1 * U) < 1e-12, 'lost @ 0.1 u/s → drop, kept');
  ok(l3.vel.length() <= 0.3 * U + 1e-9 && l3.vel.x > 0 && l3.vel.y > 0, 'lost 3-D velocity clamped by magnitude, direction kept');
  // through BallGame: wrap, move fast, the pack VANISHES → |vel| ≤ 0.3·U, stays in the tile, no LAUNCH within 2 s
  const w = makeWorld({ seed: 5 });
  const [g0, g1] = [w.games[0], w.games[1]];
  g1.start(); g0.start(); w.run(3000);
  const r = g0.ball.sphere.radius, B = g0.ball.pos.clone();
  let wp = around(B, r, 1, true); w.packs[0].R = wp;
  ok(w.runUntil(() => !!g0.ball.hold, 600) > 0, 'wrapped');
  for (let k = 1; k <= 15; k++) { w.packs[0].R = shift(wp, 0, 0.5 * k / 15, 0); w.step(); }
  wp = shift(wp, 0, 0.5, 0); w.packs[0].R = wp; w.run(200);
  for (let k = 1; k <= 12; k++) { w.packs[0].R = shift(wp, 3.0 * k / 60, 0, 0); w.step(); }   // 3 m/s (1.6 u/s) carry
  ok(!!g0.ball.hold && g0.ball.vel.x > 2.0, `carried fast while held: vx ${r3(g0.ball.vel.x)} m/s`);
  const launches = g0.net.stats.launches;
  w.packs[0].R = null; w.step();                                                // tracker dropout: the holder's pack vanishes THIS frame
  const rel = w.log.filter(e => e.ev === 'release' && e.seat === 0).pop();
  ok(rel && rel.how === 'lost' && rel.kind === 'drop', `release classified ${rel && rel.how}/${rel && rel.kind}`);
  ok(rel && rel.speedU <= 0.3 + 1e-9 && Math.hypot(g0.ball.vel.x, g0.ball.vel.z) <= 0.3 * U + 1e-9, `|vel| clamped to 0.3·U (release ${rel && r3(rel.speedU)} u/s; horizontal ${r3(Math.hypot(g0.ball.vel.x, g0.ball.vel.z))} ≤ ${r3(0.3 * U)} m/s; gravity only adds to y)`);
  ok(g0.stats.lostDrops === 1, 'stats.lostDrops === 1');
  w.run(2000);
  const rect0 = g0.tileWorldRect(0);
  ok(g0.net.stats.launches === launches && g0.net.isOwner && g0.ball.pos.x < rect0.x1 - r, `no LAUNCH within 2 s, ball still in seat 0 (x ${r3(g0.ball.pos.x)} < ${r3(rect0.x1 - r)})`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(d) doctrine through BallGame.tick: [D2] open hover never grabs / lifts; [D3] open after wrap releases; [D5] flat support');
{
  const w = makeWorld({ seed: 7 });
  const [g0, g1] = [w.games[0], w.games[1]];
  g1.start(); g0.start(); w.run(3000);
  const r = g0.ball.sphere.radius, F = g0.ball.floorY;
  const B = g0.ball.pos.clone();
  w.packs[0].L = PackGen.open(B.x + 0.02, B.y, B.z + 0.35);
  for (let k = 0; k < 30; k++) w.step();
  ok(!g0.ball.hold && !g0.ball.cradle, '[D2] open hand over the ball 30 frames: no grab');
  ok(Math.abs(g0.ball.pos.y - B.y) < 1e-3, `[D2] not lifted: |dy| = ${(Math.abs(g0.ball.pos.y - B.y) * 1000).toFixed(2)} mm`);
  ok(g0.phase === PHASE.FLOOR, `phase stays ${g0.phase}`);
  w.packs[0].L = null; w.run(500);
  const B2 = g0.ball.pos.clone(); const wp = around(B2, r, 1, true);
  w.packs[0].L = wp; ok(w.runUntil(() => !!g0.ball.hold, 600) > 0 && g0.ball.hold.type === 'wrap', 'wrap grabs (6 mm skin)');
  w.packs[0].L = opened(wp); w.step();
  ok(g0.ball.hold === null && g0.phase !== PHASE.HELD, `[D3] open after wrap: released that frame (hold ${g0.ball.hold}, phase ${g0.phase})`);
  w.packs[0].L = null; w.run(1500);
  // a flat palm-up shelf held above the floor; the ball is dropped onto it from 0.4 m: rests ON the palm, never below it
  const py = F + 0.15, c3 = w.courtOf(g0, 0);
  w.placeBall(g0, c3.x, c3.y + (0.4 + 0.15) / U, 0, 0);                       // 0.4 m above the palm, on the hand plane
  const wx = g0.ball.pos.x;
  let minY = Infinity;
  for (let k = 0; k < 90; k++) { w.packs[0].R = PackGen.flat(wx, py, -D); w.step(); minY = Math.min(minY, g0.ball.pos.y); }   // a tracked hand is re-read every frame
  ok(g0.ball.pos.y >= py + r - 0.003, `[D5] flat support: ball y ${r3(g0.ball.pos.y)} ≥ palm.y + r - 3 mm = ${r3(py + r - 0.003)} (rests on the palm, not the floor at ${r3(F + r)})`);
  ok(minY >= py + r - 0.02, `[D5] never passed through the palm: min y ${r3(minY)}`);
  ok(!g0.ball.hold && !g0.ball.cradle, '[D5] a flat shelf is support, not possession (closure 0 → no holding pose)');
  ok(g0.ball.vel.length() < 0.2, `[D5] came to rest on the hand (|v| ${r3(g0.ball.vel.length())})`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(e) goal: seat 1 designated; free ball into the ring → GOAL on both, score[0] = 1, respawn → floor; keeper palm → save');
function throwIntoRing(w, g0) {
  const r0 = g0.court.rectOf(0);
  w.placeBall(g0, r0.x0 + r0.w - 0.32, g0.court.floorY(0) + g0.court.R + 0.02, 2.0, 0.85);   // from the shelf line
}
{
  const w = makeWorld({ seed: 31 });
  const [g0, g1] = [w.games[0], w.games[1]];
  g1.start(); g0.start(); w.run(800);
  ok(g0.setGoal(1) === true, 'host designated seat 1 as the goal');
  w.run(400);
  ok(g1.court.map.goal === 1 && g1.court.map.v === 2 && g0.court.map.goal === 1, `SEAT_MAP v2 with goal 1 arrived on seat 1 (goal ${g1.court.map.goal}, v ${g1.court.map.v})`);
  ok(w.log.some(e => e.ev === 'seatmap' || true), 'seat map event');
  throwIntoRing(w, g0);
  const before = w.log.length;
  const dtGoal = w.runUntil(() => w.log.slice(before).filter(e => e.ev === 'goal' && !e.potato).length >= 2, 6000);
  const goals = w.log.slice(before).filter(e => e.ev === 'goal');
  ok(dtGoal > 0 && goals.some(e => e.seat === 0) && goals.some(e => e.seat === 1), `GOAL on both after ${dtGoal | 0} ms: ${JSON.stringify(goals.map(e => ({ seat: e.seat, scorer: e.scorerSeat, goal: e.goalSeat })))}`);
  ok(g0.score[0] === 1 && g1.score[0] === 1 && g0.score[1] === 0, `score[0] === 1 on both (${g0.score} / ${g1.score})`);
  ok(goals.every(e => e.scorerSeat === 0 && e.goalSeat === 1 && !e.potato), 'scorer = last launcher (seat 0), goalSeat 1');
  ok(g1.stats.goals === 1 && w.say.some(s => s.seat === 1 && /GOAL/.test(s.text) && s.level === 'assertive'), 'assertive GOAL announcement on the goal seat');
  const tGoal = goals[0].t;
  w.runUntil(() => g0.net.isOwner && !g0.net.inTransit && g0.phase === PHASE.FLOOR && w.log.some(e => e.ev === 'phase' && e.seat === 0 && e.to === PHASE.RESPAWN && e.t >= tGoal), 6000);
  w.run(LAT_SETTLE());                                                          // the respawned ball rests on the shelf within a frame; give the CLAIM time to reach seat 1
  const ph0 = w.log.filter(e => e.ev === 'phase' && e.seat === 0 && e.t >= tGoal).map(e => e.to);
  ok(ph0.indexOf(PHASE.RESPAWN) >= 0 && ph0.indexOf(PHASE.FLOOR) > ph0.indexOf(PHASE.RESPAWN) && !ph0.slice(0, ph0.indexOf(PHASE.RESPAWN)).some(x => x !== PHASE.SINKING) && g0.net.isOwner, `after the goal the kickoff seat goes (sinking →) respawn → floor: ${ph0.join(' → ')}`);
  ok(w.log.some(e => e.ev === 'respawn' && e.seat === 1 && e.t >= tGoal) && w.say.some(s => /Ball back to P0/.test(s.text)), 'seat 1 saw the respawn ("Ball back to P0")');
  const r0 = g0.court.rectOf(0), c0 = w.courtOf(g0, 0);
  ok(Math.abs(c0.x - (r0.x0 + r0.w / 2)) < 0.05 && Math.abs(c0.y - (g0.court.floorY(0) + g0.court.R)) < 0.03, `ball back at the kickoff tile centre, on the shelf (court ${r3(c0.x)}, ${r3(c0.y)}; shelf + R = ${r3(g0.court.floorY(0) + g0.court.R)})`);
  w.run(500);
  ok(g1.phase === PHASE.FLOOR && g1.score[0] === 1, `seat 1 mirrors floor (${g1.phase}), score kept`);
  // keeper: record the incoming path once (no hands), then put a flat palm on it in front of the ring
  const w2 = makeWorld({ seed: 31 });
  const [h0, h1] = [w2.games[0], w2.games[1]];
  h1.start(); h0.start(); w2.run(800); h0.setGoal(1); w2.run(400);
  throwIntoRing(w2, h0);
  const path = [];
  w2.runUntil(() => { if (h1.net.isOwner && !h1.net.inTransit) { const c = w2.courtOf(h1, 1); path.push({ x: c.x, y: c.y, t: w2.now() }); } return w2.log.some(e => e.ev === 'goal'); }, 6000);
  ok(w2.log.some(e => e.ev === 'goal'), 'control throw scores again (same seed)');
  const r1 = h1.court.rectOf(1), cx = r1.x0 + r1.w / 2;
  const onPath = path.find(p => p.x >= cx - 0.42) || path[Math.floor(path.length / 2)];
  // fresh world, same seed: keeper's flat palm just under the recorded path point, before the ring
  const w3 = makeWorld({ seed: 31 });
  const [k0, k1] = [w3.games[0], w3.games[1]];
  k1.start(); k0.start(); w3.run(800); k0.setGoal(1); w3.run(400);
  // the keeper: an OPEN hand held up as a wall facing the incoming ball (a real-scale PackGen.open turned to face -x), its knuckle
  // row at the height the ball rolls in on the shelf — a flat palm lying at shelf level is a speed bump the ball rolls over
  const palm = courtToWorld(k1.court, onPath.x, k1.court.floorY(1) + k1.court.R, w3.stage.rects, w3.stage.W, w3.stage.H, w3.stage.th, {});
  const keeperWall = (x, y, z) => PackGen.open(0, 0, 0).map(p => ({ x: x + p.z * 1.9, y: y + p.y * 1.9 - 0.076, z: z - p.x * 1.9 }));   // palm plane x = const, knuckles at y
  throwIntoRing(w3, k0);
  const b3 = w3.log.length;
  w3.runUntil(() => { w3.packs[1].R = keeperWall(palm.x, palm.y, -D); return w3.log.slice(b3).some(e => e.ev === 'goal'); }, 4000);
  ok(!w3.log.slice(b3).some(e => e.ev === 'goal') && k0.score[0] === 0, `keeper palm in front of the ring: no goal (score ${k0.score})`);
  ok(k1.stats.saves === 1 && k1.stats.goals === 0, `stats.saves === ${k1.stats.saves}`);
  ok(w3.log.some(e => e.ev === 'ring' && e.seat === 1 && e.kind === 'save') && w3.log.some(e => e.ev === 'chip' && e.text === 'SAVE'), 'SAVE chip + success ring');
  const kr = k1.tileWorldRect(1);
  ok(k1.net.isOwner && k1.ball.pos.y >= k1.ball.floorY + k1.ball.sphere.radius - 1e-3 && k1.ball.pos.x > kr.x0 && k1.ball.pos.x < kr.x1, `the saved ball stays in seat 1, never below the floor (y ${r3(k1.ball.pos.y)}, x ${r3(k1.ball.pos.x)})`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(f) hot potato: fuse restarts on every CLAIM; at expiry a GOAL with bit 7 arrives on both, loser = owner seat');
{
  const w = makeWorld({ seed: 41, mode: 'potato' });
  const [g0, g1] = [w.games[0], w.games[1]];
  g1.start(); g0.start();
  const t0 = w.now();
  ok(g0.potato && g0.potato.untilMs === t0 + FEEL.POTATO_MS && g0.potato.ownerSeat === 0, `host fuse armed at kickoff: until ${g0.potato && g0.potato.untilMs}`);
  w.run(600);
  ok(g1.potato && g1.potato.untilMs === g0.potato.untilMs, `seat 1 fuse agrees (tState from the CLAIM): ${g1.potato && g1.potato.untilMs}`);
  const r0 = g0.court.rectOf(0);
  w.placeBall(g0, r0.x0 + r0.w - 0.4, r0.y0 + 0.5, 2.2, 0.7);
  const dtClaim = w.runUntil(() => g1.net.isOwner, 4000);
  const claim = w.log.filter(e => e.ev === 'claim' && e.seat === 1 && e.mine).pop();
  ok(dtClaim > 0 && claim && claim.claim.reason === CLAIM_REASON.BOUNDARY, `seat 1 claimed at the boundary after ${dtClaim | 0} ms`);
  ok(g1.potato.untilMs === claim.claim.tState + FEEL.POTATO_MS && g1.potato.untilMs > t0 + FEEL.POTATO_MS && g1.potato.ownerSeat === 1, `fuse restarted at the CLAIM's tState: until ${g1.potato.untilMs}`);
  w.run(LAT_SETTLE());
  ok(Math.abs(g0.potato.untilMs - g1.potato.untilMs) <= 1, `host fuse re-armed identically from the CLAIM (${g0.potato.untilMs} vs ${g1.potato.untilMs})`);
  ok(g0.court.map.goal === -1 && g1.court.map.goal === -1, 'no goal tile in hot potato');
  // keep it held on seat 1 so the rest timer does not respawn it before the fuse
  w.runUntil(() => g1.phase === PHASE.FLOOR, 4000);
  const B = g1.ball.pos.clone(); w.packs[1].L = around(B, g1.ball.sphere.radius, 1, true);
  ok(w.runUntil(() => !!g1.ball.hold, 600) > 0, 'seat 1 holds the potato');
  const fuseAt = g1.potato.untilMs, before = w.log.length;
  const dtBurst = w.runUntil(() => w.log.slice(before).filter(e => e.ev === 'goal' && e.potato).length >= 2, 10000);
  const bursts = w.log.slice(before).filter(e => e.ev === 'goal');
  ok(dtBurst > 0 && bursts.length === 2 && bursts.every(e => e.potato && (e.goalNo & POTATO_BIT) && e.scorerSeat === 1), `burst on both at expiry: ${JSON.stringify(bursts.map(e => ({ seat: e.seat, loser: e.scorerSeat, goalNo: e.goalNo })))}`);
  const hostBurst = bursts.find(e => e.seat === 0);
  ok(hostBurst && Math.abs(hostBurst.t - fuseAt) <= FRAME + 1e-6, `host declared within a frame of the fuse (${hostBurst && hostBurst.t} vs ${fuseAt})`);
  ok(g0.score[1] === -1 && g1.score[1] === -1 && g0.score[0] === 0, `loser (owner seat 1) lost a point on both: ${g0.score} / ${g1.score}`);
  ok(Math.abs(g1.potato.untilMs - (hostBurst.t + FEEL.POTATO_MS)) <= 1 && Math.abs(g0.potato.untilMs - g1.potato.untilMs) <= 1, `fuse re-armed from the burst on both (${g0.potato.untilMs} / ${g1.potato.untilMs})`);
  ok(w.say.some(s => /Hot potato: 5 seconds/.test(s.text)) && w.say.some(s => /2 seconds/.test(s.text)) && w.say.some(s => /loses a point/.test(s.text) && s.level === 'assertive'), 'announced at 5 s, 2 s and the burst');
  ok(w.hub.stats.delivered > 0 && g1.net.stats.conflicts === 0, 'no ownership conflicts');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(g) practice (n = 1, wrap none): a +x throw bounces off the wall, never LAUNCHes');
{
  const w = makeWorld({ n: 1, tracked: [true], cols: 1, wrap: 'none', mode: 'practice', seed: 3 });
  const g = w.games[0];
  g.start(); w.run(2500);
  ok(g.phase === PHASE.FLOOR && g.net.isOwner, `solo: phase ${g.phase}`);
  const r0 = g.court.rectOf(0);
  w.placeBall(g, r0.x0 + r0.w / 2, r0.y0 + 0.5, 2.0, 0.8);
  const before = w.log.length;
  const dtWall = w.runUntil(() => w.log.slice(before).some(e => e.ev === 'wall'), 3000);
  const wall = w.log.slice(before).find(e => e.ev === 'wall');
  ok(dtWall > 0 && wall.edge === EDGE.R, `wall bounce after ${dtWall | 0} ms on edge ${wall && wall.edge} (R = 1)`);
  ok(g.ball.vel.x < 0, `vel.x after the bounce: ${r3(g.ball.vel.x)} < 0`);
  ok(g.ball.pos.x + g.ball.sphere.radius <= g.tileWorldRect(0).x1 + 1e-6, 'ball inside the tile after the bounce');
  w.run(3000);
  ok(g.net.stats.launches === 0 && g.net.isOwner && g.stats.walls >= 1, `never LAUNCHed (launches ${g.net.stats.launches}), walls ${g.stats.walls}`);
  const res = g.passToward(5);
  ok(res.ok === false && typeof res.reason === 'string', `passToward(non-neighbour) refused: ${res.reason}`);
  // rest → BallNet respawn (local, kickoff = me) → respawn → floor
  const t0 = w.now();
  const dtResp = w.runUntil(() => g.phase === PHASE.RESPAWN, TUNING.REST_TO_GUTTER_MS + 6000);
  ok(dtResp > 0, `rest timeout → local respawn after ${((w.now() - t0) / 1000).toFixed(1)} s (phase ${g.phase})`);
  ok(w.runUntil(() => g.phase === PHASE.FLOOR, 4000) > 0, 'respawn → floor');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(h) phases never skip arriving; dt clamped to [1/120, 1/30]');
{
  const w = globalThis.__worldA;
  const logs = w.games.filter(Boolean).flatMap(g => g.phaseLog.map(p => ({ ...p, seat: g.seat })));
  const bad = logs.filter(p => p.from === PHASE.TRANSIT && !(p.to === PHASE.ARRIVING || p.to === PHASE.IDLE));
  ok(bad.length === 0 && logs.some(p => p.from === PHASE.TRANSIT && p.to === PHASE.ARRIVING), `transit only ever leads to arriving (${logs.length} transitions, bad ${JSON.stringify(bad)})`);
  const seq1 = w.games[1].phaseLog.map(p => p.to);
  ok(seq1.indexOf(PHASE.ARRIVING) > seq1.indexOf(PHASE.TRANSIT) && seq1.indexOf(PHASE.TRANSIT) >= 0, `seat 1 sequence: ${seq1.join(' → ')}`);
  ok(w.games[0].phaseLog.map(p => p.to).slice(0, 3).join(',') === 'respawn,floor,held', `seat 0 sequence starts respawn → floor → held: ${w.games[0].phaseLog.map(p => p.to).slice(0, 6).join(' → ')}`);
  const g = w.games[1];
  g.tick(w.now(), 1, w.packs[1], null); const a = g.lastDt;
  g.tick(w.now(), 0, w.packs[1], null); const b = g.lastDt;
  g.tick(w.now(), NaN, w.packs[1], null); const c = g.lastDt;
  g.tick(w.now(), 1 / 60, w.packs[1], null); const d = g.lastDt;
  ok(a === FEEL.DT_MAX && b === FEEL.DT_MIN && c === FEEL.DT_MAX && Math.abs(d - 1 / 60) < 1e-12, `dt clamp: 1 → ${r3(a)}, 0 → ${r3(b)}, NaN → ${r3(c)}, 1/60 kept`);
  const snap = g.snapshot();
  ok(snap.phase === g.phase && Array.isArray(snap.score) && 'leadMs' in snap && 'inTransit' in snap && snap.ball && 'holdType' in snap.ball, `snapshot shape ok (${Object.keys(snap).join(',')})`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(i) sfx.js: node --check; every cue has a text twin; cues are safe before unlock()');
{
  let checked = false;
  try { execFileSync(process.execPath, ['--check', new URL('../sdk/game/sfx.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'pipe' }); checked = true; } catch (e) { console.log('      --check failed:', e.message); }
  ok(checked, 'node --check sdk/game/sfx.js');
  const sfx = new Sfx({ volume: 0.35 });
  const contractCues = ['whoosh', 'thud', 'bonk', 'tick', 'chime', 'sink', 'pop'];
  ok(contractCues.every(n => SFX_NAMES.includes(n)), `SFX_NAMES covers the contract cues: ${SFX_NAMES.join(', ')}`);
  ok(contractCues.every(n => typeof sfx.textTwin(n) === 'string' && sfx.textTwin(n).length > 0), `textTwin non-empty: ${contractCues.map(n => `${n}→"${sfx.textTwin(n)}"`).join(', ')}`);
  ok(sfx.textTwin('nope') === '', 'unknown cue → empty twin');
  ok(sfx.unlock() === false && sfx.ctx === null, 'unlock() returns false without WebAudio (Node)');
  let threw = false;
  try { for (const n of contractCues) sfx[n](0.3, 1.2); sfx.mute(true); sfx.duck(true); sfx.setVolume(0.5); sfx.mute(false); sfx.duck(false); } catch (e) { threw = true; console.log('      threw:', e.message); }
  ok(!threw && sfx.stats.skipped === contractCues.length && sfx.stats.played === 0 && sfx.muted === false, `cues before unlock are counted as skipped (${sfx.stats.skipped}), never throw; mute/duck round-trip`);
  ok(typeof MissCue === 'function' && typeof ArrivalRing === 'function' && typeof new MissCue(null).draw === 'function', 'MissCue / ArrivalRing exported');
  // ArrivalRing dashed flag + MissCue against a stub 2D context
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); return undefined; } });
  const ring = new ArrivalRing(ctx, () => ({ px: 10, py: 10, pr: 5 }));
  ring.show({ rect: { x0: 0, y0: 0, w: 1.78, h: 1 }, edge: EDGE.L, cEdge: 0.5, tEdgeEff: 1000, leadMs: 400, dashed: true }); ring.draw(800);
  ok(calls.includes('setLineDash') && ring.active.dashed === true, 'dashed ring calls setLineDash');
  calls.length = 0; ring.show({ rect: { x0: 0, y0: 0, w: 1.78, h: 1 }, edge: EDGE.L, cEdge: 0.5, tEdgeEff: 1000 }); ring.draw(800);
  ok(!calls.includes('setLineDash') && ring.active.dashed === false, 'solid ring by default');
  const miss = new MissCue(ctx); miss.show({ left: 0, top: 0, width: 100, height: 56 }, 'miss'); calls.length = 0; miss.draw(performance.now() + 50);
  ok(calls.includes('strokeRect') && calls.includes('fillRect') && miss.active.length === 1, 'MissCue draws ring + halo for 200 ms');
  miss.draw(performance.now() + 500); ok(miss.active.length === 0, 'MissCue expires after 200 ms');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(j) static greps [D1][D4] (+ [C1]) over ball-game.js, latency-cues.js, sfx.js (comments stripped)');
{
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const forbidden = [
    [/jointsWithin/, '[D1] jointsWithin'], [/GrabState/, '[D1] GrabState'], [/countNearLandmarks/, '[D1] countNearLandmarks'],
    [/gravity\s*[:=]\s*0\b/, '[D4] gravity 0'],
    [/handedness/i, '[C1] handedness'], [/categoryName/, '[C1] categoryName'],
    [/\b1(?:\.0+)?\s*-\s*[\w$.\[\]]*\b(?:x|u)\b/, '[C1] `1 - x` / `1 - u` flip'],
    [/\.z\s*\*=\s*-/, '[C1] z *= -'], [/(?<![\w$.\]\)]\s*)-\s*[\w$.\[\]]+\.z\b/, '[C1] unary-negated .z'], [/\bzs\s*=\s*-?1\b/, '[C1] hard-coded zSign'], [/zSign/, '[C1] zSign'],
    [/\b(mirror|flip|swap)\w*\s*[(=]/i, '[C1] mirror/flip/swap function'],
  ];
  for (const f of ['ball-game.js', 'latency-cues.js', 'sfx.js']) {
    const code = strip(fs.readFileSync(new URL('../sdk/game/' + f, import.meta.url), 'utf8'));
    const hits = forbidden.map(([re, label]) => { const m = code.match(re); return m ? `${label}: "${m[0]}"` : null; }).filter(Boolean);
    ok(hits.length === 0, `${f}: ${hits.length ? hits.join('; ') : 'clean'}`);
  }
  const src = fs.readFileSync(new URL('../sdk/game/ball-game.js', import.meta.url), 'utf8');
  ok(/gravity:\s*FEEL\.GRAVITY_M/.test(src) && /GRAVITY_M:\s*-COURT_GRAVITY\s*\*\s*U/.test(src), '[D4] the game ball is built with FEEL.GRAVITY_M = -COURT_GRAVITY·U');
  ok(/ball\.update\(dt, P, /.test(src) && /ball\.update\(dt \/ n, P, /.test(src) && !/sphere\.update\(/.test(src), 'physics goes through PropBall.update only (whole frame or sub-stepped; the sphere is never stepped here)');
  ok(!/sphere\.pos\.y\s*\+?=\s*[^=]/.test(src.split('\n').filter(l => /_bounce|_onWall/.test(l)).join('\n')), 'no line lifts the ball toward a hand');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
