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

import { execFile, execFileSync, spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, closeSync } from "node:fs"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import {
  buildCommandExecutionPlan,
  buildCalibrationEscalationNote,
  clipText,
  computeMemcoreSignature,
  computeToolSignature,
  decideAutoConsolidation,
  decideCapabilityReroute,
  decideLoopIntervention,
  decideMemcoreInjection,
  detectDeliberationSpiral,
  isDeliberationExemptPrompt,
  pruneAutoConsolidationTracking,
  shouldFileWorkedExample,
  shouldInjectWorkedExamples,
  shouldSkipWorkedExampleByCooldown,
} from "../adapter/turn-guard-helpers.ts"
import type { AutoConsolidationTrigger, MemcoreInjectionRecord } from "../adapter/turn-guard-helpers.ts"
import { loadPackagedAssets, mergeWithoutOverride, loadInstructionPaths, dedupeAppendInstructions } from "../adapter/asset-loader.ts"
import { loadRuntimeConfig, getRuntimeConfigEnvMap, DEFAULT_MCP_URL, DEFAULT_MCP_TOOL_PREFIX } from "../adapter/runtime-config.ts"
// Substrate transport is constructed ONLY through the core/ seam (Check A2).
import { createSubstrateClient } from "../core/substrate-client.ts"
import { SubstrateError, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts"
import { createMemgraphClient } from "../adapter/memgraph.ts"
import { retrieveSimilarWorkedExamples, formatWorkedExampleDemonstration, WORKED_EXAMPLE_MAX_INJECT, WORKED_EXAMPLE_RELEVANCE_FLOOR, extractWorkedExampleShape, buildWorkedExampleEntry, WORKED_EXAMPLE_FILE_AGENT_TYPES, WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS, CAPABILITY_TIER_BY_SUBAGENT, CAPABILITY_SUBAGENT_BY_TIER, mapTaskStatusToCapabilityOutcome, buildCapabilityCanonicalShape, buildCapabilityBucketId, canonicalModelId, buildFailureBucketId, buildFailurePatchId, FAILURE_PATCH_TEXT_MAX_CHARS, parseSelfReportedConfidence, buildCalibrationBucketId, INTERVENTION_REPLAY_HEADING, formatInterventionBlock } from "../adapter/retrieval-expansion.ts"
import { loadRuntimeEnv } from "../scripts/runtime-env.ts"

import { createHookHeadHandlers } from "./session-policy/hook-head.ts"
import { createToolRegistry } from "./session-policy/registry.ts"
import { getText, hasFinalReviewSignal, hasActionPart, isAssistantStop, isSerenaMemoryToolTurn } from "./session-policy/analysis.ts"
import { buildSourceCaptureEnv, buildConsolidationEnv } from "./session-policy/env.ts"

// Absolute path to the ElectricShepherd install root (the plugin's own repo).
// Runtime scripts must run from HERE — not the consumer project's cwd — so
// loadRuntimeEnv finds ElectricShepherd/.env (or the sibling docker/.env) and
// scripts resolve their sibling adapter modules.
const ESHEPHERD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

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
// Hard ceiling on the TOTAL number of auto-retries per session, independent of
// parent keying. The per-parent cap above can be defeated by a persistent stall:
// each auto-retry prompt becomes the parent of the next turn and the retryKey
// fold only climbs one level (to the grandparent), so the key shifts every
// generation and the per-parent counter never saturates. Without this total
// cap a wedged model would retry forever — each retry firing a fresh generation,
// turning a silent hang into an active GPU-pinning / cost runaway. 4 nudges is
// plenty: a transient stall recovers on the first, a genuinely stuck one will
// not recover after four. Override with ESHEPHERD_MAX_RETRIES_PER_SESSION.
const DEFAULT_MAX_RETRIES_PER_SESSION = 4
const STATUS_DIR = ".electric-shepherd"
const STATUS_FILE = "turn-guard-status.json"
const AUTOCONSOLIDATION_LOG_FILE = "auto-consolidation.log"
const MEMCORE_CONTEXT_LOG_FILE = "memcore-context.ndjson"
const MEMORY_USAGE_LOG_FILE = "memory-usage.ndjson"
// Append-only NDJSON event log: every statusSnapshot write is appended here (one
// JSON object per line) in addition to overwriting the single-status snapshot.
// The snapshot answers "current state"; this log answers "what fired, in order,
// on this event" — which matters because one compaction emits several snapshots
// (compact-archive, source-capture-verify) and the
// overwrite-only snapshot would only retain the last.
const EVENT_LOG_FILE = "turn-guard-events.ndjson"
const TURN_GUARD_INSTANCE_DIRS_KEY = "__ESHEPHERD_TURN_GUARD_INSTANCE_DIRS__"
// Test seam: set to true on globalThis before calling TurnGuard to clear the
// per-directory instance dedupe (tests run the real handler in-process).
const TURN_GUARD_INSTANCE_RESET_KEY = "__ESHEPHERD_TURN_GUARD_INSTANCE_RESET__"
const DEFAULT_MEMCORE_MAX_CHARS = 12000
const DEFAULT_MEMCORE_MAX_SCOPES = 6
const DEFAULT_INJECTION_COOLDOWN_MS = 15000
const DEFAULT_RETRY_ENABLED = false
const LOOP_GUARD_MARKER = "[Loop Guard]"
// Loop guard: abort a tool call whose (name + args) has already run N times in
// the recent window with no mutation in between, and hand the model a short
// nudge instead of the tool result. Deliberately gentle — in practice "are you
// looping? regroup" breaks the cycle; a heavyweight intervention is not needed.
//
// NOTE: OpenCode's tool.execute.before hook does not fire for tool calls made
// inside subagents spawned via the task tool (upstream issue #5894), so a loop
// entirely contained in a subagent will not be caught here.
const DEFAULT_LOOP_GUARD_ENABLED = true
const DEFAULT_LOOP_REPEAT_THRESHOLD = 3
const DEFAULT_LOOP_WINDOW_SIZE = 12
const DEFAULT_LOOP_MAX_INTERVENTIONS = 3
const DEFAULT_TASK_WATCHDOG_ENABLED = true
const DEFAULT_TASK_WATCHDOG_THRESHOLD = 3
const DEFAULT_TASK_WATCHDOG_MAX_ESCALATIONS = 2
const DEFAULT_TASK_SERIALIZE_TYPES = ["explore", "review-diff", "run-tests"]
const DEFAULT_TASK_SERIALIZE_COOLDOWN_MS = 15000
const DEFAULT_TASK_SWAP_QWEN_MATCH = "qwen"
const DEFAULT_TASK_SWAP_QWEN_TO_MODEL = "litellm/implementer-gemma4-31b"
const DEFAULT_TASK_SWAP_GEMMA_MATCH = "gemma"
const DEFAULT_TASK_SWAP_GEMMA_TO_MODEL = "litellm/implementer-qwen3.8-27b"
// Phase 13 (worked-example injection): when delegating to @implement-local via the
// task tool, append up to WORKED_EXAMPLE_MAX_INJECT relevant apprenticeship worked
// examples as demonstrations. Below WORKED_EXAMPLE_RELEVANCE_FLOOR, inject nothing.
// The cap and floor are defined in adapter/retrieval-expansion.ts (single source of
// truth); they are re-exported here for the config echo and testability.
const DEFAULT_WORKED_EXAMPLE_INJECTION_ENABLED = true
const DEFAULT_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS = 4000
// Phase 13 CREATE: when a cloud implementation subagent (implement-cloud,
// build-cloud) completes successfully with substantive output, file a compact
// worked example to the apprenticeship room and stamp it es-source-type:
// worked-example. Worked examples are a distinct knowledge class from procedural
// skills, so they get their own source type; the CONSUME side admits both
// "worked-example" (new filings) and "skill" (pre-existing drawers) via
// WORKED_EXAMPLE_SOURCE_TYPES in adapter/retrieval-expansion.ts. The apprentice
// flows (implement-local, build) deliberately do NOT file — see
// WORKED_EXAMPLE_FILE_AGENT_TYPES for the rationale.
const DEFAULT_WORKED_EXAMPLE_FILING_ENABLED = true
// Phase 14 CREATE: when a routing-tier subagent (implement-local, implement-cloud,
// implement-deep-cloud, solve-deep-cloud) completes, record a capability tuple
// (task shape, tier, outcome) to the palace so the CONSUME side can aggregate
// evidence per (shape, tier) and recommend a tier with a min-sample gate. The
// outcome is derived from the task tool part status (success/failed/aborted), NOT
// from Phase 7's es-outcome axis (human-authoritative). Best-effort: any failure
// degrades to a log line and never throws into the turn.
  const DEFAULT_CAPABILITY_RECORDING_ENABLED = true
// Phase 15 CREATE: when a turn-guard intervention fires (loop nudge, spiral
// detection), record a failure event attributed to (model, task shape) plus the
// successful intervention text. Shape reuses Phase 14's extractWorkedExampleShape /
// buildCapabilityCanonicalShape — no second shape system. Model identity is
// deterministic from routing context (provider/model); unknown => skip. The
// failure axis uses NEW es-failure-* / es-intervention-* predicates, never
// es-outcome (Phase 7 is human-authoritative). Best-effort: any failure degrades
// to a log line and never throws into the turn.
const DEFAULT_FAILURE_RECORDING_ENABLED = true
// Phase 15 CONSUME: when delegating via the task tool, inject known successful
// intervention patches for (model, shape) — only on an exact (model, shapeKey)
// match, so absent data yields no injection and no prompt bloat.
const DEFAULT_FAILURE_PATCH_INJECTION_ENABLED = true
// Phase 16 CREATE: capture the self-reported confidence label from a subagent's
// terminal output at completion time. The PENDING tuple (model, shape, confidence)
// is stored session-locally; it becomes a durable calibration edge ONLY when the
// operator later records an es-outcome for that unit via record_outcome (the
// human-authoritative path). No proxy outcome labels are ever written here.
const DEFAULT_CALIBRATION_CAPTURE_ENABLED = true
// Phase 16 CONSUME (calibrated escalation): when delegating via the task tool,
// consult the (model, shape, confidence) calibration cell BEFORE trusting the
// subagent's self-reported confidence at face value. ACTIVE BY DEFAULT — no
// feature flag. NEUTRAL FALLBACK (operator decision): a trust override requires
// at least 5 recorded samples per cell; below that, or on any read failure /
// unavailable data, the existing baseline path is preserved EXACTLY (the unit
// runs as it always did). A sufficient cell with a low measured hit rate flips
// the decision to escalate: the delegation prompt gets a calibration note telling
// the subagent its self-reported confidence at this level on this shape is
// measured unreliable, so verify before acting. The display path
// (getCalibrationTable -> /memory-status) is untouched — it keeps reporting the
// full 20-pair curve to humans; only the decision gate uses the 5-sample floor.
const CALIBRATION_OVERRIDE_MIN_SAMPLES = 5
const CALIBRATION_MIN_HIT_RATE = 0.6
// Phase 15 CONSUME (intervention replay): when delegating via the task tool,
// consult getFailureInterventions for (model, shape) — the intervention texts
// that previously BROKE a loop on this exact model + task class — and inject
// them into the outgoing prompt ("last time this shape failed, here is what
// fixed it"). ALWAYS ACTIVE — no feature flag. Bounded by INTERVENTION_REPLAY_MAX_PATCHES
// via getFailureInterventions' maxPatches argument; the closed label vocabulary
// (spiral-nudge | retry-nudge | loop-block) caps the read at 3 one-hop kg_queries
// regardless. Neutral fallback: no interventions recorded, empty result, MCP
// unavailable, or a throwing read => the prompt is left EXACTLY as-is. Idempotent:
// the block heading is checked against the current args.prompt before appending,
// so a re-fired hook never doubles the block.
const INTERVENTION_REPLAY_MAX_PATCHES = 3
  // looking like a loop, without needing to exempt the verify tools themselves.
const DEFAULT_LOOP_MUTATION_TOOLS = [
  "write",
  "edit",
  "patch",
  "bash",
  "line-edit_replace",
  "line-edit_insert",
  "line-edit_delete",
  "line-edit_batch",
  "regex-replace",
  "file-ops_bytes_replace",
  "file-ops_normalize_eol",
  "file-writer_begin",
  "file-writer_append",
  "file-writer_finish",
  "ast-tools_rewrite",
  "organize-tools_move",
  "organize-tools_apply_plan",
  "serena_replace_symbol_body",
  "serena_replace_content",
  "serena_insert_after_symbol",
  "serena_insert_before_symbol",
  "serena_rename_symbol",
  "serena_safe_delete_symbol",
]
// Never blocked: the escape hatches the nudge itself recommends.
const DEFAULT_LOOP_EXEMPT_TOOLS = ["compress", "dcp-compress"]

const SPIRAL_GUARD_MARKER = "[Spiral Guard]"
// Deliberation-spiral guard: the inverse of the loop guard. The loop guard
// catches a repeated *tool call*; this catches a finish=stop turn that narrates
// many investigations ("let me check X", "let me re-read Y") while executing NO
// tool/patch/file part — a model reasoning from priors instead of reading. It is
// reactive: it redirects the NEXT turn. OpenCode exposes no token-level hook to
// abort mid-stream, and pure-text generation never passes tool.execute.before,
// so the loop guard structurally cannot see this failure mode.
const DEFAULT_SPIRAL_GUARD_ENABLED = true
const DEFAULT_SPIRAL_INVESTIGATE_THRESHOLD = 3
const DEFAULT_SPIRAL_REVERSAL_THRESHOLD = 3
const DEFAULT_SPIRAL_MAX_INTERVENTIONS = 2
// Cloud models don't spiral the way small local models do — the guard was built
// for the local llama-swap models and a false positive on a paid Copilot call
// costs a wasted turn. Skip the guard for these providers by default.
const DEFAULT_SPIRAL_EXEMPT_PROVIDERS = ["github_copilot"]
// In OpenCode, cloud calls often route through providerID="litellm" with the
// concrete model in modelID (e.g. copilot-*). Exempt by model prefix too.
const DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES = ["copilot-"]
const DEFAULT_ALLOWED_CONSOLIDATION_WRITERS = ["dreamer"]
const CONSOLIDATION_WRITE_TOOL_NAMES = ["add_drawer", "update_drawer", "kg_add", "kg_invalidate", "apply_merge"]

// Automatic consolidation ("consolidate in the background"): OPT-IN. When enabled,
// the plugin runs the deterministic consolidation script after the session has
// either gone quiet for a delay (idle-timer) or accumulated enough new turns
// (volume-threshold), and on compaction. The idle-timer is overridable: any new
// message clears the pending timer so consolidation only runs once the session
// has actually stayed quiet for the full delay.
const DEFAULT_AUTOCONSOLIDATION_IDLE_DELAY_MS = 120000 // 2 minutes of quiet before idle-triggered consolidation
const DEFAULT_AUTOCONSOLIDATION_MESSAGE_THRESHOLD = 12 // new assistant turns that force a consolidation pass
const DEFAULT_AUTOCONSOLIDATION_COOLDOWN_MS = 600000 // 10 minutes minimum between auto-consolidation runs
const DEFAULT_AUTOCONSOLIDATION_TIMEOUT_MS = 300000 // 5 minutes before a hung run is killed (also the lock staleness window)
const AUTOCONSOLIDATION_LOCK_FILE = "auto-consolidation.lock"
const DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS = 20000 // blocking capture call ceiling so a hung script can't freeze the session
const DEFAULT_MEMCORE_LOADER_TIMEOUT_MS = 15000 // blocking loader call ceiling
// Bound the per-session auto-consolidation tracking maps so a long-lived process that
// touches thousands of sessions cannot leak memory. Oldest (least-recently
// inserted) sessions are evicted first; evicting a still-active session is
// harmless (it is simply re-tracked on its next turn as if newly seen).
const DEFAULT_AUTOCONSOLIDATION_MAX_TRACKED_SESSIONS = 512

// Checkpoint gating: only after real work, only in agents that learn durable facts.
const MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT = 4
const CHECKPOINT_MODES = new Set(["build", "plan"])
// Utility subagents do no durable work of their own (read-only exploration,
// diff review, mechanical test runs) — never prompt them for a memory checkpoint.
const DEFAULT_CHECKPOINT_DISABLED_AGENTS = ["explore", "review-diff", "run-tests", "check-diff"]

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

function resolveScopeDirFromEvent(event: any, fallbackDirectory: string, configuredScopeDir?: string): string {
  const candidates = [
    event?.properties?.cwd,
    event?.properties?.workingDirectory,
    event?.properties?.directory,
    event?.properties?.path,
    event?.properties?.info?.cwd,
    event?.message?.info?.cwd,
    configuredScopeDir,
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

function appendAutoConsolidationLog(projectRoot: string, line: string): void {
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

function appendMemcoreContextLog(projectRoot: string, payload: Record<string, unknown>): void {
  try {
    const statusDir = join(projectRoot, STATUS_DIR)
    mkdirSync(statusDir, { recursive: true })
    const path = join(statusDir, MEMCORE_CONTEXT_LOG_FILE)
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8")
  } catch (err) {
    console.error("[turn-guard] failed writing mem-core context log:", err)
  }
}

function appendMemoryUsageLog(projectRoot: string, payload: Record<string, unknown>): void {
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
function acquireAutoConsolidationLock(projectRoot: string, payload: Record<string, unknown>, staleMs: number): boolean {
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

function releaseAutoConsolidationLock(projectRoot: string): void {
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
    console.error("[turn-guard] auto-consolidation tree-kill failed; falling back to direct kill:", err)
  }
  try {
    child.kill("SIGKILL")
  } catch (err) {
    console.error("[turn-guard] auto-consolidation direct kill failed:", err)
  }
}

async function loadMemcoreMarkdown(
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

function containsConsolidationWriteTool(toolNames: string[]): boolean {
  return toolNames.some((name) => {
    const normalized = name.toLowerCase()
    return CONSOLIDATION_WRITE_TOOL_NAMES.some((tail) => normalized.endsWith(tail))
  })
}

function getAgentIdentity(msg: MessageWithParts | null | undefined): string {
  const fromInfo = String(msg?.info?.agent ?? msg?.info?.mode ?? "").trim().toLowerCase()
  return fromInfo
}

// Distinguishes retrieval from writes: "is stored memory actually being consumed?" is the open question.
function classifyMemoryTools(toolNames: string[]): { reads: string[]; writes: string[] } {
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

async function runSourceCaptureCommand(
  projectRoot: string,
  sid: string,
  eventType: string,
  options: { command: string; timeoutMs: number },
): Promise<{
  attempted: boolean;
  ok: boolean;
  output?: string;
  error?: string;
  status?: string;
  mode?: string;
  wing?: string;
  room?: string;
  source_file?: string;
  drawer_id?: string;
  location?: string;
}> {
  const configured = String(options.command || "").trim()
  // Default script resolves inside the ElectricShepherd install (ESHEPHERD_ROOT),
  // not the consumer project's root — the script ships with the plugin and
  // sources its env from there (repo .env -> sibling docker/.env fallback).
  const defaultScript = join(ESHEPHERD_ROOT, "scripts", "capture-source-transcripts.sh")
  const command = configured || (existsSync(defaultScript) ? `bash "${defaultScript}"` : "")
  if (!command) {
    return { attempted: false, ok: false, error: "capture command not set and default script missing" }
  }

  const execFileAsync = promisify(execFile)
  try {
    const output = await execFileAsync("/bin/sh", ["-c", command], {
      cwd: ESHEPHERD_ROOT,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      env: buildSourceCaptureEnv({ sid, eventType, projectRoot }),
    })
    // execFile's promisified result is { stdout, stderr }, NOT a string —
    // String(output) on it produced "[object Object]" in the event log. Read
    // .stdout explicitly (fall back to stderr if stdout is empty).
    const text = String(output?.stdout ?? "").trim() || String(output?.stderr ?? "").trim()
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    const location = lines.find((line) => line.startsWith("mempalace://"))
    const jsonLine = lines.find((line) => line.startsWith("{") && line.endsWith("}"))
    let parsed: Record<string, unknown> = {}
    if (jsonLine) {
      try {
        const candidate = JSON.parse(jsonLine)
        if (candidate && typeof candidate === "object") parsed = candidate as Record<string, unknown>
      } catch {
        // keep parsed empty on malformed line
      }
    }
    return {
      attempted: true,
      ok: true,
      output: text.slice(-2000),
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      mode: typeof parsed.mode === "string" ? parsed.mode : undefined,
      wing: typeof parsed.wing === "string" ? parsed.wing : undefined,
      room: typeof parsed.room === "string" ? parsed.room : undefined,
      source_file: typeof parsed.source_file === "string" ? parsed.source_file : undefined,
      drawer_id: typeof parsed.drawer_id === "string" ? parsed.drawer_id : undefined,
      location,
    }
  } catch (err) {
    return { attempted: true, ok: false, error: String(err) }
  }
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


function isAssistantToolCallFinish(msg: MessageWithParts): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "tool-calls"
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

function normalizeModelSpec(candidate: any): { providerID: string; modelID: string } | null {
  if (!candidate || typeof candidate !== "object") return null

  const providerID = String(
    candidate.providerID ?? candidate.providerId ?? candidate.provider ?? "",
  ).trim()
  const modelID = String(
    candidate.modelID ?? candidate.modelId ?? candidate.model ?? candidate.id ?? "",
  ).trim()

  if (providerID && modelID) return { providerID, modelID }
  return null
}

function resolveTaskSwapTarget(args: {
  current?: { providerID: string; modelID: string } | undefined
  qwenMatch: string
  qwenToProvider?: string
  qwenToModel?: string
  gemmaMatch: string
  gemmaToProvider?: string
  gemmaToModel?: string
  fallbackProvider?: string
  fallbackModel?: string
}): { providerID: string; modelID: string; reason: string } | null {
  const currentProvider = String(args.current?.providerID ?? "").trim()
  const currentModel = String(args.current?.modelID ?? "").trim().toLowerCase()
  const qwenMatch = String(args.qwenMatch || "").trim().toLowerCase()
  const gemmaMatch = String(args.gemmaMatch || "").trim().toLowerCase()

  const qwenToModel = String(args.qwenToModel || "").trim()
  const qwenToProvider = String(args.qwenToProvider || currentProvider).trim()
  const gemmaToModel = String(args.gemmaToModel || "").trim()
  const gemmaToProvider = String(args.gemmaToProvider || currentProvider).trim()
  const fallbackModel = String(args.fallbackModel || "").trim()
  const fallbackProvider = String(args.fallbackProvider || currentProvider).trim()

  if (qwenMatch && currentModel.includes(qwenMatch) && qwenToProvider && qwenToModel) {
    return {
      providerID: qwenToProvider,
      modelID: qwenToModel,
      reason: `matched ${qwenMatch}`,
    }
  }

  if (gemmaMatch && currentModel.includes(gemmaMatch) && gemmaToProvider && gemmaToModel) {
    return {
      providerID: gemmaToProvider,
      modelID: gemmaToModel,
      reason: `matched ${gemmaMatch}`,
    }
  }

  if (fallbackProvider && fallbackModel) {
    return {
      providerID: fallbackProvider,
      modelID: fallbackModel,
      reason: "fallback",
    }
  }

  return null
}

function getPromptRoutingFromToolHook(input: any, output: any): {
  agent?: string
  model?: { providerID: string; modelID: string }
} {
  const routing: {
    agent?: string
    model?: { providerID: string; modelID: string }
  } = {}

  const agentCandidates = [
    output?.agent,
    input?.agent,
    output?.mode,
    input?.mode,
  ]
  for (const candidate of agentCandidates) {
    const value = String(candidate ?? "").trim()
    if (!value) continue
    routing.agent = value
    break
  }

  const modelCandidates = [
    output?.model,
    input?.model,
    {
      providerID: output?.providerID,
      modelID: output?.modelID,
    },
    {
      providerID: input?.providerID,
      modelID: input?.modelID,
    },
  ]
  for (const candidate of modelCandidates) {
    const normalized = normalizeModelSpec(candidate)
    if (!normalized) continue
    routing.model = normalized
    break
  }

  return routing
}
/**
 * P3-1: Evict oldest entries from a Map or Set to keep it bounded.
 * Used for all session-keyed state to prevent memory leaks in long-lived processes.
 */
function pruneToMax(collection: Map<string, any> | Set<string>, max: number): void {
  if (max <= 0) return
  while (collection.size > max) {
    const oldest = collection.keys().next().value as string | undefined
    if (oldest === undefined) break
    collection.delete(oldest)
  }
}

export const TurnGuard = async ({ client, directory }: any) => {
  const rootDirectory = normalizePathForHost(directory || process.cwd())
  const projectRoot = findProjectRoot(rootDirectory)
  const runtimeConfig = loadRuntimeConfig({
    cwd: projectRoot,
    env: process.env,
  })
  const runtimeConfigEnv = getRuntimeConfigEnvMap(runtimeConfig)
  const runtimeEnv = {
    ...process.env,
    ...runtimeConfigEnv,
  }
  loadRuntimeEnv({
    scriptUrl: import.meta.url,
    env: runtimeEnv,
    cwd: projectRoot,
  })
  const cfgRaw = (path: string): string => {
    const parts = path.split(".").filter(Boolean)
    let node: any = runtimeConfig.valuesByPath
    for (const part of parts) {
      if (!node || typeof node !== "object") return ""
      node = node?.[part]
    }
    if (typeof node === "undefined" || node === null) return ""
    return String(node)
  }
  const cfgBool = (path: string, fallback: boolean): boolean => {
    const raw = cfgRaw(path).trim().toLowerCase()
    if (!raw) return fallback
    if (["1", "true", "yes", "on"].includes(raw)) return true
    if (["0", "false", "no", "off"].includes(raw)) return false
    return fallback
  }
  const cfgNum = (path: string, fallback: number): number => {
    const raw = Number(cfgRaw(path))
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
  }
  const cfgCSV = (path: string): string[] => parseCSV(cfgRaw(path))

  const globalState = globalThis as any
  const instanceDirs: Set<string> =
    globalState[TURN_GUARD_INSTANCE_DIRS_KEY] ?? (globalState[TURN_GUARD_INSTANCE_DIRS_KEY] = new Set<string>())

  if (instanceDirs.has(rootDirectory)) {
    console.log(`${START_BANNER}: duplicate plugin load detected for directory=${rootDirectory}; skipping secondary instance`)
    return {}
  }
  // Test seam: tests run the real handler in-process and need a fresh instance
  // per temp project dir; the plugin dedupes on globalThis, so allow an explicit
  // reset from test code (never set in production).
  if ((globalState as any)[TURN_GUARD_INSTANCE_RESET_KEY]) {
    delete (globalState as any)[TURN_GUARD_INSTANCE_RESET_KEY]
    instanceDirs.clear()
  }
  instanceDirs.add(rootDirectory)

  console.log(`${START_BANNER}: plugin loaded (directory=${directory})`)
  if (runtimeConfig.configPath) {
    console.log(`[turn-guard] runtime config loaded: ${runtimeConfig.configPath}`)
  } else {
    console.log("[turn-guard] runtime config loaded: defaults (no config file found: checked eshepherd-config.jsonc, eshepherd-config.example.jsonc)")
  }
  for (const warning of runtimeConfig.warnings) {
    console.warn(`[turn-guard] runtime config warning: ${warning}`)
  }
  console.log("[turn-guard] registering hooks: event(message.updated, session.idle, session.compacted, session.started), tool.execute.before")
  console.log(
    `[turn-guard] retry guard: ${
      cfgBool("retry.enabled", DEFAULT_RETRY_ENABLED)
        ? `ON (ESHEPHERD_RETRY_ENABLED=true, max ${Math.max(1, cfgNum("retry.maxRetriesPerSession", DEFAULT_MAX_RETRIES_PER_SESSION))}/session)`
        : "OFF by default (ESHEPHERD_RETRY_ENABLED=true to opt in)"
    }`,
  )
  const memcoreInjectEnabled = cfgBool("memcore.reinject.enabled", false)
  const memcoreInjectOnIdle = cfgBool("memcore.reinject.onIdle", false)
  const memcoreInjectOnCompacted = cfgBool("memcore.reinject.onCompact", false)
  const memcoreInjectOnStart = cfgBool("memcore.reinject.onStart", false)
  // Post-compaction transcript archiver: on session.compacted, read back the full
  // session log (compaction RETAINS prior messages — verified against the SDK:
  // session.messages returns them, delimited by summary:true/agent:compaction
  // markers) and write the just-compacted region to a durable file so the facts
  // the summary dropped are not lost. Default ON; ESHEPHERD_COMPACT_ARCHIVE=false
  // to disable. Declared with the other env reads, above every use.
  const compactArchiveEnabled = cfgBool("compaction.archiveEnabled", true)
  const memcoreMaxChars = cfgNum("memcore.maxChars", DEFAULT_MEMCORE_MAX_CHARS)
  const injectionCooldownMs = cfgNum("memcore.injectionCooldownMs", DEFAULT_INJECTION_COOLDOWN_MS)
  const retryEnabled = cfgBool("retry.enabled", DEFAULT_RETRY_ENABLED)
  const retryDisabledAgents = toLowerSet(cfgCSV("retry.disabledAgents"))
  const retryDisabledModes = toLowerSet(cfgCSV("retry.disabledModes"))
  const consolidationWriteGuardEnabled = cfgBool("consolidation.writeGuardEnabled", true)
  const sourceCaptureVerifyEnabled = cfgBool("sourceCapture.verifyEnabled", true)
  // Automatic consolidation ("consolidate in the background"): ON by default.
  // It triggers memory writes in the background, throttled by the idle delay,
  // message threshold, and cooldown below — so "on" means "occasionally," not
  // "every turn." Set ESHEPHERD_AUTO_CONSOLIDATION_ENABLED=false to opt out
  // (e.g. ad-hoc opencode runs on machines where background writes are unwanted).
  const autoConsolidationEnabled = cfgBool("consolidation.auto.enabled", true)
  const autoConsolidationOnIdle = cfgBool("consolidation.auto.onIdle", true)
  const autoConsolidationOnCompact = cfgBool("consolidation.auto.onCompact", true)
  const autoConsolidationIdleDelayMs = cfgNum("consolidation.auto.idleDelayMs", DEFAULT_AUTOCONSOLIDATION_IDLE_DELAY_MS)
  const autoConsolidationMessageThreshold = cfgNum("consolidation.auto.messageThreshold", DEFAULT_AUTOCONSOLIDATION_MESSAGE_THRESHOLD)
  const autoConsolidationCooldownMs = cfgNum("consolidation.auto.cooldownMs", DEFAULT_AUTOCONSOLIDATION_COOLDOWN_MS)
  const autoConsolidationTimeoutMs = cfgNum("commands.autoConsolidation.timeoutMs", DEFAULT_AUTOCONSOLIDATION_TIMEOUT_MS)
  const autoConsolidationMaxTrackedSessions = cfgNum("consolidation.auto.maxTrackedSessions", DEFAULT_AUTOCONSOLIDATION_MAX_TRACKED_SESSIONS)
  const allowedConsolidationWriters = new Set(
    cfgCSV("consolidation.allowedWriters").length > 0
      ? cfgCSV("consolidation.allowedWriters").map((item) => item.toLowerCase())
      : DEFAULT_ALLOWED_CONSOLIDATION_WRITERS,
  )

  // --- retry state ---
  // Allow one follow-up retry when the first retry still ends mid-intent,
  // while keeping a strict cap to avoid loops.
  const retriedParentBySession = new Map<string, Map<string, number>>()
  // Total auto-retries issued per session (see DEFAULT_MAX_RETRIES_PER_SESSION):
  // a keying-independent hard stop so a persistent stall cannot loop unbounded.
  const retriesTotalBySession = new Map<string, number>()
  // Chain counter: increments on each retry issued for a session, resets to 0
  // when a turn is consideredComplete or a real (non-injected) user message arrives.
  // This is the authoritative bound against runaway retry chains where per-parent
  // keying shifts every generation.
  const retryChainBySession = new Map<string, number>()
  const maxRetriesPerSession = Math.max(
    1,
    cfgNum("retry.maxRetriesPerSession", DEFAULT_MAX_RETRIES_PER_SESSION),
  )
  const startupConfirmedBySession = new Set<string>()
  const inspectedStopBySession = new Map<string, Set<string>>()

  // --- loop guard state ---
  // Recent tool-call signatures per session (oldest first), cleared by any
  // mutating tool and by each intervention (so the nudge gets a clean slate).
  const toolWindowBySession = new Map<string, string[]>()
  const loopInterventionsBySession = new Map<string, number>()
  const taskWindowBySession = new Map<string, string[]>()
  const taskEscalationsBySession = new Map<string, number>()
  const taskRecentLaunchBySession = new Map<string, Map<string, number>>()
  // Phase 13 CREATE: in-session dedup — shapeKey → timestamp of last filed example.
  // Prevents filing near-duplicate worked examples for the same problem shape.
  const workedExampleFiledByShape = new Map<string, Map<string, number>>()
  const loopGuardEnabled = cfgBool("loopGuard.enabled", DEFAULT_LOOP_GUARD_ENABLED)
  const loopRepeatThreshold = cfgNum("loopGuard.repeatThreshold", DEFAULT_LOOP_REPEAT_THRESHOLD)
  const loopWindowSize = cfgNum("loopGuard.windowSize", DEFAULT_LOOP_WINDOW_SIZE)
  const loopMaxInterventions = cfgNum("loopGuard.maxInterventions", DEFAULT_LOOP_MAX_INTERVENTIONS)
  const loopMutationTools = toLowerSet(
    cfgCSV("loopGuard.mutationTools").length > 0
      ? cfgCSV("loopGuard.mutationTools")
      : DEFAULT_LOOP_MUTATION_TOOLS,
  )
  const loopExemptTools = toLowerSet([
    ...DEFAULT_LOOP_EXEMPT_TOOLS,
    ...cfgCSV("loopGuard.exemptTools"),
  ])
  const taskWatchdogEnabled = cfgBool("taskWatchdog.enabled", DEFAULT_TASK_WATCHDOG_ENABLED)
  const taskWatchdogThreshold = cfgNum("taskWatchdog.repeatThreshold", DEFAULT_TASK_WATCHDOG_THRESHOLD)
  const taskWatchdogMaxEscalations = cfgNum("taskWatchdog.maxEscalations", DEFAULT_TASK_WATCHDOG_MAX_ESCALATIONS)
  const taskSerializeCsv = cfgCSV("taskWatchdog.serializeTypes")
  const taskSerializeTypes = toLowerSet(
    taskSerializeCsv.length > 0 ? taskSerializeCsv : DEFAULT_TASK_SERIALIZE_TYPES,
  )
  const taskSerializeCooldownMs = cfgNum("taskWatchdog.serializeCooldownMs", DEFAULT_TASK_SERIALIZE_COOLDOWN_MS)
  const taskSwapQwenMatch = String(
    cfgRaw("taskWatchdog.swap.qwen.match") || DEFAULT_TASK_SWAP_QWEN_MATCH,
  )
    .trim()
    .toLowerCase()
  const taskSwapQwenToProvider = String(cfgRaw("taskWatchdog.swap.qwen.toProvider") || "").trim()
  const taskSwapQwenToModel = String(
    cfgRaw("taskWatchdog.swap.qwen.toModel") || DEFAULT_TASK_SWAP_QWEN_TO_MODEL,
  ).trim()
  const taskSwapGemmaMatch = String(
    cfgRaw("taskWatchdog.swap.gemma.match") || DEFAULT_TASK_SWAP_GEMMA_MATCH,
  )
    .trim()
    .toLowerCase()
  const taskSwapGemmaToProvider = String(cfgRaw("taskWatchdog.swap.gemma.toProvider") || "").trim()
  const taskSwapGemmaToModel = String(
    cfgRaw("taskWatchdog.swap.gemma.toModel") || DEFAULT_TASK_SWAP_GEMMA_TO_MODEL,
  ).trim()
  const taskFallbackProvider = String(cfgRaw("taskWatchdog.fallback.provider") || "").trim()
  const taskFallbackModel = String(cfgRaw("taskWatchdog.fallback.model") || "").trim()

  // Phase 13 (worked-example injection): config + lazy palace client.
  const workedExampleInjectionEnabled = cfgBool(
    "taskWatchdog.workedExampleInjection.enabled",
    DEFAULT_WORKED_EXAMPLE_INJECTION_ENABLED,
  )
  const workedExampleSearchTimeoutMs = cfgNum(
    "taskWatchdog.workedExampleInjection.searchTimeoutMs",
    DEFAULT_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS,
  )
  // Phase 13 CREATE: config for filing worked examples on successful subagent completion.
  const workedExampleFilingEnabled = cfgBool(
    "taskWatchdog.workedExampleFiling.enabled",
    DEFAULT_WORKED_EXAMPLE_FILING_ENABLED,
  )
  // Phase 14 CREATE: config for recording capability tuples on routing-tier subagent completion.
  const capabilityRecordingEnabled = cfgBool(
    "taskWatchdog.capabilityRecording.enabled",
    DEFAULT_CAPABILITY_RECORDING_ENABLED,
  )
  // Phase 15 CREATE: config for recording per-model failure events + interventions.
  const failureRecordingEnabled = cfgBool(
    "taskWatchdog.failureRecording.enabled",
    DEFAULT_FAILURE_RECORDING_ENABLED,
  )
  // Phase 16 CREATE: config for capturing self-reported confidence at subagent completion.
  const calibrationCaptureEnabled = cfgBool(
    "taskWatchdog.calibrationCapture.enabled",
    DEFAULT_CALIBRATION_CAPTURE_ENABLED,
  )
  // Phase 15 CONSUME: config for injecting (model, shape) intervention patches.
  const failurePatchInjectionEnabled = cfgBool(
    "taskWatchdog.failurePatchInjection.enabled",
    DEFAULT_FAILURE_PATCH_INJECTION_ENABLED,
  )
  // Session-local dedup for capability recording — prevents double-recording the
  // same (message, part) on repeated idle events. Keyed by subagentType:shapeKey.
  const capabilityRecordedBySession = new Map<string, Set<string>>()
  // Phase 16 CREATE: pending calibration captures keyed by session. Each entry holds
  // the (modelId, shapeKey, confidence) triple parsed from a completed subagent's
  // terminal CONFIDENCE line. These are PENDING — they become durable es-calibration-
  // outcome edges only when the operator records an es-outcome for that unit via
  // record_outcome with matching model_id/task_shape/confidence args. The map is
  // session-scoped and pruned like other per-session state; nothing here writes to
  // the palace directly (no proxy outcome labels).
  const pendingCalibrationBySession = new Map<string, Array<{ modelId: string; shapeKey: string; confidence: string }>>()
  // Phase 15 CREATE: session-local dedup for failure-event recording. Turn-guard
  // events can fire repeatedly in one session (repeated loop nudges on the same
  // model/shape); identical (bucketId, event) pairs are recorded once per session.
  const failureRecordedBySession = new Map<string, Set<string>>()
  // Phase 15 CREATE: pending intervention patches awaiting proof of success.
  // An intervention text is NOT durable knowledge the moment it is attempted —
  // only when there is deterministic evidence it actually broke the loop/spiral.
  // Each guard that issues a nudge queues its patch here (keyed by message id);
  // onMessageUpdated later confirms or expires it:
  //   - retry / spiral nudges: confirmed when the next assistant stop for this
  //     session is considered complete by the SAME predicates issueRetry uses
  //     (hasUsefulPayload && !endsMidIntent && (!reviewRequired || hasReview)).
  //     That is the "subsequent clean completion" signal — no LLM, just the
  //     existing turn-guard observable state.
  //   - loop-block nudges: confirmed when the model's next tool call in this
  //     session is a DIFFERENT signature than the one that was blocked (the
  //     guard itself wipes its window after a nudge, so any next non-exempt tool
  //     call is by construction different). Repeating the identical call
  //     expires the pending patch instead.
  // Expired / unconfirmed patches are dropped — failed attempts never persist.
  const pendingInterventionBySession = new Map<string, Array<{ key: string; label: string; text: string }>>()
  let workedExampleClientPromise: Promise<any> | null = null
  // Phase 14/15 CONSUME (live routing): a full MemgraphClient used ONLY to read
  // capability + failure evidence before choosing a delegation tier. Kept separate
  // from the thin worked-example wrapper above because it needs the composed
  // getFailureAdjustedRouting method, not just raw kgQuery. Lazy + cached exactly
  // like getWorkedExampleClient; init failure degrades to null (neutral routing).
  let routingEvidenceClientPromise: Promise<any> | null = null
  function getRoutingEvidenceClient(): Promise<any> {
    if (!routingEvidenceClientPromise) {
      routingEvidenceClientPromise = (async () => {
        const mcpURL = String(cfgRaw("mcp.url") || "").trim() || DEFAULT_MCP_URL
        const toolPrefix = String(cfgRaw("mcp.toolPrefix") || "").trim() || DEFAULT_MCP_TOOL_PREFIX
        // Pre-Rung-3 this path resolved headers directly from env with NO loopback
        // strip (it always sent gateway credentials). Pass them explicitly so the
        // core/ seam stays byte-identical to the old behavior.
        const headers = resolveMCPHeadersFromEnv(runtimeEnv)
        // Construct through the core/ seam (Check A2): owns transport + initialize.
        const { client: mcp } = await createSubstrateClient({
          env: runtimeEnv,
          clientName: "electric-shepherd-turn-guard-routing",
          urlOverride: mcpURL,
          headersOverride: headers,
          requestTimeoutMs: workedExampleSearchTimeoutMs,
          maxRetries: 0,
        })
        return createMemgraphClient({
          // Return the SubstrateResult directly so memgraph's typed failure handling
          // (slice 2) can branch on ok/kind instead of treating a failure as an empty result.
          callTool: async (name: string, args?: Record<string, unknown>) => mcp.callToolResult(name, args),
          toolPrefix,
        })
      })().catch((err) => {
        console.log(`[turn-guard] routing evidence client init failed (neutral routing): ${String(err)}`)
        return null
      })
    }
    return routingEvidenceClientPromise
  }
  function getWorkedExampleClient(): Promise<any> {
    if (!workedExampleClientPromise) {
      workedExampleClientPromise = (async () => {
        const mcpURL = String(cfgRaw("mcp.url") || "").trim() || DEFAULT_MCP_URL
        const toolPrefix = String(cfgRaw("mcp.toolPrefix") || "").trim() || DEFAULT_MCP_TOOL_PREFIX
        // Pre-Rung-3 this path resolved headers directly from env with NO loopback
        // strip (it always sent gateway credentials). Pass them explicitly so the
        // core/ seam stays byte-identical to the old behavior.
        const headers = resolveMCPHeadersFromEnv(runtimeEnv)
        // Construct through the core/ seam (Check A2): owns transport + initialize.
        const { client: mcp } = await createSubstrateClient({
          env: runtimeEnv,
          clientName: "electric-shepherd-turn-guard",
          urlOverride: mcpURL,
          headersOverride: headers,
          requestTimeoutMs: workedExampleSearchTimeoutMs,
          maxRetries: 0,
        })
        const callRaw = async (toolName: string, args?: Record<string, unknown>) => {
          const result = await mcp.callToolResult(toolName, args)
          if (!result.ok) throw new SubstrateError(result.kind, result.detail)
          return result.value
        }
        return {
          search: (q: string, limit?: number, wing?: string, room?: string) =>
            callRaw(`${toolPrefix}search`, { query: q, limit, wing, room }),
          getDrawer: (args: { drawer_id: string }) =>
            callRaw(`${toolPrefix}get_drawer`, args),
          // Phase 13 CREATE: write path for filing worked examples + stamping.
          diaryWrite: (args: Record<string, unknown>) =>
            mcp.callToolResult(`${toolPrefix}diary_write`, args),
          kgAdd: (args: Record<string, unknown>) =>
            mcp.callToolResult(`${toolPrefix}kg_add`, args),
          // Phase 15 CONSUME: bounded one-hop KG read for failure-mode patches.
          kgQuery: (args: Record<string, unknown>) =>
            mcp.callToolResult(`${toolPrefix}kg_query`, args),
        }
      })().catch((err) => {
        console.log(`[turn-guard] worked-example injection: palace client init failed: ${String(err)}`)
        return null
      })
    }
    return workedExampleClientPromise
  }

  // Phase 13 CREATE: file a compact worked example to the apprenticeship room when a
  // cloud implementation subagent (implement-cloud, build-cloud) completes
  // successfully with substantive output. Best-effort: any failure (MCP down, stamp
  // rejected, dedup hit) degrades to a log line and NEVER throws into the turn. The
  // entry is stamped es-source-type: worked-example via kg_add after filing — a
  // distinct knowledge class from procedural skills; the CONSUME side admits both
  // "worked-example" and (for backward compatibility) "skill" via
  // WORKED_EXAMPLE_SOURCE_TYPES in adapter/retrieval-expansion.ts.
  async function maybeFileWorkedExample(args: {
    sid: string
    subagentType: string
    description: string
    prompt: string
    output: string
  }): Promise<void> {
    const { sid, subagentType, description, prompt, output } = args

    const isTargetSubagentType = WORKED_EXAMPLE_FILE_AGENT_TYPES.has(subagentType)
    if (
      !shouldFileWorkedExample({
        enabled: workedExampleFilingEnabled,
        isTargetSubagentType,
        output,
        minSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      })
    ) {
      return
    }
    const trimmedOutput = String(output || "").trim()

    // Gate 3: in-session near-duplicate suppression by shape key.
    const shape = extractWorkedExampleShape(`${description}\n${prompt}`)
    const filedBySession = workedExampleFiledByShape.get(sid) ?? new Map<string, number>()
    const nowMs = Date.now()
    const lastFiledAt = Number(filedBySession.get(shape.shapeKey) ?? 0)
    if (shouldSkipWorkedExampleByCooldown({ nowMs, lastFiledAtMs: lastFiledAt, cooldownMs: 30 * 60 * 1000 })) {
      console.log(
        `[turn-guard] worked-example filing: skipping near-duplicate shape ${shape.shapeKey} ` +
          `(filed ${Math.round((nowMs - lastFiledAt) / 1000)}s ago) sid=${sid}`,
      )
      return
    }

    const entry = buildWorkedExampleEntry({ subagentType, description, output: trimmedOutput, shape })
    const wing = String(cfgRaw("memory.projectWing") || "").trim() || "opencode"
    const room = "apprenticeship"

    try {
      const palaceClient = await getWorkedExampleClient()
      if (!palaceClient || typeof palaceClient.diaryWrite !== "function") return

      // File the worked example.
      const writeResult: any = await palaceClient.diaryWrite({
        wing,
        room,
        entry,
        agent_name: "turn-guard",
        topic: `worked-example-${subagentType}`,
      })
      if (!writeResult?.ok) {
        console.log(
          `[turn-guard] worked-example filing: diary_write failed (${writeResult?.kind ?? "unknown"}): ${String(writeResult?.detail ?? writeResult)} sid=${sid}`
        )
        return
      }
      const result = writeResult.value

      // Stamp es-source-type: worked-example via kg_add (best-effort — a stamp
      // failure does not invalidate the filed example; absence of stamp is not a
      // rejection on the CONSUME side).
      const drawerId = String(result?.drawer_id ?? result?.id ?? "").trim()
      if (drawerId && typeof palaceClient.kgAdd === "function") {
        const stampResult: any = await palaceClient.kgAdd({
          subject: drawerId,
          predicate: "es-source-type",
          object: "worked-example",
          source_closet: drawerId,
        })
        if (!stampResult?.ok) {
          console.log(
            `[turn-guard] worked-example filing: stamp failed (non-fatal; ${stampResult?.kind ?? "unknown"}): ${String(stampResult?.detail ?? stampResult)} sid=${sid}`
          )
        }
      }

      // Record the filing for in-session dedup.
      filedBySession.set(shape.shapeKey, nowMs)
      workedExampleFiledByShape.set(sid, filedBySession)

      console.log(
        `[turn-guard] worked-example filing: filed ${subagentType} example ` +
          `(shape=${shape.workClass}/${shape.shapeKey}, drawer=${drawerId || "?"}) sid=${sid}`,
      )
    } catch (err) {
      // Filing failure must never break the turn.
      console.log(`[turn-guard] worked-example filing: failed, continuing: ${String(err)}`)
    }
  }

  // Phase 14 CREATE: record a capability tuple (task shape, tier, outcome) when a
  // routing-tier subagent completes. Best-effort: any failure (MCP down, stamp
  // rejected, dedup hit) degrades to a log line and NEVER throws into the turn.
  // The outcome is derived from the task tool part status — NOT from Phase 7's
  // es-outcome axis (which is human-authoritative and attached to consulted memory
  // nodes, not to units/tiers). This keeps Phase 7's policy intact while giving
  // Phase 14 the unit-level evidence it needs for learned routing.
  async function maybeRecordCapabilityTuple(args: {
    sid: string
    subagentType: string
    description: string
    prompt: string
    status: string
  }): Promise<void> {
    if (!capabilityRecordingEnabled) return
    const { sid, subagentType, description, prompt, status } = args

    // Gate 1: only routing tiers are recorded (utility/analysis subagents skipped).
    const tier = CAPABILITY_TIER_BY_SUBAGENT[subagentType]
    if (!tier) return

    // Gate 2: closed outcome set — unknown statuses are skipped, not guessed.
    const outcome = mapTaskStatusToCapabilityOutcome(status)
    if (!outcome) return

    // Gate 3: session-local dedup — same (message, part) must not double-record on
    // repeated idle events. Keyed by subagentType + shapeKey (the part's identity
    // within the message is stable across idle passes for the same completion).
    const shape = extractWorkedExampleShape(`${description}\n${prompt}`)
    const dedupKey = `${subagentType}:${shape.shapeKey}`
    const recordedBySession = capabilityRecordedBySession.get(sid) ?? new Set<string>()
    if (recordedBySession.has(dedupKey)) {
      console.log(
        `[turn-guard] capability recording: skipping duplicate ${dedupKey} sid=${sid}`,
      )
      return
    }

    const bucketId = buildCapabilityBucketId(shape.shapeKey, tier)
    const canonicalShape = buildCapabilityCanonicalShape(shape)

    try {
      const palaceClient = await getWorkedExampleClient()
      if (!palaceClient || typeof palaceClient.kgAdd !== "function") return

      // Record the outcome edge (the core of the capability tuple).
      const outcomeResult: any = await palaceClient.kgAdd({
        subject: bucketId,
        predicate: "es-capability-outcome",
        object: outcome,
        valid_from: new Date().toISOString(),
        source_closet: bucketId,
      })
      if (!outcomeResult?.ok) {
        console.log(
          `[turn-guard] capability recording: failed (${outcomeResult?.kind ?? "unknown"}): ${String(outcomeResult?.detail ?? outcomeResult)} sid=${sid}`
        )
        return
      }

      // Best-effort shape metadata for explainability (one-time per bucket; a
      // duplicate stamp is harmless and idempotent on the read side).
      const shapeResult: any = await palaceClient.kgAdd({
        subject: bucketId,
        predicate: "es-capability-shape",
        object: canonicalShape.slice(0, 200),
        source_closet: bucketId,
      })
      if (!shapeResult?.ok) {
        console.log(
          `[turn-guard] capability recording: shape stamp failed (non-fatal; ${shapeResult?.kind ?? "unknown"}): ${String(shapeResult?.detail ?? shapeResult)} sid=${sid}`
        )
      }
      const tierResult: any = await palaceClient.kgAdd({
        subject: bucketId,
        predicate: "es-capability-tier",
        object: tier,
        source_closet: bucketId,
      })
      if (!tierResult?.ok) {
        console.log(
          `[turn-guard] capability recording: tier stamp failed (non-fatal; ${tierResult?.kind ?? "unknown"}): ${String(tierResult?.detail ?? tierResult)} sid=${sid}`
        )
      }

      // Record the dedup key for this session.
      recordedBySession.add(dedupKey)
      capabilityRecordedBySession.set(sid, recordedBySession)

      console.log(
        `[turn-guard] capability recording: recorded ${subagentType} -> ${tier} (${outcome}) ` +
          `(shape=${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}, bucket=${bucketId}) sid=${sid}`,
      )
    } catch (err) {
      // Recording failure must never break the turn.
      console.log(`[turn-guard] capability recording: failed, continuing: ${String(err)}`)
    }
  }

  // Phase 16 CREATE: capture the self-reported confidence label from a completed
  // subagent's terminal output and queue it as a PENDING calibration tuple for this
  // session. The tuple (modelId, shapeKey, confidence) is stored session-locally;
  // it becomes a durable es-calibration-outcome edge ONLY when the operator later
  // records an es-outcome for that unit via record_outcome with matching args.
  // No proxy outcome labels are written here — this is capture only.
  async function maybeCaptureCalibrationTuple(args: {
    sid: string
    model?: { providerID: string; modelID: string } | null
    description: string
    prompt: string
    outputText: string
  }): Promise<void> {
    if (!calibrationCaptureEnabled) return
    const { sid, model, description, prompt, outputText } = args

    // Gate 1: deterministic model identity — unknown model => skip (no guessing).
    const modelId = canonicalModelId(model?.providerID, model?.modelID)
    if (!modelId) return

    // Gate 2: shape from the SAME Phase 14/13 shape function.
    const shape = extractWorkedExampleShape(`${description}\n${prompt}`)

    // Gate 3: parse the self-reported confidence from the terminal output.
    // Returns null when no CONFIDENCE line is present — skip, don't guess.
    const confidence = parseSelfReportedConfidence(outputText)
    if (!confidence) return

    // Queue the pending tuple for this session. Dedup: same (modelId, shapeKey, confidence)
    // is recorded once per session (repeated idle events on the same completion).
    const pending = pendingCalibrationBySession.get(sid) ?? []
    const dedupKey = `${modelId}:${shape.shapeKey}:${confidence}`
    if (pending.some((p) => `${p.modelId}:${p.shapeKey}:${p.confidence}` === dedupKey)) return

    pending.push({ modelId, shapeKey: shape.shapeKey, confidence })
    pendingCalibrationBySession.set(sid, pending)

    console.log(
      `[turn-guard] calibration capture: queued ${modelId} / ${shape.shapeKey} / ${confidence} ` +
        `(bucket=${buildCalibrationBucketId(modelId, shape.shapeKey, confidence)}) sid=${sid}`,
    )
  }

  // Phase 15 CREATE (worked-intervention persistence): stamp the prompt patch that
  // BROKE a loop/spiral for this (model, shape) — durable procedural knowledge.
  // Called ONLY from confirmPendingInterventions with evidence of success; never
  // called at nudge time (an attempted nudge is not proof it worked). Best-effort:
  // any failure degrades to a log line and NEVER throws into the turn.
  async function persistWorkedIntervention(args: {
    sid: string
    model?: { providerID: string; modelID: string } | null
    taskText: string
    interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"
    interventionText: string
  }): Promise<void> {
    if (!failureRecordingEnabled) return
    const { sid, model, taskText, interventionLabel, interventionText } = args

    // Gate 1: deterministic model identity — unknown model => skip (no guessing).
    const modelId = canonicalModelId(model?.providerID, model?.modelID)
    if (!modelId) return

    // Gate 2: shape from the SAME Phase 14/13 shape function.
    const shape = extractWorkedExampleShape(taskText)
    const text = String(interventionText || "").trim().slice(0, FAILURE_PATCH_TEXT_MAX_CHARS)
    if (!text) return

    try {
      const palaceClient = await getWorkedExampleClient()
      if (palaceClient && typeof palaceClient.kgAdd === "function") {
        const patchId = buildFailurePatchId(modelId, shape.shapeKey, interventionLabel)
        const labelResult: any = await palaceClient.kgAdd({
          subject: patchId,
          predicate: "es-intervention-label",
          object: interventionLabel,
          source_closet: patchId,
        })
        if (!labelResult?.ok) {
          console.log(
            `[turn-guard] failure recording: intervention failed (${labelResult?.kind ?? "unknown"}): ${String(labelResult?.detail ?? labelResult)} sid=${sid}`
          )
          return
        }
        const textResult: any = await palaceClient.kgAdd({
          subject: patchId,
          predicate: "es-intervention-text",
          object: text,
          source_closet: patchId,
        })
        if (!textResult?.ok) {
          console.log(
            `[turn-guard] failure recording: intervention failed (${textResult?.kind ?? "unknown"}): ${String(textResult?.detail ?? textResult)} sid=${sid}`
          )
          return
        }
        console.log(
          `[turn-guard] failure recording: WORKED intervention ${interventionLabel} persisted ` +
            `for ${modelId} (shape=${shape.shapeKey}, patch=${patchId}) sid=${sid}`,
        )
      }
    } catch (err) {
      // Intervention recording failure must never break the turn.
      console.log(`[turn-guard] failure recording: intervention failed, continuing: ${String(err)}`)
    }
  }

  // Phase 15 CREATE (failure-event recording): record a per-model failure event
  // when a loop/spiral intervention FIRES, attributed to (model, task shape). The
  // model is the deterministic `provider/model` from routing context; if unknown,
  // skip — an unattributable event is worse than no event. The shape reuses
  // Phase 14's extractWorkedExampleShape / buildCapabilityCanonicalShape (the SAME
  // shape function, per spec). Failure events are recorded at event time: the
  // nudge/spiral WAS attempted, and that attempt is a real data point for routing
  // penalties. The intervention TEXT, by contrast, is only durable once proven to
  // have worked — see queuePendingIntervention / confirmPendingInterventions.
  // Best-effort: any failure degrades to a log line and NEVER throws into the turn.
  async function maybeRecordModelFailure(args: {
    sid: string
    model?: { providerID: string; modelID: string } | null
    taskText: string
    event: "spiral" | "loop"
    interventionLabel: "spiral-nudge" | "retry-nudge" | "loop-block"
    interventionText: string
  }): Promise<void> {
    if (!failureRecordingEnabled) return
    const { sid, model, taskText, event } = args

    // Gate 1: deterministic model identity — unknown model => skip (no guessing).
    const modelId = canonicalModelId(model?.providerID, model?.modelID)
    if (!modelId) return

    // Gate 2: shape from the SAME Phase 14/13 shape function.
    const shape = extractWorkedExampleShape(taskText)

    // Gate 3: session-local dedup — repeated identical (bucket, event) in one
    // session records once (the pattern is already captured; a second nudge on the
    // same bucket adds nothing to the count).
    const bucketId = buildFailureBucketId(modelId, shape.shapeKey)
    const dedupKey = `${bucketId}:${event}`
    const recordedBySession = failureRecordedBySession.get(sid) ?? new Set<string>()
    if (recordedBySession.has(dedupKey)) {
      console.log(
        `[turn-guard] failure recording: skipping duplicate ${dedupKey} sid=${sid}`,
      )
      return
    }

    try {
      const palaceClient = await getWorkedExampleClient()
      if (palaceClient && typeof palaceClient.kgAdd === "function") {
        const eventResult: any = await palaceClient.kgAdd({
          subject: bucketId,
          predicate: "es-failure-event",
          object: event,
          valid_from: new Date().toISOString(),
          source_closet: bucketId,
        })
        if (!eventResult?.ok) {
          console.log(
            `[turn-guard] failure recording: event failed (${eventResult?.kind ?? "unknown"}): ${String(eventResult?.detail ?? eventResult)} sid=${sid}`
          )
          return
        }
        // Best-effort shape metadata for explainability (idempotent on the read side).
        const shapeResult: any = await palaceClient.kgAdd({
          subject: bucketId,
          predicate: "es-failure-shape",
          object: buildCapabilityCanonicalShape(shape).slice(0, 200),
          source_closet: bucketId,
        })
        if (!shapeResult?.ok) {
          console.log(
            `[turn-guard] failure recording: shape stamp failed (non-fatal; ${shapeResult?.kind ?? "unknown"}): ${String(shapeResult?.detail ?? shapeResult)} sid=${sid}`
          )
        }
        recordedBySession.add(dedupKey)
        failureRecordedBySession.set(sid, recordedBySession)
        console.log(
          `[turn-guard] failure recording: recorded ${event} for ${modelId} ` +
            `(shape=${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}, bucket=${bucketId}) sid=${sid}`,
        )
      }
    } catch (err) {
      // Recording failure must never break the turn.
      console.log(`[turn-guard] failure recording: event failed, continuing: ${String(err)}`)
    }
  }

  // Phase 15 CREATE: queue an attempted intervention patch for later success
  // confirmation. Deduped by key (message id); a new nudge on the same message
  // replaces the pending entry so only the latest wording is confirmable.
  function queuePendingIntervention(sid: string, key: string, label: string, text: string): void {
    if (!failureRecordingEnabled) return
    const t = String(text || "").trim().slice(0, FAILURE_PATCH_TEXT_MAX_CHARS)
    if (!t) return
    const list = pendingInterventionBySession.get(sid) ?? []
    const next = list.filter((p) => p.key !== key)
    next.push({ key, label, text: t })
    // Bound the queue: at most one pending entry per guard site (3 sites), so a
    // pathological session cannot grow this unbounded.
    while (next.length > 6) next.shift()
    pendingInterventionBySession.set(sid, next)
  }

  // Phase 15 CREATE (success signal): confirm or expire the pending intervention
  // patches for this session and persist the ones with evidence of success.
  // `confirmedKey` is the key whose nudge demonstrably broke the loop/spiral:
  //   - retry / spiral nudges — called from onMessageUpdated when the next
  //     assistant stop is considered complete by issueRetry's own predicates
  //     (subsequent clean completion, no LLM);
  //   - loop-block nudges — called from tool.execute.before when the model's next
  //     tool call has a DIFFERENT signature than the blocked one.
  // Every OTHER pending entry is expired (dropped without persistence): its
  // intervention did not demonstrably work, so it must not become durable
  // procedural knowledge. Best-effort: never throws into the turn.
  async function confirmPendingInterventions(args: {
    sid: string
    confirmedKey?: string
    model?: { providerID: string; modelID: string } | null
    taskText: string
  }): Promise<void> {
    if (!failureRecordingEnabled) return
    const { sid, confirmedKey, model, taskText } = args
    const list = pendingInterventionBySession.get(sid) ?? []
    if (list.length === 0) return
    const confirmed = confirmedKey ? list.filter((p) => p.key === confirmedKey) : []
    const expired = list.filter((p) => !confirmedKey || p.key !== confirmedKey)
    pendingInterventionBySession.delete(sid)
    for (const entry of expired) {
      console.log(
        `[turn-guard] failure recording: intervention ${entry.label} NOT proven to work — expired, not persisted sid=${sid}`,
      )
    }
    if (confirmed.length === 0) return
    for (const entry of confirmed) {
      try {
        await persistWorkedIntervention({
          sid,
          model: model ?? null,
          taskText,
          interventionLabel: entry.label as "spiral-nudge" | "retry-nudge" | "loop-block",
          interventionText: entry.text,
        })
      } catch (err) {
        console.log(`[turn-guard] failure recording: confirm failed, continuing: ${String(err)}`)
      }
    }
  }

  // Loop-guard status banner. Emitted HERE, after the consts above are
  // initialized — emitting it earlier is a temporal-dead-zone ReferenceError
  // that throws before the hooks object returns, silently disabling the plugin.
  console.log(
    `[turn-guard] loop guard: ${
      loopGuardEnabled
        ? `ON (aborts a tool call repeated ${loopRepeatThreshold}x with no edit between; max ${loopMaxInterventions} nudges/session)`
        : "OFF (ESHEPHERD_LOOPGUARD_ENABLED=true to opt in)"
    }`,
  )

  // --- deliberation-spiral guard state ---
  const spiralGuardEnabled = cfgBool("spiralGuard.enabled", DEFAULT_SPIRAL_GUARD_ENABLED)
  const spiralInvestigateThreshold = cfgNum("spiralGuard.investigateThreshold", DEFAULT_SPIRAL_INVESTIGATE_THRESHOLD)
  const spiralReversalThreshold = cfgNum("spiralGuard.reversalThreshold", DEFAULT_SPIRAL_REVERSAL_THRESHOLD)
  const spiralMaxInterventions = cfgNum("spiralGuard.maxInterventions", DEFAULT_SPIRAL_MAX_INTERVENTIONS)
  const spiralExemptReflection = cfgBool("spiralGuard.exemptReflection", true)
  const spiralGuardDisabledModes = toLowerSet(cfgCSV("spiralGuard.disabledModes"))
  const spiralGuardDisabledAgents = toLowerSet(cfgCSV("spiralGuard.disabledAgents"))
  const spiralExemptProviders = toLowerSet(
    cfgCSV("spiralGuard.exemptProviders").concat(DEFAULT_SPIRAL_EXEMPT_PROVIDERS),
  )
  const spiralExemptModelPrefixes = toLowerSet(
    cfgCSV("spiralGuard.exemptModelPrefixes").concat(
      DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES,
    ),
  )
  // Nudges issued per session, and message IDs already inspected (message.updated
  // can fire repeatedly for one message; dedupe so a stop is judged once).
  const spiralNudgedBySession = new Map<string, number>()
  const spiralInspectedBySession = new Map<string, Set<string>>()
  console.log(
    `[turn-guard] spiral guard: ${
      spiralGuardEnabled
        ? `ON (nudges a finish=stop turn with >=${spiralInvestigateThreshold} announced-but-unexecuted investigations and no action part; max ${spiralMaxInterventions} nudges/session)`
    : "OFF (ESHEPHERD_SPIRALGUARD_ENABLED=true to opt in)"
     }`,
   )

  // P3-7: structured effective-config echo — single JSON line for programmatic parsing
  console.log(
    `[turn-guard] config=${JSON.stringify({
      retryEnabled,
      maxRetriesPerSession,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      memcoreMaxChars,
      injectionCooldownMs,
      loopGuardEnabled,
      loopRepeatThreshold,
      loopWindowSize,
      loopMaxInterventions,
      taskWatchdogEnabled,
      taskWatchdogThreshold,
      taskWatchdogMaxEscalations,
      taskSerializeTypes: [...taskSerializeTypes],
      taskSerializeCooldownMs,
      workedExampleInjectionEnabled,
      workedExampleSearchTimeoutMs,
      workedExampleFilingEnabled,
      capabilityRecordingEnabled,
      failureRecordingEnabled,
      failurePatchInjectionEnabled,
      spiralInvestigateThreshold,
      spiralReversalThreshold,
      spiralMaxInterventions,
      consolidationWriteGuardEnabled,
      sourceCaptureVerifyEnabled,
      autoConsolidationEnabled,
      autoConsolidationOnIdle,
      autoConsolidationOnCompact,
      autoConsolidationIdleDelayMs,
      autoConsolidationMessageThreshold,
      autoConsolidationCooldownMs,
      autoConsolidationTimeoutMs,
      autoConsolidationMaxTrackedSessions,
      allowedConsolidationWriters: [...allowedConsolidationWriters],
    })}`,
  )

  // --- checkpoint state ---
  // Agents exempt from the end-of-session memory-checkpoint prompt. Config CSV
  // (checkpoint.disabledAgents) overrides; empty falls back to the built-in
  // utility-subagent list above.
  const checkpointDisabledAgents = toLowerSet(
    cfgCSV("checkpoint.disabledAgents").length > 0 ? cfgCSV("checkpoint.disabledAgents") : DEFAULT_CHECKPOINT_DISABLED_AGENTS,
  )
  const checkpointedSessions = new Set<string>()
  // Count only TERMINAL assistant messages, not streaming updates — otherwise a
  // single reply satisfies the "real work" gate within the first turn.
  const terminalCountBySession = new Map<string, number>()
  const memcoreInjectionBySession = new Map<string, { signature: string; at: number; scopeDir: string }>()
  const activeRoutingBySession = new Map<string, {
    agent?: string
    model?: { providerID: string; modelID: string }
  }>()
  const warnedConsolidationWriteMessageIDs = new Set<string>()
  const memoryReadSessions = new Set<string>()
  const sourceCaptureBySession = new Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>()
  // Tracks post-compaction mem-core reinjection events per session.
  const compactionPathBySession = new Map<string, { path: "post-compact-fallback"; at: string }>()

  // --- auto-consolidation state ---
  // Pending idle-delay timers (cleared/overridden when a new message arrives),
  // last-run timestamps for the cooldown throttle, and a count of new assistant
  // turns since the last run for the volume trigger. A single in-flight flag
  // prevents overlapping background consolidations across all sessions.
  const autoConsolidationPendingTimer = new Map<string, ReturnType<typeof setTimeout>>()
  const autoConsolidationLastRunAt = new Map<string, number>()
  const autoConsolidationMessagesSinceRun = new Map<string, number>()
  let autoConsolidationInFlight = false

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
      checkpointDisabledAgents: [...checkpointDisabledAgents],
      consolidationWriteGuardEnabled,
      sourceCaptureVerifyEnabled,
      autoConsolidationEnabled,
      autoConsolidationOnIdle,
      autoConsolidationOnCompact,
      autoConsolidationIdleDelayMs,
      autoConsolidationMessageThreshold,
      autoConsolidationCooldownMs,
      autoConsolidationTimeoutMs,
      allowedConsolidationWriters: [...allowedConsolidationWriters],
      sessions: {
        checkpointed: checkpointedSessions.size,
        memcoreInjected: memcoreInjectionBySession.size,
        sourceCaptureTracked: sourceCaptureBySession.size,
      },
      lastCompactionPath: compactionPathBySession.size > 0
        ? Object.fromEntries([...compactionPathBySession.entries()].slice(-10))
        : undefined,
      ...extra,
    }
  }

  async function resolveLoopGuardRouting(sid: string, input: any, output: any): Promise<{
    agent?: string
    model?: { providerID: string; modelID: string }
  }> {
    const fromHook = getPromptRoutingFromToolHook(input, output)
    const cached = activeRoutingBySession.get(sid) ?? {}
    let agent = fromHook.agent || cached.agent
    let model = fromHook.model || cached.model

    if (agent && model) {
      return { agent, model }
    }

    const fromSession = await resolveSessionPromptRouting(sid)
    if (!agent) agent = fromSession.agent
    if (!model) model = fromSession.model

    const resolved: {
      agent?: string
      model?: { providerID: string; modelID: string }
    } = {}
    if (agent) resolved.agent = agent
    if (model) resolved.model = model
    if (resolved.agent || resolved.model) {
      activeRoutingBySession.set(sid, resolved)
    }
    return resolved
  }

  async function resolveSessionPromptRouting(sid: string): Promise<{
    agent?: string
    model?: { providerID: string; modelID: string }
  }> {
    const cached = activeRoutingBySession.get(sid) ?? {}
    let agent = cached.agent
    let model = cached.model

    if (agent && model) {
      return { agent, model }
    }

    try {
      const res: any = await client.session.messages({
        path: { id: sid },
        query: { directory },
      })
      const messages = sortByCreated(unwrapListResult(res))
      const tail = messages[messages.length - 1] ?? null
      const previous = messages.length > 1 ? messages[messages.length - 2] : null
      const fromSession = getPromptRouting(tail, previous)

      if (!agent) agent = fromSession.agent
      if (!model) model = fromSession.model
    } catch {
      // best-effort: keep hook/cached routing only
    }

    const resolved: {
      agent?: string
      model?: { providerID: string; modelID: string }
    } = {}
    if (agent) resolved.agent = agent
    if (model) resolved.model = model
    if (resolved.agent || resolved.model) {
      activeRoutingBySession.set(sid, resolved)
    }
    return resolved
  }

  async function maybeInjectMemcore(args: {
    sid: string
    event: any
    reason: "idle" | "compacted" | "started"
    messages?: MessageWithParts[]
    anchor?: MessageWithParts | null
    force?: boolean
  }): Promise<boolean> {
    // Rung 2 (R2-05): every gating refusal must be observable. A silent `return false`
    // made disabled reinjection indistinguishable from "nothing happened" in the
    // status/context logs; each refusal now records an explicit `because` reason.
    if (!memcoreInjectEnabled) {
      appendMemcoreContextLog(projectRoot, {
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        injected: false,
        because: "reinject-disabled",
      })
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        injected: false,
        because: "reinject-disabled",
      }))
      return false
    }
    const perReasonFlag =
      args.reason === "idle" ? memcoreInjectOnIdle
      : args.reason === "compacted" ? memcoreInjectOnCompacted
      : memcoreInjectOnStart
    if (!perReasonFlag) {
      appendMemcoreContextLog(projectRoot, {
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        injected: false,
        because: `reinject-${args.reason}-disabled`,
      })
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        injected: false,
        because: `reinject-${args.reason}-disabled`,
      }))
      return false
    }


    let scopeDir = resolveScopeDirFromEvent(args.event, rootDirectory, cfgRaw("memcore.scopeDir"))
    const pathFromMessages = extractPathFromMessageParts(args.messages || [])
    if (pathFromMessages) {
      scopeDir = existsSync(pathFromMessages) && !pathFromMessages.endsWith(".md") && !pathFromMessages.endsWith(".ts")
        ? pathFromMessages
        : dirname(pathFromMessages)
    }

    const { markdown, loaderInfo } = await loadMemcoreMarkdown(projectRoot, scopeDir, {
      maxScopes: cfgNum("memcore.maxScopes", DEFAULT_MEMCORE_MAX_SCOPES),
      directFileName: cfgRaw("memcore.directFileName") || "memory.md",
      storeRoots: cfgCSV("memcore.storeRoots").length > 0 ? cfgCSV("memcore.storeRoots") : [".electric-shepherd/memory"],
      timeoutMs: cfgNum("commands.memcoreLoader.timeoutMs", DEFAULT_MEMCORE_LOADER_TIMEOUT_MS),
    })
    if (!markdown) {
      appendMemcoreContextLog(projectRoot, {
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        because: "no-memcore-markdown",
      })
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        because: "no-memcore-markdown",
        loaderInfo,
      }))
      return false
    }

    // R2-04: the ENTIRE injected payload (marker + intro + render) must fit within
    // memcore.maxChars. Budget the fixed prelude out of maxChars before clipping so
    // the final text respects the configured budget end-to-end, not just the render.
    const reinjectPrelude =
      `${MEMCORE_REINJECT_MARKER} Refreshing scoped mem-core for this session (reason=${args.reason}). ` +
      `Use this as the currently active resident memory for scope: ${scopeDir}. ` +
      "This is derived render output from derived memory; do not hand-edit mem-core files.\n\n"
    const clipped = clipText(markdown, Math.max(0, memcoreMaxChars - reinjectPrelude.length))
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
      appendMemcoreContextLog(projectRoot, {
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        signature,
        because: "dedup-or-cooldown-skip",
      })
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        signature,
        because: "dedup-or-cooldown-skip",
        loaderInfo,
      }))
      return false
    }

    try {
      const routing = getPromptRouting(args.anchor)
      const body: any = {
        parts: [
          {
            type: "text",
            text: reinjectPrelude + clipped,
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
      appendMemcoreContextLog(projectRoot, {
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: true,
        signature,
        chars: clipped.length,
        preview: clipText(clipped, 1800),
      })
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
      appendMemcoreContextLog(projectRoot, {
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        signature,
        because: "injection-error",
        error: String(err),
      })
      writeStatusFile(projectRoot, statusSnapshot({
        type: "memcore-reinject",
        sid: args.sid,
        reason: args.reason,
        scopeDir,
        injected: false,
        signature,
        because: "injection-error",
        error: String(err),
        loaderInfo,
      }))
      console.error(`[turn-guard] failed mem-core re-injection sid=${args.sid}:`, err)
      return false
    }
  }

  async function maybeWarnWriteAuthority(sid: string, msg: MessageWithParts): Promise<boolean> {
    if (!consolidationWriteGuardEnabled) return false

    const msgID = String(msg?.info?.id ?? "")
    if (msgID && warnedConsolidationWriteMessageIDs.has(msgID)) return false

    const toolNames = getToolNames(msg)
    if (toolNames.length === 0 || !containsConsolidationWriteTool(toolNames)) return false

    const actor = getAgentIdentity(msg)
    const authorized = allowedConsolidationWriters.has(actor)
    if (authorized) return false

    if (msgID) warnedConsolidationWriteMessageIDs.add(msgID)
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
              `${WRITE_AUTHORITY_MARKER} derived memory write tools are restricted to dreamer agents (` +
              `${[...allowedConsolidationWriters].join(", ")}). ` +
              `This turn attempted: ${namesJoined}. ` +
              "Do not call add_drawer/update_drawer/kg_add/kg_invalidate/apply_merge from interactive build/plan flows unless this is an explicit consolidation pass. " +
              "Use diary_write for ordinary findings and reserve derived-memory writes for dreamer consolidation.",
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

  async function verifySourceCapture(sid: string, eventType: string): Promise<void> {
    if (!sourceCaptureVerifyEnabled) return

    const result = await runSourceCaptureCommand(projectRoot, sid, eventType, {
      command: cfgRaw("commands.sourceCapture.command"),
      timeoutMs: cfgNum("commands.sourceCapture.timeoutMs", DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS),
    })
    const prev = sourceCaptureBySession.get(sid)
    const next = {
      totalEvents: Number(prev?.totalEvents || 0) + 1,
      lastEvent: eventType,
      lastAt: new Date().toISOString(),
      lastSuccess: result.ok,
    }
    sourceCaptureBySession.set(sid, next)

    writeStatusFile(projectRoot, statusSnapshot({
      type: "source-capture-verify",
      sid,
      eventType,
      capture: result,
      sessionCaptureState: next,
    }))

    if (!result.attempted) {
      console.log("[turn-guard] source transcript capture verification: command not configured and default script not found")
    }
  }

  // Spawn the deterministic consolidation script in the background. Deterministic
  // (no live mapper) so it never forces a model load. The caller has already set
  // autoConsolidationInFlight and acquired the cross-process lock; this function owns the
  // process lifecycle and is the SOLE place that clears both, via settle().
  //
  // Robustness:
  //   - The default path spawns `node` directly (no shell) so the watchdog can
  //     actually kill the process tree; a user-provided command is free-form and
  //     needs a shell.
  //   - A watchdog kills a run that exceeds autoConsolidationTimeoutMs, so a hung MCP
  //     endpoint can never wedge the in-flight flag permanently.
  //   - settle() is idempotent, so exit/error/timeout racing each other only
  //     clears state once.
  async function runConsolidationCommand(sid: string, trigger: string, onStartFailure?: () => void): Promise<void> {
    const configured = cfgRaw("commands.autoConsolidation.command")
    const startedAt = new Date().toISOString()
    console.log(`[turn-guard] auto-consolidation start sid=${sid} trigger=${trigger}`)
    writeStatusFile(projectRoot, statusSnapshot({ type: "auto-consolidation-start", sid, trigger, startedAt }))

    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const settle = (status: Record<string, unknown>, startFailure = false) => {
      if (settled) return
      settled = true
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      autoConsolidationInFlight = false
      releaseAutoConsolidationLock(projectRoot)
      // A run that never actually started should not consume the cooldown, so a
      // later trigger can retry promptly. A run that started and then failed/timed
      // out keeps the cooldown (anti-thrash).
      if (startFailure) {
        try {
          onStartFailure?.()
        } catch (err) {
          console.error("[turn-guard] auto-consolidation start-failure rollback failed:", err)
        }
      }
      writeStatusFile(projectRoot, statusSnapshot({ ...status, finishedAt: new Date().toISOString() }))
      appendAutoConsolidationLog(
        projectRoot,
        `${new Date().toISOString()} [finish] sid=${sid} trigger=${trigger} status=${JSON.stringify(status)}`,
      )
    }

    try {
      const routing = await resolveSessionPromptRouting(sid)
      const childEnv = buildConsolidationEnv({
        sid,
        trigger,
        projectRoot,
        agent: routing.agent,
        modelProviderID: routing.model?.providerID,
        modelID: routing.model?.modelID,
      })
      // detached:true makes the child a process-group leader on POSIX so the
      // watchdog can kill the entire tree (see killProcessTree); harmless on
      // Windows where taskkill /T handles the tree instead.
      const detached = process.platform !== "win32"
      const plan = buildCommandExecutionPlan({
        configured,
        projectRoot: ESHEPHERD_ROOT,
        defaultScript: join(ESHEPHERD_ROOT, "scripts", "run-memory-consolidation-and-validation.ts"),
        // Absolute: a relative path would resolve against the plugin install, where nothing reads it.
        memcoreFile: join(projectRoot, STATUS_DIR, "memory", "memory.md"),
      })

      if (plan.mode === "rejected") {
        console.error(`[turn-guard] auto-consolidation rejected unsafe command: ${plan.reason}`)
        settle({ type: "auto-consolidation-rejected", sid, trigger, reason: plan.reason }, true)
        return
      }

      const logPath = join(projectRoot, STATUS_DIR, AUTOCONSOLIDATION_LOG_FILE)
      appendAutoConsolidationLog(
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
        appendAutoConsolidationLog(projectRoot, `${new Date().toISOString()} [stdout] sid=${sid} ${text}`)
      })
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk ?? "").trim()
        if (!text) return
        appendAutoConsolidationLog(projectRoot, `${new Date().toISOString()} [stderr] sid=${sid} ${text}`)
      })

      watchdog = setTimeout(() => {
        console.error(
          `[turn-guard] auto-consolidation timeout sid=${sid} trigger=${trigger} after ${autoConsolidationTimeoutMs}ms; killing`,
        )
        killProcessTree(child)
        settle({ type: "auto-consolidation-timeout", sid, trigger, timeoutMs: autoConsolidationTimeoutMs })
      }, autoConsolidationTimeoutMs)
      watchdog.unref?.()

      child.on("error", (err: unknown) => {
        console.error("[turn-guard] auto-consolidation spawn error:", err)
        settle({ type: "auto-consolidation-error", sid, trigger, error: String(err) }, true)
      })
      child.on("exit", (code: number | null) => {
        console.log(`[turn-guard] auto-consolidation finished sid=${sid} trigger=${trigger} code=${String(code)}`)
        settle({ type: "auto-consolidation-finish", sid, trigger, exitCode: code })
      })
      child.unref?.()
    } catch (err) {
      console.error("[turn-guard] auto-consolidation failed to start:", err)
      settle({ type: "auto-consolidation-error", sid, trigger, error: String(err) }, true)
    }
  }

  // Evaluate the opt-in/cooldown/threshold gate and, if it passes, claim the
  // cross-process lock and start a run. State (cooldown stamp, message reset,
  // in-flight) is only stamped once the lock is held, so a run blocked by another
  // process/instance can still fire on a later trigger.
  function evaluateAutoConsolidation(sid: string, trigger: AutoConsolidationTrigger): void {
    const messagesSinceRun = autoConsolidationMessagesSinceRun.get(sid) ?? 0
    const decision = decideAutoConsolidation({
      enabled: autoConsolidationEnabled,
      now: Date.now(),
      lastRunAt: autoConsolidationLastRunAt.get(sid) ?? null,
      cooldownMs: autoConsolidationCooldownMs,
      messagesSinceRun,
      messageThreshold: autoConsolidationMessageThreshold,
      trigger,
      inFlight: autoConsolidationInFlight,
    })

    if (!decision.shouldRun) {
      if (autoConsolidationEnabled) {
        console.log(
          `[turn-guard] auto-consolidation skip sid=${sid} trigger=${trigger} reason=${decision.reason} msgsSince=${messagesSinceRun}`,
        )
      }
      return
    }

    // Claim the cross-process lock before stamping any state. If another instance
    // (or n8n/cron) is mid-run, skip without consuming the cooldown so a later
    // trigger can retry.
    if (!acquireAutoConsolidationLock(projectRoot, { sid, trigger: decision.reason }, autoConsolidationTimeoutMs)) {
      console.log(`[turn-guard] auto-consolidation skip sid=${sid} trigger=${trigger} reason=locked`)
      writeStatusFile(projectRoot, statusSnapshot({ type: "auto-consolidation-skip", sid, trigger, reason: "locked" }))
      return
    }

    autoConsolidationInFlight = true
    const previousLastRunAt = autoConsolidationLastRunAt.get(sid) ?? null
    autoConsolidationLastRunAt.set(sid, Date.now())
    autoConsolidationMessagesSinceRun.set(sid, 0)
    pruneAutoConsolidationTracking(autoConsolidationMessagesSinceRun, autoConsolidationLastRunAt, autoConsolidationMaxTrackedSessions)
    // If the run never actually starts, undo the cooldown stamp so the next
    // trigger can retry immediately instead of waiting out a phantom cooldown.
    runConsolidationCommand(sid, decision.reason, () => {
      if (previousLastRunAt === null) autoConsolidationLastRunAt.delete(sid)
      else autoConsolidationLastRunAt.set(sid, previousLastRunAt)
    }).catch((err) => {
      console.error("[turn-guard] auto-consolidation trigger failed:", err)
      autoConsolidationInFlight = false
      releaseAutoConsolidationLock(projectRoot)
    })
  }

  // Arm/replace the idle-delay timer. The timer represents \"stayed quiet for the
  // full delay\"; a new message clears it (see onMessageUpdated) so it is the
  // overridable delay rather than a fixed schedule.
  function armAutoConsolidationIdleTimer(sid: string): void {
    if (!autoConsolidationEnabled || !autoConsolidationOnIdle) return
    const existing = autoConsolidationPendingTimer.get(sid)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      autoConsolidationPendingTimer.delete(sid)
      evaluateAutoConsolidation(sid, "idle-timer")
    }, autoConsolidationIdleDelayMs)
    timer.unref?.()
    autoConsolidationPendingTimer.set(sid, timer)
    writeStatusFile(projectRoot, statusSnapshot({ type: "auto-consolidation-armed", sid, idleDelayMs: autoConsolidationIdleDelayMs }))
  }

  // A new message means the session is active again: cancel any pending
  // idle-triggered run and, for terminal assistant turns, advance the volume
  // counter and eagerly evaluate the volume trigger.
  function noteAutoConsolidationActivity(sid: string, info: any): void {
    if (!autoConsolidationEnabled) return
    const pending = autoConsolidationPendingTimer.get(sid)
    if (pending) {
      clearTimeout(pending)
      autoConsolidationPendingTimer.delete(sid)
    }
    if (info?.role === "assistant" && info?.finish) {
      autoConsolidationMessagesSinceRun.set(sid, (autoConsolidationMessagesSinceRun.get(sid) ?? 0) + 1)
      pruneAutoConsolidationTracking(autoConsolidationMessagesSinceRun, autoConsolidationLastRunAt, autoConsolidationMaxTrackedSessions)
      evaluateAutoConsolidation(sid, "volume")
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
    if (parentText.trimStart().startsWith(CHECKPOINT_MARKER)) {
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
      // Turn is genuinely complete — reset the retry chain counter for this session.
      retryChainBySession.delete(sid)
      // Phase 15 CREATE (success signal): a clean completion right after an
      // attempted nudge is deterministic evidence the intervention worked —
      // persist the pending patch(es); expire any that were not confirmed here.
      void confirmPendingInterventions({ sid, confirmedKey: messageID, model: routing.model ?? null, taskText: parentText })
      return false
    }

    const parentID = String(last?.info?.parentID ?? "")
    if (!parentID) return false

    // If the parent already is an auto-retry prompt, fold retries under the
    // grandparent ID so we can cap the whole retry chain.
    let retryKey = parentID
    if (parentText.trimStart().startsWith(AUTO_RETRY_MARKER)) {
      const grandParentID = String(prev?.info?.parentID ?? "")
      if (grandParentID) retryKey = grandParentID
    }

    // Chain counter: the authoritative bound against runaway retry chains.
    // Resets on consideredComplete or real user message (not injected prompts).
    const chainCount = retryChainBySession.get(sid) ?? 0
    if (chainCount >= MAX_RETRIES_PER_PARENT) {
      console.log(
        `[turn-guard] skip retry in ${sid}; retry chain cap ${MAX_RETRIES_PER_PARENT} reached`,
      )
      return false
    }

    const retriedParents = retriedParentBySession.get(sid) ?? new Map<string, number>()
    const retryCount = retriedParents.get(retryKey) ?? 0
    if (retryCount >= MAX_RETRIES_PER_PARENT) return false

    // Keying-independent per-session ceiling: bounds the entire retry chain even
    // when retryKey shifts every generation (see DEFAULT_MAX_RETRIES_PER_SESSION).
    const sessionRetries = retriesTotalBySession.get(sid) ?? 0
    if (sessionRetries >= maxRetriesPerSession) {
      console.log(
        `[turn-guard] skip retry in ${sid}; per-session retry cap ${maxRetriesPerSession} reached`,
      )
      return false
    }

    retriedParents.set(retryKey, retryCount + 1)
    retriedParentBySession.set(sid, retriedParents)
    retriesTotalBySession.set(sid, sessionRetries + 1)
    retryChainBySession.set(sid, chainCount + 1)

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

    // Phase 15 CREATE: attribute the stalled stop to (model, shape) at nudge time.
    // Task text = the real user prompt when prev is a user turn, else this turn's
    // own text. The intervention text is only QUEUED here — it becomes durable
    // knowledge only if confirmPendingInterventions later proves it worked (the
    // next stop being considered complete). Fire-and-forget — best-effort.
    const retryTaskText = prevIsUser ? parentText : getText(last.parts ?? [])
    void maybeRecordModelFailure({
      sid,
      model: activeModel ?? null,
      taskText: retryTaskText,
      event: "loop",
      interventionLabel: "retry-nudge",
      interventionText: String(body.parts[0].text),
    })
    queuePendingIntervention(sid, messageID, "retry-nudge", String(body.parts[0].text))

    return true
  }

  // Reactive deliberation-spiral guard. Sibling to issueRetry: retry owns stalls
  // (no useful output / mid-intent); this owns the opposite failure — a finish=stop
  // turn dense with announced-but-unexecuted investigation and zero action parts.
  // Fires independently of retryEnabled.
  const maybeSpiralNudge = async (
    sid: string,
    last: MessageWithParts,
    prev: MessageWithParts | null,
  ): Promise<boolean> => {
    if (!spiralGuardEnabled) return false
    if (!isAssistantStop(last)) return false

    const messageID = String(last?.info?.id ?? "")
    if (messageID) {
      const inspected = spiralInspectedBySession.get(sid) ?? new Set<string>()
      if (inspected.has(messageID)) return false
      inspected.add(messageID)
      spiralInspectedBySession.set(sid, inspected)
    }

    const currentMode = String(last?.info?.mode ?? "").trim().toLowerCase()
    const currentAgent = String(last?.info?.agent ?? "").trim().toLowerCase()
    if (currentMode && spiralGuardDisabledModes.has(currentMode)) return false
    if (currentAgent && spiralGuardDisabledAgents.has(currentAgent)) return false

    // Cloud models don't spiral the way local models do — skip them by default.
    const spiralRouting = getPromptRouting(last, prev)
    const spiralProvider = spiralRouting.model?.providerID?.toLowerCase() ?? ""
    const spiralModelID = spiralRouting.model?.modelID?.toLowerCase() ?? ""
    if (spiralProvider && spiralExemptProviders.has(spiralProvider)) return false
    if (
      spiralModelID &&
      Array.from(spiralExemptModelPrefixes).some((prefix) => spiralModelID.startsWith(prefix))
    ) {
      return false
    }

    // A reply to any guard prompt is terminal — never guard the guard's own reply.
    const parentText = getText(prev?.parts ?? [])
    if (
      parentText.trimStart().startsWith(SPIRAL_GUARD_MARKER) ||
      parentText.trimStart().startsWith(AUTO_RETRY_MARKER) ||
      parentText.trimStart().startsWith(CHECKPOINT_MARKER)
    ) {
      return false
    }

    // Explicit reflection/explanation asks are supposed to be long and tool-free.
    const prevIsUser = prev?.info?.role === "user"
    if (spiralExemptReflection && prevIsUser && isDeliberationExemptPrompt(parentText)) {
      return false
    }

    const text = getText(last.parts ?? [])
    const decision = detectDeliberationSpiral({
      text,
      hasActionPart: hasActionPart(last),
      investigateThreshold: spiralInvestigateThreshold,
      reversalThreshold: spiralReversalThreshold,
    })
    if (!decision.isSpiral) return false

    const used = spiralNudgedBySession.get(sid) ?? 0
    if (used >= spiralMaxInterventions) {
      console.log(
        `[turn-guard] spiral guard: budget ${spiralMaxInterventions} spent in ${sid}; letting it through`,
      )
      return false
    }
    spiralNudgedBySession.set(sid, used + 1)

    console.log(
      `[turn-guard] spiral detected sid=${sid} msg=${messageID || "?"} ` +
        `investigate=${decision.investigateCount} reversal=${decision.reversalCount} ` +
        `nudge=${used + 1}/${spiralMaxInterventions}`,
    )

    const routing = spiralRouting
    // Phase 15 CREATE: task text for shape attribution — the real user prompt
    // (prev) when it is a user turn, else this turn's own text. Deterministic and
    // cheap; the shape function tolerates any text.
    const spiralTaskText = prevIsUser ? parentText : text
    const body: any = {
      parts: [
        {
          type: "text",
          text:
            `${SPIRAL_GUARD_MARKER} Your last turn described ${decision.investigateCount} investigations ` +
            `("let me check...", "let me re-read...") but executed none — it reasoned about the code instead of reading it. ` +
            "Stop speculating and gather evidence:\n" +
            "- Take the single most load-bearing \"let me check X\" from that turn and actually call the tool now (read/grep the file, run the command).\n" +
            "- For runtime/ordering/async questions source cannot answer (\"does X fire before Y?\"), add a log or read the library source — do not infer execution order.\n" +
            "- One tool call, then reassess against its real result. Do not narrate another plan without a tool call between.",
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

    // Phase 15 CREATE: attribute the spiral to (model, shape) at nudge time. The
    // intervention text is only QUEUED — it becomes durable knowledge only if
    // confirmPendingInterventions later proves it worked (the next stop being
    // considered complete by issueRetry's predicates). Fire-and-forget — best-effort.
    void maybeRecordModelFailure({
      sid,
      model: routing.model ?? null,
      taskText: spiralTaskText,
      event: "spiral",
      interventionLabel: "spiral-nudge",
      interventionText: String(body.parts[0].text),
    })
    queuePendingIntervention(sid, messageID, "spiral-nudge", String(body.parts[0].text))

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

    // Utility subagents never checkpoint: they do no durable work of their own,
    // and a checkpoint prompt would only burn a turn on them.
    const routing = getPromptRouting(last)
    const currentAgent = String(routing.agent ?? "").trim().toLowerCase()
    if (currentAgent && checkpointDisabledAgents.has(currentAgent)) {
      console.log(`[turn-guard] checkpoint skipped for sid=${sid}: agent=${currentAgent} is in checkpoint.disabledAgents`)
      return false
    }

    checkpointedSessions.add(sid)
    console.log(`[turn-guard] prompting memory checkpoint for sid=${sid} (mode=${mode})`)

    try {
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
              `For each durable STATE change, write/update it via diary_write (derived memory ` +
              `writes like add_drawer/kg_add are dreamer-only; write-authority will reject them from ` +
              `this agent — diary_write is the correct tool here, and a dreamer consolidation pass ` +
              `formalizes it into the derived layer).\n` +
              `mem-core is a deterministic file-only render regenerated by the consolidation runtime from derived memory. ` +
              `Do NOT hand-edit mem-core files and do NOT write any context-blocks drawer for mem-core.\n\n` +
              `PART 2 — was substantive WORK done or something LEARNED? (diary / worked example)\n` +
              `This applies EVEN IF no block changed. Save a derived entry if any happened:\n` +
              `- a feature/fix was implemented (what was built, where, key choices),\n` +
              `- a bug's root cause was found (the cause, not just the fix),\n` +
              `- a non-obvious "how/why this works" was discovered,\n` +
              `- a problem was solved in a reusable way (file as a worked example in the ` +
              `apprenticeship room; if the reusable solution maps to a RECURRING TASK, also add one line ` +
              `\`SKILL_EXERCISED: <concept name>\` so a later consolidation pass can link the worked ` +
              `example to the skill it exercised — this is only a signal for the dreamer, never a write),\n` +
              `- a dead end worth not repeating was hit.\n` +
              `Use diary_write (the apprenticeship room included) for all of this. Synthesize — ` +
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

    // A real (non-injected) user message resets the retry chain counter.
    if (info?.role === "user") {
      retryChainBySession.delete(sid)
    }

    if (!startupConfirmedBySession.has(sid)) {
      startupConfirmedBySession.add(sid)
      console.log(`${START_BANNER}: message hook active`)
    }

    // Count terminal assistant messages only (finish set) for the checkpoint gate.
    if (info?.role === "assistant" && info?.finish) {
      terminalCountBySession.set(sid, (terminalCountBySession.get(sid) ?? 0) + 1)
    }

    // Auto-consolidation: a new message cancels any pending idle run and advances the
    // volume counter; harmless no-op when auto-consolidation is disabled.
    noteAutoConsolidationActivity(sid, info)

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

      const currentRouting = getPromptRouting(current)
      if (currentRouting.agent || currentRouting.model) {
        activeRoutingBySession.set(sid, currentRouting)
      }

      const memoryTools = classifyMemoryTools(getToolNames(current))
      if (memoryTools.reads.length > 0 || memoryTools.writes.length > 0) {
        if (memoryTools.reads.length > 0) memoryReadSessions.add(sid)
        appendMemoryUsageLog(projectRoot, {
          sid,
          messageID,
          agent: getAgentIdentity(current) || undefined,
          reads: memoryTools.reads,
          writes: memoryTools.writes,
        })
      }

      await maybeWarnWriteAuthority(sid, current)

      if (info?.finish !== "stop") return

      // When BOTH reactive guards are disabled, skip parent fetch and all
      // heuristic evaluation — zero extra overhead per message.
      if (!retryEnabled && !spiralGuardEnabled) {
        verifySourceCapture(sid, "message.stop").catch(() => {})
        return
      }

      const parentID = String(current?.info?.parentID ?? "")
      if (!parentID) return

      const parentRes: any = await client.session.message({
        path: { id: sid, messageID: parentID },
        query: { directory },
      })
      const parent = unwrapMessageResult(parentRes)
      verifySourceCapture(sid, "message.stop").catch(() => {})

      // message.updated owns the reactive end-of-turn guards; checkpoint is
      // idle-only. At most one injection per stop: retry owns stalls, the spiral
      // guard owns no-action deliberation (opposite failure modes).
      const retried = await issueRetry(sid, current, parent)
      if (!retried) await maybeSpiralNudge(sid, current, parent)
    } catch (err) {
      console.error("[turn-guard] message.updated failed:", err)
    }
    // P3-1: bound all session-keyed state to prevent memory leaks in long-lived processes
    pruneToMax(retriedParentBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(retriesTotalBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(retryChainBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(inspectedStopBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(toolWindowBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskWindowBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
    pruneToMax(capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(failureRecordedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(checkpointedSessions, autoConsolidationMaxTrackedSessions)
    pruneToMax(terminalCountBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(activeRoutingBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(compactionPathBySession, autoConsolidationMaxTrackedSessions)
  }

  // Phase 13 CREATE: scan a message for successful task tool completions and file
  // worked examples. The task tool part carries the subagent_type in its input args
  // and the output (the subagent's final text) in its state/output field. We only
  // file when the part indicates success (no error status) and the output is
  // substantive. This runs on session.idle — by then the task has completed and
  // the message parts are finalized.
  async function maybeFileWorkedExamplesFromMessage(sid: string, msg: MessageWithParts): Promise<void> {
    const parts = msg?.parts ?? []
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const toolName = String(part?.tool ?? part?.name ?? "").trim().toLowerCase()
      if (toolName !== "task") continue

      // Extract subagent_type and prompt from the task call's input args.
      const inputArgs: any = part?.state?.input ?? part?.args ?? {}
      const subagentType = String(inputArgs?.subagent_type ?? "").trim().toLowerCase()

      // Extract the output (the subagent's final response text).
      const state = part?.state ?? {}
      const status = String(state?.status ?? "").trim().toLowerCase()

      const description = String(inputArgs?.description ?? "").trim()
      const prompt = String(inputArgs?.prompt ?? "").trim()

      // Phase 13 CREATE: file worked examples for cloud target subagent types with
      // substantive successful output. Success-only: skip if the task errored or was aborted.
      if (workedExampleFilingEnabled && WORKED_EXAMPLE_FILE_AGENT_TYPES.has(subagentType)) {
        if (status === "error" || status === "aborted" || status === "failed") continue

        const outputText = String(
          state?.output ?? part?.output ?? state?.text ?? "",
        ).trim()
        if (outputText.length < WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS) continue

        await maybeFileWorkedExample({ sid, subagentType, description, prompt, output: outputText })
      }

      // Phase 14 CREATE: record a capability tuple for routing-tier subagents.
      // Runs regardless of the worked-example filing gate — capability recording
      // is its own concern (it covers local/cloud/deep tiers, not just cloud).
      await maybeRecordCapabilityTuple({ sid, subagentType, description, prompt, status })

      // Phase 16 CREATE: capture the self-reported confidence label from the
      // subagent's terminal output. Runs for ANY task tool part with substantive
      // output (not gated on routing tier — calibration covers all delegated units).
      // The tuple is PENDING; it becomes durable only via record_outcome.
      const outputText = String(state?.output ?? part?.output ?? state?.text ?? "").trim()
      if (outputText.length >= WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS) {
        const activeModel = getActiveModel(msg)
        await maybeCaptureCalibrationTuple({ sid, model: activeModel, description, prompt, outputText })
      }
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

      // Phase 13 CREATE: file worked examples for successful implementation subagents.
      // Scans the last message for task tool parts with completed status and a target
      // subagent_type, then files a compact example if the output is substantive.
      await maybeFileWorkedExamplesFromMessage(sid, last)

      // Arm the overridable idle-delay timer: consolidation fires only if the
      // session stays quiet for the full delay (a new message cancels it).
      armAutoConsolidationIdleTimer(sid)
    } catch (err) {
      console.error("[turn-guard] failed:", err)
    }
    // P3-1: bound all session-keyed state (same as onMessageUpdated)
    pruneToMax(retriedParentBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(retriesTotalBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(retryChainBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(inspectedStopBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(toolWindowBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskWindowBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
    pruneToMax(capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(failureRecordedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(checkpointedSessions, autoConsolidationMaxTrackedSessions)
    pruneToMax(terminalCountBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(activeRoutingBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(compactionPathBySession, autoConsolidationMaxTrackedSessions)
  }

  // Post-compaction transcript archiver. Compaction RETAINS prior messages in the
  // session log (verified 2026-08-19: session.messages returns the full history,
  // with summary:true + agent:"compaction" assistant markers delimiting each folded
  // region). So the "just dropped" content is still readable right after compaction —
  // this slices the log at the latest compaction marker and writes that region to a
  // durable file before it scrolls out of practical reach. Structure: one markdown
  // file per compaction, roles + text/tool/patch parts, no message content omitted.
  // Entirely wrapped in try/catch — an archive failure must never break compaction.
  async function archiveCompactedRegion(sid: string): Promise<void> {
    if (!compactArchiveEnabled) return
    try {
      const res: any = await client.session.messages({
        path: { id: sid },
        query: { directory },
      })
      const messages = sortByCreated(unwrapListResult(res))
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
      const dir = join(projectRoot, STATUS_DIR, "compaction-archive")
      mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, "-")
      const path = join(dir, `${sid}-${ts}.md`)
      writeFileSync(path, lines.join("\n"), "utf8")
      console.log(`[turn-guard] compact archive: wrote ${region.length} messages sid=${sid} -> ${path}`)
      writeStatusFile(projectRoot, statusSnapshot({ type: "compact-archive", sid, messages: region.length, path }))
    } catch (err) {
      // Never let archiving break the compaction path.
      console.log(`[turn-guard] compact archive: error (ignored) sid=${sid}: ${err}`)
    }
  }

  async function onSessionCompacted(event: any): Promise<void> {
    const sid = String(event?.properties?.sessionID ?? findSessionID(event))
    if (!sid) return

    verifySourceCapture(sid, "session.compacted").catch(() => {})

    // Archive the just-compacted region BEFORE it scrolls out of practical reach.
    // Independent of the mem-core fallback below; gated by ESHEPHERD_COMPACT_ARCHIVE.
    await archiveCompactedRegion(sid)

    // Mem-core reinjection is intentionally post-compaction-only. The compaction
    // hook owns prompt shaping; this event owns continuation-memory refresh.
    compactionPathBySession.set(sid, { path: "post-compact-fallback", at: new Date().toISOString() })
    // NOTE: do NOT force here. maybeInjectMemcore injects via client.session.prompt(),
    // which creates a real generating turn (~memcoreMaxChars). Forcing made every
    // post-compaction event re-inject the same large block, re-inflating context and
    // triggering another compaction → an infinite compact/reinject loop. Relying on
    // the signature+cooldown dedup means this fires at most once per unique mem-core
    // content, so identical mem-core after a compaction is a no-op.
    await maybeInjectMemcore({
      sid,
      event,
      reason: "compacted",
    })

    // Compaction is a natural consolidation point; run auto-consolidation if enabled.
    if (autoConsolidationOnCompact) {
      evaluateAutoConsolidation(sid, "compacted")
    }
    // P3-1: bound all session-keyed state (same as onMessageUpdated)
    pruneToMax(retriedParentBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(retriesTotalBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(retryChainBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(startupConfirmedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(inspectedStopBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(toolWindowBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(loopInterventionsBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskWindowBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskEscalationsBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(taskRecentLaunchBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(workedExampleFiledByShape, autoConsolidationMaxTrackedSessions)
    pruneToMax(capabilityRecordedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(failureRecordedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(pendingCalibrationBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(pendingInterventionBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(spiralNudgedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(spiralInspectedBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(checkpointedSessions, autoConsolidationMaxTrackedSessions)
    pruneToMax(terminalCountBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(memcoreInjectionBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(sourceCaptureBySession, autoConsolidationMaxTrackedSessions)
    pruneToMax(compactionPathBySession, autoConsolidationMaxTrackedSessions)
  }

  async function onSessionStarted(event: any): Promise<void> {
    const sid = String(event?.properties?.sessionID ?? findSessionID(event))
    if (!sid) return

    toolWindowBySession.delete(sid)
    loopInterventionsBySession.delete(sid)
    activeRoutingBySession.delete(sid)

    await maybeInjectMemcore({
      sid,
      event,
      reason: "started",
      force: true,
    })
  }


  const hookHeadHandlers = createHookHeadHandlers({
    cfgBool,
    loadPackagedAssets,
    mergeWithoutOverride,
    loadInstructionPaths,
    dedupeAppendInstructions,
    onMessageUpdated,
    onSessionIdle,
    onSessionCompacted,
    onSessionStarted,
  })

  return {
    config: hookHeadHandlers.config,
    event: hookHeadHandlers.event,
    "tool.execute.before": async (input: any, output: any) => {
      if (!loopGuardEnabled) return
      const toolName = String(input?.tool ?? "").trim()
      if (!toolName) return
      const sid = String(input?.sessionID ?? input?.sessionId ?? "")
      if (!sid) return

      const key = toolName.toLowerCase()
      if (loopExemptTools.has(key)) return

      const args = output?.args ?? input?.args ?? {}

      if (taskWatchdogEnabled && key === "task") {
        const subagentType = String(args?.subagent_type ?? "").trim().toLowerCase()
        const description = String(args?.description ?? "").trim()
        const prompt = String(args?.prompt ?? "").trim()
        const now = Date.now()

        if (subagentType && taskSerializeTypes.has(subagentType)) {
          const launches = taskRecentLaunchBySession.get(sid) ?? new Map<string, number>()
          const lastLaunchAt = Number(launches.get(subagentType) ?? 0)
          const elapsed = now - lastLaunchAt
          if (lastLaunchAt > 0 && elapsed < taskSerializeCooldownMs) {
            const waitSec = Math.max(1, Math.ceil((taskSerializeCooldownMs - elapsed) / 1000))
            const nudgeText =
              `${LOOP_GUARD_MARKER} STOP. You are spawning \`${subagentType}\` tasks too quickly in parallel.\n\n` +
              `This \`task\` call was BLOCKED. Wait about ${waitSec}s, then launch the next \`${subagentType}\` task serially.\n\n` +
              `Do not retry immediately; queue it and continue with non-overlapping work.`
            throw new Error(nudgeText)
          }
          launches.set(subagentType, now)
          taskRecentLaunchBySession.set(sid, launches)
        }

        const taskSignature = computeToolSignature("task", {
          subagent_type: subagentType,
          description,
          prompt,
        })
        const taskWindow = taskWindowBySession.get(sid) ?? []
        const taskEscalationsUsed = taskEscalationsBySession.get(sid) ?? 0
        const taskDecision = decideLoopIntervention({
          window: taskWindow,
          signature: taskSignature,
          repeatThreshold: taskWatchdogThreshold,
          interventionsUsed: taskEscalationsUsed,
          maxInterventions: taskWatchdogMaxEscalations,
        })

        if (taskDecision.exhausted) {
          console.log(
            `[turn-guard] task watchdog: repeated ${subagentType || "task"} ${taskDecision.count}x in sid=${sid} ` +
              `but escalation budget (${taskWatchdogMaxEscalations}) is spent; letting it through`,
          )
        } else if (taskDecision.shouldIntervene) {
          const routing = await resolveLoopGuardRouting(sid, input, output)
          const swapTarget = resolveTaskSwapTarget({
            current: routing.model,
            qwenMatch: taskSwapQwenMatch,
            qwenToProvider: taskSwapQwenToProvider,
            qwenToModel: taskSwapQwenToModel,
            gemmaMatch: taskSwapGemmaMatch,
            gemmaToProvider: taskSwapGemmaToProvider,
            gemmaToModel: taskSwapGemmaToModel,
            fallbackProvider: taskFallbackProvider,
            fallbackModel: taskFallbackModel,
          })

          if (swapTarget) {
            args.model = {
              providerID: swapTarget.providerID,
              modelID: swapTarget.modelID,
            }
            if (output?.args) output.args = args
            if (input?.args) input.args = args
            taskEscalationsBySession.set(sid, taskEscalationsUsed + 1)
            taskWindowBySession.delete(sid)

            console.log(
              `[turn-guard] task watchdog: escalating repeated ${subagentType || "task"} call ` +
                `(repeat ${taskDecision.count}x, escalation ${taskEscalationsUsed + 1}/${taskWatchdogMaxEscalations}) ` +
                `sid=${sid} -> ${swapTarget.providerID}/${swapTarget.modelID} (${swapTarget.reason})`,
            )
          }
        }

        // Phase 13 (worked-example injection): for @implement-local delegations,
        // append up to WORKED_EXAMPLE_MAX_INJECT relevant apprenticeship worked
        // examples as demonstrations. Runs AFTER the watchdog signature is computed
        // from the ORIGINAL prompt (the loop guard must see the pre-injection call),
        // and mutates args.prompt in place so both output.args and input.args carry
        // the augmented prompt. Any failure degrades to no injection — a retrieval
        // hiccup must never block or alter a delegation.
        const demonstrationHeading =
          "## Demonstrations: how this class of problem was solved in this codebase before"
        const injectDecision = shouldInjectWorkedExamples({
          enabled: workedExampleInjectionEnabled,
          subagentType,
          prompt,
          heading: demonstrationHeading,
        })
        const hasPrompt = injectDecision.hasPrompt
        if (!injectDecision.shouldInject) {
          console.log(
            `[turn-guard] worked-example injection: skipped sid=${sid} ` +
              `(enabled=${workedExampleInjectionEnabled}, subagentType=${subagentType || ""}, ` +
              `hasPrompt=${hasPrompt}, promptAlreadyAugmented=${injectDecision.promptAlreadyAugmented})`,
          )
        }

        if (injectDecision.shouldInject) {
          try {
            const palaceClient = await getWorkedExampleClient()
            if (palaceClient) {
              const examples = await retrieveSimilarWorkedExamples(palaceClient, {
                query: prompt,
                limit: WORKED_EXAMPLE_MAX_INJECT,
                relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
              })
              const demonstration = formatWorkedExampleDemonstration(examples)
              if (demonstration) {
                args.prompt = `${prompt}${demonstration}`
                if (output?.args) output.args = args
                if (input?.args) input.args = args
                console.log(
                  `[turn-guard] worked-example injection: appended ${examples.length} example(s) ` +
                    `(top relevance ${examples[0].relevance.toFixed(2)}) to implement-local prompt sid=${sid}`,
                )
              } else {
                console.log(
                  `[turn-guard] worked-example injection: no examples above floor (${WORKED_EXAMPLE_RELEVANCE_FLOOR}) — prompt unchanged sid=${sid}`,
                )
              }
            }
          } catch (err) {
            console.log(`[turn-guard] worked-example injection: failed, prompt unchanged: ${String(err)}`)
          }
        }

        // Phase 15 CONSUME (prompt patches): inject known successful intervention
        // patches for the EXACT (model, shapeKey) pair. The model is resolved from
        // delegation context (hook args or session cache); the shape reuses Phase
        // 14's extractWorkedExampleShape on the ORIGINAL prompt (same text as the
        // CREATE side). Absent data => no injection, no prompt bloat. Any failure
        // degrades to no injection — a read hiccup must never block a delegation.
        if (failurePatchInjectionEnabled && hasPrompt) {
          try {
            const routing = await resolveLoopGuardRouting(sid, input, output)
            const modelId = canonicalModelId(routing.model?.providerID, routing.model?.modelID)
            if (modelId) {
              const shape = extractWorkedExampleShape(prompt)
              const palaceClient = await getWorkedExampleClient()
              if (palaceClient && typeof palaceClient.kgQuery === "function") {
                // Bounded read: one kg_query per candidate label (max 3).
                const patchTexts: string[] = []
                for (const label of ["spiral-nudge", "retry-nudge", "loop-block"]) {
                  const result: any = await palaceClient.kgQuery({
                    entity: buildFailurePatchId(modelId, shape.shapeKey, label),
                    direction: "outgoing",
                    predicate: "es-intervention-text",
                    recurse: false,
                    max_depth: 1,
                  })
                  if (!result?.ok) {
                    // non-fatal: skip this label
                    console.log(
                      `[turn-guard] failure-patch injection: kg_query failed for ${label} (${result?.kind ?? "unknown"}): ${String(result?.detail ?? result)} sid=${sid}`
                    )
                    continue
                  }
                  const facts = Array.isArray(result.value?.facts) ? result.value.facts : []
                  for (const fact of facts) {
                    if (fact && fact.current === false) continue
                    const t = String(fact?.object ?? "").trim()
                    if (t && !patchTexts.includes(t)) patchTexts.push(t)
                  }
                }
                if (patchTexts.length > 0) {
                  const patchHeading = "## Known failure modes for this model on this class of task"
                  const patchBlock =
                    `\n\n---\n${patchHeading}\n\n` +
                    "This model has previously failed on this class of task in the ways below. " +
                    "Apply these interventions proactively:\n" +
                    patchTexts.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n---\n"
                  args.prompt = `${args.prompt}${patchBlock}`
                  if (output?.args) output.args = args
                  if (input?.args) input.args = args
                  console.log(
                    `[turn-guard] failure-patch injection: appended ${patchTexts.length} patch(es) ` +
                      `for ${modelId} (shape=${shape.shapeKey}) to ${subagentType || "task"} prompt sid=${sid}`,
                  )
                } else {
                  console.log(
                    `[turn-guard] failure-patch injection: no patches for ${modelId} shape=${shape.shapeKey} — prompt unchanged sid=${sid}`,
                  )
                }
              }
            }
          } catch (err) {
            console.log(`[turn-guard] failure-patch injection: failed, prompt unchanged: ${String(err)}`)
          }
        }

        // Phase 14/15 CONSUME (live routing): consult capability + failure evidence
        // BEFORE the tier is chosen, and re-route the delegation to a different tier
        // when the evidence recommends it. ALWAYS ACTIVE — no feature flag. Neutral
        // fallback: if the palace is unavailable, the read throws, or the sample is
        // insufficient (fallback / no-data), decideCapabilityReroute returns null and
        // the existing routing outcome is preserved EXACTLY. Only a sufficient,
        // concrete recommendation for a DIFFERENT tier changes args.subagent_type.
        // Runs AFTER the watchdog signature was computed from the ORIGINAL args (the
        // loop guard must see the pre-reroute call) and mutates args in place so both
        // output.args and input.args carry the re-routed delegation. Any failure
        // degrades to no reroute — a read hiccup must never block or alter a unit.
        const requestedTier = CAPABILITY_TIER_BY_SUBAGENT[subagentType]
        if (requestedTier && hasPrompt) {
          try {
            const routing = await resolveLoopGuardRouting(sid, input, output)
            // The model pinned to the REQUESTED tier is what we penalize; sibling
            // tiers have no known pin in this codebase, so they stay null (unknown
            // => no penalty, per getFailureAdjustedRouting's documented semantics).
            const pinnedModel = normalizeModelSpec(args.model)
            const effectiveModel =
              (pinnedModel ? canonicalModelId(pinnedModel.providerID, pinnedModel.modelID) : null) ??
              canonicalModelId(routing.model?.providerID, routing.model?.modelID)
            const shape = extractWorkedExampleShape(prompt)
            const routingClient = await getRoutingEvidenceClient()
            if (routingClient && typeof routingClient.getFailureAdjustedRouting === "function") {
              const modelByTier: Record<string, string | null> = { local: null, cloud: null, deep: null }
              modelByTier[requestedTier] = effectiveModel
              const adjusted = await routingClient.getFailureAdjustedRouting(shape.shapeKey, modelByTier)
              const decision = decideCapabilityReroute({
                requestedTier,
                recommendation: String(adjusted?.recommendation ?? ""),
                fallback: Boolean(adjusted?.fallback),
              })
              if (decision.rerouteTo) {
                const targetSubagent = CAPABILITY_SUBAGENT_BY_TIER[decision.rerouteTo as keyof typeof CAPABILITY_SUBAGENT_BY_TIER]
                if (targetSubagent && targetSubagent !== subagentType) {
                  args.subagent_type = targetSubagent
                  if (output?.args) output.args = args
                  if (input?.args) input.args = args
                  console.log(
                    `[turn-guard] capability routing: re-routing ${subagentType} (${requestedTier}) -> ` +
                      `${targetSubagent} (${decision.rerouteTo}) on evidence sid=${sid} shape=${shape.shapeKey}`,
                  )
                } else {
                  console.log(
                    `[turn-guard] capability routing: recommended ${decision.rerouteTo} has no distinct subagent — kept ${subagentType} sid=${sid}`,
                  )
                }
              } else {
                console.log(
                  `[turn-guard] capability routing: no reroute (${decision.reason}) for ${subagentType} ` +
                    `(${requestedTier}) sid=${sid} shape=${shape.shapeKey}`,
                )
              }
            }
          } catch (err) {
            // Neutral: a read/init failure must never alter the delegation.
            console.log(`[turn-guard] capability routing: failed, kept ${subagentType}: ${String(err)}`)
          }
        }

        // Phase 16 CONSUME (calibrated escalation): consult the calibration cell
        // for this (model, shape, confidence) BEFORE a subagent's self-reported
        // confidence is trusted at face value. ACTIVE BY DEFAULT — no feature
        // flag. The trust override requires >= CALIBRATION_OVERRIDE_MIN_SAMPLES
        // (5) recorded samples in the cell; below that, or on any read failure /
        // unavailable data, decideCalibratedEscalation returns defaultAction
        // "trust" and NOTHING changes — the existing baseline path is preserved
        // EXACTLY. A sufficient cell with a low measured hit rate flips the
        // decision to escalate: the delegation prompt gets a calibration note
        // telling the subagent its self-reported confidence at this level on this
        // shape is measured unreliable, so verify before acting. Runs AFTER the
        // watchdog signature was computed from the ORIGINAL args (the loop guard
        // must see the pre-injection call) and mutates args.prompt in place so
        // both output.args and input.args carry the augmented prompt. Any failure
        // degrades to no injection — a read hiccup must never block or alter a unit.
        const calibrationNoteHeading = "## Calibration note: your self-reported confidence is measured unreliable for this class of task"
        if (hasPrompt && !prompt.includes(calibrationNoteHeading)) {
          try {
            const routing = await resolveLoopGuardRouting(sid, input, output)
            const pinnedModel = normalizeModelSpec(args.model)
            const effectiveModel =
              (pinnedModel ? canonicalModelId(pinnedModel.providerID, pinnedModel.modelID) : null) ??
              canonicalModelId(routing.model?.providerID, routing.model?.modelID)
            if (effectiveModel) {
              const shape = extractWorkedExampleShape(prompt)
              // The confidence the subagent is expected to self-report: the
              // delegation prompt's own terminal CONFIDENCE line when present,
              // otherwise "high" — the level whose trust we are gating. A
              // misreported label only changes which cell is read; the decision
              // stays neutral below the 5-sample floor either way.
              const reportedConfidence = parseSelfReportedConfidence(prompt) ?? "high"
              const routingClient = await getRoutingEvidenceClient()
              if (routingClient && typeof routingClient.decideCalibratedEscalation === "function") {
                const decision = await routingClient.decideCalibratedEscalation({
                  modelId: effectiveModel,
                  shapeKey: shape.shapeKey,
                  reportedConfidence,
                  defaultAction: "trust",
                  minHitRate: CALIBRATION_MIN_HIT_RATE,
                  minSample: CALIBRATION_OVERRIDE_MIN_SAMPLES,
                })
                if (decision.action === "escalate") {
                  const noteBlock = buildCalibrationEscalationNote({
                    heading: calibrationNoteHeading,
                    modelId: effectiveModel,
                    reportedConfidence,
                    hitRate: decision.hitRate ?? 0,
                    total: decision.total,
                  })
                  args.prompt = `${args.prompt}${noteBlock}`
                  if (output?.args) output.args = args
                  if (input?.args) input.args = args
                  console.log(
                    `[turn-guard] calibrated escalation: ESCALATE for ${effectiveModel} ` +
                      `(shape=${shape.shapeKey}, reported=${reportedConfidence}, hitRate=${decision.hitRate}) sid=${sid}`,
                  )
                } else {
                  console.log(
                    `[turn-guard] calibrated escalation: trust (${decision.reason}) for ${effectiveModel} ` +
                      `(shape=${shape.shapeKey}, reported=${reportedConfidence}) sid=${sid}`,
                  )
                }
              }
            }
          } catch (err) {
            // Neutral: a read/init failure must never alter the delegation.
            console.log(`[turn-guard] calibrated escalation: failed, prompt unchanged: ${String(err)}`)
          }
        }

        // Phase 15 CONSUME (intervention replay): consult getFailureInterventions
        // for this (model, shape) — the intervention texts that previously BROKE a
        // loop on this exact model + task class — and inject them into the outgoing
        // delegation prompt: "last time this shape failed, here is what fixed it."
        // ALWAYS ACTIVE — no feature flag. Neutral fallback: no interventions
        // recorded, empty result, MCP unavailable, or a throwing read => the prompt
        // is left EXACTLY as-is (no mutation). Idempotent: the block heading is
        // checked against args.prompt (which may already carry earlier injections)
        // before appending, so a re-fired hook never doubles the block. Bounded by
        // INTERVENTION_REPLAY_MAX_PATCHES via getFailureInterventions' maxPatches
        // argument (the closed label vocabulary caps the read at 3 one-hop reads).
        // Runs AFTER the watchdog signature was computed from the ORIGINAL args and
        // mutates args.prompt in place so both output.args and input.args carry the
        // augmented prompt. Any failure degrades to no injection — a read hiccup
        // must never block or alter a unit.
        if (hasPrompt && !String(args?.prompt ?? "").includes(INTERVENTION_REPLAY_HEADING)) {
          try {
            const routing = await resolveLoopGuardRouting(sid, input, output)
            const pinnedModel = normalizeModelSpec(args.model)
            const effectiveModel =
              (pinnedModel ? canonicalModelId(pinnedModel.providerID, pinnedModel.modelID) : null) ??
              canonicalModelId(routing.model?.providerID, routing.model?.modelID)
            if (effectiveModel) {
              const shape = extractWorkedExampleShape(prompt)
              const routingClient = await getRoutingEvidenceClient()
              if (routingClient && typeof routingClient.getFailureInterventions === "function") {
                const interventions = await routingClient.getFailureInterventions(
                  effectiveModel,
                  shape.shapeKey,
                  { maxPatches: INTERVENTION_REPLAY_MAX_PATCHES },
                )
                const block = formatInterventionBlock(interventions)
                if (block) {
                  args.prompt = `${args.prompt}${block}`
                  if (output?.args) output.args = args
                  if (input?.args) input.args = args
                  console.log(
                    `[turn-guard] intervention replay: appended ${interventions.length} intervention(s) ` +
                      `for ${effectiveModel} (shape=${shape.shapeKey}) to ${subagentType || "task"} prompt sid=${sid}`,
                  )
                } else {
                  console.log(
                    `[turn-guard] intervention replay: no interventions for ${effectiveModel} ` +
                      `shape=${shape.shapeKey} — prompt unchanged sid=${sid}`,
                  )
                }
              }
            }
          } catch (err) {
            // Neutral: a read/init failure must never alter the delegation.
            console.log(`[turn-guard] intervention replay: failed, prompt unchanged: ${String(err)}`)
          }
        }

        taskWindow.push(taskSignature)
        while (taskWindow.length > loopWindowSize) taskWindow.shift()
        taskWindowBySession.set(sid, taskWindow)
      }

      const signature = computeToolSignature(toolName, args)
      const window = toolWindowBySession.get(sid) ?? []
      const interventionsUsed = loopInterventionsBySession.get(sid) ?? 0

      const { count, shouldIntervene, exhausted } = decideLoopIntervention({
        window,
        signature,
        repeatThreshold: loopRepeatThreshold,
        interventionsUsed,
        maxInterventions: loopMaxInterventions,
      })

      if (exhausted) {
        console.log(
          `[turn-guard] loop guard: ${toolName} repeated ${count}x in sid=${sid} but the ` +
            `${loopMaxInterventions}-nudge budget is spent; letting it through`,
        )
        return
      }

      if (!shouldIntervene) {
        // A MUTATING tool called with NEW arguments is real progress: drop the
        // history that preceded it. Keep this call's own signature though --
        // seeding with [signature] instead of clearing outright is what lets an
        // immediately-repeated identical command still accumulate.
        //
        // This used to be an early return at the top of the handler, before the
        // repeat check ran at all. Because `bash` is in the mutation list, that
        // made repeated identical shell commands structurally INVISIBLE to the
        // guard -- and worse, every bash call wiped the window and erased the
        // history of every other tool too. bash mutates sometimes, but it is
        // also the most common READ tool (grep / ls / git status / test runs),
        // so "saw bash, therefore progress" was never a safe assumption.
        if (loopMutationTools.has(key) && count === 1) {
          toolWindowBySession.set(sid, [signature])
        } else {
          window.push(signature)
          while (window.length > loopWindowSize) window.shift()
          toolWindowBySession.set(sid, window)
        }
        // Phase 15 CREATE (success signal): the model's next tool call after a
        // blocked loop is a DIFFERENT signature than the one that was blocked —
        // deterministic evidence the nudge broke the loop. Persist the pending
        // loop-block patch; expire any other pending patches for this session.
        // Best-effort, never blocks or throws into the turn.
        void confirmPendingInterventions({
          sid,
          confirmedKey: signature,
          model: activeRoutingBySession.get(sid)?.model ?? null,
          taskText: `${toolName} ${JSON.stringify(args)}`,
        })
        return
      }

      // Nudge, then wipe the window so the model gets a clean slate to recover in
      // rather than tripping the guard again on its very next call.
      loopInterventionsBySession.set(sid, interventionsUsed + 1)
      toolWindowBySession.delete(sid)
      const nudge = interventionsUsed + 1
      console.log(
        `[turn-guard] loop guard: aborting ${toolName} (repeat ${count}x, nudge ${nudge}/${loopMaxInterventions}) sid=${sid}`,
      )

      // WORDING IS LOAD-BEARING (measured 2026-08-18). A softer version of this
      // message asked "are you looping?" and said "regroup before continuing" --
      // in practice the model answered the question, took "continuing" as
      // permission to proceed, and looped again. Manual interventions phrased as
      // "you're looping, stop and move forward" broke the loop; ones phrased as
      // "continue, you're looping, finish then move forward" did NOT. So: state
      // it, never ask it; forbid the specific call; say move forward, never
      // continue/finish/regroup; and do not invite narration, which just burns a
      // turn explaining the loop instead of leaving it.
      // 1) Block the tool call - the model gets a tool-error part and cannot
      //    keep hammering the identical call. This alone is invisible in some
      //    OpenCode surfaces: the error shows as a bare tool error, not a
      //    conversational turn, so the model never "hears" the nudge.
      const finalNudge = nudge >= loopMaxInterventions
      const nudgeText =
        `${LOOP_GUARD_MARKER} STOP. You have called \`${toolName}\` ${count} times with identical ` +
        `arguments. You are looping.\n\n` +
        `This call was BLOCKED and did not run. Calling \`${toolName}\` with these arguments again will ` +
        `not produce a different result - the answer you already have is the answer.\n\n` +
        `Move forward now:\n` +
        `- Act on what you already have. The earlier identical call's result is in your context; use it.\n` +
        `- If you genuinely need something else, take a DIFFERENT action: different tool, different ` +
        `arguments, or a different approach to the problem.\n` +
        `- If you cannot proceed without information you are unable to obtain, say so plainly and stop. ` +
        `Do not retry.\n\n` +
        `Your next action must be different from the one just blocked. Do not explain the loop, do not ` +
        `apologise, and do not restate your plan - just take the next real step.` +
        (finalNudge
          ? `\n\nThis is the LAST time this will be blocked (${nudge}/${loopMaxInterventions}). If you ` +
            `repeat it after this, abandon this line of work entirely and report what you have with your ` +
            `remaining uncertainty stated.`
          : `\n\n(nudge ${nudge}/${loopMaxInterventions} this session)`)

      const routing = await resolveLoopGuardRouting(sid, input, output)

      // 2) Deliver the same nudge as a real user message so it lands in the
      //    conversation context the model reads - this is what breaks the loop
      //    when the tool-error part alone doesn't register. noReply keeps it
      //    from spawning a second generation turn; the blocked call's own error
      //    path already triggers the retry/continue.
      try {
        const body: any = {
          noReply: true,
          parts: [{ type: "text", text: nudgeText }],
        }
        if (routing.agent) body.agent = routing.agent
        if (routing.model) body.model = routing.model

        await client.session.prompt({
          path: { id: sid },
          query: { directory },
          body,
        })
      } catch (promptErr) {
        // Best-effort: if the prompt injection fails, the thrown error below
        // still blocks the tool call. Log so the gap is diagnosable.
        console.error(`[turn-guard] loop guard: nudge prompt failed sid=${sid}:`, promptErr)
      }

      // Phase 15 CREATE: attribute the repeated-tool loop to (model, shape) at
      // nudge time. Task text = tool name + args (the shape function tolerates any
      // text; for non-task tools this is a coarse but deterministic shape). The
      // intervention text is only QUEUED — it becomes durable knowledge only if
      // the model's NEXT tool call has a different signature (see the
      // confirmPendingInterventions call below), which is deterministic proof the
      // loop was broken. Fire-and-forget — best-effort, never blocks.
      void maybeRecordModelFailure({
        sid,
        model: routing.model ?? null,
        taskText: `${toolName} ${JSON.stringify(args)}`,
        event: "loop",
        interventionLabel: "loop-block",
        interventionText: nudgeText,
      })
      queuePendingIntervention(sid, signature, "loop-block", nudgeText)

      throw new Error(nudgeText)
    },
    tool: createToolRegistry(),
  } as any
}

export default TurnGuard
