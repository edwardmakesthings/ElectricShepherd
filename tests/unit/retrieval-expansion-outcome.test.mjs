import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval, outcomeScoreTerm, emptyOutcomeCounts } from "../../src/capability/retrieval/retrieval-expansion.ts";

/**
 * Unit coverage for Phase 7 (unified memory): the es-outcome ranking term.
 *
 * Drives `expandScopedRetrieval` with a stub MemgraphClient whose getOutcomeCounts
 * returns fixed per-node counts, so scores are fully deterministic. Proves:
 *   1. net-positive outcomes boost and repeated revise penalises (ordering flips);
 *   2. zero-history nodes are exactly neutral (score identical to no-outcome run);
 *   3. the term is weighted BELOW authority: a doc with no outcome history still
 *      outranks a synthesis with two accepts on a factual query (spec worked example);
 *   4. accumulation is read, not collapsed — more accepts = larger boost until the
 *      ±2 clamp;
 *   5. envelope diagnostics report whether outcome weighting was applied;
 *   6. clients without getOutcomeCounts degrade to pre-Phase-7 scoring (no calls).
 */

function makeClient({ statuses = {}, sourceTypes = {}, outcomes } = {}) {
  const client = {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async () => ({}),
    getLineageSources: async () => ({}),
    getLineageDerivatives: async () => ({}),
    listScopedDerivedDrawers: async () => ({ nodes: FIXTURE_NODES }),
    getClosetStatus: async (id) => statuses[id] ?? "unknown",
    getClosetSourceType: async (id) => sourceTypes[id] ?? null,
  };
  if (outcomes) {
    client.getOutcomeCounts = async (ids) => {
      const map = new Map();
      for (const id of ids) map.set(id, outcomes[id] ?? emptyOutcomeCounts());
      return map;
    };
  }
  return client;
}

const BASE_OPTIONS = {
  query: "how does the gateway work",
  scope_room: "unit-room",
  top_n: 10,
};

// Two same-shape syntheses so the ONLY score difference is the outcome term.
//   base = height 3 + log(1+0) + 0 + lineage 2*1 = 5 (each)
const FIXTURE_NODES = [
  { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
  { node_id: "synth-b", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
];

function ids(result) {
  return result.ranked_nodes.map((n) => n.node_id);
}

test("accept outcomes boost and repeated revise penalises (ordering flips)", async () => {
  const client = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    outcomes: {
      "synth-a": { accept: 3, revise: 0, failed: 0, unused: 0, total: 3 },
      "synth-b": { accept: 0, revise: 2, failed: 1, unused: 0, total: 3 },
    },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // base score for each = 3*1 + log(1) + 0 + 2*1 = 5.
  //   synth-a: net = 3 - 0 = 3 -> clamped to 2 -> +2 * 0.5 = +1.0  => 6.0
  //   synth-b: net = 0 - 3 = -3 -> clamped to -2 -> -2 * 0.5 = -1.0 => 4.0
  assert.ok(Math.abs(byId["synth-a"].score - 6) < 1e-9, `synth-a score off: ${byId["synth-a"].score}`);
  assert.ok(Math.abs(byId["synth-b"].score - 4) < 1e-9, `synth-b score off: ${byId["synth-b"].score}`);
  assert.deepEqual(ids(result), ["synth-a", "synth-b"], `outcome ordering violated: ${JSON.stringify(ids(result))}`);

  console.log(
    `[worked-example] outcome term: synth-a=${byId["synth-a"].score.toFixed(6)} (3 accepts, +1.0), ` +
      `synth-b=${byId["synth-b"].score.toFixed(6)} (2 revise + 1 failed, -1.0)`
  );
});

test("zero-history nodes are exactly neutral (identical scores with and without outcomes)", async () => {
  const clientNoOutcomes = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });
  const clientWithEmptyHistory = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    outcomes: {
      "synth-a": emptyOutcomeCounts(),
      "synth-b": { accept: 1, revise: 1, failed: 0, unused: 2, total: 4 }, // net 1-1=0 -> neutral
    },
  });

  const a = await expandScopedRetrieval(clientNoOutcomes, { ...BASE_OPTIONS });
  const b = await expandScopedRetrieval(clientWithEmptyHistory, { ...BASE_OPTIONS });
  const aById = Object.fromEntries(a.ranked_nodes.map((n) => [n.node_id, n]));
  const bById = Object.fromEntries(b.ranked_nodes.map((n) => [n.node_id, n]));

  assert.equal(aById["synth-a"].score, bById["synth-a"].score, "zero history must be exactly neutral");
  assert.equal(aById["synth-b"].score, bById["synth-b"].score, "net-zero history (1 accept + 1 revise) must be exactly neutral");
});

test("authority dominates: a doc with no outcome history outranks a synthesis with two accepts on factual intent", async () => {
  const nodes = [
    // High-raw-score provisional synthesis WITH two accepts — the spec's worked example.
    { node_id: "prov-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
    // Doc with ZERO outcome history.
    { node_id: "doc-node", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 2, connection_degree: 2, lineage_match_count: 2 },
  ];
  const client = makeClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
    outcomes: {
      "prov-synth": { accept: 2, revise: 0, failed: 0, unused: 0, total: 2 },
      "doc-node": emptyOutcomeCounts(),
    },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // doc: base 10.098612 + doc boost 2 + outcome 0 = 12.098612.
  // prov-synth raw: 30.945910 + synthesis boost 1 + outcome (net 2 clamped * 0.5) 1.0 = 32.945910
  //   -> factual floor clamps it to the doc's score 12.098612. The doc must rank first:
  //   outcome history (even a positive one) can never let a provisional synthesis
  //   outrank a no-history doc on a factual query.
  assert.ok(Math.abs(byId["doc-node"].score - 12.098612288668111) < 1e-9, `doc score off: ${byId["doc-node"].score}`);
  assert.deepEqual(ids(result), ["doc-node", "prov-synth"], `authority invariant violated: ${JSON.stringify(ids(result))}`);

  console.log(
    `[worked-example] authority > outcome: doc-node=${byId["doc-node"].score.toFixed(6)} (no history), ` +
      `prov-synth=${byId["prov-synth"].score.toFixed(6)} (2 accepts, clamped to floor)`
  );
});

test("accumulation is read, not collapsed: more accepts = larger boost until the clamp", async () => {
  const nodes = [
    { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
  ];
  const make = (accepts) => {
    const c = makeClient({ sourceTypes: { "synth-a": "synthesis" }, outcomes: { "synth-a": { accept: accepts, revise: 0, failed: 0, unused: 0, total: accepts } } });
    c.listScopedDerivedDrawers = async () => ({ nodes });
    return c;
  };

  const r1 = await expandScopedRetrieval(make(1), { ...BASE_OPTIONS });
  const r2 = await expandScopedRetrieval(make(2), { ...BASE_OPTIONS });
  const r3 = await expandScopedRetrieval(make(3), { ...BASE_OPTIONS });
  const r6 = await expandScopedRetrieval(make(6), { ...BASE_OPTIONS });

  // base 5; +0.5 per accept until net clamps at 2 (i.e. accepts >= 2 -> +1.0).
  assert.ok(Math.abs(r1.ranked_nodes[0].score - 5.5) < 1e-9, `1 accept: ${r1.ranked_nodes[0].score}`);
  assert.ok(Math.abs(r2.ranked_nodes[0].score - 6) < 1e-9, `2 accepts: ${r2.ranked_nodes[0].score}`);
  assert.ok(Math.abs(r3.ranked_nodes[0].score - 6) < 1e-9, `3 accepts (clamped): ${r3.ranked_nodes[0].score}`);
  assert.ok(Math.abs(r6.ranked_nodes[0].score - 6) < 1e-9, `6 accepts (clamped): ${r6.ranked_nodes[0].score}`);
});

test("envelope diagnostics report whether outcome weighting was applied", async () => {
  const withHistory = makeClient({
    sourceTypes: { "synth-a": "synthesis" },
    outcomes: { "synth-a": { accept: 2, revise: 0, failed: 0, unused: 0, total: 2 } },
  });
  const applied = await expandScopedRetrieval(withHistory, { ...BASE_OPTIONS });
  assert.equal(applied.filters.outcome_expansion.enabled, true);
  assert.equal(applied.filters.outcome_expansion.applied, true, "non-zero net must report applied");
  assert.equal(applied.filters.outcome_expansion.nodes_with_history, 1);
  assert.equal(applied.filters.outcome_expansion.weight, 0.5);

  const neutral = makeClient({
    sourceTypes: { "synth-a": "synthesis" },
    outcomes: { "synth-a": emptyOutcomeCounts() },
  });
  const notApplied = await expandScopedRetrieval(neutral, { ...BASE_OPTIONS });
  assert.equal(notApplied.filters.outcome_expansion.enabled, true);
  assert.equal(notApplied.filters.outcome_expansion.applied, false, "zero history must report applied: false");
  assert.equal(notApplied.filters.outcome_expansion.nodes_with_history, 0);
});

test("client without getOutcomeCounts degrades to pre-Phase-7 scoring (no outcome calls)", async () => {
  const client = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });
  assert.equal(typeof client.getOutcomeCounts, "undefined");

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  // base 5 for each — no outcome term at all.
  assert.ok(Math.abs(byId["synth-a"].score - 5) < 1e-9, `score changed without capability: ${byId["synth-a"].score}`);
  assert.equal(result.filters.outcome_expansion, undefined, "no outcome_expansion entry when the client lacks the reader");
});

test("outcomeScoreTerm is pure and clamps to ±2", () => {
  assert.equal(outcomeScoreTerm(emptyOutcomeCounts(), 0.5), 0);
  assert.equal(outcomeScoreTerm({ accept: 1, revise: 0, failed: 0, unused: 0, total: 1 }, 0.5), 0.5);
  assert.equal(outcomeScoreTerm({ accept: 2, revise: 0, failed: 0, unused: 0, total: 2 }, 0.5), 1);
  assert.equal(outcomeScoreTerm({ accept: 9, revise: 0, failed: 0, unused: 0, total: 9 }, 0.5), 1, "positive clamp at net 2");
  assert.equal(outcomeScoreTerm({ accept: 0, revise: 3, failed: 1, unused: 0, total: 4 }, 0.5), -1, "negative clamp at net -2");
  assert.equal(outcomeScoreTerm({ accept: 1, revise: 1, failed: 0, unused: 5, total: 7 }, 0.5), 0, "unused is neutral; net zero");
});
