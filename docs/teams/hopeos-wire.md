# hopeOS wire — the one landmark packet and the one ball-ownership model

Gap folder `research/gaps/wire-protocol/`, 2026-09-18. Authoritative for everything that crosses the wire between hopeOS tiles
(local twin windows, relay, WebRTC, ACS DataChannel, Live Share). Where a canonical topic file says otherwise, §8 lists the
file:line and this document wins; patched copies of the affected files sit next to this one. Nothing under
`C:/Users/hanna/iosandbox` was modified; repo line numbers were re-grepped on the working tree on 2026-09-18.

Files: `hand-stream.mjs` (codec), `remote-consumer.mjs` (receiver), `court-bridge.mjs` (owner-side prop → court → BallNet),
`ball-net.mjs` (patched copy: exports `writeHeader`, `PROTO_VER`; 3-line diff), `transports.mjs` (patched copy: `hopeos-room`
envelope, Live Share bundling), `stage.html` + `stage-adapter.md` (meeting-app diff), `ball-extraction-plan.section6.md`,
`wire-smoke.mjs` (7 sections, all pass — output in `SUMMARY.md`).

## 0. The sentence the memo decided, made concrete

"Never track the Teams video tile; each client tracks locally, relays ~600 B landmark packets at 30 Hz, renders everyone
locally" (`scratchpad/teams-pilot-plan.html`, "The packet"). Concretely: one seat sends `HAND_STREAM 0x30` (516 B for two hands
with world, §2) on the unreliable bus at the transport's rate (§3); the ball is one `BallNet` (§4) whose `BALL_STATE 0x10` rides
the same bus and whose LAUNCH/CLAIM ride the reliable bus; every packet shares the 8-byte header of `ball-net.mjs` so one
`readHeader(buf).type` demuxes both consumers on one transport; every clock stamp is the injected session clock (§5); on the
local twin the bytes ride `BroadcastChannel('hopeos-room')` in a `kind:'wire'` envelope beside the frozen page's presence (§6).

## 1. FRAMES — what the coordinates in the packet mean

1. **`img` = exactly what the sender's `PlayerPipeline` emitted**: 21 normalised points per screen slot in the SENDER's
   selfie-mirrored display space, One-Euro filtered and predicted (`sdk/core/player-pipeline.js:175` `x: 1 - (bx + p.x*bw)`,
   `:203-208` slot assignment + `predicted(slot, predMs)`; documented in `sdk/core/multiplayer.js:13-14` and
   `sdk/core/hand-views.js:38-40`). `z` is MediaPipe's x-normalised, wrist-relative depth times the crop width (1 for
   `fullFrame`).
2. **`world` = raw MediaPipe metric world landmarks** (metres, hand-centred), untouched, or absent when the landmarker did not
   produce them.
3. **Slots `left` / `right` are the sender pipeline's SCREEN slots** (wrist x sorted in mirrored space, `player-pipeline.js:200-204`).
   They name a hand for the HOLD_OFFSET trailer and for `HandBody` slot strings; they say nothing about which physical hand it is.
   Receivers never derive chirality from a slot, a flag, or a label.
4. **Nothing is pre-flipped, re-filtered, or relabelled by sender, codec or consumer.** Each receiver runs its OWN `HandViews`
   instance per seat: chirality from the palm-block volume (`hand-views.js:167-186`), z-sign latch (`:391-401`), slot latches
   reset via `dropSlot` after 400 ms absence (`tile-pipeline.js:87-88`). Verified: `wire-smoke.mjs` (ii) — the receiver's
   measured mesh chirality equals the sender's on the decoded packet, and no `handedness` / `categoryName` / `1 - x` / z-sign
   token exists in the codec or consumer (iv).
5. **Un-mirroring happens in exactly two places, neither of which touches the arrays:**
   - **Render-only tile transform (ui).** Game mode = "Mirror my video: off" (`space-mapping.md` §7): every tile is shown
     un-mirrored (as others see you). Local tile: `transform: scaleX(-1)` on media + overlay canvases together
     (`layout-spec.md:125-127`). Remote tile: the video (if any) already arrives un-mirrored; the hand/props canvases that draw
     the sender's mirrored `img` get the `scaleX(-1)` (CSS on the canvas stack, or `ctx.translate(w,0); ctx.scale(-1,1)` per
     frame — `stage.html drawHands`). Text chrome stays HTML above the canvases (`overlay-sketches.md:12-13`), so nothing reads
     backwards.
   - **Court-only conversion (game).** `CourtMap.tileToCourt(seat, u, v, mirrored = true)` (`court-map.mjs:111-122`) is the ONE
     place `u → 1 - u` happens, and only for the ball's court coordinates. Velocity into the court is obtained by finite
     difference of two converted positions (`court-bridge.mjs toCourtBall`), so its sign inherits the flip instead of being
     reasoned about.
6. **Resolution of `ui/overlay-sketches.md:62-64` vs `codebase/multi-person.md:40`.** The ui note says relayed `hands.left/right.img`
   are "in un-mirrored [0,1] tile units" and are drawn with `u * w`; the codebase note says "do not pre-flip anything". Both cannot
   hold. Decision: the codebase rule wins — the packet is in the sender's MIRRORED space (so `HandViews` on the receiver behaves
   exactly as on the sender). The ui sketch keeps its `u * w` draw call unchanged and gets its un-mirrored result from the
   render-only canvas transform of item 5. `space-mapping.md:90` ("u → 1 - u on img landmarks; world x → -x when the game starts")
   is likewise superseded: the tile flips, the arrays do not; `:92` (conversion in `tileToCourt` only) already said so.

## 2. HAND_STREAM 0x30 — byte layout (little-endian; `hand-stream.mjs`)

Shares the 8-byte header of `ball-net.mjs` (`readHeader` `:65-68`; the writer `header()` `:59` is module-private in the
canonical file, so the patched copy exports it as `writeHeader` — a 3-line diff, see §8).

| off | type | field |
|---|---|---|
| 0 | u8 | `type` = 0x30 |
| 1 | u8 | bits 0-3 `flags` (ball-net `FLAG.FROM_HOST` / `PROXY`, normally 0); bits 4-7 protocol version = 1 |
| 2 | u16 | `seq` — per SENDER, per STREAM (independent of `BallNet.seq`; wrap-safe `seqNewer16`) |
| 4 | u32 | `t` — session-clock ms of the CAPTURE (`clock.now()` when `detect()` ran), §5 |
| 8 | u8 | `seat` — the sender's seat in the SEAT_MAP (0..254; 255 = `SEAT_NONE` is never a sender) |
| 9 | u8 | `hflags`: bit0 left present · bit1 right present · bit2 left has world · bit3 right has world · bit4 POSE33 extension (RESERVED, must be 0; decoders reject) · bits 5-7 reserved 0 |
| 10 | u8 | `hold`: bits 0-1 mode {0 free, 1 cradle, 2 wrap, 3 clip} · bit 2 slot (0 left, 1 right) — INFORMATIONAL (HUD); `BALL_STATE.hold` is the authority |
| 11 | u8 | reserved 0 |
| 12.. | | for each present slot, in the order left then right: 21 × (u, v, z) **i16 = value × 32767**, clamped to [-1, 1] (126 B); then, if that slot's world bit is set, 21 × (x, y, z) **i16 mm** (× 1000), clamped to ±32.767 m (126 B) |

**Sizes** (asserted): two hands with world **516 B**; one hand with world 264 B; one hand img-only 138 B; **heartbeat 12 B**
(no hands — sent at the same rate so `ageMs` stays fresh and "tracking, no hands" differs from "stale"). Budget 600 B (memo).
At 30 Hz: 15.5 KB/s = 124 kbps per sender; four seats: each client receives 46 KB/s.

**Quantisation** (asserted at module load by `selfCheck()` and in `wire-smoke.mjs` (i)/(iii)): img step 1/32767 = 3.05e-5,
max abs error 1.53e-5 image units (0.03 px at 1920 px; ≈ 0.05 mm of world position and depth through `mirrorPoint` at
`mirrorDist 2`). Documented z range: MediaPipe hand z is x-normalised and wrist-relative, |z| < 0.5 in practice, so [-1, 1]
covers it; u, v are [0, 1] in frame and One-Euro overshoot up to ±1 is representable; beyond that clamps. World: 1 mm step,
0.5 mm max error; hand-centred points (|xyz| < 0.25 m) never clamp; the palm-block volume (~(80 mm)³) cannot flip its sign
from 0.5 mm noise. NaN encodes as 0.

**Not in v1, on purpose:** delta/keyframe coding and 10-bit packing (`MULTIPLAYER_SYNC_ARCHITECTURES.md:41-43`) — the i16
keyframe packet is already under budget and stateless, which is what latest-wins needs. **POSE33** (33 × 3 i16 = 198 B) is
reserved by flag bit 4 but must ship as its own packet type (proposed 0x31 at `poseEvery = 2`, 15 Hz) so a two-hand packet
stays ≤ 600 B; the memo's 520-600 B budget counted hands as one coordinate set (252 B), whereas `codebase/multi-person.md:40`
requires both `img` and `world` (504 B) — that is why pose does not fit in the same packet.

**Demux rule.** Every consumer subscribes to the same `transport.onMessage` and switches on `readHeader(buf).type`:
`BallNet._onPacket` handles 0x01-0x20 and returns on 0x30 (`ball-net.mjs:454`); `RemoteHands.onMessage` accepts 0x30 and
returns `false` for everything else (`wire-smoke.mjs` (ii): 20 ball packets ignored by `RemoteHands`, 45 hand packets ignored
by `BallNet`, both on one `MemTransport`).

**PRESENCE 0x21 (added by the twin, T0 — CONTRACTS §7).** The roster packet `sdk/net/room.js` sends on join and every 2 s,
reliable, from every client; consumed by `Room` only (`BallNet._onPacket` `default:` and `RemoteHands.onMessage` ignore it, as
they ignore every type they do not own). `PK.PRESENCE = 0x21` sits in `sdk/game/ball-net.js` next to SEAT_MAP, with `PK.SCORE = 0x31` and `PK.REACTION = 0x32` (v2: leaderboard and gesture reactions, both ignored by `BallNet._onPacket`).

| type | name | bytes | reliable | rate | sender | consumer |
|---|---|---|---|---|---|---|
| 0x21 | PRESENCE | 8-byte header (`type 0x21, flags 0, seq, t`) + UTF-8 JSON `{v:1, clientId, name, tracked, aspect, handSpan, kind}` | yes | on join + every 2 s | every client | `Room` (roster, host = lowest clientId, seat map `v` bump on every roster change) |
| 0x31 | SCORE | 8-byte header (`flags` bit0 FROM_HOST, `seq` = the host's own SCORE counter) + 16 B table header (mode, round state / reason / no / goalsToWin / winnerSeat / startedAt / roundMs) + per seat 10 B fixed + UTF-8 name ≤ 48 B (≤ 58 B per row, 16 rows max) — `sdk/net/score-packet.js` | yes | after every change + every 2 s heartbeat | the host only | `Leaderboard.apply` on every client (rejects non-host, stale `seq`, malformed; a late joiner's first table is applied silently). Reserved before v2 for POSE33; the pose never got a packet, HAND_STREAM bit4 stays 0 |
| 0x32 | REACTION | 8-byte header + `kind` u8 @8 (1 raise · 2 applause · 3 like · 4 wave · 5 love · 6 laugh · 7 surprised) · `seat` u8 @9 · `state` u8 @10 (bit0 on, bit1 slot) · pad @11 · `ts` u32 LE @12 = 16 B — `sdk/net/hand-stream.js encodeReaction / decodeReaction` | yes | per gesture / React-menu pick (raise: on and off) | every client | `teamslab.html onReactionPacket` → `ReactionFx.react` on the tile of that seat (emoji, "Hand raised" pill, live text); `BallNet`, `RemoteHands`, `Room` ignore it |

## 3. RATES per transport (`transports.mjs`)

| Transport | HAND_STREAM | BALL_STATE (`rateHz`) | Why / limits |
|---|---|---|---|
| `LoopbackTransport` — `BroadcastChannel('hopeos-room')` (twin windows) | 30 Hz | 30 | in-process; injectable latency / jitter / loss for the `latency-feel.md` bands |
| `WsRelayTransport` — `relay-server.mjs` | 20-30 Hz | 20 | one TCP socket for both buses: head-of-line blocking; drop to 20 Hz when the HUD p95 age exceeds 150 ms |
| `RtcTransport` — WebRTC | 30 Hz | 30 | `'ball' {ordered:false, maxRetransmits:0}` carries BOTH streams; `'state'` ordered carries LAUNCH/CLAIM/GOAL/SEAT_MAP |
| ACS DataChannel (`acs/acs-client.html:441-475`) | 30 Hz | 20-30 | broadcast ≤ 80 pkt/s per sender where 1200 B = 1 packet: 30 hand + 30 ball = 60 pkt/s; 516 B × 30 = 124 kbps + 48 B × 30 = 11 kbps < the 200 kbps High-priority Lossy cap (< 512 kbps Lossy); 32 KB/msg is irrelevant. Raise `bitrateInKbps` from 64 to 200 and demux `msg.data` with `readHeader` instead of `JSON.parse` (`:460`, `:467`) |
| `LiveShareTransport` — `LiveEvent` (container D) | **20 Hz max, bundled** | 20 (same bundle) | Microsoft: no enforced limit, "one message per 50 ms or more" (`meeting-app/NOTES.md:16`). The patched transport keeps the LATEST packet of each type and sends ONE signal per 50 ms `{ f:[base64, ...] }` (Fluid's own advice to combine signal types, `NOTES.md:8`); the canonical `:221` throttle was per transport and would have halved both streams. Payload ≈ 690 B base64 + 64 B for the ball per signal; N² fan-out on the hosted relay. `stage.html` defaults the selector to 20 Hz; 30 Hz stays selectable for the knee measurement |

Latest-wins everywhere: a stale `seq` is dropped (`RemoteSeat._accept`), a lost packet is replaced by the next one, nothing is
retransmitted. Receivers add `predMs` (0-100 ms linear extrapolation, `remote-consumer.mjs`) instead of re-filtering.

**Inside Teams (container D) the hand stream over LiveEvent is a FALLBACK pending measurement.** `frameworks/SUMMARY.md:15`
("state, not landmarks, crosses the wire … never per-frame data") and `meeting-app/SUMMARY.md:65` ("plan a WebRTC data-channel
fallback for the pose stream") agree on the preferred in-Teams pose path: **WebRTC data channels (`RtcTransport`) signalled
through Live Share** (`LiveState` keys carry the SDP / ICE JSON, exactly like `launch`/`claim` carry bytes), with Live Share
keeping only the authority keys (SEAT_MAP mirror, goal, owner mirror) it is good at. The stage in this folder runs the fallback
so the HUD can produce the numbers (`meeting-app/SUMMARY.md` open question "measured age/loss at 30 Hz with three senders")
that decide whether the fallback is ever enough. Which meeting-app statement is superseded: "30 Hz over LiveEvent by design"
(`meeting-app/SUMMARY.md:14, :27, :30`) → 20 Hz max, bundled, fallback.

## 4. BALL OWNERSHIP — `BallNet` is the only model

Adopted as is: `research/game/examples/ball-net.mjs` — LAUNCH 0x11 / CLAIM 0x12 / ACK 0x13 / GOAL 0x14 / SEAT_MAP 0x20 with
`ownerSeq` (higher wins; equal → tile-owner rule → lower clientId), scheduled handoff at `tEdge'`, court units, host proxy for
untracked seats, recovery after 1 s of owner silence; verified by `smoke-test.mjs` 7/7 (60-throw fuzz at 120 ± 30 ms / 5 %
loss: one in-tile owner at all times, 0 conflicts). The three other designs are superseded (§8):

| Superseded design | Why it loses | What replaces it |
|---|---|---|
| `codebase/ball-extraction-plan.md:93-95` — `kind:'ball'` JSON teleport at the edge, tile-normalised pos, no owner sequence | two balls under loss/reordering; no clock; no spectators; no late joiner | LAUNCH/CLAIM in court units (`ball-extraction-plan.section6.md`) |
| `meeting-app/stage.html:215-248` — `LiveState {owner, goal, n}` set immediately by `claimBall()` / `passBall(tile)`; no flight | a page call can "own" the ball with no physics state; LWW races; no in-flight ball | `LiveState ball` is a MIRROR `{owner, ownerSeq, simSeat, goal, n}` written from `BallNet` hooks for late joiners / HUD; never read to decide ownership (`stage-adapter.md`) |
| `frameworks/examples/teams-liveshare-ball.js:26-33, :56-63` — `holder` LiveState + `throwEvt` / `catchEvt`; "in flight nobody owns it" | an unowned ball has no simulator: spectators diverge, a lost `catchEvt` leaves it ownerless forever | the thrower keeps simulating until CLAIM/timeout (`ball-net.mjs:272`, `:334`); the receiver claims at `tEdge'` without a round trip |

**How the page-level hooks map onto BallNet** (`court-bridge.mjs`, verified in `wire-smoke.mjs` (vii)):

- `window.hopeos.claimBall()` → the only legal direct claim is the host's kick-off when nobody owns: `BallNet.kickoff(ball)`
  (`ball-net.mjs:472`). A catch never calls it — the receiving `BallNet` already owns the ball at `tEdge'`; the catch is the
  receiver's local wrap / clip / cradle on its own hull (`prop-ball.js`), i.e. a local doctrine event, not an ownership write.
- `window.hopeos.passBall(seat)` → a THROW: give the court ball a velocity toward that seat's edge (the agent's `pass_prop`,
  `sandbox-tools.js:47`); `BallNet.tickOwner` emits the LAUNCH when `CourtMap.exitEdge` fires (`ball-net.mjs:279-288`). Never an
  ownership write; refused unless I own the ball and it is not in transit.
- `PropBall.onExit({pos, vel, quat, angVel})` (`prop-ball.js:389-393`) → `onPropExit(net, court, camera, info, hold)`: convert
  through `CourtMap.worldToTile` → `tileToCourt(mirrored = true)`, ask `CourtMap.exitEdge`; a real court edge is handed to
  `tickOwner` on the spot (LAUNCH to the neighbour, or `onWall`); `EDGE.NONE` means "not a court exit (front/back/over the top)
  → recentre locally, ownership unchanged". Because every owner frame already calls `net.tickOwner(toCourtBall(...))`, the court
  exit normally fires BEFORE `onExit`; set `boundsR` ≥ the frustum half-diagonal at `mirrorDist` (≈ 1.9 m) so it stays the
  safety net. The task's "derive edge from pos − home against the mirror half-extents" is therefore done by `CourtMap.exitEdge`
  on the converted ball — the same code on every client, no hand-written sign logic.
- While held: `holdFromProp(hold, ball.pos, ball.quat, palmP, palmQ, span)` → the BALL_STATE HOLD_OFFSET block (palm-local
  offset in hand-span units + relative quaternion); remote tiles reconstruct on the RECEIVED hand with `ballFromHold` after
  their own `views.resolve` + `palmPose` (0.03 mm error, (ii)). World position is the fallback when that seat's hand stream is
  older than 150 ms (`sync-protocol.md` §8).
- Late joiner: seed `net.owner / ownerSeq / ownerSimSeat` from the `ball` mirror once, before the first BALL_STATE arrives; the
  next CLAIM or BALL_STATE with a newer epoch overrides it as usual.

Doctrine that survives unchanged: pickup only by wrap / clip / holding-pose cradle from the prop hull; open hand = release;
gravity always on (`GrabbableSphere.update(dt, [], floorY)`); hands support and never pass through; never `jointsWithin` /
pinch / gravity-off seek; there is no "owner" that bypasses physics — ownership only says whose physics is authoritative.

## 5. CLOCK — one `nowMs()` injected

- Relay / WebRTC / ACS: `SharedClock` (`ball-net.mjs:201-222`): CLOCK_PING/PONG, median-of-8 NTP offset (2.3 ms error under
  ±40 ms asymmetric jitter in `smoke-test.mjs`); the relay server or the WebRTC host is the time master; ACS: the host answers
  pings on the same DataChannel.
- Inside Teams: the session clock IS Live Share's global time — `clock.adoptGlobal(timestampProvider.getTimestamp())`
  (`ILiveShareJoinResults.timestampProvider`, host-synchronised; or `ILiveShareHost.getNtpTime().ntpTimeInUTC`); re-adopt every
  10 s. Do not build a second clock (`sync-protocol.md` §3).
- Every module takes the clock by injection: `BallNet({ clock })`, `RemoteSeat({ localNow })`, `encodeHandStream(..., tMs =
  clock.now())`, `RemoteSeat.read(nowMs = clock.now())`. Packet `t` and `nowMs` MUST be the same clock; `ageMs = dt32(nowMs, t)`
  (u32 wrap-safe) is the one-way age the HUD shows and `handAgeAlpha` fades with. `sinceArrivalMs` (local) is exposed for
  HUDs before the clock has converged. `Date.now()` never appears on the wire.

## 6. ENVELOPE on `BroadcastChannel('hopeos-room')`

The frozen page posts `{ v:1, kind:'presence', t, cut, cal, profile, players:[…], balls:[] }` (`mpbrowser.html:850`, `:3266`,
`:4290`), fire-and-forget. Extension (untouched presence): **`{ v:1, kind:'wire', from, reliable, bytes:ArrayBuffer }`** —
structured clone carries the `ArrayBuffer` (verified in Node, `wire-smoke.mjs` (v)). Rules: presence listeners ignore
`kind:'wire'`; wire listeners (`unwrapRoom`) ignore any other `kind`, any other `v`, and their own `from`. `LoopbackTransport`
(patched `transports.mjs:96-112`) implements it and defaults to this channel (was `'teams-football'`). The codebase note's
proposal to add `kind:'hands'` / `kind:'ball'` JSON (`multi-person.md:40`) is superseded by carrying the binary packets.

## 7. The receiver chain (drop-in for `TilePipeline` on a remote tile)

```js
import { RemoteHands } from './remote-consumer.mjs'; import { handAgeAlpha } from '../../game/examples/latency-cues.mjs';   // browser
const remote = new RemoteHands({ alpha: handAgeAlpha, predMs: 0, localNow: () => performance.now() });
transport.onMessage(buf => remote.onMessage(buf));                     // BallNet subscribed itself in its constructor
// per remote tile, per frame (steps 2-5 of codebase/multi-person.md §2 unchanged):
const rd = remote.read(seat, clock.now());                             // { hands:{left,right}, ageMs, seq, alpha, hold, present }
for (const slot of remote.slotsToDrop(seat, clock.now())) tile.views.dropSlot(slot);   // 400 ms rule → latches reset
const packs = tile.views.resolve([rd.hands.left, rd.hands.right], tile.camera);        // measured chirality, own z-sign latch
tile.rigR.pose(packs.R, cols); tile.rigL.pose(packs.L, cols); /* HandBody.update per slot; PropBall.update only in the owning tile */
tile.setAlpha(rd.alpha);                                               // stale cue: 1 → 0.5 between 150 and 400 ms
```
Two hands per seat only: a shared-camera tile with N people (`initMultiplayerTracking`) sends N packets with distinct seats
(`tileId + '#' + moveNetId` is the roster name; the seat map assigns each its u8 seat).

## 8. Supersedes table

| Older statement (file:line) | Status | Replacement |
|---|---|---|
| `game/sync-protocol.md:130` "HAND_STREAM 0x30: the existing landmark relay packet (21 × 3 quantized per hand, PlayerFrame id) — unchanged" | superseded (no such packet existed) | §2 byte layout; 42 × 3 per hand (img + world); `seat` u8, not a PlayerFrame id |
| `game/examples/ball-net.mjs:59` `header()` module-private; `:454` default-branch comment | patched copy `ball-net.mjs` (+ `writeHeader`, `PROTO_VER` export; court-map import path; comment) | `hand-stream.mjs` imports the writer instead of copying it |
| `game/examples/transports.mjs:90` channel `'teams-football'`, ad-hoc `{from, bytes, reliable}`; `:221` 50 ms throttle per transport | patched copy `transports.mjs` | `'hopeos-room'` + `{v:1, kind:'wire', …}` (§6); per-type latest bundle every 50 ms (§3) |
| `codebase/multi-person.md:40` "extend the presence packet with `kind:'hands'` and `kind:'ball'`" | superseded | binary `HAND_STREAM` / ball packets in the `kind:'wire'` envelope; everything else in §2.2 (both `img` and `world`, no pre-flip, no re-filter, `predMs`) is adopted verbatim |
| `codebase/multi-person.md:75` and `codebase/ball-extraction-plan.md:93-95` `kind:'ball'` teleport envelope, page-derived edge | superseded | `ball-extraction-plan.section6.md`; `court-bridge.mjs onPropExit`; BallNet LAUNCH/CLAIM |
| `meeting-app/stage.html:15-30` model, `:123-129` `feedHand/claimBall/passBall`, `:176-178` `initialObjects`, `:215-248` LiveState ownership, `:270-277` JSON packet `{seq, tile, hand}` (one hand, image only, ~1.2 KB) | patched copy `stage.html`; diff in `stage-adapter.md` | base64 `HAND_STREAM` bundled on `ballEvent`; `ball` LiveState = mirror; HUD reads seq/t via `readHeader`; `feedHands(hands)` |
| `meeting-app/SUMMARY.md:14, :27, :30` "30 Hz over LiveEvent", "quantise to int16+base64 (~250 B) if loss climbs"; `NOTES.md:19` same estimate | superseded | 20 Hz max bundled fallback, WebRTC preferred in-Teams (§3); real size: 516 B → 688 B base64 |
| `frameworks/examples/teams-liveshare-ball.js:26-33, :56-63` holder + throwEvt/catchEvt, unowned in flight; `frameworks/SUMMARY.md:27` `{holder, pos, vel, t}` with release/accept events | superseded | BallNet (§4); `LiveState` keys carry LAUNCH/CLAIM bytes, LiveEvent carries the bundle |
| `frameworks/SUMMARY.md:15` "Live Share for authority only, never per-frame data" | kept as the preference; the LiveEvent hand stream is an explicitly labelled fallback pending measurement (§3) | WebRTC data channels signalled via Live Share |
| `ui/overlay-sketches.md:62-64` relayed `img` "in un-mirrored [0,1] tile units" | superseded | §1.6: sender-mirrored `img`, render-only canvas transform, `u * w` draw unchanged |
| `ui/overlay-sketches.md:14-16`, `ui/layout-spec.md:125-127` "the twin un-mirrors self video and landmarks" | clarified | tile-level transform only; landmark arrays never rewritten |
| `game/space-mapping.md:90` "u → 1 − u on `img` landmarks; `world` x → −x when the game starts" | superseded | same as above; `:92` (conversion only in `tileToCourt(mirrored)`) stands |
| `acs/acs-client.html:460` `bitrateInKbps: 64`, `:467` `JSON.parse(dec.decode(msg.data))` | to patch when the wire rides `CH_GAME` | 200 kbps, `readHeader` demux (§3) |
| `MULTIPLAYER_SYNC_ARCHITECTURES.md:41-43` 10-bit delta + keyframes; "feeds these into the SAME One-Euro banks" (repo doc, read-only) | not adopted for v1 | i16 keyframes, no re-filtering (`multi-person.md:40`) |
| `teams-pilot-plan.html` "The packet": hands 2 × 21 × (x,y,z) int16 = 252 B; pose + face in the same packet | refined | hands need both sets (504 B); pose is a separate reserved packet type (§2) |

## 9. Open items (not closable offline)

- Hosted Live Share loss/age at 20 Hz × N senders with the bundle (the stage HUD produces it; needs a tenant).
- ACS DataChannel between two ACS users inside a Teams-interop meeting (`acs-client.html:450-453` NOT VERIFIED).
- WebRTC-via-Live-Share signalling has no example yet (`RtcTransport` expects `signalSend/signalOn`; a `LiveState` pair is the
  natural carrier).
- POSE33 packet (0x31) and a per-seat `HandBody` slot naming (`'left#' + seat`) for the twin's N-tile scene.
- Which host duty splits when the organizer is untracked (`sync-protocol.md` §10) — unchanged by this gap.
