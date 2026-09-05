// @ts-nocheck

// Domain category: session/event routing and identity resolution.
// Moved verbatim from pure-helpers.ts — see the compatibility re-export there.

import { existsSync } from "node:fs"
import { normalizePathForHost } from "./constants.ts"
import type { MessageWithParts } from "./constants.ts"

export function findSessionID(event: any): string {

  return String(

    event?.sessionID ??

    event?.sessionId ??

    event?.properties?.sessionID ??

    event?.properties?.sessionId ??

    event?.info?.sessionID ??

    event?.message?.info?.sessionID ??

    "",

  )

}

export function resolveScopeDirFromEvent(event: any, fallbackDirectory: string, configuredScopeDir?: string): string {

  const candidates = [

    event?.properties?.cwd,

    event?.properties?.workingDirectory,

    event?.properties?.directory,

    event?.properties?.path,

    event?.properties?.info?.cwd,

    event?.message?.info?.cwd,

    configuredScopeDir,

    fallbackDirectory,

    process.cwd(),

  ]

    .map((value) => String(value || "").trim())

    .filter(Boolean)



  for (const candidate of candidates) {

    const normalized = normalizePathForHost(candidate)

    if (normalized && existsSync(normalized)) {

      return normalized

    }

  }

  return normalizePathForHost(fallbackDirectory) || process.cwd()

}

export function getAgentIdentity(msg: MessageWithParts | null | undefined): string {

  const fromInfo = String(msg?.info?.agent ?? msg?.info?.mode ?? "").trim().toLowerCase()

  return fromInfo

}

export function getActiveModel(msg: MessageWithParts | null | undefined): { providerID: string; modelID: string } | null {

  if (!msg?.info) return null



  const embedded = msg.info.model

  if (embedded && typeof embedded === "object") {

    const providerID = String(embedded.providerID ?? "")

    const modelID = String(embedded.modelID ?? "")

    if (providerID && modelID) return { providerID, modelID }

  }



  const providerID = String(msg.info.providerID ?? "")

  const modelID = String(msg.info.modelID ?? "")

  if (providerID && modelID) return { providerID, modelID }



  return null

}

export function getActiveAgent(msg: MessageWithParts | null | undefined): string | null {

  if (!msg?.info) return null

  const explicitAgent = String(msg.info.agent ?? "").trim()

  if (explicitAgent) return explicitAgent

  const modeFallback = String(msg.info.mode ?? "").trim()

  if (modeFallback) return modeFallback

  return null

}

export function getPromptRouting(...candidates: Array<MessageWithParts | null | undefined>): {

  agent?: string

  model?: { providerID: string; modelID: string }

} {

  let agent: string | undefined

  let model: { providerID: string; modelID: string } | undefined



  for (const msg of candidates) {

    if (!agent) {

      const resolvedAgent = getActiveAgent(msg)

      if (resolvedAgent) agent = resolvedAgent

    }

    if (!model) {

      const resolvedModel = getActiveModel(msg)

      if (resolvedModel) model = resolvedModel

    }

    if (agent && model) break

  }



  const routing: {

    agent?: string

    model?: { providerID: string; modelID: string }

  } = {}

  if (agent) routing.agent = agent

  if (model) routing.model = model

  return routing

}

export function normalizeModelSpec(candidate: any): { providerID: string; modelID: string } | null {

  if (!candidate || typeof candidate !== "object") return null



  const providerID = String(

    candidate.providerID ?? candidate.providerId ?? candidate.provider ?? "",

  ).trim()

  const modelID = String(

    candidate.modelID ?? candidate.modelId ?? candidate.model ?? candidate.id ?? "",

  ).trim()



  if (providerID && modelID) return { providerID, modelID }

  return null

}

export async function resolveSessionPromptRoutingWithGating(args: {
  sid: string
  client: any
  directory: string
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  getPromptRouting: (...candidates: Array<MessageWithParts | null | undefined>) => { agent?: string; model?: { providerID: string; modelID: string } }
  unwrapListResult: (res: any) => MessageWithParts[]
  sortByCreated: (messages: MessageWithParts[]) => MessageWithParts[]
}): Promise<{
  agent?: string
  model?: { providerID: string; modelID: string }
}> {
  const cached = args.activeRoutingBySession.get(args.sid) ?? {}
  let agent = cached.agent
  let model = cached.model

  if (agent && model) {
    return { agent, model }
  }

  try {
    const res: any = await args.client.session.messages({
      path: { id: args.sid },
      query: { directory: args.directory },
    })
    const messages = args.sortByCreated(args.unwrapListResult(res))
    const tail = messages[messages.length - 1] ?? null
    const previous = messages.length > 1 ? messages[messages.length - 2] : null
    const fromSession = args.getPromptRouting(tail, previous)

    if (!agent) agent = fromSession.agent
    if (!model) model = fromSession.model
  } catch {
    // best-effort: keep hook/cached routing only
  }

  const resolved: {
    agent?: string
    model?: { providerID: string; modelID: string }
  } = {}
  if (agent) resolved.agent = agent
  if (model) resolved.model = model
  if (resolved.agent || resolved.model) {
    args.activeRoutingBySession.set(args.sid, resolved)
  }
  return resolved
}

export async function resolveLoopGuardRoutingWithGating(args: {
  sid: string
  input: any
  output: any
  getPromptRoutingFromToolHook: (input: any, output: any) => { agent?: string; model?: { providerID: string; modelID: string } }
  activeRoutingBySession: Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>
  resolveSessionPromptRouting: (sid: string) => Promise<{ agent?: string; model?: { providerID: string; modelID: string } }>
}): Promise<{
  agent?: string
  model?: { providerID: string; modelID: string }
}> {
  const fromHook = args.getPromptRoutingFromToolHook(args.input, args.output)
  const cached = args.activeRoutingBySession.get(args.sid) ?? {}
  let agent = fromHook.agent || cached.agent
  let model = fromHook.model || cached.model

  if (agent && model) {
    return { agent, model }
  }

  const fromSession = await args.resolveSessionPromptRouting(args.sid)
  if (!agent) agent = fromSession.agent
  if (!model) model = fromSession.model

  const resolved: {
    agent?: string
    model?: { providerID: string; modelID: string }
  } = {}
  if (agent) resolved.agent = agent
  if (model) resolved.model = model
  if (resolved.agent || resolved.model) {
    args.activeRoutingBySession.set(args.sid, resolved)
  }
  return resolved
}

export function resolveTaskSwapTarget(args: {
  current?: { providerID: string; modelID: string } | undefined
  qwenMatch: string
  qwenToProvider?: string
  qwenToModel?: string
  gemmaMatch: string
  gemmaToProvider?: string
  gemmaToModel?: string
  fallbackProvider?: string
  fallbackModel?: string
}): { providerID: string; modelID: string; reason: string } | null {
  const currentProvider = String(args.current?.providerID ?? "").trim()
  const currentModel = String(args.current?.modelID ?? "").trim().toLowerCase()
  const qwenMatch = String(args.qwenMatch || "").trim().toLowerCase()
  const gemmaMatch = String(args.gemmaMatch || "").trim().toLowerCase()

  const qwenToModel = String(args.qwenToModel || "").trim()
  const qwenToProvider = String(args.qwenToProvider || currentProvider).trim()
  const gemmaToModel = String(args.gemmaToModel || "").trim()
  const gemmaToProvider = String(args.gemmaToProvider || currentProvider).trim()
  const fallbackModel = String(args.fallbackModel || "").trim()
  const fallbackProvider = String(args.fallbackProvider || currentProvider).trim()

  if (qwenMatch && currentModel.includes(qwenMatch) && qwenToProvider && qwenToModel) {
    return {
      providerID: qwenToProvider,
      modelID: qwenToModel,
      reason: `matched ${qwenMatch}`,
    }
  }

  if (gemmaMatch && currentModel.includes(gemmaMatch) && gemmaToProvider && gemmaToModel) {
    return {
      providerID: gemmaToProvider,
      modelID: gemmaToModel,
      reason: `matched ${gemmaMatch}`,
    }
  }

  if (fallbackProvider && fallbackModel) {
    return {
      providerID: fallbackProvider,
      modelID: fallbackModel,
      reason: "fallback",
    }
  }

  return null
}

export function getPromptRoutingFromToolHook(input: any, output: any): {
  agent?: string
  model?: { providerID: string; modelID: string }
} {
  const routing: {
    agent?: string
    model?: { providerID: string; modelID: string }
  } = {}

  const agentCandidates = [
    output?.agent,
    input?.agent,
    output?.mode,
    input?.mode,
  ]
  for (const candidate of agentCandidates) {
    const value = String(candidate ?? "").trim()
    if (!value) continue
    routing.agent = value
    break
  }

  const modelCandidates = [
    output?.model,
    input?.model,
    {
      providerID: output?.providerID,
      modelID: output?.modelID,
    },
    {
      providerID: input?.providerID,
      modelID: input?.modelID,
    },
  ]
  for (const candidate of modelCandidates) {
    const normalized = normalizeModelSpec(candidate)
    if (!normalized) continue
    routing.model = normalized
    break
  }

  return routing
}

