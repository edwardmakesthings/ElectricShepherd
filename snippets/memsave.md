---
description: Check for content that should be committed to memory
---

[Memory Checkpoint] Run a two-part memory check for this session. These are independent — answer both; either can warrant saving on its own.

PART 1 — Did durable STATE change? (updates the always-loaded blocks)
Check each block and update any that changed:
- project-state — architecture, active work, or a major decision changed?
- active-conventions — a naming/style/structural/tooling rule changed?
- user-preferences — a new durable preference was stated?
For each changed block: write/update the corresponding durable mem-synth facts (add_drawer, kg_add, or create_synthesis_node) and let the runtime regenerate directory-scoped mem-core files. Keep each block to a few hundred tokens. mem-core is file-only and does not round-trip into MemPalace drawers.

PART 2 — Was substantive WORK done, or something LEARNED? (diary / worked example)
This applies EVEN IF no block changed. Save a synthesized entry if any of these happened:
- A feature/component/fix was implemented (what was built, where, key choices made).
- A bug's root cause was found (the cause, not just the fix — this is high-value recall).
- A non-obvious "how this works" or "why this behaves this way" was discovered.
- A problem was solved in a way worth reusing → file it as a worked example in the apprenticeship room, framed as "here's how a problem of this class was solved."
- A dead end was hit that's worth not repeating (what was tried, why it failed).
Use diary_write for session work records, kg_add for discrete durable facts, add_drawer for findings, the apprenticeship room for reusable worked examples. Synthesize — don't dump a transcript; write what a future session would actually want to retrieve.

IF this session's work appears already done / already correct / a continuation of prior work: do NOT assume a prior session already saved it — you cannot see whether that happened. SEARCH MemPalace (diary/drawers) for an entry covering this specific work before concluding nothing needs saving. Found a matching entry → genuinely a no-op, cite it. Found NO matching entry → this is unsaved work regardless of which session did it — save it now. Never claim "a previous session should have handled this" without having searched and found evidence it did.

Important:
- Do NOT invent changes to have something to write. But "no block changed" is NOT the same as "nothing to save" — implementation work and discoveries belong in PART 2.
- Do NOT reconstruct identifiers/values from memory when writing — read the source first, copy exact characters (local models corrupt near-copy tokens).
- End by listing what you saved under each part, or stating that part genuinely had nothing.