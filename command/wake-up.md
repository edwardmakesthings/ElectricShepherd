---
description: Wake up — refresh and re-inject mem-core for the current scope
agent: dreamer
subtask: false
---
Refresh my working memory for the current scope.

Scope: $ARGUMENTS (default: the current working directory)

Steps:
1. Re-render the mem-core memory files for this scope from the latest synthesis state.
2. Report which memory files were loaded — from broad scope (project root) down to
   narrow scope (current directory) — and a short summary of what changed since they
   were last rendered.

Note: rendering excludes `es-status: provisional` closets by default (unvalidated
syntheses don't reach mem-core). If you just ran /lucid-dream or /count-sheep and expect
to see brand-new content here, it may still be provisional — run /headcount to check,
or dispatch dream-auditor to validate and promote it first.

Refresh and report only — do not synthesize or merge in this command.
