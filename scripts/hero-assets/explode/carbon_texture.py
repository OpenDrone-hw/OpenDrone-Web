#!/usr/bin/env python3
"""Tileable carbon 2x2 twill maps for the hero (albedo, roughness, normal).

Same weave as scripts/in-the-box (stage.js `twill()`): 8x8 tows of 1.8 mm = one 14.4 mm
tile, a 2x2 twill stepping one tow per row, tow crown as a sine across the tow, a hairline
gap between tows. Tuned matte and subtle for the hero (the box art is a studio render):
a few percent of albedo between tows, roughness about 0.65, a soft normal map, so the weave
only shows on a close look or at grazing light. 256 px per tile, PNG, a few KB.
usage: carbon_texture.py [outdir]"""
import sys, os
import numpy as np
from PIL import Image

N, PX = 8, 32
SIZE = N * PX
TILE_MM = N * 1.8


def maps():
    crown = np.zeros((SIZE, SIZE)); warp = np.zeros((SIZE, SIZE)); gap = np.zeros((SIZE, SIZE))
    k = np.arange(PX)
    prof = np.sin(np.pi * (k + 0.5) / PX)
    gp = ((k < 1) | (k >= PX - 1)).astype(float)
    for i in range(N):
        for j in range(N):
            w = ((j - i) % 4) < 2
            if w:   # warp tow i runs along y (rows), crown across x
                sl = (slice(j * PX, (j + 1) * PX), slice(i * PX, (i + 1) * PX))
                crown[sl] = prof[None, :]; gap[sl] = gp[None, :]; warp[sl] = 1
            else:   # weft row j runs along x, crown across y
                sl = (slice(j * PX, (j + 1) * PX), slice(i * PX, (i + 1) * PX))
                crown[sl] = prof[:, None]; gap[sl] = gp[:, None]
    return crown, warp, gap


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)]) / 255.0


def main(out):
    os.makedirs(out, exist_ok=True)
    crown, warp, gap = maps()
    a, b = hexrgb('#131416'), hexrgb('#18191c')   # a few percent between tows: matte, weave only on a close look
    t = np.clip(crown * 0.6, 0, 1)[..., None]
    tone = a * (1 - t) + b * t
    g = np.clip(gap * 0.8, 0, 1)[..., None]
    tone = tone * (1 - g) + hexrgb('#101113') * g
    # a little fibre striation along each tow so it is not a flat colour
    rng = np.random.default_rng(3)
    stri = rng.normal(0, 0.004, (SIZE, SIZE))
    stri = np.where(warp > 0, stri[:1, :].repeat(SIZE, 0), stri[:, :1].repeat(SIZE, 1))
    tone = np.clip(tone + stri[..., None] * (0.4 + crown[..., None]), 0, 1)
    Image.fromarray((tone * 255).astype(np.uint8)).save(os.path.join(out, 'twill-albedo.png'), optimize=True)
    rough = np.clip(0.66 - 0.04 * warp, 0, 1)
    mr = np.zeros((SIZE, SIZE, 3)); mr[..., 0] = 1.0; mr[..., 1] = rough
    Image.fromarray((mr * 255).astype(np.uint8)).save(os.path.join(out, 'twill-mr.png'), optimize=True)
    h = crown - gap
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    s = 4.0
    nrm = np.stack([-dx * s, dy * s, np.ones_like(h)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    Image.fromarray(((nrm * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(out, 'twill-normal.png'), optimize=True)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', '..', 'public', 'models', 'carbon'))
