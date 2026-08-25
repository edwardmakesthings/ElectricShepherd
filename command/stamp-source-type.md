---
description: Backfill the es-source-type KG axis on existing drawers (bounded, dry-run default)
agent: build
subtask: false
---
Backfill the `es-source-type` axis for existing drawers in a wing.

Arguments: $ARGUMENTS

Execution:

1. Call `palace_stamp_source_type` with the parsed arguments.
2. The tool is dry-run by default — it returns per-room counts of what WOULD be stamped and a `next_step` telling you to re-run with `dry_run:false`.
3. Show the user the dry-run summary (covered vs not covered by the page cap, transcript/synthesis/unknown counts) before applying.
4. Only after approval, call again with `dry_run: false`.

Inference rules (never guessed):

- Transcript-like rooms (`isTranscriptLikeRoom`) → `transcript` (room name is the signal; no per-drawer KG call).
- Drawers with outgoing `synthesized-from` edges → `synthesis`.
- Everything else → left UNSTAMPED ("unknown authority"). A failed edge check also stays unstamped and is counted as `check_failed`.

Bounded by construction: each room is probed for its total, then walked with at most `max_pages` pages of `page_size` drawers. Drawers beyond the cap are reported as `not_covered_by_page_cap` and never fetched — a room can never be paged to exhaustion. Re-running is idempotent: already-correctly-stamped drawers are skipped, a conflicting previous value is invalidated before re-stamping.

Useful args:

- `wing <wing>` (defaults to the project wing)
- `rooms room-a,room-b` (explicit subset; default every room in the wing)
- `exclude_rooms source-transcripts`
- `page_size 50` (default 50, max 100)
- `max_pages 4` (default 4, max 40)
- `max_rooms 25` (default 25, max 200)
- `concurrency 8` (default 8, max 16)
- `dry_run false` (apply; default true)

This tool does not touch the `es-status` axis and does not affect retrieval ranking yet (authority-aware retrieval is a later phase).
