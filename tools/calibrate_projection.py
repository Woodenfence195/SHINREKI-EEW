"""Calibrate the 352x400 NIED real-time intensity raster against real geography.

We render the Japanese prefecture polygons with a candidate equirectangular
transform, compare it with the land mask of the public NIED base map, and keep
the transform with the best IoU.  The transform is stored as grid.json and is
used by the app to place stations, hypocentres and wavefronts.
"""
from __future__ import annotations

import io
import json
import os
import sys

import numpy as np
import requests
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo import load_prefectures, simplify_ring, total_points  # noqa: E402

BASE = "http://www.kmoni.bosai.go.jp"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": BASE + "/"}
W, H = 352, 400
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    with open(path, "wb") as fh:
        fh.write(r.content)
    return path


def target_mask():
    gif = fetch(f"{BASE}/data/map_img/CommonImg/base_map_w.gif", os.path.join(HERE, "base_map_w.gif"))
    im = Image.open(gif).convert("RGB")
    a = np.asarray(im)
    mask = a.max(axis=2) <= 246
    mask[331:, 121:] = False       # NIED logo block
    return mask


def render(prefs, lon_c, lat_c, kx, ky):
    im = Image.new("1", (W, H), 0)
    d = ImageDraw.Draw(im)
    for pref in prefs:
        for ring in pref["rings"]:
            pts = [((x - lon_c) * kx + W / 2, (lat_c - y) * ky + H / 2) for x, y in ring]
            d.polygon(pts, outline=1, fill=1)
    return np.asarray(im, dtype=bool)


def iou(a, b):
    union = int(np.count_nonzero(a | b))
    if not union:
        return 0.0
    return int(np.count_nonzero(a & b)) / union


def main():
    geojson = fetch(
        "https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson",
        os.path.join(HERE, "japan_raw.geojson"),
    )
    prefs = load_prefectures(geojson)
    for p in prefs:
        p["rings"] = [simplify_ring(r, 0.008) for r in p["rings"]]
    print("prefectures:", len(prefs), "points:", total_points(prefs))

    target = target_mask()

    best = None
    stages = [
        (13.5, 17.0, 0.5, 15.5, 19.0, 0.5, 134.0, 140.0, 0.5, 34.0, 38.0, 0.5),
    ]
    for (kx0, kx1, kxs, ky0, ky1, kys, cx0, cx1, cxs, cy0, cy1, cys) in stages:
        kx = kx0
        while kx <= kx1 + 1e-9:
            ky = ky0
            while ky <= ky1 + 1e-9:
                lon_c = cx0
                while lon_c <= cx1 + 1e-9:
                    lat_c = cy0
                    while lat_c <= cy1 + 1e-9:
                        score = iou(target, render(prefs, lon_c, lat_c, kx, ky))
                        if best is None or score > best[0]:
                            best = (score, lon_c, lat_c, kx, ky)
                            print(f"  {score:.4f}  lon_c={lon_c:.2f} lat_c={lat_c:.2f} kx={kx:.2f} ky={ky:.2f}")
                        lat_c += cys
                    lon_c += cxs
                ky += kys
            kx += kxs
        # refine around best
        _, c_lon, c_lat, c_kx, c_ky = best
        for kxs, kys, cxs, cys in [(0.1, 0.1, 0.1, 0.1), (0.02, 0.02, 0.02, 0.02)]:
            improved = True
            while improved:
                improved = False
                for dkx in (-kxs, 0, kxs):
                    for dky in (-kys, 0, kys):
                        for dcx in (-cxs, 0, cxs):
                            for dcy in (-cys, 0, cys):
                                if not (dkx or dky or dcx or dcy):
                                    continue
                                cand = (c_lon + dcx, c_lat + dcy, c_kx + dkx, c_ky + dky)
                                score = iou(target, render(prefs, *cand))
                                if score > best[0] + 1e-6:
                                    best = (score, *cand)
                                    c_lon, c_lat, c_kx, c_ky = cand
                                    improved = True
                                    print(f"  refine {score:.4f}  lon_c={c_lon:.3f} lat_c={c_lat:.3f} kx={c_kx:.3f} ky={c_ky:.3f}")

    score, lon_c, lat_c, kx, ky = best
    print(f"BEST iou={score:.4f} lon_c={lon_c} lat_c={lat_c} kx={kx} ky={ky}")
    out = {
        "width": W,
        "height": H,
        "lon_c": lon_c,
        "lat_c": lat_c,
        "kx": kx,
        "ky": ky,
        "iou": score,
    }
    with open(os.path.join(HERE, "grid.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    # diagnostic overlay: target = red, render = green, both = yellow
    rmask = render(prefs, lon_c, lat_c, kx, ky)
    ov = np.zeros((H, W, 3), dtype=np.uint8)
    ov[..., 0] = 8
    ov[..., 1] = 10
    ov[..., 2] = 14
    ov[target & rmask] = (230, 200, 90)
    ov[target & ~rmask] = (200, 60, 60)
    ov[~target & rmask] = (50, 190, 120)
    Image.fromarray(ov).resize((W * 2, H * 2), Image.NEAREST).save(os.path.join(HERE, "calibration_overlay.png"))
    with open(os.path.join(HERE, "prefs_simplified.json"), "w", encoding="utf-8") as fh:
        json.dump(prefs, fh, ensure_ascii=False)
    print("wrote grid.json + calibration_overlay.png")


if __name__ == "__main__":
    main()
