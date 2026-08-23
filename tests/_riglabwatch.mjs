/** riglab session watcher — Claude's eyes on the LIVE riglab session.
 *  Reads riglab.journal.jsonl (streamed by the page via POST /journal) and:
 *    digest mode (default):  prints what the user did, newest session last
 *    --shot:                 additionally reproduces the user's latest view
 *                            headless (script + camera + ink/notes) and
 *                            screenshots it to the scratchpad
 *
 *    node tests/_riglabwatch.mjs [--all] [--shot] [--sid <session-id>]
 */
import { readFileSync, existsSync } from 'node:fs';

const JOURNAL = new URL('../riglab.journal.jsonl', import.meta.url);
const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/d1691736-d038-4eac-b4a5-2f5470f754f5/scratchpad';
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

if (!existsSync(JOURNAL)) {
  console.log('no journal yet — open http://localhost:3333/riglab (new server) and interact');
  process.exit(0);
}
const events = readFileSync(JOURNAL, 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const bySid = new Map();
for (const e of events) {
  if (!bySid.has(e.sid)) bySid.set(e.sid, []);
  bySid.get(e.sid).push(e);
}
const sids = [...bySid.keys()];
const pick = opt('--sid') || sids[sids.length - 1];
const show = flag('--all') ? sids : [pick];

const fmt = t => new Date(t).toLocaleTimeString('en-US', { hour12: false });
for (const sid of show) {
  const evs = bySid.get(sid) || [];
  console.log(`\n═══ session ${sid} — ${evs.length} events, ${fmt(evs[0].t)} → ${fmt(evs[evs.length - 1].t)} ═══`);
  for (const e of evs) {
    const d = { ...e }; delete d.sid; delete d.t; delete d.type;
    let line = '';
    switch (e.type) {
      case 'load':       line = `loaded ${e.model} (${e.points} rig points)`; break;
      case 'select':     line = `selected ${e.bone}`; break;
      case 'preset':     line = `preset → ${e.id}`; break;
      case 'play':       line = `▶ ${e.name} (${e.duration?.toFixed?.(1)}s, ${e.tracks} tracks, ${e.oscillators} osc)`; break;
      case 'pause':      line = '⏸'; break;
      case 'stop':       line = '⏹'; break;
      case 'rate':       line = `rate ${e.v}×`; break;
      case 'dragStart':  line = `drag start: ${e.bone}`; break;
      case 'dragEnd':    line = e.discarded ? `drag discarded (${e.bone})`
                                : `PATH TRACK: ${e.bone} — ${e.samples} samples over ${e.seconds?.toFixed(1)}s`; break;
      case 'scriptEdit': line = `script edited → "${e.script?.name ?? '(invalid json)'}"`; break;
      case 'stack':      line = `stacked "${e.name}" (film now ${e.count})`; break;
      case 'film':       line = `🎬 film: [${e.sessions?.join(' → ')}] ${e.duration?.toFixed(1)}s`; break;
      case 'clearStack': line = 'film stack cleared'; break;
      case 'annoMode':   line = `annotate ${e.on ? 'ON' : 'off'}`; break;
      case 'annoStroke': line = `✏ ink stroke (${e.pts.length} pts)`; break;
      case 'annoNote':   line = `🗒 NOTE @(${e.x},${e.y}): "${e.text}"`; break;
      case 'annoClear':  line = 'ink cleared'; break;
      case 'camera':     line = `camera → pos [${e.pos}] target [${e.target}]`; break;
      default:           line = JSON.stringify(d);
    }
    console.log(`  ${fmt(e.t)}  ${line}`);
  }
}

// ── --shot: reproduce the picked session's latest state headless ──
if (flag('--shot')) {
  const evs = bySid.get(pick) || [];
  const last = type => [...evs].reverse().find(e => e.type === type);
  const scriptEv = [last('play'), last('scriptEdit')].filter(Boolean).sort((a, b) => a.t - b.t).pop();
  const script = scriptEv?.script?.duration ? scriptEv.script : null;
  const cam = last('camera');
  const inkEvents = [];
  for (const e of evs) {
    if (e.type === 'annoClear') inkEvents.length = 0;
    if (e.type === 'annoStroke') inkEvents.push({ kind: 'stroke', pts: e.pts });
    if (e.type === 'annoNote') inkEvents.push({ kind: 'note', x: e.x, y: e.y, text: e.text });
  }
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--window-size=1400,900', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto('http://localhost:3333/riglab', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /playing|rig points/.test(document.getElementById('status').textContent),
    { timeout: 60000 });
  await page.evaluate(({ cam, inkEvents, script }) => {
    const R = window.__riglab;
    if (cam) R.setCamera(cam.pos, cam.target);
    if (script) R.setScript(script);
    R.replayAnno(inkEvents);
  }, { cam, inkEvents, script });
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: `${SHOT_DIR}/riglab_session.png` });
  console.log(`\nshot (their view, replayed): ${SHOT_DIR}/riglab_session.png` +
    ` — camera ${cam ? 'restored' : 'default'}, ${inkEvents.length} annotations`);
  await browser.close();
}
