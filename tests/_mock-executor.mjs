/**
 * hopeOS — MockScene: an in-memory executor for CommandAgent so the whole
 * voice/text -> tools -> actions path can be exercised with NO API key, NO
 * three.js and NO camera (node or browser). It implements every tool in
 * tools.json with the result shapes the real executor should return.
 *
 *   import { MockScene } from './mock-executor.js';
 *   const scene = new MockScene({ participants: [...], speaker: 'p1' });
 *   const agent = new CommandAgent({ tools, executor: scene.executor });
 *
 * ── Executor contract ───────────────────────────────────────────────────────
 *   async executor(name, input) -> { ok: boolean, ...fields }   (throwing is also handled;
 *   ok:false becomes is_error:true on the tool_result). spawn_object MUST return `id`
 *   (the agent's lastTarget / the model's 'last'). list_scene is also called by the agent
 *   before every Claude request to build the snapshot — keep it cheap.
 *
 * ── Mapping onto the REAL hopeOS stack (mpbrowser.html + sdk/) ──────────────
 * Names below were verified by reading C:/Users/hanna/iosandbox on 2026-09-18
 * (line numbers from that read; nothing there was modified — this is the wiring
 * plan, not a patch):
 *
 *   spawn_object   -> mesh: engSpawn(type) (mpbrowser.html L6609) makes 1-unit
 *                    sphere/cylinder/cone/box primitives seated on the floor via
 *                    engAdopt(); engImportGLB(url, meta) (L6624) hosts a GLB
 *                    (auto-scaled to <=3 u, auto-grounded). Our catalog needs a
 *                    size_m-scaled variant of the same two paths. Collision SHAPE:
 *                    sphere kinds -> a radius body (GrabbableSphere in
 *                    sdk/core/game-physics.js L225 — but NEVER HandBody.jointsWithin
 *                    (L190) / pinch as a grab: the prop-collision doctrine forbids
 *                    jointsWithin/pinch grabs and gravity-off seeks); box -> OBB; hull
 *                    kinds (sword, bird, butterfly) -> PropHull.fromPoints(verts)
 *                    (sdk/core/prop-hull.js L48) so touch is shape-vs-shape against
 *                    the 21 joint spheres; glass_ball -> the existing SoftBody
 *                    (sdk/core/glass.js L93). attach *_hand -> compute the palm frame
 *                    with _palmPose(pack, outP, outQ) (mpbrowser.html L6233: Y =
 *                    wrist->middle MCP, Z = palm normal from index-pinky, X = Y x Z,
 *                    origin = midpoint wrist..MCP9) and seat the object at the POCKET
 *                    point above the palm along +Z by its radius, then let gravity +
 *                    the cradle block (L1631-1650: the palm supports it while
 *                    P.n.y > 0.3 and it is within R*1.1 of P.pocket; tilt -> it rolls
 *                    off with the palm's velocity, L1697-1702) hold it. Never pin: no
 *                    parenting under the hand, no gravity-off.
 *   set_behavior   -> a per-object controller ticked each frame with the live hand
 *                    packs; the existing NPC "mind" pattern is the template:
 *                    ENG_MINDS (L6454: greeter / skittish / sparring reactions),
 *                    engMindSet(obj, key) (L6482), engMindTick(dt, nowT) (L6523).
 *                    seek_hand ~ a greeter that steers toward the palm pocket;
 *                    flee_hand ~ skittish (move dir 'away'); land_on_hand = seek +
 *                    settle when PropHull.handGap(joints, radii) (prop-hull.js L150)
 *                    reaches 0 on an upturned palm. Ground kinds roll/hop and keep
 *                    gravity.
 *   apply_effect   -> emissive / material tweaks and particle bursts; FireEffect in
 *                    sdk/interaction/effects.js L102 is the existing per-hand particle
 *                    example (update(rightSl, leftSl, dt)).
 *   transform_object -> mesh.scale, then PropHull.begin(obj) (prop-hull.js L124)
 *                    re-poses the hull and recomputes _scale; recolor
 *                    material.color.set(css) (three.js Color.set accepts CSS names).
 *   pass_object    -> hand the object's state {kind, size_m, vel} to the multiplayer
 *                    relay (sdk/core/multiplayer.js exists; wire format is the game/
 *                    and acs/ research folders' topic) and despawn locally once the
 *                    receiver acks.
 *   list_scene     -> serialize ENG.objects + AVREG + tracked hands per participant.
 */

const NATURAL = { apple: 0.08, ball: 0.10, basketball: 0.24, butterfly: 0.06, bird: 0.15, sword: 0.90, cube: 0.10, glass_ball: 0.12 };
const FLYER = new Set(['butterfly', 'bird']);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class MockScene {
  constructor({ participants, speaker, log } = {}) {
    this.objects = new Map();                 // id -> record
    this.participants = participants || [
      { id: 'p1', name: 'Hanna', tile: 'left',  hands: ['left', 'right'] },
      { id: 'p2', name: 'Maya',  tile: 'right', hands: ['right'] },
      { id: 'p3', name: 'Sam',   tile: 'top',   hands: [] },
    ];
    this.speaker = speaker || this.participants[0].id;
    this.goal = null;
    this.seq = 0;
    this.last = null;
    this.calls = [];                          // every (name, input) for assertions
    this.log = log || (() => {});
    this.executor = (name, input) => this.exec(name, input);
  }

  /** The executor contract: async (name, input) -> { ok, ...fields }. */
  async exec(name, input) {
    this.calls.push({ name, input });
    this.log(name, input);
    switch (name) {
      case 'spawn_object': {
        const id = input.kind + '_' + (++this.seq);
        // clamps live HERE (strict schemas cannot carry minimum/maximum)
        const size = input.size_m == null ? NATURAL[input.kind] : clamp(input.size_m, 0.02, 2.0);
        const hand = this._pickHand(input.attach);
        const rec = { id, kind: input.kind, size_m: size, physics: input.physics, color: null,
                      held_by: hand ? this.speaker + ':' + hand : null, place: input.attach,
                      behavior: null, effects: [], pos: hand ? 'palm-pocket' : input.attach };
        this.objects.set(id, rec); this.last = id;
        return { ok: true, id, kind: rec.kind, size_m: size, hand, held_by: rec.held_by };
      }
      case 'set_behavior': {
        const rec = this._resolve(input.target); if (!rec) return { ok: false, error: 'no such object: ' + input.target };
        if (!FLYER.has(rec.kind) && (input.behavior === 'orbit_hand' || input.behavior === 'land_on_hand'))
          return { ok: false, error: rec.kind + ' cannot fly; use seek_hand (it will roll/hop) or idle' };
        rec.behavior = input.behavior === 'idle' ? null : { kind: input.behavior, ...input.params,
          speed: input.params.speed == null ? null : clamp(input.params.speed, 0.05, 3) };
        return { ok: true, id: rec.id, behavior: input.behavior };
      }
      case 'apply_effect': {
        if (input.target === 'scene') return { ok: true, target: 'scene', effect: input.effect, duration_s: input.duration_s ?? 2.5 };
        const rec = this._resolve(input.target); if (!rec) return { ok: false, error: 'no such object: ' + input.target };
        if (input.duration_s === 0) rec.effects = rec.effects.filter(e => e !== input.effect);
        else if (!rec.effects.includes(input.effect)) rec.effects.push(input.effect);
        return { ok: true, id: rec.id, effects: rec.effects.slice() };
      }
      case 'transform_object': {
        const rec = this._resolve(input.target); if (!rec) return { ok: false, error: 'no such object: ' + input.target };
        if (input.size_m != null) rec.size_m = clamp(input.size_m, 0.02, 2.0);
        else if (input.scale != null) rec.size_m = clamp(rec.size_m * clamp(input.scale, 0.1, 10), 0.02, 2.0);
        if (input.color) rec.color = input.color;
        return { ok: true, id: rec.id, size_m: +rec.size_m.toFixed(3), color: rec.color };
      }
      case 'remove_object': {
        if (input.target === 'all') { const n = this.objects.size; this.objects.clear(); this.last = null; return { ok: true, removed: n }; }
        const recs = this._resolveAll(input.target);
        if (!recs.length) return { ok: false, error: 'no such object: ' + input.target };
        for (const r of recs) this.objects.delete(r.id);
        if (recs.some(r => r.id === this.last)) this.last = null;
        return { ok: true, removed: recs.length, ids: recs.map(r => r.id) };
      }
      case 'pass_object': {
        const rec = this._resolve(input.target); if (!rec) return { ok: false, error: 'no such object: ' + input.target };
        const to = this._participant(input.to_participant); if (!to) return { ok: false, error: 'no such participant: ' + input.to_participant };
        rec.held_by = null; rec.pos = 'in-flight->' + to.id;
        return { ok: true, id: rec.id, to: to.id, to_name: to.name, scored: this.goal === to.id };
      }
      case 'designate_goal': {
        if (input.participant === 'none') { this.goal = null; return { ok: true, goal: null }; }
        const p = this._participant(input.participant); if (!p) return { ok: false, error: 'no such participant: ' + input.participant };
        this.goal = p.id;
        return { ok: true, goal: p.id, name: p.name };
      }
      case 'list_scene':
        return { ok: true, ...this.snapshot() };
      default:
        return { ok: false, error: 'unknown tool ' + name };
    }
  }

  snapshot() {
    return {
      objects: [...this.objects.values()].map(o => ({ id: o.id, kind: o.kind, size_m: o.size_m, held_by: o.held_by, behavior: o.behavior ? o.behavior.kind : null, effects: o.effects, color: o.color })),
      participants: this.participants.map(p => ({ ...p, goal: this.goal === p.id })),
      speaker: this.speaker, goal: this.goal, last: this.last,
    };
  }

  _pickHand(attach) {
    const me = this.participants.find(p => p.id === this.speaker) || { hands: [] };
    if (attach === 'left_hand') return me.hands.includes('left') ? 'left' : null;
    if (attach === 'right_hand') return me.hands.includes('right') ? 'right' : null;
    if (attach === 'either_hand') return me.hands[0] || null;    // real executor: the OPEN palm facing up, nearest the camera
    return null;
  }
  _resolve(target) {
    if (!target) return null;
    if (target === 'last') return this.last ? this.objects.get(this.last) : null;
    if (this.objects.has(target)) return this.objects.get(target);
    const same = [...this.objects.values()].filter(o => o.kind === target);
    return same.length ? same[same.length - 1] : null;             // most recent of that kind
  }
  _resolveAll(target) {
    if (target === 'last') { const r = this._resolve('last'); return r ? [r] : []; }
    if (this.objects.has(target)) return [this.objects.get(target)];
    return [...this.objects.values()].filter(o => o.kind === target);
  }
  _participant(ref) {
    if (!ref) return null;
    const r = String(ref).toLowerCase();
    if (r === 'me') return this.participants.find(p => p.id === this.speaker) || null;
    return this.participants.find(p => p.id.toLowerCase() === r || p.name.toLowerCase() === r || p.tile === r) || null;
  }
}
