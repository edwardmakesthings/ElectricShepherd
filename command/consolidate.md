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
- `/consolidate live` -> dry run + live mapper/auditor subagents (`--use-live-mapper --use-live-auditor`).
- `/consolidate live apply` -> commit + live mapper/auditor (`--use-live-mapper --use-live-auditor --apply --apply-merges`).

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
- `live` -> `--use-live-mapper --use-live-auditor`
- `room=<room>` -> `--room <room>`
- `wing=<wing>` -> `--wing <wing>`
- `processed-room=<room>` -> `--processed-room <room>`
- `failed-room=<room>` -> `--failed-room <room>`
- `no-move-already-consolidated` -> `--no-move-already-consolidated`

Examples:

- `/consolidate room=source-transcripts apply`
- `/consolidate room=transcripts apply`
- `/consolidate room=transcripts retry-failed apply`
- `/consolidate room=source-transcripts processed-room=source-transcripts-processed failed-room=source-transcripts-failed apply`
- `/consolidate live room=source-transcripts apply`

Execution steps:

1. Parse `$ARGUMENTS` for mode/flags (`all`, `apply`, `retry-failed`, `live`, and optional scope/room overrides).
2. Build this command from repo root: `node --experimental-strip-types scripts/run-memory-consolidation-and-validation.ts --query "memory consolidation candidates" --batch-size 1 [--wing "<wing>"] [--room "<room>"] [--processed-room "<room>"] [--failed-room "<room>"] [--all] [--retry-failed-only] [--use-live-mapper --use-live-auditor] [--no-move-already-consolidated] [--apply --apply-merges]`
3. Run it via shell and capture stdout JSON.
4. Summarize result for the user with:
   - `worklistMode`, `worklist.count`
   - created synthesis node IDs (if any)
   - validation status (or skipped reason)
   - mem-core output file path

Lock behavior:

- Do not force `ESHEPHERD_CONSOLIDATION_LOCK_INHERITED` unless it is already set by the parent context.
- Otherwise let the script acquire/release its own consolidation lock.
