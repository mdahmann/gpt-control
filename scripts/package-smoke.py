#!/usr/bin/env python3
"""Validate the npm/plugin publish boundary without running package scripts."""
from __future__ import annotations

import json
import subprocess


def main() -> int:
    completed = subprocess.run(
        ["npm", "pack", "--dry-run", "--ignore-scripts", "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    if not isinstance(payload, list) or len(payload) != 1:
        raise SystemExit(f"unexpected npm pack payload: {payload!r}")
    package = payload[0]
    if package.get("filename") != "gpt-control-0.4.2.tgz":
        raise SystemExit(f"unexpected package filename: {package.get('filename')}")
    paths = {entry["path"] for entry in package.get("files", [])}
    required = {
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "THIRD_PARTY_NOTICES.md",
        "bin/gpt-control-mcp",
        "dist/gpt-control-mcp.js",
        "scripts/mcp-stdio-smoke.py",
        "scripts/verify-security.sh",
        "src/mcp.ts",
    }
    missing = required - paths
    if missing:
        raise SystemExit(f"required package files are missing: {sorted(missing)}")
    forbidden = sorted(
        path
        for path in paths
        if "node_modules" in path
        or "__pycache__" in path
        or path.endswith(".pyc")
        or path.startswith(".git")
        or path.endswith(".test.ts")
    )
    if forbidden:
        raise SystemExit(f"forbidden package files are present: {forbidden}")
    unpacked = int(package.get("unpackedSize", 0))
    if unpacked <= 0 or unpacked > 5 * 1024 * 1024:
        raise SystemExit(f"unexpected unpacked package size: {unpacked}")
    print(json.dumps({
        "filename": package["filename"],
        "packageSize": package.get("size"),
        "unpackedSize": unpacked,
        "fileCount": len(paths),
        "nodeModulesPresent": False,
        "requiredFilesPresent": True,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
