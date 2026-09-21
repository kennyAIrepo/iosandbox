# Topic "codebase" - SUMMARY (finisher pass, 2026-09-18)

Repo `C:/Users/hanna/iosandbox`, HEAD `6c8e6bc`, branch `st-46-face-puppet-contract`; nothing under the repo was modified. Two research passes were merged: the canonical folder (newer, with the built `sandbox-skeleton/` code) and `research_draft1/codebase/` (older, but it reached the end and had three docs the canonical folder lacked). Line numbers are WORKING-TREE numbers for `mpbrowser.html` (HEAD is -3 below line 2898, -12 in 3031-5012, ~-130 above 5393) and HEAD numbers for `sdk/**` and `tests/**` (byte-identical to HEAD). Grep the quoted symbol before copying.

## What the topic concluded

1. **Everything the Teams twin needs already exists as SDK modules; only four small glue modules are new**, and all four are now written as research copies (`sandbox-skeleton/sdk/game/`): `prop-ball.js` (the frozen page's GLASS ball-doctrine lane, extracted verbatim), `tile-pipeline.js` (one participant tile = `PlayerPipeline` + `HandViews` + 2 `HoloHandRig` + 2 `HandBody`), `command-agent.js` (the `WorldAgent` tool loop with injectable tools), `sandbox-tools.js` (8 strict Anthropic tool definitions + dispatcher + system prompt for "give me an apple in my hand"), plus `tools/sandbox-proxy.mjs` (mounts the repo's own Vercel `/api/claude` + `/api/openai` handlers locally).
2. **The doctrine lane extracts cleanly and passes its own doctrine test in Node**: `tests/prop-ball-smoke.mjs` 23/23 - rests under gravity, open hover never lifts or grabs, cupping hand only pulls z to contact depth without moving the hand, back of hand never grips, wrap/clip pick up and release THAT frame, palm-up cradle pulls x/z into the pocket and tilting rolls it off, open hand is stopped at the surface, two-hand pinch scales without moving, and static greps prove the empty hand list / no `jointsWithin` / no `pos.y`-toward-hand.
3. **Multi-person = per-tile pipelines with tile ids (topology B)**; the repo's `initMultiplayerTracking` (MoveNet ids, topology A) is only for a tile whose single camera sees several people. Remote participants are never tracked from Teams video: their `{img mirrored, world raw}` packets enter the same chain after `PlayerPipeline` would have.
4. **Chirality and z-sign stay measured per player**: one `HandViews` per tile; labels are never read anywhere in the sandbox path; unique `HandBody.slot` strings (`'left#'+id`) avoid the aliasing bug `mpgames.html` fixed.
5. **The Claude loop needs no repo change**: `api/claude.js` forwards the JSON body unchanged, so `output_config.effort`, `strict: true` tools and `is_error` results all work through it; the default model for new code is `claude-opus-5` (repo config still uses `claude-opus-4-8` / `claude-sonnet-4-6`, both valid).

## Decisions that constrain the design

- FROZEN `mpbrowser.html` + avatar rig: copy out, never import (the page is not a module; only `window.__lab` probe handles). Done for the ball lane.
- PROP COLLISION DOCTRINE enforced in code: `PropHull` vs 21 joint spheres; `GrabbableSphere.update(dt, [], floorY)` with an EMPTY hand list (its own proximity/pinch grab never runs); pickup only `_wrapGrab` (wrap/clip) or `_holdPose` cradle; open = release the same frame; `pushOut` / `handResist` so hands support and never pass through; seeks are z-only or x/z-pocket, never lift, never gravity-off.
- Chirality/z: `HandViews._zSign` and `_chirality` are the only authorities; `HandBody.palmOut` and `_holdPose`'s inner normal are measured and decay-latched.
- Import map: every page must carry the `three@0.160.0` importmap; MediaPipe `0.10.18` and models load from CDN into CacheStorage; `three-mesh-bvh@0.7.8` loads at import time of anything importing `colliders.js` (which includes `hand-rig.js`). Pages must be served over http (`npm run serve` :3333).
- Budgets: one WebGL context per landmarker (4 players x 2 tasks + three + TF.js hits the ceiling); ~12 ms per hand landmarker at 720p on this box; `multiplayer.js` budgets 45 ms/frame. Hands on local tiles only, pose on one, remotes from packets.
- `/api/*` exists only under Vercel; local dev uses `tools/sandbox-proxy.mjs` (built) or `vercel dev`.
- The presence packet on `BroadcastChannel('hopeos-room')` (`{v:1, kind:'presence', ...}`) is the envelope to extend with `kind:'hands'` / `kind:'ball'` for tile-to-tile traffic.
- Voice: `VoiceCommander` is 4 s `MediaRecorder` chunks through `/api/openai` (`gpt-4o-transcribe`); 4-6 s speech-to-action latency, no VAD.

## Canonical files (`research/codebase/`)

| File | One line | Origin |
|---|---|---|
| `dropins.md` (33 KB) | Module-by-module import / init / per-frame / outputs / gotchas table for the whole SDK, the per-tile pipeline contract, copy targets inside the frozen page, and (new section 6) the built modules | canonical kept (newer, larger than the draft); section 6 appended |
| `minimal-holohands.html` (8.9 KB) | Runnable minimal holohands page (importmap, camera, `initTracking`, One-Euro, `HandViews`, two forged `HoloHandRig`s, `window.__mini` probe seam, `?auto=1`) | canonical kept (newer) |
| `_probe-minimal.mjs` / `_probe-minimal.png` | Headless verify script + screenshot for the page above | canonical kept |
| `ball-extraction-plan.md` (17 KB) | Sections 1-3: analysis of the frozen GLASS lane (inputs, symbols, constants); sections 4-6 rewritten: the module AS BUILT, the verified 23-item checklist, the tile-to-tile pass extension | draft copied, sections 4-6 rewritten |
| `agent-tools.md` (18 KB) | Exact tool shape, `_exec` dispatch, the `/api/claude` loop and API-drift notes; sections 4-5 rewritten around the built `CommandAgent`, `SANDBOX_TOOLS`, proxy | draft copied, sections 4-5 rewritten |
| `multi-person.md` (9 KB) | Topology A vs B, why ids are stable (MoveNet `enableTracking`, `PlayerTracker` join/leave debounce, A/B hysteresis), budgets, remote-packet tiles, solo-test cloning, the doctrine/chirality checklist | written now |
| `test-conventions.md` (11 KB) | Node smoke tests vs puppeteer probes, fake-camera flags, probe seams (`__lab.AVSYNC.ovPacks`, `HOPEOS_STATE`, `__mini`), URL dev params; section 5 added: what was run, the skeleton layout, the sandbox test plan | draft copied, section 5 appended |
| `sandbox-skeleton/sdk/game/prop-ball.js` (24.6 KB) | `PropBall` + verbatim helper exports; DOM-free, Node-testable | canonical |
| `sandbox-skeleton/sdk/game/tile-pipeline.js` (8 KB) | `TilePipeline`, `cloneStreamToTiles` | canonical |
| `sandbox-skeleton/sdk/game/command-agent.js` (5.5 KB) | `CommandAgent` | canonical |
| `sandbox-skeleton/sdk/game/sandbox-tools.js` (7.6 KB) | `SANDBOX_TOOLS`, `makeSandboxExec`, `makeSandboxSystem` | canonical |
| `sandbox-skeleton/tests/prop-ball-smoke.mjs` (12 KB) | Doctrine smoke test (one-line fix this pass: strip comments before the static grep) | canonical, fixed |
| `sandbox-skeleton/tools/sandbox-proxy.mjs` (3.2 KB) | Local `/api/claude` + `/api/openai` | canonical |
| `sandbox-skeleton/package.json` + junctions `node_modules`, `sdk/core`, `sdk/interaction` -> repo | ESM + module resolution without copying the repo | canonical |

## Verification log (run once each, this pass)

| Command | Folder | Result |
|---|---|---|
| `node _probe-minimal.mjs` | `research/codebase` | exit 0. `ready:true, frames:238, detectMs:12.07, verts R 15065, packs null` (fake camera has no hands). Console: only `/favicon.ico` 404. |
| `node tests/prop-ball-smoke.mjs` | `research/codebase/sandbox-skeleton` | first run 22/23 - the static grep hit the module's doctrine HEADER COMMENT ("its own jointsWithin/pinch grab never runs"), a test bug; fixed by stripping block and line comments before the grep (`:195-196`). Second run **23 passed, 0 failed**, exit 0. |
| `node tools/sandbox-proxy.mjs 3390` + `curl` | `research/codebase/sandbox-skeleton` | boots (`keys: false/false`), `OPTIONS /api/claude` 204, `POST /api/claude` -> the repo handler's own 500 `ANTHROPIC_API_KEY is not set on the server`. Routing works; a live call needs a key. |

Not run (needs a browser or a real camera): `tile-pipeline.js` (static read only - its imports are the same public seams `handlab.html` uses), `command-agent.js` against the live API, occlusion of the rig against `ball.collider`, real-camera chirality.

## Sources

- Repo (read-only): `sdk/core/{tracking,filters,hand-views,hand-rig,hands,game-physics,prop-hull,body-rig,body-forge,multiplayer,player-pipeline,player-tracker,multipose,test-source,scene}.js`, `sdk/interaction/{colliders,grab,effects,voice}.js`, `sdk/world/ai-agent.js`, `sdk/hopeos.js`, `sdk/assets/loader.js`, `api/{claude,openai}.js`, `config.js`, `tools/dev-server.mjs`, `handlab.html`, `mpbrowser.html` (frozen; lines 850, 1206-1230, 1284-1724, 1918-1942, 2303-2341, 3022-3027, 3079-3104, 3263-3272, 3401-3409, 4288-4310, 4538-4563, 4765-4780, 6229-6257, 6454-6580), `mpgames.html` (627-632, 648-656, 1427-1450), `world.html:839-842`, `tests/{hand,game,body}-smoke.mjs`, `tests/_{glass,body,game,starter}probe.mjs`, `package.json`.
- Bundled Claude API reference (skill `claude-api`, loaded 2026-09-18): model table (`claude-opus-5` default; `claude-opus-4-8`, `claude-sonnet-4-6` valid), `output_config.effort` GA, strict tool use GA, prefill 400 on 4.6+, parallel `tool_result`s in one message, forced `tool_choice` 400 only on Claude Fable 5.1.
- Earlier memo: `scratchpad/teams-pilot-plan.html` (track locally, ~600 B packets at 30 Hz, render locally; return paths C1/C2/C3/D).
- Memory notes: prop-collision-doctrine, hand-coordinate-conventions, rig-pipeline-frozen, rig-decimation (wire-validate before claiming fixes).
