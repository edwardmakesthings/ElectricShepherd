// @ts-nocheck

// Domain category: memory-checkpoint lifecycle handler (maybeCheckpointWithGating).
// Extracted from handlers.ts as a dependency-injected *WithGating* function.

import type { MessageWithParts } from "./constants.ts"
import { CHECKPOINT_MARKER, MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT, CHECKPOINT_MODES } from "./constants.ts"
import { CHECKPOINT_PROMPT } from "../../../policy/checkpoint-prompt.ts"
import { isAssistantStop } from "./analysis.ts"
import { hasUsefulPayload, endsMidIntent } from "./pure-helpers.ts"

// Returns true if a checkpoint prompt was issued. Idle-only, once per session,
// and only on a genuinely complete turn so it never fires over a stall.
export async function maybeCheckpointWithGating(args: {
  sid: string
  last: MessageWithParts
  checkpointedSessions: Set<string>
  terminalCountBySession: Map<string, number>
  checkpointDisabledAgents: Set<string>
  client: any
  directory: string
  getPromptRouting: (...candidates: Array<MessageWithParts | null | undefined>) => { agent?: string; model?: { providerID: string; modelID: string } }
}): Promise<boolean> {
  const { sid, last } = args
  if (args.checkpointedSessions.has(sid)) return false

  const mode = String(last?.info?.mode ?? "")
  if (!CHECKPOINT_MODES.has(mode)) return false

  const count = args.terminalCountBySession.get(sid) ?? 0
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
  const routing = args.getPromptRouting(last)
  const currentAgent = String(routing.agent ?? "").trim().toLowerCase()
  if (currentAgent && args.checkpointDisabledAgents.has(currentAgent)) {
    console.log(`[turn-guard] checkpoint skipped for sid=${sid}: agent=${currentAgent} is in checkpoint.disabledAgents`)
    return false
  }

  args.checkpointedSessions.add(sid)
  console.log(`[turn-guard] prompting memory checkpoint for sid=${sid} (mode=${mode})`)

  try {
    const body: any = {
      parts: [
        {
          type: "text",
          text: `${CHECKPOINT_MARKER} ${CHECKPOINT_PROMPT}`,
        },
      ],
    }
    if (routing.agent) body.agent = routing.agent
    if (routing.model) body.model = routing.model

    await args.client.session.prompt({
      path: { id: sid },
      query: { directory: args.directory },
      body,
    })
  } catch (err) {
    console.error("[turn-guard] failed to issue checkpoint prompt:", err)
    return false
  }

  return true
}
