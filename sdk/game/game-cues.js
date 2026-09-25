/**
 * sdk/game/game-cues.js — GAME UI for every lane (the template under test).
 * ═══════════════════════════════════════════════════════════════════════════════
 * One component, four parts, one set of tokens. Browser only (DOM), no three, no
 * tracking, never takes pointer events. Mount it once per page; every game moment
 * in every lane (engine or mirror, ball, cube, bow, beat, twin) goes through it —
 * no ad-hoc toasts for game state. See docs/GAME-UI.md for the contract.
 *
 *   CUE      the call-out: "GO!" · "CATCH!" · "AIM!" · "GOAL!" — pops in the middle
 *            of the screen, holds, fades in ~1.7 s. One at a time. With a GESTURE
 *            glyph above it when the cue asks the player to DO something with their
 *            hands: drawn, animated line art (never an emoji) — catch, throw, call.
 *   BAR      the round bar at the top: left tag (round n), phase label, score;
 *            a timer that DRAINS with the phase. Stays while a round runs.
 *   BANNER   the game tag: icon + name + a hint, top-left, while a game is on —
 *            with the VOICE pill when the microphone is listening (state + what
 *            it heard, pulsing with your voice).
 *
 * TOKENS (GAME_UI): the palette is by MEANING, not by lane —
 *   hot   orange  the moment (GO! · GOAL!)          cool  cyan   system / motion (INCOMING · CATCH! · ROUND OVER)
 *   good  green   you did it (CAUGHT · HIT)          warn  amber  do it now (AIM! · SHOOT! · DRAW)
 *   bad   red     you missed (MISS · DROPPED)
 * Every colour is a CSS variable (--gc-*) on the root element, so a page or a
 * theme re-skins with GameCues.theme({...}) or plain CSS — never by editing this.
 *
 * Elements are addressable for probes and pages: `${id}Hud` (root), `${id}Cue`,
 * `${id}CueBig`, `${id}CueSub`, `${id}CueGlyph`, `${id}Phase`, `${id}Fill`,
 * `${id}Round`, `${id}Score`, `${id}Banner`, `${id}Voice`.
 */
export const GAME_UI = {
  color: {
    hot: '#ffb15d', hotGlow: 'rgba(255, 140, 60, 0.9)',
    cool: '#9ff0ff', coolGlow: 'rgba(102, 224, 255, 0.9)',
    good: '#a6ff5d', goodGlow: 'rgba(93, 255, 125, 0.9)',
    warn: '#ffe08a', warnGlow: 'rgba(255, 210, 90, 0.9)',
    bad: '#ff8a8a', badGlow: 'rgba(255, 90, 90, 0.9)',
    ink: '#ffffff', ink2: '#d7e6f3', mute: '#8fb2c8',
    panel: 'rgba(6, 12, 24, 0.62)', edge: 'rgba(255, 160, 90, 0.3)', track: 'rgba(255, 255, 255, 0.12)',
    fillA: '#ffb15d', fillB: '#ff6a1a', fillCoolA: '#66e0ff', fillCoolB: '#2fa8d8',
    glyph: '#ffffff', glyphBall: '#ff8a3c',
  },
  time: { cueMs: 1700, popIn: 0.12, hold: 0.70, barEaseMs: 120, bannerFadeMs: 250, glyphLoopMs: 1400 },
  type: { cue: 'clamp(44px, 9vw, 96px)', cueSub: '16px', bar: '12px', banner: '13px', weight: 900, tracking: '.1em' },
  layout: { barWidth: 'min(560px, 92vw)', top: 14, cueTop: '36vh', glyph: 'clamp(96px, 16vw, 170px)', radius: 14, z: 30, blur: '10px' },
};
export const CUE_KINDS = ['hot', 'cool', 'good', 'warn', 'bad'];
/** the moments every lane shares — use these names so cues read the same everywhere */
export const MOMENTS = {
  start:    { big: 'GO!',        kind: 'hot' },
  incoming: { big: 'INCOMING!',  kind: 'cool' },
  catch:    { big: 'CATCH!',     kind: 'cool', gesture: 'catch' },
  caught:   { big: 'CAUGHT ✓',   kind: 'good' },
  aim:      { big: 'AIM!',       kind: 'warn', gesture: 'throw' },
  shoot:    { big: 'SHOOT!',     kind: 'warn' },
  shot:     { big: 'SHOT!',      kind: 'warn' },
  goal:     { big: 'GOAL!',      kind: 'hot' },
  hit:      { big: 'HIT!',       kind: 'good' },
  miss:     { big: 'MISS',       kind: 'bad' },
  dropped:  { big: 'DROPPED',    kind: 'bad' },
  thrown:   { big: 'THROWN',     kind: 'warn' },
  call:     { big: 'CALLING…',   kind: 'cool', gesture: 'call' },
  over:     { big: 'ROUND OVER', kind: 'cool' },
};

/**
 * GESTURE GLYPHS — line art, animated by CSS, drawn to a 160×110 box. A hand is a
 * palm arc and five rounded-cap finger strokes; the ball is a circle with its two
 * seams. Everything is currentColor except the ball (--gc-glyph-ball), so a glyph
 * takes the cue's colour.
 */
const HAND_L = `<g class="hand hand-l"><path d="M26 74 Q22 60 32 50 L38 44" /><path d="M38 44 L34 26" /><path d="M46 42 L46 18" /><path d="M54 43 L56 20" /><path d="M62 47 L67 27" /><path d="M32 50 L20 40" /><path d="M26 74 Q40 86 60 78 L66 62" /></g>`;
const HAND_R = `<g class="hand hand-r"><path d="M134 74 Q138 60 128 50 L122 44" /><path d="M122 44 L126 26" /><path d="M114 42 L114 18" /><path d="M106 43 L104 20" /><path d="M98 47 L93 27" /><path d="M128 50 L140 40" /><path d="M134 74 Q120 86 100 78 L94 62" /></g>`;
const BALL = (cx, cy, r) => `<g class="ball"><circle cx="${cx}" cy="${cy}" r="${r}" /><path d="M${cx - r} ${cy} Q${cx} ${cy - r * 0.55} ${cx + r} ${cy}" /><path d="M${cx} ${cy - r} Q${cx + r * 0.55} ${cy} ${cx} ${cy + r}" /></g>`;
export const GESTURES = {
  // two open hands cup UP; the ball drops in on an arc and the hands close a touch
  catch: `<svg viewBox="0 0 160 110" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path class="trail" d="M80 6 Q92 30 80 58" stroke-dasharray="4 7" />
    ${BALL(80, 22, 12)}${HAND_L}${HAND_R}
    <path class="ring" d="M40 92 Q80 106 120 92" stroke-dasharray="3 6" /></svg>`,
  // one hand pushes the ball up and away, along an arc to a small ring
  throw: `<svg viewBox="0 0 160 110" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path class="trail" d="M56 70 Q90 -10 134 34" stroke-dasharray="4 7" />
    <ellipse class="ring" cx="134" cy="36" rx="14" ry="5" />
    ${BALL(60, 58, 12)}
    <g class="hand hand-t"><path d="M34 100 Q28 84 40 76 L48 70" /><path d="M48 70 L50 52" /><path d="M58 68 L62 48" /><path d="M66 70 L72 52" /><path d="M72 76 L80 62" /><path d="M40 76 L28 66" /></g></svg>`,
  // one open palm, held still — three rings settle onto it
  call: `<svg viewBox="0 0 160 110" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <g class="hand hand-c"><path d="M62 96 Q52 78 62 66 L70 58" /><path d="M70 58 L66 30" /><path d="M80 56 L80 20" /><path d="M90 57 L94 24" /><path d="M100 62 L108 36" /><path d="M62 66 L46 54" /><path d="M62 96 Q84 108 104 96 L110 78" /></g>
    <g class="rings"><ellipse cx="82" cy="60" rx="34" ry="10" /><ellipse cx="82" cy="60" rx="50" ry="15" /><ellipse cx="82" cy="60" rx="66" ry="20" /></g></svg>`,
  // the microphone: a capsule with sound waves
  listen: `<svg viewBox="0 0 160 110" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="68" y="16" width="24" height="46" rx="12" /><path d="M54 52 Q80 90 106 52" /><path d="M80 78 L80 94 M66 94 L94 94" />
    <g class="waves"><path d="M40 40 Q34 52 40 64" /><path d="M120 40 Q126 52 120 64" /><path d="M28 32 Q18 52 28 72" /><path d="M132 32 Q142 52 132 72" /></g></svg>`,
};

function css(id) {
  const R = '#' + id + 'Hud', C = GAME_UI.color, T = GAME_UI.time, F = GAME_UI.type, L = GAME_UI.layout;
  const v = (k, d) => `var(--gc-${k}, ${d})`;
  return `
${R} { display: none; pointer-events: none;
  --gc-hot: ${C.hot}; --gc-hot-glow: ${C.hotGlow}; --gc-cool: ${C.cool}; --gc-cool-glow: ${C.coolGlow}; --gc-good: ${C.good}; --gc-good-glow: ${C.goodGlow};
  --gc-warn: ${C.warn}; --gc-warn-glow: ${C.warnGlow}; --gc-bad: ${C.bad}; --gc-bad-glow: ${C.badGlow};
  --gc-ink: ${C.ink}; --gc-ink2: ${C.ink2}; --gc-mute: ${C.mute}; --gc-panel: ${C.panel}; --gc-edge: ${C.edge}; --gc-track: ${C.track};
  --gc-fill-a: ${C.fillA}; --gc-fill-b: ${C.fillB}; --gc-fill-cool-a: ${C.fillCoolA}; --gc-fill-cool-b: ${C.fillCoolB};
  --gc-glyph: ${C.glyph}; --gc-glyph-ball: ${C.glyphBall};
  --gc-radius: ${L.radius}px; --gc-z: ${L.z}; --gc-blur: ${L.blur}; --cue-ms: ${T.cueMs / 1000}s; --glyph-ms: ${T.glyphLoopMs}ms; }
${R}.on { display: block; }
${R} .bar { position: fixed; left: 50%; top: calc(env(safe-area-inset-top, 0px) + ${L.top}px); transform: translateX(-50%); z-index: ${v('z', L.z)}; display: none;
  width: ${L.barWidth}; padding: 8px 14px 10px; border-radius: ${v('radius', L.radius + 'px')}; background: ${v('panel', C.panel)}; backdrop-filter: blur(${v('blur', L.blur)});
  border: 1px solid ${v('edge', C.edge)}; font-family: inherit; color: ${v('ink2', C.ink2)}; }
${R} .bar.on { display: block; }
${R} .bar .row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: ${F.bar}; letter-spacing: ${F.tracking}; text-transform: uppercase; }
${R} .bar .row b { color: ${v('hot', C.hot)}; font-weight: 800; letter-spacing: .14em; }
${R} .bar .row b.cool { color: ${v('cool', C.cool)}; }
${R} .bar .row .sc { color: ${v('mute', C.mute)}; font-variant-numeric: tabular-nums; letter-spacing: .06em; }
${R} .bar .track { height: 6px; margin-top: 7px; border-radius: 3px; background: ${v('track', C.track)}; overflow: hidden; }
${R} .bar .fill { height: 100%; width: 0%; border-radius: 3px; background: linear-gradient(90deg, ${v('fill-a', C.fillA)}, ${v('fill-b', C.fillB)}); box-shadow: 0 0 10px ${v('hot-glow', C.hotGlow)}; transition: width ${T.barEaseMs}ms linear; }
${R} .bar .fill.cool { background: linear-gradient(90deg, ${v('fill-cool-a', C.fillCoolA)}, ${v('fill-cool-b', C.fillCoolB)}); box-shadow: 0 0 10px ${v('cool-glow', C.coolGlow)}; }
${R} .banner { position: fixed; left: 18px; top: calc(env(safe-area-inset-top, 0px) + ${L.top}px); z-index: ${v('z', L.z)}; display: none; align-items: center; gap: 10px;
  padding: 7px 14px 7px 10px; border-radius: 999px; background: ${v('panel', C.panel)}; backdrop-filter: blur(${v('blur', L.blur)}); border: 1px solid ${v('edge', C.edge)};
  color: ${v('ink2', C.ink2)}; font-size: ${F.banner}; letter-spacing: .06em; opacity: 0; transition: opacity ${T.bannerFadeMs}ms; }
${R} .banner.on { display: flex; opacity: 1; }
${R} .banner .ico { font-size: 20px; line-height: 1; }
${R} .banner b { color: ${v('hot', C.hot)}; letter-spacing: .12em; text-transform: uppercase; font-weight: 800; }
${R} .banner .hint { color: ${v('mute', C.mute)}; }
${R} .voice { display: none; align-items: center; gap: 7px; margin-left: 6px; padding-left: 12px; border-left: 1px solid ${v('edge', C.edge)}; color: ${v('mute', C.mute)}; font-size: 12px; letter-spacing: .04em; }
${R} .voice.on { display: inline-flex; }
${R} .voice .dot { width: 9px; height: 9px; border-radius: 50%; background: ${v('mute', C.mute)}; box-shadow: 0 0 0 0 transparent; transition: transform .08s, background .2s; }
${R} .voice.listening .dot { background: ${v('good', C.good)}; box-shadow: 0 0 10px ${v('good-glow', C.goodGlow)}; animation: ${id}Pulse 1.6s ease-in-out infinite; }
${R} .voice.denied .dot, ${R} .voice.error .dot, ${R} .voice.unsupported .dot { background: ${v('bad', C.bad)}; }
${R} .voice .heard { color: ${v('ink2', C.ink2)}; max-width: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; }
${R} .voice .heard:empty::before { content: 'listening…'; color: ${v('mute', C.mute)}; font-style: normal; }
${R} .voice .cmd { color: ${v('cool', C.cool)}; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; }
${R} .cue { position: fixed; left: 50%; top: ${L.cueTop}; transform: translate(-50%, -50%) scale(1); z-index: calc(${v('z', L.z)} + 1); text-align: center; opacity: 0;
  font-size: ${F.cue}; font-weight: ${F.weight}; letter-spacing: ${F.tracking}; color: ${v('ink', C.ink)}; line-height: 1;
  text-shadow: 0 0 22px ${v('hot-glow', C.hotGlow)}, 0 3px 16px rgba(0,0,0,0.7); white-space: nowrap; }
${R} .cue .glyph { display: none; width: ${L.glyph}; height: auto; margin: 0 auto 6px; color: ${v('glyph', C.glyph)}; filter: drop-shadow(0 0 14px currentColor); }
${R} .cue .glyph.on { display: block; }
${R} .cue .glyph svg { width: 100%; height: auto; overflow: visible; }
${R} .cue .glyph .ball { color: ${v('glyph-ball', C.glyphBall)}; stroke: currentColor; }
${R} .cue .glyph .hand { transform-box: fill-box; transform-origin: center; }
${R} .cue .glyph .trail, ${R} .cue .glyph .ring, ${R} .cue .glyph .rings ellipse { opacity: .7; }
${R} .cue .glyph.catch .ball { animation: ${id}Drop var(--glyph-ms) ease-in infinite; }
${R} .cue .glyph.catch .hand-l { animation: ${id}CupL var(--glyph-ms) ease-in-out infinite; }
${R} .cue .glyph.catch .hand-r { animation: ${id}CupR var(--glyph-ms) ease-in-out infinite; }
${R} .cue .glyph.throw .ball { animation: ${id}Lob var(--glyph-ms) ease-out infinite; }
${R} .cue .glyph.throw .hand-t { animation: ${id}Push var(--glyph-ms) ease-out infinite; }
${R} .cue .glyph.call .rings ellipse { animation: ${id}Settle var(--glyph-ms) ease-out infinite; }
${R} .cue .glyph.call .rings ellipse:nth-child(2) { animation-delay: calc(var(--glyph-ms) * .18); }
${R} .cue .glyph.call .rings ellipse:nth-child(3) { animation-delay: calc(var(--glyph-ms) * .36); }
${R} .cue .glyph.listen .waves path { animation: ${id}Wave 1.2s ease-in-out infinite; }
${R} .cue .glyph.listen .waves path:nth-child(2n) { animation-delay: .2s; }
${R} .cue .glyph.listen .waves path:nth-child(n+3) { animation-delay: .4s; }
${R} .cue .big { display: block; }
${R} .cue small { display: block; font-size: ${F.cueSub}; font-weight: 600; letter-spacing: .08em; color: ${v('ink2', C.ink2)}; margin-top: 10px; text-shadow: 0 2px 10px rgba(0,0,0,0.7); }
${R} .cue.show { animation: ${id}Cue var(--cue-ms) cubic-bezier(.2,.9,.3,1) forwards; }
${R} .cue.hot  { color: ${v('hot', C.hot)};  text-shadow: 0 0 22px ${v('hot-glow', C.hotGlow)},   0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.cool { color: ${v('cool', C.cool)}; text-shadow: 0 0 22px ${v('cool-glow', C.coolGlow)}, 0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.good { color: ${v('good', C.good)}; text-shadow: 0 0 22px ${v('good-glow', C.goodGlow)}, 0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.warn { color: ${v('warn', C.warn)}; text-shadow: 0 0 22px ${v('warn-glow', C.warnGlow)}, 0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.bad  { color: ${v('bad', C.bad)};  text-shadow: 0 0 22px ${v('bad-glow', C.badGlow)},   0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.hot .glyph, ${R} .cue.cool .glyph, ${R} .cue.good .glyph, ${R} .cue.warn .glyph, ${R} .cue.bad .glyph { color: currentColor; }
@keyframes ${id}Cue { 0% { opacity: 0; transform: translate(-50%, -50%) scale(1.7); } ${Math.round(T.popIn * 100)}% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  ${Math.round(T.hold * 100)}% { opacity: 1; transform: translate(-50%, -50%) scale(1.02); } 100% { opacity: 0; transform: translate(-50%, -54%) scale(1.06); } }
@keyframes ${id}Pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.45); } }
@keyframes ${id}Drop { 0% { transform: translateY(-16px); opacity: 0; } 20% { opacity: 1; } 70% { transform: translateY(34px); } 82% { transform: translateY(28px); } 100% { transform: translateY(30px); opacity: 1; } }
@keyframes ${id}CupL { 0%, 55% { transform: rotate(0deg) translateX(0); } 78%, 100% { transform: rotate(8deg) translateX(6px); } }
@keyframes ${id}CupR { 0%, 55% { transform: rotate(0deg) translateX(0); } 78%, 100% { transform: rotate(-8deg) translateX(-6px); } }
@keyframes ${id}Lob { 0%, 18% { transform: translate(0, 0); opacity: 1; } 75% { transform: translate(70px, -42px); opacity: 1; } 100% { transform: translate(74px, -24px); opacity: 0; } }
@keyframes ${id}Push { 0% { transform: translate(0, 0) rotate(0); } 25% { transform: translate(8px, -10px) rotate(-14deg); } 100% { transform: translate(0, 0) rotate(0); } }
@keyframes ${id}Settle { 0% { transform: translateY(-34px) scale(1.15); opacity: 0; } 25% { opacity: .8; } 100% { transform: translateY(0) scale(1); opacity: 0; } }
@keyframes ${id}Wave { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  ${R} .cue.show { animation: ${id}CueStill var(--cue-ms) linear forwards; }
  ${R} .cue .glyph * , ${R} .voice .dot { animation: none !important; }
}
@keyframes ${id}CueStill { 0%, ${Math.round(T.hold * 100)}% { opacity: 1; } 100% { opacity: 0; } }
`;
}

export class GameCues {
  /** @param {{ id?: string, root?: HTMLElement }} o  `id` prefixes every element id (default 'gameCues') */
  constructor(o = {}) {
    this.id = o.id || 'gameCues';
    const doc = (o.root && o.root.ownerDocument) || document;
    if (!doc.getElementById(this.id + 'HudCss')) {
      const st = doc.createElement('style'); st.id = this.id + 'HudCss'; st.textContent = css(this.id); doc.head.appendChild(st);
    }
    const root = doc.createElement('div'); root.id = this.id + 'Hud';
    root.innerHTML =
      `<div class="banner" id="${this.id}Banner"><span class="ico"></span><b></b><span class="hint"></span>` +
        `<span class="voice" id="${this.id}Voice"><span class="dot"></span><span class="heard"></span><span class="cmd"></span></span></div>` +
      `<div class="bar"><div class="row"><span id="${this.id}Left">round <b id="${this.id}Round">1</b></span><b id="${this.id}Phase"></b><span class="sc" id="${this.id}Score"></span></div><div class="track"><div class="fill" id="${this.id}Fill"></div></div></div>` +
      `<div class="cue" id="${this.id}Cue"><div class="glyph" id="${this.id}CueGlyph"></div><span class="big" id="${this.id}CueBig">GO!</span><small id="${this.id}CueSub"></small></div>`;
    (o.root || doc.body).appendChild(root);
    this.root = root;
    const $ = (k) => doc.getElementById(this.id + k);
    this.els = { bar: root.querySelector('.bar'), banner: $('Banner'), voice: $('Voice'), cue: $('Cue'), big: $('CueBig'), cueSub: $('CueSub'), glyph: $('CueGlyph'),
                 left: $('Left'), round: $('Round'), phase: $('Phase'), score: $('Score'), fill: $('Fill') };
    this.current = { big: '', kind: '', gesture: '', t: 0 };
    this._hideT = 0; this._bannerT = 0; this.log = [];
  }
  /** re-skin: theme({ hot: '#ff0', panel: 'rgba(0,0,0,.5)' }) → --gc-* variables on the root */
  theme(vars = {}) { for (const [k, v] of Object.entries(vars)) this.root.style.setProperty('--gc-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v); return this; }
  show() { this.root.classList.add('on'); return this; }
  hide() { this.root.classList.remove('on'); this.els.bar.classList.remove('on'); this.els.banner.classList.remove('on'); return this; }
  /**
   * the call-out: pops in, holds, fades. A MOMENTS key works as `big` (kind + gesture come with it).
   * @param {string} big  @param {string} sub  @param {string} kind  hot|cool|good|warn|bad
   * @param {number|{ms?:number, gesture?:string}} o  life in ms, or { ms, gesture: 'catch'|'throw'|'call'|'listen'|'' }
   */
  cue(big, sub = '', kind = 'hot', o = GAME_UI.time.cueMs) {
    const opt = typeof o === 'number' ? { ms: o } : (o || {});
    let gesture = opt.gesture;
    if (MOMENTS[big]) { const m = MOMENTS[big]; kind = kind && kind !== 'hot' ? kind : m.kind; if (gesture === undefined) gesture = m.gesture; big = m.big; }
    const ms = opt.ms || GAME_UI.time.cueMs;
    const el = this.els.cue;
    this.show();
    el.classList.remove('show', ...CUE_KINDS);
    this.els.big.textContent = big; this.els.cueSub.textContent = sub || '';
    const G = this.els.glyph; G.className = 'glyph';
    if (gesture && GESTURES[gesture]) { G.innerHTML = GESTURES[gesture]; G.classList.add('on', gesture); } else G.innerHTML = '';
    el.style.setProperty('--cue-ms', (ms / 1000) + 's');
    void el.offsetWidth;                          // restart the animation even for the same text
    el.classList.add('show'); if (CUE_KINDS.includes(kind)) el.classList.add(kind);
    this.current = { big, kind, gesture: gesture || '', t: (typeof performance !== 'undefined' ? performance.now() : Date.now()) };
    this.log.push([this.current.t | 0, big]); if (this.log.length > 40) this.log.shift();
    return this;
  }
  /** the round bar: { left, round, label, right, phase (0 full … 1 drained; omit = full), cool } */
  bar(o = {}) {
    const E = this.els;
    this.show(); E.bar.classList.add('on');
    if (o.left != null && E.left.childNodes[0]) E.left.childNodes[0].nodeValue = o.left + ' ';
    if (o.round != null && E.round.textContent !== String(o.round)) E.round.textContent = String(o.round);
    if (o.label != null && E.phase.textContent !== o.label) E.phase.textContent = o.label;
    if (o.right != null && E.score.textContent !== o.right) E.score.textContent = o.right;
    const w = o.phase == null ? 100 : Math.round((1 - Math.min(1, Math.max(0, o.phase))) * 100);
    E.fill.style.width = w + '%';
    E.fill.classList.toggle('cool', !!o.cool); E.phase.classList.toggle('cool', !!o.cool);
    return this;
  }
  hideBar(ms = 0) {
    clearTimeout(this._hideT);
    if (ms > 0) this._hideT = setTimeout(() => { this.els.bar.classList.remove('on'); }, ms);
    else this.els.bar.classList.remove('on');
    return this;
  }
  /** the game tag while a game runs: { icon: '🏀', title: 'HOOP ROUND', hint: 'catch · aim · shoot' } */
  banner(o = {}) {
    const B = this.els.banner;
    this.show(); clearTimeout(this._bannerT);
    B.querySelector('.ico').textContent = o.icon || ''; B.querySelector('b').textContent = o.title || ''; B.querySelector('.hint').textContent = o.hint || '';
    B.classList.add('on');
    return this;
  }
  hideBanner(ms = 0) {
    clearTimeout(this._bannerT);
    if (ms > 0) this._bannerT = setTimeout(() => { this.els.banner.classList.remove('on'); }, ms);
    else this.els.banner.classList.remove('on');
    return this;
  }
  /**
   * the VOICE pill in the banner: { state: 'off'|'starting'|'listening'|'paused'|'denied'|'unsupported'|'error', heard: 'give me the ball', cmd: 'ball', level: 0..1 }
   * state 'off' hides it. The banner itself is shown if it is not already.
   */
  voice(o = {}) {
    const V = this.els.voice;
    if (o.state === 'off' || o.state == null && !o.heard) { V.classList.remove('on'); return this; }
    this.show(); this.els.banner.classList.add('on'); V.classList.add('on');
    if (o.state != null) { V.className = 'voice on ' + o.state; }
    if (o.heard != null) V.querySelector('.heard').textContent = o.heard;
    if (o.cmd !== undefined) V.querySelector('.cmd').textContent = o.cmd ? '→ ' + o.cmd : '';
    if (o.level != null) V.querySelector('.dot').style.transform = 'scale(' + (1 + Math.min(1, o.level) * 1.2).toFixed(2) + ')';
    return this;
  }
  /** is a cue still on screen (inside its life)? */
  get cueLive() { return this.els.cue.classList.contains('show') && (performance.now() - this.current.t) < GAME_UI.time.cueMs; }
}
