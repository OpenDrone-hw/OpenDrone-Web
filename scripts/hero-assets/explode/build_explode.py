#!/usr/bin/env python3
"""STEP assembly (via step_extract.py pickle) -> exploded-view assets.

usage: build_explode.py <assembly.pkl> <outdir> [--sizes 3|5] [--scale 1.0]
writes <outdir>/raw.glb (every unit a named node, geometry shared where parts
repeat) and <outdir>/explode.json (per unit: label, kind, offset, timing, group).
compress-explode.mjs then splits it into streamed, meshopt-compressed chunks.
"""
import json, sys, os, argparse
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import units as U, plan as P, glb as G

BOARD_TITLES = {
    'OpenFC-Lite-Mini': 'OpenFC Lite Mini (flight controller)',
    'OpenESC-20x20-4in1-mini': 'OpenESC 20x20 4-in-1 mini',
    'OpenRX-Lite-UFL': 'OpenRX Lite (ExpressLRS receiver)',
    'OpenFC-Lite': 'OpenFC Lite (flight controller)',
    'OpenESC-30x30-4in1': 'OpenESC 30x30 4-in-1',
    'OpenRX-Mono': 'OpenRX Mono (ExpressLRS receiver)',
}
TPU_BLACK = (0.01, 0.01, 0.013)
SIDE_GOLD = (0.984, 0.714, 0.0)   # anodised Pantone 7549 C, #FBB600
MM = 0.001


LEGACY_FRAME = ('bottom', 'middle', 'top', 'arm', 'cross', 'side', 'standoff')


def part_name(u, bases):
    """CAD-style part name, as the loader would sanitise it: the product page viewers match on it."""
    if len(u.leaves) == 1 and u.kind not in ('motor',):
        n = bases[u.leaves[0][0]['base']]['name']
    else:
        n = {'motor': 'Motor', 'camera': 'Camera', 'air': 'Air unit', 'xtconn': 'XT30 connector'}.get(u.kind, u.meta.get('board') or u.label)
    return ''.join(ch for ch in n if ch not in '[]./:')


def recolour(cls, rgb):
    if cls == 'sideplate':
        return SIDE_GOLD
    if cls == 'tpu':
        # TPU ships black and green: keep the CAD green, turn every other print colour black
        r, g, bl = rgb
        return tuple(rgb) if (g > r + 0.05 and g > bl) else TPU_BLACK
    return tuple(rgb)


def make_groups(units, drop):
    by = {u.id: u for u in units}
    ids = [u.id for u in units]
    G = {}
    fc = [u for u in units if u.kind == 'fc'][0]
    esc = [u for u in units if u.kind == 'esc'][0]
    G['fc'] = [fc.id] + [u.id for u in units if u.kind == 'grommet' and u.meta.get('host') == fc.id]
    G['esc'] = [esc.id] + [u.id for u in units if u.kind == 'grommet' and u.meta.get('host') == esc.id]
    G['rx'] = [u.id for u in units if u.kind in ('rx', 'rxant')]
    # one motor stack: the front-right one (nearest the default camera)
    motors = [u for u in units if u.kind == 'motor']
    fr = max(motors, key=lambda m: m.meta['c'][0] - m.meta['c'][1])
    arm = fr.meta['arm']
    mg = {fr.id}
    for u in units:
        if u.kind == 'prop' and u.meta.get('motor') == fr.id:
            mg.add(u.id); prop = u.id
    for u in units:
        if u.kind == 'propnut' and u.meta.get('prop') in mg:
            mg.add(u.id)
        if u.kind == 'boot' and u.meta.get('arm') == arm:
            mg.add(u.id)
    for u in units:
        if u.kind == 'screw' and u.meta.get('anchor') in mg:
            mg.add(u.id)
    G['motor'] = sorted(mg)
    allmotor = {u.id for u in units if u.kind in ('motor', 'prop', 'propnut')}
    video = {u.id for u in units if u.kind in ('camera', 'air', 'mount', 'antenna', 'cammount')}
    for u in units:
        if u.kind == 'screw' and u.meta.get('anchor') in video:
            video.add(u.id)
    G['video'] = sorted(video)
    boards = set(G['fc'] + G['esc'] + G['rx'])
    for u in units:
        if u.kind == 'screw' and u.meta.get('anchor') in boards:
            boards.add(u.id)
    G['frame'] = [i for i in ids if i not in video and i not in boards and i not in allmotor
                  and not (by[i].kind in ('boot',)) and by[i].kind not in ('airtag', 'tagmount', 'xtconn')
                  and not (by[i].kind == 'screw' and by[i].meta.get('anchor') in allmotor)
                  and not (by[i].kind == 'nut')]
    return G


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pkl'); ap.add_argument('out')
    ap.add_argument('--scale', type=float, default=1.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    d, units, unclaimed = U.build_units(a.pkl, BOARD_TITLES)
    if unclaimed:
        print('UNCLAIMED leaves:', unclaimed)
    bases = d['bases']
    disp, info, drop, log, hub, pts, moves = P.build_plan(units, bases, a.scale)
    for l in log:
        print(' ', l)
    g = G.Glb()
    lg = G.Glb()
    legacy_kids = []
    kids = []
    out_units = []
    units = [u for u in units if u.id not in drop]
    for u in units:
        single = len(u.leaves) == 1 and np.linalg.det(u.leaves[0][0]['M'][:3, :3]) > 0
        extras = dict(unit=u.id, kind=u.kind, part=part_name(u, bases))
        if u.kind == 'motor':
            # One node per motor, shaft along local Y with no rotation on the bodies:
            # the product page's motor viewer explodes the bodies along the shaft and
            # spins the bell about local Y.
            leaves = [(bases[l['base']], l['M'], c) for l, c in u.leaves]
            allp = np.concatenate([(np.concatenate([v for v, _ in b['groups'].values()]) @ M[:3, :3].T + M[:3, 3]) for b, M, _ in leaves])
            big = max(leaves, key=lambda x: np.ptp(np.concatenate([v for v, _ in x[0]['groups'].values()]) @ x[1][:3, :3].T, axis=0).prod())
            bp = np.concatenate([v for v, _ in big[0]['groups'].values()]) @ big[1][:3, :3].T + big[1][:3, 3]
            c = np.array([(bp[:, 0].min() + bp[:, 0].max()) / 2, (bp[:, 1].min() + bp[:, 1].max()) / 2, allp[:, 2].min()])
            R = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)   # assembly z (shaft) -> local y
            bodies = []
            for i, (b, M, cls) in enumerate(leaves):
                prims = []
                for rgb, (v, t) in b['groups'].items():
                    w = (v.astype(np.float64) @ M[:3, :3].T + M[:3, 3] - c) @ R.T
                    col = tuple(rgb)
                    prims.append(((cls or u.cls) + '|' + ','.join(f'{x:.3f}' for x in col), col, w * MM, t))
                mi = g.mesh(('body', u.id, i), prims, f'{u.id}-body-{i}')
                bodies.append(g.node(f'{u.id}-body-{i}', mi, None, None))
            T = np.eye(4); T[:3, :3] = R.T; T[:3, 3] = c * MM
            node = g.node(u.id, None, T, extras, bodies)
        elif single:
            leaf, cls = u.leaves[0]
            b = bases[leaf['base']]
            prims = []
            for rgb, (v, t) in b['groups'].items():
                c = recolour(cls or u.cls, rgb)
                prims.append(((cls or u.cls) + '|' + ','.join(f'{x:.3f}' for x in c), c, v * MM, t))
            mi = g.mesh(('base', leaf['base'], cls or u.cls), prims, b['name'])
            M = leaf['M'].copy(); M[:3, 3] *= MM
            node = g.node(u.id, mi, M, extras)
        else:
            prims = []
            byc = {}
            for cls, rgb, v, t in u.world_prims(bases):
                c = recolour(cls, rgb)
                byc.setdefault((cls, tuple(c)), []).append((v * MM, t))
            for (cls, c), lst in byc.items():
                vs, ts, off = [], [], 0
                for v, t in lst:
                    vs.append(v); ts.append(t + off); off += len(v)
                prims.append((cls + '|' + ','.join(f'{x:.3f}' for x in c), c, np.concatenate(vs), np.concatenate(ts)))
            mi = g.mesh(('unit', u.id), prims, u.label)
            node = g.node(u.id, mi, None, extras)
        kids.append(node)
        if u.kind in LEGACY_FRAME and single:
            leaf, cls = u.leaves[0]
            b = bases[leaf['base']]
            prims = [((cls or u.cls) + '|' + ','.join(f'{x:.3f}' for x in recolour(cls or u.cls, rgb)), recolour(cls or u.cls, rgb), v * MM, t) for rgb, (v, t) in b['groups'].items()]
            mi = lg.mesh(('base', leaf['base']), prims, b['name'])
            M = leaf['M'].copy(); M[:3, 3] *= MM
            legacy_kids.append(lg.node('occurrence of ' + part_name(u, bases), mi, M, None))
        lo, hi = P_bb = (pts[u.id].min(0), pts[u.id].max(0))
        out_units.append(dict(id=u.id, label=u.label, kind=u.kind, chunk=u.chunk,
                              d=[round(float(x) * MM, 6) for x in disp[u.id]],
                              moves=[dict(v=[round(float(x) * MM, 6) for x in vec], t=round(t0, 3), dur=round(du, 3)) for vec, t0, du in moves[u.id]],
                              c=[round(float(x) * MM, 6) for x in (lo + hi) / 2],
                              r=round(float(np.linalg.norm(hi - lo)) / 2 * MM, 6),
                              anchor=u.meta.get('anchor'), axis=u.meta.get('axis')))
    root = g.node('OpenDrone', None, None, None, kids)
    g.write(os.path.join(a.out, 'raw.glb'), root)
    # builder airframe (public/models/frame<N>.glb): the structural parts, Onshape style
    lg.write(os.path.join(a.out, 'frame-legacy.glb'), lg.node('Frame', None, None, None, legacy_kids))
    json.dump(out_units, open(os.path.join(a.out, 'units.json'), 'w'), indent=1)
    json.dump(dict(units=out_units, groups=make_groups(units, drop)), open(os.path.join(a.out, 'explode.json'), 'w'), separators=(',', ':'))
    print(len(out_units), 'units,', os.path.getsize(os.path.join(a.out, 'raw.glb')) // 1024, 'KB raw')


if __name__ == '__main__':
    main()
