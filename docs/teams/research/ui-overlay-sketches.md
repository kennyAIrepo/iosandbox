# Overlay sketches - where every hopeOS layer draws inside the Teams twin

Companion to `layout-spec.md` (frame, gallery, tile, control bar, side panel) and `accessibility.md` (contrast, halo,
motion, live regions). This file is the *drawing* spec: for each hopeOS overlay, an ASCII sketch, the DOM/canvas it lives
in, the tokens it uses (`teams-tokens.css`), the z-slot (`--tw-z-*`), the pointer policy, and which sibling topic owns the
data it draws. Numbers marked **[twin]** are our decisions; everything else is derived from the cited sources.

Ground rules that apply to every sketch:

- **Never track the tile.** Overlays are fed by the *local tracker on the camera stream* (local tile) or by *relayed
  landmark packets* (remote tiles). Nothing samples pixels from a `<video>` of another participant.
- **Canvases are never pointers.** All overlay canvases are `position:absolute; inset:0; pointer-events:none;
  aria-hidden="true"`. Tile chrome (label, pills, ring, pin/more buttons) stays HTML above the canvases.
- **Mirror at the tile level only.** The local tile (media + its overlay canvases together) is `scaleX(-1)` outside
  the game; when the game starts the twin un-mirrors self video and landmarks (`research/game/space-mapping.md` section 7,
  "Mirror my video: off"). Chirality is measured by `hand-views.js _zSign`; overlays never flip a hand by label.
- **Motion gate.** Every decorative animation checks `--tw-motion` (0 under `prefers-reduced-motion`) once per frame.
- **Ring over video = colour + halo.** Any coloured ring or frame drawn over video carries `box-shadow: var(--tw-halo)`
  (`accessibility.md` R3).

Stacking recap (`layout-spec.md` section 7): `--tw-z-tile 0 < hands 5 < ball 6 < selfview 10 < controlbar 20 < panel 30 <
dialog 40 < toast 50`. Inside a tile the order is media -> hands canvas -> props canvas -> HTML chrome.

## 1. Tile stack (one participant)

```
.tile  (article, role=group, aspect 16:9, radius --tw-tile-radius 6px, overflow hidden)
|
+- .tile__media       <video> (remote) | <canvas> WebGL (local)                          z 0   object-fit: cover
+- .tile__hands       <canvas 2D>  holohands skeleton + body capsules                    z --tw-z-hands 5
+- .tile__props       <canvas WebGL> 3D props (ball, apple...) in THIS tile's scene       z --tw-z-ball 6
+- .tile__ring        <div> speaking / raised-hand / goal / catch / miss ring (border)    chrome
+- .tile__pills       raised-hand pill (top-left), reaction floaters (bottom-centre)     chrome
+- .tile__label       [mic] Name [pin] [more]  bottom-left, 8px inset                    chrome, focusable buttons
```

Sizing: the drawing surfaces share one `ResizeObserver` and are sized in *device pixels*
(`canvas.width = rect.width * devicePixelRatio`) while CSS keeps them at `inset:0`. The props canvas' three.js camera
is a per-tile perspective camera whose frustum at the hand plane spans exactly the tile, so the projected ball radius at
the tile edge equals the 2D transit ball radius (`space-mapping.md` sections 5 and 8 - "no pop").

Why two canvases and not one: the hands layer is cheap 2D (`lineWidth`, `arc`) and re-drawn every packet (30 Hz for
remote, camera rate for local); the props layer is WebGL and only re-renders when a prop exists in that tile. A tile with
no prop costs one 2D canvas. When the local user has a full HoloHandRig (3D hand mesh) the hands are drawn in the props
canvas instead and `.tile__hands` is hidden - one WebGL context per tile, at most 9 (`layout-spec.md` section 2 cap).

## 2. Holohands + body overlay (per tile)

```
 +-----------------------------------------------+
 |                       o head (pose 0)         |   bones : --tw-hand-bone  rgba(255,255,255,.85), 2px, round caps
 |              .-------+-------.                |   joints: --tw-hand-joint (colorBrandForeground1), r 3px
 |        o-----'  body capsules  '-----o wrists |   local hand tint  : --tw-hand-local  (brand)
 |       /                               \       |   remote hand tint : --tw-hand-remote (colorNeutralForeground2)
 |   .-<>-.   21-pt hand skeleton     .-<>-.     |   body capsules    : same bone colour at .45 alpha, 6px [twin]
 |   |\|/|   (MediaPipe topology)     |\|/|      |   stale hand (>150ms): alpha -> .5, no conform (latency-feel 5.8)
 |   '-+-'                            '-+-'      |   confidence < .5 : dashed bones [twin]
 | [mic] Ana                        [pin] [...]  |
 +-----------------------------------------------+
```

- Data: local = `views.resolve([L, R], camera)` packs (`research/codebase/dropins.md` section 5); remote =
  `PlayerFrame`-shaped relayed packets (`hands.left/right.img` in un-mirrored [0,1] tile units,
  `research/game/sync-protocol.md`). The overlay maps `img (u,v)` -> canvas px with `u * w, v * h`; nothing else -
  depth is not drawn.
- Multi-person in one tile (the "one camera, N people" topology, `dropins.md` section 3.11): each `PlayerFrame.id`
  (stable MoveNet id) gets a colour from the shared player palette `colorPalette<Name>BorderActive` (dark: Lilac,
  Seafoam, Peach, Gold ...) *for the body capsules only*; hands keep the local/remote tint. A small id chip `#2` sits at
  the head point (caption2-strong, `--tw-tile-label-bg` scrim) so a viewer can tell which skeleton is which when two
  people share a tile. Ids are decorative; names in the label are the identity (`accessibility.md` R4).
- Draw order inside the canvas: body capsules first (behind), then hands, then joints on top.
- The tracker runs on the *camera stream*, never on this canvas; the local hands canvas is a pure renderer.

## 3. Props (3D, per tile) and the ball

```
 tile props canvas (WebGL, z 6, transparent clear)
 +-----------------------------------------------+
 |                                               |   ball: MeshStandard, per-seat colour, 1px dark outline
 |            (o) ball                           |         (Fresnel rim in rgba(0,0,0,.6)) so it reads on white video
 |           /   \  contact shadow (soft disc,   |   shadow: radial rgba(0,0,0,.35) disc on the hand plane / tile floor
 |          ~~~~~~~ alpha .35)                   |   apple / spawned object: same rules, from CommandAgent spawn_object
 |     .-<>-.                                    |
 |     | (o)|  <- ball in CRADLE: sits on the    |   NEVER: parented under the hand, gravity off, pinch-snapped
 |     '-+-'     palm pocket, hand supports it   |   (PROP COLLISION DOCTRINE; enforced in the executor / prop-ball.js)
 | ============================================= |   tile floor: bottom edge of the tile in court units (mechanics 4)
 +-----------------------------------------------+
```

- The ball (and any spawned object) is a doctrine prop: hull vs joint spheres, wrap / clip / cradle pickup, open hand =
  release, gravity always on (`research/game/mechanics-options.md` section 3, `research/command-agent/NOTES.md`
  section 6). The overlay has no say in physics; it only renders the state the physics leaves.
- Remote tiles render a held ball from *received hand landmarks + palm-local offset*, not a world position, so it sits on
  the remote skin (`mechanics-options.md` section 3). Fallback to world position only when the hand stream is > 150 ms
  old.
- Outline + contact shadow are the ball's non-colour channels: a brand-blue ball on blue video is still a disc with a
  dark rim and a shadow.

## 4. Transit overlay (one canvas over the whole stage)

```
 .stage (position:relative)     .stage__transit <canvas 2D> inset:0, z --tw-z-ball 6, pointer-events:none
 +--------------+-gutter-+--------------+--------+--------------+
 |  A           |::::::::|  B           |::::::::|  C           |   gutter = 8px CSS (--tw-gallery-gap) = 0.08 court
 |              |:  o-> :|              |::::::::|              |   lane  : faint fill colorNeutralBackground5 @ .5 [twin]
 |       o------+-o-o-o--+--O arrival   |::::::::|              |   trail : --tw-ball-trail 3px, fades --tw-ball-trail-fade-ms
 |              |::::::::|  ring        |::::::::|              |   ring  : thrower's seat colour, r 3R->R over last 400ms
 |              |::::::::|              |::::::::|              |   ghost : 35% alpha ball on predicted path (receiver only)
 +--------------+--------+--------------+--------+--------------+
 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ bottom gutter strip: lost-ball lane (mechanics 4.2)
```

- Court -> viewer px: `pxPerUnit = tileRect.height`; the stage canvas gets every tile's `getBoundingClientRect()`
  relative to the stage once per layout change (`space-mapping.md` section 8). Because rule (B) gives equal 16:9 tiles,
  `pxPerUnit` is one number per viewer.
- Draws only while a ball is *between* tiles (LAUNCH `tEdge` -> CLAIM), plus the arrival ring and ghost from
  `research/game/latency-feel.md` section 5.1-5.2, plus the slow-mo stretch (5.3) which is a time-scale, not a visual.
- The ball itself: same radius in px as the 3D ball at the edge; 1px dark outline; trail is decorative and skipped when
  `--tw-motion: 0`. Audio pan (latency-feel 5.4) is triggered from the same LAUNCH handler; the canvas does not own it.
- On a Teams meeting-stage app (container D) there are no real video tiles; the stage *is* our canvas, so section 1's
  tiles are drawn by us (avatar/photo + landmarks) and the transit canvas and tile canvases collapse into one WebGL
  surface with a 2D HUD on top. Same court, same tokens.

## 5. Tile state rings and chips (HTML chrome)

```
 speaking            raised hand            goal tile               catch / miss (200 ms)
 #============#      #============#         #============#          +------------+
 #            #      # [hand      #         # [trophy    #          |            |
 #            #      #   raised]  #         #   Goal]    #          |            |
 # [mic~] Ana #      # [mic] Ben  #         # [mic] Cy   #          | [mic] Dee  |
 #============#      #============#         #============#          +------------+
 4px colorBrandStroke1   4px marigold #eaa300     3px --tw-goal-frame       3px --tw-catch-ring (success)
 + --tw-halo             pill: black icon on gold  marigold + halo,         or --tw-miss-ring (danger)
 + animated mic icon     (white icon FAILS 2.16)   chip --tw-goal-chip-*    + halo, + scale 1.02 bounce
                                                   with the word "Goal"     (bounce off under --tw-motion 0)
```

- Rings are `border` on `.tile__ring` (an absolutely positioned div with the tile's radius), never drawn into a canvas,
  so they survive canvas resizes and are trivially high-contrast under `forced-colors`.
- Precedence when several apply **[twin]**: goal frame (persistent) > catch/miss flash (200 ms, overrides colour) >
  raised hand > speaking. The chip / pill / mic icon of each state still shows so no state is lost (R4).
- Pill: `handRight16Filled` on `#eaa300`, radius 16px (1rem, ACS `raiseHandPill`), margin 8px, black icon (9.74:1).
- Goal chip: `trophy16Regular` + "Goal", `--tw-goal-chip-bg/fg` (marigold bg2 / fg2), top-left, replaces the pill slot.

## 6. Scoreboard (top bar centre)

```
 TOP BAR 48px
 [ Teams football - Pilot ]      +------------------------------+        [12:04] [layout] [people] [chat]
                                 |  * Ana  3   -   2  Ben *     |   --tw-scoreboard-font  (fontFamilyNumeric, semibold,
                                 +------------------------------+    14/20), .tw-numeric tabular-nums
                                  pill: --tw-scoreboard-bg (bg2), radius circular, 6px 12px pad, seat-colour dots 8px
```

- The scoreboard is DOM text; every change is also pushed to the polite live region ("Goal for Ben, 3-2") throttled to
  one message per 2 s (`accessibility.md` R6). It never animates beyond a 200 ms colour tick on the changed number.
- Inside the 994x678 / 918x540 stage app there is no Teams top bar of ours; the scoreboard becomes a floating pill at the
  top-centre of the stage, 8px inset, z `--tw-z-controlbar` **[twin]**.

## 7. Command bar (voice/text -> Claude -> object)

```
 SIDE PANEL - Game tab (280px content)                       Ctrl+/  popover over the stage (z --tw-z-dialog)
 +------------------------------+                             +----------------------------------------+
 | Seat map  [A][B][C]          |                             | Ask hopeOS                             |
 | Score     Ana 3 - 2 Ben      |                             | +----------------------------+ [mic    |
 | [ Play together ]  (share)   |                             | | give me an apple in my hand|  hold]  |
 +------------------------------+                             | +----------------------------+         |
 | Ask hopeOS                   |                             | * listening...   o thinking (1.9 s)    |
 | +--------------------+[mic]  |                             | +------------------------------------+ |
 | | type a command...  |       |                             | | OK Placed an apple in your right   | |
 | +--------------------+       |                             | |    hand                            | |
 | last: OK Placed an apple in  |                             | |    spawn_object - 2 tool calls -   | |
 |       your right hand        |                             | |    1.4 cents                       | |
 +------------------------------+                             | +------------------------------------+ |
                                                              | Esc closes - Space = push-to-talk      |
                                                              +----------------------------------------+
```

- Widgets: Fluent v9 Input (32px, radius medium, `colorNeutralStroke1` border, brand bottom stroke on focus), a 32px
  push-to-talk button (`mic20Regular`, `aria-pressed` while held, pointer capture;
  `research/command-agent/push-to-talk.js`), a status row (listening / thinking / done, with elapsed ms from the agent's
  `ms` events), and a result card (`colorNeutralBackground2`, radius large, `caption1` meta line). The card text is the
  same string that is announced (`accessibility.md` R6).
- State colours: listening = `colorStatusDangerForeground1` dot (recording convention), thinking = brand dot with a
  `--tw-motion`-gated pulse, ok = `colorStatusSuccessForeground1`, error/refusal = `colorStatusDangerForeground1` with
  the reason ("Claude declined", "no key - used local grammar"). Local-grammar fallback is *labelled*, never silent.
- The spawned object appears in the speaker's tile props canvas (section 3) seated at the palm pocket; `pass_object` /
  `designate_goal` results are relayed by the game wire, and the command bar does not draw across tiles itself.
- Wake word / always-on mode shows a persistent small mic chip in the tile label with `aria-label="listening for
  'hey hope'"` so a participant knows the mic is being transcribed **[twin]**.

## 8. Captions strip and toasts

```
 STAGE bottom, above the control bar (z --tw-z-controlbar)
                 +-----------------------------------------------------+
                 | Ana: nice catch - throw it to Cy                    |  --tw-captions-font 16/22, white on rgba(0,0,0,.7)
                 +-----------------------------------------------------+  max-width --tw-captions-max-w 720px, radius medium
 Toasts (z --tw-z-toast 50), top-right, 8px inset, --shadow16, colorNeutralBackground1, 4 s, dismissible:
 +--------------------------------+
 | ! Relay disconnected - retrying|   error toasts also go to the assertive live region
 +--------------------------------+
```

Captions in the twin are mock (accessibility.md R12); the strip exists so layout collisions with the control bar and
self-view are found now, not in Teams.

## 9. Self-view and narrow layouts

```
 normal (stage >= 480x380)                    narrow (<= 480 wide, e.g. 472x382 side-panel-min)
 +--------------------------+                 +----------+
 |  grid ...                |                 | tile     |
 |                          |                 | tile     |  one column, 16:9 tiles
 |           +--------+     |                 | tile     |
 |           | You  :: | 16 |                 |      +--+|  self-view 58x104 portrait
 |           +--------+     |                 |      |  ||  (ACS SMALL_FLOATING_MODAL 3.625x6.5rem)
 +--------------------------+                 +------+--++
 220x124, draggable (:: handle, arrow keys when focused), z --tw-z-selfview 10, .tw-focus-on-video
```

The self-view hides when the local user is in the seat map (their tile is in the grid); the transit canvas ignores the
self-view rectangle entirely - the self-view is never a court tile.

## 10. Layer ownership (who feeds what)

| overlay | fed by | topic that owns the data |
|---|---|---|
| hands / body (2) | local `views.resolve` packs; remote `PlayerFrame` packets @30 Hz | `codebase/dropins.md` 3.11, 5; `game/sync-protocol.md` |
| props (3) | prop-ball / PropHull state per tile; CommandAgent `spawn_object` | `game/mechanics-options.md`; `command-agent/` |
| transit (4) | LAUNCH / CLAIM packets + shared clock | `game/space-mapping.md` 8, `game/latency-feel.md` 5 |
| rings / chips (5) | speaking (audio level or relay flag), raise-hand, goal, catch/miss events | twin state; `game/mechanics-options.md` 1a |
| scoreboard (6) | game score events | `game/` |
| command bar (7) | `command-agent.js` events (`ms`, `usage`, `result`, `raw`) | `command-agent/` |
| captions / toasts (8) | mock captions; relay + camera errors | twin |

## Sources

- `layout-spec.md`, `accessibility.md`, `teams-tokens.css` (this folder) - tokens, sizes, contrast, motion gate.
- `research/game/space-mapping.md` sections 2, 5, 7, 8 (court units, no-pop radius, un-mirrored canonical, transit
  canvas); `research/game/latency-feel.md` section 5 (ghost, arrival ring, stretch, audio pan, hand-age fade);
  `research/game/mechanics-options.md` sections 2-4 (throw/catch states, floor, gutter strip).
- `research/codebase/dropins.md` section 3.11 (PlayerFrame, stable ids), section 5 (per-tile pipeline order).
- `research/command-agent/NOTES.md` sections 5-6, `SUMMARY.md` (push-to-talk, executor doctrine, events).
- ACS UI Library (MIT) `src/acs/components/VideoTile.tsx`, `styles/VideoTile.styles.ts` (raise-hand pill, ring widths),
  `fl.styles.ts` (self-view sizes); Fluent UI System Icons names (MIT).
- learn.microsoft.com designing-apps-in-meetings (stage sizes, dark-theme rule); the earlier memo
  `scratchpad/teams-pilot-plan.html` (never track the tile; C1/C2/C3/D return paths).
