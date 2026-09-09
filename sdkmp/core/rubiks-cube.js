/**
 * hopeOS SDK — Rubik's Cube (procedural) + table dressing
 * ═══════════════════════════════════════════════════════════════
 * 27 cubelets: rounded black plastic bodies + rounded stickers in the
 * standard (WCA) colour scheme, built in-browser. Why procedural and
 * not the scanned rubiks_cube.glb: that scan is 133MB (unshippable on
 * the web) and, decisively, a MONOLITHIC mesh can never twist — layer
 * rotation needs 27 independent cubelets. Here every cubelet is its
 * own Group carrying `userData.grid = {i,j,k}` (each in -1/0/1), so
 * the twist stage can collect a layer (e.g. all i === 1) and rotate
 * it about its axis without touching geometry.
 *
 * Cost: 1 shared body geometry + 1 shared sticker geometry + 7 shared
 * materials → 81 meshes, zero download.
 *
 *   const cube = buildRubiksCube({ edge: 0.17 });
 *   scene.add(cube.group);
 *   // physics drives cube.group.position/quaternion (GrabbableBox)
 *
 * Occlusion contract (same as the ball sandbox): every material here is
 * OPAQUE with depthWrite, so holo fingers wrapping the far side hide
 * behind it, and the mirror-mode depth-prepass occluder (hand-rig.js
 * setOccluder) lets your REAL fingers cover it from the front.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Standard WCA colours: white Up, yellow Down, green Front, blue Back,
// red Right, orange Left.
export const CUBE_FACES = [
  { axis: 'x', dir: +1, name: 'R', color: 0xb71c1c },
  { axis: 'x', dir: -1, name: 'L', color: 0xff6d00 },
  { axis: 'y', dir: +1, name: 'U', color: 0xf5f5f0 },
  { axis: 'y', dir: -1, name: 'D', color: 0xffd600 },
  { axis: 'z', dir: +1, name: 'F', color: 0x00a04a },
  { axis: 'z', dir: -1, name: 'B', color: 0x0d47c4 },
];

function roundedRect(w, r) {
  const s = new THREE.Shape(), h = w / 2;
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);  s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r);   s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h);  s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r); s.quadraticCurveTo(-h, -h, -h + r, -h);
  return s;
}

/** @returns {{ group, cubelets, edge, half }} */
export function buildRubiksCube({ edge = 0.17 } = {}) {
  const pitch = edge / 3;
  const size = pitch * 0.97;                       // hairline seams between cubelets
  const bodyGeo = new RoundedBoxGeometry(size, size, size, 3, size * 0.13);
  const stickGeo = new THREE.ShapeGeometry(roundedRect(size * 0.80, size * 0.145), 4);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.38, metalness: 0.25 });
  const faceMats = {};
  for (const f of CUBE_FACES) {
    faceMats[f.name] = new THREE.MeshStandardMaterial({
      color: f.color, roughness: 0.30, metalness: 0,
      // slight self-glow so the stickers stay readable over a dim webcam room
      emissive: f.color, emissiveIntensity: 0.22,
    });
  }

  const group = new THREE.Group();
  const cubelets = [];
  const off = size / 2 + 0.0006;                   // sticker sits just off the plastic
  const GRID_KEY = { x: 'i', y: 'j', z: 'k' };
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    const cl = new THREE.Group();
    cl.position.set(i * pitch, j * pitch, k * pitch);
    cl.userData.grid = { i, j, k };
    cl.add(new THREE.Mesh(bodyGeo, bodyMat));
    const grid = { i, j, k };
    for (const f of CUBE_FACES) {
      if (grid[GRID_KEY[f.axis]] !== f.dir) continue;   // stickers on OUTWARD faces only
      const st = new THREE.Mesh(stickGeo, faceMats[f.name]);
      if (f.axis === 'x')      { st.rotation.y = f.dir * Math.PI / 2;  st.position.x = f.dir * off; }
      else if (f.axis === 'y') { st.rotation.x = -f.dir * Math.PI / 2; st.position.y = f.dir * off; }
      else                     { if (f.dir < 0) st.rotation.y = Math.PI; st.position.z = f.dir * off; }
      cl.add(st);
    }
    group.add(cl);
    cubelets.push(cl);
  }
  return { group, cubelets, edge, half: edge / 2 };
}

// ── Twist mechanics ─────────────────────────────────────────────
// The classic three.js Rubik's technique (cuber et al.): to turn a layer,
// move its 9 cubelets into a PIVOT group, rotate the pivot live, and on
// release SNAP to the nearest 90° and BAKE — re-parent the cubelets,
// round positions back onto the lattice, quantize orientations to the
// 24-element cube rotation group (so float error can never accumulate),
// and re-tag each cubelet's integer grid. The middle-slice CROSS is the
// core: it anchors the cube's frame and is never twisted alone.

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const GRID_KEYS = ['i', 'j', 'k'];
const HALF_PI = Math.PI / 2;
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _tv = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3(), _c3 = new THREE.Vector3();

/**
 * Signed twist of a rotation about `axis` (unit vector) — the swing-twist
 * decomposition. Feed it (qNow · qRef⁻¹) of a palm to get how far the hand
 * has ROTATED about the slice axis since the grip closed.
 */
export function twistAngleAbout(q, axis) {
  let w = q.w, p = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  if (w < 0) { w = -w; p = -p; }                 // shortest representation
  return 2 * Math.atan2(p, w);                   // signed, (-π, π]
}

/** Quantize a quaternion to the nearest of the 24 cube rotations. */
export function snapQuat24(q) {
  _tm.makeRotationFromQuaternion(q);
  const e = _tm.elements;
  _c1.set(e[0], e[1], e[2]); _c2.set(e[4], e[5], e[6]);
  const snapAxis = (v) => {
    const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
    if (ax >= ay && ax >= az) v.set(Math.sign(v.x), 0, 0);
    else if (ay >= az) v.set(0, Math.sign(v.y), 0);
    else v.set(0, 0, Math.sign(v.z));
  };
  snapAxis(_c1); snapAxis(_c2);
  if (Math.abs(_c1.dot(_c2)) > 0.5) return q;    // degenerate rounding — keep as-is
  _c3.crossVectors(_c1, _c2);                    // exact right-handed third column
  _tm.makeBasis(_c1, _c2, _c3);
  return q.setFromRotationMatrix(_tm);
}

/**
 * RubiksModel — owns the live cube state: cubelet grid tags, the twist
 * pivot, the release snap animation, and the bake.
 *
 *   const model = new RubiksModel(buildRubiksCube({ edge }));
 *   model.beginTwist(1, [1]);          // axis Y, top layer
 *   model.setTwistAngle(theta);        // per frame, follows the hands
 *   model.releaseTwist();              // → eases to nearest 90°, bakes
 *   model.update(dt);                  // per frame (drives the snap)
 */
export class RubiksModel {
  constructor(built) {
    this.group = built.group;
    this.cubelets = built.cubelets;
    this.edge = built.edge;
    this.pitch = built.edge / 3;
    this.pivot = new THREE.Group();
    this.group.add(this.pivot);
    this.twist = null;        // { axis, layers, moving, angle, target? }
  }

  twisting() { return !!this.twist; }

  /**
   * Start a live twist. axis: 0|1|2 (cube-local x|y|z). layers: array of
   * -1|0|1 grid coordinates along that axis. The middle slice alone is
   * refused — the central cross is the CORE and stays put.
   */
  beginTwist(axis, layers) {
    if (this.twist) this._bake(true);            // finish any pending turn first
    const key = GRID_KEYS[axis];
    const set = [...new Set(layers)];
    if (!set.length || set.length >= 3) return false;
    if (set.length === 1 && set[0] === 0) return false;   // core stays
    const moving = this.cubelets.filter(c => set.includes(c.userData.grid[key]));
    if (!moving.length) return false;
    this.pivot.quaternion.identity();
    for (const c of moving) this.pivot.add(c);   // same-origin reparent: locals stay valid
    this.twist = { axis, layers: set, moving, angle: 0 };
    return true;
  }

  /** Follow the hands. Includes a DETENT: angles magnetize near 90° steps. */
  setTwistAngle(a) {
    const t = this.twist;
    if (!t || t.target !== undefined) return;
    const near = Math.round(a / HALF_PI) * HALF_PI;
    if (Math.abs(a - near) < 0.16) a = near + (a - near) * 0.45;   // cap-click feel
    t.angle = a;
    this.pivot.quaternion.setFromAxisAngle(AXES[t.axis], a);
  }

  /** The grip let go → ease to the nearest quarter turn, then bake. */
  releaseTwist() {
    if (this.twist && this.twist.target === undefined) {
      this.twist.target = Math.round(this.twist.angle / HALF_PI) * HALF_PI;
    }
  }

  /** Per frame: drives the release snap. Returns true while animating. */
  update(dt) {
    const t = this.twist;
    if (!t || t.target === undefined) return false;
    t.angle += (t.target - t.angle) * Math.min(1, dt * 14);
    if (Math.abs(t.target - t.angle) < 0.015) { this._bake(); return false; }
    this.pivot.quaternion.setFromAxisAngle(AXES[t.axis], t.angle);
    return true;
  }

  /** Bake at an exact 90° multiple: reparent, snap lattice + orientation + grid. */
  _bake(atCurrentTarget) {
    const t = this.twist;
    if (!t) return;
    const snapped = Math.round((t.target !== undefined ? t.target : t.angle) / HALF_PI) * HALF_PI;
    _tq.setFromAxisAngle(AXES[t.axis], snapped);
    for (const c of t.moving) {
      // fold the pivot's quarter turn into the cubelet's own transform
      c.position.applyQuaternion(_tq);
      c.quaternion.premultiply(_tq);
      this.group.add(c);
      // exactness: lattice-round the position, 24-group the orientation,
      // integer-rotate the grid tag
      c.position.set(
        Math.round(c.position.x / this.pitch) * this.pitch,
        Math.round(c.position.y / this.pitch) * this.pitch,
        Math.round(c.position.z / this.pitch) * this.pitch
      );
      snapQuat24(c.quaternion);
      const g = c.userData.grid;
      _tv.set(g.i, g.j, g.k).applyQuaternion(_tq);
      g.i = Math.round(_tv.x); g.j = Math.round(_tv.y); g.k = Math.round(_tv.z);
    }
    this.pivot.quaternion.identity();
    this.twist = null;
  }

  /** Is every face a single colour? (solved-state check for the game loop) */
  isSolved() {
    // solved ⇔ every cubelet carries the SAME orientation class: with
    // identical orientation all stickers of a face share one colour
    _tq.copy(this.cubelets[0].quaternion);
    return this.cubelets.every(c =>
      Math.abs(Math.abs(c.quaternion.dot(_tq)) - 1) < 1e-3);
  }
}

/**
 * Faint holo "glass shelf" — the table the cube rests on (mirror mode:
 * placed at the bottom of the camera frame). Transparent, no depthWrite,
 * so it never fights the occlusion design; the hand depth-prepass still
 * hides it correctly behind your real hand.
 */
export function makeHoloTable({ width = 3.4, depth = 1.7, color = 0x66e0ff } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */`varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform vec3 uColor; varying vec2 vUv;
      void main(){
        vec2 p = vUv - 0.5;
        float fade = smoothstep(0.5, 0.1, length(p * vec2(1.15, 1.7)));
        vec2 g = abs(fract(vUv * vec2(24.0, 12.0)) - 0.5);
        float line = smoothstep(0.07, 0.0, min(g.x, g.y));
        gl_FragColor = vec4(uColor, fade * (0.045 + line * 0.16));
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 2;
  return m;
}

/**
 * Soft round contact shadow. Drive per frame: position under the object,
 * scale up + fade out with height. This is what visually pins the cube
 * TO the table instead of hovering over it.
 */
export function makeContactShadow(r = 0.16) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.55 } },
    vertexShader: /* glsl */`varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform float uStrength; varying vec2 vUv;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(1.0, 0.12, d) * uStrength);
      }`,
    transparent: true, depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40), mat);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}
