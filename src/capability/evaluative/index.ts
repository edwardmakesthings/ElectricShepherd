/**
 * Evaluative memory capability (spec §3.2, Rung 3).
 *
 * Owns: outcomes, capability routing, calibration — `es-outcome`,
 * `es-calibration-outcome`, plus the unit-level capability tuples
 * (`es-capability-outcome` / `-shape` / `-tier`) and per-model failure-mode memory
 * (`es-failure-event`, intervention patches). This is the feedback axis: it records
 * how units of work actually went, so routing can learn which tier/model to use for
 * a class of task, and calibration can measure whether a model's self-reported
 * confidence is trustworthy on that shape.
 *
 * Binding rule (spec §3.1): this module never calls the substrate directly. The
 * bucket/shape/outcome helpers live in adapter/retrieval-expansion.ts and the
 * composed read methods (getCapabilityRoutingEvidence, getFailureAdjustedRouting,
 * getCalibrationCell) on MemgraphClient; this capability exposes the evaluative
 * surface — write (outcome/capability/calibration tuples), read (routing evidence,
 * calibration cells), fail (named errors) — as explicit functions so the
 * layer-shaped suite can drive them with a fake callTool.
 */

import type { MemgraphClient } from "../../core/memgraph.ts";
import {
  buildCalibrationBucketId,
  buildCapabilityBucketId,
  CAPABILITY_SUBAGENT_BY_TIER,
  CAPABILITY_TIER_BY_SUBAGENT,
  extractWorkedExampleShape,
  parseSelfReportedConfidence,
  type SelfReportedConfidence,
  type WorkedExampleShape,
} from "../procedural/worked-examples.ts";
import {
  buildCapabilityCanonicalShape,
  CAPABILITY_OUTCOME_VALUES,
  CAPABILITY_TIERS,
  mapTaskStatusToCapabilityOutcome,
  type CapabilityOutcome,
  type CapabilityTier,
} from "./capability-shape.ts";
import { buildFailureBucketId } from "./failure-buckets.ts";
import { getOutcomeCounts, recordOutcome } from "./outcomes.ts";

export {
  buildCalibrationBucketId,
  buildCapabilityBucketId,
  buildCapabilityCanonicalShape,
  buildFailureBucketId,
  CAPABILITY_OUTCOME_VALUES,
  CAPABILITY_SUBAGENT_BY_TIER,
  CAPABILITY_TIERS,
  CAPABILITY_TIER_BY_SUBAGENT,
  extractWorkedExampleShape,
  mapTaskStatusToCapabilityOutcome,
  parseSelfReportedConfidence,
  type CapabilityOutcome,
  type CapabilityTier,
  type SelfReportedConfidence,
  type WorkedExampleShape,
};

export { getOutcomeCounts, recordOutcome };

/**
 * WRITE contract (Rung 3 §6.3 question 1): an evaluative record is a set of KG
 * edges on a deterministic bucket id — never a drawer. A capability tuple is
 * (task shape, tier, outcome) on `capability::<shapeKey>::<tier>`; a calibration
 * pair is (model, shape, confidence) on `calibration::<model>::<shape>::<conf>`.
 * The closed outcome set (accept/revise/failed/unused) is enforced at the boundary:
 * an unknown status maps to null and is skipped, not guessed. Returns the exact
 * edges so the test can assert each predicate landed on the right bucket.
 */
export type CapabilityTuplePlan = {
  bucketId: string;
  tier: CapabilityTier;
  outcome: CapabilityOutcome;
  edges: Array<{ subject: string; predicate: string; object: string }>;
};

export function planCapabilityTuple(args: {
  subagentType: string;
  taskText: string;
  status: string;
}): CapabilityTuplePlan | null {
  // Gate 1: only routing tiers are recorded (utility/analysis subagents skipped).
  const tier = CAPABILITY_TIER_BY_SUBAGENT[args.subagentType];
  if (!tier) return null;
  // Gate 2: closed outcome set — unknown statuses are skipped, not guessed.
  const outcome = mapTaskStatusToCapabilityOutcome(args.status);
  if (!outcome) return null;

  const shape = extractWorkedExampleShape(args.taskText);
  const bucketId = buildCapabilityBucketId(shape.shapeKey, tier);
  const canonicalShape = buildCapabilityCanonicalShape(shape);
  return {
    bucketId,
    tier,
    outcome,
    edges: [
      // The core of the capability tuple — one edge per completed unit.
      { subject: bucketId, predicate: "es-capability-outcome", object: outcome },
      // Best-effort shape metadata for explainability (idempotent on the read side).
      { subject: bucketId, predicate: "es-capability-shape", object: canonicalShape.slice(0, 200) },
      { subject: bucketId, predicate: "es-capability-tier", object: tier },
    ],
  };
}

/**
 * READ contract (Rung 3 §6.3 question 2): evaluative memory is consumed when it
 * changes a routing decision — getCapabilityRoutingEvidence aggregates outcomes
 * per (shape, tier) and produces a recommendation with a min-sample gate (default
 * 5), and getFailureAdjustedRouting composes capability + failure evidence into the
 * tier the live hook delegates to. A calibration cell is consumed when
 * decideCalibratedEscalation trusts or escalates a model's self-reported confidence
 * based on its measured hit rate for that (model, shape, confidence) bucket. Both
 * paths change a decision: the delegation goes to a different tier than baseline.
 */
export async function readCapabilityRouting(
  client: MemgraphClient,
  shapeKey: string,
  options?: { minSample?: number; concurrency?: number },
): Promise<{
  tiers: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }>;
  recommendation: string;
  fallback: boolean;
  threshold: number;
}> {
  return client.getCapabilityRoutingEvidence(shapeKey, options);
}

export async function readFailureAdjustedRouting(
  client: MemgraphClient,
  shapeKey: string,
  modelByTier: Record<string, string | null>,
  options?: { minSample?: number; minFailureSample?: number },
): Promise<{
  recommendation: string;
  fallback: boolean;
  threshold: number;
  tiers: Record<string, { baseRate: number | null; failureTotal: number; adjustedScore: number | null }>;
}> {
  return client.getFailureAdjustedRouting(shapeKey, modelByTier, options);
}

export async function readCalibrationDecision(
  client: MemgraphClient,
  args: {
    modelId: string;
    shapeKey: string;
    reportedConfidence: SelfReportedConfidence;
    defaultAction?: "trust" | "escalate";
    minHitRate?: number;
    minSample?: number;
  },
): Promise<{ action: "trust" | "escalate"; reason: string; hitRate: number | null; total: number; threshold: number }> {
  return client.decideCalibratedEscalation(args);
}

/**
 * FAIL contract (Rung 3 §6.3 question 3): a substrate error while recording or
 * reading evaluative evidence degrades to baseline routing / no escalation — the
 * turn continues — but the degradation is NAMED (the evidence read failed), never
 * mistaken for "no history, stay on baseline". A capability tuple that fails to
 * write is recorded as a named write error so the operator sees the gap instead of
 * silently losing one data point from the routing curve.
 */
export class EvaluativeReadError extends Error {
  readonly kind: string;
  constructor(kind: string, detail: string) {
    super(detail);
    this.name = "EvaluativeReadError";
    this.kind = kind;
  }
}

export async function readCapabilityRoutingStrict(
  client: MemgraphClient,
  shapeKey: string,
  options?: { minSample?: number; concurrency?: number },
): Promise<{
  tiers: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }>;
  recommendation: string;
  fallback: boolean;
  threshold: number;
}> {
  try {
    return await readCapabilityRouting(client, shapeKey, options);
  } catch (err) {
    // Named failure: a broken evidence read must not masquerade as "no data".
    const detail = err instanceof Error ? err.message : String(err);
    throw new EvaluativeReadError("protocol", `capability routing read failed: ${detail}`);
  }
}
