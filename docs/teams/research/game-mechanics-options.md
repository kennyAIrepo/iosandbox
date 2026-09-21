# Teams football — mechanics options (cross-tile ball game)

Researcher folder: `game`. Date: 2026-09-18. Companion files: `space-mapping.md`, `sync-protocol.md`, `latency-feel.md`, `examples/`. Nothing under `C:/Users/hanna/iosandbox` was modified; line numbers below were read from the working tree on this date.

## 0. What the stack already gives us (read from the repo, not assumed)

| Piece | Where (file:line) | What it settles for the game |
|---|---|---|
| Hand as a physics body: 21 joint spheres with radii `JOINT_RADII[i] * scale`, `scale = span / (REST_SPAN * 0.6)` clamped 0.2..4; `palmVel`; `angVel` (lerp 0.4, decays 0.8 when still); `openness`; `pinch` + `pinchPoint`; `punchSpeed`; measured inner-palm normal `palmOut` / `palmSign` (never a handedness label) | `sdk/core/game-physics.js:38-208` | throw velocity, spin, "is the hand giving with the ball", palm side |
| `GrabbableSphere`: `gravity = -5.2`, `restitution = 0.58`, `drag = 0.996` per frame; release velocity = mean of the last 6 palm-follow velocities in `_velHist`; release spin = `hand.angVel * 0.85`; floor bounce only when `|vy| > 0.35`, else stop | `sdk/core/game-physics.js:225-345` | the launch vector and the integrator every client must share |
| `GrabbableSphere._pushOut`: positional correction out of every joint sphere, then an impulse `vel += n * (-(1.4) * vn)` ("bounce off the hand, e ≈ 0.4"), tangential carry 0.35, spin transfer, spin cap 40 rad/s | `sdk/core/game-physics.js:351-372` | a *rebounding* bat exists in the engine — but see the next row |
| **Glass-ball lane (the BALL DOCTRINE, frozen)**: `_holdPose` = palm up `n.y > 0.4`, closure 0.02..0.8, `pocket = palmCentre + n * (R + 0.04)`; `_wrapGrab(pack, skin)` mesh-true grip with a **6 mm** skin to grab and **30 mm** to keep (hysteresis, re-checked every frame); cradle keeps while `n.y > 0.3` and the ball is within `1.1 R` of the pocket, else "rolls off, keeps its velocity"; **depth bias**: any palm/fingertip joint within `1.2 R` in x/y eases the ball's z to contact depth on the side it is already on, `off = (R + 0.03) * max(0.15, abs(n.z))`, rate `min(1, dt*6)`; free flight = `this.sphere.update(dt, [], floorY)` — **the sphere's own hand logic is never given hands**; **support** = `hull.pushOut` capped at 2 cm/frame, **inward normal velocity killed** (`if (vn < 0) vel += n * -vn`, "no bounce into the hand"), then `vel *= 0.85` contact friction; residual `_handResist` with a 4 mm skin stops the holohand entering the ball; reset when > 3.4 m from home | `mpbrowser.html:1290-1720` (`_holdPose` :1380, `_wrapGrab` :1411, hold re-check :1598-1602, grab gate :1620-1628, cradle :1634-1651, depth bias :1655-1675, free flight :1677, support :1680-1694, resist :1706-1712, reset :1718); `_handResist` :2324-2331 | the catch rules in §3 are these rules, unchanged. **Note the correction to the earlier draft:** in the frozen lane a hand *supports and pushes*; it does not *rebound* the ball (e = 0 on the hand side). The e ≈ 0.4 rebound is the cube lane's `_pushOut`, which the doctrine keeps away from new props. |
| Exact sphere hull `PropHull.sphere(r)`; queries `surfaceDistance`, `closest` (point + outward normal), `handGap`, `pushOut` | `sdk/core/prop-hull.js:24-28, 117, 136-172` | the ball's collision shape (a capsule chain baked from a sphere over-reaches — the 2026-09-15 bug) |
| Skin conform sits **+3 mm** off the collider shell ("conformed skin sits just OFF the shell") | `sdk/core/hand-rig.js:414-443` | the no-gap / no-pierce look we must reproduce on remote hands |
| `HOLD_GRACE_FRAMES = 4` ("webcam tracking flicker must not fling it") | `sdk/core/game-physics.js:420` — used by the **cube** (`GrabbableBox`) | the ball lane does not use it; its flicker protection is the 6 mm → 30 mm skin hysteresis above |
| `PlayerFrame = { id, bbox, body2D, wrists (MIRRORED display space), hands: { left, right } each { img: 21 mirrored, world: 21 raw metric } | null }`, stable ids | `sdk/core/multiplayer.js:12-16` | per-tile players; the `img` frame is mirrored (matters for `space-mapping.md` §7) |
| Cross-page presence bus: `BroadcastChannel('hopeos-room')`, packet `{ v: 1, kind: 'presence', t, cut, cal, profile, players: [{ tag, id, team, col, court, box, k }], balls: [] }` at ~12 Hz (80 ms throttle); consumed by `dollhouse.html`, also opened by `mpbrowser.html` | `mpgames.html:608, 1568-1578, 2603`; `dollhouse.html`, `mpbrowser.html` | this **is** "our landmark relay" today; it already carries a `balls: []` slot |
| Two-bus protocol model (ephemeral newest-wins presence vs reliable ordered state), ownership-handoff authority, planned `sdk/core/cosession.js`, WebRTC `ch1 unordered maxRetransmits:0` + `ch2 ordered`, Vercel cannot host sockets | `MULTIPLAYER_SYNC_ARCHITECTURES.md:11-31, 59-63, 84-91, 100-131` | the wire design we ride (cosession.js is not built yet) |

The user-frozen doctrine (memory: *prop collision doctrine*) applies verbatim: pickup only by finger wrap / claw / clip / measured holding-pose cradle; open = release; gravity always on; hands support and never pass through; never `jointsWithin`/pinch grab; never gravity-off seek.

## 1. Three candidate rule sets

### (a) FREE PASS + GOAL TILES ("Teams football") — the screenshot game

- One shared ball. Whoever holds it (cradle / wrap / clip) can throw in any direction. The ball leaves the tile through an edge and enters the adjacent tile per the seat map (`space-mapping.md` §3).
- Exactly one tile is the **goal** at a time (organizer sets it; rotates after each score or every 60 s). The goal tile shows a goal frame on its far edge (or a ring in its lower third). A **goal** scores when the ball's centre crosses the goal plane inside the frame while the ball is *free* (not supported, cradled or held in that tile).
- Tracked goal participant = keeper. Because hands support and never pass through (doctrine), a hand in the way *is* a save; no extra block logic.
- Untracked goal participant (phone, camera off) = passive goal: entry into the zone scores. The session host's client simulates the ball while it is in that tile (proxy ownership, `sync-protocol.md` §10).
- Score goes to the last tile that launched the ball before it crossed into the goal tile, with no tracked touch in between.

Pros: matches the user's marked-up screenshot; the clearest possible "remote co-presence" beat (the ball leaves my window and enters yours); untracked people have a role (goal, wall, portal); throw and catch are both real hand physics already in the stack.
Cons: needs the full court map, the transit lane and ownership handoff at edges — the hardest part of the four files; a fast throw into a high-latency tile can be due before the receiver's client has heard about it (mitigated by the scheduled handoff and the boundary stretch, `latency-feel.md` §3); scoring needs one authority per goal event (the goal tile's owner or the host proxy).

### (b) HOT POTATO (timer-authoritative)

- Same passing physics; the only global rule is *who owns the ball when the timer fires*. A shared countdown (8–20 s) runs; when it ends, the current owner loses a life.
- A pass moves the potato only when the receiver actually **supports or cradles** the ball for >= 4 frames (contact normal `n.y > 0.5`, relative speed < 0.15 units/s). A dropped ball rolls to the receiver's floor and still belongs to the receiver, so dropping on purpose does not help.
- Untracked tiles cannot hold the potato; a throw into one makes it a **portal** (constant-speed crossing, exits the opposite edge, host proxies it).

Pros: the least latency-sensitive of the three: the one global decision is "owner at time T" on the shared clock. Inside Teams this is exactly what `LiveTimer` is for — `start(durationMs)`, `pause()`, `play()`, events `started`/`played`/`paused` `(config, local)`, `finished(config)`, `onTick(milliRemaining)` at a default `tickRate` of 20 ms (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/livetimer and the capabilities page https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities). Boundary races resolve by `ownerSeq` (`sync-protocol.md` §7), never by a physics race. Every shipped Teams-meeting game we could verify is turn-based or semi-synchronous: Games for Work (IceBreakers, Wordament, Minesweeper, Solitaire; 2–250 players; no real-time physics; the pilot app was discontinued on 2024-05-24 per the same post — https://www.microsoft.com/en-us/copilot/blog/2022/11/16/build-connections-with-games-for-work-a-new-microsoft-teams-app/) and UCL's Teams Carnival (eight Live Share games: Trivia Race and Snakes & Ladders on a single DDS, T-Rex and Space Shooter on `SharedMap` + `LivePresence`/`LiveTimer`, Balloon Bomb on `SharedMap` + `LiveEvent` + `LivePresence`, all turn-based, asynchronous or "semi-synchronous" — https://github.com/Teams-Carnival-Games, README https://raw.githubusercontent.com/Teams-Carnival-Games/.github/main/profile/README.md). Hot potato is the mode that stays inside that envelope.
Cons: less "football"; without a goal it reads as a party game; the timer makes people throw carelessly, which stresses the catch (good for testing, worse for a polished demo).

### (c) VOLLEY / KEEP-UP (co-op rally)

- Shared rally counter. Every legal *touch-then-throw* (support or cradle, then a launch that crosses into another tile) increments the rally; it resets when the ball lands on any floor, exits the court, or crosses into an untracked tile that is not a wall.
- Variant **no-hold**: the ball must be batted, never held.
- Score = best rally; per-session leaderboard (`SharedMap` inside Teams, as Teams Carnival's Pac-Man does for live scores).

Pros: cooperative (right tone for a work meeting), no goal designation UI, spectators can count along.
Cons (the important one is new): **the frozen ball lane cannot bat.** Its support step is a positional push-out with the inward velocity *killed* and a 0.85 friction multiply (`mpbrowser.html:1680-1694`); a hand moving upward carries the ball while in contact but imparts no launch velocity, so a "keep-up" tap gives no flight. A rebound exists only in `GrabbableSphere._pushOut` (`game-physics.js:351-372`), which the doctrine keeps away from new props. Making (c) work needs a *game-layer* rule that adds the contact joint's velocity (`HandBody.vel[i]`) to the ball on push-out — a change to the ball lane that the user has ordered frozen. Also: a single drop ends the fun; latency directly shortens the rally; untracked participants have nothing to do.

### Recommendation

Ship **(a) Free pass + goal tiles** as the headline, with **(b) Hot potato** as a mode switch that shares > 90 % of the code (adds a shared timer, removes the goal). Keep **(c)** as a *held-ball* rally counter for a practice screen only (touch = support/cradle, launch = release), and do **not** promise the no-hold bat variant until the user unfreezes the ball lane for a velocity-inheriting push-out.

Why: (a) is what the user drew; (b) is the fallback for a bad-network pilot day (only the timer is global); (c)'s held-ball form costs nothing extra.

Build order that de-risks (a): two windows in one browser over `BroadcastChannel` (`examples/transports.mjs` `LoopbackTransport`, latency/jitter/loss injectable) → two laptops over the `ws` relay (`examples/relay-server.mjs`) → WebRTC data channels → a Live Share adapter inside a Teams meeting (Live Share "packages require the Teams Client SDK to function properly. Features in `@microsoft/live-share` ... don't work outside Microsoft Teams" — https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq; `TestLiveShareHost.create()` exists for local dev — https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/testlivesharehost).

## 2. Throw detection (from hand velocity, under the doctrine)

Release is **not** a gesture. It is the grab gate failing: `_wrapGrab` re-checked every frame with the looser 30 mm skin (`mpbrowser.html:1598-1602`), or the cradle's palm tilting below `n.y = 0.3` (`:1638-1639`), or the hand leaving. The throw detector only classifies what the release *was* and builds the launch vector (`examples/throw-detect.mjs`):

1. **Launch velocity** `v0` = mean of the last 6 palm-follow velocities — identical to `GrabbableSphere` (`game-physics.js:268-271, 286-287`) so local and remote agree. Spin `w0 = 0.85 * HandBody.angVel` (`:272`) for wrap/clip; for a cradle, the palm's angular velocity at tilt-off.
2. **Coherence gate** (rejects tracking jitter): the last 3 velocity samples must agree in direction (pairwise dot > 0.8 after normalising) and the six palm joints (MediaPipe 0, 1, 5, 9, 13, 17 — the same `PALM_JOINTS` list the engine uses at `game-physics.js:419`) must move coherently (mean pairwise dot of `HandBody.vel[i]` > 0.7). Incoherent, or the hand vanished, = a **drop** (speed clamped to 0.3 units/s), never a throw.
3. **Classify** by `|v0|` in court units (1 unit = tile height, `space-mapping.md` §2):
   - `< 0.25` : **drop** — falls in place, stays in this tile, owner unchanged.
   - `0.25 .. 3.0` : **throw** — full ballistic flight; if the predicted path exits an edge with a neighbour, it is a pass (LAUNCH packet).
   - `>= 3.0` : **clamped throw** — scaled to 3.0 (faster than ~3 tile-heights/s is uncatchable at the 500 ms reaction budget in `latency-feel.md` §3); the excess becomes cosmetic spin.
4. **Roll-out**: a free ball rolling off the tile's floor edge or pushed across an edge by a supporting hand emits the same LAUNCH with `reason = roll` (velocity is whatever the push-out/floor physics left it with).
5. **Predicted exit** at launch: integrate `v0` with court gravity `g = 5.2` units/s^2 and drag `0.996` per 60 Hz frame (the engine defaults, reinterpreted in court units) until an edge is hit; the LAUNCH carries exit edge, edge coordinate `cEdge` and the shared-clock crossing time `tEdge`, so everyone draws the same arrival cue without waiting for physics packets.

## 3. Catch rules (prop doctrine, no snapping)

A catch is not an event we detect and then "attach" the ball to a hand; it is the *state* the local physics leaves the ball in. Three states count, in increasing strength:

| State | How it happens (existing code path) | Counts as |
|---|---|---|
| **SUPPORT** | the hull is pushed out of joint spheres (`mpbrowser.html:1680-1694`); contact normal `n.y > 0.5` and relative speed < 0.15 units/s for >= 4 frames | a *touch* (rally counter, keeper save). Not possession. |
| **CRADLE** | holding pose (`_holdPose`, palm up `n.y > 0.4`, closure 0.02..0.8); a nearby free ball is pulled in x/z into the pocket (never lifted) and rides the palm while `n.y > 0.3` (`:1634-1651, 1696-1701`) | *possession* |
| **WRAP / CLAW / CLIP** | mesh-true grab gate, 6 mm skin (`_wrapGrab(pack, 0.006, slot)`, `:1620-1628`), kept with the 30 mm skin | *possession* |

Rules that follow from the doctrine and matter for a thrown ball:

- **Incoming speed is absorbed by the hand, not by code.** On contact the inward normal velocity is removed and the ball keeps 85 % of what is left, per frame of contact (`:1690-1692`). A hand that moves *with* the ball reads as a soft catch; a stiff hand stops it dead (no rebound in this lane). Because there is no rebound, a caught ball does not bounce out of a palm — good for catching, bad for batting (§1c). We cap the **entry** speed into a tracked tile at 2.0 units/s (`latency-feel.md` §3) so a normal hand can get under it.
- **Depth is solved for the catcher by the depth bias**: any hand over the incoming ball on screen brings the ball's z to contact depth on its own side (`:1655-1675`), gravity untouched. On entry the receiving tile places the ball at its hand plane (`space-mapping.md` §6) so the bias has little to do.
- **Never snap.** No `jointsWithin` grab, no gravity-off seek. The only attractions are the doctrine's own: the cradle pocket pull in x/z and the z-only depth bias, both with gravity on.
- **Remote view of a catch has no gap.** The owner sends the hold as *palm-local* data (`hold mode, hand slot, offset in the palm frame, quaternion`, `sync-protocol.md` §6). Non-owners place the ball from the *received hand landmarks* of that tile plus the offset — not from a world position. The receiving side runs the same `HoloHandRig` with the same +3 mm conform (`hand-rig.js:443`), so the remote ball sits on the remote skin exactly like the local one. World position is only the fallback when that hand stream is older than 150 ms.
- **Two-hand pinch scale stays** (it is an on-screen gesture gated by x/y distance) but is disabled while the ball is in transit and for 300 ms before a predicted arrival, so a pinch in the catch window cannot resize the incoming ball.
- **Accessibility option (off by default): catch assist** = contact friction 0.95 instead of 0.85 for *incoming* balls only, per tile. Still shape-vs-shape, still gravity on, so it does not violate the doctrine.

## 4. When nobody catches

1. The ball falls to the **tile floor** (a plane at the tile's bottom edge in court space — the participant's desk height), bounces once if `|vy| > 0.35` (restitution 0.58) and rolls to a stop, as `GrabbableSphere.update` already does. It stays *in that tile* and belongs to that tile's client (or the host proxy for an untracked tile). Anyone in the tile can pick it up (cradle / wrap).
2. If it is not picked up within **8 s**, or the tile is untracked, it **sinks through the floor into the shared gutter** (a visible strip under the gallery in the twin; the bottom band of our canvas on a Teams stage), rolls toward the **kick-off tile** and respawns on that tile's floor. Kick-off tile: mode (a) = the tile that conceded the last goal, else the last legal thrower; mode (b) = the tile that dropped it; mode (c) = the tile that started the rally.
3. An edge with **no neighbour** (outer boundary or a gap in the seat map) is **out**. Default: a soft wall (restitution 0.5) bounces the ball back into the same tile; a rules toggle makes it a throw-in from the nearest tile. Top edges are always soft ceilings.
4. The floor/gutter lifecycle is owned by whichever client owns the ball at the time; the respawn is a normal LAUNCH with `reason = respawn`, so it is a scheduled handoff like any other and every client sees the same respawn time on the shared clock.

## 5. Precedent notes used here

- Ownership vs authority, sequence rules, exclusive ownership until relinquished, 10 Hz sends, 100 ms jitter buffer: Gaffer on Games, *Networked Physics in Virtual Reality* — "Once a cube is owned by a player, no other player could take ownership until that player relinquished ownership"; "Ownership is stronger than authority, such that an increase in ownership sequence wins over an increase in authority sequence number" — https://gafferongames.com/post/networked_physics_in_virtual_reality/
- Unity Netcode for GameObjects 2.11.2 ownership API: `ChangeOwnership(clientId)`, `RequestOwnership()`, `RemoveOwnership()`, `SetOwnershipLock(bool)`, `OwnershipStatus` flags `None | Distributable | Transferable | RequestRequired | SessionOwner`, callbacks `OnOwnershipRequested` / `OnOwnershipRequestResponse`; "the owner of a NetworkObject is always the authority for that NetworkObject" in distributed authority — https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@2.11/manual/components/core/networkobject-ownership.html
- Photon Fusion 2 state authority: `RequestStateAuthority()` is granted only if `AllowStateAuthorityOverride` is enabled or the object has no current State Authority; `ReleaseStateAuthority()`; `IStateAuthorityChanged.StateAuthorityChanged()`; networked properties replicate only from the State Authority — https://doc.photonengine.com/fusion/current/manual/network-object. **Direct fetch is bot-blocked (Gcore validation page); these names come from the search-engine snippet of that page and were not read from the page itself.**
- Games for Work (2022-11-16; discontinued 2024-05-24): https://www.microsoft.com/en-us/copilot/blog/2022/11/16/build-connections-with-games-for-work-a-new-microsoft-teams-app/
- Teams Carnival (UCL MSc, 6 students, MIT): https://github.com/Teams-Carnival-Games and https://raw.githubusercontent.com/Teams-Carnival-Games/.github/main/profile/README.md. The Microsoft Tech Community write-up (https://techcommunity.microsoft.com/blog/educatordeveloperblog/multiplayer-gaming-experiences-in-microsoft-teams-using-live-share-sdk/3951741) renders client-side and returned only its title to our fetcher, so no latency quotation is taken from it.
- Live Share `LiveTimer`: https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/livetimer ; capabilities page: https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities ; FAQ: https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-faq
