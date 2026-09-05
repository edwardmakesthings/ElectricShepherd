// @ts-nocheck

// Domain category: mem-core reinjection intervention.
// `maybeInjectMemcoreWithGating` moved verbatim to ./memcore-handler.ts —
// re-exported here so existing callers keep working.

export { maybeInjectMemcoreWithGating } from "./memcore-handler.ts"



export async function persistWorkedInterventionWithGating(args: {

  sid: string

  model?: { providerID: string; modelID: string } | null

  taskText: string

  interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"

  interventionText: string

  failureRecordingEnabled: boolean

  canonicalModelId: (providerID?: string, modelID?: string) => string | null

  extractWorkedExampleShape: (taskText: string) => { shapeKey: string; workClass: string; sizeBucket: string }

  failurePatchTextMaxChars: number

  getWorkedExampleClient: () => Promise<any>

  buildFailurePatchId: (modelId: string, shapeKey: string, interventionLabel: string) => string

}): Promise<void> {

  if (!args.failureRecordingEnabled) return

  const { sid, model, taskText, interventionLabel, interventionText } = args


  // Gate 1: deterministic model identity — unknown model => skip (no guessing).
  const modelId = args.canonicalModelId(model?.providerID, model?.modelID)

  if (!modelId) return


// Gate 2: shape from the SAME capability shape function.
  const shape = args.extractWorkedExampleShape(taskText)

  const text = String(interventionText || "").trim().slice(0, args.failurePatchTextMaxChars)

  if (!text) return


  try {

    const palaceClient = await args.getWorkedExampleClient()

    if (palaceClient && typeof palaceClient.kgAdd === "function") {

      const patchId = args.buildFailurePatchId(modelId, shape.shapeKey, interventionLabel)

      const labelResult: any = await palaceClient.kgAdd({

        subject: patchId,

        predicate: "es-intervention-label",

        object: interventionLabel,

        source_closet: patchId,

      })

      if (!labelResult?.ok) {

        console.log(

          `[turn-guard] failure recording: intervention failed (${labelResult?.kind ?? "unknown"}): ${String(labelResult?.detail ?? labelResult)} sid=${sid}`

        )

        return

      }

      const textResult: any = await palaceClient.kgAdd({

        subject: patchId,

        predicate: "es-intervention-text",

        object: text,

        source_closet: patchId,

      })

      if (!textResult?.ok) {

        console.log(

          `[turn-guard] failure recording: intervention failed (${textResult?.kind ?? "unknown"}): ${String(textResult?.detail ?? textResult)} sid=${sid}`

        )

        return

      }

      console.log(

        `[turn-guard] failure recording: WORKED intervention ${interventionLabel} persisted ` +

          `for ${modelId} (shape=${shape.shapeKey}, patch=${patchId}) sid=${sid}`,

      )

    }

  } catch (err) {

    // Intervention recording failure must never break the turn.
    console.log(`[turn-guard] failure recording: intervention failed, continuing: ${String(err)}`)

  }

}


export async function maybeRecordModelFailureWithGating(args: {

  sid: string

  model?: { providerID: string; modelID: string } | null

  taskText: string

  event: "spiral" | "loop"

  interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"

  interventionText: string

  failureRecordingEnabled: boolean

  failureRecordedBySession: Map<string, Set<string>>

  canonicalModelId: (providerID?: string, modelID?: string) => string | null

  extractWorkedExampleShape: (taskText: string) => { shapeKey: string; workClass: string; sizeBucket: string }

  buildFailureBucketId: (modelId: string, shapeKey: string) => string

  getWorkedExampleClient: () => Promise<any>

  buildCapabilityCanonicalShape: (shape: { shapeKey: string; workClass: string; sizeBucket: string }) => string

}): Promise<void> {

  if (!args.failureRecordingEnabled) return

  const { sid, model, taskText, event } = args


  // Gate 1: deterministic model identity — unknown model => skip (no guessing).
  const modelId = args.canonicalModelId(model?.providerID, model?.modelID)

  if (!modelId) return


  // Gate 2: shape from the SAME capability shape function.
  const shape = args.extractWorkedExampleShape(taskText)


  // Gate 3: session-local dedup — repeated identical (bucket, event) in one
  // session records once (the pattern is already captured; a second nudge on the
  // same bucket adds nothing to the count).
  const bucketId = args.buildFailureBucketId(modelId, shape.shapeKey)

  const dedupKey = `${bucketId}:${event}`

  const recordedBySession = args.failureRecordedBySession.get(sid) ?? new Set<string>()

  if (recordedBySession.has(dedupKey)) {

    console.log(

      `[turn-guard] failure recording: skipping duplicate ${dedupKey} sid=${sid}`,

    )

    return

  }


  try {

    const palaceClient = await args.getWorkedExampleClient()

    if (palaceClient && typeof palaceClient.kgAdd === "function") {

      const eventResult: any = await palaceClient.kgAdd({

        subject: bucketId,

        predicate: "es-failure-event",

        object: event,

        valid_from: new Date().toISOString(),

        source_closet: bucketId,

      })

      if (!eventResult?.ok) {

        console.log(

          `[turn-guard] failure recording: event failed (${eventResult?.kind ?? "unknown"}): ${String(eventResult?.detail ?? eventResult)} sid=${sid}`

        )

        return

      }

      // Best-effort shape metadata for explainability (idempotent on the read side).
      const shapeResult: any = await palaceClient.kgAdd({

        subject: bucketId,

        predicate: "es-failure-shape",

        object: args.buildCapabilityCanonicalShape(shape).slice(0, 200),

        source_closet: bucketId,

      })

      if (!shapeResult?.ok) {

        console.log(

          `[turn-guard] failure recording: shape stamp failed (non-fatal; ${shapeResult?.kind ?? "unknown"}): ${String(shapeResult?.detail ?? shapeResult)} sid=${sid}`

        )

      }

      recordedBySession.add(dedupKey)

      args.failureRecordedBySession.set(sid, recordedBySession)

      console.log(

        `[turn-guard] failure recording: recorded ${event} for ${modelId} ` +

          `(shape=${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}, bucket=${bucketId}) sid=${sid}`,

      )

    }

  } catch (err) {

    // Recording failure must never break the turn.
    console.log(`[turn-guard] failure recording: event failed, continuing: ${String(err)}`)

  }

}


export function queuePendingInterventionWithGating(args: {

  sid: string

  key: string

  label: string

  text: string

  failureRecordingEnabled: boolean

  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>

  failurePatchTextMaxChars: number

}): void {

  if (!args.failureRecordingEnabled) return

  const t = String(args.text || "").trim().slice(0, args.failurePatchTextMaxChars)

  if (!t) return

  const list = args.pendingInterventionBySession.get(args.sid) ?? []

  const next = list.filter((p) => p.key !== args.key)

  next.push({ key: args.key, label: args.label, text: t })

  // Bound the queue: at most one pending entry per guard site (3 sites), so a
  // pathological session cannot grow this unbounded.
  while (next.length > 6) next.shift()

  args.pendingInterventionBySession.set(args.sid, next)

}


export async function confirmPendingInterventionsWithGating(args: {

  sid: string

  confirmedKey?: string

  model?: { providerID: string; modelID: string } | null

  taskText: string

  failureRecordingEnabled: boolean

  pendingInterventionBySession: Map<string, Array<{ key: string; label: string; text: string }>>

  persistWorkedInterventionWithGating: (args: {

    sid: string

    model?: { providerID: string; modelID: string } | null

    taskText: string

    interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"

    interventionText: string

  }) => Promise<void>

}): Promise<void> {

  if (!args.failureRecordingEnabled) return

  const { sid, confirmedKey, model, taskText } = args

  const list = args.pendingInterventionBySession.get(sid) ?? []

  if (list.length === 0) return

  const confirmed = confirmedKey ? list.filter((p) => p.key === confirmedKey) : []

  const expired = list.filter((p) => !confirmedKey || p.key !== confirmedKey)

  args.pendingInterventionBySession.delete(sid)

  for (const entry of expired) {

    console.log(

      `[turn-guard] failure recording: intervention ${entry.label} NOT proven to work — expired, not persisted sid=${sid}`,

    )

  }

  if (confirmed.length === 0) return

  for (const entry of confirmed) {

    try {

      await args.persistWorkedInterventionWithGating({

        sid,

        model: model ?? null,

        taskText,

        interventionLabel: entry.label as "spiral-nudge" | "retry-nudge" | "loop-block",

        interventionText: entry.text,

      })

    } catch (err) {

      console.log(`[turn-guard] failure recording: confirm failed, continuing: ${String(err)}`)

    }

  }

}
