# docs/teams — Microsoft Teams pilot: roadmap, example scripts, research, design

Everything here was produced 2026-09-16 → 2026-09-19 for the Teams pilot. The sandbox itself is `teamslab.html`
(run book: `TEAMSLAB.md` at the repo root). Nothing here is a Microsoft product; we use public Fluent 2 tokens and
open-source components only (`licences.html`).

## Start here
- `pilot-memo.html` — the architecture memo: never track the Teams video tile; track locally, relay ~600 B landmark
  packets at 30 Hz, render everyone locally; return paths C1 virtual camera / C2 video-effect app / C3 ACS
  participant; container D meeting-stage app + Live Share; mini-test order T1–T8.
- `design/SPEC.md`, `design/CONTRACTS.md`, `design/BUILD-PLAN.md` — the synthesized design the sandbox was built
  from (winner of a 3-design / 2-judge panel; judges in `design/judge-*.md`). CONTRACTS is the API reference for
  `sdk/game/*` and `sdk/net/*`.

## Teams surfaces: example scripts (copied from the research, verified as noted in the summaries)
| surface | files |
|---|---|
| C2 video-effect (AR overlay) app | `manifest.json`, `video-effects-manifest.annotated.jsonc`, `video-effect.html`, `effect-core.js`, `host-harness.html` (local Teams-host simulator), `teams-video-effect.js` |
| D meeting-stage app + Live Share | `stage.html`, `side-panel.html`, `stage-adapter.md`, `research/meeting-app-README.md` (tenant, sideload, tunnel), `research/meeting-app-NOTES.md` |
| C3 ACS participant | `acs-client.html`, `research/acs-README.md`, `research/acs-UI-LIBRARY.md` |
| wire protocol (all paths) | `hopeos-wire.md`, `relay-server.example.mjs` |
| privacy / terms / licences | `privacy.html`, `terms.html`, `licences.html`, `consent-copy.md`, `data-flow.md`, `licences.md` |

## Research summaries (`research/`)
One `<topic>-SUMMARY.md` per topic (video-effects, meeting-app, acs, ui, frameworks, codebase, command-agent, game)
plus the three gap studies (`gap-wire-protocol`, `gap-render-budget` + `render-budget-decision.md`,
`gap-data-privacy-terms`) and the longer game / ui / frameworks design docs.
