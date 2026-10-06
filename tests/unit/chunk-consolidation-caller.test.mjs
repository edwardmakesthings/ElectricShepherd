import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { countDirectSources } from "../../src/capability/episodic/closet-status.ts";
import { discoverSourceChunks } from "../../src/scripts/memory-pipeline/chunk-consolidation.ts";
const parent = "drawer_test_source_parent";
const chunks = [0, 1, 2].map((index) => parent + "_chunk_" + String(index).padStart(6, "0"));
function directory(t) { const cwd = mkdtempSync(join(tmpdir(), "es-content-caller-")); t.after(() => rmSync(cwd, { recursive: true, force: true })); return cwd; }
function run(cwd, mode) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks",
    fileURLToPath(new URL("../fixtures/chunk-consolidation-caller.mjs", import.meta.url)), mode], { cwd, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim());
}
test("actual CLI raw text has no fabricated confidence/sections; drawer content and metadata stay separate", (t) => {
  const result = run(directory(t), "valid"); assert.equal(result.calls.create.length, 1);
  assert.equal(result.calls.mapBatches.length, 1); assert.equal(result.calls.mapBatches[0].sources.length, 3);
  const coverage = result.worklistOutput.chunkCoverage[0]; assert.equal(coverage.completed, true); assert.equal(coverage.replacementCoverage, true);
  assert.equal(coverage.extraction.assessments.length, 1);
  for (const [id, drawer] of Object.entries(result.state.drawers)) {
    const provenance = JSON.parse(drawer.metadata.desc);
    assert.deepEqual(provenance.contributingChunkIds, chunks);
    assert.equal(drawer.content, coverage.reconciliation.topics[0].content);
    assert.ok(!Object.hasOwn(coverage.reconciliation.topics[0], "confidence"));
    assert.ok(!Object.hasOwn(coverage.drafts[0], "consolidationDraft"));
    assert.deepEqual(result.state.edges.filter((edge) => edge.subject === id && edge.predicate === "synthesized-from").map((edge) => edge.object), [parent, ...chunks]);
  }
  assert.ok(result.calls.kg.findIndex((edge) => edge.predicate === "consolidated-into") > result.calls.kg.findLastIndex((edge) => edge.predicate === "synthesized-from"));
  assert.deepEqual(result.calls.move.map((entry) => entry.drawer_id), [parent, ...chunks]); assert.ok(result.calls.retire.length > 0);
});
for (const mode of ["missing", "done", "length", "error", "timeout", "tool", "unisolated", "model-drift", "budget-drift", "missing-request-limits", "deadline", "inventory-gap", "reducer-empty", "reducer-done", "reducer-error"]) {
  test("actual CLI no writes, retirement or fallback on failed content route: " + mode, (t) => {
    const result = run(directory(t), mode); assert.equal(result.worklistOutput.chunkCoverage[0].completed, false);
    for (const key of ["create", "kg", "move", "retire", "search"]) assert.deepEqual(result.calls[key], []);
    assert.ok(result.calls.mapBatches.length <= 2 && result.calls.reduce.length <= 2);
    if (["model-drift", "budget-drift", "missing-request-limits"].includes(mode)) assert.equal(result.calls.mapBatches.length, 1, "contract failures are not retryable");
  });
}
for (const mode of ["markdown", "fences", "retry-length", "retry-error", "retry-empty", "retry-timeout", "reducer-retry-length"]) {
  test("production raw route accepts useful text or one safe retry: " + mode, t => {
    const result = run(directory(t), mode), coverage = result.worklistOutput.chunkCoverage[0];
    assert.equal(coverage.completed, true); assert.equal(result.calls.mapBatches.length, mode.startsWith("retry-") ? 2 : 1);
    assert.equal(result.calls.reduce.length, mode === "reducer-retry-length" ? 2 : 1);
    assert.equal(result.calls.create[0].content, coverage.reconciliation.topics[0].content);
  });
}
test("partial verified writes resume with returned IDs and no duplicate successful drawers", (t) => {
  const cwd = directory(t), first = run(cwd, "partial"); assert.equal(first.calls.create.length, 1); assert.deepEqual(first.calls.move, []);
  const second = run(cwd, "valid"); assert.equal(second.calls.create.length, 0); assert.equal(second.worklistOutput.chunkCoverage[0].completed, true);
  assert.deepEqual(second.calls.map, []); assert.deepEqual(run(cwd, "valid").calls.create, []);
});
for (const initial of ["uncertain", "uncertain-throw"]) test("uncertain write stays blocked across retry and source version changes: " + initial, (t) => {
  const cwd = directory(t), first = run(cwd, initial);
  assert.equal(first.worklistOutput.chunkCoverage[0].completed, false);
  assert.equal(first.calls.create.length, 1, "uncertain palace writes never receive inference retries");
  for (const mode of ["valid", "changed"]) { const result = run(cwd, mode); assert.deepEqual(result.calls.create, []); assert.deepEqual(result.calls.move, []); assert.deepEqual(result.calls.retire, []); assert.match(result.worklistOutput.chunkCoverage[0].error, /uncertain-topic-write/); }
});
test("completion-edge failure prevents retirement until all edges verify", (t) => {
  const cwd = directory(t), first = run(cwd, "completion-failure"); assert.equal(first.worklistOutput.chunkCoverage[0].completed, false); assert.deepEqual(first.calls.move, []);
  const second = run(cwd, "valid"); assert.deepEqual(second.calls.create, []); assert.equal(second.worklistOutput.chunkCoverage[0].completed, true);
});
test("production read-only route retains capture-off and zero palace write attempts", (t) => {
  const result = run(directory(t), "only-drawer"); assert.equal(result.captureEnabled, "false");
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(result.calls[key], []);
  assert.equal(result.worklistOutput.readOnlyGuard.writeAttempts, 0);
});
test("legacy parent metadata remains supported", (t) => assert.equal(run(directory(t), "legacy").worklistOutput.chunkCoverage[0].completed, true));
test("physical chunks do not inflate logical independent source count", async () => {
  assert.equal(await countDirectSources({ kgQueryIgnoringFailure: async () => ({ facts: [parent, ...chunks].map((object) => ({ subject: "s", predicate: "synthesized-from", object })) }),
    call: async (_tool, { drawer_id }) => ({ drawer_id, metadata: drawer_id === parent ? {} : { parent_drawer_id: parent } }) }, "s"), 1);
});
test("discovery fails on incomplete declared inventory", async () => {
  await assert.rejects(discoverSourceChunks({ getDrawer: async ({ drawer_id }) => ({ drawer_id, metadata: { chunk_ids: chunks, chunks: 4 } }) }, parent), /count-mismatch/);
});

test("accepted early oversized-source batches never allow early writes when a late batch fails", (t) => {
  const cwd = directory(t), failed = run(cwd, "large-fail"), coverage = failed.worklistOutput.chunkCoverage[0];
  assert.equal(coverage.completed, false); assert.ok(coverage.extraction.assessments.length > 0);
  assert.equal(coverage.extraction.extractionComplete, false);
  assert.deepEqual(failed.calls.reduce, []);
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(failed.calls[key], []);
  const retried = run(cwd, "large-valid"); assert.equal(retried.worklistOutput.chunkCoverage[0].completed, true);
  assert.ok(retried.calls.mapBatches.length < failed.calls.mapBatches.length);
});

test("actual production policy-only source inspects but never infers, creates or retires", t => {
  const r = run(directory(t), "policy-only"), c = r.worklistOutput.chunkCoverage[0];
  assert.equal(c.completed, false); assert.equal(c.replacementCoverage, false); assert.match(c.error, /policy-only/);
  assert.equal(c.extraction.preprocessing.status, "policy-only"); assert.equal(c.extraction.preprocessing.inspectedChunkIds.length, 3);
  assert.deepEqual(c.drafts, []);
  for (const key of ["create", "kg", "move", "retire", "mapBatches", "reduce"]) assert.deepEqual(r.calls[key], []);
});
test("actual production filtered source provenance contains only retained primary chunks", t => {
  const r = run(directory(t), "policy-mixed"), c = r.worklistOutput.chunkCoverage[0];
  assert.equal(c.extraction.preprocessing.status, "filtered"); assert.equal(c.completed, true);
  assert.deepEqual(c.drafts[0].provenance.contributingChunkIds, [chunks[2]]);
  assert.ok(r.calls.mapBatches.every(b => b.sources.every(s => !s.primary.includes("secret-policy-body"))));
  const desc = JSON.parse(r.calls.create[0].metadata.desc); assert.deepEqual(desc.contributingChunkIds, [chunks[2]]);
  assert.deepEqual(desc.sourceChronology, [{ sourceDrawerId: parent, sessionId: "offline",
    sessionTime: { created: "2024-01-01T00:00:00.000Z", updated: "2024-01-01T00:00:03.000Z" },
    retainedMessageTimeRange: { earliest: "2024-01-01T00:00:02.000Z", latest: "2024-01-01T00:00:02.000Z" } }]);
  assert.ok(r.calls.mapBatches.some(b => b.sources.some(s => s.primary.includes("2024-01-01T00:00:02.000Z"))));
  assert.ok(!JSON.stringify(desc).includes("2099-"));
});

test("actual caller excludes metadata-only and guard-only chunks from PRIMARY provenance", t => {
  const r = run(directory(t), "metadata-split"), c = r.worklistOutput.chunkCoverage[0];
  assert.equal(c.completed, true); assert.deepEqual(c.extraction.preprocessing.inspectedChunkIds, chunks);
  assert.equal(c.extraction.preprocessing.rawHashes.length, 3);
  assert.deepEqual(c.extraction.preprocessing.contributingChunkIds, [chunks[1]]);
  assert.deepEqual(c.extraction.assessments.flatMap(a => a.members.map(m => m.chunkId)), [chunks[1]]);
  assert.deepEqual(c.drafts[0].provenance.contributingChunkIds, [chunks[1]]);
  assert.deepEqual(JSON.parse(r.calls.create[0].metadata.desc).contributingChunkIds, [chunks[1]]);
  assert.deepEqual(c.extraction.preprocessing.sessionSpans, [{ chunkId: chunks[0], start: 11, end: 11 + JSON.stringify({ id: "metadata-only" }).length }]);
  assert.equal(r.calls.mapBatches.length, 1); assert.equal(r.calls.mapBatches[0].sources.length, 1);
  assert.match(r.calls.mapBatches[0].sources[0].primary, /substantive viewer fix/);
  assert.ok(!r.calls.mapBatches[0].sources[0].primary.includes("metadata-only"));
  assert.ok(!r.calls.mapBatches[0].sources[0].primary.includes("secret-policy-body"));
});
test("palace storage maximum is separate from raw-summary admission", t => {
  const accepted = run(directory(t), "storage-limit");
  assert.equal(accepted.worklistOutput.chunkCoverage[0].completed, true);
  assert.equal(accepted.calls.create[0].content.length, 100000);
  const rejected = run(directory(t), "storage-excess"), c = rejected.worklistOutput.chunkCoverage[0];
  assert.equal(c.reconciliation.reconciliationComplete, true); assert.equal(c.drafts[0].content.length, 100001);
  assert.equal(c.completed, false); assert.match(c.error, /topic-storage-capacity/);
  for (const key of ["create", "kg", "move", "retire"]) assert.deepEqual(rejected.calls[key], []);
});

test("unknown original time is absent, and lost persisted metadata cannot certify completion", t => {
  const valid = run(directory(t), "valid");
  assert.deepEqual(JSON.parse(valid.calls.create[0].metadata.desc).sourceChronology, [{ sourceDrawerId: parent }]);
  const lost = run(directory(t), "lost-provenance"), coverage = lost.worklistOutput.chunkCoverage[0];
  assert.equal(coverage.completed, false); assert.match(coverage.error, /topic-provenance-unverified/);
  assert.deepEqual(lost.calls.move, []); assert.deepEqual(lost.calls.retire, []);
});

test("normal layered caller carries source-associated historical provenance through the persisted read path", async t => {
  const { runChunkConsolidation } = await import("../../src/scripts/memory-pipeline/chunk-consolidation.ts");
  const { persistedSourceChronology } = await import("../../src/core/transcript-time.ts");
  const original = { sourceDrawerId: "original-transcript", sessionId: "s", sessionTime: { created: "2024-01-01T00:00:00.000Z" },
    retainedMessageTimeRange: { earliest: "2024-01-01T00:00:01.000Z", latest: "2024-01-01T00:00:02.000Z" } };
  const drawers = { layered: { drawer_id: "layered", content: "A prior synthesized decision preserved immutable sources.",
    metadata: { desc: JSON.stringify({ sourceChronology: [original] }), filed_at: "2026-10-05T00:00:00Z" } } };
  const edges = [], writes = [];
  const client = {
    getDrawer: async ({ drawer_id }) => drawers[drawer_id],
    addDrawer: async () => { throw new Error("single-write-cannot-store-desc"); },
    addDrawers: async ({ items }) => {
      writes.push(items[0]); const drawer_id = "next-" + writes.length;
      drawers[drawer_id] = { drawer_id, content: items[0].content, metadata: items[0].metadata };
      return { results: [{ drawer_id, success: true }], errors: 0 };
    },
    kgQuery: async ({ entity, predicate }) => ({ facts: edges.filter(e => e.subject === entity && e.predicate === predicate) }),
    kgAdd: async args => { edges.push(args); return { success: true }; },
  };
  const args = { client, sourceId: "layered", options: { query: "layered", applyWrites: true, targetWing: "test", targetRoom: "synth" },
    checkpointDirectory: directory(t), extractorVersion: "offline", reducerVersion: "offline",
    mapChunk: async () => "The prior decision preserves immutable sources.", reconcileTopic: async () => "The prior decision preserves immutable sources." };
  const first = await runChunkConsolidation(args); assert.equal(first.completed, true, first.error);
  const persisted = await client.getDrawer({ drawer_id: first.drafts[0].createdNodeId });
  assert.deepEqual(persistedSourceChronology(persisted.metadata.desc), [{ sourceDrawerId: "layered" }, original]);
  assert.ok(!persisted.metadata.desc.includes("2026-10-05"), "filing time is not historical event evidence");
  const second = await runChunkConsolidation({ ...args, sourceId: persisted.drawer_id }); assert.equal(second.completed, true, second.error);
  assert.deepEqual(persistedSourceChronology(writes[1].metadata.desc), [{ sourceDrawerId: persisted.drawer_id }, { sourceDrawerId: "layered" }, original]);
  const oldVersion = first.extraction.sourceVersion;
  drawers.layered.metadata.desc = JSON.stringify({ sourceChronology: [{ ...original, sessionTime: { created: "2023-01-01T00:00:00.000Z" } }] });
  const changed = await runChunkConsolidation({ ...args, options: { ...args.options, applyWrites: false } });
  assert.notEqual(changed.extraction.sourceVersion, oldVersion, "metadata changes invalidate source-version coverage");
});
