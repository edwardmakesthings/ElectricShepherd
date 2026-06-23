# MemPalace Tool Reference — Electric Shepherd

Reference for using MemPalace MCP tools in the context of the Electric Shepherd memory
policy layer. Load this file in `instructions` when doing memory-intensive work (the dreamer,
retrieval expansion, or any session that will write synthesis nodes).

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

## Core operations at a glance

| What you want to do | Tool |
|---|---|
| Search memory | `mempalace_search` |
| File verbatim content | `mempalace_add_drawer` |
| Update existing drawer | `mempalace_update_drawer` |
| Create a synthesis node | `mempalace_create_synthesis_node` |
| Walk a node's sources (upward) | `mempalace_get_ancestors` |
| Walk nodes built from this one (downward) | `mempalace_get_descendants` |
| Get a node's height in the DAG | `mempalace_get_height` |
| Find the canonical after a merge | `mempalace_resolve_canonical` |
| Detect merge candidates | `mempalace_find_merge_candidates` |
| Find structurally broken nodes | `mempalace_find_orphan_synthesis_nodes` |
| Find scoped synthesis nodes | `mempalace_find_scoped_synthesis_nodes` |
| Execute a merge decision | `mempalace_apply_merge` |
| Replace or clear synthesis labels | `mempalace_set_synthesis_labels` |
| Inspect allowed label policy | `mempalace_get_label_policy` |
| Add a KG fact | `mempalace_kg_add` |
| Invalidate a KG fact | `mempalace_kg_invalidate` |
| Check for near-duplicates before filing | `mempalace_check_duplicate` |
| Write a diary entry | `mempalace_diary_write` |
| Read recent diary entries | `mempalace_diary_read` |

---

## Synthesis node creation — required fields

`mempalace_create_synthesis_node` will be rejected unless ALL of these are present:

| Field | Type | Notes |
|---|---|---|
| `wing` | string | Wing to file the node in |
| `room` | string | Room to file the node in |
| `content` | string | Verbatim synthesis text — the full content of the node |
| `source_drawer_ids` | array | **≥2** distinct drawer IDs this node synthesizes from |
| `desc` | string | One-line description stored in metadata; makes the node discoverable |

Optional but useful: `height` (override if you know it's higher than computed), `added_by`,
and `labels` (generic tags; labels may be restricted by an owner allowlist).

Do NOT call this tool without `source_drawer_ids` and `desc`. It will error. If you don't
have at least two source IDs, you are not creating a synthesis node — use `add_drawer` instead.

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

## Scoped retrieval + labels

Use scoped lineage query for mem-core rendering and policy ranking:

- `mempalace_find_scoped_synthesis_nodes`
	- required: `scope_room`
	- optional scope filters: `scope_wing`, `wing`, `room`
	- label filters: `match_labels` + `match_mode` (`any`/`all`) + `labeled_only`
	- traversal/paging: `include_merged`, `max_depth`, `limit`, `offset`
	- returns deterministic ranking signals (`height`, `retrieval_count`,
		`connection_degree`) so policy can rank without re-deriving.

Manage labels as generic tags (policy meaning stays outside substrate):

- `mempalace_set_synthesis_labels` — replace a node's full label set (`labels: []` clears).
- `mempalace_get_label_policy` — discover owner allowlist and limits before writing labels.

Convention: treat `pinned` as a policy label value when you need "always include"
behavior; do not assume substrate has special pin logic.

---

## KG predicates reserved for the synthesis graph

Do not use these predicates for unrelated facts — they are consumed by traversal logic:

| Predicate | Meaning |
|---|---|
| `synthesized-from` | B synthesized from A (B → A, upward toward sources) |
| `merged-into` | B was merged away; A is canonical |

Use `mempalace_kg_add` to add these edges. Use `mempalace_kg_invalidate` to retire stale
ones (e.g. when a source is superseded).

---

## Memory tiers — where to write

| Tier | Room convention | Tool |
|---|---|---|
| mem-raw | diary (tagged by session) | Never write — append-only source |
| mem-synth | any wing, any room except context-blocks | `add_drawer`, `create_synthesis_node`, `diary_write`, `kg_add` |
| mem-core | directory-scoped runtime-rendered files (`eshepherd/memory` or `memory`) | none directly; runtime render pipeline |

The runtime regenerates mem-core outputs from mem-synth. mem-core is file-only and loaded by
directory scope; agents do not write mem-core directly, and it is not mirrored into MemPalace drawers.

---

## Search strategy

Start broad, then narrow:

```
mempalace_search query="<topic>" limit=10
```

If you find a relevant node, expand with `mempalace_get_ancestors` (what sources it drew
from) or `mempalace_get_descendants` (what was synthesized from it). This is the
probabilistic-entry / deterministic-expansion pattern from the design doc.

Use `mempalace_check_duplicate` before filing new content — identical content gets a
deterministic ID and is silently skipped, but near-duplicates won't be caught without this
check.
