/**
 * hopeOS — client-side Blob upload authoriser.
 *
 * Large base GLBs (uploaded photogrammetry scenes, tens of MB) can't be embedded in
 * the publish JSON — Vercel serverless functions cap the request body at 4.5MB, so
 * embedding one returns HTTP 413. Instead the browser uploads the GLB DIRECTLY to
 * Vercel Blob (no such limit) and this route only mints the short-lived upload token.
 * The published world JSON then carries just the resulting public URL, staying tiny.
 *
 *   POST /api/blob-upload   (handshake from @vercel/blob/client `upload()`)
 */
import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const json = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['model/gltf-binary', 'model/gltf+json', 'application/octet-stream', 'application/json'],
        addRandomSuffix: true,
        maximumSizeInBytes: 300 * 1024 * 1024,   // 300MB headroom for big scene GLBs
      }),
      onUploadCompleted: async () => { /* nothing extra to record */ },
    });
    res.status(200).json(json);
  } catch (e) {
    res.status(400).json({ error: 'upload auth error: ' + e.message });
  }
}
