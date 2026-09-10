import assert from "node:assert/strict";
import test from "node:test";

import { parseMapperSections } from "../../src/scripts/memory-pipeline/subagent.ts";

// The exact shape a mapper following agents/dream-mapper.md used to emit, which
// the JSON parser could not read — every drawer was quarantined as a result.
const SECTION_OUTPUT = `
I have the complete transcript. Let me produce the mapper summary.

**DURABLE_FACTS**
- manifest version is 0.1.0
- grep for 0.1.0 matches exactly 5 files

**DECISIONS**
- Read-only audit; no durable STATE block changed.

**ROOT_CAUSES_AND_WORKED_EXAMPLES**
- Worked example of the "search before assuming unsaved" discipline

**SUBSYSTEMS_AND_FILES**
- src/core/mcp-transport.ts:131

**OPEN_ITEMS**
- Add both hardcoded sites to a version-bump checklist

**DEAD_ENDS**

CONFIDENCE: high - all facts verbatim from source.
`;

test("mapper section parser recovers summaries the JSON parser cannot read", () => {
  const summaries = parseMapperSections(SECTION_OUTPUT, ["drawer_a"]);

  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.equal(summary.transcriptId, "drawer_a");
  assert.equal(summary.confidence, "high");
  assert.deepEqual(summary.durableFacts, [
    "manifest version is 0.1.0",
    "grep for 0.1.0 matches exactly 5 files",
  ]);
  assert.deepEqual(summary.decisions, ["Read-only audit; no durable STATE block changed."]);
  assert.deepEqual(summary.subsystemsAndFiles, ["src/core/mcp-transport.ts:131"]);
  assert.deepEqual(summary.deadEnds, []);
});

// transcriptId is what lineage attaches to, so a batch's sections must be
// attributed to the drawers actually asked about, never invented.
test("mapper section parser attributes a batch to every requested transcript", () => {
  const summaries = parseMapperSections(SECTION_OUTPUT, ["drawer_a", "drawer_b"]);
  assert.deepEqual(
    summaries.map((s) => s.transcriptId),
    ["drawer_a", "drawer_b"],
  );
});

test("mapper section parser accepts markdown and bare headings", () => {
  const variants = ["## DURABLE_FACTS\n- a fact", "DURABLE_FACTS:\n- a fact", "**DURABLE_FACTS**\n- a fact"];
  for (const text of variants) {
    const [summary] = parseMapperSections(text, ["d1"]);
    assert.deepEqual(summary.durableFacts, ["a fact"], text);
  }
});

test("mapper section parser defaults confidence when the trailer is missing", () => {
  const [summary] = parseMapperSections("**DECISIONS**\n- chose X", ["d1"]);
  assert.equal(summary.confidence, "medium");
});

test("mapper section parser yields nothing for prose with no sections", () => {
  assert.deepEqual(parseMapperSections("I could not read the transcript, sorry.", ["d1"]), []);
  assert.deepEqual(parseMapperSections("", ["d1"]), []);
});

// An empty result must stay empty rather than manufacturing a summary with no
// content, which would consolidate into an orphan node.
test("mapper section parser rejects headings with no bullets", () => {
  assert.deepEqual(parseMapperSections("**DURABLE_FACTS**\n\n**DECISIONS**\n", ["d1"]), []);
});
