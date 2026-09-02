// @ts-nocheck

// Domain category: source transcript capture command.
// Moved verbatim from pure-helpers.ts — see the compatibility re-export there.

import { execFile } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import { ESHEPHERD_ROOT } from "./constants.ts"
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
