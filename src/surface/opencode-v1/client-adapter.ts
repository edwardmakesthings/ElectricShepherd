import type { Plugin } from "@opencode/plugin"

type NativeMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]
type NativeAssistant = Extract<NativeMessage, { type: "assistant" }>
type NativeToolState = Extract<NativeAssistant["content"][number], { type: "tool" }>["state"]
type DataResult<T> = T | { data: T }
type JsonMetadata = NonNullable<Parameters<Plugin.Context["session"]["prompt"]>[0]["metadata"]>

export type LegacyMessage = {
  info: { id: string; role: "user" | "assistant" | "system" | "control"; parentID: string; finish?: NativeAssistant["finish"]; time: NativeMessage["time"];
    agent?: string; mode?: JsonMetadata[string]; synthetic?: boolean; model?: { providerID: string; modelID: string; variant?: string } }
  parts: Array<{ type: "text" | "reasoning"; text: string } | { type: "tool"; tool: string; callID: string;
    state: NativeToolState; input: NativeToolState["input"]; content?: Extract<NativeToolState, { status: "completed" }>["content"];
    error?: Extract<NativeToolState, { status: "error" }>["error"] }>
}

function unwrapData<T>(result: DataResult<T>): T {
  return result !== null && typeof result === "object" && "data" in result ? result.data : result as T
}

type LegacyPromptRequest = {
  path?: { id?: string }
  body?: {
    parts?: Array<{ type?: string; text?: string }>
    text?: string
    metadata?: JsonMetadata
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
  context: (input: { sessionID: string }) => Promise<DataResult<readonly NativeMessage[]>>
  message?: { get: (input: { sessionID: string; messageID: string }) => Promise<DataResult<NativeMessage>> }
  synthetic?: Plugin.Context["session"]["synthetic"]
  prompt: Plugin.Context["session"]["prompt"]
}

function getRoleFromType(type: string): LegacyMessage["info"]["role"] {
  if (type === "synthetic") return "user"
  if (type === "assistant" || type === "user" || type === "system") return type
  return "control"
}

function toLegacyParts(message: NativeMessage): LegacyMessage["parts"] {
  if (message?.type === "assistant") {
    return message.content.flatMap<LegacyMessage["parts"][number]>((part) => {
      if (part?.type === "text" && typeof part?.text === "string") {
        return [{ type: "text", text: part.text }]
      }
      if (part?.type === "reasoning" && typeof part?.text === "string") {
        return [{ type: "reasoning", text: part.text }]
      }
      if (part?.type === "tool") {
        const state = part.state
        return [{
          type: "tool",
          tool: String(part?.name ?? ""),
          callID: String(part?.id ?? ""),
          state,
          input: state?.input,
          content: "content" in state ? state.content : undefined,
          error: "error" in state ? state.error : undefined,
        }]
      }
      return []
    })
  }

  if ((message.type === "user" || message.type === "synthetic" || message.type === "system") && typeof message.text === "string") {
    return [{ type: "text", text: message.text }]
  }

  return []
}

function toLegacyMessage(message: NativeMessage): LegacyMessage {
  const role = getRoleFromType(message.type)
  return {
    info: {
      id: String(message?.id ?? ""),
      role,
      finish: message.type === "assistant" ? message.finish : undefined,
      parentID: typeof message.metadata?.parentID === "string" ? message.metadata.parentID : "",
      time: message.time,
      agent: message.type === "assistant" ? message.agent : undefined,
      mode: message.metadata?.mode,
      synthetic: message.type === "synthetic",
      model: message.type === "assistant" ? { ...message.model, modelID: message.model.id } : undefined,
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
  const contextMessages = async (sessionID: string): Promise<LegacyMessage[]> => {
    const messages = [...unwrapData(await session.context({ sessionID }))]
      .sort((left, right) => left.time.created - right.time.created).map(toLegacyMessage)
      .filter(message => message.info.role !== "control")
    // V2 stores no parent link; infer the preceding prompt from ordered context.
    let parentID = ""
    for (const message of messages) {
      if (!message.info.parentID) message.info.parentID = parentID
      if (message.info.role === "user") parentID = message.info.id
    }
    return messages
  }
  return {
    session: {
      async messages(input: LegacyMessageRequest) {
        const sessionID = String(input?.path?.id ?? "")
        if (!sessionID) return { data: [] }
        return { data: await contextMessages(sessionID) }
      },
      async message(input: LegacyMessageRequest) {
        const sessionID = String(input?.path?.id ?? "")
        const messageID = String(input?.path?.messageID ?? "")
        if (!sessionID || !messageID) return { data: null }
        if (session.message?.get) {
          const message = toLegacyMessage(unwrapData(await session.message.get({ sessionID, messageID })))
          if ((message.info.role === "assistant" || message.info.synthetic) && !message.info.parentID) {
            const contextual = (await contextMessages(sessionID)).find(item => item.info.id === messageID)
            if (contextual) message.info.parentID = contextual.info.parentID
          }
          return { data: message }
        }
        const found = (await contextMessages(sessionID)).find(message => message.info.id === messageID)
        return { data: found ?? null }
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
