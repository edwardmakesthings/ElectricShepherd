import assert from "node:assert/strict";
import test from "node:test";

import { runConcernProposal } from "../../tools/propose_concerns.ts";

/**
 * Phase 4 (unified memory): the `propose_concerns` core (`runConcernProposal`) against a
 * fake MCP transport — no network. Proves:
 *   1. dry-run makes NO kg_add and returns a preview with proposed edges + next_step;
 *   2. endpoint validation rejects non-synthesis subjects (no synthesized-from lineage)
 *      and non-doc targets (es-source-type !== doc);
 *   3. self-links are rejected; duplicate existing concerns edges are skipped (idempotent);
 *   4. apply adds only approved/valid edges, one kg_add per edge with source_closet provenance;
 *   5. per-edge add failures are isolated and counted, never abort the batch.
 */

const SYNTH = "drawer_proj_synth_abc";
const DOC_A = "drawer_proj_reference_doc_a";
const DOC_B = "drawer_proj_reference_doc_b";
const NOT_A_DOC = "drawer_proj_notes_x";

function fact(subject, predicate, object, current = true) {
  return { subject, predicate, object, current };
}

/**
 * Fake palace. `lineage` = outgoing synthesized-from objects of the synthesis;
 * `types` maps id -> es-source-type value (absent = unstamped);
 * `existingConcerns` = already-linked doc ids on the synthesis;
 * `failKgAddFor` = set of doc ids whose kg_add throws.
 */
function makeFakePalace({ lineage = [], types = {}, existingConcerns = [], failKgAddFor = new Set() } = {}) {
  const calls = [];
  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "kg_query") {
      const entity = String(payload.entity || "");
      const predicate = String(payload.predicate || "");
      if (predicate === "synthesized-from" && entity === SYNTH) {
        return { facts: lineage.map((id) => fact(entity, "synthesized-from", id)) };
      }
      if (predicate === "concerns" && entity === SYNTH) {
        return { facts: existingConcerns.map((id) => fact(entity, "concerns", id)) };
      }
      if (predicate === "es-source-type") {
        const value = types[entity];
        return { facts: value ? [fact(entity, "es-source-type", value)] : [] };
      }
      return { facts: [] };
    }
    if (name === "get_drawer") {
      const id = String(payload.drawer_id || "");
      if (id === DOC_A) return { drawer_id: id, wing: "proj", room: "reference", desc: "Gateway API reference" };
      if (id === DOC_B) return { drawer_id: id, wing: "proj", room: "reference", desc: "Auth flow doc" };
      return { drawer_id: id, wing: "proj", room: "notes", desc: "scratch note" };
    }
    if (name === "kg_add") {
      if (failKgAddFor.has(String(payload.object))) throw new Error(`kg_add failed for ${payload.object}`);
      return {};
    }
    return {};
  };
  return { call, calls };
}

test("dry-run makes zero kg_add calls and returns a preview with proposed edges", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: { [DOC_A]: "doc", [DOC_B]: "doc" } });
  const report = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A, DOC_B], dryRun: true });

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
    assert.deepEqual(edge.proposed_edge, { subject: SYNTH, predicate: "concerns", object: edge.doc_id });
  }
  assert.equal(report.counts.proposed, 2);
  assert.match(report.next_step, /dry_run:false/);
});

test("subject without synthesized-from lineage is rejected as not-a-synthesis (preview and apply)", async () => {
  const fake = makeFakePalace({ lineage: [], types: { [DOC_A]: "doc" } });

  const preview = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A], dryRun: true });
  assert.equal(preview.edges[0].status, "rejected-not-synthesis");
  assert.match(preview.edges[0].reason, /synthesized-from/);

  const apply = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A], dryRun: false });
  assert.equal(apply.edges[0].status, "rejected-not-synthesis");
  assert.equal(apply.counts.added, 0);
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 0);
});

test("target without es-source-type: doc is rejected (unstamped and wrong-type)", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: { [NOT_A_DOC]: "transcript" } }); // DOC unstamped
  const report = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A, NOT_A_DOC], dryRun: true });

  assert.equal(report.edges[0].status, "rejected-not-doc");
  assert.match(report.edges[0].reason, /unknown/);
  assert.equal(report.edges[1].status, "rejected-not-doc");
  assert.match(report.edges[1].reason, /transcript/);
  assert.equal(report.counts.rejected, 2);
});

test("self-link is rejected", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: { [SYNTH]: "doc" } });
  const report = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [SYNTH], dryRun: true });
  assert.equal(report.edges[0].status, "rejected-self-link");
});

test("duplicate existing concerns edge is skipped (idempotent re-apply)", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: { [DOC_A]: "doc", [DOC_B]: "doc" }, existingConcerns: [DOC_A] });
  const report = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A, DOC_B], dryRun: false });

  assert.equal(report.edges[0].status, "skipped-duplicate");
  assert.equal(report.edges[1].status, "added");
  assert.equal(fake.calls.filter((c) => c.name === "kg_add").length, 1);
});

test("apply adds only valid edges with source_closet provenance", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: { [DOC_A]: "doc", [DOC_B]: "doc" } });
  const report = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A, DOC_B], dryRun: false });

  assert.equal(report.dry_run, false);
  assert.equal(report.counts.added, 2);
  const adds = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(adds.length, 2);
  for (const add of adds) {
    assert.equal(add.args.subject, SYNTH);
    assert.equal(add.args.predicate, "concerns");
    assert.equal(add.args.source_closet, SYNTH);
  }
  assert.ok(adds.some((a) => a.args.object === DOC_A));
  assert.ok(adds.some((a) => a.args.object === DOC_B));
});

test("per-edge add failure is isolated and counted, never aborts the batch", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: { [DOC_A]: "doc", [DOC_B]: "doc" }, failKgAddFor: new Set([DOC_A]) });
  const report = await runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [DOC_A, DOC_B], dryRun: false });

  assert.equal(report.edges[0].status, "add-failed");
  assert.match(report.edges[0].error, /kg_add failed/);
  assert.equal(report.edges[1].status, "added");
  assert.equal(report.counts.added, 1);
  assert.equal(report.counts.add_failed, 1);
  assert.match(report.next_step, /retry/);
});

test("requires synthesis_id and at least one doc_id", async () => {
  const fake = makeFakePalace({ lineage: ["src1"], types: {} });
  await assert.rejects(() => runConcernProposal({ call: fake.call, synthesisId: "", docIds: [DOC_A] }), /synthesis_id is required/);
  await assert.rejects(() => runConcernProposal({ call: fake.call, synthesisId: SYNTH, docIds: [] }), /doc_id is required/);
});
