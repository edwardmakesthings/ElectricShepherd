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

import { execFileSync, execSync, spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import {
  buildCommandExecutionPlan,
  clipText,
  computeMemcoreSignature,
  decideAutoSynth,
  decideMemcoreInjection,
  pruneAutoSynthTracking,
} from "../adapter/turn-guard-helpers.ts"
import type { AutoSynthTrigger, MemcoreInjectionRecord } from "../adapter/turn-guard-helpers.ts"
import { loadPackagedAssets, mergeWithoutOverride, loadInstructionPaths, dedupeAppendInstructions } from "../adapter/asset-loader.ts"
import deleteDrawersTool from "../tools/delete_drawers.ts"

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
const AUTOSYNTH_LOG_FILE = "auto-synth.log"
const DEFAULT_MEMCORE_MAX_CHARS = 12000
const DEFAULT_MEMCORE_MAX_SCOPES = 6
const DEFAULT_INJECTION_COOLDOWN_MS = 15000
const DEFAULT_RETRY_ENABLED = false
const DEFAULT_ALLOWED_SYNTH_WRITERS = ["dreamer", "dream-consolidator"]
const SYNTH_WRITE_TOOL_NAMES = ["create_synthesis_node", "apply_merge"]

// Automatic synthesis ("count-sheep in the background"): OPT-IN. When enabled,
// the plugin runs the deterministic consolidation script after the session has
// either gone quiet for a delay (idle-timer) or accumulated enough new turns
// (volume-threshold), and on compaction. The idle-timer is overridable: any new
// message clears the pending timer so consolidation only runs once the session
// has actually stayed quiet for the full delay.
const DEFAULT_AUTOSYNTH_IDLE_DELAY_MS = 120000 // 2 minutes of quiet before idle-triggered synthesis
const DEFAULT_AUTOSYNTH_MESSAGE_THRESHOLD = 12 // new assistant turns that force a synthesis pass
const DEFAULT_AUTOSYNTH_COOLDOWN_MS = 600000 // 10 minutes minimum between auto-synth runs
const DEFAULT_AUTOSYNTH_TIMEOUT_MS = 300000 // 5 minutes before a hung run is killed (also the lock staleness window)
const AUTOSYNTH_LOCK_FILE = "auto-synth.lock"
const DEFAULT_MEMRAW_CAPTURE_TIMEOUT_MS = 20000 // blocking capture call ceiling so a hung script can't freeze the session
const DEFAULT_MEMCORE_LOADER_TIMEOUT_MS = 15000 // blocking loader call ceiling
// Bound the per-session auto-synth tracking maps so a long-lived process that
// touches thousands of sessions cannot leak memory. Oldest (least-recently
// inserted) sessions are evicted first; evicting a still-active session is
// harmless (it is simply re-tracked on its next turn as if newly seen).
const DEFAULT_AUTOSYNTH_MAX_TRACKED_SESSIONS = 512

// Checkpoint gating: only after real work, only in agents that learn durable facts.
const MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT = 4
const CHECKPOINT_MODES = new Set(["build", "plan"])

// ── LEGACY OPT-IN: Ollama finish_reason compensation ─────────────────────────
// The retry apparatus (issueRetry, endsMidIntent, hasFinalReviewSignal, etc.)
// was built to compensate for Ollama/LiteLLM returning finish_reason="stop" on
// turns that still contained pending tool calls — a serving-layer mis-signal
// (opencode#20719). With llama-server as the backend (or any correctly-signalling
// OpenAI-compatible provider), finish="stop" means what it says and the model
// reliably stops only when actually done.
//
// Set ESHEPHERD_RETRY_ENABLED=true to opt back in — useful if you encounter a
// provider that still mis-signals. Expected to be a no-op on llama-server.

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

function toLowerSet(items: string[]): Set<string> {
  return new Set(items.map((item) => item.toLowerCase()))
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

function appendAutoSynthLog(projectRoot: string, line: string): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    const logPath = join(statusDir, AUTOSYNTH_LOG_FILE)
    appendFileSync(logPath, `${line}\n`, "utf8")
  } catch (err) {
    console.error("[turn-guard] failed writing auto-synth log:", err)
  }
}

/**
 * Cross-process / orphan guard for auto-synth. A lockfile carries the owning pid
 * and a start timestamp; it is treated as stale once `staleMs` has elapsed, which
 * self-heals the case where a previous run was orphaned (e.g. OpenCode exited
 * before the background process finished) and never released the lock.
 *
 * Fails open on lock-I/O errors: synthesis should not be permanently blocked by a
 * filesystem hiccup, and the in-process guard still prevents same-process overlap.
 */
function acquireAutoSynthLock(projectRoot: string, payload: Record<string, unknown>, staleMs: number): boolean {
  try {
    const dir = join(projectRoot, STATUS_DIR)
    mkdirSync(dir, { recursive: true })
    const lockPath = join(dir, AUTOSYNTH_LOCK_FILE)
    if (existsSync(lockPath)) {
      try {
        const raw = JSON.parse(readFileSync(lockPath, "utf8"))
        const startedAtMs = Number(raw?.startedAtMs || 0)
        if (startedAtMs && Date.now() - startedAtMs < staleMs) {
          return false // a still-fresh run holds the lock
        }
      } catch {
        // unreadable/corrupt lock -> treat as stale and reclaim
      }
    }
    writeFileSync(
      lockPath,
      `${JSON.stringify({ ...payload, pid: process.pid, startedAtMs: Date.now() }, null, 2)}\n`,
      "utf8",
    )
    return true
  } catch (err) {
    console.error("[turn-guard] auto-synth lock acquire failed (failing open):", err)
    return true
  }
}

function releaseAutoSynthLock(projectRoot: string): void {
  try {
    const lockPath = join(projectRoot, STATUS_DIR, AUTOSYNTH_LOCK_FILE)
    if (existsSync(lockPath)) unlinkSync(lockPath)
  } catch (err) {
    console.error("[turn-guard] auto-synth lock release failed:", err)
  }
}

/**
 * Kill a background run *and any children it spawned*. `child.kill()` only signals
 * the direct child, so a shell-wrapped `ESHEPHERD_AUTO_SYNTH_CMD` (or a runner that
 * forks a grandchild) could be orphaned. On Windows we use `taskkill /T` to kill
 * the whole tree; on POSIX we signal the process group (the runs are spawned with
 * `detached: true` so the child is a group leader). Either path falls back to a
 * direct kill so a missing `taskkill`/absent group can never leave the run alive.
 */
function killProcessTree(child: { pid?: number; kill: (signal?: string) => boolean }): void {
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
    console.error("[turn-guard] auto-synth tree-kill failed; falling back to direct kill:", err)
  }
  try {
    child.kill("SIGKILL")
  } catch (err) {
    console.error("[turn-guard] auto-synth direct kill failed:", err)
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
      timeout: getNumberEnv("ESHEPHERD_MEMCORE_LOADER_TIMEOUT_MS", DEFAULT_MEMCORE_LOADER_TIMEOUT_MS),
      killSignal: "SIGKILL",
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
  const configured = String(process?.env?.ESHEPHERD_MEMRAW_CAPTURE_CMD || "").trim()
  const defaultScript = join(projectRoot, "scripts", "capture-memraw.sh")
  const command = configured || (existsSync(defaultScript) ? "bash ./scripts/capture-memraw.sh" : "")
  if (!command) {
    return { attempted: false, ok: false, error: "capture command not set and default script missing" }
  }

  try {
    const output = execSync(command, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: getNumberEnv("ESHEPHERD_MEMRAW_CAPTURE_TIMEOUT_MS", DEFAULT_MEMRAW_CAPTURE_TIMEOUT_MS),
      killSignal: "SIGKILL",
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

function hasActionPart(msg: MessageWithParts | null | undefined): boolean {
  const parts = msg?.parts ?? []
  return parts.some((p: any) => {
    const type = String(p?.type ?? "")
    return type === "tool" || type === "patch" || type === "file" || type === "subtask"
  })
}

function isCapabilityQuestion(text: string): boolean {
  const normalized = String(text || "").trim().toLowerCase()
  if (!normalized || !normalized.includes("?")) return false
  return /^(are you able|can you|could you|are you capable|do you have|are you able to)\b/.test(normalized)
}

// Mode B premature stop: the model announced an action (or trailed off on a
// colon) but emitted finish=stop with no tool/patch/file part executing it.
// e.g. "Now let me verify the delete button in the Control Panel:" then nothing.
function endsMidIntent(msg: MessageWithParts): boolean {
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

function getActiveAgent(msg: MessageWithParts | null | undefined): string | null {
  if (!msg?.info) return null
  const explicitAgent = String(msg.info.agent ?? "").trim()
  if (explicitAgent) return explicitAgent
  const modeFallback = String(msg.info.mode ?? "").trim()
  if (modeFallback) return modeFallback
  return null
}

function getPromptRouting(...candidates: Array<MessageWithParts | null | undefined>): {
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

export const TurnGuard = async ({ client, directory }: any) => {
  console.log(`${START_BANNER}: plugin loaded (directory=${directory})`)
  console.log("[turn-guard] hooks registered: event(message.updated, session.idle, session.compacted, session.started), experimental.session.compacting")
  console.log("[turn-guard] retry guard: OFF by default (ESHEPHERD_RETRY_ENABLED=true to opt in)")

  const rootDirectory = normalizePathForHost(directory || process.cwd())
  const projectRoot = findProjectRoot(rootDirectory)
  const memcoreInjectEnabled = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ENABLED", true)
  const memcoreInjectOnIdle = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ON_IDLE", true)
  const memcoreInjectOnCompacted = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT", true)
  const memcoreInjectOnStart = getBoolEnv("ESHEPHERD_MEMCORE_REINJECT_ON_START", true)
  const memcoreMaxChars = getNumberEnv("ESHEPHERD_MEMCORE_MAX_CHARS", DEFAULT_MEMCORE_MAX_CHARS)
  const injectionCooldownMs = getNumberEnv("ESHEPHERD_MEMCORE_INJECTION_COOLDOWN_MS", DEFAULT_INJECTION_COOLDOWN_MS)
  const retryEnabled = getBoolEnv("ESHEPHERD_RETRY_ENABLED", DEFAULT_RETRY_ENABLED)
  const retryDisabledAgents = toLowerSet(parseCSV(process?.env?.ESHEPHERD_RETRY_DISABLED_AGENTS))
  const retryDisabledModes = toLowerSet(parseCSV(process?.env?.ESHEPHERD_RETRY_DISABLED_MODES))
  const synthWriteGuardEnabled = getBoolEnv("ESHEPHERD_SYNTH_WRITE_GUARD_ENABLED", true)
  const memrawVerifyEnabled = getBoolEnv("ESHEPHERD_MEMRAW_VERIFY_ENABLED", true)
  // Automatic synthesis is OFF unless explicitly opted in — it triggers memory
  // writes in the background, so callers must enable it deliberately.
  const autoSynthEnabled = getBoolEnv("ESHEPHERD_AUTO_SYNTH_ENABLED", false)
  const autoSynthOnIdle = getBoolEnv("ESHEPHERD_AUTO_SYNTH_ON_IDLE", true)
  const autoSynthOnCompact = getBoolEnv("ESHEPHERD_AUTO_SYNTH_ON_COMPACT", true)
  const autoSynthIdleDelayMs = getNumberEnv("ESHEPHERD_AUTO_SYNTH_IDLE_DELAY_MS", DEFAULT_AUTOSYNTH_IDLE_DELAY_MS)
  const autoSynthMessageThreshold = getNumberEnv("ESHEPHERD_AUTO_SYNTH_MESSAGE_THRESHOLD", DEFAULT_AUTOSYNTH_MESSAGE_THRESHOLD)
  const autoSynthCooldownMs = getNumberEnv("ESHEPHERD_AUTO_SYNTH_COOLDOWN_MS", DEFAULT_AUTOSYNTH_COOLDOWN_MS)
  const autoSynthTimeoutMs = getNumberEnv("ESHEPHERD_AUTO_SYNTH_TIMEOUT_MS", DEFAULT_AUTOSYNTH_TIMEOUT_MS)
  const autoSynthMaxTrackedSessions = getNumberEnv(
    "ESHEPHERD_AUTO_SYNTH_MAX_TRACKED_SESSIONS",
    DEFAULT_AUTOSYNTH_MAX_TRACKED_SESSIONS,
  )
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
  // Tracks which compaction path actually ran for each session: "pre-compact-hook"
  // means the experimental.session.compacting hook fired before the summarizer;
  // "post-compact-fallback" means only the session.compacted event fired.
  const compactionPathBySession = new Map<string, { path: "pre-compact-hook" | "post-compact-fallback"; at: string }>()

  // --- auto-synth state ---
  // Pending idle-delay timers (cleared/overridden when a new message arrives),
  // last-run timestamps for the cooldown throttle, and a count of new assistant
  // turns since the last run for the volume trigger. A single in-flight flag
  // prevents overlapping background consolidations across all sessions.
  const autoSynthPendingTimer = new Map<string, ReturnType<typeof setTimeout>>()
  const autoSynthLastRunAt = new Map<string, number>()
  const autoSynthMessagesSinceRun = new Map<string, number>()
  let autoSynthInFlight = false

  function statusSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      generatedAt: new Date().toISOString(),
      projectRoot,
      rootDirectory,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      retryEnabled,
      retryDisabledAgents: [...retryDisabledAgents],
      retryDisabledModes: [...retryDisabledModes],
      synthWriteGuardEnabled,
      memrawVerifyEnabled,
      autoSynthEnabled,
      autoSynthOnIdle,
      autoSynthOnCompact,
      autoSynthIdleDelayMs,
      autoSynthMessageThreshold,
      autoSynthCooldownMs,
      autoSynthTimeoutMs,
      allowedSynthWriters: [...allowedSynthWriters],
      sessions: {
        checkpointed: checkpointedSessions.size,
        memcoreInjected: memcoreInjectionBySession.size,
        memrawCaptureTracked: memrawCaptureBySession.size,
      },
      lastCompactionPath: compactionPathBySession.size > 0
        ? Object.fromEntries([...compactionPathBySession.entries()].slice(-10))
        : undefined,
      ...extra,
    }
  }

  async function maybeInjectMemcore(args: {
    sid: string
    event: any
    reason: "idle" | "compacted" | "started"
    messages?: MessageWithParts[]
    anchor?: MessageWithParts | null
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
    const signature = computeMemcoreSignature(scopeDir, clipped)
    const now = Date.now()
    const previous = memcoreInjectionBySession.get(args.sid)
    const { shouldInject } = decideMemcoreInjection({
      scopeDir,
      signature,
      now,
      previous,
      cooldownMs: injectionCooldownMs,
      force: args.force,
    })

    if (!shouldInject) {
      return false
    }

    try {
      const routing = getPromptRouting(args.anchor)
      const body: any = {
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
      }
      if (routing.agent) body.agent = routing.agent
      if (routing.model) body.model = routing.model

      await client.session.prompt({
        path: { id: args.sid },
        query: { directory },
        body,
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
      const routing = getPromptRouting(msg)
      const body: any = {
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
      }
      if (routing.agent) body.agent = routing.agent
      if (routing.model) body.model = routing.model

      await client.session.prompt({
        path: { id: sid },
        query: { directory },
        body,
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
      console.log("[turn-guard] mem-raw capture verification: command not configured and default script not found")
    }
  }

  // Spawn the deterministic consolidation script in the background. Deterministic
  // (no live mapper) so it never forces a model load. The caller has already set
  // autoSynthInFlight and acquired the cross-process lock; this function owns the
  // process lifecycle and is the SOLE place that clears both, via settle().
  //
  // Robustness:
  //   - The default path spawns `node` directly (no shell) so the watchdog can
  //     actually kill the process tree; a user-provided command is free-form and
  //     needs a shell.
  //   - A watchdog kills a run that exceeds autoSynthTimeoutMs, so a hung MCP
  //     endpoint can never wedge the in-flight flag permanently.
  //   - settle() is idempotent, so exit/error/timeout racing each other only
  //     clears state once.
  function runConsolidationCommand(sid: string, trigger: string, onStartFailure?: () => void): void {
    const configured = String(process?.env?.ESHEPHERD_AUTO_SYNTH_CMD || "").trim()
    const startedAt = new Date().toISOString()
    console.log(`[turn-guard] auto-synth start sid=${sid} trigger=${trigger}`)
    writeStatusFile(projectRoot, statusSnapshot({ type: "auto-synth-start", sid, trigger, startedAt }))

    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const settle = (status: Record<string, unknown>, startFailure = false) => {
      if (settled) return
      settled = true
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      autoSynthInFlight = false
      releaseAutoSynthLock(projectRoot)
      // A run that never actually started should not consume the cooldown, so a
      // later trigger can retry promptly. A run that started and then failed/timed
      // out keeps the cooldown (anti-thrash).
      if (startFailure) {
        try {
          onStartFailure?.()
        } catch (err) {
          console.error("[turn-guard] auto-synth start-failure rollback failed:", err)
        }
      }
      writeStatusFile(projectRoot, statusSnapshot({ ...status, finishedAt: new Date().toISOString() }))
      appendAutoSynthLog(
        projectRoot,
        `${new Date().toISOString()} [finish] sid=${sid} trigger=${trigger} status=${JSON.stringify(status)}`,
      )
    }

    try {
      const childEnv = {
        ...process.env,
        ESHEPHERD_SESSION_ID: sid,
        ESHEPHERD_EVENT_TYPE: `auto-synth:${trigger}`,
        // The plugin already holds the shared lock; tell the child runner not to
        // re-acquire (or release) it so the plugin->script handoff doesn't
        // deadlock against itself. Standalone cron/n8n runs lack this flag and
        // take the lock themselves.
        ESHEPHERD_SYNTH_LOCK_INHERITED: "1",
      }
      // detached:true makes the child a process-group leader on POSIX so the
      // watchdog can kill the entire tree (see killProcessTree); harmless on
      // Windows where taskkill /T handles the tree instead.
      const detached = process.platform !== "win32"
      const plan = buildCommandExecutionPlan({
        configured,
        projectRoot,
        defaultScript: join(projectRoot, "scripts", "capture-memraw.sh"),
      })

      if (plan.mode === "rejected") {
        console.error(`[turn-guard] auto-synth rejected unsafe command: ${plan.reason}`)
        settle({ type: "auto-synth-rejected", sid, trigger, reason: plan.reason }, true)
        return
      }

      const logPath = join(projectRoot, STATUS_DIR, AUTOSYNTH_LOG_FILE)
      appendAutoSynthLog(
        projectRoot,
        `${new Date().toISOString()} [start] sid=${sid} trigger=${trigger} command=${plan.command} args=${JSON.stringify(plan.args)} logPath=${logPath}`,
      )

      const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        detached,
      })

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk ?? "").trim()
        if (!text) return
        appendAutoSynthLog(projectRoot, `${new Date().toISOString()} [stdout] sid=${sid} ${text}`)
      })
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk ?? "").trim()
        if (!text) return
        appendAutoSynthLog(projectRoot, `${new Date().toISOString()} [stderr] sid=${sid} ${text}`)
      })

      watchdog = setTimeout(() => {
        console.error(
          `[turn-guard] auto-synth timeout sid=${sid} trigger=${trigger} after ${autoSynthTimeoutMs}ms; killing`,
        )
        killProcessTree(child)
        settle({ type: "auto-synth-timeout", sid, trigger, timeoutMs: autoSynthTimeoutMs })
      }, autoSynthTimeoutMs)
      watchdog.unref?.()

      child.on("error", (err: unknown) => {
        console.error("[turn-guard] auto-synth spawn error:", err)
        settle({ type: "auto-synth-error", sid, trigger, error: String(err) }, true)
      })
      child.on("exit", (code: number | null) => {
        console.log(`[turn-guard] auto-synth finished sid=${sid} trigger=${trigger} code=${String(code)}`)
        settle({ type: "auto-synth-finish", sid, trigger, exitCode: code })
      })
      child.unref?.()
    } catch (err) {
      console.error("[turn-guard] auto-synth failed to start:", err)
      settle({ type: "auto-synth-error", sid, trigger, error: String(err) }, true)
    }
  }

  // Evaluate the opt-in/cooldown/threshold gate and, if it passes, claim the
  // cross-process lock and start a run. State (cooldown stamp, message reset,
  // in-flight) is only stamped once the lock is held, so a run blocked by another
  // process/instance can still fire on a later trigger.
  function evaluateAutoSynth(sid: string, trigger: AutoSynthTrigger): void {
    const messagesSinceRun = autoSynthMessagesSinceRun.get(sid) ?? 0
    const decision = decideAutoSynth({
      enabled: autoSynthEnabled,
      now: Date.now(),
      lastRunAt: autoSynthLastRunAt.get(sid) ?? null,
      cooldownMs: autoSynthCooldownMs,
      messagesSinceRun,
      messageThreshold: autoSynthMessageThreshold,
      trigger,
      inFlight: autoSynthInFlight,
    })

    if (!decision.shouldRun) {
      if (autoSynthEnabled) {
        console.log(
          `[turn-guard] auto-synth skip sid=${sid} trigger=${trigger} reason=${decision.reason} msgsSince=${messagesSinceRun}`,
        )
      }
      return
    }

    // Claim the cross-process lock before stamping any state. If another instance
    // (or n8n/cron) is mid-run, skip without consuming the cooldown so a later
    // trigger can retry.
    if (!acquireAutoSynthLock(projectRoot, { sid, trigger: decision.reason }, autoSynthTimeoutMs)) {
      console.log(`[turn-guard] auto-synth skip sid=${sid} trigger=${trigger} reason=locked`)
      writeStatusFile(projectRoot, statusSnapshot({ type: "auto-synth-skip", sid, trigger, reason: "locked" }))
      return
    }

    autoSynthInFlight = true
    const previousLastRunAt = autoSynthLastRunAt.get(sid) ?? null
    autoSynthLastRunAt.set(sid, Date.now())
    autoSynthMessagesSinceRun.set(sid, 0)
    pruneAutoSynthTracking(autoSynthMessagesSinceRun, autoSynthLastRunAt, autoSynthMaxTrackedSessions)
    // If the run never actually starts, undo the cooldown stamp so the next
    // trigger can retry immediately instead of waiting out a phantom cooldown.
    runConsolidationCommand(sid, decision.reason, () => {
      if (previousLastRunAt === null) autoSynthLastRunAt.delete(sid)
      else autoSynthLastRunAt.set(sid, previousLastRunAt)
    })
  }

  // Arm/replace the idle-delay timer. The timer represents \"stayed quiet for the
  // full delay\"; a new message clears it (see onMessageUpdated) so it is the
  // overridable delay rather than a fixed schedule.
  function armAutoSynthIdleTimer(sid: string): void {
    if (!autoSynthEnabled || !autoSynthOnIdle) return
    const existing = autoSynthPendingTimer.get(sid)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      autoSynthPendingTimer.delete(sid)
      evaluateAutoSynth(sid, "idle-timer")
    }, autoSynthIdleDelayMs)
    timer.unref?.()
    autoSynthPendingTimer.set(sid, timer)
    writeStatusFile(projectRoot, statusSnapshot({ type: "auto-synth-armed", sid, idleDelayMs: autoSynthIdleDelayMs }))
  }

  // A new message means the session is active again: cancel any pending
  // idle-triggered run and, for terminal assistant turns, advance the volume
  // counter and eagerly evaluate the volume trigger.
  function noteAutoSynthActivity(sid: string, info: any): void {
    if (!autoSynthEnabled) return
    const pending = autoSynthPendingTimer.get(sid)
    if (pending) {
      clearTimeout(pending)
      autoSynthPendingTimer.delete(sid)
    }
    if (info?.role === "assistant" && info?.finish) {
      autoSynthMessagesSinceRun.set(sid, (autoSynthMessagesSinceRun.get(sid) ?? 0) + 1)
      pruneAutoSynthTracking(autoSynthMessagesSinceRun, autoSynthLastRunAt, autoSynthMaxTrackedSessions)
      evaluateAutoSynth(sid, "volume")
    }
  }

  // ── LEGACY OPT-IN: auto-retry guard ────────────────────────────────────────────
  // This block compensates for Ollama/LiteLLM returning finish_reason="stop" on
  // turns that still contained structured tool_calls, causing premature agent-loop
  // exit (opencode#20719). With llama-server (or any correctly-signalling backend),
  // finish="stop" and finish="tool-calls" mean what they say.
  //
  // Default: DISABLED (ESHEPHERD_RETRY_ENABLED=true to opt in). When disabled the
  // entire function returns immediately — zero per-message overhead.
  // Retain as an opt-in safety net for providers that still mis-signal.
  // Returns true if a retry prompt was issued.
  const issueRetry = async (
    sid: string,
    last: MessageWithParts,
    prev: MessageWithParts | null,
  ): Promise<boolean> => {
    if (!retryEnabled) return false
    if (!isAssistantStop(last)) return false

    const currentMode = String(last?.info?.mode ?? "").trim().toLowerCase()
    const currentAgent = String(last?.info?.agent ?? "").trim().toLowerCase()
    if (currentMode && retryDisabledModes.has(currentMode)) {
      return false
    }
    if (currentAgent && retryDisabledAgents.has(currentAgent)) {
      return false
    }

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
    const capabilityQuestion = prevIsUser && isCapabilityQuestion(parentText)
    const actionLikeTurn = prevIsToolTurn || hasActionPart(last) || midIntent
    const reviewRequired = actionLikeTurn && !capabilityQuestion

    console.log(
      `[turn-guard] evaluate sid=${sid} msg=${messageID || "?"} ` +
      `prevRole=${String(prev?.info?.role ?? "?")} prevFinish=${String(prev?.info?.finish ?? "")} ` +
      `prevSerenaMemory=${String(prevWasSerenaMemory)} hasUseful=${String(hasUseful)} ` +
      `hasReview=${String(hasReview)} midIntent=${String(midIntent)} reviewRequired=${String(reviewRequired)} ` +
      `capabilityQuestion=${String(capabilityQuestion)} textLen=${lastTextLen} partTypes=${partTypes(last)}`
    )

    const memoryOnlyLikelyPremature = prevWasSerenaMemory && (lastTextLen < 120 || (reviewRequired && !hasReview))
    const consideredComplete = !memoryOnlyLikelyPremature && !midIntent && hasUseful && (!reviewRequired || hasReview)
    if (consideredComplete) {
      console.log(
        `[turn-guard] skip retry in ${sid}; considered complete ` +
        `(hasUseful=${String(hasUseful)} hasReview=${String(hasReview)} midIntent=${String(midIntent)} ` +
        `reviewRequired=${String(reviewRequired)} capabilityQuestion=${String(capabilityQuestion)} ` +
        `prevSerenaMemory=${String(prevWasSerenaMemory)})`
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
          : reviewRequired
            ? "missing a final review of completed work"
            : "incomplete continuation"

    console.log(
      `[turn-guard] low-value stop detected in ${sid}; ` +
      `reason=${retryReason} prevRole=${String(prev?.info?.role ?? "?")} ` +
      `prevFinish=${String(prev?.info?.finish ?? "")} issuing one auto-retry`
    )

    const routing = getPromptRouting(last, prev)
    const activeModel = routing.model
    if (activeModel) {
      console.log(
        `[turn-guard] retry model pin sid=${sid} ` +
        `provider=${activeModel.providerID} model=${activeModel.modelID}`
      )
    } else {
      console.log(`[turn-guard] retry model pin sid=${sid} unavailable; using session default`)
    }

    const body: any = {
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

    if (routing.agent) {
      body.agent = routing.agent
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
      const routing = getPromptRouting(last)
      const body: any = {
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
      }
      if (routing.agent) body.agent = routing.agent
      if (routing.model) body.model = routing.model

      await client.session.prompt({
        path: { id: sid },
        query: { directory },
        body,
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

    // Auto-synth: a new message cancels any pending idle run and advances the
    // volume counter; harmless no-op when auto-synth is disabled.
    noteAutoSynthActivity(sid, info)

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

      // When retry is disabled, skip parent fetch and all heuristic evaluation —
      // zero extra overhead per message.
      if (!retryEnabled) {
        verifyMemrawCapture(sid, "message.stop")
        return
      }

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

      // Checkpoint is independent of retry — its own guards (clean stop,
      // !endsMidIntent, hasUsefulPayload) prevent it from firing on stalls even
      // without the retry gate. When retry IS enabled it runs first so stall
      // detection can still log; the checkpoint's guards exclude stalls either way.
      if (retryEnabled) {
        await issueRetry(sid, last, prev)
      }
      await maybeCheckpoint(sid, last)

      await maybeInjectMemcore({
        sid,
        event,
        reason: "idle",
        messages,
        anchor: last,
      })

      // Arm the overridable idle-delay timer: consolidation fires only if the
      // session stays quiet for the full delay (a new message cancels it).
      armAutoSynthIdleTimer(sid)
    } catch (err) {
      console.error("[turn-guard] failed:", err)
    }
  }

  async function onSessionCompacted(event: any): Promise<void> {
    const sid = String(event?.properties?.sessionID ?? findSessionID(event))
    if (!sid) return

    verifyMemrawCapture(sid, "session.compacted")

    // PRIMARY mem-core injection is the experimental.session.compacting pre-hook.
    // This handler is a post-compaction fallback: re-inject only when the pre-hook
    // did not already run for this session (hook unavailable or not triggered).
    const preHookRan = compactionPathBySession.get(sid)?.path === "pre-compact-hook"
    if (!preHookRan) {
      compactionPathBySession.set(sid, { path: "post-compact-fallback", at: new Date().toISOString() })
      console.log(`[turn-guard] post-compact fallback: pre-hook absent for sid=${sid}, re-injecting mem-core`)
      await maybeInjectMemcore({
        sid,
        event,
        reason: "compacted",
        force: true,
      })
    } else {
      console.log(`[turn-guard] post-compact event: pre-compact hook already ran for sid=${sid}, skipping re-injection`)
    }

    // Compaction is a natural consolidation point; run auto-synth if enabled.
    if (autoSynthOnCompact) {
      evaluateAutoSynth(sid, "compacted")
    }
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

  // Thin wrapper for the experimental.session.compacting pre-compaction hook.
  // Isolated so that if OpenCode stabilises the hook shape (proposal #4317), only
  // this function needs updating — same insulation discipline as the MemPalace
  // tool-prefix adapter. Returns { prompt } to inject mem-core into the compaction
  // context, or {} to leave the default prompt unchanged.
  async function injectMemcoreIntoCompaction(input: any): Promise<Record<string, unknown>> {
    const sid = String(input?.sessionID ?? input?.sessionId ?? findSessionID(input) ?? "")
    const existingPrompt = String(input?.prompt ?? "")
    const scopeDir = resolveScopeDirFromEvent(input, rootDirectory)
    const { markdown, loaderInfo } = loadMemcoreMarkdown(projectRoot, scopeDir)
    if (!markdown) {
      console.log(`[turn-guard] pre-compact hook: no mem-core loaded sid=${sid} scope=${scopeDir}`)
      writeStatusFile(projectRoot, statusSnapshot({ type: "pre-compact-hook", sid, scopeDir, injected: false, loaderInfo }))
      return {}
    }

    const clipped = clipText(markdown, memcoreMaxChars)
    const injectedPrompt =
      (existingPrompt ? existingPrompt + "\n\n" : "") +
      `--- mem-core (resident memory, scope: ${scopeDir}) ---\n` +
      clipped +
      "\n--- end mem-core ---\n\n" +
      "The mem-core block above is the always-loaded resident memory for this session's active scope. " +
      "Preserve and carry forward all facts listed in it when generating the continuation summary."

    compactionPathBySession.set(sid, { path: "pre-compact-hook", at: new Date().toISOString() })
    writeStatusFile(projectRoot, statusSnapshot({
      type: "pre-compact-hook",
      sid,
      scopeDir,
      injected: true,
      chars: clipped.length,
      loaderInfo,
    }))
    console.log(`[turn-guard] pre-compact hook: mem-core injected sid=${sid} scope=${scopeDir} chars=${clipped.length}`)
    return { prompt: injectedPrompt }
  }

  return {
    config: async (config: any) => {
      // Safety default: destructive drawer deletion must prompt for approval.
      const permission = config?.permission
      if (typeof permission === "string") {
        config.permission = {
          "*": permission,
          delete_drawers: "ask",
        }
      } else {
        const currentPermission = permission && typeof permission === "object" ? permission : {}
        if (!Object.prototype.hasOwnProperty.call(currentPermission, "delete_drawers")) {
          currentPermission.delete_drawers = "ask"
        }
        config.permission = currentPermission
      }

      // Make the bundled agents and slash commands load like the rest of the
      // plugin. OpenCode only auto-discovers agents/ and command/ folders when a
      // repo is the active project, which never happens for an installed plugin.
      // Reading the markdown files here and injecting them into the resolved
      // config means they load in any consumer project — while each agent and
      // command stays in its own standalone file. User-defined entries win.
      try {
        const { agents, commands } = loadPackagedAssets()
        config.agent = mergeWithoutOverride(agents, config.agent)
        config.command = mergeWithoutOverride(commands, config.command)
        let injectedInstructions = 0
        // Instructions (agent discipline) are part of the plugin's behavior,
        // so inject their absolute paths too. Opt out with
        // ESHEPHERD_INJECT_INSTRUCTIONS=false.
        if (getBoolEnv("ESHEPHERD_INJECT_INSTRUCTIONS", true)) {
          const instructionPaths = loadInstructionPaths()
          config.instructions = dedupeAppendInstructions(config.instructions, instructionPaths)
          injectedInstructions = instructionPaths.length
        }
        console.log(
          `[turn-guard] config hook injected ${Object.keys(agents).length} agents, ` +
            `${Object.keys(commands).length} commands, ${injectedInstructions} instructions`,
        )
      } catch (err) {
        console.log(`[turn-guard] config hook asset injection failed: ${String(err)}`)
      }
    },
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
    "experimental.session.compacting": async (input: any) => {
      return injectMemcoreIntoCompaction(input)
    },
    tool: {
      delete_drawers: deleteDrawersTool,
    },
  } as any
}

export default TurnGuard
