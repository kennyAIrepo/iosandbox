/**
 * hand-stream.mjs — HAND_STREAM 0x30: the landmark relay packet (hopeos-wire.md §2). DOM-free, no three.js.
 * ─────────────────────────────────────────────────────────────────────────────
 * One packet = one tracked frame of ONE seat = exactly what that seat's PlayerPipeline emitted
 * (sdk/core/player-pipeline.js:175, :203-208): per screen slot ('left' / 'right', assigned by the SENDER's
 * pipeline from wrist x) 21 `img` points in the sender's SELFIE-MIRRORED normalised space and, when the
 * landmarker produced them, 21 raw metric `world` points. Nothing is flipped, filtered, or relabelled here —
 * the receiver runs its own hand-views.js `_chirality` / `_zSign` latches on the decoded points
 * (research/codebase/multi-person.md:40, :77-80).
 *
 * Shares the 8-byte header of ball-net.mjs (type u8, flags u8, seq u16, t u32 LE) through the exported
 * `writeHeader` / `readHeader`, so one `readHeader(buf).type` demux serves BallNet and RemoteHands on the
 * same transport (ball-net.mjs `_onPacket` ignores 0x30; remote-consumer.mjs ignores everything else).
 *
 * Byte layout (little-endian), v1:
 *   off 0-7   header: type 0x30, flags (bits 0-3 as ball-net FLAG, bits 4-7 PROTO_VER = 1), seq u16 (per sender,
 *             per stream — independent of BallNet's seq), t u32 = session-clock ms of the CAPTURE (hopeos-wire.md §5)
 *   off 8     seat u8              the sender's seat index in the SEAT_MAP (0..254; 255 = SEAT_NONE never sent)
 *   off 9     hflags u8            bit0 left present · bit1 right present · bit2 left has world · bit3 right has world
 *                                  bit4 POSE33 extension follows (RESERVED — must be 0 in v1; decoders reject it)
 *                                  bits 5-7 reserved 0
 *   off 10    hold u8              bits 0-1 hold mode {0 free, 1 cradle, 2 wrap, 3 clip}, bit 2 hold slot (0 left, 1 right)
 *                                  INFORMATIONAL (HUD / debugging) — BallNet's BALL_STATE.hold is the authority
 *   off 11    reserved u8          0
 *   off 12..  for each present slot in the order left, right:
 *               21 × (u, v, z) i16   img  × 32767, clamped to [-1, 1]   (126 B)
 *               21 × (x, y, z) i16   world in mm (× 1000), clamped to ±32.767 m   (126 B, only when the world bit is set)
 *
 * Sizes: no hands (heartbeat) 12 B · one hand 138 B (264 B with world) · two hands with world 516 B (≤ 600 B target).
 *
 * Quantisation (asserted by `selfCheck()` at module load and by wire-smoke.mjs):
 *   img   step 1/32767 = 3.05e-5, max abs error HS_IMG_ERR = 1.53e-5 image units (0.03 px at 1920 px; through
 *         hand-views.js mirrorPoint at mirrorDist 2 / 16:9 that is ≈ 0.05 mm of world position, 0.05 mm of depth).
 *         Range: u, v are [0, 1] in-frame; One-Euro prediction can overshoot, so [-1, 1] is representable and
 *         anything beyond clamps. z: MediaPipe hand z is x-normalised, wrist-relative (|z| < 0.5 in practice;
 *         player-pipeline.js:175 multiplies by the crop width, = 1 for fullFrame) — the same [-1, 1] range holds.
 *   world step 1 mm, max abs error HS_WORLD_ERR = 0.5 mm; MediaPipe hand world points are hand-centred metres
 *         (|xyz| < 0.25 m), so ±32.767 m never clamps. The palm-block chirality volume (hand-views.js:76-92)
 *         is ~(80 mm)³; a 0.5 mm error per point is < 2 % of it and cannot flip the latched sign.
 */
import { PK, FLAG, PROTO_VER, readHeader, writeHeader, seqNewer16, dt32 } from '../game/ball-net.js';

export { PK, FLAG, PROTO_VER, readHeader, seqNewer16, dt32 };

const LE = true;
export const HS = Object.freeze({ PRESENT_L: 1, PRESENT_R: 2, WORLD_L: 4, WORLD_R: 8, POSE33: 16 });
export const HS_HEADER_BYTES = 12;
export const HS_HAND_BYTES = 126;                 // 21 × 3 × i16
export const HS_MAX_BYTES = HS_HEADER_BYTES + 4 * HS_HAND_BYTES;   // 516: two hands, both with world
export const HS_BUDGET_BYTES = 600;               // the memo's budget (teams-pilot-plan.html "≈ 520–600 B")
export const HS_IMG_SCALE = 32767;
export const HS_WORLD_SCALE = 1000;               // metres → mm
export const HS_IMG_ERR = 0.5 / HS_IMG_SCALE;     // 1.526e-5 image units
export const HS_WORLD_ERR = 0.5 / HS_WORLD_SCALE; // 0.0005 m (bounds are checked with a 1e-12 float tolerance)
export const SLOTS = Object.freeze(['left', 'right']);

const clampI16 = v => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
const qImg = v => clampI16(Math.round((+v || 0) * HS_IMG_SCALE));
const qWorld = v => clampI16(Math.round((+v || 0) * HS_WORLD_SCALE));

function is21(a) { return Array.isArray(a) && a.length === 21; }

/** Bytes a packet for these hands will occupy (same rules as encodeHandStream). */
export function handStreamBytes(hands) {
  let n = HS_HEADER_BYTES;
  for (const s of SLOTS) {
    const h = hands && hands[s];
    if (!h || !is21(h.img)) continue;
    n += HS_HAND_BYTES;
    if (is21(h.world)) n += HS_HAND_BYTES;
  }
  return n;
}

/**
 * @param {number} seat      sender's seat index (0..254)
 * @param {{left:{img,world}|null, right:{img,world}|null}} hands   the PlayerPipeline / TilePipeline output, as is
 * @param {number} seq       per-sender u16 counter for THIS stream
 * @param {number} tMs       session-clock ms of the capture (clock.now() when detect() ran)
 * @param {{hold?:{mode:number, slot:number|string}, flags?:number}} o   hold is informational; flags = ball-net FLAG bits
 * @returns {ArrayBuffer}
 */
export function encodeHandStream(seat, hands, seq, tMs, { hold = null, flags = 0 } = {}) {
  if (!(seat >= 0 && seat <= 254)) throw new RangeError('seat must be 0..254');
  const buf = new ArrayBuffer(handStreamBytes(hands));
  const v = new DataView(buf);
  writeHeader(v, PK.HAND_STREAM, seq, tMs, flags);
  v.setUint8(8, seat);
  let hflags = 0, off = HS_HEADER_BYTES;
  for (let k = 0; k < 2; k++) {
    const h = hands && hands[SLOTS[k]];
    if (!h || !is21(h.img)) continue;
    hflags |= k === 0 ? HS.PRESENT_L : HS.PRESENT_R;
    const img = h.img;
    for (let i = 0; i < 21; i++, off += 6) {
      v.setInt16(off, qImg(img[i].x), LE); v.setInt16(off + 2, qImg(img[i].y), LE); v.setInt16(off + 4, qImg(img[i].z), LE);
    }
    if (is21(h.world)) {
      hflags |= k === 0 ? HS.WORLD_L : HS.WORLD_R;
      const w = h.world;
      for (let i = 0; i < 21; i++, off += 6) {
        v.setInt16(off, qWorld(w[i].x), LE); v.setInt16(off + 2, qWorld(w[i].y), LE); v.setInt16(off + 4, qWorld(w[i].z), LE);
      }
    }
  }
  v.setUint8(9, hflags);
  const hm = hold ? (hold.mode & 3) : 0;
  const hs = hold ? ((hold.slot === 'right' || hold.slot === 1) ? 1 : 0) : 0;
  v.setUint8(10, hm | (hs << 2));
  v.setUint8(11, 0);
  return buf;
}

/**
 * @param {ArrayBuffer} buf
 * @param {{out?:object}} o   optional reusable output (allocated once by RemoteSeat) — see remote-consumer.mjs
 * @returns {{type, flags, ver, seq, t, seat, hflags, hold:{mode,slot}, hands:{left,right}, byteLength}}
 *   hands[slot] = { img: 21×{x,y,z}, world: 21×{x,y,z}|null } | null — the PlayerPipeline shape, untouched.
 */
export function decodeHandStream(buf, { out = null } = {}) {
  if (!(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const hd = readHeader(buf);
  if (hd.type !== PK.HAND_STREAM) throw new TypeError('not a HAND_STREAM packet: type 0x' + hd.type.toString(16));
  if (hd.ver !== PROTO_VER) throw new TypeError('HAND_STREAM protocol version ' + hd.ver + ' (expected ' + PROTO_VER + ')');
  const v = new DataView(buf);
  const seat = v.getUint8(8), hflags = v.getUint8(9), hb = v.getUint8(10);
  if (hflags & HS.POSE33) throw new TypeError('HAND_STREAM POSE33 extension is reserved in v1');
  const r = out || { hands: { left: null, right: null }, _b: { left: null, right: null } };
  Object.assign(r, hd, { seat, hflags, hold: { mode: hb & 3, slot: (hb >> 2) & 1 }, byteLength: buf.byteLength });
  let off = HS_HEADER_BYTES;
  for (let k = 0; k < 2; k++) {
    const slot = SLOTS[k];
    const present = hflags & (k === 0 ? HS.PRESENT_L : HS.PRESENT_R);
    if (!present) { r.hands[slot] = null; continue; }
    if (off + HS_HAND_BYTES > buf.byteLength) throw new RangeError('HAND_STREAM truncated');
    let hb2 = r._b[slot];
    if (!hb2) hb2 = r._b[slot] = { img: fresh21(), world: fresh21(), _w: null };
    const img = hb2.img;
    for (let i = 0; i < 21; i++, off += 6) {
      img[i].x = v.getInt16(off, LE) / HS_IMG_SCALE; img[i].y = v.getInt16(off + 2, LE) / HS_IMG_SCALE; img[i].z = v.getInt16(off + 4, LE) / HS_IMG_SCALE;
    }
    const hasWorld = hflags & (k === 0 ? HS.WORLD_L : HS.WORLD_R);
    if (hasWorld) {
      if (off + HS_HAND_BYTES > buf.byteLength) throw new RangeError('HAND_STREAM truncated (world)');
      const w = hb2.world;
      for (let i = 0; i < 21; i++, off += 6) {
        w[i].x = v.getInt16(off, LE) / HS_WORLD_SCALE; w[i].y = v.getInt16(off + 2, LE) / HS_WORLD_SCALE; w[i].z = v.getInt16(off + 4, LE) / HS_WORLD_SCALE;
      }
    }
    r.hands[slot] = { img, world: hasWorld ? hb2.world : null };
  }
  return r;
}
function fresh21() { const a = new Array(21); for (let i = 0; i < 21; i++) a[i] = { x: 0, y: 0, z: 0 }; return a; }

// ── BroadcastChannel('hopeos-room') envelope (hopeos-wire.md §6) ────────────
// The frozen page already posts { v:1, kind:'presence', ... } on this channel (mpbrowser.html:850, :3266, :4290).
// Binary wire packets ride the SAME channel as { v:1, kind:'wire', from, reliable, bytes:ArrayBuffer } — structured
// clone carries the ArrayBuffer; presence listeners ignore kind 'wire' and wire listeners ignore everything else.
export const ROOM_CHANNEL = 'hopeos-room';
export function wrapRoom(from, bytes, reliable = false) { return { v: 1, kind: 'wire', from, reliable, bytes }; }
/** @returns {ArrayBuffer|null} the packet bytes, or null when the message is not ours (other kind, other version, own echo) */
export function unwrapRoom(data, myId = null) {
  if (!data || data.v !== 1 || data.kind !== 'wire' || !(data.bytes instanceof ArrayBuffer)) return null;
  if (myId !== null && data.from === myId) return null;
  return data.bytes;
}

// ── base64 for JSON-only transports (Live Share LiveEvent / LiveState) ───────
export function bytesToB64(buf) {
  const u8 = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u8.length; i += 0x2000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
  return (typeof btoa === 'function') ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}
export function b64ToBytes(b64) {
  const s = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const buf = new ArrayBuffer(s.length), u8 = new Uint8Array(buf);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return buf;
}

// ── self check: header round trip through the SHARED reader, quantisation bounds ──
export function selfCheck() {
  const pts = (f) => Array.from({ length: 21 }, (_, i) => ({ x: f(i, 0), y: f(i, 1), z: f(i, 2) }));
  const img = pts((i, c) => 0.05 + (i * 7 + c * 3) % 21 / 21 * 0.9 - (c === 2 ? 0.5 : 0));
  const world = pts((i, c) => ((i * 5 + c) % 21 - 10) * 0.0123);
  const img2 = pts((i, c) => 0.02 + (i * 11 + c * 5) % 21 / 21 * 0.93 - (c === 2 ? 0.4 : 0));   // a second, independent hand
  const hands = { left: { img, world }, right: { img: img2, world: null } };
  const buf = encodeHandStream(7, hands, 65535, 4000000000, { hold: { mode: 2, slot: 'right' }, flags: FLAG.FROM_HOST });
  const hd = readHeader(buf);
  if (hd.type !== PK.HAND_STREAM || hd.seq !== 65535 || hd.t !== 4000000000 || hd.ver !== PROTO_VER || hd.flags !== FLAG.FROM_HOST) throw new Error('hand-stream: header round trip through ball-net.readHeader failed');
  if (buf.byteLength !== HS_HEADER_BYTES + 3 * HS_HAND_BYTES) throw new Error('hand-stream: unexpected size ' + buf.byteLength);
  const d = decodeHandStream(buf);
  if (d.seat !== 7 || d.hold.mode !== 2 || d.hold.slot !== 1 || !d.hands.left || !d.hands.right || d.hands.right.world !== null) throw new Error('hand-stream: fields');
  let eImg = 0, eWorld = 0;
  for (let i = 0; i < 21; i++) for (const c of ['x', 'y', 'z']) {
    eImg = Math.max(eImg, Math.abs(d.hands.left.img[i][c] - img[i][c]), Math.abs(d.hands.right.img[i][c] - hands.right.img[i][c]));
    eWorld = Math.max(eWorld, Math.abs(d.hands.left.world[i][c] - world[i][c]));
  }
  if (!(eImg <= HS_IMG_ERR + 1e-12)) throw new Error('hand-stream: img quantisation error ' + eImg + ' > ' + HS_IMG_ERR);
  if (!(eWorld <= HS_WORLD_ERR + 1e-12)) throw new Error('hand-stream: world quantisation error ' + eWorld + ' > ' + HS_WORLD_ERR);
  if (HS_MAX_BYTES > HS_BUDGET_BYTES) throw new Error('hand-stream: over budget');
  return { bytes: buf.byteLength, maxBytes: HS_MAX_BYTES, imgErr: eImg, worldErr: eWorld };
}
selfCheck();

// ── REACTION 0x32 (18 B; legacy 16 B): one gesture reaction event, sender → everyone (sdk/game/gesture-reactions.js) ──
// 0x30 is HAND_STREAM (above) and 0x31 is the reserved POSE33 extension (twin-ui.js:139, hopeos-wire.md §2), so the
// reaction packet takes the next free code. No existing layout changes; BallNet, RemoteHands and Room already fall
// through on unknown types (ball-net.js:458 `default:`, remote-consumer.js:140 type check, room.js:247).
// Byte layout (little-endian), v1:
//   off 0-7   header: type 0x32, flags|ver, seq u16 (per sender, per stream), t u32 = session-clock ms when SENT
//   off 8     kind u8       RX_KIND code: 1 raise · 2 applause · 3 like · 4 wave · 5 love · 6 laugh · 7 surprised
//   off 9     seat u8       the sender's seat index (0..254)
//   off 10    state u8      bit0 = on (raise: 1 raised / 0 lowered; other kinds always 1) · bit1 = slot (0 left, 1 right)
//                           · bit2 = origin present (v1.1) · bits 3-7 reserved 0
//   off 11    reserved u8   0
//   off 12    ts u32        session-clock ms of the DETECTION (the frame the gesture completed; header t is the send time)
//   off 16    origin x u8   v1.1 (2026-09-21): the gesture's landmark in TILE-NORMALISED coordinates x 255 (0..1 -> 0..255,
//   off 17    origin y u8   y down; step 1/255 = 0.4 % of the tile, ~2 px at 480 px). Present only when state bit2 is set;
//                           a legacy 16 B packet (no bytes 16-17) or bit2 clear decodes as origin = null.
// Rate: at most one per kind per 3 s per sender (the detector's cooldown), sent reliable=true when the transport has it.
export const PK_REACTION = 0x32;
export const RX_BYTES = 18;              // what encodeReaction writes (v1.1: origin appended)
export const RX_BYTES_LEGACY = 16;       // the shortest packet decodeReaction accepts (pre-origin senders)
export const RX_ORIGIN_STEP = 1 / 255;   // origin quantisation (max abs error RX_ORIGIN_STEP / 2 of the tile)
const RX_ORIGIN_BIT = 4;
export const RX_KIND = Object.freeze({ raise: 1, applause: 2, like: 3, wave: 4, love: 5, laugh: 6, surprised: 7 });
export const RX_KIND_NAME = Object.freeze(['', 'raise', 'applause', 'like', 'wave', 'love', 'laugh', 'surprised']);

/**
 * @param {number} seat   sender's seat index (0..254)
 * @param {number|string} kind   RX_KIND code or name
 * @param {number} tsMs   session-clock ms of the detection
 * @param {number} seq    per-sender u16 counter for THIS stream
 * @param {number} tMs    session-clock ms now (send time)
 * @param {{on?:boolean, slot?:number|string, flags?:number, origin?:{x:number,y:number}|null}} o
 *        origin = the gesture's landmark in tile-normalised coordinates (0..1, y down; gesture-reactions.js ev.origin);
 *        null / missing = no origin (the receiver floats from the tile's bottom-left)
 * @returns {ArrayBuffer} 18 bytes
 */
export function encodeReaction(seat, kind, tsMs, seq, tMs, { on = true, slot = 0, flags = 0, origin = null } = {}) {
  if (!(seat >= 0 && seat <= 254)) throw new RangeError('seat must be 0..254');
  const code = typeof kind === 'string' ? RX_KIND[kind] : kind;
  if (!(code >= 1 && code <= 255)) throw new RangeError('unknown reaction kind ' + kind);
  const buf = new ArrayBuffer(RX_BYTES), v = new DataView(buf);
  writeHeader(v, PK_REACTION, seq, tMs, flags);
  v.setUint8(8, code);
  v.setUint8(9, seat);
  const sl = (slot === 'right' || slot === 1) ? 1 : 0;
  const hasOrigin = !!origin && Number.isFinite(origin.x) && Number.isFinite(origin.y);
  v.setUint8(10, (on ? 1 : 0) | (sl << 1) | (hasOrigin ? RX_ORIGIN_BIT : 0));
  v.setUint8(11, 0);
  v.setUint32(12, (+tsMs || 0) >>> 0, LE);
  v.setUint8(16, hasOrigin ? q255(origin.x) : 0);
  v.setUint8(17, hasOrigin ? q255(origin.y) : 0);
  return buf;
}
function q255(x) { return Math.round(Math.min(1, Math.max(0, x)) * 255); }

/**
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @param {{out?:object}} o   optional reusable output object
 * @returns {{type, flags, ver, seq, t, kind:number, name:string, seat:number, on:boolean, slot:0|1, ts:number, origin:{x:number,y:number}|null, byteLength:number}}
 *          origin = tile-normalised { x, y } (0..1) when the sender wrote one; null for a legacy 16 B packet or a sender without one
 */
export function decodeReaction(buf, { out = null } = {}) {
  if (!(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const hd = readHeader(buf);
  if (hd.type !== PK_REACTION) throw new TypeError('not a REACTION packet: type 0x' + hd.type.toString(16));
  if (hd.ver !== PROTO_VER) throw new TypeError('REACTION protocol version ' + hd.ver + ' (expected ' + PROTO_VER + ')');
  if (buf.byteLength < RX_BYTES_LEGACY) throw new RangeError('REACTION truncated');
  const v = new DataView(buf), st = v.getUint8(10), kind = v.getUint8(8);
  const hasOrigin = (st & RX_ORIGIN_BIT) !== 0 && buf.byteLength >= RX_BYTES;
  const r = out || {};
  Object.assign(r, hd, { kind, name: RX_KIND_NAME[kind] || ('kind' + kind), seat: v.getUint8(9), on: (st & 1) === 1, slot: (st >> 1) & 1, ts: v.getUint32(12, LE),
    origin: hasOrigin ? { x: v.getUint8(16) / 255, y: v.getUint8(17) / 255 } : null, byteLength: buf.byteLength });
  return r;
}

/** Round trip + demux check for the reaction packet (runs at module load like selfCheck()). */
export function selfCheckReaction() {
  const buf = encodeReaction(3, 'raise', 123456789, 41, 123456999, { on: false, slot: 'right', flags: FLAG.FROM_HOST });
  if (buf.byteLength !== RX_BYTES) throw new Error('reaction: size ' + buf.byteLength);
  const hd = readHeader(buf);
  if (hd.type !== PK_REACTION || hd.seq !== 41 || hd.t !== 123456999 || hd.flags !== FLAG.FROM_HOST) throw new Error('reaction: header');
  const d = decodeReaction(buf);
  if (d.kind !== RX_KIND.raise || d.name !== 'raise' || d.seat !== 3 || d.on !== false || d.slot !== 1 || d.ts !== 123456789) throw new Error('reaction: fields');
  if (d.origin !== null) throw new Error('reaction: no origin given must decode as null');
  let threw = false; try { decodeHandStream(buf); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) throw new Error('reaction: decodeHandStream must reject a REACTION packet');
  // origin round trip (<= half a step) + legacy 16 B decode
  const o = decodeReaction(encodeReaction(1, 'love', 1, 2, 3, { origin: { x: 0.25, y: 0.8 } })).origin;
  if (!o || Math.abs(o.x - 0.25) > RX_ORIGIN_STEP / 2 + 1e-12 || Math.abs(o.y - 0.8) > RX_ORIGIN_STEP / 2 + 1e-12) throw new Error('reaction: origin round trip');
  const legacy = decodeReaction(buf.slice(0, RX_BYTES_LEGACY));
  if (legacy.byteLength !== RX_BYTES_LEGACY || legacy.origin !== null || legacy.name !== 'raise') throw new Error('reaction: legacy decode');
  return { bytes: buf.byteLength };
}
selfCheckReaction();
