// integrator probe: node intprobe.mjs solo|realhand|4tiles   (reuses :3333; hard timeout)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const MODE = process.argv[2] || 'solo';
const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--no-sandbox', '--window-size=1280,800'];
const FILTER = /favicon|XNNPACK|404|BVH not available|three-mesh-bvh|Autoplay|GPU stall|WebGL warning|TensorFlow|INFO: Created TensorFlow|GL_INVALID|OpenGL ES|Overriding|deprecated/i;
const Q = {
  solo: 'auto=1&fixedstep=1&consent=1&transport=loopback&tiles=1&agent=local&nosfx=1',
  realhand: 'auto=1&fixedstep=1&consent=1&transport=loopback&tiles=1&clip=tests/fixtures/clips/7530258985595248-WATER.mp4&agent=local&nosfx=1',
  '4tiles': 'auto=1&fixedstep=1&consent=1&transport=loopback&tiles=3&clone=1&bot=1&agent=local&nosfx=1',
  coach: 'auto=1&fixedstep=1&consent=1&transport=loopback&tiles=3&clone=1&bot=1&agent=local&nosfx=1&coach=1',
  coach2: 'auto=1&fixedstep=1&consent=1&transport=loopback&tiles=2&clone=1&agent=local&nosfx=1&coach=1',
};
const URL_ = `http://localhost:3333/teamslab.html?${Q[MODE]}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r3 = v => (typeof v === 'number' ? +v.toFixed(3) : v);
const hard = setTimeout(() => { console.error('HARD TIMEOUT'); process.exit(2); }, 120000);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const logs = [];
let code = 1;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('console', m => { const t = m.type(), text = m.text(); if (text.startsWith('AUTOTEST ')) return; if ((t === 'error' || t === 'warning') && !FILTER.test(text)) logs.push(`[${t}] ${text.slice(0, 300)}`); });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  console.log('[boot]', URL_);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__twin && window.__twin.ready === true, { timeout: 90000 });
  const readyAt = Date.now();
  const boot = await page.evaluate(() => ({ error: __twin.S.boot.error, stage: __twin.S.boot.stage, me: __twin.S.me.clientId, tiles: __twin.S.tiles.size }));
  console.log('[boot]', JSON.stringify(boot));
  const snapLine = () => page.evaluate(() => { const s = __twin.snapshot(); const b = __twin.game.ball; const sh = __twin.game.shelfOf(__twin.net.simSeat >= 0 ? __twin.net.simSeat : 0);
    return { t: Math.round(performance.now()), phase: s.phase, seatMap: s.seatMap && s.seatMap.v, netSeat: __twin.net.seat, owner: s.game && s.game.owner, isOwner: s.game && s.game.isOwner, running: __twin.game.running, mode: s.mode,
      ball: { x: r3(b.pos.x), y: r3(b.pos.y), z: r3(b.pos.z), vis: b.mesh.visible, r: b.sphere.radius, floorY: r3(b.floorY), onShelf: Math.abs(b.pos.y - (b.floorY + b.sphere.radius)) < 0.004, name: b.mesh.name }, radiusM: s.ball && __twin.game.radiusM, shelfFrac: __twin.game.shelfFrac, shelves: __twin.game.shelves.size, shelfVisible: !!(sh && sh.visible), halo: !!(__twin.S.ballFx), chip: (document.querySelector('.tile__handstate') || {}).hidden, contexts: s.contexts, frames: s.frames };
    function r3(v) { return +v.toFixed(3); } });
  if (MODE === 'solo') {
    let ok = false, last = null;
    for (let i = 0; i < 40; i++) { await sleep(250); last = await snapLine(); if (last.ball.vis && last.ball.onShelf && last.phase === 'floor') { ok = true; break; } }
    const pageDt = await page.evaluate(() => Math.round(performance.now() - __twin.S.boot.readyAt));
    const firstFloor = await page.evaluate(() => { const e = __twin.events.find(x => x.ev === 'phase' && x.d && x.d.to === 'floor'); return e ? Math.round(e.tl - __twin.S.boot.readyAt) : null; });
    const dt = firstFloor ?? pageDt;
    console.log('[solo] page-side: first floor phase ' + firstFloor + ' ms after ready (probe saw it at ' + pageDt + ' ms)');
    console.log(`[solo] ball on shelf within 3 s: ${ok} (after ${dt} ms)`, JSON.stringify(last));
    await sleep(800);
    await page.screenshot({ path: `${SHOT_DIR}/int-solo.png` });
    code = ok && dt <= 3000 ? 0 : 1;
  } else if (MODE === 'realhand') {
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      const s = await page.evaluate(() => { const g = __twin.game, b = g.ball, me = __twin.tiles.get(__twin.S.me.clientId); const L = g.handState('left'), R = g.handState('right');
        const pk = me.packs.R || me.packs.L; const ys = pk ? pk.map(p => p.y) : null;
        return { t: Math.round(performance.now()), hands: me.packs.hands.length, L: { present: L.present, pose: L.pose, touching: L.touching, hold: L.hold, holdPose: L.holdPose, pocketDist: L.pocketDist, why: L.why }, R: { present: R.present, pose: R.pose, touching: R.touching, hold: R.hold, holdPose: R.holdPose, pocketDist: R.pocketDist, why: R.why },
          handY: ys ? { min: +Math.min(...ys).toFixed(3), max: +Math.max(...ys).toFixed(3), palm: +pk[9].y.toFixed(3) } : null, ball: { x: +b.pos.x.toFixed(3), y: +b.pos.y.toFixed(3), z: +b.pos.z.toFixed(3), vis: b.mesh.visible }, phase: g.phase, chip: (document.querySelector('.tile__handstate-text') || {}).textContent }; });
      samples.push(s); await sleep(200);
    }
    const present = samples.filter(s => s.hands > 0);
    const cupped = samples.filter(s => ['cupped', 'closed'].includes(s.L.pose) && s.L.present || ['cupped', 'closed'].includes(s.R.pose) && s.R.present);
    const touching = samples.filter(s => s.L.touching || s.R.touching);
    const held = samples.filter(s => s.L.hold || s.R.hold);
    const ys = present.map(s => s.handY).filter(Boolean);
    const ballY = samples.map(s => s.ball.y);
    console.log(`[realhand] samples ${samples.length}, hands present ${present.length}, pose cupped/closed ${cupped.length}, touching ${touching.length}, held ${held.length}`);
    console.log(`[realhand] hand y range ${ys.length ? Math.min(...ys.map(y => y.min)).toFixed(3) + '..' + Math.max(...ys.map(y => y.max)).toFixed(3) + ' (palm ' + Math.min(...ys.map(y => y.palm)).toFixed(3) + '..' + Math.max(...ys.map(y => y.palm)).toFixed(3) + ')' : 'n/a'} vs ball y ${Math.min(...ballY).toFixed(3)}..${Math.max(...ballY).toFixed(3)}`);
    console.log('[realhand] poses R:', JSON.stringify(samples.map(s => s.R.present ? s.R.pose[0] : '.').join('')), 'L:', JSON.stringify(samples.map(s => s.L.present ? s.L.pose[0] : '.').join('')));
    console.log('[realhand] chips:', JSON.stringify([...new Set(samples.map(s => s.chip))]));
    console.log('[realhand] sample whys:', JSON.stringify([...new Set(present.map(s => (s.R.present ? s.R : s.L).why))].slice(0, 8)));
    await page.screenshot({ path: `${SHOT_DIR}/int-realhand.png` });
    code = 0;
  } else if (MODE.startsWith('coach')) {
    await page.waitForFunction(() => window.__twin.S.seatMap && window.__twin.frames > 30, { timeout: 30000, polling: 300 }).catch(() => {});
    await sleep(2500);
    const rep = await page.evaluate(() => {
      const F = document.querySelector('.tw-frame').getBoundingClientRect(), c = document.querySelector('.coach'); if (!c) return { card: null };
      const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left - F.left), y: Math.round(r.top - F.top), w: Math.round(r.width), h: Math.round(r.height) }; };
      const me = document.querySelector('.tile[data-client="' + __twin.S.me.clientId + '"]');
      const others = [...document.querySelectorAll('.tile')].filter(t => t !== me).map(R);
      const card = R(c), tile = R(me), tr = R(me.querySelector('.tile__tr'));
      const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      return { card, tile, tr, step: c.dataset.step, insideTile: card.x >= tile.x && card.y >= tile.y && card.x + card.w <= tile.x + tile.w && card.y + card.h <= tile.y + tile.h, overlapsOthers: others.map(o => inter(card, o)), overlapsTr: inter(card, tr), text: c.querySelector('.coach__text').textContent };
    });
    console.log('[coach]', JSON.stringify(rep));
    await page.screenshot({ path: SHOT_DIR + '/int-' + MODE + '.png' });
    code = rep.card && rep.insideTile && rep.overlapsOthers.every(v => v === 0) && rep.overlapsTr === 0 ? 0 : 1;
  } else {
    await page.waitForFunction(() => window.__twin.S.seatMap && window.__twin.S.seatMap.seats.length === 4 && window.__twin.frames > 30, { timeout: 30000 }).catch(() => {});
    await sleep(3000);
    const s = await snapLine();
    console.log('[4tiles]', JSON.stringify(s));
    await page.screenshot({ path: `${SHOT_DIR}/int-4tiles.png` });
    code = s.ball.vis ? 0 : 1;
  }
  if (logs.length) console.log('[console]', logs.slice(0, 10).join('\n'));
} catch (e) { console.error('PROBE ERROR', e); code = 1; }
finally { clearTimeout(hard); await browser.close().catch(() => {}); }
process.exit(code);
