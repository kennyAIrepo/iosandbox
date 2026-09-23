# tools/cloth — turning a stiff scanned prop into a CLOTH asset

`rug.glb` (Meshy, 1,005,393 triangles) is rigid not because it lacks vertices —
it has 2.4 mm edges, 500 k of them — but because it has no **simulation
topology** and no solver can touch half a million particles in a frame.
This tool gives it both: a coarse regular **lattice** that a cloth solver runs,
and the rug's own surface **embedded** in that lattice so every fringe, braid
and fold rides along.

```
rug.glb  (1.0 M tris, one rigid shell, 17.5 mm slab, gently bowed)
  │
  ├─ weld glTF splits, drop 163 junk shells, lay flat (XZ, +Y up), centre
  ├─ ray-scan the slab at 6 mm → body footprint + mid-surface field
  ├─ flatten the bow (a cloth rest state must be flat, or it remembers the bow)
  ├─ LATTICE   45 × 64 = 2,880 nodes, 30 mm cells      ← what the solver moves
  ├─ SKIN      decimate 1.0 M → 90 k tris, UVs kept     ← what the eye sees
  └─ EMBED     every skin vertex = bilinear cell + offset in that cell's frame
       ↓
sdk/assets/props/rug_cloth.glb   (RugSim + RugSkin, 13.4 MB)
sdk/assets/props/rug_cloth.json  (grid spec — the runtime rebuilds the binding from it)
```

```
blender -b --python tools/cloth/rug_cloth.py -- rug.glb sdk/assets/props/rug_cloth.glb <outdir> \
        --sim 0.030 --skin 90000 --tex 2048 --test
```

`--test` runs a real Blender cloth sim on the lattice (pinned at two nodes, a
9 cm ball in the way, 70 frames), carries the skin through the embedding and
renders it — proof that the topology deforms before any runtime code exists.

## How dense? — measured, not guessed

The XPBD loop we would ship (structural + shear + bend, Gauss–Seidel, 8
substeps, 42 hand-joint spheres) timed on **this** box, a Snapdragon ARM64
where MediaPipe already eats most of the frame (`bench_xpbd.mjs`):

| cell | grid | nodes | edges | ms/frame | verdict |
|---|---|---|---|---|---|
| 50 mm | 27×39 | 1,053 | 6.0 k | 1.8 | too coarse — a finger passes between nodes |
| 40 mm | 34×48 | 1,632 | 9.4 k | 2.7 | coarse |
| **30 mm** | **45×64** | **2,880** | **16.7 k** | **4.7** | **shipped** — 3 ms at 5 substeps |
| 25 mm | 54×77 | 4,158 | 24.3 k | 7.0 | over budget here |
| 20 mm | 67×96 | 6,432 | 37.8 k | 11.0 | desktop-only |
| 10 mm | 133×191 | 25,403 | 150.8 k | 42.9 | offline |

30 mm cells sit where the two limits cross: a finger capsule (≈ 11 mm radius)
still lands inside a cell (collide the lattice *edges*, not only the nodes, and
inflate by half a cell), and the solve leaves the frame to the tracker. The
render skin at 90 k tris is 31× finer than the lattice, so folds read smooth
however coarse the physics is — the same low-sim/high-render split Chaos Cloth
and Marvelous use, and what the WebGPU cloth study measures (sim spacing ≈ 2 ×
render spacing).

## The embedding (what the runtime does at load)

The rest lattice is a flat axis-aligned rectangle, so the binding needs no
solver — it falls out of the rest position:

```
u = clamp((x − u0)/dx, 0, nx−1)     i = ⌊u⌋, a = u − i
v = clamp((z − v0)/dy, 0, ny−1)     j = ⌊v⌋, b = v − j
off = p_rest − bilerp(rest cell)              // ≈ ±half the 17.5 mm slab
p   = bilerp(live cell) + off.x·T + off.y·B + off.z·N
```

`T, B, N` are the live cell's tangent/bitangent/normal (bilinearly interpolated
across the sheet). Offsets measured: **p50 11.2 mm, p95 24.2 mm** — half the
slab, as expected; the long tail (max 85 mm) is fringe strands, which clamp to
the boundary cells and dangle past the edge. Nothing else is stored, so the
binding can never go stale against the GLB.

## Asset layout

| node | what | counts |
|---|---|---|
| `RugSim` | the cloth lattice, quads, no material | 2,880 verts / 5,544 tris |
| `RugSkin` | the visible rug, UV + 4×2k textures | 71,750 verts / 89,975 tris |

Both lie flat in XZ with +Y up, centred on the origin (the source stands upright
in XY — Meshy's front-facing frame), 1.308 × 1.890 m, 17.5 mm thick.

## Runtime — `sdk/core/cloth-sim.js`

`ClothSim` is XPBD on the lattice (small substeps, one Gauss-Seidel sweep each,
extra sweeps + a hard length clamp on the weave, and **long-range attachments**
so a sheet hanging from two fingers cannot creep). `ClothSkin` binds the render
mesh and deforms it **in the vertex shader** off a 45×64 lattice texture — 71 k
vertices, zero CPU. `buildCloth(gltfScene, spec)` wires both and re-derives the
lattice indexing from the node positions (never trusting the exporter).

Contact is what makes it feel real, and it is built two ways because a fingertip
is **smaller than a cell**:

* joint SPHERES vs the cloth's TRIANGLES (barycentric push) — sub-cell contact,
  so the sheet meets a finger wherever it lands;
* finger CAPSULES (`HAND_BONES`) vs the nodes — deep contact;
* both use `JOINT_RADII` from `game-physics.js` — the *same* radii the HoloHands
  render with, so there is no gap between the drawn hand and the cloth;
* `clothResistHand()` takes whatever the cloth could not yield out of the HAND:
  the pack is translated back out (swept capture, so a fast finger cannot tunnel)
  **before the rigs pose**, so the drawn fingers stop on the weave.

A closing hand (fist or pinch) grabs the nodes under it and carries them in the
palm frame; opening releases with the hand's velocity.

## In mpbrowser

| | mirror lane | engine lane |
|---|---|---|
| spawn | `🧶 SPAWN RUG` (PROP · CLOTH RUG) | `🧶 Rug` in SPAWN OBJECT |
| resize | `➖ / ➕`, or PINCH with both hands | `➖ / ➕` on the RUG strip, or pinch |
| reset | `↺ flatten` | `↺ flatten` |
| debug | `◫ lattice` | `◫ lattice` |
| extra | lies at hand height — slide your hands under it | `📌 hang it` (curtain), `📷 frame` |

Tests: `npm run test:cloth` (node — solver, embedding, grab, hand-stop, budget) ·
`node tests/_rugprobe.mjs` (browser — 17 contracts across both lanes, screenshots
in `PROBE_SHOTS`).

## Still open

* self-collision is off: a fold can pass through itself if you crumple it hard;
* the engine lane seats the sheet on the world floor, so a **rotated** rug group
  gets a plane-vs-local approximation for the floor height;
* 13.4 MB is almost all texture (4 × 2k JPEG).
