import assert from "node:assert/strict";
import test from "node:test";

/**
 * Unit coverage for Phase 16 (confidence calibration).
 *
 * CREATE (write path): two surfaces.
 *   1. turn-guard captures the self-reported confidence label from a completed
 *      subagent's terminal output and queues it as a PENDING calibration tuple
 *      (model, shapeKey, confidence) session-locally. No proxy outcome labels —
 *      the durable es-calibration-outcome edge is written ONLY by the
 *      human-authoritative record_outcome path.
 *   2. tools/record_outcome.ts: when an operator records an es-outcome with
 *      matching model_id/task_shape/confidence args, the SAME outcome value is
 *      ALSO persisted as an es-calibration-outcome edge on the per-model bucket.
 *
 * CONSUME (read path): MemgraphClient.getCalibrationCell / getCalibrationTable /
 * decideCalibratedEscalation aggregate calibration tuples per (model, shapeKey,
 * confidence) with a 20-pair minimum-sample gate. Below the threshold, every
 * consumer reports "insufficient data" and falls back to default behaviour.
 */

// The real Phase 16 helpers (single source of truth for confidence parse + bucket id).
const {
  CONFIDENCE_VALUES,
  parseSelfReportedConfidence,
  buildCalibrationBucketId,
  canonicalModelId,
} = await import("../../src/capability/retrieval/retrieval-expansion.ts");

// The real CONSUME client.
const { createMemgraphClient } = await import("../../src/core/memgraph.ts");

// The real CREATE core (record_outcome).
const { runOutcomeRecord, CALIBRATION_CONFIDENCE_VALUES } = await import("../../src/tools/record_outcome.ts");

// ── (a) Confidence parse: deterministic extraction from terminal output ──────

test("CONFIDENCE_VALUES is the closed self-reported vocabulary", () => {
  assert.deepEqual([...CONFIDENCE_VALUES], ["high", "medium", "low"]);
});

test("parseSelfReportedConfidence extracts a terminal CONFIDENCE line (case-insensitive)", () => {
  for (const [input, expected] of [
    ["All done.\nCONFIDENCE: high", "high"],
    ["Summary\n**CONFIDENCE**: medium", "medium"],
    ["Result text\nconfidence: LOW", "low"],
  ]) {
    assert.equal(parseSelfReportedConfidence(input), expected, `input=${JSON.stringify(input)}`);
  }
});

test("parseSelfReportedConfidence uses the LAST occurrence (terminal self-report wins)", () => {
  const text = "Draft CONFIDENCE: high\n...revised...\nFinal CONFIDENCE: low";
  assert.equal(parseSelfReportedConfidence(text), "low");
});

test("parseSelfReportedConfidence returns null when no CONFIDENCE line is present", () => {
  for (const input of ["", "no label here", "CONFIDENCE: maybe", "CONFIDENCE: super-high"]) {
    assert.equal(parseSelfReportedConfidence(input), null, `input=${JSON.stringify(input)}`);
  }
});

// ── (b) Bucket id: deterministic (model, shapeKey, confidence) namespace ─────

test("buildCalibrationBucketId is deterministic and namespaced", () => {
  const id = buildCalibrationBucketId("litellm/model-x", "aa11bb22", "high");
  assert.equal(id, "calibration::litellm/model-x::aa11bb22::high");
  assert.equal(buildCalibrationBucketId("litellm/model-x", "aa11bb22", "high"), id);
});

test("buildCalibrationBucketId never collides with capability/failure namespaces", () => {
  const calib = buildCalibrationBucketId("m1", "s1", "high");
  assert.ok(calib.startsWith("calibration::"));
  assert.ok(!calib.startsWith("capability::"), "must not collide with Phase 14 buckets");
  assert.ok(!calib.startsWith("failure::"), "must not collide with Phase 15 buckets");
});

test("canonicalModelId is the SAME model identity used by Phase 15", () => {
  const id = canonicalModelId("litellm", "model-x");
  assert.equal(id, "litellm/model-x");
  assert.equal(canonicalModelId("", ""), null);
});

// ── (c) Predicate non-collision: es-calibration-outcome is NEW and distinct ───

test("es-calibration-outcome does not collide with the reserved predicate set", () => {
  const RESERVED = [
    "synthesized-from",
    "consolidated-into",
    "merged-into",
    "in-hall",
    "es-status",
    "es-source-type",
    "es-outcome",
    "concerns",
    "triggers-on",
    "rules-out",
    "es-staleness",
  ];
  const NEW = ["es-calibration-outcome"];
  for (const p of NEW) {
    assert.ok(!RESERVED.includes(p), `${p} must not be in the reserved set`);
  }
});

test("CALIBRATION_CONFIDENCE_VALUES matches the parse helper's vocabulary", () => {
  assert.deepEqual([...CALIBRATION_CONFIDENCE_VALUES], [...CONFIDENCE_VALUES]);
});

// ── (d) CREATE via record_outcome: calibration tuple edge on apply ───────────

function makeFakeTransport() {
  const calls = [];
  return {
    calls,
    call: async (name, payload) => {
      calls.push({ name, payload });
      return {};
    },
  };
}

const FIXED_NOW = () => new Date("2026-08-28T00:00:00.000Z");

test("record_outcome apply WITHOUT calibration args writes only es-outcome edges", async () => {
  const fake = makeFakeTransport();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: ["drawer_wing_room_abc"],
    outcome: "accept",
    dryRun: false,
    now: FIXED_NOW,
  });
  assert.equal(report.calibration, undefined);
  const kgAdds = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(kgAdds.length, 1);
  assert.equal(kgAdds[0].payload.predicate, "es-outcome");
});

test("record_outcome apply WITH valid calibration writes BOTH es-outcome AND es-calibration-outcome", async () => {
  const fake = makeFakeTransport();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: ["drawer_wing_room_abc"],
    outcome: "accept",
    dryRun: false,
    now: FIXED_NOW,
    calibration: { model_id: "litellm/model-x", task_shape: "aa11bb22", confidence: "high" },
  });
  assert.equal(report.calibration?.status, "added");
  const kgAdds = fake.calls.filter((c) => c.name === "kg_add");
  const outcomeEdges = kgAdds.filter((c) => c.payload.predicate === "es-outcome");
  const calibrationEdges = kgAdds.filter((c) => c.payload.predicate === "es-calibration-outcome");
  assert.equal(outcomeEdges.length, 1);
  assert.equal(calibrationEdges.length, 1);
  assert.equal(calibrationEdges[0].payload.subject, "calibration::litellm/model-x::aa11bb22::high");
  assert.equal(calibrationEdges[0].payload.object, "accept");
  assert.equal(calibrationEdges[0].payload.valid_from, "2026-08-28T00:00:00.000Z");
});

test("record_outcome dry-run WITH calibration previews both edges but writes nothing", async () => {
  const fake = makeFakeTransport();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: ["drawer_wing_room_abc"],
    outcome: "failed",
    dryRun: true,
    now: FIXED_NOW,
    calibration: { model_id: "litellm/model-x", task_shape: "aa11bb22", confidence: "medium" },
  });
  assert.equal(report.dry_run, true);
  assert.equal(fake.calls.length, 0, "dry-run must make zero kg_add calls");
  assert.equal(report.calibration?.status, "proposed");
  assert.equal(report.calibration?.bucket_id, "calibration::litellm/model-x::aa11bb22::medium");
});

test("record_outcome rejects an invalid confidence level (skipped_reason, es-outcome still written)", async () => {
  const fake = makeFakeTransport();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: ["drawer_wing_room_abc"],
    outcome: "accept",
    dryRun: false,
    now: FIXED_NOW,
    calibration: { model_id: "litellm/model-x", task_shape: "aa11bb22", confidence: "super-high" },
  });
  assert.ok(report.calibration_skipped_reason.includes("invalid confidence"));
  const kgAdds = fake.calls.filter((c) => c.name === "kg_add");
  // es-outcome is still written; calibration edge is NOT.
  assert.equal(kgAdds.length, 1);
  assert.equal(kgAdds[0].payload.predicate, "es-outcome");
});

test("record_outcome rejects a partial calibration capture (missing task_shape)", async () => {
  const fake = makeFakeTransport();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: ["drawer_wing_room_abc"],
    outcome: "accept",
    dryRun: false,
    now: FIXED_NOW,
    calibration: { model_id: "litellm/model-x", task_shape: "", confidence: "high" },
  });
  assert.ok(report.calibration_skipped_reason.includes("requires model_id and task_shape"));
});

// ── (e) CONSUME: cell read + 20-pair minimum-sample gate ─────────────────────

function makeCalibrationClient(factsByBucket) {
  const calls = [];
  return {
    client: createMemgraphClient({
      callTool: async (name, args) => {
        if (name.endsWith("kg_query")) {
          calls.push(args || {});
          const entity = String(args?.entity ?? "");
          const facts = factsByBucket[entity] || [];
          return { facts };
        }
        return {};
      },
    }),
    calls,
  };
}

function calibrationFacts(bucketId, outcomes) {
  return outcomes.map((o) => ({ current: true, subject: bucketId, predicate: "es-calibration-outcome", object: o }));
}

test("CONSUME: cell with >= 20 pairs reports hitRate and sufficient=true", async () => {
  const bucket = "calibration::m1::s1::high";
  const outcomes = Array(15).fill("accept").concat(Array(5).fill("revise")); // 15/20 = 0.75
  const { client } = makeCalibrationClient({ [bucket]: calibrationFacts(bucket, outcomes) });
  const cell = await client.getCalibrationCell("m1", "s1", "high");
  assert.equal(cell.total, 20);
  assert.equal(cell.accept, 15);
  assert.equal(cell.revise, 5);
  assert.equal(cell.sufficient, true);
  assert.ok(Math.abs(cell.hitRate - 0.75) < 1e-9);
});

test("CONSUME: cell with < 20 pairs reports sufficient=false (threshold gate)", async () => {
  const bucket = "calibration::m1::s1::high";
  const outcomes = Array(5).fill("accept"); // only 5 pairs
  const { client } = makeCalibrationClient({ [bucket]: calibrationFacts(bucket, outcomes) });
  const cell = await client.getCalibrationCell("m1", "s1", "high");
  assert.equal(cell.total, 5);
  assert.equal(cell.sufficient, false);
  assert.equal(cell.threshold, 20);
  // hitRate is still computed for reporting transparency (0.75) but the cell is unusable.
  assert.ok(Math.abs(cell.hitRate - 1.0) < 1e-9);
});

test("CONSUME: cell with zero pairs returns null hitRate and sufficient=false", async () => {
  const { client } = makeCalibrationClient({});
  const cell = await client.getCalibrationCell("m1", "s1", "low");
  assert.equal(cell.total, 0);
  assert.equal(cell.hitRate, null);
  assert.equal(cell.sufficient, false);
});

test("CONSUME: invalid confidence level returns empty cell (no query)", async () => {
  const { client, calls } = makeCalibrationClient({});
  const cell = await client.getCalibrationCell("m1", "s1", "super-high");
  assert.equal(cell.bucketId, "");
  assert.equal(calls.length, 0, "no kg_query should be issued for an invalid level");
});

test("CONSUME: read failure degrades to zero counts (neutral), never throws", async () => {
  const client = createMemgraphClient({
    callTool: async (name) => {
      if (name.endsWith("kg_query")) throw new Error("backend down");
      return {};
    },
  });
  const cell = await client.getCalibrationCell("m1", "s1", "high");
  assert.equal(cell.total, 0);
  assert.equal(cell.sufficient, false);
});

// ── (f) CONSUME: table + deterministic ordering ───────────────────────────────

test("CONSUME: table returns rows for all confidence levels per shape, deterministic order", async () => {
  const bucketHigh = "calibration::m1::s1::high";
  const bucketMed = "calibration::m1::s1::medium";
  const bucketLow = "calibration::m1::s1::low";
  const facts = {
    [bucketHigh]: calibrationFacts(bucketHigh, Array(20).fill("accept")),
    [bucketMed]: calibrationFacts(bucketMed, Array(5).fill("accept").concat(Array(5).fill("failed"))),
    [bucketLow]: [],
  };
  const { client } = makeCalibrationClient(facts);
  const table = await client.getCalibrationTable("m1", ["s1"]);
  assert.equal(table.model, "m1");
  assert.equal(table.rows.length, 3); // high, medium, low for shape s1
  assert.deepEqual(
    table.rows.map((r) => r.confidence),
    ["high", "medium", "low"],
    "rows must be in deterministic confidence order (high, medium, low)",
  );
  assert.equal(table.rows[0].sufficient, true); // 20 accepts
  assert.equal(table.rows[1].sufficient, false); // 10 pairs
  assert.ok(Math.abs(table.rows[1].hitRate - 0.5) < 1e-9); // 5/10 accept
  assert.equal(table.rows[2].total, 0); // no data
});

test("CONSUME: table caps shape fan-out at maxShapes (default 8)", async () => {
  const { client, calls } = makeCalibrationClient({});
  const shapes = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const table = await client.getCalibrationTable("m1", shapes);
  assert.equal(table.rows.length, 8 * 3, "default maxShapes=8 -> 24 rows (8 shapes x 3 levels)");
  // Each cell issues one kg_query; 24 cells total.
  assert.equal(calls.length, 24);
});

test("CONSUME: table with no shape keys returns empty rows", async () => {
  const { client } = makeCalibrationClient({});
  const table = await client.getCalibrationTable("m1", []);
  assert.equal(table.rows.length, 0);
});

// ── (g) CONSUME: composed escalation decision (two models, same reported confidence) ──

test("CONSUME: two models with the SAME reported confidence but different curves get DIFFERENT decisions", async () => {
  // Model A: high-confidence reports are reliable (18/20 accept = 0.9 hit rate).
  const bucketA = "calibration::model-A::s1::high";
  // Model B: high-confidence reports are unreliable (8/20 accept = 0.4 hit rate).
  const bucketB = "calibration::model-B::s1::high";
  const facts = {
    [bucketA]: calibrationFacts(bucketA, Array(18).fill("accept").concat(Array(2).fill("revise"))),
    [bucketB]: calibrationFacts(bucketB, Array(8).fill("accept").concat(Array(12).fill("failed"))),
  };
  const { client } = makeCalibrationClient(facts);

  const decisionA = await client.decideCalibratedEscalation({ modelId: "model-A", shapeKey: "s1", reportedConfidence: "high" });
  const decisionB = await client.decideCalibratedEscalation({ modelId: "model-B", shapeKey: "s1", reportedConfidence: "high" });

  assert.equal(decisionA.action, "trust", `model-A should be trusted (reason: ${decisionA.reason})`);
  assert.equal(decisionB.action, "escalate", `model-B should escalate (reason: ${decisionB.reason})`);
});

test("CONSUME: insufficient data falls back to defaultAction (no guessing)", async () => {
  const facts = {
    "calibration::m1::s1::high": calibrationFacts("calibration::m1::s1::high", Array(5).fill("accept")), // only 5 pairs
  };
  const { client } = makeCalibrationClient(facts);

  const trustDefault = await client.decideCalibratedEscalation({ modelId: "m1", shapeKey: "s1", reportedConfidence: "high", defaultAction: "trust" });
  assert.equal(trustDefault.action, "trust");
  assert.ok(trustDefault.reason.includes("insufficient-data"));

  const escalateDefault = await client.decideCalibratedEscalation({ modelId: "m1", shapeKey: "s1", reportedConfidence: "high", defaultAction: "escalate" });
  assert.equal(escalateDefault.action, "escalate");
  assert.ok(escalateDefault.reason.includes("insufficient-data"));
});

test("CONSUME: zero-pair cell falls back to defaultAction (no data at all)", async () => {
  const { client } = makeCalibrationClient({});
  const decision = await client.decideCalibratedEscalation({ modelId: "m1", shapeKey: "s1", reportedConfidence: "high", defaultAction: "trust" });
  assert.equal(decision.action, "trust");
  assert.ok(decision.reason.includes("insufficient-data"));
});

// ── (h) CONSUME: escalation note formatting (pure helper) ───────────────────
// The plugin injects this note into the prompt when decideCalibratedEscalation
// returns 'escalate'; its content is what makes the instruction actionable.

const { buildCalibrationEscalationNote } = await import("../../src/surface/turn-guard-helpers.ts");

test("buildCalibrationEscalationNote renders heading, model, confidence, hit rate and total", () => {
  const note = buildCalibrationEscalationNote({
    heading: "## Calibration warning",
    modelId: "litellm/model-x",
    reportedConfidence: "high",
    hitRate: 0.4,
    total: 25,
  });
  assert.ok(note.includes("## Calibration warning"), "note must lead with the heading");
  assert.ok(note.includes("litellm/model-x"), "note must name the model");
  assert.ok(note.includes(`"high"`), "note must quote the reported confidence level");
  assert.ok(note.includes("40%"), "hit rate must be rendered as a percent (0.4 -> 40%)");
  assert.ok(note.includes("(across 25 recorded outcomes)"), "note must state the sample total");
});

test("buildCalibrationEscalationNote rounds the hit rate and keeps the do-not-trust instruction", () => {
  const note = buildCalibrationEscalationNote({
    heading: "## Calibration warning",
    modelId: "m1",
    reportedConfidence: "medium",
    hitRate: 0.756,
    total: 21,
  });
  assert.ok(note.includes("76%"), "hit rate must round to the nearest percent (0.756 -> 76%)");
  assert.ok(note.includes("Do NOT take your own confidence at face value"), "note must carry the do-not-trust instruction");
});
