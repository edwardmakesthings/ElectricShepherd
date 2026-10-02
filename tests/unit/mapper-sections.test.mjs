import assert from "node:assert/strict";
import test from "node:test";

import { parseMapperSections } from "../../src/scripts/memory-pipeline/subagent.ts";

const ATTRIBUTED_SECTION_OUTPUT = `
TRANSCRIPT_ID: drawer_a

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

const MULTI_BLOCK_OUTPUT = `
TRANSCRIPT_ID: drawer_a
**DURABLE_FACTS**
- a

CONFIDENCE: medium

---

TRANSCRIPT_ID: drawer_b
**DURABLE_FACTS**
- b

CONFIDENCE: low
`;

test("mapper section parser recovers explicitly-attributed section summaries", () => {
  const summaries = parseMapperSections(ATTRIBUTED_SECTION_OUTPUT, ["drawer_a"]);

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

test("mapper section parser only accepts transcript ids from explicit headers", () => {
  const summaries = parseMapperSections(MULTI_BLOCK_OUTPUT, ["drawer_a", "drawer_b", "drawer_c"]);
  assert.deepEqual(
    summaries.map((s) => s.transcriptId),
    ["drawer_a", "drawer_b"],
  );
});

test("mapper section parser rejects unattributed batch sections", () => {
  const unattributed = `
**DURABLE_FACTS**
- fact without transcript id

CONFIDENCE: high
`;
  assert.deepEqual(parseMapperSections(unattributed, ["drawer_a"]), []);
});

test("mapper section parser accepts markdown and bare headings inside a transcript block", () => {
  const variants = [
    "TRANSCRIPT_ID: d1\n## DURABLE_FACTS\n- a fact",
    "TRANSCRIPT_ID: d1\nDURABLE_FACTS:\n- a fact",
    "TRANSCRIPT_ID: d1\n**DURABLE_FACTS**\n- a fact",
  ];
  for (const text of variants) {
    const [summary] = parseMapperSections(text, ["d1"]);
    assert.deepEqual(summary.durableFacts, ["a fact"], text);
  }
});

test("mapper section parser defaults confidence when the trailer is missing", () => {
  const [summary] = parseMapperSections("TRANSCRIPT_ID: d1\n**DECISIONS**\n- chose X", ["d1"]);
  assert.equal(summary.confidence, "medium");
});
