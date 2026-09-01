// @ts-nocheck


import {
  WORKED_EXAMPLE_FILE_AGENT_TYPES, WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS, CAPABILITY_TIER_BY_SUBAGENT,
  buildCapabilityBucketId, buildCapabilityCanonicalShape, buildFailureBucketId, buildFailurePatchId,
  buildWorkedExampleEntry, canonicalModelId, clipText, computeMemcoreSignature, decideAutoConsolidation,
  decideMemcoreInjection, detectDeliberationSpiral, extractWorkedExampleShape, isDeliberationExemptPrompt,
  mapTaskStatusToCapabilityOutcome, parseSelfReportedConfidence, pruneAutoConsolidationTracking,
  shouldFileWorkedExample, shouldSkipWorkedExampleByCooldown,
} from "../../adapter/retrieval-expansion.ts"
import {
  buildCommandExecutionPlan,
} from "../../adapter/turn-guard-helpers.ts"
import type { AutoConsolidationTrigger, MemcoreInjectionRecord } from "../../adapter/turn-guard-helpers.ts"
import { existsSync, mkdirSync, writeFileSync, spawn } from "node:fs"
import { dirname, join } from "node:path"
import {
  AUTO_RETRY_MARKER, CHECKPOINT_MARKER, MEMCORE_REINJECT_MARKER, WRITE_AUTHORITY_MARKER,
  MIN_USEFUL_TEXT, MAX_RETRIES_PER_PARENT, DEFAULT_MAX_RETRIES_PER_SESSION, STATUS_DIR, STATUS_FILE,
  AUTOCONSOLIDATION_LOG_FILE, MEMCORE_CONTEXT_LOG_FILE, MEMORY_USAGE_LOG_FILE, EVENT_LOG_FILE,
  TURN_GUARD_INSTANCE_DIRS_KEY, TURN_GUARD_INSTANCE_RESET_KEY, DEFAULT_MEMCORE_MAX_CHARS,
  DEFAULT_MEMCORE_MAX_SCOPES, DEFAULT_INJECTION_COOLDOWN_MS, DEFAULT_RETRY_ENABLED, LOOP_GUARD_MARKER,
  DEFAULT_LOOP_GUARD_ENABLED, DEFAULT_LOOP_REPEAT_THRESHOLD, DEFAULT_LOOP_WINDOW_SIZE,
  DEFAULT_LOOP_MAX_INTERVENTIONS, DEFAULT_TASK_WATCHDOG_ENABLED, DEFAULT_TASK_WATCHDOG_THRESHOLD,
  DEFAULT_TASK_WATCHDOG_MAX_ESCALATIONS, DEFAULT_TASK_SERIALIZE_TYPES, DEFAULT_TASK_SERIALIZE_COOLDOWN_MS,
  DEFAULT_TASK_SWAP_QWEN_MATCH, DEFAULT_TASK_SWAP_QWEN_TO_MODEL, DEFAULT_TASK_SWAP_GEMMA_MATCH,
  DEFAULT_TASK_SWAP_GEMMA_TO_MODEL, DEFAULT_WORKED_EXAMPLE_INJECTION_ENABLED,
  DEFAULT_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS, DEFAULT_WORKED_EXAMPLE_FILING_ENABLED,
  DEFAULT_CAPABILITY_RECORDING_ENABLED, DEFAULT_FAILURE_RECORDING_ENABLED,
  DEFAULT_CALIBRATION_CAPTURE_ENABLED, DEFAULT_FAILURE_PATCH_INJECTION_ENABLED,
  CALIBRATION_OVERRIDE_MIN_SAMPLES, CALIBRATION_MIN_HIT_RATE, INTERVENTION_REPLAY_MAX_PATCHES,
  DEFAULT_LOOP_MUTATION_TOOLS, DEFAULT_LOOP_EXEMPT_TOOLS,
  SPIRAL_GUARD_MARKER, DEFAULT_SPIRAL_GUARD_ENABLED, DEFAULT_SPIRAL_INVESTIGATE_THRESHOLD,
  DEFAULT_SPIRAL_REVERSAL_THRESHOLD, DEFAULT_SPIRAL_MAX_INTERVENTIONS, DEFAULT_SPIRAL_EXEMPT_PROVIDERS,
  DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES, DEFAULT_ALLOWED_CONSOLIDATION_WRITERS,
  CONSOLIDATION_WRITE_TOOL_NAMES, DEFAULT_AUTOCONSOLIDATION_IDLE_DELAY_MS,
  DEFAULT_AUTOCONSOLIDATION_MESSAGE_THRESHOLD, DEFAULT_AUTOCONSOLIDATION_COOLDOWN_MS,
  DEFAULT_AUTOCONSOLIDATION_TIMEOUT_MS, AUTOCONSOLIDATION_LOCK_FILE,
  DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS, DEFAULT_MEMCORE_LOADER_TIMEOUT_MS,
  DEFAULT_AUTOCONSOLIDATION_MAX_TRACKED_SESSIONS, MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT,
  CHECKPOINT_MODES, DEFAULT_CHECKPOINT_DISABLED_AGENTS, ESHEPHERD_ROOT,
} from "./constants.ts"
import { toLowerSet } from "./constants.ts"
import {
  findSessionID, resolveScopeDirFromEvent, extractPathFromMessageParts, findProjectRoot,
  writeStatusFile, appendAutoConsolidationLog, appendMemcoreContextLog, appendMemoryUsageLog,
  acquireAutoConsolidationLock, releaseAutoConsolidationLock, killProcessTree, loadMemcoreMarkdown,
  getToolNames, containsConsolidationWriteTool, getAgentIdentity, classifyMemoryTools,
  runSourceCaptureCommand, getText, hasUsefulPayload, hasFinalReviewSignal, hasActionPart,
  isCapabilityQuestion, endsMidIntent, isAssistantStop, isAssistantToolCallFinish,
  isSerenaMemoryToolTurn, partTypes, sortByCreated, unwrapListResult, unwrapMessageResult,
  getActiveModel, getActiveAgent, getPromptRouting, normalizeModelSpec, resolveTaskSwapTarget,
  getPromptRoutingFromToolHook, pruneToMax,
} from "./pure-helpers.ts"
import type { MessageWithParts } from "./constants.ts"

// ── module-level state (per-instance, initialized by the adapter) ──────────────
const spiralNudgedBySession = new Map<string, number>()
const spiralInspectedBySession = new Map<string, Set<string>>()
const checkpointDisabledAgents = toLowerSet(DEFAULT_CHECKPOINT_DISABLED_AGENTS)
const checkpointedSessions = new Set<string>()
const terminalCountBySession = new Map<string, number>()
const memcoreInjectionBySession = new Map<string, { signature: string; at: number; scopeDir: string }>()
const activeRoutingBySession = new Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>()
const warnedConsolidationWriteMessageIDs = new Set<string>()
const memoryReadSessions = new Set<string>()
const sourceCaptureBySession = new Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>()
const compactionPathBySession = new Map<string, { path: "post-compact-fallback"; at: string }>()
const autoConsolidationPendingTimer = new Map<string, ReturnType<typeof setTimeout>>()
const autoConsolidationLastRunAt = new Map<string, number>()
const autoConsolidationMessagesSinceRun = new Map<string, number>()

export async function maybeFileWorkedExample(args: {
  sid: string
  subagentType: string
  description: string
  prompt: string
  output: string
}): Promise<void> {
  const { sid, subagentType, description, prompt, output } = args

  const isTargetSubagentType = WORKED_EXAMPLE_FILE_AGENT_TYPES.has(subagentType)
  if (
    !shouldFileWorkedExample({
      enabled: workedExampleFilingEnabled,
      isTargetSubagentType,
      output,
      minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
    })
  ) {
    return
  }
  const trimmedOutput = String(output || "").trim()

  // Gate 3: in-session near-duplicate suppression by shape key.
  const shape = extractWorkedExampleShape(`${description}\n${prompt}`)
  const filedBySession = workedExampleFiledByShape.get(sid) ?? new Map<string, number>()
  const nowMs = Date.now()
  const lastFiledAt = Number(filedBySession.get(shape.shapeKey) ?? 0)
  if (shouldSkipWorkedExampleByCooldown({ nowMs, lastFiledAtMs: lastFiledAt, cooldownMs: 30 * 60 * 1000 })) {
    console.log(
      `[turn-guard] worked-example filing: skipping near-duplicate shape ${shape.shapeKey} ` +
        `(filed ${Math.round((nowMs - lastFiledAt) / 1000)}s ago) sid=${sid}`,
    )
    return
  }

  const entry = buildWorkedExampleEntry({ subagentType, description, output: trimmedOutput, shape })
  const wing = String(cfgRaw("memory.projectWing") || "").trim() || "opencode"
  const room = "apprenticeship"

  try {
    const palaceClient = await getWorkedExampleClient()
    if (!palaceClient || typeof palaceClient.diaryWrite !== "function") return

    // File the worked example.
    const writeResult: any = await palaceClient.diaryWrite({
      wing,
      room,
      entry,
      agent_name: "turn-guard",
      topic: `worked-example-${subagentType}`,
    })
    if (!writeResult?.ok) {
      console.log(
        `[turn-guard] worked-example filing: diary_write failed (${writeResult?.kind ?? "unknown"}): ${String(writeResult?.detail ?? writeResult)} sid=${sid}`
      )
      return
    }
    const result = writeResult.value

    // Stamp es-source-type: worked-example via kg_add (best-effort — a stamp
    // failure does not invalidate the filed example; absence of stamp is not a
    // rejection on the CONSUME side).
    const drawerId = String(result?.drawer_id ?? result?.id ?? "").trim()
    if (drawerId && typeof palaceClient.kgAdd === "function") {
      const stampResult: any = await palaceClient.kgAdd({
        subject: drawerId,
        predicate: "es-source-type",
        object: "worked-example",
        source_closet: drawerId,
      })
      if (!stampResult?.ok) {
        console.log(
          `[turn-guard] worked-example filing: stamp failed (non-fatal; ${stampResult?.kind ?? "unknown"}): ${String(stampResult?.detail ?? stampResult)} sid=${sid}`
        )
      }
    }

    // Record the filing for in-session dedup.
    filedBySession.set(shape.shapeKey, nowMs)
    workedExampleFiledByShape.set(sid, filedBySession)

    console.log(
      `[turn-guard] worked-example filing: filed ${subagentType} example ` +
        `(shape=${shape.workClass}/${shape.shapeKey}, drawer=${drawerId || "?"}) sid=${sid}`,
    )
  } catch (err) {
    // Filing failure must never break the turn.
    console.log(`[turn-guard] worked-example filing: failed, continuing: ${String(err)}`)
  }
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
  if (!capabilityRecordingEnabled) return
  const { sid, subagentType, description, prompt, status } = args

  // Gate 1: only routing tiers are recorded (utility/analysis subagents skipped).
  const tier = CAPABILITY_TIER_BY_SUBAGENT[subagentType]
  if (!tier) return

  // Gate 2: closed outcome set — unknown statuses are skipped, not guessed.
  const outcome = mapTaskStatusToCapabilityOutcome(status)
  if (!outcome) return

  // Gate 3: session-local dedup — same (message, part) must not double-record on
  // repeated idle events. Keyed by subagentType + shapeKey (the part's identity
  // within the message is stable across idle passes for the same completion).
  const shape = extractWorkedExampleShape(`${description}\n${prompt}`)
  const dedupKey = `${subagentType}:${shape.shapeKey}`
  const recordedBySession = capabilityRecordedBySession.get(sid) ?? new Set<string>()
  if (recordedBySession.has(dedupKey)) {
    console.log(
      `[turn-guard] capability recording: skipping duplicate ${dedupKey} sid=${sid}`,
    )
    return
  }

  const bucketId = buildCapabilityBucketId(shape.shapeKey, tier)
  const canonicalShape = buildCapabilityCanonicalShape(shape)

  try {
    const palaceClient = await getWorkedExampleClient()
    if (!palaceClient || typeof palaceClient.kgAdd !== "function") return

    // Record the outcome edge (the core of the capability tuple).
    const outcomeResult: any = await palaceClient.kgAdd({
      subject: bucketId,
      predicate: "es-capability-outcome",
      object: outcome,
      valid_from: new Date().toISOString(),
      source_closet: bucketId,
    })
    if (!outcomeResult?.ok) {
      console.log(
        `[turn-guard] capability recording: failed (${outcomeResult?.kind ?? "unknown"}): ${String(outcomeResult?.detail ?? outcomeResult)} sid=${sid}`
      )
      return
    }

    // Best-effort shape metadata for explainability (one-time per bucket; a
    // duplicate stamp is harmless and idempotent on the read side).
    const shapeResult: any = await palaceClient.kgAdd({
      subject: bucketId,
      predicate: "es-capability-shape",
      object: canonicalShape.slice(0, 200),
      source_closet: bucketId,
    })
    if (!shapeResult?.ok) {
      console.log(
        `[turn-guard] capability recording: shape stamp failed (non-fatal; ${shapeResult?.kind ?? "unknown"}): ${String(shapeResult?.detail ?? shapeResult)} sid=${sid}`
      )
    }
    const tierResult: any = await palaceClient.kgAdd({
      subject: bucketId,
      predicate: "es-capability-tier",
      object: tier,
      source_closet: bucketId,
    })
    if (!tierResult?.ok) {
      console.log(
        `[turn-guard] capability recording: tier stamp failed (non-fatal; ${tierResult?.kind ?? "unknown"}): ${String(tierResult?.detail ?? tierResult)} sid=${sid}`
      )
    }

    // Record the dedup key for this session.
    recordedBySession.add(dedupKey)
    capabilityRecordedBySession.set(sid, recordedBySession)

    console.log(
      `[turn-guard] capability recording: recorded ${subagentType} -> ${tier} (${outcome}) ` +
        `(shape=${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}, bucket=${bucketId}) sid=${sid}`,
    )
  } catch (err) {
    // Recording failure must never break the turn.
    console.log(`[turn-guard] capability recording: failed, continuing: ${String(err)}`)
  }
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
  if (!calibrationCaptureEnabled) return
  const { sid, model, description, prompt, outputText } = args

  // Gate 1: deterministic model identity — unknown model => skip (no guessing).
  const modelId = canonicalModelId(model?.providerID, model?.modelID)
  if (!modelId) return

  // Gate 2: shape from the SAME Phase 14/13 shape function.
  const shape = extractWorkedExampleShape(`${description}\n${prompt}`)

  // Gate 3: parse the self-reported confidence from the terminal output.
  // Returns null when no CONFIDENCE line is present — skip, don't guess.
  const confidence = parseSelfReportedConfidence(outputText)
  if (!confidence) return

  // Queue the pending tuple for this session. Dedup: same (modelId, shapeKey, confidence)
  // is recorded once per session (repeated idle events on the same completion).
  const pending = pendingCalibrationBySession.get(sid) ?? []
  const dedupKey = `${modelId}:${shape.shapeKey}:${confidence}`
  if (pending.some((p) => `${p.modelId}:${p.shapeKey}:${p.confidence}` === dedupKey)) return

  pending.push({ modelId, shapeKey: shape.shapeKey, confidence })
  pendingCalibrationBySession.set(sid, pending)

  console.log(
    `[turn-guard] calibration capture: queued ${modelId} / ${shape.shapeKey} / ${confidence} ` +
      `(bucket=${buildCalibrationBucketId(modelId, shape.shapeKey, confidence)}) sid=${sid}`,
  )
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
  if (!failureRecordingEnabled) return
  const { sid, model, taskText, interventionLabel, interventionText } = args

  // Gate 1: deterministic model identity — unknown model => skip (no guessing).
  const modelId = canonicalModelId(model?.providerID, model?.modelID)
  if (!modelId) return

  // Gate 2: shape from the SAME Phase 14/13 shape function.
  const shape = extractWorkedExampleShape(taskText)
  const text = String(interventionText || "").trim().slice(0, FAILURE_PATCH_TEXT_MAX_CHARS)
  if (!text) return

  try {
    const palaceClient = await getWorkedExampleClient()
    if (palaceClient && typeof palaceClient.kgAdd === "function") {
      const patchId = buildFailurePatchId(modelId, shape.shapeKey, interventionLabel)
      const labelResult: any = await palaceClient.kgAdd({
        subject: patchId,
        predicate: "es-intervention-label",
        object: interventionLabel,
        source_closet: patchId,
      })
      if (!labelResult?.ok) {
        console.log(
          `[turn-guard] failure recording: intervention failed (${labelResult?.kind ?? "unknown"}): ${String(labelResult?.detail ?? labelResult)} sid=${sid}`
        )
        return
      }
      const textResult: any = await palaceClient.kgAdd({
        subject: patchId,
        predicate: "es-intervention-text",
        object: text,
        source_closet: patchId,
      })
      if (!textResult?.ok) {
        console.log(
          `[turn-guard] failure recording: intervention failed (${textResult?.kind ?? "unknown"}): ${String(textResult?.detail ?? textResult)} sid=${sid}`
        )
        return
      }
      console.log(
        `[turn-guard] failure recording: WORKED intervention ${interventionLabel} persisted ` +
          `for ${modelId} (shape=${shape.shapeKey}, patch=${patchId}) sid=${sid}`,
      )
    }
  } catch (err) {
    // Intervention recording failure must never break the turn.
    console.log(`[turn-guard] failure recording: intervention failed, continuing: ${String(err)}`)
  }
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
  if (!failureRecordingEnabled) return
  const { sid, model, taskText, event } = args

  // Gate 1: deterministic model identity — unknown model => skip (no guessing).
  const modelId = canonicalModelId(model?.providerID, model?.modelID)
  if (!modelId) return

  // Gate 2: shape from the SAME Phase 14/13 shape function.
  const shape = extractWorkedExampleShape(taskText)

  // Gate 3: session-local dedup — repeated identical (bucket, event) in one
  // session records once (the pattern is already captured; a second nudge on the
  // same bucket adds nothing to the count).
  const bucketId = buildFailureBucketId(modelId, shape.shapeKey)
  const dedupKey = `${bucketId}:${event}`
  const recordedBySession = failureRecordedBySession.get(sid) ?? new Set<string>()
  if (recordedBySession.has(dedupKey)) {
    console.log(
      `[turn-guard] failure recording: skipping duplicate ${dedupKey} sid=${sid}`,
    )
    return
  }

  try {
    const palaceClient = await getWorkedExampleClient()
    if (palaceClient && typeof palaceClient.kgAdd === "function") {
      const eventResult: any = await palaceClient.kgAdd({
        subject: bucketId,
        predicate: "es-failure-event",
        object: event,
        valid_from: new Date().toISOString(),
        source_closet: bucketId,
      })
      if (!eventResult?.ok) {
        console.log(
          `[turn-guard] failure recording: event failed (${eventResult?.kind ?? "unknown"}): ${String(eventResult?.detail ?? eventResult)} sid=${sid}`
        )
        return
      }
      // Best-effort shape metadata for explainability (idempotent on the read side).
      const shapeResult: any = await palaceClient.kgAdd({
        subject: bucketId,
        predicate: "es-failure-shape",
        object: buildCapabilityCanonicalShape(shape).slice(0, 200),
        source_closet: bucketId,
      })
      if (!shapeResult?.ok) {
        console.log(
          `[turn-guard] failure recording: shape stamp failed (non-fatal; ${shapeResult?.kind ?? "unknown"}): ${String(shapeResult?.detail ?? shapeResult)} sid=${sid}`
        )
      }
      recordedBySession.add(dedupKey)
      failureRecordedBySession.set(sid, recordedBySession)
      console.log(
        `[turn-guard] failure recording: recorded ${event} for ${modelId} ` +
          `(shape=${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}, bucket=${bucketId}) sid=${sid}`,
      )
    }
  } catch (err) {
    // Recording failure must never break the turn.
    console.log(`[turn-guard] failure recording: event failed, continuing: ${String(err)}`)
  }
}

// Phase 15 CREATE: queue an attempted intervention patch for later success
// confirmation. Deduped by key (message id); a new nudge on the same message
// replaces the pending entry so only the latest wording is confirmable.
function queuePendingIntervention(sid: string, key: string, label: string, text: string): void {
  if (!failureRecordingEnabled) return
  const t = String(text || "").trim().slice(0, FAILURE_PATCH_TEXT_MAX_CHARS)
  if (!t) return
  const list = pendingInterventionBySession.get(sid) ?? []
  const next = list.filter((p) => p.key !== key)
  next.push({ key, label, text: t })
  // Bound the queue: at most one pending entry per guard site (3 sites), so a
  // pathological session cannot grow this unbounded.
  while (next.length > 6) next.shift()
  pendingInterventionBySession.set(sid, next)
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
  if (!failureRecordingEnabled) return
  const { sid, confirmedKey, model, taskText } = args
  const list = pendingInterventionBySession.get(sid) ?? []
  if (list.length === 0) return
  const confirmed = confirmedKey ? list.filter((p) => p.key === confirmedKey) : []
  const expired = list.filter((p) => !confirmedKey || p.key !== confirmedKey)
  pendingInterventionBySession.delete(sid)
  for (const entry of expired) {
    console.log(
      `[turn-guard] failure recording: intervention ${entry.label} NOT proven to work — expired, not persisted sid=${sid}`,
    )
  }
  if (confirmed.length === 0) return
  for (const entry of confirmed) {
    try {
      await persistWorkedIntervention({
        sid,
        model: model ?? null,
        taskText,
        interventionLabel: entry.label as "spiral-nudge" | "retry-nudge" | "loop-block",
        interventionText: entry.text,
      })
    } catch (err) {
      console.log(`[turn-guard] failure recording: confirm failed, continuing: ${String(err)}`)
    }
  }
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

// --- deliberation-spiral guard state ---
const spiralGuardEnabled = cfgBool("spiralGuard.enabled", DEFAULT_SPIRAL_GUARD_ENABLED)
const spiralInvestigateThreshold = cfgNum("spiralGuard.investigateThreshold", DEFAULT_SPIRAL_INVESTIGATE_THRESHOLD)
const spiralReversalThreshold = cfgNum("spiralGuard.reversalThreshold", DEFAULT_SPIRAL_REVERSAL_THRESHOLD)
const spiralMaxInterventions = cfgNum("spiralGuard.maxInterventions", DEFAULT_SPIRAL_MAX_INTERVENTIONS)
const spiralExemptReflection = cfgBool("spiralGuard.exemptReflection", true)
const spiralGuardDisabledModes = toLowerSet(cfgCSV("spiralGuard.disabledModes"))
const spiralGuardDisabledAgents = toLowerSet(cfgCSV("spiralGuard.disabledAgents"))
const spiralExemptProviders = toLowerSet(
  cfgCSV("spiralGuard.exemptProviders").concat(DEFAULT_SPIRAL_EXEMPT_PROVIDERS),
)
const spiralExemptModelPrefixes = toLowerSet(
  cfgCSV("spiralGuard.exemptModelPrefixes").concat(
    DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES,
  ),
)
// Nudges issued per session, and message IDs already inspected (message.updated
// can fire repeatedly for one message; dedupe so a stop is judged once).
const spiralNudgedBySession = new Map<string, number>()
const spiralInspectedBySession = new Map<string, Set<string>>()
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
    consolidationWriteGuardEnabled,
    sourceCaptureVerifyEnabled,
    autoConsolidationEnabled,
    autoConsolidationOnIdle,
    autoConsolidationOnCompact,
    autoConsolidationIdleDelayMs,
    autoConsolidationMessageThreshold,
    autoConsolidationCooldownMs,
    autoConsolidationTimeoutMs,
    autoConsolidationMaxTrackedSessions,
    allowedConsolidationWriters: [...allowedConsolidationWriters],
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
const warnedConsolidationWriteMessageIDs = new Set<string>()
const memoryReadSessions = new Set<string>()
const sourceCaptureBySession = new Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>()
// Tracks post-compaction mem-core reinjection events per session.
const compactionPathBySession = new Map<string, { path: "post-compact-fallback"; at: string }>()

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
    consolidationWriteGuardEnabled,
    sourceCaptureVerifyEnabled,
    autoConsolidationEnabled,
    autoConsolidationOnIdle,
    autoConsolidationOnCompact,
    autoConsolidationIdleDelayMs,
    autoConsolidationMessageThreshold,
    autoConsolidationCooldownMs,
    autoConsolidationTimeoutMs,
    allowedConsolidationWriters: [...allowedConsolidationWriters],
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
  const fromHook = getPromptRoutingFromToolHook(input, output)
  const cached = activeRoutingBySession.get(sid) ?? {}
  let agent = fromHook.agent || cached.agent
  let model = fromHook.model || cached.model

  if (agent && model) {
    return { agent, model }
  }

  const fromSession = await resolveSessionPromptRouting(sid)
  if (!agent) agent = fromSession.agent
  if (!model) model = fromSession.model

  const resolved: {
    agent?: string
    model?: { providerID: string; modelID: string }
  } = {}
  if (agent) resolved.agent = agent
  if (model) resolved.model = model
  if (resolved.agent || resolved.model) {
    activeRoutingBySession.set(sid, resolved)
  }
  return resolved
}

async function resolveSessionPromptRouting(sid: string): Promise<{
  agent?: string
  model?: { providerID: string; modelID: string }
}> {
  const cached = activeRoutingBySession.get(sid) ?? {}
  let agent = cached.agent
  let model = cached.model

  if (agent && model) {
    return { agent, model }
  }

  try {
    const res: any = await client.session.messages({
      path: { id: sid },
      query: { directory },
    })
    const messages = sortByCreated(unwrapListResult(res))
    const tail = messages[messages.length - 1] ?? null
    const previous = messages.length > 1 ? messages[messages.length - 2] : null
    const fromSession = getPromptRouting(tail, previous)

    if (!agent) agent = fromSession.agent
    if (!model) model = fromSession.model
  } catch {
    // best-effort: keep hook/cached routing only
  }

  const resolved: {
    agent?: string
    model?: { providerID: string; modelID: string }
  } = {}
  if (agent) resolved.agent = agent
  if (model) resolved.model = model
  if (resolved.agent || resolved.model) {
    activeRoutingBySession.set(sid, resolved)
  }
  return resolved
}

async function maybeInjectMemcore(args: {
  sid: string
  event: any
  reason: "idle" | "compacted" | "started"
  messages?: MessageWithParts[]
  anchor?: MessageWithParts | null
  force?: boolean
}): Promise<boolean> {
  // Rung 2 (R2-05): every gating refusal must be observable. A silent `return false`
  // made disabled reinjection indistinguishable from "nothing happened" in the
  // status/context logs; each refusal now records an explicit `because` reason.
  if (!memcoreInjectEnabled) {
    appendMemcoreContextLog(projectRoot, {
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      injected: false,
      because: "reinject-disabled",
    })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      injected: false,
      because: "reinject-disabled",
    }))
    return false
  }
  const perReasonFlag =
    args.reason === "idle" ? memcoreInjectOnIdle
    : args.reason === "compacted" ? memcoreInjectOnCompacted
    : memcoreInjectOnStart
  if (!perReasonFlag) {
    appendMemcoreContextLog(projectRoot, {
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      injected: false,
      because: `reinject-${args.reason}-disabled`,
    })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      injected: false,
      because: `reinject-${args.reason}-disabled`,
    }))
    return false
  }


  let scopeDir = resolveScopeDirFromEvent(args.event, rootDirectory, cfgRaw("memcore.scopeDir"))
  const pathFromMessages = extractPathFromMessageParts(args.messages || [])
  if (pathFromMessages) {
    scopeDir = existsSync(pathFromMessages) && !pathFromMessages.endsWith(".md") && !pathFromMessages.endsWith(".ts")
      ? pathFromMessages
      : dirname(pathFromMessages)
  }

  const { markdown, loaderInfo } = await loadMemcoreMarkdown(projectRoot, scopeDir, {
    maxScopes: cfgNum("memcore.maxScopes", DEFAULT_MEMCORE_MAX_SCOPES),
    directFileName: cfgRaw("memcore.directFileName") || "memory.md",
    storeRoots: cfgCSV("memcore.storeRoots").length > 0 ? cfgCSV("memcore.storeRoots") : [".electric-shepherd/memory"],
    timeoutMs: cfgNum("commands.memcoreLoader.timeoutMs", DEFAULT_MEMCORE_LOADER_TIMEOUT_MS),
  })
  if (!markdown) {
    appendMemcoreContextLog(projectRoot, {
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: false,
      because: "no-memcore-markdown",
    })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: false,
      because: "no-memcore-markdown",
      loaderInfo,
    }))
    return false
  }

  // R2-04: the ENTIRE injected payload (marker + intro + render) must fit within
  // memcore.maxChars. Budget the fixed prelude out of maxChars before clipping so
  // the final text respects the configured budget end-to-end, not just the render.
  const reinjectPrelude =
    `${MEMCORE_REINJECT_MARKER} Refreshing scoped mem-core for this session (reason=${args.reason}). ` +
    `Use this as the currently active resident memory for scope: ${scopeDir}. ` +
    "This is derived render output from derived memory; do not hand-edit mem-core files.\n\n"
  const clipped = clipText(markdown, Math.max(0, memcoreMaxChars - reinjectPrelude.length))
  const signature = computeMemcoreSignature(scopeDir, clipped)
  const now = Date.now()
  const previous = memcoreInjectionBySession.get(args.sid)
  const { shouldInject } = decideMemcoreInjection({
    scopeDir,
    signature,
    now,
    previous,
    cooldownMs: injectionCooldownMs,
    force: args.force,
  })

  if (!shouldInject) {
    appendMemcoreContextLog(projectRoot, {
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: false,
      signature,
      because: "dedup-or-cooldown-skip",
    })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: false,
      signature,
      because: "dedup-or-cooldown-skip",
      loaderInfo,
    }))
    return false
  }

  try {
    const routing = getPromptRouting(args.anchor)
    const body: any = {
      parts: [
        {
          type: "text",
          text: reinjectPrelude + clipped,
        },
      ],
    }
    if (routing.agent) body.agent = routing.agent
    if (routing.model) body.model = routing.model

    await client.session.prompt({
      path: { id: args.sid },
      query: { directory },
      body,
    })

    memcoreInjectionBySession.set(args.sid, { signature, at: now, scopeDir })
    appendMemcoreContextLog(projectRoot, {
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: true,
      signature,
      chars: clipped.length,
      preview: clipText(clipped, 1800),
    })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: true,
      signature,
      loaderInfo,
    }))
    console.log(`[turn-guard] mem-core re-injected sid=${args.sid} reason=${args.reason} scope=${scopeDir}`)
    return true
  } catch (err) {
    appendMemcoreContextLog(projectRoot, {
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: false,
      signature,
      because: "injection-error",
      error: String(err),
    })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "memcore-reinject",
      sid: args.sid,
      reason: args.reason,
      scopeDir,
      injected: false,
      signature,
      because: "injection-error",
      error: String(err),
      loaderInfo,
    }))
    console.error(`[turn-guard] failed mem-core re-injection sid=${args.sid}:`, err)
    return false
  }
}

async function maybeWarnWriteAuthority(sid: string, msg: MessageWithParts): Promise<boolean> {
  if (!consolidationWriteGuardEnabled) return false

  const msgID = String(msg?.info?.id ?? "")
  if (msgID && warnedConsolidationWriteMessageIDs.has(msgID)) return false

  const toolNames = getToolNames(msg)
  if (toolNames.length === 0 || !containsConsolidationWriteTool(toolNames)) return false

  const actor = getAgentIdentity(msg)
  const authorized = allowedConsolidationWriters.has(actor)
  if (authorized) return false

  if (msgID) warnedConsolidationWriteMessageIDs.add(msgID)
  const namesJoined = toolNames.join(", ")
  console.log(`[turn-guard] write-authority alert sid=${sid} actor=${actor || "unknown"} tools=${namesJoined}`)

  writeStatusFile(projectRoot, statusSnapshot({
    type: "write-authority",
    sid,
    actor,
    authorized,
    toolNames,
    messageID: msgID || undefined,
  }))

  try {
    const routing = getPromptRouting(msg)
    const body: any = {
      parts: [
        {
          type: "text",
          text:
            `${WRITE_AUTHORITY_MARKER} derived memory write tools are restricted to dreamer agents (` +
            `${[...allowedConsolidationWriters].join(", ")}). ` +
            `This turn attempted: ${namesJoined}. ` +
            "Do not call add_drawer/update_drawer/kg_add/kg_invalidate/apply_merge from interactive build/plan flows unless this is an explicit consolidation pass. " +
            "Use diary_write for ordinary findings and reserve derived-memory writes for dreamer consolidation.",
        },
      ],
    }
    if (routing.agent) body.agent = routing.agent
    if (routing.model) body.model = routing.model

    await client.session.prompt({
      path: { id: sid },
      query: { directory },
      body,
    })
  } catch (err) {
    console.error("[turn-guard] failed write-authority prompt:", err)
  }
  return true
}

async function verifySourceCapture(sid: string, eventType: string): Promise<void> {
  if (!sourceCaptureVerifyEnabled) return

  const result = await runSourceCaptureCommand(projectRoot, sid, eventType, {
    command: cfgRaw("commands.sourceCapture.command"),
    timeoutMs: cfgNum("commands.sourceCapture.timeoutMs", DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS),
  })
  const prev = sourceCaptureBySession.get(sid)
  const next = {
    totalEvents: Number(prev?.totalEvents || 0) + 1,
    lastEvent: eventType,
    lastAt: new Date().toISOString(),
    lastSuccess: result.ok,
  }
  sourceCaptureBySession.set(sid, next)

  writeStatusFile(projectRoot, statusSnapshot({
    type: "source-capture-verify",
    sid,
    eventType,
    capture: result,
    sessionCaptureState: next,
  }))

  if (!result.attempted) {
    console.log("[turn-guard] source transcript capture verification: command not configured and default script not found")
  }
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
  const configured = cfgRaw("commands.autoConsolidation.command")
  const startedAt = new Date().toISOString()
  console.log(`[turn-guard] auto-consolidation start sid=${sid} trigger=${trigger}`)
  writeStatusFile(projectRoot, statusSnapshot({ type: "auto-consolidation-start", sid, trigger, startedAt }))

  let settled = false
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const settle = (status: Record<string, unknown>, startFailure = false) => {
    if (settled) return
    settled = true
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    autoConsolidationInFlight = false
    releaseAutoConsolidationLock(projectRoot)
    // A run that never actually started should not consume the cooldown, so a
    // later trigger can retry promptly. A run that started and then failed/timed
    // out keeps the cooldown (anti-thrash).
    if (startFailure) {
      try {
        onStartFailure?.()
      } catch (err) {
        console.error("[turn-guard] auto-consolidation start-failure rollback failed:", err)
      }
    }
    writeStatusFile(projectRoot, statusSnapshot({ ...status, finishedAt: new Date().toISOString() }))
    appendAutoConsolidationLog(
      projectRoot,
      `${new Date().toISOString()} [finish] sid=${sid} trigger=${trigger} status=${JSON.stringify(status)}`,
    )
  }

  try {
    const routing = await resolveSessionPromptRouting(sid)
    const childEnv = {
      ...process.env,
      ESHEPHERD_SESSION_ID: sid,
      ESHEPHERD_EVENT_TYPE: `auto-consolidation:${trigger}`,
      // The plugin already holds the shared lock; tell the child runner not to
      // re-acquire (or release) it so the plugin->script handoff doesn't
      // deadlock against itself. Standalone cron/n8n runs lack this flag and
      // take the lock themselves.
      ESHEPHERD_CONSOLIDATION_LOCK_INHERITED: "1",
      // cwd is the plugin install; the consumer project owns the memory artifacts.
      ESHEPHERD_PROJECT_ROOT: projectRoot,
      ESHEPHERD_ACTIVE_AGENT: routing.agent,
      ESHEPHERD_ACTIVE_MODEL_PROVIDER_ID: routing.model?.providerID,
      ESHEPHERD_ACTIVE_MODEL_ID: routing.model?.modelID,
    }
    // detached:true makes the child a process-group leader on POSIX so the
    // watchdog can kill the entire tree (see killProcessTree); harmless on
    // Windows where taskkill /T handles the tree instead.
    const detached = process.platform !== "win32"
    const plan = buildCommandExecutionPlan({
      configured,
      projectRoot: ESHEPHERD_ROOT,
      defaultScript: join(ESHEPHERD_ROOT, "scripts", "run-memory-consolidation-and-validation.ts"),
      // Absolute: a relative path would resolve against the plugin install, where nothing reads it.
      memcoreFile: join(projectRoot, STATUS_DIR, "memory", "memory.md"),
    })

    if (plan.mode === "rejected") {
      console.error(`[turn-guard] auto-consolidation rejected unsafe command: ${plan.reason}`)
      settle({ type: "auto-consolidation-rejected", sid, trigger, reason: plan.reason }, true)
      return
    }

    const logPath = join(projectRoot, STATUS_DIR, AUTOCONSOLIDATION_LOG_FILE)
    appendAutoConsolidationLog(
      projectRoot,
      `${new Date().toISOString()} [start] sid=${sid} trigger=${trigger} command=${plan.command} args=${JSON.stringify(plan.args)} logPath=${logPath}`,
    )

    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      detached,
    })

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk ?? "").trim()
      if (!text) return
      appendAutoConsolidationLog(projectRoot, `${new Date().toISOString()} [stdout] sid=${sid} ${text}`)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk ?? "").trim()
      if (!text) return
      appendAutoConsolidationLog(projectRoot, `${new Date().toISOString()} [stderr] sid=${sid} ${text}`)
    })

    watchdog = setTimeout(() => {
      console.error(
        `[turn-guard] auto-consolidation timeout sid=${sid} trigger=${trigger} after ${autoConsolidationTimeoutMs}ms; killing`,
      )
      killProcessTree(child)
      settle({ type: "auto-consolidation-timeout", sid, trigger, timeoutMs: autoConsolidationTimeoutMs })
    }, autoConsolidationTimeoutMs)
    watchdog.unref?.()

    child.on("error", (err: unknown) => {
      console.error("[turn-guard] auto-consolidation spawn error:", err)
      settle({ type: "auto-consolidation-error", sid, trigger, error: String(err) }, true)
    })
    child.on("exit", (code: number | null) => {
      console.log(`[turn-guard] auto-consolidation finished sid=${sid} trigger=${trigger} code=${String(code)}`)
      settle({ type: "auto-consolidation-finish", sid, trigger, exitCode: code })
    })
    child.unref?.()
  } catch (err) {
    console.error("[turn-guard] auto-consolidation failed to start:", err)
    settle({ type: "auto-consolidation-error", sid, trigger, error: String(err) }, true)
  }
}

// Evaluate the opt-in/cooldown/threshold gate and, if it passes, claim the
// cross-process lock and start a run. State (cooldown stamp, message reset,
// in-flight) is only stamped once the lock is held, so a run blocked by another
// process/instance can still fire on a later trigger.
function evaluateAutoConsolidation(sid: string, trigger: AutoConsolidationTrigger): void {
  const messagesSinceRun = autoConsolidationMessagesSinceRun.get(sid) ?? 0
  const decision = decideAutoConsolidation({
    enabled: autoConsolidationEnabled,
    now: Date.now(),
    lastRunAt: autoConsolidationLastRunAt.get(sid) ?? null,
    cooldownMs: autoConsolidationCooldownMs,
    messagesSinceRun,
    messageThreshold: autoConsolidationMessageThreshold,
    trigger,
    inFlight: autoConsolidationInFlight,
  })

  if (!decision.shouldRun) {
    if (autoConsolidationEnabled) {
      console.log(
        `[turn-guard] auto-consolidation skip sid=${sid} trigger=${trigger} reason=${decision.reason} msgsSince=${messagesSinceRun}`,
      )
    }
    return
  }

  // Claim the cross-process lock before stamping any state. If another instance
  // (or n8n/cron) is mid-run, skip without consuming the cooldown so a later
  // trigger can retry.
  if (!acquireAutoConsolidationLock(projectRoot, { sid, trigger: decision.reason }, autoConsolidationTimeoutMs)) {
    console.log(`[turn-guard] auto-consolidation skip sid=${sid} trigger=${trigger} reason=locked`)
    writeStatusFile(projectRoot, statusSnapshot({ type: "auto-consolidation-skip", sid, trigger, reason: "locked" }))
    return
  }

  autoConsolidationInFlight = true
  const previousLastRunAt = autoConsolidationLastRunAt.get(sid) ?? null
  autoConsolidationLastRunAt.set(sid, Date.now())
  autoConsolidationMessagesSinceRun.set(sid, 0)
  pruneAutoConsolidationTracking(autoConsolidationMessagesSinceRun, autoConsolidationLastRunAt, autoConsolidationMaxTrackedSessions)
  // If the run never actually starts, undo the cooldown stamp so the next
  // trigger can retry immediately instead of waiting out a phantom cooldown.
  runConsolidationCommand(sid, decision.reason, () => {
    if (previousLastRunAt === null) autoConsolidationLastRunAt.delete(sid)
    else autoConsolidationLastRunAt.set(sid, previousLastRunAt)
  }).catch((err) => {
    console.error("[turn-guard] auto-consolidation trigger failed:", err)
    autoConsolidationInFlight = false
    releaseAutoConsolidationLock(projectRoot)
  })
}

// Arm/replace the idle-delay timer. The timer represents \"stayed quiet for the
// full delay\"; a new message clears it (see onMessageUpdated) so it is the
// overridable delay rather than a fixed schedule.
function armAutoConsolidationIdleTimer(sid: string): void {
  if (!autoConsolidationEnabled || !autoConsolidationOnIdle) return
  const existing = autoConsolidationPendingTimer.get(sid)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    autoConsolidationPendingTimer.delete(sid)
    evaluateAutoConsolidation(sid, "idle-timer")
  }, autoConsolidationIdleDelayMs)
  timer.unref?.()
  autoConsolidationPendingTimer.set(sid, timer)
  writeStatusFile(projectRoot, statusSnapshot({ type: "auto-consolidation-armed", sid, idleDelayMs: autoConsolidationIdleDelayMs }))
}

// A new message means the session is active again: cancel any pending
// idle-triggered run and, for terminal assistant turns, advance the volume
// counter and eagerly evaluate the volume trigger.
function noteAutoConsolidationActivity(sid: string, info: any): void {
  if (!autoConsolidationEnabled) return
  const pending = autoConsolidationPendingTimer.get(sid)
  if (pending) {
    clearTimeout(pending)
    autoConsolidationPendingTimer.delete(sid)
  }
  if (info?.role === "assistant" && info?.finish) {
    autoConsolidationMessagesSinceRun.set(sid, (autoConsolidationMessagesSinceRun.get(sid) ?? 0) + 1)
    pruneAutoConsolidationTracking(autoConsolidationMessagesSinceRun, autoConsolidationLastRunAt, autoConsolidationMaxTrackedSessions)
    evaluateAutoConsolidation(sid, "volume")
  }
}

