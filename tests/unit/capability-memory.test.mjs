import assert from "node:assert/strict";
import test from "node:test";

/**
 * Unit coverage for Phase 14 (capability memory / learned routing).
 *
 * CREATE (write path): turn-guard records a capability tuple (task shape, tier,
 * outcome) when a routing-tier subagent completes. The plugin module cannot be
 * imported directly (pre-existing backtick-in-template-literal issues in sibling
 * tools/ modules), so the CREATE-path decision logic is exercised against the
 * real pure helpers from adapter/turn-guard-helpers.ts and the real
 * shape/tier/outcome helpers from adapter/retrieval-expansion.ts.
 *
 * CONSUME (read path): MemgraphClient.getCapabilityRoutingEvidence aggregates
 * capability evidence per (shape, tier) and produces a recommendation with a
 * min-sample gate (default 5). This is exercised against the real client with a
 * fake kg_query backend — at least one behavior test executes the aggregation
 * logic end-to-end (not just string contains).
 */

// The real Phase 14 helpers (single source of truth for shape/tier/outcome).
const {
  extractWorkedExampleShape,
  classifyUnitSize,
  CAPABILITY_TIER_BY_SUBAGENT,
  mapTaskStatusToCapabilityOutcome,
  buildCapabilityCanonicalShape,
  buildCapabilityBucketId,
  buildFailureBucketId,
} = await import("../../adapter/retrieval-expansion.ts");

// The real CONSUME client.
const { createMemgraphClient } = await import("../../adapter/memgraph.ts");

// ── (a) Tier mapping: deterministic subagent_type -> tier ────────────────────

test("CAPABILITY_TIER_BY_SUBAGENT maps the four routing subagents to tiers", () => {
  assert.equal(CAPABILITY_TIER_BY_SUBAGENT["implement-local"], "local");
  assert.equal(CAPABILITY_TIER_BY_SUBAGENT["implement-cloud"], "cloud");
  assert.equal(CAPABILITY_TIER_BY_SUBAGENT["implement-deep-cloud"], "deep");
  assert.equal(CAPABILITY_TIER_BY_SUBAGENT["solve-deep-cloud"], "deep");
});

test("CAPABILITY_TIER_BY_SUBAGENT skips non-routing subagents (explore, review-diff, run-tests, build)", () => {
  for (const type of ["explore", "review-diff", "run-tests", "check-diff", "build", "solve-local"]) {
    assert.equal(CAPABILITY_TIER_BY_SUBAGENT[type], undefined, `${type} must not be a routing tier`);
  }
});

// ── (b) Outcome mapping: task tool part status -> closed outcome set ─────────

test("mapTaskStatusToCapabilityOutcome maps success statuses to accept", () => {
  for (const status of ["success", "completed", "ok"]) {
    assert.equal(mapTaskStatusToCapabilityOutcome(status), "accept", `${status} must map to accept`);
  }
});

test("mapTaskStatusToCapabilityOutcome maps failure statuses to failed", () => {
  for (const status of ["failed", "error"]) {
    assert.equal(mapTaskStatusToCapabilityOutcome(status), "failed", `${status} must map to failed`);
  }
});

test("mapTaskStatusToCapabilityOutcome maps abort statuses to unused", () => {
  for (const status of ["aborted", "cancelled", "canceled"]) {
    assert.equal(mapTaskStatusToCapabilityOutcome(status), "unused", `${status} must map to unused`);
  }
});

test("mapTaskStatusToCapabilityOutcome returns null for unknown statuses (skip, not guess)", () => {
  for (const status of ["", "pending", "running", "weird-status"]) {
    assert.equal(mapTaskStatusToCapabilityOutcome(status), null, `${status} must map to null`);
  }
});

// ── (c) Shape derivation: size bucket + canonical shape string ───────────────

test("classifyUnitSize detects single-file language", () => {
  assert.equal(classifyUnitSize("Fix the bug in this single file"), "single-file");
  assert.equal(classifyUnitSize("Update one file with the new config"), "single-file");
});

test("classifyUnitSize detects few-file language", () => {
  assert.equal(classifyUnitSize("Update two files: a.ts and b.ts"), "few-file");
  assert.equal(classifyUnitSize("Refactor three files in the adapter layer"), "few-file");
});

test("classifyUnitSize detects cross-cutting language", () => {
  assert.equal(classifyUnitSize("Refactor across the codebase to use the new helper"), "cross-cutting");
  assert.equal(classifyUnitSize("Update multiple files: a.ts, b.py, c.scss"), "cross-cutting");
});

test("classifyUnitSize defaults to few-file when scope is unspecified", () => {
  assert.equal(classifyUnitSize("Fix the retry logic in the gateway adapter"), "few-file");
});

test("extractWorkedExampleShape includes sizeBucket and it feeds shapeKey", () => {
  const a = extractWorkedExampleShape("Fix the bug in this single file: gateway.ts");
  const b = extractWorkedExampleShape("Fix the bug across the codebase: gateway.ts, adapter.py, styles.scss");
  assert.equal(a.sizeBucket, "single-file", "single-file prompt must classify as single-file");
  assert.equal(b.sizeBucket, "cross-cutting", "cross-cutting prompt must classify as cross-cutting");
  assert.notEqual(a.shapeKey, b.shapeKey, "different size buckets must produce different shape keys");
});

test("buildCapabilityCanonicalShape is deterministic and includes the size bucket", () => {
  const shape = extractWorkedExampleShape("Fix the websocket reconnect bug in gateway.ts");
  const s1 = buildCapabilityCanonicalShape(shape);
  const s2 = buildCapabilityCanonicalShape(extractWorkedExampleShape("Fix the websocket reconnect bug in gateway.ts"));
  assert.equal(s1, s2, "same input must produce byte-identical canonical shape strings");
  assert.ok(s1.includes(`size=${shape.sizeBucket}`), "canonical shape must include the size bucket");
});

test("buildCapabilityBucketId produces a stable capability::<shapeKey>::<tier> id", () => {
  const id = buildCapabilityBucketId("abc12345", "local");
  assert.equal(id, "capability::abc12345::local");
});

// ── (d) CONSUME live decision: decideCapabilityReroute (pure helper) ─────────
// The plugin delegates the routing change to this helper. NEUTRAL FALLBACK is
// load-bearing: insufficient/inconclusive evidence must preserve the existing
// pick, never move a unit.

const { decideCapabilityReroute } = await import("../../adapter/turn-guard-helpers.ts");

test("decideCapabilityReroute returns neutral fallback when evidence is insufficient (fallback=true)", () => {
  const decision = decideCapabilityReroute({ requestedTier: "local", recommendation: "deep", fallback: true });
  assert.equal(decision.rerouteTo, null, "fallback evidence must never reroute");
  assert.equal(decision.reason, "neutral-fallback");
});

test("decideCapabilityReroute returns neutral fallback for no-data / empty recommendation", () => {
  assert.deepEqual(
    decideCapabilityReroute({ requestedTier: "cloud", recommendation: "no-data", fallback: false }),
    { rerouteTo: null, reason: "neutral-fallback" },
  );
  assert.deepEqual(
    decideCapabilityReroute({ requestedTier: "deep", recommendation: "", fallback: false }),
    { rerouteTo: null, reason: "neutral-fallback" },
  );
});

test("decideCapabilityReroute does NOT reroute when the evidence agrees with the requested tier", () => {
  const decision = decideCapabilityReroute({ requestedTier: "local", recommendation: "local", fallback: false });
  assert.equal(decision.rerouteTo, null, "same-tier agreement must not change routing");
  assert.equal(decision.reason, "already-recommended");
});

test("decideCapabilityReroute reroutes to a concrete different tier only on sufficient evidence", () => {
  const decision = decideCapabilityReroute({ requestedTier: "local", recommendation: "cloud", fallback: false });
  assert.equal(decision.rerouteTo, "cloud", "sufficient different-tier evidence must reroute");
  assert.equal(decision.reason, "evidence-reroute");
});
function makeCapabilityClient(factsByBucket) {
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

function outcomeFacts(bucketId, outcomes) {
  return outcomes.map((o) => ({ current: true, subject: bucketId, predicate: "es-capability-outcome", object: o }));
}

test("CONSUME: recommendation differs for two shapes with different counts (behavior test)", async () => {
  // Shape A: local is strong (5 accepts), cloud is weak (1 accept, 4 failed).
  const shapeA = "aaaa0001";
  // Shape B: deep is strong (6 accepts), local is weak (2 accepts, 3 failed).
  const shapeB = "bbbb0002";

  const factsByBucket = {
    [`capability::${shapeA}::local`]: outcomeFacts(`capability::${shapeA}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${shapeA}::cloud`]: outcomeFacts(`capability::${shapeA}::cloud`, ["accept", "failed", "failed", "failed", "failed"]),
    [`capability::${shapeB}::local`]: outcomeFacts(`capability::${shapeB}::local`, ["accept", "accept", "failed", "failed", "failed"]),
    [`capability::${shapeB}::deep`]: outcomeFacts(`capability::${shapeB}::deep`, ["accept", "accept", "accept", "accept", "accept", "accept"]),
  };

  const { client } = makeCapabilityClient(factsByBucket);

  const resA = await client.getCapabilityRoutingEvidence(shapeA);
  const resB = await client.getCapabilityRoutingEvidence(shapeB);

  // Shape A: local (5/5) beats cloud (1/5).
  assert.equal(resA.recommendation, "local", `shape A should recommend local, got ${resA.recommendation}`);
  assert.equal(resA.fallback, false);
  assert.equal(resA.tiers.local.accept, 5);
  assert.equal(resA.tiers.local.total, 5);
  assert.equal(resA.tiers.cloud.accept, 1);
  assert.equal(resA.tiers.cloud.failed, 4);

  // Shape B: deep (6/6) beats local (2/5).
  assert.equal(resB.recommendation, "deep", `shape B should recommend deep, got ${resB.recommendation}`);
  assert.equal(resB.fallback, false);
  assert.equal(resB.tiers.deep.accept, 6);
  assert.equal(resB.tiers.local.accept, 2);
  assert.equal(resB.tiers.local.failed, 3);

  // The two shapes must produce DIFFERENT recommendations.
  assert.notEqual(resA.recommendation, resB.recommendation, "two shapes with different counts must recommend different tiers");
});

test("CONSUME: returns no-data/fallback when sample < 5 (min-sample gate)", async () => {
  const shape = "cccc0003";
  // Only 3 samples on local — below the min-sample threshold of 5.
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "accept", "accept"]),
  };

  const { client } = makeCapabilityClient(factsByBucket);
  const res = await client.getCapabilityRoutingEvidence(shape);

  assert.equal(res.recommendation, "no-data", "below min-sample must recommend no-data");
  assert.equal(res.fallback, true, "below min-sample must set fallback=true");
  assert.equal(res.threshold, 5, "default threshold must be 5");
  assert.equal(res.tiers.local.total, 3);
  assert.equal(res.tiers.local.sufficient_sample, false, "3 samples must NOT be sufficient");
});

test("CONSUME: deterministic tie-break order is local > cloud > deep", async () => {
  const shape = "dddd0004";
  // All three tiers have identical accept rates (1/5) — tie-break by order.
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "failed", "failed", "failed", "failed"]),
    [`capability::${shape}::cloud`]: outcomeFacts(`capability::${shape}::cloud`, ["accept", "failed", "failed", "failed", "failed"]),
    [`capability::${shape}::deep`]: outcomeFacts(`capability::${shape}::deep`, ["accept", "failed", "failed", "failed", "failed"]),
  };

  const { client } = makeCapabilityClient(factsByBucket);
  const res = await client.getCapabilityRoutingEvidence(shape);

  assert.equal(res.recommendation, "local", "tie must break to local (first in deterministic order)");
  assert.equal(res.fallback, false);
});

test("CONSUME: degrades gracefully on kg_query failure (neutral counts, no-data)", async () => {
  const client = createMemgraphClient({
    callTool: async () => {
      throw new Error("server down");
    },
  });

  const res = await client.getCapabilityRoutingEvidence("eeee0005");

  assert.equal(res.recommendation, "no-data", "failed reads must degrade to no-data");
  assert.equal(res.fallback, true);
  for (const tier of ["local", "cloud", "deep"]) {
    assert.equal(res.tiers[tier].total, 0, `${tier} must read as zero counts on failure`);
    assert.equal(res.tiers[tier].sufficient_sample, false);
  }
});

test("CONSUME: issues one-hop kg_query per tier bucket with the es-capability-outcome predicate", async () => {
  const shape = "ffff0006";
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept"]),
  };

  const { client, calls } = makeCapabilityClient(factsByBucket);
  await client.getCapabilityRoutingEvidence(shape);

  // One query per tier (3 total), each one-hop on the capability predicate.
  assert.equal(calls.length, 3, "must issue exactly one kg_query per tier bucket");
  for (const call of calls) {
    assert.equal(call.direction, "outgoing");
    assert.equal(call.predicate, "es-capability-outcome");
    // One-hop: max_depth is set to 1; recurse is intentionally omitted (undefined = no recursion).
    assert.equal(call.max_depth, 1);
    assert.ok(!("recurse" in call), `recurse must not be set for one-hop queries: ${JSON.stringify(call)}`);
  }
});

// ── (e2) CONSUME Phase 15: failure-adjusted routing composition ──────────────
// This repo has no in-repo tier SELECTOR (the orchestrator that delegates units
// to tiers lives outside this codebase), so the penalty integration is exposed
// as a deterministic composed API: getFailureAdjustedRouting combines Phase 14
// capability evidence with Phase 15 per-model failure counts into an adjusted
// recommendation. An external consumer calls it once before choosing a tier.

function makeCompositeClient(factsByBucket) {
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

function failureFacts(bucketId, events) {
  return events.map((e) => ({ current: true, subject: bucketId, predicate: "es-failure-event", object: e }));
}

test("Phase 15 CONSUME: high failure propensity flips the recommendation (differential behavior)", async () => {
  const shape = "aaaa0001";
  // Capability evidence: local is strong (5/5), cloud is weak (1/5). With no
  // failure data, Phase 14 alone recommends local.
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${shape}::cloud`]: outcomeFacts(`capability::${shape}::cloud`, ["accept", "failed", "failed", "failed", "failed"]),
  };

  const modelLocal = "litellm/model-a";
  const modelCloud = "litellm/model-b";
  const modelByTier = { local: modelLocal, cloud: modelCloud, deep: null };

  // Baseline: no failure events — the composition must agree with Phase 14.
  const baseline = await makeCompositeClient(factsByBucket).getFailureAdjustedRouting(shape, modelByTier);
  assert.equal(baseline.recommendation, "local", `no failures must keep the Phase 14 pick, got ${baseline.recommendation}`);
  assert.equal(baseline.fallback, false);

  // Now model-a (pinned to local) has a HIGH failure propensity on this shape:
  // 10 turn-guard interventions. The penalty must flip the recommendation to cloud.
  factsByBucket[buildFailureBucketId(modelLocal, shape)] = failureFacts(buildFailureBucketId(modelLocal, shape), [
    "spiral", "loop", "loop", "spiral", "loop", "loop", "spiral", "loop", "spiral", "loop",
  ]);

  const adjusted = await makeCompositeClient(factsByBucket).getFailureAdjustedRouting(shape, modelByTier);
  assert.equal(adjusted.recommendation, "cloud", `high failure propensity must flip the pick to cloud, got ${adjusted.recommendation}`);
  assert.equal(adjusted.fallback, false);
  // The evidence must be explainable: base rate minus clamped failure rate.
  assert.ok(Math.abs(adjusted.tiers.local.baseRate - 1.0) < 1e-9, "local base rate must be 5/5");
  assert.equal(adjusted.tiers.local.failureTotal, 10, "local tier must carry model-a's failure count");
  // local: 1 - 10/max(10,5) = 0.0 ; cloud: 0.2 - 0/5 = 0.2 — strict differential.
  assert.ok(Math.abs(adjusted.tiers.local.adjustedScore - 0.0) < 1e-9, "local score = base - failures/max(failures,5)");
  assert.ok(Math.abs(adjusted.tiers.cloud.adjustedScore - 0.2) < 1e-9, "cloud score = base (no failures)");
  assert.notEqual(adjusted.recommendation, baseline.recommendation, "the recommendation must differ from the no-failure baseline");
});

test("Phase 15 CONSUME: penalty magnitude scales with failure count (strict differential)", async () => {
  const shape = "bbbb0002";
  // local 5/5 vs cloud 4/5 — a small capability gap (1.0 vs 0.8).
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${shape}::cloud`]: outcomeFacts(`capability::${shape}::cloud`, ["accept", "accept", "accept", "accept", "failed"]),
  };

  const modelLocal = "litellm/model-a";
  const modelCloud = "litellm/model-b";
  const modelByTier = { local: modelLocal, cloud: modelCloud, deep: null };

  // No failures: local wins (1.0 > 0.8).
  const noFailures = await makeCompositeClient(factsByBucket).getFailureAdjustedRouting(shape, modelByTier);
  assert.equal(noFailures.recommendation, "local");

  // 2 failures on model-a: local score = 1 - 2/5 = 0.6 < cloud 0.8 => cloud wins.
  factsByBucket[buildFailureBucketId(modelLocal, shape)] = failureFacts(buildFailureBucketId(modelLocal, shape), ["loop", "spiral"]);
  const twoFailures = await makeCompositeClient(factsByBucket).getFailureAdjustedRouting(shape, modelByTier);
  assert.equal(twoFailures.recommendation, "cloud", `2 failures must overcome the capability gap, got ${twoFailures.recommendation}`);

  // The adjusted scores must be explainable and strictly ordered.
  assert.ok(Math.abs(twoFailures.tiers.local.adjustedScore - (1 - 2 / 5)) < 1e-9, "local score = base - failures/max(failures,5)");
  assert.ok(Math.abs(twoFailures.tiers.cloud.adjustedScore - 0.8) < 1e-9, "cloud score = base (no failures)");
  assert.ok(twoFailures.tiers.cloud.adjustedScore > twoFailures.tiers.local.adjustedScore);
});

test("Phase 15 CONSUME: unknown model on a tier gets no penalty (no guessing)", async () => {
  const shape = "cccc0003";
  // local 5/5, cloud 4/5. Local's model is UNKNOWN (null) — its failure bucket
  // must not be read as bad or good; the recommendation stays capability-based.
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${shape}::cloud`]: outcomeFacts(`capability::${shape}::cloud`, ["accept", "accept", "accept", "accept", "failed"]),
  };
  const modelByTier = { local: null, cloud: "litellm/model-b", deep: null };

  const res = await makeCompositeClient(factsByBucket).getFailureAdjustedRouting(shape, modelByTier);
  assert.equal(res.recommendation, "local", "unknown model must not be penalized");
  assert.equal(res.tiers.local.failureTotal, 0, "unknown model must read as zero failures (no data)");
});

test("Phase 15 CONSUME: below min-sample capability evidence still falls back to no-data", async () => {
  const shape = "dddd0004";
  // Only 3 samples on local — insufficient, even with zero failures.
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "accept", "accept"]),
  };
  const res = await makeCompositeClient(factsByBucket).getFailureAdjustedRouting(shape, { local: "litellm/model-a" });
  assert.equal(res.recommendation, "no-data", "insufficient capability sample must fall back");
  assert.equal(res.fallback, true);
});

test("Phase 15 CONSUME: degrades gracefully on kg_query failure (no-data, no throw)", async () => {
  const client = createMemgraphClient({
    callTool: async () => {
      throw new Error("server down");
    },
  });
  const res = await client.getFailureAdjustedRouting("eeee0005", { local: "litellm/model-a" });
  assert.equal(res.recommendation, "no-data");
  assert.equal(res.fallback, true);
});

test("Phase 15 CONSUME: failure counts are read from the SAME failure bucket ids (one shape system)", async () => {
  const shape = extractWorkedExampleShape("Fix the websocket reconnect bug in gateway.ts").shapeKey;
  const model = "litellm/model-a";
  const factsByBucket = {
    [`capability::${shape}::local`]: outcomeFacts(`capability::${shape}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [buildFailureBucketId(model, shape)]: failureFacts(buildFailureBucketId(model, shape), ["spiral"]),
  };
  const client = makeCompositeClient(factsByBucket);
  const res = await client.getFailureAdjustedRouting(shape, { local: model, cloud: null, deep: null });
  assert.equal(res.tiers.local.failureTotal, 1, "failure count must come from failure::<model>::<shapeKey>");
});

// ── (f) Predicate collision check: es-capability-* is NOT in the reserved set ─

test("es-capability-* predicates do not collide with the reserved predicate set", () => {
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
  const NEW = ["es-capability-outcome", "es-capability-shape", "es-capability-tier"];
  for (const p of NEW) {
    assert.ok(!RESERVED.includes(p), `${p} must not be in the reserved set`);
  }
});
