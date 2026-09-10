---
description: Best-of-N — generate several independent local attempts, verify each, keep the winner
agent: build
subtask: false
---
Solve this by generating SEVERAL independent attempts and keeping the best one, instead of
one attempt plus revise cycles.

Task: $ARGUMENTS

## When this is worth it

Local generation is free; only your time is spent. One cloud escalation costs real money.
So sampling 3 local attempts and picking the best is nearly always cheaper than escalating.

Use it when: a unit is well-specified but the first attempt has failed or seems likely to,
the task has a clear pass/fail test, or you are deciding whether to escalate.

Do NOT use it when: there is no objective check (no tests, no typecheck, no measurable
criterion). Without an external verifier this degrades into self-verification, which
measurably adds almost nothing — the model cannot reliably recognise its own best output.
**A verifiable check is the precondition for this whole mode.** If there isn't one, say so
and fall back to the normal loop.

## Protocol

Default N = 3. Accept `n=<number>` in $ARGUMENTS, cap at 5.

**Isolation: one git branch per attempt.** Never let attempts overwrite each other, and
never use `git stash` for this — stashes are easy to lose track of and hard to inspect.

1. **Confirm the check exists.** Identify the exact command that decides pass/fail
   (`dev-tools_typecheck`, `dev-tools_test`, a specific test file). If you cannot name one,
   STOP and say so.
2. **Record the starting point:** `dev-tools_git` for current branch and clean/dirty state.
   If the tree is dirty, STOP and ask — this mode assumes a clean starting tree.
3. **For each attempt i in 1..N:**
   - `git checkout -b bestof/<slug>-<i>` from the starting commit.
   - Delegate the SAME instruction to `@implement-local`. Do not vary the instruction
     between attempts — you are sampling the model, not testing different prompts.
   - Run the check. Record: pass/fail, what failed, files touched, diff size.
   - Commit on the attempt branch so nothing is lost, then return to the starting branch.
4. **Select.**
   - Discard every attempt that fails the check. If ALL fail, report that plainly — N
     failures against an objective check is strong evidence this needs escalation, and is
     worth more than one failure was.
   - If exactly one passes, it wins.
   - If several pass, delegate to `@review-diff` (different model family, so it is a real
     second opinion rather than self-assessment) with the surviving diffs. Ask which is
     best and why — correctness first, then simplicity, then blast radius.
5. **Apply:** merge or cherry-pick the winner onto the starting branch.
6. **Clean up:** delete the losing branches only after the winner is applied and verified.
   Report the branch names before deleting so nothing disappears silently.

## Report

- The check used, and each attempt's result (pass/fail + one line why)
- Which attempt won and on what grounds
- If all failed: what they failed on, and whether the failures were the SAME (suggests the
  task is misunderstood or underspecified) or DIFFERENT (suggests it is genuinely hard)

That last distinction matters more than the win itself. N attempts failing the same way
means the instruction is wrong, not the model — re-specify rather than escalate.
