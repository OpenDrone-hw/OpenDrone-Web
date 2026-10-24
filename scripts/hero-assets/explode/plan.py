"""Assembly-order model: where every unit goes in the exploded view.

All numbers derive from the geometry (extents, hole axes, which part a screw
passes through); only the assembly ORDER and the clearances are authored.
Units: mm, assembly coordinates (z up, camera at -y, as in the Onshape export).

Rules, bottom to top:
  bottom plate -> arms + cross (arms also slide out radially, boots off the arm
  tips) -> middle plate (+ press-fit inserts hovering over their holes) ->
  standoffs -> stack column (grommets, ESC, grommets, FC, nylon nuts) ->
  air unit mount -> receiver -> air unit -> top plate -> battery pad / XT30.
  Camera and its soft mounts go forward, the bumper further forward, the aluminium
  side plates drop below the frame and out sideways, the AirTag mount goes back
  and down. Motors lift off the arm ends, props above, prop nuts/screws above.
  Every screw moves along its own axis (head side) until its tip clears the last
  part it passed through, staying lined up with the hole of the part it threads
  into; washers sit between a screw and its seat.
"""
import numpy as np
from geom import unit_points, screw_axis, sample_surface

CELL = 1.2


class Raster:
    """Height map of a unit: cell -> (zmin, zmax)."""

    def __init__(self, pts):
        ij = np.floor(pts[:, :2] / CELL).astype(np.int64)
        key = ij[:, 0] * 100000 + ij[:, 1]
        order = np.argsort(key, kind='stable')
        key = key[order]
        z = pts[order, 2]
        uk, start = np.unique(key, return_index=True)
        self.key = uk
        self.zmin = np.minimum.reduceat(z, start)
        self.zmax = np.maximum.reduceat(z, start)

    def shifted(self, dx, dy):
        sx, sy = int(round(dx / CELL)), int(round(dy / CELL))
        return self.key + sx * 100000 + sy

    def need(self, lower, upper, dl, du, gap):
        """Smallest extra dz for `upper` (in addition to du's z) so that it clears `lower`."""
        kl, ku = lower.shifted(dl[0], dl[1]), upper.shifted(du[0], du[1])
        both, il, iu = np.intersect1d(kl, ku, return_indices=True)
        if len(both) < 3:
            return None
        gap_needed = (lower.zmax[il] + dl[2]) - (upper.zmin[iu] + du[2]) + gap
        return float(gap_needed.max())


def build_plan(units, bases, scale=1.0):
    by = {u.id: u for u in units}
    kinds = {}
    for u in units:
        kinds.setdefault(u.kind, []).append(u)
    K = lambda *ks: [u for k in ks for u in kinds.get(k, [])]
    pts = {u.id: unit_points(u, bases) for u in units}
    bb = {u.id: (pts[u.id].min(0), pts[u.id].max(0)) for u in units}
    ras = {}
    for u in units:
        if u.kind != 'screw':
            ras[u.id] = Raster(pts[u.id])
    d = {u.id: np.zeros(3) for u in units}
    s = scale
    log = []

    def zmin(u): return bb[u.id][0][2]
    def zmax(u): return bb[u.id][1][2]
    def ctr(u): return (bb[u.id][0] + bb[u.id][1]) / 2

    def lift_above(upper, lowers, gap, mode='raster'):
        """Set d_z of `upper` so it clears every unit in `lowers` (current d of lowers)."""
        best = None
        for lo in lowers:
            if mode == 'bbox':
                n = zmax(lo) + d[lo.id][2] + gap - zmin(upper)
            elif mode == 'near':
                # highest surface of `lo` within a few mm of upper's footprint (a floor around a slot)
                ul, uh = bb[upper.id]
                sh = d[lo.id][:2] - d[upper.id][:2]
                P = pts[lo.id]
                m = (P[:, 0] + sh[0] > ul[0] - 5) & (P[:, 0] + sh[0] < uh[0] + 5) & (P[:, 1] + sh[1] > ul[1] - 5) & (P[:, 1] + sh[1] < uh[1] + 5)
                n = (P[m, 2].max() + d[lo.id][2] + gap - zmin(upper)) if m.any() else None
            else:
                n = ras[upper.id].need(ras[lo.id], ras[upper.id], d[lo.id], d[upper.id], gap)
                if n is not None:
                    n = n + d[upper.id][2]
            if n is None:
                continue
            best = n if best is None else max(best, n)
        if best is not None:
            d[upper.id][2] = max(d[upper.id][2], best)
        return d[upper.id][2]

    bot = K('bottom')[0]
    mid = K('middle')[0]
    top = K('top')[0]
    arms = K('arm')
    cross = K('cross')
    hub = np.mean([ctr(a)[:2] for a in arms], axis=0)
    size = max(bb[a.id][1][0] - bb[a.id][0][0] for a in arms)  # arm extent along x

    # ---------------------------------------------------------------- xy moves
    R = 0.43 * size * 1.0
    arm_dir = {}
    for a in arms:
        v = ctr(a)[:2] - hub
        v = v / np.linalg.norm(v)
        arm_dir[a.id] = v
        d[a.id][:2] = v * R
    for a in K('boot'):
        # boot -> its arm; slide off the tip along the arm axis
        arm = min(arms, key=lambda x: np.linalg.norm(ctr(x)[:2] - ctr(a)[:2]))
        v = arm_dir[arm.id]
        ta = (pts[arm.id][:, :2] - hub) @ v
        tb = (pts[a.id][:, :2] - hub) @ v
        overlap = ta.max() - tb.min()
        d[a.id][:2] = v * (R + overlap + 10 * s)
        a.meta['arm'] = arm.id
    # camera forward, soft mounts forward and outward, bumper further forward
    cam = K('camera')[0]
    cam_len = bb[cam.id][1][1] - bb[cam.id][0][1]
    CF = 0.95 * cam_len + 12 * s
    d[cam.id][1] = -CF
    for m in K('cammount'):
        side = np.sign(ctr(m)[0] - ctr(cam)[0]) or 1
        d[m.id][:2] = [side * 15 * s, -CF]
    bump = K('bumper')[0]
    d[bump.id][1] = -(CF + 0.75 * (bb[bump.id][1][1] - bb[bump.id][0][1]) + 14 * s)
    # side plates: up clear of the arm layer, then out sideways
    sides = K('side')
    SX = 26 * s
    for p in sides:
        side = np.sign(ctr(p)[0] - hub[0]) or 1
        d[p.id][0] = side * SX
    # AirTag mount back, AirTag with it
    tm = K('tagmount')[0]
    d[tm.id][1] = 0.55 * (bb[tm.id][1][1] - bb[tm.id][0][1]) + 20 * s
    # antennas of the air unit go back
    for a in K('antenna'):
        d[a.id][1] = 38 * s
        d[a.id][0] = 5 * s * (1 if ctr(a)[0] > hub[0] else -1)
    # ------------------------------------------------------------------- z chain
    GL = 12 * s
    lift_above(bot, [], 0)
    for a in arms + cross:
        d[a.id][2] = GL + d[bot.id][2]
    lift_above(mid, arms + cross, 20 * s)
    for ins in K('insert'):
        d[ins.id][2] = d[mid.id][2] + (zmax(mid) - zmin(ins)) + 3 * s

    # stack column
    boards = {b.kind: b for b in K('esc', 'fc', 'rx')}
    esc, fc = boards['esc'], boards['fc']
    rx = boards.get('rx')

    def grommet_board(g):
        c = ctr(g)[2]
        return min((esc, fc), key=lambda b: abs(c - (zmin(b) + zmax(b)) / 2))
    gro = {esc.id: [], fc.id: []}
    for g in K('grommet'):
        gro[grommet_board(g).id].append(g)
        g.meta['host'] = grommet_board(g).id
    # stack inserts: the ones under the ESC footprint
    lo_e, hi_e = bb[esc.id]
    stack_ins = [i for i in K('insert') if lo_e[0] - 3 < ctr(i)[0] < hi_e[0] + 3 and lo_e[1] - 3 < ctr(i)[1] < hi_e[1] + 3]
    for g in gro[esc.id]:
        lift_above(g, stack_ins, 4 * s, 'bbox')
    gz = max(d[g.id][2] for g in gro[esc.id])
    for g in gro[esc.id]:
        d[g.id][2] = gz
    lift_above(esc, gro[esc.id], 3 * s, 'bbox')
    for g in gro[fc.id]:
        lift_above(g, [esc], 3 * s, 'bbox')
    gz = max(d[g.id][2] for g in gro[fc.id])
    for g in gro[fc.id]:
        d[g.id][2] = gz
    lift_above(fc, gro[fc.id], 3 * s, 'bbox')
    for n in K('nut'):
        lift_above(n, [fc], 4 * s, 'bbox')

    # air unit column: mount on the middle plate (screws underneath), receiver, air unit
    mount = K('mount')[0]
    air = K('air')[0]
    lift_above(mount, [mid], 12 * s)
    if rx:
        lift_above(rx, [mid], 10 * s)
        lift_above(rx, [mount], 6 * s, 'near')
    lift_above(air, [mount] + ([rx] if rx else []), 8 * s)
    # standoffs: pass through the mount; lift them clear of it, then top plate over everything
    sos = K('standoff')
    # standoffs sit just above the middle plate; the mount must clear their tops
    for so in sos:
        d[so.id][2] = d[mid.id][2] + (zmax(mid) - zmin(so)) + 14 * s
    lift_above(mount, sos, 8 * s, 'bbox')
    if rx:
        lift_above(rx, [mount], 6 * s, 'near')
    lift_above(air, [mount] + ([rx] if rx else []), 8 * s)
    for a in K('antenna'):
        d[a.id][2] = d[air.id][2]
    for a in K('rxant'):
        d[a.id][2] = d[rx.id][2] if rx else 0
        ext = bb[a.id][1][1] - bb[a.id][0][1]
        d[a.id][1] = 0.9 * ext + 12 * s
    # top plate clears nuts, FC, air unit, mount (what is under it after the xy moves)
    under = [fc, air, mount] + K('nut') + ([rx] if rx else []) + sos + K('camera', 'cammount')
    lift_above(top, under, 14 * s)
    # side plates above the arm layer (their bottom screws live in between), beside the stack
    arm_top = max(zmax(a) + d[a.id][2] for a in arms)
    for p in sides:
        d[p.id][2] = (arm_top + 16 * s) - zmin(p)
    for u in K('pad', 'xtmount'):
        lift_above(u, [top], 14 * s)
    for u in K('xtmount'):
        d[u.id][1] = 14 * s
    for u in K('xtconn'):
        d[u.id][1] = 14 * s
        lift_above(u, [top], 14 * s)
        xm = K('xtmount')
        if xm:
            d[u.id][2] = d[xm[0].id][2] + (zmax(xm[0]) - zmin(u)) + 12 * s
    # AirTag and its mount: tag drops out of the mount downwards
    for t in K('airtag'):
        d[t.id] = d[tm.id].copy()
        d[t.id][2] -= 24 * s

    # motors, props, prop nuts follow their arm
    for mo in K('motor'):
        arm = min(arms, key=lambda x: np.linalg.norm(ctr(x)[:2] - ctr(mo)[:2]))
        mo.meta['arm'] = arm.id
        d[mo.id][:2] = d[arm.id][:2]
        d[mo.id][2] = d[arm.id][2] + (zmax(arm) - zmin(mo)) + 14 * s
    for pr in K('prop'):
        mo = min(K('motor'), key=lambda x: np.linalg.norm(ctr(x)[:2] - ctr(pr)[:2]))
        pr.meta['motor'] = mo.id
        d[pr.id][:2] = d[mo.id][:2]
        d[pr.id][2] = d[mo.id][2] + (zmax(mo) - zmin(pr)) + 12 * s
    for pn in K('propnut'):
        pr = min(K('prop'), key=lambda x: np.linalg.norm(ctr(x)[:2] - ctr(pn)[:2]))
        pn.meta['prop'] = pr.id
        d[pn.id][:2] = d[pr.id][:2]
        d[pn.id][2] = d[pr.id][2] + (zmax(pr) - zmin(pn)) + 10 * s

    # ----------------------------------------------------------------- hardware
    others = {u.id: pts[u.id] for u in units if u.kind != 'screw'}
    screws = [u for u in K('screw')]
    # drop the M3x6 twin of the bumper's M3x8 (both are modelled, show only M3x8)
    info = {}
    for u in screws:
        o, a, lo, hi, r = screw_axis(pts[u.id])
        info[u.id] = dict(o=o, a=a, lo=lo, hi=hi, r=r)
    drop = set()
    for u in screws:
        for v in screws:
            if u.id >= v.id or u.id in drop or v.id in drop:
                continue
            iu, iv = info[u.id], info[v.id]
            if np.allclose(iu['a'], iv['a']) and np.linalg.norm((iu['o'] - iv['o']) - ((iu['o'] - iv['o']) @ iu['a']) * iu['a']) < 0.6 \
                    and abs(iu['lo'] - iv['lo'] + (iu['o'] - iv['o']) @ iu['a']) < 5:
                shorter = u if (iu['hi'] - iu['lo']) < (iv['hi'] - iv['lo']) else v
                drop.add(shorter.id)
                log.append(f'duplicate screw hole: dropped {shorter.label} {shorter.id} (twin kept)')
    for u in screws:
        if u.id in drop:
            continue
        i = info[u.id]
        o, a, lo, hi, r = i['o'], i['a'], i['lo'], i['hi'], i['r']
        # parts the shank passes through (surface within the hole clearance of the axis)
        hits = {}
        for uid, P in others.items():
            dd = P - o
            t = dd @ a
            m = (t > lo - 0.4) & (t < hi)
            if not m.any():
                continue
            rr = np.linalg.norm(dd[m] - np.outer(t[m], a), axis=1)
            if (rr < r + 1.6).sum() >= 4:
                # extent along the axis of that part near the axis (full local thickness)
                m2 = (np.linalg.norm(dd - np.outer(t, a), axis=1) < r + 3.5) & (t > lo - 14) & (t < hi + 14)
                hits[uid] = (float(t[m2].min()), float(t[m2].max()))
        i['hits'] = hits
        if not hits:
            log.append(f'screw {u.id} {u.label}: no hits')
            continue
        tpu_first = [h for h in hits if by[h].kind == 'bumper']
        # anchor: the part the screw threads into (tip-most), bumper screws follow the bumper
        if tpu_first:
            anchor = tpu_first[0]
        else:
            # the part the screw threads into: the tip-most part it passes through
            anchor = min(hits, key=lambda h: hits[h][0])
        perp = lambda v: v - (v @ a) * a
        pa = perp(d[anchor])
        # washers on this screw: seat is the part just tip-side of the washer
        for h, (hlo, hhi) in hits.items():
            if by[h].kind == 'washer':
                seat = [x for x in hits if x != h and by[x].kind != 'washer' and hits[x][1] <= hlo + 0.6 and np.linalg.norm(perp(d[x]) - pa) < 1.0]
                if seat:
                    sx = max(seat, key=lambda x: hits[x][1])
                    d[h] = pa + (d[sx] @ a + 3 * s) * a
                else:
                    d[h] = pa.copy()
        face = -1e9
        for h, (hlo, hhi) in hits.items():
            if np.linalg.norm(perp(d[h]) - pa) < 1.0:
                face = max(face, hhi + d[h] @ a)
        D = face + 3.5 * s - 0.0  # tip' relative to the original tip (u measured from origin o: tip at lo)
        D = face + 3.5 * s - lo
        d[u.id] = pa + D * a
        u.meta['anchor'] = anchor
        u.meta['axis'] = a.tolist()
        u.meta['o'] = o.tolist()
    for uid in drop:
        by[uid].meta['hidden'] = True
    moves = build_moves(units, by, d, kinds, drop, arm_dir, bb, s)
    return d, info, drop, log, hub, pts, moves


# --------------------------------------------------------------------------- timing
# Disassembly order, top of the stack first (p runs 0..1). A part may only start once
# everything above it that it would hit has left; screws leave with the part they
# thread into, so each screw withdraws exactly while its anchor moves.
T = dict(pad=0.00, xtconn=0.00, xtmount=0.04, top=0.06, propnut=0.02, prop=0.06, antenna=0.08,
         nut=0.09, air=0.10, rxant=0.12, rx=0.14, fc=0.15, mount=0.18, motor=0.20, esc=0.24,
         standoff=0.26, bumper=0.22, camera=0.30, cammount=0.30, airtag=0.30, middle=0.32,
         insert=0.32, side=0.56, tagmount=0.40, arm=0.50, cross=0.50, boot=0.50, bottom=0.0)
GROM_FC, GROM_ESC = 0.19, 0.28
DUR = 0.40


def build_moves(units, by, d, kinds, drop, arm_dir, bb, s):
    """Per unit: list of (vector mm, t0, dur). The sum is d[u]; splitting the vector in
    several moves lets a part go up first and sideways later, or follow a carrier."""
    mv = {}
    z = lambda v: np.array([0, 0, v[2]])
    xy = lambda v: np.array([v[0], v[1], 0])
    boards = {u.kind: u for u in units if u.kind in ('fc', 'esc')}

    def t_of(u):
        if u.kind == 'grommet':
            near_fc = abs((bb[u.id][0][2] + bb[u.id][1][2]) / 2 - (bb[boards['fc'].id][0][2] + bb[boards['fc'].id][1][2]) / 2) < \
                abs((bb[u.id][0][2] + bb[u.id][1][2]) / 2 - (bb[boards['esc'].id][0][2] + bb[boards['esc'].id][1][2]) / 2)
            return GROM_FC if near_fc else GROM_ESC
        return T.get(u.kind, 0.3)
    for u in units:
        if u.id in drop or u.kind == 'screw':
            continue
        v = d[u.id]
        t = t_of(u)
        if u.kind == 'arm':
            mv[u.id] = [(v, t, DUR)]
        elif u.kind == 'boot':
            arm = by[u.meta['arm']]
            carry = d[arm.id]
            mv[u.id] = [(np.array([carry[0], carry[1], carry[2]]), T['arm'], DUR), (v - carry, T['arm'] + 0.14, 0.36)]
        elif u.kind in ('motor', 'prop', 'propnut'):
            arm = by[u.meta.get('arm') or by[u.meta.get('motor') or by[u.meta['prop']].meta['motor']].meta['arm']]
            mv[u.id] = [(xy(v), T['arm'], DUR), (z(v), t, DUR)]
        elif u.kind == 'side':
            mv[u.id] = [(z(v), t, DUR - 0.05), (xy(v), t + 0.14, DUR - 0.1)]
        elif u.kind == 'cammount':
            mv[u.id] = [(np.array([0, v[1], v[2]]), t, DUR), (np.array([v[0], 0, 0]), t + 0.30, DUR - 0.1)]
        elif u.kind == 'antenna':
            mv[u.id] = [(z(v), t, DUR), (xy(v), t + 0.08, DUR - 0.05)]
        elif u.kind == 'rxant':
            # slides back out of its groove first, then rides up with the receiver
            mv[u.id] = [(xy(v), 0.04, 0.35), (z(v), 0.17, DUR)]
        elif u.kind == 'tagmount':
            mv[u.id] = [(v, t, DUR)]
        elif u.kind == 'airtag':
            mv[u.id] = [(xy(v), T['tagmount'], DUR), (z(v), t, DUR)]
        else:
            mv[u.id] = [(v, t, DUR)]
    # hardware: lateral parts follow the anchor, axial part when the anchor moves along the axis
    for u in units:
        if u.id in drop or u.kind != 'screw' or 'anchor' not in u.meta:
            continue
        a = np.array(u.meta['axis'])
        anc = by[u.meta['anchor']]
        ms = mv[anc.id]
        out = []
        for vec, t0, du in ms:
            perp = vec - (vec @ a) * a
            if np.linalg.norm(perp) > 1e-6:
                out.append((perp, t0, du))
        total_perp = sum((o[0] for o in out), np.zeros(3))
        axial = d[u.id] - total_perp
        k = max(range(len(ms)), key=lambda i: abs(ms[i][0] @ a)) if any(abs(m[0] @ a) > 1e-6 for m in ms) else 0
        out.append((axial, ms[k][1], ms[k][2]))
        mv[u.id] = out
    # washers: same lateral as the screw they sit on, axial gap from the seat plate
    for u in units:
        if u.kind != 'washer':
            continue
        c = (bb[u.id][0] + bb[u.id][1]) / 2
        best, bd = None, 1e9
        for sc in kinds.get('screw', []):
            if sc.id in drop or 'o' not in sc.meta:
                continue
            o, a = np.array(sc.meta['o']), np.array(sc.meta['axis'])
            dd = c - o
            dist = np.linalg.norm(dd - (dd @ a) * a)
            if dist < bd:
                best, bd = sc, dist
        ms = mv[best.id]
        lat = ms[:-1]
        total = sum((m[0] for m in lat), np.zeros(3))
        mv[u.id] = list(lat) + [(d[u.id] - total, ms[-1][1], ms[-1][2])]
    return mv
