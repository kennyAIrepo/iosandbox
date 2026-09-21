/**
 * sdk/game/shelf.js — the SHELF the game ball rests on (B1 decision 2): a per-tile plane at `court.shelf` (42 %) of the tile
 * height, chest height, where hands are actually tracked. Physics-wise the shelf is just PropBall.floorY = tileWorldRect(seat).floorY
 * (court-map.js CourtMap.floorY = the shelf line); this module is the LOOK: a translucent Fluent-tinted holo plane + the soft
 * contact-shadow blob that pins the ball to it. Both come from sdk/core/rubiks-cube.js (makeHoloTable / makeContactShadow) by
 * import — the cube lab's table, re-posed for a tile seen from the front.
 *
 * Pose: the tile camera sits at the tile centre looking down -z, and the shelf line is 8 % of a tile height BELOW the camera,
 * so a truly horizontal plane at the hand plane would be seen edge-on (a hairline). The group is pitched by SHELF_TILT so the
 * plane reads as a ledge going up-and-back from the ball's contact line (the near edge, at the hand plane z = -D, is the
 * shelf line itself; the far edge rises SHELF_DEPTH·sin(tilt)). Unlit ShaderMaterials, transparent, no depthWrite: the hand
 * depth-prepass still occludes it behind a real hand, and it never fights the ball (renderOrder 30) or the rigs. Layer 0
 * (the tile cameras render layer 0 + their own rig layer), so ONE mesh per seat on the ONE stage — no per-tile renderers.
 */
import * as THREE from 'three';
import { makeHoloTable, makeContactShadow } from '../core/rubiks-cube.js';
import { D } from './court-space.js';

export const SHELF_TILT = 0.34;        // rad: pitch of the plane toward the camera (0 = edge-on hairline)
export const SHELF_DEPTH = 0.55;       // m along the (tilted) plane, from the contact line back
export const SHELF_LIP = 0.05;         // m of plane in FRONT of the contact line (a small front lip under the ball)
export const SHELF_COLOR = 0x8b8ff4;   // Fluent / Teams brand tint (the cube lab's cyan re-tinted)
export const SHADOW_MAX_H = 0.45;      // m: the contact shadow fades out over this height above the plane

/**
 * Build the shelf for a tile rect. Returns a THREE.Group with `.table` (the plane), `.shadow` (the blob), `.rect`, `.y` (the
 * shelf line in world y) and `.tilt`; positioned by placeShelf(). Add it to the stage scene yourself.
 * @param {{x0:number,x1:number,y0:number,y1:number,floorY:number}} rect   tileWorldRect(seat) (floorY = the shelf line)
 * @param {{tilt?:number, depth?:number, color?:number, lip?:number}} [o]
 */
export function makeShelf(rect, o = {}) {
  const tilt = o.tilt ?? SHELF_TILT, depth = o.depth ?? SHELF_DEPTH, lip = o.lip ?? SHELF_LIP;
  const g = new THREE.Group();
  g.name = 'shelf';
  const table = makeHoloTable({ width: 1, depth: 1, color: o.color ?? SHELF_COLOR });
  table.rotation.x = 0;                        // the group carries the pitch; the plane stays in the group's local xy
  table.frustumCulled = false;
  table.name = 'shelf.table';
  g.add(table);
  const shadow = makeContactShadow(1);         // unit circle; scaled per frame (radius + height spread)
  shadow.rotation.x = 0;
  shadow.frustumCulled = false;
  shadow.position.z = 0.002;                   // a hair above the plane (both are depthWrite:false; renderOrder 1 < 2 keeps it under the grid)
  shadow.renderOrder = 3;
  shadow.visible = false;
  shadow.name = 'shelf.shadow';
  g.add(shadow);
  g.table = table; g.shadow = shadow; g.tilt = tilt; g.depth = depth; g.lip = lip; g.rect = null; g.y = 0;
  for (const m of [g, table, shadow]) m.layers.set(0);
  placeShelf(g, rect);
  return g;
}

/** Re-pose an existing shelf on a (new) tile rect: centre x, the shelf line y, the hand plane z; scale to the tile width. */
export function placeShelf(shelf, rect) {
  if (!rect) return shelf;
  const w = Math.max(0.1, rect.x1 - rect.x0), cx = (rect.x0 + rect.x1) / 2;
  const y = Number.isFinite(rect.floorY) ? rect.floorY : Number.isFinite(rect.shelfY) ? rect.shelfY : rect.y0;
  shelf.rect = { x0: rect.x0, x1: rect.x1, y0: rect.y0, y1: rect.y1, floorY: y };
  shelf.y = y;
  shelf.position.set(cx, y, -D);                                 // the contact line sits on the hand plane
  shelf.rotation.set(-Math.PI / 2 + shelf.tilt, 0, 0);          // local +y → world (0, sin tilt, -cos tilt): up and back
  const t = shelf.table, L = shelf.depth + shelf.lip;
  t.scale.set(w * 0.98, L, 1);
  t.position.set(0, L / 2 - shelf.lip, 0);                       // near edge at local y = -lip (in front of the contact line)
  shelf.updateMatrixWorld(true);
  return shelf;
}

/**
 * Drive the contact shadow: under the ball, scaled up and faded out with the ball's height above the plane. Hidden when the
 * ball is beyond the shelf (outside the rect's x range, or higher than SHADOW_MAX_H above the plane).
 * @param {THREE.Group} shelf      from makeShelf
 * @param {{x:number,y:number,z:number}} ballPos   world (PropBall.pos or the placed mesh position)
 * @param {number} r               ball radius (m)
 * @returns {{visible:boolean, h:number}}
 */
export function updateShelfShadow(shelf, ballPos, r) {
  const sh = shelf.shadow, rc = shelf.rect;
  if (!sh || !rc || !ballPos) { if (sh) sh.visible = false; return { visible: false, h: Infinity }; }
  const ct = Math.cos(shelf.tilt), st = Math.sin(shelf.tilt);
  // the plane point directly below the ball: local along-plane coordinate b from the ball's depth, the plane's height there
  const dz = shelf.position.z - ballPos.z;                       // > 0 when the ball is behind the contact line (deeper)
  const b = dz / Math.max(ct, 1e-3);
  const surfY = shelf.y + b * st;
  const h = ballPos.y - r - surfY;                               // ball bottom above the plane surface
  const inX = ballPos.x >= rc.x0 - r && ballPos.x <= rc.x1 + r;
  const onPlane = b >= -shelf.lip && b <= shelf.depth;
  if (!inX || !onPlane || h > SHADOW_MAX_H || h < -r) { sh.visible = false; return { visible: false, h }; }
  const k = Math.max(0, Math.min(1, h / SHADOW_MAX_H));
  const spread = r * (1.15 + 1.4 * k);
  sh.visible = true;
  sh.position.set(ballPos.x - shelf.position.x, b, 0.002);
  sh.scale.set(spread, spread, 1);
  sh.material.uniforms.uStrength.value = 0.55 * (1 - k) * (1 - k);
  return { visible: true, h };
}

/** Free the GPU resources of a shelf (geometries + materials) and detach it. */
export function disposeShelf(shelf) {
  if (!shelf) return;
  shelf.removeFromParent();
  for (const m of [shelf.table, shelf.shadow]) {
    if (!m) continue;
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
  }
}
