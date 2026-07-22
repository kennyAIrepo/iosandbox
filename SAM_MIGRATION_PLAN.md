# SAM Migration Plan — cloud-GPU tracking core + swappable model tiers

Research synthesis, 2026-07-21 (three research passes: SAM 2/3 state, cloud-GPU
hosting, avatar/3D pipeline). Goal: swap the tracking core to promptable
segmentation (SAM), host it on a rented cloud GPU, keep the browser/phone as a
thin client, and stage the render path from stick skeletons → 3D pose → rigged
avatars → scanned player models.

---

## 1. Model verdict — SAM 3 preference, honestly assessed

- **SAM 3** (Nov 2025) / **SAM 3.1** (Mar 2026): one model does open-vocabulary
  detection + segmentation + tracking with persistent IDs. Text/concept prompts
  ("player in white jersey"), exemplar prompts, AND point/box prompts — so
  **tap-to-lock is native** (the tap IS the prompt) and the **court/floor is a
  prompted segment** ("basketball court floor"), replacing the color-blob
  heuristic.
- The catch: ~848M params, **weights gated on HuggingFace** (request access —
  approval lag), custom SAM License (commercial OK, restrictions apply), **no
  official streaming API** (community bridge: Jeffjewett27/sam3-realtime), and
  video latency scales with tracked-object count. **SAM 3.1's Object Multiplex
  (16 objects/forward pass, ~30fps on H100)** is the first config where a full
  10-player scene is realistically live — but that's H100/A100-class money.
  Consumer/L4-class fps for 3.1: unpublished; profile before committing.
- **SAM 2.1** (Apache-2.0, ungated): streaming-native architecture with proven
  real-time forks (Gy920/segment-anything-2-real-time). Small/Base+ ≈ 85/44 fps
  single-object on A100; ~10 players naively lands 3–8 fps → track selectively
  (tapped players + ball), re-anchor with a detector.
- Sports stacks that exist today: Roboflow basketball pipeline (RF-DETR →
  SAM 2 → SigLIP team clustering → jersey OCR; offline), SAMURAI (SAM 2.1 +
  Kalman memory; single-object, offline), Grounded-SAM-2 (text→detect→track).
  **No mature live SAM-3 sports MOT repo exists yet** — we'd be assembling, not
  downloading.
- **The gate keeps a job in every scenario**: SAM doesn't know player vs ref vs
  bench (attribute prompts are its weakest area) and can't do team/jersey ID.
  Our fine-tuned classifier runs on SAM's mask crops — cheap, and it also
  arbitrates ID-swap recovery.

**Decision: two tracks in parallel.**
- **Track P (pragmatic, ship first): SAM 2.1-small camera-predictor + existing
  YOLO gate** as re-anchoring detector, on a Modal **L4** (~$0.80/hr).
- **Track 3 (the preference, evaluate immediately): SAM 3.1** on a Modal
  A100/H100 burst; profile fps with 10+ objects via the realtime bridge. If it
  holds ≥15fps, it becomes the core and Track P's detector+tracker collapses
  into it. Request HF access NOW (lag).

## 2. Cloud host verdict — Modal

- **Live tracker → Modal**: ASGI WebSockets on auto-TLS `wss://…modal.run`,
  scale-to-zero, GPU memory snapshots (~2–5s cold starts even with GB-scale
  weights), 1 TiB free volume for weights, `modal deploy` from Python.
  **$30/mo free credits ⇒ light demo use (≈5h/wk on L4) is effectively $0/mo**;
  2h/day ≈ $22/mo net. Don't pin region initially (pinning ×1.5 cost).
- **Training → RunPod 4090 pod (~$0.69/hr ⇒ ~$2/run) or Modal A100 (~$7.50/run)**.
  Either kills the "site is dead for 3 hours" problem — the 4060 stays free for
  the site; cloud does the training.
- Ruled out: Fly.io (GPUs shut down July 2026), Replicate (no persistent WS,
  pricey), Vast.ai for serving (fine for cheap training if tolerant), Lambda
  (no scale-to-zero).
- Phone/browser fit: `https://` Vercel page → `wss://` Modal = no mixed-content
  issue; CORS doesn't apply to WS. Auth: Vercel API route mints short-lived
  HMAC token (secret in Vercel env + Modal Secret), token in WS query string.
  Frames ≤2 MiB/message (720p JPEG ≈ 100–200 KB — fine).

## 3. Target architecture

```
BROWSER (Vercel static — mpgames / dollhouse / phone)
  camera | screenshare | file → JPEG frames (≤720p) → wss://tracker.modal.run
  ← per-frame JSON: {id, mask-outline?, box, kpts2D, kpts3D?, team, court-xy, ball}
  render: overlay (mpgames) · 3D court (dollhouse) · avatars (v2+)
  latency hiding: existing vsync/frame-echo + snapshot interp + coast (built)
─────────────────────────────────────────────────────────────────────────
MODAL GPU CONTAINER (scale-to-zero, snapshot cold-start)
  SAM core (2.1 now / 3.1 when it profiles) — masks + persistent IDs
     · prompts: user tap (forwarded from browser), text concept, auto-seed
     · court/floor: prompted once per scene, cached, re-prompt on cut
  GATE classifier (our best.pt lineage) on mask crops — player/ref/bench + team
  LANDMARK tier per ID-crop (swappable):
     · RTMW3D / yolo-pose (far, broadcast) — 2D+3D per frame, no window delay
     · MediaPipe (near, webcam) — 33 pts + hands
     · MotionBERT-Lite causal-window lifter (Apache-2.0, ONNX) — 3D from 2D
  emits the SAME presence packet the room bus already carries
─────────────────────────────────────────────────────────────────────────
TRAINING (bursty, elsewhere): RunPod/Modal jobs — gate rounds, lifter
  fine-tune (AthletePose3D), SAM fine-tune later. Local 4060 = dev + fallback.
```

Key invariant: **the presence packet is the contract.** Browser pages, dollhouse,
the room bus, games — none change when the model stack above the packet swaps.

## 4. Avatar/render staging (dollhouse v1→v4)

1. **v1 (now)**: stick skeletons + court homography roots (built), smoothing (built).
2. **v2 — 3D posture**: MotionBERT-Lite (61 MB, Apache-2.0) cloud-side, causal
   27-frame window ⇒ zero algorithmic delay, ~2 KB/frame extra. coco2h36m
   conversion is a trivial util. Optional: fine-tune on AthletePose3D (athletic
   motion cuts error ~230mm→~98mm). Alternative: RTMW3D per-crop (single-frame
   3D, jitterier — One-Euro on rotations).
3. **v3 — rigged generic avatars**: three-vrm (MIT, maintained) or Mixamo glTF;
   COCO-17→humanoid bone rotations (~300 lines quaternion swing/twist — no
   off-the-shelf lib exists; Kalidokit adaptation is the fast demo path);
   two-bone leg IK + foot-lock to court plane; hips from court tracking.
   NOTE: Ready Player Me is DEAD (Netflix acquired, API shut Jan 2026).
4. **v4 — real player models**: scan-yourself path = RealityScan 2.0/Polycam →
   cleanup → AccuRIG/Mixamo auto-rig → same retarget path. Photo-only path =
   SAM 3D Body / ECON + UniRig (experimental). **Legal: no real NBA likenesses
   without licensing** (right of publicity + NBA/2K IP) — use generic athletes
   (build/number, no likeness/logos) for anything shipped; scanned consenting
   users are fine.

## 5. Execution order

0. **Unblock demos immediately** (no cloud needed): freeze `yololab/deploy/`
   copy of best.pt + serve script so training can't touch the demo model;
   training moves to cloud (step T1) or night hours.
1. **M1 — Modal bootstrap**: account + card (owner), `modal setup`, deploy
   current serve.py logic (YOLO+gate) as wss endpoint — proves the whole
   browser→cloud→browser loop with zero model risk. Add server-URL setting in
   mpgames (localhost | modal). Phones work from this moment.
2. **M2 — SAM 2.1 core**: swap tracker to SAM2.1-small camera-predictor +
   gate re-anchor; tap forwarding (tap → point prompt); court prompt + cached
   mask; measure fps/latency on L4 vs A10G.
3. **M3 — SAM 3.1 evaluation**: gated access (owner request NOW) → profile on
   A100/H100 burst: 10-object fps, text-prompt quality on players/refs, court.
   Decision point: promote to core or stay SAM2.1+detector.
4. **V2 — lifter**: MotionBERT-Lite ONNX into the Modal container; packets gain
   kpts3D; dollhouse renders 3D posture (billboard flatness dies).
5. **V3 — avatars**: VRM retarget + IK in dollhouse.
6. **T1 — training jobs to RunPod/Modal** (gate rounds, AthletePose3D
   fine-tune) — local GPU freed permanently.

## 6. Who does what

**Only Kenny (account/payment/legal):**
- modal.com signup (GitHub/Google), add card (past free credits), run
  `modal setup` once on this machine (browser auth) or paste a token.
- HuggingFace account → request `facebook/sam3` + `facebook/sam3.1` gated
  access (do this first — approval lag).
- RunPod signup + card/credits (if chosen for training).
- Vercel env var for the WS-token secret (dashboard access).
- Any future licensing calls (likenesses, footage).

**Claude (scriptable, once tokens exist):**
- Deploy/freeze split of yololab; Modal app code (image, volume, weights
  upload, wss endpoint, snapshots, autoscaler knobs); mpgames server-URL
  setting + token fetch; SAM 2.1 integration + tap-prompt protocol; profiling
  harness + fps/latency report for the SAM 3.1 decision; lifter export +
  integration; dollhouse v2/v3 render work; training-job scripts on
  RunPod/Modal; all wiring, testing, docs.

## 7. Cost picture (steady state)

- Demo serving: **$0–25/mo** (Modal credits absorb light use; L4 ~$0.80/hr).
- SAM 3.1 evaluation: a few A100/H100 hours ≈ **$5–15 one-time**.
- Training: **~$2–8/run** (RunPod 4090 / Modal A100), replacing 3-hour local
  lockouts.
- Scale note: if SAM 3.1 becomes the core, live serving wants A100/H100-class
  (~$2.50–4/hr) — reserve for sessions, scale-to-zero between.
