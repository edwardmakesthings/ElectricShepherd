import { tool } from "@opencode-ai/plugin";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { readFileSync } from "node:fs";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { resolve } from "node:path";

declare const process: {
  env: Record<string, string | undefined>;
};

function normalizeIDs(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

type DeleteScriptRow = {
  drawer_id?: string;
  ok?: boolean;
  chunks_deleted?: number;
  error?: string;
  error_kind?: string;
};

type DeleteScriptResult = {
  ok?: boolean;
  dry_run?: boolean;
  tool?: string;
  requested?: number;
  attempted?: number;
  deleted?: number;
  chunks_deleted_total?: number;
  failed?: number;
  fatal?: boolean;
  error?: string;
  error_kind?: string;
  results?: DeleteScriptRow[];
  failure_kinds?: Record<string, number>;
  [key: string]: unknown;
};

function parseIDsFromFile(path: string, cwd: string): string[] {
  const absolute = resolve(cwd, path);
  const raw = readFileSync(absolute, "utf8").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`ids file is not a JSON array: ${path}`);
    return parsed.map((v) => String(v || "").trim()).filter(Boolean);
  }
  return raw
    .split(/[\r\n,]+/)
    .map((s: string) => s.trim())
    .filter(Boolean);
}

function classifyErrorKind(error: string): string {
  const text = String(error || "").toLowerCase();
  if (!text) return "unknown";
  if (
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("missing") ||
    text.includes("no such")
  ) {
    return "not_found";
  }
  if (
    text.includes("forbidden") ||
    text.includes("permission") ||
    text.includes("denied") ||
    text.includes("unauthorized") ||
    text.includes("not authorized")
  ) {
    return "permission_denied";
  }
  if (
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("timeout")
  ) {
    return "network";
  }
  return "unknown";
}

function summarizeFailures(result: DeleteScriptResult): {
  failure_summary: string;
  hint?: string;
  failure_kinds: Record<string, number>;
} {
  const rows = Array.isArray(result.results) ? result.results.filter((row) => row && row.ok === false) : [];
  const kinds: Record<string, number> = { ...(result.failure_kinds || {}) };
  const topLevelError = String(result.error || "").trim();

  for (const row of rows) {
    const kind = String(row.error_kind || classifyErrorKind(String(row.error || "")) || "unknown");
    kinds[kind] = (kinds[kind] || 0) + 1;
  }

  if (topLevelError) {
    const topLevelKind = classifyErrorKind(topLevelError);
    kinds[topLevelKind] = (kinds[topLevelKind] || 0) + 1;
  }

  const preview = rows.slice(0, 3).map((row) => {
    const id = String(row.drawer_id || "(unknown)");
    const kind = String(row.error_kind || classifyErrorKind(String(row.error || "")) || "unknown");
    const err = String(row.error || "unknown error");
    return `${id}: ${kind} - ${err}`;
  });

  const extra = rows.length > 3 ? ` (+${rows.length - 3} more)` : "";
  const failureSummary = rows.length > 0 ? preview.join("; ") + extra : (topLevelError || "delete_drawers failed");
  let hint = "";
  if ((kinds.not_found || 0) > 0) {
    hint = "One or more drawer IDs were not found in the target MemPalace.";
  } else if ((kinds.permission_denied || 0) > 0) {
    hint = "Deletion was denied by policy or permissions on the selected MCP endpoint.";
  } else if ((kinds.network || 0) > 0) {
    hint = "The delete request could not reach the MCP endpoint reliably.";
  }

  return {
    failure_summary: failureSummary,
    hint: hint || undefined,
    failure_kinds: kinds,
  };
}

export default tool({
  description:
    "Delete MemPalace drawers by ID with structured failure reporting.",
  args: {
    drawer_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Drawer IDs to delete."),
    ids_file: tool.schema
      .string()
      .optional()
      .describe("Path to a file containing drawer IDs (newline/csv/json array)."),
    dry_run: tool.schema
      .boolean()
      .default(false)
      .describe("When true, prints planned deletions without deleting."),
    fail_fast: tool.schema
      .boolean()
      .default(false)
      .describe("When true, stop on first failed delete."),
    tool_prefix: tool.schema
      .string()
      .optional()
      .describe("Optional MCP tool prefix override (example: mygateway_mempalace_)."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({
      cwd,
      env: process.env,
    });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const ids = new Set<string>();
    for (const id of normalizeIDs(args.drawer_ids)) ids.add(id);

    const idsFile = String(args.ids_file || "").trim();
    if (idsFile) {
      for (const id of parseIDsFromFile(idsFile, cwd)) ids.add(id);
    }

    const drawerIDs = [...ids];
    if (drawerIDs.length === 0) {
      throw new Error("Provide either drawer_ids or ids_file.");
    }

    if (args.dry_run) {
      return JSON.stringify(
        { ok: true, dry_run: true, requested: drawerIDs.length, drawer_ids: drawerIDs },
        null,
        2,
      );
    }

    const toolPrefix = String(args.tool_prefix || process.env.MEMGRAPH_TOOL_PREFIX || "mempalace_").trim();
    const failFast = Boolean(args.fail_fast);
    const deleteTool = `${toolPrefix}delete_drawer`;

    try {
      // Endpoint: direct MemPalace server by default. The shared docker/.env sets
      // MEMPALACE_MCP_URL to the LiteLLM gateway, which enforces per-key tool
      // allowlists and can deny delete_drawer. ESHEPHERD_DELETE_MCP_URL overrides.
      const envUrl = (process.env.MEMPALACE_MCP_URL || "").trim();
      const isGateway = /\/toolset\//.test(envUrl) || /:4000\//.test(envUrl);
      const mcpURL =
        (process.env.ESHEPHERD_DELETE_MCP_URL || "").trim() ||
        (envUrl && !isGateway ? envUrl : "http://localhost:8093/mcp");

      const headers = mcpURL.includes("localhost:8093") ? {} : resolveMCPHeadersFromEnv(process.env);
      const mcp = new MCPHttpClient(mcpURL, headers, {
        clientName: "electric-shepherd-delete-drawers-tool",
      });
      await mcp.initialize();

      const results: DeleteScriptRow[] = [];
      let failed = 0;
      let chunksDeletedTotal = 0;
      for (const drawerID of drawerIDs) {
        try {
          const res = (await mcp.callTool(deleteTool, { drawer_id: drawerID })) as Record<string, unknown>;
          if (res && res.success === true) {
            const chunksDeleted = Number(res.chunks_deleted ?? 0);
            results.push({
              drawer_id: drawerID,
              ok: true,
              chunks_deleted: Number.isFinite(chunksDeleted) ? chunksDeleted : 0,
              error_kind: undefined,
            });
            if (Number.isFinite(chunksDeleted)) {
              chunksDeletedTotal += chunksDeleted;
            }
          } else {
            failed += 1;
            const errorText = String((res && res.error) || "delete_drawer returned success=false");
            results.push({
              drawer_id: drawerID,
              ok: false,
              error: errorText,
              error_kind: classifyErrorKind(errorText),
            });
            if (failFast) break;
          }
        } catch (err) {
          failed += 1;
          const errorText = String(err);
          results.push({
            drawer_id: drawerID,
            ok: false,
            error: errorText,
            error_kind: classifyErrorKind(errorText),
          });
          if (failFast) break;
        }
      }

      const payload: DeleteScriptResult = {
        ok: failed === 0,
        dry_run: false,
        tool: deleteTool,
        requested: drawerIDs.length,
        attempted: results.length,
        deleted: results.length - failed,
        chunks_deleted_total: chunksDeletedTotal,
        failed,
        results,
      };

      if (failed > 0) {
        const summary = summarizeFailures(payload);
        return JSON.stringify({ ...payload, ...summary }, null, 2);
      }

      return JSON.stringify(payload, null, 2);
    } catch (err) {
      const errorText = String(err);
      const kind = classifyErrorKind(errorText);
      const payload: DeleteScriptResult = {
        ok: false,
        dry_run: false,
        fatal: true,
        error: errorText,
        error_kind: kind,
        failure_kinds: { [kind]: 1 },
      };
      const summary = summarizeFailures(payload);
      return JSON.stringify({ ...payload, ...summary }, null, 2);
    }
  },
});
