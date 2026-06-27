import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandExecutionPlan, normalizeCommandSpec } from "../../adapter/turn-guard-helpers.ts";

test("normalizeCommandSpec accepts a simple executable path", () => {
  const spec = normalizeCommandSpec("node scripts/run-policy-cycle.ts");
  assert.deepEqual(spec, {
    mode: "exec",
    command: "node",
    args: ["scripts/run-policy-cycle.ts"],
  });
});

test("normalizeCommandSpec rejects a shell metacharacter payload", () => {
  const spec = normalizeCommandSpec("node scripts/run-policy-cycle.ts && rm -rf /");
  assert.deepEqual(spec, {
    mode: "rejected",
    reason: "shell-metacharacter",
  });
});

test("normalizeCommandSpec rejects an undefined command input", () => {
  const spec = normalizeCommandSpec(undefined);
  assert.deepEqual(spec, {
    mode: "rejected",
    reason: "empty-command",
  });
});

test("buildCommandExecutionPlan preserves a safe exec-only command", () => {
  const plan = buildCommandExecutionPlan({
    configured: "node scripts/run-policy-cycle.ts",
    projectRoot: "/tmp/repo",
    defaultScript: "/tmp/repo/scripts/capture-source-transcripts.sh",
  });

  assert.equal(plan.mode, "exec");
  assert.equal(plan.command, "node");
  assert.deepEqual(plan.args, ["scripts/run-policy-cycle.ts"]);
});

test("buildCommandExecutionPlan rejects a shell string with unsafe content", () => {
  const plan = buildCommandExecutionPlan({
    configured: "bash ./scripts/capture-source-transcripts.sh && echo hi",
    projectRoot: "/tmp/repo",
    defaultScript: "/tmp/repo/scripts/capture-source-transcripts.sh",
  });

  assert.equal(plan.mode, "rejected");
  assert.equal(plan.reason, "shell-metacharacter");
});
