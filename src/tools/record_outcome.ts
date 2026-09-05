/**
 * Phase 7 (unified memory): `es-outcome` edges — human-authoritative outcome feedback
 * on the memories that were actually consulted for a unit of work.
 *
 * Predicate shape: `{subject: <node id>, predicate: "es-outcome", object: accept|revise|failed|unused}`.
 * Outcomes ACCUMULATE: multiple edges per closet are expected and meaningful (a closet
 * with 6 accepts + 1 revise is different from one with 1 accept). Nothing here ever
 * invalidates or collapses an existing edge — accumulation, no overwrite.
 *
 * HUMAN-AUTHORITATIVE by design (approved Phase 7 policy): terminal es-outcome writes
 * come ONLY from this explicit tool path, driven by an operator's judgment at cycle
 * close. There is deliberately NO input for test results, reviewer verdicts, or
 * loop/spiral intervention logs — automation is evidence only, never a writer. A
 * failed test run must NOT auto-write `failed`; the operator reads the evidence and
 * decides (loop/spiral alone maps toward `unused` unless a hard failure was
 * human-confirmed).
 *
 * Attribution guardrail (spec: "a closet blamed for a failure it had no part in is
 * worse than no signal"): this tool accepts ONLY an explicit node-id set — the
 * `selected_nodes` recorded against the unit of work. There is no wing/room/scope-based
 * write mode; broad attribution is structurally impossible here. An empty id list is
 * rejected: when the consulted set cannot be determined, write NOTHING.
 *
 * Each edge carries `valid_from` (ISO timestamp) so consumers can window recent
 * history (the /memory-status re-synthesis rule uses a bounded recent window).
 *
 * Dry-run by default — the first call makes NO kg_add; it only echoes the exact edges
 * that would be written. Pass dry_run:false to apply. Per-node failures are counted,
 * never abort the batch (relocate_memory lineage pattern).
 */

import { tool } from "@opencode-ai/plugin";
import { asText } from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { runKgAddWrites } from "../core/operation.ts";
import { normalizeDryRunArg } from "../core/substrate.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

const OUTCOME_PREDICATE = "es-outcome";
export const OUTCOME_VALUES = ["accept", "revise", "failed", "unused"] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

// Phase 16 (unified memory): confidence-calibration tuple. When the operator records an
// es-outcome for a unit that carried a self-reported confidence, the SAME judgment is
// paired with (model, task shape, reported level) and persisted as an
// `es-calibration-outcome` edge on the per-model calibration bucket — so the curve
// accumulates against Phase 7's ground truth. No proxy outcome labels: the object of
// the calibration edge is always this tool's validated es-outcome value.
const CALIBRATION_OUTCOME_PREDICATE = "es-calibration-outcome";
export const CALIBRATION_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type OutcomeEdgeStatus = "proposed" | "added" | "add-failed";

export type OutcomeRecordItem = {
  node_id: string;
  status: OutcomeEdgeStatus;
  proposed_edge?: { subject: string; predicate: string; object: string; valid_from: string };
  error?: string;
};

/** Phase 16: optional calibration tuple attached to an outcome recording. */
export type CalibrationCapture = {
  model_id: string;
  task_shape: string;
  confidence: string;
};

export type OutcomeRecordReport = {
  ok: boolean;
  dry_run: boolean;
  outcome: OutcomeValue;
  cycle_ref?: string;
  edges: OutcomeRecordItem[];
  counts: { proposed: number; added: number; add_failed: number };
  /** Phase 16: the calibration tuple edge (present only when a valid capture was supplied). */
  calibration?: {
    bucket_id: string;
    status: OutcomeEdgeStatus;
    proposed_edge?: { subject: string; predicate: string; object: string; valid_from: string };
    error?: string;
  };
  /** Phase 16: set when a capture was supplied but rejected (invalid level / missing fields). */
  calibration_skipped_reason?: string;
  error?: string;
  next_step?: string;
};

/**
 * Pure core: validate the operator's outcome judgment for an explicit node-id set and
 * (when dry_run is false) write one accumulating `es-outcome` edge per node. Exported
 * for unit testing with a fake transport, mirroring runConcernProposal.
 */
export async function runOutcomeRecord(args: {
  call: CallTool;
  nodeIds: string[];
  outcome: string;
  cycleRef?: string;
  dry_run?: boolean;
  dryRun?: boolean;
  now?: () => Date;
  /** Phase 16: optional calibration tuple for the unit this outcome closes. When all
   *  three fields are present and valid, the SAME es-outcome value is also persisted as
   *  an `es-calibration-outcome` edge on the (model, shape, confidence) bucket — the
   *  only path that creates calibration tuples. */
  calibration?: CalibrationCapture;
}): Promise<OutcomeRecordReport> {
  const outcome = String(args.outcome || "").trim().toLowerCase();
  if (!(OUTCOME_VALUES as readonly string[]).includes(outcome)) {
    throw new Error(
      `record_outcome: invalid outcome "${args.outcome}" — must be one of ${OUTCOME_VALUES.join(" | ")}`,
    );
  }

  // Attribution guardrail: explicit node ids only. No wing/room/scope mode exists, so
  // broad attribution is structurally impossible. Empty set -> write NOTHING (the
  // consulted set was undeterminable; a closet blamed without cause is worse than no
  // signal).
  const nodeIds = [...new Set((args.nodeIds || []).map((id) => asText(id).trim()).filter(Boolean))];
  if (nodeIds.length === 0) {
    throw new Error(
      "record_outcome: at least one explicit node id is required — outcomes attach only to the selected_nodes actually consulted; when that set cannot be determined, write nothing",
    );
  }

  const dryRun = normalizeDryRunArg(args);
  const validFrom = (args.now ?? (() => new Date()))().toISOString();
  const cycleRef = asText(args.cycleRef).trim() || undefined;

  const edges: OutcomeRecordItem[] = nodeIds.map((nodeId) => ({
    node_id: nodeId,
    status: "proposed" as OutcomeEdgeStatus,
    proposed_edge: { subject: nodeId, predicate: OUTCOME_PREDICATE, object: outcome, valid_from: validFrom },
  }));

  const counts = { proposed: edges.length, added: 0, add_failed: 0 };

  // Phase 16: validate the optional calibration tuple. Rejected captures are reported
  // (calibration_skipped_reason) but NEVER abort the es-outcome write — the outcome is
  // the primary record; calibration is an attached signal, not a precondition.
  const calibration = resolveCalibrationCapture(args.calibration);

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      outcome: outcome as OutcomeValue,
      cycle_ref: cycleRef,
      edges,
      counts,
      ...(calibration && !calibration.skipped_reason ? { calibration: { bucket_id: calibration.bucket_id, status: "proposed" as OutcomeEdgeStatus, proposed_edge: { ...calibration.proposed_edge, object: outcome, valid_from: validFrom } } } : {}),
      ...(calibration?.skipped_reason ? { calibration_skipped_reason: calibration.skipped_reason } : {}),
      next_step: "Show this preview to the operator; re-run with dry_run:false only after their explicit confirmation. Automation (test/reviewer signals) must never trigger this write.",
    };
  }

  // APPLY: one kg_add per node. Accumulation — no dedup skip, no invalidation of
  // prior edges; a repeated same-value edge is the operator recording another cycle
  // with the same judgment. Best-effort per node — one failure never aborts the rest.
  const edgeResults = await runKgAddWrites(
    args.call,
    edges.map((edge) => ({
      payload: {
        subject: edge.node_id,
        predicate: OUTCOME_PREDICATE,
        object: outcome,
        valid_from: edge.proposed_edge?.valid_from,
        source_closet: edge.node_id,
        ...(cycleRef ? { source_run_id: cycleRef } : {}),
      },
    })),
  );
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const result = edgeResults[i];
    if (result?.ok) {
      edge.status = "added";
      counts.added += 1;
    } else {
      edge.status = "add-failed";
      edge.error = String(result?.error || "kg_add failed");
      counts.add_failed += 1;
    }
  }

  const report: OutcomeRecordReport = { ok: true, dry_run: false, outcome: outcome as OutcomeValue, cycle_ref: cycleRef, edges, counts };

  // Phase 16 APPLY: persist the calibration tuple edge (same validated es-outcome value)
  // on the per-model bucket. Independent of the es-outcome writes above — a failure here
  // is reported but never reverts or blocks the outcome record.
  if (calibration) {
    if (calibration.skipped_reason) {
      report.calibration_skipped_reason = calibration.skipped_reason;
    } else {
      try {
        const [calibrationWrite] = await runKgAddWrites(args.call, [{
          payload: {
            subject: calibration.bucket_id,
            predicate: CALIBRATION_OUTCOME_PREDICATE,
            object: outcome,
            valid_from: validFrom,
            source_closet: calibration.bucket_id,
            ...(cycleRef ? { source_run_id: cycleRef } : {}),
          },
        }]);
        if (!calibrationWrite?.ok) throw new Error(calibrationWrite?.error || "kg_add failed");
        report.calibration = { bucket_id: calibration.bucket_id, status: "added", proposed_edge: calibration.proposed_edge };
      } catch (err) {
        report.calibration = { bucket_id: calibration.bucket_id, status: "add-failed", proposed_edge: calibration.proposed_edge, error: String(err) };
      }
    }
  }

  if (counts.add_failed > 0 || report.calibration?.status === "add-failed") {
    report.next_step = `Re-run with the same args to retry failed edge(s) (${counts.add_failed} es-outcome, ${report.calibration?.status === "add-failed" ? 1 : 0} calibration).`;
  }
  return report;
}

/** Phase 16: validate and normalize an optional calibration capture. Returns the bucket
 *  id + proposed edge when valid, or a skipped_reason when any field is missing/invalid. */
function resolveCalibrationCapture(capture?: CalibrationCapture): {
  bucket_id: string;
  proposed_edge: { subject: string; predicate: string; object: string; valid_from: string };
  skipped_reason?: string;
} | null {
  if (!capture) return null;
  const modelId = asText(capture.model_id).trim();
  const shapeKey = asText(capture.task_shape).trim();
  const confidence = asText(capture.confidence).trim().toLowerCase();
  if (!modelId || !shapeKey) {
    return {
      bucket_id: "",
      proposed_edge: { subject: "", predicate: CALIBRATION_OUTCOME_PREDICATE, object: "", valid_from: "" },
      skipped_reason: "calibration capture requires model_id and task_shape",
    };
  }
  if (!(CALIBRATION_CONFIDENCE_VALUES as readonly string[]).includes(confidence)) {
    return {
      bucket_id: "",
      proposed_edge: { subject: "", predicate: CALIBRATION_OUTCOME_PREDICATE, object: "", valid_from: "" },
      skipped_reason: `invalid confidence "${capture.confidence}" — must be one of ${CALIBRATION_CONFIDENCE_VALUES.join(" | ")}`,
    };
  }
  const bucketId = `calibration::${modelId}::${shapeKey}::${confidence}`;
  return {
    bucket_id: bucketId,
    // The object/valid_from are filled by the caller (outcome value + shared timestamp);
    // this is a preview stub for the dry-run report.
    proposed_edge: { subject: bucketId, predicate: CALIBRATION_OUTCOME_PREDICATE, object: "", valid_from: "" },
  };
}

export default tool({
  description:
    "Phase 7 outcome feedback (HUMAN-AUTHORITATIVE): record an es-outcome judgment (accept | revise | failed | unused) for an EXPLICIT set of node ids — the selected_nodes actually consulted for a unit of work. Outcomes accumulate (never overwrite). Dry-run by default; pass dry_run:false only after explicit operator confirmation. There is no scope/wing/room write mode and no automatic path: test failures, reviewer verdicts, and loop/spiral logs are evidence for the operator's judgment, never writers.",
  args: {
    node_ids: tool.schema
      .array(tool.schema.string())
      .describe(
        "Explicit node ids to attach the outcome to — exactly the selected_nodes recorded against this unit of work. Broad/scope-based writes are not supported; an empty list is rejected (write nothing when the consulted set is undeterminable).",
      ),
    outcome: tool.schema.string().describe("The operator's terminal judgment for this cycle: accept | revise | failed | unused."),
    cycle_ref: tool.schema
      .string()
      .optional()
      .describe("Optional identifier for the closed work unit (session/run/cycle id) — recorded as source_run_id provenance on each edge."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true). Pass false only after explicit operator confirmation."),
    model_id: tool.schema
      .string()
      .optional()
      .describe(
        "Phase 16 calibration: canonical model id of the unit this outcome closes (e.g. from Phase 15's canonicalModelId). Required WITH task_shape + confidence to record a calibration tuple.",
      ),
    task_shape: tool.schema
      .string()
      .optional()
      .describe(
        "Phase 16 calibration: the unit's canonical task shape key (from extractWorkedExampleShape/buildCapabilityCanonicalShape — the SAME Phase 14/13 shape system). Required WITH model_id + confidence.",
      ),
    confidence: tool.schema
      .string()
      .optional()
      .describe(
        "Phase 16 calibration: the unit's self-reported confidence level (high | medium | low), parsed from its terminal CONFIDENCE line. Required WITH model_id + task_shape. When all three are present, this es-outcome value is ALSO persisted as an es-calibration-outcome edge on the (model, shape, confidence) bucket.",
      ),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    // The write path goes through the same validated core as the unit-tested pure
    // function; the transport is the live palace client.
    const { createPalaceClient } = await import("../core/palace-tools.ts");
    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-record-outcome",
      toolPrefix: args.tool_prefix,
    });
    const call: CallTool = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const report = await runOutcomeRecord({
      call,
      nodeIds: Array.isArray(args.node_ids) ? args.node_ids.map(String) : [],
      outcome: String(args.outcome || ""),
      cycleRef: args.cycle_ref,
      dryRun: args.dry_run,
      // Phase 16: only attach a calibration capture when ALL THREE fields are present —
      // a partial capture is rejected (reported), never guessed.
      ...(args.model_id && args.task_shape && args.confidence
        ? { calibration: { model_id: String(args.model_id), task_shape: String(args.task_shape), confidence: String(args.confidence) } }
        : {}),
    });

    return JSON.stringify(report, null, 2);
  },
});
