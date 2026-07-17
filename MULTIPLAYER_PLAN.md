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

GAME-SUITE MERGE (2026-07-11): mpgames.html = handlab.html clone + single/multi switch.
  PLAYERS panel section (👤 Single / 👥 Multi). Single = ORIGINAL stack, untouched (all MP branches
  inert when S.mp=false). Multi = lazy-loaded sdk/core/multiplayer.js (TF.js only loads on first use):
  sticky PRIMARY player (largest bbox, kept while in frame) drives ALL existing games/physics/body via
  a frame-shim (pipeline output is already filtered+predicted → single-player re-filter bypassed, never
  doubled); extra players (≤3) get pooled render-only rig pairs w/ own HandViews (occluder/cover/handY/
  swap/style all live-synced). Beat-game dodge uses MoveNet nose when Mode A sheds the 3D body.
  multiplayer.js gained pause()/resume() (MoveNet pump suspends in single mode, models stay warm).
  Mode switch live at runtime, both directions, filter state dropped on handover. Camera-verify pending.
  v1 SCOPE: games are primary-player-driven; per-player scoring/interaction = research phase (next).

MPGAMES v2 (2026-07-13): body-render toggle + latency control + co-op beat.
  - BODY RENDER: default is now SKELETON (2D bone-line overlay + holo hands, same look as
    handlab-mptest) instead of the HoloBodyRig silhouette. New "BODY · render" menu: 🦴 Skeleton /
    🧍 Avatar. Skeleton = MoveNet 17-pt COCO per player (multi) or MediaPipe 33-pt (single), drawn on
    a 2D overlay canvas #ov (z under the hand canvas), cover-corrected. Avatar = the old silhouette
    mesh (primary/driving player), opt-in. Silhouette rig now gated on S.bodyRender==='avatar'
    (skeleton mode poses both body rigs null). Overlay only draws in mirror view.
  - LATENCY: "LATENCY · model switch" menu (Auto / A / B) → mt.setForceMode; applied on MP-on and
    live. Auto = multiplayer.js hysteresis (B ≤2p, A >2p); pose-cadence governor already self-tunes.
    Metrics HUD shows `multi Np·mode · mp Xms · pose 1/N`.
  - CO-OP GAMES: beat-game.js extended 2→N hands (lazy-grow _handMeta/_handPts; backward-compatible,
    handlab still passes 2). Each MP player gets a HandBody pair (added to mpSlots); all players'
    hands feed beatGame → everyone punches the shared note stream (co-op, one score). Cube/ball stay
    primary-driven (object ownership/passing = still research). Full body physics (bodyBody, jump)
    active in avatar mode; skeleton mode uses headX for dodge (hand-driven games unaffected).
  Syntax-verified (beat-game.js, multiplayer.js, mpgames module). Single-player path untouched
  (all new logic guarded by S.mp / S.bodyRender). Camera-verify + push pending. STILL uncommitted.
  NEXT (research phase): per-player scoring/scoreboards, object passing between users, avatar-avatar
  collision, competitive vs co-op modes, landmark-misalignment prevention in multi.

CAMERA RUN #3 + FIX SET (2026-07-13): "mesh bloats + goes latent once >2 hands appear" in mpgames MP.
  ROOT CAUSE (bloating/misalignment — CONFIRMED in source): CROP-SPACE Z LEAK. MediaPipe normalizes
    landmark z like x — to the IMAGE IT SAW. Per-player pipelines see a CROP (bw≈0.4–0.6 of frame),
    but hand-views mirrorPoint() scales depth assuming FULL-FRAME z (depth = d + z·sW·mirrorDepth,
    hand-views.js:248). Unscaled crop z reads ~1/bw× too deep → depth·(s=depth/d) ray-scaling balloons
    the mesh + makes it swim. Solo fast path (bw=1) unaffected → exactly "1p fine, 2p+ bloats".
    FIX: player-pipeline remaps z·bw to full-frame units (hands img + pose img). World lm unaffected.
  LATENCY (mpgames-specific stack-up, fixed):
    (1) CompositeCam was ALWAYS in the boot path → canvas+captureStream hop = +1 frame (~33ms) on
        detection + bg video. FIX: raw initCamera by default; clone-test lazily builds CompositeCam
        from a CLONE of the live stream (new useStream() — no 2nd getUserMedia) and swaps srcObject
        live; 1× swaps back to raw. Zero overhead when not clone-testing.
    (2) Primary-swap smear: chirality/z-sign latches persisted across a primary-player handover.
        FIX: drop views slots when mpPrimaryId changes.
  CUBE 4-HAND / 2-PERSON HANDOVER (built):
    - Unique HandBody identities for extra players (slot 'left#<id>'/'right#<id>') — grab/held/twist
      compare slot strings; two players' lefts no longer alias.
    - ballColliders rebuilt per frame: [primary L, R, bodyBody, ...every extra player's hands] —
      cube + ball grab/collide/z-bias now see ALL hands (z-bias seeks nearest palm of ANY player).
    - HANDOVER mechanics (v1): release-then-take — A opens grip (grace frames) while B grips → B's
      grab takes it, same GrabbableBox rules. Two-person palm-CLAMP also works (clamp is slot-agnostic).
    - TWIST generalized: A = holder resolved across all hands; B = strongest-gripping OTHER hand of
      ANY player (twistG.twistSlot) → cross-person "one holds, the other twists a layer". Null-guards
      for a holder leaving the frame.
  STILL OPEN (accuracy framework, next iterations): tug-transfer (grab-from-a-holding-hand without
    release), per-player glow/score attribution, MoveNet-wrist velocity compensation in the ownership
    gate, crop-z calibration for non-square crops (bw vs bh — currently width-normalized like MP docs).
  Syntax-verified; single-player + handlab untouched. Camera-verify pending. STILL uncommitted.

CAMERA RUN #4 + FIX SET (2026-07-13): 4× clone test — bodies 4/4 ✅, hands degrade with count:
  4th player's hands never track; 2nd/3rd hands laggy, small/offset mesh, no finger curl.
  THREE ROOT CAUSES FOUND + FIXED:
  (1) STRETCHED CROPS: crop boxes were square in NORMALIZED units → on a 16:9 frame that's a
      1.78×-wide pixel rectangle drawn into a square canvas → every landmarker saw a widened hand →
      degraded geometry/z/finger-curl + shrunken/offset mesh (x/y remap cancels the stretch but the
      MODEL's estimates suffer). FIX: player-pipeline reshapes to square-in-PIXELS before cropping.
  (2) GL-CONTEXT CEILING: every pipeline eagerly built HandLandmarker+PoseLandmarker (a GL context
      each); with Three.js + TF.js + idle single tracker + 4 pipes×2 ≈ browser WebGL context limit →
      pipeline #4 creation fails/thrashes → "4th player's hands never track". FIX: PoseLandmarker is
      LAZY (created on first Mode-B ask); prewarmed 2 pipes keep eager pose (they serve ≤2p Mode B),
      growth pipes never build one in Mode A.
  (3) BLIND ROUND-ROBIN: >2 players halved EVERY player to ~15Hz hands even when only 1-2 had hands
      raised. FIX: ACTIVITY-BASED SCHEDULER — live-handed players detect every frame (≤2 live) or
      staggered 1/2 (3-4 live); hand-less players PROBED every 4th frame (discovery <~130ms); skipped
      frames bridged by new pipe.predictOnly() (One-Euro velocity extrapolation, zero GPU) so gaps
      never read as frozen. pipe.handsLive() drives the scheduler.
  Syntax-verified. If 4p hands still heavy after this: web workers remain the structural lever.

SOURCE FEATURE (2026-07-13): screen-share / URL / file tracking in mpgames — PURE FEATURE LAYER
  (zero sdk/core changes; verified empty sdk diff). New SOURCE panel: 📷 Camera / 🖥 Screen / 🔗 URL /
  📁 File. Screen = getDisplayMedia (the YouTube path — user shares the tab; consent replaces CORS,
  captured pixels are canvas-clean); URL = direct .mp4 w/ crossOrigin (CORS-blocked → toast → use
  File); File = local clip via object URL; bgVid synced via captureStream. MIRROR ARCHITECTURE: the
  stack's mirrored convention is untouched — body.ext-source CSS un-flips the video and CSS-flips
  #ov/#c so mirrored coords land un-mirrored on un-flipped footage (badge text counter-flipped in
  draw). External source auto-forces mirror view + 🦴 skeletons display (restores prior display on
  camera return); browser "stop sharing" bounces back to camera. NOISE REJECTION (no YOLO, shipped):
  🎯 TAP-TO-LOCK — pointerdown hit-tests last frame's player bboxes (x un-mirrored for ext), toggles
  ids in a locked set; when non-empty only locked ids render (render-side: tracker still sees all,
  unlock instant, ids never reset). 🙈 SIZE GATE — bbox.h < 0.17 skipped for ext sources (audience/
  far figures). Known limits: MoveNet 6-person cap + tiny broadcast bodies → full NBA court needs
  the YOLO/ByteTrack pipeline (separate track); DRM tabs capture black.

YOLO TRACKING TRACK (2026-07-16, research + local setup): MoveNet's 6-cap + ID drift + fast-motion
  failure on NBA footage → move detection to YOLO + a real MOT tracker. THE PIPELINE (from NBA/sports
  prior art): YOLO detect (no person cap, imgsz 960+ for small players) → ByteTrack (motion+low-conf
  assoc, fast) OR BoT-SORT (adds appearance ReID, occlusion-robust, right for crowded court) →
  IDENTITY layer for cut-proof persistence: team-color cluster (drop refs/crowd) + jersey-number OCR
  with 30-50 frame voting + ReID embeddings (CLIP-ReIdent) → optional court homography → XY.
  DEPLOY: (A) client ONNX-web (light, ~handful of people) or (B) CLOUD-PROCESS on GPU + stream
  {id,box} JSON per frame over WebSocket → browser renders+taps (recommended for NBA scale; removes
  browser-GPU ceiling; latency = 1 round-trip, hidden by existing One-Euro predict). Plugs into our
  stack as a SOURCE SWAP — multiplayer.js already consumes {id,bbox,keypoints}; "YOLO-over-WS"
  replaces MoveNet, render/tap/skeleton layers unchanged. Prior art: roboflow identify-basketball-
  players, github j7yn/nba-vision, ahmed-nady/Sports-Player-Identification, arxiv TrackID3x3
  (2503.18282), SoccerNet GSR-2024 winner, CLIP-ReIdent (2303.11855).
  LOCAL SETUP (C:/Users/hanna/yololab, OUTSIDE the git repo — venvs/weights never committed):
  Python 3.11.9 + RTX 4060 8GB (cu124 torch) + ultralytics + onnx/onnxruntime. Scripts: check_gpu,
  track.py (YOLO+ByteTrack/BoT-SORT → annotated mp4 + tracks.jsonl = the browser payload), train.py
  (fine-tune on Roboflow basketball data), export_onnx.py (opset12/dynamic → onnxruntime-web),
  shell.bat/run.bat, FOUNDATIONS.md (theory→practice teaching). Build order in FOUNDATIONS.md §5.

YOLO SMOOTHNESS + TEAM-COLOR FIX SET (2026-07-16 #2): jitter/steppy motion root causes:
  (1) interp formula rendered the NEWEST snapshot on arrival then froze → frame-by-frame stepping.
      FIX: render ~one update-interval BEHIND (delay = min(260, span·1.1)) — always moving between
      two known snapshots (networked-game standard). Cost ~90ms display latency, buys butter.
  (2) raw pose keypoints shake px-level per frame → per-id One-Euro banks (HandFilterBank count:17,
      minCutoff .5, beta 1.0) applied at snapshot ingestion, cloned (banks reuse arrays).
  (3) server ran imgsz 1280 on a 960px upload = pure upscale waste → imgsz 960 match (67→54ms gpu).
  TEAM-COLOR CLASSIFICATION (no training): server samples each player's TORSO via shoulder/hip
  keypoints (not box crop — box is mostly court), median BGR, online clustering into ≤4 team
  centroids (EMA-adapting) → payload {team, col}. Browser: skeleton/box coloured by ACTUAL jersey
  colour (brightened), badge shows P<id>·T<team>. Validated e2e: 2 teams separated on test image.
  DECISIONS (user, 2026-07-16): identity = BOTH, SEQUENCED — tap-to-enroll appearance ReID first,
  jersey-number OCR later as the broadcast confirmation layer. Perf profile = FAST 960 default.
  Deploy = LOCAL-ONLY for this build; afterwards flag user to design/implement CLOUD + continued
  jitter/model/training-data evolution (model choices + detection fine-tuning iterate over time).

REAL-TIME-FEEL + IDENTITY REGISTRY (2026-07-16 #3):
  "Not real time" fix = VSYNC: ring-buffer the footage client-side and DISPLAY it delayed by
  rtt+interp (~150-250ms) so video and skeletons are IN SYNC — alignment is what makes tap feel live
  (broadcast-graphics standard). #dvid canvas covers bgVid when YOLO+ext-source+vsyncChk. Plus fp16
  server inference (54→42.5ms gpu) and SCENE-CUT detection (64×36 gray mean-diff>28) → client clears
  interp/banks on cut (no cross-cut smearing).
  IDENTITY (research-grounded): faces are 10-20px at broadcast res — NOT viable (Sports Re-ID lit);
  what works = fusion of court position + appearance + team + height. Built v1: 📐 4-tap court
  calibration (NBA paint 4.88×5.79m, DLT homography) → feet→metres; IDENTITY REGISTRY client-side —
  stable tags (A,B,C…) re-match new server ids to recently-lost entities by court-distance + team +
  jersey-colour + size (cost fusion, <85 threshold, 0.4-15s window); 🔒 locks FOLLOW the person
  across id changes; lock card shows court position + "identity held" through cuts.
  NEXT (sequenced per user decision): OSNet appearance embeddings server-side (tap-to-enroll
  gallery), jersey-number OCR + voting, Deep-EIoU-style tracker (SportsMOT winner — motion-agnostic,
  Kalman assumes linear motion which athletes violate), basketball fine-tune via train.py. Then CLOUD
  deploy (flag user for design). Refs: arxiv 2306.13074 (Deep-EIoU), 2206.02373 (Sports Re-ID),
  2602.00484 (GTATrack/SoccerTrack25), SoccerNet GSR winner.

DOLLHOUSE (research notes — NOT built): live 3D miniature of tracked players. Lightweight path:
  (1) MoveNet 2D skeletons (already have, 6 cap) or YOLO+RTMPose for crowds; (2) GROUND POSITION via
  court homography — 4+ known court points → H matrix → each player's ankle midpoint lifts to court
  XY in metres (the key trick: no depth model needed for placement); (3) POSE LIFT: drive premade
  low-poly avatar rigs (the existing BodyPose.retarget FK pattern — bone DIRECTIONS from 2D+canonical
  proportions, lengths from the rig) — same predictive-model philosophy as the hand rig; (4) render
  the rigs in a second three.js scene = orbitable "dollhouse". Prediction/interp covers occlusion
  gaps (One-Euro per track id). All client-side, no server. Camera cuts reset H → detect cut (frame
  diff spike) + re-solve homography or freeze dollhouse. Build AFTER the source feature proves out.

SKELETONS GROUP MODE (2026-07-13): new SHOW option `🦴 Skeletons` in mpgames — body-only tracking
  for LARGE GROUPS (up to 6 people, MoveNet's cap), zero hand models. multiplayer.js gained
  setHandsEnabled(false) → skeleton fast path in detect(): players get id/bbox/body2D/wrists only,
  NO pipelines touched → detect() cost ≈ 0 (MoveNet is async); + setMoveNetFps (multipose.setFps) —
  the pump runs hotter (30) in this mode since the whole GPU budget is MoveNet's. Selecting it
  auto-enables Multi (rides the MP engine), hides hand rigs everywhere (single-mode gather guard,
  extras block guard, avatar gates), draws per-player-colored skeletons + strict `P<id>` badge above
  each head, body checkbox can't exit it. Other modes untouched. Leaving restores hands + 24fps pump.

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
