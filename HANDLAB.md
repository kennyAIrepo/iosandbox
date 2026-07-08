# Hand Lab — the holo-hand substrate, v2

Open **`handlab.html`** (any static server — or hosted: the repo deploys to
**GitHub Pages** via `.github/workflows/pages.yml` (Settings → Pages → Source =
"GitHub Actions", then `https://<user>.github.io/<repo>/handlab.html`) and to
**Netlify** via `netlify.toml` (publish dir = repo root, no build step). All lab
paths are RELATIVE and three.js/MediaPipe come from CDNs, so subpath hosting
works; the copyrighted baked MP3 is gitignored and never ships — hosted builds
grey out ⭐ Beat It and default to the synth track. The `/api/*` world-publish
endpoints are Vercel-only and unused by the lab.) This is the product-dev / presentation
surface for the hand interaction system AND the reference implementation of the fixes
to the three process problems: **misalignment, latency, flip/twist on camera-mode
switch**. Holo hands remain the reliable fallback representation for the collision +
occlusion design (SAM/segmentation lanes stay decoupled, per `HOPEOS_ENGINE_BRIEF.md`).

## What's new (sdk/core/)

| Module | What it does |
|---|---|
| `hand-forge.js` | **Procedural smooth hand mesh, forged in-browser** from the 21-landmark rest skeleton — SDF capsule-blend (smooth-min: organic knuckles/webbing/palm) → MarchingCubes → weld → Taubin smooth (no shrink) → distance-to-bone-segment skin weights. 4 styles (`smooth/full/slim/lowpoly`), ~250ms once, zero download (replaces the 10MB GLB; can also auto-rig external/scraped hand GLBs via `rigExternalGeometry`). |
| `hand-rig.js` | **Bone-based skinning** (20 bones, 2 influences) instead of K-nearest-landmark dragging — kills the wrinkle/candy-wrap twist. Per-bone stretch → fingertips land EXACTLY on tracked landmarks (misalignment ≈ 0 by construction; verified 0 deviation at bind, 3e-7 under rigid motion). ~0.3ms/frame @ 15k verts. Ghost shader: pale glowing hologram blue — half-Lambert wrap diffuse for a rounded volumetric read (a fresnel-only ghost looks like a flat clip-out and goes invisible where the surface faces the eye — the "palm hole" was that dead spot, not geometry), cyan silhouette rim + icy bloom, NORMAL blending + depthWrite (visible over bright rooms, self-occludes, occludes scene objects behind fingers — the occlusion design for free). Collider conform (sphere + BVH) ported unchanged. |
| `filters.js` | **One-Euro filter** per landmark channel (replaces the deadband stabilizer) + clamped velocity **prediction** to hide the ~40–70ms pipeline latency. Render the predicted pose; feed physics the measured one. |
| `game-physics.js` | **The hand as a physics body.** `HandBody`: 21 joint colliders (size-scaled), per-joint velocities, palm frame (position + proper quaternion) with tracked **angular velocity**, punch speed, grip/pinch metrics. `GrabbableSphere`: the full object-interaction loop — sphere-vs-hand collision **avoidance** (positional push-out + impulse + tangential spin transfer: bat, dribble, roll), grip/pinch **grab** that rigidly sticks the object to the palm frame (rotate your wrist → the object rotates 1:1, at your speed), release → **throw with inherited linear + angular velocity**, gravity, floor bounce with rolling friction, pick it back up. Replaces the DEI-route basketball scripts (dei_full.html) with a reusable engine layer. `GrabbableBox`: the same loop on an **oriented box** (the Rubik's cube) with a PHYSICAL GRIP MODEL — grabbing requires a REAL grip: a finger contact pressing OPPOSITE a thumb or PALM contact (normals dot < −0.15 — palm-under + fingers-over is how a hand actually holds a cube), a full-fist wrap, or a pinch ON the surface — AND the grip must be GRAVITY-VALID: at least one contact below the cube's midline (a carrying grip wraps under the widest point, because that's what bears the weight; a hand draped over the top whose fingers straddle the upper edges never latches — the cube falls away). Back-of-fingertips / side-of-hand / near-miss hovers never stick, and the capture offset SEATS until the palm skin MEETS the face (no hover gap — the conform then wraps the fingers onto it; conform is band-limited so deep overlap is swallowed by the opaque cube instead of smearing skin across the faces). While held, the HOLDING hand's colliders keep pushing the cube out (offset adapts) — hand skin and cube surface stay mutually solid. An open palm never grabs — SUPPORT contacts (joints underneath) are near-inelastic with friction, so the cube RESTS on the hand like a tray: place it, carry it, tilt → it slides, throw ↑ and catch it, pass it hand-to-hand. Contact solve = 3 Gauss-Seidel passes over joint-vs-OBB closest-point contacts with a 6mm CONTACT SHELL (the velocity solve runs while touching, not only on penetration frames — else gravity accumulates silently in vel and one day flings a resting cube), momentum-consistent impulses with rotational effective mass, friction on EVERY contact — and hand contacts NEVER bounce (e≈0; "repelled while grabbing" was exactly that bounce) with per-frame positional pushes CAPPED so converging fingers squeeze, not eject. Bounciness is PER OBJECT: the cube's restitution is 0.05 (it THUDS on the desk and tumbles flat, never bounces) while the ball keeps 0.58. Floor is corner-based (contact patch = mean of touching corners: 1 → tumble, 2 → edge pivot, 3-4 → face rest) + a settle that lays it FLAT. `setHalf()` = live resize (two-hand pinch scale). Grip-hold gets a few grace frames against tracking flicker; pinch release is instant. |
| `beat-audio.js` | Soundtrack + beat map. Built-in **"NEON DRIVE 139"** — an original, fully procedural Web Audio track at 139 BPM with an exact-by-construction beat grid. **Any MP3**: onset detection (energy flux, low band + broadband) + BPM via lag-space autocorrelation, analyzed at UPLOAD time. **⭐ Beat It (baked)**: the user's local MP3 embedded at `assets/audio/beat-it.mp3` (gitignored — copyrighted) with its analysis precomputed by `tests/_bake-audio.mjs` into `beat-it.map.json` — zero runtime DSP, the sync ground truth, prefetched at boot. TWO HARD-WON SYNC RULES: (1) `track.time()` subtracts `ctx.outputLatency` — speakers lag the clock by 40–150ms on Windows, and visuals must sync to what the EAR gets; (2) notes anchor to the MEASURED ONSETS, never to one global BPM grid — a 0.1 BPM estimate error drifts ~100ms by mid-song and silently drops off-grid sections. |
| `beat-game.js` | **BEAT RUSH** — beatsaber/moonrider-style punch game adapted to the sit-at-screen webcam stack. **The sync system, explicitly:** (1) the AudioContext clock is the single master clock — `songTime = ctx.currentTime − t0`; (2) the beat map is generated from the music BEFORE play (synth: the pattern's own event grid; MP3: pre-analyzed at upload — onsets/BPM/phase); (3) every note's `z(t) = HIT_Z − (note.time − songTime)·speed` is a PURE function of song time (never dt-integrated → can't drift), so arrival at the punch plane IS the beat; (4) a **beat conductor** ((t−offset)/spb) fires an exact kick every musical beat that pulses the grid/rails/sky/notes — the grid is felt, not just computed; (5) each note carries an **approach telegraph ring** that shrinks and hugs the note exactly on its beat: punch when the ring lands. Notes GROW on approach (0.55×→1.8×, tiny at the vanish point → fist-sized at your hands). **Punch rules:** must be a FIST (openness gate), must be swinging (≥0.5 m/s), and swing speed GROWS your contact reach (+11cm pad at full power) and your points (moonrider 60/40 timing/speed, SUPER >1.5, MEGA >3.2 m/s); multiplier ×2/×4/×8 at streaks 2/6/14 (moonrider thresholds). Feedback: note flash-expands on hit, explosion shards scale with punch power and inherit its direction, tinted screen bloom, slam-animated judgement popups, ×N banner on multiplier-up. Walls during breakdowns → lean to dodge. S–F rank + localStorage leaderboard per track×difficulty. |
| `body-forge.js` | **Procedural realistic FULL-BODY mesh** from the MediaPipe 33-landmark pose skeleton + 4 synthetic trunk joints (hip-mid, chest, head-centre, head-top) = the 37-pt `REST_BODY` (A-pose, metres, feet at y=0). Anatomical SDF (torso slab + chest/glute/deltoid/calf masses, flattened tapered limbs, head + face wedge, WEDGE FEET: heel block → instep ramp → ball pad → toe cap; arms end in wrist stubs — real hand meshes attach in the rig) → shared `polygonizeSDF` pipeline (res 152, 6 Taubin passes: the silhouette look draws a contour line right on the edge, so faceting reads as jagged linework) → 3-influence segment-distance weights over 19 `BODY_BONES`, REGION-MASKED + RADIUS-NORMALIZED: each vertex may only bind to bones of the SDF part-group its surface belongs to (torso skin can never bind an arm bone — raw inverse-d² let the A-pose forearms, hanging beside the hips, capture waist/chest skin: raising the arms grew triangular torso shards that rode up with them), and distances compete normalized by per-bone capture radius so thick trunk bones out-pull thin limb bones. ~12.5k verts in ~450ms (`standard`), genus-0 verified. Forged, not fitted: a rigged GLB brings foreign proportions/rest-pose/bone-names and every mismatch becomes wobble — the forge binds EXACTLY to the tracked skeleton. GLB avatars remain possible later via the rigExternalGeometry route. |
| `body-rig.js` | `HoloBodyRig` — the hand rig's bone-basis LBS at body scale: 19 bones, per-bone stretch → joints land exactly on tracked points, roll stabilized by the torso-forward normal (sign-locked toward the nose so the chest/face always face front), orientation-robust sizing. **REAL HANDS**: the body's arms end in forged hand meshes (the same hand forge the interactive hands use — individual fingers are ~1 voxel at body grid resolution and would shred, so hands come from their own grid), rigidly frame-mapped onto the live wrist/pinky-MCP/index-MCP paddle frame, scaled to the body's own wrist→MCP span (EMA'd, clamped ±35% of the anatomical proportion — a bad landmark can never blow the hands up), chirality per side from the matching rest pack, sharing the body material so look/alpha stay in lockstep. **TWO BINDS** (`back: true`) — the same fix as the hands' chirality meshes: the POV retarget skeleton is a z-REFLECTION of the mirror-space rest pose (person seen from behind), and a front-bound LBS cannot follow a reflection (horizontal bones — clavicles, pelvis wings — roll 180° about their own axis, collapsing the torso into a pinched bowtie). The mirror overlay drives the FRONT bind; first/third-person drive a BACK bind (reflected rest skeleton + reflected forged geometry + chirality-swapped hand packs), so the retargeted pose is a proper motion of its own bind (rest-fed retarget ≈ identity, asserted at 0.2cm). `retarget()` also resolves the AUX landmarks the FK skeleton doesn't cover (face ring, pinky/thumb MCPs, heels — live direction, rest length): they used to sit at the ORIGIN, smearing the head into a vertical beam and blowing up the hand frames. TWO LOOKS, swappable live (`setLook`): **👻 ghost** = the hands' holo shader; **🌑 shadow** (default) = the KINECT SILHOUETTE — dark smoky core with a white-hot contour + electric aura. The core is one closed mesh with `depthWrite` ON, so normal blending resolves to a single flat alpha layer (the standard fix for a uniformly-transparent body — no self-double-blend); the aura is an inverted hull (same deforming geometry pushed out along its normals, BackSide + additive = order-independent halo, zero post-processing). `BodyPose` — the view adapter + PREDICTIVE layer: **mirror** = ray-projected silhouette overlay on your video (same `mirrorPoint` the hands use) with a partial-body stabilizer — MediaPipe hallucinates coordinates for out-of-frame joints, so every low-visibility child joint is re-hung from its parent (holds its last confident offset, relaxes to the A-pose rest; the held memory NEVER absorbs gated data); **first/third-person** = predictive avatar rebuilt from pose `worldLandmarks` (FK: rig's own rest bone lengths + live directions, elbow/knee/neck anatomical clamps), rotated to show its BACK (Kinect framing), feet grounded (smoothed → crouch tracks through; feet out of frame FREEZE the ground estimate on raw visibility), lateral steer from image hips, z-convention self-calibrated + latch-decayed. Visibility gates per limb follow field consensus (Kalidokit 0.23/0.63, iR Engine 0.6/0.75): arms 0.25, legs 0.55, else 0.5, EMA'd so no single frame flips a limb; gate 1 = pure live (zero added lag), gate 0 = held→rest. **JUMP INFERENCE**: worldLandmarks are hip-origin so a jump is invisible in them — the launch is read from the IMAGE hips (velocity gate ~1 m/s, metres self-calibrated from the live trunk span), lifting the whole avatar while airborne (`bodyPose.airY`, exposed in `HOPEOS_STATE.body.airY`); a slow rise (stand-up, stepping closer) re-baselines instead. |
| `rubiks-cube.js` | **Procedural Rubik's cube + TWIST ENGINE** — 27 cubelets (shared rounded-box body + rounded stickers, WCA colours, 7 materials total, zero download), each cubelet its own Group with `userData.grid = {i,j,k}` (the scanned 133MB `rubiks_cube.glb` is unshippable AND monolithic — it could never twist). `RubiksModel` does the classic three.js pivot-slice mechanic: `beginTwist(axis, layers)` reparents the slice onto a pivot (middle slice alone is REFUSED — the central cross is the core), `setTwistAngle` live-follows the hands with a 90° DETENT (cap-click feel), release eases to the nearest quarter turn and BAKES — lattice-rounded positions, orientations quantized to the 24-element cube rotation group (float error can never accumulate), integer grid re-tag. `twistAngleAbout` = swing-twist decomposition (how far a palm has rotated about the slice axis); `isSolved()` for the game loop. Plus the table dressing: `makeHoloTable` + `makeContactShadow` (what visually pins the cube TO the table instead of hovering). |
| `hand-views.js` | **THE single source of truth for view flips.** Invariant: physical right hand is always screen-right, and landmark-data chirality always matches mesh chirality — mirror mode routes your right hand to the LEFT-chirality mesh (a reflection IS a left hand), first/third person route naturally. All transforms are proper rotations (det > 0), so the rig can never be asked to mirror-twist a mesh. Mirror mode is RAY-BASED (each landmark slides along its own camera ray by depth, so the mesh projects onto exactly the tracked pixel — no outward finger drift) with the cover-fit crop divided out. **First/third person are PREDICTIVE POV**: the camera sees the front of your hand, your eyes see the back, so the pose is rebuilt from MediaPipe `worldLandmarks` (true metric 3D, viewpoint-independent), chirality is self-calibrated per hand against the image cloud (cross-covariance determinant — immune to MediaPipe axis/handedness quirks), then the pose is rotated 180° about vertical (a proper rotation) and re-anchored at the on-screen wrist. Palm to the camera ⇒ you see your hand's back, exactly like real FPS hands. |

The root cause of the old "flipped/twisted hand on camera switch": selfie-mirrored
(left-chirality) data was fed into the right-chirality mesh, and each view mode
re-flipped different axes in different files. The translation-based deformer absorbed
the mirror by smearing vertices — that smear *was* the twist.

## Lab controls

- **Model** — forge style + ghost opacity, live re-forge. **GLB** loads the old
  DEI-route `holohand.glb` through the SAME bone rig / filters / ghost shader
  (via `rigExternalGeometry`, `geometryFit:false` — the asset is pre-aligned to
  REST_R42/L42), so you can A/B mesh *look* with drive machinery held constant.
- **View** — Mirror / First-Person / Third-Person. Switch freely mid-tracking: hands
  must never flip, twist, or swap sides. (Third-person = the full-body/silhouette lane.)
- **Show (mesh isolation)** — `applyDisplay()`: **Full lab** (everything; body follows
  its checkbox) / **🖐 Hands** (ONLY the hand meshes — body + ball/cube/beat props
  hidden) / **🖐+🧍 Body** (hands + the full-body rig, still no props). For judging
  the substrate meshes clean; starting a BEAT RUSH round drops you back to Full lab,
  and the body checkbox inside an isolation mode switches between the two isolations.
- **Hand height (fit any screen)** — `views.cfg.yOffset` (m): raises/lowers where
  the POV hands sit on screen, for any screen+camera where they'd otherwise land
  too low. Camera-local vertical in first-person (= straight up the screen at any
  camera pitch), world-vertical in third-person; mirror mode ignores it (the mesh
  must stay glued to your real hand). BEAT RUSH's note punch-plane is shifted by
  the SAME value (`beatGame.setHeightOffset`) so notes keep arriving exactly where
  the hands are drawn — hands + physics colliders + notes move as one, no desync.
- **Audio** — master volume + **🔇 mute all**. Every track routes through one
  master `GainNode` (`beatGame.setVolume`/`setMuted`, applied even if set before a
  round starts), so the control is truly global and click-free (short gain ramp).
- **Filter** — min-cutoff (lower = calmer at rest), beta (higher = less lag at speed),
  prediction ms. "Show raw landmarks" overlays orange dots = unfiltered input, so you
  can SEE jitter removed and the predicted mesh leading the raw signal.
- **Game (BEAT RUSH)** — difficulty (Chill/Rush/Insane), track source (built-in
  synth or any local MP3 → auto beat-mapped), START forces first-person. Punch the
  orbs on the beat (left lanes magenta = left hand, right cyan = right — matching
  hand is a bonus, not a requirement), lean to dodge walls. Generous hitboxes by
  design: camera tracking carries 40–150ms motion-to-photon, so the loop rewards
  swings and zones, not precision taps (brief §9).
- **Ball sandbox** — opaque spin-visible ball with the full physics loop: grip or
  pinch to grab, it rotates with your wrist, throw it (inherits spin), it bounces
  and rolls, reach down and pick it up. Occlusion is depth-real: fingers wrapping
  the far side hide behind it (conform +3mm epsilon kills the shell z-fight).
  The ball also collides with your BODY (chest bounces) via `BodyBody`.
- **Rubik's cube (🧊 SPAWN CUBE)** — the box version of the full loop, with the
  PHYSICAL GRIP contract. It drops onto a holo TABLE pinned to the BOTTOM OF THE
  CAMERA FRAME (mirror mode; the world floor in FP/TP), tumbles corner-by-corner,
  settles flat with a contact shadow (never hovers). **Grabbing needs a real
  grip**: wrap it (thumb + fingers on opposing faces), make a fist around it, or
  pinch 🤏 it ON the surface — brushing past it, the back of your fingers, the
  side of your hand do nothing but PUSH it (avoidance). Held, it rides the palm
  frame 1:1 and seats into your grip; open your hand and it FALLS. An open palm
  is a TRAY: set the cube on it and it rests there, carried with the hand —
  that's the catch: throw it up ↑, put your palm under it, it lands and stays;
  miss and it hits the table. Pass it hand to hand. **Two-hand pinch** near the
  cube + pull apart / squeeze = scale it up/down (0.45×–2.6×, the DEI basketball
  gesture). The cube's depth actively SEEKS the
  nearest palm's z, and the table re-pins to the frame bottom at that depth —
  a reaching hand can always touch it by construction (no
  on-screen-overlap-but-metres-apart ghost contact). Fingers conform to its
  faces (box collider in `_conform`). **Occlusion is real both ways**: the cube
  hides holo fingers wrapping behind it, and in mirror mode a depth-only hand
  prepass (`rig.setOccluder`) punches hand-shaped holes in the cube so YOUR
  VIDEO FINGERS — not just the ghost — cover the faces they wrap. Spawning it
  parks the ball sandbox (re-check the box to bring the ball back).
  **🔄 LAYER TWIST**: hold the cube with one hand, grip a layer with the
  other (≥3 contacts) — the slice axis is the palm-to-palm line (cube-local),
  the slice is the layers the twisting hand touches minus the holder's, and
  the layer follows the RELATIVE twist of the two palms about that axis
  (swing-twist), like twisting a cap: left hand on the top rows + right hand
  on the bottom rows → twist → the grabbed rows turn, the rest stays with
  the holder, the core cross anchors. Detents at every 90°, release snaps
  the remainder and bakes into the grid; the twisting hand is exempt from
  push-out while it owns a slice.
- **Body** — pose-tracked full-body mesh (One-Euro filtered ×2 banks, pose
  every 2nd frame + prediction), now in EVERY camera view with two looks:
  **🌑 Shadow** (default) = the Kinect silhouette — dark translucent body,
  white-hot contour, pulsing electric aura (inverted-hull halo) — and
  **👻 Holo** = the hands' ghost shader. 🪞 Mirror = depth-true silhouette
  overlay on your video (the Kinect Fruit-Ninja read, but a real rounded 3D
  body), partial-body stabilized: limbs that leave the frame settle to rest
  instead of flailing on hallucinated landmarks. 🎮 First-P = your shadow
  STANDING IN THE SCENE 1.8m ahead (Fruit-Ninja framing) while your hands
  reach into the game. 🎥 Third-P = the avatar seen from behind, feet on the
  floor, stepping/crouching with you — BEAT RUSH playable in both POV views
  (the corridor anchors to the avatar via `setFrameAt`, Kinect Sports style).
  **Sliders**: opacity · body height (raise/lower on screen, all views) ·
  silhouette size (0.5–1.6×). **Predictive**: a hip LAUNCH in the image lifts
  the airborne avatar (jump inference, self-calibrated to camera distance);
  out-of-frame feet freeze the ground estimate; per-limb visibility gates are
  EMA'd so nothing pops. Pose One-Euro params = MediaPipe's own shipped pose
  tuning (world 0.1/40, image ≈0.08/30) — calm at rest, no lag at speed.
  Before your pose is detected the avatar stands at spawn in rest pose.
  `BodyBody` exposes 37 real + 10 virtual in-between colliders (belly,
  mid-limb) so nothing sails through the torso.

## Live spatial state

`window.HOPEOS_STATE` — plain numbers, updated per frame, allocated once: head
(normalized), per-hand palm position / velocity / quaternion / angular velocity /
punch speed / openness / pinch / fingertips, ball pose + spin + holder, cube
pose + spin + holder + tableY, game (songTime, score, streak, beat pulse). This
is the exposed avatar/hand coordinate layer for in-game interaction and external
tooling.

## Tests

`npm test` —
- `tests/hand-smoke.mjs` — forge integrity, bind-pose identity, rigid-follow,
  fingertip alignment, fist roll-fallback, left chirality, pose perf, filter
  behavior, chirality routing per view. 40 checks.
- `tests/game-smoke.mjs` — HandBody linear/angular velocity tracking, pinch,
  grab → rotate-with-hand → release-throw, hand-collision push-out, floor rest,
  synth pattern grid integrity, beat-map density/lanes/walls per difficulty,
  BPM recovery on a synthetic click track, spawn-geometry contract (notes hit
  the plane exactly on the beat), GrabbableBox (spinning drop → tumbles →
  rests FACE-FLAT at half-height, pinch-grab → 1:1 rotation-follow → release,
  spawn-inside-hand push-out with zero residual overlap), grip physicality
  (single-side touch and near-miss hovers do NOT stick, palm-up hand = tray:
  the cube rests under gravity without being grabbed and without sliding off,
  opposing thumb/finger wrap DOES grab and carries). 57 checks.
- `tests/body-smoke.mjs` — body forge (verts/NaN/human-scale/Euler χ=2 genus
  check/weights, both styles), rig bind identity (1e-7), rigid follow, synthetic
  joints, world→avatar retarget (bone lengths exact, right hand at +x from
  behind, faces −Z, feet grounded, squat lowers hips, image-step steers),
  weight regions (zero arm-bone influence on torso skin), arms-up rigidity
  (waist + head stay put with arms overhead — the shard regression), attached
  body hands (wrist seating, chirality, proportion, shared material), foot
  shape, shadow-silhouette look (material swap, shared-geometry aura hull,
  depthWrite contract), silhouette size scaling, jump inference (launch
  detected, slow drift stays grounded, landing settles), visibility inference
  (hallucinated out-of-frame arm settles to rest + reacquires live, lost feet
  freeze the ground), mirror partial-body stabilizer, retarget completeness
  (face/MCPs/heels never at origin), back-bind identity (no torso pinch) +
  chirality, body colliders. 75 checks.
- `tests/_bodyview.html` + `tests/_bodyprobe-view.mjs` — no-camera visual
  harness: renders the body rig posed from URL params (rest / arms-up /
  retarget / retarget-up — the exact live POV path — look, camera:
  full/hand/foot/head) and screenshots each state (server on :3333).
- `tests/_bodyprobe.mjs` — headless-Chrome lab probe (fake camera): boots
  handlab, checks the shadow body in third-/first-person, exercises the body
  UI (look toggle, height + size sliders).
- `tests/rubiks-smoke.mjs` — build census (27 cubelets, 54 stickers,
  1/6/12/8 core/centres/edges/corners), swing-twist math, pivot slice
  (core-alone and whole-cube twists refused), release-snap animation,
  bake exactness (lattice positions, 24-group orientations, grid stays
  a 27-slot permutation, layer footprint preserved), solved-state
  round-trip, cross-axis scramble consistency. 28 checks.
- `tests/_gameprobe.mjs` — headless-Chrome probe (fake camera): boots the lab,
  shows the Third-P avatar, runs a synth round, dumps `HOPEOS_STATE` + results
  screen. Needs `:3333`.

## Wiring status

- `handlab.html` uses the full new stack (this is the reference).
- `hopeos.js`: `handModelUrl: 'procedural'` (or any failed GLB load) now forges hands
  instead — old worlds keep working untouched.
- `world.html` / `embodiment.js` still run the legacy RiggedHand path; migrating them
  onto `hand-views.js` + `HoloHandRig` is the next step once the lab look is approved.

## Next (agreed direction)

1. Tune the ghost look + filter defaults on real devices in the lab; tune BEAT
   RUSH hit windows/speeds against real webcam latency.
2. Migrate world.html embodiment onto the new stack (drop the double-smoothing).
3. ~~Grabbable meshes beyond spheres~~ → DONE for boxes (`GrabbableBox` +
   box conform). Still open: arbitrary BVH GrabbableMesh, and note
   shapes/patterns per song section.
4. ~~Rubik's cube TWIST stage~~ → DONE (`RubiksModel` + the two-hand
   cap-twist gesture in the lab; `tests/rubiks-smoke.mjs`, 28 checks).
   Next for the cube GAME: scramble button, solve detection celebration
   (`isSolved()` is already there), move counter/timer, and a mid-twist
   collider that tracks the rotating slice corners.
