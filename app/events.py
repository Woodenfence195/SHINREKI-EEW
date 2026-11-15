"""Event normalisation, de-duplication and merging across data sources."""
from __future__ import annotations

import json
import time

from . import scale
from .geo import haversine

JST = 9 * 3600


def now():
    return int(time.time())


def parse_jst(text):
    """'2026/11/15 16:23:00(.07)' JST -> unix seconds."""
    if not text:
        return None
    t = str(text).strip().replace("T", " ")
    date, _, clock = t.partition(" ")
    try:
        y, mo, d = (int(v) for v in date.replace("-", "/").split("/"))
        parts = clock.split(":")
        hh, mm = int(parts[0]), int(parts[1])
        ss = float(parts[2]) if len(parts) > 2 and parts[2] else 0.0
    except (ValueError, IndexError):
        return None
    import calendar

    return int(calendar.timegm((y, mo, d, hh, mm, int(ss), 0, 0, 0)) - JST)


def parse_iso(text):
    """'2026-11-15T16:23:00+09:00' -> unix seconds."""
    if not text:
        return None
    t = str(text).strip()
    try:
        if t.endswith("Z"):
            import calendar
            import datetime

            dt = datetime.datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp())
        base = t[:19]
        off = t[19:]
        import datetime

        dt = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S")
        sign = 1
        if off.startswith("+"):
            sign = 1
        elif off.startswith("-"):
            sign = -1
        if off and off[0] in "+-":
            hours = int(off[1:3])
            minutes = int(off[4:6]) if len(off) >= 6 else 0
            ts = int(dt.replace(tzinfo=datetime.timezone.utc).timestamp()) - sign * (hours * 3600 + minutes * 60)
            return ts
        return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp())
    except Exception:
        return None


def quake_key(origin):
    """Second-resolution key so two quakes in the same minute stay separate."""
    t = time.gmtime(origin + JST)
    return "q-%04d%02d%02d%02d%02d%02d" % (
        t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec,
    )


def eew_group(event_id=None, origin=None):
    if event_id:
        return f"eg-{event_id}"
    if origin:
        return f"eg-{time.strftime('%Y%m%d%H%M%S', time.gmtime(origin + JST))}"
    return "eg-unknown"


def summarize(ev):
    return {
        "key": ev["key"],
        "kind": ev.get("kind", "quake"),
        "origin": ev.get("origin"),
        "place": ev.get("place"),
        "lat": ev.get("lat"),
        "lon": ev.get("lon"),
        "depth": ev.get("depth"),
        "mag": ev.get("mag"),
        "maxi": ev.get("maxi"),
        "maxi_label": scale.label(ev.get("maxi")),
        "tsunami": ev.get("tsunami"),
        "sources": list((ev.get("sources") or {}).keys()),
        "updated": ev.get("updated"),
        "reports": ev.get("reports", 1),
    }


class EventBook:
    """Canonical event registry shared by all sources."""

    def __init__(self, store, hub, logger):
        self.store = store
        self.hub = hub
        self.log = logger

    # -- quakes ----------------------------------------------------------
    def ingest_quake(self, source, data):
        """data: normalised quake dict (origin, lat, lon, depth, mag, place, maxi, ...)."""
        origin = data.get("origin")
        if not origin:
            return None
        key = quake_key(origin)
        existing = self.store.event(key)
        if existing is None:
            # look for the same quake from another source; keep the window tight
            # so that two genuinely simultaneous quakes are not merged
            rows = self.store.events_between(origin - 40, origin + 40, limit=20)
            for cand in rows:
                if abs((cand.get("origin") or 0) - origin) > 20:
                    continue
                if cand.get("lat") and data.get("lat"):
                    if haversine(cand["lat"], cand["lon"], data["lat"], data["lon"]) > 40:
                        continue
                if cand.get("mag") and data.get("mag"):
                    if abs(float(cand["mag"]) - float(data["mag"])) > 1.2:
                        continue
                key = cand["key"]
                existing = cand
                break
        if existing is None:
            existing = {
                "key": key,
                "kind": "quake",
                "origin": origin,
                "created": now(),
                "sources": {},
                "reports": 0,
            }
        sources = existing.get("sources") or {}
        sources[source] = data
        existing["sources"] = sources
        existing["reports"] = int(existing.get("reports", 0)) + 1
        # prefer JMA detail values when present, else the fastest source
        primary = sources.get("jma-xml") or sources.get("p2pquake") or data
        for field in ("lat", "lon", "depth", "mag", "place"):
            if primary.get(field) is not None:
                existing[field] = primary[field]
        # max intensity: take the highest reported by any source
        values = [s.get("maxi") for s in sources.values() if s.get("maxi") is not None]
        if values:
            existing["maxi"] = max(values)
        if data.get("points"):
            existing["points"] = data["points"]
        if data.get("tsunami"):
            existing["tsunami"] = data["tsunami"]
        if data.get("pref_max"):
            existing["pref_max"] = data["pref_max"]
        if data.get("comment"):
            existing["comment"] = data["comment"]
        existing["updated"] = now()
        existing["id"] = key
        existing["title"] = f"M{existing.get('mag')}" if existing.get("mag") else existing.get("place", "")
        self.store.upsert_event(existing)
        self.hub.broadcast("quake", summarize(existing))
        return existing

    # -- EEW -------------------------------------------------------------
    def ingest_eew(self, source, data):
        grp = data.get("grp") or eew_group(data.get("event_id"), data.get("origin"))
        serial = int(data.get("serial") or 1)
        key = f"{grp}-{serial:02d}"
        eew = {
            "key": key,
            "grp": grp,
            "serial": serial,
            "source": source,
            "report": data.get("report") or now(),
            "origin": data.get("origin"),
            "lat": data.get("lat"),
            "lon": data.get("lon"),
            "depth": data.get("depth"),
            "mag": data.get("mag"),
            "place": data.get("place"),
            "maxi": data.get("maxi"),
            "maxi_label": scale.label(data.get("maxi")),
            "areas": data.get("areas") or [],
            "cancelled": bool(data.get("cancelled")),
            "final": bool(data.get("final")),
            "urgent": bool(data.get("urgent", True)),
            "updated": now(),
        }
        eew["id"] = key
        self.store.put_eew(eew)
        self.hub.broadcast("eew", eew)
        return eew

    # -- tsunami ---------------------------------------------------------
    def ingest_tsunami(self, source, data):
        tsu = dict(data)
        tsu["source"] = source
        tsu["updated"] = now()
        tsu["id"] = tsu.get("key") or f"t-{tsu.get('time')}"
        tsu["key"] = tsu["id"]
        self.store.put_tsunami(tsu)
        self.hub.broadcast("tsunami", tsu)
        return tsu
