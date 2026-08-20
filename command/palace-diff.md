---
description: Palace diff — what memory picked up recently, versus the period before it
agent: palace-guide
subtask: false
---
Show me what changed in memory recently.

Scope hint: $ARGUMENTS (optional — a wing, a `wing/room`, or a window like `14d`)

Steps:

1. Parse `$ARGUMENTS` for a wing, an optional room, and an optional window (`7d`, `24h`,
   `2w`, `1m`, or an ISO date). Default to this project's wing and a `7d` window.
2. Run `palace_diff`. It compares the current window against the immediately preceding
   window of the same length, per room.
3. Report, in this order:
   - One line: total drawers this window vs last, and the direction of travel.
   - Per-room table: room / current / previous / delta / status
     (`growing`, `slowing`, `steady`, `newly-active`, `went-quiet`, `quiet`).
   - New sources that appeared this window.
   - How much of the new material is still unconsolidated.
4. Call out anything that deserves attention without being asked:
   - a room that `went-quiet` after being active (capture may have broken),
   - a room that is `newly-active` (something started writing there),
   - new material with no `consolidated-into` edges piling up.
5. End with the next action: `/lucid-dream` if consolidation is behind,
   `/palace-tour <wing>` to inspect a specific room, or a wider window to see more.

Read-only. Never write, move, or delete anything here.

Note: counts are exact (they come from filtered totals), but the consolidation figures are
sampled from the new drawers in each room. State that when you report them.
