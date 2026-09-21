/**
 * court-map.mjs — the shared 2D court for the cross-tile ball game ("Teams football").
 * ─────────────────────────────────────────────────────────────────────────────
 * Every tile's camera space maps into ONE court plane. 1 court unit = tile
 * height. Tiles are laid edge to edge (row-major) with a gutter between them
 * (the transit lane). Adjacency is computed from the rects, never read from
 * Teams' gallery: Teams orders tiles per viewer and lets nobody reorder them
 * (https://learn.microsoft.com/en-us/answers/questions/2123027/how-does-teams-prioritize-and-display-video-feeds,
 *  https://learn.microsoft.com/en-us/answers/questions/4438023/rearrange-order-of-participants-in-teams-when-will).
 *
 * Precedents: Racer — "The height is found by finding the height of the
 * smallest screen, and the width is the total width of all screens", "Each
 * device finds its x offset based on it's position in the device line-up
 * order" (https://web.dev/racer); bgstaal/multipleWindow3dScene — the window
 * list in localStorage IS the world (https://github.com/bgstaal/multipleWindow3dScene).
 *
 * No runtime dependency: the two camera helpers take a three.js 0.160
 * PerspectiveCamera duck-typed (matrixWorld, matrixWorldInverse,
 * projectionMatrix, projectionMatrixInverse, position, fov) and do the
 * Vector3.project / unproject math inline, so this file also runs in Node
 * (see smoke-test.mjs).
 */

export const EDGE = Object.freeze({ L: 0, R: 1, T: 2, B: 3, NONE: 255 });
export const SEAT_NONE = 0xff;            // "in the gutter" on the wire
export const DEFAULT_GUTTER = 0.08;       // court units (= 8 % of a tile height)

// ── the hand plane (court-space.js re-exports these as D / FOV / U; defined here so this module can derive R without a
//    circular import): every tile camera has FOV 50 (vertical) and the hand plane at D = 2.0 m, so ONE court unit = ONE tile
//    height = the frustum height at the hand plane = 2·D·tan(FOV/2) = 1.8652 m.
export const HAND_PLANE_D = 2.0;
export const HAND_PLANE_FOV = 50;
export const UNIT_M = 2 * HAND_PLANE_D * Math.tan(HAND_PLANE_FOV / 2 * Math.PI / 180);   // metres per court unit

// ── the GAME BALL is a fixed WORLD size (B1 decision 1): 0.05 m radius = 10 cm across, wrap-graspable by a real hand
//    (span ~0.19 m). court.R is DERIVED = radiusM / UNIT_M so every court computation (R·th projection, exitEdge, the
//    predictors, the ghost) stays consistent. The old rule (0.45 × the median hand span, else 0.07 u = 13 cm radius) made a
//    26-34 cm ball nobody could wrap — removed.
export const DEFAULT_BALL_RADIUS_M = 0.06;   // 0.06 (was 0.05): a 5 cm ball is a 7-12 px dot in a gallery tile (reviewer (d)); the slider still spans 0.035-0.07
export const BALL_RADIUS_M_MIN = 0.035, BALL_RADIUS_M_MAX = 0.07;
export const clampBallRadiusM = (m) => Math.min(BALL_RADIUS_M_MAX, Math.max(BALL_RADIUS_M_MIN, Number.isFinite(m) ? m : DEFAULT_BALL_RADIUS_M));
export const courtRadiusFromM = (m) => clampBallRadiusM(m) / UNIT_M;

// ── the SHELF (B1 decision 2): the game ball's floor is a per-tile plane at 42 % of the tile height (chest height, where
//    hands are tracked), not the tile's bottom edge (where hands leave the frame). CourtMap.floorY(seat) IS the shelf line;
//    rectOf(seat).y0 stays the bottom edge (bottomY). Tunable per session through the seat map (`shelf`).
export const SHELF_FRAC = 0.42;
export const SHELF_FRAC_MIN = 0.2, SHELF_FRAC_MAX = 0.7;
export const clampShelfFrac = (f) => Math.min(SHELF_FRAC_MAX, Math.max(SHELF_FRAC_MIN, Number.isFinite(f) ? f : SHELF_FRAC));

// The stack's GrabbableSphere defaults (sdk/core/game-physics.js:232-234, 329-335),
// reinterpreted in court units so every client integrates identically.
export const COURT_GRAVITY = 5.2;         // units/s²
export const COURT_DRAG = 0.996;          // per 60 Hz frame
export const FLOOR_RESTITUTION = 0.58;
export const FLOOR_BOUNCE_MIN_VY = 0.35;  // below this |vy| the ball stops instead of bouncing
export const FLOOR_FRICTION = 0.92;

/**
 * One integrator for owner, ghost, predictor and test: gravity, per-frame drag,
 * optional floor bounce. Mutates and returns `b` ({x,y,vx,vy}).
 */
export function integrateCourt(b, dt, floorY, R = 0) {
  b.vy -= COURT_GRAVITY * dt;
  const k = Math.pow(COURT_DRAG, dt * 60);
  b.vx *= k; b.vy *= k;
  b.x += b.vx * dt; b.y += b.vy * dt;
  if (floorY !== undefined && b.y < floorY + R) {
    b.y = floorY + R;
    if (b.vy < 0) {
      b.vy = Math.abs(b.vy) > FLOOR_BOUNCE_MIN_VY ? -b.vy * FLOOR_RESTITUTION : 0;
      b.vx *= FLOOR_FRICTION;
    }
  }
  return b;
}

/**
 * Build a seat map from a roster. Host-authored; broadcast as SEAT_MAP (0x20).
 * @param {Array<{clientId:string,name:string,tracked:boolean,role?:string,aspect?:number,handSpan?:number}>} roster
 */
export function buildSeatMap(roster, { cols = 3, gutter = DEFAULT_GUTTER, wrap = 'row', outer = 'wall', goal = -1, kickoff = 0, v = 1, ballR, shelf } = {}) {
  const seats = roster.map((p, i) => ({
    seat: i,
    clientId: p.clientId,
    name: p.name,
    tracked: !!p.tracked,
    role: p.role || (p.tracked ? 'player' : 'spectator'),   // player | goal | wall | portal | spectator
    aspect: p.aspect || 16 / 9,
    handSpan: p.handSpan ?? null,        // projected wrist→middle-MCP span in court units (advertised; informational — R no longer reads it)
  }));
  const rows = Math.max(1, Math.ceil(seats.length / cols));
  const map = { v, unit: 'tileHeight', gutter, cols, rows, wrap, outer, goal, kickoff, seats };
  if (ballR > 0) map.ballR = ballR;      // session ball radius in court units (= radiusM / UNIT_M); absent → each client keeps its own
  if (shelf > 0) map.shelf = shelf;      // shelf line as a fraction of the tile height; absent → each client keeps its own (SHELF_FRAC)
  return map;
}

// three.js Vector3.applyMatrix4 on a column-major 16-element array (with perspective divide)
function applyMat4(v, e) {
  const x = v.x, y = v.y, z = v.z;
  const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
  return {
    x: (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
    y: (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
    z: (e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
  };
}

export class CourtMap {
  constructor(seatMap) { this.set(seatMap); }

  /** Replace the map (SEAT_MAP packet). Rects are recomputed row-major. */
  set(seatMap) {
    this.map = seatMap;
    this.rects = [];
    const { cols, rows, gutter, seats } = seatMap;
    for (let i = 0; i < seats.length; i++) {
      const row = Math.floor(i / cols), col = i % cols;
      let x0 = 0;
      for (let j = row * cols; j < i; j++) x0 += seats[j].aspect + gutter;
      const y0 = (rows - 1 - row) * (1 + gutter);
      this.rects.push({ seat: i, x0, y0, w: seats[i].aspect, h: 1, row, col });
    }
    // ball radius in court units is DERIVED from the fixed world radius (decision 1): the map may carry the session's `ballR`
    // (host-authored); a map without it keeps whatever this court already has (a roster republish never resets the size)
    this.R = (seatMap.ballR > 0) ? seatMap.ballR : ((this.R > 0) ? this.R : DEFAULT_BALL_RADIUS_M / UNIT_M);
    // the shelf line (decision 2): same rule — carried by the map when set, otherwise kept, default SHELF_FRAC
    this.shelf = (seatMap.shelf > 0) ? clampShelfFrac(seatMap.shelf) : ((this.shelf > 0) ? this.shelf : SHELF_FRAC);
  }

  /** The game ball's radius in metres (= R · UNIT_M). */
  get radiusM() { return this.R * UNIT_M; }
  /** Set the session ball radius from a WORLD size (clamped to 0.035-0.07 m): R = m / UNIT_M; the map carries it as `ballR`. */
  setBallRadiusM(m) {
    const r = clampBallRadiusM(m);
    this.R = r / UNIT_M;
    if (this.map) this.map.ballR = this.R;
    return r;
  }
  /** Set the shelf line (fraction of the tile height, clamped 0.2-0.7); floorY(seat) follows; the map carries it as `shelf`. */
  setShelf(frac) {
    this.shelf = clampShelfFrac(frac);
    if (this.map) this.map.shelf = this.shelf;
    return this.shelf;
  }

  rectOf(seat) { return this.rects[seat] || null; }
  seatOfClient(clientId) { const s = this.map.seats.find(s => s.clientId === clientId); return s ? s.seat : -1; }
  role(seat) { return this.map.seats[seat]?.role || 'spectator'; }
  isTracked(seat) { return !!this.map.seats[seat]?.tracked; }

  // ── image ↔ court ─────────────────────────────────────────────────────────
  /**
   * Canonical (un-mirrored) normalized image coords (u right, v down) → court.
   * `mirrored=true` accepts the stack's mirrored display-space landmarks
   * (PlayerFrame.hands[].img, sdk/core/multiplayer.js:13-14) and un-mirrors
   * them here — the ONE place the flip happens.
   */
  tileToCourt(seat, u, v, mirrored = false, out = {}) {
    const r = this.rects[seat];
    if (mirrored) u = 1 - u;
    out.x = r.x0 + u * r.w;
    out.y = r.y0 + (1 - v);
    return out;
  }
  courtToTile(seat, x, y, mirrored = false, out = {}) {
    const r = this.rects[seat];
    let u = (x - r.x0) / r.w;
    if (mirrored) u = 1 - u;
    out.u = u; out.v = 1 - (y - r.y0);
    return out;
  }

  // ── tile world ↔ image (through that tile's three.js camera) ──────────────
  /** World point in a tile scene → canonical normalized image coords (= THREE.Vector3.project, then NDC → uv). */
  worldToTile(worldPos, camera, out = {}) {
    const ndc = applyMat4(applyMat4(worldPos, camera.matrixWorldInverse.elements), camera.projectionMatrix.elements);
    out.u = (ndc.x + 1) / 2;
    out.v = (1 - ndc.y) / 2;
    return out;
  }
  /** Normalized image coords at a camera-space depth (metres in front of the camera) → tile world (= unproject a ray point, walk `depth`). */
  tileToWorld(u, v, depth, camera, out = {}) {
    const p = applyMat4(applyMat4({ x: u * 2 - 1, y: 1 - v * 2, z: 0.5 }, camera.projectionMatrixInverse.elements), camera.matrixWorld.elements);
    const c = camera.position;
    let dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    out.x = c.x + dx * depth; out.y = c.y + dy * depth; out.z = c.z + dz * depth;
    return out;
  }
  /**
   * Tile-world ball radius that projects to R court units at the hand plane:
   * R_i = R_court × (world height of the tile at that depth). PerspectiveCamera.fov is vertical, degrees.
   */
  worldRadiusFor(camera, depth) {
    const worldH = 2 * depth * Math.tan((camera.fov * Math.PI / 180) / 2);
    return this.R * worldH;
  }

  // ── edges & adjacency ─────────────────────────────────────────────────────
  /** Edge the ball (centre x,y, radius R) has FULLY left through, or EDGE.NONE. The shelf is the floor; the bottom is never an exit. */
  exitEdge(seat, x, y, R = this.R) {
    const r = this.rects[seat];
    if (x < r.x0 - R) return EDGE.L;
    if (x > r.x0 + r.w + R) return EDGE.R;
    if (y > r.y0 + r.h + R) return EDGE.T;
    return EDGE.NONE;
  }
  /** Floor plane (court y) for a seat = the SHELF line (y0 + shelf · h): the ball rests at y = floorY + R. */
  floorY(seat) { const r = this.rects[seat]; return r.y0 + this.shelf * r.h; }
  /** The tile's bottom edge (court y) — not the game ball's floor any more (hands leave the frame there). */
  bottomY(seat) { return this.rects[seat].y0; }

  /**
   * Neighbour across `edge` at coordinate `c` (y for L/R, x for T).
   * Returns { seat, wrapDx } — wrapDx is the x shift that keeps the court
   * continuous across a row wrap (the ring); seat = -1 when there is none.
   */
  neighbourAt(seat, edge, c) {
    const r = this.rects[seat], g = this.map.gutter, eps = 1e-6;
    for (const o of this.rects) {
      if (o.seat === seat) continue;
      if (edge === EDGE.R && Math.abs(o.x0 - (r.x0 + r.w + g)) < eps && c >= o.y0 - eps && c <= o.y0 + o.h + eps) return { seat: o.seat, wrapDx: 0 };
      if (edge === EDGE.L && Math.abs((o.x0 + o.w + g) - r.x0) < eps && c >= o.y0 - eps && c <= o.y0 + o.h + eps) return { seat: o.seat, wrapDx: 0 };
      if (edge === EDGE.T && Math.abs(o.y0 - (r.y0 + r.h + g)) < eps && c >= o.x0 - eps && c <= o.x0 + o.w + eps) return { seat: o.seat, wrapDx: 0 };
    }
    if (this.map.wrap === 'row' && (edge === EDGE.L || edge === EDGE.R)) {
      const rowRects = this.rects.filter(o => o.row === r.row);
      const first = rowRects[0], last = rowRects[rowRects.length - 1];
      const span = last.x0 + last.w + g - first.x0;          // one full ring circumference
      if (edge === EDGE.R && r.seat === last.seat) return { seat: first.seat, wrapDx: -span };
      if (edge === EDGE.L && r.seat === first.seat) return { seat: last.seat, wrapDx: +span };
    }
    return { seat: -1, wrapDx: 0 };
  }

  /** Seat whose rect contains a court point (with margin), or SEAT_NONE when in a gutter. */
  seatAt(x, y, margin = 0) {
    for (const r of this.rects) {
      if (x >= r.x0 - margin && x <= r.x0 + r.w + margin && y >= r.y0 - margin && y <= r.y0 + r.h + margin) return r.seat;
    }
    return SEAT_NONE;
  }

  /**
   * Integrate a launch until it exits a tile edge, with the shared integrator,
   * so the LAUNCH packet's tEdge/cEdge are reproducible on every client.
   * @returns {{edge:number,cEdge:number,tEdge:number,to:number,wrapDx:number}|null}  null = came to rest inside the tile
   */
  predictExit(seat, x, y, vx, vy, t0ms, R = this.R, maxMs = 4000) {
    const dt = 1 / 60, b = { x, y, vx, vy }, fy = this.floorY(seat);
    for (let t = 0; t * 1000 < maxMs; t += dt) {
      integrateCourt(b, dt, fy, R);
      const e = this.exitEdge(seat, b.x, b.y, R);
      if (e !== EDGE.NONE) {
        const c = (e === EDGE.T) ? b.x : b.y;
        const nb = this.neighbourAt(seat, e, c);
        return { edge: e, cEdge: c, tEdge: t0ms + Math.round((t + dt) * 1000), to: nb.seat < 0 ? SEAT_NONE : nb.seat, wrapDx: nb.wrapDx };
      }
      if (Math.abs(b.vx) < 1e-3 && Math.abs(b.vy) < 1e-3 && b.y <= fy + R + 1e-3) return null;
    }
    return null;
  }

  // ── viewer pixels (per viewer, per DOM layout) ────────────────────────────
  /**
   * Court → this viewer's gallery pixels. `domRects[seat]` = that tile's
   * getBoundingClientRect(). Gutter points use the nearest tile's scale so the
   * overlay ball slides across visibly; 1 unit = that tile's pixel height.
   */
  courtToViewerPx(x, y, domRects, out = {}) {
    let seat = this.seatAt(x, y);
    if (seat === SEAT_NONE) {
      let best = null, bd = Infinity;
      for (const r of this.rects) {
        const dx = x < r.x0 ? r.x0 - x : x > r.x0 + r.w ? x - (r.x0 + r.w) : 0;
        const dy = y < r.y0 ? r.y0 - y : y > r.y0 + r.h ? y - (r.y0 + r.h) : 0;
        const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = r; }
      }
      seat = best.seat;
    }
    const r = this.rects[seat], d = domRects[seat];
    const pxPerUnit = d.height / r.h;
    out.px = d.left + (x - r.x0) * pxPerUnit;
    out.py = d.top + (r.y0 + r.h - y) * pxPerUnit;
    out.pr = this.R * pxPerUnit;               // ball radius in px — equals the 3D projection at the edge by construction
    out.seat = seat;
    return out;
  }
}
