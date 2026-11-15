"""P2PQuake (p2pquake.net) feed: EEW, earthquake reports and tsunami."""
from __future__ import annotations

import json
import threading
import time
import urllib.request

from . import scale
from .events import parse_jst
from .wsclient import ReconnectingSocket

WS_URL = "wss://api.p2pquake.net/v2/ws"
REST = "https://api.p2pquake.net/v2/history?codes={codes}&limit={limit}"
UA = "Shinreki/0.1 (+https://github.com/; local desktop app)"


class P2PQuakeSource:
    def __init__(self, book, store, hub, config, logger):
        self.book = book
        self.store = store
        self.hub = hub
        self.config = config
        self.log = logger
        self.ws = None
        self.poller = None
        self._stop = threading.Event()
        self.seen = {}
        self.last_message = 0.0
        self.connected = False
        self.received = 0
        self.last_eew = 0.0

    # -- lifecycle -------------------------------------------------------
    def start(self):
        self.ws = ReconnectingSocket(WS_URL, self._on_ws, headers={"User-Agent": UA}, name="p2pquake", logger=self.log)
        self.ws.start()
        self.poller = threading.Thread(target=self._poll_loop, name="p2p-poll", daemon=True)
        self.poller.start()

    def stop(self):
        self._stop.set()
        if self.ws:
            self.ws.stop()

    def _poll_loop(self):
        time.sleep(3)
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception as exc:
                self.log(f"p2pquake poll error: {exc!r}")
            self._stop.wait(30)

    def poll_once(self):
        for code in (556, 551, 552):
            url = REST.format(codes=code, limit=10)
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as resp:
                items = json.loads(resp.read().decode("utf-8"))
            for item in items:
                self.handle(item)

    # -- transport -------------------------------------------------------
    def _on_ws(self, kind, payload):
        if kind == "binary":
            return
        try:
            msg = json.loads(payload.decode("utf-8"))
        except Exception:
            return
        self.connected = True
        self.last_message = time.time()
        self.handle(msg)

    def handle(self, msg):
        code = msg.get("code")
        uid = str(msg.get("id") or msg.get("time") or "")
        stamp = time.time()
        if uid:
            if uid in self.seen and stamp - self.seen[uid] < 300:
                return
            self.seen[uid] = stamp
            if len(self.seen) > 4000:
                cutoff = stamp - 1800
                self.seen = {k: v for k, v in self.seen.items() if v > cutoff}
        self.received += 1
        try:
            if code == 551:
                self._quake(msg)
            elif code == 556:
                self._eew(msg)
            elif code == 552:
                self._tsunami(msg)
        except Exception as exc:
            self.log(f"p2pquake parse error ({code}): {exc!r}")

    # -- payloads --------------------------------------------------------
    def _quake(self, msg):
        eq = msg.get("earthquake") or {}
        hypo = eq.get("hypocenter") or {}
        issue = msg.get("issue") or {}
        points = []
        pref_max = {}
        for pt in msg.get("points") or []:
            value = scale.code_to_value(pt.get("scale"))
            if value is None:
                continue
            pref = pt.get("pref") or ""
            points.append(
                {
                    "pref": pref,
                    "addr": pt.get("addr"),
                    "scale": value,
                    "label": scale.label(value),
                    "area": bool(pt.get("isArea")),
                }
            )
            if value >= pref_max.get(pref, -1):
                pref_max[pref] = value
        data = {
            "origin": parse_jst(eq.get("time")),
            "lat": hypo.get("latitude"),
            "lon": hypo.get("longitude"),
            "depth": hypo.get("depth"),
            "mag": hypo.get("magnitude"),
            "place": hypo.get("name"),
            "maxi": scale.code_to_value(eq.get("maxScale")),
            "points": points,
            "pref_max": pref_max,
            "tsunami": eq.get("domesticTsunami"),
            "comment": (msg.get("comments") or {}).get("freeFormComment"),
            "issue": {
                "time": parse_jst(issue.get("time")),
                "type": issue.get("type"),
                "correct": issue.get("correct"),
                "source": issue.get("source"),
            },
            "raw_id": msg.get("id"),
            "received": time.time(),
        }
        if data["origin"]:
            self.book.ingest_quake("p2pquake", data)

    def _eew(self, msg):
        eq = msg.get("earthquake") or {}
        hypo = eq.get("hypocenter") or {}
        issue = msg.get("issue") or {}
        areas = []
        maxi = None
        for area in msg.get("areas") or []:
            lo = scale.code_to_value(area.get("scaleFrom"))
            hi = scale.code_to_value(area.get("scaleTo"))
            if hi is not None and (maxi is None or hi > maxi):
                maxi = hi
            areas.append(
                {
                    "pref": area.get("pref"),
                    "name": area.get("name"),
                    "from": lo,
                    "to": hi,
                    "arrival": parse_jst(area.get("arrivalTime")),
                    "kind": area.get("kindCode"),
                }
            )
        data = {
            "event_id": issue.get("eventId"),
            "serial": issue.get("serial") or 1,
            "report": parse_jst(issue.get("time")) or int(time.time()),
            "origin": parse_jst(eq.get("originTime")),
            "lat": hypo.get("latitude"),
            "lon": hypo.get("longitude"),
            "depth": hypo.get("depth"),
            "mag": hypo.get("magnitude"),
            "place": hypo.get("name"),
            "maxi": maxi if maxi is not None else scale.code_to_value(eq.get("maxScale")),
            "areas": areas,
            "cancelled": bool(msg.get("cancelled")),
            "final": False,
            "urgent": True,
        }
        self.last_eew = time.time()
        self.book.ingest_eew("p2pquake", data)

    def _tsunami(self, msg):
        areas = []
        for area in msg.get("areas") or []:
            areas.append(
                {
                    "name": area.get("name"),
                    "grade": area.get("grade"),
                    "immediate": area.get("immediate"),
                    "first": area.get("firstHeight"),
                    "max": area.get("maxHeight"),
                }
            )
        data = {
            "key": f"t-{msg.get('id') or msg.get('time')}",
            "time": parse_jst(msg.get("time")),
            "cancelled": bool(msg.get("cancelled")),
            "areas": areas,
            "issue": msg.get("issue"),
        }
        self.book.ingest_tsunami("p2pquake", data)

    # -- status ----------------------------------------------------------
    def status(self):
        age = time.time() - self.last_message if self.last_message else None
        return {
            "connected": bool(self.ws and self.ws.connected),
            "age": round(age, 1) if age is not None else None,
            "received": self.received,
            "last_eew": self.last_eew,
        }
