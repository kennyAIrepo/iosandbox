/**
 * room-link-smoke.mjs — Node unit smoke for sdk/net/room-link.js (no DOM).
 *   node tests/room-link-smoke.mjs
 * Asserts: makeRoomCode (5 uppercase letters from the 23-letter alphabet, never I/L/O, deterministic with an injected rng,
 * 2000 draws spread over the alphabet); parseRoomFromUrl for ?room=, /join/<code>, #room= and their precedence, codes
 * uppercased, named rooms kept, null when absent; buildInviteUrl on localhost (query form) and on two hosted origins
 * (/join form), relay appended only when it differs from RELAY_DEFAULT; resolveRelay order query -> default -> loopback
 * with exactly one warning; roomWsUrl; makeQrDataUrl resolves null in Node; RELAY_DEFAULT is '' or a ws(s) URL.
 */
import { RELAY_DEFAULT, RELAY_LOOPBACK, ROOM_CODE_ALPHABET, QRCODE_CDN, makeRoomCode, normalizeRoomCode, isRoomCode, parseRoomFromUrl, isLocalOrigin,
  buildInviteUrl, resolveRelay, resolveRelayInfo, _resetRelayWarning, roomWsUrl, makeQrDataUrl } from '../sdk/net/room-link.js';

let passed = 0, failed = 0;
const ok = (c, label, info) => { if (c) passed++; else failed++; console.log(`${c ? 'ok   ' : 'FAIL '} ${label}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`); };

// ── codes ──
ok(ROOM_CODE_ALPHABET.length === 23 && !/[ILO]/.test(ROOM_CODE_ALPHABET) && /^[A-Z]+$/.test(ROOM_CODE_ALPHABET), 'alphabet: 23 uppercase letters without I, L, O');
const seen = new Set(); let bad = 0;
for (let i = 0; i < 2000; i++) { const c = makeRoomCode(); if (!/^[A-Z]{5}$/.test(c) || /[ILO]/.test(c)) bad++; for (const ch of c) seen.add(ch); }
ok(bad === 0, '2000 makeRoomCode() draws are 5 uppercase letters, none ambiguous', { bad });
ok(seen.size === 23, 'draws cover the whole alphabet', { letters: seen.size });
let k = 0; const rng = () => ((k++ * 7919) % 97) / 97;
ok(makeRoomCode(rng) !== makeRoomCode(rng) && (k = 0, makeRoomCode(rng)) === (k = 0, makeRoomCode(rng)), 'injected rng makes codes deterministic');
ok(isRoomCode('KRT7Q') === false && isRoomCode('KRTZQ') && isRoomCode('krtzq') && !isRoomCode('KRTIQ') && !isRoomCode('lab'), 'isRoomCode: letters of the alphabet only, case-insensitive');
ok(normalizeRoomCode(' abcde ') === 'ABCDE' && normalizeRoomCode('pilot') === 'pilot' && normalizeRoomCode('') === null && normalizeRoomCode(null) === null, 'normalizeRoomCode: 5-letter codes uppercase, names kept, empty -> null');

// ── URL parsing (three forms + precedence) ──
ok(parseRoomFromUrl('https://h0p3.io/teamslab.html?room=krtzq&name=A') === 'KRTZQ', '?room= form (uppercased)');
ok(parseRoomFromUrl('https://iosandbox.vercel.app/join/KRTZQ') === 'KRTZQ', '/join/<code> form');
ok(parseRoomFromUrl('https://iosandbox.vercel.app/join/KRTZQ/') === 'KRTZQ', '/join/<code>/ with a trailing slash');
ok(parseRoomFromUrl('http://localhost:3333/teamslab.html#room=krtzq') === 'KRTZQ', '#room= form');
ok(parseRoomFromUrl('http://localhost:3333/teamslab.html?room=pilot') === 'pilot', 'named rooms keep their case');
ok(parseRoomFromUrl('https://x.io/join/AAAAA?room=BBBBB#room=CCCCC') === 'BBBBB', 'precedence: ?room= beats /join/ beats #room=');
ok(parseRoomFromUrl('https://x.io/join/AAAAA#room=CCCCC') === 'AAAAA', 'precedence: /join/ beats #room=');
ok(parseRoomFromUrl('https://x.io/join/a%20b') === 'a b', '/join/ segment is percent-decoded');
ok(parseRoomFromUrl('https://x.io/teamslab.html') === null && parseRoomFromUrl('https://x.io/join/') === null && parseRoomFromUrl('https://x.io/?room=') === null, 'no room -> null');
ok(parseRoomFromUrl(new URL('https://x.io/?room=zzzzz')) === 'ZZZZZ', 'accepts a URL object');

// ── invite URLs on two origins ──
ok(isLocalOrigin('http://localhost:3333') && isLocalOrigin('http://192.168.1.20:3333') && !isLocalOrigin('https://iosandbox.vercel.app') && !isLocalOrigin('https://h0p3.io'), 'isLocalOrigin');
ok(buildInviteUrl({ room: 'krtzq', origin: 'http://localhost:3333' }) === 'http://localhost:3333/teamslab.html?room=KRTZQ', 'localhost -> /teamslab.html?room=CODE (dev server has no rewrites)');
ok(buildInviteUrl({ room: 'KRTZQ', origin: 'https://iosandbox.vercel.app' }) === 'https://iosandbox.vercel.app/join/KRTZQ', 'Vercel origin -> /join/CODE');
ok(buildInviteUrl({ room: 'KRTZQ', origin: 'https://h0p3.io' }) === 'https://h0p3.io/join/KRTZQ', 'custom domain -> /join/CODE');
ok(buildInviteUrl({ room: 'KRTZQ', origin: 'https://h0p3.io', pretty: false }) === 'https://h0p3.io/teamslab.html?room=KRTZQ', 'pretty:false forces the query form');
ok(buildInviteUrl({ room: 'KRTZQ', origin: 'http://localhost:3333', pretty: true }) === 'http://localhost:3333/join/KRTZQ', 'pretty:true forces the /join form');
const withRelay = buildInviteUrl({ room: 'KRTZQ', origin: 'https://h0p3.io', relay: 'ws://192.168.1.20:8787' });
ok(withRelay === 'https://h0p3.io/join/KRTZQ?relay=ws%3A%2F%2F192.168.1.20%3A8787', 'a non-default relay travels as ?relay=', { withRelay });
ok(!buildInviteUrl({ room: 'KRTZQ', origin: 'https://h0p3.io', relay: RELAY_DEFAULT || null }).includes('relay='), 'the default relay is not repeated in the link');
ok(parseRoomFromUrl(withRelay) === 'KRTZQ' && new URL(withRelay).searchParams.get('relay') === 'ws://192.168.1.20:8787', 'invite URL round-trips through parseRoomFromUrl');
let threw = false; try { buildInviteUrl({}); } catch { threw = true; } ok(threw, 'buildInviteUrl without a room throws');

// ── resolveRelay order ──
ok(RELAY_DEFAULT === '' || /^wss?:\/\/[^/]+$/.test(RELAY_DEFAULT), 'RELAY_DEFAULT is empty or a bare ws(s) origin', { RELAY_DEFAULT });
const warns = []; const warn = (m) => warns.push(m);
_resetRelayWarning();
ok(resolveRelay('https://h0p3.io/join/X?relay=wss://other.example/', { warn }) === 'wss://other.example' && resolveRelayInfo('https://h0p3.io/?relay=ws://a:1', { warn }).source === 'query', '?relay= wins (trailing slash trimmed)');
ok(resolveRelayInfo('https://h0p3.io/join/X', { defaultRelay: 'wss://dflt.example', warn }).relay === 'wss://dflt.example' && resolveRelayInfo('https://h0p3.io/join/X', { defaultRelay: 'wss://dflt.example', warn }).source === 'default', 'then RELAY_DEFAULT');
ok(warns.length === 0, 'no warning while a relay is configured');
const lb = resolveRelayInfo('https://h0p3.io/join/X', { defaultRelay: '', warn });
ok(lb.relay === RELAY_LOOPBACK && lb.source === 'loopback' && warns.length === 1 && /RELAY_DEFAULT is empty/.test(warns[0]), 'then loopback with one console warning', { warn: warns[0]?.slice(0, 60) });
resolveRelayInfo('https://h0p3.io/join/X', { defaultRelay: '', warn });
ok(warns.length === 1, 'the loopback warning prints once');
if (RELAY_DEFAULT) { _resetRelayWarning(); ok(resolveRelay('https://h0p3.io/join/X', { warn }) === RELAY_DEFAULT, 'resolveRelay() with no ?relay= returns the deployed RELAY_DEFAULT', { RELAY_DEFAULT }); }

// ── ws URL / QR in Node ──
ok(roomWsUrl('wss://r.example/', 'KRTZQ') === 'wss://r.example/room/KRTZQ' && roomWsUrl('ws://a:8787/room/x', 'KRTZQ') === 'ws://a:8787/room/x' && roomWsUrl('ws://a', 'a b') === 'ws://a/room/a%20b', 'roomWsUrl appends /room/<code> once, encoded');
ok(/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcode\/1\.5\.\d+\/qrcode\.min\.js$/.test(QRCODE_CDN), 'QR library is the cdnjs qrcode UMD', { QRCODE_CDN });
ok((await makeQrDataUrl('https://h0p3.io/join/KRTZQ')) === null, 'makeQrDataUrl resolves null without a document (text fallback path)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
