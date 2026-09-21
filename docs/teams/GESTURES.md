# Gesture reactions — raise hand, applause, like, wave, heart

Hand gestures detected on a tile's own landmarks become the same reactions people click in Teams, without the
click. This page is the contract for `sdk/game/gesture-reactions.js` (detectors), `sdk/game/reaction-fx.js`
(in-tile visuals + aria-live), the `REACTION 0x32` packet in `sdk/net/hand-stream.js`, and the mapping onto the
Microsoft surfaces. Verified by `node tests/gesture-smoke.mjs` (confusion matrix, hold times, cooldown, wire round
trip, event origins, µs per frame).

## 0. Gesture reactions never require the HoloHands overlay

Said plainly: **no gesture reaction needs the HoloHands overlay (the hand mesh + collision rigs) to be on.** The
detector reads the tile's landmarks (`packs`), never the rigs, and the emoji is placed from those same landmarks.
HoloHands has its own three-state control (`Auto | On | Off`, `H`, the control-bar button, the Layers checkbox —
`docs/teams/HOLOHANDS-HOOK.md`); in `Auto` the overlay appears only while something needs collision or realism (the
ball, a prop, drawing, a hug, a handshake). A participant who opens the call just to make a two-hand heart gets the
heart emoji rising from between their hands and never sees the overlay. `Off` is the same: reactions keep working.

## 1. What fires, and what has to be true for it to fire

The detector reads the packs every tile already resolves (`TilePipeline.packs` / `RemoteTile.packs` =
`HandViews.resolve`: `{ R, L, hands:[{ mesh, slot, points, img }] }` — 21 world points in metres, mirror space, y up,
plus the normalised selfie-mirrored landmarks with y down). When the body layer runs, its 33 mirrored world points
(`BodyLayer.pts`) replace the fixed tile fraction with the shoulder line. Nothing reads a handedness label and no
z sign is hard-coded: the inner side of the palm is MEASURED per pack with the same maths as `PropBall._holdPose`
(thumb column volar of the knuckle plane + fingertip curl, decay-latched per slot); chirality never enters.

| gesture | conditions (all, every frame) | hold / count | event |
|---|---|---|---|
| RAISE_HAND | open hand (`closure` < 0.25, keep < 0.35) · inner palm facing the camera (normal · to-camera > 0.30, keep > 0.10) · wrist in the tile's upper 38 % (`img[0].y` < 0.38, keep < 0.44) **or** above the shoulder line + 2 cm when a pose is given · wrist still (< 0.3 m/s) | held 2.5 s | `{ kind:'raise', on:true, slot }` |
| (lowered) | any of the above false, or the hand lost | 1.5 s continuous | `{ kind:'raise', on:false }` — never suppressed by cooldown |
| CLAP | both hands present · palm-centre distance drops below 0.09 m **from above 0.22 m** (re-armed only after it opens past 0.22 m again) | 2 such crossings within 1.6 s | `{ kind:'applause' }` |
| THUMBS_UP | thumb tip (joint 4) the highest joint by ≥ 2 cm · other fingers closed (`closure` > 0.7) | held 0.8 s | `{ kind:'like', slot }` |
| WAVE | open hand (`closure` < 0.35) · wrist lateral velocity reverses sign, each swing between reversals > 0.08 m, velocity dead-band 0.12 m/s · the other hand is not moving against it (mirror motion = clapping) | ≥ 3 reversals within 1.5 s | `{ kind:'wave', slot }` |
| HEART | both hands · index tips within 5 cm · thumb tips within 5 cm · palm centres ≥ 0.10 m apart (a clap has them together) | held 0.3 s | `{ kind:'love' }` |

Every event also carries **`origin = { x, y }`** in tile-normalised coordinates (0..1, x right, y down, from the
`img` landmarks the detector already holds, clamped to the tile) — where the emoji starts:

| kind | origin |
|---|---|
| `love` (heart) | midpoint of the two index tips (`img[8]` of both hands) |
| `applause` | midpoint of the two palm centres (`(img[0] + img[9]) / 2` per hand) |
| `like` (thumbs-up) | thumb tip (`img[4]`) |
| `wave`, `raise` on | wrist (`img[0]`) |
| `raise` off (lowered) | the last wrist seen — the hand is usually gone by then |

`origin` is `null` when the hand entry has no `img` (synthetic packs: the bots' `img: null`); the visuals then fall
back to the tile's bottom-left. The origin object is the only extra allocation and is rate-limited by the cooldown.

Cooldown: 3 s per kind per tile (`GestureDetector.suppressed` counts the attempts it swallowed). A wrist moving
faster than 0.3 m/s resets the raise hold, so a high wave is a wave, never a raise. Every threshold is a key of
`GESTURE_DEFAULTS` and can be overridden in the constructor. When the palm side has not latched yet (the first
frames of a hand, or a pack with no volar evidence) the *plane* of the palm must face the camera; once latched, the
inner side must. Per-frame cost measured by the smoke test: ~1 µs (two hands), zero allocations in the update path.

```js
import { GestureDetector } from './sdk/game/gesture-reactions.js';
const det = new GestureDetector({ camera: tile.cam, onEvent: ev => { /* ev = { kind, code, on, slot, t, origin } */ } });
// per frame, after the tile resolved its packs (and, when present, the body layer ticked):
det.update(clock.now(), tile.packs, bodyLayer ? bodyLayer.pts : null);
```

## 2. Visuals and accessibility (`reaction-fx.js`)

* **Floating emoji** — one `.rx-overlay` per tile (inside `.tile__chrome`, pointer-events none). Each reaction is a
  span that starts at the event's **origin** (`fx.float(tileEl, kind, { origin })`: the heart between the index tips,
  the thumbs-up on the thumb, the wave / raise on the wrist — `originToCss()` centres the glyph on the point and keeps
  it 12 px inside the overlay), rises a short way (28 % of the tile height, so it stays near the hands), drifts
  sideways and fades over 2.2 s, on compositor-only CSS transform/opacity keyframes (no per-frame JS). With
  `origin: null` (menu reactions, legacy packets, synthetic packs) it rises from the tile's bottom-left as before.
  At most 6 alive per tile; the oldest is removed when a 7th arrives. Under `prefers-reduced-motion`, the frame's
  `data-reduced-motion="true"`, or `TwinUI.reducedMotion`, the emoji fades in place instead of moving — at the origin
  when there is one; the reduced-motion behaviour is otherwise unchanged.
* **"Hand raised" pill** — the tile template's existing `.tile__raised` pill and gold ring (`.tile.is-raised`,
  teamslab.css:99, :109-110; nothing restyled). With a `TwinUI` the pill is set through
  `ui.setTileState(clientId, { raised })` so the UI state stays authoritative; without one the class is toggled.
* **aria-live** — one sentence per event (`announcement(ev, name)`: "Ana raised a hand", "Ana lowered their hand",
  "Bo is clapping", "Bo gave a thumbs up", "Bo sent a heart", "Bo waved"), via `ui.announce` (throttled to one message
  per 2 s per region) or straight into `#live-polite`.

```js
import { ReactionFx } from './sdk/game/reaction-fx.js';
const fx = new ReactionFx({ ui });                     // ui optional
det.onEvent = ev => { fx.react(tileEl, ev, name); transport.send(encodeReaction(me.seat, ev.kind, ev.t, seq++, clock.now(), ev), { reliable: true }); };   // ev carries on, slot, origin
// receiving side: on readHeader(buf).type === PK_REACTION -> const r = decodeReaction(buf); fx.react(tileFor(r.seat), r, nameFor(r.seat));   // r.origin restored (or null)
```

## 3. Wire: `REACTION 0x32` (18 B; legacy 16 B accepted)

`0x30` is `HAND_STREAM` and `0x31` is the reserved POSE33 extension (hopeos-wire.md §2), so the reaction packet takes
the next free code. Existing layouts are untouched; `BallNet`, `RemoteHands` and `Room` already fall through on
unknown types.

| off | field | notes |
|---|---|---|
| 0-7 | header | type `0x32`, flags\|ver, seq u16 (per sender), t u32 = session-clock ms when sent |
| 8 | kind u8 | `RX_KIND`: 1 raise · 2 applause · 3 like · 4 wave · 5 love · 6 laugh · 7 surprised |
| 9 | seat u8 | sender's seat (0..254) |
| 10 | state u8 | bit0 = on (raise: 1 raised / 0 lowered; other kinds 1) · bit1 = slot (0 left, 1 right) · **bit2 = origin present** |
| 11 | reserved | 0 |
| 12-15 | ts u32 | session-clock ms of the detection (the frame the gesture completed) |
| 16 | origin x u8 | tile-normalised x × 255 (0..1 → 0..255) — v1.1, 2026-09-21 |
| 17 | origin y u8 | tile-normalised y × 255, y down; step 1/255 = 0.4 % of the tile (≈ 2 px at 480 px) |

`encodeReaction(seat, kind, tsMs, seq, tMs, { on, slot, flags, origin })` always writes 18 B (`RX_BYTES`); with no
`origin` (or a NaN one) bit2 is clear and bytes 16-17 are 0. `decodeReaction(buf)` returns `origin = { x, y }` when
bit2 is set and the packet is 18 B, else `origin = null` — so a **legacy 16 B packet** (`RX_BYTES_LEGACY`) from a
pre-origin sender decodes with every field and `origin: null`; anything under 16 B is still `RangeError` truncated.
Send reliable when the transport has it — at most one per kind per 3 s per sender, so the cost is nil.

## 4. Mapping onto the Microsoft surfaces

### C3 — ACS participant (`docs/teams/acs-client.html`): the real Teams reaction, from the calling SDK

The Azure Communication Services Calling SDK exposes both as call features on the `Call` / `TeamsCall` object:

* **Raise hand** — `const raiseHand = call.feature(Features.RaiseHand); await raiseHand.raise(); await raiseHand.lower();`
  plus `raiseHand.getRaisedHands()` and the `raisedHandEvent` / `loweredHandEvent` events for the roster.
  (Learn: <https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/raise-hand>.)
* **Reactions** — `const reaction = call.feature(Features.Reaction); await reaction.sendReaction({ reactionType: 'like' });`
  with `reactionType` one of `'like' | 'heart' | 'laugh' | 'applause' | 'surprised'` and the `reaction` event for
  incoming ones. (Learn: <https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/reactions>.)
  Reactions are supported on Teams interop calls when the Teams meeting policy allows them.

Mapping from our detector events:

| our kind | ACS call | note |
|---|---|---|
| `raise` on / off | `Features.RaiseHand` `raise()` / `lower()` | the real Teams raised-hand state, visible to everyone in the meeting |
| `applause` | `sendReaction({ reactionType: 'applause' })` | |
| `like` | `sendReaction({ reactionType: 'like' })` | |
| `love` | `sendReaction({ reactionType: 'heart' })` | our wire name is `love` (RX_KIND 5); the ACS string is `heart` |
| `laugh` / `surprised` | `sendReaction({ reactionType: 'laugh' \| 'surprised' })` | no gesture detector yet — reserved codes 6 / 7 for a face-expression source |
| `wave` | none | Teams has no wave reaction; overlay-only (`OVERLAY_ONLY` in gesture-reactions.js) |

Keep the same 3 s cooldown before calling the SDK, and never call `raise()` when `getRaisedHands()` already lists
us (the SDK rejects duplicates).

### C2 — video-effect app and D — meeting-stage app: there is NO public API for Teams' own buttons

Neither the Teams video-effect (AR filter) app surface nor the meeting-stage / side-panel app (TeamsJS `meeting`
namespace, Live Share) exposes a way to press Teams' own **Raise** or **React** buttons on behalf of the user: the
TeamsJS SDK has no raise-hand or reaction API, the video-effect host only hands the app video frames, and nothing in
the manifest permission set reaches the meeting's reaction state. Saying it plainly: from those two surfaces a
detected gesture cannot light up the real Teams hand icon on the roster.

The fallback on those surfaces is the **in-tile overlay** of §2: the detector runs locally, the event travels on
`REACTION 0x32` over the same relay as the hand packets, and every hopeOS client draws the floating emoji, the gold
"Hand raised" pill and ring on that participant's tile in *our* gallery, with an aria-live sentence. On the stage app
that is the shared stage every attendee sees; on the video-effect app it is drawn into the outgoing video frame
(`effect-core.js`), so the emoji reaches the Teams gallery as pixels — which is also how the user's own hand-raise
pill reaches people who are not running hopeOS. It is a visual twin of the Teams reaction, not the Teams reaction.

## 5. Tests

`node tests/gesture-smoke.mjs` (Node, no browser) drives synthetic packs from `sdk/game/pack-gen.js` through the
same `packToHands` projection the bots use, on fresh detectors:

* (i) confusion matrix — five scripts, each fires only its own kind (off-diagonal all zero);
* (ii) hold times — raise at 2.4 s no, 2.6 s yes (fires at exactly 2500 ms); like at 0.7 s no, 0.9 s yes; lowered
  event 1.5 s after the hand left; one clap alone is not applause; waving high is a wave, not a raise; with a pose
  the shoulder line decides;
* (iii) cooldown — second like within 3 s suppressed, third after 3 s fires;
* (iv) wire — 18 B round trip, header demux, `decodeHandStream` and `RemoteHands` reject / ignore 0x32;
* (v) timing — µs per `update()` frame with two hands (< 100 µs required, ~1 µs measured);
* (vi) `reaction-fx.js` parses;
* (vii) origins — every kind's event has an origin inside 0..1 equal to the expected landmark (recomputed from the
  same script at the event's `t`), the heart between the wrists and above them, the lowered raise reusing the last
  wrist, `img: null` -> `origin: null`, overshoot clamps; packet round trip with and without origin (within 1/510),
  legacy 16 B decode -> `origin: null`; `originToCss` placement (bottom-left fallback, centring, edge clamping).

Real-hand thresholds were chosen from MediaPipe world-landmark scale (palm span ≈ 0.10 m, hand span ≈ 0.19 m at the
hand plane); tune `GESTURE_DEFAULTS` from the `?clip=` fixtures before shipping to a tenant.
