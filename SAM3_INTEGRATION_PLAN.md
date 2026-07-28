# SAM 3 Integration Plan — concept-prompt tracking, scene geometry, MHR body rigs

Research synthesis, 2026-07-27. Goal: upgrade the cloud tracking core from
SAM 2.1 taps to **SAM 3.1 concept prompts** (text = the prompt: "floor",
"wall", "person", "basketball"), turn tracked masks into **JS collision
meshes** in three.js, and adopt **SAM 3D Body / MHR** as the 3D body-rig
tier that our MoveNet/MediaPipe landmarks prompt directly. HF access: granted
(account-side); the node still needs `huggingface-cli login`.

---

## 1. What the research says (verified 2026-07)

### SAM 3 / 3.1 — the tracking core upgrade
- **`facebook/sam3`** (0.9B params) is in **HF transformers**: `Sam3VideoModel`
  + `Sam3VideoProcessor`, with a **streaming session API** — init a session
  with no video, feed frames one at a time (`model(inference_session, frame)`).
  This is exactly our frame-lane shape; no offline-video assumption to fight.
- **Prompts compose**: text concept ("person") + visual refinements — a
  **negative box** *excludes* a region from the concept. Our ref-exclude role
  maps 1:1 onto negative prompts; player taps map onto positive point/box.
- **SAM 3.1** (2026-03): **Object Multiplex** — up to 16 objects per forward
  pass, ~2× throughput (16→32 fps H100 medium counts), ~7× at 128 objects,
  **~4 GB VRAM in FP16 on consumer cards**, zero accuracy loss. A distilled
  **sam3.1-tiny runs >60 fps on an L4** — the 5090 comfortably beats an L4.
  Full-scene NBA tracking (10 players + ball + refs + floor) in one multiplex
  pass is realistic on our card. Profile before committing (fps claims vary
  by resolution/object count).
- **Realtime bridges exist**: `matteo-tafuro/sam3-realtime` (and the
  `Jeffjewett27` fork) wrap SAM3 for webcam/RTSP incremental inference.
  Caveats they hit that we must design around: single-GPU sessions, and a
  **memory leak on long streaming sessions** (~5 min @480p on a 3090) →
  budget for **session recycling** (periodic re-init, re-seed via last masks;
  our client-side identity registry already re-matches ids across resets).
- **Fine-tuning is supported** (official repo + Roboflow end-to-end tutorial,
  COCO-format in). Our 3,620-frame `player/other/ball` dataset + 270 human
  corrections can fine-tune the *concepts themselves* — long-term this can
  absorb the YOLO gate's job; near-term **the gate stays** (SAM 3 still can't
  do player-vs-bench attribute reasoning reliably; our classifier on mask
  crops remains the arbiter).
- License: SAM License (commercial OK, restrictions), weights gated on HF.

### SAM 3D Body + MHR — the 3D rig tier
- **`facebookresearch/sam-3d-body`** (checkpoints `facebook/sam-3d-body-vith`
  / `-dinov3`): single-image full-body mesh recovery, **promptable with 2D
  keypoints and masks** — i.e. our MoveNet/MediaPipe keypoints and SAM masks
  are literally its native prompt format. Per-frame (no temporal mode) →
  smooth with per-id One-Euro on pose params (same pattern we run on 2D kpts).
- Output = **MHR (Momentum Human Rig)** parameters: **45 shape / 204 pose /
  72 expression**. Skeleton and surface are decoupled — shape is the identity,
  pose is the motion.
- **`facebookresearch/MHR`**: parametric rig with **FBX/glTF export**, LODs
  **595 → 73,639 verts**, >120 fps skinning on a desktop GPU, PyTorch API.
- **The web path this unlocks**: export a shape-personalized MHR mesh at a low
  LOD **once per tracked identity** (~a GLB the client caches), then stream
  only the **204 pose floats (~0.8 KB/person/frame)** in the presence packet.
  three.js `SkinnedMesh` applies bone poses client-side. This is the hand-morph
  pattern from handlab at body scale, and it supersedes the MotionBERT-lifter
  plan (v2 in SAM_MIGRATION_PLAN.md): 3D pose + mesh come straight from the
  frame, anchored to the exact tracked person by mask+keypoint prompts.

### SAM 3D Objects — static scene → textured meshes (the "texture later" tier)
- **`facebookresearch/sam-3d-objects`**: full 3D shape + **texture** + layout
  from a single image; composes aligned meshes into coherent scenes; seconds
  per reconstruction (not per-frame). SAM License, commercial OK.
- Right split for us: **dynamic actors** = SAM 3.1 per-frame packets;
  **static scene** (room, furniture, court) = one-shot 3D-ify per scene/cut,
  cached, shipped to the client as GLB. Dollhouse gets real textured world
  geometry without per-frame cost.

## 2. Floors/walls → collision meshes (the JS modeling layer)

SAM gives 2D mask polygons per concept per frame. Collision needs 3D planes.
Staged, cheapest-first:

1. **Floor v1 (ship first)**: we already solve a ground homography (📐 4-tap
   court calibration → metres). Generalized room mode: prompt "floor" → mask
   poly + homography ⇒ a ground-plane mesh in three.js. `courtXY()` already
   maps feet to plane coords — objects standing on the floor get world XY
   for free (this is the existing court pipeline, renamed).
2. **Walls v1**: the wall mask's **base seam** (wall∩floor boundary line in
   the image) projects through the homography to a line on the ground plane ⇒
   extrude vertically = wall plane. Pure client-side JS geometry from the
   packet polys — no new model. Good enough for ball-bounce / avatar-blocking.
3. **Scene v2**: SAM 3D Objects one-shot on a keyframe → true 3D meshes with
   texture for furniture/court; align to the floor plane; cache per scene,
   invalidate on cut (we already detect cuts server-side).
4. **Collision wiring**: meshes register into the same collision layer the
   games use (hand/game-object contact in the handlab stack) — game objects,
   the ball, and avatars collide with floor/walls/furniture. Packet →
   `THREE.Shape(poly)` extrusions; static bodies, so cost is negligible.

## 3. Protocol — presence packet vNext (additive, back-compatible)

Per-frame, added fields only (old clients ignore them):

```
{ players:[{id, tag, team, col, bbox, body2D,
            mhr?: {pose:[204]},            // S4: 3D rig tier
            }],
  objects:[{id, concept:"floor|wall|chair|…", polys:[[x,y]…],
            plane?: {n:[3], d}}],          // S3: fitted plane when solvable
  scene3d?: {glb_url, cut_id},             // S5: cached one-shot scene mesh
  ms, sms, cts, cut, filtered, rej, balls, court }
```

Client → server additions:
```
{cmd:'concept', text:'floor', on:1}        // free-text concept prompt chips
{cmd:'anchor', x, y, role, neg?:1}         // neg → SAM3 negative prompt
```

**The invariant holds: the packet is the contract.** Dollhouse, room bus,
games don't change when the model underneath swaps.

## 4. Serving layout on the 5090 (VRAM 33.6 GB, ~17.5 free today)

| Component | VRAM (est.) | Note |
|---|---|---|
| SAM 3.1 full, FP16/bf16 | ~4–6 GB | multiplex pass: players+ball+refs+floor+walls |
| SAM 3D Body ViT-H | ~2–3 GB | only on locked/enrolled ids, N ≤ 4 to start |
| YOLO gate + pose (current) | ~2 GB | keeps player/bench arbitration |
| headroom | ~6+ GB | sam3.1-tiny swap if fps demands |

Dev on a **second port** (`sam3_serve.py` on :8766 + its own quick tunnel),
so the working SAM 2.1 demo on :8765 is never at risk. A/B by `?server=`.
Recycle streaming sessions every ~3–4 min (leak reports) — re-seed prompts
from last masks; identity registry bridges the reset.

## 5. Execution order

- **S0 — access + env** (blocked on owner): `huggingface-cli login` on the
  node; accept gated terms for `facebook/sam3`, `facebook/sam-3d-body-*`;
  `pip install transformers huggingface_hub` into a **fresh venv** (keep the
  serving venv untouched); pull checkpoints to `~/hopeos/sam3_ckpts/`.
- **S1 — streaming core**: `sam3_serve.py` (:8766) — transformers streaming
  session per client; same wire protocol + `concept` cmd; profile fps on the
  5090 at 960px with 12 objects (full vs tiny, multiplex on). Decision point:
  SAM 3.1 as core vs SAM 2.1 + gate re-anchor.
- **S2 — concept UI** (mpgames): role picker grows into a **prompt palette**
  — chips (player/ref/ball/floor/wall) + a free-text field; concept-colored
  masks (smasks already carry `role`); works on every source (cs-11 shipped
  that groundwork).
- **S3 — collision meshes** (client JS): floor/wall plane fitting from packet
  polys (§2.1–2.2); three.js static bodies in the game collision layer.
- **S4 — MHR rig tier**: sam-3d-body on locked ids (keypoints+mask prompts
  from what we already track) → pose params in packet; MHR→GLB per identity;
  dollhouse swaps stick figures for skinned MHR avatars. One-Euro on pose
  params server-side.
- **S5 — scene 3D-ify**: SAM 3D Objects keyframe reconstruction → cached
  scene GLB → dollhouse world geometry + textures.
- **S6 — concept fine-tune**: our dataset+corrections → SAM3 fine-tune
  ("player"/"referee"/"ball" as learned concepts) on the 5090 or a cloud
  burst; evaluate retiring the YOLO gate.

## 6. Open risks

- **fps on the 5090 is unmeasured** for our object counts/resolution — S1's
  profiling gates everything; sam3.1-tiny is the fallback.
- **Streaming memory leak** (community-reported) — recycling is designed in,
  but verify against long sessions early.
- **SAM 3D Body per-frame cost unknown** — may need to run at 5–10 Hz on
  locked ids only, interpolating pose params between (packet interp already
  exists client-side).
- **Gated checkpoints** — S0 needs the owner's HF login on the node; approval
  lag if `sam-3d-body` access isn't already granted alongside `sam3`.
- **SAM License** — commercial use OK with restrictions; re-read before any
  hosted/paid launch.

## 7. Sources

- https://github.com/facebookresearch/sam3 · https://huggingface.co/facebook/sam3
- https://ai.meta.com/blog/segment-anything-model-3/ (SAM 3.1 / Object Multiplex)
- https://github.com/matteo-tafuro/sam3-realtime (streaming wrapper; leak+recycle notes)
- https://github.com/facebookresearch/sam-3d-body · https://huggingface.co/facebook/sam-3d-body-vith
- https://github.com/facebookresearch/MHR (45/204/72 params, glTF export, LODs)
- https://github.com/facebookresearch/sam-3d-objects (textured scene meshes)
- https://blog.roboflow.com/fine-tune-sam3/ · https://blog.roboflow.com/sam-3d/
- https://docs.ultralytics.com/models/sam-3 · https://pyimagesearch.com/2026/03/02/sam-3-for-video-concept-aware-segmentation-and-object-tracking/
