/**
 * pack-gen-smoke.mjs — sdk/game/pack-gen.js + court-space.js seams, headless (node tests/pack-gen-smoke.mjs).
 *   - every generator returns 21 points; closure(open) < 0.1, closure(cup) > 0.3; flat's palm normal points up (n.y > 0.4)
 *   - packToHands is the inverse of HandViews.mirrorPoint: world pack → {img, world} → HandViews.mirrorPoint → same pack (≤ 1 mm)
 *     for a camera OFF the origin (a seat's uv camera), for on-plane AND off-plane (cup) points
 *   - the wire chain [W]: encodeHandStream(packToHands) is 264 B and decodes to the same world pack within the 0.5 mm i16 step
 *   - throwSeq: cup frames moving at the requested speed, last frame open (release)
 *   - fixtures file written by tests/_gen-packs.mjs with the CONTRACTS §9 shape
 *   - court-space: U, stage px ↔ world round trip, courtToWorld radius rule (R·th px), worldToCourt through makeUvCamera
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { PackGen, packToHands, makeFixtures } from '../sdk/game/pack-gen.js';
import { closure, palmPose } from '../sdk/game/prop-ball.js';
import { encodeHandStream, decodeHandStream } from '../sdk/net/hand-stream.js';
import { CourtMap, buildSeatMap } from '../sdk/game/court-map.js';
import { D, FOV, U, MIRRORED_INPUT, DISPLAY_MIRRORED, stagePxFromWorld, worldFromStagePx, courtToStagePx, courtToWorld, courtRadiusWorld, worldToCourt, tileWorldRect, unmirrorHands, makeUvCamera } from '../sdk/game/court-space.js';
// sdk/interaction/colliders.js warns (async) that its https: BVH import cannot load in Node — expected, harmless
const warn = console.warn; console.warn = (...a) => { if (!String(a[0]).includes('BVH not available')) warn(...a); };
const { HandViews } = await import('../sdk/core/hand-views.js');

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + (extra ? ' ' + extra : '')); } else { fail++; console.error('  FAIL ' + name + (extra ? ' ' + extra : '')); } };
const maxDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y, p.z - b[i].z)));
const is21 = p => Array.isArray(p) && p.length === 21 && p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z));

console.log('\n[1] generators');
{
  const open = PackGen.open(0.1, -0.05, -D), cup = PackGen.cup(0.1, -0.05, -D), flat = PackGen.flat(0, -0.2, -D);
  ok(is21(open) && is21(cup) && is21(flat), 'open / cup / flat return 21 finite points');
  ok(is21(PackGen.shift(open, 0.1, 0.2, 0.3)) && PackGen.shift(open, 0.1, 0.2, 0.3)[0].x - open[0].x === 0.1, 'shift translates every point');
  const mid = PackGen.lerp(open, cup, 0.5);
  ok(is21(mid) && Math.abs(mid[8].z - (open[8].z + cup[8].z) / 2) < 1e-12, 'lerp blends per point');
  const cO = closure(open), cC = closure(cup);
  ok(cO < 0.1, `closure(open) = ${cO.toFixed(3)} < 0.1`);
  ok(cC > 0.3, `closure(cup) = ${cC.toFixed(3)} > 0.3`);
  const P = new THREE.Vector3(), Q = new THREE.Quaternion();
  ok(palmPose(flat, P, Q), 'palmPose(flat) resolves a frame');
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(Q);
  ok(n.y > 0.4, `flat palm normal n.y = ${n.y.toFixed(3)} > 0.4 (palm-up shelf)`);
  ok(palmPose(open, P, Q) && Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(Q).z) > 0.9, 'open palm normal faces the camera axis (|n.z| > 0.9)');
}

console.log('\n[2] packToHands ⟲ HandViews.mirrorPoint (the bot encoder inverse)');
{
  const cam = makeUvCamera(THREE, 16 / 9, { x: 0.9, y: -0.3, z: 0 });      // a seat camera off the stage centre
  const views = new HandViews({ mode: 'mirror' });
  const tmp = new THREE.Vector3();
  const back = img => img.map(p => views.mirrorPoint(p, cam, tmp).clone());
  for (const [name, pack] of [['open', PackGen.open(1.1, -0.2, -D)], ['cup', PackGen.cup(0.7, 0.1, -D)], ['flat', PackGen.flat(0.9, -0.5, -D)]]) {
    const h = packToHands(pack, cam, { slot: 'right' });
    ok(h.left === null && h.right && is21(h.right.img) && is21(h.right.world), `${name}: packToHands → {left:null, right:{img,world}}`);
    const err = maxDist(back(h.right.img), pack);
    ok(err < 1e-3, `${name}: img → mirrorPoint → world within 1 mm (max ${(err * 1e3).toFixed(4)} mm)`);
    ok(maxDist(h.right.world, pack) === 0, `${name}: world = pack`);
    const inFrame = h.right.img.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
    ok(inFrame, `${name}: img u,v inside [0,1] for a hand inside the tile`);
  }
  const cupZ = packToHands(PackGen.cup(0, 0, -D), cam).right.img;
  ok(Math.abs(cupZ[0].z) < 1e-9 && cupZ[8].z < -0.01, `off-plane fingers carry img z (wrist ${cupZ[0].z.toFixed(4)}, index tip ${cupZ[8].z.toFixed(4)})`);
  const hl = packToHands(PackGen.open(0, 0, -D), cam, { slot: 'left' });
  ok(hl.right === null && !!hl.left, 'slot:left fills the left slot only');
  // [W] the wire: one hand + world = 264 B, world survives the i16 mm quantisation
  const pack = PackGen.cup(0.4, -0.1, -D);
  const buf = encodeHandStream(2, packToHands(pack, cam), 7, 1234);
  ok(buf.byteLength === 264, `encodeHandStream(packToHands) = ${buf.byteLength} B (one hand + world)`);
  const dec = decodeHandStream(buf);
  ok(dec.seat === 2 && dec.hands.right && !dec.hands.left, 'decodes seat + right slot only');
  const wErr = maxDist(dec.hands.right.world, pack), iErr = maxDist(back(dec.hands.right.img), pack);
  ok(wErr <= 5.1e-4, `decoded world within the 0.5 mm step (max ${(wErr * 1e3).toFixed(3)} mm)`);
  ok(iErr < 1e-3, `decoded img → mirrorPoint within 1 mm (max ${(iErr * 1e3).toFixed(4)} mm)`);
}

console.log('\n[3] throwSeq');
{
  const seq = PackGen.throwSeq({ x: -0.3, y: 0, z: -D }, { x: 1, y: 0, z: 0 }, 2.0, 20, 1 / 60);
  ok(seq.length === 20 && seq.every(is21), '20 frames of 21 points');
  ok(closure(seq[0]) > 0.3 && closure(seq[18]) > 0.3 && closure(seq[19]) < 0.1, 'cup while carrying, open on the last frame (release)');
  const v = (seq[10][0].x - seq[9][0].x) * 60;
  ok(Math.abs(v - 2.0) < 1e-9, `wrist speed ${v.toFixed(3)} m/s = requested 2.0`);
}

console.log('\n[4] fixtures');
{
  const { FIXTURE_PATH } = await import('./_gen-packs.mjs');           // runs the generator
  ok(fs.existsSync(FIXTURE_PATH), 'tests/fixtures/hand-packs.json written');
  const fx = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  ok(is21(fx.open) && is21(fx.cup) && is21(fx.flat), 'open / cup / flat present');
  ok(Array.isArray(fx.wave) && fx.wave.length === 60 && fx.wave.every(is21), 'wave: 60 packs');
  ok(Array.isArray(fx.throwRight) && fx.throwRight.length === 20 && fx.throwRight.every(is21), 'throwRight: 20 packs');
  ok(JSON.stringify(fx) === JSON.stringify(makeFixtures()), 'fixture file == makeFixtures() (deterministic)');
}

console.log('\n[5] court-space');
{
  ok(Math.abs(U - 1.8652) < 5e-4 && D === 2 && FOV === 50, `U = ${U.toFixed(4)} m per court unit`);
  ok(DISPLAY_MIRRORED === true && MIRRORED_INPUT === false, 'D-A: DISPLAY_MIRRORED, MIRRORED_INPUT = false');
  const stageW = 994, stageH = 678, th = 200, tw = th * 16 / 9, gap = 8;
  // three 16:9 tiles in a row, centred on the stage, DOM rects relative to the stage element
  const left0 = (stageW - (3 * tw + 2 * gap)) / 2, top = (stageH - th) / 2;
  const domRects = [0, 1, 2].map(i => ({ left: left0 + i * (tw + gap), top, width: tw, height: th }));
  const p = { x: 0.37, y: -0.21, z: -D };
  const px = stagePxFromWorld(p, stageW, stageH, th), w2 = worldFromStagePx(px.px, px.py, stageW, stageH, th);
  ok(Math.hypot(w2.x - p.x, w2.y - p.y) < 1e-12 && w2.z === -D, 'stage px ↔ world round trip on the hand plane');
  ok(Math.abs(stagePxFromWorld({ x: 0, y: 0 }, stageW, stageH, th).px - stageW / 2) < 1e-12, 'world origin = stage centre');
  const roster = [0, 1, 2].map(i => ({ clientId: 'c-' + i, name: 'P' + i, tracked: true, aspect: 16 / 9, handSpan: 0.16 }));
  const court = new CourtMap(buildSeatMap(roster, { cols: 3, wrap: 'row', kickoff: 1 }));
  const r1 = court.rectOf(1);
  const s = courtToStagePx(court, r1.x0 + r1.w / 2, r1.y0 + 0.5, domRects);
  ok(s.seat === 1 && Math.abs(s.px - (domRects[1].left + tw / 2)) < 1e-9 && Math.abs(s.py - (top + th / 2)) < 1e-9, 'court centre of seat 1 → centre of its DOM rect');
  ok(Math.abs(s.pr - court.R * th) < 1e-9, `overlay radius = R·th px (${s.pr.toFixed(2)})`);
  const wc = courtToWorld(court, r1.x0 + r1.w / 2, r1.y0 + 0.5, domRects, stageW, stageH, th);
  ok(Math.abs(wc.x) < 1e-9 && Math.abs(wc.y) < 1e-9 && wc.z === -D, 'seat 1 (middle tile) centre → world origin on the hand plane');
  ok(Math.abs(courtRadiusWorld(court) - court.R * U) < 1e-12, 'courtRadiusWorld = R · U');
  // a seat camera at its tile centre: world → court through worldToTile + tileToCourt(MIRRORED_INPUT) inverts courtToWorld
  const centre = worldFromStagePx(domRects[2].left + tw / 2, top + th / 2, stageW, stageH, th);
  const cam2 = makeUvCamera(THREE, tw / th, { x: centre.x, y: centre.y, z: 0 });
  ok(cam2.fov === FOV && cam2.aspect === tw / th && cam2.near === 0.01 && cam2.far === 50 && cam2.view === null, 'makeUvCamera: FOV/aspect/near/far, no view offset');
  const cx = court.rectOf(2).x0 + 0.3, cy = court.rectOf(2).y0 + 0.7;
  const wp = courtToWorld(court, cx, cy, domRects, stageW, stageH, th);
  const back = worldToCourt(court, 2, cam2, wp);
  ok(Math.hypot(back.x - cx, back.y - cy) < 1e-6, `worldToCourt(courtToWorld) round trip on seat 2 (err ${Math.hypot(back.x - cx, back.y - cy).toExponential(2)})`);
  // display-space rule: world +x (right of the displayed tile) → larger court x (no flip)
  const a = worldToCourt(court, 2, cam2, { x: centre.x - 0.3, y: centre.y, z: -D }), b = worldToCourt(court, 2, cam2, { x: centre.x + 0.3, y: centre.y, z: -D });
  ok(b.x > a.x, 'no flip: world +x → court +x (MIRRORED_INPUT false)');
  const rect = tileWorldRect(court, 2, domRects, stageW, stageH, th);
  ok(rect && Math.abs((rect.x1 - rect.x0) - U * 16 / 9) < 1e-9 && Math.abs((rect.y1 - rect.y0) - U) < 1e-9, 'tileWorldRect: one tile = U high, U·aspect wide');
  ok(Math.abs(rect.floorY - (rect.y0 + court.shelf * (rect.y1 - rect.y0))) < 1e-9 && Math.abs(rect.bottomY - rect.y0) < 1e-9 && Math.abs(rect.shelfY - rect.floorY) < 1e-9, `tileWorldRect.floorY = the SHELF line (y0 + ${court.shelf} h); bottomY = the tile bottom`);
  const um = unmirrorHands({ left: null, right: { img: [{ x: 0.2, y: 0.3, z: 0.1 }], world: [{ x: 0.5, y: 1, z: -2 }] } });
  ok(um.left === null && um.right.img[0].x === 0.8 && um.right.world[0].x === -0.5 && um.right.img[0].z === 0.1, 'unmirrorHands (C2 seam): u → 1-u, x → -x, z untouched');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
