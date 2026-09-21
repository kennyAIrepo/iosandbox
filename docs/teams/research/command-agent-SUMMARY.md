# command-agent — research summary (2026-09-18, finisher pass)

Folder: `C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/research/command-agent/`

## What the topic concluded

The voice/text -> Claude -> 3D-object command feature ("give me an apple in my hand") is a small, dependency-free browser ES module, `command-agent.js`, that turns one spoken or typed sentence into strict tool calls (`tools.json`) executed by the host page's `executor(name, input)`, with a local regex grammar as a no-key / no-network fallback so the demo never stalls. It talks to the existing transparent proxy `api/claude.js` (`/api/claude`, raw Messages body, server adds the key) and follows the current API rules: `claude-opus-5`, no `thinking` key and no `budget_tokens` (adaptive thinking is the default; `budget_tokens` 400s on Opus 4.7+), no temperature/top_p/top_k, `output_config.effort: 'low'`, `tool_choice: auto` only (forced tool use is rejected on this tier), every tool `strict: true` with `additionalProperties: false` and full `required` (numeric bounds cannot live in strict schemas, so all clamps are in the executor), `cache_control` on the system block so tools + system (~2.9k tokens, above the 512-token minimum) are cached and the per-command scene snapshot sits after the breakpoint. The loop is at most 3 API calls; several `tool_use` blocks in one response are executed IN ORDER (not `Promise.all`) so `spawn_object` + `set_behavior(last)` + `apply_effect(last)` work in one round; all `tool_result`s go back in ONE user message with matching ids; `stop_reason: refusal` is checked before content and never retried; `max_tokens` is treated as failure; 429/529 back off once (fixed 2 s, because the proxy forwards status but not `retry-after`) and then fall back to the grammar. The second pass added a one-slot command queue (VoiceCommander can deliver a transcript every ~4 s, faster than a two-round command finishes), a 20 s per-request abort, a `raw` event for recording live fixtures, and stronger tool descriptions with trigger phrases. The system prompt states the PROP COLLISION DOCTRINE as facts ("in my hand" = placed into the open palm so the hand supports it; everything has gravity and collision; nothing is pinned) so the model never asks for a floating or pinned object; the executor is the only place the doctrine is enforced, and `mock-executor.js` maps every tool onto the FROZEN `mpbrowser.html` / `sdk/` hooks by line number (`_palmPose` palm frame + cradle pocket, `PropHull`, `ENG_MINDS` mind pattern) without touching the repo. Voice input keeps `VoiceCommander` (one-line wiring via `onTranscript`) or uses `push-to-talk.js` (MediaRecorder hold-to-talk through the same `/api/openai` proxy), which removes ~2 s of average latency. Estimated speech-end-to-apple: ~2-4.5 s push-to-talk, ~4.5-9 s with 4 s chunks, ~0.5-1.5 s local grammar; estimated cost ~1-1.5 cents per command with a warm cache, ~2.5 cents cold. Nothing was measured against a live key; every stage emits `ms` and `usage` so the real numbers come from the HUD.

## Decisions that constrain design

- Model `claude-opus-5`, effort low, no thinking block, no sampling params, `tool_choice: auto`, all tools strict. `model` is a constructor option only for a measured A/B (sonnet-5 / haiku-4-5).
- Executor contract: `async executor(name, input) -> { ok, ... }`; `spawn_object` MUST return `id`; `list_scene` is called before every Claude request (keep it cheap); throwing or `ok:false` becomes `is_error:true`.
- Tool inputs are model output: clamp `size_m` 0.02-2 m and `scale` 0.1-10x in the executor; resolve targets only against known ids/kinds; colours via `THREE.Color.set(css)`; never `eval`.
- Doctrine enforcement lives in the executor: seat at the palm pocket along the measured palm normal, gravity on, cradle block supports; never parent under the hand, never `GrabbableSphere.jointsWithin`/pinch grab, never gravity-off seek. Chirality comes from `hand-views.js _zSign`, not the prompt.
- Transport limits from `api/claude.js`: no streaming, no `retry-after`, no beta headers (so server-side refusal fallbacks are unavailable). `tools/dev-server.mjs` has no `/api` route, so on localhost `mode:'auto'` silently uses the local grammar.
- `pass_object` / `designate_goal` run on the speaker's client; relaying the state change to other tiles is the wire format of the `game` / `acs` topics. Consider a HUD confirm for `remove_object {target:'all'}`.
- The system prompt is in the cached prefix: edits invalidate the cache for everyone; keep it short and stable. `DEFAULT_SYSTEM` must stay byte-identical to `system-prompt.md` (the test asserts it).
- One command at a time per client; the newest waiting command wins and the displaced one resolves `status:'dropped'`.

## Canonical files

- `command-agent.js` — the module: `CommandAgent`, `loadTools`, `loadSystemPrompt`, `stripComments`, `summarize`, `CATALOG`, `DEFAULT_SYSTEM`; tool loop, queue, timeout, events, local grammar. (Kept the newer canonical version; the draft lacks the queue/timeout/raw/describe additions.)
- `tools.json` — 8 strict tools + spawnable catalog. (Kept canonical; same tool set as the draft, stronger descriptions.)
- `system-prompt.md` — the system text with a sourced rationale in its HTML comment. (Kept canonical; the draft prose is older and lacks the "Use the tools to act" line the JS mirrors.)
- `mock-executor.js` — `MockScene` in-memory executor + real-stack wiring plan with mpbrowser/sdk line numbers. (Kept canonical.)
- `push-to-talk.js` — `PushToTalk` hold-to-record + keep-VoiceCommander wiring + wake-word sketch. (Kept canonical.)
- `test-mock.mjs` — offline test, stubbed `fetch`, 14 sections, 114 assertions. (Kept canonical; the draft had 86.)
- `NOTES.md` — request shape with per-rule sources, latency budget, cost, testing without a key, voice path, executor contract, findings about existing code, open questions, relation to other topics. (Copied from the draft, which only the first pass wrote, and updated to the newer code.)
- `SUMMARY.md` — this file.

## Verification

`node test-mock.mjs` run from this folder on 2026-09-18 (Node v25.2.1, Windows): 114 passed, 0 failed across sections [0] static, [A] one-round spawn, [B] 3 parallel tool_use, [B2] executor error, [C] refusal, [D] 429 then 200, [D2] 529 twice, [E] fetch throws, [F] round cap, [G] max_tokens, [H] proxy 500, [H2] timeout, [I] queue, [J] 34 local-grammar phrases. No live-key run was made.

## Still missing / risks

- Measured Opus 5 effort-low latency and thinking-token share on this prompt (needs a key; events are in place).
- `anyOf [number, null]` strict schemas are documented as supported but not exercised against the live API.
- Source of participant display names inside a Teams tile for the snapshot (ACS / meeting-app topics).
- Wake word vs push-to-talk for the demo; a `/api/claude` route in `tools/dev-server.mjs` for local live-path testing (not done: the repo is read-only for this task).
- The real executor is the only doctrine guard; a sloppy implementation (parenting the apple under the hand) would violate it regardless of the prompt.

## Sources

The bundled claude-api reference (skill build 2.1.266) was the designated API snapshot; public pages it maps to: tool use overview https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md ; structured outputs / strict tools https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md ; effort https://platform.claude.com/docs/en/build-with-claude/effort.md ; adaptive thinking https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking.md ; stop reasons https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons ; prompt caching https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md ; rate limits https://platform.claude.com/docs/en/api/rate-limits.md ; models/pricing https://platform.claude.com/docs/en/about-claude/models/overview.md , https://platform.claude.com/docs/en/pricing.md ; migration guide https://platform.claude.com/docs/en/about-claude/models/migration-guide.md ; MediaRecorder https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder ; OpenAI transcription (403 to the session, not re-verified) https://platform.openai.com/docs/api-reference/audio/createTranscription . Repo files read, none modified: `api/claude.js`, `api/openai.js`, `sdk/world/ai-agent.js`, `sdk/interaction/voice.js`, `tools/dev-server.mjs`, `mpbrowser.html`, `sdk/core/prop-hull.js`, `sdk/core/game-physics.js`, `sdk/core/glass.js`; memory note prop-collision-doctrine. No `_src/` folder exists for this topic.