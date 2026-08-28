import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Unit coverage for Phase 13 CREATE — worked-example filing on successful
 * implementation subagent completion. Validates:
 *   (a) only cloud target subagent types trigger filing (NOT apprentice flows)
 *   (b) success-only gating
 *   (c) source-type stamping = worked-example
 *   (d) shape metadata present + deterministic
 *   (e) duplicate suppression
 *   (f) graceful degradation on diary/stamp failure
 *
 * The plugin module cannot be imported directly (pre-existing backtick-in-template-literal
 * issues in sibling tools/ modules), so the filing logic is exercised against the SAME
 * source text the hook uses, plus the real shape/entry functions from
 * adapter/retrieval-expansion.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TURN_GUARD_SOURCE = readFileSync(join(HERE, "..", "..", "plugin", "turn-guard.ts"), "utf8");

// The real Phase 13 CREATE functions (single source of truth for shape + entry).
const {
  extractWorkedExampleShape,
  buildWorkedExampleEntry,
  WORKED_EXAMPLE_FILE_AGENT_TYPES,
  WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
  WORKED_EXAMPLE_ENTRY_MAX_CHARS,
} = await import("../../adapter/retrieval-expansion.ts");

// --- (a) Only cloud target subagent types trigger filing ---

test("WORKED_EXAMPLE_FILE_AGENT_TYPES contains exactly implement-cloud, build-cloud", () => {
  assert.equal(WORKED_EXAMPLE_FILE_AGENT_TYPES.size, 2);
  assert.ok(WORKED_EXAMPLE_FILE_AGENT_TYPES.has("implement-cloud"));
  assert.ok(WORKED_EXAMPLE_FILE_AGENT_TYPES.has("build-cloud"));
});

test("hook source gates filing on WORKED_EXAMPLE_FILE_AGENT_TYPES", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("WORKED_EXAMPLE_FILE_AGENT_TYPES.has(subagentType)"),
    "filing must be gated on the target subagent type set",
  );
});

test("hook source does NOT file for non-target subagent types (explore, review-diff)", () => {
  assert.ok(!WORKED_EXAMPLE_FILE_AGENT_TYPES.has("explore"));
  assert.ok(!WORKED_EXAMPLE_FILE_AGENT_TYPES.has("review-diff"));
  assert.ok(!WORKED_EXAMPLE_FILE_AGENT_TYPES.has("run-tests"));
});

test("apprentice flows (implement-local, build) do NOT trigger filing — they consume examples, not produce them", () => {
  assert.ok(
    !WORKED_EXAMPLE_FILE_AGENT_TYPES.has("implement-local"),
    "implement-local must not file worked examples",
  );
  assert.ok(!WORKED_EXAMPLE_FILE_AGENT_TYPES.has("build"), "build must not file worked examples");
});

// --- (b) Success-only gating ---

test("hook source skips filing on error/aborted/failed status", () => {
  const successGate = TURN_GUARD_SOURCE.match(
    /if \(status === "error" \|\| status === "aborted" \|\| status === "failed"\) continue/,
  );
  assert.ok(successGate, "filing must skip error/aborted/failed task statuses");
});

test("hook source requires substantive output (>= WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS)", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS"),
    "filing must require a minimum output length",
  );
  assert.ok(WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS >= 100, "minimum should be at least 100 chars");
});

// --- (c) Source-type stamping = worked-example ---

test("hook source stamps es-source-type: worked-example via kg_add", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes('predicate: "es-source-type"'),
    "stamp must use es-source-type predicate",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes('object: "worked-example"'),
    "stamp object must be 'worked-example' (distinct knowledge class from skill)",
  );
});

test("hook source does NOT stamp worked examples as skill", () => {
  const filingBlock = TURN_GUARD_SOURCE.split("async function maybeFileWorkedExample(")[1]?.split("\n  }\n")[0] ?? "";
  assert.ok(
    !filingBlock.includes('object: "skill"'),
    "filing path must not stamp es-source-type: skill",
  );
});

test("hook source calls diary_write to the apprenticeship room", () => {
  assert.ok(TURN_GUARD_SOURCE.includes('room = "apprenticeship"'), "filing must target the apprenticeship room");
  assert.ok(TURN_GUARD_SOURCE.includes("palaceClient.diaryWrite"), "filing must call diaryWrite");
});

test("hook source documents that worked-example is a distinct knowledge class from skill", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("distinct knowledge class"),
    "code comment must document the worked-example vs skill rationale",
  );
});

// --- (d) Shape metadata present + deterministic ---

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

// --- (e) Duplicate suppression ---

test("hook source implements in-session dedup by shape key", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("workedExampleFiledByShape"),
    "must track filed shapes per session",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes("skipping near-duplicate shape"),
    "must log when skipping a near-duplicate",
  );
});

test("hook source uses a 30-minute dedup window", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("30 * 60 * 1000"),
    "dedup window must be 30 minutes",
  );
});

// --- (f) Graceful degradation on diary/stamp failure ---

test("hook source wraps filing in try/catch (never throws into the turn)", () => {
  const catchBlock = TURN_GUARD_SOURCE.match(
    /catch \(err\) \{\s*\/\/ Filing failure must never break the turn\./,
  );
  assert.ok(catchBlock, "filing must be wrapped in try/catch with a non-fatal comment");
});

test("hook source logs stamp failure as non-fatal", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("stamp failed (non-fatal)"),
    "stamp failures must be logged as non-fatal",
  );
});

test("hook source degrades gracefully when palace client is null", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("!palaceClient || typeof palaceClient.diaryWrite !== \"function\""),
    "must check client availability before filing",
  );
});

// --- Integration: the idle hook calls the filing function ---

test("hook source calls maybeFileWorkedExamplesFromMessage on session.idle", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("await maybeFileWorkedExamplesFromMessage(sid, last)"),
    "idle handler must call the filing scanner",
  );
});

test("hook source config echo includes workedExampleFilingEnabled", () => {
  assert.ok(
    TURN_GUARD_SOURCE.includes("workedExampleFilingEnabled,"),
    "config echo must include the filing flag",
  );
});
