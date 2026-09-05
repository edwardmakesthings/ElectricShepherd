import assert from "node:assert/strict";
import test from "node:test";

import { runSynthesisConsolidation } from "../../src/capability/episodic/synthesis-consolidation.ts";
import {
  parseDeadEndLine,
  validateDeadEndLines,
  renderDeadEndsBlock,
  renderDeadEndLine,
  RULED_OUT_MARKER,
} from "../../src/capability/negative/dead-ends.ts";

/**
 * Phase 9 (unified memory): negative-knowledge pass-through + label contract.
 *
 * These tests pin the deterministic core that makes "never an unlabelled dead end"
 * enforceable:
 *   - the mapper DEAD_ENDS lines survive parse -> summary -> draft verbatim
 *     (order preserved, no re-sort), and absent sections degrade to empty;
 *   - the render-time label is HARD: every bullet carries the [RULED OUT ...] marker
 *     plus its outcome clause, and an empty input omits the whole section;
 *   - the cap is enforced deterministically with a truncation indicator;
 *   - polarity is two-valued (tried-failed vs considered-rejected) and preserved.
 */

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

test("DEAD_ENDS lines survive parse -> summary -> draft verbatim (order preserved)", async () => {
  const summaries = [
    {
      transcriptId: "raw-001",
      confidence: "high",
      durableFacts: ["ElectricShepherd is the policy layer"],
      decisions: ["Use append-only source drawers"],
      rootCausesAndWorkedExamples: ["Gateway blocked scoped lineage listing via allow-list"],
      subsystemsAndFiles: ["adapter/synthesis-consolidation.ts"],
      openItems: ["Add an end-to-end retrieval test"],
      deadEnds: [
        'cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: "marker removed before the request" | polarity: tried-failed',
      ],
    },
    {
      transcriptId: "raw-002",
      confidence: "medium",
      durableFacts: ["The inflation guard blocks weak syntheses"],
      decisions: ["Keep the dedup gate configurable"],
      rootCausesAndWorkedExamples: ["check_duplicate uses cosine similarity at 0.9"],
      subsystemsAndFiles: ["scripts/capture-source-transcripts.sh"],
      openItems: ["Document the mem-core render contract"],
      deadEnds: [
        'a second approach | outcome: it was considered and rejected | because: "too costly" | polarity: considered-rejected',
      ],
    },
  ];

  const result = await runSynthesisConsolidation(stubClient(), {
    ...baseOptions,
    minimumMapperConfidence: "medium",
    mapperSummaries: summaries,
  });

  assert.equal(result.usedProvidedMapperSummaries, true);
  // Both dead ends survive, in source order (no re-sort).
  assert.deepEqual(result.consolidationDraft.deadEnds, [
    'cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: "marker removed before the request" | polarity: tried-failed',
    'a second approach | outcome: it was considered and rejected | because: "too costly" | polarity: considered-rejected',
  ]);
  // The negative-knowledge section is present in the persisted content, labelled.
  assert.match(result.consolidationDraft.content, /## Dead Ends \(ruled out — do not re-propose\)/);
  assert.ok(result.consolidationDraft.content.includes("cache_control injection on the openai/ prefix"));
});

test("absent DEAD_ENDS degrades to empty without failure", async () => {
  const summaries = [
    {
      transcriptId: "raw-001",
      confidence: "high",
      durableFacts: ["ElectricShepherd is the policy layer"],
      decisions: ["Use append-only source drawers"],
      rootCausesAndWorkedExamples: ["Gateway blocked scoped lineage listing via allow-list"],
      subsystemsAndFiles: ["adapter/synthesis-consolidation.ts"],
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

  const result = await runSynthesisConsolidation(stubClient(), {
    ...baseOptions,
    minimumMapperConfidence: "medium",
    mapperSummaries: summaries,
  });

  // No dead ends -> no negative-knowledge section in the content (no per-closet tax).
  assert.equal(result.consolidationDraft.deadEnds, undefined);
  assert.ok(!result.consolidationDraft.content.includes("## Dead Ends"), "empty dead-ends must not render a section");
});

test("parseDeadEndLine extracts tried/outcome/because/polarity and rejects missing outcome", () => {
  const ok = parseDeadEndLine(
    'cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: "marker removed" | polarity: tried-failed',
  );
  assert.ok(ok.parsed, `expected parse, got error ${ok.error}`);
  assert.equal(ok.parsed.tried, "cache_control injection on the openai/ prefix");
  assert.equal(ok.parsed.outcome, "this does not work, LiteLLM strips the marker");
  assert.equal(ok.parsed.because, '"marker removed"');
  assert.equal(ok.parsed.polarity, "tried-failed");

  const rejected = parseDeadEndLine(
    'a considered approach | polarity: considered-rejected',
  );
  // No outcome clause -> incomplete -> must not be filed.
  assert.equal(rejected.parsed, null);
  assert.match(rejected.error || "", /outcome/i);
});

test("validateDeadEndLines separates valid from incomplete lines", () => {
  const { valid, invalid } = validateDeadEndLines([
    'tried X | outcome: failed | because: "reason" | polarity: tried-failed',
    'incomplete line with no outcome',
  ]);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 1);
});

test("renderDeadEndLine always carries the hard RULED OUT marker + outcome clause", () => {
  const line = renderDeadEndLine({
    tried: "cache_control injection on the openai/ prefix",
    outcome: "this does not work, LiteLLM strips the marker",
    because: "marker removed before the request",
    polarity: "tried-failed",
  });
  assert.ok(line.startsWith("- [RULED OUT"), `missing hard marker: ${line}`);
  assert.ok(line.includes("tried and failed"), `polarity label missing: ${line}`);
  // The outcome clause must stay attached to the tried text — never an unlabelled dead end.
  assert.ok(line.includes("this does not work, LiteLLM strips the marker"), `outcome clause dropped: ${line}`);

  const rejected = renderDeadEndLine({
    tried: "a considered approach",
    outcome: "it was considered and rejected",
    because: "",
    polarity: "considered-rejected",
  });
  assert.ok(rejected.includes("considered and rejected"), `weaker-evidence label missing: ${rejected}`);
});

test("renderDeadEndsBlock is bounded, drops the empty section, and caps deterministically", () => {
  // Empty input -> no section at all (no per-prompt tax).
  assert.deepEqual(renderDeadEndsBlock([]), []);
  assert.deepEqual(renderDeadEndsBlock([], 3), []);

  const five = [
    'tried A | outcome: failed | because: "r" | polarity: tried-failed',
    'tried B | outcome: failed | because: "r" | polarity: tried-failed',
    'tried C | outcome: failed | because: "r" | polarity: considered-rejected',
    'tried D | outcome: failed | because: "r" | polarity: tried-failed',
    'tried E | outcome: failed | because: "r" | polarity: tried-failed',
  ];

  const block = renderDeadEndsBlock(five, 3);
  // Header + 2 descriptive lines? No — header line + intro line + 3 bullets + 1 truncation.
  assert.ok(block[0] === "## [dead-ends]", `header missing: ${block[0]}`);
  const bullets = block.filter((l) => l.startsWith("- ") && !l.startsWith("- ..."));
  assert.equal(bullets.length, 3, `expected exactly 3 bullets, got ${bullets.length}`);
  // Every bullet carries the hard marker.
  for (const bullet of bullets) {
    assert.ok(bullet.includes(RULED_OUT_MARKER), `unlabelled dead end leaked: ${bullet}`);
  }
  // Truncation indicator present and deterministic.
  assert.ok(block.some((l) => l.startsWith("- ... (2 more ruled out)")), "truncation indicator missing");

  // cap=0 -> no section.
  assert.deepEqual(renderDeadEndsBlock(five, 0), []);
});
