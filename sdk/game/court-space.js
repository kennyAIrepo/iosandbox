/**
 * court-space.js — the ONE place the twin's three spaces meet: court units (CourtMap), stage pixels (the gallery DOM)
 * and world metres (the single three.js surface, design S). Pure math: Node-safe, no DOM, no three import — vectors and
 * cameras are duck-typed exactly as court-map.js does (`{x,y,z}`, `camera.matrixWorldInverse.elements`,
 * `camera.projectionMatrix.elements`, `camera.fov`, `camera.aspect`). The only import is court-map.js (pure, Node-safe).
 *
 * Frustum rule (research/gaps/render-budget/decision.md §2, game/space-mapping.md §4/§8):
 *   - every tile camera has the same FOV (50, vertical) and hand-plane distance D = 2.0 m (HandViews.cfg.mirrorDist), so
 *     the frustum height at the hand plane is U = 2·D·tan(FOV/2) = 1.8652 m = ONE court unit = ONE tile height;
 *   - the viewer's tile height in CSS px is `th`, so every camera has the same scale th/U px per metre at the plane and a
 *     court-radius R projects to R·th px at every point of every viewport ("no pop" by construction);
 *   - world = stage space: `wx = (px - stageW/2)/th·U`, `wy = (stageH/2 - py)/th·U`, `wz = -D`; camera i sits at the world
 *     position of its tile centre, looking down -z.
 *
 * Mirror decision (D-A): tiles are DISPLAYED in self-view (mirrored) space and the court is defined in that same space, so
 * court-bridge receives `mirroredInput = false` (no flip in tileToCourt). `unmirrorHands` is the C2 seam for the other
 * choice and is UNUSED by default — hand arrays are never flipped outside sdk/core/hand-views.js (chirality is measured).
 */

import { EDGE, SEAT_NONE, HAND_PLANE_D, HAND_PLANE_FOV, UNIT_M } from './court-map.js';

export const D = HAND_PLANE_D;                                     // hand-plane distance (HandViews.cfg.mirrorDist, hand-views.js:96)
export const FOV = HAND_PLANE_FOV;                                 // vertical, degrees (handlab.html:276)
export const U = UNIT_M;                                           // 1.8652 m of frustum height at the hand plane = one court unit (court-map.js derives R from it)
export const DISPLAY_MIRRORED = true;                              // D-A: tiles displayed in self-view space, court defined there
export const MIRRORED_INPUT = !DISPLAY_MIRRORED;                   // what court-bridge receives (false in the twin)

/** World (hand-plane) point → stage px. */
export function stagePxFromWorld(p, stageW, stageH, th, out = {}) {
  const k = th / U;
  out.px = stageW / 2 + p.x * k;
  out.py = stageH / 2 - p.y * k;
  return out;
}

/** Stage px → world point ON the hand plane (z = -D). */
export function worldFromStagePx(px, py, stageW, stageH, th, out = {}) {
  const k = U / th;
  out.x = (px - stageW / 2) * k;
  out.y = (stageH / 2 - py) * k;
  out.z = -D;
  return out;
}

/**
 * Court → stage px (= CourtMap.courtToViewerPx with DOM rects RELATIVE TO THE STAGE ELEMENT: {left, top, width, height}
 * per seat). Inside a tile this IS courtToViewerPx. Inside the gutter between two DOM-adjacent tiles the POSITION lerps
 * between the neighbours' edges — the seat-map gutter (0.08 u = 14.6 px at th 183) is squeezed to the DOM gap (8 px),
 * position only, never the radius (`pr` stays `court.R · th`; render-budget decision.md §2, render-budget.html courtToPx).
 * Gutter points with no DOM neighbour (the ring wrap, the outer edges) keep the nearest tile's scale as before.
 * @returns {{px:number, py:number, pr:number, seat:number}}
 */
export function courtToStagePx(court, x, y, domRects, out = {}) {
  court.courtToViewerPx(x, y, domRects, out);
  if (court.seatAt(x, y) !== SEAT_NONE) return out;
  const s = out.seat, r = court.rectOf(s), g = court.map.gutter, dA = domRects[s];
  if (!r || !dA || !(g > 0)) return out;
  const lerp = (a, b, t) => a + (b - a) * t;
  if (y >= r.y0 && y <= r.y0 + r.h) {
    if (x > r.x0 + r.w && x < r.x0 + r.w + g) {                          // gutter to the RIGHT of s
      const nb = court.neighbourAt(s, EDGE.R, y);
      if (nb.seat >= 0 && nb.wrapDx === 0 && domRects[nb.seat]) out.px = lerp(dA.left + dA.width, domRects[nb.seat].left, (x - (r.x0 + r.w)) / g);
    } else if (x < r.x0 && x > r.x0 - g) {                               // gutter to the LEFT of s
      const nb = court.neighbourAt(s, EDGE.L, y);
      if (nb.seat >= 0 && nb.wrapDx === 0 && domRects[nb.seat]) { const dB = domRects[nb.seat]; out.px = lerp(dB.left + dB.width, dA.left, (x - (r.x0 - g)) / g); }
    }
  } else if (x >= r.x0 && x <= r.x0 + r.w) {
    if (y > r.y0 + r.h && y < r.y0 + r.h + g) {                          // gutter ABOVE s (court y up, DOM y down)
      const nb = court.neighbourAt(s, EDGE.T, x);
      if (nb.seat >= 0 && domRects[nb.seat]) { const dB = domRects[nb.seat]; out.py = lerp(dA.top, dB.top + dB.height, (y - (r.y0 + r.h)) / g); }
    } else if (y < r.y0 && y > r.y0 - g) {                               // gutter BELOW s: the tile whose top neighbour is s
      const below = court.rects.find(o => o.seat !== s && Math.abs(o.y0 + o.h + g - r.y0) < 1e-6 && x >= o.x0 - 1e-6 && x <= o.x0 + o.w + 1e-6);
      if (below && domRects[below.seat]) { const dB = domRects[below.seat]; out.py = lerp(dB.top, dA.top + dA.height, (y - (r.y0 - g)) / g); }
    }
  }
  return out;
}

/** Court → world point on the hand plane: courtToStagePx → worldFromStagePx. */
export function courtToWorld(court, x, y, domRects, stageW, stageH, th, out = {}) {
  const s = courtToStagePx(court, x, y, domRects, _px);
  return worldFromStagePx(s.px, s.py, stageW, stageH, th, out);
}
const _px = {};

/** Court-unit ball radius → world metres at the hand plane (projects to court.R · th px everywhere). */
export function courtRadiusWorld(court) { return court.R * U; }

/**
 * World point → court, through the seat's uv camera: CourtMap.worldToTile (project) → tileToCourt(seat, u, v,
 * MIRRORED_INPUT). Same chain as court-bridge.worldToCourt with the twin's flag baked in.
 */
export function worldToCourt(court, seat, uvCam, p, out = {}) {
  const uv = court.worldToTile(p, uvCam, _uv);
  return court.tileToCourt(seat, uv.u, uv.v, MIRRORED_INPUT, out);
}
const _uv = {};

/**
 * The seat's tile as a world rectangle on the hand plane (metres): x0 < x1 (left/right edges), y0 < y1 (bottom/top).
 * `floorY` = the court floor (CourtMap.floorY = the SHELF line, y0 + shelf · h — B1 decision 2) in world y; `shelfY` is the
 * same number under its own name, `bottomY` (= y0) the tile's bottom edge, `shelfFrac` the fraction the court uses.
 */
export function tileWorldRect(court, seat, domRects, stageW, stageH, th) {
  const d = domRects[seat];
  if (!d) return null;
  const tl = worldFromStagePx(d.left, d.top, stageW, stageH, th, {});
  const br = worldFromStagePx(d.left + d.width, d.top + d.height, stageW, stageH, th, {});
  const r = court.rectOf(seat);
  // court.floorY(seat) is the shelf line in court y: map it through the same DOM rect so world and court agree by construction
  const floorPy = d.top + (r.y0 + r.h - court.floorY(seat)) * (d.height / r.h);
  const floorY = (stageH / 2 - floorPy) * (U / th);
  return { x0: tl.x, y0: br.y, x1: br.x, y1: tl.y, floorY, shelfY: floorY, bottomY: br.y, shelfFrac: court.shelf };
}

/**
 * C2 seam (UNUSED by default, DISPLAY_MIRRORED = true): the un-mirrored-court alternative would flip every tile's
 * landmarks once, here — `u → 1 - u` on img, `x → -x` on world — never touching slots, chirality or z.
 * @param {{left:{img,world}|null, right:{img,world}|null}} hands   TilePipeline.hands / decodeHandStream().hands shape
 */
export function unmirrorHands(hands, out = {}) {
  for (const slot of ['left', 'right']) {
    const h = hands && hands[slot];
    if (!h) { out[slot] = null; continue; }
    const o = out[slot] || (out[slot] = { img: null, world: null });
    o.img = h.img ? h.img.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })) : null;
    o.world = h.world ? h.world.map(p => ({ x: -p.x, y: p.y, z: p.z })) : null;
  }
  return out;
}

/**
 * A seat's uv camera: PerspectiveCamera(FOV, aspect, 0.01, 50) at `position` ({x,y,z}, z normally 0) looking down -z,
 * NO view offset (HandViews.mirrorPoint reads fov/aspect only, hand-views.js:243). `THREE` is passed in so this module
 * stays import-free for Node; matrices are updated so CourtMap.worldToTile / tileToWorld can use it immediately.
 */
export function makeUvCamera(THREE, aspect, position) {
  const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.01, 50);
  cam.position.set(position?.x || 0, position?.y || 0, position?.z || 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);                       // Camera.updateMatrixWorld also refreshes matrixWorldInverse
  return cam;
}
