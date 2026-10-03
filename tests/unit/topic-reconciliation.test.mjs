import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileSourceTopics } from "../../src/scripts/memory-pipeline/topic-reconciliation.ts";
import { reconciliationResponse, deltaResponse } from "../fixtures/topic-reconciliation-mock.mjs";

const topic = { topicKey: "architecture", title: "Project migration", confidence: "high",
  durableFacts: ["A source-authored migration plan exists."], decisions: ["Perform compatibility review first."],
  rootCausesAndWorkedExamples: [], subsystemsAndFiles: [], openItems: ["Await a source-authored migration decision."], deadEnds: [] };
const extraction = { parentDrawerId: "parent", sourceVersion: "source-hash", extractionComplete: true,
  assessments: [{ chunkId: "chunk-0" }, { chunkId: "chunk-1" }], failures: [],
  topics: [{ topicKey: topic.topicKey, parentDrawerId: "parent", contributingChunkIds: ["chunk-0"], insights: [{ chunkId: "chunk-0", pieceIndex: 0, topic }] }],
  contextualEvidence: [{ chunkId: "chunk-1", pieceIndex: 0, kind: "resolution", origin: "source", text: "Migration canceled, not completed.", sourceQuote: "Migration canceled." }] };
function setup(t) {
  const checkpointDirectory = mkdtempSync(join(tmpdir(), "es-reconcile-"));
  t.after(() => rmSync(checkpointDirectory, { recursive: true, force: true }));
  const calls = [];
  return { calls, args: { extraction, checkpointDirectory, reducerVersion: "mock-model/prompt-v1",
    reconcileTopic: async (prompt) => { const input = JSON.parse(prompt.split("\n").at(-1)); calls.push(input); return reconciliationResponse(input); } } };
}
test("reducer identity and source hashes invalidate reducer checkpoints; matching identity resumes without calls", async (t) => {
  const h = setup(t);
  const first = await reconcileSourceTopics(h.args);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(await reconcileSourceTopics(h.args), first);
  assert.equal(h.calls.length, 2);
  const second = await reconcileSourceTopics({ ...h.args, reducerVersion: "mock-model/prompt-v2" });
  assert.equal(h.calls.length, 4);
  assert.notEqual(second.reconciliationVersion, first.reconciliationVersion);
  const changed = await reconcileSourceTopics({ ...h.args, reducerVersion: "mock-model/prompt-v2", extraction: { ...extraction, sourceVersion: "changed-source" } });
  assert.equal(h.calls.length, 6);
  assert.notEqual(changed.reconciliationVersion, second.reconciliationVersion);
});
test("tampered cached reducer receipt is rejected, never silently reclassified or overwritten", async (t) => {
  const h = setup(t);
  await reconcileSourceTopics(h.args);
  const file = join(h.args.checkpointDirectory, readdirSync(h.args.checkpointDirectory)[0]);
  const checkpoint = JSON.parse(readFileSync(file, "utf8"));
  const response = JSON.parse(checkpoint.responses.architecture[1]);
  response.receipt.evidenceId = "unrequested-evidence";
  checkpoint.responses.architecture[1] = JSON.stringify(response);
  writeFileSync(file, JSON.stringify(checkpoint));
  await assert.rejects(reconcileSourceTopics(h.args), /reconciliation-evidence-gap/);
  assert.equal(h.calls.length, 2);
});
test("reducer cannot invent a negative drawer assertion absent from supplied topic evidence", async (t) => {
  const h = setup(t);
  await assert.rejects(reconcileSourceTopics({ ...h.args, reconcileTopic: async (prompt) => {
    const value = JSON.parse(reconciliationResponse(JSON.parse(prompt.split("\n").at(-1))));
    value.add.deadEnds = ['- Reuse partial parent coverage | outcome: minority topic disappeared | because: "only the first topic was checked" | polarity: tried-failed'];
    return JSON.stringify(value);
  } }), /reconciliation-invented-dead-end/);
});

test("growing topic keeps prompts and model responses bounded; last step output is a small delta", async (t) => {
  const many = Array.from({ length: 6 }, (_v, index) => ({ chunkId: "chunk-" + index }));
  const grown = { ...extraction, assessments: many, contextualEvidence: [],
    topics: [{ topicKey: "architecture", parentDrawerId: "parent", contributingChunkIds: [], insights: many.map((chunk, index) => ({ chunkId: chunk.chunkId, pieceIndex: 0,
      topic: { ...topic, openItems: [], durableFacts: ["F".repeat(280) + index], decisions: ["D".repeat(280) + index] } })) }] };
  const sizes = [];
  const h = setup(t);
  const result = await reconcileSourceTopics({ ...h.args, extraction: grown, reconcileTopic: async (prompt) => {
    const input = JSON.parse(prompt.split("\n").at(-1));
    const response = reconciliationResponse(input);
    sizes.push(Buffer.byteLength(response));
    return response;
  } });
  assert.ok(Math.max(...sizes) < 2_500, "response size tracks the delta, not the accumulated state: " + sizes);
  assert.equal(result.topics[0].topic.durableFacts.length, 6);
  assert.ok(result.topics[0].receipts.length === 6);
});
test("truncated or non-delta reducer output fails closed", async (t) => {
  const h = setup(t);
  await assert.rejects(reconcileSourceTopics({ ...h.args, reconcileTopic: async () => '{"schemaVersion":1,"add":{"durableFacts":["x' }));
  await assert.rejects(reconcileSourceTopics({ ...h.args, reconcileTopic: async (prompt) => {
    const value = JSON.parse(reconciliationResponse(JSON.parse(prompt.split("\n").at(-1))));
    value.remove.durableFacts = [99];
    return JSON.stringify(value);
  } }), /invalid-reconciliation-delta/);
});
test("array reducer envelope is rejected, not coerced; one bounded retry recovers a valid object", async (t) => {
  const h = setup(t);
  let calls = 0;
  const arrayOnce = async (prompt) => { calls++;
    const body = reconciliationResponse(JSON.parse(prompt.split("\n").at(-1)));
    return calls === 1 ? "[" + body + "]" : body; };
  const ok = await reconcileSourceTopics({ ...h.args, reconcileTopic: arrayOnce });
  assert.ok(ok.reconciliationComplete);
  assert.equal(calls, 3, "first step retried once (2 calls) + second step (1 call)");
  const always = [];
  await assert.rejects(reconcileSourceTopics({ ...h.args, reducerVersion: "other",
    reconcileTopic: async (prompt) => { always.push(1); return "[" + reconciliationResponse(JSON.parse(prompt.split("\n").at(-1))) + "]"; } }),
  /invalid-reconciliation-response-shape/);
  assert.equal(always.length, 2, "exactly one retry, then fail closed");
  let n = 0;
  await assert.rejects(reconcileSourceTopics({ ...h.args, reducerVersion: "third",
    reconcileTopic: async () => { n++; return '{"schemaVersion":1,"add":{"durableFacts":["x'; } }));
  assert.equal(n, 1, "non-shape failures are not retried");
});
test("a delta cannot add or alter open items", async (t) => {
  const h = setup(t);
  await assert.rejects(reconcileSourceTopics({ ...h.args, reconcileTopic: async (prompt) => {
    const value = JSON.parse(reconciliationResponse(JSON.parse(prompt.split("\n").at(-1))));
    value.add.openItems = ["invented"];
    return JSON.stringify(value);
  } }), /unsupported-reconciliation-open-task/);
});
test("accumulation beyond section capacity fails closed instead of silently dropping", async (t) => {
  const many = Array.from({ length: 9 }, (_v, index) => ({ chunkId: "chunk-" + index }));
  const grown = { ...extraction, assessments: many, contextualEvidence: [],
    topics: [{ topicKey: "architecture", parentDrawerId: "parent", contributingChunkIds: [], insights: many.map((chunk, index) => ({ chunkId: chunk.chunkId, pieceIndex: 0,
      topic: { ...topic, openItems: [], durableFacts: ["fact " + index] } })) }] };
  await assert.rejects(reconcileSourceTopics({ ...setup(t).args, extraction: grown }), /reconciliation-section-capacity/);
});

test("rejected global context truncates by model-response index when a reader-window record is skipped; retry is not stuck on cache", async (t) => {
  const h = setup(t);
  const windowed = { ...extraction, assessments: [{ chunkId: "chunk-0" }, { chunkId: "chunk-1" }, { chunkId: "chunk-2" }],
    contextualEvidence: [
      { chunkId: "chunk-1", pieceIndex: 0, kind: "qualifier", origin: "reader-window", text: "Id cut at window edge.", sourceQuote: "drawer_x" },
      { chunkId: "chunk-2", pieceIndex: 0, kind: "resolution", origin: "source", text: "Migration canceled, not completed.", sourceQuote: "Migration canceled." }] };
  await assert.rejects(reconcileSourceTopics({ ...h.args, extraction: windowed, reconcileTopic: async (prompt) => {
    const input = JSON.parse(prompt.split("\n").at(-1));
    return deltaResponse(input, { add: input.evidence.topic ? { durableFacts: input.evidence.topic.durableFacts, decisions: input.evidence.topic.decisions } : undefined, disposition: input.evidence.context ? "unrelated" : "incorporated",
      openTaskIds: input.evidence.context ? input.eligibleOpenTasks.map((task) => task.taskId) : undefined });
  } }), /context-not-reconciled/);
  const checkpoint = JSON.parse(readFileSync(join(h.args.checkpointDirectory, readdirSync(h.args.checkpointDirectory)[0]), "utf8"));
  assert.equal(checkpoint.responses.architecture.length, 1, "only the seed response survives; the rejected source-context response is gone");
  const result = await reconcileSourceTopics({ ...h.args, extraction: windowed });
  assert.deepEqual(result.topics[0].receipts.map((receipt) => receipt.disposition), ["incorporated", "boundary-only", "resolved"]);
  assert.deepEqual(result.topics[0].contributingChunkIds, ["chunk-0", "chunk-2"], "boundary-only chunk is not a contribution");
});
test("reducer response must be a strict delta object: legacy full topic, missing or primitive containers are rejected", async (t) => {
  for (const mutate of [
    (v) => { delete v.add; delete v.remove; v.topic = topic; },
    (v) => { v.topic = topic; },
    (v) => { v.add = null; },
    (v) => { v.remove = "x"; },
    (v) => { v.add = []; },
    (v) => { delete v.remove; },
    (v) => { v.receipt = "ok"; },
  ]) {
    const h = setup(t);
    await assert.rejects(reconcileSourceTopics({ ...h.args, reconcileTopic: async (prompt) => {
      const value = JSON.parse(reconciliationResponse(JSON.parse(prompt.split("\n").at(-1))));
      mutate(value);
      return JSON.stringify(value);
    } }), /invalid-reconciliation-delta/);
  }
});
