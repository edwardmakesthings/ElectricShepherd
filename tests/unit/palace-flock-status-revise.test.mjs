import assert from "node:assert/strict";
import test from "node:test";

import {
  isReSynthesisCandidate,
  countOutcomesInWindow,
  RE_OUTCOME_WINDOW_DAYS,
  isStaleSummaryNode,
  currentStalenessValueFromFacts,
  stalenessReportBlock,
} from "../../src/tools/palace_flock_status.ts";

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

/**
 * Phase 11 (temporal validity): the /memory-status staleness backlog category.
 * A synthesis whose basis doc changed after it was written carries an open
 * `es-staleness` flag; /memory-status reports flagged consolidated summary nodes as
 * their own backlog category, alongside provisional and re-synthesis candidates.
 */

function staleFact(object, { current = true, predicate = "es-staleness", subject = "drawer_x_synth_1" } = {}) {
  return { subject, predicate, object, current };
}

test("staleness count: open es-staleness fact counts; invalidated, foreign-predicate, and unflagged do not", () => {
  const flagged = { facts: [staleFact("source-changed")] };
  assert.equal(isStaleSummaryNode(flagged), true, "open es-staleness fact must count");

  const retired = { facts: [staleFact("source-changed", { current: false })] };
  assert.equal(isStaleSummaryNode(retired), false, "invalidated (current:false) flag must NOT count");

  // Only a RETIRED marker exists — the backlog-drop case: clearing the flag drops
  // the node out of the category.
  const retiredOnly = { facts: [staleFact("source-changed", { current: false })] };
  assert.equal(currentStalenessValueFromFacts(retiredOnly), null, "retired-only marker -> no open value");

  const foreign = {
    facts: [
      staleFact("provisional", { predicate: "es-status" }),
      staleFact("revise", { predicate: "es-outcome" }),
    ],
  };
  assert.equal(isStaleSummaryNode(foreign), false, "other axis facts must not count as staleness");

  assert.equal(isStaleSummaryNode({ facts: [] }), false, "no facts -> unflagged -> 0");
  assert.equal(currentStalenessValueFromFacts({ facts: [] }), null);
});

test("staleness value read is single-marker and value-agnostic (first open value wins)", () => {
  // The axis is single-marker by writer discipline, but the read side counts ANY open
  // es-staleness value (mirrors adapter/memgraph.ts getStaleness). A value-drift bug
  // that leaves two open markers still contributes exactly ONE flagged node.
  const doubled = {
    facts: [staleFact("source-changed"), staleFact("basis-drifted")],
  };
  assert.equal(isStaleSummaryNode(doubled), true, "one node with two open markers is still one flagged node");
  assert.equal(currentStalenessValueFromFacts(doubled), "source-changed", "first open value wins");

  // Subject-scoped: a fact for ANOTHER node in the same payload does not count.
  const otherSubject = { facts: [staleFact("source-changed", { subject: "drawer_x_synth_2" })] };
  assert.equal(currentStalenessValueFromFacts(otherSubject, "drawer_x_synth_1"), null);

  // Empty object is not a marker.
  const emptyObject = { facts: [staleFact("")] };
  assert.equal(isStaleSummaryNode(emptyObject), false, "empty object is not a flag");
});

test("staleness, provisional, and re-synthesis are independent categories (same node can be in all three)", () => {
  // A provisional synthesis that is ALSO stale must appear in BOTH categories — the spec
  // says staleness is "alongside provisional", not a partition of it.
  const outcomeFacts = {
    facts: [
      { subject: "s", predicate: "es-outcome", object: "revise", current: true },
      { subject: "s", predicate: "es-outcome", object: "revise", current: true },
    ],
  };
  const counts = countOutcomesInWindow(outcomeFacts, "2000-01-01T00:00:00.000Z");
  assert.equal(isReSynthesisCandidate(counts), true, "re-synthesis candidate (2 revise)");
  assert.equal(
    isStaleSummaryNode({ facts: [staleFact("source-changed")] }),
    true,
    "stale"
  );
  // Both predicates true simultaneously is legal; the report must show both counts.
});

test("staleness report block mirrors the re_synthesis block shape and is always present", () => {
  const block = stalenessReportBlock([{ node_id: "drawer_proj_synth_1", value: "source-changed" }], 7);
  assert.equal(block.checked_summary_nodes, 7);
  assert.equal(block.candidates.length, 1);
  assert.deepEqual(block.candidates[0], { node_id: "drawer_proj_synth_1", value: "source-changed" });
  // Honesty field: docs are NOT in this population (impact map R7) — the block must say so.
  assert.match(String(block.note), /docs/i, "the block must disclose that flagged docs are not counted here");

  // Zero stale -> honest zero, category still PRESENT (deliberately different from
  // retrieval's stale_expansion envelope, which is absent when nothing is flagged):
  // an operator reading the backlog must be able to tell "checked, none stale" from
  // "not implemented". Mirror of counts.re_synthesis_candidates (always present, can be 0).
  const zero = stalenessReportBlock([], 5);
  assert.equal(zero.checked_summary_nodes, 5);
  assert.deepEqual(zero.candidates, []);

  // Candidate sample is capped like the re-synthesis block.
  const many = Array.from({ length: 25 }, (_, i) => ({ node_id: `drawer_x_synth_${i}`, value: "source-changed" }));
  assert.equal(stalenessReportBlock(many, 25).candidates.length, 10);
});
