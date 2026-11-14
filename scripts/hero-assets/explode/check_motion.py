#!/usr/bin/env python3
"""Replays the explode timeline and reports parts that pass through each other.
Overlaps already present in the assembled pose (parts touching, screws in holes) are
the baseline; a pair is flagged when its overlap grows well beyond it at some p.
usage: check_motion.py <assembly.pkl> <units.json> [steps]"""
import sys, json, os
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import units as U
from geom import unit_points

pkl, uj = sys.argv[1], sys.argv[2]
steps = int(sys.argv[3]) if len(sys.argv) > 3 else 40
d, units, _ = U.build_units(pkl, {})
plan = {u['id']: u for u in json.load(open(uj))}
units = [u for u in units if u.id in plan]
V = 1.5
pts = {u.id: unit_points(u, d['bases'], 1.0) for u in units}
by = {u.id: u.label for u in units}
ease = lambda x: 4 * x ** 3 if x < .5 else 1 - (-2 * x + 2) ** 3 / 2


def pos(u, p):
    off = np.zeros(3)
    for m in plan[u]['moves']:
        x = min(1, max(0, (p - m['t']) / m['dur']))
        off += np.array(m['v']) * 1000 * ease(x)
    return off


def keys_at(p):
    out = {}
    for u in units:
        q = np.floor((pts[u.id] + pos(u.id, p)) / V).astype(np.int64)
        out[u.id] = (np.unique(q[:, 0] * 4000000 + q[:, 1] * 2000 + q[:, 2] + 1000), (pts[u.id] + pos(u.id, p)).min(0), (pts[u.id] + pos(u.id, p)).max(0))
    return out


def overlaps(K):
    ids = list(K)
    res = {}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = K[ids[i]], K[ids[j]]
            if np.any(a[1] > b[2] + V) or np.any(b[1] > a[2] + V):
                continue
            n = len(np.intersect1d(a[0], b[0], assume_unique=True))
            if n:
                res[(ids[i], ids[j])] = n
    return res

base = overlaps(keys_at(0.0))
worst = {}
for s in range(1, steps + 1):
    p = s / steps
    for k, n in overlaps(keys_at(p)).items():
        b0 = base.get(k, 0)
        if n > max(b0 * 2, b0 + 30):
            if k not in worst or n > worst[k][0]:
                worst[k] = (n, p, b0)
for (a, b), (n, p, b0) in sorted(worst.items(), key=lambda kv: -kv[1][0]):
    print(f'{n:4d} vox (base {b0:3d}) at p={p:.2f}  {by[a]} [{a}] x {by[b]} [{b}]')
print(len(worst), 'pairs flagged')
