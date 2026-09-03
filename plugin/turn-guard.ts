/**
 * Turn-guard plugin for OpenCode.
 *
 * Single owner of the "what should happen at the end of an assistant turn?"
 * decision. Merges two previously-separate plugins (stop-quality-retry +
 * memory-checkpoint) because they were coordination-coupled: both fired on the
 * same events (message.updated, session.idle) and both worked by injecting a
 * follow-up prompt, with no knowledge of each other — so a checkpoint reply
 * tripped the retry guard.
 *
 * The end-of-turn decision is now race-free and single-owned:
 *   1. RETRY  — the turn ended with finish=stop but stalled (no useful output,
 *               missing a final review, or announced an action then stopped).
 *               Reactive, can fire multiple times per session, hard-capped.
 *   2. CHECKPOINT — the turn ended cleanly (a successful stop: useful output,
 *               not mid-intent) and the session has done real work in build/plan
 *               mode. Proactive, fires at most once per session, only on idle.
 *               Prompts the model to (a) update the always-loaded memory blocks
 *               if durable STATE changed, and (b) save a diary/worked-example
 *               entry if substantive WORK was done or something was LEARNED —
 *               even when no block changed.
 *   3. Otherwise leave the turn alone.
 *
 * Coordination rules that resolve the old conflict:
 *   - A reply to a checkpoint prompt (parent carries CHECKPOINT_MARKER) is
 *     terminal and is NEVER retried.
 *   - Checkpoint only fires on a genuinely complete turn, so it never fires over
 *     a stall (the retry path owns stalls).
 *   - If a retry is issued on idle, no checkpoint is issued that same round.
 *
 * Install: ~/.config/opencode/plugins/turn-guard.ts
 */
// @ts-nocheck

import { execFile, execFileSync, spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, closeSync } from "node:fs"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import {
  buildCommandExecutionPlan,
  buildCalibrationEscalationNote,
  computeToolSignature,
  decideAutoConsolidation,
  decideCapabilityReroute,
  decideLoopIntervention,
  detectDeliberationSpiral,
  isDeliberationExemptPrompt,
  pruneAutoConsolidationTracking,
  shouldFileWorkedExample,
  shouldInjectWorkedExamples,
  shouldSkipWorkedExampleByCooldown,
} from "../adapter/turn-guard-helpers.ts"
import type { AutoConsolidationTrigger, MemcoreInjectionRecord } from "../adapter/turn-guard-helpers.ts"
import { loadPackagedAssets, mergeWithoutOverride, loadInstructionPaths, dedupeAppendInstructions } from "../adapter/asset-loader.ts"
import { loadRuntimeConfig, getRuntimeConfigEnvMap, DEFAULT_MCP_URL, DEFAULT_MCP_TOOL_PREFIX } from "../adapter/runtime-config.ts"
// Substrate transport is constructed ONLY through the core/ seam (Check A2).
import { createSubstrateClient } from "../core/substrate-client.ts"
import { SubstrateError, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts"
import { createMemgraphClient } from "../adapter/memgraph.ts"
import { retrieveSimilarWorkedExamples, formatWorkedExampleDemonstration, WORKED_EXAMPLE_MAX_INJECT, WORKED_EXAMPLE_RELEVANCE_FLOOR, extractWorkedExampleShape, buildWorkedExampleEntry, WORKED_EXAMPLE_FILE_AGENT_TYPES, WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS, CAPABILITY_TIER_BY_SUBAGENT, CAPABILITY_SUBAGENT_BY_TIER, mapTaskStatusToCapabilityOutcome, buildCapabilityCanonicalShape, buildCapabilityBucketId, canonicalModelId, buildFailureBucketId, buildFailurePatchId, FAILURE_PATCH_TEXT_MAX_CHARS, parseSelfReportedConfidence, buildCalibrationBucketId, INTERVENTION_REPLAY_HEADING, formatInterventionBlock } from "../adapter/retrieval-expansion.ts"
import { loadRuntimeEnv } from "../scripts/runtime-env.ts"

import { createHookHeadHandlers } from "./session-policy/hook-head.ts"
import { createToolRegistry } from "./session-policy/registry.ts"
import { buildSourceCaptureEnv, buildConsolidationEnv } from "./session-policy/env.ts"
import type { MessageWithParts } from "./session-policy/constants.ts"
import {
  AUTO_RETRY_MARKER, CHECKPOINT_MARKER, START_BANNER,
  MAX_RETRIES_PER_PARENT, DEFAULT_MAX_RETRIES_PER_SESSION, STATUS_DIR, STATUS_FILE,
  AUTOCONSOLIDATION_LOG_FILE, MEMCORE_CONTEXT_LOG_FILE, MEMORY_USAGE_LOG_FILE, EVENT_LOG_FILE,
  TURN_GUARD_INSTANCE_DIRS_KEY, TURN_GUARD_INSTANCE_RESET_KEY,
  DEFAULT_MEMCORE_MAX_SCOPES, DEFAULT_RETRY_ENABLED, LOOP_GUARD_MARKER,
  CALIBRATION_OVERRIDE_MIN_SAMPLES, CALIBRATION_MIN_HIT_RATE,
  INTERVENTION_REPLAY_MAX_PATCHES,
  SPIRAL_GUARD_MARKER,
  AUTOCONSOLIDATION_LOCK_FILE,
  DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS, DEFAULT_MEMCORE_LOADER_TIMEOUT_MS,
  MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT,
  CHECKPOINT_MODES, DEFAULT_CHECKPOINT_DISABLED_AGENTS, normalizePathForHost, toLowerSet,
} from "./session-policy/constants.ts"
import {
  findProjectRoot,
  writeStatusFile, appendAutoConsolidationLog, appendMemoryUsageLog,
  acquireAutoConsolidationLock, releaseAutoConsolidationLock, killProcessTree,
  getToolNames, classifyMemoryTools, pruneToMax, sortByCreated, unwrapListResult, unwrapMessageResult,
} from "./session-policy/pure-helpers.ts"
import { findSessionID, getAgentIdentity, getActiveModel, getActiveAgent, getPromptRouting, normalizeModelSpec, resolveSessionPromptRoutingWithGating, resolveLoopGuardRoutingWithGating, resolveTaskSwapTarget, getPromptRoutingFromToolHook } from "./session-policy/routing.ts"
import { maybeInjectMemcoreWithGating, persistWorkedInterventionWithGating, maybeRecordModelFailureWithGating, queuePendingInterventionWithGating, confirmPendingInterventionsWithGating } from "./session-policy/interventions.ts"
import { maybeFileWorkedExampleWithGating, maybeFileWorkedExamplesFromMessageWithGating } from "./session-policy/worked-example.ts"
import { maybeRecordCapabilityTupleWithGating, maybeCaptureCalibrationTupleWithGating } from "./session-policy/capability.ts"
import { runSourceCaptureCommand, verifySourceCaptureWithGating, runConsolidationCommandWithGating, evaluateAutoConsolidationWithGating, armAutoConsolidationIdleTimerWithGating, noteAutoConsolidationActivityWithGating } from "./session-policy/source-capture.ts"
import { bindSessionPolicyHandlers, issueRetryWithGating, maybeSpiralNudgeWithGating, maybeCheckpointWithGating } from "./session-policy/handlers.ts"
import { bindToolExecuteBefore } from "./session-policy/tool-hook.ts"
import type { TurnGuardContext } from "./session-policy/context.ts"
import { initSessionPolicyState } from "./session-policy/state.ts"

// Absolute path to the ElectricShepherd install root (the plugin's own repo).
// Runtime scripts must run from HERE — not the consumer project's cwd — so
// loadRuntimeEnv finds ElectricShepherd/.env (or the sibling docker/.env) and
// scripts resolve their sibling adapter modules.
const ESHEPHERD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const TurnGuard = async ({ client, directory }: any) => {
  const rootDirectory = normalizePathForHost(directory || process.cwd())
  const projectRoot = findProjectRoot(rootDirectory)
  const runtimeConfig = loadRuntimeConfig({
    cwd: projectRoot,
    env: process.env,
  })
  const runtimeConfigEnv = getRuntimeConfigEnvMap(runtimeConfig)
  const runtimeEnv = {
    ...process.env,
    ...runtimeConfigEnv,
  }
  loadRuntimeEnv({
    scriptUrl: import.meta.url,
    env: runtimeEnv,
    cwd: projectRoot,
  })
  // Config readers + all startup-resolved values and per-session Maps/Sets live in
  // one helper so this file stays a thin adapter; see session-policy/state.ts.
  const state = initSessionPolicyState(runtimeConfig.valuesByPath)
  const {
    cfgRaw,
    cfgBool,
    cfgNum,
    cfgCSV,
    memcoreInjectEnabled,
    memcoreInjectOnIdle,
    memcoreInjectOnCompacted,
    memcoreInjectOnStart,
    compactArchiveEnabled,
    memcoreMaxChars,
    injectionCooldownMs,
    retryEnabled,
    retryDisabledAgents,
    retryDisabledModes,
    sourceCaptureVerifyEnabled,
    autoConsolidationEnabled,
    autoConsolidationOnIdle,
    autoConsolidationOnCompact,
    autoConsolidationIdleDelayMs,
    autoConsolidationMessageThreshold,
    autoConsolidationCooldownMs,
    autoConsolidationTimeoutMs,
    autoConsolidationMaxTrackedSessions,
    retriedParentBySession,
    retriesTotalBySession,
    retryChainBySession,
    maxRetriesPerSession,
    startupConfirmedBySession,
    inspectedStopBySession,
    toolWindowBySession,
    loopInterventionsBySession,
    taskWindowBySession,
    taskEscalationsBySession,
    taskRecentLaunchBySession,
    workedExampleFiledByShape,
    loopGuardEnabled,
    loopRepeatThreshold,
    loopWindowSize,
    loopMaxInterventions,
    loopMutationTools,
    loopExemptTools,
    taskWatchdogEnabled,
    taskWatchdogThreshold,
    taskWatchdogMaxEscalations,
    taskSerializeTypes,
    taskSerializeCooldownMs,
    taskSwapQwenMatch,
    taskSwapQwenToProvider,
    taskSwapQwenToModel,
    taskSwapGemmaMatch,
    taskSwapGemmaToProvider,
    taskSwapGemmaToModel,
    taskFallbackProvider,
    taskFallbackModel,
    workedExampleInjectionEnabled,
    workedExampleSearchTimeoutMs,
    workedExampleFilingEnabled,
    capabilityRecordingEnabled,
    failureRecordingEnabled,
    calibrationCaptureEnabled,
    failurePatchInjectionEnabled,
    capabilityRecordedBySession,
    pendingCalibrationBySession,
    failureRecordedBySession,
    pendingInterventionBySession,
    spiralGuardEnabled,
    spiralInvestigateThreshold,
    spiralReversalThreshold,
    spiralMaxInterventions,
    spiralExemptReflection,
    spiralGuardDisabledModes,
    spiralGuardDisabledAgents,
    spiralExemptProviders,
    spiralExemptModelPrefixes,
    spiralNudgedBySession,
    spiralInspectedBySession,
  } = state

  const globalState = globalThis as any
  const instanceDirs: Set<string> =
    globalState[TURN_GUARD_INSTANCE_DIRS_KEY] ?? (globalState[TURN_GUARD_INSTANCE_DIRS_KEY] = new Set<string>())

  if (instanceDirs.has(rootDirectory)) {
    console.log(`${START_BANNER}: duplicate plugin load detected for directory=${rootDirectory}; skipping secondary instance`)
    return {}
  }
  // Test seam: tests run the real handler in-process and need a fresh instance
  // per temp project dir; the plugin dedupes on globalThis, so allow an explicit
  // reset from test code (never set in production).
  if ((globalState as any)[TURN_GUARD_INSTANCE_RESET_KEY]) {
    delete (globalState as any)[TURN_GUARD_INSTANCE_RESET_KEY]
    instanceDirs.clear()
  }
  instanceDirs.add(rootDirectory)

  console.log(`${START_BANNER}: plugin loaded (directory=${directory})`)
  if (runtimeConfig.configPath) {
    console.log(`[turn-guard] runtime config loaded: ${runtimeConfig.configPath}`)
  } else {
    console.log("[turn-guard] runtime config loaded: defaults (no config file found: checked eshepherd-config.jsonc, eshepherd-config.example.jsonc)")
  }
  for (const warning of runtimeConfig.warnings) {
    console.warn(`[turn-guard] runtime config warning: ${warning}`)
  }
  console.log("[turn-guard] registering hooks: event(message.updated, session.idle, session.compacted, session.started), tool.execute.before")
  console.log(
    `[turn-guard] retry guard: ${
      cfgBool("retry.enabled", DEFAULT_RETRY_ENABLED)
        ? `ON (ESHEPHERD_RETRY_ENABLED=true, max ${Math.max(1, cfgNum("retry.maxRetriesPerSession", DEFAULT_MAX_RETRIES_PER_SESSION))}/session)`
        : "OFF by default (ESHEPHERD_RETRY_ENABLED=true to opt in)"
    }`,
  )
  let workedExampleClientPromise: Promise<any> | null = null
  // Phase 14/15 CONSUME (live routing): a full MemgraphClient used ONLY to read
  // capability + failure evidence before choosing a delegation tier. Kept separate
  // from the thin worked-example wrapper above because it needs the composed
  // getFailureAdjustedRouting method, not just raw kgQuery. Lazy + cached exactly
  // like getWorkedExampleClient; init failure degrades to null (neutral routing).
  let routingEvidenceClientPromise: Promise<any> | null = null
  function getRoutingEvidenceClient(): Promise<any> {
    if (!routingEvidenceClientPromise) {
      routingEvidenceClientPromise = (async () => {
        const mcpURL = String(cfgRaw("mcp.url") || "").trim() || DEFAULT_MCP_URL
        const toolPrefix = String(cfgRaw("mcp.toolPrefix") || "").trim() || DEFAULT_MCP_TOOL_PREFIX
        // Pre-Rung-3 this path resolved headers directly from env with NO loopback
        // strip (it always sent gateway credentials). Pass them explicitly so the
        // core/ seam stays byte-identical to the old behavior.
        const headers = resolveMCPHeadersFromEnv(runtimeEnv)
        // Construct through the core/ seam (Check A2): owns transport + initialize.
        const { client: mcp } = await createSubstrateClient({
          env: runtimeEnv,
          clientName: "electric-shepherd-turn-guard-routing",
          urlOverride: mcpURL,
          headersOverride: headers,
          requestTimeoutMs: workedExampleSearchTimeoutMs,
          maxRetries: 0,
        })
        return createMemgraphClient({
          // Return the SubstrateResult directly so memgraph's typed failure handling
          // (slice 2) can branch on ok/kind instead of treating a failure as an empty result.
          callTool: async (name: string, args?: Record<string, unknown>) => mcp.callToolResult(name, args),
          toolPrefix,
        })
      })().catch((err) => {
        console.log(`[turn-guard] routing evidence client init failed (neutral routing): ${String(err)}`)
        return null
      })
    }
    return routingEvidenceClientPromise
  }
  function getWorkedExampleClient(): Promise<any> {
    if (!workedExampleClientPromise) {
      workedExampleClientPromise = (async () => {
        const mcpURL = String(cfgRaw("mcp.url") || "").trim() || DEFAULT_MCP_URL
        const toolPrefix = String(cfgRaw("mcp.toolPrefix") || "").trim() || DEFAULT_MCP_TOOL_PREFIX
        // Pre-Rung-3 this path resolved headers directly from env with NO loopback
        // strip (it always sent gateway credentials). Pass them explicitly so the
        // core/ seam stays byte-identical to the old behavior.
        const headers = resolveMCPHeadersFromEnv(runtimeEnv)
        // Construct through the core/ seam (Check A2): owns transport + initialize.
        const { client: mcp } = await createSubstrateClient({
          env: runtimeEnv,
          clientName: "electric-shepherd-turn-guard",
          urlOverride: mcpURL,
          headersOverride: headers,
          requestTimeoutMs: workedExampleSearchTimeoutMs,
          maxRetries: 0,
        })
        const callRaw = async (toolName: string, args?: Record<string, unknown>) => {
          const result = await mcp.callToolResult(toolName, args)
          if (!result.ok) throw new SubstrateError(result.kind, result.detail)
          return result.value
        }
        return {
          search: (q: string, limit?: number, wing?: string, room?: string) =>
            callRaw(`${toolPrefix}search`, { query: q, limit, wing, room }),
          getDrawer: (args: { drawer_id: string }) =>
            callRaw(`${toolPrefix}get_drawer`, args),
          // Phase 13 CREATE: write path for filing worked examples + stamping.
          diaryWrite: (args: Record<string, unknown>) =>
            mcp.callToolResult(`${toolPrefix}diary_write`, args),
          kgAdd: (args: Record<string, unknown>) =>
            mcp.callToolResult(`${toolPrefix}kg_add`, args),
          // Phase 15 CONSUME: bounded one-hop KG read for failure-mode patches.
          kgQuery: (args: Record<string, unknown>) =>
            mcp.callToolResult(`${toolPrefix}kg_query`, args),
        }
      })().catch((err) => {
        console.log(`[turn-guard] worked-example injection: palace client init failed: ${String(err)}`)
        return null
      })
    }
    return workedExampleClientPromise
  }

  // Phase 13 CREATE: file a compact worked example to the apprenticeship room when a
  // cloud implementation subagent (implement-cloud, build-cloud) completes
  // successfully with substantive output. Best-effort: any failure (MCP down, stamp
  // rejected, dedup hit) degrades to a log line and NEVER throws into the turn. The
  // entry is stamped es-source-type: worked-example via kg_add after filing — a
  // distinct knowledge class from procedural skills; the CONSUME side admits both
  // "worked-example" and (for backward compatibility) "skill" via
  // WORKED_EXAMPLE_SOURCE_TYPES in adapter/retrieval-expansion.ts.
  async function maybeFileWorkedExample(args: {
    sid: string
    subagentType: string
    description: string
    prompt: string
    output: string
  }): Promise<void> {
    await maybeFileWorkedExampleWithGating({
      sid: args.sid,
      subagentType: args.subagentType,
      description: args.description,
      prompt: args.prompt,
      output: args.output,
      workedExampleFilingEnabled,
      workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
      workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      workedExampleFiledByShape,
      getWorkedExampleClient,
      cfgRaw,
      shouldFileWorkedExample,
      extractWorkedExampleShape,
      shouldSkipWorkedExampleByCooldown,
      buildWorkedExampleEntry,
    })
  }

  // Phase 14 CREATE: record a capability tuple (task shape, tier, outcome) when a
  // routing-tier subagent completes. Best-effort: any failure (MCP down, stamp
  // rejected, dedup hit) degrades to a log line and NEVER throws into the turn.
  // The outcome is derived from the task tool part status — NOT from Phase 7's
  // es-outcome axis (which is human-authoritative and attached to consulted memory
  // nodes, not to units/tiers). This keeps Phase 7's policy intact while giving
  // Phase 14 the unit-level evidence it needs for learned routing.
  async function maybeRecordCapabilityTuple(args: {
    sid: string
    subagentType: string
    description: string
    prompt: string
    status: string
  }): Promise<void> {
    await maybeRecordCapabilityTupleWithGating({
      sid: args.sid,
      subagentType: args.subagentType,
      description: args.description,
      prompt: args.prompt,
      status: args.status,
      capabilityRecordingEnabled,
      capabilityTierBySubagent: CAPABILITY_TIER_BY_SUBAGENT,
      capabilityRecordedBySession,
      getWorkedExampleClient,
      mapTaskStatusToCapabilityOutcome,
      extractWorkedExampleShape,
      buildCapabilityBucketId,
      buildCapabilityCanonicalShape,
    })
  }

  // Phase 16 CREATE: capture the self-reported confidence label from a completed
  // subagent's terminal output and queue it as a PENDING calibration tuple for this
  // session. The tuple (modelId, shapeKey, confidence) is stored session-locally;
  // it becomes a durable es-calibration-outcome edge ONLY when the operator later
  // records an es-outcome for that unit via record_outcome with matching args.
  // No proxy outcome labels are written here — this is capture only.
  async function maybeCaptureCalibrationTuple(args: {
    sid: string
    model?: { providerID: string; modelID: string } | null
    description: string
    prompt: string
    outputText: string
  }): Promise<void> {
    await maybeCaptureCalibrationTupleWithGating({
      sid: args.sid,
      model: args.model ?? null,
      description: args.description,
      prompt: args.prompt,
      outputText: args.outputText,
      calibrationCaptureEnabled,
      pendingCalibrationBySession,
      canonicalModelId,
      extractWorkedExampleShape,
      parseSelfReportedConfidence,
      buildCalibrationBucketId,
    })
  }

  // Phase 15 CREATE (worked-intervention persistence): stamp the prompt patch that
  // BROKE a loop/spiral for this (model, shape) — durable procedural knowledge.
  // Called ONLY from confirmPendingInterventions with evidence of success; never
  // called at nudge time (an attempted nudge is not proof it worked). Best-effort:
  // any failure degrades to a log line and NEVER throws into the turn.
  async function persistWorkedIntervention(args: {
    sid: string
    model?: { providerID: string; modelID: string } | null
    taskText: string
    interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"
    interventionText: string
  }): Promise<void> {
    await persistWorkedInterventionWithGating({
      sid: args.sid,
      model: args.model ?? null,
      taskText: args.taskText,
      interventionLabel: args.interventionLabel,
      interventionText: args.interventionText,
      failureRecordingEnabled,
      canonicalModelId,
      extractWorkedExampleShape,
      failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
      getWorkedExampleClient,
      buildFailurePatchId,
    })
  }

  // Phase 15 CREATE (failure-event recording): record a per-model failure event
  // when a loop/spiral intervention FIRES, attributed to (model, task shape). The
  // model is the deterministic `provider/model` from routing context; if unknown,
  // skip — an unattributable event is worse than no event. The shape reuses
  // Phase 14's extractWorkedExampleShape / buildCapabilityCanonicalShape (the SAME
  // shape function, per spec). Failure events are recorded at event time: the
  // nudge/spiral WAS attempted, and that attempt is a real data point for routing
  // penalties. The intervention TEXT, by contrast, is only durable once proven to
  // have worked — see queuePendingIntervention / confirmPendingInterventions.
  // Best-effort: any failure degrades to a log line and NEVER throws into the turn.
  async function maybeRecordModelFailure(args: {
    sid: string
    model?: { providerID: string; modelID: string } | null
    taskText: string
    event: "spiral" | "loop"
    interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"
    interventionText: string
  }): Promise<void> {
    await maybeRecordModelFailureWithGating({
      sid: args.sid,
      model: args.model ?? null,
      taskText: args.taskText,
      event: args.event,
      interventionLabel: args.interventionLabel,
      interventionText: args.interventionText,
      failureRecordingEnabled,
      failureRecordedBySession,
      canonicalModelId,
      extractWorkedExampleShape,
      buildFailureBucketId,
      getWorkedExampleClient,
      buildCapabilityCanonicalShape,
    })
  }

  // Phase 15 CREATE: queue an attempted intervention patch for later success
  // confirmation. Deduped by key (message id); a new nudge on the same message
  // replaces the pending entry so only the latest wording is confirmable.
  function queuePendingIntervention(sid: string, key: string, label: string, text: string): void {
    queuePendingInterventionWithGating({
      sid,
      key,
      label,
      text,
      failureRecordingEnabled,
      pendingInterventionBySession,
      failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
    })
  }

  // Phase 15 CREATE (success signal): confirm or expire the pending intervention
  // patches for this session and persist the ones with evidence of success.
  // `confirmedKey` is the key whose nudge demonstrably broke the loop/spiral:
  //   - retry / spiral nudges — called from onMessageUpdated when the next
  //     assistant stop is considered complete by issueRetry's own predicates
  //     (subsequent clean completion, no LLM);
  //   - loop-block nudges — called from tool.execute.before when the model's next
  //     tool call has a DIFFERENT signature than the blocked one.
  // Every OTHER pending entry is expired (dropped without persistence): its
  // intervention did not demonstrably work, so it must not become durable
  // procedural knowledge. Best-effort: never throws into the turn.
  async function confirmPendingInterventions(args: {
    sid: string
    confirmedKey?: string
    model?: { providerID: string; modelID: string } | null
    taskText: string
  }): Promise<void> {
    await confirmPendingInterventionsWithGating({
      sid: args.sid,
      confirmedKey: args.confirmedKey,
      model: args.model ?? null,
      taskText: args.taskText,
      failureRecordingEnabled,
      pendingInterventionBySession,
      persistWorkedInterventionWithGating: (a) =>
        persistWorkedInterventionWithGating({
          ...a,
          failureRecordingEnabled,
          canonicalModelId,
          extractWorkedExampleShape,
          failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
          getWorkedExampleClient,
          buildFailurePatchId,
        }),
    })
  }

  // Loop-guard status banner. Emitted HERE, after the consts above are
  // initialized — emitting it earlier is a temporal-dead-zone ReferenceError
  // that throws before the hooks object returns, silently disabling the plugin.
  console.log(
    `[turn-guard] loop guard: ${
      loopGuardEnabled
        ? `ON (aborts a tool call repeated ${loopRepeatThreshold}x with no edit between; max ${loopMaxInterventions} nudges/session)`
        : "OFF (ESHEPHERD_LOOPGUARD_ENABLED=true to opt in)"
    }`,
  )

  console.log(
    `[turn-guard] spiral guard: ${
      spiralGuardEnabled
        ? `ON (nudges a finish=stop turn with >=${spiralInvestigateThreshold} announced-but-unexecuted investigations and no action part; max ${spiralMaxInterventions} nudges/session)`
    : "OFF (ESHEPHERD_SPIRALGUARD_ENABLED=true to opt in)"
     }`,
   )

  // P3-7: structured effective-config echo — single JSON line for programmatic parsing
  console.log(
    `[turn-guard] config=${JSON.stringify({
      retryEnabled,
      maxRetriesPerSession,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      memcoreMaxChars,
      injectionCooldownMs,
      loopGuardEnabled,
      loopRepeatThreshold,
      loopWindowSize,
      loopMaxInterventions,
      taskWatchdogEnabled,
      taskWatchdogThreshold,
      taskWatchdogMaxEscalations,
      taskSerializeTypes: [...taskSerializeTypes],
      taskSerializeCooldownMs,
      workedExampleInjectionEnabled,
      workedExampleSearchTimeoutMs,
      workedExampleFilingEnabled,
      capabilityRecordingEnabled,
      failureRecordingEnabled,
      failurePatchInjectionEnabled,
      spiralInvestigateThreshold,
      spiralReversalThreshold,
      spiralMaxInterventions,
      sourceCaptureVerifyEnabled,
      autoConsolidationEnabled,
      autoConsolidationOnIdle,
      autoConsolidationOnCompact,
      autoConsolidationIdleDelayMs,
      autoConsolidationMessageThreshold,
      autoConsolidationCooldownMs,
      autoConsolidationTimeoutMs,
      autoConsolidationMaxTrackedSessions,
    })}`,
  )

  // --- checkpoint state ---
  // Agents exempt from the end-of-session memory-checkpoint prompt. Config CSV
  // (checkpoint.disabledAgents) overrides; empty falls back to the built-in
  // utility-subagent list above.
  const checkpointDisabledAgents = toLowerSet(
    cfgCSV("checkpoint.disabledAgents").length > 0 ? cfgCSV("checkpoint.disabledAgents") : DEFAULT_CHECKPOINT_DISABLED_AGENTS,
  )
  const checkpointedSessions = new Set<string>()
  // Count only TERMINAL assistant messages, not streaming updates — otherwise a
  // single reply satisfies the "real work" gate within the first turn.
  const terminalCountBySession = new Map<string, number>()
  const memcoreInjectionBySession = new Map<string, { signature: string; at: number; scopeDir: string }>()
  const activeRoutingBySession = new Map<string, {
    agent?: string
    model?: { providerID: string; modelID: string }
  }>()
  const memoryReadSessions = new Set<string>()
  const sourceCaptureBySession = new Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>()
  // Tracks post-compaction mem-core reinjection events per session.
  const compactionPathBySession = new Map<string, { path: "post-compact-fallback"; at: string }>()

  // Shared runtime context for the policy binders. Built once after all config
  // values and per-session Maps above are initialized; the binders read their
  // closure deps from here instead of closing over ~40 separate locals.
  const context: TurnGuardContext = {
    cfgRaw,
    cfgBool,
    cfgNum,
    cfgCSV,
    memcoreInjectEnabled,
    memcoreInjectOnIdle,
    memcoreInjectOnCompacted,
    memcoreInjectOnStart,
    compactArchiveEnabled,
    memcoreMaxChars,
    injectionCooldownMs,
    retryEnabled,
    retryDisabledAgents,
    retryDisabledModes,
    sourceCaptureVerifyEnabled,
    autoConsolidationEnabled,
    autoConsolidationOnIdle,
    autoConsolidationOnCompact,
    autoConsolidationIdleDelayMs,
    autoConsolidationMessageThreshold,
    autoConsolidationCooldownMs,
    autoConsolidationTimeoutMs,
    autoConsolidationMaxTrackedSessions,
    spiralGuardEnabled,
    retriedParentBySession,
    retriesTotalBySession,
    retryChainBySession,
    maxRetriesPerSession,
    startupConfirmedBySession,
    inspectedStopBySession,
    toolWindowBySession,
    loopInterventionsBySession,
    taskWindowBySession,
    taskEscalationsBySession,
    taskRecentLaunchBySession,
    workedExampleFiledByShape,
    loopGuardEnabled,
    loopRepeatThreshold,
    loopWindowSize,
    loopMaxInterventions,
    loopMutationTools,
    loopExemptTools,
    taskWatchdogEnabled,
    taskWatchdogThreshold,
    taskWatchdogMaxEscalations,
    taskSerializeTypes,
    taskSerializeCooldownMs,
    taskSwapQwenMatch,
    taskSwapQwenToProvider,
    taskSwapQwenToModel,
    taskSwapGemmaMatch,
    taskSwapGemmaToProvider,
    taskSwapGemmaToModel,
    taskFallbackProvider,
    taskFallbackModel,
    workedExampleInjectionEnabled,
    workedExampleSearchTimeoutMs,
    workedExampleFilingEnabled,
    capabilityRecordingEnabled,
    failureRecordingEnabled,
    calibrationCaptureEnabled,
    failurePatchInjectionEnabled,
    capabilityRecordedBySession,
    pendingCalibrationBySession,
    failureRecordedBySession,
    pendingInterventionBySession,
    getWorkedExampleClient,
    getRoutingEvidenceClient,
    runtimeEnv,
    rootDirectory,
    projectRoot,
    client,
  }

  // --- auto-consolidation state ---
  // Pending idle-delay timers (cleared/overridden when a new message arrives),
  // last-run timestamps for the cooldown throttle, and a count of new assistant
  // turns since the last run for the volume trigger. A single in-flight flag
  // prevents overlapping background consolidations across all sessions.
  const autoConsolidationPendingTimer = new Map<string, ReturnType<typeof setTimeout>>()
  const autoConsolidationLastRunAt = new Map<string, number>()
  const autoConsolidationMessagesSinceRun = new Map<string, number>()
  let autoConsolidationInFlight = false

  function statusSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      generatedAt: new Date().toISOString(),
      projectRoot,
      rootDirectory,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      retryEnabled,
      retryDisabledAgents: [...retryDisabledAgents],
      retryDisabledModes: [...retryDisabledModes],
      checkpointDisabledAgents: [...checkpointDisabledAgents],
      sourceCaptureVerifyEnabled,
      autoConsolidationEnabled,
      autoConsolidationOnIdle,
      autoConsolidationOnCompact,
      autoConsolidationIdleDelayMs,
      autoConsolidationMessageThreshold,
      autoConsolidationCooldownMs,
      autoConsolidationTimeoutMs,
      sessions: {
        checkpointed: checkpointedSessions.size,
        memcoreInjected: memcoreInjectionBySession.size,
        sourceCaptureTracked: sourceCaptureBySession.size,
      },
      lastCompactionPath: compactionPathBySession.size > 0
        ? Object.fromEntries([...compactionPathBySession.entries()].slice(-10))
        : undefined,
      ...extra,
    }
  }

  async function resolveLoopGuardRouting(sid: string, input: any, output: any): Promise<{
    agent?: string
    model?: { providerID: string; modelID: string }
  }> {
    return resolveLoopGuardRoutingWithGating({
      sid,
      input,
      output,
      getPromptRoutingFromToolHook,
      activeRoutingBySession,
      resolveSessionPromptRouting,
    })
  }

  async function resolveSessionPromptRouting(sid: string): Promise<{
    agent?: string
    model?: { providerID: string; modelID: string }
  }> {
    return resolveSessionPromptRoutingWithGating({
      sid,
      client,
      directory,
      activeRoutingBySession,
      getPromptRouting,
      unwrapListResult,
      sortByCreated,
    })
  }

  async function maybeInjectMemcore(args: {
    sid: string
    event: any
    reason: "idle" | "compacted" | "compacting" | "started"
    messages?: MessageWithParts[]
    anchor?: MessageWithParts | null
    force?: boolean
  }): Promise<boolean> {
    return maybeInjectMemcoreWithGating({
      sid: args.sid,
      event: args.event,
      reason: args.reason,
      messages: args.messages,
      anchor: args.anchor,
      force: args.force,
      rootDirectory,
      projectRoot,
      directory,
      client,
      cfgRaw,
      cfgNum,
      cfgCSV,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      memcoreMaxChars,
      injectionCooldownMs,
      memcoreInjectionBySession,
      statusSnapshot,
    })
  }


  async function verifySourceCapture(sid: string, eventType: string): Promise<void> {
    return verifySourceCaptureWithGating({
      sid,
      eventType,
      projectRoot,
      sourceCaptureVerifyEnabled,
      sourceCaptureBySession,
      runSourceCaptureCommand,
      cfgRaw,
      cfgNum,
      defaultSourceCaptureTimeoutMs: DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
  }

  // Spawn the deterministic consolidation script in the background. Deterministic
  // (no live mapper) so it never forces a model load. The caller has already set
  // autoConsolidationInFlight and acquired the cross-process lock; this function owns the
  // process lifecycle and is the SOLE place that clears both, via settle().
  //
  // Robustness:
  //   - The default path spawns `node` directly (no shell) so the watchdog can
  //     actually kill the process tree; a user-provided command is free-form and
  //     needs a shell.
  //   - A watchdog kills a run that exceeds autoConsolidationTimeoutMs, so a hung MCP
  //     endpoint can never wedge the in-flight flag permanently.
  //   - settle() is idempotent, so exit/error/timeout racing each other only
  //     clears state once.
  async function runConsolidationCommand(sid: string, trigger: string, onStartFailure?: () => void): Promise<void> {
    return runConsolidationCommandWithGating({
      sid,
      trigger,
      projectRoot,
      eshepherdRoot: ESHEPHERD_ROOT,
      autoConsolidationTimeoutMs,
      setAutoConsolidationInFlight: (value) => { autoConsolidationInFlight = value },
      resolveSessionPromptRouting,
      buildConsolidationEnv,
      buildCommandExecutionPlan,
      spawn,
      appendAutoConsolidationLog,
      releaseAutoConsolidationLock,
      killProcessTree,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
      cfgRaw,
      onStartFailure,
    })
  }

  // Evaluate the opt-in/cooldown/threshold gate and, if it passes, claim the
  // cross-process lock and start a run. State (cooldown stamp, message reset,
  // in-flight) is only stamped once the lock is held, so a run blocked by another
  // process/instance can still fire on a later trigger.
  function evaluateAutoConsolidation(sid: string, trigger: AutoConsolidationTrigger): void {
    return evaluateAutoConsolidationWithGating({
      sid,
      trigger,
      projectRoot,
      autoConsolidationEnabled,
      autoConsolidationCooldownMs,
      autoConsolidationMessageThreshold,
      autoConsolidationTimeoutMs,
      autoConsolidationMaxTrackedSessions,
      autoConsolidationLastRunAt,
      autoConsolidationMessagesSinceRun,
      getAutoConsolidationInFlight: () => autoConsolidationInFlight,
      setAutoConsolidationInFlight: (value) => { autoConsolidationInFlight = value },
      acquireAutoConsolidationLock,
      releaseAutoConsolidationLock,
      runConsolidationCommand,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
  }

  // Arm/replace the idle-delay timer. The timer represents \"stayed quiet for the
  // full delay\"; a new message clears it (see onMessageUpdated) so it is the
  // overridable delay rather than a fixed schedule.
  function armAutoConsolidationIdleTimer(sid: string): void {
    return armAutoConsolidationIdleTimerWithGating({
      sid,
      autoConsolidationEnabled,
      autoConsolidationOnIdle,
      autoConsolidationIdleDelayMs,
      autoConsolidationPendingTimer,
      evaluateAutoConsolidation,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
  }

  // A new message means the session is active again: cancel any pending
  // idle-triggered run and, for terminal assistant turns, advance the volume
  // counter and eagerly evaluate the volume trigger.
  function noteAutoConsolidationActivity(sid: string, info: any): void {
    return noteAutoConsolidationActivityWithGating({
      sid,
      info,
      autoConsolidationEnabled,
      autoConsolidationMaxTrackedSessions,
      autoConsolidationPendingTimer,
      autoConsolidationMessagesSinceRun,
      autoConsolidationLastRunAt,
      evaluateAutoConsolidation,
    })
  }

  // ── LEGACY OPT-IN: auto-retry guard ────────────────────────────────────────────
  // This block compensates for Ollama/LiteLLM returning finish_reason="stop" on
  // turns that still contained structured tool_calls, causing premature agent-loop
  // exit (opencode#20719). With llama-server (or any correctly-signalling backend),
  // finish="stop" and finish="tool-calls" mean what they say.
  //
  // Default: DISABLED (ESHEPHERD_RETRY_ENABLED=true to opt in). When disabled the
  // entire function returns immediately — zero per-message overhead.
  // Retain as an opt-in safety net for providers that still mis-signal.
  // Returns true if a retry prompt was issued.
  const issueRetry = async (
    sid: string,

    last: MessageWithParts,
    prev: MessageWithParts | null,
  ): Promise<boolean> => {
    return issueRetryWithGating({
      sid,
      last,
      prev,
      retryEnabled,
      retryDisabledModes,
      retryDisabledAgents,
      inspectedStopBySession,
      retriedParentBySession,
      retriesTotalBySession,
      retryChainBySession,
      maxRetriesPerSession,
      client,
      directory,
      getPromptRouting,
      confirmPendingInterventions,
      maybeRecordModelFailure,
      queuePendingIntervention,
    })
  }

  // Reactive deliberation-spiral guard. Sibling to issueRetry: retry owns stalls
  // (no useful output / mid-intent); this owns the opposite failure — a finish=stop
  // turn dense with announced-but-unexecuted investigation and zero action parts.
  // Fires independently of retryEnabled.
  const maybeSpiralNudge = async (
    sid: string,

    last: MessageWithParts,
    prev: MessageWithParts | null,
  ): Promise<boolean> => {
    return maybeSpiralNudgeWithGating({
      sid,
      last,
      prev,
      spiralGuardEnabled,
      spiralGuardDisabledModes,
      spiralGuardDisabledAgents,
      spiralExemptProviders,
      spiralExemptModelPrefixes,
      spiralExemptReflection,
      spiralInvestigateThreshold,
      spiralReversalThreshold,
      spiralMaxInterventions,
      spiralNudgedBySession,
      spiralInspectedBySession,
      client,
      directory,
      getPromptRouting,
      maybeRecordModelFailure,
      queuePendingIntervention,
    })
  }

  // Returns true if a checkpoint prompt was issued. Idle-only, once per session,
  // and only on a genuinely complete turn so it never fires over a stall.
  const maybeCheckpoint = async (sid: string, last: MessageWithParts): Promise<boolean> => {

    return maybeCheckpointWithGating({
      sid,
      last,
      checkpointedSessions,
      terminalCountBySession,
      checkpointDisabledAgents,
      client,
      directory,
      getPromptRouting,
    })
  }

  const boundHandlers = bindSessionPolicyHandlers({
    context,
    directory,
    noteAutoConsolidationActivity,
    verifySourceCapture,
    issueRetry,
    maybeSpiralNudge,
    unwrapMessageResult,
    pruneToMax,
    maybeCheckpoint,
    maybeInjectMemcore,
    maybeFileWorkedExamplesFromMessage,
    armAutoConsolidationIdleTimer,
    sortByCreated,
    unwrapListResult,
    evaluateAutoConsolidation,
    statusSnapshot,
    terminalCountBySession,
    activeRoutingBySession,
    memoryReadSessions,
    spiralNudgedBySession,
    spiralInspectedBySession,
    checkpointedSessions,
    memcoreInjectionBySession,
    sourceCaptureBySession,
    compactionPathBySession,
  })

  // Phase 13 CREATE: scan a message for successful task tool completions and file
  // worked examples. The task tool part carries the subagent_type in its input args
  // and the output (the subagent's final text) in its state/output field. We only
  // file when the part indicates success (no error status) and the output is
  // substantive. This runs on session.idle — by then the task has completed and
  // the message parts are finalized.
  async function maybeFileWorkedExamplesFromMessage(sid: string, msg: MessageWithParts): Promise<void> {
    return maybeFileWorkedExamplesFromMessageWithGating({
      sid,
      msg,
      workedExampleFilingEnabled,
      workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
      workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      getActiveModel,
      maybeFileWorkedExampleWithGating: (a) =>
        maybeFileWorkedExampleWithGating({
          ...a,
          workedExampleFilingEnabled,
          workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
          workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
          workedExampleFiledByShape,
          getWorkedExampleClient,
          cfgRaw,
          shouldFileWorkedExample,
          extractWorkedExampleShape,
          shouldSkipWorkedExampleByCooldown,
          buildWorkedExampleEntry,
        }),
      maybeRecordCapabilityTupleWithGating: (a) =>
        maybeRecordCapabilityTupleWithGating({
          ...a,
          capabilityRecordingEnabled,
          capabilityTierBySubagent: CAPABILITY_TIER_BY_SUBAGENT,
          capabilityRecordedBySession,
          getWorkedExampleClient,
          mapTaskStatusToCapabilityOutcome,
          extractWorkedExampleShape,
          buildCapabilityBucketId,
          buildCapabilityCanonicalShape,
        }),
      maybeCaptureCalibrationTupleWithGating: (a) =>
        maybeCaptureCalibrationTupleWithGating({
          ...a,
          calibrationCaptureEnabled,
          pendingCalibrationBySession,
          canonicalModelId,
          extractWorkedExampleShape,
          parseSelfReportedConfidence,
          buildCalibrationBucketId,
        }),
    })
  }


  const hookHeadHandlers = createHookHeadHandlers({
    cfgBool,
    loadPackagedAssets,
    mergeWithoutOverride,
    loadInstructionPaths,
    dedupeAppendInstructions,
    onMessageUpdated: boundHandlers.onMessageUpdated,
    onSessionIdle: boundHandlers.onSessionIdle,
    onSessionCompacted: boundHandlers.onSessionCompacted,
    onSessionStarted: boundHandlers.onSessionStarted,
  })

  const boundToolExecuteBefore = bindToolExecuteBefore({
    context,
    directory,
    computeToolSignature,
    resolveLoopGuardRouting,
    resolveTaskSwapTarget,
    retrieveSimilarWorkedExamples,
    WORKED_EXAMPLE_MAX_INJECT,
    WORKED_EXAMPLE_RELEVANCE_FLOOR,
    formatWorkedExampleDemonstration,
    shouldInjectWorkedExamples,
    canonicalModelId,
    extractWorkedExampleShape,
    buildFailurePatchId,
    CAPABILITY_TIER_BY_SUBAGENT,
    normalizeModelSpec,
    decideCapabilityReroute,
    CAPABILITY_SUBAGENT_BY_TIER,
    CALIBRATION_MIN_HIT_RATE,
    CALIBRATION_OVERRIDE_MIN_SAMPLES,
    parseSelfReportedConfidence,
    buildCalibrationEscalationNote,
    INTERVENTION_REPLAY_HEADING,
    formatInterventionBlock,
    INTERVENTION_REPLAY_MAX_PATCHES,
    confirmPendingInterventions,
    activeRoutingBySession,
    LOOP_GUARD_MARKER,
    maybeRecordModelFailure,
    queuePendingIntervention,
  })


  return {
    config: hookHeadHandlers.config,
    event: hookHeadHandlers.event,
    "tool.execute.before": boundToolExecuteBefore,
    tool: createToolRegistry(),
  } as any
}

export default TurnGuard
