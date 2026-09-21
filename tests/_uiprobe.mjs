/**
 * _uiprobe.mjs — browser probe for the Teams-twin UI shell (T1): teamslab.html?shell=1&tiles=4, no tracking.
 *   - tile DOM rects at the six reference rectangles (994x678, 918x540, 792x382, 472x382, 1280x720, 1920x1080)
 *     equal fixed169(n, galleryW, galleryH) +/- 1 px (position AND size, incomplete last row centred)
 *   - no horizontal scroll at 472x382; every .tile has role=group + aria-label
 *   - #controlbar is role=toolbar with 8 buttons >= 32x32 and arrow-key focus movement (roving tabindex)
 *   - #panel tabs are role=tab inside a role=tablist; arrow keys move + select
 *   - --tw-motion is '0' under Chrome's --force-prefers-reduced-motion (separate browser) and via setReducedMotion(true)
 *   - consent (C1): dialog open on load without ?consent=1; navigator.mediaDevices.getUserMedia spy stays 0 until
 *     "I agree" is clicked (the shell's stubbed onConsent is the only caller); ?consent=1 skips the dialog
 *   - setDeviceOnly(true) flips the local pill to "On-device only" and #btnDeviceOnly[aria-pressed]
 *   - announce() throttles to one message per 2 s per region; toast() renders and dismisses
 *   - screenshots at the six rectangles to SHOT_DIR
 * Needs Chrome + a static server: reuses http://localhost:3333 when it serves this repo's teamslab.html, else spawns
 * `node tools/dev-server.mjs <port>` (HOPEOS_PORT, default 3333 or the next free one).
 * Run: node tests/_uiprobe.mjs   ->  prints "N passed, M failed", exit code 1 on failure.
 *
 * T7 (`--links` runs ONLY the T7 sections [6]-[9]; `--all` runs T1 + T7):
 *   [6] every href in the API tab (API_ROWS links + PRIVACY_URL + LICENSES_URL + the About "served copies" links) resolves 200
 *   [7] on the real twin (?auto=1&fixedstep=1&consent=1&transport=loopback&bot=1&agent=local&nosfx=1) with the API tab selected,
 *       every row shows a live() string (no '—' placeholder except Tenant / packaging) and the HUD, remote-hands and ball rows
 *       change between samples 1 s apart
 *   [8] consent dialog (C1), pills (C3), device-only button (C4), strip and About footnote (C10) byte-match docs/teams/consent-copy.md;
 *       About > Privacy carries the C7 notice, the consent version and the served-copy links
 *   [9] TEAMSLAB.md quotes npm scripts that package.json defines (serve, relay, proxy, test:twin, probe:twin) and >= 4 teamslab URLs
 *
 * B7 (`--b7` runs ONLY section [10]; it also runs after T1 by default):
 *   [10] shell=1 at 1280x800, 994x678, 390x844: hand-state chip (setHandState), single status pill (C3 text + age), label bar inside
 *        the bottom 40 px with the shelf line above, Game-tab sliders emit 'ballsize' / 'shelf', skeleton while loading, quiet
 *        "Waiting for <name>", coach marks (order, anchors, Esc, persisted seen flag, contextual toasts), dark theme, no
 *        horizontal scroll -> screenshots SHOT_DIR_V2/shell-1280.png, shell-994.png, shell-phone.png
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLIDERS } from '../sdk/game/twin-ui.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-t1';
mkdirSync(SHOT_DIR, { recursive: true });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1400,900'];
const RECTS = [[994, 678], [918, 540], [792, 382], [472, 382], [1280, 720], [1920, 1080]];
class SkipT1 extends Error {}
const ARGV = process.argv.slice(2);
const RUN_T7 = ARGV.includes('--links') || ARGV.includes('--all');
const RUN_T1 = (!ARGV.includes('--links') && !ARGV.includes('--b7')) || ARGV.includes('--all');
const RUN_B7 = ARGV.includes('--b7') || ARGV.includes('--all') || !ARGV.includes('--links');
const SHOT_DIR_V2 = process.env.SHOT_DIR_V2 || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
mkdirSync(SHOT_DIR_V2, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? ' ' + extra : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- server -------------------------------------------------------------------------------------------------
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

// ---- browser ----------------------------------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message.slice(0, 200)));
// getUserMedia spy, installed before any script of the page runs
await page.evaluateOnNewDocument(() => {
  window.__gum = 0;
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
  md.getUserMedia = (c) => { window.__gum++; return orig(c); };
});
const waitReady = async () => page.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 15000 });

try {
  if (!RUN_T1) throw new SkipT1();
  // ======== [1] consent gate ========
  console.log('\n[1] consent gate (C1)');
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${BASE}?shell=1&tiles=4`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitReady();
  let c = await page.evaluate(() => ({ open: document.getElementById('consent').open, gum: window.__gum, title: document.getElementById('c1-title').textContent, agree: document.getElementById('c1-agree').textContent, modal: document.getElementById('consent').getAttribute('aria-modal'), labelled: document.getElementById('consent').getAttribute('aria-labelledby'), body: document.getElementById('c1-body').textContent }));
  ok(c.open === true, 'consent dialog open on load without ?consent=1');
  ok(c.gum === 0, 'getUserMedia not called while the dialog is open', `spy=${c.gum}`);
  ok(c.title === 'Use your camera for hand tracking?' && c.agree === 'I agree and turn on camera', 'C1 title + button verbatim', c.title);
  ok(c.modal === 'true' && c.labelled === 'c1-title', 'role=dialog aria-modal aria-labelledby=c1-title');
  ok(c.body.includes('Face data (mesh and expressions) is never sent anywhere.') && c.body.includes('This notice and your agreement are recorded on this device'), 'C1 body + Illinois line rendered');
  await page.screenshot({ path: `${SHOT_DIR}/twin-1280x720-consent.png` });
  await page.evaluate(() => document.getElementById('c1-agree').click());
  await page.waitForFunction(() => window.__gum > 0 || !document.getElementById('consent').open, { timeout: 5000 }).catch(() => {});
  await sleep(600);
  c = await page.evaluate(() => ({ open: document.getElementById('consent').open, gum: window.__gum, stored: localStorage.getItem('hopeos.consent'), pill: document.querySelector('#tile-c-000 .tile__pill').textContent, srcObject: !!document.querySelector('#tile-c-000 .tile__media').srcObject }));
  ok(c.open === false, 'dialog closed after "I agree"');
  ok(c.gum === 1, 'getUserMedia called exactly once after "I agree" (stubbed onConsent -> spy)', `spy=${c.gum}`);
  ok(!!c.stored && JSON.parse(c.stored).shareMode === 'share' && !!JSON.parse(c.stored).version, "localStorage 'hopeos.consent' = {version, at, shareMode:'share'}", c.stored);
  ok(c.pill === 'Tracking on this device' && c.srcObject, 'local pill "Tracking on this device" + fake camera attached', c.pill);

  // stored consent skips the dialog on the next load; ?consent=1 skips it regardless
  await page.goto(`${BASE}?shell=1&tiles=4`, { waitUntil: 'domcontentloaded' }); await waitReady(); await sleep(200);
  ok(await page.evaluate(() => !document.getElementById('consent').open), 'stored consent (same version) skips the dialog');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}?shell=1&tiles=4&consent=1`, { waitUntil: 'domcontentloaded' }); await waitReady(); await sleep(400);
  ok(await page.evaluate(() => !document.getElementById('consent').open), '?consent=1 skips the dialog');
  // "Not now" path (Escape = declined) keeps the camera off
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}?shell=1&tiles=2`, { waitUntil: 'domcontentloaded' }); await waitReady();
  await page.keyboard.press('Escape'); await sleep(300);
  c = await page.evaluate(() => ({ open: document.getElementById('consent').open, gum: window.__gum, stored: localStorage.getItem('hopeos.consent'), pill: document.querySelector('#tile-c-000 .tile__pill').textContent }));
  ok(c.open === false && c.gum === 0 && c.stored === null && c.pill === 'Camera off', 'Escape = "Not now": no getUserMedia, nothing stored, pill "Camera off"', JSON.stringify(c));

  // ======== [2] gallery at the six rectangles ========
  console.log('\n[2] gallery rects vs fixed169 at the six reference rectangles (tiles=4)');
  await page.goto(`${BASE}?shell=1&tiles=4&consent=1`, { waitUntil: 'domcontentloaded' }); await waitReady(); await sleep(500);
  for (const [W, H] of RECTS) {
    await page.setViewport({ width: W, height: H });
    await sleep(250);
    const r = await page.evaluate(() => {
      const ui = window.__twin.ui, f = window.__twin.fixed169;
      const L = ui.layout();
      const g = document.getElementById('gallery'), gr = g.getBoundingClientRect();
      const exp = f(ui.tiles.size, g.clientWidth, g.clientHeight, 8);
      const tiles = [...document.querySelectorAll('#gallery .tile')].sort((a, b) => +a.dataset.seat - +b.dataset.seat);
      const n = tiles.length, lastK = n - (exp.rows - 1) * exp.cols;
      const errs = tiles.map((el, i) => {
        const b = el.getBoundingClientRect(), row = Math.floor(i / exp.cols), col = i % exp.cols;
        const k = row === exp.rows - 1 ? lastK : exp.cols, off = (exp.cols - k) * (exp.tw + 8) / 2;
        const ex = gr.left + exp.padX + off + col * (exp.tw + 8), ey = gr.top + exp.padY + row * (exp.th + 8);
        return Math.max(Math.abs(b.left - ex), Math.abs(b.top - ey), Math.abs(b.width - exp.tw), Math.abs(b.height - exp.th));
      });
      const de = document.documentElement, fr = document.querySelector('.tw-frame');
      return { W: g.clientWidth, H: g.clientHeight, exp, L: { rows: L.rows, cols: L.cols, tw: L.tw, th: L.th }, maxErr: Math.max(...errs), n,
        hscroll: de.scrollWidth > de.clientWidth || fr.scrollWidth > fr.clientWidth, narrow: fr.classList.contains('is-narrow'), panelClosed: fr.classList.contains('panel-closed'),
        rects: [...ui.rects().values()].map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]) };
    });
    ok(r.n === 4 && r.maxErr <= 1, `${W}x${H}: 4 tiles at fixed169(4, ${r.W}, ${r.H}) = ${r.exp.rows}x${r.exp.cols} ${r.exp.tw}x${r.exp.th} (max err ${r.maxErr.toFixed(2)} px)`, `layout() -> ${r.L.rows}x${r.L.cols} ${r.L.tw}x${r.L.th}; rects ${JSON.stringify(r.rects)}`);
    if (W === 472) ok(!r.hscroll, '472x382: no horizontal scroll', `narrow=${r.narrow} panelClosed=${r.panelClosed}`);
    await page.screenshot({ path: `${SHOT_DIR}/twin-${W}x${H}.png` });
  }
  // 3 tiles: incomplete last row centred
  await page.setViewport({ width: 994, height: 678 });
  await page.goto(`${BASE}?shell=1&tiles=3&consent=1`, { waitUntil: 'domcontentloaded' }); await waitReady(); await sleep(400);
  const c3 = await page.evaluate(() => {
    const ui = window.__twin.ui; ui.layout();
    const g = document.getElementById('gallery').getBoundingClientRect();
    const t = [...document.querySelectorAll('#gallery .tile')].sort((a, b) => +a.dataset.seat - +b.dataset.seat).map(e => e.getBoundingClientRect());
    return { centred: Math.abs((t[2].left + t[2].width / 2) - (g.left + g.width / 2)), row1: t[2].top > t[0].bottom, sameRow: Math.abs(t[0].top - t[1].top) < 1 };
  });
  ok(c3.sameRow && c3.row1 && c3.centred <= 1, 'tiles=3 at 994x678 -> 2x2 with the lone last tile centred', `centre err ${c3.centred.toFixed(2)} px`);
  await page.screenshot({ path: `${SHOT_DIR}/twin-994x678-3tiles.png` });

  // ======== [3] a11y structure ========
  console.log('\n[3] accessibility structure');
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${BASE}?shell=1&tiles=4&consent=1`, { waitUntil: 'domcontentloaded' }); await waitReady(); await sleep(400);
  const a = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.tile')];
    const bar = document.getElementById('controlbar'), btns = [...bar.querySelectorAll('button')];
    const tabs = [...document.querySelectorAll('#panel [role=tab]')];
    return {
      tiles: tiles.length, tileRoles: tiles.every(t => t.getAttribute('role') === 'group' && (t.getAttribute('aria-label') || '').length > 3), labels: tiles.map(t => t.getAttribute('aria-label')),
      toolbar: bar.getAttribute('role'), nBtns: btns.length, btnMin: Math.min(...btns.map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))), btnIds: btns.map(b => b.id),
      tablist: !!document.querySelector('#panel [role=tablist]'), nTabs: tabs.length, tabIds: tabs.map(t => t.id), selected: tabs.filter(t => t.getAttribute('aria-selected') === 'true').length,
      canvasHidden: ['surface', 'arrivals'].every(id => document.getElementById(id).getAttribute('aria-hidden') === 'true' && getComputedStyle(document.getElementById(id)).pointerEvents === 'none'),
      live: document.getElementById('live-polite').getAttribute('aria-live') === 'polite' && document.getElementById('live-assertive').getAttribute('aria-live') === 'assertive',
      strip: document.getElementById('strip').textContent, complementary: document.getElementById('panel').getAttribute('role'),
      zTile: getComputedStyle(tiles[0]).zIndex, zSurface: getComputedStyle(document.getElementById('surface')).zIndex, zChrome: getComputedStyle(tiles[0].querySelector('.tile__chrome')).zIndex,
    };
  });
  ok(a.tiles === 4 && a.tileRoles, 'every .tile has role=group + aria-label', a.labels.join(' | '));
  ok(a.toolbar === 'toolbar' && a.nBtns === 8 && a.btnMin >= 32, `control bar role=toolbar with 8 buttons >= 32x32 (min ${a.btnMin.toFixed(0)} px)`, a.btnIds.join(','));
  ok(a.tablist && a.nTabs === 4 && a.selected === 1, '#panel: role=tablist with 4 role=tab (one selected)', a.tabIds.join(','));
  ok(a.canvasHidden, '#surface / #arrivals aria-hidden + pointer-events:none (hands are never a pointer)');
  ok(a.live && a.complementary === 'complementary', 'live regions polite/assertive + panel role=complementary');
  ok(a.strip.startsWith('hopeOS Meeting Sandbox - a local test harness') && a.strip.includes('Not a Microsoft product'), 'C10 strip rendered');
  ok(a.zTile === 'auto' && +a.zSurface === 6 && +a.zChrome === 7, 'stacking: .tile z auto < #surface 6 < .tile__chrome 7', `${a.zTile}/${a.zSurface}/${a.zChrome}`);
  // toolbar arrow keys
  await page.focus('#btnCam');
  await page.keyboard.press('ArrowRight'); const f1 = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('End'); const f2 = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('ArrowRight'); const f3 = await page.evaluate(() => document.activeElement.id);
  await page.keyboard.press('ArrowLeft'); const f4 = await page.evaluate(() => document.activeElement.id);
  ok(f1 === 'btnMic' && f2 === 'btnLeave' && f3 === 'btnCam' && f4 === 'btnLeave', 'toolbar arrow keys move focus (wraps), Home/End', `${f1} ${f2} ${f3} ${f4}`);
  const tabIdx = await page.evaluate(() => [...document.querySelectorAll('#controlbar button')].map(b => b.tabIndex));
  ok(tabIdx.filter(t => t === 0).length === 1, 'toolbar roving tabindex: exactly one button is tabbable', tabIdx.join(','));
  // tab arrow keys
  await page.focus('#tab-game'); await page.keyboard.press('ArrowRight');
  const tb = await page.evaluate(() => ({ active: document.activeElement.id, sel: document.querySelector('#panel [role=tab][aria-selected=true]').id, apiVisible: !document.getElementById('pane-api').hidden, gameHidden: document.getElementById('pane-game').hidden, apiRows: document.querySelectorAll('#apiRows .api__row').length, pills: [...document.querySelectorAll('#apiRows .api__pill')].map(p => p.textContent) }));
  ok(tb.active === 'tab-api' && tb.sel === 'tab-api' && tb.apiVisible && tb.gameHidden, 'tab ArrowRight selects the next tab and shows its panel', `${tb.active}`);
  ok(tb.apiRows === 12 && tb.pills.every(p => ['demo', 'seam', 'probe first'].includes(p)), 'API tab renders 12 rows with status pills', tb.pills.join(','));
  // gallery roving tabindex: arrows move between tiles
  await page.focus('#tile-c-000'); await page.keyboard.press('ArrowRight');
  const gf = await page.evaluate(() => document.activeElement.id);
  ok(gf === 'tile-c-001', 'gallery: ArrowRight moves focus to the next tile (roving tabindex)', gf);
  // Esc closes dialogs; Ctrl+/ opens the command popover
  await page.keyboard.down('Control'); await page.keyboard.press('Slash'); await page.keyboard.up('Control'); await sleep(100);
  const pop1 = await page.evaluate(() => document.getElementById('cmdPopover').open);
  await page.keyboard.press('Escape'); await sleep(100);
  const pop2 = await page.evaluate(() => document.getElementById('cmdPopover').open);
  ok(pop1 === true && pop2 === false, 'Ctrl+/ opens the command popover, Esc closes it');
  const ab = await page.evaluate(() => { const ui = window.__twin.ui; ui.openOutgoingHelp(); const d = document.getElementById('about'); const r = { open: d.open, foot: document.getElementById('about-trademark').textContent, obs: document.getElementById('about-outgoing').textContent }; d.close(); return r; });
  ok(ab.open && ab.foot.startsWith('Microsoft, Azure, Fluent and Microsoft Teams are trademarks') && /Outgoing video/.test(ab.obs), 'About dialog: C10 trademark footnote + outgoing (OBS) help section', ab.foot.slice(0, 60));
  // keyboard map: K toggles the keyboard hand, Space = cup (never push-to-talk)
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('KeyK'); await page.keyboard.down('Space'); const k1 = await page.evaluate(() => window.__twin.lastKey?.action + ':' + window.__twin.lastKey?.down);
  await page.keyboard.up('Space'); const k2 = await page.evaluate(() => window.__twin.lastKey?.action + ':' + window.__twin.lastKey?.down);
  await page.keyboard.press('ArrowRight'); const k3 = await page.evaluate(() => window.__twin.lastKey?.action);
  const ptt = await page.evaluate(() => document.getElementById('btnPtt').getAttribute('aria-pressed'));
  ok(k1 === 'cup:true' && k2 === 'cup:false' && k3 === 'right' && ptt === 'false', 'keys: K then Space -> cup down/up, arrows -> hand; Space never presses push-to-talk', `${k1} ${k2} ${k3} ptt=${ptt}`);
  await page.keyboard.down('KeyV'); const v1 = await page.evaluate(() => document.getElementById('btnPtt').getAttribute('aria-pressed') + ':' + document.querySelector('#btnPtt .ptt__label').textContent);
  await page.keyboard.up('KeyV'); const v2 = await page.evaluate(() => document.getElementById('btnPtt').getAttribute('aria-pressed'));
  ok(v1 === 'true:Listening... release to send' && v2 === 'false', 'V hold = push-to-talk (aria-pressed + C7 label)', `${v1} -> ${v2}`);

  // ======== [4] device-only, pills, announce, toast ========
  console.log('\n[4] device-only (C4), pills (C3), live regions, toasts');
  const d = await page.evaluate(async () => {
    const ui = window.__twin.ui;
    await new Promise(r => setTimeout(r, 2200));   // let the boot's "Tracking started on this device" leave the 2 s window
    ui.setDeviceOnly(true);
    const on = { pill: document.querySelector('#tile-c-000 .tile__pill').textContent, pressed: document.getElementById('btnDeviceOnly').getAttribute('aria-pressed'), title: document.getElementById('btnDeviceOnly').title, polite: document.getElementById('live-polite').textContent, pttDisabled: document.getElementById('btnPtt').disabled, label: document.getElementById('tile-c-000').getAttribute('aria-label') };
    ui.setDeviceOnly(false);
    const off = { pill: document.querySelector('#tile-c-000 .tile__pill').textContent, pressed: document.getElementById('btnDeviceOnly').getAttribute('aria-pressed'), pttDisabled: document.getElementById('btnPtt').disabled };
    return { on, off };
  });
  ok(d.on.pill === 'On-device only' && d.on.pressed === 'true', 'setDeviceOnly(true): local pill "On-device only" + aria-pressed=true', `${d.on.pill} / ${d.on.pressed}`);
  ok(d.on.title === 'Resume sharing your hand data with this meeting.' && d.on.polite === 'Sharing off. Nothing leaves this device.' && d.on.pttDisabled && d.on.label.includes('on-device only'), 'C4 title + announcement, PTT disabled, aria-label updated', d.on.polite);
  ok(d.off.pill === 'Tracking on this device' && d.off.pressed === 'false' && !d.off.pttDisabled, 'setDeviceOnly(false): pill back to "Tracking on this device", aria-pressed=false');
  const p = await page.evaluate(() => {
    const ui = window.__twin.ui, t = document.getElementById('tile-c-001');
    ui.setTileState('c-001', { pill: 'no-data', ageMs: 2100, alpha: 0.5, ring: 'miss', chip: 'MISS' });
    return { ring: t.dataset.ring, chip: t.querySelector('.tile__chip').textContent, age: t.querySelector('.tile__age').textContent, alpha: t.querySelector('.tile__media').style.opacity, goal: document.getElementById('tile-c-002').classList.contains('is-goal'), goalChip: getComputedStyle(document.querySelector('#tile-c-002 .tile__goalchip')).display, label2: document.getElementById('tile-c-002').getAttribute('aria-label'), border: getComputedStyle(t.querySelector('.tile__ring')).borderTopWidth, halo: getComputedStyle(t.querySelector('.tile__ring')).boxShadow !== 'none' };
  });
  await sleep(600);   // remote pill writes are throttled to one per 500 ms (privacy patch §1); rings clear after 200 ms
  const p2 = await page.evaluate(() => ({ pill: document.querySelector('#tile-c-001 .tile__pill').textContent, ring: document.getElementById('tile-c-001').dataset.ring, label: document.getElementById('tile-c-001').getAttribute('aria-label') }));
  ok(p2.pill === 'No tracking data' && p.ring === 'miss' && p.chip === 'MISS' && p.age === '2100 ms' && p.alpha === '0.5' && p2.label.includes('no tracking data'), 'remote tile state: pill (<= 500 ms) / ring / chip / age text / alpha / aria-label', `${p2.pill} ${p.ring} ${p.chip} ${p.age} ${p.alpha}`);
  ok(p.goal && p.goalChip !== 'none' && p.label2.includes('goal tile') && p.border === '3px' && p.halo, 'goal tile: frame + trophy chip + "(goal)" in the label; miss ring 3px + halo');
  ok(p2.ring === undefined, 'catch/miss ring is a 200 ms flash (cleared)', String(p2.ring));
  const ann = await page.evaluate(async () => {
    const ui = window.__twin.ui, el = document.getElementById('live-polite');
    await new Promise(r => setTimeout(r, 4200));   // drain the queued C3/C4 announcements + the 2 s window
    ui.announce('first'); const a1 = el.textContent;
    ui.announce('second'); ui.announce('third'); const a2 = el.textContent;
    await new Promise(r => setTimeout(r, 2200)); const a3 = el.textContent;
    ui.announce('loud', 'assertive'); const a4 = document.getElementById('live-assertive').textContent;
    return { a1, a2, a3, a4 };
  });
  ok(ann.a1 === 'first' && ann.a2 === 'first' && ann.a3 === 'third' && ann.a4 === 'loud', 'announce(): 2 s throttle per region, newest pending message wins, assertive region separate', JSON.stringify(ann));
  const tst = await page.evaluate(async () => {
    const ui = window.__twin.ui; ui.toast('hello toast', { ms: 400 });
    const n1 = document.querySelectorAll('#toasts .toast').length, txt = document.querySelector('#toasts .toast span')?.textContent;
    await new Promise(r => setTimeout(r, 700)); return { n1, txt, n2: document.querySelectorAll('#toasts .toast').length };
  });
  ok(tst.n1 === 1 && tst.txt === 'hello toast' && tst.n2 === 0, 'toast renders and auto-dismisses');
  const sc = await page.evaluate(() => { window.__twin.ui.setScore([3, 2], ['Ana', 'Ben']); return document.getElementById('scoreboard').textContent.replace(/\s+/g, ' ').trim(); });
  ok(/Ana\s*3.*Ben\s*2/.test(sc), 'scoreboard renders seat dots + names + tabular scores', sc);
  const ro = await page.evaluate(() => { const ui = window.__twin.ui; ui.reorder(['c-003', 'c-002', 'c-001', 'c-000']); return [...document.querySelectorAll('#gallery .tile')].map(t => t.id + ':' + t.dataset.seat).join(' '); });
  ok(ro === 'tile-c-003:0 tile-c-002:1 tile-c-001:2 tile-c-000:3', 'reorder(seatMap): DOM order = seat order', ro);
  const rm = await page.evaluate(() => { const ui = window.__twin.ui; ui.removeTile('c-002'); ui.layout(); return { n: document.querySelectorAll('#gallery .tile').length, L: ui._layout.cols + 'x' + ui._layout.rows }; });
  ok(rm.n === 3 && rm.L === '2x2', 'removeTile relayouts (3 tiles -> 2x2)', rm.L);
  // motion gate via setReducedMotion (JS override) on the normal browser
  const rm1 = await page.evaluate(() => { const ui = window.__twin.ui; const before = ui.reducedMotion; ui.setReducedMotion(true); const on = ui.reducedMotion + ':' + getComputedStyle(document.querySelector('.tw-frame')).getPropertyValue('--tw-motion').trim(); ui.setReducedMotion(null); return { before, on, after: ui.reducedMotion }; });
  ok(rm1.before === false && rm1.on === 'true:0' && rm1.after === false, 'setReducedMotion(true) -> --tw-motion 0 / get reducedMotion true; null restores the media query', JSON.stringify(rm1));

  // ======== [5] reduced motion under --force-prefers-reduced-motion ========
  console.log('\n[5] --force-prefers-reduced-motion');
  const b2 = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: [...ARGS, '--force-prefers-reduced-motion'] });
  try {
    const p2 = await b2.newPage(); await p2.setViewport({ width: 994, height: 678 });
    await p2.goto(`${BASE}?shell=1&tiles=2&consent=1`, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 15000 }); await sleep(300);
    const m = await p2.evaluate(() => ({ mq: matchMedia('(prefers-reduced-motion: reduce)').matches, motion: getComputedStyle(document.querySelector('.tw-frame')).getPropertyValue('--tw-motion').trim(), rm: window.__twin.ui.reducedMotion, dur: getComputedStyle(document.querySelector('.tw-frame')).getPropertyValue('--tw-reaction-duration').trim() }));
    ok(m.mq === true && m.motion === '0' && m.rm === true, '--tw-motion is 0 and ui.reducedMotion is true under --force-prefers-reduced-motion', JSON.stringify(m));
    await p2.screenshot({ path: `${SHOT_DIR}/twin-994x678-reduced-motion.png` });
  } finally { await b2.close(); }

  const errs = logs.filter(l => !/favicon|XNNPACK|404/.test(l));
  ok(errs.length === 0, 'no console errors (favicon/XNNPACK/404 filtered)', errs.slice(0, 3).join(' | '));
} catch (e) {
  if (!(e instanceof SkipT1)) ok(false, 'probe threw: ' + (e.stack || e.message));
}

// ======== [6]-[9] T7: API-tab links, live numbers, consent-copy byte-match, run book ========
if (RUN_T7) { try { await probeT7(); } catch (e) { ok(false, 'T7 probe threw: ' + (e.stack || e.message)); } }
// ======== [10] B7: shell polish + coaching ========
if (RUN_B7) { try { await probeB7(); } catch (e) { ok(false, 'B7 probe threw: ' + (e.stack || e.message)); } }
await browser.close();
if (server) server.kill();
console.log(`\nscreenshots: ${SHOT_DIR}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


// ---- T7 ------------------------------------------------------------------------------------------------------------
function expectedCopy(md) {
  md = md.replace(/\r\n/g, '\n');
  const sec = (id) => { const m = md.split(/^## /m).find(x => x.startsWith(id + '.')); if (!m) throw new Error('consent-copy section ' + id); return m; };
  const after = (block, label) => { const i = block.indexOf(label); if (i < 0) return null; return block.slice(i + label.length).split('\n')[0].trim(); };
  const c1 = sec('C1'), c3 = sec('C3'), c4 = sec('C4'), c10 = sec('C10');
  const quoted = (s) => [...(s ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  return {
    c1Title: after(c1, '**Title (c1-title):**'),
    c1Buttons: [...after(c1, '**Buttons:**').matchAll(/\[([^\]]+)\]/g)].map(m => m[1]),
    c1Secondary: after(c1, '**Secondary link:**'),
    c1Intro: c1.split('**Body:**')[1].trim().split('\n')[0].trim(),
    c1Face: 'Face data (mesh and expressions) is never sent anywhere.',
    c1Release: c1.split('\n').find(l => l.startsWith('By pressing "I agree"')),
    c3: Object.fromEntries([...c3.matchAll(/^- (Local tile|Remote tile), ([^:]+): \*\*([^*]+)\*\*(?:\s+\(`title`: "([^"]+)"\))?/gm)].map(m => [m[2], { pill: m[3], title: m[4] ?? '' }])),
    c3Announce: quoted(c3.split('\n').find(l => l.includes('Announcement strings:'))),
    c4Label: /Button label: \*\*([^*]+)\*\*/.exec(c4)?.[1],
    c4TitleOff: /`title` when off: "([^"]+)"/.exec(c4)?.[1], c4TitleOn: /`title` when on: "([^"]+)"/.exec(c4)?.[1],
    c4Announce: quoted(c4.split('\n').find(l => l.startsWith('Announcement:'))),
    c10Strip: after(c10, '**Strip:**'),
    c10About: after(c10, '**About panel trademark footnote:**').replace(/\s*\[\/licenses\.html\]\.?$/, ''),
  };
}

async function probeT7() {
  const { API_ROWS, PRIVACY_URL, LICENSES_URL } = await import('../sdk/game/twin-ui.js');
  const ORIGIN = `http://localhost:${PORT}/`;

  console.log('\n[6] T7 links: every API-tab href resolves 200');
  const aboutLinks = ['docs/teams/terms.html', 'docs/teams/consent-copy.md', 'docs/teams/data-flow.md', 'TEAMSLAB.md', 'docs/teams/licenses.html'];
  const hrefs = [...new Set([...API_ROWS.flatMap(r => (r.links ?? []).map(l => l.href)), PRIVACY_URL, LICENSES_URL, ...aboutLinks])];
  const bad = [];
  for (const h of hrefs) { try { const r = await fetch(ORIGIN + h); if (r.status !== 200) bad.push(`${h} -> ${r.status}`); else await r.arrayBuffer(); } catch (e) { bad.push(`${h} -> ${e.message}`); } }
  ok(bad.length === 0, `${hrefs.length} hrefs resolve 200 on :${PORT}`, bad.join(' | '));
  const p7 = await browser.newPage(); await p7.setViewport({ width: 1280, height: 720 });
  const logs7 = []; p7.on('console', m => { if (m.type() === 'error') logs7.push(m.text().slice(0, 200)); }); p7.on('pageerror', e => logs7.push('PAGEERROR ' + e.message.slice(0, 200)));
  await p7.goto(`${BASE}?auto=1&fixedstep=1&consent=1&transport=loopback&bot=1&agent=local&nosfx=1&name=Kenny`, { waitUntil: 'domcontentloaded' });
  await p7.waitForFunction(() => window.__twin && window.__twin.ready === true && window.__twin.t7, { timeout: 30000, polling: 200 });
  const domHrefs = await p7.evaluate(() => [...document.querySelectorAll('#apiRows a')].map(a => a.getAttribute('href')));
  const missing = hrefs.filter(h => !domHrefs.includes(h) && !aboutLinks.includes(h));
  ok(missing.length === 0, 'API tab renders every API_ROWS href', missing.join(' | '));

  console.log('\n[7] T7 live numbers: API tab rows tick');
  await p7.bringToFront();
  await p7.evaluate(() => document.getElementById('tab-api').click());
  await p7.waitForFunction(() => !document.getElementById('pane-api').hidden, { timeout: 5000, polling: 100 });
  await p7.waitForFunction(() => { const t = window.__twin; return t.net && t.hud && Object.keys(t.hud.remoteStats()).length > 0; }, { timeout: 20000, polling: 200 }).catch(() => {});
  await sleep(2500);
  const sample = () => p7.evaluate(() => Object.fromEntries([...document.querySelectorAll('#apiRows .api__row')].map(r => [r.dataset.layer, r.querySelector('.api__live').textContent])));
  const s1 = await sample(); await sleep(1100); const s2 = await sample(); await sleep(1100); const s3 = await sample();
  const layers = Object.keys(s1);
  ok(layers.length === API_ROWS.length, `${layers.length} rows rendered`);
  const placeholders = layers.filter(l => l !== 'Tenant / packaging' && /^live: (—|err)$/.test(s1[l]));
  ok(placeholders.length === 0, 'every row shows a live() string (no — placeholder, no err)', placeholders.join(' | '));
  for (const l of ['Latency HUD', 'Remote hands', 'Cross-tile ball']) {
    const changed = s1[l] !== s2[l] || s2[l] !== s3[l];
    ok(changed, `row "${l}" changes between 1 s samples`, (changed ? s2[l] : s1[l]).slice(0, 110));
  }
  console.log('     ' + layers.map(l => l + ' => ' + s2[l].slice(0, 110)).join('\n     '));
  await p7.screenshot({ path: `${SHOT_DIR}/twin-1280x720-api-tab.png` });
  const errs7 = logs7.filter(l => !/favicon|XNNPACK|404/.test(l));
  ok(errs7.length === 0, 'no console errors on the live twin (favicon/XNNPACK/404 filtered)', errs7.slice(0, 3).join(' | '));
  await p7.close();

  console.log('\n[8] T7 privacy chrome: strings byte-match docs/teams/consent-copy.md (C1, C3, C4, C10)');
  const exp = expectedCopy(readFileSync(path.join(REPO, 'docs/teams/consent-copy.md'), 'utf8'));
  const p8 = await browser.newPage(); await p8.setViewport({ width: 1280, height: 720 });
  await p8.goto(`${BASE}?shell=1&tiles=3`, { waitUntil: 'domcontentloaded' });
  await p8.evaluate(() => localStorage.clear()); await p8.reload({ waitUntil: 'domcontentloaded' });
  await p8.waitForFunction(() => window.__twin && window.__twin.ready === true && window.__twin.t7, { timeout: 15000, polling: 200 });
  const got = await p8.evaluate(() => {
    const T = (sel) => document.querySelector(sel)?.textContent ?? null, ui = window.__twin.ui, S = window.__twin.STRINGS;
    const ps = [...document.querySelectorAll('#c1-body p, #c1-body li')].map(e => e.textContent);
    const pill = (id) => document.querySelector(`#tile-${id} .tile__pill`);
    ui.setTileState('c-000', { pill: 'tracking' }, { immediate: true }); const pTracking = pill('c-000').textContent, tTracking = pill('c-000').title;
    ui.setTileState('c-000', { pill: 'device-only' }, { immediate: true }); const pDev = pill('c-000').textContent, tDev = pill('c-000').title;
    ui.setTileState('c-000', { pill: 'camera-off' }, { immediate: true }); const pOff = pill('c-000').textContent;
    ui.setTileState('c-001', { pill: 'no-data' }, { immediate: true });   // the shell's boot write may still be in the 500 ms pill throttle
    ui.setTileState('c-001', { pill: 'landmarks' }, { immediate: true }); const pLand = pill('c-001').textContent, tLand = pill('c-001').title;
    ui.setTileState('c-001', { pill: 'no-data' }, { immediate: true }); const pNo = pill('c-001').textContent;
    const btn = document.getElementById('btnDeviceOnly');
    return { c1Title: T('#c1-title'), c1Agree: T('#c1-agree'), c1NotNow: T('#c1-notnow'), c1Dev: T('#c1-deviceonly'), ps,
      pills: { pTracking, tTracking, pDev, tDev, pOff, pLand, tLand, pNo }, ann: [S.c3.announce.tracking, S.c3.announce['device-only'], S.c3.announce.resumed('[name]'), S.c3.announce.lost('[name]')],
      c4Label: btn.getAttribute('aria-label'), c4LabelText: btn.querySelector('.cbtn__label')?.textContent ?? null, c4TitleOff: btn.title, c4: { titleOn: S.c4.titleOn, announceOn: S.c4.announceOn, announceOff: S.c4.announceOff },
      strip: T('#strip'), about: T('#about-trademark'),
      t7: { privacy: !!document.getElementById('about-privacy'), c7: T('#about-c7') ?? '', consent: T('#about-consent') ?? '', links: [...document.querySelectorAll('#about-links a')].map(a => a.getAttribute('href')) } };
  });
  ok(got.c1Title === exp.c1Title, 'C1 title', got.c1Title);
  ok(got.c1Agree === exp.c1Buttons[0] && got.c1NotNow === exp.c1Buttons[1] && got.c1Dev === exp.c1Secondary, 'C1 buttons + secondary link', `${got.c1Agree} | ${got.c1NotNow} | ${got.c1Dev}`);
  ok(got.ps.includes(exp.c1Intro) && got.ps.includes(exp.c1Face) && got.ps.includes(exp.c1Release), 'C1 intro, face line and release paragraph verbatim', exp.c1Intro.slice(0, 60));
  const seatLabel = exp.c3['packets arriving'].pill.replace('[seat label]', 'Hannah');
  ok(got.pills.pTracking === exp.c3['tracking running'].pill && got.pills.tTracking === exp.c3['tracking running'].title, 'C3 tracking pill + title', got.pills.pTracking);
  ok(got.pills.pDev === exp.c3['on-device only'].pill && got.pills.tDev === exp.c3['on-device only'].title, 'C3 on-device-only pill + title', got.pills.pDev);
  ok(got.pills.pOff === exp.c3['camera off'].pill, 'C3 camera-off pill', got.pills.pOff);
  ok(got.pills.pLand === seatLabel && got.pills.tLand === exp.c3['packets arriving'].title, 'C3 landmarks pill + title', got.pills.pLand);
  ok(got.pills.pNo === exp.c3['no packets for 2 s'].pill, 'C3 no-data pill', got.pills.pNo);
  ok(JSON.stringify(got.ann) === JSON.stringify(exp.c3Announce), 'C3 announcement strings', got.ann.join(' / '));
  ok(got.c4Label === exp.c4Label && (got.c4LabelText === null || got.c4LabelText === exp.c4Label), 'C4 button label', got.c4Label);
  ok(got.c4TitleOff === exp.c4TitleOff && got.c4.titleOn === exp.c4TitleOn, 'C4 titles off/on', got.c4TitleOff);
  ok(got.c4.announceOn === exp.c4Announce[0] && got.c4.announceOff === exp.c4Announce[1], 'C4 announcements', got.c4.announceOn);
  ok(got.strip === exp.c10Strip, 'C10 strip', got.strip.slice(0, 60));
  ok(got.about.startsWith(exp.c10About) && /licences\.$/.test(got.about), 'C10 About footnote (+ licences link)', got.about.slice(-40));
  ok(got.t7.privacy && got.t7.c7.startsWith('Commands are processed by AI services outside this meeting.') && /version \d{4}-\d{2}-\d{2}/.test(got.t7.consent) && got.t7.links.includes('TEAMSLAB.md'), 'About > Privacy section: C7 notice, consent version, served-copy links', got.t7.consent.slice(0, 60));
  await p8.evaluate(() => { document.getElementById('c1-notnow').click(); window.__twin.ui.openAbout(); });
  await sleep(200);
  await p8.screenshot({ path: `${SHOT_DIR}/twin-1280x720-about.png` });
  await p8.close();

  console.log('\n[9] T7 run book: TEAMSLAB.md commands exist in package.json');
  const book = readFileSync(path.join(REPO, 'TEAMSLAB.md'), 'utf8'), pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const scripts = ['serve', 'relay', 'proxy', 'test:twin', 'probe:twin'];
  const miss = scripts.filter(n => !pkg.scripts[n] || !book.includes('npm run ' + n));
  ok(miss.length === 0, 'npm run serve/relay/proxy/test:twin/probe:twin defined and quoted', miss.join(' | '));
  const urls = [...book.matchAll(/http:\/\/localhost:3333\/teamslab\.html[^\s|`]*/g)].map(m => m[0]);
  ok(urls.length >= 4, `${urls.length} copy-pasteable teamslab URLs in TEAMSLAB.md`, urls[1]);
  const first = await fetch(urls[0].replace(':3333', ':' + PORT)); ok(first.status === 200, 'first run-book URL resolves on the dev server');
}


// ---- B7 ------------------------------------------------------------------------------------------------------------
async function probeB7() {
  console.log('\n[10] B7 shell polish + coaching (shell=1, tiles=4) at 1280x800, 994x678, 390x844');
  const logStart = logs.length;
  const SIZES = [[1280, 800, 'shell-1280.png'], [994, 678, 'shell-994.png'], [390, 844, 'shell-phone.png']];
  const pB = await browser.newPage();
  pB.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
  pB.on('pageerror', e => logs.push('PAGEERROR ' + e.message.slice(0, 200)));
  const ready = () => pB.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 15000 });

  for (const [W, H, shot] of SIZES) {
    const tag = `${W}x${H}`;
    await pB.setViewport({ width: W, height: H });
    await pB.goto(`${BASE}?shell=1&tiles=4&consent=1`, { waitUntil: 'domcontentloaded' }); await ready();
    await pB.evaluate(() => { localStorage.removeItem('hopeos.coach'); localStorage.removeItem('hopeos.ballsize'); localStorage.removeItem('hopeos.shelf'); });
    // the shell's boot pills settle through the 500 ms pill throttle + the fake camera attach
    await pB.waitForFunction(() => document.querySelector('#tile-c-001 .tile__pill')?.textContent === 'Landmarks from Hannah' && document.querySelector('#tile-c-000 .tile__pill')?.textContent === 'Tracking on this device', { timeout: 6000, polling: 100 }).catch(() => {});
    await sleep(200);

    // --- theme + no horizontal scroll + chrome geometry ---
    const g = await pB.evaluate(() => {
      const de = document.documentElement, fr = document.querySelector('.tw-frame'), cs = getComputedStyle(fr);
      const t0 = document.getElementById('tile-c-000'), tr = t0.getBoundingClientRect(), lab = t0.querySelector('.tile__label').getBoundingClientRect();
      const btns = [...document.querySelectorAll('#controlbar button')].map(b => b.getBoundingClientRect());
      return { theme: fr.dataset.theme, bg: cs.backgroundColor, stageBg: getComputedStyle(document.getElementById('stage')).backgroundColor,
        hscroll: de.scrollWidth > de.clientWidth || fr.scrollWidth > fr.clientWidth, sw: fr.scrollWidth, cw: fr.clientWidth, narrow: fr.classList.contains('is-narrow'),
        labelInReserve: lab.top >= tr.bottom - 40 - 0.5 && lab.bottom <= tr.bottom + 0.5, labelH: lab.height, tileH: tr.height,
        barFits: btns.every(b => b.right <= fr.getBoundingClientRect().right + 0.5 && b.width >= 32), barRight: Math.max(...btns.map(b => b.right)), frameW: fr.getBoundingClientRect().width,
        ballchipShown: [...document.querySelectorAll('.tile__ballchip')].some(e => getComputedStyle(e).display !== 'none') };
    });
    ok(g.theme === 'dark' && g.bg === 'rgb(31, 31, 31)' && g.stageBg === 'rgb(20, 20, 20)', `${tag}: dark theme default (frame #1f1f1f, stage #141414)`, `${g.bg} / ${g.stageBg}`);
    ok(!g.hscroll, `${tag}: no horizontal scroll`, `scrollWidth ${g.sw} clientWidth ${g.cw} narrow=${g.narrow}`);
    ok(g.labelInReserve, `${tag}: label bar sits inside the bottom 40 px reserve (h ${g.labelH.toFixed(0)} px of a ${g.tileH.toFixed(0)} px tile)`);
    ok(g.barFits && g.barRight <= g.frameW, `${tag}: control bar's 8 buttons fit the frame (right edge ${g.barRight.toFixed(0)} <= ${g.frameW.toFixed(0)})`);
    ok(!g.ballchipShown, `${tag}: raw 'ball' pill is never shown`);

    // --- hand-state chip on the local tile ---
    const hs = await pB.evaluate(() => {
      const ui = window.__twin.ui, el = document.getElementById('tile-c-000'), chip = el.querySelector('.tile__handstate');
      const read = () => ({ hidden: chip.hidden, state: chip.dataset.state, text: chip.querySelector('.tile__handstate-text').textContent, icon: !!chip.querySelector('svg'), label: el.getAttribute('aria-label') });
      const got = []; ui.addEventListener('handstate', (e) => got.push(e.detail.summary));
      const r0 = read();
      ui.setHandState(0, 'open'); const r1 = read();
      ui.setHandState(1, 'holding:wrap'); const r2 = read();
      ui.setHandState(1, { kind: 'holding', how: 'cradle' }); const r3 = read();
      ui.setHandState(1, 'none'); const r4 = read();
      ui.setHandState(0, 'throwing'); const r5 = read();
      ui.setHandState(0, null); const r6 = read();
      ui.setHandState(0, 'cupped'); const r7 = read();
      ui.setTileState('c-001', { ball: true }); const remote = document.querySelector('#tile-c-001 .tile__handstate');
      const r8 = { hidden: remote.hidden, text: remote.querySelector('.tile__handstate-text').textContent, state: remote.dataset.state, ballchip: getComputedStyle(document.querySelector('#tile-c-001 .tile__ballchip')).display };
      ui.setTileState('c-001', { ball: false }); const r9 = remote.hidden;
      const cs = getComputedStyle(chip);
      return { r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, got, h: chip.getBoundingClientRect().height, bg: cs.backgroundColor, color: cs.color, title: chip.title };
    });
    ok(hs.r0.hidden && hs.r0.state === 'none', `${tag}: chip hidden before any hand state`);
    ok(!hs.r1.hidden && hs.r1.text === 'Open' && hs.r1.icon && hs.r1.state === 'open', `${tag}: setHandState(0,'open') -> icon + "Open"`, hs.r1.text);
    ok(hs.r2.text === 'Holding · wrap' && hs.r2.state === 'holding:wrap' && hs.r3.text === 'Holding · cradle', `${tag}: slot 1 holding wrap / {kind, how:cradle} wins over slot 0 open`, `${hs.r2.text} -> ${hs.r3.text}`);
    ok(hs.r4.text === 'Open' && hs.r5.text === 'Throwing' && hs.r6.hidden && hs.r7.text === 'Cupped', `${tag}: clearing slot 1 -> Open; throwing; null hides; cupped`, `${hs.r4.text} ${hs.r5.text} hidden=${hs.r6.hidden} ${hs.r7.text}`);
    ok(hs.r7.label.includes('hand cupped'), `${tag}: aria-label carries the hand state`, hs.r7.label);
    ok(hs.got.join(',') === 'open,holding:wrap,holding:cradle,open,throwing,none,cupped', `${tag}: 'handstate' events with the summary`, hs.got.join(','));
    ok(!hs.r8.hidden && hs.r8.text === 'Has the ball' && hs.r8.state === 'ball' && hs.r8.ballchip === 'none' && hs.r9 === true, `${tag}: remote ball owner shows "Has the ball" (raw pill stays display:none), cleared on ball:false`, JSON.stringify(hs.r8));
    ok(hs.h >= 22 && hs.h <= 26 && hs.color === 'rgb(255, 255, 255)', `${tag}: chip 24 px, white text on the label scrim`, `${hs.h.toFixed(0)} px ${hs.bg}`);

    // --- single status pill: C3 text + age ---
    const st = await pB.evaluate(() => {
      const s1 = document.querySelector('#tile-c-001 .tile__status'), pill = s1.querySelector('.tile__pill'), age = s1.querySelector('.tile__age');
      const s0 = document.querySelector('#tile-c-000 .tile__status');
      const bgPill = getComputedStyle(pill).backgroundColor, bgStatus = getComputedStyle(s1).backgroundColor;
      const sep = getComputedStyle(age, '::before').content;
      return { text: s1.textContent.replace(/\s+/g, ' ').trim(), pillText: pill.textContent, ageText: age.textContent, ageHidden: age.hidden, bgPill, bgStatus, sep,
        local: s0.textContent.trim(), localAgeHidden: s0.querySelector('.tile__age').hidden, one: document.querySelectorAll('#tile-c-001 .tile__status').length,
        display: getComputedStyle(s1).display };
    });
    ok(st.pillText === 'Landmarks from Hannah' && st.ageText === '68 ms' && !st.ageHidden && st.sep.includes('·'), `${tag}: one status pill = C3 text (verbatim) + "· 68 ms"`, `${st.text}`);
    ok(st.bgPill === 'rgba(0, 0, 0, 0)' && st.bgStatus !== 'rgba(0, 0, 0, 0)' && st.one === 1, `${tag}: the wrapper carries the pill background, the C3 span is transparent`, `${st.bgPill} / ${st.bgStatus}`);
    ok(st.local === 'Tracking on this device' && st.localAgeHidden, `${tag}: local pill "Tracking on this device" (no age)`, st.local);
    // label-bar bands: the NAME never collapses; two rows from 440 px tiles down, still inside the 40 px reserve
    const lb = await pB.evaluate(() => {
      const band = document.getElementById('gallery').dataset.tileBand, tw = parseFloat(getComputedStyle(document.getElementById('gallery')).getPropertyValue('--tile-w'));
      const names = ['c-000', 'c-001', 'c-002'].map(id => { const n = document.querySelector(`#tile-${id} .tile__name`); return { t: n.textContent, cut: n.scrollWidth > n.clientWidth + 1 }; });
      const lab = document.querySelector('#tile-c-001 .tile__label').getBoundingClientRect(), st = document.querySelector('#tile-c-001 .tile__status').getBoundingClientRect(), nm = document.querySelector('#tile-c-001 .tile__name').getBoundingClientRect();
      const t1 = document.getElementById('tile-c-001').getBoundingClientRect();
      const stCut = (() => { const p = document.querySelector('#tile-c-001 .tile__pill'); return p.scrollWidth > p.clientWidth + 1; })();
      return { band, tw, names, rows: st.top >= nm.bottom - 1 ? 2 : 1, labH: lab.height, inReserve: lab.top >= t1.bottom - 40.5 && lab.bottom <= t1.bottom + 0.5, statusShown: getComputedStyle(document.querySelector('#tile-c-001 .tile__status')).display !== 'none', stCut, sb: document.getElementById('scoreboard').getBoundingClientRect().width, sbText: document.getElementById('scoreboard').textContent.replace(/\s+/g, ' ').trim() };
    });
    ok(lb.band === (lb.tw >= 440 ? 'wide' : lb.tw >= 240 ? 'mid' : 'small') && lb.rows === (lb.band === 'wide' ? 1 : 2), `${tag}: ${lb.tw} px tiles -> band "${lb.band}", label bar ${lb.rows} row(s)`);
    ok(lb.names.every(n => !n.cut) && lb.statusShown && !lb.stCut && lb.inReserve && lb.labH <= 40, `${tag}: names "${lb.names.map(n => n.t).join('", "')}" never truncated, status pill shown in full, bar ${lb.labH.toFixed(0)} px inside the reserve`);
    if (g.narrow) ok(/Kenny\s*2.*Hannah\s*1/.test(lb.sbText) && lb.sb > 140, `${tag}: phone scoreboard keeps both names ("${lb.sbText}", ${lb.sb.toFixed(0)} px)`);

    // --- skeleton + waiting ---
    const sk = await pB.evaluate(() => {
      const ui = window.__twin.ui, t2 = document.getElementById('tile-c-002'), sk = t2.querySelector('.tile__skeleton');
      const before = getComputedStyle(sk).display;
      ui.setTileState('c-002', { loading: true });
      const on = { display: getComputedStyle(sk).display, bg: getComputedStyle(sk).backgroundColor, cls: t2.classList.contains('is-loading'), text: sk.querySelector('.tile__skeleton-text').textContent, anim: getComputedStyle(sk, '::before').animationName, label: t2.getAttribute('aria-label') };
      const w3 = document.querySelector('#tile-c-003 .tile__waiting'), w1 = document.querySelector('#tile-c-001 .tile__waiting');
      const wait3 = { hidden: w3.hidden, text: w3.textContent, color: getComputedStyle(w3).color };
      const wait1a = w1.hidden;
      ui.setTileState('c-001', { ageMs: 2600 }); const wait1b = w1.hidden;
      ui.setTileState('c-001', { ageMs: 68 }); const wait1c = w1.hidden;
      const wLocal = document.querySelector('#tile-c-000 .tile__waiting').hidden;
      return { before, on, wait3, wait1a, wait1b, wait1c, wLocal };
    });
    ok(sk.before === 'none' && sk.on.display === 'flex' && sk.on.cls && sk.on.bg === 'rgb(36, 36, 36)', `${tag}: loading:true -> skeleton shimmer (bg2, not black)`, `${sk.before} -> ${sk.on.display} ${sk.on.bg}`);
    ok(sk.on.text === 'Starting the tracker…' && sk.on.anim === 'tile-shimmer' && sk.on.label.includes('tracker starting'), `${tag}: skeleton caption + shimmer animation + aria-label`, sk.on.anim);
    ok(!sk.wait3.hidden && sk.wait3.text === 'Waiting for Clone' && sk.wait3.color === 'rgb(255, 255, 255)', `${tag}: remote with no data shows a quiet "Waiting for Clone"`, sk.wait3.text);
    const wg = await pB.evaluate(() => { const t = document.getElementById('tile-c-003'), r = t.getBoundingClientRect(), w = t.querySelector('.tile__waiting').getBoundingClientRect(), a = t.querySelector('.tile__initials').getBoundingClientRect(), l = t.querySelector('.tile__label').getBoundingClientRect(); return { aboveBar: w.bottom <= l.top - 1 && w.bottom <= r.bottom - 40, belowAvatar: w.top >= a.bottom - 1, inTile: w.top >= r.top && w.left >= r.left && w.right <= r.right }; });
    ok(wg.aboveBar && wg.belowAvatar && wg.inTile, `${tag}: waiting note sits between the initials and the label bar`, JSON.stringify(wg));
    ok(sk.wait1a === true && sk.wait1b === false && sk.wait1c === true && sk.wLocal === true, `${tag}: waiting note appears when ageMs > 2 s and clears; never on the local tile`, `${sk.wait1a} ${sk.wait1b} ${sk.wait1c}`);

    // --- sliders ---
    await pB.evaluate((d) => { window.__shelfDefault = d; }, SLIDERS.shelf.value);
    const sl = await pB.evaluate(() => {
      const ui = window.__twin.ui, pane = document.getElementById('pane-game');
      const bs = pane.querySelector('#ballSize'), sh = pane.querySelector('#shelfPct');
      const rows = [...pane.querySelectorAll('.panel__row')], goalRow = pane.querySelector('#goalSeat').closest('.panel__row');
      const order = rows.indexOf(goalRow) < rows.indexOf(bs.closest('.panel__row')) && rows.indexOf(bs.closest('.panel__row')) < rows.indexOf(sh.closest('.panel__row'));
      const got = []; for (const ev of ['ballsize', 'shelf']) ui.addEventListener(ev, (e) => got.push([ev, e.detail]));
      bs.value = '0.04'; bs.dispatchEvent(new Event('input', { bubbles: true })); bs.dispatchEvent(new Event('change', { bubbles: true }));
      sh.value = '52'; sh.dispatchEvent(new Event('input', { bubbles: true }));
      const outB = pane.querySelector('#ballSizeOut').textContent, outS = pane.querySelector('#shelfPctOut').textContent;
      const shelfVar = getComputedStyle(document.querySelector('.tw-frame')).getPropertyValue('--tw-shelf').trim();
      const labelled = [...pane.querySelectorAll('label[for=ballSize], label[for=shelfPct]')].map(l => l.textContent);
      ui.setShelf(window.__shelfDefault, { emit: false }); ui.setBallSize(0.05, { emit: false });
      return { spec: { min: bs.min, max: bs.max, step: bs.step, smin: sh.min, smax: sh.max }, order, got, outB, outS, shelfVar, labelled, stored: localStorage.getItem('hopeos.ballsize'), ballSize: ui.ballSize, shelfPct: ui.shelfPct, dup: pane.querySelectorAll('#ballSize').length };
    });
    ok(sl.spec.min === '0.035' && sl.spec.max === '0.07' && sl.spec.step === '0.005' && sl.spec.smin === '30' && sl.spec.smax === '55' && sl.dup === 1, `${tag}: Ball size 0.035-0.07 step 0.005, Shelf 30-55, injected once`, JSON.stringify(sl.spec));
    ok(sl.order && sl.labelled.join('|') === 'Ball size|Shelf height', `${tag}: sliders follow the Goal-tile row with labels`, sl.labelled.join('|'));
    ok(sl.got.length === 3 && sl.got[0][0] === 'ballsize' && sl.got[0][1].value === 0.04 && sl.got[1][1].commit === true && sl.got[2][0] === 'shelf' && sl.got[2][1].pct === 52, `${tag}: 'ballsize' {value:0.04} + commit, 'shelf' {pct:52} emitted`, JSON.stringify(sl.got.map(g => g[1])));
    ok(sl.outB === '0.040' && sl.outS === '52 %' && sl.shelfVar === '52%' && sl.stored === '0.04', `${tag}: outputs "0.040" / "52 %", --tw-shelf 52%, hopeos.ballsize persisted`, `${sl.outB} ${sl.outS} ${sl.shelfVar}`);
    ok(sl.ballSize === 0.05 && sl.shelfPct === SLIDERS.shelf.value, `${tag}: setBallSize / setShelf restore the defaults (0.05, ${SLIDERS.shelf.value} %)`, `${sl.ballSize} ${sl.shelfPct}`);

    // --- shelf line above the reserve ---
    const shl = await pB.evaluate(() => {
      const ui = window.__twin.ui; ui.showShelf(true); const t0 = document.getElementById('tile-c-000'), tr = t0.getBoundingClientRect(), s = t0.querySelector('.tile__shelf').getBoundingClientRect();
      return { fromBottom: tr.bottom - s.top, tileH: tr.height, tag: t0.querySelector('.tile__shelf-tag').textContent, shown: !t0.querySelector('.tile__shelf').hidden };
    });
    ok(shl.shown && shl.fromBottom > 40 && Math.abs(shl.fromBottom - Math.max(40, shl.tileH * SLIDERS.shelf.value / 100)) <= 1.5, `${tag}: shelf line at max(40 px, ${SLIDERS.shelf.value} %) = ${shl.fromBottom.toFixed(0)} px above the tile bottom`, shl.tag);

    // --- coach marks ---
    const co = await pB.evaluate(async () => {
      const ui = window.__twin.ui, F = document.querySelector('.tw-frame').getBoundingClientRect();
      const rect = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { l: r.left - F.left, t: r.top - F.top, r: r.right - F.left, b: r.bottom - F.top } : null; };
      const inside = (a, b) => a && b && a.l >= b.l - 1 && a.r <= b.r + 1 && a.t >= b.t - 1 && a.b <= b.b + 1;
      const overlaps = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
      const events = []; ui.addEventListener('coach', (e) => events.push(e.detail.phase + (e.detail.index != null ? ':' + e.detail.index : '')));
      const started = ui.startCoach({ neighbour: 'Hannah' });
      const card = () => document.querySelector('.coach');
      const read = () => ({ text: card()?.querySelector('.coach__text').textContent, count: card()?.querySelector('.coach__count').textContent, dir: card()?.dataset.dir, step: card()?.dataset.step, live: card()?.querySelector('.coach__text').getAttribute('aria-live'), focus: document.activeElement?.className ?? '', next: card()?.querySelector('.coach__next').textContent, backHidden: card()?.querySelector('.coach__back').hidden, rect: rect('.coach') });
      const s0 = read(); const s0onLocal = overlaps(s0.rect, rect('#tile-c-000')) && inside(s0.rect, rect('.tw-frame'));
      card().querySelector('.coach__next').click(); const s1 = read(); const s1onNeighbour = overlaps(s1.rect, rect('#tile-c-001'));
      card().querySelector('.coach__next').click(); const s2 = read();
      const ptt = rect('#btnPtt'), pttVisible = !!document.getElementById('btnPtt').getClientRects().length;
      const s2ok = pttVisible ? (s2.rect.b <= ptt.t + 1 || s2.rect.t >= ptt.b - 1) && Math.abs((s2.rect.l + s2.rect.r) / 2 - (ptt.l + ptt.r) / 2) < 160 : s2.rect.b <= rect('#controlbar').t + 1;
      return { started, s0, s0onLocal, s1, s1onNeighbour, s2, s2ok, pttVisible, events, roleDialog: card()?.getAttribute('role'), modal: card()?.getAttribute('aria-modal') };
    });
    ok(co.started === true && co.s0.text === 'Cup your palm under the ball to catch it' && co.s0.count === 'Tip 1 of 3' && co.s0.step === 'cup' && co.s0.backHidden, `${tag}: coach step 1 "Cup your palm under the ball to catch it" (Tip 1 of 3)`, co.s0.text);
    // the card points DOWN at the shelf whenever it fits under the top bar (1280x800, 994x678); on the phone's 170 px tiles it flips below the shelf
    ok(co.s0onLocal && (co.s0.dir === 'down' || (g.narrow && co.s0.dir === 'up')), `${tag}: step 1 card overlaps the local tile, arrow ${co.s0.dir} at the shelf`, JSON.stringify(co.s0.rect));
    ok(co.s0.live === 'polite' && co.roleDialog === 'dialog' && co.modal === 'false' && /coach__next/.test(co.s0.focus), `${tag}: aria-live=polite text, non-modal dialog, Next focused`, co.s0.focus);
    ok(co.s1.text === 'Throw toward Hannah' && co.s1.count === 'Tip 2 of 3' && co.s1onNeighbour && !co.s1.backHidden, `${tag}: step 2 "Throw toward Hannah" anchored on Hannah's tile`, JSON.stringify(co.s1.rect));
    ok(co.s2.text === 'Hold V and say: give me a tennis ball' && co.s2.next === 'Done' && co.s2ok, `${tag}: step 3 "Hold V and say: give me a tennis ball" anchored at ${co.pttVisible ? '#btnPtt' : 'the control bar (panel drawer closed)'}`, JSON.stringify(co.s2.rect));
    // keyboard: Esc dismisses + persists; screenshot on the FIRST step so the card reads with the tile
    await pB.evaluate(() => { window.__twin.ui.coach.back(); window.__twin.ui.coach.back(); window.__twin.ui.setHandState(0, 'holding:wrap'); });
    await sleep(250);
    await pB.screenshot({ path: `${SHOT_DIR_V2}/${shot}` });
    await pB.keyboard.press('Escape'); await sleep(100);
    const esc = await pB.evaluate(() => ({ card: !!document.querySelector('.coach'), stored: localStorage.getItem('hopeos.coach'), again: window.__twin.ui.startCoach(), cardAgain: !!document.querySelector('.coach'), hasClass: document.querySelector('.tw-frame').classList.contains('has-coach') }));
    ok(!esc.card && !!esc.stored && JSON.parse(esc.stored).seen === true && JSON.parse(esc.stored).reason === 'esc' && JSON.parse(esc.stored).atStep === 0, `${tag}: Esc dismisses the coach and persists hopeos.coach {seen, reason:'esc'}`, esc.stored);
    ok(esc.again === false && !esc.cardAgain && !esc.hasClass, `${tag}: startCoach() again is skipped (seen)`);
    const force = await pB.evaluate(() => { const ui = window.__twin.ui; const s = ui.startCoach({ force: true }); const t = document.querySelector('.coach__text')?.textContent; ui.coach.next(); ui.coach.next(); ui.coach.next(); return { s, t, done: !document.querySelector('.coach'), rec: JSON.parse(localStorage.getItem('hopeos.coach') || 'null') }; });
    ok(force.s === true && force.t === 'Cup your palm under the ball to catch it' && force.done && force.rec.reason === 'done' && force.rec.atStep === 2, `${tag}: startCoach({force:true}) replays; Done on step 3 persists reason 'done'`, JSON.stringify(force.rec));
    // contextual toasts
    const ct = await pB.evaluate(async () => {
      const ui = window.__twin.ui, texts = () => [...document.querySelectorAll('#toasts .toast span')].map(s => s.textContent);
      const a = ui.coachEvent('catch'); const b = ui.coachEvent('goal', { name: 'Hannah' });
      const t1 = texts();
      await new Promise(r => setTimeout(r, 900)); const c = ui.coachEvent('goal', { name: 'Hannah' }); const d = ui.coachEvent('miss');
      await new Promise(r => setTimeout(r, 900)); const e = ui.coachEvent('miss');
      const t2 = texts(); const cls = [...document.querySelectorAll('#toasts .toast')].map(t => t.className);
      return { a, b, c, d, e, t1, t2, cls };
    });
    ok(ct.a === 'Nice catch' && ct.b === null && ct.t1.join('|') === 'Nice catch', `${tag}: coachEvent('catch') -> "Nice catch" toast; a goal 0 ms later is gated`, ct.t1.join('|'));
    ok(ct.c === 'GOAL for Hannah' && ct.d === null && ct.e === 'Cup lower, palm up' && ct.t2.includes('GOAL for Hannah') && ct.t2.includes('Cup lower, palm up') && ct.cls.some(c => c.includes('toast--warn')), `${tag}: "GOAL for Hannah" then "Cup lower, palm up" (warn) after the gap`, ct.t2.join('|'));
    // attach() to a BallGame-like target
    const at = await pB.evaluate(async () => {
      const ui = window.__twin.ui, tgt = new EventTarget(), got = []; ui.addEventListener('coach', (e) => { if (e.detail.phase === 'toast') got.push(e.detail.text); });
      await new Promise(r => setTimeout(r, 2600));
      const off = ui.coach.attach(tgt, { nameOfSeat: (s) => ['Kenny', 'Hannah', 'Bot-1', 'Clone'][s], mySeat: () => 0 });
      tgt.dispatchEvent(new CustomEvent('ring', { detail: { seat: 1, kind: 'catch' } }));          // not my seat: no toast
      tgt.dispatchEvent(new CustomEvent('ring', { detail: { seat: 0, kind: 'save' } }));
      await new Promise(r => setTimeout(r, 900));
      tgt.dispatchEvent(new CustomEvent('goal', { detail: { seat: 2, goalSeat: 2 } }));
      off(); tgt.dispatchEvent(new CustomEvent('ring', { detail: { seat: 0, kind: 'miss' } }));
      return got;
    });
    ok(at.join('|') === 'Nice catch|GOAL for Bot-1', `${tag}: coach.attach(game): my catch + goal name via nameOfSeat; other seats and detached events ignored`, at.join('|'));
    await pB.evaluate(() => { window.__twin.ui.setTileState('c-002', { loading: false }); });
  }
  const errs = logs.slice(logStart).filter(l => !/favicon|XNNPACK|404/.test(l));
  ok(errs.length === 0, 'B7: no console errors', errs.slice(0, 3).join(' | '));
  await pB.close();
  console.log(`  screenshots: ${SHOT_DIR_V2}/shell-1280.png, shell-994.png, shell-phone.png`);
}
