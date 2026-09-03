# Memory Graph — Design Document

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

Substrate is **mechanism** — store a derived memory, record an edge, traverse the graph,
count retrievals. Policy is **judgment** — *when* to consolidate, *what* to merge, *how* to
synthesize, *whether* something is durable. A substrate is policy-free: it exposes verbs
(`add_drawer`, `link`, `get_height`, `resolve_canonical`) without deciding when
they're called. The dreamer is nothing *but* policy — the opinionated process that decides
what to do with those verbs.

**The test for which side any piece lands on: does it require judgment, or is it mechanical?**
Mechanical → substrate → MemPalace. Judgment → policy → the separate project. This even
splits *within* a single operation: deciding two nodes should merge is judgment (policy);
recording that they merged is mechanical (substrate). The dreamer *decides* the merge, then
calls the substrate's `link` + `kg_invalidate` to *execute* it. That's the
probabilistic-wrapped-in-deterministic philosophy (§1) expressed as a repo boundary.

### MemPalace additions (substrate)

Developed in a **fork of MemPalace** with a PR open for upstreaming. Everything is
additive — raw drawers, the mining flow, and existing tools are untouched — which is what
makes it PR-able (maintainers accept substrate primitives; they reject opinionated policy).

- Reserved KG predicates + recursive traversal/height/canonical-resolution (§4, §5).
- Store-stamped `last_retrieved` / `retrieval_count` on the read path (§6).
- Thin gating helper for derived-memory (closet) creation (§7).
- (Largely obviated: the standalone synthesis-node drawer kind — summaries/arcs use native
  closets, durable facts use native KG triples, categories use native halls.)

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

## 2. The core idea — memory types are mutability contracts, mapped onto native MemPalace layers

Memory is **one graph whose nodes have different types, and a node's type determines what
operations are legal on it.** This replaces an earlier framing (a strict synthesis-height
tier ladder of "marked drawers"). The earlier model collapsed two orthogonal properties —
*origin* (verbatim / authored / derived) and *refinement* (how much consolidation has been
applied) — into one vertical ladder, which broke down as soon as real memory turned out to be
blended (transcripts, summaries, durable facts, arcs, mixed-in notes all coexisting). The
honest model separates them: type is the mutability contract; refinement is a continuous
property of position in the lineage.

Each type maps onto a layer MemPalace **already provides** — the typology is not imposed on
top of MemPalace, it *is* MemPalace's native structure used deliberately:

| Type (role) | Mutability contract | Native MemPalace home |
|---|---|---|
| **Raw transcript** | content frozen; dedup-mergeable by identity | **Drawer** (verbatim stored text) |
| **Summary / arc** | revisable, replaceable, mergeable; re-derivable | **Closet** (native summary layer, points to source) |
| **Durable fact** | supersedable *with history* (changelog) | **KG triple** (`valid_from`/`valid_to` + `kg_invalidate`) |
| **Category** | re-assignable | **Hall** (`facts`/`events`/`discoveries`/`preferences`/`advice`) |
| **Resident working set** | derived render, never authored | **mem-core** (file-only render) |

Orthogonal axes (kept separate from type): **wing** = project/person (scope), **room** =
topic within a wing (sub-scope). Wing-per-project powers cross-project connection.

**Refinement (formerly "height") survives, with sharper meaning.** Height is *depth in the
synthesis lineage* — a node synthesized from other syntheses is more refined than one
synthesized from raw drawers. It is no longer "the organizing dimension imposed by marked
drawers"; it is a property *computed from recursive traversal* of `synthesized-from` edges,
and it is still consumed by two things: mem-core ranking (importance = refinement × retrieval
× connection × pin) and selective forgetting (low-refinement AND cold AND unmodified = a
forgetting candidate). The thing that changed is the framing (one graph, typed nodes), not the
operations.

One structure still subsumes several otherwise-separate features:

| Concern | How the typed graph handles it |
|---|---|
| Replay-based consolidation | Active areas accumulate raw drawers, cross a threshold, get synthesized into closets. Refinement rises with re-synthesis. |
| Selective forgetting | Type-aware: forget cold closets freely, archive (never delete) stale drawers, supersede (never drop) durable facts, let arcs re-derive. |
| Evidence strength | A node's support = the lineage beneath it (recursive traversal). Many distinct sources = strong; one source = thin. |
| Confidence (relocated) | Trust lives in graph position, not model introspection. |
| Visualization | The graph renders as a node graph (Obsidian-style) for human audit. |

**The verbatim invariant, resolved properly.** MemPalace's thesis is "never summarize or
paraphrase stored content." This was in *apparent* tension with a synthesis layer; the
typology resolves it cleanly: **immutability applies only to the `raw` type (drawers).**
Summaries/arcs are closets (natively a revisable, non-verbatim layer) and durable facts are KG
triples (natively supersedable) — neither was ever bound by the verbatim invariant, because
the invariant was only ever about verbatim *source* content. ElectricShepherd never alters a
drawer's content; it creates closets, adds KG triples, and annotates. Compatible by
construction, not by working around the invariant.

**A consequence worth stating: ElectricShepherd is non-invasive.** Because every artifact it
creates is a native MemPalace object (closet, KG triple, hall assignment, retrieval metadata),
it works against whatever state a palace is already in, and removing it leaves the palace fully
intact and functional — just less organized. The one behavioral hook (retrieval counters)
lives in the substrate fork and degrades gracefully (existing counts persist, they simply stop
updating on upstream). Nothing depends on ElectricShepherd continuing to run.

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

## 4. Edges are KG triples; derived memory uses native layers (use what exists)

The big realization from the source: **MemPalace's KG is already the edge layer.** `kg_add`
is `subject → predicate → object` with `valid_from`/`valid_to` temporal windows AND a
`source_drawer_id` provenance link. That is an edge store — temporal, provenance-linked,
with `kg_invalidate` for superseding. We don't build one. And MemPalace already has the
*derived* layers too, so we don't build those either:

- **Summaries and arcs are closets**, not specially-marked drawers. Closets are MemPalace's
  native summary layer (compact, revisable, point back to source) — exactly the mutability
  contract a summary/arc needs. Raw source transcript drawers stay unmarked and untouched; the
  mining flow doesn't change.
- **Durable facts are KG triples** with validity windows. When a fact changes: `kg_invalidate`
  the old triple, `kg_add` the new one — the changelog/supersession behavior is native and
  free. This is where "durable fact as changelog" lives.
- **Categories are halls** (`facts`/`events`/`discoveries`/`preferences`/`advice`). The
  categorize step assigns a hall; it is re-assignable.
- **Edges are reserved KG predicates:** `synthesized-from` (B → A means B synthesized from A)
  and `merged-into` (§5). The lineage graph is these triples; traversal is KG traversal.
- **Recursive traversal lives in MemPalace** (substrate, mechanical). Native `kg_query` is
  one-hop (entity → its direct relations, no depth); recursive traversal is provided by
  `kg_query` with `recurse=true` (optionally predicate-scoped), with `get_height`
  (longest path) and `resolve_canonical` (merge-chain head) as deterministic helpers.
  It lives where the data lives (natively traversing, not reconstructing the graph
  outside MemPalace), is unit-tested there, and keeps ElectricShepherd thin.

This collapses most of what an earlier draft of this doc planned to build, and then collapses
it *further* than the first revision did: there is no invented edge store, no list-valued
drawer metadata (ChromaDB metadata is scalar-only anyway), **and no parallel synthesis-only
drawer subsystem** — summaries/arcs → closets, durable facts → KG triples, categories →
halls, edges → KG, recursive traversal → a substrate read API.
substrate PR shrinks accordingly (see the PR-rescope plan): retrieval counters and recursive
traversal survive as the genuinely-missing primitives; the synthesis-node machinery is largely
obviated by closets.

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

## 7. Schema-enforced derived-memory creation (substrate; the gap the reviews flag)

MemPalace's reviewers note "no write gating." The fork gates **derived-memory creation** (not
raw drawers — those stay as-is to preserve mining): creating a derived node (a closet
synthesis) *requires* a `DESC` and validated `synthesized-from` edges to real existing
sources. A creation missing them is rejected at the tool boundary — the model retries
deterministically, every time, instead of a validator catching malformed structure later.
Structural violations become *unrepresentable*; validators (§8) then handle only *judgment*
errors. (With the native-semantics rescope this gate is a thin helper over closet creation +
edge linking, not a whole synthesis-node subsystem.)

Also enforced here: the **empty-inflation guard**. A new refinement level is created *only
when it connects things not connected before* — never when it merely abstracts what's below.
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

The three memory tiers: **source transcript** (append-only verbatim transcripts, source of truth),
**derived memory** (the synthesis-height DAG — searchable, retrieved on demand), and **mem-core**
(the small always-resident working set, in context every turn without a retrieval decision).

**mem-core is not a place or a
separate store. It is a *rendered view* of derived memory.** There is one memory graph; mem-core
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
project box. If a synth node's lineage (its `synthesized-from` chain down to source transcript) reaches
a specific project room, it is related to that project — the graph already knows this. Scoping is therefore
a **traversal query**: "synth nodes whose lineage reaches scope X." A node touching three
projects appears in all three renders, correctly, with one stored copy — which is why this is
not duplication of derived memory. It is the same single graph viewed through a connection filter.

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
materializes memory files under `.electric-shepherd/memory/` so mem-core
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

- **Substrate (MemPalace):** recursive lineage traversal (`kg_query` with `recurse=true`
  plus predicate filtering), canonical resolution (`resolve_canonical`), and lineage height
  (`get_height`). All mechanical.
- **Policy (ElectricShepherd):** the ranking function, the top-N choice, per-scope tag config,
  where renders are written, and the dreamer's label/promote judgments (for example applying
  a `pinned` label).

The dreamer audits each scope's render against its synth trees for drift (the same audit it
does for global mem-core), so a stale resident set is flagged and re-derived rather than
rotting — the capability already built for global mem-core, extended with a scope parameter.


## 9b. Tier enforcement and injection: mechanical vs. still-convention

The three tiers are *structurally* sound (§§4–9a). This section grades them on the standard
that actually matters: **is each boundary enforced by mechanism, or hoped for by prompt?** —
and names the gaps where prompt-and-hope still lives. The pattern across the gaps is
consistent: the *deterministic machinery* (render, loader, gated writes, capture hooks) is
built, but the *injection and trigger plumbing* that connects machinery to the live context
at the right moment lags. The fixes are event-triggered plugins, not more prompts.

The reliability lever here is event-time mechanism, not prompt wording. Scoped mem-core
injection, transcript capture, and write-authority boundaries are strong only when they are
wired to deterministic runtime events (session start/idle/compaction and tool invocation)
rather than left to convention.


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
1. **Worklist (deterministic, no model):** query for source transcript drawers with no
   `synthesized-from` edge — i.e. unsynthesized. That's a graph query; it's the worklist.
   Triggerable by a `/consolidate`-style command that runs the *script*, not an agent.
2. **Per-item judgment (model as stateless function):** for each raw memory, one **bounded,
   isolated** model call — fresh context containing only that one transcript + a strict
   output schema ("read this, return this JSON"). No tools in this call (see §12a). The model
   returns a structured judgment (durable facts, decisions, confidence, tags). The script
   writes it to a local **journal** file (`eshepherd/cache/<id>.json`) — crash-safe and
   resumable: on restart the loop skips items that already have a journal entry. The model
   **never accumulates** across items; each call is stateless; the *script* holds loop state
   externally, so nothing fills a context and nothing compacts.
3. **Promote then clear:** a judgment is an **annotation on its source transcript drawer** (not a synth
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
different kinds of thing, so a per-memory judgment is stored as metadata *on the source transcript
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
derived memory anomalies (inconsistency, bad merge candidates, drift), not on approving every
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

## 14. Stack-level dependencies (cross-references to the decisions log)

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

Local serving runs llama.cpp behind `llama-swap` (one OpenAI endpoint,
on-demand model swap); LiteLLM points at it as `openai/` for the qwen family. `gemma4:26b`
stays on Ollama temporarily (mainline llama.cpp cannot load its MXFP4-fused MoE experts until
the converter PR lands); VRAM hand-off between the two runtimes is automated.

**Dynamic Context Pruning (DCP) is complementary, not competing.** DCP does model-decided
surgical compression of stale *interactive-session* content (keeping recent verbatim) — the
live-session analog of what the dream loop does for durable memory. Division of labor: DCP
owns interactive-session pruning; ElectricShepherd owns durable memory injection (mem-core
into the compaction prompt via `experimental.session.compacting`, source transcript capture). Both touch
the same compaction machinery, so they must coordinate (don't both rewrite the compaction
prompt) — test together early, since plugin-ordering interactions pass in isolation and break
combined.

DCP runs as a global OpenCode plugin (`@tarquinen/opencode-dcp`); ElectricShepherd's
compaction injection lives in `turn-guard`. Combined compaction-path integration behavior
still needs explicit joint validation so both plugins do not rewrite the prompt.
