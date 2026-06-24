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
  // Health / diagnostics so we can see EXACTLY what the deployment has. Safe — it
  // exposes env var NAMES that look blob-related (never their secret values) plus
  // which Vercel environment this function is running in.
  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      ok: true,
      hasToken: !!blobToken(),
      tokenValuePresent: Object.values(process.env).some(v => typeof v === 'string' && v.startsWith('vercel_blob_rw_')),
      blobEnvKeys: Object.keys(process.env).filter(k => /BLOB|READ_WRITE_TOKEN/i.test(k)),
      vercelEnv: process.env.VERCEL_ENV || null,
      // Which build is actually live — compare this to the latest pushed commit to
      // confirm the domain is serving the newest deployment (not a pinned old one).
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      buildMarker: 'v8-published-world-load',
    });
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
