// Modal rig-lane wire check: connect, arm {cmd:'rig'}, feed frame_sample.jpg
// on a loop, watch for rigst -> rig_topo -> rig packets. First run includes
// cold start + weight download (budget 240s).
import { readFile } from 'node:fs/promises';
const URL = process.argv[2] || 'wss://kennyairepo--hopeos-rig-rig-web.modal.run/ws';
const jpeg = await readFile('./_frame_sample.jpg');

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';
let topo = null, rigs = 0, lastStatus = '', frames = 0, timer = null;

const send = () => {
  if (ws.readyState !== 1) return;
  const out = new ArrayBuffer(8 + jpeg.byteLength);
  new DataView(out).setFloat64(0, Date.now(), true);
  new Uint8Array(out, 8).set(jpeg);
  ws.send(out); frames++;
};
ws.onopen = () => {
  console.log(`[${el()}] WS open`);
  ws.send(JSON.stringify({ cmd: 'rig', on: 1 }));
  send();
  timer = setInterval(send, 3000);   // keep offering the latest frame
};
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.rigst && d.rigst !== lastStatus) { lastStatus = d.rigst; console.log(`[${el()}] rigst -> ${d.rigst}${d.err ? ' ERR ' + d.err : ''} (frames sent ${frames})`); }
  if (d.rig_topo && !topo) { topo = d.rig_topo; console.log(`[${el()}] RIG_TOPO: nv=${topo.nv} facesB64=${topo.faces.length} chars`); }
  if (d.rig) {
    rigs++;
    console.log(`[${el()}] RIG #${rigs}: seq=${d.rig.seq} id=${d.rig.id} nv=${d.rig.nv} vmin=[${d.rig.vmin}] vmax=[${d.rig.vmax}] qB64=${d.rig.q.length}ch cam_t=[${d.rig.cam_t}] focal=${d.rig.focal} box=[${d.rig.box}] iw=${d.rig.iw} ih=${d.rig.ih} infer_ms=${d.rig.ms} total_ms=${d.ms} cts_echo=${!!d.cts} body2D=${d.body2D ? d.body2D.length + 'kp' : 'none'}`);
    if (rigs >= 4) { console.log(`[${el()}] PASS — ${rigs} rig packets, nv=${d.rig.nv}`); clearInterval(timer); ws.close(); process.exit(0); }
  }
};
ws.onerror = (e) => console.log(`[${el()}] WS error:`, e.message || e);
ws.onclose = (e) => { console.log(`[${el()}] WS closed code=${e.code}`); clearInterval(timer); process.exit(rigs > 0 ? 0 : 1); };
setTimeout(() => { console.log(`[${el()}] TIMEOUT — status=${lastStatus} topo=${!!topo} rigs=${rigs}`); ws.close(); process.exit(1); }, 240000);
