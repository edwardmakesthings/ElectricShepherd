# Follow-up: optional KG-fact filtering in `mempalace_search` (MemPalace substrate)

Deferred idea, captured during unified-memory Phase 0 investigation
(`docs/unified-memory-spec.md`, Phase 0 item 3; findings in
`.opencode/context/unified-memory-phase0-search-filter.md`). To be picked up as a
**separate PR after the current mempalace branch lands**.

## Context

Phase 0 verified that `mempalace_search` is pure semantic/BM25 retrieval with zero graph
awareness: its full input schema (`mcp_server.py:6131–6186`) is
`{query, limit, wing?, room?, source_file?, since?, before?, max_distance?, context?}` — no
KG-predicate argument of any kind — and search result rows carry no KG facts either
(`searcher.py:1827–1856`). So authority-aware retrieval (the spec's `es-source-type` axis)
cannot be expressed server-side today; the only option is retrieve-then-filter on the client.

## Why MemPalace-side filtering is architecturally nicer

- **Correct layer.** The substrate/policy split in `docs/memory-graph-design.md` says graph
  facts belong to the substrate, policy (which predicates matter) to Electric Shepherd. A KG
  join inside `tool_search`/`search_memories` keeps retrieval honest at the source instead of
  every client re-implementing the same fan-out.
- **One round-trip instead of N.** Client-side filtering costs one `kg_query` per candidate
  drawer (11–21 MCP calls for a top-10–20 result set). A server-side predicate filter is a
  single indexed SQLite lookup folded into the search call itself.
- **No silent degradation.** Per-candidate client checks degrade to "unknown" on failure and
  rely on each client passing whole, un-truncated drawer IDs through — a trap documented in
  `instructions/agent-discipline.md`. Server-side filtering has none of that surface.

## Why deferred

The current PR is scoped to the Electric Shepherd side (the `es-source-type` axis and
authority-aware ranking). Adding a substrate change now would mix two reviewable units, block
on MemPalace review timing, and expand this branch's blast radius for no near-term gain —
see "Why deferred" below: retrieve-then-filter is acceptable short-term.

## Current path (acceptable short-term)

Electric Shepherd does **retrieve-then-filter with parallel `kg_query`**: after
`client.search(...)`, one outgoing one-hop `kg_query` per candidate for the stamp predicate,
run in parallel (the exact shape of `getClosetStatus` at `adapter/memgraph.ts:787–799`, and
the P2-2 `es-status` filter at `adapter/retrieval-expansion.ts:314–325`). Each call is a
single indexed SQLite SELECT; for N=10–20 candidates that is well under a second on loopback,
and the pattern is already exercised at 5× this scale in the same pipeline. Failed checks
degrade to "unknown authority", never breaking retrieval. This stays until the substrate PR
lands; no client code changes when it does (the filter just becomes optional).

## Minimal follow-up proposal

- **API shape:** add an optional `kg_filter` argument to `mempalace_search`, e.g.
  `{"predicate": "es-source-type", "object": "doc"}` (or a small list of such pairs, AND-combined),
  applied as a post-filter in `tool_search`/`search_memories` against the KG — or, if cheaper,
  a denormalized metadata field on drawers kept in sync at write time. Predicate names stay
  client-defined; the substrate only does the join.
- **Tests:** (1) search with `kg_filter` returns only stamped drawers and is unchanged when
  omitted (backward compatible); (2) unstamped/unknown drawers are excluded, not defaulted;
  (3) filter + existing `wing`/`room`/date pre-filters compose; (4) a drawer whose fact was
  invalidated via `kg_invalidate` drops out of filtered results.
