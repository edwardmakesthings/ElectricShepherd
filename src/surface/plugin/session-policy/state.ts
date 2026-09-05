/**
 * Session-policy state initialization for the turn-guard plugin.
 *
 * Builds the config readers (cfgRaw/cfgBool/cfgNum/cfgCSV) and every
 * startup-resolved value + per-session Map/Set that turn-guard.ts used to
 * declare inline. Behavior is identical: same defaults, same config paths,
 * same initial container states, same derived values.
 */

import {
  DEFAULT_MAX_RETRIES_PER_SESSION,
  DEFAULT_MEMCORE_MAX_CHARS,
  DEFAULT_INJECTION_COOLDOWN_MS,
  DEFAULT_RETRY_ENABLED,
  DEFAULT_AUTOCONSOLIDATION_IDLE_DELAY_MS,
  DEFAULT_AUTOCONSOLIDATION_MESSAGE_THRESHOLD,
  DEFAULT_AUTOCONSOLIDATION_COOLDOWN_MS,
  DEFAULT_AUTOCONSOLIDATION_TIMEOUT_MS,
  DEFAULT_AUTOCONSOLIDATION_MAX_TRACKED_SESSIONS,
  DEFAULT_LOOP_GUARD_ENABLED,
  DEFAULT_LOOP_REPEAT_THRESHOLD,
  DEFAULT_LOOP_WINDOW_SIZE,
  DEFAULT_LOOP_MESSAGE_DISTANCE_WINDOW,
  DEFAULT_LOOP_MAX_INTERVENTIONS,
  DEFAULT_LOOP_MUTATION_TOOLS,
  DEFAULT_LOOP_EXEMPT_TOOLS,
  DEFAULT_TASK_WATCHDOG_ENABLED,
  DEFAULT_TASK_WATCHDOG_THRESHOLD,
  DEFAULT_TASK_WATCHDOG_MAX_ESCALATIONS,
  DEFAULT_TASK_SERIALIZE_TYPES,
  DEFAULT_TASK_SERIALIZE_COOLDOWN_MS,
  DEFAULT_TASK_SWAP_QWEN_MATCH,
  DEFAULT_TASK_SWAP_QWEN_TO_MODEL,
  DEFAULT_TASK_SWAP_GEMMA_MATCH,
  DEFAULT_TASK_SWAP_GEMMA_TO_MODEL,
  DEFAULT_WORKED_EXAMPLE_INJECTION_ENABLED,
  DEFAULT_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS,
  DEFAULT_WORKED_EXAMPLE_FILING_ENABLED,
  DEFAULT_CAPABILITY_RECORDING_ENABLED,
  DEFAULT_FAILURE_RECORDING_ENABLED,
  DEFAULT_FAILURE_PATCH_INJECTION_ENABLED,
  DEFAULT_CALIBRATION_CAPTURE_ENABLED,
  DEFAULT_SPIRAL_GUARD_ENABLED,
  DEFAULT_SPIRAL_INVESTIGATE_THRESHOLD,
  DEFAULT_SPIRAL_REVERSAL_THRESHOLD,
  DEFAULT_SPIRAL_MAX_INTERVENTIONS,
  DEFAULT_SPIRAL_EXEMPT_PROVIDERS,
  DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES,
  parseCSV,
  toLowerSet,
} from "./constants.ts"

export interface ConfigReaders {
  cfgRaw: (path: string) => string
  cfgBool: (path: string, fallback: boolean) => boolean
  cfgNum: (path: string, fallback: number) => number
  cfgCSV: (path: string) => string[]
}

export interface SessionPolicyState {
  cfgRaw: ConfigReaders["cfgRaw"]
  cfgBool: ConfigReaders["cfgBool"]
  cfgNum: ConfigReaders["cfgNum"]
  cfgCSV: ConfigReaders["cfgCSV"]

  // ── resolved config values (read once at startup) ─────────────────
  memcoreInjectEnabled: boolean
  memcoreInjectOnIdle: boolean
  memcoreInjectOnCompacted: boolean
  memcoreInjectOnStart: boolean
  compactArchiveEnabled: boolean
  memcoreMaxChars: number
  injectionCooldownMs: number
  retryEnabled: boolean
  retryDisabledAgents: Set<string>
  retryDisabledModes: Set<string>
  sourceCaptureVerifyEnabled: boolean
  autoConsolidationEnabled: boolean
  autoConsolidationOnIdle: boolean
  autoConsolidationOnCompact: boolean
  autoConsolidationIdleDelayMs: number
  autoConsolidationMessageThreshold: number
  autoConsolidationCooldownMs: number
  autoConsolidationTimeoutMs: number
  autoConsolidationMaxTrackedSessions: number

  // ── retry state ───────────────────────────────────────────────────
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  maxRetriesPerSession: number
  startupConfirmedBySession: Set<string>
  inspectedStopBySession: Map<string, Set<string>>

  // ── loop guard state ──────────────────────────────────────────────
  toolWindowBySession: Map<string, Array<{ signature: string; atMessage: number }>>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
  loopInterventionsBySession: Map<string, number>
  taskWindowBySession: Map<string, string[]>
  taskEscalationsBySession: Map<string, number>
  taskRecentLaunchBySession: Map<string, Map<string, number>>
  workedExampleFiledByShape: Map<string, Map<string, number>>
  loopGuardEnabled: boolean
  loopRepeatThreshold: number
  loopWindowSize: number
  loopMessageDistanceWindow: number
  loopMaxInterventions: number
  loopMutationTools: Set<string>
  loopExemptTools: Set<string>
  taskWatchdogEnabled: boolean
  taskWatchdogThreshold: number
  taskWatchdogMaxEscalations: number
  taskSerializeTypes: Set<string>
  taskSerializeCooldownMs: number
  taskSwapQwenMatch: string
  taskSwapQwenToProvider: string
  taskSwapQwenToModel: string
  taskSwapGemmaMatch: string
  taskSwapGemmaToProvider: string
  taskSwapGemmaToModel: string
  taskFallbackProvider: string
  taskFallbackModel: string

  // ── worked-example / capability / failure / calibration config ────
  workedExampleInjectionEnabled: boolean
  workedExampleSearchTimeoutMs: number
  workedExampleFilingEnabled: boolean
  capabilityRecordingEnabled: boolean
  failureRecordingEnabled: boolean
  calibrationCaptureEnabled: boolean
  failurePatchInjectionEnabled: boolean
  capabilityRecordedBySession: Map<string, Set<string>>
  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>
  failureRecordedBySession: Map<string, Set<string>>
  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>

  // ── spiral guard state ────────────────────────────────────────────
  spiralGuardEnabled: boolean
  spiralInvestigateThreshold: number
  spiralReversalThreshold: number
  spiralMaxInterventions: number
  spiralExemptReflection: boolean
  spiralGuardDisabledModes: Set<string>
  spiralGuardDisabledAgents: Set<string>
  spiralExemptProviders: Set<string>
  spiralExemptModelPrefixes: Set<string>
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
}

export function buildConfigReaders(valuesByPath: any): ConfigReaders {
  const cfgRaw = (path: string): string => {
    const parts = path.split(".").filter(Boolean)
    let node: any = valuesByPath
    for (const part of parts) {
      if (!node || typeof node !== "object") return ""
      node = node?.[part]
    }
    if (typeof node === "undefined" || node === null) return ""
    return String(node)
  }
  const cfgBool = (path: string, fallback: boolean): boolean => {
    const raw = cfgRaw(path).trim().toLowerCase()
    if (!raw) return fallback
    if (["1", "true", "yes", "on"].includes(raw)) return true
    if (["0", "false", "no", "off"].includes(raw)) return false
    return fallback
  }
  const cfgNum = (path: string, fallback: number): number => {
    const raw = Number(cfgRaw(path))
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
  }
  const cfgCSV = (path: string): string[] => parseCSV(cfgRaw(path))
  return { cfgRaw, cfgBool, cfgNum, cfgCSV }
}

export function initSessionPolicyState(valuesByPath: any): SessionPolicyState {
  const { cfgRaw, cfgBool, cfgNum, cfgCSV } = buildConfigReaders(valuesByPath)

  // --- resolved config values (read once at startup) ---
  const memcoreInjectEnabled = cfgBool("memcore.reinject.enabled", false)
  const memcoreInjectOnIdle = cfgBool("memcore.reinject.onIdle", false)
  const memcoreInjectOnCompacted = cfgBool("memcore.reinject.onCompact", false)
  const memcoreInjectOnStart = cfgBool("memcore.reinject.onStart", false)
  // Post-compaction transcript archiver: on session.compacted, read back the full
  // session log (compaction RETAINS prior messages — verified against the SDK:
  // session.messages returns them, delimited by summary:true/agent:compaction
  // markers) and write the just-compacted region to a durable file so the facts
  // the summary dropped are not lost. Default ON; ESHEPHERD_COMPACT_ARCHIVE=false
  // to disable. Declared with the other env reads, above every use.
  const compactArchiveEnabled = cfgBool("compaction.archiveEnabled", true)
  const memcoreMaxChars = cfgNum("memcore.maxChars", DEFAULT_MEMCORE_MAX_CHARS)
  const injectionCooldownMs = cfgNum("memcore.injectionCooldownMs", DEFAULT_INJECTION_COOLDOWN_MS)
  const retryEnabled = cfgBool("retry.enabled", DEFAULT_RETRY_ENABLED)
  const retryDisabledAgents = toLowerSet(cfgCSV("retry.disabledAgents"))
  const retryDisabledModes = toLowerSet(cfgCSV("retry.disabledModes"))
  const sourceCaptureVerifyEnabled = cfgBool("sourceCapture.verifyEnabled", true)
  // Automatic consolidation ("consolidate in the background"): ON by default.
  // It triggers memory writes in the background, throttled by the idle delay,
  // message threshold, and cooldown below — so "on" means "occasionally," not
  // "every turn." Set ESHEPHERD_AUTO_CONSOLIDATION_ENABLED=false to opt out
  // (e.g. ad-hoc opencode runs on machines where background writes are unwanted).
  const autoConsolidationEnabled = cfgBool("consolidation.auto.enabled", true)
  const autoConsolidationOnIdle = cfgBool("consolidation.auto.onIdle", true)
  const autoConsolidationOnCompact = cfgBool("consolidation.auto.onCompact", true)
  const autoConsolidationIdleDelayMs = cfgNum("consolidation.auto.idleDelayMs", DEFAULT_AUTOCONSOLIDATION_IDLE_DELAY_MS)
  const autoConsolidationMessageThreshold = cfgNum("consolidation.auto.messageThreshold", DEFAULT_AUTOCONSOLIDATION_MESSAGE_THRESHOLD)
  const autoConsolidationCooldownMs = cfgNum("consolidation.auto.cooldownMs", DEFAULT_AUTOCONSOLIDATION_COOLDOWN_MS)
  const autoConsolidationTimeoutMs = cfgNum("commands.autoConsolidation.timeoutMs", DEFAULT_AUTOCONSOLIDATION_TIMEOUT_MS)
  const autoConsolidationMaxTrackedSessions = cfgNum("consolidation.auto.maxTrackedSessions", DEFAULT_AUTOCONSOLIDATION_MAX_TRACKED_SESSIONS)

  // --- retry state ---
  // Allow one follow-up retry when the first retry still ends mid-intent,
  // while keeping a strict cap to avoid loops.
  const retriedParentBySession = new Map<string, Map<string, number>>()
  // Total auto-retries issued per session (see DEFAULT_MAX_RETRIES_PER_SESSION):
  // a keying-independent hard stop so a persistent stall cannot loop unbounded.
  const retriesTotalBySession = new Map<string, number>()
  // Chain counter: increments on each retry issued for a session, resets to 0
  // when a turn is consideredComplete or a real (non-injected) user message arrives.
  // This is the authoritative bound against runaway retry chains where per-parent
  // keying shifts every generation.
  const retryChainBySession = new Map<string, number>()
  const maxRetriesPerSession = Math.max(
    1,
    cfgNum("retry.maxRetriesPerSession", DEFAULT_MAX_RETRIES_PER_SESSION),
  )
  const startupConfirmedBySession = new Set<string>()
  const inspectedStopBySession = new Map<string, Set<string>>()

  // --- loop guard state ---
  // Recent tool-call signatures per session (oldest first), cleared by any
  // mutating tool and by each intervention (so the nudge gets a clean slate).
  const toolWindowBySession = new Map<string, Array<{ signature: string; atMessage: number }>>()
  const messageCountBySession = new Map<string, number>()
  const lastCountedMessageIdBySession = new Map<string, string>()
  const loopInterventionsBySession = new Map<string, number>()
  const taskWindowBySession = new Map<string, string[]>()
  const taskEscalationsBySession = new Map<string, number>()
  const taskRecentLaunchBySession = new Map<string, Map<string, number>>()
  // In-session dedup — shapeKey → timestamp of last filed example.
  // Prevents filing near-duplicate worked examples for the same problem shape.
  const workedExampleFiledByShape = new Map<string, Map<string, number>>()
  const loopGuardEnabled = cfgBool("loopGuard.enabled", DEFAULT_LOOP_GUARD_ENABLED)
  const loopRepeatThreshold = cfgNum("loopGuard.repeatThreshold", DEFAULT_LOOP_REPEAT_THRESHOLD)
  const loopWindowSize = cfgNum("loopGuard.windowSize", DEFAULT_LOOP_WINDOW_SIZE)
  const loopMessageDistanceWindow = cfgNum("loopGuard.messageDistanceWindow", DEFAULT_LOOP_MESSAGE_DISTANCE_WINDOW)
  const loopMaxInterventions = cfgNum("loopGuard.maxInterventions", DEFAULT_LOOP_MAX_INTERVENTIONS)
  const loopMutationTools = toLowerSet(
    cfgCSV("loopGuard.mutationTools").length > 0
      ? cfgCSV("loopGuard.mutationTools")
      : DEFAULT_LOOP_MUTATION_TOOLS,
  )
  const loopExemptTools = toLowerSet([
    ...DEFAULT_LOOP_EXEMPT_TOOLS,
    ...cfgCSV("loopGuard.exemptTools"),
  ])
  const taskWatchdogEnabled = cfgBool("taskWatchdog.enabled", DEFAULT_TASK_WATCHDOG_ENABLED)
  const taskWatchdogThreshold = cfgNum("taskWatchdog.repeatThreshold", DEFAULT_TASK_WATCHDOG_THRESHOLD)
  const taskWatchdogMaxEscalations = cfgNum("taskWatchdog.maxEscalations", DEFAULT_TASK_WATCHDOG_MAX_ESCALATIONS)
  const taskSerializeCsv = cfgCSV("taskWatchdog.serializeTypes")
  const taskSerializeTypes = toLowerSet(
    taskSerializeCsv.length > 0 ? taskSerializeCsv : DEFAULT_TASK_SERIALIZE_TYPES,
  )
  const taskSerializeCooldownMs = cfgNum("taskWatchdog.serializeCooldownMs", DEFAULT_TASK_SERIALIZE_COOLDOWN_MS)
  const taskSwapQwenMatch = String(
    cfgRaw("taskWatchdog.swap.qwen.match") || DEFAULT_TASK_SWAP_QWEN_MATCH,
  )
    .trim()
    .toLowerCase()
  const taskSwapQwenToProvider = String(cfgRaw("taskWatchdog.swap.qwen.toProvider") || "").trim()
  const taskSwapQwenToModel = String(
    cfgRaw("taskWatchdog.swap.qwen.toModel") || DEFAULT_TASK_SWAP_QWEN_TO_MODEL,
  ).trim()
  const taskSwapGemmaMatch = String(
    cfgRaw("taskWatchdog.swap.gemma.match") || DEFAULT_TASK_SWAP_GEMMA_MATCH,
  )
    .trim()
    .toLowerCase()
  const taskSwapGemmaToProvider = String(cfgRaw("taskWatchdog.swap.gemma.toProvider") || "").trim()
  const taskSwapGemmaToModel = String(
    cfgRaw("taskWatchdog.swap.gemma.toModel") || DEFAULT_TASK_SWAP_GEMMA_TO_MODEL,
  ).trim()
  const taskFallbackProvider = String(cfgRaw("taskWatchdog.fallback.provider") || "").trim()
  const taskFallbackModel = String(cfgRaw("taskWatchdog.fallback.model") || "").trim()

  // Worked-example injection: config + lazy palace client.
  const workedExampleInjectionEnabled = cfgBool(
    "taskWatchdog.workedExampleInjection.enabled",
    DEFAULT_WORKED_EXAMPLE_INJECTION_ENABLED,
  )
  const workedExampleSearchTimeoutMs = cfgNum(
    "taskWatchdog.workedExampleInjection.searchTimeoutMs",
    DEFAULT_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS,
  )
  // Config for filing worked examples on successful subagent completion.
  const workedExampleFilingEnabled = cfgBool(
    "taskWatchdog.workedExampleFiling.enabled",
    DEFAULT_WORKED_EXAMPLE_FILING_ENABLED,
  )
  // Config for recording capability tuples on routing-tier subagent completion.
  const capabilityRecordingEnabled = cfgBool(
    "taskWatchdog.capabilityRecording.enabled",
    DEFAULT_CAPABILITY_RECORDING_ENABLED,
  )
  // Config for recording per-model failure events + interventions.
  const failureRecordingEnabled = cfgBool(
    "taskWatchdog.failureRecording.enabled",
    DEFAULT_FAILURE_RECORDING_ENABLED,
  )
  // Config for capturing self-reported confidence at subagent completion.
  const calibrationCaptureEnabled = cfgBool(
    "taskWatchdog.calibrationCapture.enabled",
    DEFAULT_CALIBRATION_CAPTURE_ENABLED,
  )
  // Config for injecting (model, shape) intervention patches.
  const failurePatchInjectionEnabled = cfgBool(
    "taskWatchdog.failurePatchInjection.enabled",
    DEFAULT_FAILURE_PATCH_INJECTION_ENABLED,
  )
  // Session-local dedup for capability recording — prevents double-recording the
  // same (message, part) on repeated idle events. Keyed by subagentType:shapeKey.
  const capabilityRecordedBySession = new Map<string, Set<string>>()
  // Pending calibration captures keyed by session. Each entry holds
  // the (modelId, shapeKey, confidence) triple parsed from a completed subagent's
  // terminal CONFIDENCE line. These are PENDING — they become durable es-calibration-
  // outcome edges only when the operator records an es-outcome for that unit via
  // record_outcome with matching model_id/task_shape/confidence args. The map is
  // session-scoped and pruned like other per-session state; nothing here writes to
  // the palace directly (no proxy outcome labels).
  const pendingCalibrationBySession = new Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>()
  // Session-local dedup for failure-event recording. Turn-guard
  // events can fire repeatedly in one session (repeated loop nudges on the same
  // model/shape); identical (bucketId, event) pairs are recorded once per session.
  const failureRecordedBySession = new Map<string, Set<string>>()
  // Pending intervention patches awaiting proof of success.
  // An intervention text is NOT durable knowledge the moment it is attempted —
  // only when there is deterministic evidence it actually broke the loop/spiral.
  // Each guard that issues a nudge queues its patch here (keyed by message id);
  // onMessageUpdated later confirms or expires it:
  //   - retry / spiral nudges: confirmed when the next assistant stop for this
  //     session is considered complete by the SAME predicates issueRetry uses
  //     (hasUsefulPayload && !endsMidIntent && (!reviewRequired || hasReview)).
  //     That is the "subsequent clean completion" signal — no LLM, just the
  //     existing turn-guard observable state.
  //   - loop-block nudges: confirmed when the model's next tool call in this
  //     session is a DIFFERENT signature than the one that was blocked (the
  //     guard itself wipes its window after a nudge, so any next non-exempt tool
  //     call is by construction different). Repeating the identical call
  //     expires the pending patch instead.
  // Expired / unconfirmed patches are dropped — failed attempts never persist.
  const pendingInterventionBySession = new Map<string, Array<{ key: string; label: string; text: string }>>()

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

  return {
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
    messageCountBySession,
    lastCountedMessageIdBySession,
    loopInterventionsBySession,
    taskWindowBySession,
    taskEscalationsBySession,
    taskRecentLaunchBySession,
    workedExampleFiledByShape,
    loopGuardEnabled,
    loopRepeatThreshold,
    loopWindowSize,
    loopMessageDistanceWindow,
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
  }
}
