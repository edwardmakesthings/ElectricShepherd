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
