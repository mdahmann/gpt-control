#!/usr/bin/env python3
"""Dependency-free MCP stdio initialize/tools-list smoke test."""
from __future__ import annotations

import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path


def fail(message: str, process: subprocess.Popen[bytes] | None = None) -> "NoReturn":
    if process is not None:
        try:
            process.terminate()
            process.wait(timeout=2)
        except Exception:
            process.kill()
        stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
        if stderr:
            message = f"{message}\nstderr:\n{stderr[:4000]}"
    raise SystemExit(message)


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: mcp-stdio-smoke.py <gpt-control-mcp-launcher>")
    launcher = Path(sys.argv[1]).resolve()
    if not launcher.is_file():
        raise SystemExit(f"launcher not found: {launcher}")

    env = dict(os.environ)
    process = subprocess.Popen(
        [str(launcher)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    assert process.stdin is not None and process.stdout is not None
    requests = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "gpt-control-bundle-smoke", "version": "1"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    ]
    for request in requests:
        process.stdin.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
    process.stdin.flush()

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    responses: dict[int, dict] = {}
    deadline = time.monotonic() + 12
    buffer = b""
    while time.monotonic() < deadline and not {1, 2}.issubset(responses):
        if process.poll() is not None:
            fail(f"MCP bundle exited early with {process.returncode}", process)
        events = selector.select(timeout=min(0.25, deadline - time.monotonic()))
        for key, _ in events:
            chunk = os.read(key.fd, 65536)
            if not chunk:
                continue
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                message = json.loads(line)
                if isinstance(message.get("id"), int):
                    responses[message["id"]] = message

    if 1 not in responses or "result" not in responses[1]:
        fail(f"initialize response missing or failed: {responses.get(1)}", process)
    if 2 not in responses or "result" not in responses[2]:
        fail(f"tools/list response missing or failed: {responses.get(2)}", process)
    server = responses[1]["result"].get("serverInfo", {})
    if server.get("name") != "gpt-control" or server.get("version") != "0.5.0-alpha.6":
        fail(f"unexpected server identity: {server}", process)
    tools = responses[2]["result"].get("tools", [])
    names = {tool.get("name") for tool in tools}
    required = {"gpt_diagnose", "gpt_worker_run", "gpt_worker_get", "gpt_worker_cancel"}
    if not required.issubset(names):
        fail(f"required tools missing: {sorted(required - names)}", process)
    worker = next(tool for tool in tools if tool.get("name") == "gpt_worker_run")
    if worker.get("execution", {}).get("taskSupport") != "optional":
        fail(f"worker taskSupport is not optional: {worker.get('execution')}", process)

    process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=3)
    if process.returncode not in (0, -15):
        fail(f"MCP bundle exited with {process.returncode}", process)
    print(json.dumps({"server": server, "toolCount": len(tools), "requiredTools": sorted(required), "taskSupport": "optional"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
