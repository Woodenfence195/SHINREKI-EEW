"""Runtime configuration for Shinreki (source tree and PyInstaller build)."""
from __future__ import annotations

import json
import os
import sys
import threading

FROZEN = bool(getattr(sys, "frozen", False))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = getattr(sys, "_MEIPASS", ROOT)

if FROZEN:
    _base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    _default_data = os.path.join(_base, "Shinreki")
else:
    _default_data = os.path.join(ROOT, "data")

DATA_DIR = os.environ.get("SHINREKI_DATA") or _default_data
WEB_DIR = os.path.join(BUNDLE, "web")
ASSETS_DIR = os.path.join(BUNDLE, "app", "assets")
if not os.path.isdir(ASSETS_DIR):
    ASSETS_DIR = os.path.join(ROOT, "app", "assets")

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8787,
    "location": {"name": "東京", "lat": 35.6812, "lon": 139.7671},
    "retention_days": 30,
    "live_hours": 24,
    "sound": True,
    "speech": False,
    "palette": "shinreki",
    "show_history_shading": True,
    "alarm_seconds": 5,
    "rotate_seconds": 5,
    "sources": {"kmoni": True, "p2pquake": True, "jma": True},
    "kmoni_fps": 1,
}


class Config:
    def __init__(self, path=None):
        self.path = path or os.path.join(DATA_DIR, "settings.json")
        self._lock = threading.Lock()
        self.data = json.loads(json.dumps(DEFAULTS))
        self.load()

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                stored = json.load(fh)
        except Exception:
            return
        with self._lock:
            for key, value in stored.items():
                if isinstance(value, dict) and isinstance(self.data.get(key), dict):
                    self.data[key].update(value)
                else:
                    self.data[key] = value

    def save(self):
        with self._lock:
            snapshot = json.loads(json.dumps(self.data))
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def get(self, key, default=None):
        with self._lock:
            return self.data.get(key, default)

    def update(self, patch):
        with self._lock:
            for key, value in patch.items():
                if key in ("retention_days", "live_hours", "port", "alarm_seconds", "rotate_seconds"):
                    try:
                        value = int(value)
                    except (TypeError, ValueError):
                        continue
                if key in ("sound", "speech", "show_history_shading"):
                    value = bool(value) if isinstance(value, bool) else value
                self.data[key] = value
            snapshot = json.loads(json.dumps(self.data))
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path + ".tmp", "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False, indent=2)
        os.replace(self.path + ".tmp", self.path)
        return snapshot
