import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSynthesisConsolidation } from "../../src/capability/episodic/synthesis-consolidation.ts";

const options = { query: "safety", targetWing: "test", targetRoom: "test", applyWrites: true };
const richSummary = {
  transcriptId: "mapped", confidence: "high",
  durableFacts: ["A long substantive fact about the policy and substrate boundary."],
  decisions: ["Preserve sources for retry whenever live mapping produces no usable summaries."],
  rootCausesAndWorkedExamples: ["An empty source list previously searched unrelated destination syntheses."],
  subsystemsAndFiles: ["synthesis-consolidation.ts"], openItems: [],
};

for (const input of [
  { mapperSummaries: [] }, { rawEntries: [] }, { mapperSummaries: [], rawEntries: [] },
  { mapperSummaries: [], rawEntries: [{ id: "raw", text: "must not fall back" }] },
  { mapperSummaries: [richSummary], rawEntries: [] },
]) {
  test(`explicit empty input never searches or writes: ${JSON.stringify(input)}`, async () => {
    const calls = [];
    const forbidden = async () => { calls.push("external call"); throw new Error("unexpected call"); };
    const result = await runSynthesisConsolidation({
      search: forbidden, createDerivedDrawer: forbidden, kgAdd: forbidden, fileDeadEnd: forbidden,
    }, { ...options, ...input });
    assert.deepEqual(calls, []);
    assert.equal(result.inflationGuard.passed, false);
    assert.equal(result.createdNodeId, undefined);
  });
}

test("absent explicit inputs preserve search mode", async () => {
  let searches = 0;
  await runSynthesisConsolidation({ search: async () => { searches++; return { results: [] }; } }, options);
  assert.equal(searches, 1);
});

function runCaller(mode) {
  const cwd = mkdtempSync(join(tmpdir(), "es-mapper-failure-"));
  try {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks",
    fileURLToPath(new URL("../fixtures/mapper-failure-caller.mjs", import.meta.url)), mode], {
    cwd, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

for (const mode of ["unavailable", "empty"]) {
  test(`CLI total mapper failure (${mode}) leaves sources retryable and original closet intact`, () => {
    const result = runCaller(mode);
    for (const [name, calls] of Object.entries(result.calls)) if (name !== "fetch") assert.deepEqual(calls, []);
    assert.deepEqual(result.consolidationBatches, []);
    assert.deepEqual(result.allSkipped.map((item) => item.drawer_id).sort(), ["parent_a", "parent_b"]);
    const retirement = result.worklistOutput.reconsolidationRetirementsSkipped[0];
    assert.deepEqual(retirement.failedParentIds, ["parent_a", "parent_b"]);
    assert.deepEqual(result.worklistOutput.moves.processed, []);
    assert.deepEqual(result.worklistOutput.moves.failed, []);
  });
}

test("CLI partial mapping synthesizes/moves only mapped ids and blocks original retirement", () => {
  const result = runCaller("partial");
  assert.deepEqual(result.calls.search, []);
  assert.equal(result.calls.create.length, 1);
  assert.ok(result.calls.kg.some((edge) => edge.subject === "replacement" && edge.predicate === "synthesized-from" && edge.object === "parent_a"));
  assert.deepEqual(result.calls.move.map((args) => args.drawer_id), ["parent_a"]);
  assert.deepEqual(result.calls.retire, []);
  assert.deepEqual(result.allSkipped.map((entry) => entry.drawer_id), ["parent_b"]);
  assert.deepEqual(result.worklistOutput.reconsolidationRetirementsSkipped[0].failedParentIds, ["parent_b"]);
  assert.deepEqual(result.consolidationBatches[0].includedSummaryIds, ["parent_a"]);
});
