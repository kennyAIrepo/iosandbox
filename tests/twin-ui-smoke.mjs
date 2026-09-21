/**
 * twin-ui-smoke.mjs — sdk/game/twin-ui.js, headless Node (node tests/twin-ui-smoke.mjs).
 *   [1] fixed169(n, W, H) reproduces every row of R/ui/scripts/gallery-grid-results.txt for n = 1..9 at
 *       994x678, 918x540, 1280x720, 1920x1080 (the table is embedded; the research file is cross-checked when reachable)
 *   [2] the 8 text/background token pairs teamslab.css uses pass WCAG 4.5:1 — the ratio formula is the one in
 *       R/ui/scripts/contrast.mjs, the hex values are read from sdk/ui/teams-tokens.css (.tw-meeting = dark theme)
 *   [3] the API-tab row model has all 12 layers of SPEC §8, each with a pill in {demo, seam, probe first}
 *   [4] strings: C1 / C3 / C4 / C7 / C10 present verbatim; key map covers SPEC §5
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixed169, API_ROWS, STRINGS, KEY_ACTIONS, CONSENT_VERSION, HAND_STATES, handStateLabel, summarizeHandStates, SLIDERS, sliderValue, bindSlider,
  HOLOHANDS_MODES, HOLOHANDS_STORE, HOLOHANDS_FADE_MS, HoloHandsControl, computeHoloHandsShown, nextHoloHandsMode, holoHandsMode } from '../sdk/game/twin-ui.js';
import { CoachSequence, COACH_STEPS, COACH_TOASTS, COACH_VERSION, COACH_KEY, ToastGate, memoryStorage } from '../sdk/game/coach.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH = process.env.HOPEOS_RESEARCH || 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/research';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? ' ' + extra : '')); } };

// ---------------------------------------------------------------------------------------------------------
console.log('\n[1] fixed169 vs gallery-grid-results.txt');
// rows: [rows, cols, tw, th, padX, padY] for n = 1..9 (R/ui/scripts/gallery-grid-results.txt, fixed-16:9 columns)
const EXPECTED = {
  '994x678': [[1, 1, 994, 559, 0, 59], [2, 1, 595, 335, 199, 0], [2, 2, 493, 277, 0, 58], [2, 2, 493, 277, 0, 58], [3, 2, 392, 220, 101, 1], [3, 2, 392, 220, 101, 1], [3, 3, 326, 183, 0, 56], [3, 3, 326, 183, 0, 56], [3, 3, 326, 183, 0, 56]],
  '918x540': [[1, 1, 918, 516, 0, 12], [1, 2, 455, 255, 0, 142], [2, 2, 455, 255, 0, 11], [2, 2, 455, 255, 0, 11], [2, 3, 300, 169, 1, 97], [2, 3, 300, 169, 1, 97], [3, 3, 300, 169, 1, 8], [3, 3, 300, 169, 1, 8], [3, 3, 300, 169, 1, 8]],
  '1280x720': [[1, 1, 1280, 720, 0, 0], [1, 2, 636, 357, 0, 181], [2, 2, 632, 355, 4, 1], [2, 2, 632, 355, 4, 1], [2, 3, 421, 237, 0, 119], [2, 3, 421, 237, 0, 119], [3, 3, 417, 234, 6, 1], [3, 3, 417, 234, 6, 1], [3, 3, 417, 234, 6, 1]],
  '1920x1080': [[1, 1, 1920, 1080, 0, 0], [1, 2, 956, 537, 0, 271], [2, 2, 952, 536, 4, 0], [2, 2, 952, 536, 4, 0], [2, 3, 634, 357, 1, 179], [2, 3, 634, 357, 1, 179], [3, 3, 630, 354, 7, 1], [3, 3, 630, 354, 7, 1], [3, 3, 630, 354, 7, 1]],
};
let rowsChecked = 0;
for (const [rect, rows] of Object.entries(EXPECTED)) {
  const [W, H] = rect.split('x').map(Number);
  let allOk = true, bad = [];
  rows.forEach((exp, i) => {
    const n = i + 1, f = fixed169(n, W, H, 8), got = [f.rows, f.cols, f.tw, f.th, f.padX, f.padY];
    rowsChecked++;
    if (got.join() !== exp.join()) { allOk = false; bad.push(`n=${n} got ${got.join('x')} exp ${exp.join('x')}`); }
  });
  ok(allOk, `${rect}: n=1..9 rows x cols, tile px, pad all match`, bad.join('; '));
}
ok(rowsChecked === 36, 'checked 36 rows (4 rectangles x 9 tile counts)');
// cross-check the embedded table against the research file when reachable
const resFile = path.join(RESEARCH, 'ui/scripts/gallery-grid-results.txt');
if (fs.existsSync(resFile)) {
  const txt = fs.readFileSync(resFile, 'utf8');
  let cur = null, parsed = 0, mismatch = [];
  for (const line of txt.split(/\r?\n/)) {
    const h = line.match(/^== (?:stage )?(\d+)x(\d+)/); if (h) { cur = `${h[1]}x${h[2]}`; continue; }
    const m = line.match(/^\s*(\d) \|.*\|\s*(\d)x(\d)\s+(\d+)x(\d+)\s+pad (\d+),(\d+)/);
    if (!m || !cur) continue;
    const [, n, r, c, tw, th, px, py] = m.map(Number); parsed++;
    const exp = EXPECTED[cur]?.[n - 1];
    if (!exp || exp.join() !== [r, c, tw, th, px, py].join()) mismatch.push(`${cur} n=${n}`);
  }
  ok(parsed === 36 && mismatch.length === 0, `research gallery-grid-results.txt parsed (${parsed} rows) and equals the embedded table`, mismatch.join(', '));
} else console.log('  skip research gallery-grid-results.txt not reachable (HOPEOS_RESEARCH)');
ok(fixed169(3, 994, 678).cols === 2 && fixed169(3, 994, 678).rows === 2, 'n=3 -> 2x2 (incomplete last row is centred by TwinUI.layout)');

// ---------------------------------------------------------------------------------------------------------
console.log('\n[2] contrast of the token pairs teamslab.css uses (WCAG 2.2, formula from R/ui/scripts/contrast.mjs)');
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const la = lum(hex(a)), lb = lum(hex(b)); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
const over = (rgb, a, bg) => { const B = hex(bg); return '#' + rgb.map((c, i) => Math.round(c * a + B[i] * (1 - a)).toString(16).padStart(2, '0')).join(''); };
// read the dark (.tw-meeting) token block from the generated CSS — the meeting frame is always dark
const css = fs.readFileSync(path.join(REPO, 'sdk/ui/teams-tokens.css'), 'utf8');
const darkStart = css.indexOf(':root[data-theme="dark"], .tw-theme-dark, .tw-meeting {');
const darkBlock = css.slice(darkStart, css.indexOf('\n}', darkStart));
const tok = (name) => { const m = darkBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`)); return m?.[1]; };
ok(darkStart > 0 && tok('colorNeutralBackground3') === '#1f1f1f' && tok('colorNeutralForeground1') === '#ffffff', 'dark token block found (.tw-meeting = teamsDarkTheme)', `${tok('colorNeutralBackground3')} / ${tok('colorNeutralForeground1')}`);
const PAIRS = [
  ['topbar / control bar text: fg1 on bg3 (--tw-window-bg)', tok('colorNeutralForeground1'), tok('colorNeutralBackground3')],
  ['stage letterbox text: fg1 on bg4 (--tw-stage-bg)', tok('colorNeutralForeground1'), tok('colorNeutralBackground4')],
  ['panel body text: fg2 on bg2 (--tw-panel-bg)', tok('colorNeutralForeground2'), tok('colorNeutralBackground2')],
  ['strip C10 / meta text: fg3 on bg3', tok('colorNeutralForeground3'), tok('colorNeutralBackground3')],
  ['tile label: white on rgba(0,0,0,.6) over WHITE video', '#ffffff', over([0, 0, 0], 0.6, '#ffffff')],
  ['Leave: white on colorStatusDangerBackground3', '#ffffff', tok('colorStatusDangerBackground3')],
  ['primary button (Play together / I agree): fgOnBrand on brandBackground', tok('colorNeutralForegroundOnBrand'), tok('colorBrandBackground')],
  ['goal chip / device-only pill: marigoldForeground2 on marigoldBackground2', tok('colorPaletteMarigoldForeground2'), tok('colorPaletteMarigoldBackground2')],
];
let pairsOk = 0;
for (const [label, fg, bg] of PAIRS) { const r = fg && bg ? ratio(fg, bg) : 0; if (r >= 4.5) pairsOk++; ok(r >= 4.5, `${r.toFixed(2)}:1  ${label}`, `${fg} on ${bg}`); }
ok(pairsOk === 8, 'all 8 text/background pairs pass 4.5:1');
// extras the CSS relies on (accessibility.md R1/R3): links, captions, raise-hand pill icon, rings on the canvas
ok(ratio(tok('colorBrandForeground2'), tok('colorNeutralBackground1')) >= 4.5, `links: brandForeground2 on bg1 ${ratio(tok('colorBrandForeground2'), tok('colorNeutralBackground1')).toFixed(2)}:1`);
ok(ratio(tok('colorNeutralForeground4'), tok('colorNeutralBackground2')) >= 4.5, `12px captions: fg4 on bg2 ${ratio(tok('colorNeutralForeground4'), tok('colorNeutralBackground2')).toFixed(2)}:1`);
ok(ratio('#000000', '#eaa300') >= 4.5, `raise-hand pill: black icon on #eaa300 ${ratio('#000000', '#eaa300').toFixed(2)}:1 (white would be 2.16)`);
ok(ratio(tok('colorBrandStroke1'), tok('colorNeutralBackground3')) >= 3 && ratio(tok('colorStatusSuccessBorderActive'), tok('colorNeutralBackground3')) >= 3 && ratio(tok('colorStatusDangerBorderActive'), tok('colorNeutralBackground3')) >= 3, 'rings (speaking / catch / miss) >= 3:1 on the canvas bg3 (halo covers video)');
const twcss = fs.readFileSync(path.join(REPO, 'sdk/ui/teamslab.css'), 'utf8');
ok(/\.tile\s*\{[^}]*z-index:\s*auto/.test(twcss), '.tile { z-index:auto } (chrome must rise above the stage surface)');
ok(/--tw-z-surface:\s*6/.test(twcss) && /--tw-z-chrome:\s*7/.test(twcss), 'stacking tokens surface 6 / chrome 7 declared');
ok((twcss.match(/box-shadow:\s*var\(--tw-halo\)/g) || []).length >= 6, 'every ring over video carries --tw-halo');
const rawHex = (twcss.match(/#[0-9a-fA-F]{3,6}\b/g) || []).filter(h => !/^#(000|fff)$/i.test(h));
ok(rawHex.length === 0, 'teamslab.css colours come from tokens (only #000/#fff literals for the gold pill icon and label text)', rawHex.join(' '));
// B7 pairs: coach card, skeleton caption, waiting note, slider value/ends, hand-state chip (white on the label scrim over WHITE video)
const B7_PAIRS = [
  ['coach card text: fg1 on bg1', tok('colorNeutralForeground1'), tok('colorNeutralBackground1')],
  ['coach hint / count: fg3 on bg1', tok('colorNeutralForeground3'), tok('colorNeutralBackground1')],
  ['skeleton caption: fg3 on bg2', tok('colorNeutralForeground3'), tok('colorNeutralBackground2')],
  ['slider value: fg2 on panel bg2', tok('colorNeutralForeground2'), tok('colorNeutralBackground2')],
  ['hand-state chip / waiting note: white on rgba(0,0,0,.6) over WHITE video', '#ffffff', over([0, 0, 0], 0.6, '#ffffff')],
];
let b7ok = 0;
for (const [label, fg, bg] of B7_PAIRS) { const r = fg && bg ? ratio(fg, bg) : 0; if (r >= 4.5) b7ok++; ok(r >= 4.5, `${r.toFixed(2)}:1  ${label}`, `${fg} on ${bg}`); }
ok(b7ok === B7_PAIRS.length, `all ${B7_PAIRS.length} B7 text/background pairs pass 4.5:1`);
ok(ratio('#adadad', over([0, 0, 0], 0.6, '#ffffff')) < 4.5, 'fg3 on the video scrim would FAIL (2.6:1) — the waiting note and age text therefore use white', ratio('#adadad', over([0, 0, 0], 0.6, '#ffffff')).toFixed(2));
ok(/--tw-tile-reserve:\s*40px/.test(twcss) && /\.tile__shelf\s*\{[^}]*bottom:\s*max\(var\(--tw-tile-reserve\),\s*var\(--tw-shelf\)\)/.test(twcss), 'tile chrome: 40 px bottom reserve declared, shelf line sits above it (max(reserve, shelf))');
ok(/\.tile__ballchip\s*\{\s*display:\s*none\s*!important/.test(twcss) && /\.tile__handstate\s*\{/.test(twcss) && /\.tile__status\s*\{/.test(twcss), 'raw ball pill dropped; hand-state chip + single status pill styled');
ok(/\.tile\.is-loading \.tile__skeleton\s*\{\s*display:\s*flex/.test(twcss) && /@keyframes tile-shimmer/.test(twcss) && /\.tile__waiting\s*\{/.test(twcss), 'skeleton shimmer + waiting note styles present');
ok(/\.tw-frame\[data-reduced-motion="true"\] \.tile__skeleton::before/.test(twcss) && /prefers-reduced-motion: reduce\)\s*\{[^}]*\.tile__skeleton::before/.test(twcss), 'shimmer stops under reduced motion (media query AND the JS override)');
ok(/\.is-narrow #controlbar\s*\{[^}]*gap:\s*2px/.test(twcss) && /\.is-narrow \.cbtn\s*\{[^}]*min-width:\s*40px/.test(twcss), 'narrow control bar: 8 x 40 px buttons fit a 390 px phone without horizontal scroll');

// ---------------------------------------------------------------------------------------------------------
console.log('\n[3] API-tab row model (SPEC §8)');
const LAYERS = ['Holohands overlay', 'Outgoing video', 'Body + collision', 'Multi-person ids', 'Game objects (doctrine)', 'Cross-tile ball', 'Remote hands', 'Command agent', 'Latency HUD', 'Relay', 'Privacy chrome', 'Tenant / packaging'];
ok(API_ROWS.length === 12, `12 rows (${API_ROWS.length})`);
ok(LAYERS.every(l => API_ROWS.some(r => r.layer === l)), 'every SPEC §8 layer present', LAYERS.filter(l => !API_ROWS.some(r => r.layer === l)).join(', '));
ok(API_ROWS.every(r => ['demo', 'seam', 'probe first'].includes(r.pill)), 'every pill in {demo, seam, probe first}', API_ROWS.filter(r => !['demo', 'seam', 'probe first'].includes(r.pill)).map(r => r.layer).join(', '));
ok(API_ROWS.every(r => typeof r.live === 'function' && typeof r.live() === 'string' && typeof r.twin === 'string' && typeof r.path === 'string' && Array.isArray(r.links) && 'blocker' in r), 'row shape {layer, twin, path, pill, live(), links[], blocker}');
ok(API_ROWS.find(r => r.layer === 'Holohands overlay').pill === 'probe first' && API_ROWS.find(r => r.layer === 'Tenant / packaging').pill === 'probe first' && API_ROWS.find(r => r.layer === 'Body + collision').pill === 'seam', 'pills: Holohands + Tenant = probe first, Body = seam');

// ---------------------------------------------------------------------------------------------------------
console.log('\n[4] strings + key map');
ok(STRINGS.c1.title === 'Use your camera for hand tracking?' && STRINGS.c1.agree === 'I agree and turn on camera' && STRINGS.c1.notNow === 'Not now' && STRINGS.c1.deviceOnly === 'Use hopeOS without sharing (on-device only)', 'C1 title + buttons verbatim');
ok(STRINGS.c1.shared.length === 3 && STRINGS.c1.shared[2] === 'Face data (mesh and expressions) is never sent anywhere.' && STRINGS.c1.release.startsWith('By pressing "I agree" you confirm'), 'C1 body bullets + release verbatim');
ok(STRINGS.c1.illinois.includes(CONSENT_VERSION) && STRINGS.c1.illinois.endsWith('It is not sent to hopeOS.'), 'C1 Illinois line carries the consent version');
ok(STRINGS.c3.pill.tracking === 'Tracking on this device' && STRINGS.c3.pill['device-only'] === 'On-device only' && STRINGS.c3.pill['camera-off'] === 'Camera off' && STRINGS.c3.pill.landmarks('p2') === 'Landmarks from p2' && STRINGS.c3.pill['no-data'] === 'No tracking data', 'C3 pills verbatim');
ok(STRINGS.c4.label === 'On-device only' && STRINGS.c4.announceOn === 'Sharing off. Nothing leaves this device.' && STRINGS.c4.announceOff === 'Sharing on.', 'C4 toggle strings verbatim');
ok(STRINGS.c7.notice.startsWith('Commands are processed by AI services outside this meeting.') && STRINGS.c7.ptt.idle === 'Hold to talk' && STRINGS.c7.ptt.held === 'Listening... release to send' && STRINGS.c7.placeholder === 'Type a command (sent to Claude)', 'C7 notice + PTT + placeholder verbatim');
ok(STRINGS.c10.strip.startsWith('hopeOS Meeting Sandbox - a local test harness') && STRINGS.c10.strip.endsWith('Not a Microsoft product; not affiliated with or endorsed by Microsoft.'), 'C10 strip verbatim');
ok(STRINGS.c10.about.startsWith('Microsoft, Azure, Fluent and Microsoft Teams are trademarks'), 'C10 About footnote verbatim');
const html = fs.readFileSync(path.join(REPO, 'teamslab.html'), 'utf8');
ok(!/jointsWithin|GrabState|gravity\s*[:=]\s*0|handedness|categoryName/.test(html + fs.readFileSync(path.join(REPO, 'sdk/game/twin-ui.js'), 'utf8')), 'no doctrine/chirality forbidden tokens in twin-ui.js / teamslab.html');
ok(/<script type="importmap">[\s\S]*three@0\.160\.0\/build\/three\.module\.js/.test(html) && /data-theme="dark"/.test(html) && /teams-tokens\.css/.test(html) && /teamslab\.css/.test(html), 'teamslab.html: importmap three 0.160.0, data-theme=dark, both stylesheets');
for (const id of ['topbar', 'title', 'scoreboard', 'hudChip', 'topbarBtns', 'stage', 'gallery', 'surface', 'arrivals', 'panel', 'tab-people', 'tab-chat', 'tab-game', 'tab-api', 'controlbar', 'btnCam', 'btnMic', 'btnDeviceOnly', 'btnShare', 'btnReact', 'btnRaise', 'btnMore', 'btnLeave', 'strip', 'live-polite', 'live-assertive', 'toasts', 'consent', 'cmdPopover', 'about'])
  if (!html.includes(`id="${id}"`)) ok(false, `SPEC §2.4 id missing: #${id}`);
ok(true, 'SPEC §2.4 ids present (30 checked)');
const keys = Object.values(KEY_ACTIONS);
ok(['kbhand', 'left', 'right', 'up', 'down', 'cup', 'kickoff', 'play', 'mute', 'hud', 'holohands', 'ptt', 'esc'].every(a => keys.includes(a)) && KEY_ACTIONS.Space === 'cup', 'key map: K, arrows, Space=cup (never push-to-talk), G, P, M, H (HoloHands), L (HUD), V, Esc');
ok(KEY_ACTIONS.KeyH === 'holohands' && KEY_ACTIONS.KeyL === 'hud', 'H = HoloHands mode cycle; the Latency HUD toggle lives on L');

// ---------------------------------------------------------------------------------------------------------
console.log('\n[5] B7 hand-state chip model (setHandState(slot, state) -> icon + text, colour-independent)');
const KEYS = ['none', 'open', 'cupped', 'holding', 'holding:wrap', 'holding:clip', 'holding:cradle', 'throwing', 'ball'];
ok(KEYS.every(k => HAND_STATES[k] && typeof HAND_STATES[k].text === 'string' && typeof HAND_STATES[k].icon === 'string' && Number.isFinite(HAND_STATES[k].priority)), 'HAND_STATES: open / cupped / holding wrap|clip|cradle / throwing (+ none, ball) each with icon + text + priority');
ok(KEYS.filter(k => k !== 'none').every(k => HAND_STATES[k].text.length > 0) && HAND_STATES.none.text === '', 'every visible state has text (never colour alone); none is empty');
ok(handStateLabel('holding:wrap').text === 'Holding · wrap' && handStateLabel({ kind: 'holding', how: 'clip' }).key === 'holding:clip' && handStateLabel('cradle').key === 'holding:cradle' && handStateLabel('HOLDING').key === 'holding', "spellings: 'holding:wrap', {kind:'holding', how:'clip'}, 'cradle', 'HOLDING' all normalise");
ok(handStateLabel('cup').key === 'cupped' && handStateLabel('throw').key === 'throwing' && handStateLabel('release').key === 'open' && handStateLabel(null).key === 'none' && handStateLabel('bogus').key === 'none' && handStateLabel(undefined).key === 'none', 'aliases cup/throw/release; null/unknown -> none');
ok(handStateLabel({ kind: 'holding', how: 'nope' }).key === 'holding', 'unknown grip falls back to plain holding');
const pr = (k) => HAND_STATES[k].priority;
ok(pr('none') < pr('open') && pr('open') < pr('cupped') && pr('cupped') < pr('holding:wrap') && pr('holding:wrap') < pr('throwing'), 'priority none < open < cupped < holding < throwing');
ok(summarizeHandStates(['open', 'cupped']).key === 'cupped' && summarizeHandStates(['holding:cradle', 'open']).key === 'holding:cradle' && summarizeHandStates(['throwing', 'holding:wrap']).key === 'throwing' && summarizeHandStates([]).key === 'none' && summarizeHandStates(['open', 'open']).key === 'open', 'two-slot summary shows the highest-priority hand');
ok(!/[Ll]eft|[Rr]ight/.test(Object.values(HAND_STATES).map(s => s.text).join(' ')), 'chip text never names a hand side (chirality is measured, labels never read)');

// ---------------------------------------------------------------------------------------------------------
console.log('\n[6] B7 Game-tab sliders emit (bindSlider on an input double)');
ok(SLIDERS.ballsize.min === 0.035 && SLIDERS.ballsize.max === 0.07 && SLIDERS.ballsize.value === 0.05 && SLIDERS.ballsize.event === 'ballsize', 'Ball size: 0.035-0.07 default 0.05, event "ballsize"');
ok(SLIDERS.shelf.min === 30 && SLIDERS.shelf.max === 55 && SLIDERS.shelf.event === 'shelf' && SLIDERS.shelf.key === 'pct' && SLIDERS.shelf.value >= 30 && SLIDERS.shelf.value <= 55, `Shelf height: 30-55 %, default ${SLIDERS.shelf.value}, event "shelf" {pct}`);
ok(sliderValue(SLIDERS.ballsize, 0.2) === 0.07 && sliderValue(SLIDERS.ballsize, 0) === 0.035 && sliderValue(SLIDERS.ballsize, 'x') === 0.05 && sliderValue(SLIDERS.ballsize, 0.0526) === 0.055 && sliderValue(SLIDERS.shelf, 41.7) === 42, 'sliderValue clamps, snaps to step, defaults on NaN');
function fakeInput(value) { const L = {}; return { value: String(value), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { (L[t] ??= []).push(f); }, fire(t) { for (const f of L[t] ?? []) f({ type: t }); } }; }
{
  const inp = fakeInput(0.05), out = { textContent: '' }, store = memoryStorage(), got = [];
  const h = bindSlider(inp, SLIDERS.ballsize, { emit: (ev, d) => got.push([ev, d]), output: out, storage: store });
  ok(out.textContent === '0.050' && inp.attrs['aria-valuetext'] === '0.050' && got.length === 0, 'bind paints the output + aria-valuetext without emitting', out.textContent);
  inp.value = '0.04'; inp.fire('input');
  ok(got.length === 1 && got[0][0] === 'ballsize' && got[0][1].value === 0.04 && got[0][1].name === 'ballsize' && out.textContent === '0.040', "input -> emit('ballsize', {name, value:0.04})", JSON.stringify(got[0]));
  inp.fire('change');
  ok(got.length === 2 && got[1][1].commit === true && store.getItem('hopeos.ballsize') === '0.04', 'change -> emit with commit:true + persisted hopeos.ballsize', store.getItem('hopeos.ballsize'));
  inp.value = '9'; inp.fire('input');
  ok(got[2][1].value === 0.07 && h.value === 0.07, 'out-of-range input clamps to max 0.07');
  h.set(0.045); ok(inp.value === '0.045' && got[3][1].value === 0.045, 'handle.set(v) moves the input and emits');
  h.set(0.05, { emit: false }); ok(got.length === 4 && h.value === 0.05, 'handle.set(v, {emit:false}) is silent');
  const sh = fakeInput(45), sOut = { textContent: '' }, sGot = [];
  bindSlider(sh, SLIDERS.shelf, { emit: (ev, d) => sGot.push([ev, d]), output: sOut });
  sh.value = '52'; sh.fire('input');
  ok(sOut.textContent === '52 %' && sGot[0][0] === 'shelf' && sGot[0][1].pct === 52 && sGot[0][1].value === 52, "shelf slider -> emit('shelf', {pct:52}) and paints '52 %'", JSON.stringify(sGot[0]));
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[7] B7 coach sequence: order, dismiss, persistence (CoachSequence with an in-memory storage)');
ok(COACH_STEPS.length === 3 && COACH_STEPS.map(s => s.id).join() === 'cup,throw,voice' && COACH_STEPS.map(s => s.anchor).join() === 'local,neighbour,ptt', '3 steps cup -> throw -> voice anchored local / neighbour / ptt');
{
  const store = memoryStorage(), seq = new CoachSequence({ storage: store, now: () => 1758326400000 }), log = [];
  for (const ev of ['start', 'step', 'done', 'skipped', 'reset']) seq.addEventListener(ev, (e) => log.push(ev + ':' + (e.detail.index ?? e.detail.reason ?? '')));
  ok(seq.seen === false && seq.active === false && seq.step === null, 'fresh storage: not seen, inactive');
  ok(seq.start({ ctx: { neighbour: 'Hannah' } }) === true && seq.index === 0 && seq.text() === 'Cup your palm under the ball to catch it', 'start() -> step 0 "Cup your palm under the ball to catch it"', seq.text());
  ok(seq.next() === true && seq.index === 1 && seq.text() === 'Throw toward Hannah', 'next() -> step 1 "Throw toward <neighbour>"', seq.text());
  ok(seq.next() === true && seq.index === 2 && seq.text() === 'Hold V and say: give me a tennis ball', 'next() -> step 2 "Hold V and say: give me a tennis ball"', seq.text());
  ok(seq.back() === true && seq.index === 1 && seq.next() === true && seq.index === 2, 'back() then next() returns to step 2');
  ok(seq.next() === false && seq.active === false && seq.seen === true, 'next() on the last step finishes: inactive + seen');
  const rec = JSON.parse(store.getItem(COACH_KEY));
  ok(rec.version === COACH_VERSION && rec.seen === true && rec.reason === 'done' && rec.atStep === 2 && rec.at === new Date(1758326400000).toISOString(), `persisted ${COACH_KEY} = {version, seen, reason:'done', atStep:2, at}`, store.getItem(COACH_KEY));
  ok(log.join(' ') === 'start:0 step:0 step:1 step:2 step:1 step:2 done:done', 'event order start/step/.../done', log.join(' '));
  ok(seq.start() === false && log.at(-1) === 'skipped:seen', 'second start() is skipped (seen)');
  ok(seq.start({ force: true }) === true && seq.index === 0, 'start({force:true}) replays from step 0');
  ok(seq.skip('esc') === true && seq.seen === true && JSON.parse(store.getItem(COACH_KEY)).reason === 'esc' && JSON.parse(store.getItem(COACH_KEY)).atStep === 0, 'skip("esc") (keyboard dismiss) marks seen with the reason + step');
  const seq2 = new CoachSequence({ storage: store });
  ok(seq2.seen === true && seq2.start() === false, 'a new sequence on the same storage sees the flag (persists across loads)');
  const old = memoryStorage({ [COACH_KEY]: JSON.stringify({ version: '2000-01-01', seen: true }) });
  ok(new CoachSequence({ storage: old }).seen === false && new CoachSequence({ storage: old }).start() === true, 'an older version flag does not count as seen');
  seq2.reset(); ok(store.getItem(COACH_KEY) === null && seq2.seen === false, 'reset() clears the flag');
  const text = (k, d) => COACH_TOASTS[k](d);
  ok(text('catch') === 'Nice catch' && text('miss') === 'Cup lower, palm up' && text('goal', { name: 'Hannah' }) === 'GOAL for Hannah', 'contextual toast strings: catch / miss / goal');
  let t = 0; const gate = new ToastGate({ now: () => t });
  const g1 = gate.take('catch'); t += 300; const g2 = gate.take('miss'); t += 600; const g3 = gate.take('miss'); t += 3000; const g4 = gate.take('miss'); t += 1100; const g5 = gate.take('miss'); const g6 = gate.take('goal', { name: 'Ana' }); t += 2000; const g7 = gate.take('catch');
  ok(g1 === 'Nice catch' && g2 === null && g3 === 'Cup lower, palm up' && g4 === null && g5 === 'Cup lower, palm up' && g6 === null && g7 === 'Nice catch', 'ToastGate: 0.8 s min gap, same text not inside 4 s, per-type cooldown, then allowed again', [g1, g2, g3, g4, g5, g6, g7].join(' | '));
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[8] HoloHands mode control: AUTO | ON | OFF (computeHoloHandsShown, H cycle, checkbox sync, persistence, event payload)');
ok(HOLOHANDS_MODES.join() === 'auto,on,off' && HOLOHANDS_STORE === 'hopeos.holohands' && HOLOHANDS_FADE_MS === 400, 'modes auto/on/off, store hopeos.holohands, 400 ms fade recommendation');
// truth table: AUTO shows only while an interaction needs collision; ON always; OFF never (gesture reactions never need it)
const TRUTH = [
  ['auto', [], false], ['auto', ['ball'], true], ['auto', ['prop', 'draw'], true], ['auto', null, false], ['auto', new Set(['hug']), true],
  ['on', [], true], ['on', ['ball'], true], ['off', [], false], ['off', ['ball', 'handshake'], false],
];
let truthOk = 0; const truthBad = [];
for (const [m, a, exp] of TRUTH) { const got = computeHoloHandsShown(m, a); if (got === exp) truthOk++; else truthBad.push(`${m}/${JSON.stringify(a instanceof Set ? [...a] : a)} got ${got}`); }
ok(truthOk === TRUTH.length, `computeHoloHandsShown truth table (${TRUTH.length} rows): AUTO = active.length > 0, ON = true, OFF = false`, truthBad.join('; '));
ok(computeHoloHandsShown('AUTO', ['ball']) === true && computeHoloHandsShown('bogus', ['ball']) === true && computeHoloHandsShown(true, []) === true && computeHoloHandsShown(false, ['ball']) === false, 'mode spelling is normalised (AUTO, unknown -> auto, true -> on, false -> off)');
ok(nextHoloHandsMode('auto') === 'on' && nextHoloHandsMode('on') === 'off' && nextHoloHandsMode('off') === 'auto' && nextHoloHandsMode('junk') === 'on', 'cycle Auto -> On -> Off -> Auto');
ok(holoHandsMode(' On ') === 'on' && holoHandsMode(null) === 'auto' && holoHandsMode('x', 'off') === 'off', 'holoHandsMode normaliser + fallback');
function fakeEl() { const L = {}; return { attrs: {}, title: '', textContent: '', checked: true, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener(t, f) { (L[t] ??= []).push(f); }, fire(t) { for (const f of L[t] ?? []) f({ type: t }); } }; }
{
  const store = memoryStorage(), events = [];
  const ctrl = new HoloHandsControl({ storage: store, emit: (type, d) => events.push([type, d]) });
  ok(ctrl.mode === 'auto' && ctrl.shown === false && events.length === 0, 'fresh storage: mode auto, rigs not shown (no interaction yet), nothing emitted');
  const btn = fakeEl(), cap = fakeEl(), cb = fakeEl();
  ctrl.attachButton(btn, cap); ctrl.attachCheckbox(cb);
  ok(btn.attrs['aria-pressed'] === 'false' && btn.attrs['data-mode'] === 'auto' && cap.textContent === 'Auto' && cb.checked === true && btn.attrs['aria-label'] === 'HoloHands: Auto' && btn.title.startsWith('HoloHands: Auto'), 'attach paints: aria-pressed=false (not shown), caption Auto, checkbox checked (auto), title', JSON.stringify(btn.attrs));
  // API: setHoloHands(mode) -> 'holohands' { mode, prev, shown, source, fadeMs } + persisted
  ok(ctrl.set('on') === 'on' && events.length === 1 && events[0][0] === 'holohands' && JSON.stringify(events[0][1]) === JSON.stringify({ mode: 'on', prev: 'auto', shown: true, source: 'api', fadeMs: 400 }), "set('on') emits 'holohands' { mode:'on', prev:'auto', shown:true, source:'api', fadeMs:400 }", JSON.stringify(events[0]));
  ok(store.getItem(HOLOHANDS_STORE) === 'on' && btn.attrs['aria-pressed'] === 'true' && cap.textContent === 'On' && cb.checked === true, 'ON: persisted hopeos.holohands=on, aria-pressed=true, caption On, checkbox stays checked');
  ok(ctrl.set('on') === 'on' && events.length === 1, 'setting the same mode again does not emit');
  // H key: cycle via the KEY_ACTIONS action
  ok(ctrl.key('hud', true) === null && events.length === 1, "key('hud') is not ours (null, no change)");
  ok(ctrl.key(KEY_ACTIONS.KeyH, true) === 'off' && events.at(-1)[1].mode === 'off' && events.at(-1)[1].prev === 'on' && events.at(-1)[1].source === 'key' && events.at(-1)[1].shown === false, 'H from On -> Off (source key, shown false)');
  ok(cb.checked === false && btn.attrs['aria-pressed'] === 'false' && cap.textContent === 'Off' && store.getItem(HOLOHANDS_STORE) === 'off', 'OFF: checkbox unchecked, aria-pressed=false, caption Off, persisted');
  ok(ctrl.key(KEY_ACTIONS.KeyH, true) === 'auto' && ctrl.key(KEY_ACTIONS.KeyH, true) === 'on' && ctrl.key(KEY_ACTIONS.KeyH, false) === 'on', 'H: Off -> Auto -> On; keyup does not cycle');
  ok(ctrl.key(KEY_ACTIONS.KeyH, true) === 'off' && cb.checked === false, 'H again -> Off (full cycle Auto -> On -> Off -> Auto verified)');
  // checkbox -> mode: on = Auto, off = Off (On is only reachable via the button / H)
  cb.checked = true; cb.fire('change');
  ok(ctrl.mode === 'auto' && events.at(-1)[1].source === 'checkbox' && events.at(-1)[1].mode === 'auto' && cap.textContent === 'Auto', 'checkbox on -> Auto (source checkbox)');
  ctrl.set('on'); cb.checked = false; cb.fire('change');
  ok(ctrl.mode === 'off' && events.at(-1)[1].prev === 'on' && cap.textContent === 'Off', 'checkbox off (from On) -> Off');
  cb.checked = true; cb.fire('change');
  ok(ctrl.mode === 'auto' && ctrl.shown === false, 'checkbox on again -> Auto, not On');
  // button click cycles
  btn.fire('click'); ok(ctrl.mode === 'on' && events.at(-1)[1].source === 'button' && cb.checked === true, 'button click Auto -> On (checkbox painted checked)');
  btn.fire('click'); btn.fire('click'); ok(ctrl.mode === 'auto', 'two more clicks -> Off -> Auto');
  // setShown: the page's computed truth; never changes the mode, never emits
  const n = events.length;
  ctrl.set('on'); ctrl.setShown(false);
  ok(ctrl.mode === 'on' && ctrl.shown === false && btn.attrs['aria-pressed'] === 'false' && cap.textContent === 'On' && events.length === n + 1, 'setShown(false) with mode On: aria-pressed false, caption still On, mode untouched, no extra event');
  ctrl.set('auto'); ok(ctrl.setActive(['ball']) === true && btn.attrs['aria-pressed'] === 'true' && ctrl.setActive([]) === false && btn.attrs['aria-pressed'] === 'false', 'setActive([...]) recomputes shown for AUTO (ball -> shown, idle -> hidden)');
  ok(ctrl.setActive(['prop']) === true && ctrl.set('off') === 'off' && ctrl.shown === false && ctrl.set('auto') === 'auto' && ctrl.shown === true, 'mode changes re-apply the last active list (auto+prop shown, off hidden, auto again shown)');
  // persistence across loads + garbage in storage
  ctrl.set('off');
  const again = new HoloHandsControl({ storage: store });
  ok(again.mode === 'off' && again.shown === false, 'a new control on the same storage restores Off');
  ok(new HoloHandsControl({ storage: memoryStorage({ [HOLOHANDS_STORE]: 'sideways' }) }).mode === 'auto' && new HoloHandsControl({ storage: memoryStorage({ [HOLOHANDS_STORE]: 'ON' }) }).mode === 'on', 'garbage in storage -> auto; case-insensitive "ON" -> on');
  ok(new HoloHandsControl({ storage: { getItem() { throw new Error('private'); }, setItem() { throw new Error('private'); } } }).set('on') === 'on', 'a throwing storage (private mode) never breaks the control');
}
// strings + CSS + source-level checks of the TwinUI wiring (no DOM in Node)
ok(STRINGS.bar.holohands === 'HoloHands' && STRINGS.holo.modes.auto === 'Auto' && STRINGS.holo.modes.on === 'On' && STRINGS.holo.modes.off === 'Off' && STRINGS.holo.hidden === 'hands hidden', "strings: button 'HoloHands', captions Auto/On/Off, pill suffix 'hands hidden'");
ok(/H cycles Auto, On, Off/.test(STRINGS.holo.title.auto) && /gesture reactions still work/i.test(STRINGS.holo.title.off), 'titles name the H shortcut; Off says gesture reactions still work');
const tuiSrc = fs.readFileSync(path.join(REPO, 'sdk/game/twin-ui.js'), 'utf8');
ok(/_injectHoloHandsButton\(bar\);[\s\S]*const btns = \$\$\(bar, 'button'\)/.test(tuiSrc) && /mic\.before\(btn\)/.test(tuiSrc) && /id = 'btnHoloHands'/.test(tuiSrc), '#btnHoloHands is injected before Mic and before the roving-tabindex list is taken');
ok(/input\[data-layer="hands"\]/.test(tuiSrc) && /attachCheckbox\(holoCb\)/.test(tuiSrc), "the Layers 'Holohands' checkbox is bound to the control");
ok(/if \(action === 'holohands'\) this\._holo\.key\(action, true\)/.test(tuiSrc) && /\['kickoff', 'play', 'mute', 'hud', 'holohands'\]/.test(tuiSrc), 'bindKeys: H cycles the mode on keydown, keyup fires the action');
ok(/label \+= ' · ' \+ this\.strings\.holo\.hidden/.test(tuiSrc) && /LIVE_PILLS = new Set\(\['tracking', 'device-only', 'landmarks'\]\)/.test(tuiSrc), "pill: '· hands hidden' appended while tracking is live and the rigs are hidden");
ok(/setHoloHands\(mode/.test(tuiSrc) && /get holoHandsMode\(\)/.test(tuiSrc) && /setHoloHandsShown\(on\)/.test(tuiSrc) && /this\._emit\(type, d\)/.test(tuiSrc), 'API: setHoloHands / holoHandsMode / setHoloHandsShown; CustomEvent holohands');
const twcss2 = fs.readFileSync(path.join(REPO, 'sdk/ui/teamslab.css'), 'utf8');
ok(/#btnHoloHands \.cbtn__mode\s*\{/.test(twcss2) && /#btnHoloHands\[data-mode="off"\]/.test(twcss2) && /\.is-narrow #btnHoloHands\s*\{[^}]*min-width:\s*36px/.test(twcss2), 'CSS: mode caption badge, Off tint, narrow bar still fits 390 px (9 buttons: 8 x 40 + 36 + 8 x 2 + 14 = 386)');
ok(fs.existsSync(path.join(REPO, 'docs/teams/HOLOHANDS-HOOK.md')) && /computeHoloHandsShown/.test(fs.readFileSync(path.join(REPO, 'docs/teams/HOLOHANDS-HOOK.md'), 'utf8')), 'docs/teams/HOLOHANDS-HOOK.md documents the one-line page hook');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
