"""Geodesy helpers: the NIED raster projection, distances and wave travel."""
from __future__ import annotations

import json
import math
import os

from .config import ASSETS_DIR, DATA_DIR, ROOT, WEB_DIR

GRID = {"width": 352, "height": 400, "lon_c": 137.28, "lat_c": 38.08, "kx": 20.24, "ky": 24.48}
for _candidate in (
    os.path.join(ASSETS_DIR, "grid.json"),
    os.path.join(ROOT, "tools", "grid.json"),
):
    try:
        with open(_candidate, "r", encoding="utf-8") as _fh:
            _g = json.load(_fh)
            GRID.update({k: _g[k] for k in ("width", "height", "lon_c", "lat_c", "kx", "ky")})
        break
    except Exception:
        continue

W, H = GRID["width"], GRID["height"]
LON_C, LAT_C = GRID["lon_c"], GRID["lat_c"]
KX, KY = GRID["kx"], GRID["ky"]

# bounds of the raster in geographic coordinates
LON_MIN = LON_C - (W / 2) / KX
LON_MAX = LON_C + (W / 2) / KX
LAT_MIN = LAT_C - (H / 2) / KY
LAT_MAX = LAT_C + (H / 2) / KY

EARTH_R = 6371.0


def lonlat_to_xy(lon, lat):
    return (lon - LON_C) * KX + W / 2, (LAT_C - lat) * KY + H / 2


def xy_to_lonlat(x, y):
    return (x - W / 2) / KX + LON_C, LAT_C - (y - H / 2) / KY


def in_raster(lon, lat):
    return LON_MIN <= lon <= LON_MAX and LAT_MIN <= lat <= LAT_MAX


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(a)))


def hypocentral_distance(epi_km, depth_km):
    return math.hypot(epi_km, max(0.0, depth_km or 0.0))


def travel_times(epi_km, depth_km):
    """Seconds for P and S to reach a site, using simple 1-D velocities."""
    d = hypocentral_distance(epi_km, depth_km)
    return d / 7.0, d / 4.0


def qz_intensity(magnitude, epi_km, depth_km):
    """Empirical PGV-style intensity estimate (JMA-like), for a rough hint.

    Based on the well known 2.68 + 1.72M - 2.32 log10(R) relation, clamped.
    """
    if magnitude is None:
        return None
    r = max(1.0, hypocentral_distance(epi_km, depth_km))
    i = 2.68 + 1.72 * float(magnitude) - 2.32 * math.log10(r)
    return max(0.0, min(7.0, i))


def pref_centroids():
    path = os.path.join(WEB_DIR, "data", "japan.json")
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}
    return {p["ja"]: (p["c"][0], p["c"][1]) for p in doc["prefs"]}


def load_prefmap():
    path = os.path.join(ASSETS_DIR, "prefmap.bin")
    try:
        return open(path, "rb").read()
    except Exception:
        return None
