"""Real-time intensity collector (public NIED 強震モニタ raster)."""
from __future__ import annotations

import io
import json
import os
import threading
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

from .config import ASSETS_DIR, DATA_DIR, ROOT
from .geo import H, W

BASE = "http://www.kmoni.bosai.go.jp"
HEADERS = {
    "User-Agent": "Shinreki/0.1 (+local desktop app)",
    "Referer": BASE + "/",
    "Accept": "image/gif,image/*;q=0.8",
}
NODATA = 255


def _legend():
    path = os.path.join(ASSETS_DIR, "legend.json")
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    colors = []
    values = []
    for stop in doc["stops"]:
        c = stop["c"]
        colors.append([int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)])
        values.append(float(stop["v"]))
    return np.array(colors, dtype=np.int32), np.array(values, dtype=np.float64)


class KmoniCollector:
    def __init__(self, store, hub, config, logger):
        self.store = store
        self.hub = hub
        self.config = config
        self.log = logger
        self._stop = threading.Event()
        self.thread = None
        self.legend_colors, self.legend_values = _legend()
        self.prefmap = self._load_prefmap()
        self.last_ts = 0
        self.last_maxi = 0
        self.last_ok = 0.0
        self.failures = 0
        self.latency = 0.0
        self.frame_count = 0
        self._lut_cache = {}
        self._pref_idx = self._pref_indices()

    # -- assets ----------------------------------------------------------
    def _load_prefmap(self):
        path = os.path.join(ASSETS_DIR, "prefmap.bin")
        try:
            raw = open(path, "rb").read()
            arr = np.frombuffer(raw, dtype=np.uint8)
            if arr.size == W * H:
                return arr
        except Exception:
            pass
        return None

    def _pref_indices(self):
        if self.prefmap is None:
            return {}
        out = {}
        for pid in range(1, 48):
            idx = np.nonzero(self.prefmap == pid)[0]
            if idx.size:
                out[pid] = idx
        return out

    # -- decoding --------------------------------------------------------
    def _palette_lut(self, palette):
        key = bytes(palette[:96])
        lut = self._lut_cache.get(key)
        if lut is not None:
            return lut
        pal = np.array(palette, dtype=np.int32).reshape(-1, 3)
        diff = pal[:, None, :] - self.legend_colors[None, :, :]
        dist2 = (diff * diff).sum(axis=2)
        best = dist2.argmin(axis=1)
        dist = np.sqrt(dist2.min(axis=1))
        lut = np.clip(np.round(self.legend_values[best] * 10), 0, 250).astype(np.uint8)
        lut[dist > 42] = NODATA
        if len(self._lut_cache) > 64:
            self._lut_cache.clear()
        self._lut_cache[key] = lut
        return lut

    def decode(self, gif_bytes):
        im = Image.open(io.BytesIO(gif_bytes))
        idx = np.array(im)
        lut = self._palette_lut(im.getpalette())
        arr = np.full((H, W), NODATA, dtype=np.uint8)
        mask = idx > 0
        arr[mask] = lut[idx[mask]]
        return arr

    # -- fetching --------------------------------------------------------
    def _url(self, ts):
        t = time.strftime("%Y%m%d%H%M%S", time.gmtime(ts + 9 * 3600))
        return f"{BASE}/data/map_img/RealTimeImg/jma_s/{t[:8]}/{t}.jma_s.gif"

    def fetch(self, ts):
        req = urllib.request.Request(self._url(ts), headers=HEADERS)
        with urllib.request.urlopen(req, timeout=6) as resp:
            if resp.status != 200:
                return None
            return resp.read()

    # -- loop ------------------------------------------------------------
    def start(self):
        self.thread = threading.Thread(target=self._run, name="kmoni", daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        self.log("kmoni: collector started")
        while not self._stop.is_set():
            started = time.time()
            target = int(started) - 1
            gif = None
            ts = None
            for back in range(0, 5):
                cand = target - back
                try:
                    gif = self.fetch(cand)
                    if gif:
                        ts = cand
                        break
                except urllib.error.HTTPError as exc:
                    if exc.code != 404:
                        self.failures += 1
                except Exception:
                    self.failures += 1
                time.sleep(0.12)
            if gif:
                try:
                    arr = self.decode(gif)
                    if ts <= self.last_ts:
                        ts = self.last_ts + 1
                    maxi = int(arr[arr != NODATA].max()) if (arr != NODATA).any() else 0
                    self.store.append_frame(ts, arr, maxi)
                    self.last_ts = ts
                    self.last_maxi = maxi
                    self.last_ok = time.time()
                    self.latency = max(0.0, self.last_ok - ts)
                    self.failures = 0
                    self.frame_count += 1
                    self.hub.broadcast(
                        "frame",
                        {"ts": ts, "maxi": maxi, "n": int(np.count_nonzero((arr > 0) & (arr != NODATA)))},
                    )
                    if ts % 10 < 2:
                        self._pref_stats(ts, arr)
                except Exception as exc:
                    self.log(f"kmoni frame error: {exc!r}")
            else:
                self.failures += 1
                if self.failures % 30 == 0:
                    self.log(f"kmoni: {self.failures} consecutive fetch failures")
            elapsed = time.time() - started
            time.sleep(max(0.05, 1.0 - elapsed))

    def _pref_stats(self, ts, arr):
        if not self._pref_idx:
            return
        flat = arr.reshape(-1)
        values = bytearray(48)
        for pid, idx in self._pref_idx.items():
            vals = flat[idx]
            live = vals[vals != NODATA]
            values[pid] = int(live.max()) if live.size else 0
        try:
            self.store.put_pref_stats(ts, values)
        except Exception:
            pass

    # -- status ----------------------------------------------------------
    def status(self):
        age = time.time() - self.last_ok if self.last_ok else None
        return {
            "ok": bool(self.last_ok and age is not None and age < 20),
            "ts": self.last_ts,
            "maxi": self.last_maxi,
            "age": round(age, 1) if age is not None else None,
            "latency": round(self.latency, 2),
            "failures": self.failures,
            "frames": self.frame_count,
        }
