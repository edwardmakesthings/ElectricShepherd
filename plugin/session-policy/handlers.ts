// @ts-nocheck


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
  if (!retryEnabled) return false
  if (!isAssistantStop(last)) return false

  const currentMode = String(last?.info?.mode ?? "").trim().toLowerCase()
  const currentAgent = String(last?.info?.agent ?? "").trim().toLowerCase()
  if (currentMode && retryDisabledModes.has(currentMode)) {
    return false
  }
  if (currentAgent && retryDisabledAgents.has(currentAgent)) {
    return false
  }

  const messageID = String(last?.info?.id ?? "")
  if (messageID) {
    const inspected = inspectedStopBySession.get(sid) ?? new Set<string>()
    if (inspected.has(messageID)) return false
    inspected.add(messageID)
    inspectedStopBySession.set(sid, inspected)
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
    retryChainBySession.delete(sid)
    // Phase 15 CREATE (success signal): a clean completion right after an
    // attempted nudge is deterministic evidence the intervention worked —
    // persist the pending patch(es); expire any that were not confirmed here.
    void confirmPendingInterventions({ sid, confirmedKey: messageID, model: routing.model ?? null, taskText: parentText })
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
  const chainCount = retryChainBySession.get(sid) ?? 0
  if (chainCount >= MAX_RETRIES_PER_PARENT) {
    console.log(
      `[turn-guard] skip retry in ${sid}; retry chain cap ${MAX_RETRIES_PER_PARENT} reached`,
    )
    return false
  }

  const retriedParents = retriedParentBySession.get(sid) ?? new Map<string, number>()
  const retryCount = retriedParents.get(retryKey) ?? 0
  if (retryCount >= MAX_RETRIES_PER_PARENT) return false

  // Keying-independent per-session ceiling: bounds the entire retry chain even
  // when retryKey shifts every generation (see DEFAULT_MAX_RETRIES_PER_SESSION).
  const sessionRetries = retriesTotalBySession.get(sid) ?? 0
  if (sessionRetries >= maxRetriesPerSession) {
    console.log(
      `[turn-guard] skip retry in ${sid}; per-session retry cap ${maxRetriesPerSession} reached`,
    )
    return false
  }

  retriedParents.set(retryKey, retryCount + 1)
  retriedParentBySession.set(sid, retriedParents)
  retriesTotalBySession.set(sid, sessionRetries + 1)
  retryChainBySession.set(sid, chainCount + 1)

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

  const routing = getPromptRouting(last, prev)
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

  await client.session.prompt({
    path: { id: sid },
    query: { directory },
    body,
  })

  // Phase 15 CREATE: attribute the stalled stop to (model, shape) at nudge time.
  // Task text = the real user prompt when prev is a user turn, else this turn's
  // own text. The intervention text is only QUEUED here — it becomes durable
  // knowledge only if confirmPendingInterventions later proves it worked (the
  // next stop being considered complete). Fire-and-forget — best-effort.
  const retryTaskText = prevIsUser ? parentText : getText(last.parts ?? [])
  void maybeRecordModelFailure({
    sid,
    model: activeModel ?? null,
    taskText: retryTaskText,
    event: "loop",
    interventionLabel: "retry-nudge",
    interventionText: String(body.parts[0].text),
  })
  queuePendingIntervention(sid, messageID, "retry-nudge", String(body.parts[0].text))

  return true
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
  if (!spiralGuardEnabled) return false
  if (!isAssistantStop(last)) return false

  const messageID = String(last?.info?.id ?? "")
  if (messageID) {
    const inspected = spiralInspectedBySession.get(sid) ?? new Set<string>()
    if (inspected.has(messageID)) return false
    inspected.add(messageID)
    spiralInspectedBySession.set(sid, inspected)
  }

  const currentMode = String(last?.info?.mode ?? "").trim().toLowerCase()
  const currentAgent = String(last?.info?.agent ?? "").trim().toLowerCase()
  if (currentMode && spiralGuardDisabledModes.has(currentMode)) return false
  if (currentAgent && spiralGuardDisabledAgents.has(currentAgent)) return false

  // Cloud models don't spiral the way local models do — skip them by default.
  const spiralRouting = getPromptRouting(last, prev)
  const spiralProvider = spiralRouting.model?.providerID?.toLowerCase() ?? ""
  const spiralModelID = spiralRouting.model?.modelID?.toLowerCase() ?? ""
  if (spiralProvider && spiralExemptProviders.has(spiralProvider)) return false
  if (
    spiralModelID &&
    Array.from(spiralExemptModelPrefixes).some((prefix) => spiralModelID.startsWith(prefix))
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
  if (spiralExemptReflection && prevIsUser && isDeliberationExemptPrompt(parentText)) {
    return false
  }

  const text = getText(last.parts ?? [])
  const decision = detectDeliberationSpiral({
    text,
    hasActionPart: hasActionPart(last),
    investigateThreshold: spiralInvestigateThreshold,
    reversalThreshold: spiralReversalThreshold,
  })
  if (!decision.isSpiral) return false

  const used = spiralNudgedBySession.get(sid) ?? 0
  if (used >= spiralMaxInterventions) {
    console.log(
      `[turn-guard] spiral guard: budget ${spiralMaxInterventions} spent in ${sid}; letting it through`,
    )
    return false
  }
  spiralNudgedBySession.set(sid, used + 1)

  console.log(
    `[turn-guard] spiral detected sid=${sid} msg=${messageID || "?"} ` +
      `investigate=${decision.investigateCount} reversal=${decision.reversalCount} ` +
      `nudge=${used + 1}/${spiralMaxInterventions}`,
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

  await client.session.prompt({
    path: { id: sid },
    query: { directory },
    body,
  })

  // Phase 15 CREATE: attribute the spiral to (model, shape) at nudge time. The
  // intervention text is only QUEUED — it becomes durable knowledge only if
  // confirmPendingInterventions later proves it worked (the next stop being
  // considered complete by issueRetry's predicates). Fire-and-forget — best-effort.
  void maybeRecordModelFailure({
    sid,
    model: routing.model ?? null,
    taskText: spiralTaskText,
    event: "spiral",
    interventionLabel: "spiral-nudge",
    interventionText: String(body.parts[0].text),
  })
  queuePendingIntervention(sid, messageID, "spiral-nudge", String(body.parts[0].text))

  return true
}

// Returns true if a checkpoint prompt was issued. Idle-only, once per session,
// and only on a genuinely complete turn so it never fires over a stall.
const maybeCheckpoint = async (sid: string, last: MessageWithParts): Promise<boolean> => {
  if (checkpointedSessions.has(sid)) return false

  const mode = String(last?.info?.mode ?? "")
  if (!CHECKPOINT_MODES.has(mode)) return false

  const count = terminalCountBySession.get(sid) ?? 0
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
  const routing = getPromptRouting(last)
  const currentAgent = String(routing.agent ?? "").trim().toLowerCase()
  if (currentAgent && checkpointDisabledAgents.has(currentAgent)) {
    console.log(`[turn-guard] checkpoint skipped for sid=${sid}: agent=${currentAgent} is in checkpoint.disabledAgents`)
    return false
  }

  checkpointedSessions.add(sid)
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

    await client.session.prompt({
      path: { id: sid },
      query: { directory },
      body,
    })
  } catch (err) {
    console.error("[turn-guard] failed to issue checkpoint prompt:", err)
    return false
  }

  return true
}

async function onMessageUpdated(event: any): Promise<void> {
  const info = event?.properties?.info
  const sid = String(info?.sessionID ?? findSessionID(event))
  if (!sid) return

  // A real (non-injected) user message resets the retry chain counter.
  if (info?.role === "user") {
    retryChainBySession.delete(sid)
  }

  if (!startupConfirmedBySession.has(sid)) {
    startupConfirmedBySession.add(sid)
    console.log(`${START_BANNER}: message hook active`)
  }

  // Count terminal assistant messages only (finish set) for the checkpoint gate.
  if (info?.role === "assistant" && info?.finish) {
    terminalCountBySession.set(sid, (terminalCountBySession.get(sid) ?? 0) + 1)
  }

  // Auto-consolidation: a new message cancels any pending idle run and advances the
  // volume counter; harmless no-op when auto-consolidation is disabled.
  noteAutoConsolidationActivity(sid, info)

  try {
    const messageID = String(info?.id ?? "")
    if (!messageID) return
    if (info?.role !== "assistant") return
    if (info?.finish !== "stop" && info?.finish !== "tool-calls") return

    const currentRes: any = await client.session.message({
      path: { id: sid, messageID },
      query: { directory },
    })
    const current = unwrapMessageResult(currentRes)
    if (!current) return

    const currentRouting = getPromptRouting(current)
    if (currentRouting.agent || currentRouting.model) {
      activeRoutingBySession.set(sid, currentRouting)
    }

    const memoryTools = classifyMemoryTools(getToolNames(current))
    if (memoryTools.reads.length > 0 || memoryTools.writes.length > 0) {
      if (memoryTools.reads.length > 0) memoryReadSessions.add(sid)
      appendMemoryUsageLog(projectRoot, {
        sid,
        messageID,
        agent: getAgentIdentity(current) || undefined,
        reads: memoryTools.reads,
        writes: memoryTools.writes,
      })
    }

    await maybeWarnWriteAuthority(sid, current)

    if (info?.finish !== "stop") return

    // When BOTH reactive guards are disabled, skip parent fetch and all
    // heuristic evaluation — zero extra overhead per message.
    if (!retryEnabled && !spiralGuardEnabled) {
      verifySourceCapture(sid, "message.stop").catch(() => {})
      return
    }

    const parentID = String(current?.info?.parentID ?? "")
    if (!parentID) return

    const parentRes: any = await client.session.message({
      path: { id: sid, messageID: parentID },
      query: { directory },
    })
    const parent = unwrapMessageResult(parentRes)
    verifySourceCapture(sid, "message.stop").catch(() => {})

    // message.updated owns the reactive end-of-turn guards; checkpoint is
    // idle-only. At most one injection per stop: retry owns stalls, the spiral
    // guard owns no-action deliberation (opposite failure modes).
    const retried = await issueRetry(sid, current, parent)
    if (!retried) await maybeSpiralNudge(sid, current, parent)
  } catch (err) {
    console.error("[turn-guard] message.updated failed:", err)
  }
  // P3-1: bound all session-keyed state to prevent memory leaks in long-lived processes
  pruneToMax(retriedParentBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(retriesTotalBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(retryChainBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(inspectedStopBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(toolWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
  pruneToMax(capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(failureRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(checkpointedSessions, autoConsolidationMaxTrackedSessions)
  pruneToMax(terminalCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(activeRoutingBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(compactionPathBySession, autoConsolidationMaxTrackedSessions)
}

// Phase 13 CREATE: scan a message for successful task tool completions and file
// worked examples. The task tool part carries the subagent_type in its input args
// and the output (the subagent's final text) in its state/output field. We only
// file when the part indicates success (no error status) and the output is
// substantive. This runs on session.idle — by then the task has completed and
// the message parts are finalized.
async function maybeFileWorkedExamplesFromMessage(sid: string, msg: MessageWithParts): Promise<void> {
  const parts = msg?.parts ?? []
  for (const part of parts) {
    if (part?.type !== "tool") continue
    const toolName = String(part?.tool ?? part?.name ?? "").trim().toLowerCase()
    if (toolName !== "task") continue

    // Extract subagent_type and prompt from the task call's input args.
    const inputArgs: any = part?.state?.input ?? part?.args ?? {}
    const subagentType = String(inputArgs?.subagent_type ?? "").trim().toLowerCase()

    // Extract the output (the subagent's final response text).
    const state = part?.state ?? {}
    const status = String(state?.status ?? "").trim().toLowerCase()

    const description = String(inputArgs?.description ?? "").trim()
    const prompt = String(inputArgs?.prompt ?? "").trim()

    // Phase 13 CREATE: file worked examples for cloud target subagent types with
    // substantive successful output. Success-only: skip if the task errored or was aborted.
    if (workedExampleFilingEnabled && WORKED_EXAMPLE_FILE_AGENT_TYPES.has(subagentType)) {
      if (status === "error" || status === "aborted" || status === "failed") continue

      const outputText = String(
        state?.output ?? part?.output ?? state?.text ?? "",
      ).trim()
      if (outputText.length < WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS) continue

      await maybeFileWorkedExample({ sid, subagentType, description, prompt, output: outputText })
    }

    // Phase 14 CREATE: record a capability tuple for routing-tier subagents.
    // Runs regardless of the worked-example filing gate — capability recording
    // is its own concern (it covers local/cloud/deep tiers, not just cloud).
    await maybeRecordCapabilityTuple({ sid, subagentType, description, prompt, status })

    // Phase 16 CREATE: capture the self-reported confidence label from the
    // subagent's terminal output. Runs for ANY task tool part with substantive
    // output (not gated on routing tier — calibration covers all delegated units).
    // The tuple is PENDING; it becomes durable only via record_outcome.
    const outputText = String(state?.output ?? part?.output ?? state?.text ?? "").trim()
    if (outputText.length >= WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS) {
      const activeModel = getActiveModel(msg)
      await maybeCaptureCalibrationTuple({ sid, model: activeModel, description, prompt, outputText })
    }
  }
}



async function onSessionIdle(event: any): Promise<void> {
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  if (!startupConfirmedBySession.has(sid)) {
    startupConfirmedBySession.add(sid)
    console.log(`${START_BANNER}: idle hook active for session=${sid}`)
  }

  try {
    const res: any = await client.session.messages({
      path: { id: sid },
      query: { directory },
    })

    const messages = sortByCreated(unwrapListResult(res))
    if (messages.length < 2) return

    const last = messages[messages.length - 1]
    const prev = messages[messages.length - 2]

    // Checkpoint is independent of retry — its own guards (clean stop,
    // !endsMidIntent, hasUsefulPayload) prevent it from firing on stalls even
    // without the retry gate. When retry IS enabled it runs first so stall
    // detection can still log; the checkpoint's guards exclude stalls either way.
    if (retryEnabled) {
      await issueRetry(sid, last, prev)
    }
    await maybeCheckpoint(sid, last)

    await maybeInjectMemcore({
      sid,
      event,
      reason: "idle",
      messages,
      anchor: last,
    })

    // Phase 13 CREATE: file worked examples for successful implementation subagents.
    // Scans the last message for task tool parts with completed status and a target
    // subagent_type, then files a compact example if the output is substantive.
    await maybeFileWorkedExamplesFromMessage(sid, last)

    // Arm the overridable idle-delay timer: consolidation fires only if the
    // session stays quiet for the full delay (a new message cancels it).
    armAutoConsolidationIdleTimer(sid)
  } catch (err) {
    console.error("[turn-guard] failed:", err)
  }
  // P3-1: bound all session-keyed state (same as onMessageUpdated)
  pruneToMax(retriedParentBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(retriesTotalBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(retryChainBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(inspectedStopBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(toolWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
  pruneToMax(capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(failureRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(checkpointedSessions, autoConsolidationMaxTrackedSessions)
  pruneToMax(terminalCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(activeRoutingBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(compactionPathBySession, autoConsolidationMaxTrackedSessions)
}

// Post-compaction transcript archiver. Compaction RETAINS prior messages in the
// session log (verified 2026-08-19: session.messages returns the full history,
// with summary:true + agent:"compaction" assistant markers delimiting each folded
// region). So the "just dropped" content is still readable right after compaction —
// this slices the log at the latest compaction marker and writes that region to a
// durable file before it scrolls out of practical reach. Structure: one markdown
// file per compaction, roles + text/tool/patch parts, no message content omitted.
// Entirely wrapped in try/catch — an archive failure must never break compaction.
async function archiveCompactedRegion(sid: string): Promise<void> {
  if (!compactArchiveEnabled) return
  try {
    const res: any = await client.session.messages({
      path: { id: sid },
      query: { directory },
    })
    const messages = sortByCreated(unwrapListResult(res))
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
    const dir = join(projectRoot, STATUS_DIR, "compaction-archive")
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const path = join(dir, `${sid}-${ts}.md`)
    writeFileSync(path, lines.join("\n"), "utf8")
    console.log(`[turn-guard] compact archive: wrote ${region.length} messages sid=${sid} -> ${path}`)
    writeStatusFile(projectRoot, statusSnapshot({ type: "compact-archive", sid, messages: region.length, path }))
  } catch (err) {
    // Never let archiving break the compaction path.
    console.log(`[turn-guard] compact archive: error (ignored) sid=${sid}: ${err}`)
  }
}

async function onSessionCompacted(event: any): Promise<void> {
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  verifySourceCapture(sid, "session.compacted").catch(() => {})

  // Archive the just-compacted region BEFORE it scrolls out of practical reach.
  // Independent of the mem-core fallback below; gated by ESHEPHERD_COMPACT_ARCHIVE.
  await archiveCompactedRegion(sid)

  // Mem-core reinjection is intentionally post-compaction-only. The compaction
  // hook owns prompt shaping; this event owns continuation-memory refresh.
  compactionPathBySession.set(sid, { path: "post-compact-fallback", at: new Date().toISOString() })
  // NOTE: do NOT force here. maybeInjectMemcore injects via client.session.prompt(),
  // which creates a real generating turn (~memcoreMaxChars). Forcing made every
  // post-compaction event re-inject the same large block, re-inflating context and
  // triggering another compaction → an infinite compact/reinject loop. Relying on
  // the signature+cooldown dedup means this fires at most once per unique mem-core
  // content, so identical mem-core after a compaction is a no-op.
  await maybeInjectMemcore({
    sid,
    event,
    reason: "compacted",
  })

  // Compaction is a natural consolidation point; run auto-consolidation if enabled.
  if (autoConsolidationOnCompact) {
    evaluateAutoConsolidation(sid, "compacted")
  }
  // P3-1: bound all session-keyed state (same as onMessageUpdated)
  pruneToMax(retriedParentBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(retriesTotalBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(retryChainBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(inspectedStopBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(toolWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskWindowBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
  pruneToMax(capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(failureRecordedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(checkpointedSessions, autoConsolidationMaxTrackedSessions)
  pruneToMax(terminalCountBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
  pruneToMax(compactionPathBySession, autoConsolidationMaxTrackedSessions)
}

async function onSessionStarted(event: any): Promise<void> {
  const sid = String(event?.properties?.sessionID ?? findSessionID(event))
  if (!sid) return

  toolWindowBySession.delete(sid)
  loopInterventionsBySession.delete(sid)
  activeRoutingBySession.delete(sid)

  await maybeInjectMemcore({
    sid,
    event,
    reason: "started",
    force: true,
  })
}

// Thin wrapper for the experimental.session.compacting pre-compaction hook.
// Isolated so that if OpenCode stabilises the hook shape (proposal #4317), only
// this function needs updating — same insulation discipline as the MemPalace
// tool-prefix adapter. The hook contract is (input={sessionID}, output={context[],prompt?}):
// you MUTATE output.context/output.prompt; the return value is ignored. We append
// mem-core to output.context (never replace output.prompt) so the default
// shrink-oriented summary prompt stays intact.
async function injectMemcoreIntoCompaction(input: any, output: any): Promise<void> {
  // Diagnostic probe (ESHEPHERD_PRECOMPACT_PROBE): reveal the input shape of the
  // experimental.session.compacting hook. Logs STRUCTURE ONLY — top-level keys,
  // their typeof, and for arrays/objects/strings only lengths and key lists.
  // Never logs values, message text, or prompt content (transcripts contain user
  // code). Runs BEFORE the reinject gate so it fires even when reinject is off.
  // Wrapped in try/catch so a probe failure can never break compaction.
  if (precompactProbeEnabled) {
    try {
      const shape: Record<string, unknown> = {}
      const keys = input && typeof input === "object" ? Object.keys(input) : []
      for (const key of keys) {
        const value = (input as Record<string, unknown>)[key]
        if (Array.isArray(value)) {
          const first = value.length > 0 ? value[0] : undefined
          shape[key] = {
            type: "array",
            length: value.length,
            firstElementKeys:
              first && typeof first === "object" ? Object.keys(first as Record<string, unknown>) : typeof first,
          }
        } else if (typeof value === "string") {
          shape[key] = { type: "string", length: value.length }
        } else if (value && typeof value === "object") {
          shape[key] = { type: "object", keys: Object.keys(value as Record<string, unknown>) }
        } else {
          shape[key] = { type: typeof value }
        }
      }
      console.log(`[turn-guard] pre-compact probe: keys=${JSON.stringify(keys)} shape=${JSON.stringify(shape)}`)
      writeStatusFile(projectRoot, statusSnapshot({ type: "pre-compact-probe", keys, shape }))
    } catch (probeErr) {
      console.log(`[turn-guard] pre-compact probe: error (ignored): ${probeErr}`)
    }
  }
  // Prompt-shape override. Set on output.prompt (replaces the default template)
  // rather than output.context (which only appends). Runs BEFORE the mem-core
  // gate on purpose: the summary shape should apply whether or not mem-core is
  // being carried along. Wrapped so a failure here can never break compaction --
  // on error OpenCode's default prompt is simply left in place.
  if (compactPromptOverrideEnabled && output && typeof output === "object") {
    try {
      output.prompt = COMPACT_PROMPT_TEMPLATE
      console.log("[turn-guard] pre-compact: replaced compaction prompt with pointer-oriented template")
    } catch (promptErr) {
      console.log(`[turn-guard] pre-compact: prompt override failed (ignored): ${promptErr}`)
    }
  }

  // Mem-core is for the continuation turn, so it is injected on session.compacted only.
  const sid = String(input?.sessionID ?? input?.sessionId ?? findSessionID(input) ?? "")
  writeStatusFile(projectRoot, statusSnapshot({
    type: "pre-compact-hook",
    sid,
    injected: false,
    note: "prompt-shape only; mem-core injects post-compaction",
  }))
}


