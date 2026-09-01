# Testing the memory system — what YOU do at the keyboard

You have built 11 phases without running them. The failure mode this project has already
shipped twice is "writes perfectly, nothing reads it" — mem-core rendered for weeks into a
void, and source capture that never fired. Both looked healthy from every angle except the
one that mattered.

So this plan tests **read paths**, in dependency order, failing fast.

---

# STEP 1 — the ten-minute smoke test

Do this before anything else. It tests the whole chain at once.

1. Pick a fact you KNOW is in memory — something decided in a session that has since been
   consolidated. A root cause, a rejected approach, a convention.
2. Open a **brand new session** in the project. Not a continuation.
3. Ask about it without hinting: *"What do we know about X?"* — no "check memory", no
   "search the palace." If the system works, mem-core is already in context and the model
   answers. If it needs prompting to go look, that is a different (weaker) result.

**Three possible outcomes, and each means something specific:**

| Result | Meaning | Go to |
|---|---|---|
| Answers correctly, unprompted | Whole chain works | Step 3 |
| Answers only when told to search memory | Retrieval works, mem-core injection does not | Step 2, check 4 |
| Does not know at all | Chain is broken somewhere | Step 2, from check 1 |

Do not skip to per-phase testing if this fails. A broken foundation makes every phase test
below meaningless — they will all "pass" against an empty system.

---

# STEP 2 — the bisect ladder

Run in order. STOP at the first failure and fix it; everything below depends on it.

### Check 1 — is anything being captured?

```
/memory-status
```

Look at the raw/unconsolidated drawer count. Then do some work, and run it again.

- **Count is zero or unchanged after real work** → capture is not firing. This is the
  Gap #4 failure. Check `scripts/capture-source-transcripts.sh` exists and that
  `ESHEPHERD_SOURCE_CAPTURE_CMD` resolves. Nothing downstream can work.
- **Count grows by a LOT per session** (dozens) → capture mode is `append` again; each
  turn is writing a full snapshot. Set `ESHEPHERD_SOURCE_CAPTURE_MODE=hybrid`.

### Check 2 — does consolidation produce closets?

```
/consolidate          (dry run first)
/consolidate apply
/memory-status
```

- **Worklist count is zero but raw drawers exist** → the `consolidated-into` worklist query
  is wrong, or everything is already marked consumed.
- **Closets created = 0** → the `consolidationBatches` push, or synthesis is failing
  silently. Check the run's stdout JSON for created node IDs, not just "success."

### Check 3 — does anything get PROMOTED?

```
/memory-status
```

Compare provisional count against total closet count.

- **Provisional ≈ total** → nothing is being promoted, and since retrieval and mem-core
  render both exclude provisional by default, **your entire memory is invisible.** This is
  the most likely silent failure right now. Cause is usually the ≥2-direct-sources rule
  meeting 1:1 batching. Check what `directSourceCount` actually returns for one closet.

### Check 4 — does mem-core render, and does it LOAD?

Two separate things. Both must be true.

```
/memory-refresh
```

- **Renders?** Confirm files exist under `.electric-shepherd/memory/`, and check the
  timestamp is recent.
- **Loads?** This is the one that silently failed before. Check `opencode.jsonc` has an
  `instructions` entry pointing at those files, OR that a mem-core injection toggle is on.
  Then verify from inside a session: start fresh and ask *"what is in your mem-core?"* If
  the model cannot see it, it is rendered and unloaded — the original bug.

### Check 5 — is retrieval returning anything?

Ask a fresh session something answerable only from a consolidated closet. If Check 4 passed
but this fails, the problem is in retrieval scoping (wing/room mismatch) rather than the
pipeline.

---

# STEP 3 — per-phase checks

Only meaningful once Step 2 is clean. Each is a CONSUMPTION test: does the phase change
what comes back?

| Phase | Do this | Working looks like | Broken looks like |
|---|---|---|---|
| **1** source-type | `kg_query` a known closet and a known doc for `es-source-type` | both stamped, different values | unstamped, or everything one value |
| **2** authority | Ask a FACTUAL question where a doc and a provisional synthesis both match | doc ranks above the synthesis | synthesis wins → the floor is not enforced |
| **3** docs | `/ingest-docs`, then ask something answerable ONLY from a doc | answered, cites doc content | not found → ingestion wrote to the wrong wing/room |
| **4** concerns | Ask about a topic with a synthesis linked to a doc | BOTH returned together | only the synthesis → `concerns` written but not read (most likely gap) |
| **5** skills | Ask a "how do I do X here" question | skill returned | nothing → skills filed but procedural retrieval not wired |
| **6** audit | This IS the test — run it, read the findings | each phase names a reader | any phase with no reader = that phase is inert |
| **7** outcome | Complete one full review cycle, then `kg_query` the closets used | `es-outcome` present | absent → outcomes not attributed, phases 14/16 will have no data |
| **8** prospective | `/remind` against a path glob. Render mem-core INSIDE and OUTSIDE that path | appears in one, absent in the other | appears in both → trigger matching is not filtering |
| **9** dead ends | Ask about a topic you know was ruled out | returned AND clearly marked as ruled out | returned unlabelled → **worse than missing**, reads as advice |
| **10** proc scope | Promote a skill, query from a DIFFERENT project | skill returned cross-wing | not returned → cross-wing path not enabled |
| **11** temporal | Edit an ingested doc, re-mine, check a synthesis that `concerns` it | flagged stale, deprioritised, NOT deleted | silently unchanged, or deleted |

**Phase 9 deserves extra attention.** An unlabelled dead end is the only failure here that
is actively harmful rather than merely useless — it reads as a recommendation to repeat
something you already know fails.

---

# STEP 4 — phases 12–16 test differently

These are not point-in-time checks. Three of them need **accumulated data**, so "testing"
means confirming collection started and the counter moves.

| Phase | Testable immediately? | What to actually do |
|---|---|---|
| **12** domain | Yes | Promote one `writing` and one `general` skill. Query from a code project: `general` returns, `writing` does not. |
| **13** worked-example | Yes | Run one delegation with injection off, one on. Compare the diff, verdict, or revise count. **Report honestly if there is no visible difference** — this is the phase most likely to look good and do nothing. |
| **14** routing | **No — needs volume** | Verify the tuple is being WRITTEN after each unit. Then leave it. Check the per-shape counts weekly. Do not enable the consumer until ≥5 samples per shape. |
| **15** failure modes | Partly | Verify turn-guard events are being attributed per model. The routing effect needs the same volume as 14. |
| **16** calibration | **No — needs the most volume** | Verify pairs are being written. Do NOT look at a curve until ≥20 pairs per cell. An undersampled curve looks authoritative and is wrong. |

**Start the writers for 14/15/16 as early as you can even with consumers disabled.** That
data is cheap to collect and impossible to backfill — every unit completed before you start
recording is a sample gone forever.

---

# The habit worth keeping

After each future phase, before moving on: **name the reader out loud, then watch it read.**
Not "the field is set" — an actual query whose result changes because the phase exists.

Every silent failure in this project passed a write-side check.
