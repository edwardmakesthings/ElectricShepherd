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

/**
 * Phase 9 wiring: dead-end lines from the included summaries must be filed as real
 * negative-polarity syntheses via client.fileDeadEnd — NOT just rendered as plain-text
 * bullets in the main drawer. These tests drive runSynthesisConsolidation with a stub
 * client that records fileDeadEnd calls and assert the wiring path end-to-end:
 *   - one fileDeadEnd call per VALID dead-end line,
 *   - correct source_drawer_ids lineage (the same ids used for synthesis lineage),
 *   - correct wing/room/polarity/statements,
 *   - incomplete lines (no outcome clause) are skipped, never filed,
 *   - a filing failure is fault-tolerant (never throws, recorded in metadata), and
 *   - the result carries deadEndFiling counts.
 */

function summariesWithDeadEnds() {
  return [
    {
      transcriptId: "raw-001",
      confidence: "high",
      durableFacts: ["ElectricShepherd is the policy layer"],
      decisions: ["Use append-only source drawers"],
      rootCausesAndWorkedExamples: [],
      subsystemsAndFiles: ["adapter/synthesis-consolidation.ts"],
      openItems: [],
      deadEnds: [
        "cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: \"marker removed\" | polarity: tried-failed",
        "retrying with a longer backoff window | outcome: still failed under load | because: upstream rate limit is hard | polarity: tried-failed",
      ],
    },
    {
      transcriptId: "raw-002",
      confidence: "medium",
      durableFacts: ["The inflation guard blocks weak syntheses"],
      decisions: [],
      rootCausesAndWorkedExamples: [],
      subsystemsAndFiles: [],
      openItems: [],
      deadEnds: [
        // Duplicate of raw-001's first line — must be deduped, filed once.
        "cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: \"marker removed\" | polarity: tried-failed",
        // Incomplete (no outcome clause) — must be SKIPPED, never filed.
        "a bare mention with no outcome clause",
      ],
    },
  ];
}

test("applyWrites files each valid dead-end line via client.fileDeadEnd with correct lineage", async () => {
  const fileDeadEndCalls = [];
  const client = stubClient({
    createDerivedDrawer: async () => ({ node_id: "synth-dead" }),
    kgAdd: async () => ({ success: true }),
    fileDeadEnd: async (args) => {
      fileDeadEndCalls.push(args);
      return { success: true, node_id: `dead-${fileDeadEndCalls.length}`, rules_out_edges_added: 2, errors: [] };
    },
  });

  const result = await runSynthesisConsolidation(client, {
    ...baseOptions,
    applyWrites: true,
    runId: "run-9",
    mapperSummaries: summariesWithDeadEnds(),
  });

  // Two distinct valid lines (the duplicate is deduped; the incomplete one is skipped).
  assert.equal(result.inflationGuard.passed, true);
  assert.equal(fileDeadEndCalls.length, 2, `expected 2 fileDeadEnd calls, got ${fileDeadEndCalls.length}`);

  // Each call carries the same source_drawer_ids lineage as the main synthesis drawer.
  const expectedSources = ["raw-001", "raw-002"];
  for (const call of fileDeadEndCalls) {
    assert.equal(call.wing, baseOptions.targetWing);
    assert.equal(call.room, baseOptions.targetRoom);
    assert.deepEqual(call.source_drawer_ids.sort(), expectedSources);
    assert.equal(call.source_run_id, "run-9");
    // The edge object is the tried statement (what retrieval matches on), NOT the full line.
    assert.ok(Array.isArray(call.statements) && call.statements.length === 1);
    assert.ok(!call.statements[0].includes("outcome:"), "statement must be the tried text, not the full line");
    // The drawer content is the FULL verbatim line so the read path can re-derive the label.
    assert.ok(call.content.includes("outcome:"), "drawer content must carry the outcome clause");
  }

  // Polarity is propagated per line.
  assert.ok(fileDeadEndCalls.every((c) => c.polarity === "tried-failed"));

  // Metadata reflects what happened.
  assert.ok(result.deadEndFiling, "deadEndFiling metadata must be present");
  assert.equal(result.deadEndFiling.filed, 2);
  assert.equal(result.deadEndFiling.failed, 0);
  assert.equal(result.deadEndFiling.skippedIncomplete, 1);
  assert.equal(result.deadEndFiling.rulesOutEdgesAdded, 4);
});

test("applyWrites does NOT file dead ends when the inflation guard fails", async () => {
  let fileDeadEndCalled = false;
  const client = stubClient({
    createDerivedDrawer: async () => ({ node_id: "should-not-happen" }),
    fileDeadEnd: async () => {
      fileDeadEndCalled = true;
      return { success: true, rules_out_edges_added: 1, errors: [] };
    },
  });

  const result = await runSynthesisConsolidation(client, {
    ...baseOptions,
    applyWrites: true,
    mapperSummaries: [summariesWithDeadEnds()[0]], // single source -> guard fails
  });

  assert.equal(result.inflationGuard.passed, false);
  assert.equal(fileDeadEndCalled, false, "fileDeadEnd must not run when the guard fails");
  assert.equal(result.deadEndFiling, undefined);
});

test("applyWrites is fault-tolerant: a fileDeadEnd failure is recorded, never thrown", async () => {
  const client = stubClient({
    createDerivedDrawer: async () => ({ node_id: "synth-dead" }),
    kgAdd: async () => ({ success: true }),
    fileDeadEnd: async (args) => {
      if (args.statements[0].includes("backoff")) {
        throw new Error("boom: rules-out edge write failed");
      }
      return { success: true, node_id: "dead-ok", rules_out_edges_added: 2, errors: [] };
    },
  });

  // Must not throw.
  const result = await runSynthesisConsolidation(client, {
    ...baseOptions,
    applyWrites: true,
    mapperSummaries: summariesWithDeadEnds(),
  });

  assert.equal(result.deadEndFiling.filed, 1);
  assert.equal(result.deadEndFiling.failed, 1);
  assert.ok(
    result.deadEndFiling.errors.some((e) => /boom/.test(e)),
    `expected the failure to be recorded in errors, got: ${JSON.stringify(result.deadEndFiling.errors)}`
  );
});

test("applyWrites=false does NOT file dead ends (dry run)", async () => {
  let fileDeadEndCalled = false;
  const client = stubClient({
    fileDeadEnd: async () => {
      fileDeadEndCalled = true;
      return { success: true, rules_out_edges_added: 1, errors: [] };
    },
  });

  const result = await runSynthesisConsolidation(client, {
    ...baseOptions,
    // applyWrites defaults off.
    mapperSummaries: summariesWithDeadEnds(),
  });

  assert.equal(fileDeadEndCalled, false, "fileDeadEnd must not run on a dry run");
  assert.equal(result.deadEndFiling, undefined);
});
