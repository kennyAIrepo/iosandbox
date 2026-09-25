/**
 * sdk/game/ball-round.js — the engine's ball ROUND: GO! → INCOMING → CATCH → SHOOT → GOAL.
 * ─────────────────────────────────────────────────────────────────────────────
 * Node-safe: plain {x,y,z} in, plain data out, no three import, no DOM, no timers.
 * The page owns the ball (PropBall), the hands (packs) and the hoop; this module
 * owns two pieces of math and one state machine:
 *
 *   solveLaunch(from, to, opts)  the initial velocity that lands a ball at `to`
 *                                after T seconds UNDER THE PAGE'S OWN INTEGRATOR
 *                                (GrabbableSphere.update: v.y += g·dt; v *= drag;
 *                                p += v·dt). Position is linear in v0, so it is
 *                                exact — no iteration, no closed-form-without-drag
 *                                undershoot.
 *   goalTest(prev, cur, rim, r)  the ball centre crossed the rim plane DOWNWARD
 *                                inside the ring this frame.
 *   BallRound                    the round: observations in (ball, hand target,
 *                                rim), cue + orders out. Timing comes from the
 *                                caller's clock, so a probe can drive it.
 */

/** Initial velocity so the integrator lands the ball at `to` after ~T seconds. */
export function solveLaunch(from, to, { g = -9.0, drag = 0.996, dt = 1 / 60, T = 1.1 } = {}) {
  const n = Math.max(1, Math.round(T / dt));
  let A = 0, v = 1;                       // unit velocity, no gravity → displacement per unit v0
  for (let i = 0; i < n; i++) { v *= drag; A += v * dt; }
  let Gy = 0, vy = 0;                     // zero velocity, gravity only → the drop
  for (let i = 0; i < n; i++) { vy += g * dt; vy *= drag; Gy += vy * dt; }
  return { vx: (to.x - from.x) / A, vy: (to.y - from.y - Gy) / A, vz: (to.z - from.z) / A, T: n * dt, steps: n };
}

/** Run the page's integrator forward (for tests and previews). */
export function flyPath(from, v0, { g = -9.0, drag = 0.996, dt = 1 / 60, steps = 66 } = {}) {
  const p = { x: from.x, y: from.y, z: from.z }, v = { x: v0.vx ?? v0.x, y: v0.vy ?? v0.y, z: v0.vz ?? v0.z };
  const out = [];
  for (let i = 0; i < steps; i++) {
    v.y += g * dt; v.x *= drag; v.y *= drag; v.z *= drag;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
    out.push({ x: p.x, y: p.y, z: p.z });
  }
  return out;
}

/**
 * Did the ball centre pass DOWN through the rim this frame?
 * rim = { x, y, z, r } (world, ring in the horizontal plane). A made shot has the
 * centre inside the ring at the crossing with the ball's own radius to spare
 * (regulation: Ø45.7 cm ring, Ø24 cm ball — a clean swish has ~10 cm each side).
 */
export function goalTest(prev, cur, rim, ballR = 0.12) {
  if (!prev || !cur || !rim) return false;
  if (!(prev.y > rim.y && cur.y <= rim.y)) return false;         // crossing the plane, downward
  const t = (prev.y - rim.y) / Math.max(1e-9, prev.y - cur.y);   // where on the segment
  const x = prev.x + (cur.x - prev.x) * t, z = prev.z + (cur.z - prev.z) * t;
  const d = Math.hypot(x - rim.x, z - rim.z);
  return d <= Math.max(0.02, rim.r - ballR * 0.5);
}

/** Where a launch comes FROM: under the rim if there is one, else `ahead` (a point the page picks). */
export function launchOrigin(rim, toward, ahead) {
  if (rim) {
    // from just below the rim, stepped toward the catcher so it never clips the ring
    const dx = toward.x - rim.x, dz = toward.z - rim.z, L = Math.hypot(dx, dz) || 1;
    return { x: rim.x + dx / L * 0.6, y: rim.y - 0.35, z: rim.z + dz / L * 0.6 };
  }
  return ahead;
}

export const ROUND_CUES = {
  idle:     { big: '',           sub: '' },
  go:       { big: 'GO!',        sub: 'hands up — the ball is coming to you' },
  incoming: { big: 'CATCH!',     sub: 'open your hands where it lands — it finds your palm', gesture: 'catch' },
  caught:   { big: 'CAUGHT ✓',   sub: 'aim at the hoop', then: { at: 0.9, big: 'AIM!', sub: 'throw it through the rim', gesture: 'throw' } },
  shot:     { big: 'SHOOT!',     sub: 'in the air…' },
  goal:     { big: 'GOAL!',      sub: 'again — it comes right back' },
  miss:     { big: 'MISS',       sub: 'no worries — incoming again' },
  lost:     { big: 'DROPPED',    sub: 'it comes back to you' },
};

export class BallRound {
  /**
   * @param {object} o  goT (s) cue before launch · flightT (s) launch flight time ·
   *                    catchT (s) after arrival before it counts as dropped ·
   *                    shotT (s) after release before it counts as a miss ·
   *                    holdCue (s) how long GOAL/MISS stays up · auto: loop rounds
   */
  constructor(o = {}) {
    this.o = { goT: 0.9, flightT: 1.15, catchT: 3.0, shotT: 6.0, holdCue: 1.6, auto: true, ...o };
    this.state = 'idle'; this.t0 = 0; this.score = 0; this.streak = 0; this.shots = 0; this.catches = 0; this.rounds = 0;
    this.best = 0; this._prev = null; this._log = [];
  }
  start(now) { this.state = 'go'; this.t0 = now; this.rounds++; this._prev = null; return this._out(now); }
  stop(now) { this.state = 'idle'; this._prev = null; return this._out(now); }
  get on() { return this.state !== 'idle'; }
  /** the plain read-out for HUDs / probes */
  /** how long the current phase can last (s) — the round bar drains over it; null = open-ended */
  phaseT() {
    const o = this.o;
    switch (this.state) {
      case 'go': return o.goT; case 'incoming': return o.flightT + o.catchT; case 'shot': return o.shotT;
      case 'goal': case 'miss': case 'lost': return o.holdCue; default: return null;
    }
  }
  _out(now, launch = null) {
    const c = ROUND_CUES[this.state] || ROUND_CUES.idle;
    const pt = this.phaseT();
    return { state: this.state, big: c.big, sub: c.sub, gesture: c.gesture || '', launch, score: this.score, streak: this.streak, shots: this.shots,
             catches: this.catches, rounds: this.rounds, best: this.best, age: +(now - this.t0).toFixed(2),
             phaseT: pt, phase: pt ? Math.min(1, Math.max(0, (now - this.t0) / pt)) : 0 };
  }
  _go(now, state) { this.state = state; this.t0 = now; this._log.push([+now.toFixed(2), state]); if (this._log.length > 64) this._log.shift(); }
  /**
   * One frame. `ball` = { pos:{x,y,z}, vel:{x,y,z}, held:bool, r:number, floorY:number }
   * `target` = the hand to throw to ({x,y,z}) or null · `rim` = { x,y,z,r } or null.
   * Returns the read-out; `launch` (when set) is an ORDER: { to, T } — the page
   * solves the velocity with its own g/drag and sets the ball flying.
   */
  tick(now, ball, target, rim) {
    const o = this.o, age = now - this.t0;
    let launch = null;
    const resting = ball && ball.pos.y <= ball.floorY + ball.r + 0.012 && Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z) < 0.35;
    switch (this.state) {
      case 'idle': break;
      case 'go':
        if (age >= o.goT) {
          if (!target) { this.t0 = now; break; }                  // no hand yet: hold the cue
          launch = { to: { x: target.x, y: target.y, z: target.z }, T: o.flightT };
          this._go(now, 'incoming');
        }
        break;
      case 'incoming':
        if (ball && ball.held) { this.catches++; this._go(now, 'caught'); }
        else if (age > o.flightT + o.catchT || (age > o.flightT + 0.4 && resting)) { this.streak = 0; this._go(now, 'lost'); }
        break;
      case 'caught':
        if (ball && !ball.held) { this._prev = { ...ball.pos }; this._go(now, 'shot'); }
        break;
      case 'shot':
        if (ball && ball.held) { this._go(now, 'caught'); break; }   // took it back before it left
        if (ball && rim && goalTest(this._prev, ball.pos, rim, ball.r)) {
          this.score++; this.streak++; this.shots++; this.best = Math.max(this.best, this.streak); this._go(now, 'goal');
        } else if (age > o.shotT || (age > 0.6 && resting)) { this.shots++; this.streak = 0; this._go(now, 'miss'); }
        if (ball) this._prev = { ...ball.pos };
        break;
      case 'goal': case 'miss': case 'lost':
        if (age >= o.holdCue) { if (o.auto) { this.rounds++; this._go(now, 'go'); } else this._go(now, 'idle'); }
        break;
    }
    return this._out(now, launch);
  }
}

/**
 * THE CALL — an open hand held still calls a free ball to it. Scale-free and
 * pose-light on purpose: stillness (< `still` metres over `hold` seconds) and an
 * open hand (closure < `open`) are the whole gesture. Returns true ONCE when the
 * hold completes; the caller launches and the tracker re-arms after `refractory`.
 */
export class CallGesture {
  constructor(o = {}) {
    this.o = { hold: 0.7, still: 0.04, open: 0.3, refractory: 2.0, ...o };
    this._s = { left: null, right: null }; this._firedT = -9;
  }
  /** @param {string} slot @param {{x,y,z}} palm @param {number} closure 0 open … 1 fist @param {number} now seconds */
  tick(slot, palm, closure, now) {
    const S = this._s[slot] || (this._s[slot] = { x: 0, y: 0, z: 0, t: -1 });
    if (!palm || closure > this.o.open) { S.t = -1; return false; }
    if (S.t < 0 || Math.hypot(palm.x - S.x, palm.y - S.y, palm.z - S.z) > this.o.still) { S.x = palm.x; S.y = palm.y; S.z = palm.z; S.t = now; return false; }
    if (now - S.t >= this.o.hold && now - this._firedT >= this.o.refractory) { this._firedT = now; S.t = -1; return true; }
    return false;
  }
  drop(slot) { if (this._s[slot]) this._s[slot].t = -1; }
}
