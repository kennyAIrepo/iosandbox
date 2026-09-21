/**
 * tools/sandbox-proxy.mjs — local dev proxy: serves /api/claude, /api/openai and /api/sketchfab on
 * http://localhost:3334 by mounting the repo's OWN Vercel handlers (api/claude.js, api/openai.js, api/sketchfab.js), so a
 * page on `npm run serve` (:3333, static only — tools/dev-server.mjs has no /api route) can talk to Claude + Whisper +
 * Sketchfab.
 *
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... SKETCHFAB_TOKEN=... node tools/sandbox-proxy.mjs
 *   then: new CommandAgent({ endpoint: 'http://localhost:3334/api/claude', ... })
 *         new VoiceCommander('', { endpoint: 'http://localhost:3334/api/openai', ... })
 *         new ModelFetcher({ endpoint: 'http://localhost:3334/api/sketchfab' })       // sdk/game/model-fetch.js (B4)
 *
 * All handlers are plain (req, res) functions that read only process.env (api/claude.js:8-34,
 * api/openai.js:19-47, api/sketchfab.js). They expect a Vercel-style `res` (status().json(), setHeader, send) and, for
 * claude.js, a pre-parsed `req.body` / for sketchfab.js a `req.query`; the shim below provides exactly that and nothing else.
 * /api/sketchfab keeps api/sketchfab.js's query contract: ?op=search&q=&count=&downloadable=&sort=&cursor= (works with NO
 * token) and ?op=resolve&uid= (needs SKETCHFAB_TOKEN). One dev-only extra: ?op=fetch&url=<resolved glb url> streams the
 * GLB through this process for the case where Sketchfab's temporary S3 link refuses the browser's CORS preflight
 * (hosts limited to sketchfab.com / amazonaws.com / cloudfront.net).
 * CORS allows only the dev page origin (http://localhost:3333, override HOPEOS_CORS) because it differs from this proxy (:3334).
 */
import { createServer } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = process.env.HOPEOS_REPO || fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');   // tools/ -> the repo root
const PORT = parseInt(process.argv[2]) || 3334;
const ALLOWED_ORIGINS = (process.env.HOPEOS_CORS || 'http://localhost:3333,http://127.0.0.1:3333').split(',');
const FETCH_HOSTS = /(^|\.)(sketchfab\.com|amazonaws\.com|cloudfront\.net)$/i;
const claude = (await import(pathToFileURL(REPO + '/api/claude.js').href)).default;
const openai = (await import(pathToFileURL(REPO + '/api/openai.js').href)).default;
const sketchfab = (await import(pathToFileURL(REPO + '/api/sketchfab.js').href)).default;

function vercelRes(res) {                        // the subset of Vercel's response helpers the handlers use
  const shim = {
    status(code) { res.statusCode = code; return shim; },
    setHeader(k, v) { res.setHeader(k, v); return shim; },
    json(obj) { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); },
    send(body) { res.end(body); },
    end(body) { res.end(body); },
  };
  return shim;
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
/** Dev-only GLB passthrough (?op=fetch&url=): stream a resolved Sketchfab download link through this origin. */
async function fetchThrough(target, res) {
  let u;
  try { u = new URL(target); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad url' })); return; }
  if (u.protocol !== 'https:' || !FETCH_HOSTS.test(u.hostname)) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'host not allowed for op=fetch' })); return; }
  const r = await fetch(u);
  const headers = { 'content-type': r.headers.get('content-type') || 'model/gltf-binary' };
  const len = r.headers.get('content-length'); if (len) headers['content-length'] = len;
  res.writeHead(r.status, headers);
  if (!r.body) { res.end(); return; }
  for await (const chunk of r.body) res.write(chunk);
  res.end();
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  res.setHeader('access-control-allow-origin', origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);   // the page on npm run serve (:3333)
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'content-type, x-audio-type, x-model, x-language');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/claude') {
      const raw = await readBody(req);
      req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};   // claude.js forwards req.body as JSON (api/claude.js:26-27)
      await claude(req, vercelRes(res));
    } else if (url.pathname === '/api/openai') {
      req.body = await readBody(req);                                 // openai.js accepts a Buffer body (api/openai.js:10-17)
      await openai(req, vercelRes(res));
    } else if (url.pathname === '/api/sketchfab') {
      req.query = Object.fromEntries(url.searchParams);               // sketchfab.js reads req.query.{op,q,count,downloadable,sort,cursor,uid}
      if (req.query.op === 'fetch') await fetchThrough(req.query.url || '', res);
      else await sketchfab(req, vercelRes(res));
    } else {
      res.writeHead(404).end('not found');
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'proxy shim error: ' + e.message } }));
  }
}).listen(PORT, () => console.log(`sandbox proxy → http://localhost:${PORT}/api/{claude,openai,sketchfab}  (keys: ANTHROPIC_API_KEY=${!!process.env.ANTHROPIC_API_KEY}, OPENAI_API_KEY=${!!process.env.OPENAI_API_KEY}, SKETCHFAB_TOKEN=${!!process.env.SKETCHFAB_TOKEN})`));
