import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function runCaller(mode) {
  const cwd = mkdtempSync(join(tmpdir(), "es-strict-mapper-"));
  try {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks",
      fileURLToPath(new URL("../fixtures/strict-mapper-caller.mjs", import.meta.url)), mode], {
      cwd, encoding: "utf8", timeout: 30000,
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim());
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
for (const mode of ["truncated", "trailing", "sections", "legacy"]) {
  test(`actual CLI rejects ${mode} mapper output without writes or retirement`, () => {
    const result = runCaller(mode);
    for (const calls of Object.values(result.calls)) assert.deepEqual(calls, []);
    assert.deepEqual(result.consolidationBatches, []);
    assert.deepEqual(result.allSkipped.map((entry) => entry.drawer_id), ["parent_a", "parent_b"]);
    assert.deepEqual(result.worklistOutput.reconsolidationRetirementsSkipped[0].failedParentIds, ["parent_a", "parent_b"]);
  });
}
test("actual CLI accepts a complete chunk JSON assessment and preserves omitted parent", () => {
  const result = runCaller("valid");
  assert.equal(result.calls.create.length, 1);
  assert.ok(result.calls.kg.some((edge) => edge.subject === "replacement" && edge.predicate === "synthesized-from" && edge.object === "parent_a"));
  assert.deepEqual(result.calls.retire, []);
  assert.deepEqual(result.allSkipped.map((entry) => entry.drawer_id), ["parent_b"]);
});
