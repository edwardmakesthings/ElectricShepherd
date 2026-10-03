import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  getArg, hasFlag, asArray, asObject, asString, parsePositiveInt,
  parseConsolidationOptions, parseWorklistOptions, parseValidationOptions,
  parseCadenceOptions, parseMemcoreApply, parseCadenceState, usage,
  type CadenceState,
} from "./memory-pipeline/cli-options.ts";
import {
  callSubagentAuditor, runSubagent, formatPromptModelArg, resolveSubagentTimeoutMs, resolveSubagentRunner,
  type MapperEnvelope, type AuditorEnvelope,
} from "./memory-pipeline/subagent.ts";
import { runChunkConsolidation, type ChunkConsolidationOutcome } from "./memory-pipeline/chunk-consolidation.ts";
import {
  chunkHomogeneousWorklist, ensureRawEntriesForChunk,
  getFamilyDrawerIds, buildReconsolidateWorklist, parseDrawerPayload, postConsolidationMoves, moveAllToRoom, partitionChunk,
  buildReconsolidationRetirementPlan, evaluateReconsolidationRetirement, splitChunkByLineageConflicts,
  type ReconsolidationRetirementPlan,
} from "./memory-pipeline/worklist-helpers.ts";
import { runTriageOnlyPhase } from "./memory-pipeline/triage.ts";
import { renderAndApplyMemcore } from "./memory-pipeline/memcore-render.ts";
import { emitRunCompletion } from "./memory-pipeline/run-report.ts";
import {
  tryAcquireNativeConsolidationLease, releaseNativeConsolidationLease, discoverLiveMCPConfig,
} from "./memory-pipeline/coordination.ts";
import {
  appendRunEvent,
  getActivePromptRoutingFromEnv,
  isFalsyFlag,
  isTruthyFlag,
  parseMCPHttpOptions,
  parseModelSelector,
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
  const readOnlyRoute = Boolean(worklistOptions.onlyDrawerId);
  if (readOnlyRoute) process.env.ESHEPHERD_SOURCE_CAPTURE_ENABLED = "false";
  const READ_ONLY_TOOLS = ["get_drawer", "get_drawers", "kg_query", "kg_query_many", "list_drawers", "search", "status"];
  const readOnlyGuard = { allowed: [] as string[], blocked: [] as string[] };
  const guardTool = (name: string) => {
    if (!readOnlyRoute) return;
    if (!READ_ONLY_TOOLS.some((base) => name === base || name.endsWith(`_${base}`) || name.endsWith(`-${base}`))) {
      readOnlyGuard.blocked.push(name);
      throw new Error(`read-only-route-blocked-tool:${name}`);
    }
    readOnlyGuard.allowed.push(name);
  };
  // Cover raw transport consumers (including triage) as well as Memgraph calls.
  const guardTransport = (transport: Awaited<ReturnType<typeof createSubstrateClient>>["client"]) =>
    !readOnlyRoute ? transport : new Proxy(transport, {
      get(target, key) {
        if (key === "callTool" || key === "callToolResult") return (name: string, args?: Record<string, any>) => {
          guardTool(name);
          return target[key](name, args);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const discoveredMCP = mcpAutoDiscover ? discoverLiveMCPConfig(process.env, pythonBin) : undefined;
  if (!(process.env.MEMPALACE_MCP_BEARER_TOKEN || "").trim() && discoveredMCP?.bearerToken) {
    process.env.MEMPALACE_MCP_BEARER_TOKEN = discoveredMCP.bearerToken;
  }

  const mcpURL = String(runtimeConfig.valuesByPath.mcp?.url || discoveredMCP?.url || DEFAULT_MCP_URL).trim();
  const { readURL: readMCPURL, writeURL: writeMCPURL } = resolveConsolidationMCPURLs(mcpURL);
  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  const mcpHttpOptions = parseMCPHttpOptions((runtimeConfig.valuesByPath.mcp || {}) as Record<string, any>, parsePositiveInt);
  const activeRouting = getActivePromptRoutingFromEnv(process.env);
  // A configured mapper model beats the calling session's model: per-drawer
  // judgement wants a short answer, and inheriting a thinking-heavy general
  // model spends minutes per drawer deliberating a one-line verdict.
  const configuredMapperModel = String(runtimeConfig.valuesByPath.consolidation?.mapperModel || "").trim();
  const mapperModel = configuredMapperModel
    ? parseModelSelector(configuredMapperModel) ?? activeRouting.model
    : activeRouting.model;
  if (configuredMapperModel && !parseModelSelector(configuredMapperModel)) {
    process.stderr.write(
      `[memory-consolidation-validation] ignoring consolidation.mapperModel="${configuredMapperModel}": expected "<provider>/<model>"\n`,
    );
  }
  const subagentTimeoutMs = resolveSubagentTimeoutMs(process.env);
  const keepMapperSessions = runtimeConfig.valuesByPath.consolidation?.keepMapperSessions === true;

  // Construct through the core/ seam (Check A2): owns transport + initialize and
  // resolves headers per effective URL (loopback stays unauthenticated).
  const { client: readTransport } = await createSubstrateClient({
    env: process.env,
    clientName: "electric-shepherd-memory-system",
    urlOverride: readMCPURL,
    requestTimeoutMs: mcpHttpOptions.requestTimeoutMs,
    maxRetries: mcpHttpOptions.maxRetries,
    retryBackoffMs: mcpHttpOptions.retryBackoffMs,
    retryMaxBackoffMs: mcpHttpOptions.retryMaxBackoffMs,
  });
  const readMCP = guardTransport(readTransport);

  const writeMCP =
    writeMCPURL === readMCPURL
      ? readTransport
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
  const guardedWriteMCP = guardTransport(writeMCP);

  // Non-idempotent drawer creation must not be retried invisibly by transport.
  const { client: drawerTransport } = await createSubstrateClient({
    env: process.env, clientName: "electric-shepherd-topic-writes", urlOverride: readMCPURL,
    requestTimeoutMs: mcpHttpOptions.requestTimeoutMs, maxRetries: 0,
  });
  const drawerWriteMCP = guardTransport(drawerTransport);
  const client = createMemgraphClient({
    callTool: (name, args) => {
      return (name.endsWith("add_drawer") ? drawerWriteMCP : isGraphWriteToolName(name) ? guardedWriteMCP : readMCP).callToolResult(name, args);
    },
    toolPrefix,
  });

  const runCadence = hasFlag(argv, "--run-cadence");
  const includeBasePipeline = !runCadence || hasFlag(argv, "--include-base-pipeline");
  // --opencode-bin is kept as the legacy spelling of --subagent-bin.
  const explicitSubagentBin = getArg(argv, "--subagent-bin") || getArg(argv, "--opencode-bin") || undefined;
  const subagentRunner = resolveSubagentRunner({
    explicitBin: explicitSubagentBin,
    env: process.env,
    preferKind: String(runtimeConfig.valuesByPath.consolidation?.subagentHarness || "").trim().toLowerCase() as
      | "opencode"
      | "omp"
      | undefined,
  });
  const esRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (!subagentRunner) {
    // Named degradation: without a runner every mapper pass would return nothing
    // and quarantine its whole worklist as `no-created-node`, which reads as a
    // data problem rather than a missing binary. Say so once, plainly.
    process.stderr.write(
      "[memory-consolidation-validation] no subagent CLI found (looked for opencode/omp on PATH, then ~/.opencode/bin and ~/.local/bin). " +
        "Set --subagent-bin or ESHEPHERD_SUBAGENT_BIN.\n",
    );
  }
  flushRunProgress({ phase: "discovering-worklist" });

  let mapper: MapperEnvelope | undefined;
  const mapperBatches: MapperEnvelope[] = [];
  let consolidation: SynthesisConsolidationResult | undefined;
  const consolidationBatches: SynthesisConsolidationResult[] = [];
  const allSkipped: Array<{ drawer_id: string; reason: string }> = [];
  let validationMergeReview: ValidationMergeReviewResult | undefined;
  let validationSkippedReason: string | undefined;

  const collectCurrentObjects = (kgRaw: unknown, predicate: string, subject?: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const rows = asArray(asObject(kgRaw).facts);
    for (const raw of rows) {
      const fact = asObject(raw);
      if (fact.current === false) continue;
      const factPredicate = asString(fact.predicate || fact.relation || fact.type).trim();
      if (factPredicate !== predicate) continue;
      const factSubject = asString(fact.subject || fact.source || fact.from || fact.head || fact.entity).trim();
      if (subject && factSubject && factSubject !== subject) continue;
      const factObject = asString(fact.object || fact.target || fact.to || fact.tail).trim();
      if (!factObject || seen.has(factObject)) continue;
      seen.add(factObject);
      out.push(factObject);
    }
    return out;
  };

  const listCurrentOutgoingObjects = async (subject: string, predicate: string): Promise<string[]> => {
    const query = await client.kgQuery({
      entity: subject,
      direction: "outgoing",
      predicate,
      recurse: false,
      max_depth: 1,
    });
    return collectCurrentObjects(query, predicate, subject);
  };

  const listCurrentOutgoingObjectsMany = async (subjects: string[], predicate: string): Promise<Record<string, string[]>> => {
    const normalized = [...new Set(subjects.map((id) => id.trim()).filter(Boolean))];
    if (normalized.length === 0) return {};
    const results = await client.kgQueryMany({
      entities: normalized,
      direction: "outgoing",
      predicate,
      recurse: false,
      max_depth: 1,
    });
    const out: Record<string, string[]> = {};
    for (const subject of normalized) {
      out[subject] = collectCurrentObjects(results[subject], predicate, subject);
    }
    return out;
  };

  const reconsolidateClosetIds = [...new Set(worklistOptions.reconsolidateClosetIds.map((id) => id.trim()).filter(Boolean))];
  const reconsolidationParentIds = new Set<string>();
  const reconsolidationParentsByCloset: Record<string, string[]> = {};
  const reconsolidationPlansByCloset = new Map<string, ReconsolidationRetirementPlan>();

  const collectReconsolidationParents = async (closetId: string, parentMap?: Record<string, string[]>): Promise<ReconsolidationRetirementPlan | null> => {
    const normalized = closetId.trim();
    if (!normalized) return null;

    const parents = parentMap ? (parentMap[normalized] || []) : await listCurrentOutgoingObjects(normalized, "synthesized-from");
    const plan = buildReconsolidationRetirementPlan(normalized, parents);
    if (!plan) {
      process.stderr.write(
        "[memory-consolidation-validation] reconsolidate " + normalized + " has no synthesized-from parents; skipping\n",
      );
      return null;
    }

    return plan;
  };
  const enumerateAll = worklistOptions.mode === "all" || worklistOptions.mode === "all-raw";
  const hasReconsolidateMode = reconsolidateClosetIds.length > 0;
  const hasExplicitBatchSize = hasFlag(argv, "--batch-size");
  const effectiveBatchSize = hasReconsolidateMode && !hasExplicitBatchSize
    ? Math.max(1, worklistOptions.batchSize)
    : worklistOptions.batchSize;
  const worklistMode = hasReconsolidateMode ? "reconsolidate" : worklistOptions.mode;
  let worklist: SourceDrawerWorkItem[] = [];
  if (includeBasePipeline && worklistOptions.onlyDrawerId) {
    worklist = [{ drawer_id: worklistOptions.onlyDrawerId, source_class: "raw", wing: consolidationOptions.targetWing, room: worklistOptions.sourceRoom }];
  } else if (includeBasePipeline && !hasReconsolidateMode) {
    const sourceRoom = worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom;
    // Live coverage must not inherit a legacy parent-only consolidated-into edge.
    worklist = enumerateAll || !hasFlag(argv, "--no-live-mapper")
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
    if (worklistOptions.mode === "all-raw") {
      worklist = worklist.filter((item) => (item.source_class || "raw") === "raw");
    }
  }

  if (includeBasePipeline && reconsolidateClosetIds.length > 0) {
    const parentMap = await listCurrentOutgoingObjectsMany(reconsolidateClosetIds, "synthesized-from");
    for (const closetId of reconsolidateClosetIds) {
      const plan = await collectReconsolidationParents(closetId, parentMap);
      const parentIds = plan?.parentIds || [];
      reconsolidationParentsByCloset[closetId] = parentIds;
      if (plan) reconsolidationPlansByCloset.set(plan.closetId, plan);
      for (const parentId of parentIds) reconsolidationParentIds.add(parentId);
    }

    if (reconsolidationParentIds.size > 0) {
      const reconParents: SourceDrawerWorkItem[] = [];
      const parentIds = [...reconsolidationParentIds];
      for (let i = 0; i < parentIds.length; i += 500) {
        const chunk = parentIds.slice(i, i + 500);
        try {
          const fetched = await client.getDrawers({ drawer_ids: chunk });
          const rows = Array.isArray((fetched as { results?: unknown[] }).results)
            ? ((fetched as { results?: unknown[] }).results as unknown[])
            : [];
          const byId = new Map<string, unknown>();
          for (const row of rows) {
            const rowObj = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
            const rowId = asString(rowObj.drawer_id).trim();
            if (rowId) byId.set(rowId, row);
          }

          for (const parentId of chunk) {
            const raw = byId.get(parentId);
            if (!raw) {
              allSkipped.push({ drawer_id: parentId, reason: "reconsolidate-parent-fetch-failed" });
              process.stderr.write(
                "[memory-consolidation-validation] reconsolidate parent fetch failed parent=" + parentId + " err=missing bulk result\n",
              );
              continue;
            }

            const rowObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
            if (rowObj.error) {
              allSkipped.push({ drawer_id: parentId, reason: "reconsolidate-parent-fetch-failed" });
              process.stderr.write(
                "[memory-consolidation-validation] reconsolidate parent fetch failed parent=" + parentId + " err=" + String(rowObj.error) + "\n",
              );
              continue;
            }

            const parsed = parseDrawerPayload(raw);
            const drawerId = asString(parsed?.drawer_id || parentId).trim() || parentId;
            const familyIds = getFamilyDrawerIds(parsed ?? { drawer_id: drawerId });
            reconParents.push({
              drawer_id: drawerId,
              wing: asString(parsed?.wing).trim() || consolidationOptions.targetWing,
              room: asString(parsed?.room).trim() || worklistOptions.sourceRoom,
              desc: parsed?.desc,
              filed_at: parsed?.filed_at,
              source_file: asString((parsed as Record<string, unknown> | null)?.source_file).trim() || undefined,
              added_by: asString((parsed as Record<string, unknown> | null)?.added_by).trim() || undefined,
              content: parsed?.content,
              family_drawer_ids: familyIds,
            });
          }
        } catch (err) {
          for (const parentId of chunk) {
            allSkipped.push({ drawer_id: parentId, reason: "reconsolidate-parent-fetch-failed" });
            process.stderr.write(
              "[memory-consolidation-validation] reconsolidate parent fetch failed parent=" + parentId + " err=" + String(err) + "\n",
            );
          }
        }
      }

      worklist = buildReconsolidateWorklist(reconParents);
    }
  }


  if (await runTriageOnlyPhase({
    argv,
    runtimeConfig,
    worklistOptions,
    includeBasePipeline,
    worklist,
    client,
    toolPrefix,
    readMCP,
    subagentRunner,
    esRoot,
    consolidationOptions,
    runId,
    startTime,
    consolidationCoordMode,
    flushRunProgress,
    runEventLogPath,
  })) {
    releaseHeldConsolidationGuards();
    activeRunId = "";
    return;
  }

  const worklistOutput = {
    mode: worklistMode,
    count: worklist.length,
    limit: worklistOptions.limit,
    batchSize: effectiveBatchSize,
    note: includeBasePipeline
      ? reconsolidateClosetIds.length > 0
        ? "reconsolidate mode: selected closets are evaluated for retirement after successful parent replacement"
        : enumerateAll
          ? "full-scope override active: this run may reprocess already-consolidated source drawers"
          : worklistOptions.retryFailedOnly
            ? "retry mode: unconsolidated source drawers selected from failed room"
            : "default mode: unconsolidated source drawers selected from source room"
      : "cadence-only run: base worklist pipeline not executed",
    sourceRoom: worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom,
    reconsolidateClosetIds: reconsolidateClosetIds.length > 0 ? reconsolidateClosetIds : undefined,
    reconsolidationParentsByCloset: reconsolidateClosetIds.length > 0 ? reconsolidationParentsByCloset : undefined,
    reconsolidationParentCount: reconsolidateClosetIds.length > 0 ? reconsolidationParentIds.size : undefined,
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
      worklistMode,
    },
    {
      examinedCount: worklist.length,
    },
  );
  if (includeBasePipeline) {
    const worklistChunks = chunkHomogeneousWorklist(worklist, effectiveBatchSize);
    // The keyword fallback splits on sentences and lines, so a captured transcript
    // -- one long single-line JSON blob -- yields too few populated sections to
    // clear the confidence floor, and every drawer scores `low` and is dropped.
    // The live mapper is therefore the default; --no-live-mapper keeps the
    // heuristic path for plain-text drawers and offline runs.
    const useLiveMapper = !hasFlag(argv, "--no-live-mapper");
    const mapperAgent = getArg(argv, "--mapper-agent") || "dream-mapper";
    const mapperDefinition = resolve(esRoot, "agents", `${mapperAgent}.md`);
    const mapperPromptHash = createHash("sha256").update(existsSync(mapperDefinition) ? readFileSync(mapperDefinition) : mapperAgent).digest("hex");
    const chunkCoverage: ChunkConsolidationOutcome[] = [];
    const visitedLiveParents = new Set<string>();
    (worklistOutput as Record<string, unknown>).chunkCoverage = chunkCoverage;
    const movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
    const movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
    const moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> = [];
    const reconsolidationParentCoverage = new Set<string>();
    const reconsolidationParentFailures = new Set<string>();

    const trackReconsolidationOutcome = (items: SourceDrawerWorkItem[], outcome: "covered" | "failed"): void => {
      if (reconsolidationParentIds.size === 0 || items.length === 0) return;
      for (const item of items) {
        for (const drawerId of getFamilyDrawerIds(item)) {
          if (!reconsolidationParentIds.has(drawerId)) continue;
          if (outcome === "covered") reconsolidationParentCoverage.add(drawerId);
          else reconsolidationParentFailures.add(drawerId);
        }
      }
    };

    const trackReconsolidationMoves = (
      entries: Array<{ drawer_id: string; family_drawer_ids: string[] }>,
      outcome: "covered" | "failed",
    ): void => {
      if (entries.length === 0) return;
      trackReconsolidationOutcome(entries as SourceDrawerWorkItem[], outcome);
    };

    const retireReconsolidationClosets = async (): Promise<void> => {
      if (reconsolidationPlansByCloset.size === 0) return;

      if (!consolidationOptions.applyWrites) {
        for (const plan of reconsolidationPlansByCloset.values()) {
          process.stderr.write(
            `[memory-consolidation-validation] dry-run reconsolidate plan closet=${plan.closetId} retireEdges=${plan.retireEdges.length} retireStatus=es-status:provisional->retired\n`,
          );
        }
        return;
      }

      const skippedRetirements: Array<{ closetId: string; missingParentIds: string[]; failedParentIds: string[] }> = [];

      for (const plan of reconsolidationPlansByCloset.values()) {
        const evaluation = evaluateReconsolidationRetirement(plan, {
          coveredParentIds: reconsolidationParentCoverage,
          failedParentIds: reconsolidationParentFailures,
        });
        if (!evaluation.canRetire) {
          skippedRetirements.push({
            closetId: plan.closetId,
            missingParentIds: evaluation.missingParentIds,
            failedParentIds: evaluation.failedParentIds,
          });
          process.stderr.write(
            `[memory-consolidation-validation] reconsolidate preserving closet=${plan.closetId} missingParents=${evaluation.missingParentIds.join(",") || "<none>"} failedParents=${evaluation.failedParentIds.join(",") || "<none>"}\n`,
          );
          continue;
        }

        for (const edge of plan.retireEdges) {
          try {
            await client.kgInvalidate({
              subject: edge.subject,
              predicate: edge.predicate,
              object: edge.object,
            });
          } catch (err) {
            process.stderr.write(
              `[memory-consolidation-validation] reconsolidate invalidate failed edge=${edge.subject}->${edge.object} predicate=${edge.predicate} err=${String(err)}\n`,
            );
          }
        }

        try {
          await client.kgSupersede({
            subject: plan.closetId,
            predicate: "es-status",
            old_object: "provisional",
            new_object: "retired",
          });
        } catch (err) {
          process.stderr.write(
            `[memory-consolidation-validation] reconsolidate supersede status failed closet=${plan.closetId} err=${String(err)}\n`,
          );
        }
      }

      if (skippedRetirements.length > 0) {
        (worklistOutput as Record<string, unknown>).reconsolidationRetirementsSkipped = skippedRetirements;
      }
    };

    if (worklistChunks.length === 0) {
      flushRunProgress(
        {
          phase: "consolidation-empty-worklist",
          noWorkReason:
            reconsolidateClosetIds.length > 0
              ? "reconsolidate-parent-set-empty"
              : worklistOptions.retryFailedOnly
                ? `no-items-in-${worklistOptions.failedRoom}`
                : `no-items-in-${worklistOptions.sourceRoom}`,
        },
        {
          chunkIndex: 0,
          chunkTotal: 0,
          createdNodeCount: 0,
        },
      );
    }


    for (const [chunkIndex, chunk] of worklistChunks.entries()) {
      const chunkBatches = await splitChunkByLineageConflicts(
        chunk,
        (sourceId, targetId) => client.hasLineagePath(sourceId, targetId),
      );
      for (const chunkBatch of chunkBatches) {
      if (useLiveMapper) {
        for (const item of chunkBatch) {
          if (visitedLiveParents.has(item.drawer_id)) continue;
          const result = await runChunkConsolidation({
            client, sourceId: item.drawer_id, options: { ...consolidationOptions, runId },
            checkpointDirectory: resolve(worklistOptions.checkpointDirectory || ".electric-shepherd/coverage"),
            extractorVersion: JSON.stringify({ contract: "physical-chunk-topics-v8", model: mapperModel,
              agent: mapperAgent, promptHash: mapperPromptHash }),
            reducerVersion: JSON.stringify({ contract: "topic-reconciliation-v4", model: mapperModel,
              agent: mapperAgent, promptHash: mapperPromptHash }),
            mapChunk: async (prompt, identity) => {
              if (!subagentRunner) throw new Error("mapper-unavailable");
              return runSubagent({ runner: subagentRunner, esRoot, mapperRuntime: true,
                agentName: getArg(argv, "--mapper-agent") || "dream-mapper",
                modelArg: formatPromptModelArg(mapperModel), prompt, timeoutMs: subagentTimeoutMs,
                keepSession: keepMapperSessions, sessionTitle: `es-mapper ${runId} ${identity.chunkId}` });
            },
            reconcileTopic: async (prompt, identity) => {
              if (!subagentRunner) throw new Error("reducer-unavailable");
              return runSubagent({ runner: subagentRunner, esRoot, mapperRuntime: true, agentName: mapperAgent,
                modelArg: formatPromptModelArg(mapperModel), prompt, timeoutMs: subagentTimeoutMs,
                keepSession: keepMapperSessions, sessionTitle: `es-reconcile ${runId} ${identity.topicKey} ${identity.stepIndex}` });
            },
          });
          for (const id of result.familyIds) visitedLiveParents.add(id);
          chunkCoverage.push(result);
          mapperBatches.push({ summaries: result.reconciliation?.topics.map(({ topic }) => ({ ...topic, transcriptId: result.parentDrawerId })) || [],
            unmappedTranscriptIds: result.reconciliation?.reconciliationComplete ? [] : [result.parentDrawerId],
            raw: { extraction: result.extraction, reconciliation: result.reconciliation, error: result.error }, via: subagentRunner ? `${subagentRunner.kind}-run` : "none" });
          consolidationBatches.push(...result.drafts);
          const coveredItem = { ...item, drawer_id: result.parentDrawerId, family_drawer_ids: result.familyIds };
          if (!consolidationOptions.applyWrites) continue;
          if (!result.completed) {
            for (const id of result.familyIds) allSkipped.push({ drawer_id: id, reason: result.error || "chunk-coverage-incomplete" });
            trackReconsolidationOutcome([coveredItem], "failed");
            continue;
          }
          const moveOutcome = await moveAllToRoom({ client, actionable: [coveredItem], chunkIndex,
            totalChunks: worklistChunks.length, targetRoom: worklistOptions.processedRoom,
            targetWing: consolidationOptions.targetWing, reason: result.replacementCoverage ? "chunk-coverage-verified" : "complete-no-substance" });
          movedToProcessed.push(...moveOutcome.moved);
          moveErrors.push(...moveOutcome.moveErrors);
          trackReconsolidationOutcome([coveredItem], result.replacementCoverage && moveOutcome.moveErrors.length === 0 ? "covered" : "failed");
          flushRunProgress({ phase: "chunk-coverage-verified", processedCount: movedToProcessed.length });
        }
        continue;
      }
      flushRunProgress(
        {
          phase: "chunk-processing",
          currentChunk: chunkIndex + 1,
          totalChunks: worklistChunks.length,
          chunkItems: chunkBatch.length,
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
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} start (items=${chunkBatch.length})\n`,
      );
      const { actionable, movedToProcessed: chunkProcessed, moveErrors: chunkMoveErrors } = await partitionChunk({
        client, chunk: chunkBatch,
        processedRoom: worklistOptions.processedRoom,
        targetWing: consolidationOptions.targetWing,
        applyWrites: consolidationOptions.applyWrites,
        moveAlreadyConsolidated: worklistOptions.moveAlreadyConsolidated,
        forceActionableIds: reconsolidationParentIds.size > 0 ? reconsolidationParentIds : undefined,
      });
      movedToProcessed.push(...chunkProcessed);
      moveErrors.push(...chunkMoveErrors);

      if (actionable.length === 0) continue;

      flushRunProgress({ phase: "chunk-actionable", actionableCount: actionable.length });
      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} actionable=${actionable.length}\n`,
      );

      // Non-live/manual mode retains heuristic input, never full chunk coverage.
      const actionableForMoves = actionable;
      const { entries: filteredRawEntries, skipped: chunkSkipped } = await ensureRawEntriesForChunk(client, actionable);
      allSkipped.push(...chunkSkipped);
      const chunkConsolidation = await runSynthesisConsolidation(client, {
        ...consolidationOptions,
        rawEntries: filteredRawEntries,
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
        // No node is not automatically a failure. If the inflation guard refused
        // the draft, the transcript simply had nothing worth synthesizing: that
        // is a processed drawer with zero syntheses, and re-running it would
        // refuse identically forever. Only a node missing despite a passing
        // guard means the tools failed, which is what the failed room is for.
        const noSubstance = !chunkConsolidation.inflationGuard.passed;
        const moveOutcome = await moveAllToRoom({
          client, actionable: actionableForMoves, chunkIndex, totalChunks: worklistChunks.length,
          targetRoom: noSubstance ? worklistOptions.processedRoom : worklistOptions.failedRoom,
          targetWing: consolidationOptions.targetWing,
          reason: noSubstance ? "no-substance" : "no-created-node",
        });
        if (noSubstance) {
          movedToProcessed.push(...moveOutcome.moved);
          // No replacement closet was created, so reconsolidation parents are not covered.
          trackReconsolidationOutcome(actionableForMoves, "failed");
        } else {
          movedToFailed.push(...moveOutcome.moved);
          trackReconsolidationOutcome(actionableForMoves, "failed");
        }
        moveErrors.push(...moveOutcome.moveErrors);
        if (moveOutcome.moveErrors.length > 0) {
          trackReconsolidationMoves(moveOutcome.moveErrors.map((entry) => ({ drawer_id: entry.drawer_id, family_drawer_ids: [entry.drawer_id] })), "failed");
        }
        flushRunProgress(
          { phase: noSubstance ? "chunk-move-processed-no-substance" : "chunk-move-failed-no-created-node" },
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
        actionable: actionableForMoves,
        chunkIndex,
        totalChunks: worklistChunks.length,
        worklistOptions: { processedRoom: worklistOptions.processedRoom, failedRoom: worklistOptions.failedRoom },
        targetWing: consolidationOptions.targetWing,
      });
      movedToProcessed.push(...postMoves.movedToProcessed);
      movedToFailed.push(...postMoves.movedToFailed);
      moveErrors.push(...postMoves.moveErrors);
      // Heuristic/manual mapping does not establish physical chunk replacement coverage.
      trackReconsolidationMoves(postMoves.movedToProcessed, "failed");
      trackReconsolidationMoves(postMoves.movedToFailed, "failed");
      if (postMoves.moveErrors.length > 0) {
        trackReconsolidationMoves(postMoves.moveErrors.map((entry) => ({ drawer_id: entry.drawer_id, family_drawer_ids: [entry.drawer_id] })), "failed");
      }
      flushRunProgress(
        { phase: "chunk-post-verify" },
        {
          processedCount: movedToProcessed.length,
          failedCount: movedToFailed.length,
          errorCount: moveErrors.length,
        },
      );
    }
    }

    await retireReconsolidationClosets();

    if (consolidationBatches.length > 0) {
      consolidation = consolidationBatches[consolidationBatches.length - 1];
    }

    if (mapperBatches.length > 0) {
      const mergedSummaries = mapperBatches.flatMap((batch) => batch.summaries);
      const mergedUnmapped = [...new Set(mapperBatches.flatMap((batch) => batch.unmappedTranscriptIds || []))];
      mapper = {
        summaries: mergedSummaries,
        unmappedTranscriptIds: mergedUnmapped,
        raw: mapperBatches.map((batch) => batch.raw),
        via: mapperBatches.find((batch) => batch.via !== "none")?.via || "none",
      };
    }

    if (readOnlyRoute) (worklistOutput as Record<string, unknown>).readOnlyGuard = { ...readOnlyGuard, writeAttempts: readOnlyGuard.blocked.length };
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
      activeModel: mapperModel,
      consolidationResult: consolidation,
      validationResult: validationMergeReview,
      runner: subagentRunner!,
      esRoot,
      timeoutMs: subagentTimeoutMs,
      keepSession: keepMapperSessions,
      sessionLabel: runId,
    });
  }
  let memCoreApplyResult: Record<string, unknown> | undefined;
  memCoreApplyResult = await renderAndApplyMemcore({
    client,
    consolidationOptions,
    runtimeConfig,
    memcoreApply: readOnlyRoute ? { ...memcoreApply, enabled: false } : memcoreApply,
    memcoreMinFactHeight,
    consolidation,
    validationMergeReview,
    validationSkippedReason,
    auditor,
    worklist,
    includeBasePipeline,
    onProgress: flushRunProgress,
  });

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

  await emitRunCompletion({
    startTime,
    worklist,
    consolidationBatches,
    mapper,
    auditor,
    allSkipped,
    consolidationCoordMode,
    runtimeConfig,
    discoveredMCP,
    includeBasePipeline,
    worklistOptions,
    cadence,
    worklistOutput,
    flushRunProgress,
    runEventLogPath,
    runId,
  });
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
