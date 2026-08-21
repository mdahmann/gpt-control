#!/usr/bin/env python3
"""Private request-file adapter for Chrome Bridge.

The ordinary chrome-bridge CLI puts form text and upload paths in argv. This
adapter imports the installed bridge client and forwards one JSON request read
from a mode-0600 temporary file, so prompts and attachment paths never enter the
process list. The request file is created and removed by GPT-Control.
"""

import importlib.util
import json
import os
import sys


def fail(message, code=2):
    print(message, file=sys.stderr)
    raise SystemExit(code)


def main():
    if len(sys.argv) != 3:
        fail("Usage: bridge_rpc.py <test_client.py> <private-request.json>")
    client_path = os.path.realpath(sys.argv[1])
    request_path = os.path.realpath(sys.argv[2])
    if not os.path.isfile(client_path):
        fail(f"Chrome Bridge client not found: {client_path}")
    if not os.path.isfile(request_path):
        fail(f"Private request file not found: {request_path}")

    sys.path.insert(0, os.path.dirname(client_path))
    spec = importlib.util.spec_from_file_location("gpt_control_chrome_bridge_client", client_path)
    if spec is None or spec.loader is None:
        fail("Could not load Chrome Bridge client module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sender = getattr(module, "send_command_data", None)
    if not callable(sender):
        fail("Chrome Bridge client does not expose send_command_data")

    with open(request_path, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    if not isinstance(request, dict):
        fail("Private request must be a JSON object")
    action = request.get("action")
    payload = request.get("payload")
    timeout = request.get("readTimeoutMs")
    if not isinstance(action, str) or not action:
        fail("Private request is missing action")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        fail("Private request payload must be a JSON object")
    if not isinstance(timeout, (int, float)):
        timeout = None

    exit_code, response, stderr = sender(action, payload, read_timeout_ms=timeout)
    if response is not None:
        print(json.dumps(response))
    if stderr:
        print(stderr, file=sys.stderr)
    raise SystemExit(int(exit_code))


if __name__ == "__main__":
    main()
