/**
 * hopeOS — host a world's base GLB on Vercel Blob (raw bytes).
 *
 * The reliable path for publishing an UPLOADED local scene: the browser POSTs the
 * raw .glb bytes here and we `put()` them to Blob using the SAME BLOB_READ_WRITE_TOKEN
 * that the JSON publish already uses (no fragile client-token handshake). The world
 * JSON then stores just the returned public URL, so re-opening on any device imports
 * the model from that URL and replays the saved coordinates/scale.
 *
 * Raw bytes (not base64) avoid the ~33% data-URL inflation that caused HTTP 413, so
 * moderate scenes fit under Vercel's 4.5MB function-body limit. Bigger ones fall back
 * to a direct client upload (see /api/blob-upload).
 *
 *   POST /api/asset?name=<slug>   body = raw .glb  → { url }
 */
import { put } from '@vercel/blob';
import { blobToken } from './_blob.js';

export const config = { api: { bodyParser: false } };   // we need the raw binary stream

async function rawBuffer(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const token = blobToken();
  if (!token) {
    res.status(500).json({ error: 'no Vercel Blob token on the server — connect a Blob store to THIS project and REDEPLOY' });
    return;
  }
  try {
    const buf = await rawBuffer(req);
    if (!buf.length) { res.status(400).json({ error: 'empty body' }); return; }
    const name = String(req.query.name || 'scene').replace(/[^\w-]+/g, '_').slice(0, 60);
    const blob = await put(`world-assets/${name}.glb`, buf, {
      access: 'public',
      addRandomSuffix: true,
      contentType: req.headers['content-type'] || 'model/gltf-binary',
      token,
    });
    res.status(200).json({ url: blob.url });
  } catch (e) {
    const big = /payload|413|too large|exceeded/i.test(e.message || '');
    res.status(big ? 413 : 502).json({ error: 'asset upload error: ' + e.message });
  }
}
