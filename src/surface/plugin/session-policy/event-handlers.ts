// @ts-nocheck

// Domain category: session event handlers (onMessageUpdated/onSessionIdle/
// onSessionCompacted/onSessionStarted *WithGating*).
// Extracted from handlers.ts verbatim.

import type { MessageWithParts } from "./constants.ts"
import { START_BANNER } from "./constants.ts"
import { findSessionID, getPromptRouting, getAgentIdentity } from "./routing.ts"
import { getText } from "./analysis.ts"
import { getToolNames, classifyMemoryTools, appendMemoryUsageLog } from "./pure-helpers.ts"
import { pruneAllSessionState } from "./prune-state.ts"

export async function onMessageUpdatedWithGating(args: {
  event: any
  client: any
  directory: string
  projectRoot: string
  retryChainBySession: Map<string, number>
  startupConfirmedBySession: Set<string>
  terminalCountBySession: Map<string, number>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  memoryReadSessions: Set<string>
  noteAutoConsolidationActivity: (sid: string, info: any) => void
  verifySourceCapture: (sid: string, eventType: string) => Promise<void>
  issueRetry: (sid: string, last: MessageWithParts, prev: MessageWithParts | null) => Promise<boolean>
  maybeSpiralNudge: (sid: string, last: MessageWithParts, prev: MessageWithParts | null) => Promise<boolean>
  retryEnabled: boolean
  spiralGuardEnabled: boolean
  unwrapMessageResult: (res: any) => MessageWithParts | null
  autoConsolidationMaxTrackedSessions: number
  pruneToMax: (collection: Map<string, any> | Set<string>, max: number) => void
  retriedParentBySession: Map<string, Map<string, number>>
  inspectedStopBySession: Map<string, Set<string>>
  toolWindowBySession: Map<string, Array<{ signature: string; atMessage: number }>>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
  loopInterventionsBySession: Map<string, number>
  taskWindowBySession: Map<string, string[]>
  taskEscalationsBySession: Map<string, number>
  taskRecentLaunchBySession: Map<string, Map<string, number>>
  workedExampleFiledByShape: Map<string, Map<string, number>>
  capabilityRecordedBySession: Map<string, Set<string>>
  failureRecordedBySession: Map<string, Set<string>>
  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>
  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
  checkpointedSessions: Set<string>
  memcoreInjectionBySession: Map<string, { signature: string; at: number; scopeDir: string }>
  sourceCaptureBySession: Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>
  compactionPathBySession: Map<string, { path: "post-compact-fallback"; at: string }>
}): Promise<void> {
  const event = args.event
  const info = event?.properties?.info
  const sid = String(info?.sessionID ?? findSessionID(event))
  if (!sid) return
  const messageID = String(info?.id ?? "")
  if (messageID) {
    const previousMessageID = args.lastCountedMessageIdBySession.get(sid)
    if (previousMessageID !== messageID) {
      args.messageCountBySession.set(sid, (args.messageCountBySession.get(sid) ?? 0) + 1)
      args.lastCountedMessageIdBySession.set(sid, messageID)
    }
  }

  // A real (non-injected) user message resets the retry chain counter.
  if (info?.role === "user") {
    args.retryChainBySession.delete(sid)
  }

  if (!args.startupConfirmedBySession.has(sid)) {
    args.startupConfirmedBySession.add(sid)
    console.log(`${START_BANNER}: message hook active`)
  }

  // Count terminal assistant messages only (finish set) for the checkpoint gate.
  if (info?.role === "assistant" && info?.finish) {
    args.terminalCountBySession.set(sid, (args.terminalCountBySession.get(sid) ?? 0) + 1)
  }

  // Auto-consolidation: a new message cancels any pending idle run and advances the
  // volume counter; harmless no-op when auto-consolidation is disabled.
  args.noteAutoConsolidationActivity(sid, info)

  try {
    const messageID = String(info?.id ?? "")
    if (!messageID) return
    if (info?.role !== "assistant") return
    if (info?.finish !== "stop" && info?.finish !== "tool-calls") return

    const currentRes: any = await args.client.session.message({
      path: { id: sid, messageID },
      query: { directory: args.directory },
    })
    const current = args.unwrapMessageResult(currentRes)
    if (!current) return

    const currentRouting = getPromptRouting(current)
    if (currentRouting.agent || currentRouting.model) {
      args.activeRoutingBySession.set(sid, currentRouting)
    }

    const memoryTools = classifyMemoryTools(getToolNames(current))
    if (memoryTools.reads.length > 0 || memoryTools.writes.length > 0) {
      if (memoryTools.reads.length > 0) args.memoryReadSessions.add(sid)
      appendMemoryUsageLog(args.projectRoot, {
        sid,
        messageID,
        agent: getAgentIdentity(current) || undefined,
        reads: memoryTools.reads,
        writes: memoryTools.writes,
      })
    }

    if (info?.finish !== "stop") return

    // When BOTH reactive guards are disabled, skip parent fetch and all
    // heuristic evaluation — zero extra overhead per message.
    if (!args.retryEnabled && !args.spiralGuardEnabled) {
      args.verifySourceCapture(sid, "message.stop").catch(() => {})
      return
    }

    const parentID = String(current?.info?.parentID ?? "")
    if (!parentID) return

    const parentRes: any = await args.client.session.message({
      path: { id: sid, messageID: parentID },
      query: { directory: args.directory },
    })
    const parent = args.unwrapMessageResult(parentRes)
    args.verifySourceCapture(sid, "message.stop").catch(() => {})

    // message.updated owns the reactive end-of-turn guards; checkpoint is
    // idle-only. At most one injection per stop: retry owns stalls, the spiral
    // guard owns no-action deliberation (opposite failure modes).
    const retried = await args.issueRetry(sid, current, parent)
    if (!retried) await args.maybeSpiralNudge(sid, current, parent)
  } catch (err) {
    console.error("[turn-guard] message.updated failed:", err)
  }
  // P3-1: bound all session-keyed state to prevent memory leaks in long-lived processes
  pruneAllSessionState(args)
}

export async function onSessionIdleWithGating(args: {
  event: any
  client: any
  directory: string
  startupConfirmedBySession: Set<string>
  retryEnabled: boolean
  issueRetry: (sid: string, last: MessageWithParts, prev: MessageWithParts | null) => Promise<boolean>
  maybeCheckpoint: (sid: string, last: MessageWithParts) => Promise<boolean>
  maybeInjectMemcore: (opts: { sid: string; event: any; reason: "idle" | "compacted" | "compacting" | "started"; messages?: MessageWithParts[]; anchor?: MessageWithParts | null; force?: boolean }) => Promise<boolean>
  maybeFileWorkedExamplesFromMessage: (sid: string, msg: MessageWithParts) => Promise<void>
  armAutoConsolidationIdleTimer: (sid: string) => void
  sortByCreated: (messages: MessageWithParts[]) => MessageWithParts[]
  unwrapListResult: (res: any) => MessageWithParts[]
  autoConsolidationMaxTrackedSessions: number
  pruneToMax: (collection: Map<string, any> | Set<string>, max: number) => void
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  inspectedStopBySession: Map<string, Set<string>>
  toolWindowBySession: Map<string, Array<{ signature: string; atMessage: number }>>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
  loopInterventionsBySession: Map<string, number>
  taskWindowBySession: Map<string, string[]>
  taskEscalationsBySession: Map<string, number>
  taskRecentLaunchBySession: Map<string, Map<string, number>>
  workedExampleFiledByShape: Map<string, Map<string, number>>
  capabilityRecordedBySession: Map<string, Set<string>>
  failureRecordedBySession: Map<string, Set<string>>
  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>
  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
  checkpointedSessions: Set<string>
  terminalCountBySession: Map<string, number>
  memcoreInjectionBySession: Map<string, { signature: string; at: number; scopeDir: string }>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  sourceCaptureBySession: Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>
  compactionPathBySession: Map<string, { path: "post-compact-fallback"; at: string }>
}): Promise<void> {
  const event = args.event
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  if (!args.startupConfirmedBySession.has(sid)) {
    args.startupConfirmedBySession.add(sid)
    console.log(`${START_BANNER}: idle hook active for session=${sid}`)
  }

  try {
    const res: any = await args.client.session.messages({
      path: { id: sid },
      query: { directory: args.directory },
    })

    const messages = args.sortByCreated(args.unwrapListResult(res))
    if (messages.length < 2) return

    const last = messages[messages.length - 1]
    const prev = messages[messages.length - 2]

    // Checkpoint is independent of retry — its own guards (clean stop,
    // !endsMidIntent, hasUsefulPayload) prevent it from firing on stalls even
    // without the retry gate. When retry IS enabled it runs first so stall
    // detection can still log; the checkpoint's guards exclude stalls either way.
    if (args.retryEnabled) {
      await args.issueRetry(sid, last, prev)
    }
    await args.maybeCheckpoint(sid, last)

    await args.maybeInjectMemcore({
      sid,
      event,
      reason: "idle",
      messages,
      anchor: last,
    })

    // Phase 13 CREATE: file worked examples for successful implementation subagents.
    // Scans the last message for task tool parts with completed status and a target
    // subagent_type, then files a compact example if the output is substantive.
    await args.maybeFileWorkedExamplesFromMessage(sid, last)

    // Arm the overridable idle-delay timer: consolidation fires only if the
    // session stays quiet for the full delay (a new message cancels it).
    args.armAutoConsolidationIdleTimer(sid)
  } catch (err) {
    console.error("[turn-guard] failed:", err)
  }
  // P3-1: bound all session-keyed state (same as onMessageUpdated)
  pruneAllSessionState(args)
}

export async function onSessionCompactedWithGating(args: {
  event: any
  verifySourceCapture: (sid: string, eventType: string) => Promise<void>
  archiveCompactedRegion: (sid: string) => Promise<void>
  compactionPathBySession: Map<string, { path: "post-compact-fallback"; at: string }>
  maybeInjectMemcore: (opts: { sid: string; event: any; reason: "idle" | "compacted" | "compacting" | "started"; messages?: MessageWithParts[]; anchor?: MessageWithParts | null; force?: boolean }) => Promise<boolean>
  autoConsolidationOnCompact: boolean
  evaluateAutoConsolidation: (sid: string, trigger: string) => void
  autoConsolidationMaxTrackedSessions: number
  pruneToMax: (collection: Map<string, any> | Set<string>, max: number) => void
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  startupConfirmedBySession: Set<string>
  inspectedStopBySession: Map<string, Set<string>>
  toolWindowBySession: Map<string, Array<{ signature: string; atMessage: number }>>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
  loopInterventionsBySession: Map<string, number>
  taskWindowBySession: Map<string, string[]>
  taskEscalationsBySession: Map<string, number>
  taskRecentLaunchBySession: Map<string, Map<string, number>>
  workedExampleFiledByShape: Map<string, Map<string, number>>
  capabilityRecordedBySession: Map<string, Set<string>>
  failureRecordedBySession: Map<string, Set<string>>
  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>
  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>
  spiralNudgedBySession: Map<string, number>
  spiralInspectedBySession: Map<string, Set<string>>
  checkpointedSessions: Set<string>
  terminalCountBySession: Map<string, number>
  memcoreInjectionBySession: Map<string, { signature: string; at: number; scopeDir: string }>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  sourceCaptureBySession: Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>
}): Promise<void> {
  const event = args.event
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  args.verifySourceCapture(sid, "session.compacted").catch(() => {})

  // Archive the just-compacted region BEFORE it scrolls out of practical reach.
  // Independent of the mem-core fallback below; gated by ESHEPHERD_COMPACT_ARCHIVE.
  await args.archiveCompactedRegion(sid)

  // Mem-core reinjection is intentionally post-compaction-only. The compaction
  // hook owns prompt shaping; this event owns continuation-memory refresh.
  args.compactionPathBySession.set(sid, { path: "post-compact-fallback", at: new Date().toISOString() })
  // NOTE: do NOT force here. maybeInjectMemcore injects via client.session.prompt(),
  // which creates a real generating turn (~memcoreMaxChars). Forcing made every
  // post-compaction event re-inject the same large block, re-inflating context and
  // triggering another compaction → an infinite compact/reinject loop. Relying on
  // the signature+cooldown dedup means this fires at most once per unique mem-core
  // content, so identical mem-core after a compaction is a no-op.
  await args.maybeInjectMemcore({
    sid,
    event,
    reason: "compacted",
  })

  // Compaction is a natural consolidation point; run auto-consolidation if enabled.
  if (args.autoConsolidationOnCompact) {
    args.evaluateAutoConsolidation(sid, "compacted")
  }
  // P3-1: bound all session-keyed state (same as onMessageUpdated)
  pruneAllSessionState(args)
}

export async function onSessionStartedWithGating(args: {
  event: any
  toolWindowBySession: Map<string, Array<{ signature: string; atMessage: number }>>
  messageCountBySession: Map<string, number>
  lastCountedMessageIdBySession: Map<string, string>
  loopInterventionsBySession: Map<string, number>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  maybeInjectMemcore: (opts: { sid: string; event: any; reason: "idle" | "compacted" | "compacting" | "started"; messages?: MessageWithParts[]; anchor?: MessageWithParts | null }) => Promise<boolean>
}): Promise<void> {
  const event = args.event
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  args.toolWindowBySession.delete(sid)
  args.messageCountBySession.delete(sid)
  args.lastCountedMessageIdBySession.delete(sid)
  args.loopInterventionsBySession.delete(sid)
  args.activeRoutingBySession.delete(sid)

  await args.maybeInjectMemcore({
    sid,
    event,
    reason: "started",
  })
}
