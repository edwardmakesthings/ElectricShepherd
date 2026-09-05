/**
 * Phase 14 capability routing tiering — moved verbatim from
 * procedural/worked-examples.ts (Stage 2 layer assignment): these helpers belong
 * to the evaluative tier, not the procedural one. Behavior and signatures are
 * unchanged; the shape they consume (WorkedExampleShape) stays owned by Phase 13
 * in procedural/worked-examples.ts.
 */

import type { WorkedExampleShape } from "../procedural/worked-examples.ts";

/** Phase 14: routing tier vocabulary for capability memory (learned routing). */
export const CAPABILITY_TIERS = ["local", "cloud", "deep"] as const;

export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

/** Phase 14: closed outcome vocabulary for capability tuples (matches es-outcome). */
export const CAPABILITY_OUTCOME_VALUES = ["accept", "revise", "failed", "unused"] as const;

export type CapabilityOutcome = (typeof CAPABILITY_OUTCOME_VALUES)[number];

/**
 * Phase 14 CREATE: map a task tool part status to a capability outcome.
 * Returns null for unknown statuses — the caller skips recording rather than
 * guessing, keeping the closed set honest.
 */
export function mapTaskStatusToCapabilityOutcome(status: string): CapabilityOutcome | null {
  const s = String(status || "").trim().toLowerCase();
  if (s === "success" || s === "completed" || s === "ok") return "accept";
  if (s === "failed" || s === "error") return "failed";
  if (s === "aborted" || s === "cancelled" || s === "canceled") return "unused";
  return null;
}

/**
 * Phase 14: canonical shape summary string for a capability bucket. Deterministic
 * and cheap — the same fields that feed computeShapeKey, joined in a fixed order
 * so two runs over the same prompt produce byte-identical strings (and ids).
 */
export function buildCapabilityCanonicalShape(shape: WorkedExampleShape): string {
  return [
    shape.workClass,
    `files=${shape.fileTypes.join(",") || "n/a"}`,
    `hard=${shape.hardAreas.join(",") || "none"}`,
    `size=${shape.sizeBucket}`,
    `tokens=${shape.keyTokens.slice(0, 6).join(",")}`,
  ].join("|");
}
