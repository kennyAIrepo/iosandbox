# CONTRACTS — every file, its exported API, the per-frame flow, packets and doctrine assertions

Builders code against this file without reading the designs. `R` = `C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/31746f0b-c4ab-4b4f-9c24-629c6e7b40fd/scratchpad/research`,
`REPO` = `C:/Users/hanna/iosandbox`. All new files live under `REPO/`. Signatures below for COPIED modules were verified
against the research files on 2026-09-19 (line numbers cited); signatures for NEW modules are the contract.

## 0. Conventions every module obeys

- ES modules, vanilla, no bundler. three.js 0.160.0 via the page importmap (`import * as THREE from 'three'`); Node tests
  import `three` from `REPO/node_modules` (present). Copied `.mjs` research files become `.js` under `sdk/`; tests stay `.mjs`.
- Relative imports inside `sdk/game` and `sdk/net`: `../core/<x>.js` for the frozen SDK, `./<x>.js` for siblings,
  `../net/<x>.js` / `../game/<x>.js` across the two folders. Never import `mpbrowser.html` or anything under `avatar`.
- Units: metres, y up, camera looks down -z. Hand plane of every tile is `z = -D` in that tile's camera space; `D = 2.0`
  (`HandViews.cfg.mirrorDist`), `FOV = 50`, `U = 2*D*tan(FOV/2) = 1.8652 m` = one court unit = one tile height.
  World = stage space: camera `i` sits at `((cx_i - stageW/2)/th*U, (stageH/2 - cy_i)/th*U, 0)` looking -z, where
  `(cx_i, cy_i)` is tile i's centre in stage px and `th` the tile height in px. Court units convert to metres by `*U`.
- Time: `clock.now()` (SharedClock, u32 session ms) on every packet; `clock.local()` (= `performance.now()`) for local
  timers; `Date.now()` never inside `sdk/net`. `ageMs = dt32(clock.now(), pkt.t)`.
- Chirality [C1]: hand arrays are never flipped, relabelled or re-filtered outside `sdk/core/hand-views.js`; every tile
  (local or remote) owns a `HandViews({mode:'mirror'})` that MEASURES chirality on its own copy of the data.
- `S.ovPacks[clientId] = {L, R}` (21-point `{x,y,z}` arrays in that tile's world space, or null) replaces the tile's
  packs BEFORE rigs and physics read them, so probes and the keyboard hand exercise exactly the production chain.
- Every Node smoke test: `ok(cond, label)` counter, prints `N passed, M failed`, `process.exit(failed ? 1 : 0)`.
- Every browser probe (puppeteer-core, `C:/Program Files/Google/Chrome/Application/chrome.exe`,
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --use-gl=angle --no-sandbox`,
  `npm run serve` on :3333) waits on `window.__twin.ready`, reads numbers from `window.__twin`, filters console errors
  `/favicon|XNNPACK|404/`, writes screenshots to the scratchpad `SHOT_DIR`, never asserts on pixels alone.

## 1. Copy table (T0) — source -> destination, permitted edits

| destination | source (verbatim unless noted) | permitted edit |
|---|---|---|
| `sdk/ui/teams-tokens.css` | `R/ui/teams-tokens.css` | none (regenerate via `tools/gen-teams-tokens.mjs`) |
| `tools/gen-teams-tokens.mjs` | `R/ui/scripts/gen-tokens.mjs` | output path only |
| `sdk/game/prop-ball.js` | `R/codebase/sandbox-skeleton/sdk/game/prop-ball.js` (413 lines) | none in T0. T10 (body) may add `extraBodies` (§3.11) and must re-run 23/23 + 1 |
| `sdk/game/tile-pipeline.js` | `R/codebase/sandbox-skeleton/sdk/game/tile-pipeline.js` (125 lines) | EXACTLY two lines: in `detect()` after the `pipe.detect` call add `this.hands = out.hands;` and in `_drop()` add `this.hands = { left: null, right: null };` (the encoder needs the raw `{left:{img,world}, right:{img,world}}`); initialise `this.hands = { left:null, right:null }` in the constructor |
| `sdk/game/court-map.js` | `R/game/examples/court-map.mjs` (245 lines) | none |
| `sdk/game/ball-net.js` | `R/gaps/wire-protocol/ball-net.mjs` (477 lines, the PATCHED copy) | add `PRESENCE: 0x21` to the `PK` table (line 28-32); fix `./court-map.mjs` import to `./court-map.js` |
| `sdk/game/court-bridge.js` | `R/gaps/wire-protocol/court-bridge.mjs` (108 lines) | add option `mirroredInput` (default `true`, so wire-smoke (vii) still passes) threaded to `tileToCourt(seat,u,v,mirroredInput)`; signature §3.4 |
| `sdk/game/throw-detect.js` | `R/game/examples/throw-detect.mjs` (130 lines) | none |
| `sdk/game/latency-cues.js` | `R/game/examples/latency-cues.mjs` (130 lines) | T4 appends `ArrivalPredictor` and `MissCue` (§3.7); nothing existing changes |
| `sdk/game/command-agent.js`, `sdk/game/tools.json`, `sdk/game/system-prompt.md`, `sdk/game/push-to-talk.js` | `R/command-agent/{command-agent.js,tools.json,system-prompt.md,push-to-talk.js}` | none (`DEFAULT_SYSTEM` must stay byte-identical to the .md; the 114 test asserts it) |
| `sdk/net/hand-stream.js` | `R/gaps/wire-protocol/hand-stream.mjs` (205 lines) | import path of `ball-net` -> `../game/ball-net.js` |
| `sdk/net/remote-consumer.js` | `R/gaps/wire-protocol/remote-consumer.mjs` (162 lines) | import paths |
| `sdk/net/transports.js` | `R/gaps/wire-protocol/transports.mjs` (240 lines, patched: `hopeos-room` envelope, bundled Live Share) | import paths; append `gated()` (§4.4) |
| `tools/relay-server.mjs` | `R/game/examples/relay-server.mjs` | none; add `"ws": "^8.21.0"` to `package.json` devDependencies (already in `node_modules` transitively) |
| `tools/sandbox-proxy.mjs` | `R/codebase/sandbox-skeleton/tools/sandbox-proxy.mjs` | mount paths `REPO/api/claude.js`, `REPO/api/openai.js`; CORS for `http://localhost:3333` |
| `tests/prop-ball-smoke.mjs` | `R/codebase/sandbox-skeleton/tests/prop-ball-smoke.mjs` (23 checks) | import path `../sdk/game/prop-ball.js` |
| `tests/wire-smoke.mjs` | `R/gaps/wire-protocol/wire-smoke.mjs` (7 sections) | import paths; section (vii) runs twice: `mirroredInput:true` (research expectation: world +x exit -> `EDGE.L`) and `mirroredInput:false` (twin: -> `EDGE.R`) |
| `tests/ballnet-smoke.mjs` | `R/game/examples/smoke-test.mjs` (7 sections) | import paths |
| `tests/command-agent-smoke.mjs` | `R/command-agent/test-mock.mjs` (114 checks) | import paths |
| `docs/teams/*` (T8) | the research files linked from SPEC §8 | none (copies for the API tab links) |

`package.json` scripts added: `"relay": "node tools/relay-server.mjs 8787"`, `"proxy": "node tools/sandbox-proxy.mjs 3334"`,
`"test:twin": "node tests/prop-ball-smoke.mjs && node tests/wire-smoke.mjs && node tests/ballnet-smoke.mjs && node tests/command-agent-smoke.mjs && node tests/court-space-smoke.mjs && node tests/pack-gen-smoke.mjs && node tests/ball-game-smoke.mjs && node tests/scene-executor-smoke.mjs && node tests/bot-pass-smoke.mjs && node tests/twin-ui-smoke.mjs"`,
`"probe:twin": "node tests/_twinprobe.mjs"`, `"probe:twinpass": "node tests/_twinpass-probe.mjs"`. Existing scripts untouched.

## 2. Verified APIs of the copied modules (what the new code may call)

- `PropBall` (`prop-ball.js:135-413`): `new PropBall(scene|null, { radius=0.16, gravity=-4.2, restitution=0.42, mesh?, home?:Vector3 (default (0,0,-2)), floorY? (default home.y-1.05), boundsR=3.4, spawnOffset?:Vector3 (default (-0.35,0.1,0)), onExit?(info), onGrab?(slot,type), onRelease?(velVector3) })`;
  `setHome(center:Vector3, floorY?)`, `recenter()`, `setScale(sc)` (0.4..3), getters `pos/vel/quat`, `hold` (`{slot,type:'wrap'|'clip',posOff,quatOff}`|null),
  `cradle` (slot|null), `seek` ('z'|null), `collider` (`{type:'sphere',center,radius,active}`), `sphere` (GrabbableSphere: `pos, vel, angVel, quat, reset(home?)`),
  `update(dt, pk, hb=null) -> {collider, hold, cradle, seek}` where `pk = {L, R}` (21 `{x,y,z}` each or null) and `hb = {left:HandBody, right:HandBody}` (two-hand pinch scale only),
  `snapshot(out) -> {x,y,z,vx,vy,vz,held,holdType,cradle,seek,scale,...}`, `dispose()`. Also exported: `palmPose(pack, outP:Vector3, outQ:Quaternion)`, `closure(pack)`, `pinchRatio(pack)`, `packRadii(pack)`, `hullTouch`, `handResist`, `makeBallMesh(r)`.
  `_holdPose(slot, pack, R)` (private, but its maths is the pocket definition: `pocket = palmCentre + n*(R+0.04)`, `n` = measured inner normal, `pose = n.y>0.4 && 0.02<closure<0.8`).
- `TilePipeline` (`tile-pipeline.js:27-118`): `new TilePipeline(id, video, { scene, camera, withPose=false, predMs=40, style='smooth', occluder=true, cover })`, `await init()`, `setCover(boxW, boxH)`,
  `detect(now, dt, cols=null) -> { packs:{R,L,hands:[{mesh,slot,points,img}]}, handL, handR, body }` (+ `this.hands` after the T0 edit), `dispose()`; fields `views` (HandViews), `rigR/rigL` (HoloHandRig|null), `handL/handR` (HandBody), `ready`. `cloneStreamToTiles(stream, videoEls) -> streams[]`.
- `CourtMap` (`court-map.js:84-245`): `EDGE {L:0,R:1,T:2,B:3,NONE:255}`, `SEAT_NONE 0xff`, `DEFAULT_GUTTER 0.08`, `COURT_GRAVITY 5.2`, `COURT_DRAG 0.996`, `FLOOR_RESTITUTION 0.58`, `FLOOR_BOUNCE_MIN_VY 0.35`, `FLOOR_FRICTION 0.92`,
  `integrateCourt(b, dt, floorY?, R=0)`, `buildSeatMap(roster, {cols=3, gutter, wrap='row', outer='wall', goal=-1, kickoff=0, v=1})`,
  `new CourtMap(seatMap)`, `set(map)`, `rects[]`, `R` (0.45 x median tracked handSpan, else 0.07), `rectOf(seat)`, `seatOfClient(id)`, `role(seat)`, `isTracked(seat)`,
  `tileToCourt(seat,u,v,mirrored=false,out)`, `courtToTile(seat,x,y,mirrored=false,out)`, `worldToTile(p, camera, out) -> {u,v}` (uses `camera.matrixWorldInverse` + `projectionMatrix`), `tileToWorld(u,v,depth,camera,out)`, `worldRadiusFor(camera, depth)`,
  `exitEdge(seat,x,y,R) -> EDGE` (L/R/T only), `floorY(seat)`, `neighbourAt(seat, edge, c) -> {seat|-1, wrapDx}` (ring wrap when `wrap==='row'`), `seatAt(x,y,margin)`, `predictExit(seat,x,y,vx,vy,t0ms,R,maxMs=4000) -> {edge,cEdge,tEdge,to,wrapDx}|null`, `courtToViewerPx(x,y,domRects,out) -> {px,py,pr,seat}`.
- `BallNet` (`ball-net.js:241-477`): `new BallNet({ transport, clock, court, seat, clientId, isHost=false, rateHz=20, hooks })`; hooks `onBecameOwner(claim)`, `onLostOwner()`, `onOwnerChanged(claim)`, `onRemoteState(state)`, `onLaunchSeen(launch, mine)`, `onWall(edge, ball)`, `onGoal(goal)`, `onSeatMap(map)`, `onRespawnLocal(ball)`;
  `tickOwner(ball)` with `ball = {x,y,d,vx,vy,vd,wx,wy,wz,radius,hold?:{mode,slot,ox,oy,oz,qx,qy,qz,qw},atRest,onFloor,reason?}` (court units); `tick()`; `respawn(ball)`; `kickoff(ball) -> bool` (host only); `declareGoal(scorerSeat, goalNo) -> bool`; `publishSeatMap(map)` (host; sets `court` too); `ping()`;
  fields `owner, ownerSimSeat, ownerSeq, inTransit, lastLaunch (with tEdgeEff), ghost, lastRemote, stats {launches, claims, conflicts, earlyStates, timeouts, recoveries, stretches, stretchMsLast, oneWayMs, packetAgeMs}`, getters `isOwner`, `simSeat`, `getStats()`. `seat` is re-read from the seat map on every SEAT_MAP.
  Also exported: `PK, HOLD {FREE,CRADLE,WRAP,CLIP}, REASON {THROW,ROLL,BAT,RESPAWN,PORTAL}, CLAIM_REASON, FLAG {FROM_HOST:1, PROXY:2}, TUNING {MIN_LEAD_MS 80, HANDOFF_TIMEOUT_MS 250, OWNER_SILENCE_MS 1000, REST_TO_GUTTER_MS 8000, RESPAWN_TRANSIT_MS 600, LAUNCH_REPEATS 3}, PROTO_VER, writeHeader(view,type,seq,t,flags), readHeader(buf) -> {type,flags,ver,seq,t}, seqNewer16/8, dt32, encode/decode BallState|Launch|Claim|Ack|Goal|SeatMap|ClockPing|ClockPong, SharedClock`.
  `SharedClock({samples=8, localNow})`: `local()`, `now()`, `sample(t0,t1,t2,t3)`, `adoptGlobal(ms)`, fields `offset, rtt, samples[]`.
- `court-bridge.js`: `worldToCourt(court, seat, camera, p, out)`, `toCourtBall(court, seat, camera, prop, hold=null, out)` (`prop = {pos, vel, angVel?, atRest?, onFloor?, reason?}`; velocity by finite difference so its sign inherits the position flip),
  `onPropExit(net, court, camera, info, hold=null) -> {edge, courtBall, neighbour}`, `holdFromProp(hold, ballPos, ballQ, palmP, palmQ, span) -> HOLD_OFFSET block`, `ballFromHold(hold, palmP, palmQ, span, outPos, outQ)`.
- `throw-detect.js`: `THROW {V_DROP 0.25, V_MAX_OUT 3.0, V_MAX_IN 2.0, DIR_COHERENCE, PALM_COHERENCE, SPIN_SCALE 0.85, LOB_VD}`, `PALM_JOINTS`, `ThrowDetector` (only the statics are used): `ThrowDetector.shapeEntry(vx, vy, cap=2.0) -> {vx,vy}`, `catchWindowMs(v, w)`, `predictPath(...)`, `rollLaunch(...)`.
- `latency-cues.js`: `boundaryStretch(tEdge, nowSession, minLeadMs=80)`, `gutterTimeScale(stretchedMs)`, `EntryBlend({capUnitsPerS=2.0, tauMs=100})` `.start(vx,vy,nowMs)` `.factor(vx,vy,nowMs)`, `GhostBall(scene, radiusWorld, color)` `.start(launch, sessionNow, toWorld, floorY, R)` `.update()` `.promote()` `.cancel()`,
  `ArrivalRing(ctx2d, courtToPx)` `.show({rect, edge, cEdge, tEdgeEff, color, leadMs=400})` `.draw(sessionNow)` `.clear()`, `AudioCues` (superseded by `sfx.js`), `handAgeAlpha(ageMs)`, `panForTile(domRect, galleryWidthPx)`.
- `hand-stream.js`: `HS {PRESENT_L 1, PRESENT_R 2, WORLD_L 4, WORLD_R 8, POSE33 16}`, `HS_HEADER_BYTES 12`, `HS_MAX_BYTES 516`, `SLOTS ['left','right']`, `handStreamBytes(hands)`, `encodeHandStream(seat, hands, seq, tMs, {hold=null, flags=0}) -> ArrayBuffer` (`hands = {left:{img,world?}, right:{...}}`, img = 21 `{x,y,z}` normalized mirrored-display units, world = 21 `{x,y,z}` metres),
  `decodeHandStream(buf, {out}) -> {seat, seq, t, hflags, hold, hands:{left,right}}`, `ROOM_CHANNEL 'hopeos-room'`, `wrapRoom(from, bytes, reliable)`, `unwrapRoom(data, myId)`, `bytesToB64/b64ToBytes`, `selfCheck()`; re-exports `PK, FLAG, PROTO_VER, readHeader, seqNewer16, dt32`.
- `remote-consumer.js`: `REMOTE {HOLD_MS, MAX_PRED_MS, MAX_STEP_MS, ...}`, `handAgeAlpha`, `RemoteSeat`, `RemoteHands({alpha=handAgeAlpha, predMs=0, localNow})`: `onMessage(buf) -> bool` (true when it was a HAND_STREAM), `push`, `read(seat, nowMs, {predMs}) -> {hands:{left,right}, ageMs, sinceArrivalMs, seq, t, alpha, present:{left,right}, hold, extrapolatedMs, seat}`, `slotsToDrop(seat, nowMs) -> slot[]`, `seat(seat).stats`, `list()`, `forget(seat)`.
- `transports.js`: interface `{ id, send(bytes, {reliable}), onMessage(cb), close() }`. `MemHub({now, rng})` `.link(a,b,{latencyMs,jitterMs,lossPct})` `.join(id) -> MemTransport` `.flush()`; `LoopbackTransport({channel=ROOM_CHANNEL, id, latencyMs=0, jitterMs=0, lossPct=0})` (BroadcastChannel, own echo dropped, `stats.sent`); `WsRelayTransport(url)` (`id` set by the server hello, `ready` promise resolves with `{clientId, room, peers, serverNow}`, `onControl(m)` receives `{joined}`/`{left}`); `RtcTransport`, `LiveShareTransport` (seams, not instantiated).
- `command-agent.js`: `MODEL 'claude-opus-5'`, `DEFAULT_ENDPOINT '/api/claude'`, `CATALOG`, `DEFAULT_SYSTEM`, `loadTools(url) -> {tools, catalog}` shape as in the file, `loadSystemPrompt(url)`, `stripComments`, `AgentError`, `CommandAgent({endpoint, tools, executor, catalog, system, model, mode='auto', maxRounds=3, maxTokens=1500, historyTurns=3, cache=true, timeoutMs=20000, speaker, fetchImpl})`,
  `.command(text, {speaker}) -> {status, actions, say, ms, usage, source}`, `.on('say'|'action'|'status'|'raw', fn)`, `.describe()`, `.parseLocal(raw)`, `.lastTarget`, `.busy`; `summarize(actions)`. The executor is called as `executor(name, input)` and for the snapshot as `executor('list_scene', {})` expecting `{objects:[{id,kind,held_by,behavior}], participants:[{id,name,tile,hands,goal}], speaker}`.
- `push-to-talk.js`: `PushToTalk({endpoint='/api/openai', model='gpt-4o-transcribe', onTranscript, onState})` `.start()` `.stop()` `.bindKey(key)` `.bindButton(el)` `.dispose()`.
- Frozen SDK used unchanged: `HandViews({mode:'mirror'})` (`resolve(handsArr, camera) -> {R, L, hands:[{mesh,slot,points,img}]}`, `dropSlot(slot)`, `workspaceCenter(camera, out)`, `cfg.cover`, `mirrorPoint`), `HoloHandRig(REST, scene, {style})` (`.build()`, `.tick(tSec)`, `.pose(pack|null, cols)`, `.setOccluder(on)`, `.grp` Group holding mesh + occluder, `.mesh`, `.dispose()`), `HandBody(slot)` (`.update(points, dt, img)`, `.drop()`, `.present`, `.openness`, `.pinch`, `.pinchPoint`, `.palmOut`), `PropHull` (`sphere(r)`, `fromObject`, `begin(obj)`, `pushOut(joints, radii, out)`), `BodyBody(BODY_RADII)`, `REST_R42/REST_L42` from `sdk/core/hands.js`, `initCamera`, `CompositeCam` from `sdk/core/tracking.js` / `test-source.js` (see `R/codebase/dropins.md` §3.1, §3.11), `FireEffect` from `sdk/interaction/effects.js`.

## 3. New modules under `sdk/game/`

### 3.1 `sdk/game/court-space.js` (T0; pure math, Node-safe, no DOM, no three import — duck-typed vectors)

```js
export const D = 2.0, FOV = 50, U = 2 * D * Math.tan(FOV / 2 * Math.PI / 180);   // 1.8652...
export const DISPLAY_MIRRORED = true;            // D-A: tiles displayed in self-view space, court defined there
export const MIRRORED_INPUT = !DISPLAY_MIRRORED; // what court-bridge receives (false in the twin)
export function stagePxFromWorld(p, stageW, stageH, th, out={}) -> {px, py}     // px = stageW/2 + p.x/U*th ; py = stageH/2 - p.y/U*th
export function worldFromStagePx(px, py, stageW, stageH, th, out={}) -> {x, y, z:-D}
export function courtToStagePx(court, x, y, domRects, out={}) -> {px, py, pr, seat}   // = court.courtToViewerPx with domRects relative to the stage element
export function courtToWorld(court, x, y, domRects, stageW, stageH, th, out={}) -> {x, y, z:-D}   // courtToStagePx -> worldFromStagePx
export function courtRadiusWorld(court) -> number                                // court.R * U
export function worldToCourt(court, seat, uvCam, p, out={}) -> {x, y}            // court.worldToTile(p, uvCam) -> court.tileToCourt(seat, u, v, MIRRORED_INPUT, out)
export function tileWorldRect(court, seat, domRects, stageW, stageH, th) -> {x0, y0, x1, y1, floorY}   // world metres, hand plane
export function unmirrorHands(hands, out={}) -> hands'                          // u -> 1-u on img, x -> -x on world; UNUSED by default (C2 seam)
export function makeUvCamera(THREE, aspect, position) -> PerspectiveCamera        // FOV, aspect, near .01, far 50, NO view offset; call updateProjectionMatrix + updateMatrixWorld
```
Derived from `R/gaps/render-budget/decision.md` §2, `R/game/space-mapping.md` §4/§8. `makeUvCamera` takes `THREE` as a
parameter so the module stays import-free for Node (tests pass a duck-typed camera with `matrixWorldInverse.elements`
and `projectionMatrix.elements`).

### 3.2 `sdk/game/pack-gen.js` (T0; Node + browser, plain `{x,y,z}` objects)

```js
export const PackGen = {
  open(x, y, z) -> pack21,            // closure ~0, fingers extended in the screen plane   (tests/_glassprobe.mjs:36-42 verbatim)
  cup(x, y, z) -> pack21,             // fingers curling to wrap (closure ~0.5)              (:43-49)
  flat(x, y, z, k=2.2) -> pack21,     // palm-up shelf in the x/z plane                      (:50-58)
  shift(pack, dx, dy, dz) -> pack21,  // translated copy
  lerp(a, b, t) -> pack21,
  throwSeq(from:{x,y,z}, dir:{x,y,z}, speedMps, frames, dt) -> pack21[]   // cup packs moving at speed, last one `open`
};
export function packToHands(pack, camera, {slot='right'}) -> {left|right: {img, world}}   // inverse of HandViews.mirrorPoint at depth D for the bot encoder (u = 0.5 + x_cam/(sW), v = 0.5 - y_cam/sH, z 0; world = pack)
export function writeFixtures(path)   // tests/fixtures/hand-packs.json {open, cup, flat, wave:[...], throwRight:[...]}
```

### 3.3 `sdk/game/stage-renderer.js` (T2; browser)

```js
export class StageRenderer {
  constructor(canvas, { fov = FOV, d = D, gap = 8, maxDpr = 1.5 })   // WebGLRenderer {antialias, alpha:true}, setClearColor(0,0), autoClear=false, info.autoReset=false, setScissorTest(true), outputColorSpace sRGB
  scene: THREE.Scene   // hemisphere + directional light on layer 0
  resize(stageW, stageH, th, tw)                                       // setSize, pixel ratio min(dpr, maxDpr)
  tileCamera(i, rect:{left, top, width, height}) -> { cam, uvCam, vp:{x,y,w,h}, layer: 1 + i }
      // cam at ((cx - stageW/2)/th*U, (stageH/2 - cy)/th*U, 0); setViewOffset(tw, th, -gap/2, -gap/2, tw+gap, th+gap); cam.layers.enable(1+i)
      // uvCam = makeUvCamera(THREE, tw/th, cam.position) — same fov/aspect/position, no view offset (for CourtMap.worldToTile)
      // vp = {x: left-gap/2, y: stageH-(top-gap/2)-(th+gap), w: tw+gap, h: th+gap}  (GL y from the bottom)
  releaseTile(i)
  assignLayer(rig, layer)          // rig.grp.traverse(o => o.layers.set(layer))  — mesh AND occluder twin (judge fix)
  setRigAlpha(rig, alpha)          // rig.mesh.material.opacity = alpha (transparent:true); occluder untouched
  ballMaterial() -> MeshMatcapMaterial   // the radial-gradient matcap from render-budget.html:187-193 (same disc from every eye)
  render(tiles)                    // full-stage scissor+viewport clear, then per tile setViewport/setScissor(vp) + render(scene, cam)
  contexts() -> number             // live WebGL contexts (renderer + registered landmarkers via registerContext())
  registerContext(n = 1)
  onContextLost(cb)                // webglcontextlost -> preventDefault, dispose, rebuild renderer, cb()
  info() -> { calls, triangles }
  dispose()
}
```
Derived from `R/gaps/render-budget/render-budget.html:185-213, 290-297, 415-425` and `decision.md` §1-§4. Layer rule:
rigs of tile i on layer `1+i` (`assignLayer`), ball / ghost / props / lights on layer 0 (every camera sees layer 0).
Every mesh drawn on the surface must have `frustumCulled = false` (HoloHandRig already does; set it on the ball).

### 3.4 `sdk/game/court-bridge.js` — the one edit

`toCourtBall(court, seat, camera, prop, hold=null, out={}, { mirroredInput = true } = {})`,
`worldToCourt(court, seat, camera, p, out={}, mirroredInput = true)`,
`onPropExit(net, court, camera, info, hold=null, { mirroredInput = true } = {})`. The twin always passes
`{ mirroredInput: MIRRORED_INPUT }` from `court-space.js`. Nothing else in the file changes.

### 3.5 `sdk/game/remote-tile.js` (T2; browser)

```js
export class RemoteTile {
  constructor(id, { scene, camera, style = 'smooth', occluder = true, cover })   // own HandViews({mode:'mirror'}), rigR/rigL (HoloHandRig, built, occluder on), HandBody('left#'+id / 'right#'+id)
  feed(rd, now, dt, cols = null) -> { packs, handL, handR }    // rd = RemoteHands.read(seat, clock.now()); for slot of slotsToDrop -> views.dropSlot(slot);
                                                              // packs = views.resolve([rd.hands.left, rd.hands.right], camera); rigs .tick/.pose(packs.X, cols); HandBody.update per slot  [C1]
  setSlotsToDrop(slots)                                       // called by the page before feed()
  setAlpha(a)                                                 // stage.setRigAlpha on both rigs (1 -> 0.5 between 150 and 400 ms via handAgeAlpha)
  setCover(boxW, boxH)                                        // cover-fit for the avatar box (same maths as TilePipeline.setCover with aspect 16/9)
  packs, hands (last rd.hands), handL, handR, rigR, rigL, views
  dispose()
}
```
Derived from `R/gaps/wire-protocol/hopeos-wire.md` §7 (the receiver chain, line for line) and `tile-pipeline.js:86-97`.
Never edits `tile-pipeline.js`; the receiver MEASURES chirality with its own `HandViews`.

### 3.6 `sdk/game/hand-sources.js` (T2; browser)

```js
export class LocalCameraSource { constructor({ width=1280, height=720 }); async start() -> { video, stream }; stop(); kind='local'; video; stream }   // ONE getUserMedia via sdk/core/tracking.js initCamera (dropins §3.1)
export class CloneSource      { constructor(stream); async start() -> { video, stream }; kind='clone' }            // stream.clone() (tile-pipeline.js cloneStreamToTiles)
export class ClipSource       { constructor(url); async start() -> { video }; kind='clip' }                        // CompositeCam.useFile(url) (test-source.js:83-86)
export class KeyboardSource   { constructor({ S, clientId, tileWorldRect, speedMps = 0.6 }); bind(window); unbind(); toggle(on); tick(dt) -> {L:null, R:pack|null}; state:{active, x, y, z:-D, closed} }
      // arrows move; Space down -> PackGen.cup, up -> PackGen.open (one frame) then flat; writes S.ovPacks[clientId] = {L:null, R:pack}; velocity = position delta / dt (measured by PropBall's own follow history)
export function makeHandSource(kind, opts) -> LocalCameraSource | CloneSource | ClipSource
```

### 3.7 `sdk/game/latency-cues.js` — appended classes (T4)

```js
export class ArrivalPredictor {
  constructor({ court, mySeat, minLeadMs = 300 })
  onState(s, nowMs)            // BALL_STATE from BallNet.hooks.onRemoteState: ignore when s.inTransit, s.seat === SEAT_NONE, s.hold.mode !== HOLD.FREE;
                               // p = court.predictExit(s.seat, s.x, s.y, s.vx, s.vy, s.t); if p && p.to === mySeat -> this.pred = {seat:s.seat, edge, cEdge, tEdgeEst:p.tEdge, predicted:true, since:nowMs}; else clear
  onLaunch(l)                  // LAUNCH seen: if l.to === mySeat -> this.pred = {..., tEdgeEst: l.tEdgeEff, predicted:false}
  read(nowMs) -> { seat, edge, cEdge, tEdgeEst, predicted, leadMs: tEdgeEst - nowMs } | null
  clear()
  stats: { predictions, confirmed, moved (edge-point moved > 0.2 u between successive predictions) }
}
export class MissCue { constructor(ctx2d); show(domRect, kind:'miss'|'catch'|'save'|'goal', color); draw(nowLocal); }   // 200 ms ring fade, halo
```
`ArrivalRing.show` is called with `{rect: court.rectOf(seat), edge, cEdge, tEdgeEff: tEdgeEst, color, leadMs: RING_LEAD_MS, dashed: predicted}` — add the optional `dashed` flag to `ArrivalRing.show/draw` (setLineDash([6,6]) when true); that is the only change to the existing class.

### 3.8 `sdk/game/sfx.js` (T4; browser, WebAudio synthesis, no assets)

```js
export class Sfx {
  constructor({ muted = false, volume = 0.35 })
  unlock()                                  // create/resume AudioContext on the first user gesture
  whoosh(pan = 0, durMs = 350); thud(pan = 0); bonk(pan = 0, vy = 0); tick(pan = 0); chime(); sink(); pop(pan = 0)
  mute(bool); get muted; duck(bool)         // duck = -12 dB while PushToTalk is listening
  textTwin(name) -> string                  // 'whoosh' -> 'Ball thrown', ... (every cue has a text twin for the live region)
}
```
Each cue uses `OscillatorNode` / noise buffer -> `GainNode` envelope -> `StereoPannerNode(pan)`; pan from
`panForTile(domRect, galleryWidthPx)`. Derived from `AudioCues` in `latency-cues.mjs:93-125`.

### 3.9 `sdk/game/ball-game.js` (T4; Node-safe with `scene=null`, three.js math only)

```js
export const FEEL = Object.freeze({ V_DROP: 0.25, V_MAX_OUT: 3.0, V_MAX_IN: 2.0, V_MAX_IN_DEGRADED: 1.5, V_LOST_CLAMP: 0.3,
  GRAVITY_M: -COURT_GRAVITY * U, RESTITUTION: FLOOR_RESTITUTION, CUE_LEAD_MIN_MS: 300, RING_LEAD_MS: 400, RING_R_FROM: 3,
  ENTRY_TAU_MS: 100, ARRIVE_NO_CONTACT_MS: 600, GOAL_RING_R: 0.25, GOAL_RING_Y: 0.35, CATCH_ASSIST_FRICTION: 0.95,
  POTATO_MS: 8000, WALL_RESTITUTION: 0.6, DT_MIN: 1/120, DT_MAX: 1/30, STALE_FADE_MS: 150, STALE_DROP_MS: 400, LAUNCH_Z_EASE_MS: 60 });
export const PHASE = Object.freeze({ IDLE:'idle', HELD:'held', FLIGHT:'flight', TRANSIT:'transit', ARRIVING:'arriving', FLOOR:'floor', SINKING:'sinking', RESPAWN:'respawn' });
export class BallGame extends EventTarget {
  constructor({ scene, stage, court, net, clock, seat, clientId, isHost, mode = 'free'|'potato'|'practice',
                tileWorldRect: (seat) => {x0,y0,x1,y1,floorY}, courtToWorld: (x,y,out) => {x,y,z}, uvCamOf: (seat) => uvCam,
                domRects: () => rects[], cues: { ring, ghost, miss, predictor, sfx } | null, announce: (text, level) => void })
      // constructs the ONE PropBall(scene, { radius: court.R*U, gravity: FEEL.GRAVITY_M, restitution: FEEL.RESTITUTION, mesh: matcap sphere on layer 0, boundsR: 2.2,
      //   spawnOffset: (0,0,0), onExit, onGrab, onRelease }); wires every BallNet hook (net.hooks = this.hooks) — the page passes hooks through, never overrides them
  start()                        // host: net.kickoff(courtBall at kickoff seat, y0 + R + 0.4); others: no-op; sets running
  stop(); reset()
  setMode(mode); setGoal(seat|-1)             // host only: seatMap.goal -> net.publishSeatMap({...map, goal, v: map.v+1})
  passToward(seat) -> { ok, reason? }         // only when isOwner && !hold && !cradle && !inTransit: sets sphere.vel toward that seat's shared edge at 1.6 u/s * U (agent tool pass_object)
  tick(now, dt, myPacks, myHb, extraBodies = [])   // dt clamped to [DT_MIN, DT_MAX]; owner + non-owner per-frame flow (§6 steps 7)
  phase, score: number[] (by seat), goalNo, lastLauncher, potato: { untilMs } | null, stats: { catches, misses, saves, goals, lostDrops, clamped }
  events (CustomEvent detail): 'phase' {from,to}, 'owner', 'launch', 'claim', 'goal' {scorerSeat, goalSeat, potato}, 'wall', 'respawn', 'chip' {seat, text}, 'ring' {seat, kind}
  snapshot() -> { phase, owner, inTransit, ball: ball.snapshot(), score, goal, potato, leadMs }
  ball: PropBall, net, court
  dispose()
}
export function classifyRelease(velWorld, how:'wrap'|'clip'|'cradle'|'lost', U) -> { kind:'drop'|'throw', clamped:boolean, vel:Vector3, reason: REASON }
      // |v|/U < V_DROP -> drop (ROLL); > V_MAX_OUT -> scaled to V_MAX_OUT*U (clamped); how === 'lost' -> min(|v|, V_LOST_CLAMP*U) drop
```
Owner frame (in `tick`): `holderBefore = ball.hold?.slot ?? ball.cradle`; `ball.update(dt, packs, hb)`; if a hold ended this
frame and the holder's pack is absent -> `classifyRelease(vel, 'lost')`, else `classifyRelease(vel, holdType)`; apply the
classified `vel` to `ball.sphere.vel` and remember `reason`; `hold = holdFromProp(...)` when held/cradled; `cb = toCourtBall(court, net.simSeat, uvCam, {pos, vel, angVel, atRest, onFloor, reason}, hold, out, {mirroredInput})`; goal test
(free ball, centre inside the goal ring of `court.map.goal` when `net.simSeat === goal`) -> `net.declareGoal(lastLauncher, ++goalNo)`;
`net.tickOwner(cb)`; potato timer (host). Non-owner frame: `net.tick()`; ghost/remote placement; `predictor.read()` -> ring;
`ballFromHold` on the received packs when `lastRemote.hold.mode !== FREE` and that seat's hands are < 150 ms old.
`onBecameOwner(c)`: `ball.setHome(centre of my tile world rect, tileWorldRect(seat).floorY)`; `ball.sphere.reset(courtToWorld(c.x, c.y))`;
`{vx,vy} = ThrowDetector.shapeEntry(c.vx, c.vy, band cap)`; `ball.sphere.vel.set(vx*U, vy*U, 0)`; `ball.hold = null`; `ball.sphere.pos.z = -D` (camera space); phase ARRIVING.
`onWall(edge, cb)`: reflect `ball.sphere.vel.x *= -FEEL.WALL_RESTITUTION` and push the ball inside the rect by `R`.
Hooks are wired in the constructor; the page never sets `net.hooks` itself.

### 3.10 `sdk/game/bot-tile.js` (T3; Node + browser; imports only `sdk/game/court-map.js`, `ball-net.js`, `../net/hand-stream.js`, `pack-gen.js`)

```js
export class BotTile {
  constructor({ transport, clock, court, seat, clientId, name = 'Bot', holdMs = 800, throwEvery = 6000, rateHz = 30, rng = Math.random })
      // owns a BallNet (isHost:false) with hooks: onBecameOwner -> hold for holdMs (BALL_STATE with hold CRADLE, ball on the cup pack), then launch toward the next seat
      //   by setting the court ball {x,y,vx:1.6,vy:0.4} and letting tickOwner's exitEdge fire; onSeatMap -> seat/rect refresh
  tick(nowLocal)               // at rateHz: encodeHandStream(seat, hands, seq++, clock.now(), {hold}) -> transport.send(bytes,{reliable:false}); net.tick(); net.tickOwner(ball) while owner; ball integrated with integrateCourt in court units
  hands(t) -> { left:null, right:{img, world} }   // canned: PackGen.cup / open waved along a slow figure-eight, converted with packToHands at the seat's uv camera (duck-typed)
  net, seat, clientId, stats: { sent, claims, launches }
  dispose()
}
```
Bots are full BallNet clients on the same transport (ownership / roster fuzz); they never touch a hull (documented).

### 3.11 `sdk/game/prop-ball.js` — the T10 (body, stretch) extension only

`update(dt, pk, hb = null, extraBodies = [])`: after the hand SUPPORT loop (line ~353-368) and before the cradle follow,
for each `{joints, radii, present}` in `extraBodies` with `present`: `H.pushOut(joints, radii, _tB)` capped at 2 cm/frame,
velocity component into the body removed, friction 0.85 — shape-vs-shape support only; never a grab (`BodyBody.openness`
is pinned 1). Re-run the 23 checks and add the 24th (a body sphere supports the ball; the ball never ends inside it).

### 3.12 `sdk/game/scene-executor.js` (T5; Node-safe with `scene=null`)

```js
export const KINDS = { apple:{r:0.04, color:'#d7263d'}, ball:{r:0.05, color:'#f2f2f2'}, basketball:{r:0.12, color:'#e0762b'}, butterfly:{r:0.03, color:'#7b61ff'},
                       bird:{r:0.075, color:'#4aa3df'}, sword:{r:0.045, color:'#c0c0c0'}, cube:{r:0.05, color:'#3ddc97'}, glass_ball:{r:0.06, color:'#b3e5fc'} };   // sphere hulls; r = size_m/2 of tools.json natural sizes
export class SceneExecutor {
  constructor({ scene, stage, props: Map, localTile: () => Tile, roster: () => roster[], seatOf: (participantRef) => seat|-1, game: () => BallGame|null, isHost: () => bool, me: () => {clientId,name,seat}, announce, fire? })
  async exec(name, input) -> object          // ALWAYS returns { ok:boolean, ... }; unknown tool -> { ok:false, reason:'unknown tool' }
  // spawn_object {kind, size_m|null, attach, physics}:
  //   r = clamp((size_m ?? natural)/2, 0.01, 1.0); attach left_hand|right_hand -> that slot if tracked with HandBody.openness > 0.6 else {ok:false, reason:'no open <side> hand'};
  //   either_hand -> right if open else left else fallback world_front with note; table -> floor point under workspace centre;
  //   hand placement: P = palmPose(pack) centre, n = measured inner normal (same maths as PropBall._holdPose: cross(wrist->middleMCP, index->pinky) signed by the thumb/fingertip volar test), home = P + n*(r + 0.01);
  //   new PropBall(scene, { radius:r, gravity: physics==='light' ? -3 : physics==='heavy' ? -9.7 : -5.2, restitution: bouncy 0.8 | heavy 0.3 | 0.58, home, spawnOffset:(0,0,0), floorY: tile floor, boundsR: 2.2, mesh: coloured sphere on layer 0 });
  //   world_front: home = views.workspaceCenter(cam) + (0, 0.1, 0.3). Returns { ok:true, id:`${kind}_${n}`, attach: resolved, note? }. mesh.parent === scene always; gravity < 0 always. [X1][X2][X3]
  // set_behavior {target, behavior, params}: seek_hand -> prop.behavior = {kind:'seek_hand', hand} applied per frame as z-only depth bias + x/z pocket attraction toward that hand's pocket at <= 0.4 m/s, never lifting (y untouched) and never gravity-off;
  //   idle -> behavior null; orbit_hand|follow_gaze|flee_hand|land_on_hand -> { ok:false, reason:`${behavior} is not available in this build (gravity is always on)` }  [X4]
  // apply_effect {target, effect, duration_s}: glow -> material.emissive; trail -> 12-point ribbon; fire -> FireEffect when available; sparkle|confetti|bounce -> { ok:false, reason } ; duration 0 stops
  // transform_object {target, scale, color, size_m}: setScale clamped so radius in [0.01, 1.0] (size 0.02-2 m), colour via material.color
  // remove_object {target}: id | kind | 'last' | 'all' -> dispose + delete; returns { ok, removed:n }
  // pass_object {target, to_participant}: only the game ball ('ball' when the game runs) -> game.passToward(seatOf(to)); any agent prop -> { ok:false, reason:'only the game ball crosses tiles' }
  // designate_goal {participant}: isHost ? game.setGoal(seatOf(p) or -1 for 'none') : { ok:false, reason:'host only' }
  // list_scene {} -> { objects:[{id, kind, size_m, position:[x,y,z], held_by, behavior, effects}], participants:[{id:clientId, name, tile:{seat, row:0, col:seat}, hands:{left:bool,right:bool}, goal}], speaker }
  tick(dt, packs, hb)                          // per frame for every local prop: behaviour, then prop.ball.update(dt, packs, hb); effects
  resolve(targetRef) -> prop|null              // id | kind (exactly one) | 'last'
  lastTarget
  dispose()
}
```
Derived from `R/command-agent/mock-executor.js` (contract), `R/codebase/sandbox-skeleton/sdk/game/sandbox-tools.js:63-91`,
`R/codebase/agent-tools.md`, `R/command-agent/NOTES.md`. Vocabulary = `tools.json` enums exactly (D-C).

### 3.13 `sdk/game/hud.js` (T5; browser)

```js
export class Hud {
  constructor(chipEl, panelEl, { hz = 2 })
  frame({ scriptMs, detectMs, fps })            // rolling p50/p95 over 120 samples
  ownAge(ms); remoteAge(clientId, name, ms); relay({ rttMs, offsetMs, samples, errMs }); ball(netStats, phase, leadMs); contexts(n)
  band(clientId) -> 'invisible'|'fine'|'stretch'|'degraded'|'wall'     // latency-feel.md bands from p95
  render(nowLocal)                              // <= hz DOM writes; chip text `you 34 · Hannah 68 · Bot 12 · relay 9`
  toJSON() -> S.hud shape; autotestLine(extra) -> 'AUTOTEST ' + JSON
  setVisible(bool)
}
```

### 3.14 `sdk/game/twin-ui.js` (T1; browser, no three.js)

```js
export function fixed169(n, W, H, gap = 8, tol = 0.10) -> { rows, cols, tw, th, padX, padY }     // copy of R/ui/scripts/gallery-grid.mjs:30 (exported for tests)
export class TwinUI extends EventTarget {
  constructor(root, { strings })                 // builds nothing: the DOM skeleton (SPEC §2.4) is in teamslab.html; binds ids
  layout(n) -> { rows, cols, tw, th }            // rule B via CSS vars --tile-w/--tile-h on #gallery; emits 'layout' with rects
  rects() -> Map<clientId, DOMRect>              // relative to #stage
  addTile({ clientId, name, kind, seat }) -> { el, video, avatar, chrome }   // seat-ordered insertion; role=listitem/group + aria-label
  removeTile(clientId); reorder(seatMap)
  setTileState(clientId, { speaking, raised, goal, ball, alpha, ageMs, pill:'tracking'|'device-only'|'camera-off'|'landmarks'|'no-data', chip:string|null, ring:'incoming'|'catch'|'miss'|'save'|'goal'|'potato'|null })
  setScore(bySeat, names); setPotato(seat, remainingMs|null)
  toast(text, { ms = 3000 }); announce(text, level = 'polite')         // throttled 2 s per region
  openConsent() -> Promise<'share'|'device-only'|'declined'>            // C1 strings; ?consent=1 resolves 'share' immediately; stores localStorage 'hopeos.consent'
  bindControlBar({ onCam, onMic, onDeviceOnly, onShare, onReact, onRaise, onMore, onLeave })   // role=toolbar, arrow keys, aria-pressed
  bindPanel({ onLayer(name, on), onMode(mode), onGoal(seat), onPlay, onKickoff, onReset, onCommand(text), onPttDown, onPttUp, onTab(name) })
  bindKeys({ onKey(action, down) })            // K, arrows, Space, G, 1-9, P, M, H, V, Ctrl+/, Esc (SPEC §5)
  renderRoster(roster, me); renderApiTab(rows)  // rows: [{layer, twin, path, pill:'demo'|'seam'|'probe first', live:()=>string, links:[{label, href}], blocker}]
  updateApiLive()                               // calls each row's live() at 1 Hz
  openCommandPopover(); openAbout(); openOutgoingHelp()
  setReducedMotion(bool); get reducedMotion     // reads --tw-motion
  setDeviceOnly(bool)                           // pill + button state + strings C3/C4
}
```
Derived from `R/ui/layout-spec.md` §1-§7, `R/ui/overlay-sketches.md` §5-§8, `R/ui/accessibility.md`,
`R/gaps/data-privacy-terms/consent-copy.md` (C1, C3, C4, C7, C10 strings verbatim), `R/gaps/render-budget/layout-spec.patch.md`.

### 3.15 `sdk/game/body-layer.js` (T10 stretch; browser)

```js
export class BodyLayer { constructor({ scene, tile, stage }); async init() /* tile.pipe re-created with withPose:true (one pose landmarker, local tile only) */; tick(frame, dt) -> bodyBody /* BodyBody(BODY_RADII) fed from the 33-point pose via HandViews.mirrorPoint + BodyPose.stabilizeMirror as in handlab.html:937-984 (dropins §3.10) */; rig: HoloBodyRig|null; dispose() }
```

## 4. New modules under `sdk/net/`

### 4.1 `sdk/net/room.js` (T3; Node + browser; imports `../game/ball-net.js`, `../game/court-map.js`)

```js
export const PK_PRESENCE = 0x21;                   // also PK.PRESENCE in ball-net.js
export function encodePresence(p, seq, t) -> ArrayBuffer   // 8-byte header (type 0x21, flags 0, seq, t) + UTF-8 JSON {v:1, clientId, name, tracked, aspect, handSpan, kind}
export function decodePresence(buf) -> object
export class Room extends EventTarget {
  constructor({ transport, clock, net, court, me: { clientId, name, tracked, aspect = 16/9, handSpan = null, kind = 'local' }, presenceMs = 2000, pruneMs = 6000, isRelay = false })
      // isRelay: true for WsRelayTransport (the relay answers CLOCK_PING); false for Loopback/Mem (the HOST answers CLOCK_PING with CLOCK_PONG so everyone converges on the host's local clock)
  async join() -> { clientId, peers }             // WsRelay: await transport.ready; Loopback/Mem: clientId = me.clientId; sends PRESENCE immediately, then every presenceMs; pings: 1 Hz until clock.samples.length >= 8, then 0.1 Hz
  roster: [{ clientId, name, tracked, aspect, handSpan, kind, lastSeenMs }]   // sorted by clientId (string compare)
  get isHost() -> bool                             // roster[0].clientId === me.clientId  (lowest clientId; relay ids c-000.. are lexically sortable; loopback ids 'c-' + zero-padded joinedAt + rand; ?host=1 forces 'c-000000-')
  clockReady() -> bool                             // isRelay ? clock.samples.length >= 8 : (isHost || clock.samples.length >= 8)
  tick(nowLocal)                                   // presence cadence, pings, prune (no PRESENCE for pruneMs -> remove + 'roster'), host: republish seat map on roster change
  buildMap() -> seatMap                            // buildSeatMap(roster, { cols: roster.length, wrap: roster.length > 1 ? 'row' : 'none', outer: 'wall', goal: prev.goal, kickoff: 0, v: prev.v + 1 })
  publish(mapPatch = {})                           // host only: net.publishSeatMap({ ...buildMap(), ...mapPatch })
  on('roster' | 'host' | 'seatmap' | 'peer-joined' | 'peer-left', fn)   // 'seatmap' fires from net.hooks.onSeatMap passthrough (Room wraps the hook without replacing the page's/BallGame's)
  setTracked(bool); setHandSpan(units)             // updates my presence
  leave()
}
```
Derived from `R/game/examples/relay-server.mjs` (hello/joined/left, CLOCK_PING answered by the relay), `stage.html:183-222`
(host election, presence cadence), `court-map.mjs::buildSeatMap`, `ball-net.mjs::encodeSeatMap` pattern.

### 4.2 `sdk/net/video-sink.js` (T9 stretch; browser)

```js
export class OutgoingSink {
  constructor({ stage, video, localVp: () => vp, w = 1280, h = 720, fps = 30 })   // 2D canvas: drawImage(video) UN-mirrored (as others see you) + drawImage(stage.renderer.domElement, localVp crop -> 0,0,w,h) right after stage.render()
  draw()                                     // call once per rendered frame
  get stream() -> MediaStream                // canvas.captureStream(fps) (C1 via OBS window capture, C3 LocalVideoStream)
  openWindow() -> Window                      // popup teamslab.html?outgoing=1 that paints this canvas at w x h (via BroadcastChannel 'hopeos-outgoing' ImageBitmap transfer)
  stats: { fps, w, h }
  dispose()
}
```
Derived from `R/acs/acs-client.html:233-274`, `R/video-effects/effect-core.js:44-56`. No second WebGL renderer.

### 4.3 `sdk/net/hand-stream.js`, `remote-consumer.js` — verbatim (see §2).

### 4.4 `sdk/net/transports.js` — appended

```js
export function gated(transport, isSharing: () => boolean) -> Transport   // send() is a no-op (counts `stats.suppressed`) while !isSharing(); onMessage passes; id/close forwarded
```

## 5. Page: `teamslab.html` (T6) and `sdk/ui/teamslab.css` (T1)

- `<head>`: importmap `{ "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": ".../examples/jsm/" }` (as in `R/codebase/dropins.md` §1), `<link rel=stylesheet href=sdk/ui/teams-tokens.css>`, `sdk/ui/teamslab.css`, `data-theme="dark"` on `<html>`.
- URL params (`S.url`): `room` (default 'lab'), `relay` (ws URL -> transport 'ws'), `transport=loopback` (default when no relay), `name`, `host=1`, `tiles=n` (extra local tiles), `clone=1` (extra tiles are webcam clones), `clip=<url>` (extra tile from a recorded clip), `bot=n` (in-page BotTiles), `auto=1` (skip Join), `fixedstep=1` (`setInterval(16)` loop instead of rAF; headless rAF starves), `consent=1`, `agent=auto|local|claude`, `proxy=<port>`, `mode=free|potato|practice` (default practice when alone, free otherwise), `nosfx=1`, `hud=0`, `outgoing=1` (popup mode), `lat/jit/loss` (loopback injection), `wan=1` (HANDOFF_TIMEOUT 400), `shell=1` (UI only, no tracking; T1's probe).
- `window.__twin = { ready: Promise<void>|true, S, stage, tiles, room, net, court, game, agent, hud, ui, clock, transport, ovPacks: S.ovPacks, step(dt) (one manual frame under fixedstep), snapshot() -> JSON-safe {S subset, ball, hud}, THREE }`.
- `AUTOTEST {"t","fps","scriptMs","detectMs","tiles","owner","inTransit","phase","ball","remote":{id:ageMs},"leadMs","contexts"}` console line every 1 s when `?auto=1`.
- Boot order (from `R/codebase/minimal-holohands.html` and `dropins.md` §2): tokens/CSS -> `TwinUI` -> consent -> `LocalCameraSource.start()` -> `StageRenderer` -> landmarkers sequentially (`TilePipeline.init()` one at a time) -> transport + `SharedClock` -> `BallNet` (always) -> `Room.join()` -> `RemoteHands` -> layers per toggles -> loop.

## 6. Per-frame data flow (checkpoints [C] chirality, [D] doctrine, [W] wire, [M] mirror)

```
 [1] camera -> local <video> (CSS scaleX(-1) on the tile media only)        ONE getUserMedia; clones = stream.clone()
 [2] local tiles: r = pipe.detect(now, dt, cols)   cols = [game ball collider, ...local prop colliders]
       packs = views.resolve(...)                                              [C1] chirality measured per tile; labels never read
       rigs posed (conform to cols, occluder on); HandBody per slot            (all inside TilePipeline)
 [3] encodeHandStream(me.seat, pipe.hands (RAW PlayerPipeline shape), seq++, clock.now(), {hold}) -> transport.send(bytes,{reliable:false}) at 30 Hz
                                                                               [W1] nothing pre-flipped / re-filtered / relabelled; 516 B max
 [4] RemoteHands.onMessage(buf) for every HAND_STREAM on the shared transport (BallNet and Room return on 0x30)
       per remote tile: rd = remote.read(seat, clock.now()); tile.remote.setSlotsToDrop(remote.slotsToDrop(seat, now)); tile.remote.feed(rd, now, dt, cols)
                                                                               [C1'] receiver re-measures chirality with its own HandViews
       tile.remote.setAlpha(rd.alpha); hud.remoteAge(id, rd.ageMs)             stale 1 -> 0.5 between 150 and 400 ms
       (bot tiles: BotTile.tick() sent packets on the same transport; they arrive here like any remote)
 [5] ovPacks seam: if S.ovPacks[clientId] -> tile.packs = {L, R} from it (probes, KeyboardSource)   physics AND rigs read the SAME packs
 [6] local props: exec.tick(dt, localTile.packs, {left:handL, right:handR})   -> PropBall.update per prop
       [D1] collision = PropHull vs 21 joint spheres (packRadii)   [D2] pickup only _wrapGrab (wrap/clip) or _holdPose cradle
       [D3] open hand -> hold = null THAT frame                     [D4] GrabbableSphere.update(dt, [], floorY): gravity ALWAYS on, empty hand list
       [D5] hull.pushOut + handResist: ball yields <= 2 cm/frame, the hand is stopped (hands support, never pass through)
       [D6] seeks are z-only depth bias or x/z pocket attraction, never lift, never gravity-off
       [D7] extraBodies (stretch): pushOut only, BodyBody never grabs
 [7] game ball: game.tick(now, dt, simTilePacks, hb, extraBodies)   simTile = my tile, or the untracked seat I proxy (host)
       owner:      ball.update (same [D1-D7]); classifyRelease (lost -> 0.3 u/s); hold = holdFromProp(...);
                   net.tickOwner(toCourtBall(court, simSeat, uvCam, prop, hold, out, {mirroredInput:false}))       [M1] one flag, one place
                   -> BALL_STATE 34(+14) B at rateHz; exitEdge -> LAUNCH 42 B (+3 repeats) toward neighbourAt; none -> onWall (local bounce)
                   PropBall.onExit -> onPropExit(...) safety net (boundsR 2.2 m > half-diagonal 1.9 m)
       non-owner:  net.tick(); predictor.onState (from onRemoteState) -> ring (dashed) ; ghost from LAUNCH (solid ring, whoosh)
                   mesh.position = courtToWorld(ghost | lastRemote) at z = -D; or ballFromHold on that seat's received packs when held and fresh
       onBecameOwner: reset at courtToWorld(claim) with shapeEntry-capped velocity, gravity on -> catch is a normal [D2] pickup in MY tile
 [8] stage.render(tiles): clear; per tile setViewport/setScissor(vp) + render(scene, cam)   rigs on layer 1+i, ball/props/ghost layer 0
       [M2] R_px = court.R * th on both sides of every gutter (same px-per-metre by construction)
 [9] hud.frame(...); ui.setTileState(...); live regions throttled; AUTOTEST line; outgoing.draw() (T9)
```

## 7. Packet table (authoritative: `R/gaps/wire-protocol/hopeos-wire.md` §2-§6 + PRESENCE)

| type | name | bytes | reliable | rate | sender | consumer |
|---|---|---|---|---|---|---|
| 0x01/0x02 | CLOCK_PING / PONG | 12 / 20 | no | 1 Hz until 8 samples, then 0.1 Hz | every client / relay (or host on loopback) | `SharedClock.sample` (median of 8) |
| 0x10 | BALL_STATE | 34 (+14 HOLD_OFFSET) | no | 20 Hz ws, 30 Hz loopback | owner only | `BallNet`, `ArrivalPredictor.onState` |
| 0x11 | LAUNCH | 42 | yes + 3 unreliable repeats | on edge exit | owner | `BallNet` (ghost, claim schedule), `onLaunchSeen` |
| 0x12 | CLAIM | 30 | yes | at tEdge' | receiver / host proxy | `BallNet` (ownerSeq conflict rule) |
| 0x13 | ACK | 12 | yes | reply to CLAIM | old owner | `BallNet` |
| 0x14 | GOAL | 16 | yes | on goal / potato burst (`goalNo` bit 7 = potato) | goal-seat owner / host proxy | `onGoal` -> score everywhere |
| 0x20 | SEAT_MAP | 8 + JSON | yes | on roster change (FROM_HOST) | host | `BallNet` -> `court.set`, `onSeatMap` -> gallery order |
| 0x21 | PRESENCE (NEW) | 8 + JSON `{v,clientId,name,tracked,aspect,handSpan,kind}` | yes | on join + every 2 s | every client | `Room` (BallNet/RemoteHands `default:` ignore it) |
| 0x30 | HAND_STREAM | 516 two hands + world, 264 one, 12 heartbeat | no | 30 Hz | every tracked client | `RemoteHands` (latest-wins by `seqNewer16`) |

Header (LE): `u8 type, u8 flags|ver, u16 seq, u32 t`. HAND_STREAM body: `u8 seat, u8 hflags, u8 hold, u8 pad`, then per present
slot 21 x (u,v,z) i16/32767 and, when WORLD_x, 21 x (x,y,z) i16 mm. Nothing else crosses the wire: no video, no face, no
pose (POSE33 reserved), no names outside PRESENCE/SEAT_MAP JSON. Budget per client ~16.5 kB/s.
T0 appends the 0x21 row to the copied `docs/teams/hopeos-wire.md`.

## 8. Doctrine, chirality, mirror and executor checkpoints as testable assertions

| id | assertion | checked by |
|---|---|---|
| [C1] | no `handedness`, `categoryName`, `1 - x`, `-p.z`, `zSign` outside `sdk/core/hand-views.js`; every tile constructs its own `HandViews` | `wire-smoke` (iv) greps; `_twinprobe` #5 (remote tile `views !== local views`) |
| [D1] | contacts come from `PropHull` vs joint spheres; grep: no `jointsWithin`, no `GrabState` in `sdk/game`, `sdk/net`, `teamslab.html` | `prop-ball-smoke` greps + `scene-executor-smoke` greps |
| [D2] | an `open` pack hovering over the ball for 30 frames never grabs and never lifts (y unchanged +/- 1 mm); `cup` grabs within 10 frames | `prop-ball-smoke` (copied); `_twinprobe` #6 via `ovPacks`; `ball-game-smoke` |
| [D3] | on the frame the pack becomes `open`, `ball.hold === null` and `vel` = history mean | `prop-ball-smoke`; `ball-game-smoke` (`classifyRelease` sees `holdType`) |
| [D4] | grep: no `gravity: 0`, `gravity = 0`, `gravity:0`; `sphere.gravity < 0` on every PropBall instance the executor and the game create | `scene-executor-smoke`; `ball-game-smoke` |
| [D5] | a `flat` pack under the ball: ball rests at `y >= palm.y + r - 3 mm`, never below the palm; pack hitting a free ball moves it <= 2 cm/frame | `prop-ball-smoke`; `_twinprobe` #6 |
| [D6] | `seek_hand` for 60 frames with the hand 0.3 m above the prop: prop `y` never increases beyond gravity's own integration | `scene-executor-smoke` |
| [D7] | (T10) a body sphere supports the ball; ball centre distance to the sphere >= r_ball + r_body - 3 mm | `prop-ball-smoke` 24th |
| [D8] | `prop.ball.mesh.parent === scene` for every executor prop and the game ball; never a child of any rig group | `scene-executor-smoke`; `_twinprobe` #8 |
| [K1] | the keyboard hand enters through `S.ovPacks[me]` and picks the ball up by `_wrapGrab` (`ball.snapshot().holdType in {'wrap','clip'}`), never by a teleport | `_twinprobe` #9 |
| [L1] | `classifyRelease(v, 'lost')` yields `|v| <= 0.3*U` and kind 'drop'; `|v| > 3.0*U` is scaled to exactly `3.0*U` | `ball-game-smoke` |
| [M1] | `MIRRORED_INPUT === !DISPLAY_MIRRORED`; `worldToCourt` of a point at u = 0.9 of seat k yields court x in the right 10 % of rect k; a world +x exit in seat k maps to `EDGE.R` and `neighbourAt` returns seat (k+1) mod n | `court-space-smoke` |
| [M2] | `courtToStagePx(...).pr === court.R * th` (+/- 1e-9) on both sides of every gutter for the six rectangles; `uvCam` maps the tile rect corners to u,v in {0,1} (+/- 1e-6) | `court-space-smoke` |
| [W1] | encoded hands decode within 1.53e-5 img / 0.5 mm world; three senders at 30 Hz with 5 % loss: latest-wins, 0 reorders accepted; `ageMs < 200` | `wire-smoke` (copied) |
| [W2] | PRESENCE 0x21 is ignored by `BallNet._onPacket` and `RemoteHands.onMessage` (returns false), parsed by `Room`; host = lowest clientId on every client; seat map `v` increments on every roster change | `bot-pass-smoke` |
| [N1] | over MemHub 90 +/- 30 ms, 5 % loss, 3 bots + 1 headless BallGame: ball visits every seat within 20 s sim, exactly one in-tile owner at every sampled tick, `conflicts === 0` | `bot-pass-smoke` |
| [P1] | `ArrivalPredictor.read().leadMs >= 300` on every throw of the fuzz whose exit is toward me; `predicted` flips to false on LAUNCH; the confirmed edge point is within 0.2 u of the last prediction in >= 80 % of throws | `ball-game-smoke` |
| [X1] | `spawn_object {attach:'right_hand'}` with a `cup`/`open` pack: prop centre within 2 mm of `palm + n*(r+0.01)` along the MEASURED normal (sign from `palmPose`, not a constant); `attach:'either_hand'` with no open hand -> `attach:'world_front'` in the result | `scene-executor-smoke` |
| [X2] | after the pack is removed the prop falls (`vy < 0` within 10 frames) | `scene-executor-smoke` |
| [X3] | every `tools.json` tool name has an `exec` branch; every `attach` and `behavior` enum value is handled (implemented or `{ok:false}`); unknown behaviour -> `{ok:false, reason}` | `scene-executor-smoke` (loads `tools.json`) |
| [X4] | `pass_object` refused (`ok:false`) when not owner / held / in transit / prop is not the game ball; `designate_goal` refused when not host | `scene-executor-smoke` |
| [A1] | `#live-polite` text changes after a pickup and after a goal; never more than one change per 2 s | `_twinprobe` #10, `_twinpass-probe` |
| [A2] | `--tw-motion` is `0` under `--force-prefers-reduced-motion`; every `.tile` has `aria-label`; control-bar buttons >= 32x32; no horizontal scroll at 472x382 | `_twinprobe` #10, `_uiprobe` |
| [G1] | consent dialog blocks `getUserMedia` (spy count 0 -> 1 only after accept); device-only stops `transport.stats.sent` from increasing while `suppressed` increases | `_uiprobe`, `_twinprobe` #11 |
| [F1] | no `import` of `mpbrowser.html`; no `Date.now()` in `sdk/net`; none of the new files edits `sdk/core/*`, `sdk/interaction/*`, `avatar*`, `mpbrowser.html` | `wire-smoke` greps + `git status` in the acceptance check |

## 9. Test seams and fixtures

- `tests/fixtures/hand-packs.json`: `{ open, cup, flat, wave:[...60], throwRight:[...20] }` generated by `node tests/_gen-packs.mjs` via `PackGen.writeFixtures`.
- Probes inject packs with `await page.evaluate(({id, L, R}) => { window.__twin.ovPacks[id] = {L, R}; }, ...)` and clear with `delete`.
- Node tests build duck-typed cameras via `court-space.makeUvCamera(THREE, aspect, {x,y,z:0})` (three is importable in Node).
- Headless `BallGame` in Node: `scene = null`, `stage = null`, `cues = null`, `courtToWorld` and `tileWorldRect` from `court-space.js` with a synthetic stage `{stageW: 994, stageH: 678, th, rects}` derived from `fixed169(n, 994, 678)`.
