# EFFECTS PIPELINE — prompt → realistic live effect on the user's body & world

Design of record, 2026-07-28. This is the product-generation architecture the
studio implements: how a free-text prompt becomes a realistic, tracked,
collidable effect wrapped onto the live person and room. Status marks:
✅ built · 🔧 installed-not-wired · ⬜ planned.

---

## 0. The one-paragraph version

A prompt compiles into an **EffectSpec** {where, look, motion}. *Where* comes
from the tracking stack (masks → mesh → body-UV). *Look* comes from a texture
source (procedural shader, CC0 PBR, or on-node diffusion texgen). *Motion* is
a dynamics template (growth front, particles vs body colliders, instanced
geometry). Realism comes from one rule: **the base color of every effect
surface is the user's own live pixels** (projective texturing), so effects
modulate reality instead of covering it — and from depth-correct occlusion
off the reconstructed body mesh. Heavy models refresh slowly on the 5090;
everything the eye judges (skin sampling, warp, lighting) runs per display
frame in the browser shader. That split is why it can look continuous over a
~200ms link.

## 1. Pipeline

```
PROMPT ("green slime dripping from my head")
  │  E4 effect compiler (LLM via our existing /api/claude proxy → EffectSpec JSON)
  ▼
EffectSpec { where: region/part/bone · look: material source · motion: dynamics }
  │
  ├─ WHERE — surface addressing (3 levels, coarse→fine)
  │    L1 screen mask      SAM3 concept/person masks            ✅ (warped, cs-13)
  │    L2 body mesh        SAM-3D-Body → MHR verts + cam        ✅ (2.5Hz, lerped)
  │    L3 body-UV + parts  DensePose IUV → SMPL UV atlas        🔧 (.venv-tex ready)
  │                        └ part indices = semantic regions ("left forearm",
  │                          "head", "fingers") → prompts can target anatomy
  │
  ├─ LOOK — material source
  │    procedural GLSL (scales, veins, fire…)                   ✅ (scales)
  │    CC0 PBR fetch (ambientCG/PolyHaven albedo+normal+rough)  ⬜ (~half day)
  │    on-node texgen: FLUX.1-schnell + tiling → serve_files    ⬜ (~day)
  │    SMPLitex identity/effect skins in body-UV space          ⬜ (later)
  │
  ├─ MOTION — dynamics templates
  │    growth front (param sweep in body space)                 ✅
  │    stick (UV-space anchoring: effect pinned to anatomy)     🔧 needs L3
  │    drip/flow (GPU particles/SPH vs BODY COLLIDERS —
  │      capsules from MHR pred_joint_coords, already streamed) ⬜
  │    flutter/instanced geometry (feathers/fur cards on mesh
  │      faces inside a part-region, normal+bone oriented)      ⬜
  │
  └─ COMPOSITE — the realism layer (all per-display-frame, in-browser)
       projective texture: base = user's live pixels            ✅ (st-3)
       vertex lerp between rig refreshes                        ✅
       mask motion-warp                                         ✅
       screen-space normals → relight                           ✅ (v1)
       depth occlusion (mesh depth vs game objects/hands)       ⬜ (E1)
       mask-feathered edges + scene-light harmonization         ⬜ (E1)
```

## 2. Model inventory

| Model / tech | Role | Runs | Status |
|---|---|---|---|
| SAM3 (facebook/sam3, fp16) | text-concept masks + ids | 5090, ~0.4s duty-cycled | ✅ |
| yolo11s-pose | 17-kpt skeletons, full rate | 5090, ~15ms | ✅ |
| SAM 3D Body (vith) → MHR | body mesh 2767v + cam params | 5090, 0.2s @2.5Hz | ✅ |
| DensePose (detectron2) | pixel→(part,U,V) addressing | 5090 `.venv-tex` | 🔧 |
| FLUX.1-schnell (Apache) | prompt→seamless texture ~1s | 5090, on demand | ⬜ |
| SMPLitex / TexDreamer | UV-space skin completion | 5090, one-shot | ⬜ |
| Claude (existing /api/claude) | prompt → EffectSpec JSON | Vercel proxy | ⬜ E4 |
| StreamDiffusionV2 (optional) | hallucinated-effect lane | 5090 | ⬜ decision open |

## 3. Latency classes — why it reads live

| Layer | Rate | Note |
|---|---|---|
| skin sampling, lighting, growth, warp | every display frame (60fps, local) | the eye judges THIS |
| skeletons/pose | ~10-20Hz over link | drives warp + interp |
| mesh pose refresh | ~2.5Hz, vertex-lerped | shape only |
| mask shape refresh | ~1-2Hz, warped between | shape only |
| texgen / UV accumulation / SMPLitex | seconds, once | cached per identity |

Rule enforced everywhere: **slow lanes ship state; the fast lane ships looks.**

## 4. Worked examples (how a prompt executes)

**"green slime dripping from my head"** → where: part=head (L3; today L2
top-of-mesh) · look: procedural slime shader (glossy green, video-refraction
so it bends HER pixels) · motion: particle emitter at region, gravity, SPH-ish
cohesion, colliding with MHR bone capsules, merging metaball render; occlusion
vs mesh depth so drips pass BEHIND the arm.  — needs E1+E5.

**"realistic 3D feathers on my forearm"** → where: DensePose parts 16/18
(forearm) → face subset of the mesh · look: feather card texture (texgen or
CC0) · motion: instanced cards on those faces, oriented normal+bone axis,
flutter from pose velocity; base shafts sample skin pixels. — needs E2+E6.

**"turn my skin to scales"** → today's ✅ path end-to-end (st-3/st-4).

## 5. Build order

- **E1 occlusion+edges** (~day): render mesh depth; game objects/hands clip
  behind body; SAM-mask feathered alpha on all effect layers.
- **E2 DensePose lane** (~day): `.venv-tex` worker beside the rig lane →
  per-part UV in the packet; "on my forearm/face/hands" becomes real.
- **E3 texgen service** (~day): FLUX.1-schnell + `{cmd:'texgen',prompt}` →
  tunnel URL → live material swap.
- **E4 effect compiler** (~half day): /api/claude → EffectSpec; free-text
  prompts stop being keyword matches.
- **E5 slime dynamics** · **E6 instanced feathers/fur** (2-3 days each).
- **E7 SMPLitex identity skin** (later, with T2 UV accumulation).

## 6. Honest limits

Single rigged person for now; mesh alignment inherits 3DB's camera estimate
(mask-guided snap is a planned E1 refinement); mask/mesh SHAPE refreshes are
tunnel+model bound until the sam3.1-multiplex port and/or a nearer compute
region; "indistinguishable" is an asymptote — projective texturing + occlusion
+ relight gets close; the last mile is E7 + scene-light harmonization.
