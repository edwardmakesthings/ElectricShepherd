import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";
import { runOutcomeRecord } from "../../tools/record_outcome.ts";

/**
 * Integration coverage for Phase 7 (unified memory): the full write -> read loop.
 * An explicit human-authoritative outcome write (`runOutcomeRecord`, dry-run then
 * apply) lands `es-outcome` edges in a shared in-memory KG, and a subsequent
 * retrieval (`expandScopedRetrieval`) reads them back through getOutcomeCounts —
 * showing the ranking differ between "outcomes stripped" and "outcomes present",
 * which node moved, and why (the spec's PROVE shape).
 *
 * The transport is an in-memory KG, not a live MemPalace: it exercises the exact
 * ElectricShepherd-owned code on both sides (write core + retrieval adapter) with
 * real edge accumulation semantics, without requiring ESHEPHERD_TEST_INTEGRATION.
 */

const SYNTH_A = "drawer_proj_synth_a";
const SYNTH_B = "drawer_proj_synth_b";
const FIXED_NOW = () => new Date("2026-08-25T12:00:00.000Z");

function makeInMemoryKg() {
  const edges = []; // { subject, predicate, object, valid_from }
  const call = async (name, payload) => {
    if (name === "kg_add") {
      edges.push({ ...payload });
      return {};
    }
    if (name === "kg_query") {
      const entity = String(payload.entity || "");
      const predicate = String(payload.predicate || "");
      const facts = edges
        .filter((e) => e.subject === entity && e.predicate === predicate && e.current !== false)
        .map((e) => ({ subject: e.subject, predicate: e.predicate, object: e.object, current: true, valid_from: e.valid_from }));
      return { facts };
    }
    return {};
  };
  const client = {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async () => ({}),
    getLineageSources: async () => ({}),
    getLineageDerivatives: async () => ({}),
    listScopedDerivedDrawers: async () => ({
      nodes: [
        { node_id: SYNTH_A, labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
        { node_id: SYNTH_B, labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
      ],
    }),
    getClosetStatus: async () => "unknown",
    getClosetSourceType: async (id) => (id === SYNTH_A || id === SYNTH_B ? "synthesis" : null),
    getOutcomeCounts: async (ids) => {
      const map = new Map();
      for (const id of ids) {
        const counts = { accept: 0, revise: 0, failed: 0, unused: 0, total: 0 };
        for (const e of edges) {
          if (e.subject !== id || e.predicate !== "es-outcome") continue;
          if (e.object === "accept") counts.accept += 1;
          else if (e.object === "revise") counts.revise += 1;
          else if (e.object === "failed") counts.failed += 1;
          else if (e.object === "unused") counts.unused += 1;
        }
        counts.total = counts.accept + counts.revise + counts.failed + counts.unused;
        map.set(id, counts);
      }
      return map;
    },
  };
  return { call, client, edges };
}

const OPTIONS = { query: "how does the gateway work", scope_room: "unit-room", top_n: 10 };

test("explicit outcome write changes subsequent retrieval ranking (write -> read loop)", async () => {
  const kg = makeInMemoryKg();

  // 1. Retrieve BEFORE any outcomes exist — both same-shape syntheses tie at base 5.
  const before = await expandScopedRetrieval(kg.client, OPTIONS);
  const beforeIds = before.ranked_nodes.map((n) => n.node_id);
  assert.equal(before.ranked_nodes[0].score, 5);
  assert.equal(before.ranked_nodes[1].score, 5);

  // 2. Operator closes the cycle for a unit of work whose selected_nodes were both
  //    syntheses: dry-run first (no writes), then explicit apply.
  const preview = await runOutcomeRecord({ call: kg.call, nodeIds: [SYNTH_A, SYNTH_B], outcome: "accept", cycleRef: "cycle-1", dryRun: true, now: FIXED_NOW });
  assert.equal(preview.dry_run, true);
  assert.equal(kg.edges.length, 0, "dry-run must not write");

  const applied = await runOutcomeRecord({ call: kg.call, nodeIds: [SYNTH_A, SYNTH_B], outcome: "accept", cycleRef: "cycle-1", dryRun: false, now: FIXED_NOW });
  assert.equal(applied.counts.added, 2);
  assert.equal(kg.edges.length, 2, "apply must write one edge per selected node");

  // A second cycle revises B only — accumulation keeps both edges for A.
  await runOutcomeRecord({ call: kg.call, nodeIds: [SYNTH_B], outcome: "revise", cycleRef: "cycle-2", dryRun: false, now: FIXED_NOW });
  assert.equal(kg.edges.length, 3);

  // 3. Retrieve AGAIN — the ranking must differ, and we can name which node moved why.
  const after = await expandScopedRetrieval(kg.client, OPTIONS);
  const afterById = Object.fromEntries(after.ranked_nodes.map((n) => [n.node_id, n]));

  //   synth-a: 1 accept -> net +1 -> +0.5 => 5.5
  //   synth-b: 1 accept + 1 revise -> net 0 -> +0  => 5.0 (accumulation read, not collapsed)
  assert.ok(Math.abs(afterById[SYNTH_A].score - 5.5) < 1e-9, `synth-a score off: ${afterById[SYNTH_A].score}`);
  assert.ok(Math.abs(afterById[SYNTH_B].score - 5) < 1e-9, `synth-b score off: ${afterById[SYNTH_B].score}`);

  const moved = after.ranked_nodes[0].node_id;
  assert.equal(moved, SYNTH_A, "the node that moved to first is the one with net-positive history");
  assert.notDeepEqual(
    after.ranked_nodes.map((n) => [n.node_id, n.score]),
    beforeIds.map((id) => [id, 5]),
    "ranking must differ from the no-outcome retrieval"
  );

  // Envelope honesty: the outcome term was applied this run.
  assert.equal(after.filters.outcome_expansion.applied, true);
  assert.equal(after.filters.outcome_expansion.nodes_with_history, 2);

  console.log(
    `[worked-example] write->read loop: before=${JSON.stringify(beforeIds)} (scores 5/5), ` +
      `after=${JSON.stringify(after.ranked_nodes.map((n) => [n.node_id, n.score]))} — ` +
      `${SYNTH_A} moved to first (1 accept, +0.5); ${SYNTH_B} unchanged (1 accept + 1 revise net 0)`
  );
});
