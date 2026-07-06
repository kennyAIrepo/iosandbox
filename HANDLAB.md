# Hand Lab — the holo-hand substrate, v2

Open **`/handlab.html`** (any static server). This is the product-dev / presentation
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
| `game-physics.js` | **The hand as a physics body.** `HandBody`: 21 joint colliders (size-scaled), per-joint velocities, palm frame (position + proper quaternion) with tracked **angular velocity**, punch speed, grip/pinch metrics. `GrabbableSphere`: the full object-interaction loop — sphere-vs-hand collision **avoidance** (positional push-out + impulse + tangential spin transfer: bat, dribble, roll), grip/pinch **grab** that rigidly sticks the object to the palm frame (rotate your wrist → the object rotates 1:1, at your speed), release → **throw with inherited linear + angular velocity**, gravity, floor bounce with rolling friction, pick it back up. Replaces the DEI-route basketball scripts (dei_full.html) with a reusable engine layer. `GrabbableBox`: the same loop on an **oriented box** (the Rubik's cube) with a PHYSICAL GRIP MODEL — grabbing requires a REAL grip: a thumb contact + a finger contact pressing on OPPOSING faces (normals dot < −0.25), a full-fist wrap, or a pinch ON the surface; back-of-fingertips / side-of-hand / near-miss hovers never stick, and the capture offset SEATS into the palm (no hover gap). An open palm never grabs — SUPPORT contacts (joints underneath) are near-inelastic with friction, so the cube RESTS on the hand like a tray: place it, carry it, tilt → it slides, throw ↑ and catch it, pass it hand-to-hand. Contact solve = 3 Gauss-Seidel passes over joint-vs-OBB closest-point contacts with a 6mm CONTACT SHELL (the velocity solve runs while touching, not only on penetration frames — else gravity accumulates silently in vel and one day flings a resting cube), momentum-consistent impulses with rotational effective mass, restitution threshold (micro-speed contacts don't bounce), friction on EVERY contact. Floor is corner-based (contact patch = mean of touching corners: 1 → tumble, 2 → edge pivot, 3-4 → face rest) + a settle that lays it FLAT. `setHalf()` = live resize (two-hand pinch scale). Grip-hold gets a few grace frames against tracking flicker; pinch release is instant. |
| `beat-audio.js` | Soundtrack + beat map. Built-in **"NEON DRIVE 139"** — an original, fully procedural Web Audio track at 139 BPM with an exact-by-construction beat grid. **Any MP3**: onset detection (energy flux, low band + broadband) + BPM via lag-space autocorrelation, analyzed at UPLOAD time. **⭐ Beat It (baked)**: the user's local MP3 embedded at `assets/audio/beat-it.mp3` (gitignored — copyrighted) with its analysis precomputed by `tests/_bake-audio.mjs` into `beat-it.map.json` — zero runtime DSP, the sync ground truth, prefetched at boot. TWO HARD-WON SYNC RULES: (1) `track.time()` subtracts `ctx.outputLatency` — speakers lag the clock by 40–150ms on Windows, and visuals must sync to what the EAR gets; (2) notes anchor to the MEASURED ONSETS, never to one global BPM grid — a 0.1 BPM estimate error drifts ~100ms by mid-song and silently drops off-grid sections. |
| `beat-game.js` | **BEAT RUSH** — beatsaber/moonrider-style punch game adapted to the sit-at-screen webcam stack. **The sync system, explicitly:** (1) the AudioContext clock is the single master clock — `songTime = ctx.currentTime − t0`; (2) the beat map is generated from the music BEFORE play (synth: the pattern's own event grid; MP3: pre-analyzed at upload — onsets/BPM/phase); (3) every note's `z(t) = HIT_Z − (note.time − songTime)·speed` is a PURE function of song time (never dt-integrated → can't drift), so arrival at the punch plane IS the beat; (4) a **beat conductor** ((t−offset)/spb) fires an exact kick every musical beat that pulses the grid/rails/sky/notes — the grid is felt, not just computed; (5) each note carries an **approach telegraph ring** that shrinks and hugs the note exactly on its beat: punch when the ring lands. Notes GROW on approach (0.55×→1.8×, tiny at the vanish point → fist-sized at your hands). **Punch rules:** must be a FIST (openness gate), must be swinging (≥0.5 m/s), and swing speed GROWS your contact reach (+11cm pad at full power) and your points (moonrider 60/40 timing/speed, SUPER >1.5, MEGA >3.2 m/s); multiplier ×2/×4/×8 at streaks 2/6/14 (moonrider thresholds). Feedback: note flash-expands on hit, explosion shards scale with punch power and inherit its direction, tinted screen bloom, slam-animated judgement popups, ×N banner on multiplier-up. Walls during breakdowns → lean to dodge. S–F rank + localStorage leaderboard per track×difficulty. |
| `body-forge.js` | **Procedural realistic FULL-BODY mesh** from the MediaPipe 33-landmark pose skeleton + 4 synthetic trunk joints (hip-mid, chest, head-centre, head-top) = the 37-pt `REST_BODY` (A-pose, metres, feet at y=0). Anatomical SDF (torso slab + chest/glute/deltoid/calf masses, flattened tapered limbs, head + face wedge) → shared `polygonizeSDF` pipeline → 3-influence segment-distance weights over 19 `BODY_BONES`. ~9k verts in ~370ms (`standard`), genus-0 verified. Forged, not fitted: a rigged GLB brings foreign proportions/rest-pose/bone-names and every mismatch becomes wobble — the forge binds EXACTLY to the tracked skeleton (kalidokit's deprecation of Euler-solver retargeting validates driving bones straight from landmarks). GLB avatars remain possible later via the rigExternalGeometry route. |
| `body-rig.js` | `HoloBodyRig` — the hand rig's bone-basis LBS at body scale: 19 bones, per-bone stretch → joints land exactly on tracked points, roll stabilized by the torso-forward normal (sign-locked toward the nose so the chest/face always face front), orientation-robust sizing, SAME ghost shader as the hands. `BodyPose` — the view adapter: **mirror** = ray-projected silhouette overlay on your video (same `mirrorPoint` the hands use); **third-person** = predictive avatar rebuilt from pose `worldLandmarks` (FK: rig's own rest bone lengths + live directions, elbow/knee/neck anatomical clamps), rotated to show its BACK (Kinect Sports framing), feet grounded (smoothed → crouch tracks through), lateral steer from image hips, z-convention self-calibrated + latch-decayed. |
| `rubiks-cube.js` | **Procedural Rubik's cube** — 27 cubelets (shared rounded-box body + rounded stickers, WCA colours, 7 materials total, zero download), each cubelet its own Group with `userData.grid = {i,j,k}` so the LAYER-TWIST stage can collect a slice and rotate it without touching geometry (the scanned 133MB `rubiks_cube.glb` is unshippable AND monolithic — it could never twist). Plus the table dressing: `makeHoloTable` (faint glass-shelf grid) and `makeContactShadow` (height-driven soft blob — what visually pins the cube TO the table instead of hovering). |
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
  gesture). The cube's INTERACTION DEPTH follows your tracked hands (no
  on-screen-overlap-but-metres-apart ghost contact). Fingers conform to its
  faces (box collider in `_conform`). **Occlusion is real both ways**: the cube
  hides holo fingers wrapping behind it, and in mirror mode a depth-only hand
  prepass (`rig.setOccluder`) punches hand-shaped holes in the cube so YOUR
  VIDEO FINGERS — not just the ghost — cover the faces they wrap. Spawning it
  parks the ball sandbox (re-check the box to bring the ball back). Layer
  twisting is the next stage — the mesh is already 27 grid-tagged cubelets.
- **Body** — pose-tracked full-body holo mesh (One-Euro filtered ×2 banks, pose
  every 2nd frame + prediction). 🪞 Mirror = depth-true silhouette overlay on your
  video (the Kinect Fruit-Ninja read, but a real rounded 3D body). 🎥 Third-P =
  your avatar seen from behind, feet on the floor, stepping/crouching with you —
  and BEAT RUSH is playable in this view: the corridor anchors to the AVATAR
  (`setFrameAt`), notes fly to its punch zone, Kinect Sports style. Before your
  pose is detected the avatar stands at spawn in rest pose. `BodyBody` exposes
  37 real + 10 virtual in-between colliders (belly, mid-limb) so nothing sails
  through the torso.

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
  body colliders. 31 checks.
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
4. **Rubik's cube TWIST stage**: detect a second-hand twist gesture on a held
   cube, collect the layer by `userData.grid`, animate the 90° slice rotation,
   re-tag grids, track solve state. The mesh + physics substrate is ready.
