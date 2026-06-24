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

/**
 * Search → { results:[{ uid, name, thumb, downloadable, faces, author }], next }.
 * `opts`: { count=24, cursor, sort, downloadable=true }. Pass the returned `next`
 * cursor back in to page through more results ("load more" / browse like Sketchfab).
 *
 * Back-compat: also accepts the old (query, token, limit) positional form and, in
 * that case, returns the bare results array.
 */
export async function searchModels(query, opts = {}, legacyLimit) {
  const legacy = typeof opts !== 'object' || opts === null;       // old (query, token, limit) call
  const o = legacy ? { count: legacyLimit || 24 } : opts;
  const p = new URLSearchParams({ op: 'search', q: query, count: String(o.count || 24) });
  if (o.cursor) p.set('cursor', o.cursor);
  if (o.sort) p.set('sort', o.sort);
  if (o.downloadable === false) p.set('downloadable', '0');
  const res = await fetch(`${PROXY}?${p.toString()}`);
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = await res.json();
  const results = (data.results || []).map(m => ({
    uid: m.uid,
    name: m.name || 'untitled',
    thumb: pickThumb(m.thumbnails),
    downloadable: m.isDownloadable !== false,
    faces: m.faceCount || 0,
    author: (m.user && (m.user.displayName || m.user.username)) || '',
  })).filter(x => x.thumb);
  return legacy ? results : { results, next: data.nextCursor || null };
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
