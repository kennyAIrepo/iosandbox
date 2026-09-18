# Head-geometry analysis for facial marker placement (headless Blender):
#   loose parts (eyeballs / teeth / tongue shells), mouth cavity via hemisphere
#   occlusion rays, dark-texture vertices (brows / nose / mouth line), per-band
#   summaries. Writes a per-vertex JSON (occlusion + darkness) for the placer.
#   blender -b --python _analyze_head.py -- in.glb out.json [zmin]
import bpy, sys, json, math, bmesh, random
from mathutils import Vector
from mathutils.bvhtree import BVHTree
argv = sys.argv[sys.argv.index('--') + 1:]
src, outp = argv[0], argv[1]
zmin_head = float(argv[2]) if len(argv) > 2 else -1e9
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)
mesh = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
me = mesh.data; M = mesh.matrix_world
W = lambda i: M @ me.vertices[i].co
out = {'mesh': mesh.name, 'verts': len(me.vertices), 'uv_layers': [u.name for u in me.uv_layers], 'images': [(i.name, i.size[0], i.size[1]) for i in bpy.data.images]}
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
# ── loose parts ──
seen = [False] * len(bm.verts); parts = []
for v in bm.verts:
    if seen[v.index]: continue
    stack = [v]; seen[v.index] = True; comp = []
    while stack:
        x = stack.pop(); comp.append(x.index)
        for e in x.link_edges:
            o = e.other_vert(x)
            if not seen[o.index]: seen[o.index] = True; stack.append(o)
    parts.append(comp)
parts.sort(key=len, reverse=True)
out['n_parts'] = len(parts); out['loose_parts'] = []
for comp in parts[:40]:
    xs = [W(i) for i in comp]
    out['loose_parts'].append({'n': len(comp), 'bbox': [[round(min(p[k] for p in xs), 3), round(max(p[k] for p in xs), 3)] for k in range(3)],
                               'center': [round(sum(p[k] for p in xs) / len(xs), 3) for k in range(3)]})
# ── occlusion on head verts (hemisphere rays) ──
bvh = BVHTree.FromBMesh(bm)
random.seed(1); dirs = []
for i in range(32):
    z = random.random(); r = math.sqrt(1 - z * z); a = random.random() * 2 * math.pi
    dirs.append(Vector((r * math.cos(a), r * math.sin(a), z)))
head = [i for i in range(len(me.vertices)) if W(i).z >= zmin_head]
occl = {}
for i in head:
    v = me.vertices[i]; p = v.co; n = v.normal
    t = n.cross(Vector((0, 0, 1))) if abs(n.z) < 0.9 else n.cross(Vector((1, 0, 0))); t.normalize(); b = n.cross(t)
    hits = 0
    for d in dirs:
        w = t * d.x + b * d.y + n * d.z
        if bvh.ray_cast(p + n * 0.0015, w, 0.5)[0] is not None: hits += 1
    occl[i] = hits / len(dirs)
occ = [i for i in head if occl[i] > 0.75]
xs = [W(i) for i in occ]
out['occluded'] = {'n': len(occ), 'bbox': [[round(min(p[k] for p in xs), 3), round(max(p[k] for p in xs), 3)] for k in range(3)] if occ else None}
# ── dark-texture verts ──
img = None
for m in me.materials:
    if m and m.use_nodes:
        bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf and bsdf.inputs['Base Color'].links: img = bsdf.inputs['Base Color'].links[0].from_node.image
        if not img:
            for nd in m.node_tree.nodes:
                if nd.type == 'TEX_IMAGE' and nd.image: img = nd.image
dark = {}
if img and me.uv_layers.active:
    Wd, Hd = img.size; px = img.pixels[:]
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if vi not in occl: continue
            u, vv = uv[li].uv
            x = int((u % 1) * Wd) % Wd; y = int((vv % 1) * Hd) % Hd; k = (y * Wd + x) * 4
            lum = (px[k] + px[k + 1] + px[k + 2]) / 3
            dark[vi] = min(dark.get(vi, 1), lum)
    dv = [i for i in head if dark.get(i, 1) < 0.12]
    bands = {}
    for i in dv:
        p = W(i); b = round(p.z, 2); bands.setdefault(b, []).append(p)
    out['dark'] = {'n': len(dv), 'bands': {str(k): {'n': len(v), 'x': [round(min(q.x for q in v), 3), round(max(q.x for q in v), 3)], 'y': [round(min(q.y for q in v), 3), round(max(q.y for q in v), 3)]} for k, v in sorted(bands.items())}}
# ── head extremes ──
hx = [W(i) for i in head]
out['head'] = {'n': len(head), 'bbox': [[round(min(p[k] for p in hx), 3), round(max(p[k] for p in hx), 3)] for k in range(3)],
               'front_most': [round(c, 3) for c in min(hx, key=lambda p: p.y)], 'top_most': [round(c, 3) for c in max(hx, key=lambda p: p.z)]}
json.dump({'occl': {str(i): round(occl[i], 3) for i in head}, 'dark': {str(i): round(dark.get(i, 1), 3) for i in head},
           'pos': {str(i): [round(c, 4) for c in W(i)] for i in head}, 'nrm': {str(i): [round(c, 3) for c in (M.to_3x3() @ me.vertices[i].normal)] for i in head}}, open(outp, 'w'))
print('ANALYZE_JSON ' + json.dumps(out))
