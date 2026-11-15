"""Application core: wires sources, archive and API together."""
from __future__ import annotations

import io
import json
import math
import os
import threading
import time
import traceback
import zlib

import numpy as np

from .config import Config, DATA_DIR
from .events import EventBook, summarize
from .geo import LAT_MAX, LAT_MIN, LON_MAX, LON_MIN, haversine, pref_centroids, qz_intensity, travel_times
from .hub import Hub
from .jmaxml import JmaXmlSource
from .kmoni import KmoniCollector
from .p2pquake import P2PQuakeSource
from .store import NODATA, PIXELS, Store, decode_full, encode_sparse

JST = 9 * 3600


class Log:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.buffer = []
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            if os.path.getsize(path) > 2_000_000:
                os.replace(path, path + ".1")
        except OSError:
            pass

    def __call__(self, msg):
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
        with self.lock:
            self.buffer.append(line)
            if len(self.buffer) > 400:
                del self.buffer[:200]
            try:
                with open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass
        try:
            print(line, flush=True)
        except Exception:
            pass


class App:
    def __init__(self, config=None):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.config = config or Config()
        self.log = Log(os.path.join(DATA_DIR, "shinreki.log"))
        self.store = Store()
        self.hub = Hub(self.log)
        self.book = EventBook(self.store, self.hub, self.log)
        self.kmoni = None
        self.p2p = None
        self.jma = None
        self.started = time.time()
        self._compact_thread = None
        self._stop = threading.Event()
        self.test_eews = {}

    # -- lifecycle -------------------------------------------------------
    def start(self):
        sources = self.config.get("sources", {})
        if sources.get("kmoni", True):
            self.kmoni = KmoniCollector(self.store, self.hub, self.config, self.log)
            self.kmoni.start()
        if sources.get("p2pquake", True):
            self.p2p = P2PQuakeSource(self.book, self.store, self.hub, self.config, self.log)
            self.p2p.start()
        if sources.get("jma", True):
            self.jma = JmaXmlSource(self.book, self.store, self.hub, self.config, self.log)
            self.jma.start()
        self._compact_thread = threading.Thread(target=self._maintenance, name="maint", daemon=True)
        self._compact_thread.start()
        threading.Thread(target=self._state_loop, name="state", daemon=True).start()
        self.log("Shinreki started")

    def stop(self):
        self._stop.set()

    def _maintenance(self):
        try:
            self.store.compact(
                live_hours=self.config.get("live_hours", 24),
                middle_days=7,
                retention_days=self.config.get("retention_days", 30),
            )
        except Exception:
            self.log("compact failed: " + traceback.format_exc(limit=2))
        while not self._stop.is_set():
            self._stop.wait(3 * 3600)
            try:
                self.store.compact(
                    live_hours=self.config.get("live_hours", 24),
                    middle_days=7,
                    retention_days=self.config.get("retention_days", 30),
                )
            except Exception:
                self.log("compact failed: " + traceback.format_exc(limit=2))

    def _state_loop(self):
        while not self._stop.is_set():
            try:
                self.hub.broadcast("state", self.state())
            except Exception:
                pass
            self._stop.wait(5)

    # -- state -----------------------------------------------------------
    def _active_eews(self, window=240):
        cutoff = time.time() - window
        out = []
        seen = set()
        for eew in self.store.recent_eews(20):
            grp = eew.get("grp")
            if grp in seen:
                continue
            seen.add(grp)
            if eew.get("report", 0) >= cutoff and not eew.get("cancelled"):
                out.append(eew)
        now = time.time()
        for key, eew in list(self.test_eews.items()):
            if eew.get("cancelled") or now - eew.get("report", now) > 300:
                self.test_eews.pop(key, None)
                continue
            out.append(eew)
        out.sort(key=lambda e: e.get("report") or 0, reverse=True)
        return out[:6]

    def state(self):
        ks = self.kmoni.status() if self.kmoni else {"ok": False}
        ps = self.p2p.status() if self.p2p else {"connected": False}
        js = self.jma.status() if self.jma else {"ok": False}
        span = self.store.frame_span()
        quakes = [summarize(e) for e in self.store.recent_events(18)]
        eews = self._active_eews()
        tsu = self.store.latest_tsunami()
        if tsu and tsu.get("time") and time.time() - tsu["time"] > 86400:
            tsu = None
        last_ts = ks.get("ts") or self.store.last_frame_ts()
        return {
            "now": int(time.time()),
            "started": int(self.started),
            "mode": "demo" if not any((self.config.get("sources") or {}).values()) else "live",
            "status": {"kmoni": ks, "p2p": ps, "jma": js},
            "frame": {"ts": last_ts, "maxi": ks.get("maxi"), "age": ks.get("age")},
            "eews": eews,
            "quakes": quakes,
            "tsunami": tsu,
            "longperiod": self.store.latest_longperiod(),
            "longperiods": self.store.longperiod_between(time.time() - 7 * 86400, time.time() + 60, 8),
            "archive": {
                "frames": span["count"] if span else 0,
                "from": span["from"] if span else None,
                "to": span["to"] if span else None,
                "bytes": self.store.size(),
                "events": self.store.event_count(),
                "retention_days": self.config.get("retention_days", 30),
            },
            "settings": {
                "location": self.config.get("location"),
                "palette": self.config.get("palette"),
                "sound": self.config.get("sound"),
                "speech": self.config.get("speech"),
                "retention_days": self.config.get("retention_days"),
                "live_hours": self.config.get("live_hours"),
                "rotate_seconds": self.config.get("rotate_seconds", 5),
            },
            "bounds": {"lon_min": LON_MIN, "lon_max": LON_MAX, "lat_min": LAT_MIN, "lat_max": LAT_MAX},
            "clients": self.hub.count(),
        }

    # -- frames ----------------------------------------------------------
    def raster(self, ts=None):
        if ts is None:
            ts = self.store.last_frame_ts()
        if not ts:
            return None, None
        got, arr = self.store.get_frame(ts)
        if arr is None:
            return None, None
        return got, arr.tobytes()

    def sparse_frame(self, ts=None, floor=0):
        got, raw = self.raster(ts)
        if raw is None:
            return None
        arr = np.frombuffer(raw, dtype=np.uint8)
        idx = np.nonzero((arr > floor) & (arr != NODATA))[0]
        vals = arr[idx]
        return {
            "ts": got,
            "maxi": int(arr[arr != NODATA].max()) if (arr != NODATA).any() else 0,
            "i": idx.astype(int).tolist(),
            "v": vals.astype(int).tolist(),
        }

    def frames_binary(self, start, end, step=1.0):
        """Binary frame stream: magic, count, then sparse frames."""
        out = io.BytesIO()
        frames = list(self.store.iter_frames(start, end, step))
        out.write(b"SHFR")
        out.write(bytes([1, 0]))
        out.write(len(frames).to_bytes(4, "little"))
        for ts, arr in frames:
            idx = np.nonzero((arr > 0) & (arr != NODATA))[0]
            vals = arr[idx]
            out.write(int(ts).to_bytes(4, "little"))
            out.write(int(idx.size).to_bytes(4, "little"))
            out.write(idx.astype("<u4").tobytes())
            out.write(vals.astype("u1").tobytes())
        return out.getvalue(), len(frames)

    # -- queries ---------------------------------------------------------
    def events(self, since, until, limit=200):
        return self.store.events_between(since, until, limit)

    def event_detail(self, key):
        ev = self.store.event(key)
        if ev is None:
            return None
        if ev.get("points"):
            pts = sorted(ev["points"], key=lambda p: -(p.get("scale") or 0))
            ev["top_points"] = pts[:60]
            ev["point_count"] = len(ev["points"])
        return ev

    def stats(self, days=30):
        data = self.store.stats(days)
        data["archive"] = self.state()["archive"]
        return data

    def heat(self, since, until):
        return self.store.pref_stats_range(since, until)

    def timeline(self, since, until):
        span = max(60.0, float(until) - float(since))
        bucket = int(max(60, min(3600, span / 260)))
        return {
            "from": since,
            "to": until,
            "bucket": bucket,
            "buckets": self.store.frame_buckets(since, bucket),
            "events": [summarize(e) for e in self.store.events_between(since, until, 240)],
            "eews": [
                {"key": e.get("key"), "report": e.get("report"), "maxi": e.get("maxi"),
                 "place": e.get("place"), "serial": e.get("serial"), "cancelled": e.get("cancelled")}
                for e in self.store.eews_between(since, until, 240)
            ],
        }

    def demo_eew(self, opts=None):
        """Fire a synthetic EEW for rehearsal.  Never written to the archive."""
        import math

        opts = opts or {}
        now = int(time.time())
        centroids = pref_centroids()
        pref = (opts.get("pref") or "").strip()
        lat = opts.get("lat")
        lon = opts.get("lon")
        place = (opts.get("place") or "").strip()
        if lat is None or lon is None:
            if pref and pref in centroids:
                lon, lat = centroids[pref]
            else:
                loc = self.config.get("location") or {"lat": 35.68, "lon": 139.77}
                lat, lon = loc["lat"], loc["lon"]
        lat = float(lat)
        lon = float(lon)
        depth = float(opts.get("depth") or 40)
        mag = float(opts.get("mag") or 7.0)
        want_max = float(opts.get("maxi") or 6.0)
        origin_t = now - int(opts.get("delay") or 2)
        if not place:
            place = pref or f"{lat:.2f}N {lon:.2f}E"
        # expected intensity for every prefecture, anchored to the requested maximum
        def raw_intensity(d):
            r = max(1.0, math.hypot(d, max(0.0, depth)))
            return 2.68 + 1.72 * mag - 2.32 * math.log10(r)

        raw = {}
        for name, (clon, clat) in centroids.items():
            d = haversine(lat, lon, clat, clon)
            if d > 900:
                continue
            raw[name] = raw_intensity(d)
        if not raw:
            raw = {pref or "東京": want_max}
        peak = max(raw.values()) or 1.0
        shift = want_max - peak
        areas = []
        ranked = sorted(raw.items(), key=lambda kv: kv[1], reverse=True)[:12]
        for name, val in ranked:
            v = max(0.0, min(7.0, val + shift))
            if v < 1.5:
                continue
            d = haversine(lat, lon, centroids[name][1], centroids[name][0])
            s_time = self._s_travel(d, depth)
            short = name[:-1] if name.endswith(("県", "府", "都")) else name
            areas.append(
                {
                    "pref": short,
                    "name": name,
                    "from": max(0.5, round(v * 2) / 2 - 0.5),
                    "to": max(0.5, round(v * 2) / 2),
                    "arrival": origin_t + int(round(s_time)),
                }
            )
        key = f"test-{now}-{len(self.test_eews)}"
        eew = {
            "key": key,
            "grp": key,
            "serial": int(opts.get("serial") or 1),
            "source": "test",
            "test": True,
            "report": now,
            "origin": origin_t,
            "lat": lat,
            "lon": lon,
            "depth": depth,
            "mag": mag,
            "place": place,
            "maxi": want_max,
            "maxi_label": None,
            "areas": areas,
            "cancelled": False,
            "final": False,
            "urgent": True,
            "updated": now,
        }
        eew["id"] = eew["key"]
        self.test_eews[eew["key"]] = eew
        self.hub.broadcast("eew", eew)
        self.hub.broadcast("state", self.state())
        self.log(f"test EEW fired: {place} M{mag} depth {depth} max {want_max}")
        return eew

    def demo_double(self, delay=2):
        """Two simultaneous test EEWs (東北 + 九州) for multi-event rehearsal."""
        delay = int(delay or 2)
        first = self.demo_eew({"pref": "宮城県", "mag": 7.2, "depth": 40, "maxi": 6.5, "delay": delay})
        second = self.demo_eew({"pref": "熊本県", "mag": 6.4, "depth": 12, "maxi": 5.5, "delay": delay})
        return [first, second]

    def end_demo_eew(self):
        now = int(time.time())
        ended = []
        for key, eew in list(self.test_eews.items()):
            cancelled = dict(eew)
            cancelled.update({"cancelled": True, "final": True, "report": now, "updated": now})
            self.hub.broadcast("eew", cancelled)
            ended.append(key)
        self.test_eews.clear()
        self.hub.broadcast("state", self.state())
        return ended

    @staticmethod
    def _s_travel(epi_km, depth_km):
        r = math.hypot(epi_km, max(0.0, depth_km or 0.0))
        if r <= 150:
            return r / 4.0
        return 150 / 4.0 + (r - 150) / 6.8

    def clear_history(self, target="all"):
        self.store.clear(target)
        self.test_eews.clear()
        self.hub.broadcast("state", self.state())
        self.log(f"history cleared: {target}")
        return target

    def set_settings(self, patch):
        if "location" in patch and isinstance(patch["location"], dict):
            loc = patch["location"]
            try:
                loc["lat"] = float(loc.get("lat"))
                loc["lon"] = float(loc.get("lon"))
            except (TypeError, ValueError):
                raise ValueError("bad location")
        data = self.config.update(patch)
        try:
            self.store.compact(
                live_hours=data.get("live_hours", 24),
                middle_days=7,
                retention_days=data.get("retention_days", 30),
            )
        except Exception:
            pass
        self.hub.broadcast("state", self.state())
        return data
