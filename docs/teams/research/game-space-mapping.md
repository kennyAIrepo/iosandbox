# Space mapping — every tile's camera space into one shared 2D court

Researcher folder: `game`. Date: 2026-09-18. Code: `examples/court-map.mjs`.

## 1. Facts that constrain the map

1. **Teams' gallery order is per viewer and cannot be rearranged.** Microsoft Q&A: video priority is "Active speakers ... pinning or spotlighting ... Content sharing ... Bandwidth and device performance", "The limit of 49 videos is applied per viewer ... each viewer's view is independent", and "meeting organizers cannot directly change the view settings of all participants" (https://learn.microsoft.com/en-us/answers/questions/2123027/how-does-teams-prioritize-and-display-video-feeds). A May 2025 request to "swap people left and right" was answered with "submit or upvote this feature request on the Microsoft Feedback Portal" (https://learn.microsoft.com/en-us/answers/questions/4438023/rearrange-order-of-participants-in-teams-when-will). The support page adds: Large gallery "is available when at least ten people have their cameras turned on", more than 49 participants are paged, "Pin for me" is per viewer, "Spotlight for everyone" is organizer/presenter only (https://support.microsoft.com/en-us/teams/meetings/customize-your-meeting-view-in-microsoft-teams).
   Consequence: *the game owns its seat map.* We never derive adjacency from Teams' gallery; we render our own gallery (the twin, or our stage app) from a host-authored seat map every client shares.
2. **Together mode was the fixed-seat precedent — and it is gone.** Organizers could "assign seats to attendees by dragging the user to the preferred seat" and "everyone in the meeting will see the participants organized by seating assignment" (https://websites.uta.edu/oit/2022/08/25/assign-seats-in-together-mode). Microsoft retired it: UC Today (2026-05-18) reports the retirement "starting in early June, completing by late June" 2026, to simplify the meeting experience, reduce backend complexity and redirect engineering to video quality, stability and performance (https://www.uctoday.com/unified-communications/microsoft-is-retiring-teams-together-mode-the-end-of-a-pandemic-era-big-idea/); gHacks gives the cut-off as June 30, 2026 with gallery view as the replacement (https://www.ghacks.net/2026/05/22/microsoft-retires-teams-together-mode-on-june-30-pointing-users-to-gallery-view/). Microsoft's own announcement post (https://techcommunity.microsoft.com/blog/microsoft365insiderblog/goodbye-together-mode-hello-simplified-meeting-layouts-in-microsoft-teams/4519312) renders client-side and gave our fetcher only its title. A shared, same-for-everyone seating is a gap Teams just vacated.
3. **Zoom's two precedents both put the host in charge of placement, in pixels.** Immersive View "assembles up to 25 participants in one ... meeting environment", hosts "automatically or manually place participants into a virtual scene", can "move participants around that scene and even resize", overflow goes to "a thumbnail strip on the top of the scene" (2021-04-26, https://www.zoom.com/en/blog/introducing-zoom-immersive-view/). The Zoom Apps Layers API: `zoomSdk.runRenderingContext({ view: 'immersive' | 'camera' })` — "Only a meeting host may set the rendering context to immersive", "Only one app instance can create an immersive rendering context at a time"; `zoomSdk.drawParticipant({ participantUUID, x, y, width, height, zIndex, cutout })` in CSS pixels (`"Npx"`, `"N%"` or raw numbers); `clearParticipant`, `drawImage`, `drawWebView`, `closeRenderingContext`, `postMessage`/`onMessage`; requires client 5.10.6+ (https://developers.zoom.us/docs/zoom-apps/guides/layers-using-api/ and https://raw.githubusercontent.com/zoom/skills/main/skills/zoom-apps-sdk/references/layers-api.md). Our seat map is the same object expressed in court units instead of pixels.
4. **Racer's multi-screen rule** (Google I/O 2013; up to 5 phones/tablets; WebSockets via a Compute Engine relay): the track "height by finding the height of the smallest screen, and the width is the total width of all screens", each device offsets by its position in the line-up; the device showing the car sends its state "every 4 frames"; the clock polls the server several times and uses the median to land "within 10ms"; a late message under 75 ms adjusts velocity, over 75 ms jumps (https://web.dev/racer; https://developers.googleblog.com/en/race-across-screens-and-platforms-powered-by-the-mobile-web/). We adopt the same shape: one shared strip, tiles laid edge to edge, the tile showing the ball owns it.
5. **bgstaal/multipleWindow3dScene** treats the *physical screen* as the world: `WindowManager.js` stores `{x: window.screenLeft, y: window.screenTop, w: window.innerWidth, h: window.innerHeight}` per window under the `localStorage` keys `"windows"` and `"count"`, and listens to the `storage` event for `event.key == "windows"`; `main.js` sets `sceneOffsetTarget = {x: -window.screenX, y: -window.screenY}` and places each cube at `win.shape.x + win.shape.w * .5, win.shape.y + win.shape.h * .5` (https://raw.githubusercontent.com/bgstaal/multipleWindow3dScene/master/WindowManager.js, https://raw.githubusercontent.com/bgstaal/multipleWindow3dScene/master/main.js). Google's *Browser Ball* (Mark Mahoney, March 2009) did the same for a beach ball: "Open new windows. Throw a beach ball through them", the windows acting as one canvas (https://experiments.withgoogle.com/browser-ball); *Roll It* (2013-05-28) flicked a ball from a phone onto a browser alley (https://www.engadget.com/2013-05-28-google-roll-it.html). Those work because the windows share one screen. Our tiles are on different screens in different rooms, so the "shared world" must be virtual — the court — and the seat map plays the role of the `localStorage` window list. We reuse the trick literally for the **two-window local twin** (two browser windows on one desk share the court over `BroadcastChannel`, `examples/transports.mjs`).

## 2. The frames

| Frame | Units / axes | Where it lives |
|---|---|---|
| **Image frame** of tile i | MediaPipe normalized `(u, v)` in [0,1], origin top-left, `u` right, `v` down, **canonical = un-mirrored** (as others see you) | per tile; today `PlayerFrame.hands[].img` is *mirrored* (`sdk/core/multiplayer.js:13-14`) — see §7 |
| **Tile world** of tile i | that tile's three.js scene (camera at origin, metric hand `world` landmarks, ball radius `R_i`) | per tile; each client runs a scene for its own tile and renders remote tiles from relayed landmarks in the same kind of scene |
| **Court** | 2D, `x` right, `y` up, **1 unit = tile height**. Tile i occupies `[x0_i, x0_i + a_i] x [y0_i, y0_i + 1]`, `a_i` = aspect of the tile's canonical video (16:9 → 1.777; portrait phone → 0.5625). Gutter `g = 0.08` between tiles = the transit lane. | shared; the only frame that crosses the wire |
| **Depth** `d` in [-1, 1] | tile-local; `0` = the tile's hand plane | a hint on the wire, never shared physics (§6) |
| **Viewer pixels** | each viewer's own DOM gallery | per viewer (§8) |

Court `y` is "height in the tile" for everyone: a throw released at chest height in A arrives at chest height in B regardless of pixel sizes, because `y` is a fraction of tile height on both sides — Racer's smallest-height rule, done by normalisation instead of shrinking.

## 3. Seat map (host-authored, shared, versioned)

```jsonc
{
  "v": 3,                        // bumps on every change; clients ignore older
  "unit": "tileHeight",
  "gutter": 0.08,
  "cols": 3, "rows": 1,
  "wrap": "row",                 // "none" | "row": last seat's right edge -> first seat's left edge (a ring)
  "outer": "wall",               // "wall" | "out" for edges with no neighbour
  "goal": 2,                     // seat index that is the goal (mode a)
  "kickoff": 0,
  "seats": [
    { "seat": 0, "clientId": "c-3f1", "name": "Hanna", "tracked": true,  "role": "player", "aspect": 1.777, "handSpan": 0.19 },
    { "seat": 1, "clientId": "c-9a0", "name": "Kenny", "tracked": true,  "role": "player", "aspect": 1.777, "handSpan": 0.21 },
    { "seat": 2, "clientId": "c-b77", "name": "Phone", "tracked": false, "role": "goal",   "aspect": 0.5625 }
  ]
}
```

- `seat` is the index in every packet (`u8`).
- `role`: `player` (tracked, can hold), `goal`, `wall` (untracked, edges bounce), `portal` (untracked, ball crosses at constant speed), `spectator` (not on the court).
- Rects from the map, row-major: `x0_i = sum over earlier seats in the row of (a_j + g)`; `y0_i = (rows - 1 - row) * (1 + g)`.
- Adjacency = shared-edge rectangle adjacency, computed, not stored. `wrap: "row"` joins the row's last right edge to its first left edge so three players can all reach each other with one throw.
- The host publishes the map on the reliable bus (`SEAT_MAP 0x20`, JSON). Inside Teams it is a `LiveState` value: `initialize(initialState, allowedRoles?)`, `set(state)`, `on('stateChanged', (state, local, clientId))`; "the `state` value in `LiveState` is reset after all the users disconnect from a session"; `allowedRoles` restricts writers to e.g. `[UserMeetingRole.organizer, UserMeetingRole.presenter]` (https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/livestate, https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities).

## 4. Mapping equations

Tile image → court (canonical `u` right, `v` down):

```
x = x0_i + u * a_i
y = y0_i + (1 - v)
```

Court → tile image: `u = (x - x0_i) / a_i`, `v = 1 - (y - y0_i)`.

Tile world → tile image: project with the tile's three.js camera (`THREE.Vector3.project(camera)` → NDC; `u = (ndc.x + 1) / 2`, `v = (1 - ndc.y) / 2`). Tile image → tile world at depth `d`: unproject a point on the ray and walk `depth` metres from the camera (`CourtMap.tileToWorld`).

Edge exit (owner side, every frame while free): the ball centre `(x, y)` has left rect i through `L` when `x < x0_i - R`, `R` when `x > x0_i + a_i + R`, `T` when `y > y0_i + 1 + R`. The bottom is a **floor**, never an exit. The full radius must clear the edge so the ball visibly leaves.

Entry: the neighbour across edge `E` at coordinate `c` (`y` for L/R, `x` for T) is the rect sharing that edge segment and containing `c`; the ball enters at the *same court coordinates* after crossing the gutter — the court is one plane, nothing is remapped, only the owner changes. No rect contains `c` (size mismatch, gap) → the `outer` rule.

Gutter transit: while `x` is in a gutter the ball has no tile; it is drawn on the court overlay (§8) and keeps integrating with court gravity. Crossing `g = 0.08` at 1–3 units/s takes 27–80 ms — short enough for the scheduled handoff to hide, long enough to show the ball crossing.

## 5. Scale: the same ball in every hand

- Court gravity `g_c = 5.2` units/s^2 and drag 0.996 per 60 Hz frame are the engine's `GrabbableSphere` defaults (`sdk/core/game-physics.js:232-234`) reinterpreted in court units, so every client integrates identically (dead reckoning depends on it).
- `R_court` is a session constant chosen from **hands**, not pixels: each tracked seat publishes its projected wrist→middle-MCP span in court units (`HandBody.scale * REST_SPAN * 0.6` in metres projected through the tile camera); `R_court = 0.45 * median(spans)`. The ball is ~0.45 hand-spans everywhere even if one camera is zoomed in and another shows a whole room.
- Per tile, `R_i` (world metres in that scene) is solved so the projected radius at the hand plane equals `R_court` (`CourtMap.worldRadiusFor`). A person far from the camera sees a smaller ball on screen (correct perspective) but the same ball relative to their hand.
- The hull stays `PropHull.sphere(R_i)`; the doctrine is unchanged.

## 6. Depth: local, never shared as physics

The camera cannot place a hand in depth; that is why the doctrine's depth bias moves the ball's z to contact depth on the palm side (`mpbrowser.html:1655-1675`). So:

- `d` is a **hint** (`i16`, -1..1). On entry the receiving tile places the ball at its hand plane `d = 0` (mean palm z of its tracked hands over the last second, else the tile default) and the depth bias takes over once a hand is near.
- `vz` never routes the ball to another tile. A strong throw *toward* the camera (`vd < -1.5` units/s) becomes a **lob**: `vy += 0.5 * |vd|`, `vd = 0`, so the throw still does something visible. A throw *away* from the camera is damped (`vd → 0` over 150 ms) so the ball does not shrink into the background.
- On the thrower's side the ball keeps its real z until it leaves the tile; the local experience is unchanged.

## 7. Mirror: the court is un-mirrored

Teams mirrors only your own self-preview; "your outgoing video does not change ... your video does not appear mirrored for other people", and the **Mirror my video** toggle (on by default, under Device settings) turns the self-preview mirroring off (Microsoft Teams blog, https://techcommunity.microsoft.com/blog/microsoftteamsblog/turn-off-mirror-my-video-in-microsoft-teams-meetings-to-match-your-video-to-your/3114332 — the page renders client-side; the quoted behaviour is from the search-engine summary of that post and from UTA's 2021-12-13 note "The default will still be mirrored video ... turn off the 'mirror my video' toggle to utilize the un-mirrored view", https://websites.uta.edu/oit/2021/12/13/unmirror). If our court used the mirrored self frame, "my right edge" would be "my left edge" on everyone else's screen.

Decision: **canonical = un-mirrored for every tile, including your own** — game mode = "Mirror my video: off". The twin flips its self video and landmarks to un-mirrored when the game starts (one `scale(-1, 1)` on the tile and `u → 1 - u` on `img` landmarks; `world` landmarks `x → -x`). People adapt in seconds because the ball leaves toward the neighbour they can see. The alternative (mirror the whole gallery for the local viewer) would mirror the other participants too and is rejected.

Tracking-layer note: `PlayerFrame.hands[].img` is documented as *mirrored display space* (`sdk/core/multiplayer.js:13-14`), so `CourtMap.tileToCourt` takes a `mirrored` flag and the conversion happens in exactly one place. Chirality is measured, never assumed (memory: *hand coordinate conventions*), so un-mirroring does not touch handedness logic.

## 8. Viewer pixels and the transit overlay

- Each viewer maps court → its own DOM: `pxPerUnit_i = tileRect_i.height`. Inside a tile the ball is 3D in that tile's canvas; in the gutter it is drawn on a full-gallery 2D overlay canvas over the tiles (`position: absolute; pointer-events: none`). At the edge the 3D ball's projected pixel radius equals the overlay ball's radius by construction (§5), so there is no pop.
- A viewer with a different DOM layout (pinned tile, portrait phone, spotlight) does *not* change the court; only that viewer's pixel mapping differs. Physics is per-tile canonical, rendering is per viewer — Racer's device offsets.
- Inside Teams (a Live Share stage app) the whole stage is our canvas, so the overlay *is* the canvas. We found no TeamsJS or Live Share API that exposes other participants' *video* frames to a stage app, so in-Teams tiles are rendered from relayed landmarks (holohands over an avatar or profile photo); the local twin composites real video. Flagged for the `acs` / `meeting-app` researchers.

## 9. Adjacency examples

Three in a row (the screenshot): `A | B | C`, `wrap: "row"`: A.R → B.L, B.R → C.L, C.R → A.L (ring), and back. Top edges are soft ceilings, bottoms are floors.

Four in a 2 x 2 (`A B / C D`): A.R → B; A's bottom is a floor, so vertical passes do not exist unless `verticalPass: true`, in which case A's floor becomes C's ceiling entry. Recommended off for the demo: gravity already pulls down, so downward "passes" would be free.

Untracked seat in the middle (B is a phone): `role: "portal"` — B renders the ball crossing at constant velocity (host proxy simulates it) and A can still reach C; `role: "wall"` — the ball bounces off B's edge back to A; `role: "goal"` — B is the target.

## 10. Sources

- Teams gallery prioritisation per viewer, 49 per viewer, organizer cannot change others' view: https://learn.microsoft.com/en-us/answers/questions/2123027/how-does-teams-prioritize-and-display-video-feeds
- No reordering of gallery tiles (2025-05-23): https://learn.microsoft.com/en-us/answers/questions/4438023/rearrange-order-of-participants-in-teams-when-will
- Customize your meeting view (Large gallery >= 10 cameras, paging over 49, Pin for me, Spotlight for everyone): https://support.microsoft.com/en-us/teams/meetings/customize-your-meeting-view-in-microsoft-teams
- Together mode seat assignment: https://websites.uta.edu/oit/2022/08/25/assign-seats-in-together-mode ; retirement: https://www.uctoday.com/unified-communications/microsoft-is-retiring-teams-together-mode-the-end-of-a-pandemic-era-big-idea/ , https://www.ghacks.net/2026/05/22/microsoft-retires-teams-together-mode-on-june-30-pointing-users-to-gallery-view/ , announcement (title only on fetch) https://techcommunity.microsoft.com/blog/microsoft365insiderblog/goodbye-together-mode-hello-simplified-meeting-layouts-in-microsoft-teams/4519312
- Teams "Mirror my video": https://techcommunity.microsoft.com/blog/microsoftteamsblog/turn-off-mirror-my-video-in-microsoft-teams-meetings-to-match-your-video-to-your/3114332 ; https://websites.uta.edu/oit/2021/12/13/unmirror
- Zoom Immersive View: https://www.zoom.com/en/blog/introducing-zoom-immersive-view/ ; Zoom Apps Layers API: https://developers.zoom.us/docs/zoom-apps/guides/layers-using-api/ , https://raw.githubusercontent.com/zoom/skills/main/skills/zoom-apps-sdk/references/layers-api.md
- Racer: https://web.dev/racer ; https://developers.googleblog.com/en/race-across-screens-and-platforms-powered-by-the-mobile-web/
- multipleWindow3dScene: https://github.com/bgstaal/multipleWindow3dScene ; raw: https://raw.githubusercontent.com/bgstaal/multipleWindow3dScene/master/WindowManager.js , https://raw.githubusercontent.com/bgstaal/multipleWindow3dScene/master/main.js
- Browser Ball: https://experiments.withgoogle.com/browser-ball ; Roll It: https://www.engadget.com/2013-05-28-google-roll-it.html
- Live Share `LiveState`: https://learn.microsoft.com/en-us/javascript/api/@microsoft/live-share/livestate ; capabilities: https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities
- hopeOS (read-only): `sdk/core/multiplayer.js`, `sdk/core/game-physics.js`, `mpbrowser.html`
