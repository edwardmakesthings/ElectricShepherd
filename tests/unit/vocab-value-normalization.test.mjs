import assert from "node:assert/strict";
import test from "node:test";

import { uniqueFromFactsByDirection, vocabValuesFromFacts, parseKgFacts } from "../../src/core/memgraph-transport.ts";

/**
 * Regression guard for the read-path canonicalization outage.
 *
 * MemPalace canonicalizes entity display names when a fact is READ: a value
 * written as `synthesis` comes back from kg_query as `Synthesis`. Verified
 * empirically against a live substrate — the kg_add receipt echoed the
 * lowercase form while kg_query returned the capitalized one.
 *
 * Every closed-vocabulary comparison in the read path uses strict equality
 * against lowercase literals, so an un-normalized value makes the comparison
 * silently return false: the node reads as UNSTAMPED rather than erroring.
 */

const factsPayload = (objects) => ({ facts: objects.map((object) => ({ direction: "outgoing", subject: "closet-1", predicate: "es-source-type", object, current: true })) });

test("vocabValuesFromFacts lowercases substrate-canonicalized values", () => {
  assert.deepEqual(vocabValuesFromFacts(factsPayload(["Synthesis"]), "outgoing"), ["synthesis"]);
});

test("vocabValuesFromFacts leaves already-lowercase values unchanged", () => {
  assert.deepEqual(vocabValuesFromFacts(factsPayload(["provisional"]), "outgoing"), ["provisional"]);
});

test("the capitalized value fails a raw vocabulary check but passes the normalized one", () => {
  const vocabulary = ["transcript", "doc", "synthesis", "skill"];
  const raw = uniqueFromFactsByDirection(parseKgFacts(factsPayload(["Synthesis"])), "outgoing");

  // This is precisely the bug: the raw read misses the vocabulary entirely.
  assert.equal(vocabulary.includes(raw[0]), false, "raw substrate value must not match the lowercase vocabulary");
  assert.equal(vocabulary.includes(vocabValuesFromFacts(factsPayload(["Synthesis"]), "outgoing")[0]), true);
});

test("expired facts stay excluded after normalization", () => {
  const payload = { facts: [{ direction: "outgoing", object: "Synthesis", current: false }] };
  assert.deepEqual(vocabValuesFromFacts(payload, "outgoing"), []);
});
