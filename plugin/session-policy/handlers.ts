// @ts-nocheck

// Domain category: lifecycle event handlers (message.updated, session.idle,
// session.compacted, session.started). Extracted from turn-guard.ts as exported
// *WithGating* functions using dependency injection.

import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import type { MessageWithParts } from "./constants.ts"
import {
  STATUS_DIR, START_BANNER, CHECKPOINT_MARKER, SPIRAL_GUARD_MARKER, AUTO_RETRY_MARKER,
} from "./constants.ts"
import type { TurnGuardContext } from "./context.ts"
import { getPromptRouting, findSessionID, getAgentIdentity } from "./routing.ts"
import { detectDeliberationSpiral, isDeliberationExemptPrompt } from "../../adapter/turn-guard-helpers.ts"
import { getText, hasActionPart, isAssistantStop } from "./analysis.ts"
import { getToolNames, classifyMemoryTools, appendMemoryUsageLog, writeStatusFile } from "./pure-helpers.ts"
import { issueRetryWithGating } from "./retry-handler.ts"

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

/** Shared P3-1 pruning: bound all session-keyed state to prevent memory leaks. */
function pruneAllSessionState(args: {
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  retriesTotalBySession: Map<string, number>
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
  compactionPathBySession: Map<string, { path: "post-compact-fallback"; at: string }>
  autoConsolidationMaxTrackedSessions: number
  pruneToMax: (collection: Map<string, any> | Set<string>, max: number) => void
}): void {
  const { pruneToMax, autoConsolidationMaxTrackedSessions } = args
  pruneToMax(args.retriedParentBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.retriesTotalBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.retryChainBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.inspectedStopBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.toolWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.messageCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.lastCountedMessageIdBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.taskWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.failureRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.checkpointedSessions, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.terminalCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.activeRoutingBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(args.compactionPathBySession, autoConsolidationMaxTrackedSessions)
}

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

// Post-compaction transcript archiver. Compaction RETAINS prior messages in the
// session log (verified 2026-08-19: session.messages returns the full history,
// with summary:true + agent:"compaction" assistant markers delimiting each folded
// region). So the "just dropped" content is still readable right after compaction —
// this slices the log at the latest compaction marker and writes that region to a
// durable file before it scrolls out of practical reach. Structure: one markdown
// file per compaction, roles + text/tool/patch parts, no message content omitted.
// Entirely wrapped in try/catch — an archive failure must never break compaction.
export async function archiveCompactedRegionWithGating(args: {
  sid: string
  client: any
  directory: string
  projectRoot: string
  compactArchiveEnabled: boolean
  sortByCreated: (messages: MessageWithParts[]) => MessageWithParts[]
  unwrapListResult: (res: any) => MessageWithParts[]
  statusSnapshot: (extra?: Record<string, unknown>) => Record<string, unknown>
}): Promise<void> {
  const sid = args.sid
  if (!args.compactArchiveEnabled) return
  try {
    const res: any = await args.client.session.messages({
      path: { id: sid },
      query: { directory: args.directory },
    })
    const messages = args.sortByCreated(args.unwrapListResult(res))
    if (messages.length === 0) return

    // Latest compaction marker = the highest-index assistant message with
    // info.summary === true. Everything BEFORE it is what this compaction folded.
    let markerIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const info: any = messages[i]?.info
      if (info?.role === "assistant" && info?.summary === true) {
        markerIndex = i
        break
      }
    }
    if (markerIndex <= 0) return // nothing before the marker to archive

    // Only archive messages since the PREVIOUS marker (don't re-archive regions
    // already captured by an earlier compaction's archive file).
    let prevMarkerIndex = -1
    for (let i = markerIndex - 1; i >= 0; i--) {
      const info: any = messages[i]?.info
      if (info?.role === "assistant" && info?.summary === true) {
        prevMarkerIndex = i
        break
      }
    }
    const region = messages.slice(prevMarkerIndex + 1, markerIndex)
    if (region.length === 0) return

    const lines: string[] = []
    lines.push(`# Compaction archive — session ${sid}`)
    lines.push(`# Archived ${new Date().toISOString()} — ${region.length} messages folded by compaction`)
    lines.push("")
    for (const m of region) {
      const info: any = m?.info ?? {}
      const role = String(info.role ?? "?")
      const parts: any[] = m?.parts ?? []
      const text = getText(parts)
      const toolNames = parts.filter((p) => p?.type === "tool").map((p) => p?.tool).filter(Boolean)
      const patchCount = parts.filter((p) => p?.type === "patch").length
      lines.push(`## [${role}]`)
      if (text) lines.push(text)
      if (toolNames.length > 0) lines.push(`(tools: ${toolNames.join(", ")})`)
      if (patchCount > 0) lines.push(`(${patchCount} patch part${patchCount === 1 ? "" : "s"})`)
      lines.push("")
    }

    // Memory-loop output, not agent-to-agent research: keep it out of .opencode/context.
    const dir = join(args.projectRoot, STATUS_DIR, "compaction-archive")
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const path = join(dir, `${sid}-${ts}.md`)
    writeFileSync(path, lines.join("\n"), "utf8")
    console.log(`[turn-guard] compact archive: wrote ${region.length} messages sid=${sid} -> ${path}`)
    writeStatusFile(args.projectRoot, args.statusSnapshot({ type: "compact-archive", sid, messages: region.length, path }))
  } catch (err) {
    // Never let archiving break the compaction path.
    console.log(`[turn-guard] compact archive: error (ignored) sid=${sid}: ${err}`)
  }
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


// Typed binder: composes the exported *WithGating* functions into ready-to-use
// event handlers. turn-guard.ts instantiates this once with its closure deps and
// passes the returned handlers to createHookHeadHandlers — no per-handler local
// wrappers needed there anymore. Each returned function delegates verbatim to
// the corresponding *WithGating* export (no behavior changes).
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
