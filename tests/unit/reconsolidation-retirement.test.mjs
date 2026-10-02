import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReconsolidationRetirementPlan,
  buildReconsolidateWorklist,
  chunkHomogeneousWorklist,
  evaluateReconsolidationRetirement,
  mergeUniqueWorklistItemsById,
  partitionWorklistBySourceClass,
  splitChunkByLineageConflicts,
} from "../../src/scripts/memory-pipeline/worklist-helpers.ts";


test("buildReconsolidationRetirementPlan builds both lineage edges per parent", () => {
  const plan = buildReconsolidationRetirementPlan("closet_1", ["parent_a", "parent_b", "parent_a"]);
  assert.ok(plan);
  assert.deepEqual(plan.parentIds, ["parent_a", "parent_b"]);
  assert.deepEqual(plan.retireEdges, [
    { subject: "closet_1", predicate: "synthesized-from", object: "parent_a" },
    { subject: "parent_a", predicate: "consolidated-into", object: "closet_1" },
    { subject: "closet_1", predicate: "synthesized-from", object: "parent_b" },
    { subject: "parent_b", predicate: "consolidated-into", object: "closet_1" },
  ]);
});

test("evaluateReconsolidationRetirement requires full covered set and no failed parents", () => {
  const plan = buildReconsolidationRetirementPlan("closet_1", ["parent_a", "parent_b"]);
  assert.ok(plan);

  const success = evaluateReconsolidationRetirement(plan, {
    coveredParentIds: new Set(["parent_a", "parent_b"]),
    failedParentIds: new Set(),
  });
  assert.equal(success.canRetire, true);
  assert.deepEqual(success.missingParentIds, []);
  assert.deepEqual(success.failedParentIds, []);

  const unmapped = evaluateReconsolidationRetirement(plan, {
    coveredParentIds: new Set(["parent_a"]),
    failedParentIds: new Set(),
  });
  assert.equal(unmapped.canRetire, false);
  assert.deepEqual(unmapped.missingParentIds, ["parent_b"]);
  assert.deepEqual(unmapped.failedParentIds, []);

  const failed = evaluateReconsolidationRetirement(plan, {
    coveredParentIds: new Set(["parent_a", "parent_b"]),
    failedParentIds: new Set(["parent_a"]),
  });
  assert.equal(failed.canRetire, false);
  assert.deepEqual(failed.missingParentIds, []);
  assert.deepEqual(failed.failedParentIds, ["parent_a"]);
});


test("partitionWorklistBySourceClass separates raw and layered items", () => {
  const items = [
    { drawer_id: "raw-1", source_class: "raw" },
    { drawer_id: "lay-1", source_class: "layered" },
    { drawer_id: "raw-2" },
  ];

  const groups = partitionWorklistBySourceClass(items);
  assert.deepEqual(groups.raw.map((item) => item.drawer_id), ["raw-1", "raw-2"]);
  assert.deepEqual(groups.layered.map((item) => item.drawer_id), ["lay-1"]);
});

test("chunkHomogeneousWorklist never mixes classes in a chunk", () => {
  const items = [
    { drawer_id: "r1", source_class: "raw" },
    { drawer_id: "l1", source_class: "layered" },
    { drawer_id: "r2", source_class: "raw" },
    { drawer_id: "l2", source_class: "layered" },
  ];

  const chunks = chunkHomogeneousWorklist(items, 2);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].map((item) => item.drawer_id), ["r1", "r2"]);
  assert.deepEqual(chunks[1].map((item) => item.drawer_id), ["l1", "l2"]);
  assert.ok(chunks.every((chunk) => new Set(chunk.map((item) => item.source_class || "raw")).size === 1));
});

test("mergeUniqueWorklistItemsById de-duplicates drawer ids", () => {
  const merged = mergeUniqueWorklistItemsById([
    { drawer_id: "parent_a", source_class: "raw" },
    { drawer_id: "parent_b", source_class: "raw" },
    { drawer_id: "parent_a", source_class: "raw", room: "source-transcripts-processed" },
  ]);
  assert.deepEqual(merged.map((item) => item.drawer_id), ["parent_a", "parent_b"]);
});

test("buildReconsolidateWorklist returns only selected parent drawers", () => {
  const baseWorklist = [
    { drawer_id: "unconsolidated_1", source_class: "raw" },
    { drawer_id: "unconsolidated_2", source_class: "raw" },
  ];
  const reconParents = [
    { drawer_id: "parent_a", source_class: "raw" },
    { drawer_id: "parent_b", source_class: "raw" },
    { drawer_id: "parent_a", source_class: "raw", room: "source-transcripts-processed" },
  ];

  const worklist = buildReconsolidateWorklist(reconParents);
  assert.deepEqual(worklist.map((item) => item.drawer_id), ["parent_a", "parent_b"]);
  assert.ok(worklist.every((item) => item.drawer_id.startsWith("parent_")));
  assert.ok(worklist.every((item) => !item.drawer_id.startsWith("unconsolidated_")));

  void baseWorklist;
});

test("splitChunkByLineageConflicts separates ancestor/descendant drawers", async () => {
  const items = [
    { drawer_id: "ancestor", source_class: "layered" },
    { drawer_id: "descendant", source_class: "layered" },
    { drawer_id: "sibling", source_class: "layered" },
  ];

  const edges = new Set(["ancestor->descendant"]);
  const hasLineagePath = async (sourceId, targetId) => edges.has(sourceId + "->" + targetId);

  const chunks = await splitChunkByLineageConflicts(items, hasLineagePath);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].map((item) => item.drawer_id), ["ancestor", "sibling"]);
  assert.deepEqual(chunks[1].map((item) => item.drawer_id), ["descendant"]);
});