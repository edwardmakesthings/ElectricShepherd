// @ts-nocheck

// Domain category: source transcript capture command.
// Moved verbatim from pure-helpers.ts — see the compatibility re-export there.

import { execFile, spawn } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import { ESHEPHERD_ROOT, AUTOCONSOLIDATION_LOG_FILE, STATUS_DIR } from "./constants.ts"
import { buildSourceCaptureEnv } from "./env.ts"

export async function runSourceCaptureCommand(
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

export async function verifySourceCaptureWithGating(args: {
  sid: string
  eventType: string
  projectRoot: string
  sourceCaptureVerifyEnabled: boolean
  sourceCaptureBySession: Map<string, { totalEvents: number; lastEvent: string; lastAt: string; lastSuccess: boolean }>
  runSourceCaptureCommand: (
    projectRoot: string,
    sid: string,
    eventType: string,
    options: { command: string; timeoutMs: number },
  ) => Promise<{ attempted: boolean; ok: boolean; output?: string; error?: string; status?: string; mode?: string; wing?: string; room?: string; source_file?: string; drawer_id?: string; location?: string }>
  cfgRaw: (path: string) => string
  cfgNum: (path: string, fallback: number) => number
  defaultSourceCaptureTimeoutMs: number
  writeStatusFile: (extra: Record<string, unknown>) => void
}): Promise<void> {
  if (!args.sourceCaptureVerifyEnabled) return

  const result = await args.runSourceCaptureCommand(args.projectRoot, args.sid, args.eventType, {
    command: args.cfgRaw("commands.sourceCapture.command"),
    timeoutMs: args.cfgNum("commands.sourceCapture.timeoutMs", args.defaultSourceCaptureTimeoutMs),
  })
  const prev = args.sourceCaptureBySession.get(args.sid)
  const next = {
    totalEvents: Number(prev?.totalEvents || 0) + 1,
    lastEvent: args.eventType,
    lastAt: new Date().toISOString(),
    lastSuccess: result.ok,
  }
  args.sourceCaptureBySession.set(args.sid, next)

  args.writeStatusFile({
    type: "source-capture-verify",
    sid: args.sid,
    eventType: args.eventType,
    capture: result,
    sessionCaptureState: next,
  })

  if (!result.attempted) {
    console.log("[turn-guard] source transcript capture verification: command not configured and default script not found")
  }
}

export async function runConsolidationCommandWithGating(args: {
  sid: string
  trigger: string
  projectRoot: string
  eshepherdRoot: string
  autoConsolidationTimeoutMs: number
  setAutoConsolidationInFlight: (value: boolean) => void
  resolveSessionPromptRouting: (sid: string) => Promise<{ agent?: string; model?: { providerID: string; modelID: string } }>
  buildConsolidationEnv: (input: { sid: string; trigger: string; projectRoot: string; agent?: string; modelProviderID?: string; modelID?: string }) => Record<string, string>
  buildCommandExecutionPlan: (input: { configured: string; projectRoot: string; defaultScript: string; memcoreFile: string }) => any
  spawn: typeof spawn
  appendAutoConsolidationLog: (projectRoot: string, line: string) => void
  releaseAutoConsolidationLock: (projectRoot: string) => void
  killProcessTree: (child: any) => void
  writeStatusFile: (extra: Record<string, unknown>) => void
  cfgRaw: (path: string) => string
  onStartFailure?: () => void
}): Promise<void> {
  const configured = args.cfgRaw("commands.autoConsolidation.command")
  const startedAt = new Date().toISOString()
  console.log(`[turn-guard] auto-consolidation start sid=${args.sid} trigger=${args.trigger}`)
  args.writeStatusFile({ type: "auto-consolidation-start", sid: args.sid, trigger: args.trigger, startedAt })

  let settled = false
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const settle = (status: Record<string, unknown>, startFailure = false) => {
    if (settled) return
    settled = true
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    args.setAutoConsolidationInFlight(false)
    args.releaseAutoConsolidationLock(args.projectRoot)
    // A run that never actually started should not consume the cooldown, so a
    // later trigger can retry promptly. A run that started and then failed/timed
    // out keeps the cooldown (anti-thrash).
    if (startFailure) {
      try {
        args.onStartFailure?.()
      } catch (err) {
        console.error("[turn-guard] auto-consolidation start-failure rollback failed:", err)
      }
    }
    args.writeStatusFile({ ...status, finishedAt: new Date().toISOString() })
    args.appendAutoConsolidationLog(
      args.projectRoot,
      `${new Date().toISOString()} [finish] sid=${args.sid} trigger=${args.trigger} status=${JSON.stringify(status)}`,
    )
  }

  try {
    const routing = await args.resolveSessionPromptRouting(args.sid)
    const childEnv = args.buildConsolidationEnv({
      sid: args.sid,
      trigger: args.trigger,
      projectRoot: args.projectRoot,
      agent: routing.agent,
      modelProviderID: routing.model?.providerID,
      modelID: routing.model?.modelID,
    })
    // detached:true makes the child a process-group leader on POSIX so the
    // watchdog can kill the entire tree (see killProcessTree); harmless on
    // Windows where taskkill /T handles the tree instead.
    const detached = process.platform !== "win32"
    const plan = args.buildCommandExecutionPlan({
      configured,
      projectRoot: args.eshepherdRoot,
      defaultScript: join(args.eshepherdRoot, "scripts", "run-memory-consolidation-and-validation.ts"),
      // Absolute: a relative path would resolve against the plugin install, where nothing reads it.
      memcoreFile: join(args.projectRoot, STATUS_DIR, "memory", "memory.md"),
    })

    if (plan.mode === "rejected") {
      console.error(`[turn-guard] auto-consolidation rejected unsafe command: ${plan.reason}`)
      settle({ type: "auto-consolidation-rejected", sid: args.sid, trigger: args.trigger, reason: plan.reason }, true)
      return
    }

    const logPath = join(args.projectRoot, STATUS_DIR, AUTOCONSOLIDATION_LOG_FILE)
    args.appendAutoConsolidationLog(
      args.projectRoot,
      `${new Date().toISOString()} [start] sid=${args.sid} trigger=${args.trigger} command=${plan.command} args=${JSON.stringify(plan.args)} logPath=${logPath}`,
    )

    const child = args.spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      detached,
    })

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk ?? "").trim()
      if (!text) return
      args.appendAutoConsolidationLog(args.projectRoot, `${new Date().toISOString()} [stdout] sid=${args.sid} ${text}`)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk ?? "").trim()
      if (!text) return
      args.appendAutoConsolidationLog(args.projectRoot, `${new Date().toISOString()} [stderr] sid=${args.sid} ${text}`)
    })

    watchdog = setTimeout(() => {
      console.error(
        `[turn-guard] auto-consolidation timeout sid=${args.sid} trigger=${args.trigger} after ${args.autoConsolidationTimeoutMs}ms; killing`,
      )
      args.killProcessTree(child)
      settle({ type: "auto-consolidation-timeout", sid: args.sid, trigger: args.trigger, timeoutMs: args.autoConsolidationTimeoutMs })
    }, args.autoConsolidationTimeoutMs)
    watchdog.unref?.()

    child.on("error", (err: unknown) => {
      console.error("[turn-guard] auto-consolidation spawn error:", err)
      settle({ type: "auto-consolidation-error", sid: args.sid, trigger: args.trigger, error: String(err) }, true)
    })
    child.on("exit", (code: number | null) => {
      console.log(`[turn-guard] auto-consolidation finished sid=${args.sid} trigger=${args.trigger} code=${String(code)}`)
      settle({ type: "auto-consolidation-finish", sid: args.sid, trigger: args.trigger, exitCode: code })
    })
    child.unref?.()
  } catch (err) {
    console.error("[turn-guard] auto-consolidation failed to start:", err)
    settle({ type: "auto-consolidation-error", sid: args.sid, trigger: args.trigger, error: String(err) }, true)
  }
}
