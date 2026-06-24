---
description: Headcount — report counts of pending raw vs existing synthesis memories (isolated)
agent: dreamer
subtask: true
---
Give me a quick headcount of the flock.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Report:
- Number of unsynthesized mem-raw drawers in scope.
- Number of existing synthesis nodes in scope.
- Approximate backlog (raw memories not yet represented in any synthesis node).
- Whether that backlog is above the auto-synth volume threshold
  (ESHEPHERD_AUTO_SYNTH_MESSAGE_THRESHOLD) — i.e. whether a /count-sheep is due.

Read-only: do not write or modify any memory.
