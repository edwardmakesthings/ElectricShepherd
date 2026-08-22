---
description: Consolidate — run worklist-first consolidation script (dry-run by default)
agent: build
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

Scope defaults:

- wing: from runtime config `memory.projectWing` (or computed from project directory name with sortable numeric prefixes stripped, e.g. `001-SampleProject` -> `sampleproject`)
- room: from runtime config `sourceCapture.room` (default `source-transcripts`)
- query: `memory consolidation candidates`

Optional scope syntax in arguments:

- `wing=<wing> room=<room>`
- `<wing>/<room>`

Execution steps:

1. Parse `$ARGUMENTS` for `all`, `apply`, and optional scope overrides.
2. Build this command from repo root: `node --experimental-strip-types scripts/run-memory-consolidation-and-validation.ts --query "memory consolidation candidates" --batch-size 25 [--wing "<wing>"] [--room "<room>"] [--all] [--apply --apply-merges]`
3. Run it via shell and capture stdout JSON.
4. Summarize result for the user with:
   - `worklistMode`, `worklist.count`
   - created synthesis node IDs (if any)
   - validation status (or skipped reason)
   - mem-core output file path

Lock behavior:

- Do not force `ESHEPHERD_CONSOLIDATION_LOCK_INHERITED` unless it is already set by the parent context.
- Otherwise let the script acquire/release its own consolidation lock.
