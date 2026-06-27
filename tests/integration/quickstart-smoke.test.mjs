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
      env: { ...process.env, ESHEPHERD_CONSOLIDATION_LOCK_DISABLED: "1" },
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
  assert.equal(consolidate.consolidation.phase, "source-derived-consolidation");
  assert.equal(consolidate.validationMergeReview.phase, "validation-merge-review");
  assert.equal(typeof consolidate.memCoreApply.applied, "boolean");

  const cadence = runScript("scripts/run-memory-consolidation-and-validation.ts", [
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
