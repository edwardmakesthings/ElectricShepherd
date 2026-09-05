// @ts-nocheck

// Domain category: auto-retry lifecycle handler (issueRetryWithGating).
// Extracted from handlers.ts as a dependency-injected *WithGating* function.

import type { MessageWithParts } from "./constants.ts"
import { AUTO_RETRY_MARKER, CHECKPOINT_MARKER, MAX_RETRIES_PER_PARENT } from "./constants.ts"
import {
  getText, hasFinalReviewSignal, hasActionPart, isAssistantStop,
  isSerenaMemoryToolTurn,
} from "./analysis.ts"
import {
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
    // Success signal: a clean completion right after an
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

  // Attribute the stalled stop to (model, shape) at nudge time.
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
