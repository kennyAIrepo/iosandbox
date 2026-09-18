# Render orthographic reference views of a GLB head with a 5 cm tick grid → PNGs
import bpy, sys, json, math
from mathutils import Vector
argv = sys.argv[sys.argv.index('--')+1:]
src, outdir = argv[0], argv[1]
markers = json.loads(argv[2]) if len(argv) > 2 else {}      # name → [x,y,z] world (Blender frame)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.vertices) < 100: bpy.data.objects.remove(o)   # stray icosphere
mesh = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
# Meshy materials: metallic=1 + emissive; workbench TEXTURE mode shows the ACTIVE image node -> make it base color
for m in mesh.data.materials:
    if m and m.use_nodes:
        bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf:
            bsdf.inputs['Metallic'].default_value = 0
            lnk = bsdf.inputs['Base Color'].links
            if lnk and lnk[0].from_node.type == 'TEX_IMAGE':
                for n in m.node_tree.nodes: n.select = (n == lnk[0].from_node)
                m.node_tree.nodes.active = lnk[0].from_node
                im = lnk[0].from_node.image
                if im and im.size[0] > 2048: im.scale(2048, 2048)
# head region = vertices with z above 0.75 of bbox height (bust) – just for framing
bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
zmax = max(v.z for v in bb); zmin = min(v.z for v in bb)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'TEXTURE'
sc.display.shading.show_cavity = True
sc.render.resolution_x = 1400; sc.render.resolution_y = 1000; sc.render.film_transparent = False
sc.world = bpy.data.worlds.new('W'); sc.world.color = (0.12, 0.12, 0.14)
# tick grid: tiny cubes every 5 cm
mat = bpy.data.materials.new('tick'); mat.diffuse_color = (1, 0.2, 0.2, 1)
matm = bpy.data.materials.new('mk'); matm.diffuse_color = (0.1, 1, 0.2, 1)
def dot(p, s, m, name='tick'):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=s, location=p, segments=8, ring_count=6)
    o = bpy.context.object; o.name = name; o.data.materials.append(m); return o
def frame(center, size, view):
    cam = bpy.data.cameras.new('c'); cam.type = 'ORTHO'; cam.ortho_scale = size
    co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
    c = Vector(center)
    if view == 'front':  co.location = c + Vector((0, -3, 0)); co.rotation_euler = (math.pi/2, 0, 0)
    if view == 'side':   co.location = c + Vector((3, 0, 0));  co.rotation_euler = (math.pi/2, 0, math.pi/2)
    if view == 'below':  co.location = c + Vector((0, 0, -3)); co.rotation_euler = (math.pi, 0, 0)
    if view == 'frontlow': co.location = c + Vector((0, -3, -1.2)); co.rotation_euler = (math.radians(112), 0, 0)
    if view == 'three':  co.location = c + Vector((2.2, -2.2, 0.6)); co.rotation_euler = (math.radians(80), 0, math.radians(45))
    return co
center = json.loads(argv[3]) if len(argv) > 3 else [0, -0.1, (zmax*0.85)]
size = float(argv[4]) if len(argv) > 4 else 0.8
ticks = []
if not markers:
    r = size / 2
    for i in range(-8, 9):
        ticks.append(dot((center[0] + i*0.05, center[1] - 0.6, center[2] - r*0.95), 0.004, mat))   # x axis (front view bottom)
        ticks.append(dot((center[0] - r*0.95, center[1] - 0.6, center[2] + i*0.05), 0.004, mat))   # z axis (front view left)
        ticks.append(dot((center[0] + 0.6, center[1] + i*0.05, center[2] - r*0.95), 0.004, mat))   # y axis (side view bottom)
for n, p in markers.items():
    dot(p, 0.006, matm, n)
for view in ['front', 'side', 'below', 'three', 'frontlow']:
    co = frame(center, size, view)
    sc.render.filepath = f'{outdir}/{view}.png'
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co)
print('RENDER_OK', center, size, zmax)
