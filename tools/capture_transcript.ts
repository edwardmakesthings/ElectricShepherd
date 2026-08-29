import { tool } from "@opencode-ai/plugin";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    const timeoutMs = getNumberEnv("ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS", 60000);
    try {
      const output = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: ESHEPHERD_ROOT,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: childEnv,
      });
      const text = String(output?.stdout ?? "").trim() || String(output?.stderr ?? "").trim();
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const location = lines.find((line) => line.startsWith("mempalace://"));
      const jsonLine = lines.find((line) => line.startsWith("{") && line.endsWith("}"));
      let parsed: Record<string, unknown> = {};
      if (jsonLine) {
        try {
          const candidate = JSON.parse(jsonLine) as unknown;
          if (candidate && typeof candidate === "object") parsed = candidate as Record<string, unknown>;
        } catch {
          // keep parsed empty if line is malformed
        }
      }
      return JSON.stringify(
        {
          ok: true,
          sid,
          mode: args.mode || "(configured default)",
          status: typeof parsed.status === "string" ? parsed.status : undefined,
          wing: typeof parsed.wing === "string" ? parsed.wing : undefined,
          room: typeof parsed.room === "string" ? parsed.room : undefined,
          source_file: typeof parsed.source_file === "string" ? parsed.source_file : undefined,
          drawer_id: typeof parsed.drawer_id === "string" ? parsed.drawer_id : undefined,
          location,
          output: text.slice(-2000),
        },
        null,
        2,
      );
    } catch (err) {
      const e = err as {
        killed?: boolean;
        signal?: string | null;
        code?: string | number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const stderrTail = String(e?.stderr ?? "").trim().slice(-1500);
      const stdoutTail = String(e?.stdout ?? "").trim().slice(-500);

      // execFile sets killed+signal only when the timeout option fired.
      if (e?.killed && (e.signal === "SIGKILL" || e.signal === "SIGTERM")) {
        return JSON.stringify(
          {
            ok: false,
            sid,
            error:
              `capture_transcript: timed out after ${timeoutMs}ms and was killed (${e.signal}). ` +
              "Large sessions can legitimately take longer to export and duplicate-check. Raise " +
              "ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS if this session is unusually large. A timeout " +
              "during the duplicate-check step does not mean capture failed -- this session's " +
              "content may already be stored in MemPalace from an earlier capture.",
            timeoutMs,
            killedBySignal: e.signal,
          },
          null,
          2,
        );
      }

      if (e?.code === "ENOENT") {
        return JSON.stringify(
          {
            ok: false,
            sid,
            error:
              "capture_transcript: capture command or a required dependency was not found on PATH. " +
              "Check that the configured ESHEPHERD_SOURCE_CAPTURE_CMD script and its dependencies " +
              "(opencode, python3) are resolvable in the environment running this plugin.",
          },
          null,
          2,
        );
      }

      if (String(e?.message || "").toLowerCase().includes("maxbuffer")) {
        return JSON.stringify(
          {
            ok: false,
            sid,
            error: "capture_transcript: capture script output exceeded the internal buffer limit.",
          },
          null,
          2,
        );
      }

      return JSON.stringify(
        {
          ok: false,
          sid,
          error: `capture_transcript: capture script failed${e?.code !== undefined ? ` (exit code ${e.code})` : ""}.`,
          stderr: stderrTail || undefined,
          stdout: stdoutTail || undefined,
        },
        null,
        2,
      );
    }
  },
});
