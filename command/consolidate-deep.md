---
description: "Consolidate deep — full pass: synthesize, validate/promote, merge, drift-check, relocate"
agent: dreamer
subtask: false
---
Take deliberate control of the dream: run a deep consolidation pass.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given)

Tool routing: follow instructions/agent-discipline.md "MemPalace command routing matrix" for every memory operation (especially synthesis vs KG vs tunnel).

Discovery safety policy:
- Use the BOUNDED batch discovery from `agents/dreamer.md`: one page, filter, begin.
- Never issue broad wing-only `list_drawers` scans, and never page a room to exhaustion.
- This pass handles ONE batch (target 25 transcripts, hard cap 50) and then stops. It does not clear the backlog. Run it repeatedly; the `consolidated-into` edge makes each pass pick up where the last left off. If a large backlog exists, say how many passes it will likely take rather than attempting it in one.
- If transcript discovery hits repeated `list_drawers` timeouts, switch to deterministic fallback discovery via: `node --experimental-strip-types scripts/run-memory-consolidation-and-validation.ts --query "memory consolidation candidates" --batch-size 25 --worklist-limit 200` Then continue this consolidate-deep flow using that worklist/result.

Steps:
1. Do everything /consolidate does (synthesize the pending raw memories). Stamp each new closet `es-status: provisional` at creation (see dreamer.md's status contract).
2. Dispatch dream-auditor to validate the closets created in step 1. Execute its recommended promotions (pass -> active) yourself before proceeding — do not merge still-provisional closets in step 3; a bad synthesis should not get folded into a canonical node before it has been checked.
3. Then run merge review over the existing synthesis nodes: detect duplicate and near-duplicate nodes and apply the high-confidence merges.
4. Run a drift audit against the memory blocks.
5. Refresh the affected mem-core files and write one dream-log diary entry covering the syntheses, the validations/promotions, the merges, and the drift findings.
6. Surface relocation proposals: any off-scope asides found while mapping, as a single numbered list with proposed target wing/room, for the user to approve or decline. Apply only what is approved; never relocate unasked.

This is the heavier pass: additive synthesis PLUS merges are allowed here. Never modify code or raw transcripts.
