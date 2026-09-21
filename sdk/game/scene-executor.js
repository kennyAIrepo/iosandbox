/**
 * sdk/game/scene-executor.js — the CommandAgent's scene executor for the Teams twin (T5). Node-safe with
 * `scene = null` (three.js math only); the ONLY place the agent's tool calls touch physics, so it is the ONLY
 * doctrine enforcement point (CONTRACTS.md §3.12, SPEC.md §7).
 *
 *   const exec = new SceneExecutor({ scene, stage, props: S.props, localTile: () => S.tiles.get(me), roster: () => room.roster,
 *                                    seatOf: ref => court.seatOfClient(ref), game: () => S.game, isHost: () => room.isHost,
 *                                    me: () => S.me, announce: (text, level) => ui.announce(text, level) });
 *   const agent = new CommandAgent({ tools, catalog, executor: (name, input) => exec.exec(name, input) });
 *   // per frame (§6 step 6): exec.tick(dt, localTile.packs, { left: localTile.handL, right: localTile.handR })
 *
 * Every tool in tools.json has a branch; every `attach` / `behavior` / `effect` enum value returns `{ ok:boolean }`
 * (implemented, or an honest `{ ok:false, reason }`). Result shapes follow R/command-agent/mock-executor.js
 * (`ok`, `id`, `kind`, `hand`, `error`); `reason` and `error` carry the same string so both CONTRACTS.md and
 * CommandAgent.summarize() read it.
 *
 * PROP COLLISION DOCTRINE (memory: prop-collision-doctrine) — how each rule is enforced here:
 *   1. every prop is a PropBall: SHAPE (PropHull sphere) vs the 21 joint spheres; never a point / proximity grab
 *   2. pickup only by finger wrap / thumb clip (_wrapGrab) or the measured holding-pose cradle (_holdPose) — spawning
 *      "in the hand" SEATS the prop at the palm pocket (home = palm + n*(r + 0.01)) and lets gravity + the cradle hold it
 *   3. open hand = release that frame (PropBall re-tests the hold every frame)
 *   4. gravity ALWAYS on: every physics preset has gravity < 0; no behaviour ever sets it to 0 or parents the mesh
 *   5. hands support and never pass through (PropBall pushOut + handResist)
 *   6. seek_hand = x/z pocket attraction at <= SEEK_MAX_MPS, y untouched; orbit / flee / land / follow_gaze are refused
 *   7. the inner-palm side is MEASURED per pack (measurePalm = PropBall._holdPose maths: cross(wrist->middleMCP,
 *      index->pinky) signed by the thumb-column / fingertip volar test). No MediaPipe z sign, no handedness label.
 *
 * FREE-TEXT KINDS (B4, voice -> real 3D model): any `kind` that is not a KINDS key ("tennis ball", "rubber duck") goes
 * through model-fetch.js: a catalog word spawns its procedural body synchronously; anything else spawns a LABELLED
 * PLACEHOLDER CUBE into the same measured pocket at once (a real PropBody: gravity, support, wrap / cradle) and the
 * fetched GLB (bundled or Sketchfab) hot-swaps its visual + PropHull.fromObject hull in place when it arrives — position,
 * velocity and hold state are kept; a failed fetch leaves the labelled cube (status 'fallback', never silent).
 * `prop.model` carries { status, tier, progress, name, uid, error }; `onModelStatus(prop, st)` and `whenReady(id)` expose it.
 *
 * Seams (documented, not built): FireEffect via the `fire` option; remote participants' hands as behaviour targets
 * (agent props live on the local tile only). Sphere-hull KINDS stay sphere hulls unless `modelKinds` routes them.
 */
import * as THREE from 'three';
import { PropBall, palmPose, closure } from './prop-ball.js';
import { PropBody } from './prop-body.js';
import { ModelFetcher, makePlaceholder, relabelPlaceholder, normaliseKind, slugKind, disposeBuilt } from './model-fetch.js';
import { PropHull } from '../core/prop-hull.js';
import { D } from './court-space.js';

// ── vocabulary = tools.json enums exactly (D-C) ──────────────────────────────────────────────────────────────
/** Sphere hulls; r = natural size_m / 2 of tools.json (sword: a 4.5 cm grip sphere — the blade hull is a seam). */
export const KINDS = {
  apple:      { r: 0.04,  color: '#d7263d' },
  ball:       { r: 0.05,  color: '#f2f2f2' },
  basketball: { r: 0.12,  color: '#e0762b' },
  butterfly:  { r: 0.03,  color: '#7b61ff' },
  bird:       { r: 0.075, color: '#4aa3df' },
  sword:      { r: 0.045, color: '#c0c0c0' },
  cube:       { r: 0.05,  color: '#3ddc97' },
  glass_ball: { r: 0.06,  color: '#b3e5fc' },
};
/** Material presets. Gravity is ALWAYS negative (D4); the preset only changes how hard it falls and bounces. */
export const PHYSICS = {
  default: { gravity: -5.2, restitution: 0.58 },
  bouncy:  { gravity: -5.2, restitution: 0.8 },
  heavy:   { gravity: -9.7, restitution: 0.3 },
  light:   { gravity: -3.0, restitution: 0.58 },
};
export const TOOLS = ['spawn_object', 'set_behavior', 'apply_effect', 'transform_object', 'remove_object', 'pass_object', 'designate_goal', 'list_scene'];
export const ATTACH = ['left_hand', 'right_hand', 'either_hand', 'world_front', 'table'];
export const BEHAVIORS = ['seek_hand', 'orbit_hand', 'follow_gaze', 'flee_hand', 'idle', 'land_on_hand'];
export const EFFECTS = ['glow', 'sparkle', 'trail', 'confetti', 'bounce'];
export const LAYOUT_WORDS = ['left', 'right', 'top', 'bottom'];

export const R_MIN = 0.01, R_MAX = 1.0;        // radius clamp (size 0.02-2 m, tools.json descriptions)
export const OPEN_MIN = 0.6;                    // HandBody.openness above this = an open palm (SPEC §7)
export const POCKET_GAP = 0.01;                 // spawn seat: palm centre + n * (r + POCKET_GAP)
export const SEEK_MAX_MPS = 0.4;                // seek_hand pocket attraction cap (D6)
export const SEEK_DEFAULT_MPS = 0.4;
export const TRAIL_POINTS = 12;
export const GLOW_INTENSITY = 0.8;
export const WORLD_FRONT_OFFSET = Object.freeze({ x: 0, y: 0.1, z: 0.3 });
export const EVI_EPS = 1e-6;                    // volar-evidence dead band (a real thumb column gives |evi| ~ 0.1-1)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fail = (reason, extra = {}) => ({ ok: false, reason, error: reason, ...extra });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// module temps
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _pP = new THREE.Vector3(), _pQ = new THREE.Quaternion();

/**
 * MEASURED palm frame for a 21-point pack (plain {x,y,z} or Vector3) — the PropBall._holdPose maths, single frame:
 *   P  = palmPose centre (midpoint wrist..middle MCP)      pc = mean of wrist + 4 finger MCPs
 *   n  = cross(wrist->middleMCP, index->pinky) SIGNED by the volar test: thumb column (1, 2) volar of the knuckle
 *        plane + fingertip curl (8, 12, 16, 20 vs pc, half weight), divided by the palm span
 * The sign tie-break for a perfectly planar pack (evidence exactly 0) is HandBody's (`evi >= 0 -> +1`,
 * game-physics.js:131): the raw cross-product normal, never a hard-coded z sign. Returns out.ok = false when degenerate.
 */
export function measurePalm(pack, out = {}) {
  out.ok = false;
  out.P = out.P || new THREE.Vector3(); out.pc = out.pc || new THREE.Vector3();
  out.n = out.n || new THREE.Vector3(); out.q = out.q || new THREE.Quaternion();
  if (!pack || !pack[0] || !pack[9] || !pack[5] || !pack[17]) return out;
  if (!palmPose(pack, out.P, out.q)) return out;
  out.pc.set(0, 0, 0);
  for (const i of [0, 5, 9, 13, 17]) { const q = pack[i] || pack[0]; out.pc.x += q.x * 0.2; out.pc.y += q.y * 0.2; out.pc.z += q.z * 0.2; }
  _a.set(pack[9].x - pack[0].x, pack[9].y - pack[0].y, pack[9].z - pack[0].z);
  const span = _a.length(); if (span < 1e-4) return out;
  _a.normalize();
  _b.set(pack[5].x - pack[17].x, pack[5].y - pack[17].y, pack[5].z - pack[17].z);
  _c.crossVectors(_a, _b); if (_c.lengthSq() < 1e-10) return out;
  _c.normalize();
  let volar = 0;
  for (const i of [1, 2]) if (pack[i]) volar += (pack[i].x - pack[0].x) * _c.x + (pack[i].y - pack[0].y) * _c.y + (pack[i].z - pack[0].z) * _c.z;
  for (const i of [8, 12, 16, 20]) if (pack[i]) volar += ((pack[i].x - out.pc.x) * _c.x + (pack[i].y - out.pc.y) * _c.y + (pack[i].z - out.pc.z) * _c.z) * 0.5;
  volar /= span;
  out.evi = volar;
  out.sign = volar >= -EVI_EPS ? 1 : -1;                          // |evi| <= EPS = a perfectly planar (synthetic) hand: raw normal, like HandBody
  out.n.copy(_c).multiplyScalar(out.sign);
  out.closure = closure(pack);
  out.span = span;
  out.ok = true;
  return out;
}

/** Coloured, lit sphere on layer 0 (every tile camera sees layer 0); never culled (the stage scissors per tile). */
export function makePropMesh(r, color) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.05, emissive: new THREE.Color(0x000000) });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 26, 18), mat);
  mesh.frustumCulled = false;
  mesh.layers.set(0);
  return mesh;
}

export class SceneExecutor {
  /**
   * @param {object} o
   *   scene       THREE.Scene | null (Node tests)        stage   StageRenderer | null (unused today; ballMaterial seam)
   *   props       Map<id, record> shared with the page (S.props): { id, kind, ball:PropBall, behavior, effects:Set, color, ownerClient, size_m }
   *   localTile   () => { packs:{L,R,hands?}, handL, handR, views?, cam?|camera?, floorY? }   the speaker's own tile
   *   roster      () => [{ clientId, name, tracked, ... }]          seatOf   (clientId) => seat | -1
   *   game        () => BallGame | null                                isHost   () => bool
   *   me          () => { clientId, name, seat }                       announce (text, level) => void   (optional)
   *   fire        (prop, on) => bool                                    optional FireEffect seam
   *   floorY      () => number                                          optional override for the tile floor
   *   fetcher     ModelFetcher | null   free-text kinds (B4); undefined = a default ModelFetcher on first use, null = refused
   *   fetcherOptions  ModelFetcher constructor options for that default (endpoint, onStatus, ...)
   *   modelKinds  'all' | Iterable<kind>   KINDS names to route through the fetcher too (B2 visuals) — default none
   *   onModelStatus (prop, status) => void   model fetch progress (searching / downloading N % / ready / fallback)
   */
  constructor(o = {}) {
    this.scene = o.scene || null;
    this.stage = o.stage || null;
    this.props = o.props || new Map();
    this.fetcher = o.fetcher;
    this.fetcherOptions = o.fetcherOptions || null;
    this.modelKinds = o.modelKinds === 'all' ? 'all' : new Set(o.modelKinds || []);
    this.onModelStatus = o.onModelStatus || null;
    this.localTile = o.localTile || (() => null);
    this.roster = o.roster || (() => []);
    this.seatOf = o.seatOf || (() => -1);
    this.game = o.game || (() => null);
    this.isHost = o.isHost || (() => false);
    this.me = o.me || (() => ({ clientId: 'me', name: 'me', seat: 0 }));
    this.announce = o.announce || (() => {});
    this.fire = o.fire || null;
    this.floorYOf = o.floorY || null;
    this.seq = 0;
    this.lastTarget = null;
    this.calls = [];                              // [{ name, input, ok }] for HUD / probes
    this._t = 0;                                  // executor clock (s) for effect durations
    this._mp = {};                                // measurePalm scratch
  }

  // ── the executor contract: async (name, input) -> { ok, ... } ─────────────────────────────────────────────
  async exec(name, input) {
    input = input && typeof input === 'object' ? input : {};
    let r;
    switch (name) {
      case 'spawn_object':     r = this._spawn(input); break;
      case 'set_behavior':     r = this._setBehavior(input); break;
      case 'apply_effect':     r = this._applyEffect(input); break;
      case 'transform_object': r = this._transform(input); break;
      case 'remove_object':    r = this._remove(input); break;
      case 'pass_object':      r = this._pass(input); break;
      case 'designate_goal':   r = this._goal(input); break;
      case 'list_scene':       r = { ok: true, ...this.snapshot() }; break;
      default:                 r = fail('unknown tool');
    }
    this.calls.push({ name, input, ok: r.ok !== false });
    if (this.calls.length > 50) this.calls.shift();
    return r;
  }

  // ── spawn_object ──────────────────────────────────────────────────────────────────────────────────────────
  _spawn(input) {
    const kind = typeof input.kind === 'string' ? input.kind.trim() : input.kind;
    if (!KINDS[kind] || this._viaModel(kind)) return this._spawnModel(input, kind);
    const attach = input.attach;
    if (!ATTACH.includes(attach)) return fail(`unknown attach '${attach}'`);
    const physics = PHYSICS[input.physics] || PHYSICS.default;
    const natural = KINDS[kind].r;
    const r = clamp((input.size_m == null ? natural * 2 : Number(input.size_m)) / 2, R_MIN, R_MAX);
    const tile = this.localTile();
    const me = this.me() || {};
    const pl = this._place(attach, r, tile);
    if (pl.error) return fail(pl.error);
    const { home, resolved, hand, note, floorY } = pl;

    const id = `${kind}_${++this.seq}`;
    const color = KINDS[kind].color;
    const ball = new PropBall(this.scene, {
      radius: r, gravity: physics.gravity, restitution: physics.restitution,
      home, spawnOffset: new THREE.Vector3(0, 0, 0), floorY, boundsR: 2.2,
      mesh: makePropMesh(r, color),
    });
    if (!(ball.sphere.gravity < 0)) ball.sphere.gravity = PHYSICS.default.gravity;   // D4 belt and braces
    ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);       // visible (and hull-posed) at the seat before the first tick
    const prop = { id, kind, ball, behavior: null, effects: new Set(), fx: {}, color, ownerClient: me.clientId ?? null, physics: input.physics || 'default', attach: resolved };
    this.props.set(id, prop);
    this.lastTarget = id;
    this.announce(hand ? `${cap(kind)} on your ${hand} palm` : `${cap(kind)} in front of you`, 'polite');
    const out = { ok: true, id, kind, size_m: +(r * 2).toFixed(3), attach: resolved, hand, held_by: null, physics: prop.physics, position: this._pos3(ball) };
    if (note) out.note = note;
    return out;
  }

  /** Where a new prop of radius r first appears (shared by both spawn paths): the MEASURED pocket of an open palm for the
   *  hand attaches (either_hand: right preferred, else world_front with a note), the workspace front, or the floor point. */
  _place(attach, r, tile) {
    let home = null, resolved = attach, hand = null, note = null;
    const seat = (side) => {
      const h = this._openHand(tile, side);
      if (!h) return false;
      const m = measurePalm(h.pack, this._mp);
      if (!m.ok) return false;
      home = m.P.clone().addScaledVector(m.n, r + POCKET_GAP);      // palm centre + MEASURED inner normal * (r + 1 cm)
      hand = side; resolved = side + '_hand';
      return true;
    };
    if (attach === 'left_hand' || attach === 'right_hand') {
      const side = attach === 'left_hand' ? 'left' : 'right';
      if (!seat(side)) return { error: `no open ${side} hand` };
    } else if (attach === 'either_hand') {
      if (!seat('right') && !seat('left')) {                          // right preferred (SPEC §7)
        resolved = 'world_front';
        note = 'no open hand is tracked; placed in front of you';
      }
    }
    const wc = this._workspaceCenter(tile);
    const floorY = this._floorY(tile, wc);
    if (resolved === 'world_front') home = wc.clone().add(new THREE.Vector3(WORLD_FRONT_OFFSET.x, WORLD_FRONT_OFFSET.y, WORLD_FRONT_OFFSET.z));
    else if (resolved === 'table') home = new THREE.Vector3(wc.x, floorY + r + 0.02, wc.z);   // the floor point under the workspace centre
    return { home, resolved, hand, note, floorY };
  }

  // ── spawn_object, free-text kind (B4): catalog word -> procedural body now; else placeholder now, model when fetched ─
  _viaModel(kind) { return this.modelKinds === 'all' || this.modelKinds.has(kind); }
  _fetcher() {
    if (this.fetcher === undefined) {
      this.fetcher = new ModelFetcher(this.fetcherOptions || {});
      this.fetcher.preload();
    }
    return this.fetcher || null;
  }
  _spawnModel(input, kind) {
    const word = normaliseKind(kind);
    if (!word) return fail(`unknown kind '${kind}'`);
    const attach = input.attach;
    if (!ATTACH.includes(attach)) return fail(`unknown attach '${attach}'`);
    const fetcher = this._fetcher();
    if (!fetcher) return fail(`unknown kind '${kind}' (no model fetcher)`);
    const physics = PHYSICS[input.physics] || PHYSICS.default;
    const size = clamp(input.size_m == null ? fetcher.sizeFor(word) : Number(input.size_m) || fetcher.sizeFor(word), 2 * R_MIN, 2 * R_MAX);
    const r = size / 2;
    const tile = this.localTile();
    const me = this.me() || {};
    const pl = this._place(attach, r, tile);
    if (pl.error) return fail(pl.error);
    const { home, resolved, hand, note, floorY } = pl;

    const local = fetcher.local(word, size);                        // tier 1: procedural, synchronous
    const built = local || makePlaceholder(word, size);
    const id = `${slugKind(word)}_${++this.seq}`;
    const ball = new PropBody(this.scene, {
      radius: r, gravity: physics.gravity, restitution: physics.restitution,
      home, spawnOffset: new THREE.Vector3(0, 0, 0), floorY, boundsR: 2.2, built,
    });
    if (!(ball.sphere.gravity < 0)) ball.sphere.gravity = PHYSICS.default.gravity;   // D4 belt and braces
    ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
    const color = built.color || ball.color || '#9aa3ad';
    const prop = { id, kind: word, ball, behavior: null, effects: new Set(), fx: {}, color, ownerClient: me.clientId ?? null, physics: input.physics || 'default', attach: resolved,
      model: { status: local ? 'ready' : 'searching', tier: built.tier, progress: local ? 1 : 0, name: built.name || word, uid: null, error: null, abort: null } };
    this.props.set(id, prop);
    this.lastTarget = id;
    if (local) {
      prop.ready = Promise.resolve(prop);
      this.announce(hand ? `${cap(word)} on your ${hand} palm` : `${cap(word)} in front of you`, 'polite');
    } else {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      prop.model.abort = ctrl ? () => ctrl.abort() : null;
      this.announce(hand ? `Looking for a ${word} for your ${hand} palm` : `Looking for a ${word}`, 'polite');
      // progress phases come from the fetcher; the TERMINAL phases (ready / fallback) are emitted here, after the swap decision
      const progress = st => { if (st && st.phase !== 'ready' && st.phase !== 'fallback') this._modelStatus(prop, st); };
      prop.ready = fetcher.resolve(word, { size_m: size, signal: ctrl ? ctrl.signal : undefined, onStatus: progress })
        .then(b => {
          if (!b) return prop;                                        // cancelled
          if (this.props.get(id) !== prop) { disposeBuilt(b); return prop; }   // removed while loading
          if (b.tier === 'placeholder') { disposeBuilt(b); this._modelStatus(prop, { phase: 'fallback', tier: 'placeholder', error: b.error || prop.model.error || 'no model' }); return prop; }
          ball.setModel(b);
          if (prop.effects.has('glow')) ball.setGlow(prop.color);
          this._modelStatus(prop, { phase: 'ready', tier: b.tier, name: b.name || word, uid: b.uid || null, progress: 1, size_m: b.size_m, dims: b.dims });
          return prop;
        })
        .catch(e => { if (this.props.get(id) === prop) this._modelStatus(prop, { phase: 'fallback', tier: 'placeholder', error: (e && e.message) || String(e) }); return prop; });
    }
    const out = { ok: true, id, kind: word, size_m: +size.toFixed(3), attach: resolved, hand, held_by: null, physics: prop.physics, position: this._pos3(ball),
      model: { status: prop.model.status, tier: prop.model.tier } };
    if (note) out.note = note;
    return out;
  }
  _modelStatus(prop, st) {
    const m = prop.model;
    if (!m) return;
    if (st.phase) m.status = st.phase;
    if (st.progress != null) m.progress = st.progress;
    if (st.tier) m.tier = st.tier;
    if (st.name) m.name = st.name;
    if (st.uid) m.uid = st.uid;
    if (st.error) m.error = st.error;
    if (st.phase === 'ready') { m.progress = 1; if (st.uid !== undefined) m.uid = st.uid; if (this.props.get(prop.id) === prop) this.announce(`${cap(prop.kind)} is ready`, 'polite'); }
    else if (st.phase === 'fallback') {
      m.error = st.error || m.error || 'no model';
      try { relabelPlaceholder(prop.ball.mesh, prop.kind, 'no model found'); } catch { /* label is cosmetic */ }
      this.announce(`No ${prop.kind} model found; the placeholder stays`, 'polite');
    }
    if (this.onModelStatus) { try { this.onModelStatus(prop, st); } catch { /* UI errors never touch physics */ } }
  }
  /** Resolves with the prop once its model is ready / fallen back (KINDS props resolve at once); null for unknown ids. */
  whenReady(id) {
    const p = this.resolve(id);
    return p ? (p.ready || Promise.resolve(p)) : Promise.resolve(null);
  }

  /** The tracked, OPEN (HandBody.openness > OPEN_MIN) hand of the local tile for a screen slot, or null. */
  _openHand(tile, side) {
    if (!tile) return null;
    const hb = side === 'left' ? tile.handL : tile.handR;
    if (!hb || hb.present === false || !(hb.openness > OPEN_MIN)) return null;
    const pack = this._packOf(tile, side);
    if (!pack || !pack[0] || !pack[9]) return null;
    return { pack, hb };
  }
  /** Pack for a screen slot: packs.hands[] (slot-keyed, the SAME points the HandBody was fed) else packs.L / packs.R
   *  (the keys PropBall.update maps to 'left' / 'right'). Nothing is flipped or relabelled here. */
  _packOf(tile, side) {
    const packs = tile && tile.packs;
    if (!packs) return null;
    const ent = Array.isArray(packs.hands) ? packs.hands.find(h => h && h.slot === side) : null;
    if (ent && ent.points) return ent.points;
    return packs[side === 'left' ? 'L' : 'R'] || null;
  }
  _workspaceCenter(tile) {
    const cam = tile && (tile.cam || tile.camera);
    if (tile && tile.views && typeof tile.views.workspaceCenter === 'function' && cam) return tile.views.workspaceCenter(cam, new THREE.Vector3());
    if (tile && tile.center) return new THREE.Vector3(tile.center.x, tile.center.y, tile.center.z);
    if (cam && cam.position) return new THREE.Vector3(cam.position.x, cam.position.y, cam.position.z - D);
    return new THREE.Vector3(0, 0, -D);
  }
  _floorY(tile, wc) {
    if (this.floorYOf) { const f = this.floorYOf(tile); if (Number.isFinite(f)) return f; }
    if (tile && Number.isFinite(tile.floorY)) return tile.floorY;
    if (tile && tile.rect && Number.isFinite(tile.rect.floorY)) return tile.rect.floorY;
    return wc.y - 1.05;                                              // PropBall's own default (mirror-mode floor)
  }

  // ── set_behavior ──────────────────────────────────────────────────────────────────────────────────────────
  _setBehavior(input) {
    const behavior = input.behavior;
    if (!BEHAVIORS.includes(behavior)) return fail(`unknown behavior '${behavior}'`);
    const prop = this.resolve(input.target);
    if (!prop) return fail(`no such object: ${input.target}`);
    const params = input.params && typeof input.params === 'object' ? input.params : {};
    if (behavior === 'idle') { prop.behavior = null; return { ok: true, id: prop.id, behavior: 'idle' }; }
    if (behavior !== 'seek_hand') return fail(`${behavior} is not available in this build (gravity is always on)`);
    if (params.participant != null && !this._isMe(params.participant)) return fail('only your own hands are tracked on this device');
    const hand = ['left', 'right', 'either', 'nearest'].includes(params.hand) ? params.hand : 'either';
    const asked = params.speed == null ? SEEK_DEFAULT_MPS : clamp(Number(params.speed) || SEEK_DEFAULT_MPS, 0.05, 3);
    const speed = Math.min(asked, SEEK_MAX_MPS);                    // D6: x/z attraction only, at <= 0.4 m/s
    prop.behavior = { kind: 'seek_hand', hand, speed, participant: null };
    return { ok: true, id: prop.id, behavior: 'seek_hand', hand, speed };
  }

  // ── apply_effect ──────────────────────────────────────────────────────────────────────────────────────────
  _applyEffect(input) {
    const effect = input.effect;
    const dur = input.duration_s == null ? null : Number(input.duration_s);
    const stop = dur === 0;
    if (effect === 'sparkle' || effect === 'confetti' || effect === 'bounce') return fail(`${effect} is not available in this build`);
    if (effect !== 'glow' && effect !== 'trail' && effect !== 'fire') return fail(`unknown effect '${effect}'`);
    const targets = input.target === 'scene' ? [...this.props.values()] : (() => { const p = this.resolve(input.target); return p ? [p] : null; })();
    if (!targets) return fail(`no such object: ${input.target}`);
    let applied = 0;
    for (const prop of targets) {
      let okOne = false;
      if (effect === 'glow') okOne = stop ? this._glowOff(prop) : this._glowOn(prop, dur);
      else if (effect === 'trail') okOne = stop ? this._trailOff(prop) : this._trailOn(prop, dur);
      else if (effect === 'fire') {
        if (!this.fire) return fail('fire is not available in this build');
        okOne = !!this.fire(prop, !stop);
        if (okOne) { if (stop) prop.effects.delete('fire'); else prop.effects.add('fire'); }
      }
      if (okOne) applied++;
    }
    if (input.target !== 'scene' && !applied) return fail(`${effect} cannot be applied to ${targets[0].id}`);
    const one = targets.length === 1 ? targets[0] : null;
    return { ok: true, target: input.target, effect, applied, duration_s: stop ? 0 : dur, ...(one ? { id: one.id, effects: [...one.effects] } : {}) };
  }
  _glowOn(prop, dur) {
    const mat = prop.ball.mesh.material;
    if (typeof prop.ball.setGlow === 'function') { if (!prop.ball.setGlow(prop.color)) return false; }   // PropBody: every material
    else if (mat && mat.emissive) { mat.emissive.set(prop.color); mat.emissiveIntensity = GLOW_INTENSITY; }
    else if (mat && mat.uniforms && mat.uniforms.uGlow) mat.uniforms.uGlow.value = 0.6;
    else return false;
    prop.effects.add('glow');
    prop.fx.glow = { until: dur == null ? null : this._t + dur };
    return true;
  }
  _glowOff(prop) {
    const mat = prop.ball.mesh.material;
    if (typeof prop.ball.setGlow === 'function') prop.ball.setGlow(null);
    else if (mat && mat.emissive) { mat.emissive.set(0x000000); mat.emissiveIntensity = 1; }
    else if (mat && mat.uniforms && mat.uniforms.uGlow) mat.uniforms.uGlow.value = 0;
    prop.effects.delete('glow'); delete prop.fx.glow;
    return true;
  }
  _trailOn(prop, dur) {
    if (!prop.fx.trail) {
      const pos = new Float32Array(TRAIL_POINTS * 3);
      const p = prop.ball.pos;
      for (let i = 0; i < TRAIL_POINTS; i++) { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(prop.color), transparent: true, opacity: 0.6 }));
      line.frustumCulled = false; line.layers.set(0); line.renderOrder = 29;
      if (this.scene) this.scene.add(line);
      prop.fx.trail = { line, pos, until: null };
    }
    prop.fx.trail.until = dur == null ? null : this._t + dur;
    prop.effects.add('trail');
    return true;
  }
  _trailOff(prop) {
    const t = prop.fx.trail;
    if (t) { t.line.removeFromParent(); t.line.geometry.dispose(); t.line.material.dispose(); delete prop.fx.trail; }
    prop.effects.delete('trail');
    return true;
  }

  // ── transform_object ──────────────────────────────────────────────────────────────────────────────────────
  _transform(input) {
    const prop = this.resolve(input.target);
    if (!prop) return fail(`no such object: ${input.target}`);
    let r = prop.ball.radius * prop.ball.userS;
    if (input.size_m != null) r = Number(input.size_m) / 2;
    else if (input.scale != null) r = r * clamp(Number(input.scale) || 1, 0.1, 10);
    r = clamp(r, R_MIN, R_MAX);
    if (Math.abs(r - prop.ball.radius * prop.ball.userS) > 1e-9) {
      if (typeof prop.ball.setRadius === 'function') prop.ball.setRadius(r / prop.ball.userS);   // PropBody: inner model + hull segments
      else this._setRadius(prop, r);
    }
    if (input.color) {
      try {
        if (typeof prop.ball.setColor === 'function') {                                          // PropBody: every material
          if (prop.ball.setColor(input.color)) { prop.color = input.color; if (prop.effects.has('glow')) prop.ball.setGlow(input.color); }
        } else {
          const mat = prop.ball.mesh.material;
          mat.color.set(input.color); prop.color = input.color;
          if (prop.effects.has('glow') && mat.emissive) mat.emissive.set(input.color);
        }
        if (prop.fx.trail) prop.fx.trail.line.material.color.set(prop.color);
      } catch { /* an unknown CSS colour is ignored, never thrown at the model */ }
    }
    return { ok: true, id: prop.id, size_m: +(r * 2).toFixed(3), color: prop.color };
  }
  /** Re-base the PropBall at radius r: hull, geometry, sphere and collider follow (PropBall.setScale alone clamps
   *  its user scale to 0.4..3, which cannot reach the 0.02-2 m size range the tool promises). */
  _setRadius(prop, r) {
    const ball = prop.ball;
    ball.radius = r;
    ball.hull = PropHull.sphere(r);
    const old = ball.mesh.geometry;
    ball.mesh.geometry = new THREE.SphereGeometry(r, 26, 18);
    if (old && old.dispose) old.dispose();
    ball.setScale(1);                                                // sphere.radius, collider.radius, mesh.scale, matrixWorld
    if (ball.sphere.pos.y < ball.floorY + r) ball.sphere.pos.y = ball.floorY + r;   // a grown ball never starts inside the floor
    ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
  }

  // ── remove_object ─────────────────────────────────────────────────────────────────────────────────────────
  _remove(input) {
    const target = input.target;
    let list;
    if (target === 'all') list = [...this.props.values()];
    else if (target === 'last') { const p = this.resolve('last'); list = p ? [p] : []; }
    else if (this.props.has(target)) list = [this.props.get(target)];
    else list = [...this.props.values()].filter(p => p.kind === target);
    if (!list.length) return target === 'all' ? { ok: true, removed: 0, ids: [] } : fail(`no such object: ${target}`);
    for (const p of list) this._dispose(p);
    if (list.some(p => p.id === this.lastTarget)) this.lastTarget = null;
    if (target === 'all') this.announce('Scene cleared', 'polite');
    return { ok: true, removed: list.length, ids: list.map(p => p.id) };
  }
  _dispose(prop) {
    if (prop.fx.trail) this._trailOff(prop);
    if (prop.fx.glow) this._glowOff(prop);
    if (prop.effects.has('fire') && this.fire) { try { this.fire(prop, false); } catch { /* seam */ } }
    if (prop.model && prop.model.abort) { try { prop.model.abort(); } catch { /* already settled */ } prop.model.abort = null; }
    prop.ball.dispose();
    prop.behavior = null; prop.effects.clear();
    this.props.delete(prop.id);
  }

  // ── pass_object: only the GAME ball crosses tiles ─────────────────────────────────────────────────────────
  _pass(input) {
    const game = this.game();
    const target = String(input.target ?? '');
    const prop = this.resolve(target);
    const namesGameBall = /^(the )?(game[ _]?)?ball$/i.test(target) || target === 'last' && !prop;
    if (prop && !(namesGameBall && game)) return fail('only the game ball crosses tiles');
    if (!game) return fail('no game is running');
    if (!namesGameBall) return fail(`no such object: ${target}`);
    const to = this._participant(input.to_participant);
    if (!to) return fail(`no such participant: ${input.to_participant}`);
    const me = this.me() || {};
    if (to.clientId === me.clientId) return fail('that is you');
    const seat = to.seat;
    if (!(seat >= 0)) return fail(`${to.name} has no seat yet`);
    if (game.net && game.net.isOwner === false) return fail('you do not have the ball');
    if (game.net && game.net.inTransit) return fail('the ball is already in transit');
    if (typeof game.passToward !== 'function') return fail('this game cannot pass');
    let r;
    try { r = game.passToward(seat); } catch (e) { return fail(e && e.message || String(e)); }
    if (!r || r.ok === false) return fail((r && r.reason) || 'pass refused');
    return { ok: true, id: 'ball', to: to.clientId, to_name: to.name, seat, ...(r && typeof r === 'object' ? r : {}) };
  }

  // ── designate_goal: host only ─────────────────────────────────────────────────────────────────────────────
  _goal(input) {
    if (!this.isHost()) return fail('host only');
    const game = this.game();
    if (!game || typeof game.setGoal !== 'function') return fail('no game is running');
    const ref = String(input.participant ?? '').trim().toLowerCase();
    if (ref === 'none' || ref === '') { game.setGoal(-1); return { ok: true, goal: null, seat: -1 }; }
    const p = this._participant(ref);
    if (!p) return fail(`no such participant: ${input.participant}`);
    if (!(p.seat >= 0)) return fail(`${p.name} has no seat yet`);
    game.setGoal(p.seat);
    return { ok: true, goal: p.clientId, name: p.name, seat: p.seat };
  }

  // ── list_scene snapshot (what CommandAgent._snapshot reads) ───────────────────────────────────────────────
  snapshot() {
    const me = this.me() || {};
    const tile = this.localTile();
    const goalSeat = this._goalSeat();
    const objects = [...this.props.values()].map(p => {
      const b = p.ball;
      return {
        id: p.id, kind: p.kind, size_m: +(b.sphere.radius * 2).toFixed(3), position: this._pos3(b),
        held_by: b.hold ? `${me.clientId}:${b.hold.slot}` : (b.cradle ? `${me.clientId}:${b.cradle}` : null),
        behavior: p.behavior ? p.behavior.kind : null, effects: [...p.effects], color: p.color,
        ...(p.model ? { model: { status: p.model.status, tier: p.model.tier, name: p.model.name } } : {}),
      };
    });
    let roster = this.roster() || [];
    if (!roster.some(p => p.clientId === me.clientId)) roster = [{ clientId: me.clientId, name: me.name, tracked: true }, ...roster];
    const participants = roster.map(p => {
      const seat = p.clientId === me.clientId && Number.isFinite(me.seat) && me.seat >= 0 ? me.seat : this.seatOf(p.clientId);
      const mine = p.clientId === me.clientId;
      const hands = mine
        ? { left: !!(tile && tile.handL && tile.handL.present), right: !!(tile && tile.handR && tile.handR.present) }
        : { left: !!p.tracked, right: !!p.tracked };                 // remote hands: PRESENCE says tracked, not which slot
      return { id: p.clientId, name: p.name, tile: { seat, row: 0, col: seat }, hands, goal: seat >= 0 && seat === goalSeat };
    });
    return { objects, participants, speaker: me.clientId ?? null, goal: goalSeat, last: this.lastTarget };
  }
  _goalSeat() {
    const game = this.game();
    const g = game && game.court && game.court.map ? game.court.map.goal : (game && Number.isFinite(game.goal) ? game.goal : -1);
    return Number.isFinite(g) ? g : -1;
  }
  _pos3(ball) { const p = ball.pos; return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]; }

  // ── target / participant resolution ───────────────────────────────────────────────────────────────────────
  /** id | kind (the most recent of that kind) | 'last' -> prop | null */
  resolve(target) {
    if (target == null) return null;
    const t = String(target);
    if (t === 'last') return this.lastTarget ? this.props.get(this.lastTarget) || null : null;
    if (this.props.has(t)) return this.props.get(t);
    const same = [...this.props.values()].filter(p => p.kind === t);
    return same.length ? same[same.length - 1] : null;
  }
  _isMe(ref) {
    const me = this.me() || {};
    const r = String(ref).toLowerCase();
    return r === 'me' || r === 'speaker' || r === String(me.clientId).toLowerCase() || (me.name && r === String(me.name).toLowerCase());
  }
  /** 'me' | clientId | name (case-insensitive) | layout word relative to my seat -> { clientId, name, seat } | null */
  _participant(ref) {
    if (ref == null) return null;
    const me = this.me() || {};
    const r = String(ref).trim().toLowerCase();
    let roster = this.roster() || [];
    if (!roster.some(p => p.clientId === me.clientId)) roster = [{ clientId: me.clientId, name: me.name }, ...roster];
    const entry = p => ({ clientId: p.clientId, name: p.name, seat: p.clientId === me.clientId && Number.isFinite(me.seat) && me.seat >= 0 ? me.seat : this.seatOf(p.clientId) });
    if (r === 'me' || r === 'speaker') return entry(roster.find(p => p.clientId === me.clientId) || { clientId: me.clientId, name: me.name });
    if (LAYOUT_WORDS.includes(r)) {                                   // one row of seats (row 0, col = seat)
      if (r === 'top' || r === 'bottom') return null;
      const seated = roster.map(entry).filter(p => p.seat >= 0).sort((a, b) => a.seat - b.seat);
      const mySeat = (seated.find(p => p.clientId === me.clientId) || {}).seat;
      if (!(mySeat >= 0) || seated.length < 2) return null;
      const i = seated.findIndex(p => p.seat === mySeat);
      const j = r === 'left' ? (i - 1 + seated.length) % seated.length : (i + 1) % seated.length;
      return seated[j].clientId === me.clientId ? null : seated[j];
    }
    const hit = roster.find(p => String(p.clientId).toLowerCase() === r) || roster.find(p => p.name && String(p.name).toLowerCase() === r);
    return hit ? entry(hit) : null;
  }

  // ── per frame (§6 step 6) ─────────────────────────────────────────────────────────────────────────────────
  /** For every local prop: behaviour (x/z only), then PropBall.update (the doctrine lane), then effects. */
  tick(dt, packs, hb = null) {
    dt = Math.min(0.05, Math.max(0, dt || 0));
    this._t += dt;
    for (const prop of this.props.values()) {
      if (prop.behavior) this._behave(prop, dt, packs);
      prop.ball.update(dt, packs, hb);
      this._effectsTick(prop);
    }
  }
  _behave(prop, dt, packs) {
    const b = prop.behavior;
    if (!b || b.kind !== 'seek_hand') return;
    const ball = prop.ball;
    if (ball.hold || ball.cradle) return;                             // already in a hand: nothing to seek
    const L = packs && packs.L && packs.L[0] && packs.L[9] ? packs.L : null;
    const R = packs && packs.R && packs.R[0] && packs.R[9] ? packs.R : null;
    let pack = null;
    if (b.hand === 'left') pack = L; else if (b.hand === 'right') pack = R;
    else if (b.hand === 'nearest' && L && R) {
      const dl = Math.hypot(L[9].x - ball.pos.x, L[9].z - ball.pos.z), dr = Math.hypot(R[9].x - ball.pos.x, R[9].z - ball.pos.z);
      pack = dl < dr ? L : R;
    } else pack = R || L;
    if (!pack) return;
    const m = measurePalm(pack, this._mp);
    if (!m.ok) return;
    const Rr = ball.sphere.radius;
    _a.copy(m.pc).addScaledVector(m.n, Rr + 0.04);                   // the pocket (PropBall._holdPose definition)
    const dx = _a.x - ball.pos.x, dz = _a.z - ball.pos.z;             // x/z ONLY — gravity owns y (D6)
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return;
    const step = Math.min(dist, Math.min(b.speed, SEEK_MAX_MPS) * dt);
    ball.sphere.pos.x += dx / dist * step; ball.sphere.pos.z += dz / dist * step;
  }
  _effectsTick(prop) {
    const g = prop.fx.glow;
    if (g && g.until != null && this._t >= g.until) this._glowOff(prop);
    const t = prop.fx.trail;
    if (t) {
      if (t.until != null && this._t >= t.until) { this._trailOff(prop); return; }
      const pos = t.pos, p = prop.ball.pos;
      for (let i = TRAIL_POINTS - 1; i > 0; i--) { pos[i * 3] = pos[(i - 1) * 3]; pos[i * 3 + 1] = pos[(i - 1) * 3 + 1]; pos[i * 3 + 2] = pos[(i - 1) * 3 + 2]; }
      pos[0] = p.x; pos[1] = p.y; pos[2] = p.z;
      t.line.geometry.attributes.position.needsUpdate = true;
    }
  }

  /** Colliders of every live prop for rig conforming (page: cols = [game ball collider, ...exec.colliders()]). */
  colliders() { return [...this.props.values()].map(p => p.ball.collider); }

  dispose() {
    for (const p of [...this.props.values()]) this._dispose(p);
    this.lastTarget = null;
  }
}
