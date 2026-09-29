"""Cycles renderer for the "in the box" flat lays.

Run by scripts/in-the-box/render.mjs, never by hand:

    blender -b --factory-startup -P blender_render.py -- <job.json>

job.json: {"glb", "texDir", "out", "boxesOut", "width", "tiltDeg",
"samples", "marginFrac"}. The GLB is the laid-out composition exported by
stage.js; every mesh node's extras name its finish, textures (PNG files in
texDir by id), in-the-box row ("item") and layout block ("block"). This
script builds the materials, a soft product-photo light rig and a shadow
catcher, renders a transparent PNG and writes, per block, the box it covers
in the image as percentages (top-left origin) for the page's annotations.
"""

import json
import math
import os
import sys
import time

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

JOB = json.load(open(sys.argv[sys.argv.index('--') + 1]))
T0 = time.time()


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgba(hexstr, a=1.0):
    h = hexstr.lstrip('#')
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (a,)


# ---- Scene ----------------------------------------------------------------

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=JOB['glb'])
meshes = [o for o in scene.objects if o.type == 'MESH']

cy = scene.cycles
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'
    prefs.refresh_devices()
    for d in prefs.devices:
        d.use = True
    cy.device = 'GPU'
except Exception:  # noqa: BLE001 - CPU fallback is fine
    cy.device = 'CPU'
cy.samples = int(JOB.get('samples', 96))
cy.use_denoising = True
cy.denoiser = 'OPENIMAGEDENOISE'
cy.max_bounces = 8
cy.glossy_bounces = 4
cy.transparent_max_bounces = 16
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = float(JOB.get('exposure', 0.0))

# ---- Materials ------------------------------------------------------------

TEXDIR = JOB['texDir']
_images = {}


def image(tid, data=True):
    key = (tid, data)
    if key not in _images:
        img = bpy.data.images.load(os.path.join(TEXDIR, f'{tid}.png'), check_existing=False)
        img.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
        _images[key] = img
    return _images[key]


class Graph:
    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.nt = self.mat.node_tree
        self.nt.nodes.clear()
        self.out = self.n('ShaderNodeOutputMaterial')
        self.bsdf = self.n('ShaderNodeBsdfPrincipled')
        self.link(self.bsdf.outputs[0], self.out.inputs['Surface'])

    def n(self, kind, **props):
        node = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(node, k, v)
        return node

    def link(self, a, b):
        self.nt.links.new(a, b)

    def set(self, name, value):
        sock = self.bsdf.inputs.get(name)
        if sock is None:
            return
        if hasattr(value, 'bl_idname') or hasattr(value, 'node'):
            self.link(value, sock)
        else:
            sock.default_value = value

    def uv(self):
        return self.n('ShaderNodeTexCoord').outputs['UV']

    def tex(self, tid, data=True, vector=None, closest=False):
        t = self.n('ShaderNodeTexImage')
        t.image = image(tid, data)
        t.interpolation = 'Closest' if closest else 'Linear'
        if vector is not None:
            self.link(vector, t.inputs['Vector'])
        return t

    def math(self, op, a, b=None, clamp=False):
        m = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                self.link(v, m.inputs[i])
        return m.outputs[0]

    def mix(self, fac, a, b):
        m = self.n('ShaderNodeMix', data_type='RGBA')
        for sock, v in ((m.inputs[0], fac), (m.inputs[6], a), (m.inputs[7], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            elif isinstance(v, tuple):
                sock.default_value = v
            else:
                self.link(v, sock)
        return m.outputs[2]

    def bevel(self, radius):
        b = self.n('ShaderNodeBevel', samples=8)
        b.inputs['Radius'].default_value = radius
        return b.outputs[0]

    def bump(self, height, strength, distance, normal=None):
        b = self.n('ShaderNodeBump')
        b.inputs['Strength'].default_value = strength
        b.inputs['Distance'].default_value = distance
        self.link(height, b.inputs['Height'])
        if normal is not None:
            self.link(normal, b.inputs['Normal'])
        return b.outputs[0]

    def edge_mask(self, bevel_normal, gain):
        """0 on flat faces, towards 1 on the rounded (bevelled) edges."""
        geo = self.n('ShaderNodeNewGeometry')
        dot = self.n('ShaderNodeVectorMath', operation='DOT_PRODUCT')
        self.link(bevel_normal, dot.inputs[0])
        self.link(geo.outputs['Normal'], dot.inputs[1])
        inv = self.math('SUBTRACT', 1.0, dot.outputs['Value'])
        return self.math('MULTIPLY', inv, gain, clamp=True)

    def noise(self, scale, detail=2.0, coord='Position'):
        n = self.n('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        if coord == 'Position':
            self.link(self.n('ShaderNodeNewGeometry').outputs['Position'], n.inputs['Vector'])
        return n.outputs['Fac']


def carbon(ud):
    g = Graph('carbon')
    tw = g.tex(ud['tex']['twill'], True, g.uv())
    sep = g.n('ShaderNodeSeparateColor')
    g.link(tw.outputs['Color'], sep.inputs[0])
    crown, warp, gap = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    bev = g.bevel(0.00035)
    edge = g.edge_mask(bev, 3.0)
    tone = g.mix(g.math('MULTIPLY', crown, 0.6), rgba('#0c0d0f'), rgba('#1d1e22'))
    tone = g.mix(g.math('MULTIPLY', gap, 0.8), tone, rgba('#060607'))
    # Machined edges: exposed fibre reads matte grey.
    g.set('Base Color', g.mix(edge, tone, rgba('#4a4c52')))
    rough = g.math('ADD', g.math('MULTIPLY', warp, -0.12), 0.40)
    g.set('Roughness', g.math('ADD', rough, g.math('MULTIPLY', edge, 0.35), clamp=True))
    g.set('Anisotropic', 0.55)
    g.set('Anisotropic Rotation', g.math('MULTIPLY', warp, 0.25))
    tan = g.n('ShaderNodeTangent', direction_type='UV_MAP')
    g.set('Tangent', tan.outputs[0])
    coat = float(ud.get('coat', 0.3))
    g.set('Coat Weight', coat)
    g.set('Coat Roughness', 0.18)
    height = g.math('SUBTRACT', crown, gap)
    g.set('Normal', g.bump(height, 0.35, 0.00006, bev))
    return g.mat


def anodised(ud, brushed=False):
    g = Graph('alu')
    bev = g.bevel(float(ud.get('bevel', 0.0003)))
    edge = g.edge_mask(bev, 2.5)
    base = rgba(ud.get('color', '#16171a'))
    # Bead blast: satin body; the cut chamfer catches light brighter.
    g.set('Base Color', g.mix(edge, base, rgba(ud.get('chamfer', '#8a8d93'))))
    g.set('Metallic', 1.0)
    g.set('Roughness', g.math('ADD', g.math('MULTIPLY', edge, -0.2), 0.42 if not brushed else 0.3))
    if brushed:
        g.set('Anisotropic', 0.7)
    g.set('Normal', g.bump(g.noise(9000, 1.0), 0.08, 0.00002, bev))
    return g.mat


def metal(color, rough, aniso=0.0, bevel=0.00012):
    g = Graph('metal')
    g.set('Base Color', rgba(color))
    g.set('Metallic', 1.0)
    g.set('Roughness', rough)
    g.set('Anisotropic', aniso)
    g.set('Normal', g.bevel(bevel))
    return g.mat


def tpu(ud):
    g = Graph('tpu')
    g.set('Base Color', rgba(ud.get('color', '#ffb700')))
    g.set('Roughness', 0.72)
    g.set('Sheen Weight', 0.25)
    g.set('Specular IOR Level', 0.35)
    # Printed layers: 0.2 mm bands in world Z (the parts lie as printed).
    wave = g.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Z', wave_profile='SIN')
    g.link(g.n('ShaderNodeNewGeometry').outputs['Position'], wave.inputs['Vector'])
    wave.inputs['Scale'].default_value = 1.0 / 0.0002 / 6.283
    wave.inputs['Distortion'].default_value = 0.0
    g.set('Normal', g.bump(wave.outputs['Fac'], 0.25, 0.00004, g.bevel(0.0004)))
    return g.mat


def rubber(ud, rough=0.6):
    g = Graph('rubber')
    g.set('Base Color', rgba(ud.get('color', '#1e1f22')))
    g.set('Roughness', rough)
    g.set('Sheen Weight', 0.2)
    g.set('Coat Weight', 0.15)
    g.set('Coat Roughness', 0.35)
    g.set('Normal', g.bevel(0.0003))
    return g.mat


def pad(ud):
    g = Graph('pad')
    g.set('Base Color', rgba(ud.get('color', '#1c1d20')))
    g.set('Roughness', 0.72)
    g.set('Sheen Weight', 0.3)
    bev = g.bevel(0.0004)
    micro = g.bump(g.noise(2600, 3.0), 0.35, 0.00004, bev)
    mask = g.tex(ud['tex']['deboss'], True, g.uv()).outputs['Color']
    blur = g.n('ShaderNodeSeparateColor')
    g.link(mask, blur.inputs[0])
    depth = g.math('SUBTRACT', 1.0, blur.outputs[0])
    g.set('Normal', g.bump(depth, 1.0, float(ud.get('depthMm', 0.35)) / 1000, micro))
    return g.mat


def webbing(ud):
    g = Graph('webbing')
    t = ud.get('tex', {})
    uv = g.uv()
    if 'color' in t:
        g.set('Base Color', g.tex(t['color'], False, uv).outputs['Color'])
    else:
        g.set('Base Color', rgba('#131417'))
    if 'rough' in t:
        g.set('Roughness', g.math('MULTIPLY', g.tex(t['rough'], True, uv).outputs['Color'], 0.95))
    else:
        g.set('Roughness', 0.8)
    g.set('Sheen Weight', 0.45)
    g.set('Sheen Roughness', 0.4)
    if 'height' in t:
        g.set('Normal', g.bump(g.tex(t['height'], True, uv).outputs['Color'], 0.9, 0.00025))
    return g.mat


def paper(ud):
    g = Graph('paper')
    uv = g.uv()
    g.set('Base Color', g.tex(ud['tex']['color'], False, uv).outputs['Color'])
    foil = g.tex(ud['tex']['foil'], True, uv).outputs['Color'] if 'foil' in ud['tex'] else 0.0
    g.set('Metallic', foil)
    g.set('Roughness', g.math('ADD', g.math('MULTIPLY', foil, -0.62), 0.88) if not isinstance(foil, float) else 0.88)
    g.set('Normal', g.bump(g.noise(1800, 4.0), 0.2, 0.00002, g.bevel(0.0002)))
    return g.mat


def vinyl(ud):
    g = Graph('vinyl')
    g.set('Base Color', g.tex(ud['tex']['color'], False, g.uv()).outputs['Color'])
    g.set('Roughness', 0.35)
    g.set('Coat Weight', 0.6)
    g.set('Coat Roughness', 0.12)
    g.set('Normal', g.bevel(0.00015))
    return g.mat


def bag(ud):
    g = Graph('bag')
    uv = g.uv()
    col = g.tex(ud['tex']['color'], False, uv)
    g.set('Base Color', col.outputs['Color'])
    g.set('Metallic', 0.85)
    g.set('Roughness', 0.18)
    if 'alpha' in ud['tex']:
        a = g.tex(ud['tex']['alpha'], True, uv).outputs['Color']
        g.set('Alpha', a)
    else:
        g.set('Alpha', float(ud.get('alpha', 0.8)))
    crinkle = g.math('ADD', g.noise(700, 6.0), g.math('MULTIPLY', g.noise(90, 2.0), 1.5))
    if 'height' in ud['tex']:
        crinkle = g.math('ADD', crinkle, g.math('MULTIPLY', g.tex(ud['tex']['height'], True, uv).outputs['Color'], 0.6))
    g.set('Normal', g.bump(crinkle, 0.6, 0.0004))
    return g.mat


def clear(edge=False):
    g = Graph('clear')
    g.set('Base Color', rgba('#f2f5f8'))
    g.set('Roughness', 0.08)
    g.set('Transmission Weight', 0.85 if edge else 1.0)
    g.set('IOR', 1.45)
    g.set('Alpha', 0.9 if edge else 0.6)
    return g.mat


def board_image(ud, edge=False):
    g = Graph('image')
    t = g.tex(ud['tex']['color'], False, g.uv())
    g.set('Base Color', rgba('#23262a') if edge else t.outputs['Color'])
    g.set('Alpha', t.outputs['Alpha'])
    g.set('Roughness', 0.45)
    return g.mat


def sleeve(ud):
    g = Graph('sleeve')
    mp = g.n('ShaderNodeMapping')
    mp.inputs['Location'].default_value[0] = float(ud.get('offset', 0.25))
    g.link(g.uv(), mp.inputs['Vector'])
    g.set('Base Color', g.tex(ud['tex']['color'], False, mp.outputs[0]).outputs['Color'])
    g.set('Roughness', 0.3)
    g.set('Coat Weight', 0.5)
    return g.mat


def plastic(ud, rough=0.5):
    g = Graph('plastic')
    g.set('Base Color', rgba(ud.get('color', '#808080')))
    g.set('Roughness', rough)
    g.set('Normal', g.bevel(0.0002))
    return g.mat


BUILD = {
    'carbon': carbon,
    'alu': anodised,
    'alu-brushed': lambda ud: anodised(ud, brushed=True),
    'steel': lambda ud: metal(ud.get('color') if ud.get('color', '#5a5f67') != '#5a5f67' else '#1d1f23', 0.26, 0.3),
    'zinc': lambda ud: metal(ud.get('color') if ud.get('color', '#aeb4bb') != '#aeb4bb' else '#c3c8cf', 0.2),
    'gold': lambda ud: metal('#e2b24e', 0.18),
    'tpu': tpu,
    'rubber': rubber,
    'silicone': lambda ud: rubber(ud, 0.38),
    'nylon': lambda ud: plastic(ud, 0.45),
    'pad': pad,
    'webbing': webbing,
    'paper': paper,
    'vinyl': vinyl,
    'bag': bag,
    'clear': lambda ud: clear(False),
    'clear-edge': lambda ud: clear(True),
    'image': board_image,
    'image-edge': lambda ud: board_image(ud, True),
    'sleeve': sleeve,
    'plastic': plastic,
}

_cache = {}


def material_for(ud):
    finish = ud.get('finish', 'plastic')
    key = json.dumps(ud, sort_keys=True)
    if key not in _cache:
        _cache[key] = BUILD.get(finish, plastic)(ud)
    return _cache[key]


def props(obj):
    out = {}
    for k in obj.keys():
        v = obj[k]
        out[k] = v.to_dict() if hasattr(v, 'to_dict') else (list(v) if hasattr(v, 'to_list') else v)
    return out


for o in meshes:
    ud = props(o)
    finish = ud.get('finish', 'plastic')
    if finish == 'original':
        continue
    slots = o.material_slots
    faces = ud.get('faceFinishes')
    for i, slot in enumerate(slots):
        u = dict(ud)
        if faces and i < len(faces):
            u['finish'] = faces[i]
            u['tex'] = (ud.get('faceTex') or [{}] * len(faces))[i]
        u.pop('faceFinishes', None)
        u.pop('faceTex', None)
        u.pop('item', None)
        u.pop('block', None)
        slot.material = material_for(u)
    if not slots:
        o.data.materials.append(material_for(ud))

# ---- Bounds, ground, camera ------------------------------------------------

deps = bpy.context.evaluated_depsgraph_get()
pts = []
for o in meshes:
    mw = o.matrix_world
    for v in o.data.vertices:
        pts.append(mw @ v.co)
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
centre = (lo + hi) / 2
span = max(hi.x - lo.x, hi.y - lo.y)

bpy.ops.mesh.primitive_plane_add(size=span * 8, location=(centre.x, centre.y, lo.z))
ground = bpy.context.active_object
ground.is_shadow_catcher = True
ground.data.materials.append(plastic({'color': '#808080'}, 0.9))

tilt = math.radians(float(JOB.get('tiltDeg', 0)))
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.sensor_fit = 'HORIZONTAL'
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
dist = span * 4
cam.location = centre + Vector((0, -math.sin(tilt) * dist, math.cos(tilt) * dist))
cam.rotation_euler = (tilt, 0, 0)
cam_data.clip_start = 0.001
cam_data.clip_end = dist * 3
scene.camera = cam
bpy.context.view_layer.update()

inv = cam.matrix_world.inverted()
cp = [inv @ p for p in pts]
x0, x1 = min(p.x for p in cp), max(p.x for p in cp)
y0, y1 = min(p.y for p in cp), max(p.y for p in cp)
m = float(JOB.get('marginFrac', 0.04)) * max(x1 - x0, y1 - y0)
x0, x1, y0, y1 = x0 - m, x1 + m, y0 - m, y1 + m
cam.location = cam.matrix_world @ Vector(((x0 + x1) / 2, (y0 + y1) / 2, 0))
cam_data.ortho_scale = x1 - x0
W = int(JOB.get('width', 2400))
H = int(round(W * (y1 - y0) / (x1 - x0)))
scene.render.resolution_x = W
scene.render.resolution_y = H
scene.render.resolution_percentage = 100
bpy.context.view_layer.update()

# ---- Lights: large soft key, fill, low kickers that trace edges -----------------

world = bpy.data.worlds.new('world')
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = rgba('#8a8c90')
bg.inputs['Strength'].default_value = float(JOB.get('ambient', 0.12))
scene.world = world


def area(name, loc, size, power, color='#ffffff', size_y=None):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'RECTANGLE'
    ld.size = size
    ld.size_y = size_y if size_y is not None else size
    ld.energy = power
    ld.color = rgba(color)[:3]
    ob = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(ob)
    ob.location = centre + Vector(loc)
    d = centre - ob.location
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return ob


s = span
k = float(JOB.get('lightScale', 1.0)) * (s / 0.35) ** 2
area('key', (-0.45 * s, 0.55 * s, 1.1 * s), 1.1 * s, 900 * k, '#fff8ee', 0.8 * s)
area('fill', (0.8 * s, -0.4 * s, 0.9 * s), 1.4 * s, 260 * k, '#eef3ff')
area('kick-back', (0.0, 1.2 * s, 0.22 * s), 1.6 * s, 520 * k, '#ffffff', 0.06 * s)
area('kick-left', (-1.2 * s, 0.0, 0.2 * s), 1.4 * s, 300 * k, '#ffffff', 0.05 * s)
area('kick-right', (1.2 * s, 0.1 * s, 0.25 * s), 1.4 * s, 220 * k, '#ffffff', 0.05 * s)

# ---- Render ----------------------------------------------------------------

scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.render.filepath = JOB['out']
bpy.ops.render.render(write_still=True)

# ---- Per-block boxes in image space ------------------------------------------

boxes = {}
for o in meshes:
    ud = props(o)
    if 'block' not in ud:
        continue
    key = int(ud['block'])
    mw = o.matrix_world
    for v in o.data.vertices:
        c = world_to_camera_view(scene, cam, mw @ v.co)
        b = boxes.setdefault(key, {'item': ud.get('item'), 'x0': 1, 'y0': 1, 'x1': 0, 'y1': 0})
        b['x0'] = min(b['x0'], c.x)
        b['x1'] = max(b['x1'], c.x)
        b['y0'] = min(b['y0'], 1 - c.y)
        b['y1'] = max(b['y1'], 1 - c.y)
out = []
for key in sorted(boxes):
    b = boxes[key]
    if b['item'] is None:
        continue
    out.append({'item': int(b['item']), 'x': round(b['x0'] * 100, 2), 'y': round(b['y0'] * 100, 2),
                'w': round((b['x1'] - b['x0']) * 100, 2), 'h': round((b['y1'] - b['y0']) * 100, 2)})
json.dump({'width': W, 'height': H, 'boxes': out, 'seconds': round(time.time() - T0, 1)},
          open(JOB['boxesOut'], 'w'))
print(f'IN_THE_BOX_DONE {W}x{H} {time.time() - T0:.1f}s')
