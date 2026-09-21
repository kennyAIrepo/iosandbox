# SUMMARY — wire-protocol gap: one landmark packet, one ball-ownership model (2026-09-18)

Folder `research/gaps/wire-protocol/`. Closes the gap that the memo's "relay ~600 B landmark packets at 30 Hz" had no packet,
that five topics disagreed on frames and rates, and that four incompatible ball-ownership designs existed. Nothing under
`C:/Users/hanna/iosandbox` or under the canonical `research/<topic>/` folders was modified; superseded statements are listed
with file:line in `hopeos-wire.md` §8 and patched COPIES live here.

## Decisions (authoritative in `hopeos-wire.md`)

1. **Frames.** Packet `img` = exactly what the sender's `PlayerPipeline` emitted (mirrored display space, `player-pipeline.js:175`,
   `:203-208`); `world` = raw metric. Nobody pre-flips, re-filters or relabels. Un-mirroring is a RENDER-ONLY tile/canvas
   transform (ui) and a court-only `CourtMap.tileToCourt(mirrored=true)` (game). `ui/overlay-sketches.md:62-64` ("un-mirrored
   tile units") loses to `codebase/multi-person.md:40`; the `u * w` draw call stays. Every receiver measures chirality with its
   own `HandViews` (`hand-views.js _chirality/_zSign`).
2. **HAND_STREAM 0x30** (`hand-stream.mjs`): 8-byte ball-net header (type, flags|ver, seq u16, t u32) + seat u8 + hflags u8
   (present L/R, world L/R, POSE33 reserved) + hold u8 (informational) + pad; per present slot 21 × (u,v,z) i16 × 32767
   (range [-1, 1]) and, when present, 21 × (x,y,z) i16 mm. **516 B two hands, 264 B one hand, 12 B heartbeat**; quantisation
   error 1.53e-5 img / 0.5 mm world, asserted at load and in the test. Pose33 = a future separate packet (0x31) so ≤ 600 B holds.
3. **Rates.** Loopback 30 Hz · ws relay 20-30 · WebRTC 30 (unreliable channel carries hands + BALL_STATE) · ACS DataChannel 30
   (60 pkt/s of the 80 pkt/s budget, 135 kbps < 200 kbps High-priority Lossy) · Live Share LiveEvent **20 Hz max, one bundled
   signal per 50 ms carrying the latest packet of each type**, latest-wins. Inside container D the LiveEvent hand stream is a
   FALLBACK pending measurement; WebRTC data channels signalled via Live Share are the preferred in-Teams pose path.
4. **Ball ownership = `BallNet` only** (LAUNCH/CLAIM/ACK, `ownerSeq`, court units, scheduled `tEdge'`). `LiveState ball` is a
   mirror `{owner, ownerSeq, simSeat, goal, n}` for late joiners/HUD. Superseded: codebase `kind:'ball'` teleport, meeting-app
   immediate `claimBall/passBall` set, frameworks `holder + throwEvt/catchEvt`. Mapping (`court-bridge.mjs`): `claimBall` →
   host `kickoff` only; `passBall(seat)` → a throw, LAUNCH emitted by `tickOwner` at the court edge; `PropBall.onExit` →
   `onPropExit` (convert via `worldToTile → tileToCourt(mirrored=true)`, `CourtMap.exitEdge`, launch or recentre); hold →
   `holdFromProp` / `ballFromHold` for the HOLD_OFFSET trailer.
5. **Clock.** `SharedClock` (ping/pong, median of 8) on relay/WebRTC/ACS; `adoptGlobal(timestampProvider.getTimestamp())`
   inside Teams; one injected `nowMs()`; `ageMs = dt32(nowMs, t)`; `Date.now()` never on the wire.
6. **Envelope.** `BroadcastChannel('hopeos-room')`: `{ v:1, kind:'wire', from, reliable, bytes:ArrayBuffer }` next to the
   frozen page's `kind:'presence'` (untouched). `LoopbackTransport` patched to use it.
7. **Receiver** (`remote-consumer.mjs`): `RemoteHands.push/onMessage` (latest-wins per seat by `seqNewer16`),
   `read(seat, nowMs)` → PlayerPipeline shape + `ageMs, seq, alpha` (`handAgeAlpha` copied from `latency-cues.mjs:127`, which
   imports three.js), optional linear extrapolation `predMs` ≤ 100 ms (default 0), `slotsToDrop` for the 400 ms latch reset.

## Supersedes (short; full table `hopeos-wire.md` §8)

`sync-protocol.md:130` (phantom packet) · `ball-net.mjs:59/:454` (3-line patch) · `transports.mjs:90/:221` · `multi-person.md:40/:75`
· `ball-extraction-plan.md:93-95` · `stage.html:15-30/:123-129/:176-178/:215-248/:270-277` · `meeting-app/SUMMARY.md:14,:27,:30`,
`NOTES.md:19` · `teams-liveshare-ball.js:26-33/:56-63`, `frameworks/SUMMARY.md:27` · `overlay-sketches.md:14-16/:62-64`,
`layout-spec.md:125-127` · `space-mapping.md:90` · `acs-client.html:460/:467` · memo "The packet" (hands = one set).

## Verification (Node v25.2.1, no network)

`node research/gaps/wire-protocol/wire-smoke.mjs` — **7/7 sections passed**:
- (i) codec: 516 B two hands, 138/264 B one hand, 12 B heartbeat; header read by `ball-net.readHeader`; imgErr 1.5e-5, worldErr 4.1e-4; wrap, clamps, POSE33 rejected, base64 lossless.
- (ii) BallNet + RemoteHands demuxed on ONE MemTransport (20 ball packets ignored by RemoteHands, hands ignored by BallNet); HOLD_OFFSET resolved on the RECEIVED hand through the real `HandViews.resolve` + `palmPose`: **ball position error 0.033 mm, orientation 1e-4 rad, mesh chirality 'R' measured identically on both ends**; age 81 ms on the shared clock at 90 ± 20 ms latency.
- (iii) 3 senders @ 30 Hz, 60 ± 40 ms, 5 % loss: 1724 accepted, **327 reordered packets rejected as stale**, monotone wrap-safe chains, seq wrapped through 0xffff, latest-wins == newest delivered, decoded == sent within bounds; extrapolation cap/hold rules.
- (iv) static: `hand-stream.mjs` (155 code lines) and `remote-consumer.mjs` (127) contain no `handedness`, `categoryName`, `1 - x`, negated `.z`, `zSign`, mirror/flip/swap.
- (v) `hopeos-room` envelope in Node's BroadcastChannel: presence ignored, 516 B + 34 B ArrayBuffers delivered, own echo dropped.
- (vi) `handAgeAlpha` equals the canonical source at 10 ages; patched `stage.html` module passes `node --check`, old JSON packet gone.
- (vii) `court-bridge`: world +x exit in the mirror scene → court `EDGE.L`, velocity sign inherited from the conversion, BallNet LAUNCH to seat 0; non-court exit → `EDGE.NONE`; hold trailer round trip exact.

Baselines re-run, unchanged: `node research/game/examples/smoke-test.mjs` → **all sections passed** (7/7, fuzz 60 throws,
0 conflicts, handoff p95 224 ms); `node tests/prop-ball-smoke.mjs` (sandbox-skeleton) → **23 passed, 0 failed**.

## Hard rules that survive

`mpbrowser.html` and the avatar rig are FROZEN (copied, never imported); PROP COLLISION DOCTRINE unchanged (shape-vs-shape from
the hull; pickup only wrap/clip/holding-pose cradle; open hand = release; gravity always on; hands support and never pass
through; never `GrabbableSphere jointsWithin`/pinch, never gravity-off seek) — ownership only says whose physics is authoritative;
chirality only from `hand-views.js _zSign` on every receiver.

## Remaining unknowns

- Hosted Live Share loss/age at 20 Hz × N with the 50 ms bundle (needs a tenant; the stage HUD measures it).
- ACS DataChannel between ACS users inside a Teams-interop meeting (`acs-client.html:450-453` NOT VERIFIED).
- WebRTC signalling over Live Share `LiveState` keys: designed, not exemplified.
- A real Live Share session through the esm.sh bundle (meeting-app caveat unchanged).
- POSE33 (0x31) packet; per-seat `HandBody` slot strings in the twin's scene.

## Sources

Canonical research files cited above (all under `research/`), repo sources read-only (`sdk/core/player-pipeline.js`,
`multiplayer.js`, `hand-views.js`, `filters.js`, `mpbrowser.html:850/:3266/:4290`, `MULTIPLAYER_SYNC_ARCHITECTURES.md:36-50,
:220-222`), the memo `scratchpad/teams-pilot-plan.html` ("The packet"), Microsoft Live Share FAQ / LiveEvent / LiveState /
INtpTimeInfo and ACS DataChannel limits as already cached in `research/meeting-app/_src` and cited in `transports.mjs` and
`acs-client.html` (no new network fetches were needed for this gap).
