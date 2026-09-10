---
description: Palace tour — guided survey of what is actually stored in MemPalace
agent: palace-guide
subtask: false
---
Give me a tour of the palace.

Scope hint: $ARGUMENTS (optional — a wing, a `wing/room`, or a plain question)

This is interactive. Start looking first, then ask; do not interrogate the user before you have any data on screen.

Steps:

1. Run `palace_report` with no arguments and show the wing-level picture immediately (wings, drawer counts, room counts).
2. If `$ARGUMENTS` already names a wing or `wing/room`, skip straight to that scope.
3. Otherwise ask AT MOST three short questions, and only ones the data cannot answer:
   - Which wing (offer the top wings from step 1, plus this project's default wing)?
   - What do you want to know: contents, freshness, consolidation status, or duplicates?
   - Any date window worth applying (`since` / `before`)?
   Ask them together as a short numbered list. Accept partial answers and proceed.
4. Drill in with `palace_report` at wing level, then wing+room level for the rooms that matter to the question.
5. If the user wants the substance of one drawer, call `export_drawer` and dispatch the `drawer-digest` subagent against the returned `file_path`. Never paste raw drawer content into this conversation.

Report:

- Direct answer first.
- Scope table: wing / room / drawer count.
- Notable: date range, dominant sources, unconsolidated count (state the sample size), empty rooms, near-duplicate wing names.
- Next actions, named: `/consolidate-deep` to consolidate, `/relocate-memory` to re-file something that is in the wrong wing/room, `/palace-tour <wing>` to go deeper.

Read-only pass. Never write, move, or delete anything here.
