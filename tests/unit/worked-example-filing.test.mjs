import assert from "node:assert/strict";
import test from "node:test";

/**
 * Unit coverage for Phase 13 CREATE — worked-example filing on successful
 * implementation subagent completion. Validates:
 *   (a) only cloud target subagent types trigger filing (NOT apprentice flows)
 *   (b) success-only gating + substantive-output floor
 *   (c) near-duplicate suppression window
 *   (d) shape metadata present + deterministic
 *
 * The plugin module cannot be imported directly (pre-existing backtick-in-template-literal
 * issues in sibling tools/ modules), so the filing decision gates are exercised
 * against the real pure helpers from adapter/turn-guard-helpers.ts, plus the real
 * shape/entry functions from adapter/retrieval-expansion.ts.
 */

// The real Phase 13 CREATE functions (single source of truth for shape + entry).
const {
  extractWorkedExampleShape,
  buildWorkedExampleEntry,
  WORKED_EXAMPLE_FILE_AGENT_TYPES,
  WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
  WORKED_EXAMPLE_ENTRY_MAX_CHARS,
} = await import("../../src/capability/retrieval/retrieval-expansion.ts");

// --- (a) Only cloud target subagent types trigger filing ---

test("WORKED_EXAMPLE_FILE_AGENT_TYPES contains exactly implement-cloud, build-cloud", () => {
  assert.equal(WORKED_EXAMPLE_FILE_AGENT_TYPES.size, 2);
  assert.ok(WORKED_EXAMPLE_FILE_AGENT_TYPES.has("implement-cloud"));
  assert.ok(WORKED_EXAMPLE_FILE_AGENT_TYPES.has("build-cloud"));
});

// The real filing decision helpers (single source of truth for the gates).
const { shouldFileWorkedExample, shouldSkipWorkedExampleByCooldown } = await import("../../src/surface/turn-guard-helpers.ts");

test("shouldFileWorkedExample files only for target subagent types with substantive output", () => {
  const substantive = "x".repeat(WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS);
  assert.equal(
    shouldFileWorkedExample({ enabled: true, isTargetSubagentType: true, output: substantive, minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS }),
    true,
    "target type + sufficient output must file",
  );
  assert.equal(
    shouldFileWorkedExample({ enabled: true, isTargetSubagentType: false, output: substantive, minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS }),
    false,
    "non-target subagent types must not file",
  );
});

test("shouldFileWorkedExample requires substantive output (>= WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS)", () => {
  assert.equal(WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS >= 100, true, "minimum should be at least 100 chars");
  const justBelow = "x".repeat(WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS - 1);
  const exactly = "x".repeat(WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS);
  assert.equal(
    shouldFileWorkedExample({ enabled: true, isTargetSubagentType: true, output: justBelow, minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS }),
    false,
    "output one char below the floor must not file",
  );
  assert.equal(
    shouldFileWorkedExample({ enabled: true, isTargetSubagentType: true, output: exactly, minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS }),
    true,
    "output at the floor must file",
  );
});

test("shouldFileWorkedExample respects the config gate and trims whitespace before measuring", () => {
  const substantive = `  ${"x".repeat(WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS)}  `;
  assert.equal(
    shouldFileWorkedExample({ enabled: false, isTargetSubagentType: true, output: substantive, minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS }),
    false,
    "disabled filing must never file",
  );
  assert.equal(
    shouldFileWorkedExample({ enabled: true, isTargetSubagentType: true, output: substantive, minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS }),
    true,
    "surrounding whitespace must not count against the floor",
  );
});

test("shouldSkipWorkedExampleByCooldown enforces the near-duplicate window (30 minutes in the plugin)", () => {
  const COOLDOWN_MS = 30 * 60 * 1000;
  assert.equal(
    shouldSkipWorkedExampleByCooldown({ nowMs: 1000, lastFiledAtMs: 0, cooldownMs: COOLDOWN_MS }),
    false,
    "no prior filing (lastFiledAtMs=0) must never skip",
  );
  assert.equal(
    shouldSkipWorkedExampleByCooldown({ nowMs: 1000 + COOLDOWN_MS - 1, lastFiledAtMs: 1000, cooldownMs: COOLDOWN_MS }),
    true,
    "a filing inside the window must be skipped",
  );
  assert.equal(
    shouldSkipWorkedExampleByCooldown({ nowMs: 1000 + COOLDOWN_MS, lastFiledAtMs: 1000, cooldownMs: COOLDOWN_MS }),
    false,
    "a filing at/after the window must not be skipped",
  );
});



test("extractWorkedExampleShape returns all required fields", () => {
  const shape = extractWorkedExampleShape("Fix the websocket reconnect bug in gateway.ts");
  assert.ok(shape.workClass, "must have workClass");
  assert.ok(Array.isArray(shape.fileTypes), "must have fileTypes array");
  assert.ok(Array.isArray(shape.hardAreas), "must have hardAreas array");
  assert.ok(Array.isArray(shape.keyTokens), "must have keyTokens array");
  assert.ok(typeof shape.shapeKey === "string" && shape.shapeKey.length > 0, "must have shapeKey");
});

test("extractWorkedExampleShape is deterministic (same input → same output)", () => {
  const prompt = "Fix the retry loop in the gateway adapter where the websocket reconnect handler keeps spawning duplicate connections";
  const a = extractWorkedExampleShape(prompt);
  const b = extractWorkedExampleShape(prompt);
  assert.deepEqual(a, b, "same input must produce identical shape");
});

test("extractWorkedExampleShape detects bug-fix work class", () => {
  const shape = extractWorkedExampleShape("Fix the broken retry logic in the connection handler");
  assert.equal(shape.workClass, "bug-fix");
});

test("extractWorkedExampleShape detects file types", () => {
  const shape = extractWorkedExampleShape("Update the TypeScript config in tsconfig.json and the Python script solver.py");
  assert.ok(shape.fileTypes.includes(".json"), "should detect .json");
  assert.ok(shape.fileTypes.includes(".py"), "should detect .py");
});

test("extractWorkedExampleShape detects hard areas", () => {
  const shape = extractWorkedExampleShape("Fix the async race condition in the websocket handler");
  assert.ok(shape.hardAreas.includes("async"), "should detect async");
  assert.ok(shape.hardAreas.includes("concurrency"), "should detect concurrency (race condition)");
});

test("extractWorkedExampleShape produces different keys for different problem shapes", () => {
  const a = extractWorkedExampleShape("Fix the broken retry logic in the connection handler");
  const b = extractWorkedExampleShape("Add a new feature to the user dashboard component");
  assert.notEqual(a.shapeKey, b.shapeKey, "different problems must produce different shape keys");
});

test("buildWorkedExampleEntry includes DESC line and SHAPE metadata", () => {
  const shape = extractWorkedExampleShape("Fix the websocket reconnect bug in gateway.ts");
  const entry = buildWorkedExampleEntry({
    subagentType: "implement-local",
    description: "Fix websocket reconnect",
    output: "Fixed the reconnect handler by clearing the backoff timer before spawning a new connection. The root cause was that the timer was never invalidated when a new socket was created, causing duplicate connections to accumulate.",
    shape,
  });
  assert.ok(entry.startsWith("DESC:"), "entry must lead with DESC line");
  assert.ok(entry.includes("SHAPE:"), "entry must include SHAPE metadata line");
  assert.ok(entry.includes("work-class=bug-fix"), "SHAPE must include work class");
});

test("buildWorkedExampleEntry respects max chars", () => {
  const shape = extractWorkedExampleShape("Fix the bug");
  const longOutput = "x".repeat(5000);
  const entry = buildWorkedExampleEntry({
    subagentType: "implement-local",
    description: "test",
    output: longOutput,
    shape,
  });
  assert.ok(entry.length <= WORKED_EXAMPLE_ENTRY_MAX_CHARS, `entry must be <= ${WORKED_EXAMPLE_ENTRY_MAX_CHARS} chars (got ${entry.length})`);
});
