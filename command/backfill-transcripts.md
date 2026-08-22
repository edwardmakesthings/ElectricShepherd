---
description: Backfill transcripts — list project sessions, then capture each with progress + resume log
agent: build
subtask: false
---
Run the bulk transcript backfill helper for this project.

Arguments: $ARGUMENTS

Execution:

1. Build command from repo root:
   `bash scripts/backfill-source-transcripts.sh [args]`
2. Pass `$ARGUMENTS` through verbatim.
3. Stream output so the user sees:
   - discovered session list up front
   - `[i/N] OK|FAIL|SKIP <sid>` progress per session
   - final summary counts and resume log path

Defaults and resume behavior:

- Uses `opencode --pure session list --format json` scoped to current project directory.
- Writes resumable status log at:
  `.electric-shepherd/source-capture-backfill.ndjson`
- On rerun, sessions with prior `status=ok` are skipped automatically.
- Use `--no-skip` to force recapture.

Useful args:

- `--max-count 20`
- `--event-type manual:bulk-backfill`
- `--resume-file /absolute/path/to/file.ndjson`
- `--no-skip`
- `--retry-failed-only` (only re-run sessions whose latest resume status is `failed`)
- `--preflight` (export and estimate each candidate before ingest)
- `--preflight-only` (show estimates and exit without writing)
- `--confirm` (prompt before ingest after preflight)
- `--yes` (auto-confirm; use with `--confirm` in non-interactive runs)
- `--keep-local` (save transcript exports to local files while ingesting)
- `--capture-root /absolute/path` (target directory for `--keep-local`; default `.electric-shepherd/exports` under project root)
- `--mcp-timeout-seconds 180` (raise capture HTTP timeout for slower MCP responses)

When `--preflight` is combined with `--keep-local`, normalized preflight exports are written to:

- `<capture-root>/preflight/` (or `<project>/.electric-shepherd/exports/preflight/` if no capture root is provided)
- Each candidate gets both:
  - `preflight_<sid>_<event>_<timestamp>.json` (normalized JSON)
  - `preflight_<sid>_<event>_<timestamp>.txt` (readable text view with real line breaks)

Normalization is now aggressively conversation-focused for both preflight and ingest:

- Keeps only per-message `{role, text}` for messages that have non-empty text.
- Drops tool-call parts entirely (`type=tool`, `step-start`, `step-finish`, etc.).
- Drops per-message metadata (`cost`, `tokens`, IDs, timestamps, model/provider, cwd/root).
- Trims synthetic embedded file payloads in `<content>...</content>` to a marker.

This reduction applies to both preflight estimates and ingested transcript content.
