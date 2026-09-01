/**
 * TurnGuardContext — the shared runtime state passed to every policy module.
 *
 * Built once in turn-guard.ts (the thin adapter) and threaded into each
 * extracted function group so they can read config, mutate per-session Maps,
 * and call lazy client factories without closing over the outer scope.
 */

export interface TurnGuardContext {
  // ── config readers ────────────────────────────────────────────────
  cfgRaw: (path: string) => string
  cfgBool: (path: string, fallback: boolean) => boolean
  cfgNum: (path: string, fallback: number) => number
  cfgCSV: (path: string) => string[]

  // ── resolved config values (read once at startup) ─────────────────
  memcoreInjectEnabled: boolean
  memcoreInjectOnIdle: boolean
  memcoreInjectOnCompacted: boolean
  memcoreInjectOnStart: boolean
  precompactProbeEnabled: boolean
  compactArchiveEnabled: boolean
  compactPromptOverrideEnabled: boolean
  memcoreMaxChars: number
  injectionCooldownMs: number
  retryEnabled: boolean
  retryDisabledAgents: Set<string>
  retryDisabledModes: Set<string>
  consolidationWriteGuardEnabled: boolean
  sourceCaptureVerifyEnabled: boolean
  autoConsolidationEnabled: boolean
  autoConsolidationOnIdle: boolean
  autoConsolidationOnCompact: boolean
  autoConsolidationIdleDelayMs: number
  autoConsolidationMessageThreshold: number
  autoConsolidationCooldownMs: number
  autoConsolidationTimeoutMs: number
  autoConsolidationMaxTrackedSessions: number
  allowedConsolidationWriters: Set<string>

  // ── retry state ───────────────────────────────────────────────────
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  maxRetriesPerSession: number
  startupConfirmedBySession: Set<string>
  inspectedStopBySession: Map<string, Set<string>>

  // ── loop guard state ──────────────────────────────────────────────
  toolWindowBySession: Map<string, string[]>
  loopInterventionsBySession: Map<string, number>
  taskWindowBySession: Map<string, string[]>
  taskEscalationsBySession: Map<string, number>
  taskRecentLaunchBySession: Map<string, Map<string, number>>
  workedExampleFiledByShape: Map<string, Map<string, number>>
  loopGuardEnabled: boolean
  loopRepeatThreshold: number
  loopWindowSize: number
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

  // ── lazy client factories ─────────────────────────────────────────
  getWorkedExampleClient: () => Promise<any>
  getRoutingEvidenceClient: () => Promise<any>

  // ── runtime env + paths ───────────────────────────────────────────
  runtimeEnv: Record<string, string | undefined>
  rootDirectory: string
  projectRoot: string

  // ── opencode client (for session.prompt calls) ────────────────────
  client: any
}
