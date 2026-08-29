import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { runSynthesisConsolidation } from "../../adapter/synthesis-consolidation.ts";
import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";
import { runValidationMergeReview } from "../../adapter/validation-merge-review.ts";
import { createTestRoom, isIntegrationEnabled, reportSkippedIntegrationTests } from "../helpers/mempalace-room-fixture.mjs";

/**
 * End-to-end integration coverage for source-drawer -> derived-drawer -> retrieval
 * path against a real MemPalace endpoint, in an isolated, disposable room.
 *
 * This is the test that proves the pipeline actually works (not just that
 * envelopes are well-formed): we seed real source drawers, run the real
 * consolidation with writes enabled, and then assert that the resulting
 * derived drawer is BOTH (a) discoverable by scope via
 * `listScopedDerivedDrawers` — a hard, similarity-independent guarantee — and
 * (b) surfaced by the retrieval-expansion adapter for the room.
 *
 * Note the validation step between the two: under P2-2 a new closet is stamped
 * `es-status = provisional` at creation and is deliberately filtered out of
 * default retrieval until validation promotes it to `active` on >= 2 direct
 * sources. So consolidation alone is NOT expected to make a node retrievable —
 * running validation is part of the real end-to-end path, not test scaffolding.
 *
 * We provide mapper summaries keyed to the seeded drawer ids so the derived
 * drawer references genuine source drawers, while keeping the test independent of
 * MemPalace's (separately tested) extraction/search ranking.
 *
 * Gated by ESHEPHERD_TEST_INTEGRATION=1.
 */

const runIntegration = isIntegrationEnabled();
if (!runIntegration) reportSkippedIntegrationTests();

let room = null;

before(async () => {
  if (!runIntegration) return;
  room = await createTestRoom({ roomPrefix: "synth-pipeline" });
  if (!room.available) {
    throw new Error(`Test room unavailable: ${room.reason}`);
  }
});

after(async () => {
  if (room && room.available) {
    await room.teardown();
  }
});

test("source drawers consolidate into a derived drawer that is then discoverable", { skip: !runIntegration }, async () => {
  // 1) Seed real source drawers in the isolated room and capture their ids.
  const seededA = await room.addDrawer(
    "ElectricShepherd consolidation: decided synthesis requires two distinct source drawers " +
      "to clear the inflation guard. Root cause of earlier false-synth was single-source merges."
  );
  const seededB = await room.addDrawer(
    "ElectricShepherd consolidation: the dedup gate stays configurable via " +
      "sourceCapture.dedupEnabled. Subsystems: adapter/synthesis-consolidation.ts and " +
      "scripts/capture-source-transcripts.sh. Open item: end-to-end retrieval verification."
  );
  assert.equal(typeof seededA.drawer_id, "string");
  assert.equal(typeof seededB.drawer_id, "string");

  // 2) Run REAL consolidation with writes enabled. Mapper summaries are keyed
  //    to the seeded drawer ids so the derived drawer references real sources.
  const consolidation = await runSynthesisConsolidation(room.client, {
    query: "consolidation inflation guard and dedup gate",
    targetWing: room.wing,
    targetRoom: room.room,
    applyWrites: true,
    mapperSummaries: [
      {
        transcriptId: seededA.drawer_id,
        confidence: "high",
        durableFacts: ["Synthesis requires two distinct source drawers"],
        decisions: ["Enforce the inflation guard before any synth write"],
        rootCausesAndWorkedExamples: ["Single-source merges produced false syntheses"],
        subsystemsAndFiles: ["adapter/synthesis-consolidation.ts"],
        openItems: ["Verify retrieval surfaces new synth nodes"],
      },
      {
        transcriptId: seededB.drawer_id,
        confidence: "medium",
        durableFacts: ["The dedup gate is configurable via sourceCapture.dedupEnabled"],
        decisions: ["Keep dedup opt-in"],
        rootCausesAndWorkedExamples: ["check_duplicate gates appends on similarity"],
        subsystemsAndFiles: ["scripts/capture-source-transcripts.sh"],
        openItems: ["Document the mem-core render contract"],
      },
    ],
  });

  assert.equal(consolidation.inflationGuard.passed, true, JSON.stringify(consolidation.inflationGuard.reasons));
  assert.equal(typeof consolidation.createdNodeId, "string", "a derived drawer must be created");
  // Ensure teardown removes the derived drawer as well.
  room.track(consolidation.createdNodeId);

  // 3) Hard guarantee: the derived drawer is discoverable by scope.
  const scoped = await room.client.listScopedDerivedDrawers({
    scope_room: room.room,
    scope_wing: room.wing,
    wing: room.wing,
    room: room.room,
  });
  const scopedIds = Array.isArray(scoped?.nodes)
    ? scoped.nodes.map((n) => n.node_id)
    : [];
  assert.ok(
    scopedIds.includes(consolidation.createdNodeId),
    `listScopedDerivedDrawers did not return the new node. got: ${JSON.stringify(scopedIds)}`
  );

  // 4) The new closet starts provisional, so default retrieval must NOT show it
  //    yet. Asserting this first keeps the promotion below honest: without it,
  //    step 5 would still pass if the provisional gate silently stopped working.
  assert.equal(
    await room.client.getClosetStatus(consolidation.createdNodeId),
    "provisional",
    "a newly created closet must be stamped provisional"
  );

  // 5) Validation promotes it to active, because it has two direct sources.
  await runValidationMergeReview(room.client, {
    scopeRoom: room.room,
    scopeWing: room.wing,
    filterWing: room.wing,
    filterRoom: room.room,
    candidateNodeIds: [consolidation.createdNodeId],
    applyMerges: false,
  });
  assert.equal(
    await room.client.getClosetStatus(consolidation.createdNodeId),
    "active",
    "validation must promote a closet with >= 2 direct sources"
  );

  // 6) Now that it is active, the retrieval-expansion adapter surfaces it.
  const retrieval = await expandScopedRetrieval(room.client, {
    query: "inflation guard dedup gate consolidation",
    scope_room: room.room,
    scope_wing: room.wing,
    wing: room.wing,
    room: room.room,
    match_mode: "any",
    top_n: 10,
    seed_search_limit: 10,
    expansion_depth: 1,
  });
  const rankedIds = retrieval.ranked_nodes.map((n) => n.node_id);
  assert.ok(
    rankedIds.includes(consolidation.createdNodeId),
    `retrieval did not surface the new synth node. ranked: ${JSON.stringify(rankedIds)}`
  );
});
