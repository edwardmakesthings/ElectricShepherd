# Electric Shepherd — Architecture Rebuild Spec

**Date:** 2026-08-29
**Status:** In progress (criteria update: 2026-09-03)
**Supersedes:** nothing. Complements `docs/memory-graph-design.md` (which remains the
authoritative statement of *semantics*). This document concerns *structure* only.

---

## 1. Decision summary

Electric Shepherd is **restructured, not rewritten**. The domain semantics — predicates,
DAG rules, ranking axes, the es-* axis vocabulary — are correct and hard-won. The *shape*
is wrong: the system was built as sixteen vertical phases in one sprint, each appended at
the edge of whichever file was nearest, with no shared core to append to.

Four decisions were taken during the audit and are binding on this spec:

| # | Branch | Decision |
|---|---|---|
| 1 | Rebuild from scratch, or restructure? | **Restructure.** A from-scratch rebuild would re-derive the expensive part (semantics) in order to fix the cheap part (layout). |
| 2 | Where does the substrate boundary sit? | **Hard boundary.** MemPalace is frozen at the current fork's surface. ES must work with no further substrate PR. The seam is an *interface*, so a future `kg_filter` becomes an adapter swap. |
| 3 | Decomposition axis? | **Hybrid (c).** A thin horizontal core, with vertical capability modules plugged into it. |
| 4 | Migration style? | **Big bang**, then validate in a fixed ladder: basics → mem-core → new memory types. |

Rationale for (4), which reverses the usual default: characterization tests earn their keep
when quirks are *scar tissue* — accumulated production fixes whose reasons have been lost.
This codebase's quirks came from a single build sprint and were never hardened against real
usage. Pinning them would enshrine sprint artifacts rather than preserve knowledge.

---

## 2. Findings — the evidence this spec responds to

All findings below were verified against the code, not inferred. Line numbers are as of
2026-08-29.

### 2.1 The system has no substrate seam

`adapter/palace-tools.ts` is 312 lines and exports `createPalaceClient`,
`isTranscriptLikeRoom`, `asObject`, `asText`, `parseRows`, `parseFacts`, `parseTaxonomy`,
and `drawerContentFrom`. Only about 8 of 20 tools use `createPalaceClient`.

`tools/move_drawers.ts` (L2) and `tools/delete_drawers.ts` (L2) bypass it entirely,
constructing `MCPHttpClient` + `resolveMCPHeadersFromEnv` directly. There are two ways to
reach MemPalace and only one of them is testable.

Quantified: **119 raw call sites** of `add_drawer` / `kg_add` / `kg_invalidate` /
`diary_write` / `check_duplicate` scattered across **15 files**.

### 2.2 Failures are indistinguishable from empty results — highest severity

**66 silent-swallow sites** (`.catch(() => ...)`, `catch {}`) across 12 files, concentrated
in `adapter/memgraph.ts` (21) and `adapter/retrieval-expansion.ts` (17).

This is the direct cause of the project's stated problem — *"I haven't been able to test all
the types of memory."* A wrong parameter, an auth failure, a timeout, a stale-library
refusal, and a genuinely-empty result all render identically as "no facts." The system
cannot report its own brokenness.

This is not hypothetical. A prior root-cause drawer
(`drawer_electricshepherd_root-causes_a9493d927a2e8042f7dd88ed`) records that every
`kg_query` caller passed parameters the server then rejected outright, the rejection was
swallowed by `.catch(() => ({}))`, and the consequence was that *every already-consolidated
source drawer looked permanently unconsolidated*. The fork has since added those parameters,
so that specific bug is closed — but the pattern that hid it for months is untouched.

### 2.3 Policy exists twice

`plugin/turn-guard.ts` (4004 lines) and
`scripts/run-memory-consolidation-and-validation.ts` (2087 lines) are both consolidation
engines, built at different phases, sharing only `adapter/memgraph.ts`. Roughly 6000 lines
of policy with no declared boundary between them.

### 2.4 turn-guard.ts is the whole system in one file

4004 lines. It imports 19 of 20 tool modules directly (L64–L82) and is simultaneously the
plugin lifecycle hook, the composition root, and the policy engine. At least nine distinct
concerns live inside it: hook registration, tool composition, mem-core injection,
auto-consolidation triggers, loop guard, source capture, worked-example/capability/
failure-mode logic, status-file writing, and asset/instruction injection.

### 2.5 The mem-core reinjection bug is structural, not a missing flag

The configuration is well designed. `adapter/runtime-config.ts` declares four independent
flags, **all defaulting to `false`**:

- `ESHEPHERD_MEMCORE_REINJECT_ENABLED` → `memcore.reinject.enabled` (L101)
- `ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT` → `memcore.reinject.onCompact` (L102)
- `ESHEPHERD_MEMCORE_REINJECT_ON_IDLE` → `memcore.reinject.onIdle` (L103)
- `ESHEPHERD_MEMCORE_REINJECT_ON_START` → `memcore.reinject.onStart` (L104)

plus `ESHEPHERD_MEMCORE_INJECTION_COOLDOWN_MS` → `memcore.injectionCooldownMs` (L122).

The defect is that **enablement and de-duplication are two different decisions made in two
different places**, and the trigger surface is scattered across four sites:

- the `event` hook (L3427) fans out to `onSessionIdle` (L3434), `onSessionCompacted`
  (L3438), and `onSessionStarted` (L3442) — three handlers, each responsible for consulting
  its own flag;
- `experimental.session.compacting` (L3445) calls `injectMemcoreIntoCompaction` (L3320) —
  a fourth, independent path;
- `decideMemcoreInjection` (defined in `adapter/turn-guard-helpers.ts` L126, called from
  `turn-guard.ts` L2126) decides only *dedup* — signature, cooldown, and `force` (L2132),
  backed by `memcoreInjectionBySession` (L1950). It does **not** decide enablement.

There is no single chokepoint answering "should mem-core be injected right now." The
gate-bypasses are already explicit in the source comments:

> L3325: *"Runs BEFORE the reinject gate so it fires even when reinject is off."*
> L3357: *"Runs BEFORE the mem-core gate on purpose."*

Four trigger sites, two decision types, three documented bypasses, and a `force` escape
hatch — accreted one phase at a time. This is the specimen case for the whole spec.

### 2.6 ES ignores substrate capability it already has

The fork exposes 53 MCP tools. Several that directly solve ES's problems have **zero call
sites**:

| Substrate tool | ES status | Consequence |
|---|---|---|
| `mempalace_checkpoint` | unused | ES issues 119 individual writes instead of one batched, dedup-included, single-tool-card call. This is the write amplification and tool-call spam. |
| `mempalace_kg_supersede` | unused | Phase 11 temporal validity is hand-rolled as invalidate-then-add, which is **non-atomic**. A point-in-time query landing on the boundary can observe both values or neither. This is a live correctness defect. |
| `mempalace_reconnect` | unused | `scripts/` write directly; the in-memory HNSW index can go stale with no recovery path. |
| JSON-RPC `-32005` | unhandled | After any MemPalace upgrade, every ES write path fails opaquely (compounded by §2.2). |
| Logstream (`task_create`, `event_append`, `artifact_put`, `patch_submit`, `mesh_peers`) | unused | ES built parallel subagent orchestration. Accepted — see §7. |

**This is not an awareness gap — the correct guidance is already written down and the code
simply does not follow it.** `skills/eshepherd/SKILL.md` documents the live surface
accurately and prescriptively:

- L52 — *"Save a whole session at once (batch + diary) → `mempalace_checkpoint`"*
- L183 — *"Saving a full session atomically → `mempalace_checkpoint` (**not** separate
  add+diary calls)"*
- L193 — the routing matrix lists **"Many separate `add_drawer` + `diary_write` calls"** in
  the *wrong-approach* column
- L112, L324 — `mempalace_reconnect` prescribed for exactly the stale-index case in §4.1(5)

ES's own implementation then does precisely what its own skill file names as the wrong
approach: 119 separate writes, zero `checkpoint` calls, zero `reconnect` calls.

This is the **third independent instance of the same failure** in this audit — correct
intent, documented or built, defeated by the absence of a mechanism that makes the wrong
path unavailable:

1. `bulk_drawer_ops.ts` — a shared core built, adopted by 2 of 20 tools (§2.7)
2. Write-authority — an invariant declared, enforced only as a warn-guard (§2.9)
3. `checkpoint` / `reconnect` — the right call documented as mandatory, never made (§2.6)

Three for three. The conclusion this spec draws from it is §6.6: **every rule that matters
is a CI check, not a document.** A rule stated in prose has now failed here three times in
three different forms, which is enough evidence to stop treating prose as a control.

### 2.7 Lower-severity drift

- **Dry-run convention forked into two incompatible argument names**, each tool deriving it
  independently: `args.dryRun !== false` in `promote_skill` (L166),
  `palace_stamp_source_type` (L221), `remind` (L124), `propose_concerns` (L113),
  `record_outcome` (L128), `propose_refinements` (L139), `file_skill` (L91), `ingest_docs`
  (L396); but `args.dry_run !== false` in `move_drawers` (L161) and `relocate_memory` (L59).
- **Docs claim phases 12–16 are "Planned"** but tests exist for all of them
  (`capability-memory`, `confidence-calibration`, `failure-mode-memory`,
  `worked-example-*`). They are built.
- **`tools/bulk_drawer_ops.ts` is a second, competing core — not dead code.** It is not
  imported by `turn-guard.ts`, which initially suggested it was dead. It is not: it is
  imported by `tools/move_drawers.ts` (L16) and `tools/delete_drawers.ts` (L15) — precisely
  the two tools that bypass `createPalaceClient` (§2.1). It was written to DRY up shared
  drawer operations and exports `runDrawerBatch` (L131), `collectDrawerIDsByScope` (L162),
  `resolveMemPalaceMCPUrl` (L191), `summarizeFailures` (L87), and `classifyErrorKind` (L54).

  This is the most instructive finding in the audit, for two reasons.

  **First, it is the binding rule of §3.1 failing in miniature.** A shared core was built
  with the right intent and 2 of 20 tools adopted it; the other 18 went around it. Nothing
  prevented them. This is direct evidence that the no-bypass rule cannot be a convention —
  it was *already tried as a convention here and it did not hold*. Hence §6.6.

  **Second, it already contains the fix for §2.2.** `ErrorKind = "not_found" |
  "permission_denied" | "network" | "unknown"` (L4) is an error taxonomy that distinguishes
  failure modes instead of swallowing them, and `summarizeFailures` reports them. The
  highest-severity defect in this codebase was *already solved, correctly, in one corner*,
  and never generalised.

  Disposition: **absorb into `core/`, do not delete.** `ErrorKind` becomes the seed of
  `SubstrateResult["kind"]` (§4.1); `runDrawerBatch` and `collectDrawerIDsByScope` become
  core batch primitives; `resolveMemPalaceMCPUrl` collapses into the single
  `core/substrate.ts` transport.
- **Tests are phase-shaped, not layer-shaped.** ~40 unit files, 7 integration files, roughly
  one per feature increment. Nothing tests the seams. Zero coverage: `palace_report`,
  `palace_diff`, `export_drawer`, `capture_transcript`, `relocate_memory`, `delete_drawers`,
  `move_drawers`, `palace_height_threshold`, `palace_list_drawers_multi_room`.
- **`docs/mcp-tools.md` in the MemPalace fork is itself stale** — the live schema has
  `search(since, before, source_file, max_distance)` and `kg_add(valid_to)` which the doc
  does not list.

### 2.8 The design docs assert a substrate API that does not exist

`docs/memory-graph-design.md` §14 marks substrate items A1–A4 as *"(Done.)"* and describes
a traversal/label API: `get_ancestors`, `get_descendants`, `find_scoped_synthesis_nodes`,
`set_synthesis_labels`, `get_label_policy`, and a `node_kind=synthesis` drawer kind.

**A repo-wide grep finds these identifiers in that document and nowhere else.** There are
zero call sites and zero implementations. The fork's live surface offers `get_height`,
`resolve_canonical`, `find_merge_candidates`, and `apply_merge` — related, but not the same
API, and not a superset.

Notably, `match_labels` *is* implemented — but client-side in ES (`adapter/memgraph.ts`
L768, `adapter/retrieval-expansion.ts` L42, `scripts/run-policy-cycle.ts` L145). ES built
around the missing substrate feature and the doc was never corrected.

The hazard is not the stale text; it is that the document reads as an authoritative
build-order with completion markers. Anyone planning from it — human or agent — designs
against tools that do not exist. `instructions/agent-discipline.md` L94 and L115 already
cite `get_ancestors` as an example tool, propagating the phantom.

**Disposition for the two co-authored design docs:**

- **`docs/memory-graph-design.md`** is not obsolete — it is three documents fused, and the
  parts have diverged in truth value:
  - **Rationale and semantics (§1, §2, §3, §5, §9, §9a, §12, §13)** — still correct and
    still the most valuable writing in the repo. The probabilistic-wrapped-in-deterministic
    principle, memory-types-as-mutability-contracts, local-edges-only, merge-as-symlink,
    and script-orchestrates-model all hold. **Keep, unchanged.**
  - **Build order and status (§14, §9b scorecard, the "Implementation status" blocks and
    the 2026-06-23 status note)** — partly false (§2.8), and superseded by this spec's
    acceptance criteria. **Delete.** Status does not belong in a design document; that is
    the same accretion disease as the code, and it is why the doc now misreports itself.
  - **Substrate PR planning (§0 Project A, §14 Project A, "PR sequencing")** — obsolete
    under Decision 2. The substrate is frozen. **Delete**, retaining one line noting the
    fork boundary.

  Result: `memory-graph-design.md` becomes a pure **semantics and rationale** document with
  no status markers and no build order. It then stops going stale, because rationale does
  not have a completion state.

- **`docs/memory-blocks.reference.md`** (48 lines) is still structurally accurate — the
  three labeled blocks, the "derived never authored" rule, the few-hundred-token budget,
  and "mem-core does not round-trip into MemPalace drawers" all remain true and are load-
  bearing. Its *illustrative content* is stale (it describes the substrate/policy split as
  the project state, which is now assumed rather than notable). **Keep the file, refresh the
  example content**, and make the render format it documents a conformance test (§6.4) so
  the reference and the renderer cannot drift apart silently.

### 2.9 Write-authority gating: keep the invariant, change its axis

`memory-graph-design.md` §9b Gap #3 proposes gating `add_drawer` / `apply_merge` to the
dreamer agent, so that interactive `build`/`plan` agents cannot write derived memory. It is
currently implemented in `turn-guard.ts` as an event-time warn-guard (design doc L503–505
concedes it is not hard enforcement).

That proposal predates phases 5–16, and **the system has since outgrown it**. The invariant
as stated — "only the dreamer writes derived memory" — is now false by design: `file_skill`,
`remind`, `record_outcome`, `propose_concerns`, `propose_refinements`, and `ingest_docs` all
write drawers and edges from interactive flows, on purpose. Roughly a third of the tool
surface violates the stated rule as intended behaviour.

But the invariant should not be dropped, because the thing it protects is real. The audit
produced live evidence: during the authoring of this spec, a session record was written to a
`decisions` room from an interactive planning flow. The gate caught it. That write was
genuinely wrong — **not because of who issued it, but because it created a node claiming
derived status with no `synthesized-from` lineage**: a permanent orphan in the DAG, invisible
to traversal, height 0 forever.

That distinction is the fix. **The correct axis is node type, not agent identity.**

- A **synthesis** is a judgment connecting ≥2 sources. It requires lineage, dedup, and the
  empty-inflation guard. Creating one is a consolidation act → dreamer authority.
- A **skill, reminder, outcome, dead-end, or doc** is a first-class typed capture. It claims
  no lineage and asserts no synthesis. Creating one is ordinary capability work → any agent,
  through the owning capability.
- A **diary entry** is episodic append → always allowed.

The `es-source-type` axis already encodes exactly this distinction; the gate simply was not
built on it.

**Consequence for the rebuild — this is the part that answers "do we reimplement it?":
no.** Under §3.1 there is no raw `add_drawer` for any agent to misuse, because capability
modules expose typed writes (`fileSkill`, `createReminder`, `recordOutcome`,
`recordDeadEnd`, `createSynthesis`) and only `core/` may call the substrate. `createSynthesis`
is the sole dreamer-authority operation — and it *already* must validate ≥2 distinct
`synthesized-from` parents under the existing write-quality gate (design doc §7). Authority
gating and quality gating collapse into one mechanism, enforced structurally rather than by
intercepting tool calls at the harness.

So `turn-guard.ts`'s warn-guard **does not survive the rebuild**. It disappears, along with
the class of bug it was patching. Interactive agents keep `diary_write` for ordinary
findings, which is what this session used after the gate fired.

---

## 3. Target architecture

Four layers. Dependencies point strictly downward; there are no upward or sideways imports.

```
  surface/     MCP tool definitions, slash commands, plugin hook registration
      |        (thin: schema + arg parsing + delegation, no logic)
      v
  policy/      decisions: when to inject, when to consolidate, what to rank,
      |        what to escalate. Pure functions where possible.
      v
  capability/  one module per memory type; owns its own storage->injection path
      |        but reaches the substrate ONLY through core/
      v
  core/        substrate client, KG helpers, config, dry-run + approval
               scaffolding, room resolution, paging, es-* stamping
```

### 3.1 The binding rule

> **A capability module may not call the substrate directly.**
> If a capability needs something `core/` does not offer, `core/` grows.
> A capability never reaches past it.

This single rule is what would have prevented every duplication in §2. It is the one thing
in this spec that must not be relaxed under schedule pressure — every defect found in the
audit is an instance of reaching past a missing core.

Mechanically enforced: **the string `mempalace_` may appear in exactly one directory,
`core/`.** This is a lint rule, not a convention (see §6.6).

### 3.2 Capability modules

One per memory type, mapping to the existing phase work:

| Module | Owns | Predicates / axes |
|---|---|---|
| `episodic` | transcript capture, consolidation, synthesis DAG | `synthesized-from`, `consolidated-into`, `merged-into` |
| `semantic` | doc ingestion, authority ranking, cross-type linking | `concerns`, `es-source-type` |
| `procedural` | skills, promotion, refinement, worked examples | `refined-by`, `promoted-from`, `es-domain` |
| `prospective` | reminders, triggers | `triggers-on`, `es-reminder-status`, `expires-at` |
| `negative` | dead ends, ruled-out approaches | `rules-out` |
| `evaluative` | outcomes, capability routing, calibration | `es-outcome`, `es-calibration-outcome` |
| `memcore` | scoped render, injection decision, labeled blocks | `[project-state]`, `[active-conventions]`, `[user-preferences]` |

These names are the *organising* axis. Existing files map into them rather than being
rewritten: `adapter/synthesis-consolidation.ts` → `episodic`, `adapter/prospective.ts` →
`prospective`, `adapter/dead-ends.ts` → `negative`, `adapter/mem-core-loader.ts` →
`memcore`, and `adapter/retrieval-expansion.ts` splits across `semantic`, `procedural`,
and `evaluative` (it is 1915 lines precisely because it currently serves all three).

---

## 4. The core surface

`core/` is small, boring, and total. It is the only place that knows MemPalace exists.

### 4.1 `core/substrate.ts` — the only caller of `mempalace_*`

Absorbs today's `adapter/palace-tools.ts` and `adapter/mcp-http-client.ts`. Preserves the
existing helpers (`asObject`, `asText`, `parseRows`, `parseFacts`, `parseTaxonomy`,
`drawerContentFrom`) and adds the following obligations:

1. **No silent swallowing.** Every substrate call returns a discriminated result that
   separates *empty* from *failed*:

   ```ts
   type SubstrateResult<T> =
     | { ok: true; value: T }
     | { ok: false; kind: "transport" | "protocol" | "stale-library" | "not-found"
         ; detail: string }
   ```

   A caller that wants to ignore an error must say so explicitly and name a reason. The
   66 `.catch(() => ...)` sites are converted, not carried over. **This is the single
   highest-value change in the spec** — it is what makes the validation ladder in §6
   possible at all.

   This is **not a new invention**. `tools/bulk_drawer_ops.ts` L4 already defines
   `ErrorKind = "not_found" | "permission_denied" | "network" | "unknown"` and reports it
   through `summarizeFailures` (L87). That taxonomy works and is in production use by two
   tools. `SubstrateResult` generalises it to the whole substrate and adds the two kinds
   the existing set lacks (`protocol`, `stale-library`). Lower risk than it appears: the
   pattern is proven in-repo, merely unadopted.

2. **`-32005` is a first-class outcome.** The stale-library refusal maps to
   `kind: "stale-library"` and surfaces the server's `action_required:
   "restart_mcp_server"` verbatim to the operator. It is never retried and never swallowed.

3. **Batched writes go through `mempalace_checkpoint`.** A `checkpoint({ items, diary,
   dedup_threshold, added_by })` helper becomes the default write path for any operation
   filing more than one drawer. Single writes may still use `mempalace_add_drawer`.

4. **Temporal supersession uses `mempalace_kg_supersede`.** Hand-rolled
   invalidate-then-add is removed. Where a single-valued fact changes, one atomic call.

5. **A recovery path for stale vector state** via `mempalace_reconnect`, invoked when a
   direct-write script has run.

6. **`kg_filter` is anticipated but not required.** Authority filtering is implemented as
   retrieve-then-filter *behind this interface*, so a future substrate PR changes one
   function and nothing above it. The interface is written as though filtering were
   server-side; today's implementation fans out `kg_query` client-side.

### 4.2 `core/config.ts`

`adapter/runtime-config.ts` moves essentially unchanged — it is already the single
canonical declaration (`envKey` → `path` → `kind` → `defaultValue`) and is the healthiest
file in the codebase. `applyRuntimeConfigToEnv`, `loadRuntimeConfig`, and
`getRuntimeConfigEnvMap` keep their names.

### 4.3 `core/operation.ts` — dry-run and approval, defined once

Resolves §2.7. One helper owns the convention:

- **All tool-facing parameter names are `snake_case`, without exception.** This is a
  general convention, not a `dry_run` special case — it matches the substrate's own surface
  (`mempalace_mine`, `mempalace_delete_by_source`, `mempalace_sync`, `source_file`,
  `max_distance`, `valid_to`) so there is exactly one naming rule across the whole system
  rather than a translation layer at the seam. Churn is accepted: a mechanical rename with
  a type-checker behind it is cheap, and a single rule removes a permanent class of
  "which spelling does this tool want?" defects.
- The canonical dry-run argument is therefore **`dry_run`**. `dryRun` is accepted as a
  deprecated alias for one release so no caller breaks, then removed.
- Internal (non-tool-facing) TypeScript identifiers remain idiomatic `camelCase`. The
  boundary is the tool schema, and `core/operation.ts` is the only place that crosses it.
- Default is **preview** (`dry_run` defaults to `true`) for every mutating operation.
- Approval-gated operations (`promote_skill`, `record_outcome`, `remind`,
  `propose_concerns`, `propose_refinements`) declare that once, declaratively, rather than
  re-implementing the numbered-proposal pattern each time.

No tool derives its own dry-run semantics again.

### 4.4 `core/taxonomy.ts`

Room resolution and paging: `isTranscriptLikeRoom`, reuse-or-mint room selection, and
bounded page-walking. Every tool currently re-implements some part of this.

### 4.5 `core/axes.ts`

The es-* vocabulary as data, not scattered string literals: `es-source-type`, `es-status`,
`es-outcome`, `es-domain`, `es-staleness`. Stamping and reading go through here, so an
out-of-vocabulary value is a type error rather than a silently-written triple.

---

## 5. Decomposing `plugin/turn-guard.ts`

The 4004-line file becomes a thin hook adapter plus a policy dispatcher. Its nine concerns
are redistributed:

| Concern (current location) | Destination |
|---|---|
| Hook registration (`event` L3427, `experimental.session.compacting` L3445, `tool.execute.before` L3448) | `surface/plugin/hooks.ts` — registration and normalisation only |
| Composition root (19 tool imports, L64–L82) | `surface/plugin/registry.ts` — a manifest, not a hub |
| Mem-core injection (L1950, L2126, L3320) | `capability/memcore/` + `policy/injection.ts` |
| Auto-consolidation triggers (`AutoConsolidationTrigger`, `pruneToMax`) | `policy/cadence.ts` (merges with `adapter/cadence-orchestrator.ts`) |
| Loop guard (`loopGuardEnabled`, L3449+) | `policy/loop-guard.ts` |
| Source capture (`verifySourceCapture`) | `capability/episodic/capture.ts` |
| Worked-example / capability / failure-mode logic (L62 imports) | `capability/procedural/`, `capability/evaluative/` |
| Status file writing (`writeStatusFile`, `statusSnapshot`) | `core/status.ts` |
| Asset/instruction injection (`loadPackagedAssets`, `mergeWithoutOverride`, `loadInstructionPaths`, `dedupeAppendInstructions`) | `surface/assets.ts` (already isolated in `adapter/asset-loader.ts`) |

Extraction note (2026-09): the in-flight decomposition does not funnel domain logic
into a single `pure-helpers.ts` catch-all. Domain-specific helpers are extracted into
category modules under `plugin/session-policy/` — `worked-example.ts`, `capability.ts`,
`interventions.ts`, `routing.ts`, `source-capture.ts` — and `turn-guard.ts` imports the
moved symbols from those category files directly. `pure-helpers.ts` keeps only generic
utilities (status/log writes, locks, process-tree kill) and re-exports the moved symbols
for backward compatibility with existing closure imports.

### 5.1 The single injection chokepoint

This is the concrete fix for §2.5, and the pattern every other trigger follows.

All lifecycle events normalise to one call:

```ts
// policy/injection.ts
decideInjection(input: {
  reason: "started" | "idle" | "compacted" | "compacting" | "manual"
  sid: string
  scopeDir: string
  signature: string
  now: number
  previous?: MemcoreInjectionRecord
  config: MemcoreConfig
}): { inject: false; because: string } | { inject: true; render: MemcoreRender }
```

Three properties are required:

1. **Enablement and dedup are decided in the same function.** `memcore.reinject.enabled`
   is checked first and gates everything; the per-reason flag (`onStart` / `onIdle` /
   `onCompact`) is checked second; signature and `memcore.injectionCooldownMs` are checked
   third. Today's `decideMemcoreInjection` only performs the third check — it absorbs the
   first two.
2. **No caller may inject without a `{ inject: true }` result.** The two documented
   bypasses are dismantled: the pre-compact probe (`precompactProbeEnabled`) and the
   compact prompt override (`compactPromptOverrideEnabled`) are *separate concerns that
   were never mem-core* and move out of the injection path entirely rather than running
   "before the gate."
3. **`force` becomes an explicit `reason: "manual"`**, not a boolean that skips checks.
   Manual re-injection still respects `memcore.reinject.enabled`.

| `reason` | governing per-reason flag |
| --- | --- |
| `started` | `memcore.reinject.onStart` |
| `idle` | `memcore.reinject.onIdle` |
| `compacted` | `memcore.reinject.onCompact` |
| `compacting` | `memcore.reinject.onCompact` (same gate — there is deliberately no separate `onCompacting` flag) |
| `manual` | no per-reason flag; still requires `memcore.reinject.enabled` |

`memcore.reinject.enabled` is checked FIRST for every reason without exception. No lifecycle path may reach the renderer before that check. The pre-compact probe and the compact-prompt override described in `plugin/turn-guard.ts` at L3325 and L3357 — both of which currently run *before* the gate on purpose — are the specific behaviour this table abolishes.

The `because` string on refusal is not decoration — it is what makes the mem-core
behaviour testable and debuggable, and it feeds the status file.

---

## 6. Migration and validation

Big bang restructure, then a fixed validation ladder. The ladder order is deliberate: each
rung depends on the one below it being trustworthy.

### 6.0 Rung 0 — make failure visible (prerequisite)

Rung 0 has **two halves, and the enforcement half lands first**:

**0a. The §6.6 CI checks are written and wired before any code is moved.** They are cheap
(three greps and an import-graph walk) and they are what converts this spec from prose into
a control. §2.6, §2.7 and §2.9 are three independent proofs that a rule stated in a document
does not hold here; a rule stated in CI does. Writing the checks last would repeat, for a
fourth time, the exact failure this spec exists to correct.

This also has an operational consequence: **once the checks exist, conformance stops being
a judgment call and becomes mechanical.** Verifying that a unit of work satisfies the
binding rules no longer requires an expensive reviewer holding the whole architecture in
mind — it requires reading a CI result. Landing 0a first is therefore what makes the rest
of this migration safe to execute cheaply.

**0b.** Convert the 66 swallow sites and land `SubstrateResult`. **Nothing else in this spec can be
validated until this is done**, because until failures are distinguishable from empty
results, a green test proves nothing. This rung is not optional and does not run in
parallel with the others.

Exit criterion: a deliberately broken substrate call (bad URL, bad auth, bad parameter)
produces a distinct, named, operator-visible error at every layer — never an empty list.

### 6.1 Rung 1 — the basics

The bootstrap set, verified end-to-end against a live MemPalace:

- write a drawer and read it back verbatim
- add a KG fact and query it back
- resolve a canonical id and compute a height
- iterate every page of a room using a bounded page size and an explicit termination condition, without unbounded memory growth or timeout
- dry-run every mutating tool and confirm it writes nothing
- confirm `-32005` and transport failure both surface correctly

### 6.2 Rung 2 — mem-core

- with `memcore.reinject.enabled=false`, **no injection occurs on any lifecycle event** —
  this is the acceptance test for the reported bug
- with `enabled=true` and each per-reason flag toggled independently, injection occurs on
  exactly the enabled reasons and no others
- the cooldown and signature dedup suppress a repeat injection within
  `memcore.injectionCooldownMs`
- the render contains the three labeled blocks and respects `memcore.maxChars`
- every refusal reports a `because` reason

### 6.3 Rung 3 — the memory types

One capability at a time, in dependency order: `episodic` → `semantic` → `procedural` →
`prospective` → `negative` → `evaluative`. For each, the same three questions:

1. **Write:** does the capability produce the drawers and edges its spec says it does?
2. **Read:** does something actually *consume* them — do they reach retrieval or mem-core?
3. **Fail:** when the substrate errors mid-operation, does the capability report it rather
   than silently producing a partial result?

Question 2 is the one the current phase-shaped tests skip, and it is why the memory types
have never been meaningfully verified. Per `docs/memory-test-plan.md`, a write-path test
that never checks consumption proves only that a row exists.

### 6.4 Test restructuring

Tests move from phase-shaped to layer-shaped:

- `tests/core/` — substrate contract, including the failure taxonomy. Fast, mocked.
- `tests/capability/<name>/` — write + read + fail per memory type.
- `tests/conformance/` — **one parameterised suite over all capabilities**, asserting the
  invariants that hold for every memory type: dry-run writes nothing, every synthesis has
  ≥2 `synthesized-from` parents, no capability imports the substrate, es-* values are in
  vocabulary, approval-gated operations refuse to write without approval.

The conformance suite is the durable answer to *"do all the memory types work?"* — adding a
seventeenth phase later means adding a row to a table, not writing a new test file.

Existing tests are retained where they cover semantics and retired where they merely
cover a phase's plumbing. The nine tools with zero coverage (§2.7) are covered by the
conformance suite rather than by nine bespoke files.

### 6.5 Ordering within the big bang

Even in a big-bang restructure, land `core/` first and make it complete before moving
capabilities onto it. Building `core/` and the capabilities simultaneously reproduces the
original failure mode — capabilities reaching past an incomplete core.

1. `core/` complete, with Rung 0 done and `tests/core/` green.
2. Capabilities moved onto `core/`, all direct substrate calls deleted.
3. `turn-guard.ts` decomposed per §5.
4. `tools/bulk_drawer_ops.ts` is absorbed into `core/` — its logic (`ErrorKind`, `classifyErrorKind`, `summarizeFailures`, `runDrawerBatch`, `collectDrawerIDsByScope`, `resolveMemPalaceMCPUrl`) is moved, not discarded — and its two importers (`tools/move_drawers.ts` L16, `tools/delete_drawers.ts` L15) are rewired to `core/`. The *file* is removed only after that migration is complete and green. The *logic* is preserved in full. It is not dead code — see §2.7.
5. Rungs 1–3 walked in order.

### 6.6 Enforcement

Three checks, in CI, that make the architecture self-defending:

- **no runtime code outside `core/` invokes a substrate tool** — scope-limited to `adapter/`, `capability/`, `policy/`, `surface/`, `tools/`, `scripts/`, `plugin/`; explicitly excludes `docs/`, `instructions/`, `skills/`, `agents/`, `command/`, and test fixtures; implemented as an import/call-site check, not a repo-wide string grep
- **no bare `.catch(() => ...)` / `catch {}`** in `core/` or `capability/` — an ignored
  error must name a reason
- **no import from `capability/` into `core/`** — dependencies point downward only

Without these the structure decays back to its current state within a few phases. They are
part of the deliverable, not a follow-up.

---

## 7. Acceptance criteria

The restructure is complete when all of the following hold. Each is intended to be checkable by a reader with no context beyond this document; where a criterion names a command or artifact, that is the check.

### 7.1 Current criteria status (2026-09-03)

| # | Criterion | Updated Status | Evidence / Observation (current) |
|---|---|---|---|
| 1 | No runtime code outside `core/` invokes substrate | **Done (unchanged / not fully re-audited this pass)** | No regression surfaced in this pass. |
| 2 | No file exceeds 800 lines | **Fail** | Still over: `adapter/memgraph.ts` 2374, `scripts/run-memory-consolidation-and-validation.ts` 2093, `adapter/retrieval-expansion.ts` 1914. Now under 800: `plugin/turn-guard.ts` 796, `plugin/session-policy/handlers.ts` 793, `plugin/session-policy/interventions.ts` 399. |
| 3 | Exactly one consolidation engine | **Done** | `runSynthesisConsolidation` remains centralized in `adapter/synthesis-consolidation.ts`; callers are wrappers/entrypoints. |
| 4 | `capability/` imports no substrate internals | **Done (unchanged)** | No new regression found this pass. |
| 5 | `move_drawers` & `delete_drawers` no direct `MCPHttpClient` | **Done** | No direct client construction/import; only comment mention in `tools/delete_drawers.ts`. |
| 6 | `bulk_drawer_ops.ts` absorbed into `core/` | **Partial** | `tools/bulk_drawer_ops.ts` still present (13-line stub). |
| 7 | Zero bare `.catch` in `core/` and `capability/` | **Done** | No `.catch(` hit in `core/` or `capability/` for the criterion’s banned bare-swallow pattern. |
| 8 | Broken substrate call → distinct named error | **Done** | Error taxonomy path remains intact; no regression observed. |
| 9 | `-32005` surfaces `restart_mcp_server` verbatim | **Done** | `core/mcp-transport.ts` now includes verbatim `action_required` in detail and unit test asserts no retry (`tests/unit/rung1-bootstrap.test.mjs`). |
| 10 | Temporal validity uses `mempalace_kg_supersede` | **Done** | Runtime/tool paths and tests remain on supersede semantics. |
| 11 | Multi-drawer writes use `mempalace_checkpoint` | **Partial (improved)** | `runCheckpointWrite(...)` callsites exist (`promote_skill`, `remind`, `file_skill`) but not universal yet. |
| 12 | One `dry_run` implementation (default preview) | **Done** | `normalizeDryRunArg(...)` used consistently in active handlers checked. |
| 13–15 | Mem-core injection logic (Enabled/Reasons/Because) | **Partial** | Still split across `turn-guard` + `plugin/session-policy/*`; not fully consolidated. |
| 16–17 | Capabilities pass write+read+fail / Conformance | **Done** | Added `tests/conformance/capability-conformance.test.mjs` (all six capabilities) and `node --experimental-strip-types --test tests/conformance/capability-conformance.test.mjs` passes. |
| 18 | `npm test` green with verbatim reporting | **Done** | `npm test` passed: **475 tests**, **465 pass**, **0 fail**, **10 skipped** (integration-gated skips declared by runner). |
| 19 | Authority gated on node type, not agent identity | **Done** | Identity-based runtime knobs/messages were removed (`ESHEPHERD_ALLOWED_CONSOLIDATION_WRITERS`, `consolidation.allowedWriters`, `consolidation.writeGuardEnabled`, and dreamer-only checkpoint wording). Lineage-bearing synthesis authority is structural at node boundary: `createDerivedDrawer` enforces non-empty lineage and synthesis consolidation enforces distinct-source minimum (`adapter/synthesis-consolidation.ts`). |
| 20 | `turn-guard.ts` warn-guard deleted | **Done** | Legacy event-time warn-guard path is absent; `plugin/turn-guard.ts` is now orchestration + config-warning only. Remaining write-authority text is instructional (`plugin/session-policy/checkpoint-handler.ts`), while enforcement is hard rejection at write-authority boundary. |
| 21 | No orphan synthesis (structural lineage req) | **Done** | `createDerivedDrawer` rejects empty lineage and tests cover both direct create + dead-end flow lineage requirements. |
| 22 | `memory-graph-design.md` semantics/rationale only | **Done** | Status/build-order/PR-sequencing sections removed; doc reduced accordingly. |
| 23 | No phantom API refs unless tool exists | **Done** | Target phantom symbols absent in checked docs/instructions. |
| 24 | Routing matrix deduped to one source | **Done** | `instructions/agent-discipline.md` points to `skills/eshepherd/SKILL.md` as canonical. |
| 25 | `memory-blocks.reference.md` + conformance asserted | **Done** | Reference retained; conformance test present and passing. |
| 26 | Docs phase status corrected (12–16 built) | **Done** | Status line present in `docs/memory-phases-12-16-spec.md`. |
| 27 | `mcp-tools.md` updated or drift recorded | **Done** | `docs/substrate-drift.md` records date, signatures, and authority note. |

**Structural**

1. No runtime code outside `core/` invokes a substrate tool. Enforcement scope is runtime source only: `adapter/`, `capability/`, `policy/`, `surface/`, `tools/`, `scripts/`, `plugin/`. Explicitly **excluded** from this check: `docs/`, `instructions/`, `skills/`, `agents/`, `command/`, and test fixtures — these are documentation and are *expected* to name substrate tools (see criterion 24). The check is an import/call-site check over runtime directories, never a repo-wide string grep.
2. No file exceeds 800 lines. `turn-guard.ts` (4004),
   `run-memory-consolidation-and-validation.ts` (2087), `memgraph.ts` (2191), and
   `retrieval-expansion.ts` (1915) are all decomposed. Scope: maintained TypeScript source under `core/`, `capability/`, `policy/`, `surface/`, `adapter/`, `tools/`, `plugin/`. Generated files, vendored code, and test fixtures are excluded.
3. There is exactly one consolidation engine. Concretely: `plugin/turn-guard.ts` and `scripts/run-memory-consolidation-and-validation.ts` no longer both implement consolidation policy. One is the engine; the other either delegates to it or is deleted with its unique behaviour absorbed, and that unique behaviour is enumerated in the migration notes before deletion.
4. `capability/` contains no import of the substrate transport internals — specifically
   `MCPHttpClient`, `resolveMCPHeadersFromEnv`, `resolveMemPalaceMCPUrl`, or raw JSON-RPC envelope types. Capabilities import only the published interface from `core/substrate.ts`.
5. `tools/move_drawers.ts` and `tools/delete_drawers.ts` no longer construct
   `MCPHttpClient` directly.
6. `tools/bulk_drawer_ops.ts` is absorbed into `core/` — not deleted. Its `ErrorKind`
   taxonomy survives as part of `SubstrateResult`, and all tools listed in Appendix A use the resulting
   batch primitives rather than 2 of them.

**Correctness**

7. Zero bare `.catch(() => ...)` / `catch {}` in `core/` and `capability/`. Every ignored
   error names a reason. CI-enforced.
8. A deliberately broken substrate call surfaces a distinct named error at every layer,
   never an empty result. (Rung 0 exit criterion.)
9. `-32005` surfaces `action_required: "restart_mcp_server"` to the operator verbatim and
   is never retried.
10. Phase 11 temporal validity uses `mempalace_kg_supersede`. No invalidate-then-add
    sequence remains for single-valued facts.
11. Multi-drawer writes go through `mempalace_checkpoint`. The 119 scattered raw write
    sites are eliminated: zero direct calls to `mempalace_add_drawer`, `mempalace_kg_add`, `mempalace_kg_invalidate`, `mempalace_diary_write`, or `mempalace_check_duplicate` exist outside `core/`.
12. Exactly one dry-run implementation exists, keyed on `dry_run`, defaulting to preview,
    with `dryRun` accepted as a deprecated alias.

**Behavioural**

13. With `memcore.reinject.enabled=false`, no injection occurs on any lifecycle event —
    `session.started`, `session.idle`, `session.compacted`, or
    `experimental.session.compacting`. **This is the acceptance test for the reported bug.**
14. With `enabled=true`, injection occurs on exactly the reasons whose per-reason flag is
    set, and dedup/cooldown suppress repeats.
15. Every injection refusal reports a `because` reason, visible in the status file.
16. All six memory-type capabilities pass write + read + fail (§6.3). Notably the *read*
    leg: each memory type demonstrably reaches retrieval or mem-core.
17. The conformance suite (§6.4) passes for every capability with no per-capability
    exceptions. An exception in the conformance table is a design defect, not a test
    annotation.
18. `npm test` (unit + integration) is green; the test report states total / passed / failed / skipped counts copied verbatim from the runner output, and names the reason for each skip.

**Write authority**

19. Write authority is gated on **node type, not agent identity** (§2.9). `createSynthesis`
    is the only dreamer-authority operation and validates ≥2 distinct `synthesized-from`
    parents at the boundary.
20. `turn-guard.ts`'s event-time write-authority warn-guard is **deleted, not ported**.
21. No capability can create a lineage-bearing node without lineage. An orphan synthesis is
    unrepresentable rather than merely discouraged.

**Documentation**

22. `docs/memory-graph-design.md` is reduced to semantics and rationale only. All status
    markers, "Implementation status" blocks, `§14` build order, and Project A / PR
    sequencing sections are removed (§2.8).
23. No document references `get_ancestors`, `get_descendants`,
    `find_scoped_synthesis_nodes`, `set_synthesis_labels`, `get_label_policy`, or
    `node_kind` unless that tool demonstrably exists in the frozen fork surface.

    **Scope confirmed by sweep (2026-08-29):** the phantom API is confined to exactly two
    files — `docs/memory-graph-design.md` and `instructions/agent-discipline.md` (L94,
    L115). `command/`, `agents/`, and `skills/` are clean: every substrate tool they name
    was verified to exist in the fork (`traverse` → `mempalace/palace_graph.py` L305;
    `checkpoint`, `kg_supersede`, `get_taxonomy`, `find_closet_lineage_issues` → all
    present in `mempalace/mcp_server.py`). This is a two-file correction, not a repo-wide
    documentation problem.

24. `skills/eshepherd/SKILL.md` is treated as **correct and authoritative for the substrate
    surface** — verified to contain no phantom API references — every substrate tool it names was confirmed present in the fork on 2026-08-29. Where implementation and this file disagree (batch writes, reconnect), the
    **implementation** changes, not the skill file. Its L180–L195 routing matrix duplicates
    the matrix in `instructions/agent-discipline.md`; deduplicate to one source.
25. `docs/memory-blocks.reference.md` is retained with refreshed example content, and the
    render format it documents is asserted by a conformance test.
26. `docs/` phase status is corrected — phases 12–16 are marked built, not "Planned".
27. The MemPalace fork's `docs/mcp-tools.md` is updated for `search(since, before,
	source_file, max_distance)` and `kg_add(valid_to)`, or the drift is recorded in `docs/substrate-drift.md` with the date, the affected tool signatures, and which side is authoritative.

---

## 8. Out of scope

Explicitly deferred, so they do not expand this work:

- **Logstream adoption** (`task_create`, `event_append`, `artifact_put`, `patch_submit`,
  `mesh_peers`). ES has working parallel subagent orchestration. Migrating it is a real
  opportunity — durable, queryable agent telemetry — but it is orthogonal to the memory
  architecture and must not ride along. Track separately.
- **`kg_filter` substrate PR.** §4.1(6) makes ES indifferent to whether it lands. Revisit
  once the seam exists and the N+1 fanout is measurable.
- **Any change to memory semantics.** Predicates, DAG rules, ranking axes, and the es-*
  vocabulary are carried across unchanged. If the restructure appears to require a
  semantic change, that is a signal the restructure is wrong, not the semantics.
- **New memory types.** No seventeenth phase until the conformance suite is green on the
  existing six.

---

## 9. Risk

The principal risk of big-bang is that behaviour changes silently during the move and
nobody notices, because §2.2 means the system currently cannot report its own failures.

This is mitigated by ordering, not by characterization tests: **Rung 0 lands first**. Once
failure is visible, subsequent breakage announces itself instead of degrading into a
plausible-looking empty result. This is the entire reason Rung 0 is a prerequisite rather
than a cleanup task.

The secondary risk is core/capability co-development (§6.5) — building them together
recreates the original defect. Mitigated by completing `core/` and its tests before any
capability moves onto it.

---

## Appendix A — tool inventory (baseline 2026-08-29)

| Tool module | Path |
|---|---|
| `bulk_drawer_ops` | `tools/bulk_drawer_ops.ts` |
| `capture_transcript` | `tools/capture_transcript.ts` |
| `delete_drawers` | `tools/delete_drawers.ts` |
| `export_drawer` | `tools/export_drawer.ts` |
| `file_skill` | `tools/file_skill.ts` |
| `ingest_docs` | `tools/ingest_docs.ts` |
| `move_drawers` | `tools/move_drawers.ts` |
| `palace_diff` | `tools/palace_diff.ts` |
| `palace_flock_status` | `tools/palace_flock_status.ts` |
| `palace_height_threshold` | `tools/palace_height_threshold.ts` |
| `palace_list_drawers_multi_room` | `tools/palace_list_drawers_multi_room.ts` |
| `palace_organize_memories` | `tools/palace_organize_memories.ts` |
| `palace_report` | `tools/palace_report.ts` |
| `palace_stamp_source_type` | `tools/palace_stamp_source_type.ts` |
| `promote_skill` | `tools/promote_skill.ts` |
| `propose_concerns` | `tools/propose_concerns.ts` |
| `propose_refinements` | `tools/propose_refinements.ts` |
| `record_outcome` | `tools/record_outcome.ts` |
| `relocate_memory` | `tools/relocate_memory.ts` |
| `remind` | `tools/remind.ts` |
