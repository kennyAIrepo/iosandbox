/**
 * hopeOS — resolve the Vercel Blob read/write token, however it's named.
 *
 * Connecting a Blob store normally injects BLOB_READ_WRITE_TOKEN, but with a custom
 * name or MULTIPLE stores the variable can be named differently (e.g.
 * <STORE>_READ_WRITE_TOKEN). Every Blob token VALUE starts with "vercel_blob_rw_",
 * so we fall back to scanning env values — making the API work regardless of the
 * exact variable name (one store or several).
 *
 * (Files starting with "_" under /api are NOT exposed as routes — this is a helper.)
 */
export function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const v of Object.values(process.env)) {
    if (typeof v === 'string' && v.startsWith('vercel_blob_rw_')) return v;
  }
  return null;
}

/** Ensure the SDK's default env var is set (it reads BLOB_READ_WRITE_TOKEN internally). */
export function ensureBlobEnv() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const t = blobToken();
    if (t) process.env.BLOB_READ_WRITE_TOKEN = t;
    return !!t;
  }
  return true;
}
