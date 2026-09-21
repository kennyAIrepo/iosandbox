# Teams-twin layout spec (meeting window, gallery, control bar, side panel)

Scope: the local "Teams twin" sandbox page (`teams-twin.html`, vanilla ES modules, no React). It must *look* like a Teams
meeting so hopeOS layers can be developed against a realistic surface, and it must *behave* like the surfaces we will
actually ship into (meeting stage app + side panel). Every number below is either (a) published by Microsoft on
learn.microsoft.com / support.microsoft.com, (b) read from an MIT reference implementation (Azure Communication Services
UI Library, "ACS", copied under `src/acs/`), or (c) our own decision, marked **[twin]**. We do not have, and did not
inspect, the Teams client's private CSS; where a real Teams number is unknown the spec says so.

Tokens referenced as `--name` come from `teams-tokens.css` (Fluent 2 / `@fluentui/tokens` 1.0.0-alpha.24, Teams brand
theme; `--tw-*` are twin extensions defined at the end of the `:root` block).

## 0. Decisions that constrain everything

1. **Meetings are dark.** "Teams meetings are optimized for dark theme to help reduce visual and cognitive noise"
   (designing-apps-in-meetings#theming). The meeting frame is wrapped in `.tw-meeting`, which forces `teamsDarkTheme`
   colours regardless of the page theme; the lobby/settings surfaces outside the frame follow the page theme
   (`:root` light, `prefers-color-scheme: dark` / `[data-theme="dark"]` dark).
2. **The gallery is ours.** Teams' gallery order is per viewer, cannot be rearranged by an organizer, and Together mode
   (the only fixed-seat layout) was retired June 2026 (`research/game/space-mapping.md` section 1). The twin renders its
   own gallery from the host-authored seat map; tile order = seat order, identical on every client.
3. **Never track the tile.** Tiles show local video for the local user and *relayed landmarks rendered locally* for
   everyone else (holohands / avatar over the remote participant's real video in the twin; over a profile photo or avatar
   inside a Teams stage app, where remote video is not exposed to apps). The gallery therefore has two tile kinds:
   `tile--local` (camera + tracker) and `tile--remote` (video element or avatar + landmark renderer).
4. **Three real surfaces, one layout engine.** The same components lay out at (a) full window (twin), (b) the Teams
   meeting stage (994x678 / 918x540, min 792x382 / 472x382), (c) the 280 px side panel. Layout is driven by container
   queries on the frame, never by the viewport.

## 1. Window anatomy (twin, full window)

```
+--------------------------------------------------------------------------------------+
| TOP BAR  48px   [meeting title]                    [timer] [layout] [people] [chat]  |  --tw-topbar-h, --tw-topbar-bg
+-----------------------------------------------------------------+--------------------+
|                                                                 |  SIDE PANEL 320px  |  --tw-sidepanel-w
|   STAGE / GALLERY (flex:1)                                      |  20px pad each side|  --tw-sidepanel-pad-x
|   padding 8px, gap 8px                                          |  280px content     |  --tw-sidepanel-iframe-w
|   --tw-stage-bg                                                 |  --tw-panel-bg     |
|                                                                 |  --tw-panel-border |
|                                    [self-view 220x124 @16px]    |                    |  --tw-selfview-*
+-----------------------------------------------------------------+--------------------+
| CONTROL BAR 56px  (centred group)  [cam][mic][share][react][more]     [Leave]         |  --tw-controlbar-h
+--------------------------------------------------------------------------------------+
```

- Top bar 48 px, buttons 32 px visual / 40 px hit **[twin]**; Microsoft publishes no number for the client header.
- Stage: `flex: 1 1 auto; min-width: 0; position: relative; padding: var(--tw-gallery-pad)`; background
  `--tw-stage-bg` (= `colorNeutralBackground4`, `#141414` dark).
- Side panel: 320 px = "280 pixel-wide iframe area" + "20 pixels of padding on the left and right"
  (designing-apps-in-meetings#spacing). Single column, vertical scroll only, never horizontal. Error alerts sit
  directly below the header and push content down 20 px (`--tw-sidepanel-notification-h`). ACS's side pane is 21.5 rem
  (344 px) with a 1.125 rem/600 header (`cc/common_Pane.styles.ts`); we use the Teams number, 320.
- Control bar 56 px = ACS `controlButtonStyles.minHeight 3.5rem` (`components/styles/ControlBar.styles.ts`).
  Docked bottom (ACS `controlBarStyles.dockedBottom`). Buttons: min-width 56 px, max-width 128 px (8 rem), icon 20 px,
  label 10 px/16 px regular under the icon (ACS `controlButtonLabelStyles` 0.625 rem / 1 rem line). Leave is a
  danger-filled button: `--tw-leave-bg` = `colorStatusDangerBackground3` `#c50f1f`, white text (6.07:1).
- Stage aspect handling: the frame element (`.tw-frame`) is `container-type: size`. Everything inside uses `cqw`/`cqh`
  or container queries, so the same DOM renders at window size, at 994x678, and at 918x540 for screenshots/tests.

### Meeting-stage sizes (Microsoft, designing-apps-in-meetings#responsive-behavior-shared-meeting-stage)

| state | default | minimum | token |
|---|---|---|---|
| side panel closed | 994 x 678 | 792 x 382 | `--tw-stage-default-*`, `--tw-stage-min-*` |
| side panel open | 918 x 540 | 472 x 382 | `--tw-stage-sidepanel-*`, `--tw-stage-sidepanel-min-w` |
| in-meeting dialog | width 280..460 (iframe 248..428), iframe height 300 | | `--tw-dialog-*` |

Test fixtures should snapshot the twin at exactly these four rectangles plus 1280x720 and 1920x1080
(`scripts/gallery-grid-results.txt` tabulates the tile sizes for each).

## 2. Gallery grid

Two rules exist; the twin ships (B) and keeps (A) as a switch for parity tests.

**(A) ACS `calculateGridProps`** (ported verbatim in `scripts/gallery-grid.mjs::acsGrid`): cells flex to fill the
container, target aspect 16:9, minimum 8:9, `rows = floor(sqrt(16/9 / ar * n))`, then adjust so an incomplete last row
is centred ("fill horizontal") or last column ("fill vertical"). Gap 0.5 rem (`styles/GridLayout.styles.ts`). Cells are
*not* 16:9 - at 994x678 with 5-6 tiles they are 326x335 (0.97).

**(B) Twin rule "fixed 16:9, maximise tile width, centre incomplete rows"** (`fixed169` in the same script) **[twin]**.
Microsoft describes the new Teams gallery as "tiles of equal size (16:9 ratio)"; the packing algorithm itself is not
published, so (B) is our reconstruction. For n in 1..9 it chooses the rows x cols that gives the widest 16:9 tile that
fits, letterboxing the remainder with `--tw-stage-bg`. Results at the four reference rectangles are in
`scripts/gallery-grid-results.txt`; e.g. 994x678: 1 -> 994x559, 2 -> 595x335, 3-4 -> 2x2 493x277, 5-6 -> 3x2 392x220,
7-9 -> 3x3 326x183.

Why (B) matters for the game: `research/game/space-mapping.md` maps every tile's camera space into one court whose
unit is the tile height. Equal-size 16:9 tiles make `pxPerUnit` identical for every tile on a viewer, so the ball
crossing a gutter is the same size on both sides with no per-tile rescale.

Implementation: CSS grid on the stage, `grid-template-columns: repeat(cols, var(--tile-w))`,
`grid-auto-rows: var(--tile-h)`, `justify-content: center; align-content: center; gap: var(--tw-gallery-gap)`;
`--tile-w/--tile-h` set by a `ResizeObserver` on the stage using `fixed169()`. Incomplete last row is centred by
placing its tiles with explicit `grid-column` offsets (2 tiles in a 3-col row -> columns 1.5..3.5 is impossible, so use
`grid-template-columns: repeat(cols*2, calc(var(--tile-w)/2 - gap/2))` and span 2 - the standard half-column trick).

Caps: 9 tiles in the main grid (`MAX_GRID_PARTICIPANTS_NOT_LARGE_GALLERY = 9`, ACS `videoGalleryLayoutUtils.ts`);
beyond 9 the twin switches to an overflow strip (ACS "horizontalBottom" overflow gallery) and Teams' own rule is
"Large gallery ... when at least ten people have their cameras turned on", 49 max per page. The game's seat map is
capped at 9 for the pilot.

Narrow / short containers (ACS `isNarrowWidth` <= 480 px, `isShortHeight` <= 380 px; thresholds recalled from
`utils/responsive.ts`, which was not fetched): the self-view shrinks to the portrait 58x104 modal
(`SMALL_FLOATING_MODAL_SIZE_REM 3.625 x 6.5`) and the grid drops to one column. Below 792x382 (the Teams minimum) we
do not guarantee anything - the side-panel min is 472 wide, which is the "narrow" case.

## 3. Video tile

```
+---------------------------------------------+   .tile  aspect-ratio: 16/9; border-radius: var(--tw-tile-radius) 6px [twin;
|                                             |         ACS uses theme.effects.roundedCorner4 = 4px]; overflow: hidden;
|      <video> / <canvas> object-fit: cover   |         background: var(--tw-tile-bg) (camera-off surface)
|      mirrored ONLY for the local tile       |
|                                             |   speaking ring: 4px solid colorBrandStroke1 + --tw-halo  (ACS 0.25rem themePrimary)
|  [raised-hand pill]                         |   raised hand: 4px solid #eaa300 ring (ACS raiseHandGold), pill radius 1rem, margin .5rem
| [mic-off] Display name         [pin] [more] |   label: 12px/16px 600, padding 4px 8px, rgba(0,0,0,.6) scrim, white text, radius 4px
+---------------------------------------------+          bottom-left, 8px inset (ACS displayNameStyle .75rem/600, tileInfoContainer .5rem)
```

- Tile = `<article class="tile" role="group" aria-label="Display name, camera on, speaking">` (see accessibility.md R3).
- Layers inside a tile, bottom to top (`--tw-z-*`): media (`<video>` or the local WebGL canvas) -> hand/body overlay
  canvas (`--tw-z-hands`) -> game props canvas (`--tw-z-ball`) -> HTML chrome (label, pills, ring). The overlay
  canvases are `position:absolute; inset:0; pointer-events:none`. The tile's HTML chrome is never drawn into the canvas.
- Local tile: the tracker runs on the *camera stream*, never on the rendered tile. The local tile is mirrored
  (`transform: scaleX(-1)` on media + overlay canvases together) so hands match the user's proprioception; the court is
  un-mirrored (space-mapping.md section 7), so the mirror is applied at the tile level only.
- Camera-off tile: `--tw-tile-bg` with a 72 px initials avatar (ACS uses Fluent Persona sizes 32/40/72; we use 72 in
  the grid, 32 in the overflow strip) and name label as above. Landmarks still render for a remote participant with
  camera off (avatar + holohands) - that is the whole point of relaying landmarks.
- Pinned / spotlight: icons `pin16Regular` / `videoPersonStar16Regular` (Fluent UI System Icons, MIT) beside the name.
  Pinned tile is rendered at 2x2 span in rule (B) **[twin]**; spotlight = single large tile + overflow strip.
- Self-view (floating local video, ACS `FloatingLocalVideoLayout`): 220x124 (`LARGE_FLOATING_MODAL_SIZE_REM`
  13.75 x 7.5), 16 px from the bottom-right (`floatinglocalVideoModalInitialPositionGapRem = 1`), draggable, z
  `--tw-z-selfview`. When the local user is in the seat map the self-view is hidden and the local tile lives in the
  grid (ACS `localVideoTileSize: '16:9'` with `localTileNotInGrid=false`).

## 4. Control bar buttons and state

| button | icon (Fluent System Icons) | states | notes |
|---|---|---|---|
| Camera | `video20Regular` / `videoOff20Regular` | on / off / disabled | toggles tracker too **[twin]** |
| Mic | `mic20Regular` / `micOff20Regular` | on / off | mute is per-viewer honest: greys the mic pill on the tile |
| Share | `shareScreenStart20Regular` | idle / sharing | Teams share-button text rule: "Share" or scenario text such as "Play together", never "Present" |
| React | `emojiSparkle20Regular` | popover of 5 | reaction floats up the tile for `--tw-reaction-duration` 3 s |
| Raise hand | `handRight20Regular` | up / down | ring + pill on own tile |
| More | `moreHorizontal20Regular` | menu | hosts "Game", "Seat map", "Command bar" (Claude) entries **[twin]** |
| Leave | `callEnd20Regular` | - | danger fill, always rightmost, `min-width: 96px` **[twin]** |

Button anatomy (Fluent v9 Button medium): 32 px tall, radius `--borderRadiusMedium` 4 px, icon 20 px, subtle
appearance on `--tw-window-bg`; ACS stacks a 10 px label under the icon inside a 56 px cell. Pressed/toggled ("on")
state uses `colorNeutralBackground1Selected` + `colorNeutralForeground2Selected`; camera-off / mic-off use
`colorStatusDangerForeground1` on the icon only, not a filled button - the only filled red is Leave.

## 5. Side panel

Tabs: **People** (roster), **Chat**, **Game** **[twin]**. Header 18/24 600 (ACS `sidePaneHeaderStyles`), close button
32 px top-right. Roster row 40 px = 8 px padding + 24 px avatar (ACS `ParticipantItem`), name 14/20, trailing icons
16 px (mic-off, raised hand, pin). The Game tab is the same content that ships as the in-meeting side panel app in
`research/meeting-app/side-panel.html` (280 px content column): seat map preview, score, "Play together" share button,
and the Claude command bar (text field + push-to-talk).

## 6. Overlays owned by hopeOS (summary; drawings in overlay-sketches.md)

| overlay | where | z | draws |
|---|---|---|---|
| hands/body | per tile canvas | `--tw-z-hands` 5 | holohands skeleton (`--tw-hand-bone` 2 px white .85, joints 3 px brand), body capsules |
| props | per tile canvas (3D) | `--tw-z-ball` 6 | the ball / apple etc. under the prop doctrine |
| transit | one canvas over the whole stage | `--tw-z-ball` 6 | 2D ball while it crosses a gutter, trail `--tw-ball-trail` 3 px fading 600 ms |
| goal frame | tile border | tile chrome | `--tw-goal-frame` 3 px marigold + halo, trophy chip |
| scoreboard | top bar centre | top bar | `--tw-scoreboard-*`, numeric font, tabular figures |
| catch / miss | tile ring flash | tile chrome | `--tw-catch-ring` success / `--tw-miss-ring` danger, 200 ms |
| command bar | side panel Game tab + `Ctrl+/` popover | `--tw-z-dialog` | text field, push-to-talk, last result card |
| captions | bottom of stage above control bar | `--tw-z-controlbar` | 16/22 white on rgba(0,0,0,.7), max 720 px |

## 7. Stacking and pointer policy

`--tw-z-tile 0 < hands 5 < ball 6 < selfview 10 < controlbar 20 < panel 30 < dialog 40 < toast 50`. All hopeOS
canvases are `pointer-events: none`; hands are never a pointer. The only interactive things on the stage are tile
chrome buttons (pin / more) and the self-view drag handle.

## 8. Sources

- learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/design/designing-apps-in-meetings
  (stage sizes, side panel 280 + 20 px, dialog sizes, dark-theme rule, share-button text) - also summarised in
  `research/meeting-app/NOTES.md` section 8.
- support.microsoft.com/en-us/teams/meetings/customize-your-meeting-view-in-microsoft-teams (gallery 49 cap, large
  gallery at 10 cameras, pin/spotlight semantics).
- ACS UI Library (MIT) files under `src/acs/`: `components/GridLayout.tsx`, `components/styles/*.ts`,
  `components/VideoGallery/*.tsx`, `components/VideoGallery/utils/videoGalleryLayoutUtils.ts`, `fl.styles.ts`
  (floating local video sizes), `cc/common_Pane.styles.ts`, `cc/CallComposite_styles_CallComposite.styles.ts`
  (composite min 17.5 x 13 rem, 400 % zoom note).
- `@fluentui/tokens` 1.0.0-alpha.24 under `src/fluentui/` and `build/node_modules/` (all colour / type / spacing numbers).
- `scripts/gallery-grid.mjs` + `scripts/gallery-grid-results.txt` (computed tile sizes).
