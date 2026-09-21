# HoloHands mode — the page-side hook for teamslab.html

`sdk/game/twin-ui.js` now owns the HoloHands mode control (button between Camera and Mic, `H` key, Layers
"Holohands" checkbox, `hopeos.holohands` persistence, `'holohands'` CustomEvent). The page owns the truth about
*which interactions currently need collision / realism* and applies the result to the rigs. Paste the block below
at the `<!-- HH -->` spot (after `ui`, `S` and `applyHandsLayer` exist — i.e. next to `bindControls()`).

## Policy (implemented by `computeHoloHandsShown`)

| mode | rigs shown when |
|---|---|
| `auto` (default) | at least one interaction is active: the ball in / arriving at the tile, a spawned or held prop, drawing, hugging, shaking hands |
| `on` | always |
| `off` | never |

Someone who only opens the call to react with gestures (two-hand heart -> heart emoji) sees no overlay: the gesture
detector reads landmarks, never the rigs, so reactions work in every mode.

## The hook (paste verbatim)

```js
// <!-- HH --> HoloHands mode: twin-ui owns the control, the page owns the interaction list and the rigs.
import { computeHoloHandsShown, HOLOHANDS_FADE_MS } from './sdk/game/twin-ui.js';   // (or add to the existing import)
const HH = { active: new Set(), shown: null };
function holoActive(name, on) { if (on) HH.active.add(name); else HH.active.delete(name); applyHoloHands(); }   // 'ball' | 'prop' | 'draw' | 'hug' | 'handshake'
function applyHoloHands() {
  const shown = computeHoloHandsShown(ui.holoHandsMode, [...HH.active]);            // AUTO: active.size > 0 · ON: true · OFF: false
  if (shown === HH.shown) return; HH.shown = shown;
  layers.hands = ui.holoHandsMode !== 'off';                                          // keep the old flag honest for anything still reading it
  for (const t of S.tiles.values()) applyHandsLayer(t);
  ui.setHoloHandsShown(shown);                                                        // aria-pressed + caption + '· hands hidden' pill suffix
}
ui.addEventListener('holohands', applyHoloHands);                                     // button / H key / checkbox / ui.setHoloHands()
applyHoloHands();
```

Then change `applyHandsLayer(t)` to read the computed value instead of the raw layer flag, with the 400 ms fade:

```js
function applyHandsLayer(t) {
  const on = HH.shown === true;                                                       // was: layers.hands
  for (const rig of [t.pipe && t.pipe.rigR, t.pipe && t.pipe.rigL, t.remote && t.remote.rigR, t.remote && t.remote.rigL]) if (rig && rig.grp) fadeRig(rig, on);
}
function fadeRig(rig, on) {                                                           // 400 ms opacity ramp (HOLOHANDS_FADE_MS), reduced motion snaps
  const ms = ui.reducedMotion ? 0 : HOLOHANDS_FADE_MS, t0 = performance.now(), from = rig._hhAlpha ?? (rig.grp.visible ? 1 : 0), to = on ? 1 : 0;
  if (on) rig.grp.visible = true;
  cancelAnimationFrame(rig._hhRaf);
  const step = () => { const k = ms ? Math.min(1, (performance.now() - t0) / ms) : 1, a = from + (to - from) * k; rig._hhAlpha = a;
    rig.grp.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = a; } });
    if (k < 1) rig._hhRaf = requestAnimationFrame(step); else if (!on) rig.grp.visible = false; };
  step();
}
```

## Where to call `holoActive(name, on)`

* `'ball'` — on `game` events: `on` when the ball is in this tile or launched toward it (`BallNet` incoming / `INCOMING`
  ring), `off` when it left and nothing is in transit; `game.stop()` / `reset` -> off.
* `'prop'` — `SceneExecutor` `spawn_object` -> on while `S.props.size > 0`; `remove_object` of the last prop -> off.
* `'draw'`, `'hug'`, `'handshake'` — from their detectors when they land (none exist in this build; the names are
  reserved in `HOLOHANDS_INTERACTIONS`).

## Things the integrator must know

* **`H` now cycles HoloHands; the Latency HUD toggle moved to `L`** (`KEY_ACTIONS.KeyL = 'hud'`). The page's
  `case 'hud':` in `bindKeys` keeps working unchanged (it is fired by L). Update the About dialog line
  `<kbd>H</kbd> HUD` to `<kbd>H</kbd> HoloHands · <kbd>L</kbd> HUD`.
* The `onKey` switch receives a new action `'holohands'` (keydown + keyup); it needs no case — twin-ui cycles the
  mode itself and emits `'holohands'`.
* `bindPanel`'s `'layer'` event for `hands` still fires on the checkbox (registered first), then `'holohands'`
  fires; with the hook above the last word is always `applyHoloHands()`. `setLayer('hands', on)` may keep calling
  `applyHandsLayer` — it is harmless once that function reads `HH.shown`. To set the mode from code use
  `ui.setHoloHands('auto' | 'on' | 'off')` (never poke the checkbox).
* `ui.holoHandsShown` is what aria-pressed shows; `ui.setHoloHandsActive([...])` is an alternative to
  `setHoloHandsShown` that lets twin-ui compute `shown` from your list (same policy).
* The button is injected at `bindControlBar()` time as `#btnHoloHands` (`.cbtn.cbtn--holo`); nothing to add to the
  HTML. On the narrow bar it is 36 px wide so 9 buttons still fit 390 px (386 px used).
* Persistence: `localStorage['hopeos.holohands']` = `auto | on | off`; the value is read in the `TwinUI` constructor
  and applied before any event, so `?shell=1` shows the stored caption too.
* The `'holohands'` CustomEvent detail is `{ mode, prev, shown, source: 'api'|'button'|'key'|'checkbox', fadeMs: 400 }`.
