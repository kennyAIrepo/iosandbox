// B3 join-flow probe: page A opens a /join-style link (room + local relay) -> pre-join screen -> Join now -> consent (auto) -> meeting;
// page B joins the same room with ?auto=1; A's chip shows Connected · 2; the invite row / dialog exist. Hard timeout.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1280,800'];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh|Autoplay|GPU stall|WebGL warning|TensorFlow|INFO: Created TensorFlow|GL_INVALID|OpenGL ES|Overriding|deprecated/i;
const ROOM = 'QWERT', RELAY = 'ws://localhost:8787';
const base = `http://localhost:3333/teamslab.html?room=${ROOM}&relay=${RELAY}&consent=1&fixedstep=1&agent=local&nosfx=1`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
setTimeout(() => { console.error('HARD TIMEOUT'); process.exit(2); }, 120000);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const logs = [];
try {
  const A = await browser.newPage(); await A.setViewport({ width: 1280, height: 800 });
  A.on('pageerror', e => logs.push('[A PAGEERROR] ' + e.message)); A.on('console', m => { if ((m.type() === 'error') && !FILTER.test(m.text())) logs.push('[A] ' + m.text().slice(0, 200)); });
  await A.goto(base, { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.__twin && window.__twin.S && window.__twin.S.boot.stage === 'prejoin', { timeout: 30000 });
  const pj = await A.evaluate(() => { const el = document.getElementById('prejoin'); return { shown: !!el && !el.hidden, room: document.getElementById('joinRoom').value, chip: document.querySelector('.conn-chip') && document.querySelector('.conn-chip').dataset.state, consentOpen: document.getElementById('consent').open, url: __twin.S.url.transport + ' ' + __twin.S.url.relay + ' ' + __twin.S.url.room }; });
  ok(pj.shown && pj.room === 'QWERT' && !pj.consentOpen, `pre-join screen shown for the link (room ${pj.room}, chip ${pj.chip}, consent not yet open) — ${pj.url}`);
  await A.screenshot({ path: `${SHOT_DIR}/int-prejoin.png` });
  await A.type('#joinName', 'Ada');
  await A.click('#btnJoinNow');
  await A.waitForFunction(() => window.__twin.ready === true, { timeout: 90000 });
  await sleep(1500);
  const a1 = await A.evaluate(() => ({ name: __twin.S.me.name, tile: document.querySelector('.tile .tile__name').textContent, prejoinHidden: document.getElementById('prejoin').hidden, chip: document.querySelector('#topbar .conn-chip') && { state: document.querySelector('#topbar .conn-chip').dataset.state, text: document.querySelector('#topbar .conn-chip').textContent }, invite: !!document.getElementById('btnInvitePeople'), inviteUrl: __twin.join.inviteUrl, transport: __twin.S.url.transport, clientId: __twin.S.me.clientId, error: __twin.S.boot.error, roster: __twin.S.roster.length }));
  ok(a1.name === 'Ada' && a1.tile.startsWith('Ada') && a1.prejoinHidden, `joined as ${a1.name} (tile "${a1.tile}"), pre-join hidden ${a1.prejoinHidden}, relay id ${a1.clientId}, error ${a1.error}`);
  ok(a1.chip && a1.chip.state === 'connected' && a1.transport === 'ws', `top-bar chip ${JSON.stringify(a1.chip)} over ${a1.transport}`);
  ok(a1.invite && /room=QWERT/.test(a1.inviteUrl), `People-pane Invite row present; invite URL ${a1.inviteUrl}`);
  // B joins with ?auto=1 (skips the pre-join)
  const B = await browser.newPage(); await B.setViewport({ width: 1100, height: 700 });
  B.on('pageerror', e => logs.push('[B PAGEERROR] ' + e.message));
  await B.goto(base + '&auto=1&name=Ben', { waitUntil: 'domcontentloaded' });
  await B.waitForFunction(() => window.__twin.ready === true, { timeout: 90000 });
  await A.waitForFunction(() => window.__twin.S.roster.length === 2, { timeout: 20000 }).catch(() => {});
  await sleep(2500);
  const a2 = await A.evaluate(() => ({ roster: __twin.S.roster.map(p => p.name), chip: document.querySelector('#topbar .conn-chip').textContent, tiles: __twin.S.tiles.size, seatMap: __twin.S.seatMap && __twin.S.seatMap.seats.length, host: __twin.S.me.isHost, phase: __twin.game.phase, ballVis: __twin.game.ball.mesh.visible }));
  const b2 = await B.evaluate(() => ({ roster: __twin.S.roster.map(p => p.name), chip: document.querySelector('#topbar .conn-chip').textContent, seat: __twin.S.me.seat, host: __twin.S.me.isHost, prejoin: document.getElementById('prejoin').hidden, phase: __twin.game.phase, owner: __twin.net.owner }));
  ok(a2.roster.length === 2 && a2.tiles === 2 && /Connected · 2/.test(a2.chip), `A: roster ${a2.roster.join('/')}, ${a2.tiles} tiles, chip "${a2.chip}", seat map ${a2.seatMap}, host ${a2.host}, phase ${a2.phase}`);
  ok(b2.roster.length === 2 && b2.prejoin && /Connected · 2/.test(b2.chip), `B (?auto=1): roster ${b2.roster.join('/')}, pre-join skipped ${b2.prejoin}, chip "${b2.chip}", seat ${b2.seat}, host ${b2.host}, phase ${b2.phase}, owner ${b2.owner}`);
  // invite dialog on A (People tab)
  await A.evaluate(() => { document.getElementById('tab-people').click(); document.getElementById('btnInvitePeople').click(); }); await sleep(2500);
  const inv = await A.evaluate(() => { const d = document.getElementById('inviteDlg'); return { open: d.open, link: document.getElementById('inviteLink').value, qr: document.getElementById('inviteQr').dataset.qr, lb: !!document.getElementById('leaderboard') }; });
  ok(inv.open && /QWERT/.test(inv.link), `invite dialog open: link ${inv.link}, qr ${inv.qr}`);
  await A.screenshot({ path: `${SHOT_DIR}/int-invite.png` });
  ok(logs.length === 0, `console clean (${logs.length})` + (logs.length ? ' ' + logs.slice(0, 3).join(' | ') : ''));
} catch (e) { console.error('PROBE ERROR', e); fail++; }
finally { await browser.close().catch(() => {}); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
