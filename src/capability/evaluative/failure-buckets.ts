/**
 * Failure-mode bucket id — moved verbatim from
 * procedural/worked-examples.ts (Stage 2 layer assignment): it belongs to the
 * evaluative tier, not the procedural one. Behavior and signature are unchanged;
 * the InterventionLabel vocabulary stays in procedural/worked-examples.ts.
 */

import type { InterventionLabel } from "../procedural/worked-examples.ts";

/**
 * Deterministic failure bucket id for a (model, shapeKey) pair. Mirrors
 * buildCapabilityBucketId's `capability::<shapeKey>::<tier>` form so the two axes
 * share one node-naming convention — but under a distinct `failure::` namespace,
 * never colliding with capability buckets or reserved predicates.
 */
export function buildFailureBucketId(modelId: string, shapeKey: string): string {
  return `failure::${modelId}::${shapeKey}`;
}
