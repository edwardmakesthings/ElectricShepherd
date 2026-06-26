---
description: Count sheep — run worklist-first consolidation script (dry-run by default)
agent: build
subtask: false
---
# Count Sheep

Run the consolidation script directly (NOT the interactive dreamer agent path).

Arguments: $ARGUMENTS

Argument modes:

- `/count-sheep` -> dry run, unsynthesized worklist only.
- `/count-sheep apply` -> commit unsynthesized worklist (`--apply --apply-merges`).
- `/count-sheep all` -> dry run, full-scope reprocess (`--all`).
- `/count-sheep all apply` -> commit full-scope reprocess (`--all --apply --apply-merges`).

Scope defaults:

- wing: `context-blocks`
- room: `context-blocks`
- query: `memory consolidation candidates`

Optional scope syntax in arguments:

- `wing=<wing> room=<room>`
- `<wing>/<room>`

Execution steps:

1. Parse `$ARGUMENTS` for `all`, `apply`, and optional scope overrides.
2. Build this command from repo root:
   `node --experimental-strip-types scripts/run-memory-consolidation-and-validation.ts --query "memory consolidation candidates" --wing "<wing>" --room "<room>" --batch-size 25 [--all] [--apply --apply-merges]`
3. Run it via shell and capture stdout JSON.
4. Summarize result for the user with:
   - `worklistMode`, `worklist.count`
   - created synthesis node IDs (if any)
   - validation status (or skipped reason)
   - mem-core output file path

Lock behavior:

- Do not force `ESHEPHERD_SYNTH_LOCK_INHERITED` unless it is already set by the parent context.
- Otherwise let the script acquire/release its own synth lock.
