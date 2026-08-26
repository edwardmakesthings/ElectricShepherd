// @ts-expect-error runtime script package does not include node typings
import { existsSync, readFileSync } from "node:fs"
// @ts-expect-error runtime script package does not include node typings
import { basename, resolve } from "node:path"

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

type ConfigValueSource = "default" | "config" | "env"

export type LoadedRuntimeConfig = {
  configPath?: string
  valuesByEnvKey: Record<string, string>
  sourceByEnvKey: Record<string, ConfigValueSource>
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
  { envKey: "MEMPALACE_MCP_URL", path: "mcp.url", kind: "string", defaultValue: "http://localhost:8093/mcp" },
  { envKey: "ESHEPHERD_MCP_AUTO_DISCOVER", path: "mcp.autoDiscover", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MCP_REQUEST_TIMEOUT_MS", path: "mcp.requestTimeoutMs", kind: "number", defaultValue: 60000, min: 1 },
  { envKey: "ESHEPHERD_MCP_MAX_RETRIES", path: "mcp.maxRetries", kind: "number", defaultValue: 2, min: 0 },
  { envKey: "ESHEPHERD_MCP_RETRY_BACKOFF_MS", path: "mcp.retryBackoffMs", kind: "number", defaultValue: 800, min: 1 },
  { envKey: "ESHEPHERD_PYTHON_BIN", path: "mcp.pythonBin", kind: "string", defaultValue: "python" },
  { envKey: "MEMGRAPH_TOOL_PREFIX", path: "mcp.toolPrefix", kind: "string", defaultValue: "mempalace_" },
  { envKey: "MEMPALACE_MCP_AUTH_HEADER", path: "mcp.authHeader", kind: "string", defaultValue: "Authorization" },
  { envKey: "MEMPALACE_MCP_AUTH_SCHEME", path: "mcp.authScheme", kind: "string", defaultValue: "" },
  { envKey: "ESHEPHERD_DELETE_MCP_URL", path: "mcp.deleteUrl", kind: "string", defaultValue: "" },
  { envKey: "NTFY_URL", path: "notifications.ntfyUrl", kind: "string", defaultValue: "" },

  { envKey: "ESHEPHERD_PROJECT_WING", path: "memory.projectWing", kind: "string", defaultValue: "opencode" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_WING", path: "sourceCapture.wing", kind: "string", defaultValue: "opencode" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_ROOM", path: "sourceCapture.room", kind: "string", defaultValue: "source-transcripts" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_ADDED_BY", path: "sourceCapture.addedBy", kind: "string", defaultValue: "electric-shepherd-capture" },
  { envKey: "ESHEPHERD_SOURCE_CAPTURE_TOOL_PREFIX", path: "sourceCapture.toolPrefix", kind: "string", defaultValue: "mempalace_" },
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
  // Phase 8 (prospective memory): the [pending] reminders block in the mem-core
  // render. Enabled by default but hard-capped — a handful of reminders, not a
  // task list; set includePending false to disable the section entirely.
  { envKey: "ESHEPHERD_MEMCORE_RENDER_INCLUDE_PENDING", path: "memcore.render.includePending", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_MEMCORE_RENDER_MAX_PENDING", path: "memcore.render.maxPendingReminders", kind: "number", defaultValue: 3, min: 0 },
  // Phase 9 (negative knowledge): the [dead-ends] block in the mem-core render.
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

  { envKey: "ESHEPHERD_LOOPGUARD_ENABLED", path: "loopGuard.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_LOOPGUARD_THRESHOLD", path: "loopGuard.repeatThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_WINDOW", path: "loopGuard.windowSize", kind: "number", defaultValue: 12, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_MAX_INTERVENTIONS", path: "loopGuard.maxInterventions", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_LOOPGUARD_MUTATION_TOOLS", path: "loopGuard.mutationTools", kind: "csv", defaultValue: DEFAULT_LOOP_MUTATION_TOOLS.join(",") },
  { envKey: "ESHEPHERD_LOOPGUARD_EXEMPT_TOOLS", path: "loopGuard.exemptTools", kind: "csv", defaultValue: DEFAULT_LOOP_EXEMPT_TOOLS.join(",") },

  { envKey: "ESHEPHERD_SPIRALGUARD_ENABLED", path: "spiralGuard.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_SPIRALGUARD_INVESTIGATE_THRESHOLD", path: "spiralGuard.investigateThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_SPIRALGUARD_REVERSAL_THRESHOLD", path: "spiralGuard.reversalThreshold", kind: "number", defaultValue: 3, min: 1 },
  { envKey: "ESHEPHERD_SPIRALGUARD_MAX_INTERVENTIONS", path: "spiralGuard.maxInterventions", kind: "number", defaultValue: 2, min: 1 },
  { envKey: "ESHEPHERD_SPIRALGUARD_EXEMPT_REFLECTION", path: "spiralGuard.exemptReflection", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_SPIRALGUARD_DISABLED_MODES", path: "spiralGuard.disabledModes", kind: "csv", defaultValue: "" },
  { envKey: "ESHEPHERD_SPIRALGUARD_DISABLED_AGENTS", path: "spiralGuard.disabledAgents", kind: "csv", defaultValue: "" },
  { envKey: "ESHEPHERD_SPIRALGUARD_EXEMPT_PROVIDERS", path: "spiralGuard.exemptProviders", kind: "csv", defaultValue: DEFAULT_SPIRAL_EXEMPT_PROVIDERS.join(",") },
  { envKey: "ESHEPHERD_SPIRALGUARD_EXEMPT_MODEL_PREFIXES", path: "spiralGuard.exemptModelPrefixes", kind: "csv", defaultValue: DEFAULT_SPIRAL_EXEMPT_MODEL_PREFIXES.join(",") },

  { envKey: "ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED", path: "consolidation.writeGuardEnabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_ALLOWED_CONSOLIDATION_WRITERS", path: "consolidation.allowedWriters", kind: "csv", defaultValue: "dreamer" },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_ENABLED", path: "consolidation.auto.enabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE", path: "consolidation.auto.onIdle", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT", path: "consolidation.auto.onCompact", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_IDLE_DELAY_MS", path: "consolidation.auto.idleDelayMs", kind: "number", defaultValue: 120000, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD", path: "consolidation.auto.messageThreshold", kind: "number", defaultValue: 12, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_COOLDOWN_MS", path: "consolidation.auto.cooldownMs", kind: "number", defaultValue: 600000, min: 1 },
  { envKey: "ESHEPHERD_AUTO_CONSOLIDATION_MAX_TRACKED_SESSIONS", path: "consolidation.auto.maxTrackedSessions", kind: "number", defaultValue: 512, min: 1 },
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

  { envKey: "ESHEPHERD_PRECOMPACT_PROBE", path: "compaction.precompactProbeEnabled", kind: "boolean", defaultValue: false },
  { envKey: "ESHEPHERD_COMPACT_ARCHIVE", path: "compaction.archiveEnabled", kind: "boolean", defaultValue: true },
  { envKey: "ESHEPHERD_COMPACT_PROMPT_OVERRIDE", path: "compaction.promptOverrideEnabled", kind: "boolean", defaultValue: true },
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
    resolve(cwd, ".electric-shepherd", "config.jsonc"),
    resolve(cwd, "electric-shepherd.config.jsonc"),
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

  const valuesByEnvKey: Record<string, string> = {}
  const sourceByEnvKey: Record<string, ConfigValueSource> = {}

  for (const spec of RUNTIME_CONFIG_SPECS) {
    // Precedence: explicit env > config file > default. An explicitly-set env var
    // must win, otherwise a caller cannot isolate a spawned run from project
    // config (e.g. one-shot consolidation subagents that must start clean of
    // mem-core injection).
    const fromEnv = normalizeSpecValue(spec, args.env[spec.envKey])
    if (typeof fromEnv === "string") {
      valuesByEnvKey[spec.envKey] = fromEnv
      sourceByEnvKey[spec.envKey] = "env"
      continue
    }

    const fromConfig = normalizeSpecValue(spec, getByPath(rawConfig, spec.path))
    if (typeof fromConfig === "string") {
      valuesByEnvKey[spec.envKey] = fromConfig
      sourceByEnvKey[spec.envKey] = "config"
      continue
    }

    valuesByEnvKey[spec.envKey] = defaultStringForSpec(spec)
    sourceByEnvKey[spec.envKey] = "default"
  }

  for (const wingKey of ["ESHEPHERD_PROJECT_WING", "ESHEPHERD_SOURCE_CAPTURE_WING"]) {
    // An explicit "" in config means "unset" here too (matches the documented
    // example config), not "route captures to a blank wing".
    if (sourceByEnvKey[wingKey] === "default" || valuesByEnvKey[wingKey] === "") {
      valuesByEnvKey[wingKey] = computeDefaultProjectWing(args.cwd, "opencode")
    }
  }

  return {
    configPath: pathResult.path,
    valuesByEnvKey,
    sourceByEnvKey,
    warnings,
  }
}

export function applyRuntimeConfigToEnv(env: RuntimeEnv, config: LoadedRuntimeConfig): void {
  for (const [key, value] of Object.entries(config.valuesByEnvKey)) {
    env[key] = value
  }
}

export function listRuntimeConfigEnvKeys(): string[] {
  return [...SPEC_BY_ENV_KEY.keys()]
}
