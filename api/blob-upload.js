/**
 * hopeOS — direct client-upload authoriser (fallback for BIG base GLBs).
 *
 * For scene GLBs larger than Vercel's 4.5MB function-body limit, the browser uploads
 * the file DIRECTLY to Vercel Blob and this route only mints the short-lived client
 * token (via @vercel/blob handleUpload). Smaller scenes use the simpler /api/asset
 * raw-bytes route instead.
 *
 *   GET  /api/blob-upload   → { ok, hasToken }   (health / diagnostics)
 *   POST /api/blob-upload   → client-token handshake
 */
import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  // Health check so the client can report the REAL reason if uploads fail.
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, hasToken: !!process.env.BLOB_READ_WRITE_TOKEN });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST' }); return; }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set — connect a Vercel Blob store to this project and redeploy' });
    return;
  }
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
