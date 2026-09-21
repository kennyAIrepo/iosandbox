# Latency and feel — how much delay a catch tolerates, and how to hide the rest

Researcher folder: `game`. Date: 2026-09-18 (finisher pass: carried over from the first draft and reconciled with the canonical code and `mechanics-options.md` §0). Code: `examples/latency-cues.mjs` (`boundaryStretch`, `gutterTimeScale`, `EntryBlend`, `GhostBall`, `ArrivalRing`, `AudioCues`, `handAgeAlpha`, `panForTile`), `examples/throw-detect.mjs` (`THROW.V_MAX_IN / V_MAX_OUT`, `ThrowDetector.catchWindowMs`), `examples/ball-net.mjs` (`TUNING.MIN_LEAD_MS`, `BallNet.getStats()`).

## 1. Where latency actually lives in this design

| Moment | Who acts | Network latency felt | Why |
|---|---|---|---|
| Holding / throwing in my tile | me | **0** | my hands and the ball are local (owner = tile) |
| Ball crossing into B | B | **0 at the boundary** if the LAUNCH arrived before `tEdge`; otherwise `L - T_e` (stretched, see §5) | scheduled handoff; B simulates from the LAUNCH |
| Catching in B | B | **0** | B owns the ball and its own hands |
| Me watching B catch | me | `L + interp` (~ 60-200 ms) | remote hands are snapshot-interpolated, ball is dead-reckoned |
| Keeper save in the goal tile | goal owner | **0** | same as catch |
| Spectator (untracked tile) | — | `L + interp` | watching only |

So the only *interactive* moment that can be late is the ball's *appearance* at the receiving edge, and only when the one-way latency `L` exceeds the flight time to the edge `T_e`. Everything else is watching, which humans tolerate far better than acting (numbers in §2).

`L` here is *end to end*: camera → tracking → packet → transport → render, not just the wire. `BallNet.getStats().oneWayMs` (LAUNCH send-to-receive on the shared clock) and `packetAgeMs` measure the wire part; the tracking part comes from the existing latency probe. Target: remote avatar age under 80 ms on LAN.

## 2. Human numbers (cited)

| Finding | Number | Source |
|---|---|---|
| Direct manipulation: dragging performance degrades above ~25 ms; tap latency below ~24 ms is imperceptible; perception thresholds 20-100 ms | 25 ms | Jota et al. 2013, "How fast is fast enough?", https://www.tactuallabs.com/papers/howFastIsFastEnoughCHI13.pdf |
| Visuomotor delay of 235 ms in a steering task: performance recovers after minutes and the delayed feedback "became perceptually synchronous"; 430 ms: "only one participant made it past the first curve" | 235 ms OK / 430 ms fails | Cunningham et al. 2001, https://doi.org/10.1111/1467-9280.d01-17 (as summarized in https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2021.727858/full) |
| VR steering: 330 ms "not challenging enough because our users immediately adapted", 385 ms chosen, 440 ms uncontrollable | 330 / 385 / 440 ms | Frontiers in VR 2021, https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2021.727858/full |
| Pong with a sudden 100 ms feedback delay: hit rate "decreased drastically", only partial recovery over ~30 min, never back to baseline; delay is learned as a *spatial gain*, not as time | 100 ms hurts an interception task | Avraham et al. 2017, https://pmc.ncbi.nlm.nih.gov/articles/PMC5788056/ |
| Virtual ball bouncing with 83.75-335 ms system delay: initially disrupted, then stabilized after fifty 40-s trials | 84-335 ms adaptable with practice | Morice et al. 2008, https://www.sciencedirect.com/science/article/abs/pii/S0165027007005614 (abstract; the search snippet carried the numbers, the page itself refused fetch) |
| Interception timing precision ~5-7 ms SD; people "adjusted where rather than when they would hit the target if given the choice" | 5-7 ms; spatial adjustment preferred | Brenner & Smeets 2015, https://jov.arvojournals.org/article.aspx?articleid=2213289 |
| Simple visual reaction time, 1,469 subjects: mean 231 ms (hardware-corrected); typical adult range 200-250 ms | ~230-250 ms | Woods et al. 2015, https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4374455/ |

Reading these together for our case:

- Acting on your *own* hand must be < ~25 ms late — and it is 0 on the network in this design; only the tracking pipeline counts (the existing latency work).
- A ball whose *arrival time* is off by up to ~100 ms is still catchable if the player was warned (Pong's 100 ms crash was a sudden, unannounced, constant feedback delay on the paddle — the worst case; our arrival is a known event with a visible cue and a hand that has zero delay).
- Watching a remote catch 150-250 ms late reads as synchronous after a minute (Cunningham). Above ~400 ms it stops feeling like one game.
- People correct *where* not *when*: give them a spatial target (arrival ring at the exact edge height) rather than a countdown.

## 3. Derived budgets

- **Reaction budget**: 230 ms RT + ~250 ms to move a hand 0.3 tile-heights ≈ **500 ms** from "ball visibly coming" to "hand where it needs to be". Therefore the **arrival cue must lead the crossing by >= 300 ms** and the **flight inside the receiving tile must be >= 250 ms** before the ball reaches the likely hand zone (the middle third).
- **Entry speed cap**: a hand of ~0.15 tile-height width intercepts a ball travelling `v` for `0.15 / v` s; at 2.0 units/s that is 75 ms of "hand in the way", well above the 5-7 ms timing precision, and gives ~350 ms of in-tile flight across a 16:9 tile. So **cap `|v|` at 2.0 units/s on entry into a tracked tile** (3.0 on the thrower's side so the throw still looks strong; the ball decelerates in the gutter, which reads as air resistance).
- **Adjust-vs-jump rule** for correcting the dead-reckoned ball: if the predicted and actual arrival differ by < **80 ms**, adjust velocity to converge; else jump. Racer used 75 ms for the same decision (https://web.dev/racer). Position error < 0.3 units blends over 100 ms, else snaps (`sync-protocol.md` §8).
- **Boundary stretch floor**: the ball never appears at the receiver's edge sooner than **80 ms** (`TUNING.MIN_LEAD_MS`) after the receiver learned about it (`tEdge' = max(tEdge, now + 80 ms)`, `boundaryStretch()`), so there is always one frame of cue before the ball. With the default 0.08-unit gutter the gutter flight is only ~45 ms at 2 units/s, so at WAN latency *every* throw stretches (smoke test: 150-170 ms at 120 ± 30 ms) — the slow-mo in §5.3 is therefore the normal look of a remote pass, not an exception; widen `gutter` in the seat map if a longer real flight is wanted.

## 4. Tolerance bands (one-way, end to end, per tile)

| `L` | Feel | What the game does |
|---|---|---|
| < 80 ms | invisible | nothing special; ring + whoosh are cosmetic |
| 80-150 ms | fine | ghost ball + arrival ring carry the timing; remote hands may show slight lag when watching |
| 150-300 ms | playable, noticeably "remote" | boundary stretch kicks in on fast throws (`L > T_e`); the ball hangs in the gutter for the difference, with a visible slow-mo so the pause reads as intentional; audio cue leads |
| 300-500 ms | degraded | tile auto-switches to **catch assist** (contact friction 0.95 instead of 0.85 on support — friction only, the hand still never rebounds the ball, `mechanics-options.md` §0), entry cap 1.5 units/s; hot-potato mode recommended |
| > 500 ms | not a player | tile is demoted to `goal` / `wall` / `portal` role automatically (seat map bump by the host); the participant is told why in the tile badge |

## 5. Tricks that hide what is left

1. **Predicted-arrival ghost** — as soon as the LAUNCH arrives, the receiving tile integrates the trajectory forward and draws a 35 %-alpha ball travelling the predicted path from the gutter into the tile. At `tEdge` the ghost becomes the real ball (same mesh, alpha to 1). The thrower sees no ghost (its ball is real until the CLAIM).
2. **Arrival ring** — a ring on the receiving edge at `cEdge` (exact height), radius shrinking from 3 R to R over the last 400 ms before `tEdge'`, colour of the thrower's tile. This is the "adjust *where*" affordance: it tells the hand where to be, not when. The beat-game note highway in `sdk/core/beat-game.js` is the same visual language.
3. **Boundary stretch (slow-mo)** — when `L > T_e` or a late CLAIM re-times the transit, the ball's *gutter* segment is time-scaled (0.4x) rather than jumped. It is computed from the shared clock, so every viewer sees the same pause; it is never applied inside a tile, so physics in tiles stays real.
4. **Audio cue** — `AudioContext` + `StereoPannerNode`: a whoosh panned toward the receiving tile at `T0 + L` (immediately on LAUNCH), a soft "thud" on support/cradle from the catcher's own client (0 latency), a ring for a goal. Audio leads vision by nature (no decode pipeline) and pans across the gallery, so the ear tracks the ball through the gutter.
5. **Soft entry** — entry speed cap (§3) plus a 100 ms exponential blend from gutter speed to capped speed, so the ball visibly "settles" into the tile.
6. **Visible transit lane** — the gutter is drawn as a faint lane on the overlay with the ball shadow; nobody wonders where the ball went while it is between tiles.
7. **Smooth remote hands** — the stack already renders remote players one snapshot interval behind with linear snapshot interpolation (`mpgames.html` YOLO bridge, `MULTIPLAYER_SYNC_ARCHITECTURES.md`); if fingers stutter at 20-30 Hz, upgrade to Hermite using a relayed velocity (Gaffer: Hermite removed the jitter that linear showed at 10 pps, https://gafferongames.com/post/snapshot_interpolation/).
8. **Hand-age fade** — `handAgeAlpha(ageMs)`: a remote holohand whose last packet is > 150 ms old fades toward 50 % and stops conforming; a held ball on such a hand falls back to world position (an honest signal instead of a frozen hand).
9. **Catch grace** — the frozen glass-ball lane's 6 mm grab skin / 30 mm keep skin hysteresis (`mechanics-options.md` §0) keeps tracking flicker from flinging a held ball; `HOLD_GRACE_FRAMES = 4` is the cube lane's equivalent and is not used by the ball. Unchanged.
10. **Catch assist** (per-tile, opt-in or auto in the 300-500 ms band) — friction and rebound only; never a snap.
11. **Latency HUD** — per tile: one-way `L`, packet age, stretch applied, claim conflicts, timeouts; from `BallNet.getStats()`; visible during the pilot, hideable for the demo.
12. **Never**: no server rewind/lag compensation (nothing to rewind, the catcher is the authority), no rubber-banding the thrower (the CLAIM matches its prediction), no teleport-to-hand "help".

## 6. Measurement plan

- **Probe** (already planned): cross-correlate wrist height from a direct tracker and a screen-captured one to get camera→render latency per machine; add the ball: log `T0` at release and the `T` at which each client first rendered the ball inside the receiving rect. One-way `L` = `render time - tEdge'` on the shared clock (clock error ≤ 10 ms, `sync-protocol.md` §3).
- **Loopback profiles** (`LoopbackTransport({latencyMs, jitterMs, lossPct})` in a browser, `MemHub.link(a, b, {latencyMs, jitterMs, lossPct})` headless): LAN 20 ± 5, 0 %; WAN 90 ± 20, 1 %; bad Wi-Fi 250 ± 80, 5 %; phone-on-4G 400 ± 150, 3 %. The smoke test runs 120 ± 30, 5 %.
- **Acceptance**: at WAN, 10 throws each between three tiles: ≥ 8/10 caught by a practised player, zero duplicate balls, zero thrower-side corrections, arrival cue leads the ball by ≥ 300 ms in every throw log.

## 7. Sources

- Jota et al. 2013: https://www.tactuallabs.com/papers/howFastIsFastEnoughCHI13.pdf
- Cunningham et al. 2001: https://doi.org/10.1111/1467-9280.d01-17
- Frontiers in Virtual Reality 2021 (steering latency, cites Cunningham/Davis): https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2021.727858/full
- Avraham et al. 2017 (Pong delay, state-based representation): https://pmc.ncbi.nlm.nih.gov/articles/PMC5788056/
- Morice et al. 2008 (virtual ball bouncing latency): https://www.sciencedirect.com/science/article/abs/pii/S0165027007005614
- Brenner & Smeets 2015 (interception precision): https://jov.arvojournals.org/article.aspx?articleid=2213289
- Woods et al. 2015 (simple reaction time): https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4374455/
- Racer case study: https://web.dev/racer
- Gaffer on Games snapshot interpolation: https://gafferongames.com/post/snapshot_interpolation/
- Valve Source networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
