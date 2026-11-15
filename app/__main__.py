"""Command line entry point: python -m app"""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser

from .config import Config, DATA_DIR, FROZEN
from .server import serve
from .state import App


def free_port(host, start):
    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit("no free port")


def open_app_window(url):
    """Chromium app window when available, otherwise the default browser."""
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
        os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
        os.path.join(local, r"Google\Chrome\Application\chrome.exe"),
    ]
    for exe in candidates:
        if os.path.exists(exe):
            try:
                subprocess.Popen([exe, f"--app={url}", "--window-size=1520,940"])
                return True
            except OSError:
                continue
    webbrowser.open(url)
    return False


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream is not None:
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Shinreki earthquake monitor")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--host", default=None)
    parser.add_argument("--open", action="store_true", help="open the UI in the default browser")
    parser.add_argument("--app-window", action="store_true", help="open the UI as a desktop app window")
    parser.add_argument("--demo", action="store_true", help="seed a demo history before starting")
    parser.add_argument("--no-sources", action="store_true", help="do not contact the network")
    args = parser.parse_args(argv)
    if FROZEN and len(sys.argv) == 1:
        args.app_window = True

    config = Config()
    if args.no_sources:
        config.data["sources"] = {"kmoni": False, "p2pquake": False, "jma": False}
    host = args.host or config.get("host", "127.0.0.1")
    port = args.port or free_port(host, int(config.get("port", 8787)))
    config.data["port"] = port
    config.save()

    app = App(config)
    if args.demo:
        from .demo import seed_demo

        seed_demo(app, hours=8)
    app.start()

    httpd = serve(app, host, port)
    url = f"http://{host}:{port}/"
    print(f"\n  Shinreki / 震歴  ·  {url}\n  data: {DATA_DIR}\n", flush=True)
    if args.app_window:
        threading.Thread(target=lambda: (time.sleep(0.8), open_app_window(url)), daemon=True).start()
    elif args.open:
        threading.Thread(target=lambda: (time.sleep(0.6), webbrowser.open(url)), daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        app.stop()
        httpd.server_close()


if __name__ == "__main__":
    sys.exit(main())
