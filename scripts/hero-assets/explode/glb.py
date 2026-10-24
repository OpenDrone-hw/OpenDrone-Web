"""Minimal glTF 2.0 binary writer (nodes, shared meshes, PBR colours, extras)."""
import json, struct, os
import numpy as np


def normals_for(v, t):
    n = np.zeros_like(v)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, t[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1
    return (n / ln).astype(np.float32)


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.acc, self.meshes, self.nodes, self.mats = [], [], [], [], []
        self.matkey = {}
        self.mesh_cache = {}

    def _view(self, arr, target):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += arr.tobytes()
        self.views.append(dict(buffer=0, byteOffset=off, byteLength=arr.nbytes, target=target))
        return len(self.views) - 1

    def material(self, name, rgb):
        key = (name, tuple(rgb))
        if key not in self.matkey:
            pbr = dict(baseColorFactor=[*rgb, 1.0], metallicFactor=0.0, roughnessFactor=1.0)
            self.mats.append(dict(name=name, pbrMetallicRoughness=pbr))
            self.matkey[key] = len(self.mats) - 1
        return self.matkey[key]

    def mesh(self, key, prims, name):
        """prims: [(matname, rgb, verts(m,3) metres float32, tris)] -> mesh index (cached by key)."""
        if key in self.mesh_cache:
            return self.mesh_cache[key]
        gp = []
        for prim in prims:
            matname, rgb, v, t = prim[:4]
            extra = prim[4] if len(prim) > 4 else {}
            v = v.astype(np.float32)
            n = normals_for(v, t)
            idx = t.astype(np.uint32).reshape(-1)
            a_pos = self._view(v, 34962)
            a_nor = self._view(n, 34962)
            a_idx = self._view(idx, 34963)
            base = len(self.acc)
            self.acc += [
                dict(bufferView=a_pos, componentType=5126, count=len(v), type='VEC3', min=v.min(0).tolist(), max=v.max(0).tolist()),
                dict(bufferView=a_nor, componentType=5126, count=len(v), type='VEC3'),
                dict(bufferView=a_idx, componentType=5125, count=len(idx), type='SCALAR'),
            ]
            attrs = dict(POSITION=base, NORMAL=base + 1)
            if 'uv' in extra:
                a_uv = self._view(extra['uv'].astype(np.float32), 34962)
                self.acc.append(dict(bufferView=a_uv, componentType=5126, count=len(v), type='VEC2'))
                attrs['TEXCOORD_0'] = len(self.acc) - 1
            gp.append(dict(attributes=attrs, indices=base + 2, material=self.material(matname, rgb)))
        self.meshes.append(dict(name=name, primitives=gp))
        self.mesh_cache[key] = len(self.meshes) - 1
        return self.mesh_cache[key]

    def node(self, name, mesh=None, matrix=None, extras=None, children=None):
        n = dict(name=name)
        if mesh is not None:
            n['mesh'] = mesh
        if matrix is not None:
            n['matrix'] = [float(x) for x in matrix.T.reshape(-1)]
        if extras:
            n['extras'] = extras
        if children:
            n['children'] = children
        self.nodes.append(n)
        return len(self.nodes) - 1

    def write(self, path, root):
        doc = dict(asset=dict(version='2.0', generator='hero-assets/explode'),
                   scene=0, scenes=[dict(nodes=[root])], nodes=self.nodes, meshes=self.meshes,
                   materials=self.mats, accessors=self.acc, bufferViews=self.views,
                   buffers=[dict(byteLength=len(self.bin))])
        js = json.dumps(doc, separators=(',', ':')).encode()
        while len(js) % 4:
            js += b' '
        binb = bytes(self.bin)
        while len(binb) % 4:
            binb += b'\0'
        out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(binb))
        out += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binb), 0x004E4942) + binb
        open(path, 'wb').write(out)
