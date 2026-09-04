/**
 * Native coordination (lease acquire/release) + MCP discovery for the consolidation pipeline.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asObject, asString } from "./cli-options.ts";
import { parseEmbeddedJSON } from "./subagent.ts";

const NATIVE_COORD_HELPER_PATH = fileURLToPath(new URL("../native-consolidation-coord.py", import.meta.url));

export type NativeCoordAcquireResult = {
  state: "acquired" | "held" | "unavailable";
  reason?: string;
};

export type DiscoveredMCPConfig = {
  url: string;
  bearerToken?: string;
};

export function runNativeCoordinator(
  args: string[],
  env: Record<string, string | undefined>,
  options?: { pythonBin?: string },
): Record<string, unknown> | undefined {
  if (!existsSync(NATIVE_COORD_HELPER_PATH)) return undefined;

  const pythonBin = String(options?.pythonBin || "python").trim() || "python";
  try {
    const raw = execFileSync(pythonBin, [NATIVE_COORD_HELPER_PATH, ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const parsed = asObject(parseEmbeddedJSON(raw));
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function tryAcquireNativeConsolidationLease(args: {
  projectRoot: string;
  runId: string;
  staleMs: number;
  env: Record<string, string | undefined>;
  nativeCoordinatorPath?: string;
  pythonBin?: string;
}): NativeCoordAcquireResult {
  const cmdArgs = [
    "acquire",
    "--project-root",
    args.projectRoot,
    "--owner-pid",
    String(process.pid),
    "--run-id",
    args.runId,
    "--stale-ms",
    String(Math.max(1, Math.floor(args.staleMs))),
  ];

  const queuePath = String(args.nativeCoordinatorPath || "").trim();
  if (queuePath) {
    cmdArgs.push("--queue-path", queuePath);
  }

  const payload = runNativeCoordinator(cmdArgs, args.env, { pythonBin: args.pythonBin });
  if (!payload) {
    return { state: "unavailable" };
  }
  if (payload.acquired === true) {
    return { state: "acquired" };
  }
  if (payload.acquired === false) {
    return {
      state: "held",
      reason: asString(payload.reason || payload.holder_run_id || payload.holder_pid) || "held",
    };
  }
  return { state: "unavailable" };
}

export function releaseNativeConsolidationLease(args: {
  projectRoot: string;
  runId: string;
  env: Record<string, string | undefined>;
  nativeCoordinatorPath?: string;
  pythonBin?: string;
}): void {
  const cmdArgs = [
    "release",
    "--project-root",
    args.projectRoot,
    "--owner-pid",
    String(process.pid),
    "--run-id",
    args.runId,
  ];

  const queuePath = String(args.nativeCoordinatorPath || "").trim();
  if (queuePath) {
    cmdArgs.push("--queue-path", queuePath);
  }

  runNativeCoordinator(cmdArgs, args.env, { pythonBin: args.pythonBin });
}

export function discoverLiveMCPConfig(env: Record<string, string | undefined>, pythonBin: string): DiscoveredMCPConfig | undefined {
  if ((env.MEMPALACE_MCP_URL || "").trim()) return undefined;

  const resolvedPythonBin = String(pythonBin || "python").trim() || "python";
  const script = [
    "import json, os",
    "try:",
    "    from mempalace.config import MempalaceConfig",
    "    from mempalace.server_registry import read_live_serverinfo, server_token_path",
    "except Exception:",
    "    print('{}')",
    "    raise SystemExit(0)",
    "palace_path = (os.environ.get('MEMPALACE_PALACE_PATH') or MempalaceConfig().palace_path or '').strip()",
    "if not palace_path:",
    "    print('{}')",
    "    raise SystemExit(0)",
    "info = read_live_serverinfo(palace_path)",
    "if not info:",
    "    print('{}')",
    "    raise SystemExit(0)",
    "scheme = str(info.get('scheme') or 'http').strip() or 'http'",
    "host = str(info.get('host') or '127.0.0.1').strip() or '127.0.0.1'",
    "port = info.get('port')",
    "if isinstance(port, str) and port.strip().isdigit():",
    "    port = int(port.strip())",
    "if not isinstance(port, int):",
    "    print('{}')",
    "    raise SystemExit(0)",
    "token = ''",
    "try:",
    "    token_file = server_token_path(palace_path)",
    "    if token_file.exists():",
    "        token = token_file.read_text(encoding='utf-8').strip()",
    "except Exception:",
    "    token = ''",
    "print(json.dumps({'url': f'{scheme}://{host}:{port}/mcp', 'bearer_token': token}))",
  ].join("\n");

  try {
    const raw = execFileSync(resolvedPythonBin, ["-c", script], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const parsed = asObject(parseEmbeddedJSON(raw));
    const url = asString(parsed.url).trim();
    if (!url) return undefined;
    const bearerToken = asString(parsed.bearer_token).trim();
    return bearerToken ? { url, bearerToken } : { url };
  } catch {
    return undefined;
  }
}
