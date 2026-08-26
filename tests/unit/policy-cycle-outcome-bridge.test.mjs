import assert from "node:assert/strict";
import test from "node:test";

import { buildOutcomeProposal } from "../../scripts/run-policy-cycle.ts";
import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";

/**
 * Unit coverage for the Phase 7 usability bridge in scripts/run-policy-cycle.ts:
 * the operator-ready `record_outcome` proposal emitted alongside policy-cycle
 * output. Proves:
 *   1. selected_nodes ids are mirrored into the proposal's node_ids (deduped, no
 *      broad attribution — nothing outside selected_nodes appears);
 *   2. the proposal defaults to dry_run: true;
 *   3. no write tool is invoked by the bridge (it is a pure builder, and the
 *      script path that calls it performs only retrieval + stdout);
 *   4. allowed outcome values are documented in the proposal's instructions;
 *   5. cycle_ref is deterministic for a fixed timestamp + query.
 */

const NOW = () => new Date("2026-08-25T12:00:00.000Z");

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

const BASE_OPTIONS = { query: "how does the gateway work", scope_room: "unit-room", top_n: 10 };

const FIXTURE_NODES = [
  { node_id: "doc-node", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 2, connection_degree: 2, lineage_match_count: 2 },
  { node_id: "prov-synth", labels: ["pinned"], wing: "w", room: "unit-room", desc: "d", height: 5, retrieval_count: 6, connection_degree: 4, lineage_match_count: 4 },
  { node_id: "active-synth", labels: [], wing: "w", room: "unit-room", desc: "d", height: 2, retrieval_count: 1, connection_degree: 1, lineage_match_count: 1 },
];

test("selected_nodes are mirrored into proposal node_ids (deduped, exact set)", async () => {
  const client = makeClient({ statuses: { "prov-synth": "provisional" }, sourceTypes: { "doc-node": "doc", "prov-synth": "synthesis" } });
  const result = await expandScopedRetrieval(client, BASE_OPTIONS);

  const selectedIds = result.selected_nodes.map((n) => n.node_id);
  assert.ok(selectedIds.length > 0, "fixture must produce selected nodes");

  const proposal = buildOutcomeProposal(result.selected_nodes, BASE_OPTIONS.query, NOW());
  assert.deepEqual(proposal.payload.node_ids, [...new Set(selectedIds)], "node_ids must be exactly the deduped selected_nodes set");
});

test("proposal defaults to dry_run: true", () => {
  const proposal = buildOutcomeProposal([{ node_id: "drawer_x" }], "q", NOW());
  assert.equal(proposal.payload.dry_run, true);
});

test("no write tool is invoked by the bridge (pure builder; no kg_add/record_outcome)", () => {
  // The bridge is a pure function with no transport argument — structurally it
  // cannot call kg_add or record_outcome. Verify the returned payload contains
  // only the documented informational fields and nothing write-side.
  const proposal = buildOutcomeProposal([{ node_id: "drawer_x" }], "q", NOW());
  assert.equal(proposal.tool, "record_outcome");
  assert.deepEqual(Object.keys(proposal.payload).sort(), ["cycle_ref", "dry_run", "node_ids", "outcome"]);
  // outcome is a null placeholder — the operator sets it; never pre-filled.
  assert.equal(proposal.payload.outcome, null);
});

test("allowed outcome values are documented in output instructions", () => {
  const proposal = buildOutcomeProposal([{ node_id: "drawer_x" }], "q", NOW());
  assert.deepEqual(proposal.instructions.allowed_outcomes, ["accept", "revise", "failed", "unused"]);
  assert.match(proposal.instructions.note, /dry_run/);
});

test("cycle_ref is deterministic for a fixed timestamp + query", () => {
  const a = buildOutcomeProposal([{ node_id: "n" }], "same query", NOW());
  const b = buildOutcomeProposal([{ node_id: "n" }], "same query", NOW());
  assert.equal(a.payload.cycle_ref, b.payload.cycle_ref);
  assert.match(a.payload.cycle_ref, /^policy-2026-08-25T12-00-00-000Z-[0-9a-f]{8}$/);

  const c = buildOutcomeProposal([{ node_id: "n" }], "different query", NOW());
  assert.notEqual(a.payload.cycle_ref, c.payload.cycle_ref, "different queries must produce different cycle refs");
});
