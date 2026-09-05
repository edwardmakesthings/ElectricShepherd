import assert from "node:assert/strict";
import test from "node:test";

import {
  retrieveSimilarWorkedExamples,
  formatWorkedExampleDemonstration,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_MAX_CHARS,
} from "../../src/capability/retrieval/retrieval-expansion.ts";

/**
 * Unit coverage for Phase 13 (unified memory): worked-example injection — the
 * CONSUME side. `retrieveSimilarWorkedExamples` is driven with a stub palace
 * client whose search returns fixed apprenticeship rows, so relevance scores are
 * fully deterministic (token-overlap, no embeddings). Proves:
 *   1. examples above the floor are returned, ranked by relevance;
 *   2. the hard cap of WORKED_EXAMPLE_MAX_INJECT (=2) is enforced even when more
 *      candidates qualify;
 *   3. when nothing scores above the floor (or no rows exist), an empty array is
 *      returned — the caller injects nothing;
 *   4. formatWorkedExampleDemonstration produces a clearly delimited section for
 *      non-empty input and "" for empty input (no prompt growth without examples);
 *   5. content is clipped to WORKED_EXAMPLE_MAX_CHARS, keeping prompt growth bounded;
 *   6. clients without `search` degrade to "no examples" with zero extra calls.
 */

// A delegation prompt: 8 informative tokens after stopword removal.
const QUERY =
  "fix the retry loop in the gateway adapter where the websocket reconnect handler keeps spawning duplicate connections";

// Query informative tokens (after stopword removal, len>=3): fix, retry, loop, gateway,
// adapter, websocket, reconnect, handler, keeps, spawning, duplicate, connections = 12.
// Example A shares 10 of them -> relevance 10/12 ≈ 0.833 (above floor).
const EXAMPLE_A_TEXT =
  "Solved the retry loop in the gateway adapter: the websocket reconnect handler was spawning duplicate connections because the backoff timer was never cleared.";

// Example B shares 8 of the 12 -> relevance 8/12 ≈ 0.667 (above floor).
const EXAMPLE_B_TEXT =
  "Gateway adapter websocket fix: clear the reconnect timer before spawning a new connection to avoid duplicates in the retry loop.";

// Example C: shares only 2 of the query's 8 informative tokens -> relevance 0.25... exactly at the
// floor is admitted (>=). Use 1 shared token -> 0.125, below floor -> excluded.
const EXAMPLE_C_TEXT =
  "Unrelated database migration note about schema versioning and index rebuilds.";

function makeSearchClient({ rows, drawers = {}, sourceTypes = {} } = {}) {
  const calls = { search: 0, getDrawer: 0, getSourceType: 0 };
  const client = {
    __calls: calls,
    search: async (_query, _limit, _wing, room) => {
      calls.search += 1;
      assert.equal(room, "apprenticeship", "search must target the apprenticeship room");
      return { results: rows };
    },
    getDrawer: async ({ drawer_id }) => {
      calls.getDrawer += 1;
      return drawers[drawer_id] ?? {};
    },
    getClosetSourceType: async (id) => {
      calls.getSourceType += 1;
      return sourceTypes[id] ?? null;
    },
  };
  return client;
}

const ROWS = [
  { drawer_id: "ex-a", content: EXAMPLE_A_TEXT },
  { drawer_id: "ex-b", content: EXAMPLE_B_TEXT },
  { drawer_id: "ex-c", content: EXAMPLE_C_TEXT },
];

test("returns examples above the floor, ranked by relevance descending", async () => {
  const client = makeSearchClient({ rows: ROWS });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });

  assert.deepEqual(
    result.map((r) => r.drawer_id),
    ["ex-a", "ex-b"],
    `expected ex-a then ex-b, got ${JSON.stringify(result.map((r) => r.drawer_id))}`,
  );
  // ex-a: 10/12 ≈ 0.833 ; ex-b: 8/12 ≈ 0.667 — both above the 0.25 floor.
  assert.ok(Math.abs(result[0].relevance - 10 / 12) < 1e-9, `ex-a relevance off: ${result[0].relevance}`);
  assert.ok(Math.abs(result[1].relevance - 8 / 12) < 1e-9, `ex-b relevance off: ${result[1].relevance}`);
  // ex-c (1/12 ≈ 0.083) is below the floor and must be absent.
  assert.ok(!result.some((r) => r.drawer_id === "ex-c"), "below-floor example must not be returned");
});

test("enforces the hard cap of WORKED_EXAMPLE_MAX_INJECT (=2)", async () => {
  const manyRows = Array.from({ length: 5 }, (_, i) => ({
    drawer_id: `ex-${String.fromCharCode(97 + i)}`,
    content: EXAMPLE_A_TEXT, // all share the same high relevance
  }));
  const client = makeSearchClient({ rows: manyRows });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });

  assert.equal(WORKED_EXAMPLE_MAX_INJECT, 2, "cap constant must stay 2");
  assert.equal(result.length, 2, `cap violated: ${result.length} examples returned`);
});

test("returns an empty array when nothing scores above the floor", async () => {
  const client = makeSearchClient({ rows: [{ drawer_id: "ex-weak", content: EXAMPLE_C_TEXT }] });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });
  assert.deepEqual(result, [], "below-floor examples must yield an empty array");
});

test("returns an empty array when the apprenticeship room has no rows", async () => {
  const client = makeSearchClient({ rows: [] });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });
  assert.deepEqual(result, [], "no rows -> no examples");
});

test("returns an empty array for an empty/whitespace-only query", async () => {
  const client = makeSearchClient({ rows: ROWS });
  assert.deepEqual(await retrieveSimilarWorkedExamples(client, { query: "" }), []);
  assert.deepEqual(await retrieveSimilarWorkedExamples(client, { query: "   " }), []);
  assert.equal(client.__calls.search, 0, "no search call for empty query");
});

test("clients without search degrade to no examples with zero calls", async () => {
  const result = await retrieveSimilarWorkedExamples({}, { query: QUERY });
  assert.deepEqual(result, [], "client without search -> no examples");
});

test("search failures degrade to no examples (never throw)", async () => {
  const client = { search: async () => { throw new Error("palace down"); } };
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });
  assert.deepEqual(result, [], "search failure -> empty array, no throw");
});

test("fetches full drawer content via getDrawer and clips to WORKED_EXAMPLE_MAX_CHARS", async () => {
  const longContent = `Solved the retry loop in the gateway adapter. ${"x".repeat(5000)}`;
  const client = makeSearchClient({
    rows: [{ drawer_id: "ex-a", content: EXAMPLE_A_TEXT }],
    drawers: { "ex-a": { content: longContent, wing: "proj", room: "apprenticeship" } },
  });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });

  assert.equal(result.length, 1);
  assert.equal(result[0].content.length, WORKED_EXAMPLE_MAX_CHARS, "content must be clipped to the cap");
  assert.equal(result[0].wing, "proj", "wing comes from the drawer");
  assert.equal(result[0].room, "apprenticeship", "room comes from the drawer");
});

test("admits worked-example and skill stamped drawers, rejects other source types", async () => {
  const client = makeSearchClient({
    rows: [
      { drawer_id: "ex-a-we", content: EXAMPLE_A_TEXT },
      { drawer_id: "ex-b-skill", content: EXAMPLE_A_TEXT },
      { drawer_id: "ex-c-doc", content: EXAMPLE_A_TEXT },
    ],
    sourceTypes: { "ex-a-we": "worked-example", "ex-b-skill": "skill", "ex-c-doc": "doc" },
  });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });

  assert.deepEqual(
    result.map((r) => r.drawer_id),
    ["ex-a-we", "ex-b-skill"],
    "worked-example (new filings) and skill (backward compat) qualify; doc does not",
  );
});

test("unstamped drawers (null source type) are admitted — absence of a stamp is not a rejection", async () => {
  const client = makeSearchClient({ rows: [{ drawer_id: "ex-plain", content: EXAMPLE_A_TEXT }] });
  const result = await retrieveSimilarWorkedExamples(client, { query: QUERY });
  assert.equal(result.length, 1);
});

test("formatWorkedExampleDemonstration returns '' for empty input (no prompt growth)", () => {
  assert.equal(formatWorkedExampleDemonstration([]), "");
});

test("formatWorkedExampleDemonstration produces a delimited section per example", () => {
  const text = formatWorkedExampleDemonstration([
    { drawer_id: "ex-a", wing: "w", room: "apprenticeship", content: "Solved the retry loop.", relevance: 0.75 },
    { drawer_id: "ex-b", wing: "w", room: "apprenticeship", content: "Gateway adapter websocket fix.", relevance: 0.38 },
  ]);

  assert.ok(text.startsWith("\n\n---\n"), "section must open with a delimiter");
  assert.ok(text.endsWith("---\n"), "section must close with a delimiter");
  assert.ok(text.includes("## Demonstrations:"), "must carry the demonstration heading");
  assert.ok(text.includes("### Example 1 (relevance: 0.75)"), "example 1 header with relevance"); // literal fixture value, not a computed score
  assert.ok(text.includes("### Example 2 (relevance: 0.38)"), "example 2 header with relevance");
  assert.ok(text.includes("Solved the retry loop."), "example content present");
  // Bounded growth: two examples, each <= WORKED_EXAMPLE_MAX_CHARS, plus fixed framing.
  const maxExpected = 2 * WORKED_EXAMPLE_MAX_CHARS + 400;
  assert.ok(text.length <= maxExpected, `section too large: ${text.length} chars`);
});

test("deterministic: identical inputs produce identical output (no randomness)", async () => {
  const make = () => makeSearchClient({ rows: ROWS });
  const a = await retrieveSimilarWorkedExamples(make(), { query: QUERY });
  const b = await retrieveSimilarWorkedExamples(make(), { query: QUERY });
  assert.deepEqual(a, b, "retrieval must be deterministic for identical inputs");
});
