import assert from "node:assert/strict";
import test from "node:test";

import { runSynthesisConsolidation } from "../../adapter/synthesis-consolidation.ts";

/**
 * Unit coverage for the synthesis consolidation contract — the deterministic
 * core of source-drawer -> derived-drawer consolidation.
 *
 * These tests drive the adapter with PROVIDED mapper summaries (so no MCP
 * search happens) and `applyWrites: false` by default (so no MCP write
 * happens), which lets us validate the parts ElectricShepherd actually owns:
 *   - confidence filtering (which sources are included vs dropped), and
 *   - the inflation guard (the gate that blocks weak/under-sourced syntheses
 *     from ever being written).
 *
 * MemPalace's own search/store semantics are NOT re-tested here.
 */

/** Two well-formed, distinct-source summaries that should clear the guard. */
function richSummaries() {
  return [
    {
      transcriptId: "raw-001",
      confidence: "high",
      durableFacts: ["ElectricShepherd is the policy layer", "MemPalace is the substrate"],
      decisions: ["Use append-only source drawers", "Consolidation requires two distinct sources"],
      rootCausesAndWorkedExamples: ["Gateway blocked scoped lineage listing via allow-list"],
      subsystemsAndFiles: ["adapter/synthesis-consolidation.ts", "plugin/turn-guard.ts"],
      openItems: ["Add an end-to-end retrieval test"],
    },
    {
      transcriptId: "raw-002",
      confidence: "medium",
      durableFacts: ["The inflation guard blocks weak syntheses"],
      decisions: ["Keep the dedup gate configurable"],
      rootCausesAndWorkedExamples: ["check_duplicate uses cosine similarity at 0.9"],
      subsystemsAndFiles: ["scripts/capture-source-transcripts.sh"],
      openItems: ["Document the mem-core render contract"],
    },
  ];
}

/** A client stub that fails loudly if the consolidator tries to touch MCP. */
function stubClient(overrides = {}) {
  return {
    search: async () => {
      throw new Error("search must not be called when mapperSummaries are provided");
    },
    createDerivedDrawer: async () => {
      throw new Error("createDerivedDrawer must not be called when applyWrites is false");
    },
    kgAdd: async () => ({ success: true }),
    ...overrides,
  };
}

const baseOptions = {
  query: "memory pipeline architecture",
  targetWing: "eshepherd-test",
  targetRoom: "unit-room",
};

test("confidence floor includes high/medium sources and drops low ones", async () => {
  const summaries = [
    ...richSummaries(),
    {
      transcriptId: "raw-003",
      confidence: "low",
      durableFacts: ["minor aside"],
      decisions: [],
      rootCausesAndWorkedExamples: [],
      subsystemsAndFiles: [],
      openItems: [],
    },
  ];

  const result = await runSynthesisConsolidation(stubClient(), {
    ...baseOptions,
    minimumMapperConfidence: "medium",
    mapperSummaries: summaries,
  });

  assert.equal(result.usedProvidedMapperSummaries, true);
  assert.deepEqual(result.includedSummaryIds.sort(), ["raw-001", "raw-002"]);
  assert.deepEqual(result.droppedSummaryIds, ["raw-003"]);
});

test("inflation guard fails when there are too few distinct sources", async () => {
  const result = await runSynthesisConsolidation(stubClient(), {
    ...baseOptions,
    mapperSummaries: [richSummaries()[0]], // single source
  });

  assert.equal(result.inflationGuard.passed, false);
  assert.ok(
    result.inflationGuard.reasons.some((r) => /distinct source/i.test(r)),
    `expected a distinct-source reason, got: ${JSON.stringify(result.inflationGuard.reasons)}`
  );
  assert.equal(result.createdNodeId, undefined);
});

test("inflation guard passes for well-formed, multi-source evidence and builds a structured draft", async () => {
  const result = await runSynthesisConsolidation(stubClient(), {
    ...baseOptions,
    mapperSummaries: richSummaries(),
  });

  assert.equal(result.inflationGuard.passed, true, JSON.stringify(result.inflationGuard.reasons));
  assert.ok(result.sourceDrawerIds.length >= 2, "expected >= 2 distinct source drawer ids");
  assert.ok(
    result.consolidationDraft.populatedSectionCount >= 3,
    `expected >= 3 populated sections, got ${result.consolidationDraft.populatedSectionCount}`
  );
  assert.ok(result.consolidationDraft.contentCharacters >= 220);
  assert.match(result.consolidationDraft.content, /## Durable Facts/);
  assert.match(result.consolidationDraft.content, /## Decisions/);
  // applyWrites defaults off, so nothing is persisted.
  assert.equal(result.createdNodeId, undefined);
});

test("applyWrites persists a derived drawer only when the guard passes", async () => {
  const calls = [];
  const kgCalls = [];
  const client = stubClient({
    createDerivedDrawer: async (args) => {
      calls.push(args);
      return { node_id: "synth-xyz" };
    },
    kgAdd: async (args) => {
      kgCalls.push(args);
      return { success: true };
    },
  });

  const result = await runSynthesisConsolidation(client, {
    ...baseOptions,
    applyWrites: true,
    labels: ["pinned"],
    mapperSummaries: richSummaries(),
  });

  assert.equal(result.inflationGuard.passed, true);
  assert.equal(result.createdNodeId, "synth-xyz");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wing, "eshepherd-test");
  assert.equal(calls[0].room, "unit-room");
  assert.deepEqual(calls[0].source_drawer_ids.sort(), ["raw-001", "raw-002"]);
  assert.deepEqual(calls[0].labels, ["pinned"]);
  assert.ok(calls[0].content.includes("## Decisions"));
  assert.ok(kgCalls.length > 0, "expected hall/fact KG writes during applyWrites");
  assert.ok(kgCalls.some((call) => call.predicate === "in-hall"));
});

test("applyWrites does NOT persist when the inflation guard fails", async () => {
  let called = false;
  const client = stubClient({
    createDerivedDrawer: async () => {
      called = true;
      return { node_id: "should-not-happen" };
    },
  });

  const result = await runSynthesisConsolidation(client, {
    ...baseOptions,
    applyWrites: true,
    mapperSummaries: [richSummaries()[0]], // single source -> guard fails
  });

  assert.equal(result.inflationGuard.passed, false);
  assert.equal(called, false, "createDerivedDrawer must not run when the guard fails");
  assert.equal(result.createdNodeId, undefined);
});
