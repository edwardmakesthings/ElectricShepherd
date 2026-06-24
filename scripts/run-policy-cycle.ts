import { createMemgraphClient } from "../adapter/memgraph.ts";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts";
import { expandScopedRetrieval, type RetrievalExpansionOptions } from "../adapter/retrieval-expansion.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";

const runtimeProcess = (globalThis as unknown as {
  process: {
    argv: string[];
    env: Record<string, string | undefined>;
    stdout: { write: (text: string) => void };
    stderr: { write: (text: string) => void };
    exit: (code: number) => never;
  };
}).process;

function parseArgs(argv: string[]): RetrievalExpansionOptions {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
    return undefined;
  };

  const requiredQuery = get("--query");
  const requiredScopeRoom = get("--scope-room");
  if (!requiredQuery || !requiredScopeRoom) {
    throw new Error("Usage: node scripts/run-policy-cycle.ts --query <text> --scope-room <room> [options]");
  }

  const labelsRaw = get("--labels");
  const labels = labelsRaw
    ? labelsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const topN = Number(get("--top-n") || "12");
  const limit = Number(get("--limit") || "50");
  const maxDepth = Number(get("--max-depth") || "20");
  const expansionDepth = Number(get("--expansion-depth") || "2");
  const seedSearchLimit = Number(get("--seed-search-limit") || "10");

  return {
    query: requiredQuery,
    scope_room: requiredScopeRoom,
    scope_wing: get("--scope-wing"),
    wing: get("--wing"),
    room: get("--room"),
    match_labels: labels,
    match_mode: (get("--match-mode") as "any" | "all" | undefined) || "any",
    labeled_only: (get("--labeled-only") || "false").toLowerCase() === "true",
    include_merged: (get("--include-merged") || "false").toLowerCase() === "true",
    max_depth: maxDepth,
    limit,
    offset: Number(get("--offset") || "0"),
    seed_search_limit: seedSearchLimit,
    expansion_depth: expansionDepth,
    top_n: topN,
    always_include_labels: ["pinned"],
  };
}

async function main(): Promise<void> {
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: runtimeProcess.env });

  const mcpURL = runtimeProcess.env.MEMPALACE_MCP_URL || "http://localhost:8093/mcp";
  const toolPrefix = runtimeProcess.env.MEMGRAPH_TOOL_PREFIX;
  const mcpHeaders = resolveMCPHeadersFromEnv(runtimeProcess.env);
  const args = parseArgs(runtimeProcess.argv.slice(2));

  const mcp = new MCPHttpClient(mcpURL, mcpHeaders, { clientName: "electric-shepherd-policy" });
  await mcp.initialize();

  const client = createMemgraphClient({
    callTool: (name, toolArgs) => mcp.callTool(name, toolArgs),
    toolPrefix,
  });

  const result = await expandScopedRetrieval(client, args);
  runtimeProcess.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  runtimeProcess.stderr.write(`[policy-cycle] ${String(err)}\n`);
  runtimeProcess.exit(1);
});
