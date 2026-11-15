"""JMA 防災情報XML feed (eqvol): detailed 震源・震度情報 with station lists."""
from __future__ import annotations

import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET

from . import scale
from .events import parse_iso

FEEDS = (
    "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml",
    "https://www.data.jma.go.jp/developer/xml/feed/extra.xml",
)
UA = "Shinreki/0.2 (+local desktop app)"
KEEP = 40


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _text(elem, *path):
    node = elem
    for name in path:
        if node is None:
            return None
        found = None
        for child in list(node):
            if _local(child.tag) == name:
                found = child
                break
        node = found
    return node.text.strip() if node is not None and node.text else None


def _find(elem, *path):
    node = elem
    for name in path:
        if node is None:
            return None
        found = None
        for child in list(node):
            if _local(child.tag) == name:
                found = child
                break
        node = found
    return node


def _children(elem, name):
    if elem is None:
        return []
    return [c for c in list(elem) if _local(c.tag) == name]


def parse_coordinate(text):
    if not text:
        return None, None, None
    m = re.search(r"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?", text)
    if not m:
        return None, None, None
    lat = float(m.group(1))
    lon = float(m.group(2))
    depth = None
    if m.group(3):
        depth = abs(float(m.group(3))) / 1000.0
    return lat, lon, depth


class JmaXmlSource:
    def __init__(self, book, store, hub, config, logger):
        self.book = book
        self.store = store
        self.hub = hub
        self.config = config
        self.log = logger
        self._stop = threading.Event()
        self.thread = None
        self.seen = {}
        self.last_ok = 0.0
        self.last_error = None
        self.parsed = 0

    def start(self):
        self.thread = threading.Thread(target=self._run, name="jma-xml", daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        time.sleep(2)
        while not self._stop.is_set():
            try:
                self.poll_once()
                self.last_ok = time.time()
                self.last_error = None
            except Exception as exc:
                self.last_error = repr(exc)
                self.log(f"jmaxml: {exc!r}")
            self._stop.wait(45)

    def poll_once(self):
        entries = []
        for feed in FEEDS:
            try:
                req = urllib.request.Request(feed, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=25) as resp:
                    text = resp.read().decode("utf-8", "replace")
                entries.extend(re.findall(r"<entry>(.*?)</entry>", text, re.S))
            except Exception as exc:
                self.log(f"jmaxml feed {feed}: {exc!r}")
        new = []
        for raw in entries:
            m_id = re.search(r"<id>(.*?)</id>", raw, re.S)
            m_title = re.search(r"<title>(.*?)</title>", raw, re.S)
            if not m_id:
                continue
            url = m_id.group(1).strip()
            title = (m_title.group(1) if m_title else "").strip()
            relevant = any(k in title for k in ("震源", "震度", "地震", "長周期"))
            if not relevant:
                continue
            if url in self.seen and time.time() - self.seen[url] < 7200:
                continue
            new.append(url)
        for url in new[-KEEP:]:
            try:
                self._fetch_report(url)
                self.seen[url] = time.time()
            except Exception as exc:
                self.log(f"jmaxml report error {url}: {exc!r}")
        if len(self.seen) > 500:
            cutoff = time.time() - 7200
            self.seen = {k: v for k, v in self.seen.items() if v > cutoff}

    def _fetch_report(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=25) as resp:
            body = resp.read().decode("utf-8", "replace")
        root = ET.fromstring(body)
        title = _text(root, "Control", "Title") or ""
        if "長周期" in title:
            self._parse_longperiod(root, title, url)
        elif "震源" in title or "震度" in title:
            self._parse_quake(root, title, url)

    def _parse_quake(self, root, title, url):
        head = _find(root, "Head")
        body = _find(root, "Body")
        if body is None:
            return
        event_id = _text(head, "EventID")
        report_time = parse_iso(_text(head, "ReportDateTime")) or int(time.time())
        eq = _find(body, "Earthquake")
        origin = parse_iso(_text(eq, "OriginTime")) if eq is not None else None
        hypo = _find(eq, "Hypocenter")
        place = _text(hypo, "Area", "Name")
        coord = _text(hypo, "Area", "Coordinate")
        lat, lon, depth = parse_coordinate(coord)
        mag_text = _text(eq, "Magnitude")
        try:
            mag = float(mag_text) if mag_text else None
        except ValueError:
            mag = None
        if origin is None:
            origin = report_time

        points = []
        pref_max = {}
        intensity = _find(body, "Intensity", "Observation")
        maxi = None
        if intensity is not None:
            try:
                maxi = scale.xml_int_to_value(_text(intensity, "MaxInt"))
            except Exception:
                maxi = None
            for pref in _children(intensity, "Pref"):
                pref_name = _text(pref, "Name") or ""
                pref_i = scale.xml_int_to_value(_text(pref, "MaxInt"))
                if pref_i is not None:
                    pref_max[pref_name] = pref_i
                for area in _children(pref, "Area"):
                    area_name = _text(area, "Name") or ""
                    for city in _children(area, "City"):
                        city_name = _text(city, "Name") or ""
                        for st in _children(city, "IntensityStation"):
                            value = scale.xml_int_to_value(_text(st, "Int"))
                            if value is None:
                                continue
                            points.append(
                                {
                                    "pref": pref_name,
                                    "addr": _text(st, "Name"),
                                    "city": city_name,
                                    "area": area_name,
                                    "scale": value,
                                    "label": scale.label(value),
                                }
                            )
        tsunami = None
        comments = _find(body, "Comments")
        comment_text = ""
        if comments is not None:
            for child in list(comments):
                text = _text(child, "Text")
                if text:
                    comment_text += text + " "
        if "津波" in comment_text:
            tsunami = "None" if ("心配はありません" in comment_text or "心配ありません" in comment_text) else "Watch"

        data = {
            "origin": origin,
            "lat": lat,
            "lon": lon,
            "depth": depth,
            "mag": mag,
            "place": place,
            "maxi": maxi,
            "points": points,
            "pref_max": pref_max,
            "tsunami": tsunami,
            "comment": comment_text.strip(),
            "report": report_time,
            "event_id": event_id,
            "title": title,
            "url": url,
        }
        self.parsed += 1
        self.book.ingest_quake("jma-xml", data)

    def _parse_longperiod(self, root, title, url):
        """長周期地震動階級 (VXSE61/62) — tolerant parser."""
        head = _find(root, "Head")
        body = _find(root, "Body")
        if body is None:
            return
        event_id = _text(head, "EventID")
        report_time = parse_iso(_text(head, "ReportDateTime")) or int(time.time())
        eq = _find(body, "Earthquake")
        origin = parse_iso(_text(eq, "OriginTime")) if eq is not None else None
        hypo = _find(eq, "Hypocenter")
        lat, lon, depth = parse_coordinate(_text(hypo, "Area", "Coordinate"))
        mag_text = _text(eq, "Magnitude")
        try:
            mag = float(mag_text) if mag_text else None
        except ValueError:
            mag = None
        areas = []
        maxi = None
        observation = _find(body, "Intensity", "Observation")
        pref_blocks = _children(observation, "Pref") if observation is not None else []
        for pref in pref_blocks:
            pref_name = _text(pref, "Name") or ""
            pref_cls = scale.xml_int_to_value(_text(pref, "MaxInt"))
            for area in _children(pref, "Area"):
                cls = scale.xml_int_to_value(_text(area, "MaxInt"))
                if cls is None:
                    cls = scale.xml_int_to_value(_text(area, "Int"))
                if cls is None:
                    cls = scale.xml_int_to_value(_text(area, "Class"))
                if cls is None:
                    continue
                areas.append({"pref": pref_name, "name": _text(area, "Name") or "", "cls": cls})
                maxi = cls if maxi is None else max(maxi, cls)
            if pref_cls is not None:
                maxi = pref_cls if maxi is None else max(maxi, pref_cls)
        # station-level reports (VXSE62) carry Int per station
        if observation is not None:
            for pref in pref_blocks:
                pref_name = _text(pref, "Name") or ""
                for area in _children(pref, "Area"):
                    for city in _children(area, "City"):
                        for st in _children(city, "IntensityStation"):
                            cls = scale.xml_int_to_value(_text(st, "Int"))
                            if cls is None:
                                continue
                            areas.append(
                                {"pref": pref_name, "name": _text(st, "Name") or "", "cls": cls,
                                 "station": True, "city": _text(city, "Name") or ""}
                            )
                            maxi = cls if maxi is None else max(maxi, cls)
        if not areas:
            return
        lp = {
            "key": f"lp-{event_id or int(report_time)}",
            "kind": "longperiod",
            "time": origin or report_time,
            "report": report_time,
            "event_id": event_id,
            "lat": lat,
            "lon": lon,
            "depth": depth,
            "mag": mag,
            "maxi": maxi,
            "maxi_label": scale.label(maxi),
            "areas": areas,
            "title": title,
            "url": url,
            "source": "jma-xml",
        }
        self.store.put_longperiod(lp)
        self.hub.broadcast("longperiod", lp)
        self.log(f"jmaxml long-period: {lp['key']} class {maxi}")

    def status(self):
        return {
            "ok": bool(self.last_ok and time.time() - self.last_ok < 180),
            "age": round(time.time() - self.last_ok, 1) if self.last_ok else None,
            "error": self.last_error,
            "parsed": self.parsed,
        }
