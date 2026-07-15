#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate memory index files.

- index.json        : L2 hot index (recent daily logs, <=~5KB, auto-loaded for retrieval)
- archive/index.json: L4 cold manifest (archived logs, browsable on demand)
"""
import os, re, json, datetime

MEM_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".workbuddy", "memory"))
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")

def first_title(path):
    """Return the first real ## section heading (substantive topic) for retrieval,
    falling back to the first H1 or first non-empty line."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        for line in lines[:120]:  # scan first 120 lines for a ## topic
            s = line.strip()
            if s.startswith("## "):
                return s[3:].strip()[:50]
        for line in lines:
            s = line.strip()
            if s:
                return s.lstrip("#").strip()[:50]
    except Exception:
        pass
    return ""

def scan(folder, layer):
    out = []
    d = os.path.join(MEM_DIR, folder) if folder else MEM_DIR
    if not os.path.isdir(d):
        return out
    for fname in os.listdir(d):
        full = os.path.join(d, fname)
        if not os.path.isfile(full):
            continue
        m = DATE_RE.match(fname)
        if not m:
            continue
        out.append({"date": m.group(1), "file": (folder + "/" + fname) if folder else fname,
                    "layer": layer, "size_bytes": os.path.getsize(full), "title": first_title(full)})
    out.sort(key=lambda e: e["date"], reverse=True)
    return out

l2 = scan("", "L2")
l4 = scan("archive", "L4")

# L2 hot index: lean (drop size_bytes/layer to stay <=5KB)
l2_lean = [{"date": e["date"], "file": e["file"], "title": e["title"]} for e in l2]
idx = {"schema": "memory-index/v1",
       "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
       "count": len(l2_lean), "entries": l2_lean}
with open(os.path.join(MEM_DIR, "index.json"), "w", encoding="utf-8") as f:
    json.dump(idx, f, ensure_ascii=False, indent=2)

# L4 cold manifest
arch = {"schema": "memory-archive/v1",
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "count": len(l4), "entries": l4}
with open(os.path.join(MEM_DIR, "archive", "index.json"), "w", encoding="utf-8") as f:
    json.dump(arch, f, ensure_ascii=False, indent=2)

print(f"index.json (L2): {len(l2_lean)} entries, {os.path.getsize(os.path.join(MEM_DIR,'index.json'))} bytes")
print(f"archive/index.json (L4): {len(l4)} entries, {os.path.getsize(os.path.join(MEM_DIR,'archive','index.json'))} bytes")
