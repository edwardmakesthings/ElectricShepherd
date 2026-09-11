---
description: Consolidate — run worklist-first consolidation script (dry-run by default)
agent: dreamer
subtask: false
---
# Consolidate

Run the consolidation script directly (NOT the interactive dreamer agent path).

Arguments: $ARGUMENTS

Argument modes:

- `/consolidate` -> dry run, unsynthesized worklist only.
- `/consolidate apply` -> commit unsynthesized worklist (`--apply --apply-merges`).
- `/consolidate all` -> dry run, full-scope reprocess (`--all`).
- `/consolidate all apply` -> commit full-scope reprocess (`--all --apply --apply-merges`).
- `/consolidate retry-failed` -> dry run from failed room only (`--retry-failed-only`).
- `/consolidate retry-failed apply` -> commit retries from failed room (`--retry-failed-only --apply --apply-merges`).
- `/consolidate fast` -> skip the mapper subagent, use the keyword heuristic (`--no-live-mapper`).

Scope defaults:

- wing: from runtime config `memory.projectWing` (or computed from project directory name with sortable numeric prefixes stripped, e.g. `001-SampleProject` -> `sampleproject`)
- room: from runtime config `sourceCapture.room` (default `source-transcripts`)
- query: `memory consolidation candidates`

Optional scope syntax in arguments:

- `wing=<wing> room=<room>`
- `<wing>/<room>`

Optional flags you can pass in `$ARGUMENTS`:

- `apply` -> `--apply --apply-merges`
- `all` -> `--all`
- `retry-failed` -> `--retry-failed-only`
- `fast` -> `--no-live-mapper` (the mapper subagent runs by DEFAULT; this opts out to the
  keyword heuristic, which only suits plain-text drawers — it cannot read a single-line
  JSON transcript and will score every one below the confidence floor)
- `room=<room>` -> `--room <room>` (the BASE room; processed/failed rooms are derived as
  `<room>-processed` and `<room>-failed` unless overridden. With `retry-failed`, pass the base
  room — passing `source-transcripts-failed` yields `source-transcripts-failed-failed` and 0 hits.)
- `wing=<wing>` -> `--wing <wing>`
- `processed-room=<room>` -> `--processed-room <room>`
- `failed-room=<room>` -> `--failed-room <room>`
- `no-move-already-consolidated` -> `--no-move-already-consolidated`

Examples:

- `/consolidate room=source-transcripts apply`
- `/consolidate room=transcripts apply`
- `/consolidate room=transcripts retry-failed apply`
- `/consolidate room=source-transcripts processed-room=source-transcripts-processed failed-room=source-transcripts-failed apply`
- `/consolidate fast room=source-transcripts apply`

Execution steps:

1. Parse `$ARGUMENTS` for mode/flags (`all`, `apply`, `retry-failed`, `fast`, and optional scope/room overrides).
2. Build this command from repo root: `node --experimental-strip-types src/scripts/run-memory-consolidation-and-validation.ts --query "memory consolidation candidates" --batch-size 1 [--wing "<wing>"] [--room "<room>"] [--processed-room "<room>"] [--failed-room "<room>"] [--all] [--retry-failed-only] [--no-live-mapper] [--no-move-already-consolidated] [--apply --apply-merges]`
3. Run it via shell and capture stdout JSON.
4. Summarize result for the user with:
   - `worklistMode`, `worklist.count`
   - created synthesis node IDs (if any)
   - validation status (or skipped reason)
   - mem-core output file path

Progress while it runs:

The script works one drawer at a time (`--batch-size 1`), so a large worklist takes
many minutes and prints nothing until it exits. It writes progress continuously to
`.electric-shepherd/consolidation-runs.ndjson`.

- If the shell call returns before the run finishes, or you need to report status
  mid-pass, call `consolidation_progress` — it returns the current phase, `chunkIndex`/`chunkTotal`, the examined/processed/failed counters, and
  seconds since the last update.
- A pass is advancing as long as `stale_seconds` keeps resetting. Do NOT declare it
  hung under ~120s: a single drawer's mapper pass can legitimately take that long.
- Report `chunkIndex/chunkTotal` when the user asks how far along it is. Never guess
  progress from elapsed time.

Lock behavior:

- Do not force `ESHEPHERD_CONSOLIDATION_LOCK_INHERITED` unless it is already set by the parent context.
- Otherwise let the script acquire/release its own consolidation lock.
