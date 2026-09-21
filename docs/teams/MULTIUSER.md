# MULTIUSER — link-based rooms: hosted relay, invite links, pre-join screen

Round 2 of the Teams-twin sandbox replaces "run `npm run relay` on a laptop and type its LAN address" with **one link**:
whoever opens `https://<vercel-domain>/join/<CODE>` (or `teamslab.html?room=<CODE>`) on any device lands in the same
room on a **hosted relay**, sees a Teams-style pre-join screen, and joins with a name. No terminal on the guests' side.

Status 2026-09-20: relay deployed and verified from Node (18/18 protocol checks, 5 clock pings, RTT 53–265 ms from
this box); room-link + join-ui built and probed headless at 1280x800 and 390x844; **not yet wired into
`teamslab.html`** — the integrator's checklist is in §5.

## 1. The hosted relay (`tools/relay_modal.py`)

| | |
|---|---|
| URL | `wss://kennyairepo--hopeos-relay.modal.run` (HTTP: `https://kennyairepo--hopeos-relay.modal.run/` → `teams-football relay`, `/health` → rooms + counters) |
| Deploy | `py -m modal deploy tools/relay_modal.py` (Modal profile `kennyairep`, workspace slug `kennyairepo`; on Windows set `PYTHONUTF8=1` first — Modal's progress output otherwise dies with `'charmap' codec can't encode`) |
| Modal app | `hopeos-relay`, function `web`: `@app.function(image, max_containers=1, scaledown_window=600)` + `@modal.concurrent(max_inputs=500)` + `@modal.asgi_app(label="hopeos-relay")`; image `debian_slim(python 3.12)` + `fastapi>=0.115`, `uvicorn[standard]>=0.30` |
| Why one container | room state is an in-process dict; `max_containers=1` keeps every room in one process, `@modal.concurrent(max_inputs=500)` lets 500 sockets share it ("WebSockets on Modal maintain a single function call per connection" — modal.com/docs/guide/webhooks). Parameter names verified against modal 1.5.3 (`inspect.signature(modal.App.function)`: `min_containers`, `max_containers`, `buffer_containers`, `scaledown_window`; `modal.concurrent(*, max_inputs, target_inputs)`) and modal.com/docs/guide/scale |
| Cold start | the container sleeps after 600 s idle; the first socket after that waits ~1–3 s for the hello (the pre-join chip shows "Connecting…"). `min_containers=1` would remove it at the cost of an always-on container |
| Limits | messages ≤ 2 MiB, no permessage-deflate, no HTTP/2 WebSockets (Modal); our packets are ≤ ~600 B |
| Dashboard | https://modal.com/apps/kennyairepo/main/deployed/hopeos-relay |

### Protocol (identical to `tools/relay-server.mjs`; `sdk/net/room.js` and `sdk/game/ball-net.js` depend on it)

- rooms are the URL path: `wss://…/room/<room>`
- on connect: `{"hello": {"clientId": "c-001", "room": "/room/<room>", "peers": ["c-001", …], "serverNow": <u32 ms>}}`;
  the others get `{"joined": "c-001"}`; on close they get `{"left": "c-001"}`. `clientId` = `c-` + base36 counter
  zero-padded to 3 → lexically sortable, **lowest id in the roster = host**
- every **binary** frame is fanned out to the other sockets in the room unchanged (text frames are server → client only)
- `CLOCK_PING` (byte 0 = `0x01`, ≥ 12 bytes) is answered to the sender alone with a 20-byte `CLOCK_PONG`:
  `[0]=0x02 [1]=ping[1] [2..8)=ping[2..8) [8..12)=ping[8..12) [12..16)=u32le server receive [16..20)=u32le server send`
  (session clock, `docs/teams/hopeos-wire.md`)
- the relay keeps nothing: no names, no video, no landmarks — it forwards bytes per room and answers pings

### Verify

```
node tests/relay-modal-smoke.mjs                 # hosted URL (RELAY_DEFAULT); prints RTT; then a LOCAL reconnect section
node tests/relay-modal-smoke.mjs wss://other     # any relay base URL (or RELAY_URL=…)
node tests/relay-modal-smoke.mjs --local         # the same protocol checks against tools/relay-server.mjs on a free port
node tests/relay-modal-smoke.mjs --no-reconnect  # skip the kill/restart reconnect section
```

Result 2026-09-20 (hosted): `26 passed, 0 failed` — hello/joined/left fan-out, binary echo to the peer only, CLOCK_PONG
in 67 ms (min 53, median 59; an earlier cold run measured 238–267 ms), plus the reconnect section: server killed →
`closed(willReconnect)`, 4 attempts with backoff, `open(reconnected)`, session id kept, queued reliable frame flushed.

## 2. Room codes and links (`sdk/net/room-link.js`, Node-safe)

| export | behaviour |
|---|---|
| `RELAY_DEFAULT` | `'wss://kennyairepo--hopeos-relay.modal.run'` — `''` means "not deployed" |
| `makeRoomCode(rng?)` | 5 uppercase letters from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O) |
| `parseRoomFromUrl(url?)` | `?room=` → `/join/<code>` → `#room=` (that precedence); codes uppercased, named rooms (`lab`, `pilot`) kept; `null` when absent |
| `normalizeRoomCode(s)` / `isRoomCode(s)` | codes are case-insensitive; anything that is not a code is trimmed only |
| `buildInviteUrl({room, relay?, origin?, pretty?})` | hosted origin → `https://<domain>/join/<CODE>`; localhost / LAN → `http://host:3333/teamslab.html?room=<CODE>` (the dev server has no rewrites); `?relay=` appended only when it differs from `RELAY_DEFAULT` |
| `resolveRelay(url?)` / `resolveRelayInfo(url?)` | `?relay=` → `RELAY_DEFAULT` → `ws://localhost:8787` with ONE `console.warn` (source `'query' | 'default' | 'loopback'`) |
| `roomWsUrl(relay, room)` | `${relay}/room/${room}` (untouched when the relay URL already names a room, as `teamslab.html` does today) |
| `makeQrDataUrl(text)` | PNG data URL via the `qrcode` UMD on cdnjs, lazily loaded; `null` → show the link as text |

QR library path verified 2026-09-20: cdnjs lists `qrcode` 1.5.4 with **no files** (`api.cdnjs.com/libraries/qrcode` →
`"files": []`; `…/qrcode/1.5.4/qrcode.min.js` is 404) and jsdelivr has no `build/qrcode.min.js` for 1.5.4 either; the
newest cdnjs build with files is **1.5.1**: `https://cdnjs.cloudflare.com/ajax/libs/qrcode/1.5.1/qrcode.min.js`
(global `QRCode`, `QRCode.toDataURL(text, opts) → Promise<string>`). The text fallback is exercised in Node
(`makeQrDataUrl` resolves `null` without a document).

`node tests/room-link-smoke.mjs` → `36 passed, 0 failed`.

Vercel (`vercel.json`): `/teamslab → /teamslab.html`, `/join/:room → /teamslab.html` (rewrites only; the page reads the
room from `location.pathname`).

## 3. Pre-join screen, invite dialog, connection chip (`sdk/game/join-ui.js` + `sdk/ui/join.css`)

```js
import { JoinUI, ConnectionChip, NAME_KEY } from './sdk/game/join-ui.js';
const join = new JoinUI(frame, { requestPreview: () => localSource.stream });   // room/relay/name default from the URL + localStorage
const { name, mic, camera, room, relay, inviteUrl } = await join.open();        // "Join now" (Enter in the name field too)
join.close();
join.mountPeopleInvite(document.getElementById('roster'));   // People pane: "Invite people · Room KRTZQ · link or QR" + Invite
join.mountChip(document.getElementById('topbar'));           // the chip moves next to the top-bar buttons
join.chip.attach(transport, { room });                       // WsRelayTransport 'state' events + Room 'roster' → connecting / connected N / reconnecting / offline
```

- Teams-style layout: preview tile (mirrored, `is-camoff` → initials) with the "Preview · tracked on this device" pill,
  camera / mic pill toggles under it; card on the right with **Room** (code, editable — phones can type a code they were
  told), **Your name** (prefilled from `localStorage['hopeos.name']` or `?name=`), **Join now** (primary) and **Invite**.
- **Invite** opens a Fluent dialog (`.dlg` from teamslab.css): code, link in a read-only input, **Copy link**
  (`navigator.clipboard` → `execCommand` fallback, "Link copied" for 2.5 s), **Share…** when `navigator.share` exists
  (phones), QR `<img>` or the text fallback (`#inviteQr[data-qr="img"|"text"]`).
- **Connection chip** `.conn-chip[data-state]`: `connecting` (amber pulse) · `connected` "Connected · N" (green) ·
  `reconnecting` (amber) · `offline` (red); `role=status`, reduced-motion safe.
- Privacy: the screen never calls `getUserMedia` — consent (C1) stays the gate; the integrator passes the stream after
  consent (`requestPreview` / `setPreview`). Only the display name is stored (`hopeos.name`).
- Phone (≤ 480 px): one column, every control ≥ 44 px, the invite dialog goes full-width; short landscape keeps Join on
  screen. Styles are all tokens from `teams-tokens.css`; `join.css` must be linked **after** `teamslab.css`.

`node tests/_joinprobe.mjs` mounts the screen over `teamslab.html?shell=1&consent=1` with Chrome's fake camera and
checks room code, prefilled name, live preview, no horizontal scroll at 1280x800 and 390x844, ≥ 44 px targets on the
phone (6 pre-join + 4 dialog controls), QR present, Copy, toggles, validation, join result, People-pane row, chip
states against an unreachable relay. Screenshots: `scratchpad/shots-v2/join-desktop.png`, `join-phone.png`,
`join-invite-*.png`, `join-inmeeting-people.png`.

## 4. `WsRelayTransport` (sdk/net/transports.js) — reconnect

- `new WsRelayTransport(url, { reconnect: true, delaysMs: [1000, 2000, 4000, 8000], connectTimeoutMs: 10000, maxQueue: 64 })`
- `tr.on('state', ({ state, willReconnect, delayMs, attempt, reconnected, hello }) => …)`, `state` ∈ `connecting | open | closed`;
  `tr.state`, `tr.stats = { connects, reconnects, attempts, droppedUnreliable, queued }`
- backoff 1 s → 2 s → 4 s → 8 s (then 8 s forever) until `close()`; `ready` resolves with the FIRST hello and rejects after
  `connectTimeoutMs` without one (the loop keeps retrying; the chip shows it)
- identity: `tr.id` keeps the first hello's clientId for the session (`tr.relayId` is the current socket's). Peers see
  `{left: old}` then our PRESENCE re-adds the same id, so seats and host election stay stable. On a reconnect the
  transport calls `onControl({hello, reconnected:true})` and then `onControl({joined: <new relay id>, reconnected:true})`
  — `Room._onControl` answers a `joined` with an immediate PRESENCE, so the roster converges in one round trip
- sends while down: before the first hello everything queues (as before); during a reconnect only `reliable` sends
  queue (bounded 64), unreliable ones (hand stream, presence) are dropped and counted — newer ones supersede them anyway
- existing API unchanged (`id`, `ws`, `ready`, `send`, `onMessage`, `onControl`, `close`); `tests/relay-smoke.mjs`
  stays green (19/19)

## 5. Integrator checklist (`teamslab.html`, not touched by this task)

1. `<link rel="stylesheet" href="sdk/ui/join.css">` after `teamslab.css`.
2. `url.room`: `parseRoomFromUrl() || makeRoomCode()`; `url.relay`: `resolveRelay()` unless `?transport=loopback`
   (today `relay` absent means loopback; the hosted default flips that — keep `?transport=loopback` for the
   one-laptop rehearsal and the loopback probes, and `?relay=` for a LAN relay).
3. Boot order: consent (C1) → `LocalCameraSource.start()` → `new JoinUI(frame, { requestPreview: () => stream })` →
   `await join.open()` → `S.me.name = name` → transport/Room as today (`roomWsUrl(relay, room)`), `join.chip.attach(transport, { room })`,
   `join.mountChip(topbar)`, `join.mountPeopleInvite(roster)`; honour `camera:false` / `mic:false` from the join result.
   `?auto=1` skips the screen (probes).
4. Host: the first person in the room is host (lowest id) — the pre-join screen does not change that.
5. Tell people: **share the link or the 5-letter code**; the relay is public — anyone with the code can join the room.

## 6. Two-device rehearsal (no terminal on either device)

1. Deploy the site (`vercel --prod`, or open `http://<laptop-ip>:3333/teamslab.html?room=KRTZQ` on the LAN).
2. Laptop: open `/join/KRTZQ` → pre-join → Join now → **Invite** → show the QR.
3. Phone: scan → the same room, pre-join, type a name, Join now. Both chips read "Connected · 2"; the People pane lists both.
4. Kill the phone's Wi-Fi for 10 s: its chip goes "Reconnecting…", the laptop's roster drops it, then it returns under
   the same id (`WsRelayTransport` reconnect + PRESENCE).
