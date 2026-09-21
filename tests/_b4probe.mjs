/**
 * tests/_b4probe.mjs — browser probe for B4 (voice -> real 3D model): opens tests/_b4probe.html on the dev server (:3333),
 * which spawns through the REAL SceneExecutor + ModelFetcher in a WebGL scene: 'tennis ball' (catalog, B2 visuals),
 * 'rubber duck' (Sketchfab via the proxy when ?proxy=3334 is given and SKETCHFAB_TOKEN is set; else the labelled
 * placeholder fallback), 'arrow' (bundled GLB through GLTFLoader from the CDN importmap). Screenshot -> shots-v2/b4-probe.png.
 *
 *   node tests/_b4probe.mjs [--proxy=3334] [--word="coffee mug"]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || '1'] : [a, '1']; }));
const SHOTS = process.env.B4_SHOTS || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/shots-v2';
mkdirSync(SHOTS, { recursive: true });
const q = new URLSearchParams();
if (args.proxy) q.set('proxy', args.proxy);
if (args.word) q.set('word', args.word);
const URL_ = `http://localhost:3333/tests/_b4probe.html${q.toString() ? '?' + q : ''}`;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--no-sandbox', '--window-size=900,600'],
});
let code = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 160)); });
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__b4 && window.__b4.ready && window.__b4.frames > 10, { timeout: 60000 });
  await new Promise(r => setTimeout(r, 400));
  const out = await page.evaluate(() => ({ props: window.__b4.props(), results: window.__b4.results, statuses: window.__b4.statuses.map(s => `${s.kind}:${s.phase}:${s.tier || ''}${s.progress != null ? ':' + Math.round(s.progress * 100) + '%' : ''}${s.error ? ':' + s.error : ''}`), frames: window.__b4.frames }));
  await page.screenshot({ path: SHOTS + '/b4-probe.png' });
  console.log('frames', out.frames);
  console.log('props', JSON.stringify(out.props));
  console.log('results', JSON.stringify(Object.fromEntries(Object.entries(out.results).map(([k, r]) => [k, { ok: r.ok, id: r.id, size_m: r.size_m, attach: r.attach, model: r.model, reason: r.reason }]))));
  console.log('statuses', out.statuses.join(' | '));
  console.log('errors', errors.length ? errors.join('\n  ') : 'none');
  const tennis = out.props.find(p => p.kind === 'tennis ball'), arrow = out.props.find(p => p.kind === 'arrow'), duck = out.props.find(p => p.id === out.results.duck.id);
  const pass = tennis && tennis.status === 'ready' && tennis.tier === 'catalog' && arrow && arrow.status === 'ready' && arrow.tier === 'bundled' && arrow.hull > 3 && duck && (duck.status === 'ready' || duck.status === 'fallback') && !errors.some(e => /pageerror/.test(e));
  console.log(pass ? 'B4 PROBE PASS' : 'B4 PROBE FAIL', '-> ' + SHOTS + '/b4-probe.png');
  code = pass ? 0 : 1;
} catch (e) { console.error('probe error', e.message); code = 2; }
finally { await browser.close(); }
process.exit(code);
