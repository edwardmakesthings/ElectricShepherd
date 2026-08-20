/**
 * Shared pure helpers for turn-guard runtime logic and unit tests.
 *
 * Keeping these outside plugin/ prevents OpenCode from auto-loading them as
 * plugin modules.
 */

function hashText(input: string | undefined | null): string {
  const safeInput = typeof input === "string" ? input : ""
  let hash = 2166136261
  for (let i = 0; i < safeInput.length; i += 1) {
    hash ^= safeInput.charCodeAt(i)
    hash = (hash * 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function clipText(input: string | undefined | null, maxChars: number): string {
  const safeInput = typeof input === "string" ? input : ""
  if (safeInput.length <= maxChars) return safeInput
  return `${safeInput.slice(0, maxChars)}\n\n<!-- truncated by turn-guard (${safeInput.length - maxChars} chars omitted) -->`
}

export function normalizeCommandSpec(command: string | undefined | null): { mode: "exec"; command: string; args: string[] } | { mode: "rejected"; reason: string } {
  const raw = typeof command === "string" ? command : ""
  const trimmed = raw.trim()
  if (!trimmed) {
    return { mode: "rejected", reason: "empty-command" }
  }

  if (/['"`;&|<>$\\]/.test(trimmed)) {
    return { mode: "rejected", reason: "shell-metacharacter" }
  }

  const pieces = trimmed.split(/\s+/).filter(Boolean)
  if (pieces.length === 0) return { mode: "rejected", reason: "empty-command" }

  return {
    mode: "exec",
    command: pieces[0],
    args: pieces.slice(1),
  }
}

export function buildCommandExecutionPlan(args: {
  configured: string
  projectRoot: string
  defaultScript: string
  memcoreFile?: string
}): { mode: "exec"; command: string; args: string[]; cwd: string } | { mode: "rejected"; reason: string } {
  const configuredRaw = typeof args.configured === "string" ? args.configured.trim() : ""
  const memcoreFile = args.memcoreFile || ".electric-shepherd/memory/memory.md"
  if (!configuredRaw) {
    return {
      mode: "exec",
      command: "node",
      args: [
        "--experimental-strip-types",
        args.defaultScript,
        "--run-cadence",
        "--cadence-mode",
        "execute",
        "--include-base-pipeline",
        "--apply",
        "--mem-core-file",
        memcoreFile,
      ],
      cwd: args.projectRoot,
    }
  }

  const normalizedConfigured = normalizeCommandSpec(args.configured)
  if (normalizedConfigured.mode === "rejected") {
    return normalizedConfigured
  }

  if (normalizedConfigured.command === "node") {
    const scriptArgs = normalizedConfigured.args.length > 0
      ? normalizedConfigured.args
      : [
          "--experimental-strip-types",
          args.defaultScript,
          "--run-cadence",
          "--cadence-mode",
          "execute",
          "--include-base-pipeline",
          "--apply",
          "--mem-core-file",
          memcoreFile,
        ]
    return {
      mode: "exec",
      command: normalizedConfigured.command,
      args: scriptArgs,
      cwd: args.projectRoot,
    }
  }

  if (normalizedConfigured.command === "bash") {
    const path = normalizedConfigured.args[0] || ""
    if (!path.startsWith("./") && !path.startsWith("/")) {
      return { mode: "rejected", reason: "non-anchored-script" }
    }
    return {
      mode: "exec",
      command: normalizedConfigured.command,
      args: normalizedConfigured.args,
      cwd: args.projectRoot,
    }
  }

  return {
    mode: "exec",
    command: normalizedConfigured.command,
    args: normalizedConfigured.args,
    cwd: args.projectRoot,
  }
}

export type MemcoreInjectionRecord = { signature: string; at: number; scopeDir: string }

export function computeMemcoreSignature(scopeDir: string, clipped: string): string {
  return `${scopeDir}|${hashText(clipped)}`
}

export function decideMemcoreInjection(args: {
  scopeDir: string
  signature: string
  now: number
  previous?: MemcoreInjectionRecord | null
  cooldownMs: number
  force?: boolean
}): { shouldInject: boolean; changed: boolean; cooldownElapsed: boolean } {
  const previous = args.previous ?? null
  const changed = !previous || previous.signature !== args.signature || previous.scopeDir !== args.scopeDir
  const cooldownElapsed = !previous || args.now - previous.at >= args.cooldownMs
  const shouldInject = Boolean(args.force) || (changed && cooldownElapsed)
  return { shouldInject, changed, cooldownElapsed }
}

export type AutoConsolidationTrigger = "volume" | "idle-timer" | "compacted"

export function decideAutoConsolidation(args: {
  enabled: boolean
  now: number
  lastRunAt: number | null
  cooldownMs: number
  messagesSinceRun: number
  messageThreshold: number
  trigger: AutoConsolidationTrigger
  inFlight: boolean
}): { shouldRun: boolean; reason: string } {
  if (!args.enabled) return { shouldRun: false, reason: "disabled" }
  if (args.inFlight) return { shouldRun: false, reason: "in-flight" }

  // Compaction is an explicit memory-boundary event. Run consolidation every time it
  // happens so mem-core refresh does not get deferred by cooldown.
  if (args.trigger === "compacted") {
    return { shouldRun: true, reason: "compacted" }
  }

  const cooldownElapsed = args.lastRunAt == null || args.now - args.lastRunAt >= args.cooldownMs
  if (!cooldownElapsed) return { shouldRun: false, reason: "cooldown" }

  if (args.trigger === "volume") {
    if (args.messagesSinceRun < args.messageThreshold) return { shouldRun: false, reason: "below-threshold" }
    return { shouldRun: true, reason: "volume-threshold" }
  }
  if (args.trigger === "idle-timer") {
    if (args.messagesSinceRun <= 0) return { shouldRun: false, reason: "no-activity" }
    return { shouldRun: true, reason: "idle-timer" }
  }
  return { shouldRun: false, reason: "unknown-trigger" }
}

export function pruneAutoConsolidationTracking(
  activity: Map<string, number> | undefined | null,
  lastRun: Map<string, number> | undefined | null,
  max: number,
): void {
  if (max <= 0) return
  if (!activity || !lastRun) return
  while (activity.size > max) {
    const oldest = activity.keys().next().value as string | undefined
    if (oldest === undefined) break
    activity.delete(oldest)
    lastRun.delete(oldest)
  }
  while (lastRun.size > max) {
    const oldest = lastRun.keys().next().value as string | undefined
    if (oldest === undefined) break
    lastRun.delete(oldest)
  }
}

// ── Loop guard ───────────────────────────────────────────────────────────────
// A tool call is "the same call" when its name and its arguments match. Args are
// canonicalized (keys sorted, clipped) so that key order or trailing whitespace
// never makes two identical calls look different.

/** Stable, order-independent serialization of tool args, for signature hashing. */
export function canonicalizeToolArgs(args: unknown, maxChars = 2000): string {
  const seen = new WeakSet<object>()
  const normalize = (value: any): any => {
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    if (Array.isArray(value)) return value.map(normalize)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key])
    return out
  }
  let text: string
  try {
    text = JSON.stringify(normalize(args) ?? null) ?? "null"
  } catch {
    text = String(args)
  }
  return clipText(text, maxChars)
}

/** Identity of a tool call: name + canonical args. Two loops of the same read share this. */
export function computeToolSignature(tool: string, args: unknown): string {
  return `${String(tool).toLowerCase()}|${hashText(canonicalizeToolArgs(args))}`
}

export type LoopGuardDecision = { count: number; shouldIntervene: boolean; exhausted: boolean }

/**
 * Decide whether the current tool call is a loop worth interrupting.
 *
 * `window` holds the recent tool signatures for the session, oldest first, and
 * excludes the current call. `count` therefore includes the current call. The
 * window is a WINDOW rather than a consecutive run because real loops alternate
 * (read -> grep -> read -> grep), and it is cleared by the caller on any
 * mutating tool, so a legitimate verify cycle (typecheck -> edit -> typecheck)
 * can never accumulate repeats.
 *
 * `exhausted` distinguishes "we already nudged enough times, stop fighting it"
 * from "not a loop" — the caller should log the former rather than intervene.
 */
export function decideLoopIntervention(args: {
  window: string[]
  signature: string
  repeatThreshold: number
  interventionsUsed: number
  maxInterventions: number
}): LoopGuardDecision {
  const count = args.window.reduce((n, sig) => (sig === args.signature ? n + 1 : n), 0) + 1
  const repeated = count >= args.repeatThreshold
  const exhausted = repeated && args.interventionsUsed >= args.maxInterventions
  return { count, shouldIntervene: repeated && !exhausted, exhausted }
}


// ── Deliberation-spiral guard ─────────────────────────────────────────────────
// The inverse of the loop guard. The loop guard catches a repeated *tool call*;
// this catches a finish=stop turn that narrates many investigations ("let me
// check X", "let me re-read Y") while executing NO tool/patch/file part — the
// textual signature of a model reasoning from priors instead of gathering
// evidence. The load-bearing discriminator is `hasActionPart`: a turn that ran
// even one real tool is not spiraling in place, so a long turn that actually
// read files never trips this.

const INVESTIGATE_INTENT_RE =
  /\b(?:let me|let'?s|i'?ll|i will|i'?m going to|going to|i need to|i should|let me now)\s+(?:re-?read|read|check|look|inspect|examine|trace|verify|see|grep|search|find|dig into|step back|think)\b/gi

const REVERSAL_MARKER_RE =
  /\b(?:wait|actually|hmm+|on second thought|let me step back|re-?read(?:ing)?|different angle|going in circles|overthinking|scratch that|no,? wait|hold on)\b/gi

/** Count non-overlapping matches of a global regex. Does not rely on lastIndex. */
export function countMatches(text: string | undefined | null, re: RegExp): number {
  const safe = typeof text === "string" ? text : ""
  if (!safe) return 0
  const matches = safe.match(re)
  return matches ? matches.length : 0
}

/**
 * Decide whether a finished assistant turn is a deliberation spiral.
 *
 * A spiral is: no action part in the turn, and either the announced-investigation
 * count or the reversal-marker count crosses its threshold. `investigateCount`
 * measures "let me check/read/trace…" style intentions; `reversalCount` measures
 * "wait/actually/going in circles" backtracking. Either alone is sufficient — the
 * transcript pathology trips the investigate gate; a shorter thrash trips reversal.
 */
export function detectDeliberationSpiral(args: {
  text: string
  hasActionPart: boolean
  investigateThreshold: number
  reversalThreshold: number
}): { isSpiral: boolean; investigateCount: number; reversalCount: number } {
  if (args.hasActionPart) return { isSpiral: false, investigateCount: 0, reversalCount: 0 }
  const investigateCount = countMatches(args.text, INVESTIGATE_INTENT_RE)
  const reversalCount = countMatches(args.text, REVERSAL_MARKER_RE)
  const isSpiral =
    investigateCount >= args.investigateThreshold || reversalCount >= args.reversalThreshold
  return { isSpiral, investigateCount, reversalCount }
}

const DELIBERATION_EXEMPT_PROMPT_RE =
  /\b(?:reflect|reflection|explain|summar(?:ize|y)|assess|critique|brainstorm|walk me through|what do you think|pros and cons|trade-?offs?)\b/i

/**
 * True when the user's prompt explicitly asks for reflection/explanation — turns
 * that are SUPPOSED to be long and tool-free and must not be flagged as spirals.
 * Intentionally excludes "compare": comparisons should be evidence-based, so a
 * compare turn that reads nothing is a legitimate spiral to catch.
 */
export function isDeliberationExemptPrompt(text: string | undefined | null): boolean {
  return DELIBERATION_EXEMPT_PROMPT_RE.test(typeof text === "string" ? text : "")
}
