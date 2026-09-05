// @ts-nocheck

// Domain category: worked-example filing (Phase 13 CREATE).
// Moved verbatim from pure-helpers.ts — see the compatibility re-export there.

import type { MessageWithParts } from "./constants.ts"

export async function maybeFileWorkedExampleWithGating(args: {

  sid: string

  subagentType: string

  description: string

  prompt: string

  output: string

  workedExampleFilingEnabled: boolean

  workedExampleFileAgentTypes: Set<string>

  workedExampleMinSubstantiveChars: number

  workedExampleFiledByShape: Map<string, Map<string, number>>

  getWorkedExampleClient: () => Promise<any>

  cfgRaw: (path: string) => string

  shouldFileWorkedExample: (input: {

    enabled: boolean

    isTargetSubagentType: boolean

    output: string

    minSubstantiveChars: number

  }) => boolean

  extractWorkedExampleShape: (taskText: string) => { shapeKey: string; workClass: string }

  shouldSkipWorkedExampleByCooldown: (input: {

    nowMs: number

    lastFiledAtMs: number

    cooldownMs: number

  }) => boolean

  buildWorkedExampleEntry: (input: {

    subagentType: string

    description: string

    output: string

    shape: { shapeKey: string; workClass: string }

  }) => string

}): Promise<void> {

  const { sid, subagentType, description, prompt, output } = args



  const isTargetSubagentType = args.workedExampleFileAgentTypes.has(subagentType)

  if (

    !args.shouldFileWorkedExample({

      enabled: args.workedExampleFilingEnabled,

      isTargetSubagentType,

      output,

      minSubstantiveChars: args.workedExampleMinSubstantiveChars,

    })

  ) {

    return

  }

  const trimmedOutput = String(output || "").trim()



  const shape = args.extractWorkedExampleShape(`${description}\n${prompt}`)

  const filedBySession = args.workedExampleFiledByShape.get(sid) ?? new Map<string, number>()

  const nowMs = Date.now()

  const lastFiledAt = Number(filedBySession.get(shape.shapeKey) ?? 0)

  if (args.shouldSkipWorkedExampleByCooldown({ nowMs, lastFiledAtMs: lastFiledAt, cooldownMs: 30 * 60 * 1000 })) {

    console.log(

      `[turn-guard] worked-example filing: skipping near-duplicate shape ${shape.shapeKey} ` +

        `(filed ${Math.round((nowMs - lastFiledAt) / 1000)}s ago) sid=${sid}`,

    )

    return

  }



  const entry = args.buildWorkedExampleEntry({ subagentType, description, output: trimmedOutput, shape })

  const wing = String(args.cfgRaw("memory.projectWing") || "").trim() || "opencode"

  const room = "apprenticeship"



  try {

    const palaceClient = await args.getWorkedExampleClient()

    if (!palaceClient || typeof palaceClient.diaryWrite !== "function") return



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



    filedBySession.set(shape.shapeKey, nowMs)

    args.workedExampleFiledByShape.set(sid, filedBySession)



    console.log(

      `[turn-guard] worked-example filing: filed ${subagentType} example ` +

        `(shape=${shape.workClass}/${shape.shapeKey}, drawer=${drawerId || "?"}) sid=${sid}`,

    )

  } catch (err) {

    console.log(`[turn-guard] worked-example filing: failed, continuing: ${String(err)}`)

  }

}

export async function maybeFileWorkedExamplesFromMessageWithGating(args: {
  sid: string
  msg: any
  workedExampleFilingEnabled: boolean
  workedExampleFileAgentTypes: Set<string>
  workedExampleMinSubstantiveChars: number
  getActiveModel: (msg: any) => { providerID: string; modelID: string } | null
  maybeFileWorkedExampleWithGating: (input: { sid: string; subagentType: string; description: string; prompt: string; output: string }) => Promise<void>
  maybeRecordCapabilityTupleWithGating: (input: { sid: string; subagentType: string; description: string; prompt: string; status: string }) => Promise<void>
  maybeCaptureCalibrationTupleWithGating: (input: { sid: string; model?: { providerID: string; modelID: string } | null; description: string; prompt: string; outputText: string }) => Promise<void>
}): Promise<void> {
  const parts = args.msg?.parts ?? []
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
    if (args.workedExampleFilingEnabled && args.workedExampleFileAgentTypes.has(subagentType)) {
      if (status === "error" || status === "aborted" || status === "failed") continue

      const outputText = String(
        state?.output ?? part?.output ?? state?.text ?? "",
      ).trim()
      if (outputText.length < args.workedExampleMinSubstantiveChars) continue

      await args.maybeFileWorkedExampleWithGating({ sid: args.sid, subagentType, description, prompt, output: outputText })
    }

    // Phase 14 CREATE: record a capability tuple for routing-tier subagents.
    // Runs regardless of the worked-example filing gate — capability recording
    // is its own concern (it covers local/cloud/deep tiers, not just cloud).
    await args.maybeRecordCapabilityTupleWithGating({ sid: args.sid, subagentType, description, prompt, status })

    // Phase 16 CREATE: capture the self-reported confidence label from the
    // subagent's terminal output. Runs for ANY task tool part with substantive
    // output (not gated on routing tier — calibration covers all delegated units).
    // The tuple is PENDING; it becomes durable only via record_outcome.
    const outputText = String(state?.output ?? part?.output ?? state?.text ?? "").trim()
    if (outputText.length >= args.workedExampleMinSubstantiveChars) {
      const activeModel = args.getActiveModel(args.msg)
      await args.maybeCaptureCalibrationTupleWithGating({ sid: args.sid, model: activeModel, description, prompt, outputText })
    }
  }
}
