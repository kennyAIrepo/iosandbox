/**
 * _twinpass-probe.mjs — two teamslab.html pages in ONE headless Chrome (same origin → BroadcastChannel loopback), BUILD-PLAN T6:
 *   A: ?auto=1&fixedstep=1&consent=1&transport=loopback&room=t&name=A&host=1&bot=1&agent=local&nosfx=1
 *   B: ?auto=1&fixedstep=1&consent=1&transport=loopback&room=t&name=B&agent=local&nosfx=1
 *   1. both seatMap.v >= 1 with an identical seat order (A = host = seat 0, B seat 1, A's bot seat 2), B's clock converges
 *   2. A: flat (support) then cup (holding pose -> cradle) -> held; then a doctrine-true wrap, lift, carry +x at 1.5 m/s for 20
 *      frames, open -> B sees the LAUNCH (net.stats.launches on A = 1); B's predictor showed leadMs >= 300 (dashed ring) before it;
 *      B onBecameOwner within tEdgeEff + 250 ms; B's ball inside B's tile with vel.x > 0; A inTransit === false afterwards;
 *      exactly one in-tile owner at every 50 ms sample over 3 s
 *   3. designate_goal from A's agent ("make B the goal") -> seatMap.goal === 1 on both
 *   4. a throw into the ring with B's hands empty -> GOAL on both, score[0] === 1, live regions announce on both
 *   5. hot potato -> fuse on both, no goal ring
 *   6. the bot appears in both rosters and its BallNet claims >= 1 within 20 s (a pass toward its seat)
 * Run from the repo root: node tests/_twinpass-probe.mjs   (reuses :3333 when it serves teamslab.html, else spawns tools/dev-server.mjs)
 * Synthetic hands: the r-parametrised `around` / `cupHand` generators of tests/ball-game-smoke.mjs (PackGen.cup cannot wrap a
 * court ball, T4) driven per frame through window.__twin.beforeFrame (the page's ovPacks seam, CONTRACTS §0/§6 [5]).
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1100,720'];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh|Autoplay|GPU stall|WebGL warning|TensorFlow|GL_INVALID|OpenGL ES|Overriding|deprecated/i;
const ROOM = process.env.TWIN_ROOM || ('t' + Math.random().toString(36).slice(2, 6));
const QA = `auto=1&fixedstep=1&consent=1&transport=loopback&room=${ROOM}&name=A&host=1&bot=1&agent=local&nosfx=1`;
const QB = `auto=1&fixedstep=1&consent=1&transport=loopback&room=${ROOM}&name=B&agent=local&nosfx=1`;

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? '  ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r3 = v => (typeof v === 'number' ? +v.toFixed(3) : v);

// ── server ────────────────────────────────────────────────────────────────────
async function serves(port) { try { const r = await fetch(`http://localhost:${port}/teamslab.html`); return r.ok && (await r.text()).includes('tw-frame tw-meeting'); } catch { return false; } }
function busy(port) { return new Promise(res => { const s = net.createServer(); s.once('error', () => res(true)); s.once('listening', () => s.close(() => res(false))); s.listen(port, '127.0.0.1'); }); }
let PORT = +(process.env.HOPEOS_PORT || 3333), server = null;
if (!(await serves(PORT))) {
  while (await busy(PORT)) PORT++;
  server = spawn(process.execPath, [path.join(REPO, 'tools/dev-server.mjs'), String(PORT)], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await serves(PORT)); i++) await sleep(100);
  console.log(`  (spawned dev server on :${PORT})`);
} else console.log(`  (reusing dev server on :${PORT})`);
const BASE = `http://localhost:${PORT}/teamslab.html?`;

// ── synthetic hands + the per-frame throw driver (evaluated inside page A) ───────────────────────────────────
const GEN = `
const V = (x, y, z) => ({ x, y, z });
const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
/** r-AWARE (tests/ball-game-smoke.mjs): every joint sphere on the ball's surface (r + JOINT_RADII[i] + 3 mm), palm joints on the +z
 *  face, the four fingers curling over the top to the far side (DIP/TIP normals > 72° from the palm normal); fingersOn=false = straight up */
const JOINT_RADII = window.__JOINT_RADII;
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
const opened = pack => pack.map((q, i) => ([6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20].includes(i) ? V(q.x, q.y, q.z - 0.15) : q));
const cupHand = (x, y, z) => {
  const p = mk(V(x, y, z + 0.1));
  const Uu = (dx, dz, up) => V(x + dx, y + up, z + dz);
  p[0] = Uu(0, 0.1, 0); p[9] = Uu(0, -0.1, 0); p[5] = Uu(0.045, -0.09, 0); p[13] = Uu(-0.02, -0.095, 0); p[17] = Uu(-0.06, -0.085, 0);
  const cols = { 6: 0.045, 10: 0, 14: -0.02, 18: -0.06 };
  for (const [pip, dx] of Object.entries(cols)) { const b = +pip; p[b] = Uu(dx, -0.13, 0.03); p[b + 1] = Uu(dx, -0.16, 0.06); p[b + 2] = Uu(dx, -0.18, 0.09); }
  p[1] = Uu(0.05, 0.06, 0.01); p[2] = Uu(0.08, 0.02, 0.03); p[3] = Uu(0.1, -0.02, 0.05); p[4] = Uu(0.11, -0.05, 0.07);
  return p;
};
window.__gen = { V, mk, around, opened, cupHand, PackGen: window.__twin.PackGen };
/**
 * Wrap the resting ball, lift to \`at\` at liftSpeed (m/s), carry with velocity v (m/s) for \`frames\` frames, open (release).
 * Everything goes through S.ovPacks[me] per frame; resolves with what happened.
 */
window.__throw = (o) => new Promise(resolve => {
  const me = __twin.S.me.clientId, ball = __twin.game.ball, r = ball.sphere.radius;
  const stepping = !!o.stepDt;
  const pos = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z };
  const log = { frames: 0, grabbed: null, lifted: null, released: null, reason: null, relVel: null, launches0: __twin.net.stats.launches, path: [] };
  let phase = 'grab', carry = 0, openFrames = 0;
  let done = false;
  const finish = (reason) => { done = true; __twin.beforeFrame = null; delete __twin.ovPacks[me]; log.reason = reason; if (stepping) __twin.pause(false); resolve(log); };
  __twin.beforeFrame = (dt) => {
    log.frames++;
    const pack = () => __gen.around(pos, r, 1, true);
    if (phase === 'grab') { __twin.ovPacks[me] = { L: null, R: pack() }; if (ball.hold) { log.grabbed = log.frames; phase = 'lift'; } else if (log.frames > 40) finish('no grab'); return; }
    if (phase === 'lift') {
      const dx = o.at.x - pos.x, dy = o.at.y - pos.y, d = Math.hypot(dx, dy), st = o.liftSpeed * dt;
      if (d <= st) { pos.x = o.at.x; pos.y = o.at.y; phase = 'carry'; log.lifted = log.frames; } else { pos.x += dx / d * st; pos.y += dy / d * st; }
      __twin.ovPacks[me] = { L: null, R: pack() }; if (!ball.hold) finish('lost during lift'); return;
    }
    if (phase === 'carry') {
      pos.x += o.v.x * dt; pos.y += o.v.y * dt; carry++;
      __twin.ovPacks[me] = { L: null, R: pack() }; log.path.push([+pos.x.toFixed(3), +pos.y.toFixed(3)]);
      if (!ball.hold) { finish('lost during carry'); return; }
      if (carry >= o.frames) phase = 'open'; return;
    }
    if (phase === 'open') {
      __twin.ovPacks[me] = { L: null, R: __gen.opened(pack()) };
      if (openFrames === 0) { /* the release happens inside this frame's physics */ }
      openFrames++;
      if (openFrames === 2) { log.released = { frame: log.frames, held: !!ball.hold, vel: { x: +ball.vel.x.toFixed(3), y: +ball.vel.y.toFixed(3), z: +ball.vel.z.toFixed(3) }, pos: { x: +ball.pos.x.toFixed(3), y: +ball.pos.y.toFixed(3) }, phase: __twin.game.phase }; }
      if (openFrames >= 4) finish('ok');
    }
  };
  if (stepping) { __twin.pause(true); let n = 0; const tick = () => { if (done) return; if (n++ > 3000) { finish('step limit'); return; } __twin.step(o.stepDt); setTimeout(tick, Math.max(1, Math.round(o.stepDt * 1000))); }; tick(); }
});
`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 45000, args: ARGS });
const logs = { A: [], B: [] };
let exitCode = 1;
async function open(name, query) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
  page.on('console', m => { const t = m.type(), text = m.text(); if (text.startsWith('AUTOTEST ')) return; if ((t === 'error' || t === 'warning') && !FILTER.test(text)) logs[name].push(`[${t}] ${text.slice(0, 300)}`); });
  page.on('pageerror', async e => { logs[name].push('[PAGEERROR] ' + String(e.stack || e.message).split(String.fromCharCode(10)).slice(0, 8).join(' | ')); try { const st = await page.evaluate(() => ({ owner: __twin.net.owner, seat: __twin.net.seat, proxyFor: __twin.net.proxyFor, netHost: __twin.net.isHost, roomHost: __twin.room.isHost, seats: __twin.court.map.seats.length, sim: __twin.net.simSeat, phase: __twin.game.phase, gameSeat: __twin.game.seat, roster: __twin.S.roster.length, v: __twin.court.map.v, ev: __twin.events.slice(-5).map(x => x.ev + ':' + JSON.stringify(x.d).slice(0, 60)) })); logs[name].push('[STATE] ' + JSON.stringify(st)); } catch (_) {} });
  page.on('requestfailed', r => { if (!FILTER.test(r.url())) logs[name].push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`); });
  await page.goto(BASE + query, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 120000, polling: 100 });
  return page;
}
const state = (page) => page.evaluate(() => { const s = __twin.snapshot(); return { me: s.me.clientId, seat: s.me.seat, host: s.me.isHost, mode: s.mode, phase: s.phase, seatMap: s.seatMap, roster: s.roster.map(p => p.clientId), rosterKinds: s.roster.map(p => p.kind), game: s.game, net: s.net, clockReady: __twin.room.clockReady(), samples: __twin.clock.samples.length, offset: Math.round(__twin.clock.offset), running: __twin.game.running, bots: s.bots, ballW: { x: +__twin.game.ball.pos.x.toFixed(3), y: +__twin.game.ball.pos.y.toFixed(3) }, rect: __twin.game.tileWorldRect(__twin.S.me.seat), layout: __twin.ui._layout && { cols: __twin.ui._layout.cols, rows: __twin.ui._layout.rows, tw: __twin.ui._layout.tw, th: __twin.ui._layout.th } }; });
const owners = (A, B) => Promise.all([
  A.evaluate(() => ({ me: __twin.net.isOwner && !__twin.net.inTransit, bot: __twin.S.bots.map(b => b.bot.net.isOwner && !b.bot.net.inTransit), transit: __twin.net.inTransit })),
  B.evaluate(() => ({ me: __twin.net.isOwner && !__twin.net.inTransit, transit: __twin.net.inTransit })),
]);

try {
  console.log(`\n[boot] room ${ROOM}`);
  const A = await open('A', QA);
  const B = await open('B', QB);
  await Promise.all([
    A.waitForFunction(() => __twin.S.seatMap && __twin.S.seatMap.seats.length === 3, { timeout: 30000, polling: 100 }),
    B.waitForFunction(() => __twin.S.seatMap && __twin.S.seatMap.seats.length === 3, { timeout: 30000, polling: 100 }),
  ]).catch(() => {});
  await B.waitForFunction(() => __twin.room.clockReady() && __twin.game.running, { timeout: 20000, polling: 100 }).catch(() => {});
  await A.waitForFunction(() => __twin.game.running && __twin.game.phase === 'floor' && __twin.net.isOwner, { timeout: 20000, polling: 100 }).catch(() => {});
  await sleep(500);
  let sA = await state(A), sB = await state(B);
  const bootErr = await Promise.all([A.evaluate(() => __twin.S.boot.error), B.evaluate(() => __twin.S.boot.error)]);

  console.log('\n[1] room: seat maps, host, clock');
  console.log('    A ball', JSON.stringify(sA.ballW), 'A rect', JSON.stringify(sA.rect), 'layout', JSON.stringify(sA.layout));
  ok(!bootErr[0] && !bootErr[1], `both pages booted without error`, bootErr.filter(Boolean).map(e => String(e).slice(0, 200)).join(' | '));
  ok(sA.seatMap && sB.seatMap && sA.seatMap.v >= 1 && sB.seatMap.v >= 1, `seatMap.v A=${sA.seatMap && sA.seatMap.v}, B=${sB.seatMap && sB.seatMap.v} (both >= 1)`);
  ok(sA.seatMap && sB.seatMap && sA.seatMap.seats.join() === sB.seatMap.seats.join() && sA.seatMap.seats.length === 3, `identical seat order on both: ${sA.seatMap && sA.seatMap.seats.map(s => s.slice(-6)).join(' > ')}`);
  ok(sA.host && !sB.host && sA.seat === 0 && sB.seat === 1, `A host seat 0 (${sA.host}, ${sA.seat}); B seat 1 (host ${sB.host}, seat ${sB.seat})`);
  ok(sB.clockReady && sB.samples >= 8, `B clock converged: ${sB.samples} samples, offset ${sB.offset} ms, clockReady ${sB.clockReady}`);
  ok(sA.running && sB.running && ['floor', 'flight', 'sinking', 'respawn'].includes(sA.phase) && sA.game.owner === 0 && sB.game.owner === 0, `games running on both; A kicked off and owns: phase ${sA.phase}, owner ${sA.game.owner} (B sees owner ${sB.game.owner}, phase ${sB.phase}; the 8 s rest-to-gutter timer may cycle floor -> sinking -> respawn while pages boot)`);
  ok(sA.roster.length === 3 && sB.roster.length === 3 && sA.rosterKinds.includes('bot') && sB.rosterKinds.includes('bot'), `the bot is in both rosters (A ${sA.rosterKinds.join('/')}, B ${sB.rosterKinds.join('/')})`);

  // ── 2. A: flat -> holding pose -> held; wrap -> throw -> B catches ───────
  console.log('\n[2] A holds, throws; B predicts, claims, catches');
  await A.evaluate("(async () => { const g = await import('/sdk/core/game-physics.js'); window.__JOINT_RADII = g.JOINT_RADII; })()");
  await A.evaluate(GEN);
  // a FRESH, confirmed rest on A's floor (nudge, land, 300 ms still) so BallNet's 8 s rest-to-gutter respawn cannot fire under the hold test
  await A.evaluate(() => { const b = __twin.game.ball, rect = __twin.game.tileWorldRect(__twin.S.me.seat); b.sphere.pos.set((rect.x0 + rect.x1) / 2, b.pos.y + 0.15, -2.0); b.sphere.vel.set(0, 0, 0); b.mesh.position.copy(b.sphere.pos); b.mesh.updateMatrixWorld(true); });
  await sleep(400);
  await A.waitForFunction(() => { const g = __twin.game, b = g.ball; const rest = g.phase === 'floor' && __twin.net.isOwner && !__twin.net.inTransit && b.vel.length() < 0.05; if (!rest) { window.__restAt = 0; return false; } if (!window.__restAt) { window.__restAt = performance.now(); return false; } return performance.now() - window.__restAt > 300; }, { timeout: 25000, polling: 50 }).catch(() => {});
  const hold = await A.evaluate(() => new Promise(resolve => {
    const me = __twin.S.me.clientId, ball = __twin.game.ball, r = ball.sphere.radius;
    const B0 = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, py = ball.floorY + 0.25;
    const out = { flatRel: null, flatMin: Infinity, cradleAt: null, phaseHeld: null, wireHold: null, log: [], B0, py, r, launches0: __twin.net.stats.launches, owner0: __twin.net.owner };
    let f = 0, stage = 'flat', done = false;
    ball.sphere.pos.set(B0.x, py + r + 0.2, B0.z); ball.sphere.vel.set(0, 0, 0); ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
    const finish = () => { done = true; __twin.beforeFrame = null; delete __twin.ovPacks[me]; __twin.pause(false); resolve(out); };
    __twin.pause(true);
    const tick = () => { if (done) return; __twin.step(1 / 60); setTimeout(tick, 16); };
    setTimeout(tick, 0);
    __twin.beforeFrame = () => {
      f++;
      if (f <= 2 || f % 10 === 0) out.log.push([f, stage, +(ball.pos.y - (py + r)).toFixed(3), +(ball.pos.x - B0.x).toFixed(2), +(ball.pos.z - B0.z).toFixed(2), __twin.game.phase, __twin.net.owner, __twin.net.inTransit ? 1 : 0, __twin.net.stats.launches, ball.cradle, ball.hold ? ball.hold.type : null]);
      if (stage === 'flat') {                                            // a flat shelf under a dropped ball: support only
        __twin.ovPacks[me] = { L: null, R: __gen.PackGen.flat(B0.x, py, B0.z) };
        out.flatMin = Math.min(out.flatMin, ball.pos.y - (py + r));
        if (out.flatRel === null && f > 5 && Math.abs(ball.vel.y) < 0.05 && ball.pos.y < py + r + 0.03) { out.flatRel = ball.pos.y - (py + r); out.flatAt = f; }   // landed: the shelf stopped the fall
        if (f === 36) { out.flatEnd = ball.pos.y - (py + r); out.flatHeld = !!(ball.hold || ball.cradle); stage = 'cup'; ball.sphere.pos.set(B0.x, py + r + 0.1, B0.z); ball.sphere.vel.set(0, 0, 0); }
        return;
      }
      if (stage === 'cup') {                                             // the holding pose: cradle = held
        __twin.ovPacks[me] = { L: null, R: __gen.cupHand(B0.x, py, B0.z) };
        if (ball.cradle && !out.cradleAt) { out.cradleAt = f; out.phaseHeld = __twin.game.phase; }
        if (out.cradleAt && f > out.cradleAt + 5) { out.phaseHeld = __twin.game.phase; stage = 'done'; finish(); }
        else if (f > 200) finish();
      }
    };
  }));
  console.log('    hold log [f, stage, rel, dx, dz, phase, owner, transit, launches, cradle, hold]:', JSON.stringify(hold.log), 'B0', JSON.stringify(hold.B0), 'owner0', hold.owner0, 'launches0', hold.launches0);
  ok(hold.flatRel !== null && hold.flatRel >= -0.006 && hold.flatMin >= -0.02 && !hold.flatHeld, `A flat shelf stops the dropped ball: landed at palm + r ${r3(hold.flatRel * 1000)} mm (frame ${hold.flatAt}; ${r3(hold.flatEnd * 1000)} mm at frame 36; min ${r3(hold.flatMin * 1000)} mm, never through), not possessed`);
  ok(hold.cradleAt > 0 && hold.phaseHeld === 'held', `A holding pose -> cradle in ${hold.cradleAt} frames, game phase '${hold.phaseHeld}'`);
  const heldOnB = await B.evaluate(() => { const s = __twin.game.snapshot(); return { phase: s.phase, owner: s.owner }; });
  console.log(`    B mirrors: phase ${heldOnB.phase}, owner ${heldOnB.owner}`);
  // let the ball settle back on A's floor, then THROW: wrap, lift 0.6 m, carry +x 1.5 m/s (+0.3 up) for 20 frames, open
  await A.waitForFunction(() => __twin.game.phase === 'floor' && __twin.net.isOwner && __twin.game.ball.vel.length() < 0.05, { timeout: 15000, polling: 100 }).catch(() => {});
  await B.evaluate(() => { window.__pred = { n: 0, predictedN: 0, maxLead: -1, firstLead: null, rings: 0 }; __twin.beforeFrame = () => { const p = __twin.game.predictor.read(__twin.clock.now()); if (!p) return; window.__pred.n++; if (p.predicted) { window.__pred.predictedN++; if (window.__pred.firstLead === null) window.__pred.firstLead = p.leadMs; window.__pred.maxLead = Math.max(window.__pred.maxLead, p.leadMs); } }; });
  const claims0 = await B.evaluate(() => __twin.events.filter(e => e.ev === 'claim' && e.d && e.d.mine === true).length);
  const thrown = await A.evaluate(() => {
    const ball = __twin.game.ball, rect = __twin.game.tileWorldRect(__twin.S.me.seat), U = 1.8652;
    return __throw({ at: { x: rect.x1 - 1.0, y: rect.floorY + 0.4 * U }, liftSpeed: 1.0, v: { x: 1.5, y: 2.5 }, frames: 12, stepDt: 1 / 120 });
  });
  ok(thrown.reason === 'ok' && thrown.grabbed > 0 && thrown.released && !thrown.released.held, `A: wrap in ${thrown.grabbed} frames, lifted by ${thrown.lifted}, carried 12 frames at (1.5, 2.5) m/s, open -> released (${thrown.reason}); vel ${JSON.stringify(thrown.released && thrown.released.vel)} m/s, phase ${thrown.released && thrown.released.phase}`);
  // B catches: wait for B's claim (mine) event
  await B.waitForFunction((n0) => __twin.events.filter(e => e.ev === 'claim' && e.d && e.d.mine === true).length > n0, { timeout: 8000, polling: 100 }, claims0).catch(() => {});
  const pred = await B.evaluate(() => { __twin.beforeFrame = null; return window.__pred; });
  await sleep(300);
  const la = await A.evaluate(() => ({ launches: __twin.net.stats.launches, last: __twin.net.lastLaunch && { to: __twin.net.lastLaunch.to, tEdgeEff: __twin.net.lastLaunch.tEdgeEff, from: __twin.net.lastLaunch.from, edge: __twin.net.lastLaunch.edge, x: __twin.net.lastLaunch.x, y: __twin.net.lastLaunch.y, vx: __twin.net.lastLaunch.vx }, inTransit: __twin.net.inTransit, isOwner: __twin.net.isOwner, phase: __twin.game.phase }));
  const lb = await B.evaluate(() => {
    const cl = __twin.events.filter(e => e.ev === 'claim' && e.d && e.d.mine === true); const claim = cl[cl.length - 1];
    const b = __twin.game.ball, rect = __twin.game.tileWorldRect(__twin.S.me.seat);
    return { launchesSeen: __twin.events.filter(e => e.ev === 'launch').length, lastLaunch: __twin.net.lastLaunch && { to: __twin.net.lastLaunch.to, from: __twin.net.lastLaunch.from }, claim: claim && { t: claim.t, tState: claim.d.tState, reason: claim.d.reason }, isOwner: __twin.net.isOwner, inTransit: __twin.net.inTransit, phase: __twin.game.phase,
      ball: { x: b.pos.x, y: b.pos.y, vx: b.vel.x, visible: b.mesh.visible }, rect, inside: b.pos.x >= rect.x0 && b.pos.x <= rect.x1 && b.pos.y >= rect.y0 - 0.01 && b.pos.y <= rect.y1, rings: __twin.events.filter(e => e.ev === 'ring').map(e => e.d && e.d.kind), polite: document.getElementById('live-polite').textContent };
  });
  ok(la.launches === 1 && lb.launchesSeen >= 1 && lb.lastLaunch && lb.lastLaunch.to === 1 && la.last && la.last.to === 1, `LAUNCH: A net.stats.launches = ${la.launches}; B saw it (${lb.launchesSeen} launch event(s), lastLaunch ${JSON.stringify(lb.lastLaunch)}); to seat ${la.last && la.last.to}, edge ${la.last && la.last.edge}, tEdgeEff ${la.last && la.last.tEdgeEff}`);
  ok(pred.maxLead >= 300 && pred.predictedN > 0, `B's predictor showed leadMs >= 300 before the LAUNCH (dashed ring): first lead ${r3(pred.firstLead)} ms, max ${r3(pred.maxLead)} ms over ${pred.predictedN} predicted frames (${pred.n} frames with a prediction)`);
  ok(lb.claim && la.last && lb.claim.t <= la.last.tEdgeEff + 250 && lb.claim.t >= la.last.tEdgeEff - 50, `B onBecameOwner at session t ${lb.claim && lb.claim.t} within tEdgeEff ${la.last && la.last.tEdgeEff} + 250 ms (delta ${lb.claim && la.last ? lb.claim.t - la.last.tEdgeEff : '?'} ms, reason ${lb.claim && lb.claim.reason})`);
  ok(lb.isOwner && lb.inside && lb.ball.vx > 0, `B owns the ball inside B's tile (x ${r3(lb.ball.x)} in [${r3(lb.rect.x0)}, ${r3(lb.rect.x1)}], y ${r3(lb.ball.y)}) with vel.x ${r3(lb.ball.vx)} > 0; phase ${lb.phase}`);
  ok(!la.inTransit && !la.isOwner, `A afterwards: inTransit ${la.inTransit}, isOwner ${la.isOwner}, phase ${la.phase}`);
  let oneOwner = 0, samplesN = 0, bad = [];
  for (let i = 0; i < 60; i++) { const [oa, ob] = await owners(A, B); const n = (oa.me ? 1 : 0) + (ob.me ? 1 : 0) + oa.bot.filter(Boolean).length; samplesN++; if (n === 1) oneOwner++; else bad.push({ i, oa, ob }); await sleep(50); }
  ok(oneOwner === samplesN, `exactly one in-tile owner at every 50 ms sample over 3 s (${oneOwner}/${samplesN})`, bad.length ? JSON.stringify(bad.slice(0, 2)) : '');
  await A.screenshot({ path: `${SHOT_DIR}/twinpass-A-after-catch.png` }); await B.screenshot({ path: `${SHOT_DIR}/twinpass-B-after-catch.png` });

  // ── 3. designate_goal from A's agent ─────────────────────────────────────
  console.log('\n[3] designate_goal via the agent');
  const dg = await A.evaluate(async () => { const r = await __twin.agent.cmd.command('make B the goal'); return { status: r.status, source: r.source, actions: r.actions.map(a => ({ name: a.name, input: a.input, ok: a.result && a.result.ok, reason: a.result && a.result.reason })), say: r.say }; });
  await sleep(400);
  sA = await state(A); sB = await state(B);
  ok(dg.actions.some(a => a.name === 'designate_goal' && a.ok) && sA.seatMap.goal === 1 && sB.seatMap.goal === 1, `"make B the goal" -> ${JSON.stringify(dg.actions)} -> seatMap.goal A=${sA.seatMap.goal}, B=${sB.seatMap.goal} (v A ${sA.seatMap.v}, B ${sB.seatMap.v})`);

  // ── 4. throw into the ring (B's hands empty) → GOAL on both ──────────────
  console.log('\n[4] goal');
  // the ball is B's: B passes it back to A (the agent tool path, a THROW by fiat), A catches it on the floor
  const back = await B.evaluate(() => __twin.game.passToward(0));
  await A.waitForFunction(() => __twin.net.isOwner && !__twin.net.inTransit && __twin.game.phase === 'floor' && __twin.game.ball.vel.length() < 0.05, { timeout: 15000, polling: 100 }).catch(() => {});
  const gotBack = await A.evaluate(() => ({ isOwner: __twin.net.isOwner, phase: __twin.game.phase, x: __twin.game.ball.pos.x }));
  ok(back.ok && gotBack.isOwner && gotBack.phase === 'floor', `B passToward(0) ${JSON.stringify(back)} -> A owns it again (phase ${gotBack.phase})`);
  const goalThrow = await A.evaluate(() => {
    const ball = __twin.game.ball, rect = __twin.game.tileWorldRect(__twin.S.me.seat);
    // release just inside the right edge at 0.8 tile heights with (1.8, 0.6) u/s -> enters B at ~0.88 u and passes the goal ring (centre, y0 + 0.35 u, r 0.25 u);
    // driven at dt = 1/120 s so the wrap survives the 3.4 m/s carry (the lane's follow lerp lags 0.67 x step; the 3 cm skin allows ~3 cm steps)
    const U = 1.8652;
    return __throw({ at: { x: rect.x1 - 0.45, y: rect.floorY + 0.8 * U }, liftSpeed: 1.2, v: { x: 1.8 * U, y: 0.6 * U }, frames: 8, stepDt: 1 / 120 });
  });
  await Promise.all([
    A.waitForFunction(() => __twin.events.some(e => e.ev === 'goal'), { timeout: 8000, polling: 100 }).catch(() => {}),
    B.waitForFunction(() => __twin.events.some(e => e.ev === 'goal'), { timeout: 8000, polling: 100 }).catch(() => {}),
  ]);
  const traj = await B.evaluate(() => new Promise(res => { const out = []; const t0 = performance.now(); const iv = setInterval(() => { const b = __twin.game.ball, c = __twin.game._courtPos ? (() => { try { return __twin.game._courtPos(__twin.S.me.seat); } catch { return null; } })() : null; out.push([Math.round(performance.now() - t0), +b.pos.x.toFixed(2), +b.pos.y.toFixed(2), __twin.game.phase, __twin.net.isOwner ? 1 : 0, c && +c.x.toFixed(2), c && +c.y.toFixed(2)]); if (performance.now() - t0 > 1500) { clearInterval(iv); res(out); } }, 100); }));
  console.log('    B ball after the throw [ms, x, y, phase, owner, court x, court y]:', JSON.stringify(traj.filter((_, i) => i % 2 === 0)));
  const gA = await A.evaluate(() => ({ goals: __twin.events.filter(e => e.ev === 'goal').map(e => e.d), score: __twin.game.score.slice(), polite: document.getElementById('live-polite').textContent, assertive: document.getElementById('live-assertive').textContent, sb: document.getElementById('scoreboard').textContent, phase: __twin.game.phase, launches: __twin.net.stats.launches }));
  const gB = await B.evaluate(() => ({ goals: __twin.events.filter(e => e.ev === 'goal').map(e => e.d), score: __twin.game.score.slice(), polite: document.getElementById('live-polite').textContent, assertive: document.getElementById('live-assertive').textContent, sb: document.getElementById('scoreboard').textContent, phase: __twin.game.phase, ball: { x: __twin.game.ball.pos.x, y: __twin.game.ball.pos.y } }));
  ok(goalThrow.reason === 'ok' && goalThrow.released && !goalThrow.released.held, `A goal throw: ${goalThrow.reason}, release vel ${JSON.stringify(goalThrow.released && goalThrow.released.vel)}, A launches ${gA.launches}`);
  ok(gA.goals.length >= 1 && gB.goals.length >= 1 && !gA.goals[0].potato, `GOAL on both: A ${JSON.stringify(gA.goals[0])}, B ${JSON.stringify(gB.goals[0])}`);
  ok(gA.score[0] === 1 && gB.score[0] === 1, `score[0] === 1 on both (A ${JSON.stringify(gA.score)}, B ${JSON.stringify(gB.score)}); scoreboard A "${gA.sb}"`);
  ok(/GOAL/i.test(gA.assertive + gA.polite) && /GOAL/i.test(gB.assertive + gB.polite), `live regions announce on both: A "${gA.assertive || gA.polite}", B "${gB.assertive || gB.polite}"`);
  await A.screenshot({ path: `${SHOT_DIR}/twinpass-A-goal.png` }); await B.screenshot({ path: `${SHOT_DIR}/twinpass-B-goal.png` });

  // ── 5. hot potato → fuse on both, no goal ring ───────────────────────────
  console.log('\n[5] hot potato');
  await A.waitForFunction(() => __twin.net.owner >= 0 && !__twin.net.inTransit, { timeout: 8000, polling: 100 }).catch(() => {});
  await A.bringToFront();
  await A.click('input[name=mode][value=potato]');
  await Promise.all([
    A.waitForFunction(() => __twin.game.mode === 'potato' && __twin.S.seatMap.mode === 'potato', { timeout: 5000, polling: 100 }).catch(() => {}),
    B.waitForFunction(() => __twin.game.mode === 'potato' && __twin.S.seatMap.mode === 'potato', { timeout: 5000, polling: 100 }).catch(() => {}),
  ]);
  await sleep(600);
  const pA = await A.evaluate(() => ({ mode: __twin.game.mode, potato: __twin.game.potato && { remain: __twin.game.potato.untilMs - __twin.clock.now(), seat: __twin.game.potato.ownerSeat }, goal: __twin.S.seatMap.goal, owner: __twin.net.owner, chip: [...__twin.ui.tiles.values()].map(t => t.state.chip).filter(Boolean), ring: [...__twin.ui.tiles.values()].map(t => t.state.ring).filter(Boolean) }));
  const pB = await B.evaluate(() => ({ mode: __twin.game.mode, potato: __twin.game.potato && { remain: __twin.game.potato.untilMs - __twin.clock.now(), seat: __twin.game.potato.ownerSeat }, goal: __twin.S.seatMap.goal, owner: __twin.net.owner, chip: [...__twin.ui.tiles.values()].map(t => t.state.chip).filter(Boolean), ring: [...__twin.ui.tiles.values()].map(t => t.state.ring).filter(Boolean), goalTiles: [...__twin.ui.tiles.values()].filter(t => t.state.goal).length }));
  ok(pA.mode === 'potato' && pB.mode === 'potato', `mode potato on both (A ${pA.mode}, B ${pB.mode}); owner A ${pA.owner} / B ${pB.owner}`);
  ok(pA.potato && pB.potato && pA.potato.remain > 0 && pB.potato.remain > 0 && Math.abs(pA.potato.remain - pB.potato.remain) < 500, `fuse on both: A ${pA.potato && Math.round(pA.potato.remain)} ms, B ${pB.potato && Math.round(pB.potato.remain)} ms (seat ${pA.potato && pA.potato.seat}); chips A ${JSON.stringify(pA.chip)}, B ${JSON.stringify(pB.chip)}`);
  ok(pA.goal === -1 && pB.goal === -1 && pB.goalTiles === 0, `no goal ring: seatMap.goal A ${pA.goal}, B ${pB.goal}; goal-marked tiles on B ${pB.goalTiles}`);

  // ── 6. the bot claims within 20 s: pass toward its seat ──────────────────
  console.log('\n[6] bot');
  // a hand throw toward A's LEFT edge (ring wrap: seat 0's left neighbour is the last seat = the bot); passToward() from the tile centre
  // rolls out on floor friction before the edge (BallGame's 1.6 u/s at 12 deg is a short pass, T4)
  await A.waitForFunction(() => __twin.net.isOwner && !__twin.net.inTransit && !__twin.game.ball.hold && __twin.game.phase === 'floor' && __twin.game.ball.vel.length() < 0.05, { timeout: 15000, polling: 100 }).catch(() => {});
  const passBot = await A.evaluate(async () => {
    const rect = __twin.game.tileWorldRect(__twin.S.me.seat), U = 1.8652;
    const r = await __throw({ at: { x: rect.x0 + 0.85, y: rect.floorY + 0.55 * U }, liftSpeed: 1.0, v: { x: -1.5, y: 0.3 }, frames: 10, stepDt: 1 / 60 });
    return { pass: { ok: r.reason === 'ok', reason: r.reason, vel: r.released && r.released.vel }, owner: __twin.net.owner, seat: __twin.S.me.seat };
  });
  const trace6 = await A.evaluate(() => new Promise(res => { const out = []; const t0 = performance.now(); const iv = setInterval(() => { const b = __twin.S.bots[0].bot; let c = null; try { c = __twin.game._courtPos(__twin.net.simSeat); } catch {} out.push([Math.round(performance.now() - t0), __twin.game.phase, __twin.net.owner, __twin.net.inTransit ? 1 : 0, __twin.net.stats.launches, c && +c.x.toFixed(2), c && +c.y.toFixed(2), b.net.owner, b.net.seat, b.seated ? 1 : 0, b.stats.claims, b.net.lastLaunch && b.net.lastLaunch.to]); if (performance.now() - t0 > 2500) { clearInterval(iv); res(out); } }, 250); }));
  console.log('    A after passToward(2) [ms, phase, owner, transit, launches, court x, y | bot owner, seat, seated, claims, lastLaunch.to]:', JSON.stringify(trace6));
  await A.waitForFunction(() => __twin.S.bots[0] && __twin.S.bots[0].bot.stats.claims >= 1, { timeout: 20000, polling: 100 }).catch(() => {});
  const botA = await A.evaluate(() => ({ stats: __twin.S.bots[0].bot.stats, seat: __twin.S.bots[0].bot.seat, owner: __twin.net.owner, inRosterA: __twin.S.roster.some(p => p.kind === 'bot') }));
  const botB = await B.evaluate(() => ({ inRosterB: __twin.S.roster.some(p => p.kind === 'bot'), tile: !!document.querySelector('.tile--bot'), owner: __twin.net.owner, ageMs: (() => { const t = [...__twin.tiles.values()].find(t => t.kind === 'bot'); return t && Math.round(t.ageMs); })() }));
  ok(botA.inRosterA && botB.inRosterB && botB.tile, `the bot is in both rosters and has a tile on B (age ${botB.ageMs} ms)`);
  ok(passBot.pass.ok && botA.stats.claims >= 1, `throw toward the bot's edge ${JSON.stringify(passBot.pass)} -> bot.stats.claims = ${botA.stats.claims} >= 1 (bot seat ${botA.seat}; owner now A ${botA.owner} / B ${botB.owner}); bot stats ${JSON.stringify(botA.stats)}`);

  // ── wrap-up ─────────────────────────────────────────────────────────────
  const all = [...logs.A.map(l => 'A ' + l), ...logs.B.map(l => 'B ' + l)];
  ok(all.length === 0, `no console errors beyond the filter on either page (${all.length})`, all.slice(0, 4).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('PROBE ERROR', e);
  console.log(`\n${pass} passed, ${fail + 1} failed (probe error)`);
  const all = [...logs.A.map(l => 'A ' + l), ...logs.B.map(l => 'B ' + l)];
  if (all.length) console.log('[console]', all.slice(0, 12).join('\n'));
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}
process.exit(exitCode);
