---
description: Headcount — report counts of pending raw vs existing synthesis memories (isolated)
agent: dreamer
subtask: true
---
Give me a quick headcount of the flock.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Report:
- Number of unconsolidated source drawers in scope.
- Number of existing consolidated summary nodes in scope.
- Approximate backlog (source memories not yet represented in any synthesized-from summary node).
- Whether that backlog is above the auto-consolidation volume threshold
  (ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD) — i.e. whether a /count-sheep is due.

Read-only: do not write or modify any memory.
