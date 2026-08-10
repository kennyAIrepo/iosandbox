#!/usr/bin/env python3
"""
glb_digest.py - compact, machine-readable structural digest of a GLB/glTF mesh.

WHY THIS EXISTS
    A 125k-vertex mesh cannot be handed to a language model, but rigging
    decisions only need a few hundred numbers: where the head is, where the
    mouth crease runs, which vertices are mirror partners, how thick the neck
    is. This extracts exactly that and nothing else.

THE IDENTITY CONTRACT
    Every landmark carries a stable VERTEX INDEX. Index i resolves to the same
    point in the GLB, in Blender (mesh.vertices[i]), and in three.js (position
    attribute i). Coordinates drift the moment anyone edits the mesh; indices
    are what survive. Always refer to rig points by index, and treat the
    coordinates in this digest as a snapshot.

    Caveat that bites: indices are only comparable between meshes with the same
    topology. Applying a boolean, decimating, or re-exporting renumbers
    everything. The digest records vert_count + a geometry hash so a mismatch
    is detectable rather than silent.

DEPENDENCIES
    numpy only. GLB is parsed directly - no pygltflib, no trimesh, so this runs
    on the ARM64 box without a build toolchain.

USAGE
    py -3 glb_digest.py model.glb -o digest.json
    py -3 glb_digest.py model.glb --slices 24 --top 8
"""

import argparse
import base64
import hashlib
import json
import os
import struct
import sys

import numpy as np

# glTF component types -> (numpy dtype, byte size)
_CTYPE = {
    5120: (np.int8, 1), 5121: (np.uint8, 1), 5122: (np.int16, 2),
    5123: (np.uint16, 2), 5125: (np.uint32, 4), 5126: (np.float32, 4),
}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


# ---------------------------------------------------------------- GLB parsing

def read_gltf(path):
    """Return (gltf_dict, {buffer_index: bytes})."""
    with open(path, "rb") as fh:
        head = fh.read(12)
        if head[:4] == b"glTF":
            _, _, total = struct.unpack("<4sII", head)
            gltf, buffers = None, {}
            bin_chunk = None
            while fh.tell() < total:
                raw = fh.read(8)
                if len(raw) < 8:
                    break
                clen, ctype = struct.unpack("<II", raw)
                data = fh.read(clen)
                if ctype == 0x4E4F534A:      # 'JSON'
                    gltf = json.loads(data.decode("utf-8"))
                elif ctype == 0x004E4942:    # 'BIN\0'
                    bin_chunk = data
            if bin_chunk is not None:
                buffers[0] = bin_chunk
        else:                                 # plain .gltf
            fh.seek(0)
            gltf = json.load(fh)
            buffers = {}

    base = os.path.dirname(os.path.abspath(path))
    for i, buf in enumerate(gltf.get("buffers", [])):
        if i in buffers:
            continue
        uri = buf.get("uri", "")
        if uri.startswith("data:"):
            buffers[i] = base64.b64decode(uri.split(",", 1)[1])
        elif uri:
            with open(os.path.join(base, uri), "rb") as bf:
                buffers[i] = bf.read()
    return gltf, buffers


def accessor(gltf, buffers, idx):
    """Decode accessor idx into an (count, ncomp) float/int array."""
    acc = gltf["accessors"][idx]
    n = acc["count"]
    ncomp = _NCOMP[acc["type"]]
    dt, csize = _CTYPE[acc["componentType"]]

    if "bufferView" not in acc:
        return np.zeros((n, ncomp), dtype=dt)

    bv = gltf["bufferViews"][acc["bufferView"]]
    blob = buffers[bv.get("buffer", 0)]
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or ncomp * csize

    if stride == ncomp * csize:
        flat = np.frombuffer(blob, dtype=dt, count=n * ncomp, offset=start)
        out = flat.reshape(n, ncomp)
    else:  # interleaved
        out = np.empty((n, ncomp), dtype=dt)
        for k in range(n):
            off = start + k * stride
            out[k] = np.frombuffer(blob, dtype=dt, count=ncomp, offset=off)

    if acc.get("normalized") and dt != np.float32:
        info = np.iinfo(dt)
        out = out.astype(np.float32) / max(abs(info.min), info.max)
    return out


def node_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in node:
        m = np.diag(list(node["scale"]) + [1.0]) @ m
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1]])
        m = r @ m
    if "translation" in node:
        t = np.eye(4)
        t[:3, 3] = node["translation"]
        m = t @ m
    return m


def collect_mesh(gltf, buffers):
    """Flatten the scene into one (V,3) position array + (F,3) index array."""
    verts, faces, parts, offset = [], [], [], 0
    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]

    def walk(ni, parent):
        nonlocal offset
        node = gltf["nodes"][ni]
        world = parent @ node_matrix(node)
        if "mesh" in node:
            for pi, prim in enumerate(gltf["meshes"][node["mesh"]].get("primitives", [])):
                if "POSITION" not in prim.get("attributes", {}):
                    continue
                p = accessor(gltf, buffers, prim["attributes"]["POSITION"]).astype(np.float64)
                p = (world @ np.c_[p, np.ones(len(p))].T).T[:, :3]
                if "indices" in prim:
                    idx = accessor(gltf, buffers, prim["indices"]).reshape(-1).astype(np.int64)
                else:
                    idx = np.arange(len(p), dtype=np.int64)
                tri = idx.reshape(-1, 3) + offset
                verts.append(p)
                faces.append(tri)
                parts.append({
                    "node": node.get("name", f"node{ni}"),
                    "mesh": gltf["meshes"][node["mesh"]].get("name", f"mesh{node['mesh']}"),
                    "primitive": pi,
                    "vert_range": [offset, offset + len(p)],
                    "material": prim.get("material"),
                })
                offset += len(p)
        for c in node.get("children", []):
            walk(c, world)

    for root in scene.get("nodes", []):
        walk(root, np.eye(4))

    V = np.vstack(verts) if verts else np.zeros((0, 3))
    F = np.vstack(faces) if faces else np.zeros((0, 3), dtype=np.int64)
    return V, F, parts


# ------------------------------------------------------------------- analysis

def vertex_normals(V, F):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    ln = np.linalg.norm(fn, axis=1, keepdims=True)
    fn = fn / np.where(ln < 1e-20, 1, ln)
    N = np.zeros_like(V)
    for k in range(3):
        np.add.at(N, F[:, k], fn)
    ln = np.linalg.norm(N, axis=1, keepdims=True)
    return N / np.where(ln < 1e-20, 1, ln)


def curvature(V, F, N):
    """Discrete mean-curvature proxy + crease sharpness, per vertex.

    concavity > 0 : neighbours sit in front of the normal  -> valley/crease
                    (this is what the mouth line, eyelid seam, and any fold read as)
    sharpness     : 1 - mean(n_i . n_j) -> high on any hard edge, sign-agnostic
    """
    E = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    E = np.vstack([E, E[:, ::-1]])
    i, j = E[:, 0], E[:, 1]
    d = V[j] - V[i]
    dl = np.linalg.norm(d, axis=1)
    ok = dl > 1e-12
    proj = np.zeros(len(i))
    proj[ok] = np.einsum("ij,ij->i", d[ok] / dl[ok, None], N[i[ok]])
    dot = np.einsum("ij,ij->i", N[i], N[j])

    cnt = np.bincount(i, minlength=len(V)).astype(np.float64)
    cnt[cnt == 0] = 1
    concavity = np.bincount(i, weights=proj, minlength=len(V)) / cnt
    sharpness = 1.0 - np.bincount(i, weights=dot, minlength=len(V)) / cnt
    return concavity, sharpness


def symmetry(V, nbins=64):
    """Find the mirror plane by voxel-overlap scoring. Returns (axis, offset, score)."""
    lo, hi = V.min(0), V.max(0)
    span = np.where(hi - lo < 1e-12, 1, hi - lo)
    g = np.floor((V - lo) / span * (nbins - 1)).astype(np.int32)
    occupied = set(map(tuple, g))
    best = (0, float(V[:, 0].mean()), 0.0)
    for ax in range(3):
        for freq in np.linspace(0.42, 0.58, 17):        # scan plane position
            c = (nbins - 1) * freq
            mirrored = g.copy()
            mirrored[:, ax] = np.round(2 * c - g[:, ax]).astype(np.int32)
            hits = sum(1 for t in map(tuple, mirrored) if t in occupied)
            score = hits / len(g)
            if score > best[2]:
                best = (ax, float(lo[ax] + span[ax] * freq), score)
    return {"axis": "xyz"[best[0]], "axis_index": best[0],
            "plane_offset": round(best[1], 5), "score": round(best[2], 4)}


def grid_hash(V, cell):
    tbl = {}
    keys = np.floor(V / cell).astype(np.int64)
    for n, k in enumerate(map(tuple, keys)):
        tbl.setdefault(k, []).append(n)
    return tbl, cell


def nearest(tbl, cell, V, p):
    k = tuple(np.floor(p / cell).astype(np.int64))
    cand = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cand.extend(tbl.get((k[0] + dx, k[1] + dy, k[2] + dz), []))
    if not cand:
        return None, None
    cand = np.asarray(cand)
    d = np.linalg.norm(V[cand] - p, axis=1)
    b = int(np.argmin(d))
    return int(cand[b]), float(d[b])


def slice_profile(V, axis, n):
    """Cross-section stats along `axis` - reveals head / neck / body / tail."""
    a = V[:, axis]
    lo, hi = float(a.min()), float(a.max())
    edges = np.linspace(lo, hi, n + 1)
    other = [k for k in range(3) if k != axis]
    rows = []
    for s in range(n):
        m = (a >= edges[s]) & (a < edges[s + 1] if s < n - 1 else a <= edges[s + 1])
        c = int(m.sum())
        if c == 0:
            rows.append({"at": round(edges[s], 4), "n": 0})
            continue
        sub = V[m]
        w = float(np.ptp(sub[:, other[0]]))
        h = float(np.ptp(sub[:, other[1]]))
        rows.append({
            "at": round(float(edges[s]), 4), "n": c,
            "w": round(w, 4), "h": round(h, 4),
            "girth": round((w + h) / 2, 4),
            "ctr": [round(float(sub[:, k].mean()), 4) for k in range(3)],
        })
    return {"axis": "xyz"[axis], "range": [round(lo, 4), round(hi, 4)], "slices": rows}


def crease_clusters(V, mask, cell, top):
    """Voxel-bin flagged vertices; report the densest groups as landmark candidates."""
    idx = np.nonzero(mask)[0]
    if len(idx) == 0:
        return []
    bins = {}
    keys = np.floor(V[idx] / cell).astype(np.int64)
    for n, k in zip(idx, map(tuple, keys)):
        bins.setdefault(k, []).append(n)
    groups = sorted(bins.values(), key=len, reverse=True)[:top]
    out = []
    for g in groups:
        g = np.asarray(g)
        pts = V[g]
        ctr = pts.mean(0)
        d = np.linalg.norm(pts - ctr, axis=1)
        out.append({
            "n": len(g),
            "centroid": [round(float(x), 4) for x in ctr],
            "extent": [round(float(np.ptp(pts[:, k])), 4) for k in range(3)],
            "rep_vert": int(g[int(np.argmin(d))]),      # vertex nearest the centroid
            "sample_verts": [int(x) for x in g[:: max(1, len(g) // 6)][:6]],
        })
    return out


def extremes(V, sym_axis):
    """Axis extreme points - snout tip, tail tip, feet, crown. Index-anchored."""
    names = {0: ("x_min", "x_max"), 1: ("y_min", "y_max"), 2: ("z_min", "z_max")}
    out = {}
    for ax in range(3):
        for which, fn in ((0, np.argmin), (1, np.argmax)):
            i = int(fn(V[:, ax]))
            out[names[ax][which]] = {"vert": i, "co": [round(float(x), 4) for x in V[i]]}
    return out


# ----------------------------------------------------------------------- main

def to_blender(V):
    """glTF is Y-up / -Z-forward; Blender is Z-up / -Y-forward.

    Blender(x, y, z) = GLB(x, -z, y).  Applying this makes every coordinate in
    the digest directly comparable to what bpy reports, so nobody has to do the
    swap in their head and get a sign wrong.
    """
    return np.c_[V[:, 0], -V[:, 2], V[:, 1]]


def digest(path, n_slices=20, top=6, region=None, blender_axes=False):
    gltf, buffers = read_gltf(path)
    V, F, parts = collect_mesh(gltf, buffers)
    if len(V) == 0:
        raise SystemExit("no POSITION data found")

    if blender_axes:
        V = to_blender(V)

    # Region focus: keep only faces fully inside the box, but PRESERVE the
    # original vertex indices - they are the identity contract. Analysis runs
    # on a compacted copy and indices are mapped back before output.
    keep_map = None
    if region:
        lo_r = np.array(region[0::2], dtype=np.float64)
        hi_r = np.array(region[1::2], dtype=np.float64)
        inside = np.all((V >= lo_r) & (V <= hi_r), axis=1)
        fmask = inside[F].all(axis=1)
        F = F[fmask]
        used = np.unique(F)
        if len(used) == 0:
            raise SystemExit("region contains no complete faces")
        keep_map = used                       # local index -> original index
        remap = np.full(len(V), -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        F = remap[F]
        V = V[used]

    N = vertex_normals(V, F)
    conc, sharp = curvature(V, F, N)
    sym = symmetry(V)

    lo, hi = V.min(0), V.max(0)
    size = hi - lo
    diag = float(np.linalg.norm(size))

    # Longest axis is the body axis for a quadruped/creature.
    body_axis = int(np.argmax(size))

    # Crease candidates: strongly concave AND sharp. These are folds - the mouth
    # line is the biggest one on a closed-mouth head.
    thr_c = float(np.quantile(conc, 0.985))
    thr_s = float(np.quantile(sharp, 0.95))
    creases = crease_clusters(V, (conc > thr_c) & (sharp > thr_s), diag / 28.0, top)

    # Convex bumps: eyes, knuckles, nostrils.
    thr_v = float(np.quantile(conc, 0.015))
    bumps = crease_clusters(V, (conc < thr_v) & (sharp > thr_s), diag / 28.0, top)

    skins = gltf.get("skins", [])
    morphs = sum(len(p.get("targets", []))
                 for m in gltf.get("meshes", []) for p in m.get("primitives", []))

    h = hashlib.sha1()
    h.update(np.ascontiguousarray(V.astype(np.float32)).tobytes())
    h.update(np.ascontiguousarray(F.astype(np.int32)).tobytes())

    # Translate every local index back to an original-mesh index.
    if keep_map is not None:
        def fix(groups):
            for g in groups:
                g["rep_vert"] = int(keep_map[g["rep_vert"]])
                g["sample_verts"] = [int(keep_map[v]) for v in g["sample_verts"]]
            return groups
        fix(creases)
        fix(bumps)
        ex = extremes(V, sym["axis_index"])
        for v in ex.values():
            v["vert"] = int(keep_map[v["vert"]])
    else:
        ex = extremes(V, sym["axis_index"])

    return {
        "_contract": ("Landmarks are VERTEX INDICES, stable across GLB / Blender / three.js. "
                      "Valid only while vert_count and geom_sha1 match; any boolean, "
                      "decimate, or re-export renumbers them."),
        "file": os.path.basename(path),
        "file_mb": round(os.path.getsize(path) / 1e6, 2),
        "generator": gltf.get("asset", {}).get("generator"),
        "axes": "blender (x,y,z) = glb(x,-z,y)" if blender_axes else "glb (Y-up)",
        "region": region,
        "vert_count": int(len(V)),
        "tri_count": int(len(F)),
        "geom_sha1": h.hexdigest()[:16],
        "already_rigged": {
            "skins": len(skins),
            "joints": [len(s.get("joints", [])) for s in skins],
            "morph_targets": morphs,
            "animations": len(gltf.get("animations", [])),
        },
        "parts": parts,
        "materials": [m.get("name") for m in gltf.get("materials", [])],
        "bbox": {"min": [round(float(x), 4) for x in lo],
                 "max": [round(float(x), 4) for x in hi],
                 "size": [round(float(x), 4) for x in size],
                 "center": [round(float(x), 4) for x in (lo + hi) / 2],
                 "diagonal": round(diag, 4)},
        "symmetry": sym,
        "body_axis": "xyz"[body_axis],
        "extremes": ex,
        "profile": slice_profile(V, body_axis, n_slices),
        "creases_concave": creases,
        "bumps_convex": bumps,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("glb")
    ap.add_argument("-o", "--out")
    ap.add_argument("--slices", type=int, default=20)
    ap.add_argument("--top", type=int, default=6)
    ap.add_argument("--blender-axes", action="store_true",
                    help="report coordinates in Blender's Z-up frame")
    ap.add_argument("--region", type=str, default=None,
                    help="focus box 'xmin,xmax,ymin,ymax,zmin,zmax' - indices "
                         "stay anchored to the ORIGINAL mesh")
    a = ap.parse_args()

    region = [float(x) for x in a.region.split(",")] if a.region else None
    if region and len(region) != 6:
        raise SystemExit("--region needs 6 comma-separated numbers")

    d = digest(a.glb, a.slices, a.top, region, a.blender_axes)
    text = json.dumps(d, indent=1)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {a.out}  ({len(text)/1024:.1f} KB, "
              f"{d['vert_count']} verts -> digest)")
    else:
        print(text)


if __name__ == "__main__":
    main()
