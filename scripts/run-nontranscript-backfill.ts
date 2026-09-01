import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isTranscriptLikeRoom, parseTaxonomy } from "../adapter/palace-tools.ts";
// Substrate transport is constructed ONLY through the core/ seam (Check A2).
import { createSubstrateClient } from "../core/substrate-client.ts";
import { DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";

const runtimeProcess = (globalThis as unknown as {
  process: {
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: () => string;
    stdout: { write: (text: string) => void };
    stderr: { write: (text: string) => void };
    exit: (code: number) => never;
  };
}).process;

type ParsedArgs = {
  wing: string;
  rooms: string[];
  excludeRooms: string[];
  maxRooms: number;
  includeTranscriptLike: boolean;
  apply: boolean;
  applyMerges: boolean;
  batchSize: number;
  worklistLimit: number;
  query: string;
};

function getArg(argv: string[], flag: string): string {
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return String(argv[at + 1] || "").trim();
  return "";
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseCSV(value: string): string[] {
  if (!value.trim()) return [];
  return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

function parseArgs(argv: string[], runtimeConfig: ReturnType<typeof loadRuntimeConfig>): ParsedArgs {
  const wing =
    getArg(argv, "--wing") ||
    String(runtimeConfig.valuesByPath.memory?.projectWing || "").trim() ||
    String(runtimeConfig.valuesByPath.sourceCapture?.wing || "").trim();
  if (!wing) throw new Error("run-nontranscript-backfill: --wing is required (or set memory.projectWing in config)");

  return {
    wing,
    rooms: parseCSV(getArg(argv, "--rooms")),
    excludeRooms: parseCSV(getArg(argv, "--exclude-rooms")),
    maxRooms: Math.max(1, Number(getArg(argv, "--max-rooms") || "40")),
    includeTranscriptLike: hasFlag(argv, "--include-transcript-like"),
    apply: hasFlag(argv, "--apply"),
    applyMerges: hasFlag(argv, "--apply-merges"),
    // Default 1 to match the consolidation script: one item per subagent run.
    batchSize: Math.max(1, Number(getArg(argv, "--batch-size") || "1")),
    worklistLimit: Math.max(1, Number(getArg(argv, "--worklist-limit") || "200")),
    query: getArg(argv, "--query") || "non-transcript memory consolidation",
  };
}

async function resolveRooms(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  runtimeConfig: ReturnType<typeof loadRuntimeConfig>,
): Promise<string[]> {
  if (args.rooms.length > 0) return args.rooms;

  const mcpURL = String(runtimeConfig.valuesByPath.mcp?.url || "").trim() || DEFAULT_MCP_URL;
  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  // Construct through the core/ seam (Check A2): owns transport + initialize and
  // resolves headers for the effective URL (loopback stays unauthenticated).
  const { client } = await createSubstrateClient({
    env,
    clientName: "electric-shepherd-nontranscript-backfill",
    urlOverride: mcpURL,
  });

  const taxonomyRaw = await client.callTool(`${toolPrefix}get_taxonomy`, {});
  const wingEntry = parseTaxonomy(taxonomyRaw).find((entry) => entry.wing === args.wing);
  if (!wingEntry) return [];

  let rooms = wingEntry.rooms.map((entry) => entry.room);
  if (!args.includeTranscriptLike) rooms = rooms.filter((room) => !isTranscriptLikeRoom(room));
  if (args.excludeRooms.length > 0) {
    const excluded = new Set(args.excludeRooms);
    rooms = rooms.filter((room) => !excluded.has(room));
  }
  return rooms.slice(0, args.maxRooms);
}

async function runOneRoom(scriptPath: string, repoRoot: string, args: ParsedArgs, room: string): Promise<Record<string, unknown>> {
  const commandArgs = [
    "--experimental-strip-types",
    scriptPath,
    "--query",
    args.query,
    "--wing",
    args.wing,
    "--room",
    room,
    "--all",
    "--batch-size",
    String(args.batchSize),
    "--worklist-limit",
    String(args.worklistLimit),
  ];
  if (args.apply) commandArgs.push("--apply");
  if (args.applyMerges) commandArgs.push("--apply-merges");

  return await new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("node", commandArgs, { cwd: repoRoot, env: runtimeProcess.env });

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      runtimeProcess.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      runtimeProcess.stderr.write(text);
    });

    child.on("close", (code) => {
      resolvePromise({ room, ok: code === 0, exit_code: code ?? -1, stdout_bytes: stdout.length, stderr_bytes: stderr.length });
    });
    child.on("error", (err) => {
      resolvePromise({ room, ok: false, exit_code: -1, error: String(err) });
    });
  });
}

async function main(): Promise<void> {
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: runtimeProcess.env });
  const runtimeConfig = loadRuntimeConfig({ cwd: runtimeProcess.cwd(), env: runtimeProcess.env });

  const argv = runtimeProcess.argv.slice(2);
  const args = parseArgs(argv, runtimeConfig);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const consolidationScript = resolve(repoRoot, "scripts", "run-memory-consolidation-and-validation.ts");

  const rooms = await resolveRooms(args, runtimeProcess.env, runtimeConfig);
  if (rooms.length === 0) {
    runtimeProcess.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          wing: args.wing,
          rooms_considered: 0,
          note: "No eligible rooms found after transcript-like/exclusion filtering.",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  runtimeProcess.stdout.write(
    `${JSON.stringify(
      {
        start: true,
        wing: args.wing,
        rooms: rooms.length,
        apply: args.apply,
        apply_merges: args.applyMerges,
        include_transcript_like: args.includeTranscriptLike,
        selected_rooms: rooms,
      },
      null,
      2,
    )}\n`,
  );

  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < rooms.length; i += 1) {
    const room = rooms[i];
    runtimeProcess.stdout.write(`[nontranscript-backfill] [${i + 1}/${rooms.length}] room=${room}\n`);
    const result = await runOneRoom(consolidationScript, repoRoot, args, room);
    results.push(result);
  }

  const failed = results.filter((row) => row.ok === false).length;
  runtimeProcess.stdout.write(
    `${JSON.stringify(
      {
        ok: failed === 0,
        wing: args.wing,
        rooms_considered: rooms.length,
        failed,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  runtimeProcess.stderr.write(`[run-nontranscript-backfill] ${String(err)}\n`);
  runtimeProcess.exit(1);
});
