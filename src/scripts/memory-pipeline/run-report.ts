/**
 * Run-completion reporting for the consolidation pipeline: trace envelope,
 * final progress flush, run-event finish entry, crash-safe journal append.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import { appendRunEvent, appendRunJournalEntry } from "./runtime-utils.ts";
import { asArray, asObject, type WorklistOptions } from "./cli-options.ts";
import type { AuditorEnvelope, MapperEnvelope } from "./subagent.ts";
import type { DiscoveredMCPConfig } from "./coordination.ts";
import type { SourceDrawerWorkItem } from "../../core/memgraph.ts";
import type { SynthesisConsolidationResult } from "../../capability/episodic/synthesis-consolidation.ts";
import type { LoadedRuntimeConfig } from "../../core/runtime-config.ts";
import type { CadenceOrchestratorResult } from "../../policy/cadence-orchestrator.ts";

type ConsolidationCoordMode = "native-queue" | "lockfile" | "bypassed";

/**
 * Emit the run's trace envelope to stdout, flush final progress, append the
 * finish event to the run log, and write the crash-safe journal entry.
 */
export async function emitRunCompletion(params: {
  startTime: number;
  worklist: SourceDrawerWorkItem[];
  consolidationBatches: SynthesisConsolidationResult[];
  mapper: MapperEnvelope | undefined;
  auditor: AuditorEnvelope | undefined;
  allSkipped: Array<{ drawer_id: string; reason: string }>;
  consolidationCoordMode: ConsolidationCoordMode;
  runtimeConfig: LoadedRuntimeConfig;
  discoveredMCP: DiscoveredMCPConfig | undefined;
  includeBasePipeline: boolean;
  worklistOptions: WorklistOptions;
  cadence: CadenceOrchestratorResult | undefined;
  worklistOutput: Record<string, unknown>;
  flushRunProgress: (patch: Record<string, unknown>, counters?: Record<string, number>) => void;
  runEventLogPath: string;
  runId: string;
}): Promise<void> {
  // Trace envelope — wrap output with run metadata
  const durationMs = Date.now() - params.startTime;
  const examinedCount = params.worklist.length;
  const createdNodes = params.consolidationBatches.map((c) => c.createdNodeId).filter(Boolean) as string[];

  // Collect warnings for mapper/auditor fallbacks
  const traceWarnings: string[] = [];
  if (params.mapper && params.mapper.via === "none") traceWarnings.push("mapper-unavailable");
  if (params.auditor && params.auditor.via === "none") traceWarnings.push("auditor-unavailable");

  const output: Record<string, unknown> = {
    trace: {
      runId: params.runId,
      startedAt: new Date(params.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      pid: process.pid,
      examinedCount,
      createdNodeCount: createdNodes.length,
      createdNodeIds: createdNodes,
      consolidationBatchCount: params.consolidationBatches.length,
      // Why a batch produced no node. Without this the report says only that
      // createdNodeCount is 0, and the refusal has to be recovered by reading
      // the guard's source rather than the run's own log.
      inflationGuardRefusals: params.consolidationBatches
        .map((batch, index) => ({ index, reasons: batch?.inflationGuard?.reasons ?? [] }))
        .filter((entry) => entry.reasons.length > 0),
      skipped: params.allSkipped.length > 0 ? params.allSkipped : undefined,
      warnings: traceWarnings.length > 0 ? traceWarnings : undefined,
      consolidationCoordMode: params.consolidationCoordMode,
      mcpEndpointSource: String(params.runtimeConfig.valuesByPath.mcp?.url || "").trim()
        ? "env"
        : params.discoveredMCP
          ? "server-registry"
          : "default",
    },
    mode: params.includeBasePipeline ? "full-pipeline" : "cadence-only",
    worklistMode: params.worklistOptions.mode,
    worklist: params.worklistOutput,
    ...(params.cadence?.calibration ? { calibration: params.cadence.calibration } : {}),
  };

  // Write trace envelope to stdout
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const moveSummary = asObject((params.worklistOutput as Record<string, unknown>).moves);
  params.flushRunProgress(
    {
      status: "completed",
      phase: "completed",
      completedAt: new Date().toISOString(),
      durationMs,
    },
    {
      examinedCount,
      processedCount: asArray(moveSummary.processed).length,
      failedCount: asArray(moveSummary.failed).length,
      createdNodeCount: createdNodes.length,
    },
  );
  appendRunEvent(params.runEventLogPath, {
    ts: new Date().toISOString(),
    runId: params.runId,
    event: "finish",
    status: "completed",
    durationMs,
    examinedCount,
    createdNodeCount: createdNodes.length,
  });

  // Append run journal entry for crash-safe resume
  try {
    appendRunJournalEntry({
      env: process.env,
      cwd: process.cwd(),
      runId: params.runId,
      completedAt: new Date().toISOString(),
      durationMs,
      examinedCount,
      createdNodeIds: createdNodes,
      consolidationBatchCount: params.consolidationBatches.length,
    });
  } catch (err) {
    process.stderr.write(`[memory-consolidation-validation] journal append failed: ${String(err)}\n`);
  }
}
