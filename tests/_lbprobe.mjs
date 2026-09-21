/**
 * tests/_lbprobe.mjs — drives tests/_lbprobe.html in headless Chrome: the score UX of sdk/game/leaderboard.js with the real
 * stylesheets (teams-tokens.css + teamslab.css + leaderboard.css). Screenshots to SHOT_DIR (shots-v2), asserts the DOM
 * states the CSS depends on. `node tests/_lbprobe.mjs` from the repo root with the dev server on :3333.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.HOPEOS_BASE || 'http://localhost:3333';
const SHOT_DIR = process.env.SHOT_DIR || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
fs.mkdirSync(SHOT_DIR, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400 && !/favicon.ico$/.test(r.url())) errors.push(r.status() + ' ' + r.url()); });
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + '/tests/_lbprobe.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', { timeout: 10000 });
  const s0 = await page.evaluate(() => window.__lb.state());
  ok(errors.length === 0, 'no page errors on load', errors.join(' | '));
  ok(s0.sectionRows === 3 && s0.chips.length === 3 && s0.round === 1, 'section mounted first in #pane-people with 3 rows; 3 chips; round live', JSON.stringify(s0.rows));
  const first = await page.evaluate(() => document.getElementById('pane-people').firstElementChild.id);
  ok(first === 'leaderboard', 'leaderboard section is the first child of the People pane');

  // seed: Bot-1 2 goals, Kenny 3 catches (streak 3 → flame), Zoë a potato drop
  await page.evaluate(() => window.__lb.seed());
  await sleep(1400);                                        // the seed's two Bot-1 goals celebrate too; let them clear first
  const s1 = await page.evaluate(() => window.__lb.state());
  ok(s1.rows[0].startsWith('1:Bot-1:2G') && s1.rows[1].startsWith('2:Kenny:0G3C3S') && s1.rows[2].startsWith('3:Zoë'), 'ranking Bot-1 > Kenny > Zoë', s1.rows.join(' '));
  const flame = await page.evaluate(() => ({ chip: !!document.querySelector('#scoreboard .sb__seat[data-seat="0"] .lb-flame'), row: !!document.querySelector('.lb__row[data-seat="0"] .lb__flame'), drops: !!document.querySelector('.lb__row[data-seat="2"] .lb__stat--drops') }));
  ok(flame.chip && flame.row && flame.drops, 'streak flame on Kenny chip + row; potato drop stat on Zoë');
  const widths = await page.evaluate(() => [...document.querySelectorAll('.lb__bar i')].map(i => i.style.width));
  ok(widths[0] === '40%' && widths[1] === '0%', 'bars: 2/5 goals = 40 %, 0 %', widths.join(' '));
  await page.screenshot({ path: SHOT_DIR + '/leaderboard-section.png' });

  // goal celebration: chip pulse + tile flash + confetti, mid-animation
  await page.evaluate(() => window.__lb.goal(0));
  await sleep(200);
  const s2 = await page.evaluate(() => window.__lb.state());
  const inTile0 = await page.evaluate(() => document.querySelectorAll('.tile[data-seat="0"] .lb-confetti i').length);
  ok(s2.scoredRows === 1, 'section: the scorer row carries is-scored during the celebration', String(s2.scoredRows));
  ok(s2.flash.join() === '0' && inTile0 === 28 && s2.confetti === 28 && s2.chips.some(c => c.startsWith('Kenny') && c.endsWith('*')), 'goal by Kenny: only tile 0 flashes, 28 confetti sprites inside it, Kenny chip pulsing', JSON.stringify({ flash: s2.flash, confetti: s2.confetti, chips: s2.chips }));
  const ring = await page.evaluate(() => { const r = getComputedStyle(document.querySelector('.tile[data-seat="0"] .tile__ring')); return { bw: r.borderTopWidth, bc: r.borderTopColor, anim: r.animationName }; });
  ok(ring.bw === '4px' && ring.anim === 'lb-flash', 'flash ring: 4 px border in the seat colour, lb-flash animation', JSON.stringify(ring));
  await page.screenshot({ path: SHOT_DIR + '/leaderboard-goal-flash.png' });
  await page.evaluate(() => window.__lb.advance(1300));   // the probe clock is virtual: move it past CELEBRATE_MS
  await sleep(1300);
  const s3 = await page.evaluate(() => window.__lb.state());
  ok(s3.flash.length === 0 && s3.confetti === 0, 'celebration cleared after 1.2 s');
  ok(s3.scoredRows === 0, 'SectionView re-rendered after the celebration: is-scored highlight gone', String(s3.scoredRows));

  // two goals 900 ms apart on the same tile: the second celebration must outlive the first one's cleanup timer
  await page.evaluate(() => window.__lb.goal(2)); await sleep(900); await page.evaluate(() => window.__lb.goal(2)); await sleep(500);
  const ov2 = await page.evaluate(() => ({ flash: document.querySelector('.tile[data-seat="2"]').classList.contains('lb-goal-flash'), layers: document.querySelectorAll('.tile[data-seat="2"] .lb-confetti').length }));
  ok(ov2.flash && ov2.layers === 1, 'overlapping goals on one tile: still flashing 1.4 s after the first, exactly one confetti layer', JSON.stringify(ov2));
  await sleep(1000);
  // round-end card
  await page.evaluate(() => window.__lb.finish());
  await sleep(300);
  const s4 = await page.evaluate(() => window.__lb.state());
  const cardInfo = await page.evaluate(() => { const c = document.querySelector('.lb-card'); const r = c.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(); const inner = c.querySelector('.lb-card__inner').getBoundingClientRect(); return { live: c.getAttribute('aria-live'), role: c.getAttribute('role'), title: c.querySelector('.lb-card__title').textContent, rows: c.querySelectorAll('.lb-card__row').length, centred: Math.abs((inner.left + inner.width / 2) - (st.left + st.width / 2)) < 2 && Math.abs((inner.top + inner.height / 2) - (st.top + st.height / 2)) < 2, focus: document.activeElement.className }; });
  ok(s4.card && s4.round === 2 && cardInfo.role === 'dialog' && cardInfo.live === 'assertive' && cardInfo.title === 'Bot-1 wins' && cardInfo.rows === 3, 'round-end card: dialog, aria-live assertive, "Bot-1 wins", 3 ranked rows', JSON.stringify(cardInfo));
  ok(cardInfo.centred, 'card centred over the gallery (stage)');
  ok(cardInfo.focus.includes('lb-card__again'), 'focus on Play again (host)');
  await page.screenshot({ path: SHOT_DIR + '/leaderboard-round-card.png' });
  await page.keyboard.press('Escape');
  await sleep(50);
  const s5 = await page.evaluate(() => window.__lb.state());
  ok(!s5.card, 'Esc closes the card');
  // Play again resets and restarts
  await page.evaluate(() => { window.__lb.card.show(window.__lb.lb.viewState({ meSeat: 0 })); });
  await page.click('.lb-card__again');
  await sleep(50);
  const s6 = await page.evaluate(() => window.__lb.state());
  ok(!s6.card && s6.round === 1 && s6.rows.every(r => r.endsWith('0G0C0S')), 'Play again: card closed, round live, stats zeroed', s6.rows.join(' '));
  // auto-dismiss (short timer)
  await page.evaluate(() => { window.__lb.card.autoMs = 400; window.__lb.card.show(window.__lb.lb.viewState({ meSeat: 0 })); });
  await sleep(600);
  ok(!(await page.evaluate(() => window.__lb.card.open)), 'card auto-dismisses after autoMs');

  // reduced motion: no confetti, static flash, no pulse animation
  await page.evaluate(() => window.__lb.reduced(true));
  await page.evaluate(() => { const t = document.querySelector('.tile[data-seat="1"]'); window.__lb._c = window.__lb.lb.viewState(); });
  await page.evaluate(() => window.__lb.goal(1));
  await sleep(100);
  const rm = await page.evaluate(() => { const t = document.querySelector('.tile[data-seat="1"]'); const r = getComputedStyle(t.querySelector('.tile__ring')); return { confetti: document.querySelectorAll('.lb-confetti i').length, flash: t.classList.contains('lb-goal-flash'), dur: r.animationDuration, chipDur: getComputedStyle(document.querySelector('#scoreboard .sb__seat[data-seat="1"]')).animationDuration }; });
  const hidden = await page.evaluate(() => { const l = document.querySelector('.tile[data-seat="1"] .lb-confetti'); return l ? getComputedStyle(l).display : 'absent'; });
  const ringAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.tile[data-seat="1"] .tile__ring')).animationName);
  ok(rm.flash && ringAnim === 'none' && rm.chipDur === '0s', 'reduced motion (frame flag): static flash (class on, animation none), no chip pulse animation', JSON.stringify({ ...rm, ringAnim }));
  ok(hidden === 'none', 'confetti layer hidden by the frame flag (display none)', hidden);
  await sleep(1300);

  // narrow frame: nothing overflows horizontally
  await page.setViewport({ width: 472, height: 382 });
  await sleep(100);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  ok(ov.sw <= ov.cw, 'no horizontal scroll at 472x382', JSON.stringify(ov));
  await page.screenshot({ path: SHOT_DIR + '/leaderboard-narrow.png' });
  ok(errors.length === 0, 'no page errors during the probe', errors.join(' | '));
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed; shots in ${SHOT_DIR}`);
process.exit(fail ? 1 : 0);
