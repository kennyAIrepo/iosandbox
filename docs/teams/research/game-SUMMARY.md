# SUMMARY — cross-tile ball game ("Teams football") design inputs

Researcher folder: `game`. Date: 2026-09-18 (finisher pass). Nothing under `C:/Users/hanna/iosandbox` was modified; the stack was only read.

## Finisher decisions (which version is canonical)

| Deliverable | Kept | Why |
|---|---|---|
| `mechanics-options.md` | canonical (newer) | superset of the draft: same sections, adds the `HOLD_GRACE_FRAMES` / hysteresis row and the "catch assist = friction only, never rebound" rule |
| `space-mapping.md` | canonical (newer) | superset of the draft; adds Browser Ball / Roll It / multipleWindow3dScene precedents and the June 30 2026 Together-mode cut-off |
| `sync-protocol.md` | canonical (newer) | already reconciled with the code (byte layouts LAUNCH 42 B, CLAIM 30 B; rule 10 self-destination launch; `TUNING` constants) |
| `latency-feel.md` | canonical (newer) | draft content carried over and re-pointed at the canonical `latency-cues.mjs` / `throw-detect.mjs` symbols |
| `SUMMARY.md` | written now | only the draft had one; its packet sizes (LAUNCH 40 B, CLAIM 28 B) and "no smoke test" state were stale — corrected below |
| `examples/*.mjs` | canonical | larger, and the only set with `smoke-test.mjs` |

**Verification run (2026-09-18, Node v25.2.1, `cd examples && node smoke-test.mjs`): all 7 sections passed.** Results: codec round-trips (BALL_STATE 34 B + 14 B hold trailer = 48 B, LAUNCH 42 B, CLAIM 30 B, GOAL 16 B); SharedClock median-of-8 offset error 2.3 ms under ±40 ms asymmetric jitter (mean RTT 155 ms); court adjacency / ring wrap / floor-not-exit / reproducible `predictExit`; throw classification (coherent → throw, jitter → drop, fast → clamped, lob rule, 75 ms catch window at 2 units/s); A→B→C→A scheduled handoff over MemHub at 120 ± 30 ms one-way with 5 % loss (launch→claim 192-212 ms, `maxInTileOwners = 1`, thrower never corrected); untracked goal seat proxied by the host (GOAL accepted 540 ms after the throw, respawn at 8.7 s); dead receiver (thrower timeout 308 ms, host recovery 1004 ms); 60-throw fuzz (60/60 completed, 0 conflicts, handoff p50 200 / p95 224 / max 232 ms, owner overlap max 116 ms, 161/3788 packets dropped).

## Executive summary

The headline game — three participants in separate video tiles passing one ball tile-to-tile with tracked holohands, any tile designatable as the goal — is buildable on the existing hopeOS stack with one new sync module and one court-map module; no new physics is required because the frozen ball doctrine (`mpbrowser.html` glass-ball lane, `sdk/core/game-physics.js`, `sdk/core/prop-hull.js`) already defines throw (release inherits the mean of the last six palm-follow velocities plus 0.85 × hand spin), catch (support / cradle / wrap-clip with a 6 mm grab skin and 30 mm hold hysteresis, gravity always on, no snapping) and the no-gap hand contact (+3 mm conform in `hand-rig.js`). The decisive architectural facts are: (1) Microsoft Teams orders gallery tiles per viewer by active speaker / pin / spotlight and nobody can reorder them, so adjacency cannot come from the Teams gallery — the game must own a host-authored **seat map**, exactly the fixed-seat model Together mode used and which Microsoft retired on June 30 2026; (2) Zoom Immersive View and the Zoom Apps Layers API (`runRenderingContext({view:'immersive'})`, `drawParticipant`) both put a host in charge of placement in pixel units, confirming the "host-authored shared canvas" pattern; (3) Racer (Google, 2013) solved the multi-screen strip with "height = smallest screen, width = sum of widths, offset by position", the showing device sending every 4 frames, and a median-of-polls clock within 10 ms; (4) game-netcode precedent (Gaffer VR physics, Unity Netcode distributed authority, Photon Fusion state authority) converges on **one exclusive owner per object with sequence-numbered ownership**, adopted as "the tile that contains the ball owns it". Recommended rule set: (a) Free pass + goal tiles as the demo, (b) Hot potato as a mode switch (timer-authoritative, the most latency-tolerant), (c) Volley/keep-up as a practice screen. The sync design is ownership-authoritative with a **scheduled handoff**: a throw publishes the predicted boundary-crossing time `tEdge` on a shared clock; the receiving tile spawns a predicted ghost immediately and claims ownership when `tEdgeEff = max(tEdge, now + 80 ms)` passes — no round trip at the boundary, the thrower is never corrected, and the catch itself has zero network latency because the catcher owns both the ball and its own hands. Conflicts resolve deterministically (higher `ownerSeq`, then tile-owner rule, then lower `clientId` — the tie-break Live Share `LiveEvent.isNewer()` documents). Packets are byte-specified (`BALL_STATE` 34 B + 14 B hand-space hold trailer at 20-30 Hz, `LAUNCH` 42 B reliable + 3 unreliable repeats, `CLAIM` 30 B, `ACK` 12 B, `GOAL` 16 B, `SEAT_MAP` JSON, `CLOCK_PING/PONG` 12/20 B) and run over five interchangeable transports: `MemHub` (headless), `BroadcastChannel` loopback for the twin, a `ws` relay with a clock pong, WebRTC data channels (`{ordered:false, maxRetransmits:0}` + a reliable channel), and Live Share (`LiveEvent` for the unreliable bus, `LiveState` for the reliable keys; Teams-only, one message per 50 ms, delivery not guaranteed for events). Human-factors literature bounds the feel: own-hand latency must stay under ~25 ms (it is 0 on the network here), a sudden 100 ms feedback delay wrecks an interception task, 235-335 ms is adaptable with a cue, ~430 ms is not; simple reaction time is ~230 ms and people correct *where* not *when*, so the arrival ring on the exact edge height, a ghost ball, the 80 ms boundary stretch, an entry-speed cap of 2.0 tile-heights/s and a panned audio whoosh are the tricks, with tiles auto-demoted to goal/wall/portal above ~500 ms one-way. Untracked participants (phone, camera off) remain in the game as goal, wall or portal tiles simulated by the host as proxy owner. Open question for the Teams researchers: no TeamsJS API was found that exposes other participants' video to a stage app, so in-Teams tiles are landmark-rendered holohands over avatars, while the local twin can composite real video.

## Decisions that constrain design

1. **Doctrine unchanged**: throw = release velocity from the frozen ball lane; catch = support / cradle / wrap-clip only; gravity always on; hands never pass through; no `jointsWithin`/pinch, no gravity-off seek. Catch assist at high latency changes contact *friction* only (0.95 vs 0.85), never rebound.
2. **Seat map, not Teams gallery**: adjacency is host-authored JSON (`buildSeatMap`), versioned, one court unit = tile height, tiles edge-to-edge with a 0.08-unit gutter, ring wrap optional, floor never an exit; vertical passes off for the demo.
3. **Un-mirrored canonical court frame**: `PlayerFrame.img` is mirrored today; the conversion lives in exactly one place (`CourtMap.tileToCourt(mirrored=true)`).
4. **One owner, scheduled handoff**: owner = the client whose rect contains the ball; ownership passes at `tEdgeEff` by schedule; `ownerSeq` (u8) wins conflicts; host proxies untracked seats and recovers a silent owner after 1 s; `HANDOFF_TIMEOUT_MS = 250` (raise to 400 for WAN).
5. **Hold is shipped in hand space** (`HOLD_OFFSET` trailer) and placed on the *received* hand landmarks so the remote catch is gap-free.
6. **Shared clock**: relay/WebRTC-host NTP-style median-of-8 (`SharedClock`); inside Teams adopt Live Share `getNtpTime()` / `ILiveEvent.timestamp` rather than run a second clock.
7. **Rates**: 20 Hz on relay / Live Share (Live Share caps at one message per 50 ms), 30 Hz on WebRTC; non-owners dead-reckon with the same `integrateCourt` constants (g 5.2, drag 0.996, restitution 0.58, bounce min |vy| 0.35, floor friction 0.92) and blend errors < 0.3 units over 100 ms, else snap.
8. **Latency bands**: < 80 ms invisible; 80-150 fine; 150-300 playable with boundary stretch; 300-500 catch-assist + 1.5 units/s entry cap, hot potato recommended; > 500 ms the tile is demoted to a non-player role.
9. **Build order**: two windows over `BroadcastChannel` → two laptops over the `ws` relay → WebRTC → Live Share adapter inside a Teams meeting. Vercel cannot host the relay (needs a VM / LAN).
10. **The state machine is browser-free**: `BallNet` runs only from `tick()` and an injected clock, so the same module runs in rAF and headless.

## Canonical files

- `mechanics-options.md` — stack inventory (file:line), three rule sets with pros/cons, recommendation, throw detection, doctrine-true catch rules, drop/respawn lifecycle.
- `space-mapping.md` — frames, seat-map JSON, tile-court equations, adjacency incl. ring wrap, hand-relative ball scale, depth-as-hint, un-mirrored canonical frame, per-viewer pixel mapping and the transit overlay.
- `sync-protocol.md` — roles, shared clock, state machine, scheduled handoff timeline, byte-level packet tables, ten conflict rules, non-owner rendering, transport table, untracked-participant behaviour, test hooks.
- `latency-feel.md` — where latency lives, cited human thresholds, derived budgets, tolerance bands, the tricks that hide the rest, measurement plan.
- `examples/court-map.mjs` — `CourtMap`, `buildSeatMap`, `integrateCourt`, exit/entry/neighbour/`predictExit`, viewer px mapping (three.js 0.160-compatible, no three import needed).
- `examples/ball-net.mjs` — `DataView` codecs for every packet, `SharedClock`, `BallNet` owner/receiver/host state machine, `TUNING`, `getStats()`.
- `examples/throw-detect.mjs` — `ThrowDetector` (coherence gate, drop/throw/clamp, lob rule, spin), bat launch, entry shaping, catch window, path prediction.
- `examples/transports.mjs` — `MemHub`/`MemTransport` (headless), `LoopbackTransport` (BroadcastChannel + latency/jitter/loss), `WsRelayTransport`, `RtcTransport` (two data channels, perfect negotiation), `LiveShareTransport` (LiveEvent + LiveState).
- `examples/relay-server.mjs` — Node `ws` room relay with `CLOCK_PING` → `CLOCK_PONG` session clock (needs `npm i ws`; not exercised by the smoke test).
- `examples/latency-cues.mjs` — `boundaryStretch`, `gutterTimeScale`, `EntryBlend`, `GhostBall`, `ArrivalRing`, `AudioCues` (WebAudio, panned), `handAgeAlpha`, `panForTile`.
- `examples/smoke-test.mjs` — headless verification (Node 18+, no npm deps); passes as recorded above.

## Risks

- Scheduled handoff assumes a shared clock within ~10 ms; on Live Share the host global timestamp must be adopted, not a second ping clock.
- The un-mirrored court frame changes the self-view users are used to; a mirror bug shows up as balls exiting the wrong edge.
- Live Share caps the presence bus at 20 Hz and loses events; remote hands at 20 Hz need Hermite interpolation (already in `mpgames.html`).
- Host proxying of untracked seats plus recovery doubles the host duties; the code has a single `isHost` flag — splitting seat-map authority (organizer) from proxy duty (lowest tracked clientId) is not yet implemented.
- `HANDOFF_TIMEOUT_MS = 250` is borderline at 150 ms one-way (timeouts fire harmlessly but inflate stats).
- Photon Fusion references are from search snippets (fetch was bot-blocked); Rocket League 120/60 Hz numbers are from secondary sources.
- `RtcTransport`, `WsRelayTransport` and `LiveShareTransport` are written against documented APIs but only `MemHub` is verified headless; the browser transports are untested until the twin page exists.

## Open questions

- Does any TeamsJS / Live Share surface give a stage app access to other participants' *video* frames? (None found; in-Teams tiles are landmark-rendered.)
- Which Teams surface the pilot targets (meeting stage via Live Share vs our own page joined through ACS) decides whether the clock is Live Share NTP time or the relay clock.
- Vertical passes in 2 × 2 layouts (floor of A = ceiling of C)? Recommended off for the demo.
- Tenant policy for sideloading / external participants gates the in-Teams transport test.

## Sources

- hopeOS stack (read-only): `sdk/core/game-physics.js`, `sdk/core/prop-hull.js`, `sdk/core/hand-rig.js`, `sdk/core/multiplayer.js`, `mpbrowser.html` (glass-ball lane), `mpgames.html`, `MULTIPLAYER_SYNC_ARCHITECTURES.md`, `multiplayer-game-state-sync-protocols.md`
- bgstaal/multipleWindow3dScene: https://github.com/bgstaal/multipleWindow3dScene ; Browser Ball: https://experiments.withgoogle.com/browser-ball ; Roll It: https://www.engadget.com/2013-05-28-google-roll-it.html
- Gaffer on Games: https://gafferongames.com/post/networked_physics_in_virtual_reality/ ; https://gafferongames.com/post/snapshot_interpolation/ ; https://gafferongames.com/post/state_synchronization/
- Unity Netcode ownership: https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@2.11/manual/components/core/networkobject-ownership.html
- Photon Fusion (bot-blocked; names from snippets): https://doc.photonengine.com/fusion/current/manual/network-object ; https://forum.photonengine.com/discussion/20377/how-i-can-switch-the-stateauthority
- Valve Source Multiplayer Networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Rocket League GDC 2018 (PDF): https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf
- Racer: https://web.dev/racer ; https://developers.googleblog.com/en/race-across-screens-and-platforms-powered-by-the-mobile-web/
- Cristian algorithm: https://en.wikipedia.org/wiki/Cristian%27s_algorithm
- MDN createDataChannel: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
- Live Share overview / capabilities / FAQ: https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-overview ; https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities ; https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq
- Live Share API reference: https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveevent ; https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/iliveevent ; https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/liveshareclient ; https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/testlivesharehost ; https://github.com/microsoft/live-share-sdk
- Teams Carnival: https://techcommunity.microsoft.com/blog/educatordeveloperblog/multiplayer-gaming-experiences-in-microsoft-teams-using-live-share-sdk/3951741 ; https://github.com/Teams-Carnival-Games
- Games for Work: https://www.microsoft.com/en-us/copilot/blog/2022/11/16/build-connections-with-games-for-work-a-new-microsoft-teams-app/
- Teams gallery per-viewer prioritization / no reordering / sizes: https://learn.microsoft.com/en-us/answers/questions/2123027/how-does-teams-prioritize-and-display-video-feeds ; https://learn.microsoft.com/en-us/answers/questions/4438023/rearrange-order-of-participants-in-teams-when-will ; https://support.microsoft.com/en-us/teams/meetings/customize-your-meeting-view-in-microsoft-teams ; https://learn.microsoft.com/en-us/answers/questions/4424086/large-gallery-option-is-disabled-in-my-teams-and-h
- Together mode seats / retirement (June 30 2026): https://websites.uta.edu/oit/2022/08/25/assign-seats-in-together-mode ; https://www.uctoday.com/unified-communications/microsoft-is-retiring-teams-together-mode-the-end-of-a-pandemic-era-big-idea/ ; https://www.ghacks.net/2026/05/22/microsoft-retires-teams-together-mode-on-june-30-pointing-users-to-gallery-view/ ; https://techcommunity.microsoft.com/blog/microsoft365insiderblog/goodbye-together-mode-hello-simplified-meeting-layouts-in-microsoft-teams/4519312
- Teams "Mirror my video": https://techcommunity.microsoft.com/blog/microsoftteamsblog/turn-off-mirror-my-video-in-microsoft-teams-meetings-to-match-your-video-to-your/3114332
- Zoom Immersive View / Layers API: https://www.zoom.com/en/blog/introducing-zoom-immersive-view/ ; https://developers.zoom.us/docs/zoom-apps/guides/layers-using-api/ ; https://github.com/zoom/skills/blob/main/skills/zoom-apps-sdk/references/layers-api.md ; https://github.com/zoom/zoomapps-customlayout-js
- Human factors: Jota et al. 2013 https://www.tactuallabs.com/papers/howFastIsFastEnoughCHI13.pdf ; Cunningham et al. 2001 https://doi.org/10.1111/1467-9280.d01-17 ; Frontiers in VR 2021 https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2021.727858/full ; Avraham et al. 2017 https://pmc.ncbi.nlm.nih.gov/articles/PMC5788056/ ; Morice et al. 2008 https://www.sciencedirect.com/science/article/abs/pii/S0165027007005614 ; Brenner & Smeets 2015 https://jov.arvojournals.org/article.aspx?articleid=2213289 ; Woods et al. 2015 https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4374455/
