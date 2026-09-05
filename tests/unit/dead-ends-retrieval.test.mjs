import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval } from "../../src/capability/retrieval/retrieval-expansion.ts";

/**
 * Phase 9 (unified memory): negative-knowledge labelling in scoped retrieval.
 *
 * Drives `expandScopedRetrieval` with a stub MemgraphClient whose getRulesOut
 * returns fixed per-node rules-out facts, so scores are fully deterministic. Proves:
 *   1. a synthesis carrying a rules-out edge is returned with the explicit
 *      ruled_out marker (polarity + statements) — never an unlabelled dead end;
 *   2. labelling does NOT change ranking: a labelled node's score is byte-identical
 *      to the same node without the capability (weights.ruledOut is 0 by construction);
 *   3. the marker only applies to synthesis nodes (docs are never dead ends);
 *   4. envelope diagnostics report how many nodes were labelled and that weight=0;
 *   5. a client without getRulesOut degrades to pre-Phase-9 output (no calls, no field).
 */

function makeClient({ sourceTypes = {}, rulesOut } = {}) {
  const client = {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async () => ({}),
    getLineageSources: async () => ({}),
    getLineageDerivatives: async () => ({}),
    listScopedDerivedDrawers: async () => ({ nodes: FIXTURE_NODES }),
    getClosetStatus: async () => "unknown",
    getClosetSourceType: async (id) => sourceTypes[id] ?? null,
  };
  if (rulesOut) {
    client.getRulesOut = async (id) => {
      const entry = rulesOut[id];
      if (!entry) return { statements: [], polarities: [], count: 0 };
      return { statements: entry.statements, polarities: entry.polarities, count: entry.statements.length + entry.polarities.length };
    };
  }
  return client;
}

const BASE_OPTIONS = {
  query: "how does the gateway work",
  scope_room: "unit-room",
  top_n: 10,
};

// Two same-shape syntheses so the ONLY difference is the rules-out marker.
const FIXTURE_NODES = [
  { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
  { node_id: "synth-b", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
];

function ids(result) {
  return result.ranked_nodes.map((n) => n.node_id);
}

test("a synthesis with a rules-out edge is returned with the explicit ruled_out marker", async () => {
  const client = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    rulesOut: {
      "synth-a": { statements: ["cache_control injection on the openai/ prefix"], polarities: ["tried-failed"] },
    },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["synth-a"].ruled_out, "dead end must carry the ruled_out marker");
  assert.equal(byId["synth-a"].ruled_out.polarity, "tried-failed");
  assert.deepEqual(byId["synth-a"].ruled_out.statements, ["cache_control injection on the openai/ prefix"]);

  // The non-dead-end node is untouched.
  assert.equal(byId["synth-b"].ruled_out, undefined);
});

test("labelling does NOT change ranking (score identical with and without the capability)", async () => {
  const withCapability = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    rulesOut: {
      "synth-a": { statements: ["cache_control injection on the openai/ prefix"], polarities: ["tried-failed"] },
    },
  });
  const withoutCapability = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });

  const a = await expandScopedRetrieval(withCapability, { ...BASE_OPTIONS });
  const b = await expandScopedRetrieval(withoutCapability, { ...BASE_OPTIONS });
  const aById = Object.fromEntries(a.ranked_nodes.map((n) => [n.node_id, n]));
  const bById = Object.fromEntries(b.ranked_nodes.map((n) => [n.node_id, n]));

  // The labelled node's score must be byte-identical to the unlabelled run —
  // weights.ruledOut is 0 by construction; this phase labels, it does not re-rank.
  assert.equal(aById["synth-a"].score, bById["synth-a"].score, "labelling must not move the score");
  assert.equal(aById["synth-b"].score, bById["synth-b"].score);
  // Ordering is unchanged too.
  assert.deepEqual(ids(a), ids(b), "labelling must not change ordering");
});

test("the marker only applies to synthesis nodes (docs are never dead ends)", async () => {
  const nodes = [
    { node_id: "doc-node", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 1 },
  ];
  const client = makeClient({
    sourceTypes: { "doc-node": "doc" },
    rulesOut: {
      // Even if a doc somehow had a rules-out edge, it must not be labelled —
      // dead ends are syntheses with negative polarity, never docs.
      "doc-node": { statements: ["some statement"], polarities: ["tried-failed"] },
    },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  assert.equal(byId["doc-node"].ruled_out, undefined, "a doc must never carry the ruled_out marker");
});

test("envelope diagnostics report labelled count and zero weight", async () => {
  const client = makeClient({
    sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" },
    rulesOut: {
      "synth-a": { statements: ["statement A"], polarities: ["tried-failed"] },
    },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  assert.equal(result.filters.ruled_out_expansion.enabled, true);
  assert.equal(result.filters.ruled_out_expansion.nodes_labeled, 1);
  assert.equal(result.filters.ruled_out_expansion.weight, 0, "this phase labels, it does not re-rank");
});

test("client without getRulesOut degrades to pre-Phase-9 output (no calls, no field)", async () => {
  const client = makeClient({ sourceTypes: { "synth-a": "synthesis", "synth-b": "synthesis" } });
  assert.equal(typeof client.getRulesOut, "undefined");

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));
  assert.equal(byId["synth-a"].ruled_out, undefined);
  assert.equal(result.filters.ruled_out_expansion, undefined, "no ruled_out_expansion entry when the client lacks the reader");
});
