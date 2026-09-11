---
description: Memory status — quick counts, plus an optional bounded preview of what's pending
agent: dreamer
subtask: true
---
Report memory status for: $ARGUMENTS (default: this project's wing).

Call `palace_flock_status` once, with the wing from the arguments. It already
computes every number below at parent-drawer granularity — do not enumerate
drawers, and do not call other tools to recompute what it returned.

Render its fields:

- `counts.unconsolidated_source_drawers` — waiting for a synthesis pass.
- `counts.consolidated_summary_nodes` — syntheses that exist.
- `counts.provisional_summary_nodes` — synthesized but not yet validated. Needs a validation pass, not a synthesis pass.
- `counts.re_synthesis_candidates` — repeatedly revised; their synthesis should be redone, not just validated.
- `staleness` — syntheses whose source doc changed since synthesis. Advisory: re-validate or re-synthesize, never delete on this basis. Flagged docs themselves are surfaced by retrieval deprioritisation, not by this count.
- `threshold` / `next_action` — whether a pass is due.

Include `detail` in the arguments to also list a bounded sample (max 25) from
`re_synthesis.candidates` and `staleness.candidates`, with their accept/revise
counts. Say "sampled N of approximately M" rather than enumerating a backlog.

Read-only: never call `add_drawer`, `kg_add`, or `apply_merge`.

End with the next action `palace_flock_status` reported, naming the specific
closets when it flagged any.
