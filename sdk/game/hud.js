/**
 * sdk/game/hud.js — latency HUD for the Teams twin (T5; CONTRACTS.md §3.13, SPEC.md §9).
 *
 * Numbers are ALWAYS computed (probes and the AUTOTEST line read them); the DOM is written at most `hz` times a
 * second and only when elements were given, so the class also runs headless in Node (`new Hud(null, null)`).
 *
 *   chip  (top bar, tabular figures):  `you 34 · Hannah 68 · Bot 12 · relay 9`
 *   panel (HUD tab of Game): fps, script p50/p95, detect ms, per-seat pkt/s + age p50/p95 + band, clock offset /
 *          err / samples, ball owner / phase / in-transit / one-way / handoff p95 / stretches / conflicts / lead ms, contexts
 *
 * Ages: own = now - frame capture time (page: requestVideoFrameCallback else performance.now() at detect);
 * remote = dt32(clock.now(), pkt.t) on the SHARED clock (R/gaps/wire-protocol/hopeos-wire.md §5). Bands are the
 * one-way tolerance bands of R/game/latency-feel.md §4 applied to the p95 age; they drive UI only, never physics.
 */

/** latency-feel.md §4: < 80 invisible; 80-150 fine; 150-300 playable but "remote" (stretch); 300-500 degraded; > 500 wall */
export const BANDS = Object.freeze([
  { name: 'invisible', max: 80 },
  { name: 'fine',      max: 150 },
  { name: 'stretch',   max: 300 },
  { name: 'degraded',  max: 500 },
  { name: 'wall',      max: Infinity },
]);
export function bandOf(p95Ms) {
  if (!Number.isFinite(p95Ms)) return 'invisible';
  if (p95Ms < 80) return 'invisible';
  if (p95Ms < 150) return 'fine';
  if (p95Ms < 300) return 'stretch';
  if (p95Ms <= 500) return 'degraded';
  return 'wall';
}
/** stage.html HUD percentile: sorted[min(n-1, floor(p*n))]; NaN when empty. */
export function pct(arr, p) {
  if (!arr || !arr.length) return NaN;
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
export const WINDOW = 120;
export const CLOCK_ERR_AMBER_MS = 30;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = v => Number.isFinite(v) ? Math.round(v) : '-';
const r1 = v => Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '-';

class Ring {
  constructor(n = WINDOW) { this.n = n; this.a = []; }
  push(v) { if (!Number.isFinite(v)) return; this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
  p50() { return pct(this.a, 0.5); }
  p95() { return pct(this.a, 0.95); }
  last() { return this.a.length ? this.a[this.a.length - 1] : NaN; }
  get length() { return this.a.length; }
}

export class Hud {
  /**
   * @param {HTMLElement|null} chipEl   the top-bar chip (textContent)
   * @param {HTMLElement|null} panelEl  the HUD tab body (innerHTML table)
   * @param {{hz?:number, window?:number, localNow?:()=>number}} opts
   */
  constructor(chipEl, panelEl, { hz = 2, window = WINDOW, localNow } = {}) {
    this.chipEl = chipEl || null;
    this.panelEl = panelEl || null;
    this.hz = hz;
    this.window = window;
    this.localNow = localNow || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.visible = true;
    this.script = new Ring(window); this.detect = new Ring(window); this.fpsRing = new Ring(window);
    this.fps = 0; this.scriptMs = 0; this.detectMs = 0;
    this.ownAgeMs = 0; this.ownRing = new Ring(window);
    this.remote = new Map();               // clientId -> { name, ageMs, ring:Ring, lastAge, arrivals:number[], hz, drops }
    this.relayRttMs = NaN; this.clockOffsetMs = 0; this.clockSamples = 0; this.clockErrMs = NaN;
    this.ballStats = { owner: -1, inTransit: false, phase: 'idle', oneWayMs: 0, handoffMs: 0, stretches: 0, conflicts: 0, leadMs: 0 };
    this.handoffRing = new Ring(32);
    this.nContexts = 0;
    this.frames = 0;
    this.chipText = ''; this.panelHtml = '';
    this._lastRender = -Infinity; this._renders = 0;
  }

  // ── feeders (call every frame / on every event; cheap) ─────────────────────────────────────────────────
  frame({ scriptMs, detectMs, fps } = {}) {
    this.frames++;
    if (Number.isFinite(scriptMs)) { this.script.push(scriptMs); this.scriptMs = scriptMs; }
    if (Number.isFinite(detectMs)) { this.detect.push(detectMs); this.detectMs = detectMs; }
    if (Number.isFinite(fps)) { this.fpsRing.push(fps); this.fps = fps; }
  }
  ownAge(ms) { if (Number.isFinite(ms)) { this.ownAgeMs = ms; this.ownRing.push(ms); } }
  /** Per frame per remote tile. A packet arrival is inferred when the age DROPS between two calls (latest-wins
   *  consumer, so the age only decreases when a newer packet landed); pkt/s = arrivals in the last second. */
  remoteAge(clientId, name, ms) {
    let r = this.remote.get(clientId);
    if (!r) { r = { name: name || String(clientId), ageMs: NaN, ring: new Ring(this.window), lastAge: NaN, arrivals: [], hz: 0, drops: 0, lastSeen: 0 }; this.remote.set(clientId, r); }
    if (name) r.name = name;
    if (!Number.isFinite(ms)) return;
    const now = this.localNow();
    if (Number.isFinite(r.lastAge) && ms < r.lastAge) { r.arrivals.push(now); }
    while (r.arrivals.length && now - r.arrivals[0] > 1000) r.arrivals.shift();
    r.hz = r.arrivals.length;
    r.lastAge = ms; r.ageMs = ms; r.lastSeen = now;
    r.ring.push(ms);
  }
  forget(clientId) { this.remote.delete(clientId); }
  relay({ rttMs, offsetMs, samples, errMs } = {}) {
    if (Number.isFinite(rttMs)) this.relayRttMs = rttMs;
    if (Number.isFinite(offsetMs)) this.clockOffsetMs = offsetMs;
    if (Number.isFinite(samples)) this.clockSamples = samples;
    if (Number.isFinite(errMs)) this.clockErrMs = errMs;
  }
  /** netStats = BallNet.getStats() (+ owner, inTransit); phase = BallGame.phase; leadMs = predictor lead. */
  ball(netStats, phase, leadMs) {
    const s = netStats || {};
    const b = this.ballStats;
    if (s.owner !== undefined) b.owner = s.owner;
    if (s.inTransit !== undefined) b.inTransit = !!s.inTransit;
    if (phase !== undefined) b.phase = phase;
    if (Number.isFinite(s.oneWayMs)) b.oneWayMs = s.oneWayMs;
    if (Number.isFinite(s.stretches)) b.stretches = s.stretches;
    if (Number.isFinite(s.conflicts)) b.conflicts = s.conflicts;
    const h = Number.isFinite(s.handoffMs) ? s.handoffMs : (Number.isFinite(s.stretchMsLast) ? s.stretchMsLast : NaN);
    if (Number.isFinite(h) && h !== b.handoffMs) { b.handoffMs = h; this.handoffRing.push(h); }
    if (Number.isFinite(leadMs)) b.leadMs = leadMs;
  }
  contexts(n) { if (Number.isFinite(n)) this.nContexts = n; }

  // ── readers ────────────────────────────────────────────────────────────────────────────────────────────
  /** Latency band of a remote tile from its p95 age; `'you'` / undefined = my own capture age. */
  band(clientId) {
    if (clientId === undefined || clientId === null || clientId === 'you') return bandOf(this.ownRing.p95());
    const r = this.remote.get(clientId);
    return r ? bandOf(r.ring.p95()) : 'invisible';
  }
  get scriptP50() { return this.script.p50(); }
  get scriptP95() { return this.script.p95(); }
  get detectP50() { return this.detect.p50(); }
  get detectP95() { return this.detect.p95(); }
  get handoffP95() { return this.handoffRing.p95(); }
  remoteStats() {
    const out = {};
    for (const [id, r] of this.remote) out[id] = { name: r.name, ageMs: r.ageMs, hz: r.hz, p50: r.ring.p50(), p95: r.ring.p95(), band: bandOf(r.ring.p95()) };
    return out;
  }
  /** S.hud shape (SPEC §6.1). */
  toJSON() {
    const remote = {};
    for (const [id, r] of this.remote) remote[id] = { ageMs: r.ageMs, hz: r.hz, p95: r.ring.p95(), name: r.name };
    return {
      fps: this.fps, scriptMs: this.scriptMs, detectMs: this.detectMs,
      scriptP50: this.script.p50(), scriptP95: this.script.p95(), detectP50: this.detect.p50(), detectP95: this.detect.p95(),
      ownAgeMs: this.ownAgeMs, remote,
      relayRttMs: this.relayRttMs, clockOffsetMs: this.clockOffsetMs, clockSamples: this.clockSamples, clockErrMs: this.clockErrMs,
      ball: { ...this.ballStats, handoffP95: this.handoffRing.p95() }, contexts: this.nContexts,
    };
  }
  /** `AUTOTEST {...}` console line (R/codebase/test-conventions.md §3-4). NaN -> null so the JSON stays valid. */
  autotestLine(extra = {}) {
    const j = this.toJSON();
    const remote = {}; for (const id in j.remote) remote[id] = Math.round(j.remote[id].ageMs);
    const line = { t: Math.round(this.localNow()), fps: +this.fps.toFixed(1), scriptMs: +this.scriptMs.toFixed(2), detectMs: +this.detectMs.toFixed(2),
      ownAgeMs: Math.round(this.ownAgeMs), remote, owner: j.ball.owner, inTransit: j.ball.inTransit, phase: j.ball.phase, leadMs: j.ball.leadMs,
      contexts: j.contexts, ...extra };
    return 'AUTOTEST ' + JSON.stringify(line, (k, v) => (typeof v === 'number' && !Number.isFinite(v)) ? null : v);
  }

  // ── DOM (<= hz writes per second) ──────────────────────────────────────────────────────────────────────
  chipString() {
    const parts = [`you ${r0(this.ownAgeMs)}`];
    for (const r of this.remote.values()) parts.push(`${r.name} ${r0(r.ageMs)}`);
    if (Number.isFinite(this.relayRttMs)) parts.push(`relay ${r0(this.relayRttMs)}`);
    return parts.join(' · ');
  }
  panelString() {
    const b = this.ballStats;
    const rows = [
      ['fps', r1(this.fps)],
      ['script p50 / p95', `${r1(this.script.p50())} / ${r1(this.script.p95())} ms`],
      ['detect p50 / p95', `${r1(this.detect.p50())} / ${r1(this.detect.p95())} ms`],
      ['own age', `${r0(this.ownAgeMs)} ms · ${bandOf(this.ownRing.p95())}`],
    ];
    for (const [id, r] of this.remote) rows.push([`${r.name} (${String(id).slice(0, 8)})`, `${r.hz} pkt/s · age ${r0(r.ageMs)} · p50 ${r0(r.ring.p50())} · p95 ${r0(r.ring.p95())} ms · ${bandOf(r.ring.p95())}`]);
    rows.push(['clock offset / err / samples', `${r0(this.clockOffsetMs)} / ${r0(this.clockErrMs)} / ${this.clockSamples}` + (this.clockErrMs > CLOCK_ERR_AMBER_MS ? ' · amber' : '')]);
    rows.push(['relay rtt', `${r0(this.relayRttMs)} ms`]);
    rows.push(['ball', `owner ${b.owner} · ${b.phase} · ${b.inTransit ? 'in transit' : 'settled'} · one-way ${r0(b.oneWayMs)} · handoff p95 ${r0(this.handoffRing.p95())} · stretches ${b.stretches} · conflicts ${b.conflicts} · lead ${r0(b.leadMs)} ms`]);
    rows.push(['contexts', String(this.nContexts)]);
    return '<table class="hud-table">' + rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</table>';
  }
  /** Throttled DOM write; returns true when it wrote. `nowLocal` = performance.now() (or the loop's local clock). */
  render(nowLocal = this.localNow()) {
    if (nowLocal - this._lastRender < 1000 / this.hz) return false;
    this._lastRender = nowLocal; this._renders++;
    this.chipText = this.chipString();
    this.panelHtml = this.panelString();
    if (this.visible) {
      if (this.chipEl) this.chipEl.textContent = this.chipText;
      if (this.panelEl) this.panelEl.innerHTML = this.panelHtml;
    }
    return true;
  }
  setVisible(on) {
    this.visible = !!on;
    if (this.chipEl) this.chipEl.hidden = !this.visible;
    if (this.panelEl) this.panelEl.hidden = !this.visible;
  }
}
