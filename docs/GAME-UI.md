# GAME UI — cues, round bar, banner (template under test)

`sdk/game/game-cues.js` is the one place game state reaches the screen. It is a
**component with tokens**, not a page's HUD: every lane — engine or mirror, ball,
cube, bow, beat, twins — cues the same way, and the look is changed in one file (or
by theme variables), never by editing a lane.

Status: **template under test** (2026-09-25). Wired into: the engine 🏀 hoop round
(all phases, with the catch and throw glyphs), voice in both lanes ("ball" →
CATCH!), the engine + mirror basketball (caught / thrown), BEAT RUSH (start /
over), the bow (shot). Once approved it becomes the guardrail: no ad-hoc toasts for
game state.

## The three parts

| part | what | when |
|---|---|---|
| **cue** | the call-out — `GO!`, `INCOMING!`, `AIM!`, `GOAL!` — pops in the centre, holds, fades in ~1.7 s; one at a time | every game moment |
| **bar** | the round bar at the top: `round n` · phase label · score, with a timer that **drains** over the phase | while a round runs |
| **banner** | the game tag, top-left: icon · name · hint | while a game is on |

```js
import { GameCues, MOMENTS, GAME_UI } from './sdk/game/game-cues.js';
const CUES = new GameCues({ id: 'engBall' });          // ids: engBallHud, engBallCue, engBallPhase, engBallFill …

CUES.banner({ icon: '🏀', title: 'HOOP ROUND', hint: 'catch · aim · shoot' });
CUES.cue('start');                                      // a MOMENTS key → "GO!", hot
CUES.cue('INCOMING!', 'open your hand where it lands', 'cool');
CUES.bar({ round: 3, label: 'INCOMING', right: '2 goals · streak 2 · best 4', phase: 0.35, cool: true });
CUES.hideBar(1800); CUES.hideBanner(1800);              // after the last cue fades
```

## Gesture glyphs

A cue that asks the player to DO something with their hands carries a **gesture
glyph** above the word: drawn, animated line art in the cue's colour — never an
emoji. `catch` (two open hands cup up, the ball drops in, the hands close a
touch), `throw` (a hand pushes the ball up the arc to a small ring), `call` (an
open palm, rings settling onto it), `listen` (the microphone with sound waves).

```js
CUES.cue('CATCH!', 'open your hands — it lands in your palm', 'cool', { gesture: 'catch', ms: 1900 });
CUES.cue('catch');     // the MOMENTS key carries its gesture
```

## Voice

`sdk/game/voice-commands.js` — the microphone listens continuously
(SpeechRecognition, auto-restart on silence); a small grammar fires commands; the
banner's **voice pill** shows the state (pulsing while listening, with your voice
level) and what it heard. Both panels carry the same block: **🎙 LISTEN / ■ STOP**,
a status line ("● listening · heard “…” → BALL"), and command **chips** that run
the same pipeline the mic fires (`VOICE.inject`), so nothing is mic-only. V toggles.

- engine: **"ball"** → the ball flies to your hands, `CATCH!` with the catch glyph ·
  "go" (a round; also opens the mic) · "stop" · "hoop" · "drop"
- mirror: **"ball"** → the basketball flies to your holo hands · "cube" · "rug" ·
  "slime" · "bow" spawn by name · "go" / "stop" BEAT RUSH · "drop"

```js
CUES.voice({ state: 'listening', heard: 'give me the ball', cmd: 'ball', level: 0.4 });
```

## Tokens (`GAME_UI`)

Colour is by **meaning**, not by lane:

| kind | colour | use |
|---|---|---|
| `hot` | orange `#ffb15d` | the moment — `GO!`, `GOAL!` |
| `cool` | cyan `#9ff0ff` | system / motion — `INCOMING!`, `ROUND OVER` |
| `good` | green `#a6ff5d` | you did it — `CAUGHT ✓`, `HIT!` |
| `warn` | amber `#ffe08a` | do it now — `AIM!`, `SHOOT!`, `DRAW` |
| `bad` | red `#ff8a8a` | you missed — `MISS`, `DROPPED` |

Timing: cue life 1.7 s (pop-in 12 %, hold to 70 %, fade), bar eases 120 ms, banner
fades 250 ms. Type: cue `clamp(44px, 9vw, 96px)` at weight 900, bar/banner 12–13 px
uppercase tracked. Layout: bar `min(560px, 92vw)` at the top, cue at 34 vh, z 30.

Every token is a `--gc-*` CSS variable on the root, so a theme re-skins with
`CUES.theme({ hot: '#f80', panel: 'rgba(0,0,0,.5)' })` or plain CSS.

## Rules (the guardrail once approved)

1. Game state never goes through `toast()`; it goes through `cue` / `bar` / `banner`.
2. Use the shared **MOMENTS** names (`start`, `incoming`, `caught`, `aim`, `shoot`,
   `goal`, `hit`, `miss`, `dropped`, `thrown`, `over`) so the same event reads the
   same in every lane.
3. One cue at a time; a new phase is one cue. Never a static panel that stays.
4. The bar drains with a real timer (`phaseT` from the state machine) — never a
   decorative animation.
5. Nothing here takes pointer events; the engine's orbit, gizmo and panels keep
   working under every cue.

Probe: `tests/_engplayprobe.mjs` (the cue pops, the bar drains, the cue fades, the bar stays).
