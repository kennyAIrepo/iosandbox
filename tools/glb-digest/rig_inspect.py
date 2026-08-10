#!/usr/bin/env python3
"""
rig_inspect.py - validate HOW a GLB's rig actually works: per-mesh morph
target names (the authored shape keys), skin joints, and what each
animation clip actually targets. Companion to glb_digest.py (reuses its
parser). Answers: pre-rigged or not, and by which mechanism (morphs vs
bones vs baked clips).

USAGE:  py -3 rig_inspect.py model.glb
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_digest import read_gltf


def inspect(path):
    gltf, _ = read_gltf(path)
    out = {"file": os.path.basename(path)}

    # Per-mesh morph targets: names live in mesh.extras.targetNames (the
    # convention Blender/RPM/three.js all write and read)
    meshes = []
    for m in gltf.get("meshes", []):
        prims = m.get("primitives", [])
        n_targets = max((len(p.get("targets", [])) for p in prims), default=0)
        names = (m.get("extras") or {}).get("targetNames") or []
        meshes.append({
            "mesh": m.get("name"),
            "morph_count": n_targets,
            "morph_names_sample": names[:10],
            "has": {k: any(k.lower() in n.lower() for n in names)
                    for k in ("jawOpen", "mouthOpen", "tongueOut", "eyeBlink",
                              "mouthSmile", "mouthStretch", "viseme")}
        })
    out["meshes"] = meshes

    # Skins: which node names are joints
    skins = []
    nodes = gltf.get("nodes", [])
    for s in gltf.get("skins", []):
        jn = [nodes[j].get("name", f"n{j}") for j in s.get("joints", [])]
        face_joints = [n for n in jn if any(k in n.lower()
                       for k in ("jaw", "tongue", "head", "eye", "neck"))]
        skins.append({"joints": len(jn), "face_relevant_joints": face_joints[:12]})
    out["skins"] = skins

    # Animations: what do the clips actually drive?
    anims = []
    for a in gltf.get("animations", []):
        targets = {"rotation": 0, "translation": 0, "scale": 0, "weights": 0}
        for ch in a.get("channels", []):
            p = ch.get("target", {}).get("path")
            if p in targets:
                targets[p] += 1
        anims.append({"clip": a.get("name"), "channels": targets})
    out["animations"] = anims
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(inspect(p), indent=1))
