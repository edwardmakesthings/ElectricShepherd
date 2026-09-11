"""A3 harness: one TSA MCP session, many calls, measured.

Usage: python tests/manual/tsa_a3.py '<json list of {name, arguments}>'
Reports per-call latency and response size (the context cost an agent pays).
"""
import json
import subprocess
import sys
import time

calls = json.loads(sys.argv[1])

lines = [
    json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "a3", "version": "1"}}}),
    json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
]
for i, call in enumerate(calls, start=2):
    lines.append(json.dumps({"jsonrpc": "2.0", "id": i, "method": "tools/call",
                             "params": {"name": call["name"], "arguments": call.get("arguments", {})}}))

started = time.time()
proc = subprocess.run(
    ["uvx", "--from", "tree-sitter-analyzer[mcp]", "tree-sitter-analyzer-mcp", "--project-root", "."],
    input="\n".join(lines) + "\n", capture_output=True, text=True, encoding="utf-8", errors="replace",
)
elapsed = time.time() - started

by_id = {}
for line in proc.stdout.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except Exception:
        continue
    if isinstance(message.get("id"), int):
        by_id[message["id"]] = message

total = 0
for i, call in enumerate(calls, start=2):
    message = by_id.get(i)
    if message is None:
        print(f"[{call['name']}] NO RESPONSE")
        continue
    body = json.dumps(message.get("result") or message.get("error"))
    total += len(body)
    print(f"[{call['name']} {call.get('arguments', {}).get('action', '')}] bytes={len(body)}")
    print(body[:1500] + ("\n…[truncated]" if len(body) > 1500 else ""))
    print()

print(f"=== calls={len(calls)} total_bytes={total} wall_s={elapsed:.1f} ===")
