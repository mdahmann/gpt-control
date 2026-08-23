#!/usr/bin/env python3
"""Validate the npm/plugin publish boundary without running package scripts."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile


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
    if package.get("filename") != "gpt-control-0.5.0-alpha.4.tgz":
        raise SystemExit(f"unexpected package filename: {package.get('filename')}")
    paths = {entry["path"] for entry in package.get("files", [])}
    required = {
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "THIRD_PARTY_NOTICES.md",
        "bin/gpt-control-mcp",
		"bin/gpt-control-desktop-driver",
		"bin/gpt-control-desktop-driver.js",
		"dist/gpt-control-desktop-driver.js",
		"bin/gpt-control-desktop-pool-driver",
		"bin/gpt-control-desktop-pool-driver.js",
		"dist/gpt-control-desktop-pool-driver.js",
        "dist/gpt-control-mcp.js",
		"docs/CHATGPT_DESKTOP_CDP.md",
		"scripts/desktop-cdp-live-smoke.mjs",
		"scripts/chatgpt-desktop-doctor.mjs",
		"scripts/chatgpt-desktop-launch.mjs",
		"scripts/chatgpt-desktop-acceptance.mjs",
        "scripts/mcp-stdio-smoke.py",
        "scripts/verify-security.sh",
        "src/mcp.ts",
		"src/desktop-cdp-macos.ts",
		"src/desktop-driver-cli.ts",
		"src/desktop-driver.ts",
		"src/desktop-pool-driver-cli.ts",
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

    with tempfile.TemporaryDirectory(prefix="gpt-control-package-") as temp:
        packed = subprocess.run(
            ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", temp],
            check=True,
            capture_output=True,
            text=True,
        )
        packed_payload = json.loads(packed.stdout)
        tarball = Path(temp, packed_payload[0]["filename"])
        install = Path(temp, "install")
        install.mkdir(mode=0o700)
        subprocess.run(
            ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", str(tarball)],
            cwd=install,
            check=True,
            capture_output=True,
            text=True,
        )
        desktop_bin = install / "node_modules" / ".bin" / "gpt-control-desktop-driver"
        pool_bin = install / "node_modules" / ".bin" / "gpt-control-desktop-pool-driver"
        mcp_bin = install / "node_modules" / ".bin" / "gpt-control-mcp"
        if not desktop_bin.exists() or not pool_bin.exists() or not mcp_bin.exists():
            raise SystemExit("clean package install did not expose all three executables")
        invalid = subprocess.run(
            [str(desktop_bin)],
            input="not-json\n",
            cwd=install,
            capture_output=True,
            text=True,
            check=False,
        )
        envelope = json.loads(invalid.stdout)
        if invalid.returncode != 0 or envelope.get("ok") is not False or envelope.get("version") != 2:
            raise SystemExit(f"installed desktop protocol error contract failed: rc={invalid.returncode}, envelope={envelope!r}")
        null_request = subprocess.run(
            [str(desktop_bin)],
            input="null\n",
            cwd=install,
            capture_output=True,
            text=True,
            check=False,
        )
        null_envelope = json.loads(null_request.stdout)
        if null_request.returncode != 0 or null_envelope.get("ok") is not False or null_envelope.get("version") != 2:
            raise SystemExit(f"installed desktop non-object request contract failed: rc={null_request.returncode}, envelope={null_envelope!r}")
        pool_invalid = subprocess.run(
            [str(pool_bin)],
            input="not-json\n",
            cwd=install,
            capture_output=True,
            text=True,
            check=False,
        )
        pool_envelope = json.loads(pool_invalid.stdout)
        if pool_invalid.returncode != 0 or pool_envelope.get("ok") is not False or pool_envelope.get("version") != 2:
            raise SystemExit(f"installed pool protocol error contract failed: rc={pool_invalid.returncode}, envelope={pool_envelope!r}")
    print(json.dumps({
        "filename": package["filename"],
        "packageSize": package.get("size"),
        "unpackedSize": unpacked,
        "fileCount": len(paths),
        "nodeModulesPresent": False,
        "requiredFilesPresent": True,
        "cleanInstallExecutablesPresent": True,
        "desktopErrorEnvelopeExitZero": True,
        "desktopNonObjectEnvelopeExitZero": True,
        "desktopPoolErrorEnvelopeExitZero": True,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
