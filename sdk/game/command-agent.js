/**
 * hopeOS — CommandAgent: voice/text -> Claude tool-use -> scene actions.
 * ═══════════════════════════════════════════════════════════════════════════
 * Turns "give me an apple in my hand" or "make the butterfly look for my hand"
 * into structured tool calls (tools.json) that a host page executes against
 * the live scene. Browser ES module, no dependencies, no build step; also runs
 * under Node >= 20 for the offline test (test-mock.mjs).
 *
 *   import { CommandAgent, loadTools } from './command-agent.js';
 *   const { tools, catalog } = await loadTools('./tools.json');
 *   const agent = new CommandAgent({ endpoint: '/api/claude', tools, catalog,
 *                                    executor: (name, input) => scene.exec(name, input) });
 *   agent.on('say',    ({ text }) => hud.say(text));
 *   agent.on('action', ({ name, input, result, ms }) => hud.log(name, input, result));
 *   agent.on('status', ({ state }) => hud.spinner(state === 'thinking'));
 *   await agent.command('give me an apple in my hand');
 *
 * Request shape follows the Claude Messages API as documented in the bundled
 * claude-api reference (skill build 2.1.266: typescript/claude-api/tool-use.md,
 * shared/tool-use-concepts.md, shared/models.md, shared/model-migration.md,
 * shared/prompt-caching.md, shared/error-codes.md) — public pages, re-checked
 * 2026-09-18 where marked (*):
 *   https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md      (*)
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md    (*)
 *   https://platform.claude.com/docs/en/build-with-claude/effort.md
 *   https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
 *   https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md
 *   https://platform.claude.com/docs/en/api/rate-limits.md
 *   https://platform.claude.com/docs/en/about-claude/models/migration-guide.md
 *
 * Rules baked in (do not "fix" them):
 *   · model 'claude-opus-5'; NO `thinking` key sent (thinking is adaptive by default
 *     on Opus 5) and NO budget_tokens (400 on Opus 4.7 and later); no temperature /
 *     top_p / top_k (rejected on this generation); output_config.effort 'low'.
 *   · tool_choice {type:'auto'} — never 'any' / 'tool' (forced tool use 400s on the
 *     Fable/Mythos 5.1 tier; unnecessary once tools are strict). Parallel tool use is
 *     left ON so "glowing butterfly that seeks my hand" is one round with 3 blocks.
 *   · every tool is strict:true (tools.json); tool inputs are objects (JSON.parse'd if
 *     a transport ever hands them over as a string), never string-matched out of prose.
 *   · stop_reason 'refusal' is checked BEFORE content is read and is never retried;
 *     HTTP 429 / 529 back off once, then the local grammar takes over.
 *   · when one response carries several tool_use blocks, ALL tool_result blocks go
 *     back in ONE user message, in the same order, each with its tool_use_id.
 *
 * Transport: the existing transparent proxy api/claude.js (read 2026-09-18): the
 * browser POSTs the raw Messages body, the server adds x-api-key and
 * anthropic-version 2023-06-01 and returns upstream.json() with upstream's HTTP
 * status. Consequences: no streaming through this proxy (it buffers .json()); the
 * retry-after header is NOT forwarded (only the JSON body is), so a 429 here uses a
 * fixed backoff; beta headers (e.g. server-side fallbacks for refusals) cannot be
 * added from the browser.
 */

export const MODEL = 'claude-opus-5';
export const DEFAULT_ENDPOINT = '/api/claude';
export const MAX_ROUNDS = 3;              // API calls per command (tool loop cap)

/** Mirror of tools.json "catalog" (kept here so the local grammar works with no fetch). */
export const CATALOG = {
  apple:      { natural_size_m: 0.08, flyer: false, synonyms: ['apple', 'fruit'] },
  ball:       { natural_size_m: 0.10, flyer: false, synonyms: ['ball', 'red ball', 'small ball', 'tennis ball'] },
  basketball: { natural_size_m: 0.24, flyer: false, synonyms: ['basketball', 'big ball', 'b-ball'] },
  butterfly:  { natural_size_m: 0.06, flyer: true,  synonyms: ['butterfly', 'moth'] },
  bird:       { natural_size_m: 0.15, flyer: true,  synonyms: ['bird', 'sparrow', 'robin', 'parrot'] },
  sword:      { natural_size_m: 0.90, flyer: false, synonyms: ['sword', 'blade', 'katana', 'lightsaber'] },
  cube:       { natural_size_m: 0.10, flyer: false, synonyms: ['cube', 'box', 'block', 'dice', 'die'] },
  glass_ball: { natural_size_m: 0.12, flyer: false, synonyms: ['glass ball', 'glass sphere', 'crystal ball', 'glass slime', 'slime', 'glass orb', 'orb'] },
};

/** Byte-identical copy of system-prompt.md (minus its HTML comment). test-mock.mjs asserts it. */
export const DEFAULT_SYSTEM = `You are the scene commander for hopeOS, a hand-tracked 3D layer running inside a video call. Participants speak short commands; you turn each one into tool calls on the live scene, then reply with at most one short sentence for the on-screen HUD (no markdown, no questions unless the command is truly impossible). Use the tools to act; do not describe what you would do.

Facts about this world. Treat them as physics, not preferences:

- Every object is a solid body with gravity and collision. Nothing floats, nothing is pinned to a hand, nothing passes through a hand.
- "In my hand" means the object is placed INTO the open palm so the hand supports it from underneath. The user can then close the hand to grip it, tilt the palm to drop it, throw it, pass it to another tile, or scale it by pinching with two hands. You never attach objects rigidly; the executor does the palm placement.
- Behaviors (seek_hand, orbit_hand, follow_gaze, flee_hand, land_on_hand) are continuous: they run until the next set_behavior on that object. idle stops them. Flyers (butterfly, bird) fly; ground objects roll or hop and still fall.
- Effects are cosmetic and temporary; they never change physics.
- Catalog kinds appear instantly: apple, ball, basketball, butterfly, bird, sword, cube, glass_ball. Map near-synonyms to them (box -> cube, crystal ball or slime -> glass_ball, moth -> butterfly). Any other object name is valid too (tennis ball, rubber duck, coffee mug): pass the plain noun as kind and a real 3D model is fetched; a labelled placeholder holds its place until it arrives. Colour goes in transform_object, never in the kind.

How to act:

- Use the fewest tool calls that fully satisfy the command, usually one. "Give me an apple" is one spawn_object with attach either_hand and size_m null. "Give me a glowing apple" is spawn_object followed by apply_effect with target "last", in the same response.
- Each command carries a scene snapshot (objects with ids, participants with tile positions, the speaker). Resolve targets from it: "it" / "that" is the most recent object (target "last"); a bare kind with several instances is the one nearest the speaker's hand. Call list_scene only when the snapshot cannot resolve the target.
- "Me" / "my hand" is the speaker in the snapshot. Other people are participant names (match them case-insensitively; transcripts arrive lowercased) or layout words (left, right, top, bottom) relative to the speaker's tile.
- Never invent ids. If a target does not exist, or no tool can express what was asked, say so in one sentence and call no tool.
- Defaults: attach either_hand; size_m null; physics default; params.hand either; speed, radius_m, participant, duration_s null.
- Reply text after tools: at most 12 words, present tense, plain. Examples: "Apple in your right hand." "Butterfly is looking for your hand." "Ball passed to Maya."`;

/** Fetch tools.json -> { tools, catalog }. */
export async function loadTools(url = new URL('./tools.json', import.meta.url).href) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('tools.json ' + r.status);
  const j = await r.json();
  return { tools: j.tools, catalog: j.catalog };
}

/** Fetch system-prompt.md and strip the HTML comments. */
export async function loadSystemPrompt(url = new URL('./system-prompt.md', import.meta.url).href) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('system-prompt.md ' + r.status);
  return stripComments(await r.text());
}
export function stripComments(md) { return String(md).replace(/<!--[\s\S]*?-->/g, '').trim(); }

export class AgentError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentError'; this.code = code; }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class CommandAgent extends EventTarget {
  /**
   * @param {Object} o
   * @param {string}   [o.endpoint='/api/claude']  transparent Messages proxy
   * @param {Array}    o.tools                     tools.json "tools" (strict definitions)
   * @param {Function} o.executor                  async (name, input) => result object { ok, ... }
   * @param {Object}   [o.catalog]                 tools.json "catalog" (defaults to CATALOG)
   * @param {string}   [o.system]                  system prompt text (defaults to DEFAULT_SYSTEM)
   * @param {string}   [o.model='claude-opus-5']   override only for a measured A/B (see NOTES.md)
   * @param {'auto'|'claude'|'local'} [o.mode]     auto = Claude, fall back to local grammar on failure
   * @param {number}   [o.maxRounds=3]             API calls per command
   * @param {number}   [o.maxTokens=1500]          hard cap on thinking + text; low-effort thinking + <=3 tool calls + 12 words
   * @param {number}   [o.historyTurns=3]          commands remembered (user+assistant text pairs)
   * @param {boolean}  [o.cache=true]              cache_control on the system block (caches tools+system)
   * @param {number}   [o.timeoutMs=20000]         per-request abort (a hung proxy must not hang the demo)
   * @param {string}   [o.speaker]                 default speaker id/name for the snapshot
   * @param {Function} [o.fetchImpl]               injectable fetch (tests)
   */
  constructor({ endpoint = DEFAULT_ENDPOINT, tools, executor, catalog, system, model = MODEL,
                mode = 'auto', maxRounds = MAX_ROUNDS, maxTokens = 1500, historyTurns = 3,
                cache = true, timeoutMs = 20000, speaker = null, fetchImpl } = {}) {
    super();
    if (!Array.isArray(tools) || !tools.length) throw new Error('CommandAgent: tools[] required (load tools.json)');
    if (typeof executor !== 'function') throw new Error('CommandAgent: executor(name, input) required');
    this.endpoint = endpoint;
    this.tools = tools;
    this.executor = executor;
    this.catalog = catalog || CATALOG;
    this.system = system || DEFAULT_SYSTEM;
    this.model = model;
    this.mode = mode;
    this.maxRounds = maxRounds;
    this.maxTokens = maxTokens;
    this.historyTurns = historyTurns;
    this.cache = cache;
    this.timeoutMs = timeoutMs;
    this.speaker = speaker;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.history = [];            // [{role:'user', content:text}, {role:'assistant', content:text}] pairs
    this.lastTarget = null;       // id of the most recently spawned object ("it")
    this.busy = false;
    this._pending = null;         // one-slot queue: newest command waits for the running one
    this._toolIndex = new Map(tools.map(t => [t.name, t]));
    this._synonyms = buildSynonyms(this.catalog);
  }

  /** Convenience: agent.on('say', fn) receives event.detail directly. Returns this. */
  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); return this; }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** What the HUD shows in an "about" line. */
  describe() {
    return { model: this.model, endpoint: this.endpoint, mode: this.mode,
             tools: this.tools.map(t => t.name), maxRounds: this.maxRounds };
  }

  /**
   * Run one spoken/typed command to completion.
   * Resolves { source:'claude'|'local', status:'ok'|'refused'|'error'|'nomatch'|'dropped',
   *            actions:[{name,input,result,ms}], say, rounds, ms, usage }.
   * Never throws for API/network trouble (emits 'error' and falls back); throws only on
   * programmer errors. While a command runs, a new one waits in a one-slot queue (the
   * newest wins; a displaced one resolves with status 'dropped') — VoiceCommander can
   * deliver a transcript every ~4 s, faster than a two-round command finishes.
   */
  async command(text, opts = {}) {
    text = String(text || '').trim();
    if (!text) return null;
    if (this.busy) {
      if (this._pending) this._pending.resolve({ source: 'queue', status: 'dropped', actions: [], say: '', rounds: 0, ms: 0 });
      this._emit('queued', { text });
      return new Promise(resolve => { this._pending = { text, opts, resolve }; });
    }
    this.busy = true;
    try {
      return await this._run(text, opts);
    } finally {
      this.busy = false;
      this._emit('status', { state: 'idle' });
      const p = this._pending; this._pending = null;
      if (p) this.command(p.text, p.opts).then(p.resolve, p.resolve);
    }
  }

  async _run(text, opts) {
    const t0 = now();
    this._emit('transcript', { text });
    if (this.mode !== 'local') {
      try {
        const r = await this._runClaude(text, opts);
        if (r.status === 'ok' || r.status === 'refused') {
          r.ms = now() - t0;
          this._emit('done', r);
          return r;
        }
        // r.status === 'fallback' -> continue to the local grammar
      } catch (e) {
        this._emit('error', { code: e.code || 'exception', message: e.message, phase: 'claude' });
        if (this.mode === 'claude') {
          const r = { source: 'claude', status: 'error', actions: [], say: '', rounds: 0, ms: now() - t0, error: e.message };
          this._emit('done', r);
          return r;
        }
      }
    }
    const r = await this._runLocal(text);
    r.ms = now() - t0;
    this._emit('done', r);
    return r;
  }

  // ── Claude path ────────────────────────────────────────────────────────────

  async _runClaude(text, opts) {
    const snapshot = await this._snapshot(opts.speaker || this.speaker);
    // Two text blocks: the command, then the compact live scene. The snapshot is
    // per-request content and sits AFTER the cached prefix (tools + system), so
    // it never breaks the cache. It lets most commands finish in ONE round.
    const userContent = [{ type: 'text', text }];
    if (snapshot) userContent.push({ type: 'text', text: 'Scene snapshot (JSON): ' + JSON.stringify(snapshot) });

    const messages = [...this.history, { role: 'user', content: userContent }];
    const actions = [];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let say = '', rounds = 0;

    for (let round = 0; round < this.maxRounds; round++) {
      rounds = round + 1;
      this._emit('status', { state: 'thinking', round: rounds });
      const body = {
        model: this.model,
        max_tokens: this.maxTokens,
        // system as a block array so cache_control can sit on it: a breakpoint on the
        // last system block caches tools + system together (render order is
        // tools -> system -> messages). Opus 5's cache minimum is 512 tokens; the
        // tools alone clear that.
        system: [{ type: 'text', text: this.system, ...(this.cache ? { cache_control: { type: 'ephemeral' } } : {}) }],
        tools: this.tools,
        tool_choice: { type: 'auto' },
        output_config: { effort: 'low' },
        // NOTE: no `thinking` key (adaptive by default on claude-opus-5), no budget_tokens,
        // no temperature/top_p/top_k (rejected on this generation).
        messages,
      };
      const { data, ms } = await this._post(body);
      for (const k of Object.keys(usage)) usage[k] += Number(data.usage?.[k] || 0);
      this._emit('round', { round: rounds, ms, stop_reason: data.stop_reason, usage: data.usage });
      this._emit('raw', { round: rounds, response: data });      // for recording fixtures

      // 1. refusal FIRST — content may be empty; never retry the same prompt.
      //    stop_details is populated only on refusal (category, explanation).
      if (data.stop_reason === 'refusal') {
        say = "I can't do that one.";
        this._emit('refusal', { text, stop_details: data.stop_details ?? null });
        this._emit('say', { text: say });
        return { source: 'claude', status: 'refused', actions, say, rounds, usage };
      }
      // 2. truncated output is a failed attempt, not something to parse.
      if (data.stop_reason === 'max_tokens') {
        this._emit('error', { code: 'max_tokens', message: 'response truncated at max_tokens ' + this.maxTokens, phase: 'claude' });
        return { source: 'claude', status: 'fallback', actions, say, rounds, usage };
      }

      const content = Array.isArray(data.content) ? data.content : [];

      // 3. pause_turn only occurs with server-side tools (none are declared here);
      //    the documented resume is to append the assistant turn and re-send.
      if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content }); continue; }

      const spoken = content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (spoken) { say = spoken; this._emit('say', { text: spoken }); }

      const toolUses = content.filter(b => b.type === 'tool_use');
      if (!toolUses.length) break;                                   // end_turn -> done

      messages.push({ role: 'assistant', content });                 // full content, tool_use ids intact
      this._emit('status', { state: 'executing', round: rounds, count: toolUses.length });
      const results = await this._execute(toolUses, actions);
      messages.push({ role: 'user', content: results });             // ALL results, one message, same order

      if (round === this.maxRounds - 1)
        this._emit('error', { code: 'round_cap', message: 'stopped after ' + this.maxRounds + ' rounds with tool calls pending', phase: 'claude' });
    }

    this._remember(text, say || summarize(actions));
    return { source: 'claude', status: 'ok', actions, say, rounds, usage };
  }

  /** POST the raw Messages body through the proxy; one backoff on 429 / 529. */
  async _post(body, attempt = 0) {
    const t0 = now();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : 0;
    let res;
    try {
      res = await this.fetch(this.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch (e) {
      throw new AgentError(e && e.name === 'AbortError' ? 'timeout' : 'network', e && e.message || String(e));
    } finally { clearTimeout(timer); }

    if (res.status === 429 || res.status === 529) {
      // 429 rate_limit_error and 529 overloaded_error are the documented retryable
      // statuses (the SDKs retry them with backoff). api/claude.js forwards the STATUS
      // but only the JSON body, not the retry-after header, so `ra` is normally NaN
      // here and the fixed backoff applies.
      const ra = Number(res.headers?.get?.('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : 2000 * (attempt + 1);
      this._emit('ratelimited', { status: res.status, wait, attempt });
      if (attempt >= 1) throw new AgentError('ratelimited', 'HTTP ' + res.status + ' twice');
      await sleep(wait);
      return this._post(body, attempt + 1);
    }
    let data;
    try { data = await res.json(); } catch { throw new AgentError('badjson', 'non-JSON response, HTTP ' + res.status); }
    // The proxy returns {error:{message}} for its own failures (405/500/502) and
    // forwards Anthropic's {type:'error', error:{type,message}} with upstream status.
    if (!res.ok || data.error) throw new AgentError(data.error?.type || ('http_' + res.status), data.error?.message || ('HTTP ' + res.status));
    return { data, ms: now() - t0 };
  }

  /**
   * Execute tool_use blocks IN ORDER (not Promise.all): a single response often
   * carries spawn_object followed by set_behavior/apply_effect on 'last', and the
   * executor resolves 'last' from what was just spawned.
   */
  async _execute(toolUses, actions) {
    const results = [];
    for (const tu of toolUses) {
      // Non-streaming responses deliver `input` as an object already. A streaming
      // transport must concatenate input_json_delta.partial_json and JSON.parse it
      // before reaching here. Either way the input is parsed, never regex'd from prose.
      let input = tu.input;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
      const t0 = now();
      let result;
      const problem = this._validate(tu.name, input);
      if (problem) result = { ok: false, error: problem };
      else {
        try { result = await this.executor(tu.name, input); }
        catch (e) { result = { ok: false, error: e && e.message || String(e) }; }
      }
      if (!result || typeof result !== 'object') result = { ok: true, value: result ?? null };
      if (result.ok !== false && tu.name === 'spawn_object' && result.id) this.lastTarget = result.id;
      if (result.ok !== false && tu.name === 'remove_object' && (input.target === 'all' || input.target === 'last' || input.target === this.lastTarget)) this.lastTarget = null;
      const ms = now() - t0;
      actions.push({ name: tu.name, input, result, ms });
      this._emit('action', { name: tu.name, input, result, ms, id: tu.id });
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        ...(result.ok === false ? { is_error: true } : {}),     // documented error signalling
      });
    }
    return results;
  }

  /** Compact scene for the user turn: ids, kinds, holders, behaviors, participants. */
  async _snapshot(speaker) {
    try {
      const s = await this.executor('list_scene', {});
      if (!s || typeof s !== 'object') return null;
      return {
        objects: (s.objects || []).map(o => ({ id: o.id, kind: o.kind, held_by: o.held_by ?? null, behavior: o.behavior ?? null })),
        participants: (s.participants || []).map(p => ({ id: p.id, name: p.name, tile: p.tile ?? null, hands: p.hands ?? null, goal: !!p.goal })),
        speaker: speaker ?? s.speaker ?? null,
        last: this.lastTarget,
      };
    } catch { return null; }
  }

  /**
   * Schema-lite check, defense in depth. strict:true already guarantees the API's
   * tool inputs match the schema; this also protects the local-grammar path and
   * any future non-strict transport. Returns a string problem or null.
   */
  _validate(name, input) {
    const t = this._toolIndex.get(name);
    if (!t) return 'unknown tool ' + name;
    return checkObject(t.input_schema || {}, input, '');
  }

  _remember(userText, assistantText) {
    if (!userText || !assistantText) return;                     // never store a dangling turn
    // Text-only pairs: a stored assistant turn with tool_use blocks would have to be
    // followed by matching tool_result blocks, and the blocks would bloat the
    // uncached suffix. The scene snapshot carries the state that matters.
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: assistantText });
    const max = this.historyTurns * 2;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  clearHistory() { this.history.length = 0; this.lastTarget = null; }

  // ── Local fallback grammar ─────────────────────────────────────────────────

  async _runLocal(text) {
    const actions = [];
    const plan = this.parseLocal(text);
    if (!plan) {
      const say = "Didn't catch that.";
      this._emit('error', { code: 'nomatch', message: 'no local grammar match', phase: 'local' });
      this._emit('say', { text: say });
      return { source: 'local', status: 'nomatch', actions, say, rounds: 0 };
    }
    this._emit('status', { state: 'executing', round: 0, count: plan.length });
    // Same executor, same ordering rule, same result shape as the Claude path —
    // the tool_use id is synthetic so the HUD can key on it.
    const fake = plan.map((a, i) => ({ id: 'local_' + Date.now().toString(36) + '_' + i, name: a.name, input: a.input }));
    await this._execute(fake, actions);
    const say = summarize(actions);
    this._emit('say', { text: say });
    this._remember(text, say);
    return { source: 'local', status: 'ok', actions, say, rounds: 0 };
  }

  /**
   * Regex grammar for the demo's most likely phrases (offline / no key / 429).
   * Returns [{name, input}] or null. Order matters: list, goal, remove, pass,
   * behavior, effect, transform are tested BEFORE spawn because "make the apple
   * bigger" also contains a spawn-ish verb, and goal before remove because
   * "clear the goal" is a goal command, not a removal.
   */
  parseLocal(raw) {
    const s = ' ' + String(raw).toLowerCase().replace(/[^a-z0-9#'.\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    const kind = this._findKind(s);
    const pronoun = /\b(it|that|this|them)\b/.test(s);
    const target = kind || (pronoun || this.lastTarget ? 'last' : null);
    const side = /\bleft\b/.test(s) ? 'left' : /\bright\b/.test(s) ? 'right' : 'either';
    const hasHand = /\bhands?\b/.test(s);

    // 1. list
    if (/\b(what('s| is) (in|on) (the )?scene|what do i have|list (the )?(scene|objects)|what objects|what's here)\b/.test(s))
      return [{ name: 'list_scene', input: {} }];

    // 2. goal (before remove: "clear the goal")
    if (/\bgoal\b/.test(s)) {
      if (/\b(no|clear|remove|cancel|reset) (the )?goal\b/.test(s)) return [{ name: 'designate_goal', input: { participant: 'none' } }];
      if (/\b(i'm|i am|me|my|mine)\b/.test(s)) return [{ name: 'designate_goal', input: { participant: 'me' } }];
      const lay = s.match(/\b(left|right|top|bottom)\b/);
      if (lay) return [{ name: 'designate_goal', input: { participant: lay[1] } }];
      const who = s.match(/\b(?:make|set|let|designate|switch(?: the goal)? to)\s+([a-z][a-z0-9]*)(?:'s)?\b/);
      if (who && !['the', 'a', 'me', 'my'].includes(who[1])) return [{ name: 'designate_goal', input: { participant: who[1] } }];
      return null;
    }

    // 3. remove / clear
    if (/\b(remove|delete|get rid of|clear|reset|take (it |that |them )?away|destroy|despawn)\b/.test(s)) {
      const all = /\b(everything|all|the scene|every)\b/.test(s) || (!kind && !pronoun);
      return [{ name: 'remove_object', input: { target: all ? 'all' : target } }];
    }

    // 4. pass / throw to someone: "pass the ball to maya", "throw it to the person on the left", "give sam the apple"
    const passTo = s.match(/\b(?:pass|throw|toss|send|give|hand|kick)\b.*?\b(?:to|over to|at)\s+(?:the\s+)?(?:person\s+(?:on\s+)?(?:the\s+)?)?([a-z][a-z0-9]*)\b/);
    if (passTo && target && !/\bmy hand/.test(s) && passTo[1] !== 'me')
      return [{ name: 'pass_object', input: { target, to_participant: passTo[1] } }];
    const giveX = s.match(/\b(?:give|hand|pass|throw|toss)\s+([a-z][a-z0-9]*)\s+(?:the|my|this|that|a|an)\b/);
    if (giveX && kind && !['me', 'us', 'it', 'them'].includes(giveX[1]))
      return [{ name: 'pass_object', input: { target: kind, to_participant: giveX[1] } }];

    // 5. behaviors (continuous)
    const P = { hand: side, speed: null, radius_m: null, participant: null };
    const beh =
      /\b(look for|looks for|find|seek|come to|go to|fly to|chase|come here|come to me|follow me)\b/.test(s) && !/\bwhere i look\b/.test(s) ? 'seek_hand' :
      /\b(land|perch|sit|rest|settle)\b/.test(s) && hasHand ? 'land_on_hand' :
      /\b(orbit|circle|fly around|go around|spin around|circle around)\b/.test(s) ? 'orbit_hand' :
      /\b(run away|fly away|flee|avoid|stay away|escape|keep away|scared of)\b/.test(s) ? 'flee_hand' :
      /\b(follow|watch|track|look) (where i look|my (eyes|gaze|face|head))\b/.test(s) ? 'follow_gaze' :
      /\b(stop moving|stay still|hold still|calm down|be still|freeze|idle|stay put|stop flying)\b/.test(s) ? 'idle' : null;
    if (beh && target) return [{ name: 'set_behavior', input: { target, behavior: beh, params: P } }];

    // 6. effects (checked before transform so "stop glowing" is an effect with duration 0)
    const eff = s.match(/\b(glow|glowing|shine|shiny|light up|sparkle|sparkles|sparkly|glitter|trail|confetti|celebrate|party|bounce|bouncing|hop)\b/);
    if (eff) {
      const effect = /glow|shin|light up/.test(eff[1]) ? 'glow' : /sparkl|glitter/.test(eff[1]) ? 'sparkle'
                   : /trail/.test(eff[1]) ? 'trail' : /confetti|celebrate|party/.test(eff[1]) ? 'confetti' : 'bounce';
      const stop = /\b(stop|no more|turn off|remove|cancel)\b/.test(s);
      const isSpawnToo = /\b(give me|hand me|i want|spawn|create|make me|put|place|add)\b/.test(s) && kind && !pronoun && !stop;
      if (isSpawnToo) {
        // "give me a glowing apple" -> spawn then effect on 'last'
        const spawn = this._spawnFrom(s, kind);
        return [spawn, { name: 'apply_effect', input: { target: 'last', effect, duration_s: null } }];
      }
      const t = (effect === 'confetti' && !kind && !pronoun) ? 'scene' : (target || 'scene');
      return [{ name: 'apply_effect', input: { target: t, effect, duration_s: stop ? 0 : null } }];
    }

    // 7. transform: size / colour
    const scale =
      /\b(much bigger|huge|giant|enormous)\b/.test(s) ? 2.5 :
      /\b(twice|double|2x|two times)\b/.test(s) ? 2 :
      /\b(triple|three times|3x)\b/.test(s) ? 3 :
      /\b(bigger|larger|grow|enlarge|big)\b/.test(s) ? 1.5 :
      /\b(half|halve)\b/.test(s) ? 0.5 :
      /\b(tiny|teeny|mini)\b/.test(s) ? 0.35 :
      /\b(smaller|shrink|small|little)\b/.test(s) ? 0.67 : null;
    const abs = s.match(/(\d+(?:\.\d+)?)\s*(cm|centimet\w*|mm|millimet\w*|m|met\w*|in|inch\w*|ft|feet|foot)\b/);
    const size_m = abs ? toMetres(parseFloat(abs[1]), abs[2]) : null;
    const color = this._findColor(s);
    const isTransformVerb = /\b(make|turn|paint|colou?r|set|scale|resize|change)\b/.test(s);
    const isSpawnVerb = /\b(give me|hand me|i want|i'd like|i would like|can i have|spawn|create|make me|put|place|add|drop)\b/.test(s);
    if ((scale || size_m || color) && isTransformVerb && !isSpawnVerb && target)
      return [{ name: 'transform_object', input: { target, scale: size_m ? null : scale, color, size_m } }];

    // 8. spawn (last: "give me a big red apple in my left hand")
    if (isSpawnVerb && kind) {
      const spawn = this._spawnFrom(s, kind, { scale, size_m });
      return color ? [spawn, { name: 'transform_object', input: { target: 'last', scale: null, color, size_m: null } }] : [spawn];
    }
    return null;
  }

  _spawnFrom(s, kind, { scale = null, size_m = null } = {}) {
    const attach = /\bleft hand\b/.test(s) ? 'left_hand' : /\bright hand\b/.test(s) ? 'right_hand'
                 : /\btable\b|\bfloor\b|\bground\b/.test(s) ? 'table'
                 : /\bin front\b|\bhere\b|\bfront of me\b/.test(s) ? 'world_front' : 'either_hand';
    const physics = /\bbouncy\b/.test(s) ? 'bouncy' : /\bheavy\b/.test(s) ? 'heavy' : /\b(light|floaty)\b/.test(s) ? 'light' : 'default';
    const natural = (this.catalog[kind] || {}).natural_size_m || 0.1;
    const size = size_m != null ? size_m : (scale ? +(natural * scale).toFixed(3) : null);
    return { name: 'spawn_object', input: { kind, size_m: size, attach, physics } };
  }

  _findKind(s) {
    for (const [syn, kind] of this._synonyms) if (s.includes(' ' + syn + ' ') || s.includes(' ' + syn + 's ')) return kind;
    return null;
  }

  _findColor(s) {
    const hex = s.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/);
    if (hex) return '#' + hex[1];
    const m = s.match(/\b(red|orange|yellow|green|blue|purple|pink|white|black|gold|golden|silver|brown|gr[ae]y|cyan|magenta|teal|lime|violet|turquoise|navy)\b/);
    return m ? (m[1] === 'golden' ? 'gold' : m[1]) : null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal JSON-schema check: required, enum, additionalProperties:false, nested objects, anyOf null. */
function checkObject(schema, value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return (path || 'input') + ' is not an object';
  for (const k of schema.required || []) if (!(k in value)) return 'missing ' + path + k;
  for (const [k, v] of Object.entries(value)) {
    const p = schema.properties?.[k];
    if (!p) return 'unexpected field ' + path + k;
    if (p.enum && !p.enum.includes(v)) return path + k + ' must be one of ' + p.enum.join('|');
    if (p.type === 'object') { const r = checkObject(p, v, path + k + '.'); if (r) return r; }
    else if (p.anyOf) {
      const okTypes = p.anyOf.map(a => a.type);
      const t = v === null ? 'null' : typeof v;
      if (!okTypes.includes(t)) return path + k + ' must be ' + okTypes.join('|');
    } else if (p.type && v !== null && typeof v !== p.type && !(p.type === 'integer' && typeof v === 'number')) return path + k + ' must be ' + p.type;
  }
  return null;
}

/** Longest synonym first so "glass ball" beats "ball" and "basketball" beats "ball". */
function buildSynonyms(catalog) {
  const out = [];
  for (const [kind, c] of Object.entries(catalog)) for (const syn of (c.synonyms || [kind])) out.push([syn, kind]);
  out.push(...Object.keys(catalog).map(k => [k.replace(/_/g, ' '), k]));
  return out.sort((a, b) => b[0].length - a[0].length);
}

function toMetres(v, unit) {
  if (/^cm/.test(unit) || /^centimet/.test(unit)) return v / 100;
  if (/^mm/.test(unit) || /^millimet/.test(unit)) return v / 1000;
  if (/^in/.test(unit)) return v * 0.0254;
  if (/^f/.test(unit)) return v * 0.3048;
  return v;
}

/** One HUD line from executed actions (local path, or Claude path with no text). */
export function summarize(actions) {
  if (!actions.length) return 'Done.';
  const bits = actions.map(a => {
    const r = a.result || {};
    if (r.ok === false) return a.name + ' failed: ' + (r.error || 'unknown');
    switch (a.name) {
      case 'spawn_object':     return (r.kind || a.input.kind) + ' ' + placeWord(a.input.attach) + (r.hand ? ' (' + r.hand + ')' : '');
      case 'set_behavior':     return a.input.target + ' -> ' + a.input.behavior.replace(/_/g, ' ');
      case 'apply_effect':     return a.input.effect + (a.input.duration_s === 0 ? ' off' : '') + ' on ' + a.input.target;
      case 'transform_object': return a.input.target + (a.input.color ? ' -> ' + a.input.color : '') + (a.input.scale ? ' x' + a.input.scale : '') + (a.input.size_m ? ' -> ' + a.input.size_m + ' m' : '');
      case 'remove_object':    return 'removed ' + a.input.target;
      case 'pass_object':      return a.input.target + ' passed to ' + a.input.to_participant;
      case 'designate_goal':   return 'goal: ' + a.input.participant;
      case 'list_scene':       return (r.objects ? r.objects.length : 0) + ' objects';
      default:                 return a.name;
    }
  });
  return bits.join('; ') + '.';
}
function placeWord(attach) {
  return { left_hand: 'in your left hand', right_hand: 'in your right hand', either_hand: 'in your hand', world_front: 'in front of you', table: 'on the table' }[attach] || '';
}
