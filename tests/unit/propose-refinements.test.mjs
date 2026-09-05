import assert from "node:assert/strict";
import test from "node:test";

import { runRefinementProposal, REFINED_BY_PREDICATE } from "../../src/tools/propose_refinements.ts";

/**
 * Phase 5 (unified memory): the `propose_refinements` core (`runRefinementProposal`)
 * against a fake MCP transport — no network. Proves:
 *   1. dry-run makes NO kg_add and returns a preview with proposed edges + next_step;
 *   2. endpoint validation rejects non-skill subjects (missing drawer or wrong stamp)
 *      on both preview and apply;
 *   3. evidence drawers must EXIST but need no es-source-type — unstamped session
 *      notes, transcripts, syntheses, and apprenticeship drawers all pass;
 *   4. self-links are rejected; duplicate existing refined-by edges are skipped (idempotent);
 *   5. apply adds only approved/valid edges, one kg_add per edge with source_closet provenance;
 *   6. per-edge add failures are isolated and counted, never abort the batch;
 *   7. es-status is never touched by any path.
 */

const SKILL = "drawer_proj_skills_ingest_docs";
const SESSION_A = "drawer_proj_source-transcripts_sess_a";
const SYNTH_B = "drawer_proj_synth_b";
const APPRENTICE_C = "drawer_proj_apprenticeship_c";
const GHOST = "drawer_proj_ghost_missing";

function fact(subject, predicate, object, current = true) {
  return { subject, predicate, object, current };
}

/**
 * Fake palace. `types` maps id -> es-source-type value (absent = unstamped);
 * `existingRefinedBy` = already-linked evidence ids on the skill;
 * `failKgAddFor` = set of evidence ids whose kg_add throws.
 * Every id in `drawers` exists as a drawer; GHOST never does.
 */
function makeFakePalace({ types = {}, existingRefinedBy = [], failKgAddFor = new Set() } = {}) {
  const drawers = new Set([SKILL, SESSION_A, SYNTH_B, APPRENTICE_C]);
  const calls = [];
  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "kg_query") {
      const entity = String(payload.entity || "");
      const predicate = String(payload.predicate || "");
      if (predicate === REFINED_BY_PREDICATE && entity === SKILL) {
        return { facts: existingRefinedBy.map((id) => fact(SKILL, REFINED_BY_PREDICATE, id)) };
      }
      if (predicate === "es-source-type") {
        const value = types[entity];
        return { facts: value ? [fact(entity, "es-source-type", value)] : [] };
      }
      return { facts: [] };
    }
    if (name === "get_drawer") {
      const id = String(payload.drawer_id || "");
      if (!drawers.has(id)) return { error: `no drawer ${id}` };
      return { drawer_id: id, desc: `desc of ${id}`, room: id.split("_")[3] };
    }
    if (name === "kg_add") {
      if (failKgAddFor.has(String(payload.object))) throw new Error(`kg_add failed for ${payload.object}`);
      return {};
    }
    return {};
  };
  return { call, calls };
}

const skillStamped = () => ({ [SKILL]: "skill" });

test("dry-run makes zero kg_add calls and returns a preview with proposed edges", async () => {
  const fake = makeFakePalace({ types: skillStamped() });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [SESSION_A, SYNTH_B], dryRun: true });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.deepEqual(
    fake.calls.filter((c) => c.name === "kg_add"),
    [],
    "dry-run must not write any KG edge"
  );
  assert.equal(report.edges.length, 2);
  for (const edge of report.edges) {
    assert.equal(edge.status, "proposed");
    assert.deepEqual(edge.proposed_edge, { subject: SKILL, predicate: REFINED_BY_PREDICATE, object: edge.evidence_id });
  }
  assert.equal(report.counts.proposed, 2);
  assert.match(report.next_step, /dry_run:false/);
});

test("subject without es-source-type: skill is rejected (unstamped and wrong-type), preview and apply", async () => {
  const unstamped = makeFakePalace({ types: {} });
  const preview = await runRefinementProposal({ call: unstamped.call, skillId: SKILL, evidenceIds: [SESSION_A], dryRun: true });
  assert.equal(preview.edges[0].status, "rejected-not-skill");
  assert.match(preview.edges[0].reason, /unknown/);

  const wrongType = makeFakePalace({ types: { [SKILL]: "doc" } });
  const apply = await runRefinementProposal({ call: wrongType.call, skillId: SKILL, evidenceIds: [SESSION_A], dryRun: false });
  assert.equal(apply.edges[0].status, "rejected-not-skill");
  assert.match(apply.edges[0].reason, /doc/);
  assert.equal(apply.counts.added, 0);
  assert.equal(wrongType.calls.filter((c) => c.name === "kg_add").length, 0);
});

test("subject drawer that does not exist is rejected as not-a-skill", async () => {
  const fake = makeFakePalace({ types: skillStamped() });
  const report = await runRefinementProposal({ call: fake.call, skillId: GHOST, evidenceIds: [SESSION_A], dryRun: true });
  assert.equal(report.edges[0].status, "rejected-not-skill");
  assert.match(report.edges[0].reason, /does not exist/);
});

test("evidence must exist but needs no es-source-type — unstamped/transcript/synthesis/apprenticeship all pass", async () => {
  // No types at all on the evidence side: SESSION_A (unstamped), SYNTH_B, APPRENTICE_C.
  const fake = makeFakePalace({ types: skillStamped() });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [SESSION_A, SYNTH_B, APPRENTICE_C], dryRun: true });
  for (const edge of report.edges) {
    assert.equal(edge.status, "proposed", `evidence ${edge.evidence_id} should pass with no stamp`);
  }

  // A transcript-stamped session is fine too.
  const stamped = makeFakePalace({ types: { ...skillStamped(), [SESSION_A]: "transcript" } });
  const report2 = await runRefinementProposal({ call: stamped.call, skillId: SKILL, evidenceIds: [SESSION_A], dryRun: true });
  assert.equal(report2.edges[0].status, "proposed");
});

test("nonexistent evidence drawer is rejected as missing", async () => {
  const fake = makeFakePalace({ types: skillStamped() });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [GHOST], dryRun: true });
  assert.equal(report.edges[0].status, "rejected-evidence-missing");
  assert.match(report.edges[0].reason, /does not exist/);
});

test("self-link is rejected", async () => {
  const fake = makeFakePalace({ types: skillStamped() });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [SKILL], dryRun: true });
  assert.equal(report.edges[0].status, "rejected-self-link");
});

test("duplicate existing refined-by edge is skipped (idempotent re-apply)", async () => {
  const fake = makeFakePalace({ types: skillStamped(), existingRefinedBy: [SESSION_A] });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [SESSION_A, SYNTH_B], dryRun: false });

  assert.equal(report.edges[0].status, "skipped-duplicate");
  assert.equal(report.edges[1].status, "added");
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 1);
});

test("apply adds only valid edges with source_closet provenance and never touches es-status", async () => {
  const fake = makeFakePalace({ types: skillStamped() });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [SESSION_A, APPRENTICE_C], dryRun: false });

  assert.equal(report.dry_run, false);
  assert.equal(report.counts.added, 2);
  const adds = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(adds.length, 2);
  for (const add of adds) {
    assert.equal(add.args.subject, SKILL);
    assert.equal(add.args.predicate, REFINED_BY_PREDICATE);
    assert.equal(add.args.source_closet, SKILL);
    assert.notEqual(add.args.predicate, "es-status", "refined-by must never touch es-status");
  }
  assert.ok(adds.some((a) => a.args.object === SESSION_A));
  assert.ok(adds.some((a) => a.args.object === APPRENTICE_C));
});

test("per-edge add failure is isolated and counted, never aborts the batch", async () => {
  const fake = makeFakePalace({ types: skillStamped(), failKgAddFor: new Set([SESSION_A]) });
  const report = await runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [SESSION_A, SYNTH_B], dryRun: false });

  assert.equal(report.edges[0].status, "add-failed");
  assert.match(report.edges[0].error, /kg_add failed/);
  assert.equal(report.edges[1].status, "added");
  assert.equal(report.counts.added, 1);
  assert.equal(report.counts.add_failed, 1);
  assert.match(report.next_step, /retry/);
});

test("requires skill_id and at least one evidence_id", async () => {
  const fake = makeFakePalace({ types: skillStamped() });
  await assert.rejects(() => runRefinementProposal({ call: fake.call, skillId: "", evidenceIds: [SESSION_A] }), /skill_id is required/);
  await assert.rejects(() => runRefinementProposal({ call: fake.call, skillId: SKILL, evidenceIds: [] }), /evidence_id is required/);
});
