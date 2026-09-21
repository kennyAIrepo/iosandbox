# CommandAgent — engineering notes (2026-09-18, finisher pass)

Carried over from the first (interrupted) research pass and updated against the
newer code in this folder (the second pass added a one-slot queue, a per-request
timeout, `raw` fixture events, `describe()`, stronger tool descriptions and a
114-assertion test).

Voice/text -> Claude tool-use -> scene actions for the hopeOS Teams demo.
Files in this folder:

| File | What |
|---|---|
| `command-agent.js` | Browser ES module. `class CommandAgent({ endpoint, tools, executor, catalog, system, mode, model, maxRounds, maxTokens, historyTurns, cache, timeoutMs, speaker, fetchImpl })`, `await agent.command(text)`; 3-round tool loop; rolling history; one-slot queue (newest wins, a displaced command resolves `status:'dropped'`); 20 s abort per request; `EventTarget` events `transcript / status / queued / round / raw / action / say / refusal / ratelimited / error / done`; `describe()` for a HUD about-line; local regex fallback grammar. |
| `tools.json` | 8 strict tools (spawn_object, set_behavior, apply_effect, transform_object, remove_object, pass_object, designate_goal, list_scene) + spawnable catalog (apple, ball, basketball, butterfly, bird, sword, cube, glass_ball). Descriptions carry the trigger phrases ("call this for 'make it glow'...") and say `last` also resolves to an object created earlier in the same response. |
| `system-prompt.md` | The system text (doctrine stated as facts; 12-word reply cap; "Use the tools to act"). Its HTML comment explains each choice with the source. `DEFAULT_SYSTEM` in the JS is a byte-identical mirror (asserted by the test). |
| `mock-executor.js` | `MockScene`: in-memory executor implementing every tool; header comment maps each tool onto the real mpbrowser/sdk hooks. |
| `push-to-talk.js` | `PushToTalk`: MediaRecorder start/stop -> `/api/openai` -> `agent.command()`; `arm()`, `bindKey(' ')`, `bindButton(el)`, wake-word gate sketch. Also shows the keep-VoiceCommander wiring. |
| `test-mock.mjs` | `node test-mock.mjs` — 114 offline assertions with a stubbed `fetch` (no key, no network); 14 sections [0]..[J]. Passed 114/114 on 2026-09-18 (Node 25.2.1). |

## 1. Request shape (what the module sends and why)

Sent through the existing transparent proxy `C:/Users/hanna/iosandbox/api/claude.js` (browser POSTs the raw Messages body; the server adds `x-api-key` and `anthropic-version: 2023-06-01`, returns `upstream.json()` with upstream's status):

```json
{
  "model": "claude-opus-5",
  "max_tokens": 1500,
  "system": [{ "type": "text", "text": "<system-prompt.md>", "cache_control": { "type": "ephemeral" } }],
  "tools": [ "...tools.json, every one strict:true..." ],
  "tool_choice": { "type": "auto" },
  "output_config": { "effort": "low" },
  "messages": [
    "...≤3 prior (user text, assistant text) pairs...",
    { "role": "user", "content": [
      { "type": "text", "text": "give me an apple in my hand" },
      { "type": "text", "text": "Scene snapshot (JSON): {\"objects\":[...],\"participants\":[...],\"speaker\":\"p1\"}" } ] }
  ]
}
```

Rules followed, with the source for each:

- `claude-opus-5`, $5 / $25 per MTok, thinking on by default (omit `thinking` = adaptive), `refusal` stop reason possible, 512-token cache minimum — bundled reference `shared/models.md`; public: https://platform.claude.com/docs/en/about-claude/models/overview.md
- No `budget_tokens` (400 on Opus 4.7 and later; use `output_config.effort`) — `shared/model-migration.md`; public: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking.md
- `output_config.effort: "low"`: cheapest/fastest rung; "low gave up 1-3 points for a third to a half off cost per task" on Anthropic's knowledge-work runs — `shared/cost-optimization.md`; public: https://platform.claude.com/docs/en/build-with-claude/effort.md
- `tool_choice: auto` only. Forced `any`/`tool` is rejected on the Fable/Mythos 5.1 tier and unnecessary once tools are strict — `shared/tool-use-concepts.md`; public: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md
- `strict: true` + `additionalProperties: false` + `required` on every tool; strict schemas reject `minimum`/`maximum`/`minLength`, so every numeric clamp lives in the executor and ranges are in descriptions — `shared/tool-use-concepts.md` § Structured Outputs; public: https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md
- Check `stop_reason === "refusal"` BEFORE reading `content` (content may be empty; do not retry the same prompt) — `shared/model-migration.md` § Opus 5; public: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- Treat `stop_reason === "max_tokens"` as a failed attempt, not something to parse — `shared/cost-optimization.md`
- All `tool_result` blocks for one response go back in ONE user message, `tool_use_id` matched — `shared/tool-use-concepts.md` § Handling Tool Results
- 429 / 529 are retryable; the SDK would retry with backoff (`max_retries=2`) — `shared/error-codes.md`; public: https://platform.claude.com/docs/en/api/rate-limits.md. We are not using the SDK (raw fetch through the proxy), so `_post()` backs off once (2 s, then 4 s) and then falls back to the local grammar.
- `cache_control` on the system block caches tools + system (prefix order is tools -> system -> messages); 5-minute TTL; reads ~0.1x, writes 1.25x; breakpoint sits BEFORE the per-command snapshot so the snapshot never invalidates it — `shared/prompt-caching.md`; public: https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md

Tool inputs arrive as objects in the non-streaming response and are passed straight to the executor after a schema-lite check (`_validate`). A streaming variant must concatenate `input_json_delta.partial_json` and `JSON.parse` it; nothing is ever regex'd out of prose (the local grammar regexes the USER's words, never the model's).

## 2. Latency budget (estimates; nothing here was measured against a live key)

The module instruments every stage so the demo number comes from the HUD, not from this table: `round` event = ms per API call + `usage`, `action` event = executor ms, `done` event = end-to-end ms, and `PushToTalk` reports `{ heldMs, sttMs }`.

| Stage | Push-to-talk path | VoiceCommander (4 s chunks) | Local grammar |
|---|---|---|---|
| Wait for audio to close | 0 (key-up) | avg ~2.1 s, worst ~4.2 s (`interval: 4000` + 200 ms gap, `sdk/interaction/voice.js`) | same as left |
| Speech-to-text (`gpt-4o-transcribe` via `/api/openai`) | ~0.5-1.5 s for a 2-3 s clip (unmeasured) | same | same |
| Claude round 1 (Opus 5, effort low, ~2.9k cached input, ~150-400 output tokens incl. brief thinking, non-streaming) | ~1.5-3 s (unmeasured) | same | <1 ms |
| Claude round 2 (only if the model calls `list_scene` first or a tool errors) | +1-2.5 s | same | n/a |
| Executor (spawn into palm pocket, same frame) | <16 ms | same | same |
| Speech-end -> apple in hand | **~2-4.5 s** | **~4.5-9 s** | **~0.5-1.5 s** |

Design choices that keep it to one round: the compact scene snapshot rides in the user turn so "it", "the butterfly" and participant names resolve without a `list_scene` call; the system prompt says "usually one tool call"; effort low trims thinking. Vercel serverless cold starts add an unmeasured extra on the first call; a `max_tokens: 0` keep-alive every ~4 minutes keeps the prompt cache warm (`shared/prompt-caching.md` § Pre-warming) if idle gaps between commands exceed 5 minutes.

The proxy buffers `upstream.json()`, so streaming is impossible without changing `api/claude.js`; for a tool-use turn that costs little — the `tool_use` block is complete only at the end anyway.

Experiment worth running once a key is available: the same prompt on `claude-sonnet-5` and `claude-haiku-4-5` (the cost guide's step-down method: sweep effort on the current model, then drop one tier and re-check against an eval — `shared/cost-optimization.md` § 2.7). The module takes `model` as a constructor option for exactly that; the pinned default stays `claude-opus-5` per the API rules for this task.

## 3. Cost per command

Prices (bundled `shared/models.md`, public https://platform.claude.com/docs/en/pricing.md): Opus 5 $5/MTok input, $25/MTok output; cache read ~0.1x ($0.50/MTok), cache write 1.25x ($6.25/MTok, 5-min TTL).

Token estimate (chars/4, measured on these files): tools ≈ 2,200, system ≈ 660 -> cached prefix ≈ 2,900; uncached suffix (history ≤ 3 pairs + command + snapshot) ≈ 200-400; output ≈ 150-400 (tool JSON ~60, HUD text ~15, the rest adaptive thinking at effort low — thinking is billed as output).

| Scenario | Input | Output | ≈ cost |
|---|---|---|---|
| Warm cache, 1 round | 2,900 cached ($0.0015) + 300 fresh ($0.0015) | 250 ($0.0063) | **~$0.009** |
| Warm cache, 2 rounds | + 2,900 cached + 450 fresh ($0.0037) | + 60 ($0.0015) | **~$0.015** |
| Cold cache (first command after 5 min idle) | 2,900 written ($0.018) + 300 | 250 | **~$0.026** |

So roughly 1-1.5 cents per command warm, ~2.5 cents cold; a 20-minute demo with 40 commands ≈ $0.50-0.80; 1,000 commands ≈ $10-15. Verify with `usage` from the `done` event — `cache_read_input_tokens` should equal the prefix on every command after the first.

## 4. Testing without a key

1. **Unit / loop:** `node test-mock.mjs` (Node 25 on this machine; needs Node >= 20 for global `fetch`/`Response`). Stubs `fetch` with canned Messages responses and asserts: request shape (model, effort, tool_choice, strict tools, no thinking/budget_tokens/sampling params, cache_control, snapshot attached); tool_result echo with matching ids; three parallel `tool_use` blocks -> three results in one user message in order, executed sequentially so `last` resolves to the just-spawned object; refusal -> no executor call, no retry; 429 -> one backoff then success; network throw / proxy 500 / `max_tokens` -> local grammar; round cap 3; executor `ok:false` -> `is_error:true`; hung proxy -> `timeoutMs` abort -> local grammar; two commands issued while one runs -> `queued` events and the older one resolves `dropped`; a `raw` event per round; 34 grammar phrases incl. lowercase participant names, glowing/red apple = two actions, chit-chat and off-catalog kinds -> no tool. Currently 114/114 (2026-09-18, Node 25.2.1).
2. **Browser, no server at all:** `new CommandAgent({ mode: 'local', tools, executor: scene.executor })` — the HUD, hands and physics run with the regex grammar. `mode: 'auto'` (default) does the same automatically whenever `/api/claude` is unreachable.
3. **Local dev server:** `tools/dev-server.mjs` serves static files and `POST /journal` only — there is no `/api/*` route, so on `http://localhost:3333` the Claude path 404s and the agent falls back to local. To exercise the real path locally either run the Vercel CLI dev server (not verified in this session) or add a ~20-line route to `dev-server.mjs` that mirrors `api/claude.js` (reads `ANTHROPIC_API_KEY` from the environment). Not done here: this task does not modify `iosandbox`.
4. **Fixtures from real traffic:** `agent.on('raw', ({ round, response }) => ...)` exposes every live Messages response so real traffic can be recorded as new canned cases for `test-mock.mjs`.
5. **Mock scene as the game's contract:** `MockScene.exec()` is the reference for result shapes (`{ ok, id, kind, hand, held_by }` etc.). The real executor in `mpbrowser.html` should return the same keys so the HUD and the model's follow-ups (`last`) keep working.

## 5. Voice path

Keep `VoiceCommander` (`sdk/interaction/voice.js`); it already calls `onTranscript(lowercasedText)` BEFORE its regex registry, so the wiring is one line and no regex commands need registering:

```js
import { VoiceCommander } from '/sdk/interaction/voice.js';
const vc = new VoiceCommander('', { interval: 4000, onTranscript: t => agent.command(t) });
await vc.start();
```

Its 4-second chunking is the single biggest latency item (see § 2) and splits phrases spoken across a boundary. `push-to-talk.js` is the alternative: hold SPACE (or a HUD button with pointer capture) -> `MediaRecorder.start()`; release -> `.stop()` -> one blob -> the same `/api/openai` wire protocol (`application/octet-stream` body, `x-audio-type`, `x-model`, `x-language` headers, verified in `api/openai.js`) -> `agent.command(text)`. Blobs under 2.5 KB (`minBytes`) are treated as taps (VoiceCommander's own threshold is 4000 bytes), and a 12 s safety stop covers a stuck key. The OpenAI transcription reference page returned 403 to the research session, so `gpt-4o-transcribe` is taken from `voice.js`/`api/openai.js` as-is; `whisper-1` is the fallback name if it 400s. MediaRecorder: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder; upstream endpoint: https://platform.openai.com/docs/api-reference/audio/createTranscription.

A wake word (`hey hope, ...`) gate is sketched at the bottom of `push-to-talk.js` for the always-on mode so table talk in a call does not spawn apples.

## 6. Executor contract and doctrine enforcement

`executor(name, input) -> Promise<{ ok: boolean, ...}>` (throwing is also handled; `ok:false` becomes `is_error:true` on the `tool_result`). `spawn_object` must return `id` so the agent's `lastTarget` and the model's follow-ups work. `list_scene` is also called by the agent before every Claude request to build the snapshot; keep it cheap and synchronous-ish. Because VoiceCommander can deliver a transcript every ~4 s, faster than a two-round command finishes, `command()` runs one command at a time and keeps only the newest waiting one (the displaced one resolves `status:'dropped'`).

The doctrine (memory: prop-collision-doctrine, 2026-09-15) lives in two places: as facts in the system prompt (so the model never asks for a pinned object) and in the executor (the only place that can actually enforce it). The mapping in `mock-executor.js`'s header: palm frame from the `_palmPose` basis in `mpbrowser.html`, seat at the pocket point, let gravity + the cradle block (~L1633) hold it; collision via `PropHull` (`sdk/core/prop-hull.js`) or the sphere/OBB bodies in `sdk/core/game-physics.js`; NEVER `GrabbableSphere` jointsWithin/pinch grab or gravity-off seek. Behaviors follow the `ENG_MINDS`/`engMindSet`/`engMindTick` pattern already in `mpbrowser.html` (greeter ≈ seek, skittish ≈ flee).

Tool inputs are model output: clamp `size_m` 0.02-2 m and `scale` 0.1-10x, resolve `target` only against known ids/kinds, set colours through `THREE.Color.set(css)` and ignore failures, never `eval`. Consider a HUD confirm for `remove_object { target: 'all' }` in shared sessions. `pass_object` runs on the speaker's client only; the executor is where the state change gets relayed to the other tiles (game/ and acs/ research folders).

## 7. Findings about the existing code (read-only)

- `api/claude.js` forwards upstream's STATUS but only the JSON body: no `retry-after` header reaches the browser (hence the fixed backoff), no streaming (`upstream.json()`), no way to add beta headers — so `fallbacks: "default"` for refusals (needs `server-side-fallback-2026-07-01`) cannot be used through it as-is.
- `sdk/world/ai-agent.js` (`WorldAgent`) pins `claude-opus-4-8` (build) / `claude-sonnet-4-6` (converse), uses no `strict`, no `tool_choice`, no `output_config`, no refusal / 429 handling, runs tools with `Promise.all` (fine for its independent edit tools, wrong for spawn -> behavior dependencies), and loops up to 16 rounds x 8,000 tokens in build mode. Its conventions that were copied: `/api/claude` proxy + `fetch` with a raw body, `data.error` surfaced as a message, full `content` pushed back as the assistant turn, `tool_result.content` as a string. The new module deliberately differs on everything in § 1.
- `sdk/interaction/voice.js` has no wake word and no push-to-talk; `onTranscript` fires before the regex pass with lowercased text.
- `tools/dev-server.mjs` has no `/api` route.

## 8. Open questions

- Real latency and `usage.output_tokens` (thinking share) for Opus 5 at effort low on this exact prompt — needs a key; the events are there to measure.
- Whether `strict` schemas using `anyOf: [{type:'number'},{type:'null'}]` compile on the first request without complaint (the docs list `anyOf` and `null` as supported; first use of a schema has a one-time compilation cost and a 24-hour cache).
- Where participant display names come from inside a Teams tile (ACS / meeting-app research) so the snapshot can carry them.
- Whether the demo wants always-on listening with a wake word, or push-to-talk only.
- The `pause_turn` branch (append assistant turn, re-send) exists but is only reachable with server-side tools, which this module never declares; it is untested.

## 9. Relation to the other topics

- The Teams twin page (`teams-twin` topic) instantiates one `CommandAgent` per local client with `speaker` = the local participant id and the real scene executor; `pass_object` / `designate_goal` results feed the relay (`game` topic) so the other tiles see the state change.
- The ~600 B landmark packets at 30 Hz from the memo are unrelated to this module; commands are rare (one every few seconds) and can ride a separate reliable channel.
- Nothing here edits `mpbrowser.html` or the rig pipeline (FROZEN); `mock-executor.js` cites the line numbers to copy from.
