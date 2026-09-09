/**
 * hopeOS SDK — BEAT RUSH
 * ═══════════════════════════════════════════════════════════════
 * A beat-synced punch game (beatsaber / moonrider-style, adapted to
 * the hopeOS webcam + holo-hand substrate: you sit facing the screen,
 * your meshed hands ARE the controllers).
 *
 *   • Notes fly out of a VANISHING POINT far down the corridor and
 *     arrive at your hand level EXACTLY on the beat (the AudioContext
 *     clock is the single master clock — spawn time = beat − travel).
 *   • Punch them: contact is resolved against the HandBody joint
 *     colliders + punch speed (moonrider scoring: ~60% timing, ~40%
 *     swing speed). Explosion FX inherit your punch direction.
 *   • Walls fly in during breakdowns — LEAN left/right (head tracking)
 *     to dodge.
 *   • The floor grid streams toward you at note speed, rails pulse,
 *     gates/rings fly past, an aurora sky breathes with the low band.
 *
 * Design cues taken from supermedium/moonrider (MIT): punch-mode dot
 * beats, speed-weighted scoring, 1.1s anticipation glow, the
 * magenta/cyan/yellow scheme — re-skinned to the hopeOS holo shades.
 */

import * as THREE from 'three';
import { SynthTrack, FileTrack, loadFileTrack, buildSynthPattern, buildBeatMap } from './beat-audio.js';

export const NOTE_COLORS = { left: 0xf971c3, right: 0x66e0ff, any: 0xfff568 };
const WALL_COLOR = 0xff5a7a;
// geometry contract, exported for tests / external tooling:
// a note spawned at (time − travel) sits at SPAWN_Z, and reaches HIT_Z
// exactly at `time` — z(t) = HIT_Z − (time − t)·speed
export const GAME_GEOM = { get LANES_X() { return LANES_X; }, get ROWS_DY() { return ROWS_DY; },
  get SPEEDS() { return SPEEDS; }, get SPAWN_Z() { return SPAWN_Z; }, get HIT_Z() { return HIT_Z; },
  get HIT_WINDOW() { return HIT_WINDOW; }, get NOTE_R() { return NOTE_R; } };
const LANES_X = [-0.34, -0.115, 0.115, 0.34];
const ROWS_DY = [-0.42, -0.14];            // relative to camera height (low row = kicks, high = snares)
const SPEEDS = { chill: 8.5, rush: 11.5, insane: 15 };
const SPAWN_Z = -54;                        // local vanish point
const HIT_Z = -0.60;                        // arrival plane ≈ fingertip reach in first-person
const HIT_WINDOW = 0.38;                    // generous — webcam carries 40–150ms latency (brief §9)
const W_PERFECT = 0.12, W_GREAT = 0.22;
const PUNCH_SPEED_MIN = 0.5;                // m/s — gate opens low; SPEED then buys reach + points
const SUPER_SPEED = 1.5;                    // moonrider SUPER punch threshold
const MEGA_SPEED = 3.2;                     // full-power swing
const FIST_MAX_OPEN = 0.58;                 // openness below this = a punching fist
const MULT_STEPS = [0, 2, 6, 14];           // streak → ×1 ×2 ×4 ×8 (moonrider thresholds)
const NOTE_R = 0.088;
const HIT_PAD_BASE = 0.11;                  // resting reach around the note…
const HIT_PAD_SPEED = 0.11;                 // …a hard swing grows your effective fist
const NOTE_SCALE_FAR = 0.55;                // notes GROW as they fly in (small at the vanish
const NOTE_SCALE_HIT = 1.8;                 // point → 1.8× ≈ 16cm ball at your fists)

const _v = new THREE.Vector3(), _u = new THREE.Vector3(), _p = new THREE.Vector3();

// ── shaders ─────────────────────────────────────────────────────
const GRID_FRAG = /* glsl */`
uniform float uTime, uScroll, uBeat;
varying vec3 vPos;
float gridLine(vec2 p, float w) {
  vec2 g = abs(fract(p) - 0.5) / fwidth(p);
  return 1.0 - smoothstep(0.0, w, min(g.x, g.y));
}
void main() {
  vec2 p = vec2(vPos.x, vPos.z - uScroll) * 1.6;       // scroll: lines stream toward the player
  float l = gridLine(p, 1.4);
  float lane = smoothstep(1.2, 0.25, abs(vPos.x));      // corridor glow
  float dist = smoothstep(-54.0, -6.0, vPos.z);         // fade to the vanish point
  vec3 base = vec3(0.05, 0.16, 0.22);
  vec3 laneC = vec3(0.18, 0.65, 0.85);
  vec3 col = (base + laneC * lane * (0.55 + uBeat * 0.9)) * l;
  col += vec3(0.02, 0.05, 0.07) * lane * dist;          // faint road wash
  float a = l * mix(0.12, 0.85, dist) * (0.55 + lane * 0.45) + lane * dist * 0.05;
  gl_FragColor = vec4(col * (0.8 + uBeat * 0.6), a);
}`;

const SKY_FRAG = /* glsl */`
uniform float uTime, uBeat;
varying vec3 vDir;
float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(vec3(i,0.)), b = hash(vec3(i+vec2(1,0),0.));
  float c = hash(vec3(i+vec2(0,1),0.)), d = hash(vec3(i+vec2(1,1),0.));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){ return 0.55*noise(p) + 0.3*noise(p*2.1+3.7) + 0.15*noise(p*4.3+9.1); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // deep space gradient
  vec3 col = mix(vec3(0.012,0.03,0.055), vec3(0.02,0.075,0.11), smoothstep(-0.15, 0.55, h));
  // aurora curtains — drift + beat breathing
  float band = smoothstep(0.02, 0.18, h) * smoothstep(0.75, 0.35, h);
  float n1 = fbm(vec2(d.x * 2.6 + uTime * 0.045, d.z * 2.6 - uTime * 0.03));
  float n2 = fbm(vec2(d.x * 5.0 - uTime * 0.06, d.z * 5.0 + uTime * 0.02));
  float curt = pow(n1, 3.0) * band * 1.7;
  vec3 aur = mix(vec3(0.15, 0.9, 0.75), vec3(0.55, 0.25, 0.95), n2);
  col += aur * curt * (0.45 + uBeat * 0.6);
  // stars
  vec3 sp = floor(d * 220.0);
  float s = hash(sp);
  if (s > 0.995 && h > 0.05) {
    float tw = 0.5 + 0.5 * sin(uTime * 2.4 + s * 71.0);
    col += vec3(0.8, 0.9, 1.0) * (s - 0.995) * 180.0 * tw;
  }
  // vanish-point portal glow down the corridor (−Z) — kept soft so the
  // corridor centre never blows out under the additive gates/rails
  float g = pow(max(dot(d, normalize(vec3(0.0, 0.06, -1.0))), 0.0), 30.0);
  col += vec3(0.95, 0.35, 0.75) * g * (0.18 + uBeat * 0.28);
  col += vec3(0.25, 0.75, 0.9) * pow(g, 3.0) * 0.35;
  gl_FragColor = vec4(col, 1.0);
}`;

const NOTE_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uGlow;
varying vec3 vN, vV;
void main() {
  vec3 N = normalize(vN), V = normalize(vV);
  float f = pow(1.0 - abs(dot(N, V)), 1.7);
  vec3 c = uCol * (0.35 + f * 0.9) + vec3(1.0) * f * 0.35 + uCol * uGlow * 0.8;
  gl_FragColor = vec4(c, 1.0);
}`;

const NOTE_VERT = /* glsl */`
varying vec3 vN, vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const RAIL_FRAG = /* glsl */`
uniform float uTime, uScroll, uBeat;
uniform vec3 uCol;
varying vec3 vPos;
void main() {
  float pulse = 0.5 + 0.5 * sin((vPos.z - uScroll * 0.9) * 1.1);
  float dist = smoothstep(-54.0, -2.0, vPos.z);
  vec3 c = uCol * (0.35 + pulse * (0.65 + uBeat * 0.9));
  gl_FragColor = vec4(c, (0.25 + pulse * 0.5) * mix(0.15, 1.0, dist));
}`;

const WALL_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uCol;
uniform float uHot;
varying vec3 vN, vV, vP;
void main() {
  vec3 N = normalize(vN), V = normalize(vV);
  float f = pow(1.0 - abs(dot(N, V)), 1.4);
  float scan = 0.75 + 0.25 * sin(vP.y * 26.0 + uTime * 5.0);
  vec3 c = uCol * (0.25 + f * 1.1) * scan + uCol * uHot;
  gl_FragColor = vec4(c, 0.16 + f * 0.5 + uHot * 0.25);
}`;

const WALL_VERT = /* glsl */`
varying vec3 vN, vV, vP;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz); vP = position;
  gl_Position = projectionMatrix * mv;
}`;

// ── DOM (HUD, judgements, results, leaderboard) ─────────────────
const HUD_CSS = `
#brWrap{position:fixed;inset:0;pointer-events:none;z-index:25;font-family:'Segoe UI',system-ui,sans-serif}
#brTop{position:absolute;top:10px;left:50%;transform:translateX(-50%);text-align:center;display:none}
#brScore{font-size:34px;font-weight:700;color:#fff;text-shadow:0 0 26px rgba(102,224,255,.8);font-family:Consolas,monospace}
#brSub{font-size:11px;letter-spacing:.22em;color:#66e0ff}
#brSub b{color:#fff568}
#brProg{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);width:320px;display:none;text-align:center}
#brProg .nm{font-size:10px;letter-spacing:.18em;color:#6d8494;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#brProg .bar{height:3px;background:rgba(102,224,255,.15);border-radius:2px;overflow:hidden}
#brProg .bar i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#66e0ff,#f971c3)}
#brCount{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);font-size:92px;font-weight:800;color:#66e0ff;
  text-shadow:0 0 60px rgba(102,224,255,.9);display:none;font-family:Consolas,monospace}
#brFlash{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,transparent 55%,rgba(255,60,90,.55) 100%);
  opacity:0;transition:opacity .12s}
#brHitFlash{position:absolute;inset:0;opacity:0;transition:opacity .18s;mix-blend-mode:screen}
#brMult{position:absolute;top:26%;left:50%;transform:translate(-50%,-50%);font-size:88px;font-weight:800;
  color:#fff568;text-shadow:0 0 50px rgba(255,245,104,.9);font-family:Consolas,monospace;opacity:0;pointer-events:none}
#brMult.slam{animation:brSlam .8s cubic-bezier(.2,1.4,.4,1) forwards}
@keyframes brSlam{0%{opacity:0;transform:translate(-50%,-50%) scale(2.6)}18%{opacity:1;transform:translate(-50%,-50%) scale(1)}
  72%{opacity:1}100%{opacity:0;transform:translate(-50%,-58%) scale(1.05)}}
#brLean{position:absolute;bottom:70px;left:50%;transform:translateX(-50%);font-size:13px;letter-spacing:.3em;color:#ff5a7a;
  display:none;text-shadow:0 0 18px rgba(255,90,122,.8)}
.brJ{position:absolute;font-size:24px;font-weight:800;letter-spacing:.12em;opacity:0;transform:translate(-50%,-50%);
  font-family:Consolas,monospace;text-shadow:0 0 22px currentColor}
.brJ.pop{animation:brJpop .62s cubic-bezier(.2,1.5,.4,1) forwards}
@keyframes brJpop{0%{opacity:0;transform:translate(-50%,-50%) scale(.45)}
  16%{opacity:1;transform:translate(-50%,-52%) scale(1.35)}
  38%{transform:translate(-50%,-58%) scale(1.05)}
  100%{opacity:0;transform:translate(-50%,-92%) scale(.95)}}
#brResults{position:fixed;inset:0;display:none;place-items:center;background:rgba(4,8,14,.82);backdrop-filter:blur(8px);
  z-index:45;pointer-events:auto}
#brResults .card{background:rgba(13,18,26,.92);border:1px solid rgba(102,224,255,.25);border-radius:14px;padding:26px 34px;
  text-align:center;min-width:360px;color:#cfe6f2}
#brResults .rank{font-size:74px;font-weight:800;color:#fff568;text-shadow:0 0 44px rgba(255,245,104,.7);font-family:Consolas,monospace;line-height:1}
#brResults .big{font-size:26px;color:#fff;font-family:Consolas,monospace;margin:6px 0 2px}
#brResults .meta{font-size:11.5px;color:#6d8494;line-height:1.9}
#brResults table{margin:14px auto 4px;border-collapse:collapse;font-size:11px;font-family:Consolas,monospace;width:100%}
#brResults td,#brResults th{padding:3px 10px;color:#9fc2d4;text-align:right}
#brResults th{color:#66e0ff;letter-spacing:.15em;font-weight:600;border-bottom:1px solid rgba(102,224,255,.2)}
#brResults tr.me td{color:#fff568}
#brResults button{margin:14px 6px 0;padding:9px 26px;border-radius:8px;cursor:pointer;font-size:12.5px;letter-spacing:.12em;
  border:1px solid rgba(102,224,255,.45);background:rgba(28,64,86,.7);color:#fff}
#brResults button.primary{background:linear-gradient(135deg,#66e0ff,#3fa8d8);color:#041018;border:0;font-weight:600}
`;

// ── the game ────────────────────────────────────────────────────
export class BeatGame {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {Object} opts { onStateChange(running) }
   */
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.opts = opts;
    this.running = false;
    this.ctx = null;                    // AudioContext (lazy — needs user gesture)
    this.track = null;
    this.map = null;
    this.difficulty = 'rush';
    this.speed = SPEEDS.rush;

    // score state
    this.S = { score: 0, streak: 0, maxStreak: 0, mult: 1, hits: 0, misses: 0,
               wallsDodged: 0, wallsHit: 0, accSum: 0, judged: 0 };

    this._nextNote = 0; this._nextWall = 0;
    this._active = [];      // live note objs
    this._activeWalls = [];
    this._headX = 0.5;      // smoothed lean 0..1
    this._beat = 0;         // audio low-band pulse 0..1
    this._beatKick = 0;     // conductor kick — MUST init here: update() decays
    this.spb = 60 / 120;    // it on idle frames before any round begins, and
    this.gridOff = 0;       // undefined * x = NaN would poison _beat forever
    this._lastBeat = -1;
    this.beatPhase = 0;
    this._loPrev = 0;       // runtime transient detector state
    this._sinceKick = 9;
    this._freq = new Uint8Array(128);
    this._yOff = 0;             // hand-height offset (m): notes arrive where the
                                // lifted hands sit (see setHeightOffset + handlab)
    this._vol = 1;             // master audio level 0..1
    this._muted = false;       // mute-all
    this._master = null;       // master GainNode (created lazily with the ctx)
    this._handPts = [[], []];   // root-local punch points per hand slot
    for (let h = 0; h < 2; h++) for (let i = 0; i < 10; i++) this._handPts[h].push(new THREE.Vector3());
    this._handMeta = [{ speed: 0, present: false, slot: 'left' }, { speed: 0, present: false, slot: 'right' }];
    this._invRoot = new THREE.Matrix4();

    this._buildEnv();
    this._buildPools();
    this._buildDom();
    this.setVisible(false);
  }

  // ═══ environment ═══
  _buildEnv() {
    this.root = new THREE.Group();       // game-space frame, set from camera at start
    this.scene.add(this.root);
    this.envU = { uTime: { value: 0 }, uScroll: { value: 0 }, uBeat: { value: 0 } };

    // floor grid — streams toward the player
    const gridMat = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: GRID_FRAG,
      uniforms: this.envU, transparent: true, depthWrite: false,
    });
    const gridGeo = new THREE.PlaneGeometry(130, 120, 1, 1);
    gridGeo.rotateX(-Math.PI / 2);
    gridGeo.translate(0, 0, -42);
    this.grid = new THREE.Mesh(gridGeo, gridMat);
    this.grid.frustumCulled = false;
    this.root.add(this.grid);

    // aurora / star dome
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: SKY_FRAG,
      uniforms: this.envU, side: THREE.BackSide, depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(85, 32, 20), skyMat);
    this.sky.renderOrder = -10;
    this.root.add(this.sky);

    // corridor rails
    const railGeo = new THREE.PlaneGeometry(0.06, 55, 1, 1);
    railGeo.rotateX(-Math.PI / 2); railGeo.translate(0, 0.012, -27);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(railGeo, new THREE.ShaderMaterial({
        vertexShader: `varying vec3 vPos; void main(){ vPos = (modelMatrix * vec4(position,1.0)).xyz; vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: RAIL_FRAG,
        uniforms: { ...this.envU, uCol: { value: new THREE.Color(sx < 0 ? NOTE_COLORS.left : NOTE_COLORS.right) } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.position.x = sx * 0.68;
      m.frustumCulled = false;
      this.root.add(m);
    }

    // gates + rings flying past (strong speed cue)
    this.gates = [];
    const pillarGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 8);
    const ringGeo = new THREE.TorusGeometry(1.5, 0.035, 8, 40);
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 2 ? 0xf971c3 : 0x2a8bb0, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      if (i % 3 === 2) {
        const ring = new THREE.Mesh(ringGeo, mat);
        ring.position.y = 1.45;
        g.add(ring);
        g.userData.ring = ring;
      } else {
        for (const sx of [-1, 1]) {
          const p = new THREE.Mesh(pillarGeo, mat);
          p.position.set(sx * 1.9, 1.6, 0);
          g.add(p);
        }
      }
      g.position.z = -6 - i * 6.5;
      this.root.add(g);
      this.gates.push(g);
    }

    // ambient so any lit materials read
    this.root.add(new THREE.AmbientLight(0x557799, 1.1));
    const key = new THREE.DirectionalLight(0xbfe8ff, 1.4);
    key.position.set(2, 5, 3);
    this.root.add(key);
  }

  // ═══ pools ═══
  _buildPools() {
    // glow sprite texture
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g2 = cv.getContext('2d');
    const rg = g2.createRadialGradient(32, 32, 2, 32, 32, 31);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(0.35, 'rgba(255,255,255,0.28)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = rg; g2.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(cv);

    // notes — opaque core (depthWrite: the holo hand correctly hides behind
    // a note it reaches past) + additive halo sprite + APPROACH TELEGRAPH
    // ring (rhythm-game timing cue: the ring shrinks onto the note and hugs
    // it EXACTLY on the beat — that ring IS the audio sync made visible)
    this._notePool = [];
    const noteGeo = new THREE.SphereGeometry(NOTE_R, 20, 14);
    const teleGeo = new THREE.RingGeometry(NOTE_R * 1.06, NOTE_R * 1.22, 36);
    for (let i = 0; i < 26; i++) {
      const u = { uCol: { value: new THREE.Color(1, 1, 1) }, uGlow: { value: 0 } };
      const core = new THREE.Mesh(noteGeo, new THREE.ShaderMaterial({
        vertexShader: NOTE_VERT, fragmentShader: NOTE_FRAG, uniforms: u,
        transparent: false, depthWrite: true,
      }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.scale.setScalar(0.5);
      const tele = new THREE.Mesh(teleGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      core.add(halo, tele);
      core.visible = false;
      this.root.add(core);
      this._notePool.push({ mesh: core, halo, tele, u, busy: false });
    }

    // walls
    this._wallPool = [];
    for (let i = 0; i < 4; i++) {
      const u = { uTime: this.envU.uTime, uCol: { value: new THREE.Color(WALL_COLOR) }, uHot: { value: 0 } };
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.64, 2.35, 1), new THREE.ShaderMaterial({
        vertexShader: WALL_VERT, fragmentShader: WALL_FRAG, uniforms: u,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.64, 2.35, 1)),
        new THREE.LineBasicMaterial({ color: WALL_COLOR, transparent: true, opacity: 0.9 }));
      mesh.add(edges);
      mesh.visible = false;
      this.root.add(mesh);
      this._wallPool.push({ mesh, u, busy: false });
    }

    // explosion bursts — shards fly along the punch direction
    this._fxPool = [];
    for (let i = 0; i < 10; i++) {
      const n = 34;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.028, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      pts.visible = false; pts.frustumCulled = false;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.06, 0.085, 28),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ring.visible = false;
      this.root.add(pts, ring);
      this._fxPool.push({ pts, ring, vel: Array.from({ length: n }, () => new THREE.Vector3()), life: 0, busy: false });
    }
  }

  // ═══ DOM ═══
  _buildDom() {
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.id = 'brWrap';
    wrap.innerHTML = `
      <div id="brTop"><div id="brScore">0</div><div id="brSub">×<b>1</b> · STREAK 0 · ACC 100%</div></div>
      <div id="brProg"><div class="nm"></div><div class="bar"><i></i></div></div>
      <div id="brCount"></div><div id="brFlash"></div><div id="brHitFlash"></div>
      <div id="brMult"></div>
      <div id="brLean">◀ &nbsp;LEAN TO DODGE&nbsp; ▶</div>`;
    document.body.appendChild(wrap);
    this.dom = {
      top: wrap.querySelector('#brTop'), score: wrap.querySelector('#brScore'),
      sub: wrap.querySelector('#brSub'), prog: wrap.querySelector('#brProg'),
      progName: wrap.querySelector('#brProg .nm'), progBar: wrap.querySelector('#brProg .bar i'),
      count: wrap.querySelector('#brCount'), flash: wrap.querySelector('#brFlash'),
      hitFlash: wrap.querySelector('#brHitFlash'), mult: wrap.querySelector('#brMult'),
      lean: wrap.querySelector('#brLean'), wrap,
    };
    this._judges = [];
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'brJ';
      wrap.appendChild(d);
      this._judges.push({ el: d, t: 0 });
    }
    const res = document.createElement('div');
    res.id = 'brResults';
    document.body.appendChild(res);
    this.dom.results = res;
  }

  setVisible(v) {
    this.root.visible = v;
  }

  /** Anchor the game corridor to the current camera (yaw-only, level floor). */
  setFrame() {
    const cam = this.camera;
    cam.getWorldDirection(_v); _v.y = 0;
    const yaw = Math.atan2(-_v.x, -_v.z) + Math.PI;   // face the camera's forward
    this.setFrameAt(cam.position, yaw + Math.PI, cam.position.y);
  }

  /**
   * Anchor the corridor to an arbitrary origin — Kinect-style avatar
   * rounds anchor at the AVATAR (origin = its feet, rowRefY ≈ just
   * above its chest so lanes arrive at its punch zone). Notes then fly
   * to the avatar, not to the camera.
   */
  setFrameAt(origin, yaw, rowRefY) {
    this.root.position.set(origin.x, 0, origin.z);
    this.root.rotation.set(0, yaw, 0);
    this.root.updateMatrixWorld(true);
    this._invRoot.copy(this.root.matrixWorld).invert();
    this._camY = rowRefY;
  }

  laneWorld(lane, row, out) {
    out.set(LANES_X[lane], this._camY + ROWS_DY[row] + this._yOff, HIT_Z);
    return this.root.localToWorld(out);
  }

  // ═══ start / stop ═══
  async startSynth(difficulty = 'rush') {
    this._ensureCtx();
    const pattern = buildSynthPattern();
    const track = new SynthTrack(this.ctx, pattern);
    const map = buildBeatMap(pattern, difficulty);
    this._begin(track, map, difficulty);
  }

  /**
   * PRE-GAME ANALYSIS — call this the moment the user picks a file (the
   * picker click is the required audio-unlock gesture). Decodes the audio,
   * runs onset/BPM analysis ONCE and caches the track, so START is instant
   * and the whole round is generated from the song BEFORE it plays.
   */
  async prepareFile(file) {
    this._ensureCtx();
    if (this._prepared?.fileRef === file) return this._prepared.info;
    const track = await loadFileTrack(this.ctx, file);
    const info = {
      name: track.name, bpm: track.bpm,
      duration: Math.round(track.duration),
      onsets: track.analysis.onsets.length,
    };
    this._prepared = { fileRef: file, track, info };
    return info;
  }

  async startFile(file, difficulty = 'rush') {
    await this.prepareFile(file);              // cached → instant on 2nd call
    const track = this._prepared.track;
    const map = buildBeatMap(track.analysis, difficulty);
    this._begin(track, map, difficulty);
    return { bpm: track.bpm, notes: map.notes.length, walls: map.walls.length };
  }

  /**
   * BAKED TRACK — audio embedded in the app + its analysis precomputed
   * offline (tests/_bake-audio.mjs) and shipped as JSON. Ground truth for
   * the sync system: no runtime DSP at all, the map IS the baked onsets.
   */
  _loadBaked(urls = {
    // resolved against THIS MODULE, not the page — works from any host
    // subpath (GitHub Pages project sites) and any page location
    audio: new URL('../../assets/audio/beat-it.mp3', import.meta.url).href,
    map: new URL('../../assets/audio/beat-it.map.json', import.meta.url).href,
  }) {
    if (!this._bakedP) {
      this._bakedP = (async () => {
        const [ab, meta] = await Promise.all([
          fetch(urls.audio).then(r => { if (!r.ok) throw new Error('audio HTTP ' + r.status); return r.arrayBuffer(); }),
          fetch(urls.map).then(r => { if (!r.ok) throw new Error('beat-map HTTP ' + r.status); return r.json(); }),
        ]);
        const audio = await this.ctx.decodeAudioData(ab);
        return new FileTrack(this.ctx, audio, meta.name || 'baked track', meta);
      })();
      this._bakedP.catch(() => { this._bakedP = null; });   // allow retry on failure
    }
    return this._bakedP;
  }

  /** Fire-and-forget warmup (call after boot) so START is instant. */
  prefetchBaked() {
    try { this._ensureCtx(); this._loadBaked().catch(() => {}); } catch (e) {}
  }

  async startBaked(difficulty = 'rush') {
    this._ensureCtx();
    const track = await this._loadBaked();
    const map = buildBeatMap(track.analysis, difficulty);
    this._begin(track, map, difficulty);
    return { bpm: track.bpm, notes: map.notes.length, walls: map.walls.length };
  }

  _ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // Master gain — EVERY track routes through this, so one knob (and mute)
    // controls all audio. Created once, persists across tracks.
    if (!this._master) {
      this._master = this.ctx.createGain();
      this._master.gain.value = this._muted ? 0 : this._vol;
      this._master.connect(this.ctx.destination);
    }
  }

  /** Master audio level, 0..1. Persists across tracks; mute overrides. */
  setVolume(v) {
    this._vol = Math.max(0, Math.min(1, v));
    this._applyGain();
  }

  /** Mute / unmute all audio (remembers the volume underneath). */
  setMuted(b) {
    this._muted = !!b;
    this._applyGain();
  }

  _applyGain() {
    if (!this._master) return;
    const g = this._muted ? 0 : this._vol;
    // short ramp avoids a click on toggle
    this._master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  /** Vertical offset (m) of the note punch-plane — kept equal to the hand
   *  height offset so notes always arrive where the hands are drawn. */
  setHeightOffset(y) { this._yOff = y || 0; }

  _begin(track, map, difficulty) {
    this.stopClean();
    this.track = track; this.map = map; this.difficulty = difficulty;
    this._lastName = track.name;
    // Route this track's output through the master gain (volume + mute-all).
    // Tracks connect their analyser straight to ctx.destination on build; we
    // re-point that one hop. The analyser still reads the signal (it's driven
    // by its upstream gain), so the beat visuals are unaffected.
    if (this._master && track.analyser) {
      try { track.analyser.disconnect(); } catch (e) {}
      track.analyser.connect(this._master);
    }
    // BEAT CONDUCTOR — the musical grid as a clock. Every visual pulse
    // (world, grid, notes, telegraphs) fires off THIS, not off an
    // analyser that lags the transient. spb = seconds per beat; gridOff =
    // the analysis phase for MP3s (the synth pattern starts on the grid).
    this.spb = 60 / (track.bpm || 120);
    this.gridOff = track.analysis?.offset ?? 0;
    this._lastBeat = -1;
    this._beatKick = 0;
    this._beat = 0;
    this.speed = SPEEDS[difficulty] || SPEEDS.rush;
    this.S = { score: 0, streak: 0, maxStreak: 0, mult: 1, hits: 0, misses: 0,
               wallsDodged: 0, wallsHit: 0, accSum: 0, judged: 0 };
    this._nextNote = 0; this._nextWall = 0;
    this.setFrame();
    this.setVisible(true);
    this.running = true;
    this.dom.top.style.display = 'block';
    this.dom.prog.style.display = 'block';
    this.dom.progName.textContent = `${track.name} · ${difficulty.toUpperCase()} · ${map.notes.length} notes`;
    this.dom.results.style.display = 'none';
    this._refreshHud();
    track.play(3.2);                      // 3-2-1 countdown rides the negative song time
    this.opts.onStateChange?.(true);
  }

  /** Stop + show results (finished or aborted with a score). */
  stop() {
    if (!this.running) return;
    const played = this.S.judged > 0 || this.S.wallsDodged + this.S.wallsHit > 0;
    this.stopClean();
    if (played) this._results();
    this.opts.onStateChange?.(false);
  }

  stopClean() {
    this.running = false;
    if (this.track) { this.track.stop(); this.track = null; }
    for (const n of this._active) this._freeNote(n);
    for (const w of this._activeWalls) this._freeWall(w);
    this._active.length = 0; this._activeWalls.length = 0;
    this.dom.top.style.display = 'none';
    this.dom.prog.style.display = 'none';
    this.dom.count.style.display = 'none';
    this.dom.lean.style.display = 'none';
  }

  // ═══ per-frame ═══
  /**
   * @param {number} dt seconds
   * @param {HandBody[]} hands (any order; slots read from each)
   * @param {number|null} headX normalized head x (0..1, mirrored) for dodging
   */
  update(dt, hands, headX) {
    // env animation runs always (idle scroll before/without a round)
    const flow = this.running ? this.speed : 1.4;
    this.envU.uTime.value += dt;
    this.envU.uScroll.value += flow * dt;
    for (const g of this.gates) {
      g.position.z += flow * dt;
      if (g.userData.ring) g.userData.ring.rotation.z += dt * 0.6;
      if (g.position.z > 2) g.position.z -= 9 * 6.5;
    }
    // audio-reactive pulse. Two beat sources:
    //   exact-grid tracks (synth) → conductor kick on the pattern grid;
    //   real songs (MP3/baked) → RUNTIME TRANSIENT detector on the low
    //   band — the kick lands on the audio you HEAR, immune to any
    //   BPM-grid drift over the song.
    let level = 0;
    if (this.track?.analyser) {
      this.track.analyser.getByteFrequencyData(this._freq);
      let s = 0; for (let i = 1; i < 9; i++) s += this._freq[i];
      level = Math.min(1, (s / 8 / 255) * 1.6);
    }
    if (this.running && this.track && !this.track.exactGrid) {
      const flux = level - this._loPrev;
      if (flux > 0.085 && level > 0.22 && this._sinceKick > 0.18) {
        this._beatKick = 1;
        this._sinceKick = 0;
      }
      this._sinceKick += dt;
    }
    this._loPrev = level;
    this._beatKick *= Math.exp(-dt * 8);
    const target = Math.max(level, this._beatKick);
    this._beat += (target - this._beat) * (target > this._beat ? 0.6 : 0.14);
    this.envU.uBeat.value = this._beat;

    this._updateFx(dt);
    for (const j of this._judges) if (j.t > 0) j.t -= dt;   // slot reuse timer (CSS owns the fade)
    if (!this.running || !this.track) return;

    const t = this.track.time();

    // countdown
    if (t < 0) {
      const n = Math.ceil(-t);
      this.dom.count.style.display = 'block';
      this.dom.count.textContent = n <= 3 ? n : '';
      return;
    } else if (t < 0.8 && this.dom.count.textContent !== 'GO!') {
      this.dom.count.textContent = 'GO!';
      setTimeout(() => { if (this.dom.count.textContent === 'GO!') this.dom.count.style.display = 'none'; }, 600);
    }

    // grid conductor: exact-grid tracks kick on every musical beat boundary
    const beatF = (t - this.gridOff) / this.spb;
    const beatI = Math.floor(beatF);
    if (this.track.exactGrid && beatI !== this._lastBeat && beatI >= 0) {
      this._lastBeat = beatI;
      this._beatKick = 1;
    }
    this.beatPhase = beatF - beatI;

    // head lean smoothing
    if (headX != null) this._headX += (headX - this._headX) * 0.25;

    // hand punch points → root-local (+ fist state: punching needs a FIST)
    for (let h = 0; h < hands.length; h++) {
      if (!this._handMeta[h]) {          // grow to N hands (multiplayer co-op — extra players punch too)
        this._handMeta[h] = { speed: 0, present: false, slot: 'left' };
        const pp = []; for (let i = 0; i < 10; i++) pp.push(new THREE.Vector3());
        this._handPts[h] = pp;
      }
      const hb = hands[h], meta = this._handMeta[h];
      meta.present = !!(hb && hb.present);
      if (!meta.present) continue;
      meta.speed = hb.punchSpeed; meta.slot = hb.slot;
      meta.fist = hb.openness < FIST_MAX_OPEN;
      const pts = this._handPts[h];
      let k = 0;
      for (const id of [0, 5, 9, 13, 17, 4, 8, 12, 16, 20]) {
        pts[k++].copy(hb.joints[id]).applyMatrix4(this._invRoot);
      }
    }

    this._spawn(t);
    this._moveNotes(t, dt, hands);
    this._moveWalls(t, dt);
    this._progress(t);

    // song over?
    const total = this.map.duration || this.track.duration;
    if (t > total + 1.5 && this._active.length === 0 && this._activeWalls.length === 0) {
      this.stop();
    }
  }

  _spawn(t) {
    const travel = (HIT_Z - SPAWN_Z) / this.speed;
    const notes = this.map.notes;
    while (this._nextNote < notes.length && notes[this._nextNote].time - travel <= t) {
      const n = notes[this._nextNote++];
      const slot = this._notePool.find(p => !p.busy);
      if (slot) {
        slot.busy = true;
        slot.note = n;
        slot.state = 'fly';
        const col = NOTE_COLORS[n.hand] ?? NOTE_COLORS.any;
        slot.u.uCol.value.set(col);
        slot.halo.material.color.set(col);
        slot.tele.material.color.set(col);
        slot.tele.material.opacity = 0;
        slot.mesh.visible = true;
        slot.mesh.scale.setScalar(NOTE_SCALE_FAR);
        slot.fall = 0;
        this._active.push(slot);
      }
    }
    const walls = this.map.walls;
    while (this._nextWall < walls.length && walls[this._nextWall].time - travel <= t) {
      const w = walls[this._nextWall++];
      const slot = this._wallPool.find(p => !p.busy);
      if (slot) {
        slot.busy = true; slot.wall = w; slot.crashed = false; slot.scored = false;
        const len = Math.max(1.2, w.dur * this.speed);
        slot.mesh.scale.set(1, 1, len);
        slot.mesh.position.set(w.side === 'left' ? -0.33 : 0.33, 1.17, SPAWN_Z);
        slot.len = len;
        slot.u.uHot.value = 0;
        slot.mesh.visible = true;
        this._activeWalls.push(slot);
        this.dom.lean.style.display = 'block';
      }
    }
  }

  _moveNotes(t, dt, hands) {
    for (let i = this._active.length - 1; i >= 0; i--) {
      const s = this._active[i];
      const n = s.note;
      const err = t - n.time;                                  // + = late
      if (s.state === 'fly') {
        const z = HIT_Z - (n.time - t) * this.speed;
        s.mesh.position.set(LANES_X[n.lane], this._camY + ROWS_DY[n.row] + this._yOff, z);
        // GROW on approach: tiny at the vanish point → a fist-sized ball at
        // the hit plane, with a heartbeat bump on every conductor beat
        const flight = Math.min(1, Math.max(0, (z - SPAWN_Z) / (HIT_Z - SPAWN_Z)));
        const grow = NOTE_SCALE_FAR + (NOTE_SCALE_HIT - NOTE_SCALE_FAR) * flight * flight;
        s.mesh.scale.setScalar(grow * (1 + this._beatKick * 0.10));
        // anticipation glow (moonrider: light up ~1.1s out)
        const soon = Math.max(0, 1 - Math.abs(n.time - t) / 1.1);
        s.u.uGlow.value = soon * (0.5 + this._beat * 0.6);
        s.halo.material.opacity = 0.12 + soon * 0.6;
        s.halo.scale.setScalar(0.42 + soon * 0.35 + this._beatKick * 0.1);
        // TELEGRAPH RING: shrinks onto the note and hugs it EXACTLY on the
        // beat — punch when the ring lands. This is the sync made visible.
        const lead = Math.max(0, n.time - t);
        if (lead < 1.2 && err <= 0) {
          s.tele.material.opacity = (1 - lead / 1.2) * 0.7;
          s.tele.scale.setScalar(1 + (lead / 1.2) * 2.2);
          s.tele.lookAt(this.camera.position);
        } else {
          s.tele.material.opacity = Math.max(0, s.tele.material.opacity - dt * 6);
        }
        // punchable?
        if (Math.abs(err) <= HIT_WINDOW) {
          const hit = this._checkPunch(s, hands);
          if (hit) { this._hit(s, i, err, hit); continue; }
        }
        if (err > HIT_WINDOW) {                                // missed
          s.state = 'miss';
          s.fall = 0;
          s.u.uGlow.value = 0;
          s.halo.material.opacity = 0;
          s.tele.material.opacity = 0;
          this._judge('MISS', '#ff5a7a', s.mesh);
          this.S.streak = 0; this.S.misses++; this.S.judged++;
          this._refreshMult(); this._refreshHud();
        }
      } else if (s.state === 'pop') {                          // hit: flash-expand, then gone
        s.pop -= dt;
        s.mesh.scale.multiplyScalar(1 + dt * 11);
        s.u.uGlow.value = 2.2;
        s.halo.material.opacity = Math.max(0, s.pop / 0.13);
        s.halo.scale.setScalar(1.2);
        if (s.pop <= 0) { this._freeNote(s); this._active.splice(i, 1); }
      } else {                                                 // miss: fall away
        s.fall += dt;
        s.mesh.position.y -= 2.2 * s.fall * dt * 4;
        s.mesh.position.z += this.speed * 0.4 * dt;
        s.mesh.scale.multiplyScalar(1 - dt * 1.4);
        if (s.fall > 0.8) { this._freeNote(s); this._active.splice(i, 1); }
      }
    }
  }

  /**
   * Contact + swing test. The rules of the punch:
   *   1. FIST — an open hand passes through (you're reaching, not punching)
   *   2. SWING — the hand must be moving (≥ PUNCH_SPEED_MIN)
   *   3. REACH SCALES WITH POWER — a harder swing grows the contact pad,
   *      so committing to the punch literally makes the note easier to hit
   *      (and scores more, see _hit). Contact radius also tracks the note's
   *      current grown scale.
   */
  _checkPunch(s, hands) {
    const noteR = NOTE_R * s.mesh.scale.x;
    for (let h = 0; h < hands.length; h++) {
      const meta = this._handMeta[h];
      if (!meta || !meta.present || !meta.fist || meta.speed < PUNCH_SPEED_MIN) continue;
      const pad = HIT_PAD_BASE + HIT_PAD_SPEED * Math.min(meta.speed / MEGA_SPEED, 1);
      const reach = noteR + pad;
      const pts = this._handPts[h];
      for (let k = 0; k < 10; k++) {
        if (pts[k].distanceTo(s.mesh.position) < reach) {
          return { slot: meta.slot, speed: meta.speed, point: pts[k], hand: hands[h] };
        }
      }
    }
    return null;
  }

  _hit(s, idx, err, hit) {
    // moonrider punch scoring: ~60% for connecting on time, ~40% swing
    // speed; SUPER (>1.5 m/s) remaps up to +70, MEGA (>3.2) is the ceiling.
    const aerr = Math.abs(err);
    const timing = aerr <= W_PERFECT ? 1 : aerr <= W_GREAT ? 0.85 : 0.6;
    let speedPts;
    if (hit.speed <= SUPER_SPEED) speedPts = (hit.speed / SUPER_SPEED) * 40;
    else speedPts = 40 + (Math.min(hit.speed, 6) - SUPER_SPEED) / (6 - SUPER_SPEED) * 30;
    const match = s.note.hand === 'any' || s.note.hand === hit.slot;
    let pts = Math.round((60 * timing + speedPts) * (match ? 1.1 : 1));
    pts = Math.ceil(pts / 10) * 10;

    const prevMult = this.S.mult;
    this.S.streak++; this.S.maxStreak = Math.max(this.S.maxStreak, this.S.streak);
    this._refreshMult();
    this.S.score += pts * this.S.mult;
    this.S.hits++; this.S.judged++;
    this.S.accSum += timing;

    const power = hit.speed >= MEGA_SPEED ? 'MEGA ' : hit.speed > SUPER_SPEED ? 'SUPER ' : '';
    const label = aerr <= W_PERFECT ? `${power}PERFECT` : aerr <= W_GREAT ? `${power}GREAT` : `${power}GOOD`;
    const col = aerr <= W_PERFECT ? '#fff568' : aerr <= W_GREAT ? '#66e0ff' : '#9fc2d4';
    this._judge(`${label} +${pts * this.S.mult}`, col, s.mesh);
    this._explode(s.mesh.position, s.u.uCol.value, hit.hand, hit.speed);
    this._hitSound(aerr <= W_PERFECT);
    this._hitFlash(s.u.uCol.value, Math.min(hit.speed / MEGA_SPEED, 1));
    if (this.S.mult > prevMult) this._multBanner(this.S.mult);
    if (hit.hand) hit.hand._glowKick = 1;   // read by handlab → rig uGlow flash
    // the note flash-expands for a beat instead of vanishing instantly
    s.state = 'pop';
    s.pop = 0.13;
    s.tele.material.opacity = 0;
    this._refreshHud();
  }

  _moveWalls(t, dt) {
    let anyWall = false;
    for (let i = this._activeWalls.length - 1; i >= 0; i--) {
      const s = this._activeWalls[i];
      const w = s.wall;
      // wall front face arrives at the player on w.time
      const zFront = HIT_Z - (w.time - t) * this.speed;
      s.mesh.position.z = zFront - s.len / 2;
      anyWall = true;
      const overPlayer = zFront > -0.35 && zFront - s.len < 0.45;
      if (overPlayer && !s.crashed) {
        // dodge check: head lean must be OUT of the wall's half
        const lean = (this._headX - 0.5) * 1.5;                // → local x
        const inside = w.side === 'left' ? lean < 0.10 : lean > -0.10;
        if (inside) {
          s.crashed = true;
          s.u.uHot.value = 1;
          this.S.wallsHit++; this.S.streak = 0;
          this.S.score = Math.max(0, this.S.score - 150);
          this._refreshMult(); this._refreshHud();
          this.dom.flash.style.opacity = 1;
          setTimeout(() => this.dom.flash.style.opacity = 0, 260);
          this._judge('CRASH −150', '#ff5a7a', s.mesh);
        }
      }
      if (!s.crashed && !s.scored && zFront - s.len > 0.5) {
        s.scored = true;
        this.S.wallsDodged++; this.S.score += 50 * this.S.mult;
        this._judge('DODGE +' + 50 * this.S.mult, '#7df0c8', s.mesh);
        this._refreshHud();
      }
      s.u.uHot.value *= 0.94;
      if (zFront - s.len > 1.5) { this._freeWall(s); this._activeWalls.splice(i, 1); }
    }
    if (!anyWall) this.dom.lean.style.display = 'none';
  }

  // ═══ FX ═══
  _explode(pos, color, hand, speed = 1) {
    const fx = this._fxPool.find(f => !f.busy);
    if (!fx) return;
    const power = 1 + Math.min(speed / MEGA_SPEED, 1) * 1.1;   // harder punch → bigger blast
    fx.busy = true; fx.life = 0.62;
    fx.pts.material.color.copy(color);
    fx.pts.material.size = 0.028 * power;
    fx.ring.material.color.copy(color);
    const attr = fx.pts.geometry.getAttribute('position');
    // shards inherit the punch direction — the hit "carries through"
    _u.set(0, 0, 1);
    if (hand && hand.palmVel.lengthSq() > 1e-4) {
      const mag = Math.min(hand.palmVel.length(), 3) / 3;
      _u.copy(hand.palmVel).transformDirection(this._invRoot).multiplyScalar(mag);
    }
    for (let k = 0; k < fx.vel.length; k++) {
      attr.setXYZ(k, pos.x, pos.y, pos.z);
      fx.vel[k].randomDirection().multiplyScalar((0.8 + Math.random() * 1.6) * power)
        .addScaledVector(_u, (0.9 + Math.random()) * power);
    }
    attr.needsUpdate = true;
    fx.pts.visible = true; fx.pts.material.opacity = 1;
    fx.ring.visible = true; fx.ring.material.opacity = 0.9;
    fx.ring.position.copy(pos);
    fx.ring.scale.setScalar(power * 0.9);
    fx.ring.userData.grow = 9 * power;
    fx.ring.lookAt(this.camera.position);
  }

  /** Brief tinted screen bloom on every hit — punch feedback you can't miss. */
  _hitFlash(color, power) {
    const el = this.dom.hitFlash;
    el.style.background = `radial-gradient(ellipse at 50% 55%, ${'#' + color.getHexString()}30 0%, transparent 60%)`;
    el.style.opacity = 0.5 + power * 0.5;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.style.opacity = 0, 90);
  }

  /** Multiplier level-up banner: ×2 / ×4 / ×8 slams the centre. */
  _multBanner(mult) {
    const el = this.dom.mult;
    el.textContent = `×${mult}`;
    el.classList.remove('slam');
    void el.offsetWidth;                      // restart the CSS animation
    el.classList.add('slam');
  }

  _updateFx(dt) {
    for (const fx of this._fxPool) {
      if (!fx.busy) continue;
      fx.life -= dt;
      if (fx.life <= 0) { fx.busy = false; fx.pts.visible = false; fx.ring.visible = false; continue; }
      const attr = fx.pts.geometry.getAttribute('position');
      for (let k = 0; k < fx.vel.length; k++) {
        fx.vel[k].y -= 1.6 * dt;
        attr.setXYZ(k, attr.getX(k) + fx.vel[k].x * dt, attr.getY(k) + fx.vel[k].y * dt, attr.getZ(k) + fx.vel[k].z * dt);
      }
      attr.needsUpdate = true;
      const a = fx.life / 0.62;
      fx.pts.material.opacity = a;
      fx.ring.material.opacity = a * 0.9;
      fx.ring.scale.addScalar(dt * (fx.ring.userData.grow || 9));
    }
  }

  _hitSound(perfect) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(perfect ? 880 : 620, t);
    o.frequency.exponentialRampToValueAtTime(perfect ? 1760 : 930, t + 0.07);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + 0.14);
  }

  _judge(text, color, mesh) {
    const j = this._judges.find(x => x.t <= 0) || this._judges[0];
    _p.copy(mesh.position);
    this.root.localToWorld(_p).project(this.camera);
    j.el.textContent = text;
    j.el.style.color = color;
    j.el.style.left = `${(_p.x * 0.5 + 0.5) * 100}%`;
    j.el.style.top = `${(-_p.y * 0.5 + 0.5) * 100 - 4}%`;
    j.el.classList.remove('pop');
    void j.el.offsetWidth;                    // restart the slam animation
    j.el.classList.add('pop');
    j.t = 0.62;
  }

  _freeNote(s) {
    s.busy = false; s.mesh.visible = false;
    s.halo.material.opacity = 0; s.tele.material.opacity = 0;
    s.tele.scale.setScalar(1); s.u.uGlow.value = 0;
  }
  _freeWall(s) { s.busy = false; s.mesh.visible = false; }

  _refreshMult() {
    let m = 1;
    for (let i = 0; i < MULT_STEPS.length; i++) if (this.S.streak >= MULT_STEPS[i]) m = 1 << i;
    this.S.mult = m;
  }

  _refreshHud() {
    this.dom.score.textContent = this.S.score;
    const acc = this.S.judged ? Math.round((this.S.accSum / this.S.judged) * 100) : 100;
    this.dom.sub.innerHTML = `×<b>${this.S.mult}</b> · STREAK ${this.S.streak} · ACC ${acc}%`;
  }

  _progress(t) {
    const total = this.map.duration || this.track.duration || 1;
    this.dom.progBar.style.width = `${Math.min(100, (t / total) * 100)}%`;
  }

  // ═══ results + leaderboard ═══
  _rank(acc, missRate) {
    if (acc >= 0.95 && missRate <= 0.02) return 'S';
    if (acc >= 0.88 && missRate <= 0.08) return 'A';
    if (acc >= 0.78 && missRate <= 0.18) return 'B';
    if (acc >= 0.6 && missRate <= 0.35) return 'C';
    if (missRate <= 0.6) return 'D';
    return 'F';
  }

  _results() {
    const S = this.S;
    const acc = S.judged ? S.accSum / S.judged : 0;
    const missRate = S.judged ? S.misses / S.judged : 1;
    const rank = this._rank(acc, missRate);
    const key = `${this._lastName || 'track'}|${this.difficulty}`;
    const lbAll = JSON.parse(localStorage.getItem('handlab_beatrush_lb') || '{}');
    const lb = lbAll[key] = lbAll[key] || [];
    const entry = { score: S.score, acc: Math.round(acc * 100), rank, streak: S.maxStreak, date: new Date().toISOString().slice(0, 10) };
    lb.push(entry);
    lb.sort((a, b) => b.score - a.score);
    lbAll[key] = lb.slice(0, 8);
    localStorage.setItem('handlab_beatrush_lb', JSON.stringify(lbAll));

    const rows = lbAll[key].map((e) =>
      `<tr${e === entry ? ' class="me"' : ''}><td>${e.score}</td><td>${e.acc}%</td><td>${e.rank}</td><td>×${e.streak}</td><td>${e.date}</td></tr>`).join('');
    this.dom.results.innerHTML = `
      <div class="card">
        <div class="rank">${rank}</div>
        <div class="big">${S.score}</div>
        <div class="meta">${S.hits} hit · ${S.misses} missed · max streak ×${S.maxStreak} · acc ${Math.round(acc * 100)}%<br>
          walls dodged ${S.wallsDodged} · crashed ${S.wallsHit}</div>
        <table><tr><th>SCORE</th><th>ACC</th><th>RANK</th><th>STREAK</th><th>DATE</th></tr>${rows}</table>
        <button class="primary" id="brRetry">⟲ RETRY</button><button id="brClose">CLOSE</button>
      </div>`;
    this.dom.results.style.display = 'grid';
    this.dom.results.querySelector('#brRetry').onclick = () => { this.dom.results.style.display = 'none'; this.opts.onRetry?.(); };
    this.dom.results.querySelector('#brClose').onclick = () => { this.dom.results.style.display = 'none'; };
  }

  /** Remember track label for the leaderboard key. */
  setTrackLabel(name) { this._lastName = name; }

  snapshot(out = {}) {
    out.running = this.running;
    out.songTime = this.running && this.track ? this.track.time() : 0;
    out.score = this.S.score; out.streak = this.S.streak; out.mult = this.S.mult;
    out.notesLive = this._active.length; out.beat = this._beat;
    out.headX = this._headX;
    return out;
  }
}
