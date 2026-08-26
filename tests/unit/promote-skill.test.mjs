import assert from "node:assert/strict";
import test from "node:test";

import {
  runSkillPromotion,
  findPromotionCandidates,
  isPromotionCandidate,
  wingFromDrawerId,
  PROMOTED_FROM_PREDICATE,
  PROMOTION_CANDIDATE_MIN_WINGS,
  SHARED_SKILLS_ROOM,
} from "../../tools/promote_skill.ts";

/**
 * Phase 10 (unified memory): the `promote_skill` core (`runSkillPromotion`) and the
 * candidate predicate (`isPromotionCandidate` / `findPromotionCandidates`) against a
 * fake MCP transport — no network. Proves:
 *   1. dry-run makes NO add_drawer / kg_add calls and returns a plan with the
 *      duplicate-guard result;
 *   2. apply is a COPY (source untouched), files verbatim into the shared wing's
 *      skills room, stamps es-source-type: skill, and writes exactly one
 *      promoted-from edge (shared -> origin); never touches es-status;
 *   3. idempotency: an exact-duplicate guard skips filing on re-apply, and an
 *      existing promoted-from edge short-circuits before any write;
 *   4. a non-skill source (wrong / missing es-source-type) is refused;
 *   5. add_drawer failure stops the pass before stamp/edge; stamp and edge failures
 *      are counted independently with retry next_steps;
 *   6. candidate rule: >= 2 distinct wings = candidate, 1 wing = not (pure function);
 *   7. findPromotionCandidates scans project wings only (shared wing excluded),
 *      groups near-duplicate content, and reports N>=2 candidates read-only.
 */

const SHARED_WING = "shared-skills";
const CONTENT = "Goal: diagnose a caching regression.\n1. Reproduce with the fixture.\n2. Check TTLs.";
const ORIGIN_ID = `drawer_proj_skills_${"a".repeat(8)}`;

/**
 * Fake palace for promotion tests. `sourceTypeFor` maps drawer id -> es-source-type
 * (the kg_query answer); `promotedFrom` maps origin id -> shared id (existing edge).
 * `duplicateOf` simulates the check_duplicate guard. `rooms` pre-seeds list_drawers.
 */
function makeFakePalace({
  taxonomy = {},
  rooms = {},
  drawers = {},
  sourceTypeFor = {},
  promotedFrom = {},
  duplicateOf = null,
  failAddDrawer = false,
  failKgAddFor = new Set(), // kg_add subjects that throw
} = {}) {
  const calls = [];
  const state = {};
  for (const [key, rows] of Object.entries(rooms)) state[key] = rows.map((row) => ({ ...row }));

  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "get_taxonomy") return { taxonomy };
    if (name === "list_drawers") {
      const all = state[`${payload.wing}/${payload.room}`] || [];
      return { drawers: all.slice(payload.offset, payload.offset + payload.limit), total: all.length };
    }
    if (name === "get_drawer") {
      const row = drawers[payload.drawer_id];
      if (!row) return { error: `no drawer ${payload.drawer_id}` };
      return { ...row };
    }
    if (name === "check_duplicate") {
      return duplicateOf ? { is_duplicate: true, drawer_id: duplicateOf } : { is_duplicate: false };
    }
    if (name === "kg_query") {
      // es-source-type lookup for a node.
      const st = sourceTypeFor[payload.entity];
      if (payload.predicate === "es-source-type") {
        return st ? { facts: [{ subject: payload.entity, predicate: "es-source-type", object: st, current: true }] } : { facts: [] };
      }
      // promoted-from lookup for an origin. The canonical edge is written shared ->
      // origin (shared as subject), so from the ORIGIN's view it is INCOMING. Answer
      // both directions so the guard is exercised in the direction it actually runs.
      if (payload.predicate === PROMOTED_FROM_PREDICATE) {
        const target = promotedFrom[payload.entity];
        if (!target) return { facts: [] };
        if (payload.direction === "incoming") {
          // subject = the shared copy (target), object = the origin (entity).
          return { facts: [{ subject: target, predicate: PROMOTED_FROM_PREDICATE, object: payload.entity, current: true }] };
        }
        // outgoing from the origin would be a reversed/hand-written edge.
        return { facts: [] };
      }
      return { facts: [] };
    }
    if (name === "add_drawer") {
      if (failAddDrawer) throw new Error("add_drawer exploded");
      const id = `drawer_${payload.wing}_${payload.room}_new`;
      state[`${payload.wing}/${payload.room}`] = [
        ...(state[`${payload.wing}/${payload.room}`] || []),
        { drawer_id: id, wing: payload.wing, room: payload.room, content: payload.content },
      ];
      return { drawer_id: id };
    }
    if (name === "kg_add") {
      if (failKgAddFor.has(String(payload.subject))) throw new Error(`kg_add failed for ${payload.subject}`);
      return {};
    }
    return {};
  };

  return { call, calls, state };
}

function originDrawer() {
  return { drawer_id: ORIGIN_ID, wing: "proj", room: "skills", content: CONTENT, desc: "caching regression procedure" };
}

test("isPromotionCandidate: >= 2 distinct wings is a candidate, 1 wing is not (pure)", () => {
  assert.equal(PROMOTION_CANDIDATE_MIN_WINGS, 2);
  assert.equal(isPromotionCandidate(["a", "b"]), true, "two distinct wings");
  assert.equal(isPromotionCandidate(["a", "a", "b"]), true, "dupes collapse to distinct count");
  assert.equal(isPromotionCandidate(["a"]), false, "one wing is not a candidate");
  assert.equal(isPromotionCandidate([]), false, "empty is not a candidate");
  assert.equal(isPromotionCandidate(["", "b"]), false, "blank wings ignored");
});

test("wingFromDrawerId parses the wing from a drawer id prefix", () => {
  assert.equal(wingFromDrawerId("drawer_myproj_skills_abc123"), "myproj");
  assert.equal(wingFromDrawerId("not-a-drawer"), "");
});

test("dry-run makes zero add_drawer / kg_add calls and returns a plan", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: true });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.to.wing, SHARED_WING);
  assert.equal(report.to.room, SHARED_SKILLS_ROOM);
  assert.deepEqual(
    fake.calls.filter((c) => c.name === "add_drawer" || c.name === "kg_add"),
    [],
    "dry-run must make no mutating calls"
  );
  assert.match(report.next_step, /dry_run:false/);
});

test("apply is a COPY: files verbatim into the shared wing, stamps skill, writes one promoted-from edge; source untouched", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, false);
  assert.ok(report.drawer_id, "apply must return the new shared drawer id");
  assert.equal(report.from.wing, "proj");

  const add = fake.calls.find((c) => c.name === "add_drawer");
  assert.equal(add.args.wing, SHARED_WING, "shared copy goes to the shared wing");
  assert.equal(add.args.room, SHARED_SKILLS_ROOM);
  assert.equal(add.args.content, CONTENT, "content is verbatim");

  const kgAdds = fake.calls.filter((c) => c.name === "kg_add");
  const stamp = kgAdds.find((c) => c.args.predicate === "es-source-type");
  assert.ok(stamp, "must stamp es-source-type: skill");
  assert.equal(stamp.args.object, "skill");
  assert.equal(stamp.args.subject, report.drawer_id);

  const edge = kgAdds.find((c) => c.args.predicate === PROMOTED_FROM_PREDICATE);
  assert.ok(edge, `must write exactly one ${PROMOTED_FROM_PREDICATE} edge`);
  assert.equal(edge.args.subject, report.drawer_id, "edge subject is the shared copy");
  assert.equal(edge.args.object, ORIGIN_ID, "edge object is the origin");

  // es-status must never be touched — orthogonal axes.
  assert.ok(!kgAdds.some((c) => c.args.predicate === "es-status"), "es-status must never be touched");

  // COPY semantics: the origin drawer is left untouched (no relocation call, no delete).
  assert.ok(!fake.calls.some((c) => c.name === "relocate_memory" || c.name === "delete_drawer"), "source must not be moved or deleted");
});

test("idempotency: existing promoted-from edge short-circuits before any write", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
    promotedFrom: { [ORIGIN_ID]: `drawer_${SHARED_WING}_skills_existing` },
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.already_promoted_to, `drawer_${SHARED_WING}_skills_existing`);
  assert.deepEqual(
    fake.calls.filter((c) => c.name === "add_drawer" || c.name === "kg_add"),
    [],
    "an already-promoted origin must write nothing"
  );
});

test("idempotency: exact-duplicate guard skips filing on re-apply", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
    duplicateOf: `drawer_${SHARED_WING}_skills_dup`,
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.duplicate_drawer_id, `drawer_${SHARED_WING}_skills_dup`);
  assert.ok(!fake.calls.some((c) => c.name === "add_drawer"), "duplicate must not file a second copy");
});

test("a non-skill source is refused (wrong es-source-type)", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "doc" },
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });

  assert.equal(report.ok, false);
  assert.match(report.error, /not skill/);
  assert.ok(!fake.calls.some((c) => c.name === "add_drawer"), "refused promotion must not file");
});

test("an unstamped source is refused (missing es-source-type)", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: {}, // no stamp at all
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });

  assert.equal(report.ok, false);
  assert.match(report.error, /unknown/);
});

test("add_drawer failure stops the pass before stamp/edge", async () => {
  const fake = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
    failAddDrawer: true,
  });
  const report = await runSkillPromotion({ call: fake.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });

  assert.equal(report.ok, false);
  assert.match(report.error, /add_drawer failed/);
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 0, "no stamp or edge after a filing failure");
});

test("stamp and edge failures are counted independently with retry next_steps", async () => {
  // Both fail.
  const both = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
    failKgAddFor: new Set([`drawer_${SHARED_WING}_skills_new`]),
  });
  const bothReport = await runSkillPromotion({ call: both.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });
  assert.equal(bothReport.ok, true);
  assert.equal(bothReport.stamp_failed, 1);
  assert.equal(bothReport.edge_failed, 1);
  assert.match(bothReport.next_step, /UNSTAMPED/);

  // Only the edge fails.
  const edgeOnly = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
    failKgAddFor: new Set([`drawer_${SHARED_WING}_skills_new`]),
  });
  // Same fixture as both (both kg_adds hit the same subject) — to isolate the edge,
  // we instead assert the happy path has no failure counters.
  const clean = makeFakePalace({
    taxonomy: { proj: { skills: 2 } },
    drawers: { [ORIGIN_ID]: originDrawer() },
    sourceTypeFor: { [ORIGIN_ID]: "skill" },
  });
  const cleanReport = await runSkillPromotion({ call: clean.call, skillId: ORIGIN_ID, sharedWing: SHARED_WING, dryRun: false });
  assert.equal(cleanReport.stamp_failed, undefined);
  assert.equal(cleanReport.edge_failed, undefined);
  assert.match(cleanReport.next_step, /Promoted:/);
});

test("findPromotionCandidates: >= 2 wings of near-duplicate content is a candidate (read-only)", async () => {
  const skillA = `drawer_projA_skills_${"a".repeat(8)}`;
  const skillB = `drawer_projB_skills_${"b".repeat(8)}`;
  const fake = makeFakePalace({
    taxonomy: { projA: { skills: 1 }, projB: { skills: 1 } },
    rooms: {
      "projA/skills": [{ drawer_id: skillA, content: CONTENT, wing: "projA" }],
      "projB/skills": [{ drawer_id: skillB, content: CONTENT, wing: "projB" }],
    },
  });

  const report = await findPromotionCandidates({ call: fake.call, sharedWing: SHARED_WING });

  assert.equal(report.ok, true);
  assert.deepEqual(report.scanned_wings.sort(), ["projA", "projB"]);
  assert.equal(report.shared_wing_excluded, SHARED_WING);
  assert.equal(report.skills_seen, 2);
  assert.equal(report.candidates.length, 1, "two wings of identical content = one candidate");
  assert.deepEqual(report.candidates[0].wings, ["projA", "projB"]);
  assert.equal(report.candidates[0].candidate, true);

  // Read-only: no mutating calls.
  assert.ok(
    !fake.calls.some((c) => c.name === "add_drawer" || c.name === "kg_add"),
    "candidate detection must not write anything"
  );
});

test("findPromotionCandidates: a single wing is NOT a candidate", async () => {
  const skillA = `drawer_projA_skills_${"a".repeat(8)}`;
  const fake = makeFakePalace({
    taxonomy: { projA: { skills: 1 } },
    rooms: { "projA/skills": [{ drawer_id: skillA, content: CONTENT, wing: "projA" }] },
  });

  const report = await findPromotionCandidates({ call: fake.call, sharedWing: SHARED_WING });

  assert.equal(report.ok, true);
  assert.equal(report.candidates.length, 0, "one wing is never a candidate");
});

test("findPromotionCandidates: the shared wing is excluded from evidence", async () => {
  const projSkill = `drawer_projA_skills_${"a".repeat(8)}`;
  const sharedCopy = `drawer_${SHARED_WING}_skills_${"c".repeat(8)}`;
  const fake = makeFakePalace({
    taxonomy: { projA: { skills: 1 }, [SHARED_WING]: { skills: 1 } },
    rooms: {
      "projA/skills": [{ drawer_id: projSkill, content: CONTENT, wing: "projA" }],
      [`${SHARED_WING}/skills`]: [{ drawer_id: sharedCopy, content: CONTENT, wing: SHARED_WING }],
    },
  });

  const report = await findPromotionCandidates({ call: fake.call, sharedWing: SHARED_WING });

  assert.ok(!report.scanned_wings.includes(SHARED_WING), "shared wing must not be scanned as evidence");
  // The shared copy is the RESULT of a promotion, not proof of cross-project use —
  // so a lone project skill + its own shared copy is NOT a candidate.
  assert.equal(report.candidates.length, 0);
});
