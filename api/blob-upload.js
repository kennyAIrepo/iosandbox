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
import { blobToken, ensureBlobEnv } from './_blob.js';

export default async function handler(req, res) {
  // Health check so the client can report the REAL reason if uploads fail.
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, hasToken: !!blobToken() });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST' }); return; }
  if (!ensureBlobEnv()) {     // make the SDK see BLOB_READ_WRITE_TOKEN even if the var is named differently
    res.status(500).json({ error: 'no Vercel Blob token on the server — connect a Blob store to THIS project and REDEPLOY' });
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
