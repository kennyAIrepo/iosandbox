// mpgames ↔ CLOUD TRACKING LANE probe: opens the page with ?server=<wss>, arms
// the 🧠 engine, feeds a clip when given, and checks the socket goes LIVE with
// zero page errors — on BOTH wire schemas (:8765 kpts/box, :8766 body2D/bbox).
//   node tests/_mpcloudprobe.mjs wss://… [clip.mp4]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const [,, server, clip] = process.argv;
if (!server) { console.log('usage: node tests/_mpcloudprobe.mjs wss://server [clip.mp4]'); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1280,800', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage(); const errors = []; const notFound = [];
page.on('response', r => { if (r.status() === 404) notFound.push(r.url().replace('http://localhost:3333','')); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK|ERR_NAME_NOT_RESOLVED|nba_sample|net::ERR|404/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3333/mpgames.html?server=' + encodeURIComponent(server), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 }); await page.click('#startBtn');
await page.waitForFunction(() => !!window.__mpg, { timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
if (clip && fs.existsSync(clip)) { const inp = await page.$('#srcFile'); if (inp) { await inp.uploadFile(clip); await new Promise(r => setTimeout(r, 2500)); } }
await page.evaluate(() => { const c = document.getElementById('yoloChk'); if (c && !c.checked) c.click(); });
await new Promise(r => setTimeout(r, 20000));
const out = await page.evaluate(() => { const Y = window.__mpg.YOLO; return {
  url: localStorage.getItem('hopeos-yolo-server'), on: Y.on, ws: Y.ws ? Y.ws.readyState : null,
  fresh: (performance.now() - (Y.lastT || 0)) < 2000, players: (Y.players || []).length,
  ids: (Y.players || []).map(p => p.id).slice(0, 10), serverMs: Y.serverMs, profile: Y.profile,
  hud: (document.getElementById('metrics')?.innerText || '').split('\n').filter(l => /YOLO|track/i.test(l)).join(' | ') }; });
await browser.close();
console.log(JSON.stringify({ server, ...out, errors, notFound }, null, 1));
const fail = [];
if (out.ws !== 1) fail.push('socket not open (readyState ' + out.ws + ')');
if (!out.fresh) fail.push('no fresh server replies');
if (errors.length) fail.push(errors.length + ' page error(s)');
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ cloud lane LIVE in mpgames, no page errors');
process.exit(fail.length ? 1 : 0);
