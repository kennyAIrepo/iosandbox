/**
 * room-link.js — link-based multi-user: room codes, invite URLs, relay resolution, QR codes.
 * ─────────────────────────────────────────────────────────────────────────────
 * Node-safe (no top-level DOM); every browser-only path checks for `document` / `location`.
 *
 *   makeRoomCode()                 -> 'KRT7Q'-style 5 uppercase letters, no I / L / O (ambiguous with 1 / 0)
 *   parseRoomFromUrl(url?)         -> room from ?room=, /join/<code>, or #room= (that precedence); null when absent
 *   normalizeRoomCode(s)           -> 'abcde ' -> 'ABCDE' (5-letter codes are case-insensitive; named rooms keep their case)
 *   buildInviteUrl({room, relay?, origin?, pretty?})
 *                                  -> https://<vercel-domain>/join/<CODE>   (vercel.json rewrites /join/:room -> /teamslab.html)
 *                                     http://localhost:3333/teamslab.html?room=<CODE>   (the dev server has no rewrites)
 *                                     + ?relay=<url> only when it differs from RELAY_DEFAULT
 *   resolveRelay(url?)             -> relay base URL: ?relay= -> RELAY_DEFAULT -> ws://localhost:8787 (console.warn once)
 *   resolveRelayInfo(url?)         -> { relay, source: 'query' | 'default' | 'loopback' }
 *   roomWsUrl(relay, room)         -> `${relay}/room/${room}` (unchanged when the relay already names a room)
 *   makeQrDataUrl(text, opts?)     -> Promise<string|null>: PNG data URL from the `qrcode` UMD on cdnjs, lazily loaded;
 *                                     null (caller shows the text link) when the CDN is blocked, in Node, or on any error
 *
 * RELAY_DEFAULT: the hosted relay (tools/relay_modal.py, `py -m modal deploy tools/relay_modal.py`). '' means "not
 * deployed": resolveRelay then warns and falls back to the laptop relay (`npm run relay`).
 *
 * qrcode CDN path verified 2026-09-20: cdnjs lists `qrcode` 1.5.4 with NO files (api.cdnjs.com/libraries/qrcode ->
 * "files": []) and https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.5.4/qrcode.min.js is a 404; 1.5.1 is the newest
 * cdnjs build with files (qrcode.js, qrcode.min.js) and exposes `var QRCode` with `QRCode.toDataURL(text, opts)`.
 * jsdelivr has no /build/qrcode.min.js for qrcode@1.5.4 either (404). So: cdnjs 1.5.1, then the text-link fallback.
 */

export const RELAY_DEFAULT = 'wss://kennyairepo--hopeos-relay.modal.run';   // deployed 2026-09-20 (`py -m modal deploy tools/relay_modal.py`, workspace kennyairepo)
export const RELAY_LOOPBACK = 'ws://localhost:8787';
export const QRCODE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.5.1/qrcode.min.js';
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';   // 23 letters: no I, L, O
export const ROOM_CODE_LEN = 5;
const CODE_RE = /^[A-Za-z]{5}$/;

/** 5 uppercase letters from ROOM_CODE_ALPHABET. `rng` is injectable for deterministic tests. */
export function makeRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_CODE_ALPHABET[Math.floor(rng() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  return s;
}

/** true when `s` is a generated-style code (5 letters of the alphabet, case-insensitive; 'pilot' is not: I, L, O) */
export function isRoomCode(s) { return typeof s === 'string' && CODE_RE.test(s) && [...s.toUpperCase()].every(c => ROOM_CODE_ALPHABET.includes(c)); }

/** Codes are case-insensitive → uppercase; anything else (named rooms like 'lab', 'pilot') is trimmed only. */
export function normalizeRoomCode(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return isRoomCode(t) ? t.toUpperCase() : t;
}

function toURL(url) {
  if (url instanceof URL) return url;
  if (typeof url === 'string') return new URL(url, 'http://localhost/');
  if (typeof location !== 'undefined') return new URL(location.href);
  return null;
}

/**
 * Room from the three link forms, in this precedence: `?room=X`, `/join/X` (Vercel rewrite), `#room=X`.
 * Returns the raw (decoded, trimmed) room string or null. Codes are uppercased; named rooms keep their case.
 */
export function parseRoomFromUrl(url) {
  const u = toURL(url); if (!u) return null;
  const q = u.searchParams.get('room');
  if (q && q.trim()) return normalizeRoomCode(q);
  const m = /^\/join\/([^/?#]+)\/?$/.exec(u.pathname);
  if (m) { try { return normalizeRoomCode(decodeURIComponent(m[1])); } catch { return normalizeRoomCode(m[1]); } }
  if (u.hash && u.hash.length > 1) {
    const hp = new URLSearchParams(u.hash.slice(1));
    const h = hp.get('room');
    if (h && h.trim()) return normalizeRoomCode(h);
  }
  return null;
}

/** localhost / 127.0.0.1 / [::1] / *.local / LAN addresses: the dev server (tools/dev-server.mjs) has no /join rewrite */
export function isLocalOrigin(origin) {
  let host = '';
  try { host = new URL(origin).hostname; } catch { return true; }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.local') ||
    /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
}

/**
 * Invite link for `room`. On the Vercel domain: `${origin}/join/<room>`; on localhost / LAN: `${origin}/teamslab.html?room=<room>`.
 * `relay` is appended as `?relay=` only when it differs from RELAY_DEFAULT (so hosted links stay short and the laptop
 * relay still travels with a LAN link). `pretty` forces the /join form (true) or the query form (false).
 */
export function buildInviteUrl({ room, relay = null, origin = (typeof location !== 'undefined' ? location.origin : 'http://localhost:3333'), pretty = null } = {}) {
  if (!room) throw new Error('buildInviteUrl: room required');
  const code = normalizeRoomCode(room);
  const usePretty = pretty == null ? !isLocalOrigin(origin) : !!pretty;
  const u = new URL(usePretty ? `/join/${encodeURIComponent(code)}` : '/teamslab.html', origin);
  if (!usePretty) u.searchParams.set('room', code);
  if (relay && relay !== RELAY_DEFAULT) u.searchParams.set('relay', relay);
  return u.toString();
}

let warnedLoopback = false;
/** { relay, source } — `?relay=` (source 'query') → RELAY_DEFAULT ('default') → RELAY_LOOPBACK ('loopback', console.warn once) */
export function resolveRelayInfo(url, { defaultRelay = RELAY_DEFAULT, loopback = RELAY_LOOPBACK, warn = (typeof console !== 'undefined' ? console.warn.bind(console) : null) } = {}) {
  const u = toURL(url);
  const q = u && u.searchParams.get('relay');
  if (q && q.trim()) return { relay: q.trim().replace(/\/+$/, ''), source: 'query' };
  if (defaultRelay) return { relay: defaultRelay.replace(/\/+$/, ''), source: 'default' };
  if (!warnedLoopback && warn) { warnedLoopback = true; warn(`[room-link] no hosted relay (RELAY_DEFAULT is empty) and no ?relay= — falling back to ${loopback}; run \`npm run relay\` or deploy tools/relay_modal.py`); }
  return { relay: loopback, source: 'loopback' };
}
export function resolveRelay(url, opts) { return resolveRelayInfo(url, opts).relay; }
/** tests only: forget that the loopback warning was printed */
export function _resetRelayWarning() { warnedLoopback = false; }

/** `${relay}/room/<room>` — untouched when the relay URL already carries a /room/ segment (TEAMSLAB.md §2) */
export function roomWsUrl(relay, room) {
  const base = String(relay || '').replace(/\/+$/, '');
  return /\/room\//.test(base) ? base : `${base}/room/${encodeURIComponent(room)}`;
}

let qrLib = null;   // Promise<QRCode|null>
function loadQrLib(src = QRCODE_CDN) {
  if (qrLib) return qrLib;
  qrLib = new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    if (globalThis.QRCode && typeof globalThis.QRCode.toDataURL === 'function') { resolve(globalThis.QRCode); return; }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    const timer = setTimeout(() => { resolve(null); }, 8000);
    s.onload = () => { clearTimeout(timer); resolve(globalThis.QRCode && typeof globalThis.QRCode.toDataURL === 'function' ? globalThis.QRCode : null); };
    s.onerror = () => { clearTimeout(timer); resolve(null); };
    document.head.appendChild(s);
  });
  return qrLib;
}

/**
 * PNG data URL of a QR code for `text` (the invite link), or null when the library cannot load (offline, CSP, Node) —
 * the caller then shows the link as text. `qrcode` UMD API (node-qrcode README): `QRCode.toDataURL(text, { width, margin,
 * errorCorrectionLevel, color: { dark, light } }) -> Promise<string>`.
 */
export async function makeQrDataUrl(text, { width = 208, margin = 2, dark = '#000000ff', light = '#ffffffff', src = QRCODE_CDN } = {}) {
  try {
    const lib = await loadQrLib(src);
    if (!lib) return null;
    return await lib.toDataURL(String(text), { width, margin, errorCorrectionLevel: 'M', color: { dark, light } });
  } catch (e) {
    try { console.warn('[room-link] QR unavailable, showing the link as text:', e && e.message || e); } catch { /* ignore */ }
    return null;
  }
}
