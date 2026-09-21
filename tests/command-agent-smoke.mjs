/**
 * Offline test for CommandAgent: no API key, no network, no browser.
 *   node tests/command-agent-smoke.mjs
 * Stubs fetch with canned Messages-API responses and asserts the request shape
 * (model, effort, tool_choice, strict tools, no thinking/budget_tokens/sampling),
 * the loop rules (all tool_results in one message, in order; refusal before content;
 * 429 backoff; max_tokens -> fallback; round cap), the one-slot queue, that
 * DEFAULT_SYSTEM mirrors system-prompt.md, and the local fallback grammar coverage.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CommandAgent, DEFAULT_SYSTEM, stripComments } from '../sdk/game/command-agent.js';
import { MockScene } from './_mock-executor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const toolsJson = readFileSync(join(here, '..', 'sdk', 'game', 'tools.json'), 'utf8');
const { tools, catalog } = JSON.parse(toolsJson);
const systemMd = readFileSync(join(here, '..', 'sdk', 'game', 'system-prompt.md'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok  ' + name + ' ' + extra); } else { fail++; console.error('  FAIL ' + name + ' ' + extra); } };

// ── canned API responses ─────────────────────────────────────────────────────
const msg = (content, stop_reason = 'end_turn', extra = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 2300, output_tokens: 120, cache_read_input_tokens: 2100, cache_creation_input_tokens: 0 }, ...extra,
});
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = t => ({ type: 'text', text: t });

/** fetch stub: a queue of {status, body, headers, throw, delay}; records every request body. */
function makeFetch(queue, sent) {
  return async (url, init) => {
    sent.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error('fetch stub exhausted');
    if (next.delay) await new Promise(r => setTimeout(r, next.delay));
    if (next.throw) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(next.body), { status: next.status || 200, headers: next.headers || { 'content-type': 'application/json' } });
  };
}
function agentWith(queue, extra = {}) {
  const sent = [], scene = new MockScene(), events = [];
  const agent = new CommandAgent({ tools, catalog, executor: scene.executor, fetchImpl: makeFetch(queue, sent), ...extra });
  for (const ev of ['say', 'action', 'refusal', 'error', 'ratelimited', 'done', 'status', 'round', 'raw', 'queued']) agent.on(ev, d => events.push([ev, d]));
  return { agent, scene, sent, events };
}

// ── 0. static checks ─────────────────────────────────────────────────────────
console.log('\n[0] static');
{
  ok(stripComments(systemMd) === DEFAULT_SYSTEM, 'DEFAULT_SYSTEM is byte-identical to system-prompt.md minus comments');
  ok(tools.length === 8 && tools.map(t => t.name).join() === 'spawn_object,set_behavior,apply_effect,transform_object,remove_object,pass_object,designate_goal,list_scene', 'eight tools in tools.json');
  const walk = (s, p) => { if (!s || typeof s !== 'object') return true; if (s.type === 'object' && s.additionalProperties !== false) { console.error('    missing additionalProperties:false at ' + p); return false; } if (s.type === 'object' && !Array.isArray(s.required)) return false; return Object.values(s.properties || {}).every((v, i) => walk(v, p + '.' + Object.keys(s.properties)[i])); };
  ok(tools.every(t => t.strict === true && walk(t.input_schema, t.name)), 'every tool strict:true, every object additionalProperties:false + required (nested too)');
  ok(tools.every(t => Object.keys(t.input_schema.properties).every(k => t.input_schema.required.includes(k))), 'required lists EVERY property (strict rule)');
  ok(!/"minimum"|"maximum"|"minLength"|"maxLength"|"multipleOf"/.test(toolsJson), 'no unsupported numeric/string constraints in schemas');
  const est = Math.round((JSON.stringify(tools).length + DEFAULT_SYSTEM.length) / 4);
  console.log('    prefix estimate (chars/4): tools ' + Math.round(JSON.stringify(tools).length / 4) + ' + system ' + Math.round(DEFAULT_SYSTEM.length / 4) + ' = ~' + est + ' tokens (+286 tool-use system prompt on Opus 5)');
  ok(est > 512, 'cached prefix clears the 512-token Opus 5 cache minimum', '~' + est);
}

// ── A. one-round spawn: request shape + tool_result echo ─────────────────────
console.log('\n[A] give me an apple in my hand');
{
  const { agent, scene, sent, events } = agentWith([
    { body: msg([toolUse('tu_1', 'spawn_object', { kind: 'apple', size_m: null, attach: 'either_hand', physics: 'default' })], 'tool_use') },
    { body: msg([text('Apple in your left hand.')]) },
  ]);
  const r = await agent.command('give me an apple in my hand');
  const req = sent[0];
  ok(req.model === 'claude-opus-5', 'model claude-opus-5');
  ok(req.output_config && req.output_config.effort === 'low', 'output_config.effort low');
  ok(req.tool_choice && req.tool_choice.type === 'auto' && !('disable_parallel_tool_use' in req.tool_choice), 'tool_choice auto, parallel tool use left on');
  ok(!('thinking' in req) && JSON.stringify(req).indexOf('budget_tokens') < 0, 'no thinking / budget_tokens');
  ok(!('temperature' in req) && !('top_p' in req) && !('top_k' in req), 'no sampling params');
  ok(req.max_tokens === 1500, 'max_tokens 1500 (thinking + text cap)');
  ok(req.tools.every(t => t.strict === true), 'tools sent strict');
  ok(Array.isArray(req.system) && req.system[0].cache_control && req.system[0].cache_control.type === 'ephemeral', 'cache_control on system block (caches tools+system)');
  ok(Array.isArray(req.messages[0].content) && req.messages[0].content[1].text.startsWith('Scene snapshot'), 'scene snapshot attached to user turn');
  ok(scene.calls.some(c => c.name === 'spawn_object' && c.input.kind === 'apple'), 'executor ran spawn_object');
  const second = sent[1];
  ok(second.messages.length === 3 && second.messages[1].role === 'assistant' && second.messages[2].role === 'user', 'assistant turn + tool_result turn appended');
  const tr = second.messages[2].content[0];
  ok(tr.type === 'tool_result' && tr.tool_use_id === 'tu_1' && JSON.parse(tr.content).ok === true && !('is_error' in tr), 'tool_result echoes tool_use_id, JSON content, no is_error');
  ok(r.status === 'ok' && r.source === 'claude' && r.rounds === 2 && r.say === 'Apple in your left hand.', 'result ok, 2 rounds, say text', JSON.stringify({ rounds: r.rounds, say: r.say }));
  ok(agent.lastTarget === 'apple_1', 'lastTarget tracks spawned id');
  ok(agent.history.length === 2 && agent.history[0].content === 'give me an apple in my hand' && typeof agent.history[1].content === 'string', 'rolling history stored as text pair');
  ok(r.usage.cache_read_input_tokens === 4200, 'usage accumulated across rounds');
  ok(events.filter(([e]) => e === 'raw').length === 2, 'raw event per round (fixture recording)');
}

// ── B. parallel tool_use: all results, one user message, in order ────────────
console.log('\n[B] give me a glowing butterfly that looks for my hand (3 tool_use in one response)');
{
  const { agent, scene, sent } = agentWith([
    { body: msg([
        toolUse('tu_a', 'spawn_object', { kind: 'butterfly', size_m: null, attach: 'either_hand', physics: 'light' }),
        toolUse('tu_b', 'set_behavior', { target: 'last', behavior: 'seek_hand', params: { hand: 'either', speed: null, radius_m: null, participant: null } }),
        toolUse('tu_c', 'apply_effect', { target: 'last', effect: 'glow', duration_s: null }),
      ], 'tool_use') },
    { body: msg([text('Butterfly is looking for your hand.')]) },
  ]);
  await agent.command('give me a glowing butterfly that looks for my hand');
  const results = sent[1].messages[2].content;
  ok(results.length === 3 && results.map(r => r.tool_use_id).join() === 'tu_a,tu_b,tu_c', 'all 3 tool_results in ONE user message, same order');
  ok(scene.calls.map(c => c.name).filter(n => n !== 'list_scene').join() === 'spawn_object,set_behavior,apply_effect', 'executed sequentially in order');
  const bf = scene.objects.get('butterfly_1');
  ok(bf && bf.behavior && bf.behavior.kind === 'seek_hand' && bf.effects.includes('glow'), '"last" resolved to the just-spawned butterfly');
}

// ── B2. executor error -> is_error:true tool_result ─────────────────────────
console.log('\n[B2] executor error -> is_error');
{
  const { agent, sent } = agentWith([
    { body: msg([toolUse('tu_e', 'set_behavior', { target: 'apple', behavior: 'orbit_hand', params: { hand: 'either', speed: null, radius_m: null, participant: null } })], 'tool_use') },
    { body: msg([text('There is no apple yet.')]) },
  ]);
  await agent.command('make the apple orbit my hand');
  const tr = sent[1].messages[2].content[0];
  ok(tr.is_error === true && /no such object/.test(JSON.parse(tr.content).error), 'is_error:true with the executor message');
  const bad = agent._validate('spawn_object', { kind: 'dragon', size_m: null, attach: 'either_hand', physics: 'default' });
  ok(bad === null, 'schema-lite accepts a free-text kind (B4: off-catalog words are fetched as 3D models)');
  ok(agent._validate('set_behavior', { target: 'x', behavior: 'idle', params: { hand: 'left', speed: null, radius_m: null } }) === 'missing params.participant', 'schema-lite checks nested required');
}

// ── C. refusal: checked before content, no executor call, no retry ───────────
console.log('\n[C] refusal');
{
  const { agent, scene, sent, events } = agentWith([
    { body: msg([], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: null } }) },
  ]);
  const r = await agent.command('give me a sword');
  ok(r.status === 'refused' && sent.length === 1, 'refused, single request, no retry');
  ok(!scene.calls.some(c => c.name !== 'list_scene'), 'no scene mutation on refusal');
  ok(events.some(([e, d]) => e === 'refusal' && d.stop_details && d.stop_details.type === 'refusal'), 'refusal event carries stop_details');
}

// ── D. 429 once -> backoff -> success ────────────────────────────────────────
console.log('\n[D] 429 then 200');
{
  const { agent, sent, events } = agentWith([
    { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } },
    { body: msg([toolUse('tu_1', 'spawn_object', { kind: 'ball', size_m: null, attach: 'right_hand', physics: 'bouncy' })], 'tool_use') },
    { body: msg([text('Ball in your right hand.')]) },
  ]);
  const t0 = Date.now();
  const r = await agent.command('give me a ball in my right hand');
  ok(r.status === 'ok' && sent.length === 3, 'retried after 429 and completed');
  ok(events.some(([e, d]) => e === 'ratelimited' && d.status === 429), 'ratelimited event');
  ok(Date.now() - t0 >= 1900, 'waited the fixed backoff (~2 s; proxy drops retry-after)');
}

// ── D2. 529 twice -> local fallback ──────────────────────────────────────────
console.log('\n[D2] 529 twice -> local fallback');
{
  const e529 = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } };
  const { agent, sent } = agentWith([e529, e529]);
  const r = await agent.command('give me a cube');
  ok(sent.length === 2 && r.source === 'local' && r.actions[0].name === 'spawn_object' && r.actions[0].input.kind === 'cube', 'two 529s then local grammar spawned the cube');
}

// ── E. network failure -> local grammar ──────────────────────────────────────
console.log('\n[E] fetch throws -> local fallback');
{
  const { agent, scene, events } = agentWith([{ throw: true }]);
  await scene.exec('spawn_object', { kind: 'butterfly', size_m: null, attach: 'either_hand', physics: 'light' });
  const r = await agent.command('make the butterfly look for my hand');
  ok(r.source === 'local' && r.status === 'ok', 'local path ran');
  ok(r.actions[0].name === 'set_behavior' && r.actions[0].input.behavior === 'seek_hand' && r.actions[0].input.target === 'butterfly', 'seek_hand on butterfly');
  ok(events.some(([e, d]) => e === 'error' && d.code === 'network'), 'network error surfaced as event');
}

// ── F. round cap ─────────────────────────────────────────────────────────────
console.log('\n[F] round cap = 3');
{
  const tu = () => ({ body: msg([toolUse('tu_x', 'list_scene', {})], 'tool_use') });
  const { agent, sent, events } = agentWith([tu(), tu(), tu(), tu(), tu()]);
  const r = await agent.command('what is in the scene');
  ok(sent.length === 3 && r.rounds === 3, 'stopped after 3 API calls');
  ok(events.some(([e, d]) => e === 'error' && d.code === 'round_cap'), 'round_cap error event');
}

// ── G. max_tokens truncation -> fallback ─────────────────────────────────────
console.log('\n[G] max_tokens -> local fallback');
{
  const { agent } = agentWith([{ body: msg([], 'max_tokens') }]);
  const r = await agent.command('give me a cube');
  ok(r.source === 'local' && r.actions[0].name === 'spawn_object' && r.actions[0].input.kind === 'cube', 'truncated response not parsed; local spawn ran');
}

// ── H. proxy 500 (no key on server) -> local fallback; mode:'claude' -> error ──
console.log('\n[H] proxy 500 "ANTHROPIC_API_KEY is not set"');
{
  const body = { error: { message: 'ANTHROPIC_API_KEY is not set on the server' } };
  const a = agentWith([{ status: 500, body }]);
  const r = await a.agent.command('give me an apple');
  ok(r.source === 'local' && r.status === 'ok', 'auto mode fell back to local');
  const b = agentWith([{ status: 500, body }], { mode: 'claude' });
  const r2 = await b.agent.command('give me an apple');
  ok(r2.status === 'error' && /ANTHROPIC_API_KEY/.test(r2.error), 'claude mode reports the proxy error, no fallback');
}

// ── H2. timeout -> local fallback ────────────────────────────────────────────
console.log('\n[H2] request timeout -> local fallback');
{
  const sent = [], scene = new MockScene();
  const hang = (url, init) => new Promise((_, reject) => { sent.push(1); init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const agent = new CommandAgent({ tools, catalog, executor: scene.executor, fetchImpl: hang, timeoutMs: 150 });
  const errs = []; agent.on('error', e => errs.push(e.code));
  const r = await agent.command('give me a ball');
  ok(r.source === 'local' && errs.includes('timeout'), 'aborted after timeoutMs, local grammar ran');
}

// ── I. one-slot queue while busy ─────────────────────────────────────────────
console.log('\n[I] queue: newest wins while a command runs');
{
  const { agent, scene, events } = agentWith([
    { delay: 60, body: msg([toolUse('tu_1', 'spawn_object', { kind: 'apple', size_m: null, attach: 'either_hand', physics: 'default' })], 'tool_use') },
    { body: msg([text('Apple in your hand.')]) },
    { body: msg([toolUse('tu_2', 'apply_effect', { target: 'last', effect: 'glow', duration_s: null })], 'tool_use') },
    { body: msg([text('Glowing.')]) },
  ]);
  const p1 = agent.command('give me an apple');
  const p2 = agent.command('make it sparkle');          // displaced by p3 -> 'dropped'
  const p3 = agent.command('make it glow');
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  ok(r1.status === 'ok' && r2.status === 'dropped' && r3.status === 'ok', 'first ran, middle dropped, newest ran after');
  ok(events.filter(([e]) => e === 'queued').length === 2, 'queued events emitted');
  ok(scene.objects.get('apple_1').effects.includes('glow'), 'queued command executed against the spawned apple');
}

// ── J. local grammar coverage (the demo phrases) ─────────────────────────────
console.log('\n[J] local grammar');
{
  const scene = new MockScene();
  const agent = new CommandAgent({ tools, catalog, executor: scene.executor, mode: 'local' });
  const cases = [
    // the ten most likely demo phrases first
    ['give me an apple in my hand',                 'spawn_object',     i => i.kind === 'apple' && i.attach === 'either_hand' && i.size_m === null && i.physics === 'default'],
    ['put a basketball in my left hand',            'spawn_object',     i => i.kind === 'basketball' && i.attach === 'left_hand'],
    ['make the butterfly look for my hand',         'set_behavior',     i => i.behavior === 'seek_hand' && i.target === 'butterfly'],
    ['make the bird land on my right hand',         'set_behavior',     i => i.behavior === 'land_on_hand' && i.params.hand === 'right'],
    ['make the apple glow',                         'apply_effect',     i => i.effect === 'glow' && i.target === 'apple' && i.duration_s === null],
    ['make the apple twice as big',                 'transform_object', i => i.scale === 2 && i.target === 'apple'],
    ['remove the apple',                            'remove_object',    i => i.target === 'apple'],
    ['pass the ball to Maya',                       'pass_object',      i => i.to_participant === 'maya' && i.target === 'ball'],
    ["make Sam's window the goal",                  'designate_goal',   i => i.participant === 'sam'],
    ['what is in the scene',                        'list_scene',       () => true],
    // and the rest
    ['I want a big red ball',                       'spawn_object',     i => i.kind === 'ball' && Math.abs(i.size_m - 0.15) < 1e-6],
    ['drop a glass ball on the table',              'spawn_object',     i => i.kind === 'glass_ball' && i.attach === 'table'],
    ['give me a bouncy ball in front of me',        'spawn_object',     i => i.kind === 'ball' && i.attach === 'world_front' && i.physics === 'bouncy'],
    ['can i have a sword',                          'spawn_object',     i => i.kind === 'sword'],
    ['have the butterfly fly around my hand',       'set_behavior',     i => i.behavior === 'orbit_hand'],
    ['make the bird run away from my hand',         'set_behavior',     i => i.behavior === 'flee_hand'],
    ['make the ball follow where I look',           'set_behavior',     i => i.behavior === 'follow_gaze'],
    ['butterfly stay still',                        'set_behavior',     i => i.behavior === 'idle'],
    ['stop glowing',                                'apply_effect',     i => i.effect === 'glow' && i.duration_s === 0],
    ['confetti!',                                   'apply_effect',     i => i.effect === 'confetti' && i.target === 'scene'],
    ['make it smaller',                             'transform_object', i => i.scale === 0.67 && i.target === 'last'],
    ['paint the ball gold',                         'transform_object', i => i.color === 'gold'],
    ['make the cube 30 cm',                         'transform_object', i => Math.abs(i.size_m - 0.3) < 1e-9 && i.scale === null],
    ['clear everything',                            'remove_object',    i => i.target === 'all'],
    ['throw it to the person on the left',          'pass_object',      i => i.to_participant === 'left' && i.target === 'last'],
    ['give sam the apple',                          'pass_object',      i => i.to_participant === 'sam' && i.target === 'apple'],
    ["I'm the goal",                                'designate_goal',   i => i.participant === 'me'],
    ['switch the goal to the left tile',            'designate_goal',   i => i.participant === 'left'],
    ['no goal',                                     'designate_goal',   i => i.participant === 'none'],
    ['clear the goal',                              'designate_goal',   i => i.participant === 'none'],
  ];
  agent.lastTarget = 'x';                                   // so "it" resolves
  for (const [phrase, name, check] of cases) {
    const plan = agent.parseLocal(phrase);
    const first = plan && plan[0];
    ok(first && first.name === name && check(first.input), phrase, first ? '-> ' + first.name + ' ' + JSON.stringify(first.input) : '-> null');
    if (first) ok(agent._validate(first.name, first.input) === null, '  schema-lite valid');
  }
  const multi = agent.parseLocal('give me a glowing apple');
  ok(multi && multi.length === 2 && multi[1].name === 'apply_effect' && multi[1].input.target === 'last', 'give me a glowing apple -> spawn + glow(last)');
  const colored = agent.parseLocal('give me a red apple in my right hand');
  ok(colored && colored.length === 2 && colored[1].name === 'transform_object' && colored[1].input.color === 'red' && colored[0].input.attach === 'right_hand', 'give me a red apple -> spawn + recolor(last)');
  ok(agent.parseLocal('so anyway how was your weekend') === null, 'chit-chat -> null (no spurious spawn)');
  ok(agent.parseLocal('give me a dragon') === null, 'off-catalog kind -> null');

  // end-to-end local run mutates the mock scene
  const r = await agent.command('give me a glowing apple in my left hand');
  ok(r.source === 'local' && scene.objects.size === 1 && [...scene.objects.values()][0].effects.includes('glow'), 'local end-to-end: apple spawned with glow', r.say);
  const r2 = await agent.command('pass the apple to maya');
  ok(r2.actions[0].result.ok === true && r2.actions[0].result.to === 'p2', 'local: lowercase "maya" resolved to participant p2');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
