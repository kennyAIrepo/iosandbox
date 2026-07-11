# Multiplayer Tracking — Infrastructure Plan (build-spec)

Adaptive A/B multi-person tracking on one webcam, browser-only, static-hosted.
Decision record: memory `multiplayer-tracking-architecture`. Research: 2026-07-10 deep-research run.

- **Base (always on):** MoveNet MultiPose Lightning (TF.js/WebGL) → players, stable IDs, crop boxes, wrist anchors. ~17 ms, constant vs player count.
- **Mode B (≤2 players):** + per-crop MediaPipe PoseLandmarker (3D body) + per-crop HandLandmarker (3D hands).
- **Mode A (>2 players):** per-crop HandLandmarker only (body = MoveNet 2D). B ⊃ A; the switch gates ONE call.
- 3D hands + fingers + IDs survive in BOTH modes; only body-3D flexes.

---

## 1. Module map

```
sdk/core/
  tracking.js        [TOUCH]  extract createHandLandmarker()/createPoseLandmarker() factories;
                              initTracking() API unchanged (legacy pages keep working)
  multipose.js       [NEW]    MoveNet MultiPose wrapper (TF.js) → raw tracked poses
  player-tracker.js  [NEW]    track manager: smoothed crop boxes, mirror convention, join/leave,
                              A/B mode hysteresis
  player-pipeline.js [NEW]    per-player bundle: crop canvas + HandLandmarker (+PoseLandmarker),
                              filter banks, coordinate remap crop→frame
  multiplayer.js     [NEW]    public API/orchestrator + frame scheduler

handlab.html         [TOUCH]  "PLAYERS" toggle; MP path with per-player rig pairs; 1P path untouched
tests/
  _multipose.html    [NEW]    stage-1 harness: boxes+IDs over video, per-stage ms
  _mpcrop.html       [NEW]    stage-2 harness: per-player crops + hand landmarks, per-stage ms
  _mpbench.html      [NEW]    benchmark: MoveNet + N×(hands[,pose]) real frame times on target laptop
```

No changes to: filters.js, hand-views.js, hand-rig.js, hopeos.js (already instantiable / legacy).

## 2. Data contract — `PlayerFrame` (the one shape all games consume)

```js
// multiplayer.detect(now) →
{
  mode: 'A'|'B', count: n,
  players: [{
    id: 3,                    // persistent MoveNet track id
    bbox: {x,y,w,h},          // full-frame MIRRORED normalized, smoothed (render-safe)
    body2D: [17×{x,y,score}], // MoveNet kpts, full-frame MIRRORED normalized
    wrists: {l:{x,y}, r:{x,y}},  // hand→player anchors (mirrored space)
    bodyImg: [33×{x,y,z,v}] | null,   // Mode B only — full-frame mirrored (matches tracking.js pose)
    bodyWorld: [33×xyz m] | null,     // Mode B only — raw MediaPipe world (matches poseWorld)
    hands: { left: {img, world}|null, right: {img, world}|null },
    //  img: 21 pts, FULL-FRAME mirrored normalized (already One-Euro-filtered + predictable)
    //  world: 21 pts, metres, raw camera axes — same convention tracking.js emits today
  }]
}
```

**Space rules (single source of truth = player-tracker.js):**
- Video is processed RAW (crops cut from the raw frame; MediaPipe VIDEO-mode needs a stable un-flipped stream).
- Mirroring (`x → 1−x`) is applied ONCE, at emit time, to bbox/body2D/wrists/bodyImg/hand img — so every
  consumer sees exactly today's tracking.js convention. World landmarks stay raw/unmirrored (same as today).
- Crop→frame remap for landmarks: `X = (cx + x·cw)/W, Y = (cy + y·ch)/H`; z passes through unscaled
  (z is wrist-relative in hand landmarks — unaffected by crop position; document, don't scale).

## 3. Per-module spec

### multipose.js (~120 lines)
- `initMultiPose(opts)` → `{ estimate(videoEl, tMs) → poses[], dispose() }`
- Dynamic ESM import from CDN (same pattern as tracking.js): `@tensorflow/tfjs` + `@tensorflow-models/pose-detection`.
- Config: `MULTIPOSE_LIGHTNING`, `enableTracking:true`, `trackerType:'keypoint'` (players stand close),
  `multiPoseMaxDimension: opts.maxDim ?? 256`, `maxTracks: 6`, score threshold 0.25.
- Backend: `webgl` (do NOT await tf.ready before user gesture; init inside camera-on flow like tracker).
- Output passthrough: `[{id, score, box{yMin..}, keypoints[17]{x,y,score,name}}]` in RAW pixel coords.

### player-tracker.js (~180 lines)
- `class PlayerTracker { update(poses, tMs) → tracks[]; get mode(); }`
- Track: `{ id, bboxRaw(EMA), bboxStable, wrists, body2D, lastSeen, pipeline? }`.
- **Crop stabilization** (critical for VIDEO-mode hand tracking): square box around upper body
  (shoulders..wrists extent + 25% pad), EMA-smoothed (α≈0.3), and only RE-SNAPPED when drift > 15%
  of size — landmarkers see a near-static camera, not a jittering one.
- Join: track seen ≥ 5 consecutive frames → acquire pipeline from pool. Leave: unseen > 1.5 s →
  release pipeline (banks dropped, instance kept warm).
- **Mode hysteresis:** enter A when count ≥3 held 0.5 s; back to B when ≤2 held 1.0 s. Exposes
  `mode` + `onModeChange` (UI badge). Never disposes models on switch — B's pose call is simply gated.
- Owns the mirror-at-emit step (§2).

### player-pipeline.js (~150 lines)
- `class PlayerPipeline { async init(fileset); detect(videoEl, bboxRaw, tMs, {wantPose}) → partial PlayerFrame; drop(); }`
- Per instance: 1 offscreen canvas (256×256 for hands; 224 pose input handled by task itself),
  1 HandLandmarker (VIDEO, numHands:2, via tracking.js factory), lazily 1 PoseLandmarker (VIDEO,
  numPoses:1, lite), HandFilterBank ×2 (img + world, same params as handlab), pose banks ×2 (Mode B).
- One landmarker instance per player, VIDEO mode (per-stream temporal state stays clean).
- **Timestamps:** MediaPipe VIDEO mode requires monotonically increasing ts per instance — each
  pipeline keeps its own `lastTs` guard (never reuse one instance across players in the same frame).
- Slot assignment INSIDE the crop = same label-free sort-by-x logic handlab uses today (lines 890–916),
  lifted verbatim; filters keyed `'left'/'right'` per pipeline (bank instance is per-player, so no
  playerID compound keys needed).
- `drop()`: banks.drop both slots + lastTs reset — called on player-leave / pool release
  (mirrors hand-views dropSlot contract).

### multiplayer.js (~120 lines) — public API
- `initMultiplayerTracking(videoEl, opts)` → `{ detect(now) → PlayerFrame; mode(); stats(); dispose() }`
  — deliberately parallel to `initTracking()` so games swap one init call.
- **Scheduler** (per detect() call):
  1. MoveNet every frame.
  2. Hands: players ≤2 → every player every frame; players 3–4 → round-robin (each player's hands
     at 30 Hz on a 60 Hz loop; One-Euro prediction covers gaps — same trick as `poseEvery`).
  3. Pose (Mode B only): per player every `poseEvery` (default 2) frames, offset per player.
- `stats()` → per-stage EMA ms `{ multipose, hands, pose, total }` for the HUD/benchmark.

### tracking.js changes (surgical)
- Extract + export `createHandLandmarker(fileset, opts)`, `createPoseLandmarker(fileset, opts)`,
  `getFileset()` (memoized) from the existing bodies of initTracking. initTracking calls them;
  external behavior identical. The dead `stH` deadband stays for legacy non-raw callers (hopeos.js).

## 4. handlab.html integration (Mode toggle, 1P untouched)

- Toggle: `S.players = '1'|'multi'` (UI chip next to camera toggle). `'1'` = existing path exactly as-is.
- `'multi'`: camera-on calls `initMultiplayerTracking(els.vid, …)` instead of initTracking.
- Loop (steps 1–4, lines ~885–927): in MP mode, `frame.players` replaces the single slot-gather —
  per player the pipeline already returns filtered `hands.left/right`, so the loop reduces to:
  `views[p.id].resolve([p.hands.left, p.hands.right], camera)` → `rigs[p.id].R/L.pose(packs…)`.
- Rig pool: `rigs[id] = { R: new HoloHandRig(REST_R42…), L: …, views: new HandViews({mode:S.mode}) }`
  created on player-join (forge is ~ms-cheap per existing stats), disposed on leave (scene.remove).
  Optional: tint per player id (rig style accent) for readability.
- HUD: add `players n · mode A|B · mp xms · hands xms · pose xms` from stats().

## 5. Build order (each stage runs + is measured before the next)

| # | Deliverable | Acceptance |
|---|---|---|
| 0 | tracking.js factory extraction | handlab/world/play load unchanged (smoke: 1P handlab tracks) |
| 1 | multipose.js + tests/_multipose.html | 2 people → 2 stable IDs surviving cross/occlusion; measured ms on target laptop |
| 2 | player-tracker.js + crop remap + tests/_mpcrop.html | per-player crops stable; hand landmarks land on the correct person's hands in full-frame overlay |
| 3 | player-pipeline.js + multiplayer.js (Mode A end-to-end) | 2-player hands+fingers concurrently ≥20 fps; IDs never swap hands |
| 4 | Mode B (per-crop pose) + hysteresis switch | 2p: 3D bodies present; walk a 3rd person in → auto-drop to A, badge flips, no hitch (models stay warm) |
| 5 | handlab MP toggle + per-player rigs + HUD stats | two players each drive their own rig pair in mirror mode; 1P path byte-identical behavior |
| 6 | tests/_mpbench.html sweep (1–4 players × A/B) | real numbers table → replaces the estimates in the decision memory |

Deferred (separate track, do NOT wire into this loop): YOLO/ONNX-Runtime-Web substrate for
object/seg/SAM/depth world-parsing — new plan doc when started.

## BUILD STATUS (2026-07-10)

BUILT + statically validated (syntax, import graph, API symbols vs real package, CDN 200s):
  sdk/core/tracking.js       factories extracted (getFileset / createHand|Pose|FaceLandmarker); initTracking behavior preserved
  sdk/core/multipose.js      MoveNet MultiPose + async background pump
  sdk/core/player-tracker.js EMA crop boxes, mirror-at-emit, A/B hysteresis
  sdk/core/player-pipeline.js per-player HandLandmarker(+Pose), crop→frame remap, reuses HandFilterBank
  sdk/core/multiplayer.js    orchestrator, warm pipe pool, sync detect(), Mode A+B, setForceMode
  tests/_multipose.html      stage-1: IDs + skeletons + MoveNet ms
  tests/_mpcrop.html         stage-2/3: per-player crops + hand landmarks overlay
  tests/_mpbench.html        stage-6: A/B latency capture → CSV
  handlab-mp.html            stage-5: per-player HoloHandRig pairs, mirror mode, HUD

DEVIATION: stage 5 shipped as a NEW page handlab-mp.html (reuses HoloHandRig+HandViews+multiplayer)
  instead of editing handlab.html — zero regression risk to the shipped single-player lab, which is
  deeply wired to physics/beat/cube. Folding a PLAYERS toggle into handlab.html remains open if wanted.

CAMERA RUN #1 (2026-07-10): multi-person ids ✅, MoveNet clip + MediaPipe fingers ✅.
  Measured: MoveNet 18.2ms; 1p total ~32ms (~31fps); 2p Mode B total ~65ms (~15fps).
  Bug 1: hand mesh laggy + flat/vanishing on finger articulation (even 1p).
    Cause (a): 256² crop canvas — MediaPipe's internal hand-ROI resample got ~80px hands (old stack
    fed the full 1280×720 video). Cause (b): crop box built from body kpts ends at the WRIST; fingers
    extend ~forearm-length past it → fingertips clipped at crop edge → flat/dropped landmarks.
  Bug 2: with 2 players, one player's hand dropped; intruder hand double-tracked.
    Cause: overlapping crops — numHands:2 spent a slot on the OTHER player's (bigger/closer) hand.
  FIXES APPLIED (camera-verify pending):
    player-tracker: crop box extended past each wrist along elbow→wrist ×0.9 (fingertip headroom).
    player-pipeline: cropPx 256→512; numHands 2→4 + WRIST-OWNERSHIP GATE (keep hands whose wrist is
      nearest OUR MoveNet wrist and not nearer another player's; gate r = clamp(0.3·boxsize, .10, .25));
      SOLO FAST PATH — 1 player skips cropping entirely, landmarkers run on the raw video element
      (identical to the old single-player stack); slot side-split uses box centre, not frame centre.
    multiplayer: passes wrists/otherWrists/fullFrame; MoveNet fpsCap 30→24 (GPU contention relief).
  Still open if 2p Mode B stays ~15fps after fixes: poseEvery 3, maxDim 192, or hands-interleave at 2p.

CAMERA RUN #2 (2026-07-10): solo ✅ minimal latency, finger morphing fixed (512 crop + wrist extension
  + solo fast path all confirmed working). 4-hand tracking ✅. NEW PROBLEM: 2p Mode B → 110.9ms (~9fps).
  ROOT CAUSES:
    (1) numHands:4 broke MediaPipe steady-state: palm detector keeps searching until numHands hands are
        locked; with only ≤2 visible it re-ran FULL detection every frame per player. Dominant cost.
    (2) Both players' pose fired on the SAME frames (frameCount%2 for everyone) → spike frames.
    (3) Structural: one thread + one GPU, costs add linearly (worker parallelization = future lever).
  FIXES APPLIED (verify pending):
    numHands 4→2 (tracking mode restored); intruder problem now solved by PIXEL MASKING — other
      players' box regions are painted out of each crop (peephole circles r=0.22·crop around own wrists
      so crossed-over own hands survive); ownership gate kept as 2nd line.
    Pose runs on a separate UNMASKED canvas (mask could cover our own body in the overlap region).
    Pose STAGGERED across players (posePhase=i → ≤1 pose model per frame).
    Pose-cadence GOVERNOR: budgetMs=45; poseEveryDyn 2→..6 stretches when stats.total blows the budget,
      relaxes with headroom. Hands stay per-frame; only body-3D cadence flexes. HUD shows pose 1/N.
  Expected 2p: hands 2×~12ms + ≤1 pose ~18ms → ~40ms ≈ 25fps (vs 9). If still not "solo-like", next
  lever is WEB WORKERS (one pipeline worker per player, VideoFrame transfer) — true parallelism.

TEST TOOLING — fake multi-person from ONE person (sdk/core/test-source.js, CompositeCam):
  Composites the webcam (or a recorded clip via useFile) into a canvas tiled N×, exposed as a
  captureStream — the pipeline sees N real bodies, N pipelines run, intruder-mask fires on overlap.
  Stream identity is stable so retiling needs NO re-init. Wired:
    tests/_mpbench.html — [1× / 2× / 2× overlap / 4×] buttons, live (numbers only).
    handlab-mp.html — ?sim=N URL param (2..4) → visual self-clone test with per-player ghost hands.
    handlab-mptest.html — SANDBOX: handlab-mp's 3D per-player hands + _mpbench's clone/mode/CSV
      controls in ONE page → watch the actual 3D meshes AND latency at the same time. Test ground only.
  Caveat: tiling+capture adds ~1-3ms vs a real N-person camera (absolute ms slightly pessimistic;
  A/B + scaling valid); clones share your motion (use a recorded clip for independent-motion id tests).

## 6. Risks / notes

- **Three GL contexts** (Three.js + TF.js WebGL + MediaPipe GPU) in one page: allowed (~16 limit),
  but VRAM adds up — keep multiPoseMaxDimension at 256, pose model `lite`.
- **TF.js + MediaPipe coexist fine** (different runtimes); both loaded lazily on camera-on, never at page load.
- **Crop feedback loop:** never derive crop boxes from hand landmarks (wobble amplifies) — boxes come
  from MoveNet body only.
- **MoveNet keypoint names** are COCO (`left_wrist`/`right_wrist` are the SUBJECT's left/right, unmirrored);
  after the mirror-at-emit step they flip sides — player-tracker owns this and emits screen-space `l/r`;
  downstream stays label-free anyway (chirality is measured, wrists are only crop/association anchors).
- **Model URLs:** MoveNet weights come from TF Hub via pose-detection (CDN-hosted, cached); MediaPipe
  tasks stay on jsDelivr + Google storage as today. All static-host compatible. Later hardening:
  self-host copies in `models/` (both APIs accept a modelUrl/modelAssetPath override).
- **Numbers discipline:** every stage harness prints per-stage ms; the ~15–23 fps envelope in the
  decision memory is ESTIMATED and must be replaced by _mpbench results at stage 6.
