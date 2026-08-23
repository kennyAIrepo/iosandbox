/**
 * hopeOS dev server — serves the repo root on http://localhost:3333
 *
 *   npm run serve        (or: node tools/dev-server.mjs [port])
 *
 * Why needed at all (the site is static): browsers block BOTH camera
 * access (getUserMedia needs a secure context — localhost counts, file://
 * does not) and ES-module imports on file:// pages. Every lab page
 * therefore needs an http origin locally. This is the same server the
 * headless probes (tests/_*probe.mjs) expect on :3333.
 *
 * Explicit MIME map because Windows' registry-based type guessing serves
 * .js as text/plain, which breaks module loading.
 */
import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = parseInt(process.argv[2]) || 3333;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.onnx': 'application/octet-stream', '.task': 'application/octet-stream',
  '.npy': 'application/octet-stream', '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // ── session journal: lab pages POST activity batches (drags, clicks,
    // annotations, script edits) as JSONL; Claude reads the file to "see"
    // the live session. Append-only, repo root, gitignored.
    if (req.method === 'POST' && p === '/journal') {
      let body = '';
      for await (const c of req) body += c;
      const lines = JSON.parse(body).map(e => JSON.stringify(e)).join('\n');
      await appendFile(join(ROOT, 'riglab.journal.jsonl'), lines + '\n');
      res.writeHead(204).end();
      return;
    }
    if (p === '/') p = '/index.html';
    if (!extname(p)) p += '.html';                     // vanity routes like /signlab
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // no-store on code: without this, browsers heuristically cache ES
      // modules and a normal reload keeps serving STALE JS after edits —
      // which silently masks fixes (bit us on the hand-slot fix rollout)
      ...(['.js', '.mjs', '.html', '.json', '.css'].includes(ext)
        ? { 'cache-control': 'no-store' } : {})
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(
  `hopeOS dev server → http://localhost:${PORT}\n` +
  `  signlab: http://localhost:${PORT}/signlab.html`));
