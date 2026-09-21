// gen-teams-tokens.mjs -- emits ../sdk/ui/teams-tokens.css by READING the published @fluentui/tokens package
// (no hand transcription of hex values). Run from REPO:  node tools/gen-teams-tokens.mjs  (inputs: ../build/node_modules/@fluentui/tokens + ../src/global/brandColors.ts relative to tools/, as in research/ui)
//
// Sources (all public):
//   @fluentui/tokens 1.0.0-alpha.24 (MIT)   npm package installed in ../build/node_modules; source of truth for every value:
//     https://github.com/microsoft/fluentui/tree/master/packages/tokens/src
//     themes/teams/lightTheme.ts  -> teamsLightTheme = createLightTheme(brandTeams) + teamsFontFamilies
//     themes/teams/darkTheme.ts   -> teamsDarkTheme  = createTeamsDarkTheme(brandTeams) + teamsFontFamilies
//     global/brandColors.ts       -> brandTeams ramp 10..160 (and brandTeamsV21, opt-in)
//     alias/lightColor.ts, alias/teamsDarkColor.ts -> neutral/brand alias tokens
//     alias/lightColorPalette.ts, alias/darkColorPalette.ts -> colorPalette* / colorStatus* tokens
//     global/fonts.ts (+ alias/teamsFontFamilies.ts), global/spacings.ts, global/borderRadius.ts,
//     global/strokeWidths.ts, global/durations.ts, global/curves.ts, utils/shadows.ts
//   Fluent UI React v9 focus ring: packages/react-components/react-tabster/src/focus/createFocusOutlineStyle.ts
//     (outlineColor: tokens.colorStrokeFocus2, outlineRadius: tokens.borderRadiusMedium, outlineWidth: '2px')
//   Fluent 2 design site: https://fluent2.microsoft.design/typography (semantic type ramp names),
//     https://fluent2.microsoft.design/layout (4px base grid, size ramp), https://fluent2.microsoft.design/elevation
//   Teams meeting stage sizes: https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/design/designing-apps-in-meetings
//   ACS UI Library calling palette (MIT): packages/react-components/src/theming/themes.ts (raiseHandGold #eaa300, callRed)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const t = require('../build/node_modules/@fluentui/tokens');
const pkg = require('../build/node_modules/@fluentui/tokens/package.json');

const L = t.teamsLightTheme, D = t.teamsDarkTheme, LV = t.teamsLightV21Theme, DV = t.teamsDarkV21Theme;
// brandTeams / brandTeamsV21 are not re-exported by the package; parse them from the fetched source file global/brandColors.ts
// (https://raw.githubusercontent.com/microsoft/fluentui/master/packages/tokens/src/global/brandColors.ts)
import { readFileSync } from 'node:fs';
const brandSrc = readFileSync(new URL('../src/global/brandColors.ts', import.meta.url), 'utf8');
const parseRamp = (name) => {
  const m = brandSrc.match(new RegExp(`export const ${name}: BrandVariants = \\{([^}]*)\\}`));
  const o = {};
  for (const [, k, v] of m[1].matchAll(/(\d+):\s*`(#[0-9a-f]{6})`/g)) o[k] = v;
  return o;
};
const brand = parseRamp('brandTeams'), brandV21 = parseRamp('brandTeamsV21');
// cross-check the parsed ramp against the compiled themes: light colorBrandBackground = brand80, dark = brand70, dark fg1 = brand100
if (L.colorBrandBackground !== brand[80] || D.colorBrandBackground !== brand[70] || D.colorBrandForeground1 !== brand[100]) throw new Error('brand ramp parse mismatch');
if (LV.colorBrandBackground !== brandV21[80]) throw new Error('brandV21 ramp parse mismatch');

// ---- token groups, in the order requested by the spec. Each: [label, source, regex] ----
const GROUPS = [
  ['Brand alias tokens (colorBrandBackground*, colorBrandForeground*, colorBrandStroke*, colorCompoundBrand*)', 'alias/lightColor.ts (light) / alias/teamsDarkColor.ts (dark), fed by global/brandColors.ts brandTeams', /^color(Brand|CompoundBrand)/],
  ['Neutral backgrounds 1-6 (+ hover/pressed/selected), inverted, static, alpha, subtle, transparent, disabled, stencil, scrollbar', 'alias/lightColor.ts / alias/teamsDarkColor.ts. NOTE: teamsDark bg2..bg5 differ from webDark (teams: #242424 #1f1f1f #141414 #0a0a0a)', /^color(Neutral(Background|Stencil)|Subtle|Transparent|Scrollbar)/],
  ['Neutral foregrounds 1-4, disabled, inverted, on-brand, link', 'alias/lightColor.ts / alias/teamsDarkColor.ts', /^colorNeutralForeground/],
  ['Stroke colors: neutralStroke1-3, strokeAccessible, strokeSubtle, strokeOnBrand, strokeDisabled, transparentStroke, strokeAlpha', 'alias/lightColor.ts / alias/teamsDarkColor.ts', /^color(NeutralStroke|TransparentStroke)/],
  ['Focus ring colors (colorStrokeFocus1 = inner, colorStrokeFocus2 = outer)', 'alias/lightColor.ts / alias/teamsDarkColor.ts; ring geometry from react-tabster createFocusOutlineStyle.ts', /^colorStrokeFocus/],
  ['Shadow colors (ambient + key)', 'alias/lightColor.ts / alias/teamsDarkColor.ts', /^color(Neutral|Brand)Shadow/],
  ['Card backgrounds + modal overlay scrim (colorBackgroundOverlay)', 'alias/lightColor.ts / alias/teamsDarkColor.ts', /^color(NeutralCardBackground|BackgroundOverlay)/],
  ['Status colors: Danger (cranberry), Success (green), Warning (orange)', 'alias/lightColorPalette.ts / alias/darkColorPalette.ts via alias/statusColorMapping.ts', /^colorStatus/],
  ['Shared palette tokens (colorPalette<Name>Background1-3 / Foreground1-3 / Border1-2 / BorderActive). Marigold is used for the twin goal frame; the rest are available for per-player colours.', 'alias/lightColorPalette.ts / alias/darkColorPalette.ts (global/colors.ts ramps)', /^colorPalette/],
  ['Font families (teamsFontFamilies overrides fontFamilyBase)', 'alias/teamsFontFamilies.ts + global/fonts.ts. Fluent 2 typography page: Windows renders the ramp in Segoe UI Variable, web default is Segoe UI', /^fontFamily/],
  ['Type ramp sizes (Caption2=100 10px, Caption1=200 12px, Body1=300 14px, Subtitle2=400 16px, Subtitle1=500 20px, Title3=600 24px, Title2=700 28px, Title1=800 32px, LargeTitle=900 40px, Display=1000 68px)', 'global/fonts.ts; semantic names per fluent2.microsoft.design/typography', /^fontSize/],
  ['Line heights', 'global/fonts.ts. NOTE: fluent2.microsoft.design/typography lists Subtitle 1 as 20/26; the shipped token lineHeightBase500 is 28px -- we follow the package', /^lineHeight/],
  ['Font weights', 'global/fonts.ts', /^fontWeight/],
  ['Corner radii', 'global/borderRadius.ts', /^borderRadius/],
  ['Stroke widths', 'global/strokeWidths.ts', /^strokeWidth/],
  ['Spacing scale (4px base grid; 2/6/10 exist for icon optical padding per fluent2.microsoft.design/layout)', 'global/spacings.ts', /^spacing/],
  ['Shadows (ambient + key recipe, shadow2/4/8/16/28/64 and *Brand)', 'utils/shadows.ts createShadowTokens(colorNeutralShadowAmbient, colorNeutralShadowKey)', /^shadow/],
  ['Motion durations', 'global/durations.ts', /^duration/],
  ['Motion curves', 'global/curves.ts', /^curve/],
];

const allKeys = Object.keys(L);
const seen = new Set();
const emit = (theme, indent = '  ') => {
  let out = '';
  for (const [label, src, re] of GROUPS) {
    const keys = allKeys.filter(k => re.test(k));
    if (!keys.length) continue;
    out += `\n${indent}/* ---- ${label}  [${src}] ---- */\n`;
    for (const k of keys) { seen.add(k); out += `${indent}--${k}: ${theme[k]};\n`; }
  }
  return out;
};
const emitColorsOnly = (theme, indent = '  ') => {
  let out = '';
  for (const [label, src, re] of GROUPS) {
    const keys = allKeys.filter(k => re.test(k) && /^color/.test(k));
    if (!keys.length) continue;
    out += `\n${indent}/* ---- ${label}  [${src}] ---- */\n`;
    for (const k of keys) out += `${indent}--${k}: ${theme[k]};\n`;
  }
  return out;
};
const emitRamp = (name, ramp, indent = '  ') => Object.keys(ramp).map(k => `${indent}--${name}${k}: ${ramp[k]};`).join('\n');
const emitDiff = (base, variant, indent = '  ') => allKeys.filter(k => base[k] !== variant[k]).map(k => `${indent}--${k}: ${variant[k]};`).join('\n');

// ---- twin-specific tokens (OUR mapping onto Fluent tokens; not Microsoft numbers unless cited) ----
const TWIN = `
  /* ==== TEAMS-TWIN EXTENSION TOKENS (prefix --tw-). These are OUR mappings onto the Fluent tokens above.
     Numbers with a citation are Microsoft's; everything else is a design decision for the twin. ==== */
  /* Meeting stage sizes (learn.microsoft.com designing-apps-in-meetings#responsive-behavior-shared-meeting-stage):
     "When the side panel isn't open, the meeting stage is 994x678 pixels, by default and can be a minimum 792x382 pixel."
     "When the side panel is open, the meeting stage is 918x540 pixels by default and can be a minimum 472x382 pixels." */
  --tw-stage-default-w: 994px;  --tw-stage-default-h: 678px;
  --tw-stage-min-w: 792px;      --tw-stage-min-h: 382px;
  --tw-stage-sidepanel-w: 918px; --tw-stage-sidepanel-h: 540px;
  --tw-stage-sidepanel-min-w: 472px;
  /* In-meeting side panel: "Optimize your in-meeting tab to fit edge-to-edge within the 280 pixel-wide iframe area.
     There are 20 pixels of padding on the left and right sides of the iframe" (same page, #spacing) -> 280 + 2*20 = 320px */
  --tw-sidepanel-w: 320px;
  --tw-sidepanel-iframe-w: 280px;
  --tw-sidepanel-pad-x: 20px;
  --tw-sidepanel-notification-h: 20px; /* "Error alerts display directly below the header and push the rest of your iframe content down 20 pixels." */
  /* In-meeting dialog: "Width: Min--280 pixels (248 pixels iframe). Max--460 pixels (428 pixels iframe). Height: 300 pixels (iframe)." */
  --tw-dialog-min-w: 280px; --tw-dialog-max-w: 460px; --tw-dialog-iframe-h: 300px;
  /* ACS UI Library reference numbers (MIT, packages/react-components/src/...):
     GridLayout gridGap 0.5rem; VideoTile label 0.75rem/600 at bottom-left with 0.5rem padding; speaking/raised-hand ring 0.25rem;
     raised-hand pill radius 1rem, margin 0.5rem, opacity .9; side pane 21.5rem wide, header 1.125rem/600;
     floating local video 13.75rem x 7.5rem (16:9) at 1rem from bottom/right; control-bar buttons min 3.5rem, label 0.625rem. */
  --tw-gallery-gap: 8px;
  --tw-gallery-pad: 8px;
  --tw-tile-aspect: 16 / 9;
  --tw-tile-radius: var(--borderRadiusLarge);            /* 6px; ACS uses theme.effects.roundedCorner4 (4px) */
  --tw-tile-bg: var(--colorNeutralBackground1);          /* camera-off tile surface */
  --tw-tile-label-font: var(--fontWeightSemibold) var(--fontSizeBase200) / var(--lineHeightBase200) var(--fontFamilyBase);
  --tw-tile-label-pad: var(--spacingVerticalXS) var(--spacingHorizontalS);
  --tw-tile-label-bg: rgba(0, 0, 0, 0.6);                /* white text passes 4.5:1 over any video (see accessibility.md scrim table) */
  --tw-tile-label-fg: #ffffff;
  --tw-tile-label-radius: var(--borderRadiusMedium);
  --tw-tile-speaking-ring: var(--strokeWidthThickest) solid var(--colorBrandStroke1); /* 4px = ACS 0.25rem themePrimary */
  --tw-tile-raisedhand-ring: var(--strokeWidthThickest) solid var(--colorPaletteMarigoldBorderActive);
  --tw-raisehand-gold: #eaa300;                          /* ACS callingPalette.raiseHandGold = Fluent marigold primary */
  --tw-tile-pinned-icon: 'pin16Regular';                 /* Fluent UI System Icons names (MIT) */
  --tw-tile-spotlight-icon: 'videoPersonStar16Regular';
  --tw-tile-muted-icon: 'micOff16Regular';
  --tw-selfview-w: 220px; --tw-selfview-h: 124px;        /* ACS LARGE_FLOATING_MODAL 13.75rem x 7.5rem (16:9) when floated */
  --tw-selfview-inset: 16px;                             /* ACS floatinglocalVideoModalInitialPositionGapRem = 1rem */
  --tw-controlbar-h: 56px;                               /* ACS controlButtonStyles minHeight 3.5rem */
  --tw-controlbar-btn-min-w: 56px;
  --tw-controlbar-btn-h: 32px;                           /* Fluent v9 Button medium: 5px + 20px line + 5px + 2px border */
  --tw-controlbar-btn-radius: var(--borderRadiusMedium);
  --tw-controlbar-icon: 20px;                            /* Fluent v9 Button medium icon 20px */
  --tw-controlbar-label-font: var(--fontWeightRegular) var(--fontSizeBase100) / var(--lineHeightBase200) var(--fontFamilyBase); /* ACS label 0.625rem */
  --tw-leave-bg: var(--colorStatusDangerBackground3);    /* Leave = danger button; white text 6.07:1 */
  --tw-leave-bg-hover: var(--colorStatusDangerBackground3Hover);
  --tw-leave-fg: var(--colorNeutralForegroundOnBrand);
  --tw-roster-row-h: 40px;                               /* ACS ParticipantItem padding 0.5rem + 24px avatar */
  --tw-roster-avatar: 24px;
  --tw-roster-header-font: var(--fontWeightSemibold) 18px / 24px var(--fontFamilyBase); /* ACS sidePaneHeaderStyles 1.125rem/1.5rem/600 */
  --tw-captions-font: var(--fontWeightRegular) var(--fontSizeBase400) / var(--lineHeightBase400) var(--fontFamilyBase);
  --tw-captions-bg: rgba(0, 0, 0, 0.7);
  --tw-captions-fg: #ffffff;
  --tw-captions-max-w: 720px;
  --tw-reaction-size: 32px;
  --tw-reaction-duration: 3000ms;                        /* support page: "pops up momentarily ... for a few seconds" */
  /* Focus ring per Fluent v9 createFocusOutlineStyle: 2px solid colorStrokeFocus2, radius borderRadiusMedium, drawn OUTSIDE via ::after;
     colorStrokeFocus1 is the inner contrast stroke. */
  --tw-focus-ring: 2px solid var(--colorStrokeFocus2);
  --tw-focus-ring-inner: 1px solid var(--colorStrokeFocus1);
  --tw-focus-ring-radius: var(--borderRadiusMedium);
  /* Game layer (co-presence): goal frame = marigold (colour-independent: also a Trophy icon + "GOAL" chip + aria-label);
     ball trail = brand foreground 2; success/danger rings from status tokens; hand rig lines use brand + white. */
  --tw-goal-frame: 3px solid var(--colorPaletteMarigoldBorderActive);
  --tw-goal-chip-bg: var(--colorPaletteMarigoldBackground2);
  --tw-goal-chip-fg: var(--colorPaletteMarigoldForeground2);
  --tw-goal-icon: 'trophy16Regular';
  --tw-ball-trail: var(--colorBrandForeground2);
  --tw-ball-trail-width: 3px;
  --tw-ball-trail-fade-ms: 600ms;
  --tw-hand-bone: rgba(255, 255, 255, 0.85);
  --tw-hand-joint: var(--colorBrandForeground1);
  --tw-hand-bone-width: 2px;
  --tw-hand-joint-r: 3px;
  --tw-scoreboard-font: var(--fontWeightSemibold) var(--fontSizeBase300) / var(--lineHeightBase300) var(--fontFamilyNumeric);
  --tw-scoreboard-bg: var(--colorNeutralBackground2);
  --tw-scoreboard-radius: var(--borderRadiusCircular);
  --tw-catch-ring: 3px solid var(--colorStatusSuccessBorderActive);
  --tw-miss-ring: 3px solid var(--colorStatusDangerBorderActive);
  --tw-motion-fast: var(--durationFast) var(--curveDecelerateMid);
  --tw-motion-normal: var(--durationNormal) var(--curveEasyEase);
  --tw-motion: 1;                                        /* JS gate: getComputedStyle(el).getPropertyValue('--tw-motion').trim() === '0' -> no trails/particles/reaction animation */
  /* Breakpoints (Fluent UI v8 responsive size classes, also listed on fluent2.microsoft.design/layout): small <480, medium 480-639,
     large 640-1023, xLarge 1024-1365, xxLarge 1366-1919, xxxLarge >=1920. ACS additionally treats a gallery container <=480px wide
     as "narrow" and <=380px tall as "short" (VideoGallery utils/responsive.ts; thresholds recalled, that file was not fetched). */
  --tw-bp-small-max: 479px; --tw-bp-medium-max: 639px; --tw-bp-large-max: 1023px;
  --tw-bp-xlarge-min: 1024px; --tw-bp-xxlarge-min: 1366px; --tw-bp-xxxlarge-min: 1920px;
  --tw-gallery-narrow-max: 480px; --tw-gallery-short-max: 380px;
  --tw-selfview-narrow-w: 58px; --tw-selfview-narrow-h: 104px;  /* ACS SMALL_FLOATING_MODAL 3.625rem x 6.5rem (portrait) when the gallery is narrow */
  /* Window chrome (OUR numbers; Microsoft publishes none for the client's top bar) */
  --tw-window-bg: var(--colorNeutralBackground3);
  --tw-stage-bg: var(--colorNeutralBackground4);
  --tw-topbar-bg: var(--colorNeutralBackground3);
  --tw-topbar-h: 48px; --tw-topbar-btn: 32px; --tw-topbar-btn-hit: 40px;
  --tw-panel-bg: var(--colorNeutralBackground2);
  --tw-panel-border: var(--colorNeutralStroke2);
  --tw-font-ui: "Segoe UI Variable Text", "Segoe UI Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif; /* opt-in Windows 11 variable face (fluent2 typography page); the tokens' fontFamilyBase names plain "Segoe UI" */
  /* Halos: a dark keyline under any coloured ring/stroke drawn OVER VIDEO, so the ring reads on mid-grey video where the brand
     stroke alone fails 3:1 (contrast-results.txt: brandStroke1 vs #808080 = 1.24:1 dark / 1.36:1 light; #1f1f1f vs #808080 = 4.17:1) */
  --tw-halo: 0 0 0 1px rgba(0, 0, 0, 0.6);
  --tw-halo-strong: 0 0 0 2px rgba(0, 0, 0, 0.8);
  --tw-hand-local: var(--colorBrandForeground1);
  --tw-hand-remote: var(--colorNeutralForeground2);
  /* Stacking order for the layered twin (tile canvas < hands < transit overlay < self-view < control bar < side panel < dialog < toast) */
  --tw-z-tile: 0; --tw-z-hands: 5; --tw-z-ball: 6; --tw-z-selfview: 10; --tw-z-controlbar: 20; --tw-z-panel: 30; --tw-z-dialog: 40; --tw-z-toast: 50;
`;

const header = `/* teams-tokens.css -- Teams-twin design tokens (Fluent 2 / @fluentui/tokens ${pkg.version}, Teams brand theme)
 * GENERATED on 2026-09-18 by scripts/gen-tokens.mjs, which reads the published npm package -- edit the generator, not this file.
 *
 * LEGITIMACY STATEMENT: this file reuses PUBLIC design tokens and open-source reference implementations only:
 *   - Fluent 2 design system (https://fluent2.microsoft.design) and @fluentui/tokens (MIT, https://github.com/microsoft/fluentui)
 *   - Fluent UI React v9 focus-ring recipe (MIT, same repo), Fluent UI System Icons names (MIT, https://github.com/microsoft/fluentui-system-icons)
 *   - Azure Communication Services UI Library CallComposite as a public reference implementation (MIT, https://github.com/Azure/communication-ui-library)
 *   - numbers published on learn.microsoft.com / support.microsoft.com
 * It does NOT contain, and we did not download or de-minify, Microsoft's proprietary Teams client code or assets.
 * The Teams client's private CSS is not reproduced; where Microsoft has not published a number, the --tw-* token says so.
 *
 * Theme wiring (three states, per the artifact/theme contract):
 *   :root                                                     -> teamsLightTheme
 *   @media (prefers-color-scheme: dark) :root:not([data-theme="light"]) -> teamsDarkTheme
 *   :root[data-theme="dark"]                                  -> teamsDarkTheme (explicit toggle wins both ways)
 *   .tw-meeting                                               -> ALWAYS teamsDarkTheme colours: "Teams meetings are optimized for dark theme
 *                                                                to help reduce visual and cognitive noise" (learn.microsoft.com
 *                                                                .../designing-apps-in-meetings#theming)
 *   [data-brand="teams-v21"]                                  -> opt-in brandTeamsV21 ramp (teamsLightV21Theme / teamsDarkV21Theme)
 * Variable names are the Fluent v9 token names, so \`var(--colorBrandBackground)\` here equals \`tokens.colorBrandBackground\` in React v9
 * (lib/tokens.js maps every token to var(--<name>)).
 * Contrast results for the pairs used by the twin: see accessibility.md (computed by scripts/contrast.mjs from this same package).
 */
`;

let css = header;
css += `\n:root, .tw-theme-light {\n`;
css += `  /* ---- Brand ramp: brandTeams  [global/brandColors.ts]. teamsLightTheme uses 80 for colorBrandBackground, teamsDarkTheme uses 70; brandForeground1 = 80 light / 100 dark ---- */\n`;
css += emitRamp('brand', brand) + '\n';
css += emit(L);
css += TWIN;
css += `}\n`;

css += `\n/* ===================== DARK (teamsDarkTheme) -- colour tokens only; typography/spacing/radii/motion are theme-invariant ===================== */\n`;
css += `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n`;
css += `    /* Brand ramp unchanged in dark; alias tokens pick different steps (bg = brand70, fg1 = brand100, fg2 = brand120 [teams-specific]) */\n`;
css += emitColorsOnly(D, '    ');
css += `  }\n}\n`;
css += `\n:root[data-theme="dark"], .tw-theme-dark, .tw-meeting {\n`;
css += emitColorsOnly(D, '  ');
css += `}\n`;

css += `\n/* ===================== OPT-IN: brandTeamsV21 ramp (newer purple). Apply [data-brand="teams-v21"] on <html>. Only the tokens that differ are listed. ===================== */\n`;
css += `[data-brand="teams-v21"] {\n${emitRamp('brand', brandV21)}\n${emitDiff(L, LV)}\n}\n`;
css += `@media (prefers-color-scheme: dark) {\n  [data-brand="teams-v21"]:not([data-theme="light"]) {\n${emitDiff(D, DV, '    ')}\n  }\n}\n`;
css += `[data-brand="teams-v21"][data-theme="dark"], [data-brand="teams-v21"] .tw-meeting {\n${emitDiff(D, DV)}\n}\n`;

css += `
/* ===================== Base element styles that the tokens imply (small, optional) ===================== */
html { color-scheme: light dark; }
body { margin: 0; background: var(--colorNeutralBackground1); color: var(--colorNeutralForeground1);
       font: var(--fontWeightRegular) var(--fontSizeBase300) / var(--lineHeightBase300) var(--fontFamilyBase); }
.tw-meeting { background: var(--colorNeutralBackground3); color: var(--colorNeutralForeground1); }
/* Fluent v9 focus ring, drawn outside the element (createFocusOutlineStyle): needs position:relative on the element */
.tw-focusable { position: relative; outline: none; }
.tw-focusable:focus-visible::after { content: ""; position: absolute; pointer-events: none; z-index: 1; inset: calc(-1 * 2px);
  border: var(--tw-focus-ring); border-radius: var(--tw-focus-ring-radius); }
@media (forced-colors: active) { .tw-focusable:focus-visible::after { border-color: Highlight; } }
/* Double ring for controls that float over video (accessibility.md R7): white 2px + dark halo, legible whatever the video behind */
.tw-focus-on-video:focus-visible { outline: 2px solid #ffffff; outline-offset: 0; box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.8); }
@media (forced-colors: active) { .tw-focus-on-video:focus-visible { outline-color: Highlight; box-shadow: none; } }
@media (prefers-reduced-motion: reduce) { :root, .tw-meeting { --tw-motion-fast: 0ms linear; --tw-motion-normal: 0ms linear; --tw-ball-trail-fade-ms: 0ms; --tw-reaction-duration: 0ms; --tw-motion: 0;
  --durationUltraFast: 0ms; --durationFaster: 0ms; --durationFast: 0ms; --durationNormal: 0ms; --durationGentle: 0ms; --durationSlow: 0ms; --durationSlower: 0ms; --durationUltraSlow: 0ms; } }
.tw-visually-hidden { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
/* Type ramp (fluent2.microsoft.design/typography; = Fluent UI React v9 Text presets) */
.tw-caption2        { font-size: var(--fontSizeBase100); line-height: var(--lineHeightBase100); font-weight: var(--fontWeightRegular); }
.tw-caption2-strong { font-size: var(--fontSizeBase100); line-height: var(--lineHeightBase100); font-weight: var(--fontWeightSemibold); }
.tw-caption1        { font-size: var(--fontSizeBase200); line-height: var(--lineHeightBase200); font-weight: var(--fontWeightRegular); }
.tw-caption1-strong { font-size: var(--fontSizeBase200); line-height: var(--lineHeightBase200); font-weight: var(--fontWeightSemibold); }
.tw-body1           { font-size: var(--fontSizeBase300); line-height: var(--lineHeightBase300); font-weight: var(--fontWeightRegular); }
.tw-body1-strong    { font-size: var(--fontSizeBase300); line-height: var(--lineHeightBase300); font-weight: var(--fontWeightSemibold); }
.tw-subtitle2       { font-size: var(--fontSizeBase400); line-height: var(--lineHeightBase400); font-weight: var(--fontWeightSemibold); }
.tw-subtitle1       { font-size: var(--fontSizeBase500); line-height: var(--lineHeightBase500); font-weight: var(--fontWeightSemibold); }
.tw-title3          { font-size: var(--fontSizeBase600); line-height: var(--lineHeightBase600); font-weight: var(--fontWeightSemibold); }
.tw-title2          { font-size: var(--fontSizeHero700); line-height: var(--lineHeightHero700); font-weight: var(--fontWeightSemibold); }
.tw-title1          { font-size: var(--fontSizeHero800); line-height: var(--lineHeightHero800); font-weight: var(--fontWeightSemibold); }
.tw-large-title     { font-size: var(--fontSizeHero900); line-height: var(--lineHeightHero900); font-weight: var(--fontWeightSemibold); }
.tw-display         { font-size: var(--fontSizeHero1000); line-height: var(--lineHeightHero1000); font-weight: var(--fontWeightSemibold); }
.tw-numeric         { font-family: var(--fontFamilyNumeric); font-variant-numeric: tabular-nums; }
`;

const missing = allKeys.filter(k => !seen.has(k));
if (missing.length) console.warn('WARNING: tokens not covered by any group:', missing.join(', '));
writeFileSync(new URL('../sdk/ui/teams-tokens.css', import.meta.url), css);
console.log(`wrote teams-tokens.css: ${css.length} bytes, ${allKeys.length} tokens per theme, package ${pkg.version}`);
