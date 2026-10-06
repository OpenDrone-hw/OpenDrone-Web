#!/usr/bin/env python3
"""Render the /visit background map from OpenStreetMap data.

    python3 scripts/gen-visit-map.py              # fetch from Overpass, render
    python3 scripts/gen-visit-map.py --osm FILE   # render from a saved Overpass JSON

Writes public/makerspace/map-dark.svg, public/makerspace/map-light.svg and
app/lib/visit-map.generated.ts (map size and the lab's position in it, in
metres). The page positions the map so that position sits under the open
hours card. Map data (c) OpenStreetMap contributors, ODbL; the page carries
the attribution. Standard library only.
"""

import argparse
import json
import math
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'public' / 'makerspace'
OUT_TS = ROOT / 'app' / 'lib' / 'visit-map.generated.ts'

# The High Tech Lab inside the maakleerplek site, as marked on the map by the
# founder (2026-10-04). Nominatim's address point for Stapelhuisstraat 15 sits
# on a different, smaller building 44 m east of it.
LAB = (50.886576, 4.704624)
# The maakleerplek site, as marked by the founder: the old mill (Maalderij Van
# Orshoven, Stapelhuisstraat 13) and the two buildings south of it.
SITE_WAYS = {315785032, 562686794, 510790352}
# Map extent around the lab: about 3.9 km x 2.7 km.
SOUTH, WEST, NORTH, EAST = 50.8746, 4.6772, 50.8986, 4.7333
# Buildings further than this from the lab are left out to keep the file small.
BUILDING_RADIUS_M = 1400

QUERY = f"""[out:json][timeout:90];
(
  way["highway"]({SOUTH},{WEST},{NORTH},{EAST});
  way["railway"="rail"]({SOUTH},{WEST},{NORTH},{EAST});
  way["waterway"]({SOUTH},{WEST},{NORTH},{EAST});
  way["natural"="water"]({SOUTH},{WEST},{NORTH},{EAST});
  relation["natural"="water"]({SOUTH},{WEST},{NORTH},{EAST});
  way["leisure"="park"]({SOUTH},{WEST},{NORTH},{EAST});
  way["landuse"~"grass|forest|meadow|recreation_ground"]({SOUTH},{WEST},{NORTH},{EAST});
  way["building"]({SOUTH},{WEST},{NORTH},{EAST});
);
out geom;"""

PALETTES = {
    'dark': {
        'green': '#121813',
        'water': '#0f1c24',
        'waterline': '#16303d',
        'building': '#18181c',
        'minor': '#1d1d22',
        'road': '#26262c',
        'major': '#32323a',
        'rail': '#3a3a42',
        'lab': '#f5b100',
    },
    'light': {
        'green': '#e3eadf',
        'water': '#d6e4ec',
        'waterline': '#bcd3df',
        'building': '#e6e3dc',
        'minor': '#e9e6df',
        'road': '#dcd8cf',
        'major': '#cdc8bd',
        'rail': '#b9b4a9',
        'lab': '#c98f00',
    },
}

ROAD_WIDTH = {
    'motorway': ('major', 16), 'trunk': ('major', 14), 'primary': ('major', 12),
    'secondary': ('major', 10), 'tertiary': ('road', 8),
    'motorway_link': ('major', 8), 'trunk_link': ('major', 8), 'primary_link': ('major', 8),
    'secondary_link': ('road', 7), 'tertiary_link': ('road', 6),
    'residential': ('road', 6), 'unclassified': ('road', 6), 'living_street': ('road', 5),
    'pedestrian': ('road', 5), 'service': ('minor', 3), 'cycleway': ('minor', 2),
    'footway': ('minor', 1.5), 'path': ('minor', 1.5), 'steps': ('minor', 1.5),
    'track': ('minor', 2),
}

KX = 111320 * math.cos(math.radians(LAB[0]))
KY = 110574
WIDTH = round((EAST - WEST) * KX)
HEIGHT = round((NORTH - SOUTH) * KY)


def xy(lat, lon):
    return (lon - WEST) * KX, (NORTH - lat) * KY


def path_d(points, closed=False):
    """Absolute first point, then relative integer steps; drops zero steps."""
    out, px, py = [], None, None
    for lat, lon in points:
        x, y = (round(v) for v in xy(lat, lon))
        if px is None:
            out.append(f'M{x} {y}')
        elif (x, y) != (px, py):
            out.append(f'l{x - px} {y - py}')
        else:
            continue
        px, py = x, y
    if len(out) < 2:
        return ''
    return ''.join(out) + ('z' if closed else '')


def geom(el):
    return [(p['lat'], p['lon']) for p in el.get('geometry', []) if p]


def inside(poly, pt):
    """Ray casting point-in-polygon on (lat, lon) pairs."""
    y, x = pt
    hit = False
    for (y1, x1), (y2, x2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def dist_m(a, b):
    ax, ay = xy(*a)
    bx, by = xy(*b)
    return math.hypot(ax - bx, ay - by)


def fetch():
    body = urllib.parse.urlencode({'data': QUERY}).encode()
    req = urllib.request.Request(
        'https://overpass-api.de/api/interpreter',
        data=body,
        headers={'User-Agent': 'opendrone.be visit map generator'},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def render(elements, palette):
    c = PALETTES[palette]
    green, water_fill, water_lines, buildings, rail = [], [], [], [], []
    roads = {}
    site = []

    for el in elements:
        tags = el.get('tags', {})
        if el['type'] == 'relation':
            if tags.get('natural') == 'water':
                for m in el.get('members', []):
                    if m.get('role') == 'outer' and m.get('geometry'):
                        pts = [(p['lat'], p['lon']) for p in m['geometry'] if p]
                        water_fill.append(path_d(pts, True))
            continue
        pts = geom(el)
        if len(pts) < 2:
            continue
        if 'building' in tags:
            if el['id'] in SITE_WAYS:
                site.append(path_d(pts, True))
            elif dist_m(pts[0], LAB) <= BUILDING_RADIUS_M:
                buildings.append(path_d(pts, True))
        elif tags.get('natural') == 'water':
            water_fill.append(path_d(pts, True))
        elif 'waterway' in tags:
            water_lines.append((path_d(pts), 10 if tags['waterway'] in ('canal', 'river') else 3))
        elif tags.get('leisure') == 'park' or 'landuse' in tags:
            green.append(path_d(pts, True))
        elif tags.get('railway') == 'rail':
            # Main and branch lines only: station yards are a dozen parallel tracks.
            if tags.get('usage') in ('main', 'branch') and 'service' not in tags:
                rail.append(path_d(pts))
        elif 'highway' in tags and tags['highway'] in ROAD_WIDTH and tags.get('area') != 'yes':
            cls, w = ROAD_WIDTH[tags['highway']]
            roads.setdefault((cls, w), []).append(path_d(pts))

    if len(site) != len(SITE_WAYS):
        sys.exit(f'expected {len(SITE_WAYS)} site buildings, found {len(site)}')

    def joined(ds):
        return ''.join(d for d in ds if d)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" '
        f'width="{WIDTH}" height="{HEIGHT}">',
        '<title>Map of the Vaartkom, Leuven. Data (c) OpenStreetMap contributors, ODbL.</title>',
        f'<path fill="{c["green"]}" d="{joined(green)}"/>',
        f'<path fill="{c["water"]}" d="{joined(water_fill)}"/>',
    ]
    for d, w in water_lines:
        if d:
            parts.append(f'<path fill="none" stroke="{c["waterline"]}" stroke-width="{w}" '
                         f'stroke-linecap="round" stroke-linejoin="round" d="{d}"/>')
    parts.append(f'<path fill="{c["building"]}" d="{joined(buildings)}"/>')
    order = ['minor', 'road', 'major']
    for (cls, w) in sorted(roads, key=lambda k: (order.index(k[0]), k[1])):
        parts.append(
            f'<path fill="none" stroke="{c[cls]}" stroke-width="{w}" stroke-linecap="round" '
            f'stroke-linejoin="round" d="{joined(roads[(cls, w)])}"/>'
        )
    parts.append(f'<path fill="none" stroke="{c["rail"]}" stroke-width="3" '
                 f'stroke-dasharray="12 8" d="{joined(rail)}"/>')
    parts.append(f'<path fill="{c["lab"]}" fill-opacity="0.22" stroke="{c["lab"]}" '
                 f'stroke-opacity="0.8" stroke-width="2.5" stroke-linejoin="round" '
                 f'd="{joined(site)}"/>')
    parts.append('</svg>\n')
    return ''.join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--osm', type=pathlib.Path, help='saved Overpass JSON instead of fetching')
    args = ap.parse_args()
    data = json.loads(args.osm.read_text()) if args.osm else fetch()
    elements = data['elements']

    for palette in PALETTES:
        out = OUT_DIR / f'map-{palette}.svg'
        out.write_text(render(elements, palette))
        print(f'{out.relative_to(ROOT)}: {out.stat().st_size / 1024:.0f} KB')

    lx, ly = xy(*LAB)
    OUT_TS.write_text(
        '// Generated by scripts/gen-visit-map.py. Do not edit by hand.\n'
        '/** Size of public/makerspace/map-*.svg and the lab inside it, in map units (metres). */\n'
        'export const VISIT_MAP = {\n'
        f'  width: {WIDTH},\n'
        f'  height: {HEIGHT},\n'
        f'  labX: {round(lx)},\n'
        f'  labY: {round(ly)},\n'
        '} as const;\n'
    )
    print(f'{OUT_TS.relative_to(ROOT)}: {WIDTH} x {HEIGHT} m, lab at {round(lx)}, {round(ly)}')


if __name__ == '__main__':
    main()
