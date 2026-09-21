/**
 * _twinprobe.mjs — headless probe for T6 (teamslab.html page assembly). BUILD-PLAN T6 acceptance, one page:
 *   teamslab.html?auto=1&fixedstep=1&consent=1&transport=loopback&tiles=3&clone=1&bot=1&agent=local&nosfx=1
 *   (1) 4 tiles laid by rule B in seat order, rects == fixed169(stageW, stageH, 4)
 *   (2) stage.contexts() === 4 (renderer + 3 hand landmarkers), info().calls > 0
 *   (3) over 5 s of AUTOTEST lines: p50 scriptMs < 45, fps >= 25 under fixedstep
 *   (4) hud.remote[bot] < 100 ms, the bot tile's rigR.mesh.visible, local tiles packs.hands.length === 0 (fake camera), no console errors beyond the filter
 *   (5) the remote tile's HandViews is distinct from the local tile's
 *   (6) doctrine via ovPacks[me]: open over the ball 30 frames -> held === null, |dy| < 1 mm; wrap -> held within 10 frames (wrap|clip);
 *       open -> released that frame; flat under -> support (y >= palm.y + r - 3 mm); holding pose -> cradle
 *   (7) occlusion: after the wrap pose the conform delta at a contact joint > 0 (rig.pose(pack, [ball.collider]))
 *   (8) agent.cmd.command('give me an apple in my hand') with an open right pack -> props.size === 1, prop within r + 0.01 of the palm, source 'local', mesh.parent === stage.scene
 *   (9) keyboard: K, arrows, Space -> ovPacks[me].R present and the ball picked up by wrap (KeyboardSource -> PackGen.cup -> _wrapGrab)
 *   (10) a11y: #live-polite changed after the pickup; --tw-motion === '0' under --force-prefers-reduced-motion; every .tile has aria-label
 *   (11) [G1] btnDeviceOnly -> transport.stats.sent stops increasing, suppressed increases, agent mode 'local'
 *   (12) screenshots at the six rectangles
 *   (14) v2 integration: the ball is the B2 tennis mesh (name 'tennisBall', felt map) at the B1 default radius 0.06 m (court.R derived),
 *        one shelf.js group per seat on the ONE stage (game.shelfOf(seat) in stage.scene, visible), the B7 hand-state chip on my tile
 *        follows game.handState ('Holding · wrap' while the wrap pack holds, hidden with no hand), BallFx + the glow sprite on the stage
 *   (13) --body (T9): the page boots with &body=1 -> stage.contexts() === 5 (one pose landmarker on the local tile), a synthetic
 *        37-point pose through the S.ovBody seam (REST_BODY lying on its back, chest under the ball) supports the ball: y stable
 *        +/- 3 mm over 60 frames, never inside the body, never grabbed; pose gone -> body absent, ball back on the floor;
 *        script p50 (section 3) still < 45 ms with the pose landmarker running
 * Run from the repo root: node tests/_twinprobe.mjs [--body]   (reuses :3333 when it serves teamslab.html, else spawns tools/dev-server.mjs)
 * Synthetic hands: PackGen (sdk/game/pack-gen.js) + the r-parametrised `around` / `cupHand` generators of tests/ball-game-smoke.mjs
 * (the keyboard hand closes with the page's r-aware gripPack — the same around() geometry — round the nearest ball within reach).
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
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1280,800'];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh|Autoplay|GPU stall|WebGL warning|TensorFlow|INFO: Created TensorFlow|GL_INVALID|OpenGL ES|Overriding|deprecated/i;
const BODY = process.argv.includes('--body');                         // T9: &body=1 + section (13)
const QUERY = (process.env.TWIN_QUERY || 'auto=1&fixedstep=1&consent=1&transport=loopback&tiles=3&clone=1&bot=1&agent=local&nosfx=1') + (BODY ? '&body=1' : '');

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
const URL_ = `http://localhost:${PORT}/teamslab.html?${QUERY}`;

// ── synthetic hands (mirrors tests/ball-game-smoke.mjs; evaluated inside the page) ───────────────────────────
const GEN = `
const V = (x, y, z) => ({ x, y, z });
const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
/** palm joints on +z of the ball; fingers on -z (wrapping) or curled away — a doctrine-true WRAP (ball-game-smoke.mjs) */
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
/** fingers leave the far side (palm joints STAY touching) = open hand -> release */
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
const PackGen = window.__twin.PackGen;
window.__gen = { V, mk, around, opened, cupHand, PackGen };
`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const logs = [], autotest = [];
let exitCode = 1;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('console', m => {
    const t = m.type(), text = m.text();
    if (text.startsWith('AUTOTEST ')) { try { autotest.push(JSON.parse(text.slice(9))); } catch { /* ignore */ } return; }
    if ((t === 'error' || t === 'warning') && !FILTER.test(text)) logs.push(`[${t}] ${text.slice(0, 300)}`);
  });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => { if (!FILTER.test(r.url())) logs.push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`); });

  console.log(`\n[boot] ${URL_}`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 120000 });
  const boot = await page.evaluate(() => ({ error: __twin.S.boot.error, stage: __twin.S.boot.stage, consentOk: __twin.S.boot.consentOk, me: __twin.S.me.clientId }));
  ok(!boot.error && boot.stage === 'loop', `booted: stage=${boot.stage} error=${boot.error} me=${boot.me}`);
  // wait for the seat map with all 4 seats + the first AUTOTEST lines
  await page.waitForFunction(() => window.__twin.S.seatMap && window.__twin.S.seatMap.seats.length === 4 && window.__twin.frames > 30, { timeout: 30000 }).catch(() => {});
  await sleep(500);

  // ── (1) layout ───────────────────────────────────────────────────────────
  console.log('\n[1] gallery layout (rule B, seat order)');
  const lay = await page.evaluate(() => {
    const ui = __twin.ui, f = __twin.fixed169, g = ui.el.gallery, st = ui.el.stage;
    const W = g.clientWidth, H = g.clientHeight, exp = f(ui.tiles.size, W, H, ui._layout.gap);
    const rects = [...ui.rects()].map(([id, r]) => ({ id, x: r.x, y: r.y, w: r.width, h: r.height }));
    const dom = [...g.querySelectorAll('.tile')].map(el => ({ id: el.dataset.client, seat: +el.dataset.seat, kind: el.dataset.kind }));
    const seats = __twin.S.seatMap ? __twin.S.seatMap.seats.map(s => s.clientId) : [];
    return { n: ui.tiles.size, W, H, stageW: st.clientWidth, stageH: st.clientHeight, exp, rects, dom, seats, v: __twin.S.seatMap && __twin.S.seatMap.v, kinds: [...ui.tiles.values()].map(t => t.kind) };
  });
  ok(lay.n === 4, `4 tiles (got ${lay.n}: ${lay.kinds.join(', ')})`);
  ok(lay.rects.every(r => Math.abs(r.w - lay.exp.tw) < 0.51 && Math.abs(r.h - lay.exp.th) < 0.51), `tile sizes = fixed169(${lay.W}x${lay.H}, 4) = ${lay.exp.tw}x${lay.exp.th} (${lay.exp.cols}x${lay.exp.rows})`, JSON.stringify(lay.rects.map(r => [r.w, r.h])));
  ok(lay.dom.every((d, i) => d.seat === i) && lay.dom.map(d => d.id).join() === lay.seats.join(), `DOM order = seat order = seat map v${lay.v}: ${lay.dom.map(d => d.kind + ':' + d.seat).join(' ')}`);

  // ── (2) contexts / render ───────────────────────────────────────────────
  console.log('\n[2] surface');
  const st = await page.evaluate(() => ({ contexts: __twin.stage.contexts(), calls: __twin.stage.info().calls, tris: __twin.stage.info().triangles, pipes: [...__twin.tiles.values()].filter(t => t.pipe && t.pipe.ready).length, canvas: [__twin.stage.canvas.width, __twin.stage.canvas.height], surface: document.getElementById('surface') === __twin.stage.canvas }));
  const CTX = BODY ? 5 : 4;
  ok(st.contexts === CTX && st.pipes === 3, `stage.contexts() === ${CTX} (renderer + 3 hand landmarkers${BODY ? ' + 1 pose landmarker' : ''}): got ${st.contexts}, ready pipes ${st.pipes}`);
  ok(st.calls > 0 && st.surface, `render calls ${st.calls}, triangles ${st.tris}, canvas ${st.canvas.join('x')} is #surface`);

  // ── (3) budget over 5 s ─────────────────────────────────────────────────
  console.log('\n[3] budget (5 s of AUTOTEST under fixedstep)');
  const n0 = autotest.length;
  await sleep(5200);
  const lines = autotest.slice(n0);
  const p50 = arr => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
  const scriptP50 = p50(lines.map(l => l.scriptMs)), fpsP50 = p50(lines.map(l => l.fps)), detP50 = p50(lines.map(l => l.detectMs));
  ok(lines.length >= 4 && scriptP50 < 45, `AUTOTEST lines ${lines.length}: script p50 ${r3(scriptP50)} ms (< 45), detect p50 ${r3(detP50)} ms`);
  ok(fpsP50 >= 25, `fps p50 ${r3(fpsP50)} >= 25`);
  console.log('    last line:', JSON.stringify(lines[lines.length - 1]).slice(0, 300));

  // ── (4) remote bot / local packs / console ─────────────────────────────
  console.log('\n[4] bot tile, local packs, console');
  const rb = await page.evaluate(() => {
    const bot = [...__twin.tiles.values()].find(t => t.kind === 'bot'), me = __twin.tiles.get(__twin.S.me.clientId);
    const locals = [...__twin.tiles.values()].filter(t => t.local);
    const hud = __twin.hud.toJSON();
    return { botId: bot && bot.clientId, age: bot && hud.remote[bot.clientId] && hud.remote[bot.clientId].ageMs, hz: bot && hud.remote[bot.clientId] && hud.remote[bot.clientId].hz,
      rigVisible: !!(bot && bot.remote && bot.remote.rigR.mesh.visible), grpVisible: !!(bot && bot.remote && (bot.remote.rigR.grp.visible || bot.remote.rigL.grp.visible)), botHands: bot ? bot.packs.hands.length : -1,
      localHands: locals.map(t => t.packs.hands.length), botStats: __twin.S.bots.map(b => b.bot.stats), botSeat: bot && bot.seat, remoteSeats: __twin.remote.list() };
  });
  ok(rb.botId && rb.age < 100, `hud.remote[bot] age ${r3(rb.age)} ms < 100 (${rb.hz} pkt/s, seat ${rb.botSeat}, remote seats ${JSON.stringify(rb.remoteSeats)})`);
  ok(rb.rigVisible && rb.botHands === 1, `bot tile rigR.mesh.visible (${rb.rigVisible}), grp visible ${rb.grpVisible}, packs.hands ${rb.botHands}`);
  ok(rb.localHands.every(n => n === 0), `local tiles packs.hands.length === 0 under the fake camera: ${JSON.stringify(rb.localHands)}`);
  ok(logs.length === 0, `no console errors beyond the filter (${logs.length})`, logs.slice(0, 5).join(' | '));

  // ── (5) distinct HandViews ─────────────────────────────────────────────
  console.log('\n[5] chirality authority per tile');
  const hv = await page.evaluate(() => { const me = __twin.tiles.get(__twin.S.me.clientId), bot = [...__twin.tiles.values()].find(t => t.kind === 'bot'); const clones = [...__twin.tiles.values()].filter(t => t.kind === 'clone'); return { distinct: !!(me.pipe && bot.remote && me.pipe.views !== bot.remote.views), cloneDistinct: clones.every(c => c.pipe && c.pipe.views !== me.pipe.views), n: new Set([...__twin.tiles.values()].map(t => (t.pipe || t.remote).views)).size }; });
  ok(hv.distinct && hv.cloneDistinct && hv.n === 4, `remote tile views !== local tile views; ${hv.n} distinct HandViews for 4 tiles`);

  // ── (6) doctrine via ovPacks[me] ───────────────────────────────────────
  console.log('\n[6] doctrine through S.ovPacks[me] (probe seam = production chain)');
  await page.evaluate(() => { window.__twin.PackGen = null; });
  await page.evaluate(`(async () => { const m = await import('/sdk/game/pack-gen.js'); window.__twin.PackGen = m.PackGen; const g = await import('/sdk/core/game-physics.js'); window.__JOINT_RADII = g.JOINT_RADII; })()`);
  await page.evaluate(GEN);
  // the game ball: host kickoff at my seat → it falls to my floor; wait for rest
  await page.waitForFunction(() => { const b = __twin.game.ball; return __twin.game.running && b.mesh.visible && __twin.net.isOwner && __twin.game.phase === 'floor'; }, { timeout: 20000 }).catch(() => {});
  const g0 = await page.evaluate(() => { const b = __twin.game.ball, s = b.snapshot(); return { phase: __twin.game.phase, owner: __twin.net.owner, isOwner: __twin.net.isOwner, pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, r: b.sphere.radius, floorY: b.floorY, held: s.held, R: __twin.court.R, mySeat: __twin.S.me.seat }; });
  ok(g0.isOwner && g0.phase === 'floor' && !g0.held, `ball at rest on my floor: phase ${g0.phase}, owner ${g0.owner} (me seat ${g0.mySeat}), y ${r3(g0.pos.y)} = floor ${r3(g0.floorY)} + r ${r3(g0.r)} (court R ${r3(g0.R)} u)`);
  // ── (14) v2 integration: tennis mesh, 0.06 m, shelves on the one stage, hand-state chip, fx ──
  console.log('\n[14] v2 integration (B1 shelf + radius, B2 tennis ball + fx, B7 hand-state chip)');
  const v2 = await page.evaluate(() => {
    const g = __twin.game, b = g.ball, me = __twin.S.me.seat, sh = g.shelfOf(me), scene = __twin.stage.scene;
    const mat = b.mesh.material;
    const chip = document.querySelector(`.tile[data-client="${__twin.S.me.clientId}"] .tile__handstate`);
    const shelfLine = document.querySelector(`.tile[data-client="${__twin.S.me.clientId}"] .tile__shelf`);
    const fx = __twin.S.ballFx;
    return { name: b.mesh.name, hasMap: !!(mat && mat.map), matcap: !!(mat && mat.matcap), kind: b.mesh.userData && b.mesh.userData.kind, r: b.sphere.radius, radiusM: g.radiusM, R: __twin.court.R, RxU: __twin.court.R * 1.8652,
      shelves: g.shelves.size, seats: __twin.court.map.seats.length, shelfInScene: !!(sh && sh.parent === scene), shelfVisible: !!(sh && sh.visible), shelfY: sh && sh.y, floorY: b.floorY, shelfFrac: g.shelfFrac,
      shelfLine: !!shelfLine && !shelfLine.hidden, chipEl: !!chip, chipHidden: chip ? chip.hidden : null, fxInScene: !!(fx && fx.group.parent === scene), glow: !!scene.getObjectByName('ballGlow'), slider: document.getElementById('ballSize') && document.getElementById('ballSize').value };
  });
  ok(v2.name === 'tennisBall' && v2.hasMap && v2.matcap && v2.kind === 'tennis', `[B2] ball mesh is the tennis ball (name ${v2.name}, kind ${v2.kind}, felt map ${v2.hasMap}, matcap ${v2.matcap}) — no blue sphere`);
  ok(Math.abs(v2.r - 0.06) < 1e-6 && Math.abs(v2.radiusM - 0.06) < 1e-6 && Math.abs(v2.RxU - 0.06) < 1e-3, `[B1] radius 0.06 m by default (sphere ${r3(v2.r)}, game.radiusM ${r3(v2.radiusM)}, court.R ${r3(v2.R)} u = ${r3(v2.RxU)} m); slider ${v2.slider}`);
  ok(v2.shelves === v2.seats && v2.shelfInScene && v2.shelfVisible && Math.abs(v2.shelfY - v2.floorY) < 1e-6, `[B1] ${v2.shelves} shelf group(s) for ${v2.seats} seats on the ONE stage; my shelf y ${r3(v2.shelfY)} = ball floorY ${r3(v2.floorY)} (shelf ${v2.shelfFrac}); guide line shown ${v2.shelfLine}`);
  ok(v2.chipEl && v2.chipHidden === true && v2.fxInScene && v2.glow, `[B7] hand-state chip present and hidden with no hand (${v2.chipEl}/${v2.chipHidden}); [B2] BallFx group + glow sprite on the stage (${v2.fxInScene}/${v2.glow})`);
  await page.evaluate(() => __twin.pause(true));
  const stepN = (n, dt = 1 / 60) => page.evaluate(({ n, dt }) => { for (let i = 0; i < n; i++) __twin.step(dt); }, { n, dt });
  const me = boot.me;
  // (a) OPEN hand hovering over the ball for 30 frames: never grabs, never lifts
  await page.evaluate(({ me }) => { const b = __twin.game.ball.pos; __twin.ovPacks[me] = { L: null, R: __gen.PackGen.open(b.x + 0.02, b.y + 0.05, b.z + 0.3) }; }, { me });
  await stepN(30);
  const oh = await page.evaluate(({ me, y0 }) => { const b = __twin.game.ball; return { held: b.hold, cradle: b.cradle, dy: b.pos.y - y0, hands: __twin.tiles.get(me).packs.hands.length, rigPosed: !!__twin.tiles.get(me).pipe.rigR.mesh.visible }; }, { me, y0: g0.pos.y });
  ok(oh.held === null && oh.cradle === null && Math.abs(oh.dy) < 0.001, `[D2] open hover 30 frames: held ${oh.held}, cradle ${oh.cradle}, |dy| ${r3(Math.abs(oh.dy) * 1000)} mm < 1 (tile packs.hands ${oh.hands})`);
  // (b) WRAP: the r-parametrised `around` hand → held within 10 frames, holdType wrap|clip
  const wr = await page.evaluate(({ me }) => {
    const ball = __twin.game.ball, B = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, r = ball.sphere.radius;
    __twin.ovPacks[me] = { L: null, R: __gen.around(B, r, 1, true) };
    let frames = -1;
    for (let i = 0; i < 10; i++) { __twin.step(1 / 60); if (ball.hold) { frames = i + 1; break; } }
    return { frames, holdType: ball.hold && ball.hold.type, slot: ball.hold && ball.hold.slot, phase: __twin.game.phase, snap: ball.snapshot().holdType };
  }, { me });
  ok(wr.frames > 0 && ['wrap', 'clip'].includes(wr.holdType), `[D2] wrap pack -> held in ${wr.frames} frame(s), holdType ${wr.holdType} (slot ${wr.slot}), phase ${wr.phase}`);
  await stepN(6);                                                       // the chip is refreshed every 6 frames
  const hsChip = await page.evaluate(() => { const el = document.querySelector(`.tile[data-client="${__twin.S.me.clientId}"] .tile__handstate`); return { hidden: el.hidden, state: el.dataset.state, text: el.querySelector('.tile__handstate-text').textContent, ui: __twin.ui.handState(__twin.S.me.clientId) }; });
  ok(!hsChip.hidden && /^holding/.test(hsChip.state), `[B7] hand-state chip while held: "${hsChip.text}" (data-state ${hsChip.state}, ui ${JSON.stringify(hsChip.ui && hsChip.ui.hands)})`);
  // (7) occlusion: the rig conforms to the ball collider at a contact joint
  const occ = await page.evaluate(({ me }) => {
    const t = __twin.tiles.get(me), rig = t.pipe.rigR, pack = __twin.ovPacks[me].R, col = __twin.game.ball.collider;
    const T = window.__twin.THREE;
    const raw = (i) => new T.Vector3(pack[i].x, pack[i].y, pack[i].z);
    rig.pose(pack, null); rig.mesh.updateMatrixWorld(true);
    const pa = rig.mesh.geometry.getAttribute('position'); const n = pa.count;
    // nearest vertex to the fingertip (joint 12, a contact joint of `around`) before and after conform
    const near = (p) => { let best = Infinity, idx = -1; for (let i = 0; i < n; i++) { const v = new T.Vector3().fromBufferAttribute(pa, i).applyMatrix4(rig.mesh.matrixWorld); const d = v.distanceToSquared(p); if (d < best) { best = d; idx = i; } } return idx; };
    const tip = raw(12), idx = near(tip);
    const before = new T.Vector3().fromBufferAttribute(pa, idx).applyMatrix4(rig.mesh.matrixWorld);
    rig.pose(pack, [col]); rig.mesh.updateMatrixWorld(true);
    const pb = rig.mesh.geometry.getAttribute('position');
    const after = new T.Vector3().fromBufferAttribute(pb, idx).applyMatrix4(rig.mesh.matrixWorld);
    const delta = before.distanceTo(after);
    const uniforms = rig.uniforms ? Object.keys(rig.uniforms).filter(k => /col|occl|conform/i.test(k)) : [];
    return { delta, colActive: col.active, colR: col.radius, distTip: tip.distanceTo(new T.Vector3(col.center.x, col.center.y, col.center.z)), occluder: !!(rig.occluder || rig.grp.children.length > 1), uniforms, verts: n };
  }, { me });
  ok(occ.delta > 0 || occ.uniforms.length > 0, `[7] conform: rig.pose(pack, [ball.collider]) moved the vertex nearest the contact fingertip by ${r3(occ.delta * 1000)} mm (collider r ${r3(occ.colR)}, tip-centre ${r3(occ.distTip)}, occluder twin ${occ.occluder}, conform uniforms ${occ.uniforms.join('/') || '-'})`);
  // (c) OPEN → released THAT frame
  const rel = await page.evaluate(({ me }) => {
    const ball = __twin.game.ball; const pack = __twin.ovPacks[me].R;
    __twin.ovPacks[me] = { L: null, R: __gen.opened(pack) };
    __twin.step(1 / 60);
    return { held: ball.hold, phase: __twin.game.phase, vel: { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z } };
  }, { me });
  ok(rel.held === null, `[D3] open hand -> hold === null that frame (phase ${rel.phase}, vel ${r3(rel.vel.x)},${r3(rel.vel.y)},${r3(rel.vel.z)})`);
  await page.evaluate(({ me }) => { delete __twin.ovPacks[me]; }, { me });
  await stepN(90);
  // (d) FLAT palm under a falling ball: support, never below the palm [D5] (pack re-delivered every frame: hand-stop mutates it)
  const fl = await page.evaluate(({ me }) => {
    const ball = __twin.game.ball, r = ball.sphere.radius, B = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z };
    const py = ball.floorY + 0.35;
    ball.sphere.pos.set(B.x, py + r + 0.25, B.z); ball.sphere.vel.set(0, 0, 0); ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
    let minY = Infinity, minRel = Infinity;
    for (let i = 0; i < 120; i++) {
      __twin.ovPacks[me] = { L: null, R: __gen.PackGen.flat(B.x, py, B.z) };   // k = 2.2 (workspace scale), as ball-game-smoke (d)
      __twin.step(1 / 60);
      const rel = ball.pos.y - (py + r); minY = Math.min(minY, ball.pos.y); minRel = Math.min(minRel, rel);
    }
    return { y: ball.pos.y, py, r, rel: ball.pos.y - (py + r), minRel, cradle: ball.cradle, held: ball.hold, seek: ball.seek };
  }, { me });
  ok(fl.rel >= -0.006 && fl.minRel >= -0.02 && fl.y > fl.py && !fl.held, `[D5] flat palm under a ball dropped 0.25 m: rests at palm.y + r ${r3(fl.rel * 1000)} mm (>= -6 mm = the lane's contact skin; min ${r3(fl.minRel * 1000)} mm >= -20), never below the palm, not possessed (cradle ${fl.cradle}, hold ${fl.held})`);
  // (e) HOLDING POSE → cradle (PackGen.flat has closure 0, so the holding pose is the measured cupHand — T4)
  const cr = await page.evaluate(({ me }) => {
    const ball = __twin.game.ball, r = ball.sphere.radius, B = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z };
    const py = ball.floorY + 0.3;
    ball.sphere.pos.set(B.x, py + r + 0.12, B.z); ball.sphere.vel.set(0, 0, 0); ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
    let frames = -1;
    for (let i = 0; i < 120; i++) { __twin.ovPacks[me] = { L: null, R: __gen.cupHand(B.x, py, B.z) }; __twin.step(1 / 60); if (ball.cradle) { frames = i + 1; break; } }
    const P = ball._pose.right;
    return { frames, cradle: ball.cradle, y: ball.pos.y, py, r, pose: P && P.pose, ny: P && P.n.y, closure: P && P.closure, phase: __twin.game.phase };
  }, { me });
  ok(cr.frames > 0 && cr.cradle === 'right' && cr.y >= cr.py + cr.r - 0.003, `[D2] holding pose -> cradle in ${cr.frames} frames (pose ${cr.pose}, n.y ${r3(cr.ny)}, closure ${r3(cr.closure)}), y ${r3(cr.y)} >= palm ${r3(cr.py)} + r - 3 mm; phase ${cr.phase}`);
  const politeAfterPickup = await page.evaluate(() => document.getElementById('live-polite').textContent);
  await page.evaluate(({ me }) => { delete __twin.ovPacks[me]; }, { me });
  await stepN(60);
  await page.screenshot({ path: `${SHOT_DIR}/twin-6-doctrine.png` });

  // ── (8) agent: local grammar → SceneExecutor spawn in my open right hand ──
  console.log('\n[8] command agent (local) -> apple in my hand');
  const ag = await page.evaluate(async ({ me }) => {
    const rect = __twin.game.tileWorldRect(__twin.S.me.seat);
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
    __twin.ovPacks[me] = { L: null, R: __gen.PackGen.open(cx + 0.25, cy + 0.1, -2.0) };
    for (let i = 0; i < 5; i++) __twin.step(1 / 60);
    const t = __twin.tiles.get(me);
    const r = await __twin.agent.cmd.command('give me an apple in my hand');
    const props = [...__twin.S.props.values()], p = props[0];
    const T = __twin.THREE;
    let dist = null, r_ = null, parentOk = null, gravity = null, attach = null, distAfter = null;
    if (p) {
      const { measurePalm } = await import('/sdk/game/scene-executor.js');
      const M = measurePalm(__twin.ovPacks[me].R, {});
      const pc = new T.Vector3(M.pc.x, M.pc.y, M.pc.z);
      dist = p.ball.pos.distanceTo(pc); r_ = p.ball.sphere.radius; parentOk = p.ball.mesh.parent === __twin.stage.scene; gravity = p.ball.sphere.gravity;
      for (let i = 0; i < 30; i++) __twin.step(1 / 60);
      distAfter = p.ball.pos.distanceTo(pc);
    }
    return { status: r.status, source: r.source, actions: r.actions.map(a => a.name + ':' + JSON.stringify(a.input || a.args || {})).slice(0, 3), say: r.say, size: __twin.S.props.size, dist, distAfter, r: r_, parentOk, gravity, openness: t.handR.openness, present: t.handR.present, ok: r.actions[0] && r.actions[0].result && r.actions[0].result.ok, res: r.actions[0] && r.actions[0].result };
  }, { me });
  ok(ag.size === 1 && ag.source === 'local', `props.size === 1 (${ag.size}), source '${ag.source}', status ${ag.status}: ${ag.actions.join(' ; ')}`);
  ok(ag.dist !== null && Math.abs(ag.dist - (ag.r + 0.01)) <= 0.003, `apple seated at r + 0.01 (+/- 3 mm) from the measured palm centre: ${r3(ag.dist)} <= ${r3(ag.r + 0.01)} (openness ${r3(ag.openness)}, attach ${JSON.stringify(ag.res && ag.res.attach)}); 30 frames later ${r3(ag.distAfter)} (gravity + pocket pull, hand supports)`);
  ok(ag.parentOk === true && ag.gravity < 0, `[D8] mesh.parent === stage.scene, gravity ${r3(ag.gravity)} < 0 [D4]`);
  await page.evaluate(({ me }) => { delete __twin.ovPacks[me]; }, { me });
  await stepN(30);
  await page.screenshot({ path: `${SHOT_DIR}/twin-8-apple.png` });
  await page.evaluate(() => __twin.agent.exec.exec('remove_object', { target: 'all' }));

  // ── (9) keyboard hand: K, arrows, Space → ovPacks[me].R, wrap pickup ────
  console.log('\n[9] keyboard hand through the doctrine');
  // put the ball back at rest on my floor; the keyboard hand advertises a hand span → court R follows it (seat map v+1)
  await page.evaluate(() => { const b = __twin.game.ball; b.recenter(); b.sphere.vel.set(0, 0, 0); __twin.pause(false); });
  await page.bringToFront();
  await page.keyboard.press('KeyK');
  await sleep(100);
  const kb0 = await page.evaluate(({ me }) => ({ active: __twin.kb.state.active, ov: !!(__twin.ovPacks[me] && __twin.ovPacks[me].R), shape: __twin.kb.shape, uiKb: __twin.ui.kbActive, lastKey: __twin.lastKey && __twin.lastKey.action }), { me });
  ok(kb0.active && kb0.ov && kb0.uiKb, `K -> keyboard hand active (${kb0.active}), ovPacks[me].R present (${kb0.ov}), shape ${kb0.shape}, TwinUI.kbActive ${kb0.uiKb}, lastKey ${kb0.lastKey}`);
  // the hand appears at the tile centre — move it aside (real arrow keys, loop running) before dropping the ball, or the ball lands on its palm
  await page.keyboard.down('ArrowLeft'); await sleep(600); await page.keyboard.up('ArrowLeft');
  await page.evaluate(() => { const b = __twin.game.ball; b.recenter(); b.sphere.vel.set(0, 0, 0); });
  // wait for the seat map to carry the advertised span and the ball to rest
  await page.waitForFunction(() => { const s = __twin.S.seatMap && __twin.S.seatMap.seats.find(x => x.clientId === __twin.S.me.clientId); return s && s.handSpan > 0 && Math.abs(__twin.game.ball.sphere.radius - __twin.court.R * 1.8652) < 0.002; }, { timeout: 8000 }).catch(() => {});
  // a CONFIRMED rest (300 ms on the floor, owner, not in transit): BallNet's 8 s rest-to-gutter timer runs on real time, so a paused probe can resume into a respawn
  await page.waitForFunction(() => { const g = __twin.game, b = g.ball; const rest = g.phase === 'floor' && __twin.net.isOwner && !__twin.net.inTransit && b.vel.length() < 0.05; if (!rest) { window.__restAt = 0; return false; } if (!window.__restAt) { window.__restAt = performance.now(); return false; } return performance.now() - window.__restAt > 300; }, { timeout: 25000, polling: 50 }).catch(() => {});
  await page.evaluate(() => __twin.pause(true));
  const kb1 = await page.evaluate(() => { const b = __twin.game.ball; const s = __twin.S.seatMap.seats.find(x => x.clientId === __twin.S.me.clientId); return { r: b.sphere.radius, R: __twin.court.R, span: s && s.handSpan, phase: __twin.game.phase, ball: { x: b.pos.x, y: b.pos.y, z: b.pos.z }, hand: { x: __twin.kb.state.x, y: __twin.kb.state.y } }; });
  console.log(`    court R ${r3(kb1.R)} u (span ${r3(kb1.span)}) -> ball r ${r3(kb1.r)} m; ball at ${r3(kb1.ball.x)},${r3(kb1.ball.y)}; hand at ${r3(kb1.hand.x)},${r3(kb1.hand.y)}; phase ${kb1.phase}`);
  // drive the hand with ARROW KEYS: UP over the ball first (an open flat hand sweeping through it at its own height honestly shoves it
  // away — hands never pass through), across, then straight down beside it to the pickup pocket (dx = +0.04, dy = -0.01); then Space:
  // the keyboard hand reaches for the nearest hull within a hand's width, the r-aware wrap closes round it (page gripPack = ball-game-smoke's
  // around()) and _wrapGrab holds; real key events, real KeyboardSource integration at 0.6 m/s
  const target = { x: kb1.ball.x + 0.04, y: kb1.ball.y - 0.01 }, over = kb1.ball.y + 0.22;
  const drive = async (key, frames) => { await page.keyboard.down(key); await stepN(frames); await page.keyboard.up(key); };
  const framesFor = (d) => Math.round(Math.abs(d) / (0.6 / 60));
  const dx = target.x - kb1.hand.x;
  await drive('ArrowUp', framesFor(over - kb1.hand.y));
  await drive(dx > 0 ? 'ArrowRight' : 'ArrowLeft', framesFor(dx));
  await drive('ArrowDown', framesFor(over - target.y));
  const kb2 = await page.evaluate(() => ({ hand: { x: __twin.kb.state.x, y: __twin.kb.state.y }, ball: { x: __twin.game.ball.pos.x, y: __twin.game.ball.pos.y, z: __twin.game.ball.pos.z }, held: __twin.game.ball.hold }));
  ok(Math.abs(kb2.hand.x - target.x) < 0.02 && Math.abs(kb2.hand.y - target.y) < 0.02, `arrows moved the hand to ${r3(kb2.hand.x)},${r3(kb2.hand.y)} (target ${r3(target.x)},${r3(target.y)}); ball free (${kb2.held === null}) at ${r3(kb2.ball.x)},${r3(kb2.ball.y)},${r3(kb2.ball.z)} (offset ${r3(kb2.hand.x - kb2.ball.x)},${r3(kb2.hand.y - kb2.ball.y)})`);
  await page.keyboard.down('Space');
  const kb3 = await page.evaluate(() => { const b = __twin.game.ball; let frames = -1; for (let i = 0; i < 12; i++) { __twin.step(1 / 60); if (b.hold) { frames = i + 1; break; } } const ov = __twin.ovPacks[__twin.S.me.clientId]; return { frames, holdType: b.hold && b.hold.type, snap: b.snapshot().holdType, shape: __twin.kb.shape, closed: __twin.kb.state.closed, y: b.pos.y, packZ: ov && ov.R && ov.R[9].z, ballZ: b.pos.z, ovR: !!(ov && ov.R), gripR: __twin.snapshot().kb.gripR, r: b.sphere.radius }; });
  ok(kb3.frames > 0 && ['wrap', 'clip'].includes(kb3.holdType) && kb3.ovR, `[K1] Space held -> grip pack (ovPacks[me].R, palm z ${r3(kb3.packZ)} latched ${r3(kb3.packZ - kb3.ballZ)} in front of the ball, grip r ${r3(kb3.gripR)} = ball r ${r3(kb3.r)}) -> picked up by ${kb3.holdType} in ${kb3.frames} frame(s) (KeyboardSource shape ${kb3.shape}, closed ${kb3.closed}), never a teleport`);
  // lift + release
  await drive('ArrowUp', 20);
  const lifted = await page.evaluate(() => ({ y: __twin.game.ball.pos.y, held: !!__twin.game.ball.hold }));
  await page.keyboard.up('Space');
  const kb4 = await page.evaluate(() => { __twin.step(1 / 60); const b = __twin.game.ball; const s1 = __twin.kb.shape; __twin.step(1 / 60); return { held: b.hold, shapeAfter: s1, shapeNow: __twin.kb.shape, y: b.pos.y }; });
  ok(lifted.held && lifted.y > kb3.y + 0.05 && kb4.held === null, `carried up ${r3((lifted.y - kb3.y) * 1000)} mm while held; Space up -> open (${kb4.shapeAfter}) -> released (hold ${kb4.held}), then ${kb4.shapeNow}`);
  await page.screenshot({ path: `${SHOT_DIR}/twin-9-keyboard.png` });
  await page.keyboard.press('KeyK');
  await stepN(5);

  // ── (10) a11y ───────────────────────────────────────────────────────────
  console.log('\n[10] accessibility');
  const a11y = await page.evaluate(() => ({
    polite: document.getElementById('live-polite').textContent, tilesLabelled: [...document.querySelectorAll('.tile')].every(el => (el.getAttribute('aria-label') || '').length > 0),
    labels: [...document.querySelectorAll('.tile')].map(el => el.getAttribute('aria-label')), motion: getComputedStyle(document.querySelector('.tw-frame')).getPropertyValue('--tw-motion').trim(),
    btns: [...document.querySelectorAll('#controlbar button')].every(b => { const r = b.getBoundingClientRect(); return r.width >= 32 && r.height >= 32; }),
    hscroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }));
  ok(politeAfterPickup.length > 0 && a11y.polite.length > 0, `[A1] #live-polite changed after the pickup: "${politeAfterPickup}" → now "${a11y.polite}"`);
  ok(a11y.tilesLabelled, `[A2] every .tile has aria-label: ${a11y.labels.map(l => JSON.stringify(l)).join(', ')}`);
  ok(a11y.btns && a11y.hscroll, `[A2] control-bar buttons >= 32x32 (${a11y.btns}), no horizontal scroll (${a11y.hscroll}); --tw-motion "${a11y.motion}" (normal)`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await sleep(100);
  const motion = await page.evaluate(() => ({ v: getComputedStyle(document.querySelector('.tw-frame')).getPropertyValue('--tw-motion').trim(), ui: __twin.ui.reducedMotion, S: __twin.S.a11y.reducedMotion }));
  ok(motion.v === '0' && motion.ui === true, `[A2] --tw-motion === '0' under prefers-reduced-motion: reduce (ui.reducedMotion ${motion.ui}, S.a11y ${motion.S})`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // ── (11) [G1] device-only gates the transport and the agent ────────────
  console.log('\n[11] on-device only (C4)');
  await page.evaluate(() => __twin.pause(false));
  const g1a = await page.evaluate(() => ({ ...__twin.transport.stats }));
  await sleep(600);
  const g1b = await page.evaluate(() => ({ ...__twin.transport.stats }));
  ok(g1b.sent > g1a.sent, `sharing: transport.stats.sent grows (${g1a.sent} -> ${g1b.sent})`);
  await page.click('#btnDeviceOnly');
  await sleep(150);
  const g1c = await page.evaluate(() => ({ ...__twin.transport.stats, mode: __twin.agent.cmd.mode, share: __twin.S.me.shareMode, pressed: document.getElementById('btnDeviceOnly').getAttribute('aria-pressed'), pill: __twin.ui.tiles.get(__twin.S.me.clientId).state.pill, ptt: document.getElementById('btnPtt').disabled }));
  await sleep(1000);
  const g1d = await page.evaluate(() => ({ ...__twin.transport.stats }));
  ok(g1d.sent === g1c.sent && g1d.suppressed > g1c.suppressed, `[G1] device-only: sent frozen at ${g1d.sent}, suppressed ${g1c.suppressed} -> ${g1d.suppressed}`);
  ok(g1c.mode === 'local' && g1c.share === 'device-only' && g1c.pressed === 'true' && g1c.pill === 'device-only' && g1c.ptt === true, `agent mode '${g1c.mode}', shareMode '${g1c.share}', button pressed ${g1c.pressed}, pill '${g1c.pill}', PTT disabled ${g1c.ptt}`);
  await page.click('#btnDeviceOnly');
  await sleep(300);
  const g1e = await page.evaluate(() => ({ mode: __twin.agent.cmd.mode, share: __twin.S.me.shareMode, sent: __twin.transport.stats.sent, urlAgent: __twin.S.url.agent }));
  ok(g1e.share === 'share' && g1e.mode === g1e.urlAgent && g1e.sent > g1d.sent, `back to sharing: agent mode '${g1e.mode}' (= ?agent=${g1e.urlAgent}), sent ${g1e.sent}`);

  // ── (12) screenshots at the six rectangles ─────────────────────────────
  console.log('\n[12] six rectangles');
  const RECTS = [[1280, 800], [994, 678], [1100, 620], [800, 600], [640, 480], [472, 382]];
  for (const [w, h] of RECTS) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await sleep(350);
    const r = await page.evaluate(() => { const ui = __twin.ui, g = ui.el.gallery; const exp = __twin.fixed169(ui.tiles.size, g.clientWidth, g.clientHeight, ui._layout.gap); const rects = [...ui.rects().values()]; return { exp: [exp.tw, exp.th], got: rects.map(x => [Math.round(x.width), Math.round(x.height)]), stage: [__twin.stage.stageW, __twin.stage.stageH], canvas: [__twin.stage.canvas.width, __twin.stage.canvas.height], hs: document.documentElement.scrollWidth <= document.documentElement.clientWidth, calls: __twin.stage.info().calls }; });
    await page.screenshot({ path: `${SHOT_DIR}/twin-12-${w}x${h}.png` });
    ok(r.got.every(x => Math.abs(x[0] - r.exp[0]) <= 1 && Math.abs(x[1] - r.exp[1]) <= 1) && r.hs && r.calls > 0, `${w}x${h}: tiles ${r.exp.join('x')} (stage ${r.stage.join('x')}, canvas ${r.canvas.join('x')}, calls ${r.calls}, no h-scroll ${r.hs})`);
  }
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  // ── (13) --body: T9 body layer through the S.ovBody seam ───────────────
  if (BODY) {
    console.log('\n[13] body layer (T9): &body=1, S.ovBody seam, [D7] body support');
    await sleep(400);
    const b0 = await page.evaluate(() => {
      const me = __twin.tiles.get(__twin.S.me.clientId), L = __twin.body, st = __twin.bodyStats && __twin.bodyStats();
      const cb = document.querySelector('input[data-layer=body]');
      // the re-created pipe's rigs: hidden while no hand is tracked (rig.pose(null)), shown again the frame a pack arrives
      __twin.pause(true);
      const b = __twin.game.ball.pos;
      __twin.ovPacks[__twin.S.me.clientId] = { L: null, R: __gen.PackGen.open(b.x + 0.3, b.y + 0.4, b.z + 0.3) };
      __twin.step(1 / 60);
      const rigShown = !!(me.pipe && me.pipe.rigR && me.pipe.rigR.grp.visible && me.pipe.rigR.mesh.visible);
      __twin.ovPacks[__twin.S.me.clientId] = null; __twin.step(1 / 60);
      __twin.pause(false);
      return { has: !!L, ready: !!(L && L.ready), layerOn: !!__twin.S.layers.body, box: !!(cb && cb.checked),
        withPose: !!(me && me.pipe && me.pipe.opts && me.pipe.opts.withPose), poseLM: !!(me && me.pipe && me.pipe.pipe && me.pipe.pipe.poseLM), recreated: !!(L && L.recreated),
        contexts: __twin.stage.contexts(), rig: !!(L && L.rig && L.rig.mesh), rigLayer: L && L.rig ? L.rig.grp.layers.mask : -1, tileLayer: me ? (1 << me.layer) : -1,
        frames: st ? st.frames : -1, source: st ? st.source : null, present: st ? st.present : null, poseMs: st ? st.poseMs : null,
        rigShown, handsLayer: __twin.S.layers.hands, handL: !!(me && me.pipe && me.handL === me.pipe.handL) };
    });
    ok(b0.has && b0.ready && b0.layerOn && b0.box && b0.withPose && b0.poseLM && b0.contexts === 5, `?body=1 -> __twin.body ready (${b0.ready}), layer on (${b0.layerOn}, box ${b0.box}), tile.pipe re-created with withPose (${b0.withPose}, poseLM ${b0.poseLM}, recreated ${b0.recreated}), contexts ${b0.contexts} === 5`);
    ok(b0.rig && b0.rigLayer === b0.tileLayer && b0.frames > 0 && b0.rigShown && b0.handsLayer && b0.handL, `body rig forged on the local tile's layer (mask ${b0.rigLayer} = ${b0.tileLayer}), ${b0.frames} body ticks, tracker pose under the fake camera: present ${b0.present}, source ${b0.source} (MediaPipe pose can hallucinate a person on the test pattern; not asserted), pose ${r3(b0.poseMs)} ms, the re-created pipe's holohand still renders a pack (${b0.rigShown}, layer ${b0.handsLayer}), HandBodies re-pointed (${b0.handL})`);
    // synthetic 37-point pose (world space of my tile): a person LYING ON THE BACK along x (a proper rotation of REST_BODY: rest x,y,z ->
    // world z,x,y; head toward +x, front facing up) so the chest (34) is the top surface under the ball's column; the arms are raised
    // beside the ball (elbows at +/- z) with the forearms toward the head (+x) and the knees drawn up (-x): body-sphere BUMPERS a few cm
    // off the ball so the balance on the chest sphere is a basin, not a ridge — nothing but the chest touches at rest. The same
    // construction as tests/prop-ball-smoke.mjs [D7] (which needs no bumpers: a Node lane has no relayout jitter).
    await page.evaluate("(async () => { const m = await import('/sdk/core/body-forge.js'); window.__REST_BODY = m.REST_BODY; })()");
    await page.evaluate(() => {
      window.__lyingCradle = (chest) => {
        const R = __REST_BODY, C = R[34];
        const P = R.map(p => ({ x: chest.x + (p[1] - C[1]), y: chest.y + (p[2] - C[2]), z: chest.z + (p[0] - C[0]) }));
        const set = (i, dx, dy, dz) => { P[i] = { x: chest.x + dx, y: chest.y + dy, z: chest.z + dz }; };
        for (const s of [-1, 1]) {                                     // s = -1: person's left (lm 13/15/…), +1: right (14/16/…)
          const e = s < 0 ? 13 : 14, w = s < 0 ? 15 : 16, pk = s < 0 ? 17 : 18, ix = s < 0 ? 19 : 20, th = s < 0 ? 21 : 22, k = s < 0 ? 25 : 26, a = s < 0 ? 27 : 28, h = s < 0 ? 29 : 30, t = s < 0 ? 31 : 32;
          set(e, 0.0, 0.266, s * 0.233);                               // elbow beside the ball at its height (5 cm off its surface)
          set(w, 0.2, 0.266, s * 0.12);                                // wrist in front of the ball (toward the head)
          set(pk, 0.26, 0.266, s * 0.10); set(ix, 0.26, 0.266, s * 0.06); set(th, 0.22, 0.266, s * 0.03);
          set(k, -0.2, 0.25, s * 0.10);                                // knee drawn up behind the ball (toward the hips)
          set(a, -0.3, 0.0, s * 0.12); set(h, -0.34, -0.03, s * 0.12); set(t, -0.24, -0.04, s * 0.12);
        }
        return P;
      };
    });
    await page.evaluate(() => { __twin.ovPacks[__twin.S.me.clientId] = null; __twin.pause(true); });
    const bd = await page.evaluate(() => {
      const ball = __twin.game.ball, r = ball.sphere.radius;
      const chest = { x: ball.pos.x, y: ball.floorY + 0.45, z: ball.pos.z };
      __twin.S.ovBody = __lyingCradle(chest);
      __twin.step(1 / 60); __twin.step(1 / 60);                                             // the body is posed + present before the ball is placed
      const L = __twin.body, B = L.body, Rc = B.radii[34], contactY = chest.y + Rc + r;
      ball.sphere.pos.set(chest.x, contactY + 0.2, chest.z); ball.sphere.vel.set(0, 0, 0); ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
      const gaps = () => { ball.mesh.updateWorldMatrix(true, false); ball.hull.begin(ball.mesh); const g = []; for (let i = 0; i < B.joints.length; i++) g.push(ball.hull.surfaceDistance(B.joints[i]) - B.radii[i]); return g; };
      let minGap = Infinity; const ys = [];
      for (let i = 0; i < 180; i++) { __twin.step(1 / 60); const g = Math.min(...gaps()); if (g < minGap) minGap = g; if (i >= 120) ys.push(ball.pos.y); }
      const gr = gaps(), touching = []; gr.forEach((g, i) => { if (g < 0.006) touching.push(i); });
      const j = B.joints[34];
      const bd = { present: B.present, source: L.source, posed: !!L.posed, rigVisible: L.rig.grp.visible, scale: B.scale, Rc, r, contactY, nJoints: B.joints.length,
        y: ball.pos.y, rest: ball.pos.y - contactY, spread: Math.max(...ys) - Math.min(...ys), minGap, gapRest: Math.min(...gr), touching, chestGap: gr[34], hold: ball.hold, cradle: ball.cradle, phase: __twin.game.phase,
        chestUnder: { dx: j.x - ball.pos.x, dz: j.z - ball.pos.z, below: ball.pos.y - j.y }, floorY: ball.floorY, bodies: __twin.bodyStats().bodies, contexts: __twin.stage.contexts() };
      // pose gone (same evaluate: the hold is wall-clock, and a puppeteer round trip on a 4-tile page can itself take > dropMs): the last
      // pose is HELD for dropMs (900 ms of no pose), then the body is absent, the rig hidden and gravity takes the ball back to the floor
      __twin.S.ovBody = null;
      const me = __twin.tiles.get(__twin.S.me.clientId); me.pipe.opts.withPose = false;   // the tracker's pose is gated off for this step (the fake camera can hallucinate one)
      const y0 = ball.pos.y, sinceSeen0 = performance.now() - L.seen, src0 = L.source;
      let goneAt = -1, goneMs = -1, heldFrames = 0;
      const tA = performance.now();
      for (let i = 0; i < 150; i++) { __twin.step(1 / 60); if (goneAt < 0) { if (!L.body.present) { goneAt = i; goneMs = performance.now() - tA; } else heldFrames++; } }
      me.pipe.opts.withPose = true; __twin.pause(false);
      bd.bg = { goneAt, goneMs, heldFrames, sinceSeen0, src0, stepsMs: performance.now() - tA, present: L.body.present, rigVisible: L.rig.grp.visible, source: L.source, fell: y0 - ball.pos.y, y: ball.pos.y, floorY: ball.floorY, r: ball.sphere.radius, bodies: __twin.bodyStats().bodies };
      return bd;
    });
    const chestUnder = Math.abs(bd.chestUnder.dx) < 0.06 && Math.abs(bd.chestUnder.dz) < 0.06 && bd.chestUnder.below >= 0.9 * (bd.Rc + bd.r) && bd.chestGap < 0.006;
    ok(bd.present && bd.source === 'override' && bd.posed && bd.rigVisible && chestUnder && bd.nJoints === 47, `S.ovBody -> body present (source ${bd.source}, scale ${r3(bd.scale)}, ${bd.nJoints} colliders), rig visible (${bd.rigVisible}); the chest capsule (R ${r3(bd.Rc)}) is under the ball and touching: dx ${r3(bd.chestUnder.dx * 1000)} mm, dz ${r3(bd.chestUnder.dz * 1000)} mm, ${r3(bd.chestUnder.below)} m below the centre, gap ${r3(bd.chestGap * 1000)} mm; touching joints ${JSON.stringify(bd.touching)}; extraBodies ${bd.bodies}`);
    ok(bd.rest >= -0.006 && bd.rest <= 0.01 && bd.spread <= 0.006 && bd.minGap >= -0.02 && bd.gapRest >= -0.006 && !bd.hold && !bd.cradle, `[D7] the ball rests ON the body: y - (chest + R_chest + r) ${r3(bd.rest * 1000)} mm (>= -6 = the lane's skin), stable ${r3(bd.spread * 1000)} mm over 60 frames (+/- 3), never inside (min gap ${r3(bd.minGap * 1000)} mm >= -20 during the 20 cm drop, ${r3(bd.gapRest * 1000)} mm at rest), never grabbed (hold ${JSON.stringify(bd.hold)}, cradle ${bd.cradle}), y ${r3(bd.y)} = floor ${r3(bd.floorY)} + ${r3(bd.y - bd.floorY)}, phase ${bd.phase}`);
    const bg = bd.bg;
    ok(bg.goneAt > 0 && bg.heldFrames > 0 && bg.goneMs + bg.sinceSeen0 >= 850 && bg.goneMs <= 2500 && !bg.present && !bg.rigVisible && bg.bodies === 0 && bg.fell > 0.3, `ovBody = null -> the last pose is HELD for ${bg.heldFrames} frames, then absent after ${r3(bg.goneMs)} ms of wall time (dropMs 900; ${r3(bg.stepsMs / 150)} ms/step, ${r3(bg.sinceSeen0)} ms since the last live pose at the clear, source ${bg.src0} -> ${bg.source}), rig hidden (${!bg.rigVisible}), extraBodies ${bg.bodies}; the ball fell ${r3(bg.fell)} m (y ${r3(bg.y)}, floor + r ${r3(bg.floorY + bg.r)})`);
    await page.screenshot({ path: `${SHOT_DIR}/twin-13-body.png` });
  }

  // ── wrap-up ─────────────────────────────────────────────────────────────
  const snap = await page.evaluate(() => __twin.snapshot());
  console.log('\n[snapshot]', JSON.stringify({ me: snap.me.clientId, seat: snap.me.seat, host: snap.me.isHost, mode: snap.mode, phase: snap.phase, roster: snap.roster.length, seatMap: snap.seatMap && snap.seatMap.v, R: snap.court && r3(snap.court.R), bots: snap.bots, contexts: snap.contexts, fps: r3(snap.fps), frames: snap.frames, net: { launches: snap.net.launches, claims: snap.net.claims, conflicts: snap.net.conflicts } }));
  if (logs.length) console.log('\n[console]', logs.slice(0, 12).join('\n'));
  ok(logs.length === 0, `console clean at the end (${logs.length} entries)`, logs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('PROBE ERROR', e);
  console.log(`\n${pass} passed, ${fail + 1} failed (probe error)`);
  if (logs.length) console.log('[console]', logs.slice(0, 12).join('\n'));
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}
process.exit(exitCode);
