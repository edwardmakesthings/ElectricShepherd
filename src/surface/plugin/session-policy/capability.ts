// @ts-nocheck

// Domain category: capability tuple recording.
// Moved verbatim from pure-helpers.ts — see the compatibility re-export there.

import type { MessageWithParts } from "./constants.ts"

export async function maybeRecordCapabilityTupleWithGating(args: {

  sid: string

  subagentType: string

  description: string

  prompt: string

  status: string

  capabilityRecordingEnabled: boolean

  capabilityTierBySubagent: Record<string, string>

  capabilityRecordedBySession: Map<string, Set<string>>

  getWorkedExampleClient: () => Promise<any>

  mapTaskStatusToCapabilityOutcome: (status: string) => string | null

  extractWorkedExampleShape: (taskText: string) => { shapeKey: string; workClass: string; sizeBucket: string }

  buildCapabilityBucketId: (shapeKey: string, tier: string) => string

  buildCapabilityCanonicalShape: (shape: { shapeKey: string; workClass: string; sizeBucket: string }) => string

}): Promise<void> {

  if (!args.capabilityRecordingEnabled) return

  const { sid, subagentType, description, prompt, status } = args



  const tier = args.capabilityTierBySubagent[subagentType]

  if (!tier) return



  const outcome = args.mapTaskStatusToCapabilityOutcome(status)

  if (!outcome) return



  const shape = args.extractWorkedExampleShape(`${description}\n${prompt}`)

  const dedupKey = `${subagentType}:${shape.shapeKey}`

  const recordedBySession = args.capabilityRecordedBySession.get(sid) ?? new Set<string>()

  if (recordedBySession.has(dedupKey)) {

    console.log(

      `[turn-guard] capability recording: skipping duplicate ${dedupKey} sid=${sid}`,

    )

    return

  }



  const bucketId = args.buildCapabilityBucketId(shape.shapeKey, tier)

  const canonicalShape = args.buildCapabilityCanonicalShape(shape)



  try {

    const palaceClient = await args.getWorkedExampleClient()

    if (!palaceClient || typeof palaceClient.kgAdd !== "function") return



    const outcomeResult: any = await palaceClient.kgAdd({

      subject: bucketId,

      predicate: "es-capability-outcome",

      object: outcome,

      valid_from: new Date().toISOString(),

      source_closet: bucketId,

    })

    if (!outcomeResult?.ok) {

      console.log(

        `[turn-guard] capability recording: failed (${outcomeResult?.kind ?? "unknown"}): ${String(outcomeResult?.detail ?? outcomeResult)} sid=${sid}`

      )

      return

    }



    const shapeResult: any = await palaceClient.kgAdd({

      subject: bucketId,

      predicate: "es-capability-shape",

      object: canonicalShape.slice(0, 200),

      source_closet: bucketId,

    })

    if (!shapeResult?.ok) {

      console.log(

        `[turn-guard] capability recording: shape stamp failed (non-fatal; ${shapeResult?.kind ?? "unknown"}): ${String(shapeResult?.detail ?? shapeResult)} sid=${sid}`

      )

    }

    const tierResult: any = await palaceClient.kgAdd({

      subject: bucketId,

      predicate: "es-capability-tier",

      object: tier,

      source_closet: bucketId,

    })

    if (!tierResult?.ok) {

      console.log(

        `[turn-guard] capability recording: tier stamp failed (non-fatal; ${tierResult?.kind ?? "unknown"}): ${String(tierResult?.detail ?? tierResult)} sid=${sid}`

      )

    }



    recordedBySession.add(dedupKey)

    args.capabilityRecordedBySession.set(sid, recordedBySession)



    console.log(

      `[turn-guard] capability recording: recorded ${subagentType} -> ${tier} (${outcome}) ` +

        `(shape=${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}, bucket=${bucketId}) sid=${sid}`,

    )

  } catch (err) {

    console.log(`[turn-guard] capability recording: failed, continuing: ${String(err)}`)

  }

}

export async function maybeCaptureCalibrationTupleWithGating(args: {

  sid: string

  model?: { providerID: string; modelID: string } | null

  description: string

  prompt: string

  outputText: string

  calibrationCaptureEnabled: boolean

  pendingCalibrationBySession: Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>

  canonicalModelId: (providerID?: string, modelID?: string) => string | null

  extractWorkedExampleShape: (taskText: string) => { shapeKey: string; workClass: string; sizeBucket: string }

  parseSelfReportedConfidence: (outputText: string) => string | null

  buildCalibrationBucketId: (modelId: string, shapeKey: string, confidence: string) => string

}): Promise<void> {

  if (!args.calibrationCaptureEnabled) return

  const { sid, model, description, prompt, outputText } = args


  // Gate 1: deterministic model identity — unknown model => skip (no guessing).
  const modelId = args.canonicalModelId(model?.providerID, model?.modelID)

  if (!modelId) return


  // Gate 2: shape from the SAME capability shape function.
  const shape = args.extractWorkedExampleShape(`${description}\n${prompt}`)


  // Gate 3: parse the self-reported confidence from the terminal output.
  // Returns null when no CONFIDENCE line is present — skip, don't guess.
  const confidence = args.parseSelfReportedConfidence(outputText)

  if (!confidence) return


  // Queue the pending tuple for this session. Dedup: same (modelId, shapeKey, confidence)
  // is recorded once per session (repeated idle events on the same completion).
  const pending = args.pendingCalibrationBySession.get(sid) ?? []

  const dedupKey = `${modelId}:${shape.shapeKey}:${confidence}`

  if (pending.some((p) => `${p.modelId}:${p.shapeKey}:${p.confidence}` === dedupKey)) return


  pending.push({ modelId, shapeKey: shape.shapeKey, confidence })

  args.pendingCalibrationBySession.set(sid, pending)


  console.log(

    `[turn-guard] calibration capture: queued ${modelId} / ${shape.shapeKey} / ${confidence} ` +

      `(bucket=${args.buildCalibrationBucketId(modelId, shape.shapeKey, confidence)}) sid=${sid}`,

  )

}
