# Memory Graph — Design Document

**Status: architecture reference for the policy/runtime split.**
ElectricShepherd now implements the policy side in this repository with a
 deterministic adapter + retrieval-expansion runtime path, while MemPalace remains the
 substrate dependency/fork boundary. Most sections below describe the intended design
 and the runtime contracts ElectricShepherd depends on.

This document was rewritten after reading MemPalace's actual source (`backends/base.py`,
`mcp_server.py` at v3.4.x). Two findings reshaped it: **(1)** the backend seam is a pure
vector-store contract — the wrong layer for a knowledge graph; the graph belongs at the
core/MCP-tool layer beside the existing KG. **(2)** MemPalace's KG is already a temporal,
provenance-linked triple store — it *is* the edge layer; we don't invent one. The design
below builds on what's actually there.

---

## 0. Project structure — substrate vs. policy (read this first)

The whole system splits into two projects along one principled line:

> **MemPalace is a memory *substrate*; the dreamer is a memory *policy*.**

Substrate is **mechanism** — store a synthesis node, record an edge, traverse the graph,
count retrievals. Policy is **judgment** — *when* to consolidate, *what* to merge, *how* to
synthesize, *whether* something is durable. A substrate is policy-free: it exposes verbs
(`create_synthesis_node`, `link`, `get_height`, `resolve_canonical`) without deciding when
they're called. The dreamer is nothing *but* policy — the opinionated process that decides
what to do with those verbs.

**The test for which side any piece lands on: does it require judgment, or is it mechanical?**
Mechanical → substrate → MemPalace. Judgment → policy → the separate project. This even
splits *within* a single operation: deciding two nodes should merge is judgment (policy);
recording that they merged is mechanical (substrate). The dreamer *decides* the merge, then
calls the substrate's `link` + `kg_invalidate` to *execute* it. That's the
probabilistic-wrapped-in-deterministic philosophy (§1) expressed as a repo boundary.

### Project A — MemPalace additions (substrate; open PR)

Developed in a **fork of MemPalace** with a PR open for upstreaming. Everything is
additive — raw drawers, the mining flow, and existing tools are untouched — which is what
makes it PR-able (maintainers accept substrate primitives; they reject opinionated policy).

- Synthesis-node drawer kind (§4).
- Reserved KG predicates + deterministic traversal/height/canonical-resolution (§4, §5).
- Store-stamped `last_retrieved` / `retrieval_count` on the read path (§6).
- Schema-enforced creation of synthesis nodes (§7).

If upstreamed, the fork shrinks to nothing and you rebase onto it. If not, carry the
small additive diff that rebases cleanly across MemPalace updates. ElectricShepherd is
built against this fork.

### ElectricShepherd — the dreamer (policy; separate repo)

A separate project that is a *client* of the substrate — it calls the substrate verbs, never
reaches into MemPalace internals. Holds: the consolidation dreamer (map-reduce fan-out), the
empty-inflation guard, bidirectional validation, confidence/escalation logic, model choices,
cadence (volume-queue + idle + nightly backstop), notifications/audit, and the
authored-notes *policy*. Survives MemPalace upgrades as long as the substrate verbs are
stable.

**The thin adapter (change-insurance).** ElectricShepherd talks to the substrate through a
small adapter module that maps "the graph operations the dreamer needs" → "the actual
MemPalace tool names." If substrate tool names change, you change the adapter, not the
dreamer. Cheap insurance; build it from the start. ElectricShepherd can shift between compatible
substrate builds without dreamer logic changes.

---

## 1. Design philosophy — the model is a probabilistic component wrapped in deterministic structure

**Reliability comes from minimizing what the model decides and maximizing what the structure
guarantees around those decisions.** Every probabilistic step is wrapped in deterministic
structure on both sides — deterministic candidate-generation *before* a model judgment,
deterministic consequence-application *after* it. The model makes the call; the machinery
sets up the call and executes the result.

This is why memory beats context (memory is structured and inspectable; context is an opaque
probabilistic blob), and the same move already used elsewhere in the stack: the gateway
finish_reason callback determinizes a model *output*, the turn-guard determinizes *when* a
memory decision is prompted, the custom tool suite determinizes *how* edits apply. The
substrate/policy split (§0) is this same principle as a repo boundary. Default answer to
"should this be a model decision or a script?": **script, unless it's irreducibly judgment —
and even then, wrap it.**

Irreducibly-probabilistic steps determinism must not try to reach: the semantic match at
retrieval entry, the synthesis act itself, and the final pairwise adjudications (same
conclusion? / is this parent supported?). Everything else is structure.

## 2. The core idea — a synthesis-height DAG over verbatim memory

Memory is a **synthesis-height DAG**. Raw drawers (verbatim, exactly as MemPalace stores
them) sit at height 0. Each consolidation pass produces *synthesis nodes* one level up that
express connections not visible in any single lower node. An area discussed twice has a
shallow tree (max height ~2); a major project a deep one (height 8). **Height is the
organizing dimension, and it emerges from activity** rather than being imposed.

One structure subsumes five otherwise-separate features:

| Concern | How the height-DAG handles it |
|---|---|
| Replay-based consolidation | Active areas accumulate height-0 nodes, cross a threshold, get re-synthesized upward. Height *is* replay count. |
| Selective forgetting | Shallow + cold nodes (low height, not retrieved, not modified) are the forgettable ones. Falls out of structure. |
| Evidence strength | A node's support = the lineage beneath it. Height-5 over 12 sources is strong; height-2 over 1 is thin. Readable from position. |
| Confidence (relocated) | Trust lives in graph position, not model introspection. |
| Visualization | The DAG renders as a node graph (Obsidian-style) for human audit. |

**Respecting MemPalace's verbatim invariant.** MemPalace's thesis is "never summarize or
paraphrase stored content." The synthesis layer does *not* violate this: raw drawers are
never altered. A synthesis node is a *new* drawer whose verbatim content happens to be a
synthesis, and the relationship to its sources lives in the KG. You add a layer; you never
rewrite the store. Philosophically compatible, not in tension.

## 3. The non-negotiable invariant: local edges only

**No node knows the whole graph. Each node knows only its immediate neighbors.** Global
structure is *traversed*, never *stored* — the principle that keeps the graph from getting
brittle as it grows (the web, the brain, distributed filesystems all work this way). Height,
ancestry, orphans, duplicate candidates: all **computed by traversal**, never authoritatively
held. A corrupt or missing derived value rebuilds; only a corrupt edge is real damage (which
validation guards).

It's a **DAG, not a tree** — `synthesized-from` is many-valued. One root-cause insight can
feed three distant higher-level connections (an auth bug informs "error handling is weak" AND
"we under-test edges" AND "the session layer needs rework"). Forcing one parent hides exactly
the cross-cutting connections synthesis exists to surface. A node's height is
`max(parent heights) + 1`, computed by longest path from any height-0 source.

## 4. Edges are KG triples; synthesis nodes are drawers (use what exists)

The big realization from the source: **MemPalace's KG is already the edge layer.** `kg_add`
is `subject → predicate → object` with `valid_from`/`valid_to` temporal windows AND a
`source_drawer_id` provenance link. That is an edge store — temporal, provenance-linked,
with `kg_invalidate` for superseding. We don't build one.

- **Synthesis nodes are drawers** marked `node_kind=synthesis` with `height` metadata. Content
  is verbatim like any drawer (just generated, not mined), so the verbatim invariant holds.
  Raw mem-raw drawers are unmarked and untouched — the mining flow doesn't change.
- **Edges are reserved KG predicates:** `synthesized-from` (B → A means B synthesized from A)
  and `merged-into` (§5). The DAG is these triples; traversal is KG traversal.
- **Deterministic traversal lives in MemPalace** (substrate, mechanical): `get_ancestors`,
  `get_descendants`, `get_height`, `resolve_canonical`, orphan/candidate detection — a
  read-side companion to the KG, computing over its triples and the synthesis-node drawers.
  It lives where the data lives (so it's natively traversing, not reconstructing the graph
  from query results outside), is unit-tested there, and keeps ElectricShepherd thin. ElectricShepherd
  calls `mempalace_get_height(node_id)` and trusts it.

This collapses most of what an earlier draft of this doc planned to build. No invented edge
store, no list-valued drawer metadata (ChromaDB metadata is scalar-only anyway — the reason
`add_drawer` writes only flat fields). Edges → KG. Nodes → drawers. Traversal → a substrate
read API over both.

## 5. Merge: symlink via KG, not delete (preserve convergence as signal)

When two transcripts independently reach the same conclusion, that convergence is *itself
information* — two paths to one insight is stronger evidence than one. Merge must keep both
provenance chains, never delete one.

Mechanism, entirely on existing primitives:
1. Substrate flags candidate duplicate pairs (semantically near, topologically distant —
   seeded by the existing `check_duplicate` tool, §6).
2. Validator (policy, model) adjudicates: same conclusion?
3. On yes: designate a **canonical** node; the other gets a `merged-into` KG edge pointing at
   canonical, and its stale `synthesized-from` edges are `kg_invalidate`d. **Both lineages now
   resolve under canonical**, so evidence strength correctly *rises* on merge (the thing a
   naive delete would destroy).
4. Substrate `resolve_canonical` follows `merged-into` chains transparently (B→A→canonical,
   like a filesystem following symlinks to the real inode). The model always lands on live
   canonical; merge is **idempotent**.

## 6. Store-stamped dates + retrieval counts (substrate; the determinism prompts can't give)

`add_drawer` already stamps `filed_at`. The fork added `last_retrieved` + `retrieval_count`,
**incremented by the store on the read path** — because the model genuinely can't know it was
the thing retrieved; only the store can. This is the one structural change that requires a
read-path write-back in the substrate; it's broadly useful upstream (time-decay scoring,
roadmap #337) and is part of the open PR.

These feed forgetting: a decay candidate is **low height AND not retrieved in X AND not
modified in Y** — three deterministic signals, no model judgment. The two temporal axes are
distinct: recently-modified-but-never-retrieved = churn the dreamer keeps touching but nothing
uses (suspicious); frequently-retrieved-but-never-modified = stable load-bearing knowledge
(the opposite of forgettable).

**Candidate detection** reuses `check_duplicate` (content + threshold, already an MCP tool)
as the seed for the near-but-distant query that serves both merge-candidates and
missed-connection candidates (entries semantically near but with no common ancestor — a
deterministic graph query over the KG).

## 7. Schema-enforced synthesis-node creation (substrate; the gap the reviews flag)

MemPalace's reviewers note "no write gating." The fork gates **synthesis-node creation**
(not raw drawers — those stay as-is to preserve mining): creating a synthesis node *requires*
a `DESC` and validated `synthesized-from` edges to real existing nodes. A creation missing
them is rejected at the tool boundary — the model retries deterministically, every time,
instead of a validator catching malformed structure later. Structural violations become
*unrepresentable*; validators (§8) then handle only *judgment* errors.

Also enforced here: the **empty-inflation guard**. A new height level is created *only when
it connects things not connected before* — never when it merely abstracts what's below.
Deterministic pre-gate (structurally: does this draw from ≥2 distinct lower nodes not already
sharing a parent?), then model judgment (is the content a genuine insight?). Cheap
deterministic filter first.

## 8. Bidirectional validation (policy; replaces the broken confidence signal)

Self-reported confidence is unreliable on local models (Qwen especially defends its output).
So validation is "compare two artifacts," never "introspect on your certainty" — the model
looks *outward*, which is what makes it work on over-confident models. Validator failures,
not a self-reported score, are the escalation trigger.

- **Downward — does the connection hold?** For a height-N node, pull its `synthesized-from`
  sources, ask: is this synthesized claim actually supported by them? Catches empty inflation
  and confidently-wrong synthesis. Substrate supplies the parent+children bundle; model judges.
- **Upward — were connections missed?** Proxy: nodes sharing strong tags but with no common
  ancestor are candidate missed connections — a deterministic graph query surfacing a bounded
  list the dreamer examines. Same query as merge-candidate detection.

**Escalation (policy):** a failure the local validator can't resolve → escalate that specific
case to a frontier model (Sonnet/Gemini, not Opus — coherence is judgment, not hard reasoning;
cheap because it runs on compressed nodes, not raw transcripts) → structured corrections the
dreamer applies. Conditional (only on local-validator flag), not every night. Unresolvable →
ntfy the human. **Git history becomes the trail you consult after a ping, not the tripwire.**

This is a dedicated context-isolated subagent (clean session, gets only the artifacts to
compare — audit independence). Isolation buys uncontaminated *comparison*; the *confidence*
fix is the proxies (graph-position evidence strength, validator contradictions), not the
isolation. Keep those two separate.

## 9. Retrieval: probabilistic entry, deterministic expansion (policy uses substrate)

The only probabilistic step at query time is the entry — a semantic match finds the relevant
node. From there **traversal takes over deterministically**: pull ancestors for context,
descendants for evidence, `merged-into`/canonical for alternates. The model picks the entry
point; the substrate's traversal mechanically supplies the connected neighborhood. Far more
reliable (and faster) than repeated free-form search. One match in, a bounded deterministic
neighborhood out.

## 9a. mem-core: resident memory as a deterministic, scoped render

The three memory tiers: **mem-raw** (append-only verbatim transcripts, source of truth),
**mem-synth** (the synthesis-height DAG — searchable, retrieved on demand), and **mem-core**
(the small always-resident working set, in context every turn without a retrieval decision).

**mem-core is not a place or a
separate store. It is a *rendered view* of mem-synth.** There is one memory graph; mem-core
is a deterministic markdown render of "the most load-bearing synth nodes for a given scope."
Global mem-core is one render; a project's mem-core is another render of the same graph
through a different scope filter. One renderer, scope as a parameter, output path as a
parameter — not multiple systems.

This is what makes it *memory* and not *config*. A directory-scoped `AGENTS.md`/`CLAUDE.md`
is authored config with good locality: static, hand-maintained, it rots because humans must
keep N of them current. mem-core has the property those files lack — it is **derived, never
authored**, so it is recomputed on every render and cannot fall out of maintenance. If a node
stops being retrieved, it drops out of the next render automatically.

### Scope is a graph-connection query, not separate storage

A render's scope is defined by *what the graph connects to*, not by putting nodes in a
project box. If a synth node's lineage (its `synthesized-from` chain down to mem-raw) reaches
a specific project room, it is related to that project — the graph already knows this. Scoping is therefore
a **traversal query**: "synth nodes whose lineage reaches scope X." A node touching three
projects appears in all three renders, correctly, with one stored copy — which is why this is
not duplication of mem-synth. It is the same single graph viewed through a connection filter.

Default scope = lineage reaches a room/path. An **optional per-scope tag config**
(ElectricShepherd-side) refines it: "also include nodes tagged `X`" or "only nodes tagged
`Z`" — the escape hatch for when raw graph-connection is too loose or too tight. Running the
filtered query is mechanism (substrate); choosing the filter is policy (config).

### The render is deterministic; the inputs may carry judgment

mem-core never falls out of maintenance because the **render is a pure function of graph
state**: rank synth nodes by a deterministic signal (e.g. height × retrieval-count ×
connection-degree) whose lineage reaches the scope, take the top N, emit markdown. Same graph
state → same output, always.

Judgment enters only as *data the render reads*, never as render logic: the dreamer may
apply a **label** to a node (for example `pinned`, meaning "resident for scope X regardless
of ranking") to catch the case where something is load-bearing but the deterministic signals
haven't caught up yet (a critical decision made yesterday with no accumulated retrievals).
The renderer honors label predicates but stays deterministic given them. This is the
materialized-view discipline again: the view is deterministic, but what it is a view *of*
can include curated marks. Result: never-rots (derived) *and* can-react-fast (via labels),
with no tension.

The deterministic policy runtime (`scripts/run-policy-cycle.ts`,
`scripts/run-memory-consolidation-and-validation.ts`, and adapter modules)
produces scoped selection/ranking plus automatic mem-core markdown renders. The runtime
materializes memory files under `eshepherd/memory/` (or `memory/` when present) so mem-core
behaves like dynamic config instead of a human-maintained prompt artifact.

### Nesting is permitted and nearly free

Scopes nest along the directory tree exactly like config files do — but each level is a
*render*, not an authored doc. Working in `monorepo/packages/subpackage`, the active resident set
is the merge of the renders along the path: `monorepo/.../memory.md` (repo-level: structure,
cross-cutting conventions) + `monorepo/packages/subpackage/.../memory.md` (package-level), loaded
outer-to-inner. This is the same directory-walk OpenCode/Claude Code already do for config —
reused, but each file is a maintained render instead of static config that rots. That is the
whole novelty in one line: **directory-nested resident memory that is derived, not authored,
so it cannot go stale.**

Allow arbitrary nesting in the *mechanism* (it costs nothing — it's just "render at each
scope on the path"); let *usage* decide how deep is useful rather than capping it. The static
nested-config failure mode (rot) does not apply because nobody maintains the renders by hand.
The only real cost is context budget (stacked resident sets stack tokens), which is a per-
render top-N tuning question, not an architectural one. Project-level scope is clearly worth
it; finer directory-level scope is permitted-but-prove-it — the value drops below the project
level and the context cost doesn't.

### mem-core is a notepad beside recent turns, not a re-derivation of the whole context

A guard against a tempting-but-wrong version. The context the model sees each turn is a flat
token sequence reassembled fresh every call from a *curated slice* of stored history (OpenCode
already separates full stored history from the model-context slice it sends). The wrong idea
is "re-derive the *entire* context each turn from mem-core + system prompt only" — that throws
away recent turns and produces an agent that forgets what was just said: amnesia with a
reference book. The right composition is **[system prompt] + [mem-core: the distilled resident
working set] + [recent N turns, verbatim] + [current message]**. Recent conversation stays raw
(no forgetting the immediate thread); only *old* context is distilled into mem-core and dropped
from verbatim history. mem-core is the notepad the agent refers to; it does not replace the
agent's short-term memory of the current exchange. OpenCode's own compaction already protects
recent turns (tail-turn protection) while distilling old ones — the notepad model matches how
the harness already behaves; mem-core just makes the distilled part graph-derived and scoped.
(What gets *re-derived* each turn is which mem-core to inject — cheap, the notepad refreshing —
not the conversation.)

### Substrate vs. policy split for mem-core

- **Substrate (MemPalace):** the scoped lineage query ("synth nodes whose lineage reaches
  scope X"), node labels, query-time label filters (`match_labels`, `match_mode`,
  `labeled_only`), and label-policy discovery (`get_label_policy`). All mechanical.
- **Policy (ElectricShepherd):** the ranking function, the top-N choice, per-scope tag config,
  where renders are written, and the dreamer's label/promote judgments (for example applying
  a `pinned` label).

The dreamer audits each scope's render against its synth trees for drift (the same audit it
does for global mem-core), so a stale resident set is flagged and re-derived rather than
rotting — the capability already built for global mem-core, extended with a scope parameter.


## 9b. Tier enforcement and injection: mechanical vs. still-convention

**Status update (2026-06-23):** the gap framing in this section is now mostly
historical. ElectricShepherd's current `turn-guard` wiring already implements
compaction-aware scoped reinjection and OpenCode-oriented capture verification,
and the runtime now includes shared synthesis locking and orphan/hang hardening.
The gap descriptions are retained below as design rationale and failure-mode
analysis.

The three tiers are *structurally* sound (§§4–9a). This section grades them on the standard
that actually matters: **is each boundary enforced by mechanism, or hoped for by prompt?** —
and names the gaps where prompt-and-hope still lives. The pattern across the gaps is
consistent: the *deterministic machinery* (render, loader, gated writes, capture hooks) is
built, but the *injection and trigger plumbing* that connects machinery to the live context
at the right moment lags. The fixes are event-triggered plugins, not more prompts.

### Scorecard

| Tier | Boundary | Status |
|---|---|---|
| **mem-raw** | transcripts pushed in, append-only | **Mechanical** (hooks fire on Stop/PreCompact → `mempalace mine`; append-only enforced substrate-side). One wiring check: confirm it fires on the *OpenCode* harness, not only the Claude Code/Codex/Cursor hooks it was built for. |
| **mem-synth** | only well-formed nodes exist | **Mechanical** (substrate gates `create_synthesis_node` on DESC + ≥2 validated sources; inflation guard blocks weak syntheses before write). |
| **mem-synth** | *only the dreamer writes it* | **Convention** — nothing stops an interactive agent from calling `create_synthesis_node` if it holds the tool. Gap #3. |
| **mem-core** | derived render, file-only, never round-trips | **Mechanical** (post-audit: render is deterministic, file-only). |
| **mem-core** | *right render present in context, at compaction not just session start* | **Mechanical in OpenCode plugin path** — `turn-guard` re-resolves and reinjects scoped mem-core on `session.started`, `session.idle`, and `session.compacted` (remaining risk is harness/tooling drift, not missing mechanism). |

The counterintuitive result: the most important tier (mem-core, the always-resident one) is
the *least reliably present when it matters*, because injection is the unsolved part.

### Gap #1 — compaction-aware mem-core re-injection (highest priority, not deferrable)

Compaction is a re-injection event, and nothing initially guaranteed mem-core survives it or
is refreshed at it. mem-core enters context via OpenCode's `instructions` at session start;
when OpenCode compacts, the post-compaction context is determined by the summarizer, not
re-derived from the render. Worse, compaction is exactly when you'd want to *re-pull the
freshest render* — the consolidation pass may have updated it, or the work may have crossed
into a different scope since session start.

**The seam is a documented OpenCode hook: `experimental.session.compacting`.** It fires
*before* the LLM generates the continuation summary, and a plugin can either inject context
into the compaction prompt or **replace the compaction prompt entirely** (`output.prompt`).
This is the real "run a script before the agent's context is cleaned" mechanism — not the
earlier turn-guard approach of injecting mem-core as a synthetic user message (which was at
the summarizer's mercy). The fix: turn-guard implements `experimental.session.compacting` to
inject the freshly-resolved scoped mem-core into the compaction prompt, guaranteeing it
survives into the post-compaction context. Mirrors the existing PreCompact *push* (transcripts
out to mem-raw) with a *pull* (mem-core in).

Two cautions: the hook is `experimental.` (an active proposal, #4317, would stabilize
`/compact` and the compaction API), so isolate it behind a thin wrapper — same adapter
discipline as the MemPalace tool names — so a rename touches one file. And OpenCode's
*unrecoverable-overflow* case is real (if compaction itself overflows, the session hard-fails),
which is another argument for keeping context shallow proactively rather than letting it grow
to where even summarization can't fit. Validate against the real hook on the brutal
low-context local models (4-turn compaction) before building anything larger on it.

### Gap #2 — scope-aware injection wiring

`mem-core-loader.ts` correctly resolves and merges the directory-nested render (broad→narrow)
for a given directory — but nothing wires its output into what OpenCode actually injects based
on *where the work is happening*. OpenCode loads a static `instructions` list; it does not call
the loader to pick the scope-appropriate render for the file being edited. So the
directory-nested-render design exists as a *capability* (the loader runs, produces correct
merged markdown) but is not *connected* to injection. Current behavior is "always load the
global blocks," not "load the merged scoped render for wherever you are." The scoping is built
but not plumbed. Fix: a mechanism (plugin watching the active working directory, or a
re-resolve at session-start/compaction) that makes injection consult the loader rather than a
static list. Until then, the scoping designed in §9a is inert.

### Gap #3 — enforce "only the dreamer writes mem-synth" (if it's a real invariant)

The design says only the dreamer creates mem-synth, but that is currently a convention — an
interactive `build`/`plan` agent with the synthesis tools in scope could call them mid-session.
If the invariant is real, enforce it the same way Serena's memory tools were gated: tool-scope
`create_synthesis_node` / `apply_merge` to the dreamer agent only, deny them to interactive
agents. Cheap, closes the gap, and keeps the substrate/policy boundary honest (interactive
agents write *raw* via the capture path; the dreamer is the sole synthesizer). Note this is
distinct from §6/§7's *write-quality* gating (which is mechanical and stays) — this is
*write-authority* gating.

### Gap #4 — verify mem-raw capture fires on OpenCode

The capture hooks (`mempal_save_hook.sh`, `mempal_precompact_hook.sh`) were written for the
Claude Code / Codex / Cursor hook protocols. The active harness is OpenCode. Confirm the
OpenCode equivalent (a compaction plugin or Stop-equivalent) actually fires the
`mempalace mine`, because if it doesn't, mem-raw silently stops capturing and the failure is
invisible until a dreamer run comes up empty. Design is sound; this is a wiring-verification
item.

### The shape of the fix, and why it's not "more prompts"

All four gaps are closed by **event-triggered plumbing** — plugins on compaction,
directory-change, and session-start that *deterministically* perform injection/capture — plus
one tool-scope denial. None is closed by a better prompt. This is the same lesson as the
self-editing-memory checkpoint: a deterministic trigger at a fixed event beats hoping the
right thing happens. The substrate got solid first; this is the orchestration layer that wires
it into live sessions, and it is the natural build phase *before* the graph-view inspection
surface (operational reliability precedes inspection — you make the loop correct, then make it
visible). Build order: Gap #1 (compaction re-injection) first (load-bearing, not deferrable),
then #2 (scope wiring), then #3 and #4 (cheap closes).

### Implementation status (ElectricShepherd repo)

Current plugin/runtime state now closes these with deterministic wiring:

- Gap #1: `plugin/turn-guard.ts` handles `session.compacted` and re-injects scoped mem-core
  by invoking `scripts/run-mem-core-loader.ts`.
- Gap #2: reinjection resolves scope from session/event metadata and recent file paths, then
  loads broad→narrow scoped renders through the loader.
- Gap #3: `turn-guard` enforces write-authority as an event-time guard by detecting
  unauthorized `create_synthesis_node` / `apply_merge` calls and issuing deterministic
  correction prompts (authoritative hard denial still belongs in harness/tool-scope policy).
- Gap #4: `turn-guard` emits OpenCode mem-raw capture verification heartbeats and optional
  capture-command execution status to `./.electric-shepherd/turn-guard-status.json`.
- Operator control surface: slash commands in `command/` (`/count-sheep`, `/herd`,
  `/lucid-dream`, `/wake-up`, `/headcount`) provide explicit consolidation actions;
  memory-mutating commands run as isolated subtasks, while `/wake-up` intentionally
  runs in-session to refresh the active context.
- Auto-synthesis hardening: idle/volume/compaction triggers are now guarded by
  cooldown + timeout watchdog + cross-process lockfile + process-tree kill +
  bounded tracking maps + start-failure cooldown rollback.
- Standalone scheduler safety: `scripts/run-memory-consolidation-and-validation.ts`
  now uses shared lock primitives in `scripts/synth-lock.ts` so cron/n8n runs do
  not overlap plugin-triggered synthesis runs.


## 10. Authored-notes unification (mechanism = substrate, policy = ElectricShepherd)

The dreamer can pull authored Obsidian notes into the *same* DAG — dissolving the usual
earned-vs-authored knowledge split. A debugging insight can gain a `synthesized-from` edge to
a design principle you wrote months ago; the dreamer can *discover* and make that edge.

- **Mechanism (substrate):** a note becomes a node (a drawer, or a referenced external node),
  linkable like any other.
- **Policy (ElectricShepherd):** *which* notes enter, at *what* height, *when*.
- **Boundary (non-negotiable):** the dreamer creates edges *to* authored notes and synthesizes
  *above* them — it **never edits** an authored note. Authored notes are immutable source at
  variable height. Distinct from `oikb` (a separate RAG surface); here notes become nodes in
  the memory graph itself.

## 11. Cadence (policy): volume-queue + idle execution, nightly backstop

Nightly is cargo-culted from biology; the real trigger is **accumulated unconsolidated volume
in an area** (and detected incoherence). Biology consolidates during sleep due to resource
contention, not the clock — practical compute contention (VRAM and runtime availability)
still applies, so the mechanism transfers but the trigger shouldn't be purely time.

- **Deterministic queueing:** a per-area counter increments as height-0 nodes arrive; crossing
  threshold N flags the area for re-synthesis. (This *is* selective replay — busy areas climb,
  quiet areas stay shallow and eventually decay.)
- **Opportunistic execution:** flagged work runs when idle (no active session, GPU free).
- **Nightly backstop:** catches what didn't trigger, plus global passes (orphan sweep, decay).

## 12. The dreamer: a script owns the loop, the model is a stateless judgment function

**The control hierarchy is inverted from the usual pattern.** The dominant pattern is
*agent-orchestrates-scripts* — the LLM is the control flow, holds the loop in its context,
decides what to do next, calls tools as subroutines. The dreamer is the opposite:
*script-orchestrates-model* — a deterministic program is the control flow, holds the loop,
decides what's next, and calls the model as a subroutine for the one thing only a model can
do: make a bounded judgment. Factory, not agent: the assembly line (script) is fixed and
deterministic; each worker (a model call) does one judgment at its station and passes the
result down the line; no worker holds the whole factory in its head.

This was forced by observation. The earlier design put a `dreamer` *agent* in charge of the
pass — it had to hold watermark, fan-out, collect, synthesize, merge-review, drift-audit,
mem-core refresh, and dream-log in its context as control flow, on a 24B local model. It
couldn't: the orchestration ate the context the work needed, and it compacted before
producing anything (and never delegated to mappers). Putting the component that's *worst* at
long deterministic procedure (probabilistic, limited context) in charge of the procedure,
while the component that's *best* at it (a script) sat idle as an occasionally-called tool,
was upside down. The fix is to give the loop to the script.

**The loop (script-owned, resume-safe):**
1. **Worklist (deterministic, no model):** query for mem-raw drawers with no
   `synthesized-from` edge — i.e. unsynthesized. That's a graph query; it's the worklist.
   Triggerable by a `/count-sheep`-style command that runs the *script*, not an agent.
2. **Per-item judgment (model as stateless function):** for each raw memory, one **bounded,
   isolated** model call — fresh context containing only that one transcript + a strict
   output schema ("read this, return this JSON"). No tools in this call (see §12a). The model
   returns a structured judgment (durable facts, decisions, confidence, tags). The script
   writes it to a local **journal** file (`eshepherd/cache/<id>.json`) — crash-safe and
   resumable: on restart the loop skips items that already have a journal entry. The model
   **never accumulates** across items; each call is stateless; the *script* holds loop state
   externally, so nothing fills a context and nothing compacts.
3. **Promote then clear:** a judgment is an **annotation on its mem-raw drawer** (not a synth
   node — see §12b), committed once journaled. Clear each journal file only *after* its
   annotation is confirmed committed (per-item, not all-at-once) — a write-ahead-log
   discipline: the annotation is authoritative once written; the journal is the rebuildable
   buffer discarded only when the real write lands.
4. **Reduce (model, seeing compressed judgments only):** group annotated-but-unsynthesized
   memories and create synth nodes — again bounded calls, the model seeing distilled
   judgments, not raw transcripts; the script writes the nodes and edges.

Per-memory judgments and pairwise adjudications are bounded function calls; relationship
*finding* is substrate work (§12c). Model: Qwen3.6-27B for the judgment/synthesis calls.

### 12a. Direct model calls, no tools (immunity to the finish_reason bug by design)

The judgment and adjudication calls go **directly to the model (via LiteLLM), with no tools
offered.** Two reasons. First, the factory model means the model never needs tools — the
*script* does all tool-work (queries, traversal) deterministically and hands the model
already-fetched data; the model only judges and returns text. Second, this grants *immunity*
to the LiteLLM-Ollama `finish_reason`/`tool_calls` bug (the adapter mis-parses tool calls and
returns `finish_reason: stop` with `tool_calls: null`): a call that requests **no tools** has
no tool-call signal to mis-parse — you ask for JSON, you get text, the script parses and
schema-validates it (bounded retry on malformed output). The whole bug class can't touch the
dream loop. (Switching the local backend to llama-server — see decisions log — fixes the bug
at the source for the *interactive* path; the dream loop is immune regardless.)

### 12b. A judgment is an annotation, not a synth node

A **synth node connects ≥2 memories**; a **judgment annotates one memory**. They are
different kinds of thing, so a per-memory judgment is stored as metadata *on the mem-raw
drawer* (e.g. a `judgment` field + a `judged` status), never as a synth node. The
synth-creation step then queries "judged-but-unsynthesized" drawers. This keeps the synth
graph meaning what it says (connections), and keeps judgments queryable as the worklist
marker. Uncommitted/pending judgments are **script-private** (local journal, or a
`pending`-status the agent-facing read path filters out) and the script may purge them
freely — agents only ever see committed, validated memory.

### 12c. The dream script uses MemPalace as a library, and finds relationships in a funnel

The script imports **MemPalace directly as a library** (or queries its DB) rather than
talking to the MCP server. MCP is the *agent-facing* boundary — it exists so a *model* can
reach tools across a protocol. The script is not an agent; making it speak MCP to annotate a
row it could write directly is overhead, and the library path also lets it write the
script-private states (pending judgments) the MCP tools don't expose. (Content writes that
need embedding still go through MemPalace's own functions so the invariants and embedding
hold — library, not raw SQL.)

Relationship-finding is a **deterministic funnel**, model only at the end: tag-overlap (free,
pure set intersection) → substrate similarity (`check_duplicate` / near-but-distant query,
cheap) → model adjudication only on the few survivors. The substrate *finds* candidates; the
model only *judges finalists*. The need for an agent-with-tools to "find related memories" is
a smell that orchestration leaked back into the model.

Safety: the script revises synth nodes and re-renders mem-core, never edits raw-drawer
*content* (only appends annotations), never touches code. Human audit concentrates on
mem-synth anomalies (inconsistency, bad merge candidates, drift), not on approving every
mem-core refresh.

## 13. The honest risk, and what bounds it

A real system that can silently corrupt memory. What bounds it: the substrate's traversal/
merge/height machinery is **deterministic and unit-tested** (it lives in MemPalace, testable
in place — plant an orphan, assert found; build a known DAG, assert height; chain three
merges, assert resolution lands on canonical), and the **substrate/policy line stays clean**
(the model never writes a value the substrate computes — height, canonical, dates; the
substrate never makes a synthesis judgment).

Build approach is build-whole-then-test (matching the rest of the stack — architecture
trusted up front from node-system expertise). So the substrate unit tests aren't phase gates;
they're a **debugging accelerant** for this domain's specific failure mode: a structural bug
in memory is *silent* (it surfaces weeks later as the dreamer making subtly wrong synthesis
decisions that *look* like model-judgment errors). The tests let you rule out the substrate
fast and know a bad result is judgment, not machinery. Non-optional for that reason.

---

## 14. Build order (re-homed by project)

A dependency sequence, not validation gates. The current batch dreamer runs throughout;
this grows beside it. Build the substrate (Project A, in the fork) first; build the policy
(ElectricShepherd) against it. Source spots to confirm against the real code are marked [CONFIRM].

### Project A — MemPalace fork (substrate; open PR)

**A1 — synthesis-node drawer kind + retrieval counters.** *(Done.)* Added `node_kind=synthesis` + `height`
metadata to drawers; `last_retrieved`/`retrieval_count` stamped on the read path.
Pure additive metadata + a read-side counter. Implements §4 (nodes), §6.

**A2 — synthesis edges + traversal API.** *(Done.)* Reserved `synthesized-from`/`merged-into` predicates;
added the deterministic traversal read-API (`get_ancestors`/`get_descendants`/`get_height`/
`resolve_canonical`/candidate-detection) over the KG + synthesis nodes, as new MCP tools.
Reuses `check_duplicate` as the candidate seed. Implements §3, §4 (edges/traversal), §5
(resolution), §6 (candidates). Visual graph render extends the existing exporter.

**A3 — schema-enforced synthesis creation + empty-inflation pre-gate.** *(Done.)* Synthesis-node
creation gated on required DESC + validated edges; deterministic ≥2-distinct-parents pre-gate.
Implements §7.

**A4 — scoped lineage query + labels (for mem-core renders, §9a).** *(Done.)* Added two
additive capabilities: (1) `find_scoped_synthesis_nodes`, a scoped traversal query returning
synth nodes whose lineage reaches a given room/scope, with deterministic ranking signals
(height, retrieval_count, connection-degree) exposed so a caller can rank without re-deriving;
and (2) generic node labels (set/clear + filter) via `set_synthesis_labels` with
`match_labels` / `match_mode` / `labeled_only`, plus `get_label_policy` so callers can
discover owner-configured allowed labels. This keeps mechanism in substrate and policy in the
dreamer (for example, ElectricShepherd can treat label `pinned` specially without MemPalace
encoding that policy). Implements §9a. (A1–A4 are the open-PR set: additive, no policy.)

### ElectricShepherd — the dreamer (policy; separate repo, against the fork)

**Policy step 1 — thin adapter foundation.** The module mapping dreamer graph-ops → MemPalace
tool names. Build first so everything else in policy code is insulated from substrate renames (§0).

**Policy step 2 — retrieval expansion.** Probabilistic-entry/deterministic-expansion recall (§9)
via the adapter. Immediately useful; exercises the A2 traversal API.

**Policy step 3 — synthesis consolidation (map-reduce) + inflation guard.** §12, §7
(content-judgment half). Creates synthesis nodes via the substrate.

**Policy step 4 — bidirectional validation + merge adjudication + escalation.** §8, §5
(adjudication half). The context-isolated validator subagent, conditional frontier escalation,
ntfy-on-unresolved.

**Policy step 5 — authored-notes policy + volume-queue cadence.** §10 (policy half), §11.

**Policy step 6 — tier enforcement + injection plumbing (§9b).** The orchestration that makes
the three tiers *operationally* reliable rather than only structurally sound. In priority
order: (a) compaction-aware mem-core re-injection plugin — pull-on-compact mirroring the
existing push-on-compact (load-bearing, not deferrable); (b) scope-aware injection wiring so
the loader actually drives what's injected for the current working directory; (c) tool-scope
`create_synthesis_node`/`apply_merge` to the dreamer only (write-authority gating); (d) verify
mem-raw capture fires on the OpenCode harness. All are event-triggered plumbing + one tool-
scope denial — no prompts. Build this **before** the graph-view inspection surface
(operational reliability precedes inspection).

#### Implementation status (policy, ElectricShepherd repo)

- **Steps 1–2 (adapter + retrieval expansion).** *Built.* `adapter/memgraph.ts` is the
  graph-ops→MemPalace adapter; `adapter/retrieval-expansion.ts` does probabilistic-entry /
  deterministic-expansion recall.
- **Steps 3–4 (synthesis consolidation + validation/merge).** *Built.*
  `adapter/synthesis-consolidation.ts` (map-reduce + inflation guard) and
  `adapter/validation-merge-review.ts` (context-isolated validation, merge adjudication).
- **Step 5 (cadence).** *Built.* `adapter/cadence-orchestrator.ts` +
  `.electric-shepherd-cadence-state.json` drive the volume-queue cadence.
- **Step 6 (tier enforcement + injection plumbing, §9b).** *Built* via `plugin/turn-guard.ts`
  (gaps #1, #2, #4 closed; gap #3 is event-time warn-guard plus config-level tool denial, not
  hard substrate enforcement — see scorecard).
- **§12 factory inversion — partial / divergent.** The consolidation pass *is* a script that
  owns the loop (`scripts/run-memory-consolidation-and-validation.ts`: worklist-first,
  batch-chunked, cross-process lock via `scripts/synth-lock.ts`, triggered by `/count-sheep`
  and auto-synth-on-compact — not an agent-in-charge). But its *internal mechanics* still
  diverge from §12a–c: it talks to MemPalace over **MCP** (not as a library), uses **live
  subagent mappers/auditors** (not per-item bounded **no-tools** direct model calls), and has
  **no `eshepherd/cache/` crash-safe judgment journal** or `judged`-status drawer-annotation
  promote-then-clear funnel. The factory *shape* is real; the strict no-tools/library/journal
  form in §12 is the remaining work.

Substrate A1–A2 are the foundation and highest value-to-risk (schema, counters, the
deterministic graph + visualization — all before any model-judgment machinery). Everything
that can go wrong by *judgment* (ElectricShepherd) sits on a proven deterministic substrate.

### PR sequencing

A1–A4 are implemented in the MemPalace fork (open PR). Run ElectricShepherd against that build.
If/when those additions land upstream, ElectricShepherd's adapter repoints to the upstream toolset
without changing dreamer logic. If the substrate surface differs across environments,
adjust only the adapter mapping. Either way ElectricShepherd is insulated.

---

## 15. Stack-level dependencies (cross-references to the decisions log)

ElectricShepherd's reliability rests on two stack-level choices recorded in the decisions log;
noted here because they directly shape the architecture above.

**Local serving via llama-server, not Ollama (behind LiteLLM).** The
`finish_reason`/`tool_calls` breakage is in LiteLLM's *Ollama adapter* specifically (it
mis-parses Ollama's tool calls, returning `finish_reason: stop` / `tool_calls: null`); direct
curl to Ollama is correct, and llama-server exposes a natively OpenAI-compatible endpoint that
LiteLLM passes through without that transformation. Pointing LiteLLM at llama-server as an
`openai/` provider removes the bug from the *interactive* path. The dream loop is immune
regardless (§12a, no tools requested). LiteLLM stays — it's the gateway that defines models
once for every surface; only the backend behind it changes.

*Status: landed.* Local serving runs llama.cpp behind `llama-swap` (one OpenAI endpoint,
on-demand model swap); LiteLLM points at it as `openai/` for the qwen family. `gemma4:26b`
stays on Ollama temporarily (mainline llama.cpp cannot load its MXFP4-fused MoE experts until
the converter PR lands); VRAM hand-off between the two runtimes is automated.

**Dynamic Context Pruning (DCP) is complementary, not competing.** DCP does model-decided
surgical compression of stale *interactive-session* content (keeping recent verbatim) — the
live-session analog of what the dream loop does for durable memory. Division of labor: DCP
owns interactive-session pruning; ElectricShepherd owns durable memory injection (mem-core
into the compaction prompt via `experimental.session.compacting`, mem-raw capture). Both touch
the same compaction machinery, so they must coordinate (don't both rewrite the compaction
prompt) — test together early, since plugin-ordering interactions pass in isolation and break
combined.

*Status: adopted, combined-integration test pending.* DCP runs as a global OpenCode plugin
(`@tarquinen/opencode-dcp`); ElectricShepherd's compaction injection lives in `turn-guard`.
The two have not yet been exercised together through a real compaction to confirm they don't
both rewrite the prompt.
