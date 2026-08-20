import { tool } from "@opencode-ai/plugin";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { execFile } from "node:child_process";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { existsSync } from "node:fs";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { dirname, join, resolve } from "node:path";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { fileURLToPath } from "node:url";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { promisify } from "node:util";

declare const process: {
  env: Record<string, string | undefined>;
};

// This file ships inside the plugin install, one level under its root.
const ESHEPHERD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getNumberEnv(name: string, fallback: number): number {
  const raw = Number(process?.env?.[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export default tool({
  description:
    "Force-capture the CURRENT session's transcript into MemPalace right now, bypassing the idle/compaction triggers that normally gate automatic capture. Use when you need this session's content available for consolidation immediately rather than waiting for it to go idle or compact.",
  args: {
    mode: tool.schema
      .enum(["append", "replace", "hybrid"])
      .optional()
      .describe("Override the configured source-capture mode for this one call."),
    reason: tool.schema
      .string()
      .optional()
      .describe("Short free-text reason, recorded in the capture event log (default: manual)."),
  },
  async execute(args, context) {
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env });

    const sid = String(context.sessionID || "").trim();
    if (!sid) {
      throw new Error("capture_transcript: no sessionID available from tool context");
    }
    // The consumer project, NOT this plugin's own install directory -- capture
    // config (wing/room) must resolve against the project actually being captured.
    const projectRoot = context.worktree || context.directory;

    const configured = String(process?.env?.ESHEPHERD_SOURCE_CAPTURE_CMD || "").trim();
    const defaultScript = join(ESHEPHERD_ROOT, "scripts", "capture-source-transcripts.sh");
    const command = configured || (existsSync(defaultScript) ? `bash "${defaultScript}"` : "");
    if (!command) {
      throw new Error("capture_transcript: capture command not configured and default script not found");
    }

    const reason = String(args.reason || "manual").trim() || "manual";
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ESHEPHERD_SESSION_ID: sid,
      ESHEPHERD_EVENT_TYPE: `manual:${reason}`,
      ESHEPHERD_PROJECT_ROOT: projectRoot,
    };
    if (args.mode) {
      childEnv.ESHEPHERD_SOURCE_CAPTURE_MODE = args.mode;
    }

    const execFileAsync = promisify(execFile);
    try {
      const output = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: ESHEPHERD_ROOT,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: getNumberEnv("ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS", 20000),
        killSignal: "SIGKILL",
        env: childEnv,
      });
      const text = String(output?.stdout ?? "").trim() || String(output?.stderr ?? "").trim();
      return JSON.stringify({ ok: true, sid, mode: args.mode || "(configured default)", output: text.slice(-2000) }, null, 2);
    } catch (err) {
      return JSON.stringify({ ok: false, sid, error: String(err) }, null, 2);
    }
  },
});
