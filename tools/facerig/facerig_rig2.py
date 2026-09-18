# hopeOS — FACE RIG, stage 3 (headless Blender 4.4): bones + SMOOTH weights on the REBUILT head, body from the original.
# ═══════════════════════════════════════════════════════════════════════════════════════════
#   body   = the original Meshy mesh minus its head faces (rigid: hips/spine/chest/neck bands)
#   head   = head_rebuilt.glb (closed quad mesh, cut mouth, cavity, teeth, tongue; baked textures)
#   bones  = ARP-style facial deform bones at the markers (same names/contract as arp-face-driver.js)
#   weights= numpy DIFFUSION on the head's own vertex graph:
#            · jaw: 1 below the lip line / 0 above, then Laplacian-smoothed along the SURFACE — the mouth
#              slit breaks the graph, so the transition runs around the commissures, not across the lips
#            · every face bone: Gaussian seed (radius per region, masked to its side of the slit and
#              material class) → smoothed → takes its share from the head/jaw pool (partition of unity)
#            · teeth: rigid (top → head, bottom → jaw); tongue: two bones blended along its length
#   export = sdk/assets/avatars/foxfull_face.glb (two skinned meshes, one armature, 4 influences)
#
#   blender -b --python facerig_rig2.py -- body.glb head_rebuilt.glb markers.json rebuild.json out.glb outdir [--zmin 0.45] [--render]
import bpy, bmesh, sys, json, math, os, time
import numpy as np
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
BODY_SRC, HEAD_SRC, MK, RB, OUTGLB, OUT = argv[:6]
opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
ZMIN = float(opt('--zmin', '0.45')); RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)
log = lambda *a: print('[rig2]', *a, flush=True)
T0 = time.time()
M = {k: Vector(v) for k, v in json.load(open(MK)).items()}
R = json.load(open(RB))
CREASE = [Vector(p) for p in R['crease']]; U = R['u']

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
def activate(o):
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o

# ── body: original minus head ──
bpy.ops.import_scene.gltf(filepath=BODY_SRC)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)
BODY = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices)); BODY.name = 'Body'
activate(BODY)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
for f in BODY.data.polygons: f.select = all((BODY.matrix_world @ BODY.data.vertices[i].co).z > ZMIN - 0.02 for i in f.vertices)   # the head mesh starts at ZMIN − 2 cm
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE'); bpy.ops.mesh.delete(type='FACE'); bpy.ops.object.mode_set(mode='OBJECT')
log('body', len(BODY.data.vertices), 'verts (head faces removed)')
# ── head ──
before = set(o.name for o in bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=HEAD_SRC)
HEAD = [o for o in bpy.data.objects if o.name not in before and o.type == 'MESH'][0]; HEAD.name = 'Head'
# the glTF round trip split vertices along UV-island seams; weld them back (UVs live on loops, so they survive)
# — otherwise the two copies of a seam vertex diffuse with different neighbours and the skin tears along the islands
n0 = len(HEAD.data.vertices); activate(HEAD)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.remove_doubles(threshold=1e-5, use_unselected=False); bpy.ops.object.mode_set(mode='OBJECT')
log('welded UV-seam duplicates:', n0, '→', len(HEAD.data.vertices))
NV = len(HEAD.data.vertices)
P = np.array([[*(HEAD.matrix_world @ v.co)] for v in HEAD.data.vertices])
# vertex classes from the MATERIAL slots (the glTF round trip splits vertices at UV seams, so rebuild.json's
# per-index classes no longer line up); teeth rows split by the crease height
crease_z = float(np.mean([p.z for p in CREASE]))
matn = [m.name.split('.')[0] if m else 'FoxSkin' for m in HEAD.data.materials]
VCLASS = ['FoxSkin'] * NV
for f in HEAD.data.polygons:
    n = matn[f.material_index] if f.material_index < len(matn) else 'FoxSkin'
    for vi in f.vertices: VCLASS[vi] = n
VCLASS = [('FoxTeethTop' if P[i, 2] > crease_z else 'FoxTeethBot') if c == 'FoxTeeth' else c for i, c in enumerate(VCLASS)]
log('head', NV, 'verts; classes', {c: VCLASS.count(c) for c in set(VCLASS)})

# ── key points ──
TIP_X = (M['lips_smile.l'].x + M['lips_smile.r'].x) / 2
JAW_PIV = M['jaw_pivot.x']; CHIN = M['chin_01.x']; NOSE = M['nose_tip.x']
CORNER = {'l': M['lips_smile.l'], 'r': M['lips_smile.r']}
EYE_C = {s: M[f'eye_center.{s}'] for s in 'lr'}
ang = lambda p: math.atan2(p.x - JAW_PIV.x, -(p.y - JAW_PIV.y))
CA = np.array([ang(p) for p in CREASE]); CZ = np.array([p.z for p in CREASE])
A_R, A_L = CA[0], CA[-1]
def line_z(p):
    a = ang(p)
    if a <= CA[0]: return CZ[0] - 0.015 * min(1, (CA[0] - a) / 0.6)
    if a >= CA[-1]: return CZ[-1] - 0.015 * min(1, (a - CA[-1]) / 0.6)
    return float(np.interp(a, CA, CZ))
smooth = lambda a, b, x: (lambda t: t * t * (3 - 2 * t))(min(1, max(0, (x - a) / (b - a))))
LZ = np.array([line_z(Vector(p)) for p in P])
ANG = np.array([ang(Vector(p)) for p in P])
BEYOND = np.maximum(0, np.maximum(A_R - ANG, ANG - A_L))          # radians past the nearest commissure
IN_FRONT = P[:, 1] < JAW_PIV.y + 0.02

# ── armature ──
arm = bpy.data.armatures.new('FoxArmature'); ARM = bpy.data.objects.new('FoxArmature', arm); sc.collection.objects.link(ARM)
PB = np.array([[*(BODY.matrix_world @ v.co)] for v in BODY.data.vertices])
zlo = PB[:, 2].min(); cy = float(PB[PB[:, 2] > ZMIN - 0.1][:, 1].mean()); head_top = P[:, 2].max()
chain = [('hips', (0, cy, zlo + (ZMIN - zlo) * 0.45), (0, cy, zlo + (ZMIN - zlo) * 0.62)), ('spine', None, (0, cy, zlo + (ZMIN - zlo) * 0.82)),
         ('chest', None, (0, cy, ZMIN - 0.08)), ('neck', None, (TIP_X, JAW_PIV.y, ZMIN + 0.03)), ('head', None, (TIP_X, JAW_PIV.y - 0.02, head_top - 0.12))]
activate(ARM); bpy.ops.object.mode_set(mode='EDIT')
prev = None
for name, h, t in chain:
    eb = arm.edit_bones.new(name); eb.head = Vector(h) if h else prev.tail; eb.tail = Vector(t); eb.use_deform = True
    if prev: eb.parent = prev; eb.use_connect = True
    prev = eb
HEAD_NAME = 'head'
FACE = []
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
B('teeth_top.x', M['teeth_top.x'], inward(M['teeth_top.x'], 0.01), HEAD_NAME)
B('teeth_bot.x', M['teeth_bot.x'], inward(M['teeth_bot.x'], 0.01), 'jaw.x')
# tongue bones from the rebuilt tongue geometry (class FoxTongue): root at its back, tip at its front
TG = np.array([i for i, c in enumerate(VCLASS) if c == 'FoxTongue'])
tg_back = Vector(P[TG][P[TG][:, 1].argmax()]); tg_front = Vector(P[TG][P[TG][:, 1].argmin()]); tg_mid = (tg_back + tg_front) / 2
B('tongue_01.x', tg_back, tg_mid, 'jaw.x'); B('tongue_02.x', tg_mid, tg_front, 'tongue_01.x')
AI = ARM.matrix_world.inverted()
for name, h, t, par in FACE:
    eb = arm.edit_bones.new(name); eb.head = AI @ h; eb.tail = AI @ t; eb.use_deform = True
    eb.parent = arm.edit_bones[par]; eb.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
log('bones', len(arm.bones))

# ── head vertex graph (for surface diffusion) ──
E = np.array([[e.vertices[0], e.vertices[1]] for e in HEAD.data.edges])
DEG = np.bincount(E.ravel(), minlength=NV).astype(np.float64); DEG[DEG == 0] = 1
def diffuse(w, iters, lam=0.6, fixed=None):
    """Jacobi smoothing of a per-vertex field along the mesh graph (uniform Laplacian); fixed = mask kept as-is"""
    w = w.astype(np.float64).copy()
    for _ in range(iters):
        s = np.zeros(NV); np.add.at(s, E[:, 0], w[E[:, 1]]); np.add.at(s, E[:, 1], w[E[:, 0]])
        nb = s / DEG; w2 = w + lam * (nb - w)
        if fixed is not None: w2[fixed] = w[fixed]
        w = w2
    return w
cls = np.array(VCLASS)
SKIN = cls == 'FoxSkin'; MOUTH = cls == 'FoxMouth'; TTOP = cls == 'FoxTeethTop'; TBOT = cls == 'FoxTeethBot'; TONG = cls == 'FoxTongue'
# ── jaw field ──
below = (P[:, 2] < LZ)
band = 0.003 + 0.047 * np.minimum(1.0, BEYOND / 0.15)             # blend half-width: 3 mm at the slit → 5 cm within ~9° behind the commissures
jaw0 = np.array([1 - smooth(LZ[i] - band[i], LZ[i] + band[i], P[i, 2]) for i in range(NV)])
jaw0[BEYOND == 0] = (P[BEYOND == 0, 2] < LZ[BEYOND == 0]).astype(float)   # in front of the commissures the SLIT is the split: hard by side
jaw0 *= IN_FRONT
# fade to the head at the back of the mandible (towards the pivot / ear base)
depth = np.clip((JAW_PIV.y - P[:, 1]) / 0.10, 0, 1)             # 0 at the pivot line, 1 ≥ 10 cm in front
jaw0 *= depth ** 0.5
# hard classes: mouth interior by side of the line, teeth rigid, tongue → jaw pool
jaw0[MOUTH] = (P[MOUTH, 2] < LZ[MOUTH]).astype(float)
jaw0[TTOP] = 0; jaw0[TBOT] = 1; jaw0[TONG] = 1
# Dirichlet pins: in front of the commissures only the ±1.5 cm band around the slit may blend (the slit already
# separates the lips); the skull top and the region at/behind the pivot never take jaw weight
fixed = TTOP | TBOT | TONG | (BEYOND == 0) | (P[:, 1] > JAW_PIV.y - 0.02)   # only the region behind the commissures diffuses
jaw0[P[:, 1] > JAW_PIV.y - 0.02] = 0                                # pinned pivot / ear-base region is head
JAW = np.clip(diffuse(jaw0, 30, 0.5, fixed), 0, 1)
# diagnostic: where does the field still jump across an edge?
dJ = np.abs(JAW[E[:, 0]] - JAW[E[:, 1]]); bad = np.nonzero(dJ > 0.3)[0]
if bad.size:
    bp = (P[E[bad, 0]] + P[E[bad, 1]]) / 2
    log('jaw jumps > .3 across', bad.size, 'edges; centroid', [round(float(v), 3) for v in bp.mean(axis=0)], 'y range', round(float(bp[:, 1].min()), 3), round(float(bp[:, 1].max()), 3), 'z range', round(float(bp[:, 2].min()), 3), round(float(bp[:, 2].max()), 3), 'classes', {c: int((cls[E[bad, 0]] == c).sum()) for c in set(cls[E[bad, 0]])})
# the interior stays crisp: palate → head, floor → jaw (5 mm soft band at the line), so the cavity never smears
JAW[MOUTH] = (P[MOUTH, 2] < LZ[MOUTH]).astype(float)   # hard by side: palate → head, floor → jaw; the one wall row across the line stretches inside
front = (BEYOND == 0) & SKIN
up = front & (P[:, 2] > LZ + 0.003) & (P[:, 2] < LZ + 0.015); lo = front & (P[:, 2] < LZ - 0.003) & (P[:, 2] > LZ - 0.015)
log('slit check: upper-lip JAW mean', round(float(JAW[up].mean()), 3), 'n', int(up.sum()), '| lower-lip JAW mean', round(float(JAW[lo].mean()), 3), 'n', int(lo.sum()), '| seed upper', round(float(jaw0[up].mean()), 3), 'seed lower', round(float(jaw0[lo].mean()), 3))
# graph links between the two lips? edges that cross the line in front of the commissures
cross = front[E[:, 0]] & front[E[:, 1]] & ((P[E[:, 0], 2] - LZ[E[:, 0]]) * (P[E[:, 1], 2] - LZ[E[:, 1]]) < 0) & (np.abs(P[E[:, 0], 2] - P[E[:, 1], 2]) > 0.004)
log('edges crossing the slit line in front:', int(cross.sum()))
near = front & (np.abs(P[:, 2] - LZ) < 0.008)
bridge = [f.index for f in HEAD.data.polygons if all(near[v] for v in f.vertices) and (P[list(f.vertices), 2] - LZ[list(f.vertices)]).max() > 0.0004 and (P[list(f.vertices), 2] - LZ[list(f.vertices)]).min() < -0.0004]
log('faces bridging the slit (all verts within 8 mm of the line, straddling it):', len(bridge))
for fi in bridge[:12]:
    f = HEAD.data.polygons[fi]; c = f.center; log('   bridge', [round(float(v), 3) for v in c], 'mat', HEAD.data.materials[f.material_index].name, 'nverts', len(f.vertices), 'dz', [round(float(P[v, 2] - LZ[v]) * 1000, 1) for v in f.vertices])
for ei in np.nonzero(cross)[0][:40]:
    a_, b_ = E[ei]; log('   cross', [round(float(v), 3) for v in P[a_]], '->', [round(float(v), 3) for v in P[b_]], 'len mm', round(float(np.linalg.norm(P[a_] - P[b_]) * 1000), 1), cls[a_], cls[b_], 'J', round(float(JAW[a_]), 2), round(float(JAW[b_]), 2))
span = []
for f in HEAD.data.polygons:
    ws = JAW[list(f.vertices)]
    if ws.max() - ws.min() > 0.5 and all(cls[v] == 'FoxSkin' for v in f.vertices): span.append(f.index)
if span:
    cs = np.array([[*HEAD.data.polygons[i].center] for i in span])
    log('SKIN polygons spanning the jaw split:', len(span), 'y', round(float(cs[:, 1].min()), 3), round(float(cs[:, 1].max()), 3), 'z', round(float(cs[:, 2].min()), 3), round(float(cs[:, 2].max()), 3), 'x', round(float(cs[:, 0].min()), 3), round(float(cs[:, 0].max()), 3))
    zs = np.array([HEAD.data.polygons[i].area for i in span]); log('  mean area mm2', round(float(zs.mean() * 1e6), 2), 'max', round(float(zs.max() * 1e6), 2))
log('jaw field: verts > .5 =', int((JAW > 0.5).sum()), 'blend verts', int(((JAW > 0.05) & (JAW < 0.95)).sum()))
# ── neck blend at the bottom of the head mesh ──
NECK = np.array([1 - smooth(ZMIN - 0.02, ZMIN + 0.06, z) for z in P[:, 2]]) * (1 - JAW)
# ── face bone kernels ──
POS = {n: h for n, h, t, p in FACE}
def kern(center, r, mask=None, iters=6):
    d = np.linalg.norm(P - np.array([*center]), axis=1); w = np.exp(-(d / r) ** 2 * 1.2); w[d > 2.5 * r] = 0
    if mask is not None: w = w * mask
    return diffuse(w, iters, 0.5)
UPPER_SIDE = SKIN & (P[:, 2] >= LZ - 0.004); LOWER_SIDE = SKIN & (P[:, 2] <= LZ + 0.004)
face_w = {}
for name, h, t, par in FACE:
    c = h
    if name == 'jaw.x' or name.startswith('teeth') or name.startswith('tongue'): continue
    if name.startswith('lips_smile'):   face_w[name] = (kern(c, 0.024, SKIN), 'both')
    elif name.startswith('lips_top'):   face_w[name] = (kern(c, 0.017, UPPER_SIDE), HEAD_NAME)
    elif name.startswith('lips_bot'):   face_w[name] = (kern(c, 0.017, LOWER_SIDE), 'jaw.x')
    elif name.startswith('chin'):       face_w[name] = (kern(c, 0.028, SKIN), 'jaw.x')
    elif name.startswith('cheek_smile'): face_w[name] = (kern(c, 0.032, SKIN), HEAD_NAME)
    elif name.startswith('cheek_inflate'): face_w[name] = (kern(c, 0.034, SKIN), 'both')
    elif name.startswith('nostril'):    face_w[name] = (kern(c, 0.012, SKIN), HEAD_NAME)
    elif name.startswith('nose_tip'):   face_w[name] = (kern(c, 0.016, SKIN), HEAD_NAME)
    elif name.startswith('nose_'):      face_w[name] = (kern(c, 0.022, SKIN), HEAD_NAME)
    elif name.startswith('eyebrow'):    face_w[name] = (kern(c, 0.018, SKIN), HEAD_NAME)
    elif name.startswith('eyelid'):     face_w[name] = (kern(c, 0.012, SKIN), HEAD_NAME)
    elif name.startswith('eye.'):
        s = name[-1]; ec = np.array([*EYE_C[s]]); d = np.linalg.norm(P - ec, axis=1)
        face_w[name] = (diffuse(np.where(d < 0.026, 1.0, 0.0) * SKIN, 4, 0.5), HEAD_NAME)   # the painted eyeball region
    elif name.startswith('ear_01'):
        side = np.sign(P[:, 0] - TIP_X) == np.sign(h.x - TIP_X)
        face_w[name] = (kern((h + t) / 2, 0.05, SKIN & side & (P[:, 2] > h.z - 0.02)), HEAD_NAME)
    elif name.startswith('ear_02'):
        side = np.sign(P[:, 0] - TIP_X) == np.sign(h.x - TIP_X)
        face_w[name] = (kern((h + t) / 2, 0.055, SKIN & side & (P[:, 2] > h.z - 0.01)), HEAD_NAME)
# ── assemble the weight matrix ──
names = ['hips', 'spine', 'chest', 'neck', 'head', 'jaw.x'] + [n for n, *_ in FACE if n != 'jaw.x']
W = {n: np.zeros(NV) for n in names}
W['neck'] = NECK; W['head'] = (1 - NECK) * (1 - JAW); W['jaw.x'] = (1 - NECK) * JAW
# teeth / tongue rigid
W['teeth_top.x'][TTOP] = 1; W['head'][TTOP] = 0; W['jaw.x'][TTOP] = 0
W['teeth_bot.x'][TBOT] = 1; W['head'][TBOT] = 0; W['jaw.x'][TBOT] = 0
if TG.size:
    t = np.clip((P[TG, 1] - tg_front.y) / max(1e-6, tg_back.y - tg_front.y), 0, 1)   # 0 tip … 1 root
    W['tongue_01.x'][TG] = t; W['tongue_02.x'][TG] = 1 - t; W['head'][TG] = 0; W['jaw.x'][TG] = 0
# face bones draw from the pools
pool = {HEAD_NAME: W['head'].copy(), 'jaw.x': W['jaw.x'].copy()}
groups = {HEAD_NAME: [], 'jaw.x': []}
for n, (w, base) in face_w.items():
    if base == 'both': groups[HEAD_NAME].append((n, w)); groups['jaw.x'].append((n, w))
    else: groups[base].append((n, w))
for base, lst in groups.items():
    if not lst: continue
    tot = sum(w for _, w in lst); share = np.minimum(1.0, tot)
    for n, w in lst: W[n] += np.where(tot > 1e-9, pool[base] * share * w / np.maximum(tot, 1e-9), 0)
    W[base] = pool[base] * (1 - share)
Wm = np.stack([W[n] for n in names], axis=1)
for i in range(NV):
    row = Wm[i]
    if (row > 1e-5).sum() > 4: row[np.argsort(row)[:-4]] = 0
    s = row.sum(); Wm[i] = row / s if s > 1e-9 else 0
Wm[np.isnan(Wm)] = 0
empty = int((Wm.sum(axis=1) < 0.5).sum()); log('head weights: unweighted verts', empty)
for k, n in enumerate(names):
    vg = HEAD.vertex_groups.new(name=n); nz = np.nonzero(Wm[:, k] > 1e-5)[0]
    for i in nz: vg.add([int(i)], float(Wm[i, k]), 'REPLACE')
# ── body weights: z bands ──
zb = PB[:, 2]
bounds = [('hips', zlo + (ZMIN - zlo) * 0.62), ('spine', zlo + (ZMIN - zlo) * 0.82), ('chest', ZMIN - 0.08), ('neck', ZMIN + 0.03), ('head', 1e9)]
prev_top = -1e9; BW = {}
for k, (n, top) in enumerate(bounds):
    w = np.ones(len(zb))
    if k > 0: w *= np.array([smooth(prev_top - 0.03, prev_top + 0.03, z) for z in zb])
    if k < len(bounds) - 1: w *= np.array([1 - smooth(top - 0.03, top + 0.03, z) for z in zb])
    BW[n] = w; prev_top = top
for vg in list(BODY.vertex_groups): BODY.vertex_groups.remove(vg)
for n, w in BW.items():
    vg = BODY.vertex_groups.new(name=n)
    for i in np.nonzero(w > 1e-4)[0]: vg.add([int(i)], float(w[i]), 'REPLACE')
for o in (HEAD, BODY):
    mod = o.modifiers.new('Armature', 'ARMATURE'); mod.object = ARM; o.parent = ARM
counts = {n: int((Wm[:, k] > 0.2).sum()) for k, n in enumerate(names)}
log('counts >0.2:', json.dumps({k: v for k, v in counts.items() if v}))

# ── pose renders ──
def render_pose(tag, poses, center, size, views=('front', 'left', 'three')):
    activate(ARM); bpy.ops.object.mode_set(mode='POSE')
    for pb in ARM.pose.bones: pb.location = (0, 0, 0); pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (1, 0, 0, 0)
    for name, loc, rot in poses:
        pb = ARM.pose.bones[name]
        if loc: pb.location = pb.bone.matrix_local.to_3x3().inverted() @ Vector(loc)
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
    sc.render.engine = 'BLENDER_WORKBENCH'; sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x = 1200; sc.render.resolution_y = 900; sc.world = bpy.data.worlds.new('W'); sc.world.color = (0.1, 0.1, 0.12)
    for m in HEAD.data.materials:
        if m and m.use_nodes:
            b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            l = b.inputs['Base Color'].links if b else []
            if l and l[0].from_node.type == 'TEX_IMAGE':
                for n in m.node_tree.nodes: n.select = (n == l[0].from_node)
                m.node_tree.nodes.active = l[0].from_node
            elif b: m.diffuse_color = b.inputs['Base Color'].default_value
    hc = (TIP_X, NOSE.y + 0.15, (NOSE.z + EYE_C['l'].z) / 2)
    dq = lambda deg: Matrix.Rotation(math.radians(deg), 4, 'X')
    render_pose('rest', [], hc, 0.5)
    # jaw sign: try both, keep the one that drops the chin (checked below via the renders' file names)
    render_pose('openA', [('jaw.x', None, dq(-22))], hc, 0.5)
    render_pose('openB', [('jaw.x', None, dq(22))], hc, 0.5, views=('left',))
    # which faces STRETCH when the jaw opens? (evaluated mesh vs rest)
    dg = bpy.context.evaluated_depsgraph_get(); ev = HEAD.evaluated_get(dg).data
    rest = HEAD.data; stretched = []
    for f in ev.polygons:
        vs = list(f.vertices); zs = [ev.vertices[v].co.z for v in vs]; z0 = [rest.vertices[v].co.z for v in vs]
        if (max(zs) - min(zs)) > 0.02 and (max(z0) - min(z0)) < 0.008: stretched.append((f.index, f.material_index, [round(c, 3) for c in rest.polygons[f.index].center], round((max(zs) - min(zs)) * 100, 1)))
    log('faces stretched > 2 cm by the open jaw (rest height < 8 mm):', len(stretched))
    ys = np.array([t[2][1] for t in stretched]); xs = np.array([t[2][0] for t in stretched]); zs = np.array([t[2][2] for t in stretched])
    log('   stretched by y band:', {b: int(((ys >= b - 0.02) & (ys < b)).sum()) for b in [-0.40, -0.38, -0.36, -0.34, -0.32, -0.30, -0.28, -0.26, -0.24]})
    fr = [t for t in stretched if t[2][1] < -0.31]
    for t in fr[:6]:
        f = HEAD.data.polygons[t[0]]; vs = list(f.vertices)
        for v in vs:
            row = {names[k]: round(float(Wm[v, k]), 2) for k in range(len(names)) if Wm[v, k] > 0.01}
            log('    front v', v, 'dz', round(float(P[v, 2] - LZ[v]) * 1000, 1), 'JAW', round(float(JAW[v]), 2), cls[v], row)
    back = 0.02
    render_pose('smile', [('lips_smile.l', (0, back, 0.012), None), ('lips_smile.r', (0, back, 0.012), None), ('lips_top_03.l', (0, back * .6, .006), None), ('lips_top_03.r', (0, back * .6, .006), None), ('cheek_smile.l', (0, .008, .01), None), ('cheek_smile.r', (0, .008, .01), None)], hc, 0.5)
    render_pose('pucker', [('lips_top.x', (0, -0.018, 0), None), ('lips_bot.x', (0, -0.018, 0), None), ('lips_top_01.l', (0, -0.012, 0), None), ('lips_top_01.r', (0, -0.012, 0), None), ('lips_bot_01.l', (0, -0.012, 0), None), ('lips_bot_01.r', (0, -0.012, 0), None)], hc, 0.5, views=('left', 'three'))
    render_pose('brows_blink', [(f'eyebrow_{n}.{s}', (0, 0, 0.018), None) for s in 'lr' for n in ('01', '02', '03', '04')] + [(f'eyelid_top_{n}.l', (0, 0, -0.018), None) for n in ('01', '02', '03')] + [('ear_01.l', None, Matrix.Rotation(math.radians(30), 4, 'Y'))], hc, 0.5, views=('front', 'three'))
    render_pose('rest2', [], hc, 0.5, views=('front',))
    # material-ID render of the open pose: skin beige / mouth red / teeth white / tongue pink
    sc.display.shading.color_type = 'MATERIAL'
    for m in HEAD.data.materials:
        n = m.name.split('.')[0]; m.diffuse_color = {'FoxSkin': (0.85, 0.6, 0.4, 1), 'FoxMouth': (0.6, 0.05, 0.08, 1), 'FoxTeeth': (1, 1, 1, 1), 'FoxTongue': (1, 0.3, 0.5, 1)}.get(n, (0.5, 0.5, 0.5, 1))
    render_pose('openB_matid', [('jaw.x', None, dq(22))], hc, 0.5, views=('left', 'frontlow'))
    sc.display.shading.color_type = 'TEXTURE'
    log('pose renders written')

# ── export ──
bpy.ops.object.select_all(action='DESELECT'); HEAD.select_set(True); BODY.select_set(True); ARM.select_set(True); bpy.context.view_layer.objects.active = ARM
bpy.ops.export_scene.gltf(filepath=OUTGLB, export_format='GLB', use_selection=True, export_skins=True, export_all_influences=False, export_animations=False, export_apply=False, export_yup=True, export_image_format='AUTO', export_materials='EXPORT')
log('exported', OUTGLB, os.path.getsize(OUTGLB), round(time.time() - T0, 1), 's')
print('RIG2_OK ' + json.dumps({'bones': len(arm.bones), 'head_verts': NV, 'body_verts': len(BODY.data.vertices), 'unweighted': empty}))
