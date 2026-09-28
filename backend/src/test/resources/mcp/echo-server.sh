#!/usr/bin/env bash
# Minimal MCP stdio echo server for tests.
# Framing: newline-delimited JSON-RPC 2.0 (one message per line).
# Handles: server/discover (error → legacy fallback), initialize, tools/list, tools/call.
exec python3 -c '
import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method", "")
    msg_id = msg.get("id")

    if method == "server/discover":
        print(json.dumps({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Method not found"}}), flush=True)
    elif method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": {"protocolVersion": "2025-11-25", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "echo-server", "version": "1.0"}}}), flush=True)
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        print(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": [{"name": "echo", "description": "Echoes the message back", "inputSchema": {"type": "object", "properties": {"message": {"type": "string", "description": "Message to echo"}}, "required": ["message"]}}]}}), flush=True)
    elif method == "tools/call":
        args = msg.get("params", {}).get("arguments", {})
        message = args.get("message", "")
        print(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": message}], "isError": False}}), flush=True)
    elif msg_id is not None:
        print(json.dumps({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Method not found"}}), flush=True)
'