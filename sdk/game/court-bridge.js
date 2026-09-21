/**
 * court-bridge.mjs — the owner-side glue between the tile's 3D prop (PropBall, metres, mirror scene) and BallNet (court units).
 * DOM-free, no three.js import: the camera is duck-typed exactly as court-map.mjs does (matrixWorldInverse, projectionMatrix,
 * fov), positions/velocities are plain {x,y,z}, quaternions plain {x,y,z,w} (THREE.Vector3 / Quaternion satisfy that).
 * ─────────────────────────────────────────────────────────────────────────────
 * hopeos-wire.md §4 — how PropBall / window.hopeos map onto BallNet:
 *   • every owner frame: `net.tickOwner(toCourtBall(...))` — BallNet.tickOwner IS the launch path (ball-net.mjs:263-289):
 *     it runs CourtMap.exitEdge on the court ball and sends LAUNCH when the centre has fully left an L/R/T edge toward a
 *     neighbour. There is no separate `launch()` API and the page never derives an edge by hand.
 *   • the court conversion goes through CourtMap.worldToTile (three.js project) → CourtMap.tileToCourt(seat, u, v, mirrored=true):
 *     the ONE place the mirror flip happens (space-mapping.md §7). Velocity is converted by FINITE DIFFERENCE of two converted
 *     positions, so its sign inherits the flip from the position conversion — no axis reasoning here, none in the page.
 *   • PropBall.onExit (prop-ball.js:389-393) stays the safety net: it fires when the ball leaves `boundsR` of `home` WITHOUT
 *     having crossed a court edge (front/back of the workspace, a bounce over the top with no neighbour, a bug). `onPropExit`
 *     converts the exit state, asks CourtMap.exitEdge, and either hands it to tickOwner (a court edge after all → LAUNCH / onWall)
 *     or reports EDGE.NONE (recentre locally; still my ball; ownership unchanged).
 *   • the HOLD_OFFSET trailer: `holdFromProp` turns the local doctrine hold (PropBall.hold / cradle + the holder's pack palm frame
 *     from prop-ball.js palmPose) into the palm-local offset + relative quaternion BALL_STATE carries (sync-protocol.md §6).
 */
import { EDGE, SEAT_NONE } from './court-map.js';
import { HOLD, REASON } from './ball-net.js';

const FD_DT = 1 / 60;   // finite-difference step for the velocity conversion (s)

/**
 * Tile-world point → court point (via CourtMap only). `mirroredInput = true` (research default): the tile scene is the
 * mirrored self-view, so tileToCourt un-mirrors it here — the ONE place the flip happens. The twin passes
 * `MIRRORED_INPUT` from court-space.js (false: the court is defined in the displayed self-view space, no flip).
 */
export function worldToCourt(court, seat, camera, p, out = {}, mirroredInput = true) {
  const uv = court.worldToTile(p, camera);
  return court.tileToCourt(seat, uv.u, uv.v, mirroredInput, out);
}

/**
 * Build the court-units ball BallNet.tickOwner expects from the tile's prop state.
 * @param {import('./court-map.js').CourtMap} court
 * @param {number} seat            my sim seat
 * @param {object} camera          the tile's three.js camera (matrixWorldInverse + projectionMatrix current)
 * @param {{pos:{x,y,z}, vel:{x,y,z}, angVel?:{x,y,z}, atRest?:boolean, onFloor?:boolean, reason?:number}} prop
 * @param {object|null} hold       from holdFromProp(), or null when free
 * @param {object} out             reused per frame
 * @param {{mirroredInput?:boolean}} opts  mirroredInput (default true) → tileToCourt flip, see worldToCourt
 */
export function toCourtBall(court, seat, camera, prop, hold = null, out = {}, { mirroredInput = true } = {}) {
  const a = worldToCourt(court, seat, camera, prop.pos, _a, mirroredInput);
  _p.x = prop.pos.x + prop.vel.x * FD_DT; _p.y = prop.pos.y + prop.vel.y * FD_DT; _p.z = prop.pos.z + prop.vel.z * FD_DT;
  const b = worldToCourt(court, seat, camera, _p, _b, mirroredInput);
  out.x = a.x; out.y = a.y; out.d = 0;                                    // depth is local, never shared physics (space-mapping.md §6)
  out.vx = (b.x - a.x) / FD_DT; out.vy = (b.y - a.y) / FD_DT; out.vd = 0;
  const w = prop.angVel || _zero; out.wx = w.x; out.wy = w.y; out.wz = w.z;
  out.radius = court.R;                                                   // session constant from hand spans, not from this tile's metres
  out.hold = hold || _free; out.atRest = !!prop.atRest; out.onFloor = !!prop.onFloor;
  out.reason = prop.reason ?? REASON.THROW;
  return out;
}
const _a = {}, _b = {}, _p = { x: 0, y: 0, z: 0 }, _zero = { x: 0, y: 0, z: 0 }, _free = { mode: HOLD.FREE, slot: 0 };

/**
 * PropBall.onExit handler body. Returns the court edge the exit corresponds to; when it is a real court edge the court ball
 * is handed to tickOwner right away (LAUNCH to the neighbour, or onWall when there is none); EDGE.NONE means "not a court
 * exit — recentre locally, ownership unchanged".
 */
export function onPropExit(net, court, camera, info, hold = null, { mirroredInput = true } = {}) {
  const seat = net.simSeat;
  const cb = toCourtBall(court, seat, camera, { pos: info.pos, vel: info.vel, angVel: info.angVel, atRest: false }, hold, {}, { mirroredInput });
  const edge = court.exitEdge(seat, cb.x, cb.y, cb.radius);
  if (edge !== EDGE.NONE && net.isOwner && !net.inTransit) net.tickOwner(cb);
  return { edge, courtBall: cb, neighbour: edge === EDGE.NONE ? SEAT_NONE : court.neighbourAt(seat, edge, edge === EDGE.T ? cb.x : cb.y).seat };
}

// ── hold → HOLD_OFFSET trailer (plain quaternion math) ───────────────────────
const qConj = (q, o = {}) => { o.x = -q.x; o.y = -q.y; o.z = -q.z; o.w = q.w; return o; };
const qMul = (a, b, o = {}) => {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w; return o;
};
const qApply = (q, v, o = {}) => {           // v' = q v q*  (three.js Vector3.applyQuaternion form: v + 2w·t + 2 q×t, t = q×v)
  const vx = v.x, vy = v.y, vz = v.z;
  const tx = 2 * (q.y * vz - q.z * vy), ty = 2 * (q.z * vx - q.x * vz), tz = 2 * (q.x * vy - q.y * vx);
  o.x = vx + q.w * tx + q.y * tz - q.z * ty; o.y = vy + q.w * ty + q.z * tx - q.x * tz; o.z = vz + q.w * tz + q.x * ty - q.y * tx;
  return o;
};
const _qi = {}, _rel = {}, _d = {}, _o = {};

/**
 * @param {{type:'wrap'|'clip'|'cradle', slot:'left'|'right'}} hold   PropBall.hold ({type, slot}) or { type:'cradle', slot: ball.cradle }
 * @param {{x,y,z}} ballPos            PropBall.pos (tile world)
 * @param {{x,y,z,w}} ballQ            PropBall.quat
 * @param {{x,y,z}} palmP              palmPose() P of the HOLDER's pack (the pack of `slot`, packs.hands.find(h => h.slot === slot).points)
 * @param {{x,y,z,w}} palmQ            palmPose() Q
 * @param {number} span                |pack[9] - pack[0]| of that pack (hand-span units on the wire)
 * @returns {{mode, slot, ox, oy, oz, qx, qy, qz, qw}} the BALL_STATE hold block (ball-net.mjs encodeBallState)
 */
export function holdFromProp(hold, ballPos, ballQ, palmP, palmQ, span) {
  const mode = hold.type === 'wrap' ? HOLD.WRAP : hold.type === 'clip' ? HOLD.CLIP : HOLD.CRADLE;
  const slot = hold.slot === 'right' ? 1 : 0;
  qConj(palmQ, _qi);
  _d.x = ballPos.x - palmP.x; _d.y = ballPos.y - palmP.y; _d.z = ballPos.z - palmP.z;
  qApply(_qi, _d, _o);
  const s = span > 1e-9 ? 1 / span : 0;
  qMul(_qi, ballQ, _rel);
  return { mode, slot, ox: _o.x * s, oy: _o.y * s, oz: _o.z * s, qx: _rel.x, qy: _rel.y, qz: _rel.z, qw: _rel.w };
}

/** Receiver side: place the ball on the RECEIVED hand of the owner's seat (mechanics-options.md:89). */
export function ballFromHold(hold, palmP, palmQ, span, outPos = {}, outQ = {}) {
  _o.x = hold.ox * span; _o.y = hold.oy * span; _o.z = hold.oz * span;
  qApply(palmQ, _o, outPos); outPos.x += palmP.x; outPos.y += palmP.y; outPos.z += palmP.z;
  qMul(palmQ, { x: hold.qx, y: hold.qy, z: hold.qz, w: hold.qw }, outQ);
  return { pos: outPos, quat: outQ };
}
