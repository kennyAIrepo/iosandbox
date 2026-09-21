/**
 * relay-server.mjs — minimal room relay + session clock for the two-laptop test.
 * ─────────────────────────────────────────────────────────────────────────────
 *   npm i ws            (https://github.com/websockets/ws — `import { WebSocketServer } from 'ws'`,
 *                        `new WebSocketServer({ server })`, `wss.on('connection', (ws, req))`,
 *                        `ws.on('message', (data, isBinary))` — README verified 2026-09-18)
 *   node relay-server.mjs 8787
 *
 * Rooms are the URL path (ws://host:8787/room/demo). Every binary frame is
 * fanned out to the other sockets in the room unchanged, except CLOCK_PING
 * (0x01) which is answered with CLOCK_PONG (0x02) carrying the server's
 * receive/send times — the session clock (sync-protocol.md §3).
 *
 * Vercel cannot host this (no persistent sockets); run it on a laptop, a
 * Fly/Render/PartyKit box, or a Durable Object — MULTIPLAYER_SYNC_ARCHITECTURES.md §3/§5.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.argv[2] || 8787);
const PK_CLOCK_PING = 0x01, PK_CLOCK_PONG = 0x02;
const t0 = Date.now();
const serverNow = () => (Date.now() - t0) >>> 0;              // u32 ms since server start = the session clock

const rooms = new Map();                                      // path → Set<ws>
let nextClient = 1;

const http = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('teams-football relay\n'); });
const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws, req) => {
  const room = req.url || '/room/default';
  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);
  peers.add(ws);
  ws.clientId = 'c-' + (nextClient++).toString(36).padStart(3, '0');   // lexically sortable → lowest id = host
  ws.send(JSON.stringify({ hello: { clientId: ws.clientId, room, peers: [...peers].map(p => p.clientId), serverNow: serverNow() } }));
  for (const p of peers) if (p !== ws && p.readyState === p.OPEN) p.send(JSON.stringify({ joined: ws.clientId }));

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;                                     // control frames are server → client only
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length >= 12 && buf[0] === PK_CLOCK_PING) {
      const t1 = serverNow();
      const pong = Buffer.alloc(20);
      pong[0] = PK_CLOCK_PONG; pong[1] = buf[1];
      buf.copy(pong, 2, 2, 8);                                 // echo seq + header t
      buf.copy(pong, 8, 8, 12);                                // t0 (client local send)
      pong.writeUInt32LE(t1, 12);
      pong.writeUInt32LE(serverNow(), 16);                     // t2
      ws.send(pong);
      return;
    }
    for (const p of peers) if (p !== ws && p.readyState === p.OPEN) p.send(buf, { binary: true });   // fan-out; the client's seq does newest-wins
  });

  ws.on('close', () => {
    peers.delete(ws);
    for (const p of peers) if (p.readyState === p.OPEN) p.send(JSON.stringify({ left: ws.clientId }));
    if (!peers.size) rooms.delete(room);
  });
});

http.listen(PORT, () => console.log(`relay on ws://0.0.0.0:${PORT}/room/<name>`));
