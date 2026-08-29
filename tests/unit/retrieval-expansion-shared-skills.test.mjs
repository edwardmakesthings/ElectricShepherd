import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";

/**
 * Unit coverage for Phase 10 (unified memory): shared-skills-wing admission on
 * procedural intent. A skill promoted into the shared wing has NO edges into the
 * querying project, so edge-based expansion cannot see it — the bounded room scan
 * of the shared wing's `skills` room is the primary admission path. This file proves:
 *   1. procedural intent + shared_wing admits a skill-stamped drawer from the shared
 *      wing (via: "shared"), ranked with the existing procedural boosts;
 *   2. non-procedural intents NEVER call listDrawers on the shared wing and admit no
 *      cross-wing node (the exact failure mode wing-scoping exists to prevent);
 *   3. an unstamped or transcript-stamped drawer in the shared room is NOT admitted
 *      even on procedural intent (hard es-source-type: skill check);
 *   4. a row claiming a different wing than the shared wing is dropped;
 *   5. a client without listDrawers degrades to pre-Phase-10 behavior with zero
 *      extra calls and no envelope entry;
 *   6. envelope honesty: shared_skills_expansion reports scanned/admitted/truncated;
 *   7. Phase 12 es-domain filtering: a code request admits code + general, excludes
 *      writing; an unknown requester admits only null/general; unstamped legacy skills
 *      stay admissible; a client without getClosetDomain degrades to no filtering;
 *   8. P2-1 promoted-from provenance read: the reader is called for admitted shared
 *      skills on procedural intent and its result rides into the node metadata +
 *      envelope WITHOUT changing ranking; non-procedural intents, other pool nodes, and
 *      clients without getPromotedFrom never call it (degrade to pre-P2-1 output).
 */

const BASE_OPTIONS = {
  query: "how do I diagnose a caching regression",
  scope_room: "unit-room",
  top_n: 10,
};

const SHARED_WING = "shared-skills";

// Fixture pool for the LOCAL project wing (the querying side).
const FIXTURE_NODES = [
  { node_id: "local-synth", labels: [], wing: "projA", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
];

// Shared-wing drawers (the promoted skills).
const SHARED_SKILL = { drawer_id: "shared-skill-1", wing: SHARED_WING, room: "skills", desc: "Caching regression procedure" };
const SHARED_UNSTAMPED = { drawer_id: "shared-unstamped", wing: SHARED_WING, room: "skills", desc: "No type stamp" };
const SHARED_TRANSCRIPT = { drawer_id: "shared-transcript", wing: SHARED_WING, room: "skills", desc: "A transcript in the shared room" };
const SHARED_WRONG_WING = { drawer_id: "shared-wrong-wing", wing: "projB", room: "skills", desc: "Claims a different wing" };

// Phase 12 domain fixtures.
const SKILL_CODE = { drawer_id: "skill-code", wing: SHARED_WING, room: "skills", desc: "A code-domain skill" };
const SKILL_WRITING = { drawer_id: "skill-writing", wing: SHARED_WING, room: "skills", desc: "A writing-domain skill" };
const SKILL_GENERAL = { drawer_id: "skill-general", wing: SHARED_WING, room: "skills", desc: "A general-domain skill" };

function makeClient({ sourceTypes = {}, sharedDrawers = [], domains = {}, callTracker, promotedFrom } = {}) {
  const client = {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async () => ({}),
    getLineageSources: async () => ({}),
    getLineageDerivatives: async () => ({}),
    listScopedDerivedDrawers: async () => ({ nodes: FIXTURE_NODES }),
    getClosetStatus: async () => "active",
    getClosetSourceType: async (id) => sourceTypes[id] ?? null,
    // Phase 12: es-domain reader. Absent id = unstamped legacy skill (null).
    getClosetDomain: async (id) => domains[id] ?? null,
    // P2-1: promoted-from provenance reader (shared skill -> origin project skill).
    // Only present when the fixture opts in — its absence simulates a client without
    // the capability. Absent id = no origin edge.
    ...(promotedFrom ? { getPromotedFrom: async (id) => { if (callTracker) callTracker.push({ name: "getPromotedFrom", id }); return { node_ids: promotedFrom[id] ?? [], count: (promotedFrom[id] ?? []).length }; } } : {}),
    getDrawer: async ({ drawer_id }) => {
      const row = sharedDrawers.find((d) => d.drawer_id === drawer_id);
      return row ? { ...row } : {};
    },
    listDrawers: async ({ wing, room, limit, offset }) => {
      if (callTracker) callTracker.push({ name: "listDrawers", wing, room });
      // Only the shared wing's skills room has drawers in these fixtures.
      if (wing === SHARED_WING && room === "skills") {
        return { drawers: sharedDrawers.slice(offset, offset + limit), total: sharedDrawers.length };
      }
      return { drawers: [], total: 0 };
    },
  };
  return client;
}

function ids(result) {
  return result.ranked_nodes.map((n) => n.node_id);
}

test("procedural intent + shared_wing admits a skill-stamped drawer from the shared wing (via: shared)", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["shared-skill-1"], `shared skill should be admitted: ${JSON.stringify(ids(result))}`);
  assert.equal(byId["shared-skill-1"].via, "shared");
  assert.equal(byId["shared-skill-1"].source_type, "skill");
  assert.equal(byId["shared-skill-1"].wing, SHARED_WING);

  // Envelope honesty.
  assert.ok(result.filters.shared_skills_expansion, "envelope must report the shared scan");
  assert.equal(result.filters.shared_skills_expansion.enabled, true);
  assert.equal(result.filters.shared_skills_expansion.wing, SHARED_WING);
  assert.equal(result.filters.shared_skills_expansion.room, "skills");
  assert.equal(result.filters.shared_skills_expansion.drawers_scanned, 1);
  assert.equal(result.filters.shared_skills_expansion.targets_admitted, 1);
  assert.deepEqual(result.seeds.shared_skill_ids, ["shared-skill-1"]);
});

test("factual intent NEVER calls listDrawers on the shared wing and admits no cross-wing node", async () => {
  const calls = [];
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    callTracker: calls,
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // No cross-wing node admitted.
  assert.ok(!byId["shared-skill-1"], "factual intent must not admit a shared-wing node");

  // The shared wing was never even listed.
  const sharedCalls = calls.filter((c) => c.wing === SHARED_WING);
  assert.equal(sharedCalls.length, 0, `factual intent must make zero shared-wing listDrawers calls: ${JSON.stringify(calls)}`);

  // No envelope entry for the shared scan.
  assert.equal(result.filters.shared_skills_expansion, undefined, "no shared_skills_expansion on factual intent");
});

test("historical intent NEVER calls listDrawers on the shared wing", async () => {
  const calls = [];
  const client = makeClient({
    sourceTypes: { "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    callTracker: calls,
  });

  await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "historical", shared_wing: SHARED_WING });
  const sharedCalls = calls.filter((c) => c.wing === SHARED_WING);
  assert.equal(sharedCalls.length, 0, "historical intent must make zero shared-wing listDrawers calls");
});

test("default intent (no intent set) NEVER calls listDrawers on the shared wing", async () => {
  const calls = [];
  const client = makeClient({
    sourceTypes: { "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    callTracker: calls,
  });

  await expandScopedRetrieval(client, { ...BASE_OPTIONS, shared_wing: SHARED_WING });
  const sharedCalls = calls.filter((c) => c.wing === SHARED_WING);
  assert.equal(sharedCalls.length, 0, "default intent must make zero shared-wing listDrawers calls");
});

test("an unstamped drawer in the shared room is NOT admitted even on procedural intent", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis" }, // no stamp for shared-unstamped
    sharedDrawers: [SHARED_UNSTAMPED],
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(!byId["shared-unstamped"], "unstamped drawer must not be admitted");
  assert.equal(result.filters.shared_skills_expansion.targets_admitted, 0);
});

test("a transcript-stamped drawer in the shared room is NOT admitted", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-transcript": "transcript" },
    sharedDrawers: [SHARED_TRANSCRIPT],
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(!byId["shared-transcript"], "transcript-stamped drawer must not be admitted");
});

test("a row claiming a different wing than the shared wing is dropped", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-wrong-wing": "skill" },
    sharedDrawers: [SHARED_WRONG_WING], // claims wing: projB, not shared-skills
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(!byId["shared-wrong-wing"], "a row claiming a foreign wing must be dropped");
});

test("a client without listDrawers degrades to pre-Phase-10 behavior (no shared scan)", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
  });
  delete client.listDrawers;

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(!byId["shared-skill-1"], "without listDrawers the shared scan cannot run");
  assert.equal(result.filters.shared_skills_expansion, undefined, "no envelope entry without the capability");
});

// ── Phase 12: es-domain filtering on shared-skill admission ─────────────────────
// A code request must admit code + general skills, exclude writing; an unknown
// requester admits only null/general; unstamped legacy skills stay admissible.

test("Phase 12: a code request admits code + general and excludes writing", async () => {
  const client = makeClient({
    sourceTypes: { "skill-code": "skill", "skill-writing": "skill", "skill-general": "skill" },
    sharedDrawers: [SKILL_CODE, SKILL_WRITING, SKILL_GENERAL],
    domains: { "skill-code": "code", "skill-writing": "writing", "skill-general": "general" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING, domain: "code" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["skill-code"], `code skill must be admitted for a code request: ${JSON.stringify(ids(result))}`);
  assert.ok(byId["skill-general"], "general skills are admitted to every domain");
  assert.ok(!byId["skill-writing"], "a writing skill must never surface in a code project");

  const filter = result.filters.shared_skills_expansion.domain_filter;
  assert.equal(filter.enabled, true);
  assert.equal(filter.requesting_domain, "code");
  assert.equal(filter.matched, 2);
  assert.equal(filter.filtered, 1);
});

test("Phase 12: a missing requester domain admits only general/unstamped skills", async () => {
  const client = makeClient({
    sourceTypes: { "skill-code": "skill", "skill-writing": "skill", "skill-general": "skill" },
    sharedDrawers: [SKILL_CODE, SKILL_WRITING, SKILL_GENERAL], // all stamped; none unstamped here
    domains: { "skill-code": "code", "skill-writing": "writing", "skill-general": "general" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(!byId["skill-code"], "a specific-domain skill is never surfaced to an unclassified project");
  assert.ok(!byId["skill-writing"], "same for writing");
  assert.ok(byId["skill-general"], "general is always admitted");

  const filter = result.filters.shared_skills_expansion.domain_filter;
  assert.equal(filter.requesting_domain, null);
  assert.equal(filter.matched, 1);
  assert.equal(filter.filtered, 2);
});

test("Phase 12: unstamped legacy skills remain admissible (null domain)", async () => {
  const client = makeClient({
    sourceTypes: { "skill-code": "skill", "shared-skill-1": "skill" },
    sharedDrawers: [SKILL_CODE, SHARED_SKILL], // SHARED_SKILL has no domain stamp
    domains: { "skill-code": "code" },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING, domain: "writing" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["shared-skill-1"], "an unstamped legacy skill is admitted to any requester");
  assert.ok(!byId["skill-code"], "a code skill is excluded from a writing request");

  const filter = result.filters.shared_skills_expansion.domain_filter;
  assert.equal(filter.requesting_domain, "writing");
  assert.equal(filter.matched, 1);
  assert.equal(filter.filtered, 1);
});

test("Phase 12: a client without getClosetDomain degrades to pre-Phase-12 admission", async () => {
  const client = makeClient({
    sourceTypes: { "skill-writing": "skill" },
    sharedDrawers: [SKILL_WRITING],
    domains: { "skill-writing": "writing" },
  });
  delete client.getClosetDomain;

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING, domain: "code" });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["skill-writing"], "without the reader there is no filter — pre-Phase-12 behavior");
  assert.equal(result.filters.shared_skills_expansion.domain_filter, undefined, "no domain_filter entry without the capability");
});

test("envelope reports truncated when the shared room exceeds one page", async () => {
  // Build 51 drawers so total > pageSize (50).
  const manyDrawers = Array.from({ length: 51 }, (_, i) => ({
    drawer_id: `shared-many-${i}`,
    wing: SHARED_WING,
    room: "skills",
    desc: `Skill ${i}`,
  }));
  const sourceTypes = {};
  for (const d of manyDrawers) sourceTypes[d.drawer_id] = "skill";

  const client = makeClient({ sourceTypes, sharedDrawers: manyDrawers });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });

  assert.ok(result.filters.shared_skills_expansion, "envelope must report the scan");
  assert.equal(result.filters.shared_skills_expansion.truncated, true, "51 drawers > 50 page size = truncated");
  assert.equal(result.filters.shared_skills_expansion.drawers_scanned, 50, "only one bounded page is scanned");
});

// ── P2-1: promoted-from provenance read on the shared-skill admission path ───────
// The reader (getPromotedFrom) must be called for admitted shared skills on procedural
// intent and its result must ride into node metadata + envelope WITHOUT changing
// ranking. It is not required anywhere else: non-procedural intents, other pool nodes,
// and clients without the capability never call it.

test("P2-1: getPromotedFrom is called for admitted shared skills and origin rides into node metadata", async () => {
  const calls = [];
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    callTracker: calls,
    promotedFrom: { "shared-skill-1": ["drawer_projA_skills_origin"] },
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  // The reader was called exactly once — for the admitted shared skill.
  const promotedCalls = calls.filter((c) => c.name === "getPromotedFrom");
  assert.equal(promotedCalls.length, 1, `getPromotedFrom must be called once for the admitted shared skill: ${JSON.stringify(calls)}`);
  assert.equal(promotedCalls[0].id, "shared-skill-1");

  // The origin rides into the node as metadata.
  assert.deepEqual(byId["shared-skill-1"].promoted_from, ["drawer_projA_skills_origin"]);

  // Envelope honesty for the provenance read.
  const pf = result.filters.shared_skills_expansion.promoted_from;
  assert.ok(pf, "envelope must report the promoted-from read");
  assert.equal(pf.enabled, true);
  assert.equal(pf.checked, 1);
  assert.equal(pf.with_origin, 1);
});

test("P2-1: promoted-from metadata does NOT change ranking or scores", async () => {
  const withOrigin = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    promotedFrom: { "shared-skill-1": ["drawer_projA_skills_origin"] },
  });
  const withoutOrigin = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    promotedFrom: {}, // reader present but no edge
  });

  const a = await expandScopedRetrieval(withOrigin, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const b = await expandScopedRetrieval(withoutOrigin, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });

  // Identical node set and order — provenance is metadata only.
  assert.deepEqual(ids(a), ids(b), "ranking must be identical with or without a promoted-from origin");
  const scoreA = Object.fromEntries(a.ranked_nodes.map((n) => [n.node_id, n.score]));
  const scoreB = Object.fromEntries(b.ranked_nodes.map((n) => [n.node_id, n.score]));
  assert.deepEqual(scoreA, scoreB, "scores must be identical with or without a promoted-from origin");

  // The only difference is the metadata field + envelope sub-block.
  const byIdA = Object.fromEntries(a.ranked_nodes.map((n) => [n.node_id, n]));
  const byIdB = Object.fromEntries(b.ranked_nodes.map((n) => [n.node_id, n]));
  assert.deepEqual(byIdA["shared-skill-1"].promoted_from, ["drawer_projA_skills_origin"]);
  assert.equal(byIdB["shared-skill-1"].promoted_from, undefined);
  const pfA = a.filters.shared_skills_expansion.promoted_from;
  const pfB = b.filters.shared_skills_expansion.promoted_from;
  assert.equal(pfA.checked, 1);
  assert.equal(pfA.with_origin, 1);
  assert.equal(pfB.checked, 1);
  assert.equal(pfB.with_origin, 0, "the read was attempted but found no origin");
});

test("P2-1: non-procedural intents never call getPromotedFrom", async () => {
  const calls = [];
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    callTracker: calls,
    promotedFrom: { "shared-skill-1": ["drawer_projA_skills_origin"] },
  });

  await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "factual", shared_wing: SHARED_WING });
  assert.equal(calls.filter((c) => c.name === "getPromotedFrom").length, 0, "factual intent must make zero getPromotedFrom calls");
});

test("P2-1: getPromotedFrom is never called for non-shared pool nodes", async () => {
  const calls = [];
  // A skill in the LOCAL (scoped) pool — not a shared-wing admission. The reader must
  // only run on the shared-skill admission path, not for arbitrary pool skills.
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    callTracker: calls,
    promotedFrom: { "local-synth": ["drawer_projA_skills_origin"] },
  });
  // Force a local skill into the scoped pool.
  client.listScopedDerivedDrawers = async () => ({
    nodes: [...FIXTURE_NODES, { node_id: "local-skill", labels: [], wing: "projA", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 }],
  });

  await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const promotedCalls = calls.filter((c) => c.name === "getPromotedFrom");
  assert.equal(promotedCalls.length, 1, `only the admitted shared skill may be checked: ${JSON.stringify(calls)}`);
  assert.equal(promotedCalls[0].id, "shared-skill-1", "the reader must not be called for non-shared pool nodes");
});

test("P2-1: a client without getPromotedFrom degrades to pre-P2-1 output (no metadata, no envelope entry)", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
    // No promotedFrom fixture -> client has no getPromotedFrom method.
  });

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["shared-skill-1"], "the skill is still admitted without the reader");
  assert.equal(byId["shared-skill-1"].promoted_from, undefined, "no promoted_from metadata without the capability");
  assert.equal(result.filters.shared_skills_expansion.promoted_from, undefined, "no envelope entry without the capability");
});

test("P2-1: a failing getPromotedFrom degrades to no origin (admission and ranking unchanged)", async () => {
  const client = makeClient({
    sourceTypes: { "local-synth": "synthesis", "shared-skill-1": "skill" },
    sharedDrawers: [SHARED_SKILL],
  });
  // Override with a reader that always throws — the read must degrade, never abort.
  client.getPromotedFrom = async () => { throw new Error("kg_query exploded"); };

  const result = await expandScopedRetrieval(client, { ...BASE_OPTIONS, intent: "procedural", shared_wing: SHARED_WING });
  const byId = Object.fromEntries(result.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(byId["shared-skill-1"], "a failing provenance read must not drop the skill");
  assert.equal(byId["shared-skill-1"].promoted_from, undefined, "failure degrades to no origin");
  // Envelope: checked=1 (the call was made), with_origin=0.
  const pf = result.filters.shared_skills_expansion.promoted_from;
  assert.ok(pf, "envelope must still report the read attempt");
  assert.equal(pf.checked, 1);
  assert.equal(pf.with_origin, 0);
});
