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
  computeToolSignature,
  decideAutoConsolidation,
  decideCapabilityReroute,
  decideLoopIntervention,
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
import { toLowerSet } from "./session-policy/constants.ts"
import {
  findProjectRoot,
  writeStatusFile, appendAutoConsolidationLog, appendMemoryUsageLog,
  acquireAutoConsolidationLock, releaseAutoConsolidationLock, killProcessTree,
  getToolNames, containsConsolidationWriteTool, classifyMemoryTools, pruneToMax,
} from "./session-policy/pure-helpers.ts"
import { findSessionID, getAgentIdentity, getActiveModel, getActiveAgent, getPromptRouting, normalizeModelSpec, resolveSessionPromptRoutingWithGating, resolveLoopGuardRoutingWithGating, maybeWarnWriteAuthorityWithGating, resolveTaskSwapTarget, getPromptRoutingFromToolHook } from "./session-policy/routing.ts"
import { maybeInjectMemcoreWithGating, persistWorkedInterventionWithGating, maybeRecordModelFailureWithGating, queuePendingInterventionWithGating, confirmPendingInterventionsWithGating } from "./session-policy/interventions.ts"
import { maybeFileWorkedExampleWithGating, maybeFileWorkedExamplesFromMessageWithGating } from "./session-policy/worked-example.ts"
import { maybeRecordCapabilityTupleWithGating, maybeCaptureCalibrationTupleWithGating } from "./session-policy/capability.ts"
import { runSourceCaptureCommand, verifySourceCaptureWithGating, runConsolidationCommandWithGating, evaluateAutoConsolidationWithGating, armAutoConsolidationIdleTimerWithGating, noteAutoConsolidationActivityWithGating } from "./session-policy/source-capture.ts"
import { bindSessionPolicyHandlers, issueRetryWithGating, maybeSpiralNudgeWithGating, maybeCheckpointWithGating } from "./session-policy/handlers.ts"
import { bindToolExecuteBefore } from "./session-policy/tool-hook.ts"

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

function normalizePathForHost(path: string): string {
  if (!path) return ""
  const trimmed = path.trim()
  if (!trimmed) return ""
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
    return resolve(trimmed)
  }
  return resolve(trimmed)
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
    await maybeFileWorkedExampleWithGating({
      sid: args.sid,
      subagentType: args.subagentType,
      description: args.description,
      prompt: args.prompt,
      output: args.output,
      workedExampleFilingEnabled,
      workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
      workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      workedExampleFiledByShape,
      getWorkedExampleClient,
      cfgRaw,
      shouldFileWorkedExample,
      extractWorkedExampleShape,
      shouldSkipWorkedExampleByCooldown,
      buildWorkedExampleEntry,
    })
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
    await maybeRecordCapabilityTupleWithGating({
      sid: args.sid,
      subagentType: args.subagentType,
      description: args.description,
      prompt: args.prompt,
      status: args.status,
      capabilityRecordingEnabled,
      capabilityTierBySubagent: CAPABILITY_TIER_BY_SUBAGENT,
      capabilityRecordedBySession,
      getWorkedExampleClient,
      mapTaskStatusToCapabilityOutcome,
      extractWorkedExampleShape,
      buildCapabilityBucketId,
      buildCapabilityCanonicalShape,
    })
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
    await maybeCaptureCalibrationTupleWithGating({
      sid: args.sid,
      model: args.model ?? null,
      description: args.description,
      prompt: args.prompt,
      outputText: args.outputText,
      calibrationCaptureEnabled,
      pendingCalibrationBySession,
      canonicalModelId,
      extractWorkedExampleShape,
      parseSelfReportedConfidence,
      buildCalibrationBucketId,
    })
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
    await persistWorkedInterventionWithGating({
      sid: args.sid,
      model: args.model ?? null,
      taskText: args.taskText,
      interventionLabel: args.interventionLabel,
      interventionText: args.interventionText,
      failureRecordingEnabled,
      canonicalModelId,
      extractWorkedExampleShape,
      failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
      getWorkedExampleClient,
      buildFailurePatchId,
    })
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
    await maybeRecordModelFailureWithGating({
      sid: args.sid,
      model: args.model ?? null,
      taskText: args.taskText,
      event: args.event,
      interventionLabel: args.interventionLabel,
      interventionText: args.interventionText,
      failureRecordingEnabled,
      failureRecordedBySession,
      canonicalModelId,
      extractWorkedExampleShape,
      buildFailureBucketId,
      getWorkedExampleClient,
      buildCapabilityCanonicalShape,
    })
  }

  // Phase 15 CREATE: queue an attempted intervention patch for later success
  // confirmation. Deduped by key (message id); a new nudge on the same message
  // replaces the pending entry so only the latest wording is confirmable.
  function queuePendingIntervention(sid: string, key: string, label: string, text: string): void {
    queuePendingInterventionWithGating({
      sid,
      key,
      label,
      text,
      failureRecordingEnabled,
      pendingInterventionBySession,
      failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
    })
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
    await confirmPendingInterventionsWithGating({
      sid: args.sid,
      confirmedKey: args.confirmedKey,
      model: args.model ?? null,
      taskText: args.taskText,
      failureRecordingEnabled,
      pendingInterventionBySession,
      persistWorkedInterventionWithGating: (a) =>
        persistWorkedInterventionWithGating({
          ...a,
          failureRecordingEnabled,
          canonicalModelId,
          extractWorkedExampleShape,
          failurePatchTextMaxChars: FAILURE_PATCH_TEXT_MAX_CHARS,
          getWorkedExampleClient,
          buildFailurePatchId,
        }),
    })
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
    return resolveLoopGuardRoutingWithGating({
      sid,
      input,
      output,
      getPromptRoutingFromToolHook,
      activeRoutingBySession,
      resolveSessionPromptRouting,
    })
  }

  async function resolveSessionPromptRouting(sid: string): Promise<{
    agent?: string
    model?: { providerID: string; modelID: string }
  }> {
    return resolveSessionPromptRoutingWithGating({
      sid,
      client,
      directory,
      activeRoutingBySession,
      getPromptRouting,
      unwrapListResult,
      sortByCreated,
    })
  }

  async function maybeInjectMemcore(args: {
    sid: string
    event: any
    reason: "idle" | "compacted" | "compacting" | "started"
    messages?: MessageWithParts[]
    anchor?: MessageWithParts | null
    force?: boolean
  }): Promise<boolean> {
    return maybeInjectMemcoreWithGating({
      sid: args.sid,
      event: args.event,
      reason: args.reason,
      messages: args.messages,
      anchor: args.anchor,
      force: args.force,
      rootDirectory,
      projectRoot,
      directory,
      client,
      cfgRaw,
      cfgNum,
      cfgCSV,
      memcoreInjectEnabled,
      memcoreInjectOnIdle,
      memcoreInjectOnCompacted,
      memcoreInjectOnStart,
      memcoreMaxChars,
      injectionCooldownMs,
      memcoreInjectionBySession,
      statusSnapshot,
    })
  }

  async function maybeWarnWriteAuthority(sid: string, msg: MessageWithParts): Promise<boolean> {
    return maybeWarnWriteAuthorityWithGating({
      sid,
      msg,
      consolidationWriteGuardEnabled,
      warnedConsolidationWriteMessageIDs,
      allowedConsolidationWriters,
      client,
      directory,
      getToolNames,
      containsConsolidationWriteTool,
      getAgentIdentity,
      getPromptRouting,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
  }

  async function verifySourceCapture(sid: string, eventType: string): Promise<void> {
    return verifySourceCaptureWithGating({
      sid,
      eventType,
      projectRoot,
      sourceCaptureVerifyEnabled,
      sourceCaptureBySession,
      runSourceCaptureCommand,
      cfgRaw,
      cfgNum,
      defaultSourceCaptureTimeoutMs: DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
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
    return runConsolidationCommandWithGating({
      sid,
      trigger,
      projectRoot,
      eshepherdRoot: ESHEPHERD_ROOT,
      autoConsolidationTimeoutMs,
      setAutoConsolidationInFlight: (value) => { autoConsolidationInFlight = value },
      resolveSessionPromptRouting,
      buildConsolidationEnv,
      buildCommandExecutionPlan,
      spawn,
      appendAutoConsolidationLog,
      releaseAutoConsolidationLock,
      killProcessTree,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
      cfgRaw,
      onStartFailure,
    })
  }

  // Evaluate the opt-in/cooldown/threshold gate and, if it passes, claim the
  // cross-process lock and start a run. State (cooldown stamp, message reset,
  // in-flight) is only stamped once the lock is held, so a run blocked by another
  // process/instance can still fire on a later trigger.
  function evaluateAutoConsolidation(sid: string, trigger: AutoConsolidationTrigger): void {
    return evaluateAutoConsolidationWithGating({
      sid,
      trigger,
      projectRoot,
      autoConsolidationEnabled,
      autoConsolidationCooldownMs,
      autoConsolidationMessageThreshold,
      autoConsolidationTimeoutMs,
      autoConsolidationMaxTrackedSessions,
      autoConsolidationLastRunAt,
      autoConsolidationMessagesSinceRun,
      getAutoConsolidationInFlight: () => autoConsolidationInFlight,
      setAutoConsolidationInFlight: (value) => { autoConsolidationInFlight = value },
      acquireAutoConsolidationLock,
      releaseAutoConsolidationLock,
      runConsolidationCommand,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
  }

  // Arm/replace the idle-delay timer. The timer represents \"stayed quiet for the
  // full delay\"; a new message clears it (see onMessageUpdated) so it is the
  // overridable delay rather than a fixed schedule.
  function armAutoConsolidationIdleTimer(sid: string): void {
    return armAutoConsolidationIdleTimerWithGating({
      sid,
      autoConsolidationEnabled,
      autoConsolidationOnIdle,
      autoConsolidationIdleDelayMs,
      autoConsolidationPendingTimer,
      evaluateAutoConsolidation,
      writeStatusFile: (extra) => writeStatusFile(projectRoot, statusSnapshot(extra)),
    })
  }

  // A new message means the session is active again: cancel any pending
  // idle-triggered run and, for terminal assistant turns, advance the volume
  // counter and eagerly evaluate the volume trigger.
  function noteAutoConsolidationActivity(sid: string, info: any): void {
    return noteAutoConsolidationActivityWithGating({
      sid,
      info,
      autoConsolidationEnabled,
      autoConsolidationMaxTrackedSessions,
      autoConsolidationPendingTimer,
      autoConsolidationMessagesSinceRun,
      autoConsolidationLastRunAt,
      evaluateAutoConsolidation,
    })
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
    return issueRetryWithGating({
      sid,
      last,
      prev,
      retryEnabled,
      retryDisabledModes,
      retryDisabledAgents,
      inspectedStopBySession,
      retriedParentBySession,
      retriesTotalBySession,
      retryChainBySession,
      maxRetriesPerSession,
      client,
      directory,
      getPromptRouting,
      confirmPendingInterventions,
      maybeRecordModelFailure,
      queuePendingIntervention,
    })
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
    return maybeSpiralNudgeWithGating({
      sid,
      last,
      prev,
      spiralGuardEnabled,
      spiralGuardDisabledModes,
      spiralGuardDisabledAgents,
      spiralExemptProviders,
      spiralExemptModelPrefixes,
      spiralExemptReflection,
      spiralInvestigateThreshold,
      spiralReversalThreshold,
      spiralMaxInterventions,
      spiralNudgedBySession,
      spiralInspectedBySession,
      client,
      directory,
      getPromptRouting,
      maybeRecordModelFailure,
      queuePendingIntervention,
    })
  }

  // Returns true if a checkpoint prompt was issued. Idle-only, once per session,
  // and only on a genuinely complete turn so it never fires over a stall.
  const maybeCheckpoint = async (sid: string, last: MessageWithParts): Promise<boolean> => {

    return maybeCheckpointWithGating({
      sid,
      last,
      checkpointedSessions,
      terminalCountBySession,
      checkpointDisabledAgents,
      client,
      directory,
      getPromptRouting,
    })
  }

  const boundHandlers = bindSessionPolicyHandlers({
    client,
    directory,
    projectRoot,
    retryEnabled,
    spiralGuardEnabled,
    autoConsolidationMaxTrackedSessions,
    compactArchiveEnabled,
    autoConsolidationOnCompact,
    noteAutoConsolidationActivity,
    maybeWarnWriteAuthority,
    verifySourceCapture,
    issueRetry,
    maybeSpiralNudge,
    unwrapMessageResult,
    pruneToMax,
    maybeCheckpoint,
    maybeInjectMemcore,
    maybeFileWorkedExamplesFromMessage,
    armAutoConsolidationIdleTimer,
    sortByCreated,
    unwrapListResult,
    evaluateAutoConsolidation,
    statusSnapshot,
    retryChainBySession,
    startupConfirmedBySession,
    terminalCountBySession,
    activeRoutingBySession,
    memoryReadSessions,
    retriedParentBySession,
    retriesTotalBySession,
    inspectedStopBySession,
    toolWindowBySession,
    loopInterventionsBySession,
    taskWindowBySession,
    taskEscalationsBySession,
    taskRecentLaunchBySession,
    workedExampleFiledByShape,
    capabilityRecordedBySession,
    failureRecordedBySession,
    pendingCalibrationBySession,
    pendingInterventionBySession,
    spiralNudgedBySession,
    spiralInspectedBySession,
    checkpointedSessions,
    memcoreInjectionBySession,
    sourceCaptureBySession,
    compactionPathBySession,
  })

  // Phase 13 CREATE: scan a message for successful task tool completions and file
  // worked examples. The task tool part carries the subagent_type in its input args
  // and the output (the subagent's final text) in its state/output field. We only
  // file when the part indicates success (no error status) and the output is
  // substantive. This runs on session.idle — by then the task has completed and
  // the message parts are finalized.
  async function maybeFileWorkedExamplesFromMessage(sid: string, msg: MessageWithParts): Promise<void> {
    return maybeFileWorkedExamplesFromMessageWithGating({
      sid,
      msg,
      workedExampleFilingEnabled,
      workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
      workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
      getActiveModel,
      maybeFileWorkedExampleWithGating: (a) =>
        maybeFileWorkedExampleWithGating({
          ...a,
          workedExampleFilingEnabled,
          workedExampleFileAgentTypes: WORKED_EXAMPLE_FILE_AGENT_TYPES,
          workedExampleMinSubstantiveChars: WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
          workedExampleFiledByShape,
          getWorkedExampleClient,
          cfgRaw,
          shouldFileWorkedExample,
          extractWorkedExampleShape,
          shouldSkipWorkedExampleByCooldown,
          buildWorkedExampleEntry,
        }),
      maybeRecordCapabilityTupleWithGating: (a) =>
        maybeRecordCapabilityTupleWithGating({
          ...a,
          capabilityRecordingEnabled,
          capabilityTierBySubagent: CAPABILITY_TIER_BY_SUBAGENT,
          capabilityRecordedBySession,
          getWorkedExampleClient,
          mapTaskStatusToCapabilityOutcome,
          extractWorkedExampleShape,
          buildCapabilityBucketId,
          buildCapabilityCanonicalShape,
        }),
      maybeCaptureCalibrationTupleWithGating: (a) =>
        maybeCaptureCalibrationTupleWithGating({
          ...a,
          calibrationCaptureEnabled,
          pendingCalibrationBySession,
          canonicalModelId,
          extractWorkedExampleShape,
          parseSelfReportedConfidence,
          buildCalibrationBucketId,
        }),
    })
  }


  const hookHeadHandlers = createHookHeadHandlers({
    cfgBool,
    loadPackagedAssets,
    mergeWithoutOverride,
    loadInstructionPaths,
    dedupeAppendInstructions,
    onMessageUpdated: boundHandlers.onMessageUpdated,
    onSessionIdle: boundHandlers.onSessionIdle,
    onSessionCompacted: boundHandlers.onSessionCompacted,
    onSessionStarted: boundHandlers.onSessionStarted,
  })

  const boundToolExecuteBefore = bindToolExecuteBefore({
    loopGuardEnabled,
    loopExemptTools,
    taskWatchdogEnabled,
    taskSerializeTypes,
    taskSerializeCooldownMs,
    computeToolSignature,
    taskWindowBySession,
    taskEscalationsBySession,
    taskRecentLaunchBySession,
    toolWindowBySession,
    loopInterventionsBySession,
    taskWatchdogThreshold,
    taskWatchdogMaxEscalations,
    resolveLoopGuardRouting,
    resolveTaskSwapTarget,
    taskSwapQwenMatch,
    taskSwapQwenToProvider,
    taskSwapQwenToModel,
    taskSwapGemmaMatch,
    taskSwapGemmaToProvider,
    taskSwapGemmaToModel,
    taskFallbackProvider,
    taskFallbackModel,
    workedExampleInjectionEnabled,
    getWorkedExampleClient,
    retrieveSimilarWorkedExamples,
    WORKED_EXAMPLE_MAX_INJECT,
    WORKED_EXAMPLE_RELEVANCE_FLOOR,
    formatWorkedExampleDemonstration,
    shouldInjectWorkedExamples,
    failurePatchInjectionEnabled,
    canonicalModelId,
    extractWorkedExampleShape,
    buildFailurePatchId,
    CAPABILITY_TIER_BY_SUBAGENT,
    normalizeModelSpec,
    getRoutingEvidenceClient,
    decideCapabilityReroute,
    CAPABILITY_SUBAGENT_BY_TIER,
    CALIBRATION_MIN_HIT_RATE,
    CALIBRATION_OVERRIDE_MIN_SAMPLES,
    parseSelfReportedConfidence,
    buildCalibrationEscalationNote,
    INTERVENTION_REPLAY_HEADING,
    formatInterventionBlock,
    INTERVENTION_REPLAY_MAX_PATCHES,
    loopWindowSize,
    loopRepeatThreshold,
    loopMaxInterventions,
    loopMutationTools,
    confirmPendingInterventions,
    activeRoutingBySession,
    LOOP_GUARD_MARKER,
    client,
    directory,
    maybeRecordModelFailure,
    queuePendingIntervention,
  })


  return {
    config: hookHeadHandlers.config,
    event: hookHeadHandlers.event,
    "tool.execute.before": boundToolExecuteBefore,
    tool: createToolRegistry(),
  } as any
}

export default TurnGuard
