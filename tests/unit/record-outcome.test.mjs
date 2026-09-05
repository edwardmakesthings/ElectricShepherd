import assert from "node:assert/strict";
import test from "node:test";

import { runOutcomeRecord, OUTCOME_VALUES } from "../../src/tools/record_outcome.ts";

/**
 * Unit coverage for Phase 7 (unified memory): the human-authoritative es-outcome write
 * path (`runOutcomeRecord`) against a fake MCP transport — no network. Proves:
 *   1. dry-run makes NO kg_add and returns a preview of the exact edges;
 *   2. only accept | revise | failed | unused are accepted — anything else throws;
 *   3. an empty node-id set is rejected (write nothing when the consulted set is
 *      undeterminable) — there is no broad/scope-based write mode at all;
 *   4. apply writes one kg_add per explicit node id, with valid_from + source_closet
 *      provenance and cycle_ref as source_run_id;
 *   5. accumulation: two applies for the same node/value produce two kg_add calls —
 *      no dedup skip, no invalidation of prior edges;
 *   6. per-node failures are isolated and counted, never abort the batch.
 */

const NODE_A = "drawer_proj_synth_a";
const NODE_B = "drawer_proj_synth_b";
const FIXED_NOW = () => new Date("2026-08-25T12:00:00.000Z");

function makeFakePalace({ failKgAddFor = new Set() } = {}) {
  const calls = [];
  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "kg_add") {
      if (failKgAddFor.has(String(payload.subject))) throw new Error(`kg_add failed for ${payload.subject}`);
      return {};
    }
    return {};
  };
  return { call, calls };
}

test("dry-run makes zero kg_add calls and returns a preview of the exact edges", async () => {
  const fake = makeFakePalace();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: [NODE_A, NODE_B],
    outcome: "accept",
    cycleRef: "cycle-42",
    dryRun: true,
    now: FIXED_NOW,
  });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.deepEqual(
    fake.calls.filter((c) => c.name === "kg_add"),
    [],
    "dry-run must not write any KG edge"
  );
  assert.equal(report.edges.length, 2);
  for (const edge of report.edges) {
    assert.equal(edge.status, "proposed");
    assert.deepEqual(edge.proposed_edge, {
      subject: edge.node_id,
      predicate: "es-outcome",
      object: "accept",
      valid_from: "2026-08-25T12:00:00.000Z",
    });
  }
  assert.equal(report.cycle_ref, "cycle-42");
  assert.match(report.next_step, /dry_run:false/);
});

test("only accept | revise | failed | unused are accepted; anything else throws", async () => {
  const fake = makeFakePalace();
  for (const value of OUTCOME_VALUES) {
    const report = await runOutcomeRecord({ call: fake.call, nodeIds: [NODE_A], outcome: value, dryRun: true, now: FIXED_NOW });
    assert.equal(report.outcome, value);
  }
  // Case-insensitive normalization.
  const upper = await runOutcomeRecord({ call: fake.call, nodeIds: [NODE_A], outcome: "ACCEPT", dryRun: true, now: FIXED_NOW });
  assert.equal(upper.outcome, "accept");

  for (const bad of ["passed", "ok", "", "revise!", "FAILED-CONFIRMED"]) {
    await assert.rejects(
      () => runOutcomeRecord({ call: fake.call, nodeIds: [NODE_A], outcome: bad, dryRun: true, now: FIXED_NOW }),
      /invalid outcome/,
      `expected rejection for ${JSON.stringify(bad)}`
    );
  }
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 0);
});

test("empty node-id set is rejected — write nothing when the consulted set is undeterminable", async () => {
  const fake = makeFakePalace();
  for (const empty of [[], ["", "  "]]) {
    await assert.rejects(
      () => runOutcomeRecord({ call: fake.call, nodeIds: empty, outcome: "failed", dryRun: false, now: FIXED_NOW }),
      /at least one explicit node id/,
      `expected rejection for ${JSON.stringify(empty)}`
    );
  }
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 0, "no writes may happen on an empty set");
});

test("apply writes one kg_add per explicit node with valid_from + source_closet + cycle provenance", async () => {
  const fake = makeFakePalace();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: [NODE_A, NODE_B, NODE_A], // duplicate id must collapse to one edge
    outcome: "revise",
    cycleRef: "cycle-7",
    dryRun: false,
    now: FIXED_NOW,
  });

  assert.equal(report.dry_run, false);
  assert.equal(report.counts.added, 2);
  const adds = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(adds.length, 2, "duplicate node ids collapse to one edge per id");
  for (const add of adds) {
    assert.equal(add.args.predicate, "es-outcome");
    assert.equal(add.args.object, "revise");
    assert.equal(add.args.valid_from, "2026-08-25T12:00:00.000Z");
    assert.equal(add.args.source_closet, add.args.subject);
    assert.equal(add.args.source_run_id, "cycle-7");
  }
});

test("accumulation: repeated applies produce repeated edges — no dedup skip, no invalidation", async () => {
  const fake = makeFakePalace();
  for (let i = 0; i < 2; i += 1) {
    await runOutcomeRecord({ call: fake.call, nodeIds: [NODE_A], outcome: "accept", dryRun: false, now: FIXED_NOW });
  }
  const adds = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(adds.length, 2, "two cycles with the same judgment must accumulate two edges");
  // And a different value for the same node also accumulates (6 accepts + 1 revise stays distinguishable).
  await runOutcomeRecord({ call: fake.call, nodeIds: [NODE_A], outcome: "revise", dryRun: false, now: FIXED_NOW });
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 3);
  // No invalidation path is ever used.
  assert.equal(fake.calls.filter((c) => c.name === "kg_invalidate").length, 0);
});

test("per-node add failures are isolated and counted, never abort the batch", async () => {
  const fake = makeFakePalace({ failKgAddFor: new Set([NODE_A]) });
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: [NODE_A, NODE_B],
    outcome: "failed",
    dryRun: false,
    now: FIXED_NOW,
  });

  assert.equal(report.counts.added, 1);
  assert.equal(report.counts.add_failed, 1);
  const byId = Object.fromEntries(report.edges.map((e) => [e.node_id, e]));
  assert.equal(byId[NODE_A].status, "add-failed");
  assert.match(byId[NODE_A].error, /kg_add failed/);
  assert.equal(byId[NODE_B].status, "added", "one failure must not abort the rest");
});
