# tools/facerig — automatic Auto-Rig-Pro-style FACE RIG for Meshy heads

Headless Blender 4.4 pipeline that turns an unrigged (or body-rigged) Meshy character
into a face puppet the engine can drive live from the camera:

```
foxfull.glb ──► facerig_author.py --stage markers ──► markers.json + check renders
                (front / side / below ray rasters, texture + geometry detection)
           ──► facerig_rig.py ──► foxfull_face.glb   (bones · weights · pose renders)
                                        │
                                        ▼
        engine: SPAWN 🦊 Fox → 🎭 mirror me   (sdk/interaction/arp-face-driver.js)
```

No system Python is needed — everything runs inside Blender's Python.

## 1. Markers (the Auto-Rig-Pro "Facial Setup" layout, placed automatically)

```
blender -b --python tools/facerig/facerig_author.py -- foxfull.glb <outdir> --stage markers --zmin 0.45
```

`--zmin` = the height (Blender z, metres) where the head region starts (just below the chin).
The placer rasterizes the head through a BVH from the front, both sides and below, sampling the
base-colour texture at every hit, then finds:

| region | rule | markers |
|---|---|---|
| nose | black blob at the front-most point | `nose_tip.x`, `nostril.l/r`, `nose_01..03.x` (bridge) |
| eyes | white ∪ dark blobs per side → ellipse | `eye_center`, `eyelid_top_01..03`, `eyelid_bot_01..03`, `eyelid_corner_01/02` |
| brows | dark blob above each eye, inner → outer | `eyebrow_01..04.l/r`, `eyebrow_full` |
| mouth | dark ∪ pink cavity grown along the dark-brown lip crease to the commissures (mirror fallback across the nose plane) | `lips_top.x`, `lips_top_01..03.l/r`, `lips_smile.l/r`, `lips_bot.x`, `lips_bot_01..03.l/r` (u = 0 / ±.3 / ±.6 / ±.85 / ±1) |
| chin / jaw | most forward-and-low mandible point; pivot behind the commissures under the ear | `chin_01/02.x`, `jaw_pivot.x/l/r` |
| cheeks | side surface under the eye / beside the jaw | `cheek_smile.l/r`, `cheek_inflate.l/r` |
| ears | top-most vertex per side; base where the silhouette widens | `ear_01` (base), `ear_02` (tip) |
| inside | pink / white pixels in the cavity | `tongue_01/02.x`, `teeth_top/bot.x` |

Outputs `markers.json` plus `markers_*.png` / `mouth_*.png` (green = upper lip, cyan = lower lip,
yellow = commissures, blue = eyes, red = jaw) and `debug_mouth_zoom.png` (what the crease
detector saw). Hand-tune with `--overrides my.json` (name → [x,y,z]) when a marker lands wrong.
The markers of record for the fox are `foxfull.markers.json`.

## 2. REBUILD the head (required for Meshy meshes) — `facerig_rebuild.py`

The Meshy head is a soup of ~200 open patches, ~2k triangles, no mouth interior and 4–6 vertices per eye:
no skin weights can animate that (the first attempt tore into triangle blocks). The rebuild remakes it the
way a modeller would, in about a minute headless:

```
blender -b --python tools/facerig/facerig_rebuild.py -- foxfull.glb tools/facerig/foxfull.markers.json <outdir> --bake 2048 [--render]
```

1. **Solid + remesh** — thicken the patches (30 mm skull / 9 mm ears via a vertex group), voxel-remesh at 4 mm,
   keep the largest shell, QuadriFlow to ~20k quads, then delete the INTERIOR sheet (faces blocked by all
   12 rays: the solidified soup keeps its inner surface, connected through rim tubes) → ~13k outer quads.
2. **Mouth cut** — exact booleans on the open shell: a thin blade along the lip crease (3.5 cm outward so it
   always reaches the remeshed skin, 4 mm at the tip → 0.8 mm at the commissures) and a cavity PRISM over the
   inset mouth outline (a loft that converges on the pivot self-intersects) whose palate / floor heights are
   clamped by ray-cast skin thickness. Skin faces left inside the cutter volumes are deleted.
3. **Interior** — procedural gums material, two rows of cone teeth (canines at |u| ≈ .45), a bent-ellipsoid tongue.
4. **Texture** — smart-UV the new skin, Cycles-bake base colour + tangent normal from the ORIGINAL head at 2k
   (4k runs out of memory on this box; the source metallic/emission are neutralised first).
5. Export `head_rebuilt.glb` + `rebuild.json` (crease samples, pivot).

## 3. Rig + weights + export — `facerig_rig2.py`

```
blender -b --python tools/facerig/facerig_rig2.py -- foxfull.glb <outdir>/head_rebuilt.glb tools/facerig/foxfull.markers.json <outdir>/rebuild.json sdk/assets/avatars/foxfull_face.glb <outdir> [--render]
```

* body = the original mesh minus its head faces (z-band weights); head = the rebuilt mesh, UV-seam duplicates
  WELDED on import (else each copy diffuses with its own neighbours and the skin tears along the islands).
* 62 ARP-named deform bones at the markers (same contract as `arp-face-driver.js`).
* Weights by DIFFUSION on the head's own vertex graph: the jaw field is hard by side of the slit in front of the
  commissures (the slit IS the split; any blend there stretches the lip rims across the slot) and blends
  along the surface only behind them (6 mm → 5 cm band, pinned at the pivot); cavity walls hard by side;
  teeth rigid (top → head, bottom → jaw); tongue on two bones; every face bone = Gaussian seed → diffused →
  share of the head/jaw pool (partition of unity, ≤ 4 influences).
* `--render` writes pose checks (rest, open A/B to find the jaw sign, smile, pucker, brows+blink) and a
  material-ID open view; the log lists faces that stretch > 2 cm on jaw open (a few dozen is normal, all
  behind the commissures or inside the mouth).

## 4. Legacy: rig on the raw mesh — `facerig_rig.py`

Kept for reference; it produced the triangle-block result on the Meshy mesh.

```
blender -b --python tools/facerig/facerig_rig.py -- foxfull.glb tools/facerig/foxfull.markers.json out.glb <outdir> --zmin 0.45 [--render] [--subdiv 2]
```

* Subdivides the face (linear, 2 passes: front half of the head, then 5 cm around the lip ring)
  so each lip bone owns 20–40 vertices on a 10k-vertex Meshy mesh; custom split normals are
  cleared afterwards (subdividing them leaves dark shards in three.js).
* Body: an existing armature's head bone is detected from its vertex groups; an unrigged
  export gets a `hips / spine / chest / neck / head` chain (the mesh becomes a SkinnedMesh).
* 62 deform bones: `jaw.x` (pivot → chin) parents the lower ring, chin, lower teeth, tongue;
  everything else parents the head. `lips_smile` draws weight from BOTH the head and jaw pools
  (the runtime blends the commissures 50 % with the jaw — Rigify / ARP "lips elasticity").
* Weights: jaw cut along the lip line with a smoothstep band (1.2 cm at the lips, widening to
  5 cm behind the commissures), Gaussian kernels per face bone with region masks, ≤ 4
  influences, normalized. `--render` writes `pose_*.png` (rest, open, smile, pucker, brows+blink).
* glTF export keeps the original 4k textures (detection works on a downscaled COPY).

## 5. Runtime

`sdk/interaction/arp-face-driver.js` (`FOX_ARP`, `ArpFaceDriver`): ring-to-ring lip mapping
(human 20-point outer-lip contour ↔ fox lip ring, both parametrized tip → commissure), mouth
shut at the user's neutral (the Meshy fox is modelled ajar), jaw hinge, commissures following
half the jaw, lids from blink, gaze from the eyeLook* blendshapes, 4-bone brows, cheeks, nose
sneer, ears, head + neck. three.js drops `.` from node names — the driver aliases
`jaw.x` ↔ `jawx`, so the readable ARP names stay in the contract.

Tests: `npm run test:facerig-arp` (node, bone contracts) · `node tests/_foxfullprobe.mjs`
(browser, synthetic face, screenshots in `PROBE_SHOTS`) · `node tests/_foxfullcloseup.mjs` (engine
close-ups of the mouth at neutral / open / smile) · `tools/facerig/_diag_mesh.py` (is a mesh animatable
at all: density, shells, interior geometry).

## Re-running on a new character

1. Drop the GLB in the repo, pick `--zmin` just below the chin (render `tools/facerig/_render_views.py` to eyeball it).
2. Stage `markers`, look at the renders, override what is off.
3. Stage `rig` with `--render`, check `pose_open_left.png` (teeth + tongue should drop with the jaw, no cheek tearing).
4. If the character came body-rigged (Meshy / UniRig), the face bones parent under its head bone automatically.
