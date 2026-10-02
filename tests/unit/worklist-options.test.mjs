import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../../src/core/runtime-config.ts";
import { parseWorklistOptions } from "../../src/scripts/memory-pipeline/cli-options.ts";

function runtimeConfig() {
  return loadRuntimeConfig({ cwd: process.cwd(), env: {} });
}

test("parseWorklistOptions selects all-raw mode", () => {
  const options = parseWorklistOptions(["--all-raw"], runtimeConfig());
  assert.equal(options.mode, "all-raw");
});

test("parseWorklistOptions rejects all-raw combined with all/full-scope/reprocess-all", () => {
  const cfg = runtimeConfig();
  assert.throws(
    () => parseWorklistOptions(["--all-raw", "--all"], cfg),
    /--all-raw cannot be combined with --all\/--full-scope\/--reprocess-all/,
  );
  assert.throws(
    () => parseWorklistOptions(["--all-raw", "--full-scope"], cfg),
    /--all-raw cannot be combined with --all\/--full-scope\/--reprocess-all/,
  );
  assert.throws(
    () => parseWorklistOptions(["--all-raw", "--reprocess-all"], cfg),
    /--all-raw cannot be combined with --all\/--full-scope\/--reprocess-all/,
  );
});

test("parseWorklistOptions rejects all-raw combined with reconsolidate", () => {
  const cfg = runtimeConfig();
  assert.throws(
    () => parseWorklistOptions(["--all-raw", "--reconsolidate", "closet_a"], cfg),
    /--all-raw cannot be combined with --reconsolidate/,
  );
});
