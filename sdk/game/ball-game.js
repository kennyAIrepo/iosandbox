/**
 * sdk/game/ball-game.js — the twin's ball game: the FEEL state machine on top of BallNet (ownership) + PropBall (the
 * doctrine), cues, the arrival predictor, goal / hot-potato / practice rules. CONTRACTS §3.9, SPEC §6, DESIGN §7.
 * ─────────────────────────────────────────────────────────────────────────────
 * Node-safe with `scene = null` (three.js math only; the mesh is a plain Mesh nobody renders). Per client, per frame:
 *
 *   owner:     ball.update(dt, packs, hb)   — the frozen lane's doctrine, untouched: contacts are PropHull vs 21 joint
 *              spheres [D1]; pickup only by wrap / clip / holding-pose cradle [D2]; open hand = release THAT frame [D3];
 *              GrabbableSphere integrates with an EMPTY hand list, gravity always on [D4]; hands support and never pass
 *              through [D5]; the only seeks are the z-only depth bias and the x/z pocket pull [D6].
 *              → classifyRelease (drop / throw / clamped; a LOST hand never flings the ball) → holdFromProp → toCourtBall
 *              → goal test (goal seat only) → net.tickOwner (BALL_STATE; exitEdge → LAUNCH or onWall).
 *   non-owner: net.tick(); the ball is PLACED (never simulated) from the ghost (LAUNCH toward me), from the owner's
 *              received hand (ballFromHold, < 150 ms old) or from the dead-reckoned BALL_STATE; ArrivalPredictor turns
 *              free-flight states into a dashed ring hundreds of ms before the LAUNCH confirms it (solid ring, whoosh).
 *   claim:     onBecameOwner → setHome(my tile), reset at the entry point on the hand plane (z = -D), velocity capped
 *              by ThrowDetector.shapeEntry (2.0 u/s, 1.5 degraded), gravity on → the catch is a normal [D2] pickup.
 *
 * Ownership truth lives in BallNet only; `phase` is derived from its hooks + PropBall state (SPEC §3). Nothing here
 * reads MediaPipe handedness or hard-codes a z sign: packs arrive already resolved by each tile's own HandViews.
 */
import * as THREE from 'three';
import { PropBall, palmPose, hullTouch, closure as handClosure, makeBallMesh } from './prop-ball.js';
import { PropHull } from '../core/prop-hull.js';
import { EDGE, SEAT_NONE, COURT_GRAVITY, FLOOR_RESTITUTION, integrateCourt, DEFAULT_BALL_RADIUS_M, BALL_RADIUS_M_MIN, BALL_RADIUS_M_MAX, clampBallRadiusM, SHELF_FRAC, clampShelfFrac } from './court-map.js';
import { HOLD, REASON, CLAIM_REASON, PK, FLAG, dt32, seqNewer8, encodeGoal, decodeGoal, decodeClaim, readHeader } from './ball-net.js';
import { toCourtBall, onPropExit, holdFromProp, ballFromHold } from './court-bridge.js';
import { ThrowDetector } from './throw-detect.js';
import { U, D, MIRRORED_INPUT } from './court-space.js';
import { ArrivalPredictor, panForTile } from './latency-cues.js';
import { makeShelf, placeShelf, updateShelfShadow, disposeShelf } from './shelf.js';

// ── FEEL: the single source of the game's numbers (SPEC §6.3, DESIGN §7.5) ──────────────────────────────────────
export const FEEL = Object.freeze({
  V_DROP: 0.25, V_MAX_OUT: 3.0, V_MAX_IN: 2.0, V_MAX_IN_DEGRADED: 1.5, V_LOST_CLAMP: 0.3,   // u/s (throw-detect THROW, latency-feel §4)
  GRAVITY_M: -COURT_GRAVITY * U, RESTITUTION: FLOOR_RESTITUTION,                             // D-D: court gravity in metres, floor bounce
  CUE_LEAD_MIN_MS: 300, RING_LEAD_MS: 400, RING_R_FROM: 3,                                   // latency-feel §3, §5.2
  ENTRY_TAU_MS: 100, ARRIVE_NO_CONTACT_MS: 600,                                              // EntryBlend / arriving → flight
  GOAL_RING_R: 0.25, GOAL_RING_Y: SHELF_FRAC + 0.13,                                         // court units, goal tile centre, sitting on the shelf (0.55)
  CATCH_ASSIST_FRICTION: 0.95,                                                               // vs the lane's 0.85 (mechanics-options §3)
  POTATO_MS: 8000, WALL_RESTITUTION: 0.6, DT_MIN: 1 / 120, DT_MAX: 1 / 30,
  STALE_FADE_MS: 150, STALE_DROP_MS: 400, LAUNCH_Z_EASE_MS: 60,
  BALL_RADIUS_M: DEFAULT_BALL_RADIUS_M, BALL_RADIUS_MIN_M: BALL_RADIUS_M_MIN, BALL_RADIUS_MAX_M: BALL_RADIUS_M_MAX,   // B1 (1): a fixed WORLD size, 5 cm (10 cm across)
  SUBSTEP_M: 0.015, SUBSTEPS_MAX: 4,                                                          // B1: with hands present, PropBall.update is sub-stepped so the ball moves ≤ 1.5 cm per doctrine pass (a 5 cm ball at 3 m/s would otherwise slip past a palm's joint spheres between frames — [D5])
  SHELF_FRAC,                                                                                // B1 (2): the ball's floor = the shelf at 42 % of the tile height
  HAND_STATE_OPEN: 0.15, HAND_STATE_CLOSED: 0.8,                                             // handState() closure bands: open < 0.15 ≤ cupped < 0.8 ≤ closed
});
/** `?ballr=` (metres, 0.035-0.07) from the page URL when there is one; null in Node / without the param. */
export function urlBallRadiusM(search) {
  try {
    const s = search !== undefined ? search : (globalThis.location && globalThis.location.search);
    if (!s) return null;
    const v = parseFloat(new URLSearchParams(s).get('ballr'));
    return Number.isFinite(v) ? clampBallRadiusM(v) : null;
  } catch { return null; }
}
export const PHASE = Object.freeze({ IDLE: 'idle', HELD: 'held', FLIGHT: 'flight', TRANSIT: 'transit', ARRIVING: 'arriving', FLOOR: 'floor', SINKING: 'sinking', RESPAWN: 'respawn' });
export const POTATO_BIT = 0x80;                    // GOAL.goalNo high bit = hot-potato burst (SPEC §6.1.6)
const LANE_FRICTION = 0.85;                        // prop-ball.js support contact friction (the lane's number)
const SEAT_COLORS = ['#5b5fc7', '#c4314b', '#13a10e', '#e97548', '#0078d4', '#8e562e', '#b4009e', '#00b7c3'];

/**
 * Classify a release under FEEL (SPEC §6.1.3). `how` = the hold that ended: 'wrap' | 'clip' | 'cradle', or 'lost' when the
 * holder's pack vanished this frame (tracker dropout — a drop clamped to 0.3 u/s, never a fling across the meeting).
 * @param {{x:number,y:number,z:number}} velWorld  world m/s (PropBall's 6-frame palm-follow mean at release)
 * @param {number} unit                              metres per court unit (court-space U)
 * @returns {{kind:'drop'|'throw', clamped:boolean, vel:THREE.Vector3, reason:number, speedU:number}}
 */
export function classifyRelease(velWorld, how, unit = U) {
  const vel = new THREE.Vector3(velWorld.x || 0, velWorld.y || 0, velWorld.z || 0);
  const s = vel.length() / unit;
  if (how === 'lost') {
    const clamped = s > FEEL.V_LOST_CLAMP;
    if (clamped) vel.multiplyScalar(FEEL.V_LOST_CLAMP / s);
    return { kind: 'drop', clamped, vel, reason: REASON.ROLL, speedU: Math.min(s, FEEL.V_LOST_CLAMP) };
  }
  if (s < FEEL.V_DROP) return { kind: 'drop', clamped: false, vel, reason: REASON.ROLL, speedU: s };
  let clamped = false;
  if (s > FEEL.V_MAX_OUT) { vel.multiplyScalar(FEEL.V_MAX_OUT / s); clamped = true; }
  return { kind: 'throw', clamped, vel, reason: REASON.THROW, speedU: clamped ? FEEL.V_MAX_OUT : s };
}

const _pP = new THREE.Vector3(), _pQ = new THREE.Quaternion(), _v3 = new THREE.Vector3();
const _w = { x: 0, y: 0, z: 0 }, _bp = { x: 0, y: 0, z: 0 }, _bq = { x: 0, y: 0, z: 0, w: 1 };
const span = pk => Math.hypot(pk[9].x - pk[0].x, pk[9].y - pk[0].y, pk[9].z - pk[0].z);
const packOk = pk => !!(pk && pk[0] && pk[9] && pk[5] && pk[17]);
const evt = (type, detail) => new CustomEvent(type, { detail });

/**
 * PALM FILL — a SUPPORT-ONLY collider per hand (the [D7] extraBodies contract: pushed out of like a hand, ≤ 2 cm/frame, no
 * bounce, friction; NEVER a grab candidate — no wrap / clip / cradle test reads it). The lane's hand is 21 joint spheres; between
 * the wrist (3.4 cm) and the MCP row (2.2 cm) that leaves a ~13 cm hole a 26 cm ball never noticed and a 10 cm ball falls straight
 * through (a flat palm under the game ball). Like BodyBody.VIRTUALS (game-physics.js:952) the fill rides the real joints:
 * [a, b, t, radius at k = 1] — two beads on each wrist→MCP line, one between neighbouring knuckles, two in the thumb web. Radii
 * scale with the pack's palm length exactly as prop-ball.js packRadii (k = palm / 0.204) and never exceed the joints they bridge,
 * so the palm's supporting surface stays where the joints put it (the cradle pocket, 4 cm above the palm centre, is untouched).
 */
export const PALM_FILL = Object.freeze([
  [0, 5, 0.35, 0.020], [0, 5, 0.7, 0.019], [0, 9, 0.35, 0.021], [0, 9, 0.7, 0.019],
  [0, 13, 0.35, 0.020], [0, 13, 0.7, 0.018], [0, 17, 0.35, 0.019], [0, 17, 0.7, 0.017],
  [5, 9, 0.5, 0.016], [9, 13, 0.5, 0.016], [13, 17, 0.5, 0.015],
  [1, 5, 0.5, 0.018], [2, 5, 0.5, 0.016],
]);
export class PalmFill {
  constructor() {
    this.joints = PALM_FILL.map(() => new THREE.Vector3());
    this.radii = new Array(PALM_FILL.length).fill(0);
    this.present = false;
    this.openness = 1;                                             // pinned: support only (the BodyBody convention)
  }
  /** Re-derive from a pack (plain {x,y,z} or Vector3 joints); absent pack → present = false. */
  update(pack) {
    if (!packOk(pack)) { this.present = false; return this; }
    const k = Math.max(0.02, span(pack)) / 0.204;
    for (let i = 0; i < PALM_FILL.length; i++) {
      const [a, b, t, r] = PALM_FILL[i], A = pack[a] || pack[0], B = pack[b] || pack[0];
      this.joints[i].set(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, A.z + (B.z - A.z) * t);
      this.radii[i] = r * k;
    }
    this.present = true;
    return this;
  }
}

export class BallGame extends EventTarget {
  /**
   * @param {object} o
   *   scene, stage          THREE.Scene | null (Node), StageRenderer | null
   *   court, net, clock     CourtMap, BallNet (its hooks are WIRED HERE — the page never sets net.hooks), SharedClock
   *   seat, clientId, isHost, mode: 'free' | 'potato' | 'practice'
   *   tileWorldRect(seat) → {x0,y0,x1,y1,floorY}   courtToWorld(x,y,out) → {x,y,z}   uvCamOf(seat) → uv camera   domRects() → rects[]
   *   cues: { ring?, ghost?, miss?, predictor?, sfx? } | null      announce(text, level)      packsOf?(seat) → {L,R,ageMs} | null
   *   colorOf?(seat) → css colour (ring / cue colour of a seat)
   *   ballRadiusM?  the ball's WORLD radius in metres (default `?ballr=` from the URL, else FEEL.BALL_RADIUS_M = 0.05; clamped 0.035-0.07);
   *                 court.R is derived from it (court.setBallRadiusM) so every court computation stays consistent
   *   shelfFrac?    the shelf line as a fraction of the tile height (default the court's, SHELF_FRAC = 0.42)
   *   shelves?      false to skip the shelf visuals (default: one makeShelf per seat on the scene when there is one)
   *   mesh?         THREE.Mesh | (R) => THREE.Mesh — the ball's visual (sdk/game/ball-visuals.js makeTennisBallMesh); default the matcap sphere
   */
  constructor(o) {
    super();
    this.scene = o.scene || null; this.stage = o.stage || null;
    this.court = o.court; this.net = o.net; this.clock = o.clock;
    this.seat = o.seat; this.clientId = o.clientId; this.isHost = !!o.isHost;
    this.mode = o.mode || 'free';
    this.tileWorldRect = o.tileWorldRect; this.courtToWorld = o.courtToWorld; this.uvCamOf = o.uvCamOf;
    this.domRects = o.domRects || (() => []);
    this.cues = o.cues || {};
    this.announce = o.announce || null;
    this.packsOf = o.packsOf || null;
    this.colorOf = o.colorOf || (s => SEAT_COLORS[((s | 0) % SEAT_COLORS.length + SEAT_COLORS.length) % SEAT_COLORS.length]);
    this.predictor = this.cues.predictor || new ArrivalPredictor({ court: this.court, mySeat: this.seat, minLeadMs: FEEL.CUE_LEAD_MIN_MS });
    this.sfx = this.cues.sfx || null;

    this.phase = PHASE.IDLE; this.running = false;
    this.score = new Array(this._nSeats()).fill(0);
    this.goalNo = 0; this.lastLauncher = -1; this.potato = null;
    this.stats = { catches: 0, misses: 0, saves: 0, goals: 0, lostDrops: 0, clamped: 0, throws: 0, drops: 0, walls: 0, potatoBursts: 0 };
    this.entryCap = FEEL.V_MAX_IN; this.assist = false;
    this.lastDt = 0; this.leadMs = null; this.chip = null; this.lastRemote = null;
    this.phaseLog = [];                                            // [{from,to,t}] (probes; capped at 64)
    this._reason = REASON.THROW; this._arrivedFrom = -1; this._arrivedAt = 0; this._touched = false; this._caught = false;
    this._bonked = false; this._missed = false; this._scored = false; this._parked = null; this._rk = null;
    this._tickedSince = -1; this._respawnEpoch = -1; this._potatoNo = 0; this._potatoWarned = 0; this._lastBurstNo = -1; this._lastGoalKey = -1;
    this._holderBefore = null; this._holdTypeBefore = null; this._packs = { L: null, R: null };
    this._cb = {};

    // the ONE PropBall: a FIXED WORLD radius (B1 decision 1; court.R is derived from it), court gravity, floor bounce; mesh on
    // layer 0 (rigs live on 1 + i). Its floor is the SHELF line of the sim tile (decision 2), re-read every owner frame.
    this.radiusM = this.court.setBallRadiusM(o.ballRadiusM ?? urlBallRadiusM() ?? DEFAULT_BALL_RADIUS_M);
    if (o.shelfFrac !== undefined) this.court.setShelf(o.shelfFrac);
    const R = this.radiusM;
    const rect = this._rectOf(this.seat);
    const home = new THREE.Vector3(rect ? (rect.x0 + rect.x1) / 2 : 0, rect ? (rect.y0 + rect.y1) / 2 : 0, -D);
    this.ball = new PropBall(this.scene, {
      radius: R, gravity: FEEL.GRAVITY_M, restitution: FEEL.RESTITUTION, mesh: typeof o.mesh === 'function' ? o.mesh(R) : (o.mesh || this._makeMesh(R)),
      home, floorY: rect ? rect.floorY : home.y - U / 2, boundsR: 2.2, spawnOffset: new THREE.Vector3(0, 0, 0),
      onExit: info => this._onPropExit(info), onGrab: (slot, type) => this._onGrab(slot, type), onRelease: vel => this._onRelease(vel),
    });
    this.ball.mesh.layers.set(0);
    this.ball.mesh.visible = false;                                // shown once the ball exists (kickoff / first state)
    this.shelves = new Map();                                      // seat → makeShelf group (browser only; see _shelfFrame)
    this._shelvesOn = o.shelves !== false && !!this.scene;
    this._floorRect = null;                                        // the sim tile rect the floor was last synced from
    this.palmFill = { left: new PalmFill(), right: new PalmFill() };   // support-only palm colliders (see PalmFill)
    this._bodies = [];                                             // extraBodies + the two palm fills, rebuilt per frame (no allocation)

    // every BallNet hook, wired here; the page passes hooks through, never overrides them
    this.hooks = {
      onBecameOwner: c => this._onBecameOwner(c), onLostOwner: () => this._onLostOwner(), onOwnerChanged: c => this._onOwnerChanged(c),
      onRemoteState: s => this._onRemoteState(s), onLaunchSeen: (l, mine) => this._onLaunchSeen(l, mine), onWall: (edge, cb) => this._onWall(edge, cb),
      onGoal: g => this._onGoal(g), onSeatMap: m => this._onSeatMap(m), onRespawnLocal: b => this._onRespawnLocal(b),
    };
    this.net.hooks = this.hooks;
    // hot-potato bursts are host-authored GOAL packets with bit 7 set and no goal tile: BallNet's GOAL filter (goalSeat must be
    // the map's goal, sender must own it) drops them by design, so the game listens on the same transport for that one case
    this._tr = this.net.tr || null;
    if (this._tr && typeof this._tr.onMessage === 'function') this._tr.onMessage(buf => this._onRaw(buf));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  /** host: kickoff (a RESPAWN claim at the kickoff seat: RESTING on the shelf centre, y = floorY + R — B1 (5)); others: just run. */
  start() {
    this.running = true;
    if (!this.isHost) return true;
    const k = this.court.map.kickoff ?? 0, r = this.court.rectOf(k), R = this.court.R;
    if (!r) return false;
    return this.net.kickoff({ x: r.x0 + r.w / 2, y: this.court.floorY(k) + R, d: 0, vx: 0, vy: 0, vd: 0, wx: 0, wy: 0, wz: 0, radius: R, atRest: true });
  }
  /**
   * Change the ball's WORLD radius (metres, clamped 0.035-0.07): court.R follows (= m / U), the PropBall is re-based in place
   * (hull, mesh geometry, conform collider; never while held), the host republishes the seat map with `ballR` so every client
   * agrees. Returns the applied radius.
   */
  setBallRadiusM(m, { publish = this.isHost } = {}) {
    const r = clampBallRadiusM(m);
    if (Math.abs(r - this.radiusM) < 1e-6) return r;
    this.court.setBallRadiusM(r);
    this._applyRadius(r);
    if (publish && this.net && typeof this.net.publishSeatMap === 'function') {
      const map = { ...this.court.map, ballR: this.court.R, v: (this.court.map.v || 0) + 1 };
      this.net.publishSeatMap(map); this._onSeatMap(map);
    }
    this.dispatchEvent(evt('ballsize', { radiusM: r, R: this.court.R }));
    return r;
  }
  /** Change the shelf line (fraction of the tile height, clamped 0.2-0.7); the floor follows next frame; host republishes `shelf`. */
  setShelfFrac(frac, { publish = this.isHost } = {}) {
    const f = clampShelfFrac(frac);
    if (Math.abs(f - this.court.shelf) < 1e-9) return f;
    this.court.setShelf(f);
    this._floorRect = null;                                        // force a re-sync (floor + shelf visuals)
    this._syncFloor();
    if (publish && this.net && typeof this.net.publishSeatMap === 'function') {
      const map = { ...this.court.map, shelf: f, v: (this.court.map.v || 0) + 1 };
      this.net.publishSeatMap(map); this._onSeatMap(map);
    }
    this.dispatchEvent(evt('shelf', { frac: f }));
    return f;
  }
  get shelfFrac() { return this.court.shelf; }
  /** Re-base the PropBall to a new radius in place (the page's old syncBallRadius, owned here now). */
  _applyRadius(r) {
    const ball = this.ball;
    this.radiusM = r;
    if (!(r > 0) || Math.abs(ball.radius - r) < 1e-6) return;
    ball.radius = r; ball.hull = PropHull.sphere(r);
    const old = ball.mesh.geometry;
    ball.mesh.geometry = new THREE.SphereGeometry(r, old && old.parameters ? old.parameters.widthSegments || 32 : 32, old && old.parameters ? old.parameters.heightSegments || 20 : 20);
    if (old && old.dispose) old.dispose();
    if (ball.mesh.userData) ball.mesh.userData.radius = r;         // ball-visuals meshes carry their radius (BallFx reads it)
    ball.setScale(1);                                              // sphere.radius, collider.radius, mesh scale
    if (ball.sphere.pos.y < ball.floorY + r) ball.sphere.pos.y = ball.floorY + r;   // a grown ball never starts inside the shelf
    ball.mesh.position.copy(ball.sphere.pos); ball.mesh.updateMatrixWorld(true);
    if (this.cues.ghost && this.cues.ghost.mesh) { const g = this.cues.ghost.mesh, og = g.geometry; g.geometry = new THREE.SphereGeometry(r, 24, 16); if (og && og.dispose) og.dispose(); }
  }
  /**
   * The ball's floor is the sim tile's SHELF line (tileWorldRect(seat).floorY, = court.floorY through the DOM rect). Re-read
   * whenever the rect changes (layout, roster, shelf slider): the game is the floor authority, the page may assign the same.
   */
  _syncFloor() {
    const seat = this.net && this.net.isOwner ? this.net.simSeat : this.seat;
    const rect = this._rectOf(seat);
    if (!rect || !Number.isFinite(rect.floorY)) return;
    const p = this._floorRect;
    if (p && p.seat === seat && p.floorY === rect.floorY && p.x0 === rect.x0 && p.x1 === rect.x1 && p.y0 === rect.y0 && p.y1 === rect.y1) return;
    this._floorRect = { seat, floorY: rect.floorY, x0: rect.x0, x1: rect.x1, y0: rect.y0, y1: rect.y1 };
    this.ball.floorY = rect.floorY;
    this.ball.center.set((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, -D);
    this._shelvesDirty = true;
  }
  /** One shelf visual per seat (scene only), re-posed when a rect changes; the contact shadow follows the visible ball. */
  _shelfFrame() {
    if (!this._shelvesOn) return;
    const n = this._nSeats();
    if (this._shelvesDirty || this.shelves.size !== n || (this.lastDt && ((this._shelfTick = (this._shelfTick | 0) + 1) % 30 === 0))) {
      this._shelvesDirty = false;
      for (let s = 0; s < n; s++) {
        const rect = this._rectOf(s); if (!rect) continue;
        let sh = this.shelves.get(s);
        if (!sh) { sh = makeShelf(rect); this.shelves.set(s, sh); this.scene.add(sh); }
        else if (!sh.rect || sh.rect.floorY !== rect.floorY || sh.rect.x0 !== rect.x0 || sh.rect.x1 !== rect.x1) placeShelf(sh, rect);
      }
      for (const [s, sh] of this.shelves) if (s >= n) { disposeShelf(sh); this.shelves.delete(s); }
    }
    const m = this.ball.mesh, r = this.ball.sphere.radius;
    for (const sh of this.shelves.values()) {
      if (!m.visible) { sh.shadow.visible = false; continue; }
      updateShelfShadow(sh, m.position, r);
    }
  }
  /** The shelf visual of a seat (null in Node / when shelves are off). */
  shelfOf(seat) { return this.shelves.get(seat) || null; }
  /** The page's tiles moved (layout / roster / resize): re-read the floor now and re-place every shelf on the next frame. */
  relayout() { this._floorRect = null; this._shelvesDirty = true; this._syncFloor(); }
  stop() { this.running = false; this._setPhase(PHASE.IDLE); this.chip = null; if (this.cues.ring) this.cues.ring.clear(); }
  reset() {
    const was = this.running;
    this.score.fill(0); this.goalNo = 0; this.lastLauncher = -1; this.potato = null; this._potatoWarned = 0;
    for (const k of Object.keys(this.stats)) this.stats[k] = 0;
    this._arrivedFrom = -1; this._scored = false; this._parked = null; this._rk = null; this.predictor.clear();
    this.ball.recenter();
    if (was) this.start();
  }
  setMode(mode) {
    if (!['free', 'potato', 'practice'].includes(mode)) return false;
    this.mode = mode;
    if (mode === 'potato') {
      if (this.isHost && (this.court.map.goal ?? -1) >= 0) this.setGoal(-1);          // no goal tile in hot potato
      this.potato = this.net.owner >= 0 ? { untilMs: this.clock.now() + FEEL.POTATO_MS, ownerSeat: this.net.owner, epoch: this.net.ownerSeq } : null;
    } else this.potato = null;
    this._potatoWarned = 0;
    this.dispatchEvent(evt('mode', { mode }));
    return true;
  }
  /** host only: seatMap.goal → publishSeatMap({...map, goal, v: v + 1}) */
  setGoal(seat) {
    if (!this.isHost) return false;
    const map = { ...this.court.map, goal: seat ?? -1, v: (this.court.map.v || 0) + 1 };
    this.net.publishSeatMap(map);                                  // sets court locally + SEAT_MAP to everyone
    this._onSeatMap(map);
    return true;
  }
  /** latency band → entry cap + catch assist (friction only; latency-feel.md §4). Never touches physics elsewhere. */
  setLatencyBand(oneWayMs) {
    const degraded = oneWayMs >= 300;
    this.entryCap = degraded ? FEEL.V_MAX_IN_DEGRADED : FEEL.V_MAX_IN;
    this.assist = degraded;
  }
  /**
   * agent tool pass_object: a THROW by fiat toward the seat's shared edge — never an ownership write. The LAUNCH only
   * fires once the ball has FULLY left the tile (court-map exitEdge: centre past the edge by R) and the floor's contact
   * friction kills any roll, so the arc must clear that line IN THE AIR: 1.6 u/s is the floor of the pass speed (a flat
   * arc, ≥ 12° of lift, when it reaches); a longer pass takes the speed its range needs at 45°, never above V_MAX_OUT
   * (what a human may throw); an upward pass rises to the top edge. Gravity stays on — it is a plain ballistic throw.
   * @returns {{ok:boolean, reason?:string, edge?:number, speedU?:number, liftDeg?:number}}
   */
  passToward(seat) {
    if (!this.net.isOwner) return { ok: false, reason: 'not the owner' };
    if (this.net.inTransit) return { ok: false, reason: 'ball in transit' };
    if (this.ball.hold || this.ball.cradle) return { ok: false, reason: 'ball is held' };
    const me = this.net.simSeat, cb = this._courtPos(me), rect = this.court.rectOf(me);
    let edge = -1;
    for (const e of [EDGE.R, EDGE.L, EDGE.T]) { const nb = this.court.neighbourAt(me, e, e === EDGE.T ? cb.x : cb.y); if (nb.seat === seat) { edge = e; break; } }
    if (edge < 0) return { ok: false, reason: 'seat ' + seat + ' is not adjacent' };
    if (!rect) return { ok: false, reason: 'no tile rect for seat ' + me };
    const R = this.court.R, g = COURT_GRAVITY, S0 = 1.6, TH_MIN = 12 * Math.PI / 180;
    const dist = edge === EDGE.R ? (rect.x0 + rect.w + R) - cb.x : edge === EDGE.L ? cb.x - (rect.x0 - R) : (rect.y0 + rect.h + R) - cb.y;   // court u to the exit line
    const need = Math.max(0, dist) * 1.15 + 0.05;                                               // cross in the air, not land on the line
    let s = S0, th;
    if (edge === EDGE.T) { s = Math.sqrt(2 * g * need); th = Math.PI / 2; }                    // apex s²/2g ≥ need
    else if (need <= S0 * S0 / g) th = Math.max(TH_MIN, 0.5 * Math.asin(g * need / (S0 * S0)));   // 1.6 u/s reaches: the flat arc (range s² sin2θ / g)
    else { th = Math.PI / 4; s = Math.sqrt(g * need); }                                          // longer: 45° at the speed the range needs
    s = Math.min(FEEL.V_MAX_OUT, Math.max(S0, s));
    const sx = edge === EDGE.T ? 0 : s * Math.cos(th) * (edge === EDGE.L ? -1 : 1), sy = s * Math.sin(th);
    this.ball.sphere.vel.set(sx * U, sy * U, 0);
    this._reason = REASON.THROW; this.stats.throws++;
    this._setPhase(PHASE.FLIGHT); this._chip(me, 'PASS', 300);
    return { ok: true, edge, speedU: +s.toFixed(3), liftDeg: +(th * 180 / Math.PI).toFixed(1) };
  }

  // ── per frame ───────────────────────────────────────────────────────────
  /**
   * @param {number} now      local ms (clock.local()); timers use the injected clock
   * @param {number} dt       seconds, clamped to [DT_MIN, DT_MAX] before physics
   * @param {{L,R}} packs     the sim tile's packs (my tile, or the untracked seat I proxy)
   * @param {{left,right}} hb HandBodies (two-hand pinch scale only; disabled in transit / arriving)
   * @param {Array} extraBodies  T10 stretch (body support) — forwarded to PropBall.update when it accepts them
   */
  tick(now, dt, packs, hb = null, extraBodies = []) {
    dt = Math.min(FEEL.DT_MAX, Math.max(FEEL.DT_MIN, Number.isFinite(dt) ? dt : FEEL.DT_MAX));
    this.lastDt = dt;
    const P = this._packs; P.L = packs && packs.L ? packs.L : null; P.R = packs && packs.R ? packs.R : null;   // handState() reads these on every side
    if (this.running) {
      if (this.net.isOwner) this._ownerFrame(dt, packs, hb, extraBodies);
      else this._remoteFrame(dt);
    }
    this.net.tick();                                               // claims at tEdge', repeats, handoff timeout, recovery, ghost
    if (this.running) { this._potatoFrame(); this._chipFrame(); }
    this._shelfFrame();
    return this.phase;
  }

  /**
   * WHY a grab is or is not happening, per screen slot, from the lane's own measurements (B1 (4)): the measured holding pose
   * (prop-ball.js _holdPose), closure, mesh-true contact, the pocket distance and the hold in force. Read-only.
   * @returns {{slot, present, pose:'open'|'cupped'|'closed', holdPose:boolean, closure:number, ny:number|null, pocketDist:number|null,
   *            touching:boolean, hold:'wrap'|'clip'|'cradle'|null, state:'absent'|'open'|'cupped'|'closed'|'holding', why:string}}
   */
  handState(slot) {
    const pk = slot === 'left' ? this._packs.L : this._packs.R;
    const ball = this.ball, R = ball.sphere.radius, present = packOk(pk);
    const out = { slot, present, pose: 'open', holdPose: false, closure: 0, ny: null, pocketDist: null, touching: false, hold: null, state: 'absent', why: '' };
    if (ball.hold && ball.hold.slot === slot) out.hold = ball.hold.type;
    else if (ball.cradle === slot) out.hold = 'cradle';
    if (!present) { out.state = out.hold ? 'holding' : 'absent'; out.why = out.hold ? 'held (' + out.hold + ')' : 'no hand tracked'; return out; }
    const P = ball.handPose(slot);
    out.closure = handClosure(pk);
    out.pose = out.closure >= FEEL.HAND_STATE_CLOSED ? 'closed' : out.closure >= FEEL.HAND_STATE_OPEN ? 'cupped' : 'open';
    if (P && P.sign !== 0) {
      out.ny = P.n.y; out.holdPose = !!P.pose;
      out.pocketDist = Math.hypot(P.pocket.x - ball.sphere.pos.x, P.pocket.y - ball.sphere.pos.y, P.pocket.z - ball.sphere.pos.z);
    }
    out.touching = this._touch(pk, this.palmFill[slot]);
    out.state = out.hold ? 'holding' : out.pose;
    if (out.hold) out.why = 'held (' + out.hold + ')';
    else if (out.pose === 'closed') out.why = 'fist: open the hand around the ball';
    else if (out.touching) out.why = 'touching: curl the fingers round it, or turn the palm up';
    else if (out.ny === null) out.why = 'palm side not measured yet';
    else if (out.holdPose && out.pocketDist !== null && out.pocketDist <= R * 3.5) out.why = 'holding pose: the ball is coming to the pocket';
    else if (out.holdPose) out.why = 'holding pose: bring the palm under the ball (' + (out.pocketDist * 100).toFixed(0) + ' cm away)';
    else if (out.closure <= 0.02) out.why = 'fingers straight: relax them a little';
    else if (out.ny <= 0.25) out.why = 'palm not facing up (n.y ' + out.ny.toFixed(2) + ')';
    else out.why = 'out of reach';
    return out;
  }

  _ownerFrame(dt, packs, hb, extraBodies) {
    const ball = this.ball, sph = ball.sphere, net = this.net, tl = this.clock.local();
    const P = this._packs;
    this._syncFloor();                                             // the shelf is the floor; follows the sim tile rect
    this._holderBefore = ball.hold ? ball.hold.slot : ball.cradle;
    this._holdTypeBefore = ball.hold ? ball.hold.type : (ball.cradle ? 'cradle' : null);
    const vyBefore = sph.vel.y;
    if (this._parked) return this._parkedFrame(dt);
    ball.mesh.visible = true;
    // two-hand pinch scale is disabled while the ball is in transit / arriving and 300 ms before a predicted arrival
    const pred = this.predictor.read(this.clock.now());
    const scaleOk = !(this.phase === PHASE.TRANSIT || this.phase === PHASE.ARRIVING) && !(pred && pred.leadMs <= FEEL.CUE_LEAD_MIN_MS);
    // [D1]-[D6] inside PropBall.update; onGrab / onRelease fire here. Sub-stepped while something can touch the ball and it moves more
    // than SUBSTEP_M per pass (its OWN speed; a fast HAND is already stopped at the surface by the lane's handResist), so a falling
    // 5 cm ball meets the palm's joint spheres instead of passing between two frames — the same doctrine, run at a finer dt.
    const bodies = this._bodies; bodies.length = 0;
    if (extraBodies) for (const b of extraBodies) bodies.push(b);
    bodies.push(this.palmFill.left.update(P.L), this.palmFill.right.update(P.R));   // [D7] support-only: closes the palm hole for a 5 cm ball
    const canTouch = !!(P.L || P.R || (extraBodies && extraBodies.length)) && !ball.hold && !ball.cradle;   // a held / cradled ball rides the palm kinematically: one pass (its velocity history feeds the throw)
    const n = canTouch ? Math.min(FEEL.SUBSTEPS_MAX, Math.max(1, Math.ceil(sph.vel.length() * dt / FEEL.SUBSTEP_M))) : 1;
    this.lastSubsteps = n;
    if (n === 1) ball.update(dt, P, scaleOk ? hb : null, bodies);
    else for (let s = 0; s < n; s++) ball.update(dt / n, P, scaleOk ? hb : null, bodies);
    // a cradle ends without a callback (palm tilted off / hand gone): classify it here
    if (this._holdTypeBefore === 'cradle' && !ball.hold && !ball.cradle) this._classify(sph.vel, this._packPresent(this._holderBefore) ? 'cradle' : 'lost');
    const r = sph.radius, held = !!(ball.hold || ball.cradle);
    const onFloor = sph.pos.y <= ball.floorY + r + 1e-3, atRest = onFloor && sph.vel.lengthSq() < 0.01;
    let touching = held || this._anyTouch(P.L, P.R);
    if (this.assist && touching && !held) sph.vel.multiplyScalar(FEEL.CATCH_ASSIST_FRICTION / LANE_FRICTION);   // catch assist = friction only
    // first contact / catch / miss bookkeeping for a ball that came from another tile
    if (this._arrivedFrom >= 0) {
      if (touching && !this._touched) {
        this._touched = true;
        if (this.mode === 'free' && net.simSeat === (this.court.map.goal ?? -1) && !this._scored) { this.stats.saves++; this._chip(net.simSeat, 'SAVE', 800); this._cue(net.simSeat, 'save'); }
      }
      if (held && !this._caught) { this._caught = true; this.stats.catches++; if (this.sfx) this.sfx.thud(this._pan(net.simSeat)); this._cue(net.simSeat, 'catch'); this._say(`${this._name(net.simSeat)} caught the ball`); }
      if (onFloor && !this._touched && !this._bonked) { this._bonked = true; if (this.sfx) this.sfx.bonk(this._pan(net.simSeat), vyBefore); }
    }
    // phase
    let target = this.phase;
    if (held) target = PHASE.HELD;
    else if (net.inTransit) target = this.phase === PHASE.SINKING ? PHASE.SINKING : PHASE.TRANSIT;
    else if (this.phase === PHASE.ARRIVING) target = atRest ? PHASE.FLOOR : (touching || tl - this._arrivedAt >= FEEL.ARRIVE_NO_CONTACT_MS) ? PHASE.FLIGHT : PHASE.ARRIVING;
    else if (this.phase === PHASE.RESPAWN) target = atRest ? PHASE.FLOOR : PHASE.RESPAWN;
    else target = atRest ? PHASE.FLOOR : PHASE.FLIGHT;
    if (target === PHASE.FLOOR && this.phase !== PHASE.FLOOR && this._arrivedFrom >= 0 && !this._touched && !this._missed) {
      this._missed = true; this.stats.misses++; this._chip(net.simSeat, 'MISS', 800); this._cue(net.simSeat, 'miss'); this._say(`Missed in ${this._name(net.simSeat)}`);
    }
    if (target === PHASE.HELD && this.phase !== PHASE.HELD) { this._chip(net.simSeat, 'HOLDING·' + (ball.hold ? ball.hold.slot : ball.cradle), 0); this._say(`${this._name(net.simSeat)} has the ball`); }
    if (this.phase === PHASE.HELD && target !== PHASE.HELD && this.chip && this.chip.text.startsWith('HOLDING')) this._chip(net.simSeat, null, 0);
    this._setPhase(target);
    // hold block for the wire (palm-local offset + relative quaternion, hand-span units)
    let hold = null;
    if (held) {
      const slot = ball.hold ? ball.hold.slot : ball.cradle, type = ball.hold ? ball.hold.type : 'cradle';
      const pk = slot === 'left' ? P.L : P.R;
      if (packOk(pk) && palmPose(pk, _pP, _pQ)) hold = holdFromProp({ type, slot }, sph.pos, sph.quat, _pP, _pQ, span(pk));
    }
    if (!held && !net.inTransit) this._softWalls();                // bounce at a wall SURFACE where there is no neighbour (BallNet.onWall stays the fallback)
    const cb = toCourtBall(this.court, net.simSeat, this._uvCam(net.simSeat), { pos: sph.pos, vel: sph.vel, angVel: sph.angVel, atRest, onFloor, reason: this._reason }, hold, this._cb, { mirroredInput: MIRRORED_INPUT });
    // goal: FREE ball, centre inside the goal ring of the goal tile, declared by that tile's owner (keeper or host proxy)
    const goal = this.court.map.goal ?? -1;
    if (this.mode === 'free' && !held && !net.inTransit && goal >= 0 && net.simSeat === goal && !this._scored && this.phase !== PHASE.RESPAWN && this.phase !== PHASE.SINKING) {
      const gr = this.court.rectOf(goal), gx = gr.x0 + gr.w / 2, gy = gr.y0 + FEEL.GOAL_RING_Y;
      if (Math.hypot(cb.x - gx, cb.y - gy) < FEEL.GOAL_RING_R) {
        const scorer = this.lastLauncher >= 0 ? this.lastLauncher : goal;
        this.goalNo = (this.goalNo + 1) & 0x7f;
        if (net.declareGoal(scorer, this.goalNo)) { this._scored = true; net.respawn(cb); return; }   // _onGoal ran inside declareGoal
      }
    }
    net.tickOwner(cb);                                             // BALL_STATE at rateHz; exitEdge → LAUNCH toward neighbourAt, or onWall
  }
  /** After the bounds safety net fired while a LAUNCH was already out: keep sending the extrapolated court state, not home. */
  _parkedFrame(dt) {
    const pk = this._parked;
    if (!this.net.inTransit) { this._parked = null; return; }
    integrateCourt(pk, dt);
    this.net.tickOwner(Object.assign(this._cb, pk, { d: 0, vd: 0, wx: 0, wy: 0, wz: 0, radius: this.court.R, hold: null, atRest: false, onFloor: false, reason: this._reason }));
  }
  _softWalls() {
    const rect = this._rectOf(this.net.simSeat); if (!rect) return;
    const sph = this.ball.sphere, r = sph.radius, me = this.net.simSeat, y = this._courtPos(me).y;
    if (sph.pos.x + r > rect.x1 && sph.vel.x > 0 && this.court.neighbourAt(me, EDGE.R, y).seat < 0) this._bounce(EDGE.R, rect);
    else if (sph.pos.x - r < rect.x0 && sph.vel.x < 0 && this.court.neighbourAt(me, EDGE.L, y).seat < 0) this._bounce(EDGE.L, rect);
    if (sph.pos.y + r > rect.y1 && sph.vel.y > 0 && this.court.neighbourAt(me, EDGE.T, this._courtPos(me).x).seat < 0) this._bounce(EDGE.T, rect);
  }
  _bounce(edge, rect) {
    const sph = this.ball.sphere, r = sph.radius;
    if (edge === EDGE.R) { sph.vel.x *= -FEEL.WALL_RESTITUTION; sph.pos.x = Math.min(sph.pos.x, rect.x1 - r); }
    else if (edge === EDGE.L) { sph.vel.x *= -FEEL.WALL_RESTITUTION; sph.pos.x = Math.max(sph.pos.x, rect.x0 + r); }
    else { sph.vel.y *= -FEEL.WALL_RESTITUTION; sph.pos.y = Math.min(sph.pos.y, rect.y1 - r); }
    this.ball.mesh.position.copy(sph.pos);
    this.stats.walls++;
    this.dispatchEvent(evt('wall', { edge, seat: this.net.simSeat }));
  }

  _remoteFrame(dt) {
    const net = this.net, ball = this.ball, now = this.clock.now(), tl = this.clock.local();
    this._parked = null;
    let placed = false;
    const l = net.lastLaunch;
    if (net.ghost && l && (l.to === this.seat || (this.isHost && l.to !== SEAT_NONE && !this.court.isTracked(l.to)))) {
      if (this.cues.ghost && this.cues.ghost.state) this.cues.ghost.update();   // the page's 35 % ghost draws the gutter flight
      else { const w = this.courtToWorld(net.ghost.x, net.ghost.y, _w); ball.mesh.position.set(w.x, w.y, -D); placed = true; }   // else the ghost BallNet integrates for me
    } else if (this._rk) {
      const k = this._rk;
      if (k.hold && k.hold.mode !== HOLD.FREE && this.packsOf && k.seat !== SEAT_NONE) {   // on the owner's RECEIVED hand when fresh
        const rp = this.packsOf(k.seat);
        const pk = rp && (k.hold.slot ? rp.R : rp.L);
        if (rp && rp.ageMs < FEEL.STALE_FADE_MS && packOk(pk) && palmPose(pk, _pP, _pQ)) {
          ballFromHold(k.hold, _pP, _pQ, span(pk), _bp, _bq);
          ball.mesh.position.set(_bp.x, _bp.y, _bp.z); ball.mesh.quaternion.set(_bq.x, _bq.y, _bq.z, _bq.w); placed = true;
        }
      }
      if (!placed) {
        let remain = Math.min(0.25, Math.max(0, (tl - k.tl) / 1000)); k.tl = tl;
        if (!k.atRest && !(k.hold && k.hold.mode !== HOLD.FREE)) {
          const fy = k.seat !== SEAT_NONE && this.court.rectOf(k.seat) ? this.court.floorY(k.seat) : undefined;
          while (remain > 1e-6) { const s = Math.min(1 / 60, remain); integrateCourt(k, s, fy, this.court.R); remain -= s; }
        }
        const w = this.courtToWorld(k.x, k.y, _w);
        ball.mesh.position.set(w.x, w.y, -D); placed = true;
      }
    }
    ball.mesh.visible = placed;
    if (placed) { ball.sphere.pos.copy(ball.mesh.position); ball.collider.center.copy(ball.mesh.position); ball.collider.active = true; ball.mesh.updateMatrixWorld(true); }
    else ball.collider.active = false;
    // arrival cue: dashed ring from the predictor, solid once the LAUNCH confirmed; one tick at 300 ms lead
    let p = this.predictor.read(now);
    if (p && p.leadMs < -500) { this.predictor.clear(); p = null; }   // a prediction that never materialised
    this.leadMs = p ? p.leadMs : null;
    if (p) {
      if (this.cues.ring) this.cues.ring.show({ rect: this.court.rectOf(this.seat), edge: p.edge, cEdge: p.cEdge, tEdgeEff: p.tEdgeEst, color: this.colorOf(p.seat), leadMs: FEEL.RING_LEAD_MS, dashed: p.predicted });
      if (p.leadMs <= FEEL.CUE_LEAD_MIN_MS && p.since !== this._tickedSince) {
        this._tickedSince = p.since;
        if (this.sfx) this.sfx.tick(this._pan(this.seat));
        this.dispatchEvent(evt('ring', { seat: this.seat, kind: p.predicted ? 'predicted' : 'confirmed', leadMs: p.leadMs }));
      }
    }
  }

  // ── BallNet hooks ───────────────────────────────────────────────────────
  _onBecameOwner(c) {
    const net = this.net, ball = this.ball, sph = ball.sphere, seat = net.simSeat, tl = this.clock.local();
    const rect = this._rectOf(seat);
    if (rect) ball.setHome(_v3.set((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, -D), rect.floorY);   // also recenters: hold/cradle null
    const w = this.courtToWorld(c.x, c.y, _w);
    sph.reset(_v3.set(w.x, w.y, -D));                              // entry point on the hand plane; gravity on from here
    ball.hold = null; ball.cradle = null; ball._velHist.length = 0;
    const e = ThrowDetector.shapeEntry(c.vx || 0, c.vy || 0, this.entryCap);
    sph.vel.set(e.vx * U, e.vy * U, 0); sph.pos.z = -D;
    ball.mesh.position.copy(sph.pos); ball.mesh.quaternion.copy(sph.quat); ball.mesh.updateMatrixWorld(true); ball.mesh.visible = true;
    ball.collider.center.copy(sph.pos); ball.collider.active = true;
    this._reason = REASON.THROW; this._parked = null; this._rk = null; this._scored = false;
    this._touched = false; this._caught = false; this._bonked = false; this._missed = false; this._arrivedAt = tl;
    if ((c.reason === CLAIM_REASON.BOUNDARY || c.reason === CLAIM_REASON.PROXY) && !this._viaRespawn(c)) {
      this._arrivedFrom = net.lastLaunch ? net.lastLaunch.from : -1;
      this._setPhase(PHASE.ARRIVING); this._chip(seat, 'INCOMING', 600);
      if (this.cues.ghost && this.cues.ghost.state) this.cues.ghost.promote();
      if (this.cues.ring) this.cues.ring.clear();
    } else {
      this._arrivedFrom = -1; this._respawnEpoch = c.ownerSeq;
      this._setPhase(PHASE.RESPAWN);
      if (this.sfx) this.sfx.pop(this._pan(seat));
      this._say(c.reason === CLAIM_REASON.RECOVERY ? `Ball recovered by ${this._name(seat)}` : `Ball back to ${this._name(seat)}`);
      this.dispatchEvent(evt('respawn', { seat, reason: c.reason }));
    }
    if (this.mode === 'potato') { this.potato = { untilMs: c.tState + FEEL.POTATO_MS, ownerSeat: c.seat, epoch: c.ownerSeq }; this._potatoWarned = 0; }
    this.predictor.clear();
    this.dispatchEvent(evt('claim', { claim: c, mine: true }));
    this.dispatchEvent(evt('owner', { seat: c.seat, simSeat: seat, mine: true }));
  }
  _onLostOwner() {
    this._arrivedFrom = -1; this._parked = null;
    if (this.phase === PHASE.TRANSIT) this._setPhase(PHASE.ARRIVING);   // the receiver has it now (CLAIM or handoff timeout)
    this._arrivedAt = this.clock.local();
    if (this.chip && this.chip.text && this.chip.text.startsWith('HOLDING')) this._chip(this.seat, null, 0);
    this.dispatchEvent(evt('owner', { seat: this.net.owner, simSeat: this.net.ownerSimSeat, mine: false }));
  }
  _onOwnerChanged(c) {
    this._rk = null;
    if (c.reason === CLAIM_REASON.RESPAWN || c.reason === CLAIM_REASON.RECOVERY || this._viaRespawn(c)) {
      this._announceRespawn(c);
    } else {
      if (this.phase !== PHASE.ARRIVING) this._setPhase(PHASE.ARRIVING);
      this._arrivedAt = this.clock.local();
    }
    if (this.mode === 'potato') { this.potato = { untilMs: c.tState + FEEL.POTATO_MS, ownerSeat: c.seat, epoch: c.ownerSeq }; this._potatoWarned = 0; }
    if (this.cues.ring) this.cues.ring.clear();
    if (this.cues.ghost && this.cues.ghost.state) this.cues.ghost.cancel();
    this.predictor.clear();
    this.dispatchEvent(evt('claim', { claim: c, mine: false }));
    this.dispatchEvent(evt('owner', { seat: c.seat, simSeat: c.simSeat, mine: false }));
  }
  _onRemoteState(s) {
    this.lastRemote = s;
    this.predictor.onState(s, this.clock.now());
    const age = Math.max(0, dt32(this.clock.now(), s.t));
    this._rk = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, seat: s.seat, owner: s.owner, hold: s.hold, atRest: s.atRest, tl: this.clock.local() - age };
    if (!this.net.isOwner) this._mirrorPhase(s);
  }
  _mirrorPhase(s) {
    const tl = this.clock.local();
    if (s.inTransit) { if (this.phase !== PHASE.TRANSIT && this.phase !== PHASE.SINKING) this._setPhase(PHASE.TRANSIT); return; }
    if (this.phase === PHASE.TRANSIT || this.phase === PHASE.SINKING || this.phase === PHASE.IDLE) {   // a state from the new owner before its CLAIM: arrive first
      this._setPhase(this.phase === PHASE.SINKING ? PHASE.RESPAWN : PHASE.ARRIVING); this._arrivedAt = tl; return;
    }
    const held = s.hold && s.hold.mode !== HOLD.FREE;
    if (this.phase === PHASE.ARRIVING && !held && !s.atRest && tl - this._arrivedAt < FEEL.ARRIVE_NO_CONTACT_MS) return;
    if (this.phase === PHASE.RESPAWN && !held && !s.atRest) return;
    this._setPhase(held ? PHASE.HELD : s.atRest ? PHASE.FLOOR : PHASE.FLIGHT);
  }
  _onLaunchSeen(l, mine) {
    if (l.reason === REASON.RESPAWN) {
      this._setPhase(PHASE.SINKING);
      if (this.sfx) this.sfx.sink();
    } else {
      this.lastLauncher = l.from;
      this._setPhase(PHASE.TRANSIT);
      if (this.sfx) this.sfx.whoosh(this._pan(l.to));
      if (mine) this._chip(l.from, 'THROW', 300);
      if (l.to === this.seat) {
        this._chip(this.seat, 'INCOMING', 600);
        if (this.cues.ghost) {
          const wrapDx = l.edge === EDGE.NONE ? 0 : (this.court.neighbourAt(l.from, l.edge, l.cEdge).wrapDx || 0);
          this.cues.ghost.start({ ...l, x: l.x + wrapDx }, this.clock.now(), (x, y) => this.courtToWorld(x, y, {}), this.court.floorY(this.seat), this.court.R);
        }
      }
    }
    this.predictor.onLaunch(l);
    this.dispatchEvent(evt('launch', { launch: l, mine }));
  }
  /** BallNet found no neighbour across the edge the ball fully left: reflect and push it back inside the rect by R. */
  _onWall(edge, cb) {
    const rect = this._rectOf(this.net.simSeat); if (!rect) return;
    const sph = this.ball.sphere, r = sph.radius;
    if (edge === EDGE.R) { if (sph.vel.x > 0) sph.vel.x *= -FEEL.WALL_RESTITUTION; sph.pos.x = Math.min(sph.pos.x, rect.x1 - r); }
    else if (edge === EDGE.L) { if (sph.vel.x < 0) sph.vel.x *= -FEEL.WALL_RESTITUTION; sph.pos.x = Math.max(sph.pos.x, rect.x0 + r); }
    else if (edge === EDGE.T) { if (sph.vel.y > 0) sph.vel.y *= -FEEL.WALL_RESTITUTION; sph.pos.y = Math.min(sph.pos.y, rect.y1 - r); }
    this.ball.mesh.position.copy(sph.pos);
    this.stats.walls++;
    this.dispatchEvent(evt('wall', { edge, seat: this.net.simSeat }));
  }
  _onGoal(g) {
    if (g.goalNo & POTATO_BIT) return;                             // bursts take the raw path
    const key = (g.goalSeat << 8) | g.goalNo; if (key === this._lastGoalKey) return; this._lastGoalKey = key;
    this._bump(g.scorerSeat, +1); this.stats.goals++;
    if (this.sfx) this.sfx.chime();
    this._cue(g.goalSeat, 'goal'); this._chip(g.goalSeat, 'GOAL', 1200);
    this._say(`GOAL — ${this._name(g.scorerSeat)}`, 'assertive');
    this.dispatchEvent(evt('goal', { scorerSeat: g.scorerSeat, goalSeat: g.goalSeat, potato: false, goalNo: g.goalNo }));
  }
  _onSeatMap(map) {
    const n = map.seats ? map.seats.length : this._nSeats();
    while (this.score.length < n) this.score.push(0);
    const mine = this.court.seatOfClient(this.clientId);
    if (mine >= 0) this.seat = mine;
    this.predictor.mySeat = this.seat;
    // a host-authored ball size / shelf arrived (court.set already read them): follow locally, never republish from here
    const rM = this.court.R * U;
    if (Math.abs(rM - this.radiusM) > 1e-6 && !this.ball.hold && !this.ball.cradle) { this._applyRadius(rM); this.dispatchEvent(evt('ballsize', { radiusM: rM, R: this.court.R })); }
    this._floorRect = null; this._shelvesDirty = true;
    this.dispatchEvent(evt('seatmap', { map }));
  }
  _announceRespawn(c) {
    this._respawnEpoch = c.ownerSeq;
    this._setPhase(PHASE.RESPAWN);
    if (this.sfx) this.sfx.pop(this._pan(c.simSeat));
    this._say(`Ball back to ${this._name(c.simSeat)}`);
    this.dispatchEvent(evt('respawn', { seat: c.simSeat, reason: c.reason }));
  }
  /** a RESPAWN travels as a LAUNCH (reason RESPAWN) and is claimed at the kickoff seat as a BOUNDARY / PROXY claim: still a respawn */
  _viaRespawn(c) {
    const l = this.net.lastLaunch;
    return !!(l && l.reason === REASON.RESPAWN && (c.reason === CLAIM_REASON.BOUNDARY || c.reason === CLAIM_REASON.PROXY) && (c.launchSeq === undefined || c.launchSeq === l.launchSeq));
  }
  _onRespawnLocal(b) { this.dispatchEvent(evt('respawnLocal', { x: b.x, y: b.y })); }   // the RESPAWN claim already went through _onBecameOwner

  // ── PropBall callbacks ──────────────────────────────────────────────────
  _onGrab(slot, type) { this.dispatchEvent(evt('grab', { seat: this.net.simSeat, slot, type })); }
  /** wrap / clip ended THIS frame (inside PropBall.update, hold already null): classify with the holder known BEFORE the frame */
  _onRelease(vel) {
    const how = this._packPresent(this._holderBefore) ? (this._holdTypeBefore || 'wrap') : 'lost';
    this._classify(vel, how);
  }
  _classify(vel, how) {
    const c = classifyRelease(vel, how, U);
    this.ball.sphere.vel.copy(c.vel);
    this._reason = c.reason;
    if (how === 'lost') this.stats.lostDrops++;
    if (c.clamped) this.stats.clamped++;
    if (c.kind === 'throw') { this.stats.throws++; this._chip(this.net.simSeat, c.clamped ? 'THROW·max' : 'THROW', 300); }
    else { this.stats.drops++; this._chip(this.net.simSeat, how === 'lost' ? 'LOST' : 'DROP', 300); }
    this.dispatchEvent(evt('release', { how, kind: c.kind, clamped: c.clamped, speedU: c.speedU }));
  }
  /** bounds safety net (prop-ball.js onExit): a court edge after all → tickOwner (LAUNCH / onWall); else recentre locally */
  _onPropExit(info) {
    const net = this.net;
    if (!net.isOwner) return;
    if (net.inTransit) {                                           // the LAUNCH already went out: keep the wire honest, hide the reset ball
      const cb = toCourtBall(this.court, net.simSeat, this._uvCam(net.simSeat), { pos: info.pos, vel: info.vel, angVel: info.angVel }, null, {}, { mirroredInput: MIRRORED_INPUT });
      this._parked = { x: cb.x, y: cb.y, vx: cb.vx, vy: cb.vy };
      this.ball.mesh.visible = false;
      return;
    }
    const r = onPropExit(net, this.court, this._uvCam(net.simSeat), info, null, { mirroredInput: MIRRORED_INPUT });
    this.dispatchEvent(evt('exit', { edge: r.edge, neighbour: r.neighbour }));
    if (r.edge !== EDGE.NONE && net.inTransit) { this._parked = { x: r.courtBall.x, y: r.courtBall.y, vx: r.courtBall.vx, vy: r.courtBall.vy }; this.ball.mesh.visible = false; }
  }

  // ── hot potato ──────────────────────────────────────────────────────────
  _potatoFrame() {
    if (this.mode !== 'potato' || !this.potato || this.net.owner < 0) return;
    const now = this.clock.now(), remain = dt32(this.potato.untilMs, now);
    if (remain <= 5000 && this._potatoWarned < 1) { this._potatoWarned = 1; this._say('Hot potato: 5 seconds'); if (this.sfx) this.sfx.tick(0); }
    if (remain <= 2000 && this._potatoWarned < 2) { this._potatoWarned = 2; this._say('Hot potato: 2 seconds', 'assertive'); if (this.sfx) this.sfx.tick(0); }
    if (remain > 0 || !this.isHost) return;
    const loser = this.net.owner;                                  // whoever owns the ball when the fuse fires
    this._potatoNo = (this._potatoNo + 1) & 0x7f;
    const g = { t: now, goalSeat: loser, scorerSeat: loser, ownerSeq: this.net.ownerSeq, goalNo: this._potatoNo | POTATO_BIT, tGoal: now };
    if (this._tr) this._tr.send(encodeGoal(g, this.net.seq++, FLAG.FROM_HOST), { reliable: true });
    this._applyBurst(g);
  }
  _onRaw(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 16) return;
    const hd = readHeader(buf);
    if (hd.type === PK.CLAIM) {
      // BallNet answers a CLAIM whose epoch it already learned from an earlier BALL_STATE with a NACK and NO hook (ball-net.js
      // CLAIM case). The reliable CLAIM packet itself is read here for the two things only it carries: the hot-potato fuse,
      // which restarts at EVERY CLAIM's tState (SPEC §6.1.6), and the respawn announcement (a RESPAWN LAUNCH is claimed as BOUNDARY).
      if (buf.byteLength < 30) return;
      const c = decodeClaim(buf);
      if (seqNewer8(this.net.ownerSeq, c.ownerSeq) || c.seat !== this.net.owner) return;   // stale epoch / the losing side of a conflict
      if (this.mode === 'potato' && (!this.potato || this.potato.epoch !== c.ownerSeq || this.potato.untilMs !== c.tState + FEEL.POTATO_MS)) {
        this.potato = { untilMs: c.tState + FEEL.POTATO_MS, ownerSeat: c.seat, epoch: c.ownerSeq }; this._potatoWarned = 0;
      }
      if (!this.net.isOwner && this._respawnEpoch !== c.ownerSeq && (c.reason === CLAIM_REASON.RESPAWN || c.reason === CLAIM_REASON.RECOVERY || this._viaRespawn(c))) this._announceRespawn(c);
      return;
    }
    if (hd.type !== PK.GOAL || !(hd.flags & FLAG.FROM_HOST)) return;
    const g = decodeGoal(buf);
    if (!(g.goalNo & POTATO_BIT)) return;
    this._applyBurst(g);
  }
  _applyBurst(g) {
    if (g.goalNo === this._lastBurstNo) return; this._lastBurstNo = g.goalNo;
    const loser = g.scorerSeat;
    this._bump(loser, -1); this.stats.potatoBursts++;
    this.potato = { untilMs: g.tGoal + FEEL.POTATO_MS, ownerSeat: loser, epoch: this.net.ownerSeq }; this._potatoWarned = 0;
    if (this.sfx) { this.sfx.bonk(this._pan(loser), 2); this.sfx.bonk(this._pan(loser), 1); }
    this._cue(loser, 'miss'); this._chip(loser, 'BURST', 1200);
    this._say(`Hot potato! ${this._name(loser)} loses a point`, 'assertive');
    this.dispatchEvent(evt('goal', { scorerSeat: loser, goalSeat: g.goalSeat, potato: true, goalNo: g.goalNo }));
  }

  // ── state ───────────────────────────────────────────────────────────────
  snapshot() {
    const net = this.net, now = this.clock.now();
    const p = this.predictor.read(now);
    return {
      phase: this.phase, mode: this.mode, owner: net.owner, ownerSeq: net.ownerSeq, simSeat: net.ownerSimSeat, isOwner: net.isOwner, inTransit: net.inTransit,
      ball: this.ball.snapshot(), score: this.score.slice(), goal: this.court.map.goal ?? -1, lastLauncher: this.lastLauncher,
      radiusM: this.radiusM, shelfFrac: this.court.shelf, floorY: this.ball.floorY, hands: { left: this.handState('left'), right: this.handState('right') },
      potato: this.potato ? { untilMs: this.potato.untilMs, ownerSeat: this.potato.ownerSeat, remainMs: dt32(this.potato.untilMs, now) } : null,
      leadMs: p ? p.leadMs : null, predicted: p ? p.predicted : null, chip: this.chip ? this.chip.text : null, stats: { ...this.stats },
    };
  }
  dispose() {
    this.running = false;
    this.ball.dispose();
    for (const sh of this.shelves.values()) disposeShelf(sh);
    this.shelves.clear();
    if (this.net.hooks === this.hooks) this.net.hooks = {};
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  _setPhase(to) {
    if (to === this.phase) return;
    const from = this.phase; this.phase = to;
    this.phaseLog.push({ from, to, t: this.clock.local() }); if (this.phaseLog.length > 64) this.phaseLog.shift();
    this.dispatchEvent(evt('phase', { from, to }));
  }
  _chip(seat, text, ms) {
    if (!text) { if (this.chip) { this.chip = null; this.dispatchEvent(evt('chip', { seat, text: null })); } return; }
    this.chip = { seat, text, until: ms > 0 ? this.clock.local() + ms : 0 };
    this.dispatchEvent(evt('chip', { seat, text, ms }));
  }
  _chipFrame() { if (this.chip && this.chip.until && this.clock.local() > this.chip.until) this._chip(this.chip.seat, null, 0); }
  _cue(seat, kind) {
    if (this.cues.miss) { const rects = this.domRects(); if (rects && rects[seat]) this.cues.miss.show(rects[seat], kind, this.colorOf(seat)); }
    this.dispatchEvent(evt('ring', { seat, kind }));
  }
  _say(text, level = 'polite') { if (this.announce) this.announce(text, level); }
  _name(seat) { const s = this.court.map.seats && this.court.map.seats[seat]; return (s && s.name) || ('seat ' + seat); }
  _nSeats() { return this.court.map.seats ? this.court.map.seats.length : 0; }
  _bump(seat, d) { while (this.score.length <= seat) this.score.push(0); this.score[seat] += d; }
  _rectOf(seat) { try { return this.tileWorldRect ? this.tileWorldRect(seat) : null; } catch { return null; } }
  _uvCam(seat) { return this.uvCamOf(seat); }
  _courtPos(seat) { const uv = this.court.worldToTile(this.ball.sphere.pos, this._uvCam(seat), {}); return this.court.tileToCourt(seat, uv.u, uv.v, MIRRORED_INPUT, {}); }
  _packPresent(slot) { if (!slot) return false; const pk = slot === 'left' ? this._packs.L : this._packs.R; return packOk(pk); }
  /** mesh-true contact (6 mm skin) of a pack OR its palm fill with the ball (the fill is the palm's surface: a ball resting on it is touched) */
  _touch(pk, fill) {
    const ball = this.ball;
    if (packOk(pk) && hullTouch(ball.hull, ball.mesh, pk) <= 0.006) return true;
    if (fill && fill.present && ball.hull.begin(ball.mesh).handGap(fill.joints, fill.radii).gap <= 0.006) return true;
    return false;
  }
  _anyTouch(L, R) { return this._touch(L, this.palmFill.left) || this._touch(R, this.palmFill.right); }
  _pan(seat) {
    const rects = this.domRects(); if (!rects || !rects[seat]) return 0;
    let w = 0; for (const r of rects) if (r) w = Math.max(w, r.left + r.width);
    return w > 0 ? panForTile(rects[seat], w) : 0;
  }
  /** matcap sphere in the browser (a procedural matcap, no assets); the lane's banded shader ball in Node */
  _makeMesh(R) {
    if (!this.scene || typeof document === 'undefined') return makeBallMesh(R);
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(44, 40, 6, 64, 64, 72);
    grad.addColorStop(0, '#f4f8ff'); grad.addColorStop(0.35, '#7fb6ff'); grad.addColorStop(0.8, '#1b4f9c'); grad.addColorStop(1, '#0b2247');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 20), new THREE.MeshMatcapMaterial({ matcap: tex }));
    mesh.name = 'gameBall';
    return mesh;
  }
}
