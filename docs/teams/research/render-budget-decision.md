# Decision: render architecture for the Teams twin AND the meeting-stage app

Gap: `research/ui/overlay-sketches.md:29-45` (design P, one WebGL canvas per tile + a 2D transit canvas, :115-123) was never
rendered or measured (`research/ui/SUMMARY.md:98`), while `:121` already prescribes a single WebGL surface for the
meeting-stage app (container D). Measured here with `render-budget.html` + `probe-render-budget.mjs` (numbers in
`results.md`, screenshots in `shots/`). Box: Snapdragon X ARM64 Windows laptop, headless Chrome through ANGLE D3D11 on the
Adreno X1-85 - a LOWER BOUND for a pilot laptop with a discrete or Apple GPU; see `SUMMARY.md` caveats.

## 1. Recommendation: design S (single surface) for the twin and for the stage app, with the 2D hands layer kept per tile

**S = one transparent `WebGLRenderer` sized to the stage, `setScissorTest(true)`, one scissored viewport + one
`PerspectiveCamera` per tile, one scene; the ball is ONE mesh in court coordinates; per-tile 2D `.tile__hands` canvases stay
for remote skeletons (packets) and for local hands when no HoloHandRig is wanted.** The twin and the container-D stage app
then share one render architecture (the stage app simply draws its own tiles under the same surface).

Why, in order of weight:

1. **Contexts.** Chrome's ceiling is **16 active WebGL contexts per page**, measured: the 17th `getContext` evicts the
   OLDEST context (`WARNING: Too many active WebGL contexts. Oldest context will be lost.`), and the oldest is the three.js
   renderer created at page start (`THREE.WebGLRenderer: Context Lost.`, `shots/S-t3-h1-p0-r1-720-x24.png` - rigs and ball
   simply vanish, zero exceptions, draw calls 0). Design P costs **N + k + 1** contexts (N tile renderers, k hand
   landmarkers, 1 pose); at 9 tiles + 3 hands + pose that is 13 - three short of the cap before a face landmarker (+1),
   MoveNet/TF.js (+1), a self-view or PiP renderer (+1) or the user's other tabs (the cap is per page, but GPU memory is
   shared). Design S costs **1 + k + 1** (= 5 at the same configuration), leaving 11 in hand. MediaPipe holds exactly one
   context per landmarker (`ctx list` column: `m2` = a 1x1 OffscreenCanvas webgl2 context), confirming
   `research/codebase/multi-person.md:34`.
2. **Same pixels, no seam - with one material rule.** The ball straddling the gutter is rendered by two scissored passes
   of the same scene with the same px-per-metre; `Rpx cam0 / cam1` equal `R_court * th` in every S run (26.64 = 26.64 px
   at 526x296 tiles, 17.46 at 346x194 ...). The two cameras do sit a tile pitch apart, so a LIT sphere showed a flat
   brightness step at the mid-gutter (`edge-scan-lit.txt`: 63,67,129 -> 87,92,172); a `MeshMatcapMaterial` ball (shading
   indexed by the view-space normal, identical from every eye) scans as one monotone gradient through the gutter
   (`edge-scan.txt`). In P the transit is a separate 2D disc (now drawn from the same matcap image, within ~7 RGB units of
   the 3D sphere) plus the sketch's unstated requirement that a ball straddling an edge exists in BOTH tile scenes at once
   (first-pass `P-*-edge.png` had the far half missing), plus the tile ring chrome crossing the ball at every edge.
3. **Render cost is a wash on the main thread; the cadence is video-bound.** Script p50 with 3 rigged local tiles + pose:
   P 25.5-28.4 ms, S 24.7-27.1 ms at 720p (flat in tile count 3..9); render() itself 0.2-0.4 ms in every row for 13 draw
   calls / ~363k triangles (`*-nolm` rows: rig posing + resolve alone = 3.6-4.2 ms for 3 tiles). Every configuration with
   >= 3 cloned video tiles runs at a 33.3 ms rAF cadence on this box - including video-only rows with one idle context and
   0.3 ms of script - so the frame gap measures headless video compositing, not P vs S. The decisive costs are the contexts
   (1) and the per-tile bookkeeping S centralises, not draw time.
4. **One architecture.** `overlay-sketches.md:121` already needs S for the stage app; keeping P for the twin would mean
   maintaining two ball-render paths (3D in-tile + 2D transit) and two "no pop" rules. With S the transit canvas, the
   radius-matching rule and the 3D<->2D hand-off code disappear.

What S does NOT change: prop physics stays per tile in tile-local metres (doctrine untouched); the 2D hands canvas per tile
stays (cheap, clipped by the tile radius, remote tiles never need WebGL); tracking still never touches the tile video.

## 2. The camera / frustum rule that keeps the projected radius equal at every tile edge (replaces space-mapping.md s5/s8 "transit" text)

Definitions (all measured in the probe, `render-budget.html` "three.js: per design" block):

- `th` = tile height in CSS px (gallery rule B gives ONE `th` per viewer, `layout-spec.md` s2); `pxPerUnit = th`
  (`space-mapping.md` s8). Court unit = tile height (s2).
- `d` = hand-plane distance = `HandViews` `mirrorDist` 2.0 m (`hand-views.js:96`); `fov` = 50 (handlab.html:276).
- **`U = 2 * d * tan(fov/2)` = 1.8652 m** = metres of frustum height at the hand plane per court unit. Every tile camera has
  the same `fov`, `aspect = tw/th`, and `d`, so every camera has the same scale **`th / U` px per metre at the hand plane**.
- Court -> stage px: per tile rect (s8): inside tile i `px = left_i + (x - x0_i) * th`, `py = top_i + (y0_i + 1 - y) * th`;
  inside a gutter, lerp between the neighbours' edges (the seat-map gutter `G = 0.08` is squeezed to the DOM gap - position
  only, never radius).
- Stage px -> world: `wx = (px - stageW/2) / th * U`, `wy = (stageH/2 - py) / th * U`, `wz = -d`.
- **Camera i**: `PerspectiveCamera(fov, tw/th, 0.01, 50)` at world `((cx_i - stageW/2)/th * U, (stageH/2 - cy_i)/th * U, 0)`
  looking down -z (`cx_i, cy_i` = tile centre in stage px), `setViewOffset(tw, th, -gap/2, -gap/2, tw+gap, th+gap)`;
  GL viewport = GL scissor = tile rect grown by `gap/2` on every side (y flipped: `stageH - top - h`). The half-gutter
  extension makes adjacent viewports tile the stage without overlap, so a ball in the gutter is drawn by both halves with
  the same scale. `HandViews.mirrorPoint` reads `camera.fov/aspect` (`hand-views.js:243`), not the view offset, so `u,v in
  [0,1]` still map to the tile rect (rigs sit inside the local tile in every screenshot).
- **Ball**: ONE mesh, radius `R_w = R_court * U`, position `world(courtToPx(x, y))` with `wz = -d`. Projected radius is
  **`R_px = R_court * th` at every point of every viewport** (measured `26.64 = 26.64` px at 1280x720/4 tiles, `21.06` at
  9 tiles, etc. - `Rpx` column) - the "no pop" rule becomes a construction, not a matching step.
- **Depth caveat**: cameras sit at different x/y, so only objects ON the hand plane project identically across two
  viewports; objects at `wz != -d` show parallax at the seam. The court is one plane and depth is tile-local
  (`space-mapping.md` s6), so: force `d = 0` (hand plane) from LAUNCH until CLAIM. Held/in-tile props may have depth.
- **Shading rule for anything that crosses a gutter**: the two eyes differ by a tile pitch, so a lit sphere shows a
  brightness step at the mid-gutter even though its disc is continuous (measured, `edge-scan-lit.txt`). Crossing props use
  view-independent shading - `MeshMatcapMaterial` (the matcap disc is identical from every eye; `edge-scan.txt` is one
  smooth gradient) or an unlit material. Held props inside one tile may be lit normally (one camera draws them).
  Alternative if a lit look must survive transit: a stage-wide pass for layer 0 with ONE shared eye at the stage centre
  (`fov_stage = 2 * atan((stageH / th) * tan(fov / 2))`, same `th / U` scale at the plane) - seamless for any material,
  but its depth buffer is incompatible with the tile passes (different projections), so hands cannot occlude the ball during
  transit; acceptable, since a ball in transit is never in a hand.
- **Layers**: `HoloHandRig` meshes are `frustumCulled = false` (`hand-rig.js:283`, `:310`), so tile i's rigs go on
  `layer 1 + i` and `camera_i.layers.enable(1 + i)`; ball, lights and shared props stay on layer 0. Without this every pass
  draws every rig.
- **Renderer**: `autoClear = false`, one full-stage scissor+clear per frame, then N passes; `info.autoReset = false` if you
  read draw-call stats; `setPixelRatio(min(dpr, 1.5))` at 1080p+ (the surface is stage-sized, 4x the pixels of one tile
  at dpr 2).

## 3. Stacking order update (proposed patch copy: `layout-spec.patch.md`)

`--tw-z-tile 0 < hands 5 (per tile 2D) < surface 6 (one WebGL canvas over the stage; --tw-z-ball aliases it) < chrome 7
(tile ring / label / pills, above the surface) < selfview 10 < controlbar 20 < panel 30 < dialog 40 < toast 50`.
`.tile` must not create a stacking context (`z-index: auto`) so its chrome can sit above the stage-level surface.
The `.tile__props` canvas and the `.stage__transit` canvas are deleted. Also fix in the token generator: the `--tw-*` colour
aliases are resolved on `:root` before `.tw-meeting` re-themes `<body>`, so `<body class="tw-meeting">` alone renders LIGHT;
the probe sets `data-theme="dark"` on `<html>`.

## 4. Landmarker context budget rule (restated with measured numbers)

- **Hands on LOCAL tiles only, pose on ONE tile, remotes from packets.** Each landmarker = 1 WebGL context
  (`m2` entries, a 1x1 OffscreenCanvas webgl2) and ~1 s to instantiate even from CacheStorage (boot 1.6 s with one hand,
  ~5 s with three hands + pose) plus a 230-380 ms first-inference stall. On this box at 1280x720 fake video one
  HandLandmarker = **~10 ms p50 per frame** alone (palm detector every frame because the fake feed has no hand - the
  expensive path), **6.7-8 ms each when three run back-to-back** (GPU overlap), PoseLandmarker lite = **11.5 ms alone / 7.5 ms
  next to three hands**, every 2nd frame. Three local hand landmarkers + pose = **22-25 ms p50 / 28-29 ms p95 of detect time,
  25-28 ms of script** - inside the 45 ms budget of `multiplayer.js:90` but above one 60 Hz frame, i.e. a 30 fps twin on
  this class of laptop regardless of design P or S. At 1080p with 9 tiles the same landmarkers slow to 8.9 / 8.1 ms (GPU
  contention with the larger surface): S-t9-1080 = 32.6 / 39.2 ms script, the matrix maximum.
- Context budget for the twin at the gallery cap (9 tiles), measured: design S = 1 (three) + k (hands) + 1 (pose) = 5 with
  k = 3 [+1 face, +1 TF.js/MoveNet if a tile is shared -> 7], under half the cap; design P = 9 + k + 1 = 13 with k = 3, and
  face + MoveNet + one more renderer = 16 = EVICTION of the first tile renderer. 3 local tiles is the sensible max for one
  laptop anyway (time budget above).
- Order of creation matters because the OLDEST context is the victim: create the three.js renderer FIRST only if you
  never approach 16; otherwise create landmarkers first and the renderer last, and always listen for `webglcontextlost`
  on the surface canvas and rebuild (three.js does not throw; the overlays just stop).
- Creating many contexts in one synchronous burst (24 in one task) stalled the headless page for > 2 minutes on this
  box (GPU-process reset); create landmarkers sequentially with `await`, which `createHandLandmarker` already forces.

## 5. What P would need to remain viable (for the record)

The ball mesh must exist in every tile scene its disc overlaps (not only the owner's) and the transit disc must be clipped to
the gutter, or the far half disappears at the edge (first-pass `P-*-edge.png`); the tile ring/label chrome sits above the
per-tile props canvas, so rings cross the ball at every edge unless chrome is restacked. Lazy per-tile contexts (create the
props renderer only when a prop or rig enters the tile, dispose on leave) keep P at
1 + k + 1 + (tiles currently holding a prop) - workable for the ball game (<= 2 tiles at once) but it re-introduces context
creation latency (shader compile ~ hundreds of ms per new context - see `warm-up` column) exactly when the ball arrives,
and it keeps the 2D transit disc and its shading mismatch. Not recommended.
