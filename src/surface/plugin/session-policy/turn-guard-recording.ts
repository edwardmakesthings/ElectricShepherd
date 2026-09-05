// @ts-nocheck

/**
 * Turn-guard recording + palace-client cluster.
 *
 * Extracted verbatim from turn-guard.ts (AC #2 line-count reduction). Owns the
 * two lazy MCP client factories and every Phase 13/14/15/16 CREATE helper that
 * records worked examples, capability tuples, calibration captures, failure
 * events, and pending/confirmed intervention patches. Behavior and signatures
 * are unchanged: callers still receive the same closures as before; this module
 * just builds them from an explicit deps object instead of the plugin's closure.
 */

import { DEFAULT_MCP_URL, DEFAULT_MCP_TOOL_PREFIX } from "../../../core/runtime-config.ts"
// Substrate transport is constructed ONLY through the core/ seam (Check A2).
import { createSubstrateClient } from "../../../core/substrate-client.ts"
import { SubstrateError, resolveMCPHeadersFromEnv } from "../../../core/mcp-http-client.ts"
import { createMemgraphClient } from "../../../core/memgraph.ts"
import { shouldFileWorkedExample, shouldSkipWorkedExampleByCooldown } from "../../turn-guard-helpers.ts"
import {
  extractWorkedExampleShape,
  buildWorkedExampleEntry,
  WORKED_EXAMPLE_FILE_AGENT_TYPES,
  WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
  CAPABILITY_TIER_BY_SUBAGENT,
  mapTaskStatusToCapabilityOutcome,
  buildCapabilityCanonicalShape,
  buildCapabilityBucketId,
  canonicalModelId,
  buildFailureBucketId,
  buildFailurePatchId,
  FAILURE_PATCH_TEXT_MAX_CHARS,
  parseSelfReportedConfidence,
  buildCalibrationBucketId,
} from "../../../capability/retrieval/retrieval-expansion.ts"
import { maybeFileWorkedExampleWithGating, maybeFileWorkedExamplesFromMessageWithGating } from "./worked-example.ts"
import { persistWorkedInterventionWithGating, maybeRecordModelFailureWithGating, queuePendingInterventionWithGating, confirmPendingInterventionsWithGating } from "./interventions.ts"
import { maybeRecordCapabilityTupleWithGating, maybeCaptureCalibrationTupleWithGating } from "./capability.ts"
import type { MessageWithParts } from "./constants.ts"

export interface RecordingDeps {
  cfgRaw: (path: string) => string
  runtimeEnv: Record<string, string | undefined>
  workedExampleSearchTimeoutMs: number
  workedExampleFilingEnabled: boolean
  capabilityRecordingEnabled: boolean
  failureRecordingEnabled: boolean
  calibrationCaptureEnabled: boolean
  workedExampleFiledByShape: Map<string, Map<string, number>>
  capabilityRecordedBySession: Map<string, Set<string>>
  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>
  failureRecordedBySession: Map<string, Set<string>>
  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>
  getActiveModel: (msg: any) => { providerID: string; modelID: string } | null
}

/**
 * Build the recording/client helper cluster for one plugin instance. All
 * closures share the same lazy client promises and per-session Maps as before
 * the extraction, so observable behavior is identical.
 */
export function createRecordingHelpers(deps: RecordingDeps) {
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
        const mcpURL = String(deps.cfgRaw("mcp.url") || "").trim() || DEFAULT_MCP_URL
        const toolPrefix = String(deps.cfgRaw("mcp.toolPrefix") || "").trim() || DEFAULT_MCP_TOOL_PREFIX
        // Pre-Rung-3 this path resolved headers directly from env with NO loopback
        // strip (it always sent gateway credentials). Pass them explicitly so the
        // core/ seam stays byte-identical to the old behavior.
        const headers = resolveMCPHeadersFromEnv(deps.runtimeEnv)
        // Construct through the core/ seam (Check A2): owns transport + initialize.
        const { client: mcp } = await createSubstrateClient({
          env: deps.runtimeEnv,
          clientName: "electric-shepherd-turn-guard-routing",
          urlOverride: mcpURL,
          headersOverride: headers,
          requestTimeoutMs: deps.workedExampleSearchTimeoutMs,
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
        const mcpURL = String(deps.cfgRaw("mcp.url") || "").trim() || DEFAULT_MCP_URL
        const toolPrefix = String(deps.cfgRaw("mcp.toolPrefix") || "").trim() || DEFAULT_MCP_TOOL_PREFIX
        // Pre-Rung-3 this path resolved headers directly from env with NO loopback
        // strip (it always sent gateway credentials). Pass them explicitly so the
        // core/ seam stays byte-identical to the old behavior.
        const headers = resolveMCPHeadersFromEnv(deps.runtimeEnv)
        // Construct through the core/ seam (Check A2): owns transport + initialize.
        const { client: mcp } = await createSubstrateClient({
          env: deps.runtimeEnv,
          clientName: "electric-shepherd-turn-guard",
          urlOverride: mcpURL,
          headersOverride: headers,
          requestTimeoutMs: deps.workedExampleSearchTimeoutMs,
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
      workedExampleFilingEnabled: deps.workedExampleFilingEnabled,
      workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
      workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      workedExampleFiledByShape: deps.workedExampleFiledByShape,
      getWorkedExampleClient,
      cfgRaw: deps.cfgRaw,
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
      capabilityRecordingEnabled: deps.capabilityRecordingEnabled,
      capabilityTierBySubagent: CAPABILITY_TIER_BY_SUBAGENT,
      capabilityRecordedBySession: deps.capabilityRecordedBySession,
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
      calibrationCaptureEnabled: deps.calibrationCaptureEnabled,
      pendingCalibrationBySession: deps.pendingCalibrationBySession,
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
      failureRecordingEnabled: deps.failureRecordingEnabled,
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
      failureRecordingEnabled: deps.failureRecordingEnabled,
      failureRecordedBySession: deps.failureRecordedBySession,
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
      failureRecordingEnabled: deps.failureRecordingEnabled,
      pendingInterventionBySession: deps.pendingInterventionBySession,
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
      failureRecordingEnabled: deps.failureRecordingEnabled,
      pendingInterventionBySession: deps.pendingInterventionBySession,
      persistWorkedInterventionWithGating: (a) =>
        persistWorkedInterventionWithGating({
          ...a,
          failureRecordingEnabled: deps.failureRecordingEnabled,
          canonicalModelId,
          extractWorkedExampleShape,
          failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
          getWorkedExampleClient,
          buildFailurePatchId,
        }),
    })
  }

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
      workedExampleFilingEnabled: deps.workedExampleFilingEnabled,
      workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
      workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      getActiveModel: deps.getActiveModel,
      maybeFileWorkedExampleWithGating: (a) =>
        maybeFileWorkedExampleWithGating({
          ...a,
          workedExampleFilingEnabled: deps.workedExampleFilingEnabled,
          workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
          workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
          workedExampleFiledByShape: deps.workedExampleFiledByShape,
          getWorkedExampleClient,
          cfgRaw: deps.cfgRaw,
          shouldFileWorkedExample,
          extractWorkedExampleShape,
          shouldSkipWorkedExampleByCooldown,
          buildWorkedExampleEntry,
        }),
      maybeRecordCapabilityTupleWithGating: (a) =>
        maybeRecordCapabilityTupleWithGating({
          ...a,
          capabilityRecordingEnabled: deps.capabilityRecordingEnabled,
          capabilityTierBySubagent: CAPABILITY_TIER_BY_SUBAGENT,
          capabilityRecordedBySession: deps.capabilityRecordedBySession,
          getWorkedExampleClient,
          mapTaskStatusToCapabilityOutcome,
          extractWorkedExampleShape,
          buildCapabilityBucketId,
          buildCapabilityCanonicalShape,
        }),
      maybeCaptureCalibrationTupleWithGating: (a) =>
        maybeCaptureCalibrationTupleWithGating({
          ...a,
          calibrationCaptureEnabled: deps.calibrationCaptureEnabled,
          pendingCalibrationBySession: deps.pendingCalibrationBySession,
          canonicalModelId,
          extractWorkedExampleShape,
          parseSelfReportedConfidence,
          buildCalibrationBucketId,
        }),
    })
  }

  return {
    getRoutingEvidenceClient,
    getWorkedExampleClient,
    maybeFileWorkedExample,
    maybeRecordCapabilityTuple,
    maybeCaptureCalibrationTuple,
    persistWorkedIntervention,
    maybeRecordModelFailure,
    queuePendingIntervention,
    confirmPendingInterventions,
    maybeFileWorkedExamplesFromMessage,
  }
}
