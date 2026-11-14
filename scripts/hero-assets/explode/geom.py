"""Geometry helpers: surface samples, screw axes and the parts each screw passes through."""
import numpy as np

_rng = np.random.default_rng(7)


def sample_surface(verts, tris, spacing=0.8, cap=4000):
    """Points on the triangles, about `spacing` mm apart (plus the vertices)."""
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    k = np.minimum(np.ceil(area / (spacing * spacing)).astype(int), 400)
    k = np.where(area < 1e-9, 0, k)
    total = int(k.sum())
    pts = [verts]
    if total:
        scale = min(1.0, cap * 20 / max(total, 1))
        kk = np.maximum((k * scale).astype(int), (k > 0).astype(int))
        idx = np.repeat(np.arange(len(tris)), kk)
        r1 = np.sqrt(_rng.random(len(idx)))
        r2 = _rng.random(len(idx))
        pts.append(a[idx] * (1 - r1)[:, None] + b[idx] * (r1 * (1 - r2))[:, None] + c[idx] * (r1 * r2)[:, None])
    return np.concatenate(pts)


def unit_points(unit, bases, spacing=0.8):
    return np.concatenate([sample_surface(v, t, spacing) for _, _, v, t in unit.world_prims(bases)])


def screw_axis(pts):
    """Axis, head end and tip end of a screw from its points (units: mm).
    Returns (origin, a, t_tip, t_head, r_shank) with a pointing from tip to head."""
    c = pts.mean(0)
    u, s, vt = np.linalg.svd(pts - c, full_matrices=False)
    a = vt[0]
    # snap to the nearest world axis when within 1 degree (CAD screws are axis aligned)
    k = np.argmax(np.abs(a))
    if abs(a[k]) > 0.9998:
        a = np.zeros(3); a[k] = 1.0 * np.sign(vt[0][k])
    t = (pts - c) @ a
    perp = pts - c - np.outer(t, a)
    rad = np.linalg.norm(perp, axis=1)
    lo, hi = t.min(), t.max()
    r_lo = rad[t < lo + 0.8].max() if np.any(t < lo + 0.8) else 0
    r_hi = rad[t > hi - 0.8].max() if np.any(t > hi - 0.8) else 0
    if r_lo > r_hi:    # head at the low end: flip so +a points at the head
        a = -a
        t = -t
        lo, hi = t.min(), t.max()
        r_lo, r_hi = r_hi, r_lo
    r_shank = float(np.median(rad[(t > lo + 0.5) & (t < lo + (hi - lo) * 0.5)]))
    r_shank = float(np.percentile(rad[(t > lo + 0.5) & (t < hi - (hi - lo) * 0.4)], 90))
    # axis passes through c + (perp mean) -- recentre on the shank
    sh = (t < hi - (hi - lo) * 0.4)
    o = c + (pts[sh] - c - np.outer(t[sh], a)).mean(0)
    return o, a, float(lo), float(hi), r_shank


def hits_on_screw(o, a, t_tip, t_head, r, others, margin=0.35):
    """Which units have surface inside the shank tube. others: {uid: pts}.
    Returns {uid: (u_lo, u_hi)} with u measured from the origin along a."""
    out = {}
    for uid, P in others.items():
        d = P - o
        t = d @ a
        mask = (t > t_tip - 0.4) & (t < t_head)
        if not mask.any():
            continue
        perp = d[mask] - np.outer(t[mask], a)
        rr = np.linalg.norm(perp, axis=1)
        sel = rr < r + margin
        if sel.sum() < 4:
            continue
        tt = t[mask][sel]
        out[uid] = (float(tt.min()), float(tt.max()))
    return out
