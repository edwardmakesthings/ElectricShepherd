---
description: Create, update, or close a prospective reminder (dry-run-first; no expiry, no reminder)
agent: dreamer
subtask: false
---
Manage prospective reminders — "remember to do X when Y". A reminder fires into the session's mem-core under a `[pending]` block when its trigger matches the current scope (a path/glob, a topic keyword, or a wing/room). It is pushed by circumstance, not pulled by query.

Arguments: $ARGUMENTS — one of:
- `create <condition> <what> --expires <ISO date>` — file a new reminder. Example: `/remind create web/src/features/controlPanel/** watch PR #25165 for Laguna support --expires 2026-09-30`
- `update <drawer_id> <new what and/or --expires ISO>` — change the text or expiry of one existing reminder.
- `close <drawer_id> [satisfied|expired]` — retire a reminder (default satisfied).
- `list` — see `/reminders`.

Execution:

1. Call `remind` with the parsed args and `dry_run: true` (the default). For create, pass `wing` = this project's wing, `condition`, `what`, and `expires_at` (ISO).
2. The tool validates and returns a preview of the exact drawer + KG edges that would be written (`triggers-on`, `es-reminder-status: active`, `es-reminder-expires-at`).
3. **Hard rule — no expiry, no reminder:** if `expires_at` is missing or not a valid date, the tool rejects the capture. Do not work around it; ask the operator for an expiry (or a satisfaction plan that implies one) and retry.
4. Show the operator the preview. Only after their explicit confirmation, call again with `dry_run: false`.

Condition kinds (the tool classifies from the value):
- path/glob — contains `/`, `*`, `?`, or `[` (e.g. `web/src/features/controlPanel/**`)
- wing/room scope — exactly two segments, no glob chars (e.g. `opencode/synthesis`)
- topic keyword — anything else (e.g. `prompt caching`)

Useful args:

- `wing <wing>` (defaults to the project wing)
- `expires_at <ISO>` (required for create; optional on update)
- `drawer_id <id>` (update/close target — from `/reminders`; there is no broad write mode)
- `status satisfied|expired` (close target, default satisfied; also a list filter)
- `dry_run false` (apply; default true)

This tool writes only to the `reminders` room of the given wing plus KG edges on the reminder drawer. It never touches `es-status`, source drawers, or synthesis lineage. Reminders are NOT open items: an `OPEN_ITEMS` entry stays in `[open-items]`; a reminder is the triggered, expiring form that lands in `[pending]`.
