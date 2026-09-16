// WING DRIVE + FLIGHT CONTROL contract smoke — pure node, synthetic BlazePose-33
// world landmarks (raw: x = user's LEFT, y DOWN, z toward camera −).
//   · arm angles: out = 0°, up = +90°, down = −90°; forearm bend reads
//   · lean left → turn +; head turn left → yaw +
//   · fast flapping (2 Hz) charges the meter to LIFT OFF in ~chargeSec
//   · slow flapping (0.5 Hz) never lifts off; the meter drains
//   · in flight: flapping climbs, arms out glides (sinks slowly), arms down descends,
//     touchdown fires LANDED
//   node tests/wing-smoke.mjs
import { WingDrive, DragonFlightControl, FLIGHT_CFG } from '../sdk/interaction/wing-drive.js';

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (info ? '  ' + info : '')); if (!ok) fails++; };
const D2R = Math.PI / 180;

// synthetic body: shoulders at y −0.5 (0.16 apart), hips at 0; arms of length 0.3 + 0.28
// elevL/R = upper-arm angle above the shoulder line (deg); bend = forearm relative elev
function pose({ elevL = 0, elevR = 0, foreL = null, foreR = null, sweep = 0, lean = 0, headYaw = 0, facing = 0, bend = 0, armsHidden = false, hipsHidden = false, armHidden = null } = {}) {
  const P = (x, y, z) => ({ x, y, z, visibility: 1 });
  const w = new Array(33).fill(0).map(() => P(0, 0.3, 0));
  const lr = lean * D2R;                         // lean left: left shoulder DOWN (raw y up)
  w[23] = P(0.1, 0, 0); w[24] = P(-0.1, 0, 0);
  w[11] = P(0.16, -0.5 + Math.sin(lr) * 0.16, 0); w[12] = P(-0.16, -0.5 - Math.sin(lr) * 0.16, 0);
  const arm = (side, sh, e, f) => {
    const s = side === 'L' ? 1 : -1;
    const el = P(sh.x + s * 0.3 * Math.cos(e * D2R), sh.y - 0.3 * Math.sin(e * D2R), sh.z - 0.3 * Math.sin(sweep * D2R));
    const ff = f === null ? e : f;
    const wr = P(el.x + s * 0.28 * Math.cos(ff * D2R), el.y - 0.28 * Math.sin(ff * D2R), el.z);
    return [el, wr];
  };
  [w[13], w[15]] = arm('L', w[11], elevL, foreL);
  [w[14], w[16]] = arm('R', w[12], elevR, foreR);
  const hy = headYaw * D2R;                      // nose swings toward the user's left (+x) when they turn left
  w[7] = P(0.07, -0.66, 0.1); w[8] = P(-0.07, -0.66, 0.1);
  w[0] = P(Math.sin(hy) * 0.12, -0.68, 0.1 - Math.cos(hy) * 0.12);
  for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) w[i] = P(0, -0.66, 0.1);
  w[25] = P(0.1, 0.45, 0); w[26] = P(-0.1, 0.45, 0);
  w[27] = P(0.1, 0.85, 0); w[28] = P(-0.1, 0.85, 0);
  // torso facing: rotate shoulders + hips about the vertical — turned LEFT means the
  // left shoulder swings AWAY from the camera (+z)
  const fy = facing * D2R;
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24]) { const p = w[i]; const x = p.x * Math.cos(fy), z = p.z + p.x * Math.sin(fy); p.x = x; p.z = z; }
  // torso bend: shoulders (and everything above) move toward the camera (−z) and down
  const by = bend * D2R, tl = 0.5;
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) { const p = w[i]; const h = -p.y; p.y = -(h * Math.cos(by)); p.z += -(tl * Math.sin(by)) * (h / tl); }
  if (armsHidden) for (const i of [13, 14, 15, 16]) w[i].visibility = 0.1;
  if (hipsHidden) for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) w[i].visibility = 0.1;
  if (armHidden) for (const i of (armHidden === 'L' ? [13, 15] : [14, 16])) w[i].visibility = 0.1;
  return w;
}
const DT = 1 / 30;
const settle = (wd, w, n = 40) => { let s; for (let i = 0; i < n; i++) s = wd.update(w, DT); return s; };

// ── angle contracts ──
const wd = new WingDrive();
let s = settle(wd, pose({ elevL: 0, elevR: 0 }));
check('arms straight out → elev ≈ 0 both sides', Math.abs(s.L.elev) < 4 && Math.abs(s.R.elev) < 4, `${s.L.elev.toFixed(1)} / ${s.R.elev.toFixed(1)}`);
s = settle(wd, pose({ elevL: 70, elevR: -60 }));
check('left arm up reads +, right arm down reads −', s.L.elev > 60 && s.R.elev < -50, `${s.L.elev.toFixed(1)} / ${s.R.elev.toFixed(1)}`);
s = settle(wd, pose({ elevL: 0, elevR: 0, foreL: 60, foreR: 60 }));
check('forearm raised reads elevF > elev, bend ≈ 60', s.L.elevF > 50 && Math.abs(s.L.bend - 60) < 6, `elevF ${s.L.elevF.toFixed(1)} bend ${s.L.bend.toFixed(1)}`);
s = settle(wd, pose({ sweep: 40 }));
check('arms forward reads sweep +', s.L.sweep > 30 && s.R.sweep > 30, `${s.L.sweep.toFixed(1)}`);
s = settle(wd, pose({ lean: 20 }));
check('lean left reads roll +', s.roll > 12, s.roll.toFixed(1));
s = settle(wd, pose({ headYaw: 30 }));
check('head turned left reads yaw +', s.head.seen && s.head.yaw > 15, s.head.yaw.toFixed(1));
s = wd.update(null, DT);
check('no pose → invalid', !s.valid);
const lowVis = pose({ elevL: 50, elevR: 50 }); lowVis[15].visibility = 0.2;
check('one hidden wrist → still valid (that arm mirrors the other)', wd.update(lowVis, DT).valid && wd.state.armsSeen === 1);
lowVis[16].visibility = 0.2;
check('both wrists hidden → invalid', !wd.update(lowVis, DT).valid);

// ── flap → lift off ──
const run = (hz, secs, ctl, wdr, alt = () => 0, ampDeg = 45, centre = 5) => {
  let ev = [], t = 0;
  for (let i = 0; i < secs / DT; i++) {
    t += DT;
    const e = centre + ampDeg * Math.sin(2 * Math.PI * hz * t);
    const st = wdr.update(pose({ elevL: e, elevR: e }), DT);
    const c = ctl.update(st, DT, alt(t));
    if (c.event) ev.push([+t.toFixed(2), c.event]);
  }
  return ev;
};
let ctl = new DragonFlightControl(), w2 = new WingDrive();
let ev = run(2.0, 5, ctl, w2);
check('2 Hz flapping lifts off', ctl.phase === 'flying' && ev.some(e => e[1] === 'liftoff'), JSON.stringify(ev) + ` rate ${ctl.rate.toFixed(2)} amp ${ctl.amp.toFixed(0)}`);
const tLift = ev.find(e => e[1] === 'liftoff')?.[0] ?? 99;
check('lift-off needs sustained flapping (≥ chargeSec, ≤ chargeSec+2)', tLift >= FLIGHT_CFG.chargeSec && tLift <= FLIGHT_CFG.chargeSec + 2, `at ${tLift}s`);
ctl = new DragonFlightControl(); w2 = new WingDrive();
ev = run(0.5, 6, ctl, w2);
check('0.5 Hz flapping never lifts off', ctl.phase === 'ground' && ev.length === 0, `meter ${ctl.meter.toFixed(2)} rate ${ctl.rate.toFixed(2)}`);
ctl = new DragonFlightControl(); w2 = new WingDrive();
run(2.0, 2.0, ctl, w2);
const m1 = ctl.meter;
run(0, 2.0, ctl, w2, () => 0, 0);
check('meter charges then drains when flapping stops', m1 > 0.25 && ctl.meter < 0.05, `${m1.toFixed(2)} → ${ctl.meter.toFixed(2)}`);
// low, tired flap around −40° still counts (running centre)
ctl = new DragonFlightControl(); w2 = new WingDrive();
ev = run(1.8, 5, ctl, w2, () => 0, 35, -40);
check('a low flap (centre −40°) still lifts off', ctl.phase === 'flying', `rate ${ctl.rate.toFixed(2)} amp ${ctl.amp.toFixed(0)}`);

// ── in flight ──
ctl = new DragonFlightControl(); w2 = new WingDrive();
run(2.0, 4, ctl, w2);
let climbs = [];
run(1.2, 2, ctl, w2, () => 5); climbs.push(ctl.climb);
check('flapping in flight → climb > 0', ctl.climb > 0.3, ctl.climb.toFixed(2));
run(0, 2, ctl, w2, () => 5, 0, 0);                        // arms out, still
check('arms out & still → glide (slow sink)', ctl.climb < 0 && ctl.climb > -0.5, ctl.climb.toFixed(2));
run(0, 2, ctl, w2, () => 5, 0, -70);                      // arms down
check('arms down → descend', ctl.climb <= -0.9, ctl.climb.toFixed(2));
ev = run(0, 1, ctl, w2, () => 0, 0, -70);                 // touchdown
check('touchdown → LANDED, back on the ground', ctl.phase === 'ground' && ev.some(e => e[1] === 'landed') && ctl.meter === 0, JSON.stringify(ev));
// lean steering while flying
ctl = new DragonFlightControl(); w2 = new WingDrive();
run(2.0, 4, ctl, w2);
let st; for (let i = 0; i < 40; i++) { st = w2.update(pose({ lean: 22 }), DT); ctl.update(st, DT, 5); }
check('lean left in flight → bank + (steering is the torso facing, not lean)', ctl.turn === 0 && ctl.bank > 0.4, `turn ${ctl.turn.toFixed(2)} bank ${ctl.bank.toFixed(2)}`);
for (let i = 0; i < 40; i++) { st = w2.update(pose({ lean: 3 }), DT); ctl.update(st, DT, 5); }
check('slight lean stays in the dead zone', ctl.bank === 0, ctl.bank.toFixed(2));

// ── head-only, facing, bend ──
const w3 = new WingDrive();
s = settle(w3, pose({ headYaw: 30, armsHidden: true }));
check('head turn reads even with the arms hidden (wings invalid)', !s.valid && s.head.seen && s.head.yaw > 15, `valid ${s.valid} yaw ${s.head.yaw.toFixed(1)}`);
s = settle(w3, pose({ facing: 30 }), 80);
check('torso turned left reads facing +', s.facing > 15, s.facing.toFixed(1));
s = settle(w3, pose({ facing: -30 }), 80);
check('torso turned right reads facing −', s.facing < -15, s.facing.toFixed(1));
s = settle(w3, pose({ bend: 40 }), 80);
check('torso bent forward reads bend +', s.bend > 25, s.bend.toFixed(1));
s = settle(w3, pose({}), 80);
check('upright reads bend ≈ 0', Math.abs(s.bend) < 6, s.bend.toFixed(1));
ctl = new DragonFlightControl(); w2 = new WingDrive();
run(2.0, 4, ctl, w2);
for (let i = 0; i < 80; i++) { st = w2.update(pose({ facing: 35 }), DT); ctl.update(st, DT, 6); }
check('in flight: body facing left → turn +', ctl.turn > 0.4, ctl.turn.toFixed(2));
for (let i = 0; i < 80; i++) { st = w2.update(pose({ facing: -35 }), DT); ctl.update(st, DT, 6); }
check('in flight: body facing right → turn −', ctl.turn < -0.4, ctl.turn.toFixed(2));
for (let i = 0; i < 80; i++) { st = w2.update(pose({ bend: 40 }), DT); ctl.update(st, DT, 6); }
check('in flight: bend forward → dive, sinks faster than a glide', ctl.dive > 0.5 && ctl.climb < -0.6, `dive ${ctl.dive.toFixed(2)} climb ${ctl.climb.toFixed(2)}`);
for (let i = 0; i < 80; i++) { st = w2.update(pose({}), DT); ctl.update(st, DT, 6); }
check('straighten up → dive ends, back to glide', ctl.dive === 0 && ctl.climb < 0 && ctl.climb > -0.5, `dive ${ctl.dive} climb ${ctl.climb.toFixed(2)}`);
ctl = new DragonFlightControl(); w2 = new WingDrive();
for (let i = 0; i < 80; i++) { st = w2.update(pose({ bend: 40 }), DT); ctl.update(st, DT, 0); }
check('on the ground a bend is not a dive', ctl.dive === 0 && ctl.phase === 'ground');

// ── UPPER-BODY FALLBACK: hips / legs out of frame must not stall the game ──
const w4 = new WingDrive();
s = settle(w4, pose({ elevL: 60, elevR: 60, hipsHidden: true }));
check('hips hidden → still valid, arm elevation reads', s.valid && !s.hipsSeen && s.L.elev > 50 && s.R.elev > 50, `valid ${s.valid} elev ${s.L.elev.toFixed(1)}`);
s = settle(w4, pose({ facing: 30, hipsHidden: true }), 80);
check('hips hidden → facing still steers', s.facing > 15, s.facing.toFixed(1));
s = settle(w4, pose({ bend: 40, hipsHidden: true }), 80);
check('hips hidden → bend read from shoulders→head', s.bend > 25, s.bend.toFixed(1));
s = settle(w4, pose({ hipsHidden: true }), 80);
check('hips hidden → upright reads bend ≈ 0', Math.abs(s.bend) < 6, s.bend.toFixed(1));
ctl = new DragonFlightControl(); w2 = new WingDrive();
{ let t = 0, ev = [];
  for (let i = 0; i < 5 / DT; i++) { t += DT; const e = 5 + 45 * Math.sin(2 * Math.PI * 2.0 * t); const c = ctl.update(w2.update(pose({ elevL: e, elevR: e, hipsHidden: true }), DT), DT, 0); if (c.event) ev.push(c.event); }
  check('hips hidden → fast flapping still lifts off', ctl.phase === 'flying' && ev.includes('liftoff'), JSON.stringify(ev)); }
s = settle(new WingDrive(), pose({ elevL: 70, elevR: -70, armHidden: 'R' }));
check('one arm hidden → it mirrors the visible arm', s.valid && s.armsSeen === 1 && s.R.elev > 60, `armsSeen ${s.armsSeen} R.elev ${s.R.elev.toFixed(1)}`);
s = settle(new WingDrive(), pose({ elevL: 70, elevR: 70, armsHidden: true }));
check('both arms hidden → invalid (head still reads)', !s.valid && s.head.seen);

console.log(fails ? `\n${fails} FAILED` : '\nall wing contracts hold');
process.exit(fails ? 1 : 0);
