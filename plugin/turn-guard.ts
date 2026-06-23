/**
 * Turn-guard plugin for OpenCode.
 *
 * Single owner of the "what should happen at the end of an assistant turn?"
 * decision. Merges two previously-separate plugins (stop-quality-retry +
 * memory-checkpoint) because they were coordination-coupled: both fired on the
 * same events (message.updated, session.idle) and both worked by injecting a
 * follow-up prompt, with no knowledge of each other — so a checkpoint reply
 * tripped the retry guard.
 *
 * The end-of-turn decision is now race-free and single-owned:
 *   1. RETRY  — the turn ended with finish=stop but stalled (no useful output,
 *               missing a final review, or announced an action then stopped).
 *               Reactive, can fire multiple times per session, hard-capped.
 *   2. CHECKPOINT — the turn ended cleanly (a successful stop: useful output,
 *               not mid-intent) and the session has done real work in build/plan
 *               mode. Proactive, fires at most once per session, only on idle.
 *               Prompts the model to (a) update the always-loaded memory blocks
 *               if durable STATE changed, and (b) save a diary/worked-example
 *               entry if substantive WORK was done or something was LEARNED —
 *               even when no block changed.
 *   3. Otherwise leave the turn alone.
 *
 * Coordination rules that resolve the old conflict:
 *   - A reply to a checkpoint prompt (parent carries CHECKPOINT_MARKER) is
 *     terminal and is NEVER retried.
 *   - Checkpoint only fires on a genuinely complete turn, so it never fires over
 *     a stall (the retry path owns stalls).
 *   - If a retry is issued on idle, no checkpoint is issued that same round.
 *
 * Install: ~/.config/opencode/plugins/turn-guard.ts
 */
// @ts-nocheck

import { execFileSync, execSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"

type MessageWithParts = {
  info?: any
  parts?: any[]
}

const AUTO_RETRY_MARKER = "[Auto-Retry Guard]"
const CHECKPOINT_MARKER = "[Memory Checkpoint]"
const MEMCORE_REINJECT_MARKER = "[Mem-core Reinjection]"
const WRITE_AUTHORITY_MARKER = "[Write-Authority Gate]"
const MIN_USEFUL_TEXT = 24
const START_BANNER = "[turn-guard] START"
const MAX_RETRIES_PER_PARENT = 2
const STATUS_DIR = ".electric-shepherd"
const STATUS_FILE = "turn-guard-status.json"
const DEFAULT_MEMCORE_MAX_CHARS = 12000
const DEFAULT_MEMCORE_MAX_SCOPES = 6
const DEFAULT_INJECTION_COOLDOWN_MS = 15000
const DEFAULT_ALLOWED_SYNTH_WRITERS = ["dreamer", "dream-consolidator"]
const SYNTH_WRITE_TOOL_NAMES = ["create_synthesis_node", "apply_merge"]

// Checkpoint gating: only after real work, only in agents that learn durable facts.
const MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT = 4
const CHECKPOINT_MODES = new Set(["build", "plan"])

function getBoolEnv(name: string, fallback: boolean): boolean {
  const raw = String(process?.env?.[name] ?? "").trim().toLowerCase()
  if (!raw) return fallback
  if (["1", "true", "yes", "on"].includes(raw)) return true
  if (["0", "false", "no", "off"].includes(raw)) return false
  return fallback
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = Number(process?.env?.[name] ?? "")
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function parseCSV(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePathForHost(path: string): string {
  if (!path) return ""
  const trimmed = path.trim()
  if (!trimmed) return ""
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
    return resolve(trimmed)
  }
  return resolve(trimmed)
}

function hashText(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function clipText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input
  return `${input.slice(0, maxChars)}\n\n<!-- truncated by turn-guard (${input.length - maxChars} chars omitted) -->`
}

function findSessionID(event: any): string {
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

function resolveScopeDirFromEvent(event: any, fallbackDirectory: string): string {
  const candidates = [
    event?.properties?.cwd,
    event?.properties?.workingDirectory,
    event?.properties?.directory,
    event?.properties?.path,
    event?.properties?.info?.cwd,
    event?.message?.info?.cwd,
    process?.env?.ESHEPHERD_SCOPE_DIR,
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

function extractPathFromMessageParts(messages: MessageWithParts[]): string | null {
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

function findProjectRoot(startDir: string): string {
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

function writeStatusFile(projectRoot: string, payload: Record<string, unknown>): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    const statusPath = join(statusDir, STATUS_FILE)
    writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  } catch (err) {
    console.error("[turn-guard] failed writing status file:", err)
  }
}

function loadMemcoreMarkdown(projectRoot: string, scopeDir: string): { markdown: string; loaderInfo: Record<string, unknown> } {
  const loaderScript = join(projectRoot, "scripts", "run-mem-core-loader.ts")
  if (!existsSync(loaderScript)) {
    return { markdown: "", loaderInfo: { reason: "loader-script-not-found", loaderScript } }
  }

  const maxScopes = String(getNumberEnv("ESHEPHERD_MEMCORE_MAX_SCOPES", DEFAULT_MEMCORE_MAX_SCOPES))
  const directFileName = String(process?.env?.ESHEPHERD_MEMCORE_DIRECT_FILE || "memory.md")
  const storeRoots = parseCSV(process?.env?.ESHEPHERD_MEMCORE_STORE_ROOTS || "eshepherd/memory,memory")

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

  try {
    const output = execFileSync("node", args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return {
      markdown: String(output || "").trim(),
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

function getToolNames(msg: MessageWithParts): string[] {
  const parts = msg?.parts ?? []
  const names: string[] = []
  for (const part of parts) {
    if (part?.type !== "tool") continue
    const raw = String(part?.tool ?? part?.name ?? "").trim()
    if (raw) names.push(raw)
  }
  return names
}

function containsSynthWriteTool(toolNames: string[]): boolean {
  return toolNames.some((name) => {
    const normalized = name.toLowerCase()
    return SYNTH_WRITE_TOOL_NAMES.some((tail) => normalized.endsWith(tail))
  })
}

function getAgentIdentity(msg: MessageWithParts | null | undefined): string {
  const fromInfo = String(msg?.info?.agent ?? msg?.info?.mode ?? "").trim().toLowerCase()
  return fromInfo
}

function runMemrawCaptureCommand(projectRoot: string, sid: string, eventType: string): { attempted: boolean; ok: boolean; output?: string; error?: string } {
  const command = String(process?.env?.ESHEPHERD_MEMRAW_CAPTURE_CMD || "").trim()
  if (!command) {
    return { attempted: false, ok: false, error: "ESHEPHERD_MEMRAW_CAPTURE_CMD not set" }
  }

  try {
    const output = execSync(command, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ESHEPHERD_SESSION_ID: sid,
        ESHEPHERD_EVENT_TYPE: eventType,
      },
    })
    return { attempted: true, ok: true, output: String(output || "").slice(-2000) }
  } catch (err) {
    return { attempted: true, ok: false, error: String(err) }
  }
}

function getText(parts: any[]): string {
  return parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

function hasUsefulPayload(msg: MessageWithParts): boolean {
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

function hasFinalReviewSignal(msg: MessageWithParts): boolean {
  const text = getText(msg.parts ?? []).toLowerCase()
  if (!text) return false
  return /review|summary|what i did|what changed|result|blocker|next step|next action/.test(text)
}

// Mode B premature stop: the model announced an action (or trailed off on a
// colon) but emitted finish=stop with no tool/patch/file part executing it.
// e.g. "Now let me verify the delete button in the Control Panel:" then nothing.
function endsMidIntent(msg: MessageWithParts): boolean {
  const parts = msg.parts ?? []
  const hasActionPart = parts.some(
    (p: any) => p?.type === "tool" || p?.type === "patch" || p?.type === "file",
  )
  if (hasActionPart) return false
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

function isAssistantStop(msg: MessageWithParts): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "stop"
}

function isAssistantToolCallFinish(msg: MessageWithParts): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "tool-calls"
}

function isSerenaMemoryToolTurn(msg: MessageWithParts | null | undefined): boolean {
  if (!msg) return false
  const parts = msg.parts ?? []
  return parts.some((p: any) => {
    if (p?.type !== "tool") return false
    const name = String(p?.tool ?? "").toLowerCase()
    return /^serena_/.test(name) && /memory/.test(name)
  })
}

function partTypes(msg: MessageWithParts | null | undefined): string {
  const parts = msg?.parts ?? []
  return parts.map((p: any) => String(p?.type ?? "?")).join(",") || "none"
}

function sortByCreated(messages: MessageWithParts[]): MessageWithParts[] {
  return [...messages].sort((a, b) => {
    const ta = Number(a?.info?.time?.created ?? 0)
    const tb = Number(b?.info?.time?.created ?? 0)
    return ta - tb
  })
}

function unwrapListResult(res: any): MessageWithParts[] {
  if (Array.isArray(res?.data)) return res.data
  if (Array.isArray(res)) return res
  return []
}

function unwrapMessageResult(res: any): MessageWithParts | null {
  if (res?.data && typeof res.data === "object") return res.data
  if (res && typeof res === "object" && res.info) return res
  return null
}

function getActiveModel(msg: MessageWithParts | null | undefined): { providerID: string; modelID: string } | null {
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

export const TurnGuard = async ({ client, directory }: any) => {
  console.log(`${START_BANNER}: plugin loaded (directory=${directory})`)
  console.log("[turn-guard] hooks registered: event(message.updated, session.idle, session.compacted, session.started)")

  const rootDirectory = normalizePathForHost(directory || process.cwd())
  const projectRoot = findProjectRoot(rootDirectory)
  const memcoreInjectEnabled = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ENABLED", true)
  const memcoreInjectOnIdle = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ON_IDLE", true)
  const memcoreInjectOnCompacted = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT", true)
  const memcoreInjectOnStart = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ON_START", true)
  const memcoreMaxChars = getNumberEnv("ESHEPHERD_MEMCORE_MAX_CHARS", DEFAULT_MEMCORE_MAX_CHARS)
  const injectionCooldownMs = getNumberEnv("ESHEPHERD_MEMCORE_INJECTION_COOLDOWN_MS", DEFAULT_INJECTION_COOLDOWN_MS)
  const synthWriteGuardEnabled = getBoolEnv("ESHEPHERD_SYNTH_WRITE_GUARD_ENABLED", true)
  const memrawVerifyEnabled = getBoolEnv("ESHEPHERD_MEMRAW_VERIFY_ENABLED", true)
  const allowedSynthWriters = new Set(
    parseCSV(process?.env?.ESHEPHERD_ALLOWED_SYNTH_WRITERS).length > 0
      ? parseCSV(process?.env?.ESHEPHERD_ALLOWED_SYNTH_WRITERS).map((item) => item.toLowerCase())
      : DEFAULT_ALLOWED_SYNTH_WRITERS,
  )

  // --- retry state ---
  // Allow one follow-up retry when the first retry still ends mid-intent,
  // while keeping a strict cap to avoid loops.
  const retriedParentBySession = new Map<string, Map<string, number>>()
  const startupConfirmedBySession = new Set<string>()
  const inspectedStopBySession = new Map<string, Set<string>>()

  // --- checkpoint state ---
  const checkpointedSessions = new Set<string>()
  // Count only TERMINAL assistant messages, not streaming updates — otherwise a
  // single reply satisfies the "real work" gate within the first turn.
  const terminalCountBySession = new Map<string, number>()
  const memcoreInjectionBySession = new Map<string, { signature: string; at: number; scopeDir: string }>()
  const warnedSynthWriteMessageIDs = new Set<string>()
  const memrawCaptureBySession = new Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>()

  function statusSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      generatedAt: new Date().toISOString(),
      projectRoot,
      rootDirectory,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      synthWriteGuardEnabled,
      memrawVerifyEnabled,
      allowedSynthWriters: [...allowedSynthWriters],
      sessions: {
        checkpointed: checkpointedSessions.size,
        memcoreInjected: memcoreInjectionBySession.size,
        memrawCaptureTracked: memrawCaptureBySession.size,
      },
      ...extra,
    }
  }

  async function maybeInjectMemcore(args: {
    sid: string
    event: any
    reason: "idle" | "compacted" | "started"
    messages?: MessageWithParts[]
    force?: boolean
  }): Promise<boolean> {
    if (!memcoreInjectEnabled) return false
    if (args.reason === "idle" && !memcoreInjectOnIdle) return false
    if (args.reason === "compacted" && !memcoreInjectOnCompacted) return false
    if (args.reason === "started" && !memcoreInjectOnStart) return false

    let scopeDir = resolveScopeDirFromEvent(args.event, rootDirectory)
    const pathFromMessages = extractPathFromMessageParts(args.messages || [])
    if (pathFromMessages) {
      scopeDir = existsSync(pathFromMessages) && !pathFromMessages.endsWith(".md") && !pathFromMessages.endsWith(".ts")
        ? pathFromMessages
        : dirname(pathFromMessages)
    }

    const { markdown, loaderInfo } = loadMemcoreMarkdown(projectRoot, scopeDir)
    if (!markdown) {
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        loaderInfo,
      }))
      return false
    }

    const clipped = clipText(markdown, memcoreMaxChars)
    const signature = `${scopeDir}|${hashText(clipped)}`
    const now = Date.now()
    const previous = memcoreInjectionBySession.get(args.sid)
    const changed = !previous || previous.signature !== signature || previous.scopeDir !== scopeDir
    const cooldownElapsed = !previous || now - previous.at >= injectionCooldownMs
    const shouldInject = Boolean(args.force) || (changed && cooldownElapsed)

    if (!shouldInject) {
      return false
    }

    try {
      await client.session.prompt({
        path: { id: args.sid },
        query: { directory },
        body: {
          parts: [
            {
              type: "text",
              text:
                `${MEMCORE_REINJECT_MARKER} Refreshing scoped mem-core for this session (reason=${args.reason}). ` +
                `Use this as the currently active resident memory for scope: ${scopeDir}. ` +
                "This is derived render output from mem-synth; do not hand-edit mem-core files.\n\n" +
                clipped,
            },
          ],
        },
      })

      memcoreInjectionBySession.set(args.sid, { signature, at: now, scopeDir })
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: true,
        signature,
        loaderInfo,
      }))
      console.log(`[turn-guard] mem-core re-injected sid=${args.sid} reason=${args.reason} scope=${scopeDir}`)
      return true
    } catch (err) {
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        error: String(err),
        loaderInfo,
      }))
      console.error(`[turn-guard] failed mem-core re-injection sid=${args.sid}:`, err)
      return false
    }
  }

  async function maybeWarnWriteAuthority(sid: string, msg: MessageWithParts): Promise<boolean> {
    if (!synthWriteGuardEnabled) return false

    const msgID = String(msg?.info?.id ?? "")
    if (msgID && warnedSynthWriteMessageIDs.has(msgID)) return false

    const toolNames = getToolNames(msg)
    if (toolNames.length === 0 || !containsSynthWriteTool(toolNames)) return false

    const actor = getAgentIdentity(msg)
    const authorized = allowedSynthWriters.has(actor)
    if (authorized) return false

    if (msgID) warnedSynthWriteMessageIDs.add(msgID)
    const namesJoined = toolNames.join(", ")
    console.log(`[turn-guard] write-authority alert sid=${sid} actor=${actor || "unknown"} tools=${namesJoined}`)

    writeStatusFile(projectRoot, statusSnapshot({
      type: "write-authority",
      sid,
      actor,
      authorized,
      toolNames,
      messageID: msgID || undefined,
    }))

    try {
      await client.session.prompt({
        path: { id: sid },
        query: { directory },
        body: {
          parts: [
            {
              type: "text",
              text:
                `${WRITE_AUTHORITY_MARKER} mem-synth write tools are restricted to dreamer agents (` +
                `${[...allowedSynthWriters].join(", ")}). ` +
                `This turn attempted: ${namesJoined}. ` +
                "Do not call create_synthesis_node/apply_merge from interactive build/plan flows. " +
                "Use diary/add_drawer/kg writes for raw findings and defer synthesis-node writes to the dreamer.",
            },
          ],
        },
      })
    } catch (err) {
      console.error("[turn-guard] failed write-authority prompt:", err)
    }
    return true
  }

  function verifyMemrawCapture(sid: string, eventType: string): void {
    if (!memrawVerifyEnabled) return

    const result = runMemrawCaptureCommand(projectRoot, sid, eventType)
    const prev = memrawCaptureBySession.get(sid)
    const next = {
      totalEvents: Number(prev?.totalEvents || 0) + 1,
      lastEvent: eventType,
      lastAt: new Date().toISOString(),
      lastSuccess: result.ok,
    }
    memrawCaptureBySession.set(sid, next)

    writeStatusFile(projectRoot, statusSnapshot({
      type: "memraw-capture-verify",
      sid,
      eventType,
      capture: result,
      sessionCaptureState: next,
    }))

    if (!result.attempted) {
      console.log("[turn-guard] mem-raw capture verification: command not configured; set ESHEPHERD_MEMRAW_CAPTURE_CMD")
    }
  }

  // Returns true if a retry prompt was issued.
  const issueRetry = async (
    sid: string,
    last: MessageWithParts,
    prev: MessageWithParts | null,
  ): Promise<boolean> => {
    if (String(last?.info?.mode ?? "") !== "build") return false
    if (!isAssistantStop(last)) return false

    const messageID = String(last?.info?.id ?? "")
    if (messageID) {
      const inspected = inspectedStopBySession.get(sid) ?? new Set<string>()
      if (inspected.has(messageID)) return false
      inspected.add(messageID)
      inspectedStopBySession.set(sid, inspected)
    }

    const prevIsToolTurn = !!prev && isAssistantToolCallFinish(prev)
    const prevIsUser = prev?.info?.role === "user"
    if (!prevIsToolTurn && !prevIsUser) return false

    const parentText = getText(prev?.parts ?? [])
    // A reply to a memory-checkpoint prompt is terminal by design — never retry it.
    if (parentText.includes(CHECKPOINT_MARKER)) {
      console.log(`[turn-guard] skip retry in ${sid}; turn is a memory-checkpoint reply`)
      return false
    }

    const hasUseful = hasUsefulPayload(last)
    const hasReview = hasFinalReviewSignal(last)
    const lastTextLen = getText(last.parts ?? []).length
    const prevWasSerenaMemory = isSerenaMemoryToolTurn(prev)
    const midIntent = endsMidIntent(last)

    console.log(
      `[turn-guard] evaluate sid=${sid} msg=${messageID || "?"} ` +
      `prevRole=${String(prev?.info?.role ?? "?")} prevFinish=${String(prev?.info?.finish ?? "")} ` +
      `prevSerenaMemory=${String(prevWasSerenaMemory)} hasUseful=${String(hasUseful)} ` +
      `hasReview=${String(hasReview)} midIntent=${String(midIntent)} textLen=${lastTextLen} partTypes=${partTypes(last)}`
    )

    const memoryOnlyLikelyPremature = prevWasSerenaMemory && (lastTextLen < 120 || !hasReview)
    if (!memoryOnlyLikelyPremature && !midIntent && hasUseful && hasReview) {
      console.log(
        `[turn-guard] skip retry in ${sid}; considered complete ` +
        `(hasUseful=${String(hasUseful)} hasReview=${String(hasReview)} midIntent=${String(midIntent)} prevSerenaMemory=${String(prevWasSerenaMemory)})`
      )
      return false
    }

    const parentID = String(last?.info?.parentID ?? "")
    if (!parentID) return false

    // If the parent already is an auto-retry prompt, fold retries under the
    // grandparent ID so we can cap the whole retry chain.
    let retryKey = parentID
    if (parentText.includes(AUTO_RETRY_MARKER)) {
      const grandParentID = String(prev?.info?.parentID ?? "")
      if (grandParentID) retryKey = grandParentID
    }

    const retriedParents = retriedParentBySession.get(sid) ?? new Map<string, number>()
    const retryCount = retriedParents.get(retryKey) ?? 0
    if (retryCount >= MAX_RETRIES_PER_PARENT) return false

    retriedParents.set(retryKey, retryCount + 1)
    retriedParentBySession.set(sid, retriedParents)

    const retryReason = memoryOnlyLikelyPremature
      ? "memory checkpoint without concrete continuation"
      : midIntent
        ? "announced an action but stopped before executing it"
        : !hasUseful
          ? "no useful output"
          : "missing a final review of completed work"

    console.log(
      `[turn-guard] low-value stop detected in ${sid}; ` +
      `reason=${retryReason} prevRole=${String(prev?.info?.role ?? "?")} ` +
      `prevFinish=${String(prev?.info?.finish ?? "")} issuing one auto-retry`
    )

    const activeModel = getActiveModel(last) ?? getActiveModel(prev)
    if (activeModel) {
      console.log(
        `[turn-guard] retry model pin sid=${sid} ` +
        `provider=${activeModel.providerID} model=${activeModel.modelID}`
      )
    } else {
      console.log(`[turn-guard] retry model pin sid=${sid} unavailable; using session default`)
    }

    const body: any = {
      agent: "build",
      parts: [
        {
          type: "text",
          text:
            `${AUTO_RETRY_MARKER} Your previous turn ended with finish=stop and ${retryReason}. ` +
            "Before responding, evaluate why progression stalled. If uncertain, call your configured sequentialthinking MCP tool once to choose the next concrete action. " +
            "Then continue execution immediately (do not stop at status-only output). If the tool result is empty/no-match, recover by checking alternative paths/patterns or report a precise blocker. " +
            "End with a short 'Review' section containing: what you did, what changed or what failed, and the exact next action.",
        },
      ],
    }

    if (activeModel) {
      body.model = activeModel
    }

    await client.session.prompt({
      path: { id: sid },
      query: { directory },
      body,
    })

    return true
  }

  // Returns true if a checkpoint prompt was issued. Idle-only, once per session,
  // and only on a genuinely complete turn so it never fires over a stall.
  const maybeCheckpoint = async (sid: string, last: MessageWithParts): Promise<boolean> => {
    if (checkpointedSessions.has(sid)) return false

    const mode = String(last?.info?.mode ?? "")
    if (!CHECKPOINT_MODES.has(mode)) return false

    const count = terminalCountBySession.get(sid) ?? 0
    if (count < MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT) return false

    // Only checkpoint after a clean, SUCCESSFUL turn — a real stop with useful
    // output, not a stall and not mid-intent. (Do NOT require a final-review
    // signal: that is a build-mode convention and would block checkpoints in
    // plan mode. On idle, retry already owns build stalls, so reaching here
    // means the turn completed.)
    if (!isAssistantStop(last)) return false
    if (endsMidIntent(last)) return false
    if (!hasUsefulPayload(last)) return false

    checkpointedSessions.add(sid)
    console.log(`[turn-guard] prompting memory checkpoint for sid=${sid} (mode=${mode})`)

    try {
      await client.session.prompt({
        path: { id: sid },
        query: { directory },
        body: {
          parts: [
            {
              type: "text",
              text:
                `${CHECKPOINT_MARKER} Before this session winds down, run a two-part memory ` +
                `check. These are independent — answer both; either can warrant saving alone.\n\n` +
                `PART 1 — did durable STATE change? (the always-loaded blocks)\n` +
                `- project-state — architecture, active work, or a major decision changed?\n` +
                `- active-conventions — a naming/style/structural/tooling rule changed?\n` +
                `- user-preferences — a new durable preference was stated?\n` +
                `For each durable STATE change, write/update the corresponding mem-synth fact using ` +
                `add_drawer, kg_add, or create_synthesis_node (the same durable layer used in PART 2).\n` +
                `mem-core is a deterministic file-only render regenerated by the consolidation runtime from mem-synth. ` +
                `Do NOT hand-edit mem-core files and do NOT write any context-blocks drawer for mem-core.\n\n` +
                `PART 2 — was substantive WORK done or something LEARNED? (diary / worked example)\n` +
                `This applies EVEN IF no block changed. Save a synthesized entry if any happened:\n` +
                `- a feature/fix was implemented (what was built, where, key choices),\n` +
                `- a bug's root cause was found (the cause, not just the fix),\n` +
                `- a non-obvious "how/why this works" was discovered,\n` +
                `- a problem was solved in a reusable way (file as a worked example in the ` +
                `apprenticeship room),\n` +
                `- a dead end worth not repeating was hit.\n` +
                `Use diary_write / kg_add / add_drawer / the apprenticeship room. Synthesize — ` +
                `don't dump a transcript; write what a future session would want to retrieve. ` +
                `Lead each saved entry with a one-line \`DESC:\` (what it is + when it's ` +
                `relevant) so it's discoverable without loading the body.\n\n` +
                `IF this session's work appears to already be done / already correct / a ` +
                `continuation of prior work: do NOT assume a prior session already saved it. ` +
                `You cannot see whether that happened. SEARCH MemPalace (diary/drawers) for an ` +
                `entry covering this specific work before concluding nothing needs saving. ` +
                `If you find a matching entry: genuinely a no-op, say so and cite what you found. ` +
                `If you find NO matching entry: this is unsaved work regardless of which session ` +
                `did it — save it now per PART 2 above. Never write "a previous session should ` +
                `have handled this" without having searched and found evidence it did.\n\n` +
                `Do not invent changes just to have something to write — but "no block changed" ` +
                `is NOT "nothing to save"; implementation work and discoveries belong in PART 2. ` +
                `If genuinely nothing in either part, reply "No memory updates needed" and stop. ` +
                `End by listing what you saved under each part.`,
            },
          ],
        },
      })
    } catch (err) {
      console.error("[turn-guard] failed to issue checkpoint prompt:", err)
      return false
    }

    return true
  }

  async function onMessageUpdated(event: any): Promise<void> {
    const info = event?.properties?.info
    const sid = String(info?.sessionID ?? findSessionID(event))
    if (!sid) return

    if (!startupConfirmedBySession.has(sid)) {
      startupConfirmedBySession.add(sid)
      console.log(`${START_BANNER}: message hook active`)
    }

    // Count terminal assistant messages only (finish set) for the checkpoint gate.
    if (info?.role === "assistant" && info?.finish) {
      terminalCountBySession.set(sid, (terminalCountBySession.get(sid) ?? 0) + 1)
    }

    try {
      const messageID = String(info?.id ?? "")
      if (!messageID) return
      if (info?.role !== "assistant") return
      if (info?.finish !== "stop" && info?.finish !== "tool-calls") return

      const currentRes: any = await client.session.message({
        path: { id: sid, messageID },
        query: { directory },
      })
      const current = unwrapMessageResult(currentRes)
      if (!current) return

      await maybeWarnWriteAuthority(sid, current)

      if (info?.finish !== "stop") return

      const parentID = String(current?.info?.parentID ?? "")
      if (!parentID) return

      const parentRes: any = await client.session.message({
        path: { id: sid, messageID: parentID },
        query: { directory },
      })
      const parent = unwrapMessageResult(parentRes)
      verifyMemrawCapture(sid, "message.stop")

      // message.updated only handles retries; checkpoint is idle-only.
      await issueRetry(sid, current, parent)
    } catch (err) {
      console.error("[turn-guard] message.updated failed:", err)
    }
  }

  async function onSessionIdle(event: any): Promise<void> {
    const sid = String(event?.properties?.sessionID ?? findSessionID(event))
    if (!sid) return

    if (!startupConfirmedBySession.has(sid)) {
      startupConfirmedBySession.add(sid)
      console.log(`${START_BANNER}: idle hook active for session=${sid}`)
    }

    try {
      const res: any = await client.session.messages({
        path: { id: sid },
        query: { directory },
      })

      const messages = sortByCreated(unwrapListResult(res))
      if (messages.length < 2) return

      const last = messages[messages.length - 1]
      const prev = messages[messages.length - 2]

      // Retry owns stalls; only consider a checkpoint when nothing was retried.
      const retried = await issueRetry(sid, last, prev)
      if (!retried) {
        await maybeCheckpoint(sid, last)
      }

      await maybeInjectMemcore({
        sid,
        event,
        reason: "idle",
        messages,
      })
    } catch (err) {
      console.error("[turn-guard] failed:", err)
    }
  }

  async function onSessionCompacted(event: any): Promise<void> {
    const sid = String(event?.properties?.sessionID ?? findSessionID(event))
    if (!sid) return

    verifyMemrawCapture(sid, "session.compacted")
    await maybeInjectMemcore({
      sid,
      event,
      reason: "compacted",
      force: true,
    })
  }

  async function onSessionStarted(event: any): Promise<void> {
    const sid = String(event?.properties?.sessionID ?? findSessionID(event))
    if (!sid) return

    await maybeInjectMemcore({
      sid,
      event,
      reason: "started",
      force: true,
    })
  }

  const hooks = {
    event: async ({ event }: any) => {
      if (!event?.type) return
      if (event.type === "message.updated") {
        await onMessageUpdated(event)
        return
      }
      if (event.type === "session.idle") {
        await onSessionIdle(event)
        return
      }
      if (event.type === "session.compacted") {
        await onSessionCompacted(event)
        return
      }
      if (event.type === "session.started" || event.type === "session.created") {
        await onSessionStarted(event)
      }
    },
  }

  return hooks as any
}

export default TurnGuard
