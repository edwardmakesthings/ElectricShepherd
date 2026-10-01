import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * OpenCode v2 compaction archive.
 *
 * v1 reconstructed the folded region after the fact by finding the summary
 * marker in the full message list. v2 exposes no such marker to plugins, but
 * its `compaction` session hook receives exactly the messages about to be
 * summarized, so the archive is written from those before they are folded.
 */

interface ArchiveMessage {
  role?: string
  content?: ReadonlyArray<{ type?: string; text?: string | null; name?: string }>
}

/** Render the region being compacted as markdown; null when there is nothing to archive. */
export function renderCompactionArchive(sessionID: string, messages: ReadonlyArray<ArchiveMessage>, at: Date): string | null {
  const blocks: string[] = []
  let count = 0
  for (const message of messages) {
    const role = String(message?.role ?? "?")
    if (role === "system" || role === "tool") continue
    const parts = Array.isArray(message?.content) ? message.content : []
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
      .map((part) => String(part.text).trim())
      .join("\n")
    const tools = parts.filter((part) => part?.type === "tool-call" && part.name).map((part) => String(part.name))
    const priorSummary = parts.some((part) => part?.type === "compaction")
    if (!text && tools.length === 0 && !priorSummary) continue

    count += 1
    blocks.push(`## [${role}]`)
    if (priorSummary) blocks.push("(previous compaction summary)")
    if (text) blocks.push(text)
    if (tools.length > 0) blocks.push(`(tools: ${tools.join(", ")})`)
    blocks.push("")
  }
  if (count === 0) return null
  return [
    `# Compaction archive — session ${sessionID}`,
    `# Archived ${at.toISOString()} — ${count} messages folded by compaction`,
    "",
    ...blocks,
  ].join("\n")
}

/** Write the archive file and return its path, or null when nothing was archived. */
export function writeCompactionArchive(
  archiveDir: string,
  sessionID: string,
  messages: ReadonlyArray<ArchiveMessage>,
  at: Date = new Date(),
): string | null {
  const markdown = renderCompactionArchive(sessionID, messages, at)
  if (!markdown) return null
  mkdirSync(archiveDir, { recursive: true })
  const path = join(archiveDir, `${sessionID}-${at.toISOString().replace(/[:.]/g, "-")}.md`)
  writeFileSync(path, markdown, "utf8")
  return path
}

export async function registerCompactionArchive(
  ctx: {
    session: {
      hook(name: "compaction", callback: (event: { sessionID: string; messages: ReadonlyArray<any> }) => void): Promise<unknown>
    }
  },
  archiveDir: string,
): Promise<void> {
  await ctx.session.hook("compaction", (event) => {
    // Never let archiving break compaction.
    try {
      const path = writeCompactionArchive(archiveDir, event.sessionID, event.messages)
      if (path) console.log(`[turn-guard] compact archive: sid=${event.sessionID} -> ${path}`)
    } catch (error) {
      console.log(`[turn-guard] compact archive: error (ignored) sid=${event.sessionID}: ${String(error)}`)
    }
  })
}
