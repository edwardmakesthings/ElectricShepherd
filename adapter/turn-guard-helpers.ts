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
}): { mode: "exec"; command: string; args: string[]; cwd: string } | { mode: "rejected"; reason: string } {
  const normalizedConfigured = normalizeCommandSpec(args.configured)
  if (normalizedConfigured.mode === "rejected") {
    return normalizedConfigured
  }

  if (normalizedConfigured.command === "node") {
    const scriptArgs = normalizedConfigured.args.length > 0 ? normalizedConfigured.args : ["scripts/run-memory-consolidation-and-validation.ts", "--run-cadence", "--cadence-mode", "execute", "--apply"]
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

export type AutoSynthTrigger = "volume" | "idle-timer" | "compacted"

export function decideAutoSynth(args: {
  enabled: boolean
  now: number
  lastRunAt: number | null
  cooldownMs: number
  messagesSinceRun: number
  messageThreshold: number
  trigger: AutoSynthTrigger
  inFlight: boolean
}): { shouldRun: boolean; reason: string } {
  if (!args.enabled) return { shouldRun: false, reason: "disabled" }
  if (args.inFlight) return { shouldRun: false, reason: "in-flight" }

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
  return { shouldRun: true, reason: "compacted" }
}

export function pruneAutoSynthTracking(
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
