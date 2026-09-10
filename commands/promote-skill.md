---
description: Promote a project skill into the shared skills wing so any project's procedural retrieval can reach it (copy, approval-gated, idempotent)
agent: dreamer
subtask: false
---
Promote a skill into the shared skills wing.

Arguments: $ARGUMENTS = `<drawer_id of the project skill to promote>` — the skill must already carry `es-source-type: skill` (file it with `/file-skill` first if not). Promotion is a DISTINCT operation from relocation: relocation fixes misfiling (the drawer was in the wrong place); promotion generalises something correctly filed (the drawer now belongs in two places). This command does NOT move or delete the source — it copies.

Execution:

1. Call `promote_skill` with `skill_id` and `dry_run: true` (the default).
2. The tool reads the source drawer, verifies it is a real skill (hard `es-source-type: skill` check), runs an idempotency guard (an existing `promoted-from` edge short-circuits; an exact-duplicate content guard prevents a second shared copy), and returns a bounded preview of the destination room.
3. Show the user the dry-run summary: source wing/room, destination wing/room, whether the room was reused or minted, idempotency-guard result.
4. Only after approval, call again with `dry_run: false`.

What apply does:

- Idempotency guard first: if the origin already carries a `promoted-from` edge (in either direction), nothing is written (`already_promoted_to`). If identical content is already filed in the shared wing, nothing is written (`skipped-duplicate`).
- Files the procedure VERBATIM into `<shared-wing>/skills` via `add_drawer`. The source drawer is left untouched — COPY semantics, never a move.
- Stamps the shared copy `es-source-type: skill` (a location, not a kind — no new source type). If the stamp fails, the report says so with a retry next_step.
- Writes exactly one lineage-free edge `{subject: <shared>, predicate: "promoted-from", object: <origin>}`. This is NOT `synthesized-from`: it never counts toward height and never feeds recursive lineage traversal. It exists so the origin stays traceable after promotion.

Useful args:

- `shared_wing <wing>` (defaults to `shared-skills`, or `ESHEPHERD_SHARED_SKILLS_WING`)
- `room <room>` (explicit destination room; default reuse-or-mint `skills`)
- `dry_run false` (apply; default true)

This command does not touch the `es-status` axis — it stays orthogonal to `es-source-type`. A skill is authoritative on arrival, like a doc.

Finding candidates: before promoting, surface skills present in >= 2 project wings via the memory-status candidate scan (`findPromotionCandidates`). Promotion is proposed, never automatic — no threshold crossing silently moves a drawer.
