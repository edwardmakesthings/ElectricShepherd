// @ts-nocheck

// Domain category: compaction archive handler (archiveCompactedRegionWithGating).
// Extracted from handlers.ts verbatim.

import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import type { MessageWithParts } from "./constants.ts"
import { STATUS_DIR } from "./constants.ts"
import { getText } from "./analysis.ts"
import { writeStatusFile } from "./pure-helpers.ts"

export async function archiveCompactedRegionWithGating(args: {
  sid: string
  client: any
  directory: string
  projectRoot: string
  compactArchiveEnabled: boolean
  sortByCreated: (messages: MessageWithParts[]) => MessageWithParts[]
  unwrapListResult: (res: any) => MessageWithParts[]
  statusSnapshot: (extra?: Record<string, unknown>) => Record<string, unknown>
}): Promise<void> {
  const sid = args.sid
  if (!args.compactArchiveEnabled) return
  try {
    const res: any = await args.client.session.messages({
      path: { id: sid },
      query: { directory: args.directory },
    })
    const messages = args.sortByCreated(args.unwrapListResult(res))
    if (messages.length === 0) return

    // Latest compaction marker = the highest-index assistant message with
    // info.summary === true. Everything BEFORE it is what this compaction folded.
    let markerIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const info: any = messages[i]?.info
      if (info?.role === "assistant" && info?.summary === true) {
        markerIndex = i
        break
      }
    }
    if (markerIndex <= 0) return // nothing before the marker to archive

    // Only archive messages since the PREVIOUS marker (don't re-archive regions
    // already captured by an earlier compaction's archive file).
    let prevMarkerIndex = -1
    for (let i = markerIndex - 1; i >= 0; i--) {
      const info: any = messages[i]?.info
      if (info?.role === "assistant" && info?.summary === true) {
        prevMarkerIndex = i
        break
      }
    }
    const region = messages.slice(prevMarkerIndex + 1, markerIndex)
    if (region.length === 0) return

    const lines: string[] = []
    lines.push(`# Compaction archive — session ${sid}`)
    lines.push(`# Archived ${new Date().toISOString()} — ${region.length} messages folded by compaction`)
    lines.push("")
    for (const m of region) {
      const info: any = m?.info ?? {}
      const role = String(info.role ?? "?")
      const parts: any[] = m?.parts ?? []
      const text = getText(parts)
      const toolNames = parts.filter((p) => p?.type === "tool").map((p) => p?.tool).filter(Boolean)
      const patchCount = parts.filter((p) => p?.type === "patch").length
      lines.push(`## [${role}]`)
      if (text) lines.push(text)
      if (toolNames.length > 0) lines.push(`(tools: ${toolNames.join(", ")})`)
      if (patchCount > 0) lines.push(`(${patchCount} patch part${patchCount === 1 ? "" : "s"})`)
      lines.push("")
    }

    // Memory-loop output, not agent-to-agent research: keep it out of .opencode/context.
    const dir = join(args.projectRoot, STATUS_DIR, "compaction-archive")
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const path = join(dir, `${sid}-${ts}.md`)
    writeFileSync(path, lines.join("\n"), "utf8")
    console.log(`[turn-guard] compact archive: wrote ${region.length} messages sid=${sid} -> ${path}`)
    writeStatusFile(args.projectRoot, args.statusSnapshot({ type: "compact-archive", sid, messages: region.length, path }))
  } catch (err) {
    // Never let archiving break the compaction path.
    console.log(`[turn-guard] compact archive: error (ignored) sid=${sid}: ${err}`)
  }
}

