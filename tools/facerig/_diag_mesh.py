# Diagnose an AI head mesh for facial animation: interior geometry, density, shells, wireframe renders.
#   blender -b --python _diag_mesh.py -- in.glb outdir markers.json zmin
import bpy, bmesh, sys, json, math, os
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, MK, ZMIN = argv[0], argv[1], argv[2], float(argv[3])
os.makedirs(OUT, exist_ok=True)
M = {k: Vector(v) for k, v in json.load(open(MK)).items()}
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)
mesh = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
me = mesh.data; MW = mesh.matrix_world
P = np.array([[*(MW @ v.co)] for v in me.vertices])
bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
tri = bm.copy(); bmesh.ops.triangulate(tri, faces=tri.faces[:]); bvh = BVHTree.FromBMesh(tri)
head = P[:, 2] > ZMIN
out = {'verts_total': len(P), 'head_verts': int(head.sum()), 'faces_total': len(me.polygons)}
# quads vs tris
out['head_faces'] = {'tris': 0, 'quads': 0, 'ngons': 0}
for f in me.polygons:
    if all(P[i, 2] > ZMIN for i in f.vertices):
        k = len(f.vertices); out['head_faces']['tris' if k == 3 else 'quads' if k == 4 else 'ngons'] += 1
# mouth region: within 6 cm of any lip marker
lips = np.array([[*v] for k, v in M.items() if k.startswith('lips')])
dmin = np.min(np.linalg.norm(P[:, None, :] - lips[None, :, :], axis=2), axis=1)
mouth = dmin < 0.06
out['mouth_region_verts_6cm'] = int(mouth.sum())
# interior: vertices BEHIND the lip crease plane (toward the pivot) AND occluded from most directions
piv = M['jaw_pivot.x']; top = M['lips_top.x']; bot = M['lips_bot.x']
mid = (top + bot) / 2
inward = (piv - mid); inward.z = 0; inward.normalize()
interior = []
for i in np.nonzero(mouth)[0]:
    p = Vector(P[i]); depth = (p - mid).dot(inward)
    if depth < 0.005: continue
    n = me.vertices[i].normal
    hits = 0
    for d in [Vector((0, -1, 0)), Vector((0, -1, 0.5)).normalized(), Vector((0, -1, -0.5)).normalized(), Vector((0.5, -1, 0)).normalized(), Vector((-0.5, -1, 0)).normalized(), Vector((0, 0, 1)), Vector((0, 0, -1))]:
        if bvh.ray_cast(p + d * 0.001, d, 0.5)[0] is not None: hits += 1
    if hits >= 5: interior.append((i, depth, hits))
out['interior_verts'] = len(interior)
out['interior_depth_max_cm'] = round(max([d for _, d, _ in interior] + [0]) * 100, 1)
# loose shells touching the mouth region
seen = [False] * len(bm.verts); shells = []
for v in bm.verts:
    if seen[v.index]: continue
    stack = [v]; seen[v.index] = True; comp = []
    while stack:
        x = stack.pop(); comp.append(x.index)
        for e in x.link_edges:
            o = e.other_vert(x)
            if not seen[o.index]: seen[o.index] = True; stack.append(o)
    shells.append(comp)
main = max(shells, key=len)
mouth_shells = [c for c in shells if any(mouth[i] for i in c) and c is not main]
out['mouth_loose_shells'] = [{'n': len(c), 'center': [round(float(x), 3) for x in P[c].mean(axis=0)]} for c in mouth_shells]
out['main_shell_verts'] = len(main); out['shells'] = len(shells)
# non-manifold edges in the head
nm = sum(1 for e in bm.edges if not e.is_manifold and all(P[v.index, 2] > ZMIN for v in e.verts))
out['head_nonmanifold_edges'] = nm
# eye + brow density: verts within 2.5 cm of the eye centre / brow markers
for s in 'lr':
    ec = np.array([*M[f'eye_center.{s}']]); out[f'eye_{s}_verts_25mm'] = int((np.linalg.norm(P - ec, axis=1) < 0.025).sum())
    bc = np.array([*M[f'eyebrow_02.{s}']]); out[f'brow_{s}_verts_25mm'] = int((np.linalg.norm(P - bc, axis=1) < 0.025).sum())
# average edge length in the head
el = [ (e.verts[0].co - e.verts[1].co).length for e in bm.edges if P[e.verts[0].index, 2] > ZMIN]
out['head_mean_edge_mm'] = round(float(np.mean(el)) * 1000, 1)
# is there any geometry that looks like teeth (white) or tongue (pink) inside? by material colour sampling is done elsewhere; here just count interior shells
print('DIAG ' + json.dumps(out))
# ── wireframe renders of the mouth + eye ──
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'SINGLE'
sc.display.shading.single_color = (0.8, 0.8, 0.8); sc.display.shading.show_object_outline = False
sc.render.resolution_x = 1200; sc.render.resolution_y = 900
sc.world = bpy.data.worlds.new('W'); sc.world.color = (0.1, 0.1, 0.12)
mesh.show_wire = True; mesh.show_all_edges = True
# wireframe via a Wireframe modifier copy for visibility in workbench renders
w = mesh.copy(); w.data = mesh.data.copy(); sc.collection.objects.link(w)
mod = w.modifiers.new('wire', 'WIREFRAME'); mod.thickness = 0.0012; mod.use_replace = True
mw = bpy.data.materials.new('wire'); mw.diffuse_color = (0.05, 0.05, 0.05, 1); w.data.materials.clear(); w.data.materials.append(mw)
sc.display.shading.color_type = 'MATERIAL'; mesh.hide_render = False
mm = bpy.data.materials.new('skin'); mm.diffuse_color = (0.85, 0.85, 0.85, 1)
for i in range(len(mesh.data.materials)): mesh.data.materials[i] = mm
mesh.scale = (0.998, 0.998, 0.998)   # skin slightly inside the wire shell
def cam(view, center, size):
    c = bpy.data.cameras.new('c'); c.type = 'ORTHO'; c.ortho_scale = size; co = bpy.data.objects.new('cam', c); sc.collection.objects.link(co); sc.camera = co
    cv = Vector(center)
    if view == 'front':  co.location = cv + Vector((0, -3, 0)); co.rotation_euler = (math.pi / 2, 0, 0)
    if view == 'left':   co.location = cv + Vector((3, 0, 0)); co.rotation_euler = (math.pi / 2, 0, math.pi / 2)
    if view == 'frontlow': co.location = cv + Vector((0, -3, -1.3)); co.rotation_euler = (math.radians(113), 0, 0)
    return co
for view, ctr, size, name in [('front', (M['nose_tip.x'].x, M['nose_tip.x'].y + 0.1, M['nose_tip.x'].z + 0.05), 0.45, 'wire_face'), ('frontlow', mid, 0.2, 'wire_mouth'), ('left', mid, 0.22, 'wire_mouth_side')]:
    co = cam(view, ctr, size); sc.render.filepath = os.path.join(OUT, name + '.png'); bpy.ops.render.render(write_still=True); bpy.data.objects.remove(co)
# jaw open cutaway: hide the lower-jaw skin, look into the cavity from the front-low
print('DIAG_RENDERS_OK')
