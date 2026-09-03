// @ts-nocheck
import type { TurnGuardContext } from "./context.ts"
import { decideLoopIntervention } from "../../adapter/turn-guard-helpers.ts"

// Typed binder for the "tool.execute.before" hook. turn-guard.ts instantiates
// this once with its closure deps and registers the returned handler — no
// inline monolith in the hook registration site, no free-global state. Every
// dep is injected; there is no other runtime path for this hook.
export interface ToolExecuteBeforeDeps {
  context: TurnGuardContext
  directory: string
  computeToolSignature: (toolName: string, args: any) => string
  resolveLoopGuardRouting: (sid: string, input: any, output: any) => Promise<{ agent?: string; model?: { providerID: string; modelID: string } }>
  resolveTaskSwapTarget: (args: {
    current?: { providerID: string; modelID: string } | undefined
    qwenMatch: string
    qwenToProvider?: string
    qwenToModel?: string
    gemmaMatch: string
    gemmaToProvider?: string
    gemmaToModel?: string
    fallbackProvider?: string
    fallbackModel?: string
  }) => { providerID: string; modelID: string; reason: string } | null
  retrieveSimilarWorkedExamples: (client: any, opts: { query: string; limit: number; relevanceFloor: number }) => Promise<any[]>
  WORKED_EXAMPLE_MAX_INJECT: number
  WORKED_EXAMPLE_RELEVANCE_FLOOR: number
  formatWorkedExampleDemonstration: (examples: any[]) => string
  shouldInjectWorkedExamples: (args: { enabled: boolean; subagentType: string; prompt: string; heading: string }) => { shouldInject: boolean; hasPrompt: boolean; promptAlreadyAugmented: boolean }
  canonicalModelId: (providerID?: string, modelID?: string) => string | null
  extractWorkedExampleShape: (taskText: string) => { shapeKey: string; workClass: string; sizeBucket: string }
  buildFailurePatchId: (modelId: string, shapeKey: string, label: string) => string
  CAPABILITY_TIER_BY_SUBAGENT: Record<string, string>
  normalizeModelSpec: (spec: any) => { providerID: string; modelID: string } | null
  decideCapabilityReroute: (args: { requestedTier: string; recommendation: string; fallback: boolean }) => { rerouteTo: string | null; reason: string }
  CAPABILITY_SUBAGENT_BY_TIER: Record<string, string>
  CALIBRATION_MIN_HIT_RATE: number
  CALIBRATION_OVERRIDE_MIN_SAMPLES: number
  parseSelfReportedConfidence: (outputText: string) => string | null
  buildCalibrationEscalationNote: (args: { heading: string; modelId: string; reportedConfidence: string; hitRate: number; total: number }) => string
  INTERVENTION_REPLAY_HEADING: string
  formatInterventionBlock: (interventions: any[]) => string
  INTERVENTION_REPLAY_MAX_PATCHES: number
  confirmPendingInterventions: (args: { sid: string; confirmedKey?: string; model?: { providerID: string; modelID: string } | null; taskText: string }) => Promise<void>
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  LOOP_GUARD_MARKER: string
  maybeRecordModelFailure: (args: { sid: string; model?: { providerID: string; modelID: string } | null; taskText: string; event: "spiral" | "loop"; interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"; interventionText: string }) => Promise<void>
  queuePendingIntervention: (sid: string, key: string, label: string, text: string) => void
}

export function bindToolExecuteBefore(deps: ToolExecuteBeforeDeps) {
  const { context } = deps
  return async (input: any, output: any): Promise<void> => {
    if (!context.loopGuardEnabled) return
    const toolName = String(input?.tool ?? "").trim()
    if (!toolName) return
    const sid = String(input?.sessionID ?? input?.sessionId ?? "")
    if (!sid) return

    const key = toolName.toLowerCase()
    if (context.loopExemptTools.has(key)) return

    const args = output?.args ?? input?.args ?? {}

    if (context.taskWatchdogEnabled && key === "task") {
      const subagentType = String(args?.subagent_type ?? "").trim().toLowerCase()
      const description = String(args?.description ?? "").trim()
      const prompt = String(args?.prompt ?? "").trim()
      const now = Date.now()

      if (subagentType && context.taskSerializeTypes.has(subagentType)) {
        const launches = context.taskRecentLaunchBySession.get(sid) ?? new Map<string, number>()
        const lastLaunchAt = Number(launches.get(subagentType) ?? 0)
        const elapsed = now - lastLaunchAt
        if (lastLaunchAt > 0 && elapsed < context.taskSerializeCooldownMs) {
          const waitSec = Math.max(1, Math.ceil((context.taskSerializeCooldownMs - elapsed) / 1000))
          const nudgeText =
            `${deps.LOOP_GUARD_MARKER} STOP. You are spawning \`${subagentType}\` tasks too quickly in parallel.\n\n` +
            `This \`task\` call was BLOCKED. Wait about ${waitSec}s, then launch the next \`${subagentType}\` task serially.\n\n` +
            `Do not retry immediately; queue it and continue with non-overlapping work.`
          throw new Error(nudgeText)
        }
        launches.set(subagentType, now)
        context.taskRecentLaunchBySession.set(sid, launches)
      }

      const taskSignature = deps.computeToolSignature("task", {
        subagent_type: subagentType,
        description,
        prompt,
      })
      const taskWindow = context.taskWindowBySession.get(sid) ?? []
      const taskEscalationsUsed = context.taskEscalationsBySession.get(sid) ?? 0
      const taskDecision = decideLoopIntervention({
        window: taskWindow,
        signature: taskSignature,
        repeatThreshold: context.taskWatchdogThreshold,
        interventionsUsed: taskEscalationsUsed,
        maxInterventions: context.taskWatchdogMaxEscalations,
      })

      if (taskDecision.exhausted) {
        console.log(
          `[turn-guard] task watchdog: repeated ${subagentType || "task"} ${taskDecision.count}x in sid=${sid} ` +
            `but escalation budget (${context.taskWatchdogMaxEscalations}) is spent; letting it through`,
        )
      } else if (taskDecision.shouldIntervene) {
        const routing = await deps.resolveLoopGuardRouting(sid, input, output)
        const swapTarget = deps.resolveTaskSwapTarget({
          current: routing.model,
          qwenMatch: context.taskSwapQwenMatch,
          qwenToProvider: context.taskSwapQwenToProvider,
          qwenToModel: context.taskSwapQwenToModel,
          gemmaMatch: context.taskSwapGemmaMatch,
          gemmaToProvider: context.taskSwapGemmaToProvider,
          gemmaToModel: context.taskSwapGemmaToModel,
          fallbackProvider: context.taskFallbackProvider,
          fallbackModel: context.taskFallbackModel,
        })

        if (swapTarget) {
          args.model = {
            providerID: swapTarget.providerID,
            modelID: swapTarget.modelID,
          }
          if (output?.args) output.args = args
          if (input?.args) input.args = args
          context.taskEscalationsBySession.set(sid, taskEscalationsUsed + 1)
          context.taskWindowBySession.delete(sid)

          console.log(
            `[turn-guard] task watchdog: escalating repeated ${subagentType || "task"} call ` +
              `(repeat ${taskDecision.count}x, escalation ${taskEscalationsUsed + 1}/${context.taskWatchdogMaxEscalations}) ` +
              `sid=${sid} -> ${swapTarget.providerID}/${swapTarget.modelID} (${swapTarget.reason})`,
          )
        }
      }

      // Phase 13 (worked-example injection): for @implement-local delegations,
      // append up to WORKED_EXAMPLE_MAX_INJECT relevant apprenticeship worked
      // examples as demonstrations. Runs AFTER the watchdog signature is computed
      // from the ORIGINAL prompt (the loop guard must see the pre-injection call),
      // and mutates args.prompt in place so both output.args and input.args carry
      // the augmented prompt. Any failure degrades to no injection — a retrieval
      // hiccup must never block or alter a delegation.
      const demonstrationHeading =
        "## Demonstrations: how this class of problem was solved in this codebase before"
      const injectDecision = deps.shouldInjectWorkedExamples({
        enabled: context.workedExampleInjectionEnabled,
        subagentType,
        prompt,
        heading: demonstrationHeading,
      })
      const hasPrompt = injectDecision.hasPrompt
      if (!injectDecision.shouldInject) {
        console.log(
          `[turn-guard] worked-example injection: skipped sid=${sid} ` +
            `(enabled=${context.workedExampleInjectionEnabled}, subagentType=${subagentType || ""}, ` +
            `hasPrompt=${hasPrompt}, promptAlreadyAugmented=${injectDecision.promptAlreadyAugmented})`,
        )
      }

      if (injectDecision.shouldInject) {
        try {
          const palaceClient = await context.getWorkedExampleClient()
          if (palaceClient) {
            const examples = await deps.retrieveSimilarWorkedExamples(palaceClient, {
              query: prompt,
              limit: deps.WORKED_EXAMPLE_MAX_INJECT,
              relevanceFloor: deps.WORKED_EXAMPLE_RELEVANCE_FLOOR,
            })
            const demonstration = deps.formatWorkedExampleDemonstration(examples)
            if (demonstration) {
              args.prompt = `${prompt}${demonstration}`
              if (output?.args) output.args = args
              if (input?.args) input.args = args
              console.log(
                `[turn-guard] worked-example injection: appended ${examples.length} example(s) ` +
                  `(top relevance ${examples[0].relevance.toFixed(2)}) to implement-local prompt sid=${sid}`,
              )
            } else {
              console.log(
                `[turn-guard] worked-example injection: no examples above floor (${deps.WORKED_EXAMPLE_RELEVANCE_FLOOR}) — prompt unchanged sid=${sid}`,
              )
            }
          }
        } catch (err) {
          console.log(`[turn-guard] worked-example injection: failed, prompt unchanged: ${String(err)}`)
        }
      }

      // Phase 15 CONSUME (prompt patches): inject known successful intervention
      // patches for the EXACT (model, shapeKey) pair. The model is resolved from
      // delegation context (hook args or session cache); the shape reuses Phase
      // 14's extractWorkedExampleShape on the ORIGINAL prompt (same text as the
      // CREATE side). Absent data => no injection, no prompt bloat. Any failure
      // degrades to no injection — a read hiccup must never block a delegation.
      if (context.failurePatchInjectionEnabled && hasPrompt) {
        try {
          const routing = await deps.resolveLoopGuardRouting(sid, input, output)
          const modelId = deps.canonicalModelId(routing.model?.providerID, routing.model?.modelID)
          if (modelId) {
            const shape = deps.extractWorkedExampleShape(prompt)
            const palaceClient = await context.getWorkedExampleClient()
            if (palaceClient && typeof palaceClient.kgQuery === "function") {
              // Bounded read: one kg_query per candidate label (max 3).
              const patchTexts: string[] = []
              for (const label of ["spiral-nudge", "retry-nudge", "loop-block"]) {
                const result: any = await palaceClient.kgQuery({
                  entity: deps.buildFailurePatchId(modelId, shape.shapeKey, label),
                  direction: "outgoing",
                  predicate: "es-intervention-text",
                  recurse: false,
                  max_depth: 1,
                })
                if (!result?.ok) {
                  // non-fatal: skip this label
                  console.log(
                    `[turn-guard] failure-patch injection: kg_query failed for ${label} (${result?.kind ?? "unknown"}): ${String(result?.detail ?? result)} sid=${sid}`
                  )
                  continue
                }
                const facts = Array.isArray(result.value?.facts) ? result.value.facts : []
                for (const fact of facts) {
                  if (fact && fact.current === false) continue
                  const t = String(fact?.object ?? "").trim()
                  if (t && !patchTexts.includes(t)) patchTexts.push(t)
                }
              }
              if (patchTexts.length > 0) {
                const patchHeading = "## Known failure modes for this model on this class of task"
                const patchBlock =
                  `\n\n---\n${patchHeading}\n\n` +
                  "This model has previously failed on this class of task in the ways below. " +
                  "Apply these interventions proactively:\n" +
                  patchTexts.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n---\n"
                args.prompt = `${args.prompt}${patchBlock}`
                if (output?.args) output.args = args
                if (input?.args) input.args = args
                console.log(
                  `[turn-guard] failure-patch injection: appended ${patchTexts.length} patch(es) ` +
                    `for ${modelId} (shape=${shape.shapeKey}) to ${subagentType || "task"} prompt sid=${sid}`,
                )
              } else {
                console.log(
                  `[turn-guard] failure-patch injection: no patches for ${modelId} shape=${shape.shapeKey} — prompt unchanged sid=${sid}`,
                )
              }
            }
          }
        } catch (err) {
          console.log(`[turn-guard] failure-patch injection: failed, prompt unchanged: ${String(err)}`)
        }
      }

      // Phase 14/15 CONSUME (live routing): consult capability + failure evidence
      // BEFORE the tier is chosen, and re-route the delegation to a different tier
      // when the evidence recommends it. ALWAYS ACTIVE — no feature flag. Neutral
      // fallback: if the palace is unavailable, the read throws, or the sample is
      // insufficient (fallback / no-data), decideCapabilityReroute returns null and
      // the existing routing outcome is preserved EXACTLY. Only a sufficient,
      // concrete recommendation for a DIFFERENT tier changes args.subagent_type.
      // Runs AFTER the watchdog signature was computed from the ORIGINAL args (the
      // loop guard must see the pre-reroute call) and mutates args in place so both
      // output.args and input.args carry the re-routed delegation. Any failure
      // degrades to no reroute — a read hiccup must never block or alter a unit.
      const requestedTier = deps.CAPABILITY_TIER_BY_SUBAGENT[subagentType]
      if (requestedTier && hasPrompt) {
        try {
          const routing = await deps.resolveLoopGuardRouting(sid, input, output)
          // The model pinned to the REQUESTED tier is what we penalize; sibling
          // tiers have no known pin in this codebase, so they stay null (unknown
          // => no penalty, per getFailureAdjustedRouting's documented semantics).
          const pinnedModel = deps.normalizeModelSpec(args.model)
          const effectiveModel =
            (pinnedModel ? deps.canonicalModelId(pinnedModel.providerID, pinnedModel.modelID) : null) ??
            deps.canonicalModelId(routing.model?.providerID, routing.model?.modelID)
          const shape = deps.extractWorkedExampleShape(prompt)
          const routingClient = await context.getRoutingEvidenceClient()
          if (routingClient && typeof routingClient.getFailureAdjustedRouting === "function") {
            const modelByTier: Record<string, string | null> = { local: null, cloud: null, deep: null }
            modelByTier[requestedTier] = effectiveModel
            const adjusted = await routingClient.getFailureAdjustedRouting(shape.shapeKey, modelByTier)
            const decision = deps.decideCapabilityReroute({
              requestedTier,
              recommendation: String(adjusted?.recommendation ?? ""),
              fallback: Boolean(adjusted?.fallback),
            })
            if (decision.rerouteTo) {
              const targetSubagent = deps.CAPABILITY_SUBAGENT_BY_TIER[decision.rerouteTo as keyof typeof deps.CAPABILITY_SUBAGENT_BY_TIER]
              if (targetSubagent && targetSubagent !== subagentType) {
                args.subagent_type = targetSubagent
                if (output?.args) output.args = args
                if (input?.args) input.args = args
                console.log(
                  `[turn-guard] capability routing: re-routing ${subagentType} (${requestedTier}) -> ` +
                    `${targetSubagent} (${decision.rerouteTo}) on evidence sid=${sid} shape=${shape.shapeKey}`,
                )
              } else {
                console.log(
                  `[turn-guard] capability routing: recommended ${decision.rerouteTo} has no distinct subagent — kept ${subagentType} sid=${sid}`,
                )
              }
            } else {
              console.log(
                `[turn-guard] capability routing: no reroute (${decision.reason}) for ${subagentType} ` +
                  `(${requestedTier}) sid=${sid} shape=${shape.shapeKey}`,
              )
            }
          }
        } catch (err) {
          // Neutral: a read/init failure must never alter the delegation.
          console.log(`[turn-guard] capability routing: failed, kept ${subagentType}: ${String(err)}`)
        }
      }

      // Phase 16 CONSUME (calibrated escalation): consult the calibration cell
      // for this (model, shape, confidence) BEFORE a subagent's self-reported
      // confidence is trusted at face value. ACTIVE BY DEFAULT — no feature
      // flag. The trust override requires >= CALIBRATION_OVERRIDE_MIN_SAMPLES
      // (5) recorded samples in the cell; below that, or on any read failure /
      // unavailable data, decideCalibratedEscalation returns defaultAction
      // "trust" and NOTHING changes — the existing baseline path is preserved
      // EXACTLY. A sufficient cell with a low measured hit rate flips the
      // decision to escalate: the delegation prompt gets a calibration note
      // telling the subagent its self-reported confidence at this level on this
      // shape is measured unreliable, so verify before acting. Runs AFTER the
      // watchdog signature was computed from the ORIGINAL args (the loop guard
      // must see the pre-injection call) and mutates args.prompt in place so
      // both output.args and input.args carry the augmented prompt. Any failure
      // degrades to no injection — a read hiccup must never block or alter a unit.
      const calibrationNoteHeading = "## Calibration note: your self-reported confidence is measured unreliable for this class of task"
      if (hasPrompt && !prompt.includes(calibrationNoteHeading)) {
        try {
          const routing = await deps.resolveLoopGuardRouting(sid, input, output)
          const pinnedModel = deps.normalizeModelSpec(args.model)
          const effectiveModel =
            (pinnedModel ? deps.canonicalModelId(pinnedModel.providerID, pinnedModel.modelID) : null) ??
            deps.canonicalModelId(routing.model?.providerID, routing.model?.modelID)
          if (effectiveModel) {
            const shape = deps.extractWorkedExampleShape(prompt)
            // The confidence the subagent is expected to self-report: the
            // delegation prompt's own terminal CONFIDENCE line when present,
            // otherwise "high" — the level whose trust we are gating. A
            // misreported label only changes which cell is read; the decision
            // stays neutral below the 5-sample floor either way.
            const reportedConfidence = deps.parseSelfReportedConfidence(prompt) ?? "high"
            const routingClient = await context.getRoutingEvidenceClient()
            if (routingClient && typeof routingClient.decideCalibratedEscalation === "function") {
              const decision = await routingClient.decideCalibratedEscalation({
                modelId: effectiveModel,
                shapeKey: shape.shapeKey,
                reportedConfidence,
                defaultAction: "trust",
                minHitRate: deps.CALIBRATION_MIN_HIT_RATE,
                minSample: deps.CALIBRATION_OVERRIDE_MIN_SAMPLES,
              })
              if (decision.action === "escalate") {
                const noteBlock = deps.buildCalibrationEscalationNote({
                  heading: calibrationNoteHeading,
                  modelId: effectiveModel,
                  reportedConfidence,
                  hitRate: decision.hitRate ?? 0,
                  total: decision.total,
                })
                args.prompt = `${args.prompt}${noteBlock}`
                if (output?.args) output.args = args
                if (input?.args) input.args = args
                console.log(
                  `[turn-guard] calibrated escalation: ESCALATE for ${effectiveModel} ` +
                    `(shape=${shape.shapeKey}, reported=${reportedConfidence}, hitRate=${decision.hitRate}) sid=${sid}`,
                )
              } else {
                console.log(
                  `[turn-guard] calibrated escalation: trust (${decision.reason}) for ${effectiveModel} ` +
                    `(shape=${shape.shapeKey}, reported=${reportedConfidence}) sid=${sid}`,
                )
              }
            }
          }
        } catch (err) {
          // Neutral: a read/init failure must never alter the delegation.
          console.log(`[turn-guard] calibrated escalation: failed, prompt unchanged: ${String(err)}`)
        }
      }

      // Phase 15 CONSUME (intervention replay): consult getFailureInterventions
      // for this (model, shape) — the intervention texts that previously BROKE a
      // loop on this exact model + task class — and inject them into the outgoing
      // delegation prompt: "last time this shape failed, here is what fixed it."
      // ALWAYS ACTIVE — no feature flag. Neutral fallback: no interventions
      // recorded, empty result, MCP unavailable, or a throwing read => the prompt
      // is left EXACTLY as-is (no mutation). Idempotent: the block heading is
      // checked against args.prompt (which may already carry earlier injections)
      // before appending, so a re-fired hook never doubles the block. Bounded by
      // INTERVENTION_REPLAY_MAX_PATCHES via getFailureInterventions' maxPatches
      // argument (the closed label vocabulary caps the read at 3 one-hop reads).
      // Runs AFTER the watchdog signature was computed from the ORIGINAL args and
      // mutates args.prompt in place so both output.args and input.args carry the
      // augmented prompt. Any failure degrades to no injection — a read hiccup
      // must never block or alter a unit.
      if (hasPrompt && !String(args?.prompt ?? "").includes(deps.INTERVENTION_REPLAY_HEADING)) {
        try {
          const routing = await deps.resolveLoopGuardRouting(sid, input, output)
          const pinnedModel = deps.normalizeModelSpec(args.model)
          const effectiveModel =
            (pinnedModel ? deps.canonicalModelId(pinnedModel.providerID, pinnedModel.modelID) : null) ??
            deps.canonicalModelId(routing.model?.providerID, routing.model?.modelID)
          if (effectiveModel) {
            const shape = deps.extractWorkedExampleShape(prompt)
            const routingClient = await context.getRoutingEvidenceClient()
            if (routingClient && typeof routingClient.getFailureInterventions === "function") {
              const interventions = await routingClient.getFailureInterventions(
                effectiveModel,
                shape.shapeKey,
                { maxPatches: deps.INTERVENTION_REPLAY_MAX_PATCHES },
              )
              const block = deps.formatInterventionBlock(interventions)
              if (block) {
                args.prompt = `${args.prompt}${block}`
                if (output?.args) output.args = args
                if (input?.args) input.args = args
                console.log(
                  `[turn-guard] intervention replay: appended ${interventions.length} intervention(s) ` +
                    `for ${effectiveModel} (shape=${shape.shapeKey}) to ${subagentType || "task"} prompt sid=${sid}`,
                )
              } else {
                console.log(
                  `[turn-guard] intervention replay: no interventions for ${effectiveModel} ` +
                    `shape=${shape.shapeKey} — prompt unchanged sid=${sid}`,
                )
              }
            }
          }
        } catch (err) {
          // Neutral: a read/init failure must never alter the delegation.
          console.log(`[turn-guard] intervention replay: failed, prompt unchanged: ${String(err)}`)
        }
      }

      taskWindow.push(taskSignature)
      while (taskWindow.length > context.loopWindowSize) taskWindow.shift()
      context.taskWindowBySession.set(sid, taskWindow)
    }

    const signature = deps.computeToolSignature(toolName, args)
    const window = context.toolWindowBySession.get(sid) ?? []
    const interventionsUsed = context.loopInterventionsBySession.get(sid) ?? 0

    const { count, shouldIntervene, exhausted } = decideLoopIntervention({
      window,
      signature,
      repeatThreshold: context.loopRepeatThreshold,
      interventionsUsed,
      maxInterventions: context.loopMaxInterventions,
    })

    if (exhausted) {
      console.log(
        `[turn-guard] loop guard: ${toolName} repeated ${count}x in sid=${sid} but the ` +
          `${context.loopMaxInterventions}-nudge budget is spent; letting it through`,
      )
      return
    }

    if (!shouldIntervene) {
      // A MUTATING tool called with NEW arguments is real progress: drop the
      // history that preceded it. Keep this call's own signature though --
      // seeding with [signature] instead of clearing outright is what lets an
      // immediately-repeated identical command still accumulate.
      //
      // This used to be an early return at the top of the handler, before the
      // repeat check ran at all. Because `bash` is in the mutation list, that
      // made repeated identical shell commands structurally INVISIBLE to the
      // guard -- and worse, every bash call wiped the window and erased the
      // history of every other tool too. bash mutates sometimes, but it is
      // also the most common READ tool (grep / ls / git status / test runs),
      // so "saw bash, therefore progress" was never a safe assumption.
      if (context.loopMutationTools.has(key) && count === 1) {
        context.toolWindowBySession.set(sid, [signature])
      } else {
        window.push(signature)
        while (window.length > context.loopWindowSize) window.shift()
        context.toolWindowBySession.set(sid, window)
      }
      // Phase 15 CREATE (success signal): the model's next tool call after a
      // blocked loop is a DIFFERENT signature than the one that was blocked —
      // deterministic evidence the nudge broke the loop. Persist the pending
      // loop-block patch; expire any other pending patches for this session.
      // Best-effort, never blocks or throws into the turn.
      void deps.confirmPendingInterventions({
        sid,
        confirmedKey: signature,
        model: deps.activeRoutingBySession.get(sid)?.model ?? null,
        taskText: `${toolName} ${JSON.stringify(args)}`,
      })
      return
    }

    // Nudge, then wipe the window so the model gets a clean slate to recover in
    // rather than tripping the guard again on its very next call.
    context.loopInterventionsBySession.set(sid, interventionsUsed + 1)
    context.toolWindowBySession.delete(sid)
    const nudge = interventionsUsed + 1
    console.log(
      `[turn-guard] loop guard: aborting ${toolName} (repeat ${count}x, nudge ${nudge}/${context.loopMaxInterventions}) sid=${sid}`,
    )

    // WORDING IS LOAD-BEARING (measured 2026-08-18). A softer version of this
    // message asked "are you looping?" and said "regroup before continuing" --
    // in practice the model answered the question, took "continuing" as
    // permission to proceed, and looped again. Manual interventions phrased as
    // "you're looping, stop and move forward" broke the loop; ones phrased as
    // "continue, you're looping, finish then move forward" did NOT. So: state
    // it, never ask it; forbid the specific call; say move forward, never
    // continue/finish/regroup; and do not invite narration, which just burns a
    // turn explaining the loop instead of leaving it.
    // 1) Block the tool call - the model gets a tool-error part and cannot
    //    keep hammering the identical call. This alone is invisible in some
    //    OpenCode surfaces: the error shows as a bare tool error, not a
    //    conversational turn, so the model never "hears" the nudge.
    const finalNudge = nudge >= context.loopMaxInterventions
    const nudgeText =
      `${deps.LOOP_GUARD_MARKER} STOP. You have called \`${toolName}\` ${count} times with identical ` +
      `arguments. You are looping.\n\n` +
      `This call was BLOCKED and did not run. Calling \`${toolName}\` with these arguments again will ` +
      `not produce a different result - the answer you already have is the answer.\n\n` +
      `Move forward now:\n` +
      `- Act on what you already have. The earlier identical call's result is in your context; use it.\n` +
      `- If you genuinely need something else, take a DIFFERENT action: different tool, different ` +
      `arguments, or a different approach to the problem.\n` +
      `- If you cannot proceed without information you are unable to obtain, say so plainly and stop. ` +
      `Do not retry.\n\n` +
      `Your next action must be different from the one just blocked. Do not explain the loop, do not ` +
      `apologise, and do not restate your plan - just take the next real step.` +
      (finalNudge
        ? `\n\nThis is the LAST time this will be blocked (${nudge}/${context.loopMaxInterventions}). If you ` +
          `repeat it after this, abandon this line of work entirely and report what you have with your ` +
          `remaining uncertainty stated.`
        : `\n\n(nudge ${nudge}/${context.loopMaxInterventions} this session)`)

    const routing = await deps.resolveLoopGuardRouting(sid, input, output)

    // 2) Deliver the same nudge as a real user message so it lands in the
    //    conversation context the model reads - this is what breaks the loop
    //    when the tool-error part alone doesn't register. noReply keeps it
    //    from spawning a second generation turn; the blocked call's own error
    //    path already triggers the retry/continue.
    try {
      const body: any = {
        noReply: true,
        parts: [{ type: "text", text: nudgeText }],
      }
      if (routing.agent) body.agent = routing.agent
      if (routing.model) body.model = routing.model

      await context.client.session.prompt({
        path: { id: sid },
        query: { directory: deps.directory },
        body,
      })
    } catch (promptErr) {
      // Best-effort: if the prompt injection fails, the thrown error below
      // still blocks the tool call. Log so the gap is diagnosable.
      console.error(`[turn-guard] loop guard: nudge prompt failed sid=${sid}:`, promptErr)
    }

    // Phase 15 CREATE: attribute the repeated-tool loop to (model, shape) at
    // nudge time. Task text = tool name + args (the shape function tolerates any
    // text; for non-task tools this is a coarse but deterministic shape). The
    // intervention text is only QUEUED — it becomes durable knowledge only if
    // the model's NEXT tool call has a different signature (see the
    // confirmPendingInterventions call below), which is deterministic proof the
    // loop was broken. Fire-and-forget — best-effort, never blocks.
    void deps.maybeRecordModelFailure({
      sid,
      model: routing.model ?? null,
      taskText: `${toolName} ${JSON.stringify(args)}`,
      event: "loop",
      interventionLabel: "loop-block",
      interventionText: nudgeText,
    })
    deps.queuePendingIntervention(sid, signature, "loop-block", nudgeText)

    throw new Error(nudgeText)
  }
}
