import { createMemgraphClient, type SourceDrawerWorkItem } from "../core/memgraph.ts";
// Substrate transport is constructed ONLY through the core/ seam (Check A2).
import { createSubstrateClient } from "../core/substrate-client.ts";
import {
  runSynthesisConsolidation,
  type SynthesisConsolidationOptions,
  type SynthesisConsolidationResult,
} from "../capability/episodic/synthesis-consolidation.ts";
import {
  runValidationMergeReview,
  type ValidationMergeReviewResult,
} from "../policy/validation-merge-review.ts";
import {
  runCadenceOrchestrator,
  type CadenceOrchestratorOptions,
  type CadenceOrchestratorResult,
} from "../policy/cadence-orchestrator.ts";
import { DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";
import { acquireConsolidationLock, releaseConsolidationLock } from "./consolidation-lock.ts";

// Extracted modules (criterion 2 decomposition)
import {
  getArg, hasFlag, asObject, asArray, asString, parsePositiveInt,
  parseConsolidationOptions, parseWorklistOptions, parseValidationOptions,
  parseCadenceOptions, parseMemcoreApply, parseCadenceState, usage,
  type CadenceState,
} from "./memory-pipeline/cli-options.ts";
import {
  callSubagentMapper, callSubagentAuditor, resolveSubagentTimeoutMs,
  type MapperEnvelope, type AuditorEnvelope,
} from "./memory-pipeline/subagent.ts";
import {
  chunkItems, ensureRawEntriesForChunk,
  postConsolidationMoves, moveAllToFailed, partitionChunk,
} from "./memory-pipeline/worklist-helpers.ts";
import {
  buildMemcoreMarkdown, fetchHighHeightFacts, resolveMemcoreFilePath,
  fetchPendingReminderLines, fetchDeadEndLines,
} from "./memory-pipeline/memcore-render.ts";
import {
  tryAcquireNativeConsolidationLease, releaseNativeConsolidationLease, discoverLiveMCPConfig,
} from "./memory-pipeline/coordination.ts";
import {
  appendRunEvent,
  appendRunJournalEntry,
  getActivePromptRoutingFromEnv,
  isFalsyFlag,
  isTruthyFlag,
  parseMCPHttpOptions,
  resolveConsolidationMCPURLs,
  resolveRunEventLogPath,
  tryWriteFile,
  type PromptRouting,
} from "./memory-pipeline/runtime-utils.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  pid: number;
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
  exit: (code: number) => never;
};

let activeRunId = "";

// Project root whose shared consolidation lock this process currently holds (null when it
// does not hold one, e.g. the lock was inherited from the spawning plugin). Used
// so both the success path and the top-level catch can release it.
let heldConsolidationLockRoot: string | null = null;
let heldNativeConsolidationLease: { projectRoot: string; runId: string } | null = null;
let configuredPythonBin = "python";
let configuredNativeCoordinatorPath = "";

type ConsolidationCoordMode = "native-queue" | "lockfile" | "bypassed";

const GRAPH_WRITE_TOOL_BASES = new Set([
  "apply_merge",
  "resolve_canonical",
  "kg_query",
  "get_height",
  "find_merge_candidates",
  "find_closet_lineage_issues",
  "update_drawer",
  "kg_add",
  "kg_invalidate",
]);

function isGraphWriteToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  for (const base of GRAPH_WRITE_TOOL_BASES) {
    if (normalized === base || normalized.endsWith(`_${base}`) || normalized.endsWith(`-${base}`)) return true;
  }
  return false;
}

function releaseHeldConsolidationGuards(): void {
  if (heldNativeConsolidationLease) {
    releaseNativeConsolidationLease({
      projectRoot: heldNativeConsolidationLease.projectRoot,
      runId: heldNativeConsolidationLease.runId,
      env: process.env,
      nativeCoordinatorPath: configuredNativeCoordinatorPath,
      pythonBin: configuredPythonBin,
    });
    heldNativeConsolidationLease = null;
  }
  if (heldConsolidationLockRoot) {
    releaseConsolidationLock(heldConsolidationLockRoot);
    heldConsolidationLockRoot = null;
  }
}

async function main(): Promise<void> {
  const startTime = Date.now();
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env });

  // The plugin spawns this script with cwd=plugin install dir (for module/env
  // resolution); ESHEPHERD_PROJECT_ROOT is the actual consumer project, and
  // config/wing/room must resolve against THAT, not this script's own cwd.
  const configCwd = process.env.ESHEPHERD_PROJECT_ROOT || process.cwd();
  const runtimeConfig = loadRuntimeConfig({
    cwd: configCwd,
    env: process.env,
  });

  const mcpAutoDiscover = !isFalsyFlag(String(runtimeConfig.valuesByPath.mcp?.autoDiscover));
  const pythonBin = String(runtimeConfig.valuesByPath.mcp?.pythonBin || "python").trim() || "python";
  const nativeCoordinatorPath = String(runtimeConfig.valuesByPath.consolidation?.lock?.nativeCoordinatorPath || "").trim();
  const worklistPageSize = parsePositiveInt(String(runtimeConfig.valuesByPath.consolidation?.worklist?.pageSize || ""), 50);
  const memcoreMinFactHeight = Number(runtimeConfig.valuesByPath.memcore?.render?.minFactHeight) || 2;
  configuredPythonBin = pythonBin;
  configuredNativeCoordinatorPath = nativeCoordinatorPath;

  // Generate run_id at startup
  const runId = "eshepherd-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 17) + "-" + Math.random().toString(36).slice(2, 6);

  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const runEventLogPath = resolveRunEventLogPath(process.env, process.cwd());
  activeRunId = runId;
  const runProgressState: Record<string, unknown> = {
    runId,
    status: "running",
    phase: "startup",
    startedAt: new Date(startTime).toISOString(),
    updatedAt: new Date().toISOString(),
    counters: {
      examinedCount: 0,
      processedCount: 0,
      failedCount: 0,
      errorCount: 0,
      createdNodeCount: 0,
      chunkIndex: 0,
      chunkTotal: 0,
    },
  };
  const flushRunProgress = (patch: Record<string, unknown> = {}, counterPatch?: Record<string, number>) => {
    const currentCounters = asObject(runProgressState.counters);
    if (counterPatch && Object.keys(counterPatch).length > 0) {
      runProgressState.counters = { ...currentCounters, ...counterPatch };
    }
    Object.assign(runProgressState, patch, { updatedAt: new Date().toISOString() });
    appendRunEvent(runEventLogPath, {
      ts: new Date().toISOString(),
      runId,
      event: "progress",
      status: runProgressState.status,
      phase: runProgressState.phase,
      counters: runProgressState.counters,
      ...(runProgressState.noWorkReason ? { noWorkReason: runProgressState.noWorkReason } : {}),
    });
  };
  appendRunEvent(runEventLogPath, {
    ts: new Date(startTime).toISOString(),
    runId,
    event: "start",
    mode: hasFlag(argv, "--run-cadence") ? "cadence" : "full-pipeline",
  });
  flushRunProgress({ phase: "lock-acquire" });

  let consolidationCoordMode: ConsolidationCoordMode = "bypassed";

  // Cross-process lock so a plugin-triggered run, a cron run, and an n8n run can
  // never overlap. The turn-guard plugin sets ESHEPHERD_CONSOLIDATION_LOCK_INHERITED when
  // it spawns us (it already holds the lock), so we skip acquire/release in that
  // case to avoid deadlocking against the parent. --no-lock /
  // ESHEPHERD_CONSOLIDATION_LOCK_DISABLED bypass it for tests.
  const lockInherited =
    isTruthyFlag(process.env.ESHEPHERD_CONSOLIDATION_LOCK_INHERITED) ||
    isTruthyFlag(runtimeConfig.valuesByPath.consolidation?.lock?.disabled) ||
    hasFlag(argv, "--no-lock");
  if (!lockInherited) {
    const staleMs = Number(runtimeConfig.valuesByPath.commands?.autoConsolidation?.timeoutMs) || 300000;
    const lockRoot = process.cwd();

    const nativeCoordDisabled =
      isTruthyFlag(runtimeConfig.valuesByPath.consolidation?.lock?.nativeCoordinatorDisabled) || hasFlag(argv, "--no-native-coord");

    if (!nativeCoordDisabled) {
      const nativeLease = tryAcquireNativeConsolidationLease({
        projectRoot: lockRoot,
        runId,
        staleMs,
        env: process.env,
        nativeCoordinatorPath,
        pythonBin,
      });
      if (nativeLease.state === "acquired") {
        heldNativeConsolidationLease = { projectRoot: lockRoot, runId };
        consolidationCoordMode = "native-queue";
      } else if (nativeLease.state === "held") {
        flushRunProgress({ status: "skipped", phase: "blocked-native-coordination", reason: "consolidation-native-coord-held" });
        process.stdout.write(
          `${JSON.stringify({ skipped: true, reason: "consolidation-native-coord-held", detail: nativeLease.reason }, null, 2)}\n`,
        );
        return;
      }
    }

    if (consolidationCoordMode !== "native-queue") {
      if (
        !acquireConsolidationLock(
          lockRoot,
          { source: "run-memory-consolidation-and-validation", runId },
          staleMs,
          {
            pythonBin,
            nativePidProbeDisabled: isTruthyFlag(String(runtimeConfig.valuesByPath.consolidation?.lock?.nativePidProbeDisabled)),
          },
        )
      ) {
        flushRunProgress({ status: "skipped", phase: "blocked-lock-held", reason: "consolidation-lock-held" });
        process.stdout.write(`${JSON.stringify({ skipped: true, reason: "consolidation-lock-held" }, null, 2)}\n`);
        return;
      }
      heldConsolidationLockRoot = lockRoot;
      consolidationCoordMode = "lockfile";
    }
  }

  const consolidationOptions = parseConsolidationOptions(argv, runtimeConfig);
  const validationOptions = parseValidationOptions(argv, consolidationOptions, runtimeConfig);
  const cadenceOptions = parseCadenceOptions(argv, consolidationOptions);
  const worklistOptions = parseWorklistOptions(argv, runtimeConfig);
  const memcoreApply = parseMemcoreApply(argv);

  const discoveredMCP = mcpAutoDiscover ? discoverLiveMCPConfig(process.env, pythonBin) : undefined;
  if (!(process.env.MEMPALACE_MCP_BEARER_TOKEN || "").trim() && discoveredMCP?.bearerToken) {
    process.env.MEMPALACE_MCP_BEARER_TOKEN = discoveredMCP.bearerToken;
  }

  const mcpURL = String(runtimeConfig.valuesByPath.mcp?.url || discoveredMCP?.url || DEFAULT_MCP_URL).trim();
  const { readURL: readMCPURL, writeURL: writeMCPURL } = resolveConsolidationMCPURLs(mcpURL);
  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  const mcpHttpOptions = parseMCPHttpOptions((runtimeConfig.valuesByPath.mcp || {}) as Record<string, any>, parsePositiveInt);
  const activeRouting = getActivePromptRoutingFromEnv(process.env);
  const subagentTimeoutMs = resolveSubagentTimeoutMs(process.env);

  // Construct through the core/ seam (Check A2): owns transport + initialize and
  // resolves headers per effective URL (loopback stays unauthenticated).
  const { client: readMCP } = await createSubstrateClient({
    env: process.env,
    clientName: "electric-shepherd-memory-system",
    urlOverride: readMCPURL,
    requestTimeoutMs: mcpHttpOptions.requestTimeoutMs,
    maxRetries: mcpHttpOptions.maxRetries,
    retryBackoffMs: mcpHttpOptions.retryBackoffMs,
    retryMaxBackoffMs: mcpHttpOptions.retryMaxBackoffMs,
  });

  const writeMCP =
    writeMCPURL === readMCPURL
      ? readMCP
      : (
          await createSubstrateClient({
            env: process.env,
            clientName: "electric-shepherd-memory-system-write",
            urlOverride: writeMCPURL,
            requestTimeoutMs: mcpHttpOptions.requestTimeoutMs,
            maxRetries: mcpHttpOptions.maxRetries,
            retryBackoffMs: mcpHttpOptions.retryBackoffMs,
            retryMaxBackoffMs: mcpHttpOptions.retryMaxBackoffMs,
          })
        ).client;

  const client = createMemgraphClient({
    callTool: (name, args) =>
      (isGraphWriteToolName(name) ? writeMCP : readMCP).callToolResult(name, args),
    toolPrefix,
  });

  const runCadence = hasFlag(argv, "--run-cadence");
  const includeBasePipeline = !runCadence || hasFlag(argv, "--include-base-pipeline");
  const opencodeBin = getArg(argv, "--opencode-bin") || "opencode";
  flushRunProgress({ phase: "discovering-worklist" });

  let mapper: MapperEnvelope | undefined;
  const mapperBatches: MapperEnvelope[] = [];
  let consolidation: SynthesisConsolidationResult | undefined;
  const consolidationBatches: SynthesisConsolidationResult[] = [];
  const allSkipped: Array<{ drawer_id: string; reason: string }> = [];
  let validationMergeReview: ValidationMergeReviewResult | undefined;
  let validationSkippedReason: string | undefined;

  const enumerateAll = worklistOptions.mode === "all";
  let worklist: SourceDrawerWorkItem[] = [];
  if (includeBasePipeline) {
    const sourceRoom = worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom;
    worklist = enumerateAll
      ? await client.listSourceDrawersByScope({
          wing: consolidationOptions.targetWing,
          room: sourceRoom,
          limit: worklistOptions.limit,
          pageSize: worklistPageSize,
        })
      : await client.findUnconsolidatedSourceDrawers({
          wing: consolidationOptions.targetWing,
          room: sourceRoom,
          limit: worklistOptions.limit,
          pageSize: worklistPageSize,
        });
  }

  const worklistOutput = {
    mode: worklistOptions.mode,
    count: worklist.length,
    limit: worklistOptions.limit,
    batchSize: worklistOptions.batchSize,
    note: includeBasePipeline
      ? enumerateAll
        ? "full-scope override active: this run may reprocess already-consolidated source drawers"
        : worklistOptions.retryFailedOnly
          ? "retry mode: unconsolidated source drawers selected from failed room"
          : "default mode: unconsolidated source drawers selected from source room"
      : "cadence-only run: base worklist pipeline not executed",
    sourceRoom: worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom,
    processedRoom: worklistOptions.processedRoom,
    failedRoom: worklistOptions.failedRoom,
    retryFailedOnly: worklistOptions.retryFailedOnly,
    moveAlreadyConsolidated: worklistOptions.moveAlreadyConsolidated,
    items: worklist.map((item) => ({
      drawer_id: item.drawer_id,
      wing: item.wing,
      room: item.room,
      desc: item.desc,
      filed_at: item.filed_at,
      source_file: item.source_file,
      added_by: item.added_by,
    })),
  };

  flushRunProgress(
    {
      phase: includeBasePipeline ? "consolidation" : "cadence-only",
      includeBasePipeline,
      worklistMode: worklistOptions.mode,
    },
    {
      examinedCount: worklist.length,
    },
  );
  if (includeBasePipeline) {
    const worklistChunks = chunkItems(worklist, worklistOptions.batchSize);
    const useLiveMapper = hasFlag(argv, "--use-live-mapper");
    const movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
    const movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
    const moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> = [];

    if (worklistChunks.length === 0) {
      // Even with no new source drawers selected, render mem-core from the
      // current synthesized memory state so refreshes are not blocked on
      // creating new closets.
      const emptyConsolidation = await runSynthesisConsolidation(client, {
        ...consolidationOptions,
        rawEntries: [],
        runId,
      });
      consolidationBatches.push(emptyConsolidation);
      flushRunProgress(
        {
          phase: "consolidation-empty-worklist",
          noWorkReason:
            worklistOptions.retryFailedOnly
              ? `no-items-in-${worklistOptions.failedRoom}`
              : `no-items-in-${worklistOptions.sourceRoom}`,
        },
        {
          chunkIndex: 0,
          chunkTotal: 0,
          createdNodeCount: consolidationBatches.map((c) => asString(c.createdNodeId).trim()).filter(Boolean).length,
        },
      );
    }


    for (const [chunkIndex, chunk] of worklistChunks.entries()) {
      flushRunProgress(
        {
          phase: "chunk-processing",
          currentChunk: chunkIndex + 1,
          totalChunks: worklistChunks.length,
          chunkItems: chunk.length,
        },
        {
          chunkIndex: chunkIndex + 1,
          chunkTotal: worklistChunks.length,
          processedCount: movedToProcessed.length,
          failedCount: movedToFailed.length,
          errorCount: moveErrors.length,
          createdNodeCount: consolidationBatches.map((c) => asString(c.createdNodeId).trim()).filter(Boolean).length,
        },
      );
      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} start (items=${chunk.length})\n`,
      );
      const { actionable, movedToProcessed: chunkProcessed, moveErrors: chunkMoveErrors } = await partitionChunk({
        client, chunk,
        processedRoom: worklistOptions.processedRoom,
        targetWing: consolidationOptions.targetWing,
        applyWrites: consolidationOptions.applyWrites,
        moveAlreadyConsolidated: worklistOptions.moveAlreadyConsolidated,
      });
      movedToProcessed.push(...chunkProcessed);
      moveErrors.push(...chunkMoveErrors);

      if (actionable.length === 0) continue;

      flushRunProgress({ phase: "chunk-actionable", actionableCount: actionable.length });

      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} actionable=${actionable.length}\n`,
      );

      let chunkMapper: MapperEnvelope | undefined;

      if (useLiveMapper) {
        chunkMapper = await callSubagentMapper({
          toolPrefix,
          mapperAgentName: getArg(argv, "--mapper-agent") || "dream-mapper",
          activeModel: activeRouting.model,
          query: consolidationOptions.query,
          wing: consolidationOptions.targetWing,
          room: worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom,
          worklistIds: actionable.map((item) => item.drawer_id),
          opencodeBin,
          timeoutMs: subagentTimeoutMs,
        });
        mapperBatches.push(chunkMapper);
      }

      const { entries: rawEntries, skipped: chunkSkipped } = await ensureRawEntriesForChunk(client, actionable);
      if (chunkSkipped.length > 0) allSkipped.push(...chunkSkipped);
      const chunkConsolidation = await runSynthesisConsolidation(client, {
        ...consolidationOptions,
        mapperSummaries: chunkMapper && chunkMapper.summaries.length > 0 ? chunkMapper.summaries : undefined,
        rawEntries,
        runId,
      });
      consolidationBatches.push(chunkConsolidation);
      flushRunProgress(
        {
          phase: "chunk-consolidated",
          lastCreatedNodeId: asString(chunkConsolidation.createdNodeId).trim() || undefined,
        },
        {
          createdNodeCount: consolidationBatches.map((c) => asString(c.createdNodeId).trim()).filter(Boolean).length,
        },
      );
      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} consolidation createdNodeId=${asString(chunkConsolidation.createdNodeId).trim() || "<none>"}\n`,
      );

      if (!consolidationOptions.applyWrites) continue;

      const createdNodeId = asString(chunkConsolidation.createdNodeId).trim();
      if (!createdNodeId) {
        const failedMoves = await moveAllToFailed({
          client, actionable, chunkIndex, totalChunks: worklistChunks.length,
          failedRoom: worklistOptions.failedRoom, targetWing: consolidationOptions.targetWing,
        });
        movedToFailed.push(...failedMoves.movedToFailed);
        moveErrors.push(...failedMoves.moveErrors);
        flushRunProgress(
          { phase: "chunk-move-failed-no-created-node" },
          {
            processedCount: movedToProcessed.length,
            failedCount: movedToFailed.length,
            errorCount: moveErrors.length,
          },
        );
        continue;
      }

      const postMoves = await postConsolidationMoves({
        client,
        actionable,
        chunkIndex,
        totalChunks: worklistChunks.length,
        worklistOptions: { processedRoom: worklistOptions.processedRoom, failedRoom: worklistOptions.failedRoom },
        targetWing: consolidationOptions.targetWing,
      });
      movedToProcessed.push(...postMoves.movedToProcessed);
      movedToFailed.push(...postMoves.movedToFailed);
      moveErrors.push(...postMoves.moveErrors);
      flushRunProgress(
        { phase: "chunk-post-verify" },
        {
          processedCount: movedToProcessed.length,
          failedCount: movedToFailed.length,
          errorCount: moveErrors.length,
        },
      );
    }

    if (consolidationBatches.length > 0) {
      consolidation = consolidationBatches[consolidationBatches.length - 1];
    }

    if (mapperBatches.length > 0) {
      const mergedSummaries = mapperBatches.flatMap((batch) => batch.summaries);
      mapper = {
        summaries: mergedSummaries,
        raw: mapperBatches.map((batch) => batch.raw),
        via: mapperBatches.some((batch) => batch.via === "opencode-run") ? "opencode-run" : "none",
      };
    }

    (worklistOutput as Record<string, unknown>).moves = {
      processed: movedToProcessed,
      failed: movedToFailed,
      errors: moveErrors.length > 0 ? moveErrors : undefined,
      applyWrites: consolidationOptions.applyWrites,
    };

    const touchedNodeIds = [...new Set(consolidationBatches.map((c) => c.createdNodeId).filter(Boolean))] as string[];
    flushRunProgress({ phase: "validation-merge-review", touchedNodeCount: touchedNodeIds.length });
    if (touchedNodeIds.length > 0) {
      validationMergeReview = await runValidationMergeReview(client, {
        ...validationOptions,
        candidateNodeIds: touchedNodeIds,
      });
    } else {
      validationSkippedReason = "no-created-nodes";
    }
  }

  let auditor: AuditorEnvelope | undefined;
  if (includeBasePipeline && hasFlag(argv, "--use-live-auditor") && consolidation && validationMergeReview) {
    auditor = await callSubagentAuditor({
      auditorAgentName: getArg(argv, "--auditor-agent") || "dream-auditor",
      activeModel: activeRouting.model,
      consolidationResult: consolidation,
      validationResult: validationMergeReview,
      opencodeBin,
      timeoutMs: subagentTimeoutMs,
    });
  }
  let memCoreApplyResult: Record<string, unknown> | undefined;
  if (memcoreApply.enabled && includeBasePipeline && consolidation) {
    flushRunProgress({ phase: "memcore-apply" });
    const validationForRender: ValidationMergeReviewResult = validationMergeReview || {
      phase: "validation-merge-review",
      downwardValidation: [],
      mergeAdjudications: [],
      escalations: {
        reasons: validationSkippedReason ? [validationSkippedReason] : [],
        nodeIds: [],
        mergePairs: [],
        notified: false,
      },
    };

    const highHeightFacts = await fetchHighHeightFacts(client, {
      wing: consolidationOptions.targetWing,
      room: consolidationOptions.targetRoom,
      minHeight: memcoreMinFactHeight,
      limit: Number(runtimeConfig.valuesByPath.memcore?.render?.maxFactsPerSection) || 8,
    });

  // Pending reminder lines for the [pending] block.
    const maxPending = Math.max(0, Number(runtimeConfig.valuesByPath.memcore?.render?.maxPendingReminders) || 3);
    const pendingReminderLines = !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includePending))
      ? await fetchPendingReminderLines({
          client,
          wing: consolidationOptions.targetWing,
          room: consolidationOptions.targetRoom,
          query: consolidation.query,
          scopeDir: memcoreApply.scopeDir,
          maxPending,
        })
      : [];

  // Dead-end lines for the [dead-ends] block.
    const maxDeadEnds = Math.max(0, Number(runtimeConfig.valuesByPath.memcore?.render?.maxDeadEnds) || 3);
    const deadEndLines = !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includeDeadEnds))
      ? await fetchDeadEndLines({
          client,
          wing: consolidationOptions.targetWing,
          room: consolidationOptions.targetRoom,
          draftDeadEnds: consolidation.consolidationDraft.deadEnds || [],
          maxDeadEnds,
        })
      : [];

    const markdown = buildMemcoreMarkdown({
      query: consolidation.query,
      consolidation,
      validation: validationForRender,
      auditor,
      sourceDescriptions: Object.fromEntries(worklist.map((item) => [item.drawer_id, asString(item.desc)])),
      includeFacts: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includeFacts)),
      includePointers: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includePointers)),
      maxFactsPerSection: Number(runtimeConfig.valuesByPath.memcore?.render?.maxFactsPerSection) || 8,
      highHeightFacts,
      pendingReminderLines,
      includePending: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includePending)),
      deadEndLines,
      includeDeadEnds: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includeDeadEnds)),
      maxDeadEnds: Number(runtimeConfig.valuesByPath.memcore?.render?.maxDeadEnds) || 3,
    });

    const targetFilePath = resolveMemcoreFilePath({
      explicitFilePath: memcoreApply.filePath,
      explicitBaseDir: memcoreApply.baseDir,
      scopeDir: memcoreApply.scopeDir,
    });

    tryWriteFile(targetFilePath, markdown, process.pid);

    memCoreApplyResult = {
      applied: true,
      mode: "auto",
      fileWritten: true,
      filePath: targetFilePath,
      markdownPreview: markdown.slice(0, 320),
    };
  } else if (!memcoreApply.enabled) {
    memCoreApplyResult = {
      applied: false,
      reason: "disabled by --no-mem-core-auto",
    };
  } else if (!includeBasePipeline) {
    memCoreApplyResult = {
      applied: false,
      reason: "cadence-only run (use --include-base-pipeline for mem-core render)",
    };
  } else {
    memCoreApplyResult = {
      applied: false,
      reason: "missing consolidation outputs",
    };
  }

  let cadence: CadenceOrchestratorResult | undefined;
  let cadenceStateOut: CadenceState | undefined;
  if (hasFlag(argv, "--run-cadence")) {
    cadence = await runCadenceOrchestrator(client, cadenceOptions);

    const cadenceStatePath = getArg(argv, "--cadence-state-file") || "./.electric-shepherd-cadence-state.json";
    const prior = parseCadenceState(cadenceStatePath);
    const next: CadenceState = {
      lastRunISO: new Date().toISOString(),
      areas: { ...prior.areas },
    };

    for (const area of cadence.plan) {
      const prev = next.areas[area.areaId];
      next.areas[area.areaId] = {
        lastCandidateCount: area.candidateCount,
        lastTriggeredISO: area.triggered ? next.lastRunISO : prev?.lastTriggeredISO,
      };
    }

    tryWriteFile(cadenceStatePath, JSON.stringify(next, null, 2), process.pid);
    cadenceStateOut = next;
  }

  // Trace envelope — wrap output with run metadata
  const durationMs = Date.now() - startTime;
  const examinedCount = worklist.length;
  const createdNodes = consolidationBatches.map((c) => c.createdNodeId).filter(Boolean) as string[];

  // Collect warnings for mapper/auditor fallbacks
  const traceWarnings: string[] = [];
  if (mapper && mapper.via === "none") traceWarnings.push("mapper-unavailable");
  if (auditor && auditor.via === "none") traceWarnings.push("auditor-unavailable");

  const output: Record<string, unknown> = {
    trace: {
      runId,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      pid: process.pid,
      examinedCount,
      createdNodeCount: createdNodes.length,
      createdNodeIds: createdNodes,
      consolidationBatchCount: consolidationBatches.length,
      skipped: allSkipped.length > 0 ? allSkipped : undefined,
      warnings: traceWarnings.length > 0 ? traceWarnings : undefined,
      consolidationCoordMode,
      mcpEndpointSource: String(runtimeConfig.valuesByPath.mcp?.url || "").trim()
        ? "env"
        : discoveredMCP
          ? "server-registry"
          : "default",
    },
    mode: includeBasePipeline ? "full-pipeline" : "cadence-only",
    worklistMode: worklistOptions.mode,
    worklist: worklistOutput,
    ...(cadence?.calibration ? { calibration: cadence.calibration } : {}),
  };

  // Write trace envelope to stdout
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const moveSummary = asObject((worklistOutput as Record<string, unknown>).moves);
  flushRunProgress(
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
  appendRunEvent(runEventLogPath, {
    ts: new Date().toISOString(),
    runId,
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
      runId,
      completedAt: new Date().toISOString(),
      durationMs,
      examinedCount,
      createdNodeIds: createdNodes,
      consolidationBatchCount: consolidationBatches.length,
    });
  } catch (err) {
    process.stderr.write(`[memory-consolidation-validation] journal append failed: ${String(err)}\n`);
  }

  releaseHeldConsolidationGuards();
  activeRunId = "";
}

main().catch((err) => {
  try {
    appendRunEvent(resolveRunEventLogPath(process.env, process.cwd()), {
      ts: new Date().toISOString(),
      runId: activeRunId || undefined,
      event: "finish",
      status: "failed",
      error: String(err),
    });
  } catch {
    // best-effort
  }
  releaseHeldConsolidationGuards();
  process.stderr.write(`[memory-consolidation-validation] ${String(err)}\n`);
  process.exit(1);
});
