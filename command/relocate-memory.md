---
description: Re-file memory that landed in the wrong wing/room (whole drawer, or a verbatim aside)
agent: dreamer
subtask: false
---
Re-file memory into the scope where it belongs.

Request: $ARGUMENTS (e.g. "the ElectricShepherd memory-management aside in the source_project transcripts should live in the electric_shepherd wing")

This is the DIRECT path, for when you already know something is misfiled. The normal path is automatic: `/consolidate-deep` detects off-scope asides during consolidation and proposes them for approval. Use this command to act on a specific item without waiting for a pass.

Two shapes, pick the right one:

- WHOLE DRAWER in the wrong place -> `relocate_memory` with `mode: "move"`. The drawer changes wing/room; nothing is copied or rewritten.
- AN ASIDE INSIDE a larger drawer (the usual case for a tangent inside a session transcript) -> `relocate_memory` with `mode: "excerpt"`. The verbatim passage is filed as a NEW drawer in the target scope and linked back with an `excerpted-from` edge. The source transcript is never edited — raw transcripts stay verbatim and intact.

Steps:

1. Locate the material. Use `palace_report` (wing, then wing+room) to find candidate drawers. For a large drawer, use `export_drawer` + the `drawer-digest` subagent rather than reading it inline.
2. Confirm the destination. If the target wing does not exist yet, say so — filing there creates it. Use the project's normalized wing naming; do not invent a variant of an existing wing (`electric_shepherd` vs `electricshepherd`).
3. For `mode: "excerpt"`, prefer `excerpt_start` / `excerpt_end` anchors (the exact first and last line of the passage) over retyping the text. The tool slices the passage verbatim from the stored drawer and refuses anything that does not match.
4. Run with `dry_run: true` first. Show the user: source drawer, from-scope, to-scope, and (for excerpts) the character count and verbatim confirmation.
5. Only after the user confirms, re-run with `dry_run: false`.
6. Report the resulting IDs: moved drawer, or new drawer id plus the lineage edge.

Rules:

- Never delete the source. Relocation is additive or a metadata move, never a deletion.
- Never rewrite content to "fit" the new room.
- If the passage spans several disconnected parts of a drawer, file them as separate excerpts rather than stitching them into one fabricated block.
