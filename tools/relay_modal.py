"""
relay_modal.py — the hosted twin of tools/relay-server.mjs: a Modal app ("hopeos-relay") that serves the SAME room
relay + session-clock protocol over a public wss:// URL, so two phones/laptops can share a room from a link instead of
someone running `npm run relay` on a LAN.

    py -m modal deploy tools/relay_modal.py        # profile kennyairep; prints https://<workspace>--hopeos-relay.modal.run
    node tests/relay-modal-smoke.mjs               # two ws clients against the deployed URL (or --local)

Protocol (byte-for-byte what tools/relay-server.mjs does — sdk/net/room.js and sdk/game/ball-net.js depend on it):
  * rooms are the URL path:  wss://<host>/room/<room>
  * on connect the server sends  {"hello": {"clientId", "room", "peers", "serverNow"}}  (room = the path string,
    peers = every clientId in the room including yours, serverNow = u32 ms since server start = the session clock);
    the other members get  {"joined": clientId};  on close they get  {"left": clientId}
  * clientId = "c-" + base36 counter zero-padded to 3 (lexically sortable: the lowest id in the roster is the host)
  * every BINARY frame is fanned out to the other sockets in the room unchanged (text frames are server -> client only),
    except CLOCK_PING (byte 0 == 0x01, >= 12 bytes) which is answered to the sender alone with a 20-byte CLOCK_PONG:
      [0]=0x02  [1]=ping[1]  [2..8)=ping[2..8) (seq + header t)  [8..12)=ping[8..12) (client t0)
      [12..16)=u32le server receive time  [16..20)=u32le server send time            (docs/teams/hopeos-wire.md, sync §3)

Why one container: room state is a plain in-process dict, so the whole relay must be ONE process — `max_containers=1`
plus `@modal.concurrent(max_inputs=500)` (one Modal input per WebSocket connection; up to 500 sockets share the
container). Parameter names verified against modal 1.5.3 on this box (`inspect.signature(modal.App.function)` lists
min_containers / max_containers / buffer_containers / scaledown_window; `modal.concurrent(*, max_inputs, target_inputs)`)
and https://modal.com/docs/guide/scale + https://modal.com/docs/guide/webhooks (2026-09-20): "WebSockets on Modal
maintain a single function call per connection", messages <= 2 MiB, no permessage-deflate.

Modal is the ASGI server here (no uvicorn process is started); uvicorn[standard] is installed so the same file also runs
locally for debugging:   py -m uvicorn tools.relay_modal:local_app --port 8787
"""
import struct
import time

import modal

APP_NAME = "hopeos-relay"
PK_CLOCK_PING = 0x01
PK_CLOCK_PONG = 0x02

image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi>=0.115", "uvicorn[standard]>=0.30")
app = modal.App(APP_NAME)


def build_asgi():
    """Create the FastAPI app with its in-process room table (one per container == one per relay)."""
    from fastapi import FastAPI, WebSocket
    from fastapi.responses import JSONResponse, PlainTextResponse

    t0 = time.monotonic()

    def server_now() -> int:            # u32 ms since server start = the session clock (wraps like the JS `>>> 0`)
        return int((time.monotonic() - t0) * 1000) & 0xFFFFFFFF

    rooms: dict[str, dict[str, WebSocket]] = {}      # path -> {clientId: socket}
    counter = {"next": 1}
    stats = {"connections": 0, "frames": 0, "pings": 0}

    def next_client_id() -> str:
        n = counter["next"]
        counter["next"] += 1
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"
        s = ""
        while n:
            s = digits[n % 36] + s
            n //= 36
        return "c-" + (s or "0").rjust(3, "0")

    web = FastAPI(title=APP_NAME)

    @web.get("/", response_class=PlainTextResponse)
    async def index():
        return "teams-football relay\n"

    @web.get("/health")
    async def health():
        return JSONResponse({
            "app": APP_NAME, "serverNow": server_now(), "uptimeMs": int((time.monotonic() - t0) * 1000),
            "rooms": {k: sorted(v.keys()) for k, v in rooms.items()}, "stats": stats,
        })

    async def fan_out(peers: dict[str, WebSocket], sender: str, payload, *, binary: bool):
        dead = []
        for cid, sock in list(peers.items()):
            if cid == sender:
                continue
            try:
                if binary:
                    await sock.send_bytes(payload)
                else:
                    await sock.send_text(payload)
            except Exception:
                dead.append(cid)
        for cid in dead:
            peers.pop(cid, None)

    @web.websocket("/room/{room}")
    async def room_socket(ws: WebSocket, room: str):
        import json

        await ws.accept()
        path = ws.scope.get("path") or f"/room/{room}"      # the JS relay keys rooms by req.url; hello.room carries the same string
        peers = rooms.setdefault(path, {})
        client_id = next_client_id()
        peers[client_id] = ws
        stats["connections"] += 1
        await ws.send_text(json.dumps({"hello": {"clientId": client_id, "room": path, "peers": list(peers.keys()), "serverNow": server_now()}}))
        await fan_out(peers, client_id, json.dumps({"joined": client_id}), binary=False)
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                buf = msg.get("bytes")
                if buf is None:                                 # text frames are control, server -> client only
                    continue
                stats["frames"] += 1
                if len(buf) >= 12 and buf[0] == PK_CLOCK_PING:
                    t1 = server_now()
                    pong = bytearray(20)
                    pong[0] = PK_CLOCK_PONG
                    pong[1] = buf[1]
                    pong[2:8] = buf[2:8]                         # echo seq + header t
                    pong[8:12] = buf[8:12]                       # t0 (client local send)
                    struct.pack_into("<I", pong, 12, t1)
                    struct.pack_into("<I", pong, 16, server_now())   # t2
                    stats["pings"] += 1
                    await ws.send_bytes(bytes(pong))
                    continue
                await fan_out(peers, client_id, buf, binary=True)   # the client's seq does newest-wins
        except Exception:
            pass                                                # WebSocketDisconnect / transport errors: fall through to cleanup
        finally:
            if peers.get(client_id) is ws:
                peers.pop(client_id, None)
            await fan_out(peers, client_id, json.dumps({"left": client_id}), binary=False)
            if not peers:
                rooms.pop(path, None)

    return web


@app.function(image=image, max_containers=1, scaledown_window=600)
@modal.concurrent(max_inputs=500)
@modal.asgi_app(label=APP_NAME)
def web():
    return build_asgi()


# local debugging only (needs `pip install fastapi uvicorn[standard]`): py -m uvicorn tools.relay_modal:local_app --port 8787
def __getattr__(name):
    if name == "local_app":
        return build_asgi()
    raise AttributeError(name)
