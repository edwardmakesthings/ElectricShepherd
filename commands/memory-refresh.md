---
description: Memory refresh — preview or rebuild scoped mem-core from existing validated memory
agent: dreamer
subtask: false
---
Refresh the resident memory for: $ARGUMENTS (default: the current working directory).

`/memory-refresh [scope]` previews the rebuilt file. `/memory-refresh apply [scope]`
requests applying it. Treat the scope as a path, not as shell instructions.

## Behavior

Rebuild from current, active synthesis drawers and their stored facts, plus active
reminders matching the scope. Exclude provisional, retired, and merged-away nodes;
expired graph facts must not affect eligibility. Replace the old generated file,
rather than appending, so removed content and obsolete pointers disappear.

Rendering is deterministic: no consolidation, synthesis, validation, merges, or
model worker calls. This command writes no palace drawers or KG facts. Never
hand-edit mem-core or promote a provisional node just to make it visible.

## Steps

1. Resolve the consumer project's scope and the Electric Shepherd installation
   (`ESHEPHERD_ROOT` when set; otherwise the project checkout). Run its script:

   `node --experimental-strip-types "<ESHEPHERD_ROOT>/src/scripts/run-mem-core-refresh.ts" --start-dir "<scope>"`

   The project wing is resolved from that workspace's configuration. Use `--wing`
   only when the user explicitly names a different wing. An optional `--room`
   narrows the palace source set; the default scans all rooms in the project wing.

2. Show the preview: target file, wing, scanned/eligible counts, selected source
   IDs, whether the file would change, and the rebuilt markdown. If no eligible
   memory remains, explain that applying will clear the old derived content.
   A failed or incomplete read must leave the existing file untouched; report the
   error rather than claiming an empty success or running consolidation instead.

3. Stop without writing unless the user requested `apply` or confirms the preview.
   After approval, repeat the same command with `--apply`. Report `fileWritten`
   and the exact target path. Direct `memory.md` files and other scopes are not
   rewritten.

4. Verify composition with the read-only loader:

   `node --experimental-strip-types "<ESHEPHERD_ROOT>/src/scripts/run-mem-core-loader.ts" --start-dir "<scope>" --format json`

   Report additional direct or ancestor files separately; a scoped rebuild does
   not replace them. Generated renders must match the current project, wing, and
   directory scope; unverified legacy renders are skipped until rebuilt. Empty
   memory injects nothing. V2 waits for revalidation when its cache expires;
   verify a subsequent context without forcing a shared restart.
