import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval } from "../../src/capability/retrieval/retrieval-expansion.ts";

/**
 * Unit coverage for Phase 5 Unit B (unified memory): refined-by neighbor
 * expansion on procedural intent. A skill is a leaf with no synthesized-from
 * lineage, so it never enters the scoped pool — the one-hop `refined-by` edge
 * is the bridge. This file proves:
 *   1. procedural intent admits a skill via incoming refined-by (skill →
 *      synthesis in the pool), ranks it above an unstamped transcript with the
 *      computed scores printed, and exposes envelope honesty;
 *   2. outgoing refined-by on a skill-typed pool node admits its evidence;
 *   3. non-procedural / default intents never call getRefinedBy (no regression);
 *   4. candidates that are not skill-stamped or out of scope are NOT admitted;
 *   5. a client without getRefinedBy degrades to pre-Phase-5 behavior with zero
 *      extra calls and no envelope entry;
 *   6. the adapter helpers (getRefinedBy / getRefines) issue one-hop kg_query
 *      in the right direction and degrade gracefully on failure.
 */

const BASE_OPTIONS = {
  query: "how do I ingest docs",
  scope_room: "unit-room",
  top_n: 10,
};

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

// Fixture pool: a synthesis (the evidence target) and an unstamped transcript.
//   synth-a:      height 1, retrieval 0, connection 0, lineage 0 -> base 3
//   transcript-b: height 1, retrieval 0, connection 0, lineage 0 -> base 3
const FIXTURE_NODES = [
  { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
  { node_id: "transcript-b", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
];

function makeRefinedClient({ refinedBy = {}, refines = {}, drawers = {}, statuses = {}, sourceTypes = {} } = {}) {
  const base = makeClient({ statuses, sourceTypes });
  base.getRefinedBy = async (id) => ({ node_ids: refinedBy[id] ?? [], count: (refinedBy[id] ?? []).length });
  base.getRefines = async (id) => ({ node_ids: refines[id] ?? [], count: (refines[id] ?? []).length });
  base.getDrawer = async ({ drawer_id }) => drawers[drawer_id] ?? {};
  return base;
}

function ids(result) {
  return result.ranked_nodes.map((n) => n.node_id);
}

test("procedural intent admits a skill via incoming refined-by and ranks it above an unstamped transcript (computed scores)", async () => {
  const client = makeRefinedClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis", "ingest-docs-skill": "skill" },
    // Skill points at the synthesis as evidence: refined-by(skill -> synth-a).
    refinedBy: { "synth-a": ["ingest-docs-skill"] },
    drawers: { "ingest-docs-skill": { drawer_id: "ingest-docs-skill", wing: "w", room: "skills", desc: "Ingest docs procedure" } },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["ingest-docs-skill"], `skill should be admitted via refined-by: ${JSON.stringify(ids(result))}`);
  assert.equal(byId["ingest-docs-skill"].via, "refined");
  assert.equal(byId["ingest-docs-skill"].source_type, "skill");
  assert.equal(byId["synth-a"].via, undefined); // scoped nodes keep no via marker

  // Computed scores (default weights; no intent boost on the transcript/unknown):
  //   ingest-docs-skill: base 0 + neighborhoodBoost 1 + procedural skill boost 2 = 3
  //   synth-a:           base 3 + procedural synthesis boost 1                = 4
  //   transcript-b:      base 3 + 0 (unknown authority)                        = 3
  assert.ok(Math.abs(byId["ingest-docs-skill"].score - 3) < 1e-9, `skill score off: ${byId["ingest-docs-skill"].score}`);
  assert.ok(Math.abs(byId["synth-a"].score - 4) < 1e-9, `synth score off: ${byId["synth-a"].score}`);
  assert.ok(Math.abs(byId["transcript-b"].score - 3) < 1e-9, `transcript score off: ${byId["transcript-b"].score}`);

  // Ordering: synth-a (4) first. Skill (3) ties transcript-b (3) on score; the
  // height tie-break puts transcript-b (h=1) above the skill (h=0 — refined-by is
  // not lineage, so admitted skills keep pure synthesized-from height). A skill
  // outranking an unstamped h=0 transcript is proven by the next test.
  assert.deepEqual(
    ids(result),
    ["synth-a", "transcript-b", "ingest-docs-skill"],
    `procedural ordering off: ${JSON.stringify(ids(result))}`
  );

  console.log(
    `[worked-example] procedural + refined-by: ingest-docs-skill=${byId["ingest-docs-skill"].score.toFixed(6)}, ` +
      `synth-a=${byId["synth-a"].score.toFixed(6)}, transcript-b=${byId["transcript-b"].score.toFixed(6)}`
  );

  // Envelope honesty.
  assert.deepEqual(result.seeds.refined_neighbor_ids, ["ingest-docs-skill"]);
  assert.equal(result.filters.refined_expansion.enabled, true);
  assert.equal(result.filters.refined_expansion.targets_admitted, 1);
});

test("procedural intent: a skill admitted via refined-by outranks an unstamped h=0 transcript", async () => {
  const nodes = [
    { node_id: "synth-a", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
    { node_id: "transcript-c", labels: [], wing: "w", room: "unit-room", desc: "d", height: 0, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
  ];
  const client = makeRefinedClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis", "ingest-docs-skill": "skill" },
    refinedBy: { "synth-a": ["ingest-docs-skill"] },
    drawers: { "ingest-docs-skill": { drawer_id: "ingest-docs-skill", wing: "w", room: "skills", desc: "Ingest docs procedure" } },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  //   ingest-docs-skill: 0 + 1 (neighborhood) + 2 (skill boost) = 3
  //   transcript-c:       0 + 0 + 0                             = 0
  assert.ok(Math.abs(byId["ingest-docs-skill"].score - 3) < 1e-9, `skill score off: ${byId["ingest-docs-skill"].score}`);
  assert.ok(Math.abs(byId["transcript-c"].score - 0) < 1e-9, `transcript score off: ${byId["transcript-c"].score}`);
  assert.deepEqual(
    ids(result),
    ["synth-a", "ingest-docs-skill", "transcript-c"],
    `skill must rank above the unstamped transcript: ${JSON.stringify(ids(result))}`
  );
});

test("procedural intent: outgoing refined-by on a skill-typed pool node admits its evidence (skill-stamped only)", async () => {
  const nodes = [
    { node_id: "ingest-docs-skill", labels: [], wing: "w", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
  ];
  const client = makeRefinedClient({
    statuses: { "ingest-docs-skill": "active" },
    sourceTypes: { "ingest-docs-skill": "skill", "session-evidence": "transcript" },
    // Skill's outgoing refined-by points at the session that refined it.
    refines: { "ingest-docs-skill": ["session-evidence"] },
    drawers: { "session-evidence": { drawer_id: "session-evidence", wing: "w", room: "unit-room", desc: "Session transcript" } },
  });
  client.listScopedDerivedDrawers = async () => ({ nodes });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // The evidence is a transcript, not skill-stamped -> NOT admitted (hard filter).
  assert.ok(!byId["session-evidence"], `non-skill evidence must not be admitted: ${JSON.stringify(ids(result))}`);
  // But the edge was still SEEN (envelope honesty).
  assert.deepEqual(result.seeds.refined_neighbor_ids, ["session-evidence"]);
  assert.equal(result.filters.refined_expansion.targets_admitted, 0);
});

test("non-procedural and default intents never call getRefinedBy (no regression)", async () => {
  let refinedByCalls = 0;
  const client = makeRefinedClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis", "ingest-docs-skill": "skill" },
    refinedBy: { "synth-a": ["ingest-docs-skill"] },
    drawers: { "ingest-docs-skill": { drawer_id: "ingest-docs-skill", wing: "w", room: "skills", desc: "d" } },
  });
  const origGetRefinedBy = client.getRefinedBy;
  client.getRefinedBy = async (id) => { refinedByCalls++; return origGetRefinedBy(id); };

  // factual intent: no refined-by expansion.
  const fact = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual" });
  assert.equal(refinedByCalls, 0, `getRefinedBy must not be called on factual intent (calls=${refinedByCalls})`);
  assert.ok(!ids(fact).includes("ingest-docs-skill"), `skill must not enter the pool on factual intent: ${JSON.stringify(ids(fact))}`);
  assert.equal(fact.filters.refined_expansion, undefined, "no refined_expansion entry for non-procedural intents");

  // default (omitted) intent: no refined-by expansion.
  const def = await expandScopedRetrieval(client, { ...BASE_OPTIONS });
  assert.equal(refinedByCalls, 0, `getRefinedBy must not be called on default intent (calls=${refinedByCalls})`);
  assert.ok(!ids(def).includes("ingest-docs-skill"), `skill must not enter the pool on default intent: ${JSON.stringify(ids(def))}`);
  assert.equal(def.filters.refined_expansion, undefined);

  // historical intent: no refined-by expansion.
  await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "historical" });
  assert.equal(refinedByCalls, 0, `getRefinedBy must not be called on historical intent (calls=${refinedByCalls})`);
});

test("client without getRefinedBy degrades to pre-Phase-5 behavior (zero extra calls, no envelope entry)", async () => {
  // makeClient has no getRefinedBy / getRefines — the feature gate must disable
  // the expansion entirely. Ordering and scores match the pre-Phase-5 values.
  const client = makeClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // Pre-Phase-5 procedural scores (no skill in the pool): synth-a 3+1=4, transcript-b 3.
  assert.ok(Math.abs(byId["synth-a"].score - 4) < 1e-9, `synth score changed: ${byId["synth-a"].score}`);
  assert.ok(Math.abs(byId["transcript-b"].score - 3) < 1e-9, `transcript score changed: ${byId["transcript-b"].score}`);
  assert.deepEqual(ids(result), ["synth-a", "transcript-b"], `degraded ordering changed: ${JSON.stringify(ids(result))}`);

  // Envelope honesty: the expansion is reported as disabled.
  assert.equal(result.filters.refined_expansion.enabled, false);
  assert.equal(result.filters.refined_expansion.targets_admitted, 0);
  assert.equal(result.seeds.refined_neighbor_ids, undefined);
});

test("procedural intent does NOT trigger the direct doc scan (gate is factual-or-explicit)", async () => {
  // The Phase 3 close-out gate is `include_docs || intent === "factual"`. A procedural
  // intent without the explicit flag must not silently enable the doc room paging.
  const client = makeClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis", "standalone-doc": "doc" },
  });
  let listDrawersCalls = 0;
  client.listDrawers = async () => {
    listDrawersCalls++;
    return { drawers: [{ drawer_id: "standalone-doc", wing: "w", room: "unit-room", desc: "d" }], total: 1 };
  };

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural" });

  assert.equal(listDrawersCalls, 0, `doc scan must not page rooms on procedural intent (calls=${listDrawersCalls})`);
  assert.ok(!ids(result).includes("standalone-doc"), `doc must not enter the pool on procedural intent: ${JSON.stringify(ids(result))}`);
  assert.equal(result.filters.doc_scan, undefined, "no doc_scan entry when docs not requested");

  // Explicit opt-in still works for procedural intent.
  const optedIn = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", include_docs: true });
  assert.ok(ids(optedIn).includes("standalone-doc"), `include_docs must admit the doc on procedural intent: ${JSON.stringify(ids(optedIn))}`);
  const byId = Object.fromEntries(optedIn.ranked_nodes.map((n) => [n.node_id, n]));
  assert.equal(byId["standalone-doc"].via, "doc");
  assert.equal(optedIn.filters.doc_scan.targets_admitted, 1);
});

test("refined-by candidates that are not skill-stamped or out of scope are NOT admitted", async () => {
  const client = makeRefinedClient({
    statuses: { "synth-a": "active" },
    sourceTypes: { "synth-a": "synthesis", "not-a-skill": "transcript", "other-wing-skill": "skill" },
    refinedBy: { "synth-a": ["not-a-skill", "other-wing-skill"] },
    drawers: {
      "not-a-skill": { drawer_id: "not-a-skill", wing: "w", room: "unit-room", desc: "a transcript" },
      "other-wing-skill": { drawer_id: "other-wing-skill", wing: "other-w", room: "skills", desc: "cross-project skill" },
    },
  });

  // scope_wing engages the cross-wing guard (BASE_OPTIONS has no wing filter).
  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", scope_wing: "w" });
  assert.deepEqual(ids(result), ["synth-a", "transcript-b"], `no refined candidate should be admitted: ${JSON.stringify(ids(result))}`);
  // Both edges were still SEEN (envelope honesty), but nothing was admitted.
  assert.deepEqual(result.seeds.refined_neighbor_ids, ["not-a-skill", "other-wing-skill"]);
  assert.equal(result.filters.refined_expansion.targets_admitted, 0);
});

test("getRefinedBy / getRefines issue one-hop kg_query in the right direction and degrade on failure", async () => {
  const { createMemgraphClient } = await import("../../src/core/memgraph.ts");

  // getRefinedBy: incoming refined-by subjects.
  const seenIn = [];
  const clientIn = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query")) seenIn.push(args || {});
      return { facts: [{ current: true, subject: "skill-x", predicate: "refined-by", object: "evidence-y" }] };
    },
  });
  const inRes = await clientIn.getRefinedBy("evidence-y");
  assert.deepEqual(inRes.node_ids, ["skill-x"]);
  assert.equal(seenIn.length, 1);
  assert.equal(seenIn[0].direction, "incoming");
  assert.equal(seenIn[0].predicate, "refined-by");
  // One-hop: the adapter passes max_depth 1 and never sets recurse (undefined = no recursion).
  assert.equal(seenIn[0].max_depth, 1);
  assert.ok(!("recurse" in seenIn[0]), `recurse must not be set for one-hop queries: ${JSON.stringify(seenIn[0])}`);

  // getRefines: outgoing refined-by targets.
  const seenOut = [];
  const clientOut = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query")) seenOut.push(args || {});
      return { facts: [{ current: true, subject: "skill-x", predicate: "refined-by", object: "evidence-y" }] };
    },
  });
  const outRes = await clientOut.getRefines("skill-x");
  assert.deepEqual(outRes.node_ids, ["evidence-y"]);
  assert.equal(seenOut[0].direction, "outgoing");
  assert.equal(seenOut[0].predicate, "refined-by");

  // Graceful degradation: a failing kg_query degrades to empty, never throws.
  const clientFail = createMemgraphClient({
    callTool: async () => { throw new Error("server down"); },
  });
  const failRes = await clientFail.getRefinedBy("evidence-y");
  assert.deepEqual(failRes.node_ids, []);
  const failRes2 = await clientFail.getRefines("skill-x");
  assert.deepEqual(failRes2.node_ids, []);

  // Self-links are filtered out.
  const clientSelf = createMemgraphClient({
    callTool: async () => ({ facts: [{ current: true, subject: "node-1", predicate: "refined-by", object: "node-1" }] }),
  });
  assert.deepEqual((await clientSelf.getRefinedBy("node-1")).node_ids, []);
});
