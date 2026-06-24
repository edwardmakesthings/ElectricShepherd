---
description: Herd — round up pending raw memories and preview what would consolidate (read-only, isolated)
agent: dreamer
subtask: true
---
Round up the flock: show me what is pending consolidation WITHOUT writing anything.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Steps:
1. List the unsynthesized mem-raw drawers in scope and group them by topic/source.
2. Describe the synthesis nodes that a consolidation pass WOULD create or update.
3. Flag any low-confidence or single-source items that would be skipped.

Read-only dry run: do NOT call create_synthesis_node, apply_merge, or modify any
memory. Just tell me what /count-sheep would do.
