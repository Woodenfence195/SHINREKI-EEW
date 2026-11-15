"""A tiny RFC 6455 WebSocket client built on the standard library.

Only what Shinreki needs: client handshake, text/binary messages, ping/pong,
close.  Keeping this in-tree means the app runs on a bare Python install with
no third party packages.
"""
from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import threading
import time
from urllib.parse import urlsplit

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketError(Exception):
    pass


class WebSocket:
    def __init__(self, url, headers=None, timeout=20.0):
        self.url = url
        self.headers = headers or {}
        self.timeout = timeout
        self.sock = None
        self._lock = threading.Lock()
        self.closed = False

    # -- low level -------------------------------------------------------
    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise WebSocketError("connection closed")
            buf += chunk
        return buf

    def _send_frame(self, opcode, payload):
        if self.closed or self.sock is None:
            raise WebSocketError("socket closed")
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._lock:
            self.sock.sendall(bytes(header) + masked)

    def _read_frame(self):
        b1, b2 = self._read_exact(2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        if masked:
            mask = self._read_exact(4)
            data = self._read_exact(length)
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        else:
            data = self._read_exact(length)
        return fin, opcode, data

    # -- public ----------------------------------------------------------
    def connect(self):
        parts = urlsplit(self.url)
        host = parts.hostname
        port = parts.port or (443 if parts.scheme == "wss" else 80)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        raw = socket.create_connection((host, port), timeout=self.timeout)
        if parts.scheme == "wss":
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=host)
        self.sock = raw
        self.sock.settimeout(None)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        for k, v in self.headers.items():
            lines.append(f"{k}: {v}")
        request = "\r\n".join(lines) + "\r\n\r\n"
        raw.sendall(request.encode())
        # read handshake response
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = raw.recv(4096)
            if not chunk:
                raise WebSocketError("handshake closed")
            response += chunk
        head, _, rest = response.partition(b"\r\n\r\n")
        status = head.split(b"\r\n")[0]
        if b"101" not in status:
            raise WebSocketError("handshake failed: " + status.decode(errors="replace"))
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if accept.encode() not in head:
            raise WebSocketError("bad accept header")
        if rest:
            # extremely unlikely for our servers; keep it simple
            self._buffer = rest
        else:
            self._buffer = b""
        return self

    def send_text(self, text):
        self._send_frame(0x1, text.encode("utf-8"))

    def send_json(self, obj):
        import json

        self.send_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))

    def recv(self):
        """Return ('text'|'binary', data) or None on close."""
        fragments = b""
        frag_opcode = None
        while True:
            fin, opcode, data = self._read_frame()
            if opcode == 0x8:  # close
                self.close()
                return None
            if opcode == 0x9:  # ping
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2):
                fragments = data
                frag_opcode = opcode
                if fin:
                    return ("text" if opcode == 0x1 else "binary", fragments)
            elif opcode == 0x0:
                fragments += data
                if fin:
                    return ("text" if frag_opcode == 0x1 else "binary", fragments)
            else:
                raise WebSocketError(f"unknown opcode {opcode}")

    def ping(self):
        self._send_frame(0x9, b"shinreki")

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


class ReconnectingSocket:
    """Keeps a WebSocket alive and feeds decoded messages to a callback."""

    def __init__(self, url, on_message, headers=None, name="ws", logger=None):
        self.url = url
        self.on_message = on_message
        self.headers = headers or {}
        self.name = name
        self.log = logger or (lambda *a, **k: None)
        self._stop = threading.Event()
        self._thread = None
        self.connected = False
        self.last_message = 0.0
        self.attempts = 0

    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"ws-{self.name}", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        delay = 1.0
        while not self._stop.is_set():
            ws = None
            try:
                ws = WebSocket(self.url, headers=self.headers, timeout=20)
                ws.connect()
                self.connected = True
                self.attempts = 0
                delay = 1.0
                self.log(f"{self.name}: connected")
                # heartbeat pings
                def pinger():
                    while self.connected and not self._stop.is_set():
                        time.sleep(25)
                        try:
                            ws.ping()
                        except Exception:
                            return

                threading.Thread(target=pinger, daemon=True).start()
                while not self._stop.is_set():
                    msg = ws.recv()
                    if msg is None:
                        break
                    self.last_message = time.time()
                    kind, payload = msg
                    try:
                        self.on_message(kind, payload)
                    except Exception as exc:  # never let a handler kill the loop
                        self.log(f"{self.name}: handler error {exc!r}")
            except Exception as exc:
                self.log(f"{self.name}: {type(exc).__name__} {exc}")
            finally:
                self.connected = False
                if ws is not None:
                    ws.close()
            if self._stop.is_set():
                break
            self.attempts += 1
            time.sleep(min(delay, 30))
            delay = min(delay * 1.8, 30)
