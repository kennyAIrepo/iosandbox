// voice-commands: the grammar matches whole words (never "basketball" → ball),
// longer phrases win, a rolling interim/final result list fires each command ONCE,
// the cooldown swallows echoes, and a recogniser restart re-arms the slots.
import { normalize, matchCommand, parseResults, GRAMMAR } from '../sdk/game/voice-commands.js';

let pass = 0, fail = 0;
const ok = (name, c, info = '') => { if (c) { pass++; console.log('  ok   ' + name + (info ? '  — ' + info : '')); } else { fail++; console.log('  FAIL ' + name + (info ? '  — ' + info : '')); } };

console.log('[grammar]');
ok('normalize strips case and punctuation', normalize('  Ball!!  PLEASE, ') === 'ball please');
ok('"ball" → ball', matchCommand('ball')?.cmd === 'ball');
ok('"the ball" → ball (whole word inside a phrase)', matchCommand('give me the ball now')?.cmd === 'ball');
ok('"basketball" does NOT fire ball', matchCommand('basketball') === null);
ok('"pass it" → ball, the longer phrase', matchCommand('pass it')?.cmd === 'ball' && matchCommand('pass it')?.phrase === 'pass it');
ok('a common mishear ("paul") still calls the ball', matchCommand('paul')?.cmd === 'ball');
ok('"let\'s go" → go', matchCommand("let's go")?.cmd === 'go');
ok('"stop" → stop · "hoop" → hoop · "reset" → drop', matchCommand('stop')?.cmd === 'stop' && matchCommand('hoop')?.cmd === 'hoop' && matchCommand('reset')?.cmd === 'drop');
ok('the LAST command in an utterance wins', matchCommand('go ball')?.cmd === 'ball' && matchCommand('ball go')?.cmd === 'go');
ok('nothing → null', matchCommand('hello there') === null && matchCommand('') === null);
ok('the mirror props by name: cube · rug · slime · bow', matchCommand('cube')?.cmd === 'cube' && matchCommand('the rug')?.cmd === 'rug' && matchCommand('slime')?.cmd === 'slime' && matchCommand('bow and arrow')?.cmd === 'bow' && matchCommand('glass ball')?.cmd === 'slime');
ok('every grammar phrase matches itself', Object.entries(GRAMMAR).every(([c, ps]) => ps.every(p => matchCommand(p)?.cmd === c)));

console.log('[rolling results]');
{
  const S = { fired: new Map(), last: new Map() };
  let out = parseResults([{ transcript: 'ba', isFinal: false }], S, { now: 0 });
  ok('an interim fragment fires nothing', out.length === 0);
  out = parseResults([{ transcript: 'ball', isFinal: false }], S, { now: 0.2 });
  ok('the interim "ball" fires once', out.length === 1 && out[0].cmd === 'ball' && !out[0].final);
  out = parseResults([{ transcript: 'ball', isFinal: true }], S, { now: 0.5 });
  ok('the FINAL of the same slot does not fire again', out.length === 0);
  out = parseResults([{ transcript: 'ball', isFinal: true }, { transcript: 'ball', isFinal: false }], S, { now: 0.9 });
  ok('a new slot inside the cooldown is swallowed', out.length === 0);
  out = parseResults([{ transcript: 'ball', isFinal: true }, { transcript: 'ball yes', isFinal: true }, { transcript: 'ball', isFinal: false }], S, { now: 2.5 });
  ok('after the cooldown a new slot fires again', out.length === 1 && out[0].slot === 2, JSON.stringify(out));
  out = parseResults([{ transcript: 'ball', isFinal: true }, { transcript: 'ball yes', isFinal: true }, { transcript: 'ball stop', isFinal: true }], S, { now: 2.6 });
  ok('a slot that grows into a different command fires that command', out.length === 1 && out[0].cmd === 'stop', JSON.stringify(out));
  S.fired.clear();
  out = parseResults([{ transcript: 'ball', isFinal: false }], S, { now: 5 });
  ok('a recogniser restart (slots cleared) re-arms', out.length === 1 && out[0].cmd === 'ball');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
