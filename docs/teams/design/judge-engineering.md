# Judge: engineering feasibility and correctness

Lens: can this be built in one day of parallel agents on top of what is actually on disk, and is it correct where it
touches the doctrine, the frozen files, the wire, and the render path. Written 2026-09-19 after re-verifying the research
artifacts and the repo (nothing under `C:/Users/hanna/iosandbox` modified). `R` = `scratchpad/research`.

## 0. What I verified on disk before scoring (applies to all three)

| Claim shared by the designs | Verified | Note |
|---|---|---|
| `R/command-agent/test-mock.mjs` 114/114 | yes, ran it | 114 passed, 0 failed |
| `R/codebase/sandbox-skeleton/tests/prop-ball-smoke.mjs` 23/23 | yes, ran it | 23 passed |
| `R/game/examples/smoke-test.mjs` (BallNet, 60-throw fuzz, 0 conflicts) | yes, ran it | all sections passed, handoff p95 224 ms at 120+/-30 ms |
| `R/gaps/wire-protocol/wire-smoke.mjs` 7 sections | yes, ran it | all sections passed; (vii) shows a **world +x exit in the mirror scene maps to court EDGE.L** under `tileToCourt(mirrored=true)` |
| `ws` available for `tools/relay-server.mjs` | yes | `node_modules/ws` 8.21.0 (transitive); not in `package.json` devDependencies yet |
| `puppeteer-core`, `three` 0.160.0, Node v25.2.1 | yes | |
| design S single-surface renderer code (`setViewOffset`, scissor, layers 1+i, matcap) | yes | `R/gaps/render-budget/render-budget.html:192-213,296,421-423`; `decision.md` §2 U = 1.8652 m, §4 contexts = 5 at 9 tiles |
| `CourtMap` API: `tileToCourt(seat,u,v,mirrored)`, `exitEdge`, `neighbourAt`, `predictExit`, `courtToViewerPx`, `buildSeatMap` | yes | `R/game/examples/court-map.mjs:59,116,159,174,205,226`; `exitEdge` has NO bottom option; `neighbourAt` handles L/R/T only |
| `BallNet` hooks (onBecameOwner, onLostOwner, onOwnerChanged, onRemoteState, onLaunchSeen, onWall, onGoal, onRespawnLocal, onSeatMap), `TUNING`, `SharedClock` | yes | `R/gaps/wire-protocol/ball-net.mjs`; `tickOwner` calls `court.exitEdge(seat,x,y,R)` at `:285` with no flag; ghost integration `:371-372` uses the ghost seat's `floorY` |
| `transports.mjs`: `MemHub`, `MemTransport`, `LoopbackTransport({latencyMs,jitterMs,lossPct})`, `WsRelayTransport`, `RtcTransport`, `LiveShareTransport` | yes | `:58,86,95,118,143,198` |
| `hand-stream.mjs`, `remote-consumer.mjs` (`RemoteHands.read/onMessage/slotsToDrop`), `throw-detect.mjs` (`release(hand, how)`, statics), `latency-cues.mjs` exports | yes | |
| `PropBall(scene, {radius,gravity,restitution,mesh,home,floorY,boundsR,spawnOffset,onExit,onGrab,onRelease})`, `update(dt, pk, hb)`, public mutable `floorY` | yes | `sandbox-skeleton/sdk/game/prop-ball.js:135-400` |
| `TilePipeline.detect(now, dt, cols)` returns `{packs, handL, handR, body}` | yes | **it does NOT return the raw `out.hands` `{left:{img,world}, right:{img,world}}`** that every design feeds to `encodeHandStream`; a 1-line edit, but "verbatim" is false for two designs |
| `tools.json` enums | yes | `attach: left_hand|right_hand|either_hand|world_front|table`; `behavior: seek_hand|orbit_hand|follow_gaze|flee_hand|idle|land_on_hand` |
| `host-harness.html` Mode B verified in headless Chrome (all 4 modes PASS) | yes | `R/video-effects/SUMMARY.md` table; sharedFrame needs `crossOriginIsolated` — `R/video-effects/serve.mjs` sets COOP/COEP, **`tools/dev-server.mjs` sets neither** |
| Chrome fake camera has no hands; synthetic pack generators at `tests/_glassprobe.mjs:32-56` | yes | |
| `HoloHandRig` has no layer API; render-budget sets layers via `rig.grp.traverse(o => o.layers.set(...))` | yes | `hand-rig.js`, `render-budget.html:296` |

## 1. demo-first (`design/demo-first/DESIGN.md`)

| Criterion | Score | Reasoning |
|---|---|---|
| Buildability | 8 | ~2.4 k new lines on ~7 k verified copies; every new module has a Node test or a probe assertion; T0 serial then four parallel lanes; explicit import-path fixes; loopback + clone + bot make the whole demo rehearsable on one laptop with no key. Deductions: T5 "page assembly" is an 8 h single-integrator bottleneck (should be split: loop/URL/HUD vs `ball-game.js`); `body-layer.js` at ~90 lines is optimistic (needs the `mirrorPoint` + `BodyPose.stabilizeMirror` + 33-bank chain from handlab); `tile-pipeline.js` must also expose `out.hands` for step [3] (not in its +30 list). |
| Doctrine | 9 | [D1]-[D7] checkpoints map one-to-one onto the lane (`GrabbableSphere.update(dt, [], floorY)`, `_wrapGrab`/`_holdPose`, pushOut <= 2 cm, z-only/x-z seeks); `extraBodies` is pushOut-only (BodyBody never grabs); executor spawns at the measured pocket with gravity on, never parents, refuses unknown behaviours instead of faking; keyboard hand is a synthetic pack through `_wrapGrab`; receiver re-measures chirality with its own `HandViews`; static greps listed; never imports the frozen page. |
| Demo impact | 9 | Minute-by-minute two-laptop script with what each beat proves; latency HUD numbers are the pitch; honest Teams-API tab with status pills; body + hot-potato + voice-apple beats; solo rehearsal fallback. |
| Latency design | 8 | BallNet scheduled handoff, 30 Hz HAND_STREAM, latest-wins, stale alpha, bands drive UI not physics, Play-together gated on 8 clock samples, HANDOFF_TIMEOUT tuned from HUD at rehearsal, TCP HOL risk named with the RTC seam. Lacks game-feel-first's in-tile arrival prediction (cue lead stays at gutter time). |
| UI fidelity + a11y | 8 | Generated Fluent tokens, rule B grid, stacking order, DOM ids for probes, roving tabindex, throttled live regions, reduced-motion gate, contrast pairs from the token package, six reference rectangles snapshotted. Less privacy chrome than integration-first. |
| **Total** | **42** | |

**Best ideas to graft**
- `court-space.DISPLAY_MIRRORED` single-flag court orientation (§7.3): keep every tile in mirrored space and define the court there; zero flips in the hand chain, one pure-function flag, guarded by `court-space-smoke` "screen-right exit -> right neighbour". This is the only design whose mirror story is consistent with a shared WebGL surface (see flaws of the other two).
- Per-frame flow with numbered doctrine/chirality checkpoints (§5) — the build plan can cite them.
- `Room` module (PRESENCE 0x21, host = lowest clientId, seat-map publication, ping cadence) and `bot-pass-smoke` over `MemHub` with 3 bots.
- Play-together disabled until `clock.samples >= 8`.
- Honest executor: unknown behaviour -> `{ok:false, reason}`; `either_hand` = tracked hand with `openness > 0.6`.
- `?transport=loopback&tiles=2&clone=1&bot=1&agent=local` rehearsal URL and the 10-minute script.

**Concrete flaws**
- `TilePipeline.detect` does not surface `out.hands`; step [3] cannot encode without it (add `this.hands = out.hands` in the +30-line edit).
- T5 (8 h) is on the critical path with one builder; split it.
- Bots never touch the hull (acknowledged) — the two-window probe is the only automated doctrine-across-the-wire check.
- `extraBodies` in `prop-ball.js` re-opens the 23/23 lane; the design adds a 24th check, good, but the body layer feeding it is a stretch task.
- `setLayer` on rigs must traverse `rig.grp` (mesh + occluder twin), not `rig.mesh` alone.
- PRESENCE 0x21 is new on the wire (acknowledged); C2 integration will need `mirroredInput:true`, so `court-bridge` carries two conventions.

## 2. game-feel-first (`design/game-feel-first/DESIGN.md`)

| Criterion | Score | Reasoning |
|---|---|---|
| Buildability | 6 | Same verified copy set, but more genuinely new glue: a 7-phase feel state machine, `ArrivalPredictor`/`MissCue`/`TransitDraw`, `sfx.js`, `hands-2d.js`, `session.js`, `courtGrid`, a `BotTile` that runs its own `PropBall` + `BallNet`, and a vertical slam/lob rule. The vertical rule contradicts "ball-net verbatim": `BallNet.tickOwner` (`:285`) calls `exitEdge(seat,x,y,R)` with no bottom flag and `:287` computes `cEdge` only for T; the ghost integrator (`:371-372`) bounces on `floorY`, so a slam-down ghost never leaves the tile; `predictExit` cannot predict slams, so the headline `ArrivalPredictor` is blind to vertical passes. That means editing the fuzz-verified BallNet and re-running the fuzz. "tile-pipeline verbatim" also needs `out.hands`. Six parallel wave-1 lanes are well cut, but the integrator wave carries the state machine + a11y + all cues. |
| Doctrine | 8 | CP1-CP7 are correct and testable; catch assist is friction only; two-hand scale locked during arrival; drop-on-tracking-loss clamped so a lost hand never flings. Deductions: the slam/lob windows lower `PropBall.floorY` by 2U for 600 ms — gravity stays on, but a tile with no floor is a lane-environment hack the freeze was meant to avoid, and a failed window closure is a real failure mode (acknowledged); keyboard "virtual cradle" injects a 1.6 u/s release velocity chosen by the game, not measured from the pack; `set_behavior 'follow_hand'` and `spawn_object {placement:'in_hand'}` are not in `tools.json` (`seek_hand`, `attach: either_hand`), so the executor and the prompt would disagree — its own risk 7. |
| Demo impact | 8 | The latency-hiding argument becomes visceral: dashed predicted ring, panned whoosh before the ball, slow-mo gutter, HOLDING/THROW/INCOMING/MISS/CATCH chips, keeper saves, solo practice mode. Less explicit demo script; sound in a meeting is a liability (acknowledged). |
| Latency design | 9 | `ArrivalPredictor` from BALL_STATE turns the cue lead from gutter time (27-80 ms) into in-tile flight time (400-900 ms) with zero extra packets, using `CourtMap.predictExit` that already exists; audio leads vision; per-seat bands from p95; `clockErrMs` amber; `dt` clamp so a hitch is never a fling; `FEEL` constants in one table. |
| UI fidelity + a11y | 8 | Same token/layout base; court-completion grid (goal/wall cells) is a deliberate, game-mode-only deviation from Teams' centred rows; chips + rings never colour-only; potato timer announced; reduced motion keeps timing as a "+120 ms" chip. |
| **Total** | **39** | |

**Best ideas to graft**
- `ArrivalPredictor` (predict exit on every free-flight BALL_STATE; dashed ring until LAUNCH confirms; blend edge changes over 100 ms).
- `sfx.js` synthesized, `StereoPannerNode`-panned cues with `M` mute and `nosfx=1` (every cue has a text twin).
- The phase state machine table (§7.1) and tile chips — the build plan should adopt the vocabulary even if the vertical rule is dropped.
- `ThrowDetector.release` classification: drop / throw / clamped; `how='lost'` -> drop clamped 0.3 u/s.
- `dt` clamp `[1/120, 1/30]` before physics.
- Solo practice mode (walls) as the 1-tile default.
- `[feel]` constants table with sources, tunable only there.

**Concrete flaws**
- Mirror contradiction: the court is un-mirrored (`tileToCourt(mirrored=true)`) but the design never un-mirrors the tile display (space-mapping §7 says it must). Under wire-smoke (vii) a screen-right exit is court EDGE.L, i.e. it arrives at the neighbour displayed on the LEFT of a seat-ordered gallery — the opposite of what risk 6's probe asserts. Fixing it by un-mirroring the video hits the shared-surface problem (rigs/ball live on one stage-level WebGL canvas that CSS cannot flip per tile). Adopt demo-first's flag or a mirrored projection for the local camera.
- Vertical rule requires BallNet edits (`tickOwner` edge/`cEdge`, ghost floor) and `predictExit` awareness — not the "verbatim" adoption claimed; budget it or drop to `vertical:'none'` from the start.
- `Space` is overloaded: catch during INCOMING vs push-to-talk when the command bar is focused.
- `hands-2d.js` draws 2D hands on a per-tile canvas while rigs are also drawn on the surface — when each is used is unspecified.
- Tool/argument names off the schema (`follow_hand`, `placement`).
- `tile-pipeline.js` needs `out.hands` exposed.

## 3. integration-first (`design/integration-first/DESIGN.md`)

| Criterion | Score | Reasoning |
|---|---|---|
| Buildability | 5 | The core twin (L1-L5) is comparable to demo-first and cleanly factored (`RemoteTile`, `hand-sources.js`, `gated()` transport). On top: `OutgoingSink` with a second WebGL renderer, `TeamsHostShim` extracted from the harness, `AcsTransport`, three `MeetingHost` implementations, `apps/teams-effect`, `apps/teams-stage`, `apps/acs`, privacy pages, consent gating — L6/L7 are verifiable only by `node --check` and a fake-camera effect probe. That is roughly 1.6-2x demo-first's surface for one day, and two integration-level assumptions are wrong or missing: (a) the mirror rule ("un-mirror the tile via `scaleX(-1)` on the tile's own layers only") cannot flip the rigs and ball, which are drawn on the shared stage-level surface, so after un-mirroring the video the holohands sit on the wrong side of the body; (b) Mode B `sharedFrame` needs `crossOriginIsolated`, and `tools/dev-server.mjs` sets no COOP/COEP (the research used its own `serve.mjs`). "tile-pipeline verbatim" again needs `out.hands`. |
| Doctrine | 7 | CP1-CP10 are sound where they touch the lane (empty hand list, hull vs joint spheres, wrap/cradle only, pushOut for bodies, `mesh.parent === scene` asserted). Deductions: flyer behaviours (`orbit_hand`, `flee_hand`, "flight targets near the palm" for butterfly/bird) under "gravity always on" are undefined — they either lift (breach) or fall; `attach:'nearest_hand'|'floor'|'front'` are not `tools.json` values (`either_hand`, `table`, `world_front`); the N-hand `extra.hands` loop and `extra.bodies` re-open the lane (fine, but re-run 23/23). Chirality: correct (arrays never flipped, per-seat `HandViews`). |
| Demo impact | 7 | Strong answer to "how does this land in Teams": Mode B speaks the real teams-js postMessage protocol, `OutgoingSink` popup is the C1 path, `AcsTransport` is a class not a slide. But the goal rule (held >= 250 ms by the goal tile's owner) cannot score on an untracked/proxied goal seat, contradicting rule 8; the mirror flaw would show in the first cross-tile throw; and half the deliverable is not runnable in the room. |
| Latency design | 8 | Same BallNet/clock/stream base; per-transport rate table (ACS 200 kbps, Live Share 20 Hz bundle, RTC channel split); `ownHandAgeMs` definition; per-seat p50/p95/max/lost; effect-path 45 ms budget with the Worker plan named. |
| UI fidelity + a11y | 9 | The most complete: consent dialog before `getUserMedia`, tracking/external pills, device-only toggle that no-ops `send`, recording/transcription banners, sandbox strip, toolbar roles with arrow navigation, Teams shortcuts, `forced-colors`, honest-limits About panel, a dedicated a11y probe, `gallery-smoke` against the four result tables. |
| **Total** | **36** | |

**Best ideas to graft**
- `RemoteTile` as its own class (feed from `RemoteHands.read`) instead of overloading `TilePipeline`.
- `hand-sources.js` (`LocalCameraSource`, `CloneSource`, `ClipSource`, `BotSource` as a sender) with `PackGen` — bots and clips become plain remote tiles.
- `gated(transport, isSharing)` device-only wrapper and the consent dialog that gates `getUserMedia` (`?consent=1` for probes).
- The four adapter interfaces (`Transport`, `MeetingHost`, `VideoSink`, `HandSource`) as the documented seams — even if only `TwinHost`/`Loopback`/`WsRelay` ship on day one.
- `OutgoingSink` crop mode (2D canvas: video + surface crop -> `captureStream(30)`) is cheap and gives a real C1 demo without a second renderer.
- `stage-scene-smoke.mjs` camera-math Node test (U, `projectedRadius = R_court*th` at four rectangles, no WebGL).
- Teams-API tab rows with live numbers and per-row tenant/policy gates.

**Concrete flaws**
- Mirror rule breaks on the shared surface (above); needs a mirrored projection for `camera_s0` (negate projection x, reverse face culling) or demo-first's flag.
- COOP/COEP absent on the dev server for Mode B sharedFrame.
- Scope: L6 + L7 + privacy pages are not a one-day fit next to the core twin; make them a second day.
- `attach` enum mismatch with `tools.json`; flyer behaviours undefined under the doctrine.
- Goal rule unreachable for proxied goal seats.
- `tile-pipeline.js` needs `out.hands` exposed.

## 4. Ranking and recommendation

1. **demo-first — 42.** Smallest new-code surface, every new module has a test, and it is the only design whose mirror convention survives design S's single shared WebGL surface. Winner from the engineering lens.
2. **game-feel-first — 39.** Best latency ideas on the table; the vertical rule and the un-addressed mirror contradiction are the cost. Graft `ArrivalPredictor`, `sfx.js`, the phase/chip vocabulary and the throw classification onto demo-first; drop slam/lob to `vertical:'none'`.
3. **integration-first — 36.** Best a11y/privacy and the cleanest module boundaries; too much surface for one day and a mirror rule that does not work on the shared surface. Graft `RemoteTile`, `hand-sources.js`, `gated()`, the consent gate, `OutgoingSink` crop mode and the adapter interfaces; defer `apps/*`, `TeamsHostShim`, `AcsTransport` to day two.

Cross-cutting fixes the synthesizer must write into CONTRACTS.md regardless of winner: (1) `TilePipeline.detect` exposes `hands` (raw `PlayerPipeline` shape) for the encoder; (2) one court-orientation rule, tested by a "screen-right exit -> displayed-right neighbour" Node check; (3) executor argument names are exactly the `tools.json` enums; (4) any `prop-ball.js` extension re-runs the 23 checks plus its own; (5) `ws` added to devDependencies; (6) rigs are put on layers by traversing `rig.grp`.
