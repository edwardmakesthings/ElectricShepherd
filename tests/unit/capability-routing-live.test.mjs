import assert from "node:assert/strict";
import test from "node:test";

/**
 * P0-1 acceptance: Phase 14/15 CONSUME (getFailureAdjustedRouting) is now wired
 * into the LIVE delegation routing in plugin/session-policy.ts (tool.execute.before,
 * task branch). This file proves the live call site behaves correctly:
 *
 *   1. baseline selection UNCHANGED when no evidence (fallback / no-data),
 *   2. selection ADJUSTS when mocked failure evidence is present,
 *   3. failures in the read path degrade gracefully to baseline.
 *
 * The decision logic lives in adapter/turn-guard-helpers.ts (decideCapabilityReroute)
 * and the evidence composition in adapter/memgraph.ts (getFailureAdjustedRouting) —
 * both are real modules, so these tests exercise the SAME code the hook runs, at
 * the adapter level.
 */

const { CAPABILITY_TIER_BY_SUBAGENT, CAPABILITY_SUBAGENT_BY_TIER, buildFailureBucketId } =
  await import("../../src/policy/retrieval.ts");
const { decideCapabilityReroute } = await import("../../src/surface/turn-guard-helpers.ts");
const { createMemgraphClient } = await import("../../src/core/memgraph.ts");

// ── helpers (mirror the composition the live hook performs) ──────────────────

function outcomeFacts(bucketId, outcomes) {
  return outcomes.map((o) => ({ current: true, subject: bucketId, predicate: "es-capability-outcome", object: o }));
}

function failureFacts(bucketId, events) {
  return events.map((e) => ({ current: true, subject: bucketId, predicate: "es-failure-event", object: e }));
}

/** Build a real MemgraphClient over a fake kg_query backend keyed by entity id. */
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

/**
 * The exact composition the live hook performs for a delegation to `requestedTier`:
 * only that tier's model is known (siblings null => no penalty), then the composed
 * getFailureAdjustedRouting result is fed through decideCapabilityReroute. Returns
 * the final decision the hook would act on.
 */
async function liveRoutingDecision(factsByBucket, requestedTier, effectiveModel) {
  const client = makeCompositeClient(factsByBucket);
  const modelByTier = { local: null, cloud: null, deep: null };
  modelByTier[requestedTier] = effectiveModel;
  const adjusted = await client.getFailureAdjustedRouting(SHAPE, modelByTier);
  return decideCapabilityReroute({
    requestedTier,
    recommendation: String(adjusted?.recommendation ?? ""),
    fallback: Boolean(adjusted?.fallback),
  });
}

// A single deterministic shape key shared by the capability-evidence fixtures.
const SHAPE = "live0001";

// ── (1) baseline selection unchanged when no evidence ────────────────────────

test("LIVE routing: no evidence (empty palace) => neutral fallback, NO reroute", async () => {
  // Empty factsByBucket => every tier reads zero counts => below min-sample gate
  // => getFailureAdjustedRouting returns recommendation "no-data", fallback true.
  const decision = await liveRoutingDecision({}, "local", "litellm/model-a");
  assert.equal(decision.rerouteTo, null, "no evidence must NOT reroute (baseline preserved)");
  assert.equal(decision.reason, "neutral-fallback");
});

test("LIVE routing: insufficient sample (<5) => neutral fallback, NO reroute", async () => {
  const factsByBucket = {
    [`capability::${SHAPE}::local`]: outcomeFacts(`capability::${SHAPE}::local`, ["accept", "accept", "accept"]),
  };
  const decision = await liveRoutingDecision(factsByBucket, "local", "litellm/model-a");
  assert.equal(decision.rerouteTo, null, "below min-sample must NOT reroute (baseline preserved)");
  assert.equal(decision.reason, "neutral-fallback");
});

test("LIVE routing: evidence agrees with the requested tier => NO reroute (baseline unchanged)", async () => {
  // local is the strongest tier AND is the one being requested => recommendation
  // equals requestedTier => decideCapabilityReroute returns null.
  const factsByBucket = {
    [`capability::${SHAPE}::local`]: outcomeFacts(`capability::${SHAPE}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${SHAPE}::cloud`]: outcomeFacts(`capability::${SHAPE}::cloud`, ["accept", "failed", "failed", "failed", "failed"]),
  };
  const decision = await liveRoutingDecision(factsByBucket, "local", "litellm/model-a");
  assert.equal(decision.rerouteTo, null, "evidence agreeing with the pick must NOT reroute");
  assert.equal(decision.reason, "already-recommended");
});

// ── (2) selection adjusts when mocked failure evidence is present ────────────

test("LIVE routing: high failure propensity on the requested tier => reroute to sibling", async () => {
  // Capability: local 5/5 (strong), cloud 4/5 (weaker). With NO failures, Phase 14
  // alone recommends local. But the model pinned to local has a HIGH failure
  // propensity on this shape, so its adjusted score drops below cloud's and the
  // recommendation flips to cloud — a DIFFERENT tier than requested.
  const factsByBucket = {
    [`capability::${SHAPE}::local`]: outcomeFacts(`capability::${SHAPE}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${SHAPE}::cloud`]: outcomeFacts(`capability::${SHAPE}::cloud`, ["accept", "accept", "accept", "accept", "failed"]),
  };

  // Baseline: no failure events => recommendation stays local (== requested) => no reroute.
  const baseline = await liveRoutingDecision(factsByBucket, "local", "litellm/model-a");
  assert.equal(baseline.rerouteTo, null, `no failures must keep the Phase 14 pick (got ${baseline.reason})`);

  // Now model-a (pinned to local) has a HIGH failure propensity: 10 interventions.
  const modelLocal = "litellm/model-a";
  factsByBucket[buildFailureBucketId(modelLocal, SHAPE)] = failureFacts(buildFailureBucketId(modelLocal, SHAPE), [
    "spiral", "loop", "loop", "spiral", "loop", "loop", "spiral", "loop", "spiral", "loop",
  ]);

  const adjusted = await liveRoutingDecision(factsByBucket, "local", modelLocal);
  assert.equal(adjusted.rerouteTo, "cloud", `high failure propensity must reroute local -> cloud (got ${adjusted.rerouteTo ?? "null"})`);
  assert.equal(adjusted.reason, "evidence-reroute");
  // The chosen TIER actually changes: implement-local -> implement-cloud.
  const fromSubagent = CAPABILITY_SUBAGENT_BY_TIER[CAPABILITY_TIER_BY_SUBAGENT["implement-local"]];
  const toSubagent = CAPABILITY_SUBAGENT_BY_TIER[adjusted.rerouteTo];
  assert.notEqual(toSubagent, fromSubagent, "the chosen subagent (tier) must change when failure evidence is present");
});

test("LIVE routing: capability gap alone (no failures) does NOT reroute — failure evidence is the trigger", async () => {
  // local 5/5 vs cloud 4/5. Even though cloud is weaker, with no failure events
  // the recommendation stays local (== requested) => NO reroute. This isolates that
  // it is the FAILURE evidence (not the capability gap) that drives a live change.
  const factsByBucket = {
    [`capability::${SHAPE}::local`]: outcomeFacts(`capability::${SHAPE}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${SHAPE}::cloud`]: outcomeFacts(`capability::${SHAPE}::cloud`, ["accept", "accept", "accept", "accept", "failed"]),
  };
  const decision = await liveRoutingDecision(factsByBucket, "local", "litellm/model-a");
  assert.equal(decision.rerouteTo, null, "capability gap alone (no failures) must NOT reroute");
});

// ── (3) failures in the read path degrade gracefully to baseline ─────────────

test("LIVE routing: kg_query throws => no-data/fallback => NO reroute (graceful)", async () => {
  const client = createMemgraphClient({
    callTool: async () => {
      throw new Error("server down");
    },
  });
  // getFailureAdjustedRouting must NOT throw; it degrades to no-data / fallback.
  const adjusted = await client.getFailureAdjustedRouting(SHAPE, { local: "litellm/model-a", cloud: null, deep: null });
  assert.equal(adjusted.recommendation, "no-data", "failed reads must degrade to no-data");
  assert.equal(adjusted.fallback, true);
  const decision = decideCapabilityReroute({
    requestedTier: "local",
    recommendation: adjusted.recommendation,
    fallback: adjusted.fallback,
  });
  assert.equal(decision.rerouteTo, null, "a read failure must preserve the baseline (no reroute)");
});

test("LIVE routing: unknown model on requested tier => no penalty, capability-based pick preserved", async () => {
  // The requested tier's model is UNKNOWN (null). getFailureAdjustedRouting gives it
  // no failure penalty; if it is still the strongest tier, recommendation == requested
  // => no reroute. Proves an unattributable bucket never looks like "this model is bad".
  const factsByBucket = {
    [`capability::${SHAPE}::local`]: outcomeFacts(`capability::${SHAPE}::local`, ["accept", "accept", "accept", "accept", "accept"]),
    [`capability::${SHAPE}::cloud`]: outcomeFacts(`capability::${SHAPE}::cloud`, ["accept", "failed", "failed", "failed", "failed"]),
  };
  const decision = await liveRoutingDecision(factsByBucket, "local", null);
  assert.equal(decision.rerouteTo, null, "unknown model must not be penalized into a reroute");
});

test("LIVE routing: CAPABILITY_SUBAGENT_BY_TIER maps each tier to its canonical subagent", () => {
  assert.equal(CAPABILITY_SUBAGENT_BY_TIER.local, "implement-local");
  assert.equal(CAPABILITY_SUBAGENT_BY_TIER.cloud, "implement-cloud");
  assert.equal(CAPABILITY_SUBAGENT_BY_TIER.deep, "implement-deep-cloud");
});
