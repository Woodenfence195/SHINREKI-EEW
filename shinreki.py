"""PyInstaller / source entry point for Shinreki."""
from __future__ import annotations

import os
import sys

if __name__ == "__main__":
    # windowed builds have no stdio; keep logging code safe
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    from app.__main__ import main

    sys.exit(main())
