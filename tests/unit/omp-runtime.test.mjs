import assert from "node:assert/strict";
import test from "node:test";

import { toNumber, toList, isTrue } from "../../src/surface/omp/runtime.ts";

// `Number("")` is 0 and finite, so an unset key must not read as zero — that would
// silently disable a timeout or budget instead of applying its documented default.
test("toNumber falls back for unset and unparseable values", () => {
  assert.equal(toNumber(undefined, 600000), 600000);
  assert.equal(toNumber("", 600000), 600000);
  assert.equal(toNumber("   ", 600000), 600000);
  assert.equal(toNumber("nope", 600000), 600000);
  assert.equal(toNumber("0", 600000), 0);
  assert.equal(toNumber("4000", 600000), 4000);
});

test("toList splits csv and drops blanks", () => {
  assert.deepEqual(toList(".electric-shepherd/memory"), [".electric-shepherd/memory"]);
  assert.deepEqual(toList("a, b ,,c"), ["a", "b", "c"]);
  assert.deepEqual(toList(undefined), []);
});

test("isTrue only accepts the literal true", () => {
  assert.equal(isTrue("true"), true);
  assert.equal(isTrue("TRUE"), true);
  assert.equal(isTrue("1"), false);
  assert.equal(isTrue(undefined), false);
});
