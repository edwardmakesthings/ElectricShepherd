import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestDrawerText } from "../../src/scripts/memory-pipeline/raw-text-worker.ts";
import { WorkerFailure } from "../../src/scripts/memory-pipeline/omp-completion.ts";
import { buildMemcoreMarkdown } from "../../src/scripts/memory-pipeline/memcore-render.ts";
const valid = "The source confirms the proposal was canceled and the existing architecture should remain unchanged.";
test("downstream mem-core uses raw synthesis pointers, never fabricated fact/task sections", () => {
  const markdown = buildMemcoreMarkdown({ query: "source", consolidation: { route: "raw-text", content: valid,
    query: "source", sourceDrawerIds: ["parent"], createdNodeId: "synthesis", provenance: {}, substanceGuard: { passed: true } },
    validation: { downwardValidation: [], mergeAdjudications: [], escalations: { reasons: [], nodeIds: [], mergePairs: [], notified: false } } });
  assert.ok(markdown.includes("node_id:synthesis")); assert.ok(markdown.includes("Not extracted from raw text"));
  assert.ok(!markdown.includes(valid));
});
for (const category of ["transport", "timeout", "empty", "length", "error"]) {
  test("safe observed failure retries once: " + category, async () => {
    let calls = 0; const records = [];
    assert.equal(await requestDrawerText({ records, invoke: async ({ attempt, timeoutMs }) => {
      assert.equal(attempt, ++calls); assert.ok(timeoutMs <= 900000);
      if (attempt === 1) throw new WorkerFailure(category, true, category); return valid;
    } }), valid);
    assert.equal(calls, 2); assert.equal(records[0].category, category); assert.equal(records[1].outcome, "accepted");
  });
}
test("exhaustion, unclassified failures and tool-use are bounded", async () => {
  for (const [error, expected] of [[new WorkerFailure("timeout", true), 2], [new WorkerFailure("tool-use", true), 1], [new Error("unknown"), 1]]) {
    let calls = 0; await assert.rejects(requestDrawerText({ records: [], invoke: async () => { calls++; throw error; } })); assert.equal(calls, expected);
  }
});
test("deadline bounds attempt timeout and prevents retry after expiry", async () => {
  let calls = 0; const records = [], deadlineMs = Date.now() + 30;
  await assert.rejects(requestDrawerText({ records, deadlineMs, invoke: async ({ timeoutMs }) => {
    calls++; assert.ok(timeoutMs <= 30); await new Promise(resolve => setTimeout(resolve, 40)); throw new WorkerFailure("timeout", true);
  } }), /deadline/); assert.equal(calls, 1);
  await assert.rejects(requestDrawerText({ records: [], deadlineMs: Date.now() - 1, invoke: async () => { throw new Error("must not call"); } }), /deadline/);
});
test("expired successful response cannot become admitted coverage", async () => {
  await assert.rejects(requestDrawerText({ records: [], deadlineMs: Date.now() + 10,
    invoke: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return valid; } }), /deadline/);
});
test("secure rejection audit contains hashes/categories, no raw content, secrets or reasoning", async t => {
  const directory = mkdtempSync(join(tmpdir(), "es-attempt-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(requestDrawerText({ records: [], auditDirectory: directory, operationId: "test", invoke: async () => "secret=private" }), /insubstantial/);
  const path = join(directory, readdirSync(directory)[0]), record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(record.category, "insubstantial");
  assert.equal(record.rejection.bytes, 14); assert.match(record.rejection.hash, /^[a-f0-9]{64}$/);
  assert.ok(!readFileSync(path, "utf8").includes("private"));
});
