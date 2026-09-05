// @ts-nocheck

import type { MessageWithParts } from "./constants.ts"
import { CHECKPOINT_MARKER, SPIRAL_GUARD_MARKER, AUTO_RETRY_MARKER } from "./constants.ts"
import type { TurnGuardContext } from "./context.ts"
import { getPromptRouting } from "./routing.ts"
import { detectDeliberationSpiral, isDeliberationExemptPrompt } from "../../turn-guard-helpers.ts"
import { getText, hasActionPart, isAssistantStop } from "./analysis.ts"
import { issueRetryWithGating } from "./retry-handler.ts"
import { archiveCompactedRegionWithGating } from "./archive-handler.ts"
import {
  onMessageUpdatedWithGating,
  onSessionIdleWithGating,
  onSessionCompactedWithGating,
  onSessionStartedWithGating,
} from "./event-handlers.ts"

export { issueRetryWithGating } from "./retry-handler.ts"


// turn dense with announced-but-unexecuted investigation and zero action parts.
// Fires independently of retryEnabled.
export async function maybeSpiralNudgeWithGating(args: {
  sid: string
  last: MessageWithParts
  prev: MessageWithParts | null
  spiralGuardEnabled: boolean
  spiralGuardDisabledModes: Set<string>
  spiralGuardDisabledAgents: Set<string>
  spiralExemptProviders: Set<string>
  spiralExemptModelPrefixes: Set<string>
  spiralExemptReflection: boolean
  spiralInvestigateThreshold: number
  spiralReversalThreshold: number
  spiralMaxInterventions: number
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
  client: any
  directory: string
  getPromptRouting: (...candidates: Array<MessageWithParts | null | undefined>) => { agent?: string; model?: { providerID: string; modelID: string } }
  maybeRecordModelFailure: (args: { sid: string; model?: { providerID: string; modelID: string } | null; taskText: string; event: "spiral" | "loop"; interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"; interventionText: string }) => Promise<void>
  queuePendingIntervention: (sid: string, key: string, label: string, text: string) => void
}): Promise<boolean> {
  const { sid, last, prev } = args
  if (!args.spiralGuardEnabled) return false
  if (!isAssistantStop(last)) return false

  const messageID = String(last?.info?.id ?? "")
  if (messageID) {
    const inspected = args.spiralInspectedBySession.get(sid) ?? new Set<string>()
    if (inspected.has(messageID)) return false
    inspected.add(messageID)
    args.spiralInspectedBySession.set(sid, inspected)
  }

  const currentMode = String(last?.info?.mode ?? "").trim().toLowerCase()
  const currentAgent = String(last?.info?.agent ?? "").trim().toLowerCase()
  if (currentMode && args.spiralGuardDisabledModes.has(currentMode)) return false
  if (currentAgent && args.spiralGuardDisabledAgents.has(currentAgent)) return false

  // Cloud models don't spiral the way local models do — skip them by default.
  const spiralRouting = args.getPromptRouting(last, prev)
  const spiralProvider = spiralRouting.model?.providerID?.toLowerCase() ?? ""
  const spiralModelID = spiralRouting.model?.modelID?.toLowerCase() ?? ""
  if (spiralProvider && args.spiralExemptProviders.has(spiralProvider)) return false
  if (
    spiralModelID &&
    Array.from(args.spiralExemptModelPrefixes).some((prefix) => spiralModelID.startsWith(prefix))
  ) {
    return false
  }

  // A reply to any guard prompt is terminal — never guard the guard's own reply.
  const parentText = getText(prev?.parts ?? [])
  if (
    parentText.trimStart().startsWith(SPIRAL_GUARD_MARKER) ||
    parentText.trimStart().startsWith(AUTO_RETRY_MARKER) ||
    parentText.trimStart().startsWith(CHECKPOINT_MARKER)
  ) {
    return false
  }

  // Explicit reflection/explanation asks are supposed to be long and tool-free.
  const prevIsUser = prev?.info?.role === "user"
  if (args.spiralExemptReflection && prevIsUser && isDeliberationExemptPrompt(parentText)) {
    return false
  }

  const text = getText(last.parts ?? [])
  const decision = detectDeliberationSpiral({
    text,
    hasActionPart: hasActionPart(last),
    investigateThreshold: args.spiralInvestigateThreshold,
    reversalThreshold: args.spiralReversalThreshold,
  })
  if (!decision.isSpiral) return false

  const used = args.spiralNudgedBySession.get(sid) ?? 0
  if (used >= args.spiralMaxInterventions) {
    console.log(
      `[turn-guard] spiral guard: budget ${args.spiralMaxInterventions} spent in ${sid}; letting it through`,
    )
    return false
  }
  args.spiralNudgedBySession.set(sid, used + 1)

  console.log(
    `[turn-guard] spiral detected sid=${sid} msg=${messageID || "?"} ` +
      `investigate=${decision.investigateCount} reversal=${decision.reversalCount} ` +
      `nudge=${used + 1}/${args.spiralMaxInterventions}`,
  )

  const routing = spiralRouting
  // Phase 15 CREATE: task text for shape attribution — the real user prompt
  // (prev) when it is a user turn, else this turn's own text. Deterministic and
  // cheap; the shape function tolerates any text.
  const spiralTaskText = prevIsUser ? parentText : text
  const body: any = {
    parts: [
      {
        type: "text",
        text:
          `${SPIRAL_GUARD_MARKER} Your last turn described ${decision.investigateCount} investigations ` +
          `("let me check...", "let me re-read...") but executed none — it reasoned about the code instead of reading it. ` +
          "Stop speculating and gather evidence:\n" +
          "- Take the single most load-bearing \"let me check X\" from that turn and actually call the tool now (read/grep the file, run the command).\n" +
          "- For runtime/ordering/async questions source cannot answer (\"does X fire before Y?\"), add a log or read the library source — do not infer execution order.\n" +
          "- One tool call, then reassess against its real result. Do not narrate another plan without a tool call between.",
      },
    ],
  }
  if (routing.agent) body.agent = routing.agent
  if (routing.model) body.model = routing.model

  await args.client.session.prompt({
    path: { id: sid },
    query: { directory: args.directory },
    body,
  })

  // Phase 15 CREATE: attribute the spiral to (model, shape) at nudge time. The
  // intervention text is only QUEUED — it becomes durable knowledge only if
  // confirmPendingInterventions later proves it worked (the next stop being
  // considered complete by issueRetry's predicates). Fire-and-forget — best-effort.
  void args.maybeRecordModelFailure({
    sid,
    model: routing.model ?? null,
    taskText: spiralTaskText,
    event: "spiral",
    interventionLabel: "spiral-nudge",
    interventionText: String(body.parts[0].text),
  })
  args.queuePendingIntervention(sid, messageID, "spiral-nudge", String(body.parts[0].text))

  return true
}

export { maybeCheckpointWithGating } from "./checkpoint-handler.ts"

export interface SessionPolicyHandlerDeps {
  context: TurnGuardContext
  directory: string
  noteAutoConsolidationActivity: (sid: string, info: any) => void
  verifySourceCapture: (sid: string, eventType: string) => Promise<void>
  issueRetry: (sid: string, last: MessageWithParts, prev: MessageWithParts | null) => Promise<boolean>
  maybeSpiralNudge: (sid: string, last: MessageWithParts, prev: MessageWithParts | null) => Promise<boolean>
  unwrapMessageResult: (res: any) => MessageWithParts | null
  pruneToMax: (collection: Map<string, any> | Set<string>, max: number) => void
  maybeCheckpoint: (sid: string, last: MessageWithParts) => Promise<boolean>
  maybeInjectMemcore: (opts: { sid: string; event: any; reason: "idle" | "compacted" | "compacting" | "started"; messages?: MessageWithParts[]; anchor?: MessageWithParts | null }) => Promise<boolean>
  maybeFileWorkedExamplesFromMessage: (sid: string, msg: MessageWithParts) => Promise<void>
  armAutoConsolidationIdleTimer: (sid: string) => void
  sortByCreated: (messages: MessageWithParts[]) => MessageWithParts[]
  unwrapListResult: (res: any) => MessageWithParts[]
  evaluateAutoConsolidation: (sid: string, trigger: string) => void
  statusSnapshot: (extra?: Record<string, unknown>) => Record<string, unknown>
  terminalCountBySession: Map<string, number>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  memoryReadSessions: Set<string>
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
  checkpointedSessions: Set<string>
  memcoreInjectionBySession: Map<string, { signature: string; at: number; scopeDir: string }>
  sourceCaptureBySession: Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>
  compactionPathBySession: Map<string, { path: "post-compact-fallback"; at: string }>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
}

export function bindSessionPolicyHandlers(deps: SessionPolicyHandlerDeps) {
  const { context } = deps
  return {
    onMessageUpdated(event: any): Promise<void> {
      return onMessageUpdatedWithGating({
        event,
        client: context.client,
        directory: deps.directory,
        projectRoot: context.projectRoot,
        retryChainBySession: context.retryChainBySession,
        retriesTotalBySession: context.retriesTotalBySession,
        startupConfirmedBySession: context.startupConfirmedBySession,
        terminalCountBySession: deps.terminalCountBySession,
        activeRoutingBySession: deps.activeRoutingBySession,
        memoryReadSessions: deps.memoryReadSessions,
        noteAutoConsolidationActivity: deps.noteAutoConsolidationActivity,
        verifySourceCapture: deps.verifySourceCapture,
        issueRetry: deps.issueRetry,
        maybeSpiralNudge: deps.maybeSpiralNudge,
        retryEnabled: context.retryEnabled,
        spiralGuardEnabled: context.spiralGuardEnabled,
        unwrapMessageResult: deps.unwrapMessageResult,
        autoConsolidationMaxTrackedSessions: context.autoConsolidationMaxTrackedSessions,
        pruneToMax: deps.pruneToMax,
        retriedParentBySession: context.retriedParentBySession,
        inspectedStopBySession: context.inspectedStopBySession,
        toolWindowBySession: context.toolWindowBySession,
        messageCountBySession: context.messageCountBySession,
        lastCountedMessageIdBySession: context.lastCountedMessageIdBySession,
        loopInterventionsBySession: context.loopInterventionsBySession,
        taskWindowBySession: context.taskWindowBySession,
        taskEscalationsBySession: context.taskEscalationsBySession,
        taskRecentLaunchBySession: context.taskRecentLaunchBySession,
        workedExampleFiledByShape: context.workedExampleFiledByShape,
        capabilityRecordedBySession: context.capabilityRecordedBySession,
        failureRecordedBySession: context.failureRecordedBySession,
        pendingCalibrationBySession: context.pendingCalibrationBySession,
        pendingInterventionBySession: context.pendingInterventionBySession,
        spiralNudgedBySession: deps.spiralNudgedBySession,
        spiralInspectedBySession: deps.spiralInspectedBySession,
        checkpointedSessions: deps.checkpointedSessions,
        memcoreInjectionBySession: deps.memcoreInjectionBySession,
        sourceCaptureBySession: deps.sourceCaptureBySession,
        compactionPathBySession: deps.compactionPathBySession,
      })
    },

    onSessionIdle(event: any): Promise<void> {
      return onSessionIdleWithGating({
        event,
        client: context.client,
        directory: deps.directory,
        startupConfirmedBySession: context.startupConfirmedBySession,
        retryEnabled: context.retryEnabled,
        issueRetry: deps.issueRetry,
        maybeCheckpoint: deps.maybeCheckpoint,
        maybeInjectMemcore: deps.maybeInjectMemcore,
        maybeFileWorkedExamplesFromMessage: deps.maybeFileWorkedExamplesFromMessage,
        armAutoConsolidationIdleTimer: deps.armAutoConsolidationIdleTimer,
        sortByCreated: deps.sortByCreated,
        unwrapListResult: deps.unwrapListResult,
        autoConsolidationMaxTrackedSessions: context.autoConsolidationMaxTrackedSessions,
        pruneToMax: deps.pruneToMax,
        retriedParentBySession: context.retriedParentBySession,
        retriesTotalBySession: context.retriesTotalBySession,
        retryChainBySession: context.retryChainBySession,
        inspectedStopBySession: context.inspectedStopBySession,
        toolWindowBySession: context.toolWindowBySession,
        messageCountBySession: context.messageCountBySession,
        lastCountedMessageIdBySession: context.lastCountedMessageIdBySession,
        loopInterventionsBySession: context.loopInterventionsBySession,
        taskWindowBySession: context.taskWindowBySession,
        taskEscalationsBySession: context.taskEscalationsBySession,
        taskRecentLaunchBySession: context.taskRecentLaunchBySession,
        workedExampleFiledByShape: context.workedExampleFiledByShape,
        capabilityRecordedBySession: context.capabilityRecordedBySession,
        failureRecordedBySession: context.failureRecordedBySession,
        pendingCalibrationBySession: context.pendingCalibrationBySession,
        pendingInterventionBySession: context.pendingInterventionBySession,
        spiralNudgedBySession: deps.spiralNudgedBySession,
        spiralInspectedBySession: deps.spiralInspectedBySession,
        checkpointedSessions: deps.checkpointedSessions,
        terminalCountBySession: deps.terminalCountBySession,
        memcoreInjectionBySession: deps.memcoreInjectionBySession,
        activeRoutingBySession: deps.activeRoutingBySession,
        sourceCaptureBySession: deps.sourceCaptureBySession,
        compactionPathBySession: deps.compactionPathBySession,
      })
    },

    // Archive helper (internal to the binder): composes archiveCompactedRegionWithGating.
    archiveCompactedRegion(sid: string): Promise<void> {
      return archiveCompactedRegionWithGating({
        sid,
        client: context.client,
        directory: deps.directory,
        projectRoot: context.projectRoot,
        compactArchiveEnabled: context.compactArchiveEnabled,
        sortByCreated: deps.sortByCreated,
        unwrapListResult: deps.unwrapListResult,
        statusSnapshot: deps.statusSnapshot,
      })
    },

    onSessionCompacted(event: any): Promise<void> {
      return onSessionCompactedWithGating({
        event,
        verifySourceCapture: deps.verifySourceCapture,
        archiveCompactedRegion: (sid) =>
          archiveCompactedRegionWithGating({
            sid,
            client: context.client,
            directory: deps.directory,
            projectRoot: context.projectRoot,
            compactArchiveEnabled: context.compactArchiveEnabled,
            sortByCreated: deps.sortByCreated,
            unwrapListResult: deps.unwrapListResult,
            statusSnapshot: deps.statusSnapshot,
          }),
        compactionPathBySession: deps.compactionPathBySession,
        maybeInjectMemcore: deps.maybeInjectMemcore,
        autoConsolidationOnCompact: context.autoConsolidationOnCompact,
        evaluateAutoConsolidation: deps.evaluateAutoConsolidation,
        autoConsolidationMaxTrackedSessions: context.autoConsolidationMaxTrackedSessions,
        pruneToMax: deps.pruneToMax,
        retriedParentBySession: context.retriedParentBySession,
        retriesTotalBySession: context.retriesTotalBySession,
        retryChainBySession: context.retryChainBySession,
        startupConfirmedBySession: context.startupConfirmedBySession,
        inspectedStopBySession: context.inspectedStopBySession,
        toolWindowBySession: context.toolWindowBySession,
        messageCountBySession: context.messageCountBySession,
        lastCountedMessageIdBySession: context.lastCountedMessageIdBySession,
        loopInterventionsBySession: context.loopInterventionsBySession,
        taskWindowBySession: context.taskWindowBySession,
        taskEscalationsBySession: context.taskEscalationsBySession,
        taskRecentLaunchBySession: context.taskRecentLaunchBySession,
        workedExampleFiledByShape: context.workedExampleFiledByShape,
        capabilityRecordedBySession: context.capabilityRecordedBySession,
        failureRecordedBySession: context.failureRecordedBySession,
        pendingCalibrationBySession: context.pendingCalibrationBySession,
        pendingInterventionBySession: context.pendingInterventionBySession,
        spiralNudgedBySession: deps.spiralNudgedBySession,
        spiralInspectedBySession: deps.spiralInspectedBySession,
        checkpointedSessions: deps.checkpointedSessions,
        terminalCountBySession: deps.terminalCountBySession,
        memcoreInjectionBySession: deps.memcoreInjectionBySession,
        activeRoutingBySession: deps.activeRoutingBySession,
        sourceCaptureBySession: deps.sourceCaptureBySession,
      })
    },

    onSessionStarted(event: any): Promise<void> {
      return onSessionStartedWithGating({
        event,
        toolWindowBySession: context.toolWindowBySession,
        messageCountBySession: context.messageCountBySession,
        lastCountedMessageIdBySession: context.lastCountedMessageIdBySession,
        loopInterventionsBySession: context.loopInterventionsBySession,
        activeRoutingBySession: deps.activeRoutingBySession,
        maybeInjectMemcore: deps.maybeInjectMemcore,
      })
    },

  }
}
