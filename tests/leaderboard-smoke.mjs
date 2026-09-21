/**
 * tests/leaderboard-smoke.mjs — headless verification of sdk/game/leaderboard.js + sdk/net/score-packet.js (B6).
 * Node only, no DOM, no three.js: `node tests/leaderboard-smoke.mjs` from the repo root.
 *   [1] SCORE 0x31 codec: self check, 8-row round trip, <= 64 B per row, name cut on a code-point boundary, rejections
 *   [2] event -> table transitions: goal, catch streak (+ pass credit), plain pickup is not a catch, pass window, miss, potato drop, re-seating
 *   [3] ranking ties (standard competition ranking 1, 1, 3) and the tie-break order
 *   [4] host-only authority: broadcast after every change, client applies, stale packet keeps the newer one by seq, non-host
 *       packets rejected, the host never applies, seq wrap 65535 -> 0, becomeHost continues the seq, client transition events
 *   [5] round end: first to 5 goals (free), 180 s (free / potato, never practice), host end, Play again, draw
 *   [6] 2 s heartbeat cadence
 *   [7] render(): row order as HTML text (JSDOM-free), you / flame / escaping / empty state; cardHTML; roundLine
 *   [8] bindGame() on a fake BallGame EventTarget
 */
import assert from 'node:assert/strict';
import { encodeScore, decodeScore, scoreBytes, selfCheck, encodeName, PK_SCORE, SCORE_ROW_BUDGET_BYTES, SCORE_ROW_FIXED_BYTES, SCORE_NAME_MAX, SCORE_MAX_ROWS, ROUND, END_REASON, FLAG, readHeader } from '../sdk/net/score-packet.js';
import { Leaderboard, SCORE_RULES, rankRows, render, sectionHTML, cardHTML, roundLine, bindGame, escapeHtml, formatClock, emptyRow } from '../sdk/game/leaderboard.js';
import { RemoteHands } from '../sdk/net/remote-consumer.js';
import { PK } from '../sdk/game/ball-net.js';

let passed = 0, failed = 0;
function ok(cond, label, extra = '') { if (cond) { passed++; console.log('  ok   ' + label + (extra ? '  ' + extra : '')); } else { failed++; console.log('  FAIL ' + label + (extra ? '  ' + extra : '')); } }
function section(name) { console.log('\n[' + name + ']'); }
const clockAt = (t0 = 0) => { const c = { T: t0, now: () => c.T, tick: (dt) => { c.T += dt; return c.T; } }; return c; };
const ROSTER = [{ seat: 0, name: 'Kenny', clientId: 'c-a' }, { seat: 1, name: 'Bot-1', clientId: 'c-b' }, { seat: 2, name: 'Zoë', clientId: 'c-c' }];
const host = (o = {}) => { const c = clockAt(o.t0 || 0); const lb = new Leaderboard({ isHost: true, clock: c, ...o }); lb.setRoster(o.roster || ROSTER); return { lb, c }; };
const seats = html => [...html.matchAll(/data-seat="(\d+)"/g)].map(m => +m[1]);
const count = (target, type) => { let n = 0; target.addEventListener(type, () => n++); return () => n; };

// ─────────────────────────────────────────────────────────────────────────────
section('1 SCORE 0x31 codec');
const sc = selfCheck();
ok(sc.rows === 8 && sc.rowMax <= SCORE_ROW_BUDGET_BYTES, 'selfCheck: 8 rows, row max ' + sc.rowMax + ' B <= ' + SCORE_ROW_BUDGET_BYTES, `packet ${sc.bytes} B`);
const rows8 = Array.from({ length: 8 }, (_, i) => ({ seat: i, colour: (i * 2) % 9, goals: 5 - (i % 6), streak: i % 5, catches: 1000 * i + 7, passes: 65535 - i, potatoDrops: i % 4, name: ['Kenny', 'Bot-1', 'Zoë', '李雷', 'Émile', 'Hannah Zhao', 'Bot-7 (proxy)', 'x'.repeat(48)][i] }));
const table8 = { mode: 'potato', round: { state: ROUND.ENDED, reason: END_REASON.TIME, no: 12, goalsToWin: 5, winnerSeat: 3, startedAt: 123456789, roundMs: 180000 }, rows: rows8 };
const buf8 = encodeScore(table8, 4242, 987654321);
const d8 = decodeScore(buf8);
ok(readHeader(buf8).type === PK_SCORE && d8.seq === 4242 && d8.t === 987654321 && d8.fromHost === true, 'header: type 0x31, seq, t, FROM_HOST');
ok(d8.mode === 'potato' && d8.round.state === ROUND.ENDED && d8.round.reason === END_REASON.TIME && d8.round.no === 12 && d8.round.goalsToWin === 5 && d8.round.winnerSeat === 3 && d8.round.startedAt === 123456789 && d8.round.roundMs === 180000, 'table header round trip (mode, round state/reason/no/goalsToWin/winner/startedAt/roundMs)');
ok(d8.rows.length === 8 && d8.rows.every((r, i) => ['seat', 'colour', 'goals', 'streak', 'catches', 'passes', 'potatoDrops', 'name'].every(k => r[k] === rows8[i][k])), '8 rows round trip field by field (u16 catches/passes at the top of range)');
const rowBytes = rows8.map(r => SCORE_ROW_FIXED_BYTES + encodeName(r.name).byteLength);
ok(rowBytes.every(b => b <= SCORE_ROW_BUDGET_BYTES) && Math.max(...rowBytes) === SCORE_ROW_FIXED_BYTES + SCORE_NAME_MAX, 'every row <= 64 B (max ' + Math.max(...rowBytes) + ' B) and buffer size == scoreBytes', `${buf8.byteLength} B`);
ok(buf8.byteLength === scoreBytes(rows8), 'scoreBytes(rows) equals the encoded length');
const longName = '😀'.repeat(20) + 'tail';                                  // 4 B per emoji: 84 B → cut at 12 emoji (48 B)
const cut = decodeScore(encodeScore({ mode: 'free', round: {}, rows: [{ seat: 0, name: longName }] }, 1, 1)).rows[0].name;
ok(cut === '😀'.repeat(12) && encodeName(longName).byteLength === 48 && !cut.includes('�'), 'name over 48 B is cut on a code-point boundary (no torn surrogate)', JSON.stringify(cut.length));
const e0 = decodeScore(encodeScore({ mode: 'free', round: {}, rows: [] }, 7, 9)).rows.length;
ok(e0 === 0, 'empty table (0 rows) round trips');
const rows16 = Array.from({ length: SCORE_MAX_ROWS }, (_, i) => emptyRow(i, 'p' + i));
ok(decodeScore(encodeScore({ mode: 'free', round: {}, rows: rows16 }, 1, 1)).rows.length === 16, '16 rows accepted');
assert.throws(() => encodeScore({ mode: 'free', round: {}, rows: [...rows16, emptyRow(16)] }, 1, 1), RangeError); ok(true, '17 rows throws RangeError');
const notHost = decodeScore(encodeScore(table8, 1, 1, 0));
ok(notHost.fromHost === false, 'flags 0 decodes as fromHost:false (rejected later by Leaderboard.apply)');
const hsHeader = new ArrayBuffer(12); new DataView(hsHeader).setUint8(0, PK.HAND_STREAM); new DataView(hsHeader).setUint8(1, 1 << 4);
assert.throws(() => decodeScore(hsHeader), TypeError); ok(true, 'decodeScore rejects a HAND_STREAM header with TypeError');
assert.throws(() => decodeScore(buf8.slice(0, 40)), RangeError); ok(true, 'a truncated SCORE packet throws RangeError');
ok(new RemoteHands().onMessage(buf8) === false, 'RemoteHands.onMessage ignores 0x31 (returns false) — the demux stays one transport');

// ─────────────────────────────────────────────────────────────────────────────
section('2 event -> table transitions');
{
  const { lb, c } = host();
  const goals = count(lb, 'goal'), streaks = count(lb, 'streak'), bc = count(lb, 'broadcast');
  const before = bc();
  ok(lb.goal(0) === true && lb.rows.get(0).goals === 1 && lb.rows.get(0).streak === 1 && goals() === 1, 'goal(0): goals 1, streak 1, goal event', `broadcasts +${bc() - before}`);
  ok(bc() === before + 1, 'the host broadcasts once per change');
  // catch streak with pass credit: Bot-1 throws, Kenny's hold begins
  lb.throw(1, 0); ok(lb.observeHold(0, true) === true && lb.rows.get(0).catches === 1 && lb.rows.get(1).passes === 1 && lb.rows.get(0).streak === 2, 'throw(1→0) + hold begins on 0: catch for 0, pass for 1, streak 2');
  ok(lb.observeHold(0, true) === false && lb.rows.get(0).catches === 1, 'a held hand that stays held is not a second catch (edge detector)');
  lb.observeHold(0, false); lb.throw(1, -1); c.tick(500);
  ok(lb.observeHold(0, true) === true && lb.rows.get(0).streak === 3 && streaks() === 1, 'third consecutive success: streak 3 → streak event (flame)');
  lb.observeHold(0, false);
  ok(lb.observeHold(1, true) === false && lb.rows.get(1).catches === 0, 'a plain pickup with no pending pass is not a catch');
  lb.observeHold(1, false);
  lb.throw(0, 1); c.tick(SCORE_RULES.PASS_WINDOW_MS + 1);
  ok(lb.observeHold(1, true) === false && lb.rows.get(1).catches === 0, 'a hold ' + (SCORE_RULES.PASS_WINDOW_MS + 1) + ' ms after the LAUNCH is outside the pass window');
  lb.observeHold(1, false);
  lb.throw(0, 1); ok(lb.observeHold(2, true) === false && lb.rows.get(2).catches === 0, 'a LAUNCH toward seat 1 is not a catch when the hold begins on seat 2');
  lb.observeHold(2, false);
  ok(lb.miss(0) === true && lb.rows.get(0).streak === 0 && lb.rows.get(0).catches === 2 && lb.rows.get(0).goals === 1, 'miss(0): streak 0, catches (2) and goals (1) kept');
  const pd = lb.goal(2, { potato: true });
  ok(pd === true && lb.rows.get(2).potatoDrops === 1 && lb.rows.get(2).goals === 0 && goals() === 2, 'potato drop on 2: potatoDrops 1, goals unchanged, goal event {potato:true}');
  lb.catch(2); lb.catch(2); ok(lb.rows.get(2).streak === 2, 'streak rebuilds after the drop'); lb.goal(2, { potato: true }); ok(lb.rows.get(2).streak === 0, 'a potato drop resets the streak');
  ok(lb.drop(1) === true && lb.rows.get(1).streak === 0, 'drop(1) is accepted (no-op streak 0)');
  // re-seating keeps the stats with the clientId
  lb.setRoster([{ seat: 0, name: 'Bot-1', clientId: 'c-b' }, { seat: 1, name: 'Kenny', clientId: 'c-a' }, { seat: 2, name: 'Zoë', clientId: 'c-c' }]);
  ok(lb.rows.get(1).goals === 1 && lb.rows.get(1).catches === 2 && lb.rows.get(1).name === 'Kenny' && lb.rows.get(0).passes === 2 && lb.rows.get(0).name === 'Bot-1', 'setRoster re-seating: Kenny (c-a) keeps 1 goal / 2 catches at seat 1, Bot-1 keeps 2 passes at seat 0');
  lb.setRoster([{ seat: 0, name: 'Kenny', clientId: 'c-a' }]);
  ok(lb.rows.size === 1 && lb.rows.get(0).goals === 1, 'departed participants are dropped, the survivor keeps its stats');
  const client = new Leaderboard({ isHost: false, clock: c }); client.setRoster(ROSTER);
  ok(client.goal(0) === false && client.catch(0) === false && client.throw(0, 1) === false && client.startRound() === false && client.rows.get(0).goals === 0, 'a client never computes its own: goal/catch/throw/startRound return false and mutate nothing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('3 ranking ties');
{
  const r = (seat, name, goals, catches, passes = 0, potatoDrops = 0) => ({ ...emptyRow(seat, name), goals, catches, passes, potatoDrops });
  const ranked = rankRows([r(0, 'Kenny', 2, 1), r(1, 'Bot-1', 2, 1), r(2, 'Zoë', 1, 9), r(3, 'Amy', 2, 2), r(4, 'Nil', 0, 0)]);
  ok(ranked.map(x => x.seat).join() === '3,1,0,2,4', 'order: goals desc, then catches desc, then name (Bot-1 before Kenny)', ranked.map(x => x.name + ':' + x.rank).join(' '));
  ok(ranked.map(x => x.rank).join() === '1,2,2,4,5', 'ties share a rank; the next rank skips (1, 2, 2, 4, 5)');
  const tie = rankRows([r(0, 'B', 3, 3), r(1, 'A', 3, 3), r(2, 'C', 3, 3)]);
  ok(tie.every(x => x.rank === 1) && tie.map(x => x.name).join('') === 'ABC', 'three-way tie: all rank 1, alphabetical');
  const pot = rankRows([r(0, 'Drops', 0, 4, 0, 2), r(1, 'Clean', 0, 4, 0, 0), r(2, 'Passer', 0, 4, 3, 0)]);
  ok(pot.map(x => x.name).join() === 'Passer,Clean,Drops', 'equal catches: passes desc, then fewer potato drops win');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4 packet round trip + host-only authority');
{
  const c = clockAt(1000);
  const h = new Leaderboard({ isHost: true, clock: c }); h.setRoster(rows8.map(r => ({ seat: r.seat, name: r.name, clientId: 'id' + r.seat })));
  for (let i = 0; i < 3; i++) h.goal(1); h.goal(4); h.throw(1, 2); h.observeHold(2, true);
  const cl = new Leaderboard({ isHost: false, clock: c });
  const bytesA = h.packet();
  ok(bytesA.byteLength <= 24 + 8 * 64 && cl.apply(bytesA) === true && cl.rows.size === 8 && cl.rows.get(1).goals === 3 && cl.rows.get(4).goals === 1 && cl.rows.get(2).catches === 1 && cl.rows.get(1).passes === 1, 'client applies an 8-row host packet: table equal', `${bytesA.byteLength} B`);
  const strip = rows => rows.map(r => { const { clientId, ...rest } = r; return rest; });
  assert.deepStrictEqual(strip(cl.table().rows), strip(h.table().rows));
  ok(cl.table().rows.every(r => !('clientId' in r)), 'client table == host table (deepStrictEqual); no clientId key on the wire side');
  // broadcast after every change
  const bc = count(h, 'broadcast'); const n0 = bc(); h.goal(0); h.catch(0); h.miss(0); h.goal(3, { potato: true });
  ok(bc() - n0 === 4, 'four changes → four broadcast events (host)');
  // stale packet: apply B (newer) then A (older) → A rejected, B kept (h.goal broadcasts in between, so B is A + 2)
  const pA = h.packet(); h.goal(5); const pB = h.packet(); const seqA = readHeader(pA).seq, seqB = readHeader(pB).seq;
  ok(seqB === seqA + 2 && cl.apply(pB) === true && cl.rows.get(5).goals === 1, 'client applies B (seq ' + seqB + ')');
  ok(cl.apply(pA) === false && cl.rows.get(5).goals === 1 && cl.stats.rejectedStale === 1 && cl.lastSeq === seqB, 'stale A (seq ' + seqA + ') rejected; the newer table stays');
  ok(cl.apply(pB) === false && cl.stats.rejectedStale === 2, 'a duplicate of the current packet is stale too');
  const forged = encodeScore({ ...h.table(), rows: h.table().rows.map(r => ({ ...r, goals: 99 })) }, h.seq + 5, c.now(), 0);
  ok(cl.apply(forged) === false && cl.stats.rejectedNotHost === 1 && cl.rows.get(5).goals === 1, 'a packet without FROM_HOST is rejected even with a newer seq');
  ok(cl.apply(new ArrayBuffer(3)) === false && cl.stats.rejectedBad === 1, 'garbage is rejected as bad');
  ok(h.apply(pB) === false && h.stats.ignoredAsHost === 1 && h.rows.get(5).goals === 1, 'the host never applies a packet (authority stays local)');
  // seq wrap (the goal's own broadcast carries seq 0)
  let lastBytes = null; h.addEventListener('broadcast', e => { lastBytes = e.detail.bytes; });
  h.seq = 65535; const pW = h.packet(); h.goal(6); const p0 = lastBytes;
  ok(cl.apply(pW) === false && cl.stats.rejectedStale === 3, 'a client at seq ' + cl.lastSeq + ' treats 65535 as stale (wrap arithmetic, half-range rule)');
  const cw = new Leaderboard({ isHost: false, clock: c });                 // a fresh client for the wrap itself
  ok(readHeader(pW).seq === 65535 && readHeader(p0).seq === 0 && cw.apply(pW) === true && cw.apply(p0) === true && cw.lastSeq === 0 && cw.rows.get(6).goals === 1, 'seq wrap 65535 → 0 is accepted as newer');
  ok(cw.apply(pW) === false, 'and 65535 is stale after 0');
  // host migration
  cw.becomeHost();
  ok(cw.isHost && cw.seq === 1 && readHeader(cw.packet()).seq === 1, 'becomeHost continues the seq after the last applied one (1)');
  // client transition events
  const c2 = new Leaderboard({ isHost: false, clock: c }); const g2 = []; c2.addEventListener('goal', e => g2.push(e.detail.seat + (e.detail.potato ? 'p' : '')));
  const rounds = []; c2.addEventListener('round', e => rounds.push(e.detail.state)); const st = count(c2, 'streak');
  c2.apply(h.packet());
  ok(g2.length === 0 && st() === 0 && c2.rows.get(1).goals === 3 && c2.rows.get(6).goals === 1, 'a late joiner applies history silently (no goal / streak events for past goals)');
  h.goal(7); h.goal(7, { potato: true }); h.catch(7); h.catch(7); h.catch(7); c2.apply(h.packet());
  ok(g2.join() === '7,7p' && st() === 1, 'a client raises goal / potato / streak events from the packet diff', g2.join());
  h.startRound(); c2.apply(h.packet()); h.endRound(END_REASON.HOST); c2.apply(h.packet());
  ok(rounds.join() === 'live,ended', 'a client raises round live → ended from the packet', rounds.join());
}

// ─────────────────────────────────────────────────────────────────────────────
section('5 round end: 5 goals, 180 s, practice never, host end, play again, draw');
{
  const { lb, c } = host();
  const ev = []; lb.addEventListener('round', e => ev.push(e.detail.state + ':' + (e.detail.reason ?? '')));
  ok(lb.startRound() && lb.round.state === ROUND.LIVE && lb.round.no === 1 && lb.round.startedAt === c.now(), 'startRound: LIVE, round 1');
  for (let i = 0; i < 4; i++) lb.goal(1);
  ok(lb.round.state === ROUND.LIVE, '4 goals: still live');
  lb.goal(1);
  ok(lb.round.state === ROUND.ENDED && lb.round.reason === END_REASON.GOALS && lb.round.winnerSeat === 1 && ev.at(-1) === 'ended:' + END_REASON.GOALS, '5th goal: ENDED (GOALS), winner seat 1');
  ok(lb.goal(0) === false && lb.catch(0) === false && lb.rows.get(0).goals === 0, 'nothing counts after the final whistle');
  ok(lb.playAgain() && lb.round.state === ROUND.LIVE && lb.round.no === 2 && [...lb.rows.values()].every(r => r.goals + r.catches + r.passes + r.streak + r.potatoDrops === 0), 'playAgain: stats zeroed, round 2 live');
  // time limit
  const t0 = c.now();
  ok(lb.tick(t0 + SCORE_RULES.ROUND_MS - 1) !== undefined && lb.round.state === ROUND.LIVE, 'tick at 179 999 ms: still live');
  const sent = lb.tick(t0 + SCORE_RULES.ROUND_MS);
  ok(lb.round.state === ROUND.ENDED && lb.round.reason === END_REASON.TIME && sent && decodeScore(sent).round.state === ROUND.ENDED, 'tick at 180 000 ms: ENDED (TIME) and the tick returned the ENDED packet');
  ok(lb.round.winnerSeat === -1, 'no scores → no winner (draw)');
  // practice never ends, potato ends on time but not on goals
  const p = host({ mode: 'practice' }); p.lb.startRound(); const tp = p.c.now(); for (let i = 0; i < 7; i++) p.lb.goal(0); p.lb.tick(tp + 10 * 60 * 1000);
  ok(p.lb.round.state === ROUND.LIVE && p.lb.rows.get(0).goals === 7, 'practice: 7 goals and 10 minutes, still live');
  const q = host({ mode: 'potato' }); q.lb.startRound(); const tq = q.c.now(); for (let i = 0; i < 6; i++) q.lb.goal(0);
  ok(q.lb.round.state === ROUND.LIVE, 'potato: no goal limit'); q.lb.tick(tq + SCORE_RULES.ROUND_MS);
  ok(q.lb.round.state === ROUND.ENDED && q.lb.round.reason === END_REASON.TIME, 'potato: ends on the 3-minute limit');
  // host end + draw at the top
  const d = host(); d.lb.startRound(); d.lb.goal(0); d.lb.goal(1);
  ok(d.lb.endRound(END_REASON.HOST) && d.lb.round.reason === END_REASON.HOST && d.lb.round.winnerSeat === -1, 'host end with a tie at the top → draw');
  ok(d.lb.endRound() === false, 'endRound on an ended round is a no-op');
  const g = host({ goalsToWin: 2 }); g.lb.startRound(); g.lb.goal(2); g.lb.goal(2);
  ok(g.lb.round.state === ROUND.ENDED && g.lb.round.winnerSeat === 2, 'goalsToWin is configurable (2)');
  const lobby = host(); lobby.lb.goal(0);
  ok(lobby.lb.rows.get(0).goals === 1 && lobby.lb.round.state === ROUND.LOBBY, 'goals before startRound still count (lobby play)');
  ok(lobby.lb.resetScores() && lobby.lb.rows.get(0).goals === 0 && lobby.lb.round.state === ROUND.LOBBY, 'resetScores zeroes and returns to the lobby');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6 heartbeat every 2 s');
{
  const { lb, c } = host({ t0: 5000 });
  const sentAt = []; lb.addEventListener('broadcast', e => sentAt.push(c.now() + ':' + e.detail.reason));
  ok(lb.tick(5000) === null, 'the roster broadcast at 5000 counts: a tick at 5000 sends nothing');
  ok(lb.tick(6000) === null && lb.tick(6999) === null, 'ticks at +1000 / +1999: nothing');
  ok(lb.tick(7000) !== null, 'tick at +2000: heartbeat');
  c.T = 8500; lb.goal(1);               // a change at 8500 restarts the cadence
  ok(lb.tick(9000) === null && lb.tick(10499) === null && lb.tick(10500) !== null, 'a change restarts the 2 s cadence');
  ok(sentAt.filter(s => s.endsWith('heartbeat')).length === 2 && sentAt.filter(s => s.endsWith('goal')).length === 1, 'reasons: 2 heartbeats, 1 goal', sentAt.join(' '));
  const fresh = new Leaderboard({ isHost: true, clock: c });
  ok(fresh.tick(c.now()) !== null, 'a host that never broadcast sends on its first tick');
  const cl = new Leaderboard({ isHost: false, clock: c });
  ok(cl.tick(20000) === null, 'a client tick sends nothing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7 render(): row order as HTML (JSDOM-free), you / flame / escaping, card, round line');
{
  const { lb, c } = host({ roster: [{ seat: 0, name: 'Kenny <b>', clientId: 'c-a' }, { seat: 1, name: 'Bot-1', clientId: 'c-b' }, { seat: 2, name: 'Zoë', clientId: 'c-c' }, { seat: 3, name: 'Amy', clientId: 'c-d' }] });
  lb.startRound(); lb.goal(2); lb.goal(2); lb.goal(1); lb.goal(1); lb.catch(1); lb.goal(3); lb.catch(0); lb.catch(0); lb.catch(0);
  c.tick(66000);
  const state = lb.viewState({ meSeat: 0 });
  const el = { innerHTML: '' };
  const html = render(el, state);
  ok(el.innerHTML === html && html.length > 200, 'render(el, state) writes el.innerHTML and returns the HTML');
  ok(seats(html).join() === '1,2,3,0', 'row order: Bot-1 (2G 1C) > Zoë (2G) > Amy (1G) > Kenny (0G 3C)', seats(html).join());
  ok(/data-seat="1" data-rank="1"/.test(html) && /data-seat="2" data-rank="2"/.test(html) && /data-seat="0" data-rank="4"/.test(html), 'rank attributes 1, 2, 3, 4');
  ok(html.includes('Kenny &lt;b&gt;') && !html.includes('<b>'), 'names are HTML-escaped');
  ok(/data-seat="0"[^]*?lb__you/.test(html) && !/data-seat="1"[^]*?class="lb__you/.test(html.split('data-seat="2"')[0]), '"you" marker on my row only');
  ok(/data-seat="0"[^]*?lb__flame/.test(html) && !/data-seat="2"[^]*?lb__flame[^]*?data-seat="3"/.test(html), 'flame on the 3-streak row (Kenny), not on Zoë');
  ok(html.includes('--seat-color:var(--tw-seat-1)') && html.includes('lb__dot') && html.includes('lb__bar'), 'seat colour dot and bar per row');
  ok(html.includes('Round 1 · first to 5 · 01:54 left'), 'round line: Round 1 · first to 5 · 01:54 left', roundLine(state));
  ok(render(el, state) === html && el.innerHTML === html, 'render is idempotent (same HTML, no rewrite needed)');
  const empty = render(null, new Leaderboard({ isHost: true }).viewState());
  ok(empty.includes('lb__empty') && !empty.includes('<li'), 'empty state text, no rows');
  // card
  lb.goal(1); lb.goal(1); lb.goal(1);                                     // Bot-1 reaches 5 → ENDED
  const st2 = lb.viewState({ meSeat: 0 });
  const card = cardHTML(st2, { canPlayAgain: true });
  ok(lb.round.state === ROUND.ENDED && card.includes('Bot-1 wins') && card.includes('First to 5') && card.includes('Play again') && card.includes('lb-card__close'), 'card: "Bot-1 wins", reason, Play again / Close');
  ok(seats(card.replace(/style="[^"]*"/g, '')).length === 0 && [...card.matchAll(/lb__nm">([^<]+)</g)].map(m => m[1]).join() === 'Bot-1,Zoë,Amy,Kenny &lt;b&gt;', 'card ranking order equals the section order');
  ok(cardHTML(st2, { canPlayAgain: false }).includes('disabled'), 'Play again disabled for a non-host');
  ok(roundLine(st2) === 'Round 1 over · Bot-1 wins', 'round line after the whistle', roundLine(st2));
  ok(formatClock(0) === '00:00' && formatClock(65400) === '01:05' && formatClock(180000) === '03:00', 'formatClock');
  ok(escapeHtml(`<a href="x">'&'</a>`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;', 'escapeHtml covers & < > " \'');
  const pot = host({ mode: 'potato' }); pot.lb.goal(0, { potato: true }); pot.lb.catch(1);
  const ph = sectionHTML(pot.lb.viewState());
  ok(seats(ph).join() === '1,2,0' && ph.includes('lb__stat--drops'), 'potato mode: catches rank, drops shown, dropper last', seats(ph).join());
}

// ─────────────────────────────────────────────────────────────────────────────
section('8 bindGame on a fake BallGame');
{
  const c = clockAt(0);
  const game = new EventTarget(); game.net = { simSeat: 0 };
  const lb = new Leaderboard({ isHost: true, clock: c });
  const off = bindGame(lb, game);
  const fire = (type, detail) => game.dispatchEvent(new CustomEvent(type, { detail }));
  fire('seatmap', { map: { seats: [{ seat: 0, name: 'Kenny', clientId: 'c-a' }, { seat: 1, name: 'Bot-1', clientId: 'c-b' }] } });
  ok(lb.rows.size === 2 && lb.rows.get(1).name === 'Bot-1', 'seatmap → roster');
  fire('goal', { scorerSeat: 1, goalSeat: 0, potato: false, goalNo: 1 });
  ok(lb.rows.get(1).goals === 1, "'goal' → goals");
  fire('launch', { launch: { from: 1, to: 0 }, mine: false }); c.tick(300);
  ok(lb.observeHold(0, true) && lb.rows.get(0).catches === 1 && lb.rows.get(1).passes === 1, "'launch' + hold on the receiver → catch + pass");
  fire('ring', { seat: 0, kind: 'miss' });
  ok(lb.rows.get(0).streak === 0, "'ring' miss → streak reset");
  lb.catch(0); fire('release', { how: 'wrap', kind: 'drop', clamped: false, speedU: 0.1 });
  ok(lb.rows.get(0).streak === 0, "'release' drop (local seat) → streak reset");
  fire('goal', { scorerSeat: 0, potato: true, goalNo: 0x81 });
  ok(lb.rows.get(0).potatoDrops === 1, "'goal' with potato → potatoDrops");
  fire('mode', { mode: 'potato' });
  ok(lb.mode === 'potato', "'mode' → mode");
  off(); fire('goal', { scorerSeat: 1, potato: false });
  ok(lb.rows.get(1).goals === 1, 'unbind stops the listeners');
  // per-frame tick with heldOf
  const lb2 = new Leaderboard({ isHost: true, clock: c }); lb2.setRoster(ROSTER); lb2.throw(0, 1);
  let held = false; lb2.tick(c.now(), s => (s === 1 ? held : false)); held = true; lb2.tick(c.tick(16), s => (s === 1 ? held : false));
  ok(lb2.rows.get(1).catches === 1 && lb2.rows.get(0).passes === 1, 'tick(now, heldOf) samples holds and credits the catch');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
