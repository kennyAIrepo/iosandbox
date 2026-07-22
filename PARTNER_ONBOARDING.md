# hopeOS — Partner Onboarding

## What we're building
A real-time **tracking-to-render** pipeline for multi-person scenes (starting with NBA
footage). We extract skeletons and world-position stats for every player — and the ball —
from any video source, stream those tiny "stats packets" to a cloud coordination layer, and
reconstruct the scene — players, game objects, avatars — live on any client, down to a phone.
The bet is **ship semantics, not pixels**: low-bandwidth landmark data instead of video, so
high-accuracy tracking can render anywhere with low latency.

## The stack — four layers
1. **Capture (browser, thin client).** `mpgames.html` / `dollhouse.html`, static on Vercel.
   Camera / screenshare / file in; overlay + tap-to-lock out. Nothing heavy runs here — a phone
   can be a full client.
2. **Vision (cloud GPU).** The RTX 5090 B3IQ node. Detects and tracks people, classifies
   player vs ref/bench, reads team, extracts pose. This is where the models live.
3. **Protocol — the presence packet.** The stable contract: per frame, per person
   `{id, tag, team, court-xy, keypoints, ball}`. Everything above this line is model-agnostic —
   we can swap the models underneath without touching the app.
4. **Render / room.** Overlay on the live footage, the 3D **dollhouse** court reconstruction,
   and (roadmap) rigged avatars. A mid-server coordinates multi-source rooms.

## Accessing the GPU node
Follow the getting-started steps in `Getting started on CloudGPU/remote-gpu-how-to-guide.md` to SSH in. Our working tree lives
in `~/hopeos` (venv, dataset, weights, scripts). Two rules: keep the machine in **Bare metal**
(Earn mode disables SSH), and keep our files under `~/hopeos` (the host reconciles the rest).

## Models & training
- **The gate** — a fine-tuned detector that decides *who counts*:
  `player / other (ref, bench, crowd) / ball`. Trained on our own broadcast footage.
- **Coach loop** — human-in-the-loop. Label corrections feed round-based retraining: each round
  relabels the dataset, re-applies human corrections (**human > machine, always**), and retrains
  from the previous best. Latest round on the 5090 (~12 min): player mAP50 **0.96**, ball **0.85**.
- **Tracking core → SAM.** Migrating identity + segmentation to **Segment Anything**: SAM 2.1 is
  live now (a **tap becomes the prompt** → a pixel-mask that tracks that exact person; the
  **court/floor** is a prompted segment). **SAM 3.x** is the target — text/concept prompts,
  unified detect + track — gated on HuggingFace approval.
- **Pose & 3D.** 2D keypoints today; a causal **2D→3D lifter** (MotionBERT-class) turns them into
  real 3D posture for avatars.
- **Next classifier.** Team + **jersey-number ID**, run on clean mask crops.

## Roadmap — staged, each ships on its own
1. **Tracking core** — gate + SAM promptable tracking + court segmentation; low-noise persistent IDs.
2. **Mid-server room** — presence packets coordinated in a cloud room; live spectate + record.
3. **Avatars / 3D** — lifted 3D pose → rigged VRM avatars → scanned custom models.
4. **Phone-native** — GPU node exposed at a public URL; anyone tracks and renders from their own device.

## Keywords
SAM 2.1 / 3.1 · YOLO11 · BoT-SORT (+ReID) · the *gate* · *coach loop* · court **homography** /
court-metres · **presence packet** · MotionBERT **lifter** · VRM avatars · **dollhouse** ·
B3IQ / Modal (cloud GPU) · **Local Services** (public URL).

## Deeper specs (in this repo)
`SAM_MIGRATION_PLAN.md` · `MULTIPLAYER_SYNC_ARCHITECTURES.md` · `MULTIPLAYER_PLAN.md`.
