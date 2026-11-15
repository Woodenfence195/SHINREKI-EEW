"""SQLite archive for Shinreki.

The intensity field (352x400, 0.1 JMA-scale units, 255 = no data) is stored in
three shapes so that weeks of history fit in a small file:

  K  keyframe  - full raster, zlib                      (every ~5 minutes)
  D  delta     - changed pixels versus the previous row  (1 Hz live tier)
  S  sparse    - absolute list of lit pixels             (compacted tiers)

Compaction rewrites anything older than the live window into sparse frames at
a coarser cadence, so the delta chain never grows without bound.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import zlib

import numpy as np

from .config import DATA_DIR
from .geo import H, W

PIXELS = W * H
NODATA = 255
VALUE_FLOOR = 3          # ignore flicker below 0.3 in compacted frames

SCHEMA = """
CREATE TABLE IF NOT EXISTS frames (
    ts   INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    data BLOB NOT NULL,
    maxi INTEGER,
    cnt  INTEGER
);
CREATE TABLE IF NOT EXISTS pref_stats (
    ts   INTEGER PRIMARY KEY,
    data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    key      TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    origin   INTEGER,
    created  INTEGER,
    updated  INTEGER,
    maxi     INTEGER,
    mag      REAL,
    lat      REAL,
    lon      REAL,
    depth    INTEGER,
    place    TEXT,
    payload  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_origin ON events(origin);
CREATE TABLE IF NOT EXISTS eews (
    key      TEXT PRIMARY KEY,
    grp      TEXT,
    serial   INTEGER,
    origin   INTEGER,
    report   INTEGER,
    updated  INTEGER,
    maxi     INTEGER,
    mag      REAL,
    lat      REAL,
    lon      REAL,
    depth    INTEGER,
    place    TEXT,
    cancelled INTEGER DEFAULT 0,
    payload  TEXT
);
CREATE INDEX IF NOT EXISTS idx_eews_report ON eews(report);
CREATE TABLE IF NOT EXISTS tsunamis (
    key     TEXT PRIMARY KEY,
    time    INTEGER,
    updated INTEGER,
    payload TEXT
);
CREATE TABLE IF NOT EXISTS longperiod (
    key     TEXT PRIMARY KEY,
    time    INTEGER,
    updated INTEGER,
    maxi    INTEGER,
    payload TEXT
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def decode_delta(blob, arr):
    raw = zlib.decompress(blob)
    n = int.from_bytes(raw[:4], "little")
    if n:
        idx = np.frombuffer(raw[4 : 4 + 4 * n], dtype="<u4")
        vals = np.frombuffer(raw[4 + 4 * n : 4 + 5 * n], dtype="u1")
        arr[idx] = vals
    return arr


def decode_sparse(blob, arr):
    raw = zlib.decompress(blob)
    n = int.from_bytes(raw[:4], "little")
    if n:
        idx = np.frombuffer(raw[4 : 4 + 4 * n], dtype="<u4")
        vals = np.frombuffer(raw[4 + 4 * n : 4 + 5 * n], dtype="u1")
        arr[idx] = vals
    return arr


def encode_sparse(arr, floor=0):
    mask = (arr > floor) & (arr != NODATA)
    idx = np.nonzero(mask)[0].astype("<u4")
    vals = arr[mask]
    raw = int(idx.size).to_bytes(4, "little") + idx.tobytes() + vals.tobytes()
    return zlib.compress(raw, 6)


def encode_full(arr):
    return zlib.compress(arr.tobytes(), 6)


def decode_full(blob):
    return np.frombuffer(zlib.decompress(blob), dtype="u1").copy()


def max_of(arr):
    live = arr[arr != NODATA]
    return int(live.max()) if live.size else 0


class Store:
    def __init__(self, path=None):
        self.path = path or os.path.join(DATA_DIR, "archive.db")
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA cache_size=-20000")
        self.db.executescript(SCHEMA)
        self.db.commit()
        self._prev = None
        self._prev_ts = 0

    # -- infrastructure --------------------------------------------------
    def _exec(self, sql, args=()):
        with self._lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur

    def _query(self, sql, args=()):
        with self._lock:
            return self.db.execute(sql, args).fetchall()

    def _one(self, sql, args=()):
        rows = self._query(sql, args)
        return rows[0] if rows else None

    def close(self):
        with self._lock:
            self.db.close()

    def size(self):
        total = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                total += os.path.getsize(self.path + suffix)
            except OSError:
                pass
        return total

    # -- frames ----------------------------------------------------------
    def last_frame_ts(self):
        row = self._one("SELECT MAX(ts) AS t FROM frames")
        return row["t"] if row and row["t"] else 0

    def last_frame(self):
        row = self._one("SELECT ts, kind, data, maxi FROM frames ORDER BY ts DESC LIMIT 1")
        if not row:
            return None, None
        if row["kind"] == "K":
            arr = decode_full(row["data"])
        elif row["kind"] == "D":
            ts, arr = self.get_frame(row["ts"])
        else:
            arr = np.full(PIXELS, NODATA, dtype=np.uint8)
            decode_sparse(row["data"], arr)
        return row["ts"], arr

    def append_frame(self, ts, arr, maxi=None, force_key=False):
        arr = np.asarray(arr, dtype=np.uint8).reshape(-1)
        if maxi is None:
            maxi = max_of(arr)
        with self._lock:
            if self._prev is None and self._prev_ts == 0:
                try:
                    self._prev_ts, self._prev = self.last_frame()
                except Exception:
                    self._prev = None
            if force_key or self._prev is None or ts - self._prev_ts > 300 or ts <= self._prev_ts:
                kind = "K"
                data = encode_full(arr)
            else:
                changed = np.nonzero(self._prev != arr)[0]
                n = int(changed.size)
                raw = n.to_bytes(4, "little") + changed.astype("<u4").tobytes() + arr[changed].tobytes()
                data = zlib.compress(raw, 6)
                kind = "D"
            self._prev_ts = ts
            self._prev = arr.copy()
            self.db.execute(
                "INSERT OR REPLACE INTO frames(ts,kind,data,maxi,cnt) VALUES(?,?,?,?,?)",
                (int(ts), kind, data, int(maxi), int(np.count_nonzero((arr > 0) & (arr != NODATA)))),
            )
            self.db.commit()

    def get_frame(self, ts):
        """Reconstruct the exact frame at ts, or the nearest previous one."""
        row = self._one("SELECT MAX(ts) AS t FROM frames WHERE kind='K' AND ts<=?", (int(ts),))
        start = row["t"] if row and row["t"] else None
        if start is None:
            row = self._one("SELECT MIN(ts) AS t FROM frames WHERE ts>=?", (int(ts),))
            if not row or not row["t"]:
                return None, None
            start = row["t"]
        rows = self._query(
            "SELECT ts,kind,data FROM frames WHERE ts>=? AND ts<=? ORDER BY ts", (start, int(ts))
        )
        arr = np.full(PIXELS, NODATA, dtype=np.uint8)
        got = None
        for r in rows:
            if r["kind"] == "K":
                arr = decode_full(r["data"])
            elif r["kind"] == "D":
                decode_delta(r["data"], arr)
            else:
                arr = np.full(PIXELS, NODATA, dtype=np.uint8)
                decode_sparse(r["data"], arr)
            got = r["ts"]
        return (got, arr) if got else (None, None)

    def iter_frames(self, start, end, step=1.0):
        """Yield (ts, array) at roughly `step` seconds between start and end."""
        row = self._one("SELECT MAX(ts) AS t FROM frames WHERE kind='K' AND ts<=?", (int(start),))
        key = row["t"] if row and row["t"] else None
        if key is None:
            row = self._one("SELECT MIN(ts) AS t FROM frames WHERE ts>=?", (int(start),))
            if not row or not row["t"]:
                return
            key = row["t"]
        rows = self._query(
            "SELECT ts,kind,data FROM frames WHERE ts>=? AND ts<=? ORDER BY ts", (key, int(end))
        )
        arr = np.full(PIXELS, NODATA, dtype=np.uint8)
        next_emit = float(start)
        last = None
        for r in rows:
            if r["kind"] == "K":
                arr = decode_full(r["data"])
            elif r["kind"] == "D":
                decode_delta(r["data"], arr)
            else:
                arr = np.full(PIXELS, NODATA, dtype=np.uint8)
                decode_sparse(r["data"], arr)
            last = r["ts"]
            if r["ts"] + 1e-6 >= next_emit:
                yield r["ts"], arr.copy()
                next_emit = r["ts"] + step

    def frame_span(self):
        row = self._one("SELECT MIN(ts) AS a, MAX(ts) AS b, COUNT(*) AS n FROM frames")
        if not row or not row["n"]:
            return None
        return {"from": row["a"], "to": row["b"], "count": row["n"]}

    def frame_buckets(self, since, bucket=300):
        rows = self._query(
            "SELECT CAST(ts/? AS INTEGER)*? AS b, MAX(maxi) AS m, COUNT(*) AS n "
            "FROM frames WHERE ts>=? GROUP BY b ORDER BY b",
            (bucket, bucket, int(since)),
        )
        return [{"t": r["b"], "maxi": r["m"] or 0, "n": r["n"]} for r in rows]

    def put_pref_stats(self, ts, values):
        self._exec(
            "INSERT OR REPLACE INTO pref_stats(ts,data) VALUES(?,?)",
            (int(ts), zlib.compress(bytes(values), 3)),
        )

    def pref_stats_range(self, since, until, max_points=800):
        rows = self._query(
            "SELECT ts,data FROM pref_stats WHERE ts>=? AND ts<=? ORDER BY ts", (int(since), int(until))
        )
        if not rows:
            return []
        stride = max(1, len(rows) // max_points)
        out = []
        for i, r in enumerate(rows):
            if i % stride:
                continue
            try:
                vals = list(zlib.decompress(r["data"]))
            except Exception:
                continue
            out.append({"t": r["ts"], "v": vals})
        return out

    # -- tiering ---------------------------------------------------------
    def compact(self, live_hours=24, middle_days=7, retention_days=30, force=False):
        """Rewrite frames older than the live window into sparse tiers."""
        now = int(time.time())
        live_cut = now - int(live_hours * 3600)
        keep_cut = now - int(retention_days * 86400)
        done_until = int(self.meta("compacted_until") or 0)
        if force:
            done_until = 0
        if done_until and done_until > live_cut:
            done_until = live_cut
        start = max(done_until, keep_cut)
        removed = 0
        while start < live_cut:
            end = min(start + 6 * 3600, live_cut)
            age_days = (now - start) / 86400.0
            step = 10 if age_days <= middle_days else 60
            removed += self._compact_window(start, end, step)
            self.meta("compacted_until", end)
            start = end
        if keep_cut > now - 3600:
            return removed
        deleted = self._exec("DELETE FROM frames WHERE ts<?", (keep_cut,)).rowcount
        self._exec("DELETE FROM pref_stats WHERE ts<?", (keep_cut,))
        return removed + max(0, deleted)

    def _compact_window(self, start, end, step):
        rows = self._query(
            "SELECT ts,kind,data FROM frames WHERE ts>=? AND ts<? ORDER BY ts", (start, end)
        )
        if not rows:
            return 0
        if all(r["kind"] == "S" for r in rows):
            return 0
        out = []
        arr = np.full(PIXELS, NODATA, dtype=np.uint8)
        next_emit = float(start)
        for r in rows:
            if r["kind"] == "K":
                arr = decode_full(r["data"])
            elif r["kind"] == "D":
                decode_delta(r["data"], arr)
            else:
                arr = np.full(PIXELS, NODATA, dtype=np.uint8)
                decode_sparse(r["data"], arr)
            if r["ts"] + 1e-6 >= next_emit:
                out.append((r["ts"], encode_sparse(arr, VALUE_FLOOR), max_of(arr)))
                next_emit = r["ts"] + step
        with self._lock:
            self.db.execute("DELETE FROM frames WHERE ts>=? AND ts<?", (start, end))
            self.db.executemany(
                "INSERT OR REPLACE INTO frames(ts,kind,data,maxi,cnt) VALUES(?,?,?,?,0)",
                [(int(ts), "S", blob, int(mx)) for ts, blob, mx in out],
            )
            self.db.commit()
            self._prev = None
            self._prev_ts = 0
        return len(rows)

    # -- events ----------------------------------------------------------
    def upsert_event(self, ev):
        payload = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
        self._exec(
            "INSERT INTO events(key,kind,origin,created,updated,maxi,mag,lat,lon,depth,place,payload) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
            "origin=excluded.origin, updated=excluded.updated, maxi=excluded.maxi, mag=excluded.mag, "
            "lat=excluded.lat, lon=excluded.lon, depth=excluded.depth, place=excluded.place, payload=excluded.payload",
            (
                ev["key"], ev.get("kind", "quake"), ev.get("origin"), ev.get("created", int(time.time())),
                int(time.time()), ev.get("maxi"), ev.get("mag"), ev.get("lat"), ev.get("lon"),
                ev.get("depth"), ev.get("place"), payload,
            ),
        )
        return ev

    def event(self, key):
        row = self._one("SELECT payload FROM events WHERE key=?", (key,))
        return json.loads(row["payload"]) if row else None

    def events_between(self, since, until, limit=500):
        rows = self._query(
            "SELECT payload FROM events WHERE origin>=? AND origin<=? ORDER BY origin DESC LIMIT ?",
            (int(since), int(until), int(limit)),
        )
        return [json.loads(r["payload"]) for r in rows]

    def recent_events(self, limit=30):
        rows = self._query("SELECT payload FROM events ORDER BY origin DESC LIMIT ?", (int(limit),))
        return [json.loads(r["payload"]) for r in rows]

    def search_events(self, text="", min_intensity=0, limit=100):
        like = f"%{text}%"
        rows = self._query(
            "SELECT payload FROM events WHERE place LIKE ? AND maxi>=? ORDER BY origin DESC LIMIT ?",
            (like, int(min_intensity), int(limit)),
        )
        return [json.loads(r["payload"]) for r in rows]

    def event_count(self):
        row = self._one("SELECT COUNT(*) AS n FROM events")
        return row["n"] if row else 0

    def put_eew(self, eew):
        self._exec(
            "INSERT INTO eews(key,grp,serial,origin,report,updated,maxi,mag,lat,lon,depth,place,cancelled,payload) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
            "origin=excluded.origin, report=excluded.report, updated=excluded.updated, maxi=excluded.maxi, "
            "mag=excluded.mag, lat=excluded.lat, lon=excluded.lon, depth=excluded.depth, place=excluded.place, "
            "cancelled=excluded.cancelled, payload=excluded.payload",
            (
                eew["key"], eew.get("grp"), eew.get("serial"), eew.get("origin"), eew.get("report"),
                int(time.time()), eew.get("maxi"), eew.get("mag"), eew.get("lat"), eew.get("lon"),
                eew.get("depth"), eew.get("place"), 1 if eew.get("cancelled") else 0,
                json.dumps(eew, ensure_ascii=False, separators=(",", ":")),
            ),
        )
        return eew

    def recent_eews(self, limit=10):
        rows = self._query("SELECT payload FROM eews ORDER BY report DESC LIMIT ?", (int(limit),))
        return [json.loads(r["payload"]) for r in rows]

    def eews_between(self, since, until, limit=200):
        rows = self._query(
            "SELECT payload FROM eews WHERE report>=? AND report<=? ORDER BY report DESC LIMIT ?",
            (int(since), int(until), int(limit)),
        )
        return [json.loads(r["payload"]) for r in rows]

    def put_tsunami(self, tsu):
        self._exec(
            "INSERT INTO tsunamis(key,time,updated,payload) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
            "time=excluded.time, updated=excluded.updated, payload=excluded.payload",
            (tsu["key"], tsu.get("time") or int(time.time()), int(time.time()),
             json.dumps(tsu, ensure_ascii=False, separators=(",", ":"))),
        )

    def latest_tsunami(self):
        row = self._one("SELECT payload FROM tsunamis ORDER BY updated DESC LIMIT 1")
        return json.loads(row["payload"]) if row else None

    # -- long period ground motion ---------------------------------------
    def put_longperiod(self, lp):
        self._exec(
            "INSERT INTO longperiod(key,time,updated,maxi,payload) VALUES(?,?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET time=excluded.time, updated=excluded.updated, "
            "maxi=excluded.maxi, payload=excluded.payload",
            (lp["key"], lp.get("time") or int(time.time()), int(time.time()), lp.get("maxi"),
             json.dumps(lp, ensure_ascii=False, separators=(",", ":"))),
        )
        return lp

    def latest_longperiod(self):
        row = self._one("SELECT payload FROM longperiod ORDER BY updated DESC LIMIT 1")
        return json.loads(row["payload"]) if row else None

    def longperiod_between(self, since, until, limit=100):
        rows = self._query(
            "SELECT payload FROM longperiod WHERE time>=? AND time<=? ORDER BY time DESC LIMIT ?",
            (int(since), int(until), int(limit)),
        )
        return [json.loads(r["payload"]) for r in rows]

    # -- destructive maintenance -----------------------------------------
    def clear(self, target="all"):
        tables = {
            "all": ["frames", "pref_stats", "events", "eews", "tsunamis", "longperiod"],
            "frames": ["frames", "pref_stats"],
            "events": ["events", "eews", "tsunamis", "longperiod"],
        }.get(target)
        if not tables:
            raise ValueError("unknown target")
        with self._lock:
            for table in tables:
                self.db.execute(f"DELETE FROM {table}")
            self.db.execute("DELETE FROM meta WHERE key LIKE 'compacted%'")
            self.db.commit()
            try:
                self.db.execute("VACUUM")
            except Exception:
                pass
            self._prev = None
            self._prev_ts = 0
        return target

    # -- statistics ------------------------------------------------------
    def stats(self, days=30):
        since = int(time.time()) - days * 86400
        rows = self._query(
            "SELECT origin, maxi, mag FROM events WHERE origin>=? ORDER BY origin", (since,)
        )
        by_day = {}
        mags = []
        maxi = 0
        for r in rows:
            day = time.strftime("%Y-%m-%d", time.gmtime(r["origin"] + 9 * 3600))
            slot = by_day.setdefault(day, {"n": 0, "maxi": 0})
            slot["n"] += 1
            if r["maxi"] is not None:
                slot["maxi"] = max(slot["maxi"], r["maxi"])
                maxi = max(maxi, r["maxi"])
            if r["mag"]:
                mags.append(r["mag"])
        buckets = {"M3-": 0, "M4": 0, "M5": 0, "M6": 0, "M7+": 0}
        for m in mags:
            if m < 4:
                buckets["M3-"] += 1
            elif m < 5:
                buckets["M4"] += 1
            elif m < 6:
                buckets["M5"] += 1
            elif m < 7:
                buckets["M6"] += 1
            else:
                buckets["M7+"] += 1
        hourly = [0] * 24
        for r in rows:
            hourly[time.gmtime(r["origin"] + 9 * 3600).tm_hour] += 1
        pref_counts = {}
        return {
            "days": days,
            "count": len(rows),
            "maxi": maxi,
            "by_day": by_day,
            "mag_buckets": buckets,
            "hourly": hourly,
            "pref_counts": pref_counts,
        }

    # -- meta ------------------------------------------------------------
    def meta(self, key, value=None):
        if value is None:
            row = self._one("SELECT value FROM meta WHERE key=?", (key,))
            return row["value"] if row else None
        self._exec("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))
        return value
