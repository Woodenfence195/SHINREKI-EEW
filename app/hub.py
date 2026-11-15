"""Fan-out of live events to Server-Sent-Events clients."""
from __future__ import annotations

import json
import queue
import threading
import time


class Client:
    def __init__(self):
        self.q = queue.Queue(maxsize=512)
        self.closed = False

    def put(self, name, data):
        if self.closed:
            return
        try:
            self.q.put_nowait((name, data))
        except queue.Full:
            # drop the oldest payload, keep the stream alive
            try:
                self.q.get_nowait()
            except queue.Empty:
                pass
            try:
                self.q.put_nowait((name, data))
            except queue.Full:
                pass

    def close(self):
        self.closed = True
        try:
            self.q.put_nowait((None, None))
        except queue.Full:
            pass


class Hub:
    def __init__(self, logger=None):
        self.clients = set()
        self.lock = threading.Lock()
        self.log = logger or (lambda *a, **k: None)
        self.last = {}

    def register(self):
        c = Client()
        with self.lock:
            self.clients.add(c)
        return c

    def unregister(self, c):
        with self.lock:
            self.clients.discard(c)
        c.close()

    def broadcast(self, name, data):
        if name in ("state", "frame"):
            self.last[name] = data
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if not isinstance(data, str) else data
        with self.lock:
            clients = list(self.clients)
        for c in clients:
            c.put(name, payload)

    def count(self):
        with self.lock:
            return len(self.clients)
