"""Build the static assets the app ships with.

  web/data/japan.json      simplified prefecture polygons (lon/lat)
  data/prefmap.bin         352x400 raster of prefecture ids (0 = sea)
  data/legend.json         colour gradient sampled from the public NIED legend
"""
from __future__ import annotations

import io
import json
import os

import numpy as np
import requests
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
W, H = 352, 400
BASE = "http://www.kmoni.bosai.go.jp"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": BASE + "/"}


def legend():
    path = os.path.join(HERE, "scale_jma_s_w.gif")
    if not os.path.exists(path):
        r = requests.get(f"{BASE}/data/map_img/ScaleImg/nied_jma_s_w_scale.gif", headers=HEADERS, timeout=20)
        r.raise_for_status()
        open(path, "wb").write(r.content)
    im = Image.open(path).convert("RGB")
    px = im.load()
    stops = []
    for y in range(20, 291):
        rgb = px[8, y]
        stops.append({"y": y, "v": round(7.0 * (290 - y) / 270.0, 4), "c": "#%02X%02X%02X" % rgb})
    with open(os.path.join(ROOT, "app", "assets", "legend.json"), "w", encoding="utf-8") as fh:
        json.dump({"top": 20, "bottom": 290, "vmax": 7.0, "stops": stops}, fh, separators=(",", ":"))
    return stops


def polygons():
    prefs = json.load(open(os.path.join(HERE, "prefs_simplified.json"), encoding="utf-8"))
    grid = json.load(open(os.path.join(HERE, "grid.json"), encoding="utf-8"))
    out = {"version": 1, "grid": grid, "prefs": []}
    for idx, p in enumerate(prefs, start=1):
        rings = []
        for ring in p["rings"]:
            flat = []
            for x, y in ring:
                flat.append(round(x, 4))
                flat.append(round(y, 4))
            if len(flat) >= 8:
                rings.append(flat)
        if not rings:
            continue
        # label anchor: centroid of the largest ring (by point count proxy) is noisy;
        # use the polygon with the largest area instead
        best = None
        for ring in p["rings"]:
            area = 0.0
            for i in range(len(ring) - 1):
                area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
            area = abs(area) / 2
            if best is None or area > best[0]:
                best = (area, ring)
        ring = best[1]
        cx = sum(pt[0] for pt in ring) / len(ring)
        cy = sum(pt[1] for pt in ring) / len(ring)
        out["prefs"].append(
            {
                "id": idx,
                "ja": p["name_ja"],
                "en": p["name"],
                "bbox": [round(v, 3) for v in p["bbox"]],
                "c": [round(cx, 4), round(cy, 4)],
                "rings": rings,
            }
        )
    path = os.path.join(ROOT, "web", "data", "japan.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    print("pref polygons:", path, os.path.getsize(path))

    # rasterize prefecture ids with the calibrated transform
    lon_c, lat_c, kx, ky = grid["lon_c"], grid["lat_c"], grid["kx"], grid["ky"]
    im = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(im)
    for p in out["prefs"]:
        for ring in p["rings"]:
            pts = [((x - lon_c) * kx + W / 2, (lat_c - y) * ky + H / 2) for x, y in zip(ring[0::2], ring[1::2])]
            d.polygon(pts, fill=p["id"])
    arr = np.array(im)
    open(os.path.join(ROOT, "app", "assets", "prefmap.bin"), "wb").write(arr.astype(np.uint8).tobytes())
    print("prefmap:", int((arr > 0).sum()), "land pixels")


if __name__ == "__main__":
    legend()
    polygons()
