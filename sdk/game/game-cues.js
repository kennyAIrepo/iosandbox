/**
 * sdk/game/game-cues.js — GAME UI for every lane (the template under test).
 * ═══════════════════════════════════════════════════════════════════════════════
 * One component, three parts, one set of tokens. Browser only (DOM), no three, no
 * tracking, never takes pointer events. Mount it once per page; every game moment
 * in every lane (engine or mirror, ball, cube, bow, beat, twin) goes through it —
 * no ad-hoc toasts for game state. See docs/GAME-UI.md for the contract.
 *
 *   CUE      the call-out: "GO!" · "INCOMING!" · "AIM!" · "GOAL!" — pops in the
 *            middle of the screen, holds, fades in ~1.7 s. One at a time.
 *   BAR      the round bar at the top: left tag (round n), phase label, score;
 *            a timer that DRAINS with the phase. Stays while a round runs.
 *   BANNER   the game tag: icon + name + a hint, top-left, while a game is on.
 *
 * TOKENS (GAME_UI): the palette is by MEANING, not by lane —
 *   hot   orange  the moment (GO! · GOAL!)          cool  cyan   system / motion (INCOMING · ROUND OVER)
 *   good  green   you did it (CAUGHT · HIT)          warn  amber  do it now (AIM! · SHOOT! · DRAW)
 *   bad   red     you missed (MISS · DROPPED)
 * Every colour is a CSS variable (--gc-*) on the root element, so a page or a
 * theme re-skins with GameCues.theme({...}) or plain CSS — never by editing this.
 *
 * Elements are addressable for probes and pages: `${id}Hud` (root), `${id}Cue`,
 * `${id}CueSub`, `${id}Phase`, `${id}Fill`, `${id}Round`, `${id}Score`, `${id}Banner`.
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
  },
  time: { cueMs: 1700, popIn: 0.12, hold: 0.70, barEaseMs: 120, bannerFadeMs: 250 },
  type: { cue: 'clamp(44px, 9vw, 96px)', cueSub: '16px', bar: '12px', banner: '13px', weight: 900, tracking: '.1em' },
  layout: { barWidth: 'min(560px, 92vw)', top: 14, cueTop: '34vh', radius: 14, z: 30, blur: '10px' },
};
export const CUE_KINDS = ['hot', 'cool', 'good', 'warn', 'bad'];
/** the moments every lane shares — use these names so cues read the same everywhere */
export const MOMENTS = {
  start:    { big: 'GO!',        kind: 'hot' },
  incoming: { big: 'INCOMING!',  kind: 'cool' },
  catch:    { big: 'CATCH!',     kind: 'cool' },
  caught:   { big: 'CAUGHT ✓',   kind: 'good' },
  aim:      { big: 'AIM!',       kind: 'warn' },
  shoot:    { big: 'SHOOT!',     kind: 'warn' },
  shot:     { big: 'SHOT!',      kind: 'warn' },
  goal:     { big: 'GOAL!',      kind: 'hot' },
  hit:      { big: 'HIT!',       kind: 'good' },
  miss:     { big: 'MISS',       kind: 'bad' },
  dropped:  { big: 'DROPPED',    kind: 'bad' },
  thrown:   { big: 'THROWN',     kind: 'warn' },
  over:     { big: 'ROUND OVER', kind: 'cool' },
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
  --gc-radius: ${L.radius}px; --gc-z: ${L.z}; --gc-blur: ${L.blur}; --cue-ms: ${T.cueMs / 1000}s; }
${R}.on { display: block; }
${R} .bar { position: fixed; left: 50%; top: calc(env(safe-area-inset-top, 0px) + ${L.top}px); transform: translateX(-50%); z-index: ${v('z', L.z)}; display: none;
  width: ${L.barWidth}; padding: 8px 14px 10px; border-radius: ${v('radius', L.radius + 'px')}; background: ${v('panel', C.panel)}; backdrop-filter: blur(${v('blur', L.blur)});
  border: 1px solid ${v('edge', C.edge)}; font-family: inherit; color: ${v('ink2', C.ink2)}; }
${R} .bar.on { display: block; }
${R} .bar .row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: ${F.bar}; letter-spacing: ${F.tracking}; text-transform: uppercase; }
${R} .bar .row b { color: ${v('hot', C.hot)}; font-weight: 800; letter-spacing: .14em; }
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
${R} .cue { position: fixed; left: 50%; top: ${L.cueTop}; transform: translate(-50%, -50%) scale(1); z-index: calc(${v('z', L.z)} + 1); text-align: center; opacity: 0;
  font-size: ${F.cue}; font-weight: ${F.weight}; letter-spacing: ${F.tracking}; color: ${v('ink', C.ink)}; line-height: 1;
  text-shadow: 0 0 22px ${v('hot-glow', C.hotGlow)}, 0 3px 16px rgba(0,0,0,0.7); white-space: nowrap; }
${R} .cue small { display: block; font-size: ${F.cueSub}; font-weight: 600; letter-spacing: .08em; color: ${v('ink2', C.ink2)}; margin-top: 10px; text-shadow: 0 2px 10px rgba(0,0,0,0.7); }
${R} .cue.show { animation: ${id}Cue var(--cue-ms) cubic-bezier(.2,.9,.3,1) forwards; }
${R} .cue.hot  { color: ${v('hot', C.hot)};  text-shadow: 0 0 22px ${v('hot-glow', C.hotGlow)},   0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.cool { color: ${v('cool', C.cool)}; text-shadow: 0 0 22px ${v('cool-glow', C.coolGlow)}, 0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.good { color: ${v('good', C.good)}; text-shadow: 0 0 22px ${v('good-glow', C.goodGlow)}, 0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.warn { color: ${v('warn', C.warn)}; text-shadow: 0 0 22px ${v('warn-glow', C.warnGlow)}, 0 3px 16px rgba(0,0,0,0.7); }
${R} .cue.bad  { color: ${v('bad', C.bad)};  text-shadow: 0 0 22px ${v('bad-glow', C.badGlow)},   0 3px 16px rgba(0,0,0,0.7); }
@keyframes ${id}Cue { 0% { opacity: 0; transform: translate(-50%, -50%) scale(1.7); } ${Math.round(T.popIn * 100)}% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  ${Math.round(T.hold * 100)}% { opacity: 1; transform: translate(-50%, -50%) scale(1.02); } 100% { opacity: 0; transform: translate(-50%, -54%) scale(1.06); } }
@media (prefers-reduced-motion: reduce) { ${R} .cue.show { animation: ${id}CueStill var(--cue-ms) linear forwards; } }
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
      `<div class="banner" id="${this.id}Banner"><span class="ico"></span><b></b><span class="hint"></span></div>` +
      `<div class="bar"><div class="row"><span id="${this.id}Left">round <b id="${this.id}Round">1</b></span><b id="${this.id}Phase"></b><span class="sc" id="${this.id}Score"></span></div><div class="track"><div class="fill" id="${this.id}Fill"></div></div></div>` +
      `<div class="cue" id="${this.id}Cue">GO!<small id="${this.id}CueSub"></small></div>`;
    (o.root || doc.body).appendChild(root);
    this.root = root;
    const $ = (k) => doc.getElementById(this.id + k);
    this.els = { bar: root.querySelector('.bar'), banner: $('Banner'), cue: $('Cue'), cueSub: $('CueSub'), left: $('Left'), round: $('Round'), phase: $('Phase'), score: $('Score'), fill: $('Fill') };
    this.current = { big: '', kind: '', t: 0 };
    this._hideT = 0; this._bannerT = 0; this.log = [];
  }
  /** re-skin: theme({ hot: '#ff0', panel: 'rgba(0,0,0,.5)' }) → --gc-* variables on the root */
  theme(vars = {}) { for (const [k, v] of Object.entries(vars)) this.root.style.setProperty('--gc-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v); return this; }
  show() { this.root.classList.add('on'); return this; }
  hide() { this.root.classList.remove('on'); this.els.bar.classList.remove('on'); this.els.banner.classList.remove('on'); return this; }
  /** the call-out: pops in, holds, fades. `ms` = total life (default GAME_UI.time.cueMs). A MOMENTS key works as `big`. */
  cue(big, sub = '', kind = 'hot', ms = GAME_UI.time.cueMs) {
    if (MOMENTS[big]) { kind = MOMENTS[big].kind; big = MOMENTS[big].big; }
    const el = this.els.cue;
    this.show();
    el.classList.remove('show', ...CUE_KINDS);
    el.childNodes[0].nodeValue = big; this.els.cueSub.textContent = sub || '';
    el.style.setProperty('--cue-ms', (ms / 1000) + 's');
    void el.offsetWidth;                          // restart the animation even for the same text
    el.classList.add('show'); if (CUE_KINDS.includes(kind)) el.classList.add(kind);
    this.current = { big, kind, t: (typeof performance !== 'undefined' ? performance.now() : Date.now()) };
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
    E.fill.classList.toggle('cool', !!o.cool);
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
  /** is a cue still on screen (inside its life)? */
  get cueLive() { return this.els.cue.classList.contains('show') && (performance.now() - this.current.t) < GAME_UI.time.cueMs; }
}
