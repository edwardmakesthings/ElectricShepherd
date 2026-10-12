import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveMemcorePath } from "../capability/memcore/mem-core-provenance.ts";
import { buildRefreshedMemcore } from "../capability/memcore/mem-core-refresh.ts";
import { loadMemcoreForDirectory } from "../capability/memcore/mem-core-loader.ts";
import { connectMemcoreReader, readMemcoreSources, type MemcoreReadClient } from "../core/memcore-sources.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { isFalsyFlag, tryWriteFile } from "./memory-pipeline/runtime-utils.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";

function parseOptions(argv: string[]): { scopeDir: string; wing?: string; room?: string; maxDrawers?: number; apply: boolean } {
  const values = new Map<string, string>();
  const flags = new Set(["--start-dir", "--wing", "--room", "--max-drawers"]);
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { apply = true; continue; }
    if (!flags.has(flag)) throw new Error(`Unknown refresh argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  return { scopeDir: resolveMemcorePath(values.get("--start-dir") || process.env.ESHEPHERD_PROJECT_ROOT || process.cwd()),
    wing: values.get("--wing"), room: values.get("--room"),
    maxDrawers: values.has("--max-drawers") ? Number(values.get("--max-drawers")) : undefined, apply };
}

/** Preview by default; apply replaces only the generated file for the requested scope. */
export async function refreshMemcore(argv: string[], clientOverride?: MemcoreReadClient) {
  const options = parseOptions(argv);
  const workspaceRoot = loadMemcoreForDirectory({ startDir: options.scopeDir }).workspaceRoot;
  const env = { ...process.env };
  loadRuntimeEnv({ scriptUrl: import.meta.url, env, cwd: workspaceRoot });
  const config = loadRuntimeConfig({ cwd: workspaceRoot, env });
  applyRuntimeConfigToEnv(env, config);
  const wing = options.wing || String(config.valuesByPath.memory?.projectWing || "").trim();
  if (!wing) throw new Error("No project memory wing configured");
  const roots = String(config.valuesByPath.memcore?.storeRoots || ".electric-shepherd/memory").split(",").map((root) => root.trim()).filter(Boolean);
  const relScope = relative(workspaceRoot, options.scopeDir);
  const filePath = resolve(workspaceRoot, roots[0], relScope, "memory.md");
  const client = clientOverride || await connectMemcoreReader(env);
  const snapshot = await readMemcoreSources(client, { wing, room: options.room, maxDrawers: options.maxDrawers });
  const render = config.valuesByPath.memcore?.render;
  const rendered = buildRefreshedMemcore(snapshot.sources, {
    wing, room: options.room, scopeDir: options.scopeDir, workspaceRoot,
    maxChars: Number(config.valuesByPath.memcore?.maxChars ?? 12000),
    maxFactsPerSection: Number(render?.maxFactsPerSection ?? 8),
    maxPendingReminders: Number(render?.maxPendingReminders ?? 3),
    maxDeadEnds: Number(render?.maxDeadEnds ?? 3),
    includeFacts: !isFalsyFlag(String(render?.includeFacts)),
    includePointers: !isFalsyFlag(String(render?.includePointers)),
    includePending: !isFalsyFlag(String(render?.includePending)),
    includeDeadEnds: !isFalsyFlag(String(render?.includeDeadEnds)),
  });
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
  const changed = previous !== rendered.markdown;
  if (options.apply && changed) tryWriteFile(filePath, rendered.markdown, process.pid);
  return { applied: options.apply, fileWritten: options.apply && changed, changed, filePath, wing,
    scopeDirectory: options.scopeDir, scannedDrawers: snapshot.scanned, eligibleSources: snapshot.sources.length,
    sourceDrawerIds: rendered.sourceDrawerIds, markdown: rendered.markdown };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node --experimental-strip-types src/scripts/run-mem-core-refresh.ts [--start-dir <scope>] [--wing <wing>] [--room <room>] [--max-drawers <n>] [--apply]\nPreview only unless --apply is supplied. No inference or palace writes.\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(await refreshMemcore(argv), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`[mem-core-refresh] ${String(error)}\n`); process.exitCode = 1; });
}
