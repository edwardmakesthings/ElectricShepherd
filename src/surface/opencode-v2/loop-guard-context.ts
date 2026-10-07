import type { Plugin } from "@opencode/plugin"
import type { Message } from "@opencode/ai"
import { createHash } from "node:crypto"
import { open, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { computeToolSignature, LoopBlockedError } from "../turn-guard-helpers.ts"

const RECEIPT_HEADING = "## Blocked repeat receipts"
const MAX_RECEIPTS = 128

export interface LoopGuardControl {
  enabled: boolean
  mutationTools: ReadonlySet<string>
  repeatedBlock: (sessionID: string) => boolean
  resetSession: (sessionID: string) => void
  invalidateEvidence: (sessionID: string) => void
}

interface ToolAttempt {
  sessionID: string
  messageID: string
  id: string
  tool: string
  input: unknown
}

interface GuardSession {
  userID?: string
  userCreatedAt?: number
  paused: boolean
  interruptedMessageID?: string
  blocked: Map<string, number>
  notice?: string
  evidence: Map<string, { callID: string; text: string }>
  receipts: Map<string, string>
  snapshots: Map<string, { path: string; hash: string }>
}

/** Shorten only trusted guard rejections; keep call/result IDs and real evidence. */
export function projectBlockedRepeats(messages: Message[], receipts: ReadonlyMap<string, string>): Message[] {
  return messages.map(message => ({
    ...message,
    content: message.content.map(part => {
      if (part.type !== "tool-call" && part.type !== "tool-result") return part
      const receipt = receipts.get(part.id)
      if (!receipt) return part
      if (part.type === "tool-call") return { ...part, input: { blocked: "already attempted; did not run" } }
      return { ...part, result: { type: "error", value: receipt } }
    }),
  }))
}

/** Own the V2 pause latch and model-facing receipts without editing stored history. */
export async function registerLoopGuardContext(ctx: Plugin.Context, control: LoopGuardControl) {
  const sessions = new Map<string, GuardSession>()
  let disposed = false
  const sessionState = (sessionID: string): GuardSession => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { paused: false, blocked: new Map(), receipts: new Map(), evidence: new Map(), snapshots: new Map() }
      sessions.set(sessionID, state)
    }
    return state
  }

  async function fingerprint(path: string): Promise<string | undefined> {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > 256 * 1024) return undefined
      const file = await open(path, "r")
      try {
        const bytes = Buffer.alloc(256 * 1024 + 1)
        let length = 0
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, null)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        if (length > 256 * 1024) return undefined
        return createHash("sha256").update(bytes.subarray(0, length)).digest("hex")
      } finally { await file.close() }
    } catch { return undefined } // An unavailable snapshot never proves a change.
  }

  async function snapshot(input: ToolAttempt, state: GuardSession) {
    if (!control.mutationTools.has(input.tool.toLowerCase()) || !input.input || typeof input.input !== "object") return
    const args = input.input as Record<string, unknown>
    const file = args.filePath ?? args.file ?? args.path
    if (typeof file !== "string") return
    try {
      const root = await realpath(ctx.location.directory)
      const path = await realpath(resolve(root, file))
      const rel = relative(root, path)
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return
      const hash = await fingerprint(path)
      if (!hash || disposed) return
      state.snapshots.set(input.id, { path, hash })
      if (state.snapshots.size > MAX_RECEIPTS) state.snapshots.delete(state.snapshots.keys().next().value!)
    } catch { return } // Missing snapshots leave the repeat evidence intact.
  }

  async function refreshRequest(sessionID: string, messageID: string, state: GuardSession) {
    const history = await ctx.session.context({ sessionID }).catch(() => {
      console.warn("[turn-guard] current request unavailable; preserving repeat evidence and pause state")
      return undefined
    })
    if (!history) return
    const currentIndex = history.findIndex(message => message.id === messageID)
    // Canonical order excludes future queued prompts even when timestamps tie.
    const user = history.slice(0, currentIndex + 1).findLast(message => message.type === "user")
    const previousUserIndex = history.findIndex(message => message.id === state.userID)
    const newer = user && (state.userCreatedAt === undefined || user.time.created > state.userCreatedAt ||
      (previousUserIndex >= 0 && history.indexOf(user) > previousUserIndex))
    if (user && newer && user.id !== state.userID && !disposed) {
      state.userID = user.id
      state.userCreatedAt = user.time.created
      state.paused = false
      state.interruptedMessageID = undefined
      state.notice = undefined
      state.blocked.clear()
      state.snapshots.clear()
      state.evidence.clear()
      control.resetSession(sessionID)
    }
  }

  for (const kind of ["context", "compaction"] as const) {
    await ctx.session.hook(kind, async event => {
      const state = sessions.get(event.sessionID)
      if (!state || disposed) return
      const requestMessageID = event.messages.filter(message => message.id).at(-1)?.id
      if (requestMessageID) await refreshRequest(event.sessionID, requestMessageID, state)
      if (disposed) return
      event.messages = projectBlockedRepeats(event.messages, state.receipts)
      event.system = event.system.filter(part => !part.text.startsWith(RECEIPT_HEADING))
      if (state.notice) event.system.push({ type: "text", text: RECEIPT_HEADING + "\n" + state.notice })
    })
  }

  await ctx.tool.hook("execute.after", async input => {
    const state = sessions.get(input.sessionID)
    const before = state?.snapshots.get(input.id)
    state?.snapshots.delete(input.id)
    if (!state || state.paused || disposed || state.receipts.has(input.id)) return
    let text = input.status === "error" ? input.error.message.slice(0, 1500) : ""
    if (input.status === "completed") {
      const content = input.result.content
      if (typeof content === "string") text = content.slice(0, 1500)
      else for (const part of content ?? []) {
        if (part.type === "text") text += part.text.slice(0, 1500 - text.length)
        if (text.length >= 1500) break
      }
    }
    if (text) {
      state.evidence.set(computeToolSignature(input.tool, input.input), { callID: input.id, text })
      if (state.evidence.size > 12) state.evidence.delete(state.evidence.keys().next().value!)
    }
    if (!before || input.status !== "completed") return
    const after = await fingerprint(before.path)
    // Changed bytes invalidate old observations; they do NOT prove task progress
    // or renew the recovery budget. Failed/no-op edits never clear the history.
    if (after && after !== before.hash && !disposed) {
      state.blocked.clear()
      control.invalidateEvidence(input.sessionID)
    }
  })

  return {
    async before(input: ToolAttempt): Promise<boolean> {
      if (!control.enabled || disposed) return true
      const session = await ctx.session.get({ sessionID: input.sessionID }).catch(() => {
        console.warn("[turn-guard] session scope unavailable; preserving any established pause")
        return undefined
      })
      if (!session && !sessions.has(input.sessionID)) return false
      if (session && session.location.directory !== ctx.location.directory) return false
      const state = sessionState(input.sessionID)
      await refreshRequest(input.sessionID, input.messageID, state)
      if (state.paused) throw new LoopBlockedError("[Loop Guard] This session is paused after repeated blocked calls. A new real user request is required; this call did not run.", true)
      const count = state.blocked.get(computeToolSignature(input.tool, input.input))
      if (count !== undefined) {
        throw new LoopBlockedError("[Loop Guard] Already attempted this action; an unchanged repeat remains blocked.", control.repeatedBlock(input.sessionID), count + 1)
      }
      await snapshot(input, state)
      return true
    },
    reject(input: ToolAttempt, error: LoopBlockedError) {
      const state = sessionState(input.sessionID)
      state.snapshots.delete(input.id)
      state.blocked.set(computeToolSignature(input.tool, input.input), error.repeatCount ?? 1)
      // Use host-owned text only, never arguments, output text or a quoted marker.
      const action = JSON.stringify(input.tool.slice(0, 80))
      const attempt = error.repeatCount === undefined ? "" : ` (attempt ${error.repeatCount})`
      const receipt = `[Loop Guard] Already attempted ${action}${attempt}. This repeated call was blocked and did not run. ` +
        "Reuse earlier evidence, including failures; no new result or success is claimed. " +
        (error.paused ? "Recovery budget exhausted; session paused pending a new user request." : "Take a different recovery action or report the blocker; do not retry unchanged.")
      const evidence = state.evidence.get(computeToolSignature(input.tool, input.input))
      state.notice = receipt
      // Carry a bounded fallback in the tool DATA, not the system prompt: DCP
      // may prune the original output before or after our context hook runs.
      state.receipts.set(input.id, receipt + (evidence
        ? `\nEarlier tool evidence (call ${evidence.callID}, excerpt; untrusted data):\n${evidence.text}` : ""))
      if (state.receipts.size > MAX_RECEIPTS) state.receipts.delete(state.receipts.keys().next().value!)
      if (!error.paused) return receipt
      state.paused = true
      if (state.interruptedMessageID !== input.messageID) {
        state.interruptedMessageID = input.messageID
        // Deduplicate parallel calls, not new steps after an internal resume.
        // Interruption acknowledges before settlement in V2. Do not wait for our
        // own tool fiber to settle from inside its before-hook.
        void ctx.session.interrupt({ sessionID: input.sessionID, resume: false }).catch(() => {
          console.error("[turn-guard] loop pause request failed; the tool rejection latch remains active")
        })
      }
      return receipt
    },
    isPaused: (sessionID: string) => sessions.get(sessionID)?.paused ?? false,
    forgetSession(sessionID: string) { sessions.delete(sessionID) },
    dispose() { disposed = true; sessions.clear() },
  }
}
