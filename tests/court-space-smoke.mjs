/**
 * court-space-smoke.mjs — sdk/game/court-space.js, headless (node tests/court-space-smoke.mjs). CONTRACTS §3.1, [M1], [M2].
 *   - U within 1e-4 of 1.8652 (one court unit = one tile height = the frustum height at the hand plane)
 *   - for the six reference rectangles (SPEC §2.2) and n in {1,2,3,4,6,9} tiles laid by gallery rule B (fixed169):
 *       courtToStagePx ↔ worldFromStagePx ↔ worldToCourt round-trips within 1e-9 (every seat, 9 sample points each)
 *       stagePxFromWorld ∘ worldFromStagePx = identity within 1e-9
 *       [M2] pr === court.R · th (±1e-9) on BOTH sides of every gutter (horizontal and vertical) and at the gutter mid-point
 *       [M2] the seat's uv camera (makeUvCamera) maps the tile-rect corners to u,v ∈ {0,1} ± 1e-6 through CourtMap.worldToTile
 *       tileWorldRect = the DOM rect on the hand plane, floorY = the SHELF line (y0 + 0.42·h; B1 decision 2), bottomY = the tile bottom
 *   - [2c] court.R is DERIVED from the fixed world radius (0.05 m / U; B1 decision 1), carried by the map as ballR, clamped; the shelf
 *       is the court floor (floorY, predictExit) and travels as map.shelf
 *   - [M1] MIRRORED_INPUT === !DISPLAY_MIRRORED; a point at u = 0.9 of seat k lands in the right 10 % of rect k; a world +x
 *       step from there exits through EDGE.R and neighbourAt returns seat (k+1) mod n (row ring) under MIRRORED_INPUT=false,
 *       and EDGE.L under the mirrored flag
 *   - unmirrorHands is an involution (C2 seam)
 */
import * as THREE from 'three';
import { CourtMap, buildSeatMap, EDGE, SEAT_NONE, UNIT_M, DEFAULT_BALL_RADIUS_M, SHELF_FRAC } from '../sdk/game/court-map.js';
import { D, FOV, U, DISPLAY_MIRRORED, MIRRORED_INPUT, stagePxFromWorld, worldFromStagePx, courtToStagePx, courtToWorld,
  courtRadiusWorld, worldToCourt, tileWorldRect, unmirrorHands, makeUvCamera } from '../sdk/game/court-space.js';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? ' ' + extra : '')); } };

// gallery rule B — research/ui/scripts/gallery-grid.mjs:30-41 verbatim (T1 ships the same function in twin-ui.js)
function fixed169(n, W, H, gap = 8, tol = 0.10) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    const c = { cols, rows, tw: Math.floor(tw), th: Math.floor(tw * 9 / 16) };
    if (!best || c.tw > best.tw * (1 + tol)) best = c;
    else if (c.tw >= best.tw * (1 - tol) && c.cols > best.cols) best = c;
  }
  const usedW = best.cols * best.tw + gap * (best.cols - 1), usedH = best.rows * best.th + gap * (best.rows - 1);
  return { ...best, padX: Math.floor((W - usedW) / 2), padY: Math.floor((H - usedH) / 2) };
}
const GAP = 8, PAD = 8;
/** DOM rects relative to the stage element, incomplete last row centred (render-budget.html:150-160, layout-spec s2). */
function layout(n, stageW, stageH) {
  const g = fixed169(n, stageW - 2 * PAD, stageH - 2 * PAD, GAP);
  const { cols, rows, tw, th } = g;
  const rects = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const m = (r === rows - 1) ? n - r * cols : cols;
    const rowW = m * tw + (m - 1) * GAP, fullW = cols * tw + (cols - 1) * GAP;
    const left = PAD + g.padX + (fullW - rowW) / 2 + c * (tw + GAP);
    const top = PAD + g.padY + r * (th + GAP);
    rects.push({ left, top, width: tw, height: th });
  }
  return { cols, rows, tw, th, rects };
}
function makeCourt(n, cols, aspect) {
  const roster = Array.from({ length: n }, (_, i) => ({ clientId: 'c-' + i, name: 'P' + i, tracked: true, aspect, handSpan: 0.16 }));
  return new CourtMap(buildSeatMap(roster, { cols, wrap: 'row', kickoff: 0 }));
}
const RECTS = [[994, 678], [918, 540], [792, 382], [472, 382], [1280, 720], [1920, 1080]];   // SPEC §2.2 six reference rectangles
const NS = [1, 2, 3, 4, 6, 9];

console.log('\n[1] constants');
ok(Math.abs(U - 1.8652) < 1e-4, `U = ${U.toFixed(6)} m (2·D·tan(FOV/2), D=${D}, FOV=${FOV})`);
ok(DISPLAY_MIRRORED === true && MIRRORED_INPUT === false && MIRRORED_INPUT === !DISPLAY_MIRRORED, 'D-A: DISPLAY_MIRRORED true, MIRRORED_INPUT = !DISPLAY_MIRRORED = false');

console.log('\n[2] six rectangles × n ∈ {1,2,3,4,6,9}: round trips, gutter radius, uv corners');
{
  let trips = 0, tripsBad = 0, worstTrip = 0, gutters = 0, guttersBad = 0, worstPr = 0, corners = 0, cornersBad = 0, worstUv = 0, pxTrips = 0, pxBad = 0, rectsBad = 0;
  for (const [W, H] of RECTS) for (const n of NS) {
    const L = layout(n, W, H);
    const th = L.th, aspect = L.tw / L.th;
    const court = makeCourt(n, L.cols, aspect);
    const cams = L.rects.map(d => {
      const c = worldFromStagePx(d.left + d.width / 2, d.top + d.height / 2, W, H, th);
      return makeUvCamera(THREE, aspect, { x: c.x, y: c.y, z: 0 });
    });
    for (let k = 0; k < n; k++) {
      const r = court.rectOf(k), d = L.rects[k];
      // court → stage px → world → court (through the seat's uv camera)
      for (const [fu, fv] of [[0.05, 0.05], [0.5, 0.5], [0.95, 0.95], [0.05, 0.95], [0.95, 0.05], [0.25, 0.75], [0.75, 0.25], [0.5, 0.02], [0.02, 0.5]]) {
        const cx = r.x0 + fu * r.w, cy = r.y0 + fv * r.h;
        const s = courtToStagePx(court, cx, cy, L.rects);
        const p = worldFromStagePx(s.px, s.py, W, H, th);
        const b = worldToCourt(court, k, cams[k], p);
        const e = Math.max(Math.abs(b.x - cx), Math.abs(b.y - cy));
        trips++; if (!(e < 1e-9) || s.seat !== k) tripsBad++; worstTrip = Math.max(worstTrip, e);
        const w2 = courtToWorld(court, cx, cy, L.rects, W, H, th);
        if (Math.abs(w2.x - p.x) > 1e-12 || Math.abs(w2.y - p.y) > 1e-12 || w2.z !== -D) tripsBad++;
        const q = stagePxFromWorld(p, W, H, th);
        pxTrips++; if (Math.abs(q.px - s.px) > 1e-9 || Math.abs(q.py - s.py) > 1e-9) pxBad++;
      }
      // uv camera: tile-rect corners → u,v ∈ {0,1}
      for (const [ex, ey, eu, ev] of [[0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 0, 1], [1, 1, 1, 1]]) {
        const p = worldFromStagePx(d.left + ex * d.width, d.top + ey * d.height, W, H, th);
        const uv = court.worldToTile(p, cams[k]);
        const e = Math.max(Math.abs(uv.u - eu), Math.abs(uv.v - ev));
        corners++; if (!(e < 1e-6)) cornersBad++; worstUv = Math.max(worstUv, e);
      }
      // tileWorldRect = the DOM rect on the hand plane; floorY = the SHELF line (y0 + shelf · h), bottomY = the tile bottom
      const wr = tileWorldRect(court, k, L.rects, W, H, th);
      const tl = worldFromStagePx(d.left, d.top, W, H, th), br = worldFromStagePx(d.left + d.width, d.top + d.height, W, H, th);
      const shelfWorld = br.y + court.shelf * (tl.y - br.y);
      if (!wr || Math.abs(wr.x0 - tl.x) > 1e-12 || Math.abs(wr.x1 - br.x) > 1e-12 || Math.abs(wr.y1 - tl.y) > 1e-12 || Math.abs(wr.y0 - br.y) > 1e-12
        || Math.abs(wr.floorY - shelfWorld) > 1e-9 || wr.shelfY !== wr.floorY || Math.abs(wr.bottomY - br.y) > 1e-12 || wr.shelfFrac !== court.shelf) rectsBad++;
      // [M2] every gutter: both sides + the mid-point project the ball to R·th px
      const Rpx = court.R * th, eps = 1e-6;
      const check = (x, y) => { const s = courtToStagePx(court, x, y, L.rects); gutters++; const e = Math.abs(s.pr - Rpx); worstPr = Math.max(worstPr, e); if (!(e < 1e-9)) guttersBad++; };
      const g = court.map.gutter;
      const nbR = court.neighbourAt(k, EDGE.R, r.y0 + 0.5);
      if (nbR.seat >= 0 && nbR.wrapDx === 0) {                     // a real horizontal gutter (not the ring wrap)
        const y = r.y0 + 0.5;
        check(r.x0 + r.w - eps, y); check(r.x0 + r.w + g / 2, y); check(r.x0 + r.w + g + eps, y);
        const mid = courtToStagePx(court, r.x0 + r.w + g / 2, y, L.rects);
        if (mid.seat !== k && mid.seat !== nbR.seat) guttersBad++;
      }
      const nbT = court.neighbourAt(k, EDGE.T, r.x0 + r.w / 2);
      if (nbT.seat >= 0) {                                          // a vertical gutter (rows)
        const x = r.x0 + r.w / 2;
        check(x, r.y0 + r.h - eps); check(x, r.y0 + r.h + g / 2); check(x, r.y0 + r.h + g + eps);
      }
    }
  }
  ok(tripsBad === 0, `court → stage px → world → court round-trips within 1e-9 (${trips} trips, worst ${worstTrip.toExponential(2)})`);
  ok(pxBad === 0, `stagePxFromWorld ∘ worldFromStagePx = identity within 1e-9 (${pxTrips})`);
  ok(cornersBad === 0, `[M2] uv camera maps tile-rect corners to u,v ∈ {0,1} ± 1e-6 (${corners} corners, worst ${worstUv.toExponential(2)})`);
  ok(guttersBad === 0 && gutters > 0, `[M2] pr === court.R · th ± 1e-9 on both sides and mid-point of every gutter (${gutters} samples, worst ${worstPr.toExponential(2)})`);
  ok(rectsBad === 0, `tileWorldRect = DOM rect on the hand plane, floorY = the shelf line y0 + ${SHELF_FRAC}·h (shelfY), bottomY = tile bottom (every seat)`);
}

console.log('\n[2c] derived ball radius (B1 decision 1) and the shelf floor (decision 2)');
{
  const [W, H] = RECTS[0], L = layout(3, W, H), court = makeCourt(3, 3, L.tw / L.th);   // makeCourt advertises handSpan 0.16 — ignored now
  ok(Math.abs(court.R - DEFAULT_BALL_RADIUS_M / U) < 1e-12 && Math.abs(courtRadiusWorld(court) - DEFAULT_BALL_RADIUS_M) < 1e-12, `default court.R = ${DEFAULT_BALL_RADIUS_M} m / U = ${court.R.toFixed(5)} u (hand span no longer read); courtRadiusWorld = ${courtRadiusWorld(court).toFixed(3)} m`);
  ok(Math.abs(UNIT_M - U) < 1e-15, 'court-space U === court-map UNIT_M (one definition)');
  ok(court.setBallRadiusM(0.06) === 0.06 && Math.abs(court.R * U - 0.06) < 1e-12 && Math.abs(court.map.ballR - court.R) < 1e-15, `setBallRadiusM(0.06): R·U = ${(court.R * U).toFixed(4)} m, map.ballR carried`);
  ok(court.setBallRadiusM(0.02) === 0.035 && court.setBallRadiusM(0.5) === 0.07 && court.setBallRadiusM(NaN) === DEFAULT_BALL_RADIUS_M, `clamped to 0.035-0.07 m (NaN → default ${DEFAULT_BALL_RADIUS_M})`);
  court.setBallRadiusM(0.06);
  const before = court.R;
  court.set(buildSeatMap([{ clientId: 'a', name: 'A', tracked: true }, { clientId: 'b', name: 'B', tracked: true }], { cols: 2 }));   // a roster republish without ballR
  ok(court.R === before && court.rects.length === 2, 'set(map without ballR) keeps the session radius');
  court.set(buildSeatMap([{ clientId: 'a', name: 'A', tracked: true }], { cols: 1, ballR: 0.04 / U }));
  ok(Math.abs(court.R * U - 0.04) < 1e-12, 'set(map with ballR) reads it (host-authored size)');
  const fresh = new CourtMap(buildSeatMap([{ clientId: 'a', name: 'A', tracked: true, handSpan: 0.3 }], { cols: 1 }));
  ok(Math.abs(fresh.R * U - DEFAULT_BALL_RADIUS_M) < 1e-12 && fresh.shelf === SHELF_FRAC, `a fresh court with handSpan 0.3: R·U = ${(fresh.R * U).toFixed(3)} m (default), shelf ${fresh.shelf}`);
  // the shelf is the floor: floorY = y0 + shelf·h; bottomY = y0; exitEdge never exits through the bottom
  for (const r of fresh.rects) {
    ok(Math.abs(fresh.floorY(r.seat) - (r.y0 + SHELF_FRAC * r.h)) < 1e-12 && fresh.bottomY(r.seat) === r.y0, `seat ${r.seat}: floorY = y0 + 0.42·h = ${fresh.floorY(r.seat).toFixed(3)}, bottomY = ${fresh.bottomY(r.seat)}`);
    ok(fresh.exitEdge(r.seat, r.x0 + 0.5, r.y0 - 1) === EDGE.NONE, 'the bottom is never an exit');
  }
  ok(fresh.setShelf(0.5) === 0.5 && Math.abs(fresh.floorY(0) - 0.5) < 1e-12 && fresh.map.shelf === 0.5, 'setShelf(0.5): floorY follows, map.shelf carried');
  ok(fresh.setShelf(0.05) === 0.2 && fresh.setShelf(0.95) === 0.7, 'shelf clamped to 0.2-0.7');
  fresh.set(buildSeatMap([{ clientId: 'a', name: 'A', tracked: true }], { cols: 1, shelf: 0.45 }));
  ok(fresh.shelf === 0.45 && Math.abs(fresh.floorY(0) - 0.45) < 1e-12, 'set(map with shelf) reads it');
  // predictExit integrates against the shelf: a ball dropped from the tile centre comes to rest at floorY + R (null = no exit)
  const p = fresh.predictExit(0, 0.5, 0.9, 0, 0);
  ok(p === null, 'predictExit: a dropped ball rests on the shelf (no exit)');
  // tileWorldRect maps the shelf through the DOM rect: world floorY = 45 % up the tile
  const wr = tileWorldRect(fresh, 0, [{ left: 0, top: 0, width: 320, height: 180 }], 320, 180, 180);
  ok(Math.abs(wr.floorY - (wr.y0 + 0.45 * (wr.y1 - wr.y0))) < 1e-9, `tileWorldRect.floorY = y0 + 0.45·h in world metres (${wr.floorY.toFixed(4)})`);
}

console.log('\n[2b] gutter position: continuous across the DOM gap (court gutter squeezed to the gap, position only)');
{
  let bad = 0, checks = 0, worstJump = 0;
  for (const [W, H] of RECTS) for (const n of NS) {
    const L = layout(n, W, H), th = L.th, court = makeCourt(n, L.cols, L.tw / L.th), g = court.map.gutter;
    for (const r of court.rects) {
      const nbR = court.neighbourAt(r.seat, EDGE.R, r.y0 + 0.5);
      if (nbR.seat >= 0 && nbR.wrapDx === 0) {
        const dA = L.rects[r.seat], dB = L.rects[nbR.seat], y = r.y0 + 0.5;
        let prev = null;
        for (let k = 0; k <= 20; k++) {                                  // walk the gutter, 1/20 of a gutter per step
          const x = r.x0 + r.w - 1e-9 + (g + 2e-9) * (k / 20);
          const s = courtToStagePx(court, x, y, L.rects);
          checks++;
          if (k === 0 && Math.abs(s.px - (dA.left + dA.width)) > 1e-6) bad++;         // leaves at A's right edge
          if (k === 20 && Math.abs(s.px - dB.left) > 1e-6) bad++;                       // arrives at B's left edge
          if (k === 10 && Math.abs(s.px - (dA.left + dA.width + dB.left) / 2) > 1e-6) bad++;   // mid-gutter = mid-gap
          if (Math.abs(s.pr - court.R * th) > 1e-9) bad++;                              // radius never squeezed
          if (prev !== null) { const j = s.px - prev; worstJump = Math.max(worstJump, Math.abs(j - GAP / 20)); if (j < 0) bad++; }
          prev = s.px;
        }
      }
      const nbT = court.neighbourAt(r.seat, EDGE.T, r.x0 + r.w / 2);
      if (nbT.seat >= 0) {
        const dA = L.rects[r.seat], dB = L.rects[nbT.seat], x = r.x0 + r.w / 2;
        const a = courtToStagePx(court, x, r.y0 + r.h + 1e-9, L.rects), m = courtToStagePx(court, x, r.y0 + r.h + g / 2, L.rects), b = courtToStagePx(court, x, r.y0 + r.h + g - 1e-9, L.rects);
        checks += 3;
        if (Math.abs(a.py - dA.top) > 1e-6 || Math.abs(b.py - (dB.top + dB.height)) > 1e-6 || Math.abs(m.py - (dA.top + dB.top + dB.height) / 2) > 1e-6) bad++;
        // and the same gutter walked from the tile ABOVE, downwards
        const rb = court.rectOf(nbT.seat);
        const a2 = courtToStagePx(court, x, rb.y0 - 1e-9, L.rects), b2 = courtToStagePx(court, x, rb.y0 - g + 1e-9, L.rects);
        checks += 2;
        if (Math.abs(a2.py - (dB.top + dB.height)) > 1e-6 || Math.abs(b2.py - dA.top) > 1e-6) bad++;
      }
    }
  }
  ok(bad === 0 && checks > 0, `gutter walk: monotone, A right edge → gap middle → B left edge, pr = R·th throughout (${checks} checks, worst step error ${worstJump.toExponential(1)} px)`);
  // outside any DOM-adjacent gutter (the ring wrap beyond the last tile) the nearest-tile rule still applies
  const [W, H] = RECTS[0], L = layout(3, W, H), court = makeCourt(3, 3, L.tw / L.th), r2 = court.rectOf(2);
  const s = courtToStagePx(court, r2.x0 + r2.w + 0.04, r2.y0 + 0.5, L.rects);
  ok(s.seat === 2 && Math.abs(s.px - (L.rects[2].left + L.rects[2].width + 0.04 * L.th)) < 1e-9, 'beyond the last tile of a row (ring wrap): nearest-tile scale, unchanged');
}

console.log('\n[3] courtRadiusWorld and the same px-per-metre everywhere');
{
  const [W, H] = RECTS[0], n = 4, L = layout(n, W, H), th = L.th, court = makeCourt(n, L.cols, L.tw / L.th);
  ok(Math.abs(courtRadiusWorld(court) - court.R * U) < 1e-12, `courtRadiusWorld = R·U = ${courtRadiusWorld(court).toFixed(4)} m`);
  // a world radius R·U spans R·th px on the stage for every tile (the frustum rule)
  const r0 = court.rectOf(0), r3 = court.rectOf(3);
  const a = courtToStagePx(court, r0.x0 + 0.5, r0.y0 + 0.5, L.rects), b = courtToStagePx(court, r3.x0 + 0.5, r3.y0 + 0.5, L.rects);
  const pa = worldFromStagePx(a.px, a.py, W, H, th), pb = worldFromStagePx(b.px, b.py, W, H, th);
  const qa = stagePxFromWorld({ x: pa.x + courtRadiusWorld(court), y: pa.y }, W, H, th), qb = stagePxFromWorld({ x: pb.x + courtRadiusWorld(court), y: pb.y }, W, H, th);
  ok(Math.abs((qa.px - a.px) - court.R * th) < 1e-9 && Math.abs((qb.px - b.px) - court.R * th) < 1e-9, `R·U metres → R·th = ${(court.R * th).toFixed(3)} px in seat 0 and seat 3`);
}

console.log('\n[M1] display-space court: +x exits right, ring neighbour, and the mirrored alternative');
{
  let bad = 0, checks = 0;
  for (const n of NS) {
    const [W, H] = RECTS[0], L = layout(n, W, H), th = L.th, aspect = L.tw / L.th;
    const ring = makeCourt(n, n, aspect);                           // one row: neighbour = (k+1) mod n literally
    const grid = makeCourt(n, L.cols, aspect);                      // the gallery layout: neighbour = the row ring successor
    for (let k = 0; k < n; k++) {
      const d = L.rects[k];
      const c = worldFromStagePx(d.left + d.width / 2, d.top + d.height / 2, W, H, th);
      const cam = makeUvCamera(THREE, aspect, { x: c.x, y: c.y, z: 0 });
      for (const [court, expected] of [[ring, (k + 1) % n], [grid, null]]) {
        const r = court.rectOf(k);
        const p = court.tileToWorld(0.9, 0.5, D, cam);                                  // u = 0.9 of seat k, hand plane
        const q = worldToCourt(court, k, cam, p);
        checks++; if (!(q.x > r.x0 + 0.9 * r.w - 1e-9 && q.x <= r.x0 + r.w + 1e-9)) bad++;   // right 10 % of rect k
        const stepU = (0.1 * r.w + court.R + 0.02) * U;                                // enough to leave fully (x > x0 + w + R)
        const p2 = { x: p.x + stepU, y: p.y, z: p.z };
        const q2 = worldToCourt(court, k, cam, p2);
        checks++; if (court.exitEdge(k, q2.x, q2.y) !== EDGE.R) bad++;
        const nb = court.neighbourAt(k, EDGE.R, q2.y);
        const want = expected !== null ? expected : (() => { const row = court.rects.filter(o => o.row === r.row); const i = row.findIndex(o => o.seat === k); return row[(i + 1) % row.length].seat; })();
        checks++; if (nb.seat !== want) { bad++; console.error(`    n=${n} k=${k} cols=${court.map.cols}: neighbour ${nb.seat} != ${want}`); }
        // the mirrored alternative: the same world step reads as a LEFT exit
        const uv = court.worldToTile(p2, cam);
        const qm = court.tileToCourt(k, uv.u, uv.v, true);
        checks++; if (court.exitEdge(k, qm.x, qm.y) !== EDGE.L) bad++;
        // and the un-stepped point sits in the LEFT 10 % under the flag
        const uv0 = court.worldToTile(p, cam), qm0 = court.tileToCourt(k, uv0.u, uv0.v, true);
        checks++; if (!(qm0.x < r.x0 + 0.1 * r.w + 1e-9)) bad++;
      }
    }
  }
  ok(bad === 0, `[M1] u = 0.9 → right 10 %; world +x → EDGE.R and neighbour (k+1) mod n (one row) / row-ring successor (grid); EDGE.L under mirrored=true (${checks} checks)`);
  // n = 1 practice court: a +x exit has no neighbour unless the row wraps onto itself
  const solo = makeCourt(1, 1, 16 / 9);
  const nb = solo.neighbourAt(0, EDGE.R, 0.5);
  ok(nb.seat === 0 && nb.wrapDx < 0, 'n = 1 with wrap:row: the ring closes on itself (seat 0, wrapDx < 0)');
  const noWrap = new CourtMap(buildSeatMap([{ clientId: 'a', name: 'A', tracked: true }], { cols: 1, wrap: 'none' }));
  ok(noWrap.neighbourAt(0, EDGE.R, 0.5).seat === -1, 'n = 1 with wrap:none: no neighbour (practice bounce)');
  ok(solo.seatAt(solo.rectOf(0).x0 + solo.rectOf(0).w + 0.04, 0.5) === SEAT_NONE, 'a gutter point reports SEAT_NONE');
}

console.log('\n[4] unmirrorHands (C2 seam) is an involution');
{
  const mk = (s) => Array.from({ length: 21 }, (_, i) => ({ x: 0.1 + i * 0.01 * s, y: 0.4 - i * 0.005, z: -0.02 * i }));
  const hands = { left: { img: mk(1), world: mk(3) }, right: { img: mk(2), world: null } };
  const once = unmirrorHands(hands), twice = unmirrorHands(once);
  let worst = 0;
  for (const slot of ['left', 'right']) for (const part of ['img', 'world']) {
    const a = hands[slot][part], b = twice[slot][part];
    if (!a) { if (b !== null) worst = Infinity; continue; }
    for (let i = 0; i < 21; i++) worst = Math.max(worst, Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y), Math.abs(a[i].z - b[i].z));
  }
  ok(worst < 1e-12, `unmirrorHands ∘ unmirrorHands = identity (img u → 1-u, world x → -x; worst ${worst.toExponential(1)}, fp rounding of 1-(1-u))`);
  ok(once.left.img[5].x === 1 - hands.left.img[5].x && once.left.world[5].x === -hands.left.world[5].x && once.left.img[5].z === hands.left.img[5].z, 'one application flips u and world x only; z untouched');
  ok(once.right.world === null && unmirrorHands({ left: null, right: null }).left === null, 'null slots / null world pass through');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
