---
description: Count sheep — consolidate pending raw memories into synthesis nodes (isolated dreamer pass)
agent: dreamer
subtask: true
---
Run a standard memory consolidation pass now, in this session, so I can watch it work.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Steps:
1. Establish the watermark from the latest dream-log diary entry.
2. Find the unsynthesized mem-raw drawers in scope.
3. Map each in-scope transcript, then reduce the mapper summaries into consolidated
   mem-synth nodes using the substrate graph tools (create_synthesis_node).
4. Refresh the affected mem-core memory files through the render path.
5. Write one dream-log diary entry summarizing what was consolidated, what was
   deferred, and any low-confidence items.

This is the standard, additive pass: synthesize raw into synth nodes only — do NOT
merge or dedupe existing synthesis nodes here. Never modify code or raw transcripts.
