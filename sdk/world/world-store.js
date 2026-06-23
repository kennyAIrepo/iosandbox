/**
 * hopeOS SDK — World Store (save / load built worlds)
 * ═══════════════════════════════════════════════════════════════
 * Persists a whole built world as a snapshot: the base scene + every object
 * (its source GLB url / primitive type + colour + world transform) + the avatar
 * spawn & look. Two layers, one shape:
 *
 *   • LIBRARY  — IndexedDB on this machine. Survives reloads, lists instantly,
 *     reopens on click. This is what the "build your own world" section shows as
 *     saved-world cards you click to drop back in and keep building.
 *   • DISK     — exportFile() writes a self-contained <name>.hopeworld.json to
 *     your downloads (uploaded base scenes are embedded as a data URL so the file
 *     stands alone); importFile() reads one back in.
 *
 * Browser reality: a sandboxed page can't silently write to an arbitrary folder.
 * IndexedDB IS local persistent storage; exportFile/importFile bridge to real
 * files. (Cloud per-user sync swaps in behind this same API later.)
 *
 * Snapshot shape:
 *   { name, createdAt, updatedAt,
 *     base:   { source:'sketchfab'|'url'|'upload'|'default', url?, uid?, blob?, autoScale, targetSpan },
 *     avatar: { spawn:[x,y,z], yaw, pitch },
 *     objects:[ { label, kind:'import'|'primitive', url?, ptype?, color?, position, rotationDeg, scale } ] }
 */

const DB = 'hopeOS-worlds', STORE = 'worlds', VER = 1;

function _open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// One db op per call — request issued synchronously inside the transaction.
function _do(mode, fn) {
  return _open().then(db => new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    tx.oncomplete = () => db.close();
  }));
}

function _blobToDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}

export const WorldStore = {
  /** Save/replace a world in the local library (keyed by name). */
  async saveWorld(rec) {
    rec.updatedAt = Date.now();
    rec.createdAt = rec.createdAt || rec.updatedAt;
    await _do('readwrite', st => st.put(rec));
    return rec;
  },

  /** All saved worlds, newest first (metadata + full record). */
  async listWorlds() {
    const all = await _do('readonly', st => st.getAll()).catch(() => []);
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  loadWorld(name) { return _do('readonly', st => st.get(name)); },
  deleteWorld(name) { return _do('readwrite', st => st.delete(name)); },

  /** A name that won't clobber an existing different world (adds " 2", " 3", …). */
  async uniqueName(base) {
    const all = await this.listWorlds().catch(() => []);
    const names = new Set(all.map(w => w.name));
    if (!names.has(base)) return base;
    let n = 2; while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  },

  /** A JSON-safe, self-contained record (for .json export OR cloud publish).
   *  Object blobs (uploaded local GLBs) can't be JSON-serialised, so they're
   *  dropped (Sketchfab/URL objects survive); an uploaded BASE scene is embedded
   *  as a data URL so the record stands alone anywhere. */
  async toPortable(rec) {
    let out = { ...rec };
    if (out.objects) out.objects = out.objects.map(({ blob, ...rest }) => rest);
    if (rec.base && rec.base.blob) {
      const data = await _blobToDataURL(rec.base.blob);
      out.base = { ...rec.base, blob: undefined, blobData: data, blobName: rec.base.blob.name || 'scene.glb' };
    }
    return out;
  },

  /** Rebuild a live record from a portable one (recreates the base blob). */
  async fromPortable(rec) {
    if (rec.base && rec.base.blobData) {
      rec.base.blob = await (await fetch(rec.base.blobData)).blob();
      delete rec.base.blobData;
    }
    return rec;
  },

  /** Write a self-contained <name>.hopeworld.json to the user's downloads. */
  async exportFile(rec) {
    const out = await this.toPortable(rec);
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (rec.name || 'world').replace(/[^\w-]+/g, '_') + '.hopeworld.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },

  /** Read a .hopeworld.json File back into a record (rebuilds the base blob). */
  async importFile(file) {
    return this.fromPortable(JSON.parse(await file.text()));
  },
};

export default WorldStore;
