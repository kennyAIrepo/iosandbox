/**
 * hopeOS — Sketchfab proxy (model search + download-link resolve).
 * The browser calls /api/sketchfab?op=search&q=... or ?op=resolve&uid=...; this
 * function adds the secret token server-side. The token never reaches the browser.
 *
 * Env var: SKETCHFAB_TOKEN
 *
 * Note: ?op=resolve returns Sketchfab's temporary S3 .glb URL. The browser then
 * fetches that URL directly (it can be CORS-restricted) — for guaranteed imports
 * a direct .glb URL or a local upload is still the most reliable path.
 */
const API = 'https://api.sketchfab.com/v3';

export default async function handler(req, res) {
  const token = process.env.SKETCHFAB_TOKEN;
  const op = req.query.op;
  try {
    if (op === 'search') {
      const q = req.query.q || '';
      const limit = req.query.limit || 24;
      const url = `${API}/search?type=models&downloadable=true&archives_flavours=false&count=${limit}&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: token ? { Authorization: 'Token ' + token } : {} });
      res.status(r.status).json(await r.json());
    } else if (op === 'resolve') {
      if (!token) { res.status(500).json({ error: 'SKETCHFAB_TOKEN is not set on the server' }); return; }
      const uid = String(req.query.uid || '');
      const r = await fetch(`${API}/models/${encodeURIComponent(uid)}/download`, { headers: { Authorization: 'Token ' + token } });
      res.status(r.status).json(await r.json());
    } else {
      res.status(400).json({ error: 'unknown op (use search|resolve)' });
    }
  } catch (e) {
    res.status(502).json({ error: 'proxy error: ' + e.message });
  }
}
