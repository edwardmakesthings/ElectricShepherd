---
description: Herd — round up pending raw memories and preview what would consolidate (read-only, isolated)
agent: dreamer
subtask: true
---
Round up the flock: show me what is pending consolidation WITHOUT writing anything.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Steps:
1. List the unconsolidated source drawers in scope and group them by topic/source.
2. Describe the derived drawers that a consolidation pass WOULD create or update.
3. Flag any low-confidence or single-source items that would be skipped.
4. Separately, list existing closets with `es-status: provisional` in scope — these were already synthesized but never validated/promoted, so they are currently hidden from default retrieval. This is a different backlog than item 1 (nothing new to synthesize, just nothing yet run through dream-auditor).

Read-only dry run: do NOT call add_drawer, kg_add, apply_merge, or modify any memory. Just tell me what /count-sheep would do.
