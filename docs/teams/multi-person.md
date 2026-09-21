# Multi-person tracking with stable ids - the two topologies and what the SDK already gives you

Repo `C:/Users/hanna/iosandbox` HEAD `6c8e6bc`, read 2026-09-18; every `sdk/core/*` file cited is byte-identical to HEAD. Written by the finisher pass from the sources on disk (`sdk/core/multiplayer.js`, `player-tracker.js`, `player-pipeline.js`, `multipose.js`, `test-source.js`, `mpgames.html`) and the built research module `research/codebase/sandbox-skeleton/sdk/game/tile-pipeline.js`. Companion: `dropins.md` section 3.11 has the per-call contracts; this file is about WHICH topology, WHY ids are stable, and the budgets.

## 1. The decision in one paragraph

The Teams twin has N tiles, each showing ONE participant from their OWN camera (or a remote stream). That is topology **B: one pipeline per tile**, and the stable id is the tile / participant id - stable by construction, no re-identification needed. The repo's `initMultiplayerTracking` (topology **A: one camera, N people**) is the wrong tool for the twin's normal case: it exists to find several bodies in one frame with MoveNet and hand each a crop; you only need it for the "two people share one laptop camera" tile, and even then it can run INSIDE that one tile. The architecture memo already fixed the rest: track locally, relay ~600 B landmark packets at 30 Hz, render everyone locally - so a remote participant's tile never runs a landmarker on the incoming Teams video; it consumes their packet stream and feeds the same downstream chain (`HandViews.resolve -> HoloHandRig / HandBody / PropBall`).

## 2. Topology B - N tiles, one person each (`TilePipeline`, built)

`research/codebase/sandbox-skeleton/sdk/game/tile-pipeline.js` (8 KB) is the per-tile unit, built only from public SDK seams:

```js
import { TilePipeline, cloneStreamToTiles } from './sdk/game/tile-pipeline.js';
const tile = await new TilePipeline('alice', videoEl, { scene, camera, withPose: false, predMs: 40, style: 'smooth', occluder: true }).init();
tile.setCover(boxW, boxH);                                   // on loadedmetadata / resize of THIS tile
// per frame
const { packs, handL, handR, body } = tile.detect(now, dt, [ball.collider]);   // packs = { R, L, hands:[{mesh, slot, points, img}] } world space
ball.update(dt, packs, { left: handL, right: handR });
```

What it does per frame (`tile-pipeline.js:78-100`), and where each step comes from:

1. `PlayerPipeline.detect(video, {x:0,y:0,w:1,h:1}, size, now, { fullFrame: true, wantPose, poseEvery: 2, frameCount, predMs })` - `fullFrame: true` skips the crop and the intruder mask (`player-pipeline.js:106-107`) because the tile holds one person by construction. Output hands are ALREADY One-Euro filtered and predicted, in full-frame mirrored units (`player-pipeline.js:175`, `:203-208`) - the same `{img mirrored, world raw}` shape `tracking.js` emits, so nothing downstream changes. Do not filter again.
2. Slot loss: a slot absent for 400 ms calls `views.dropSlot(slot)` to reset the chirality and z-sign latches (`hand-views.js:404-407`; the 400 ms is `handlab.html:912-916`).
3. `HandViews.resolve([left, right], camera)` - the ONLY mirror/flip authority. Chirality is MEASURED from the palm-block volume (`hand-views.js:76-92`, `:167-186`); the z convention is decay-latched in `_zSign` (`:391-401`). MediaPipe handedness labels are never read - the only line in the whole stack that reads a label is the legacy `hopeos.js:345`, which the sandbox does not use.
4. Rigs posed with the same packs physics reads (`handlab.html:355-356`), then `HandBody.update` per SCREEN slot, `HandBody.drop()` when absent.
5. `HandBody` slot strings are `'left#' + id` / `'right#' + id` - the fix `mpgames.html:652-655` documents: grab / held / twist logic compares slot strings, and 2N hands would otherwise alias as one `'left'/'right'` pair.

Body: pass `withPose: true` ONLY on the tile that needs `BodyBody` collision (the local user, typically); `body = { img: 33, world: 33 }` is then available every `poseEvery`-th frame and goes through `views.mirrorPoint -> BodyPose.stabilizeMirror -> HoloBodyRig.pose -> BodyBody.update` as in `dropins.md` 3.10.

### 2.1 Budgets that decide how many tiles can track locally

- **WebGL contexts.** Every landmarker holds its own GL context (`player-pipeline.js:66-69`: "4 players x 2 tasks + Three + TF.js brushes the browser's WebGL-context ceiling - the 4th player's hands never track"). Chrome's practical cap is ~16 contexts per page, but the failure shows up earlier because MediaPipe contexts are heavy. Rule for the twin: hands on every LOCAL tile, pose on at most one, no MoveNet unless a tile is shared - i.e. 3 local tiles = 3 hand contexts (+1 pose +1 three.js = 5).
- **Time.** `initMultiplayerTracking` budgets 45 ms total per frame (`multiplayer.js:90`) and staggers hands round-robin above 2 players (`:41`, `:161`); a hand landmarker on a 1280x720 tile is ~10-13 ms on this box (`_probe-minimal` measured 12 ms). Three tiles of hands at 30 Hz is ~36 ms - at the edge. Options, in order: (a) run remote tiles from their PACKETS (the memo's design - zero local landmarkers for remotes); (b) `predMs`/`predictOnly(tMs)` (`player-pipeline.js:261-272`) to bridge skipped frames and detect each tile every other frame; (c) lower the tile video to 640x360 before `detect` (the crop path in `PlayerPipeline` already renders to a `cropPx` canvas - pass `fullFrame:false` with the full box and `cropPx: 512` to get the downscale for free).
- **The WASM fileset is shared.** `createHandLandmarker / createPoseLandmarker` memoize one fileset (`tracking.js:46-63`, `:119-143`) and models come from CacheStorage after the first load (`:73-109`), so the second and third tile's `init()` is fast and offline-capable.

### 2.2 Remote tiles: packets in, same chain out

A remote participant's `TilePipeline` is replaced by a packet consumer that produces the same `out.hands = { left: {img, world}, right: {img, world} }` shape (21 mirrored normalised image points + 21 raw metric world points = 42 x 3 floats = ~500 B as `Float32`, ~600 B with a header - the memo's number). Then steps 2-5 above run unchanged. Two rules: the packet must carry the SENDER's mirrored `img` and RAW `world` exactly as their `PlayerPipeline` emitted them (do not pre-flip anything - `HandViews` on the receiver measures chirality itself), and the receiver runs its own One-Euro only if the sender did not (the sender's pipeline already filtered; add `predMs` on the receiver for network jitter instead). The presence packet the frozen page already broadcasts (`mpbrowser.html:850`, `:3266`, `:4290`; `{v:1, kind:'presence', t, players:[{id, box, k:[[x,y,score] x17]}], balls:[...]}`) is the shape to extend with `kind:'hands'` and `kind:'ball'` rather than inventing a new envelope.

### 2.3 Solo testing of N tiles

`cloneStreamToTiles(stream, videoEls)` (`tile-pipeline.js:121-123`): one `getUserMedia`, `stream.clone()` per tile (a second `getUserMedia` fails on single-camera devices, `tracking.js:271-273`). Every tile shows the same person, so ids are trivially stable - it exercises layout, contexts, time budget, physics and the pass game, NOT id swaps. For genuinely different people per tile use `CompositeCam.useFile(url)` (`test-source.js:83-86`) with a recorded clip per tile.

## 3. Topology A - one camera, N people (`initMultiplayerTracking`, in the repo)

Use it inside ONE tile when that tile's camera sees several people (a meeting-room laptop). `sdk/core/multiplayer.js:37-59`:

```js
const { initMultiplayerTracking } = await import('./sdk/core/multiplayer.js');   // lazy: TF.js + MoveNet load on first use (mpgames.html:627-632)
const mt = await initMultiplayerTracking(videoEl, { maxPlayers: 4, prewarm: 2, poseEvery: 2, roundRobin: true, cropPx: 512, predMs: 0, budgetMs: 45 });
const f = mt.detect(now);   // { mode:'A'|'B', count, players:[{ id, bbox, body2D, wrists, hands:{left,right}, bodyImg, bodyWorld }] }
for (const p of f.players) { const slot = mpSlotFor(p.id); slot.packs = slot.views.resolve([p.hands.left, p.hands.right], camera); ... }
```

Why the ids are stable, and their limits:

- **Source of ids:** MoveNet MultiPose with `enableTracking: true` (`multipose.js:11`, `:73`) - TF.js's built-in cross-frame tracker; poses without an id are dropped (`:100`). MoveNet runs on an async background pump (`multiplayer.js:19-21`) so `detect()` stays synchronous and drops into a rAF loop.
- **Debounce:** `PlayerTracker` (`player-tracker.js:29-45`) makes a player "active" only after `joinFrames: 4` consecutive frames and drops a track after `leaveMs: 1500` of absence, so games do not flicker in and out; crop boxes are EMA-smoothed (`ema 0.3`, `resnap 0.15`) from BODY keypoints only, never from hand landmarks (header `:17-18` - that feedback loop amplifies wobble).
- **Mode A/B with hysteresis:** <= 2 players -> Mode B (3D body + 3D hands), > 2 -> Mode A (2D body, 3D hands) to shed the pose pass; switches need 500 ms / 1000 ms of stable count (`enterAms`, `enterBms`, `:41-42`). Pipelines are never torn down on a switch (`multiplayer.js:22-25`).
- **Mirror-at-emit:** crop boxes stay RAW for MediaPipe; `bbox`, `body2D`, `wrists` are emitted selfie-mirrored (`player-tracker.js:12-15`), consistent with `tracking.js`.
- **What id stability does NOT survive:** two people crossing/occluding can swap MoveNet ids (the tracker is a 2D keypoint tracker, no appearance model); people leaving for > 1.5 s come back as a NEW id. For a meeting demo this is acceptable (ids only matter for "whose hand holds the ball" for a second); for scoring, bind a name to an id on join (the presence packet's `tag` field) and re-bind when a new id appears where the old one vanished. The clone test cannot exercise this (`test-source.js:19-25`); only a two-person clip can.
- **Per-player downstream:** one `HandViews` + two `HandBody`s (`'left#'+id`) per player, allocated from a fixed slot pool (`mpgames.html:648-656` `forgeMpSlot`, 3 slots max); rigs per slot are optional (skeleton-only mode via `mt.setHandsEnabled(false)` supports up to 6 people, `multiplayer.js:109-123`).

## 4. Which to use where (the twin's tile grid)

| Tile | Video source | Tracker | Ids | Landmarkers on this machine |
|---|---|---|---|---|
| Me | local camera | `TilePipeline` (`withPose: true` if body collision wanted) | tile id | hands (+ pose) |
| Remote participant | Teams stream (never tracked) | packet consumer -> same chain | participant id from the relay | none |
| Shared room camera (2+ people) | local or remote | `initMultiplayerTracking` inside that tile; remote -> sender runs it and relays N `players` | `tileId + '#' + moveNetId` | hands x N (+ pose in Mode B) - only when local |
| Solo test x3 | `cloneStreamToTiles` | 3 x `TilePipeline` | tile id | 3 x hands |

The ball (`PropBall`) is in exactly one tile at a time; feed it that tile's packs (or every player's packs in a shared tile - extend the `[['left', pk.L], ['right', pk.R]]` loop in `prop-ball.js:update` to N hands; the wrap/clip/cradle gates are per hand and need no change). Cross-tile motion is the `onExit -> kind:'ball' packet -> reset at the mirrored edge` handover in `ball-extraction-plan.md` section 6.

## 5. Doctrine and chirality checklist for any multi-person path

- Never read `frame.handedness` / a MoveNet left/right label to pick a rig or a slot; `HandViews.resolve` decides per hand from measured volume, per player (`hand-views.js:8-31`). One `HandViews` PER PLAYER - the latches are per instance.
- Never hard-code a z sign for a remote participant's packets; their `world` points go through the receiver's `_zSign` latch like any other hand.
- Every hand from every player is a collider for the prop (`PropHull.pushOut` / `handResist`), and can pick it up only through the same wrap/clip/cradle gates; there is no "owner" that bypasses physics.
- Unique `HandBody.slot` strings per player (`'left#'+id`); reuse of a bare `'left'` across players is the aliasing bug `mpgames.html:652-655` fixed.
