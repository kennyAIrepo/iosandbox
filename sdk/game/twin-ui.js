/**
 * twin-ui.js — the Teams-twin UI shell (T1). Browser only, no three.js, no tracking.
 *
 * Builds nothing: the DOM skeleton (SPEC §2.4) lives in teamslab.html; this class binds the ids and drives
 * the gallery layout (rule B `fixed169`), tile chrome (pills C3, rings, chips), scoreboard, control bar
 * (role=toolbar, arrow keys, aria-pressed), side panel (role=tablist), consent gate (C1 verbatim, gates
 * getUserMedia), live regions (throttled 2 s per region), toasts, keyboard map (SPEC §5) and the API tab.
 *
 * Sources: R/ui/layout-spec.md §1-§7, R/ui/scripts/gallery-grid.mjs::fixed169 (copied verbatim below),
 * R/ui/overlay-sketches.md §5-§8, R/ui/accessibility.md R1-R12, R/gaps/render-budget/layout-spec.patch.md
 * (stacking: .tile z-index:auto, chrome z 7 above the stage surface z 6),
 * R/gaps/data-privacy-terms/consent-copy.md (C1, C3, C4, C7, C10 verbatim), .../patches/layout-spec-privacy.patch.md.
 *
 * `fixed169`, `STRINGS`, `API_ROWS` and `CONSENT_VERSION` are importable from Node (tests/twin-ui-smoke.mjs);
 * `TwinUI` touches the DOM only inside its constructor and methods.
 *
 * B7 (shell polish + coaching): hand-state chip (`setHandState(slot, state)`, HAND_STATES), single status pill
 * (`.tile__status` = C3 pill text + '· 54 ms' age), bottom 40 px reserved for the label bar (`--tw-tile-reserve`) with
 * the ball shelf line above it (`--tw-shelf`, `setShelf(pct)`), Game-tab sliders (SLIDERS: 'ballsize' / 'shelf' events),
 * skeleton shimmer while the tracker warms up (`setTileState(id, { loading:true })`), quiet "Waiting for <name>" on
 * remotes with no data, and the coach marks (`ui.coach`, `startCoach()`, `coachEvent()` -> sdk/game/coach.js).
 *
 * HoloHands mode control (2026-09-21): the hand-mesh overlay + collision rigs are shown only while an interaction needs
 * collision / realism (the ball in or arriving at the tile, a spawned / held prop, drawing, a hug, a handshake); someone
 * who only reacts with gestures never sees the overlay. Three states AUTO (default) | ON | OFF: control-bar button
 * `#btnHoloHands` (injected between Camera and Mic, aria-pressed = rigs currently SHOWN, caption Auto/On/Off), the H key
 * (cycles Auto -> On -> Off -> Auto), the Layers "Holohands" checkbox (on = Auto, off = Off; On only via the button),
 * persisted in localStorage `hopeos.holohands`, 'holohands' CustomEvent { mode, prev, shown, source, fadeMs }.
 * Page hook (docs/teams/HOLOHANDS-HOOK.md): `ui.setHoloHandsShown(computeHoloHandsShown(ui.holoHandsMode, active))`
 * where `active` lists the interactions currently needing collision; rigs fade over HOLOHANDS_FADE_MS (400 ms).
 * `HoloHandsControl`, `computeHoloHandsShown`, `nextHoloHandsMode` are Node-safe (tests/twin-ui-smoke.mjs).
 */
import { Coach } from './coach.js';

// ---------------------------------------------------------------------------------------------------------
// Gallery rule (B): fixed 16:9, maximise tile width, centre incomplete rows.  Verbatim copy of
// R/ui/scripts/gallery-grid.mjs:30-41 (results in gallery-grid-results.txt).  Exported for tests.
// ---------------------------------------------------------------------------------------------------------
export function fixed169(n, W, H, gap = 8, tol = 0.10) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    const c = { cols, rows, tw: Math.floor(tw), th: Math.floor(tw * 9 / 16) };
    if (!best || c.tw > best.tw * (1 + tol)) best = c;
    else if (c.tw >= best.tw * (1 - tol) && c.cols > best.cols) best = c; // within 10%: prefer wider rows (side-by-side)
  }
  const usedW = best.cols * best.tw + gap * (best.cols - 1), usedH = best.rows * best.th + gap * (best.rows - 1);
  return { ...best, padX: Math.floor((W - usedW) / 2), padY: Math.floor((H - usedH) / 2) };
}

// ---------------------------------------------------------------------------------------------------------
// Strings (consent-copy.md ids).  Placeholders in [brackets] are filled per deployment: the twin's relay is
// tools/relay-server.mjs, which keeps nothing; the privacy page is docs/teams/privacy.html (T7 copies it).
// ---------------------------------------------------------------------------------------------------------
export const CONSENT_VERSION = '2026-09-18';
export const PRIVACY_URL = 'docs/teams/privacy.html';
export const LICENSES_URL = 'docs/teams/licences.html';

export const STRINGS = {
  // C1. First-run consent dialog (gates getUserMedia; R9, R10)
  c1: {
    title: 'Use your camera for hand tracking?',
    intro: 'hopeOS tracks your hands (and, if you turn on Body, your body pose) on this device to draw the holohands and play the ball game. Your camera picture never leaves this device on the tracking path.',
    sharedHeading: 'What is shared while you play:',
    shared: [
      'Hand landmark data (21 points per hand, including a metric hand-shape model) and, if Body is on, 33 body points, about 30 times a second.',
      'It goes only to the other people in this meeting so their screens can show your hands, through a relay operated by hopeOS that keeps nothing.',
      'Face data (mesh and expressions) is never sent anywhere.',
    ],
    term: 'Length of term: for this meeting only. hopeOS keeps none of it afterwards. Details, retention and your rights: ',
    termLink: 'Data retention policy',
    release: 'By pressing "I agree" you confirm that you have read this notice and you agree to the collection of your hand (and body) geometry data for the purpose above and for the length of term above, and to sharing it with the other participants of this meeting. You can stop at any time with "On-device only" or by turning the camera off.',
    agree: 'I agree and turn on camera',
    notNow: 'Not now',
    deviceOnly: 'Use hopeOS without sharing (on-device only)',
    illinois: `This notice and your agreement are recorded on this device (date, version ${CONSENT_VERSION}). It is not sent to hopeOS.`,
  },
  // C2. Consent version bump (R9)
  c2: {
    title: 'Our data notice changed',
    body: 'Since you last agreed, hopeOS changed what it shares while you play: body pose can now be shared when Body is on. Please read the updated notice and agree again to keep sharing.',
    review: 'Review and agree',
    keep: 'Keep on-device only',
  },
  // C3. Tracking indicators in tile chrome (R8)
  c3: {
    pill: {
      tracking: 'Tracking on this device',
      'device-only': 'On-device only',
      'camera-off': 'Camera off',
      landmarks: (seat) => `Landmarks from ${seat}`,
      'no-data': 'No tracking data',
    },
    title: {
      tracking: 'Your hands are tracked here. Landmarks are shared with this meeting.',
      'device-only': 'Nothing is sent to other participants.',
      'camera-off': '',
      landmarks: "This person's hand data is drawn here. Their camera picture is not received.",
      'no-data': '',
    },
    announce: {
      tracking: 'Tracking started on this device',
      'device-only': 'Sharing paused - on-device only',
      resumed: (name) => `Tracking data from ${name} resumed`,
      lost: (name) => `Tracking data from ${name} lost`,
    },
  },
  // C4. On-device-only toggle in the control bar (R7)
  c4: {
    label: 'On-device only',
    titleOff: 'Stop sharing your hand data with this meeting. Tracking keeps working for you.',
    titleOn: 'Resume sharing your hand data with this meeting.',
    announceOn: 'Sharing off. Nothing leaves this device.',
    announceOff: 'Sharing on.',
  },
  // C7. Voice and text command processing notice (R5, R6, R16)
  c7: {
    notice: "Commands are processed by AI services outside this meeting. Hold the button to record; the recording is sent to OpenAI for speech-to-text, and the text plus a list of the objects in the scene (no camera, no hand data, no names) is sent to Anthropic's Claude to carry out the command. Nothing is sent while the button is not held. OpenAI does not keep the recording after transcribing it; Anthropic keeps nothing at rest. See ",
    noticeLink: 'privacy.html',
    noticeTail: ' for details.',
    gotIt: 'Got it',
    ptt: { idle: 'Hold to talk', held: 'Listening... release to send', sending: 'Sending to speech-to-text...' },
    placeholder: 'Type a command (sent to Claude)',
    unreachable: 'Command service unreachable - using the on-device command grammar.',
  },
  // C10. "Not a Microsoft product" disclaimer (branding)
  c10: {
    strip: 'hopeOS Meeting Sandbox - a local test harness that imitates the Microsoft Teams meeting layout for engineering. Not a Microsoft product; not affiliated with or endorsed by Microsoft.',
    about: 'Microsoft, Azure, Fluent and Microsoft Teams are trademarks of the Microsoft group of companies. hopeOS is not affiliated with, endorsed by, or sponsored by Microsoft. Licences: ',
  },
  // Control bar (layout-spec §4) and misc chrome
  bar: {
    cam: 'Camera', mic: 'Mic', share: 'Share', playTogether: 'Play together', react: 'React', raise: 'Raise hand',
    more: 'More', leave: 'Leave', holohands: 'HoloHands',
  },
  // HoloHands mode control (button caption, titles, announcements, pill suffix)
  holo: {
    label: 'HoloHands',
    modes: { auto: 'Auto', on: 'On', off: 'Off' },
    title: {
      auto: 'HoloHands: Auto — the hand overlay appears only while something needs it (the ball, a prop, drawing, a hug, a handshake). H cycles Auto, On, Off.',
      on: 'HoloHands: On — the hand overlay is always drawn. H cycles Auto, On, Off.',
      off: 'HoloHands: Off — the hand overlay is never drawn; gesture reactions still work. H cycles Auto, On, Off.',
    },
    announce: { auto: 'HoloHands auto: shown only while an interaction needs them', on: 'HoloHands on', off: 'HoloHands off. Gesture reactions still work.' },
    hidden: 'hands hidden',
  },
  chips: { ball: 'ball', goal: 'Goal', raised: 'Hand raised', potato: (s) => `POTATO ${s}` },
  // B7 tile empty / loading states and the sliders
  tile: { warming: 'Starting the tracker…', waiting: (name) => `Waiting for ${name}`, shelf: 'Ball shelf' },
  sliders: { ballsize: 'Ball size', shelf: 'Shelf height', smaller: 'smaller', larger: 'larger', lower: 'lower', higher: 'higher' },
};

// ---------------------------------------------------------------------------------------------------------
// B7: hand-state chip model (icons + text, colour-independent).  `game.handState(slot)` (B1) returns one of the keys
// below, or 'holding' with a `how` in {wrap, clip, cradle}; `handStateLabel()` normalises every spelling.
// ---------------------------------------------------------------------------------------------------------
export const HAND_STATES = {
  none:              { icon: 'none',  text: '',                  priority: 0 },
  open:              { icon: 'open',  text: 'Open',              priority: 1 },
  cupped:            { icon: 'cup',   text: 'Cupped',            priority: 2 },
  holding:           { icon: 'hold',  text: 'Holding',           priority: 3 },
  'holding:wrap':    { icon: 'hold',  text: 'Holding · wrap',    priority: 3 },
  'holding:clip':    { icon: 'hold',  text: 'Holding · clip',    priority: 3 },
  'holding:cradle':  { icon: 'hold',  text: 'Holding · cradle',  priority: 3 },
  throwing:          { icon: 'throw', text: 'Throwing',          priority: 4 },
  ball:              { icon: 'ball',  text: 'Has the ball',      priority: 3 },   // remote tiles: the tile owns the ball
};
const HAND_ALIASES = { idle: 'none', off: 'none', lost: 'none', cup: 'cupped', cupping: 'cupped', hold: 'holding', held: 'holding', grab: 'holding', throw: 'throwing', thrown: 'throwing', release: 'open', released: 'open', wrap: 'holding:wrap', clip: 'holding:clip', cradle: 'holding:cradle' };
/** @returns {{ key: string, icon: string, text: string, priority: number }} normalised chip model for any state spelling */
export function handStateLabel(state) {
  let key = 'none';
  if (state && typeof state === 'object') {
    const kind = String(state.kind ?? state.state ?? state.type ?? 'none').toLowerCase(), how = state.how ?? state.grip ?? state.mode ?? null;
    key = kind === 'holding' || kind === 'hold' || kind === 'held' ? (how && HAND_STATES[`holding:${how}`] ? `holding:${how}` : 'holding') : (HAND_ALIASES[kind] ?? kind);
  } else if (typeof state === 'string') { const s = state.trim().toLowerCase(); key = HAND_STATES[s] ? s : (HAND_ALIASES[s] ?? (s.startsWith('holding') ? 'holding' : 'none')); }
  if (!HAND_STATES[key]) key = 'none';
  return { key, ...HAND_STATES[key] };
}
/** Highest-priority state across hand slots (ties: the lower slot wins); [] -> 'none'. */
export function summarizeHandStates(states = []) {
  let best = handStateLabel('none');
  for (const s of states) { const l = handStateLabel(s); if (l.priority > best.priority) best = l; }
  return best;
}
// 16x16 stroke glyphs (static markup, no user data): open palm, cup, hand + ball, throw arrow, ball
const HAND_ICONS = {
  none: '',
  open: '<path d="M5 9V4.5a1 1 0 0 1 2 0V8M7 7.5V3a1 1 0 0 1 2 0v5M9 7.5V3.8a1 1 0 0 1 2 0V8M11 8V5.2a1 1 0 0 1 2 0v5.3a4.5 4.5 0 0 1-4.5 4.5H7.6a3.6 3.6 0 0 1-3-1.6L3 11a1 1 0 0 1 1.7-1L6 11.5"/>',
  cup: '<path d="M2.5 7.5h11a0 0 0 0 1 0 0v.5a5.5 5.5 0 0 1-5.5 5.5A5.5 5.5 0 0 1 2.5 8z"/><path d="M13 8.5h1.5a1.5 1.5 0 0 1 0 3H13"/>',
  hold: '<circle cx="8" cy="5" r="2.6"/><path d="M2.5 9.5h11v1a5.5 5.5 0 0 1-5.5 5A5.5 5.5 0 0 1 2.5 10.5z"/>',
  throw: '<circle cx="4.5" cy="8" r="2.2"/><path d="M8 8h5.5M11 5.5 13.5 8 11 10.5"/>',
  ball: '<circle cx="8" cy="8" r="5.5"/><path d="M4 4.5c2 1.5 2 5.5 0 7M12 4.5c-2 1.5-2 5.5 0 7"/>',
};

// ---------------------------------------------------------------------------------------------------------
// B7: Game-tab sliders.  Injected by bindPanel() after the "Goal tile" row (teamslab.html is not edited); each emits a
// CustomEvent on TwinUI ({ name, value } + the spec's own key) on every input and persists on change.
// ---------------------------------------------------------------------------------------------------------
export const SLIDERS = {
  ballsize: { id: 'ballSize', name: 'ballsize', label: 'Ball size', min: 0.035, max: 0.07, step: 0.005, value: 0.05, event: 'ballsize', key: 'value', store: 'hopeos.ballsize', fmt: (v) => Number(v).toFixed(3), ends: ['smaller', 'larger'] },
  // default 42 = B1's SHELF_FRAC (sdk/game/court-map.js); the integrator maps 'shelf' {pct} -> game.setShelfFrac(pct / 100)
  shelf:    { id: 'shelfPct', name: 'shelf', label: 'Shelf height', min: 30, max: 55, step: 1, value: 42, event: 'shelf', key: 'pct', store: 'hopeos.shelf', fmt: (v) => `${Math.round(v)} %`, ends: ['lower', 'higher'] },
};
/** Clamp + snap a raw slider value to the spec (Node-safe). */
export function sliderValue(spec, raw) {
  let v = Number(raw); if (!Number.isFinite(v)) v = spec.value;
  v = Math.min(spec.max, Math.max(spec.min, v));
  const steps = Math.round((v - spec.min) / spec.step);
  return +(spec.min + steps * spec.step).toFixed(6);
}
/**
 * Bind an input-like object ({ value, addEventListener(type, fn) } — a real <input type=range> or a test double) to a
 * slider spec.  `emit(spec.event, { name, value, [spec.key]: value })` fires on 'input' and 'change'; `output.textContent`
 * mirrors the formatted value; `storage.setItem(spec.store, value)` on 'change'.  Returns { get value, set(v, {emit}) }.
 */
export function bindSlider(input, spec, { emit = () => {}, output = null, storage = null } = {}) {
  let cur = sliderValue(spec, input.value ?? spec.value);
  const paint = () => { if (output) output.textContent = spec.fmt(cur); if (input.setAttribute) input.setAttribute('aria-valuetext', spec.fmt(cur)); };
  const detail = () => ({ name: spec.name, value: cur, [spec.key]: cur });
  const read = () => { cur = sliderValue(spec, input.value); paint(); };
  input.addEventListener('input', () => { read(); emit(spec.event, detail()); });
  input.addEventListener('change', () => { read(); emit(spec.event, { ...detail(), commit: true }); try { storage?.setItem(spec.store, String(cur)); } catch { /* ignore */ } });
  paint();
  return { spec, get value() { return cur; }, set(v, { emit: doEmit = true } = {}) { cur = sliderValue(spec, v); input.value = String(cur); paint(); if (doEmit) emit(spec.event, detail()); return cur; } };
}

// ---------------------------------------------------------------------------------------------------------
// Teams-API panel rows (SPEC §8): one per layer.  `live()` placeholders return '—' until T7 wires live numbers.
// ---------------------------------------------------------------------------------------------------------
// research example scripts are served copies under docs/teams/ (T7 copies them); links are repo-relative
// live(): each row reads its layer's getter from API_LIVE (filled by the page's T7 block via TwinUI.setApiLive) and
// falls back to '—' when the page has not registered one (the ?shell=1 UI-only shell, Node smoke).
export const API_LIVE = {};   // layer -> () => string
const dash = () => '—';
const liveOf = (layer) => () => { const f = API_LIVE[layer]; return f ? f() : '—'; };
export const API_ROWS = [
  { layer: 'Holohands overlay', twin: 'TilePipeline + HoloHandRig on the surface', path: 'C2 video-effect app (own tile) / C1 virtual camera', pill: 'probe first', live: liveOf('Holohands overlay'),
    links: [{ label: 'video-effect.html', href: 'docs/teams/video-effect.html' }, { label: 'effect-core.js', href: 'docs/teams/effect-core.js' }, { label: 'host-harness.html (Mode B)', href: 'docs/teams/host-harness.html' }, { label: 'teams-video-effect.js', href: 'docs/teams/teams-video-effect.js' }],
    blocker: 'videoEffects @beta, DevPreview manifest, sideload; issue #24 (new Teams 25163 never applies); NV12 + 45 ms' },
  { layer: 'Outgoing video', twin: 'OutgoingSink crop popup', path: 'C1 OBS window capture -> virtual camera; C3 LocalVideoStream(captureStream)', pill: 'demo', live: liveOf('Outgoing video'),
    links: [{ label: 'acs-client.html', href: 'docs/teams/acs-client.html' }], blocker: 'C1 = pixels only, no packets' },
  { layer: 'Body + collision', twin: 'body-layer.js (local only, stretch)', path: 'C2', pill: 'seam', live: liveOf('Body + collision'),
    links: [{ label: 'dropins.md §3.10', href: 'docs/teams/dropins.md' }], blocker: '+11 ms, +1 context; POSE33 0x31 reserved' },
  { layer: 'Multi-person ids', twin: 'N tiles, clientId/seat via PRESENCE + SEAT_MAP; one-tile MoveNet = day two', path: 'D packets per id, C2 pixels', pill: 'demo', live: liveOf('Multi-person ids'),
    links: [{ label: 'multi-person.md', href: 'docs/teams/multi-person.md' }, { label: 'sdk/core/multiplayer.js', href: 'sdk/core/multiplayer.js' }], blocker: 'TF.js context; ids swap on crossing' },
  { layer: 'Game objects (doctrine)', twin: 'PropBall props bag + SceneExecutor', path: 'C2 render sink', pill: 'demo', live: liveOf('Game objects (doctrine)'),
    links: [{ label: 'prop-ball.js', href: 'sdk/game/prop-ball.js' }, { label: 'prop-ball-smoke.mjs', href: 'tests/prop-ball-smoke.mjs' }], blocker: 'others see pixels only' },
  { layer: 'Cross-tile ball', twin: 'BallGame + BallNet over the relay', path: 'D stage app + Live Share (LiveEvent 20 Hz bundled, LiveState), or C3 ACS DataChannel', pill: 'demo', live: liveOf('Cross-tile ball'),
    links: [{ label: 'stage.html', href: 'docs/teams/stage.html' }, { label: 'stage-adapter.md', href: 'docs/teams/stage-adapter.md' }, { label: 'side-panel.html', href: 'docs/teams/side-panel.html' }, { label: 'acs-client.html', href: 'docs/teams/acs-client.html' }, { label: 'transports.js', href: 'sdk/net/transports.js' }],
    blocker: 'no third party gets remote pixels; Live Share 1.4.2 / Fluid 1.x esm.sh unverified; anonymous users cannot see stage apps' },
  { layer: 'Remote hands', twin: 'RemoteHands + RemoteTile', path: 'D / C3 (never the tile video)', pill: 'demo', live: liveOf('Remote hands'),
    links: [{ label: 'hopeos-wire.md §7', href: 'docs/teams/hopeos-wire.md' }], blocker: '—' },
  { layer: 'Command agent', twin: 'CommandAgent + SceneExecutor + PushToTalk', path: 'D side panel; /api/claude proxy', pill: 'demo', live: liveOf('Command agent'),
    links: [{ label: 'side-panel.html', href: 'docs/teams/side-panel.html' }, { label: 'command-agent NOTES', href: 'docs/teams/command-agent-NOTES.md' }],
    blocker: 'one command at a time; live latency unmeasured' },
  { layer: 'Latency HUD', twin: 'hud.js', path: 'D stage HUD', pill: 'demo', live: liveOf('Latency HUD'),
    links: [{ label: 'stage.html HUD', href: 'docs/teams/stage.html' }], blocker: 'Live Share age unmeasured' },
  { layer: 'Relay', twin: 'tools/relay-server.mjs + WsRelayTransport (+ gated())', path: 'D Azure Fluid Relay / C3 ACS DataChannel', pill: 'demo', live: liveOf('Relay'),
    links: [{ label: 'relay-server.mjs', href: 'tools/relay-server.mjs' }, { label: 'relay-server.example.mjs', href: 'docs/teams/relay-server.example.mjs' }, { label: 'data-flow.md (R22)', href: 'docs/teams/data-flow.md' }], blocker: 'Vercel cannot host sockets; ACS DataChannel inside Teams undocumented' },
  { layer: 'Privacy chrome', twin: 'consent C1, pills C3, device-only C4, strip C10, About footnote', path: 'all', pill: 'demo', live: liveOf('Privacy chrome'),
    links: [{ label: 'consent-copy.md', href: 'docs/teams/consent-copy.md' }, { label: 'privacy.html', href: PRIVACY_URL }, { label: 'terms.html', href: 'docs/teams/terms.html' }, { label: 'licences.html', href: LICENSES_URL }, { label: 'data-flow.md', href: 'docs/teams/data-flow.md' }], blocker: '—' },
  { layer: 'Tenant / packaging', twin: '—', path: 'manifests: meeting-app manifest.json (v1.30, RSC x4), video-effects manifest.json (DevPreview)', pill: 'probe first', live: liveOf('Tenant / packaging'),
    links: [{ label: 'meeting-app manifest.json', href: 'docs/teams/manifest.json' }, { label: 'video-effects manifest (annotated)', href: 'docs/teams/video-effects-manifest.annotated.jsonc' }, { label: 'privacy.html', href: PRIVACY_URL }, { label: 'terms.html', href: 'docs/teams/terms.html' }],
    blocker: 'custom upload must be on; free dev tenant gated in 2026; icons not produced' },
];

/** Label-bar band from the tile width: wide = one row (name + status pill), mid = two rows, small = two rows without the age, tiny = name only. */
export const TILE_BANDS = { wide: 440, mid: 240, small: 180 };
export function tileBand(tw) { return tw >= TILE_BANDS.wide ? 'wide' : tw >= TILE_BANDS.mid ? 'mid' : tw >= TILE_BANDS.small ? 'small' : 'tiny'; }

// H = HoloHands mode (Auto -> On -> Off -> Auto, handled inside bindKeys); the Latency HUD toggle moved to L.
export const KEY_ACTIONS = {
  KeyK: 'kbhand', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Space: 'cup',
  KeyG: 'kickoff', KeyP: 'play', KeyM: 'mute', KeyH: 'holohands', KeyL: 'hud', KeyV: 'ptt', Escape: 'esc',
};

// ---------------------------------------------------------------------------------------------------------
// HoloHands mode control — pure, Node-safe.  USER POLICY: the overlay + collision rigs are ON only while an interaction
// needs collision / realism; a gesture-only participant never sees them.  The page lists the interactions that are
// active right now (e.g. ['ball', 'prop', 'draw', 'hug', 'handshake']) and asks computeHoloHandsShown() once per change.
// Recommended: fade the rigs in / out over HOLOHANDS_FADE_MS rather than snapping (docs/teams/HOLOHANDS-HOOK.md).
// ---------------------------------------------------------------------------------------------------------
export const HOLOHANDS_MODES = Object.freeze(['auto', 'on', 'off']);
export const HOLOHANDS_STORE = 'hopeos.holohands';
export const HOLOHANDS_FADE_MS = 400;
/** Interactions that need collision / realism (the page may pass any string; these are the documented ones). */
export const HOLOHANDS_INTERACTIONS = Object.freeze(['ball', 'prop', 'draw', 'hug', 'handshake']);
/** Normalise any spelling ('AUTO', ' on ', true/false, null) to 'auto' | 'on' | 'off'; unknown -> fallback. */
export function holoHandsMode(v, fallback = 'auto') {
  if (v === true) return 'on'; if (v === false) return 'off';
  const s = String(v ?? '').trim().toLowerCase();
  return HOLOHANDS_MODES.includes(s) ? s : fallback;
}
/** Auto -> On -> Off -> Auto (the H key and the button). */
export function nextHoloHandsMode(mode) { return HOLOHANDS_MODES[(HOLOHANDS_MODES.indexOf(holoHandsMode(mode)) + 1) % HOLOHANDS_MODES.length]; }
/**
 * Are the rigs shown?  AUTO: shown while at least one interaction is active; ON: always; OFF: never.
 * @param {'auto'|'on'|'off'} mode
 * @param {string[]|Set<string>|null} activeInteractions   e.g. ['ball'] while the ball is in / arriving at the tile
 */
export function computeHoloHandsShown(mode, activeInteractions = []) {
  const m = holoHandsMode(mode);
  if (m === 'on') return true;
  if (m === 'off') return false;
  const n = activeInteractions == null ? 0 : (Array.isArray(activeInteractions) ? activeInteractions.length : (activeInteractions.size ?? activeInteractions.length ?? 0));
  return n > 0;
}
// 20x20 stroke glyph (static markup): open hand with landmark dots = the tracked hand mesh
const HOLO_ICON = '<path d="M6.5 10.5V5a1 1 0 0 1 2 0v4.5M8.5 9V3.5a1 1 0 0 1 2 0V9M10.5 9V4.5a1 1 0 0 1 2 0v5M12.5 9.5V6.5a1 1 0 0 1 2 0v5.5a5 5 0 0 1-5 5H9a4 4 0 0 1-3.2-1.6L3.5 12.5a1 1 0 0 1 1.6-1.2l1.4 1.4"/><circle cx="7.5" cy="10.5" r=".7" fill="currentColor"/><circle cx="9.5" cy="9" r=".7" fill="currentColor"/><circle cx="11.5" cy="9" r=".7" fill="currentColor"/><circle cx="13.5" cy="9.5" r=".7" fill="currentColor"/><circle cx="10" cy="14" r=".7" fill="currentColor"/>';
/**
 * The mode state machine behind the button, the H key and the Layers checkbox.  Elements are duck-typed
 * ({ setAttribute, addEventListener, title, checked, textContent } — real DOM or test doubles), storage is
 * localStorage-like (memoryStorage() in tests).  `emit('holohands', detail)` fires on every mode CHANGE with
 * detail = { mode, prev, shown, source: 'api'|'button'|'key'|'checkbox', fadeMs }.
 */
export class HoloHandsControl {
  constructor({ storage = null, emit = null, strings = STRINGS.holo, mode = 'auto', store = HOLOHANDS_STORE } = {}) {
    this.storage = storage; this.emit = emit; this.str = strings; this.store = store;
    let stored = null; try { stored = storage?.getItem(store) ?? null; } catch { /* private mode */ }
    this.mode = holoHandsMode(stored, holoHandsMode(mode));
    this.active = [];                                   // last interaction list given to setActive()
    this.shown = computeHoloHandsShown(this.mode, this.active);
    this.button = null; this.caption = null; this.checkbox = null;
  }
  /** Set the mode ('auto' | 'on' | 'off'); persists, repaints, emits on change. Returns the mode in force. */
  set(mode, { emit = true, persist = true, source = 'api' } = {}) {
    const m = holoHandsMode(mode, this.mode), prev = this.mode;
    this.mode = m;
    this.shown = computeHoloHandsShown(m, this.active);
    if (persist) { try { this.storage?.setItem(this.store, m); } catch { /* ignore */ } }
    this.paint();
    if (emit && m !== prev) this.emit?.('holohands', this.detail(source, prev));
    return m;
  }
  cycle(source = 'button') { return this.set(nextHoloHandsMode(this.mode), { source }); }
  /** The key action from KEY_ACTIONS ('holohands' on keydown cycles). Returns the mode, or null when not ours. */
  key(action, down = true) { if (action !== 'holohands') return null; return down ? this.cycle('key') : this.mode; }
  /** The page's truth about the interactions needing collision right now; recomputes `shown` (AUTO only cares). */
  setActive(list = []) { this.active = list == null ? [] : (Array.isArray(list) ? list.slice() : [...list]); return this.setShown(computeHoloHandsShown(this.mode, this.active)); }
  /** Rigs currently shown (aria-pressed + the pill suffix) — never changes the mode. */
  setShown(on) { this.shown = !!on; this.paint(); return this.shown; }
  detail(source = 'api', prev = this.mode) { return { mode: this.mode, prev, shown: this.shown, source, fadeMs: HOLOHANDS_FADE_MS }; }
  /** Bind the control-bar button (click cycles) and its caption span. */
  attachButton(btn, caption = null) { this.button = btn; this.caption = caption; btn?.addEventListener?.('click', () => this.cycle('button')); this.paint(); return btn; }
  /** Bind the Layers "Holohands" checkbox: checked -> Auto, unchecked -> Off; mode On/Auto paint it checked. */
  attachCheckbox(cb) { this.checkbox = cb; cb?.addEventListener?.('change', () => this.set(cb.checked ? 'auto' : 'off', { source: 'checkbox' })); this.paint(); return cb; }
  paint() {
    const b = this.button, s = this.str;
    if (b) {
      b.setAttribute('aria-pressed', String(this.shown));
      b.setAttribute('data-mode', this.mode);
      b.setAttribute('aria-label', `${s.label}: ${s.modes[this.mode]}`);
      b.title = s.title[this.mode];
    }
    if (this.caption) this.caption.textContent = s.modes[this.mode];
    if (this.checkbox) { const want = this.mode !== 'off'; if (this.checkbox.checked !== want) this.checkbox.checked = want; }
  }
}
const LIVE_PILLS = new Set(['tracking', 'device-only', 'landmarks']);   // pills that get the '· hands hidden' suffix

const SEAT_PALETTE = ['Berry', 'Marigold', 'Seafoam', 'Lavender', 'Peach', 'Lilac', 'Teal', 'Gold', 'Cornflower'];
const ANNOUNCE_MS = 2000;   // accessibility.md R6: one message per 2 s per region, never per frame
const PILL_WRITE_MS = 500;  // layout-spec-privacy.patch §1: one DOM write per 500 ms per pill

const initials = (name = '') => name.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('') || '?';
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------------------------------------
export class TwinUI extends EventTarget {
  /** @param {HTMLElement} root the `.tw-frame` element (or document) — ids are bound inside it */
  constructor(root, { strings } = {}) {
    super();
    this.root = root?.classList?.contains('tw-frame') ? root : (root ?? document).querySelector('.tw-frame');
    if (!this.root) throw new Error('TwinUI: .tw-frame not found');
    this.strings = strings ? deepMerge(cloneDeep(STRINGS), strings) : STRINGS;
    this.url = new URL(location.href).searchParams;
    this.tiles = new Map();      // clientId -> { el, video, avatar, chrome, seat, name, kind, state, pillAt }
    this.me = null;              // clientId of the local tile (first kind:'local')
    this.kbActive = false;       // keyboard hand (K) owns the arrow keys while true
    this._live = { polite: { at: -Infinity, timer: 0, queued: null, last: '' }, assertive: { at: -Infinity, timer: 0, queued: null, last: '' } };
    this._layout = null;
    this._panelUser = false;
    this._handlers = {};
    this._apiRows = [];
    this._apiTimer = 0;
    this._sliders = {};          // name -> bindSlider() handle (after bindPanel)
    this._coach = null;          // lazy Coach (sdk/game/coach.js)
    this.ballSize = SLIDERS.ballsize.value;
    this.shelfPct = SLIDERS.shelf.value;
    // HoloHands mode control (persisted hopeos.holohands); the button / checkbox attach in bindControlBar / bindPanel
    let storage = null; try { storage = localStorage; } catch { /* private mode */ }
    this._holo = new HoloHandsControl({ storage, strings: this.strings.holo, emit: (type, d) => this._onHoloChange(type, d) });
    this._bind();
    this.setShelf(this._stored(SLIDERS.shelf), { emit: false });
    this.ballSize = sliderValue(SLIDERS.ballsize, this._stored(SLIDERS.ballsize));
  }

  _stored(spec) { try { const v = localStorage.getItem(spec.store); return v == null ? spec.value : sliderValue(spec, v); } catch { return spec.value; } }

  // ---- ids -------------------------------------------------------------------------------------------
  _bind() {
    const r = this.root;
    this.el = {
      frame: r, topbar: $(r, '#topbar'), title: $(r, '#title'), scoreboard: $(r, '#scoreboard'), hudChip: $(r, '#hudChip'),
      topbarBtns: $(r, '#topbarBtns'), timer: $(r, '#timer'), stage: $(r, '#stage'), gallery: $(r, '#gallery'),
      surface: $(r, '#surface'), arrivals: $(r, '#arrivals'), panel: $(r, '#panel'), controlbar: $(r, '#controlbar'),
      strip: $(r, '#strip'), polite: $(r, '#live-polite'), assertive: $(r, '#live-assertive'), toasts: $(r, '#toasts'),
      consent: $(r, '#consent'), cmdPopover: $(r, '#cmdPopover'), about: $(r, '#about'), tileTpl: $(r, '#tile-template'),
      roster: $(r, '#roster'), apiRows: $(r, '#apiRows'), cmdCard: $(r, '#cmdCard'), cmdStatus: $(r, '#cmdStatus'),
      c7: $(r, '#c7notice'),
    };
    if (this.el.strip) this.el.strip.textContent = this.strings.c10.strip;
    const about = $(r, '#about-trademark');
    if (about) { about.textContent = this.strings.c10.about; const a = document.createElement('a'); a.href = LICENSES_URL; a.textContent = 'licences'; about.appendChild(a); about.appendChild(document.createTextNode('.')); }
    // stage size classes + relayout on resize (container queries cannot style the container itself)
    const onResize = () => { this._classify(); this._scheduleLayout(); };
    if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(onResize); this._ro.observe(this.el.frame); this._ro.observe(this.el.gallery); }
    else window.addEventListener('resize', onResize);
    this._classify();
    // dialogs: Esc on the consent dialog = "Not now" (handled in openConsent); others just close
    for (const d of [this.el.cmdPopover, this.el.about]) d?.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    // gallery roving tabindex (R5): arrows move between tiles unless the keyboard hand owns them
    this.el.gallery?.addEventListener('keydown', (e) => this._galleryKeys(e));
    // motion gate mirror (R8)
    this._mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this._mq?.addEventListener?.('change', () => this.dispatchEvent(new CustomEvent('motion', { detail: { reducedMotion: this.reducedMotion } })));
  }

  _classify() {
    const f = this.el.frame, w = f.clientWidth, h = f.clientHeight;
    const narrow = w > 0 && w <= 640, short = h > 0 && h <= 380;
    f.classList.toggle('is-narrow', narrow);
    f.classList.toggle('is-short', short);
    if (!this._panelUser) f.classList.toggle('panel-closed', narrow);   // narrow: the panel is a drawer, closed by default
  }

  // ---- gallery layout (rule B) --------------------------------------------------------------------------
  _scheduleLayout() {
    if (this._layoutRaf) return;
    this._layoutRaf = requestAnimationFrame(() => { this._layoutRaf = 0; this.layout(); });
  }

  /** Rule B via fixed169; tiles are position:absolute (z-index:auto) inside #gallery; emits 'layout' {rects}. */
  layout(n = this.tiles.size) {
    const g = this.el.gallery;
    const W = g.clientWidth, H = g.clientHeight;
    const gap = parseFloat(getComputedStyle(g).getPropertyValue('--tw-gallery-gap')) || 8;
    if (!n || W <= 0 || H <= 0) { this._layout = { rows: 0, cols: 0, tw: 0, th: 0, padX: 0, padY: 0, W, H, gap }; return this._layout; }
    const f = fixed169(n, W, H, gap);
    g.style.setProperty('--tile-w', f.tw + 'px'); g.style.setProperty('--tile-h', f.th + 'px');
    g.style.setProperty('--cols', f.cols); g.style.setProperty('--rows', f.rows);
    // B7: label-bar band by tile width (CSS reads it; a container query on .tile would add a stacking context and bury the chrome)
    g.dataset.tileBand = tileBand(f.tw);
    const ordered = this._ordered();
    const lastRowCount = n - (f.rows - 1) * f.cols;
    ordered.forEach((t, i) => {
      const row = Math.floor(i / f.cols), col = i % f.cols;
      const k = row === f.rows - 1 ? lastRowCount : f.cols;
      const offset = (f.cols - k) * (f.tw + gap) / 2;                       // centre the incomplete last row
      const left = f.padX + offset + col * (f.tw + gap), top = f.padY + row * (f.th + gap);
      Object.assign(t.el.style, { left: left + 'px', top: top + 'px', width: f.tw + 'px', height: f.th + 'px' });
      t.el.dataset.index = i;
    });
    this._layout = { ...f, W, H, gap };
    this.dispatchEvent(new CustomEvent('layout', { detail: { ...this._layout, rects: this.rects() } }));
    return this._layout;
  }

  /** Tile rects relative to #stage (what StageRenderer scissors to). */
  rects() {
    const s = this.el.stage.getBoundingClientRect(), out = new Map();
    for (const [id, t] of this.tiles) { const r = t.el.getBoundingClientRect(); out.set(id, new DOMRect(r.left - s.left, r.top - s.top, r.width, r.height)); }
    return out;
  }

  _ordered() { return [...this.tiles.values()].sort((a, b) => a.seat - b.seat || a.order - b.order); }

  // ---- tiles ----------------------------------------------------------------------------------------------
  /** Seat-ordered insertion. Returns { el, video, avatar, chrome }. */
  addTile({ clientId, name = clientId, kind = 'remote', seat = this.tiles.size }) {
    if (this.tiles.has(clientId)) return this.tiles.get(clientId);
    const el = this.el.tileTpl.content.firstElementChild.cloneNode(true);
    el.id = `tile-${clientId}`; el.dataset.client = clientId; el.dataset.seat = seat; el.dataset.kind = kind;
    el.classList.add(kind === 'local' ? 'tile--local' : 'tile--remote', `tile--${kind}`);
    el.tabIndex = this.tiles.size === 0 ? 0 : -1;
    const video = $(el, '.tile__media'), avatar = $(el, '.tile__avatar'), chrome = $(el, '.tile__chrome');
    $(el, '.tile__initials').textContent = initials(name);
    $(el, '.tile__name').textContent = kind === 'local' ? `${name} (you)` : name;
    el.style.setProperty('--seat-color', `var(--tw-seat-${seat % 9})`);
    this._dressChrome(el, name, kind);
    // tile chrome buttons: pin / more (the only interactive things on the stage besides the self-view handle)
    $(el, '.tile__pin')?.addEventListener('click', (e) => { e.stopPropagation(); this._emit('tile:pin', { clientId }); });
    $(el, '.tile__more')?.addEventListener('click', (e) => { e.stopPropagation(); this._emit('tile:more', { clientId }); });
    el.addEventListener('focus', () => { for (const t of this.tiles.values()) t.el.tabIndex = t.el === el ? 0 : -1; });
    const t = { clientId, el, video, avatar, chrome, seat, name, kind, order: this.tiles.size, pillAt: -Infinity, pillPending: 0,
      state: { speaking: false, raised: false, goal: false, ball: false, alpha: 1, ageMs: null, pill: kind === 'local' ? 'camera-off' : 'no-data', chip: null, ring: null, muted: false, pinned: false,
        loading: false, hands: {}, hand: 'none' } };
    this.tiles.set(clientId, t);
    if (kind === 'local' && !this.me) this.me = clientId;
    // insert in seat order
    const after = this._ordered().filter(x => x !== t && (x.seat < seat || (x.seat === seat && x.order < t.order))).pop();
    if (after) after.el.after(el); else this.el.gallery.prepend(el);
    this._applyState(t, true);
    this.layout();
    this._emit('tile:add', { clientId, seat, kind });
    return { el, video, avatar, chrome };
  }

  /**
   * B7 tile chrome (the template in teamslab.html is not edited): skeleton shimmer, bottom reserve scrim + shelf line,
   * a top-right column for the event chip + hand-state chip, and ONE status pill (C3 text + age) in the label bar.
   * Idempotent: a template that already carries these nodes is left alone.
   */
  _dressChrome(el, name, kind) {
    const chrome = $(el, '.tile__chrome'), str = this.strings.tile;
    if (!chrome || $(el, '.tile__handstate')) return;
    const mk = (tag, cls, attrs = {}) => { const e = document.createElement(tag); e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    // skeleton (under every other chrome node) + waiting note
    const sk = mk('div', 'tile__skeleton', { 'aria-hidden': 'true' });
    const skHand = mk('span', 'tile__skeleton-hand'); skHand.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${HAND_ICONS.open}</svg>`;
    const skText = mk('span', 'tile__skeleton-text tw-caption1'); skText.textContent = str.warming;
    sk.append(skHand, skText);
    chrome.prepend(sk);
    const waiting = mk('div', 'tile__waiting tw-caption1'); waiting.hidden = true; waiting.textContent = str.waiting(name);
    sk.after(waiting);
    // bottom reserve scrim (40 px) + the shelf guide line above it
    const reserve = mk('div', 'tile__reserve', { 'aria-hidden': 'true' });
    const shelf = mk('div', 'tile__shelf', { 'aria-hidden': 'true' }); shelf.hidden = true;
    const shelfTag = mk('span', 'tile__shelf-tag'); shelfTag.textContent = str.shelf; shelf.appendChild(shelfTag);
    waiting.after(reserve, shelf);
    // top-right column: event chip (INCOMING / MISS / POTATO) above the hand-state chip
    const tr = mk('div', 'tile__tr');
    const chip = $(el, '.tile__chip'); if (chip) { chip.before(tr); tr.appendChild(chip); } else chrome.appendChild(tr);
    const hs = mk('span', 'tile__handstate', { 'data-state': 'none' }); hs.hidden = true;
    const hsIcon = mk('i', 'tile__handstate-icon', { 'aria-hidden': 'true' }); const hsText = mk('span', 'tile__handstate-text');
    hs.append(hsIcon, hsText); tr.appendChild(hs);
    // single status pill: wrap the C3 pill (verbatim text) + the age span in one visual pill
    const pill = $(el, '.tile__pill'), age = $(el, '.tile__age');
    if (pill) { const status = mk('span', 'tile__status'); pill.before(status); status.appendChild(pill); if (age) status.appendChild(age); }
    const ballChip = $(el, '.tile__ballchip'); if (ballChip) ballChip.hidden = true;     // dropped in favour of the hand-state chip
    if (kind !== 'local') hs.dataset.remote = 'true';
  }

  removeTile(clientId) {
    const t = this.tiles.get(clientId); if (!t) return;
    t.el.remove(); this.tiles.delete(clientId);
    if (this.me === clientId) this.me = [...this.tiles.values()].find(x => x.kind === 'local')?.clientId ?? null;
    if (this.tiles.size && ![...this.tiles.values()].some(x => x.el.tabIndex === 0)) this._ordered()[0].el.tabIndex = 0;
    this.layout();
    this._emit('tile:remove', { clientId });
  }

  /** seatMap: array of clientIds in seat order | { seats:[{clientId}|clientId] } | Map<clientId, seat> | {clientId: seat}. */
  reorder(seatMap) {
    let order;
    if (Array.isArray(seatMap)) order = seatMap.map(s => typeof s === 'string' ? s : s?.clientId);
    else if (seatMap instanceof Map) order = [...seatMap.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    else if (Array.isArray(seatMap?.seats)) order = seatMap.seats.map(s => typeof s === 'string' ? s : s?.clientId);
    else if (seatMap && typeof seatMap === 'object') order = Object.entries(seatMap).sort((a, b) => a[1] - b[1]).map(e => e[0]);
    if (!order) return;
    let seat = 0;
    for (const id of order) { const t = this.tiles.get(id); if (!t) continue; t.seat = seat; t.el.dataset.seat = seat; t.el.style.setProperty('--seat-color', `var(--tw-seat-${seat % 9})`); seat++; }
    for (const t of this._ordered()) { if (!order.includes(t.clientId)) { t.seat = seat; t.el.dataset.seat = seat; seat++; } }
    for (const t of this._ordered()) this.el.gallery.appendChild(t.el);   // DOM order = seat order (tab order)
    this.layout();
    this._emit('reorder', { order: this._ordered().map(t => t.clientId) });
  }

  /** Partial state patch; pills per consent-copy C3, rings per overlay-sketches §5. */
  setTileState(clientId, patch = {}, { immediate = false } = {}) {
    const t = this.tiles.get(clientId); if (!t) return;
    const prev = { ...t.state };
    Object.assign(t.state, patch);
    this._applyState(t, false, prev, immediate);
  }

  _applyState(t, initial, prev = {}, immediate = false) {
    const s = t.state, el = t.el, str = this.strings;
    el.classList.toggle('is-speaking', !!s.speaking);
    el.classList.toggle('is-raised', !!s.raised);
    el.classList.toggle('is-goal', !!s.goal);
    el.classList.toggle('has-ball', !!s.ball);
    el.classList.toggle('is-muted', !!s.muted);
    el.classList.toggle('is-pinned', !!s.pinned);
    if (s.ring) el.dataset.ring = s.ring; else delete el.dataset.ring;
    if (s.ring && s.ring !== prev.ring && s.ring !== 'incoming' && s.ring !== 'potato') {   // 200 ms flash then clear
      clearTimeout(t.ringTimer);
      t.ringTimer = setTimeout(() => { if (t.state.ring === s.ring) { t.state.ring = null; delete el.dataset.ring; } }, this.reducedMotion ? 400 : 220);
    }
    const media = t.video, avatar = t.avatar;
    const alpha = Number.isFinite(s.alpha) ? Math.max(0, Math.min(1, s.alpha)) : 1;
    media.style.opacity = alpha; avatar.style.opacity = alpha;
    const age = $(el, '.tile__age');
    if (age) { const show = t.kind !== 'local' && Number.isFinite(s.ageMs); age.hidden = !show; if (show) age.textContent = `${Math.round(s.ageMs)} ms`; }
    const chip = $(el, '.tile__chip');
    if (chip) { chip.hidden = !s.chip; chip.textContent = s.chip ?? ''; }
    // B7: the raw 'ball' pill stays hidden; a remote tile that owns the ball shows the hand-state chip 'Has the ball'
    const ballChip = $(el, '.tile__ballchip'); if (ballChip) ballChip.hidden = true;
    this._paintHandState(t);
    // B7: skeleton while the tracker warms up (never a black tile); quiet "Waiting for <name>" on a remote with no data
    el.classList.toggle('is-loading', !!s.loading);
    const waiting = $(el, '.tile__waiting');
    if (waiting) {
      const noData = t.kind !== 'local' && s.pill !== 'camera-off' && !s.loading && (s.pill === 'no-data' || (Number.isFinite(s.ageMs) && s.ageMs > 2000));
      waiting.hidden = !noData; waiting.textContent = str.tile.waiting(t.name);
      el.classList.toggle('is-waiting', noData);
    }
    // pill (C3): one DOM write per 500 ms unless user-driven
    if (initial || s.pill !== prev.pill) this._writePill(t, initial || immediate);
    // camera-off surface: avatar when the media is not live
    const camOff = s.pill === 'camera-off' || (t.kind !== 'local' && !media.srcObject && !media.src);
    el.classList.toggle('is-camoff', camOff);
    el.setAttribute('aria-label', this._ariaLabel(t));
    // announcements (C3): once per change, throttled by announce(); the first packets of a tile are not a "resume"
    if (!initial && s.pill !== prev.pill) {
      const a = str.c3.announce;
      if (t.kind === 'local') { if (immediate) { /* user-driven (C4 toggle): the caller announces */ } else if (s.pill === 'tracking') this.announce(a.tracking); else if (s.pill === 'device-only') this.announce(a['device-only']); }
      else if (s.pill === 'landmarks' && prev.pill === 'no-data' && t.hadData) this.announce(a.resumed(t.name));
      else if (s.pill === 'no-data' && prev.pill === 'landmarks') this.announce(a.lost(t.name));
      if (s.pill === 'landmarks') t.hadData = true;
    }
  }

  /** One DOM write per 500 ms per pill (remote packet flapping); `force` = user-driven change (C4) or the deferred timer. */
  _writePill(t, force = false) {
    const now = performance.now(), dt = now - t.pillAt;
    if (!force && dt < PILL_WRITE_MS) { if (!t.pillPending) t.pillPending = setTimeout(() => { t.pillPending = 0; this._writePill(t, true); }, PILL_WRITE_MS - dt + 1); return; }
    if (t.pillPending) { clearTimeout(t.pillPending); t.pillPending = 0; }
    t.pillAt = now;
    const pill = $(t.el, '.tile__pill'), s = t.state, c3 = this.strings.c3;
    const kind = s.pill ?? (t.kind === 'local' ? 'camera-off' : 'no-data');
    let label = typeof c3.pill[kind] === 'function' ? c3.pill[kind](t.seatLabel ?? t.name) : c3.pill[kind] ?? kind;
    // HoloHands: tracking is live but the rigs are not drawn -> '· hands hidden' (C3 text stays verbatim in front)
    const hidden = !this._holo.shown && LIVE_PILLS.has(kind);
    if (hidden) label += ' · ' + this.strings.holo.hidden;
    pill.textContent = label; pill.dataset.pill = kind; pill.title = c3.title[kind] ?? '';
    pill.dataset.hands = hidden ? 'hidden' : 'shown';
    t.el.dataset.pill = kind;
  }

  /**
   * B7 hand-state chip. `slot` = hand slot index from the tracker (0/1 — never a left/right label); `state` = one of
   * HAND_STATES keys, 'holding:wrap|clip|cradle', { kind, how }, or null/'none' to clear the slot.  The chip shows the
   * highest-priority slot; the title lists every slot.  Emits 'handstate' { clientId, slot, state, summary }.
   */
  setHandState(slot, state, { clientId = this.me } = {}) {
    const t = clientId != null ? this.tiles.get(clientId) : null; if (!t) return null;
    const label = handStateLabel(state), k = String(slot ?? 0);
    const hands = { ...t.state.hands };
    if (label.key === 'none') delete hands[k]; else hands[k] = label.key;
    const summary = summarizeHandStates(Object.keys(hands).sort().map(s => hands[s]));
    const changed = t.state.hand !== summary.key || JSON.stringify(t.state.hands) !== JSON.stringify(hands);
    t.state.hands = hands; t.state.hand = summary.key;
    if (changed) { this._paintHandState(t); t.el.setAttribute('aria-label', this._ariaLabel(t)); this._emit('handstate', { clientId: t.clientId, slot, state: label.key, summary: summary.key, hands }); }
    return summary.key;
  }
  /** Hand-state chip for every slot at once ({ slot: state } or [state0, state1]). */
  setHandStates(states, { clientId = this.me } = {}) {
    const entries = Array.isArray(states) ? states.map((s, i) => [i, s]) : Object.entries(states ?? {});
    const t = clientId != null ? this.tiles.get(clientId) : null; if (!t) return null;
    for (const k of Object.keys(t.state.hands)) if (!entries.some(([s]) => String(s) === k)) this.setHandState(k, 'none', { clientId });
    let out = 'none'; for (const [slot, s] of entries) out = this.setHandState(slot, s, { clientId }) ?? out;
    return out;
  }
  handState(clientId = this.me) { const t = this.tiles.get(clientId); return t ? { summary: t.state.hand, hands: { ...t.state.hands } } : null; }

  _paintHandState(t) {
    const hs = $(t.el, '.tile__handstate'); if (!hs) return;
    const s = t.state;
    let label = handStateLabel(s.hand);
    if (label.key === 'none' && s.ball && t.kind !== 'local') label = handStateLabel('ball');   // remote owner: 'Has the ball'
    hs.hidden = label.key === 'none';
    hs.dataset.state = label.key; hs.dataset.icon = label.icon;
    $(hs, '.tile__handstate-text').textContent = label.text;
    const icon = $(hs, '.tile__handstate-icon');
    if (icon && icon.dataset.icon !== label.icon) { icon.dataset.icon = label.icon; icon.innerHTML = label.icon === 'none' ? '' : `<svg viewBox="0 0 16 16" aria-hidden="true">${HAND_ICONS[label.icon] ?? ''}</svg>`; }
    const slots = Object.keys(s.hands ?? {}).sort();
    hs.title = slots.length > 1 ? slots.map(k => `hand ${k}: ${handStateLabel(s.hands[k]).text}`).join(' · ') : '';
  }

  _ariaLabel(t) {
    const s = t.state, parts = [t.kind === 'local' ? `${t.name} (you)` : t.name];
    if (t.kind === 'local') parts.push(s.pill === 'camera-off' ? 'camera off' : 'camera on');
    else parts.push(s.pill === 'landmarks' ? 'hand data live' : s.pill === 'camera-off' ? 'camera off' : 'no tracking data');
    parts.push(s.muted ? 'muted' : 'unmuted');
    if (s.speaking) parts.push('speaking');
    if (s.raised) parts.push('hand raised');
    if (s.pinned) parts.push('pinned');
    if (s.pill === 'device-only') parts.push('on-device only');
    if (s.ball) parts.push('holding the ball');
    if (s.goal) parts.push('goal tile');
    if (s.hand && s.hand !== 'none') parts.push('hand ' + handStateLabel(s.hand).text.toLowerCase().replace(' · ', ' '));
    if (s.loading) parts.push('tracker starting');
    return parts.join(', ');
  }

  _galleryKeys(e) {
    if (this.kbActive) return;                                            // K: arrows move the keyboard hand instead
    const tiles = this._ordered().map(t => t.el), i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tiles.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tiles.length) % tiles.length;
    else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tiles.length - 1;
    else if (e.key === 'Enter') { this._emit('tile:more', { clientId: tiles[i].dataset.client }); e.preventDefault(); return; }
    else if (e.key === 'p' || e.key === 'P') { this._emit('tile:pin', { clientId: tiles[i].dataset.client }); e.preventDefault(); return; }
    else return;
    e.preventDefault(); e.stopPropagation();
    tiles[j].focus();
  }

  // ---- scoreboard / potato ----------------------------------------------------------------------------------
  /** bySeat: number[] | {seat: n}; names: string[] | {seat: name}. */
  setScore(bySeat, names = {}) {
    const sb = this.el.scoreboard; if (!sb) return;
    const entries = Array.isArray(bySeat) ? bySeat.map((v, i) => [i, v]) : Object.entries(bySeat ?? {}).map(([k, v]) => [+k, v]);
    sb.replaceChildren();
    if (!entries.length) { sb.hidden = true; return; }
    sb.hidden = false;
    entries.sort((a, b) => a[0] - b[0]).forEach(([seat, score], i) => {
      if (i) sb.appendChild(Object.assign(document.createElement('span'), { className: 'sb__sep', textContent: '–' }));
      const w = document.createElement('span'); w.className = 'sb__seat'; w.style.setProperty('--seat-color', `var(--tw-seat-${seat % 9})`);
      const dot = document.createElement('i'); dot.className = 'sb__dot'; dot.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('span'); nm.className = 'sb__name'; nm.textContent = names?.[seat] ?? [...this.tiles.values()].find(t => t.seat === seat)?.name ?? `seat ${seat}`;
      const sc = document.createElement('b'); sc.className = 'sb__score tw-numeric'; sc.textContent = String(score ?? 0);
      const prevEl = this._scoreEls?.get(seat); if (prevEl && prevEl !== score) sc.classList.add('tick');
      w.append(dot, nm, sc); sb.appendChild(w);
    });
    this._scoreEls = new Map(entries);
  }

  /** Hot potato fuse on the seat's tile: chip "POTATO 1.4s" + ring 'potato'; null clears. */
  setPotato(seat, remainingMs) {
    for (const t of this.tiles.values()) {
      if (t.seat === seat && remainingMs != null) this.setTileState(t.clientId, { chip: this.strings.chips.potato((Math.max(0, remainingMs) / 1000).toFixed(1) + 's'), ring: 'potato' });
      else if (t.state.ring === 'potato') this.setTileState(t.clientId, { chip: null, ring: null });
    }
  }

  // ---- toasts / live regions -------------------------------------------------------------------------------
  toast(text, { ms = 3000, level = 'info' } = {}) {
    const box = this.el.toasts; if (!box) return null;
    const el = document.createElement('div'); el.className = `toast toast--${level}`; el.setAttribute('role', 'status');
    const span = document.createElement('span'); span.textContent = text;
    const x = document.createElement('button'); x.type = 'button'; x.className = 'toast__x tw-focusable'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    const kill = () => { clearTimeout(timer); el.remove(); };
    x.addEventListener('click', kill);
    el.append(span, x); box.appendChild(el);
    const timer = setTimeout(kill, ms);
    if (level === 'error') this.announce(text, 'assertive');
    return el;
  }

  /** Throttled to one message per 2 s per region; the newest pending message wins (never per frame). */
  announce(text, level = 'polite') {
    const reg = this._live[level] ?? this._live.polite, el = level === 'assertive' ? this.el.assertive : this.el.polite;
    if (!el) return;
    const now = performance.now();
    const write = () => {
      reg.at = performance.now(); reg.queued = null;
      el.textContent = text === reg.last ? text + '​' : text; reg.last = el.textContent;
      this._emit('announce', { text, level });
    };
    if (now - reg.at >= ANNOUNCE_MS) { clearTimeout(reg.timer); reg.timer = 0; write(); return; }
    reg.queued = text;
    if (!reg.timer) reg.timer = setTimeout(() => { reg.timer = 0; const q = reg.queued; if (q != null) { text = q; write(); } }, ANNOUNCE_MS - (now - reg.at));
  }

  // ---- consent (C1) --------------------------------------------------------------------------------------------
  /** Resolves 'share' | 'device-only' | 'declined'. `?consent=1` resolves 'share' immediately. Stores hopeos.consent. */
  openConsent() {
    const dlg = this.el.consent, c1 = this.strings.c1;
    const store = (shareMode) => { try { localStorage.setItem('hopeos.consent', JSON.stringify({ version: CONSENT_VERSION, at: new Date().toISOString(), shareMode })); } catch { /* private mode */ } };
    if (this.url.get('consent') === '1') { store('share'); this._emit('consent', { mode: 'share', skipped: true }); return Promise.resolve('share'); }
    let stored = null; try { stored = JSON.parse(localStorage.getItem('hopeos.consent') || 'null'); } catch { /* ignore */ }
    if (stored?.version === CONSENT_VERSION && (stored.shareMode === 'share' || stored.shareMode === 'device-only')) {
      this._emit('consent', { mode: stored.shareMode, stored: true }); return Promise.resolve(stored.shareMode);
    }
    const bump = !!stored && stored.version !== CONSENT_VERSION;
    // fill the dialog from STRINGS (single source of truth)
    $(dlg, '#c1-title').textContent = bump ? this.strings.c2.title : c1.title;
    const body = $(dlg, '#c1-body'); body.replaceChildren();
    const p = (txt, cls) => { const e = document.createElement('p'); if (cls) e.className = cls; e.textContent = txt; body.appendChild(e); return e; };
    if (bump) p(this.strings.c2.body, 'c1-bump');
    p(c1.intro);
    p(c1.sharedHeading, 'c1-heading');
    const ul = document.createElement('ul'); for (const s of c1.shared) { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); } body.appendChild(ul);
    const term = p(c1.term); const a = document.createElement('a'); a.href = PRIVACY_URL; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c1.termLink; term.appendChild(a); term.appendChild(document.createTextNode('.'));
    p(c1.release);
    p(c1.illinois, 'c1-illinois tw-caption1');
    const agree = $(dlg, '#c1-agree'), notNow = $(dlg, '#c1-notnow'), dev = $(dlg, '#c1-deviceonly');
    agree.textContent = bump ? this.strings.c2.review : c1.agree; notNow.textContent = c1.notNow; dev.textContent = bump ? this.strings.c2.keep : c1.deviceOnly;
    return new Promise((resolve) => {
      let done = false;
      const finish = (mode) => {
        if (done) return; done = true;
        agree.onclick = notNow.onclick = dev.onclick = null; dlg.removeEventListener('cancel', onCancel);
        if (mode !== 'declined') store(mode);
        if (dlg.open) dlg.close();
        this._emit('consent', { mode });
        resolve(mode);
      };
      const onCancel = (e) => { e.preventDefault(); finish('declined'); };   // Escape = "Not now"; backdrop click never closes
      agree.onclick = () => finish('share'); notNow.onclick = () => finish('declined'); dev.onclick = () => finish('device-only');
      dlg.addEventListener('cancel', onCancel);
      if (!dlg.open) dlg.showModal();
      agree.focus();
    });
  }

  // ---- control bar (role=toolbar) ------------------------------------------------------------------------------
  bindControlBar(h = {}) {
    Object.assign(this._handlers, h);
    const bar = this.el.controlbar;
    this._injectHoloHandsButton(bar);                 // before the roving-tabindex list is taken
    const btns = $$(bar, 'button');
    const c4 = this.strings.c4;
    const b = (id) => $(bar, id);
    const toggle = (btn, cb) => btn?.addEventListener('click', () => { const on = btn.getAttribute('aria-pressed') !== 'true'; btn.setAttribute('aria-pressed', String(on)); cb?.(on); });
    toggle(b('#btnCam'), (on) => { this._emit('cam', { on }); h.onCam?.(on); });
    toggle(b('#btnMic'), (on) => { if (this.me) this.setTileState(this.me, { muted: !on }); this._emit('mic', { on }); h.onMic?.(on); });
    b('#btnDeviceOnly')?.addEventListener('click', () => this.setDeviceOnly(b('#btnDeviceOnly').getAttribute('aria-pressed') !== 'true'));
    if (b('#btnDeviceOnly')) b('#btnDeviceOnly').title = c4.titleOff;
    toggle(b('#btnRaise'), (on) => { if (this.me) this.setTileState(this.me, { raised: on }); this._emit('raise', { on }); h.onRaise?.(on); });
    b('#btnShare')?.addEventListener('click', () => this._menu(b('#btnShare'), [{ label: this.strings.bar.playTogether, id: 'play' }, { label: 'Share screen (not in the twin)', id: 'screen', disabled: true }], (id) => { this._emit('share', { id }); h.onShare?.(id); }));
    b('#btnReact')?.addEventListener('click', () => this._menu(b('#btnReact'), ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F62E}', '\u{1F44F}'].map(e => ({ label: e, id: e })), (id) => { this._emit('react', { emoji: id }); h.onReact?.(id); this._float(id); }, 'reactions'));
    b('#btnMore')?.addEventListener('click', () => this._menu(b('#btnMore'), [
      { label: 'Command bar (Ctrl+/)', id: 'command' }, { label: 'Outgoing video (OBS)', id: 'outgoing' }, { label: 'Keyboard shortcuts', id: 'keys' }, { label: 'About / privacy', id: 'about' },
    ], (id) => { if (id === 'command') this.openCommandPopover(); else if (id === 'outgoing') this.openOutgoingHelp(); else if (id === 'about' || id === 'keys') this.openAbout(); this._emit('more', { id }); h.onMore?.(id); }));
    b('#btnLeave')?.addEventListener('click', () => { this._emit('leave', {}); h.onLeave?.(); });
    // roving tabindex + arrow keys (R5)
    btns.forEach((x, i) => { x.tabIndex = i === 0 ? 0 : -1; });
    bar.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement); if (i < 0) return;
      let j = i;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % btns.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = btns.length - 1; else return;
      e.preventDefault(); e.stopPropagation();
      btns.forEach((x, k) => { x.tabIndex = k === j ? 0 : -1; }); btns[j].focus();
    });
    bar.addEventListener('focusin', (e) => { const i = btns.indexOf(e.target); if (i >= 0) btns.forEach((x, k) => { x.tabIndex = k === i ? 0 : -1; }); });
    // topbar: panel toggle + about
    $(this.root, '#btnPanel')?.addEventListener('click', () => this.togglePanel());
    $(this.root, '#btnAbout')?.addEventListener('click', () => this.openAbout());
  }

  // ---- HoloHands mode control ----------------------------------------------------------------------------------
  /** `#btnHoloHands` between Camera and Mic (idempotent: a page that already ships the button is bound, not duplicated). */
  _injectHoloHandsButton(bar) {
    if (!bar) return null;
    let btn = $(bar, '#btnHoloHands');
    if (!btn) {
      btn = document.createElement('button'); btn.id = 'btnHoloHands'; btn.type = 'button'; btn.className = 'cbtn cbtn--holo tw-focusable';
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = `<svg class="tw-icon" viewBox="0 0 20 20" aria-hidden="true">${HOLO_ICON}</svg><span class="cbtn__label"></span><span class="cbtn__mode tw-caption1"></span>`;
      const cam = $(bar, '#btnCam'), mic = $(bar, '#btnMic');
      if (mic) mic.before(btn); else if (cam) cam.after(btn); else bar.prepend(btn);
    }
    const label = $(btn, '.cbtn__label'); if (label) label.textContent = this.strings.bar.holohands;
    this._holo.attachButton(btn, $(btn, '.cbtn__mode'));
    return btn;
  }
  /** Mode change from any source: repaint the live pills, announce (user-driven), emit 'holohands' { mode, prev, shown, source, fadeMs }. */
  _onHoloChange(type, d) {
    this._repaintHoloPills();
    if (d.source !== 'api') this.announce(this.strings.holo.announce[d.mode]);
    if (d.source === 'key') this.toast(`${this.strings.holo.label}: ${this.strings.holo.modes[d.mode]}`, { ms: 1200 });
    this._emit(type, d);
    this._handlers.onHoloHands?.(d.mode, d);
  }
  _repaintHoloPills() { for (const t of this.tiles.values()) if (LIVE_PILLS.has(t.state.pill)) this._writePill(t, true); }
  /** Set the HoloHands mode: 'auto' (default) | 'on' | 'off'. Persists to hopeos.holohands; emits 'holohands' on change. */
  setHoloHands(mode, { source = 'api', emit = true } = {}) { return this._holo.set(mode, { source, emit }); }
  get holoHandsMode() { return this._holo.mode; }
  /** Are the rigs drawn right now (what aria-pressed and the pill suffix reflect)? */
  get holoHandsShown() { return this._holo.shown; }
  /** The page reports whether the rigs are shown (after computeHoloHandsShown): aria-pressed + caption + pills, mode untouched. */
  setHoloHandsShown(on) { const prev = this._holo.shown, v = this._holo.setShown(on); if (v !== prev) this._repaintHoloPills(); return v; }
  /** Convenience: hand over the active-interaction list and let the control compute `shown` for the current mode. */
  setHoloHandsActive(list) { const prev = this._holo.shown, v = this._holo.setActive(list); if (v !== prev) this._repaintHoloPills(); return v; }

  togglePanel(open) {
    const f = this.el.frame, closed = f.classList.contains('panel-closed');
    const next = open == null ? closed : open;
    this._panelUser = true;
    f.classList.toggle('panel-closed', !next);
    $(this.root, '#btnPanel')?.setAttribute('aria-pressed', String(next));
    this._scheduleLayout();
    this._emit('panel', { open: next });
  }

  _menu(anchor, items, onPick, kind = 'menu') {
    $(this.root, '.tw-menu')?.remove();
    const m = document.createElement('div'); m.className = `tw-menu tw-menu--${kind}`; m.setAttribute('role', 'menu');
    for (const it of items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tw-menu__item tw-focusable'; b.setAttribute('role', 'menuitem'); b.textContent = it.label; b.disabled = !!it.disabled;
      b.addEventListener('click', () => { m.remove(); anchor.focus(); onPick(it.id); });
      m.appendChild(b);
    }
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close, true); if (e.type === 'keydown') anchor.focus(); } };
    setTimeout(() => { document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', close, true); });
    this.el.frame.appendChild(m);
    const a = anchor.getBoundingClientRect(), f = this.el.frame.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(f.width - m.offsetWidth - 8, a.left - f.left + a.width / 2 - m.offsetWidth / 2)) + 'px';
    m.style.bottom = (f.bottom - a.top + 4) + 'px';
    m.querySelector('button:not(:disabled)')?.focus();
  }

  _float(emoji) {
    const t = this.me && this.tiles.get(this.me); if (!t || this.reducedMotion) return;
    const f = document.createElement('span'); f.className = 'tile__reaction'; f.textContent = emoji; f.setAttribute('aria-hidden', 'true');
    t.chrome.appendChild(f); setTimeout(() => f.remove(), 3100);
  }

  // ---- side panel (role=tablist) --------------------------------------------------------------------------------
  bindPanel(h = {}) {
    Object.assign(this._handlers, h);
    const p = this.el.panel, tabs = $$(p, '[role=tab]');
    const select = (tab, focus = false) => {
      tabs.forEach(t => { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; const pane = $(p, '#' + t.getAttribute('aria-controls')); if (pane) pane.hidden = !on; });
      if (focus) tab.focus();
      const name = tab.dataset.tab; this._emit('tab', { name }); h.onTab?.(name);
      if (name === 'api') this.updateApiLive();
    };
    tabs.forEach(t => t.addEventListener('click', () => select(t)));
    $(p, '[role=tablist]')?.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      let j = i;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1; else return;
      e.preventDefault(); e.stopPropagation(); select(tabs[j], true);
    });
    this.selectTab = (name) => { const t = tabs.find(x => x.dataset.tab === name); if (t) select(t); };
    // layers
    $$(p, 'input[data-layer]').forEach(cb => cb.addEventListener('change', () => { this._emit('layer', { name: cb.dataset.layer, on: cb.checked }); h.onLayer?.(cb.dataset.layer, cb.checked); }));
    // HoloHands: the "Holohands" layer checkbox mirrors the mode (on = Auto, off = Off); bound AFTER the 'layer' listener so
    // the 'holohands' event (and the page hook that applies computeHoloHandsShown) always runs last on a click
    const holoCb = $(p, 'input[data-layer="hands"]'); if (holoCb) this._holo.attachCheckbox(holoCb);
    // mode / goal / play / kickoff / reset
    $$(p, 'input[name=mode]').forEach(r => r.addEventListener('change', () => { if (r.checked) { this._emit('mode', { mode: r.value }); h.onMode?.(r.value); } }));
    $(p, '#goalSeat')?.addEventListener('change', (e) => { const seat = +e.target.value; this._emit('goal', { seat }); h.onGoal?.(seat); });
    $(p, '#btnPlay')?.addEventListener('click', () => { this._emit('play', {}); h.onPlay?.(); });
    $(p, '#btnKickoff')?.addEventListener('click', () => { this._emit('kickoff', {}); h.onKickoff?.(); });
    $(p, '#btnReset')?.addEventListener('click', () => { this._emit('reset', {}); h.onReset?.(); });
    // B7 sliders (Ball size / Shelf height) after the "Goal tile" row; events 'ballsize' {value} and 'shelf' {pct}
    this._injectSliders(p, h);
    // command field (Game tab) + popover form share one submit path
    const submit = (form) => (e) => { e.preventDefault(); const inp = form.querySelector('input,textarea'); const text = inp.value.trim(); if (!text) return; inp.value = ''; this._emit('command', { text }); h.onCommand?.(text); if (form.closest('dialog')?.open) form.closest('dialog').close(); };
    for (const form of [$(p, '#cmdForm'), $(this.el.cmdPopover, 'form')]) if (form) { form.addEventListener('submit', submit(form)); const inp = form.querySelector('input'); if (inp) inp.placeholder = this.strings.c7.placeholder; }
    // push-to-talk (C7): pointer capture, aria-pressed while held, label per state; V key handled by bindKeys
    for (const btn of [$(p, '#btnPtt'), $(this.el.cmdPopover, '.ptt')]) if (btn) this._bindPtt(btn);
    // C7 notice with "Got it" (stored)
    const c7 = this.el.c7;
    if (c7) {
      let seen = false; try { seen = localStorage.getItem('hopeos.c7') === '1'; } catch { /* ignore */ }
      $(c7, '.c7__text').textContent = this.strings.c7.notice;
      const a = document.createElement('a'); a.href = PRIVACY_URL; a.target = '_blank'; a.rel = 'noopener'; a.textContent = this.strings.c7.noticeLink; $(c7, '.c7__text').append(a, this.strings.c7.noticeTail);
      const got = $(c7, 'button'); got.textContent = this.strings.c7.gotIt;
      got.addEventListener('click', () => { c7.hidden = true; try { localStorage.setItem('hopeos.c7', '1'); } catch { /* ignore */ } });
      c7.hidden = seen;
    }
    // goal select options follow the tiles
    this.addEventListener('tile:add', () => this._fillGoalSelect()); this.addEventListener('tile:remove', () => this._fillGoalSelect()); this.addEventListener('reorder', () => this._fillGoalSelect());
    this._fillGoalSelect();
    select(tabs.find(t => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
  }

  _bindPtt(btn) {
    const c7 = this.strings.c7, label = $(btn, '.ptt__label') ?? btn;
    btn.title = c7.notice.slice(0, 160) + '…';
    label.textContent = c7.ptt.idle;
    const down = (e) => { if (btn.disabled) return; e.preventDefault(); btn.setPointerCapture?.(e.pointerId); btn.setAttribute('aria-pressed', 'true'); label.textContent = c7.ptt.held; this._emit('ptt', { down: true }); this._handlers.onPttDown?.(); };
    const up = (e) => { if (btn.getAttribute('aria-pressed') !== 'true') return; e?.preventDefault?.(); btn.setAttribute('aria-pressed', 'false'); label.textContent = c7.ptt.sending; this._emit('ptt', { down: false }); this._handlers.onPttUp?.(); setTimeout(() => { if (btn.getAttribute('aria-pressed') !== 'true') label.textContent = c7.ptt.idle; }, 1500); };
    btn.addEventListener('pointerdown', down); btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up); btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('keydown', (e) => { if ((e.key === 'Enter') && !e.repeat) down(e); });
    btn.addEventListener('keyup', (e) => { if (e.key === 'Enter') up(e); });
    this._pttBtns = (this._pttBtns ?? []).concat(btn);
  }

  /** Hold-to-talk from the V key (SPEC §5): mirrors the button state. */
  pttFromKey(down) { for (const b of this._pttBtns ?? []) { if (b.disabled) continue; if (down) { b.setAttribute('aria-pressed', 'true'); ($(b, '.ptt__label') ?? b).textContent = this.strings.c7.ptt.held; } else { b.setAttribute('aria-pressed', 'false'); ($(b, '.ptt__label') ?? b).textContent = this.strings.c7.ptt.idle; } } }

  /** Builds the two slider rows (idempotent) and binds them; `h.onBallSize(value)` / `h.onShelf(pct)` mirror the events. */
  _injectSliders(p, h = {}) {
    const anchor = $(p, '#goalSeat')?.closest('.panel__row') ?? null, pane = $(p, '#pane-game');
    const str = this.strings.sliders;
    const build = (spec) => {
      let input = $(p, '#' + spec.id), row = input?.closest('.panel__row');
      if (!input) {
        row = document.createElement('div'); row.className = 'panel__row panel__row--slider'; row.dataset.slider = spec.name;
        const lab = document.createElement('label'); lab.htmlFor = spec.id; lab.textContent = str[spec.name] ?? spec.label;
        input = document.createElement('input'); input.type = 'range'; input.id = spec.id; input.className = 'tw-slider tw-focusable'; input.min = spec.min; input.max = spec.max; input.step = spec.step;
        input.setAttribute('aria-describedby', spec.id + 'Out');
        const out = document.createElement('output'); out.id = spec.id + 'Out'; out.className = 'tw-numeric slider__out'; out.htmlFor = spec.id;
        const ends = document.createElement('span'); ends.className = 'slider__ends tw-caption1'; ends.setAttribute('aria-hidden', 'true'); ends.textContent = `${str[spec.ends[0]] ?? spec.ends[0]} ← → ${str[spec.ends[1]] ?? spec.ends[1]}`;
        row.append(lab, input, out, ends);
        if (anchor) anchor.after(row); else pane?.appendChild(row);
      }
      const start = spec.name === 'shelf' ? this.shelfPct : this.ballSize;
      input.value = String(start);
      const out = $(row, 'output') ?? $(p, '#' + spec.id + 'Out');
      let storage = null; try { storage = localStorage; } catch { /* private mode */ }
      const handle = bindSlider(input, spec, { output: out, storage, emit: (ev, d) => {
        if (spec.name === 'shelf') this.setShelf(d.pct, { emit: false }); else this.ballSize = d.value;
        this._emit(ev, d); (spec.name === 'shelf' ? h.onShelf : h.onBallSize)?.(d[spec.key], d);
      } });
      this._sliders[spec.name] = handle;
    };
    // insert in reverse so the DOM order is Ball size, Shelf height right after the goal row
    build(SLIDERS.shelf); build(SLIDERS.ballsize);
  }

  /** Ball radius slider value (court units); `setBallSize(v)` moves the slider and emits 'ballsize' unless emit:false. */
  setBallSize(v, { emit = true } = {}) {
    const h = this._sliders.ballsize;
    this.ballSize = h ? h.set(v, { emit }) : sliderValue(SLIDERS.ballsize, v);
    if (!h && emit) this._emit('ballsize', { name: 'ballsize', value: this.ballSize });
    return this.ballSize;
  }
  /** Shelf height as % of tile height from the bottom; sets `--tw-shelf` on the frame (shelf guide line) and emits 'shelf' {pct}. */
  setShelf(pct, { emit = true, show } = {}) {
    const v = sliderValue(SLIDERS.shelf, pct);
    this.shelfPct = v; this.el.frame.style.setProperty('--tw-shelf', v + '%');
    const h = this._sliders.shelf; if (h && h.value !== v) h.set(v, { emit: false });
    if (show != null) this.showShelf(show);
    if (emit) this._emit('shelf', { name: 'shelf', pct: v, value: v });
    return v;
  }
  /** Shows the shelf guide line on the local tile (or `clientId`) — the integrator turns it on while the game runs. */
  showShelf(on, clientId = this.me) {
    const t = clientId != null ? this.tiles.get(clientId) : null; if (!t) return;
    const line = $(t.el, '.tile__shelf'); if (line) line.hidden = !on;
    t.el.classList.toggle('has-shelf', !!on);
  }

  // ---- coach (B7; sdk/game/coach.js) ------------------------------------------------------------------------------
  /** Lazy Coach bound to this UI; `ui.coach.attach(game, { nameOfSeat, mySeat })` wires BallGame events to toasts. */
  get coach() { if (!this._coach) this._coach = new Coach(this); return this._coach; }
  /** First-run coach marks: 3 dismissible hints anchored to the local tile, the neighbour's tile and #btnPtt. */
  startCoach(opts = {}) { return this.coach.start(opts); }
  /** Contextual coaching toast: 'catch' -> "Nice catch", 'miss' -> "Cup lower, palm up", 'goal' {name} -> "GOAL for <name>". */
  coachEvent(type, detail = {}) { return this.coach.event(type, detail); }

  _fillGoalSelect() {
    const sel = $(this.el.panel, '#goalSeat'); if (!sel) return;
    const cur = sel.value; sel.replaceChildren();
    for (const t of this._ordered()) { const o = document.createElement('option'); o.value = t.seat; o.textContent = `${t.seat}: ${t.name}`; sel.appendChild(o); }
    if (cur !== '' && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  /** Command-agent status row + result card (SPEC §7): status in {idle,listening,thinking,acting,done,error}. */
  setAgentStatus(status, last = null) {
    for (const el of [this.el.cmdStatus, $(this.el.cmdPopover, '.cmd__status')]) if (el) { el.dataset.status = status; el.textContent = { idle: '', listening: 'listening…', thinking: `thinking${last?.ms ? ` (${(last.ms / 1000).toFixed(1)} s)` : '…'}`, acting: 'acting…', done: last?.source === 'local' ? 'done · local grammar' : 'done', error: last?.text ?? 'error' }[status] ?? status; }
    if (!last) return;
    for (const card of [this.el.cmdCard, $(this.el.cmdPopover, '.cmd__card')]) if (card) {
      card.hidden = false; card.dataset.status = status;
      $(card, '.cmd__say').textContent = last.say ?? last.text ?? '';
      $(card, '.cmd__meta').textContent = [last.source, last.rounds != null ? `${last.rounds} rd` : null, last.ms != null ? `${Math.round(last.ms)} ms` : null, last.actions?.length ? last.actions.map(a => a.name ?? a).join(', ') : null].filter(Boolean).join(' · ');
    }
    if (status === 'done' && last.say) this.announce(last.say);
    if (status === 'error' && last.text) this.announce(last.text, 'assertive');
  }

  // ---- keys (SPEC §5) ------------------------------------------------------------------------------------------
  bindKeys({ onKey } = {}) {
    const typing = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
    const fire = (action, down, e) => { this._emit('key', { action, down }); onKey?.(action, down); if (e) e.preventDefault(); };
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === '/') { this.openCommandPopover(); fire('command', true, e); return; }
      if (e.key === 'Escape') { for (const d of [this.el.cmdPopover, this.el.about]) if (d?.open) d.close(); $(this.root, '.tw-menu')?.remove(); fire('esc', true); return; }
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^Digit[1-9]$/.test(e.code)) { if (!e.repeat) fire('goal:' + e.code.slice(5), true, e); return; }
      const action = KEY_ACTIONS[e.code]; if (!action) return;
      if (action === 'kbhand') { if (e.repeat) return; this.kbActive = !this.kbActive; fire('kbhand', this.kbActive, e); return; }
      if (['left', 'right', 'up', 'down', 'cup'].includes(action)) {
        if (!this.kbActive && action !== 'cup') return;                     // arrows belong to focus movement until K
        if (e.repeat) { e.preventDefault(); return; }
        fire(action, true, e); return;
      }
      if (action === 'ptt') { if (e.repeat) return; this.pttFromKey(true); fire('ptt', true, e); return; }
      if (e.repeat) return;
      if (action === 'holohands') this._holo.key(action, true);          // H: Auto -> On -> Off -> Auto (emits 'holohands')
      fire(action, true, e);
    });
    document.addEventListener('keyup', (e) => {
      if (typing(e)) return;
      const action = KEY_ACTIONS[e.code]; if (!action) return;
      if (['left', 'right', 'up', 'down', 'cup'].includes(action)) { if (this.kbActive || action === 'cup') fire(action, false, e); return; }
      if (action === 'ptt') { this.pttFromKey(false); fire('ptt', false, e); return; }
      if (['kickoff', 'play', 'mute', 'hud', 'holohands'].includes(action)) fire(action, false);
    });
    window.addEventListener('blur', () => { for (const a of ['left', 'right', 'up', 'down', 'cup', 'ptt']) fire(a, false); });
  }

  // ---- roster / API tab --------------------------------------------------------------------------------------------
  renderRoster(roster = [], me = null) {
    const list = this.el.roster; if (!list) return;
    list.replaceChildren();
    for (const r of roster) {
      const li = document.createElement('li'); li.className = 'roster__row'; li.dataset.client = r.clientId;
      const av = document.createElement('span'); av.className = 'roster__avatar'; av.textContent = initials(r.name); av.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('span'); nm.className = 'roster__name'; nm.textContent = r.name + (r.clientId === (me?.clientId ?? me) ? ' (you)' : '');
      const meta = document.createElement('span'); meta.className = 'roster__meta tw-caption1';
      meta.textContent = [r.kind && r.kind !== 'remote' && r.kind !== 'local' ? r.kind : null, r.seat != null ? `seat ${r.seat}` : null, r.isHost ? 'host' : null, r.tracked === false ? 'no data' : null].filter(Boolean).join(' · ');
      li.append(av, nm, meta); list.appendChild(li);
    }
    const count = $(this.el.panel, '#rosterCount'); if (count) count.textContent = String(roster.length);
  }

  renderApiTab(rows = API_ROWS) {
    const box = this.el.apiRows; if (!box) return;
    this._apiRows = rows; box.replaceChildren();
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'api__row'; row.dataset.layer = r.layer;
      const head = document.createElement('div'); head.className = 'api__head';
      const name = document.createElement('b'); name.textContent = r.layer;
      const pill = document.createElement('span'); pill.className = 'api__pill'; pill.dataset.pill = r.pill; pill.textContent = r.pill;
      head.append(name, pill);
      const twin = document.createElement('div'); twin.className = 'api__twin tw-caption1'; twin.textContent = r.twin;
      const path = document.createElement('div'); path.className = 'api__path tw-caption1'; path.textContent = 'Return path: ' + r.path;
      const live = document.createElement('div'); live.className = 'api__live tw-caption1 tw-numeric'; live.textContent = 'live: ' + safeLive(r);
      const links = document.createElement('div'); links.className = 'api__links tw-caption1';
      (r.links ?? []).forEach((l, i) => { if (i) links.append(' · '); const a = document.createElement('a'); a.href = l.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = l.label; links.appendChild(a); });
      const blocker = document.createElement('div'); blocker.className = 'api__blocker tw-caption1'; blocker.textContent = 'Blocker: ' + (r.blocker ?? '—');
      row.append(head, twin, path, live, links, blocker); box.appendChild(row);
    }
    clearInterval(this._apiTimer);
    this._apiTimer = setInterval(() => this.updateApiLive(), 1000);   // 1 Hz; skipped while the tab is hidden
  }

  /** T7: register per-layer live getters ({ [layer]: () => string }); a non-function value removes the getter. */
  setApiLive(map = {}) {
    for (const [layer, fn] of Object.entries(map)) { if (typeof fn === 'function') API_LIVE[layer] = fn; else delete API_LIVE[layer]; }
    this.updateApiLive({ force: true });
  }

  updateApiLive({ force = false } = {}) {
    const box = this.el.apiRows; if (!box || (!force && box.closest('[role=tabpanel]')?.hidden)) return;
    $$(box, '.api__row').forEach((row, i) => { const r = this._apiRows[i]; if (r) $(row, '.api__live').textContent = 'live: ' + safeLive(r); });
  }

  // ---- dialogs -------------------------------------------------------------------------------------------------------
  openCommandPopover() { const d = this.el.cmdPopover; if (!d) return; if (!d.open) d.showModal(); d.querySelector('input')?.focus(); this._emit('popover', { open: true }); }
  openAbout() { const d = this.el.about; if (!d) return; if (!d.open) d.showModal(); }
  openOutgoingHelp() { this.openAbout(); $(this.el.about, '#about-outgoing')?.scrollIntoView({ block: 'start' }); $(this.el.about, '#about-outgoing')?.focus?.(); }

  // ---- motion / device-only ------------------------------------------------------------------------------------------
  setReducedMotion(on) { if (on == null) delete this.el.frame.dataset.reducedMotion; else this.el.frame.dataset.reducedMotion = on ? 'true' : 'false'; this._emit('motion', { reducedMotion: this.reducedMotion }); }
  get reducedMotion() { return getComputedStyle(this.el.frame).getPropertyValue('--tw-motion').trim() === '0'; }

  /** C4: pill + button state + announcement; emits 'deviceonly' (T6 gates the transport and the agent on it). */
  setDeviceOnly(on) {
    const btn = $(this.el.controlbar, '#btnDeviceOnly'), c4 = this.strings.c4;
    if (btn) { btn.setAttribute('aria-pressed', String(!!on)); btn.title = on ? c4.titleOn : c4.titleOff; }
    if (this.me) { const t = this.tiles.get(this.me); if (t && t.state.pill !== 'camera-off') this.setTileState(this.me, { pill: on ? 'device-only' : 'tracking' }, { immediate: true }); }
    for (const b of this._pttBtns ?? []) b.disabled = !!on;     // C7: on-device-only disables push-to-talk
    this.announce(on ? c4.announceOn : c4.announceOff);
    this.deviceOnly = !!on;
    this._emit('deviceonly', { on: !!on });
    this._handlers.onDeviceOnly?.(!!on);
  }

  setHudChip(text) { if (this.el.hudChip) { this.el.hudChip.textContent = text ?? ''; this.el.hudChip.hidden = !text; } }
  setTimer(ms) { if (!this.el.timer) return; const s = Math.floor(ms / 1000); this.el.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

function safeLive(r) { try { return String(r.live?.() ?? '—'); } catch (e) { return 'err'; } }
function cloneDeep(v) { return Array.isArray(v) ? v.map(cloneDeep) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneDeep(x)])) : v; }  // keeps functions
function deepMerge(a, b) { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]); else a[k] = b[k]; } return a; }
export { SEAT_PALETTE };
