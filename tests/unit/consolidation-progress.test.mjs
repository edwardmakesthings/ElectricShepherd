import assert from "node:assert/strict";
import test from "node:test";

import { parseRunEvents } from "../../src/tools/consolidation_progress.ts";
import { parseModelSelector } from "../../src/scripts/memory-pipeline/runtime-utils.ts";
import { resolveSubagentRunner } from "../../src/scripts/memory-pipeline/subagent.ts";

const NOW = Date.parse("2026-09-11T19:25:00.000Z");

function event(patch) {
  return JSON.stringify({
    ts: "2026-09-11T19:24:57.717Z",
    runId: "run-a",
    event: "progress",
    status: "running",
    phase: "chunk-processing",
    counters: { examinedCount: 24, processedCount: 0, chunkIndex: 6, chunkTotal: 24 },
    ...patch,
  });
}

test("parseRunEvents reports the latest state per run", () => {
  const [progress] = parseRunEvents([event({}), event({ phase: "chunk-consolidated", counters: { chunkIndex: 7, chunkTotal: 24 } })].join("\n"), NOW);
  assert.equal(progress.run_id, "run-a");
  assert.equal(progress.phase, "chunk-consolidated");
  assert.equal(progress.counters.chunkIndex, 7);
});

// The log is read from a byte offset, so the first line is usually a fragment.
test("parseRunEvents ignores a truncated leading line", () => {
  const runs = parseRunEvents(`unterProcessed":3}}\n${event({})}`, NOW);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].counters.chunkIndex, 6);
});

test("parseRunEvents derives staleness from the last update", () => {
  const [progress] = parseRunEvents(event({ ts: "2026-09-11T19:24:00.000Z" }), NOW);
  assert.equal(progress.stale_seconds, 60);
});

test("parseRunEvents separates concurrent runs, newest first", () => {
  const runs = parseRunEvents(
    [event({ runId: "old", ts: "2026-09-11T18:00:00.000Z" }), event({ runId: "new", ts: "2026-09-11T19:24:59.000Z" })].join("\n"),
    NOW,
  );
  assert.deepEqual(runs.map((r) => r.run_id), ["new", "old"]);
});

test("parseModelSelector splits a provider/model pair", () => {
  assert.deepEqual(parseModelSelector("litellm/implementer-gemma4-31b"), {
    providerID: "litellm",
    modelID: "implementer-gemma4-31b",
  });
});

test("parseModelSelector rejects a value missing either half", () => {
  for (const bad of ["implementer-gemma4-31b", "/model", "litellm/", ""]) {
    assert.equal(parseModelSelector(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// A run started under omp must not spawn opencode: that loads the other
// harness's plugin surface and writes .opencode state from an omp session.
test("resolveSubagentRunner honours the preferred harness", () => {
  const env = { PATH: "" };
  const home = "/home/u";
  const existing = resolveSubagentRunner({ env, home, preferKind: "omp" });
  assert.equal(existing, undefined, "no binaries exist in this fake env");

  const explicit = resolveSubagentRunner({ explicitBin: "/home/u/.local/bin/omp", env });
  assert.deepEqual(explicit, { kind: "omp", bin: "/home/u/.local/bin/omp" });
});

test("resolveSubagentRunner treats an explicit bin as authoritative", () => {
  const explicit = resolveSubagentRunner({ env: { ESHEPHERD_SUBAGENT_BIN: "/opt/omp" } });
  assert.equal(explicit.kind, "omp");
  assert.equal(explicit.bin, "/opt/omp");
});
