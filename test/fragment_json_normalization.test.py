#!/usr/bin/env python3
"""Focused FI2 fragment JSON normalization/parity validation entrypoint.

The implementation tests live in fragment_package_parity.test.py; this file keeps
that focused coverage available under the deterministic validation contract name.
"""
from pathlib import Path
import runpy


if __name__ == "__main__":
    runpy.run_path(
        str(Path(__file__).with_name("fragment_package_parity.test.py")),
        run_name="__main__",
    )
