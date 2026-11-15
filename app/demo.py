"""Deterministic demo data: a plausible 8 hour chronicle ending 'now'.

Used for the built-in tour, for screenshots and for testing replay without
network access.  Everything is synthetic; no live feed is touched.
"""
from __future__ import annotations

import math
import os
import time

import numpy as np

from . import scale
from .geo import H, W, LAT_C, LON_C, KX, KY
from .store import NODATA, PIXELS

JST = 9 * 3600
RNG = np.random.default_rng(20251115)

_LAST, _FIRST = np.meshgrid(np.arange(W), np.arange(H))
LON = ( _LAST - W / 2) / KX + LON_C
LAT = LAT_C - (_FIRST - H / 2) / KY

try:
    _PREFMAP = np.frombuffer(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "prefmap.bin"), "rb").read(), dtype=np.uint8)
except Exception:
    _PREFMAP = np.ones(PIXELS, dtype=np.uint8)

LAND = (_PREFMAP > 0).reshape(H, W)
STATION_MASK = LAND & (RNG.random((H, W)) < 0.18)
SITE = RNG.normal(0, 0.55, size=(H, W))

# realistic-looking observation point names for the synthetic bulletins
STATIONS = {
    "宮城県": ["仙台市青葉区", "石巻市", "大崎市古川", "気仙沼市", "登米市", "栗原市", "名取市", "角田市",
             "白石市", "多賀城市", "塩竈市", "東松島市", "岩沼市", "亘理町", "山元町", "女川町"],
    "岩手県": ["盛岡市", "宮古市", "大船渡市", "釜石市", "花巻市", "一関市", "陸前高田市", "久慈市", "遠野市"],
    "福島県": ["福島市", "郡山市", "いわき市", "白河市", "相馬市", "二本松市", "田村市", "南相馬市"],
    "茨城県": ["水戸市", "日立市", "土浦市", "つくば市", "ひたちなか市", "鹿嶋市", "常陸太田市"],
    "千葉県": ["千葉市中央区", "銚子市", "市川市", "船橋市", "館山市", "勝浦市", "旭市"],
    "熊本県": ["熊本市中央区", "八代市", "人吉市", "天草市", "宇土市", "宇城市", "阿蘇市", "山鹿市"],
    "島根県": ["松江市", "出雲市", "浜田市", "益田市", "大田市", "安来市"],
    "石川県": ["金沢市", "七尾市", "輪島市", "珠洲市", "穴水町", "能登町", "輪島市門前町"],
    "岐阜県": ["岐阜市", "高山市", "飛騨市", "下呂市", "郡上市", "白川村"],
    "和歌山県": ["和歌山市", "田辺市", "新宮市", "海南市", "橋本市", "有田市"],
    "東京都": ["千代田区", "新宿区", "世田谷区", "八王子市", "府中市", "調布市", "町田市"],
    "北海道": ["札幌市中央区", "函館市", "釧路市", "帯広市", "北見市", "室蘭市", "根室市"],
}


def pref_of_place(place):
    for pref in STATIONS:
        if pref in place or place.startswith(pref.replace("県", "")):
            return pref
    for pref in ("宮城県", "岩手県", "福島県"):
        if pref[:2] in place:
            return pref
    return ""


def station_names(place, n):
    pref = pref_of_place(place)
    pool = list(STATIONS.get(pref) or [x for names in STATIONS.values() for x in names])
    RNG.shuffle(pool)
    out = []
    for i in range(n):
        name = pool[i % len(pool)]
        if i >= len(pool):
            name = f"{name}＊"
        out.append(name)
    return out, pref


def field(magnitude, lat, lon, depth, scale=1.0):
    epi = np.hypot((LAT - lat) * 111.0, (LON - lon) * 111.0 * math.cos(math.radians(lat)))
    r = np.maximum(5.0, np.hypot(epi, depth))
    intensity = 1.0 + 1.5 * magnitude - 3.0 * np.log10(r) + SITE * scale
    out = np.full((H, W), NODATA, dtype=np.uint8)
    vals = np.clip(np.round(intensity * 10), 0, 70).astype(np.uint8)
    out[STATION_MASK] = vals[STATION_MASK]
    return out


def quiet():
    out = np.full((H, W), NODATA, dtype=np.uint8)
    base = np.clip(np.round(RNG.normal(0.12, 0.14, size=(H, W)) * 10), 0, 6).astype(np.uint8)
    out[STATION_MASK] = base[STATION_MASK]
    return out


def pref_stats(arr):
    values = bytearray(48)
    flat = arr.reshape(-1)
    for pid in range(1, 48):
        idx = np.nonzero(_PREFMAP == pid)[0]
        if not idx.size:
            continue
        vals = flat[idx]
        live = vals[vals != NODATA]
        values[pid] = int(live.max()) if live.size else 0
    return bytes(values)


PLACES = [
    ("茨城県沖", 36.4, 141.2, 50), ("千葉県東方沖", 35.4, 140.9, 40), ("福島県沖", 37.3, 141.6, 45),
    ("宮城県沖", 38.3, 142.1, 50), ("岩手県沖", 39.6, 142.4, 40), ("北海道東方沖", 43.4, 146.2, 60),
    ("熊本県熊本地方", 32.7, 130.8, 10), ("島根県東部", 35.3, 133.1, 12), ("石川県能登地方", 37.5, 137.2, 12),
    ("岐阜県飛騨地方", 36.2, 137.4, 8), ("和歌山県北部", 34.2, 135.4, 8), ("東京湾", 35.5, 139.9, 60),
]


def _event(app, origin, mag, lat, lon, depth, place, maxi, source_mix=True, points_n=20):
    key_ts = int(origin)
    pref_points = []
    if points_n:
        names, pref = station_names(place, points_n)
        for i, name in enumerate(names):
            val = max(0.5, min(7.0, maxi - abs(RNG.normal(0, 1.2))))
            val = round(val * 2) / 2 if val > 4 else round(val)
            pref_points.append({"pref": pref, "addr": name, "scale": float(val), "label": scale.label(val)})
    data = {
        "origin": key_ts,
        "lat": lat,
        "lon": lon,
        "depth": depth,
        "mag": mag,
        "place": place,
        "maxi": maxi,
        "points": pref_points,
        "tsunami": "None",
        "comment": "この地震による津波の心配はありません。（デモデータ）",
    }
    ev = app.book.ingest_quake("p2pquake", dict(data))
    if source_mix:
        jma = dict(data)
        jma["points"] = pref_points
        jma["pref_max"] = {}
        ev = app.book.ingest_quake("jma-xml", jma)
    return ev


def seed_demo(app, hours=8, with_frames=True):
    now = int(time.time())
    start = now - hours * 3600
    store = app.store
    info = {"events": 0, "frames": 0}

    # quiet background frames, one per minute
    if with_frames:
        t = start
        while t < now - 200:
            f = quiet()
            store.append_frame(t, f, 0, force_key=(t % 600 < 60))
            store.put_pref_stats(t, pref_stats(f))
            t += 60
            info["frames"] += 1

    # the main event: M7.4 offshore Miyagi, three hours ago
    main_time = now - 3 * 3600
    lat, lon, depth, mag, place = 38.16, 142.34, 45, 7.4, "宮城県沖"
    for k, serial in enumerate((1, 2, 3)):
        areas = []
        for name, pref, lo, hi in (
            ("宮城県北部", "宮城", 5.0, 6.0),
            ("宮城県南部", "宮城", 5.0, 5.5),
            ("岩手県沿岸南部", "岩手", 4.5, 5.5),
            ("福島県浜通り", "福島", 4.5, 5.0),
            ("山形県村山", "山形", 4.0, 4.5),
            ("秋田県沿岸南部", "秋田", 3.5, 4.5),
        ):
            areas.append({"pref": pref, "name": name, "from": lo, "to": hi, "arrival": main_time + 20 + k * 3})
        app.book.ingest_eew(
            "p2pquake",
            {
                "event_id": "demo2026",
                "serial": serial,
                "report": main_time - 14 + k * 6,
                "origin": main_time,
                "lat": lat,
                "lon": lon,
                "depth": depth,
                "mag": mag - 0.2 * (2 - k),
                "place": place,
                "maxi": 5.0 + 0.5 * k,
                "areas": areas,
                "cancelled": False,
            },
        )
    ev = _event(app, main_time, mag, lat, lon, depth, place, 6.5, points_n=40)
    info["events"] += 1
    if with_frames:
        # shaking animation around the main event
        peak = None
        for off in range(-20, 100):
            amp = 1.0 if off > 0 else 0.7
            f = field(mag, lat, lon, depth, scale=amp)
            store.append_frame(main_time + off, f, 65, force_key=(off == -20))
            if off == 30:
                peak = f
            info["frames"] += 1
        store.put_pref_stats(main_time + 30, pref_stats(peak if peak is not None else field(mag, lat, lon, depth)))

    # aftershocks
    aftershocks = [
        (main_time + 9 * 60, 5.2, 38.05, 142.4, 40, "宮城県沖", 4.0),
        (main_time + 26 * 60, 4.7, 38.3, 142.0, 45, "宮城県沖", 3.5),
        (main_time + 52 * 60, 4.3, 37.9, 142.6, 35, "宮城県沖", 3.0),
        (main_time + 95 * 60, 4.9, 38.4, 141.9, 50, "宮城県沖", 3.5),
    ]
    for o, m, la, lo, d, pl, mi in aftershocks:
        _event(app, o, m, la, lo, d, pl, mi, points_n=12)
        info["events"] += 1
        if with_frames:
            for off in range(0, 30):
                f = field(m, la, lo, d, 1.0)
                store.append_frame(int(o) + off, f, int(mi * 10), force_key=(off == 0))
                info["frames"] += 1
            store.put_pref_stats(int(o) + 10, pref_stats(field(m, la, lo, d, 1.0)))

    # scattered small quakes through the day
    for i in range(16):
        o = start + RNG.uniform(0, hours * 3600)
        if abs(o - main_time) < 900:
            continue
        name, la, lo, d = PLACES[i % len(PLACES)]
        m = float(np.round(RNG.uniform(3.0, 5.0), 1))
        mi = float(min(4.5, max(0.5, round(1.0 + 1.5 * m - 3.0 * math.log10(RNG.uniform(30, 120))))))
        _event(app, o, m, la, lo, d, name, mi, points_n=6)
        info["events"] += 1

    store.meta("demo_seeded", str(now))
    app.log(f"demo seeded: {info}")
    return info
