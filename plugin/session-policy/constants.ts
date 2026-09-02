// @ts-nocheck


import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Absolute path to the ElectricShepherd install root (the plugin's own repo).
// Runtime scripts must run from HERE — not the consumer project's cwd — so
// loadRuntimeEnv finds ElectricShepherd/.env (or the sibling docker/.env) and
// scripts resolve their sibling adapter modules. Single source of truth: this
// file lives at plugin/session-policy/, so ".." is the plugin dir and "../.."
// is the install root.
export const ESHEPHERD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

export type MessageWithParts = {
  info?: any
  parts?: any[]
}

export const AUTO_RETRY_MARKER = "[Auto-Retry Guard]"
export const CHECKPOINT_MARKER = "[Memory Checkpoint]"
export const MEMCORE_REINJECT_MARKER = "[Mem-core Reinjection]"
export const WRITE_AUTHORITY_MARKER = "[Write-Authority Gate]"
export const MIN_USEFUL_TEXT = 24
export const START_BANNER = "[turn-guard] START"
export const MAX_RETRIES_PER_PARENT = 2
// Hard ceiling on the TOTAL number of auto-retries per session, independent of
// parent keying. The per-parent cap above can be defeated by a persistent stall:
// each auto-retry prompt becomes the parent of the next turn and the retryKey
// fold only climbs one level (to the grandparent), so the key shifts every
// generation and the per-parent counter never saturates. Without this total
// cap a wedged model would retry forever — each retry firing a fresh generation,
// turning a silent hang into an active GPU-pinning / cost runaway. 4 nudges is
// plenty: a transient stall recovers on the first, a genuinely stuck one will
// not recover after four. Override with ESHEPHERD_MAX_RETRIES_PER_SESSION.
export const DEFAULT_MAX_RETRIES_PER_SESSION = 4
export const STATUS_DIR = ".electric-shepherd"
export const STATUS_FILE = "turn-guard-status.json"
export const AUTOCONSOLIDATION_LOG_FILE = "auto-consolidation.log"
export const MEMCORE_CONTEXT_LOG_FILE = "memcore-context.ndjson"
export const MEMORY_USAGE_LOG_FILE = "memory-usage.ndjson"
// Append-only NDJSON event log: every statusSnapshot write is appended here (one
// JSON object per line) in addition to overwriting the single-status snapshot.
// The snapshot answers "current state"; this log answers "what fired, in order,
// on this event" — which matters because one compaction emits several snapshots
// (compact-archive, source-capture-verify) and the
// overwrite-only snapshot would only retain the last.
export const EVENT_LOG_FILE = "turn-guard-events.ndjson"
export const TURN_GUARD_INSTANCE_DIRS_KEY = "__ESHEPHERD_TURN_GUARD_INSTANCE_DIRS__"
// Test seam: set to true on globalThis before calling TurnGuard to clear the
// per-directory instance dedupe (tests run the real handler in-process).
export const TURN_GUARD_INSTANCE_RESET_KEY = "__ESHEPHERD_TURN_GUARD_INSTANCE_RESET__"
export const DEFAULT_MEMCORE_MAX_CHARS = 12000
export const DEFAULT_MEMCORE_MAX_SCOPES = 6
export const DEFAULT_INJECTION_COOLDOWN_MS = 15000
export const DEFAULT_RETRY_ENABLED = false
export const LOOP_GUARD_MARKER = "[Loop Guard]"
// Loop guard: abort a tool call whose (name + args) has already run N times in
// the recent window with no mutation in between, and hand the model a short
// nudge instead of the tool result. Deliberately gentle — in practice "are you
// looping? regroup" breaks the cycle; a heavyweight intervention is not needed.
//
// NOTE: OpenCode's tool.execute.before hook does not fire for tool calls made
// inside subagents spawned via the task tool (upstream issue #5894), so a loop
// entirely contained in a subagent will not be caught here.
export const DEFAULT_LOOP_GUARD_ENABLED = true
export const DEFAULT_LOOP_REPEAT_THRESHOLD = 3
export const DEFAULT_LOOP_WINDOW_SIZE = 12
export const DEFAULT_LOOP_MAX_INTERVENTIONS = 3
export const DEFAULT_TASK_WATCHDOG_ENABLED = true
export const DEFAULT_TASK_WATCHDOG_THRESHOLD = 3
export const DEFAULT_TASK_WATCHDOG_MAX_ESCALATIONS = 2
export const DEFAULT_TASK_SERIALIZE_TYPES = ["explore", "review-diff", "run-tests"]
export const DEFAULT_TASK_SERIALIZE_COOLDOWN_MS = 15000
export const DEFAULT_TASK_SWAP_QWEN_MATCH = "qwen"
export const DEFAULT_TASK_SWAP_QWEN_TO_MODEL = "litellm/implementer-gemma4-31b"
export const DEFAULT_TASK_SWAP_GEMMA_MATCH = "gemma"
export const DEFAULT_TASK_SWAP_GEMMA_TO_MODEL = "litellm/implementer-qwen3.8-27b"
// Phase 13 (worked-example injection): when delegating to @implement-local via the
// task tool, append up to WORKED_EXAMPLE_MAX_INJECT relevant apprenticeship worked
// examples as demonstrations. Below WORKED_EXAMPLE_RELEVANCE_FLOOR, inject nothing.
// The cap and floor are defined in adapter/retrieval-expansion.ts (single source of
// truth); they are re-exported here for the config echo and testability.
export const DEFAULT_WORKED_EXAMPLE_INJECTION_ENABLED = true
export const DEFAULT_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS = 4000
// Phase 13 CREATE: when a cloud implementation subagent (implement-cloud,
// build-cloud) completes successfully with substantive output, file a compact
// worked example to the apprenticeship room and stamp it es-source-type:
// worked-example. Worked examples are a distinct knowledge class from procedural
// skills, so they get their own source type; the CONSUME side admits both
// "worked-example" (new filings) and "skill" (pre-existing drawers) via
// WORKED_EXAMPLE_SOURCE_TYPES in adapter/retrieval-expansion.ts. The apprentice
// flows (implement-local, build) deliberately do NOT file — see
// WORKED_EXAMPLE_FILE_AGENT_TYPES for the rationale.
export const DEFAULT_WORKED_EXAMPLE_FILING_ENABLED = true
// Phase 14 CREATE: when a routing-tier subagent (implement-local, implement-cloud,
// implement-deep-cloud, solve-deep-cloud) completes, record a capability tuple
// (task shape, tier, outcome) to the palace so the CONSUME side can aggregate
// evidence per (shape, tier) and recommend a tier with a min-sample gate. The
// outcome is derived from the task tool part status (success/failed/aborted), NOT
// from Phase 7's es-outcome axis (human-authoritative). Best-effort: any failure
// degrades to a log line and never throws into the turn.
  export const DEFAULT_CAPABILITY_RECORDING_ENABLED = true
// Phase 15 CREATE: when a turn-guard intervention fires (loop nudge, spiral
// detection), record a failure event attributed to (model, task shape) plus the
// successful intervention text. Shape reuses Phase 14's extractWorkedExampleShape /
// buildCapabilityCanonicalShape — no second shape system. Model identity is
// deterministic from routing context (provider/model); unknown => skip. The
// failure axis uses NEW es-failure-* / es-intervention-* predicates, never
// es-outcome (Phase 7 is human-authoritative). Best-effort: any failure degrades
// to a log line and never throws into the turn.
export const DEFAULT_FAILURE_RECORDING_ENABLED = true
// Phase 15 CONSUME: when delegating via the task tool, inject known successful
// intervention patches for (model, shape) — only on an exact (model, shapeKey)
// match, so absent data yields no injection and no prompt bloat.
export const DEFAULT_FAILURE_PATCH_INJECTION_ENABLED = true
// Phase 16 CREATE: capture the self-reported confidence label from a subagent's
// terminal output at completion time. The PENDING tuple (model, shape, confidence)
// is stored session-locally; it becomes a durable calibration edge ONLY when the
// operator later records an es-outcome for that unit via record_outcome (the
// human-authoritative path). No proxy outcome labels are ever written here.
export const DEFAULT_CALIBRATION_CAPTURE_ENABLED = true
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
export const CALIBRATION_OVERRIDE_MIN_SAMPLES = 5
export const CALIBRATION_MIN_HIT_RATE = 0.6
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
export const INTERVENTION_REPLAY_MAX_PATCHES = 3
  // looking like a loop, without needing to exempt the verify tools themselves.
export const DEFAULT_LOOP_MUTATION_TOOLS = [
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
export const DEFAULT_LOOP_EXEMPT_TOOLS = ["compress", "dcp-compress"]

export const SPIRAL_GUARD_MARKER = "[Spiral Guard]"
// Deliberation-spiral guard: the inverse of the loop guard. The loop guard
// catches a repeated *tool call*; this catches a finish=stop turn that narrates
// many investigations ("let me check X", "let me re-read Y") while executing NO
// tool/patch/file part — a model reasoning from priors instead of reading. It is
// reactive: it redirects the NEXT turn. OpenCode exposes no token-level hook to
// abort mid-stream, and pure-text generation never passes tool.execute.before,
// so the loop guard structurally cannot see this failure mode.
export const DEFAULT_SPIRAL_GUARD_ENABLED = true
export const DEFAULT_SPIRAL_INVESTIGATE_THRESHOLD = 3
export const DEFAULT_SPIRAL_REVERSAL_THRESHOLD = 3
export const DEFAULT_SPIRAL_MAX_INTERVENTIONS = 2
// Cloud models don't spiral the way small local models do — the guard was built
// for the local llama-swap models and a false positive on a paid Copilot call
// costs a wasted turn. Skip the guard for these providers by default.
export const DEFAULT_SPIRAL_EXEMPT_PROVIDERS = ["github_copilot"]
// In OpenCode, cloud calls often route through providerID="litellm" with the
// concrete model in modelID (e.g. copilot-*). Exempt by model prefix too.
export const DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES = ["copilot-"]
export const DEFAULT_ALLOWED_CONSOLIDATION_WRITERS = ["dreamer"]
export const CONSOLIDATION_WRITE_TOOL_NAMES = ["add_drawer", "update_drawer", "kg_add", "kg_invalidate", "apply_merge"]

// Automatic consolidation ("consolidate in the background"): OPT-IN. When enabled,
// the plugin runs the deterministic consolidation script after the session has
// either gone quiet for a delay (idle-timer) or accumulated enough new turns
// (volume-threshold), and on compaction. The idle-timer is overridable: any new
// message clears the pending timer so consolidation only runs once the session
// has actually stayed quiet for the full delay.
export const DEFAULT_AUTOCONSOLIDATION_IDLE_DELAY_MS = 120000
export const DEFAULT_AUTOCONSOLIDATION_MESSAGE_THRESHOLD = 12
export const DEFAULT_AUTOCONSOLIDATION_COOLDOWN_MS = 600000
export const DEFAULT_AUTOCONSOLIDATION_TIMEOUT_MS = 300000
export const AUTOCONSOLIDATION_LOCK_FILE = "auto-consolidation.lock"
export const DEFAULT_SOURCE_CAPTURE_TIMEOUT_MS = 20000
export const DEFAULT_MEMCORE_LOADER_TIMEOUT_MS = 15000
// Bound the per-session auto-consolidation tracking maps so a long-lived process that
// touches thousands of sessions cannot leak memory. Oldest (least-recently
// inserted) sessions are evicted first; evicting a still-active session is
// harmless (it is simply re-tracked on its next turn as if newly seen).
export const DEFAULT_AUTOCONSOLIDATION_MAX_TRACKED_SESSIONS = 512

// Checkpoint gating: only after real work, only in agents that learn durable facts.
export const MIN_TERMINAL_MESSAGES_BEFORE_CHECKPOINT = 4
export const CHECKPOINT_MODES = new Set(["build", "plan"])
// Utility subagents do no durable work of their own (read-only exploration,
// diff review, mechanical test runs) — never prompt them for a memory checkpoint.
export const DEFAULT_CHECKPOINT_DISABLED_AGENTS = ["explore", "review-diff", "run-tests", "check-diff"]

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

export function parseCSV(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function toLowerSet(items: string[]): Set<string> {
  return new Set(items.map((item) => item.toLowerCase()))
}

export function normalizePathForHost(path: string): string {
  if (!path) return ""
  const trimmed = path.trim()
  if (!trimmed) return ""
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
    return resolve(trimmed)
  }
  return resolve(trimmed)
}