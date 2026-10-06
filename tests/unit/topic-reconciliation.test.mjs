import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileSourceTopics } from "../../src/scripts/memory-pipeline/topic-reconciliation.ts";
const early = "# Proposal\nMigration was proposed pending source-based validation of the new architecture.";
const late = "## Cancellation\nThe later source canceled migration; keep the existing architecture without migration tasks.";
function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "es-raw-reducer-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const extraction = { parentDrawerId: "parent", sourceVersion: "source", extractionComplete: true, failures: [], attempts: [],
    assessments: [early, late].map((content, i) => ({ content, batchId: String(i), members: [{ chunkId: "c" + i, pieceIndex: 0, pieceCount: 1, contentHash: "h" + i }] })) };
  const calls = [];
  const args = { extraction, reducerVersion: "test", checkpointDirectory: directory, reconcileTopic: async (prompt) => {
    calls.push(prompt); return prompt.split("NEXT CHRONOLOGICAL FINDINGS\n")[1];
  } };
  return { args, calls, directory };
}
test("all findings supplied chronologically, corrected raw output retained, conservative full-source provenance", async (t) => {
  const h = harness(t), result = await reconcileSourceTopics(h.args);
  assert.equal(result.reconciliationComplete, true); assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].endsWith(early)); assert.ok(h.calls[1].includes("PREVIOUS SUMMARY\n" + early)); assert.ok(h.calls[1].endsWith(late));
  assert.equal(result.topics[0].content, late); assert.deepEqual(result.topics[0].contributingChunkIds, ["c0", "c1"]);
  assert.deepEqual(result.topics[0].inputBatchIds, ["0", "1"]);
  h.args.reconcileTopic = async () => { throw new Error("must reuse cache"); }; await reconcileSourceTopics(h.args);
});
test("raw route deliberately has no structured task or dead-end gate", async (t) => {
  const h = harness(t); const text = "# Arbitrary heading\nA task not present in source may pass structural admission; this fixture proves no semantic protection.";
  h.args.reconcileTopic = async () => text;
  const result = await reconcileSourceTopics(h.args); assert.equal(result.topics[0].content, text);
  assert.ok(!Object.hasOwn(result.topics[0], "extractedOpenTasks"));
});
for (const response of ["", "Done", "Acknowledged."]) {
  test("missing or acknowledgement reducer cannot complete: " + response, async (t) => {
    const h = harness(t); let calls = 0; h.args.reconcileTopic = async () => { calls++; return response; };
    await assert.rejects(reconcileSourceTopics(h.args)); assert.equal(calls, response ? 1 : 2);
    assert.equal(readdirSync(h.directory).filter(f => f.endsWith(".json")).length, 0);
  });
}
test("failed reducer resumes accepted steps only and retains historical version evidence", async (t) => {
  const h = harness(t), original = h.args.reconcileTopic; let count = 0;
  h.args.reconcileTopic = async (prompt) => { if (++count === 2) throw new Error("unavailable"); return original(prompt); };
  await assert.rejects(reconcileSourceTopics(h.args), /unavailable/);
  h.calls.length = 0; h.args.reconcileTopic = original; await reconcileSourceTopics(h.args); assert.equal(h.calls.length, 1);
  h.args.reducerVersion = "new"; await reconcileSourceTopics(h.args); assert.equal(readdirSync(h.directory).filter(f => f.endsWith(".json")).length, 2);
});
test("cached text is validated again", async (t) => {
  const h = harness(t); await reconcileSourceTopics(h.args);
  const path = join(h.directory, readdirSync(h.directory).find(f => f.endsWith(".json"))), stored = JSON.parse(readFileSync(path, "utf8"));
  Object.values(stored.responses)[0].response = "Done"; writeFileSync(path, JSON.stringify(stored));
  await assert.rejects(reconcileSourceTopics(h.args), /insubstantial/);
});
test("large summaries and combined reducer inputs stay complete without artificial caps", async (t) => {
  const h = harness(t), text = "x".repeat(17000); h.args.extraction.assessments[0].content = text;
  const result = await reconcileSourceTopics(h.args);
  assert.equal(result.reconciliationComplete, true); assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1].length > 16000); assert.ok(h.calls[1].includes("PREVIOUS SUMMARY\n" + text));
  assert.ok(h.calls[1].endsWith(late)); assert.equal(result.topics[0].content, late);
});
test("partial extraction cannot reach reducer", async (t) => {
  const h = harness(t); h.args.extraction.extractionComplete = false;
  await assert.rejects(reconcileSourceTopics(h.args), /complete-extraction/); assert.equal(h.calls.length, 0);
});