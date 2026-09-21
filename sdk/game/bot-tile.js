/**
 * bot-tile.js — a scripted seat for the Teams twin (Node + browser). Imports only court-map.js, ball-net.js,
 * ../net/hand-stream.js and pack-gen.js — no three.js, no DOM, no timers: everything advances from `tick(nowLocal)`.
 * ─────────────────────────────────────────────────────────────────────────────
 * A BotTile is a FULL BallNet client on the same transport as everyone else (ownership / roster fuzz for the protocol) that
 * also streams canned hands (HAND_STREAM 0x30 at `rateHz`), so on every other client it arrives exactly like a tracked
 * person: `RemoteHands` decodes it, the remote tile's own `HandViews` measures chirality on the decoded points.
 *
 * What a bot does with the ball (CONTRACTS §3.10): `onBecameOwner` → it "catches" at once — holds for `holdMs` with the
 * ball on its cup pack (BALL_STATE carries HOLD.CRADLE, HAND_STREAM carries the same hold), then launches toward the
 * next seat by setting the court ball to `{x, y, vx: 1.6, vy: 0.4}` at the hand and letting `tickOwner`'s exitEdge fire
 * (the ring's right neighbour). If it still owns a free ball `throwEvery` ms after its last throw (wall bounce back, a
 * rest, a 2-seat ring) it picks the ball up again and throws again.
 *
 * DOCUMENTED EXCEPTION to the prop doctrine: bots never touch a hull. There is no PropBall, no PropHull, no joint
 * spheres here — the bot's hold is a scripted court-unit position, not a wrap / clip / cradle measured on a pack. Bots
 * exist to exercise BallNet / Room / RemoteHands, never physics. Every real tile (local or remote person) still goes
 * through PropBall's [D1-D7]; the ball a bot throws ARRIVES at a person's tile as a normal claim and is caught by the
 * doctrine pickup there.
 *
 * Hands: `PackGen.cup` while holding, `PackGen.open` otherwise, waved along a slow figure-eight in the bot's own tile
 * world (hand plane z = -D at the origin of a duck-typed uv camera), converted with `packToHands` — the exact inverse
 * of HandViews.mirrorPoint — so nothing is flipped or relabelled (checkpoint [C1] / [W1]).
 */
import { EDGE, integrateCourt } from './court-map.js';
import { BallNet, HOLD } from './ball-net.js';
import { encodeHandStream } from '../net/hand-stream.js';
import { PackGen, packToHands } from './pack-gen.js';

export const BOT = Object.freeze({
  D: 2.0,                 // hand-plane distance (HandViews.cfg.mirrorDist; court-space.js D)
  FOV: 50,                // vertical fov of every tile camera (court-space.js FOV)
  MIRRORED_INPUT: false,  // court-space.js MIRRORED_INPUT (D-A: the court is defined in the displayed, self-view space)
  FIG8_X: 0.35,           // figure-eight half-width (m)
  FIG8_Y: 0.10,           // figure-eight half-height (m)
  FIG8_PERIOD_MS: 4000,   // one full figure-eight
  V_MAX: 3.0,             // THROW.V_MAX_OUT — the throw is scaled up to this if predictExit says it would rest inside
  SUBSTEP: 1 / 60,
});

/** A duck-typed uv camera at the origin looking down -z (fov / aspect / matrixWorldInverse — all packToHands reads). */
export function identityCamera(aspect = 16 / 9, fov = BOT.FOV) {
  return { fov, aspect, matrixWorldInverse: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } };
}

const PALM = [0, 5, 9, 17];

export class BotTile {
  /**
   * @param {object} o
   * @param {{id?:string, send:Function, onMessage:Function}} o.transport   shared with Room / RemoteHands
   * @param {import('./ball-net.js').SharedClock} o.clock
   * @param {import('./court-map.js').CourtMap} o.court     initially a self map (v 0); refreshed by SEAT_MAP
   * @param {number} o.seat            my seat in `court` (re-read from every SEAT_MAP)
   * @param {string} o.clientId
   * @param {boolean} o.waitForSeatMap hands + ownership start only after the host's first SEAT_MAP (default true, so a bot's
   *                                   provisional self-map seat never collides with the host's seat 0 on the wire)
   * @param {{onThrow?:Function, onCatch?:Function}} o.hooks
   */
  constructor({ transport, clock, court, seat = 0, clientId, name = 'Bot', holdMs = 800, throwEvery = 6000, rateHz = 30, rng = Math.random,
    aspect = 16 / 9, waitForSeatMap = true, throwVx = 1.6, throwVy = 0.4, hooks = {} } = {}) {
    this.tr = transport; this.clock = clock; this.court = court; this.seat = seat; this.clientId = clientId; this.name = name;
    this.holdMs = holdMs; this.throwEvery = throwEvery; this.rateHz = rateHz; this.rng = rng; this.aspect = aspect;
    this.throwVx = throwVx; this.throwVy = throwVy; this.hooks = hooks;
    this.cam = identityCamera(aspect);
    this.seated = !waitForSeatMap;
    this.ball = null; this.holding = false; this.holdUntil = 0; this.lastThrowAt = -Infinity;
    this.hold = null;                                      // HAND_STREAM hold byte source {mode, slot}
    this.phase = rng() * BOT.FIG8_PERIOD_MS;               // bots do not wave in lockstep
    this.disposed = false;
    this._seq = 0; this._lastSend = -Infinity; this._last = -Infinity; this._sent = 0; this._throws = 0; this._catches = 0;
    this._hc = { x: 0, y: 0 };
    this.net = new BallNet({ transport, clock, court, seat, clientId, isHost: false, rateHz, hooks: {
      onBecameOwner: c => this._onBecameOwner(c),
      onLostOwner: () => { this.ball = null; this.holding = false; this.hold = null; },
      onWall: (edge, b) => { if (edge === EDGE.T) b.vy = -Math.abs(b.vy) * 0.5; else b.vx = -b.vx * 0.5; },
      onSeatMap: () => { this.seat = this.net.seat; this.seated = this.seat >= 0; if (!this.seated) { this.ball = null; this.holding = false; this.hold = null; } },
    } });
  }

  get stats() { return { sent: this._sent, claims: this.net.stats.claims, launches: this.net.stats.launches, throws: this._throws, catches: this._catches }; }

  /** Canned hands at local time t (ms): `{ left: null, right: {img, world} }` — cup while holding, open otherwise. */
  hands(t) {
    const a = ((t + this.phase) / BOT.FIG8_PERIOD_MS) * Math.PI * 2;
    const x = BOT.FIG8_X * Math.sin(a), y = BOT.FIG8_Y * Math.sin(2 * a);
    const pack = this.holding ? PackGen.cup(x, y, -BOT.D) : PackGen.open(x, y, -BOT.D);
    return packToHands(pack, this.cam, { slot: 'right', mirrorDist: BOT.D });
  }

  /** One step: HAND_STREAM at rateHz (when seated), owner physics + tickOwner while I own the ball, net.tick(). */
  tick(nowLocal = this.clock.local()) {
    if (this.disposed) return;
    const now = nowLocal;
    const dt = this._last === -Infinity ? 0 : Math.max(0, (now - this._last) / 1000);
    this._last = now;
    let hands = null;
    if (this.seated && now - this._lastSend >= 1000 / this.rateHz) {
      this._lastSend = now;
      hands = this.hands(now);
      this.tr.send(encodeHandStream(this.seat, hands, this._seq++ & 0xffff, this.clock.now(), { hold: this.hold }), { reliable: false });
      this._sent++;
    }
    if (this.net.isOwner && this.ball) {
      this._simulate(now, dt, hands || this.hands(now));
      this.net.tickOwner(this.ball);
    }
    this.net.tick();
  }

  dispose() { this.disposed = true; this.ball = null; this.holding = false; this.hold = null; }

  // ── internals ─────────────────────────────────────────────────────────────
  _onBecameOwner(c) {
    if (this.disposed) return;
    const R = this.court.R;
    this.ball = { x: c.x, y: c.y, d: c.d ?? 0, vx: c.vx, vy: c.vy, vd: c.vd ?? 0, wx: 0, wy: 0, wz: 0, radius: R, atRest: false, onFloor: false, hold: null };
    if (!this.seated) { this.ball = null; return; }        // provisional seat: never simulate on the wire (host recovery takes over)
    this._grab(this.clock.local());
  }

  _grab(now) {
    this.holding = true; this.holdUntil = now + this.holdMs; this._catches++;
    this.hold = { mode: HOLD.CRADLE, slot: 'right' };
    this.hooks.onCatch?.(this);
  }

  /** court position of the palm centre of the hand pack just sent (img → tileToCourt at MY seat, no flip: BOT.MIRRORED_INPUT) */
  _handCourt(hands, out) {
    const img = hands.right.img;
    let u = 0, v = 0;
    for (const i of PALM) { u += img[i].x; v += img[i].y; }
    return this.court.tileToCourt(this.seat, u / PALM.length, v / PALM.length, BOT.MIRRORED_INPUT, out);
  }

  _simulate(now, dt, hands) {
    const b = this.ball, seat = this.net.simSeat, R = b.radius, fy = this.court.floorY(seat);
    if (this.holding) {
      const h = this._handCourt(hands, this._hc);
      if (now < this.holdUntil) {
        // ball rides on the cup pack: cradle pocket = palm + R (court units); at rest relative to the hand
        b.x = h.x; b.y = h.y + R; b.vx = 0; b.vy = 0; b.atRest = false; b.onFloor = false;
        b.hold = { mode: HOLD.CRADLE, slot: 1, ox: 0, oy: 0.5, oz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
        return;
      }
      // release toward the next seat: open hand, ball leaves the pocket with the scripted throw velocity
      this.holding = false; this.hold = null; this.lastThrowAt = now; this._throws++;
      let vx = this.throwVx, vy = this.throwVy;
      for (let k = 0; k < 6; k++) {                        // rest-inside guard: scale up (≤ V_MAX) until predictExit says it leaves
        const p = this.court.predictExit(seat, h.x, h.y + R, vx, vy, this.clock.now(), R);
        if (p && p.edge !== EDGE.NONE) break;
        if (Math.hypot(vx, vy) >= BOT.V_MAX) break;
        vx *= 1.25; vy *= 1.1;
      }
      const cap = Math.hypot(vx, vy); if (cap > BOT.V_MAX) { vx *= BOT.V_MAX / cap; vy *= BOT.V_MAX / cap; }
      b.x = h.x; b.y = h.y + R; b.vx = vx; b.vy = vy; b.hold = null; b.atRest = false; b.onFloor = false;
      this.hooks.onThrow?.(this, { x: b.x, y: b.y, vx, vy });
      return;
    }
    // free ball in my rect (or already past the edge while the LAUNCH handoff completes): court-unit physics
    let remain = dt;
    while (remain > 1e-6) { const s = Math.min(BOT.SUBSTEP, remain); integrateCourt(b, s, fy, R); remain -= s; }
    b.onFloor = b.y <= fy + R + 1e-3;
    b.atRest = b.onFloor && Math.hypot(b.vx, b.vy) < 0.1;
    if (!this.net.inTransit && now - this.lastThrowAt >= this.throwEvery) this._grab(now);   // pick it up again and throw again
  }
}
