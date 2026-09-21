/**
 * tests/scene-executor-smoke.mjs — Node smoke test for sdk/game/scene-executor.js + sdk/game/hud.js (T5).
 * No browser, no webcam: `scene = new THREE.Scene()`, packs from PackGen, a fake local tile `{ packs, handL, handR }`
 * whose HandBody.openness comes from the pack itself (HandBody.update), tools.json loaded for the enums.
 * Checkpoints (CONTRACTS.md §8): [X1] [X2] [X3] [X4] [D4] [D6] [D8] + doctrine greps [D1] + [B4] free-text kinds (model-fetch / prop-body).
 *
 *   node tests/scene-executor-smoke.mjs      (from the repo root)
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SceneExecutor, KINDS, PHYSICS, TOOLS, ATTACH, BEHAVIORS, EFFECTS, measurePalm, R_MAX, SEEK_MAX_MPS, POCKET_GAP } from '../sdk/game/scene-executor.js';
import { Hud, bandOf, pct } from '../sdk/game/hud.js';
import { PackGen } from '../sdk/game/pack-gen.js';
import { HandBody } from '../sdk/core/game-physics.js';
import { CommandAgent } from '../sdk/game/command-agent.js';
import { D } from '../sdk/game/court-space.js';

const here = dirname(fileURLToPath(import.meta.url));
const toolsJson = JSON.parse(readFileSync(join(here, '..', 'sdk', 'game', 'tools.json'), 'utf8'));
const { tools, catalog } = toolsJson;

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok   ' + name + ' ' + extra); } else { fail++; console.error('  FAIL ' + name + ' ' + extra); } };
const DT = 1 / 60;
const V = (x, y, z) => ({ x, y, z });
const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));

// ── synthetic hands ─────────────────────────────────────────────────────────────────────────────────────────
/** PackGen.open is perfectly planar (volar evidence exactly 0). A real thumb column sits VOLAR of the knuckle plane,
 *  so give it one: s = +1 curls thumb + fingertips toward +z (palm faces the camera), s = -1 the other way. */
const openVolar = (x, y, z, s = 1) => {
  const p = PackGen.open(x, y, z);
  p[1] = V(x + 0.03, y - 0.03, z + 0.010 * s); p[2] = V(x + 0.06, y - 0.01, z + 0.020 * s);
  p[3] = V(x + 0.085, y, z + 0.030 * s); p[4] = V(x + 0.1, y, z + 0.030 * s);
  for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.16, z + 0.010 * s);
  return p;
};
/** A hand WRAPPED around a ball of radius r at B (prop-ball-smoke.mjs `around`, lateral offsets scaled for small r):
 *  palm joints on +z of the ball at contact, finger joints on -z at contact, thumb column off to the side. */
const around = (B, r) => {
  const lx = Math.min(0.04, r * 0.5);
  const p = mk(V(B.x, B.y - 0.3, B.z + 0.5));
  const pz = B.z + r + 0.022;
  p[9] = V(B.x, B.y, pz); p[0] = V(B.x, B.y - 0.204, pz);
  p[5] = V(B.x + lx, B.y, pz); p[13] = V(B.x - lx, B.y, pz); p[17] = V(B.x - 2 * lx, B.y, pz);
  const fz = B.z - (r + 0.013);
  p[8] = V(B.x + lx, B.y, fz); p[12] = V(B.x, B.y, fz); p[16] = V(B.x - lx, B.y, fz); p[20] = V(B.x, B.y - 0.06, fz);
  p[7] = V(B.x + lx, B.y + 0.015, B.z - (r + 0.015)); p[11] = V(B.x, B.y + 0.015, B.z - (r + 0.015));
  for (const i of [6, 10, 14]) p[i] = V(B.x, B.y + r + 0.05, B.z);
  for (const i of [1, 2, 3, 4]) p[i] = V(B.x + r + 0.08, B.y - 0.05, B.z + 0.02);
  return p;
};
/** Independent reference for the MEASURED inner normal (the PropBall._holdPose maths, written out here). */
const refPalm = (p) => {
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const y = sub(p[9], p[0]), span = Math.hypot(y.x, y.y, y.z);
  const c = cross(y, sub(p[5], p[17])); const cl = Math.hypot(c.x, c.y, c.z);
  const n = V(c.x / cl, c.y / cl, c.z / cl);
  const pc = V(0, 0, 0); for (const i of [0, 5, 9, 13, 17]) { pc.x += p[i].x / 5; pc.y += p[i].y / 5; pc.z += p[i].z / 5; }
  let volar = 0;
  for (const i of [1, 2]) volar += dot(sub(p[i], p[0]), n);
  for (const i of [8, 12, 16, 20]) volar += dot(sub(p[i], pc), n) * 0.5;
  volar /= span;
  const s = volar >= -1e-6 ? 1 : -1;                                  // dead band: a planar synthetic hand is fp noise around 0
  return { P: V((p[0].x + p[9].x) / 2, (p[0].y + p[9].y) / 2, (p[0].z + p[9].z) / 2), n: V(n.x * s, n.y * s, n.z * s), volar };
};

// ── fake local tile + executor ──────────────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const tile = { packs: { L: null, R: null, hands: [] }, handL: new HandBody('left'), handR: new HandBody('right') };
const setHands = (L, R) => {
  tile.packs = { L, R, hands: [] };
  if (L) tile.handL.update(L, DT); else tile.handL.drop();
  if (R) tile.handR.update(R, DT); else tile.handR.drop();
};
const hb = () => ({ left: tile.handL, right: tile.handR });
const roster = [{ clientId: 'c-000', name: 'Kenny', tracked: true }, { clientId: 'c-001', name: 'Maya', tracked: true }, { clientId: 'c-002', name: 'Sam', tracked: false }];
const seats = { 'c-000': 0, 'c-001': 1, 'c-002': 2 };
let gameStub = null, hostFlag = false;
const announced = [];
const props = new Map();
const exec = new SceneExecutor({
  scene, stage: null, props, localTile: () => tile, roster: () => roster, seatOf: id => (id in seats ? seats[id] : -1),
  game: () => gameStub, isHost: () => hostFlag, me: () => ({ clientId: 'c-000', name: 'Kenny', seat: 0 }),
  announce: (t, l) => announced.push([t, l]),
});
const HX = 0.15, HY = 0.05, HZ = -D;                                  // right-hand pack position (hand plane)
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const tick = (n, packs = tile.packs) => { for (let i = 0; i < n; i++) exec.tick(DT, packs, hb()); };

// ── [X3] every tool / attach / behavior / effect enum has a branch returning { ok: boolean } ──────────────
console.log('\n[X3] vocabulary = tools.json');
{
  const names = tools.map(t => t.name);
  ok(names.length === 8 && names.every(n => TOOLS.includes(n)) && TOOLS.every(n => names.includes(n)), `tools.json names == TOOLS: ${names.join(', ')}`);
  const attachEnum = tools.find(t => t.name === 'spawn_object').input_schema.properties.attach.enum;
  const behaviorEnum = tools.find(t => t.name === 'set_behavior').input_schema.properties.behavior.enum;
  const effectEnum = tools.find(t => t.name === 'apply_effect').input_schema.properties.effect.enum;
  const physicsEnum = tools.find(t => t.name === 'spawn_object').input_schema.properties.physics.enum;
  const kindProp = tools.find(t => t.name === 'spawn_object').input_schema.properties.kind;
  ok(!kindProp.enum && kindProp.type === 'string' && /Sketchfab/.test(kindProp.description), 'kind is free text (B4): no enum, description names the fetch path');
  const kindEnum = Object.keys(catalog);                              // the instant catalog = the executor's sphere KINDS
  ok(attachEnum.every(a => ATTACH.includes(a)) && behaviorEnum.every(b => BEHAVIORS.includes(b)) && effectEnum.every(e => EFFECTS.includes(e)), 'attach / behavior / effect enums match the module');
  ok(physicsEnum.every(p => PHYSICS[p]) && kindEnum.every(k => KINDS[k]) && Object.keys(KINDS).length === kindEnum.length, 'physics presets + KINDS match the tools.json catalog');
  for (const k of kindEnum) ok(Math.abs(KINDS[k].r * 2 - catalog[k].natural_size_m) < 1e-9 || k === 'sword', `${k}: r = natural/2 (${KINDS[k].r})`);
  const minimal = {
    spawn_object: { kind: 'apple', size_m: null, attach: 'world_front', physics: 'default' },
    set_behavior: { target: 'last', behavior: 'idle', params: { hand: 'either', speed: null, radius_m: null, participant: null } },
    apply_effect: { target: 'last', effect: 'glow', duration_s: null },
    transform_object: { target: 'last', scale: null, color: null, size_m: null },
    remove_object: { target: 'last' },
    pass_object: { target: 'last', to_participant: 'maya' },
    designate_goal: { participant: 'me' },
    list_scene: {},
  };
  for (const n of names) {
    const r = await exec.exec(n, minimal[n]);
    ok(r && typeof r.ok === 'boolean' && r.reason !== 'unknown tool', `exec('${n}') has a branch -> ok:${r.ok}${r.reason ? ' (' + r.reason + ')' : ''}`);
  }
  const unk = await exec.exec('teleport', {});
  ok(unk.ok === false && unk.reason === 'unknown tool', 'unknown tool -> { ok:false, reason:"unknown tool" }');
  await exec.exec('remove_object', { target: 'all' });
  setHands(null, openVolar(HX, HY, HZ, 1));
  for (const a of attachEnum) {
    const r = await exec.exec('spawn_object', { kind: 'ball', size_m: null, attach: a, physics: 'default' });
    ok(typeof r.ok === 'boolean' && (r.ok || typeof r.reason === 'string'), `attach '${a}' -> ok:${r.ok} attach:${r.attach || '-'}${r.reason ? ' reason: ' + r.reason : ''}`);
  }
  const base = await exec.exec('spawn_object', { kind: 'butterfly', size_m: null, attach: 'world_front', physics: 'light' });
  for (const b of behaviorEnum) {
    const r = await exec.exec('set_behavior', { target: base.id, behavior: b, params: { hand: 'either', speed: null, radius_m: null, participant: null } });
    ok(typeof r.ok === 'boolean' && (r.ok || typeof r.reason === 'string'), `behavior '${b}' -> ok:${r.ok}${r.reason ? ' reason: ' + r.reason : ''}`);
  }
  const unkB = await exec.exec('set_behavior', { target: base.id, behavior: 'teleport', params: { hand: 'either', speed: null, radius_m: null, participant: null } });
  ok(unkB.ok === false && /unknown behavior/.test(unkB.reason), 'unknown behaviour -> { ok:false, reason }');
  for (const e of effectEnum) {
    const r = await exec.exec('apply_effect', { target: base.id, effect: e, duration_s: null });
    ok(typeof r.ok === 'boolean' && (r.ok || typeof r.reason === 'string'), `effect '${e}' -> ok:${r.ok}${r.reason ? ' reason: ' + r.reason : ''}`);
  }
  const off = await exec.exec('apply_effect', { target: base.id, effect: 'glow', duration_s: 0 });
  ok(off.ok === true && !exec.resolve(base.id).effects.has('glow'), 'duration 0 stops the glow');
  const sc = await exec.exec('apply_effect', { target: 'scene', effect: 'trail', duration_s: 1 });
  ok(sc.ok === true && sc.applied >= 1, `scene-wide trail applied to ${sc.applied} props`);
  tick(70);
  ok(![...props.values()].some(p => p.effects.has('trail')), 'a 1 s trail expires after 70 frames');
  await exec.exec('remove_object', { target: 'all' });
}

// ── [X1] spawn into the OPEN right hand: seated at palm + n * (r + 0.01) along the MEASURED normal ───────────
console.log('\n[X1] spawn_object right_hand -> measured pocket');
{
  const r = KINDS.apple.r;
  const results = {};
  for (const s of [1, -1]) {
    const pack = openVolar(HX, HY, HZ, s);
    setHands(null, pack);
    ok(tile.handR.openness > 0.6, `s=${s}: HandBody.openness of the open pack = ${tile.handR.openness.toFixed(2)} > 0.6`);
    const res = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'right_hand', physics: 'default' });
    ok(res.ok === true && res.attach === 'right_hand' && res.hand === 'right' && /^apple_\d+$/.test(res.id), `s=${s}: spawned ${res.id} attach ${res.attach} hand ${res.hand}`);
    const prop = exec.resolve(res.id);
    const ref = refPalm(pack);
    const expected = V(ref.P.x + ref.n.x * (r + POCKET_GAP), ref.P.y + ref.n.y * (r + POCKET_GAP), ref.P.z + ref.n.z * (r + POCKET_GAP));
    const d = dist3(prop.ball.pos, expected);
    ok(d < 0.002, `s=${s}: prop centre within 2 mm of palm + n*(r+0.01): ${(d * 1000).toFixed(2)} mm (n.z=${ref.n.z.toFixed(2)}, volar=${ref.volar.toFixed(3)})`);
    const m = measurePalm(pack);
    ok(m.ok && Math.abs(m.n.z - ref.n.z) < 1e-6 && m.sign === (ref.volar >= 0 ? 1 : -1), `s=${s}: measurePalm agrees with the reference (sign ${m.sign})`);
    results[s] = { z: prop.ball.pos.z, nz: ref.n.z, id: res.id };
    ok(prop.ball.mesh.parent === scene, `[D8] s=${s}: mesh.parent === scene`);
    ok(prop.ball.sphere.gravity < 0, `[D4] s=${s}: sphere.gravity = ${prop.ball.sphere.gravity} < 0`);
  }
  ok(results[1].nz * results[-1].nz < 0, `flipping the pack's z flips the measured normal (${results[1].nz.toFixed(2)} vs ${results[-1].nz.toFixed(2)})`);
  ok(Math.abs((results[1].z - results[-1].z) - 2 * (r + POCKET_GAP) * Math.sign(results[1].nz)) < 0.002, `the prop moved to the other side of the palm (dz = ${(results[1].z - results[-1].z).toFixed(3)})`);
  const planar = PackGen.open(HX, HY, HZ);
  setHands(null, planar);
  const rp = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'right_hand', physics: 'default' });
  const refP = refPalm(planar), pp = exec.resolve(rp.id).ball.pos;
  const ep = V(refP.P.x + refP.n.x * (r + POCKET_GAP), refP.P.y + refP.n.y * (r + POCKET_GAP), refP.P.z + refP.n.z * (r + POCKET_GAP));
  ok(rp.ok && dist3(pp, ep) < 0.002, `a perfectly planar PackGen.open pack still seats at the pocket (HandBody tie-break, sign ${refP.volar >= 0 ? '+1' : '-1'}): ${(dist3(pp, ep) * 1000).toFixed(2)} mm`);
  // left_hand with only a right hand tracked -> refused; either_hand with a cup (not open) -> world_front
  const noL = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'left_hand', physics: 'default' });
  ok(noL.ok === false && /no open left hand/.test(noL.reason), `left_hand with no left hand -> ${JSON.stringify(noL.reason)}`);
  const cupPack = PackGen.cup(HX, HY, HZ);
  setHands(null, cupPack);
  ok(tile.handR.openness > 0.6 && tile.handR.openness < 0.75, `PackGen.cup (loosely cupped, closure ~0.5) reads openness ${tile.handR.openness.toFixed(2)}: still an open palm`);
  const fist = cupPack.map((q, i) => ([8, 12, 16, 20].includes(i) ? V(HX, HY + 0.03, HZ + 0.03) : i === 4 ? V(HX + 0.03, HY, HZ + 0.03) : q));
  setHands(null, fist);
  ok(tile.handR.openness <= 0.6, `fist pack openness ${tile.handR.openness.toFixed(2)} <= 0.6 (not an open palm)`);
  const cupR = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'right_hand', physics: 'default' });
  ok(cupR.ok === false && /no open right hand/.test(cupR.reason), `right_hand with a closed hand -> ${JSON.stringify(cupR.reason)}`);
  setHands(null, null);
  const eh = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'either_hand', physics: 'default' });
  ok(eh.ok === true && eh.attach === 'world_front' && typeof eh.note === 'string', `either_hand with no open hand -> ok:true attach:'${eh.attach}' note: ${eh.note}`);
  const wc = V(0, 0, -D);
  ok(dist3(exec.resolve(eh.id).ball.pos, V(wc.x, wc.y + 0.1, wc.z + 0.3)) < 1e-6, 'world_front home = workspace centre + (0, 0.1, 0.3)');
  setHands(null, openVolar(HX, HY, HZ, 1));
  const ehR = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'either_hand', physics: 'default' });
  ok(ehR.ok && ehR.attach === 'right_hand', 'either_hand prefers the open right hand');
  setHands(openVolar(-HX, HY, HZ, 1), null);
  const ehL = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'either_hand', physics: 'default' });
  ok(ehL.ok && ehL.attach === 'left_hand', 'either_hand falls back to the open left hand');
  ok(announced.some(a => /Apple on your right palm/.test(a[0])), 'announce() got the spawn line');
  await exec.exec('remove_object', { target: 'all' });
  // [D5] a palm-UP hand: the apple is seated above the palm and the hand SUPPORTS it (never passes through).
  // k = 1.0 = a real-sized palm (wrist..knuckles 8 cm); PackGen.flat's default k = 2.2 leaves a 17 cm hole a 4 cm apple drops through.
  const flat = PackGen.flat(HX, HY, HZ, 1.0);
  setHands(null, flat);
  const fr = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'right_hand', physics: 'default' });
  const fp = exec.resolve(fr.id);
  ok(fr.ok && fp.ball.pos.y > HY + r, `palm-up flat pack: measured normal points up, apple seated above the palm (y ${fp.ball.pos.y.toFixed(3)} > ${(HY + r).toFixed(3)})`);
  let yMin = Infinity;
  for (let i = 0; i < 90; i++) { setHands(null, PackGen.flat(HX, HY, HZ, 1.0)); tick(1); yMin = Math.min(yMin, fp.ball.pos.y); }   // a tracked hand is re-delivered every frame (hand-stop mutates packs)
  ok(yMin >= HY + r - 0.015 && !fp.ball.hold, `[D5] after 90 frames it rests ON the palm joints (centre ~3 cm over the plane by geometry): min y ${yMin.toFixed(4)} >= ${(HY + r - 0.015).toFixed(3)}, not grabbed, never through`);
  await exec.exec('remove_object', { target: 'all' });
}

// ── [X2] gravity after the hand goes; a cup pack around the apple wraps it ──────────────────────────────────
console.log('\n[X2] falls when the hand leaves; wrap grabs');
{
  setHands(null, openVolar(HX, HY, HZ, 1));
  const res = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'right_hand', physics: 'default' });
  const prop = exec.resolve(res.id);
  setHands(null, null);
  let fell = -1;
  for (let i = 1; i <= 10; i++) { tick(1); if (prop.ball.vel.y < 0) { fell = i; break; } }
  ok(fell > 0, `[X2] pack removed -> vy < 0 within ${fell} frame(s) (vy=${prop.ball.vel.y.toFixed(3)})`);
  const w = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'world_front', physics: 'default' });
  const wp = exec.resolve(w.id);
  tick(2);
  const B = wp.ball.pos.clone();
  const wrapPack = around(B, wp.ball.sphere.radius);
  setHands(null, wrapPack);
  let held = -1;
  for (let i = 1; i <= 10; i++) { tick(1); if (wp.ball.snapshot().holdType === 'wrap') { held = i; break; } }
  ok(held > 0, `[X2] cup pack around the apple -> holdType 'wrap' within ${held} frame(s)`);
  tick(30);
  ok(wp.ball.hold && wp.ball.hold.type === 'wrap' && dist3(wp.ball.pos, B) < 0.02, `still wrapped after 30 more frames (moved ${(dist3(wp.ball.pos, B) * 1000).toFixed(1)} mm)`);
  ok(exec.snapshot().objects.find(o => o.id === w.id).held_by === 'c-000:right', 'list_scene reports held_by "c-000:right" while wrapped');
  const opened = wrapPack.map((q, i) => ([6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20].includes(i) ? V(q.x, q.y, q.z - 0.15) : q));
  setHands(null, opened);
  tick(1);
  ok(!wp.ball.hold, '[D3] fingers open -> released that frame');
  await exec.exec('remove_object', { target: 'all' });
}

// ── [D4] every physics preset keeps gravity on ─────────────────────────────────────────────────────────────
console.log('\n[D4] presets');
{
  setHands(null, null);
  for (const p of Object.keys(PHYSICS)) {
    const r = await exec.exec('spawn_object', { kind: 'ball', size_m: null, attach: 'world_front', physics: p });
    const b = exec.resolve(r.id).ball;
    ok(b.sphere.gravity < 0 && b.sphere.gravity === PHYSICS[p].gravity && b.sphere.restitution === PHYSICS[p].restitution, `${p}: gravity ${b.sphere.gravity} restitution ${b.sphere.restitution}`);
    ok(b.mesh.parent === scene && b.mesh.layers.mask === 1, `[D8] ${p}: mesh on the scene, layer 0`);
  }
  const big = await exec.exec('spawn_object', { kind: 'ball', size_m: 9, attach: 'world_front', physics: 'default' });
  ok(exec.resolve(big.id).ball.sphere.radius === R_MAX && big.size_m === 2, `size_m 9 clamps to r=${R_MAX} (size_m ${big.size_m})`);
  const tiny = await exec.exec('spawn_object', { kind: 'ball', size_m: 0.001, attach: 'world_front', physics: 'default' });
  ok(exec.resolve(tiny.id).ball.sphere.radius === 0.01, 'size_m 0.001 clamps to r=0.01');
  await exec.exec('remove_object', { target: 'all' });
}

// ── [D6] seek_hand never lifts ─────────────────────────────────────────────────────────────────────────────
console.log('\n[D6] seek_hand');
{
  setHands(null, null);
  const r = await exec.exec('spawn_object', { kind: 'ball', size_m: null, attach: 'table', physics: 'default' });
  const prop = exec.resolve(r.id);
  tick(120);                                                          // settle on the floor
  const y0 = prop.ball.pos.y, x0 = prop.ball.pos.x;
  const sb = await exec.exec('set_behavior', { target: r.id, behavior: 'seek_hand', params: { hand: 'right', speed: 2.5, radius_m: null, participant: null } });
  ok(sb.ok === true && sb.behavior === 'seek_hand' && sb.speed <= SEEK_MAX_MPS, `seek_hand accepted, speed capped at ${sb.speed} m/s`);
  const hand = openVolar(x0 + 0.25, y0 + 0.3, prop.ball.pos.z, 1);   // 0.3 m ABOVE the prop, off to +x
  setHands(null, hand);
  let yMax = -Infinity, moved = 0;
  for (let i = 0; i < 60; i++) { tick(1); yMax = Math.max(yMax, prop.ball.pos.y); }
  moved = prop.ball.pos.x - x0;
  ok(yMax <= y0 + 1e-6, `[D6] 60 frames of seek_hand with the hand 0.3 m above: y never above its start (max ${yMax.toFixed(4)} vs ${y0.toFixed(4)})`);
  ok(moved > 0.05 && moved <= SEEK_MAX_MPS * DT * 60 + 1e-6, `the prop rolled toward the hand in x/z only: dx=${moved.toFixed(3)} (cap ${(SEEK_MAX_MPS * DT * 60).toFixed(3)})`);
  ok(prop.ball.sphere.gravity < 0, 'gravity untouched by the seek');
  const orbit = await exec.exec('set_behavior', { target: r.id, behavior: 'orbit_hand', params: { hand: 'either', speed: null, radius_m: null, participant: null } });
  ok(orbit.ok === false && typeof orbit.reason === 'string' && orbit.reason.length > 5, `orbit_hand -> ok:false "${orbit.reason}"`);
  ok(prop.behavior && prop.behavior.kind === 'seek_hand', 'a refused behaviour leaves the running one alone');
  const other = await exec.exec('set_behavior', { target: r.id, behavior: 'seek_hand', params: { hand: 'either', speed: null, radius_m: null, participant: 'maya' } });
  ok(other.ok === false && /own hands/.test(other.reason), `seek_hand toward another participant -> ${JSON.stringify(other.reason)}`);
  const idle = await exec.exec('set_behavior', { target: r.id, behavior: 'idle', params: { hand: 'either', speed: null, radius_m: null, participant: null } });
  ok(idle.ok === true && prop.behavior === null, 'idle clears the behaviour');
  await exec.exec('remove_object', { target: 'all' });
}

// ── transform / remove ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[transform / remove]');
{
  setHands(null, null);
  const r = await exec.exec('spawn_object', { kind: 'basketball', size_m: null, attach: 'world_front', physics: 'bouncy' });
  const prop = exec.resolve(r.id);
  const t = await exec.exec('transform_object', { target: 'last', scale: 10, color: 'gold', size_m: null });
  ok(t.ok === true && prop.ball.sphere.radius === 1.0 && prop.ball.collider.radius === 1.0 && t.size_m === 2, `scale 10 on a basketball clamps the radius to 1.0 (size_m ${t.size_m})`);
  const H = prop.ball.hull.begin(prop.ball.mesh);
  ok(Math.abs(H.surfaceDistance(new THREE.Vector3(prop.ball.pos.x + 1.0, prop.ball.pos.y, prop.ball.pos.z))) < 1e-6, 'the hull follows the new radius');
  ok(prop.ball.mesh.material.color.getHexString() === 'ffd700' && prop.color === 'gold', 'colour set through material.color (gold)');
  const bad = await exec.exec('transform_object', { target: 'last', scale: null, color: 'not-a-colour-xyz', size_m: null });
  ok(bad.ok === true, 'an unknown colour name is ignored, not thrown');
  const half = await exec.exec('transform_object', { target: 'basketball', scale: 0.5, color: null, size_m: null });
  ok(half.ok && Math.abs(prop.ball.sphere.radius - 0.5) < 1e-9, 'scale 0.5 -> r 0.5');
  const abs = await exec.exec('transform_object', { target: 'basketball', scale: 3, color: null, size_m: 0.3 });
  ok(abs.ok && Math.abs(prop.ball.sphere.radius - 0.15) < 1e-9, 'size_m wins over scale (r 0.15)');
  tick(5);
  ok(prop.ball.sphere.gravity < 0 && prop.ball.mesh.parent === scene, 'still falling on the scene after resizing');
  await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'world_front', physics: 'default' });
  await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'world_front', physics: 'default' });
  const rk = await exec.exec('remove_object', { target: 'apple' });
  ok(rk.ok && rk.removed === 2 && props.size === 1, `remove_object 'apple' removed both apples (${rk.removed})`);
  const none = await exec.exec('remove_object', { target: 'butterfly' });
  ok(none.ok === false, 'removing a missing kind -> ok:false');
  const meshesBefore = scene.children.length;
  const all = await exec.exec('remove_object', { target: 'all' });
  ok(all.ok && all.removed === 1 && props.size === 0 && exec.lastTarget === null, `remove_object 'all' empties the map (${all.removed} removed, lastTarget null)`);
  ok(scene.children.length === meshesBefore - 1 && scene.children.length === 0, `meshes left the scene (${scene.children.length} children)`);
}

// ── [X4] pass_object / designate_goal gates ────────────────────────────────────────────────────────────────
console.log('\n[X4] pass / goal');
{
  setHands(null, null);
  const a = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'world_front', physics: 'default' });
  gameStub = null;
  const p1 = await exec.exec('pass_object', { target: 'apple', to_participant: 'maya' });
  ok(p1.ok === false && /only the game ball/.test(p1.reason), `pass an apple -> ${JSON.stringify(p1.reason)}`);
  const p0 = await exec.exec('pass_object', { target: 'ball', to_participant: 'maya' });
  ok(p0.ok === false && /no game/.test(p0.reason), `pass the ball with no game -> ${JSON.stringify(p0.reason)}`);
  const calls = [];
  gameStub = { net: { isOwner: false, inTransit: false }, court: { map: { goal: -1 } }, passToward: s => { calls.push(s); return { ok: true }; }, setGoal: s => { gameStub.court.map.goal = s; } };
  const p2 = await exec.exec('pass_object', { target: 'ball', to_participant: 'Maya' });
  ok(p2.ok === false && calls.length === 0, `not the owner -> ${JSON.stringify(p2.reason)} (passToward not called)`);
  gameStub.net.isOwner = true;
  const p3 = await exec.exec('pass_object', { target: 'ball', to_participant: 'maya' });
  ok(p3.ok === true && calls[0] === 1 && p3.to === 'c-001', `owner -> game.passToward(seat 1) -> ok (to ${p3.to})`);
  const p4 = await exec.exec('pass_object', { target: 'ball', to_participant: 'right' });
  ok(p4.ok === true && calls[1] === 1, "layout word 'right' from seat 0 -> seat 1");
  const p5 = await exec.exec('pass_object', { target: 'ball', to_participant: 'nobody' });
  ok(p5.ok === false && /no such participant/.test(p5.reason), 'unknown participant -> ok:false');
  const p6 = await exec.exec('pass_object', { target: 'ball', to_participant: 'me' });
  ok(p6.ok === false, 'passing to yourself -> ok:false');
  gameStub.passToward = () => ({ ok: false, reason: 'held' });
  const p7 = await exec.exec('pass_object', { target: 'ball', to_participant: 'maya' });
  ok(p7.ok === false && p7.reason === 'held', 'game.passToward refusal (held / in transit) is passed through');
  const p8 = await exec.exec('pass_object', { target: a.id, to_participant: 'maya' });
  ok(p8.ok === false && /only the game ball/.test(p8.reason), 'an agent prop by id -> refused even with a game');
  hostFlag = false;
  const g1 = await exec.exec('designate_goal', { participant: 'maya' });
  ok(g1.ok === false && g1.reason === 'host only', `designate_goal as non-host -> ${JSON.stringify(g1.reason)}`);
  hostFlag = true;
  const g2 = await exec.exec('designate_goal', { participant: 'sam' });
  ok(g2.ok === true && g2.seat === 2 && gameStub.court.map.goal === 2, 'host: designate_goal sam -> game.setGoal(2)');
  const snapG = exec.snapshot();
  ok(snapG.participants.find(p => p.id === 'c-002').goal === true && snapG.participants.find(p => p.id === 'c-000').goal === false, 'snapshot marks the goal participant');
  const g3 = await exec.exec('designate_goal', { participant: 'none' });
  ok(g3.ok === true && gameStub.court.map.goal === -1, "'none' clears the goal (setGoal(-1))");
  const g4 = await exec.exec('designate_goal', { participant: 'me' });
  ok(g4.ok === true && g4.seat === 0, "'me' -> my seat");
  hostFlag = false; gameStub = null;
  await exec.exec('remove_object', { target: 'all' });
}

// ── list_scene shape (what CommandAgent._snapshot reads) ──────────────────────────────────────────────────
console.log('\n[list_scene]');
{
  setHands(null, openVolar(HX, HY, HZ, 1));
  const a = await exec.exec('spawn_object', { kind: 'apple', size_m: null, attach: 'right_hand', physics: 'default' });
  await exec.exec('apply_effect', { target: a.id, effect: 'glow', duration_s: null });
  const s = await exec.exec('list_scene', {});
  ok(s.ok === true && Array.isArray(s.objects) && Array.isArray(s.participants) && s.speaker === 'c-000', 'list_scene -> { ok, objects[], participants[], speaker }');
  const o = s.objects[0];
  ok(o && o.id === a.id && o.kind === 'apple' && o.size_m === 0.08 && Array.isArray(o.position) && o.position.length === 3 && 'held_by' in o && o.behavior === null && Array.isArray(o.effects) && o.effects.includes('glow'), `object: ${JSON.stringify(o)}`);
  const me = s.participants.find(p => p.id === 'c-000');
  ok(me && me.name === 'Kenny' && me.tile.seat === 0 && me.tile.row === 0 && me.tile.col === 0 && me.hands.left === false && me.hands.right === true && me.goal === false, `me: ${JSON.stringify(me)}`);
  const maya = s.participants.find(p => p.id === 'c-001');
  ok(maya && maya.tile.seat === 1 && maya.hands.right === true && s.participants.find(p => p.id === 'c-002').hands.left === false, 'remote participants: seat + tracked hands');
  ok(s.last === a.id && exec.lastTarget === a.id, 'last = the spawned id');
  await exec.exec('remove_object', { target: 'all' });
}

// ── CommandAgent local grammar through the real executor ───────────────────────────────────────────────────
console.log('\n[CommandAgent mode:local]');
{
  setHands(null, openVolar(HX, HY, HZ, 1));
  const agent = new CommandAgent({ tools, catalog, executor: (n, i) => exec.exec(n, i), mode: 'local' });
  const res = await agent.command('give me an apple in my hand');
  ok(res.source === 'local' && res.status === 'ok', `source '${res.source}' status '${res.status}'`);
  ok(res.actions.length === 1 && res.actions[0].name === 'spawn_object', `one action: ${res.actions.map(a => a.name).join(', ')}`);
  const r0 = res.actions[0].result;
  ok(r0 && r0.ok === true && r0.attach === 'right_hand' && props.size === 1, `spawned ${r0 && r0.id} in the ${r0 && r0.attach}`);
  ok(agent.lastTarget === r0.id, 'agent.lastTarget follows the executor id');
  const glow = await agent.command('make it glow');
  ok(glow.actions.length === 1 && glow.actions[0].name === 'apply_effect' && glow.actions[0].result.ok === true, 'follow-up "make it glow" resolves "it" through last');
  const pass = await agent.command('pass it to maya');
  ok(pass.actions.length === 1 && pass.actions[0].name === 'pass_object' && pass.actions[0].result.ok === false, `"pass it to maya" on the apple is refused: ${pass.actions[0].result.reason}`);
  await exec.exec('remove_object', { target: 'all' });
}

// ── hud.js: rolling p50/p95 + bands ─────────────────────────────────────────────────────────────────────────
console.log('\n[hud]');
{
  let t = 0;
  const hud = new Hud(null, null, { hz: 2, localNow: () => t });
  const fed = [];
  for (let i = 0; i < 300; i++) { const v = (i * 37) % 100; fed.push(v); hud.frame({ scriptMs: v, detectMs: v / 2, fps: 60 }); }
  const last120 = fed.slice(-120);
  ok(Math.abs(hud.scriptP50 - pct(last120, 0.5)) < 1e-9 && Math.abs(hud.scriptP95 - pct(last120, 0.95)) < 1e-9, `script p50 ${hud.scriptP50} / p95 ${hud.scriptP95} over the last 120 of 300 frames`);
  ok(Math.abs(hud.detectP95 - pct(last120.map(v => v / 2), 0.95)) < 1e-9 && hud.fps === 60, `detect p95 ${hud.detectP95}, fps ${hud.fps}`);
  const bands = [[79, 'invisible'], [80, 'fine'], [149, 'fine'], [150, 'stretch'], [299, 'stretch'], [300, 'degraded'], [500, 'degraded'], [501, 'wall']];
  for (const [ms, b] of bands) ok(bandOf(ms) === b, `band(${ms}) = ${bandOf(ms)}`);
  for (let i = 0; i < 130; i++) hud.remoteAge('c-001', 'Maya', 60 + (i % 3) * 10);
  for (let i = 0; i < 130; i++) hud.remoteAge('c-bot', 'Bot', 200 + (i % 3) * 10);
  hud.ownAge(34);
  hud.relay({ rttMs: 9, offsetMs: 12, samples: 8, errMs: 3 });
  ok(hud.band('c-001') === 'fine' && hud.band('c-bot') === 'stretch' && hud.band('you') === 'invisible', `bands: Maya ${hud.band('c-001')}, Bot ${hud.band('c-bot')}, you ${hud.band('you')}`);
  ok(hud.chipString() === 'you 34 · Maya 60 · Bot 200 · relay 9', `chip: ${hud.chipString()}`);   // last fed: i=129 -> +0
  // pkt/s: a dropping age = a new packet
  t = 0; hud.forget('c-001');
  for (let i = 0; i < 60; i++) { t = i * (1000 / 60); hud.remoteAge('c-001', 'Maya', 40 + (i % 2) * 16); }
  ok(hud.toJSON().remote['c-001'].hz >= 25 && hud.toJSON().remote['c-001'].hz <= 30, `pkt/s inferred from age drops: ${hud.toJSON().remote['c-001'].hz}`);
  hud.ball({ owner: 1, inTransit: true, oneWayMs: 70, stretches: 2, conflicts: 0, handoffMs: 120 }, 'transit', 350);
  hud.contexts(3);
  const j = hud.toJSON();
  ok(j.ball.owner === 1 && j.ball.inTransit === true && j.ball.phase === 'transit' && j.ball.leadMs === 350 && j.ball.handoffMs === 120 && j.contexts === 3 && j.relayRttMs === 9 && j.clockSamples === 8, 'toJSON carries the S.hud shape');
  const line = hud.autotestLine({ tiles: 2 });
  ok(line.startsWith('AUTOTEST ') && JSON.parse(line.slice(9)).tiles === 2 && JSON.parse(line.slice(9)).phase === 'transit', `autotestLine: ${line.slice(0, 80)}...`);
  t = 0; let writes = 0;
  for (let i = 0; i < 10; i++) { t = i * 100; if (hud.render(t)) writes++; }
  ok(writes === 2, `render throttled to hz=2: ${writes} writes in 1 s`);
  const chip = { textContent: '', hidden: false }, panel = { innerHTML: '', hidden: false };
  const hud2 = new Hud(chip, panel, { hz: 2, localNow: () => 0 });
  hud2.ownAge(12); hud2.remoteAge('x', '<b>Eve</b>', 50); hud2.render(1000);
  ok(chip.textContent === 'you 12 · <b>Eve</b> 50' && panel.innerHTML.includes('&lt;b&gt;Eve&lt;/b&gt;') && !panel.innerHTML.includes('<b>Eve'), 'DOM chip written; panel escapes names');
  hud2.setVisible(false);
  ok(chip.hidden === true && panel.hidden === true, 'setVisible(false) hides both');
}

// ── [B4] free-text kind: placeholder into the measured pocket NOW, fetched model hot-swapped in place (mocked fetcher) ─
console.log('\n[B4] free-text kind through a mocked fetcher');
{
  const { makePlaceholder, normaliseModel, buildHull, toMatcap, ModelFetcher } = await import('../sdk/game/model-fetch.js');
  const { PropBody } = await import('../sdk/game/prop-body.js');
  const { PropBall } = await import('../sdk/game/prop-ball.js');
  const statuses = [];
  const pending = [];                                                  // { kind, resolve, signal } per fetcher.resolve call
  const mockFetcher = {
    sizeFor: kind => /tennis/.test(kind) ? 0.067 : 0.09,
    local: () => null,
    resolve(kind, o) { o.onStatus({ phase: 'searching', tier: 'sketchfab' }); return new Promise(resolve => pending.push({ kind, resolve, signal: o.signal })); },
  };
  const props2 = new Map();
  const exec2 = new SceneExecutor({ scene, props: props2, localTile: () => tile, me: () => ({ clientId: 'c-000', name: 'Kenny', seat: 0 }),
    announce: (t, l) => announced.push([t, l]), fetcher: mockFetcher, onModelStatus: (p, st) => statuses.push(p.id + ':' + st.phase) });
  const pack = openVolar(HX, HY, HZ, 1);
  setHands(null, pack);
  const res = await exec2.exec('spawn_object', { kind: 'Rubber Duck', size_m: null, attach: 'right_hand', physics: 'default' });
  ok(res.ok === true && res.id === 'rubber_duck_1' && res.kind === 'rubber duck' && res.size_m === 0.09 && res.attach === 'right_hand' && res.hand === 'right' && res.model && res.model.status === 'searching' && res.model.tier === 'sketchfab',
    `free-text kind spawns at once: ${JSON.stringify({ id: res.id, kind: res.kind, size_m: res.size_m, model: res.model })}`);
  const prop = exec2.resolve(res.id);
  ok(prop.ball instanceof PropBody && prop.ball instanceof PropBall && prop.model.status === 'searching' && pending.length === 1 && pending[0].kind === 'rubber duck', 'PropBody registered in the props bag; fetcher.resolve called once with the normalised word');
  const rDuck = 0.045, ref = refPalm(pack);
  const expected = V(ref.P.x + ref.n.x * (rDuck + POCKET_GAP), ref.P.y + ref.n.y * (rDuck + POCKET_GAP), ref.P.z + ref.n.z * (rDuck + POCKET_GAP));
  ok(dist3(prop.ball.pos, expected) < 0.002, `[X1] placeholder seated at palm + n*(r+0.01) with r = size/2 = ${rDuck}: ${(dist3(prop.ball.pos, expected) * 1000).toFixed(2)} mm`);
  ok(prop.ball.mesh.parent === scene && prop.ball.sphere.gravity < 0 && prop.ball.hull.segs.length === 1 && Math.abs(prop.ball.hull.segs[0].ra - 0.09 * 0.6) < 1e-9, `[D4][D8] placeholder on the scene, gravity ${prop.ball.sphere.gravity}, sphere hull r=${prop.ball.hull.segs[0].ra.toFixed(3)}`);
  let cubeMesh = null; prop.ball.mesh.traverse(m => { if (m.isMesh) cubeMesh = m; });
  ok(cubeMesh && cubeMesh.geometry.type === 'BoxGeometry' && cubeMesh.material.type === 'MeshMatcapMaterial' && cubeMesh.layers.mask === 1, `placeholder is a matcap cube on layer 0 (${cubeMesh && cubeMesh.geometry.type})`);
  ok(statuses.includes('rubber_duck_1:searching') && announced.some(a => /Looking for a rubber duck for your right palm/.test(a[0])), 'status callback + announce fired for the search');
  // the placeholder is a doctrine prop while it waits: the hand leaves -> it falls
  setHands(null, null);
  let fell = -1;
  for (let i = 1; i <= 10; i++) { exec2.tick(DT, tile.packs, hb()); if (prop.ball.vel.y < 0) { fell = i; break; } }
  ok(fell > 0, `[X2] placeholder falls when the hand leaves (vy < 0 within ${fell} frames)`);
  // the model arrives: a 2 x 1 x 0.5 box off-centre at (3,0,0) with a light -> normalised, matcap, capsule-chain hull
  const raw = new THREE.Group();
  const bm = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 0.5, 4, 2, 2), new THREE.MeshStandardMaterial({ color: 0xffcc00 }));
  bm.position.set(3, 0, 0); raw.add(bm); raw.add(new THREE.PointLight());
  const n = normaliseModel(raw, 0.09); toMatcap(n.object); const h = buildHull(n.object, n.r);
  ok(Math.abs(n.dims[0] - 0.09) < 1e-9 && Math.abs(n.dims[1] - 0.045) < 1e-9 && Math.abs(n.dims[2] - 0.0225) < 1e-9, `normalised dims ${n.dims.map(v => v.toFixed(4)).join(' x ')} (largest = 0.09)`);
  const nb = new THREE.Box3().setFromObject(n.object), nc = nb.getCenter(new THREE.Vector3());
  let lights = 0; n.object.traverse(o => { if (o.isLight) lights++; });
  ok(nc.length() < 1e-9 && lights === 0, `centred (|centre| = ${nc.length().toExponential(1)}), lights stripped`);
  ok(!h.sphere && h.hull.segs.length > 0, `capsule-chain hull: ${h.hull.segs.length} segments`);
  const built = { tier: 'sketchfab', object: n.object, inner: n.inner, hull: h.hull, sphere: h.sphere, r: n.r, size_m: 0.09, dims: n.dims, name: 'Rubber Duck (mock)', uid: 'mock-uid' };
  const posBefore = prop.ball.pos.clone(), velBefore = prop.ball.vel.clone(), oldWrap = prop.ball.mesh;
  pending[0].resolve(built);
  const readyProp = await exec2.whenReady(res.id);
  ok(readyProp === prop && prop.model.status === 'ready' && prop.model.tier === 'sketchfab' && prop.model.uid === 'mock-uid', `whenReady -> model ${JSON.stringify({ status: prop.model.status, tier: prop.model.tier, name: prop.model.name })}`);
  ok(prop.ball.mesh === built.object && built.object.parent === scene && oldWrap.parent === null && !scene.children.includes(oldWrap), 'visual hot-swapped: model group on the scene, placeholder wrapper gone');
  ok(prop.ball.pos.distanceTo(posBefore) < 1e-9 && prop.ball.vel.distanceTo(velBefore) < 1e-9 && prop.ball.hull === h.hull, 'position / velocity kept across the swap; hull is the capsule chain');
  const H = prop.ball.hull.begin(prop.ball.mesh);
  ok(H.surfaceDistance(prop.ball.pos) < 0 && H.surfaceDistance(new THREE.Vector3(prop.ball.pos.x + 0.3, prop.ball.pos.y, prop.ball.pos.z)) > 0.2, 'hull follows the prop: centre inside, 30 cm away outside');
  ok(announced.some(a => /Rubber duck is ready/.test(a[0])) && statuses.includes('rubber_duck_1:ready'), 'ready announced + status callback');
  // [D5] the fetched model rests on a flat palm (hull push-out), never through it
  prop.ball.sphere.reset(new THREE.Vector3(HX, HY + 0.08, HZ)); prop.ball.sphere.vel.set(0, 0, 0);
  let yMin = Infinity;
  for (let i = 0; i < 90; i++) { setHands(null, PackGen.flat(HX, HY, HZ, 1.0)); exec2.tick(DT, tile.packs, hb()); yMin = Math.min(yMin, prop.ball.pos.y); }
  ok(yMin >= HY - 0.01 && prop.ball.pos.y >= HY - 0.01, `[D5] model rests on the palm joints: min y ${yMin.toFixed(4)} >= ${(HY - 0.01).toFixed(3)} (never through)`);
  setHands(null, null);
  // transform: absolute size + colour on the PropBody (inner model + hull segments scale together)
  const ra0 = prop.ball.hull.segs[0].ra;
  const t = await exec2.exec('transform_object', { target: 'last', scale: null, color: 'gold', size_m: 0.18 });
  const mats = prop.ball.materials();
  ok(t.ok === true && Math.abs(prop.ball.sphere.radius - 0.09) < 1e-9 && Math.abs(prop.ball.hull.segs[0].ra - 2 * ra0) < 1e-12 && mats.length > 0 && mats.every(m => m.color.getHexString() === 'ffd700') && prop.color === 'gold',
    `size_m 0.18 -> r 0.09, hull segment radius x2 (${ra0.toFixed(4)} -> ${prop.ball.hull.segs[0].ra.toFixed(4)}), ${mats.length} material(s) gold`);
  const nb2 = new THREE.Box3().setFromObject(prop.ball.mesh), d2 = nb2.getSize(new THREE.Vector3());
  ok(Math.abs(d2.x - 0.18) < 1e-6, `the visual grew with it (largest dim ${d2.x.toFixed(4)})`);
  const g = await exec2.exec('apply_effect', { target: 'last', effect: 'glow', duration_s: null });
  ok(g.ok === true && prop.effects.has('glow') && mats[0].color.getHexString() !== 'ffd700', 'glow on a matcap body brightens it (no emissive needed)');
  await exec2.exec('apply_effect', { target: 'last', effect: 'glow', duration_s: 0 });
  ok(mats[0].color.getHexString() === 'ffd700', 'glow off restores the base colour');
  const snap = await exec2.exec('list_scene', {});
  ok(snap.objects[0].kind === 'rubber duck' && snap.objects[0].model && snap.objects[0].model.status === 'ready' && snap.objects[0].size_m === 0.18, `list_scene carries model status: ${JSON.stringify(snap.objects[0].model)}`);
  // fallback: the fetcher comes back with a placeholder -> status 'fallback', the labelled cube STAYS (never silent)
  const r2 = await exec2.exec('spawn_object', { kind: 'unicorn', size_m: null, attach: 'world_front', physics: 'default' });
  const p2 = exec2.resolve(r2.id), meshBefore = p2.ball.mesh;
  pending[1].resolve({ ...makePlaceholder('unicorn', 0.09), error: 'no downloadable model for "unicorn"' });
  await exec2.whenReady(r2.id);
  ok(p2.model.status === 'fallback' && p2.ball.mesh === meshBefore && p2.ball.mesh.parent === scene && /no downloadable/.test(p2.model.error) && announced.some(a => /No unicorn model found/.test(a[0])),
    `fallback keeps the labelled placeholder on the scene and announces it (${p2.model.error})`);
  // remove while loading: the fetch is aborted and a late model is discarded
  const r3 = await exec2.exec('spawn_object', { kind: 'toy car', size_m: null, attach: 'world_front', physics: 'default' });
  const p3 = exec2.resolve(r3.id);
  await exec2.exec('remove_object', { target: r3.id });
  ok(!props2.has(r3.id) && pending[2].signal && pending[2].signal.aborted === true, 'remove while loading aborts the fetch signal');
  const late = normaliseModel(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8)), 0.09);
  pending[2].resolve({ tier: 'sketchfab', object: late.object, inner: late.inner, hull: null, sphere: true, r: 0.045, size_m: 0.09, dims: late.dims, name: 'late' });
  await p3.ready;
  ok(late.object.parent === null && !props2.has(r3.id), 'a model that arrives after removal is discarded, never added to the scene');
  // catalog tier through the REAL ModelFetcher is synchronous and offline: 'tennis ball' -> procedural sphere, no network
  const real = new ModelFetcher({ fetch: () => { throw new Error('no network in this test'); }, caches: null });
  const props3 = new Map();
  const exec3 = new SceneExecutor({ scene, props: props3, localTile: () => tile, me: () => ({ clientId: 'c-000', name: 'Kenny', seat: 0 }), fetcher: real });
  setHands(null, pack);
  const tb = await exec3.exec('spawn_object', { kind: 'tennis ball', size_m: null, attach: 'right_hand', physics: 'default' });
  ok(tb.ok === true && tb.id === 'tennis_ball_1' && tb.model.status === 'ready' && tb.model.tier === 'catalog' && tb.size_m === 0.067 && tb.hand === 'right', `'tennis ball' -> catalog tier, synchronous: ${JSON.stringify(tb.model)} size ${tb.size_m}`);
  const tbp = exec3.resolve(tb.id), rt = 0.0335;
  const et = V(ref.P.x + ref.n.x * (rt + POCKET_GAP), ref.P.y + ref.n.y * (rt + POCKET_GAP), ref.P.z + ref.n.z * (rt + POCKET_GAP));
  ok(dist3(tbp.ball.pos, et) < 0.002 && tbp.ball.hull.segs.length === 1 && Math.abs(tbp.ball.hull.segs[0].ra - rt) < 1e-9, `seated at the pocket with r = 0.0335, exact sphere hull (${(dist3(tbp.ball.pos, et) * 1000).toFixed(2)} mm)`);
  setHands(null, null); exec3.tick(DT, tile.packs, hb()); exec3.tick(DT, tile.packs, hb());
  const B = tbp.ball.pos.clone();
  setHands(null, around(B, tbp.ball.sphere.radius));
  let held = -1;
  for (let i = 1; i <= 10; i++) { exec3.tick(DT, tile.packs, hb()); if (tbp.ball.snapshot().holdType === 'wrap') { held = i; break; } }
  ok(held > 0, `[X2] a hand wrapped around the tennis ball grips it (wrap within ${held} frames)`);
  const unk = await exec3.exec('spawn_object', { kind: '   ', size_m: null, attach: 'world_front', physics: 'default' });
  ok(unk.ok === false && /unknown kind/.test(unk.reason), `an empty kind is refused: ${JSON.stringify(unk.reason)}`);
  const noF = new SceneExecutor({ scene, props: new Map(), localTile: () => tile, fetcher: null });
  const nf = await noF.exec('spawn_object', { kind: 'rubber duck', size_m: null, attach: 'world_front', physics: 'default' });
  ok(nf.ok === false && /no model fetcher/.test(nf.reason), `fetcher:null refuses free text honestly: ${JSON.stringify(nf.reason)}`);
  setHands(null, null);
  await exec2.exec('remove_object', { target: 'all' });
  await exec3.exec('remove_object', { target: 'all' });
  ok(props2.size === 0 && props3.size === 0 && !scene.children.some(c => c === built.object), 'model props disposed and off the scene');
}

// ── static doctrine greps ([D1] / [D4] / [C1]) ─────────────────────────────────────────────────────────────
console.log('\n[static doctrine]');
{
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of ['scene-executor.js', 'hud.js', 'prop-body.js', 'model-fetch.js']) {
    const src = readFileSync(join(here, '..', 'sdk', 'game', f), 'utf8');
    const code = strip(src);
    ok(!/jointsWithin|GrabState|countNearLandmarks|gravity\s*[:=]\s*0\b/.test(code), `${f}: no jointsWithin / GrabState / gravity-off (comments stripped)`);
    ok(!/handedness|categoryName|zSign/i.test(code), `${f}: no handedness / categoryName / zSign`);
    ok(!/\.add\([^)]*mesh[^)]*\)/.test(code.replace(/scene\.add\(/g, '')) , `${f}: props are never parented under anything but the scene`);
  }
  const src = readFileSync(join(here, '..', 'sdk', 'game', 'scene-executor.js'), 'utf8');
  const behave = src.slice(src.indexOf('_behave(prop, dt, packs) {'), src.indexOf('_effectsTick(prop) {'));
  ok(behave.length > 100 && !/pos\.y\s*[+\-]?=/.test(behave) && !/\.vel\.y/.test(behave), 'seek_hand never writes y (x/z pocket attraction only)');
  ok(!/setHome|parent\s*=|\.attach\(/.test(strip(behave)), 'seek_hand never re-parents or re-homes the prop');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
