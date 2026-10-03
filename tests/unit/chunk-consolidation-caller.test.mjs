import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { countDirectSources } from "../../src/capability/episodic/closet-status.ts";
import { discoverSourceChunks } from "../../src/scripts/memory-pipeline/chunk-consolidation.ts";
import { logicalParentDrawerId } from "../../src/core/drawer-metadata.ts";

const parent = "drawer_test_source_parent";
const chunks = [0, 1, 2].map((index) => `${parent}_chunk_${String(index).padStart(6, "0")}`);
function directory(t) {
  const cwd = mkdtempSync(join(tmpdir(), "es-chunk-caller-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function run(cwd, mode) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks",
    fileURLToPath(new URL("../fixtures/chunk-consolidation-caller.mjs", import.meta.url)), mode], { cwd, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
test("actual CLI consumes multiple chunk topics with exact parent/physical provenance before completion", (t) => {
  const cwd = directory(t);
  const result = run(cwd, "valid");
  assert.equal(result.calls.create.length, 3);
  assert.deepEqual(result.calls.map.map((input) => input.chunkId), chunks);
  assert.equal(result.calls.mapBatches.length, 1, "three physical chunks use one actual subprocess invocation");
  assert.equal(result.calls.mapBatches[0].pieces.length, 3);
  const evidence = Object.entries(result.state.drawers).map(([id, drawer]) => [id, JSON.parse(drawer.content.split("## Chunk Evidence\n")[1])]);
  assert.deepEqual(evidence.map(([, value]) => value.topicKey), ["architecture", "secondary", "minority"]);
  assert.deepEqual(evidence.map(([, value]) => value.contributingChunkIds), [[chunks[0], chunks[1]], [chunks[0]], [chunks[2]]]);
  for (const [id, value] of evidence) {
    assert.equal(value.parentDrawerId, parent);
    const lineage = result.state.edges.filter((edge) => edge.subject === id && edge.predicate === "synthesized-from").map((edge) => edge.object);
    assert.deepEqual(lineage, [parent, ...value.contributingChunkIds]);
    assert.ok(result.state.edges.filter((edge) => edge.subject === id && edge.predicate === "synthesized-from").every((edge) => edge.source_drawer_id === parent));
  }
  const firstCompletion = result.calls.kg.findIndex((edge) => edge.predicate === "consolidated-into");
  const lastEvidence = result.calls.kg.findLastIndex((edge) => edge.predicate === "synthesized-from");
  assert.ok(firstCompletion > lastEvidence);
  assert.equal(result.worklistOutput.chunkCoverage[0].replacementCoverage, true);
  assert.deepEqual(result.calls.move.map((entry) => entry.drawer_id), [parent, ...chunks]);
  assert.ok(result.calls.retire.length > 0);
  const coveragePath = join(cwd, ".electric-shepherd/coverage");
  const manifest = JSON.parse(readFileSync(join(coveragePath, readdirSync(coveragePath).find((name) => name.endsWith(".json"))), "utf8"));
  assert.equal(manifest.completed, true);
  assert.equal(manifest.extraction.assessments.length, 3);
  assert.ok(Object.values(manifest.writes).every((entry) => entry.status === "verified" && entry.drawerId));
});
test("actual CLI partial writes resume with returned IDs, never duplicate successful drawers", (t) => {
  const cwd = directory(t);
  const first = run(cwd, "partial");
  assert.equal(first.calls.create.length, 2);
  assert.deepEqual(first.calls.move, []);
  assert.deepEqual(first.calls.retire, []);
  assert.ok(first.calls.kg.every((edge) => edge.predicate !== "consolidated-into"));
  const second = run(cwd, "valid");
  assert.equal(second.calls.create.length, 1); // Only the not-yet-attempted minority topic.
  assert.deepEqual(second.calls.map, []);
  assert.equal(Object.keys(second.state.drawers).length, 3);
  assert.equal(second.worklistOutput.chunkCoverage[0].completed, true);
  const third = run(cwd, "valid");
  assert.deepEqual(third.calls.create, []);
  assert.deepEqual(third.calls.map, []);
});
test("ambiguous write response blocks retry for manual reconciliation, including no blind duplicate", (t) => {
  const cwd = directory(t);
  const first = run(cwd, "uncertain");
  assert.equal(first.calls.create.length, 2);
  assert.equal(first.worklistOutput.chunkCoverage[0].completed, false);
  const second = run(cwd, "valid");
  assert.deepEqual(second.calls.create, []);
  assert.deepEqual(second.calls.move, []);
  assert.deepEqual(second.calls.retire, []);
  assert.match(second.worklistOutput.chunkCoverage[0].error, /manual-reconciliation-required/);
});
for (const mode of ["gap", "low", "inventory-gap", "batch-missing", "batch-duplicate", "batch-extra"]) {
  test(`actual CLI preserves old closet and source on ${mode} coverage despite legacy completion`, (t) => {
    const result = run(directory(t), mode);
    assert.deepEqual(result.calls.create, []);
    assert.deepEqual(result.calls.move, []);
    assert.deepEqual(result.calls.retire, []);
    assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
    assert.deepEqual(result.worklistOutput.reconsolidationRetirementsSkipped[0].failedParentIds, [parent]);
  });
}
test("complete zero-substance chunks move without false replacement or retirement", (t) => {
  const result = run(directory(t), "zero");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  assert.equal(result.worklistOutput.chunkCoverage[0].replacementCoverage, false);
  assert.deepEqual(result.calls.create, []);
  assert.deepEqual(result.calls.retire, []);
  assert.deepEqual(result.calls.kg, []);
  assert.equal(result.calls.move.length, 4);
});
test("completion edge retry verifies existing drawers without duplicate topic writes", (t) => {
  const cwd = directory(t);
  const first = run(cwd, "completion-failure");
  assert.equal(first.calls.create.length, 3);
  assert.deepEqual(first.calls.move, []);
  assert.deepEqual(first.calls.retire, []);
  const resumed = run(cwd, "valid");
  assert.deepEqual(resumed.calls.create, []);
  assert.deepEqual(resumed.calls.map, []);
  assert.equal(resumed.worklistOutput.chunkCoverage[0].completed, true);
});
test("changed physical content invalidates coverage in the actual CLI", (t) => {
  const cwd = directory(t);
  const first = run(cwd, "valid");
  const second = run(cwd, "changed");
  assert.equal(second.calls.map.length, 3);
  assert.equal(second.calls.create.length, 3);
  assert.notEqual(first.worklistOutput.chunkCoverage[0].extraction.sourceVersion, second.worklistOutput.chunkCoverage[0].extraction.sourceVersion);
});
test("zero-substance spans are explicitly covered without inventing contribution lineage", (t) => {
  const result = run(directory(t), "mixed-zero");
  const extraction = result.worklistOutput.chunkCoverage[0].extraction;
  assert.equal(extraction.assessments[1].assessment, "zero-substance");
  assert.ok(result.state.edges.every((edge) => edge.predicate !== "synthesized-from" || edge.object !== chunks[1]));
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
});
test("--only-drawer runs the production model path read-only: zero writes, fresh checkpoint dir, chosen parent only", (t) => {
  const cwd = directory(t);
  const result = run(cwd, "only-drawer");
  assert.deepEqual(result.calls.map.map((input) => input.chunkId), chunks);
  assert.ok(result.calls.reduce.length > 0);
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], [], key);
  assert.equal(result.worklistOutput.chunkCoverage[0].parentDrawerId, parent);
  assert.ok(existsSync(join(cwd, "smoke-coverage")));
  const guard = result.worklistOutput.readOnlyGuard;
  assert.equal(guard.writeAttempts, 0);
  assert.deepEqual(guard.blocked, []);
  assert.ok(guard.allowed.length > 0);
  assert.ok(guard.allowed.every((name) => !/add_drawer|kg_add|update_drawer|move|delete|checkpoint/.test(name)), guard.allowed.join());
  assert.equal(result.captureEnabled, "false");
});
test("host smoke assertions accept the actual CLI report and reject coverage gaps, empty drafts and blocked writes", async (t) => {
  const harness = new URL("../../../1-Armet/opencode/context/chunk-aware-live-smoke.mjs", import.meta.url);
  if (!existsSync(harness)) return t.skip("host-side smoke harness is not installed alongside this checkout");
  const { assessSmokeReport } = await import(harness);
  // Reuse the existing caller fixture and the real run-report emitter, not a new model smoke.
  const { report } = run(directory(t), "only-drawer");
  assert.ok(Object.values(assessSmokeReport(report, parent).checks).every(Boolean));
  const rejected = (change, key) => {
    const invalid = structuredClone(report);
    change(invalid);
    assert.equal(assessSmokeReport(invalid, parent).checks[key], false);
  };
  rejected((r) => r.worklist.chunkCoverage[0].extraction.assessments.pop(), "fullCoverage");
  rejected((r) => { r.worklist.chunkCoverage[0].extraction.extractionComplete = false; }, "fullCoverage");
  rejected((r) => { r.worklist.chunkCoverage[0].drafts[0].consolidationDraft.content = " "; }, "nonemptyDrafts");
  rejected((r) => { r.worklist.readOnlyGuard.blocked.push("mock_kg_add"); }, "noWrites");
  rejected((r) => { r.worklist.chunkCoverage[0].reconciliation.reconciliationComplete = false; }, "completeReconciliation");
  rejected((r) => { r.worklist.chunkCoverage[0].reconciliation.topics[0].contributingChunkIds = ["unknown"]; }, "provenance");
  assert.equal(assessSmokeReport(report, parent, null).checks.cliExit0, false);
});
test("reader-window-only topic creates no closet yet the chunk is assessed and coverage completes", (t) => {
  const result = run(directory(t), "reader-topic-only");
  const coverage = result.worklistOutput.chunkCoverage[0];
  assert.equal(coverage.extraction.assessments[1].assessment, "zero-substance");
  assert.equal(coverage.completed, true);
  assert.ok(!JSON.stringify(result.calls.create).includes("window-fragment"));
});
test("actual CLI accepts facts-only topics (one substantive section) under the default minimum", (t) => {
  const result = run(directory(t), "facts-only");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  assert.ok(result.calls.create.length > 0);
});
test("a durable topic without an admissible primary quote fails closed with no writes or completion", (t) => {
  const result = run(directory(t), "unsupported-fact");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
  assert.match(result.worklistOutput.chunkCoverage[0].error, /topic-quote-not-in-primary|extraction/);
  assert.equal(result.calls.create.length, 0);
});
test("physical evidence edges cannot promote one parent as multiple independent sources", async () => {
  const facts = [parent, ...chunks].map((object) => ({ subject: "closet", predicate: "synthesized-from", object, source_drawer_id: parent }));
  const core = { kgQueryIgnoringFailure: async () => ({ facts }), call: async (_name, args) => ({ drawer_id: args.drawer_id,
    metadata: { parent_drawer_id: chunks.includes(args.drawer_id) ? parent : undefined } }) };
  assert.equal(await countDirectSources(core, "closet"), 1);
  facts.push({ subject: "closet", predicate: "synthesized-from", object: "other-parent", source_drawer_id: "other-parent" });
  assert.equal(await countDirectSources(core, "closet"), 2);
});
test("actual CLI accepts substrate canonical vocabulary and does not require unreadable KG provenance", (t) => {
  const result = run(directory(t), "canonical");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  assert.equal(result.calls.create.length, 3);
});
test("actual CLI verifies separate dead-end drawer and its exact primary chunk lineage", (t) => {
  const result = run(directory(t), "dead-end");
  assert.equal(result.calls.create.length, 4);
  const negative = Object.entries(result.state.drawers).find(([, drawer]) => drawer.content.startsWith("- Reuse partial parent coverage"));
  assert.ok(negative);
  assert.deepEqual(result.state.edges.filter((edge) => edge.subject === negative[0] && edge.predicate === "synthesized-from").map((edge) => edge.object), [parent, chunks[0]]);
  assert.equal(result.state.edges.filter((edge) => edge.subject === negative[0] && edge.predicate === "rules-out").length, 2);
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
});
test("actual CLI rejects unrelated subjects sharing a topic key before any write or completion", (t) => {
  const result = run(directory(t), "collision");
  assert.match(result.worklistOutput.chunkCoverage[0].error, /topic-key-subject-collision:architecture/);
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
  assert.deepEqual(result.calls.create, []);
  assert.deepEqual(result.calls.move, []);
  assert.deepEqual(result.calls.retire, []);
  assert.deepEqual(result.calls.kg, []);
});
test("actual CLI covers every oversized physical piece, preserving late minority evidence and exact chunk IDs", (t) => {
  const result = run(directory(t), "large-valid");
  const physical = result.calls.map.filter((input) => input.chunkId === chunks[0]);
  assert.deepEqual(physical.map((input) => input.pieceIndex), [0, 1, 2]);
  assert.ok(result.calls.map.every((input) => input.primary.length <= 16_000 && input.previous.length <= 1_000 && input.next.length <= 1_000));
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  assert.deepEqual(result.worklistOutput.chunkCoverage[0].extraction.assessments[0].pieceCoverage.completedIndices, [0, 1, 2]);
  const late = Object.entries(result.state.drawers).find(([, drawer]) => drawer.content.includes('"topicKey":"late-piece"'));
  assert.ok(late[1].content.includes("LATE PIECE MINORITY"));
  assert.deepEqual(result.state.edges.filter((edge) => edge.subject === late[0] && edge.predicate === "synthesized-from").map((edge) => edge.object), [parent, chunks[0]]);
});
test("actual CLI resumes only missing oversized pieces, not successful pieces or entire chunk", (t) => {
  const cwd = directory(t);
  const first = run(cwd, "large-partial");
  assert.equal(first.calls.map.length, 5);
  assert.deepEqual(first.calls.create, []);
  assert.deepEqual(first.calls.retire, []);
  assert.equal(first.worklistOutput.chunkCoverage[0].extraction.assessments.some((assessment) => assessment.chunkId === chunks[0]), false);
  const resumed = run(cwd, "large-valid");
  assert.deepEqual(resumed.calls.map.map(({ chunkId, pieceIndex }) => ({ chunkId, pieceIndex })), [{ chunkId: chunks[0], pieceIndex: 1 }]);
  assert.equal(resumed.worklistOutput.chunkCoverage[0].completed, true);
  const again = run(cwd, "large-valid");
  assert.deepEqual(again.calls.map, []);
  assert.deepEqual(again.calls.create, []);
});
test("wrong piece identity cannot certify physical chunk coverage in the actual CLI", (t) => {
  const result = run(directory(t), "large-wrong-piece");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
  assert.match(result.worklistOutput.chunkCoverage[0].extraction.failures[0].error, /wrong-batch-piece-provenance|duplicate-batch-piece/);
  assert.deepEqual(result.calls.create, []);
  assert.deepEqual(result.calls.retire, []);
});
test("server-shaped legacy parent_entry_id source resolves and completes through actual CLI", (t) => {
  const result = run(directory(t), "legacy");
  assert.equal(result.worklistOutput.chunkCoverage[0].parentDrawerId, parent);
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  assert.deepEqual(result.calls.map.map((input) => input.chunkId), chunks);
  assert.deepEqual(result.calls.move.map((entry) => entry.drawer_id), [parent, ...chunks]);
  assert.ok(result.calls.retire.length > 0);
});
test("legacy parent resolution and direct-source counting use supported server metadata precedence", async () => {
  assert.equal(logicalParentDrawerId({ parent_entry_id: parent }), parent);
  assert.equal(logicalParentDrawerId({ parent_drawer_id: parent, parent_entry_id: "older" }), parent);
  assert.throws(() => logicalParentDrawerId({ parent_entry_id: 42 }), /invalid-logical-parent/);
  const getDrawer = async ({ drawer_id }) => ({ drawer_id, content: "raw", metadata: drawer_id === parent
    ? { parent_entry_id: parent, chunk_ids: chunks, chunks: 3 } : { parent_entry_id: parent, chunk_index: chunks.indexOf(drawer_id) } });
  const inventory = await discoverSourceChunks({ getDrawer }, chunks[2]);
  assert.equal(inventory.parentDrawerId, parent);
  assert.deepEqual(inventory.chunks.map((chunk) => chunk.drawerId), chunks);
  const facts = [parent, ...chunks].map((object) => ({ subject: "closet", predicate: "synthesized-from", object }));
  assert.equal(await countDirectSources({ kgQueryIgnoringFailure: async () => ({ facts }), call: (_name, args) => getDrawer(args) }, "closet"), 1);
});
test("actual CLI reconciles later resolution, retains minority topics and persists exact correction provenance", (t) => {
  const cwd = directory(t);
  const result = run(cwd, "semantic-valid");
  const coverage = result.worklistOutput.chunkCoverage[0];
  assert.equal(coverage.completed, true);
  assert.equal(coverage.extraction.assessments[2].assessment, "context");
  assert.deepEqual(coverage.reconciliation.topics.map(({ topic }) => topic.topicKey), ["architecture", "secondary", "minority"]);
  const reconciled = coverage.reconciliation.topics[0];
  assert.deepEqual(reconciled.topic.openItems, []);
  assert.ok(reconciled.topic.durableFacts.includes("The migration was explicitly canceled after compatibility review, not completed."));
  assert.deepEqual(result.consolidationBatches[0].consolidationDraft.openItems, []);
  const correction = reconciled.evidence.find((record) => record.context);
  const receipt = reconciled.receipts.find((entry) => entry.evidenceId === correction.evidenceId);
  assert.equal(correction.chunkId, chunks[2]);
  assert.equal(correction.pieceIndex, 0);
  assert.equal(receipt.disposition, "resolved");
  assert.equal(reconciled.evidence.find((record) => record.evidenceId === receipt.affectedEvidenceIds[0]).chunkId, chunks[0]);
  assert.deepEqual(reconciled.contributingChunkIds, chunks);
  const audit = JSON.parse(result.calls.create[0].content.split("## Chunk Evidence\n")[1]);
  assert.deepEqual(audit.receipts, reconciled.receipts);
  assert.deepEqual(audit.evidence, reconciled.evidence);
  assert.ok(result.state.edges.some((edge) => edge.subject === "drawer_topic_0" && edge.predicate === "synthesized-from" && edge.object === chunks[2]));
  assert.ok(result.calls.reduce.every((input) => input.primary === undefined && input.evidence && Buffer.byteLength(JSON.stringify(input)) <= 32_000));
  const resumed = run(cwd, "semantic-valid");
  assert.deepEqual(resumed.calls.map, []);
  assert.deepEqual(resumed.calls.reduce, []);
  assert.deepEqual(resumed.calls.create, []);
  assert.deepEqual(resumed.worklistOutput.chunkCoverage[0].reconciliation, coverage.reconciliation);
});
test("live-smoke pagination clarification removes window-local pending work without claiming a full list", (t) => {
  const result = run(directory(t), "semantic-pages");
  const final = result.worklistOutput.chunkCoverage[0].reconciliation.topics[0];
  assert.deepEqual(final.topic.openItems, []);
  assert.ok(final.topic.durableFacts.some((line) => line.includes("one 25-ID page") && line.includes("150 total")));
  assert.equal(final.receipts.at(-1).disposition, "qualified");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
});
for (const mode of ["semantic-truncated", "semantic-failed", "semantic-wrong-source", "semantic-omitted-receipt", "semantic-forged-target", "semantic-unchanged"]) {
  test(`actual CLI blocks writes, movement and retirement on ${mode} reducer`, (t) => {
    const cwd = directory(t);
    const failed = run(cwd, mode);
    assert.equal(failed.worklistOutput.chunkCoverage[0].extraction.extractionComplete, true);
    assert.equal(failed.worklistOutput.chunkCoverage[0].completed, false);
    assert.deepEqual(failed.calls.create, []);
    assert.deepEqual(failed.calls.kg, []);
    assert.deepEqual(failed.calls.move, []);
    assert.deepEqual(failed.calls.retire, []);
    assert.deepEqual(failed.calls.search, []);
    const resumed = run(cwd, "semantic-valid");
    assert.equal(resumed.worklistOutput.chunkCoverage[0].completed, true);
    assert.deepEqual(resumed.calls.map, []);
    if (mode === "semantic-truncated" || mode === "semantic-failed") {
      assert.equal(resumed.calls.reduce.filter((input) => input.topicKey === "architecture").length, 1);
      assert.ok(resumed.calls.reduce.find((input) => input.topicKey === "architecture").evidence.context);
    }
  });
}
test("all reducers dismissing a contextual record cannot silently certify source completion", (t) => {
  const cwd = directory(t);
  const result = run(cwd, "semantic-silent-drop");
  assert.match(result.worklistOutput.chunkCoverage[0].error, /context-not-reconciled/);
  assert.deepEqual(result.calls.create, []);
  assert.deepEqual(result.calls.move, []);
  assert.deepEqual(result.calls.retire, []);
  const resumed = run(cwd, "semantic-valid");
  assert.deepEqual(resumed.calls.map, []);
  assert.ok(resumed.calls.reduce.every((input) => input.evidence.context));
  assert.equal(resumed.worklistOutput.chunkCoverage[0].completed, true);
});

for (const [mode, error] of [["semantic-unrelated-change", "unrelated-context-changed-state"], ["semantic-unrelated-target", "unrelated-context-has-targets"]]) {
  test(`actual CLI blocks ${mode} despite correct resolution of another topic`, (t) => {
    const result = run(directory(t), mode);
    const coverage = result.worklistOutput.chunkCoverage[0];
    assert.equal(coverage.extraction.extractionComplete, true);
    assert.equal(coverage.completed, false);
    assert.match(coverage.error, new RegExp(error));
    const resolved = result.calls.reduce.findIndex((input) => input.topicKey === "architecture" && input.evidence.context);
    const unrelated = result.calls.reduce.findIndex((input) => input.topicKey === "secondary" && input.evidence.context);
    assert.ok(resolved >= 0 && unrelated > resolved, "matching topic resolution must precede the unrelated mutation");
    assert.deepEqual(result.calls.reduce[unrelated].previous.openItems, ["The separate source-authored secondary task remains pending."]);
    assert.deepEqual(result.calls.create, []);
    assert.deepEqual(result.calls.kg, []);
    assert.deepEqual(result.calls.move, []);
    assert.deepEqual(result.calls.retire, []);
  });
}
test("unrelated context preserves canonical typed state regardless of JSON property order", (t) => {
  const result = run(directory(t), "semantic-unrelated-reordered");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  const secondary = result.worklistOutput.chunkCoverage[0].reconciliation.topics.find(({ topic }) => topic.topicKey === "secondary");
  assert.deepEqual(secondary.topic.openItems, ["The separate source-authored secondary task remains pending."]);
  assert.equal(secondary.receipts.at(-1).disposition, "unrelated");
  assert.deepEqual(secondary.receipts.at(-1).affectedEvidenceIds, []);
  assert.deepEqual(secondary.contributingChunkIds, [chunks[0]]);
});

for (const [mode, error] of [["semantic-invented-unlisted", "invalid-reconciliation-open-task-ids|unsupported-reconciliation-open-task"], ["semantic-invented-listed", "invalid-reconciliation-open-task-ids"]]) {
  test(`reducer inventing an open task under a qualifier blocks all writes: ${mode}`, (t) => {
    const result = run(directory(t), mode === "semantic-invented-unlisted" ? "semantic-invented-unlisted" : mode);
    const coverage = result.worklistOutput.chunkCoverage[0];
    assert.equal(coverage.completed, false);
    assert.match(coverage.error, new RegExp(error));
    for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], []);
  });
}
test("valid retained and resolved authored tasks keep typed ledger", (t) => {
  const final = run(directory(t), "semantic-valid").worklistOutput.chunkCoverage[0].reconciliation;
  const arch = final.topics.find(({ topic }) => topic.topicKey === "architecture");
  assert.deepEqual(arch.topic.openItems, []);
  assert.equal(arch.authoredOpenTasks.length, 1);
  assert.deepEqual(arch.retainedOpenTaskIds, []);
  const secondary = run(directory(t), "semantic-unrelated-reordered").worklistOutput.chunkCoverage[0].reconciliation.topics.find(({ topic }) => topic.topicKey === "secondary");
  assert.equal(secondary.retainedOpenTaskIds.length, 1);
  assert.equal(secondary.authoredOpenTasks[0].taskId, secondary.retainedOpenTaskIds[0]);
});

test("reader-window context is classified deterministically, never reaches the reducer or durable facts", (t) => {
  const result = run(directory(t), "semantic-reader-window");
  const coverage = result.worklistOutput.chunkCoverage[0];
  assert.equal(coverage.completed, true);
  assert.equal(coverage.extraction.contextualEvidence[0].origin, "reader-window");
  assert.ok(result.calls.reduce.every((input) => !input.evidence.context));
  for (const { topic, receipts } of coverage.reconciliation.topics) {
    assert.equal(receipts.at(-1).disposition, "boundary-only");
    assert.ok(topic.durableFacts.every((fact) => !fact.includes("25-ID page")));
  }
});
test("reader-window-only chunk adds no synthesized-from contribution edge to any topic", (t) => {
  const result = run(directory(t), "semantic-reader-window");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, true);
  assert.ok(result.state.edges.some((edge) => edge.predicate === "synthesized-from"));
  assert.ok(!result.state.edges.some((edge) => edge.predicate === "synthesized-from" && edge.object === chunks[2]));
  assert.ok(result.state.edges.some((edge) => edge.predicate === "consolidated-into" && edge.subject === chunks[2]), "chunk is still accounted for");
  for (const { topic, contributingChunkIds, receipts } of result.worklistOutput.chunkCoverage[0].reconciliation.topics) {
    assert.ok(!contributingChunkIds.includes(chunks[2]), topic.topicKey);
    assert.equal(receipts.at(-1).disposition, "boundary-only");
  }
});
for (const mode of ["semantic-legacy-full", "semantic-null-delta"]) {
  test(`actual CLI fails closed on non-delta reducer output: ${mode}`, (t) => {
    const result = run(directory(t), mode);
    assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
    assert.match(result.worklistOutput.chunkCoverage[0].error, /invalid-reconciliation-delta/);
    for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], []);
  });
}
test("a reducer cannot launder reader-window text into facts; source limitation qualifier is retained", (t) => {
  assert.equal(run(directory(t), "semantic-reader-leak").worklistOutput.chunkCoverage[0].completed, true, "source-origin leak mock is a normal qualifier");
  const final = run(directory(t), "semantic-pages").worklistOutput.chunkCoverage[0].reconciliation.topics[0];
  assert.ok(final.topic.durableFacts.some((line) => line.includes("25-ID page") && line.includes("150 total")));
});
test("unrelated disposition with changed state fails closed", (t) => {
  const result = run(directory(t), "semantic-boundary-changed");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
  assert.match(result.worklistOutput.chunkCoverage[0].error, /unrelated-context-changed-state/);
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], []);
});
test("model-claimed boundary-only is no longer a valid reducer disposition", (t) => {
  const result = run(directory(t), "semantic-boundary-correction");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
  assert.match(result.worklistOutput.chunkCoverage[0].error, /invalid-reconciliation-disposition/);
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], []);
});

test("actual CLI grounds a newline quote to literal escaped source text and completes", (t) => {
  const coverage = run(directory(t), "semantic-escaped").worklistOutput.chunkCoverage[0];
  assert.equal(coverage.completed, true);
  const quote = coverage.extraction.contextualEvidence[0].sourceQuote;
  assert.ok(quote.includes("\\n") && !quote.includes("\n"));
});
test("actual CLI rejects a fabricated suffix on an escaped-source quote before reconciliation or writes", (t) => {
  const result = run(directory(t), "semantic-escaped-fake");
  assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
  assert.deepEqual(result.calls.reduce, []);
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], []);
});
