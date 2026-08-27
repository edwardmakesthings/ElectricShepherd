import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval, staleScoreTerm } from "../../adapter/retrieval-expansion.ts";

/**
 * Unit coverage for Phase 11 (unified memory): the es-staleness CONSUME path.
 * Retrieval reads `es-staleness` flags for candidate nodes via the memgraph client's
 * batch reader (`getStalenessFlags`) and deprioritises flagged nodes WITHOUT deleting
 * them — a stale node is penalised in rank, never filtered out.
 *
 * Drives `expandScopedRetrieval` with a stub MemgraphClient whose getStalenessFlags
 * returns fixed per-node values, so scores are fully deterministic. Proves:
 *   1. a flagged node scores lower than its identical unflagged twin (ordering flips);
 *   2. unflagged nodes are exactly neutral (identical scores with/without the reader);
 *   3. staleness is weighted BELOW authority: a stale doc still outranks an unflagged
 *      provisional synthesis on a factual query, and prov-synths clamp to the
 *      PENALISED floor (the deliberate R4 design made explicit);
 *   4. outcome + staleness terms compose additively (R8);
 *   5. the flag survives into selected_nodes AND ranked_nodes;
 *   6. envelope diagnostics report the staleness contribution (and stay absent when
 *      no node is flagged or the client lacks the reader);
 *   7. clients without getStalenessFlags degrade to pre-Phase-11 scoring with zero
 *      extra calls, and a throwing reader degrades to "unflagged" without crashing.
 */

function makeClient({ statuses = {}, sourceTypes = {}, staleness } = {}) {
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
  if (staleness) {
    client.getStalenessFlags = async (ids) => {
      const map = new Map();
      for (const id of ids) map.set(id, staleness[id] ?? null);
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

// Two same-shape syntheses so the ONLY score difference is the staleness term.
//   base = height 3 + log(1+0) + 0 + lineage 2*1 = 5 (each)
const FIXTURE_NODES = [
  { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
  { node_id: "synth-b", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
];

function ids(result) {
  return result.ranked_nodes.map((n) => n.node_id);
}

test("a flagged node scores lower than its identical unflagged twin (ordering flips)", async () => {
  const client = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    staleness: { "synth-a": "source-changed" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // base score for each = 3*1 + log(1) + 0 + 2*1 = 5.
  //   synth-a: flagged -> -weights.staleness = -0.5 => 4.5
  //   synth-b: unflagged -> exactly 0 from the term => 5.0
  assert.ok(Math.abs(byId["synth-a"].score - 4.5) < 1e-9, `stale twin score off: ${byId["synth-a"].score}`);
  assert.ok(Math.abs(byId["synth-b"].score - 5) < 1e-9, `unflagged twin score off: ${byId["synth-b"].score}`);
  assert.deepEqual(ids(result), ["synth-b", "synth-a"], `staleness ordering violated: ${JSON.stringify(ids(result))}`);

  // Deprioritised but NOT removed: the stale node is still ranked and still selectable.
  assert.ok(result.ranked_nodes.some((n) => n.node_id === "synth-a"), "stale node must remain in ranked_nodes");
  assert.ok(result.selected_nodes.some((n) => n.node_id === "synth-a"), "stale node must remain selectable");

  console.log(
    `[worked-example] staleness term: synth-a=${byId["synth-a"].score.toFixed(6)} (es-staleness: source-changed, -0.5), ` +
      `synth-b=${byId["synth-b"].score.toFixed(6)} (unflagged, 0)`
  );
});

test("unflagged nodes are exactly neutral (identical scores with and without the staleness read)", async () => {
  const clientNoReader = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });
  const clientAllUnflagged = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    staleness: {}, // reader present, but no node carries the flag
  });

  const a = await expandScopedRetrieval(clientNoReader, { ...BASE_OPTIONS });
  const b = await expandScopedRetrieval(clientAllUnflagged, { ...BASE_OPTIONS });
  const aById = Object.fromEntries(a.ranked_nodes.map((n) => [n.node_id, n]));
  const bById = Object.fromEntries(b.ranked_nodes.map((n) => [n.node_id, n]));

  assert.equal(aById["synth-a"].score, bById["synth-a"].score, "unflagged nodes must be exactly neutral");
  assert.equal(aById["synth-b"].score, bById["synth-b"].score, "unflagged nodes must be exactly neutral");
  // No flag anywhere -> no envelope block (byte-identical to pre-Phase-11 output).
  assert.equal(b.filters.stale_expansion, undefined, "no stale_expansion entry when nothing is flagged");
});

test("staleness weighted BELOW authority: a stale doc still outranks an unflagged provisional synthesis on factual intent", async () => {
  const nodes = [
    // High-raw-score provisional synthesis — the spec's worked example shape.
    { node_id: "prov-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
    // Doc carrying the staleness flag (its content moved since synthesis).
    { node_id: "doc-node", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 2, connection_degree: 2, lineage_match_count: 2 },
  ];
  const client = makeClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
    staleness: { "doc-node": "source-changed" },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // doc: base 10.098612 + doc boost 2 - staleness 0.5 = 11.598612.
  // prov-synth raw: 30.945910 + synthesis boost 1 = 31.945910 -> factual floor clamps it
  // to the PENALISED doc score 11.598612 (R4 design (a): the floor is computed from
  // final, penalised doc scores — "stale basis → less trust"). The stale doc must still
  // rank first: a 0.5 penalty cannot flip the doc-over-provisional-synthesis invariant.
  assert.ok(Math.abs(byId["doc-node"].score - 11.598612288668111) < 1e-9, `stale doc score off: ${byId["doc-node"].score}`);
  assert.ok(Math.abs(byId["prov-synth"].score - 11.598612288668111) < 1e-9, `clamp to penalised floor violated: ${byId["prov-synth"].score}`);
  assert.deepEqual(ids(result), ["doc-node", "prov-synth"], `authority invariant violated: ${JSON.stringify(ids(result))}`);
  assert.equal(byId["doc-node"].stale?.value, "source-changed", "stale doc must carry the surfaced flag");

  console.log(
    `[worked-example] authority > staleness: doc-node=${byId["doc-node"].score.toFixed(6)} (stale, -0.5), ` +
      `prov-synth=${byId["prov-synth"].score.toFixed(6)} (clamped to the penalised floor)`
  );
});

test("all-docs-stale: provisional synth clamps to the penalised floor, not the unpenalised one", async () => {
  const nodes = [
    { node_id: "prov-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
    // Two docs, BOTH flagged. The lower-scoring one sets the floor.
    { node_id: "doc-low", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 2 },
    { node_id: "doc-high", labels: [], wing: "w", room: "unit-room", desc: "d", height: 2, retrieval_count: 3, connection_degree: 1, lineage_match_count: 1 },
  ];
  const client = makeClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "doc-low": "doc", "doc-high": "doc", "prov-synth": "synthesis" },
    staleness: { "doc-low": "source-changed", "doc-high": "source-changed" },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // doc-low: base height 1*3 + log(1+0)*1 + connection 0*1 + lineage 2*2 = 7.
  //   + doc boost 2 - staleness 0.5 = 8.5 (the floor).
  // doc-high: base (height 2*3 + log(1+3) + connection 1 + lineage 1*2 = 6 + 1.386294 + 1 + 2 = 10.386294)
  //   + doc boost 2 - staleness 0.5 = 11.886294.
  // prov-synth raw: 31.945910 -> clamped to the PENALISED floor 8.5, not the unpenalised 9.
  assert.ok(Math.abs(byId["doc-low"].score - 8.5) < 1e-9, `penalised floor doc off: ${byId["doc-low"].score}`);
  assert.ok(Math.abs(byId["prov-synth"].score - 8.5) < 1e-9, `clamp must use the penalised floor: ${byId["prov-synth"].score}`);
  assert.equal(ids(result)[0], "doc-high", "the unpenalised-higher stale doc still ranks first among docs");

  console.log(
    `[worked-example] all-docs-stale: floor=${byId["doc-low"].score.toFixed(6)} (penalised), ` +
      `prov-synth clamped to ${byId["prov-synth"].score.toFixed(6)}`
  );
});

test("stale synthesis with positive outcome history: the terms compose additively", async () => {
  const client = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    staleness: { "synth-a": "source-changed" },
  });
  // Give both twins the same positive outcome history so ONLY staleness differs.
  client.getOutcomeCounts = async (ids) => {
    const map = new Map();
    for (const id of ids) map.set(id, { accept: 3, revise: 0, failed: 0, unused: 0, total: 3 });
    return map;
  };

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // base 5 + outcome (net 3 clamped to 2 * 0.5 = +1.0).
  //   synth-a: +1.0 - 0.5 (stale) = 5.5
  //   synth-b: +1.0 = 6.0
  assert.ok(Math.abs(byId["synth-a"].score - 5.5) < 1e-9, `composed stale+outcome score off: ${byId["synth-a"].score}`);
  assert.ok(Math.abs(byId["synth-b"].score - 6) < 1e-9, `composed unflagged+outcome score off: ${byId["synth-b"].score}`);
  assert.deepEqual(ids(result), ["synth-b", "synth-a"], `composition ordering violated: ${JSON.stringify(ids(result))}`);

  console.log(
    `[worked-example] outcome + staleness compose: synth-a=${byId["synth-a"].score.toFixed(6)} (+1.0 - 0.5), ` +
      `synth-b=${byId["synth-b"].score.toFixed(6)} (+1.0)`
  );
});

test("the flag survives into selected_nodes and ranked_nodes", async () => {
  const client = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    staleness: { "synth-a": "source-changed" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const rankedById = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  const selectedById = Object.fromEntries(result.selected_nodes.map((n) => [n.node_id, n]));

  assert.deepEqual(rankedById["synth-a"].stale, { value: "source-changed" }, "ranked node must carry the flag");
  assert.deepEqual(selectedById["synth-a"].stale, { value: "source-changed" }, "selected node must carry the flag");
  assert.equal(rankedById["synth-b"].stale, undefined, "unflagged twin must not carry the field");
  assert.equal(selectedById["synth-b"].stale, undefined, "unflagged twin must not carry the field");
});

test("envelope diagnostics report staleness weighting (and stay absent when nothing is flagged)", async () => {
  const flagged = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    staleness: { "synth-a": "source-changed" },
  });
  const applied = await expandScopedRetrieval(flagged, { ...BASE_OPTIONS });
  assert.equal(applied.filters.stale_expansion.enabled, true);
  assert.equal(applied.filters.stale_expansion.applied, true, "a flagged node must report applied");
  assert.equal(applied.filters.stale_expansion.nodes_flagged, 1);
  assert.equal(applied.flags?.stale_expansion, undefined, "flags object has no stale_expansion (it lives on filters)");
  assert.equal(applied.filters.stale_expansion.weight, 0.5);

  const unflagged = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    staleness: {},
  });
  const notApplied = await expandScopedRetrieval(unflagged, { ...BASE_OPTIONS });
  assert.equal(notApplied.filters.stale_expansion, undefined, "zero-flag pool must report no stale_expansion block");
});

test("client without getStalenessFlags degrades to pre-Phase-11 scoring (no staleness calls)", async () => {
  const client = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });
  assert.equal(typeof client.getStalenessFlags, "undefined");

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  // base 5 for each — no staleness term at all.
  assert.ok(Math.abs(byId["synth-a"].score - 5) < 1e-9, `score changed without capability: ${byId["synth-a"].score}`);
  assert.equal(result.filters.stale_expansion, undefined, "no stale_expansion entry when the client lacks the reader");
});

test("a throwing getStalenessFlags degrades to unflagged (retrieval still works, no crash)", async () => {
  const client = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });
  let calls = 0;
  client.getStalenessFlags = async () => {
    calls += 1;
    throw new Error("kg_query exploded");
  };

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  assert.equal(calls, 1, "the batch reader must be attempted exactly once");
  // Read failure degrades to "unflagged" per node — scores are the pre-Phase-11 base.
  assert.ok(Math.abs(byId["synth-a"].score - 5) < 1e-9, `failure must degrade to neutral: ${byId["synth-a"].score}`);
  assert.equal(byId["synth-a"].stale, undefined, "no flag surfaced on read failure");
  assert.equal(result.filters.stale_expansion, undefined, "no stale_expansion block when the read failed");
});

test("staleScoreTerm is pure and binary (no accumulation)", () => {
  assert.equal(staleScoreTerm(false, 0.5), 0, "unflagged is exactly neutral");
  assert.equal(staleScoreTerm(true, 0.5), -0.5, "flagged deprioritises by exactly the weight");
  assert.equal(staleScoreTerm(true, 2), -2, "any weight scales linearly; no clamp, no accumulation");
  assert.ok(Math.abs(staleScoreTerm(true, 0)) < 1e-9, "zero weight is a no-op");
});
