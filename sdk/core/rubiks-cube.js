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
