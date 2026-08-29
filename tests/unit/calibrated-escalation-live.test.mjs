import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P0-2 acceptance: Phase 16's decision API decideCalibratedEscalation is now
 * wired into the LIVE delegation path in plugin/turn-guard.ts (tool.execute.before,
 * task branch) — the site where a subagent's self-reported confidence would
 * otherwise be trusted at face value. Operator judgment: ACTIVE BY DEFAULT with a
 * neutral fallback that requires >= 5 samples per cell; below that (or on any
 * read failure / unavailable data) the existing baseline path is preserved EXACTLY.
 *
 *   1. a low-accuracy calibration cell with >= 5 samples FLIPS the decision to escalate,
 *   2. a < 5 sample cell does NOT override the baseline (neutral fallback),
 *   3. read-path failure degrades gracefully to the baseline,
 *   4. a non-test caller exists in production code (plugin/turn-guard.ts).
 *
 * The decision logic lives in adapter/memgraph.ts (decideCalibratedEscalation /
 * getCalibrationCell) — the real module the hook calls, exercised here at the
 * adapter level with a fake kg_query backend. A final source-text assertion
 * confirms the live call site exists in turn-guard (the plugin module itself
 * cannot be imported by tests due to pre-existing issues in sibling tools/ modules).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TURN_GUARD_SOURCE = readFileSync(join(HERE, "..", "..", "plugin", "turn-guard.ts"), "utf8");

const { createMemgraphClient } = await import("../../adapter/memgraph.ts");

// The same constants the live hook passes (kept in sync with plugin/turn-guard.ts).
const CALIBRATION_OVERRIDE_MIN_SAMPLES = 5;
const CALIBRATION_MIN_HIT_RATE = 0.6;
const SHAPE = "live0001";

function calibrationFacts(bucketId, outcomes) {
  return outcomes.map((o) => ({ current: true, subject: bucketId, predicate: "es-calibration-outcome", object: o }));
}

/** Build a real MemgraphClient over a fake kg_query backend keyed by entity id. */
function makeCalibrationClient(factsByBucket) {
  return createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query")) {
        const entity = String(args?.entity ?? "");
        return { facts: factsByBucket[entity] || [] };
      }
      return {};
    },
  });
}

/**
 * The exact composition the live hook performs for a delegation on `modelId`:
 * decideCalibratedEscalation with defaultAction "trust" (the baseline — trust the
 * self-report), minHitRate 0.6, and minSample 5 (the operator's >= 5 gate).
 */
async function liveCalibrationDecision(factsByBucket, modelId, reportedConfidence) {
  const client = makeCalibrationClient(factsByBucket);
  return client.decideCalibratedEscalation({
    modelId,
    shapeKey: SHAPE,
    reportedConfidence,
    defaultAction: "trust",
    minHitRate: CALIBRATION_MIN_HIT_RATE,
    minSample: CALIBRATION_OVERRIDE_MIN_SAMPLES,
  });
}

// ── (1) low-accuracy cell with >= 5 samples flips the decision to escalate ────

test("LIVE calibration: low-accuracy cell with >= 5 samples => ESCALATE (decision flips)", async () => {
  // 5 recorded outcomes for "high" reports on this shape, only 1 accepted =>
  // hitRate 0.2 < 0.6 floor. The self-report is measured unreliable, so the
  // decision must flip from the trust baseline to escalate.
  const bucket = `calibration::litellm/model-a::${SHAPE}::high`;
  const factsByBucket = { [bucket]: calibrationFacts(bucket, ["accept", "failed", "revise", "failed", "failed"]) };

  const decision = await liveCalibrationDecision(factsByBucket, "litellm/model-a", "high");
  assert.equal(decision.action, "escalate", `low-accuracy sufficient cell must escalate (got ${decision.reason})`);
  assert.ok(decision.reason.includes("measured-unreliable"), `reason must cite the measurement (got ${decision.reason})`);
  assert.equal(decision.total, 5);
  assert.ok(Math.abs(decision.hitRate - 0.2) < 1e-9);
});

test("LIVE calibration: reliable cell with >= 5 samples => TRUST (no escalation)", async () => {
  // Same sample count, but the self-reports are measured reliable (5/5 accept) =>
  // the baseline trust is CONFIRMED by measurement; no escalation.
  const bucket = `calibration::litellm/model-b::${SHAPE}::high`;
  const factsByBucket = { [bucket]: calibrationFacts(bucket, ["accept", "accept", "accept", "accept", "accept"]) };

  const decision = await liveCalibrationDecision(factsByBucket, "litellm/model-b", "high");
  assert.equal(decision.action, "trust", `reliable sufficient cell must trust (got ${decision.reason})`);
  assert.ok(decision.reason.includes("measured-reliable"), `reason must cite the measurement (got ${decision.reason})`);
});

// ── (2) < 5 sample cell does NOT override the baseline (neutral fallback) ─────

test("LIVE calibration: < 5 samples => NEUTRAL FALLBACK, baseline trust preserved", async () => {
  // Only 4 recorded outcomes — even though they are all "failed" (hitRate 0.0),
  // the cell is below the 5-sample floor, so the decision must stay at the
  // baseline (trust) and cite insufficient data. A curve built on four points
  // is confidently wrong about confidence.
  const bucket = `calibration::litellm/model-c::${SHAPE}::high`;
  const factsByBucket = { [bucket]: calibrationFacts(bucket, ["failed", "failed", "failed", "failed"]) };

  const decision = await liveCalibrationDecision(factsByBucket, "litellm/model-c", "high");
  assert.equal(decision.action, "trust", "below the 5-sample floor must NOT override the baseline (no escalation)");
  assert.ok(decision.reason.includes("insufficient-data"), `reason must cite insufficient data (got ${decision.reason})`);
});

test("LIVE calibration: zero-pair cell => NEUTRAL FALLBACK, baseline trust preserved", async () => {
  const decision = await liveCalibrationDecision({}, "litellm/model-d", "high");
  assert.equal(decision.action, "trust", "no data at all must preserve the baseline");
  assert.ok(decision.reason.includes("insufficient-data"));
});

// ── (3) read-path failure degrades gracefully to the baseline ─────────────────

test("LIVE calibration: kg_query throws => NEUTRAL FALLBACK, baseline trust preserved", async () => {
  const client = createMemgraphClient({
    callTool: async (name) => {
      if (name.endsWith("kg_query")) throw new Error("server down");
      return {};
    },
  });
  // decideCalibratedEscalation must NOT throw; the failed read reads as "no data"
  // and the decision degrades to the defaultAction (trust => baseline unchanged).
  const decision = await client.decideCalibratedEscalation({
    modelId: "litellm/model-e",
    shapeKey: SHAPE,
    reportedConfidence: "high",
    defaultAction: "trust",
    minHitRate: CALIBRATION_MIN_HIT_RATE,
    minSample: CALIBRATION_OVERRIDE_MIN_SAMPLES,
  });
  assert.equal(decision.action, "trust", "a read failure must preserve the baseline (no escalation)");
  assert.ok(decision.reason.includes("insufficient-data"), `reason must cite insufficient data (got ${decision.reason})`);
});

// ── (4) a non-test caller exists in production code ───────────────────────────

test("LIVE calibration: turn-guard hook calls decideCalibratedEscalation (non-test caller outside memgraph.ts)", () => {
  // The acceptance gate: at least one non-test, non-adapter/memgraph.ts caller.
  assert.ok(
    TURN_GUARD_SOURCE.includes("decideCalibratedEscalation("),
    "plugin/turn-guard.ts must call decideCalibratedEscalation (the live consume path)",
  );
});

test("LIVE calibration: the hook enforces the >= 5 sample gate and keeps the display path intact", () => {
  // The trust override requires at least 5 samples per cell (operator decision).
  assert.ok(
    TURN_GUARD_SOURCE.includes("CALIBRATION_OVERRIDE_MIN_SAMPLES = 5"),
    "the hook must define the 5-sample override floor",
  );
  assert.ok(
    TURN_GUARD_SOURCE.includes("minSample: CALIBRATION_OVERRIDE_MIN_SAMPLES"),
    "the hook must pass the 5-sample floor into decideCalibratedEscalation",
  );
  // The existing display/status path (getCalibrationTable -> /memory-status) is untouched.
  assert.ok(
    TURN_GUARD_SOURCE.includes("getCalibrationTable"),
    "the display path (getCalibrationTable) must remain intact in turn-guard",
  );
});
