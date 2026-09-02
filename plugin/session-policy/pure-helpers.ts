// @ts-nocheck


import { execFile, execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import {
  appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, closeSync,
} from "node:fs"
import { promisify } from "node:util"
import {
  STATUS_DIR, STATUS_FILE, AUTOCONSOLIDATION_LOG_FILE, MEMCORE_CONTEXT_LOG_FILE, MEMORY_USAGE_LOG_FILE,
  EVENT_LOG_FILE, AUTOCONSOLIDATION_LOCK_FILE, MIN_USEFUL_TEXT, CONSOLIDATION_WRITE_TOOL_NAMES,
  normalizePathForHost,
} from "./constants.ts"
import type { MessageWithParts } from "./constants.ts"


export function extractPathFromMessageParts(messages: MessageWithParts[]): string | null {
  const pathLikeRegex = /([A-Za-z]:[\\/][^\s"'`]+|\/[^\s"'`]+\.[A-Za-z0-9_]+)/g

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parts = messages[i]?.parts ?? []
    for (const part of parts) {
      if (part?.type === "file") {
        const fromFields = [part?.path, part?.filePath, part?.uri].find((v: any) => typeof v === "string" && v.trim())
        if (fromFields) {
          const normalized = normalizePathForHost(fromFields)
          if (existsSync(normalized)) return normalized
        }
      }
      if (part?.type === "text" && typeof part?.text === "string") {
        const text = String(part.text)
        const matches = text.match(pathLikeRegex) || []
        for (const candidate of matches) {
          const normalized = normalizePathForHost(candidate)
          if (existsSync(normalized)) return normalized
        }
      }
    }
  }

  return null
}

export function findProjectRoot(startDir: string): string {
  let current = normalizePathForHost(startDir)
  while (true) {
    if (existsSync(join(current, "package.json")) || existsSync(join(current, ".git"))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

export function writeStatusFile(projectRoot: string, payload: Record<string, unknown>): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    const statusPath = join(statusDir, STATUS_FILE)
    writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    // Append the event to the durable per-event log (NDJSON, one per line).
    // Log ONLY the event-specific fields: the payload carries a full config
    // snapshot via statusSnapshot's spread, which is right for the overwrite
    // snapshot but pure noise repeated on every appended line. Strip the
    // constant config/session block and keep the event type + its own data.
    try {
      // Drop the constant config/session block that statusSnapshot spreads into
      // every payload (it's identical across events — noise in an append-only log).
      // Keep the event type and its own data fields.
      const rest = { ...(payload as Record<string, unknown>) }
      for (const k of [
        "generatedAt", "projectRoot", "rootDirectory",
        "memcoreInjectEnabled", "memcoreInjectOnIdle", "memcoreInjectOnCompacted", "memcoreInjectOnStart",
        "retryEnabled", "retryDisabledAgents", "retryDisabledModes",
        "consolidationWriteGuardEnabled", "sourceCaptureVerifyEnabled",
        "autoConsolidationEnabled", "autoConsolidationOnIdle", "autoConsolidationOnCompact",
        "autoConsolidationIdleDelayMs", "autoConsolidationMessageThreshold",
        "autoConsolidationCooldownMs", "autoConsolidationTimeoutMs",
        "allowedConsolidationWriters", "sessions",
      ]) {
        delete rest[k]
      }
      appendFileSync(join(statusDir, EVENT_LOG_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...rest })}\n`, "utf8")
    } catch {
      // ignore append failure
    }
  } catch (err) {
    console.error("[turn-guard] failed writing status file:", err)
  }
}

export function appendAutoConsolidationLog(projectRoot: string, line: string): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    const logPath = join(statusDir, AUTOCONSOLIDATION_LOG_FILE)
    // P3-2: rotate at 1 MB to .1 (keep one generation)
    const MAX_LOG_SIZE = 1048576 // 1 MB
    try {
      const stat = statSync(logPath)
      if (stat.size >= MAX_LOG_SIZE) {
        const rotatedPath = logPath + ".1"
        if (existsSync(rotatedPath)) unlinkSync(rotatedPath)
        renameSync(logPath, rotatedPath)
      }
    } catch {
      // stat/rename failure is non-fatal; proceed with append
    }
    appendFileSync(logPath, `${line}\n`, "utf8")
  } catch (err) {
    console.error("[turn-guard] failed writing auto-consolidation log:", err)
  }
}

export function appendMemcoreContextLog(projectRoot: string, payload: Record<string, unknown>): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    const path = join(statusDir, MEMCORE_CONTEXT_LOG_FILE)
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8")
  } catch (err) {
    console.error("[turn-guard] failed writing mem-core context log:", err)
  }
}

export function appendMemoryUsageLog(projectRoot: string, payload: Record<string, unknown>): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    appendFileSync(
      join(statusDir, MEMORY_USAGE_LOG_FILE),
      `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`,
      "utf8",
    )
  } catch (err) {
    console.error("[turn-guard] failed writing memory usage log:", err)
  }
}

/**
 * Cross-process / orphan guard for auto-consolidation. A lockfile carries the owning pid
 * and a start timestamp; it is treated as stale once `staleMs` has elapsed, which
 * self-heals the case where a previous run was orphaned (e.g. OpenCode exited
 * before the background process finished) and never released the lock.
 *
 * Uses atomic exclusive creation ("wx") so two processes cannot both acquire.
 * Fails CLOSED on unexpected FS errors: a skipped consolidation is recoverable,
 * a double-write race is not.
 *
 * NOTE: This function must stay byte-compatible with scripts/consolidation-lock.ts.
 * Any change to the algorithm here must be mirrored there.
 */
export function acquireAutoConsolidationLock(projectRoot: string, payload: Record<string, unknown>, staleMs: number): boolean {
  const dir = join(projectRoot, STATUS_DIR)
  mkdirSync(dir, { recursive: true })
  const lockPath = join(dir, AUTOCONSOLIDATION_LOCK_FILE)

  // Attempt atomic exclusive create
  let fd: number | undefined
  try {
    fd = openSync(lockPath, "wx")
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err // fail closed on unexpected errors
    // Lock exists — check staleness
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8"))
      const startedAtMs = Number(raw?.startedAtMs || 0)
      if (startedAtMs && Date.now() - startedAtMs < staleMs) {
        return false // a still-fresh run holds the lock
      }
    } catch {
      // unreadable/corrupt lock -> treat as stale
    }

    // Stale — reclaim: unlink first, then retry wx-create
    try {
      unlinkSync(lockPath)
    } catch (unlinkErr) {
      console.error("[turn-guard] auto-consolidation lock stale reclaim unlink failed:", unlinkErr)
      throw unlinkErr // fail closed
    }

    try {
      fd = openSync(lockPath, "wx")
    } catch (retryErr: any) {
      if (retryErr?.code === "EEXIST") {
        return false // another process won the reclaim race
      }
      throw retryErr // fail closed on unexpected errors
    }
  }

  const content = `${JSON.stringify({ ...payload, pid: process.pid, startedAtMs: Date.now() }, null, 2)}\n`
  try {
    writeFileSync(fd, content, "utf8")
    closeSync(fd)
    return true
  } catch (err) {
    // If we can't write the payload after acquiring, release and fail closed
    try { unlinkSync(lockPath) } catch {}
    console.error("[turn-guard] auto-consolidation lock write failed:", err)
    throw err
  }
}

export function releaseAutoConsolidationLock(projectRoot: string): void {
  try {
    const lockPath = join(projectRoot, STATUS_DIR, AUTOCONSOLIDATION_LOCK_FILE)
    if (existsSync(lockPath)) unlinkSync(lockPath)
  } catch (err) {
    console.error("[turn-guard] auto-consolidation lock release failed:", err)
  }
}

/**
 * Kill a background run *and any children it spawned*. `child.kill()` only signals
 * the direct child, so a shell-wrapped `ESHEPHERD_AUTO_CONSOLIDATION_CMD` (or a runner that
 * forks a grandchild) could be orphaned. On Windows we use `taskkill /T` to kill
 * the whole tree; on POSIX we signal the process group (the runs are spawned with
 * `detached: true` so the child is a group leader). Either path falls back to a
 * direct kill so a missing `taskkill`/absent group can never leave the run alive.
 */
export function killProcessTree(child: { pid?: number; kill: (signal?: string) => boolean }): void {
  const pid = child?.pid
  try {
    if (process.platform === "win32") {
      if (pid) {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
        return
      }
    } else if (pid) {
      process.kill(-pid, "SIGKILL") // negative pid => signal the whole process group
      return
    }
  } catch (err) {
    console.error("[turn-guard] auto-consolidation tree-kill failed; falling back to direct kill:", err)
  }
  try {
    child.kill("SIGKILL")
  } catch (err) {
    console.error("[turn-guard] auto-consolidation direct kill failed:", err)
  }
}

export async function loadMemcoreMarkdown(
  projectRoot: string,
  scopeDir: string,
  options: {
    maxScopes: number
    directFileName: string
    storeRoots: string[]
    timeoutMs: number
  },
): Promise<{ markdown: string; loaderInfo: Record<string, unknown> }> {
  const loaderScript = join(projectRoot, "scripts", "run-mem-core-loader.ts")
  if (!existsSync(loaderScript)) {
    return { markdown: "", loaderInfo: { reason: "loader-script-not-found", loaderScript } }
  }

  const maxScopes = String(options.maxScopes)
  const directFileName = options.directFileName
  const storeRoots = options.storeRoots

  const args = [
    "--experimental-strip-types",
    loaderScript,
    "--start-dir",
    scopeDir,
    "--workspace-root",
    projectRoot,
    "--format",
    "markdown",
    "--max-scopes",
    maxScopes,
    "--direct-file-name",
    directFileName,
  ]

  if (storeRoots.length > 0) {
    args.push("--store-roots", storeRoots.join(","))
  }

  const execFileAsync = promisify(execFile)
  try {
    const output: any = await execFileAsync("node", args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    })
    const stdout =
      typeof output === "string"
        ? output
        : typeof output?.stdout === "string"
          ? output.stdout
          : ""
    return {
      markdown: stdout.trim(),
      loaderInfo: { ok: true, scopeDir, maxScopes: Number(maxScopes), directFileName, storeRoots },
    }
  } catch (err) {
    return {
      markdown: "",
      loaderInfo: {
        ok: false,
        reason: "loader-exec-failed",
        error: String(err),
        scopeDir,
        maxScopes: Number(maxScopes),
        directFileName,
        storeRoots,
      },
    }
  }
}


export function getToolNames(msg: MessageWithParts): string[] {
  const parts = msg?.parts ?? []
  const names: string[] = []
  for (const part of parts) {
    if (part?.type !== "tool") continue
    const raw = String(part?.tool ?? part?.name ?? "").trim()
    if (raw) names.push(raw)
  }
  return names
}

export function containsConsolidationWriteTool(toolNames: string[]): boolean {
  return toolNames.some((name) => {
    const normalized = name.toLowerCase()
    return CONSOLIDATION_WRITE_TOOL_NAMES.some((tail) => normalized.endsWith(tail))
  })
}


// Distinguishes retrieval from writes: "is stored memory actually being consumed?" is the open question.
export function classifyMemoryTools(toolNames: string[]): { reads: string[]; writes: string[] } {
  const reads: string[] = []
  const writes: string[] = []
  for (const name of toolNames) {
    const normalized = name.toLowerCase()
    if (!normalized.includes("mempalace")) continue
    if (CONSOLIDATION_WRITE_TOOL_NAMES.some((tail) => normalized.endsWith(tail)) || normalized.endsWith("diary_write")) {
      writes.push(name)
      continue
    }
    if (/search|get_drawer|list_drawers|kg_query|diary_read|traverse|follow_tunnels|resolve_canonical/.test(normalized)) {
      reads.push(name)
    }
  }
  return { reads, writes }
}


export function getText(parts: any[]): string {
  return parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

export function hasUsefulPayload(msg: MessageWithParts): boolean {
  const parts = msg.parts ?? []
  const text = getText(parts)
  if (text.length >= MIN_USEFUL_TEXT) return true
  // Short but still useful status/blocker responses should not trigger retries.
  if (/no files found|not found|blocked|error|unable|cannot|next step|i will/i.test(text)) return true
  if (text.length >= 8) return true
  if (parts.some((p) => p?.type === "patch")) return true
  if (parts.some((p) => p?.type === "file")) return true
  return false
}

export function hasFinalReviewSignal(msg: MessageWithParts): boolean {
  const text = getText(msg.parts ?? []).toLowerCase()
  if (!text) return false
  return /review|summary|what i did|what changed|result|blocker|next step|next action/.test(text)
}

export function hasActionPart(msg: MessageWithParts | null | undefined): boolean {
  const parts = msg?.parts ?? []
  return parts.some((p: any) => {
    const type = String(p?.type ?? "")
    return type === "tool" || type === "patch" || type === "file" || type === "subtask"
  })
}

export function isCapabilityQuestion(text: string): boolean {
  const normalized = String(text || "").trim().toLowerCase()
  if (!normalized || !normalized.includes("?")) return false
  return /^(are you able|can you|could you|are you capable|do you have|are you able to)\b/.test(normalized)
}

// Mode B premature stop: the model announced an action (or trailed off on a
// colon) but emitted finish=stop with no tool/patch/file part executing it.
// e.g. "Now let me verify the delete button in the Control Panel:" then nothing.
export function endsMidIntent(msg: MessageWithParts): boolean {
  const parts = msg.parts ?? []
  if (hasActionPart(msg)) return false
  const text = getText(parts).trim()
  if (!text) return false
  const lastLine = (text.split(/\n/).pop() ?? "").trim()
  const danglingColon = /[:\uFF1A]\s*$/.test(text)
  const announcesAction =
    /\b(let me|let's|now (?:i|we)|i'?ll|i will|i'm going to|going to|next,?\s+i|then i|first,? i|i need to|i'?m going to|let me now)\b/i.test(
      lastLine,
    )
  return danglingColon || announcesAction
}

export function isAssistantStop(msg: MessageWithParts): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "stop"
}

export function isAssistantToolCallFinish(msg: MessageWithParts): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "tool-calls"
}

export function isSerenaMemoryToolTurn(msg: MessageWithParts | null | undefined): boolean {
  if (!msg) return false
  const parts = msg.parts ?? []
  return parts.some((p: any) => {
    if (p?.type !== "tool") return false
    const name = String(p?.tool ?? "").toLowerCase()
    return /^serena_/.test(name) && /memory/.test(name)
  })
}

export function partTypes(msg: MessageWithParts | null | undefined): string {
  const parts = msg?.parts ?? []
  return parts.map((p: any) => String(p?.type ?? "?")).join(",") || "none"
}

export function sortByCreated(messages: MessageWithParts[]): MessageWithParts[] {
  return [...messages].sort((a, b) => {
    const ta = Number(a?.info?.time?.created ?? 0)
    const tb = Number(b?.info?.time?.created ?? 0)
    return ta - tb
  })
}

export function unwrapListResult(res: any): MessageWithParts[] {
  if (Array.isArray(res?.data)) return res.data
  if (Array.isArray(res)) return res
  return []
}

export function unwrapMessageResult(res: any): MessageWithParts | null {
  if (res?.data && typeof res.data === "object") return res.data
  if (res && typeof res === "object" && res.info) return res
  return null
}


// ── compatibility re-exports (moved to domain-category modules) ─────────────
export { maybeFileWorkedExampleWithGating } from "./worked-example.ts"
export { maybeRecordCapabilityTupleWithGating, maybeCaptureCalibrationTupleWithGating } from "./capability.ts"
export { maybeInjectMemcoreWithGating, persistWorkedInterventionWithGating, maybeRecordModelFailureWithGating, queuePendingInterventionWithGating, confirmPendingInterventionsWithGating } from "./interventions.ts"
export { findSessionID, resolveScopeDirFromEvent, getAgentIdentity, getActiveModel, getActiveAgent, getPromptRouting, normalizeModelSpec, resolveSessionPromptRoutingWithGating, resolveLoopGuardRoutingWithGating, maybeWarnWriteAuthorityWithGating } from "./routing.ts"
export { runSourceCaptureCommand, verifySourceCaptureWithGating, runConsolidationCommandWithGating } from "./source-capture.ts"
export { maybeFileWorkedExamplesFromMessageWithGating } from "./worked-example.ts"
