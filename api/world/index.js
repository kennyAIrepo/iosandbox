/**
 * hopeOS — list published worlds (the communal public library).
 * GET /api/world  → { worlds: [{ name, url, size, uploadedAt }] } newest first.
 * Anyone, on any device, sees every world that was published to the cloud.
 * (Private drafts are NOT here — they live locally in each creator's browser
 * until they explicitly Publish.)
 */
import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  try {
    const { blobs } = await list({ prefix: 'worlds/', limit: 1000 });
    const worlds = blobs
      .filter(b => b.pathname.endsWith('.json'))
      .map(b => ({
        name: b.pathname.replace(/^worlds\//, '').replace(/\.json$/, ''),
        url: b.url,
        size: b.size,
        uploadedAt: b.uploadedAt,
      }))
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.setHeader('cache-control', 'public, max-age=5');   // newly published worlds appear in the graph quickly
    res.status(200).json({ worlds });
  } catch (e) {
    res.status(502).json({ error: 'blob list error: ' + e.message });
  }
}
