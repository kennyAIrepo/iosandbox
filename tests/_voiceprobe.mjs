// 🎙 VOICE in the MIRROR lane: the LISTEN button degrades to a state headless; "ball"
// spawns the basketball and flies it to the holo hands with the CATCH! glyph; props
// spawn by name; the chips run the same intake. needs: npm run serve
import puppeteer from 'puppeteer-core';
import os from 'node:os'; import path from 'node:path';
const URL = process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await b.newPage(); await page.setViewport({ width: 1300, height: 900 });
const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK|404|Failed to load resource/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 }); await page.click('#startBtn');
await page.waitForFunction(() => window.__lab?.S?.running, { timeout: 120000 }); await sleep(600);
const out = {};
await page.click('#voiceBtn'); await sleep(400);
out.listen = await page.evaluate(() => ({ state: window.__lab.voice.state, btn: document.getElementById('voiceBtn').textContent.trim(), stat: document.getElementById('voiceStat').textContent.slice(0, 60),
  cue: document.getElementById('engBallCueBig').textContent, glyph: window.__lab.cues.current.gesture }));
// an open hand in the mirror workspace, then "ball"
await page.evaluate(() => {
  const L = window.__lab, T3 = L.THREE, V = (x, y, z) => ({ x, y, z });
  const c = L.camera.position.clone().add(new T3.Vector3(0.15, -0.1, -1.6));
  const p = new Array(21).fill(0).map(() => V(c.x, c.y, c.z));
  p[0] = V(c.x, c.y - 0.05, c.z); p[9] = V(c.x, c.y + 0.05, c.z); p[5] = V(c.x + 0.035, c.y + 0.04, c.z); p[13] = V(c.x, c.y + 0.045, c.z); p[17] = V(c.x - 0.035, c.y + 0.04, c.z);
  for (const [i, dx] of [[8, 0.035], [12, 0.008], [16, -0.02], [20, -0.045]]) p[i] = V(c.x + dx, c.y + 0.15, c.z);
  for (const [i, dx] of [[7, 0.035], [11, 0.008], [15, -0.02], [19, -0.045]]) p[i] = V(c.x + dx, c.y + 0.11, c.z);
  for (const [i, dx] of [[6, 0.035], [10, 0.008], [14, -0.02], [18, -0.045]]) p[i] = V(c.x + dx, c.y + 0.08, c.z);
  p[4] = V(c.x + 0.085, c.y + 0.02, c.z); p[3] = V(c.x + 0.07, c.y - 0.01, c.z); p[2] = V(c.x + 0.05, c.y - 0.03, c.z); p[1] = V(c.x + 0.03, c.y - 0.045, c.z);
  window.__hand = c; L.AVSYNC.ovPose = null; L.AVSYNC.ovPacks = { L: null, R: p };
});
await sleep(300);
out.said = await page.evaluate(() => { const cmd = window.__lab.say('ball'); return { cmd, stat: document.getElementById('voiceStat').textContent.slice(0, 80), pill: document.querySelector('#engBallVoice .cmd').textContent }; });   // read at once: the ball's GLB load outlasts the pill
await page.waitForFunction(() => window.__lab.basket.on && window.__lab.basket.ball, { timeout: 60000 });
await sleep(350);
out.flight = await page.evaluate(() => { const B = window.__lab.basket.ball, h = window.__hand; return { vel: +B.sphere.vel.length().toFixed(2), dist: +B.sphere.pos.distanceTo(h).toFixed(3),
  cue: document.getElementById('engBallCueBig').textContent, glyph: window.__lab.cues.current.gesture, glyphSvg: !!document.querySelector('#engBallCueGlyph svg .hand-l'), bar: document.getElementById('engBallPhase').textContent,
  stat: document.getElementById('voiceStat').textContent.slice(0, 80), pill: document.querySelector('#engBallVoice .cmd').textContent }; });
await sleep(1800);
out.arrived = await page.evaluate(() => { const B = window.__lab.basket.ball, h = window.__hand; return { held: !!B.hold, dist: +B.sphere.pos.distanceTo(h).toFixed(3), zone: B.zone }; });
await page.screenshot({ path: path.join(process.env.PROBE_SHOTS || os.tmpdir(), 'voice-mirror.png') });
// props by name, and a chip
out.cube = await page.evaluate(async () => { window.__lab.say('cube'); await new Promise(r => setTimeout(r, 400)); return { on: window.__lab.S && !!document.querySelector('#cubeBtn.on') }; });
out.slime = await page.evaluate(async () => { document.querySelector('#voiceCmds [data-cmd="slime"]').click(); await new Promise(r => setTimeout(r, 400)); return { on: window.__lab.slime.on, lastCmd: window.__lab.voice.lastCmd }; });
out.stop = await page.evaluate(() => { window.__lab.voice.stop(); return { state: window.__lab.voice.state, btn: document.getElementById('voiceBtn').textContent.trim() }; });
await page.evaluate(() => { window.__lab.AVSYNC.ovPose = undefined; window.__lab.AVSYNC.ovPacks = undefined; });
const R = out;
const checks = {
  'LISTEN degrades to a state headless (no throw) and cues LISTENING with the mic glyph': ['listening', 'starting', 'unsupported', 'denied', 'error', 'paused'].includes(R.listen.state) && /LISTENING|NO MICROPHONE/.test(R.listen.cue) && R.listen.glyph === 'listen',
  '"ball" → the basketball spawns and flies toward the holo hand': R.said.cmd === 'ball' && R.flight.vel > 0.5,
  'CATCH! with the catch glyph, the bar says CATCH': R.flight.cue === 'CATCH!' && R.flight.glyph === 'catch' && R.flight.glyphSvg && R.flight.bar === 'CATCH',
  'the status line and the pill show the command': /BALL/.test(R.said.stat) && /ball/i.test(R.said.pill),
  'it arrives in the hand (held, or within a palm)': R.arrived.held || R.arrived.dist < 0.3,
  '"cube" spawns the cube by name': R.cube.on === true,
  'a chip runs the same intake ("slime")': R.slime.on === true && R.slime.lastCmd === 'slime',
  'stop → off, the button reads LISTEN': R.stop.state === 'off' && /LISTEN/.test(R.stop.btn),
  'no page errors': errors.length === 0,
};
console.log(JSON.stringify(out, null, 1)); console.log('errors:', errors.length ? errors.slice(0, 4) : 'none');
for (const [k, v] of Object.entries(checks)) console.log((v ? '  ok   ' : '  FAIL ') + k);
const ok = Object.values(checks).every(Boolean); console.log(ok ? 'VOICE PROBE OK' : 'VOICE PROBE FAILED');
await b.close(); process.exit(ok ? 0 : 1);
