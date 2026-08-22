#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
capture_script="$script_dir/capture-source-transcripts.sh"

if [[ ! -f "$capture_script" ]]; then
  echo "backfill-source-transcripts: missing capture script at $capture_script" >&2
  exit 2
fi

project_root="${ESHEPHERD_PROJECT_ROOT:-$PWD}"
event_type="${ESHEPHERD_EVENT_TYPE:-manual:bulk-backfill}"
no_skip="false"
max_count=""
resume_file=""
retry_failed_only="false"
preflight="false"
preflight_only="false"
require_confirm="false"
assume_yes="false"
capture_keep_local=""
capture_root=""
mcp_timeout_seconds=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      project_root="$2"
      shift 2
      ;;
    --event-type)
      event_type="$2"
      shift 2
      ;;
    --max-count)
      max_count="$2"
      shift 2
      ;;
    --resume-file)
      resume_file="$2"
      shift 2
      ;;
    --no-skip)
      no_skip="true"
      shift
      ;;
    --retry-failed-only)
      retry_failed_only="true"
      shift
      ;;
    --preflight)
      preflight="true"
      shift
      ;;
    --preflight-only)
      preflight="true"
      preflight_only="true"
      shift
      ;;
    --confirm)
      preflight="true"
      require_confirm="true"
      shift
      ;;
    --yes)
      assume_yes="true"
      shift
      ;;
    --keep-local)
      capture_keep_local="true"
      shift
      ;;
    --capture-root)
      capture_root="$2"
      shift 2
      ;;
    --mcp-timeout-seconds)
      mcp_timeout_seconds="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  backfill-source-transcripts.sh [options]

Options:
  --project-root <path>   Project directory to backfill (default: $PWD)
  --event-type <name>     Capture event type tag (default: manual:bulk-backfill)
  --max-count <n>         Only process first N sessions after sorting by update desc
  --resume-file <path>    Status file path (default: <project>/.electric-shepherd/source-capture-backfill.ndjson)
  --no-skip               Re-run sessions even if status file marks them successful
  --retry-failed-only     Process only sessions whose latest resume-log status is failed
  --preflight             Export each candidate transcript first and print size/chunk estimates
  --preflight-only        Run preflight and exit before any capture writes
  --confirm               With preflight, require y/yes confirmation before ingesting
  --yes                   Auto-confirm (useful with --confirm in non-interactive runs)
  --keep-local            Save each exported transcript locally during capture
  --capture-root <path>   Local export directory for --keep-local
  --mcp-timeout-seconds <n>
                           Override MCP HTTP timeout for capture requests (default: 60)
EOF
      exit 0
      ;;
    *)
      echo "backfill-source-transcripts: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$resume_file" ]]; then
  resume_file="$project_root/.electric-shepherd/source-capture-backfill.ndjson"
fi

mkdir -p "$(dirname "$resume_file")"
touch "$resume_file"

sessions_json="$(cd "$project_root" && opencode --pure session list --format json)"
sessions_file="$(mktemp "${TMPDIR:-/tmp}/eshepherd_sessions_XXXXXX.json")"
printf '%s' "$sessions_json" > "$sessions_file"

selection_file="$(mktemp "${TMPDIR:-/tmp}/eshepherd_selection_XXXXXX.json")"
python3 - "$sessions_file" "$project_root" "$max_count" > "$selection_file" <<'PY'
import json
import sys

sessions_path, project_root, max_count_raw = sys.argv[1:4]
with open(sessions_path, "r", encoding="utf-8") as fh:
  rows = json.load(fh)

rows = [r for r in rows if str(r.get("directory") or "") == project_root]
rows.sort(key=lambda r: int(r.get("updated") or 0), reverse=True)

if max_count_raw:
  rows = rows[: max(0, int(max_count_raw))]

print(json.dumps(rows, ensure_ascii=False))
PY

echo "Found sessions in $project_root:"
python3 - "$selection_file" <<'PY'
import json
import sys

rows = json.load(open(sys.argv[1], "r", encoding="utf-8"))
for idx, row in enumerate(rows, start=1):
  print(f"  {idx:>3}. {row.get('id')}  {row.get('title')}")
print(f"Total: {len(rows)}")
PY

python3 - "$resume_file" "$no_skip" "$retry_failed_only" "$selection_file" "$capture_script" "$project_root" "$event_type" "$preflight" "$preflight_only" "$require_confirm" "$assume_yes" "$capture_keep_local" "$capture_root" "$mcp_timeout_seconds" <<'PY'
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import tempfile

(
  resume_path,
  no_skip_raw,
  retry_failed_only_raw,
  selection_path,
  capture_script,
  project_root,
  event_type,
  preflight_raw,
  preflight_only_raw,
  require_confirm_raw,
  assume_yes_raw,
  capture_keep_local_raw,
  capture_root_raw,
  mcp_timeout_seconds_raw,
) = sys.argv[1:15]
sys.path.insert(0, os.path.dirname(capture_script))
from transcript_capture_normalization import normalize_capture_content, render_readable_preview

no_skip = no_skip_raw == "true"
retry_failed_only = retry_failed_only_raw == "true"
preflight = preflight_raw == "true"
preflight_only = preflight_only_raw == "true"
require_confirm = require_confirm_raw == "true"
assume_yes = assume_yes_raw == "true"
capture_keep_local = capture_keep_local_raw == "true"
capture_root = capture_root_raw.strip()
mcp_timeout_seconds = mcp_timeout_seconds_raw.strip()
sessions = json.load(open(selection_path, "r", encoding="utf-8"))
chunk_limit_chars = 95_000
estimated_storage_chunk_chars = max(1, int(os.environ.get("ESHEPHERD_SOURCE_CAPTURE_PREVIEW_CHUNK_CHARS", "800")))
default_capture_root = os.path.join(project_root, ".electric-shepherd", "exports")


def safe_fragment(value: str) -> str:
  cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
  return cleaned.strip("-") or "unknown"


def estimate_session(sid: str, write_preview: bool, preview_root: str, event_type_value: str) -> dict:
  with tempfile.NamedTemporaryFile("w+b", delete=False) as tmp:
    export_path = tmp.name

  try:
    with open(export_path, "w", encoding="utf-8") as out_f:
      proc = subprocess.run(
        ["opencode", "--pure", "export", sid],
        cwd=project_root,
        text=True,
        stdout=out_f,
        stderr=subprocess.PIPE,
      )

    raw = ""
    with open(export_path, "r", encoding="utf-8") as in_f:
      raw = in_f.read().strip()
  finally:
    try:
      os.remove(export_path)
    except OSError:
      pass

  if proc.returncode != 0:
    return {
      "ok": False,
      "error": (proc.stderr or proc.stdout or "export failed").strip()[-300:],
    }

  if not raw:
    return {
      "ok": False,
      "error": "export returned empty transcript",
    }

  normalized = normalize_capture_content(raw)
  chars = len(normalized)
  preview_path = None
  if write_preview:
    os.makedirs(preview_root, exist_ok=True)
    stem = (
      f"preflight_{safe_fragment(sid)}_"
      f"{safe_fragment(event_type_value)}_"
      f"{dt.datetime.now(dt.UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    preview_path = os.path.join(preview_root, stem)
    with open(preview_path, "w", encoding="utf-8") as out_f:
      out_f.write(normalized)
    preview_txt_path = os.path.join(preview_root, stem[:-5] + ".txt")
    with open(preview_txt_path, "w", encoding="utf-8") as out_txt:
      out_txt.write(render_readable_preview(normalized))

  return {
    "ok": True,
    "raw_chars": len(raw),
    "normalized_chars": chars,
    "estimated_capture_drawers": max(1, math.ceil(chars / chunk_limit_chars)),
    "estimated_storage_chunks": max(1, math.ceil(chars / estimated_storage_chunk_chars)),
    "preview_path": preview_path,
    "preview_txt_path": preview_txt_path if write_preview else None,
  }

done = set()
latest_status = {}
with open(resume_path, "r", encoding="utf-8") as fh:
  for line in fh:
    line = line.strip()
    if not line:
      continue
    try:
      row = json.loads(line)
    except json.JSONDecodeError:
      continue
    sid = row.get("sid")
    if isinstance(sid, str):
      latest_status[sid] = row.get("status")
      if row.get("status") == "ok":
        done.add(sid)

if retry_failed_only:
  sessions = [r for r in sessions if isinstance(r.get("id"), str) and latest_status.get(str(r.get("id"))) == "failed"]
  print(f"Retry-failed-only enabled: eligible sessions={len(sessions)}")

candidate_sessions = sessions if no_skip else [r for r in sessions if str(r.get("id") or "").strip() not in done]
pre_skip_count = len(sessions) - len(candidate_sessions)

if preflight:
  preflight_capture_root = capture_root or default_capture_root
  preflight_preview_root = os.path.join(preflight_capture_root, "preflight")
  preflight_write_preview = capture_keep_local

  print("\nPreflight estimates:")
  print(
    f"  selected={len(sessions)} candidate={len(candidate_sessions)} pre_skipped_ok={pre_skip_count} "
    f"capture_chunk_limit={chunk_limit_chars} estimated_storage_chunk={estimated_storage_chunk_chars}"
  )
  if preflight_write_preview:
    print(f"  preflight_preview_root={preflight_preview_root}")

  totals = {
    "raw_chars": 0,
    "normalized_chars": 0,
    "estimated_capture_drawers": 0,
    "estimated_storage_chunks": 0,
  }
  failed_estimates = 0

  for idx, row in enumerate(candidate_sessions, start=1):
    sid = str(row.get("id") or "").strip()
    title = str(row.get("title") or "")
    if not sid:
      continue

    estimate = estimate_session(sid, preflight_write_preview, preflight_preview_root, event_type)
    if not estimate.get("ok"):
      failed_estimates += 1
      print(f"  [{idx}/{len(candidate_sessions)}] FAIL {sid}  error={estimate.get('error')}")
      continue

    totals["raw_chars"] += int(estimate["raw_chars"])
    totals["normalized_chars"] += int(estimate["normalized_chars"])
    totals["estimated_capture_drawers"] += int(estimate["estimated_capture_drawers"])
    totals["estimated_storage_chunks"] += int(estimate["estimated_storage_chunks"])
    print(
      f"  [{idx}/{len(candidate_sessions)}] {sid}"
      f"  normalized_chars={estimate['normalized_chars']}"
      f"  est_capture_drawers={estimate['estimated_capture_drawers']}"
      f"  est_storage_chunks={estimate['estimated_storage_chunks']}"
      f"  preview_json={estimate.get('preview_path') or '-'}"
      f"  preview_text={estimate.get('preview_txt_path') or '-'}"
      f"  title={title}"
    )

  print("\nPreflight summary:")
  print(f"  candidates={len(candidate_sessions)} failed_estimates={failed_estimates}")
  print(f"  total_raw_chars={totals['raw_chars']}")
  print(f"  total_normalized_chars={totals['normalized_chars']}")
  print(f"  total_est_capture_drawers={totals['estimated_capture_drawers']}")
  print(f"  total_est_storage_chunks={totals['estimated_storage_chunks']}")

  if preflight_only:
    print("\nPreflight-only mode: no captures were ingested.")
    raise SystemExit(0)

  if len(candidate_sessions) == 0:
    print("\nNo candidate sessions to ingest after resume-log skip filtering.")
    raise SystemExit(0)

  if require_confirm:
    if assume_yes:
      print("\nPreflight confirm: auto-approved via --yes")
    else:
      prompt_stream = None
      try:
        prompt_stream = open("/dev/tty", "r", encoding="utf-8")
      except OSError:
        pass

      if prompt_stream is None:
        print("--confirm was requested but no interactive tty is available; pass --yes to proceed.", file=sys.stderr)
        raise SystemExit(2)

      try:
        print("\nProceed with transcript ingestion? [y/N] ", end="", flush=True)
        answer = prompt_stream.readline().strip().lower()
      finally:
        prompt_stream.close()

      if answer not in {"y", "yes"}:
        print("Aborted before ingestion.")
        raise SystemExit(0)

ok = 0
failed = 0
skipped = 0

with open(resume_path, "a", encoding="utf-8") as out:
  total = len(sessions)
  for idx, row in enumerate(sessions, start=1):
    sid = str(row.get("id") or "").strip()
    title = str(row.get("title") or "")
    if not sid:
      continue

    if (not no_skip) and sid in done:
      skipped += 1
      print(f"[{idx}/{total}] SKIP {sid} (already successful in resume file)")
      continue

    env = os.environ.copy()
    env["ESHEPHERD_PROJECT_ROOT"] = project_root
    env["ESHEPHERD_EVENT_TYPE"] = event_type
    env["ESHEPHERD_SESSION_ID"] = sid
    if capture_keep_local:
      env["ESHEPHERD_CAPTURE_KEEP_LOCAL"] = "true"
    if capture_root:
      env["ESHEPHERD_CAPTURE_ROOT"] = capture_root
    if mcp_timeout_seconds:
      env["ESHEPHERD_SOURCE_CAPTURE_MCP_TIMEOUT_SECONDS"] = mcp_timeout_seconds

    proc = subprocess.run(["bash", capture_script], text=True, capture_output=True, env=env)
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    payload = None
    location = None
    for line in stdout.splitlines():
      t = line.strip()
      if t.startswith("{") and t.endswith("}"):
        try:
          payload = json.loads(t)
        except json.JSONDecodeError:
          pass
      if t.startswith("mempalace://"):
        location = t

    status = "ok" if proc.returncode == 0 else "failed"
    record = {
      "at": dt.datetime.now(dt.UTC).isoformat(),
      "sid": sid,
      "title": title,
      "status": status,
      "returncode": proc.returncode,
      "payload": payload,
      "location": location,
      "stderr": stderr[-1000:] if stderr else "",
    }
    out.write(json.dumps(record, ensure_ascii=False) + "\n")
    out.flush()

    if status == "ok":
      ok += 1
      print(f"[{idx}/{total}] OK   {sid}  status={((payload or {}).get('status') if isinstance(payload, dict) else None)}")
    else:
      failed += 1
      print(f"[{idx}/{total}] FAIL {sid}  rc={proc.returncode}")

print(f"\nBackfill complete: ok={ok} failed={failed} skipped={skipped} total={len(sessions)}")
print(f"Resume log: {resume_path}")
PY
