#!/usr/bin/env python3
"""Shrink UI screenshots: 256-colour palette (fast octree, no dither).

Flat UI renders survive this almost losslessly and drop ~90% in size.
Usage: shrink-png.py FILE.png [...]   (rewrites in place, only if smaller)
"""
import os
import sys

from PIL import Image

for path in sys.argv[1:]:
    before = os.path.getsize(path)
    img = Image.open(path).convert("RGB")
    q = img.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    tmp = path + ".tmp.png"
    q.save(tmp, optimize=True)
    after = os.path.getsize(tmp)
    if after < before:
        os.replace(tmp, path)
    else:
        os.remove(tmp)
        after = before
    print(f"{os.path.basename(path)}: {before // 1024} KB -> {after // 1024} KB")
