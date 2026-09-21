# hopeOS drop-in modules for the Teams-twin sandbox

Repo: `C:/Users/hanna/iosandbox`, HEAD `6c8e6bc` (2026-09-16), branch `st-46-face-puppet-contract`. Read 2026-09-18 from the WORKING TREE. Every `sdk/**` and `tests/**` file cited below is byte-identical to HEAD (`git status`: only `sdk/world/editor.js`, `sdk/world/template.js`, `world.html`, `package.json`, `mpbrowser.html` are modified; none of those except `mpbrowser.html` is cited by line). `mpbrowser.html` carries uncommitted edits (`git diff --stat`: +171/-9; hunks start at wt lines 140, 246, 304, 2074, 2899, 2949, 3010, 3031, 5013, 5310, 5330, 5393, 6643, 6660, 6682, 6700, 6987). Consequence for the numbers below: **mpbrowser refs 304-2898 are HEAD+3, 2899-3030 are HEAD+6, 3031-5012 are HEAD+12, 5393-6642 are about HEAD+132, above 6643 about HEAD+150.** So the ball lane at wt `1570-1724` is HEAD `1567-1721`, the presence packet at wt `4290` is HEAD `4278` (the task brief's "~4278-4297"), `_palmPose` at wt `6233` is HEAD ~`6101`, `ENG_MINDS` at wt `6454` is HEAD ~`6322`. Always grep the quoted symbol before copying. Nothing in the repo was modified to produce these files.

## 0. Hard rules (restated, with the code that enforces them)

1. **FROZEN: `mpbrowser.html` and the avatar rig pipeline.** New features layer on top or copy code out into new modules; never edit them. Concretely for the sandbox: copy the GLASS ball lane (`mpbrowser.html:1570-1724`) plus its helpers (`:1380-1439`, `:2306-2341`, `:6233-6257`) into a new `sdk/game/prop-ball.js` (see `ball-extraction-plan.md`). Do not import from the page: it is not a module; it only exposes probe handles on `window.__lab` (`mpbrowser.html:4765-4780`) and `window.__eng`.
2. **PROP COLLISION DOCTRINE.** Collision is shape-vs-shape from the prop hull (`sdk/core/prop-hull.js:1-31` header, `PropHull.sphere` `:117`, `handGap` `:150-159`, `pushOut` `:163-172`) against the hand's 21 joint spheres (`JOINT_RADII`, `sdk/core/game-physics.js:38-45`). Pickup ONLY by finger wrap / clip (`_wrapGrab`, `mpbrowser.html:1411-1439`) or the measured holding-pose cradle (`_holdPose` `:1380-1402`, cradle logic `:1631-1652`). Open hand = release the same frame (`:1600-1607`: `_wrapGrab` re-tested every frame with a looser 0.03 skin; `!g` releases). Gravity always on (`:1675-1677`: `GrabbableSphere.update(dt, [], floorY)` with an EMPTY hand list). Hands support and never pass through (`:1678-1695` hull `pushOut` capped at 2 cm/frame, no bounce into the hand; `:1703-1713` `_handResist` moves the pack out of the hull). NEVER `GrabbableSphere` `jointsWithin`/pinch grab (`game-physics.js:298-314` is the forbidden path; the frozen `sandbox` ball still uses it at `mpbrowser.html:1255` via `ballColliders`, the doctrine lane sidesteps it by passing `[]` at `:1677`); never a gravity-off seek (the only seeks are z-only depth bias `:1653-1674` "z only, gravity untouched, never lifted" and x/z pocket attraction `:1641-1651` "gravity does the falling; it is never lifted").
3. **Chirality / z-sign is MEASURED.** `HandViews._zSign` (`sdk/core/hand-views.js:391-401`) is the authority for the world-landmark z convention (decay-latched palm-block volume, `a.sum * 0.98 + chirVol`); `_chirality` (`:179-186`) and `imageChirality` (`:167-170`) measure which mesh from the signed volume of the wrist / index-MCP / pinky-MCP / thumb-base tetrahedron (`:76-92`). MediaPipe handedness labels are emitted by `tracking.js:229-230` but nothing in the hand stack reads them (`hand-views.js:8-31`). `HandBody.palmOut` is likewise measured (`game-physics.js:116-134`), and so is `_holdPose`'s inner-palm normal (`mpbrowser.html:1390-1397`). Never hard-code a MediaPipe z sign; never key a mesh or a slot off `handedness`.

## 1. Import map and runtime dependencies

Every lab page carries this importmap verbatim (`handlab.html:65-70`, `mpbrowser.html:167-172`):

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
} }
</script>
```

- SDK modules import `'three'` and `'three/addons/loaders/GLTFLoader.js'` (`sdk/assets/loader.js:12-13`), so a page without this map cannot load any SDK module. Node smoke tests resolve the same specifier from `node_modules/three` 0.160.0 (`package.json` devDependency; `tests/hand-smoke.mjs:2`).
- CDN loaded lazily by the SDK itself: `@mediapipe/tasks-vision@0.10.18` ESM + WASM (`sdk/core/tracking.js:33-34`); `.task` models from `storage.googleapis.com/mediapipe-models/...` (`:35-44`), fetched with retry and cached in CacheStorage `hopeos-mediapipe-models-v1` (`:73-109`) so warm loads work offline; `three-mesh-bvh@0.7.8` (`sdk/interaction/colliders.js:19`, imported at module load by anything that imports `colliders.js`, which includes `hand-rig.js:31`); TF.js 4.22.0 + pose-detection 2.1.3 as UMD `<script>` globals for the multi-person stack (`sdk/core/multipose.js:27-28`, `:41-56`).
- Pages must be served over http: `getUserMedia` and ES modules both fail on `file://` (`tools/dev-server.mjs:6-10`). `npm run serve` = `node tools/dev-server.mjs` on `:3333` with an explicit MIME map and `cache-control: no-store` on code (`:22-29`, `:53-57`).
- `/api/*` (Claude and Whisper proxies) exist only under Vercel (`api/claude.js`, `api/openai.js`, `vercel.json`); the static dev server has no `/api` route except `POST /journal` (`tools/dev-server.mjs:37-44`).

## 2. Minimal holohands page recipe (distilled from `handlab.html:229-1087`)

Runnable copy: `minimal-holohands.html` in this folder, verified headless with Chrome's fake camera by `_probe-minimal.mjs` (screenshot `_probe-minimal.png`; see `test-conventions.md`). Order of operations, each line traced to handlab:

1. Renderer `{antialias, alpha:true}`, clear colour `0x000000,0`, `SRGBColorSpace`; `PerspectiveCamera(50, aspect, 0.01, 200)` at the origin with no rotation in mirror mode (`handlab.html:271-277`, `:443-445`).
2. `new HandFilterBank({minCutoff:1.4, beta:0.08})` for image landmarks, a second bank with `maxLead:0.05` for world landmarks (`:295-296`).
3. `new HandViews({mode:'mirror'})` (`:297`).
4. `new HoloHandRig(REST_R42, scene, {style:'smooth'}).build(style)` and the same with `REST_L42` (`:314-319`); handlab defers the forge 80 ms so the page paints first (`:320-325`); `setOccluder(isMirror)` (`:433-434`).
5. Cover-fit: `views.cfg.cover = {x:min(1,A/Av), y:min(1,Av/A)}` on `loadedmetadata` and resize (`:465-479`).
6. Boot on click: `await initCamera(bgVid, vid)`, `updateCover()`, `tracker = await initTracking(vid, {numHands:2, raw:true, enableFace:false, poseEvery:2})` (`:1058-1062`).
7. Loop (`:854-1051`): `tracker.detect()` (`:887`) -> sort hands by wrist x -> slot `'left'|'right'` (`:898-901`) -> `filters.apply(slot, img, now)` / `filtersW.apply` -> `predicted(slot, predMs)` (`:902-908`) -> drop after 400 ms (`:912-916`) -> `packs = views.resolve([left,right], camera)` (`:920`) -> `rig.tick(t); rig.pose(packs.R, cols)` (`:925-926`) -> `handBodies[slot].update(hand.points, dt, hand.img)` (`:988-992`) -> game objects -> `renderer.render` (`:1050`). `loop()` starts before the camera (`:1087`).

## 3. Module table

Each entry: import line, init signature, per-frame call, outputs, dependencies, gotchas. Paths are relative to the repo root; use `./sdk/...` from a root page, `../sdk/...` from a subfolder.

### 3.1 `sdk/core/tracking.js` - camera + MediaPipe (hands / pose / face)

- **Import:** `import { initCamera, initTracking, createHandLandmarker, createPoseLandmarker, createFaceLandmarker, getVision, getFileset, getModelBuffer, POSE_MODELS } from './sdk/core/tracking.js';`
- **Init:** `await initCamera(bgVideoEl, detectionVideoEl)` -> `{ stream, bgStream }` (`:274-292`): ONE `getUserMedia({video:{facingMode:'user', width:{ideal:1280}, height:{ideal:720}}})`, the background `<video>` gets `stream.clone()` (a second getUserMedia fails on single-camera devices). `await initTracking(videoEl, opts)` -> `{ detect, handLandmarker, poseLandmarker, faceLandmarker }` (`:175-269`). Opts (`:162-174`): `numHands` (2), `raw` (true = skip the legacy deadband stabiliser; use it when you One-Euro yourself), `enableHands/enablePose/enableFace` (false to skip), `poseEvery` (4; body-mesh consumers pass 2), `faceEvery` (3), `faceMatrix`, `poseModel` (`POSE_MODELS.lite|full|heavy`, `:39-43`), `handConfidence`, `trackingConfidence`.
- **Per frame:** `const frame = tracker.detect()` (sync; once per rAF, `:203-204`). Payload (`:205`): `{ hands, handsWorld, handedness, handCount, pose, poseWorld, face }`:
  - `hands[h]` = 21 `{x,y,z}` normalised, **selfie-mirrored** (`x = 1 - x`, `:222`), deadband-stabilised unless `raw` (`:223`).
  - `handsWorld[h]` = 21 raw MediaPipe metric world landmarks, **unmirrored** (`:224-227`).
  - `handedness[h]` = label flipped for selfie (`:229-230`); present, never used downstream.
  - `pose` = 33 `{x:1-x, y, z, v}` (v = visibility) on every `poseEvery`-th call, else `null` (`:234-241`); `poseWorld` = raw metric 33 (`:242-244`).
  - `face` = `{ landmarks(478), blendshapes: [{categoryName, score}]|null, matrix: Float32Array(16)|null }` every `faceEvery`-th call; face landmarks are RAW video coords, NOT mirrored (`:247-262`).
- **Dependencies:** none in-repo; CDN as in section 1.
- **Gotchas:** `detect()` returns the empty result until `videoEl.readyState >= 2` (`:206`) and when called twice within one `performance.now()` tick (`:208-210`). Pose/face are `null` on skipped frames: keep the last value yourself (`sdk/hopeos.js:288-291` does). The deadband stabiliser keys on hand INDEX, not slot (`:16-27`) - one more reason to pass `raw:true`. Each landmarker holds a WebGL context (`sdk/core/player-pipeline.js:66-69`); a 3-tile page with hand+pose per tile creates 6 contexts plus three.js.

### 3.2 `sdk/core/filters.js` - One-Euro banks

- **Import:** `import { HandFilterBank, OneEuro } from './sdk/core/filters.js';`
- **Init:** `new HandFilterBank({ count = 21, minCutoff = 1.4, beta = 0.08, dCutoff = 1.0, maxLead = 0.08 })` (`:64-74`). Pose banks: `{count:33, minCutoff:0.08, beta:30}` for image, `{count:33, minCutoff:0.1, beta:40, maxLead:0.05}` for world (`handlab.html:374-381`, the constants MediaPipe ships in `pose_landmark_filtering.pbtxt`).
- **Per frame:** `bank.apply(side, lm, tMs)` -> measured filtered array (`:109-122`); `bank.predicted(side, leadMs)` -> velocity-extrapolated array clamped to `maxLead`, for RENDERING only (`:128-141`; `leadMs <= 0` returns the measured array); `bank.drop(side)` on hand loss (`:100-103`); `bank.speed(side, idx)` (`:144-149`); `bank.setParams({minCutoff, beta})` live (`:77-86`).
- **Gotchas:** output arrays are REUSED every frame - read-only snapshots, never store across frames (`:58-63`). A gap > 250 ms reseeds (`:113`). Physics should consume `apply()` output, not `predicted()` (`:14-19`).

### 3.3 `sdk/core/hand-views.js` - the ONLY mirror/flip authority

- **Import:** `import { HandViews } from './sdk/core/hand-views.js';`
- **Init:** `new HandViews({ mode:'mirror'|'firstPerson'|'thirdPerson', avatar:{position:Vector3, yaw}, ...VIEW_DEFAULTS overrides })` (`:138-154`; defaults `:94-136`: `mirrorDist 2.0`, `mirrorDepth 1.0`, `cover {x:1,y:1}`, `yOffset 0`, `fp*`, `povHandScale 0.6`, `tp*`). `setMode(m)` (`:158`); `swapSlots` flag (`:153`, applied in `resolve` `:208`).
- **Per frame:** `views.resolve([handL, handR], camera)` where each entry is `{ img: 21 mirrored normalised, world: 21 raw metric | null }` or null (`:199-220`). Returns `{ R, L, hands:[{ mesh:'R'|'L', slot:'left'|'right', points, img }] }`: `R`/`L` are 21 preallocated `THREE.Vector3` WORLD-space packs keyed by MESH chirality (which `HoloHandRig` to drive), `slot` is the screen half (which `HandBody`). Buffers are reused (`:147`).
- **Also:** `views.mirrorPoint(p, camera, out)` projects ONE normalised landmark onto the pixel ray at `mirrorDist` with depth `p.z * sW * mirrorDepth` (`:241-255`) - reuse it for body landmarks and for anything "on the video"; `views.workspaceCenter(camera, out)` = where to spawn props (`:411-423`; mirror mode: `(0, 0, -mirrorDist)` in camera space); `views.dropSlot(slot)` resets the chirality and z-sign latches (`:404-407`).
- **Gotchas:** naming pitfall - `REST_R42` is stored in MIRROR space, so in mirror mode your physical right hand drives mesh `'R'`; in POV modes it drives `'L'` (`:19-25`, `:210`). Two hands measuring the same chirality borrow the other mesh (`:211`). One hand -> slot by which half of the screen the wrist is in (`:205-207`). Cover-fit must be updated from the real video size or every hand sits at a constant offset (`:98-103`).

### 3.4 `sdk/core/hand-rig.js` - HoloHandRig (the holohand)

- **Import:** `import { HoloHandRig, makeGhostMaterial, makeFleshMaterial, HAND_BONES } from './sdk/core/hand-rig.js';`
- **Init:** `new HoloHandRig(rest, scene, opts)` (`:158-205`) with `rest = REST_R42 | REST_L42` (only the first 21 rows are used, `:159`), opts `{ style:'smooth'|'slim'|'full'|'lowpoly', geometry, geometryFit, look:'ghost'|'flesh', alpha 0.46, body 0x6fb0dc, rim 0xaeeaff, skin 0xe0b69e }`. `rig.build(style)` forges the mesh in-browser via `forgeHand` (no GLB; `rig.stats = {verts, style, ms}`; 15065 verts for `smooth` in the probe run) and returns `this` (`:243-288`). `rig.setOccluder(true)` adds a depth-only twin at renderOrder -5 so REAL video fingers cover scene objects; mirror mode only (`:290-313`). `setGhost({alpha, body, rim})` (`:316-320`), `setLook('flesh'|'ghost')` (`:324-331`).
- **Per frame:** `rig.tick(elapsedSec)` (`:495`) then `rig.pose(pack21, cols)` (`:337-428`): `pack` = 21 `Vector3` or `{x,y,z}` world points, or null (-> hidden); returns `lm` or null. `cols` = array of collider objects the skin conforms to (`_conform`, `:430-493`): `{type:'sphere', center, radius, active}`, `{type:'box', center, quat, half, active}`, `{type:'mesh', mesh, bvh, boundCenter, boundRadius, _invMat, active}`.
- **Outputs:** `rig.mesh` (renderOrder 10, `:284`), `rig.grp`, `rig.tips[5]` fingertip world positions (`:203`, `:423-426`), `rig.uniforms.uGlow` contact heat (`:420`; games kick it for hit feedback, `handlab.html:997-1003`).
- **Dependencies:** `hand-forge.js` (`forgeHand`, `rigExternalGeometry`, `computeDetailAttribute`, `HAND_BONES`), `../interaction/colliders.js` (`getFaceNormal`, which pulls three-mesh-bvh from the CDN at import time).
- **Gotchas:** build once; a rebuild disposes the old geometry (`:244-254`). Bone frames come straight from the landmarks so the mesh is exactly on the tracked points - physics fed the SAME packs matches pixels (`handlab.html:355-356`). Conform epsilon is +3 mm off the collider shell (`:443-445`). Hand size is the max of three orthogonal spans, EMA'd (`:344-354`).

### 3.5 `sdk/core/hands.js` - rest skeletons (and the legacy rig)

- **Import:** `import { REST_R42, REST_L42 } from './sdk/core/hands.js';`
- `REST_R42` = 42 `[x,y,z]` rows (21 MediaPipe + 21 inner points, `:18-19`); `REST_L42 = REST_R42.map(p => [-x, y, z])` (`:20`). `buildFrame(lm)` (`:28-42`) is the palm-basis helper the page's `_palmPose` mirrors.
- `RiggedHand` (`:69` onward) is the OLD K-nearest deformer, used only by `sdk/hopeos.js`, which routes it by MediaPipe label (`hopeos.js:345`). Do not use it for the sandbox hands.

### 3.6 `sdk/assets/loader.js` - GLB loading

- **Import:** `import { loadModel, splitHandModel, loadHandPair } from './sdk/assets/loader.js';`
- `await loadModel(url, scene, { scale, collider:'sphere'|'mesh'|null, visible, doubleSided })` -> `{ group, mixer, anims, collider, rawScene, boundingSize, isPlaceholder? }` (`:46-105`): auto-centres and scales so the max dimension = `opts.scale`; a missing GLB resolves to a wireframe placeholder and never rejects (`:29-44`, `:100-103`). `collider:'sphere'` registers in the global registry (`:84-86`).
- `await splitHandModel('./sdk/assets/holo_hands_model.glb')` -> `{ right:{positions, normals, uvs, indices}, left }` split by x (`:153-213`); handlab wraps the halves into `BufferGeometry` and rigs them with `{ geometry, geometryFit:false }` (`handlab.html:330-344`, `:1095-1102`).
- GLB paths: `sdk/assets/holo_hands_model.glb` (default hands for `HopeOS.init`, `hopeos.js:139`), `sdk/assets/hands_flesh.glb` (PARKED: no hand-authored weights, `loader.js:124-131`), props `sdk/assets/props/` (`bow.glb`, `arrow.glb`), avatars `sdk/assets/avatars/`.
- **Gotcha:** for the sandbox prefer forged hands (`build('smooth')`): zero download, exact landmark fit.

### 3.7 `sdk/core/game-physics.js` - HandBody / BodyBody / integrators

- **Import:** `import { HandBody, BodyBody, GrabbableSphere, GrabbableBox, JOINT_RADII } from './sdk/core/game-physics.js';`
- **`HandBody(slot)`** (`:54-77`): `hb.update(points21World, dt, img)` each frame (`:86-177`); `hb.drop()` when absent (`:79`). Outputs: `joints[21]` Vector3, `vel[21]` m/s EMA, `radii[21]` = `JOINT_RADII * scale` (`:101-104`, `scale = span / (0.34 * 0.6)` clamped 0.2..4), `palm` (mean of wrist + 4 MCPs, `:107-108`), `palmQ` proper rotation (`:109-114`), `palmOut` MEASURED inner-palm normal, decay-latched (`:116-134`), `palmSign`, `palmVel`, `angVel` (`:136-158`), `speed`, `punchSpeed` (`:160-163`), `openness` 1 open .. 0 fist (`:165-169`), `pinch` 0..1 + `pinchPoint` (needs `img`, `:171-176`); `nearestSurface(p)` (`:180-187`); `snapshot(out)` plain numbers (`:197-216`). Allowed under the doctrine: all of it EXCEPT using `jointsWithin()` (`:190-194`) as a grab trigger.
- **`BodyBody(BODY_RADII)`** (`:951-1035`): `body.update(posedPoints37, dt)` with the SAME points `HoloBodyRig.pose` returns (`:990-1018`); exposes the HandBody interface (`joints/vel/radii/present`, `slot:'body'`, `palm` = chest `:1014`, `palmOut` up `:978`) plus 10 virtual in-between colliders so a ball cannot sail through a thigh or the belly (`VIRTUALS`, `:955-961`); never grabs (`openness` pinned 1, `pinch` 0, `:974-975`). This IS automatic body collision: put it in the same collider list as the hands (`handlab.html:407`, `mpbrowser.html:1122` `ballColliders = [handBodies.left, handBodies.right, bodyBody]`).
- **`GrabbableSphere(radius, {gravity -5.2, restitution 0.58, drag 0.996, home})`** (`:225-243`): `update(dt, hands, floorY)` (`:258-348`) = held-follow (`:261-294`) / grab check (`:297-314`, **doctrine-forbidden for props**) -> integrate gravity, drag, spin (`:316-326`) -> `_pushOut` vs every hand's joint spheres with impulse (`:328-332`, `:351-374`) -> floor bounce / roll (`:334-346`). Doctrine use: `sphere.update(dt, [], floorY)` with an EMPTY hand list, exactly as `mpbrowser.html:1677` does - gravity + drag + floor only, contact via `PropHull`. `reset(home)` (`:247-252`), `snapshot(out)` (`:378-386`).
- **`GrabbableBox`** (`:422-937`): the Rubik's-cube OBB body with an opposing-contact grip model, Gauss-Seidel push-out, corner tumble and `contain()` frame keeper (`:923-936`). Not needed for the ball; its open-palm-never-grabs / inner-hand-only rules (`:649-675`) are the spirit the ball lane copies.
- **Gotcha:** `HandBody.scale` uses `span / 0.204` (`:48`, `:103`); the page's `_packRadii` (`mpbrowser.html:2306-2311`) applies the same `palm/0.204` ruler to a raw pack. Use one or the other consistently.

### 3.8 `sdk/core/prop-hull.js` - PropHull (the doctrine's shape)

- **Import:** `import { PropHull } from './sdk/core/prop-hull.js';`
- **Build once:** `PropHull.sphere(r)` for a true sphere (`:115-117`; a capsule chain baked from a sphere mesh over-reaches), `PropHull.fromObject(object3D, {bins 14, pct 0.95, minR 0.004, maxSamples 6000})` for any GLB prop (`:94-110`; capsule chain along the extreme-vertex axis, `:47-92`), `toJSON()` / `PropHull.fromJSON(j)` (`:112-121`) to ship a hull with an asset.
- **Per frame:** `hull.begin(object3D)` poses every query through the live `matrixWorld`, scale included (`:123-133`); then `surfaceDistance(p)` signed (`:136-138`), `closest(p, outPoint, outNormal)` (`:141-146`), `handGap(joints, radii)` -> `{gap, joint}`, gap <= 0 is real touch (`:150-159`), `pushOut(joints, radii, outVec)` accumulates the min-translation out of penetrating joint spheres and returns the contact count (`:163-172`).
- **Gotcha:** call `begin()` again after moving the object within the frame (`mpbrowser.html:1693` re-begins after every push). Zero allocation in the hot path (`:35-37` module temps).

### 3.9 `sdk/interaction/colliders.js`, `grab.js`, `effects.js`

- `colliders.js`: global registry `colliders[]` (`:26`), `registerSphere(center, radius, active)` (`:39-46`), `registerMesh(mesh)` with BVH (`:49-66`), `registerMeshAsync` (`:69-72`), `awaitBVH()` (`:23`), `removeCollider` (`:33-36`), `deactivateAll()` (`:92-94`), `getFaceNormal` (`:75-89`). The objects it makes are exactly what `HoloHandRig.pose(lm, cols)` conforms to; the sandbox can hand-roll `{type:'sphere', center, radius, active}` objects like `handlab.html:348` instead of using the registry.
- `grab.js`: `isPinch` (`:17-23`), `pinchPoint` (`:26-32`), `palmCenter` (`:35-41`), `handQuaternion` (`:44-52`) are fine as measurements (they allocate); `GrabState` (`:78-146`) is a PROXIMITY grab (`countNearLandmarks`, `:55-62`) - doctrine-forbidden for props.
- `effects.js`: `new FireEffect(scene)`; `fire.active = true; fire.update(rightPack, leftPack, dt)` (`:102-120`) sizes a ray-marched flame to each hand's palm (`:122-137`). A ready-made effect for a voice command ("set my hands on fire").

### 3.10 `sdk/core/body-rig.js` (+ `body-forge.js`) - full body

- **Import:** `import { HoloBodyRig, BodyPose, BODY_RADII, REST_BODY, BODY_BONES, HIP_MID, CHEST, HEAD_C, HEAD_TOP } from './sdk/core/body-rig.js';` (re-exported from `body-forge.js` at `body-rig.js:40`).
- **Init:** `new HoloBodyRig(scene, { alpha 0.42, look:'ghost'|'shadow', back:false, core, aura, auraWidth }).build('standard'|'lite')` (`:189-237`, `:274-313`). Two rigs for both views: front bind for the mirror overlay, `back:true` for POV (`:176-188`; `handlab.html:1067-1070`).
- **Per frame (mirror overlay):** filter `frame.pose` with the 33-count banks, EMA the visibilities (`handlab.html:937-944`), project each point with `views.mirrorPoint(img[i], camera, bodyPts[i])`, `bodyPose.stabilizeMirror(bodyPts, poseVis, dt)` (`body-rig.js:781-814`), `bodyPosed = bodyRig.pose(bodyPts)` -> the posed 37-point array or null (`:413-491`; `extendPose` adds HIP_MID/CHEST/HEAD_C/HEAD_TOP `:415`) - `handlab.html:949-965`. **Per frame (POV):** `bodyPose.retarget(worldPose, imgPose, spawnVec3, yaw, poseVis, tSec)` -> 37 points (`:643-770`) -> `bodyRigB.pose(pts)` (`handlab.html:966-973`).
- **Outputs:** `rig.anchors {chest, hips, head}` (`:236`, `:486-488`), `bodyPose.airY` inferred jump height (`:575`, `:605-631`), `rig.stats`. Feed `bodyPosed` to `new BodyBody(BODY_RADII).update(bodyPosed, dt)` (`handlab.html:984`).
- **Gotchas:** `BODY_RADII` is a 37-entry Float32Array (`body-forge.js:106-123`); drop the pose banks + `bodyPose.drop()` after 900 ms without pose (`handlab.html:942-944`); `poseEvery:2` for a body mesh (`tracking.js:234`). The z-convention latch for the POV body is `BodyPose._zSign` (`:821-828`), decay-accumulated like the hands.

### 3.11 Multi-person: `multiplayer.js`, `player-pipeline.js`, `player-tracker.js`, `multipose.js`, `test-source.js`

See `multi-person.md` for the two topologies (one camera with N people vs N tile cameras). Summary of the contracts:

- **Import:** `import { initMultiplayerTracking } from './sdk/core/multiplayer.js';` (lazy-import it: TF.js loads on first use, `mpgames.html:627-632`).
- **Init:** `const mt = await initMultiplayerTracking(videoEl, { maxPlayers 4, prewarm 2, poseEvery 2, roundRobin true, cropPx 512, predMs 0, maxDim 256, moveNetFps 24, budgetMs 45, tracker:{...} })` (`:37-59`; tracker opts `player-tracker.js:29-45`).
- **Per frame:** `const mpF = mt.detect(now)` (sync) -> `{ mode:'A'|'B', count, players:[PlayerFrame] }` (`:96-199`). **PlayerFrame** (`:12-16`, `:179-182`): `{ id (stable MoveNet id), bbox (mirrored display box), body2D (17 COCO keypoints, mirrored), wrists:[screenLeft|null, screenRight|null], hands:{ left:{img, world}|null, right:{img, world}|null }, bodyImg (33, Mode B only), bodyWorld }`. Hands are ALREADY One-Euro filtered + predicted, in full-frame mirrored units (`player-pipeline.js:175`, `:203-208`) - feed them straight to `views.resolve([p.hands.left, p.hands.right], camera)` (`mpgames.html:1434`, `mpbrowser.html:3117`), never filter again.
- **Controls:** `setHandsEnabled(false)` skeleton-only for up to 6 people (`:109-123`, `:206`), `setForceMode('A'|'B')`, `pause()/resume()`, `stats()` `{moveNet, mediapipe, total, players, mode, poseEvery}` (`:80`, `:213`), `poses()`, `dispose()`.
- **`PlayerPipeline`** (`player-pipeline.js:29-288`) is the reusable per-video unit: `await new PlayerPipeline({withPose, eagerPose, cropPx, predMs}).init()` then `detect(video, box, size, tMs, {fullFrame:true, wantPose, poseEvery, frameCount, predMs})` -> `{hands:{left,right}, bodyImg, bodyWorld}` (`:97-248`); `predictOnly(tMs)` bridges skipped frames (`:261-272`); `drop()` (`:275-282`), `dispose()` (`:284-287`).
- **`CompositeCam`** (`test-source.js:52-114`): `new CompositeCam({count, overlap, width, height, fps})`, `useWebcam()` / `useStream(stream)` / `useFile(url)`, `attach(videoEl)`, `setCount(n)`, `setOverlap(x)`, `stop()`; tiles one source N times into a `captureStream` whose identity never changes (`:16-17`).

### 3.12 `sdk/core/scene.js` and `sdk/hopeos.js`

- `scene.js` is the module-singleton scene/camera used by the world pages: `initScene(canvas, {lights})` (`:56-75`, camera at `z = 2` with fov 50, `:11-19`), `mp2s(lm)` (`:35-41`), `render()` (`:78-80`). `handlab` / `mpbrowser` do NOT use it; they own their renderer. Either style works for the sandbox; the singleton is what `sdk/world/*` expects.
- `hopeos.js`: `HopeOS.init({canvas, bgVideo, detectionVideo, numHands, handModelUrl, voice, worldMode})` (`:109-187`) boots the OLD label-keyed `RiggedHand` hands (`:136-166`, `:341-351`), `BodyTracker`, Rapier `PhysicsWorld`, `FireEffect`, `VoiceCommander`; re-exports at `:359-377`. Use it for `world.html`-style pages and `WorldAgent`; do not use its hands for the doctrine sandbox.

### 3.13 `sdk/interaction/voice.js` - VoiceCommander

- **Import:** `import { VoiceCommander } from './sdk/interaction/voice.js';`
- **Init:** `new VoiceCommander('', { endpoint:'/api/openai', model:'gpt-4o-transcribe', lang:'en', interval:4000, onTranscript })` (`:15-24`); `vc.register(name, /regex/, cb)` (`:27-30`), `vc.unregister(name)` (`:33-35`); `await vc.start()` (mic `getUserMedia`, `:38-50`); `vc.stop()` (`:52`).
- **Loop:** `MediaRecorder` records `interval`-ms chunks (`:85-111`); blobs < 4000 bytes are skipped (`:98`); each chunk is POSTed as `application/octet-stream` with `x-audio-type`, `x-model`, `x-language` headers to `endpoint` (`:54-71`); the proxy rebuilds the multipart form and adds `OPENAI_API_KEY` server-side (`api/openai.js:19-47`). The lowercase transcript goes to `onTranscript` then to the first matching regex command (`:73-83`). `world.html:839-842` feeds the transcript straight into `agent.command(t)`.
- **Gotchas:** fixed 4 s chunking plus upload = roughly 4-6 s from speech to action; no VAD; `/api/openai` does not exist on `npm run serve`, only under `vercel dev` / deploy. `apiKey` is ignored (`:16`).

### 3.14 `sdk/world/ai-agent.js` - see `agent-tools.md`

`WorldAgent` is bound to a `WorldTemplate` (`_system` calls `this.world.getSceneState()`, `:253`; `_exec` dispatches ~40 world methods, `:286-431`) and reads a module-private `TOOLS` array inside `command()` (`:33-162`, used at `:461`). A new page cannot inject its own tool set without copying the 40-line loop (`:442-481`). The `/api/claude` proxy (`api/claude.js:8-34`) is reusable as-is.

## 4. Where the frozen page's reusable pieces live (copy targets)

| Piece | Working-tree lines in `mpbrowser.html` | Notes |
|---|---|---|
| Ball mesh shader (spin-visible bands, opaque, depthWrite) | `1206-1230` (`makeBallMesh`) | reusable verbatim; same code at `handlab.html:486-510` |
| `sandbox` (the FORBIDDEN pattern: `sphere.update(dt, ballColliders, ...)`) | `1233-1264` | do not copy the update; only `recenter()` / `floorY()` are useful |
| `slimeLab` state + `PropHull.sphere` + glass material | `1284-1325` | `hull = PropHull.sphere(SLIME_R)` at `:1303`; `makeGlass` from `sdk/core/glass.js:32` |
| `_holdPose`, `_wrapGrab` | `1380-1439` | cradle pose + wrap/clip gate (methods on `slimeLab`) |
| `_hands` adapter (pack -> `{joints, vel, radii, present}`) | `1481-1503` | the shape the slime sim wants; also a fine HandBody-lite |
| GLASS (rigid ball) doctrine lane | `1570-1724` | the lane to extract |
| `_packRadii`, `_hullTouch`, `_handResist` | `2303-2341` | mesh-true touch + hand-stop; uses module temps `_lbA`, `_lbB` (`:2272`) and `JOINT_RADII` |
| `_palmPose`, `_closure`, `_pinchR` | `6233-6257` | palm frame / closure / pinch measures; module temps `_gA.._gC`, `_gM` (`:6230-6232`) |
| Cube z-bias seek (every player's hands, mirror only) | `1918-1942` | the "prop meets the hand in depth" pattern; z only |
| Slot loop feeding `handBodies` + `slimeLab.update(dt, packs)` | `3401-3409` | order: HandBody update -> sandbox -> slime -> cube -> beat game |
| Presence packet (`BroadcastChannel('hopeos-room')`) | `850` (channel), `3263-3272` (MoveNet path), `4288-4310` (YOLO path) | `{v:1, kind:'presence', t, cut, cal, profile, players:[{tag,id,team,col,court,box:[x,y,w,h],k:[[x,y,score]x17]}], balls:[{x,y,r,court}], objects?, floor?}` - the existing cross-page contract; a tile-to-tile ball packet should extend this shape, not invent one |
| Clone test (`CompositeCam` off `camStreams.stream.clone()`) | `4538-4563` | how the page fakes N players from one webcam |
| Probe seam | `2077` (`AVSYNC`), `3022-3027` (`ovPacks` wins), `3095-3099` (`packsAligned`), `4765-4780` (`window.__lab`) | `window.__lab.AVSYNC.ovPose = null; ovPacks = {L, R}` overrides the hand packs the ball lane and rigs read (`tests/_glassprobe.mjs:74-76`) |
| NPC mind (rules-as-data) | `6454-6470` (`ENG_MINDS`), `6523-6580` (`engMindTick`) | `{role, reactions:[{on:'approach'|'touch'|'leave', within|beyond, play, move:{dir:'away'|'toward', speed, dur}, turn:'face'|'away', nod|lean, stats, cooldown}]}`; tick = sensors -> reaction stack -> settle; the shape for "make the butterfly look for my hand" (`turn:'face'`, `move:{dir:'toward'}`) |

## 5. Per-tile pipeline contract (what a sandbox builder implements)

One tile = one participant = one instance of this chain. All world-space, metres, y up, camera at the origin looking down -z in mirror mode.

```
video (tile)  --detect-->  { hands[img], handsWorld, pose?, poseWorld? }        tracking.js:205
   |  raw:true
   v
slot by wrist x ('left'|'right')  --One-Euro-->  { img: predicted(40ms), world }  filters.js:109,128
   v
views.resolve([L, R], camera)  -->  { R, L, hands:[{mesh, slot, points, img}] }  hand-views.js:199
   v                              \
rigR.pose(packs.R, cols)           handBodies[slot].update(points, dt, img)      hand-rig.js:337 / game-physics.js:86
rigL.pose(packs.L, cols)           bodyBody.update(bodyPosed, dt)               game-physics.js:990
   ^                                  |
   |  cols = [{type:'sphere', center:ball.pos, radius, active}]   (conform)
   |                                  v
   +---- ball.update(dt, packsBySlot, floorY)  (prop-ball.js: hull vs joint spheres, wrap/clip/cradle, gravity always)
```

Order matters and is fixed by the pages: physics reads the SAME packs the rigs render (`handlab.html:355-356`), the hand-stop mutates the packs in place BEFORE the rigs pose them if you want the stopped hand rendered (`mpbrowser.html:2318-2326` comment; the page runs `slimeLab.update` AFTER `rig.pose` at `:3103-3104` vs `:3408`, so the stop shows one frame late - acceptable), and the conform collider list is published after the ball moved (`:1715-1717`).

## 6. Built research modules (finisher pass 2026-09-18) - `sandbox-skeleton/`

The four modules this document proposes now exist as research copies under `research/codebase/sandbox-skeleton/sdk/game/` (junctions `sdk/core`, `sdk/interaction`, `node_modules` point into the repo so the relative imports are the same as after a builder copies `sdk/game/` into the repo). None of them modifies or imports the frozen page.

| File | Exports | Verified |
|---|---|---|
| `sdk/game/prop-ball.js` | `PropBall`, `palmPose`, `closure`, `pinchRatio`, `packRadii`, `hullTouch`, `handResist`, `makeBallMesh` | `tests/prop-ball-smoke.mjs` 23/23 (see `ball-extraction-plan.md` section 5) |
| `sdk/game/tile-pipeline.js` | `TilePipeline`, `cloneStreamToTiles` | static read only; browser probe planned (`test-conventions.md` 5.2) |
| `sdk/game/command-agent.js` | `CommandAgent` (injectable tools, `output_config.effort`, `is_error` results) | static read against the Claude API reference (`agent-tools.md` 4.1) |
| `sdk/game/sandbox-tools.js` | `SANDBOX_TOOLS` (8 strict tools), `makeSandboxExec`, `makeSandboxSystem` | static read (`agent-tools.md` 4.2) |
| `tools/sandbox-proxy.mjs` | dev proxy mounting `api/claude.js` + `api/openai.js` on :3334 | boots; routes verified without keys (`agent-tools.md` 5) |
