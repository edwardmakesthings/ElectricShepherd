import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractSourceChunks as productionExtraction, extractionPromptHash } from "../../src/scripts/memory-pipeline/chunk-extraction.ts";
import { callSubagentMapper } from "../../src/scripts/memory-pipeline/subagent.ts";

const parentDrawerId = "drawer_test_source_parent";
// Preserve the existing per-piece semantic mocks while exercising the new production transport.
const extractSourceChunks = (args) => productionExtraction({ ...args, mapChunk: async (prompt, identity) => {
  const input = JSON.parse(prompt.split("\n").at(-1));
  const pieces = [];
  for (const piece of input.pieces) {
    const raw = await args.mapChunk(JSON.stringify(piece), { ...identity, ...piece });
    let result;
    try { result = JSON.parse(raw); } catch { result = { ...piece, complete: false }; }
    pieces.push({ pieceIndex: piece.pieceIndex, pieceCount: piece.pieceCount, ...result });
  }
  return JSON.stringify({ schemaVersion: 1, parentDrawerId: input.parentDrawerId, complete: true, pieces });
} });
const ids = [0, 1, 2].map((index) => `${parentDrawerId}_chunk_${String(index).padStart(6, "0")}`);
const topic = (topicKey, fact = "Durable evidence.", sourceQuotes = ["a"], origin = "source") => ({
  topicKey, title: topicKey, confidence: "high", origin, sourceQuotes, durableFacts: [fact], decisions: [],
  rootCausesAndWorkedExamples: [], subsystemsAndFiles: [], openItems: [], deadEnds: [],
});
const response = (chunkId, topics = [topic("main")]) => JSON.stringify({
  schemaVersion: 1, parentDrawerId, chunkId, complete: true,
  assessment: topics.length ? "topics" : "zero-substance", topics, contextualEvidence: [],
});
function harness(t, contents = ["raw start", "raw continuation", "late minority topic"]) {
  const directory = mkdtempSync(join(tmpdir(), "es-chunk-extraction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reads = [];
  const mappings = [];
  let activeReads = 0;
  return {
    directory, reads, mappings, contents,
    args: {
      inventory: { parentDrawerId, requiredChunkCount: 3, chunks: ids.map((drawerId, chunkIndex) => ({ drawerId, chunkIndex })) },
      checkpointDirectory: directory, toolPrefix: "test_", extractorVersion: "mock-v1",
      readTool: async (name, args) => {
        assert.equal(name, "test_get_drawer");
        assert.equal(activeReads++, 0, "reads must be sequential");
        await Promise.resolve();
        activeReads--;
        reads.push(args.drawer_id);
        const index = ids.indexOf(args.drawer_id);
        assert.notEqual(index, -1, "only physical chunks may be read");
        return { drawer_id: args.drawer_id, content: contents[index], metadata: { parent_drawer_id: parentDrawerId, chunk_index: index } };
      },
      mapChunk: async (prompt, { chunkId }) => {
        mappings.push(chunkId);
        const source = JSON.parse(prompt.split("\n").at(-1));
        assert.equal(source.primary, contents[ids.indexOf(chunkId)]);
        return response(chunkId);
      },
    },
  };
}

test("actual extraction caller preserves multiple topics, late minority topic and exact chunk provenance", async (t) => {
  const h = harness(t);
  const seen = [];
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (prompt, { chunkId }) => {
    const source = JSON.parse(prompt.split("\n").at(-1));
    seen.push(source);
    const index = ids.indexOf(chunkId);
    return response(chunkId, index === 0 ? [topic("main"), topic("second")]
      : index === 2 ? [topic("main"), topic("minority", source.primary)] : [topic("main")]);
  } });
  assert.equal(result.extractionComplete, true);
  assert.deepEqual(result.topics.map((entry) => entry.topicKey), ["main", "second", "minority"]);
  assert.deepEqual(result.topics[0].contributingChunkIds, ids);
  assert.deepEqual(result.topics[1].contributingChunkIds, [ids[0]]);
  assert.deepEqual(result.topics[2].contributingChunkIds, [ids[2]]);
  assert.equal(result.topics[2].parentDrawerId, parentDrawerId);
  assert.equal(result.topics[2].insights[0].topic.durableFacts[0], "late minority topic");
  assert.equal(seen[0].previous, "");
  assert.equal(seen[0].next, h.contents[1]);
  assert.equal(seen[1].previous, h.contents[0]);
  assert.equal(seen[2].next, "");
  assert.deepEqual(h.reads, [...ids, ...ids, ...ids]);
  assert.equal("sourceComplete" in result, false);
});

test("persistent partial extraction resumes only missing chunks without repeating successful mappings", async (t) => {
  const h = harness(t);
  const first = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => {
    h.mappings.push(chunkId);
    return chunkId === ids[1] ? '{"unfinished":' : response(chunkId);
  } });
  assert.equal(first.extractionComplete, false);
  assert.deepEqual(first.failures.map((entry) => entry.chunkId), [ids[1]]);
  h.mappings.length = 0;
  const resumed = await extractSourceChunks(h.args);
  assert.equal(resumed.extractionComplete, true);
  assert.deepEqual(h.mappings, [ids[1]]);
  h.mappings.length = 0;
  await extractSourceChunks(h.args);
  assert.deepEqual(h.mappings, []);
});

test("changed source hash or extractor version invalidates extraction checkpoints", async (t) => {
  const h = harness(t);
  const original = await extractSourceChunks(h.args);
  h.mappings.length = 0;
  h.contents[2] = "changed final chunk";
  const changed = await extractSourceChunks(h.args);
  assert.notEqual(changed.sourceVersion, original.sourceVersion);
  assert.deepEqual(h.mappings, ids);
  h.mappings.length = 0;
  await extractSourceChunks({ ...h.args, extractorVersion: "mock-v2" });
  assert.deepEqual(h.mappings, ids);
});

for (const mode of ["truncated-outer", "incomplete", "wrong-provenance", "missing-field", "empty-topics", "oversized", "invalid-dead-end"]) {
  test(`extraction caller rejects ${mode} rather than certifying coverage`, async (t) => {
    const h = harness(t);
    const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => {
      const value = JSON.parse(response(chunkId));
      if (mode === "truncated-outer") return '{"response":' + JSON.stringify(value);
      if (mode === "incomplete") value.complete = false;
      if (mode === "wrong-provenance") value.chunkId = "unrequested-chunk";
      if (mode === "missing-field") delete value.topics[0].decisions;
      if (mode === "empty-topics") value.topics = [];
      if (mode === "oversized") value.topics[0].durableFacts = ["x".repeat(20_000)];
      if (mode === "invalid-dead-end") value.topics[0].deadEnds = ["We failed without an outcome."];
      return JSON.stringify(value);
    } });
    assert.equal(result.extractionComplete, false);
    assert.equal(result.assessments.length, 0);
    assert.equal(result.failures.length, 3);
    assert.deepEqual(readdirSync(h.directory), []);
  });
}

test("explicit zero-substance is complete extraction, never replacement coverage", async (t) => {
  const h = harness(t);
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => response(chunkId, []) });
  assert.equal(result.extractionComplete, true);
  assert.deepEqual(result.topics, []);
  assert.equal(result.assessments.length, 3);
  assert.equal("sourceComplete" in result, false);
});

test("inventory gaps fail before any read or mapping", async (t) => {
  const h = harness(t);
  await assert.rejects(extractSourceChunks({ ...h.args, inventory: {
    ...h.args.inventory, chunks: [h.args.inventory.chunks[0], h.args.inventory.chunks[2]],
  } }), /chunk-coverage-gap/);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.mappings, []);
});

test("oversized physical chunks use bounded surrogate-safe pieces without clipping", async (t) => {
  const content = "x".repeat(15_999) + "😀" + "late minority evidence";
  const h = harness(t, [content, "raw", "raw"]);
  const inputs = [];
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (prompt, identity) => {
    const input = JSON.parse(prompt.split("\n").at(-1));
    inputs.push(input);
    assert.ok(input.primary.length <= 16_000);
    const value = JSON.parse(response(identity.chunkId));
    value.topics[0].sourceQuotes = [input.primary.slice(0, 5)];
    return JSON.stringify({ ...value, pieceIndex: identity.pieceIndex, pieceCount: identity.pieceCount });
  } });
  assert.equal(result.extractionComplete, true);
  assert.ok(inputs[0].primary.length < 16_000, "labels and context consume envelope space");
  assert.ok(inputs.every((input) => !/[\uD800-\uDBFF]$/.test(input.primary) && !/^[\uDC00-\uDFFF]/.test(input.primary)));
  assert.equal(inputs.filter((input) => input.chunkId === ids[0]).map((input) => input.primary).join(""), content);
  assert.equal(result.assessments[0].pieceCoverage.required, inputs.filter((input) => input.chunkId === ids[0]).length);
  assert.deepEqual(result.topics[0].contributingChunkIds, ids);
});
test("context-only primary evidence survives extraction and is never marked zero-substance", async (t) => {
  const h = harness(t);
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => {
    if (chunkId !== ids[2]) return response(chunkId);
    return JSON.stringify({ schemaVersion: 1, parentDrawerId, chunkId, complete: true, assessment: "context",
      topics: [], contextualEvidence: [{ kind: "qualifier", origin: "source", text: "The final source narrows earlier scope.", sourceQuote: h.contents[2] }] });
  } });
  assert.equal(result.extractionComplete, true);
  assert.equal(result.assessments[2].assessment, "context");
  assert.equal(result.contextualEvidence[0].chunkId, ids[2]);
  assert.equal(result.contextualEvidence[0].pieceIndex, 0);
});
test("missing context assessment and forged primary quotation fail extraction closed", async (t) => {
  for (const forged of [false, true]) {
    const h = harness(t);
    const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => {
      const value = JSON.parse(response(chunkId));
      if (forged) value.contextualEvidence = [{ kind: "correction", origin: "source", text: "A correction.", sourceQuote: "not present in primary" }];
      else delete value.contextualEvidence;
      return JSON.stringify(value);
    } });
    assert.equal(result.extractionComplete, false);
    assert.equal(result.failures.length, 3);
  }
});

test("reader-window topics are excluded but the chunk stays assessed; unquoted or forged source topics fail closed", async (t) => {
  const h = harness(t);
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => response(chunkId,
    chunkId === ids[1] ? [topic("window", "Primary is a fragment of a list.", [], "reader-window")] : [topic("main")]) });
  assert.equal(result.extractionComplete, true);
  assert.equal(result.assessments.length, 3);
  assert.equal(result.assessments[1].assessment, "zero-substance");
  assert.deepEqual(result.topics.map((entry) => entry.topicKey), ["main"]);
  assert.deepEqual(result.topics[0].contributingChunkIds, [ids[0], ids[2]]);
  for (const bad of [[], ["not in primary"]]) {
    const failed = await extractSourceChunks({ ...harness(t).args, mapChunk: async (_prompt, { chunkId }) => response(chunkId, [topic("main", "claim", bad)]) });
    assert.equal(failed.extractionComplete, false);
    assert.equal(failed.failures.length, 3);
  }
  const missing = await extractSourceChunks({ ...harness(t).args, mapChunk: async (_prompt, { chunkId }) => {
    const value = JSON.parse(response(chunkId)); delete value.topics[0].origin; return JSON.stringify(value); } });
  assert.equal(missing.extractionComplete, false);
});
test("a genuine page qualifier fact survives with exact quote; source+reader mixed pieces keep the minority source topic", async (t) => {
  const note = "(Note: this dump is one page \\u2014 count: 25 of the 150 total drawers.)";
  const h = harness(t, ["raw start", "raw continuation", note]);
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => response(chunkId, chunkId === ids[2]
    ? [topic("window", "Window ends mid id.", [], "reader-window"), topic("pages", "The dump is one page of 150 total drawers.", ["one page"])] : [topic("main")]) });
  assert.equal(result.extractionComplete, true);
  const pages = result.topics.find((entry) => entry.topicKey === "pages");
  assert.deepEqual(pages.insights[0].topic.sourceQuotes, ["one page"]);
  assert.equal(result.topics.some((entry) => entry.topicKey === "window"), false);
});
test("topic quote contract version invalidates older extraction checkpoints", async (t) => {
  const h = harness(t);
  await extractSourceChunks(h.args);
  const checkpoint = join(h.directory, readdirSync(h.directory)[0]);
  const stored = JSON.parse(readFileSync(checkpoint, "utf8"));
  stored.sourceVersion = "physical-chunk-topics-v6-stale";
  writeFileSync(checkpoint, JSON.stringify(stored));
  const before = h.mappings.length;
  await extractSourceChunks(h.args);
  assert.equal(h.mappings.length, before + 3);
});
test("cached pieces from a different (older) prompt identity are not reused for the same source hash", async (t) => {
  const h = harness(t);
  await extractSourceChunks(h.args);
  const file = join(h.directory, readdirSync(h.directory)[0]);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.match(extractionPromptHash(), /^[0-9a-f]{64}$/);
  stored.sourceVersion = "identity-from-previous-prompt-wording"; // same source hashes, older prompt identity
  writeFileSync(file, JSON.stringify(stored));
  const before = h.mappings.length;
  const result = await extractSourceChunks(h.args);
  assert.equal(h.mappings.length, before + 3, "every piece is assessed afresh");
  assert.equal(result.extractionComplete, true);
  const again = h.mappings.length;
  await extractSourceChunks(h.args);
  assert.equal(h.mappings.length, again, "the current identity resumes from its checkpoint");
});
test("source changes during mapping do not return complete extraction", async (t) => {
  const h = harness(t);
  await assert.rejects(extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => {
    h.contents[0] = "changed while mapping";
    return response(chunkId);
  } }), /source-changed-during-extraction/);
});

test("corrupt checkpoint fails closed without a mapper call", async (t) => {
  const h = harness(t);
  await extractSourceChunks(h.args);
  writeFileSync(join(h.directory, readdirSync(h.directory)[0]), '{"incomplete":');
  h.mappings.length = 0;
  await assert.rejects(extractSourceChunks(h.args));
  assert.deepEqual(h.mappings, []);
});

test("empty mapper worklist performs no reads or process calls", async () => {
  const result = await callSubagentMapper({ worklistIds: [], readTool: async () => { throw new Error("unexpected read"); } });
  assert.deepEqual(result, { summaries: [], unmappedTranscriptIds: [], raw: null, via: "none" });
});

async function quoteRun(t, content, quote) {
  const h = harness(t, ["raw start", "raw continuation", content]);
  const result = await extractSourceChunks({ ...h.args, mapChunk: async (_prompt, { chunkId }) => {
    if (chunkId !== ids[2]) return response(chunkId);
    return JSON.stringify({ schemaVersion: 1, parentDrawerId, chunkId, complete: true, assessment: "context",
      topics: [], contextualEvidence: [{ kind: "qualifier", origin: "source", text: "Qualifier.", sourceQuote: quote }] });
  } });
  return result;
}
test("model quote with real newline/quote/backslash grounds to literal JSON-escaped source and is canonicalised", async (t) => {
  const source = String.raw`total: 150\n**ids:**\n\"x\" path C:\\dir\\f.ts`;
  const quote = 'total: 150\n**ids:**\n"x" path C:\\dir\\f.ts';
  const result = await quoteRun(t, source, quote);
  assert.equal(result.extractionComplete, true);
  assert.equal(result.contextualEvidence[0].sourceQuote, source);
});
test("exact literal quote is unchanged; fabricated, altered, unsupported-escape and adjacent quotes are rejected", async (t) => {
  const source = String.raw`code a\nb "k"`;
  assert.equal((await quoteRun(t, source, String.raw`code a\nb`)).contextualEvidence[0].sourceQuote, String.raw`code a\nb`);
  for (const bad of ["code a b", "code a\n  b", "fabricated", "code a\nB", "code a\t", "raw start", "\u0041"]) {
    assert.equal((await quoteRun(t, source, bad)).extractionComplete, false, bad);
  }
});
test("source backslashes in paths are never unescaped for matching", async (t) => {
  const source = String.raw`open C:\dir\file.ts`;
  assert.equal((await quoteRun(t, source, String.raw`open C:\dir\file.ts`)).contextualEvidence[0].sourceQuote, source);
  // Doubled-backslash quote against a single-backslash source must not be "unescaped" into a match.
  assert.equal((await quoteRun(t, source, String.raw`open C:\\dir\\file.ts`)).extractionComplete, false);
});
