import { createMemgraphClient } from "../adapter/memgraph.ts";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import {
  expandScopedRetrieval,
  type RetrievalExpansionOptions,
  type RetrievalIntent,
} from "../adapter/retrieval-expansion.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";

/**
 * Phase 7 usability bridge: build an operator-ready `record_outcome` proposal
 * payload from a policy-cycle result. STRICTLY INFORMATIONAL — this function and
 * the script that calls it perform NO writes (no record_outcome, no kg_add). The
 * operator copies the payload, sets `outcome` to their judgment, and invokes the
 * human-authoritative `record_outcome` tool themselves (dry-run first, then apply).
 */

const OUTCOME_VALUES = ["accept", "revise", "failed", "unused"] as const;

/** Short deterministic hash of a string (FNV-1a, 32-bit) — stable across runs. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic-ish cycle id: timestamp + short query hash. */
function makeCycleRef(query: string, now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `policy-${ts}-${shortHash(query)}`;
}

/**
 * Phase 9 usability bridge: surface the explicit ruled-out marker on dead-end nodes in
 * the operator-facing output. A node with a `ruled_out` field is a negative-knowledge
 * synthesis (an approach that was tried and failed or considered and rejected); this
 * renders it with the hard "[RULED OUT ...]" label so it can never read as a suggestion.
 * STRICTLY INFORMATIONAL — no writes, no ranking change; the node's score is untouched.
 */
export function buildRuledOutNotes(
  selectedNodes: Array<{ node_id: string; desc?: string; ruled_out?: { polarity: string; statements: string[] } }>,
): Array<{ node_id: string; label: string; note: string }> {
  const out: Array<{ node_id: string; label: string; note: string }> = [];
  for (const node of selectedNodes || []) {
    if (!node.ruled_out || !Array.isArray(node.ruled_out.statements) || node.ruled_out.statements.length === 0) continue;
    const polarityLabel = node.ruled_out.polarity === "considered-rejected" ? "considered and rejected" : "tried and failed";
    const statements = node.ruled_out.statements.join("; ");
    out.push({
      node_id: node.node_id,
      label: `[RULED OUT — ${polarityLabel}]`,
      note: `${statements}${node.desc ? ` — ${node.desc}` : ""}. Do NOT re-propose this approach.`,
    });
  }
  return out;
}

export function buildOutcomeProposal(
  selectedNodes: Array<{ node_id: string }>,
  query: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const nodeIds = [...new Set(selectedNodes.map((n) => n.node_id).filter(Boolean))];
  return {
    tool: "record_outcome",
    payload: {
      node_ids: nodeIds,
      outcome: null, // operator must set one of the allowed values below before calling
      cycle_ref: makeCycleRef(query, now),
      dry_run: true,
    },
    instructions: {
      allowed_outcomes: [...OUTCOME_VALUES],
      note: "Set `outcome` to your judgment (accept | revise | failed | unused). Call record_outcome with dry_run:true first; re-run with dry_run:false only after your explicit confirmation. This proposal is informational — the policy cycle itself never writes outcome edges.",
    },
  };
}

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

  const intentRaw = get("--intent");
  let intent: RetrievalIntent | undefined;
  if (intentRaw !== undefined) {
    if (intentRaw === "factual" || intentRaw === "historical" || intentRaw === "procedural") {
      intent = intentRaw;
    } else {
      throw new Error(`Invalid --intent "${intentRaw}": expected factual, historical, or procedural`);
    }
  }

  // Phase 3 close-out: explicit opt-in for direct doc admission into the ranked pool.
  // Factual intent already implies it; this flag matters for non-factual intents.
  const includeDocs = argv.includes("--include-docs");

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
    intent,
    include_docs: includeDocs || undefined,
  };
}

async function main(): Promise<void> {
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: runtimeProcess.env });
  const runtimeConfig = loadRuntimeConfig({
    cwd: runtimeProcess.cwd(),
    env: runtimeProcess.env,
  });
  applyRuntimeConfigToEnv(runtimeProcess.env, runtimeConfig);

  const mcpURL = runtimeProcess.env.MEMPALACE_MCP_URL || "http://localhost:8093/mcp";
  const toolPrefix = runtimeProcess.env.MEMGRAPH_TOOL_PREFIX;
  const mcpHeaders = resolveMCPHeadersFromEnv(runtimeProcess.env);
  const args = parseArgs(runtimeProcess.argv.slice(2));

  const mcp = new MCPHttpClient(mcpURL, mcpHeaders, {
    clientName: "electric-shepherd-policy",
    requestTimeoutMs: Number(runtimeProcess.env.ESHEPHERD_MCP_REQUEST_TIMEOUT_MS || "60000"),
    maxRetries: Number(runtimeProcess.env.ESHEPHERD_MCP_MAX_RETRIES || "2"),
    retryBackoffMs: Number(runtimeProcess.env.ESHEPHERD_MCP_RETRY_BACKOFF_MS || "800"),
  });
  await mcp.initialize();

  const client = createMemgraphClient({
    callTool: (name, toolArgs) => mcp.callTool(name, toolArgs),
    toolPrefix,
  });

  const result = await expandScopedRetrieval(client, args);

  // Phase 7 usability bridge: emit an operator-ready record_outcome proposal.
  // Informational only — no write path here; the script never calls record_outcome/kg_add.
  const output = {
    ...result,
    outcome_proposal: buildOutcomeProposal(result.selected_nodes ?? [], args.query),
    // Phase 9 usability bridge: surface explicit ruled-out labels on dead-end nodes so
    // an unlabelled dead end can never read as a suggestion in the operator-facing output.
    ruled_out_notes: buildRuledOutNotes(result.selected_nodes ?? []),
  };

  runtimeProcess.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

// Only run when executed directly (not imported by tests).
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const isDirectRun = (() => {
  try {
    const entry = runtimeProcess.argv[1] ? resolve(runtimeProcess.argv[1]) : "";
    return entry === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    runtimeProcess.stderr.write(`[policy-cycle] ${String(err)}\n`);
    runtimeProcess.exit(1);
  });
}
