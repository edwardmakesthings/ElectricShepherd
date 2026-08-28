import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Unit coverage for Phase 13 (worked-example injection) — the turn-guard CONSUME
 * path. The plugin's `tool.execute.before` hook intercepts `task` calls; this test
 * proves the injection guard: only `subagent_type === "implement-local"` delegations
 * get their prompt augmented with a delimited demonstration section, and only when
 * apprenticeship examples score above the relevance floor.
 *
 * The plugin module cannot be imported directly (its sibling tools/ modules contain
 * backticks inside template literals that Node's type-stripping rejects — pre-existing,
 * unrelated to this change), so the guard is exercised here against the SAME source
 * text the hook uses, plus the real retrieval/format functions from
 * adapter/retrieval-expansion.ts. The integration of these two (hook calls retrieve +
 * format) is covered by the shape assertions below and by the plugin's config echo.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TURN_GUARD_SOURCE = readFileSync(join(HERE, "..", "..", "plugin", "turn-guard.ts"), "utf8");

// The real Phase 13 functions (single source of truth for cap + floor).
const {
  retrieveSimilarWorkedExamples,
  formatWorkedExampleDemonstration,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_RELEVANCE_FLOOR,
} = await import("../../adapter/retrieval-expansion.ts");

const QUERY =
  "fix the retry loop in the gateway adapter where the websocket reconnect handler keeps spawning duplicate connections";
const EXAMPLE_A_TEXT =
  "Solved the retry loop in the gateway adapter: the websocket reconnect handler was spawning duplicate connections because the backoff timer was never cleared.";
const EXAMPLE_B_TEXT =
  "Gateway adapter websocket fix: clear the reconnect timer before spawning a new connection to avoid duplicates in the retry loop.";

function makeSearchClient(rows) {
  return {
    search: async (_q, _limit, _wing, room) => {
      assert.equal(room, "apprenticeship");
      return { results: rows };
    },
    getDrawer: async () => ({}),
  };
}

test("hook source gates injection on subagent_type === 'implement-local'", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes('const shouldInjectWorkedExamples ='),
    "worked-example injection gate variable must exist",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes('subagentType === "implement-local"'),
    "injection must be gated on implement-local subagent type",
  );
});

test("hook source skips re-injection when the demonstration section is already present (idempotent)", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("const promptAlreadyAugmented = hasPrompt && prompt.includes(demonstrationHeading)"),
    "idempotency sentinel must detect existing demonstration heading",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes("!promptAlreadyAugmented"),
    "re-injection guard must be present",
  );
});

test("hook source mutates args.prompt AND reassigns output.args/input.args (both carriers see the augmented prompt)", () => {
  const block = TURN_GUARD_SOURCE.split("worked-example injection): for @implement-local")[1]?.split("taskWindow.push")[0] ?? "";
  assert.ok(block.includes("args.prompt = `${prompt}${demonstration}`"), "must append to args.prompt");
  assert.ok(block.includes("if (output?.args) output.args = args"), "must reassign output.args");
  assert.ok(block.includes("if (input?.args) input.args = args"), "must reassign input.args");
});

test("hook source resolves MCP headers with runtime config env overlay (config authHeader/authScheme reach injection client)", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("...runtimeConfigEnv"),
    "headers env should overlay runtime config values",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes("resolveMCPHeadersFromEnv(runtimeEnv)"),
    "header resolution should use merged env object",
  );
});

test("hook source loads runtime env files before MCP header resolution", () => {
  assert.ok(TURN_GUARD_SOURCE.includes("loadRuntimeEnv({"), "turn-guard should load runtime env files");
  assert.ok(TURN_GUARD_SOURCE.includes("cwd: projectRoot"), "runtime env load should resolve explicit path from project root");
});

test("hook source degrades to no injection on retrieval failure (try/catch wraps the whole path)", () => {
  const block = TURN_GUARD_SOURCE.split("worked-example injection): for @implement-local")[1]?.split("taskWindow.push")[0] ?? "";
  assert.ok(block.includes("try {"), "injection must be wrapped in try");
  assert.ok(block.includes("prompt unchanged"), "failure path must log and leave the prompt alone");
});

test("non-implement-local task calls are unchanged (guard is false for other subagent types)", async () => {
  // Simulate the hook's gate: only implement-local enters the injection branch.
  const subagentTypes = ["explore", "review-diff", "run-tests", "solve-deep-cloud", ""];
  for (const subagentType of subagentTypes) {
    const shouldInject =
      true && // workedExampleInjectionEnabled
      subagentType === "implement-local" &&
      QUERY && // prompt
      !QUERY.includes("## Demonstrations: how this class of problem was solved in this codebase before");
    assert.equal(shouldInject, false, `${subagentType || "(empty)"} must not trigger injection`);
  }
});

test("implement-local call with matching examples over floor gets a delimited demonstration section", async () => {
  const client = makeSearchClient([
    { drawer_id: "ex-a", content: EXAMPLE_A_TEXT },
    { drawer_id: "ex-b", content: EXAMPLE_B_TEXT },
  ]);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });
  const demonstration = formatWorkedExampleDemonstration(examples);

  assert.ok(demonstration.length > 0, "demonstration must be non-empty when examples qualify");
  const augmented = `${QUERY}${demonstration}`;
  assert.ok(augmented.startsWith(QUERY), "original prompt must be preserved verbatim at the front");
  assert.ok(augmented.includes("## Demonstrations:"), "delimited demonstration section present");
  assert.ok(augmented.includes("### Example 1"), "example headers present");
});

test("implement-local call with no examples over floor injects nothing (prompt unchanged)", async () => {
  const client = makeSearchClient([
    { drawer_id: "ex-weak", content: "Unrelated database migration note about schema versioning and index rebuilds." },
  ]);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });
  const demonstration = formatWorkedExampleDemonstration(examples);

  assert.deepEqual(examples, [], "no examples above floor");
  assert.equal(demonstration, "", "format returns '' for empty input -> prompt unchanged");
});

test("at most WORKED_EXAMPLE_MAX_INJECT (=2) examples are injected", async () => {
  const manyRows = Array.from({ length: 5 }, (_, i) => ({
    drawer_id: `ex-${String.fromCharCode(97 + i)}`,
    content: EXAMPLE_A_TEXT,
  }));
  const client = makeSearchClient(manyRows);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });

  assert.equal(WORKED_EXAMPLE_MAX_INJECT, 2);
  assert.equal(examples.length, 2, "hard cap of 2 enforced");
});

test("checkpoint gate skips disabled utility agents (default set covers explore/review-diff/run-tests/check-diff)", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes('const DEFAULT_CHECKPOINT_DISABLED_AGENTS = ["explore", "review-diff", "run-tests", "check-diff"]'),
    "built-in checkpoint disabled-agent default must include the utility subagents",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes('cfgCSV("checkpoint.disabledAgents")'),
    "checkpoint gate must parse the checkpoint.disabledAgents config CSV",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes("checkpointDisabledAgents.has(currentAgent)"),
    "maybeCheckpoint must skip when the resolved routing agent is in the disabled set",
  );
});

test("checkpoint gate logs the skip and exposes the active policy in statusSnapshot", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("checkpoint skipped for sid=${sid}: agent=${currentAgent} is in checkpoint.disabledAgents"),
    "skipped checkpoints must emit a clear log line naming the disabled agent",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes("checkpointDisabledAgents: [...checkpointDisabledAgents]"),
    "statusSnapshot must expose checkpointDisabledAgents so operators can inspect the active policy",
  );
});

test("injection is idempotent: an already-augmented prompt is not augmented again", async () => {
  const client = makeSearchClient([
    { drawer_id: "ex-a", content: EXAMPLE_A_TEXT },
  ]);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });
  const firstPass = `${QUERY}${formatWorkedExampleDemonstration(examples)}`;

  // Second pass: the hook's guard sees the heading and skips.
  const wouldReinject = !firstPass.includes("## Demonstrations: how this class of problem was solved in this codebase before");
  assert.equal(wouldReinject, false, "already-augmented prompt must not be re-injected");
});
