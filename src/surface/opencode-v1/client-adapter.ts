type LegacyPromptRequest = {
  path?: { id?: string }
  body?: {
    parts?: Array<{ type?: string; text?: string }>
    text?: string
    metadata?: Record<string, unknown>
    delivery?: "steer" | "queue"
    resume?: boolean
    noReply?: boolean
    agent?: string
  }
}

type LegacyMessageRequest = {
  path?: { id?: string; messageID?: string }
}

type SessionLike = {
  context: (input: { sessionID: string }) => Promise<unknown[]>
  synthetic?: (input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, any>
    delivery?: "steer" | "queue"
    resume?: boolean
  }) => Promise<unknown>
  message?: {
    get: (input: { sessionID: string; messageID: string }) => Promise<unknown>
  }
  prompt: (input: {
    sessionID: string
    text: string
    metadata?: Record<string, any>
    delivery?: "steer" | "queue"
    resume?: boolean
    agents?: Array<{ name: string }>
  }) => Promise<unknown>
}

function getRoleFromType(type: string): string {
  if (type === "assistant" || type === "user" || type === "system") return type
  return "assistant"
}

function toLegacyParts(message: any): any[] {
  if (message?.type === "assistant") {
    const content = Array.isArray(message?.content) ? message.content : []
    return content.flatMap((part) => {
      if (part?.type === "text" && typeof part?.text === "string") {
        return [{ type: "text", text: part.text }]
      }
      if (part?.type === "reasoning" && typeof part?.text === "string") {
        return [{ type: "reasoning", text: part.text }]
      }
      if (part?.type === "tool") {
        const state = part?.state && typeof part.state === "object" ? part.state : {}
        return [{
          type: "tool",
          tool: String(part?.name ?? ""),
          callID: String(part?.id ?? ""),
          state,
          input: state?.input,
          content: state?.content,
          error: state?.error,
        }]
      }
      return []
    })
  }

  if (message?.type === "user" && typeof message?.text === "string") {
    return [{ type: "text", text: message.text }]
  }

  return []
}

function toLegacyMessage(message: any): any {
  const role = getRoleFromType(String(message?.type ?? "assistant"))
  return {
    info: {
      id: String(message?.id ?? ""),
      role,
      finish: message?.finish,
      parentID: String(message?.metadata?.parentID ?? message?.parentID ?? ""),
      time: message?.time,
      agent: message?.agent,
      mode: message?.metadata?.mode,
      model: message?.model,
    },
    parts: toLegacyParts(message),
  }
}

function textFromLegacyPrompt(body: LegacyPromptRequest["body"]): string {
  if (typeof body?.text === "string" && body.text.trim().length > 0) return body.text
  const parts = Array.isArray(body?.parts) ? body.parts : []
  return parts
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim()
}

export function createLegacyClientAdapter(session: SessionLike) {
  return {
    session: {
      async messages(input: LegacyMessageRequest) {
        const sessionID = String(input?.path?.id ?? "")
        if (!sessionID) return { data: [] }
        const messages = await session.context({ sessionID })
        return { data: (messages as any[]).map(toLegacyMessage) }
      },
      async message(input: LegacyMessageRequest) {
        const sessionID = String(input?.path?.id ?? "")
        const messageID = String(input?.path?.messageID ?? "")
        if (!sessionID || !messageID) return { data: null }
        if (session.message?.get) {
          const message = await session.message.get({ sessionID, messageID })
          return { data: toLegacyMessage(message) }
        }
        const messages = await session.context({ sessionID })
        const found = (messages as any[]).find((message) => String((message as any)?.id ?? "") === messageID)
        return { data: found ? toLegacyMessage(found) : null }
      },
      async prompt(input: LegacyPromptRequest) {
        const sessionID = String(input?.path?.id ?? "")
        if (!sessionID) return
        const text = textFromLegacyPrompt(input?.body)
        if (!text) return
        const agentName = String(input?.body?.agent ?? "").trim()
        const metadata = {
          ...(input?.body?.metadata ?? {}),
          ...(input?.body?.noReply ? { noReply: true } : {}),
        }
        if (input?.body?.noReply && session.synthetic) {
          await session.synthetic({
            sessionID,
            text,
            description: "Electric Shepherd loop guard nudge",
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            ...(input?.body?.delivery ? { delivery: input.body.delivery } : {}),
            ...(typeof input?.body?.resume === "boolean" ? { resume: input.body.resume } : {}),
          })
          return
        }

        await session.prompt({
          sessionID,
          text,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          ...(input?.body?.delivery ? { delivery: input.body.delivery } : {}),
          ...(typeof input?.body?.resume === "boolean" ? { resume: input.body.resume } : {}),
          ...(agentName ? { agents: [{ name: agentName }] } : {}),
        })
      },
    },
  }
}

export function toLegacyEvent(event: any): any | null {
  switch (String(event?.type ?? "")) {
    case "session.step.ended":
      return {
        type: "message.updated",
        properties: {
          info: {
            sessionID: String(event?.data?.sessionID ?? ""),
            id: String(event?.data?.assistantMessageID ?? ""),
            role: "assistant",
            finish: event?.data?.finish,
          },
        },
      }
    case "session.idle":
      return {
        type: "session.idle",
        properties: {
          sessionID: String(event?.data?.sessionID ?? ""),
        },
      }
    case "session.compaction.ended":
      return {
        type: "session.compacted",
        properties: {
          sessionID: String(event?.data?.sessionID ?? ""),
        },
      }
    case "session.created":
      return {
        type: "session.started",
        properties: {
          sessionID: String(event?.data?.sessionID ?? ""),
        },
      }
    default:
      return null
  }
}
