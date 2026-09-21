# Accessibility for the Teams twin and the hopeOS overlays

Target: WCAG 2.2 AA for everything that is a UI control or text, plus honest statements about what a hand-tracked game
cannot make equivalent. Contrast numbers below are computed by `scripts/contrast.mjs` directly from the published
`@fluentui/tokens` package (teamsLightTheme / teamsDarkTheme); the full table is `scripts/contrast-results.txt`
(50 PASS / 10 FAIL, every FAIL either exempt or mitigated below). Formula: WCAG 2.2 relative luminance + contrast ratio.

## R1. Text contrast (1.4.3, 4.5:1)

| pair | light | dark | verdict |
|---|---|---|---|
| fg1 / bg1 | 15.52 | 14.55 | PASS |
| fg2 / bg1 | 10.05 | 10.01 | PASS |
| fg3 / bg1 | 6.19 | 6.48 | PASS |
| fg4 / bg1 (12 px captions) | 4.95 | 5.11 | PASS - fg4 is the *lowest* grey allowed for text |
| fg1 / bg3 (meeting canvas `#1f1f1f`) | 14.24 | 16.48 | PASS |
| fgDisabled / bg1 | 1.88 | 2.18 | FAIL but exempt (1.4.3 "inactive user interface component"); reported |
| brandForeground1 / bg1 (brand text) | 5.38 | 4.56 | PASS - dark is close to the line; prefer `colorBrandForeground2` `#aab1fa` (7.19) for text on dark |
| white / brandBackground (primary button) | 5.38 | 6.60 | PASS |
| white / dangerBackground3 (Leave) | 6.07 | 6.07 | PASS |
| success / warning foreground1 on bg1 | 6.28 / 5.06 | 5.34 / 7.14 | PASS |
| marigoldForeground1 / bg1 (goal text) | **2.64 FAIL** | 10.22 (on bg3) | light: use `colorPaletteMarigoldForeground2` `#835b00` (6.07); the meeting frame is always dark so the twin never hits the light case |

Rule: never put text in `colorNeutralForeground4` smaller than 12 px, never in `fgDisabled` unless the control is
disabled, and inside `.tw-meeting` treat the canvas as `bg3 #1f1f1f`, not `bg1`.

## R2. Text over video (1.4.3 with an unknown background)

Video can be any luminance; white text on a 50 % scrim fails on white video (3.95:1). The tile label uses
`rgba(0,0,0,0.6)` (`--tw-tile-label-bg`): white text is 5.74:1 over pure-white video, 12.63:1 over mid-grey, so it
passes on any frame. Captions use 0.7 (8.45:1 worst case). Do not reduce either alpha; do not use `colorNeutralBackgroundAlpha2`
(too light for this purpose).

## R3. Non-text contrast (1.4.11, 3:1) - rings, frames, focus

| element | on canvas `#1f1f1f` | on mid-grey video `#808080` | fix |
|---|---|---|---|
| active-speaker ring `colorBrandStroke1` `#7f85f5` | 5.16 PASS | **1.24 FAIL** | `--tw-halo` (1 px black .6 keyline outside the ring: `#1f1f1f` vs `#808080` = 4.17) |
| goal frame `colorPaletteMarigoldBorderActive` `#f2c661` | 10.22 PASS | **2.45 FAIL** | same halo |
| ball trail `colorBrandForeground2` `#aab1fa` | 8.15 PASS | 1.95 | trail is decorative, but the ball itself gets a 1 px dark outline |
| catch ring success `#54b054` / miss ring danger `#dc626d` | 6.06 / 4.72 PASS | - | halo |
| raise-hand gold `#eaa300` ring | 7.64 PASS | - | white icon on the gold pill is **2.16 FAIL**; use a black icon (9.74) |
| focus ring `colorStrokeFocus2` white | 16.48 PASS | 3.95 | see R7 |
| tile keyline `colorNeutralStroke1` `#666666` vs bg3 | 2.87 (decorative, n/a) | - | keylines are not the only boundary; tiles also differ from the canvas by fill |
| primary button `#4f52b2` vs bg3 | 2.50 | - | the button is identified by its text (1.4.11 does not require a fill boundary when text carries it) |

Any coloured ring drawn over video therefore carries `box-shadow: var(--tw-halo)` in addition to its colour.
The halo is what makes the ring readable for everyone, not just users with low vision, so it is on by default.

## R4. Colour is never the only channel (1.4.1)

- Speaking: ring **and** the animated mic icon in the label (ACS shows a speaking indicator; Teams animates the mic).
- Raised hand: ring **and** the pill with `handRight16Filled` icon and the text "Hand raised" for screen readers.
- Goal tile: marigold frame **and** the trophy chip with the word "Goal".
- Catch / miss: green/red flash **and** a 200 ms scale bounce (suppressed under reduced motion) **and** the scoreboard
  text update announced via live region.
- Local vs remote hands: brand vs neutral colour **and** the local tile is the one with the mirrored "You" label.
- Player colours from the shared palette (`colorPalette<Name>BorderActive`) are decorative; the name label is the identity.

## R5. Keyboard (2.1.1, 2.4.3, 2.4.7)

Tab order: top bar -> gallery (each tile is one tab stop, `role="group"`, arrow keys move between tiles, `Enter`
opens the tile menu, `p` pins - mirrors ACS `VideoTile` which puts its `moreButton` in the tab order and makes iframes
`tabIndex=-1`) -> self-view -> control bar (`role="toolbar"`, arrow keys within, `Space`/`Enter` toggle) -> side panel
(`role="complementary"`, its own tab order). `Escape` closes the panel / menu / command popover. Shortcuts follow
Teams: `Ctrl+Shift+M` mute, `Ctrl+Shift+O` camera, `Ctrl+Shift+K` raise hand, `Ctrl+Shift+E` share, and our
`Ctrl+/` command bar **[twin]** (documented in a "Keyboard shortcuts" dialog, 2.1.4 single-key shortcuts avoided).

The game must be *playable* without hands for testing and for people who cannot use the tracker:
`ArrowLeft/Right` to aim, `Space` to throw from the local tile, via the same doctrine path (a scripted holding-pose
cradle then a release) so the physics is identical. This is the keyboard equivalent, not a second game.

## R6. Screen readers (4.1.2, 4.1.3)

- Tile: `aria-label="{name}, {camera on|camera off}, {muted|unmuted}{, speaking}{, hand raised}{, pinned}"`, updated
  on state change (ACS exposes `noVideoAvailableAriaLabel`; Teams reads "camera off").
- Control bar buttons: `aria-pressed` for toggles, `aria-label` = label text (ACS `ControlBarButton` uses
  `ariaLabel ?? labelText ?? tooltipContent` and `aria-describedby` the tooltip).
- Live regions: one `aria-live="polite"` region for game events ("Ana caught the ball", "Goal for Ben, 3-2") and one
  `aria-live="assertive"` for errors (camera lost, relay disconnected). Throttle to one message per 2 s; never announce
  per-frame tracking.
- The command feature returns a text result card ("Placed an apple in your right hand") that is also announced.
- Canvases carry `aria-hidden="true"`; every visual state that matters is mirrored in DOM text.

## R7. Focus visible (2.4.7, 2.4.11 AA in 2.2)

Fluent v9 recipe (`createFocusOutlineStyle`): 2 px `colorStrokeFocus2` ring drawn *outside* the element by an
`::after` at `inset: -2px`, radius `borderRadiusMedium` 4 px; `colorStrokeFocus1` is the inner contrast stroke. The
element needs `position: relative`; `.tw-focusable` implements this. On dark the ring is white (16.48:1 on canvas)
but only 3.95:1 on mid-grey video, so controls that float over video (tile pin/more, self-view) use
`.tw-focus-on-video`: white 2 px outline plus a 4 px `rgba(0,0,0,.8)` shadow - legible on any frame. Under
`forced-colors: active` both become `Highlight`. Focus is never obscured by the control bar or side panel because those
are outside the scrolling region (2.4.11).

## R8. Motion (2.3.3, 2.2.2)

`@media (prefers-reduced-motion: reduce)` zeroes the whole Fluent duration ramp, `--tw-ball-trail-fade-ms`,
`--tw-reaction-duration`, and sets `--tw-motion: 0`; JS reads that custom property once per frame and skips trails,
particles, catch bounce and floating reactions. The ball still moves (it is the content), but no decorative motion
remains. Reactions and captions can be paused from the More menu (2.2.2 pause/stop). No flashing above 3 Hz anywhere
(2.3.1): the catch/miss flash is a single 200 ms fade.

## R9. Target size (2.5.8 AA: 24x24 min; Teams uses 32 with 40 hit)

Control-bar buttons 56x56 cells; top-bar buttons 32 px visual with a 40 px hit area (`--tw-topbar-btn-hit`); tile chrome
buttons 32 px; roster rows 40 px. Nothing interactive is smaller than 24 px.

## R10. Zoom and reflow (1.4.4, 1.4.10)

Text sizes are in px tokens but the whole frame is container-sized, and at 200 % browser zoom the gallery re-packs
(fewer columns) instead of clipping. ACS's composite declares `minWidth: min(20rem, calc(100vw - 1rem))` and
`minHeight: 16rem` for 400 % zoom compliance; the twin's frame keeps the same floor. Below 320 CSS px wide
(400 % of 1280) the side panel becomes a full-screen sheet.

## R11. Pointer / hands (2.5.1, 2.5.7)

Hands are never a pointer: no UI control is operated by gesture, and every hand action in the game has the R5
keyboard path. Dragging the self-view has a keyboard alternative (arrow keys when focused, 2.5.7).

## R12. Honest limits

- Landmark rendering of *other* people (holohands over their video) is visual only; a blind participant gets the live
  region narration of game events, not hand positions.
- Camera-based play is not available to users without a camera or with motor impairments that the tracker misreads;
  the keyboard path exists so they can still throw and catch, but it is a lesser experience and the pilot should say so.
- Automatic captions and reactions in the twin are mock; real accessibility of speech happens in Teams itself.

## Sources

- WCAG 2.2: https://www.w3.org/TR/WCAG22/ (1.4.1, 1.4.3, 1.4.11, 2.1.1, 2.2.2, 2.3.3, 2.4.7, 2.4.11, 2.5.7, 2.5.8, 4.1.3).
- `@fluentui/tokens` 1.0.0-alpha.24 (values), `src/tabster/createFocusOutlineStyle.ts` (focus recipe),
  `src/acs/components/VideoTile.tsx`, `ControlBarButton.tsx` (aria patterns), `cc/CallComposite_styles_CallComposite.styles.ts` (zoom floors).
- `scripts/contrast.mjs`, `scripts/contrast-results.txt` (all ratios above).
- Teams keyboard shortcuts: support.microsoft.com/en-us/office/keyboard-shortcuts-for-microsoft-teams (recalled, not re-fetched).
