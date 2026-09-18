import bpy, json, sys, math
from mathutils import Vector
argv = sys.argv[sys.argv.index('--')+1:]
src = argv[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
out = {'objects': []}
for o in bpy.data.objects:
    d = {'name': o.name, 'type': o.type, 'parent': o.parent.name if o.parent else None}
    if o.type == 'MESH':
        me = o.data
        d['verts'] = len(me.vertices); d['polys'] = len(me.polygons)
        d['shape_keys'] = [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else []
        d['vgroups'] = len(o.vertex_groups)
        d['mods'] = [(m.type, getattr(m, 'object', None).name if getattr(m, 'object', None) else None) for m in o.modifiers]
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        d['bbox'] = [[round(min(v[i] for v in bb),3), round(max(v[i] for v in bb),3)] for i in range(3)]
        d['materials'] = [m.name for m in me.materials if m]
    if o.type == 'ARMATURE':
        d['bones'] = [(b.name, b.parent.name if b.parent else None, [round(x,3) for x in (o.matrix_world @ b.head_local)], [round(x,3) for x in (o.matrix_world @ b.tail_local)]) for b in o.data.bones]
        d['matrix_world'] = [list(map(lambda x: round(x,3), r)) for r in o.matrix_world]
    out['objects'].append(d)
print('PROBE_JSON ' + json.dumps(out))
