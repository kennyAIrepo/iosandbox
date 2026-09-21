/**
 * leaderboard.js — per-participant score model, host authority over the wire (SCORE 0x31), and the restrained
 * Fluent view pieces: top-bar chip decoration (scored pulse + streak flame), the People-pane "Leaderboard" section,
 * the round-end card and the goal celebration. Node-safe: no three.js, no DOM at module load (every DOM touch is
 * inside a method / function that receives elements); `render()` works against any object with an `innerHTML`.
 *
 * Model (per participant, keyed by seat on the wire, by clientId across re-seating):
 *   { seat, name, colour, goals, catches, passes, streak, potatoDrops }
 *   goals        GOAL 0x14 without the potato bit (ball-game.js 'goal' {scorerSeat, potato:false})
 *   potatoDrops  GOAL with POTATO_BIT (ball-game.js 'goal' {potato:true}: the holder lost the point)
 *   catches      a hold that BEGINS on seat B while a pass from seat A (a LAUNCH, ball-game.js 'launch') is pending
 *   passes       credited to A on that same catch (B caught what A threw)
 *   streak       consecutive goals/catches by the seat; a miss / drop / potato drop resets it; flame at >= 3
 *
 * Authority: the HOST mutates and broadcasts the full table after every change and every BROADCAST_MS (tick);
 * a client only ever `apply()`s host packets, keeps the newest by seq (wrap-safe) and never computes its own.
 * On host migration `becomeHost()` continues the seq after the last one seen, so the other clients accept it.
 */
import { encodeScore, decodeScore, seqNewer16, dt32, FLAG, ROUND, END_REASON, MODE_NAME, SCORE_MAX_ROWS, PK_SCORE, isScorePacket } from '../net/score-packet.js';

export { ROUND, END_REASON, PK_SCORE, isScorePacket };

export const SCORE_RULES = Object.freeze({
  GOALS_TO_WIN: 5,          // free mode: first to this many goals ends the round
  ROUND_MS: 180000,         // free / potato: 3 minutes; practice never ends on time
  STREAK_FLAME: 3,          // chip flame emoji from this streak
  BROADCAST_MS: 2000,       // host heartbeat of the full table
  PASS_WINDOW_MS: 5000,     // a LAUNCH counts as a pass only if a hold begins on another seat within this window
  CARD_AUTO_MS: 8000,       // round-end card auto-dismiss
  CELEBRATE_MS: 1200,       // goal flash + confetti
  MAX_ROWS: SCORE_MAX_ROWS,
});

const STAT_KEYS = ['goals', 'catches', 'passes', 'streak', 'potatoDrops'];

export function emptyRow(seat, name = 'seat ' + seat, colour = seat % 9) {
  return { seat, name, colour, goals: 0, catches: 0, passes: 0, streak: 0, potatoDrops: 0 };
}

/** goals desc, catches desc, passes desc, potato drops asc, streak desc, then name, then seat — deterministic everywhere. */
export function compareRows(a, b) {
  return (b.goals - a.goals) || (b.catches - a.catches) || (b.passes - a.passes) || (a.potatoDrops - b.potatoDrops) || (b.streak - a.streak)
    || String(a.name).localeCompare(String(b.name), 'en') || (a.seat - b.seat);
}
const sameScore = (a, b) => a.goals === b.goals && a.catches === b.catches && a.passes === b.passes && a.potatoDrops === b.potatoDrops;

/** Ranked copy with standard competition ranking: equal (goals, catches, passes, potatoDrops) share a rank (1, 1, 3). */
export function rankRows(rows) {
  const out = [...rows].map(r => ({ ...r })).sort(compareRows);
  for (let i = 0; i < out.length; i++) out[i].rank = i > 0 && sameScore(out[i], out[i - 1]) ? out[i - 1].rank : i + 1;
  return out;
}

const evt = (type, detail) => new CustomEvent(type, { detail });

export class Leaderboard extends EventTarget {
  /**
   * @param {{isHost?:boolean, clock?:{now():number}|null, mode?:'free'|'potato'|'practice', goalsToWin?:number, roundMs?:number,
   *          broadcastMs?:number, colourOf?:(seat:number)=>number}} o
   */
  constructor(o = {}) {
    super();
    this.isHost = !!o.isHost;
    this.clock = o.clock || null;
    this.mode = MODE_NAME.includes(o.mode) ? o.mode : 'free';
    this.broadcastMs = o.broadcastMs ?? SCORE_RULES.BROADCAST_MS;
    this.colourOf = o.colourOf || (seat => seat % 9);
    this.rows = new Map();                 // seat -> row
    this._byClient = new Map();            // clientId -> row (survives re-seating)
    this.seq = 0;                          // host: next SCORE seq
    this.lastSeq = -1;                     // newest seq applied (client) or sent (host)
    this.round = { state: ROUND.LOBBY, reason: END_REASON.NONE, no: 0, goalsToWin: o.goalsToWin ?? SCORE_RULES.GOALS_TO_WIN, winnerSeat: -1, startedAt: 0, roundMs: o.roundMs ?? SCORE_RULES.ROUND_MS };
    this._pass = null;                     // { from, to, t } pending pass credit after a LAUNCH
    this._held = new Map();                // seat -> bool, observeHold edge detector
    this._lastBroadcast = -Infinity;
    this._now = 0;
    this.lastGoalSeat = -1; this.lastGoalAt = -Infinity;
    this.stats = { changes: 0, sent: 0, applied: 0, rejectedStale: 0, rejectedNotHost: 0, rejectedBad: 0, ignoredAsHost: 0 };
  }

  now() { return this.clock ? this.clock.now() : this._now; }
  get streakFlame() { return SCORE_RULES.STREAK_FLAME; }

  // ── roster ───────────────────────────────────────────────────────────────
  /** [{seat, name, clientId?, colour?}] — keeps stats across re-seating (by clientId, else by seat); drops departed seats. */
  setRoster(list) {
    const next = new Map(), byClient = new Map();
    let changed = false;
    for (const p of list || []) {
      if (p == null || !(p.seat >= 0)) continue;
      const prev = (p.clientId != null && this._byClient.get(p.clientId)) || this.rows.get(p.seat) || null;
      const row = prev ? { ...prev } : emptyRow(p.seat);
      const name = p.name || row.name || ('seat ' + p.seat);
      const colour = p.colour ?? this.colourOf(p.seat);
      if (!prev || prev.seat !== p.seat || prev.name !== name || prev.colour !== colour) changed = true;
      row.seat = p.seat; row.name = name; row.colour = colour;
      if (p.clientId != null) { row.clientId = p.clientId; byClient.set(p.clientId, row); }
      next.set(p.seat, row);
    }
    if (next.size !== this.rows.size) changed = true;
    this.rows = next; this._byClient = byClient;
    if (changed) this._changed('roster', -1);
    return changed;
  }
  setMode(mode) {
    if (!MODE_NAME.includes(mode) || mode === this.mode) return false;
    this.mode = mode; this._changed('mode', -1); return true;
  }
  row(seat) { let r = this.rows.get(seat); if (!r && seat >= 0 && this.rows.size < SCORE_RULES.MAX_ROWS) { r = emptyRow(seat, undefined, this.colourOf(seat)); this.rows.set(seat, r); } return r || null; }

  // ── host-side events (from BallGame) — no-ops on a client, which only applies packets ───────────────────
  /** GOAL packet seen: potato → the holder loses (potatoDrops++, streak 0); else goals++ and streak++ for the scorer. */
  goal(seat, { potato = false } = {}) {
    if (!this.isHost || this.round.state === ROUND.ENDED) return false;   // nothing counts between the final whistle and Play again
    const r = this.row(seat); if (!r) return false;
    if (potato) { r.potatoDrops++; r.streak = 0; }
    else { r.goals++; r.streak++; this.lastGoalSeat = seat; this.lastGoalAt = this.now(); }
    this._pass = null;
    this.dispatchEvent(evt('goal', { seat, row: { ...r }, potato }));
    if (!potato && r.streak === SCORE_RULES.STREAK_FLAME) this.dispatchEvent(evt('streak', { seat, streak: r.streak }));
    this._changed(potato ? 'potato' : 'goal', seat);
    if (!potato) this._checkGoalsEnd();
    return true;
  }
  /** LAUNCH seen: `from` threw toward `to` (-1 = unknown). The pass is credited on the catch. */
  throw(from, to = -1) {
    if (!this.isHost) return false;
    this._pass = { from, to, t: this.now() };
    return true;
  }
  /** A ball from another tile was caught on `seat` (ball-game.js 'ring' catch semantics). */
  catch(seat) {
    if (!this.isHost || this.round.state === ROUND.ENDED) return false;
    const r = this.row(seat); if (!r) return false;
    r.catches++; r.streak++;
    const p = this._pass;
    if (p && p.from !== seat && p.from >= 0 && (p.to < 0 || p.to === seat) && dt32(this.now(), p.t) <= SCORE_RULES.PASS_WINDOW_MS) {
      const t = this.row(p.from); if (t) t.passes++;
    }
    this._pass = null;
    this.dispatchEvent(evt('catch', { seat, row: { ...r } }));
    if (r.streak === SCORE_RULES.STREAK_FLAME) this.dispatchEvent(evt('streak', { seat, streak: r.streak }));
    this._changed('catch', seat);
    return true;
  }
  miss(seat) { return this._resetStreak(seat, 'miss', true); }
  drop(seat) { return this._resetStreak(seat, 'drop', false); }
  _resetStreak(seat, reason, clearPass) {
    if (!this.isHost) return false;
    const r = this.row(seat); if (!r) return false;
    if (clearPass) this._pass = null;
    if (r.streak === 0) return true;
    r.streak = 0; this._changed(reason, seat); return true;
  }
  /**
   * Rising edge of "seat holds the ball" while a pass from ANOTHER seat is pending → catch (+ pass credit).
   * A plain pickup with no pending pass is not a catch. Feed the host's own hold from `game.ball.hold || game.ball.cradle`
   * and remote seats from the HAND_STREAM hold byte (`remote.read(seat, now).hold.mode !== HOLD.FREE`).
   */
  observeHold(seat, held) {
    held = !!held;
    const was = this._held.get(seat) || false;
    this._held.set(seat, held);
    if (!this.isHost || !held || was) return false;
    const p = this._pass;
    if (!p || p.from === seat || (p.to >= 0 && p.to !== seat) || dt32(this.now(), p.t) > SCORE_RULES.PASS_WINDOW_MS) return false;
    return this.catch(seat);
  }

  // ── rounds (host controlled) ─────────────────────────────────────────────
  startRound(now = this.now()) {
    if (!this.isHost) return false;
    const rd = this.round;
    rd.state = ROUND.LIVE; rd.no = (rd.no + 1) & 0xff || 1; rd.startedAt = now >>> 0; rd.reason = END_REASON.NONE; rd.winnerSeat = -1;
    this._pass = null;
    this.dispatchEvent(evt('round', { state: 'live', no: rd.no, ranked: this.ranked() }));
    this._changed('round', -1);
    return true;
  }
  endRound(reason = END_REASON.HOST, now = this.now()) {
    if (!this.isHost || this.round.state !== ROUND.LIVE) return false;
    const rd = this.round, ranked = this.ranked();
    rd.state = ROUND.ENDED; rd.reason = reason;
    rd.winnerSeat = ranked.length && !(ranked[1] && ranked[1].rank === 1) && (ranked[0].goals + ranked[0].catches + ranked[0].passes > 0) ? ranked[0].seat : -1;
    this.dispatchEvent(evt('round', { state: 'ended', no: rd.no, reason, winnerSeat: rd.winnerSeat, ranked }));
    this._changed('round', -1);
    return true;
  }
  /** Host: zero every stat and start the next round. */
  playAgain(now = this.now()) {
    if (!this.isHost) return false;
    for (const r of this.rows.values()) for (const k of STAT_KEYS) r[k] = 0;
    this._held.clear();
    return this.startRound(now);
  }
  /** Host: zero every stat, back to the lobby (the page's Reset button). */
  resetScores() {
    if (!this.isHost) return false;
    for (const r of this.rows.values()) for (const k of STAT_KEYS) r[k] = 0;
    this.round.state = ROUND.LOBBY; this.round.reason = END_REASON.NONE; this.round.winnerSeat = -1; this.round.startedAt = 0;
    this._pass = null;
    this.dispatchEvent(evt('round', { state: 'lobby', no: this.round.no, ranked: this.ranked() }));
    this._changed('reset', -1);
    return true;
  }
  _checkGoalsEnd() {
    if (this.round.state !== ROUND.LIVE || this.mode !== 'free' || !(this.round.goalsToWin > 0)) return;
    for (const r of this.rows.values()) if (r.goals >= this.round.goalsToWin) { this.endRound(END_REASON.GOALS); return; }
  }
  /**
   * Per frame (or any cadence >= 10 Hz). Host: time limit, hold sampling through `heldOf(seat) -> boolean|null`,
   * and the 2 s heartbeat. Returns the bytes sent this tick (null when nothing was sent).
   */
  tick(now, heldOf = null) {
    if (now != null) this._now = now; else now = this.now();
    if (!this.isHost) return null;
    let sent = null;
    if (this.round.state === ROUND.LIVE && this.mode !== 'practice' && this.round.roundMs > 0 && dt32(now, this.round.startedAt) >= this.round.roundMs) { this.endRound(END_REASON.TIME, now); sent = this._lastBytes; }
    if (heldOf) for (const seat of [...this.rows.keys()]) { const h = heldOf(seat); if (h != null && this.observeHold(seat, h)) sent = this._lastBytes; }
    if (dt32(now, this._lastBroadcast) >= this.broadcastMs || this._lastBroadcast === -Infinity) sent = this._broadcast('heartbeat');
    return sent;
  }

  // ── wire ─────────────────────────────────────────────────────────────────
  table() { return { mode: this.mode, round: { ...this.round }, rows: [...this.rows.values()].sort((a, b) => a.seat - b.seat).map(r => ({ ...r })) }; }
  /** Host: encode the full table with the next seq (the caller sends it reliably). */
  packet(now = this.now()) {
    if (!this.isHost) return null;
    const bytes = encodeScore(this.table(), this.seq, now, FLAG.FROM_HOST);
    this.lastSeq = this.seq; this.seq = (this.seq + 1) & 0xffff; this.stats.sent++;
    this._lastBytes = bytes;
    return bytes;
  }
  _broadcast(reason) {
    const bytes = this.packet(); if (!bytes) return null;
    this._lastBroadcast = this.now();
    this.dispatchEvent(evt('broadcast', { bytes, reason, seq: this.lastSeq }));
    return bytes;
  }
  _changed(reason, seat) {
    this.stats.changes++;
    this.dispatchEvent(evt('change', { reason, seat }));
    if (this.isHost) this._broadcast(reason);
  }
  /**
   * Client: apply a SCORE packet. Rejected (returns false) when: this is the host, the packet is malformed, it lacks
   * FROM_HOST, or its seq is not newer than the last applied one (a stale / reordered packet never wins).
   */
  apply(buf) {
    if (this.isHost) { this.stats.ignoredAsHost++; return false; }
    let d;
    try { d = buf && typeof buf === 'object' && Array.isArray(buf.rows) && buf.type === PK_SCORE ? buf : decodeScore(buf); } catch { this.stats.rejectedBad++; return false; }
    if (!d.fromHost) { this.stats.rejectedNotHost++; return false; }
    if (this.lastSeq >= 0 && !seqNewer16(d.seq, this.lastSeq)) { this.stats.rejectedStale++; return false; }
    const prevRows = this.rows, prevRound = { ...this.round }, prevMode = this.mode, first = this.lastSeq < 0;
    const rows = new Map();
    for (const r of d.rows) { const prev = prevRows.get(r.seat); const row = { ...r }; if (prev && prev.name === r.name && prev.clientId != null) row.clientId = prev.clientId; rows.set(r.seat, row); }
    this.rows = rows; this.mode = d.mode; this.round = { ...d.round }; this.lastSeq = d.seq; this.stats.applied++;
    // transitions → the same events the host raised locally, so one UI path serves both roles; a late joiner's FIRST
    // packet is history, not news (no celebration per past goal, no stale round card)
    if (!first) for (const r of rows.values()) {
      const p = prevRows.get(r.seat) || emptyRow(r.seat);
      if (r.goals > p.goals) { this.lastGoalSeat = r.seat; this.lastGoalAt = this.now(); this.dispatchEvent(evt('goal', { seat: r.seat, row: { ...r }, potato: false })); }
      if (r.potatoDrops > p.potatoDrops) this.dispatchEvent(evt('goal', { seat: r.seat, row: { ...r }, potato: true }));
      if (r.catches > p.catches) this.dispatchEvent(evt('catch', { seat: r.seat, row: { ...r } }));
      if (r.streak >= SCORE_RULES.STREAK_FLAME && p.streak < SCORE_RULES.STREAK_FLAME) this.dispatchEvent(evt('streak', { seat: r.seat, streak: r.streak }));
    }
    if (!first && (this.round.state !== prevRound.state || this.round.no !== prevRound.no)) {
      const st = this.round.state === ROUND.ENDED ? 'ended' : this.round.state === ROUND.LIVE ? 'live' : 'lobby';
      this.dispatchEvent(evt('round', { state: st, no: this.round.no, reason: this.round.reason, winnerSeat: this.round.winnerSeat, ranked: this.ranked() }));
    }
    this.dispatchEvent(evt('change', { reason: 'packet', seat: -1, seq: d.seq, modeChanged: prevMode !== d.mode }));
    return true;
  }
  /** Host migration: keep the table, continue the seq after the newest one seen so the other clients accept us. */
  becomeHost() { if (this.isHost) return; this.isHost = true; this.seq = this.lastSeq >= 0 ? (this.lastSeq + 1) & 0xffff : 0; this._lastBroadcast = -Infinity; }
  resign() { this.isHost = false; }

  // ── views ────────────────────────────────────────────────────────────────
  ranked() { return rankRows([...this.rows.values()]); }
  snapshot() { return { ...this.table(), seq: this.seq, lastSeq: this.lastSeq, isHost: this.isHost, stats: { ...this.stats } }; }
  /** Everything render() / cardHTML() need, plain data. */
  viewState({ meSeat = -1, now = this.now() } = {}) {
    const rd = this.round, live = rd.state === ROUND.LIVE;
    const elapsedMs = live ? Math.max(0, dt32(now, rd.startedAt)) : 0;
    const remainingMs = live && rd.roundMs > 0 && this.mode !== 'practice' ? Math.max(0, rd.roundMs - elapsedMs) : null;
    const rows = this.ranked();
    return { rows, round: { ...rd }, mode: this.mode, goalsToWin: this.mode === 'free' ? rd.goalsToWin : 0, meSeat, elapsedMs, remainingMs,
      leaderSeat: rows.length && (rows[0].goals + rows[0].catches + rows[0].passes > 0) ? rows[0].seat : -1, streakFlame: SCORE_RULES.STREAK_FLAME,
      lastGoalSeat: dt32(now, this.lastGoalAt) < SCORE_RULES.CELEBRATE_MS ? this.lastGoalSeat : -1 };
  }
}

/**
 * Wire a BallGame's events into the model (host: mutates; client: harmless no-ops, the packets drive it).
 * Uses what ball-game.js emits today: 'goal' {scorerSeat, potato}, 'launch' {launch:{from,to}}, 'ring' {seat, kind:'miss'},
 * 'release' {kind:'drop'} (local seat only), 'mode' {mode}, 'seatmap' {map}. Catches come from `lb.tick(now, heldOf)`.
 * @returns {() => void} unbind
 */
export function bindGame(lb, game, { roster = true } = {}) {
  const on = (type, fn) => { game.addEventListener(type, fn); return () => game.removeEventListener(type, fn); };
  const offs = [
    on('goal', e => lb.goal(e.detail.scorerSeat, { potato: !!e.detail.potato })),
    on('launch', e => { const l = e.detail && e.detail.launch; if (l) lb.throw(l.from, l.to == null || l.to === 255 ? -1 : l.to); }),
    on('ring', e => { if (e.detail && e.detail.kind === 'miss') lb.miss(e.detail.seat); }),
    on('release', e => { if (e.detail && e.detail.kind === 'drop' && game.net && game.net.simSeat >= 0) lb.drop(game.net.simSeat); }),
    on('mode', e => lb.setMode(e.detail.mode)),
    on('seatmap', e => { const m = e.detail && e.detail.map; if (roster && m && Array.isArray(m.seats)) lb.setRoster(m.seats.map(s => ({ seat: s.seat, name: s.name, clientId: s.clientId }))); }),
  ];
  return () => offs.forEach(f => f());
}

// ── HTML views (pure string builders; `render` sets innerHTML on whatever it is given) ────────────────────
export function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function formatClock(ms) { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
const seatVar = colour => `var(--tw-seat-${(+colour || 0) % 9})`;
const flameHTML = (row, flame) => row.streak >= flame ? `<span class="lb__flame" role="img" aria-label="${row.streak} in a row" title="${row.streak} in a row">🔥</span>` : '';

/** One-line round status for the section header. */
export function roundLine(state) {
  const rd = state.round, n = rd.no ? `Round ${rd.no}` : 'Round';
  if (state.mode === 'practice') return rd.state === ROUND.LIVE ? 'Practice' : 'Practice · waiting for kick-off';
  if (rd.state === ROUND.LIVE) {
    const parts = [n]; if (state.goalsToWin > 0) parts.push(`first to ${state.goalsToWin}`); if (state.remainingMs != null) parts.push(`${formatClock(state.remainingMs)} left`);
    return parts.join(' · ');
  }
  if (rd.state === ROUND.ENDED) {
    const w = state.rows.find(r => r.seat === rd.winnerSeat);
    return `${n} over · ${w ? escapeHtml(w.name) + ' wins' : 'draw'}`;
  }
  return 'Waiting for kick-off';
}

/** The People-pane section body: heading, round line, ranked rows (seat dot, name, goals, catches, thin bar). */
export function sectionHTML(state) {
  const rows = state.rows || [], flame = state.streakFlame ?? SCORE_RULES.STREAK_FLAME;
  const byGoals = state.mode !== 'potato';
  const top = Math.max(1, byGoals ? Math.max(state.goalsToWin || 0, ...rows.map(r => r.goals)) : Math.max(...rows.map(r => r.catches)));
  const items = rows.map(r => {
    const val = byGoals ? r.goals : r.catches, pct = Math.round(100 * Math.min(1, val / top));
    const cls = ['lb__row', r.seat === state.meSeat ? 'is-me' : '', r.rank === 1 && r.seat === state.leaderSeat ? 'is-leader' : '', r.seat === state.lastGoalSeat ? 'is-scored' : ''].filter(Boolean).join(' ');
    return `<li class="${cls}" data-seat="${r.seat}" data-rank="${r.rank}" style="--seat-color:${seatVar(r.colour)}">` +
      `<span class="lb__rank" aria-hidden="true">${r.rank}</span><i class="lb__dot" aria-hidden="true"></i>` +
      `<span class="lb__name"><span class="lb__nm">${escapeHtml(r.name)}</span>${r.seat === state.meSeat ? '<span class="lb__you tw-caption1">you</span>' : ''}${flameHTML(r, flame)}</span>` +
      `<span class="lb__stat lb__stat--goals tw-numeric" aria-label="${r.goals} goal${r.goals === 1 ? '' : 's'}">${r.goals}<small>G</small></span>` +
      `<span class="lb__stat lb__stat--catches tw-numeric" aria-label="${r.catches} catch${r.catches === 1 ? '' : 'es'}">${r.catches}<small>C</small></span>` +
      (r.potatoDrops ? `<span class="lb__stat lb__stat--drops tw-numeric" aria-label="${r.potatoDrops} potato drop${r.potatoDrops === 1 ? '' : 's'}">${r.potatoDrops}<small>🥔</small></span>` : '') +
      `<span class="lb__bar" aria-hidden="true"><i style="width:${pct}%"></i></span></li>`;
  }).join('');
  return `<div class="lb__head"><h2 class="panel__h lb__title">Leaderboard</h2><span class="lb__round tw-caption1">${roundLine(state)}</span></div>` +
    (rows.length ? `<ol class="lb__rows" aria-label="Ranking">${items}</ol>` : `<p class="lb__empty tw-caption1">Scores appear when the game starts.</p>`);
}

/**
 * render(el, state): builds the section HTML for `state` (= Leaderboard.viewState()) and writes it to `el.innerHTML`
 * when it changed (el may be null or any object with an innerHTML property — no DOM needed). Returns the HTML.
 */
export function render(el, state) {
  const html = sectionHTML(state);
  if (el && el.innerHTML !== html) el.innerHTML = html;
  return html;
}

/** Mount the section as the first child of the People pane (`#pane-people`); returns the section element. */
export function mountLeaderboard(paneEl, { id = 'leaderboard' } = {}) {
  let sec = paneEl.querySelector('#' + id);
  if (!sec) { sec = paneEl.ownerDocument.createElement('section'); sec.id = id; sec.className = 'lb'; sec.setAttribute('aria-label', 'Leaderboard'); paneEl.insertBefore(sec, paneEl.firstChild); }
  return sec;
}

/** Round-end card body (the card itself is a `div.lb-card[role=dialog]` from RoundCard). */
export function cardHTML(state, { canPlayAgain = true } = {}) {
  const rd = state.round, rows = state.rows || [], w = rows.find(r => r.seat === rd.winnerSeat);
  const why = rd.reason === END_REASON.GOALS ? `First to ${rd.goalsToWin}` : rd.reason === END_REASON.TIME ? "Time's up" : 'Round ended';
  const title = w ? `${escapeHtml(w.name)} wins` : (rows.length ? "It's a draw" : 'Round over');
  const items = rows.map(r => `<li class="lb-card__row${r.seat === state.meSeat ? ' is-me' : ''}" style="--seat-color:${seatVar(r.colour)}">` +
    `<span class="lb__rank" aria-hidden="true">${r.rank}</span><i class="lb__dot" aria-hidden="true"></i><span class="lb__name"><span class="lb__nm">${escapeHtml(r.name)}</span>${r.seat === state.meSeat ? '<span class="lb__you tw-caption1">you</span>' : ''}</span>` +
    `<span class="lb-card__stats tw-numeric"><b>${r.goals}</b><small>goals</small><b>${r.catches}</b><small>catches</small><b>${r.passes}</b><small>passes</small></span></li>`).join('');
  return `<p class="lb-card__eyebrow tw-caption1">${rd.no ? `Round ${rd.no} · ` : ''}${why}</p><h2 class="lb-card__title">${title}</h2>` +
    `<ol class="lb-card__rows" aria-label="Final ranking">${items}</ol>` +
    `<div class="lb-card__btns"><button type="button" class="tw-btn tw-btn--primary tw-focusable lb-card__again"${canPlayAgain ? '' : ' disabled title="Only the host can restart"'}>Play again</button>` +
    `<button type="button" class="tw-btn tw-btn--outline tw-focusable lb-card__close">Close</button></div><i class="lb-card__timer" aria-hidden="true"></i>`;
}

// ── DOM pieces (browser only; every DOM reference is a parameter) ─────────────────────────────────────────

/**
 * Decorate TwinUI's top-bar chips (`#scoreboard .sb__seat`, built in seat order by TwinUI.setScore) with the streak
 * flame and the scored pulse. TwinUI rebuilds the chips on every setScore, so call this after it (or use ScoreChips).
 */
export function decorateScoreboard(sb, state, { pulseSeat = -1 } = {}) {
  if (!sb) return 0;
  const chips = sb.querySelectorAll('.sb__seat');
  const bySeat = [...(state.rows || [])].sort((a, b) => a.seat - b.seat);
  let n = 0;
  chips.forEach((chip, i) => {
    const row = bySeat[i]; if (!row) return;
    chip.dataset.seat = String(row.seat); n++;
    let flame = chip.querySelector('.lb-flame');
    if (row.streak >= SCORE_RULES.STREAK_FLAME) {
      if (!flame) { flame = chip.ownerDocument.createElement('span'); flame.className = 'lb-flame'; flame.setAttribute('role', 'img'); flame.textContent = '🔥'; chip.appendChild(flame); }
      flame.setAttribute('aria-label', row.streak + ' in a row'); flame.title = row.streak + ' in a row';
    } else if (flame) flame.remove();
    if (row.seat === pulseSeat) {
      chip.classList.remove('lb-pulse'); void chip.offsetWidth; chip.classList.add('lb-pulse');
      chip.addEventListener('animationend', () => chip.classList.remove('lb-pulse'), { once: true });
    }
  });
  return n;
}

/** Keeps the chips decorated across TwinUI rebuilds (childList observer) and pulses the scorer for CELEBRATE_MS. */
export class ScoreChips {
  constructor(sb, lb, { meSeat = () => -1 } = {}) {
    this.sb = sb; this.lb = lb; this.meSeat = meSeat; this._pulseSeat = -1; this._pulseAt = -Infinity;
    this._mo = typeof MutationObserver === 'function' && sb ? new MutationObserver(() => this.refresh()) : null;
    if (this._mo) this._mo.observe(sb, { childList: true });
    this._onGoal = e => { if (!e.detail.potato) this.pulse(e.detail.seat); else this.refresh(); };
    this._onChange = () => this.refresh();
    lb.addEventListener('goal', this._onGoal); lb.addEventListener('change', this._onChange);
  }
  pulse(seat) { this._pulseSeat = seat; this._pulseAt = (typeof performance !== 'undefined' ? performance.now() : 0); this.refresh(); }
  refresh() {
    const fresh = (typeof performance !== 'undefined' ? performance.now() : 0) - this._pulseAt < SCORE_RULES.CELEBRATE_MS;
    decorateScoreboard(this.sb, this.lb.viewState({ meSeat: this.meSeat() }), { pulseSeat: fresh ? this._pulseSeat : -1 });
    if (fresh) this._pulseSeat = this._pulseSeat; else this._pulseSeat = -1;
  }
  dispose() { if (this._mo) this._mo.disconnect(); this.lb.removeEventListener('goal', this._onGoal); this.lb.removeEventListener('change', this._onChange); }
}

/**
 * Keeps the People-pane section rendered: on every change, once more when the scored highlight expires (CELEBRATE_MS),
 * and at 1 Hz while a round is live (the "01:54 left" countdown). `meSeat()` is asked at render time.
 */
export class SectionView {
  constructor(sectionEl, lb, { meSeat = () => -1 } = {}) {
    this.el = sectionEl; this.lb = lb; this.meSeat = meSeat; this._timer = 0; this._tick = 0;
    this._onChange = () => this.render();
    this._onGoal = () => { clearTimeout(this._timer); this._timer = setTimeout(() => this.render(), SCORE_RULES.CELEBRATE_MS + 50); };
    lb.addEventListener('change', this._onChange); lb.addEventListener('goal', this._onGoal);
    this._tick = setInterval(() => { if (this.lb.round.state === ROUND.LIVE) this.render(); }, 1000);
    this.render();
  }
  render() { return render(this.el, this.lb.viewState({ meSeat: this.meSeat() })); }
  dispose() { clearTimeout(this._timer); clearInterval(this._tick); this.lb.removeEventListener('change', this._onChange); this.lb.removeEventListener('goal', this._onGoal); }
}

/**
 * Round-end card centred over the gallery: ranking, Play again (host) / Close, auto-dismiss, aria-live, Esc closes.
 * `host` is the element to append to (the stage); `canPlayAgain()` is asked at show time (host only).
 */
export class RoundCard {
  constructor(host, { onPlayAgain = null, onClose = null, autoMs = SCORE_RULES.CARD_AUTO_MS, canPlayAgain = () => true, reducedMotion = () => false } = {}) {
    this.host = host; this.onPlayAgain = onPlayAgain; this.onClose = onClose; this.autoMs = autoMs; this.canPlayAgain = canPlayAgain; this.reducedMotion = reducedMotion;
    this.el = null; this._timer = 0; this._restore = null;
  }
  get open() { return !!this.el; }
  show(state) {
    this.hide(false);
    const doc = this.host.ownerDocument, el = doc.createElement('div');
    el.className = 'lb-card'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'false'); el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-label', 'Round over'); el.tabIndex = -1; el.dataset.reducedMotion = this.reducedMotion() ? 'true' : 'false';
    el.style.setProperty('--lb-card-ms', this.autoMs + 'ms');
    const inner = doc.createElement('div'); inner.className = 'lb-card__inner'; inner.innerHTML = cardHTML(state, { canPlayAgain: !!this.canPlayAgain() });
    el.appendChild(inner);
    const again = inner.querySelector('.lb-card__again'), close = inner.querySelector('.lb-card__close');
    again.addEventListener('click', () => { this.hide(); if (this.onPlayAgain) this.onPlayAgain(); });
    close.addEventListener('click', () => this.hide());
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); this.hide(); } });
    this._restore = doc.activeElement;
    this.host.appendChild(el); this.el = el;
    (again.disabled ? close : again).focus({ preventScroll: true });
    if (this.autoMs > 0) this._timer = setTimeout(() => this.hide(), this.autoMs);
    return el;
  }
  hide(callback = true) {
    clearTimeout(this._timer); this._timer = 0;
    if (!this.el) return;
    const el = this.el; this.el = null; el.remove();
    if (this._restore && typeof this._restore.focus === 'function' && this._restore.isConnected) { try { this._restore.focus({ preventScroll: true }); } catch { /* detached */ } }
    this._restore = null;
    if (callback && this.onClose) this.onClose();
  }
}

/**
 * Goal celebration on the scorer's tile: outline flash in the seat colour (class `lb-goal-flash`, --lb-colour) and
 * CSS confetti sprites inside the tile for CELEBRATE_MS. Reduced motion: a static flash, no confetti.
 * Pure CSS/DOM — nothing is added to the WebGL stage (render-budget rule). Returns a cancel function.
 */
export function celebrateGoal({ tile, colour = 0, reducedMotion = false, ms = SCORE_RULES.CELEBRATE_MS, count = 28, rng = Math.random } = {}) {
  if (!tile) return () => {};
  if (typeof tile.__lbCelebrateCancel === 'function') tile.__lbCelebrateCancel();   // a second goal on the same tile restarts, never races the first one's cleanup
  const doc = tile.ownerDocument;
  tile.style.setProperty('--lb-colour', typeof colour === 'number' ? seatVar(colour) : String(colour));
  tile.classList.remove('lb-goal-flash'); void tile.offsetWidth; tile.classList.add('lb-goal-flash');
  let layer = null;
  if (!reducedMotion) {
    layer = doc.createElement('div'); layer.className = 'lb-confetti'; layer.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i++) {
      const bit = doc.createElement('i');
      bit.style.setProperty('--x', (rng() * 100).toFixed(1) + '%');
      bit.style.setProperty('--dx', ((rng() - 0.5) * 80).toFixed(0) + 'px');
      bit.style.setProperty('--rot', (rng() * 720 - 360).toFixed(0) + 'deg');
      bit.style.setProperty('--delay', (rng() * ms * 0.25).toFixed(0) + 'ms');
      bit.style.setProperty('--c', i % 3 === 0 ? 'var(--lb-colour)' : seatVar((i * 7 + 1) % 9));
      bit.style.setProperty('--s', (rng() * 0.6 + 0.6).toFixed(2));
      layer.appendChild(bit);
    }
    tile.appendChild(layer);
  }
  const timer = setTimeout(done, ms + 120);
  function done() { clearTimeout(timer); if (tile.__lbCelebrateCancel === done) tile.__lbCelebrateCancel = null; tile.classList.remove('lb-goal-flash'); if (layer) layer.remove(); layer = null; }
  tile.__lbCelebrateCancel = done;
  return done;
}
