"""Geometry helpers used by the offline asset builder.

Pure stdlib + numpy-free implementations so the build tools can run anywhere
Python 3.9+ is available.  Nothing here is imported by the running app.
"""
from __future__ import annotations

import json
import math


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify_ring(points, tol):
    """Douglas-Peucker on an open ring (first==last tolerated)."""
    n = len(points)
    if n < 4:
        return points
    closed = points[0] == points[-1]
    pts = points[:-1] if closed else list(points)
    n = len(pts)
    if n < 4:
        return points
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i]
        bx, by = pts[j]
        best, best_i = -1.0, -1
        for k in range(i + 1, j):
            d = _seg_dist(pts[k][0], pts[k][1], ax, ay, bx, by)
            if d > best:
                best, best_i = d, k
        if best > tol and best_i > 0:
            keep[best_i] = True
            stack.append((i, best_i))
            stack.append((best_i, j))
    out = [pts[i] for i in range(n) if keep[i]]
    if closed:
        out.append(out[0])
    return out


def load_prefectures(path):
    """Return [{id, name, name_ja, rings:[[(lon,lat),...]], bbox}]."""
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    out = []
    for feat in doc.get("features", []):
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}
        rings = []
        if geom.get("type") == "Polygon":
            polys = [geom["coordinates"]]
        elif geom.get("type") == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        for poly in polys:
            # ring 0 = exterior, the rest = holes
            for idx, ring in enumerate(poly):
                if idx == 0 and len(ring) >= 4:
                    rings.append([(float(x), float(y)) for x, y in ring])
        if not rings:
            continue
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        out.append(
            {
                "id": props.get("id"),
                "name": props.get("nam"),
                "name_ja": props.get("nam_ja"),
                "rings": rings,
                "bbox": [min(xs), min(ys), max(xs), max(ys)],
            }
        )
    return out


def total_points(prefs):
    return sum(len(r) for p in prefs for r in p["rings"])
