# Live Effects Engine — calibrated real-time gen FX on tracked bodies

Research synthesis, 2026-07-28. Goal: "point at forearm, say *green fish scales*,
scales grow on your skin and stick" — plus conjurable objects (basketball,
butterfly) with real collision/gravity — **in real time, on any device's screen**,
from the cloud dollhouse. This extends SAM3_INTEGRATION_PLAN.md (S0–S6) with the
generation + delivery tiers. Four research sweeps behind this: world-model route
(Decart), real-time body mesh, fast gen models, low-latency cloud-AR streaming.

---

## 0. The thesis (and why Decart's route can't beat us here)

**Decart (MirageLSD / Oasis / Lucy 2) regenerates every pixel of every frame
through a video diffusion model.** Verified numbers: MirageLSD ≈40 ms *model*
time but **~100 ms end-to-end per frame**, 768×432, 20–24 fps on Hopper-class
GPUs; Oasis 360p/20fps with ~3 s of world memory; Lucy 2 claims 1080p30 with
third-party reports of 200 ms+ at 1080p. Their whole training apparatus
(Diffusion Forcing + History Augmentation) exists to fight autoregressive
drift — and they still concede: **no persistent 3D state, no object-level
control, no collision, inserted objects "attach to the subject."** Frame
latency is their floor, not their ceiling: every frame pays the model.

**Our route inverts it: generation is an *asset-time* event, never a
*frame-time* event.** The frame loop is tracking + skinning + rendering +
compositing — deterministic, milliseconds. A generated texture/mesh binds once
to the tracked MHR rig and then deforms/collides for free, forever. Latency of
generation (0.05–3 s) is UX ("the scales grow in"), not motion-to-photon lag.
The field converged on the same split: PersonaLive/StreamAvatar and the whole
StreamDiffusion ecosystem inject explicit keypoints/depth/pose as conditioning
— **geometry is the control channel, diffusion is the texture channel.**
Decart's real transferable lesson is systems engineering: distillation,
pruning, fused kernels bought their 16× — not new theory.

## 1. The five lanes

```
camera → [A: tracking core] → [B: surface/UV attach] → [D: physics] → [E: delivery]
voice/tap → [C: generation service, OFF the frame loop] ──↑ (binds assets to B/D)
                                    [F: optional stylize pass, every Nth frame]
```

### Lane A — tracking core (per-frame, the 5090)
Already planned (S1–S4); research adds the speed numbers that make it real-time:

- **SAM 3.1 multiplex** concepts (person/ball/floor/wall/free-text) — 16 objects
  per pass, 32 fps H100-class; sam3.1-tiny >60 fps on an L4. (Per plan §1.)
- **Body rig: SAM 3D Body → MHR, with Fast-SAM-3D-Body pruning.** Stock 3DB is
  ~1 fps — but arXiv 2603.15603 (training-free: drop self-prompt refinement,
  keep decoder layers {0,1,2}, feedforward MHR→SMPL map) hits **~65 ms/frame on
  an RTX 5090 (~15 fps)**, accuracy parity. Run at 10–15 Hz on locked ids,
  One-Euro on the 204 pose floats, client interpolates to 60 — exactly the
  packet-interp pattern that already exists. MHR's decoupled skeleton/shape +
  LODs (595→73k verts) is purpose-built for what Lanes B/D need.
- **Hands: WiLoR** (130–175 fps GPU, MANO out) gated by MediaPipe hand presence
  for close-up shots; otherwise trust MHR's built-in hand articulation.
- **Alpha matte lane: RVM** (100+ fps HD) stays as the cheap always-on person
  alpha; SAM masks for concepts/parts.

### Lane B — surface attachment (the "stick to skin" mechanism)
The single most important research finding for the fish-scales demo:

- **Skip DensePose. Rasterize the posed MHR mesh's UVs** (nvdiffrast or
  three.js render target) masked by the SAM person mask → dense, temporally
  stable per-pixel image↔surface correspondence at <1 ms. Effects are authored
  in **MHR UV space** (a decal/material region on the body texture) and sampled
  per pixel. This is how Snap Body Mesh attaches gowns; ours is rig-exact.
- **Part targeting** ("forearm"): render MHR per-part vertex colors in the same
  pass → license-clean part masks (Sapiens is CC-BY-NC — avoid). User tap ray →
  hit UV → flood the part region; "forearm" resolves from the tapped bone id.
- **Growth effect**: shader-side reveal mask animated outward from the tap UV +
  height-map parallax/displacement. Zero generation in the loop — the "special
  effect" is a uniform ramp.

### Lane C — generation service (three tiers, off the frame loop)
The Meshy/Tripo/Blender-MCP work moves here as Tier 2; Tiers 0–1 are new and
are what makes it *feel* instant:

- **Tier 0 — instant (<100 ms): retrieval.** Curated library of pre-made
  tileable PBR materials (scales, chrome, lava, fur…) + pre-rigged props,
  indexed by SigLIP/CLIP embeddings in FAISS (<10 ms lookup). Parse color
  ("green") → shader tint uniform. The effect *starts* from Tier 0 always.
- **Tier 1 — fast (0.5–3 s): generate the real ask.**
  - Material patch (primary path for skin effects): **StableMaterials-LCM**
    (4-step, 512², tileable, full PBR maps, OpenRAIL) or **FLUX.1-schnell**
    (Apache-2.0, ~0.7 s H100) + normal-from-height → **~0.5–1.5 s on the 5090**;
    hot-swap over the Tier-0 material under the same reveal mask.
  - Texture a given mesh: **TRELLIS.2 shape-conditioned texturing** (~1–3 s,
    MIT); fallback FlashTex / Make-A-Texture (~3 s).
  - New prop geometry: **Hunyuan3D-2mini-Turbo + FlashVDM** (<1 s shape on a
    4090) or **TripoSR (0.2 s) / SPAR3D (0.7 s)**; quick texture; parent to a
    body joint or drop into physics — props don't need rigs.
- **Tier 2 — async (15 s–2 min): production swap.** **TRELLIS.2 @1024³**
  (17 s, MIT, full PBR) or Meshy/Tripo API; **UniRig (1–5 s)** when the asset
  must deform with the body; silently replace the Tier-1 asset (Meta AssetGen's
  Flash→full pattern). Blender MCP remains the offline authoring/repair tool.
- Retrieval-then-generate in live AR appears to be **open ground** — no product
  found doing it; Snap's GenAI Suite is minutes-scale, in-editor.

### Lane D — physics (already mostly built)
- **Capsule-per-bone proxies** from the MHR skeleton (update from joint
  transforms, 60 Hz) + **MHR LOD5 (595 verts) skinned mesh collider** for
  surface-accurate contacts. Kinematic one-way coupling into Rapier — the
  handlab contact solver and grip model port unchanged.
- Feed the solver **estimated bone velocities** (from the One-Euro state), not
  just positions — restitution reads right; a chest-bounce looks like a bounce.
- Floors/walls per plan §2; conjured props are ordinary dynamic bodies.

### Lane E — delivery (two modes; packet stays the contract)
Handheld/screen AR tolerance is the architectural gift: users notice ~69 ms,
prefer <132 ms — vs 20 ms for headsets. Two modes, per effect weight:

- **Mode 1 — packet mode (default, ships first).** What we do now, extended:
  stream landmarks + 204 MHR pose floats (~0.8 KB/person) + *asset events*
  (`{fx:'material', part:'forearm_l', url:'…glb/ktx2', reveal:{uv,t0}}`).
  Client three.js skins MHR + renders the effect locally. World latency = 0
  (it's the local camera), effect latency = packet latency. Cheapest, works on
  every current client; generation tiers just push URLs.
- **Mode 2 — effect-layer streaming (heavy FX: volumetrics, cloth, crowds).**
  Dollhouse renders the effect layer only; **packed alpha** (effect on top,
  luma matte stacked below in one frame — survives NVENC, codec-agnostic;
  WebRTC ignores native alpha); NVENC zero-frame-delay (~5–10 ms); WebRTC now /
  WebTransport next (QUIC datagrams for the landmark uplink, ~30 % lower
  latency; Safari 26.4 has it). Client shader splits alpha, **late-reprojects
  2D by the pose delta**, composites over the **local live camera** — the world
  never lags, only the effect does. Budget: **~50–110 ms effect lag**, under
  the 132 ms threshold; server sim runs at t+RTT (One-Euro + velocity
  extrapolation; ~cm error at 100 ms, hidden by dilated/feathered mattes).
- Client keeps a ~5-frame camera ring buffer keyed by capture timestamp →
  optional **precision mode** (composite against the matching buffered frame:
  perfect registration, whole view delayed ~RTT) for tight-contact moments.
- Design effects misalignment-tolerant: glows, particles, auras, soft edges —
  not hard silhouette-locked overlays.

### Lane F — optional stylization polish (the only diffusion in the loop)
**StreamDiffusion** SD-Turbo 1-step img2img (~10 ms @512 on a 4090, Apache-2.0)
over the effect bounding box every Nth frame, conditioned on our pose/depth
(ControlNet-in-stream is production-real in StreamDiffusionTD at 15–25 fps).
Use at low denoise strength to melt the CG/skin seam. Strictly optional; ship
without it, add behind a flag. This is the *entire* Decart idea, shrunk to a
garnish where it can't cause drift or lag.

## 2. Latency budgets (same-region GPU, ≤30 ms RTT)

| Path | Budget |
|---|---|
| Tracking → packet → client render (Mode 1) | ~35–70 ms effect-visible lag |
| Mode 2 full loop (capture→uplink→sim/render→NVENC→downlink→decode→composite) | ~50–110 ms unpredicted; ≈ prediction error with t+RTT sim |
| Tier 0 conjure (retrieval) | 10–50 ms to first visible effect |
| Tier 1 real texture swap | +0.5–3 s, masked by the growth animation |
| Tier 2 production swap | +15 s–2 min, silent |

The UX trick that makes it feel instant: **Tier 0 answers immediately, the
reveal/growth animation covers Tier 1's generation window, Tier 2 swaps
silently.** Nothing ever blocks on a diffusion model.

## 3. Execution order (continues SAM3 plan's S-numbering)

- **F1 — UV attach pass**: nvdiffrast (server) or render-target (client) UV +
  part-id rasterization of the posed MHR mesh; tap→UV→part resolution; shader
  reveal mask. Demo: flat green decal "grows" on the forearm. No gen yet.
- **F2 — Tier 0 retrieval**: ~50 premade tileable PBR materials + ~20 rigged
  props; SigLIP+FAISS; color/verb parsing; asset-event packet fields.
- **F3 — Tier 1 gen workers** (5090, separate venv/queue): StableMaterials-LCM
  + FLUX-schnell material path; TRELLIS.2 texturing; Hunyuan3D-mini/TripoSR
  props; hot-swap protocol (same asset id, new URL).
- **F4 — physics glue**: capsule set + LOD5 collider from live MHR; prop
  conjure → dynamic body; chest-bounce/hand-grab regression vs handlab.
- **F5 — Mode 2 streaming lane**: offscreen three.js (or headless renderer) →
  NVENC packed-alpha → WebRTC; client composite shader + 2D late-reproject +
  ring buffer. Gate: measured glass-to-glass <130 ms.
- **F6 — Tier 2 + rigging**: TRELLIS.2 1024³ / Meshy/Tripo API + UniRig;
  silent swap; Blender MCP as repair/authoring bench.
- **F7 — stylize flag**: StreamDiffusion pass over effect bbox, A/B'd.

## 4. Open risks

- Fast-SAM-3D-Body numbers come from one 2026 paper — reproduce on our 5090
  before betting the rig tier's Hz on it (fallback: 5–10 Hz + interp, already
  acceptable per SAM3 plan §6).
- 5090 VRAM contention: SAM 3.1 + 3DB + gen workers won't all fit hot.
  Tier 1 workers should load/unload (or live on a second cloud GPU); profile.
- Licenses: SDXL-Turbo is non-commercial (use FLUX-schnell/SDXL-Lightning);
  Sapiens is NC (avoided by design); FlashTex license unverified; Hunyuan3D is
  Tencent community license (region/commercial caveats); read MHR + SAM-3D-Body
  LICENSE files before any paid launch. Clean core: TRELLIS.2 (MIT),
  FLUX-schnell (Apache-2.0), StableMaterials (OpenRAIL), StreamDiffusion
  (Apache-2.0), Rapier (Apache-2.0), RVM (GPL-3.0 — isolate as a service).
- WebCodecs drops alpha; packed-alpha is the hedge (codec-agnostic). MoQ not
  ready for the 1:1 loop yet (200–400 ms in production) — WebRTC now.
- Prediction error on fast limbs (~cm at 100 ms) will show on tight-fit
  effects in Mode 2 — keep skin-locked effects in Mode 1 (client-rendered)
  where they track at packet rate.

## 5. Sources (key; full trails in research notes)

- Decart/world models: decart.ai/publications/mirage · oasis-model.github.io ·
  the-decoder.com MirageLSD coverage · huggingface.co/decart-ai/Lucy-Edit-Dev ·
  github.com/etched-ai/open-oasis · krea.ai/blog/krea-realtime-14b ·
  github.com/cumulo-autumn/StreamDiffusion · arxiv.org/abs/2511.07399 (SDv2)
- Body/rig: github.com/facebookresearch/sam-3d-body · arxiv.org/abs/2603.15603
  (Fast SAM 3D Body, 65 ms/5090) · github.com/facebookresearch/MHR ·
  arxiv.org/abs/2511.15586 · github.com/warmshao/WiLoR ·
  github.com/PeterL1n/RobustVideoMatting · nvdiffrast
- Gen: github.com/microsoft/TRELLIS.2 · huggingface.co/gvecchio/StableMaterials ·
  github.com/Tencent-Hunyuan/FlashVDM · github.com/Stability-AI/stable-point-aware-3d ·
  github.com/VAST-AI-Research/UniRig · flashtex.github.io ·
  arxiv.org/abs/2605.26137 (AssetGen Flash→full) · arxiv.org/abs/2403.09675
  (retrieve-else-generate)
- Streaming: jakearchibald.com/2024/video-with-transparency (packed alpha) ·
  arxiv.org/abs/2505.22132 (QUIC vs WebRTC) · learn.microsoft.com Azure Remote
  Rendering LSR · gafferongames.com snapshot interpolation · protocol.vmc.info
  (landmark-streaming precedent) · developer.nvidia.com CloudXR 6.0
