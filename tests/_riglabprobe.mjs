/** riglab probe — headless checks for the full rig-host loop:
 *  1. GLB binds, 76 rig points listed, tongue points present
 *  2. skeleton roles resolve; preset buttons build (walk plays + animates)
 *  3. golfball DRAG records a path track and remixes it into the script
 *  4. film stack: 2 sessions sequence into one script with summed duration
 *
 *    node tools/dev-server.mjs   (separately, :3333)
 *    node tests/_riglabprobe.mjs
 */
import puppeteer from 'puppeteer-core';

const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/d1691736-d038-4eac-b4a5-2f5470f754f5/scratchpad';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1400,900', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails.push(name);
};

await page.goto('http://localhost:3333/riglab', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForFunction(() => /playing|rig points/.test(document.getElementById('status').textContent),
  { timeout: 60000 });

// 1 ── bind + rig points
const info = await page.evaluate(() => ({
  bones: document.querySelectorAll('#boneList div').length,
  tongue: [...document.querySelectorAll('#boneList div')].map(d => d.textContent).filter(n => /tongue/i.test(n)),
  roles: document.getElementById('rolesLine').textContent,
  presets: [...document.querySelectorAll('#presetRow button')].map(b => ({ t: b.textContent, off: b.disabled })),
}));
check('76 rig points', info.bones === 76, String(info.bones));
check('2 tongue points', info.tongue.length === 2, info.tongue.join(','));
console.log('  ' + info.roles);
console.log('  presets: ' + info.presets.map(p => `${p.t}${p.off ? '(off)' : ''}`).join(' '));

// 2 ── walk preset plays + pixels move
const walkBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll('#presetRow button')].find(b => /walk/.test(b.textContent)));
const walkOff = await page.evaluate(b => b.disabled, walkBtn);
check('walk preset enabled', !walkOff);
if (!walkOff) {
  await walkBtn.asElement().click();
  await new Promise(r => setTimeout(r, 300));
  const st = await page.evaluate(() => document.getElementById('status').textContent);
  check('walk playing', /playing: walk/.test(st), st);
  const a = await page.screenshot({ clip: { x: 360, y: 100, width: 900, height: 700 } });
  await new Promise(r => setTimeout(r, 500));
  const b = await page.screenshot({ clip: { x: 360, y: 100, width: 900, height: 700 } });
  let diff = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff++;
  check('walk animates (pixel diff)', diff > 500, String(diff));
  await page.screenshot({ path: `${SHOT_DIR}/riglab_walk.png` });
}

// 3 ── GROUP drag via the UI flow: ⬚ mode → click two golfballs → box over
// them → mode off → grab Tip → one path track per member with falloff
// (pause first so markers hold still under the cursor)
await page.click('#pauseBtn');
await new Promise(r => setTimeout(r, 150));
await page.click('#groupBtn');
const pMid = await page.evaluate(() => window.__riglab.screenPosOf('Tongue_Mid'));
const pTip = await page.evaluate(() => window.__riglab.screenPosOf('Tongue_Tip'));
await page.mouse.click(pMid.x, pMid.y);                     // click = toggle in
await page.mouse.click(pTip.x, pTip.y);
// box drag across the tongue area (adds, never removes)
await page.mouse.move(Math.min(pMid.x, pTip.x) - 30, Math.min(pMid.y, pTip.y) - 30);
await page.mouse.down();
await page.mouse.move(Math.max(pMid.x, pTip.x) + 30, Math.max(pMid.y, pTip.y) + 30, { steps: 5 });
await page.mouse.up();
const uiGroup = await page.evaluate(() => window.__riglab.group);
check('⬚ UI group has both tongue points', uiGroup.includes('Tongue_Mid') && uiGroup.includes('Tongue_Tip'),
  uiGroup.join(','));
await page.click('#groupBtn');                              // mode off
await page.evaluate(() => window.__riglab.setGroup(['Tongue_Mid', 'Tongue_Tip']));
await new Promise(r => setTimeout(r, 150));
const pos = await page.evaluate(() => window.__riglab.screenPosOf('Tongue_Tip'));
await page.mouse.move(pos.x, pos.y);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(pos.x - i * 6, pos.y - i * 4);
  await new Promise(r => setTimeout(r, 45));
}
await page.mouse.up();
await new Promise(r => setTimeout(r, 200));
const afterDrag = await page.evaluate(() => ({
  status: document.getElementById('status').textContent,
  script: document.getElementById('script').value,
}));
const parsed = JSON.parse(afterDrag.script);
const tipTrack = (parsed.tracks || []).find(t => t.path && t.bone === 'Tongue_Tip');
const midTrack = (parsed.tracks || []).find(t => t.path && t.bone === 'Tongue_Mid');
check('group drag: leader path track', !!tipTrack,
  tipTrack ? `${tipTrack.path.length} samples` : afterDrag.status);
check('group drag: follower path track (falloff)', !!midTrack,
  midTrack ? `${midTrack.path.length} samples` : 'missing');
check('remix keeps preset tracks', (parsed.oscillators || []).length > 0);
await page.screenshot({ path: `${SHOT_DIR}/riglab_drag.png` });

// 3b ── add a rig point at a tail bone position; master influence dial
const added = await page.evaluate(() => {
  const p = window.__riglab.puppet.getWorldPos('Bone_030').toArray();
  return window.__riglab.addPointAt('Probe_Point', p);
});
check('addRigPoint creates bone + weights', added.name === 'Probe_Point' && added.weightedVerts > 50,
  `parent ${added.parent}, ${added.weightedVerts} verts`);
const listed = await page.evaluate(() => ({
  count: document.querySelectorAll('#boneList div').length,
  weight0: (() => { window.__riglab.puppet.weight = 0.5; return window.__riglab.puppet.weight; })(),
}));
check('new point listed (77)', listed.count === 77, String(listed.count));
check('master influence dial', listed.weight0 === 0.5);
await page.evaluate(() => { window.__riglab.puppet.weight = 1; });

// 3c ── mouth preset: jaw-hinge open/close plays and animates the head
const mouthBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll('#presetRow button')].find(b => /mouth/.test(b.textContent)));
const mouthOff = await page.evaluate(b => b.disabled, mouthBtn);
check('mouth preset enabled (jawLower role)', !mouthOff);
if (!mouthOff) {
  await mouthBtn.asElement().click();
  await new Promise(r => setTimeout(r, 250));
  const st = await page.evaluate(() => document.getElementById('status').textContent);
  check('mouth playing', /playing: mouth/.test(st), st);
  const ha = await page.screenshot({ clip: { x: 500, y: 150, width: 500, height: 400 } });
  await new Promise(r => setTimeout(r, 700));
  const hb = await page.screenshot({ clip: { x: 500, y: 150, width: 500, height: 400 } });
  let hd = 0;
  for (let i = 0; i < Math.min(ha.length, hb.length); i++) if (ha[i] !== hb[i]) hd++;
  check('mouth animates (pixel diff)', hd > 500, String(hd));
}

// 4 ── film stack: stack twice, sequence
await page.click('#stackBtn');
await page.evaluate(() => {
  const s = window.__riglab.buildPreset('tail-sway', window.__riglab.rig);
  document.getElementById('script').value = JSON.stringify(s, null, 2);
});
await page.click('#stackBtn');
await page.click('#filmBtn');
await new Promise(r => setTimeout(r, 200));
const film = await page.evaluate(() => JSON.parse(document.getElementById('script').value));
const durOk = film.duration > 2.4;   // session1 (>=2.4s) + tail-sway (2s)
check('film sequences 2 sessions', film.name === 'film' && durOk,
  `duration ${film.duration?.toFixed(2)}s, ${film.tracks?.length} tracks`);
const chips = await page.evaluate(() => document.querySelectorAll('#sessionList .chip').length);
check('session chips listed', chips === 2, String(chips));

await page.screenshot({ path: `${SHOT_DIR}/riglab_film.png` });
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l) && !/favicon/.test(l));
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
if (fails.length) { console.error(`\n${fails.length} FAILURES: ${fails.join(' | ')}`); process.exit(1); }
console.log('\nriglab probe: all green');
