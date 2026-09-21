/**
 * sdk/game/ball-fx.js — cheap motion cues for the game ball, all on the ONE stage (no extra WebGL contexts, unlit
 * materials only, layer 0 so every tile camera sees them):
 *
 *   TRAIL   ribbon through the last 12 positions, alpha/width fading to the tail, only while |v| > 0.6 m/s (retracts otherwise)
 *   SQUASH  0.8 along the bounce normal for 90 ms (eased back), perpendicular axes bulge 10 % — composed on top of the
 *           PropBall transform through mesh.matrix during the squash only (matrixAutoUpdate restored after)
 *   SPIN    when the caller passes no `quat` (PropBall drives mesh.quaternion itself): integrate angVel, or a roll
 *           synthesised from the linear velocity on the shelf (omega = up x v / r), decaying in flight
 *   CATCH   pulse: material colour flash + an additive halo shell, exp decay tau 120 ms
 *   MISS    dust puff: 6 pooled sprites spreading in the screen plane, 450 ms
 *   SHADOW  (optional, when ballState.floorY is given) a soft contact blob at the ball's foot, fading with height
 *
 *   const fx = new BallFx(scene, mesh, { color, createCanvas, autoBounce, autoPuff, shadow, spin });
 *   fx.update(dt, { pos, vel, r, phase, onSurface, angVel?, quat?, held?, floorY? })    // dt in SECONDS, after physics
 *   fx.bounce(normal?, strength?)  fx.catchPulse()  fx.missPuff(pos?)  fx.settle()  fx.state  fx.dispose()
 *   RULE: call update(dt, state) every frame right after the physics step — during a squash the ball's matrix is composed
 *   here (matrixAutoUpdate off for <= 90 ms); a frame that moves the ball without calling update renders it at the old spot.
 *
 * Node-safe (three math + Object3D only; sprites get no texture when no canvas factory is injected).
 */
import * as THREE from 'three';

export const FX = Object.freeze({
  TRAIL_N: 12, TRAIL_MIN_SPEED: 0.6, TRAIL_FULL_SPEED: 1.6, TRAIL_RETRACT: 2, TRAIL_JUMP_RESET: 0.6,
  SQUASH_MS: 90, SQUASH_SCALE: 0.8, SQUASH_BULGE: 0.5, BOUNCE_COOLDOWN_MS: 120, BOUNCE_MIN_DV: 0.5,
  PULSE_TAU_MS: 120, PULSE_GAIN: 0.6,
  PUFF_N: 6, PUFF_MS: 450, PUFF_SPEED_R: 7, PUFF_AUTO_VY: -1.2,
  SPIN_DECAY: 0.985, SHADOW_H: 0.6,
});

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _sq = new THREE.Matrix4(), _zero = new THREE.Vector3(0, 0, 0), _n = new THREE.Vector3();
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

function radialSprite(createCanvas, inner, outer, size = 64) {
  if (!createCanvas) return null;
  const cv = createCanvas(size, size); cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

export class BallFx {
  /**
   * @param {THREE.Scene|THREE.Object3D|null} scene   where the trail / halo / puffs live (null in pure logic tests)
   * @param {THREE.Mesh} mesh                          the ball mesh (PropBall's; position/quaternion/scale are its own)
   * @param {object} o  color (trail tint, default mesh.userData.tint), createCanvas(w,h) (sprite textures; default document),
   *                    autoBounce (squash from velocity flips, default true), autoPuff (dust on hard landings, default true),
   *                    shadow (contact blob when floorY is given, default true), spin: 'auto' | 'own' | 'off' (default 'auto')
   */
  constructor(scene, mesh, o = {}) {
    this.scene = scene; this.mesh = mesh;
    this.opts = Object.assign({ autoBounce: true, autoPuff: true, shadow: true, spin: 'auto' }, o);
    this.color = new THREE.Color(o.color || (mesh && mesh.userData && mesh.userData.tint) || '#d8ff3a');
    const createCanvas = o.createCanvas || (typeof document !== 'undefined' ? (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; } : null);
    this.group = new THREE.Group(); this.group.name = 'ballFx'; this.group.frustumCulled = false;
    this._buildTrail();
    this._buildHalo();
    this._buildPuffs(createCanvas);
    this._buildShadow(createCanvas);
    if (scene) scene.add(this.group);
    // state
    this._prev = null;                          // last ballState copy {pos, vel, onSurface, held, phase}
    this._trailPts = [];                        // Vector3[] head first
    this._trailHead = 0;                        // speed fade at the head (0..1)
    this._squash = { t: -1, n: new THREE.Vector3(0, 1, 0), k: 1 };
    this._lastBounce = -1e9; this._time = 0;
    this._pulse = 0;
    this._baseColor = mesh && mesh.material && mesh.material.color ? mesh.material.color.clone() : null;
    this._omega = new THREE.Vector3();
    this._puffs = []; this._puffT = -1; this._puffPos = new THREE.Vector3();
  }

  // ── build ────────────────────────────────────────────────────────────────────────────────────────────────────────
  _buildTrail() {
    const N = FX.TRAIL_N;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 2 * 4), 4));   // RGBA -> USE_COLOR_ALPHA
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.trail = new THREE.Mesh(geo, mat);
    this.trail.name = 'ballTrail'; this.trail.frustumCulled = false; this.trail.renderOrder = 28; this.trail.visible = false; this.trail.layers.set(0);
    this.group.add(this.trail);
  }
  _buildHalo() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
    this.halo.name = 'ballHalo'; this.halo.frustumCulled = false; this.halo.renderOrder = 31; this.halo.visible = false; this.halo.layers.set(0);
    this.group.add(this.halo);
  }
  _buildPuffs(createCanvas) {
    const tex = radialSprite(createCanvas, 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
    this.puffGroup = new THREE.Group(); this.puffGroup.name = 'ballPuffs';
    this.puffs = [];
    for (let i = 0; i < FX.PUFF_N; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, color: 0xd9d2c0, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
      const s = new THREE.Sprite(mat); s.visible = false; s.frustumCulled = false; s.renderOrder = 32; s.layers.set(0);
      s.userData.vel = new THREE.Vector3();
      this.puffs.push(s); this.puffGroup.add(s);
    }
    this.group.add(this.puffGroup);
  }
  _buildShadow(createCanvas) {
    const tex = radialSprite(createCanvas, 'rgba(0,0,0,0.85)', 'rgba(0,0,0,0)');
    const mat = new THREE.SpriteMaterial({ map: tex, color: 0x000000, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.shadow = new THREE.Sprite(mat); this.shadow.name = 'ballShadow'; this.shadow.visible = false; this.shadow.frustumCulled = false; this.shadow.renderOrder = 27; this.shadow.layers.set(0);
    this.group.add(this.shadow);
  }

  // ── triggers ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** squash along `normal` (world, default +y); strength scales the depth (1 = 0.8) */
  bounce(normal = null, strength = 1) {
    this._squash.t = 0;
    this._squash.strength = Math.max(0.3, Math.min(1.4, strength));
    if (normal) this._squash.n.set(normal.x, normal.y, normal.z).normalize(); else this._squash.n.set(0, 1, 0);
    if (this._squash.n.lengthSq() < 1e-6) this._squash.n.set(0, 1, 0);
    this._lastBounce = this._time;
  }
  /** rim/emissive flash on hold */
  catchPulse() { this._pulse = 1; }
  /** end every transient at once (respawn / teleport / pause): squash finished + transform handed back, trail and pulse cleared */
  settle() {
    if (this._squash.t >= 0) { this._squash.t = -1; this._squash.k = 1; this.mesh.matrixAutoUpdate = true; this.mesh.updateMatrix(); this.mesh.matrixWorldNeedsUpdate = true; }
    this._trailPts.length = 0; this.trail.visible = false; this.trail.geometry.setDrawRange(0, 0);
    if (this._pulseLive) { this._pulse = 0; this.halo.visible = false; this._restoreColor(); this._pulseLive = false; }
    this._pulse = 0;
  }
  /** 6 dust sprites spreading from `pos` (default: the ball's foot) */
  missPuff(pos = null) {
    const p = pos ? _v.set(pos.x, pos.y, pos.z) : (this._prev ? _v.set(this._prev.pos.x, this._prev.pos.y - this._prev.r, this._prev.pos.z) : _v.copy(this.mesh.position));
    this._puffPos.copy(p); this._puffT = 0;
    const r = this._prev ? this._prev.r : (this.mesh.userData.radius || 0.05);
    for (let i = 0; i < this.puffs.length; i++) {
      const s = this.puffs[i], a = (i + 0.5) / this.puffs.length * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      s.position.copy(p);
      s.userData.vel.set(Math.cos(a) * 1.0, Math.sin(a) * 0.55 + 0.35, 0).multiplyScalar(FX.PUFF_SPEED_R * r * (0.8 + Math.random() * 0.4));
      s.userData.r = r;
      s.scale.setScalar(r * 0.6); s.material.opacity = 0.55; s.visible = true;
    }
  }

  // ── per frame ────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * @param {number} dt seconds
   * @param {object} s  { pos:{x,y,z}, vel:{x,y,z}, r, phase, onSurface, angVel?:{x,y,z}, quat?:THREE.Quaternion, held?:boolean, floorY?:number }
   */
  update(dt, s) {
    dt = Math.max(0, Math.min(0.25, +dt || 0));
    const ms = dt * 1000; this._time += ms;
    if (!s || !s.pos) { this._advanceTimers(ms, dt); return; }
    const r = s.r || this.mesh.userData.radius || 0.05;
    const vel = s.vel || _zero, speed = Math.hypot(vel.x || 0, vel.y || 0, vel.z || 0);
    const held = !!(s.held || s.phase === 'held');
    const prev = this._prev;

    // ── transitions from the state stream ──
    if (prev) {
      if (held && !prev.held) this.catchPulse();
      if (this.opts.autoBounce && this._time - this._lastBounce > FX.BOUNCE_COOLDOWN_MS && !held) {
        const dvy = (vel.y || 0) - prev.vel.y, dvx = (vel.x || 0) - prev.vel.x;
        const landed = (s.onSurface && !prev.onSurface) || (prev.vel.y < -FX.BOUNCE_MIN_DV && (vel.y || 0) > 0.05);
        if (landed && Math.abs(prev.vel.y) > FX.BOUNCE_MIN_DV * 0.5) {
          this.bounce({ x: 0, y: 1, z: 0 }, Math.min(1.4, 0.5 + Math.abs(dvy) / 2.5));
          if (this.opts.autoPuff && prev.vel.y < FX.PUFF_AUTO_VY) this.missPuff({ x: s.pos.x, y: s.pos.y - r, z: s.pos.z });
        } else if (Math.abs(dvx) > FX.BOUNCE_MIN_DV && Math.sign(vel.x || 0) !== Math.sign(prev.vel.x) && Math.abs(prev.vel.x) > FX.BOUNCE_MIN_DV) {
          this.bounce({ x: Math.sign(prev.vel.x) || 1, y: 0, z: 0 }, Math.min(1.4, 0.5 + Math.abs(dvx) / 2.5));
        }
      }
    }

    // ── trail ──
    const jumped = prev && Math.hypot(s.pos.x - prev.pos.x, s.pos.y - prev.pos.y, s.pos.z - prev.pos.z) > FX.TRAIL_JUMP_RESET;
    if (jumped || held) this._trailPts.length = 0;
    if (!held && speed > FX.TRAIL_MIN_SPEED) {
      this._trailPts.unshift(new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z));
      if (this._trailPts.length > FX.TRAIL_N) this._trailPts.length = FX.TRAIL_N;
      this._trailHead = Math.min(1, (speed - FX.TRAIL_MIN_SPEED) / (FX.TRAIL_FULL_SPEED - FX.TRAIL_MIN_SPEED) + 0.25);
    } else if (this._trailPts.length) {
      this._trailPts.length = Math.max(0, this._trailPts.length - FX.TRAIL_RETRACT);
    }
    this._writeTrail(r);

    // ── spin ──
    if (this.opts.spin !== 'off' && !(this.opts.spin === 'auto' && s.quat)) {
      const av = s.angVel;
      if (av && Math.hypot(av.x, av.y, av.z) > 0.05) this._omega.set(av.x, av.y, av.z);
      else if (s.onSurface && speed > 0.05) this._omega.set(0, 1, 0).cross(_v.set(vel.x, vel.y, vel.z)).divideScalar(Math.max(r, 1e-3));
      else this._omega.multiplyScalar(FX.SPIN_DECAY);
      const w = this._omega.length();
      if (w > 1e-4 && dt > 0) { _q.setFromAxisAngle(_d.copy(this._omega).divideScalar(w), w * dt); this.mesh.quaternion.premultiply(_q); }
    }

    // ── squash (composed over PropBall's transform) ──
    this._applySquash(ms);

    // ── catch pulse ──
    this._advancePulse(ms, r, s.pos);

    // ── puffs / shadow ──
    this._advancePuffs(dt);
    this._placeShadow(s, r);

    // remember
    if (!prev) this._prev = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onSurface: false, held: false, phase: null, r };
    const p = this._prev;
    p.pos.x = s.pos.x; p.pos.y = s.pos.y; p.pos.z = s.pos.z;
    p.vel.x = vel.x || 0; p.vel.y = vel.y || 0; p.vel.z = vel.z || 0;
    p.onSurface = !!s.onSurface; p.held = held; p.phase = s.phase || null; p.r = r;
  }

  _advanceTimers(ms, dt) { this._applySquash(ms); this._advancePulse(ms, this._prev ? this._prev.r : 0.05, this._prev ? this._prev.pos : this.mesh.position); this._advancePuffs(dt); }

  _writeTrail(r) {
    const pts = this._trailPts, n = pts.length, geo = this.trail.geometry;
    if (n < 2) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    const cr = this.color.r, cg = this.color.g, cb = this.color.b;
    for (let i = 0; i < n; i++) {
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      _d.subVectors(a, b);                                     // along the motion (head-ward)
      if (_d.lengthSq() < 1e-10) _d.set(1, 0, 0);
      _w.set(-_d.y, _d.x, 0).normalize();                      // perpendicular in the screen plane (every camera looks -z)
      const f = i / (n - 1);
      const width = r * (0.7 - 0.62 * f) * this._trailHead;
      const alpha = 0.5 * Math.pow(1 - f, 1.4) * this._trailHead;
      const o = i * 6;
      pos[o] = p.x + _w.x * width; pos[o + 1] = p.y + _w.y * width; pos[o + 2] = p.z;
      pos[o + 3] = p.x - _w.x * width; pos[o + 4] = p.y - _w.y * width; pos[o + 5] = p.z;
      const c = i * 8, lift = 0.35 * (1 - f);                   // brighter toward the head
      col[c] = Math.min(1, cr + lift); col[c + 1] = Math.min(1, cg + lift); col[c + 2] = Math.min(1, cb + lift); col[c + 3] = alpha;
      col[c + 4] = col[c]; col[c + 5] = col[c + 1]; col[c + 6] = col[c + 2]; col[c + 7] = alpha;
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, (n - 1) * 6);
    this.trail.visible = true;
  }

  _applySquash(ms) {
    const sq = this._squash, mesh = this.mesh;
    if (sq.t < 0) return;
    sq.t += ms;
    const f = Math.min(1, sq.t / FX.SQUASH_MS);
    const depth = (1 - FX.SQUASH_SCALE) * (sq.strength || 1);
    const k = 1 - depth * (1 - easeOutCubic(f));                 // 0.8 -> 1
    sq.k = k;
    if (f >= 1) {                                                // done: hand the transform back
      sq.t = -1; sq.k = 1;
      mesh.matrixAutoUpdate = true; mesh.updateMatrix(); mesh.matrixWorldNeedsUpdate = true;
      return;
    }
    const p = 1 + (1 - k) * FX.SQUASH_BULGE;                     // perpendicular bulge
    const n = sq.n;
    // Sq = p*I + (k - p) n n^T  (scale k along n, p across it)
    const e = _sq.elements, kp = k - p;
    e[0] = p + kp * n.x * n.x; e[4] = kp * n.x * n.y; e[8] = kp * n.x * n.z; e[12] = 0;
    e[1] = kp * n.y * n.x; e[5] = p + kp * n.y * n.y; e[9] = kp * n.y * n.z; e[13] = 0;
    e[2] = kp * n.z * n.x; e[6] = kp * n.z * n.y; e[10] = p + kp * n.z * n.z; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    _m.compose(_zero, mesh.quaternion, mesh.scale).premultiply(_sq).setPosition(mesh.position);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(_m); mesh.matrixWorldNeedsUpdate = true;
  }

  _advancePulse(ms, r, pos) {
    if (this._pulse <= 0.001) { if (this._pulseLive) { this.halo.visible = false; this._restoreColor(); this._pulseLive = false; } this._pulse = 0; return; }
    this._pulseLive = true;
    this._pulse *= Math.exp(-ms / FX.PULSE_TAU_MS);
    const v = this._pulse;
    this.halo.visible = v > 0.02;
    this.halo.position.set(pos.x, pos.y, pos.z);
    this.halo.scale.setScalar(r * (1.03 + 0.15 * v));
    this.halo.material.opacity = FX.PULSE_GAIN * v;
    if (this._baseColor && this.mesh.material && this.mesh.material.color) {
      const c = this.mesh.material.color;
      c.setRGB(this._baseColor.r * (1 + 0.5 * v), this._baseColor.g * (1 + 0.45 * v), this._baseColor.b * (1 + 0.25 * v));
    }
  }
  _restoreColor() { if (this._baseColor && this.mesh.material && this.mesh.material.color) this.mesh.material.color.copy(this._baseColor); }

  _advancePuffs(dt) {
    if (this._puffT < 0) return;
    this._puffT += dt * 1000;
    const f = Math.min(1, this._puffT / FX.PUFF_MS);
    const drag = Math.pow(0.88, dt * 60);
    for (const s of this.puffs) {
      s.position.addScaledVector(s.userData.vel, dt);
      s.userData.vel.multiplyScalar(drag);
      s.scale.setScalar(s.userData.r * (0.6 + 1.7 * easeOutCubic(f)));
      s.material.opacity = 0.55 * (1 - f) * (1 - f);
      s.visible = f < 1;
    }
    if (f >= 1) this._puffT = -1;
  }

  _placeShadow(s, r) {
    if (!this.opts.shadow || typeof s.floorY !== 'number' || !this.shadow.material.map) { this.shadow.visible = false; return; }
    const h = Math.max(0, s.pos.y - r - s.floorY);
    const k = 1 - Math.min(1, h / FX.SHADOW_H);
    this.shadow.visible = k > 0.02;
    this.shadow.position.set(s.pos.x, s.floorY + 0.002, s.pos.z + 0.001);
    this.shadow.scale.set(r * (2.2 + 1.2 * (1 - k)), r * 0.7, 1);
    this.shadow.material.opacity = 0.4 * k * k;
  }

  /** observable state (tests / HUD) */
  get state() {
    return { trail: this._trailPts.length, trailVisible: this.trail.visible, squash: { active: this._squash.t >= 0, t: this._squash.t, k: this._squash.k },
      pulse: this._pulse, haloVisible: this.halo.visible, puffs: this.puffs.filter(p => p.visible).length, spinRate: this._omega.length(), shadowVisible: this.shadow.visible };
  }

  setVisible(v) { this.group.visible = !!v; }

  dispose() {
    if (this._squash.t >= 0) { this._squash.t = -1; this.mesh.matrixAutoUpdate = true; this.mesh.updateMatrix(); }
    this._restoreColor();
    this.group.removeFromParent();
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    this._trailPts.length = 0;
  }
}
