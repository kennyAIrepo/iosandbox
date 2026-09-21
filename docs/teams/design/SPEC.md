# SPEC — `teamslab.html`, the hopeOS Teams twin (synthesized design, 2026-09-19)

Spine: `design/demo-first/DESIGN.md` (winner, 42/50 from both judges). Grafts: `ArrivalPredictor`, the ball phase
machine, tile chips, `sfx.js`, lost-hand drop clamp, `FEEL` table and practice mode from `game-feel-first`;
`RemoteTile`, `hand-sources.js`, `gated()` transport, consent-before-`getUserMedia`, `OutgoingSink` crop mode, the four
adapter interfaces and live numbers in the API tab from `integration-first`. Companion files: `CONTRACTS.md` (APIs,
packets, checkpoints) and `BUILD-PLAN.md` (tasks). Paths: `R` = `scratchpad/research`, `REPO` = `C:/Users/hanna/iosandbox`.

Hard rules (never relaxed): `mpbrowser.html` + the avatar rig pipeline are FROZEN (copy out, never import, never edit);
PROP COLLISION DOCTRINE (shape-vs-shape from the prop hull; pickup only by finger wrap / clip / measured holding-pose
cradle; open hand = release; gravity always on; hands support and never pass through; never `GrabbableSphere.jointsWithin`
/ pinch grab, never gravity-off seek); hand chirality / z-sign is MEASURED by `hand-views.js _zSign`, never hard-coded,
never read from MediaPipe handedness labels.

## 0. Decisions the judges asked the synthesizer to make

| # | Decision | Chosen | Why |
|---|---|---|---|
| D-A | Court orientation | **Every tile is displayed in mirrored (self-view) space and the court is defined in that frame**: `court-space.DISPLAY_MIRRORED = true`, `court-bridge` called with `mirroredInput:false`. Screen-right exit -> the seat displayed to the right. | The only convention that survives one shared WebGL surface (CSS cannot flip rigs/ball per tile); zero flips in the hand chain; the verified mirror-mode occluder and pixel match untouched. Deviates from `R/game/space-mapping.md` §7, which assumed remote VIDEO must match; the twin has no remote video (remote tiles = avatar + holohands from packets). Guarded by `tests/court-space-smoke.mjs` "screen-right exit -> seat+1". The un-mirrored canonical stays one flag away (`unmirrorHands()` seam) for C2, where `mirroredInput:true` is used exactly as the research copy does. |
| D-B | Court topology | **One court row = a ring** (`buildSeatMap(roster, {cols: roster.length, wrap:'row', outer:'wall'})`) regardless of the DOM grid; **vertical passes OFF** (`exitEdge` verbatim: floor is never an exit). Practice (1 tile): `wrap:'none'` -> walls. | Keeps `court-map.mjs`/`ball-net.mjs` verbatim (7/7 fuzz stands); every seat is reachable (a 2x2 court with no B exits isolates the second row); two laptops side by side get "throw right -> arrives left of B", and B's right edge wraps back to A. Non-DOM-adjacent hops (seat 1 -> seat 2 in a 2x2 gallery) leave at the exit edge and re-enter at the target edge under an arrival ring with >= 300 ms lead. |
| D-C | Executor vocabulary | **`tools.json` is the authority**: `attach` in `left_hand|right_hand|either_hand|world_front|table`; `behavior` in `seek_hand|orbit_hand|follow_gaze|flee_hand|idle|land_on_hand`. `seek_hand` and `idle` are implemented; `orbit_hand`, `follow_gaze`, `flee_hand`, `land_on_hand` return `{ok:false, reason}` and the agent relays it in one sentence. | Anything else breaks the 114-check suite or fakes lift under gravity-always-on. |
| D-D | Physics parity | `PropBall` for the game ball is constructed with `gravity: -COURT_GRAVITY*U` (-9.70 m/s^2), `restitution: FLOOR_RESTITUTION` (0.58), `radius: court.R*U`. | The owner's metres physics and everyone's court-unit ghost/predictor integrate identically, so the `ArrivalPredictor` ring is placed where the ball really exits. Constructor options only; the lane is not edited. |
| D-E | Scope for day one | Twin + loopback/ws relay + bots + agent + HUD + consent chrome + C1 `OutgoingSink` crop popup. NOT built: Live Share / ACS / RTC transports (seams), `apps/*`, `TeamsHostShim`, MoveNet shared tile (day two), body layer (stretch T10). | Judges' scope findings on integration-first. |

## 1. Concept

`teamslab.html` is a Teams-meeting look-alike (Fluent 2 tokens, 16:9 gallery, 48 px top bar, 56 px control bar, 320 px
side panel) whose tiles are participants and whose every hopeOS layer is a side-panel toggle. Each laptop tracks ONLY its
own camera, ships a 516 B `HAND_STREAM` at 30 Hz through a 60-line WebSocket relay (or a `BroadcastChannel` loopback on
one machine), and renders everybody's holohands locally from packets. One ball lives in the shared court under the exact
glass-ball doctrine lane (`PropBall`, 23/23), ownership by `BallNet` (7/7 + 60-throw fuzz), arrival predicted from the
thrower's `BALL_STATE`s so the catcher's ring leads by hundreds of ms. "Give me an apple in my hand" goes voice/text ->
`CommandAgent` (114/114) -> `SceneExecutor` (the only doctrine enforcement point) with an offline 34-phrase grammar so
the beat never depends on a key or Wi-Fi. Everything is drawn by ONE transparent WebGL surface over the whole stage
(design S: 5 contexts at 9 tiles, no seam when the ball crosses a gutter). A latency HUD chip ("you 34 · B 68 · relay 9")
is the pilot argument made visible. The Teams-API tab maps every layer to its real return path with a status pill and
the known blocker. About 85 % of shipped code is verified research code copied into `sdk/game/`, `sdk/net/`, `tools/`,
`tests/`; the new code is ten small modules plus the page.

### 1.1 The 10-minute two-laptop demo (laptop A runs `npm run serve` + `npm run relay`)

| min | beat | what the audience sees | what proves the pitch |
|---|---|---|---|
| 0-1 | A opens `teamslab.html?room=pilot&relay=ws://A:8787&name=Kenny`, accepts the consent dialog, clicks Join | Teams-dark meeting, one 16:9 tile with real video + holohands, control bar, People panel, "Tracking on this device" pill | "this is the surface you already have" |
| 1-2 | B joins the same room | second tile: B's holohands over B's avatar, no video crossed the wire; HUD "you 34 · B 68 · relay 9"; "Landmarks from Hannah" pill | track locally, relay 600 B, render locally |
| 2-4 | A: Game > **Play together** (enabled once the clock has 8 samples) | ball kicks off in A's tile; A wraps it (HOLDING·R chip), throws right (THROW chip); B sees a dashed ring while the ball is still crossing A's tile, solid on LAUNCH, whoosh panned right, ghost through the gutter; B cradles it (CATCH), throws back | doctrine catch/throw, scheduled handoff, cue lead 400-900 ms |
| 4-6 | A sets B's tile as **goal** (panel or "make Hannah the goal"), scores twice; **Hot potato** for 30 s | marigold goal frame + trophy chip, scoreboard "A 2 : 0 B", aria-live "Goal, Kenny 2, Hannah 0"; potato fuse ring | game rules under the same physics |
| 6-8 | A holds **V** / the mic pill: "give me an apple in my hand"; "make it glow"; "pass it to Hannah" | apple appears on A's open palm and falls when the hand opens; glow; the apple is refused for pass (only the game ball crosses tiles) and the agent says so in one line | voice -> Claude tool use -> doctrine executor; `?agent=local` gives the identical visible result |
| 8-9 | A opens **Outgoing** (C1) popup | a 1280x720 window "as others see you": video + holohands + apple; OBS/virtual camera can capture it into a real Teams call | the tenant-free path into real Teams today |
| 9-10 | **Teams API** tab | one row per layer: return path (C1/C2/C3/D), status pill (demo / seam / probe first), live numbers, known blocker, script link | honest integration map |

Rehearsal insurance on ONE laptop: `?transport=loopback&tiles=2&clone=1&bot=1&agent=local&consent=1`
(second tile = webcam clone, third = scripted bot). Two browser windows on one machine: `?room=x&host=1` and `?room=x`.

### 1.2 Cut from the demo path (kept as documented seams)

- Live Share, ACS, WebRTC: classes stay in `sdk/net/transports.js` as copied; only `WsRelayTransport` and
  `LoopbackTransport` are instantiated. The API tab links the stage / ACS research pages.
- MoveNet multi-person in ONE tile (topology A): day two. Multi-person in the demo = N tiles with stable ids
  (`clientId`, `seat` from the host's seat map, PRESENCE roster).
- Non-sphere props: every catalog kind is a sphere-hull `PropBall` with its own radius and material; `PropHull.fromObject`
  for GLBs is a documented seam in `scene-executor.js`.
- Behaviours other than `seek_hand` / `idle` and effects other than `glow` / `trail`: honest `{ok:false, reason}`.
- Body layer (`body-layer.js`) and `OutgoingSink` hires mode: stretch tasks.

## 2. Page anatomy

Tokens and numbers: `R/ui/layout-spec.md` §1-§5, `R/ui/teams-tokens.css` (GENERATED; regenerate with the copied
`tools/gen-teams-tokens.mjs`, never hand-edit). Gallery rule (B) fixed 16:9 from `R/ui/scripts/gallery-grid.mjs::fixed169`;
stacking from `R/gaps/render-budget/layout-spec.patch.md`: `tile 0 < surface 6 < arrivals 7 < selfview 10 < controlbar 20
< panel 30 < dialog 40 < toast 50` (`.tile { z-index:auto }`). Twin-only numbers are marked `[twin]` and are not Teams facts.

### 2.1 One tile (solo practice; 1280x720 window, panel open)

```
+------------------------------------------------------------------------------+--------------------+
| TOP BAR 48  hopeOS Meeting Sandbox · not a Microsoft product  [00:42] [you 34 · — · relay —] [⋯] | People Chat Game API |
+------------------------------------------------------------------------------+--------------------+
|  STAGE (flex 1, pad 8, bg colorNeutralBackground4)                           | Layers             |
|   +--------------------------------------------------------------+           | [x] Holohands      |
|   |     <video> mirrored (local camera, object-fit cover)        |           | [ ] Body + collide |
|   |     holohands + ball + props drawn by the ONE stage surface  |           | [x] Props          |
|   |                                                              |           | [x] Ball game      |
|   |                                                              |           | [x] Command agent  |
|   | [mic] Kenny (you)  [Tracking on this device]      [pin] [⋯]  |           | [x] Latency HUD    |
|   +--------------------------------------------------------------+           | [x] Sound          |
|                                        (self-view hidden: local is in-grid)  | Practice: walls    |
+------------------------------------------------------------------------------+--------------------+
| CONTROL BAR 56  [Camera] [Mic] [On-device only] [Share ▸ Play together] [React] [Raise] [More]  [ Leave ] |
| STRIP 20  hopeOS Meeting Sandbox — imitates the Teams meeting layout for engineering. Not a Microsoft product. |
+-----------------------------------------------------------------------------------------------------+
```
Stage 952x600 -> one tile 952x535 (rule B). Practice mode: the ball bounces off the tile walls (`outer:'wall'`,
`wrap:'none'`), chips and rings still fire, so a solo page is a game rather than a blank meeting.

### 2.2 Three tiles (A, B, bot) — 2x2 grid, incomplete row centred; court = ring 0 -> 1 -> 2 -> 0

```
+------------------------------------------------------------------------------+--------------------+
| TOP BAR   [ A 2 : 1 B ]   [you 34 · B 68 · bot 12 · relay 9]                  | Game               |
+------------------------------------------------------------------------------+ (o) Free pass      |
|   +----------------------------+  +----------------------------+             | ( ) Hot potato     |
|   |  A (you)  video + hands    |  |  B  avatar + hands (pkts)  |  <- GOAL    | Goal tile [B  v]   |
|   |  HOLDING·R           o====|==|=> (dashed ring -> solid)    |    frame    | [Play together]    |
|   |                            |  |  INCOMING                  |             | [Kick off] [Reset] |
|   | [mic] Kenny [Tracking]     |  | [mic] Hannah [Landmarks] 🏆 |             |--------------------|
|   +----------------------------+  +----------------------------+             | Command            |
|                 +----------------------------+                               | [ give me an ...  ]|
|                 |  bot  avatar + canned hands|                               | (● hold V to talk) |
|                 |                            |                               | last: spawn_object |
|                 | [mic-off] Bot-1 [Landmarks]|                               |  apple -> right    |
|                 +----------------------------+                               |  local · 1 rd · 12ms|
+------------------------------------------------------------------------------+--------------------+
```
Court seats: 0 at x 0..1.78, 1 at 1.86..3.64, 2 at 3.72..5.50 (gutter 0.08, aspect 16/9). The 0.08 court gutter is
squeezed to the 8 px DOM gap for position only, never radius. A ball leaving B's right edge arrives at the bot's left
edge (displayed bottom-centre): it vanishes at B's edge, the bot tile shows the ring/whoosh, it re-enters from the left.

### 2.3 Four tiles — 2x2 full (A, B, clone, bot); court ring 0-1-2-3-0

Tile sizes at the six reference rectangles come from `R/ui/scripts/gallery-grid-results.txt` (994x678: 3-4 tiles ->
493x277; 5-6 -> 392x220; 7-9 -> 326x183). `.tw-frame` is `container-type:size`; probes snapshot 994x678, 918x540,
792x382, 472x382, 1280x720, 1920x1080.

### 2.4 DOM skeleton (ids the probes and modules rely on)

```
<div class="tw-frame tw-meeting" data-theme="dark">           (also data-theme="dark" on <html>; decision.md §3)
  <header id="topbar"> #title #scoreboard #hudChip #topbarBtns </header>
  <main id="stage">                                            position:relative; grid + surface + arrivals
    <section id="gallery" role="list">
      <article class="tile" role="listitem" data-seat="0" data-client="c-000" id="tile-c-000">
        <video class="tile__media">  <div class="tile__avatar">  <div class="tile__chrome"> label · pills · chip · ring </div>
    <canvas id="surface">                                      ONE WebGLRenderer, z 6, pointer-events:none, aria-hidden
    <canvas id="arrivals">                                     2D: ArrivalRing / MissCue / potato fuse, z 7, aria-hidden
  </main>
  <aside id="panel" role="complementary"> role=tablist: #tab-people #tab-chat #tab-game #tab-api </aside>
  <footer id="controlbar" role="toolbar"> #btnCam #btnMic #btnDeviceOnly #btnShare #btnReact #btnRaise #btnMore #btnLeave </footer>
  <div id="strip">  <div id="live-polite" aria-live="polite">  <div id="live-assertive" aria-live="assertive">
  <div id="toasts">  <dialog id="consent">  <dialog id="cmdPopover">  <dialog id="about">
</div>
```

## 3. State model

One page-level object `S` exposed as `window.__twin.S` (plain data where possible; class instances where the research
defines them). Nothing global besides `window.__twin`.

```js
S = {
  url:   { room, relay, transport:'ws'|'loopback', tiles, clone, bot, clip, auto, fixedstep, consent, agent:'auto'|'local'|'claude',
           proxy, host, mode:'free'|'potato'|'practice', nosfx, hud, outgoing, lat, jit, loss, wan },
  boot:  { consentOk, ready, error },
  me:    { clientId, name, seat, isHost, shareMode:'share'|'device-only' },
  clock: SharedClock,  transport: Transport,  room: Room,  net: BallNet,  court: CourtMap,
  roster: [{ clientId, name, tracked, aspect, handSpan, kind:'local'|'clone'|'clip'|'bot'|'remote', lastSeenMs }],
  seatMap: { v, cols, rows, gutter, wrap, outer, goal, kickoff, seats:[...] },      // host-authored, arrives as SEAT_MAP
  stage: StageRenderer,
  tiles: Map<clientId, Tile>,   // Tile = { el, video, seat, kind, source:HandSource, pipe:TilePipeline|null, remote:RemoteTile|null,
                                //          cam, uvCam, rect, packs, hands, handL, handR, alpha, ageMs, chip, ring }
  layers: { hands:true, body:false, props:true, game:true, agent:true, hud:true, sfx:true },
  props:  Map<id, { id, kind, ball:PropBall, behavior, effects:Set, color, ownerClient }>,   // agent props, local tile only
  game:   BallGame|null,        // S.game.phase is the feel state machine (§6.2); ownership truth is S.net only
  agent:  { cmd:CommandAgent, ptt:PushToTalk|null, exec:SceneExecutor, status:'idle'|'listening'|'thinking'|'acting'|'done'|'error',
            last:{ text, actions, say, source:'claude'|'local', rounds, ms } },
  hud:    { fps, scriptMs, detectMs, ownAgeMs, remote:{[clientId]:{ageMs, hz, p95}}, relayRttMs, clockOffsetMs, clockSamples,
            ball:{ owner, inTransit, phase, oneWayMs, handoffMs, stretches, conflicts, leadMs }, contexts },
  a11y:   { reducedMotion, lastPoliteAt, lastAssertiveAt, kb:{ active, x, y, closed } },
  ovPacks: { [clientId]: { L, R } } | {},     // probe / keyboard seam: replaces that tile's packs before physics AND rigs
};
```

Authority rules: `net.owner / ownerSeq / inTransit` are `BallNet` state only; `seatMap` is written only by the host and
arrives as `SEAT_MAP 0x20`; `game.score` is derived on every client from accepted `GOAL 0x14`; `game.phase` is computed
from BallNet hooks + PropBall state; `S.me.shareMode === 'device-only'` => every transport `send` is a no-op (`gated()`);
`props.get(id).ball.mesh.parent === stage.scene` always (nothing is ever parented under a hand).

Transitions: **join** = consent -> `getUserMedia` -> transport hello -> `me.clientId` -> PRESENCE -> roster -> host builds
the seat map -> `SEAT_MAP` -> `court.set` on everyone -> gallery re-laid in seat order. **layer toggles**: `hands` builds /
disposes rigs (landmarkers stay); `body` inits pose on the LOCAL tile only; `game` constructs `BallGame`; `agent`
constructs `CommandAgent` + `SceneExecutor`; `hud` shows/hides the chip (numbers always computed).

## 4. UX flows

1. **Consent gate** (C1 of `R/gaps/data-privacy-terms/consent-copy.md`): modal `role=dialog aria-modal` before any
   `getUserMedia`; "I agree and turn on camera" / "Not now" / secondary "Use hopeOS without sharing (on-device only)".
   Stored in `localStorage 'hopeos.consent'` `{version, at, shareMode}`; `?consent=1` pre-accepts for probes.
2. **Join**: name field, Join button (`?auto=1` skips it). Tiles appear in seat order as PRESENCE arrives; a tile with no
   packets for 2 s shows "No tracking data".
3. **Play together**: disabled until `room.clockReady()` (8 clock samples, or host on loopback); host kicks off at the
   kickoff seat. Mode radio: Free pass / Hot potato; Goal tile select (host); Kick off / Reset.
4. **Throw / catch**: entirely the doctrine; chips narrate: HOLDING·L/R, THROW, INCOMING (ring), CATCH, MISS, STALE,
   KEEPER, SAVE; each with a 200 ms ring fade and a text twin in `#live-polite`.
5. **Command**: Game tab text field (Enter) or `Ctrl+/` popover; hold `V` or the mic pill to talk (`PushToTalk`, `/api/openai`,
   2-4.5 s). Result card: `source · rounds · ms · actions`. Refusals are shown verbatim in one line.
6. **On-device only** (C4): control-bar toggle; pill flips to "On-device only"; transport sends stop (probe asserts the send
   counter); agent forced to `mode:'local'`; PushToTalk disabled.
7. **Outgoing** (C1): `?outgoing=1` popup or the More menu; 1280x720 canvas = un-mirrored video + the local viewport crop of
   the surface, `captureStream(30)`; instructions for OBS window capture in the About dialog.
8. **Leave**: closes transport, stops tracks, keeps consent.

## 5. Accessibility (from `R/ui/accessibility.md` R1-R12; computed, not asserted)

- Keyboard equivalents go THROUGH the doctrine: `K` toggles the keyboard hand (an outlined synthetic `flat` pack entering via
  `S.ovPacks[me]`); arrows move it at 0.6 m/s; **Space held** morphs it to `cup` (wrap pickup by `_wrapGrab`); **Space
  released** -> `open` (release with the pack's measured velocity; throw = move + release). `G` kick off (host), `1-9` goal
  seat (host), `P` play/stop, `M` mute cues, `H` HUD, `V` hold to talk, `Ctrl+/` command popover, `Esc` closes dialogs.
  Space is NEVER push-to-talk (avoids the overload the judges flagged). Tab order: top bar -> gallery (roving tabindex,
  `article role=group aria-label="Hannah, camera on, holding the ball"`) -> control bar (`role=toolbar`, arrow keys,
  `aria-pressed`) -> side panel (`role=tablist`).
- Live regions: `#live-polite` throttled to one per 2 s ("Ball is in Hannah's tile", "Goal, Kenny 2, Hannah 1", "Apple placed
  in your right hand", "Hannah joined", "Missed in Bot-1"); `#live-assertive` (relay lost, camera denied, agent refused,
  potato burst). Every audio cue has a text twin. Never per-frame.
- Reduced motion: `@media (prefers-reduced-motion: reduce)` sets `--tw-motion:0`; JS gate disables ring shrink, ghost
  trail, reaction floats, confetti; the ghost ball still moves; the gutter slow-mo is shown as a static "+120 ms" chip.
- Contrast: text >= 4.5:1 from tokens (`R/ui/scripts/contrast.mjs` results 50 pass / 10 exempt); label scrim rgba(0,0,0,.6);
  every ring over video carries `--tw-halo`; raise-hand pill black icon on `#eaa300`; Leave is the only filled red.
- Colour never alone: goal = frame + trophy chip + "(goal)" in the label; owner = "ball" chip + ring; stale remote = alpha AND
  "68 ms" text; latency bands have names in the HUD.
- Targets >= 24 px (control cells 56, buttons 32 visual / 40 hit); `forced-colors` -> `Highlight`; canvases `aria-hidden`,
  `pointer-events:none`; hands are never a pointer (R11). Honest limits in the About dialog (R12).

## 6. Ball game rules

### 6.1 Rules (implemented by `ball-game.js` on top of `BallNet` + `PropBall`, no new contact rule)

1. **One ball, one owner**: the client whose tile contains the ball simulates it; everyone else renders ghost / remote
   state. Host = lowest `clientId`; the host kicks off, proxies untracked seats (bots offline, camera-off), recovers a silent
   owner after 1 s (all `BallNet`).
2. **Catch** = the doctrine pickup in MY tile (wrap / clip / palm-up cradle) after ownership arrives at `tEdge'`; open hand
   releases the same frame. The only catch assist is contact friction 0.95 vs 0.85 in the 300-500 ms band and the entry
   cap (2.0 u/s, 1.5 degraded). Two-hand pinch scale is disabled while `phase in {transit, arriving}`.
3. **Throw**: release velocity = mean of the last six palm-follow velocities (verbatim lane). Classification on release
   (`FEEL`): `|v| < 0.25 u/s` drop (reason ROLL), `0.25..3.0` throw, `> 3.0` clamped; holder hand LOST this frame -> drop
   clamped to 0.3 u/s (a tracker dropout never flings the ball across the meeting). LAUNCH fires when the centre fully
   leaves an L/R edge toward a neighbour (`BallNet.tickOwner`); no neighbour = wall bounce, still my ball. Floor is
   never an exit; T exits exist in `court-map` but a one-row court has no T neighbour.
4. **Arrival cues**: non-owners run `CourtMap.predictExit` on every free-flight `BALL_STATE`; if the predicted neighbour is
   me: dashed ring at the predicted edge point with `tEdgeEst`, `sfx.tick` at 300 ms lead; LAUNCH confirms (solid ring,
   `tEdgeEff`, whoosh panned toward me); ghost ball through the gutter; catch = thud from my own client at 0 ms.
5. **Goal** (free pass): exactly one goal seat (host or `designate_goal`, host-gated). Scored when the ball is FREE (not
   held / cradled) and its centre enters the goal ring (radius 0.25 u, centred at the goal tile's bottom-centre 0.35 u
   above the floor), declared by the goal seat's owner (tracked keeper or host proxy) via `net.declareGoal(lastLauncher,
   n)`. Score goes to the last launcher. A keeper's hand in front of the ring is a save by the doctrine alone (support):
   chip SAVE. After a goal the host respawns at kickoff; the goal stays unless "rotate" is on (then next seat).
6. **Hot potato**: same physics; shared 8 s fuse on the shared clock restarted at every CLAIM (`tState`); at zero the
   owner's seat loses a point (host declares via GOAL with `goalNo` high bit = potato flag, `scorerSeat` = loser); no goal
   tile; fuse ring drawn on the owner's tile; announced at 5 s and 2 s.
7. **Latency bands drive UI, never physics** (`R/game/latency-feel.md`): < 80 invisible; 80-150 ghost + ring; 150-300
   boundary stretch visible (slow-mo 0.4x in the gutter); 300-500 entry cap 1.5 + assist friction + "Hot potato
   recommended" toast to the host; > 500 the seat is demoted to a wall (host proxy), chip "spectating".
8. **Practice** (1 tile, default `mode=practice`): walls on every side (`onWall` reflects `vx` with restitution 0.6), the
   floor is a floor, rest 8 s -> respawn at kickoff (BallNet).
9. **Keyboard players** play through the same pickup path with the synthetic hand; no keyboard teleport.

### 6.2 Phase state machine (`S.game.phase`; HUD, chips, live regions and probes key on it)

| phase | enter | local physics | cues | exit |
|---|---|---|---|---|
| `idle` | game not running / no owner | none | dim ball at the kickoff tile | host `kickoff` -> `floor` |
| `held` | `PropBall.hold` or `cradle` on the owner | doctrine hold; BALL_STATE + HOLD_OFFSET | chip HOLDING·slot; remotes place the ball on the received hand when < 150 ms old | release -> `flight` |
| `flight` | free inside the owner's rect | `sphere.update(dt, [], floorY)` + support | thrower chip THROW 300 ms; receivers: predictor ring (dashed) | LAUNCH -> `transit`; rest -> `floor`; goal ring (goal owner) -> GOAL |
| `transit` | LAUNCH sent / seen | thrower keeps simulating until CLAIM or `HANDOFF_TIMEOUT_MS`; nobody else | ghost in the gutter, solid ring, whoosh, slow-mo when stretched | receiver claims at `tEdgeEff` -> `arriving` |
| `arriving` | I claimed | `setHome(myTile)`, `reset(entryWorld)`, vel = `shapeEntry` cap, `z = -D` until first contact | ghost promoted over 80 ms; ring shrinks 3R -> R; chip INCOMING | contact -> `held`/`flight`; floor -> `floor`; 600 ms no contact -> `flight` |
| `floor` | `atRest` on my floor | rest timer (BallNet) | chip MISS + danger ring + bonk if it came from another tile | pickup -> `held`; 8 s -> `sinking` |
| `sinking` | rest timeout | none | sinks 600 ms (`sfx.sink`) | RESPAWN launch -> `respawn` |
| `respawn` | RESPAWN claim at kickoff | kickoff owner: reset at `y0 + R + 0.4` | pop, ring at kickoff, "Ball back to <name>" | falls -> `floor` |

### 6.3 `FEEL` constants (single source `sdk/game/ball-game.js`, tunable only there)

| name | value | source |
|---|---|---|
| `V_DROP / V_MAX_OUT / V_MAX_IN / V_MAX_IN_DEGRADED` | 0.25 / 3.0 / 2.0 / 1.5 u/s | `throw-detect.js THROW`, latency-feel §4 |
| `V_LOST_CLAMP` | 0.3 u/s | game-feel-first §7.2 |
| `GRAVITY_M / RESTITUTION` | `-COURT_GRAVITY*U` (-9.70) / 0.58 | D-D |
| `CUE_LEAD_MIN_MS / RING_LEAD_MS / RING_R_FROM` | 300 / 400 / 3R | latency-feel §3, §5.2 |
| `MIN_LEAD_MS / HANDOFF_TIMEOUT_MS` | 80 / 250 (400 on ws over WAN, `?wan=1`) | `TUNING` |
| `ENTRY_TAU_MS / ARRIVE_NO_CONTACT_MS` | 100 / 600 | `EntryBlend` |
| `REST_TO_GUTTER_MS / RESPAWN_TRANSIT_MS` | 8000 / 600 | `TUNING` |
| `GOAL_RING_R / GOAL_RING_Y` | 0.25 / 0.35 u | demo-first §7.1 |
| `CATCH_ASSIST_FRICTION` | 0.95 (vs 0.85) | mechanics-options §3 |
| `POTATO_MS` | 8000 | mechanics-options §1b |
| `STALE_FADE_MS / STALE_DROP_MS` | 150 / 400 | remote-consumer |
| `WALL_RESTITUTION` | 0.6 | practice mode |
| `DT_MIN / DT_MAX` | 1/120 / 1/30 s (clamped before physics) | game-feel-first |

## 7. Command agent UX

- Module: `sdk/game/command-agent.js` + `tools.json` + `system-prompt.md` + `push-to-talk.js` copied unchanged (114/114).
  Construction: `new CommandAgent({ endpoint, tools, catalog, executor:(n,i) => S.agent.exec.exec(n,i), mode:S.url.agent ??
  'auto', speaker:S.me.name, timeoutMs:20000 })`. `endpoint` = `/api/claude` (Vercel) or `http://localhost:<proxy>/api/claude`
  with `?proxy=3334` (`tools/sandbox-proxy.mjs`); on `npm run serve` alone `mode:'auto'` silently uses the local grammar.
  Baked-in rules not to be "fixed": `claude-opus-5`, `effort:'low'`, no thinking key, `tool_choice auto`, strict tools,
  refusal checked first, 429/529 one backoff then local, all `tool_result`s in one user message, `cache_control` on system.
- Executor (`scene-executor.js`) is the ONLY doctrine enforcement point (contract in `CONTRACTS.md` §5).
  `spawn_object {attach:'either_hand'}` = the local tile's tracked hand with `HandBody.openness > 0.6` (right preferred);
  the apple is seated at the measured pocket (`palmPose` + measured inner normal, `home = palm + n*(r+0.01)`), gravity
  on, never parented; no open tracked hand -> `world_front` and the reply says so. "it" resolves through `lastTarget`.
- Voice: `PushToTalk` bound to the mic pill and to `V` (hold). `VoiceCommander` (4 s chunks) is not used.
- Text: Game tab field + `Ctrl+/` popover; Enter submits. Card shows `source · rounds · ms · actions`.
- Networked tools: `pass_object` -> `game.passToward(seat)` only for the game ball, refused while held / in transit / not
  owner; `designate_goal` host only; both relay through BallNet, never through the agent.
- Consent strings (C7) shown once before the first voice command; on-device-only forces `mode:'local'` and disables PTT.

## 8. Teams-API panel mapping (tab "API")

One row per layer: twin implementation, real return path, status pill (`demo` runs here / `seam` class present /
`probe first` blocked on tenant), live numbers, example script link (served copies under `docs/teams/`), known blocker.

| Layer | Twin | Return path | Live numbers | Example scripts | Known blocker |
|---|---|---|---|---|---|
| Holohands overlay | `TilePipeline` + `HoloHandRig` on the surface | **C2** video-effect app (own tile) / **C1** virtual camera | detect ms, rig fps | `R/video-effects/video-effect.html`, `effect-core.js`, `host-harness.html` (Mode B), `R/frameworks/examples/teams-video-effect.js` | `videoEffects` @beta, DevPreview manifest, sideload; issue #24 (new Teams 25163 never applies) -> probe first; NV12 + 45 ms |
| Outgoing video | `OutgoingSink` crop popup | **C1** OBS window capture -> virtual camera; **C3** `LocalVideoStream(captureStream)` | fps, size | `R/acs/acs-client.html:233-300` | C1 = pixels only, no packets |
| Body + collision | `body-layer.js` (local only, stretch) | **C2** | pose ms | `R/codebase/dropins.md` §3.10 | +11 ms, +1 context; POSE33 0x31 reserved |
| Multi-person ids | N tiles, `clientId`/seat via PRESENCE + SEAT_MAP; one-tile MoveNet = day two | **D** packets per id, **C2** pixels | roster n, seat map v | `R/codebase/multi-person.md`, `sdk/core/multiplayer.js` | TF.js context; ids swap on crossing |
| Game objects (doctrine) | `PropBall` props bag + `SceneExecutor` | **C2** render sink | hold type, cradle, contacts | `sandbox-skeleton/sdk/game/prop-ball.js`, `tests/prop-ball-smoke.mjs` | others see pixels only |
| Cross-tile ball | `BallGame` + `BallNet` over the relay | **D** stage app + Live Share (`LiveEvent` 20 Hz bundled, `LiveState`), or **C3** ACS DataChannel | owner, ownerSeq, in transit, conflicts, stretches, handoff p95, lead ms | `R/gaps/wire-protocol/stage.html`, `stage-adapter.md`, `R/meeting-app/*`, `R/acs/acs-client.html`, `transports.js::LiveShareTransport/RtcTransport` | no third party gets remote pixels; Live Share 1.4.2 / Fluid 1.x esm.sh unverified; anonymous users cannot see stage apps |
| Remote hands | `RemoteHands` + `RemoteTile` | **D** / **C3** (never the tile video) | pkt/s, age p50/p95, drops | `hopeos-wire.md` §7 | — |
| Command agent | `CommandAgent` + `SceneExecutor` + `PushToTalk` | **D** side panel; `/api/claude` proxy | state, rounds, ms, usage, mode | `R/meeting-app/side-panel.html`, `R/command-agent/NOTES.md` | one command at a time; live latency unmeasured |
| Latency HUD | `hud.js` | **D** stage HUD | own age, remote age, relay RTT, clock err | `R/meeting-app/stage.html` HUD | Live Share age unmeasured |
| Relay | `tools/relay-server.mjs` + `WsRelayTransport` (+ `gated()`) | **D** Azure Fluid Relay / **C3** ACS DataChannel | rtt, loss | `R/game/examples/relay-server.mjs`, `R/gaps/data-privacy-terms/` R22 | Vercel cannot host sockets; ACS DataChannel inside Teams undocumented |
| Privacy chrome | consent C1, pills C3, device-only C4, strip C10, About footnote | all | consentVersion, shareMode | `consent-copy.md`, `privacy.html`, `terms.html` | — |
| Tenant / packaging | — | manifests `R/meeting-app/manifest.json` (v1.30, RSC x4), `R/video-effects/manifest.json` (DevPreview) | — | `privacy.html`, `terms.html` | custom upload must be on; free dev tenant gated in 2026; icons not produced |

Adapter interfaces (documented once; only the twin adapters ship on day one):
```
Transport   { id, send(bytes,{reliable}), onMessage(cb), close() }     Loopback | WsRelay | Mem | (Rtc | LiveShare | Acs seams)
MeetingHost { join(), roster, isHost, on('roster'|'seatmap'|'host'), clockReady(), leave() }   Room (twin) | (TeamsHost | AcsHost day two)
VideoSink   { canvas, stream, openWindow() }                            OutgoingSink crop (C1/C3) | (effectRender for C2 day two)
HandSource  { kind, video|null, start(), stop() } or a packet sender   LocalCamera | Clone | Clip | Keyboard | Bot (sends) | RemoteHands
```

## 9. Latency HUD

Chip in the top bar (2 Hz DOM writes, tabular figures): `you <ownAgeMs> · <name> <ageMs> … · relay <rttMs>`; expanded panel
(HUD tab of Game): fps, script p50/p95, detect ms per local tile, per-seat pkt/s + age p50/p95 + drops, clock offset /
err / samples, ball owner / phase / in-transit / one-way / handoff p95 / stretches / conflicts / lead ms, contexts.
`ownAgeMs` = now - frame capture time (`requestVideoFrameCallback` where available, else `performance.now()` at detect);
remote `ageMs = dt32(clock.now(), pkt.t)`. `clockErrMs > 30` turns the ring amber. `AUTOTEST {...}` JSON line every 1 s
when `?auto=1` (`R/codebase/test-conventions.md` §3-4).

## 10. Test strategy (headless; details in `BUILD-PLAN.md`)

Node smoke tests (`ok()` counter + exit code) per module; two browser probes (puppeteer-core, Chrome fake camera,
`--use-gl=angle`): `_twinprobe.mjs` (one page, loopback, clone + bot, doctrine via `ovPacks`, agent local, keyboard, a11y,
screenshots at six rectangles) and `_twinpass-probe.mjs` (two pages over loopback: throw -> LAUNCH -> claim at `tEdge'`
-> catch -> goal -> potato -> bot). Every probe wire-validates from `window.__twin` and console, never screenshots alone.
Static greps (comments stripped) over `sdk/game`, `sdk/net`, `teamslab.html`: no `jointsWithin`, `GrabState`, `gravity: 0`,
`gravity = 0`, `handedness`, `categoryName`, `1 - x` / `-p.z` outside `hand-views.js`, no import of `mpbrowser.html`, no
`Date.now()` in `sdk/net`.

## 11. Risks carried forward

1. Mirror convention is a deliberate deviation (D-A); the guard test must stay in `npm test`.
2. Chrome's fake camera has no hands: doctrine/chirality under real video is proven only by the human rehearsal; `?clip=`
   (`CompositeCam.useFile`) is the repeatable semi-real path.
3. Main-thread budget: never pose on more than one tile; landmarkers created sequentially; `webglcontextlost` rebuild.
4. TCP relay head-of-line blocking can spike `ageMs`; the HUD shows it; `?wan=1` sets `HANDOFF_TIMEOUT_MS` 400.
5. Clock convergence gates Play together; the first throw within ~8 s of joining may stretch.
6. Claude live latency unmeasured; `?agent=local` is the identical-looking fallback.
7. PRESENCE 0x21 is new on the wire (added to `hopeos-wire.md` §2 by T0).
8. Bots never touch the hull; the two-page probe is the only automated doctrine-across-the-wire check.
9. Design S depth caveat: on LAUNCH the owner's mesh eases `z` to `-D` over 60 ms.
10. Sound in a meeting: default volume low, `M` mute, `nosfx=1`, no VAD ducking (documented).
