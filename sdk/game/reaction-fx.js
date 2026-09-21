/**
 * reaction-fx.js — Teams-style reaction visuals for one tile: floating emoji, the "Hand raised" pill, aria-live text.
 * Browser module, no three.js; safe to import in Node (nothing touches `document` until a ReactionFx is built).
 * ─────────────────────────────────────────────────────────────────────────────
 * Floating emoji: one overlay div per tile (`.rx-overlay`, appended inside `.tile__chrome` so it sits over video and
 * hands but under the pills/label chrome, `pointer-events:none`). Each reaction is a `<span class="rx-emoji">` that
 * rises from its ORIGIN — the gesture's own landmark in tile-normalised coordinates (`ev.origin = { x, y }`, 0..1,
 * y down: the heart appears between the two index tips, the thumbs-up on the thumb, the wave / raise on the wrist;
 * gesture-reactions.js) — or from the tile's bottom-left when the origin is null (menu reactions, legacy packets,
 * synthetic packs). It drifts sideways and fades over 2.2 s (CSS transform + opacity keyframes on the compositor — no
 * per-frame JS). At most 6 alive per tile: the oldest is removed when a 7th arrives. With prefers-reduced-motion (the
 * media query, the frame's data-reduced-motion="true", or TwinUI.reducedMotion) the emoji fades in place instead of
 * moving — at the origin when there is one (unchanged behaviour otherwise).
 *
 * Gesture reactions never require the HoloHands overlay: the origin comes from landmarks, not from the rigs, so a
 * participant with HoloHands Off / Auto-idle still sees the heart rise from between their hands.
 *
 * "Hand raised" pill: the tile template already has `.tile__raised` shown by `.tile.is-raised` (teamslab.css:109-110,
 * the gold ACS raiseHand pill + ring); nothing is restyled here. When a TwinUI is given the pill goes through
 * `ui.setTileState(clientId, { raised })` so TwinUI's state stays authoritative; otherwise the class is toggled directly.
 *
 * aria-live: one short sentence per event (`announcement(ev, name)`), through `ui.announce` (throttled 2 s, twin-ui.js:457)
 * when available, else written to `#live-polite` (teamslab.html:248) with the same repeat-nudge trick.
 */
export const EMOJI = Object.freeze({
  like: '\u{1F44D}', love: '❤️', applause: '\u{1F44F}', laugh: '\u{1F602}', surprised: '\u{1F62E}',
  wave: '\u{1F44B}', raise: '✋',
});

/** The aria-live sentence for a detector / wire event ({kind, on}). */
export function announcement(ev, name = 'Someone') {
  switch (ev && ev.kind) {
    case 'raise': return ev.on ? `${name} raised a hand` : `${name} lowered their hand`;
    case 'applause': return `${name} is clapping`;
    case 'like': return `${name} gave a thumbs up`;
    case 'love': return `${name} sent a heart`;
    case 'wave': return `${name} waved`;
    case 'laugh': return `${name} laughed`;
    case 'surprised': return `${name} is surprised`;
    default: return `${name} reacted`;
  }
}

export const FX_DEFAULTS = Object.freeze({ durationMs: 2200, maxAlive: 6, rise: 0.62, driftPx: 44, riseFromOrigin: 0.28, edgePx: 12 });

/**
 * Where an emoji starts inside a tile: origin { x, y } (0..1, y down) -> CSS { left, bottom } in px, centred on the point
 * and kept `edgePx` inside the overlay; null origin -> the classic bottom-left corner. Pure (Node-safe, tested).
 * @returns {{ left:number, bottom:number, fromOrigin:boolean }}
 */
export function originToCss(origin, w, h, { edgePx = FX_DEFAULTS.edgePx, size = 32 } = {}) {
  const W = w > 0 ? w : 320, H = h > 0 ? h : 180, half = size / 2;
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return { left: edgePx, bottom: edgePx, fromOrigin: false };
  const x = Math.min(1, Math.max(0, origin.x)), y = Math.min(1, Math.max(0, origin.y));
  const left = Math.round(Math.min(W - edgePx - size, Math.max(edgePx, x * W - half)));
  const bottom = Math.round(Math.min(H - edgePx - size, Math.max(edgePx, (1 - y) * H - half)));
  return { left, bottom, fromOrigin: true };
}

const STYLE_ID = 'rx-fx-style';
const CSS = `
.rx-overlay { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.rx-emoji { position: absolute; left: 12px; bottom: 12px; font-size: var(--tw-reaction-size, 32px); line-height: 1; opacity: 0;
  will-change: transform, opacity; transform: translate3d(0, 0, 0) scale(.6);
  animation: rx-float var(--rx-dur, 2200ms) cubic-bezier(.2, .7, .3, 1) forwards; }
@keyframes rx-float {
  0%   { transform: translate3d(0, 0, 0) scale(.6); opacity: 0; }
  12%  { transform: translate3d(calc(var(--rx-dx, 0px) * .25), calc(var(--rx-rise, -160px) * .12), 0) scale(1.15); opacity: 1; }
  55%  { transform: translate3d(calc(var(--rx-dx, 0px) * .8), calc(var(--rx-rise, -160px) * .55), 0) scale(1); opacity: 1; }
  100% { transform: translate3d(var(--rx-dx, 0px), var(--rx-rise, -160px), 0) scale(.92); opacity: 0; }
}
.rx-overlay.rx-static .rx-emoji { transform: none; animation: rx-fade var(--rx-dur, 2200ms) linear forwards; }
@keyframes rx-fade { 0% { opacity: 0; } 15% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
`;

export class ReactionFx {
  /**
   * @param {object} o
   *   doc            Document (default globalThis.document)
   *   ui             TwinUI (optional): pill via setTileState, announcements via announce, reducedMotion getter
   *   live           an aria-live element to write to when no ui is given (default: #live-polite)
   *   reducedMotion  boolean override (null = detect)
   *   durationMs / maxAlive / rise / driftPx   see FX_DEFAULTS
   */
  constructor(o = {}) {
    this.doc = o.doc || globalThis.document;
    if (!this.doc) throw new Error('ReactionFx needs a document');
    this.ui = o.ui || null;
    this.cfg = Object.assign({}, FX_DEFAULTS, o);
    this.live = o.live || null;
    this.reducedMotion = o.reducedMotion ?? null;
    this._mq = (typeof matchMedia === 'function') ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._lastLive = '';
    this._seq = 0;
    this._overlays = new Set();
    this._ensureStyle();
  }
  _ensureStyle() {
    if (this.doc.getElementById(STYLE_ID)) return;
    const s = this.doc.createElement('style'); s.id = STYLE_ID; s.textContent = CSS;
    (this.doc.head || this.doc.documentElement).appendChild(s);
  }

  /** Per-tile overlay (created once; idempotent). */
  attach(tileEl) {
    let ov = tileEl.querySelector(':scope > .tile__chrome > .rx-overlay, :scope > .rx-overlay');
    if (ov) return ov;
    ov = this.doc.createElement('div'); ov.className = 'rx-overlay'; ov.setAttribute('aria-hidden', 'true');
    ov._alive = [];
    const chrome = tileEl.querySelector(':scope > .tile__chrome');
    if (chrome) chrome.insertBefore(ov, chrome.firstChild); else tileEl.appendChild(ov);
    this._overlays.add(ov);
    return ov;
  }

  isReduced(tileEl) {
    if (this.reducedMotion !== null) return this.reducedMotion;
    const frame = tileEl && tileEl.closest ? tileEl.closest('.tw-frame') : null;
    if (frame && frame.dataset.reducedMotion === 'true') return true;
    if (frame && frame.dataset.reducedMotion === 'false') return false;
    if (this.ui && typeof this.ui.reducedMotion === 'boolean') return this.ui.reducedMotion;
    return !!(this._mq && this._mq.matches);
  }

  /**
   * Float one emoji on a tile. `emoji` is a glyph or an EMOJI kind ('love'); `origin` = { x, y } tile-normalised (0..1,
   * y down) where it starts (the gesture's landmark), or null -> bottom-left as before. From an origin the rise is
   * shorter (riseFromOrigin of the tile height) so the emoji stays near the hands; under reduced motion it fades in
   * place at the origin. Returns the span.
   */
  float(tileEl, emoji, { origin = null } = {}) {
    if (EMOJI[emoji]) emoji = EMOJI[emoji];
    const ov = this.attach(tileEl);
    const reduced = this.isReduced(tileEl);
    ov.classList.toggle('rx-static', reduced);
    while (ov._alive.length >= this.cfg.maxAlive) { const old = ov._alive.shift(); clearTimeout(old._t); old.remove(); }
    const el = this.doc.createElement('span');
    el.className = 'rx-emoji'; el.textContent = emoji; el.setAttribute('aria-hidden', 'true');
    const h = ov.clientHeight || 240, w = ov.clientWidth || 320;
    const n = this._seq++;
    const at = originToCss(origin, w, h, { edgePx: this.cfg.edgePx });
    el.style.setProperty('--rx-dur', this.cfg.durationMs + 'ms');
    el.style.setProperty('--rx-rise', (-Math.round(h * (at.fromOrigin ? this.cfg.riseFromOrigin : this.cfg.rise))) + 'px');
    el.style.setProperty('--rx-dx', Math.round(((n * 7) % 5 - 1) / 3 * this.cfg.driftPx) + 'px');   // deterministic -14..+44 px drift
    if (at.fromOrigin) { el.style.left = at.left + 'px'; el.style.bottom = at.bottom + 'px'; el.dataset.origin = `${origin.x.toFixed(3)},${origin.y.toFixed(3)}`; }
    else if (reduced) el.style.left = (12 + (n % 3) * 40) + 'px';                                   // fade in place, side by side
    const done = () => { clearTimeout(el._t); const i = ov._alive.indexOf(el); if (i >= 0) ov._alive.splice(i, 1); el.remove(); };
    el.addEventListener('animationend', done, { once: true });
    el._t = setTimeout(done, this.cfg.durationMs + 250);                                             // fallback (animation disabled)
    ov.appendChild(el); ov._alive.push(el);
    return el;
  }

  /** The "Hand raised" pill (+ gold ring) on a tile, through TwinUI when it owns the tile. */
  setRaised(tileEl, on) {
    const id = tileEl && tileEl.dataset ? tileEl.dataset.client : '';
    if (this.ui && id && this.ui.tiles && this.ui.tiles.has(id)) { this.ui.setTileState(id, { raised: !!on }); return; }
    if (tileEl) tileEl.classList.toggle('is-raised', !!on);
  }

  announce(text, level = 'polite') {
    if (!text) return;
    if (this.ui && typeof this.ui.announce === 'function') { this.ui.announce(text, level); return; }
    const el = this.live || this.doc.getElementById(level === 'assertive' ? 'live-assertive' : 'live-polite');
    if (!el) return;
    el.textContent = text === this._lastLive ? text + '​' : text; this._lastLive = el.textContent;
  }

  /**
   * One detector / wire event on a tile: emoji + pill + live text.
   * @param {Element} tileEl   the `.tile` article
   * @param {{kind:string,on?:boolean,origin?:{x:number,y:number}|null}} ev   origin = tile-normalised start point (or null)
   * @param {string} name      the participant's display name for the announcement
   * @returns {string} the announcement made
   */
  react(tileEl, ev, name = 'Someone') {
    const kind = ev && ev.kind, origin = ev && ev.origin ? ev.origin : null;
    if (kind === 'raise') { this.setRaised(tileEl, !!ev.on); if (ev.on) this.float(tileEl, EMOJI.raise, { origin }); }
    else if (EMOJI[kind]) this.float(tileEl, EMOJI[kind], { origin });
    const text = announcement(ev, name);
    this.announce(text);
    return text;
  }

  /** Alive emoji on a tile (0 when none / not attached). */
  alive(tileEl) { const ov = tileEl.querySelector('.rx-overlay'); return ov && ov._alive ? ov._alive.length : 0; }

  dispose() {
    for (const ov of this._overlays) { for (const el of ov._alive) clearTimeout(el._t); ov.remove(); }
    this._overlays.clear();
  }
}
