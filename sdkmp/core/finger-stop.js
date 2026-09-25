/**
 * sdk/core/finger-stop.js — SKELETON-LEVEL hand contact.
 * ─────────────────────────────────────────────────────────────────────────────
 * The tracked fingers are stopped AT a prop's surface on the LANDMARKS, before
 * the hand is skinned: a finger joint inside the prop rotates its sub-chain about
 * the parent joint (bone lengths kept) until it sits on the skin, root → tip. The
 * mesh is then posed from stopped bones, so it keeps its THICKNESS — the way every
 * real-time hand does it (capsules per bone, a rigidly skinned visual hand whose
 * fingers are clamped at the surface). Per-vertex projection onto the shell — the
 * conform — flattens any finger whose axis is inside; after this it only ever sees
 * the last few millimetres.
 *
 *   fingerStop(query, pack, radii, skin, { palm: 'translate' | 'none', bisect })
 *     query(p, outN) → signed distance from p to the surface (< 0 inside); writes the outward normal
 *     pack           21 landmarks {x,y,z} — MUTATED in place (the packs the rigs pose from)
 *     radii          21 joint radii (m); skin = contact skin (m)
 *     palm           'translate': a palm joint inside moves the WHOLE hand out (the hand-stop, ≤ 3 passes);
 *                    'none': the palm is the caller's anchor (a carried ball sits on it) — left alone
 *     bisect         steps of the angle search per joint (default 10 → ~0.2°)
 *   → { fingers, palm, max }  joints rotated · metres the hand was translated · deepest penetration resolved
 *
 *   The rotation per joint: about the axis (bone × normal) — or any perpendicular
 *   when the finger points straight in — by the SMALLEST angle that puts the joint
 *   on the skin (bisection on the query, so it holds for any convex hull, not only
 *   a sphere), up to the angle that points the bone along the outward normal. A
 *   joint that cannot get out even then (its parent is buried) goes as far as it
 *   can; the distal joints ride every rotation and are fixed in turn.
 *
 *   sphereQuery(center, R)   a query for an exact sphere (any {x,y,z} center)
 *   Any PropHull works: (p, n) => hull.begin(obj).closest(p, null, n)
 */
import * as THREE from 'three';

/** finger chains, root first — the root is a palm joint and is never rotated */
export const FINGER_CHAINS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
export const PALM_JOINTS = [0, 1, 5, 9, 13, 17];

const _n = new THREE.Vector3(), _d0 = new THREE.Vector3(), _ax = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion();

export function sphereQuery(center, R) {
  return (p, outN) => {
    _t.set(p.x - center.x, p.y - center.y, p.z - center.z);
    const d = _t.length();
    if (outN) { if (d > 1e-9) outN.copy(_t).divideScalar(d); else outN.set(0, 1, 0); }
    return d - R;
  };
}

export function fingerStop(query, pack, radii, skin = 0.004, opts = {}) {
  const bisect = opts.bisect ?? 10, palmMode = opts.palm ?? 'translate';
  let fingers = 0, max = 0, palm = 0;
  if (!pack || !pack[0]) return { fingers, palm, max };
  // 1. the palm: a palm joint inside the prop moves the WHOLE hand out along the deepest contact normal
  //    (a second and third pass catch the joints whose own normal pointed elsewhere)
  if (palmMode === 'translate') for (let pass = 0; pass < 3; pass++) {
    let depth = 0;
    for (const i of PALM_JOINTS) {
      const q = pack[i]; if (!q) continue;
      const g = query(q, _n) - (radii ? radii[i] : 0) - skin;
      if (g < depth) { depth = g; _d0.copy(_n); }
    }
    if (depth >= 0) break;
    const push = -depth; palm += push;
    for (const q of pack) { if (!q) continue; q.x += _d0.x * push; q.y += _d0.y * push; q.z += _d0.z * push; }
    if (push > max) max = push;
  }
  // 2. each finger, root → tip: a joint inside rotates its sub-chain about the parent (length kept)
  for (const chain of FINGER_CHAINS) {
    for (let k = 1; k < chain.length; k++) {
      const j = chain[k], par = chain[k - 1];
      const J = pack[j], P = pack[par]; if (!J || !P) continue;
      const r = (radii ? radii[j] : 0) + skin;
      const g0 = query(J, _n) - r;
      if (g0 >= -1e-6) continue;
      if (-g0 > max) max = -g0;
      _d0.set(J.x - P.x, J.y - P.y, J.z - P.z);
      const L = _d0.length();
      if (L < 1e-5) {                                            // degenerate bone: slide the sub-chain out
        for (let m = k; m < chain.length; m++) { const q = pack[chain[m]]; if (!q) continue; q.x -= _n.x * g0; q.y -= _n.y * g0; q.z -= _n.z * g0; }
        fingers++; continue;
      }
      _d0.divideScalar(L);
      _ax.crossVectors(_d0, _n);
      if (_ax.lengthSq() < 1e-8) {                               // pointing straight in (or out): any perpendicular will do
        _ax.set(1, 0, 0).cross(_d0); if (_ax.lengthSq() < 1e-8) _ax.set(0, 1, 0).cross(_d0);
      }
      _ax.normalize();
      const thMax = Math.acos(Math.max(-1, Math.min(1, _d0.dot(_n))));   // this far, the bone points along the outward normal
      if (thMax < 1e-4) continue;                                // already pointing out: only its parent could help
      const gAt = (th) => { _q.setFromAxisAngle(_ax, th); _t.copy(_d0).applyQuaternion(_q).multiplyScalar(L).add(P); return query(_t, null) - r; };
      let lo = 0, hi = thMax;
      if (gAt(hi) >= 0) for (let it = 0; it < bisect; it++) { const mid = (lo + hi) * 0.5; if (gAt(mid) >= 0) hi = mid; else lo = mid; }
      _q.setFromAxisAngle(_ax, hi);                              // the smallest angle that clears the skin — or as far as it goes
      for (let m = k; m < chain.length; m++) {
        const q = pack[chain[m]]; if (!q) continue;
        _t.set(q.x - P.x, q.y - P.y, q.z - P.z).applyQuaternion(_q);
        q.x = P.x + _t.x; q.y = P.y + _t.y; q.z = P.z + _t.z;
      }
      fingers++;
    }
  }
  return { fingers, palm, max };
}
