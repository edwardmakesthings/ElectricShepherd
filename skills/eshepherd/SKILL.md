---
name: eshepherd
description: MemPalace MCP tool reference for Electric Shepherd. Use when doing memory-intensive work — the dreamer, retrieval expansion, derived-drawer lineage, or any session that reads or writes to the memory palace. Covers all core tools across palace read/write, knowledge graph, lineage/merge operations, navigation, diary, and system operations.
---

# MemPalace Tool Reference — Electric Shepherd

Complete reference for MemPalace MCP tools, with Electric Shepherd–specific policy
guidance. Load this file in `instructions` when doing memory-intensive work (the dreamer,
retrieval expansion, or any session that reads or writes derived drawers).

---

## Tool prefix

MemPalace tools are named `mempalace_<operation>`. If you are calling through a namespaced
MCP gateway, it may prepend its own namespace, producing:

```
<namespace>mempalace_<operation>
```

The correct prefix for your setup is in `QUICKSTART.md §2`. Use that full name for every
call — do not guess or abbreviate.

---

## Complete operation index

Every tool that exists is listed here. Models: do not skip tools you are uncertain about —
consult this table first.

### Palace — Read

| What you want to do | Tool |
|---|---|
| Palace overview (drawer count, wings, rooms) | `mempalace_status` |
| List all wings with drawer counts | `mempalace_list_wings` |
| List rooms within a wing (or all rooms) | `mempalace_list_rooms` |
| Full wing → room → count tree | `mempalace_get_taxonomy` |
| Semantic search by meaning | `mempalace_search` |
| Fetch a single drawer by ID | `mempalace_get_drawer` |
| List drawers with pagination/filtering | `mempalace_list_drawers` |
| Check for near-duplicate before filing | `mempalace_check_duplicate` |
| Get the AAAK dialect specification | `mempalace_get_aaak_spec` |

### Palace — Write

| What you want to do | Tool |
|---|---|
| File verbatim content (single drawer) | `mempalace_add_drawer` |
| Save a whole session at once (batch + diary) | `mempalace_checkpoint` |
| Update an existing drawer's content/location | `mempalace_update_drawer` |
| Delete a drawer by ID | `mempalace_delete_drawer` |
| Bulk-delete every drawer from one source file | `mempalace_delete_by_source` |
| Mine a directory into the palace | `mempalace_mine` |
| Prune orphan drawers (deleted/ignored source files) | `mempalace_sync` |

### Knowledge Graph

| What you want to do | Tool |
|---|---|
| Query an entity's relationships (with time filter) | `mempalace_kg_query` |
| Add a fact / relationship | `mempalace_kg_add` |
| Invalidate a fact (mark no longer true) | `mempalace_kg_invalidate` |
| Chronological timeline of an entity | `mempalace_kg_timeline` |
| KG overview (entity/triple counts) | `mempalace_kg_stats` |

### Synthesis Graph (native drawer + KG lineage)

| What you want to do | Tool |
|---|---|
| Create a synthesized summary from ≥2 source drawers | `mempalace_add_drawer` + `mempalace_kg_add` (`synthesized-from`) |
| Walk a node's sources (upward toward raw) | `mempalace_kg_query` (`predicate=synthesized-from`, `direction=outgoing`, `recurse=true`) |
| Walk nodes built from this one (downward) | `mempalace_kg_query` (`predicate=synthesized-from`, `direction=incoming`, `recurse=true`) |
| Compute a node's DAG height | `mempalace_get_height` |
| Follow the merged-into chain to canonical | `mempalace_resolve_canonical` |
| Surface merge candidates | `mempalace_find_merge_candidates` |
| Execute a merge decision | `mempalace_apply_merge` |
| Find structurally broken nodes | `mempalace_find_closet_lineage_issues` |
| Build scoped synthesis sets (for mem-core rendering) | `mempalace_search` + recursive `mempalace_kg_query` expansion |
| Replace or clear hall labels | `mempalace_kg_invalidate` + `mempalace_kg_add` (`predicate=in-hall`) |
| Known hall values | `hall_facts`, `hall_events`, `hall_discoveries`, `hall_preferences`, `hall_advice` |

### Navigation (Tunnels & Hallways)

| What you want to do | Tool |
|---|---|
| Walk the palace graph from a room | `mempalace_traverse` |
| Find rooms that bridge two wings | `mempalace_find_tunnels` |
| Palace graph overview (nodes, edges, top tunnels) | `mempalace_graph_stats` |
| Create a cross-wing tunnel | `mempalace_create_tunnel` |
| List explicit cross-wing tunnels | `mempalace_list_tunnels` |
| Delete a tunnel by ID | `mempalace_delete_tunnel` |
| Follow tunnels from a room to connected rooms | `mempalace_follow_tunnels` |
| List within-wing hallway records | `mempalace_list_hallways` |
| Delete a hallway record by ID | `mempalace_delete_hallway` |

### Agent Diary

| What you want to do | Tool |
|---|---|
| Write a diary entry | `mempalace_diary_write` |
| Read recent diary entries | `mempalace_diary_read` |

### System

| What you want to do | Tool |
|---|---|
| Check if a recent checkpoint was saved | `mempalace_memories_filed_away` |
| Get or set auto-save hook behaviour | `mempalace_hook_settings` |
| Force reconnect after external palace changes | `mempalace_reconnect` |

---

## Electric Shepherd tools (NOT MemPalace MCP — local plugin tools)

These wrap the MCP calls above and do the paging/aggregation OUTSIDE your context. Prefer
them over hand-rolled `list_drawers` loops, which burn context and time out on big wings.

| What you want to do | Tool |
|---|---|
| Fast flock/consolidation backlog quick counts (parent units + provisional) | `palace_flock_status` |
| Survey wings/rooms/counts without loading content | `palace_report` |
| What changed recently vs the period before | `palace_diff` |
| List several rooms in ONE call | `palace_list_drawers_multi_room` |
| Find drawers at or above a synthesis height | `palace_height_threshold` |
| Propose room/wing cleanup (read-only) | `palace_organize_memories` |
| Write a drawer to disk + get metadata only | `export_drawer` |
| Re-file a drawer, or lift a verbatim excerpt | `relocate_memory` |
| Backfill the `es-source-type` axis on existing drawers (bounded, dry-run first) | `palace_stamp_source_type` |
| Ingest a docs dir into the reference room + stamp es-source-type: doc (mine + staleness invalidation, dry-run first) | `ingest_docs` |
| Propose/apply `concerns` edges between a synthesis and its authority docs (validates endpoints; dry-run first; apply only approved) | `propose_concerns` |
| Move drawers in bulk between scopes | `move_drawers` |
| Delete drawers by ID or scope | `delete_drawers` |
| Force-capture THIS session's transcript now | `capture_transcript` |

Large drawers: never `get_drawer` a transcript into context. `export_drawer` writes it to
`.electric-shepherd/scratch/` and returns metadata plus head/tail previews; dispatch the
`drawer-digest` subagent against the returned `file_path`.

Flock status fast path: for `/memory-status` quick counts, call `palace_flock_status` first.
It already normalizes chunk-vs-parent counting and returns unconsolidated sources, summary-node
count, provisional count, backlog estimate, and threshold decision in one call.

---

## Consumption and status predicates (Electric Shepherd conventions)

These are as load-bearing as `synthesized-from`, and are NOT MemPalace built-ins:

| Predicate | Meaning | Who writes it |
|---|---|---|
| `consolidated-into` | `{subject: source drawer, object: closet}`. The ONLY signal that a source is consumed. Without it the next pass re-processes the same transcript, because `synthesized-from` (closet -> source) leaves the source looking untouched. | dreamer / consolidation script |
| `es-status` | `provisional` at closet creation; promoted to `active` only after validation confirms >= 2 DIRECT sources. Retrieval and mem-core render exclude `provisional` by default. | dreamer / validation pass |
| `es-source-type` | What KIND of material a drawer holds: `transcript` \| `doc` \| `synthesis` \| `skill`. ORTHOGONAL to `es-status` (kind vs validated) — never conflate them. Stamped at write time; missing = "unknown authority", never a default type. Backfill infers `transcript` from transcript-like rooms and `synthesis` from outgoing `synthesized-from` edges, and leaves everything else unstamped. | capture pipeline / consolidation / `palace_stamp_source_type` backfill |

Consolidation status is a GRAPH question, never a content question: answer it with
`kg_query` on `consolidated-into`. Reading drawer content cannot see the edge.

---

## Room naming

- Wings are `snake_case` (derived from directory normalization); rooms are `kebab-case`.
- Name rooms for PURPOSE or SUBSYSTEM, never derivation level. `synthesis`, `mem-synth`,
  `level-<n>`, `arc*` are rejected names — height already encodes level, computed from the
  `synthesized-from` DAG via `mempalace_get_height`.
- Call `get_taxonomy` before minting a room and reuse an existing one. Near-duplicate names
  (`layout` vs `layout-system`) split a topic across rooms that never co-retrieve.

---

## Command selection rules (use this first)

Choose by intent, not by similarity of names:

1. Building synthesis memory from multiple sources → `mempalace_add_drawer` + `mempalace_kg_add` (`synthesized-from`)
2. Linking factual entities or time-bound facts → `mempalace_kg_add`
3. Creating cross-wing navigation bridges → `mempalace_create_tunnel`
4. Saving a full session atomically → `mempalace_checkpoint` (not separate add+diary calls)

Do not mix these roles.

| Intent | Correct tool | Wrong tool to avoid |
|---|---|---|
| Synthesis lineage (drawer+KG) | `mempalace_add_drawer` + `mempalace_kg_add` | `mempalace_create_tunnel` |
| Merge duplicate derived drawers | `mempalace_find_merge_candidates` → `mempalace_apply_merge` | Manual `kg_add` for merge edges |
| Entity/fact assertion | `mempalace_kg_add` | `mempalace_create_tunnel` |
| Cross-project/room navigation | `mempalace_create_tunnel` | `mempalace_add_drawer` + `mempalace_kg_add` (lineage creation) |
| Batch session save | `mempalace_checkpoint` | Many separate `add_drawer` + `diary_write` calls |

Hard rule: `mempalace_create_tunnel` is for navigation only. It does not create
synthesis lineage and will not be used by synthesis DAG traversal, merge canonicalization,
or scoped synthesis retrieval.

---

## Synthesis summary creation — required fields

For synthesized summaries, enforce these fields before writing:

| Field | Type | Notes |
|---|---|---|
| `wing` | string | Wing to file the summary in (`add_drawer`) |
| `room` | string | Room to file the summary in (`add_drawer`) |
| `content` | string | Verbatim summary text |
| `source_drawer_ids` | array | **≥2** distinct drawer IDs this summary synthesizes from (used to emit `kg_add` lineage edges) |
| `desc` | string | One-line description in summary content/metadata for discoverability |

Optional but useful: `added_by` and hall tags via `kg_add` (`predicate=in-hall`).

Do NOT create a synthesized summary without `source_drawer_ids` and `desc`. If you don't
have at least two source IDs, you are not creating a synthesis summary — use `add_drawer` as a normal note.

---

## Merge execution — required fields

`mempalace_apply_merge` formalizes a merge decision the policy (dreamer) has already made.
Two required fields:

| Field | Notes |
|---|---|
| `source_node_id` | The node being merged away (will get a `merged-into` edge) |
| `canonical_node_id` | The surviving canonical node |

The tool is idempotent — re-merging a node that already resolves to the same canonical is
a no-op. After merge, use `mempalace_resolve_canonical` to verify the chain.

---

## Scoped retrieval + hall tags

Use scoped lineage query for mem-core rendering and policy ranking via:

- `mempalace_search` for seed set
- recursive `mempalace_kg_query` for neighborhood expansion
- `mempalace_get_height` + retrieval counters for deterministic ranking signals.

Manage hall labels as KG facts:

- `mempalace_kg_add` with `predicate=in-hall`
- `mempalace_kg_invalidate` to clear/reassign hall tags.

Convention: treat `pinned` as a policy label value when you need "always include"
behavior; do not assume substrate has special pin logic.

---

## KG predicates reserved for the synthesis graph

Do not use these predicates for unrelated facts — they are consumed by traversal logic:

| Predicate | Meaning |
|---|---|
| `synthesized-from` | B synthesized from A (B → A, upward toward sources) |
| `merged-into` | B was merged away; A is canonical |
| `concerns` | Synthesis → doc: cross-type authority pointer. ONE-HOP ONLY and NOT lineage — it does not affect height or feed lineage traversal. Written via `propose_concerns` (approval-gated, dry-run first); retrieval expansion pulls one-hop concerns targets into the ranked pool so a synthesis hit surfaces its authority doc. |

Use `mempalace_kg_add` to add these edges. Use `mempalace_kg_invalidate` to retire stale
ones (e.g. when a source is superseded). Retiring a wrong `concerns` edge is one
`kg_invalidate {subject, predicate: "concerns", object}` — no drawer content is ever touched.

---

## Memory layers — where to write

| Tier | Room convention | Tool |
|---|---|---|
| raw transcripts | default `source-transcripts` room in the project wing (configurable via source-capture room / consolidation `--room`; legacy setups may use `transcripts`) | `add_drawer` by the capture pipeline only — never hand-write, never edit; append-only source |
| summaries + facts | any wing, any room except context-blocks | `add_drawer`, `diary_write`, `kg_add`, `kg_invalidate` |
| mem-core | directory-scoped runtime-rendered files (`.electric-shepherd/memory`) | none directly. Rendered as part of consolidation pipeline runs (`--include-base-pipeline`); `run-mem-core-loader.ts` READS rendered files, it does not produce them. |

The runtime regenerates mem-core outputs from consolidated summaries/facts. mem-core is file-only and loaded by
directory scope; agents do not write mem-core directly, and it is not mirrored into MemPalace drawers.

---

## Search strategy

Start broad, then narrow:

```
mempalace_search query="<topic>" limit=10
```

If you find a relevant node, expand with recursive `mempalace_kg_query` over `synthesized-from`
for outgoing/incoming traversal. This is the
probabilistic-entry / deterministic-expansion pattern from the design doc.

Use `mempalace_check_duplicate` before filing new content — identical content gets a
deterministic ID and is silently skipped, but near-duplicates won't be caught without this
check.

---

## Recall protocol

Search the palace **before answering** whenever the question concerns past work, people,
prior decisions, or anything that may already be filed:

1. Call `mempalace_search` first — short keyword query, not a pasted conversation.
2. Use `mempalace_kg_query` for relational or time-bound facts about an entity.
3. Use `mempalace_diary_read` for recent session continuity.
4. Return verbatim drawer text — never paraphrase stored content.
5. After a substantive session, record continuity with `mempalace_diary_write` (skip if a
   background hook already saved via `mempalace_memories_filed_away`).

Do **not** search on pure greenfield work with no memory relevance.

---

## Unhappy paths

- **Empty results** — say the palace has nothing on this topic; do not invent an answer.
  Offer to widen the search (drop `wing` filter) or file new information.
- **MCP error / server down** — surface the error; suggest `mempalace status` or
  re-run `/mempalace-init`. Never silently fall back to guessing.
- **Stale in-memory index after CLI changes** — call `mempalace_reconnect` to resync the
  HNSW index with the on-disk palace.
- **Corrupt index** — stop the server and run `mempalace repair --mode from-sqlite
  --archive-existing --yes`, then `mempalace repair-status`. Do not re-mine (that drops
  MCP-added drawers and diary entries).
- **Conflicting KG facts** — trust the time-valid answer; call `mempalace_kg_invalidate`
  on the old fact then `mempalace_kg_add` for the new one.
