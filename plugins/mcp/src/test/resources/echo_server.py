#!/usr/bin/env python3
"""Test fixture: a minimal MCP server over stdio with one echo tool.

This script is a TEST FIXTURE RESOURCE ONLY. It lives under src/test/resources
and is never packaged into the plugin jar (the plugin build conventions bundle
only the main runtimeClasspath). The product's zero-external-binaries rule
applies to product tools; this fixture is a standard test resource that lets
the tests exercise a real MCP handshake against a real spawned process.

Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout, implementing
initialize, ping, tools/list and tools/call for a single tool named "echo"
that returns its "message" argument unchanged.

Usage: python3 echo_server.py [pidfile]
  pidfile - optional path; the server writes its own pid there on startup so
            tests can prove the process is gone after the client disconnects.
"""

import json
import os
import sys

FALLBACK_PROTOCOL_VERSION = "2024-11-05"

ECHO_TOOL = {
    "name": "echo",
    "description": "Echo the message back.",
    "inputSchema": {
        "type": "object",
        "properties": {"message": {"type": "string"}},
        "required": ["message"],
    },
}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def handle(req):
    method = req.get("method", "")
    req_id = req.get("id")
    params = req.get("params") or {}
    if req_id is None:
        # Notification (for example notifications/initialized): no response.
        return
    if method == "initialize":
        result = {
            "protocolVersion": params.get("protocolVersion", FALLBACK_PROTOCOL_VERSION),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "echo-server", "version": "1.0.0"},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [ECHO_TOOL]}
    elif method == "tools/call":
        arguments = params.get("arguments") or {}
        message = arguments.get("message", "")
        result = {
            "content": [{"type": "text", "text": str(message)}],
            "isError": False,
        }
    else:
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": "Method not found: %s" % method},
        })
        return
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as pid_file:
            pid_file.write(str(os.getpid()))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        handle(request)


if __name__ == "__main__":
    main()
