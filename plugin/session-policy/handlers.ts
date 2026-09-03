// @ts-nocheck

// Domain category: lifecycle event handlers (message.updated, session.idle,
// session.compacted, session.started). Extracted from turn-guard.ts as exported
// *WithGating* functions using dependency injection.

import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import type { MessageWithParts } from "./constants.ts"
import {
  STATUS_DIR, START_BANNER, AUTO_RETRY_MARKER, CHECKPOINT_MARKER, SPIRAL_GUARD_MARKER,
  MAX_RETRIES_PER_PARENT, MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT, CHECKPOINT_MODES,
} from "./constants.ts"
import type { TurnGuardContext } from "./context.ts"
import { getPromptRouting, findSessionID, getAgentIdentity } from "./routing.ts"
import { detectDeliberationSpiral, isDeliberationExemptPrompt } from "../../adapter/turn-guard-helpers.ts"
import {
  getText, hasFinalReviewSignal, hasActionPart, isAssistantStop,
  isSerenaMemoryToolTurn,
} from "./analysis.ts"
import {
  getToolNames, classifyMemoryTools, appendMemoryUsageLog, writeStatusFile,
  hasUsefulPayload, isCapabilityQuestion, endsMidIntent, isAssistantToolCallFinish, partTypes,
} from "./pure-helpers.ts"


// turns that still contained structured tool_calls, causing premature agent-loop
// exit (opencode#20719). With llama-server (or any correctly-signalling backend),
// finish="stop" and finish="tool-calls" mean what they say.
//
// Default: DISABLED (ESHEPHERD_RETRY_ENABLED=true to opt in). When disabled the
// entire function returns immediately — zero per-message overhead.
// Retain as an opt-in safety net for providers that still mis-signal.
// Returns true if a retry prompt was issued.
export async function issueRetryWithGating(args: {
  sid: string
  last: MessageWithParts
  prev: MessageWithParts | null
  retryEnabled: boolean
  retryDisabledModes: Set<string>
  retryDisabledAgents: Set<string>
  inspectedStopBySession: Map<string, Set<string>>
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  maxRetriesPerSession: number
  client: any
  directory: string
  getPromptRouting: (...candidates: Array<MessageWithParts | null | undefined>) => { agent?: string; model?: { providerID: string; modelID: string } }
  confirmPendingInterventions: (args: { sid: string; confirmedKey?: string; model?: { providerID: string; modelID: string } | null; taskText: string }) => Promise<void>
  maybeRecordModelFailure: (args: { sid: string; model?: { providerID: string; modelID: string } | null; taskText: string; event: "spiral" | "loop"; interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"; interventionText: string }) => Promise<void>
  queuePendingIntervention: (sid: string, key: string, label: string, text: string) => void
}): Promise<boolean> {
  const { sid, last, prev } = args
  if (!args.retryEnabled) return false
  if (!isAssistantStop(last)) return false

  const currentMode = String(last?.info?.mode ?? "").trim().toLowerCase()
  const currentAgent = String(last?.info?.agent ?? "").trim().toLowerCase()
  if (currentMode && args.retryDisabledModes.has(currentMode)) {
    return false
  }
  if (currentAgent && args.retryDisabledAgents.has(currentAgent)) {
    return false
  }

  const messageID = String(last?.info?.id ?? "")
  if (messageID) {
    const inspected = args.inspectedStopBySession.get(sid) ?? new Set<string>()
    if (inspected.has(messageID)) return false
    inspected.add(messageID)
    args.inspectedStopBySession.set(sid, inspected)
  }

  const prevIsToolTurn = !!prev && isAssistantToolCallFinish(prev)
  const prevIsUser = prev?.info?.role === "user"
  if (!prevIsToolTurn && !prevIsUser) return false

  const parentText = getText(prev?.parts ?? [])
  // A reply to a memory-checkpoint prompt is terminal by design — never retry it.
  if (parentText.trimStart().startsWith(CHECKPOINT_MARKER)) {
    console.log(`[turn-guard] skip retry in ${sid}; turn is a memory-checkpoint reply`)
    return false
  }

  const hasUseful = hasUsefulPayload(last)
  const hasReview = hasFinalReviewSignal(last)
  const lastTextLen = getText(last.parts ?? []).length
  const prevWasSerenaMemory = isSerenaMemoryToolTurn(prev)
  const midIntent = endsMidIntent(last)
  const capabilityQuestion = prevIsUser && isCapabilityQuestion(parentText)
  const actionLikeTurn = prevIsToolTurn || hasActionPart(last) || midIntent
  const reviewRequired = actionLikeTurn && !capabilityQuestion

  console.log(
    `[turn-guard] evaluate sid=${sid} msg=${messageID || "?"} ` +
    `prevRole=${String(prev?.info?.role ?? "?")} prevFinish=${String(prev?.info?.finish ?? "")} ` +
    `prevSerenaMemory=${String(prevWasSerenaMemory)} hasUseful=${String(hasUseful)} ` +
    `hasReview=${String(hasReview)} midIntent=${String(midIntent)} reviewRequired=${String(reviewRequired)} ` +
    `capabilityQuestion=${String(capabilityQuestion)} textLen=${lastTextLen} partTypes=${partTypes(last)}`
  )

  const memoryOnlyLikelyPremature = prevWasSerenaMemory && (lastTextLen < 120 || (reviewRequired && !hasReview))
  const consideredComplete = !memoryOnlyLikelyPremature && !midIntent && hasUseful && (!reviewRequired || hasReview)
  if (consideredComplete) {
    console.log(
      `[turn-guard] skip retry in ${sid}; considered complete ` +
      `(hasUseful=${String(hasUseful)} hasReview=${String(hasReview)} midIntent=${String(midIntent)} ` +
      `reviewRequired=${String(reviewRequired)} capabilityQuestion=${String(capabilityQuestion)} ` +
      `prevSerenaMemory=${String(prevWasSerenaMemory)})`
    )
    // Turn is genuinely complete — reset the retry chain counter for this session.
    args.retryChainBySession.delete(sid)
    // Phase 15 CREATE (success signal): a clean completion right after an
    // attempted nudge is deterministic evidence the intervention worked —
    // persist the pending patch(es); expire any that were not confirmed here.
    const routing = args.getPromptRouting(last, prev)
    void args.confirmPendingInterventions({ sid, confirmedKey: messageID, model: routing.model ?? null, taskText: parentText })
    return false
  }

  const parentID = String(last?.info?.parentID ?? "")
  if (!parentID) return false

  // If the parent already is an auto-retry prompt, fold retries under the
  // grandparent ID so we can cap the whole retry chain.
  let retryKey = parentID
  if (parentText.trimStart().startsWith(AUTO_RETRY_MARKER)) {
    const grandParentID = String(prev?.info?.parentID ?? "")
    if (grandParentID) retryKey = grandParentID
  }

  // Chain counter: the authoritative bound against runaway retry chains.
  // Resets on consideredComplete or real user message (not injected prompts).
  const chainCount = args.retryChainBySession.get(sid) ?? 0
  if (chainCount >= MAX_RETRIES_PER_PARENT) {
    console.log(
      `[turn-guard] skip retry in ${sid}; retry chain cap ${MAX_RETRIES_PER_PARENT} reached`,
    )
    return false
  }

  const retriedParents = args.retriedParentBySession.get(sid) ?? new Map<string, number>()
  const retryCount = retriedParents.get(retryKey) ?? 0
  if (retryCount >= MAX_RETRIES_PER_PARENT) return false

  // Keying-independent per-session ceiling: bounds the entire retry chain even
  // when retryKey shifts every generation (see DEFAULT_MAX_RETRIES_PER_SESSION).
  const sessionRetries = args.retriesTotalBySession.get(sid) ?? 0
  if (sessionRetries >= args.maxRetriesPerSession) {
    console.log(
      `[turn-guard] skip retry in ${sid}; per-session retry cap ${args.maxRetriesPerSession} reached`,
    )
    return false
  }

  retriedParents.set(retryKey, retryCount + 1)
  args.retriedParentBySession.set(sid, retriedParents)
  args.retriesTotalBySession.set(sid, sessionRetries + 1)
  args.retryChainBySession.set(sid, chainCount + 1)

  const retryReason = memoryOnlyLikelyPremature
    ? "memory checkpoint without concrete continuation"
    : midIntent
      ? "announced an action but stopped before executing it"
      : !hasUseful
        ? "no useful output"
        : reviewRequired
          ? "missing a final review of completed work"
          : "incomplete continuation"

  console.log(
    `[turn-guard] low-value stop detected in ${sid}; ` +
    `reason=${retryReason} prevRole=${String(prev?.info?.role ?? "?")} ` +
    `prevFinish=${String(prev?.info?.finish ?? "")} issuing one auto-retry`
  )

  const routing = args.getPromptRouting(last, prev)
  const activeModel = routing.model
  if (activeModel) {
    console.log(
      `[turn-guard] retry model pin sid=${sid} ` +
      `provider=${activeModel.providerID} model=${activeModel.modelID}`
    )
  } else {
    console.log(`[turn-guard] retry model pin sid=${sid} unavailable; using session default`)
  }

  const body: any = {
    parts: [
      {
        type: "text",
        text:
          `${AUTO_RETRY_MARKER} Your previous turn ended with finish=stop and ${retryReason}. ` +
          "Before responding, evaluate why progression stalled. If uncertain, call your configured sequentialthinking MCP tool once to choose the next concrete action. " +
          "Then continue execution immediately (do not stop at status-only output). If the tool result is empty/no-match, recover by checking alternative paths/patterns or report a precise blocker. " +
          "End with a short 'Review' section containing: what you did, what changed or what failed, and the exact next action.",
      },
    ],
  }

  if (routing.agent) {
    body.agent = routing.agent
  }

  if (activeModel) {
    body.model = activeModel
  }

  await args.client.session.prompt({
    path: { id: sid },
    query: { directory: args.directory },
    body,
  })

  // Phase 15 CREATE: attribute the stalled stop to (model, shape) at nudge time.
  // Task text = the real user prompt when prev is a user turn, else this turn's
  // own text. The intervention text is only QUEUED here — it becomes durable
  // knowledge only if confirmPendingInterventions later proves it worked (the
  // next stop being considered complete). Fire-and-forget — best-effort.
  const retryTaskText = prevIsUser ? parentText : getText(last.parts ?? [])
  void args.maybeRecordModelFailure({
    sid,
    model: activeModel ?? null,
    taskText: retryTaskText,
    event: "loop",
    interventionLabel: "retry-nudge",
    interventionText: String(body.parts[0].text),
  })
  args.queuePendingIntervention(sid, messageID, "retry-nudge", String(body.parts[0].text))

  return true
}

// Reactive deliberation-spiral guard. Sibling to issueRetry: retry owns stalls
// (no useful output / mid-intent); this owns the opposite failure — a finish=stop
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

// Returns true if a checkpoint prompt was issued. Idle-only, once per session,
// and only on a genuinely complete turn so it never fires over a stall.
export async function maybeCheckpointWithGating(args: {
  sid: string
  last: MessageWithParts
  checkpointedSessions: Set<string>
  terminalCountBySession: Map<string, number>
  checkpointDisabledAgents: Set<string>
  client: any
  directory: string
  getPromptRouting: (...candidates: Array<MessageWithParts | null | undefined>) => { agent?: string; model?: { providerID: string; modelID: string } }
}): Promise<boolean> {
  const { sid, last } = args
  if (args.checkpointedSessions.has(sid)) return false

  const mode = String(last?.info?.mode ?? "")
  if (!CHECKPOINT_MODES.has(mode)) return false

  const count = args.terminalCountBySession.get(sid) ?? 0
  if (count < MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT) return false

  // Only checkpoint after a clean, SUCCESSFUL turn — a real stop with useful
  // output, not a stall and not mid-intent. (Do NOT require a final-review
  // signal: that is a build-mode convention and would block checkpoints in
  // plan mode. On idle, retry already owns build stalls, so reaching here
  // means the turn completed.)
  if (!isAssistantStop(last)) return false
  if (endsMidIntent(last)) return false
  if (!hasUsefulPayload(last)) return false

  // Utility subagents never checkpoint: they do no durable work of their own,
  // and a checkpoint prompt would only burn a turn on them.
  const routing = args.getPromptRouting(last)
  const currentAgent = String(routing.agent ?? "").trim().toLowerCase()
  if (currentAgent && args.checkpointDisabledAgents.has(currentAgent)) {
    console.log(`[turn-guard] checkpoint skipped for sid=${sid}: agent=${currentAgent} is in checkpoint.disabledAgents`)
    return false
  }

  args.checkpointedSessions.add(sid)
  console.log(`[turn-guard] prompting memory checkpoint for sid=${sid} (mode=${mode})`)

  try {
    const body: any = {
      parts: [
        {
          type: "text",
          text:
            `${CHECKPOINT_MARKER} Before this session winds down, run a two-part memory ` +
            `check. These are independent — answer both; either can warrant saving alone.\n\n` +
            `PART 1 — did durable STATE change? (the always-loaded blocks)\n` +
            `- project-state — architecture, active work, or a major decision changed?\n` +
            `- active-conventions — a naming/style/structural/tooling rule changed?\n` +
            `- user-preferences — a new durable preference was stated?\n` +
            `For each durable STATE change, write/update it via diary_write (derived memory ` +
            `writes like add_drawer/kg_add are dreamer-only; write-authority will reject them from ` +
            `this agent — diary_write is the correct tool here, and a dreamer consolidation pass ` +
            `formalizes it into the derived layer).\n` +
            `mem-core is a deterministic file-only render regenerated by the consolidation runtime from derived memory. ` +
            `Do NOT hand-edit mem-core files and do NOT write any context-blocks drawer for mem-core.\n\n` +
            `PART 2 — was substantive WORK done or something LEARNED? (diary / worked example)\n` +
            `This applies EVEN IF no block changed. Save a derived entry if any happened:\n` +
            `- a feature/fix was implemented (what was built, where, key choices),\n` +
            `- a bug's root cause was found (the cause, not just the fix),\n` +
            `- a non-obvious "how/why this works" was discovered,\n` +
            `- a problem was solved in a reusable way (file as a worked example in the ` +
            `apprenticeship room; if the reusable solution maps to a RECURRING TASK, also add one line ` +
            `\`SKILL_EXERCISED: <concept name>\` so a later consolidation pass can link the worked ` +
            `example to the skill it exercised — this is only a signal for the dreamer, never a write),\n` +
            `- a dead end worth not repeating was hit.\n` +
            `Use diary_write (the apprenticeship room included) for all of this. Synthesize — ` +
            `don't dump a transcript; write what a future session would want to retrieve. ` +
            `Lead each saved entry with a one-line \`DESC:\` (what it is + when it's ` +
            `relevant) so it's discoverable without loading the body.\n\n` +
            `IF this session's work appears to already be done / already correct / a ` +
            `continuation of prior work: do NOT assume a prior session already saved it. ` +
            `You cannot see whether that happened. SEARCH MemPalace (diary/drawers) for an ` +
            `entry covering this specific work before concluding nothing needs saving. ` +
            `If you find a matching entry: genuinely a no-op, say so and cite what you found. ` +
            `If you find NO matching entry: this is unsaved work regardless of which session ` +
            `did it — save it now per PART 2 above. Never write "a previous session should ` +
            `have handled this" without having searched and found evidence it did.\n\n` +
            `Do not invent changes just to have something to write — but "no block changed" ` +
            `is NOT "nothing to save"; implementation work and discoveries belong in PART 2. ` +
            `If genuinely nothing in either part, reply "No memory updates needed" and stop. ` +
            `End by listing what you saved under each part.`,
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
  } catch (err) {
    console.error("[turn-guard] failed to issue checkpoint prompt:", err)
    return false
  }

  return true
}

/** Shared P3-1 pruning: bound all session-keyed state to prevent memory leaks. */
function pruneAllSessionState(args: {
  retriedParentBySession: Map<string, Map<string, number>>
  retriesTotalBySession: Map<string, number>
  retryChainBySession: Map<string, number>
  startupConfirmedBySession: Set<string>
  inspectedStopBySession: Map<string, Set<string>>
  toolWindowBySession: Map<string, string[]>
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
  toolWindowBySession: Map<string, string[]>
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
  toolWindowBySession: Map<string, string[]>
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
  toolWindowBySession: Map<string, string[]>
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
  toolWindowBySession: Map<string, string[]>
  loopInterventionsBySession: Map<string, number>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  maybeInjectMemcore: (opts: { sid: string; event: any; reason: "idle" | "compacted" | "compacting" | "started"; messages?: MessageWithParts[]; anchor?: MessageWithParts | null; force?: boolean }) => Promise<boolean>
}): Promise<void> {
  const event = args.event
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  args.toolWindowBySession.delete(sid)
  args.loopInterventionsBySession.delete(sid)
  args.activeRoutingBySession.delete(sid)

  await args.maybeInjectMemcore({
    sid,
    event,
    reason: "started",
    force: true,
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
  maybeInjectMemcore: (opts: { sid: string; event: any; reason: "idle" | "compacted" | "compacting" | "started"; messages?: MessageWithParts[]; anchor?: MessageWithParts | null; force?: boolean }) => Promise<boolean>
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
        loopInterventionsBySession: context.loopInterventionsBySession,
        activeRoutingBySession: deps.activeRoutingBySession,
        maybeInjectMemcore: deps.maybeInjectMemcore,
      })
    },
  }
}
