/**
 * hopeOS SDK — Lizard2DRig (procedural 2D mock-3D puppet)
 * ═══════════════════════════════════════════════════════════════
 * The PUPPET half of the 2D lizard movement contract, executable —
 * the canvas-2D sibling of quadruped.js. Consumes the SAME human-side
 * channels (BodyProbe values + PuppetInput face state + gesture events);
 * instead of driving GLB bones it poses a procedural lizard in a tiny
 * 3D-ish world space (x lateral, y up, z depth) and draws itself through
 * a pinhole projection with painter z-sorting, gradient "cylinder"
 * shading, rim light and contact shadows — 2D that reads as 3D.
 *
 * World-space conventions (shared with the game page):
 *   +z = away from camera (lizard faces away, back POV)
 *   1 unit = one lizard body length (snout→tail-base)
 *   origin = lizard root on the branch surface; the GAME owns the
 *   camera + world scroll; the rig only poses/draws in local space.
 *
 * Channels executed here (assets/lizard/lizard2d.body.contract.json):
 *   limb.*.raise   → foot lift + step cycles (gait_step)
 *   body.crouch    → belly hug + leap-coil (body_lower)
 *   head.rot       → aim turret (yaw/pitch) — the hunt controller
 *   mouth.open     → jaw hinge (arms the tongue)
 *   tongue.out     → live tongue length, SAME-LENGTH rule 1:1
 *   eye.blink      → eyelids
 * Derived events (detected game-side per contract.derived_events):
 *   rig.fireTongue(power)   ← tongue.shoot
 *   rig.setAirborne(phase)  ← leap.hop flight (game moves the root)
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const D2R = Math.PI / 180;

// palette — warm-lit green lizard, painterly not flat
const C = {
  flank: '#7fae3e', flankLit: '#a8cf62', dorsal: '#4c7f28', dorsalDeep: '#35611c',
  belly: '#cfe09a', stripe: '#2e5518', band: '#6d9a35',
  throat: '#e4ecb0', eye: '#1c1408', eyeRing: '#e8b53a', lid: '#6d9a35',
  mouthIn: '#5e1f2c', tongue: '#f0566f', tongueDark: '#c23a52',
  claw: '#3a3220', shadow: 'rgba(20,26,8,0.28)'
};

const LIMBS = {
  frontL: { side: -1, zRoot: 0.34, ch: 'limb.armL.raise' },
  frontR: { side: 1, zRoot: 0.34, ch: 'limb.armR.raise' },
  hindL:  { side: -1, zRoot: -0.26, ch: 'limb.legL.raise' },
  hindR:  { side: 1, zRoot: -0.26, ch: 'limb.legR.raise' }
};
// diagonal-couplet order for auto-steps while walking
const COUPLET = { frontL: 'hindR', frontR: 'hindL', hindL: 'frontR', hindR: 'frontL' };

export class Lizard2DRig {
  constructor(contract) {
    this.c = contract;
    this.t = 0;

    // gait
    this.limbs = {};
    for (const [id, def] of Object.entries(LIMBS)) {
      this.limbs[id] = {
        ...def, lift: 0,            // channel-driven manual lift 0..1
        slide: (def.side > 0 ? 0.06 : -0.04) + (id.startsWith('h') ? 0.05 : 0),
        swing: -1,                  // -1 idle, else 0..1 swing phase
        up: false                   // channel above step threshold
      };
    }
    this.cadence = 0; this._steps = []; this._lastStepAt = -1e4;
    this.speed = 0;                 // body-lengths/s, game reads for scroll
    this.baseSpeed = 0;             // auto-run floor (game sets after first hop)
    this.walkW = 0;                 // 0..1 how "walking" we are
    this.phase = 0;                 // undulation phase

    // head / face
    this.yaw = 0; this.pitch = 0;   // degrees, aim turret
    this.jaw = 0; this.blinkL = 0; this.blinkR = 0;
    this.crouch = 0;
    this._saccade = { x: 0, y: 0, t: 0 };
    this.lookHint = null;           // {yaw,pitch} idle interest (nearest fly)

    // tongue state machine
    this.tongue = {
      mode: 'follow', len: 0, liveTarget: 0,
      dir: { x: 0, y: 0, z: 1 },    // unit ray at fire time
      // full extension in ~90ms — kinematic and fast; physics-slow reads mushy
      maxReach: 2.5, speed: 24, power: 1,
      target: null,                 // local-space homing point (aim assist)
      stickAt: 0, stickT: 0, prey: null, retractFrom: 0, retractT: 0
    };
    this.onPreyDelivered = null;    // cb(prey) when retract completes with prey

    // flight / fall pose
    this.air = -1;                  // -1 grounded, else 0..1 leap phase
    this.falling = false;

    this.onStep = null;             // cb(limbId) — game syncs audio/particles
  }

  /* ── contract execution: one call per frame ─────────────────── */
  /**
   * @param {Object} v    BodyProbe.values (contract-keyed measures)
   * @param {Object} face PuppetInput.state (head/mouth/eyes) or null
   * @param {number} dt   seconds
   */
  update(v, face, dt) {
    this.t += dt;
    const gait = this.c.gait;
    const now = this.t * 1000;

    // ── limb channels → lifts + step-cycle detection ──
    for (const [id, L] of Object.entries(this.limbs)) {
      const ch = this.c.channels.find(c => c.puppet.target.limb === id);
      const raw = v?.[L.ch];
      if (raw !== undefined) {
        const rest = ch.map.rest_offset ?? 0;
        L.lift = clamp((raw - rest - ch.map.deadzone) * 1.6, 0, 1);
        const up = (raw - rest) > ch.map.step_threshold;
        if (L.up && !up) this._step(id, now);       // raise→lower = one step
        L.up = up;
      }
      // planted feet slide back under the moving world; swing returns them
      if (L.swing >= 0) {
        L.swing += dt / 0.19;
        if (L.swing >= 1) { L.swing = -1; L.slide = 0.16; }
      } else {
        L.slide -= this.speed * dt;
        if (L.slide < -0.16 && this.walkW > 0.05) this._step(id, now, true);
        L.slide = Math.max(L.slide, -0.2);
      }
    }
    const win = gait.cadence_window_s * 1000;
    this._steps = this._steps.filter(t => now - t < win);
    this.cadence = this._steps.length / gait.cadence_window_s;

    const idleFor = now - this._lastStepAt;
    let targetW = clamp(this.cadence / gait.walk_full_at_cadence, 0, 1);
    if (idleFor > gait.idle_after_ms) targetW = 0;
    // auto-run: an external base speed keeps the gait alive without user steps
    if (this.baseSpeed > 0.01) targetW = Math.max(targetW, 0.85);
    this.walkW += clamp(targetW - this.walkW, -dt * 4, dt * 4);
    this.speed = Math.max(this.baseSpeed, Math.min(this.cadence * 0.34, 1.5)) * (this.air >= 0 ? 2 : 1);
    this.phase += dt * (1.5 + this.speed * 7);

    // ── crouch ──
    this.crouch = lerp(this.crouch, v?.['body.crouch'] ?? 0, Math.min(1, dt * 8));

    // ── head aim (over-unity gain per contract: hunting must feel powerful) ──
    const hc = this.c.channels.find(c => c.id === 'head.rot');
    if (face?.head?.seen) {
      const [lo, hi] = hc.map.clamp_deg;
      // mirrored-selfie: nose to screen-right → away-facing lizard aims ITS screen-right
      this.yaw = lerp(this.yaw, clamp(-face.head.yaw * hc.map.yaw_gain, lo, hi), Math.min(1, dt * 14));
      this.pitch = lerp(this.pitch, clamp(face.head.pitch * hc.map.pitch_gain, lo, hi), Math.min(1, dt * 14));
    } else if (this.lookHint && idleFor > gait.idle_after_ms) {
      // idle interest: the lizard WANTS the fly (contract idle_behavior)
      this.yaw = lerp(this.yaw, this.lookHint.yaw, dt * 2);
      this.pitch = lerp(this.pitch, this.lookHint.pitch, dt * 2);
    }
    // micro-saccades keep the idle head alive
    if (this.t > this._saccade.t) {
      this._saccade = { x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 2, t: this.t + 0.7 + Math.random() * 1.6 };
    }

    // ── jaw + eyes ──
    const mo = face?.mouth?.mouthOpenAmount ?? 0;
    const moc = this.c.channels.find(c => c.id === 'mouth.open').map;
    this.jaw = lerp(this.jaw, clamp(Math.pow(Math.max(0, mo - moc.dead) / (1 - moc.dead), moc.gamma), 0, 1), Math.min(1, dt * 16));
    this.blinkL = lerp(this.blinkL, 1 - (face?.eyes?.left.openAmount ?? 1), Math.min(1, dt * 18));
    this.blinkR = lerp(this.blinkR, 1 - (face?.eyes?.right.openAmount ?? 1), Math.min(1, dt * 18));

    // ── tongue ──
    const tg = this.tongue;
    const tc = this.c.channels.find(c => c.id === 'tongue.out').map;
    const rawT = face?.mouth?.tongueAmount ?? 0;
    tg.liveTarget = clamp(Math.pow(Math.max(0, rawT - tc.dead) / (1 - tc.dead), tc.gamma), 0, 1);
    if (tg.mode === 'follow') {
      // SAME-LENGTH rule: live 1:1 follow (fast lerp only denoises)
      const gate = this.jaw > 0.04 ? 1 : 0.45;      // closed jaw = only a tip peek
      tg.len = lerp(tg.len, tg.liveTarget * tg.maxReach * 0.55 * gate, Math.min(1, dt * 10));
      tg.dir = this._aimDir();
    } else if (tg.mode === 'shoot') {
      tg.len += tg.speed * dt;
      // projectile magnetism: steer the TIP (never the player's aim) toward
      // the locked target, turn rate capped ~600°/s — looks like skill
      if (tg.target) {
        const m = this._bodyPose().mouth;
        const want = norm3(tg.target.x - m.x, tg.target.y - m.y, tg.target.z - m.z);
        const maxTurn = 10.5 * dt;   // rad
        tg.dir = slerpDir(tg.dir, want, maxTurn);
      }
      if (tg.len >= tg.maxReach * tg.power) this._retract(false);
    } else if (tg.mode === 'stick') {
      tg.stickT += dt;
      if (tg.stickT > 0.04) this._retract(true);
    } else if (tg.mode === 'retract') {
      tg.retractT += dt / (tg.prey ? 0.14 : 0.19);
      tg.len = tg.retractFrom * (1 - tg.retractT);
      if (tg.retractT >= 1) {
        tg.len = 0; tg.mode = 'follow';
        if (tg.prey && this.onPreyDelivered) this.onPreyDelivered(tg.prey);
        tg.prey = null;
      }
    }
  }

  _step(id, now, auto = false) {
    const L = this.limbs[id];
    if (L.swing >= 0) return;
    L.swing = 0;
    // only the USER's own raise→lower cycles feed cadence (contract gait
    // rule) — auto/couplet steps are cosmetic, else walking never stops
    if (!auto) { this._steps.push(now); this._lastStepAt = now; }
    if (this.onStep) this.onStep(id, auto);
    // sprawling couplet: a real step nudges its diagonal partner soon after
    if (!auto) {
      const p = this.limbs[COUPLET[id]];
      if (p.swing < 0 && p.slide < 0.02) setTimeout(() => { if (p.swing < 0) this._step(COUPLET[id], now + 90, true); }, 90);
    }
  }

  /* ── hunt actions (called by the game on derived events) ─────── */
  /** Current aim ray (unit, lizard-local == world axes; rig never rotates). */
  aimDir() { return this._aimDir(); }
  _aimDir() {
    const cy = Math.cos(this.yaw * D2R), sy = Math.sin(this.yaw * D2R);
    const cp = Math.cos(this.pitch * D2R), sp = Math.sin(this.pitch * D2R);
    return { x: sy * cp, y: sp, z: cy * cp };
  }

  /** tongue.shoot — ballistic extend along current aim ray.
   *  @param {Object|null} target lizard-LOCAL homing point (aim-assist pick) */
  fireTongue(power = 1, target = null) {
    const tg = this.tongue;
    if (tg.mode !== 'follow') return false;
    tg.mode = 'shoot'; tg.power = clamp(power, 0.7, 1.15);
    tg.dir = this._aimDir(); tg.stickT = 0; tg.target = target;
    return true;
  }

  /** Update the homing point mid-flight (target keeps moving). */
  setTongueTarget(t) { this.tongue.target = t; }
  get tongueBusy() { return this.tongue.mode !== 'follow'; }

  /** Game confirmed a hit: stick the tip to the prey and reel it in. */
  stick(prey, dist) {
    const tg = this.tongue;
    tg.mode = 'stick'; tg.stickT = 0; tg.len = dist; tg.prey = prey;
  }

  _retract(hit) {
    const tg = this.tongue;
    tg.mode = 'retract'; tg.retractFrom = tg.len; tg.retractT = 0; tg.target = null;
  }

  /** Mouth anchor + current tongue tip in LIZARD-LOCAL space. */
  mouthLocal() {
    const b = this._bodyPose();
    return b.mouth;
  }
  tongueTipLocal() {
    const b = this._bodyPose(), tg = this.tongue;
    const droop = tg.mode === 'follow' ? tg.len * tg.len * 0.10 : tg.len * tg.len * 0.025;
    return {
      x: b.mouth.x + tg.dir.x * tg.len,
      y: b.mouth.y + tg.dir.y * tg.len - droop,
      z: b.mouth.z + tg.dir.z * tg.len
    };
  }

  /** Auto-run floor speed (body-lengths/s) — user steps still boost above it. */
  setBaseSpeed(v) { this.baseSpeed = Math.max(0, v); }

  /** Leap flight (game moves root): phase 0..1, or -1 when grounded. */
  setAirborne(p) { this.air = p; }
  setFalling(f) { this.falling = f; }

  /* ── pose solve (lizard-local) ──────────────────────────────── */
  _bodyPose() {
    const breathe = Math.sin(this.t * 2.4) * 0.008;
    const sprawlH = lerp(0.11, 0.035, this.crouch) + breathe;
    const undA = lerp(0.022, 0.085, this.walkW);
    const airK = this.air >= 0 ? Math.sin(this.air * Math.PI) : 0;
    const sway = z => Math.sin(this.phase + z * 4.2) * undA * (1 - airK);
    // spine sample points, tail tip (near camera) → snout (far)
    const spine = [];
    for (let i = 0; i <= 8; i++) {
      const z = lerp(-0.55, 0.58, i / 8);
      spine.push({
        x: sway(z), z,
        y: sprawlH + (this.air >= 0 ? airK * 0.06 * (z + 0.5) : 0),
        // slim + long — the reptile silhouette (round = frog)
        r: 0.055 + 0.07 * Math.sin(Math.PI * clamp((z + 0.47) / 1.16, 0.04, 0.96))
      });
    }
    const neck = spine[8];
    const yawR = this.yaw * D2R, pitR = this.pitch * D2R;
    const headLen = 0.28;                     // long snout = reptile
    const head = {
      x: neck.x + Math.sin(yawR) * headLen,
      y: neck.y + Math.sin(pitR) * headLen + 0.02,
      z: neck.z + Math.cos(yawR) * Math.cos(pitR) * headLen
    };
    const mouth = {
      x: neck.x + Math.sin(yawR) * (headLen + 0.1),
      y: neck.y + Math.sin(pitR) * (headLen + 0.1) - this.jaw * 0.03,
      z: neck.z + Math.cos(yawR) * (headLen + 0.1)
    };
    return { spine, neck, head, mouth, sprawlH, sway, airK };
  }

  _limbPose(id, body) {
    const L = this.limbs[id];
    const front = id.startsWith('f');
    const zR = L.zRoot, side = L.side;
    const shoulder = { x: body.sway(zR) + side * 0.10, y: body.sprawlH + 0.03, z: zR };
    // swing arc or planted slide; manual lift rides on top
    // feet stay ON the branch top (halfwidth ~0.17) — no mid-air dangle
    let footZ = zR + L.slide, footY = 0, footX = side * lerp(0.18, 0.15, this.crouch);
    if (L.swing >= 0) {
      const s = L.swing;
      footZ = zR + lerp(-0.16, 0.16, s);
      footY = Math.sin(s * Math.PI) * 0.10;
    }
    footY = Math.max(footY, L.lift * 0.14);
    if (this.air >= 0) {  // tucked then splayed in flight
      const k = body.airK;
      footY = 0.06 + k * 0.07; footZ = zR + (front ? 0.12 : -0.12) * k; footX = side * (0.16 + k * 0.1);
    }
    if (this.falling) {
      footY = 0.1 + Math.sin(this.t * 22 + zR * 9 + side) * 0.06;
      footX = side * (0.26 + Math.cos(this.t * 19 + zR * 7) * 0.07);
    }
    // sprawl elbow/knee: front points slightly up-out; hind knee points
    // out-back and LOW (frog knees hug high — lizard knees sprawl)
    const elbow = {
      x: (shoulder.x + footX) / 2 + side * (front ? 0.07 : 0.10),
      y: Math.max(shoulder.y, footY) + (front ? 0.035 : 0.018),
      z: (shoulder.z + footZ) / 2 + (front ? 0.02 : -0.06)
    };
    return { shoulder, elbow, foot: { x: footX, y: footY, z: footZ }, side, front };
  }

  _tailPose(body) {
    const pts = [];
    const airWhip = this.air >= 0 ? Math.sin(this.air * Math.PI) : 0;
    for (let i = 0; i <= 6; i++) {
      const f = i / 6, z = -0.55 - f * 0.72;
      // grounded: tip curls up a little AND snakes SIDEWAYS in a static S —
      // from the back POV the lateral sweep is what reads "lizard"
      const curl = this.air < 0 && !this.falling ? f * f * 0.18 : 0;
      const sSweep = Math.sin(f * 2.4) * 0.09 * (1 - airWhip);
      pts.push({
        x: body.sway(z) * (1 + f * 0.8) + sSweep + Math.sin(this.phase * 0.7 - f * 2.6) * 0.10 * f * (1 - airWhip),
        y: body.sprawlH * (1 - f * 0.55) + curl + airWhip * f * 0.16 + (this.falling ? Math.sin(this.t * 14 + f * 5) * 0.08 * f : 0),
        z, r: 0.09 * (1 - f * 0.88) + 0.004
      });
    }
    return pts;
  }

  /* ── draw: painter-sorted parts through the game's projector ──
   *  proj: {P(x,y,z)→{x,y,s} screen pt + scale, lit(z)→0..1 fog-lit}
   *  `which`: 'all' | 'body' | 'tail' — the tail extends ~1 body-length
   *  toward the camera, so the game must z-sort it SEPARATELY from the
   *  body or nearer branch segments paint over it. */
  draw(ctx, proj, worldPos, which = 'all') {
    const b = this._bodyPose();
    const W = (p) => proj.P(worldPos.x + p.x, worldPos.y + p.y, worldPos.z + p.z);
    const parts = [];

    if (which === 'tail') {
      const tail = this._tailPose(b);
      this._drawTail(ctx, W, tail, proj);
      return;
    }

    // contact shadow on branch (drawn first, always under)
    if (this.air < 0 && !this.falling) {
      const s0 = W({ x: 0, y: 0.005, z: 0 });
      const sN = W({ x: 0, y: 0.005, z: 0.45 }), sT = W({ x: 0, y: 0.005, z: -0.9 });
      ctx.save();
      const g = ctx.createRadialGradient(s0.x, s0.y, 0, s0.x, s0.y, Math.abs(sT.y - sN.y) * 0.75 + 8);
      g.addColorStop(0, C.shadow); g.addColorStop(1, 'rgba(20,26,8,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(s0.x, s0.y, s0.s * 0.20, Math.max(4, Math.abs(sT.y - sN.y) * 0.35), 0, 0, 7);
      ctx.fill(); ctx.restore();
    }

    // ── tongue (extends beyond head → farthest, draw before head) ──
    const tg = this.tongue;
    if (tg.len > 0.015) {
      parts.push({ z: b.mouth.z + tg.dir.z * tg.len, draw: () => this._drawTongue(ctx, W, b) });
    }

    // ── head ──
    parts.push({ z: b.head.z, draw: () => this._drawHead(ctx, W, b, proj) });

    // ── limbs + torso slices interleaved by z ──
    for (const id of Object.keys(LIMBS)) {
      const lp = this._limbPose(id, b);
      parts.push({ z: lp.elbow.z + 0.01, draw: () => this._drawLimb(ctx, W, lp, proj) });
    }
    parts.push({ z: 0.1, draw: () => this._drawTorso(ctx, W, b, proj) });

    if (which === 'all') {
      const tail = this._tailPose(b);
      parts.push({ z: tail[3].z, draw: () => this._drawTail(ctx, W, tail, proj) });
    }

    parts.sort((a, b2) => b2.z - a.z);       // far first
    for (const p of parts) p.draw();
  }

  _drawTongue(ctx, W, b) {
    const tg = this.tongue;
    const m = W(b.mouth), tip = W(this.tongueTipLocal());
    // sag control point
    const midL = this.tongueTipLocal();
    const cpt = W({ x: (b.mouth.x + midL.x) / 2, y: (b.mouth.y + midL.y) / 2 - (tg.mode === 'follow' ? tg.len * 0.06 : 0.01), z: (b.mouth.z + midL.z) / 2 });
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.tongueDark;
    ctx.lineWidth = Math.max(1.2, m.s * 0.030);
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.quadraticCurveTo(cpt.x, cpt.y, tip.x, tip.y); ctx.stroke();
    ctx.strokeStyle = C.tongue;
    ctx.lineWidth = Math.max(0.8, m.s * 0.018);
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.quadraticCurveTo(cpt.x, cpt.y, tip.x, tip.y); ctx.stroke();
    // forked / clubbed tip
    ctx.fillStyle = C.tongue;
    const tr = Math.max(1.2, tip.s * (tg.mode === 'shoot' || tg.mode === 'stick' ? 0.030 : 0.020));
    ctx.beginPath(); ctx.arc(tip.x, tip.y, tr, 0, 7); ctx.fill();
    if (tg.prey) { ctx.fillStyle = '#20180c'; ctx.beginPath(); ctx.arc(tip.x, tip.y - tr, tr * 1.15, 0, 7); ctx.fill(); }
    ctx.restore();
  }

  _drawHead(ctx, W, b, proj) {
    const n = W(b.neck), h = W(b.head);
    const lit = proj.lit(b.head.z);
    const yawK = this.yaw / 42;                     // -1..1 how far we see the side
    ctx.save();
    // skull: neck→snout tapered wedge
    const ang = Math.atan2(h.y - n.y, h.x - n.x);
    const wN = n.s * 0.10, wH = h.s * 0.075;
    const px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
    const g = ctx.createLinearGradient(n.x - px * wN, n.y - py * wN, n.x + px * wN, n.y + py * wN);
    g.addColorStop(0, shade(C.flankLit, lit)); g.addColorStop(0.45, shade(C.flank, lit)); g.addColorStop(1, shade(C.dorsalDeep, lit));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(n.x - px * wN, n.y - py * wN);
    ctx.quadraticCurveTo(h.x - px * wH * 1.7, h.y - py * wH * 1.7, h.x - px * wH, h.y - py * wH);
    ctx.arc(h.x, h.y, wH, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.quadraticCurveTo(n.x + px * wN * 1.05, n.y + py * wN * 1.05, n.x + px * wN, n.y + py * wN);
    ctx.closePath(); ctx.fill();
    // open jaw: dark gap + lower jaw wedge (reads at side/down angles)
    if (this.jaw > 0.10) {
      const jd = this.jaw * h.s * 0.06;
      ctx.fillStyle = C.mouthIn;
      ctx.beginPath();
      ctx.moveTo(h.x - px * wH * 0.8, h.y - py * wH * 0.8 + jd * 0.2);
      ctx.lineTo(h.x + px * wH * 0.8, h.y + py * wH * 0.8 + jd * 0.2);
      ctx.lineTo(h.x + px * wH * 0.35, h.y + py * wH * 0.35 + jd);
      ctx.lineTo(h.x - px * wH * 0.35, h.y - py * wH * 0.35 + jd);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = shade(C.throat, lit);
      ctx.beginPath(); ctx.ellipse(h.x, h.y + jd * 1.15, wH * 0.72, jd * 0.5 + 0.8, ang, 0, 7); ctx.fill();
    }
    // eyes: bumps at skull sides; blink = lid sweep; back-POV keeps them subtle
    for (const s of [-1, 1]) {
      const vis = 1 - Math.max(0, s * yawK * 1.6);  // turning right hides right eye
      if (vis <= 0.1) continue;
      const ex = lerp(n.x, h.x, 0.72) + px * wN * 0.8 * s, ey = lerp(n.y, h.y, 0.72) + py * wN * 0.8 * s;
      const er = n.s * 0.026 * clamp(vis, 0, 1);
      const blink = s < 0 ? this.blinkL : this.blinkR;
      ctx.fillStyle = shade(C.eyeRing, lit);
      ctx.beginPath(); ctx.arc(ex, ey, er * 1.25, 0, 7); ctx.fill();
      if (blink < 0.75) {
        ctx.fillStyle = C.eye;
        ctx.beginPath(); ctx.ellipse(ex, ey, er, er * (1 - blink), 0, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.arc(ex - er * 0.3, ey - er * 0.3, er * 0.3, 0, 7); ctx.fill();
      } else {
        ctx.strokeStyle = shade(C.lid, lit); ctx.lineWidth = Math.max(0.8, er * 0.5);
        ctx.beginPath(); ctx.moveTo(ex - er, ey); ctx.lineTo(ex + er, ey); ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawTorso(ctx, W, b, proj) {
    ctx.save();
    // volume: overlapping shaded discs along the spine (cheap "cylinder")
    for (let i = b.spine.length - 1; i >= 0; i--) {
      const sp = b.spine[i], p = W(sp);
      const lit = proj.lit(sp.z);
      const r = p.s * sp.r;
      const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.55, r * 0.15, p.x, p.y, r * 1.1);
      g.addColorStop(0, shade(C.flankLit, lit));
      g.addColorStop(0.55, shade(C.flank, lit));
      g.addColorStop(1, shade(C.dorsalDeep, lit));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * 0.8, 0, 0, 7); ctx.fill();
    }
    // dorsal stripe + banding: the pattern that sells the curve
    const mid = b.spine.map(sp => W({ x: sp.x, y: sp.y + sp.r * 0.62, z: sp.z }));
    ctx.strokeStyle = 'rgba(46,85,24,0.85)';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, mid[4].s * 0.045);
    ctx.beginPath(); ctx.moveTo(mid[0].x, mid[0].y);
    for (let i = 1; i < mid.length; i++) ctx.lineTo(mid[i].x, mid[i].y);
    ctx.stroke();
    for (let i = 1; i < b.spine.length - 1; i += 2) {
      const sp = b.spine[i], p = W({ x: sp.x, y: sp.y + sp.r * 0.3, z: sp.z });
      ctx.strokeStyle = 'rgba(53,97,28,0.5)';
      ctx.lineWidth = Math.max(1, p.s * 0.02);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.s * sp.r * 0.82, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    }
    // rim light along the spine top (sun) — subtle, offset to the lit side
    ctx.strokeStyle = 'rgba(255,244,200,0.26)';
    ctx.lineWidth = Math.max(1, mid[4].s * 0.014);
    ctx.beginPath();
    const rim = b.spine.map(sp => W({ x: sp.x - sp.r * 0.5, y: sp.y + sp.r * 0.72, z: sp.z }));
    ctx.moveTo(rim[1].x, rim[1].y);
    for (let i = 2; i < rim.length - 1; i++) ctx.lineTo(rim[i].x, rim[i].y);
    ctx.stroke();
    ctx.restore();
  }

  _drawLimb(ctx, W, lp, proj) {
    const s = W(lp.shoulder), e = W(lp.elbow), f = W(lp.foot);
    const lit = proj.lit(lp.elbow.z);
    ctx.save();
    ctx.lineCap = 'round';
    // upper segment (thick) then lower (tapered) — sprawled silhouette
    ctx.strokeStyle = shade(lp.front ? C.band : C.dorsal, lit);
    ctx.lineWidth = Math.max(2.5, s.s * 0.075);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(e.x, e.y - s.s * 0.01, e.x, e.y); ctx.stroke();
    ctx.strokeStyle = shade(C.flank, lit);
    ctx.lineWidth = Math.max(2, s.s * 0.05);
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(f.x, f.y); ctx.stroke();
    // foot: splayed toes gripping the branch
    ctx.strokeStyle = shade(C.dorsal, lit);
    ctx.lineWidth = Math.max(1, f.s * 0.016);
    for (const ta of [-0.5, 0, 0.5]) {
      ctx.beginPath(); ctx.moveTo(f.x, f.y);
      ctx.lineTo(f.x + Math.cos(ta + (lp.side > 0 ? -0.4 : Math.PI + 0.4)) * f.s * 0.055,
                 f.y + Math.abs(Math.sin(ta)) * f.s * 0.03 + f.s * 0.02);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawTail(ctx, W, tail, proj) {
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < tail.length - 1; i++) {
      const a = W(tail[i]), b2 = W(tail[i + 1]);
      const lit = proj.lit(tail[i].z);
      ctx.strokeStyle = i % 2 ? shade(C.band, lit) : shade(C.flank, lit);
      ctx.lineWidth = Math.max(1, a.s * tail[i].r * 1.9);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
    }
    ctx.restore();
  }
}

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}
/* rotate unit vec a toward unit vec b by at most `maxRad` */
function slerpDir(a, b, maxRad) {
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const ang = Math.acos(dot);
  if (ang < 1e-4 || ang <= maxRad) return b;
  const t = maxRad / ang, s = Math.sin(ang);
  const w1 = Math.sin((1 - t) * ang) / s, w2 = Math.sin(t * ang) / s;
  return norm3(a.x * w1 + b.x * w2, a.y * w1 + b.y * w2, a.z * w1 + b.z * w2);
}

/* darken/keep a hex color by lit 0..1 (fog-light product from the game) */
const _shadeCache = {};
function shade(hex, lit) {
  const k = hex + (lit * 20 | 0);
  if (_shadeCache[k]) return _shadeCache[k];
  const n = parseInt(hex.slice(1), 16);
  const f = 0.35 + 0.65 * lit;
  const r = (n >> 16) * f | 0, g = ((n >> 8) & 255) * f | 0, b = (n & 255) * f | 0;
  return (_shadeCache[k] = `rgb(${r},${g},${b})`);
}
