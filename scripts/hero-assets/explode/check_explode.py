#!/usr/bin/env python3
"""Interference check of the exploded pose: surface voxels shared by two units.
usage: check_explode.py <assembly.pkl> <units.json> [min_voxels]"""
import sys, json, os
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import units as U
from geom import unit_points

pkl, uj = sys.argv[1], sys.argv[2]
thr = int(sys.argv[3]) if len(sys.argv) > 3 else 8
d, units, _ = U.build_units(pkl, {})
plan = {u['id']: np.array(u['d']) * 1000 for u in json.load(open(uj))}
units = [u for u in units if u.id in plan]
V = 1.0
keys = {}
for u in units:
    p = unit_points(u, d['bases'], 0.6) + plan[u.id]
    ij = np.floor(p / V).astype(np.int64)
    keys[u.id] = np.unique(ij[:, 0] * 4000000 + ij[:, 1] * 2000 + ij[:, 2] + 1000)
ids = list(keys)
bbs = {i: (np.min(keys[i]), np.max(keys[i])) for i in ids}
bad = []
for a in range(len(ids)):
    for b in range(a + 1, len(ids)):
        n = len(np.intersect1d(keys[ids[a]], keys[ids[b]], assume_unique=True))
        if n >= thr:
            bad.append((n, ids[a], ids[b]))
by = {u.id: u.label for u in units}
for n, a, b in sorted(bad, reverse=True):
    print(f'{n:5d} voxels  {by[a]} [{a}]  x  {by[b]} [{b}]')
print(len(bad), 'overlapping pairs')
