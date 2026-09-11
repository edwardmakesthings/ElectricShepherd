import assert from "node:assert/strict";
import test from "node:test";

import { scoreEnvelope, summarize } from "../../src/scripts/benchmark-mapper-models.ts";

function summary(patch = {}) {
  return {
    transcriptId: "d1",
    confidence: "high",
    durableFacts: ["a fact"],
    decisions: [],
    rootCausesAndWorkedExamples: [],
    subsystemsAndFiles: [],
    openItems: [],
    deadEnds: [],
    ...patch,
  };
}

const envelope = (summaries) => ({ summaries, raw: summaries, via: "omp-run" });

// Parse success is the quarantine gate — an empty envelope is the failure the
// whole benchmark exists to detect.
test("scoreEnvelope treats an empty envelope as unparsed", () => {
  const score = scoreEnvelope(envelope([]), ["d1"]);
  assert.equal(score.parsed, false);
  assert.equal(score.covered, false);
});

test("scoreEnvelope requires a summary for every requested id", () => {
  const score = scoreEnvelope(envelope([summary()]), ["d1", "d2"]);
  assert.equal(score.parsed, true);
  assert.equal(score.covered, false, "d2 was requested and not returned");
});

test("scoreEnvelope flags ids that were never requested", () => {
  const score = scoreEnvelope(envelope([summary(), summary({ transcriptId: "ghost" })]), ["d1"]);
  assert.deepEqual(score.fabricated, ["ghost"]);
});

// An all-empty summary parses cleanly and is useless, so parse rate alone would
// rank it as a success.
test("scoreEnvelope counts populated fields so empty summaries cannot pass as good", () => {
  const empty = scoreEnvelope(envelope([summary({ durableFacts: [] })]), ["d1"]);
  assert.equal(empty.parsed, true);
  assert.equal(empty.populatedFields, 0);

  const full = scoreEnvelope(envelope([summary({ decisions: ["chose X"], openItems: ["ship it"] })]), ["d1"]);
  assert.equal(full.populatedFields, 3);
});

test("scoreEnvelope checks dead-end lines carry outcome, because, and polarity", () => {
  const good = 'tried Y | outcome: failed | because: "leaks" | polarity: tried-failed';
  const score = scoreEnvelope(envelope([summary({ deadEnds: [good, "just gave up"] })]), ["d1"]);
  assert.equal(score.deadEndLines, 2);
  assert.equal(score.deadEndWellFormed, 1);
});

test("summarize reports rates per model rather than a single sample", () => {
  const base = { drawerId: "d1", fabricated: [], populatedFields: 2, deadEndLines: 0, deadEndWellFormed: 0, confidence: "high" };
  const [row] = summarize([
    { model: "m", repeat: 1, parsed: true, covered: true, ms: 100, ...base },
    { model: "m", repeat: 2, parsed: false, covered: false, ms: 300, ...base },
    { model: "m", repeat: 3, parsed: true, covered: true, ms: 200, ...base },
  ]);
  assert.equal(row.parse_rate, "2/3");
  assert.equal(row.coverage_rate, "2/3");
  assert.equal(row.median_ms, 200);
  assert.equal(row.max_ms, 300);
});

test("summarize keeps models in separate rows", () => {
  const base = { drawerId: "d1", repeat: 1, parsed: true, covered: true, ms: 10, fabricated: [], populatedFields: 1, deadEndLines: 0, deadEndWellFormed: 0, confidence: "high" };
  const rows = summarize([{ ...base, model: "a" }, { ...base, model: "b" }]);
  assert.deepEqual(rows.map((r) => r.model), ["a", "b"]);
});
