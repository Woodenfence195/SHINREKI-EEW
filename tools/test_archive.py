# -*- coding: utf-8 -*-
"""Exercise the tiered archive: write 3 days of frames, compact, replay."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from app.store import NODATA, PIXELS, Store


def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_test_archive.db")
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(path + suffix)
        except OSError:
            pass
    store = Store(path)
    now = int(time.time())
    start = now - 9000          # 2.5 hours of 2 s frames
    rng = np.random.default_rng(7)
    frames = 0
    t = start
    while t < now - 120:
        arr = np.full(PIXELS, NODATA, dtype=np.uint8)
        idx = rng.choice(PIXELS, 2000, replace=False)
        arr[idx] = rng.integers(0, 70, size=2000).astype(np.uint8)
        store.append_frame(t, arr, int(rng.integers(0, 70)), force_key=(frames % 300 == 0))
        frames += 1
        t += 2
    print("wrote", frames, "frames", store.frame_span())
    before = store.frame_span()["count"]
    removed = store.compact(live_hours=1, middle_days=7, retention_days=30)
    after = store.frame_span()
    print("compact processed", removed, "rows; now", after)
    assert after["count"] < before * 0.6, after
    # replay correctness: sample frames around the middle and the newest
    for ts in (start + 3600, now - 3600, now - 130):
        got, arr = store.get_frame(ts)
        assert arr is not None and got, ts
        live = arr[arr != NODATA]
        assert live.size > 0, ts
    samples = list(store.iter_frames(now - 7200, now - 130, 60))
    print("iter_frames produced", len(samples), "samples")
    assert len(samples) > 50
    print("size", store.size(), "bytes")
    store.close()
    print("OK")


if __name__ == "__main__":
    main()
