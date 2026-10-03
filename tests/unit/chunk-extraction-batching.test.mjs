import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractSourceChunks } from "../../src/scripts/memory-pipeline/chunk-extraction.ts";

function harness(t, contents) {
  const parentDrawerId = "drawer_batch_source_parent";
  const ids = contents.map((_, i) => `${parentDrawerId}_chunk_${String(i).padStart(6, "0")}`);
  const directory = mkdtempSync(join(tmpdir(), "es-batch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const response = (input) => ({ schemaVersion: 1, parentDrawerId, complete: true, pieces: input.pieces.map((piece) => ({
    schemaVersion: 1, parentDrawerId, chunkId: piece.chunkId, pieceIndex: piece.pieceIndex, pieceCount: piece.pieceCount,
    complete: true, assessment: "topics", contextualEvidence: [], topics: [{
      topicKey: "work", title: "Work", confidence: "high", origin: "source", sourceQuotes: [piece.primary.slice(0, 20)],
      durableFacts: ["Source work."], decisions: [], rootCausesAndWorkedExamples: [], subsystemsAndFiles: [], openItems: [], deadEnds: [],
    }],
  })) });
  const run = (change = (value) => value) => extractSourceChunks({
    inventory: { parentDrawerId, requiredChunkCount: ids.length, chunks: ids.map((drawerId, chunkIndex) => ({ drawerId, chunkIndex })) },
    toolPrefix: "test_", checkpointDirectory: directory, extractorVersion: "batch-tests",
    readTool: async (_name, { drawer_id }) => ({ drawer_id, content: contents[ids.indexOf(drawer_id)],
      metadata: { parent_drawer_id: parentDrawerId, chunk_index: ids.indexOf(drawer_id) } }),
    mapChunk: async (prompt) => {
      assert.ok(prompt.length <= 16_000, "entire escaped input envelope is bounded");
      const input = JSON.parse(prompt.split("\n").at(-1));
      assert.ok(input.pieces.length <= 4);
      calls.push(input);
      const value = change(response(input), input);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  });
  return { run, ids, calls, directory };
}

test("20 neighboring 800-character physical chunks require five genuine model calls, not twenty", async (t) => {
  const h = harness(t, Array.from({ length: 20 }, (_, i) => `Evidence ${i}: `.padEnd(800, "x")));
  const result = await h.run();
  assert.equal(result.extractionComplete, true);
  assert.equal(h.calls.length, 5);
  assert.deepEqual(h.calls.map((input) => input.pieces.length), [4, 4, 4, 4, 4]);
  assert.deepEqual(result.assessments.map((assessment) => assessment.chunkId), h.ids);
  assert.deepEqual(result.topics[0].contributingChunkIds, h.ids);
});

for (const mode of ["missing", "duplicate", "extra", "unrequested", "wrong-parent", "wrong-count", "incomplete-envelope", "truncated", "oversized"]) {
  test(`batch ${mode} fails the entire identity envelope before any checkpoint admission`, async (t) => {
    const h = harness(t, ["First distinct primary", "Second distinct primary", "Third distinct primary"]);
    const result = await h.run((value) => {
      if (mode === "missing") value.pieces.pop();
      if (mode === "duplicate") value.pieces[1] = value.pieces[0];
      if (mode === "extra") value.pieces.push({ ...value.pieces[0], chunkId: "extra" });
      if (mode === "unrequested") value.pieces[1].chunkId = "unrequested";
      if (mode === "wrong-parent") value.pieces[1].parentDrawerId = "wrong";
      if (mode === "wrong-count") value.pieces[1].pieceCount++;
      if (mode === "incomplete-envelope") value.complete = false;
      if (mode === "truncated") return '{"schemaVersion":1,"pieces":' + JSON.stringify(value.pieces);
      if (mode === "oversized") value.pieces[0].topics[0].durableFacts = ["x".repeat(17_000)];
      return value;
    });
    assert.equal(result.extractionComplete, false);
    assert.equal(result.failures.length, 3);
    assert.deepEqual(result.assessments, []);
    assert.deepEqual(readdirSync(h.directory), []);
  });
}

test("neighbor primary quotes cannot certify a piece; valid members checkpoint and only the missing member retries", async (t) => {
  const h = harness(t, ["Alpha-only evidence", "Beta-only evidence", "Late correction evidence"]);
  const first = await h.run((value) => {
    value.pieces[1].topics[0].sourceQuotes = ["Alpha-only evidence"];
    return value;
  });
  assert.equal(first.extractionComplete, false);
  assert.deepEqual(first.failures.map((failure) => failure.chunkId), [h.ids[1]]);
  const checkpoint = JSON.parse(readFileSync(join(h.directory, readdirSync(h.directory)[0]), "utf8"));
  assert.deepEqual(Object.keys(checkpoint.responses), [h.ids[0], h.ids[2]]);
  h.calls.length = 0;
  assert.equal((await h.run()).extractionComplete, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].pieces.map((piece) => piece.chunkId), [h.ids[1]]);
  h.calls.length = 0;
  await h.run();
  assert.deepEqual(h.calls, []);
});

test("a malformed member stays pending while validated members survive partial retry", async (t) => {
  const h = harness(t, ["Alpha evidence", "Beta evidence", "Gamma evidence"]);
  const result = await h.run((value) => {
    delete value.pieces[1].topics[0].decisions;
    return value;
  });
  assert.equal(result.extractionComplete, false);
  assert.deepEqual(result.failures.map((failure) => failure.chunkId), [h.ids[1]]);
  h.calls.length = 0;
  assert.equal((await h.run()).extractionComplete, true);
  assert.deepEqual(h.calls[0].pieces.map((piece) => piece.chunkId), [h.ids[1]]);
});

test("large escaped chunks split without loss or surrogate damage and retain late primary correction", async (t) => {
  const content = ('quoted " path \\ newline\n😀 '.repeat(1500)) + "FINAL: migration canceled.";
  const h = harness(t, [content, "Adjacent-only statement"]);
  const result = await h.run((value, input) => {
    for (const [i, piece] of input.pieces.entries()) {
      if (piece.primary.includes("FINAL: migration canceled.")) {
        value.pieces[i].contextualEvidence.push({ kind: "resolution", origin: "source", text: "Migration canceled.", sourceQuote: "FINAL: migration canceled." });
      }
      assert.ok(!/[\uD800-\uDBFF]$/.test(piece.primary) && !/^[\uDC00-\uDFFF]/.test(piece.primary));
    }
    return value;
  });
  assert.equal(result.extractionComplete, true);
  const pieces = h.calls.flatMap((call) => call.pieces).filter((piece) => piece.chunkId === h.ids[0]);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.map((piece) => piece.primary).join(""), content);
  assert.deepEqual(pieces.map((piece) => piece.pieceIndex), pieces.map((_, i) => i));
  assert.equal(result.assessments[0].pieceCoverage.required, pieces.length);
  assert.equal(result.contextualEvidence[0].chunkId, h.ids[0]);
  assert.equal(result.contextualEvidence[0].pieceIndex, pieces.length - 1);
  assert.equal(result.contextualEvidence[0].sourceQuote, "FINAL: migration canceled.");
});

test("contextual quotations are primary-isolated too, even when the neighbor supplies a real correction", async (t) => {
  const h = harness(t, ["Migration pending.", "Migration canceled."]);
  const result = await h.run((value) => {
    value.pieces[0].contextualEvidence = [{ kind: "resolution", origin: "source", text: "Canceled.", sourceQuote: "Migration canceled." }];
    return value;
  });
  assert.equal(result.extractionComplete, false);
  assert.deepEqual(result.failures.map((failure) => failure.chunkId), [h.ids[0]]);
  assert.deepEqual(result.contextualEvidence, []);
});
