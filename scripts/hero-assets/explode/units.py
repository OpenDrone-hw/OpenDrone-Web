"""Group the leaves of a STEP assembly (see step_extract.py) into explode units.

A unit is the smallest thing the exploded view moves and the hover label names:
one screw, one plate, one board (with every SMD part on it), one motor. Names
come from the CAD part names; everything is data-driven so the 3" and the 5"
assemblies go through the same rules.
"""
import pickle, re
import numpy as np

SUB = re.compile(r'^(.+?)_(pad|soldermask|silkscreen|PCB)$')


class Unit:
    def __init__(self, uid, kind, label, cls):
        self.id = uid
        self.kind = kind          # semantic role, used by plan.py
        self.label = label        # clean hover name
        self.cls = cls            # default material class
        self.leaves = []          # (leaf, cls override)
        self.chunk = 'frame'
        self.meta = {}

    # ---- geometry in assembly coordinates (mm) ----
    def world_prims(self, bases):
        """[(cls, rgb, verts(n,3), tris(m,3))] in assembly space."""
        out = []
        for leaf, cls in self.leaves:
            b = bases[leaf['base']]
            M = leaf['M']
            for rgb, (v, t) in b['groups'].items():
                w = v.astype(np.float64) @ M[:3, :3].T + M[:3, 3]
                if np.linalg.det(M[:3, :3]) < 0:
                    t = t[:, ::-1]
                out.append((cls or self.cls, rgb, w, t))
        return out

    def bbox(self, bases):
        pts = np.concatenate([p[2] for p in self.world_prims(bases)])
        return pts.min(0), pts.max(0)


def _fmt_dim(x):
    x = float(x)
    return str(int(x)) if x == int(x) else str(x)


def classify(name):
    """name -> (kind, label template, material class) or None."""
    n = name
    rules = [
        (r'^Base-Bot$', 'bottom', 'Bottom plate (carbon)', 'carbon'),
        (r'^Base-Top$', 'middle', 'Middle plate (carbon)', 'carbon'),
        (r'^Top$', 'top', 'Top plate (carbon)', 'carbon'),
        (r'^Arm$', 'arm', 'Arm (carbon)', 'carbon'),
        (r'^Cross$', 'cross', 'Cross (carbon)', 'carbon'),
        (r'^Standoff-[LR]$', 'side', 'Camera side plate (aluminium)', 'sideplate'),
        (r'^Standoff M3 F-F', 'standoff', 'Standoff M3 F-F 20 mm (aluminium)', 'alu'),
        (r'^m(\d) pressnut$', 'insert', 'M{0} press-fit insert', 'steel'),
        (r'^Washer M(\d)', 'washer', 'M{0} washer', 'steel'),
        (r'^Grommet M(\d)', 'grommet', 'M{0} silicone grommet', 'rubber'),
        (r'^Prevailing torque nut thin M(\d)', 'nut', 'M{0} nylon lock nut', 'steel'),
        (r'^Prevailing torque nut M5', 'propnut', 'M5 prop nut (lock)', 'steel'),
        (r'^(CW_PROP|5in-prop cw)$', 'prop', 'Propeller (CW)', 'prop'),
        (r'^(CCW_PROP|5in-prop ccw)$', 'prop', 'Propeller (CCW)', 'prop'),
        (r'^(bootF[LR]|bootR[LR]|Boot-[LR])$', 'boot', 'Arm boot (TPU, O4 Pro)', 'tpu'),
        (r'^Cam-Mount-[LR]$', 'cammount', 'Camera soft mount (TPU, O4 Pro)', 'tpu'),
        (r'^VTX-Mount$', 'mount', 'Air unit mount (TPU, O4 Pro)', 'tpu'),
        (r'^Airtag/Antenna[- ][Mm]ount$', 'tagmount', 'AirTag and antenna mount (TPU, O4 Pro)', 'tpu'),
        (r'^(Bumpr|Bumper)$', 'bumper', 'Bumper (TPU, O4 Pro)', 'tpu'),
        (r'^xt30Mount$', 'xtmount', 'XT30 mount (TPU)', 'tpu'),
        (r'^anti-slip pad$', 'pad', 'Battery pad (silicone)', 'antislip'),
        (r'^AirTag$', 'airtag', 'AirTag (not included)', 'tag'),
        (r'^DJI O4  Pro Antenna', 'antenna', 'O4 Pro antenna', 'antenna'),
        (r'^(2\.4ghz-ufl|Dual-Band-UFL-Antenna)$', 'rxant', 'Receiver antenna (U.FL)', 'antenna'),
    ]
    for rx, kind, label, cls in rules:
        m = re.match(rx, n)
        if m:
            return kind, label.format(*m.groups()), cls
    return None


def screw_label(name):
    m = re.match(r'(.*screw).*M(\d)x[\d.]+ x (\d+)', name)
    if not m:
        return 'Screw'
    d, ln = m.group(2), m.group(3)
    if 'countersunk' in m.group(1):
        t = 'countersunk screw'
    elif 'cap screw' in m.group(1):
        t = 'socket head cap screw'
    else:
        t = 'button head screw'
    return f'M{d}x{ln} {t}'


CAMERA = re.compile(r'^(Body|Lens|Front Housing|Rear Housing)')
AIRUNIT = re.compile(r'^(Top Casing|Bottom Casing|USB C|BM6B|Black-Oxide)')
XT30C = re.compile(r'^(Boss-Extrude|Chamfer|Cut-Extrude)')
MOTOR = re.compile(r'^(Admi|2306)')
HARDWARE = re.compile(r'screw|nut|Washer|Grommet|Standoff|pressnut', re.I)


def build_units(pkl, board_titles):
    d = pickle.load(open(pkl, 'rb'))
    bases, leaves = d['bases'], d['leaves']
    units = []
    counters = {}

    def uid(prefix):
        counters[prefix] = counters.get(prefix, 0) + 1
        return f'{prefix}-{counters[prefix]}'

    def wb(leaf):
        b = bases[leaf['base']]
        P = np.concatenate([v for v, _ in b['groups'].values()])
        W = P @ leaf['M'][:3, :3].T + leaf['M'][:3, 3]
        return W.min(0), W.max(0)

    # boards from their substrate fragments
    boards = {}
    for leaf in leaves:
        n = bases[leaf['base']]['name']
        m = SUB.match(n)
        if m and m.group(2) == 'PCB':
            lo, hi = wb(leaf)
            boards[m.group(1)] = (lo, hi)
    board_units = {}
    for bid, (lo, hi) in boards.items():
        low = bid.lower()
        kind = 'fc' if 'fc' in low else 'esc' if 'esc' in low else 'rx' if 'rx' in low else 'board'
        u = Unit(f'board-{kind}', kind, board_titles.get(bid, bid), 'smd')
        u.meta['board'] = bid
        u.chunk = f'board-{bid}'
        board_units[bid] = u
        units.append(u)

    def nearest_board(c):
        best, bd = None, 1e9
        for bid, (lo, hi) in boards.items():
            if not (lo[0] - 2 <= c[0] <= hi[0] + 2 and lo[1] - 2 <= c[1] <= hi[1] + 2):
                continue
            dz = max(lo[2] - c[2], 0, c[2] - hi[2])
            if dz < 8 and dz < bd:
                best, bd = bid, dz
        return best

    camera = Unit('camera', 'camera', 'DJI O4 Pro camera', 'camera'); camera.chunk = 'video'
    air = Unit('airunit', 'air', 'DJI O4 Pro air unit', 'smd'); air.chunk = 'video'
    xt30c = Unit('xt30', 'xtconn', 'XT30 connector', 'steel')
    motors = []
    unclaimed = []
    rest = []
    for leaf in leaves:
        n = bases[leaf['base']]['name']
        m = SUB.match(n)
        suffix_cls = {'pad': 'padgold', 'silkscreen': 'silk', 'soldermask': 'mask', 'PCB': 'fr4'}
        if m:
            board_units[m.group(1)].leaves.append((leaf, suffix_cls[m.group(2)]))
            continue
        base_n = re.sub(r'^(.*?):\d+__.*$', r'\1', n)  # "Top Casing:1__Body1"
        if CAMERA.match(n):
            camera.leaves.append((leaf, 'camera')); continue
        if AIRUNIT.match(n):
            cls = 'heatsink' if re.match(r'^(Top|Bottom) Casing', n) else 'smd'
            air.leaves.append((leaf, cls)); continue
        if XT30C.match(n):
            xt30c.leaves.append((leaf, 'steel')); continue
        if MOTOR.match(n):
            lo, hi = wb(leaf)
            c = (lo + hi) / 2
            for mu in motors:
                if np.hypot(*(mu.meta['c'][:2] - c[:2])) < 20:
                    mu.leaves.append((leaf, 'motor')); break
            else:
                mu = Unit(uid('motor'), 'motor', 'Motor', 'motor')
                mu.meta['c'] = c
                mu.leaves.append((leaf, 'motor')); mu.chunk = 'drive'
                motors.append(mu)
            continue
        if re.search(r'screw', n, re.I):
            u = Unit(uid('screw'), 'screw', screw_label(n), 'steel')
            u.meta['name'] = n
            u.leaves.append((leaf, None)); units.append(u)
            continue
        cl = classify(n)
        if cl:
            kind, label, cls = cl
            u = Unit(uid(kind), kind, label, cls)
            u.leaves.append((leaf, None)); units.append(u)
            continue
        rest.append(leaf)
    for leaf in rest:
        lo, hi = wb(leaf)
        bid = nearest_board((lo + hi) / 2)
        if bid:
            board_units[bid].leaves.append((leaf, 'smd'))
        else:
            unclaimed.append(bases[leaf['base']]['name'])
    units += motors
    # a mirrored soft mount is missing from some assemblies (5": only Cam-Mount-L): mirror it
    cms = [u for u in units if u.kind == 'cammount']
    if len(cms) == 1 and camera.leaves:
        lo = np.min([wb(l)[0] for l, _ in camera.leaves], axis=0)
        hi = np.max([wb(l)[1] for l, _ in camera.leaves], axis=0)
        cx = (lo[0] + hi[0]) / 2
        src = cms[0].leaves[0][0]
        F = np.eye(4); F[0, 0] = -1; F[0, 3] = 2 * cx
        u = Unit(uid('cammount'), 'cammount', cms[0].label, cms[0].cls)
        u.leaves.append((dict(base=src['base'], path=src['path'], M=F @ src['M']), None))
        units.append(u)
    for u in (camera, air, xt30c):
        if u.leaves:
            units.append(u)
    # chunks
    for u in units:
        if u.kind in ('motor', 'prop', 'propnut'):
            u.chunk = 'drive'
        elif u.kind in ('mount', 'antenna', 'cammount', 'camera', 'air'):
            u.chunk = 'video'
    return d, units, unclaimed
