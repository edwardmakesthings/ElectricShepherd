---
description: Save transcript — force-capture THIS session's transcript into MemPalace right now
agent: build
subtask: false
---
Call the `capture_transcript` tool right now for this session. Do not shell out or write a script yourself — the tool resolves the session ID and project scope correctly; a manual bash invocation will not.

Arguments: $ARGUMENTS

Argument handling:

- No arguments: call `capture_transcript` with no args (uses the configured default capture mode).
- `mode=append` / `mode=replace` / `mode=hybrid`: pass that as the `mode` argument.
- Anything else in `$ARGUMENTS`: pass it as the `reason` argument (recorded in the capture event log).

After the call, report:
- Whether it succeeded (`ok`).
- The mode actually used.
- Anything notable in the tool's output (e.g. `stored`, `updated`, `skipped-duplicate`, `skipped-unchanged`).

This captures the CURRENT state of the conversation. It does not wait for idle or compaction, and it does not run consolidation — the transcript still needs a `/count-sheep` (or auto-consolidation) pass afterward to turn it into synthesized memory.
