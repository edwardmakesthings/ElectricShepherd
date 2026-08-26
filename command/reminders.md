---
description: List prospective reminders with filters (status, condition) — read-only
agent: dreamer
subtask: true
---
List the project's prospective reminders.

Scope: $ARGUMENTS — optional filters, e.g. `status active`, `condition web/src`, or a free-text note about what to look for. No arguments = all reminders in the project wing's `reminders` room (bounded, default 20).

Execution:

1. Call `remind` with `action: "list"`, `wing` = this project's wing, and any parsed filters (`status`, `condition_contains`, `limit`).
2. Report each reminder as one line: text — status — trigger(s) — expiry (and satisfied-at when closed). Group active first, then satisfied/expired.
3. Flag reminders whose `expires_at` is already past but still `active` — those are silently dropped from the mem-core `[pending]` render; suggest closing them (`/remind close <drawer_id> expired`).

Read-only: do not call `add_drawer`, `update_drawer`, or `kg_add`. To create, update, or close a reminder use `/remind`.

End with the next action, named: nothing further if all active reminders are clearly scoped and unexpired; `/remind close <id> expired` for any stale ones you flagged.
