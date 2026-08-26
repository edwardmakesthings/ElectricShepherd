import assert from "node:assert/strict";
import test from "node:test";

import { buildMemcoreMarkdown } from "../../scripts/run-memory-consolidation-and-validation.ts";

/**
 * Phase 9 (unified memory): the [dead-ends] mem-core render block.
 *
 * Pins the PROVE-side contract for negative knowledge:
 *   - a populated deadEndLines list renders a bounded "## [dead-ends]" section where
 *     EVERY bullet carries the hard "[RULED OUT ...]" marker (an unlabelled dead end
 *     reads as a suggestion — the spec's main risk);
 *   - the section is capped at maxDeadEnds with a deterministic truncation indicator;
 *   - an empty/absent list omits the whole section (no per-prompt tax);
 *   - includeDeadEnds:false suppresses the section even when lines are present.
 */

function makeConsolidation(deadEnds) {
  return {
    phase: "source-derived-consolidation",
    query: "how does the gateway work",
    usedProvidedMapperSummaries: true,
    mapperSummaryCount: 1,
    includedSummaryIds: ["raw-001"],
    droppedSummaryIds: [],
    sourceDrawerIds: ["drawer-src-1"],
    runId: "run-2026-08-26",
    createdNodeId: "node-synth-1",
    consolidationDraft: {
      title: "Gateway architecture synthesis",
      content: "# Consolidation: Gateway architecture synthesis",
      durableFacts: ["ElectricShepherd is the policy layer"],
      decisions: ["Use append-only source drawers"],
      openItems: ["Add an end-to-end retrieval test"],
      deadEnds,
      contentCharacters: 100,
      populatedSectionCount: 3,
      labels: [],
    },
    inflationGuard: { passed: true, reason: "ok" },
  };
}

function makeValidation() {
  return {
    downwardValidation: [{ nodeId: "node-synth-1", verdict: "pass" }],
    escalations: { nodeIds: [], mergePairs: [] },
  };
}

const DEAD_END_LINES = [
  'cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: "marker removed" | polarity: tried-failed',
  'a second approach | outcome: it was considered and rejected | because: "too costly" | polarity: considered-rejected',
];

test("populated deadEndLines render a bounded [dead-ends] section with hard RULED OUT markers", () => {
  const markdown = buildMemcoreMarkdown({
    query: "how does the gateway work",
    consolidation: makeConsolidation(DEAD_END_LINES),
    validation: makeValidation(),
    deadEndLines: DEAD_END_LINES,
  });

  assert.ok(markdown.includes("## [dead-ends]"), `missing [dead-ends] section:\n${markdown}`);

  // Every bullet in the section carries the hard marker.
  const lines = markdown.split("\n");
  const sectionStart = lines.findIndex((l) => l === "## [dead-ends]");
  assert.ok(sectionStart >= 0, "section header not found");
  const bullets = [];
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break; // next section
    if (lines[i].startsWith("- ") && !lines[i].startsWith("- ...")) bullets.push(lines[i]);
  }
  assert.equal(bullets.length, 2, `expected 2 dead-end bullets, got ${bullets.length}`);
  for (const bullet of bullets) {
    assert.ok(bullet.includes("[RULED OUT"), `unlabelled dead end leaked into render: ${bullet}`);
  }
  // Both polarities are distinguished.
  assert.ok(markdown.includes("tried and failed"), "strong-evidence label missing");
  assert.ok(markdown.includes("considered and rejected"), "weaker-evidence label missing");
});

test("the [dead-ends] section is capped at maxDeadEnds with a truncation indicator", () => {
  const five = [
    'tried A | outcome: failed | because: "r" | polarity: tried-failed',
    'tried B | outcome: failed | because: "r" | polarity: tried-failed',
    'tried C | outcome: failed | because: "r" | polarity: considered-rejected',
    'tried D | outcome: failed | because: "r" | polarity: tried-failed',
    'tried E | outcome: failed | because: "r" | polarity: tried-failed',
  ];

  const markdown = buildMemcoreMarkdown({
    query: "how does the gateway work",
    consolidation: makeConsolidation(five),
    validation: makeValidation(),
    deadEndLines: five,
    maxDeadEnds: 3,
  });

  const lines = markdown.split("\n");
  const sectionStart = lines.findIndex((l) => l === "## [dead-ends]");
  assert.ok(sectionStart >= 0);
  const bullets = [];
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (lines[i].startsWith("- ") && !lines[i].startsWith("- ...")) bullets.push(lines[i]);
  }
  assert.equal(bullets.length, 3, `expected exactly 3 bullets (cap), got ${bullets.length}`);
  assert.ok(markdown.includes("2 more ruled out"), "truncation indicator missing");
});

test("an empty/absent deadEndLines list omits the whole [dead-ends] section", () => {
  const withEmpty = buildMemcoreMarkdown({
    query: "how does the gateway work",
    consolidation: makeConsolidation(undefined),
    validation: makeValidation(),
    deadEndLines: [],
  });
  assert.ok(!withEmpty.includes("## [dead-ends]"), "empty list must not render a section");

  const withAbsent = buildMemcoreMarkdown({
    query: "how does the gateway work",
    consolidation: makeConsolidation(undefined),
    validation: makeValidation(),
  });
  assert.ok(!withAbsent.includes("## [dead-ends]"), "absent list must not render a section");
});

test("includeDeadEnds:false suppresses the section even when lines are present", () => {
  const markdown = buildMemcoreMarkdown({
    query: "how does the gateway work",
    consolidation: makeConsolidation(DEAD_END_LINES),
    validation: makeValidation(),
    deadEndLines: DEAD_END_LINES,
    includeDeadEnds: false,
  });
  assert.ok(!markdown.includes("## [dead-ends]"), "includeDeadEnds:false must suppress the section");
});
