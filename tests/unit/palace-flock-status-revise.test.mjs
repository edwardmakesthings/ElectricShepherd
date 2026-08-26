import assert from "node:assert/strict";
import test from "node:test";

import { isReSynthesisCandidate, countOutcomesInWindow, RE_OUTCOME_WINDOW_DAYS } from "../../tools/palace_flock_status.ts";

/**
 * Unit coverage for Phase 7 (unified memory): the /memory-status re-synthesis
 * candidate rule. A closet accumulating `revise` outcomes is a re-synthesis
 * candidate — approved threshold: revise_count >= 2 AND revise_count > accept_count
 * over a bounded recent window (RE_OUTCOME_WINDOW_DAYS). Proves:
 *   1. the exact boundary behavior of the candidate predicate;
 *   2. windowing by valid_from — old edges fall out, untimestamped edges count in;
 *   3. unknown outcome values are ignored (closed axis);
 *   4. invalidated (current: false) edges do not count.
 */

function fact(object, { current = true, valid_from } = {}) {
  const f = { subject: "drawer_x_synth_1", predicate: "es-outcome", object, current };
  if (valid_from) f.valid_from = valid_from;
  return f;
}

test("candidate rule: revise >= 2 AND revise > accept over the window", () => {
  // Below threshold on count.
  assert.equal(isReSynthesisCandidate({ accept: 0, revise: 1, failed: 0, unused: 0 }), false);
  // Meets count but revise is not strictly greater than accept (2 vs 2).
  assert.equal(isReSynthesisCandidate({ accept: 2, revise: 2, failed: 0, unused: 0 }), false);
  // The spec's own example: 6 accepts + 1 revise is NOT a candidate.
  assert.equal(isReSynthesisCandidate({ accept: 6, revise: 1, failed: 0, unused: 0 }), false);
  // Exactly at threshold.
  assert.equal(isReSynthesisCandidate({ accept: 1, revise: 2, failed: 0, unused: 0 }), true);
  assert.equal(isReSynthesisCandidate({ accept: 0, revise: 2, failed: 3, unused: 9 }), true);
  // Revise dominant.
  assert.equal(isReSynthesisCandidate({ accept: 0, revise: 5, failed: 0, unused: 0 }), true);
});

test("windowing: edges older than the window fall out; untimestamped edges count in", () => {
  const windowStart = new Date(Date.now() - RE_OUTCOME_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const old = new Date(Date.now() - (RE_OUTCOME_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const facts = {
    facts: [
      fact("revise", { valid_from: old }), // outside window -> ignored
      fact("revise", { valid_from: recent }), // in window
      fact("revise"), // untimestamped -> counts in (conservative)
      fact("accept", { valid_from: recent }),
    ],
  };

  const counts = countOutcomesInWindow(facts, windowStart);
  assert.deepEqual(counts, { accept: 1, revise: 2, failed: 0, unused: 0 });
  // With the old edge excluded this is a candidate; with it included (3 revise) it
  // would still be — but the counts prove the window did its filtering.
  assert.equal(isReSynthesisCandidate(counts), true);

  // Same facts with only the OLD edge: not a candidate after windowing.
  const oldOnly = { facts: [fact("revise", { valid_from: old }), fact("revise", { valid_from: old })] };
  assert.deepEqual(countOutcomesInWindow(oldOnly, windowStart), { accept: 0, revise: 0, failed: 0, unused: 0 });
});

test("unknown outcome values are ignored (closed axis) and invalidated edges do not count", () => {
  const facts = {
    facts: [
      fact("accept"),
      fact("accept"),
      fact("revise"),
      fact("passed"), // not a valid es-outcome value -> ignored
      fact("revise", { current: false }), // invalidated -> ignored
    ],
  };
  const counts = countOutcomesInWindow(facts, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(counts, { accept: 2, revise: 1, failed: 0, unused: 0 });
  // 2 accepts + 1 revise is NOT a candidate (the spec's distinguishability example).
  assert.equal(isReSynthesisCandidate(counts), false);
});
