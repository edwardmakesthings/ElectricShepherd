---
description: Mine a docs directory into the project wing's reference room and stamp es-source-type: doc (bounded, dry-run default)
agent: dreamer
subtask: false
---
Ingest a docs directory into the palace.

Arguments: $ARGUMENTS = `<path>` — an existing directory of docs to mine (e.g. `docs/`, or any folder of markdown/references).

Execution:

1. Call `ingest_docs` with `path` and `dry_run: true` (the default).
2. The tool resolves the project wing, picks the destination room via `get_taxonomy` (reuses an existing reference-like room before minting `reference`), and returns a bounded preview of the destination room's current drawer count.
3. Show the user the dry-run summary: resolved wing/room, target path, how much of the room the run can see (page cap).
4. Only after approval, call again with `dry_run: false`.

What apply does:

- Mines `<path>` via substrate `mempalace_mine` (projects mode, wing pinned). The miner stamps absolute `source_file`, so deleted docs are pruned later by `mempalace_sync` — this command never deletes.
- Re-mine is content-stable: unchanged files are skipped by the substrate mtime gate; changed files are purged+reinserted under the same drawer IDs.
- Staleness pass: a bounded pre/post ID snapshot around the mine gives the changed set by construction. Every open outgoing KG fact on a changed drawer is invalidated (the miner purges drawers but never touches the KG store), then `es-source-type: doc` is re-stamped. Unchanged drawers are never touched.
- Partial failures are counted and reported; re-running converges (every step is idempotent). There is no cross-call transaction — a partial state heals on the next run.

Useful args:

- `wing <wing>` (defaults to the project wing)
- `room <room>` (explicit destination room; default reuse-or-mint `reference`)
- `page_size 50` (default 50, max 100)
- `max_pages 4` (default 4, max 40)
- `concurrency 8` (default 8, max 16)
- `max_changed 500` (cap on drawers to invalidate/re-stamp per run; default 500)
- `dry_run false` (apply; default true)

This tool does not touch the `es-status` axis — it stays orthogonal to `es-source-type`.
