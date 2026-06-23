/**
 * hopeOS — published world store (Vercel Blob).
 * Each built world is published as a public, shareable URL: h0p3.io/world/<name>.
 *
 *   POST /api/world/<name>   body = the world snapshot JSON  → stores it, returns { url }
 *   GET  /api/world/<name>                                   → returns the stored snapshot JSON
 *
 * Storage: a Vercel Blob store (create one in the Vercel dashboard → Storage →
 * Blob, connect it to this project). Vercel auto-injects BLOB_READ_WRITE_TOKEN.
 */
import { put, list } from '@vercel/blob';

function slugify(name) {
  return String(name || '').trim().replace(/[^\w-]+/g, '_').slice(0, 80);
}

async function rawBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    return JSON.stringify(req.body);          // Vercel already parsed application/json
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  const name = slugify(req.query.name);
  if (!name) { res.status(400).json({ error: 'bad world name' }); return; }
  const path = `worlds/${name}.json`;

  try {
    if (req.method === 'POST') {
      const json = await rawBody(req);
      const blob = await put(path, json, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      });
      res.status(200).json({ ok: true, name, url: blob.url });
    } else if (req.method === 'GET') {
      const { blobs } = await list({ prefix: path, limit: 1 });
      const hit = blobs.find(b => b.pathname === path) || blobs[0];
      if (!hit) { res.status(404).json({ error: `world "${name}" not found` }); return; }
      const r = await fetch(hit.url);
      const text = await r.text();
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'public, max-age=60');
      res.status(200).send(text);
    } else {
      res.status(405).json({ error: 'GET or POST' });
    }
  } catch (e) {
    res.status(502).json({ error: 'blob error: ' + e.message });
  }
}
