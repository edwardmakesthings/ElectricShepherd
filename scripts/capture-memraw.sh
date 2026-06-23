#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

load_env_file() {
  local file_path="$1"
  if [[ -f "$file_path" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$file_path"
    set +a
    return 0
  fi
  return 1
}

if [[ -n "${ESHEPHERD_ENV_FILE:-}" ]]; then
  load_env_file "$ESHEPHERD_ENV_FILE" || true
else
  loaded_repo_env=false
  if load_env_file "$repo_root/.env"; then
    loaded_repo_env=true
  fi
  if load_env_file "$repo_root/.env.local"; then
    loaded_repo_env=true
  fi

  if [[ "$loaded_repo_env" == "false" ]]; then
    load_env_file "$repo_root/../docker/.env" || true
  fi
fi

sid="${ESHEPHERD_SESSION_ID:-}"
event_type="${ESHEPHERD_EVENT_TYPE:-unknown}"

if [[ -z "$sid" ]]; then
  echo "capture-memraw: ESHEPHERD_SESSION_ID is required" >&2
  exit 2
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
  echo "capture-memraw: missing required command: $1" >&2
  exit 3
  fi
}

require_cmd opencode
require_cmd python

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_root="${TMPDIR:-/tmp}"
tmpfile="$tmp_root/eshepherd_memraw_${sid}_${event_type}_${timestamp}.json"

# Keep a local copy only when explicitly requested. MemPalace is the primary sink.
capture_keep_local="${ESHEPHERD_CAPTURE_KEEP_LOCAL:-false}"
capture_root="${ESHEPHERD_CAPTURE_ROOT:-$PWD/.electric-shepherd/exports}"

mcp_url="${MEMPALACE_MCP_URL:-}"
mcp_api_key="${MEMPALACE_MCP_API_KEY:-}"
mcp_auth_header="${MEMPALACE_MCP_AUTH_HEADER:-Authorization}"
mcp_auth_scheme="${MEMPALACE_MCP_AUTH_SCHEME:-}"
mcp_headers_json="${MEMPALACE_MCP_HEADERS_JSON:-}"
memraw_tool_prefix="${ESHEPHERD_MEMRAW_TOOL_PREFIX:-${MEMGRAPH_TOOL_PREFIX:-mempalace_}}"

if [[ -z "$mcp_url" ]]; then
  echo "capture-memraw: set MEMPALACE_MCP_URL (full MCP endpoint URL)" >&2
  exit 5
fi

wing="${ESHEPHERD_MEMRAW_WING:-${ESHEPHERD_PROJECT_WING:-opencode}}"
room="${ESHEPHERD_MEMRAW_ROOM:-mem-raw}"
added_by="${ESHEPHERD_MEMRAW_ADDED_BY:-electric-shepherd-capture}"
source_file="opencode://session/${sid}/${event_type}/${timestamp}"

cleanup() {
  rm -f "$tmpfile"
}
trap cleanup EXIT

# --pure avoids plugin log noise; stderr redirect suppresses export banners.
opencode --pure export "$sid" > "$tmpfile" 2>/dev/null

if [[ ! -s "$tmpfile" ]]; then
  echo "capture-memraw: export produced empty payload for session $sid" >&2
  exit 4
fi

python - "$tmpfile" "$mcp_url" "$mcp_api_key" "$wing" "$room" "$added_by" "$source_file" "$mcp_auth_header" "$mcp_auth_scheme" "$mcp_headers_json" "$memraw_tool_prefix" <<'PY'
import json
import re
import sys
import urllib.request

payload_path, mcp_url, api_key, wing, room, added_by, source_file, auth_header, auth_scheme, headers_json, tool_prefix = sys.argv[1:12]
session_id = None


def has_auth_scheme(value: str) -> bool:
  return bool(re.match(r"^[A-Za-z][A-Za-z0-9_-]*\s+", value))


def parse_mcp_response(raw: str) -> dict:
  raw = raw.strip()
  if not raw:
    return {}
  if raw.startswith("{"):
    return json.loads(raw)
  last = {}
  for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data:"):
      chunk = line[5:].strip()
      try:
        last = json.loads(chunk)
      except json.JSONDecodeError:
        continue
  return last


def mcp_post(body: dict) -> dict:
  global session_id
  headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  }

  if headers_json:
    try:
      parsed = json.loads(headers_json)
      if isinstance(parsed, dict):
        for key, value in parsed.items():
          if isinstance(key, str) and isinstance(value, str):
            headers[key] = value
    except json.JSONDecodeError:
      pass

  if api_key and auth_header and auth_header.lower() not in {k.lower() for k in headers.keys()}:
    auth_value = api_key
    if auth_scheme:
      if auth_scheme.lower() != "none":
        auth_value = f"{auth_scheme} {api_key}"
    elif auth_header.lower() == "authorization":
      auth_value = api_key if has_auth_scheme(api_key) else f"Bearer {api_key}"
    headers[auth_header] = auth_value

  if session_id:
    headers["Mcp-Session-Id"] = session_id

  req = urllib.request.Request(
    mcp_url,
    data=json.dumps(body).encode("utf-8"),
    headers=headers,
    method="POST",
  )
  with urllib.request.urlopen(req, timeout=60) as resp:
    sid = resp.headers.get("Mcp-Session-Id")
    if sid:
      session_id = sid
    raw = resp.read().decode("utf-8", "replace")
  out = parse_mcp_response(raw)
  if out.get("error"):
    raise RuntimeError(out["error"])
  return out


def maybe_initialize() -> None:
  try:
    mcp_post(
      {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
          "protocolVersion": "2025-03-26",
          "capabilities": {},
          "clientInfo": {"name": "electric-shepherd-capture", "version": "0.1.0"},
        },
      }
    )
    try:
      mcp_post(
        {
          "jsonrpc": "2.0",
          "id": -1,
          "method": "notifications/initialized",
          "params": {},
        }
      )
    except Exception:
      pass
  except Exception:
    pass


def tool_call(req_id: int, name: str, args: dict) -> dict:
  return mcp_post(
    {
      "jsonrpc": "2.0",
      "id": req_id,
      "method": "tools/call",
      "params": {
        "name": name,
        "arguments": args,
      },
    }
  )


with open(payload_path, "r", encoding="utf-8") as fh:
  content = fh.read().strip()

if not content:
  raise SystemExit("capture-memraw: exported payload is empty")

maybe_initialize()

tool_check = f"{tool_prefix}check_duplicate"
tool_add = f"{tool_prefix}add_drawer"

dup_resp = tool_call(1, tool_check, {"content": content})
dup_text = ""
for item in (dup_resp.get("result", {}).get("content") or []):
  if isinstance(item, dict) and item.get("type") == "text":
    dup_text += item.get("text", "")

is_dup = False
if dup_text:
  try:
    parsed = json.loads(dup_text)
    is_dup = bool(parsed.get("is_duplicate", False))
  except json.JSONDecodeError:
    is_dup = False

if is_dup:
  print(json.dumps({"status": "skipped-duplicate", "wing": wing, "room": room, "source_file": source_file}))
  raise SystemExit(0)

add_resp = tool_call(
  2,
  tool_add,
  {
    "wing": wing,
    "room": room,
    "content": content,
    "source_file": source_file,
    "added_by": added_by,
  },
)

if add_resp.get("error"):
  raise SystemExit(f"capture-memraw: add_drawer failed: {add_resp['error']}")

print(json.dumps({"status": "stored", "wing": wing, "room": room, "source_file": source_file}))
PY

if [[ "$capture_keep_local" == "true" ]]; then
  mkdir -p "$capture_root"
  outfile="$capture_root/session_${sid}_${event_type}_${timestamp}.json"
  mv "$tmpfile" "$outfile"
  echo "$outfile"
else
  echo "mempalace://$wing/$room/$sid/$event_type/$timestamp"
fi
