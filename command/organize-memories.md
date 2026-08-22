---
description: Organize memories — analyze room structure and propose cleanup actions (read-only)
agent: dreamer
subtask: false
---
Analyze memory organization and propose room/wing cleanup.

Scope: $ARGUMENTS (default: current project wing)

Steps:

1. Resolve target wing from `$ARGUMENTS` or runtime config.
2. Call `palace_organize_memories` with optional room subset when specified.
3. Report in order:
   - tiny rooms (by threshold) and likely merge targets
   - naming issues (non-kebab-case / derivation-style room names)
   - near-duplicate room names
   - any explicit drawer mismatch checks (if drawer IDs were supplied)
4. End with numbered, explicit next actions using dry-run-first move tools.

Read-only analysis only. Never mutate drawers in this command.
