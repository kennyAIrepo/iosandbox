# hopeOS — FACE RIG AUTHOR (headless Blender 4.4)
# ═══════════════════════════════════════════════════════════════════════
# Places Auto-Rig-Pro-style FACIAL MARKERS on a Meshy fox head automatically
# (the way an artist does it in ARP's "Facial Setup": front-view projection of
# a marker template, refined from what the texture and the geometry say), then
# (stage 'rig') builds deform bones at the markers, authors skin weights, and
# exports a GLB three.js can drive.
#
#   blender -b --python facerig_author.py -- in.glb outdir [--stage markers|rig] [--zmin 0.45]
#            [--overrides markers.override.json] [--render]
#
# MARKER DETECTION (front / side orthographic rasters through the BVH):
#   nose       black blob at the front-most point of the head
#   eyes       white blobs per side (eye whites) → ellipse → 8 eyelid markers
#   brows      dark blobs above each eye → 4 markers inner→outer
#   mouth      the dark lip crease + cavity: corners = rear ends of the crease,
#              ring = 16 markers along the upper / lower lip edges tip→corners
#   chin       lowest front point of the lower jaw
#   jaw pivot  behind the mandible under the ear base (ARP auto jaw pivot)
#   cheeks     smile (beside the muzzle, under the eye) + inflate (lower cheek)
#   ears       tip = top-most per side, base = ear root on the skull
#   tongue / teeth  from the mouth cavity (pink / white pixels inside)
# Every position is a SURFACE point (a raster hit), Blender frame: +z up,
# -y forward (glTF +z forward), +x = the character's LEFT.
import bpy, bmesh, sys, json, math, os
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
opt = lambda k, d=None: argv[argv.index(k) + 1] if k in argv else d
STAGE = opt('--stage', 'markers'); ZMIN = float(opt('--zmin', '0.45')); OVR = opt('--overrides'); RENDER = '--render' in argv
os.makedirs(OUT, exist_ok=True)
log = lambda *a: print('[facerig]', *a)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)
MESH = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
ME = MESH.data; MW = MESH.matrix_world.copy()
ARM = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)

# ── triangulated BVH + per-triangle UVs for texture sampling ──
bm = bmesh.new(); bm.from_mesh(ME); bmesh.ops.triangulate(bm, faces=bm.faces[:]); bm.faces.ensure_lookup_table(); bm.verts.ensure_lookup_table()
uvl = bm.loops.layers.uv.active
TRI_UV = [[l[uvl].uv.copy() for l in f.loops] if uvl else None for f in bm.faces]
TRI_V = [[l.vert.co.copy() for l in f.loops] for f in bm.faces]
BVH = BVHTree.FromBMesh(bm)

# base-colour image → small numpy array (detection only)
IMG = None
for m in ME.materials:
    if m and m.use_nodes:
        b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if b and b.inputs['Base Color'].links and b.inputs['Base Color'].links[0].from_node.type == 'TEX_IMAGE': IMG = b.inputs['Base Color'].links[0].from_node.image
        if IMG: break
PIX = None; IW = IH = 0
if IMG:
    IMG = IMG.copy()                      # detection copy: never downscale the datablock that gets exported
    if IMG.size[0] > 1024: IMG.scale(1024, 1024)
    IW, IH = IMG.size; PIX = np.empty(IW * IH * 4, np.float32); IMG.pixels.foreach_get(PIX); PIX = PIX.reshape(IH, IW, 4)

def tex(tri, p):
    """RGB at surface point p on triangle tri (barycentric UV)."""
    if PIX is None or TRI_UV[tri] is None: return (0.5, 0.5, 0.5)
    a, b, c = TRI_V[tri]; v0 = b - a; v1 = c - a; v2 = p - a
    d00 = v0.dot(v0); d01 = v0.dot(v1); d11 = v1.dot(v1); d20 = v2.dot(v0); d21 = v2.dot(v1)
    den = d00 * d11 - d01 * d01 or 1e-12
    v = (d11 * d20 - d01 * d21) / den; w = (d00 * d21 - d01 * d20) / den; u = 1 - v - w
    ua, ub, uc = TRI_UV[tri]; uv = ua * u + ub * v + uc * w
    x = int((uv.x % 1) * IW) % IW; y = int((uv.y % 1) * IH) % IH
    return tuple(float(q) for q in PIX[y, x, :3])

class Raster:
    """Orthographic ray raster: axis = 'y' (front, rays +y), 'x' (side, rays -x or +x), 'z' (below, rays +z)."""
    def __init__(self, axis, sign, a0, a1, b0, b1, res=0.002, zmin=None):
        self.axis, self.sign, self.res = axis, sign, res
        self.a0, self.b0 = a0, b0
        self.na = int((a1 - a0) / res) + 1; self.nb = int((b1 - b0) / res) + 1
        self.hit = {}
        far = 3.0
        for i in range(self.na):
            for j in range(self.nb):
                a = a0 + i * res; b = b0 + j * res
                if axis == 'y':   o = Vector((a, -far * sign, b)); d = Vector((0, sign, 0))
                elif axis == 'x': o = Vector((far * sign, a, b)); d = Vector((-sign, 0, 0))
                else:             o = Vector((a, b, -far)); d = Vector((0, 0, 1))
                loc, nrm, idx, dist = BVH.ray_cast(o, d, far * 2)
                if loc is None or (zmin is not None and loc.z < zmin): continue
                self.hit[(i, j)] = (loc, nrm, idx, tex(idx, loc))
    def ij(self, a, b): return (int(round((a - self.a0) / self.res)), int(round((b - self.b0) / self.res)))
    def ab(self, i, j): return (self.a0 + i * self.res, self.b0 + j * self.res)
    def nearest(self, a, b, pred=lambda h: True, rmax=12):
        best = None
        for r in range(rmax + 1):
            for di in range(-r, r + 1):
                for dj in (-r, r) if abs(di) < r else range(-r, r + 1):
                    h = self.hit.get((self.ij(a, b)[0] + di, self.ij(a, b)[1] + dj))
                    if h and pred(h): return h
        return best

lum = lambda c: (c[0] + c[1] + c[2]) / 3
sat = lambda c: max(c) - min(c)
is_dark = lambda c: lum(c) < 0.14
is_white = lambda c: lum(c) > 0.72 and sat(c) < 0.16
is_pink = lambda c: c[0] > 0.55 and c[1] < 0.5 and c[2] > 0.3 and c[0] - c[1] > 0.2
is_fur = lambda c: not (is_dark(c) or is_white(c) or is_pink(c))
is_crease = lambda c: lum(c) < 0.26 and sat(c) < 0.30      # the lip line is drawn dark-brown to black

def components(cells):
    cells = set(cells); comps = []
    while cells:
        s = cells.pop(); stack = [s]; comp = [s]
        while stack:
            i, j = stack.pop()
            for n in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1), (i + 1, j + 1), (i - 1, j - 1), (i + 1, j - 1), (i - 1, j + 1)):
                if n in cells: cells.remove(n); stack.append(n); comp.append(n)
        comps.append(comp)
    return sorted(comps, key=len, reverse=True)

# ── head extent ──
verts_w = [MW @ v.co for v in ME.vertices]
head_v = [p for p in verts_w if p.z >= ZMIN]
hx0, hx1 = min(p.x for p in head_v), max(p.x for p in head_v)
hy0, hy1 = min(p.y for p in head_v), max(p.y for p in head_v)
hz0, hz1 = ZMIN, max(p.z for p in head_v)
NOSE = min(head_v, key=lambda p: p.y)
log('head bbox x', round(hx0, 3), round(hx1, 3), 'y', round(hy0, 3), round(hy1, 3), 'z', round(hz0, 3), round(hz1, 3), 'nose', [round(c, 3) for c in NOSE])

# ── rasters ──
log('rasterizing front / sides / below …')
F = Raster('y', +1, hx0 - 0.01, hx1 + 0.01, hz0, hz1 + 0.01, zmin=ZMIN)            # a = x, b = z
SL = Raster('x', +1, hy0 - 0.01, hy1 + 0.01, hz0, hz1 + 0.01, zmin=ZMIN)           # from +x (character's left side): a = y, b = z
SR = Raster('x', -1, hy0 - 0.01, hy1 + 0.01, hz0, hz1 + 0.01, zmin=ZMIN)
B = Raster('z', +1, hx0 - 0.01, hx1 + 0.01, hy0 - 0.01, hy1 + 0.01, res=0.003, zmin=ZMIN)   # a = x, b = y (rays up)
log('front hits', len(F.hit), 'side', len(SL.hit), len(SR.hit), 'below', len(B.hit))

def raster_png(R, name):
    a = np.zeros((R.nb, R.na, 4), np.float32); a[..., 3] = 1
    for (i, j), h in R.hit.items():
        c = h[3]; a[j, i, :3] = (0, 0, 0) if is_dark(c) else (1, 1, 1) if is_white(c) else (1, 0.3, 0.7) if is_pink(c) else (0.45, 0.35, 0.3)
    im = bpy.data.images.new(name, R.na, R.nb, alpha=True); im.pixels.foreach_set(a.ravel()); im.filepath_raw = os.path.join(OUT, name + '.png'); im.file_format = 'PNG'; im.save()
raster_png(F, 'raster_front'); raster_png(SL, 'raster_left'); raster_png(SR, 'raster_right')
M = {}   # marker name → Vector
def put(name, p): M[name] = Vector(p)

# ── nose: dark component containing the front-most hit ──
front_cells = [k for k, h in F.hit.items() if is_dark(h[3])]
nose_comp = None
ni, nj = F.ij(NOSE.x, NOSE.z)
for comp in components(front_cells):
    if any(abs(i - ni) <= 6 and abs(j - nj) <= 6 for i, j in comp): nose_comp = comp; break
if nose_comp:
    pts = [F.hit[k][0] for k in nose_comp]
    nose_top = max(pts, key=lambda p: p.z); nose_bot = min(pts, key=lambda p: p.z)
    put('nose_tip.x', min(pts, key=lambda p: p.y))
    put('nostril.l', max(pts, key=lambda p: p.x)); put('nostril.r', min(pts, key=lambda p: p.x))
else:
    nose_top = NOSE + Vector((0, 0, 0.02)); nose_bot = NOSE - Vector((0, 0, 0.02)); put('nose_tip.x', NOSE)
    put('nostril.l', NOSE + Vector((0.02, 0.01, 0))); put('nostril.r', NOSE + Vector((-0.02, 0.01, 0)))
log('nose top/bot z', round(nose_top.z, 3), round(nose_bot.z, 3))

# ── eyes: largest white component per side above the nose ──
EYE = {}
eye_zone = lambda h: nose_top.z + 0.03 < h[0].z < nose_top.z + 0.16 and 0.02 < abs(h[0].x) < 0.15 and h[0].y < NOSE.y + 0.22
white_cells = [k for k, h in F.hit.items() if eye_zone(h) and (is_white(h[3]) or is_dark(h[3]))]
wc = components(white_cells)
for side, sgn in (('l', 1), ('r', -1)):
    cands = [c for c in wc if len(c) > 8 and sgn * sum(F.hit[k][0].x for k in c) / len(c) > 0.01 and any(is_white(F.hit[k][3]) for k in c)]
    if not cands: log('!! no eye white on side', side); continue
    comp = list(cands[0]); c0 = np.array([[F.hit[k][0].x, F.hit[k][0].z] for k in comp]).mean(axis=0)
    for other in cands[1:]:   # merge the sclera halves / rim pieces around the same eye
        oc = np.array([[F.hit[k][0].x, F.hit[k][0].z] for k in other]).mean(axis=0)
        if np.hypot(*(oc - c0)) < 0.035: comp += other
    # grow into the dark rim around the white (the eyelid line)
    cs = set(comp); ring = set()
    for (i, j) in comp:
        for di in range(-4, 5):
            for dj in range(-4, 5):
                k = (i + di, j + dj)
                if k in F.hit and k not in cs and (is_dark(F.hit[k][3]) or not is_fur(F.hit[k][3])): ring.add(k)
    allc = list(cs | ring)
    P = np.array([[F.hit[k][0].x, F.hit[k][0].z] for k in allc])
    c = P.mean(axis=0); cov = np.cov((P - c).T); w, v = np.linalg.eigh(cov)
    ax = v[:, 1] * math.sqrt(w[1]) * 2.0; ay = v[:, 0] * math.sqrt(w[0]) * 2.0        # ~2σ ellipse
    if ax[0] < 0: ax = -ax
    if ay[1] < 0: ay = -ay
    EYE[side] = {'c': c, 'ax': ax, 'ay': ay, 'cells': allc}
    ctr = F.nearest(c[0], c[1]); put(f'eye_center.{side}', ctr[0] if ctr else Vector((c[0], NOSE.y + 0.1, c[1])))
    # 8 eyelid markers: corners (inner/outer), top 3, bottom 3 (ARP eyelid_top_01..03 / bot_01..03 / corner_01/02)
    def ell(t):
        q = c + ax * math.cos(t) + ay * math.sin(t); h = F.nearest(q[0], q[1]); return h[0] if h else Vector((q[0], NOSE.y + 0.1, q[1]))
    inner_t = math.pi if sgn > 0 else 0.0; outer_t = 0.0 if sgn > 0 else math.pi
    put(f'eyelid_corner_01.{side}', ell(inner_t)); put(f'eyelid_corner_02.{side}', ell(outer_t))
    for n, t in ((1, 0.25), (2, 0.5), (3, 0.75)):
        tt = inner_t + (outer_t - inner_t) * t if sgn > 0 else inner_t + (outer_t - inner_t) * t
        put(f'eyelid_top_{n:02d}.{side}', ell(math.pi - (math.pi * t) if sgn > 0 else math.pi * t))
        put(f'eyelid_bot_{n:02d}.{side}', ell(math.pi + (math.pi * t) if sgn > 0 else 2 * math.pi - math.pi * t))
    log('eye', side, 'center', [round(float(x), 3) for x in c], 'axes', [round(float(x), 3) for x in ax], [round(float(x), 3) for x in ay])

# ── brows: dark component above each eye ──
for side, sgn in (('l', 1), ('r', -1)):
    if side not in EYE: continue
    e = EYE[side]; ex, ez = e['c']; top = ez + abs(e['ay'][1]) * 0.8
    cells = [k for k, h in F.hit.items() if is_dark(h[3]) and top < h[0].z < top + 0.10 and abs(h[0].x - ex) < 0.09]
    comps = [c for c in components(cells) if len(c) > 6]
    if not comps: log('!! no brow', side); continue
    comp = comps[0]
    P = np.array([[F.hit[k][0].x, F.hit[k][0].z] for k in comp]); c = P.mean(axis=0)
    cov = np.cov((P - c).T); w, v = np.linalg.eigh(cov); d = v[:, 1]
    if d[0] < 0: d = -d
    proj = (P - c) @ d; lo, hi = proj.min(), proj.max()
    order = [0.08, 0.36, 0.64, 0.92] if sgn > 0 else [0.92, 0.64, 0.36, 0.08]   # 01 = inner (near the midline): low x on the left eye, high x on the right
    for n, t in enumerate(order, 1):
        q = c + d * (lo + (hi - lo) * t); h = F.nearest(q[0], q[1]); put(f'eyebrow_{n:02d}.{side}', h[0])
    hq = F.nearest(c[0], c[1]); put(f'eyebrow_full.{side}', hq[0])
    log('brow', side, 'span', round(float(hi - lo), 3))

# ── mouth: cavity + crease ──
# cavity = dark ∪ pink (+ enclosed white teeth) under the nose; the lip CREASE = thin dark texture line that
# continues from the cavity to the commissures. Nose cells are excluded (the black nose touches the upper lip).
nose_set = set(nose_comp or [])
band = lambda h: nose_bot.z - 0.11 < h[0].z < nose_bot.z + 0.07 and abs(h[0].x) < 0.17 and h[0].y < NOSE.y + 0.30 and not (abs(h[0].x - NOSE.x) < 0.035 and h[0].z > nose_bot.z - 0.002)   # the smile crease climbs toward the commissures; keep the nose column out
core = set(k for k, h in F.hit.items() if band(h) and k not in nose_set and (is_dark(h[3]) or is_pink(h[3])))
crease_cells = set(k for k, h in F.hit.items() if band(h) and k not in nose_set and is_crease(h[3]) and abs(h[0].x) > 0.02)
teeth = set(k for k, h in F.hit.items() if band(h) and is_white(h[3]) and any((k[0] + di, k[1] + dj) in core for di in range(-2, 3) for dj in range(-2, 3)))
comps = components(core | teeth | crease_cells)
# the cavity = component nearest the front centre under the nose
cav_ref = F.ij(NOSE.x, nose_bot.z - 0.03)
comps.sort(key=lambda c: min(abs(i - cav_ref[0]) + abs(j - cav_ref[1]) for i, j in c) - 0.02 * len(c))
mouth = list(comps[0]) if comps else []
# grow along the crease: absorb dark components that come within 3 cells of the current set
grown = set(mouth); changed = True
while changed:
    changed = False
    for c in comps:
        if c[0] in grown: continue
        gl = list(grown)
        if any(abs(i - gi) <= 8 and abs(j - gj) <= 8 for (i, j) in c for (gi, gj) in gl):
            grown |= set(c); changed = True
mouth = list(grown)
for c in comps[:12]:
    rr = max((F.hit[k][0] for k in c), key=lambda p: abs(p.x)); log('  comp', len(c), 'in' if c[0] in grown else 'out', 'outermost', [round(v, 3) for v in rr])
mz = sum(F.hit[k][0].z for k in mouth) / max(1, len(mouth)) if mouth else nose_bot.z - 0.04
col0 = [k for k in mouth if abs(F.ab(*k)[0] - NOSE.x) <= F.res * 1.01]
crease_z = max(F.hit[k][0].z for k in col0) if col0 else mz + 0.02      # upper-lip edge height at the tip
log('mouth region cells', len(mouth), 'mean z', round(mz, 3), 'crease z', round(crease_z, 3))
def overlay_png(R, name, sets):
    a = np.zeros((R.nb, R.na, 4), np.float32); a[..., 3] = 1
    for (i, j), h in R.hit.items():
        c = h[3]; a[j, i, :3] = (0, 0, 0) if is_dark(c) else (1, 1, 1) if is_white(c) else (1, 0.3, 0.7) if is_pink(c) else (0.45, 0.35, 0.3)
    for col, cells in sets:
        for (i, j) in cells:
            if 0 <= j < R.nb and 0 <= i < R.na: a[j, i, :3] = col
    im = bpy.data.images.new(name, R.na, R.nb, alpha=True); im.pixels.foreach_set(a.ravel()); im.filepath_raw = os.path.join(OUT, name + '.png'); im.file_format = 'PNG'; im.save()
overlay_png(F, 'debug_mouth', [((1, 0, 0), mouth), ((0, 1, 0), [k for c in comps for k in c if k not in set(mouth)])])
def zoom_png(R, name, sets, a_rng, b_rng, scale=5):
    i0, j0 = R.ij(a_rng[0], b_rng[0]); i1, j1 = R.ij(a_rng[1], b_rng[1])
    w, h = (i1 - i0 + 1) * scale, (j1 - j0 + 1) * scale; a = np.zeros((h, w, 4), np.float32); a[..., 3] = 1
    col = {}
    for (i, j), hh in R.hit.items():
        if i0 <= i <= i1 and j0 <= j <= j1:
            c = hh[3]; col[(i, j)] = (0, 0, 0) if is_dark(c) else (0.3, 0.2, 0.1) if is_crease(c) else (1, 1, 1) if is_white(c) else (1, 0.3, 0.7) if is_pink(c) else (0.45, 0.35, 0.3)
    for cc, cells in sets:
        for k in cells:
            if k in col: col[k] = cc
    for (i, j), c in col.items():
        a[(j - j0) * scale:(j - j0 + 1) * scale, (i - i0) * scale:(i - i0 + 1) * scale, :3] = c
    im = bpy.data.images.new(name, w, h, alpha=True); im.pixels.foreach_set(a.ravel()); im.filepath_raw = os.path.join(OUT, name + '.png'); im.file_format = 'PNG'; im.save()
zoom_png(F, 'debug_mouth_zoom', [((1, 0, 0), mouth), ((0, 1, 0), [k for c in comps for k in c if k not in set(mouth)])], (NOSE.x - 0.14, NOSE.x + 0.14), (crease_z - 0.07, crease_z + 0.09))
CORNER = {}
for side, sgn in (('l', 1), ('r', -1)):
    cells = [k for k in mouth if sgn * F.hit[k][0].x > 0.01]
    if not cells: log('!! no mouth cells on side', side); continue
    # commissure = the outermost cell of the lip line on this side (ties → rear-most)
    k = max(cells, key=lambda k: (round(sgn * F.hit[k][0].x, 3), F.hit[k][0].y))
    CORNER[side] = F.hit[k][0]; put(f'lips_smile.{side}', F.hit[k][0])
    log('corner', side, [round(c, 3) for c in F.hit[k][0]])
for side, sgn in (('l', 1), ('r', -1)):
    if side not in CORNER:
        h = (SL if sgn > 0 else SR).nearest(NOSE.y + 0.14, crease_z); CORNER[side] = h[0]; put(f'lips_smile.{side}', h[0])
MIRX = NOSE.x                                            # symmetry plane of the face
def mirror_snap(p):
    q = Vector((2 * MIRX - p.x, p.y, p.z)); h = F.nearest(q.x, q.z, rmax=20)
    return h[0] if h else q
dl, dr = abs(CORNER['l'].x - MIRX), abs(CORNER['r'].x - MIRX)
if abs(dl - dr) > 0.015:
    good = 'l' if dl > dr else 'r'; bad = 'r' if good == 'l' else 'l'
    CORNER[bad] = mirror_snap(CORNER[good]); put(f'lips_smile.{bad}', CORNER[bad])
    log('corner', bad, 'mirrored from', good, '→', [round(c, 3) for c in CORNER[bad]])
tip_x = (CORNER['l'].x + CORNER['r'].x) / 2
def lip_edge(upper, u):
    """point on the upper/lower lip edge at u ∈ [-1 (right corner), 0 (tip), 1 (left corner)] — the mouth
    region's top / bottom boundary in that raster column, stepped one cell outward onto the lip skin."""
    side = 'l' if u >= 0 else 'r'; corner = CORNER[side]; a = abs(u)
    x = tip_x + (corner.x - tip_x) * a
    i0 = F.ij(x, crease_z)[0]
    col = [k for k in mouth if abs(k[0] - i0) <= 1]
    if not col:
        im = F.ij(2 * MIRX - x, crease_z)[0]; colm = [k for k in mouth if abs(k[0] - im) <= 1]     # the other side's column, mirrored
        if colm:
            j = (max if upper else min)(colm, key=lambda k: k[1]); h2 = F.hit.get((j[0], j[1] + (2 if upper else -2))) or F.hit[j]
            return mirror_snap(h2[0])
        y = corner.y - (corner.y - NOSE.y - 0.02) * (1 - a); z = crease_z + (0.006 if upper else -0.006)
        hh = (SL if side == 'l' else SR).nearest(y, z); return hh[0] if hh else Vector((x, y, z))
    j = (max if upper else min)(col, key=lambda k: k[1])
    k2 = (j[0], j[1] + (2 if upper else -2)); h2 = F.hit.get(k2) or F.hit.get((j[0], j[1] + (1 if upper else -1)))
    return (h2 or F.hit[j])[0]
put('lips_top.x', lip_edge(True, 0)); put('lips_bot.x', lip_edge(False, 0))
for side, sgn in (('l', 1), ('r', -1)):
    put(f'lips_top_01.{side}', lip_edge(True, sgn * 0.3)); put(f'lips_top_02.{side}', lip_edge(True, sgn * 0.6)); put(f'lips_top_03.{side}', lip_edge(True, sgn * 0.85))
    put(f'lips_bot_01.{side}', lip_edge(False, sgn * 0.3)); put(f'lips_bot_02.{side}', lip_edge(False, sgn * 0.6)); put(f'lips_bot_03.{side}', lip_edge(False, sgn * 0.85))
# tongue / teeth from the cavity colours
pink = [F.hit[k][0] for k in mouth if is_pink(F.hit[k][3])]
white = [F.hit[k][0] for k in mouth if is_white(F.hit[k][3])]
if pink: put('tongue_01.x', sum(pink, Vector()) / len(pink)); put('tongue_02.x', min(pink, key=lambda p: p.y))
if white:
    up = [p for p in white if p.z > mz]; dn = [p for p in white if p.z <= mz]
    if up: put('teeth_top.x', sum(up, Vector()) / len(up))
    if dn: put('teeth_bot.x', sum(dn, Vector()) / len(dn))
# ── chin: lowest front point of the lower jaw (below raster, front-most rows) ──
lb = M['lips_bot.x']
jaw_hits = [h[0] for h in list(F.hit.values()) + list(B.hit.values()) if abs(h[0].x - tip_x) < 0.04 and lb.z - 0.09 < h[0].z < lb.z - 0.006 and h[0].y < lb.y + 0.08]
chin = min(jaw_hits, key=lambda p: p.y + 0.8 * p.z) if jaw_hits else Vector((tip_x, lb.y + 0.01, lb.z - 0.04))   # most forward-and-low point of the mandible
put('chin_01.x', chin); put('chin_02.x', Vector((chin.x, chin.y + 0.03, chin.z - 0.005)))
# ── ears ──
for side, sgn in (('l', 1), ('r', -1)):
    tip = max((p for p in head_v if sgn * p.x > 0.03), key=lambda p: p.z)
    put(f'ear_02.{side}', tip)                                    # ARP: ear_01 = base, ear_02 = tip
    # base = where the ear meets the skull: walk from the tip toward the skull centre until the front-view
    # silhouette row is wider than an ear (the head), then snap that point to the surface
    skull = Vector((tip_x, NOSE.y + 0.24, nose_top.z + 0.12))
    base = None
    for t in np.arange(0.15, 0.9, 0.02):
        q = tip + (skull - tip) * t
        row = [F.hit[k][0] for k in F.hit if abs(F.ab(*k)[1] - q.z) <= F.res * 0.51 and sgn * F.hit[k][0].x > 0]
        if row and (max(p.x * sgn for p in row) - min(p.x * sgn for p in row)) > 0.13: base = q; break
    base = base or tip + (skull - tip) * 0.45
    loc, nrm, idx, dist = BVH.find_nearest(base)
    put(f'ear_01.{side}', loc if loc else base)
# ── cheeks: on the side surface ──
for side, R, sgn in (('l', SL, 1), ('r', SR, -1)):
    ez = EYE[side]['c'][1] if side in EYE else mz + 0.1
    cs = R.nearest(CORNER[side].y - 0.005, (CORNER[side].z + ez) / 2); put(f'cheek_smile.{side}', cs[0])
    ci = R.nearest(CORNER[side].y + 0.06, mz - 0.01); put(f'cheek_inflate.{side}', ci[0])
# ── nose bridge markers: midline from between the eyes to the nose top ──
bz = (EYE['l']['c'][1] + EYE['r']['c'][1]) / 2 if len(EYE) == 2 else nose_top.z + 0.09
bx = (EYE['l']['c'][0] + EYE['r']['c'][0]) / 2 if len(EYE) == 2 else 0.0
for n, t in ((1, 0.2), (2, 0.55), (3, 0.9)):
    h = F.nearest(bx + (M['nose_tip.x'].x - bx) * t, bz + (nose_top.z - bz) * t); put(f'nose_{n:02d}.x', h[0])
# ── jaw pivot: behind the mandible under the ear base (ARP auto pivot), per side + centre ──
ear_base_z = (M['ear_01.l'].z + M['ear_01.r'].z) / 2
cz_ = (CORNER['l'].z + CORNER['r'].z) / 2
jz = cz_ + 0.03                                   # condyle: a little above the tooth row
jy = max(CORNER['l'].y, CORNER['r'].y) + 0.16     # behind the commissures, under the ear
put('jaw_pivot.l', Vector((CORNER['l'].x + 0.03, jy, jz))); put('jaw_pivot.r', Vector((CORNER['r'].x - 0.03, jy, jz)))
put('jaw_pivot.x', Vector((tip_x, jy, jz)))
# ── skull / head reference ──
put('head_top.x', max(F.hit.values(), key=lambda h: (h[0].z if abs(h[0].x - tip_x) < 0.05 and h[0].z < ear_base_z + 0.02 else -1))[0])
fh = F.nearest(bx, bz + 0.07, rmax=30); put('forehead.x', fh[0] if fh else Vector((bx, NOSE.y + 0.15, bz + 0.07)))

# ── overrides ──
if OVR and os.path.exists(OVR):
    for k, v in json.load(open(OVR)).items(): M[k] = Vector(v); log('override', k, v)

json.dump({k: [round(c, 4) for c in v] for k, v in M.items()}, open(os.path.join(OUT, 'markers.json'), 'w'), indent=1)
log('markers', len(M))

# ── verification render: green dots on the head from front / side / low-front ──
if RENDER or STAGE == 'markers':
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
    cols = {'lips': (0.1, 1, 0.2, 1), 'eye': (0.2, 0.6, 1, 1), 'brow': (1, 0.9, 0.1, 1), 'nose': (1, 0.3, 0.9, 1), 'ear': (0.9, 0.5, 0.1, 1), 'jaw': (1, 0.1, 0.1, 1), 'other': (1, 1, 1, 1)}
    mats = {k: bpy.data.materials.new('mk_' + k) for k in cols}
    for k, c in cols.items(): mats[k].diffuse_color = c
    cols['lower'] = (0.1, 0.9, 1, 1); cols['corner'] = (1, 1, 0.1, 1)
    for k in ('lower', 'corner'): mats[k] = bpy.data.materials.new('mk_' + k); mats[k].diffuse_color = cols[k]
    grp = lambda n: 'corner' if n.startswith('lips_smile') else 'lower' if n.startswith('lips_bot') else 'lips' if n.startswith('lips') or n.startswith('tongue') or n.startswith('teeth') else 'eye' if n.startswith('eye') else 'brow' if 'brow' in n else 'nose' if n.startswith('nos') else 'ear' if n.startswith('ear') else 'jaw' if n.startswith('jaw') or n.startswith('chin') else 'other'
    for n, p in M.items():
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.0035 if grp(n) not in ('jaw', 'corner') else 0.006, location=p, segments=8, ring_count=6)
        o = bpy.context.object; o.name = 'mk_' + n; o.data.materials.append(mats[grp(n)])
    cz = (mz + ear_base_z) / 2; cy = NOSE.y + 0.18
    def cam(view, center, size):
        c = bpy.data.cameras.new('c'); c.type = 'ORTHO'; c.ortho_scale = size; co = bpy.data.objects.new('cam', c); sc.collection.objects.link(co); sc.camera = co
        cv = Vector(center)
        if view == 'front':    co.location = cv + Vector((0, -3, 0)); co.rotation_euler = (math.pi / 2, 0, 0)
        if view == 'left':     co.location = cv + Vector((3, 0, 0)); co.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        if view == 'right':    co.location = cv + Vector((-3, 0, 0)); co.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
        if view == 'frontlow': co.location = cv + Vector((0, -3, -1.3)); co.rotation_euler = (math.radians(113), 0, 0)
        if view == 'three':    co.location = cv + Vector((2.2, -2.2, 0.5)); co.rotation_euler = (math.radians(80), 0, math.radians(45))
        return co
    for view in ('front', 'left', 'right', 'frontlow', 'three'):
        co = cam(view, (tip_x, cy, cz), 0.55)
        sc.render.filepath = os.path.join(OUT, f'markers_{view}.png'); bpy.ops.render.render(write_still=True); bpy.data.objects.remove(co)
    mc_ = ((CORNER['l'] + CORNER['r']) / 2 + M['lips_top.x']) / 2
    for view in ('frontlow', 'left', 'three'):
        co = cam(view, (mc_.x, mc_.y, mc_.z), 0.22)
        sc.render.filepath = os.path.join(OUT, f'mouth_{view}.png'); bpy.ops.render.render(write_still=True); bpy.data.objects.remove(co)
    log('renders written')

if STAGE == 'markers':
    print('FACERIG_MARKERS ' + json.dumps({k: [round(c, 4) for c in v] for k, v in M.items()}))
    sys.exit(0)
