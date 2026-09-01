# Spec: memory phases 12–16 — domain, demonstration, routing, failure modes, calibration

Continues phases 1–5 (source-type, authority retrieval, docs, linking, skills) and 6–11
(consumption audit, outcome, prospective, negative, procedural scope, temporal validity).

**The rule from phase 6 still governs: no phase is complete until something READS what it
writes.** Every phase below specifies CREATE / CONSUME / PROVE, and PROVE means showing a
decision that changed — not that a field exists.

These four phases share a purpose distinct from 1–11: those built *what the system knows*.
These build *what the system knows about itself* — which models work, on what, with what
evidence, and how to hand them a worked example instead of a description.

---

## Phase 12 — domain axis on skills (AMENDMENT to phase 10, must land WITH it)

Phase 10 promotes a successful skill from a project wing to a shared wing. Without a
domain axis, a **writing** skill promoted that way surfaces in **coding** contexts, and
cross-project promotion actively degrades relevance the moment two unlike projects exist.

If phase 10 promotion is already enabled, do this first and backfill before promoting more.

### CREATE

Predicate `es-domain` on skill drawers: `code | writing | infra | research | general`.
Extend the value set deliberately rather than letting it grow ad hoc — a domain vocabulary
that drifts is a room-sprawl problem wearing different clothes.

- Set at skill creation, inferred from the project's own domain where obvious.
- `general` is for skills that genuinely transfer everywhere ("how I verify a plugin
  actually loaded"). Use it sparingly; it is the default that makes the axis useless if
  overused.
- Promotion to the shared wing REQUIRES an explicit domain. A skill with no domain cannot
  be promoted.

### CONSUME

Procedural retrieval (the cross-wing path from phase 10) filters on `es-domain`, matching
the current project's domain plus `general`. Never return a `writing` skill to a `code`
project.

### PROVE

Promote one `writing` and one `general` skill. Run a procedural query from a code project
and show the `general` one returned and the `writing` one absent.

---

## Phase 13 — worked-example injection (cheapest, do this first)

The `apprenticeship` room already collects worked examples that `deep-solver` files after
solving something hard. They are currently *reference material* — retrieved as background
if they happen to rank. They are not used as **demonstration**.

That distinction is the whole phase. In-context demonstration is the strongest documented
lever for small models, and these examples were solved by an expensive model, in this
codebase, in this style. Right now each one pays off once. This makes them pay repeatedly.

### CREATE

Mostly already done — `deep-solver`'s Teach step files the examples. Two additions:

- Stamp `es-source-type: worked-example`. Decision made during Phase 13 implementation:
  worked examples are a distinct knowledge class from procedural skills, so they get
  their own source type. The CONSUME side admits both `worked-example` (new filings)
  and `skill` (pre-existing drawers) for backward compatibility.
- Record the **problem shape** the example addressed, not just the solution: what made it
  hard, what class of task it was. Retrieval matches on the problem, not the answer.

Widen the source: an example should also be filed when a **local** worker succeeds on
something that previously failed, not only when `deep-solver` runs. That is the case where
the demonstration is most useful and it is currently never captured.

### CONSUME

When `orchestrate-cloud` delegates a unit to `@implement-local`, retrieve the 1–2 most
similar worked examples and inject them into the delegation prompt as **demonstrations** —
framed as "here is how this class of problem was solved in this codebase before," not as
generic context.

Hard cap at 2 examples. This is prompt real estate on every delegation; three mediocre
matches are worse than one good one. If nothing scores above a relevance floor, inject
nothing rather than padding.

### PROVE

Take a task class with an existing worked example. Run one delegation with injection off
and one with it on, and show the difference — in the diff produced, the review verdict, or
the number of revise cycles. State honestly if there is no observable difference.

---

## Phase 14 — capability memory (learned routing)

This is the phase that addresses cost directly.

Escalation is currently a judgment made in the moment, with no evidence, under an
asymmetry that guarantees over-escalation: escalating unnecessarily costs money quietly,
under-escalating costs a visible failed cycle. The rational move under uncertainty is
always to escalate. That is exactly what happened last month.

Phase 7 produced the data to replace the judgment with a lookup.

### CREATE

On unit completion, record a tuple: **task shape**, tier that ran it, outcome.

Task shape must be cheap and deterministic to compute — this is the part to get right, and
the part most likely to be over-engineered:
- file types touched (`.ts`, `.py`, `.scss`)
- unit size bucket (single-file / few-file / cross-cutting)
- work class (new feature / bug fix / refactor / config change)
- whether it touched a known-hard area (concurrency, type-system, migration)

Do NOT use an embedding of the task description. It is unstable across phrasings, and
routing decisions must be explainable — you need to be able to read why a tier was chosen.

### CONSUME

`orchestrate-cloud` queries this before choosing a tier and states the evidence in its
plan: *"local has succeeded on 9 of 11 refactors in this repo; on type-system work it is 1
of 6."* That turns the three-tier prompt heuristic into a table.

**Fail safe:** below a minimum sample count (start at 5 for a given shape), report "no
data" and fall back to current behaviour. A routing decision from two data points is
superstition, and confidently wrong routing is worse than the honest guess it replaced.

### PROVE

Show two routing decisions for different task shapes where the recommendation differs, and
print the counts behind each. Then show a third shape with insufficient data falling back
to default behaviour.

---

## Phase 15 — per-model failure-mode memory

You already know these anecdotally: Qwen spirals before acting, Devstral under-thinks,
Gemma is grounded but slow. **turn-guard is already logging the evidence** — loop nudges,
spiral detections, cycle counts — and none of it is attributed per model or task class.

### CREATE

Attribute existing turn-guard events by model and task shape (reuse phase 14's shape
function; do not write a second one). Persist as facts against a per-model node rather than
per session, so the pattern accumulates.

Also capture **prompt interventions that worked**. This project has already learned that
"stop and move forward" breaks a loop while "continue, you're looping, finish then move
forward" does not. That is durable procedural knowledge about a specific model and it
currently lives only in a chat log.

### CONSUME

Two readers:

1. **Routing** — feeds phase 14. A model whose outputs get REVISE'd on a task class should
   lose to a sibling on that class, independent of overall capability.
2. **Targeted prompt patches** — a model that spirals on a task class gets the relevant
   instruction injected **only when that class comes up**, rather than carrying the warning
   in every prompt forever. This is the mechanism that keeps agent prompts from growing
   monotonically as you learn more about each model's quirks.

### PROVE

Show one task class where the model recommendation differs from the overall-capability
ranking, with the failure counts behind it. Show one prompt patch injected for a matching
task and absent for a non-matching one.


---

## Phase 16 — confidence calibration

Your agents self-report `CONFIDENCE: high|medium|low` (dream-mapper, drawer-digest,
build's end-of-loop line). Self-reported confidence is famously badly calibrated, and
yours is by your own account "often not great." That makes it worse than useless right
now: it is a signal the orchestrator can read but cannot trust, which is exactly the
condition that produces precautionary escalation.

Phase 7 gives you the ground truth to measure it against. This phase turns a vibe into a
number.

### CREATE

For every completed unit that carried a self-reported confidence, record the pair:
`(model, self_reported_confidence, actual_outcome)`. The outcome is phase 7's
`es-outcome` — reuse it, do not introduce a second notion of success.

Persist as facts on the per-model node from phase 15, NOT per session, so the curve
accumulates. Key by model AND task shape (phase 14's shape function — the same one, a
third implementation would be the drift problem again). Calibration is not uniform: a
model may be well calibrated on refactors and wildly overconfident on type-system work,
and a single global number would hide exactly the case you need.

**Minimum sample before reporting anything: 20 pairs per (model, confidence-level) cell.**
Below that, report "insufficient data" and nothing else. A calibration curve built on five
points is confidently wrong about confidence, which is worse than the uncalibrated signal
it replaced — and it will be believed BECAUSE it looks quantitative.

### CONSUME

Two readers, and the first is the point of the phase:

1. **Escalation triggers.** `orchestrate-cloud` reads the curve, not the raw label:
   *"local reported high; local's high on this task shape is 62% accurate."* A high
   report from a poorly-calibrated model becomes weak evidence rather than a green light.
   This converts confidence from decoration into an input, and it is where the
   over-escalation asymmetry from phase 14 actually gets corrected — you escalate on
   measured unreliability rather than on nervousness.
2. **Reporting.** `/memory-status` surfaces calibration per model, so drift is visible.
   A model that was well calibrated and stops being so is a signal something changed —
   a sampling-param edit, a quant swap, a prompt change.

### PROVE

Show one calibration table with real counts (model x confidence-level x hit rate). Then
show two escalation decisions on the SAME self-reported confidence where the routing
differs because the models' curves differ. Then show a third case falling back to default
behaviour on insufficient data.

---

## Ordering

13 → 12 → 15 → 14 → 16.

13 is cheapest and gives an immediate capability bump. 12 is urgent only if phase 10
promotion is live. 15 mostly re-reads data turn-guard already emits. 14 is the highest
value but needs the largest sample before it can be trusted, so start collecting early and
enable the consumer late.

16 is last for a hard reason: it needs BOTH phase 7 outcomes and phase 14's shape function
to exist, and it needs volume neither will have on day one. Start WRITING the pairs as soon
as phase 7 lands — the data is cheap to collect and impossible to backfill — but keep the
consumer disabled until the cells are populated.

## Guardrails (each has shipped in this repo)

- **Declaration order:** a `const` used above its declaration is a temporal-dead-zone
  `ReferenceError` that silently disables the whole plugin at load.
- **Never page a room to exhaustion.** One bounded page, then begin.
- **A capability needs the tool grant AND the prompt AND the permission.** Missing one
  fails silently.
- **Do not add a predicate where an existing one fits.** Live and consumed:
  `synthesized-from`, `consolidated-into`, `merged-into`, `in-hall`, `es-status`,
  `es-source-type`, `es-outcome`, `concerns`, `triggers-on`, `rules-out`, `es-staleness`.
- **Every prompt-injected addition must be capped**, and every mem-core addition doubly so
  — it rides in every request.
- **One shape function.** Phases 14, 15 and 16 all key on task shape; two implementations
  that drift apart produce routing, failure and calibration data that cannot be joined.
- **Never report a statistic below its minimum sample.** A quantitative-looking number gets
  believed more readily than a hedge; an undersampled calibration figure is the most
  dangerous output in this whole spec.

## Verify before reporting

- Typecheck.
- Every phase's PROVE step, with actual output pasted. A phase without proof is incomplete.
- Confirm no new predicate collides with the reserved set.
- State the delta in per-delegation prompt size from phase 13, in tokens.

## Report

- FILES: each path touched, what changed
- VERIFIED: commands run, plus each phase's PROVE output
- CONSUME AUDIT: one line per phase naming what reads it
- NOTES: assumptions, anything that looked wrong, scope deliberately not touched
