import assert from "node:assert/strict";
import test from "node:test";

import {
  clipPreview,
  isTranscriptLikeRoom,
  parseFacts,
  parseRows,
  parseTaxonomy,
  previewEnds,
  resolveDiffWindows,
  resolvePalaceEndpoint,
  scratchFileNameFor,
  sliceVerbatimBetween,
  summarizeDrawerRows,
  verifyVerbatimExcerpt,
} from "../../adapter/palace-tools.ts";

test("resolvePalaceEndpoint withholds credentials from loopback endpoints", () => {
  const secretEnv = { MEMPALACE_MCP_API_KEY: "sk-test", MEMPALACE_MCP_URL: "http://localhost:8093/mcp" };
  assert.deepEqual(resolvePalaceEndpoint(secretEnv).headers, {});

  const remote = resolvePalaceEndpoint({ ...secretEnv, MEMPALACE_MCP_URL: "https://gateway.example/mcp" });
  assert.equal(remote.url, "https://gateway.example/mcp");
  assert.equal(remote.headers.Authorization, "Bearer sk-test");
});

test("parseRows and parseFacts read MemPalace's differing envelope keys", () => {
  assert.equal(parseRows({ drawers: [{ drawer_id: "a" }, {}] }).length, 1);
  assert.equal(parseRows({ results: [{ drawer_id: "b" }] })[0].drawer_id, "b");
  assert.deepEqual(parseRows(null), []);

  assert.equal(parseFacts({ facts: [{ predicate: "consolidated-into" }] }).length, 1);
  assert.deepEqual(parseFacts({ facts: [] }), []);
});

test("parseTaxonomy sorts wings and rooms by drawer count", () => {
  const parsed = parseTaxonomy({
    taxonomy: {
      sampleproject: { transcripts: 728, docs: 160 },
      local_infra: { "mem-raw": 60 },
    },
  });

  assert.equal(parsed[0].wing, "sampleproject");
  assert.equal(parsed[0].drawers, 888);
  assert.equal(parsed[0].rooms[0].room, "transcripts");
  assert.equal(parsed[1].wing, "local_infra");
});

test("previewEnds keeps both ends and flags truncation only when needed", () => {
  const short = previewEnds("abcdef", 10, 10);
  assert.equal(short.truncated, false);
  assert.equal(short.head, "abcdef");

  const long = previewEnds("0123456789ABCDEFGHIJ", 4, 4);
  assert.equal(long.truncated, true);
  assert.equal(long.head, "0123");
  assert.equal(long.tail, "GHIJ");
});

test("clipPreview collapses whitespace and marks elision", () => {
  assert.equal(clipPreview("  a\n\n  b  ", 50), "a b");
  assert.equal(clipPreview("abcdefghij", 5), "abcd...");
});

test("scratchFileNameFor strips path-unsafe characters", () => {
  const name = scratchFileNameFor("drawer/../../etc passwd", "2026-08-20T12:00:00Z");
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes(" "));
  assert.ok(name.endsWith(".txt"));
});

test("verifyVerbatimExcerpt accepts exact passages and rejects paraphrase", () => {
  const source = "line one\nthe aside about  electric shepherd memory\nline three";

  assert.deepEqual(verifyVerbatimExcerpt(source, "the aside about electric shepherd memory"), { ok: true });
  assert.equal(verifyVerbatimExcerpt(source, "an aside regarding electric shepherd").ok, false);
  assert.equal(verifyVerbatimExcerpt(source, "   ").reason, "empty-excerpt");
  assert.equal(verifyVerbatimExcerpt("", "anything").reason, "source-content-unavailable");
});

test("isTranscriptLikeRoom recognizes raw capture rooms only", () => {
  assert.equal(isTranscriptLikeRoom("source-transcripts"), true);
  assert.equal(isTranscriptLikeRoom("mem-raw"), true);
  assert.equal(isTranscriptLikeRoom("decisions"), false);
});

test("summarizeDrawerRows reports range, sources, and previews", () => {
  const summary = summarizeDrawerRows(
    [
      {
        drawer_id: "d1",
        room: "source-transcripts",
        content_preview: "first  drawer",
        metadata: { filed_at: "2026-08-19T10:00:00Z", source_file: "session-a" },
      },
      {
        drawer_id: "d2",
        room: "source-transcripts",
        content_preview: "second drawer",
        metadata: { filed_at: "2026-08-20T10:00:00Z", source_file: "session-b" },
      },
    ],
    100,
  );

  assert.equal(summary.count, 2);
  assert.equal(summary.filedAtEarliest, "2026-08-19T10:00:00Z");
  assert.equal(summary.filedAtLatest, "2026-08-20T10:00:00Z");
  assert.deepEqual(summary.sources, ["session-a", "session-b"]);
  assert.equal(summary.samples[0].preview, "first drawer");
});

test("sliceVerbatimBetween lifts the passage between anchors without carrying it", () => {
  const drawer = [
    "user: lets finish the sample project importer",
    "assistant: side note on electric shepherd",
    "assistant: the dreamer should propose moves itself",
    "assistant: end of aside",
    "user: back to the importer",
  ].join("\n");

  const sliced = sliceVerbatimBetween(
    drawer,
    "assistant: side note on electric   shepherd",
    "assistant: end of aside",
  );

  assert.equal(sliced.ok, true);
  assert.ok(sliced.text.startsWith("assistant: side note"));
  assert.ok(sliced.text.endsWith("end of aside"));
  assert.ok(!sliced.text.includes("back to the importer"));
  // The slice must come out of the stored bytes, so it re-verifies as verbatim.
  assert.equal(verifyVerbatimExcerpt(drawer, sliced.text).ok, true);
});

test("sliceVerbatimBetween reports which anchor failed", () => {
  const drawer = "alpha\nbravo\ncharlie";
  assert.equal(sliceVerbatimBetween(drawer, "nope", "charlie").reason, "start-anchor-not-found");
  assert.equal(sliceVerbatimBetween(drawer, "alpha", "nope").reason, "end-anchor-not-found");
  assert.equal(sliceVerbatimBetween(drawer, "alpha", "").reason, "missing-anchor");
  assert.equal(sliceVerbatimBetween("", "alpha", "charlie").reason, "source-content-unavailable");
});

test("sliceVerbatimBetween handles a single-line passage where both anchors match once", () => {
  const drawer = "one\nthe whole aside is one line\ntwo";
  const sliced = sliceVerbatimBetween(drawer, "the whole aside is one line", "the whole aside is one line");
  assert.equal(sliced.ok, true);
  assert.equal(sliced.text, "the whole aside is one line");
});

test("resolveDiffWindows builds adjacent windows of equal length", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const windows = resolveDiffWindows({ now, since: "7d" });

  assert.equal(windows.current.before, "2026-08-20T12:00:00.000Z");
  assert.equal(windows.current.since, "2026-08-13T12:00:00.000Z");
  assert.equal(windows.previous.before, windows.current.since);
  assert.equal(windows.previous.since, "2026-08-06T12:00:00.000Z");
  assert.equal(windows.durationMs, 7 * 86400000);
});

test("resolveDiffWindows accepts absolute dates and rejects impossible ranges", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");

  const absolute = resolveDiffWindows({ now, since: "2026-08-18T00:00:00.000Z" });
  assert.equal(absolute.durationMs, 2 * 86400000);

  assert.throws(() => resolveDiffWindows({ now, since: "2026-08-25T00:00:00.000Z" }), /since must be earlier/);
  assert.throws(() => resolveDiffWindows({ now, since: "not-a-date" }), /invalid since/);
});
