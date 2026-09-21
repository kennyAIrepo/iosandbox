# Judge: product / demo impact + Teams-integration realism

Lens: what convinces a Teams product team, and whether the Teams return paths are described as they actually are in
`research/video-effects`, `research/meeting-app`, `research/acs`, `research/frameworks`. Written 2026-09-19 from the
three `design/*/DESIGN.md` files and the research on disk. Claims were spot-checked against the code the designs cite
(`research/codebase/dropins.md`, `research/codebase/sandbox-skeleton/`, `research/command-agent/tools.json`,
`research/game/examples/*.mjs`, `research/gaps/wire-protocol/*.mjs`, `research/gaps/render-budget/decision.md`,
`research/video-effects/host-harness.html`, `C:/Users/hanna/iosandbox/tests/_glassprobe.mjs:30-58`).

Scale 1-10 per criterion; total = sum (max 50).

| Design | Buildability (1 day, parallel agents) | Doctrine | Demo impact (Teams PM) | Latency design | UI fidelity + a11y | Total |
|---|---|---|---|---|---|---|
| demo-first | 8 | 9 | 9 | 8 | 8 | **42** |
| game-feel-first | 6 | 8 | 8 | 9 | 7 | 38 |
| integration-first | 5 | 8 | 8 | 8 | 9 | 38 |

**Winner: demo-first**, with three grafts from the other two (listed at the end).

## Facts that apply to all three (checked)

- All three adopt design S (one transparent `WebGLRenderer`, scissor per tile, matcap ball, `U = 1.8652 m`) exactly as
  `research/gaps/render-budget/decision.md` §1-2 prescribes; contexts `1 + k + 1`. Correct.
- All three add a new `0x21` presence/roster packet not in `hopeos-wire.md`; none conflicts with `BallNet`/`RemoteHands`
  (`default:` branches). Integration-first is the only one to say what replaces it inside Teams (`LivePresence`, as
  `gaps/wire-protocol/stage.html:33-39` already does). The synthesizer should add 0x21 to the wire doc once.
- All three cite the right Teams-surface facts: C2 `videoEffects` is `@beta`, DevPreview manifest, sideload, issue #24;
  D = configurable tab with `meetingSidePanel` + `meetingStage`, Live Share 1.4.2 on Fluid 1.x, esm.sh unverified,
  anonymous participants cannot see stage apps; C3 ACS DataChannel inside a Teams meeting undocumented; Together mode
  retired. Nobody over-promises; that is the single most important realism check and all pass it.
- `research/command-agent/tools.json` `spawn_object.attach` enum is `left_hand | right_hand | either_hand | world_front
  | table`. Only demo-first uses that vocabulary. Game-feel-first writes `placement:'in_hand'`; integration-first
  writes `attach:'left_hand'|'right_hand'|'nearest_hand'` and `'floor'|'front'`. Both mismatches will cost a builder
  an hour and could silently break the 114-check test if the schema is "fixed" to match the prose.
- `PropBall.update(dt, pk, hb = null)` (`sandbox-skeleton/sdk/game/prop-ball.js:261`) has no body/extra-hand argument;
  every design's body-support extension is real new code (demo-first ~8 lines `extraBodies`; integration-first
  `extra:{hands, bodies}`; game-feel-first does not extend it and only says `withPose` on seat 0).
- `ws` is present in `C:/Users/hanna/iosandbox/node_modules/ws` (transitive); `relay-server.mjs` sends `hello/joined/left`
  JSON frames and answers `CLOCK_PING` as demo-first describes.

---

## demo-first — 42

### Buildability 8
- ~90 % of shipped code is a byte-copy of verified research files (PropBall 23/23, wire 7/7, ballnet 7/7, agent
  114/114); the module table (§4) names the research source and the exported API for every file, and the new glue is
  bounded (~2.4 k lines, six small modules). Every acceptance check is a number a probe can read.
- T0 (copy + wire) is serial and 2 h; T1-T4 are truly independent; T5 (page assembly, 8 h) is the only fat task and it
  has a two-page loopback probe (§11.4) as its gate. Critical path ~20 builder-hours: tight for one day but the
  demo-visible surface is done at T6 and T7/T8 are polish.
- Checked: `court-map.mjs` has `predictExit`, `courtToViewerPx`, `buildSeatMap`; `latency-cues.mjs` exports the eight
  names claimed; `throw-detect.mjs` has the statics `shapeEntry/catchWindowMs/predictPath`; `_glassprobe.mjs:32-56`
  generators exist; `LoopbackTransport` takes `latencyMs/jitterMs/lossPct`. The claims hold.
- Minus: `TilePipeline.poseFromHands` modifies the verified skeleton module instead of wrapping it (integration-first's
  separate `RemoteTile` is cleaner); `room.js` (host election, clock cadence, prune) is a new networking module with no
  research copy behind it; `bot-tile.js` must run in both Node and browser.

### Doctrine 9
- Checkpoints [D1-D7] and [C1] are written into the per-frame flow (§5) and each has a Node or probe assertion. The
  executor is the only enforcement point; unknown behaviours return `{ok:false, reason}` rather than faking motion —
  the safest answer to "make the butterfly fly" under gravity-always-on.
- Keyboard players go through `S.ovPacks` with a synthetic `flat`/`cup`/`open` pack, so there is exactly one hand chain.
- The only deviation is the mirror convention (§7.3), which does not touch chirality (measured per receiver) and is
  isolated in one constant with a guard test. Body support is `hull.pushOut` only.
- Minus: `pass_object` sets `ball.sphere.vel` directly ("throw: set vel toward that seat's edge") — a scripted velocity
  on a free ball is fine, but the text should say it is refused while held (it does: "not held, not in transit").

### Demo impact 9
- The 10-minute two-laptop script (§1.1) with a "what proves the pitch" column is exactly what a product team needs;
  rehearsal insurance (`?transport=loopback&tiles=2&clone=1&bot=1`, `?agent=local`) means the demo cannot be killed by
  Wi-Fi or an API key.
- The HUD chip ("you 34 · B 68 · relay 9") is the pilot argument made visible; the API tab with `demo / seam / probe
  first` pills and the known blocker per row is the honest integration map a PM will screenshot.
- Minus: nothing runs inside real Teams. C1 (virtual camera) is only a row in the table, yet it is the one path that
  works today with no tenant (`OutgoingSink` popup → OBS virtual camera → a real meeting). A PM who asks "show it in
  my client" gets a table. Graft integration-first's `OutgoingSink` popup (below).

### Latency design 8
- Scheduled handoff at `tEdge'`, ghost + arrival ring, HUD ages from `dt32`, clock convergence gates the Play button
  (8 pings), WAN tuning of `HANDOFF_TIMEOUT_MS` from real HUD numbers in T6. Solid and honest.
- Minus: the arrival ring lead is the LAUNCH-to-`tEdge'` window (gutter time, tens of ms at LAN latency) — game-feel-
  first's `ArrivalPredictor` (predict from `BALL_STATE` while the ball is still crossing the thrower's tile) turns that
  into hundreds of ms with zero extra packets and should be grafted.

### UI fidelity + a11y 8
- Tokens generated (never hand-edited), rule B gallery, 48/56/320 anatomy, six reference rectangles snapshot, contrast
  from the token package, colour-never-alone, roving tabindex, live regions throttled, reduced motion via `--tw-motion`,
  "not a Microsoft product" strip.
- Minus: keeps the local tile mirrored in game mode against `ui/layout-spec.md` §3 / `space-mapping.md` §7 (a deliberate
  choice, but it is the one thing a Teams PM might notice: "my right edge" is not what others' clients would show if
  video ever crossed); consent copy is T8 polish rather than a gate before `getUserMedia`; no Teams keyboard shortcuts.

### Best ideas to graft
1. The scripted demo table with a proof column and the rehearsal-insurance URL (§1.1) — adopt verbatim as the spec's
   demo section.
2. `?agent=local` offline grammar as the default when `/api` is absent, so the voice/text beat never depends on a key.
3. `court-space.js` as a single-constant seam (`DISPLAY_MIRRORED`) with a "screen-right exit → right neighbour" guard
   test — whichever mirror convention the synthesizer picks, keep this test.
4. API tab status pills (`demo / seam / probe first`) plus the per-row known blocker.
5. Bots that are full `BallNet` clients on the same transport (roster/ownership fuzz without a second laptop).

### Concrete flaws
- No C1 outgoing sink: the only tenant-free "inside real Teams" beat is missing.
- Mirror convention deviates from the research decision; the synthesizer must choose and the cost is bounded but real.
- `PRESENCE 0x21` and `room.js` are new protocol + new code with no research copy; the design admits it (§13.7).
- `poseFromHands` edits the verified `tile-pipeline.js`; prefer a wrapper.
- T5 (8 h) is a single-builder integration task; if it slips, nothing demo-visible ships.

---

## game-feel-first — 38

### Buildability 6
- Wave 0/1/2/3 is sane and six Wave-1 tasks are parallel, but the NEW surface is larger than it looks: `ball-game.js` is a
  seven-phase state machine with slam/lob windows, potato lives, keeper/save, goal rotation and a constants table;
  `ArrivalPredictor`, `MissCue`, `TransitDraw`, `sfx.js` (WebAudio synthesis), `hands-2d.js`, `gallery.js` with
  `courtGrid`, `session.js`, `twin-hud.js`, and a bot that runs its own `PropBall` + `BallNet` in-process.
- The vertical rule edits the VERIFIED `court-map.mjs` (`buildSeatMap` gains `rows`/`vertical`, `exitEdge` gains
  `{bottom}`, `neighbourAt` handles `EDGE.B`) — the 7/7 fuzz and wire-smoke (vii) must be re-run and may need patching.
- Wave 2 is one integrator assembling the page, tabs, HUD, a11y, URL params after six parallel modules land — the same
  single-builder risk as demo-first's T5 but with more new physics glue underneath.
- `placement:'in_hand'` is not in `tools.json` (`attach: either_hand`); risk #7 warns builders about two lineages and
  then the design itself uses a third vocabulary.

### Doctrine 8
- CP1-CP7 are precise and each has a test; "release is the grab gate failing, never a gesture"; catch assist is
  friction-only; two-hand pinch disabled during transit; keyboard catch/throw through a synthetic cradle pack.
- Minus: the slam/lob rule lowers `PropBall.floorY` for 600 ms so the ball can pass the floor plane. Gravity stays on,
  hands still support, so it is not a doctrine violation, but it bends "floor is a floor" on the frozen lane's own
  constructor option and a window that fails to close leaves a tile with no floor (the design's own risk #1). The
  research recommends vertical passes OFF for the demo; this is feel ambition over safety.
- `follow_hand` is described correctly (z-only bias + x/z pocket pull, never lift). Good.

### Demo impact 8
- This is the design that will FEEL alive: chips (`HOLDING·L`, `THROW`, `INCOMING`, `KEEPER`, `MISS`, `SAVE`), rings,
  panned whoosh/thud/bonk/chime, gutter slow-mo, a marigold GOAL tile with a keeper whose hand in front of the frame is a
  save by doctrine alone, hot potato with lives, and a solo practice mode (throw at a wall, catch the rebound) that makes
  a one-laptop rehearsal a game rather than a test.
- The HUD line "stretch 0/12" and "thrower shows 0 corrections" is a crisp pilot claim.
- Minus: no demo choreography; the Teams-API tab is a set of links ("Open harness"); "court = DOM grid" replaces the
  Teams gallery in game mode with virtual GOAL/wall tiles — memorable, but a Teams PM sees a gallery that is no longer
  Teams' gallery. Sound cues in a meeting with no ducking (risk #9) is a real meeting-etiquette objection.

### Latency design 9
- `ArrivalPredictor` from `BALL_STATE` (cue lead = in-tile flight time, 400-900 ms, zero extra packets; dashed until
  LAUNCH confirms) is the best single idea in the three designs. Bands drive UI per seat from `p95`; audio leads vision;
  `dt` clamped to `[1/120, 1/30]` so a hitch never flings; `clockErrMs` turns the ring amber above 30 ms; "never:
  server rewind, rubber-banding, teleport-to-hand".
- Minus: prediction jitter with spin or a support touch after release (risk #2) is mitigated only by dashed styling.

### UI fidelity + a11y 7
- Same token/anatomy substrate as the others; good a11y (virtual hand visible as an outlined holohand, potato timer
  announced at 5 s and 2 s, static "+120 ms" chip under reduced motion instead of stretched motion).
- Minus: game-mode grid deviates from rule B (virtual tiles instead of centred incomplete rows); consent strings and
  privacy chrome are Wave-3 polish (T8) with no `getUserMedia` gate; no Teams shortcuts; `ROSTER 0x21` on the
  unreliable bus at 2 Hz means a late joiner can wait 5 s for a seat.

### Best ideas to graft
1. `ArrivalPredictor` (predict the receiving edge from free-flight `BALL_STATE`, dashed ring → solid on LAUNCH).
2. The phase state machine vocabulary (`idle/held/flight/transit/arriving/floor/sinking/respawn`) exposed on `S.ball.phase`
   — it is what the HUD, chips, live regions and probes all key on.
3. Tile chips + `MISS`/`CATCH`/`SAVE` rings with 200 ms fades, every audio cue with a text twin.
4. Practice mode (walls) as the 1-tile default, so a solo page is a game, not a blank meeting.
5. `ThrowDetector.release(hand, how)` treating `how === 'lost'` as a clamped 0.3 u/s drop, so a tracker dropout never
   flings the ball across the meeting.
6. The `[feel]` constants table in one place (`FEEL`) that builders may tune only there.

### Concrete flaws
- Vertical slam/lob rule: new physics glue on the frozen lane's floor, edits verified `court-map.mjs`; research says off.
- `placement:'in_hand'` vs `tools.json` `attach` — vocabulary mismatch in the executor contract.
- No demo script; Teams-API panel is links; nothing runs inside real Teams; no outgoing sink.
- Game-mode gallery is not Teams' gallery.
- Sound in meetings without ducking.
- Bot runs a full `PropBall` + `BallNet` in-process (heavier than needed; demo-first's court-unit bot is enough for
  ownership tests).

---

## integration-first — 38

### Buildability 5
- The strongest architecture (four adapter boundaries: `Transport`, `MeetingHost`, `VideoSink`, `HandSource`) but the
  widest scope for one day: `remote-tile.js`, `hand-sources.js`, `stage-scene.js`, `ball-game.js`, `latency-hud.js`,
  `a11y.js`, `gallery.js`, `meeting-host.js` with THREE hosts (`TwinHost`, `TeamsHost`, `AcsHost`), `acs-transport.js`,
  `video-sink.js` (crop + a second hires `WebGLRenderer` + popup), `teams-host-shim.js` (extracted from
  `host-harness.html:221-307`, verified present), `scene-executor.js`, three `apps/` families, `privacy.html`/`terms.html`,
  six Node tests and six browser probes.
- `TeamsHost` and `AcsHost` cannot be exercised without a tenant / Azure resource; they are code that will be written
  blind on day one. L7's acceptance is only `node --check` + manifest validation, which is honest but means "shipping
  pages" are unverified copies.
- There is no explicit page-assembly/integration task: L1 is "twin shell", L2-L6 produce modules, and nobody owns
  wiring them into `teamslab.html` (the dependency line says only "L7 needs L3/L4/L6").
- `attach:'nearest_hand'|'floor'|'front'` does not match `tools.json`.
- Un-mirroring the local tile when the game starts (research-aligned) adds a `scaleX(-1)` flip path that must be exactly
  right; demo-first's zero-flip choice is lower risk for a one-day build.

### Doctrine 8
- CP1-CP10 with `extra.bodies` support-only, `mesh.parent === scene` invariant, keyboard throw through `PackGen.throwSeq`
  into the SAME `PropBall.update`, hand-stop one frame late accepted as in mpbrowser, "nothing here reads any tile
  <video> for tracking. Ever."
- Minus: `spawn_object` for flyers = "sphere hull + flee/seek behaviours as flight targets NEAR the palm" and
  `land_on_hand = seek then cradle` — a butterfly that flies cannot have gravity always on; the prose is ambiguous where
  demo-first simply refuses. Needs the executor to state that flyers are grounded props with a hover offset, or refuse.

### Demo impact 8
- The credibility story is the best of the three: the same `sdk/game` + `sdk/net` modules run in the twin and in
  `apps/teams-effect`, `apps/teams-stage`, `apps/acs` with only the adapter swapped; Mode B drives the real teams-js
  2.56.0 postMessage handshake in the panel iframe (the harness trace in `video-effects/SUMMARY.md` proves this works);
  `OutgoingSink.openWindow()` → OBS virtual camera is the ONE path that puts holohands + a held apple into a real Teams
  meeting today with no tenant, no sideload, no beta API. The Teams-API tab shows live numbers per row (effect avg/max
  ms, notifyError, consent state), not links.
- Privacy chrome (consent before `getUserMedia`, device-only toggle, tracking pills, recording/transcription banners,
  sandbox strip) is what an enterprise PM's legal reviewer will ask for first.
- Minus: no demo choreography at all; HUD off by default (`hud:false`); the "wow" of the game is under-specified (goal
  = held ≥ 250 ms by the goal owner is a weaker beat than crossing a goal frame); with L6/L7 half-built the live demo
  risks showing broken ports, which is worse than an honest table.

### Latency design 8
- Transport-level realism is the best: per-transport rates (ws 20-30 with drop-to-20 at p95 > 150 ms; WebRTC unordered
  `'ball'` + ordered `'state'`; ACS 60 of 80 pkt/s under the 200 kbps High Lossy cap; Live Share 20 Hz bundled 50 ms),
  `clock.adoptGlobal(timestampProvider.getTimestamp())` inside Teams, per-seat hz/p50/p95/max/lost like `stage.html`.
- Minus: no feel engineering beyond the research bands (no arrival prediction, no audio); HUD hidden by default.

### UI fidelity + a11y 9
- Most complete: `role=toolbar` with arrow navigation and `aria-pressed`, Teams shortcuts `Ctrl+Shift+M/O/K/E`,
  `forced-colors` → `Highlight`, consent dialog that blocks `getUserMedia` (asserted by a spy count), device-only
  toggle that stops sends (asserted), "Landmarks from seat k" pills, letterboxed stage at 994x678, `acsGrid` parity
  switch, honest-limits About panel, 20 px sandbox strip. Local tile un-mirrored in game mode per the research decision.

### Best ideas to graft
1. `OutgoingSink` (crop mode + `?outgoing=1` popup for OBS) — the tenant-free "inside real Teams" demo beat. Skip the
   hires second renderer on day one.
2. `RemoteTile` as a separate class wrapping `HandViews` + rigs + `HandBody` per remote seat (instead of editing
   `tile-pipeline.js`).
3. Consent-before-`getUserMedia` + device-only gate (`gated(transport)`) + tracking pills + sandbox strip, with the
   spy-count and send-count probe assertions.
4. The four adapter interfaces written down once (`Transport / MeetingHost / VideoSink / HandSource`) even if only
   `TwinHost` + `Loopback/WsRelay` ship — it is what makes the Teams-API tab's "ships as / twin stand-in" columns true.
5. Live numbers in the Teams-API tab rather than links.
6. `TeamsHostShim` extraction from `host-harness.html` Mode B as a stretch task: it is the only local proof of the C2
   protocol and the harness already passes.

### Concrete flaws
- Scope: three host adapters, an ACS transport, three app families and a video sink in one day, with no assembly task.
- `attach` vocabulary mismatch with `tools.json`.
- Flyer behaviours ambiguous under gravity-always-on.
- No demo script; HUD off by default; goal rule is the least visual of the three.
- `TeamsHost`/`AcsHost` cannot be tested locally; they will ship as untested code paths presented as "shipping pages".
- Mirror flip at game start is one more place to get an edge wrong (acknowledged as risk #5).

---

## Recommendation for the synthesizer

Build demo-first's page, module map and test plan as the spine, and graft:

1. **From integration-first:** `OutgoingSink` crop-mode popup (C1 via OBS) as a T7-class stretch; `RemoteTile` instead
   of `poseFromHands`; consent gate before `getUserMedia` + device-only toggle + sandbox strip in T1/T8; live numbers in
   the API tab; the four adapter interfaces as a one-page `CONTRACTS.md` section even where only the twin adapters ship.
2. **From game-feel-first:** `ArrivalPredictor`; `S.ball.phase` state machine; `MISS/CATCH` chips and rings; practice
   mode on one tile; `how === 'lost'` drop clamp; the `FEEL` constants table. Leave the vertical slam/lob rule out
   (research says vertical off for the demo; it edits verified code).
3. **Resolve once:** the mirror convention (demo-first mirrored court vs research un-mirrored) and the `spawn_object`
   `attach` vocabulary (`tools.json` is the authority: `either_hand`, `world_front`, `table`).
