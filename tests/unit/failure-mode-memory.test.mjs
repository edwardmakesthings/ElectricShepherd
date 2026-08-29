import assert from "node:assert/strict";
import test from "node:test";

/**
 * Unit coverage for Phase 15 (per-model failure-mode memory).
 *
 * CREATE (write path): turn-guard records a failure event + successful
 * intervention when loop/spiral interventions fire, attributed to
 * (model, task shape). The CREATE-path write methods are exercised against the
 * real MemgraphClient with a fake kg_add backend, plus the real Phase 15
 * helpers from adapter/retrieval-expansion.ts.
 *
 * CONSUME (read path): MemgraphClient.getFailureCounts / getFailureInterventions
 * are exercised against the real client with a fake kg_query backend — at least
 * one behavior test executes the aggregation logic end-to-end (not just string
 * contains).
 */

// The real Phase 14/15 shape + identity helpers (single source of truth).
const {
  extractWorkedExampleShape,
  buildCapabilityCanonicalShape,
  canonicalModelId,
  buildFailureBucketId,
  buildFailurePatchId,
  FAILURE_EVENT_VALUES,
  INTERVENTION_LABELS,
  FAILURE_PATCH_TEXT_MAX_CHARS,
} = await import("../../adapter/retrieval-expansion.ts");

// The real CONSUME/CREATE client.
const { createMemgraphClient, MemgraphClient } = await import("../../adapter/memgraph.ts");

// ── (a) Phase 15 helpers: model identity + bucket ids ────────────────────────

test("canonicalModelId produces a deterministic provider/model string", () => {
  assert.equal(canonicalModelId("litellm", "implementer-qwen3.8-27b"), "litellm/implementer-qwen3.8-27b");
  // Case-insensitive: routing pins are case-sensitive but attribution is not.
  assert.equal(canonicalModelId("LiteLLM", "Implementer-Qwen"), "litellm/implementer-qwen");
});

test("canonicalModelId returns null when either half is missing (skip, not guess)", () => {
  assert.equal(canonicalModelId(null, "model-x"), null);
  assert.equal(canonicalModelId("provider-x", ""), null);
  assert.equal(canonicalModelId(undefined, undefined), null);
});

test("buildFailureBucketId is stable and namespaced under failure:: (not capability::)", () => {
  const id = buildFailureBucketId("litellm/qwen3.8-27b", "abc12345");
  assert.equal(id, "failure::litellm/qwen3.8-27b::abc12345");
  assert.ok(id.startsWith("failure::"), "must be in the failure namespace");
  assert.ok(!id.startsWith("capability::"), "must not collide with capability buckets");
});

test("buildFailurePatchId is stable and includes the intervention label", () => {
  const id = buildFailurePatchId("litellm/qwen3.8-27b", "abc12345", "spiral-nudge");
  assert.equal(id, "failure-patch::litellm/qwen3.8-27b::abc12345::spiral-nudge");
});

test("FAILURE_EVENT_VALUES and INTERVENTION_LABELS are closed sets", () => {
  assert.deepEqual([...FAILURE_EVENT_VALUES], ["spiral", "loop"]);
  assert.deepEqual([...INTERVENTION_LABELS], ["spiral-nudge", "retry-nudge", "loop-block"]);
});

// ── (b) Shape reuse: Phase 15 uses the SAME shape function as Phase 14 ───────

test("Phase 15 failure buckets key to the same shapeKey as Phase 14 capability buckets", () => {
  const prompt = "Fix the websocket reconnect bug in gateway.ts";
  const shape = extractWorkedExampleShape(prompt);
  // The canonical shape string is byte-identical whether used for capability or failure.
  const s1 = buildCapabilityCanonicalShape(shape);
  const s2 = buildCapabilityCanonicalShape(extractWorkedExampleShape(prompt));
  assert.equal(s1, s2, "same input must produce byte-identical canonical shape strings");
  // The bucket id uses the same shapeKey.
  const failureId = buildFailureBucketId("litellm/model-x", shape.shapeKey);
  assert.ok(failureId.includes(shape.shapeKey), "failure bucket must embed the Phase 14 shapeKey");
});

// ── (d) CONSUME: getFailureCounts with two models and two shapes ─────────────

function makeFailureClient(factsByEntity) {
  const calls = [];
  return {
    client: createMemgraphClient({
      callTool: async (name, args) => {
        if (name.endsWith("kg_query")) {
          calls.push(args || {});
          const entity = String(args?.entity ?? "");
          const facts = factsByEntity[entity] || [];
          return { facts };
        }
        return {};
      },
    }),
    calls,
  };
}

function eventFacts(bucketId, events) {
  return events.map((e) => ({ current: true, subject: bucketId, predicate: "es-failure-event", object: e }));
}

test("CONSUME: getFailureCounts returns per-bucket counts for two models and two shapes (behavior test)", async () => {
  // Model A / Shape X: 2 spirals + 1 loop.
  const modelA = "litellm/model-a";
  const shapeX = "aaaa0001";
  const bucketAX = buildFailureBucketId(modelA, shapeX);
  // Model B / Shape Y: 3 loops.
  const modelB = "litellm/model-b";
  const shapeY = "bbbb0002";
  const bucketBY = buildFailureBucketId(modelB, shapeY);

  const factsByEntity = {
    [bucketAX]: eventFacts(bucketAX, ["spiral", "spiral", "loop"]),
    [bucketBY]: eventFacts(bucketBY, ["loop", "loop", "loop"]),
  };

  const { client } = makeFailureClient(factsByEntity);

  const resAX = await client.getFailureCounts(bucketAX);
  assert.equal(resAX.spiral, 2, "model A / shape X must have 2 spirals");
  assert.equal(resAX.loop, 1, "model A / shape X must have 1 loop");
  assert.equal(resAX.total, 3);

  const resBY = await client.getFailureCounts(bucketBY);
  assert.equal(resBY.spiral, 0, "model B / shape Y must have 0 spirals");
  assert.equal(resBY.loop, 3, "model B / shape Y must have 3 loops");
  assert.equal(resBY.total, 3);

  // The two (model, shape) pairs must produce DIFFERENT count profiles.
  assert.notEqual(resAX.spiral, resBY.spiral, "different models/shapes must have different spiral counts");
});

test("CONSUME: getFailureCounts returns zeros for absent data (no-data safe)", async () => {
  const { client } = makeFailureClient({});
  const res = await client.getFailureCounts(buildFailureBucketId("litellm/unknown", "cccc0003"));
  assert.equal(res.spiral, 0);
  assert.equal(res.loop, 0);
  assert.equal(res.total, 0);
});

test("CONSUME: getFailureCounts degrades gracefully on kg_query failure (neutral zeros)", async () => {
  const client = createMemgraphClient({
    callTool: async () => {
      throw new Error("server down");
    },
  });
  const res = await client.getFailureCounts(buildFailureBucketId("litellm/x", "dddd0004"));
  assert.equal(res.spiral, 0);
  assert.equal(res.loop, 0);
  assert.equal(res.total, 0);
});

test("CONSUME: getFailureCounts issues one-hop kg_query on es-failure-event", async () => {
  const bucket = buildFailureBucketId("litellm/model-x", "eeee0005");
  const factsByEntity = { [bucket]: eventFacts(bucket, ["spiral"]) };
  const { client, calls } = makeFailureClient(factsByEntity);
  await client.getFailureCounts(bucket);
  assert.equal(calls.length, 1, "must issue exactly one kg_query");
  assert.equal(calls[0].direction, "outgoing");
  assert.equal(calls[0].predicate, "es-failure-event");
  assert.equal(calls[0].max_depth, 1);
});

// ── (e) CONSUME: getFailureInterventions — patch retrieval on matching (model,shape) ─

function patchFacts(patchId, texts) {
  return texts.map((t) => ({ current: true, subject: patchId, predicate: "es-intervention-text", object: t }));
}

test("CONSUME: getFailureInterventions returns patches only for matching (model, shape)", async () => {
  const model = "litellm/model-a";
  const shapeX = "aaaa0001";
  const patchAX = buildFailurePatchId(model, shapeX, "spiral-nudge");
  // A DIFFERENT shape for the same model must NOT return this patch.
  const shapeY = "bbbb0002";

  const factsByEntity = {
    [patchAX]: patchFacts(patchAX, ["Stop speculating and gather evidence."]),
  };

  const { client } = makeFailureClient(factsByEntity);

  // Matching (model, shape) => patch returned.
  const resMatch = await client.getFailureInterventions(model, shapeX);
  assert.equal(resMatch.length, 1, "matching (model, shape) must return the patch");
  assert.ok(resMatch[0].includes("Stop speculating"), "patch text must be present");

  // Same model, DIFFERENT shape => no patch (no cross-shape bleed).
  const resNoMatch = await client.getFailureInterventions(model, shapeY);
  assert.equal(resNoMatch.length, 0, "non-matching shape must return no patches");

  // Different model, same shape => no patch (no cross-model bleed).
  const resOtherModel = await client.getFailureInterventions("litellm/model-b", shapeX);
  assert.equal(resOtherModel.length, 0, "different model must return no patches");
});

test("CONSUME: getFailureInterventions returns empty for absent data (no injection)", async () => {
  const { client } = makeFailureClient({});
  const res = await client.getFailureInterventions("litellm/unknown", "cccc0003");
  assert.deepEqual(res, [], "absent data must yield an empty list");
});

test("CONSUME: getFailureInterventions degrades gracefully on kg_query failure", async () => {
  const client = createMemgraphClient({
    callTool: async () => {
      throw new Error("server down");
    },
  });
  const res = await client.getFailureInterventions("litellm/x", "dddd0004");
  assert.deepEqual(res, [], "failed reads must degrade to no patches");
});

test("CONSUME: getFailureInterventions is bounded by maxPatches", async () => {
  const model = "litellm/model-a";
  const shape = "eeee0005";
  // Three labels, each with a distinct patch text.
  const factsByEntity = {
    [buildFailurePatchId(model, shape, "spiral-nudge")]: patchFacts(buildFailurePatchId(model, shape, "spiral-nudge"), ["patch-1"]),
    [buildFailurePatchId(model, shape, "retry-nudge")]: patchFacts(buildFailurePatchId(model, shape, "retry-nudge"), ["patch-2"]),
    [buildFailurePatchId(model, shape, "loop-block")]: patchFacts(buildFailurePatchId(model, shape, "loop-block"), ["patch-3"]),
  };
  const { client } = makeFailureClient(factsByEntity);

  const resAll = await client.getFailureInterventions(model, shape);
  assert.equal(resAll.length, 3, "default maxPatches must allow all 3 labels");

  const resOne = await client.getFailureInterventions(model, shape, { maxPatches: 1 });
  assert.equal(resOne.length, 1, "maxPatches=1 must bound to 1 patch");
});

// ── (f) CREATE: MemgraphClient write methods ─────────────────────────────────

test("CREATE: recordFailureEvent writes es-failure-event edge", async () => {
  const kgAdds = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_add")) {
        kgAdds.push(args || {});
        return {};
      }
      return {};
    },
  });
  const bucket = buildFailureBucketId("litellm/model-a", "aaaa0001");
  await client.recordFailureEvent(bucket, "spiral", "2026-08-28T00:00:00Z");
  assert.equal(kgAdds.length, 1);
  assert.equal(kgAdds[0].subject, bucket);
  assert.equal(kgAdds[0].predicate, "es-failure-event");
  assert.equal(kgAdds[0].object, "spiral");
});

test("CREATE: recordFailureEvent rejects invalid event values (closed set)", async () => {
  const client = createMemgraphClient({ callTool: async () => ({}) });
  await assert.rejects(
    () => client.recordFailureEvent(buildFailureBucketId("m", "s"), "weird-event"),
    /invalid event/,
    "unknown event values must be rejected (closed set)",
  );
});

test("CREATE: recordIntervention writes es-intervention-label + es-intervention-text", async () => {
  const kgAdds = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_add")) {
        kgAdds.push(args || {});
        return {};
      }
      return {};
    },
  });
  const patchId = buildFailurePatchId("litellm/model-a", "aaaa0001", "spiral-nudge");
  const ok = await client.recordIntervention(patchId, "spiral-nudge", "Stop speculating and gather evidence.");
  assert.equal(ok, true);
  assert.equal(kgAdds.length, 2);
  assert.equal(kgAdds[0].predicate, "es-intervention-label");
  assert.equal(kgAdds[0].object, "spiral-nudge");
  assert.equal(kgAdds[1].predicate, "es-intervention-text");
  assert.equal(kgAdds[1].object, "Stop speculating and gather evidence.");
});

test("CREATE: recordIntervention bounds text to FAILURE_PATCH_TEXT_MAX_CHARS", async () => {
  const kgAdds = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_add")) {
        kgAdds.push(args || {});
        return {};
      }
      return {};
    },
  });
  const patchId = buildFailurePatchId("litellm/model-a", "aaaa0001", "spiral-nudge");
  const longText = "x".repeat(FAILURE_PATCH_TEXT_MAX_CHARS + 100);
  await client.recordIntervention(patchId, "spiral-nudge", longText);
  const textFact = kgAdds.find((a) => a.predicate === "es-intervention-text");
  assert.equal(textFact.object.length, FAILURE_PATCH_TEXT_MAX_CHARS, "text must be bounded to max chars");
});

// ── (g) Predicate collision check: es-failure-* / es-intervention-* NOT reserved ─

test("es-failure-* and es-intervention-* predicates do not collide with the reserved set", () => {
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
  const NEW = [
    MemgraphClient.FAILURE_EVENT_PREDICATE,
    MemgraphClient.FAILURE_SHAPE_PREDICATE,
    MemgraphClient.INTERVENTION_LABEL_PREDICATE,
    MemgraphClient.INTERVENTION_TEXT_PREDICATE,
  ];
  for (const p of NEW) {
    assert.ok(!RESERVED.includes(p), `${p} must not be in the reserved set`);
  }
});

test("es-failure-* predicates do not collide with Phase 14 es-capability-*", () => {
  const CAPABILITY = [
    MemgraphClient.CAPABILITY_OUTCOME_PREDICATE,
    MemgraphClient.CAPABILITY_SHAPE_PREDICATE,
    MemgraphClient.CAPABILITY_TIER_PREDICATE,
  ];
  const NEW = [
    MemgraphClient.FAILURE_EVENT_PREDICATE,
    MemgraphClient.FAILURE_SHAPE_PREDICATE,
    MemgraphClient.INTERVENTION_LABEL_PREDICATE,
    MemgraphClient.INTERVENTION_TEXT_PREDICATE,
  ];
  for (const p of NEW) {
    assert.ok(!CAPABILITY.includes(p), `${p} must not collide with es-capability-*`);
  }
});
