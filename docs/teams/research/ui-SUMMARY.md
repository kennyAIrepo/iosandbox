# ui - research summary (2026-09-18, finisher pass)

Topic: the visual/UX substrate of the local "Teams twin" sandbox page - Fluent 2 tokens, meeting-window layout
(gallery, control bar, side panel), accessibility, and the drawing spec for every hopeOS overlay that drops in.

## What the topic concluded

The twin can look and behave like a Teams meeting using only public material: `@fluentui/tokens` 1.0.0-alpha.24
(MIT) gives every colour / type / spacing / radius / shadow / motion value for `teamsLightTheme` and `teamsDarkTheme`
(459 tokens per theme, emitted as `--<fluentTokenName>` CSS variables so they line up 1:1 with React v9 `tokens.*`);
Microsoft's published meeting-app design page gives the hard rectangles (stage 994x678 / 918x540, minima 792x382 /
472x382, side panel 280 px + 20 px padding, dialog 280..460 x 300); the MIT Azure Communication Services UI Library
is the reference implementation for control-bar, tile, self-view, grid and side-pane dimensions; the Teams support
pages give the gallery semantics (49 cap, large gallery at 10 cameras, pin/spotlight). Nothing proprietary from the
Teams client was fetched or reproduced; where Microsoft publishes no number the spec says so and marks our choice
**[twin]**.

Three design decisions fall out: meetings are always dark (`.tw-meeting` forces the dark theme regardless of page
theme); the gallery is ours (fixed 16:9 equal tiles, host-authored seat order, max 9 in grid - which is what makes
the cross-tile ball the same size on both sides of a gutter); and every overlay is a `pointer-events:none`,
`aria-hidden` canvas layered under HTML chrome, fed by the local tracker or relayed landmarks, never by sampling a
tile. Contrast was computed from the token package itself: 50 pass / 10 fail, every fail either WCAG-exempt
(disabled text) or mitigated by a specific rule (dark halo under any ring over video, black icon on the gold
raise-hand pill, marigold fg2 for goal text on light).

## Decisions that constrain design

- Theme wiring: `:root` = teamsLightTheme; `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and
  `:root[data-theme="dark"]` = teamsDarkTheme; `.tw-meeting` = ALWAYS dark; `[data-brand="teams-v21"]` opt-in newer
  brand ramp. Inside the meeting frame the canvas is `colorNeutralBackground3 #1f1f1f`, not bg1.
- Reference rectangles for every test/screenshot: 994x678, 918x540, 792x382, 472x382, plus 1280x720 and 1920x1080.
  The frame is `container-type: size`; layout uses container queries, never the viewport.
- Gallery rule (B) "fixed 16:9, widest tile that fits, centre incomplete rows" ships; ACS `calculateGridProps` (A)
  is kept only as a parity switch. 9-tile cap in the grid; overflow strip beyond. Gap and pad 8 px.
- Tile: `<article role="group">`, media -> hands canvas (z 5) -> props canvas (z 6) -> HTML chrome; local tile mirrored
  as a unit outside the game and un-mirrored when the game starts (court is canonical un-mirrored); chirality from
  `hand-views.js _zSign` only.
- Control bar 56 px docked bottom, buttons 56 min-width, icon 20, label 10/16; Leave is the only filled red
  (`colorStatusDangerBackground3`, white 6.07:1). Side panel 320 = 280 content + 2x20.
- Stacking: tile 0 < hands 5 < ball 6 < selfview 10 < controlbar 20 < panel 30 < dialog 40 < toast 50. Hands are
  never a pointer; the only stage-interactive elements are tile chrome buttons and the self-view drag handle.
- Accessibility rules that bind the overlays: any ring/frame over video gets `--tw-halo`; tile label scrim
  `rgba(0,0,0,.6)`, captions `.7` (never lower); `--tw-motion: 0` under reduced motion kills trails / particles /
  bounce / reaction floats; one polite + one assertive live region, throttled 2 s; keyboard throw/catch path
  (`ArrowLeft/Right`, `Space`) runs through the same doctrine cradle-then-release; nothing interactive < 24 px.
- Prop doctrine is upstream of the overlays: the props canvas renders whatever the physics leaves (wrap/clip/cradle,
  gravity on); remote held balls are placed from received hand landmarks + palm-local offset, never a world position.
- `teams-tokens.css` is GENERATED (`scripts/gen-tokens.mjs` reads the npm package); edit the generator, not the CSS.

## Canonical files (all under `research/ui/`)

- `teams-tokens.css` - 84 KB generated token sheet: brand ramp, all alias/status/palette colours, type ramp, spacing,
  radii, strokes, durations/curves, shadows, for light / dark / `.tw-meeting` / v21 brand; `--tw-*` twin extension
  tokens (stage sizes, gallery, tile, control bar, roster, captions, focus, game overlays, z-slots, breakpoints);
  utility classes (`.tw-focusable`, `.tw-focus-on-video`, `.tw-visually-hidden`, type ramp classes, reduced-motion
  block). KEPT the canonical version (newer, 101 `--tw-*` names vs the draft's 77, richer header and utilities).
- `layout-spec.md` - window anatomy, meeting-stage rectangles, gallery rules (A)/(B) with computed tile sizes,
  tile anatomy and layers, control-bar button table, side panel tabs, overlay table, stacking policy, sources. KEPT
  canonical (draft had none).
- `accessibility.md` - WCAG 2.2 AA rules R1-R12 with computed contrast ratios, halo rule, keyboard path, live
  regions, focus recipe, motion gate, target sizes, zoom floors, honest limits. KEPT canonical (draft had none).
- `overlay-sketches.md` - WRITTEN this pass: ASCII drawings + DOM/canvas/token/z/pointer spec for the tile stack,
  holohands + body (incl. multi-person stable-id colouring), props/ball, transit canvas, state rings and chips,
  scoreboard, command bar (side panel + Ctrl+/ popover), captions/toasts, self-view/narrow, and a layer-ownership
  table mapping each overlay to the sibling topic that feeds it.
- `SUMMARY.md` - this file.
- Supporting (not deliverables): `scripts/gen-tokens.mjs` (generator), `scripts/contrast.mjs` +
  `scripts/contrast-results.txt` (WCAG ratios), `scripts/gallery-grid.mjs` + `scripts/gallery-grid-results.txt`
  (tile sizes for both grid rules at the six rectangles), `build/` (npm-installed `@fluentui/tokens`), `src/`
  (fetched primary sources: tokens package .ts, ACS components/styles/composite, Fluent focus recipe, Fluent System
  Icons name lists).
- Draft folder (`research_draft1/ui/`): superseded. Its `teams-tokens.css` / `gen-tokens.mjs` are an older cut of
  the same generator (different `--tw-*` naming, e.g. `--tw-z-overlay-hands`, `--tw-tile-label-scrim`); its
  `src/acs-grid-port.ts`, `maxfit-grid.mjs`, `VideoGallery_OverflowGallery.tsx`, `cc_styles_CallPage.styles.ts` and
  `acs/README.md` are the only things not present in canonical and are not needed by the deliverables.

## Verification (run 2026-09-18 from `research/ui/`)

- `node scripts/gen-tokens.mjs` -> exit 0, "wrote teams-tokens.css: 84373 bytes, 459 tokens per theme, package
  1.0.0-alpha.24"; output byte-identical to the checked-in file (generator is deterministic; its brand-ramp
  cross-checks against the compiled themes passed).
- `node scripts/contrast.mjs` -> exit 0, 50 PASS / 10 FAIL, matching `scripts/contrast-results.txt` and the tables in
  `accessibility.md`.
- `node scripts/gallery-grid.mjs` -> exit 0, output matches `scripts/gallery-grid-results.txt`.
- No browser render of the CSS was done (no twin page exists yet); the CSS was checked only by generation and by
  confirming every token name referenced in the three .md files exists in the sheet.

## Still missing / risks

- No `teams-twin.html` yet: the specs are implementable but unrendered; first render should snapshot the six
  reference rectangles and compare tile sizes to `gallery-grid-results.txt`.
- ACS `utils/responsive.ts` thresholds (narrow <= 480, short <= 380) were recalled, not fetched; the Teams keyboard
  shortcut list was recalled, not re-fetched.
- Gallery rule (B) is a reconstruction; Microsoft does not publish the Teams packing algorithm. Parity with the
  real client is approximate by design and only matters for look, not for the game (which uses our seat map).
- Top-bar height (48) and several `--tw-*` numbers are twin decisions with no published Teams value.
- `@fluentui/tokens` is an alpha package (1.0.0-alpha.24); a bump could rename values - regenerate rather than patch.
- One WebGL context per tile (up to 9) plus a 2D transit canvas is the budget assumed by the sketches; it has not
  been measured on a low-end laptop.

## Sources

- https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/design/designing-apps-in-meetings
- https://support.microsoft.com/en-us/teams/meetings/customize-your-meeting-view-in-microsoft-teams
- https://github.com/microsoft/fluentui packages/tokens (MIT; installed in `build/`, sources in `src/`), react-tabster
  `createFocusOutlineStyle.ts` (`src/tabster/`).
- https://github.com/microsoft/fluentui-system-icons (MIT; name lists in `src/icons/`).
- https://github.com/Azure/communication-ui-library (MIT; `src/acs/`).
- https://fluent2.microsoft.design (typography / layout / elevation pages).
- WCAG 2.2 https://www.w3.org/TR/WCAG22/.
- Sibling topics consumed: `research/game/space-mapping.md`, `latency-feel.md`, `mechanics-options.md`,
  `research/codebase/dropins.md`, `research/command-agent/NOTES.md` + `SUMMARY.md`, `research/meeting-app/NOTES.md`.
