# Multiplayer Game State Synchronization Protocols

*Design ideation & technical research for on-the-wire state sharing in multiplayer games*

(Recovered copy — original arrived as a WhatsApp transfer 2026-07; saved into the repo
2026-07-20 because WhatsApp expires transfer files. Companion build-spec:
`MULTIPLAYER_SYNC_ARCHITECTURES.md`.)

---

## Table of Contents

1. [Transport Layer Choices](#transport-layer-choices)
2. [Application-Layer State Sync Patterns](#application-layer-state-sync-patterns)
3. [Serialization Format on the Wire](#serialization-format-on-the-wire)
4. [Practical Techniques Layered On Top](#practical-techniques-layered-on-top)
5. [Deep Dive: Snapshot Packet Layout Example](#deep-dive-snapshot-packet-layout-example)
6. [Deep Dive: Unreal vs. Custom Engine State Sync](#deep-dive-unreal-vs-custom-engine-state-sync)
7. [Deep Dive: Client-Side Prediction Explained](#deep-dive-client-side-prediction-explained)
8. [Recommended Reading](#recommended-reading)
9. [TL;DR](#tldr)

---

## Transport Layer Choices

### UDP — almost always the answer for real-time games
- **Why**: TCP's head-of-line blocking and retransmission stalls are unacceptable for 60Hz state updates. A dropped packet from 100ms ago is stale garbage — you don't want it retransmitted.
- **Trade-off**: You have to build reliability, ordering, and congestion control yourself (or use a library like ENet, yojimbo, or GameNetworkingSockets).
- **Used by**: Counter-Strike, Fortnite, Valorant, Call of Duty, Rocket League.

### QUIC — the modern middle ground
- Built on UDP but gives you multiplexed streams, TLS 1.3 encryption, and connection migration for free.
- Increasingly used for game lobbies, matchmaking, and even gameplay in newer titles.
- Good option if you want UDP performance without hand-rolling a reliability layer.

### WebRTC / WebTransport — for browser-based games
- WebRTC DataChannels give you UDP-like unreliable/unordered delivery in browsers.
- WebTransport (over HTTP/3/QUIC) is the newer, cleaner option for browser games needing datagrams.

### TCP — only for non-real-time
- Fine for turn-based games, chat, inventory transactions, matchmaking, login flows.
- Bad for positional state.

---

## Application-Layer State Sync Patterns

### 1. Snapshot Interpolation (Valve / Source engine model)
- Server is authoritative, simulates the world at a fixed tick rate (e.g., 64Hz).
- Server sends periodic **snapshots** of all relevant entity state to each client.
- Clients render 100–200ms in the past, **interpolating** between two received snapshots for smooth motion.
- Delta-compressed: only send fields that changed since last ACK'd snapshot.
- **Best for**: FPS, competitive games where consistency matters.

### 2. State Replication / Property Replication (Unreal Engine model)
- Actors on the server mark properties as "replicated."
- Engine automatically diffs and sends only changed properties, with per-property reliability semantics (`Reliable`, `Unreliable`, `RepNotify`).
- Uses **relevancy filtering** — you only get updates about entities near you (network culling).
- **Best for**: Large open worlds, MMOs, battle royales.

### 3. Lockstep / Deterministic Simulation (RTS model)
- Only **inputs** are sent over the wire, not state. Every client deterministically simulates the same world.
- Extremely bandwidth-efficient (send commands, not positions).
- Requires bit-perfect determinism across platforms — brutally hard to maintain.
- **Best for**: RTS (StarCraft, AoE), fighting games with rollback (GGPO, Guilty Gear Strive).

### 4. Event-Based / RPC Messaging
- Fire-and-forget or reliable RPCs for discrete actions ("player fired weapon," "door opened").
- Usually layered on top of state sync for one-shot events that don't fit the continuous-state model.

---

## Serialization Format on the Wire

| Format | Use Case | Notes |
|---|---|---|
| **Custom bit-packed binary** | Hot-path gameplay state | Quantize floats, pack booleans into bitfields — 5–20x savings |
| **FlatBuffers / Cap'n Proto** | Structured messages, zero-copy | Good if you want structure without a parse step |
| **Protobuf** | Lobby / matchmaking / RPC | Varint encoding not ideal for floats |
| **MessagePack / CBOR** | Occasional use | Usually beaten by hand-tuned binary |
| **JSON** | Debug telemetry only | Avoid on the hot path |

---

## Practical Techniques Layered On Top

- **Delta compression** against last-acknowledged baseline
- **Quantization** (positions to fixed-point, quaternions with smallest-three)
- **Priority accumulator** — send updates for important/nearby entities more often
- **Client-side prediction** — client simulates local player immediately, reconciles when server disagrees
- **Lag compensation** — server rewinds world state to when client fired to validate hits
- **Area of interest / relevancy** — don't send state for entities the player can't see

---

## Deep Dive: Snapshot Packet Layout Example

Here's a realistic bit-level layout for a server → client snapshot in a competitive FPS running at 64Hz with ~30 relevant entities per player.

### High-level packet structure

```
+------------------------------------------------------------+
| UDP Header (8 bytes)                                       |
+------------------------------------------------------------+
| Custom Transport Header (4 bytes)                          |
|   - Sequence number         (16 bits)                      |
|   - ACK of last recv        (16 bits)                      |
|   - ACK bitfield (32 bits)  — for last 32 packets recv'd   |
+------------------------------------------------------------+
| Snapshot Header (variable, ~4 bytes)                       |
|   - Server tick             (32 bits)                      |
|   - Baseline tick (delta ref) (16 bits)                    |
|   - Entity count            (10 bits)                      |
+------------------------------------------------------------+
| Entity Deltas (repeating, variable width)                  |
|   For each changed entity:                                 |
|     - Entity ID              (14 bits)                     |
|     - Change bitmask         (N bits, one per property)    |
|     - Only changed fields... (quantized)                   |
+------------------------------------------------------------+
| Event Section (optional)                                   |
|   - Event count              (6 bits)                      |
|   - [event_type, payload]... (variable)                    |
+------------------------------------------------------------+
| Trailing padding to byte boundary                          |
+------------------------------------------------------------+
```

### Example entity delta — a player

Assume a player entity has these replicated fields:

| Field | Full precision | Quantized bits | Notes |
|---|---|---|---|
| position.x | float32 (32 bits) | 16 bits | Fixed-point, ±2048m, ~6cm precision |
| position.y | float32 (32 bits) | 16 bits | Same |
| position.z | float32 (32 bits) | 12 bits | Vertical range is smaller |
| yaw | float32 (32 bits) | 12 bits | 0–360° → ~0.09° precision |
| pitch | float32 (32 bits) | 10 bits | ±90° → ~0.18° precision |
| velocity | 3 × float32 (96 bits) | 3 × 12 = 36 bits | Quantized |
| health | uint16 (16 bits) | 8 bits | 0–255 |
| ammo | uint16 (16 bits) | 8 bits | Per active weapon |
| animation state | enum | 6 bits | 64 states |
| is_crouched | bool | 1 bit | |
| is_firing | bool | 1 bit | |
| weapon_id | enum | 6 bits | |

**Total naive**: ~272 bits (34 bytes) per full entity
**Total quantized**: ~132 bits (~17 bytes) per full entity
**With delta compression** (typically only 2–4 fields change per tick): often **3–6 bytes** per entity update

### Bandwidth math

- 30 relevant entities × ~5 bytes avg delta = **150 bytes/tick payload**
- Plus ~15 bytes of headers = **~165 bytes/packet**
- At 64Hz: **~10.5 KB/s downstream per client** (~84 kbps)

That's the bandwidth Counter-Strike-tier games actually run on. The bit-packing and delta compression are the difference between "works on any connection" and "unplayable."

### Reliability strategy inside snapshots

- Snapshots themselves are **unreliable** — if one drops, the next one supersedes it.
- ACK bitfield in the transport header tells the server which of the last 32 sequence numbers the client has received.
- Server uses ACKs to know which baseline to delta-compress against.
- Discrete events (kills, pickups, chat) ride in the event section with their own reliable-in-order sub-protocol (retransmit until ACK'd, sequence-numbered).

---

## Deep Dive: Unreal vs. Custom Engine State Sync

### Unreal Engine's Replication System

**Model**: Declarative property replication on top of a client-server actor model.

**How it works**:
- You mark UPROPERTYs with `Replicated` or `ReplicatedUsing=OnRep_Function`.
- The engine's `NetDriver` iterates actors each net-update tick, checks a **relevancy** function (default: distance + line of sight hooks), and builds a list of actors to update per connection.
- For each relevant actor, it diffs replicated properties against the last-ACK'd state for that connection and serializes only the changes.
- Reliable RPCs (`Server`, `Client`, `NetMulticast`) are layered on top for discrete events.
- Uses a **bunch/channel** abstraction — each actor gets a channel, bunches are the delta payloads, packed into UDP packets.

**Strengths**:
- Massive productivity win — designers and gameplay programmers rarely touch the network layer.
- Battle-tested at scale (Fortnite, Gears, Valorant-adjacent tech).
- Rich tooling: replication graph, dormancy, sub-object replication, iris (new replication system in UE 5.x).
- Built-in relevancy, prioritization, and bandwidth throttling per connection.

**Weaknesses**:
- Opinionated. If your game doesn't fit the "actor with replicated properties" model (e.g., voxel worlds, huge particle sims, non-Euclidean space), you fight the engine.
- Bandwidth overhead vs. hand-tuned custom: Unreal's per-property metadata (property handles, bunch headers) costs bits you wouldn't spend in a bespoke protocol.
- Debugging deep replication issues requires understanding a lot of engine internals (`NetSerialize`, `PreReplication`, `FastArraySerializer`, replication graph nodes).
- Historically not deterministic — bolt-on rollback is hard.

**When to pick it**: You're building a shooter, action game, or open-world game with a team that ships in months, not years. You want to focus on gameplay, not netcode. You're OK with the C++/BP paradigm.

### Custom / Bespoke Netcode

**Model**: You write the transport, serialization, replication model, and reliability layer from scratch (or with libraries like yojimbo, GameNetworkingSockets, ENet, or libdatachannel).

**How it typically works**:
- Fixed-tick authoritative server simulation.
- Hand-authored packet formats (like the snapshot layout above).
- Custom entity component system with per-component serialization functions.
- You explicitly decide relevancy, priority, quantization per game.
- Reliability layered where needed (sequence + ACK bitfield for snapshots; reliable-ordered channels for events).

**Strengths**:
- **Bandwidth**: You can beat Unreal's efficiency by 2–5x because you know exactly which bits matter for *your* game.
- **Determinism**: If you want lockstep or rollback (fighting games, RTS, competitive esports), you basically must roll your own.
- **Platform reach**: Console, mobile, browser, dedicated Linux server all treated equally.
- **Predictable performance**: No hidden engine costs; you own the CPU budget.
- Custom protocols enable exotic patterns — eventual consistency, CRDTs, deterministic rollback, area-of-interest sharding.

**Weaknesses**:
- **Time cost**: 6–24 months of engineering before you have parity with what Unreal ships out of the box.
- **Bug surface**: Reliability, ordering, congestion, encryption, MTU discovery, NAT traversal, DDOS mitigation — all yours to own.
- **Tooling**: You build your own network profilers, replay systems, packet inspectors.
- **Hiring**: Fewer engineers know your stack.

**When to pick it**: You're building a fighting game with rollback (Skullgirls, Guilty Gear Strive), a competitive esport where every bit matters (Rocket League famously wrote custom netcode on top of Unreal), an RTS with lockstep (StarCraft II, AoE 4), an MMO with a custom entity model (EVE Online, Star Citizen), or a browser game where you need WebTransport/WebRTC.

### Side-by-side comparison

| Dimension | Unreal Replication | Custom Netcode |
|---|---|---|
| **Time to first playable** | Days | Months |
| **Bandwidth efficiency** | Good | Best possible |
| **Determinism** | Hard to add | Design it in |
| **Rollback support** | Painful | Feasible |
| **Debugging** | Engine-assisted, but deep | You built it, you know it |
| **Team size needed** | Small (1–2 net eng) | Larger (3–5+ net eng) |
| **Platform flexibility** | UE-supported platforms | Anything you port to |
| **Best fit** | AAA action, open-world | Fighting, RTS, esports, MMO, browser |

### Hybrid approach (common in shipped games)

Many shipped titles use **Unreal for actors + a custom subsystem for a specific need**:
- Rocket League: Unreal + custom physics + custom replication for ball/car state.
- Sea of Thieves: Unreal + custom ship-authority handoff.
- Fortnite: Unreal, but with heavy custom work in the replication graph and Iris for scale.

If you're not sure, **start with Unreal, replace subsystems you outgrow**.

---

## Deep Dive: Client-Side Prediction Explained

Client-side prediction is the technique that makes a networked game feel responsive despite 30–150ms of round-trip latency. Without it, every keypress would have a visible delay before the character reacts. It's non-negotiable for anything twitchy.

### The core problem

The server is authoritative. If the client just waits for the server to say "you moved forward," the loop is:

```
t=0ms    Client presses W
t=50ms   Server receives input
t=50ms   Server simulates, moves player forward
t=100ms  Client receives new position, renders it
```

**100ms of input lag** on a good connection. Feels awful.

### The prediction fix

The client runs the **same simulation code as the server**, immediately, on local input. It optimistically shows the result. Later, when the server's authoritative state arrives, the client reconciles.

```
t=0ms    Client presses W
         → Client immediately simulates: moves player forward, renders it
         → Client sends input to server, tagged with input sequence #42
t=50ms   Server receives input #42, simulates it, updates authoritative state
t=100ms  Client receives server snapshot: "as of input #42, you are at (x,y,z)"
         → Client compares to its own predicted state at input #42
         → If they match: done, no visible correction
         → If they differ: reconcile
```

The player perceives **zero input lag** for their own actions in the happy path.

### The state buffer and input buffer

The client maintains two ring buffers:

**Input buffer** — every input the client has sent, tagged with a monotonically increasing sequence number, kept until the server ACKs it.

```
Input #40: {tick=1000, forward, jump}    [ACK'd by server]
Input #41: {tick=1001, forward}          [pending]
Input #42: {tick=1002, forward, fire}    [pending]
Input #43: {tick=1003, forward}          [pending]
```

**Predicted state buffer** — for each input applied, the resulting simulated state.

```
After #41: pos=(10.0, 0, 0), vel=(5,0,0)
After #42: pos=(10.5, 0, 0), vel=(5,0,0), ammo=29
After #43: pos=(11.0, 0, 0), vel=(5,0,0)
```

### Reconciliation (server correction)

When a server snapshot arrives, it says something like: *"After processing input #42, your authoritative position is (10.4, 0, 0)."*

The client:

1. Looks up its predicted state after #42 → `(10.5, 0, 0)`.
2. Compares. Difference is 0.1m — outside a tolerance threshold.
3. **Snaps** its local state to the server's authoritative state at #42: `(10.4, 0, 0)`.
4. **Re-simulates forward** by replaying inputs #43, #44, #45 (any inputs newer than what the server ACK'd) against the corrected state.
5. Ends up with a corrected "now" state.

If the delta is small enough, the player never notices. If it's large (e.g., they got shoved by a rocket the client didn't know about), you get a visible correction — sometimes called a **"rubber band"** or **"snap."** Good games smooth this with a short interpolation (over 100–200ms) rather than an instant teleport.

### Pseudocode: client tick loop

```pseudo
on every client tick:
    input = read_local_input()
    input.sequence = next_sequence++
    input.client_tick = current_tick

    # 1. Send input to server (unreliable, but include a few recent inputs
    #    to survive packet loss)
    send_to_server([last_3_inputs, input])

    # 2. Locally predict
    apply_input(predicted_state, input)
    input_buffer.push(input)
    predicted_state_buffer.push(current_tick, predicted_state.clone())

    # 3. Render the predicted state (with interpolation smoothing for remote entities)
    render(predicted_state)

on server snapshot received:
    server_state, last_acked_input_seq = snapshot

    # Discard ACK'd inputs
    input_buffer.discard_up_to(last_acked_input_seq)

    # Find our predicted state at that same input sequence
    my_predicted = predicted_state_buffer.at(last_acked_input_seq)

    if distance(my_predicted, server_state) > TOLERANCE:
        # Misprediction — reconcile
        predicted_state = server_state

        # Replay all inputs newer than the server's ACK
        for input in input_buffer:  # these are all still-pending
            apply_input(predicted_state, input)
    else:
        # Prediction was correct, do nothing
        pass
```

### What can and can't be predicted

**Safe to predict**:
- Your own player's movement (deterministic given input)
- Your own weapon firing animation and muzzle flash
- Your own item pickups (with server confirmation)
- Local physics you have authority over

**Don't predict** (or predict very carefully):
- Other players' movement — you don't have their inputs. Use **interpolation** instead (render them in the past, tween between snapshots).
- Damage / hit confirmation — server must decide. Predict the animation, but wait for server for the "kill" event.
- Anything involving randomness the server owns.
- Anything requiring global state you don't have.

### Common pitfalls

- **Non-deterministic simulation** — if your movement code uses different math on client and server (float ordering, physics engine RNG, frame-rate-dependent integration), predictions will always be slightly off. Fix determinism at the source.
- **Prediction of things you can't predict** — trying to predict other players' movement leads to constant snap-back. Use interpolation with a fixed delay buffer.
- **Not accounting for authority handoff** — if the server can push you around (knockback, teleporters, forced movement), your client's replay assumes YOU moved you, and misreconciles. The server must send a "you were forcibly moved, discard predictions up to tick N" flag.
- **Reconciliation snaps that are too jarring** — smooth corrections over 100–200ms unless the delta is enormous.
- **Input loss** — if inputs drop, the server might process #40, #42, #44 without #41 and #43. Send a small window of recent inputs in every packet as redundancy.

### Related techniques

- **Interpolation** (for remote entities): Render remote players ~100ms in the past, tween between two received snapshots. Costs a little visible lag on remote objects, buys smoothness.
- **Extrapolation** (rare, dangerous): Predict remote entities forward from last known velocity when snapshots are late. Prone to visible corrections. Most games avoid it.
- **Lag compensation** (server-side complement): When a client fires, server rewinds the world to the state the client saw when they clicked, checks the hit there. Pairs with prediction to make hitscan weapons feel fair.
- **Rollback netcode** (fighting games): A stronger form of prediction where the client predicts *remote* player inputs too, then rolls back and re-simulates when actual inputs arrive. Requires strict determinism and short rollback windows (~7 frames).

---

## Recommended Reading

- **Glenn Fiedler's "Gaffer On Games"** — the canonical resource for building netcode from scratch. Especially the "Networked Physics" and "Networking for Game Programmers" series.
- **Valve's "Source Multiplayer Networking"** — wiki article covering snapshot interpolation, lag compensation, prediction.
- **Unreal Engine networking documentation** — property replication, RPCs, replication graph, Iris.
- **Overwatch's GDC talk** — "Networking Scripted Weapons and Abilities" is one of the best real-world case studies published.
- **"1500 Archers on a 28.8"** — the classic Age of Empires postmortem on lockstep networking.
- **GGPO / rollback netcode papers** — for fighting games and any game where determinism + prediction combine.
- **Yojimbo / GameNetworkingSockets source code** — production-quality reference for reliable UDP.

---

## TL;DR

**UDP transport + authoritative server + tick-based delta-compressed snapshots + client-side prediction + interpolation** is the workhorse pattern. Bit-pack your payloads. Use RPCs for discrete events. Use Unreal if you want to ship fast; roll custom if you need determinism, rollback, browser reach, or extreme bandwidth efficiency.
