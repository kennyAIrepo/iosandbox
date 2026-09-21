/**
 * coach.js — first-run coach marks + contextual coaching toasts for the Teams-twin shell (B7).
 *
 * Two layers:
 *   - `CoachSequence` (Node-safe, no DOM): the 3-step first-run sequence as a state machine with an injectable
 *     storage ({ getItem, setItem, removeItem } — localStorage in the browser, a Map-backed object in tests).
 *     The 'seen' flag is persisted under `hopeos.coach` as { version, seen:true, at, reason, atStep }.
 *   - `Coach` (browser): renders one dismissible card at a time, anchored to a real element (local tile shelf,
 *     the neighbour's tile, the push-to-talk button), keyboard dismissible (Esc = skip, Enter = next), text in
 *     an aria-live="polite" node, and turns game events into short toasts through `ui.toast()` with a cooldown.
 *
 * Wiring (the integrator, teamslab.html): `ui.startCoach({ neighbour })` after the first tile rects exist;
 * `ui.coach.attach(game, { nameOfSeat })` to get catch / miss / goal toasts from BallGame's 'ring' + 'goal' events;
 * or `ui.coachEvent('catch' | 'miss' | 'goal', { name })` from anywhere. `?coach=0` disables the sequence,
 * `?coach=1` forces it (clears the seen flag). Everything is exposed through TwinUI methods and CustomEvents.
 */

export const COACH_VERSION = '2026-09-20';
export const COACH_KEY = 'hopeos.coach';

/** anchor: 'local' = the local tile (arrow at the ball shelf), 'neighbour' = the neighbour's tile, 'ptt' = #btnPtt. */
export const COACH_STEPS = [
  { id: 'cup', anchor: 'local', text: () => 'Cup your palm under the ball to catch it', hint: 'Hold the cup still for a moment; the ball settles into it.' },
  { id: 'throw', anchor: 'neighbour', text: (ctx) => `Throw toward ${ctx?.neighbour || 'your neighbour'}`, hint: 'Open your hand as you swing; the ball leaves at the edge of your tile.' },
  { id: 'voice', anchor: 'ptt', text: () => 'Hold V and say: give me a tennis ball', hint: 'Or type it in the command box. Objects arrive ready to catch.' },
];

/** Contextual toasts (event -> text). `name` is the goal tile's display name. */
export const COACH_TOASTS = {
  catch: () => 'Nice catch',
  miss: () => 'Cup lower, palm up',
  goal: ({ name } = {}) => `GOAL for ${name || 'the goal tile'}`,
};

export const TOAST_COOLDOWN_MS = { catch: 2500, miss: 2500, goal: 1500 };
const TOAST_MIN_GAP_MS = 800;        // never two coaching toasts inside 0.8 s (they stack in #toasts)
const TOAST_REPEAT_MS = 4000;        // the same text is not repeated inside 4 s

// ---------------------------------------------------------------------------------------------------------
// Storage: localStorage when reachable (private mode throws), else an in-memory map
// ---------------------------------------------------------------------------------------------------------
export function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
function defaultStorage() {
  try { const ls = globalThis.localStorage; if (ls && typeof ls.getItem === 'function') { ls.getItem(COACH_KEY); return ls; } } catch { /* private mode / sandbox */ }
  return memoryStorage();
}

// ---------------------------------------------------------------------------------------------------------
export class CoachSequence extends EventTarget {
  /**
   * @param {{ steps?: typeof COACH_STEPS, storage?: {getItem,setItem,removeItem}, key?: string, version?: string, now?: () => number }} o
   */
  constructor({ steps = COACH_STEPS, storage = null, key = COACH_KEY, version = COACH_VERSION, now = () => Date.now() } = {}) {
    super();
    this.steps = steps; this.storage = storage ?? defaultStorage(); this.key = key; this.version = version; this.nowFn = now;
    this.index = -1; this.ctx = {}; this.active = false;
  }

  /** Persisted record or null. */
  record() { try { const r = JSON.parse(this.storage.getItem(this.key) || 'null'); return r && typeof r === 'object' ? r : null; } catch { return null; } }
  /** true when this version of the sequence was completed or skipped before. */
  get seen() { const r = this.record(); return !!r && r.version === this.version && r.seen === true; }
  get step() { return this.active ? this.steps[this.index] ?? null : null; }
  get length() { return this.steps.length; }
  text(step = this.step) { if (!step) return ''; return typeof step.text === 'function' ? step.text(this.ctx) : String(step.text ?? ''); }
  hint(step = this.step) { return step?.hint ?? ''; }

  /** Starts at step 0 unless seen (or `force`). Returns true when a card should be shown. */
  start({ force = false, ctx = {} } = {}) {
    this.ctx = { ...ctx };
    if (this.active) return true;
    if (this.seen && !force) { this._emit('skipped', { reason: 'seen' }); return false; }
    if (force) { try { this.storage.removeItem(this.key); } catch { /* ignore */ } }
    this.active = true; this.index = 0;
    this._emit('start', { step: this.step, index: 0 });
    this._emit('step', { step: this.step, index: 0, text: this.text() });
    return true;
  }
  /** Advances; finishing the last step marks seen with reason 'done'. */
  next() {
    if (!this.active) return false;
    if (this.index >= this.steps.length - 1) { this._finish('done'); return false; }
    this.index++; this._emit('step', { step: this.step, index: this.index, text: this.text() }); return true;
  }
  back() { if (!this.active || this.index <= 0) return false; this.index--; this._emit('step', { step: this.step, index: this.index, text: this.text() }); return true; }
  /** Dismiss early (Esc / Skip / x): marks seen with reason 'skip' so it never nags again. */
  skip(reason = 'skip') { if (!this.active) return false; this._finish(reason); return true; }
  /** Forget the seen flag (for `?coach=1` and the About > "Show tips again" affordance). */
  reset() { try { this.storage.removeItem(this.key); } catch { /* ignore */ } this.active = false; this.index = -1; this._emit('reset', {}); }

  _finish(reason) {
    const atStep = this.index, step = this.step;
    this.active = false; this.index = -1;
    const rec = { version: this.version, seen: true, at: new Date(this.nowFn()).toISOString(), reason, atStep };
    try { this.storage.setItem(this.key, JSON.stringify(rec)); } catch { /* ignore */ }
    this._emit('done', { reason, atStep, step });
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// ---------------------------------------------------------------------------------------------------------
// Toast gate (Node-safe): decides whether a coaching toast for `type` may fire now.  Exported for tests.
// ---------------------------------------------------------------------------------------------------------
export class ToastGate {
  constructor({ cooldown = TOAST_COOLDOWN_MS, minGap = TOAST_MIN_GAP_MS, repeat = TOAST_REPEAT_MS, now = () => (globalThis.performance?.now?.() ?? Date.now()) } = {}) {
    this.cooldown = cooldown; this.minGap = minGap; this.repeat = repeat; this.nowFn = now;
    this.lastByType = new Map(); this.lastAt = -Infinity; this.lastText = ''; this.lastTextAt = -Infinity;
  }
  /** @returns {string|null} the text to show, or null when gated */
  take(type, detail = {}) {
    const f = COACH_TOASTS[type]; if (!f) return null;
    const t = this.nowFn(), text = f(detail);
    if (t - this.lastAt < this.minGap) return null;
    if (t - (this.lastByType.get(type) ?? -Infinity) < (this.cooldown[type] ?? 2000)) return null;
    if (text === this.lastText && t - this.lastTextAt < this.repeat) return null;
    this.lastAt = t; this.lastByType.set(type, t); this.lastText = text; this.lastTextAt = t;
    return text;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Coach (browser): card + anchors + toasts.  Owned by TwinUI (`ui.coach`), never constructed by the page.
// ---------------------------------------------------------------------------------------------------------
const $ = (root, sel) => root?.querySelector?.(sel) ?? null;

export class Coach extends EventTarget {
  /** @param {import('./twin-ui.js').TwinUI} ui */
  constructor(ui, { storage = null, sequence = null } = {}) {
    super();
    this.ui = ui;
    this.seq = sequence ?? new CoachSequence({ storage });
    this.gate = new ToastGate();
    this.card = null; this._prevFocus = null; this._ctx = {}; this._anchors = {};
    this._onKey = (e) => this._keys(e);
    this._onLayout = () => this._place();
    this.seq.addEventListener('step', (e) => { this._render(e.detail); this._emit('step', { index: e.detail.index, id: e.detail.step?.id, text: e.detail.text }); });
    this.seq.addEventListener('done', (e) => { this._teardown(); this._emit('done', { reason: e.detail.reason, atStep: e.detail.atStep }); });
  }

  get active() { return this.seq.active; }
  get seen() { return this.seq.seen; }

  /**
   * @param {{ neighbour?: string, force?: boolean, anchors?: { local?: Element|string, neighbour?: Element|string, ptt?: Element|string } }} o
   *   neighbour: display name used in step 2; anchors override the element lookup (element or CSS selector).
   */
  start({ neighbour = null, force = false, anchors = {} } = {}) {
    const q = this.ui.url?.get?.('coach');
    if (q === '0' && !force) { this._emit('skipped', { reason: 'url' }); return false; }
    if (q === '1') force = true;
    this._ctx = { neighbour: neighbour ?? this._guessNeighbour() }; this._anchors = anchors;
    this._prevFocus = document.activeElement;
    const started = this.seq.start({ force, ctx: this._ctx });
    if (started) this._emit('start', { index: 0 });
    return started;
  }
  next() { return this.seq.next(); }
  back() { return this.seq.back(); }
  skip(reason = 'skip') { return this.seq.skip(reason); }
  stop() { if (this.seq.active) this.seq.skip('stop'); else this._teardown(); }
  reset() { this.seq.reset(); this._teardown(); }

  /** Contextual toast for a game event: 'catch' | 'miss' | 'goal' (detail.name = goal tile's name). Returns the text or null. */
  event(type, detail = {}) {
    const text = this.gate.take(type, detail);
    if (!text) return null;
    const level = type === 'miss' ? 'warn' : 'info';
    this.ui.toast?.(text, { ms: type === 'goal' ? 2600 : 1800, level });
    this._emit('toast', { type, text });
    return text;
  }

  /**
   * Subscribe to a BallGame-like EventTarget: 'ring' {seat, kind:'catch'|'save'|'miss'|...} and 'goal' {seat|goalSeat}.
   * Only the LOCAL seat's catch/miss coach the local player (`mySeat()`); goals are announced for everyone.
   * Returns a detach function.
   */
  attach(target, { nameOfSeat = null, mySeat = null } = {}) {
    if (!target?.addEventListener) return () => {};
    const name = (seat) => { try { return nameOfSeat?.(seat) ?? null; } catch { return null; } };
    const mine = (seat) => { if (typeof mySeat !== 'function') return true; try { const s = mySeat(); return s == null || s < 0 || s === seat; } catch { return true; } };
    const onRing = (e) => { const d = e.detail ?? {}; if (!mine(d.seat)) return; if (d.kind === 'catch' || d.kind === 'save') this.event('catch'); else if (d.kind === 'miss') this.event('miss'); };
    const onGoal = (e) => { const d = e.detail ?? {}; const seat = d.goalSeat ?? d.goal ?? d.seat; this.event('goal', { name: name(seat) ?? (seat != null ? `seat ${seat}` : null) }); };
    target.addEventListener('ring', onRing); target.addEventListener('goal', onGoal);
    return () => { target.removeEventListener('ring', onRing); target.removeEventListener('goal', onGoal); };
  }

  // ---- card ----------------------------------------------------------------------------------------------
  _render({ step, index, text }) {
    const ui = this.ui, frame = ui.el?.frame; if (!frame || !step) return;
    if (!this.card) {
      const c = document.createElement('div'); c.className = 'coach'; c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'false'); c.setAttribute('aria-labelledby', 'coach-text'); c.dataset.step = step.id;
      c.innerHTML = '';
      const arrow = document.createElement('i'); arrow.className = 'coach__arrow'; arrow.setAttribute('aria-hidden', 'true');
      const head = document.createElement('div'); head.className = 'coach__head';
      const count = document.createElement('span'); count.className = 'coach__count tw-caption1 tw-numeric';
      const x = document.createElement('button'); x.type = 'button'; x.className = 'coach__x tw-focusable'; x.setAttribute('aria-label', 'Dismiss tips'); x.textContent = '×';
      x.addEventListener('click', () => this.skip('close'));
      head.append(count, x);
      const txt = document.createElement('p'); txt.id = 'coach-text'; txt.className = 'coach__text'; txt.setAttribute('aria-live', 'polite'); txt.setAttribute('aria-atomic', 'true');
      const hint = document.createElement('p'); hint.className = 'coach__hint tw-caption1';
      const btns = document.createElement('div'); btns.className = 'coach__btns';
      const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'tw-btn tw-btn--link coach__skip tw-focusable'; skip.textContent = 'Skip tips';
      skip.addEventListener('click', () => this.skip('skip'));
      const back = document.createElement('button'); back.type = 'button'; back.className = 'tw-btn tw-btn--outline coach__back tw-focusable'; back.textContent = 'Back';
      back.addEventListener('click', () => this.back());
      const next = document.createElement('button'); next.type = 'button'; next.className = 'tw-btn tw-btn--primary coach__next tw-focusable';
      next.addEventListener('click', () => this.next());
      btns.append(skip, back, next);
      c.append(arrow, head, txt, hint, btns);
      frame.appendChild(c);
      this.card = c; this._els = { count, txt, hint, next, back };
      document.addEventListener('keydown', this._onKey, true);
      ui.addEventListener?.('layout', this._onLayout); window.addEventListener('resize', this._onLayout);
      ui.el.frame.classList.add('has-coach');
    }
    const n = this.seq.length, last = index >= n - 1;
    this.card.dataset.step = step.id; this.card.dataset.index = String(index);
    this._els.count.textContent = `Tip ${index + 1} of ${n}`;
    this._els.txt.textContent = text;
    this._els.hint.textContent = this.seq.hint(step); this._els.hint.hidden = !this._els.hint.textContent;
    this._els.next.textContent = last ? 'Done' : 'Next';
    this._els.back.hidden = index === 0;
    this._place();
    this._els.next.focus({ preventScroll: true });
  }

  _teardown() {
    if (!this.card) return;
    this.card.remove(); this.card = null; this._els = null;
    document.removeEventListener('keydown', this._onKey, true);
    this.ui.removeEventListener?.('layout', this._onLayout); window.removeEventListener('resize', this._onLayout);
    this.ui.el?.frame?.classList.remove('has-coach');
    const f = this._prevFocus; this._prevFocus = null;
    if (f && f.isConnected && typeof f.focus === 'function' && f !== document.body) { try { f.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  _keys(e) {
    if (!this.card) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.skip('esc'); return; }
    if (e.key === 'Enter' && this.card.contains(document.activeElement) && document.activeElement === this._els?.next) { e.preventDefault(); this.next(); }
  }

  /** Resolve the step's anchor to an element; overrides win; falls back to the control bar (always visible). */
  _anchorEl(step) {
    const ui = this.ui, ov = this._anchors?.[step.anchor];
    const el = (v) => (typeof v === 'string' ? $(document, v) : v) ?? null;
    let a = el(ov);
    if (!a) {
      if (step.anchor === 'local') a = ui.me ? ui.tiles.get(ui.me)?.el : null;
      else if (step.anchor === 'neighbour') { const t = this._neighbourTile(); a = t?.el ?? null; }
      else if (step.anchor === 'ptt') a = $(ui.el?.panel, '#btnPtt');
    }
    if (a && !(a.getClientRects?.().length)) a = null;                                   // hidden (panel drawer closed at narrow)
    if (!a && step.anchor === 'ptt') a = $(ui.el?.controlbar, '#btnMore') ?? ui.el?.controlbar ?? null;
    if (!a) a = ui.el?.controlbar ?? ui.el?.frame ?? null;
    return a;
  }
  _neighbourTile() {
    const ui = this.ui, ordered = [...ui.tiles.values()].sort((a, b) => a.seat - b.seat);
    if (!ordered.length) return null;
    const meIdx = ordered.findIndex(t => t.clientId === ui.me);
    const byName = this._ctx.neighbour ? ordered.find(t => t.name === this._ctx.neighbour && t.clientId !== ui.me) : null;
    return byName ?? ordered[(meIdx + 1) % ordered.length] ?? ordered[0];
  }
  _guessNeighbour() { const t = this._neighbourTile(); return t && t.clientId !== this.ui.me ? t.name : null; }

  /** Card placement: tiles -> inside the tile with the arrow pointing down at the shelf; buttons -> above (or below) the anchor. */
  _place() {
    const c = this.card, step = this.seq.step; if (!c || !step) return;
    const ui = this.ui, frame = ui.el.frame, F = frame.getBoundingClientRect(), a = this._anchorEl(step);
    if (!a) return;
    const A = a.getBoundingClientRect(), rel = { x: A.left - F.left, y: A.top - F.top, w: A.width, h: A.height };
    c.style.maxWidth = Math.min(320, F.width - 16) + 'px';
    const cw = c.offsetWidth, ch = c.offsetHeight, M = 8;
    const isTile = a.classList?.contains('tile');
    const minTop = (ui.el.topbar?.getBoundingClientRect().height ?? 48) + M;   // never under the top bar
    let left, top, dir;
    if (isTile) {
      // arrow points down at the ball shelf line (bottom: --tw-shelf) or at the tile centre for the neighbour; the card may
      // overflow a short tile upward (it is a coach mark, not tile chrome) and only flips below the target when the stage is too short
      const shelf = step.anchor === 'local' ? parseFloat(getComputedStyle(frame).getPropertyValue('--tw-shelf')) || 45 : 50;
      const targetY = rel.y + rel.h * (1 - shelf / 100);
      // left-aligned inside a wide tile so the top-right chips (hand state, INCOMING) stay readable; the arrow still points at the tile centre
      left = rel.w >= cw + 96 ? rel.x + M : rel.x + rel.w / 2 - cw / 2;
      top = targetY - ch - 14; dir = 'down';
      if (top < minTop) { top = targetY + 14; dir = 'up'; }
    } else {
      left = rel.x + rel.w / 2 - cw / 2; top = rel.y - ch - 12; dir = 'down';
      if (top < minTop) { top = rel.y + rel.h + 12; dir = 'up'; }
    }
    if (isTile) {
      // reviewer (f): a coach mark must not cover a NEIGHBOURING tile or the local tile's top-right chips (hand state / INCOMING): when the
      // card fits, clamp it inside the anchor tile — below the .tile__tr chip column, above the 40 px label bar; a tile too small for the
      // card keeps the overflow behaviour above (the mark is chrome, not tile content)
      const reserve = parseFloat(getComputedStyle(frame).getPropertyValue('--tw-tile-reserve')) || 40;
      const safe = { x0: rel.x + M, y0: rel.y + M, x1: rel.x + rel.w - M, y1: rel.y + rel.h - reserve - M };
      const tr = a.querySelector ? a.querySelector('.tile__tr') : null;
      const T = tr ? tr.getBoundingClientRect() : null;
      if (T && T.height > 0 && T.width > 0) {
        const trRel = { x: T.left - F.left, y: T.top - F.top, w: T.width, h: T.height };
        if (left + cw > trRel.x - M && top < trRel.y + trRel.h + M) {
          if (trRel.x - M - cw >= safe.x0) left = Math.min(left, trRel.x - M - cw);          // slide left of the chip column
          else top = trRel.y + trRel.h + M;                                                 // or drop below it
        }
      }
      if (cw <= safe.x1 - safe.x0 && ch <= safe.y1 - safe.y0) {
        left = Math.max(safe.x0, Math.min(safe.x1 - cw, left));
        top = Math.max(safe.y0, Math.min(safe.y1 - ch, top));
      }
    }
    left = Math.max(M, Math.min(F.width - cw - M, left));
    top = Math.max(M, Math.min(F.height - ch - M, top));
    c.style.left = Math.round(left) + 'px'; c.style.top = Math.round(top) + 'px'; c.dataset.dir = dir;
    const ax = Math.max(16, Math.min(cw - 16, rel.x + rel.w / 2 - left));
    c.style.setProperty('--coach-arrow-x', Math.round(ax) + 'px');
    this._emit('place', { step: step.id, left: Math.round(left), top: Math.round(top), dir, anchor: a.id || a.className });
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); this.ui.dispatchEvent?.(new CustomEvent('coach', { detail: { phase: type, ...detail } })); }
}
