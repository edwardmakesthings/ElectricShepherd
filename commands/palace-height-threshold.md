---
description: Palace height threshold — surface high-height synthesis nodes for review
agent: palace-guide
subtask: false
---
Show drawers whose lineage height is above a threshold.

Scope hint: $ARGUMENTS (examples: `armet 4`, `armet/frontend 3`, `drawer_id=<id> min=2`)

Steps:

1. Parse `$ARGUMENTS` into:
   - minimum height (required; default to 3 if omitted)
   - optional `wing`, optional `room`, or explicit `drawer_id`/`drawer_ids`
2. Call `palace_height_threshold` with the parsed scope.
3. Report:
   - threshold used and evaluated count
   - match count
   - matches table sorted by height (drawer_id, wing/room, height, retrieval_count)
4. Flag outliers (very high height, stale retrieval count) as candidates for merge/drift review.

Read-only. Do not move, merge, or delete in this command.
