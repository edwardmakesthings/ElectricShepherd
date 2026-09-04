# Structure and comment audit — execution spec

Date: 2026-09-04
Status: Ready to execute
Supersedes: nothing. Complements `docs/2026-08_architecture-rebuild-spec.md` (referred to below as
"the rebuild spec"), which remains authoritative on layer semantics and the binding rule.

## 0. Purpose and scope

The rebuild spec's four-layer model (`surface/` -> `policy/` -> `capability/` -> `core/`) is
approximately half realised. This spec finishes it and removes construction scaffolding from
comments. It changes no memory semantics. If a step here appears to require a semantics change,
stop and escalate: that means the step is wrong.

This spec is written to be executed by an implementation model with limited context. Every step
names exact paths. Where a step requires judgment, it says so explicitly and tells you to stop.

### Audit findings this spec acts on

1. `capability/<type>/index.ts` (6 files, ~120 lines each) are facades. Each imports
   `MemgraphClient` from `../../adapter/memgraph.ts`, re-exports adapter symbols, and adds a few
   `plan*` / `read*Strict` wrappers. The implementation lives in `adapter/`, one directory
   sideways. The conformance suite passes against the facade, so it buys a green check and no
   structural protection.
2. `policy/` and `surface/` do not exist. That role was absorbed by `plugin/session-policy/`
   (20 files).
3. The substrate layer has two occupants: `core/` (4 files) and the `memgraph-*` half of
   `adapter/`. Two names for one job.
4. `adapter/` mixes three different layers. `memgraph-structure.ts` / `memgraph-transport.ts` /
   `memgraph-internals.ts` / `palace-tools.ts` are genuine substrate translation.
   `retrieval-scoring.ts` is pure policy (300 lines, zero substrate calls). `memgraph-axes.ts`
   and parts of `memgraph-drawers.ts` encode capability semantics (`es-status`, `es-outcome`,
   `rules-out`, reminders, dead ends, lineage).
5. `package.json` `"files"` ships `adapter` but not `core`, `capability`, or `policy`. The
   published package is missing the substrate layer added by the rebuild. This is a live bug.
6. 329 `Phase N` / `Rung N` references in comment lines across 51 of the 92 runtime-source
   TypeScript files — including several in each of the six newly written
   `capability/*/index.ts` files, so the habit is actively regenerating, not merely legacy.
   A further 37 test files carry them; tests are out of scope for the checks.
7. Two dangling doc references in comments:
   - `tools/promote_skill.ts:63` -> `docs/memory-phases-6-11-spec.md` (file does not exist)
   - `tools/palace_stamp_source_type.ts:5` -> `docs/unified-memory-spec.md` (file does not exist)
   Seven other `.md` comment references are legitimate and MUST be preserved (see §4.2).
8. The rebuild spec's acceptance-criteria status table is stale. It lists three files as over the
   800-line ceiling. Measured across all 92 runtime-source files on 2026-09-04, **nothing exceeds
   800 lines** — the largest is `scripts/run-memory-consolidation-and-validation.ts` at 784.
   Criterion 2 is green and has been for some time; the table asserted an outstanding failure
   that no longer existed. A hand-maintained table of machine-checkable facts drifted, exactly as
   comments do. (This spec therefore states no line counts of its own beyond this finding.)

### Governing decisions (settled, do not relitigate)

- D1. `adapter/` ceases to exist as a directory name. Its contents distribute to `core/`,
  `capability/`, `policy/`, and `surface/`.
- D2. The surviving substrate directory is `core/`, because the rebuild spec's binding rule and CI
  check are bound to that word: the string `mempalace_` may appear in exactly one directory. A
  two-tier substrate layer would force the check to name two directories, at which point it stops
  making the wrong path unavailable.
- D3. A `src/` root holds all runtime source. Assets stay at the repo root. The discriminator is
  *who resolves the path*: source is resolved by the TypeScript import graph (renaming it is a
  compile error); assets are resolved by name at runtime by opencode or `loadPackagedAssets`
  (renaming them fails silently).
- D4. `tools/` sits at `src/tools/`, not `src/surface/tools/`, for discoverability. No CI check
  depends on it being nested.
- D5. `scripts/` moves to `src/scripts/`. It is source, and
  `run-memory-consolidation-and-validation.ts` is half of the duplicated policy layer; `policy/`
  cannot absorb it across two different roots.
- D6. `tests/` stays at the repo root. It mirrors `src/` rather than belonging to it, and the CI
  checks scope themselves to runtime code — putting tests under `src/` would require an exclusion
  carve-out in every check.
- D7. Execution is three stages, each landing green on `npm test` before the next begins. Stage 1
  is pure motion so that a dead read path found later can be attributed by `git log --follow`
  rather than by bisecting a large diff.
- D8. Checks land before the code they govern (rebuild spec Rung 0a). A check written after a
  cleanup only proves the cleanup happened; a check written before it is what stops the habit
  returning.

### Target layout

```
src/
  core/         substrate translation; the ONLY directory containing the string mempalace_
  capability/   one module per memory type; owns es-* semantics and predicate names
  policy/       decisions: when, how much, what to rank; no substrate calls
  surface/      plugin hook registration and asset injection
  tools/        the 19 MCP tool modules
  scripts/      operator entrypoints
agents/ command/ skills/ instructions/ snippets/   assets, name-resolved
docs/ tests/ index.ts
```

## Stage 0 — land the checks first

Do this before moving any code.

Read `scripts/verify-structural.ts` first to learn its existing structure and reporting format.
Add checks in the same style. Do not rewrite existing checks.

**It already has three checks, and all three currently PASS:**

- **Check A** — no raw transport construction or `mempalace_` tool names outside `core/`
- **Check B** — no silent catches in `core/` / `capability/`
- **Check C** — no `capability/` imports into `core/`

Check A is already the substrate-confinement rule. Do NOT add a duplicate. Instead, in Stage 1,
**rescope the path roots of Checks A, B, and C to `src/`** as part of the move — that is the only
change they need, and it is a one-line edit per check.

Add three NEW checks, continuing the existing letter naming:

- **Check D — no construction scaffolding in comments.** No comment line under `src/` may match
  `Phase \d+`, `Rung \d+`, or `P\d+-\d+`. Comment lines only — a line whose first non-whitespace
  characters are `//`, `*`, or `/*`. Code and string literals are NOT in scope. Scope is `src/`
  only: `tests/` is excluded deliberately, because test names legitimately reference the rung
  that introduced the behaviour under test.
- **Check E — doc references resolve.** Every `*.md` path appearing in a comment under `src/`
  must resolve to an existing file, relative to the repo root. This is a link check, NOT a ban on
  `.md` in comments. Comments pointing at assets are the one class of comment that earns its
  keep, because that coupling is name-resolved and invisible to the type-checker.
- **Check F — file length ceiling.** No maintained TypeScript file under `src/` exceeds 800
  lines. This is not currently enforced anywhere; it is new. The codebase already complies, so it
  can be strict from the moment it is written — it is a ratchet, not a cleanup.

Checks D and E will fail on the current codebase (329 and 2 violations respectively). That is
expected and correct — Stage 3 brings the code into compliance. Until Stage 3 lands, wire D and E
to report violations without failing the build (a `--strict` flag, or a warn mode). Stage 3's
final step flips them to failing.

Check F is strict immediately.

**Acceptance:** `npm run verify:structural` runs, reports counts for all six checks, exits
non-zero if A, B, C, or F is violated, and exits zero despite D/E violations while they are in warn
mode.

---

## Stage 1 — pure motion

**The invariant for this entire stage: no file's contents change except its `import` and
`export ... from` specifiers.** No logic edits. No renames beyond the directory moves listed
below. No comment edits. No splitting files. If you find yourself wanting to fix something, write
it down and leave it for Stage 2.

Violating this invariant destroys the stage's whole purpose, which is that `git log --follow`
can exonerate the move as the cause of any later failure.

### 1.1 Move map

Create `src/`. Move whole files. Each row is a whole-file move; nothing is split in this stage.

**To `src/core/`** — substrate translation:

| From | To |
|---|---|
| `core/mcp-transport.ts` | `src/core/mcp-transport.ts` |
| `core/substrate-client.ts` | `src/core/substrate-client.ts` |
| `core/substrate.ts` | `src/core/substrate.ts` |
| `core/operation.ts` | `src/core/operation.ts` |
| `adapter/mcp-http-client.ts` | `src/core/mcp-http-client.ts` |
| `adapter/palace-tools.ts` | `src/core/palace-tools.ts` |
| `adapter/memgraph.ts` | `src/core/memgraph.ts` |
| `adapter/memgraph-transport.ts` | `src/core/memgraph-transport.ts` |
| `adapter/memgraph-internals.ts` | `src/core/memgraph-internals.ts` |
| `adapter/memgraph-structure.ts` | `src/core/memgraph-structure.ts` |
| `adapter/memgraph-drawers.ts` | `src/core/memgraph-drawers.ts` |
| `adapter/memgraph-axes.ts` | `src/core/memgraph-axes.ts` |
| `adapter/memgraph-lineage.ts` | `src/core/memgraph-lineage.ts` |
| `adapter/memgraph-capability.ts` | `src/core/memgraph-capability.ts` |
| `adapter/runtime-config.ts` | `src/core/runtime-config.ts` |

Note: `memgraph-axes.ts`, `memgraph-drawers.ts`, and `memgraph-capability.ts` contain capability
semantics that do not belong in `core/`. They land here in Stage 1 anyway, because Stage 1 does
not split files. Stage 2 extracts them. This is a deliberate, temporary state.

**To `src/policy/`** — decisions, no substrate calls:

| From | To |
|---|---|
| `adapter/retrieval-scoring.ts` | `src/policy/retrieval-scoring.ts` |
| `adapter/cadence-orchestrator.ts` | `src/policy/cadence-orchestrator.ts` |
| `adapter/validation-merge-review.ts` | `src/policy/validation-merge-review.ts` |

**To `src/capability/`** — memory-type semantics:

| From | To |
|---|---|
| `capability/episodic/index.ts` | `src/capability/episodic/index.ts` |
| `capability/semantic/index.ts` | `src/capability/semantic/index.ts` |
| `capability/procedural/index.ts` | `src/capability/procedural/index.ts` |
| `capability/prospective/index.ts` | `src/capability/prospective/index.ts` |
| `capability/negative/index.ts` | `src/capability/negative/index.ts` |
| `capability/evaluative/index.ts` | `src/capability/evaluative/index.ts` |
| `adapter/synthesis-consolidation.ts` | `src/capability/episodic/synthesis-consolidation.ts` |
| `adapter/prospective.ts` | `src/capability/prospective/prospective.ts` |
| `adapter/dead-ends.ts` | `src/capability/negative/dead-ends.ts` |
| `adapter/mem-core-loader.ts` | `src/capability/memcore/mem-core-loader.ts` |

The `retrieval-expansion*` family serves semantic, procedural, and evaluative simultaneously —
that is why `retrieval-expansion.ts` grew large. Stage 1 cannot split it, so it moves intact into
a holding module that Stage 2 dissolves:

| From | To |
|---|---|
| `adapter/retrieval-expansion.ts` | `src/capability/retrieval/retrieval-expansion.ts` |
| `adapter/retrieval-expansion-core.ts` | `src/capability/retrieval/retrieval-expansion-core.ts` |
| `adapter/retrieval-expansion-types.ts` | `src/capability/retrieval/retrieval-expansion-types.ts` |
| `adapter/retrieval-expansion-docs.ts` | `src/capability/retrieval/retrieval-expansion-docs.ts` |
| `adapter/retrieval-expansion-skills.ts` | `src/capability/retrieval/retrieval-expansion-skills.ts` |
| `adapter/retrieval-worked-examples.ts` | `src/capability/retrieval/retrieval-worked-examples.ts` |

`src/capability/retrieval/` is explicitly transitional. Do not treat it as a seventh memory type.

**To `src/surface/`** — hook registration and asset injection:

| From | To |
|---|---|
| `adapter/asset-loader.ts` | `src/surface/asset-loader.ts` |
| `adapter/turn-guard-helpers.ts` | `src/surface/turn-guard-helpers.ts` |
| `plugin/session-policy.ts` | `src/surface/plugin/session-policy.ts` |
| `plugin/session-policy/*` (20 files) | `src/surface/plugin/session-policy/*` |

**To `src/tools/` and `src/scripts/`** — move the directories wholesale, preserving internal
structure including `scripts/memory-pipeline/`:

| From | To |
|---|---|
| `tools/` (19 files) | `src/tools/` |
| `scripts/` (14 files incl. `memory-pipeline/`) | `src/scripts/` |

`index.ts` stays at the repo root. Update its single import to
`./src/surface/plugin/session-policy.ts`.

After the moves, `adapter/`, `core/`, `capability/`, `policy/`, `plugin/`, `tools/`, and
`scripts/` must not exist at the repo root.

### 1.2 Rewrite imports

Every `import` / `export ... from` specifier that referenced a moved file must be updated.

**The tests are the trap in this step.** `tests/` holds 56 files, all `.mjs`, not `.ts`. They
reach into the moved directories with roughly 67 specifiers: ~35 into `adapter/`, ~21 into
`tools/`, ~6 into `capability/`, ~5 into `scripts/`. Because they are `.mjs`, **`tsc` does not
see them** — `tsconfig.json` includes `**/*.ts` only. A broken test import is therefore NOT a
compile error; it surfaces only when the test runs, as a module-resolution failure.

So the two verifications are complementary and both are mandatory:
- `npx tsc --noEmit` proves the `.ts` import graph is intact.
- `npm test` proves the `.mjs` test import graph is intact.

Neither alone is sufficient. Do not skip the test run because the typecheck was clean.

Prefer a scripted rewrite over hand editing.

There is currently no `typecheck` npm script. Add one — `"typecheck": "tsc --noEmit"` — as part
of this stage; a verification step that has to be remembered as a raw command is the same failure
mode as a rule that lives only in prose.

Do NOT introduce path aliases (`@core/...`) in this stage. Relative specifiers only. Aliases are
a separate decision and would hide breakage behind resolver config.

### 1.3 Fix `package.json`

Current `"files"` array ships `adapter` and omits `core`, `capability`, and `policy`. Replace the
source entries with the single `src` root:

```
"files": [
  "index.ts",
  "src",
  "agents",
  "command",
  "instructions",
  "skills",
  "snippets",
  "docs",
  "electric-shepherd.config.example.jsonc",
  "QUICKSTART.md",
  "README.md",
  "LICENSE"
]
```

Remove `plugin`, `adapter`, `tools`, and `scripts` — all now inside `src`.

Update every `scripts` entry path: `scripts/run-policy-cycle.ts` becomes
`src/scripts/run-policy-cycle.ts`, and so on. There are 18 npm scripts; 14 invoke a
`scripts/*.ts` path and must be updated. Copy each path from the
existing file; do not retype from memory.

`test` and `test:unit` / `test:integration` globs point at `tests/`, which does not move — leave
them unchanged.

### 1.4 Stage 1 acceptance

All must hold before Stage 2 begins:

1. `npm run typecheck` reports zero errors. (Baseline: clean as of 2026-09-04.)
2. `npm test` reports the same pass/skip counts as before the stage began. Record the
   pre-stage counts first and compare. Report skips honestly; the current baseline is
   476 tests, 466 pass, 0 fail, 10 skipped (integration-gated), measured 2026-09-04.
3. `npm run verify:structural` passes Checks A, B, C, and F, with A/B/C now rescoped to `src/`.
4. `git status` shows moves, not deletions plus additions — i.e. `git log --follow` works on a
   moved file. If git did not detect the renames, the diff is too large; redo with `git mv`.
5. `git diff -M --stat` shows no content changes other than import specifiers, the
   `package.json` edits, and `index.ts`'s single import. Spot-check five moved files to confirm.
6. The repo root no longer contains `adapter/`, `core/`, `capability/`, `policy/`, `plugin/`,
   `tools/`, or `scripts/`.

Commit Stage 1 as its own commit before proceeding.

---

## Stage 2 — layer assignment

Now real logic moves. Each extraction below is independently revertable; land them as separate
commits, running `npm test` after each.

### 2.1 Extract capability semantics out of `src/core/`

The discriminator: **does this code know a predicate name or an `es-*` value?** If yes, it is
capability code and must not live in `core/`.

Move these symbols to the capabilities that own them. Read each symbol before moving it; do not
reconstruct signatures from this table.

From `src/core/memgraph-axes.ts`:

| Symbol | Owning capability |
|---|---|
| `getClosetStatus`, `setClosetStatus`, `countDirectSources` | `episodic` |
| `getClosetSourceType`, `setClosetSourceType`, `getConcerns` | `semantic` |
| `getClosetDomain`, `getRefinedBy`, `getRefines`, `getPromotedFrom` | `procedural` |
| `listReminders` | `prospective` |
| `getRulesOut` | `negative` |
| `getOutcomeCounts`, `recordOutcome`, `OUTCOME_VALUES` | `evaluative` |
| `getStaleness`, `getStalenessFlags`, `setStalenessFlag` | `semantic` |

From `src/core/memgraph-drawers.ts`:

| Symbol | Destination |
|---|---|
| `createDerivedDrawer` | `capability/episodic` — it enforces lineage authority (rebuild spec criterion 21) |
| `fileDeadEnd` | `capability/negative` |
| `listSourceDrawersByScope`, `findUnconsolidatedSourceDrawers` | `capability/episodic` |
| `addDrawer`, `checkpoint`, `updateDrawer`, `kgAdd`, `kgSupersede`, `kgInvalidate`, `search`, `listDrawers`, `getDrawer` | stay in `core/` — these are substrate translation |

`src/core/memgraph-capability.ts` (21 phase comments, capability-routing logic) belongs to
`evaluative`. Move the whole file to `src/capability/evaluative/`.

**Constraint:** after each extraction, the moved code must reach the substrate only through
`core/`. If a moved symbol needs something `core/` no longer exposes, **grow `core/`** — add the
function there and call it. Never reach past it. Check A enforces this, so a violation fails the
build rather than passing silently.

### 2.2 Dissolve the facades

The six `capability/<type>/index.ts` files currently re-export from what is now `src/core/`.
After 2.1, each capability owns its implementation. Rewrite each `index.ts` so that:

- it re-exports from sibling files inside its own module, not from `core/`
- the `plan*` / `read*Strict` wrappers it already defines stay
- nothing outside the module imports anything except through `index.ts`

The facade stops being a pass-through and becomes the module's actual public surface.

### 2.3 Dissolve `src/capability/retrieval/`

Split the holding module along the three capabilities it serves:

- worked-example retrieval and formatting (`retrieveSimilarWorkedExamples`,
  `formatWorkedExampleDemonstration`, `extractWorkedExampleShape`,
  `WORKED_EXAMPLE_*`) -> `capability/procedural/`
- capability tiers, failure modes, calibration (`CAPABILITY_TIERS`,
  `buildCapabilityCanonicalShape`, `buildFailureBucketId`, `FAILURE_EVENT_VALUES`,
  `INTERVENTION_LABELS`, `CONFIDENCE_VALUES`, `mapTaskStatusToCapabilityOutcome`) ->
  `capability/evaluative/`
- doc/authority expansion (`retrieval-expansion-docs.ts`) -> `capability/semantic/`
- skill/shared-skill expansion (`expandRefinedNeighbors`, `admitSharedSkills`) ->
  `capability/procedural/`
- `expandScopedRetrieval` and its parsing helpers -> `policy/retrieval.ts`. It orchestrates
  across capabilities and decides what is ranked and admitted; that is a policy decision, and it
  must not live inside any single capability.

`src/capability/retrieval/` must not exist when Stage 2 ends.

**This is the one step in this spec requiring real judgment.** If a symbol's owner is genuinely
ambiguous, stop and ask rather than guessing. A misfiled symbol here is the drift this whole
exercise exists to prevent.

### 2.4 Stage 2 acceptance

1. Typecheck clean; `npm test` at the recorded baseline counts.
2. `npm run verify:structural` passes Checks A, B, C, and F.
3. `src/capability/retrieval/` does not exist.
4. No file under `src/capability/` or `src/policy/` references a `mempalace_*` tool name.
5. No file under `src/core/` references an `es-*` axis value or a graph predicate name
   (`synthesized-from`, `concerns`, `refined-by`, `rules-out`, `promoted-from`, `triggers-on`,
   `consolidated-into`, `merged-into`). Verify by grep and report the result.
6. Each of the six `capability/*/index.ts` re-exports only from its own module's siblings.

---

## Stage 3 — comment sweep

Zero runtime effect. 329 comment sites across 51 files. Land last, so that nothing else is in
flight while 48 files of prose change.

### 3.1 The rule

> A comment may explain **why** the code is the way it is. It may not describe **what** the code
> does, restate a name, cite a phase or rung number, or reference a document that does not exist.
> Anything a reader needs that the code cannot express belongs in a doc. Anything that is true
> only until the next edit belongs nowhere.

Record this in `instructions/agent-discipline.md` under a new heading, and in `CONTRIBUTING.md`.
It is enforced by Checks D and E, so state it once and point at the checks — do not restate the
violation list in prose, because a hand-maintained list of machine-checkable facts drifts (see
finding 8).

### 3.2 What to delete

Delete outright:

- Any comment whose content is a phase or rung number and nothing else
  (`// Phase 12: domain axis`, `/* Rung 0a */`).
- Any comment that restates the identifier below it.
- Any comment describing construction sequence, migration order, or what a previous version did.
- Any TODO referencing a completed phase.

**Preserve the constraint, drop the citation.** Most phase comments are load-bearing sentences
with a phase number bolted on. `// Phase 7: outcomes accumulate, never overwrite` becomes
`// Outcomes accumulate; they never overwrite.` The invariant survives; the scaffolding goes.

**Do not delete the whole comment because it contains a phase number.** That is the main failure
mode for this stage. Read the sentence, decide whether the claim is still true and non-obvious,
and keep it if so.

### 3.3 The two dangling doc references

- `src/tools/promote_skill.ts:63` — cites `docs/memory-phases-6-11-spec.md Phase 10`, which does
  not exist. The surrounding claim (no per-project success signal exists yet) may still be true;
  keep the claim, drop the citation.
- `src/tools/palace_stamp_source_type.ts:5` — cites `docs/unified-memory-spec.md, Phase 1` for
  inference rules, which does not exist. The inference rules themselves are in the code below;
  drop the citation.

### 3.4 Doc references to PRESERVE

These point at assets, whose coupling is name-resolved and invisible to the type-checker. A
comment is the only place that coupling can be recorded. Check E confirms they resolve; do not remove
them:

- `src/tools/promote_skill.ts:16` -> `agents/dreamer.md`
- `src/tools/promote_skill.ts:280` -> `command/relocate-memory.md`
- `src/capability/procedural/...` (from `retrieval-worked-examples.ts:594`) ->
  `agents/dream-mapper.md`, `agents/drawer-digest.md`
- `src/capability/memcore/mem-core-loader.ts:80-81` -> the `<scope>/memory.md` path format
- `src/surface/asset-loader.ts:111` -> the `*.md` load description
- `src/scripts/verify-structural.ts:2` -> `docs/2026-08_architecture-rebuild-spec.md`

Line numbers are pre-move and approximate after Stages 1-2; locate by content, not by number.

### 3.5 Flip the checks to strict

Final step of this stage: remove the warn mode from Checks D and E. They now fail the build.

### 3.6 Stage 3 acceptance

1. `npm run verify:structural` passes all six checks (A-F) in strict mode.
2. `npm test` at the recorded baseline counts.
3. `git diff` for this stage touches comments only — no statement, expression, or signature
   changes. Verify by reviewing the diff with whitespace and comment-only filtering.
4. The rule text appears in `instructions/agent-discipline.md` and `CONTRIBUTING.md`.

---

## 4. Documentation cleanup

After Stage 3:

1. **Delete the stale status table** in `docs/2026-08_architecture-rebuild-spec.md` §7. Replace
   the criterion-2 row with "enforced by `npm run verify:structural` (Check F)". Put no line counts in
   prose. The table drifted and cost a false belief in an outstanding failure that had already
   been fixed.
2. Mark the rebuild spec **Complete**, with a pointer to this spec for the structural finish.
3. Add a short "Layout" section to `README.md` describing the four layers and the one-sentence
   discriminator for each. This is the orientation doc that did not exist, and its absence is why
   `adapter/` accumulated three layers' worth of code.

## 5. Explicitly out of scope

- Any change to memory semantics, predicates, ranking behaviour, or the es-* vocabulary.
- Path aliases (`@core/...`).
- Splitting or rewriting `src/scripts/run-memory-consolidation-and-validation.ts`. It is the
  other half of the duplicated policy layer, but merging it into `policy/` is a separate piece of
  work with its own risk; moving it into `src/` is enough for now.
- New tests beyond keeping the existing suite green. The layer-shaped and conformance test
  reshaping in the rebuild spec §6.4 is separate work.
- Running `docs/memory-test-plan.md`. That happens after this spec completes.

## 6. Stop conditions

Stop and escalate rather than improvising if:

- A step appears to require changing what a function does.
- A symbol's owning capability in §2.3 is genuinely ambiguous.
- `npm test` counts change in either direction. A test that starts passing is as much a signal as
  one that starts failing.
- Any check in Stage 0 cannot be written without an exclusion carve-out. A rule with carve-outs
  is the failure mode this codebase has already suffered three times.

## 7. Why this order

The rebuild spec's recurring finding was three separate instances of correct intent defeated by
the absence of a mechanism: a shared core adopted by 2 of 20 tools, a write-authority rule that
only warned, and substrate calls documented as mandatory but never made. The conclusion drawn
there — every rule that matters is a CI check, not a document — is the reason Stage 0 precedes
everything, and the reason this spec replaces prose assertions with checks wherever a check is
possible.

The finding this audit adds: the same disease affects documentation about code. A hand-written
table of file lengths, a comment citing a deleted spec, and a `"files"` array listing directories
by hand are the same failure at three scales. Each is a claim about the repository that nothing
keeps true.
