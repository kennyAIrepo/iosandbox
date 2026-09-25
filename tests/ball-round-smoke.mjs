// ball-round: the launch solver is exact against the page's integrator, the goal
// test reads a swish and rejects a rim-out, the round walks GO → INCOMING → CAUGHT
// → SHOT → GOAL and loops, and the call gesture needs a STILL, OPEN hand.
import { solveLaunch, flyPath, goalTest, launchOrigin, BallRound, CallGesture } from '../sdk/game/ball-round.js';

let pass = 0, fail = 0;
const ok = (name, c, info = '') => { if (c) { pass++; console.log('  ok   ' + name + (info ? '  — ' + info : '')); } else { fail++; console.log('  FAIL ' + name + (info ? '  — ' + info : '')); } };

console.log('[launch solver]');
{
  const from = { x: 0, y: 2.7, z: -4 }, to = { x: 0.3, y: 1.2, z: 0.2 };
  const opts = { g: -9.0, drag: 0.996, dt: 1 / 60, T: 1.15 };
  const v = solveLaunch(from, to, opts);
  const path = flyPath(from, v, { ...opts, steps: v.steps });
  const end = path[path.length - 1];
  const err = Math.hypot(end.x - to.x, end.y - to.y, end.z - to.z);
  ok('lands where it was aimed under g + drag', err < 0.005, 'error ' + (err * 1000).toFixed(2) + ' mm after ' + v.steps + ' steps');
  ok('it is a lob, not a line drive', Math.max(...path.map(p => p.y)) > Math.max(from.y, to.y) + 0.1, 'apex ' + Math.max(...path.map(p => p.y)).toFixed(2) + ' m');
  const v2 = solveLaunch(from, to, { ...opts, T: 0.6 });
  ok('a shorter flight is faster', Math.hypot(v2.vx, v2.vy, v2.vz) > Math.hypot(v.vx, v.vy, v.vz));
}

console.log('[goal test]');
{
  const rim = { x: 0, y: 3.05, z: -4, r: 0.2286 };
  ok('a swish through the centre scores', goalTest({ x: 0.02, y: 3.2, z: -4.03 }, { x: 0.0, y: 2.95, z: -4.0 }, rim, 0.12));
  ok('a ball falling 30 cm wide does not', !goalTest({ x: 0.3, y: 3.2, z: -4 }, { x: 0.3, y: 2.95, z: -4 }, rim, 0.12));
  ok('rising through the plane is not a goal', !goalTest({ x: 0, y: 2.9, z: -4 }, { x: 0, y: 3.2, z: -4 }, rim, 0.12));
  ok('a frame that never reaches the plane is not', !goalTest({ x: 0, y: 3.4, z: -4 }, { x: 0, y: 3.1, z: -4 }, rim, 0.12));
  const o = launchOrigin(rim, { x: 0, y: 1.2, z: 0 }, { x: 9, y: 9, z: 9 });
  ok('launch origin sits under the rim, toward the catcher', o.y < rim.y && o.z > rim.z && Math.abs(o.x) < 1e-9, JSON.stringify(o));
  ok('…or the fallback when there is no hoop', launchOrigin(null, { x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 }).x === 9);
}

console.log('[round]');
{
  const R = new BallRound({ goT: 0.5, flightT: 1.0, catchT: 2.0, shotT: 3.0, holdCue: 1.0, auto: true });
  const ball = { pos: { x: 0, y: 0.12, z: 0 }, vel: { x: 0, y: 0, z: 0 }, held: false, r: 0.12, floorY: 0 };
  const hand = { x: 0.2, y: 1.2, z: 0.5 }, rim = { x: 0, y: 3.05, z: -4, r: 0.2286 };
  let t = 10;
  let out = R.start(t);
  ok('start → GO! with its cue', out.state === 'go' && out.big === 'GO!');
  out = R.tick(t += 0.3, ball, hand, rim);
  ok('the cue holds until goT', out.state === 'go' && !out.launch);
  out = R.tick(t += 0.3, ball, hand, rim);
  ok('then a LAUNCH order to the hand', out.state === 'incoming' && out.launch && out.launch.to.x === hand.x && out.launch.T === 1.0, JSON.stringify(out.launch));
  ball.pos = { x: 0.2, y: 1.6, z: -1 }; ball.vel = { x: 1, y: 2, z: 2 };
  out = R.tick(t += 0.8, ball, hand, rim);
  ok('INCOMING while it flies', out.state === 'incoming');
  ball.held = true; ball.pos = { ...hand };
  out = R.tick(t += 0.3, ball, hand, rim);
  ok('held → CAUGHT', out.state === 'caught' && out.catches === 1);
  ball.held = false; ball.pos = { x: 0.1, y: 1.9, z: -0.5 }; ball.vel = { x: 0, y: 4, z: -4 };
  out = R.tick(t += 0.1, ball, hand, rim);
  ok('released → SHOT', out.state === 'shot');
  ball.pos = { x: 0.02, y: 3.2, z: -3.98 }; out = R.tick(t += 0.5, ball, hand, rim);
  ball.pos = { x: 0.0, y: 2.9, z: -4.0 }; ball.vel = { x: 0, y: -3, z: 0 }; out = R.tick(t += 0.05, ball, hand, rim);
  ok('through the rim → GOAL, score 1, streak 1', out.state === 'goal' && out.score === 1 && out.streak === 1 && out.shots === 1, out.state + ' ' + out.score);
  out = R.tick(t += 1.1, ball, hand, rim);
  ok('auto: the next round starts by itself', out.state === 'go' && out.rounds === 2);
  // a dropped catch
  out = R.tick(t += 0.6, ball, hand, rim);
  ok('second launch order', out.state === 'incoming' && !!out.launch);
  ball.held = false; ball.pos = { x: 0.5, y: 0.12, z: 0.4 }; ball.vel = { x: 0, y: 0, z: 0 };
  out = R.tick(t += 1.6, ball, hand, rim);
  ok('resting on the floor after arrival → DROPPED, streak reset', out.state === 'lost' && out.streak === 0, out.state);
  // a rim-out
  out = R.tick(t += 1.1, ball, hand, rim); out = R.tick(t += 0.6, ball, hand, rim);
  ball.held = true; out = R.tick(t += 0.2, ball, hand, rim);
  ball.held = false; ball.pos = { x: 1, y: 2, z: -2 }; ball.vel = { x: 0, y: 3, z: -3 }; out = R.tick(t += 0.1, ball, hand, rim);
  ball.pos = { x: 1, y: 0.12, z: -4 }; ball.vel = { x: 0, y: 0, z: 0 };
  out = R.tick(t += 0.7, ball, hand, rim);
  ok('a shot that comes to rest elsewhere → MISS, shots 2', out.state === 'miss' && out.shots === 2 && out.score === 1, out.state + ' shots ' + out.shots);
  const R2 = new BallRound({ goT: 0.1 });
  R2.start(0); const o2 = R2.tick(0.5, ball, null, rim);
  ok('no hand in view: GO! waits instead of launching into nothing', o2.state === 'go' && !o2.launch);
  ok('stop → idle', R2.stop(1).state === 'idle' && !R2.on);
}

console.log('[call gesture]');
{
  const C = new CallGesture({ hold: 0.7, still: 0.04, open: 0.3, refractory: 2 });
  const p = { x: 0, y: 1, z: 0 };
  let fired = false;
  for (let t = 0; t <= 0.6; t += 0.1) fired = C.tick('right', p, 0.1, t) || fired;
  ok('not yet at 0.6 s', !fired);
  fired = C.tick('right', p, 0.1, 0.75);
  ok('fires once the open hand has held still 0.7 s', fired);
  ok('…and not again inside the refractory', !C.tick('right', p, 0.1, 1.5));
  const C2 = new CallGesture({ hold: 0.7, still: 0.04 });
  let f2 = false;
  for (let t = 0; t <= 1.2; t += 0.1) f2 = C2.tick('right', { x: t * 0.2, y: 1, z: 0 }, 0.1, t) || f2;
  ok('a moving hand never calls', !f2);
  const C3 = new CallGesture({ hold: 0.7 });
  let f3 = false;
  for (let t = 0; t <= 1.2; t += 0.1) f3 = C3.tick('right', p, 0.9, t) || f3;
  ok('a fist never calls', !f3);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
