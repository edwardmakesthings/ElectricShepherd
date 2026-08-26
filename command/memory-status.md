---
description: Memory status — quick counts, plus an optional bounded preview of what's pending
agent: dreamer
subtask: true
---
Give me a status report on the flock.

Scope: $ARGUMENTS (default: the current project's memory if no scope is given). Include the word `detail` anywhere in the arguments for the deeper preview below (e.g. "electric_shepherd detail").

## Quick counts (always — this is the default, keep it fast)

- Number of unconsolidated source drawers in scope.
- Number of existing consolidated summary nodes in scope.
- Number of those summary nodes still `es-status: provisional` (synthesized but never validated/promoted — hidden from default retrieval until a dream-auditor pass promotes them). This is separate backlog from the two counts above: it needs a validation pass, not a synthesis pass.
- Approximate backlog (source memories not yet represented in any synthesized-from summary node).
- Whether that backlog is above the auto-consolidation volume threshold (ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD) — i.e. whether a `/consolidate` is due.
- Number of **re-synthesis candidates**: summary closets accumulating `es-outcome: revise` outcomes (rule: >= 2 revise AND more revise than accept over the recent window). This is a re-synthesis backlog, separate from the counts above — those closets were consulted and revised repeatedly, so their synthesis should be redone, not just validated.

Fast path for quick counts: call `palace_flock_status` first. It counts at parent-drawer granularity (not chunk rows) and returns the exact fields this command needs.

Fallback only if unavailable: use `palace_report` + aggregate graph queries, not by listing every drawer in scope. On a large backlog, do not enumerate it to get an exact number — report a sampled estimate and say the sample size, same disclosure `/palace-diff` uses.

## Detail (only when the caller asked for it)

1. List a SAMPLE of unconsolidated source drawers (up to 25) and group them by topic/source. Do not attempt to enumerate the whole backlog — say "sampled N of approximately M" if M is large.
2. From that sample, describe the derived drawers a consolidation pass would likely create or update.
3. Flag any low-confidence or single-source items in the sample that would be skipped.
4. List existing closets with `es-status: provisional` in scope — synthesized but never validated/promoted. This is a different backlog than item 1: nothing new to synthesize, just nothing yet run through dream-auditor.
5. List the re-synthesis candidates (bounded sample from the tool's `re_synthesis.candidates`) — closets with repeated `es-outcome: revise` history that should be re-synthesized. Note their accept/revise counts so the operator can weigh them.

Read-only: do not call `add_drawer`, `kg_add`, `apply_merge`, or otherwise write/modify any memory.

End with the next action, named: `/consolidate` if there's a normal backlog to clear, `/consolidate-deep` if it's been a while (validation/merge/relocation are also due), name the re-synthesis candidates when they exist (a targeted re-synthesis of those closets is the follow-up), or nothing further if counts are all at zero.
