/**
 * score-packet.js — SCORE 0x31: the host's authoritative leaderboard table, one packet = the WHOLE table.
 * DOM-free, no three.js, never reads the wall clock (CONTRACTS [F1]); shares the 8-byte wire header of ball-net.js so the
 * same `readHeader(buf).type` demux serves BallNet, Room, RemoteHands and the Leaderboard on one transport
 * (BallNet `_onPacket` default: ignores 0x31; Room only reads 0x01/0x21; RemoteHands only 0x30).
 *
 * Authority (CONTRACTS §7 style): only the HOST sends SCORE, always with FLAG.FROM_HOST; every client keeps the
 * newest table by `seqNewer16` and never computes its own (sdk/game/leaderboard.js `Leaderboard.apply`).
 * Sent reliably after every change and every 2 s as a heartbeat (a late joiner gets the table within 2 s).
 *
 * Byte layout (little-endian), v1:
 *   off 0-7   header: type 0x31, flags (bit 0 FROM_HOST — receivers DROP the packet without it), seq u16 (the host's
 *             SCORE counter, independent of BallNet's), t u32 = session-clock ms of the change
 *   off 8     ver u8 = 1
 *   off 9     nRows u8 (0..16)
 *   off 10    mode u8 {0 free, 1 potato, 2 practice}
 *   off 11    round u8: bits 0-1 state {0 lobby, 1 live, 2 ended}, bits 2-3 end reason {0 none, 1 goals, 2 time, 3 host}
 *   off 12    roundNo u8
 *   off 13    goalsToWin u8 (0 = no goal limit)
 *   off 14    winnerSeat u8 (255 = none / draw)
 *   off 15    reserved 0
 *   off 16    roundStartedAt u32 session-clock ms (0 = not started)
 *   off 20    roundMs u32 time limit in ms (0 = none)
 *   off 24..  rows, each: seat u8, colour u8, goals u8, streak u8, catches u16, passes u16, potatoDrops u8, nameLen u8,
 *             name UTF-8 (nameLen <= SCORE_NAME_MAX = 48 bytes, cut on a code-point boundary)
 *             -> 10 + 48 = 58 B <= the 64 B per-row budget; 8 rows <= 488 B, 16 rows <= 952 B.
 */
import { PK, FLAG, PROTO_VER, readHeader, writeHeader, seqNewer16, dt32 } from '../game/ball-net.js';

export { FLAG, PROTO_VER, readHeader, seqNewer16, dt32 };

export const PK_SCORE = 0x31;                       // not in ball-net.js PK (that file is frozen for this task); BallNet ignores it
export const SCORE_VER = 1;
export const SCORE_HEADER_BYTES = 24;               // 8 wire header + 16 table header
export const SCORE_ROW_FIXED_BYTES = 10;
export const SCORE_NAME_MAX = 48;                   // UTF-8 bytes
export const SCORE_ROW_MAX_BYTES = SCORE_ROW_FIXED_BYTES + SCORE_NAME_MAX;   // 58
export const SCORE_ROW_BUDGET_BYTES = 64;           // the task's per-row budget
export const SCORE_MAX_ROWS = 16;
export const SEAT_NONE = 0xff;

export const MODE_CODE = Object.freeze({ free: 0, potato: 1, practice: 2 });
export const MODE_NAME = Object.freeze(['free', 'potato', 'practice']);
export const ROUND = Object.freeze({ LOBBY: 0, LIVE: 1, ENDED: 2 });
export const END_REASON = Object.freeze({ NONE: 0, GOALS: 1, TIME: 2, HOST: 3 });

const LE = true;
let _enc = null, _dec = null;
const enc = () => _enc || (_enc = new TextEncoder());
const dec = () => _dec || (_dec = new TextDecoder());
const u8 = v => Math.max(0, Math.min(255, Math.round(+v || 0)));
const u16 = v => Math.max(0, Math.min(65535, Math.round(+v || 0)));
const u32 = v => ((+v || 0) >>> 0);

/** UTF-8 bytes of `name` cut to <= SCORE_NAME_MAX on a code-point boundary (never a torn surrogate / multibyte char). */
export function encodeName(name) {
  let s = String(name ?? '');
  let b = enc().encode(s);
  while (b.byteLength > SCORE_NAME_MAX) {
    // drop one code point (surrogate pairs are one code point) and re-encode
    const cps = Array.from(s); cps.pop(); s = cps.join(''); b = enc().encode(s);
  }
  return b;
}

/** Bytes a SCORE packet for these rows will occupy (same rules as encodeScore). */
export function scoreBytes(rows) {
  let n = SCORE_HEADER_BYTES;
  for (const r of rows || []) n += SCORE_ROW_FIXED_BYTES + encodeName(r.name).byteLength;
  return n;
}

const modeCode = m => (typeof m === 'number' ? (m & 3) : (MODE_CODE[m] ?? 0));

/**
 * @param {{mode, round:{state,reason,no,goalsToWin,winnerSeat,startedAt,roundMs}, rows:[{seat,colour,goals,streak,catches,passes,potatoDrops,name}]}} table
 * @param {number} seq   the host's u16 SCORE counter
 * @param {number} tMs   session-clock ms
 * @param {number} flags ball-net FLAG bits; the host always sends FROM_HOST (default)
 * @returns {ArrayBuffer}
 */
export function encodeScore(table, seq, tMs, flags = FLAG.FROM_HOST) {
  const rows = (table.rows || []).slice(0, SCORE_MAX_ROWS);
  if ((table.rows || []).length > SCORE_MAX_ROWS) throw new RangeError('SCORE: more than ' + SCORE_MAX_ROWS + ' rows');
  const names = rows.map(r => encodeName(r.name));
  let size = SCORE_HEADER_BYTES; for (const b of names) size += SCORE_ROW_FIXED_BYTES + b.byteLength;
  const buf = new ArrayBuffer(size), v = new DataView(buf), bytes = new Uint8Array(buf);
  writeHeader(v, PK_SCORE, seq, tMs, flags);
  const rd = table.round || {};
  v.setUint8(8, SCORE_VER);
  v.setUint8(9, rows.length);
  v.setUint8(10, modeCode(table.mode));
  v.setUint8(11, ((rd.state ?? ROUND.LOBBY) & 3) | (((rd.reason ?? END_REASON.NONE) & 3) << 2));
  v.setUint8(12, u8(rd.no));
  v.setUint8(13, u8(rd.goalsToWin));
  v.setUint8(14, rd.winnerSeat == null || rd.winnerSeat < 0 ? SEAT_NONE : u8(rd.winnerSeat));
  v.setUint8(15, 0);
  v.setUint32(16, u32(rd.startedAt), LE);
  v.setUint32(20, u32(rd.roundMs), LE);
  let off = SCORE_HEADER_BYTES;
  rows.forEach((r, i) => {
    const nb = names[i];
    v.setUint8(off, u8(r.seat)); v.setUint8(off + 1, u8(r.colour)); v.setUint8(off + 2, u8(r.goals)); v.setUint8(off + 3, u8(r.streak));
    v.setUint16(off + 4, u16(r.catches), LE); v.setUint16(off + 6, u16(r.passes), LE);
    v.setUint8(off + 8, u8(r.potatoDrops)); v.setUint8(off + 9, nb.byteLength);
    bytes.set(nb, off + SCORE_ROW_FIXED_BYTES);
    off += SCORE_ROW_FIXED_BYTES + nb.byteLength;
  });
  return buf;
}

/** True when `buf` carries a SCORE header (type only; call decodeScore for validation). */
export function isScorePacket(buf) {
  if (!buf || buf.byteLength < 8) return false;
  return new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer).getUint8(0) === PK_SCORE;
}

/**
 * @param {ArrayBuffer} buf
 * @returns {{type, flags, ver, seq, t, fromHost:boolean, mode:string, round:{state,reason,no,goalsToWin,winnerSeat,startedAt,roundMs}, rows:[], byteLength}}
 */
export function decodeScore(buf) {
  if (!(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (buf.byteLength < 8) throw new RangeError('SCORE: shorter than the wire header');
  const hd = readHeader(buf);
  if (hd.type !== PK_SCORE) throw new TypeError('not a SCORE packet: type 0x' + hd.type.toString(16));
  if (hd.ver !== PROTO_VER) throw new TypeError('SCORE wire version ' + hd.ver + ' (expected ' + PROTO_VER + ')');
  if (buf.byteLength < SCORE_HEADER_BYTES) throw new RangeError('SCORE truncated header');
  const v = new DataView(buf);
  const ver = v.getUint8(8);
  if (ver !== SCORE_VER) throw new TypeError('SCORE table version ' + ver + ' (expected ' + SCORE_VER + ')');
  const n = v.getUint8(9), rb = v.getUint8(11), winner = v.getUint8(14);
  const out = {
    ...hd, fromHost: !!(hd.flags & FLAG.FROM_HOST), tableVer: ver,
    mode: MODE_NAME[v.getUint8(10)] || 'free',
    round: { state: rb & 3, reason: (rb >> 2) & 3, no: v.getUint8(12), goalsToWin: v.getUint8(13), winnerSeat: winner === SEAT_NONE ? -1 : winner,
      startedAt: v.getUint32(16, LE), roundMs: v.getUint32(20, LE) },
    rows: [], byteLength: buf.byteLength,
  };
  let off = SCORE_HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    if (off + SCORE_ROW_FIXED_BYTES > buf.byteLength) throw new RangeError('SCORE truncated row ' + i);
    const nl = v.getUint8(off + 9);
    if (nl > SCORE_NAME_MAX || off + SCORE_ROW_FIXED_BYTES + nl > buf.byteLength) throw new RangeError('SCORE truncated name ' + i);
    out.rows.push({
      seat: v.getUint8(off), colour: v.getUint8(off + 1), goals: v.getUint8(off + 2), streak: v.getUint8(off + 3),
      catches: v.getUint16(off + 4, LE), passes: v.getUint16(off + 6, LE), potatoDrops: v.getUint8(off + 8),
      name: dec().decode(new Uint8Array(buf, off + SCORE_ROW_FIXED_BYTES, nl)),
    });
    off += SCORE_ROW_FIXED_BYTES + nl;
  }
  return out;
}

// ── self check: round trip through the SHARED header reader, name cut on a code-point boundary, row budget ──
export function selfCheck() {
  const rows = Array.from({ length: 8 }, (_, i) => ({ seat: i, colour: i % 9, goals: i * 3 % 7, streak: i % 4, catches: 300 + i, passes: 60000 + i, potatoDrops: i % 3, name: ['Kenny', 'Bot-1', 'Zoë', '李雷', 'Émile', 'x'.repeat(60), '😀😀😀😀😀😀😀😀😀😀😀', 'Hannah Z'][i] }));
  const table = { mode: 'free', round: { state: ROUND.LIVE, reason: END_REASON.NONE, no: 3, goalsToWin: 5, winnerSeat: -1, startedAt: 4000000000, roundMs: 180000 }, rows };
  const buf = encodeScore(table, 65535, 4000000123);
  const hd = readHeader(buf);
  if (hd.type !== PK_SCORE || hd.seq !== 65535 || hd.t !== 4000000123 || hd.ver !== PROTO_VER || hd.flags !== FLAG.FROM_HOST) throw new Error('score-packet: header round trip failed');
  if (buf.byteLength !== scoreBytes(rows)) throw new Error('score-packet: size ' + buf.byteLength + ' != ' + scoreBytes(rows));
  const d = decodeScore(buf);
  if (d.rows.length !== 8 || d.mode !== 'free' || d.round.no !== 3 || d.round.state !== ROUND.LIVE || d.round.winnerSeat !== -1 || d.round.startedAt !== 4000000000 || d.round.roundMs !== 180000) throw new Error('score-packet: table header');
  for (let i = 0; i < 8; i++) {
    const a = rows[i], b = d.rows[i];
    for (const k of ['seat', 'colour', 'goals', 'streak', 'catches', 'passes', 'potatoDrops']) if (a[k] !== b[k]) throw new Error('score-packet: row ' + i + ' field ' + k);
    const rowBytes = SCORE_ROW_FIXED_BYTES + encodeName(a.name).byteLength;
    if (rowBytes > SCORE_ROW_BUDGET_BYTES) throw new Error('score-packet: row ' + i + ' is ' + rowBytes + ' B > ' + SCORE_ROW_BUDGET_BYTES);
    if (i < 5 || i === 7) { if (a.name !== b.name) throw new Error('score-packet: name ' + i); }
    else if (!a.name.startsWith(b.name) || b.name.length === 0 || encodeName(a.name).byteLength > SCORE_NAME_MAX) throw new Error('score-packet: long name cut ' + i);
  }
  if (d.rows[6].name.includes('�')) throw new Error('score-packet: emoji name torn');
  return { bytes: buf.byteLength, rows: 8, rowMax: SCORE_ROW_MAX_BYTES };
}
selfCheck();
