import { existsSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"
// The substrate tool-name prefix and default endpoint are defined in core/ (the
// binding rule keeps the `mempalace_` literal there). Re-exported here so the
// config-spec table and existing importers keep their names unchanged.
import { SUBSTRATE_DEFAULT_URL, SUBSTRATE_TOOL_PREFIX } from "./substrate-client.ts"

export type RuntimeEnv = Record<string, string | undefined>

type ConfigKind = "string" | "number" | "boolean" | "csv" | "enum"

type RuntimeConfigSpec = {
  envKey: string
  path: string
  kind: ConfigKind
  defaultValue: string | number | boolean
  min?: number
  allowedValues?: readonly string[]
}

// Back-compat aliases — the literals live in core/substrate-client.ts.
export const DEFAULT_MCP_URL = SUBSTRATE_DEFAULT_URL
export const DEFAULT_MCP_TOOL_PREFIX = SUBSTRATE_TOOL_PREFIX

export type LoadedRuntimeConfig = {
  configPath?: string
  valuesByPath: Record<string, any>
  warnings: string[]
}

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

const DEFAULT_LOOP_EXEMPT_TOOLS = ["compress", "dcp-compress"]
const DEFAULT_SPIRAL_EXEMPT_PROVIDERS = ["github_copilot"]
const DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES = ["copilot-"]

// Non-secret configuration surface. Secrets stay in env only.
// Command-related options are intentionally grouped under commands.* paths.
export const RUNTIME_CONFIG_SPECS: readonly RuntimeConfigSpec[] = [
  { envKey: "ESHEPHERD_ENV_FILE", path: "env.envFile", kind: "string", defaultValue: "" },
  { envKey: "MEMPALACE_MCP_URL", path: "mcp.url", kind: "string", defaultValue: DEFAULT_MCP_URL },
  { envKey: "ESHEPHERD_MCP_AUTO_DISCOVER", path: "mcp.autoDiscover", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MCP_REQUEST_TIMEOUT_MS", path: "mcp.requestTimeoutMs", kind: "number", defaultValue: 60000, min: 1 },
  { envKey: "ESHEPHERD_MCP_MAX_RETRIES", path: "mcp.maxRetries", kind: "number", defaultValue: 2, min: 0 },
  { envKey: "ESHEPHERD_MCP_RETRY_BACKOFF_MS", path: "mcp.retryBackoffMs", kind: "number", defaultValue: 800, min: 1 },
  { envKey: "ESHEPHERD_MCP_RETRY_MAX_BACKOFF_MS", path: "mcp.retryMaxBackoffMs", kind: "number", defaultValue: 8000, min: 1 },
  { envKey: "ESHEPHERD_PYTHON_BIN", path: "mcp.pythonBin", kind: "string", defaultValue: "python" },
  { envKey: "MEMGRAPH_TOOL_PREFIX", path: "mcp.toolPrefix", kind: "string", defaultValue: DEFAULT_MCP_TOOL_PREFIX },
  { envKey: "MEMPALACE_MCP_AUTH_HEADER", path: "mcp.authHeader", kind: "string", defaultValue: "Authorization" },
  { envKey: "MEMPALACE_MCP_AUTH_SCHEME", path: "mcp.authScheme", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_DELETE_MCP_URL", path: "mcp.deleteUrl", kind: "string", defaultValue: "" },
  { envKey: "NTFY_URL", path: "notifications.ntfyUrl", kind: "string", defaultValue: "" },

  { envKey: "ESHEPHERD_PROJECT_WING", path: "memory.projectWing", kind: "string", defaultValue: "opencode" },
  // The shared skills wing — where promoted skills
  // live so procedural-intent retrieval from ANY project wing can reach them.
  // A location, not a kind: promoted drawers keep es-source-type: skill.
  { envKey: "ESHEPHERD_SHARED_SKILLS_WING", path: "memory.sharedSkillsWing", kind: "string", defaultValue: "shared-skills" },
  // The requesting project's es-domain — used by
  // procedural-intent retrieval to hard-filter shared-skill admission (a `code`
  // skill is never surfaced to a `writing` project). Empty default = unclassified
  // requester, which admits only null/`general` skills; omitted configs keep the
  // pre-domain-filter behavior. Closed vocabulary — out-of-vocabulary values are
  // dropped (read as unclassified), matching the read side's tolerance.
  { envKey: "ESHEPHERD_PROJECT_DOMAIN", path: "memory.projectDomain", kind: "enum", defaultValue: "", allowedValues: ["code", "writing", "infra", "research", "general"] },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_WING", path: "sourceCapture.wing", kind: "string", defaultValue: "opencode" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_ROOM", path: "sourceCapture.room", kind: "string", defaultValue: "source-transcripts" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_ADDED_BY", path: "sourceCapture.addedBy", kind: "string", defaultValue: "electric-shepherd-capture" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_TOOL_PREFIX", path: "sourceCapture.toolPrefix", kind: "string", defaultValue: DEFAULT_MCP_TOOL_PREFIX },
  {
    envKey: "ESHEPHERD_SOURCE_CAPTURE_MODE",
    path: "sourceCapture.mode",
    kind: "enum",
    defaultValue: "append",
    allowedValues: ["append", "replace", "hybrid"],
  },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_DEDUP_ENABLED", path: "sourceCapture.dedupEnabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_VERIFY_ENABLED", path: "sourceCapture.verifyEnabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_CAPTURE_KEEP_LOCAL", path: "sourceCapture.keepLocal", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_CAPTURE_ROOT", path: "sourceCapture.captureRoot", kind: "string", defaultValue: ".electric-shepherd/exports" },

  { envKey: "ESHEPHERD_MEMCORE_REINJECT_ENABLED", path: "memcore.reinject.enabled", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT", path: "memcore.reinject.onCompact", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_MEMCORE_REINJECT_ON_IDLE", path: "memcore.reinject.onIdle", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_MEMCORE_REINJECT_ON_START", path: "memcore.reinject.onStart", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_MEMCORE_MAX_CHARS", path: "memcore.maxChars", kind: "number", defaultValue: 12000, min: 1 },
  { envKey: "ESHEPHERD_MEMCORE_MAX_SCOPES", path: "memcore.maxScopes", kind: "number", defaultValue: 6, min: 1 },
  { envKey: "ESHEPHERD_MEMCORE_DIRECT_FILE", path: "memcore.directFileName", kind: "string", defaultValue: "memory.md" },
  { envKey: "ESHEPHERD_MEMCORE_STORE_ROOTS", path: "memcore.storeRoots", kind: "csv", defaultValue: ".electric-shepherd/memory" },
  { envKey: "ESHEPHERD_MEMCORE_RENDER_INCLUDE_FACTS", path: "memcore.render.includeFacts", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MEMCORE_RENDER_INCLUDE_POINTERS", path: "memcore.render.includePointers", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MEMCORE_RENDER_MAX_FACTS", path: "memcore.render.maxFactsPerSection", kind: "number", defaultValue: 8, min: 1 },
  // The [pending] reminders block in the mem-core
  // render. Enabled by default but hard-capped — a handful of reminders, not a
  // task list; set includePending false to disable the section entirely.
  { envKey: "ESHEPHERD_MEMCORE_RENDER_INCLUDE_PENDING", path: "memcore.render.includePending", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MEMCORE_RENDER_MAX_PENDING", path: "memcore.render.maxPendingReminders", kind: "number", defaultValue: 3, min: 0 },
  // The [dead-ends] block in the mem-core render.
  // Enabled by default but hard-capped — a handful of ruled-out approaches, not a
  // full history; set includeDeadEnds false to disable the section entirely.
  { envKey: "ESHEPHERD_MEMCORE_RENDER_INCLUDE_DEAD_ENDS", path: "memcore.render.includeDeadEnds", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MEMCORE_RENDER_MAX_DEAD_ENDS", path: "memcore.render.maxDeadEnds", kind: "number", defaultValue: 3, min: 0 },
  { envKey: "ESHEPHERD_MEMCORE_INJECTION_COOLDOWN_MS", path: "memcore.injectionCooldownMs", kind: "number", defaultValue: 15000, min: 1 },
  { envKey: "ESHEPHERD_SCOPE_DIR", path: "memcore.scopeDir", kind: "string", defaultValue: "" },

  { envKey: "ESHEPHERD_RETRY_ENABLED", path: "retry.enabled", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_MAX_RETRIES_PER_SESSION", path: "retry.maxRetriesPerSession", kind: "number", defaultValue: 4, min: 1 },
  { envKey: "ESHEPHERD_RETRY_DISABLED_AGENTS", path: "retry.disabledAgents", kind: "csv", defaultValue: "" },
  { envKey: "ESHEPHERD_RETRY_DISABLED_MODES", path: "retry.disabledModes", kind: "csv", defaultValue: "" },
  // End-of-session memory-checkpoint prompt: agents to skip (utility subagents by
  // default — see DEFAULT_CHECKPOINT_DISABLED_AGENTS in plugin/session-policy.ts). An
  // empty CSV falls back to that built-in list.
  { envKey: "ESHEPHERD_CHECKPOINT_DISABLED_AGENTS", path: "checkpoint.disabledAgents", kind: "csv", defaultValue: "" },

  { envKey: "ESHEPHERD_LOOPGUARD_ENABLED", path: "loopGuard.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_LOOPGUARD_THRESHOLD", path: "loopGuard.repeatThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_WINDOW", path: "loopGuard.windowSize", kind: "number", defaultValue: 12, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_MESSAGE_DISTANCE_WINDOW", path: "loopGuard.messageDistanceWindow", kind: "number", defaultValue: 15, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_MAX_INTERVENTIONS", path: "loopGuard.maxInterventions", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_MUTATION_TOOLS", path: "loopGuard.mutationTools", kind: "csv", defaultValue: DEFAULT_LOOP_MUTATION_TOOLS.join(",") },
  { envKey: "ESHEPHERD_LOOPGUARD_EXEMPT_TOOLS", path: "loopGuard.exemptTools", kind: "csv", defaultValue: DEFAULT_LOOP_EXEMPT_TOOLS.join(",") },

  { envKey: "ESHEPHERD_TASK_WATCHDOG_ENABLED", path: "taskWatchdog.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_THRESHOLD", path: "taskWatchdog.repeatThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_MAX_ESCALATIONS", path: "taskWatchdog.maxEscalations", kind: "number", defaultValue: 2, min: 1 },
  { envKey: "ESHEPHERD_TASK_SERIALIZE_TYPES", path: "taskWatchdog.serializeTypes", kind: "csv", defaultValue: "explore,review-diff,run-tests" },
  { envKey: "ESHEPHERD_TASK_SERIALIZE_COOLDOWN_MS", path: "taskWatchdog.serializeCooldownMs", kind: "number", defaultValue: 15000, min: 1 },
  { envKey: "ESHEPHERD_TASK_SWAP_QWEN_MATCH", path: "taskWatchdog.swap.qwen.match", kind: "string", defaultValue: "qwen" },
  { envKey: "ESHEPHERD_TASK_SWAP_QWEN_TO_PROVIDER", path: "taskWatchdog.swap.qwen.toProvider", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_TASK_SWAP_QWEN_TO_MODEL", path: "taskWatchdog.swap.qwen.toModel", kind: "string", defaultValue: "litellm/implementer-gemma4-31b" },
  { envKey: "ESHEPHERD_TASK_SWAP_GEMMA_MATCH", path: "taskWatchdog.swap.gemma.match", kind: "string", defaultValue: "gemma" },
  { envKey: "ESHEPHERD_TASK_SWAP_GEMMA_TO_PROVIDER", path: "taskWatchdog.swap.gemma.toProvider", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_TASK_SWAP_GEMMA_TO_MODEL", path: "taskWatchdog.swap.gemma.toModel", kind: "string", defaultValue: "litellm/implementer-qwen3.8-27b" },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_FALLBACK_PROVIDER", path: "taskWatchdog.fallback.provider", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_FALLBACK_MODEL", path: "taskWatchdog.fallback.model", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_WORKED_EXAMPLE_INJECTION_ENABLED", path: "taskWatchdog.workedExampleInjection.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS", path: "taskWatchdog.workedExampleInjection.searchTimeoutMs", kind: "number", defaultValue: 4000, min: 1 },
  { envKey: "ESHEPHERD_TASK_WATCHDOG_WORKED_EXAMPLE_FILING_ENABLED", path: "taskWatchdog.workedExampleFiling.enabled", kind: "boolean", defaultValue: true },

  { envKey: "ESHEPHERD_SPIRALGUARD_ENABLED", path: "spiralGuard.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_SPIRALGUARD_INVESTIGATE_THRESHOLD", path: "spiralGuard.investigateThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_SPIRALGUARD_REVERSAL_THRESHOLD", path: "spiralGuard.reversalThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_SPIRALGUARD_MAX_INTERVENTIONS", path: "spiralGuard.maxInterventions", kind: "number", defaultValue: 2, min: 1 },
  { envKey: "ESHEPHERD_SPIRALGUARD_EXEMPT_REFLECTION", path: "spiralGuard.exemptReflection", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_SPIRALGUARD_DISABLED_MODES", path: "spiralGuard.disabledModes", kind: "csv", defaultValue: "" },
  { envKey: "ESHEPHERD_SPIRALGUARD_DISABLED_AGENTS", path: "spiralGuard.disabledAgents", kind: "csv", defaultValue: "" },
  { envKey: "ESHEPHERD_SPIRALGUARD_EXEMPT_PROVIDERS", path: "spiralGuard.exemptProviders", kind: "csv", defaultValue: DEFAULT_SPIRAL_EXEMPT_PROVIDERS.join(",") },
  { envKey: "ESHEPHERD_SPIRALGUARD_EXEMPT_MODEL_PREFIXES", path: "spiralGuard.exemptModelPrefixes", kind: "csv", defaultValue: DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES.join(",") },

  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_ENABLED", path: "consolidation.auto.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE", path: "consolidation.auto.onIdle", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT", path: "consolidation.auto.onCompact", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_IDLE_DELAY_MS", path: "consolidation.auto.idleDelayMs", kind: "number", defaultValue: 120000, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD", path: "consolidation.auto.messageThreshold", kind: "number", defaultValue: 12, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_COOLDOWN_MS", path: "consolidation.auto.cooldownMs", kind: "number", defaultValue: 600000, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_MAX_TRACKED_SESSIONS", path: "consolidation.auto.maxTrackedSessions", kind: "number", defaultValue: 512, min: 1 },
  { envKey: "ESHEPHERD_CONSOLIDATION_SEARCH_LIMIT", path: "consolidation.searchLimit", kind: "number", defaultValue: 12, min: 1 },
  { envKey: "ESHEPHERD_CONSOLIDATION_LOCK_DISABLED", path: "consolidation.lock.disabled", kind: "boolean", defaultValue: false },
  {
    envKey: "ESHEPHERD_CONSOLIDATION_NATIVE_COORD_DISABLED",
    path: "consolidation.lock.nativeCoordinatorDisabled",
    kind: "boolean",
    defaultValue: false,
  },
  {
    envKey: "ESHEPHERD_CONSOLIDATION_NATIVE_COORD_PATH",
    path: "consolidation.lock.nativeCoordinatorPath",
    kind: "string",
    defaultValue: "",
  },
  {
    envKey: "ESHEPHERD_CONSOLIDATION_NATIVE_PID_PROBE_DISABLED",
    path: "consolidation.lock.nativePidProbeDisabled",
    kind: "boolean",
    defaultValue: false,
  },

  { envKey: "ESHEPHERD_COMPACT_ARCHIVE", path: "compaction.archiveEnabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_INJECT_INSTRUCTIONS", path: "assets.injectInstructions", kind: "boolean", defaultValue: true },

  { envKey: "ESHEPHERD_SOURCE_CAPTURE_CMD", path: "commands.sourceCapture.command", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS", path: "commands.sourceCapture.timeoutMs", kind: "number", defaultValue: 20000, min: 1 },
  { envKey: "ESHEPHERD_MEMCORE_LOADER_TIMEOUT_MS", path: "commands.memcoreLoader.timeoutMs", kind: "number", defaultValue: 15000, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_CMD", path: "commands.autoConsolidation.command", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_TIMEOUT_MS", path: "commands.autoConsolidation.timeoutMs", kind: "number", defaultValue: 300000, min: 1 },
] as const

const SPEC_BY_ENV_KEY = new Map(RUNTIME_CONFIG_SPECS.map((spec) => [spec.envKey, spec]))

function stripJSONComments(content: string): string {
  let out = ""
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    const next = i + 1 < content.length ? content[i + 1] : ""

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false
        out += ch
      }
      continue
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false
        i += 1
      }
      continue
    }

    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === "/" && next === "/") {
      inLineComment = true
      i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true
      i += 1
      continue
    }

    out += ch
  }

  return out
}

function parseJSONC(content: string): unknown {
  const withoutComments = stripJSONComments(content)
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, "$1")
  return JSON.parse(withoutTrailingCommas)
}

function getByPath(root: unknown, path: string): unknown {
  if (!root || typeof root !== "object") return undefined
  let node: any = root
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object" || !(part in node)) return undefined
    node = node[part]
  }
  return node
}

function setByPath(root: Record<string, any>, path: string, value: string): void {
  const parts = path.split(".")
  let node: Record<string, any> = root
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]
    const child = node[part]
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      node[part] = {}
    }
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

function asBoolean(input: unknown): boolean | undefined {
  if (typeof input === "boolean") return input
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(normalized)) return true
    if (["0", "false", "no", "off"].includes(normalized)) return false
  }
  return undefined
}

function asNumber(input: unknown, min: number): number | undefined {
  const value = typeof input === "number" ? input : Number(input)
  if (!Number.isFinite(value)) return undefined
  if (value < min) return undefined
  return value
}

function asCSV(input: unknown): string | undefined {
  if (Array.isArray(input)) {
    const out = input.map((v) => String(v || "").trim()).filter(Boolean)
    return out.join(",")
  }
  if (typeof input === "string") return input
  return undefined
}

function asString(input: unknown): string | undefined {
  if (typeof input === "undefined" || input === null) return undefined
  return String(input)
}

function normalizeSpecValue(spec: RuntimeConfigSpec, raw: unknown): string | undefined {
  if (spec.kind === "boolean") {
    const value = asBoolean(raw)
    return typeof value === "boolean" ? (value ? "true" : "false") : undefined
  }

  if (spec.kind === "number") {
    const value = asNumber(raw, spec.min ?? 1)
    return typeof value === "number" ? String(value) : undefined
  }

  if (spec.kind === "csv") {
    const value = asCSV(raw)
    return typeof value === "string" ? value : undefined
  }

  if (spec.kind === "enum") {
    const value = asString(raw)?.trim()
    if (!value) return undefined
    if (!spec.allowedValues || spec.allowedValues.includes(value)) return value
    return undefined
  }

  const value = asString(raw)
  return typeof value === "string" ? value : undefined
}

function defaultStringForSpec(spec: RuntimeConfigSpec): string {
  if (spec.kind === "boolean") return spec.defaultValue ? "true" : "false"
  return String(spec.defaultValue)
}

function resolveConfigPath(cwd: string, env: RuntimeEnv): { path?: string; warning?: string } {
  const explicit = String(env.ESHEPHERD_CONFIG_FILE || "").trim()
  if (explicit) {
    const explicitPath = resolve(cwd, explicit)
    if (existsSync(explicitPath)) return { path: explicitPath }
    return { warning: `configured ESHEPHERD_CONFIG_FILE not found: ${explicitPath}` }
  }

  const candidates = [
    resolve(cwd, "eshepherd-config.jsonc"),
    resolve(cwd, "eshepherd-config.example.jsonc"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate }
  }
  return {}
}

// Base normalization for project-derived wing names.
function normalizeWingName(name: string): string {
  return name.toLowerCase().replace(/[ -]/g, "_").replace(/^_+|_+$/g, "")
}

// Many users keep sortable numeric prefixes in folder names (e.g. "001-SampleProject").
// Those prefixes are organizational, not semantic identity, so default wings
// should use the de-prefixed alias by default ("sampleproject").
function normalizeProjectWingAlias(name: string): string {
  const normalized = normalizeWingName(name)
  const alias = normalized.replace(/^\d+_+/, "")
  if (alias && /[a-z]/.test(alias)) {
    return alias
  }
  return normalized
}

function computeDefaultProjectWing(cwd: string, fallback: string): string {
  const normalized = normalizeProjectWingAlias(basename(resolve(cwd)))
  return normalized || fallback
}

export function loadRuntimeConfig(args: {
  cwd: string
  env: RuntimeEnv
}): LoadedRuntimeConfig {
  const warnings: string[] = []

  const pathResult = resolveConfigPath(args.cwd, args.env)
  if (pathResult.warning) warnings.push(pathResult.warning)

  let rawConfig: unknown = {}
  if (pathResult.path) {
    try {
      rawConfig = parseJSONC(readFileSync(pathResult.path, "utf8"))
    } catch (err) {
      warnings.push(`failed to parse config file ${pathResult.path}: ${String(err)}`)
      rawConfig = {}
    }
  }

  const valuesByPath: Record<string, any> = {}
  const configuredPaths = new Set<string>()

  for (const spec of RUNTIME_CONFIG_SPECS) {
    const fromConfig = normalizeSpecValue(spec, getByPath(rawConfig, spec.path))
    if (typeof fromConfig === "string") {
      setByPath(valuesByPath, spec.path, fromConfig)
      configuredPaths.add(spec.path)
      continue
    }

    setByPath(valuesByPath, spec.path, defaultStringForSpec(spec))
  }

  for (const wingKey of ["ESHEPHERD_PROJECT_WING", "ESHEPHERD_SOURCE_CAPTURE_WING"]) {
    // An explicit "" in config means "unset" here too (matches the documented
    // example config), not "route captures to a blank wing".
    const wingSpec = SPEC_BY_ENV_KEY.get(wingKey)
    const currentValue = wingSpec ? asString(getByPath(valuesByPath, wingSpec.path)) : undefined
    if (wingSpec && (!configuredPaths.has(wingSpec.path) || currentValue === "")) {
      setByPath(valuesByPath, wingSpec.path, computeDefaultProjectWing(args.cwd, "opencode"))
    }
  }

  // The shared skills wing is a FIXED name (not directory-derived), so an
  // explicit "" in config means "unset" -> fall back to the spec default, not "route
  // promotions to a blank wing". Distinct from project/source wings above, which are
  // computed from the project directory.
  const sharedWingSpec = SPEC_BY_ENV_KEY.get("ESHEPHERD_SHARED_SKILLS_WING")
  const sharedWingValue = sharedWingSpec ? asString(getByPath(valuesByPath, sharedWingSpec.path)) : undefined
  if (sharedWingSpec && (!configuredPaths.has(sharedWingSpec.path) || sharedWingValue === "")) {
    setByPath(valuesByPath, sharedWingSpec.path, defaultStringForSpec(sharedWingSpec))
  }

  return {
    configPath: pathResult.path,
    valuesByPath,
    warnings,
  }
}

function getRuntimeConfigValueByEnvKey(config: LoadedRuntimeConfig, envKey: string): string | undefined {
  const spec = SPEC_BY_ENV_KEY.get(envKey)
  if (!spec) return undefined
  const value = getByPath(config.valuesByPath, spec.path)
  const normalized = normalizeSpecValue(spec, value)
  return typeof normalized === "string" ? normalized : undefined
}

export function getRuntimeConfigEnvMap(config: LoadedRuntimeConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of RUNTIME_CONFIG_SPECS) {
    out[spec.envKey] = getRuntimeConfigValueByEnvKey(config, spec.envKey) ?? defaultStringForSpec(spec)
  }
  return out
}

export function getRuntimeConfigValueByPath(config: LoadedRuntimeConfig, path: string): string | undefined {
  if (!path.trim()) return undefined
  const value = getByPath(config.valuesByPath, path)
  const raw = asString(value)
  if (typeof raw !== "string") return undefined
  return raw
}

export function applyRuntimeConfigToEnv(env: RuntimeEnv, config: LoadedRuntimeConfig): void {
  void env
  void config
}

export function listRuntimeConfigEnvKeys(): string[] {
  return [...SPEC_BY_ENV_KEY.keys()]
}
