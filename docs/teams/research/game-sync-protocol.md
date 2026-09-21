# Sync protocol — one ball, one owner, scheduled handoff at the tile boundary

Researcher folder: `game`. Date: 2026-09-18 (finisher pass: reconciled with the canonical code, which is the authority for byte layouts). Code: `examples/ball-net.mjs` (codec, `SharedClock`, `BallNet`), `examples/transports.mjs`, `examples/relay-server.mjs`; verified headless by `examples/smoke-test.mjs` (see `SUMMARY.md`).

## 1. Principles (and where each comes from)

1. **Exactly one owner simulates the ball.** Everyone else dead-reckons and renders. Unity Netcode's distributed-authority rule ("the owner of a NetworkObject is always the authority for that NetworkObject", https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@2.11/manual/components/core/networkobject-ownership.html) and the *ownership* half of Gaffer's VR physics design: ownership is exclusive until relinquished and "an increase in ownership sequence wins over an increase in authority sequence number" (https://gafferongames.com/post/networked_physics_in_virtual_reality/).
2. **Two buses**, as already decided in `MULTIPLAYER_SYNC_ARCHITECTURES.md`: an *unreliable, newest-wins* presence bus (hand landmarks, `BALL_STATE`) and a *reliable, ordered* state bus (`LAUNCH`, `CLAIM`, `ACK`, `GOAL`, `SEAT_MAP`). On WebRTC: `createDataChannel('ball', { ordered: false, maxRetransmits: 0 })` and `createDataChannel('state', { ordered: true })` — `maxRetransmits` and `maxPacketLifeTime` are mutually exclusive (https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel).
3. **Local-first hands**: your hands never round-trip. The catch is computed by the catcher's own client with its own hands, so a catch has zero network latency by construction.
4. **Handoff by schedule, not by request.** A throw publishes the predicted boundary-crossing time on the shared clock; the receiving tile takes ownership when that time passes, without a round trip. Racer did the analogue for cars crossing phone screens: the device showing the car sends every 4 frames and the receiver "render[s] forward based on message latency" (https://web.dev/racer).
5. **Ship the hold in hand space.** While the ball is held, the wire carries `(hold mode, hand slot, palm-local offset + rotation)`, and remote clients place the ball on the *received hand* — this is what keeps the remote catch gap-free (`mechanics-options.md` §3).
6. **No timers, no browser APIs in the state machine.** `BallNet` advances only from `tick()` / `tickOwner(ball)` and an injected clock, so the same code runs in a rAF loop and headless (`smoke-test.mjs` drives it on a virtual clock through `MemHub`).

## 2. Roles

| Role | Who | Duties |
|---|---|---|
| **client** | every tracked participant's browser | owns the ball while it is in its tile; streams its hands; renders everything else |
| **host** | lowest `clientId` among tracked clients (loopback / relay / WebRTC); inside Teams: a client whose role is `organizer` or `presenter` (`UserMeetingRole`, enforced with `allowedRoles` on `initialize`, https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities) | authors the seat map and mode (`publishSeatMap`); `kickoff()`; **proxy owner** for untracked seats (goal / wall / portal); recovery owner when the owner vanishes; time master on WebRTC |
| **untracked seat** | phone, camera off, spectator | sends nothing; may not even run our app |

Host election is deterministic from the roster; a host change is just a new `SEAT_MAP` version. In the code the two host duties are one flag (`isHost`); §10 explains when they should split.

Two seat notions matter on the wire and in `BallNet`: the **owner** (`owner`, the seat of the *client* that simulates) and the **sim seat** (`ownerSimSeat` / `simSeat`, the *rect* the physics runs in). They differ only while the host proxies an untracked seat (`proxyFor >= 0`).

## 3. Shared clock

Every packet timestamp is on the **session clock** `T`, in ms, `u32` (wraps at ~49.7 days; compare with the wrap-safe `dt32(a, b)`).

- **Relay (WebSocket)**: the server is the clock. Client sends `CLOCK_PING(t0)`; `relay-server.mjs` replies `CLOCK_PONG(t0, t1, t2)`; client notes `t3`. Offset = `((t1 - t0) + (t2 - t3)) / 2` (NTP form of Cristian's `T + RTT/2`, https://en.wikipedia.org/wiki/Cristian%27s_algorithm). `SharedClock.sample()` keeps the **median of 8**; re-sample every 10 s. Racer polled the server multiple times and took the median to land "within 10 ms" (https://web.dev/racer). Measured in the smoke test: offset error 2.3 ms under ±40 ms asymmetric jitter.
- **WebRTC mesh**: no server; the host is the time master and answers pings on the reliable channel.
- **Live Share**: `SharedClock.adoptGlobal()` with the host's global time — `ILiveShareHost.getNtpTime()` → `INtpTimeInfo.ntpTimeInUTC`, and every `ILiveEvent` carries `timestamp` ("Global timestamp of when the event was sent", https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/iliveevent). Do not build a second clock there.
- Local `performance.now()` is monotonic; the offset maps it to `T`. `Date.now()` is never used on the wire.

## 4. Ball state machine (owner side)

```
FREE_IN_TILE ──(hand wraps/clips/cradles)──> HELD ──(gate fails)──> FREE_IN_TILE (drop) or IN_TRANSIT (LAUNCH)
FREE_IN_TILE ──(centre + R crosses L/R/T edge with a neighbour)──> IN_TRANSIT (LAUNCH, reason=throw/roll/bat)
FREE_IN_TILE ──(edge with no neighbour)──> onWall hook (outer rule is local: still my ball)
IN_TRANSIT   ──(T >= tEdge', receiver claims)──> FREE_IN_TILE (new owner)
FREE_IN_TILE ──(atRest 8 s)──> respawn: local CLAIM(respawn) if I am the kick-off seat, else LAUNCH(reason=respawn, 600 ms)
any          ──(owner silent 1 s)──> host CLAIM(reason=recovery) → FREE_IN_TILE in host's tile
```

The floor is never an exit (`exitEdge` tests L, R, T only — `court-map.mjs`). Owner emits `BALL_STATE` at `rateHz` (20 on relay / Live Share, 30 on WebRTC) in every state, and `LAUNCH` once per transition into `IN_TRANSIT` (reliable, plus `LAUNCH_REPEATS = 3` unreliable copies 16 ms apart so a lost reliable message is not the only path when the reliable bus is a TCP WebSocket in head-of-line block). While in transit the owner keeps simulating but never re-launches.

`TUNING` (ball-net.mjs): `MIN_LEAD_MS 80`, `HANDOFF_TIMEOUT_MS 250`, `OWNER_SILENCE_MS 1000`, `REST_TO_GUTTER_MS 8000`, `RESPAWN_TRANSIT_MS 600`, `LAUNCH_REPEATS 3 / GAP 16`.

## 5. Ownership handoff at a boundary (the scheduled handoff)

Let A own the ball, throw toward B, one-way latency `L`, predicted gutter time `T_e = gutter / |v_along|` (floor 0.2 units/s).

```
T0            A: release; ThrowDetector → v0, w0; exit edge E, cEdge, tEdge = T0 + T_e
T0            A → all: LAUNCH{launchSeq, from=A, to=B, ownerSeat, E, cEdge, tEdge, x,y,d, v, w, ownerSeq, radius}
T0 + L        B: receives LAUNCH; tEdge' = max(tEdge, now + MIN_LEAD_MS); spawns a GHOST integrated from (x + wrapDx, y, v @ T0) to "now"; arrival ring at (E, cEdge) shrinking to tEdge'
T0 .. tEdge'  A: keeps simulating; BALL_STATE; C dead-reckons (prefers the LAUNCH trajectory to BALL_STATE while in transit — it is exact)
tEdge'        B: T >= tEdge' → B becomes owner: ownerSeq += 1, CLAIM{ownerSeq, reason=boundary, simSeat=B, state=ghost@tEdge', tState=tEdge'}; B's local physics now runs the real ball (hands can catch it)
tEdge' + L    A, C: CLAIM with ownerSeq > mine → A drops ownership (onLostOwner), everyone re-times lastLaunch.tEdgeEff = tState and renders B's BALL_STATE (or B's hand-space hold if caught)
tEdge + 250   A: (no CLAIM yet) assumes the handoff anyway (stats.timeouts++), stops sending BALL_STATE; if B is gone the host recovers after 1 s of silence
```

Key properties:
- B never waits for A at the boundary; the ball appears at B's edge at `tEdge'` on the shared clock, for B and for every spectator.
- A never gets corrected: the CLAIM state equals what A predicted (same `integrateCourt`, same constants), so there is no rubber band on the thrower's screen. The smoke test asserts this over an A→B→C→A ring and a 60-throw fuzz.
- If A's hand bats the ball back before `tEdge'` (still A's tile, still A's ball), A sends a **new LAUNCH with launchSeq + 1**; B discards a ghost whose `launchSeq` is stale before claiming. The window for this race is `L` — see §7.
- If `L > T_e` (the LAUNCH arrives after the ball was due), B applies the **boundary stretch** from `latency-feel.md` §3: `tEdge' = max(tEdge, now + 80 ms)`; B still claims at `tEdge'`, A learns `tEdge'` from B's CLAIM (`tState`) and shows the ball hanging in the gutter for the difference. In the smoke test at 120 ± 30 ms with a 0.08-unit gutter (T_e ≈ 45 ms) every hop stretches by ~150-170 ms — expected: the gutter is short by design and the stretch is the visible slow-mo, not a bug.
- **Timing note**: `HANDOFF_TIMEOUT_MS` (250) must exceed the CLAIM's round trip (`~2L + jitter`); at `L = 150 ms` it is borderline and the thrower's timeout can fire a few ms before the CLAIM lands (harmless — same outcome — but it inflates `stats.timeouts`). Raise it to 400 for WAN profiles.

## 6. Packets — byte-level layout (authoritative: `ball-net.mjs`)

All multi-byte fields little-endian (`DataView`, `LE = true`). Court units: 1 = tile height. Quantization: positions `i16 × 1000` (±32.7 units, 1 mm at a 1 m tile), velocities `i16 × 1000` units/s, depth `i16 × 10000`, spin `i16 × 100` rad/s, time `u32` ms session clock, `seq` `u16` per sender (wrap-safe `seqNewer16`), `ownerSeq`/`launchSeq` `u8` (`seqNewer8`).

**Common header — 8 bytes**

| off | type | field |
|---|---|---|
| 0 | u8 | `type` |
| 1 | u8 | `flags` (bit0 = `FROM_HOST`, bit1 = `PROXY`, bits 4-7 = protocol version = 1) |
| 2 | u16 | `seq` |
| 4 | u32 | `t` session clock ms of the state in the packet |

**CLOCK_PING 0x01 (12 B)**: header + `t0 u32`. **CLOCK_PONG 0x02 (20 B)**: header + `t0 u32` + `t1 u32` (server receive) + `t2 u32` (server send).

**BALL_STATE 0x10 — 34 bytes, unreliable, 20-30 Hz, owner only**

| off | type | field |
|---|---|---|
| 8 | u8 | `owner` seat (the sending client's seat) |
| 9 | u8 | `ownerSeq` |
| 10 | u8 | `hold`: bits 0-1 mode {0 free, 1 cradle, 2 wrap, 3 clip}; bit 2 hand slot (0 L, 1 R); bit 3 atRest; bit 4 inTransit; bit 5 onFloor |
| 11 | u8 | `seat` the ball is simulated in (`ownerSimSeat`; 0xFF = gutter while in transit) |
| 12-16 | i16 ×3 | `x`, `y`, `d` |
| 18-22 | i16 ×3 | `vx`, `vy`, `vd` |
| 24-28 | i16 ×3 | `wx`, `wy`, `wz` |
| 30 | u16 | `radius` (court units × 10000) |
| 32 | u8 | `launchSeq` |
| 33 | u8 | `held` (1 = a HOLD_OFFSET trailer follows) |

**HOLD_OFFSET trailer — 14 bytes** (offsets 34-47, appended when held): `ox, oy, oz i16 × 10000` palm-local offset in hand-span units; `q0, q1, q2 i16 × 10000` smallest-three quaternion (largest component dropped, sign normalised positive); `big u8` (index of the dropped component); `pad u8`. Remote clients reconstruct `ballPos = palm + palmQ * offset` from the *received landmarks* of that seat's hand — no gap, no world-position mismatch. `atRest` lets the receiver skip velocity (Gaffer's at-rest flag, https://gafferongames.com/post/state_synchronization/). Total held packet: 48 B.

**LAUNCH 0x11 — 42 bytes, reliable (+3 unreliable repeats)**

| off | type | field |
|---|---|---|
| 8 | u8 | `from` seat (sim seat the ball leaves) |
| 9 | u8 | `to` seat (predicted; 0xFF = no neighbour) |
| 10 | u8 | `ownerSeq` |
| 11 | u8 | `launchSeq` |
| 12 | u8 | `reason` {0 throw, 1 drop-roll, 2 bat, 3 respawn, 4 portal-pass} |
| 13 | u8 | `edge` {0 L, 1 R, 2 T, 3 B, 255 none (respawn)} |
| 14-18 | i16 ×3 | `x0`, `y0`, `d0` (release position, in `from`'s court coordinates) |
| 20-24 | i16 ×3 | `vx`, `vy`, `vd` |
| 26-30 | i16 ×3 | `wx`, `wy`, `wz` |
| 32 | u32 | `tEdge` (session clock) |
| 36 | i16 | `cEdge` (court coordinate along the edge: y for L/R, x for T) |
| 38 | u16 | `radius` |
| 40 | u8 | `ownerSeat` — the *client* seat sending (differs from `from` when the host proxies) |
| 41 | u8 | pad |

**CLAIM 0x12 — 30 bytes, reliable**: header + `seat u8` (claimant client) + `ownerSeq u8` + `reason u8` {0 boundary, 1 touch, 2 proxy, 3 recovery, 4 respawn} + `launchSeq u8` + state `x, y, d, vx, vy, vd i16` (offsets 12-22) + `tState u32` (24; usually `tEdge'`) + `simSeat u8` (28; the rect the claimant simulates in — equals `seat` unless proxying) + pad.

**ACK 0x13 — 12 bytes, reliable**: header + `ownerSeq u8` + `accepted u8` + `bySeat u8` + pad. Informational (the CLAIM already wins by sequence).

**GOAL 0x14 — 16 bytes, reliable**: header + `goalSeat u8` + `scorerSeat u8` + `ownerSeq u8` + `goalNo u8` + `tGoal u32`. Accepted only if `goalSeat === map.goal`, `ownerSeq` matches, and the sender is the goal seat's owner or (`flags PROXY | FROM_HOST` and the goal seat is untracked). `BallNet.declareGoal(scorerSeat, goalNo)` refuses when the caller is not simulating the goal rect.

**SEAT_MAP 0x20 — variable, reliable**: header + UTF-8 JSON (`space-mapping.md` §3). Accepted only with `FROM_HOST` and a higher `v`; the receiver re-derives its own seat from `clientId`.

**HAND_STREAM 0x30**: the existing landmark relay packet (21 × 3 quantized per hand, `PlayerFrame` id) — unchanged; the ball protocol only references its `seat` + `hand slot`.

Bandwidth: owner 34-48 B × 20 Hz < 1 KB/s; LAUNCH/CLAIM are rare. Well under any transport, including Live Share's advice to debounce to one message per 50 ms (https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq). Smoke-test fuzz: 60 throws over 3 peers ≈ 3.8 k packets total.

## 7. Conflict rules (deterministic, no server needed — all implemented in `BallNet._onPacket`)

1. **Higher `ownerSeq` wins.** A CLAIM with an older `ownerSeq` is ignored and answered with `ACK accepted = 0`.
2. **Equal `ownerSeq`** from a different seat (two clients claimed simultaneously — e.g. the ball on an edge between B and C after a wall bounce): the **tile-owner rule** — the client whose rect contains the ball's centre at the claim's state wins; if neither/both, the **lower `clientId` (string sort) wins** — the tie-break Live Share's `LiveEvent.isNewer()` documents ("the clientId containing the lower sort order wins any ties", https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveevent). Counted in `stats.conflicts`.
3. **Stale `launchSeq`**: a repeat copy of a LAUNCH (same `from` + `launchSeq`) is dropped; a ghost older than the latest LAUNCH from the current owner is replaced.
4. **Stale `seq`**: presence packets with an older `seq` than the last accepted from that sender are dropped (newest-wins).
5. **Grab during transit** is impossible by construction: hands only interact with the ball in the tile that owns it. During the `L` window after `tEdge'`, A's hands are ignored for the ball (A already switched to render mode) — the doctrine's hand-stop still runs cosmetically so A's holohand does not pass through the departing ball.
6. **Owner vanished**: no `BALL_STATE` for 1 s → host `CLAIM(reason = recovery)` with `ownerSeq + 1`, ball placed above its own floor (smoke test: recovery 1004 ms after the receiver died, thrower timed out at 308 ms).
7. **Late LAUNCH** (`L > T_e`): boundary stretch (§5); the receiver's CLAIM carries `tState = tEdge'` and everyone re-times the transit to it.
8. **Two balls**: never. A `BALL_STATE` with a newer `ownerSeq` than mine while I own it means I lost a race: I drop ownership (`earlyStates` if I was in transit, else `conflicts`). A `BALL_STATE` with an equal epoch from a seat that is not the known owner is held until the CLAIM settles it.
9. **Seat map version**: a `SEAT_MAP` with `v <= mine` is ignored; packets referring to unknown seats are dropped (the 500 ms hold from the draft is not implemented — a newer map always precedes the packets that need it on the reliable bus).
10. **Self-destination launch** (added in the finisher pass — a real hole found by the smoke test): in a 2-3 seat ring, or when the host proxies both the from- and the to-seat, a LAUNCH's destination is the sender itself, and the sender's own LAUNCH is filtered as an echo. `_sendLaunch` therefore seeds the ghost locally and `tick()` claims at `tEdge'` even though `isOwner && inTransit`. Spectators still see the LAUNCH and then the CLAIM; because the sender cannot apply `MIN_LEAD` to itself, spectators' `tEdgeEff` is re-timed by the CLAIM (they only render `BALL_STATE`, so nothing visible jumps).

## 8. Non-owner rendering

- **Dead reckoning** with the same integrator (`integrateCourt`: `g = 5.2`, drag 0.996/frame, floor restitution 0.58, bounce only when `|vy| > 0.35`, floor friction 0.92) from the last `BALL_STATE`, or from the LAUNCH while in transit. New packet → blend the position error out over 100 ms; > 0.3 units → snap (Gaffer's adaptive blending, https://gafferongames.com/post/state_synchronization/).
- **Jitter buffer** = one packet interval (50 ms at 20 Hz). Valve's 100 ms default at 20 updates/s exists so that "even if one snapshot is lost, there are always two valid snapshots" (https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking); Gaffer measured 85 ms at 60 pps, 150 ms at 30 pps, 350 ms at 10 pps for 5 % loss (https://gafferongames.com/post/snapshot_interpolation/). Extrapolation is chosen over interpolation for the ball because its physics is deterministic and known; hands use the snapshot interpolation the stack already has (the `mpgames.html` YOLO bridge renders one interval behind — `MULTIPLAYER_SYNC_ARCHITECTURES.md` §"already built"); Hermite with the relayed velocity is the upgrade if 20 Hz fingers stutter.
- **Held ball**: place from the received hand landmarks + `HOLD_OFFSET` if the hand stream is < 150 ms old; otherwise fall back to the world position with the ball fading (`handAgeAlpha`, `latency-cues.mjs`).
- **Rocket League** reference for the feel target: physics 120 Hz, network 60 Hz, client prediction with correction smoothing (GDC 2018, https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf — PDF; numbers cross-checked via secondary sources). We run 20-30 Hz because the ball is one object and the hands dominate bandwidth.

## 9. Transports (`transports.mjs`; interface `{ id, send(bytes, {reliable}), onMessage(cb), close() }`)

| Transport | Where | `BALL_STATE` | `LAUNCH/CLAIM/GOAL/SEAT_MAP` | Clock | Notes |
|---|---|---|---|---|---|
| **MemHub / MemTransport** | in-process (Node or browser) | per-link latency / jitter / loss | reliable (no loss) | virtual `now()` | what `smoke-test.mjs` runs; seeded RNG |
| **Loopback** `BroadcastChannel('teams-football')` | same browser, the twin's windows | direct | direct | shared `performance.timeOrigin` | injectable latency / jitter / loss for the `latency-feel.md` §4 bands |
| **WebSocket relay** (`relay-server.mjs`, `ws`) | two laptops, LAN or a small VM (Vercel cannot host sockets — `MULTIPLAYER_SYNC_ARCHITECTURES.md` §3) | binary frames, newest-wins on the client | same socket (TCP ordered) | server pong | head-of-line blocking accepted at 20 Hz; rooms are the URL path |
| **WebRTC** `RtcTransport` | 2-4 peers | `'ball' {ordered:false, maxRetransmits:0}` | `'state' {ordered:true}` | host time master | perfect negotiation; needs signaling + TURN for ~15 % of pairs |
| **Live Share** `LiveShareTransport` | inside a Teams meeting only ("Features in @microsoft/live-share ... don't work outside Microsoft Teams") | `LiveEvent.send()` — "Events aren't guaranteed to be delivered" | `LiveState.set()` (reliable LWW, resets when all leave) keyed `launch`, `owner`, `goal`, `seatMap` | `ILiveEvent.timestamp` / `getNtpTime()` | ≤ 1 msg / 50 ms; data retained ≤ 24 h; 100 attendees; no Teams Rooms; guests OK; GCC only among gov clouds; JSON payloads (base64 the bytes); `TestLiveShareHost.create()` for local dev; npm packages, not CDN |

## 10. What runs when a participant is untracked

- The seat exists in the map with `tracked: false` and a role. The **host proxies** that seat: on a LAUNCH to an untracked seat the host ghosts it and claims with `reason = proxy`, `simSeat = that seat`, `flags PROXY | FROM_HOST`; it simulates in that rect (transit at constant velocity for `portal`, `onWall` for `wall`, gravity + goal plane for `goal`), emits `BALL_STATE` with `seat = simSeat`, and may `declareGoal`. Ownership rules are unchanged; the host is just another owner. Verified in the smoke test (proxy claim → GOAL accepted by the other client 540 ms after the throw → ring-wrap exit back to the host's own tile → rest → local respawn at 8.7 s).
- The untracked participant's own device renders nothing special; if it runs the app (e.g. phone in Teams), it only listens.
- If the host itself is untracked (organizer on a phone), the *proxying* duty should pass to the lowest tracked `clientId` while the seat-map authority stays with the organizer inside Teams (role check). The code has one `isHost` flag today; splitting it is a small change and is listed under open items.

## 11. Test hooks

- `MemHub({ now, rng })` + `hub.link(a, b, { latencyMs, jitterMs, lossPct })` reproduces LAN, WAN and bad-Wi-Fi profiles headlessly; `LoopbackTransport({ latencyMs, jitterMs, lossPct })` does the same in one browser.
- `BallNet.getStats()` — `launches, claims, conflicts, earlyStates, timeouts, recoveries, stretches, stretchMsLast, oneWayMs, packetAgeMs, owner, ownerSeq, inTransit` — feeds the latency HUD (`latency-feel.md` §5).
- Acceptance for the pilot: zero duplicate balls in 30 min of loopback fuzzing at 250 ms ± 80 ms latency with 5 % loss; a claim conflict resolves within 1 packet interval; no thrower-side correction ever. The 60-throw smoke fuzz at 120 ± 30 ms / 5 % loss already gives `maxInTileOwners = 1`, `conflicts = 0`, handoff p95 224 ms, max owner overlap 116 ms (< L + jitter + timeout).

## 12. Sources

- Gaffer on Games — Networked Physics in VR: https://gafferongames.com/post/networked_physics_in_virtual_reality/ ; Snapshot Interpolation: https://gafferongames.com/post/snapshot_interpolation/ ; State Synchronization: https://gafferongames.com/post/state_synchronization/
- Unity Netcode ownership: https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@2.11/manual/components/core/networkobject-ownership.html
- Photon Fusion network object (bot-blocked on fetch; names from search snippets only): https://doc.photonengine.com/fusion/current/manual/network-object
- Valve Source networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Rocket League GDC 2018 deck: https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf
- Racer case study: https://web.dev/racer
- Cristian's algorithm: https://en.wikipedia.org/wiki/Cristian%27s_algorithm
- MDN `createDataChannel`: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
- `ws` README: https://github.com/websockets/ws
- Live Share: overview https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-overview ; capabilities https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities ; FAQ https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq ; `LiveEvent` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveevent ; `LiveState` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/livestate ; `ILiveEvent` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/iliveevent ; `INtpTimeInfo` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/intptimeinfo ; `LiveShareClient` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveshareclient ; `TestLiveShareHost` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/testlivesharehost ; `UserMeetingRole` https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/usermeetingrole ; SDK repo https://github.com/microsoft/live-share-sdk
- Teams Carnival (synchronous games judged too laggy on Live Share): https://github.com/Teams-Carnival-Games , https://techcommunity.microsoft.com/blog/educatordeveloperblog/multiplayer-gaming-experiences-in-microsoft-teams-using-live-share-sdk/3951741
