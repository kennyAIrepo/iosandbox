# TEAMSLAB — run book for the Teams-twin sandbox (`teamslab.html`)

`teamslab.html` is a test harness that imitates the Microsoft Teams meeting layout so the hopeOS layers
(holohands, props under the collision doctrine, the cross-tile ball game, gestures and reactions, the leaderboard,
the command agent) can be developed against a realistic surface. It is not a Microsoft product and not affiliated
with or endorsed by Microsoft (`docs/teams/licences.html` §4). Everything below runs from the repo root on Windows,
macOS or Linux with Node 18+ and Chrome; phones use the hosted link.

## 1. Play with people over a link (hosted)

1. Open `https://<domain>/teamslab.html` (or any invite link `https://<domain>/join/<CODE>`; `vercel.json` rewrites
   `/join/:room` and `/teamslab` to the page).
2. A page opened from a link shows the **pre-join screen** first: room code, your name (remembered on this device as
   `hopeos.name`), camera / mic toggles, **Invite**. Press **Join now** (or Enter) — then the C1 tracking notice
   (the only gate before the camera starts) — and you are in the room.
3. Anyone else: **People** pane → **Invite** → copy the link, show the QR code, or *Share…* on a phone. Everyone
   who opens it lands in the same room, from any device; a 5-letter code (`KRT7Q` style, no I / L / O) is typed in
   any case. Opened without a room, the page runs locally (loopback); its Invite makes a fresh code and, when you
   close the dialog, moves you into that room on the relay.
4. The ball: the tennis ball rests on the **shelf** (the dashed "BALL SHELF" line at 42 % of your tile). Cup your palm
   under it, wrap or clip it, throw toward a neighbour; Game tab → **Ball size** (0.035-0.07 m, default 0.06) and
   **Shelf height** (host only; everyone follows). Raise your open hand above the shoulder line for ~2.5 s to raise
   your hand (the Raise button does the same); clap, thumbs-up, wave or a heart become reactions on your tile for
   everyone. The **leaderboard** lives in the People pane (goals, catches, passes, streaks; first to 5 or 3 min).

The relay is **public and unauthenticated**: `wss://kennyairepo--hopeos-relay.modal.run` (`tools/relay_modal.py`,
`py -m modal deploy tools/relay_modal.py` with `PYTHONUTF8=1` on Windows). Anyone who knows a room code can join
that room; the relay keeps nothing (binary fan-out per room + the session clock) and sleeps after 10 min idle (the
first hello after idle takes 1-3 s; the chip says *Connecting…*). Only hand landmarks, the ball state, scores and
reactions travel — never video. The **connection chip** in the top bar shows *Connected · n / Reconnecting… /
Offline*; `WsRelayTransport` reconnects with backoff (1-2-4-8 s) and a toast says so.

## 2. Local flows (one laptop)

```
npm run serve      # static dev server on http://localhost:3333 (tools/dev-server.mjs; localhost is a secure context)
npm run relay      # OPTIONAL laptop relay on ws://localhost:8787 (tools/relay-server.mjs) — the hosted relay is the default
npm run proxy      # /api/claude + /api/openai + /api/sketchfab on http://localhost:3334 (tools/sandbox-proxy.mjs; keys in §4)
```

| URL | what it is |
|---|---|
| `http://localhost:3333/teamslab.html` | solo practice: one tile, real camera, consent dialog, practice mode, the ball on your shelf (loopback, no relay) |
| `http://localhost:3333/teamslab.html?transport=loopback&tiles=2&clone=1&bot=1&agent=local&consent=1` | one-laptop rehearsal: you + a webcam clone + a scripted bot, on-device agent, consent skipped |
| `http://localhost:3333/teamslab.html?room=pilot&name=Kenny&host=1` | laptop A on the hosted relay (room `pilot`); laptop B opens the same link with `name=Hannah` from anywhere |
| `http://localhost:3333/teamslab.html?room=pilot&relay=ws://<A-ip>:8787&name=Hannah` | LAN-only variant against A's `npm run relay` (the invite link carries `?relay=` when it differs from the default) |

Two browser windows on one machine share a room without any relay: `?room=x&transport=loopback&host=1` and
`?room=x&transport=loopback` (`LoopbackTransport` over `BroadcastChannel`; same browser profile).

## 3. URL parameters

| param | effect |
|---|---|
| `room=<code or name>` / `/join/<code>` / `#room=` | room; a room in the URL = the hosted relay + the pre-join screen. Absent → loopback room `lab` |
| `relay=wss://…` | relay override (default `RELAY_DEFAULT` in `sdk/net/room-link.js`); the page appends `/room/<room>` |
| `transport=loopback` | force the in-browser loopback bus (also the default when the URL has no room and no `relay`) |
| `name=<text>` | display name (pre-fills the pre-join screen) |
| `host=1` | claim the lowest client id (host = lowest id in the PRESENCE roster) |
| `tiles=n` | extra local tiles; `clone=1` makes them webcam clones, `clip=<url>` plays a recorded clip (`tiles=1&clip=` makes YOUR tile the clip — probes) |
| `bot=n` | in-page scripted `BotTile`s (own roster members) |
| `ballr=<m>` | ball radius in metres (0.035-0.07; default 0.06, else the Game-tab slider value you last set) |
| `auto=1` | skip the pre-join screen, run as soon as the clock is ready (a lone host kicks off in practice); `AUTOTEST {...}` console line every 1 s |
| `fixedstep=1` | `setInterval(16)` loop instead of rAF (headless probes; rAF starves in background tabs) |
| `consent=1` | skip the C1 dialog (resolves "share"); the consent record is still per device |
| `coach=1` / `coach=0` | force / suppress the three first-run coach marks (skipped under `auto=1` unless `coach=1`) |
| `agent=auto|local|claude` | command agent: `local` = on-device grammar, `claude` = proxy only, `auto` = Claude with local fallback |
| `proxy=3334` | port of `npm run proxy` for `/api/claude`, `/api/openai` and `/api/sketchfab` (on Vercel they are `/api/*`) |
| `mode=free|potato|practice` | game mode (practice alone, free otherwise) |
| `nosfx=1`, `hud=0`, `outgoing=1` | mute cues, hide the HUD, open the outgoing-video popup (C1) |
| `lat=<ms>&jit=<ms>&loss=<pct>` | loopback latency / jitter / loss injection |
| `wan=1` | degraded band: `game.setLatencyBand(400)` (entry cap + catch assist) |
| `shell=1` | UI-only shell, no tracking (tests/_uiprobe.mjs) |

The pre-v2 probe URLs still boot unchanged:
`?auto=1&fixedstep=1&consent=1&transport=loopback&tiles=3&clone=1&bot=1&agent=local&nosfx=1`.

## 4. The 10-minute demo (SPEC §1.1)

1. A opens the page, **Invite**, sends the link (or the QR) to B; both **Join now** and accept the tracking notice.
2. B's tile appears with B's holohands — no video crossed the wire ("Landmarks from Hannah" pill; HUD chip
   `you 34 · Hannah 68 · relay 9`; top-bar chip *Connected · 2*).
3. A: Game → **Play together** (the clock needs 8 samples, ~2 s). Wrap the tennis ball on the shelf (hand-state chip
   *Holding · wrap*), throw right; B sees the dashed arrival ring, catches by cradle, throws back; the leaderboard
   credits the catch and the pass.
4. A: set B's tile as **goal** (panel or "make Hannah the goal"), score twice (confetti on the scorer's tile, chips in
   the top bar); **Hot potato** for 30 s; the round card at the whistle, **Play again**.
5. Gestures: open hand above the shoulder line → *Hand raised* on everyone's view of your tile; clap / thumbs-up /
   heart → emoji on your tile for everyone (the React menu sends the same packet).
6. A: hold **V** (or the mic pill): "give me an apple in my hand", "make it glow", "give me a rubber duck" (free text:
   catalog → bundled GLB → Sketchfab → labelled placeholder, with progress toasts). `?agent=local` gives the identical
   visible result for catalog kinds without the proxy.
7. A: More → Outgoing video (C1 popup) — OBS Window Capture → Virtual Camera → pick it in a real Teams call.
8. **API** tab: one row per layer with return path, status pill, live numbers, script links, blocker.

Keyboard fallback for every step: `K` keyboard hand, arrows move, hold `Space` to grip (the hand reaches for the
nearest ball within a hand's width and closes round it) / release to throw, `G` kick off (host), `1`-`9` goal seat,
`P` play/stop, `M` mute cues, `H` HUD, `Ctrl+/` command popover, `Esc` closes.

## 5. Keys and services

- Vercel env vars: `ANTHROPIC_API_KEY` (`api/claude.js`), `OPENAI_API_KEY` (`api/openai.js`, push-to-talk),
  `SKETCHFAB_TOKEN` (`api/sketchfab.js` `?op=resolve`; search works without it, downloads fall back to the placeholder).
- Locally `npm run proxy` reads the same names from the environment
  (PowerShell: `$env:ANTHROPIC_API_KEY = "..."; $env:OPENAI_API_KEY = "..."; npm run proxy`). Without them the
  agent falls back to the on-device grammar and shows the C7 "Command service unreachable" line.
- Voice/text commands leave the meeting (OpenAI speech-to-text, Anthropic Claude): the C7 notice in the Game tab
  says so once; push-to-talk is disabled while **On-device only** is on.
- The relay keeps nothing; it fans out binary frames per room and answers CLOCK_PING with the server clock.

## 6. Tests and probes (all from the repo root; run suites one at a time with a timeout when scripting)

```
npm run test:twin          # Node unit smokes: prop-ball, wire, ballnet, command-agent, court-space, pack-gen, ball-game, scene-executor, bot-pass, twin-ui
npm run probe:twin         # headless Chrome (fake camera): tiles, contexts, fps budget, doctrine steps, tennis ball / shelf / hand-state chip, agent, keyboard hand
npm run probe:twinpass     # headless two pages over loopback: pass, catch, goal, potato, hand-stream age
node tests/_intprobe.mjs solo|realhand|4tiles|coach   # integrator probes: solo kickoff, the real-hand clip, 4 tiles, coach placement (shots-v2/)
node tests/_intjoin.mjs    # B3: pre-join → Join now → local relay (npm run relay) → chip Connected · 2 → invite dialog + QR
node tests/_intgest.mjs    # B5/B6 over loopback: raise pill / emoji on the right tile for everyone, SCORE 0x31 to the client's leaderboard
node tests/_uiprobe.mjs    # UI shell: layout at six rectangles, a11y, consent gate, device-only, reduced motion (--b7: sliders, coach, chips)
node tests/_uiprobe.mjs --links   # T7: every API-tab href resolves 200, live numbers tick, consent-copy strings byte-match
node tests/gesture-smoke.mjs; node tests/leaderboard-smoke.mjs; node tests/room-link-smoke.mjs; node tests/ball-visuals-smoke.mjs; node tests/model-fetch-smoke.mjs
```

Probes reuse a dev server already on :3333 or spawn their own; Chrome is expected at
`C:/Program Files/Google/Chrome/Application/chrome.exe` (override with `CHROME=`). Chrome's fake camera shows no
hands, so doctrine is exercised with synthetic packs (`window.__twin.ovPacks`, `PackGen`, the r-aware `around()`);
`tiles=1&clip=tests/fixtures/clips/<file>.mp4` drives a real recorded hand through the same lane.

## 7. Privacy chrome (where each string lives)

| id | where | source |
|---|---|---|
| C1 consent dialog | `#consent`, gates `getUserMedia`; record in `localStorage['hopeos.consent']` `{version, at, shareMode}` | `sdk/game/twin-ui.js` STRINGS.c1 |
| C3 tile pills | `.tile__pill` (Tracking on this device / On-device only / Camera off / Landmarks from X / No tracking data) | STRINGS.c3 |
| C4 On-device only | `#btnDeviceOnly` (aria-pressed, titles, announcements); gates every send incl. PRESENCE, SCORE, REACTION | STRINGS.c4 |
| C7 voice/text notice | Game tab `#c7notice` ("Got it" stored in `hopeos.c7`), push-to-talk title, About > Privacy | STRINGS.c7 |
| C10 strip + footnote | `#strip` (never hidden), About `#about-trademark` -> `docs/teams/licences.html` | STRINGS.c10 |
| C11 Body, C13 bug report | About > Privacy (informational; Body layer and bug button are seams) | `teamslab.html` T7 block |
| pre-join / invite | `#prejoin`, `#inviteDlg`, the connection chip; the name is stored as `hopeos.name` only | `sdk/game/join-ui.js` JOIN_STRINGS |

Served copies of the notices and the research example scripts linked from the API tab live under `docs/teams/`
(`privacy.html`, `terms.html`, `licences.html`, `consent-copy.md`, `data-flow.md`, `MULTIUSER.md`, `GESTURES.md`,
manifests, stage / side-panel / video-effect / ACS examples). The wire table (0x01-0x32) is `docs/teams/hopeos-wire.md`.

## 8. Troubleshooting

- **Consent dialog again after reload**: the record is per browser profile; `?consent=1` skips it for tests only.
- **"Play together" stays disabled**: the session clock needs 8 samples (~2 s on loopback, longer on a cold relay);
  a non-host page waits for the host's first SEAT_MAP. A lone participant publishes its own one-seat map and
  kicks off in practice within ~2 s of the page being ready.
- **Chip stays "Connecting…"**: the hosted relay wakes from idle (1-3 s); a corporate proxy may block `wss://` —
  run `npm run relay` and add `?relay=ws://<ip>:8787` to the link. The API tab's Relay row shows `sent / rtt / pings`.
- **No second tile**: both pages must show the same room code (the pre-join screen / the invite dialog) and the
  same relay; on a LAN, A's firewall must allow :3333 and :8787.
- **Hands not tracked**: the C3 pill says "Camera off" or "No tracking data"; use `K` for the keyboard hand. A real
  hand reads *Open / Cupped / Holding · wrap* in the tile's hand-state chip (top right).
- **The ball is tiny in a 9-tile gallery**: the glow halo marks it; Ball size (host) goes to 0.07 m.
- **Headless probes hang**: background tabs starve rAF; use `?fixedstep=1` (the probes do) and poll with an
  interval, not rAF, when another tab is in front.
