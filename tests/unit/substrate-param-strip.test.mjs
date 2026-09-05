import assert from "node:assert/strict";
import test from "node:test";

import { stripUndeclaredSubstrateParams } from "../../src/core/memgraph.ts";

/**
 * Regression guard for the -32602 outage: MemPalace strict-validates its MCP
 * input schemas, so sending a parameter it does not declare fails the whole
 * call rather than being ignored. `source_run_id` is ours, not the substrate's.
 */

function recordingCaller() {
  const calls = [];
  const caller = async (name, args) => {
    calls.push({ name, args });
    return {};
  };
  return { calls, caller };
}

test("strips source_run_id from kg_add before it reaches the substrate", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);

  await wrapped("mempalace_kg_add", {
    subject: "closet-1",
    predicate: "synthesized-from",
    object: "drawer-1",
    source_closet: "closet-1",
    source_run_id: "run-abc",
  });

  assert.equal(calls.length, 1);
  assert.ok(!("source_run_id" in calls[0].args), "source_run_id must not be forwarded");
  // Every declared parameter survives untouched.
  assert.deepEqual(calls[0].args, {
    subject: "closet-1",
    predicate: "synthesized-from",
    object: "drawer-1",
    source_closet: "closet-1",
  });
});

test("strips regardless of the configured tool prefix", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);

  await wrapped("mygateway_dream_mempalace-mempalace_kg_add", {
    subject: "a",
    predicate: "es-status",
    object: "provisional",
    source_run_id: "run-abc",
  });

  assert.ok(!("source_run_id" in calls[0].args));
});

test("does not mutate the caller's argument object", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);
  const original = {
    subject: "a",
    predicate: "synthesized-from",
    object: "b",
    source_run_id: "run-abc",
  };

  await wrapped("mempalace_kg_add", original);

  // Call sites may keep the run id for local logging after the call returns.
  assert.equal(original.source_run_id, "run-abc");
  assert.ok(!("source_run_id" in calls[0].args));
});

test("leaves other tools' arguments untouched", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);
  const args = { wing: "w", room: "r", content: "c", source_run_id: "run-abc" };

  await wrapped("mempalace_add_drawer", args);

  // Only kg_add is known to reject it; nothing else is silently rewritten.
  assert.deepEqual(calls[0].args, args);
});

test("passes through undefined args without constructing an object", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);

  await wrapped("mempalace_kg_add", undefined);

  assert.equal(calls[0].args, undefined);
});

/**
 * kg_supersede is stricter than kg_add: it declares only subject, predicate,
 * old_object, new_object and `at` — no provenance at all. setClosetSourceType
 * and setStalenessFlag both passed source_closet AND source_run_id, so every
 * supersede call was failing -32602 and the axis could never be CHANGED.
 */
test("strips both source_run_id and source_closet from kg_supersede", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);

  await wrapped("mempalace_kg_supersede", {
    subject: "closet-1",
    predicate: "es-source-type",
    old_object: "transcript",
    new_object: "synthesis",
    source_closet: "closet-1",
    source_run_id: "run-abc",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {
    subject: "closet-1",
    predicate: "es-source-type",
    old_object: "transcript",
    new_object: "synthesis",
  }, "only the five declared kg_supersede parameters may survive");
});

test("keeps source_closet on kg_add — it is declared there, and only stripped for supersede", async () => {
  const { calls, caller } = recordingCaller();
  const wrapped = stripUndeclaredSubstrateParams(caller);

  await wrapped("mempalace_kg_add", { subject: "a", predicate: "p", object: "b", source_closet: "a" });

  assert.equal(calls[0].args.source_closet, "a", "kg_add declares source_closet; stripping it would lose provenance");
});
