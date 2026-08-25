import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const shouldRunIntegration = process.env.ESHEPHERD_TEST_INTEGRATION === "1";

function runScript(scriptPath, scriptArgs) {
  const stdout = execFileSync(
    "node",
    ["--experimental-strip-types", scriptPath, ...scriptArgs],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    }
  );
  return JSON.parse(stdout);
}

test("quickstart retrieval expansion returns expected envelope", { skip: !shouldRunIntegration }, () => {
  const out = runScript("scripts/run-policy-cycle.ts", [
    "--query",
    "recent architecture decisions",
    "--scope-room",
    "context-blocks",
    "--scope-wing",
    "context-blocks",
    "--labels",
    "pinned",
    "--match-mode",
    "any",
    "--top-n",
    "12",
  ]);

  assert.equal(out.scope.scope_room, "context-blocks");
  assert.equal(out.filters.match_mode, "any");
  assert.ok(Array.isArray(out.selected_nodes));
  assert.ok(Array.isArray(out.ranked_nodes));
});

test("quickstart consolidation and cadence return expected envelopes", { skip: !shouldRunIntegration }, () => {
  const consolidate = runScript("scripts/run-memory-consolidation-and-validation.ts", [
    "--no-lock",
    "--query",
    "memory consolidation candidates",
    "--wing",
    "context-blocks",
    "--room",
    "context-blocks",
    "--scope-room",
    "context-blocks",
  ]);

  assert.equal(consolidate.mode, "full-pipeline");
  // The pipeline short-circuits before the consolidation phase when the worklist
  // is empty, so `consolidation` is absent by design rather than missing. Assert
  // the phase only when there was actually something to consolidate.
  if (consolidate.worklist?.count > 0) {
    assert.equal(consolidate.consolidation.phase, "source-derived-consolidation");
    assert.equal(consolidate.validationMergeReview.phase, "validation-merge-review");
    assert.equal(typeof consolidate.memCoreApply.applied, "boolean");
  } else {
    assert.equal(consolidate.consolidation, undefined);
    assert.equal(consolidate.validationMergeReview, undefined);
  }

  const cadence = runScript("scripts/run-memory-consolidation-and-validation.ts", [
    "--no-lock",
    "--run-cadence",
    "--cadence-mode",
    "plan",
    "--query",
    "memory consolidation candidates",
    "--wing",
    "context-blocks",
    "--room",
    "context-blocks",
    "--scope-room",
    "context-blocks",
    "--current-idle-minutes",
    "25",
    "--nightly-backstop",
  ]);

  assert.equal(cadence.mode, "cadence-only");
  assert.equal(cadence.cadence.phase, "cadence-orchestrator");
  assert.ok(Array.isArray(cadence.cadence.plan));
});
