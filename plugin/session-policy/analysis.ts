// @ts-nocheck

/**
 * Pure, side-effect-free analysis helpers extracted from turn-guard.ts.
 *
 * These functions operate on message/part data structures and return
 * boolean/string results without touching any mutable state, config, or I/O.
 * They are the foundational building blocks for stop detection, action-part
 * detection, final-review signal detection, and Serena-memory-tool-turn detection.
 */

import type { MessageWithParts } from "./constants.ts"

/**
 * Extract concatenated text content from message parts.
 * Filters to parts with type "text" and joins their text fields with newlines.
 */
export function getText(parts: any[]): string {
  return parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

/**
 * Detect whether a message contains a final-review signal.
 * Looks for keywords indicating the model is summarizing or reporting results.
 */
export function hasFinalReviewSignal(msg: MessageWithParts): boolean {
  const text = getText(msg.parts ?? []).toLowerCase()
  if (!text) return false
  return /review|summary|what i did|what changed|result|blocker|next step|next action/.test(text)
}

/**
 * Detect whether a message contains an action part (tool/patch/file/subtask).
 * Used to determine if the model executed any concrete action in its turn.
 */
export function hasActionPart(msg: MessageWithParts | null | undefined): boolean {
  const parts = msg?.parts ?? []
  return parts.some((p: any) => {
    const type = String(p?.type ?? "")
    return type === "tool" || type === "patch" || type === "file" || type === "subtask"
  })
}

/**
 * Check if a message is an assistant stop (finish="stop").
 */
export function isAssistantStop(msg: MessageWithParts): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "stop"
}

/**
 * Detect whether a turn contains Serena memory tool calls.
 * Matches tools with names starting with "serena_" and containing "memory".
 */
export function isSerenaMemoryToolTurn(msg: MessageWithParts | null | undefined): boolean {
  if (!msg) return false
  const parts = msg.parts ?? []
  return parts.some((p: any) => {
    if (p?.type !== "tool") return false
    const name = String(p?.tool ?? "").toLowerCase()
    return /^serena_/.test(name) && /memory/.test(name)
  })
}
