"""Tiny HTTP server: static UI, JSON API and an SSE live stream."""
from __future__ import annotations

import gzip
import json
import mimetypes
import os
import posixpath
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import WEB_DIR

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Shinreki/0.1"

    # quiet the default stderr noise
    def log_message(self, fmt, *args):
        app = getattr(self.server, "app", None)
        if app:
            app.log(f"http {self.address_string()} {fmt % args}")

    # -- helpers ---------------------------------------------------------
    def _send(self, code, body=b"", ctype="application/octet-stream", extra=None, gz=False):
        if isinstance(body, str):
            body = body.encode("utf-8")
        headers = {"Content-Type": ctype, "Cache-Control": "no-store"}
        if gz and len(body) > 512:
            body = gzip.compress(body, 6)
            headers["Content-Encoding"] = "gzip"
        headers["Content-Length"] = str(len(body))
        if extra:
            headers.update(extra)
        self.send_response(code)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, obj, code=200, gz=True):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)
        self._send(code, body, "application/json; charset=utf-8", gz=gz)

    def _error(self, code, message):
        self._json({"error": message}, code=code, gz=False)

    # -- routing ---------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        app = self.server.app
        try:
            if path == "/api/state":
                return self._json(app.state())
            if path == "/api/stream":
                return self._stream(app)
            if path == "/api/raster":
                ts = int(query.get("ts", ["0"])[0]) or None
                got, raw = app.raster(ts)
                if raw is None:
                    return self._error(404, "no frame")
                return self._send(200, raw, "application/octet-stream",
                                  extra={"X-Frame-Ts": str(got)}, gz=True)
            if path == "/api/frame":
                ts = int(query.get("ts", ["0"])[0]) or None
                floor = int(query.get("floor", ["0"])[0])
                frame = app.sparse_frame(ts, floor)
                if frame is None:
                    return self._error(404, "no frame")
                return self._json(frame)
            if path == "/api/frames":
                start = float(query.get("from", ["0"])[0])
                end = float(query.get("to", [str(time.time())])[0])
                step = float(query.get("step", ["1"])[0])
                step = max(0.2, min(120.0, step))
                if end - start > 86400 * 31:
                    start = end - 86400 * 31
                payload, count = app.frames_binary(start, end, step)
                return self._send(
                    200, payload, "application/octet-stream",
                    extra={"X-Frame-Count": str(count)}, gz=True,
                )
            if path == "/api/events":
                start = float(query.get("from", ["0"])[0])
                end = float(query.get("to", [str(time.time())])[0])
                limit = int(query.get("limit", ["200"])[0])
                return self._json(app.events(start, end, limit))
            if path.startswith("/api/event/"):
                key = urllib.parse.unquote(path[len("/api/event/"):])
                ev = app.event_detail(key)
                if ev is None:
                    return self._error(404, "unknown event")
                return self._json(ev)
            if path == "/api/eews":
                start = float(query.get("from", ["0"])[0])
                end = float(query.get("to", [str(time.time())])[0])
                return self._json(app.store.eews_between(start, end, 300))
            if path == "/api/stats":
                days = int(query.get("days", ["30"])[0])
                return self._json(app.stats(days))
            if path == "/api/heat":
                start = float(query.get("from", ["0"])[0])
                end = float(query.get("to", [str(time.time())])[0])
                return self._json(app.heat(start, end))
            if path == "/api/timeline":
                start = float(query.get("from", [str(time.time() - 86400)])[0])
                end = float(query.get("to", [str(time.time())])[0])
                return self._json(app.timeline(start, end))
            if path == "/api/longperiod":
                start = float(query.get("from", ["0"])[0])
                end = float(query.get("to", [str(time.time())])[0])
                return self._json(app.store.longperiod_between(start, end, 100))
            if path == "/api/search":
                q = query.get("q", [""])[0]
                mini = int(float(query.get("min", ["0"])[0]) * 10)
                return self._json(app.store.search_events(q, mini, 200))
            if path == "/api/logs":
                return self._json({"log": app.log.buffer[-200:]})
            if path == "/health":
                return self._json({"ok": True, "uptime": int(time.time() - app.started)})
            return self._static(path)
        except BrokenPipeError:
            return
        except Exception:
            app.log("http error: " + traceback.format_exc(limit=3))
            try:
                self._error(500, "internal error")
            except Exception:
                pass

    def do_POST(self):
        app = self.server.app
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._error(400, "bad json")
        try:
            if parsed.path == "/api/settings":
                return self._json({"ok": True, "settings": app.set_settings(body)})
            if parsed.path == "/api/compact":
                removed = app.store.compact(
                    live_hours=app.config.get("live_hours", 24), middle_days=7,
                    retention_days=app.config.get("retention_days", 30), force=True,
                )
                return self._json({"ok": True, "removed": removed})
            if parsed.path == "/api/demo":
                from .demo import seed_demo
                info = seed_demo(app, hours=body.get("hours", 6))
                return self._json({"ok": True, "info": info})
            if parsed.path == "/api/demo/eew":
                eew = app.demo_eew(body or {})
                return self._json({"ok": True, "eew": eew})
            if parsed.path == "/api/demo/eew/double":
                eews = app.demo_double((body or {}).get("delay", 2))
                return self._json({"ok": True, "eews": eews})
            if parsed.path == "/api/demo/eew/end":
                ended = app.end_demo_eew()
                return self._json({"ok": True, "ended": ended})
            if parsed.path == "/api/clear":
                target = (body or {}).get("target", "all")
                if target not in ("all", "frames", "events"):
                    return self._error(400, "bad target")
                app.clear_history(target)
                return self._json({"ok": True, "target": target})
            return self._error(404, "unknown endpoint")
        except Exception:
            app.log("POST error: " + traceback.format_exc(limit=3))
            return self._error(500, "internal error")

    # -- static ----------------------------------------------------------
    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        safe = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        if safe.startswith(".."):
            return self._error(403, "forbidden")
        full = os.path.join(WEB_DIR, *safe.split("/"))
        if not os.path.isfile(full):
            return self._error(404, "not found")
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as fh:
            body = fh.read()
        ctype = MIME.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        cache = "public, max-age=3600" if ext in (".png", ".svg", ".woff2") else "no-store"
        return self._send(200, body, ctype, extra={"Cache-Control": cache})

    # -- SSE -------------------------------------------------------------
    def _stream(self, app):
        client = app.hub.register()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            hello = json.dumps({"state": app.state()}, ensure_ascii=False)
            self.wfile.write(f"event: hello\ndata: {hello}\n\n".encode("utf-8"))
            self.wfile.flush()
            last_ping = time.time()
            while True:
                try:
                    name, data = client.q.get(timeout=10)
                except Exception:
                    if time.time() - last_ping > 12:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = time.time()
                    continue
                if name is None:
                    break
                self.wfile.write(f"event: {name}\ndata: {data}\n\n".encode("utf-8"))
                self.wfile.flush()
                last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            app.hub.unregister(client)


def serve(app, host="127.0.0.1", port=8787):
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.app = app
    return httpd
