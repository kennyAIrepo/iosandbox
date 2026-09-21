// B5/B6 wire probe: two pages on loopback; A raises via the Raise BUTTON and via a synthetic detector event; B shows the pill and the emoji
// on A's tile; B reacts from the menu and A floats it; (B6) the host's SCORE packet reaches B's leaderboard. Hard timeout.
import puppeteer from 'puppeteer-core';
const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1280,800'];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh|Autoplay|GPU stall|WebGL warning|TensorFlow|INFO: Created TensorFlow|GL_INVALID|OpenGL ES|Overriding|deprecated/i;
const ROOM = 'g' + Math.random().toString(36).slice(2, 6);
const base = `http://localhost:3333/teamslab.html?room=${ROOM}&transport=loopback&auto=1&consent=1&fixedstep=1&agent=local&nosfx=1`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
setTimeout(() => { console.error('HARD TIMEOUT'); process.exit(2); }, 150000);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const logs = [];
const CLAP = '\u{1F44F}';
try {
  const A = await browser.newPage(); await A.setViewport({ width: 1280, height: 800 });
  const B = await browser.newPage(); await B.setViewport({ width: 1100, height: 700 });
  for (const [P, n] of [[A, 'A'], [B, 'B']]) { P.on('pageerror', e => logs.push(`[${n} PAGEERROR] ` + e.message)); P.on('console', m => { if (m.type() === 'error' && !FILTER.test(m.text())) logs.push(`[${n}] ` + m.text().slice(0, 200)); }); }
  await A.goto(base + '&host=1&name=Ada', { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.__twin.ready === true, { timeout: 60000, polling: 500 }).catch(async () => { console.log('A stuck at', JSON.stringify(await A.evaluate(() => ({ stage: __twin.S.boot.stage, error: __twin.S.boot.error, prejoin: !!document.getElementById('prejoin') && !document.getElementById('prejoin').hidden, url: __twin.S.url })))); throw new Error('A not ready'); });
  await B.goto(base + '&name=Ben', { waitUntil: 'domcontentloaded' });
  await B.waitForFunction(() => window.__twin.ready === true, { timeout: 90000, polling: 500 });
  await A.waitForFunction(() => window.__twin.S.roster.length === 2 && window.__twin.S.seatMap && window.__twin.S.seatMap.seats.length === 2, { timeout: 20000, polling: 300 });
  await B.waitForFunction(() => window.__twin.S.roster.length === 2 && window.__twin.S.me.seat >= 0, { timeout: 20000, polling: 300 });
  await sleep(1000);
  const ids = await A.evaluate(() => ({ me: __twin.S.me.clientId, seat: __twin.S.me.seat, peer: __twin.S.roster.find(p => p.clientId !== __twin.S.me.clientId).clientId }));
  console.log('  ids', JSON.stringify(ids));
  // 1. Raise button on A -> A's pill + B sees A raised
  await A.evaluate(() => document.getElementById('btnRaise').click());
  await sleep(700);
  const r1 = await A.evaluate(() => ({ pressed: document.getElementById('btnRaise').getAttribute('aria-pressed'), raised: __twin.ui.tiles.get(__twin.S.me.clientId).state.raised, det: __twin.gestures.raised, polite: document.getElementById('live-polite').textContent }));
  const r1b = await B.evaluate((id) => { const t = __twin.ui.tiles.get(id); return { raised: t && t.state.raised, cls: t && t.el.classList.contains('is-raised') }; }, ids.me);
  ok(r1.pressed === 'true' && r1.raised === true && r1.det === true && r1b.raised === true && r1b.cls, `[B5] Raise button on A: pressed ${r1.pressed}, pill ${r1.raised}, detector latch ${r1.det}; B shows A raised ${r1b.raised} (.is-raised ${r1b.cls}); live "${r1.polite}"`);
  // 2. synthetic detector 'raise off' event on A -> goes through the button path -> B lowers
  await A.evaluate(() => __twin.gestures.onEvent({ kind: 'raise', code: 1, on: false, slot: 'right', t: 0 }));
  await sleep(700);
  const r2 = await A.evaluate(() => ({ pressed: document.getElementById('btnRaise').getAttribute('aria-pressed'), raised: __twin.ui.tiles.get(__twin.S.me.clientId).state.raised, events: __twin.S.gestures.events }));
  const r2b = await B.evaluate((id) => __twin.ui.tiles.get(id).state.raised, ids.me);
  ok(r2.pressed === 'false' && !r2.raised && !r2b, `[B5] detector raise:off on A -> button un-pressed (${r2.pressed}), pill off (${r2.raised}), B lowered (${r2b}); gesture events ${r2.events}`);
  // 3. synthetic 'like' gesture on A -> emoji on A's tile on BOTH pages
  await A.evaluate(() => __twin.gestures.onEvent({ kind: 'like', code: 3, on: true, slot: 'right', t: 0 }));
  await sleep(600);
  const r3 = await A.evaluate(() => __twin.rxFx.alive(__twin.ui.tiles.get(__twin.S.me.clientId).el));
  const r3b = await B.evaluate((id) => ({ alive: __twin.rxFx.alive(__twin.ui.tiles.get(id).el), text: (document.querySelector(`.tile[data-client="${id}"] .rx-emoji`) || {}).textContent, polite: document.getElementById('live-polite').textContent }), ids.me);
  ok(r3 > 0 && r3b.alive > 0, `[B5] 'like' gesture on A: ${r3} emoji alive on A's own tile; on B ${r3b.alive} alive on A's tile ("${r3b.text}"), live "${r3b.polite}"`);
  // 4. React menu on B (clap) -> A floats it on B's tile
  await B.evaluate(() => { document.getElementById('btnReact').click(); });
  await sleep(200);
  const picked = await B.evaluate((clap) => { const items = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === clap); if (items.length) { items[0].click(); return true; } return false; }, CLAP);
  await sleep(700);
  const r4 = await A.evaluate((peer) => ({ alive: __twin.rxFx.alive(__twin.ui.tiles.get(peer).el), text: (document.querySelector(`.tile[data-client="${peer}"] .rx-emoji`) || {}).textContent }), ids.peer);
  ok(picked && r4.alive > 0 && r4.text === CLAP, `[B5] React menu on B (picked ${picked}) -> A floats "${r4.text}" on B's tile (${r4.alive} alive)`);
  await A.screenshot({ path: `${SHOT_DIR}/int-gestures.png` });
  // 5. (B6) leaderboard: A is host; a goal on A -> B's leaderboard row updates via SCORE 0x31
  const lbA = await A.evaluate(() => (__twin.lb ? { host: __twin.lb.isHost, rows: __twin.lb.rows.size, sec: !!document.getElementById('leaderboard') } : null));
  const lbB = await B.evaluate(() => (__twin.lb ? { host: __twin.lb.isHost, rows: __twin.lb.rows.size, applied: __twin.lb.stats.applied, sec: !!document.getElementById('leaderboard') } : null));
  ok(lbA && lbA.host && lbA.sec && lbB && !lbB.host && lbB.sec && lbB.rows === 2, `[B6] leaderboard mounted: A host ${lbA && lbA.host} rows ${lbA && lbA.rows}; B client rows ${lbB && lbB.rows}, packets applied ${lbB && lbB.applied}`);
  if (lbA) {
    await A.evaluate(() => { __twin.lb.goal(0, { potato: false }); });
    await sleep(800);
    const g = await B.evaluate(() => ({ goals: __twin.lb.rows.get(0) && __twin.lb.rows.get(0).goals, applied: __twin.lb.stats.applied, html: (document.getElementById('leaderboard') || { textContent: '' }).textContent.replace(/\s+/g, ' ').slice(0, 120) }));
    ok(g.goals === 1 && g.applied > 0, `[B6] host goal -> B's leaderboard row seat 0 goals ${g.goals} (applied ${g.applied}); section: "${g.html}"`);
    await A.screenshot({ path: `${SHOT_DIR}/int-leaderboard.png` });
  }
  ok(logs.length === 0, `console clean (${logs.length})` + (logs.length ? ' ' + logs.slice(0, 3).join(' | ') : ''));
} catch (e) { console.error('PROBE ERROR', e); fail++; }
finally { await browser.close().catch(() => {}); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
