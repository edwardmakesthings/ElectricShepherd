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
