# hopeOS — FACE REBUILD (headless Blender 4.4): turn an AI-generated (Meshy) head into an ANIMATABLE face.
# ═══════════════════════════════════════════════════════════════════════════════════════════
# The Meshy head is a soup of ~200 open patches, ~2k triangles, no mouth interior, no lids —
# no skin weights can animate that. This rebuilds the head the way a modeller would:
#
#   1. SOLID + REMESH   thicken the patches → voxel-remesh the solid → one closed manifold → QuadriFlow quads
#   2. MOUTH CUT        boolean a slit along the lip crease (from the markers) + a mouth-bag cavity behind it
#   3. INTERIOR         procedural gums material, upper/lower teeth rows (canines), tongue
#   4. TEXTURE          smart-UV the new skin and Cycles-bake base colour + normal from the ORIGINAL head
#   5. EXPORT           head_rebuilt.glb (skin / mouth / teeth / tongue material slots) + rebuild.json
#
#   blender -b --python facerig_rebuild.py -- in.glb markers.json outdir [--zmin 0.45] [--faces 14000]
#            [--voxel 3.5] [--bake 2048] [--nobake] [--render]
import bpy, bmesh, sys, json, math, os, time
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, MK, OUT = argv[0], argv[1], argv[2]
opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
ZMIN = float(opt('--zmin', '0.45')); FACES = int(opt('--faces', '22000')); VOX = float(opt('--voxel', '4')) / 1000
BAKE = int(opt('--bake', '2048')); NOBAKE = '--nobake' in argv; RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)
log = lambda *a: print('[rebuild]', *a, flush=True)
T0 = time.time()
M = {k: Vector(v) for k, v in json.load(open(MK)).items()}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)
SRCOBJ = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
SRCOBJ.name = 'Source'
sc = bpy.context.scene
def activate(o):
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o

# ═══ 1. SOLID + REMESH ═══════════════════════════════════════════════════════════════════
head = SRCOBJ.copy(); head.data = SRCOBJ.data.copy(); head.name = 'Head'; sc.collection.objects.link(head)
activate(head)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
for f in head.data.polygons: f.select = any((head.matrix_world @ head.data.vertices[i].co).z < ZMIN - 0.04 for i in f.vertices)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE'); bpy.ops.mesh.delete(type='FACE'); bpy.ops.object.mode_set(mode='OBJECT')
SOLID = float(opt('--solid', '30')) / 1000   # patch skin thickness; the core is made solid below (interior removal + second voxel pass)
ear_z = min(M['ear_01.l'].z, M['ear_01.r'].z) - 0.02
vg = head.vertex_groups.new(name='solid')
for v in head.data.vertices:
    w = 0.0 if (head.matrix_world @ v.co).z > ear_z and abs((head.matrix_world @ v.co).x) > 0.06 else 1.0
    vg.add([v.index], w, 'REPLACE')
so = head.modifiers.new('solid', 'SOLIDIFY'); so.thickness = SOLID; so.offset = -1; so.use_rim = True; so.use_quality_normals = True
so.vertex_group = 'solid'; so.thickness_vertex_group = 0.3
bpy.ops.object.modifier_apply(modifier='solid')
head.data.remesh_voxel_size = VOX; head.data.remesh_voxel_adaptivity = 0.0; head.data.use_remesh_fix_poles = True; head.data.use_remesh_preserve_volume = True
bpy.ops.object.voxel_remesh()
def largest_shell(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.verts.ensure_lookup_table()
    seen = set(); comps = []
    for v in bm.verts:
        if v.index in seen: continue
        comp = []; stack = [v]; seen.add(v.index)
        while stack:
            x = stack.pop(); comp.append(x.index)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen: seen.add(o.index); stack.append(o)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    kill = set(i for c in comps[1:] for i in c)
    if kill: bmesh.ops.delete(bm, geom=[bm.verts[i] for i in kill], context='VERTS')
    bm.to_mesh(obj.data); bm.free(); obj.data.update(); return len(comps)
log('voxel', len(head.data.vertices), 'verts, shells', largest_shell(head), round(time.time() - T0, 1), 's')
# ── make the core SOLID: the solidified patch soup keeps its inner surface (connected to the outer one through the
#    rim tubes), so the voxel shell is hollow. Interior faces = every one of 12 rays from the face is blocked. Delete
#    them, close the holes they leave, voxelize the closed shell again (a closed surface voxelizes as a solid). ──
def remove_interior(obj, dirs=12, reach=0.6):
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.faces.ensure_lookup_table()
    tri = bm.copy(); bmesh.ops.triangulate(tri, faces=tri.faces[:]); bvh = BVHTree.FromBMesh(tri); tri.free()
    golden = math.pi * (3 - math.sqrt(5)); D = []
    for i in range(dirs):
        y = 1 - (i / (dirs - 1)) * 2; r = math.sqrt(1 - y * y); t = golden * i
        D.append(Vector((math.cos(t) * r, y, math.sin(t) * r)))
    kill = []
    for f in bm.faces:
        c = f.calc_center_median(); blocked = 0; free = 0
        for d in D:
            if bvh.ray_cast(c + d * 0.0015, d, reach)[0] is not None: blocked += 1
            else:
                free += 1
                break
        if blocked == dirs: kill.append(f)
    n = len(kill)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(obj.data); bm.free(); obj.data.update(); return n
def manifold_report(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); ne = sum(1 for e in bm.edges if not e.is_manifold); nv = sum(1 for v in bm.verts if not v.is_manifold); bm.free(); return ne, nv
log('manifold check (edges, verts non-manifold):', manifold_report(head))
nq = len(head.data.vertices)
for attempt in range(3):
    res = bpy.ops.object.quadriflow_remesh(target_faces=FACES, use_preserve_sharp=False, use_preserve_boundary=False, use_mesh_symmetry=False, seed=1 + attempt, mode='FACES')
    if len(head.data.vertices) != nq: break
    # repair: drop non-manifold verts, fill the holes, recalc normals, retry
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.mesh.select_mode(type='VERT')
    bpy.ops.mesh.select_non_manifold(extend=False, use_wire=True, use_boundary=True, use_multi_face=True, use_non_contiguous=True, use_verts=True)
    bpy.ops.mesh.delete(type='VERT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.fill_holes(sides=0); bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode='OBJECT')
    largest_shell(head); nq = len(head.data.vertices); log('  repaired for quadriflow:', manifold_report(head), nq, 'verts')
log('quadriflow', res, len(head.data.vertices), 'verts', len(head.data.polygons), 'faces', round(time.time() - T0, 1), 's')
nk = remove_interior(head); largest_shell(head)
log('interior sheet removed from the quad mesh:', nk, 'faces →', len(head.data.vertices), 'verts', round(time.time() - T0, 1), 's')
# cut the neck flat (the solidify rim voxelizes into a lumpy skirt) — capped so the mesh stays CLOSED for the booleans
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.bisect(plane_co=(0, 0, ZMIN - 0.02), plane_no=(0, 0, 1), clear_inner=True, use_fill=True)   # inner = below the plane → removed
bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
for f in head.data.polygons: f.use_smooth = True
# smooth the voxel staircase a touch without losing volume
sm = head.modifiers.new('sm', 'CORRECTIVE_SMOOTH'); sm.factor = 0.5; sm.iterations = 5; sm.use_only_smooth = True; sm.smooth_type = 'LENGTH_WEIGHTED'
bpy.ops.object.modifier_apply(modifier='sm')

# ═══ 2. MOUTH CUT ═══════════════════════════════════════════════════════════════════════
# ring samples along u (right commissure → tip → left commissure), on the crease
def ring_pts():
    top = {0: M['lips_top.x']}; bot = {0: M['lips_bot.x']}
    for s, sg in (('l', 1), ('r', -1)):
        for n, u in (('01', .3), ('02', .6), ('03', .85)):
            top[sg * u] = M[f'lips_top_{n}.{s}']; bot[sg * u] = M[f'lips_bot_{n}.{s}']
        top[sg * 1.0] = M[f'lips_smile.{s}']; bot[sg * 1.0] = M[f'lips_smile.{s}']
    us = sorted(top); return us, [(top[u] + bot[u]) / 2 for u in us]
US, RING = ring_pts()
PIV = M['jaw_pivot.x']
def resample(pts, n):
    # Catmull-Rom through the ring points → n samples
    P = [pts[0]] + list(pts) + [pts[-1]]; out = []
    for i in range(n):
        t = i / (n - 1) * (len(pts) - 1); k = min(int(t), len(pts) - 2); f = t - k
        p0, p1, p2, p3 = P[k], P[k + 1], P[k + 2], P[k + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f))
    return out
NS = 33
CREASE = resample(RING, NS)                       # 33 points along the mouth line
U = [i / (NS - 1) * 2 - 1 for i in range(NS)]
def inward(p):
    d = PIV - p; d.z = 0; return d.normalized()
def loft(sections, cap=True):
    """closed mesh from a list of equal-length closed polygons (rings) + end caps"""
    bm = bmesh.new(); rows = [[bm.verts.new(p) for p in sec] for sec in sections]
    for a, b in zip(rows, rows[1:]):
        for i in range(len(a)):
            j = (i + 1) % len(a); bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap: bm.faces.new(rows[0][::-1]); bm.faces.new(rows[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new('loft'); bm.to_mesh(me); bm.free(); return me
LIP_T = 0.011                                      # lip flesh thickness (crease → cavity wall)
# thickness probes on the CLOSED remeshed head: from a point just inside the skin, how far to the opposite wall
bmh = bmesh.new(); bmh.from_mesh(head.data); bmesh.ops.triangulate(bmh, faces=bmh.faces[:]); HBVH = BVHTree.FromBMesh(bmh); bmh.free()
def wall(p, d, dmax=0.3):
    h = HBVH.ray_cast(p, d, dmax); return h[3] if h[0] is not None else dmax
def cavity_mesh():
    """the mouth bag as a PRISM over the inset mouth outline (top view): no self-intersection, unlike a loft that
    converges on the pivot. Floor / palate heights vary along u and are clamped by the local skin thickness."""
    bm = bmesh.new(); bot = []; top = []
    for i, p in enumerate(CREASE):
        u = U[i]; w = (1 - abs(u) ** 2.2); d = inward(p)
        q = p + d * LIP_T                                              # inset outline point (lip flesh stays)
        ht = 0.004 + 0.020 * w; hb = 0.004 + 0.022 * w
        probe = q + d * 0.012
        ht = min(ht, max(0.003, wall(probe, Vector((0, 0, 1))) - 0.008)); hb = min(hb, max(0.003, wall(probe, Vector((0, 0, -1))) - 0.008))
        bot.append(bm.verts.new(Vector((q.x, q.y, q.z - hb)))); top.append(bm.verts.new(Vector((q.x, q.y, q.z + ht))))
    n = len(bot)
    for i in range(n):
        j = (i + 1) % n                                                # the last quad closes the outline behind the commissures (throat)
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    bm.faces.new(bot[::-1]); bm.faces.new(top)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new('cavity'); bm.to_mesh(me); bm.free(); return me
def slit_sections():
    secs = []
    for i, p in enumerate(CREASE):
        u = U[i]; d = inward(p); z = Vector((0, 0, 1)); g = 0.0012 + 0.0008 * (1 - abs(u))
        g *= (0.35 + 0.65 * (1 - abs(u) ** 3))                                  # thinner at the commissures
        prof = [(-0.035, g), (LIP_T + 0.012, g), (LIP_T + 0.012, -g), (-0.035, -g)]   # the blade starts 3.5 cm OUTSIDE: the remeshed skin can sit ~1 cm off the marker line
        secs.append([p + d * a + z * b for a, b in prof])
    return secs
CUTTERS = []
def boolean_cut(target, cutter_mesh, name, mat):
    cut = bpy.data.objects.new(name, cutter_mesh); sc.collection.objects.link(cut)
    bmk = bmesh.new(); bmk.from_mesh(cutter_mesh); bmesh.ops.triangulate(bmk, faces=bmk.faces[:]); CUTTERS.append(BVHTree.FromBMesh(bmk)); bmk.free()
    cutter_mesh.materials.append(mat)
    bmc = bmesh.new(); bmc.from_mesh(cutter_mesh); nm = sum(1 for e in bmc.edges if not e.is_manifold); vol = bmc.calc_volume(signed=True); bmc.free()
    bb = [Vector(c) for c in cut.bound_box]
    log('cutter', name, 'faces', len(cutter_mesh.polygons), 'nonmanifold', nm, 'signed vol', round(vol * 1e6, 1), 'cm3', 'bbox z', round(min(v.z for v in bb), 3), round(max(v.z for v in bb), 3), 'y', round(min(v.y for v in bb), 3), round(max(v.y for v in bb), 3))
    if '--dumpcut' in argv:
        activate(cut); bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'cutter_{name}.glb'), export_format='GLB', use_selection=True, export_materials='NONE')
    bpy.context.view_layer.update()
    hb = [target.matrix_world @ Vector(c) for c in target.bound_box]
    log('  target world bbox z', round(min(v.z for v in hb), 3), round(max(v.z for v in hb), 3), 'y', round(min(v.y for v in hb), 3), round(max(v.y for v in hb), 3), 'matrix identity?', target.matrix_world == Matrix.Identity(4))
    activate(target)
    n0 = len(target.data.vertices)
    for solver in ('EXACT', 'FAST'):
        b = target.modifiers.new(name, 'BOOLEAN'); b.operation = 'DIFFERENCE'; b.object = cut; b.solver = solver; b.material_mode = 'TRANSFER'
        if solver == 'EXACT': b.use_self = True; b.use_hole_tolerant = True
        bpy.context.view_layer.update()
        r = bpy.ops.object.modifier_apply(modifier=name)
        log('  boolean', name, solver, r, n0, '→', len(target.data.vertices))
        if len(target.data.vertices) != n0: break
    bpy.data.objects.remove(cut)
MAT_SKIN = bpy.data.materials.new('FoxSkin'); MAT_SKIN.use_nodes = True
MAT_MOUTH = bpy.data.materials.new('FoxMouth'); MAT_MOUTH.use_nodes = True
MAT_MOUTH.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.06, 0.07, 1); MAT_MOUTH.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.55
MAT_TEETH = bpy.data.materials.new('FoxTeeth'); MAT_TEETH.use_nodes = True
MAT_TEETH.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.93, 0.9, 0.82, 1); MAT_TEETH.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.35
MAT_TONGUE = bpy.data.materials.new('FoxTongue'); MAT_TONGUE.use_nodes = True
MAT_TONGUE.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.75, 0.25, 0.3, 1); MAT_TONGUE.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.5
head.data.materials.clear(); head.data.materials.append(MAT_SKIN)
nv0 = len(head.data.vertices)
boolean_cut(head, cavity_mesh(), 'cavity', MAT_MOUTH)
boolean_cut(head, loft(slit_sections()), 'slit', MAT_MOUTH)
def inside_any(pt):
    for bvh in CUTTERS:
        hits = 0; o = Vector(pt); d = Vector((0.31, 0.73, 0.61)).normalized()
        while True:
            h = bvh.ray_cast(o, d, 2.0)
            if h[0] is None: break
            hits += 1; o = h[0] + d * 1e-5
        if hits % 2 == 1: return True
    return False
bmq = bmesh.new(); bmq.from_mesh(head.data); bmq.faces.ensure_lookup_table()
junk = [f for f in bmq.faces if f.material_index == 0 and inside_any(f.calc_center_median())]
bmesh.ops.delete(bmq, geom=junk, context='FACES'); bmq.to_mesh(head.data); bmq.free(); head.data.update()
log('skin faces left inside the mouth volume (deleted):', len(junk))
bmq = bmesh.new(); bmq.from_mesh(head.data)
cap = [f for f in bmq.faces if all(abs(v.co.z - (ZMIN - 0.02)) < 0.0015 for v in f.verts)]
bmesh.ops.delete(bmq, geom=cap, context='FACES'); bmq.to_mesh(head.data); bmq.free(); head.data.update()
log('neck cap faces removed:', len(cap))
largest_shell(head)
log('mouth cut:', nv0, '→', len(head.data.vertices), 'verts; mouth faces', sum(1 for f in head.data.polygons if f.material_index == 1), round(time.time() - T0, 1), 's')
largest_shell(head)

# ═══ 3. INTERIOR: teeth + tongue (separate objects, joined at export; weighted by name later) ═══
def add_prim(name, mesh, mat):
    o = bpy.data.objects.new(name, mesh); sc.collection.objects.link(o); mesh.materials.append(mat); return o
def cone(p, axis, h, r, seg=8):
    bm = bmesh.new(); axis = axis.normalized()
    # basis
    t = axis.cross(Vector((0, 0, 1))) if abs(axis.z) < 0.9 else axis.cross(Vector((1, 0, 0))); t.normalize(); b = axis.cross(t)
    base = [bm.verts.new(p + (t * math.cos(a) + b * math.sin(a)) * r) for a in [k / seg * 2 * math.pi for k in range(seg)]]
    tip = bm.verts.new(p + axis * h); mid = [bm.verts.new(p + axis * h * 0.55 + (t * math.cos(a) + b * math.sin(a)) * r * 0.62) for a in [k / seg * 2 * math.pi for k in range(seg)]]
    bm.faces.new(base[::-1])
    for i in range(seg):
        j = (i + 1) % seg; bm.faces.new((base[i], base[j], mid[j], mid[i])); bm.faces.new((mid[i], mid[j], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); me = bpy.data.meshes.new('tooth'); bm.to_mesh(me); bm.free(); return me
TEETH = []
for row, sign, zoff, name in (('upper', -1, 0.0035, 'TeethTop'), ('lower', 1, -0.0035, 'TeethBot')):
    bm_all = bmesh.new()
    for i in range(1, NS - 1):
        u = U[i]
        if abs(u) > 0.92: continue
        if (i + (0 if row == 'upper' else 1)) % 2: continue            # alternate rows offset by half a spacing
        p = CREASE[i] + inward(CREASE[i]) * (LIP_T + 0.004) + Vector((0, 0, zoff + (0.003 if row == 'upper' else -0.003)))
        canine = 0.38 < abs(u) < 0.52
        h = (0.017 if canine else 0.009) * (1 - 0.25 * abs(u)); r = 0.0032 if canine else 0.0024
        me = cone(p, Vector((0, 0, sign)) * -1, h, r)             # upper teeth point DOWN, lower point UP
        bm_all.from_mesh(me); bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name); bm_all.to_mesh(me); bm_all.free()
    TEETH.append(add_prim(name, me, MAT_TEETH))
# tongue: bent ellipsoid on the cavity floor
ctr = sum(CREASE, Vector()) / NS
tipc = CREASE[NS // 2]; back = (CREASE[0] + CREASE[-1]) / 2
axis = (back - tipc); axis.z = 0; L = axis.length; axis.normalize()
bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
for v in bm.verts:
    x, y, z = v.co.x, v.co.y, v.co.z
    v.co = Vector((x * 0.022, y * (L * 0.42), z * 0.009 + 0.004 * (y * y)))   # width 4.4 cm, length ~half the mouth, thin, curled at the ends
    # curl the tip slightly up
me = bpy.data.meshes.new('Tongue'); bm.to_mesh(me); bm.free()
tongue = add_prim('Tongue', me, MAT_TONGUE)
rot = Matrix.Rotation(math.atan2(axis.x, -axis.y), 4, 'Z')          # local +y → forward (−y world) direction of the mouth
tongue.matrix_world = Matrix.Translation(tipc + axis * (L * 0.5) + Vector((0, 0, -0.016))) @ rot
for f in me.polygons: f.use_smooth = True
# smooth-shade teeth
for t in TEETH:
    for f in t.data.polygons: f.use_smooth = True

# ═══ 4. TEXTURE: UV + bake from the ORIGINAL ═══════════════════════════════════════════
activate(head)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode='OBJECT')
IMG_C = bpy.data.images.new('FoxSkin_BaseColor', BAKE, BAKE); IMG_N = bpy.data.images.new('FoxSkin_Normal', BAKE, BAKE, float_buffer=False)
IMG_N.colorspace_settings.name = 'Non-Color'
nt = MAT_SKIN.node_tree; bsdf = nt.nodes['Principled BSDF']
tc = nt.nodes.new('ShaderNodeTexImage'); tc.image = IMG_C; nt.links.new(tc.outputs['Color'], bsdf.inputs['Base Color'])
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = IMG_N; nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
bsdf.inputs['Roughness'].default_value = 0.85; bsdf.inputs['Metallic'].default_value = 0.0
if not NOBAKE:
    # the source material: metallic=1 + emissive would poison a diffuse bake → neutralise on the SOURCE copy
    for m in SRCOBJ.data.materials:
        if m and m.use_nodes:
            b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if b:
                b.inputs['Metallic'].default_value = 0
                for l in list(b.inputs['Metallic'].links): m.node_tree.links.remove(l)
                for l in list(b.inputs['Emission Strength'].links) if 'Emission Strength' in b.inputs else []: m.node_tree.links.remove(l)
                if 'Emission Strength' in b.inputs: b.inputs['Emission Strength'].default_value = 0
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 4; sc.cycles.use_denoising = False
    sc.render.bake.use_selected_to_active = True; sc.render.bake.cage_extrusion = 0.02; sc.render.bake.max_ray_distance = 0.05
    sc.render.bake.margin = 8; sc.render.bake.use_pass_direct = False; sc.render.bake.use_pass_indirect = False; sc.render.bake.use_pass_color = True
    # only the SKIN faces receive the bake (material slot 0): bake writes to the active image node of the active material
    bpy.ops.object.select_all(action='DESELECT'); SRCOBJ.select_set(True); head.select_set(True); bpy.context.view_layer.objects.active = head
    head.active_material_index = 0
    for n in nt.nodes: n.select = (n == tc)
    nt.nodes.active = tc
    t1 = time.time(); bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_selected_to_active=True, cage_extrusion=0.02, max_ray_distance=0.05, margin=8)
    log('baked base colour', round(time.time() - t1, 1), 's')
    for n in nt.nodes: n.select = (n == tn)
    nt.nodes.active = tn
    t1 = time.time(); bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', use_selected_to_active=True, cage_extrusion=0.02, max_ray_distance=0.05, margin=8)
    log('baked normal', round(time.time() - t1, 1), 's')
    IMG_C.filepath_raw = os.path.join(OUT, 'skin_basecolor.png'); IMG_C.file_format = 'PNG'; IMG_C.save()
    IMG_N.filepath_raw = os.path.join(OUT, 'skin_normal.png'); IMG_N.file_format = 'PNG'; IMG_N.save()
    IMG_C.pack(); IMG_N.pack()

# ═══ 5. EXPORT ═══════════════════════════════════════════════════════════════════════
# join teeth + tongue into the head (one SkinnedMesh later); keep material slots
activate(head)
for o in TEETH + [tongue]: o.select_set(True)
bpy.context.view_layer.objects.active = head
bpy.ops.object.join()
# tag vertex classes for the rig stage: skin / mouth / teeth_top / teeth_bot / tongue by material slot
slots = {m.name: i for i, m in enumerate(head.data.materials)}
cls = {}
for f in head.data.polygons:
    for vi in f.vertices: cls[vi] = f.material_index
# teeth rows: split by z against the crease line height
crease_z = float(np.mean([p.z for p in CREASE]))
vclass = []
for v in head.data.vertices:
    mi = cls.get(v.index, 0); name = head.data.materials[mi].name
    if name == 'FoxTeeth': name = 'FoxTeethTop' if v.co.z > crease_z else 'FoxTeethBot'
    vclass.append(name)
json.dump({'vclass': vclass, 'crease': [[round(c, 4) for c in p] for p in CREASE], 'u': U, 'lip_t': LIP_T, 'pivot': [round(c, 4) for c in PIV]}, open(os.path.join(OUT, 'rebuild.json'), 'w'))
bpy.ops.object.select_all(action='DESELECT'); head.select_set(True); bpy.context.view_layer.objects.active = head
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'head_rebuilt.glb'), export_format='GLB', use_selection=True, export_materials='EXPORT', export_image_format='AUTO', export_apply=False)
log('exported head_rebuilt.glb', os.path.getsize(os.path.join(OUT, 'head_rebuilt.glb')), 'B', len(head.data.vertices), 'verts', round(time.time() - T0, 1), 's')

if RENDER:
    sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE' if not NOBAKE else 'MATERIAL'
    if NOBAKE: MAT_SKIN.diffuse_color = (0.85, 0.6, 0.4, 1); MAT_MOUTH.diffuse_color = (0.32, 0.06, 0.07, 1); MAT_TEETH.diffuse_color = (0.93, 0.9, 0.82, 1); MAT_TONGUE.diffuse_color = (0.75, 0.25, 0.3, 1)
    sc.render.resolution_x = 1200; sc.render.resolution_y = 900
    sc.world = sc.world or bpy.data.worlds.new('W'); sc.world.color = (0.1, 0.1, 0.12)
    SRCOBJ.hide_render = True
    for n in nt.nodes: n.select = (n == tc)
    nt.nodes.active = tc
    c = sum(CREASE, Vector()) / NS
    def cam(view, center, size):
        cm = bpy.data.cameras.new('c'); cm.type = 'ORTHO'; cm.ortho_scale = size; co = bpy.data.objects.new('cam', cm); sc.collection.objects.link(co); sc.camera = co
        cv = Vector(center)
        if view == 'front':  co.location = cv + Vector((0, -3, 0)); co.rotation_euler = (math.pi / 2, 0, 0)
        if view == 'left':   co.location = cv + Vector((3, 0, 0)); co.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        if view == 'three':  co.location = cv + Vector((2.2, -2.2, 0.5)); co.rotation_euler = (math.radians(80), 0, math.radians(45))
        if view == 'frontlow': co.location = cv + Vector((0, -3, -1.3)); co.rotation_euler = (math.radians(113), 0, 0)
        return co
    for view, size, nm_ in (('front', 0.55, 'head'), ('three', 0.55, 'head'), ('frontlow', 0.22, 'mouth'), ('left', 0.22, 'mouth')):
        co = cam(view, (c.x, c.y + (0.12 if nm_ == 'head' else 0), c.z + (0.08 if nm_ == 'head' else 0)), size)
        sc.render.filepath = os.path.join(OUT, f'rebuild_{nm_}_{view}.png'); bpy.ops.render.render(write_still=True); bpy.data.objects.remove(co)
    log('renders written')
print('REBUILD_OK ' + json.dumps({'verts': len(head.data.vertices), 'faces': len(head.data.polygons), 'seconds': round(time.time() - T0, 1)}))
