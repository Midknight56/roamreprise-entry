"""Copies the browser builds of Bryntum Scheduler (trial) and three.js from node_modules into public/vendor/
(ignored by git), so the Worker serves them and the repo never carries vendor files.
Run by `python dev/cf.py deploy` and `python dev/cf.py dev` before wrangler starts.

Usage: python dev/vendor.py
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "vendor")


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    copied = 0
    bry = os.path.join(ROOT, "node_modules", "@bryntum", "scheduler-trial")
    if os.path.isdir(bry):
        dst = os.path.join(OUT, "bryntum", "scheduler")
        os.makedirs(dst)
        for name in ("scheduler.module.js", "scheduler.css", "svalbard-light.css"):
            shutil.copy2(os.path.join(bry, name), dst)
            copied += 1
        for folder in ("fonts", "fontawesome"):
            shutil.copytree(os.path.join(bry, folder), os.path.join(dst, folder))
            copied += 1
    else:
        print("vendor: @bryntum/scheduler-trial is not installed; the page falls back to the basic timeline")
    three = os.path.join(ROOT, "node_modules", "three", "build")
    dst = os.path.join(OUT, "three")
    os.makedirs(dst)
    for name in ("three.module.js", "three.core.js"):
        shutil.copy2(os.path.join(three, name), dst)
        copied += 1
    print(f"vendor: {copied} items in {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
