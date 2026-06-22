import { createMemgraphClient, type JsonMap } from "../adapter/memgraph.ts";
import { expandScopedRetrieval, type RetrievalExpansionOptions } from "../adapter/retrieval-expansion.ts";

type MCPMessage = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type MCPResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

class MCPHttpClient {
  private url: string;
  private sessionId: string | null;
  private idCounter: number;

  constructor(url: string) {
    this.url = url;
    this.sessionId = null;
    this.idCounter = 0;
  }

  private nextID(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private parseResponsePayload(raw: string): MCPResponse {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Empty MCP response");
    }
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed) as MCPResponse;
    }

    let lastData: string | null = null;
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const clean = line.trim();
      if (clean.startsWith("data:")) {
        lastData = clean.slice(5).trim();
      }
    }
    if (!lastData) {
      throw new Error(`Unable to parse MCP response: ${trimmed.slice(0, 200)}`);
    }
    return JSON.parse(lastData) as MCPResponse;
  }

  private async post(payload: MCPMessage): Promise<MCPResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const sessionHeader = response.headers.get("Mcp-Session-Id");
    if (sessionHeader) {
      this.sessionId = sessionHeader;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return this.parseResponsePayload(text);
  }

  async initialize(): Promise<void> {
    const init: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "electric-shepherd-policy", version: "0.1.0" },
      },
    };
    const response = await this.post(init);
    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    const notify: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "notifications/initialized",
      params: {},
    };
    await this.post(notify).catch(() => {
      // Some servers reject notification RPC-style responses; safe to ignore.
    });
  }

  async callTool(name: string, args?: JsonMap): Promise<JsonMap> {
    const payload: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "tools/call",
      params: { name, arguments: args || {} },
    };

    const response = await this.post(payload);
    if (response.error) {
      throw new Error(`Tool call failed (${name}): ${response.error.message}`);
    }

    const content = ((response.result || {}).content || []) as Array<Record<string, unknown>>;
    // MemPalace tools generally return JSON in text parts.
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          return JSON.parse(item.text) as JsonMap;
        } catch {
          // Not JSON text; continue searching or return envelope below.
        }
      }
    }

    // Fallback: pass raw result object through as a JsonMap.
    return (response.result || {}) as JsonMap;
  }
}

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
  const mcpURL = process.env.MEMPALACE_MCP_URL || "http://localhost:8093/mcp";
  const toolPrefix = process.env.MEMGRAPH_TOOL_PREFIX;
  const args = parseArgs(process.argv.slice(2));

  const mcp = new MCPHttpClient(mcpURL);
  await mcp.initialize();

  const client = createMemgraphClient({
    callTool: (name, toolArgs) => mcp.callTool(name, toolArgs),
    toolPrefix,
  });

  const result = await expandScopedRetrieval(client, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[policy-cycle] ${String(err)}\n`);
  process.exit(1);
});
