# hopeOS — FACE RIG AUTHOR, stage 2: bones + weights + export (headless Blender 4.4)
# ═══════════════════════════════════════════════════════════════════════
# Consumes markers.json from facerig_author.py (stage 'markers') and the same
# GLB, then:
#   · builds (or reuses) the body armature — an existing rig's head bone is
#     detected from its vertex groups; an unrigged Meshy export gets a simple
#     hips/spine/chest/neck/head chain so the mesh becomes a SkinnedMesh
#   · adds Auto-Rig-Pro-style facial DEFORM bones at the markers
#       jaw.x (pivot→chin) ← lips_bot*, chin, tongue, teeth_bot
#       head ← lips_top*, lips_smile (corners: the runtime blends them 50 % with the jaw),
#              nose_*, nostril, cheek_*, eyebrow_01..04, eyelid_top/bot_01..03, eyelid_corner_01/02,
#              eye, ear_01/02, teeth_top
#   · authors PROCEDURAL skin weights: the jaw is cut along the lip line
#     (smoothstep band), each face bone takes a Gaussian share of its region
#     from its base bone (head / jaw), ≤ 4 influences, normalized
#   · renders check poses (jaw open, smile, brows, blink) and exports a GLB
#
#   blender -b --python facerig_rig.py -- in.glb markers.json out.glb outdir [--zmin 0.45] [--render]
import bpy, bmesh, sys, json, math, os
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, MK, OUTGLB, OUT = argv[0], argv[1], argv[2], argv[3]
opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
ZMIN = float(opt('--zmin', '0.45')); RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)
log = lambda *a: print('[facerig-rig]', *a)
M = {k: Vector(v) for k, v in json.load(open(MK)).items()}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)
MESH = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
ME = MESH.data; MW = MESH.matrix_world.copy()
ARM = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
M0 = {k: Vector(v) for k, v in json.load(open(MK)).items()}
# ── local SUBDIVISION of the face so the lip / lid bones have vertices to move (Meshy heads are ~2k verts):
#    pass 1: every face on the front half of the head; pass 2: faces within 5 cm of the mouth ring. Linear
#    (smoothness 0) so the 198 loose shells never open cracks and the marker surface stays put.
SUBDIV = int(opt('--subdiv', '2'))
if SUBDIV:
    jp = M0['jaw_pivot.x']; ring0 = [v for k, v in M0.items() if k.startswith('lips')]
    def sel_faces(pred):
        bpy.ops.object.mode_set(mode='OBJECT')
        for f in ME.polygons: f.select = pred(f)
        for e in ME.edges: e.select = False
        for v in ME.vertices: v.select = False
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE')
    bpy.context.view_layer.objects.active = MESH; MESH.select_set(True)
    n0 = len(ME.vertices)
    sel_faces(lambda f: all((MW @ ME.vertices[i].co).z > ZMIN - 0.02 and (MW @ ME.vertices[i].co).y < jp.y + 0.14 for i in f.vertices))
    bpy.ops.mesh.subdivide(number_cuts=1, smoothness=0); bpy.ops.object.mode_set(mode='OBJECT')
    if SUBDIV > 1:
        near = lambda p: min((p - r).length for r in ring0) < 0.05
        sel_faces(lambda f: all(near(MW @ ME.vertices[i].co) for i in f.vertices))
        bpy.ops.mesh.subdivide(number_cuts=1, smoothness=0); bpy.ops.object.mode_set(mode='OBJECT')
    log('subdivided face region:', n0, '→', len(ME.vertices), 'verts')
    # the glTF import brought CUSTOM SPLIT NORMALS; subdividing leaves the new loops with broken ones (dark
    # jagged patches in three.js) → drop them and shade smooth: the fur texture carries the look anyway
    bpy.ops.object.mode_set(mode='OBJECT')
    try: bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception as e: log('custom normals clear:', e)
    for f in ME.polygons: f.use_smooth = True
    ME.update()
P = np.array([[*(MW @ v.co)] for v in ME.vertices], np.float64)   # world positions
NV = len(P)
bm = bmesh.new(); bm.from_mesh(ME); bmesh.ops.triangulate(bm, faces=bm.faces[:]); BVH = BVHTree.FromBMesh(bm)

# ── colour classes for teeth / tongue masks (base colour at each vertex) ──
IMG = None
for m in ME.materials:
    if m and m.use_nodes:
        b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if b and b.inputs['Base Color'].links and b.inputs['Base Color'].links[0].from_node.type == 'TEX_IMAGE': IMG = b.inputs['Base Color'].links[0].from_node.image; break
VCOL = np.full((NV, 3), 0.5)
if IMG and ME.uv_layers.active:
    IMG = IMG.copy()
    if IMG.size[0] > 1024: IMG.scale(1024, 1024)
    IW, IH = IMG.size; PIX = np.empty(IW * IH * 4, np.float32); IMG.pixels.foreach_get(PIX); PIX = PIX.reshape(IH, IW, 4)
    uv = ME.uv_layers.active.data
    for poly in ME.polygons:
        for li in poly.loop_indices:
            vi = ME.loops[li].vertex_index; u, v = uv[li].uv
            VCOL[vi] = PIX[int((v % 1) * IH) % IH, int((u % 1) * IW) % IW, :3]
lum = VCOL.mean(axis=1); satv = VCOL.max(axis=1) - VCOL.min(axis=1)
is_white = (lum > 0.72) & (satv < 0.16)
is_pink = (VCOL[:, 0] > 0.55) & (VCOL[:, 1] < 0.5) & (VCOL[:, 2] > 0.3) & (VCOL[:, 0] - VCOL[:, 1] > 0.2)

# ── key points ──
TIP_X = (M['lips_smile.l'].x + M['lips_smile.r'].x) / 2
JAW_PIV = M['jaw_pivot.x']; CHIN = M['chin_01.x']
CORNER = {'l': M['lips_smile.l'], 'r': M['lips_smile.r']}
NOSE = M['nose_tip.x']
EYE_C = {s: M[f'eye_center.{s}'] for s in 'lr' if f'eye_center.{s}' in M}

# ── the LIP LINE as a function of angle around the jaw pivot (top view), z of the mouth mid-line ──
ring = []
for s, sgn in (('l', 1), ('r', -1)):
    for n in ('01', '02', '03'):
        t, b_ = M.get(f'lips_top_{n}.{s}'), M.get(f'lips_bot_{n}.{s}')
        if t and b_: ring.append(((t + b_) / 2))
    ring.append(CORNER[s])
ring.append((M['lips_top.x'] + M['lips_bot.x']) / 2)
ang = lambda p: math.atan2(p.x - JAW_PIV.x, -(p.y - JAW_PIV.y))            # 0 = straight ahead, + = left
ring.sort(key=ang)
RA = [ang(p) for p in ring]; RZ = [p.z for p in ring]
A_L, A_R = ang(CORNER['l']), ang(CORNER['r'])
def line_z(p):
    a = ang(p)
    if a <= RA[0]: return RZ[0] - 0.02 * min(1, (RA[0] - a) / 0.6)      # behind the corner: the jaw body drops a little
    if a >= RA[-1]: return RZ[-1] - 0.02 * min(1, (a - RA[-1]) / 0.6)
    for i in range(len(RA) - 1):
        if RA[i] <= a <= RA[i + 1]:
            f = (a - RA[i]) / max(1e-9, RA[i + 1] - RA[i]); return RZ[i] * (1 - f) + RZ[i + 1] * f
    return RZ[-1]
smooth = lambda a, b, x: (lambda t: t * t * (3 - 2 * t))(min(1, max(0, (x - a) / (b - a))))

# ── armature ──
if ARM is None:
    log('no armature in the GLB → building a hips/spine/chest/neck/head chain')
    arm = bpy.data.armatures.new('FoxArmature'); ARM = bpy.data.objects.new('FoxArmature', arm); bpy.context.scene.collection.objects.link(ARM)
    zlo = P[:, 2].min(); neck_z = ZMIN + 0.07; head_top = P[:, 2].max()
    cy = float(P[P[:, 2] > ZMIN - 0.1][:, 1].mean())
    chain = [('hips', (0, cy, zlo + 0.9 * (ZMIN - zlo) * 0.45), (0, cy, zlo + (ZMIN - zlo) * 0.62)),
             ('spine', None, (0, cy, zlo + (ZMIN - zlo) * 0.82)),
             ('chest', None, (0, cy, ZMIN - 0.08)),
             ('neck', None, (TIP_X, JAW_PIV.y, ZMIN + 0.03)),
             ('head', None, (TIP_X, JAW_PIV.y - 0.02, head_top - 0.12))]
    bpy.context.view_layer.objects.active = ARM; bpy.ops.object.mode_set(mode='EDIT')
    prev = None
    for name, h, t in chain:
        eb = arm.edit_bones.new(name); eb.head = Vector(h) if h else prev.tail; eb.tail = Vector(t); eb.use_deform = True
        if prev: eb.parent = prev; eb.use_connect = True
        prev = eb
    bpy.ops.object.mode_set(mode='OBJECT')
    HEAD_NAME = 'head'; BODY_NEW = True
else:
    # existing rig: the head bone = the deform bone whose vertex group covers the most head-region vertices
    best = None
    for vg in MESH.vertex_groups:
        n = 0
        for i in range(NV):
            if P[i, 2] < ZMIN: continue
            try: n += vg.weight(i) > 0.3
            except RuntimeError: pass
        if best is None or n > best[1]: best = (vg.name, n)
    HEAD_NAME = best[0]; BODY_NEW = False
    log('existing armature', ARM.name, 'head bone =', HEAD_NAME)
arm = ARM.data

# ── facial deform bones ──
FACE = []   # (name, head, tail, parent)
def B(name, head, tail, parent): FACE.append((name, Vector(head), Vector(tail), parent))
inward = lambda p, k=0.012: p + (JAW_PIV - p).normalized() * k
B('jaw.x', JAW_PIV, CHIN, HEAD_NAME)
B('chin_01.x', CHIN, M['chin_02.x'], 'jaw.x')
B('lips_top.x', M['lips_top.x'], inward(M['lips_top.x']), HEAD_NAME)
B('lips_bot.x', M['lips_bot.x'], inward(M['lips_bot.x']), 'jaw.x')
for s in 'lr':
    B(f'lips_smile.{s}', CORNER[s], inward(CORNER[s]), HEAD_NAME)
    for n in ('01', '02', '03'):
        B(f'lips_top_{n}.{s}', M[f'lips_top_{n}.{s}'], inward(M[f'lips_top_{n}.{s}']), HEAD_NAME)
        B(f'lips_bot_{n}.{s}', M[f'lips_bot_{n}.{s}'], inward(M[f'lips_bot_{n}.{s}']), 'jaw.x')
    B(f'cheek_smile.{s}', M[f'cheek_smile.{s}'], inward(M[f'cheek_smile.{s}'], 0.02), HEAD_NAME)
    B(f'cheek_inflate.{s}', M[f'cheek_inflate.{s}'], inward(M[f'cheek_inflate.{s}'], 0.02), HEAD_NAME)
    B(f'nostril.{s}', M[f'nostril.{s}'], inward(M[f'nostril.{s}'], 0.01), HEAD_NAME)
    for n in ('01', '02', '03', '04'):
        B(f'eyebrow_{n}.{s}', M[f'eyebrow_{n}.{s}'], inward(M[f'eyebrow_{n}.{s}'], 0.012), HEAD_NAME)
    if s in EYE_C:
        ec = EYE_C[s]; B(f'eye.{s}', ec + (JAW_PIV - ec).normalized() * 0.02, ec, HEAD_NAME)
        for n in ('01', '02', '03'):
            B(f'eyelid_top_{n}.{s}', M[f'eyelid_top_{n}.{s}'], inward(M[f'eyelid_top_{n}.{s}'], 0.008), HEAD_NAME)
            B(f'eyelid_bot_{n}.{s}', M[f'eyelid_bot_{n}.{s}'], inward(M[f'eyelid_bot_{n}.{s}'], 0.008), HEAD_NAME)
        B(f'eyelid_corner_01.{s}', M[f'eyelid_corner_01.{s}'], inward(M[f'eyelid_corner_01.{s}'], 0.008), HEAD_NAME)
        B(f'eyelid_corner_02.{s}', M[f'eyelid_corner_02.{s}'], inward(M[f'eyelid_corner_02.{s}'], 0.008), HEAD_NAME)
    e1, e2 = M[f'ear_01.{s}'], M[f'ear_02.{s}']; mid = (e1 + e2) / 2
    B(f'ear_01.{s}', e1, mid, HEAD_NAME); B(f'ear_02.{s}', mid, e2, f'ear_01.{s}')
for n in ('01', '02', '03'): B(f'nose_{n}.x', M[f'nose_{n}.x'], inward(M[f'nose_{n}.x'], 0.015), HEAD_NAME)
B('nose_tip.x', NOSE, inward(NOSE, 0.012), HEAD_NAME)
if 'teeth_top.x' in M: B('teeth_top.x', M['teeth_top.x'], inward(M['teeth_top.x'], 0.01), HEAD_NAME)
if 'teeth_bot.x' in M: B('teeth_bot.x', M['teeth_bot.x'], inward(M['teeth_bot.x'], 0.01), 'jaw.x')
if 'tongue_01.x' in M:
    t1, t2 = M['tongue_01.x'], M.get('tongue_02.x', M['tongue_01.x'] + Vector((0, -0.03, 0)))
    root = t1 + (t1 - t2).normalized() * 0.035
    B('tongue_01.x', root, t1, 'jaw.x'); B('tongue_02.x', t1, t2, 'tongue_01.x')

bpy.context.view_layer.objects.active = ARM; ARM.select_set(True); bpy.ops.object.mode_set(mode='EDIT')
AI = ARM.matrix_world.inverted()
for name, h, t, par in FACE:
    eb = arm.edit_bones.new(name); eb.head = AI @ h; eb.tail = AI @ t; eb.use_deform = True
    eb.parent = arm.edit_bones[par]; eb.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
log('face bones', len(FACE), '→ total', len(arm.bones))

# ── weights ──
# base assignment: existing weights (rigged input) or the new chain by z; then the jaw cut; then face bones
W = {}                    # bone name → np array (NV)
def arr(n):
    if n not in W: W[n] = np.zeros(NV)
    return W[n]
if BODY_NEW:
    zlo = P[:, 2].min(); z = P[:, 2]
    bounds = [('hips', -1e9, zlo + (ZMIN - zlo) * 0.62), ('spine', None, zlo + (ZMIN - zlo) * 0.82), ('chest', None, ZMIN - 0.08), ('neck', None, ZMIN + 0.03), ('head', None, 1e9)]   # the head starts just above the chin
    prev_top = -1e9
    for k, (n, _, top) in enumerate(bounds):
        w = np.ones(NV)
        if k > 0: w *= smooth(prev_top - 0.03, prev_top + 0.03, 0) * 0 + np.vectorize(lambda zz: smooth(prev_top - 0.03, prev_top + 0.03, zz))(z)
        if k < len(bounds) - 1: w *= np.vectorize(lambda zz: 1 - smooth(top - 0.03, top + 0.03, zz))(z)
        arr(n)[:] = w; prev_top = top
else:
    for vg in MESH.vertex_groups:
        a = arr(vg.name)
        for i in range(NV):
            try: a[i] = vg.weight(i)
            except RuntimeError: pass
HEAD_W = arr(HEAD_NAME).copy()
# jaw cut: head-region vertices in front of the pivot and below the lip line
jaw = arr('jaw.x')
for i in range(NV):
    if HEAD_W[i] < 1e-4: continue
    p = Vector(P[i])
    if p.y > JAW_PIV.y + 0.02 or p.z > JAW_PIV.z + 0.03: continue
    lz = line_z(p)
    a = ang(p); beyond = max(0.0, A_R - a, a - A_L)                        # radians past the nearest commissure
    bh = 0.012 + 0.04 * min(1.0, beyond / 0.7)                            # 1.2 cm band at the lips → 5 cm behind the corners
    f = 1 - smooth(lz - bh, lz + bh, p.z)                                 # 1 = below the lip line
    # fade the jaw share toward the pivot / rear of the mandible so the hinge blends into the cheek
    dback = max(0.0, 1 - (JAW_PIV.y - p.y) / 0.08) if p.y > JAW_PIV.y - 0.08 else 0.0
    f *= 1 - dback
    if is_white[i] or is_pink[i]:                                       # teeth / tongue: by side of the line, hard
        f = 1.0 if p.z < lz else 0.0
    jaw[i] = HEAD_W[i] * f; W[HEAD_NAME][i] = HEAD_W[i] * (1 - f)
log('jaw verts', int((jaw > 0.3).sum()))
BASE = {n: W[n].copy() for n in W}   # after the jaw cut: the base pool each face bone draws from
# face bone kernels: (name, centre, radius, base bone, mask fn)
D = lambda c: np.linalg.norm(P - np.array([*c]), axis=1)
lipline_d = np.array([abs(P[i, 2] - line_z(Vector(P[i]))) if P[i, 1] < JAW_PIV.y else 1 for i in range(NV)])
near_mouth = (lipline_d < 0.035)
K = []
def kern(name, c, r, base, mask=None): K.append((name, c, r, base, mask))
for n, h, t, par in FACE:
    c = h
    if n.startswith('lips_smile'): kern(n, c, 0.022, 'both', near_mouth)
    elif n.startswith('lips_top'): kern(n, c, 0.016, HEAD_NAME, near_mouth & (P[:, 2] >= np.array([line_z(Vector(P[i])) - 0.004 for i in range(NV)])))
    elif n.startswith('lips_bot'): kern(n, c, 0.016, 'jaw.x', near_mouth & (P[:, 2] <= np.array([line_z(Vector(P[i])) + 0.004 for i in range(NV)])))
    elif n.startswith('chin'): kern(n, c, 0.025, 'jaw.x', None)
    elif n.startswith('cheek_smile'): kern(n, c, 0.03, HEAD_NAME, ~near_mouth)
    elif n.startswith('cheek_inflate'): kern(n, c, 0.03, HEAD_NAME, ~near_mouth)
    elif n.startswith('nostril'): kern(n, c, 0.012, HEAD_NAME, None)
    elif n.startswith('nose_tip'): kern(n, c, 0.014, HEAD_NAME, None)
    elif n.startswith('nose_'): kern(n, c, 0.02, HEAD_NAME, None)
    elif n.startswith('eyebrow'): kern(n, c, 0.016, HEAD_NAME, None)
    elif n.startswith('eyelid'): kern(n, c, 0.011, HEAD_NAME, None)
    elif n.startswith('eye.'):
        s = n[-1]; ec = EYE_C[s]
        kern(n, ec, 0.03, HEAD_NAME, (D(ec) < 0.028))                   # the eyeball region inside the lid ring
    elif n.startswith('ear_01'): kern(n, (h + t) / 2, 0.045, HEAD_NAME, (P[:, 2] > h.z - 0.02) & (np.sign(P[:, 0] - TIP_X) == np.sign(h.x - TIP_X)))
    elif n.startswith('ear_02'): kern(n, (h + t) / 2, 0.05, HEAD_NAME, (P[:, 2] > h.z - 0.01) & (np.sign(P[:, 0] - TIP_X) == np.sign(h.x - TIP_X)))
    elif n.startswith('teeth_top'): kern(n, c, 0.03, HEAD_NAME, is_white & near_mouth)
    elif n.startswith('teeth_bot'): kern(n, c, 0.03, 'jaw.x', is_white & near_mouth)
    elif n.startswith('tongue_01'): kern(n, (h + t) / 2, 0.03, 'jaw.x', is_pink)
    elif n.startswith('tongue_02'): kern(n, t, 0.025, 'jaw.x', is_pink)
    elif n == 'jaw.x': pass
face_w = {}
for name, c, r, base, mask in K:
    d = D(c); w = np.exp(-(d / r) ** 2 * 1.4); w[d > 2.2 * r] = 0
    if mask is not None: w = w * mask
    face_w[name] = (w, base)
# every face bone draws from its base bone's pool; the pool cannot go negative. 'both' bones (the
# commissures) take their share from whichever pool the vertex sits in, so the corner region moves as one.
for name in list(face_w):
    if face_w[name][1] == 'both':
        w = face_w.pop(name)[0]; face_w[name + '@head'] = (w, HEAD_NAME); face_w[name + '@jaw'] = (w, 'jaw.x')
for base in (HEAD_NAME, 'jaw.x'):
    names = [n for n, (w, b) in face_w.items() if b == base]
    tot = sum(face_w[n][0] for n in names)
    share = np.minimum(1.0, tot)
    pool = BASE[base]
    for n in names:
        w = face_w[n][0]
        arr(n.split('@')[0])[:] += np.where(tot > 1e-9, pool * share * w / np.maximum(tot, 1e-9), 0)
    W[base] = pool * (1 - share)
face_w = {n.split('@')[0]: (w, b) for n, (w, b) in face_w.items()}
# limit to 4 influences per vertex + normalize
names = list(W.keys()); Wm = np.stack([W[n] for n in names], axis=1)
for i in range(NV):
    row = Wm[i]
    if (row > 1e-5).sum() > 4:
        idx = np.argsort(row)[:-4]; row[idx] = 0
    s = row.sum()
    Wm[i] = row / s if s > 1e-9 else 0
if BODY_NEW:
    for vg in list(MESH.vertex_groups): MESH.vertex_groups.remove(vg)
for k, n in enumerate(names):
    vg = MESH.vertex_groups.get(n) or MESH.vertex_groups.new(name=n)
    nz = np.nonzero(Wm[:, k] > 1e-5)[0]
    if BODY_NEW or n in face_w or n in (HEAD_NAME, 'jaw.x'):
        vg.remove(list(range(NV)))
        for i in nz: vg.add([int(i)], float(Wm[i, k]), 'REPLACE')
counts = {n: int((Wm[:, k] > 0.2).sum()) for k, n in enumerate(names)}
log('vertex counts (w>0.2):', json.dumps({k: v for k, v in counts.items() if k in face_w or k in (HEAD_NAME, 'jaw.x')}))
# armature modifier / parent
if not any(m.type == 'ARMATURE' for m in MESH.modifiers):
    mod = MESH.modifiers.new('Armature', 'ARMATURE'); mod.object = ARM
MESH.parent = ARM

# ── check-pose renders ──
def render_pose(tag, poses, center, size, views=('front', 'left', 'three')):
    sc = bpy.context.scene
    bpy.context.view_layer.objects.active = ARM; bpy.ops.object.mode_set(mode='POSE')
    for pb in ARM.pose.bones: pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.rotation_mode = 'QUATERNION'
    for name, loc, rot in poses:
        pb = ARM.pose.bones[name]
        if loc: pb.location = pb.bone.matrix_local.to_3x3().inverted() @ Vector(loc)      # world-axis delta → bone local
        if rot: pb.rotation_quaternion = (pb.bone.matrix_local.to_3x3().inverted().to_quaternion() @ rot.to_quaternion() @ pb.bone.matrix_local.to_3x3().to_quaternion())
    bpy.ops.object.mode_set(mode='OBJECT')
    for view in views:
        c = bpy.data.cameras.new('c'); c.type = 'ORTHO'; c.ortho_scale = size; co = bpy.data.objects.new('cam', c); sc.collection.objects.link(co); sc.camera = co
        cv = Vector(center)
        if view == 'front':  co.location = cv + Vector((0, -3, 0)); co.rotation_euler = (math.pi / 2, 0, 0)
        if view == 'left':   co.location = cv + Vector((3, 0, 0)); co.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        if view == 'three':  co.location = cv + Vector((2.2, -2.2, 0.5)); co.rotation_euler = (math.radians(80), 0, math.radians(45))
        if view == 'frontlow': co.location = cv + Vector((0, -3, -1.3)); co.rotation_euler = (math.radians(113), 0, 0)
        sc.render.filepath = os.path.join(OUT, f'pose_{tag}_{view}.png'); bpy.ops.render.render(write_still=True); bpy.data.objects.remove(co)
if RENDER:
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x = 1400; sc.render.resolution_y = 1000
    sc.world = bpy.data.worlds.new('W'); sc.world.color = (0.12, 0.12, 0.14)
    for m in ME.materials:
        if m and m.use_nodes:
            b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if b:
                b.inputs['Metallic'].default_value = 0
                l = b.inputs['Base Color'].links
                if l and l[0].from_node.type == 'TEX_IMAGE':
                    for n in m.node_tree.nodes: n.select = (n == l[0].from_node)
                    m.node_tree.nodes.active = l[0].from_node
    head_c = (TIP_X, NOSE.y + 0.16, (NOSE.z + EYE_C['l'].z) / 2 if 'l' in EYE_C else NOSE.z + 0.06)
    open_rot = Matrix.Rotation(math.radians(-22), 4, 'X')                     # about world X: chin drops (checked by the render)
    render_pose('rest', [], head_c, 0.5)
    render_pose('open', [('jaw.x', None, open_rot)], head_c, 0.5)
    render_pose('open2', [('jaw.x', None, Matrix.Rotation(math.radians(22), 4, 'X'))], head_c, 0.5, views=('left',))
    back = 0.025
    render_pose('smile', [('lips_smile.l', (0, back, 0.012), None), ('lips_smile.r', (0, back, 0.012), None), ('lips_top_03.l', (0, back * 0.6, 0.008), None), ('lips_top_03.r', (0, back * 0.6, 0.008), None), ('cheek_smile.l', (0, 0.01, 0.012), None), ('cheek_smile.r', (0, 0.01, 0.012), None)], head_c, 0.5)
    render_pose('pucker', [('lips_top.x', (0, -0.02, 0), None), ('lips_bot.x', (0, -0.02, 0), None), ('lips_top_01.l', (0, -0.014, 0), None), ('lips_top_01.r', (0, -0.014, 0), None), ('lips_bot_01.l', (0, -0.014, 0), None), ('lips_bot_01.r', (0, -0.014, 0), None), ('lips_smile.l', (0, -0.012, 0), None), ('lips_smile.r', (0, -0.012, 0), None)], head_c, 0.5, views=('left', 'three'))
    render_pose('brows_blink', [(f'eyebrow_{n}.{s}', (0, 0, 0.02), None) for s in 'lr' for n in ('01', '02', '03', '04')] + [(f'eyelid_top_{n}.l', (0, 0, -0.02), None) for n in ('01', '02', '03')] + [('ear_01.l', None, Matrix.Rotation(math.radians(30), 4, 'Y'))], head_c, 0.5, views=('front', 'three'))
    render_pose('rest2', [], head_c, 0.5, views=('front',))
    log('pose renders written')

# ── export ──
bpy.ops.object.select_all(action='DESELECT'); MESH.select_set(True); ARM.select_set(True); bpy.context.view_layer.objects.active = ARM
bpy.ops.export_scene.gltf(filepath=OUTGLB, export_format='GLB', use_selection=True, export_skins=True, export_all_influences=False,
                          export_animations=False, export_apply=False, export_yup=True, export_image_format='AUTO', export_texcoords=True, export_normals=True, export_materials='EXPORT')
log('exported', OUTGLB, os.path.getsize(OUTGLB))
print('FACERIG_RIG_OK ' + json.dumps({'bones': len(arm.bones), 'face_bones': len(FACE), 'head': HEAD_NAME, 'counts': counts}))
