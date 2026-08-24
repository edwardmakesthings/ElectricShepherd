---
description: Memory refresh — report what mem-core currently holds for this scope, and whether it is stale
agent: dreamer
subtask: false
---
Show me the working memory that is actually loaded for this scope.

Scope: $ARGUMENTS (default: the current working directory)

## What this command can and cannot do

mem-core is NOT independently re-renderable. The render happens inside the consolidation
script (`run-memory-consolidation-and-validation.ts`), gated on `--include-base-pipeline`
and on that run actually producing consolidation output — with no output it reports
`missing consolidation outputs` and writes nothing. There is no standalone render entry
point. So this command REPORTS the current state; `/consolidate` is what refreshes it.

Do not attempt to re-render here, and do not synthesize or merge.

## Steps

1. Load the scoped memory files from repo root:

   `node --experimental-strip-types scripts/run-mem-core-loader.ts --start-dir "<scope>" --format json`

   Omit `--start-dir` to use the current directory. Add `--strict` to exit non-zero when
   nothing is found.

2. Report from that output:
   - Each loaded file: path, `sourceType` (`direct` = a `memory.md` sitting in the scope
     directory, `store` = the rendered file under `.electric-shepherd/memory`),
     `scopeDirectory`, and size.
   - The scope ladder, broad (workspace root) to narrow (current directory) — this is the
     order they merge in, so a narrow file refines a broad one.
   - Total bytes loaded. Call it out if it is large; mem-core rides in every prompt.

3. Judge staleness and say so plainly:
   - If NO files loaded: mem-core has never been rendered for this scope. Say that
     directly rather than reporting an empty success.
   - Compare the newest rendered file's timestamp against recent consolidation activity
     (`/memory-status`). If consolidation has run since the last render, mem-core is
     behind.

4. End with the next action:
   - Stale or empty -> `/consolidate` (renders mem-core as part of the pass).
   - Content missing that you expected -> it may still be `es-status: provisional`;
     rendering excludes provisional closets by default. Run `/memory-status` to check, or
     dispatch dream-auditor to validate and promote it.
   - Current -> say so and stop.
