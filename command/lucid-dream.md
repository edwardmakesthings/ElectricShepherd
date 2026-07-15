---
description: Lucid dream — deep consolidation pass that also merges and dedupes existing synthesis nodes (isolated)
agent: dreamer
subtask: false
---
Take deliberate control of the dream: run a deep consolidation pass.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Tool routing: follow instructions/agent-discipline.md "MemPalace command routing matrix"
for every memory operation (especially synthesis vs KG vs tunnel).

Steps:
1. Do everything /count-sheep does (synthesize the pending raw memories). Stamp each new
   closet `es-status: provisional` at creation (see dreamer.md's status contract).
2. Dispatch dream-auditor to validate the closets created in step 1. Execute its
   recommended promotions (pass -> active) yourself before proceeding — do not merge
   still-provisional closets in step 3; a bad synthesis should not get folded into a
   canonical node before it has been checked.
3. Then run merge review over the existing synthesis nodes: detect duplicate and
   near-duplicate nodes and apply the high-confidence merges.
4. Run a drift audit against the memory blocks.
5. Refresh the affected mem-core files and write one dream-log diary entry covering
   the syntheses, the validations/promotions, the merges, and the drift findings.

This is the heavier pass: additive synthesis PLUS merges are allowed here. Never
modify code or raw transcripts.
