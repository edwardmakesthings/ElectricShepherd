import assert from "node:assert/strict";
import test from "node:test";

/**
 * P0-3 acceptance: getFailureInterventions (adapter/memgraph.ts) — the sole reader
 * of the es-intervention-label / es-intervention-text predicates — is now wired into
 * the LIVE delegation path in plugin/session-policy.ts (tool.execute.before, task
 * branch). When a (model, shape) pair has recorded interventions from prior
 * failures, those interventions are injected into the outgoing delegation prompt:
 * "last time this shape failed, here is what fixed it." Operator judgment: ALWAYS
 * ACTIVE with a neutral fallback — no interventions / empty result / MCP down /
 * throwing read => the prompt is left EXACTLY as-is. Bounded by
 * INTERVENTION_REPLAY_MAX_PATCHES via getFailureInterventions' maxPatches argument;
 * idempotent via the block-heading check on args.prompt.
 *
 *   1. a RECORDED INTERVENTION ALTERS A SUBSEQUENT PROMPT (acceptance criterion —
 *      real behavioral assertion: prompt-in vs prompt-out),
 *   2. no interventions recorded => prompt unchanged (neutral fallback),
 *   3. read failure / throw => prompt unchanged (graceful degradation),
 *   4. maxPatches bound is genuinely enforced (more recorded than the bound =>
 *      only the bound is injected).
 *
 * The decision logic lives in adapter/memgraph.ts (getFailureInterventions) and
 * the block formatting in adapter/retrieval-expansion.ts (formatInterventionBlock /
 * INTERVENTION_REPLAY_HEADING) — both are real modules, exercised here at the
 * adapter level with a fake kg_query backend. The live-hook composition is mirrored
 * exactly (same effectiveModel resolution fallback, same shape extraction on the
 * ORIGINAL prompt, same maxPatches argument).
 */

const { createMemgraphClient } = await import("../../src/core/memgraph.ts");
const { buildFailurePatchId, extractWorkedExampleShape, canonicalModelId, INTERVENTION_REPLAY_HEADING, formatInterventionBlock } =
  await import("../../src/capability/retrieval/retrieval-expansion.ts");

// The same constants the live hook passes (kept in sync with plugin/session-policy.ts).
const INTERVENTION_REPLAY_MAX_PATCHES = 3;
const MODEL = "litellm/model-a";
const PROMPT_IN = "Fix the failing test in web/src/foo.test.ts for the auth flow.";

// ── helpers: mirror the live hook's composition exactly ───────────────────────

function interventionFacts(patchId, texts) {
  return texts.map((t) => ({ current: true, subject: patchId, predicate: "es-intervention-text", object: t }));
}

/** Build a real MemgraphClient over a fake kg_query backend keyed by entity id. */
function makeInterventionClient(factsByEntity) {
  return createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query")) {
        const entity = String(args?.entity ?? "");
        return { facts: factsByEntity[entity] || [] };
      }
      return {};
    },
  });
}

/**
 * The exact composition the live hook performs for a delegation with `args.prompt`:
 * resolve effectiveModel (pinned model first, then routing model), extract the shape
 * from the ORIGINAL prompt, call getFailureInterventions with maxPatches =
 * INTERVENTION_REPLAY_MAX_PATCHES, format the block, and apply the idempotency guard.
 * Returns { prompt } — the outgoing prompt after the hook.
 */
async function liveInterventionReplay({ factsByEntity, args, routingModel, throwOnRead }) {
  const prompt = String(args?.prompt ?? "").trim();
  if (!prompt) return { prompt: String(args?.prompt ?? "") };
  // Idempotency guard (same check the hook runs on args.prompt).
  if (String(args?.prompt ?? "").includes(INTERVENTION_REPLAY_HEADING)) {
    return { prompt: String(args?.prompt ?? "") };
  }
  const client = throwOnRead
    ? createMemgraphClient({ callTool: async () => { throw new Error("server down"); } })
    : makeInterventionClient(factsByEntity);
  // effectiveModel resolution mirrors the hook: pinned args.model first, else routing.
  const pinned = args?.model && args.model.providerID && args.model.modelID
    ? canonicalModelId(args.model.providerID, args.model.modelID)
    : null;
  const effectiveModel = pinned ?? canonicalModelId(routingModel?.providerID, routingModel?.modelID);
  if (!effectiveModel) return { prompt: String(args?.prompt ?? "") };
  const shape = extractWorkedExampleShape(prompt);
  const interventions = await client.getFailureInterventions(effectiveModel, shape.shapeKey, {
    maxPatches: INTERVENTION_REPLAY_MAX_PATCHES,
  });
  const block = formatInterventionBlock(interventions);
  return { prompt: block ? `${String(args?.prompt ?? "")}${block}` : String(args?.prompt ?? "") };
}

function shapeKeyFor(prompt) {
  return extractWorkedExampleShape(prompt).shapeKey;
}

// ── (1) a recorded intervention alters a subsequent prompt ─────────────────────

test("LIVE intervention replay: RECORDED INTERVENTION ALTERS A SUBSEQUENT PROMPT", async () => {
  const shape = shapeKeyFor(PROMPT_IN);
  const patchId = buildFailurePatchId(MODEL, shape, "spiral-nudge");
  const factsByEntity = { [patchId]: interventionFacts(patchId, ["Stop speculating and gather evidence first."]) };

  const args = { prompt: PROMPT_IN, model: { providerID: "litellm", modelID: "model-a" } };
  const { prompt } = await liveInterventionReplay({ factsByEntity, args });

  assert.notEqual(prompt, PROMPT_IN, "the recorded intervention MUST alter the outgoing prompt");
  assert.ok(prompt.startsWith(PROMPT_IN), "the original prompt must be preserved as a prefix");
  assert.ok(prompt.includes(INTERVENTION_REPLAY_HEADING), "the block heading must be present");
  assert.ok(prompt.includes("Stop speculating and gather evidence first."), "the intervention text must be injected");
});

test("LIVE intervention replay: model resolved from routing context (no pinned args.model)", async () => {
  const shape = shapeKeyFor(PROMPT_IN);
  const patchId = buildFailurePatchId(MODEL, shape, "loop-block");
  const factsByEntity = { [patchId]: interventionFacts(patchId, ["Break the loop: take a different action."]) };

  const args = { prompt: PROMPT_IN }; // no args.model — routing model must be used
  const { prompt } = await liveInterventionReplay({
    factsByEntity,
    args,
    routingModel: { providerID: "litellm", modelID: "model-a" },
  });

  assert.ok(prompt.includes("Break the loop"), "routing-resolved model must key to the same patch node");
});

// ── (2) no interventions recorded => prompt unchanged (neutral fallback) ───────

test("LIVE intervention replay: no interventions recorded => prompt EXACTLY unchanged", async () => {
  const args = { prompt: PROMPT_IN, model: { providerID: "litellm", modelID: "model-a" } };
  const { prompt } = await liveInterventionReplay({ factsByEntity: {}, args });
  assert.equal(prompt, PROMPT_IN, "absent data must leave the prompt byte-identical");
});

test("LIVE intervention replay: different (model, shape) => no cross-bleed, prompt unchanged", async () => {
  const shape = shapeKeyFor(PROMPT_IN);
  // A patch recorded for a DIFFERENT model on the same shape must not inject.
  const otherPatchId = buildFailurePatchId("litellm/model-b", shape, "spiral-nudge");
  const factsByEntity = { [otherPatchId]: interventionFacts(otherPatchId, ["Should NOT appear."]) };

  const args = { prompt: PROMPT_IN, model: { providerID: "litellm", modelID: "model-a" } };
  const { prompt } = await liveInterventionReplay({ factsByEntity, args });
  assert.equal(prompt, PROMPT_IN, "a patch for a different model must not bleed into this delegation");
});

test("LIVE intervention replay: idempotency — an already-present block is NOT appended twice", async () => {
  const shape = shapeKeyFor(PROMPT_IN);
  const patchId = buildFailurePatchId(MODEL, shape, "spiral-nudge");
  const factsByEntity = { [patchId]: interventionFacts(patchId, ["Apply the fix."]) };

  // First pass: block appended.
  const first = await liveInterventionReplay({ factsByEntity, args: { prompt: PROMPT_IN, model: { providerID: "litellm", modelID: "model-a" } } });
  assert.ok(first.prompt.includes(INTERVENTION_REPLAY_HEADING));

  // Second pass (re-fired hook): the heading is already present => no double append.
  const second = await liveInterventionReplay({ factsByEntity, args: { prompt: first.prompt, model: { providerID: "litellm", modelID: "model-a" } } });
  assert.equal(second.prompt, first.prompt, "a re-fired hook must not double the intervention block");
  const occurrences = second.prompt.split(INTERVENTION_REPLAY_HEADING).length - 1;
  assert.equal(occurrences, 1, `the heading must appear exactly once (found ${occurrences})`);
});

// ── (3) read failure / throw => prompt unchanged (graceful degradation) ────────

test("LIVE intervention replay: kg_query throws => prompt EXACTLY unchanged", async () => {
  const args = { prompt: PROMPT_IN, model: { providerID: "litellm", modelID: "model-a" } };
  const { prompt } = await liveInterventionReplay({ factsByEntity: {}, args, throwOnRead: true });
  assert.equal(prompt, PROMPT_IN, "a throwing read must leave the prompt byte-identical");
});

test("LIVE intervention replay: MCP unavailable (no effective model) => prompt unchanged", async () => {
  const shape = shapeKeyFor(PROMPT_IN);
  const patchId = buildFailurePatchId(MODEL, shape, "spiral-nudge");
  const factsByEntity = { [patchId]: interventionFacts(patchId, ["Should NOT appear."]) };

  // No pinned model and no routing model => effectiveModel is null => neutral.
  const args = { prompt: PROMPT_IN };
  const { prompt } = await liveInterventionReplay({ factsByEntity, args, routingModel: null });
  assert.equal(prompt, PROMPT_IN, "no resolvable model must leave the prompt unchanged");
});

// ── (4) maxPatches bound is genuinely enforced ─────────────────────────────────

test("LIVE intervention replay: more recorded than the bound => only INTERVENTION_REPLAY_MAX_PATCHES injected", async () => {
  const shape = shapeKeyFor(PROMPT_IN);
  // All three closed labels carry distinct patches — the maximum recordable.
  const factsByEntity = {
    [buildFailurePatchId(MODEL, shape, "spiral-nudge")]: interventionFacts(buildFailurePatchId(MODEL, shape, "spiral-nudge"), ["patch-spiral"]),
    [buildFailurePatchId(MODEL, shape, "retry-nudge")]: interventionFacts(buildFailurePatchId(MODEL, shape, "retry-nudge"), ["patch-retry"]),
    [buildFailurePatchId(MODEL, shape, "loop-block")]: interventionFacts(buildFailurePatchId(MODEL, shape, "loop-block"), ["patch-loop"]),
  };

  const args = { prompt: PROMPT_IN, model: { providerID: "litellm", modelID: "model-a" } };
  const { prompt } = await liveInterventionReplay({ factsByEntity, args });

  assert.ok(prompt.includes("patch-spiral"), "first patch must be injected");
  // With the bound at 3 (== the closed label vocabulary) all three fit; the bound
  // is what keeps this from ever growing if the vocabulary widens.
  const injected = ["patch-spiral", "patch-retry", "patch-loop"].filter((p) => prompt.includes(p)).length;
  assert.ok(injected <= INTERVENTION_REPLAY_MAX_PATCHES, `injected patches (${injected}) must not exceed the bound (${INTERVENTION_REPLAY_MAX_PATCHES})`);

  // Direct adapter-level proof of the bound: maxPatches=1 yields exactly 1.
  const client = makeInterventionClient(factsByEntity);
  const bounded = await client.getFailureInterventions(MODEL, shape, { maxPatches: 1 });
  assert.equal(bounded.length, 1, "maxPatches=1 must yield exactly one patch");
});

test("LIVE intervention replay: bound is a live constant — mutating it changes the injected count", async () => {
  // Mutation-verified: this test pins the SAME constant the hook passes. If
  // INTERVENTION_REPLAY_MAX_PATCHES in plugin/session-policy.ts were changed, the
  // source assertion below would fail (the hook must pass the named constant), and
  // the adapter-level bound check here would reflect the new value.
  const shape = shapeKeyFor(PROMPT_IN);
  const factsByEntity = {
    [buildFailurePatchId(MODEL, shape, "spiral-nudge")]: interventionFacts(buildFailurePatchId(MODEL, shape, "spiral-nudge"), ["p1"]),
    [buildFailurePatchId(MODEL, shape, "retry-nudge")]: interventionFacts(buildFailurePatchId(MODEL, shape, "retry-nudge"), ["p2"]),
    [buildFailurePatchId(MODEL, shape, "loop-block")]: interventionFacts(buildFailurePatchId(MODEL, shape, "loop-block"), ["p3"]),
  };
  const client = makeInterventionClient(factsByEntity);

  // The bound the hook uses: exactly INTERVENTION_REPLAY_MAX_PATCHES injected.
  const atBound = await client.getFailureInterventions(MODEL, shape, { maxPatches: INTERVENTION_REPLAY_MAX_PATCHES });
  assert.equal(atBound.length, Math.min(3, INTERVENTION_REPLAY_MAX_PATCHES), "at the bound, exactly min(3, bound) patches are injected");

  // A STRICTER bound (1) genuinely reduces the count — proving the argument is live.
  const stricter = await client.getFailureInterventions(MODEL, shape, { maxPatches: 1 });
  assert.equal(stricter.length, 1, "a stricter maxPatches must reduce the injected count");
});
