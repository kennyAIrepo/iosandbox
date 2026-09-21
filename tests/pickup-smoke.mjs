/**
 * tests/pickup-smoke.mjs — B1 BALL FEEL + PICKUP, headless: `node tests/pickup-smoke.mjs` from the repo root.
 * A ONE-seat practice court (BallGame + BallNet over MemHub, scene = null) with the 5 cm game ball RESTING ON THE SHELF, and
 * synthetic 21-point hands at REAL scale (wrist→middle-MCP span 0.19 m, the hand plane's real hand; prop-ball.js packRadii
 * scales the joint spheres off that span). Every scenario goes through BallGame.tick → PropBall.update (the doctrine lane):
 *   (a) a palm-up open hand (fingers relaxed) moved UNDER the resting ball → cradle within 12 frames; supported, never inside the hand
 *   (b) an open hand reaches the ball from the front, the fingers curl round it (real finger lengths along the sphere) → 'wrap' within
 *       6 frames; lifted; opened → released THAT frame; falls back to the shelf and stops, never below it
 *   (c) a cupped (palm-up) hand approaching from the side at 0.4 m/s → pocket attraction ('pocket' seek) then cradle
 *   (d) the OLD ball (0.17 m radius, the hand-span rule): the same real hand cannot WRAP it (its fingers reach 36° round, the wrap gate
 *       needs > 72°), nor clip it; the same palm-under approach is reported for the record
 *   (e) handState(slot) reports open → cupped → holding, with closure / n.y / pocketDist / touching / hold
 *   (f) the radius + shelf API: fixed world radius (default 0.05, ?ballr= and the option clamped to 0.035-0.07), court.R derived,
 *       setBallRadiusM re-bases the prop, setShelfFrac moves the floor and the resting ball with it
 */
import * as THREE from 'three';
import { CourtMap, buildSeatMap, DEFAULT_BALL_RADIUS_M, SHELF_FRAC, UNIT_M } from '../sdk/game/court-map.js';
const TEST_R = 0.05;   // world radius the synthetic hands in this file are shaped for (the page default is DEFAULT_BALL_RADIUS_M = 0.06)
import { BallNet, SharedClock } from '../sdk/game/ball-net.js';
import { MemHub } from '../sdk/net/transports.js';
import { U, D, courtToWorld, tileWorldRect, worldFromStagePx, makeUvCamera } from '../sdk/game/court-space.js';
import { PackGen } from '../sdk/game/pack-gen.js';
import { BallGame, FEEL, PHASE, PalmFill, PALM_FILL, urlBallRadiusM } from '../sdk/game/ball-game.js';
import { PropBall, hullTouch, closure } from '../sdk/game/prop-ball.js';
import { JOINT_RADII } from '../sdk/core/game-physics.js';

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) { passed++; console.log('  ok   ' + label); } else { failed++; console.log('  FAIL ' + label); } };
const info = (label) => console.log('  info ' + label);
const section = (n) => console.log('\n[' + n + ']');
const r3 = (v) => Math.round(v * 1000) / 1000;
const mm = (v) => (v * 1000).toFixed(1) + ' mm';
const FRAME = 1000 / 60;

// ── stage layout (gallery rule B, one tile) ─────────────────────────────────────────────────────────────────
function fixed169(n, W, H, gap = 8, tol = 0.10) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    const c = { cols, rows, tw: Math.floor(tw), th: Math.floor(tw * 9 / 16) };
    if (!best || c.tw > best.tw * (1 + tol)) best = c; else if (c.tw >= best.tw * (1 - tol) && c.cols > best.cols) best = c;
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
  return { W, H, th: f.th, tw: f.tw, rects };
}

// ── REAL-SCALE synthetic hands ───────────────────────────────────────────────────────────────────────────────
const SPAN = 0.19;                                                  // wrist → middle MCP at the hand plane (a real MediaPipe hand)
const KJ = SPAN / 0.204;                                            // packRadii scale (prop-ball.js: JOINT_RADII × palm / 0.204)
const V = (x, y, z) => ({ x, y, z });
const mk = (b) => new Array(21).fill(0).map(() => V(b.x, b.y, b.z));
const scaleAbout = (pack, k, o) => pack.map(p => V(o.x + (p.x - o.x) * k, o.y + (p.y - o.y) * k, o.z + (p.z - o.z) * k));
const shift = (pack, dx, dy, dz) => pack.map(p => V(p.x + dx, p.y + dy, p.z + dz));
const lerpPack = (a, b, t) => PackGen.lerp(a, b, t);
const spanOf = (p) => Math.hypot(p[9].x - p[0].x, p[9].y - p[0].y, p[9].z - p[0].z);
/** PackGen.open (span 0.10) scaled to the real span about its origin: fingers straight, palm in the screen plane. */
const openReal = (x, y, z) => scaleAbout(PackGen.open(x, y, z), SPAN / 0.10, { x, y, z });
/**
 * Palm-UP holding pose (the prop-ball-smoke cupHand, span 0.2 → scaled to 0.19): fingers forward (-z) and relaxed (curling up
 * 3-9 cm → closure ≈ 0.2), thumb up. Palm-block joints (0, 5, 9, 13, 17) lie at y; the palm centre pc ≈ (x, y, z - 0.051).
 */
const palmUp = (x, y, z) => {
  const p = mk(V(x, y, z + 0.1));
  const Uu = (dx, dz, up) => V(x + dx, y + up, z + dz);
  p[0] = Uu(0, 0.1, 0); p[9] = Uu(0, -0.1, 0); p[5] = Uu(0.045, -0.09, 0); p[13] = Uu(-0.02, -0.095, 0); p[17] = Uu(-0.06, -0.085, 0);
  const cols = { 6: 0.045, 10: 0, 14: -0.02, 18: -0.06 };
  for (const [pip, dx] of Object.entries(cols)) { const b = +pip; p[b] = Uu(dx, -0.13, 0.03); p[b + 1] = Uu(dx, -0.16, 0.06); p[b + 2] = Uu(dx, -0.18, 0.09); }
  p[1] = Uu(0.05, 0.06, 0.01); p[2] = Uu(0.08, 0.02, 0.03); p[3] = Uu(0.1, -0.02, 0.05); p[4] = Uu(0.11, -0.05, 0.07);
  return scaleAbout(p, SPAN / 0.2, { x, y, z });
};
const PC_DZ = -0.051;                                               // palmUp: palm centre z offset from the generator origin
/**
 * ANATOMICAL curl round a ball of radius r from the FRONT (+z, the camera side): the knuckle row (5, 9, 13, 17) rests on the
 * ball's front face within the 6 mm skin, the wrist a span below; each finger follows the sphere's surface from its knuckle over
 * the top toward the far side with REAL segment lengths (proximal 4.5 / middle 3.0 / distal 2.5 cm × span/0.19) — the joints
 * sit at surface distance (r + joint radius + skin), so how far round they get is set by r alone: a 5 cm ball puts the finger
 * tips ~92° round (past the wrap gate's 72°), a 17 cm ball only ~36° (never a wrap). `curl = 0` leaves the fingers straight.
 */
const curlAround = (B, r, { curl = 1, skin = 0.003, span = SPAN } = {}) => {
  const k = span / 0.204, ks = span / 0.19;
  const rad = i => JOINT_RADII[i] * k;
  const onSphere = (i, dir, s = skin) => { const l = Math.hypot(dir[0], dir[1], dir[2]) || 1, d = r + rad(i) + s; return V(B.x + dir[0] / l * d, B.y + dir[1] / l * d, B.z + dir[2] / l * d); };
  const p = mk(V(B.x, B.y - 0.3, B.z + 0.5));
  const cols = [[5, 6, 7, 8, 0.022 * ks], [9, 10, 11, 12, 0], [13, 14, 15, 16, -0.022 * ks], [17, 18, 19, 20, -0.044 * ks]];
  const th0 = Math.atan2(0.1, 1);                                   // knuckle contact: just above the front pole
  const segs = [0.045 * ks, 0.030 * ks, 0.025 * ks];
  const reach = [];
  for (const [mcp, pip, dip, tip, x] of cols) {
    p[mcp] = onSphere(mcp, [x, Math.sin(th0), Math.cos(th0)]);
    let th = th0, prev = mcp;
    for (const [j, seg] of [[pip, segs[0]], [dip, segs[1]], [tip, segs[2]]]) {
      const rho = r + (rad(prev) + rad(j)) / 2 + skin;
      const thCurl = th + seg / rho;                                 // arc length along the surface at the mean joint distance
      const thStr = th0;                                             // straight finger: stays at the knuckle angle, extends up (+y) in front of the ball
      const t = curl;
      const a = thStr + (thCurl - thStr) * t;
      if (t >= 1) p[j] = onSphere(j, [x, Math.sin(a), Math.cos(a)]);
      else {                                                         // blend between straight-up and on-sphere positions
        const s = onSphere(j, [x, Math.sin(thCurl), Math.cos(thCurl)]);
        const up = V(p[mcp].x, p[mcp].y + (th === th0 ? seg : 0) + (j === dip ? segs[0] + seg : j === tip ? segs[0] + segs[1] + seg : 0) * 0 + segAccum(j, segs, pip, dip), p[mcp].z + 0.02 * ks);
        p[j] = V(up.x + (s.x - up.x) * t, up.y + (s.y - up.y) * t, up.z + (s.z - up.z) * t);
      }
      th = thCurl; prev = j;
    }
    reach.push(th);
  }
  p[0] = V(p[9].x, p[9].y - Math.sqrt(span * span - 0.012 * 0.012), p[9].z + 0.012);   // |p9 − p0| = span exactly
  const w = p[0];
  p[1] = V(w.x + 0.03 * ks, w.y + 0.04 * ks, w.z - 0.01); p[2] = V(w.x + 0.06 * ks, w.y + 0.08 * ks, w.z - 0.03);
  p[3] = V(w.x + 0.08 * ks, w.y + 0.11 * ks, w.z - 0.05); p[4] = V(w.x + 0.09 * ks, w.y + 0.13 * ks, w.z - 0.07);
  p.reachDeg = reach.map(a => Math.round((a - th0) * 180 / Math.PI));   // how far round each finger tip got (0 = at the knuckle)
  return p;
};
function segAccum(j, segs, pip, dip) { return j === pip ? segs[0] : j === dip ? segs[0] + segs[1] : segs[0] + segs[1] + segs[2]; }

// ── a one-seat practice world ────────────────────────────────────────────────────────────────────────────────
function makeWorld(opts = {}) {
  let T = 0; const now = () => T;
  const hub = new MemHub({ now, rng: () => 0.5 });
  const stage = stageFor(1);
  const map = buildSeatMap([{ clientId: 'c-0', name: 'P0', tracked: true, aspect: 16 / 9, handSpan: SPAN / U }], { cols: 1, wrap: 'none', kickoff: 0, v: 1 });
  const tr = hub.join('c-0'), court = new CourtMap(map), clock = new SharedClock({ localNow: now });
  const net = new BallNet({ transport: tr, clock, court, seat: 0, clientId: 'c-0', isHost: true, rateHz: 20, hooks: {} });
  const d = stage.rects[0], c = worldFromStagePx(d.left + d.width / 2, d.top + d.height / 2, stage.W, stage.H, stage.th, {});
  const cam = makeUvCamera(THREE, d.width / d.height, { x: c.x, y: c.y, z: 0 });
  const game = new BallGame({
    scene: null, court, net, clock, seat: 0, clientId: 'c-0', isHost: true, mode: 'practice', ballRadiusM: TEST_R,   // the synthetic hands below are built for a 5 cm ball; the page default (0.06 for visibility) is asserted separately
    tileWorldRect: s => tileWorldRect(court, s, stage.rects, stage.W, stage.H, stage.th),
    courtToWorld: (x, y, out) => courtToWorld(court, x, y, stage.rects, stage.W, stage.H, stage.th, out),
    uvCamOf: () => cam, domRects: () => stage.rects, cues: null, ...opts,
  });
  const packs = { L: null, R: null }, log = [];
  for (const ev of ['grab', 'release', 'phase']) game.addEventListener(ev, e => log.push({ t: T, ev, ...e.detail }));
  const step = () => { T += FRAME; game.tick(T, FRAME / 1000, packs, null); hub.flush(); };
  const run = ms => { const n = Math.round(ms / FRAME); for (let i = 0; i < n; i++) step(); };
  game.start(); run(500);
  const rect = game.tileWorldRect(0);
  return { game, ball: game.ball, packs, log, step, run, rect, now, court };
}
/** min over the 21 joint spheres of (hull surface distance − joint radius): < 0 = inside the ball */
function minJointGap(ball, pack) { ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true); return hullTouch(ball.hull, ball.mesh, pack); }
function palmTop(pack) { const k = spanOf(pack) / 0.204; let t = -Infinity; for (const i of [0, 5, 9, 13, 17]) t = Math.max(t, pack[i].y + JOINT_RADII[i] * k); return t; }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('setup: the 5 cm ball rests on the shelf of a one-seat practice court; real-scale hands');
const w = makeWorld();
{
  const { game, ball, rect } = w;
  const r = ball.sphere.radius;
  ok(Math.abs(r - TEST_R) < 1e-12 && Math.abs(game.court.R * U - TEST_R) < 1e-12, `ball radius ${r} m (10 cm across, pinned by the ballRadiusM option); court.R = ${game.court.R.toFixed(4)} u derived from it`);
  ok(game.phase === PHASE.FLOOR && Math.abs(ball.pos.y - (rect.floorY + r)) < 1e-6 && Math.abs(rect.floorY - (rect.y0 + SHELF_FRAC * (rect.y1 - rect.y0))) < 1e-9,
    `resting on the shelf: y = shelf + r = ${r3(ball.pos.y)} (shelf at 42 % of the tile: ${r3(rect.floorY)}, tile ${r3(rect.y0)}..${r3(rect.y1)}), phase ${game.phase}`);
  const o = openReal(0, 0, -D), pu = palmUp(0, 0, -D), cw = curlAround({ x: 0, y: 0, z: -D }, 0.05);
  ok(Math.abs(spanOf(o) - SPAN) < 1e-9 && Math.abs(spanOf(pu) - SPAN) < 1e-9 && Math.abs(spanOf(cw) - SPAN) < 1e-9, `generators at real scale: spans ${r3(spanOf(o))} / ${r3(spanOf(pu))} / ${r3(spanOf(cw))} m`);
  ok(closure(o) < 0.05 && closure(pu) > 0.1 && closure(pu) < 0.5, `closure: open ${r3(closure(o))}, palm-up relaxed ${r3(closure(pu))}`);
  const rad9 = JOINT_RADII[9] * KJ;
  info(`joint spheres at this span: wrist ${mm(JOINT_RADII[0] * KJ)}, knuckle ${mm(rad9)}, finger tip ${mm(JOINT_RADII[8] * KJ)}; the lane's cradle pocket sits r + 4 cm above the palm centre`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(a) palm-up open hand moved UNDER the resting ball → cradle within 12 frames; supported, never inside the hand');
{
  const { game, ball, packs, step, run, rect } = w;
  const r = ball.sphere.radius, B = ball.pos.clone();
  const states = [];
  const rec = () => { const s = game.handState('right'); if (!states.length || states[states.length - 1] !== s.state) states.push(s.state); };
  // 1. an open hand off to the side (not touching): 'open'
  packs.R = openReal(B.x + 0.45, B.y + 0.1, B.z); for (let i = 0; i < 5; i++) { step(); rec(); }
  const hsOpen = game.handState('right');
  ok(hsOpen.present && hsOpen.pose === 'open' && hsOpen.state === 'open' && !hsOpen.touching && hsOpen.hold === null, `open hand beside the ball: ${JSON.stringify({ state: hsOpen.state, closure: r3(hsOpen.closure), why: hsOpen.why })}`);
  // 2. the palm-up hand slides in under the ball in 10 frames (3 cm/frame): palm block 4 cm under the shelf line so the pocket (pc + r + 4 cm) is at the ball's centre
  const hy = rect.floorY - 0.04, hz = B.z - PC_DZ;
  const from = palmUp(B.x + 0.30, hy, hz), to = palmUp(B.x, hy, hz);
  let cradleAt = -1, arrivedAt = -1, minGapApproach = Infinity, sawPocket = false;
  for (let i = 1; i <= 10; i++) { packs.R = lerpPack(from, to, i / 10); step(); rec(); if (ball.seek === 'pocket') sawPocket = true; minGapApproach = Math.min(minGapApproach, minJointGap(ball, packs.R)); if (ball.cradle === 'right' && cradleAt < 0) cradleAt = i; }
  arrivedAt = 10; packs.R = to;
  for (let i = 11; i <= 60 && cradleAt < 0; i++) { step(); rec(); minGapApproach = Math.min(minGapApproach, minJointGap(ball, packs.R)); if (ball.cradle === 'right') cradleAt = i; }
  const hs = game.handState('right');
  ok(cradleAt > 0 && cradleAt - arrivedAt <= 12, `cradle after ${cradleAt} frames (${Math.max(0, cradleAt - arrivedAt)} after the palm arrived under it; pocket pull seen: ${sawPocket}), phase ${game.phase}`);
  ok(hs.holdPose && hs.pose === 'cupped' && hs.ny > 0.25 && hs.hold === 'cradle' && hs.state === 'holding', `handState: ${JSON.stringify({ state: hs.state, hold: hs.hold, pose: hs.pose, closure: r3(hs.closure), ny: r3(hs.ny), pocketDist: r3(hs.pocketDist), touching: hs.touching })}`);
  // 3. hold still 60 frames: supported on the palm (y >= palm top + r - 6 mm), never inside the hand (joint gap >= -6 mm settled, >= -20 mm ever = the 2 cm/frame yield)
  let minY = Infinity, minGap = Infinity, minGapSettled = Infinity;
  for (let i = 0; i < 60; i++) { step(); rec(); minY = Math.min(minY, ball.pos.y); const g = minJointGap(ball, packs.R); minGap = Math.min(minGap, g); if (i >= 30) minGapSettled = Math.min(minGapSettled, g); }
  const pt = palmTop(packs.R);
  ok(ball.cradle === 'right' && minY >= pt + r - 0.006, `stays supported: min y ${r3(minY)} >= palm top ${r3(pt)} + r − 6 mm = ${r3(pt + r - 0.006)} (ball ${mm(ball.pos.y - pt - r)} above the palm surface — the lane's pocket)`);
  ok(minGapSettled >= -0.006 && minGap >= -0.02 && minGapApproach >= -0.02, `never inside the hand: joint gap ${mm(minGapSettled)} settled (>= -6), ${mm(Math.min(minGap, minGapApproach))} worst during the approach (>= -20)`);
  // (e) transitions
  ok(states.indexOf('open') >= 0 && states.indexOf('cupped') > states.indexOf('open') && states.indexOf('holding') > states.indexOf('cupped'), `(e) handState transitions open → cupped → holding: ${states.join(' → ')}`);
  // the cradled ball rides the hand up 20 cm (gravity on: it is the palm that carries it)
  const y0 = ball.pos.y; let pk = packs.R;
  for (let k = 1; k <= 20; k++) { packs.R = shift(pk, 0, 0.2 * k / 20, 0); step(); }
  pk = packs.R; run(200);
  ok(ball.cradle === 'right' && ball.pos.y - y0 > 0.15, `cradled ball rides the hand up: rose ${r3(ball.pos.y - y0)} m`);
  // hand gone → the ball falls to the shelf (lost drop), never below it
  packs.R = null; let low = Infinity; for (let i = 0; i < 90; i++) { step(); low = Math.min(low, ball.pos.y); }
  ok(!ball.cradle && Math.abs(ball.pos.y - (rect.floorY + r)) < 2e-3 && low >= rect.floorY + r - 1e-3 && ball.vel.length() < 0.05, `hand gone: falls to the shelf and stops (y ${r3(ball.pos.y)} = shelf + r, lowest ${r3(low)}, |v| ${r3(ball.vel.length())})`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(b) fingers curl round it → wrap within 6 frames; lifted; opened → released THAT frame; falls to the shelf, never below');
{
  const { game, ball, packs, step, run, rect, log } = w;
  const r = ball.sphere.radius;
  run(300);
  const B = ball.pos.clone();
  // 1. the open hand reaches the ball's front face over 8 frames (fingers straight): support contact, no grab
  const openAt = curlAround(B, r, { curl: 0 }), far = shift(openAt, 0.25, 0.05, 0.15);
  for (let i = 1; i <= 8; i++) { packs.R = lerpPack(far, openAt, i / 8); step(); }
  const hsTouch = game.handState('right');
  ok(!ball.hold && !ball.cradle && hsTouch.touching, `open hand on the ball's front: touching ${hsTouch.touching}, no grab (why: "${hsTouch.why}")`);
  // 2. the fingers curl round it over 4 frames → WRAP within 6 frames of the curl starting
  const curled = curlAround(B, r, { curl: 1 });
  info(`finger tips reach ${curled.reachDeg.join('/')}° round the 5 cm ball (index/middle/ring/pinky; the wrap gate needs > 72°)`);
  let wrapAt = -1;
  for (let i = 1; i <= 6; i++) { packs.R = lerpPack(openAt, curled, Math.min(1, i / 4)); step(); if (ball.hold && wrapAt < 0) wrapAt = i; }
  ok(wrapAt > 0 && wrapAt <= 6 && ball.hold && ball.hold.type === 'wrap' && game.phase === PHASE.HELD, `wrap after ${wrapAt} frames: hold ${JSON.stringify(ball.hold && ball.hold.type)}, phase ${game.phase}`);
  const hsHold = game.handState('right');
  ok(hsHold.hold === 'wrap' && hsHold.state === 'holding', `handState: state ${hsHold.state}, hold ${hsHold.hold}`);
  // 3. lift 20 cm (rides the hand)
  const yHeld = ball.pos.y; let pk = packs.R;
  for (let k = 1; k <= 20; k++) { packs.R = shift(pk, 0, 0.2 * k / 20, 0); step(); }
  pk = packs.R; run(150);
  ok(!!ball.hold && ball.pos.y - yHeld > 0.15, `wrapped ball rides the lifting hand: rose ${r3(ball.pos.y - yHeld)} m`);
  // 4. open → released THAT frame
  const opened = curlAround({ x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, r, { curl: 0 });
  const before = log.length;
  packs.R = opened; step();
  const rel = log.slice(before).find(e => e.ev === 'release');
  ok(!ball.hold && rel && rel.how === 'wrap', `open → released that frame: hold ${ball.hold}, release ${rel && rel.how}/${rel && rel.kind}`);
  // 5. hand away → falls to the shelf and stops, never below it
  packs.R = null; let low = Infinity; for (let i = 0; i < 90; i++) { step(); low = Math.min(low, ball.pos.y); }
  ok(Math.abs(ball.pos.y - (rect.floorY + r)) < 2e-3 && low >= rect.floorY + r - 1e-3 && ball.vel.length() < 0.05 && game.phase === PHASE.FLOOR,
    `falls to the shelf and stops: y ${r3(ball.pos.y)} = shelf ${r3(rect.floorY)} + r, lowest ${r3(low)} (never below shelf), |v| ${r3(ball.vel.length())}, phase ${game.phase}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(c) cupped hand approaching from the side at 0.4 m/s → pocket attraction, then cradle');
{
  const w2 = makeWorld();
  const { game, ball, packs, step, rect } = w2;
  const r = ball.sphere.radius, B = ball.pos.clone();
  const hy = rect.floorY - 0.04, hz = B.z - PC_DZ;
  const v = 0.4, perFrame = v / 60;
  let x = B.x + 0.32, seekAt = -1, cradleAt = -1, distAtSeek = 0, distAtCradle = 0, maxXDrift = 0;
  for (let i = 1; i <= 90 && cradleAt < 0; i++) {
    x -= perFrame; packs.R = palmUp(x, hy, hz); step();
    const hs = game.handState('right');
    if (ball.seek === 'pocket' && seekAt < 0) { seekAt = i; distAtSeek = hs.pocketDist; }
    if (ball.cradle === 'right') { cradleAt = i; distAtCradle = hs.pocketDist; }
    maxXDrift = Math.max(maxXDrift, ball.pos.x - B.x);              // the hand comes from +x: the pull rolls the ball toward +x
  }
  ok(seekAt > 0 && cradleAt > seekAt, `pocket attraction from frame ${seekAt} (pocket ${r3(distAtSeek)} m away ≤ 3.5 r = ${r3(3.5 * r)}), cradle at frame ${cradleAt} (pocket ${r3(distAtCradle)} m ≤ r)`);
  ok(maxXDrift > 0.02 && maxXDrift < 0.3, `the ball rolled ${r3(maxXDrift)} m toward the approaching palm (x/z pull only, gravity on)`);
  const hs = game.handState('right');
  ok(hs.hold === 'cradle' && game.phase === PHASE.HELD && Math.abs(ball.pos.y - rect.floorY) < 0.2, `cradled: hold ${hs.hold}, phase ${game.phase}, ball y ${r3(ball.pos.y)} (shelf ${r3(rect.floorY)})`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(d) the OLD 0.17 m ball (the hand-span rule): a real hand cannot wrap or clip it; the palm-under approach for the record');
{
  const { rect } = w;
  const R17 = 0.17;
  const home = new THREE.Vector3((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, -D);
  const big = new PropBall(null, { radius: R17, gravity: FEEL.GRAVITY_M, restitution: FEEL.RESTITUTION, home, floorY: rect.floorY, boundsR: 3, spawnOffset: new THREE.Vector3(0, 0, 0) });
  const stepB = (pk) => big.update(1 / 60, pk);
  for (let i = 0; i < 120; i++) stepB({ L: null, R: null });
  const B = big.pos.clone();
  ok(Math.abs(B.y - (rect.floorY + R17)) < 2e-3, `0.17 m ball rests on the shelf at y ${r3(B.y)} (34 cm across, its top at ${r3(B.y + R17)} vs the tile top ${r3(rect.y1)})`);
  // (d2) the same anatomical curl: the finger tips only get ~36° round → no wrap, no clip, ever
  const open17 = curlAround(B, R17, { curl: 0 }), curl17 = curlAround(B, R17, { curl: 1 });
  info(`finger tips reach ${curl17.reachDeg.join('/')}° round the 17 cm ball (vs ${curlAround(B, 0.05, { curl: 1 }).reachDeg.join('/')}° round the 5 cm ball)`);
  let held = null;
  for (let i = 1; i <= 8; i++) { stepB({ L: null, R: lerpPack(shift(open17, 0.25, 0.05, 0.15), open17, i / 8) }); }
  for (let i = 1; i <= 60; i++) { stepB({ L: null, R: lerpPack(open17, curl17, Math.min(1, i / 4)) }); if (big.hold) { held = big.hold.type; break; } }
  ok(held === null && !big.hold, `curling a real hand round the 0.17 m ball never grips: hold ${JSON.stringify(held)} after 60 frames (the wrap gate needs finger contacts > 72° from the palm contact)`);
  // (d1) the same palm-under approach as (a), for the record: the lane's pocket capture is radius-relative, so this part of the old
  // failure was the tile-BOTTOM floor (a palm 4 cm under a ball resting on the bottom edge is out of the frame) and the size, not the pocket
  const hy = rect.floorY - 0.04, hz = B.z - PC_DZ;
  const from = palmUp(B.x + 0.30, hy, hz), to = palmUp(B.x, hy, hz);
  let cradle17 = -1, gap17 = Infinity;
  for (let i = 1; i <= 10; i++) { const pk = lerpPack(from, to, i / 10); stepB({ L: null, R: pk }); gap17 = Math.min(gap17, minJointGap(big, pk)); if (big.cradle && cradle17 < 0) cradle17 = i; }
  for (let i = 11; i <= 60 && cradle17 < 0; i++) { stepB({ L: null, R: to }); if (big.cradle) cradle17 = i; }
  info(`palm-under approach on the 0.17 m ball: ${cradle17 > 0 ? 'cradled at frame ' + cradle17 : 'no cradle in 60 frames'} (pocket r + 4 cm = 21 cm above the palm centre; worst joint gap ${mm(gap17)} — the lane's pocket capture is radius-relative, so the SIZE alone does not stop the cradle; the wrap is what it kills)`);
  const tileBottomPalm = rect.y0 - 0.04;
  ok(tileBottomPalm < rect.y0, `documented: with the tile bottom as the floor, the palm-under pose for a 0.17 m ball sits ${mm(rect.y0 - tileBottomPalm)} below the frame (hands leave the frame there) — the shelf puts the same pose ${mm(hy - rect.y0)} inside it`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
section('(f) radius + shelf API: fixed world size, ?ballr= / option clamped, court.R derived, setBallRadiusM / setShelfFrac');
{
  ok(FEEL.BALL_RADIUS_M === DEFAULT_BALL_RADIUS_M && FEEL.BALL_RADIUS_M === 0.06 && FEEL.BALL_RADIUS_MIN_M === 0.035 && FEEL.BALL_RADIUS_MAX_M === 0.07 && FEEL.SHELF_FRAC === 0.42, `FEEL: BALL_RADIUS_M ${FEEL.BALL_RADIUS_M} (${FEEL.BALL_RADIUS_MIN_M}-${FEEL.BALL_RADIUS_MAX_M}), SHELF_FRAC ${FEEL.SHELF_FRAC}`);
  ok(urlBallRadiusM('?ballr=0.06') === 0.06 && urlBallRadiusM('?x=1&ballr=0.1') === 0.07 && urlBallRadiusM('?ballr=0.01') === 0.035 && urlBallRadiusM('?ballr=abc') === null && urlBallRadiusM('') === null && urlBallRadiusM() === null,
    'urlBallRadiusM: ?ballr=0.06 → 0.06, 0.1 → 0.07, 0.01 → 0.035, junk / absent → null (Node: no location → null)');
  const w3 = makeWorld({ ballRadiusM: 0.02 });
  ok(Math.abs(w3.ball.sphere.radius - 0.035) < 1e-12 && Math.abs(w3.court.R * U - 0.035) < 1e-12, `option ballRadiusM 0.02 → clamped to 0.035 (ball ${w3.ball.sphere.radius}, court.R·U ${r3(w3.court.R * U)})`);
  const w4 = makeWorld({ ballRadiusM: 0.06 });
  const { game, ball, rect, step, run } = w4;
  ok(Math.abs(ball.sphere.radius - 0.06) < 1e-12 && Math.abs(ball.hull.segs[0].ra - 0.06) < 1e-12 && Math.abs(ball.collider.radius - 0.06) < 1e-12 && Math.abs(ball.pos.y - (rect.floorY + 0.06)) < 1e-6, `option ballRadiusM 0.06: sphere / hull / collider radius 0.06, resting at shelf + 0.06`);
  const applied = game.setBallRadiusM(0.04);
  run(600);                                                                     // the shrunk ball drops 2 cm onto the shelf and settles (one small bounce)
  ok(applied === 0.04 && Math.abs(ball.radius - 0.04) < 1e-12 && Math.abs(ball.sphere.radius - 0.04) < 1e-12 && Math.abs(ball.hull.segs[0].ra - 0.04) < 1e-12 && Math.abs(game.court.R * U - 0.04) < 1e-12 && Math.abs(game.court.map.ballR - game.court.R) < 1e-15 && Math.abs(ball.pos.y - (rect.floorY + 0.04)) < 2e-3,
    `setBallRadiusM(0.04): prop re-based in place (radius / hull / sphere), court.R·U = ${r3(game.court.R * U)}, map.ballR carried, resting at shelf + 0.04 (y ${r3(ball.pos.y)})`);
  ok(game.setBallRadiusM(0.5) === 0.07 && game.setBallRadiusM(0) === 0.035, 'setBallRadiusM clamps to 0.035-0.07');
  game.setBallRadiusM(0.05); run(100);
  const f0 = ball.floorY;
  const f = game.setShelfFrac(0.55); run(100);
  const rect2 = game.tileWorldRect(0);
  ok(f === 0.55 && Math.abs(rect2.floorY - (rect2.y0 + 0.55 * (rect2.y1 - rect2.y0))) < 1e-9 && Math.abs(ball.floorY - rect2.floorY) < 1e-9 && ball.floorY > f0 && Math.abs(ball.pos.y - (ball.floorY + 0.05)) < 2e-3 && game.court.map.shelf === 0.55,
    `setShelfFrac(0.55): tileWorldRect.floorY = y0 + 0.55·h (${r3(rect2.floorY)}, was ${r3(f0)}), the ball's floor follows and the resting ball rides up to it (y ${r3(ball.pos.y)}), map.shelf carried`);
  ok(game.setShelfFrac(0.05) === 0.2 && game.setShelfFrac(0.9) === 0.7, 'setShelfFrac clamps to 0.2-0.7');
  game.setShelfFrac(SHELF_FRAC); run(300);
  const snap = game.snapshot();
  ok(snap.radiusM === 0.05 && snap.shelfFrac === SHELF_FRAC && snap.hands && snap.hands.right.state === 'absent' && Math.abs(snap.floorY - ball.floorY) < 1e-12, `snapshot carries radiusM ${snap.radiusM}, shelfFrac ${snap.shelfFrac}, floorY, hands.{left,right}`);
  // the palm fill: 13 support beads that ride the real joints, radii scaled like packRadii, never larger than the joints they bridge
  const pf = new PalmFill().update(palmUp(0, 0, -D));
  ok(pf.present && pf.joints.length === PALM_FILL.length && pf.radii.every((rr, i) => rr <= Math.max(JOINT_RADII[PALM_FILL[i][0]], JOINT_RADII[PALM_FILL[i][1]]) * KJ + 1e-9) && pf.openness === 1,
    `PalmFill: ${PALM_FILL.length} beads, radii ${mm(Math.min(...pf.radii))}..${mm(Math.max(...pf.radii))} (≤ the bridged joints), openness pinned 1 (support only)`);
  ok(!new PalmFill().update(null).present, 'PalmFill.update(null) → absent');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
