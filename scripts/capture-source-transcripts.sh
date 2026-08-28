#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
consumer_root="${ESHEPHERD_PROJECT_ROOT:-$PWD}"

resolve_env_path() {
  local raw_path="$1"
  if [[ "$raw_path" = /* ]]; then
    printf '%s\n' "$raw_path"
    return 0
  fi
  printf '%s\n' "$consumer_root/$raw_path"
}

load_env_file() {
  local file_path="$1"
  if [[ -f "$file_path" ]]; then
    # Load only missing variables so caller-provided runtime config values
    # (inherited env) are not overridden by stale local .env defaults.
    while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
      local line="$raw_line"
      line="${line#${line%%[![:space:]]*}}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      if [[ "$line" == export\ * ]]; then
        line="${line#export }"
      fi

      local key="${line%%=*}"
      key="${key%%[[:space:]]*}"
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

      if [[ -z "${!key+x}" ]]; then
        eval "export $line"
      fi
    done < "$file_path"
    return 0
  fi
  return 1
}

if [[ -n "${ESHEPHERD_ENV_FILE:-}" ]]; then
  load_env_file "$(resolve_env_path "$ESHEPHERD_ENV_FILE")" || true
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

# Load non-secret runtime behavior from JSONC config when available.
# This keeps env focused on secrets while still supporting standalone script runs.
# --cwd must be the CONSUMER project (not this repo) so wing/room/config resolve
# against the project actually being captured; the plugin sets ESHEPHERD_PROJECT_ROOT
# when it spawns this script with cwd=repo_root. Falls back to $PWD for standalone runs.
preserve_runtime_override() {
  local key="$1"
  local val="$2"
  export "$key=$val"
}

if command -v node >/dev/null 2>&1; then
  preserve_capture_keep_local="${ESHEPHERD_CAPTURE_KEEP_LOCAL+x}"
  preserve_capture_keep_local_val="${ESHEPHERD_CAPTURE_KEEP_LOCAL-}"
  preserve_capture_root="${ESHEPHERD_CAPTURE_ROOT+x}"
  preserve_capture_root_val="${ESHEPHERD_CAPTURE_ROOT-}"
  preserve_capture_mode="${ESHEPHERD_SOURCE_CAPTURE_MODE+x}"
  preserve_capture_mode_val="${ESHEPHERD_SOURCE_CAPTURE_MODE-}"
  preserve_capture_timeout="${ESHEPHERD_SOURCE_CAPTURE_MCP_TIMEOUT_SECONDS+x}"
  preserve_capture_timeout_val="${ESHEPHERD_SOURCE_CAPTURE_MCP_TIMEOUT_SECONDS-}"

  config_exports="$(node --experimental-strip-types "$repo_root/scripts/emit-runtime-config-env.ts" --cwd "${ESHEPHERD_PROJECT_ROOT:-$PWD}" 2>/dev/null || true)"
  if [[ -n "$config_exports" ]]; then
    eval "$config_exports"
  fi

  if [[ -n "$preserve_capture_keep_local" ]]; then
    preserve_runtime_override "ESHEPHERD_CAPTURE_KEEP_LOCAL" "$preserve_capture_keep_local_val"
  fi
  if [[ -n "$preserve_capture_root" ]]; then
    preserve_runtime_override "ESHEPHERD_CAPTURE_ROOT" "$preserve_capture_root_val"
  fi
  if [[ -n "$preserve_capture_mode" ]]; then
    preserve_runtime_override "ESHEPHERD_SOURCE_CAPTURE_MODE" "$preserve_capture_mode_val"
  fi
  if [[ -n "$preserve_capture_timeout" ]]; then
    preserve_runtime_override "ESHEPHERD_SOURCE_CAPTURE_MCP_TIMEOUT_SECONDS" "$preserve_capture_timeout_val"
  fi
fi

sid="${ESHEPHERD_SESSION_ID:-}"
event_type="${ESHEPHERD_EVENT_TYPE:-unknown}"

if [[ -z "$sid" ]]; then
  echo "capture-source-transcripts: ESHEPHERD_SESSION_ID is required" >&2
  exit 2
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
  echo "capture-source-transcripts: missing required command: $1" >&2
  exit 3
  fi
}

require_cmd opencode
# Resolve a Python interpreter: prefer python3, fall back to python. Some hosts
# (the opencode systemd service PATH) ship only python3, so a bare `python`
# requirement would fail the dependency check even though python3 is present.
PYBIN="$(command -v python3 || command -v python || true)"
if [[ -z "$PYBIN" ]]; then
  echo "capture-source-transcripts: missing required command: python3 or python" >&2
  exit 3
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_root="${TMPDIR:-/tmp}"
tmpfile="$tmp_root/eshepherd_source_capture_${sid}_${event_type}_${timestamp}.json"

# Keep a local copy only when explicitly requested. MemPalace is the primary sink.
capture_keep_local="${ESHEPHERD_CAPTURE_KEEP_LOCAL:-false}"
capture_root="${ESHEPHERD_CAPTURE_ROOT:-$PWD/.electric-shepherd/exports}"

mcp_url="${MEMPALACE_MCP_URL:-}"
mcp_api_key="${MEMPALACE_MCP_API_KEY:-}"
mcp_auth_header="${MEMPALACE_MCP_AUTH_HEADER:-Authorization}"
mcp_auth_scheme="${MEMPALACE_MCP_AUTH_SCHEME:-}"
mcp_headers_json="${MEMPALACE_MCP_HEADERS_JSON:-}"
source_capture_tool_prefix="${ESHEPHERD_SOURCE_CAPTURE_TOOL_PREFIX:-${MEMGRAPH_TOOL_PREFIX:-mempalace_}}"
source_capture_dedup_enabled="${ESHEPHERD_SOURCE_CAPTURE_DEDUP_ENABLED:-true}"
mcp_timeout_seconds="${ESHEPHERD_SOURCE_CAPTURE_MCP_TIMEOUT_SECONDS:-60}"
# Capture mode:
#   append  -> always write a new timestamped source drawer snapshot
#   replace -> maintain one stable latest snapshot per session (update in place)
#   hybrid  -> replace on message.stop, append on session.compacted
source_capture_mode="${ESHEPHERD_SOURCE_CAPTURE_MODE:-append}"

if [[ -z "$mcp_url" ]]; then
  echo "capture-source-transcripts: set MEMPALACE_MCP_URL (full MCP endpoint URL)" >&2
  exit 5
fi

wing="${ESHEPHERD_SOURCE_CAPTURE_WING:-${ESHEPHERD_PROJECT_WING:-opencode}}"
room="${ESHEPHERD_SOURCE_CAPTURE_ROOM:-source-transcripts}"
added_by="${ESHEPHERD_SOURCE_CAPTURE_ADDED_BY:-electric-shepherd-capture}"
source_file_append="opencode://session/${sid}/${event_type}/${timestamp}"
# Flat source key (no slashes) so list_drawers metadata can match exactly.
source_file_latest="opencode-session-${sid}-latest"

cleanup() {
  rm -f "$tmpfile"
}
trap cleanup EXIT

# --pure avoids plugin log noise; stderr redirect suppresses export banners.
opencode --pure export "$sid" > "$tmpfile" 2>/dev/null

if [[ ! -s "$tmpfile" ]]; then
  echo "capture-source-transcripts: export produced empty payload for session $sid" >&2
  exit 4
fi

"$PYBIN" - "$tmpfile" "$mcp_url" "$mcp_api_key" "$wing" "$room" "$added_by" "$source_file_append" "$source_file_latest" "$event_type" "$source_capture_mode" "$mcp_auth_header" "$mcp_auth_scheme" "$mcp_headers_json" "$source_capture_tool_prefix" "$source_capture_dedup_enabled" "$mcp_timeout_seconds" "$script_dir" <<'PY'
import json
import re
import sys
import urllib.request

(
  payload_path,
  mcp_url,
  api_key,
  wing,
  room,
  added_by,
  source_file_append,
  source_file_latest,
  event_type,
  capture_mode_raw,
  auth_header,
  auth_scheme,
  headers_json,
  tool_prefix,
  dedup_enabled_raw,
  timeout_seconds_raw,
  script_dir,
) = sys.argv[1:18]
session_id = None
dedup_enabled = dedup_enabled_raw.strip().lower() in {"1", "true", "yes", "on"}
capture_mode = capture_mode_raw.strip().lower() if capture_mode_raw else "append"
try:
  timeout_seconds = float(timeout_seconds_raw)
except (TypeError, ValueError):
  timeout_seconds = 60.0
if timeout_seconds <= 0:
  timeout_seconds = 60.0
if capture_mode not in {"append", "replace", "hybrid"}:
  capture_mode = "append"

sys.path.insert(0, script_dir)
from transcript_capture_normalization import normalize_capture_content

if capture_mode == "append":
  ingest_mode = "append"
elif capture_mode == "replace":
  ingest_mode = "replace"
else:
  ingest_mode = "append" if event_type == "session.compacted" else "replace"


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
  with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
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


def decode_tool_json(response: dict):
  result = response.get("result", {})
  if result.get("isError"):
    detail = ""
    for item in (result.get("content") or []):
      if isinstance(item, dict) and item.get("type") == "text":
        detail += item.get("text", "")
    raise RuntimeError(detail.strip() or "tool execution failed")

  text = ""
  for item in (result.get("content") or []):
    if isinstance(item, dict) and item.get("type") == "text":
      text += item.get("text", "")
  text = text.strip()
  if not text:
    return {}
  try:
    return json.loads(text)
  except json.JSONDecodeError:
    return {}


def extract_drawer_id(payload: dict):
  if not isinstance(payload, dict):
    return None
  for key in ("drawer_id", "id", "node_id"):
    value = payload.get(key)
    if isinstance(value, str) and value.strip():
      return value.strip()
  nested = payload.get("drawer")
  if isinstance(nested, dict):
    for key in ("drawer_id", "id", "node_id"):
      value = nested.get(key)
      if isinstance(value, str) and value.strip():
        return value.strip()
  return None


def require_tool_success(payload: dict, action: str) -> None:
  if not isinstance(payload, dict):
    return
  success = payload.get("success")
  if success is False:
    error = payload.get("error")
    detail = str(error).strip() if error is not None else "unknown error"
    raise RuntimeError(f"{action} failed: {detail}")


def chunk_text(text: str, limit: int):
  if limit <= 0:
    return [text]
  out = []
  start = 0
  n = len(text)
  while start < n:
    out.append(text[start:start + limit])
    start += limit
  return out


def add_with_chunking(base_args: dict, source_key: str) -> dict:
  payload = dict(base_args)
  parsed = decode_tool_json(tool_call(2, tool_add, payload))
  if isinstance(parsed, dict) and parsed.get("success") is False:
    error = str(parsed.get("error") or "")
    if "maximum length" not in error:
      require_tool_success(parsed, "add_drawer")
      return {
        "status": "stored",
        "mode": ingest_mode,
        "wing": wing,
        "room": room,
        "source_file": source_key,
        "drawer_id": extract_drawer_id(parsed),
        "tool_result": parsed,
      }

    content_value = str(payload.get("content") or "")
    chunks = chunk_text(content_value, 95_000)
    if len(chunks) <= 1:
      require_tool_success(parsed, "add_drawer")

    first_payload = dict(payload)
    first_payload["content"] = chunks[0]
    first_parsed = decode_tool_json(tool_call(2, tool_add, first_payload))
    require_tool_success(first_parsed, "add_drawer")
    first_id = extract_drawer_id(first_parsed)
    if not first_id:
      raise RuntimeError("add_drawer failed: chunked root drawer missing drawer_id")

    child_ids = []
    for index, piece in enumerate(chunks[1:], start=1):
      child_payload = dict(payload)
      child_payload["content"] = piece
      child_payload["source_file"] = f"{source_key}#chunk-{index + 1:03d}-of-{len(chunks):03d}"
      child_parsed = decode_tool_json(tool_call(2000 + index, tool_add, child_payload))
      require_tool_success(child_parsed, "add_drawer")
      child_id = extract_drawer_id(child_parsed)
      if child_id:
        child_ids.append(child_id)

    try:
      root_existing = None
      for drawer in iter_drawers_by_source_file(source_key):
        root_existing = drawer
        break
      if root_existing is not None:
        root_id = str(root_existing.get("drawer_id", "") or "").strip()
        if root_id:
          root_content = str(root_existing.get("content", "") or "")
          marker = {
            "chunked_capture": True,
            "chunks": len(chunks),
            "chunk_ids": [root_id, *child_ids],
            "source_file": source_key,
          }
          update_payload = {
            "drawer_id": root_id,
            "content": root_content + "\n\n" + json.dumps(marker),
          }
          update_result = decode_tool_json(tool_call(3000, tool_update, update_payload))
          require_tool_success(update_result, "update_drawer")
    except Exception:
      pass

    # Phase 1: stamp root + children (best-effort; never fails capture).
    for stamped_id in [first_id, *child_ids]:
      stamp_source_type(stamped_id)

    return {
      "status": "stored-chunked",
      "mode": ingest_mode,
      "wing": wing,
      "room": room,
      "source_file": source_key,
      "drawer_id": first_id,
      "chunks": len(chunks),
      "chunk_count": len(chunks),
      "tool_result": first_parsed,
    }

  require_tool_success(parsed, "add_drawer")
  drawer_id = extract_drawer_id(parsed)
  # Phase 1: stamp the new source drawer (best-effort; never fails capture).
  stamp_source_type(drawer_id)
  return {
    "status": "stored",
    "mode": ingest_mode,
    "wing": wing,
    "room": room,
    "source_file": source_key,
    "drawer_id": drawer_id,
    "tool_result": parsed,
  }


def iter_drawers_by_source_file(source_key: str):
  offset = 0
  limit = 100
  tool_list = f"{tool_prefix}list_drawers"

  while True:
    listed = tool_call(80 + (offset // max(limit, 1)), tool_list, {
      "wing": wing,
      "room": room,
      "limit": limit,
      "offset": offset,
    })
    payload = decode_tool_json(listed)
    drawers = payload.get("drawers") if isinstance(payload, dict) else None
    if not isinstance(drawers, list) or len(drawers) == 0:
      break

    for drawer in drawers:
      if not isinstance(drawer, dict):
        continue
      meta = drawer.get("metadata") if isinstance(drawer.get("metadata"), dict) else {}
      row_source = str(meta.get("source_file", "") or "").strip()
      if row_source == source_key:
        yield drawer

    if len(drawers) < limit:
      break
    offset += len(drawers)


with open(payload_path, "r", encoding="utf-8") as fh:
  payload_raw = fh.read()
content = normalize_capture_content(payload_raw)

if not content:
  raise SystemExit("capture-source-transcripts: exported payload is empty")

maybe_initialize()

tool_check = f"{tool_prefix}check_duplicate"
tool_add = f"{tool_prefix}add_drawer"
tool_update = f"{tool_prefix}update_drawer"
tool_kg = f"{tool_prefix}kg_add"

# Phase 1 (unified memory): stamp captured source drawers with es-source-type=transcript.
# Best-effort only — a failed stamp must never fail the capture (same contract as the
# chunked marker update above). Uses the same tool prefix as every other call here.
# The request-id counter is a mutable default so it survives being exec'd in any
# namespace (a `global` would NameError and be swallowed by the except below).
def stamp_source_type(drawer_id: str, _state: dict = {"id": 9000}) -> None:
  if not drawer_id:
    return
  try:
    _state["id"] += 1
    tool_call(_state["id"], tool_kg, {
      "subject": drawer_id,
      "predicate": "es-source-type",
      "object": "transcript",
    })
  except Exception:
    pass

if ingest_mode == "append" and dedup_enabled:
  dup_resp = tool_call(1, tool_check, {"content": content})
  dup_parsed = decode_tool_json(dup_resp)
  is_dup = False
  if isinstance(dup_parsed, dict):
    is_dup = bool(dup_parsed.get("is_duplicate", False))

  if is_dup:
    with open(payload_path, "w", encoding="utf-8") as out_f:
      out_f.write(payload_raw)
    print(json.dumps({
      "status": "skipped-duplicate",
      "mode": ingest_mode,
      "wing": wing,
      "room": room,
      "source_file": source_file_append,
    }))
    raise SystemExit(0)

if ingest_mode == "replace":
  existing = None
  for drawer in iter_drawers_by_source_file(source_file_latest):
    existing = drawer
    break

  if existing is not None:
    existing_id = str(existing.get("drawer_id", "") or "").strip()
    existing_content = str(existing.get("content", "") or "")
    if content == existing_content:
      print(json.dumps({
        "status": "skipped-unchanged",
        "mode": ingest_mode,
        "wing": wing,
        "room": room,
        "source_file": source_file_latest,
        "drawer_id": existing_id,
      }))
      raise SystemExit(0)

    if not existing_id:
      raise SystemExit("capture-source-transcripts: existing drawer missing drawer_id")

    update_resp = tool_call(
      2,
      tool_update,
      {
        "drawer_id": existing_id,
        "content": content,
      },
    )
    update_parsed = decode_tool_json(update_resp)
    require_tool_success(update_parsed, "update_drawer")
    print(json.dumps({
      "status": "updated",
      "mode": ingest_mode,
      "wing": wing,
      "room": room,
      "source_file": source_file_latest,
      "drawer_id": existing_id,
      "tool_result": update_parsed,
    }))
    raise SystemExit(0)

  stored = add_with_chunking(
    {
      "wing": wing,
      "room": room,
      "content": content,
      "source_file": source_file_latest,
      "added_by": added_by,
    },
    source_file_latest,
  )
  print(json.dumps(stored))
else:
  stored = add_with_chunking(
    {
      "wing": wing,
      "room": room,
      "content": content,
      "source_file": source_file_append,
      "added_by": added_by,
    },
    source_file_append,
  )
  print(json.dumps(stored))
PY

if [[ "$capture_keep_local" == "true" ]]; then
  mkdir -p "$capture_root"
  outfile="$capture_root/session_${sid}_${event_type}_${timestamp}.json"
  mv "$tmpfile" "$outfile"
  echo "$outfile"
else
  echo "mempalace://$wing/$room/$sid/$event_type/$timestamp"
fi
