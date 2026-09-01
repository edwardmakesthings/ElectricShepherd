# Spec: memory phases 6–11 — outcome, prospective, negative, scope, time

Continues the unified-memory spec (phases 1–5: source-type axis, authority-aware
retrieval, doc ingestion, cross-type linking, skills).

---

## The rule that governs every phase below

**No phase is complete until something READS what it writes.**

This project has already shipped this bug at full scale: mem-core was rendered correctly
for weeks while `instructions` was absent and all four injection toggles were off. The
pipeline was flawless and the output reached nothing. Consolidation ran, validated,
promoted, and rendered — into a void.

So every phase here is specified as three parts, and a phase with an empty CONSUME
section is not a feature, it is a liability that costs write-time and returns nothing:

- **CREATE** — what gets written, by whom, when.
- **CONSUME** — what reads it, and how it changes a decision.
- **PROVE** — a check that demonstrates the read path actually fires. Not "the field
  exists"; "a decision changed because of it."

---

## Phase 6 — audit phases 1–5 for consumption. Build nothing new.

Before adding memory types, verify the existing ones are read. For each of:
`es-source-type`, the authority weight, ingested docs, `concerns` edges, and skills —
answer with evidence, not inspection of intent:

1. What code path reads it?
2. Show one worked example where its presence changed a ranking, a routing decision, or
   an output. Print the before/after scores.
3. If nothing reads it, say so plainly and stop. That is the finding.

`concerns` (phase 4) is the likeliest gap: the spec asked retrieval expansion to pull
`concerns` neighbours alongside `synthesized-from`, which is easy to write and easy to
leave unwired. Check it specifically.

Report findings and STOP for review before phase 7.

---

## Phase 7 — outcome feedback

Electric Shepherd records what happened, never whether it worked. The signal already
exists and is discarded every turn.

### CREATE

Add predicate `es-outcome` with values `accept | revise | failed | unused`.

Sources of truth, all already emitted:
- `review-diff` returns `VERDICT: ACCEPT` / `VERDICT: REVISE`.
- `run-tests` returns pass/fail.
- turn-guard logs loop and spiral interventions per session.
- the delegation tier that actually resolved a unit (local / cloud / deep).

**Attribution is the hard part, and getting it wrong poisons the data.** An outcome must
attach to the memories that were actually consulted, not to everything in scope.
Retrieval already returns `selected_nodes`; record that set against the unit of work, and
attach the outcome to exactly those ids when the cycle closes. If the set cannot be
determined, write NOTHING rather than attributing broadly — a closet blamed for a failure
it had no part in is worse than no signal.

Outcomes accumulate; do not overwrite. A closet with 6 accepts and 1 revise is different
from one with 1 accept.

### CONSUME

`adapter/retrieval-expansion.ts` gains an outcome term in ranking: net-positive outcomes
boost, repeated `revise` penalises. Weight it BELOW authority — a doc with no outcome
history must still outrank a synthesis that happens to have two accepts.

Second consumer: a closet accumulating `revise` outcomes is a re-synthesis candidate.
Surface it in `/memory-status`, the same way provisional backlog is surfaced.

### PROVE

Retrieve for a query twice — once with outcomes stripped, once with them present — and
show the ranking differing. State which node moved and why.

---

## Phase 8 — prospective memory (remember to do X when Y)

Absent entirely, and generated constantly. Every session produces items like "watch PR
#25165 for Laguna support" or "verify cached_tokens returned after the revert." They land
in an `OPEN_ITEMS` field and are never surfaced at the moment they matter.

The distinguishing property: prospective memory is **pushed by circumstance, not pulled by
query**. Nobody searches for a reminder; it has to arrive.

### CREATE

Predicate `triggers-on`, with condition values of three kinds:
- path/glob — `web/src/features/controlPanel/**`
- topic keyword — `llama.cpp`, `prompt caching`
- scope — a wing/room

Written two ways: a `/remind <condition> <what>` command for explicit capture, and
proposed by consolidation from `OPEN_ITEMS` entries that carry a clear condition. Proposed
reminders follow the relocation pattern — numbered list, user approves, never auto-filed.

**Every reminder needs an expiry or a satisfaction condition.** A reminder that fires
forever becomes noise, and noise in mem-core is expensive because mem-core rides in every
prompt. No expiry, no reminder.

### CONSUME

mem-core render. It is already directory-scoped, which is exactly the matching mechanism:
a reminder whose `triggers-on` matches the current scope renders into that scope's
`memory.md` under a `[pending]` block. Cap it hard — a handful of reminders, not a task
list — and drop expired ones at render time.

### PROVE

File a reminder against a path glob, render mem-core for a directory inside that glob and
one outside it, and show it present in the first and absent in the second.

---

## Phase 9 — negative knowledge (what was ruled out)

The system stores what worked (`apprenticeship`, `ROOT_CAUSES_AND_WORKED_EXAMPLES`) and
discards what failed. Dead ends are the most expensive knowledge to relearn.

### CREATE

Add a `DEAD_ENDS` output section to `dream-mapper` and `drawer-digest`, alongside the
existing sections. One line each: what was tried, what happened, why it was abandoned.
Distinguish "tried and failed" from "considered and rejected" — the second is cheaper and
weaker evidence.

File these as drawers with `es-source-type: synthesis` and predicate
`rules-out` linking to the topic or approach. Do NOT invent a fourth source-type; a dead
end is a synthesis with negative polarity, not a different kind of thing.

### CONSUME

Retrieval returns dead-ends alongside positive knowledge for a matching topic —
**explicitly labelled as ruled out.**

This is the phase's main risk and it must be handled at render, not left to inference: an
unlabelled dead end reads as a suggestion. "We tried cache_control injection on the
openai/ prefix" looks like advice unless it carries "— this does not work, LiteLLM strips
the marker." Render negative knowledge with an explicit marker, and never let a dead-end
snippet appear without its outcome clause attached.

### PROVE

Query a topic with a known dead end. Show it returned, show it labelled, and show that the
label survives into the mem-core render rather than being stripped by summarisation.

---

## Phase 10 — procedural scope (skills that cross projects)

Phase 5 files skills into the project wing. But "how I diagnose a caching regression" or
"how I verify a plugin actually loaded" transfers everywhere; only project-specific
procedure should stay wing-locked.

Episodic memory should remain project-scoped. Procedural mostly should not.

### CREATE

- Skills default to the project wing (phase 5 behaviour, unchanged).
- A skill used successfully in N distinct projects (N=2 to start) becomes a **promotion
  candidate** to a shared skills wing. Promotion is proposed, never automatic, and uses
  the existing `relocate_memory` machinery with a `promoted-from` lineage edge so the
  origin stays traceable.
- Promotion is a distinct operation from relocation: relocation fixes misfiling, promotion
  generalises something correctly filed. Do not overload one command with both.

### CONSUME

**Retrieval must search the project wing AND the shared skills wing — for procedural
queries only.** This is the real change; current retrieval is single-wing. Scope every
other memory type as it is today. A cross-wing search for episodic memory would surface
another project's transcripts, which is the failure mode wing-scoping exists to prevent.

### PROVE

Promote a skill, then run a procedural query from a different project's wing and show the
skill returned. Run an episodic query from the same place and show cross-wing results
absent.

---

## Phase 11 — temporal validity

The substrate supports it (`kg_add` takes `valid_from`, `kg_invalidate` retires facts);
the policy layer ignores it. A doc-derived fact about a library three major versions stale
is still `active`.

### CREATE

- Stamp `valid_from` on doc-derived facts at ingestion.
- On re-mine, detect changed source files and `kg_invalidate` facts derived from the prior
  version rather than leaving both live.
- A synthesis with a `concerns` edge to a doc that has since changed gets flagged
  `es-staleness: source-changed`. Flag, do not auto-invalidate — the synthesis may still
  be correct, and silent deletion of possibly-good knowledge is worse than a flag.

### CONSUME

Retrieval deprioritises flagged nodes and surfaces the flag in the result, so the reader
knows the basis moved. `/memory-status` reports the count as its own backlog category,
alongside provisional.

### PROVE

Ingest a doc, synthesise from it, change the doc, re-mine, and show the synthesis flagged
and deprioritised — without having been deleted.

---

## Guardrails (each of these has actually shipped in this repo)

- **Declaration order:** a `const` used above its declaration is a temporal-dead-zone
  `ReferenceError` that silently disables the entire plugin at load.
- **Never page a room to exhaustion.** Take one bounded page and begin.
- **Verify a tool exists and is granted before building on it.** Agents here have been
  granted tools they were told not to use, and told to use tools they were denied.
- **A capability needs the tool grant AND the prompt AND the permission.** Missing any one
  fails silently.
- **Do not add a new predicate where an existing one fits.** Check the reserved set first;
  `synthesized-from`, `consolidated-into`, `merged-into`, `in-hall`, `es-status`,
  `es-source-type`, `concerns` are all live and consumed by traversal logic.
- **Every new mem-core render addition must be capped.** mem-core rides in every prompt;
  an uncapped section is a permanent per-request tax.

## Verify before reporting

- Typecheck.
- For EVERY phase: the PROVE step, with actual output pasted. A phase without its proof is
  reported as incomplete, not done.
- Confirm no new predicate collides with the reserved set above.
- Confirm mem-core render size before and after; state the delta in tokens.

## Report

- FILES: each path touched, what changed
- VERIFIED: commands run, plus each phase's PROVE output
- CONSUME AUDIT: for each phase, the one line naming what reads it
- NOTES: assumptions, anything that looked wrong, scope deliberately not touched
