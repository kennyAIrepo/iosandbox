# Multiplayer State-Sync Architectures (build-spec proposals)

Contextualizes the game-state-sync research (`multiplayer-game-state-sync-protocols.md`,
recovered into repo 2026-07-20; plus the co-presence design sessions) against our stack,
and proposes three buildable architectures. Cloud host: Vercel
(plus the pieces Vercel structurally can't do — named explicitly). Engine reuse: mpgames /
sdk/core, per `MULTIPLAYER_PLAN.md`.

---

## 1. The protocol model (what the sync doc + co-presence direction established)

**Ship semantics, not pixels.** Landmarks/gestures are low-dimensional, smooth, loss- and
latency-tolerant; the representation layer (interpolate + extrapolate + retarget-to-rig)
absorbs whatever the transport delivers.

**Two data classes — the distinction that decides everything:**

| | EPHEMERAL PRESENCE | AUTHORITATIVE STATE |
|---|---|---|
| examples | hand/body landmarks, head, gestures-in-flight | cube rotation, grabbed-object owner, score, note stream |
| rate | 20–60 Hz continuous | on-change, discrete |
| delivery | lossy, unordered, newest-wins | reliable, ordered, consistent |
| conflict | none — each player owns their own body | arbitration required |
| degrades as | choppy-but-live | laggy-but-correct |

**Authority = ownership handoff** (Rec-Room model), not authoritative server sim: grab claims
ownership, release keeps it, grab-races resolved by deterministic tie-break; non-physics
state is CRDT/LWW. **Latency-hiding = local-first:** your own body renders from local
tracking at 0 latency and never round-trips; only remote players are interpolated/dead-reckoned.
**Transport-agnostic:** the protocol probes each transport's capability profile (ordered?
reliable? RTT? max rate/size?) and self-configures fidelity — WebRTC fast, relay medium,
chat-text degenerate ("chess-notation keyframes").

### The spatial gesture template (movement sync)

Movement is synced by **retargeting, not replay**. Every client owns identical rig templates
(`HoloHandRig` REST_R42/L42, body rig canonical proportions). The wire carries only the
*pose parameters* of the template:

- **Continuous stream:** quantized landmarks — hands 21×(x,y,z) img + world, body 17/33 pts.
  Keyframe every N packets, delta-encoded between; 10-bit fixed-point per coord ⇒ ~120–200 B
  per player per packet gzipped-equivalent. The remote side feeds these into the SAME
  One-Euro banks + `views.resolve()` + `rig.pose()` path local players use — the rig template
  reconstructs a full 3D hand from sparse params, hiding both network loss and quantization.
- **Discrete gesture events:** locally-classified templates (grab, release, pinch, twist,
  punch-hit) sent as reliable state-bus events. These are what gameplay *reacts* to — so game
  logic stays correct even when the continuous stream degrades to 5 Hz.
- **Degenerate profile:** keyframe-only gesture events over a text channel = the chess case.
  Same protocol, lowest profile.

### 1b. Mapping the research doc's concepts onto our stack (reconciled 2026-07-20)

The research doc is classic game-netcode (Valve/Unreal/GGPO lineage). Our stack is a
*tracked-body* game, which changes which techniques apply and how:

| Doc concept | Our stack | Verdict |
|---|---|---|
| UDP transport | WebRTC DataChannel `unordered, maxRetransmits:0` (Arch A) = the browser's UDP. Relay WS (Arch B) is TCP — accepted cost (~1 interp interval absorbs HOL blocking); **WebTransport datagrams** are the future upgrade if the relay ever needs UDP semantics (needs an HTTP/3 host, e.g. Fly — Durable Objects are WS-only today). | adopt / adapt |
| Snapshot interpolation, render 100–200ms behind | Already built and camera-proven in the YOLO bridge (10Hz snapshots → 60fps render). Becomes the remote-player renderer verbatim. | already built |
| Delta compression + quantization + bit-packing | Adopt for presence hot path. Doc's player entity: 17B full / 3–6B delta. Ours: 17-pt body ≈ 17×2×10bit ≈ 43B full; +2 hands (21×3) ≈ ~200B full — keyframe every 10th, delta between, ~60–80B/player/packet typical at 30Hz ⇒ ~2–3KB/s per player. Well inside any transport. JSON stays for the state bus + debug + the chat-degenerate profile (low-rate, where the doc's "JSON never" doesn't bind). | adopt |
| Snapshots unreliable + reliable event sub-protocol | Exactly our two data classes: presence bus = unreliable snapshots; state bus = reliable ordered events. The doc independently confirms the split. | confirms design |
| Client-side prediction + reconciliation | **Mostly unnecessary for bodies** — our "input" IS the pose; your own body renders local-first with zero round-trip, stronger than prediction (nothing to reconcile — no server sim of bodies, each player is authority over their own). Where it DOES apply: **optimistic ownership** — grab renders immediately, room may deny the claim; the "rubber band" is the object snapping to the granted owner. Small predicted-state buffer only for held-object transforms. | adapt (narrow) |
| Lag compensation (server rewinds to validate hits) | Optional, for competitive scoring only (e.g. beat-game hit racing): punch events carry the frame-time they refer to; room checks against its note-timeline at that time. The frame-echo/vsync machinery already gives us honest timestamps. Skip for co-op v1. | defer |
| Lockstep / rollback | Not applicable: tracked poses are continuous non-deterministic inputs (no bit-perfect sim to lockstep); social/training toy needs no rollback. | reject |
| Relevancy / area-of-interest, priority accumulator | Matters only at Arch C scale (many entities in a court-sized room): room fans out per-subscriber at each client's negotiated budget — that IS a priority accumulator; distance-based relevancy when rooms exceed ~10 entities. | adopt at C |
| Authoritative server + tick sim (the doc's workhorse) | Hybridized: the room worker is authoritative for the STATE BUS only (ownership claims, LWW keys, score, note stream at a modest tick) and never simulates bodies. Full server sim is exactly what ship-semantics makes unnecessary. | hybrid |
| Unreal vs custom | We're the doc's "custom" column by necessity (browser reach, tracked-input model no engine ships) — but ~90% of the custom-netcode bug surface is avoided by riding WebRTC/WS (reliability, congestion, encryption, NAT come free). | n/a — custom-lite |

---

## 2. What the engine already gives us (the reuse inventory)

| Seam | Where | Role in sync |
|---|---|---|
| `PlayerFrame` contract | `sdk/core/multiplayer.js` `detect()` | The canonical presence payload — already id'd, filtered, predicted. Serialize it, that's the outbound presence packet. |
| `EXPO` / `window.HOPEOS_STATE` | `mpgames.html` ~1070 | Live authoritative-state snapshot (hands, body, ball, cube on/twist/squeeze, game) as plain numbers, allocated once — the outbound STATE packet already exists. |
| Snapshot interpolation + vsync | `mpgames.html` YOLO bridge (~1899–2030) | Render one interval behind between two known snapshots + One-Euro at ingestion + scene-cut reset. This IS the remote-player renderer — proven at 10 Hz updates → smooth 60 fps. |
| Ownership mechanics | cube release-then-take, slot ids `left#<id>`, cross-person twist | Local-mode ownership handoff already implemented; network version = same rules, claims travel on the state bus. |
| Per-player rig pools | `handlab-mp` / mpgames extras | Remote avatars = same pooled rig pairs, fed from network instead of local pipeline. |
| Session recorder + dollhouse | `.jsonl` recorder, `dollhouse.html` | Replay/spectator path; a room server can emit the same stream live. |
| One-Euro predict (`predictOnly`) | `player-pipeline.js` | Dead-reckoning for network gaps — same code that bridges skipped detect frames. |

**Net-new needed:** one module — `sdk/core/cosession.js` — plus transport plug-ins.

```js
const cs = await joinRoom(roomId, transport);   // transport: 'webrtc' | 'relay' | 'loopback'
cs.presence.send(playerFramePacket);            // 20–60Hz, newest-wins
cs.presence.onRemote((peerId, frame) => …);     // → snapshot-interp → rig pool
cs.state.set('cube.q', quat);                   // LWW, reliable
cs.state.claim('cube', onGranted);              // ownership handoff, deterministic tie-break
cs.state.onChange((key, val, owner) => …);
```

Renderer never changes; transports are swappable underneath. Loopback transport first =
everything testable solo with CompositeCam clones.

---

## 3. Vercel reality check (constraints that shape all three architectures)

- **Vercel serverless/edge functions cannot host WebSocket servers** (request/response +
  SSE streaming only). So Vercel's roles are: static hosting (all our pages are static —
  perfect fit), signaling/API routes, auth, room directory.
- Anything holding a **persistent socket or room state** lives beside Vercel: WebRTC P2P
  (no server socket at all), a managed realtime service, or a tiny stateful worker
  (Cloudflare Durable Object / PartyKit / Fly.io machine).
- **GPU inference (YOLO serve.py) can never run on Vercel** — GPU host (Fly GPU / Modal /
  RunPod) with its own WS endpoint, fronted by a Vercel API route that mints room/auth tokens.

---

## 4. Architecture A — P2P WebRTC mesh, Vercel = static + signaling

**For:** 2–4 players, lowest latency (~20–60 ms same-region), zero per-message infra cost.
The co-presence memory's agreed FIRST build.

```
Vercel (static mpgames.html + /api/room signaling, Upstash KV or SSE for offer/answer)
        │  signaling only (join, SDP, ICE)
Peer A ═══ WebRTC data channels ═══ Peer B (mesh for 3–4)
        ch1 presence: unordered, maxRetransmits:0   (ephemeral class)
        ch2 state:    ordered, reliable              (authoritative class)
```

- Signaling = 3 serverless routes (`create/join/signal`) + short-TTL KV (Upstash free tier
  or Vercel KV); client polls or holds an SSE stream for the answer. ~150 lines total.
- TURN fallback (symmetric NATs, ~15% of pairs): Cloudflare Calls TURN or Twilio NTS,
  credentials minted by a Vercel route. Without TURN those pairs simply fail — ship with it.
- Ownership tie-break: lowest peerId wins simultaneous claims; claims carry a Lamport tick.
- Mesh caps at ~4 peers (each peer uploads presence to every other); beyond that → B.

**Build:** cosession.js + loopback (~1d) → signaling routes (~0.5d) → WebRTC transport
(~1–2d) → cube-over-network testbed (grab/twist/handoff between two laptops).

## 5. Architecture B — room relay (managed realtime beside Vercel) ← transferable default

**For:** >4 players, NAT/firewall-hostile networks, drop-in spectators, and a place to run
neutral arbitration. One relay hop (~30–80 ms added) — fine for a social toy with One-Euro
prediction on top.

```
Vercel (static + /api/auth token minting + room directory)
        │
PartyKit / Cloudflare Durable Object  (one instance per room = the room's state brain)
   ├─ presence fan-out: newest-wins per peer, rate-adaptive (drops to each subscriber's budget)
   ├─ state: LWW key-store + ownership registry (claims arbitrated HERE — no tie-break races)
   └─ history: emits recorder-format .jsonl → dollhouse replays any live room
Peers connect by plain WebSocket (works everywhere a browser works)
```

- **PartyKit** (Cloudflare-acquired) is the ergonomic pick: a room = one JS class, WS-native,
  deployable in an afternoon, free tier. Raw Durable Objects = same shape, more control.
  Managed alternatives (Ably/Pusher/Supabase Realtime) work but give you channels, not a
  programmable room brain — you'd lose server-side ownership arbitration.
- Same `CoSession` interface — transport plug-in swap, renderer untouched. A/B coexist:
  try WebRTC, fall back to relay (capability probe decides).
- The room worker is also where the **degenerate profiles** live: a slow client negotiates
  5 Hz keyframes; a text-only bridge (chat-bot transport) gets gesture-event notation.

**Build:** PartyKit room (~1–2d given cosession.js exists) → fidelity negotiation (~1d) →
spectator page = dollhouse pointed at the live room stream (~0.5d).

## 6. Architecture C — mid-server sim + THE VIRTUAL ROOM (the target vision)

**The vision (user, 2026-07-20):** track and extract game stats + movements — coordinates
of BOTH human landmark gestures AND game-object specs — as **stats packages**; a cloud
mid-server coordinates them; every player's screen renders everyone's actions. All shared
movement/interaction data lives in a **"virtual room" of coordinates** on the mid-server.

**The virtual room, concretely:** one shared coordinate frame per room, held by the room
worker. Every source normalizes INTO room-space on ingest; every client renders OUT of it:

- **Webcam players** → PlayerFrame (normalized frame coords) → room-space via a per-player
  anchor (v0: each player is a placed "seat" in the room; later: calibrated metres).
- **Footage sources** → YOLO bridge tracks, already court-metres via the 4-tap homography —
  camera-invariant, drops straight into room-space (paint = origin, exactly like dollhouse).
- **Game objects** (ball, cube, notes) → EXPO snapshots keyed into the room's state store;
  position in room-space, owner attached.
- **Stats packages** = the two packet classes of §1 + derived aggregates the room computes
  (per-player speed/distance/gesture counts/score events) — the recorder .jsonl generalized
  into a live queryable stream. Same package feeds live render, dollhouse, and training data.

Each client is a *view* of the room: your own body local-first at 0 latency, everyone else
snapshot-interpolated from room-space into your renderer (rig pools for hands/bodies,
dollhouse for the orbitable overview). Extends B; build only after B ships.

```
Vercel (static: mpgames, dollhouse-live; /api: auth, rooms, session index)
        │
Room worker (Durable Object/PartyKit — same as B)
   ├─ ingests: webcam peers' PlayerFrames  AND  GPU-bridge track streams
   ├─ world state: authoritative store + ownership + game rules that need neutrality
   ├─ behavior/prediction models (court-metres tracks are camera-invariant = trainable)
   └─ emits: per-subscriber views (player / spectator / dollhouse / recorder .jsonl)
        │
GPU host (Fly GPU / Modal / RunPod — serve.py: YOLO+pose+team+gate, fp16, ~42ms)
   streams {id, kpts, box, team, court-xy} into the room like any other "player source"
```

- The key move: the GPU bridge's payload and a webcam peer's PlayerFrame normalize to the
  same presence packet — the room doesn't care if a body is a person at a laptop or a
  tracked NBA player. Dollhouse becomes a live view of ANY room.
- Latency budget: source→GPU ~40 ms + hop ~40 ms + interp delay ~100 ms ≈ 180–250 ms,
  aligned by the existing vsync/frame-echo machinery — already proven in the local bridge.
- Storage: session .jsonl → Vercel Blob or R2; Vercel cron for cleanup/indexing.

## 7. Recommendation + build order

1. **`sdk/core/cosession.js` + loopback transport** — the protocol core, testable solo
   (CompositeCam clones as fake peers). Everything else is a plug-in to this.
2. **Architecture A** (WebRTC + Vercel signaling) — the working vertical slice the partner
   validation plan calls for; Rubik's cube = the two-class stress test (grab ephemeral,
   face-turn authoritative, cross-person twist = ownership handoff).
3. **Architecture B** (PartyKit room) — makes it transferable/deployable-anywhere; adds
   spectators + server arbitration + degradation profiles.
4. **Architecture C** — wire the GPU bridge + dollhouse into B's rooms when the YOLO cloud
   deploy happens (already flagged as a design-with-user step).

Presence wire format v0 (both A and B): `{t, seq, players:[{id, bbox, wrists, body2D?,
handsL?, handsR?}]}` — a pruned PlayerFrame, 10-bit quantized, keyframe every 10th packet;
state bus v0: `{tick, key, val, owner?}` LWW. Version byte first — profiles evolve.

---

## 8. The NBA training-tool loop (how the protocol carries it)

**Vision (user, 2026-07-20):** tracked NBA skeletons + movement stats → mid-server
reconstructs them as avatars → per-player movement profiles → reconstruct whole game
scenes from tracked data → "grab a player out" with their tracking template → upload
YOURSELF as an avatar and play with/against that player live. A training tool.

**The one property that makes this possible:** the presence bus is *source-agnostic*.
A participant in the virtual room is anything that emits presence packets into room-space.
That gives four participant kinds, all speaking the same protocol:

| participant | source of packets | already have |
|---|---|---|
| live human (trainee) | webcam → PlayerFrame → room-space | ✅ full stack |
| tracked footage | GPU bridge → court-metres tracks | ✅ YOLO pipeline + homography |
| **replay** | recorded session .jsonl played on the room clock | ✅ recorder + dollhouse v0 |
| **ghost** | player-profile model generating packets server-side, *reacting to room state* | ❌ the research build |

Because a ghost and a human are indistinguishable on the wire, "play against Jokić's
template" needs ZERO new protocol — the ghost is just a peer whose transport is a
server-side loop. Interaction (ball possession, screens, contact) runs through the same
authoritative state bus + ownership claims as any two humans.

**The pipeline, staged (each stage independently useful):**

1. **RECORD** — session .jsonl: `{tag, team, col, court-metres, box, 17kpts}` per frame.
   Built. Court-metres via homography = camera-invariant → this IS the training corpus.
2. **RECONSTRUCT** — 2D kpt sequences → 3D joint rotations via a MotionBERT/VideoPose3D-class
   lifter (Apache pretrained, ONNX-able; recorded sessions are exactly its input format —
   already identified in MULTIPLAYER_PLAN). Output drives rigged avatars → dollhouse v2
   replays full game scenes as 3D sets, orbitable. This is "scene reconstruction" done.
3. **PROFILE** — per-player template = (a) *skeletal template*: proportions/rig calibration
   measured from their tracks; (b) *movement profile*: statistics first (speed/accel
   envelopes, cut angles, release patterns — queryable stats packages), learned behavior
   model later. Stored per tag/identity from the registry.
4. **GHOST** — a room-side agent process: consumes room state (your avatar's position, ball)
   at tick rate, emits presence packets from the profile model. v0 ghost = pure replay
   (runs a recorded possession at you — already a useful training drill: "defend this
   actual play"). v1 ghost = replay with reactive blending (speed/path adapts to you).
   v2 ghost = learned policy. The protocol is identical across all three — only the
   packet generator improves.
5. **MIXED ROOM** — trainee (local-first, 0-latency own body) + ghost(s) + ball
   (authoritative object both can claim) + live stats scoring on the room's derived-
   aggregate stream. Render on the trainee's end: their holo rig + ghost avatars +
   dollhouse overview. That's the training tool.

**Trainee→court mapping:** your webcam tracking is normalized frame coords; the room is
court-metres. v0 = a fixed training zone (your ~2×2m camera space maps to a court region,
scaled); movement beyond it via gesture/step locomotion. Full-court 1:1 needs room-scale
tracking we don't have — design the zone mapping as its own small spec when stage 5 starts.

**Honest boundary:** stages 1–2 and v0-ghost are engineering on things that exist. A ghost
that genuinely *plays defense* (v1–v2) is the behavior-model research the MID-SERVER note
already flags — the protocol carries it structurally, but its quality is a modeling
problem, not a sync problem. Build order stays: B's room first; ghosts are just its
third participant type.
