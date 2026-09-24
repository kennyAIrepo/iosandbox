/**
 * sdk/game/prop-ball.js — the BALL DOCTRINE as a component (extracted 2026-09-18,
 * in service since 2026-09-24).
 * ═══════════════════════════════════════════════════════════════════════════
 * The GLASS (rigid sphere) lane of mpbrowser.html's `slimeLab`, lifted out so any
 * page can drop it in. IN USE BY: teamslab.html (the playable ball) and
 * mpbrowser.html's 🏀 BASKETBALL — the scanned Sketchfab ball in both the mirror
 * lab (`basketLab`) and the engine (`engSpawnBasket` / `engBallTick`), where the
 * mesh is a real GLB instead of makeBallMesh().
 *
 * AVOIDANCE GATE (2026-09-24): `resistSkin` is live. mpbrowser sets it every frame
 * from FIVE SCREEN PIXELS converted to metres at the ball's own depth, so the
 * hand-stop engages exactly when the drawn hand reaches the drawn ball at any
 * zoom; `gap` (min hand↔surface clearance) and `avoiding` are readable each frame.
 *
 * Source (mpbrowser.html WORKING TREE 2026-09-18; HEAD 6c8e6bc is these numbers minus 3):
 *   makeBallMesh (opaque, spin-visible bands)      :1206-1230
 *   slimeLab state fields                          :1284-1294
 *   hull = PropHull.sphere(R)                      :1303
 *   recenter / setScale / floorY                   :1358-1363, :1365-1374, :1480
 *   _holdPose (measured holding pose, pocket)      :1380-1402
 *   _wrapGrab (mesh-true wrap / clip gate)         :1411-1439
 *   GLASS lane (the per-frame doctrine)            :1570-1724
 *   _packRadii / _hullTouch / _handResist          :2305-2341
 *   _palmPose / _closure / _pinchR                 :6229-6257
 *   loop feed: handBodies update -> slimeLab.update :3402-3408 (rigs pose at :3103-3104)
 *
 * DOCTRINE (restated; each rule points at the code below that enforces it):
 *   1. collision is SHAPE vs SHAPE: PropHull capsule chain vs 21 joint spheres (packRadii) — never proximity to a point
 *   2. pickup ONLY by finger WRAP or thumb/finger CLIP (_wrapGrab) or the measured HOLDING-POSE cradle (_holdPose)
 *   3. open hand = release THAT frame (hold re-tested every frame with a looser 0.03 skin)
 *   4. gravity ALWAYS on: the GrabbableSphere integrates with an EMPTY hand list (its own jointsWithin/pinch grab never runs)
 *   5. hands SUPPORT and never pass through: hull.pushOut (ball yields, <= 2 cm/frame) + handResist (the pack is moved out)
 *   6. the only "seeks" are z-only depth bias and x/z pocket attraction — never lifted, never gravity-off
 *   7. nothing here reads MediaPipe handedness or hard-codes a z sign: the inner-palm side is MEASURED (_holdPose)
 *   8. [D7] extraBodies (T9 body layer): BodyBody joint spheres SUPPORT the ball exactly like hands (hull.pushOut, <= 2 cm/frame,
 *      no bounce into the body, friction) and NEVER grab — BodyBody.openness is pinned 1 and no grab gate ever reads a body
 */
import * as THREE from 'three';
import { GrabbableSphere, JOINT_RADII } from '../core/game-physics.js';   // game-physics.js:225, :38
import { PropHull } from '../core/prop-hull.js';                          // prop-hull.js:39

// ── module temps (fresh copies of the page temps _sbTmpA/B/C :1067, _slP/_slQ/_slQ2 :1068,
//    _gA/_gB/_gC/_gM :6230-6231, _lbA/_lbB :2272, _hgR :2305) ──
const _tA = new THREE.Vector3(), _tB = new THREE.Vector3(), _tC = new THREE.Vector3();
const _pP = new THREE.Vector3(), _pQ = new THREE.Quaternion(), _pQ2 = new THREE.Quaternion();
const _gA = new THREE.Vector3(), _gB = new THREE.Vector3(), _gC = new THREE.Vector3(), _gM = new THREE.Matrix4();
const _lbA = new THREE.Vector3(), _lbB = new THREE.Vector3();
const _hgR = new Array(21).fill(0);

// ── pure hand measures (verbatim, mpbrowser.html:6233-6257) ──────────────────
/** Palm frame: Y = wrist->middle MCP, Z = palm normal, X = YxZ (right-handed, det>0). Returns false if degenerate. */
export function palmPose(pack, outP, outQ) {                   // :6233-6246
  _gA.copy(pack[9]).sub(pack[0]);
  if (_gA.lengthSq() < 1e-10) return false;
  _gA.normalize();
  _gB.copy(pack[5]).sub(pack[17]);
  _gC.crossVectors(_gA, _gB);
  if (_gC.lengthSq() < 1e-10) return false;
  _gC.normalize();
  _gB.crossVectors(_gA, _gC).normalize();
  _gM.makeBasis(_gB, _gA, _gC);
  outQ.setFromRotationMatrix(_gM);
  outP.copy(pack[0]).lerp(pack[9], 0.5);
  return true;
}
/** 0 open ... 1 fist, scale-free (mean fingertip->wrist distance over palm length). */
export function closure(pack) {                                // :6247-6253
  const palm = _gA.copy(pack[0]).distanceTo(pack[9]);
  if (palm < 1e-6) return 0;
  let d = 0;
  for (const i of [8, 12, 16, 20]) d += _gA.copy(pack[i]).distanceTo(pack[0]);
  return Math.min(1, Math.max(0, (1.6 - (d / 4) / palm) / 0.6));
}
/** thumb-tip<->index-tip over palm length (pinch ratio). */
export function pinchRatio(pack) {                             // :6254-6257
  const palm = _gA.copy(pack[0]).distanceTo(pack[9]);
  return palm < 1e-6 ? 9 : _gA.copy(pack[4]).distanceTo(pack[8]) / palm;
}

// ── mesh-true touch helpers (verbatim, mpbrowser.html:2305-2341) ─────────────
/** World joint radii off the palm ruler: JOINT_RADII x (palm / 0.204). Shared array — consume immediately. */
export function packRadii(pack) {                              // :2306-2311
  const palm = Math.max(0.02, _lbB.copy(pack[0]).distanceTo(pack[9]));
  const k = palm / 0.204;                                       // REST_SPAN*povHandScale ref (game-physics.js:48, :103)
  for (let i = 0; i < 21; i++) _hgR[i] = JOINT_RADII[i] * k;
  return _hgR;
}
/** Min gap between the 21 joint spheres and the hull surface (<= 0 = real touch). */
export function hullTouch(hull, obj, pack) {                   // :2312-2315
  if (!hull || !pack || !pack[0]) return Infinity;
  return hull.begin(obj).handGap(pack, packRadii(pack)).gap;
}
/** HAND RESISTANCE: translate the WHOLE pack back out along the deepest contact normal (mutates pack in place).
 *  share = 1.0 for an anchored/rigid prop, 0.3 when the prop itself yields. Returns the resolved depth. */
export function handResist(hull, obj, pack, share, skin = 0.004) {           // :2324-2341
  if (!hull || !pack || !pack[0]) return 0;
  hull.begin(obj);
  const radii = packRadii(pack);
  let depth = 0;
  for (let i = 0; i < 21; i++) {
    if (!pack[i]) continue;
    const g = hull.closest(pack[i], null, _lbB) - radii[i] - skin;   // contact skin (default 4 mm)
    if (g < depth) { depth = g; _lbA.copy(_lbB); }                     // deepest contact
  }
  if (depth >= 0) return 0;
  const push = -depth * share;
  for (const p of pack) {
    if (!p) continue;
    p.x += _lbA.x * push; p.y += _lbA.y * push; p.z += _lbA.z * push;
  }
  return -depth;
}

// ── ball mesh (verbatim, mpbrowser.html:1206-1230; identical at handlab.html:486-510) ──
/** Opaque, depthWrite ball with object-space colour bands so spin is visible. Occlusion-correct with the holohand. */
export function makeBallMesh(r) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uGlow: { value: 0 } },
    vertexShader: `varying vec3 vN, vV, vO;
      void main(){ vN = normalize(normalMatrix * normal); vO = position;
        vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uGlow; varying vec3 vN, vV, vO;
      void main(){
        vec3 N = normalize(vN), V = normalize(vV);
        float ndv = abs(dot(N, V));
        float fres = pow(1.0 - ndv, 1.8);
        vec3 L = normalize(vec3(0.4, 0.8, 0.5));
        float dif = 0.45 + 0.55 * max(dot(N, L), 0.0);
        float bands = step(0.0, sin(atan(vO.x, vO.z) * 4.0)) * 0.5 + step(0.0, vO.y) * 0.22;
        vec3 cA = vec3(0.10, 0.35, 0.52), cB = vec3(0.62, 0.88, 1.0);
        vec3 c = mix(cA, cB, bands * 0.55 + 0.1) * dif;
        c += vec3(0.55, 0.9, 1.0) * fres * 0.7 + vec3(0.95, 0.6, 0.3) * uGlow;
        gl_FragColor = vec4(c, 1.0);
      }`,
    transparent: false, depthWrite: true,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(r, 26, 18), mat);
}

const _newPose = () => ({ pose: false, pc: new THREE.Vector3(), n: new THREE.Vector3(), pocket: new THREE.Vector3(), closure: 0, evi: 0, sign: 0,
  pcPrev: new THREE.Vector3(), step: 0, seen: false });   // step = the palm centre's motion since the last frame (m): the hold re-test skin grows with it (B1)

export class PropBall {
  /**
   * @param {THREE.Scene|null} scene   null is fine (Node smoke tests)
   * @param {object} opts
   *   radius      metres (SLIME_R = 0.16 in the page; the sandbox ball is 0.13)
   *   gravity     -4.2 (page glass) / -5.2 (page sandbox ball)      -> GrabbableSphere
   *   restitution 0.42 / 0.58                                       -> GrabbableSphere
   *   mesh        your own THREE.Mesh (any material) or omit for makeBallMesh(radius)
   *   home        THREE.Vector3 workspace centre (views.workspaceCenter(camera)); default (0,0,-2)
   *   floorY      default home.y - 1.05 (the page's mirror-mode floor, :1480)
   *   boundsR     3.4 m out-of-workspace radius (:1718); onExit(info) is called before the reset when given
   *   spawnOffset THREE.Vector3 added to home on reset (page: (-0.35, 0.1, 0), :1361)
   *   onGrab(slot, type) / onRelease(velVector3)   optional events
   */
  constructor(scene, opts = {}) {
    this.radius = opts.radius ?? 0.16;
    this.sphere = new GrabbableSphere(this.radius, { gravity: opts.gravity ?? -4.2, restitution: opts.restitution ?? 0.42 });   // :1286
    this.center = (opts.home ? opts.home.clone() : new THREE.Vector3(0, 0, -2));
    this.spawnOffset = opts.spawnOffset ? opts.spawnOffset.clone() : new THREE.Vector3(-0.35, 0.1, 0);
    this.floorY = opts.floorY ?? (this.center.y - 1.05);
    this.boundsR = opts.boundsR ?? 3.4;
    this.onExit = opts.onExit || null;
    this.onGrab = opts.onGrab || null;
    this.onRelease = opts.onRelease || null;
    this.userS = 1;                                            // live scale (two-hand pinch / UI)
    this.hull = PropHull.sphere(this.radius);                  // :1303 — EXACT sphere hull
    this.mesh = opts.mesh || makeBallMesh(this.radius);
    this.mesh.renderOrder = 30;
    if (scene) scene.add(this.mesh);
    // the conform collider the HoloHandRig skin wraps onto (hand-rig.js:440-447); pass it in rig.pose(pack, [ball.collider])
    this.collider = { type: 'sphere', center: new THREE.Vector3(), radius: this.radius, active: false };   // :1066, :1715-1717
    // interaction state (:1287-1294)
    this._scal = null; this.seek = null; this.seekHand = null;
    this.hold = null; this._velHist = [];                      // { slot, type:'wrap'|'clip', posOff, quatOff }
    this.cradle = null;                                        // slot of the HOLDING-POSE hand it rests in
    this._pose = { left: _newPose(), right: _newPose() };
    this._gT = new Uint8Array(21); this._gN = new Array(21).fill(0).map(() => new THREE.Vector3());
    // SCREEN-SPACE GRASP (2026-09-24). A camera cannot measure depth, so "the
    // hand is on the ball" is a SCREEN fact, and the world z has to be mocked to
    // match it. The page supplies grasp(slot, pack, R) -> { over, closing, z }:
    //   over    the hand overlaps the ball's screen circle (within N px of it)
    //   closing that hand is closing (curl or pinch) — intent, never proximity alone
    //   z       the depth to mock the ball to, so the fingers can actually close
    // Without it the lane keeps its old world-space behaviour verbatim.
    this.grasp = opts.grasp || null;
    // ── THE DEI LANE (dei_full.html, restored 2026-09-24) ──
    // The route that always worked on a webcam, because it never pretends the
    // camera knows depth: the ball COMES TO THE HAND from across the workspace,
    // and a hand ON it takes it — no pose to hit, no curl threshold to pass.
    //   attract  { zone, force }  approach zone in metres, drift per 1/60 s
    //   grabNear { need, margin } landmarks that must be on it, and the skin
    //   float    no gravity: it hangs where you left it (mirror AR, no floor)
    this.attract = opts.attract || null;
    this.grabNear = opts.grabNear || null;
    this.float = !!opts.float;
    this.zone = 'far';                                         // far | approach | contact
    this.overSlot = null;                                      // which hand is on it this frame (screen truth)
    this.resistSkin = opts.resistSkin ?? 0.004;                // contact skin for the HAND-STOP, live (metres)
    this.gap = Infinity;                                       // min hand↔surface clearance this frame (metres)
    this.avoiding = false;                                     // …and whether that put avoidance in charge
    this.extraBodies = [];                                     // [D7] default for update(): {joints, radii, present} bodies (BodyBody) — support only
    this.recenter();
  }

  /** Move the workspace (call with views.workspaceCenter(camera, v) on view/resize changes). */
  setHome(center, floorY) {
    this.center.copy(center);
    this.floorY = (floorY !== undefined) ? floorY : this.center.y - 1.05;
    this.recenter();
  }
  recenter() {                                                 // :1358-1363 minus the slime branch
    this.sphere.reset(this.center.clone().add(this.spawnOffset));
    this.hold = null; this.cradle = null; this._velHist.length = 0;
  }
  setScale(sc) {                                               // :1365-1374 minus glass thickness + sim
    this.userS = Math.max(0.4, Math.min(3, sc));
    this.mesh.scale.setScalar(this.userS);
    this.sphere.radius = this.radius * this.userS;
    this.collider.radius = this.radius * this.userS;
    this.mesh.updateMatrixWorld(true);
  }
  get pos() { return this.sphere.pos; }
  get vel() { return this.sphere.vel; }
  get quat() { return this.sphere.quat; }

  /** The HOLDING POSE, measured per hand (verbatim :1380-1402): palm facing UP by the MEASURED inner-palm
   *  normal (thumb column volar of the knuckle plane + fingertip curl, decay-latched), fingers out, slightly
   *  curled. pocket = one radius (+4 cm) up the inner normal from the palm centre. */
  _holdPose(slot, pack, R) {
    const P = this._pose[slot]; P.pose = false;
    if (!pack || !pack[0] || !pack[9] || !pack[5] || !pack[17]) return P;
    P.pc.set(0, 0, 0); for (const i of [0, 5, 9, 13, 17]) { const q = pack[i] || pack[0]; P.pc.x += q.x * 0.2; P.pc.y += q.y * 0.2; P.pc.z += q.z * 0.2; }
    P.step = P.seen ? P.pc.distanceTo(P.pcPrev) : 0; P.pcPrev.copy(P.pc); P.seen = true;
    _tA.set(pack[9].x - pack[0].x, pack[9].y - pack[0].y, pack[9].z - pack[0].z);
    const span = _tA.length(); if (span < 1e-4) return P;
    _tA.normalize();
    _tB.set(pack[5].x - pack[17].x, pack[5].y - pack[17].y, pack[5].z - pack[17].z);
    _tC.crossVectors(_tA, _tB); if (_tC.lengthSq() < 1e-10) return P;
    _tC.normalize();
    let volar = 0;
    for (const i of [1, 2]) if (pack[i]) volar += (pack[i].x - pack[0].x) * _tC.x + (pack[i].y - pack[0].y) * _tC.y + (pack[i].z - pack[0].z) * _tC.z;
    for (const i of [8, 12, 16, 20]) if (pack[i]) volar += ((pack[i].x - P.pc.x) * _tC.x + (pack[i].y - P.pc.y) * _tC.y + (pack[i].z - P.pc.z) * _tC.z) * 0.5;
    volar /= span;
    P.evi = P.sign === 0 ? volar : P.evi * 0.85 + volar * 0.15;
    if (P.sign === 0 || Math.abs(P.evi) > 0.04) P.sign = P.evi >= 0 ? 1 : (P.evi < 0 ? -1 : 0);
    if (P.sign === 0) return P;
    P.n.copy(_tC).multiplyScalar(P.sign);
    P.closure = closure(pack);
    P.pocket.copy(P.pc).addScaledVector(P.n, R + 0.04);
    P.pose = P.n.y > 0.25 && P.closure > 0.02 && P.closure < 0.8;   // B1 (3): 0.25 (was 0.4) — a webcam's palm-up normal is noisy
    return P;
  }
  /** Read-only: the measured holding-pose record of a slot ({pose, pc, n, pocket, closure, evi, sign}) for HUDs (BallGame.handState). */
  handPose(slot) { return this._pose[slot] || null; }

  /** MESH-TRUE grab gate (verbatim :1411-1439). Every joint sphere is tested against the hull and its contact
   *  NORMAL kept: wrap = a palm-region joint touches AND >= 2 finger joints (from >= 2 fingers) touch with normals
   *  more than ~72 deg from the palm contact; clip = a thumb joint and an index/middle joint touch on opposite sides.
   *  The ball must be on the INNER side of the measured palm — the back of the hand never grips. */
  _wrapGrab(pack, skin, slot) {
    if (!this.hull || !pack || !pack[0]) return null;
    const PS = slot ? this._pose[slot] : null;
    if (PS && PS.sign !== 0) {
      _tC.set(this.sphere.pos.x - PS.pc.x, this.sphere.pos.y - PS.pc.y, this.sphere.pos.z - PS.pc.z);
      if (_tC.dot(PS.n) < 0) return null;
    }
    const H = this.hull.begin(this.mesh), rad = packRadii(pack), T = this._gT, N = this._gN;
    for (let i = 0; i < 21; i++) {
      const q = pack[i]; T[i] = 0; if (!q) continue;
      const g = H.closest(_tA.set(q.x, q.y, q.z), null, N[i]) - rad[i];
      if (g <= skin && g > -0.03) T[i] = 1;             // touching — sunk deeper is interpenetration, not a grip
    }
    _tB.set(0, 0, 0); let np = 0, palm = 0;
    for (const i of [0, 1, 5, 9, 13, 17]) if (T[i]) { _tB.add(N[i]); np++; if (i !== 1) palm++; }
    if (np && palm) {
      _tB.normalize(); let opp = 0, fingers = 0;
      for (const i of [6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20]) if (T[i] && N[i].dot(_tB) < 0.3) { opp++; fingers |= 1 << ((i - 5) / 4 | 0); }
      if (opp >= 2 && (fingers & (fingers - 1)) !== 0) return { type: 'wrap' };
    }
    for (const t of [3, 4]) if (T[t]) for (const f of [7, 8, 11, 12]) if (T[f] && N[f].dot(N[t]) < -0.2) return { type: 'clip' };
    return null;
  }

  /** nearest landmark distance to the ball centre (dei_full.html minLandmarkDist) */
  _minDist(pack) {
    let m = Infinity;
    for (let i = 0; i < 21; i++) { const q = pack[i]; if (!q) continue;
      const d = Math.hypot(q.x - this.sphere.pos.x, q.y - this.sphere.pos.y, q.z - this.sphere.pos.z);
      if (d < m) m = d; }
    return m;
  }
  /** how many of the contact landmarks are on it (dei_full.html countNearLandmarks) */
  _countNear(pack, within) {
    let n = 0;
    for (const i of [0, 4, 5, 8, 9, 12, 13, 16, 17, 20]) { const q = pack[i]; if (!q) continue;
      if (Math.hypot(q.x - this.sphere.pos.x, q.y - this.sphere.pos.y, q.z - this.sphere.pos.z) < within) n++; }
    return n;
  }
  /** the palm centre the DEI lane carried the ball by (wrist + 3 MCPs) */
  _palmC(pack, out) {
    out.set(0, 0, 0); let n = 0;
    for (const i of [0, 5, 9, 17]) { const q = pack[i]; if (!q) continue; out.x += q.x; out.y += q.y; out.z += q.z; n++; }
    if (n) out.multiplyScalar(1 / n);
    return out;
  }
  /** DEI CONTACT: enough landmarks on the ball — proximity IS the intent */
  _nearGrab(pack, R) {
    if (!this.grabNear) return null;
    const contact = R + (this.grabNear.margin ?? 0.03);
    if (this._minDist(pack) >= contact) return null;
    if (this._countNear(pack, contact + 0.1) < (this.grabNear.need ?? 4)) return null;
    return { type: 'near' };
  }

  /**
   * The screen-space grab: a hand that is ON the ball on screen AND closing.
   * This is the DEI basketball gate (intent + proximity, game-physics.js:296-312)
   * restated against the page's screen truth instead of a world radius, because
   * a webcam's depth is a guess and the world radius test silently never fires
   * when the hand's guessed depth differs from the ball's.
   * @param {boolean} holding loosen it (hysteresis) while the ball is already held
   */
  _graspGrab(slot, pack, R, holding = false) {
    if (!this.grasp) return null;
    const G = this.grasp(slot, pack, R, holding);
    if (!G || !G.over || !G.closing) return null;
    return { type: 'grip', z: G.z, target: G.target };
  }

  /**
   * Per frame (verbatim lane :1570-1724 with page globals swapped for fields/args).
   * @param {number} dt            seconds, clamp <= 0.05 upstream
   * @param {{L:Vector3[21]|null, R:Vector3[21]|null}} pk
   *        the SAME world packs the rigs render — views.resolve(...) output ({R, L}); plain {x,y,z} objects
   *        work too (that is how tests/_glassprobe.mjs drives the page). NOTE the keys are MESH chirality
   *        (page :1595 maps L->'left', R->'right'); hand-stop MUTATES these packs in place (handResist).
   * @param {{left?:HandBody, right?:HandBody}} [hb]  screen-slot HandBodies, ONLY for the two-hand pinch scale
   * @param {Array<{joints:Array, radii:ArrayLike<number>, present:boolean}>} [extraBodies]  [D7] BodyBody colliders (T9): SUPPORT only —
   *        pushed out of like the hands (<= 2 cm/frame, no bounce into them, friction), never a grab candidate. Defaults to
   *        this.extraBodies so a caller that passes three arguments (the scene executor) can be given a body by assignment.
   * @returns {{collider, hold, cradle, seek}}
   */
  update(dt, pk, hb = null, extraBodies = this.extraBodies) {
    const R = this.radius * this.userS;                                            // :1514
    const HL = hb && hb.left, HR = hb && hb.right;
    const twoPinch = !!(HL && HR && HL.present && HR.present && HL.pinch > 0.7 && HR.pinch > 0.7);   // :1582
    let scaling = false;
    if (twoPinch && !this.hold) {                                                  // :1584-1592 two-hand PINCH = SCALE (never moves it)
      const mid = HL.pinchPoint.clone().add(HR.pinchPoint).multiplyScalar(0.5);
      const d = HL.pinchPoint.distanceTo(HR.pinchPoint);
      if (this._scal || Math.hypot(mid.x - this.sphere.pos.x, mid.y - this.sphere.pos.y) < R + 0.15) {
        if (!this._scal) this._scal = { d0: Math.max(d, 1e-3), u0: this.userS };
        this.setScale(this._scal.u0 * d / this._scal.d0);
        scaling = true;
      }
    }
    if (!scaling) this._scal = null;
    this.mesh.updateWorldMatrix(true, false);                                       // :1594
    const hands = pk ? [['left', pk.L], ['right', pk.R]].filter(e => e[1] && e[1][0] && e[1][9]) : [];   // :1595
    for (const [slot, pack] of hands) this._holdPose(slot, pack, R);               // :1596
    for (const slot of ['left', 'right']) if (!hands.some(h => h[0] === slot)) this._pose[slot].seen = false;   // absent hand: no stale step next time
    this.seek = null; this.seekHand = null;
    // ── HOLD (wrap/clip): re-checked EVERY frame (looser skin = hysteresis); gone -> released THAT frame (:1600-1619)
    //    B1 tolerance: the re-test runs BEFORE the ball rides the palm this frame, so a carried ball trails the hand by the frame's
    //    motion; the lane's 0.03 skin (sized for a 16 cm ball) grows by the palm's per-frame step (<= 8 cm) so a 5 cm ball survives a
    //    2-3 m/s carry. At rest the skin is exactly the lane's 0.03; an OPEN hand still releases THAT frame (no opposite finger joint).
    if (this.hold) {
      const e = hands.find(h => h[0] === this.hold.slot);
      const g = e
        ? (this.hold.type === 'near'
            ? (this._minDist(e[1]) < R + (this.grabNear.margin ?? 0.03) + 0.06
               && this._countNear(e[1], R + 0.16) >= Math.max(2, (this.grabNear.need ?? 4) - 2)
               ? { type: 'near' } : null)
            : (this._wrapGrab(e[1], 0.03 + Math.min(0.08, this._pose[this.hold.slot].step), this.hold.slot)
               || this._graspGrab(this.hold.slot, e[1], R, true)))
        : null;
      if (!g) {
        _tC.set(0, 0, 0); for (const v of this._velHist) _tC.add(v);
        if (this._velHist.length) _tC.divideScalar(this._velHist.length);
        this.sphere.vel.copy(_tC);                                                  // thrown / dropped with the hand's velocity
        this.hold = null; this._velHist.length = 0;
        if (this.onRelease) this.onRelease(this.sphere.vel);
      } else {
        palmPose(e[1], _pP, _pQ);                                                    // ride the palm frame
        _tB.copy(this.hold.posOff).applyQuaternion(_pQ).add(_pP);
        _tC.copy(this.sphere.pos);
        this.sphere.pos.lerp(_tB, 0.6);
        _pQ2.copy(_pQ).multiply(this.hold.quatOff); this.sphere.quat.slerp(_pQ2, 0.5);
        _tC.subVectors(this.sphere.pos, _tC).divideScalar(Math.max(dt, 1e-3));
        this._velHist.push(_tC.clone()); if (this._velHist.length > 6) this._velHist.shift();
        this.sphere.vel.copy(_tC);
        this.hold.type = g.type;
      }
    }
    // ── GRAB gate for a free (or cradled) ball: wrap or clip, touching (6 mm skin) (:1621-1630)
    if (!this.hold && !scaling) for (const [slot, pack] of hands) {
      const g = this._nearGrab(pack, R) || this._wrapGrab(pack, 0.006, slot) || this._graspGrab(slot, pack, R);
      if (!g) continue;
      // a SCREEN grab takes the mocked depth with it: the offset is captured
      // after the snap, so the ball is IN the hand rather than wherever its
      // guessed depth happened to leave it
      if (g.target) { this.sphere.pos.set(g.target.x, g.target.y, g.target.z); this.sphere.vel.set(0, 0, 0); }
      else if (g.z != null) { this.sphere.pos.z = g.z; this.sphere.vel.z = 0; }
      palmPose(pack, _pP, _pQ);
      this.hold = { slot, type: g.type,
        posOff: _tB.copy(this.sphere.pos).sub(_pP).applyQuaternion(_pQ2.copy(_pQ).invert()).clone(),
        quatOff: _pQ2.copy(_pQ).invert().multiply(this.sphere.quat).clone() };
      this._velHist.length = 0; this.sphere.vel.set(0, 0, 0); this.cradle = null;
      if (this.onGrab) this.onGrab(slot, g.type);
      break;
    }
    // ── CRADLE / POCKET ATTRACTION (holding pose): x/z only — gravity does the falling; never lifted (:1631-1652)
    let cradleP = null;
    if (!this.hold && !scaling) {
      if (this.cradle) {
        const P = this._pose[this.cradle], e = hands.find(h => h[0] === this.cradle);
        if (e && P.pose && P.n.y > 0.3 && this.sphere.pos.distanceTo(P.pocket) < R * 1.1) cradleP = P;
        else this.cradle = null;                                                    // palm tilted / hand gone -> rolls off
      }
      if (!this.cradle) for (const [slot] of hands) {
        const P = this._pose[slot]; if (!P.pose) continue;
        const dx = P.pocket.x - this.sphere.pos.x, dy = P.pocket.y - this.sphere.pos.y, dz = P.pocket.z - this.sphere.pos.z;
        if (Math.hypot(dx, dz) > R * 3.5 || dy > R * 0.8 || Math.abs(dy) > 0.9) continue;   // in reach (B1 (3): 3.5 R, was 2.5), not above the ball
        const k = Math.min(1, dt * 3);
        this.sphere.pos.x += dx * k; this.sphere.pos.z += dz * k;
        this.sphere.vel.x *= 0.8; this.sphere.vel.z *= 0.8;
        this.seek = 'pocket'; this.seekHand = hands.find(h => h[0] === slot)[1];
        if (Math.hypot(dx, dy, dz) < R * 1.0) { this.cradle = slot; cradleP = P; }   // B1 (3): capture at 1.0 R (was 0.6) for a 5 cm ball
        break;
      }
    }
    // ── DEPTH BIAS (the cube doctrine): a hand over the ball on screen has the ball's z come to CONTACT depth on
    //    the hand's inner side — z only, gravity untouched, never lifted, never moved on screen (:1653-1674)
    this.overSlot = null;
    if (!this.hold && !this.cradle && !scaling && !this.seek) for (const [slot, pack] of hands) {
      const G = this.grasp ? this.grasp(slot, pack, R, false) : null;
      let near = G ? G.over : false;
      if (!G) for (const i of [0, 5, 9, 13, 17, 4, 8, 12, 16]) { const q = pack[i]; if (q && Math.hypot(q.x - this.sphere.pos.x, q.y - this.sphere.pos.y) < R * 1.2) { near = true; break; } }
      if (!near) continue;
      this.overSlot = slot;
      const P = this._pose[slot], pc = _tA.copy(pack[0]).lerp(pack[9], 0.5);
      const side = Math.sign(this.sphere.pos.z - pc.z) || -1;                        // the side it is ALREADY on — never through the hand
      const off = (R + 0.03) * (P.sign !== 0 ? Math.max(0.15, Math.abs(P.n.z)) : 1);
      // A CLOSING hand gets the ball INTO the grasp (the hand's own depth): parking
      // it a radius off the palm is why fingers could never close round it, and why
      // it always drew behind the hand. An OPEN hand keeps the old contact depth.
      // ENGAGE brings it into the hand; a merely open hand keeps the old
      // contact depth, so an open palm still cannot swallow it
      const closing = !!(G && G.engage);
      if (closing && G.target) {
        // ALONG THE CAMERA RAY: the depth changes, the pixel does not. Moving on
        // the world z axis instead would slide the ball off the hand on screen.
        const f = Math.min(1, dt * 12);
        this.sphere.pos.x += (G.target.x - this.sphere.pos.x) * f;
        this.sphere.pos.y += (G.target.y - this.sphere.pos.y) * f;
        this.sphere.pos.z += (G.target.z - this.sphere.pos.z) * f;
        this.sphere.vel.set(0, 0, 0);                                                // no momentum from a mocked move
        this.seek = 'grasp'; this.seekHand = pack;
        break;
      }
      const zt0 = pc.z + side * off;
      if (Math.abs(zt0 - this.sphere.pos.z) < 0.004) continue;
      const zt = Math.max(this.center.z - 0.9, Math.min(this.center.z + 0.9, zt0));
      this.sphere.pos.z += (zt - this.sphere.pos.z) * Math.min(1, dt * 6);
      this.seek = 'z'; this.seekHand = pack;
      break;
    }
    // ── DEI APPROACH ZONE: a hand anywhere near it and the ball comes TO the
    //    hand (all axes, gravity suspended while it closes). This is the whole
    //    reason the DEI route worked on a webcam: you never have to find the
    //    ball in depth — it finds you.
    this.zone = 'far';
    let attracting = false;
    if (this.attract && !this.hold && !scaling) {
      let best = Infinity, bestPack = null;
      for (const [, pack] of hands) { const d = this._minDist(pack); if (d < best) { best = d; bestPack = pack; } }
      if (bestPack && best < this.attract.zone) {
        const contact = R + ((this.grabNear && this.grabNear.margin) || 0.03);
        this.zone = best < contact ? 'contact' : 'approach';
        if (best > contact) {
          attracting = true;
          this._palmC(bestPack, _tB).sub(this.sphere.pos);
          const len = _tB.length();
          if (len > 1e-5) {
            const f = (this.attract.force ?? 0.04) * (1 - best / this.attract.zone) * Math.min(3, dt * 60);
            this.sphere.pos.addScaledVector(_tB.divideScalar(len), Math.min(len, f));
            this.sphere.vel.multiplyScalar(0.6);
          }
        }
      }
    }
    // ── free flight: gravity ALWAYS on (unless this prop floats, DEI-style);
    //    the sphere only integrates + floor — its own grab logic is never given a hand (:1675-1677)
    if (!this.hold && !scaling && !cradleP && !attracting) {
      if (this.float) {
        this.sphere.pos.addScaledVector(this.sphere.vel, dt);
        this.sphere.vel.multiplyScalar(0.94);
        const w = this.sphere.angVel.length();
        if (w > 1e-4) { _pQ.setFromAxisAngle(_tA.copy(this.sphere.angVel).normalize(), w * dt);
          this.sphere.quat.premultiply(_pQ).normalize(); this.sphere.angVel.multiplyScalar(0.995); }
      } else this.sphere.update(dt, [], this.floorY);
    }
    // ── SUPPORT: a free ball is pushed OUT of every hand's joint spheres — rests on a palm, batted, never passes through (:1678-1695)
    if (!this.hold && !scaling && this.hull) {
      this.mesh.position.copy(this.sphere.pos); this.mesh.updateWorldMatrix(true, false);
      const H = this.hull.begin(this.mesh);
      for (const [slot, pack] of hands) {
        _tB.set(0, 0, 0);
        if (!H.pushOut(pack, packRadii(pack), _tB)) continue;
        const m = _tB.length(); if (m < 1e-6) continue;
        if (m > 0.02) _tB.multiplyScalar(0.02 / m);                                  // gentle: never flung — the residual stops the hand instead
        this.sphere.pos.add(_tB);
        _tB.normalize();
        const vn = this.sphere.vel.dot(_tB);
        if (vn < 0) this.sphere.vel.addScaledVector(_tB, -vn);                        // no bounce into the hand
        this.sphere.vel.multiplyScalar(0.85);                                         // contact friction
        this.mesh.position.copy(this.sphere.pos); this.mesh.updateWorldMatrix(true, false); H.begin(this.mesh);
      }
      // ── [D7] BODY SUPPORT (T9): the same shape-vs-shape push-out against every present body's joint spheres (BodyBody: 37 pose
      //    joints + 10 virtual in-between colliders) — the ball rests on a chest / shoulder / thigh, is batted by a knee, never
      //    passes through; a body is NEVER a grab candidate (no wrap / clip / cradle test reads it; BodyBody.openness is pinned 1)
      if (extraBodies && extraBodies.length) for (const b of extraBodies) {
        if (!b || !b.present || !b.joints || !b.joints.length) continue;
        _tB.set(0, 0, 0);
        if (!H.pushOut(b.joints, b.radii, _tB)) continue;
        const m = _tB.length(); if (m < 1e-6) continue;
        if (m > 0.02) _tB.multiplyScalar(0.02 / m);                                  // gentle: <= 2 cm/frame, never flung
        this.sphere.pos.add(_tB);
        _tB.normalize();
        const vn = this.sphere.vel.dot(_tB);
        if (vn < 0) this.sphere.vel.addScaledVector(_tB, -vn);                        // no bounce into the body
        this.sphere.vel.multiplyScalar(0.85);                                         // contact friction
        this.mesh.position.copy(this.sphere.pos); this.mesh.updateWorldMatrix(true, false); H.begin(this.mesh);
      }
    }
    // ── CRADLE follow (after physics, so it stays in the pocket) (:1696-1702)
    if (cradleP && !this.hold) {
      _tC.copy(this.sphere.pos);
      this.sphere.pos.lerp(cradleP.pocket, 0.6);
      _tC.subVectors(this.sphere.pos, _tC).divideScalar(Math.max(dt, 1e-3));
      this.sphere.vel.copy(_tC);                                                      // leaves the palm with the palm's velocity when tilted off
    }
    // ── HAND-STOP residual (mesh-true): whatever penetration is left stops the HAND — the carrying hand is exempt (:1703-1713)
    this.gap = Infinity; this.avoiding = false;
    this._t = (this._t || 0) + dt;
    if (this.hull && pk && !scaling) {
      this.mesh.position.copy(this.sphere.pos); this.mesh.updateWorldMatrix(true, false);
      const holder = this.hold ? this.hold.slot : null;
      for (const [slot, pack] of hands) {
        const t = hullTouch(this.hull, this.mesh, pack);        // SHAPE vs SHAPE clearance
        if (t < this.gap) this.gap = t;
        if (slot === holder || slot === this.cradle) continue;
        if (t > this.resistSkin) continue;                      // out of the skin: nothing to avoid yet
        this.avoiding = true; this._avoidAt = this._t;
        handResist(this.hull, this.mesh, pack, 1.0, this.resistSkin);
      }
    }
    // latched for anything that samples between frames (UI glow, probes)
    this.avoidingHold = this.avoiding || (this._avoidAt != null && this._t - this._avoidAt < 0.3);
    // ── conform collider for the holohand skin, depth-true (:1714-1717)
    this.collider.center.copy(this.sphere.pos);
    this.collider.radius = this.radius * this.userS;
    this.collider.active = true;
    // ── out of the workspace (:1718): tell the game (tile-to-tile pass), then reset
    if (!this.hold && !attracting && this.sphere.pos.distanceTo(this.center) > this.boundsR) {
      if (this.onExit) this.onExit({ pos: this.sphere.pos.clone(), vel: this.sphere.vel.clone(), quat: this.sphere.quat.clone(), angVel: this.sphere.angVel.clone() });
      this.sphere.reset(); this.hold = null; this.cradle = null;
    }
    this.mesh.position.copy(this.sphere.pos);                                        // :1719-1721
    this.mesh.quaternion.copy(this.sphere.quat);
    this.mesh.updateMatrixWorld(true);
    return { collider: this.collider, hold: this.hold, cradle: this.cradle, seek: this.seek };
  }

  /**
   * THE SHAPE, as a game object: the live sphere every hand routine reads —
   * the same numbers that drive the conform collider and the hand-stop. Feed it
   * to anything that needs to know where this ball's edge is this frame.
   */
  shape() {
    const c = this.sphere.pos;
    return { type: 'sphere', center: [c.x, c.y, c.z], radius: this.radius * this.userS,
             scale: this.userS, held: this.hold ? this.hold.slot : null, over: this.overSlot };
  }

  /** Plain-number state for HUDs / probes (GrabbableSphere.snapshot + hold/cradle/seek). */
  snapshot(out = {}) {
    this.sphere.snapshot(out);
    out.held = this.hold ? this.hold.slot : null;
    out.holdType = this.hold ? this.hold.type : null;
    out.cradle = this.cradle; out.seek = this.seek; out.scale = this.userS; out.zone = this.zone;
    return out;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}
