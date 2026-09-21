# stage-adapter — the diff from `research/meeting-app/stage.html` to `gaps/wire-protocol/stage.html`, and from `ball-extraction-plan.md` §6

Both patched files are COPIES in this folder; the canonical files are untouched. Line numbers on the left are the canonical
`research/meeting-app/stage.html` (340 lines); on the right the patched copy (419 lines). The HTML/CSS shell is the same except
for label text and the rate selector default; every change is in the module script and the header comment.

## A. `stage.html`

| Canonical | Patched | Change |
|---|---|---|
| `:7-48` header: "LiveEvent broadcasting a hand packet at 30 Hz", "LiveState holding ball OWNERSHIP", `feedHand/claimBall/passBall` | `:7-56` | model restated: HAND_STREAM + BALL_STATE bundled on one LiveEvent, LAUNCH/CLAIM/GOAL/SEAT_MAP on LiveState keys, `ball` LiveState = mirror; hooks `feedHands / feedHand (shim) / setHold / passBall / claimBall (deprecated → kick-off)`; rendering rule (render-only un-mirror) |
| `:83` `<select id="rate">` default 30 Hz | `:90` | default `20 Hz (Live Share max)`; 30 Hz kept for the knee measurement (`hopeos-wire.md` §3) |
| `:81-82` "Take ball" / "Pass to next tile" | `:88-89` | "Kick off (host)" / "Throw to next seat" — the buttons no longer write ownership |
| `:105` esm.sh import | `:112-118` | unchanged esm.sh import + the five wire modules (`hand-stream.mjs`, `remote-consumer.mjs`, `ball-net.mjs`, `transports.mjs`) and `../../game/examples/court-map.mjs` |
| `:116-121` tile letter from `sessionStorage` (A-H) | removed | the seat comes from the SEAT_MAP (`net.seat`), authored by the host from the presence roster (`publishMap`, `:239-245`) |
| `:123-137` `window.hopeos.feedHand(landmarks21)`; `syntheticHand` = one 21-point blob as `[x,y,z]` arrays | `:125-149` | `feedHands(hands)` takes the PlayerPipeline output `{left:{img,world}, right:{img,world}}` untouched; `feedHand` shim wraps arrays into `{x,y,z}` on the `right` slot; `setHold(hold)`; `syntheticHands` = two hands with a world set |
| `:173-180` `initialObjects: { packets: LiveEvent, presence: LivePresence, ball: LiveState }` | `:183-191` | `{ ballEvent: LiveEvent, launch/claim/goal/seatMap: LiveState, presence: LivePresence, ball: LiveState }` — the shape `LiveShareTransport` expects plus presence and the mirror. `initialObjects` are frozen per container: a new meeting / cleared `#containerId` is needed once |
| `:183` `const now = () => timestampProvider.getTimestamp()` | `:194-198` | `SharedClock.adoptGlobal(timestampProvider.getTimestamp())` every 10 s; `now = () => clock.now()` — the u32 session clock every header `t` carries (`hopeos-wire.md` §5) |
| — | `:209-213` | `const tr = new LiveShareTransport(container.initialObjects); await tr._init()` (patched transport: 50 ms bundle, LiveState keys); `myId = tr.id` (the LiveEvent clientId) |
| `:195-213` presence rows by tile letter | `:215-222`, `:325-333` | presence data carries `{ wireId: myId }`; roster sorted by wire clientId; **host = lowest wire clientId** (inside Teams gate with `UserMeetingRole` — `sync-protocol.md` §2); roster rows show the seat |
| `:215-249` `ballState {owner, goal, n}`; `setBall(owner)` = `ball.set(...)`; `claimBall = () => setBall(myTile)`; `passBall = (tile) => setBall(tile)` | `:224-283` | `BallNet` over `tr` with hooks; `courtBall` integrated with `integrateCourt` when I own it (the 3D twin converts `PropBall` through `court-bridge.mjs` instead); `ball.on('stateChanged')` only seeds a late joiner's `owner/ownerSeq/simSeat` and renders; `mirrorBall()` is written by the HOST from `onBecameOwner`/`onOwnerChanged`; `claimBall()` → `net.kickoff` (host, nobody owns) else refused; `passBall(seat)` → velocity toward that seat's edge; the LAUNCH is emitted by `net.tickOwner` at the edge |
| `:251-265` `remote` Map keyed by clientId, `evt.seq` gap counting, `evt.hand` latest-wins in page code | `:288-299` | `RemoteHands` (`remote-consumer.mjs`) does latest-wins per seat; the HUD wrapper on `tr.onMessage` filters `readHeader(buf).type === PK.HAND_STREAM`, reads `seq`/`t` from the header and computes `age = dt32(now(), t)` on the shared clock; `gaps / stale` come from `remote.seat(seat).stats` |
| `:269-282` sender: `packet = { seq: ++seq, tile: myTile, hand }` JSON (~1.2 KB), `packets.send(packet)` | `:301-323` | `bytes = encodeHandStream(net.seat, hands, hseq++, now(), { hold: localHold })` → `tr.send(bytes, { reliable: false })`: the transport base64s and bundles it with `BALL_STATE` (from `net.tickOwner`) into one signal per 50 ms; `net.tick()` and the ghost dead-reckoning run in the same tick; `#bytes` shows the binary size (516 max) |
| `:284-296` HUD per clientId | `:334-347` | HUD per seat: hz, age p50/p95/max from header `t`, `gaps / stale` |
| `:298-319` draw: `x * w, y * h` for every hand; ball ring on the owner's wrist | `:350-402` | tiles laid out from `court.rects`; every tile (mine included) drawn UN-MIRRORED by `g.translate(right, top); g.scale(-1, 1)` — a render-only transform, arrays untouched (`hopeos-wire.md` §1.5); remote hands from `remote.read(seat, now())` with `alpha`; `remote.slotsToDrop` is where the 3D twin calls `views.dropSlot`; ball: owner → `courtBall`, non-owner → dead-reckoned ghost, or on the RECEIVED hand of the owner's seat while `lastRemote.hold.mode !== FREE` (2D palm-centre stand-in for `court-bridge.ballFromHold`); yellow ring while in transit |
| `:322-337` camera probe, `main()` | unchanged | |

What the patched page does NOT do (and says so): it never decides a grab (no hull, no doctrine — `setHold` is fed by the 3D
page), never writes ownership from a button, never reads `ball` LiveState to decide who owns the ball, never flips a landmark
array. `node --check` of its module script and the absence of the old JSON packet are asserted by `wire-smoke.mjs` (vi).
Still NOT verified (needs a tenant / tinylicious run): a live Live Share session through esm.sh, the bundle's measured age.

## B. `research/codebase/ball-extraction-plan.md` §6 → `ball-extraction-plan.section6.md`

- `:93` page-derived edge from `pos − home` vs half-extents → `court-bridge.mjs onPropExit` (CourtMap.exitEdge on the converted
  ball); the per-frame `net.tickOwner(toCourtBall(...))` normally launches before `onExit` fires; `boundsR` ≥ frustum half-diagonal.
- `:94` `kind:'ball'` JSON teleport over `hopeos-room` → LAUNCH/CLAIM bytes in the `kind:'wire'` envelope; receiver places the
  ball from `onBecameOwner(claim)` with gravity on; catch by wrap/clip/cradle only.
- `:95` goal counts `kind:'ball'` packets → `BallNet.declareGoal` / GOAL 0x14.
- Everything else in the file (sections 1-5, the 23/23 smoke test) is unchanged and still the authority on the doctrine lane.

## C. Other canonical files touched only by description (no copy needed)

- `research/codebase/multi-person.md:40` — keep the packet rule (both `img` and `world`, no pre-flip, no re-filter, `predMs`);
  replace "extend the presence packet with `kind:'hands'` and `kind:'ball'`" with the `kind:'wire'` binary envelope.
- `research/ui/overlay-sketches.md:62-64` — "un-mirrored tile units" → "sender-mirrored `img`; the canvas stack carries the
  render-only `scaleX(-1)`; the `u * w` draw call stays".
- `research/game/sync-protocol.md:130` — replace the sentence with a pointer to `hopeos-wire.md` §2.
- `research/acs/acs-client.html:460, :467` — `bitrateInKbps: 200`, demux `msg.data` with `readHeader` when the wire packets
  ride `CH_GAME`.
