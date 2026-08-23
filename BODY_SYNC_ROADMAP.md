# BODY SYNC ROADMAP — local, live, no cloud roundtrip

Goal: the studio-quality body sync we had via the SAM3 3D body-rig lane,
but computed LOCALLY — accurate live sync of arms, hands, face, and whole-
body movements (run, walk, jump, kick) from landmarks to the avatar's
rigged keypoints, with the contract stack as the boundary.

## Why the route changes (measured, not vibes)

| Route | motion→avatar | Notes |
|---|---|---|
| SAM3 cloud body rig (st-45 measured) | ~800ms (351ms inference + ~360ms gap) | quality good, latency kills embodiment; H100 tested & REJECTED (host-bound) |
| Local landmark FK retarget (this) | tracking-bound: ~30–50ms | solve itself is sub-ms; runs on landmarks we already produce every frame |

Division of labor going forward:
- **SAM3 / cloud** = what it's uniquely good at: segmentation, garment fit,
  own-pixels mesh wrap — offline or slow-lane. NEVER in the per-frame motion loop.
- **Local** = ALL per-frame motion: pose world-landmarks → FK retarget,
  hands → finger curls, face matrix → head, measures → gait/gesture triggers.

## The solve (implemented in sdk/interaction/body-drive.js v2)

Direction-based FK retargeting — the Kalidokit-class approach:

1. MediaPipe pose gives WORLD landmarks (metric 3D, origin at hip mid) —
   `tracker.detect().poseWorld`, already computed, previously unused here.
2. For each avatar segment (spine, upper arms, forearms, thighs, shins),
   take the human segment's 3D direction, map MediaPipe world → three
   mirror space ((x,y,z) → (x,−y,−z), sides swapped for mirror mode).
3. Rotate the avatar bone so its child points along that direction —
   parents first, absolute from rest pose each frame (no drift), world-
   space deltas (no assumptions about bone local frames — works on any
   rig that skeleton-align.js can classify).
4. One-Euro on target directions; low-visibility segments ease to rest.
5. Fingers: hand-measures curls onto auto-discovered finger chains.
   Head: face transform matrix onto neck, PuppetStage damping.
   Crouch: BodyProbe measure → root drop (root translation is
   unobservable in hip-origin world landmarks).

## Phases

**P0 — DONE (this pass)**
- FK retarget v2 in humanlab (brunette/robot), overlay mirror bug fixed,
  finger + head + crouch lanes integrated.

**P1 — joint completeness**
- DONE: palm orientation from hand world-landmarks — hands.js buildFrame
  palm-basis math (0/9/5/17) evaluated on BOTH sides (landmarks vs bone
  positions) → hand bone orientation; per-finger per-segment FK.
- DONE (first layer): human-movement constraints — z attenuation, ROM
  cone clamps (shoulder 110°/hip 100°/spine 25°, clinical-ROM inspired),
  elbow/knee flexion ≤150°, arm back-plane clamp (kills backwards-
  through-chest artifacts from z noise).
- NEXT: capsule self-collision (hand-vs-hand, hand-vs-torso pushout);
  true hinge-plane projection for elbows/knees (current limit is
  angle-only); foot/toe aim + ground contact clamp; forearm twist from
  palm roll.

**P2 — locomotion & airborne (run/walk/jump/kick as MOTION, not just triggers)**
- Root vertical: jump = airborne when both ankles' world-Y rise together
  while legspan holds; drive root Y ballistically between contacts
  (BodyGestureDetector 'jump' event arms it, landmarks scale it).
- In-place run/walk (runInPlace cadence) → optional world translation for
  game modes (same gait math as the fox driver, biped stride).
- Kick/punch: already correct via FK retarget (the leg literally follows
  your leg); gesture events remain as GAME triggers, not motion sources.

**P3 — polish to studio grade**
- Calibration ritual (contract stage 2): T-pose 2s → per-user limb
  proportions + rest offsets; store via CalStore like the face lane.
- Per-rig response curves (contract map field): gain/clamp per joint,
  handshake-frozen like the face contract.
- Optional SAM3 slow lane: segmentation-refined body shape / own-pixels
  texture applied to the SAME rig the local solve drives (cloud enhances
  appearance at 1–2Hz; motion stays local at 60).

## Contract position

Nothing about the boundary changes: human side emits measures + world
directions; skeleton-align detects the puppet's rigged keypoints; the
driver is the translation. MoveNet remains a swap-in (MOVENET_17 map) —
but note MoveNet is 2D-only: it can feed the measures/trigger lane, not
the 3D FK retarget lane. MediaPipe pose world-landmarks are what make the
local 3D solve possible at zero added inference.
