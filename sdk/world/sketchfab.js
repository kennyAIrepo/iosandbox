/**
 * hopeOS SDK — Sketchfab grab
 * ═══════════════════════════════════════════════════════════════
 * Minimal asset discovery + import. Search returns ONLY a thumbnail and a uid —
 * no names, no license/free/downloadable badges, no metadata clutter. You click
 * a thumbnail and the model is fetched and dropped into the world.
 *
 * Download note: Sketchfab's download endpoint needs an API token AND the model
 * to be downloadable; the temporary file is served from S3, which can be
 * CORS-restricted in the browser. The reliable path that always works is a
 * direct .glb URL (also covers Meshy) — see importGLBFromURL on WorldTemplate.
 */

// All Sketchfab calls go through the hopeOS proxy so the token stays server-side.
// (The `token` params below are ignored — kept only for call-site compatibility.)
const PROXY = '/api/sketchfab';

/** Search → minimal [{ uid, thumb }] (downloadable models only). */
export async function searchModels(query, token = '', limit = 24) {
  const res = await fetch(`${PROXY}?op=search&limit=${limit}&q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(m => ({
    uid: m.uid,
    thumb: pickThumb(m.thumbnails),
  })).filter(x => x.thumb);
}

function pickThumb(thumbs) {
  const imgs = (thumbs && thumbs.images) || [];
  if (!imgs.length) return null;
  // a mid-size square-ish thumbnail
  const sorted = [...imgs].sort((a, b) => a.width - b.width);
  return (sorted.find(i => i.width >= 256) || sorted[sorted.length - 1]).url;
}

/** Resolve a downloadable GLB URL for a model uid (token added by the proxy). */
export async function resolveGLB(uid, token) {
  const res = await fetch(`${PROXY}?op=resolve&uid=${encodeURIComponent(uid)}`);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const d = await res.json();
  const link = (d.glb && d.glb.url) || (d.gltf && d.gltf.url);
  if (!link) throw new Error('no glb in response');
  return link;
}
