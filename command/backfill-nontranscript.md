---
description: Backfill non-transcript rooms — run consolidation script per room (dry-run default)
agent: build
subtask: false
---
Run non-transcript memory backfill for a wing.

Arguments: $ARGUMENTS

Execution:

1. Build command from repo root: `node --experimental-strip-types scripts/run-nontranscript-backfill.ts [args]`
2. Pass `$ARGUMENTS` through verbatim.
3. Stream output so the user sees:
   - selected wing + resolved room list
   - per-room progress `[i/N] room=<name>`
   - final JSON summary with failures (if any)

Defaults:

- Requires a wing from `--wing` or runtime config (`memory.projectWing`).
- Excludes transcript-like rooms unless `--include-transcript-like` is provided.
- Runs dry-run by default; apply with `--apply` (and optional `--apply-merges`).

Useful args:

- `--wing <wing>`
- `--rooms room-a,room-b`
- `--exclude-rooms source-transcripts,transcripts`
- `--max-rooms 40`
- `--batch-size 1`
- `--worklist-limit 200`
- `--query "non-transcript memory consolidation"`
- `--apply`
- `--apply-merges`

This command is agent-oriented orchestration; it fans out room-by-room and delegates each room to the existing consolidation engine.
