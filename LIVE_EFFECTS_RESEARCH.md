# Live Effects — research notes (world models · fast gen · streaming)

Raw research trails behind LIVE_EFFECTS_PLAN.md, gathered 2026-07-28.
Three sweeps: Decart/world-model route, fast generative texture/mesh, and
low-latency cloud-AR delivery. (The body-mesh/rig sweep — SAM 3, SAM 3D Body,
MHR, WiLoR, UV attach — lives in SAM3_INTEGRATION_PLAN.md.)
**2026-07-29: three more sweeps added (§0 verdict, §4–§6) answering "is
SAM3+DensePose the right stack for indistinguishable live body-wrap?"**
Items marked (unverified) could not be confirmed from primary sources.

---

## 0. VERDICT — stack decision (2026-07-29)

Question asked: is SAM3 + DensePose the right stack for realistic, real-time
effects wrapped onto the user's body mesh? Answer, from three independent
sweeps (§4 body-surface tracking, §5 real-time generative video, §6 composite
realism):

### What was wrong

1. **DensePose (2018) is the wrong architecture, not a tuning problem.**
   Direct per-pixel IUV regression stopped evolving in ~2022. Meta's own
   modern human stack (Sapiens2, SAM 3D Body, MHR) never reintroduced a UV
   head, because the field's answer is: **track a parametric body mesh at
   frame rate, then rasterize its native UV atlas** — seam-free continuous
   UVs (no 24 blocky parts), plus normals + depth from the same <1 ms raster
   pass, temporally stable because the mesh is stable. Snap's Body Mesh ships
   exactly this. Our blocky/streaky wrap is DensePose's ceiling.
2. **SAM3 is one version behind.** SAM 3.1 (Mar 2026, `facebook/sam3.1`):
   ~6× faster video tracking (32 fps 1×H100 vs 5–6 fps), 16 objects
   multiplexed per forward pass, drop-in.
3. **The wrap looked like a "cheap 2D filter" for four nameable reasons**
   (§6), independent of tracking quality: (a) effect ignores real scene
   lighting; (b) hard binary mask edges instead of an alpha matte; (c) the
   user's own skin micro-texture (pores, creases, AO, specular glints)
   vanishes under the material; (d) effect updates at tracker cadence instead
   of being pixel-locked by optical flow.
4. **Pure PBR compositing tops out at "very good AR", not indistinguishable**
   — organic materials (slime, feathers) need silhouette change and light
   interaction only a generative model produces. And **pure live v2v on open
   weights isn't photoreal yet at our latency bar** (1.3B @368×640 =
   stylization-grade; 14B needs >32 GB). The only shipped
   indistinguishable-live system is Decart Lucy 2.5 (closed API) — which we
   deliberately don't build on.

### The revised stack (three layers, all runnable on the 5090 + Modal)

- **L0 — body truth** (replaces DensePose): SAM 3.1 for concept seg/tracking;
  MHR mesh (Apache-2.0, real-time LODs — already integrated) as the rig,
  identity/shape anchored occasionally by SAM 3D Body (~230 ms is fine at
  0.1 Hz), **per-frame pose driven by a fast head** (FastHMR/CameraHMR
  ~100–150 fps class, or PromptHMR which eats our SAM masks as prompts);
  **rasterize the posed mesh's UV atlas** (nvdiffrast server-side, or ship
  pose params and rasterize client-side in WebGL — cheaper than shipping IUV
  PNGs) → per-pixel UV + normal + depth every frame. Crisp edges from
  RobustVideoMatting (104 fps HD on a 1080Ti) instead of hard SAM masks.
- **L1 — always-on live composite** (the four §6 fixes, mostly client
  shader work, near-zero cost): camera-fed IBL (live frame as env/specular
  source, Snap's documented trick) + slow-lane HDR probe refresh; alpha-matte
  edges with Fresnel-weighted falloff; **frequency-split detail transfer**
  (PBR material carries the low/mid band, the live frame's high-frequency
  luminance is re-injected on top so the user's real pores/shading survive —
  the single biggest realism lever, nearly free); optical-flow pixel-locking
  of the effect layer between tracker updates (NVIDIA NVOFA hardware flow:
  ~536–1296 fps @1080p on Ada, <2 ms).
- **L2 — generative tier** (where "indistinguishable" actually comes from):
  - **L2a keyframe+flow (open, fits the 5090, recommended first)**: every
    1–3 s, a photoreal masked image edit ("scales on this arm" —
    Qwen-Image-Edit distilled, Apache-2.0; or FLUX.1 Kontext dev,
    non-commercial) on the current frame; diff the edit against the frame and
    **warp that residual per-frame with NVOFA flow** until the next keyframe.
    Material inherits actually-photographed shading. Nobody ships this — open
    win.
  - **L2b masked live stream (open)**: **Daydream Scope + VACE adaptation
    (arXiv 2602.14381) on LongLive-1.3B — 17–22 fps on ONE RTX 5090**
    (368×640, 14.6 GB, depth/pose/mask/reference conditioning, masked
    body-only regeneration keeping real background pixels). CC BY-NC-SA.
    ~700 ms chunk latency, stylization-grade at 1.3B — the live "wow" tier,
    not yet the photoreal tier.
  - **L2c cloud quality (open weights, rented GPU)**: same Scope+VACE on
    Krea Realtime 14B — needs ~55 GB → Modal H100/B200, 12–16 fps @320×576.
  - Upstream StreamDiffusionV2 (our Wan 1.3B causal DMD checkpoints, already
    downloaded) is the Apache-2.0 engine but has **no control branch** —
    control only exists via Scope's VACE layer.

### Build order

1. L1 composite fixes in studio.html (client-only, applies to any UV source).
2. Scope + VACE on the node (5090 is the paper's own benchmark GPU); feed our
   SAM person mask → masked live restyle lane replacing the raw-SDv2 plan.
3. SAM 3.1 drop-in for sam3_serve.
4. Mesh-UV lane: fast pose head driving MHR + UV-atlas rasterization;
   retire dp_serve/DensePose.
5. L2a keyframe-edit + NVOFA flow-warp lane (Qwen-Image-Edit on node or
   Modal).

---

## 1. World-model route — Decart and real-time generative video

### Decart: company + infrastructure
- Israeli startup. $21M seed → $32M Series A @ $500M (Dec 2024) → $100M @
  $3.1B (Aug 2025) → $300M Series B @ ~$4B (Radical Ventures). Strategic bet
  on Amazon Trainium alongside NVIDIA.
- "DOS" (Decart Optimization Stack): hardware-aware model design, kernel
  tooling, proprietary compilers across NVIDIA/TPU/Trainium. DOS 2.0 claim:
  full-HD at up to 100 fps (company claim, unverified). No custom Decart
  silicon; Oasis's ASIC partner was Etched (Sohu).

### Oasis (Oct–Nov 2024, with Etched) — playable world model
- Architecture: ViT spatial autoencoder + Diffusion Transformer, frames
  generated autoregressively; trained with **Diffusion Forcing** (per-token
  independent noise); inference uses dynamic noising to limit error
  accumulation. No game engine underneath — pure model.
- Numbers: **20 fps, 47 ms/frame, 360p on an H100**. 4K only targeted on the
  Etched Sohu ASIC (never publicly shipped — unverified).
- Open release: 500M weights (huggingface.co/Etched/oasis-500m), code
  (github.com/etched-ai/open-oasis).
- Self-stated limits: fuzzy far field, temporal breaks on uncertain objects,
  **~3 s world memory** (look away → the world regenerates differently),
  imprecise object control.
- Oasis 2.0 (Sept 2025): live Minecraft restyling via a V2V model
  ("Lucy-Restyle"); 1080p/30fps as a Minecraft mod; Decart's own note: "FPS
  may drop a bit, resolution isn't perfect."

### MirageLSD / Mirage (July 2025) — real-time V2V "Live-Stream Diffusion"
- First infinite-length real-time video-to-video diffusion. **<40 ms model
  latency/frame; ~100 ms end-to-end; 20–24 fps; 768×432** — note the gap
  between the marketing 40 ms and the end-to-end ~100 ms.
- Architecture: **causal frame-by-frame** diffusion — each output frame
  conditioned on recent generated frames + current input frame + prompt, fed
  back autoregressively. Not chunk generation.
- Anti-drift training (the two key tricks): **Diffusion Forcing** (denoise a
  frame without trusting history) + **History Augmentation** (fine-tune on
  deliberately corrupted history so the model corrects its own drift → enables
  "infinite" streams; prior AR video models degrade past ~20–30 s).
- Real-time systems work: **shortcut distillation (claimed 16×), Hopper-tuned
  architecture pruning, fused whole-network CUDA "mega kernels."** Tech
  report: decart.ai/publications/mirage.
- Self-stated limits: consistency decays with the finite history window, large
  style departures fail, **no precise object-level control**, quality below
  offline SOTA.

### Lucy family
- **Lucy-Edit-Dev** (Sept 2025, HF decart-ai/Lucy-Edit-Dev): open-weight
  instruction-guided **offline** video editing on Wan2.2 5B; good at
  clothing/character swaps. Failure modes directly relevant to body FX: color
  edits unreliable, **inserted objects tend to attach to the subject**, global
  edits bleed. Non-commercial license (dev).
- **Lucy 2** (Jan 2026): claims 1080p/30fps "near-zero latency" continuous
  streaming, ~$3/hr serving, NVIDIA + Trainium. Third-party report: sub-100 ms
  only ≤720p, 1080p at 200 ms+ (unverified). "Physical interaction
  consistency" is a marketing claim (unverified).
- **Lucy 2.5 live-edit API**: WebRTC in / `wss://api3.decart.ai/v1/stream`,
  720p, live `setPrompt()`, 2 credits/sec (platform.decart.ai).

### Competing / related real-time systems (verified numbers)

| System | Type | Throughput / latency | HW |
|---|---|---|---|
| StreamDiffusion | img2img pipeline (SD-Turbo/LCM) | up to 91 fps @512; RCFG 2× | 1× RTX 4090 |
| StreamDiffusionV2 (MLSys'26) | training-free streaming video diffusion | TTFF <0.5 s; 58 fps (14B) / 64.5 fps (1.3B), 1–4 steps | 4× H100 |
| Self-Forcing (NeurIPS'25) | AR video diffusion distillation | 480p, ~16 fps H100 / ~10 fps 4090, ~0.8 s TTFF | 1 GPU |
| Krea Realtime 14B | Wan 2.1 14B Self-Forcing distill, Apache-2.0 | 11 fps @4 steps, TTFF ~1 s, live prompt switch | 1× B200 |
| Runway Aleph | in-context video editing (offline) | 100–300 s per generation, clips ≤30 s | cloud |
| Daydream (Livepeer) | hosted StreamDiffusion/ComfyStream | 15–25 fps TensorRT, targets sub-100 ms | NVIDIA cloud |
| StreamDiffusionTD / TouchDiffusion | TouchDesigner operators | 15–25 fps @512; >1024² collapses to ~4 fps | RTX consumer |
| MirageLSD | real-time V2V world model | <40 ms model, ~100 ms e2e, 20–24 fps, 768×432 | Hopper |
| Oasis | playable world model | 20 fps, 47 ms/frame, 360p | H100 |

- AR-adjacent avatar research all conditions diffusion on **explicit
  geometry**: PersonaLive (arXiv 2512.11253, 3D implicit keypoints),
  StreamAvatar (2512.22065), InteractiveAvatar (2606.22905), LiveTalk
  (2512.23576). ControlNet-in-stream is production-real: StreamDiffusionTD
  ships TensorRT multi-ControlNet (Depth/Pose/HED/Tile/Canny) live.

### Cross-cutting limits of the pure world-model route
- Model latency ≠ end-to-end latency; every real-time system is
  server-GPU-bound (H100/B200/4×H100), nothing on-device.
- Temporal/identity drift is the central failure mode; MirageLSD's entire
  contribution exists to fight it and still concedes long-horizon loss.
- **No persistent 3D state, no scene graph, no collision, no physics
  guarantees.** Oasis: ~3 s memory.
- No object-level control; prompt edits are global-style-biased; prompt-change
  convergence is its own latency channel (frames-to-seconds).
- Resolution/compute wall: real-time today = 360p–768×432 (world models) or
  512px (StreamDiffusion); 1080p30 is the frontier claim.

### Lessons for a landmark-anchored system
- The generative-only route trades away exactly what body effects need:
  deterministic anchors, occlusion, collision, per-object control. Landmarks
  run in single-digit ms and give all four.
- The field's convergence: **geometry is the control channel, diffusion is the
  texture channel** — few-step distilled diffusion conditioned every frame on
  keypoints/depth, composited over the real feed at modest resolution.
- Decart's transferable lesson is inference engineering (distillation,
  pruning, fused kernels — the 16× was systems work, not theory).

Sources: decart.ai/publications/mirage · the-decoder.com (MirageLSD) ·
oasis-model.github.io · InfoQ (Oasis) · github.com/etched-ai/open-oasis ·
huggingface.co/decart-ai/Lucy-Edit-Dev · Lucy Edit paper (d2drjpuinn46lb
.cloudfront.net) · Forbes (Lucy 2, 2026-01-27) · platform.decart.ai ·
crusoe.ai blog · arxiv.org/abs/2312.12491 (StreamDiffusion) ·
arxiv.org/abs/2511.07399 (SDv2) · self-forcing.github.io ·
krea.ai/blog/krea-realtime-14b · runwayml.com/research/introducing-runway-aleph ·
blog.livepeer.org (Daydream) · dotsimulate.com/docs/streamdiffusiontd

---

## 2. Fast generative texture / mesh (the asset loop)

### Text-to-texture on a GIVEN mesh

| Method | Time | GPU | Notes |
|---|---|---|---|
| **TRELLIS.2** (Microsoft, Dec 2025) | ~1 s material stage @512³ (3 s total); 7 s @1024³ | H100 | Shape-conditioned texturing of a provided mesh (`example_texturing.py`); full PBR. **MIT.** |
| **FlashTex** (Roblox/CMU) | 3.07 s e2e | H100 | LightControlNet + fast SDS; relightable. License non-commercial (unverified). |
| **Make-A-Texture** (Snap) | 3.04 s e2e | H100 | Depth-aware inpainting + backprojection. arXiv 2412.07766 |
| Meta 3D TextureGen | ~20 s retexture | H100-class | Not released. |
| TEXGen (UV-space diffusion, 700M) | ~10 s (unverified) | A100 | Denoises the UV map directly — closest architecture to "texture a known body patch." |
| TexGaussian | 21 s full PBR feed-forward | — | Octree-3DGS → UV bake. |
| Hunyuan3D-Paint 2.0-Turbo | ~10–20 s (unverified) | 4090/A100, 12–21 GB | 2.1 adds PBR, needs 21 GB. Tencent community license (region/commercial caveats). |
| Older: TEXTure 1.5 min · SyncMVD ~2 min · Paint3D 2.6 min · Text2Tex 13 min | | A100 | All too slow for live. |

**Conclusion: <3 s full-mesh texturing is real today (TRELLIS.2, FlashTex,
Make-A-Texture); nothing full-mesh is reliably <1 s — but body patches don't
need full-mesh texturing.**

### The real <1 s path: image gen → tileable material patch
- **SDXL-Turbo**: 512² ~83 ms (H100+TensorRT) / ~207 ms (A100), 1-step —
  **non-commercial license.**
- **SDXL-Lightning**: 1024² 2–8 steps, ~300–500 ms 4090-class (approx.) —
  OpenRAIL++, commercial OK.
- **FLUX.1 schnell**: 1024² 4-step ~700 ms on H100 compiled — **Apache-2.0.**
- **LCM-LoRA**: 4-step on any SD1.5/SDXL, ~200–400 ms @512 on 4090 (approx.).
- **StableMaterials** (gvecchio, HF): tileable basecolor+normal+height+rough+
  metal @512², **LCM 4-step variant → well under 1 s**. OpenRAIL. Also MatFuse
  (50-step, slower), MatForger (tileable via noise rolling). Material Palette =
  extraction from photo, minutes. Substance 3D text-to-texture is DCC-latency
  (unverified).
- **The winning trick: generate a tiling albedo+normal patch once (~0.5–1 s),
  apply to the already-UV-mapped body region — deformation/sticking is free;
  no per-frame generation.**
- Screen-space: StreamDiffusion ~94 fps img2img @512 (SD-Turbo 1-step, 4090,
  Apache-2.0) → per-frame or every-Nth-frame beautify pass. Known failure:
  temporal flicker (Stochastic Similarity Filter helps).

### Fast text/image-to-3D mesh (conjured props)
- **TRELLIS.2**: ~3 s @512³ (2 s shape + 1 s material), 17 s @1024³. MIT. Best
  quality/latency/license combo.
- **Hunyuan3D-2mini-Turbo + FlashVDM**: **shape <1 s on a 4090** (5-step
  distilled DiT + 45× faster VAE decode); full asset 10–25 s.
- Feed-forward reconstructors: **TripoSR 0.2 s (MIT)**, **SPAR3D 0.7 s**
  (Stability community license) vs InstantMesh 36 s, LGM 41 s (SPAR3D CVPR'25
  table).
- **Meta AssetGen** ("Deployable 3D Asset Generation at Interactive Speed",
  arXiv 2605.26137): 30 s production asset; **AssetGen Flash ~14 s preview**;
  explicitly designed for preview→final progressive swap.
- Roblox Cube 3D: ~4 s/object after CUDA-graph optimization (7.8 ms/token);
  open-sourced Mar 2025 (license unverified).
- APIs: Tripo Smart Mesh P1.0 (Mar 2026) ~2–10 s quad mesh; Tripo v2.5
  25–30 s; Meshy-6 ~60 s full PBR; Meshy auto-rig <30 s + 500 preset anims.
- **Rigging**: generated meshes are NOT rigged. **UniRig (SIGGRAPH'25,
  VAST/Tsinghua): 1–5 s skeleton + skinning — the only rig path fast enough
  for a live loop** (successor: SkinTokens). Anything World: minutes, async.
  Mixamo: humanoid-only, manual. For body-attached props you usually don't
  need a rig: parent to a joint or wrap-deform.

### Composite realism
- 3DGS renders 100+ fps but gen→3DGS pipelines aren't faster than mesh routes.
- Relighting: IC-Light / SwitchLight are seconds-per-frame; only real-time
  result found is EdgeRelight360 (Qualcomm, 0.04 s/frame portrait, on-device).
  Practical: estimate ambient light (ARKit/ARCore-style probes) + standard PBR
  with generated normal maps ≈ 0 ms.
- Diffusion beautify: 1-step SD-Turbo img2img at low denoise over the effect
  bbox: ~10 ms @512 on 4090.

### Retrieval-then-generate (the Tier-0 idea)
- Research-established: Retrieval-Augmented Score Distillation (arXiv
  2402.02972); open-universe scene gen retrieves via CLIP/ScaNN and generates
  only when similarity is below threshold (arXiv 2403.09675); MetaFind
  (2510.04057); MaRI material retrieval (2503.08111).
- Products: Snap Lens Studio GenAI Suite = minutes-scale in-editor; Meta
  AssetGen Flash→full swap = the progressive pattern; Roblox Cube for
  in-experience gen. **No product found doing retrieval-instantly +
  generated-replacement-seconds-later in live AR — open ground** (unverified
  that none exists).
- Retrieval cost: CLIP/SigLIP embedding + FAISS over a few hundred assets =
  <10 ms.

### Three-tier recommendation
- **Tier 0, <100 ms**: premade tileable PBR library + pre-rigged props,
  SigLIP+FAISS, color parsed to shader tint.
- **Tier 1, 0.5–5 s**: StableMaterials-LCM / FLUX-schnell material patch
  (~0.5–1.5 s on the 5090); TRELLIS.2 texturing for whole assets (1–3 s);
  Hunyuan-mini-Turbo / TripoSR / SPAR3D props (<1 s shape).
- **Tier 2, 15 s–2 min**: TRELLIS.2 @1024³ / Meshy / Tripo; UniRig if it must
  deform; silent swap (AssetGen pattern).
- Because the body mesh is already tracked, rigged, UV-unwrapped, every tier
  reduces to texture/material swaps or joint-parenting — **generation never
  sits in the frame loop.**

Sources: github.com/microsoft/TRELLIS.2 · huggingface.co/microsoft/TRELLIS.2-4B ·
flashtex.github.io · arxiv.org/abs/2412.07766 · arxiv.org/abs/2407.02430 ·
arxiv.org/abs/2605.26137 (AssetGen) · github.com/Tencent-Hunyuan/Hunyuan3D-2.1 ·
github.com/Tencent-Hunyuan/FlashVDM · arxiv.org/abs/2403.14370 (SyncTweedies
runtimes) · dl.acm.org/doi/10.1145/3687909 (TEXGen) · arxiv.org/abs/2411.19654 ·
baseten.co (SDXL TensorRT) · modal.com/docs/examples/flux ·
huggingface.co/gvecchio/StableMaterials · github.com/cumulo-autumn/StreamDiffusion ·
github.com/Stability-AI/stable-point-aware-3d · meshy.ai/compare/meshy-vs-tripo ·
3daistudio.com (API comparison) · github.com/VAST-AI-Research/UniRig ·
about.roblox.com (Cube inference) · arxiv.org/abs/2404.09918 (EdgeRelight360) ·
github.com/lllyasviel/IC-Light · ar.snap.com/blog/genai-suite-lens-studio-5.0 ·
arxiv.org/abs/2402.02972 · arxiv.org/abs/2403.09675 · arxiv.org/abs/2510.04057

---

## 3. Low-latency cloud-AR delivery (the dollhouse loop)

### Latency budgets — perception thresholds
- HMD VR/AR: motion-to-photon ≤20 ms (NVIDIA/GSMA/Microsoft consensus).
- **Handheld/screen AR is far more forgiving — the key architectural fact**:
  users start noticing ~**69 ms**, prefer <**132 ms**; interaction feel
  degrades ~75→250 ms. Trained observers JND ~15 ms; consumer tolerance on a
  flat screen ~100 ms+.
- Cloud gaming proves the loop: GeForce NOW ~40 ms system latency (LDAT,
  fiber); Stadia 70–87 ms; browser xCloud can exceed 300 ms.

### Split/cloud rendering systems
- **NVIDIA CloudXR 6.0**: OpenXR server, WebRTC CloudXR.js for browsers,
  foveated streaming, 90 fps over 5 GHz Wi-Fi, targets 20 ms MTP with
  client-side pose prediction + reprojection.
- **Unreal Pixel Streaming**: WebRTC+NVENC; WebRTC layer ~10 ms; same-region
  glass-to-glass commonly 60–150 ms (no official figure).
- **Azure Remote Rendering** (retired 2025, canonical precedent): server
  renders heavy content, client renders local content at the remote frame's
  pose, **Late Stage Reprojection** applied to both.
- Google Starline→Beam: streams compressed 3D/lightfield, renders locally —
  not split rendering.
- Academic: image-space split rendering −23 % E2E latency (arXiv 2211.02529);
  **streaming 3D Gaussians instead of video** so the client re-renders at
  local pose (arXiv 2604.02851); QUIC vs WebRTC measured (arXiv 2505.22132).

### Hiding the round trip over a local camera
- **(a) Late-stage reprojection**: on handheld degenerates to a cheap 2D
  homography/shift of the effect layer by the pose delta — corrects camera
  motion, not subject motion.
- **(b) Effect-layer + alpha over the LOCAL camera — the single biggest win.**
  The world never lags (it's the local feed); only the effect lags by RTT.
  Converts "the world lags 150 ms" into "the sticker lags 150 ms," which is
  under handheld thresholds.
- **(c) Prediction**: run sim/render at pose(t+RTT). One-Euro is the standard
  low-lag smoother; 80–100 ms human-pose extrapolation is solved territory
  (≤400 ms horizons in the literature); error at 100 ms ≈ a few cm — fine for
  effects, marginal for tight occlusion.
- **(d) Dilated/feathered alpha** so ±cm error shows no seam; design effects
  misalignment-tolerant (glows, particles, auras) rather than hard
  silhouette-locked. Industry practice (little formal literature).
- Netcode bonus: timestamp every uplink frame; client keeps a ~5-frame camera
  ring buffer → composite against "now" (effect lags) or against the matching
  buffered frame (**precision mode**: perfect registration, whole view delayed
  ~RTT — acceptable on handheld).

### Transport + codecs
- **WebRTC**: tuned pipelines hit 40–150 ms e2e; protocol itself ~10 ms. Pin
  playout-delay ≈ 0, no jitter-buffer growth, periodic-intra.
- **WebTransport/QUIC**: ~30 % lower latency vs RTCPeerConnection in studies;
  reliable streams + unreliable datagrams (ideal split: datagrams for the
  landmark uplink, stream for effect video). Safari/iOS 26.4 added support
  (Apr 2026) → viable cross-browser.
- **MoQ**: draft-17/18, approaching WGLC; Cloudflare relays; production
  200–400 ms — great fan-out, **not yet better than tuned WebRTC for 1:1**.
- **WebCodecs**: per-frame hardware encode/decode control; **currently drops
  alpha** (w3c/webcodecs#200).
- **NVENC**: ~3–10 ms/frame 1080p low-latency preset; beware 2–4-frame
  pipelining on some paths (`lookahead=0`, zero-frame-delay modes on desktop
  Ada+). Client hardware decode 2–5 ms.
- **Alpha is the hard part**: WebRTC's encode path ignores alpha; AV1 has no
  native alpha; HEVC-alpha is Apple-only. **Answer: packed alpha — effect
  color + its luma matte stacked in one frame, split in a client shader;
  premultiplied color; codec-agnostic, survives NVENC.** (Alternatives:
  chroma key w/ spill correction — fragile; VDO.Ninja chunked mode.)

### Precedents
- Snap Camera Kit: client-side only; Remote/Connected Lenses = shared state,
  not remote render.
- Niantic Lightship VPS: cloud *localization* + downloaded meshes for local
  physics/occlusion — the "stream understanding, not video" half at city scale.
- **VMC Protocol (VTuber stacks)**: bone transforms + blendshapes over
  OSC/UDP; a full body ≈ 2 KB/frame ≈ 0.5 Mbps @30fps — three orders of
  magnitude below video. VSeeFace/Warudo fully separate tracking producers
  from renderers. Strongest precedent for the packet-mode uplink/downlink.
- HeyGen-style interactive avatars render server-side over WebRTC — closest
  commercial "cloud-rendered character" analog.

### Server physics per dollhouse room
- Netcode fit: server-authoritative sim + snapshot interpolation; keep sim
  inputs predicted +RTT so the rendered effect lands "on time."
- Engines: Unity dedicated server (PhysX, heavyweight per user) · Unreal (sim
  + render + Pixel Streaming in one process, heaviest) · Godot headless (Jolt,
  lighter, maturity unverified) · **Rapier in Node (Apache-2.0, deterministic,
  lightest per-user; pairs with Three.js offscreen/WebGPU render + NVENC)** ·
  Jolt C++/WASM (soft bodies/cloth) · PhysX/Omniverse (many rooms on one GPU,
  overkill).
- **Best fit for many cheap per-user rooms on one GPU: Node + Rapier + Three.js
  offscreen render → NVENC.**

### End-to-end budget (handheld, same-region GPU ≤30 ms RTT)

| Stage | ms |
|---|---|
| Capture + client preprocess | 8–16 |
| Landmark extraction (server GPU or client MediaPipe) | 5–15 |
| Uplink (landmarks ~2 KB via QUIC datagram / low-res video) | 2–15 |
| Prediction offset (sim at t+RTT) | −(60–120) |
| Sim + render (1 tick + 1 frame @60–120 Hz) | 8–16 |
| NVENC packed-alpha encode (zero-frame-delay) | 5–10 |
| Downlink | 10–30 |
| HW decode | 3–8 |
| Composite + late-reproject + display | 8–16 |
| **Effect-visible lag (unpredicted)** | **~50–110** |

With prediction, perceived lag ≈ prediction error only. Under the 132 ms
handheld preference threshold without prediction; well under with.

### Top three patterns
1. **Local-world + remote-effect-layer compositing** (never stream the camera
   back) — takes the system from "unusable" to "shippable" on its own.
2. **Predict-ahead sim + tiny landmark uplink** (VMC-style packets, QUIC
   datagrams, capture timestamps; One-Euro + velocity extrapolation server-side).
3. **Client late-warp + dual composite modes** (default: 2D late-reproject vs
   pose delta; precision: composite against the matching ring-buffer frame).

Sources: developer.nvidia.com (CloudXR 6.0) · gsma.com (Cloud AR/VR
whitepaper) · dev.epicgames.com (Pixel Streaming tuning) ·
learn.microsoft.com (Azure Remote Rendering camera/LSR) ·
arxiv.org/abs/2401.06366 (GFN measurement) · arxiv.org/abs/2211.02529 ·
arxiv.org/abs/2604.02851 (Gaussian streaming) · arxiv.org/abs/2505.22132
(QUIC vs WebRTC) · datatracker.ietf.org (MoQ) · jakearchibald.com/2024/
video-with-transparency · github.com/w3c/webcodecs/issues/200 ·
docs.vdo.ninja (transparent video) · dl.acm.org/doi/10.1145/2207676.2208639
(1€ filter) · arxiv.org/abs/2302.08274 (pose forecasting) ·
protocol.vmc.info · gafferongames.com (snapshot interpolation) ·
nianticlabs.com (Lightship VPS) · threejs.org (RapierPhysics) ·
forums.developer.nvidia.com (NVENC latency threads)

---

## 4. Body-surface tracking, 2024–2026 (is DensePose/SAM3 outdated?)

### Sapiens / Sapiens2 (Meta)
- **Sapiens** (ECCV'24, facebookresearch/sapiens): 0.3B–2B ViTs, native
  1024×768; pose (308 kpt), 28-part seg, relative depth, **surface normals**.
  **No UV head.** Sapiens-Lite torchscript exports "up to 4× faster" but Meta
  publishes **zero fps numbers**; community: 1B ≈ few fps on consumer GPUs
  (unverified). Custom license.
- **Sapiens2** (ICLR'26, released Apr 24 2026, arXiv 2604.21681): 0.1B–5B +
  1B-4K; adds **per-pixel metric pointmap (XYZ)**, matting, albedo; windowed
  attention + GQA; +24.3 mIoU seg, −45.6% normal error vs v1. Still **no UV**,
  still no published fps, proprietary "Sapiens2 License". 0.1B is the
  plausible real-time-normals candidate — must profile.

### The DensePose line is dead
CSE (NeurIPS'20, continuous embeddings, kills the 24-part seams but same slow
R-CNN, CC-BY-NC) → BodyMap (CVPR'22) → nothing since. **No one built a fast
modern DensePose because the field's answer is: track a mesh, rasterize its
UV.** PyTorch3D ships an official "render DensePose from SMPL" path
(TexturesUV); SOTA papers *generate* DensePose GT this way (SimPose,
DenseRaC). Raster cost of a 7–27k-vert mesh with UV+normal+depth: **<1 ms**.

### Real-time mesh trackers (the DensePose replacement)

| Method | Nature | Speed | Notes |
|---|---|---|---|
| **FastHMR** (WACV'26) | per-frame SMPL, accel. HMR2.0/CameraHMR | **103–150 fps** | token+layer merge + diffusion decoder; smoother than HMR2.0 |
| CameraHMR | per-frame SMPL, camera-aware | ~54 fps | SOTA-ish accuracy |
| **PromptHMR** (CVPR'25) | SMPL-X, **promptable by masks/boxes/text** | n/a published | pairs directly with our SAM masks |
| **Human3R** (2025) | online multi-person SMPL-X + scene + camera | **15 fps, 8 GB** | first genuinely live world-grounded SMPL-X |
| NLF (NeurIPS'24) | any-point localization field | "interactive", TorchScript | code MIT, **weights non-commercial** |
| WHAM / GVHMR / TRAM | video, world-grounded | 9 / 4.9 / <1 fps full pipeline | offline preproc-bound |
| SAM 3D Body → MHR | per-frame MHR rig | ~230 ms (our measure) | **MHR itself Apache-2.0, real-time LODs** — keep as identity anchor |

### SAM 3.1
SAM3 video = 5–6 fps @1080p (H200). **SAM 3.1 (Mar 27 2026,
facebook/sam3.1): 32 fps on one H100, 16 objects multiplexed, drop-in** —
single highest-leverage upgrade to the existing lane.

### Matting
RVM: 104 fps HD / 76 fps 4K on a **1080Ti** — still the real-time default.
BiRefNet 17 fps @1024 (4090, stills). MatAnyone/2: best hair, not real-time.

### Depth/normals
FlashDepth 24 fps @2K streaming; DA3-Streaming ~10 fps (A100, scene);
mesh-derived normals are free at raster time — cheapest correct answer.

### 3DGS avatars
Fit offline (30 min–3 h), drive+render live (50–560 fps). Re-render the
*avatar*, not the user's pixels — wrong tool for wrap-on-video, right tool for
full re-texture later. (ExAvatar, 3DGS-Avatar, Mon3tr '26.)

### Production AR
Snap Body Mesh = tracked parametric mesh + authored UV layout, on-device;
TikTok = skeleton puppeting; MediaPipe GHUM = 33 kpts + coarse shape; ARKit =
skeleton only. **Nobody in production regresses per-pixel IUV.**

Sources: github.com/facebookresearch/sapiens · …/sapiens2 · arXiv 2604.21681 ·
detectron2 DensePose CSE docs · arXiv 2205.09111 (BodyMap) ·
istvansarandi.com/nlf · arXiv 2312.07531 (WHAM) · FastHMR (WACV'26) ·
yufu-wang.github.io/phmr-page · arXiv 2510.06219 (Human3R) ·
github.com/facebookresearch/MHR · ai.meta.com/blog/segment-anything-model-3
(SAM 3.1) · github.com/facebookresearch/sam3/issues/425 ·
github.com/ByteDance-Seed/Depth-Anything-3 · eyeline-labs.github.io/FlashDepth ·
github.com/PeterL1n/RobustVideoMatting · github.com/ZhengPeng7/BiRefNet ·
pq-yang.github.io/projects/MatAnyone · developers.snap.com (Body Mesh) ·
effecthouse.tiktok.com (Body Avatar Drive) · arXiv 2206.11678 (GHUM) ·
pytorch3d.org/tutorials/render_densepose · arXiv 2007.15506 (SimPose)

---

## 5. Real-time body-conditioned generative video (mid-2026)

### Headline
**Daydream Scope + "Adapting VACE for Real-Time Autoregressive Video
Diffusion" (arXiv 2602.14381)** retrofits VACE conditioning — depth, pose,
scribble, optical flow, **masked inpainting**, reference images — onto causal
Wan-based real-time models (LongLive, Krea Realtime, StreamDiffusionV2,
MemFlow, RewardForcing). Measured **17.2–22.3 fps on ONE RTX 5090** (LongLive
1.3B, 368×640, 4 steps, 14.6 GB, ~700 ms chunk latency). Masked body-only
regeneration keeping real background pixels **exists in-stream today**.
Scope license CC BY-NC-SA 4.0. Key paper finding: in-latent reference images
collapse under causal attention — their fix is a parallel conditioning
pathway, no retraining.

### Consolidated single-GPU fps (Wan-family distills)

| Config | fps |
|---|---|
| Self-Forcing 1.3B @480p, 1×4090 | ~10 |
| Self-Forcing 1.3B @480p, 1×H100 | ~16 |
| LongLive 1.3B, 1×H100 | 20.7 (24.8 FP8) |
| **LongLive 1.3B via Scope, 368×640, 1×5090** | **22.3 (17.2 w/ depth or mask)** |
| StreamDiffusionV2 1.3B @512, 4×4090 / 4×H100 | ~24 / 64.5 |
| FastWan-QAD 1.3B @480p, 1×5090 | ~2.8× realtime (chunked) |
| Krea 14B via Scope @320×576, 1×H100 | 16.2 (13.5 w/ depth) |
| Krea 14B, 1×B200 | 11 |

### Key systems
- **StreamDiffusionV2** (MLSys'26 **Best Paper**, Apache-2.0,
  chenfengxu714/StreamDiffusionV2): text-only V2V upstream — **no control
  branch**; motion-aware noise controller; our downloaded wan_causal_dmd_v2v
  checkpoints are this. Single-GPU fps unpublished.
- **Krea Realtime 14B**: v2v.py real-time restyling; repo says CC BY-NC-SA
  (press said Apache — unverified); **55 GB with VACE → does NOT fit the 5090**;
  Modal H100/B200 job. Anti-drift: KV recompute from clean latents, negative
  attention bias on stale tokens, 3-frame context.
- **Self-Forcing / CausVid / Rolling Forcing / LongLive / Causal Forcing**:
  foundations, no control branches upstream; LongLive = interactive prompt
  switching via KV-recache.
- **Decart**: MirageLSD (<40 ms, 768×432) → **Lucy 2.5** (Jan'26): live
  character swap/restyle/VFX, 30 fps 720–1080p, sub-40 ms, reference images,
  self-anchoring; fal websocket API ~$0.02/s. **The only demonstrated
  indistinguishable+live+<300 ms system. Closed. No open replication.**
  Open cousin decart-ai/Lucy-Edit-1.1-Dev (Wan2.2 5B, offline instruction
  editor) = quality reference / distillation target.
- **SD1.5/SDXL ControlNet streaming** (StreamDiffusionTD, Daydream fork,
  ComfyStream): 15–25 fps with multi-ControlNet pose+depth + IPAdapter-FaceID
  on one consumer GPU — but per-frame image diffusion = flicker + "AI filter"
  look; superseded for our bar.
- 2026 watch list: MotionStream (29 fps H100, drag control), MonarchRT
  (~16 fps 5090), MemFlow (Kling, memory bank), Reward-Forcing (CVPR'26 HL),
  arXiv 2606.05981 (0.39B edit U-Net, **74 fps @512 on one 5090**,
  stylization-grade); FastWan-QAD (Apache-2.0 distillation base).

### Identity preservation techniques (live v2v)
Low v2v denoise (identity from input latent; trade-off vs restyle strength) ·
feature banks (StreamV2V, 20 fps A100) · KV hygiene (Krea) · self-anchoring
(Lucy) · reference images via parallel pathway (Scope fix) · **structure
control ≠ identity: combine depth/pose control with masked inpainting so the
real face + background stay untouched**. Failure modes: drift, DMD mode
collapse, small faces destroyed at 368×640, ~700 ms chunk latency, flicker
at low denoise vs identity loss at high.

Sources: arXiv 2602.14381 · github.com/daydreamlive/scope (+docs/vace.md) ·
github.com/chenfengxu714/StreamDiffusionV2 · arXiv 2511.07399 ·
github.com/krea-ai/realtime-video · krea.ai/blog/krea-realtime-14b ·
github.com/guandeh17/Self-Forcing · github.com/NVlabs/LongLive ·
github.com/TencentARC/RollingForcing · github.com/thu-ml/Causal-Forcing ·
decart.ai/publications/mirage · fal.ai/models/decart/lucy-2-5/realtime ·
huggingface.co/decart-ai/Lucy-Edit-1.1-Dev · dotsimulate.com (TD) ·
github.com/livepeer/comfystream · jeff-liangf.github.io/projects/streamv2v ·
haoailab.com/blogs/fastwan-qad · github.com/KlingTeam/MemFlow ·
arXiv 2511.01266 · arXiv 2602.12271 · arXiv 2606.05981

---

## 6. Composite realism — why Route A reads as a sticker, and the hybrid

### Snap's actual recipe (the Route-A state of the art)
Body Mesh (generic template fit to pose, authored against a published UV
layout) + Uber PBR + mobile ray tracing on skinned meshes + **the secret
sauce: lighting from the live camera** — Dynamic Environment Map (ML-upgraded
env map generated in real time from camera input) and "From Camera" PBR
reflections (live feed as specular source). Realism = lighting response, not
texture quality. Matcap is the legacy trick; camera-fed IBL is the modern one.

### Per-frame relighting that's actually fast
ARCore/ARKit-style probes (per-frame, ~1 ms) · learned HDR env-map <9 ms on
an iPhone XS (arXiv 2011.10687) · DiffusionLight-Turbo ≈30 s (slow-lane probe
refresh) · EdgeRelight360 (real-time on-device portrait relighting) ·
SwitchLight 3.0 (video→PBR intrinsics, cloud, fps unpublished) · IC-Light
(Apache-2.0, seconds — keyframe lane).

### The four composite fixes (ranked by realism-per-cost)
1. **Frequency-split detail transfer** — render the material as low/mid band,
   re-inject the live frame's high-frequency luminance (pores, vellus hair,
   micro-glints, crease AO, subsurface red edges) via soft-light/linear-light.
   Nearly free; the single biggest lever. (Documented in AR-tattoo compositing
   literature: multiply/overlay over live pixels + displacement + tone match.)
2. **Real alpha matte, not binary masks** — MatAnyone-class quality offline,
   RVM live; feather + choke; Fresnel-weighted opacity falloff at grazing
   angles so the silhouette stays the person's.
3. **Camera-fed IBL** as above + slow-lane HDR probe.
4. **Flow-locking** — NVOFA hardware optical flow: ~536–1296 fps @1080p
   highest quality on Ada (<2 ms @720p; Blackwell ≥ Ada assumed, unverified);
   warp effect/lighting layers between updates, temporally filter mattes and
   probes. Learned fallback: NeuFlow v2. FRUC 4.41 ms @1080p (4090).

### Slow-lane photoreal keyframe editing + propagation
Editors: **Qwen-Image-Edit (20B, Apache-2.0, ~20 s full / Lightning distills
exist)** · FLUX.1 Kontext dev (12B, non-commercial, sub-5 s warm on H100;
~1–2 s distilled on 5090 plausible, unverified) · Nano Banana (cloud, 1.5–4 s,
best untouched-region preservation). Diffusion propagation (TokenFlow →
FRESCO → RAVE → FlowDirector → I2VEdit → NOVA '26) is all offline — for live,
propagation = **plain flow warping of the edit residual** (EbSynth logic)
with occlusion-masked re-fill at the next keyframe, seeded with the previous
warped result to kill keyframe pops.

### Material-transfer research bar
MaterialFusion / MatSwap (light-aware) / FROMAT: all offline; they define the
requirement — transferred material must inherit target geometry AND
illumination. Video try-on (Kling Kolors etc.): commercially mature, all
offline. **No published real-time neural material-on-skin exists; no shipped
product combines tracked-PBR + generative refinement — open lane.**

### Verdict (ranked)
1. **Hybrid tracked-PBR base + keyframe diffusion edit + flow-warped residual**
   — best realism-per-watt on one 5090; only path where the material inherits
   actually-photographed shading while staying live. Risk: keyframe pops;
   mitigate by seeding each edit with the previous warped result.
2. **Full live v2v** — highest ceiling (re-renders lighting/occlusion/SSS
   natively); today that's Lucy 2.5 (closed) or Scope-VACE 1.3B (open,
   stylization-grade) / 14B (Modal).
3. **Pure PBR compositing** — with all four fixes beats every consumer lens;
   plateaus below "indistinguishable" for organic materials. Correct as the
   always-on layer and as conditioning for 1–2.

Sources: developers.snap.com (Body Mesh · ray tracing · ML Environment
Matching · Light and Shadow · Portrait Relighting) · developers.google.com/ar
(lighting estimation) · arXiv 2011.10687 · diffusionlight.github.io/turbo ·
arXiv 2507.01305 · arXiv 2404.09918 (EdgeRelight360) · beeble.ai
(SwitchLight 3.0) · github.com/lllyasviel/IC-Light · NVOFA app note
(docs.nvidia.com/video-technologies/optical-flow-sdk) · arXiv 2408.10161
(NeuFlow v2) · github.com/pq-yang/MatAnyone · arXiv 2202.05297 (tattoo
compositing) · arXiv 2502.06606 (MaterialFusion) · arXiv 2512.09617 (FROMAT) ·
github.com/williamyang1991/FRESCO · rave-video.github.io · arXiv 2506.05046 ·
arXiv 2603.02802 (NOVA) · arXiv 2506.15742 (Kontext) · blog.google (Nano
Banana) · about.fb.com (Meta Restyle) · newsroom.snap.com (Video Gen AI
lenses) · mediapost.com (Snap real-time on-device model)
