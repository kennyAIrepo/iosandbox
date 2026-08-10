# I AM LIZARD — system plan

Game experiment: you ARE a lizard. Your face drives the lizard's face; opening your
mouth arms the tongue; your hand aims it; a flick fires it. Catch flies, then fruit.

Separate system from the avatar studio. The avatar rig pipeline stays FROZEN —
the lizard is a new page (`lizard.html`) that consumes the SDK only.

## 1. What the stack already has (nothing cloud-side is needed)

Real-time tracking in this stack is ALREADY embedded and local — MediaPipe
tasks-vision 0.10.18, WASM + WebGL GPU delegate, running in the browser:

| Piece | Where | Status |
|---|---|---|
| Camera (single getUserMedia, cloned) | `sdk/core/tracking.js` initCamera | done |
| Hands: 21 landmarks ×2, GPU, VIDEO mode | `sdk/core/tracking.js` createHandLandmarker | done, proven in studio.html hand rig |
| Face: 478 landmarks + 52 blendshapes | `sdk/core/tracking.js` createFaceLandmarker | done — studio just passes `enableFace: false` |
| Face → game events (blink/smile/jawOpen/gaze/…) | `sdk/interaction/face.js` FaceExpressionDetector | done |
| Pose (body) | createPoseLandmarker | done, optional for lizard |

SAM3 / Modal cloud lane: NOT in the loop for this game. Cloud roundtrip is
~351ms inference + gap (st-45); MediaPipe local is ~15–25ms/frame on GPU.
SAM3 stays for what it's good at: offline segmentation (garment fit, own-pixels
extraction) — never real-time control.

Latency budget target: motion → pixel < 80ms (detect ~20ms + game logic ~1ms +
render 16ms + display). This is why the whole control loop is on-device.

## 2. Tracking config for the lizard  [BUILT]

```js
const tracker = await initTracking(vid, { numHands: 1, enableFace: true, faceEvery: 1, raw: true });
```

All of this landed in `sdk/core/tracking.js` (additive opts, old callers
unchanged): `enableHands:false` / `enablePose:false` for face-only pages,
`faceEvery` (default 3; use 1 when triggers are gameplay), `faceMatrix:true`
for the 4×4 head-pose matrix, and blendshapes are now unwrapped to a plain
`[{categoryName, score}]` array (fixes a latent TypeError in face.js — face
had never been switched on end-to-end before).

- `raw: true` + One-Euro filter on the hand tip (the deadband stabilizer
  stair-steps slow motion; studio already learned this).

## 2b. Trigger layer — `sdk/interaction/mouth.js`  [BUILT]

The game's face input is deliberately just two triggers, done with simple CV
(see the module header for research annotations):

- **mouth open** — Mouth Aspect Ratio (MAR): inner-lip vertical gap ÷ mouth
  width, landmarks 13/14 ÷ 78/308. Scale-invariant, One-Euro smoothed,
  hysteresis (open >0.28, close <0.15).
- **tongue visible** — MediaPipe has no tongueOut blendshape, so: red-pixel
  ratio inside the inner-lip polygon, sampled from the video into a ≤64px
  canvas. Tongue = bright AND red-dominant; teeth = bright grey (rejected);
  open cavity = dark (rejected). Bonus output: `tongueTip` = centroid of
  tongue pixels → an aim point for free.

Events: `mouthOpen / mouthClose / tongueOut / tongueIn` + poll `mouth.state`.
Test rig: `mouthlab.html` (start camera → HUD with MAR/red-ratio bars,
polygon + tip overlay, event log). Tune the thresholds there per lighting.

## 2c. Unified access point — `sdk/interaction/puppet.js`  [BUILT]

`PuppetInput` = ONE object feeding a rigged puppet all its channels from a
single `tracker.detect()` frame per rAF (also exported via `sdk/hopeos.js`):

| Channel | Signal | Source |
|---|---|---|
| `state.mouth` | open/close + degree, tongue out/in + tip | MouthTriggers (2b) |
| `state.eyes.left/right` | per-eye open bool + 0–1 degree | eyeBlink blendshapes, hysteresis |
| `state.head` | yaw/pitch/roll in DEGREES, smoothed | face transform matrix (`faceMatrix:true`), landmark-geometry fallback |
| `state.limbs.armL/armR/legL/legR` | raised bool + raise (-1..1) + extend (0..1) + tip pos | PoseLandmarker 33-pt — the already-mature body tracking; reuses body-gestures.js anatomy |

Events: mouth's four + `eyeClose/eyeOpen(side)` + `limbRaise/limbLower(id)`.
Limb sides are anatomical; in mirrored selfie space player-left = screen-left,
so limbs map straight onto the lizard's screen-side legs. Lizard move scripts
consume `limbRaise` (step trigger) + `extend` (stride length) — that IS the
"add body tracking to the move scripts" step, no new tracking needed.
Full test rig: `puppetlab.html` (skeleton overlay + every channel as a bar).

## 3. Control mapping (face + hand → lizard)

MediaPipe's 52 blendshapes have NO true `tongueOut` (that's the one ARKit shape
it lacks — `face.js` already proxies it as jawOpen×mouthFunnel). So the tongue
is HAND-driven by design, which matches the game idea:

| Player input | Signal | Lizard |
|---|---|---|
| open mouth | MAR trigger (`mouth.js` mouthOpen) | jaw opens, tongue ARMED (can't fire with mouth shut) |
| stick tongue out | red-ratio trigger (`mouth.js` tongueOut) | tongue FIRES to target (~120ms out) — primary fire |
| hand position | index fingertip (landmark 8), One-Euro filtered | tongue TARGET reticle in world |
| fast flick / throw of hand | fingertip speed > threshold, or pinch release | alternate fire (fallback if tongue CV is unreliable in bad light) |
| hold pinch | thumb–index distance | grip: fruit needs held grip on the pull-back |
| blink | `eyeBlinkLeft/Right` | lizard blinks (independent eyes = very lizard) |
| gaze | `eyeLook*` composite from face.js state | eye look-at |
| head turn | facial transformation matrix | head aim (clamped) |
| puff cheeks | `cheekPuff` | gulp/swallow animation after a catch |

`FaceExpressionDetector` already emits `mouthOpen`, `blink`, `cheekPuff`, and
keeps `state.lookDirection` — the game reads `face.state` every frame, no new
detection code.

## 4. The lizard asset — Blender MCP pipeline

Authoring goes through the new Blender MCP lane (see `tools/blender-mcp/`,
`.mcp.json`): describe → Claude builds/rigs in Blender → export glTF →
`GLTFLoader` (three 0.160 already in the import map).

Rig kept deliberately tiny — bones only for what tracking drives:
- `root`, `spine`, `head` (aim), `jaw` (jawOpen), `eye.L`/`eye.R` (gaze),
  optional feet/tail for idle animation clips.
- Eyelids as shape keys (glTF morph targets) for blink.

The TONGUE IS NOT BONES. Procedural in three.js: a `CatmullRomCurve3` from a
`tongueSocket` empty (exported inside the mouth) to the target point, swept as a
`TubeGeometry` (or skinned tube) rebuilt on fire/retract. Reasons: arbitrary
stretch length, trivial tip-position access for catch tests, no retargeting.
Catch = `tongueTip.distanceTo(fly) < r` during the out-stroke; fly parents to
the tip on the return stroke.

Export loop: `export_scene.gltf` via MCP → `assets/lizard.glb` → hot-reload in
the game page.

## 5. Game structure

```
lizard.html            three.js scene (same import-map pattern as studio.html)
  sdk/core/tracking.js       camera + hands + face (enableFace: true)
  sdk/interaction/face.js    FaceExpressionDetector
  lizard/tongue.js           procedural tongue: arm/fire/retract state machine
  lizard/critters.js         flies (fast, erratic wander), fruit (slow arcs, heavy)
  lizard/game.js             score, combo, round timer
assets/lizard.glb      authored via Blender MCP
```

Tongue state machine: `IDLE → ARMED (jawOpen>0.3) → FIRING (flick; ~120ms
ease-out to target) → STUCK|MISS → RETRACT (~180ms, slower if fruit) → IDLE`.

## 6. Milestones

- M0: Blender MCP lane proven — build + rig a placeholder lizard, export glb, loads in three.
- M1: `lizard.html` with tracker (face ON), debug HUD of jawOpen/blink/fingertip.
- M2: procedural tongue: arm with mouth, aim with hand, fire on flick. No prey.
- M3: flies + catch/eat + score. Tune fire threshold so accidental flicks don't fire.
- M4: fruit (grip + weight), lizard face acting (blink/gaze/gulp), sfx, polish.

## 7. Later / explicitly out of scope now

- Cloud Blender access (MCP lane is local-first; the addon socket on :9876
  could later be tunneled, same shape).
- Multiplayer lizards (`sdk/core/multiplayer.js` is already parallel-shaped).
- Driving the STUDIO avatar's face from FaceExpressionDetector — same wiring,
  separate experiment, and it must layer on top of the frozen rig only.
