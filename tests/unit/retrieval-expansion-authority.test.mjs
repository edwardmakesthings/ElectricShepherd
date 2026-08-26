import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";

/**
 * Unit coverage for Phase 2 (unified memory): authority-aware retrieval.
 *
 * Drives `expandScopedRetrieval` with a stub MemgraphClient returning fixed
 * nodes of known height/status/source-type, so the computed scores are fully
 * deterministic and can be printed as the spec's worked example.
 *
 * Default weights (adapter/retrieval-expansion.ts):
 *   height: 3, retrieval: 1, connection: 1, lineage: 2, labelMatch: 0.75,
 *   seedBoost: 2, neighborhoodBoost: 1, alwaysLabeledBoost: 2, authority: 1.
 */

function makeClient({ statuses = {}, sourceTypes = {} } = {}) {
  return {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async () => ({}),
    getLineageSources: async () => ({}),
    getLineageDerivatives: async () => ({}),
    listScopedDerivedDrawers: async () => ({ nodes: FIXTURE_NODES }),
    getClosetStatus: async (id) => statuses[id] ?? "unknown",
    getClosetSourceType: async (id) => sourceTypes[id] ?? null,
  };
}

const BASE_OPTIONS = {
  query: "how does the gateway work",
  scope_room: "unit-room",
  top_n: 10,
};

// Fixture nodes with hand-computable scores.
//   doc-node:      height 1, retrieval 2, connection 2, lineage 2
//                  base = 3 + log(1+2) + 2 + 4 = 10.098612
//   prov-synth:    height 5, retrieval 6, connection 4, lineage 4, pinned
//                  base = 15 + log(1+6) + 4 + 8 + 2 (always-labeled) = 30.945910
//   active-synth:  height 2, retrieval 1, connection 1, lineage 1
//                  base = 6 + log(1+1) + 1 + 2 = 9.693147
const FIXTURE_NODES = [
  { node_id: "doc-node", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 2, connection_degree: 2, lineage_match_count: 2 },
  { node_id: "prov-synth", labels: ["pinned"], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  { node_id: "active-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 2, retrieval_count: 1, connection_degree: 1, lineage_match_count: 1 },
];

function ids(result) {
  return result.ranked_nodes.map((n) => n.node_id);
}

test("worked example: factual intent floors a provisional synthesis below a doc (computed scores)", async () => {
  const client = makeClient({
    statuses: { "prov-synth": "provisional", "active-synth": "active" },
    // active-synth is deliberately left unstamped here -> "unknown" authority (see below).
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
  });

  // include_provisional keeps the provisional synth in the pool so the FLOOR (not the
  // P2-2 filter) is what puts it below the doc — that is the hard rule under test.
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });

  // Raw scores (before the floor), with factual authority boosts applied:
  //   doc-node:      10.098612 + 2 (doc boost)          = 12.098612
  //   prov-synth:    30.945910 + 1 (synthesis boost)    = 31.945910
  //   active-synth:   9.693147 + 0 (unknown boost)       =  9.693147
  // floorMin = min doc score = 12.098612; prov-synth is clamped from 31.945910 down to 12.098612.
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.equal(
    result.ranked_nodes.length,
    3,
    `expected all three fixture nodes ranked, got: ${JSON.stringify(ids(result))}`
  );
  // The hard rule, shown with computed scores rather than asserted in the abstract:
  // a provisional synthesis that would otherwise score ~2.8x higher lands EXACTLY at
  // the doc's score and sorts behind it on the height tie-break (doc h=1 < synth h=5).
  assert.ok(
    Math.abs(byId["doc-node"].score - 12.098612288668111) < 1e-9,
    `doc score off: ${byId["doc-node"].score}`
  );
  assert.ok(
    Math.abs(byId["prov-synth"].score - 12.098612288668111) < 1e-9,
    `clamped provisional score off: ${byId["prov-synth"].score} (expected floor 12.098612)`
  );
  assert.ok(
    Math.abs(byId["active-synth"].score - 9.693147180559945) < 1e-9,
    `active synthesis score off: ${byId["active-synth"].score}`
  );

  // Ordering: the provisional synth is clamped to EXACTLY the doc's floor score. The two
  // tie on score, and the factual floor tie-break guard (adapter) puts the doc first so a
  // wrong synthesis never presents above the actual API reference. Active synthesis is
  // last by score. A pinned, high-height provisional synth must NOT outrank a doc.
  assert.deepEqual(
    ids(result),
    ["doc-node", "prov-synth", "active-synth"],
    `factual ordering violated: ${JSON.stringify(ids(result))}`
  );

  // The envelope stays honest about the attribute and the intent. (active-synth is
  // deliberately left unstamped in this fixture -> "unknown" authority.)
  assert.equal(byId["doc-node"].source_type, "doc");
  assert.equal(byId["prov-synth"].source_type, "synthesis");
  assert.equal(byId["active-synth"].source_type, "unknown");
  assert.equal(result.filters.intent, "factual");
  assert.equal(result.ranking.weights.authority, 1);

  console.log(
    `[worked-example] factual intent: doc-node=${byId["doc-node"].score.toFixed(6)} ` +
      `(raw 12.098612), prov-synth=${byId["prov-synth"].score.toFixed(6)} ` +
      `(raw 31.945910, clamped to floor 12.098612), active-synth=${byId["active-synth"].score.toFixed(6)}`
  );
});

test("factual intent with no doc present: provisional synthesis may rank first (rule is relative)", async () => {
  const nodes = FIXTURE_NODES.filter((n) => n.node_id !== "doc-node");
  const client = makeClient({
    statuses: { "prov-synth": "provisional", "active-synth": "active" },
    sourceTypes: { "prov-synth": "synthesis", "active-synth": "synthesis" },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });

  // No doc in the candidate set -> nothing to outrank -> no clamping.
  assert.deepEqual(
    ids(result),
    ["prov-synth", "active-synth"],
    `expected provisional first when no doc exists, got: ${JSON.stringify(ids(result))}`
  );
  const prov = result.ranked_nodes.find((n) => n.node_id === "prov-synth");
  assert.ok(
    Math.abs(prov.score - 31.94591014905531) < 1e-9,
    `score should be unclamped raw value, got ${prov.score}`
  );
});

test("default (omitted intent) preserves pre-Phase-2 ordering semantics exactly", async () => {
  const client = makeClient({
    statuses: { "prov-synth": "provisional", "active-synth": "active" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
  });

  // include_provisional keeps the provisional synth in the pool so this exercises the
  // pre-Phase-2 SCORING path directly (default intent must leave scores untouched).
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_provisional: true });

  // Pre-Phase-2 formula with default weights (no authority term):
  //   prov-synth:    30.945910 (height 15 + log(1+6) 1.9459 + conn 4 + lineage 8 + pinned 2)
  //   doc-node:      10.098612
  //   active-synth:   9.693147 (unstamped -> unknown authority, no boost anyway)
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  assert.ok(
    Math.abs(byId["prov-synth"].score - 30.94591014905531) < 1e-9,
    `default prov score off: ${byId["prov-synth"].score}`
  );
  assert.ok(
    Math.abs(byId["doc-node"].score - 10.098612288668111) < 1e-9,
    `default doc score off: ${byId["doc-node"].score}`
  );
  assert.ok(
    Math.abs(byId["active-synth"].score - 9.693147180559945) < 1e-9,
    `default active score off: ${byId["active-synth"].score}`
  );

  // No intent -> no floor, no boosts: the high provisional synth still ranks first,
  // exactly as before Phase 2 (include_provisional keeps it in the pool). Note that
  // under the DEFAULT include_provisional=false the P2-2 filter would drop it entirely
  // — that behavior is unchanged too; this fixture exercises the scoring path directly.
  assert.deepEqual(
    ids(result),
    ["prov-synth", "doc-node", "active-synth"],
    `default ordering changed: ${JSON.stringify(ids(result))}`
  );
  assert.equal(result.filters.intent, undefined);
});

test("include_provisional + factual intent: floor still applies (floor is not a filter)", async () => {
  const client = makeClient({
    statuses: { "prov-synth": "provisional", "active-synth": "active" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis", "active-synth": "synthesis" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });

  // Provisional stays in the pool (not filtered) but is floored to at most the doc's
  // score. The floor clamps it to EXACTLY the doc score; the tie-break guard puts the
  // doc first so the provisional synth never presents above it.
  assert.ok(ids(result).includes("prov-synth"), "provisional must remain in the pool");
  const docIdx = ids(result).indexOf("doc-node");
  const provIdx = ids(result).indexOf("prov-synth");
  assert.ok(docIdx < provIdx, `doc (${docIdx}) must rank above provisional synth (${provIdx}): ${JSON.stringify(ids(result))}`);
});

test("default intent path is byte-identical to the pre-Phase-2 formula (no authority term)", async () => {
  const client = makeClient({
    statuses: { "prov-synth": "provisional", "active-synth": "active" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
  });

  // Omitted intent (no preference): scores must match the hand-computed pre-patch
  // values with zero authority contribution. include_provisional keeps all three
  // fixture nodes in the pool so every score is observable.
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  const expectedDefaultScores = {
    "doc-node": 3 * 1 + Math.log(1 + 2) + 2 * 1 + 2 * 2, // 10.098612
    "prov-synth": 3 * 5 + Math.log(1 + 6) + 4 * 1 + 4 * 2 + 2, // 30.945910 (pinned boost)
    "active-synth": 3 * 2 + Math.log(1 + 1) + 1 * 1 + 1 * 2, // 9.693147 (unknown: no authority term)
  };
  for (const [id, expected] of Object.entries(expectedDefaultScores)) {
    assert.ok(
      Math.abs(byId[id].score - expected) < 1e-9,
      `${id}: expected ${expected}, got ${byId[id].score}`
    );
  }

  // source_type is still exposed on the envelope (attribute always populated),
  // but it contributes nothing to the score when intent is omitted.
  assert.equal(byId["doc-node"].source_type, "doc");
  assert.equal(byId["prov-synth"].source_type, "synthesis");
  assert.equal(byId["active-synth"].source_type, "unknown");
});

test("historical intent boosts synthesis and transcript; procedural boosts skill then synthesis", async () => {
  const nodes = [
    { node_id: "transcript-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
    { node_id: "synth-b", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
    { node_id: "skill-c", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
    { node_id: "doc-d", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
  ];
  const sourceTypes = { "transcript-a": "transcript", "synth-b": "synthesis", "skill-c": "skill", "doc-d": "doc" };
  const client = makeClient({ statuses: {}, sourceTypes });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  // historical: synthesis +2, transcript +1, doc/skill +0.
  const hist = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "historical" });
  assert.deepEqual(
    ids(hist),
    ["synth-b", "transcript-a", "doc-d", "skill-c"],
    `historical ordering off: ${JSON.stringify(ids(hist))}`
  );
  const histById = Object.fromEntries(hist.ranked_nodes.map((n) => [n.node_id, n]));
  assert.equal(histById["synth-b"].score, 3 + 2); // height only + boost
  assert.equal(histById["transcript-a"].score, 3 + 1);
  assert.equal(histById["doc-d"].score, 3);
  assert.equal(histById["skill-c"].score, 3);

  // procedural: skill +2, synthesis +1, doc/transcript +0.
  const proc = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural" });
  assert.deepEqual(
    ids(proc),
    ["skill-c", "synth-b", "doc-d", "transcript-a"],
    `procedural ordering off: ${JSON.stringify(ids(proc))}`
  );
});

test("unstamped (unknown authority) nodes get no special treatment on factual intent", async () => {
  const client = makeClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" }, // active-synth unstamped
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.equal(byId["active-synth"].source_type, "unknown");
  // Unknown node is neither floor nor ceiling: raw score + 0 boost, no clamping.
  assert.ok(
    Math.abs(byId["active-synth"].score - 9.693147180559945) < 1e-9,
    `unknown node should keep its raw score, got ${byId["active-synth"].score}`
  );
  // Doc still outranks the provisional synth via the floor. The floor clamps prov to
  // exactly the doc score; the tie-break guard puts the doc first so a wrong synthesis
  // never presents above the actual API reference.
  assert.ok(
    ids(result).indexOf("doc-node") < ids(result).indexOf("prov-synth"),
    `floor violated: ${JSON.stringify(ids(result))}`
  );
});

test("pinned provisional synthesis cannot outrank an unpinned doc on factual intent", async () => {
  // include_provisional keeps the pinned provisional synth in the pool; without it,
  // the P2-2 filter would drop it before ranking (also correct, but not what this test
  // is checking). The always-labeled boost (+2) makes prov-synth score even higher
  // than in the worked example, so the floor has real work to do.
  const client = makeClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });

  // The floor clamps the pinned provisional synth to EXACTLY the doc's score; the
  // tie-break guard puts the doc first so a wrong synthesis never presents above the
  // actual API reference. Both nodes must be present and ranked with doc strictly first.
  const rankedIds = result.ranked_nodes.map((n) => n.node_id);
  assert.ok(rankedIds.includes("doc-node") && rankedIds.includes("prov-synth"), "both nodes must be ranked");
  assert.equal(rankedIds[0], "doc-node", `doc must rank first: ${JSON.stringify(rankedIds)}`);

  // Selection mirrors ranking: the pinned provisional synth is force-selected (always-
  // labeled "pinned") but appears AFTER the doc in both ranked and selected output.
  const selectedIds = result.selected_nodes.map((n) => n.node_id);
  assert.ok(
    selectedIds.indexOf("doc-node") < selectedIds.indexOf("prov-synth"),
    `selected order violated: ${JSON.stringify(selectedIds)}`
  );
});

/**
 * Phase 4 (unified memory): concerns-neighbor expansion. A synthesis hit should pull its
 * one-hop `concerns` targets (authority docs) into the ranked pool, bounded and safe:
 * only doc-stamped targets pass, scope-guarded, with envelope honesty (via / seeds / filters).
 */

function makeConcernClient({ concerns = {}, drawers = {}, statuses = {}, sourceTypes = {} } = {}) {
  const base = makeClient({ statuses, sourceTypes });
  base.getConcerns = async (id) => ({ node_ids: concerns[id] ?? [], count: (concerns[id] ?? []).length });
  base.getDrawer = async ({ drawer_id }) => drawers[drawer_id] ?? {};
  return base;
}

test("synthesis seed pulls its one-hop concerns doc into the pool with via: 'concern' and neighborhood boost", async () => {
  const nodes = [
    { node_id: "prov-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  ];
  const client = makeConcernClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "prov-synth": "synthesis", "authority-doc": "doc" },
    concerns: { "prov-synth": ["authority-doc"] },
    drawers: { "authority-doc": { drawer_id: "authority-doc", wing: "w", room: "unit-room", desc: "Gateway API reference" } },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["authority-doc"], `doc should be admitted via concerns: ${JSON.stringify(ids(result))}`);
  assert.equal(byId["authority-doc"].via, "concern");
  assert.equal(byId["prov-synth"].via, undefined); // scoped nodes keep no via marker
  assert.equal(byId["authority-doc"].source_type, "doc");

  // Score: doc base = log(1+0) + 0 + 0 + 0 = 0, + neighborhoodBoost 1 (it is in the
  // neighborhood set now), no intent boost -> exactly 1. The synthesis keeps its raw
  // score (no intent): 3*5 + log(1+6) + 4 + 8 + seedBoost 2 (it IS the canonical seed —
  // search returns nothing, so resolveCanonical falls back to the id itself) = 28.945910.
  assert.ok(Math.abs(byId["authority-doc"].score - 1) < 1e-9, `doc concern score off: ${byId["authority-doc"].score}`);
  assert.ok(Math.abs(byId["prov-synth"].score - 28.94591014905531) < 1e-9, `synth score off: ${byId["prov-synth"].score}`);

  // Envelope honesty.
  assert.deepEqual(result.seeds.concern_neighbor_ids, ["authority-doc"]);
  assert.equal(result.filters.concerns_expansion.enabled, true);
  assert.equal(result.filters.concerns_expansion.targets_admitted, 1);
});

test("factual intent: a concerns-linked doc outranks its provisional synthesis (floor now has real members)", async () => {
  const nodes = [
    // High-height provisional synth that would otherwise dominate on raw score.
    { node_id: "prov-synth", labels: ["pinned"], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  ];
  const client = makeConcernClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "prov-synth": "synthesis", "authority-doc": "doc" },
    concerns: { "prov-synth": ["authority-doc"] },
    drawers: { "authority-doc": { drawer_id: "authority-doc", wing: "w", room: "unit-room", desc: "Gateway API reference" } },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // doc: base 0 + neighborhood 1 + factual doc boost 2 = 3.
  // prov-synth raw: 30.945910 + synthesis boost 1 = 31.945910 -> clamped to floorMin = 3.
  assert.ok(Math.abs(byId["authority-doc"].score - 3) < 1e-9, `doc score off: ${byId["authority-doc"].score}`);
  assert.ok(Math.abs(byId["prov-synth"].score - 3) < 1e-9, `clamped synth score off: ${byId["prov-synth"].score}`);

  // The hard rule with a REAL doc in the pool (pre-Phase-4 the floor's FLOOR class was
  // usually empty): even a pinned provisional synthesis must not present above its own
  // authority doc on a factual query.
  assert.deepEqual(ids(result), ["authority-doc", "prov-synth"], `factual concerns ordering violated: ${JSON.stringify(ids(result))}`);

  console.log(
    `[worked-example] factual + concerns: authority-doc=${byId["authority-doc"].score.toFixed(6)}, ` +
      `prov-synth=${byId["prov-synth"].score.toFixed(6)} (raw 31.945910, clamped to floor ${byId["authority-doc"].score.toFixed(6)})`
  );
});

test("concerns targets that are not doc-stamped or out of scope are NOT admitted", async () => {
  const nodes = [
    { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
  ];
  const client = makeConcernClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis", "not-a-doc": "transcript", "other-wing-doc": "doc" },
    concerns: { "synth-a": ["not-a-doc", "other-wing-doc"] },
    drawers: {
      "not-a-doc": { drawer_id: "not-a-doc", wing: "w", room: "unit-room", desc: "a transcript" },
      "other-wing-doc": { drawer_id: "other-wing-doc", wing: "other-w", room: "unit-room", desc: "cross-project doc" },
    },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  // scope_wing engages the cross-wing guard (BASE_OPTIONS has no wing filter).
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, scope_wing: "w" });
  assert.deepEqual(ids(result), ["synth-a"], `no concern target should be admitted: ${JSON.stringify(ids(result))}`);
  // The edge was still SEEN (envelope honesty), but nothing was admitted.
  assert.deepEqual(result.seeds.concern_neighbor_ids, ["not-a-doc", "other-wing-doc"]);
  assert.equal(result.filters.concerns_expansion.targets_admitted, 0);
});

test("default path with no concerns configured is byte-identical in ordering to pre-Phase-4", async () => {
  const client = makeClient({
    statuses: { "prov-synth": "provisional", "active-synth": "active" },
    sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" },
  });

  // No getConcerns on the stub client -> concerns expansion is disabled entirely;
  // ordering and scores must match the pre-Phase-4 values exactly.
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_provisional: true });
  assert.deepEqual(
    ids(result),
    ["prov-synth", "doc-node", "active-synth"],
    `no-concerns ordering changed: ${JSON.stringify(ids(result))}`
  );
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  assert.ok(Math.abs(byId["prov-synth"].score - 30.94591014905531) < 1e-9, `prov score changed: ${byId["prov-synth"].score}`);
  assert.equal(result.filters.concerns_expansion.enabled, false);
  assert.equal(result.filters.concerns_expansion.targets_admitted, 0);
  assert.deepEqual(result.seeds.concern_neighbor_ids, []);
  // Phase 3 close-out envelope honesty: default intent + no include_docs -> the doc
  // scan must not even be reported (no room paging happened).
  assert.equal(result.filters.doc_scan, undefined, "no doc_scan entry on the default path");
});

/**
 * Phase 3 close-out (unified memory): direct doc admission. Standalone docs have no
 * lineage edge, so listScopedDerivedDrawers never admits them; before a concerns edge
 * exists they are invisible to scoped retrieval. On factual intent (or explicit
 * include_docs) the adapter scans the scope room (bounded paging) and admits
 * doc-stamped drawers directly (via: "doc"). Proves:
 *   1. factual intent admits a standalone doc with via: "doc" and the floor engages;
 *   2. non-factual + no flag -> zero extra calls, byte-identical ordering;
 *   3. include_docs opt-in works without an intent;
 *   4. hard filter: unstamped/transcript rows are NOT admitted;
 *   5. scope guard: out-of-wing/room docs are NOT admitted;
 *   6. dedupe: a doc already in the pool via concerns keeps via: "concern";
 *   7. page cap respected (truncated reported).
 */

function makeDocScanClient({ rows = [], sourceTypes = {}, statuses = {} } = {}) {
  const base = makeClient({ statuses, sourceTypes });
  // Bounded room listing: the probe (limit 1) reports the total; pages slice rows.
  base.listDrawers = async ({ limit, offset }) => ({ drawers: rows.slice(offset, offset + limit), total: rows.length });
  return base;
}

const DOC_ROW = { drawer_id: "standalone-doc", wing: "w", room: "unit-room", desc: "Gateway API reference" };

test("factual intent admits a standalone doc without a concerns edge (via: 'doc', floor engages)", async () => {
  const nodes = [
    // High-height provisional synth that would otherwise dominate on raw score.
    { node_id: "prov-synth", labels: ["pinned"], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  ];
  const client = makeDocScanClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "prov-synth": "synthesis", "standalone-doc": "doc" },
    rows: [DOC_ROW],
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["standalone-doc"], `doc should be admitted directly: ${JSON.stringify(ids(result))}`);
  assert.equal(byId["standalone-doc"].via, "doc");
  assert.equal(byId["standalone-doc"].source_type, "doc");
  assert.equal(byId["prov-synth"].via, undefined); // scoped nodes keep no via marker

  // Computed scores (factual intent):
  //   standalone-doc: base 0 + doc boost 2 = 2 (no neighborhood boost — deliberately
  //     NOT in the neighborhood set; doc authority comes from the boost table).
  //   prov-synth: raw 30.945910 + synthesis boost 1 = 31.945910 -> clamped to floorMin = 2.
  assert.ok(Math.abs(byId["standalone-doc"].score - 2) < 1e-9, `doc score off: ${byId["standalone-doc"].score}`);
  assert.ok(Math.abs(byId["prov-synth"].score - 2) < 1e-9, `clamped synth score off: ${byId["prov-synth"].score}`);

  // The hard rule with a REAL doc in the pool BEFORE any concerns edge exists — the
  // exact failure mode the Phase 6 audit flagged: even a pinned provisional synthesis
  // must not present above a standalone doc on a factual query.
  assert.deepEqual(
    ids(result),
    ["standalone-doc", "prov-synth"],
    `factual direct-doc ordering violated: ${JSON.stringify(ids(result))}`
  );

  console.log(
    `[worked-example] factual + direct doc: standalone-doc=${byId["standalone-doc"].score.toFixed(6)}, ` +
      `prov-synth=${byId["prov-synth"].score.toFixed(6)} (raw 31.945910, clamped to floor ${byId["standalone-doc"].score.toFixed(6)})`
  );

  // Envelope honesty: the scan happened, scanned 1 drawer, admitted 1, not truncated.
  assert.equal(result.filters.doc_scan.enabled, true);
  assert.deepEqual(result.filters.doc_scan.rooms_scanned, ["unit-room"]);
  assert.equal(result.filters.doc_scan.drawers_scanned, 1);
  assert.equal(result.filters.doc_scan.targets_admitted, 1);
  assert.equal(result.filters.doc_scan.truncated, false);
});

test("non-factual intent without include_docs: zero doc-scan calls and byte-identical ordering", async () => {
  const nodes = [
    { node_id: "prov-synth", labels: ["pinned"], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  ];
  const client = makeDocScanClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "prov-synth": "synthesis", "standalone-doc": "doc" },
    rows: [DOC_ROW],
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  // The gate is factual-or-explicit: default intent must not silently enable the scan.
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_provisional: true });

  assert.deepEqual(
    ids(result),
    ["prov-synth"],
    `default path must be unchanged (no doc admission): ${JSON.stringify(ids(result))}`
  );
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  assert.ok(Math.abs(byId["prov-synth"].score - 30.94591014905531) < 1e-9, `default score changed: ${byId["prov-synth"].score}`);
  // No room paging happened at all — the stub listDrawers was never called.
  assert.equal(result.filters.doc_scan, undefined, "no doc_scan entry when docs not requested");

  // historical intent (non-factual) without the flag: same story.
  const hist = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "historical", include_provisional: true });
  assert.deepEqual(ids(hist), ["prov-synth"], `historical path must be unchanged: ${JSON.stringify(ids(hist))}`);
  assert.equal(hist.filters.doc_scan, undefined);
});

test("include_docs: true on default intent admits docs (explicit opt-in)", async () => {
  const nodes = [
    { node_id: "active-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 2, retrieval_count: 1, connection_degree: 1, lineage_match_count: 1 },
  ];
  const client = makeDocScanClient({
    statuses: { "active-synth": "active" },
    sourceTypes: { "active-synth": "synthesis", "standalone-doc": "doc" },
    rows: [DOC_ROW],
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_docs: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["standalone-doc"], `doc should be admitted via explicit opt-in: ${JSON.stringify(ids(result))}`);
  assert.equal(byId["standalone-doc"].via, "doc");
  // No intent -> no authority boost: doc base score is exactly 0.
  assert.ok(Math.abs(byId["standalone-doc"].score - 0) < 1e-9, `opt-in doc score off: ${byId["standalone-doc"].score}`);
  assert.equal(result.filters.doc_scan.enabled, true);
  assert.equal(result.filters.doc_scan.targets_admitted, 1);
});

test("direct doc scan hard-filters unstamped and non-doc rows (scanned but not admitted)", async () => {
  const nodes = [
    { node_id: "active-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 2, retrieval_count: 1, connection_degree: 1, lineage_match_count: 1 },
  ];
  const client = makeDocScanClient({
    statuses: { "active-synth": "active" },
    sourceTypes: { "active-synth": "synthesis", "transcript-row": "transcript" }, // unstamped-doc left unstamped (null)
    rows: [
      { drawer_id: "unstamped-doc", wing: "w", room: "unit-room", desc: "no stamp" },
      { drawer_id: "transcript-row", wing: "w", room: "unit-room", desc: "a transcript" },
    ],
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual" });
  assert.deepEqual(
    ids(result),
    ["active-synth"],
    `no non-doc row may be admitted: ${JSON.stringify(ids(result))}`
  );
  // The scan DID happen (envelope honesty): it saw both rows, admitted neither.
  assert.equal(result.filters.doc_scan.enabled, true);
  assert.equal(result.filters.doc_scan.drawers_scanned, 2);
  assert.equal(result.filters.doc_scan.targets_admitted, 0);
});

test("direct doc scan scope guard: docs in another wing/room are NOT admitted", async () => {
  const nodes = [
    { node_id: "active-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 2, retrieval_count: 1, connection_degree: 1, lineage_match_count: 1 },
  ];
  const client = makeDocScanClient({
    statuses: { "active-synth": "active" },
    sourceTypes: { "active-synth": "synthesis", "other-wing-doc": "doc", "other-room-doc": "doc" },
    rows: [
      { drawer_id: "other-wing-doc", wing: "other-w", room: "unit-room", desc: "cross-project doc" },
      { drawer_id: "other-room-doc", wing: "w", room: "elsewhere", desc: "cross-room doc" },
    ],
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  // scope_wing engages the cross-wing guard; scope_room is unit-room.
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", scope_wing: "w" });
  assert.deepEqual(
    ids(result),
    ["active-synth"],
    `out-of-scope docs must not be admitted: ${JSON.stringify(ids(result))}`
  );
  assert.equal(result.filters.doc_scan.drawers_scanned, 2);
  assert.equal(result.filters.doc_scan.targets_admitted, 0);
});

test("dedupe: a doc already in the pool via concerns keeps via: 'concern' (no duplicate admission)", async () => {
  const nodes = [
    { node_id: "prov-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  ];
  const client = makeDocScanClient({
    statuses: { "prov-synth": "provisional" },
    sourceTypes: { "prov-synth": "synthesis", "authority-doc": "doc" },
    rows: [{ drawer_id: "authority-doc", wing: "w", room: "unit-room", desc: "Gateway API reference" }],
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });
  client.getConcerns = async (id) => ({ node_ids: id === "prov-synth" ? ["authority-doc"] : [], count: 1 });
  client.getDrawer = async ({ drawer_id }) => ({ drawer_id, wing: "w", room: "unit-room", desc: "Gateway API reference" });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", include_provisional: true });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // Exactly one entry for the doc; the edge path won the via precedence.
  assert.equal(result.ranked_nodes.filter((n) => n.node_id === "authority-doc").length, 1, "no duplicate admission");
  assert.equal(byId["authority-doc"].via, "concern", `via must stay 'concern', got: ${byId["authority-doc"].via}`);

  // The doc scan still reports honestly: it scanned the row but admitted 0 (deduped).
  assert.equal(result.filters.doc_scan.enabled, true);
  assert.equal(result.filters.doc_scan.drawers_scanned, 1);
  assert.equal(result.filters.doc_scan.targets_admitted, 0);
});

test("direct doc scan respects the page cap and reports truncation", async () => {
  // 300 rows in the room; the bounded scan covers at most 4 pages x 50 = 200.
  const rows = Array.from({ length: 300 }, (_, i) => ({ drawer_id: `row-${i}`, wing: "w", room: "unit-room", desc: "d" }));
  const client = makeDocScanClient({ rows });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, include_docs: true });

  assert.equal(result.filters.doc_scan.enabled, true);
  // Every listed row is a candidate (deduped by id) — the scan saw all 300 listed
  // rows across the capped pages... but only 200 rows were actually fetched.
  assert.equal(result.filters.doc_scan.drawers_scanned, 200, `only capped rows may be scanned: ${result.filters.doc_scan.drawers_scanned}`);
  assert.equal(result.filters.doc_scan.truncated, true, "truncation must be reported");
  // None of the rows are doc-stamped (null) -> nothing admitted.
  assert.equal(result.filters.doc_scan.targets_admitted, 0);
});

