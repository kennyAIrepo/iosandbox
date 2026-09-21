# Gap: render budget - WebGL context ceiling vs per-tile vs single-surface rendering (2026-09-18)

**Decision: design S - one transparent WebGLRenderer over the whole stage, one scissored viewport + camera per tile, one
scene, the ball ONE mesh in court coordinates - for the Teams twin AND the container-D meeting-stage app; keep the 2D
`.tile__hands` canvas per tile for remote skeletons. Drop the per-tile props canvas, the 2D transit canvas and the
radius-matching "no pop" step.** Details: `decision.md`; numbers: `results.md` (50 runs); stacking patch:
`layout-spec.patch.md`; probe: `render-budget.html` + `probe-render-budget.mjs` (`--quick`, `--only=`, `--missing`,
`--report`); seam scans: `edge-scan.txt` (matcap) vs `edge-scan-lit.txt`; screenshots: `shots/`.

## Numbers (headless Chrome, ANGLE D3D11 on Adreno X1-85, ARM64 Windows - LOWER BOUND)

- **Context ceiling = 16 active WebGL contexts per page; the 17th evicts the OLDEST** (`WARNING: Too many active WebGL
  contexts. Oldest context will be lost.`), which is the three.js renderer created at page start: rigs and ball vanish with
  zero exceptions (`THREE.WebGLRenderer: Context Lost.`, `shots/S-t3-h1-p0-r1-720-x24.png`). Creating 24 contexts in one
  synchronous burst stalled the page > 2 min; one per frame did not.
- **Contexts per configuration**: P = `tiles + hands + pose` (9 tiles + 3 hands + pose = **13**, three short of eviction
  before face / MoveNet / one more renderer); S = `1 + hands + pose` (= **5**). MediaPipe = exactly one webgl2 context per
  landmarker (1x1 OffscreenCanvas), ~1 s each to instantiate even from CacheStorage, 230-380 ms first-inference stall.
- **Main-thread time is landmarker-bound, identical for P and S, flat in tile count**: one HandLandmarker ~10 ms p50
  (fake feed, palm detector every frame); three back-to-back 6.7-8 ms each; pose lite 11.5 ms alone / 7.5 ms with three
  hands, every 2nd frame. Script p50 / p95 at 720p: hands=1 -> 11.4 / 13.5 ms; +pose -> 16-21 / 25; hands=3 -> 22-25 / 27-29;
  hands=3+pose -> 25-28 / 31-32 (both designs, 3..9 tiles). Max of the matrix: S 9 tiles at 1080p 32.6 / 39.2 ms. Nothing
  exceeded the 45 ms budget (`multiplayer.js:90`); everything with 3 local landmarkers exceeds one 60 Hz frame -> 30 fps twin.
- **Render is not the cost**: `renderer.render` 0.2-0.4 ms/frame in every row for 13 draw calls / ~363k triangles (3 tiles x
  2 HoloHandRigs x mesh + occluder, 15065 verts each); rig posing + resolve 3.6-4.2 ms for 3 tiles; heap 28-105 MB.
- **rAF cadence 33.3 ms p50 in every run with >= 3 cloned video tiles** - even video-only rows (1 context, 0.3 ms script);
  the empty 1-tile page runs at 16.7 ms. Headless video compositing, not the overlays; read `script`/`detect`, not `frame`.
- **No-pop check**: projected radius through tile-0 and tile-1 cameras = `R_court * th` exactly in every S row
  (26.64, 21.06, 17.46, 42.84, 28.26 px). A LIT ball still seamed at the mid-gutter (RGB 63,67,129 -> 87,92,172) because
  neighbouring eyes sit a tile pitch apart; `MeshMatcapMaterial` makes the scan one smooth gradient. Rule: crossing props are
  matcap/unlit (or a shared-eye stage pass for layer 0). P additionally needs the ball in every overlapped tile scene (its
  far half was missing at the edge) and restacked chrome (rings cross the ball).
- Tile sizes with the twin chrome (48 top + 56 control bar + 8 pad): 1280x720 -> 526x296 (3-4), 416x234 (5-6),
  346x194 (7-9); 1920x1080 -> 846x476 (4), 559x314 (9).

## Caveats

- ANGLE D3D11 on a Qualcomm iGPU in headless mode; a discrete/Apple GPU will be faster, an Intel iGPU laptop may not be.
- Synthetic fake camera: no real hand -> landmarkers run their worst-case path, rigs posed from synthetic 21-point clouds
  through the real `HandViews` (chirality measured, labels never read); no One-Euro/PlayerPipeline in the loop (~0.1 ms).
- All tiles are clones of ONE 720p stream; no WebRTC decode, no packets, no network jitter, no Teams client sharing the GPU.
- Frame-gap numbers are quantised by the video path (above); dpr = 1; nothing measured with a face landmarker or MoveNet.
- Found on the way: `<body class="tw-meeting">` alone renders LIGHT (the `--tw-*` aliases resolve on `:root` first) - the
  probe sets `data-theme="dark"` on `<html>`; fix belongs in `scripts/gen-tokens.mjs`.

## Still needs a real multi-laptop run

Real hands (tracking path, cheaper than palm detection every frame), real remote tiles (WebRTC decode per tile + packet
consumer), the Teams desktop client running alongside (its own GPU contexts and video decode), a dpr-2 display at 1080p+
(`setPixelRatio` cap), an Intel-iGPU laptop, and the context count with face + MoveNet + self-view added on top of S.
