/**
 * _joinprobe.mjs — headless probe of the PRE-JOIN screen (sdk/game/join-ui.js + sdk/ui/join.css) at 1280x800 and 390x844.
 *   node tests/_joinprobe.mjs
 * Mounts JoinUI over teamslab.html?shell=1&consent=1 (the real frame, tokens and teamslab.css; no tracking), hands it the
 * fake camera stream (Chrome --use-fake-device-for-media-stream), and asserts:
 *   - screen visible, room code = the ?room= of the URL, name prefilled from localStorage, chip shows connecting/offline states
 *   - no horizontal scroll (document and .prejoin scrollWidth <= clientWidth) at both sizes
 *   - phone: every button / input on the screen and in the invite dialog is >= 44 px tall (touch targets)
 *   - Invite dialog opens, link = buildInviteUrl(room) on this origin, Copy reports; QR is an <img> with a data: URL
 *     (cdnjs qrcode) OR the text fallback is shown (data-qr=text) — the probe reports which
 *   - camera / mic toggles flip aria-pressed and the tile's is-camoff class; Join now with an empty name shows the error,
 *     with a name resolves open() and stores hopeos.name; the People-pane invite row mounts; the chip moves to the top bar
 *   - a WsRelayTransport against an unreachable port drives the chip to reconnecting (state events) within 3 s
 * Screenshots: SHOT_DIR/join-desktop.png and join-phone.png (+ join-invite-*.png).
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
mkdirSync(SHOT_DIR, { recursive: true });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1400,900'];

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? ' ' + extra : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function serves(port) { try { const r = await fetch(`http://localhost:${port}/teamslab.html`); return r.ok && (await r.text()).includes('tw-frame tw-meeting'); } catch { return false; } }
async function busy(port) { try { await fetch(`http://localhost:${port}/`); return true; } catch { return false; } }
let PORT = +(process.env.HOPEOS_PORT || 3333), server = null;
if (!(await serves(PORT))) {
  while (await busy(PORT)) PORT++;
  server = spawn(process.execPath, [path.join(REPO, 'tools/dev-server.mjs'), String(PORT)], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await serves(PORT)); i++) await sleep(100);
  console.log(`  (spawned dev server on :${PORT})`);
} else console.log(`  (reusing dev server on :${PORT})`);
const BASE = `http://localhost:${PORT}/teamslab.html`;
const ROOM = 'KRTZQ';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const logs = [];

/** open the shell page and mount JoinUI over it; returns the page */
async function mountJoin(w, hh, { name = null, relay = null } = {}) {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) logs.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message.slice(0, 200)));
  page.on('response', r => { if (r.status() >= 400) logs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`); });
  await page.setViewport({ width: w, height: hh, isMobile: w < 600, hasTouch: w < 600, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((nm) => { try { localStorage.clear(); if (nm) localStorage.setItem('hopeos.name', nm); } catch {} }, name);
  await page.goto(`${BASE}?shell=1&consent=1&tiles=1&room=${ROOM}${relay ? '&relay=' + encodeURIComponent(relay) : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 15000 });
  await page.addStyleTag({ url: `/sdk/ui/join.css` });
  await page.addScriptTag({ type: 'module', content: `
    import { JoinUI, ConnectionChip, NAME_KEY } from '/sdk/game/join-ui.js';
    import { buildInviteUrl } from '/sdk/net/room-link.js';
    const frame = document.querySelector('.tw-frame');
    const join = new JoinUI(frame, { requestPreview: () => navigator.mediaDevices.getUserMedia({ video: true, audio: false }) });
    window.__join = { join, ConnectionChip, NAME_KEY, buildInviteUrl, result: null };
    join.open().then(r => { window.__join.result = r; });
  ` });
  await page.waitForFunction(() => window.__join && !document.getElementById('prejoin').hidden, { timeout: 5000 });
  await sleep(600);   // fake camera attaches; fonts settle
  return page;
}
const overflow = (page) => page.evaluate(() => {
  const d = document.documentElement, p = document.getElementById('prejoin');
  return { docOk: d.scrollWidth <= d.clientWidth + 1, preOk: p.scrollWidth <= p.clientWidth + 1, doc: [d.scrollWidth, d.clientWidth], pre: [p.scrollWidth, p.clientWidth] };
});
const targets = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null || e.closest('dialog[open]')).map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.className.split(' ')[0], w: Math.round(r.width), h: Math.round(r.height) }; }), sel);

try {
  // ======== [1] desktop 1280x800 ========
  console.log('\n[1] desktop 1280x800');
  const pd = await mountJoin(1280, 800, { name: 'Kenny' });
  const st = await pd.evaluate(() => { const j = window.__join.join; return { room: j.room, code: document.querySelector('.prejoin__code').textContent, name: document.getElementById('joinName').value, chip: document.querySelector('.prejoin .conn-chip')?.dataset.state, camoff: document.querySelector('.prejoin__tile').classList.contains('is-camoff'), video: document.querySelector('.prejoin__video').videoWidth, relay: j.relay, relaySource: j.relaySource, invite: j.inviteUrl }; });
  ok(st.room === ROOM && st.code === ROOM, 'room code from ?room= shown', st.code);
  ok(st.name === 'Kenny', 'name prefilled from localStorage[hopeos.name]', st.name);
  ok(!st.camoff && st.video > 0, 'camera preview is live (fake device) and the tile is not cam-off', `video ${st.video}px`);
  ok(st.chip === 'connecting', 'chip starts as connecting', st.chip);
  ok(st.invite === `http://localhost:${PORT}/teamslab.html?room=${ROOM}` || st.invite === `http://localhost:${PORT}/teamslab.html?room=${ROOM}&relay=${encodeURIComponent(st.relay)}`, 'invite URL = the localhost query form', st.invite);
  const od = await overflow(pd); ok(od.docOk && od.preOk, 'no horizontal scroll at 1280x800', JSON.stringify(od));
  await pd.screenshot({ path: `${SHOT_DIR}/join-desktop.png` });

  // invite dialog + QR
  await pd.click('#btnInvite');
  await pd.waitForFunction(() => document.getElementById('inviteDlg').open && document.getElementById('inviteQr').dataset.qr !== 'pending', { timeout: 12000 });
  const inv = await pd.evaluate(() => { const q = document.getElementById('inviteQr'); const img = q.querySelector('img'); return { qr: q.dataset.qr, src: img.hidden ? null : img.src.slice(0, 22), imgW: img.naturalWidth, text: q.querySelector('.invite__qrtext').hidden ? null : q.querySelector('.invite__qrtext').textContent.slice(0, 60), link: document.getElementById('inviteLink').value, code: document.querySelector('#inviteDlg .prejoin__code').textContent }; });
  ok(inv.link === st.invite && inv.code === ROOM, 'invite dialog shows the link and the code', inv.link);
  ok((inv.qr === 'img' && inv.src.startsWith('data:image/png') && inv.imgW > 0) || (inv.qr === 'text' && inv.text && inv.text.includes('link')), `QR present (${inv.qr})`, inv.qr === 'img' ? `${inv.imgW}px png` : inv.text);
  await pd.screenshot({ path: `${SHOT_DIR}/join-invite-desktop.png` });
  await pd.click('#btnCopyLink'); await sleep(200);
  const copied = await pd.evaluate(() => document.querySelector('.invite__copied').textContent);
  ok(/copied|Copy failed/.test(copied), 'Copy reports a result', copied);
  await pd.keyboard.press('Escape'); await sleep(100);
  ok(await pd.evaluate(() => !document.getElementById('inviteDlg').open), 'Escape closes the invite dialog');

  // device toggles + join validation + join
  await pd.click('.prejoin__devbtn[aria-label="Camera"]'); await pd.click('.prejoin__devbtn[aria-label="Mic"]');
  const tg = await pd.evaluate(() => ({ cam: document.querySelector('.prejoin__devbtn[aria-label="Camera"]').getAttribute('aria-pressed'), mic: document.querySelector('.prejoin__devbtn[aria-label="Mic"]').getAttribute('aria-pressed'), camoff: document.querySelector('.prejoin__tile').classList.contains('is-camoff') }));
  ok(tg.cam === 'false' && tg.mic === 'false' && tg.camoff, 'camera / mic toggles flip aria-pressed and the tile goes cam-off', JSON.stringify(tg));
  await pd.click('.prejoin__devbtn[aria-label="Camera"]');
  await pd.evaluate(() => { document.getElementById('joinName').value = ''; document.getElementById('joinName').dispatchEvent(new Event('input')); });
  await pd.click('#btnJoinNow'); await sleep(50);
  const err = await pd.evaluate(() => ({ err: document.querySelector('.prejoin__err').textContent, result: window.__join.result }));
  ok(err.err.length > 0 && err.result === null, 'Join now with an empty name shows the error and does not resolve', err.err);
  await pd.type('#joinName', 'Hannah'); await pd.keyboard.press('Enter'); await sleep(100);
  const joined = await pd.evaluate(() => ({ result: window.__join.result, stored: localStorage.getItem('hopeos.name') }));
  ok(joined.result && joined.result.name === 'Hannah' && joined.result.room === ROOM && joined.result.camera === true && joined.result.mic === false, 'Enter in the name field resolves open() with {name, room, camera, mic}', JSON.stringify(joined.result));
  ok(joined.stored === 'Hannah', 'name stored in localStorage[hopeos.name]');
  await pd.evaluate(() => { const j = window.__join.join; j.close(); j.mountPeopleInvite(document.getElementById('roster')); j.mountChip(document.getElementById('topbar')); j.chip.set('connected', { peers: 3 }); });
  const inMeeting = await pd.evaluate(() => ({ hidden: document.getElementById('prejoin').hidden, row: !!document.querySelector('#pane-people .roster__invite #btnInvitePeople'), chip: document.querySelector('#topbar .conn-chip')?.textContent, meta: document.querySelector('.roster__invite .roster__meta')?.textContent }));
  ok(inMeeting.hidden && inMeeting.row && inMeeting.chip === 'Connected · 3' && inMeeting.meta.includes(ROOM), 'in-meeting: screen hidden, People-pane invite row + top-bar chip', JSON.stringify(inMeeting));
  await pd.evaluate(() => { document.getElementById('tab-people').click(); document.getElementById('btnInvitePeople').click(); });
  await sleep(150);
  ok(await pd.evaluate(() => document.getElementById('inviteDlg').open), 'People-pane Invite reopens the dialog');
  await pd.screenshot({ path: `${SHOT_DIR}/join-inmeeting-people.png` });
  await pd.close();

  // ======== [2] phone 390x844 ========
  console.log('\n[2] phone 390x844');
  const pp = await mountJoin(390, 844, { name: null });
  const sp = await pp.evaluate(() => ({ name: document.getElementById('joinName').value, focused: document.activeElement?.id, cols: getComputedStyle(document.querySelector('.prejoin__body')).gridTemplateColumns.split(' ').length }));
  ok(sp.name === '' && sp.focused === 'joinName', 'empty name: the name field has focus', JSON.stringify(sp));
  ok(sp.cols === 1, 'one-column layout on the phone', `cols=${sp.cols}`);
  const op = await overflow(pp); ok(op.docOk && op.preOk, 'no horizontal scroll at 390x844', JSON.stringify(op));
  const tp = await targets(pp, '.prejoin button, .prejoin input');
  const small = tp.filter(t => t.h < 44);
  ok(tp.length >= 5 && small.length === 0, `every pre-join button / input >= 44 px tall on the phone (${tp.length} checked)`, small.length ? JSON.stringify(small) : '');
  const joinVisible = await pp.evaluate(() => { const r = document.getElementById('btnJoinNow').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
  ok(joinVisible, 'Join now is on screen without scrolling at 390x844');
  await pp.screenshot({ path: `${SHOT_DIR}/join-phone.png` });
  await pp.tap('#btnInvite');
  await pp.waitForFunction(() => document.getElementById('inviteDlg').open && document.getElementById('inviteQr').dataset.qr !== 'pending', { timeout: 12000 });
  const ti = await targets(pp, '#inviteDlg button, #inviteDlg input');
  const smallI = ti.filter(t => t.h < 44);
  ok(ti.length >= 3 && smallI.length === 0, `invite dialog controls >= 44 px on the phone (${ti.length} checked)`, smallI.length ? JSON.stringify(smallI) : '');
  const qrp = await pp.evaluate(() => { const d = document.getElementById('inviteDlg').getBoundingClientRect(); return { qr: document.getElementById('inviteQr').dataset.qr, fits: d.width <= innerWidth + 1 }; });
  ok(qrp.fits && qrp.qr !== 'pending', `invite dialog fits the phone width, QR ${qrp.qr}`);
  await pp.screenshot({ path: `${SHOT_DIR}/join-invite-phone.png` });
  await pp.close();

  // ======== [3] chip follows WsRelayTransport state events (unreachable relay -> reconnecting) ========
  console.log('\n[3] connection chip + WsRelayTransport reconnect states');
  const pc = await mountJoin(1280, 800, { name: 'Kenny' });
  const chipStates = await pc.evaluate(async () => {
    const { WsRelayTransport } = await import('/sdk/net/transports.js');
    const j = window.__join.join; const seen = [];
    const tr = new WsRelayTransport('ws://127.0.0.1:1/room/x', { delaysMs: [200, 400, 800, 1600], connectTimeoutMs: 2500 });
    tr.on('state', e => seen.push(e.state + (e.willReconnect ? '+r' : '')));
    j.chip.attach(tr);
    const chips = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 1800) { chips.push(j.chip.el.dataset.state); await new Promise(r => setTimeout(r, 100)); }
    let readyErr = null; try { await tr.ready; } catch (e) { readyErr = String(e.message || e); }
    tr.close();
    return { seen: [...new Set(seen)], chips: [...new Set(chips)], attempts: tr.stats.attempts, final: j.chip.el.dataset.state, readyErr };
  });
  ok(chipStates.seen.includes('connecting') && chipStates.seen.includes('closed+r') && chipStates.attempts >= 2, 'transport emits connecting / closed(willReconnect) and retries with backoff', JSON.stringify(chipStates));
  ok(chipStates.chips.includes('reconnecting') && chipStates.final === 'offline', 'chip shows reconnecting while retrying and offline after close()', JSON.stringify({ chips: chipStates.chips, final: chipStates.final }));
  ok(!!chipStates.readyErr && /no hello/.test(chipStates.readyErr), 'ready rejects after connectTimeoutMs while the loop keeps retrying', chipStates.readyErr);
  await pc.close();
} catch (e) {
  fail++; console.error('  FAIL probe threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  if (server) server.kill();
}
const errs = logs.filter(l => !/favicon\.ico|ERR_CONNECTION_REFUSED|WebSocket connection to 'ws:\/\/127\.0\.0\.1:1/.test(l));
ok(errs.length === 0, 'no console / page errors (relay-refused noise excluded)', errs.slice(0, 3).join(' | '));
console.log(`\nscreenshots: ${SHOT_DIR}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
