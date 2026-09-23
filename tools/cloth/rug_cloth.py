# Turn a STIFF solid prop (Meshy rug: 1.0 M triangles, one rigid shell) into a
# CLOTH ASSET: a coarse regular quad LATTICE that a solver can actually run, plus
# a decimated render skin EMBEDDED in that lattice (bilinear cell + local frame),
# so every fringe, braid and fold rides the simulated sheet.
#
#   blender -b --python tools/cloth/rug_cloth.py -- rug.glb out.glb outdir
#          [--sim 0.030] [--skin 90000] [--tex 2048] [--test] [--render]
#
# Why a lattice and not "more vertices on the rug": the mesh already HAS 1 M
# triangles (2.4 mm edges). Density is not what makes cloth move - a regular
# grid of structural / shear / bend edges is, and it has to be COARSE enough to
# solve 8 substeps inside a frame (see README for the measured budget).
import bpy, bmesh, sys, os, json, time
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

A = sys.argv[sys.argv.index('--') + 1:]
SRC, OUTGLB, OUT = A[0], A[1], A[2]
def opt(k, d, f=float):
    return f(A[A.index(k) + 1]) if k in A else d
SIM_SP = opt('--sim', 0.030)
SKIN_TRIS = opt('--skin', 90000, int)
TEX = opt('--tex', 2048, int)
TEST = '--test' in A
RENDER = '--render' in A or TEST
os.makedirs(OUT, exist_ok=True)
T0 = time.time()
def log(*a): print('[rug]', *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)
src = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
for o in list(bpy.data.objects):
    if o is not src: bpy.data.objects.remove(o)
log('imported', len(src.data.vertices), 'verts', len(src.data.polygons), 'tris')

# -- 1. clean: weld the glTF vertex splits, drop the junk shells --------------
bm = bmesh.new(); bm.from_mesh(src.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
bm.verts.ensure_lookup_table()
seen = [False] * len(bm.verts); shells = []
for v in bm.verts:
    if seen[v.index]: continue
    stack, comp = [v], []
    seen[v.index] = True
    while stack:
        x = stack.pop(); comp.append(x)
        for e in x.link_edges:
            o = e.other_vert(x)
            if not seen[o.index]: seen[o.index] = True; stack.append(o)
    shells.append(comp)
shells.sort(key=len, reverse=True)
junk = [v for c in shells[1:] if len(c) < 400 for v in c]
bmesh.ops.delete(bm, geom=junk, context='VERTS')
bm.to_mesh(src.data); bm.free(); src.data.update()
log('welded + %d junk shells removed ->' % (len(shells) - 1), len(src.data.vertices), 'verts')

# -- 2. lay it FLAT (Blender XY plane, thin in Z) and centre it ---------------
n = len(src.data.vertices)
P = np.empty(n * 3, 'f8'); src.data.vertices.foreach_get('co', P); P = P.reshape(n, 3)
thin = int(np.argmin(P.max(0) - P.min(0)))
if thin != 2:                                     # glTF import leaves the rug standing up
    R = Matrix.Rotation(np.pi / 2, 4, 'X') if thin == 1 else Matrix.Rotation(np.pi / 2, 4, 'Y')
    src.data.transform(R)
    P = np.empty(n * 3, 'f8'); src.data.vertices.foreach_get('co', P); P = P.reshape(n, 3)
ctr = np.array([P[:, 0].mean(), P[:, 1].mean(), (P[:, 2].min() + P[:, 2].max()) / 2])
src.data.transform(Matrix.Translation(Vector(-ctr)))
P = np.empty(n * 3, 'f8'); src.data.vertices.foreach_get('co', P); P = P.reshape(n, 3)
ext = P.max(0) - P.min(0)
log('flat: %.3f x %.3f m, %.1f mm thick' % (ext[0], ext[1], ext[2] * 1000))

# -- 3. where is the BODY of the rug (vs the fringe strands)? -----------------
bmt = bmesh.new(); bmt.from_mesh(src.data); bmesh.ops.triangulate(bmt, faces=bmt.faces[:])
bvh = BVHTree.FromBMesh(bmt)
TOP = P[:, 2].max() + 0.05
def column(x, y):
    """all surface crossings straight down through (x,y) -> list of z, top first"""
    o = Vector((x, y, TOP)); d = Vector((0, 0, -1)); zs = []
    while len(zs) < 24:
        h = bvh.ray_cast(o, d, 1.0)
        if h[0] is None: break
        zs.append(h[0].z); o = h[0] + d * 1e-5
    return zs
RS = 0.006
gx = np.arange(P[:, 0].min(), P[:, 0].max() + RS, RS)
gy = np.arange(P[:, 1].min(), P[:, 1].max() + RS, RS)
body = np.zeros((len(gx), len(gy)), bool); mid = np.full((len(gx), len(gy)), np.nan)
thick = np.full((len(gx), len(gy)), np.nan)
for i, x in enumerate(gx):
    for j, y in enumerate(gy):
        zs = column(x, y)
        if len(zs) >= 2:
            th = zs[0] - zs[-1]
            if 0.006 <= th <= 0.05:
                body[i, j] = True; mid[i, j] = (zs[0] + zs[-1]) / 2; thick[i, j] = th
bx, by = np.nonzero(body)
u0, u1 = float(gx[bx.min()]), float(gx[bx.max()])
v0, v1 = float(gy[by.min()]), float(gy[by.max()])
midz = float(np.nanmean(mid))
TH = np.nanpercentile(thick, [5, 50, 95]) * 1000
log('slab thickness mm: p05 %.1f median %.1f p95 %.1f' % tuple(TH))
# the scanned rug is gently bowed; a cloth REST state must be flat, or the sheet
# for ever remembers the bow. Fill + smooth the mid-surface field, then subtract it.
H = mid.copy()
for _ in range(40):
    Q = np.pad(H, 1, mode='edge')
    nb = np.stack([Q[:-2, 1:-1], Q[2:, 1:-1], Q[1:-1, :-2], Q[1:-1, 2:]])
    avg = np.nanmean(nb, axis=0)
    H = np.where(np.isnan(H), avg, H)
H = np.where(np.isnan(H), midz, H)
for _ in range(25):
    Q = np.pad(H, 1, mode='edge')
    H = 0.5 * H + 0.5 * 0.25 * (Q[:-2, 1:-1] + Q[2:, 1:-1] + Q[1:-1, :-2] + Q[1:-1, 2:])
log('bow flattened: mid-surface field %.1f .. %.1f mm' % (H.min() * 1000, H.max() * 1000))
def bow_at(x, y):
    i = np.clip(((x - gx[0]) / RS).astype(int), 0, len(gx) - 1)
    j = np.clip(((y - gy[0]) / RS).astype(int), 0, len(gy) - 1)
    return H[i, j]
log('body %.3f x %.3f m (%.1f%% of the footprint raster), mid-surface z = %.1f mm'
    % (u1 - u0, v1 - v0, 100 * body.mean(), midz * 1000))

# -- 4. THE CLOTH LATTICE: flat, regular, uniform rest lengths ----------------
nx = max(2, int(round((u1 - u0) / SIM_SP)) + 1)
ny = max(2, int(round((v1 - v0) / SIM_SP)) + 1)
dx, dy = (u1 - u0) / (nx - 1), (v1 - v0) / (ny - 1)
GX = u0 + dx * np.arange(nx); GY = v0 + dy * np.arange(ny)
G = np.zeros((nx, ny, 3))
G[:, :, 0] = GX[:, None]; G[:, :, 1] = GY[None, :]; G[:, :, 2] = midz
simme = bpy.data.meshes.new('RugSim')
verts = [tuple(G[i, j]) for j in range(ny) for i in range(nx)]
faces = [(j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i)
         for j in range(ny - 1) for i in range(nx - 1)]
simme.from_pydata(verts, [], faces); simme.update()
sim = bpy.data.objects.new('RugSim', simme); sc.collection.objects.link(sim)
struct = nx * (ny - 1) + ny * (nx - 1)
shear = 2 * (nx - 1) * (ny - 1)
bend = nx * max(0, ny - 2) + ny * max(0, nx - 2)
log('LATTICE %dx%d = %d nodes | %.1f x %.1f mm cells | %d structural + %d shear + %d bend edges'
    % (nx, ny, nx * ny, dx * 1000, dy * 1000, struct, shear, bend))

# -- 5. render SKIN: decimate the million-triangle shell, keep UV + material --
skin = src.copy(); skin.data = src.data.copy(); skin.name = skin.data.name = 'RugSkin'
sc.collection.objects.link(skin)
ratio = min(1.0, SKIN_TRIS / max(1, len(skin.data.polygons)))
if ratio < 1.0:
    md = skin.modifiers.new('dec', 'DECIMATE'); md.ratio = ratio; md.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = skin
    bpy.ops.object.modifier_apply(modifier='dec')
log('skin decimated %.3f ->' % ratio, len(skin.data.vertices), 'verts', len(skin.data.polygons), 'tris')
bpy.data.objects.remove(src)

# -- 6. EMBEDDING: every skin vertex = bilinear cell + offset in the cell frame
m = len(skin.data.vertices)
S = np.empty(m * 3, 'f8'); skin.data.vertices.foreach_get('co', S); S = S.reshape(m, 3)
S[:, 2] -= bow_at(S[:, 0], S[:, 1]) - midz          # unbow: the rest rug lies dead flat
skin.data.vertices.foreach_set('co', S.ravel()); skin.data.update()
fu = np.clip((S[:, 0] - u0) / dx, 0, nx - 1.0001)
fv = np.clip((S[:, 1] - v0) / dy, 0, ny - 1.0001)
ci = fu.astype(int); cj = fv.astype(int)
a = (fu - ci)[:, None]; b = (fv - cj)[:, None]
base = (G[ci, cj] * (1 - a) * (1 - b) + G[ci + 1, cj] * a * (1 - b)
        + G[ci, cj + 1] * (1 - a) * b + G[ci + 1, cj + 1] * a * b)
OFF = S - base          # rest lattice is flat and axis-aligned -> offset IS the local frame
tang = float(np.abs(OFF[:, :2]).max())
q = np.percentile(np.abs(OFF[:, 2]), [50, 95, 99.9]) * 1000
log('embedding: %d skin verts bound to cells; tangential offset max %.1f mm (fringe overhang); '
    '|normal offset| p50 %.1f p95 %.1f p99.9 %.1f max %.1f mm'
    % (m, tang * 1000, q[0], q[1], q[2], np.abs(OFF[:, 2]).max() * 1000))

spec = {
    'source': os.path.basename(SRC),
    'size': [round(u1 - u0, 4), round(v1 - v0, 4)],
    'thickness_mm': round(float(TH[1]), 1), 'pile_extent_mm': round(float(ext[2] * 1000), 1),
    'grid': {'nx': nx, 'ny': ny, 'dx': dx, 'dy': dy, 'u0': u0, 'v0': v0, 'z': midz,
             'nodes': nx * ny, 'edges': {'structural': struct, 'shear': shear, 'bend': bend}},
    'skin': {'verts': m, 'tris': len(skin.data.polygons), 'overhang_mm': round(tang * 1000, 1)},
    'bind': 'u=(x-u0)/dx, v=(y-v0)/dy clamped to the lattice; p = bilerp(cell) + off.x*T + off.y*B + off.z*N',
    'axes': {'note': 'glTF frame: the rug lies in XZ (+Y up); lattice u = +X, v = -Z, n = +Y'},
}
json.dump(spec, open(os.path.join(OUT, 'rug_cloth.json'), 'w'), indent=1)

# -- 6b. the scan says metallic 1 / rough 1; a rug is a dielectric ------------
for mat in bpy.data.materials:
    if not mat.use_nodes: continue
    for nd in mat.node_tree.nodes:
        if nd.type != 'BSDF_PRINCIPLED': continue
        for ln in list(mat.node_tree.links):
            if ln.to_node is nd and ln.to_socket.name in ('Metallic',): mat.node_tree.links.remove(ln)
        nd.inputs['Metallic'].default_value = 0.0
        if not nd.inputs['Roughness'].is_linked: nd.inputs['Roughness'].default_value = 0.92
        log('material', mat.name, '-> dielectric')

# -- 7. textures down to a sane web size -------------------------------------
for im in list(bpy.data.images):
    if im.size[0] == 0:
        try: im.reload()
        except Exception: pass
    log('texture', im.name, '%dx%d' % (im.size[0], im.size[1]))
    if im.size[0] > TEX:
        c = im.copy(); c.scale(TEX, int(im.size[1] * TEX / im.size[0]))
        for mat in bpy.data.materials:
            if not mat.use_nodes: continue
            for nd in mat.node_tree.nodes:
                if nd.type == 'TEX_IMAGE' and nd.image == im: nd.image = c
        log('texture', im.name, im.size[0], '->', c.size[0])

# -- 8. export ---------------------------------------------------------------
for o in bpy.data.objects: o.select_set(o.name in ('RugSkin', 'RugSim'))
bpy.context.view_layer.objects.active = skin
bpy.ops.export_scene.gltf(filepath=OUTGLB, export_format='GLB', use_selection=True,
                          export_apply=True, export_yup=True)
log('wrote', OUTGLB, '%.1f MB' % (os.path.getsize(OUTGLB) / 1048576), '| %.0f s' % (time.time() - T0))

# -- 9. proof: run a real cloth sim on the lattice and carry the skin with it -
if RENDER:
    sc.render.engine = 'BLENDER_WORKBENCH'; sc.render.resolution_x = sc.render.resolution_y = 850
    sh = sc.display.shading; sh.light = 'STUDIO'; sh.show_object_outline = True; sh.type = 'SOLID'
    cam_d = bpy.data.cameras.new('c'); cam = bpy.data.objects.new('c', cam_d); sc.collection.objects.link(cam); sc.camera = cam
    cam_d.type = 'ORTHO'
    wire = sim.copy(); wire.data = sim.data.copy(); wire.name = 'RugWire'; sc.collection.objects.link(wire)
    wm = wire.modifiers.new('w', 'WIREFRAME'); wm.thickness = 0.004
    def shoot(name, off, who, scale=2.3, tgt=None):
        for o in bpy.data.objects:
            if o.type == 'MESH': o.hide_render = (o.name not in who)
        cam_d.ortho_scale = scale
        t = Vector(tgt or (0, 0, midz))
        cam.location = t + Vector(off).normalized() * 4
        cam.rotation_euler = (t - cam.location).normalized().to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(OUT, name); bpy.ops.render.render(write_still=True)
    shoot('lattice_rest.png', (0.35, -0.6, 0.72), {'RugWire'})
    shoot('lattice_rest_zoom.png', (0.35, -0.6, 0.72), {'RugWire'}, 0.45, (0.4, 0.6, midz))
    shoot('skin_rest.png', (0.35, -0.6, 0.72), {'RugSkin'})

if TEST:
    sim.modifiers.clear()
    cl = sim.modifiers.new('cloth', 'CLOTH').settings
    cl.quality = 8; cl.mass = 0.6; cl.tension_stiffness = 20; cl.compression_stiffness = 20
    cl.shear_stiffness = 5; cl.bending_stiffness = 0.6; cl.air_damping = 1.5
    grp = sim.vertex_groups.new(name='pin')
    hold = [(ny - 1) * nx + int(nx * 0.25), (ny - 1) * nx + int(nx * 0.75)]   # two fingers, one end
    grp.add(hold, 1.0, 'REPLACE'); cl.vertex_group_mass = 'pin'
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.09, location=(0, -0.15, midz - 0.35))
    ball = bpy.context.object; ball.modifiers.new('col', 'COLLISION')
    sc.frame_start = 1; sc.frame_end = 70
    dg = bpy.context.evaluated_depsgraph_get()
    for f in range(1, 71):
        sc.frame_set(f); dg.update()
    ev = sim.evaluated_get(dg).data
    D = np.empty(nx * ny * 3, 'f8'); ev.vertices.foreach_get('co', D)
    D = D.reshape(ny, nx, 3).transpose(1, 0, 2)
    log('cloth test: 70 frames, lowest node fell %.0f cm, deformed bbox %s'
        % ((midz - D[:, :, 2].min()) * 100, (D.reshape(-1, 3).max(0) - D.reshape(-1, 3).min(0)).round(3).tolist()))
    # carry the skin: bilinear cell + offset rotated into the DEFORMED cell frame
    TU = np.zeros_like(D); TV = np.zeros_like(D)
    TU[:-1] = D[1:] - D[:-1]; TU[-1] = TU[-2]
    TV[:, :-1] = D[:, 1:] - D[:, :-1]; TV[:, -1] = TV[:, -2]
    TU /= np.linalg.norm(TU, axis=2, keepdims=True); TV /= np.linalg.norm(TV, axis=2, keepdims=True)
    NN = np.cross(TU, TV); NN /= np.linalg.norm(NN, axis=2, keepdims=True)
    TV = np.cross(NN, TU)
    def bil(F):
        return (F[ci, cj] * (1 - a) * (1 - b) + F[ci + 1, cj] * a * (1 - b)
                + F[ci, cj + 1] * (1 - a) * b + F[ci + 1, cj + 1] * a * b)
    newS = bil(D) + bil(TU) * OFF[:, 0:1] + bil(TV) * OFF[:, 1:2] + bil(NN) * OFF[:, 2:3]
    skin.data.vertices.foreach_set('co', newS.ravel()); skin.data.update()
    sim.modifiers.clear(); sim.data.vertices.foreach_set('co', D.transpose(1, 0, 2).ravel()); sim.data.update()
    bpy.data.objects.remove(ball)
    log('skin carried by the lattice: %d verts, draped bbox %s'
        % (m, (newS.max(0) - newS.min(0)).round(3).tolist()))

if TEST and RENDER:
    wire.data = sim.data.copy()
    T = (0, 0, midz - 0.35)
    shoot('lattice_draped.png', (0.5, -1, 0.35), {'RugWire'}, 2.3, T)
    shoot('skin_draped.png', (0.5, -1, 0.35), {'RugSkin'}, 2.3, T)
    shoot('skin_draped_side.png', (1, -0.15, 0.1), {'RugSkin'}, 2.3, T)
if RENDER: log('renders in', OUT)
