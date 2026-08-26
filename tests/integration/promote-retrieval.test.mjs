import assert from "node:assert/strict";
import test from "node:test";

import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";
import { runSkillPromotion, PROMOTED_FROM_PREDICATE } from "../../tools/promote_skill.ts";

/**
 * Integration coverage for Phase 10 (unified memory): the full promote -> read loop.
 * An explicit promotion (`runSkillPromotion`, dry-run then apply) files a shared copy
 * in the shared skills wing and writes a promoted-from edge into a shared in-memory
 * KG; a subsequent procedural-intent retrieval (`expandScopedRetrieval` with
 * shared_wing) reads the shared room back through listDrawers/getDrawer/
 * getClosetSourceType — showing the skill is INVISIBLE before promotion (no edges
 * into the querying project, no shared copy yet) and VISIBLE after (via: "shared").
 *
 * The transport is an in-memory KG + drawer store, not a live MemPalace: it exercises
 * the exact ElectricShepherd-owned code on both sides (promotion core + retrieval
 * adapter) with real edge semantics, without requiring ESHEPHERD_TEST_INTEGRATION.
 */

const ORIGIN = "drawer_projA_skills_origin";
const SHARED_WING = "shared-skills";
const CONTENT = "Goal: diagnose a caching regression.\n1. Reproduce.\n2. Check TTLs.";

function makeInMemoryPalace() {
  const edges = []; // { subject, predicate, object }
  const drawers = {}; // id -> { drawer_id, wing, room, content, desc }

  // The origin skill exists from the start, stamped es-source-type: skill (as an edge,
  // so kg_query for es-source-type returns it — mirroring a real palace stamp).
  drawers[ORIGIN] = { drawer_id: ORIGIN, wing: "projA", room: "skills", content: CONTENT, desc: "caching regression procedure" };
  const sourceTypes = {};
  sourceTypes[ORIGIN] = "skill";
  edges.push({ subject: ORIGIN, predicate: "es-source-type", object: "skill" });

  const call = async (name, payload) => {
    if (name === "get_taxonomy") return { taxonomy: { projA: { skills: 1 } } };
    if (name === "list_drawers") {
      const rows = Object.values(drawers).filter((d) => d.wing === payload.wing && d.room === payload.room);
      return { drawers: rows.slice(payload.offset, payload.offset + payload.limit), total: rows.length };
    }
    if (name === "get_drawer") {
      const row = drawers[payload.drawer_id];
      return row ? { ...row } : { error: `no drawer ${payload.drawer_id}` };
    }
    if (name === "check_duplicate") {
      // A duplicate exists iff ANOTHER drawer (not the origin being promoted) has
      // identical content. The real oracle excludes the source from its own match.
      const dup = Object.values(drawers).find((d) => d.content === payload.content && d.drawer_id !== ORIGIN);
      return dup ? { is_duplicate: true, drawer_id: dup.drawer_id } : { is_duplicate: false };
    }
    if (name === "kg_query") {
      const entity = String(payload.entity || "");
      const predicate = String(payload.predicate || "");
      const direction = String(payload.direction || "outgoing");
      // Match on subject for outgoing, on object for incoming — mirroring the real
      // kg_query direction semantics (a promoted-from edge is shared -> origin, so it
      // is INCOMING to the origin).
      const facts = edges
        .filter((e) => e.predicate === predicate && e.current !== false)
        .filter((e) => (direction === "incoming" ? e.object === entity : e.subject === entity))
        .map((e) => ({ subject: e.subject, predicate: e.predicate, object: e.object, current: true }));
      return { facts };
    }
    if (name === "add_drawer") {
      const id = `drawer_${payload.wing}_${payload.room}_new`;
      drawers[id] = { drawer_id: id, wing: payload.wing, room: payload.room, content: payload.content, desc: "promoted skill" };
      sourceTypes[id] = undefined; // stamped separately via kg_add below
      return { drawer_id: id };
    }
    if (name === "kg_add") {
      edges.push({ ...payload });
      if (payload.predicate === "es-source-type") sourceTypes[payload.subject] = payload.object;
      return {};
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
      // The querying project's local pool — the origin skill is NOT in it (it lives
      // in projA/skills, a different room than the scope_room below).
      nodes: [
        { node_id: "local-synth", labels: [], wing: "projB", room: "unit-room", desc: "d", height: 1, retrieval_count: 0, connection_degree: 0, lineage_match_count: 0 },
      ],
    }),
    getClosetStatus: async () => "active",
    getClosetSourceType: async (id) => sourceTypes[id] ?? null,
    getDrawer: async ({ drawer_id }) => {
      const row = drawers[drawer_id];
      return row ? { ...row } : {};
    },
    listDrawers: async ({ wing, room, limit, offset }) => {
      const rows = Object.values(drawers).filter((d) => d.wing === wing && d.room === room);
      return { drawers: rows.slice(offset, offset + limit), total: rows.length };
    },
  };

  return { call, client, edges, drawers, sourceTypes };
}

const RETRIEVAL_OPTIONS = { query: "how do I diagnose a caching regression", scope_room: "unit-room", top_n: 10, intent: "procedural", shared_wing: SHARED_WING };

test("promote -> retrieval: a promoted skill is invisible before, visible after (via: shared)", async () => {
  const kg = makeInMemoryPalace();

  // 1. BEFORE promotion: the origin skill has no edges into projB and no shared copy
  //    exists — procedural retrieval from projB must NOT surface it.
  const before = await expandScopedRetrieval(kg.client, RETRIEVAL_OPTIONS);
  const beforeIds = before.ranked_nodes.map((n) => n.node_id);
  assert.ok(!beforeIds.includes(ORIGIN), `origin must be invisible before promotion: ${JSON.stringify(beforeIds)}`);
  // The shared room is empty, so the scan reports zero admissions.
  assert.equal(before.filters.shared_skills_expansion.targets_admitted, 0);

  // 2. Operator promotes: dry-run first (no writes), then explicit apply.
  const edgesBeforeDryRun = kg.edges.length; // includes the pre-seeded origin stamp
  const preview = await runSkillPromotion({ call: kg.call, skillId: ORIGIN, sharedWing: SHARED_WING, dryRun: true });
  assert.equal(preview.dry_run, true);
  assert.equal(kg.edges.length, edgesBeforeDryRun, "dry-run must write nothing");

  const applied = await runSkillPromotion({ call: kg.call, skillId: ORIGIN, sharedWing: SHARED_WING, dryRun: false });
  assert.equal(applied.ok, true);
  assert.ok(applied.drawer_id, "apply must return the shared drawer id");
  const sharedId = applied.drawer_id;

  // The promoted-from edge is in place (shared -> origin). Filter to this predicate —
  // the pre-seeded origin stamp is an es-source-type edge, not a promoted-from one.
  const edge = kg.edges.find((e) => e.predicate === PROMOTED_FROM_PREDICATE);
  assert.ok(edge, `a ${PROMOTED_FROM_PREDICATE} edge must exist`);
  assert.equal(edge.subject, sharedId);
  assert.equal(edge.object, ORIGIN);

  // The shared copy is stamped es-source-type: skill.
  assert.equal(kg.sourceTypes[sharedId], "skill", "shared copy must be skill-stamped");

  // 3. AFTER promotion: procedural retrieval from projB now surfaces the shared copy.
  const after = await expandScopedRetrieval(kg.client, RETRIEVAL_OPTIONS);
  const afterById = Object.fromEntries(after.ranked_nodes.map((n) => [n.node_id, n]));

  assert.ok(afterById[sharedId], `promoted skill must be visible after: ${JSON.stringify(Object.keys(afterById))}`);
  assert.equal(afterById[sharedId].via, "shared");
  assert.equal(afterById[sharedId].source_type, "skill");
  assert.equal(afterById[sharedId].wing, SHARED_WING);

  // Envelope honesty: the scan now reports one admission.
  assert.equal(after.filters.shared_skills_expansion.targets_admitted, 1);
  assert.deepEqual(after.seeds.shared_skill_ids, [sharedId]);

  console.log(
    `[worked-example] promote->retrieval: before=${beforeIds.length} nodes (no shared), after=${after.ranked_nodes.length} nodes ` +
      `(shared ${sharedId} admitted via=shared, score=${afterById[sharedId].score.toFixed(6)})`
  );
});

test("promote is idempotent across the retrieval loop: a second apply writes nothing", async () => {
  const kg = makeInMemoryPalace();

  await runSkillPromotion({ call: kg.call, skillId: ORIGIN, sharedWing: SHARED_WING, dryRun: false });
  const edgesAfterFirst = kg.edges.length;
  const drawersAfterFirst = Object.keys(kg.drawers).length;

  // A second apply (e.g. the operator re-runs after a partial failure) must be a no-op.
  const second = await runSkillPromotion({ call: kg.call, skillId: ORIGIN, sharedWing: SHARED_WING, dryRun: false });
  assert.equal(second.ok, true);
  assert.ok(second.already_promoted_to, "second apply must report the existing shared copy");
  assert.equal(kg.edges.length, edgesAfterFirst, "no new edge on re-apply");
  assert.equal(Object.keys(kg.drawers).length, drawersAfterFirst, "no new drawer on re-apply");
});
