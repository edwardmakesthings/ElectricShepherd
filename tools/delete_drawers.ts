import { tool } from "@opencode-ai/plugin";
// Substrate transport is constructed ONLY through the core/ seam (Check A2). The
// raw MCPHttpClient and header resolver live in core/mcp-transport.ts.
import { createSubstrateClient } from "../core/substrate-client.ts";
import { applyRuntimeConfigToEnv, DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import {
  collectDrawerIDsByScope,
  classifyErrorKind,
  normalizeIDs,
  normalizeOptional,
  normalizeWingList,
  parseIDsFromFile,
  normalizeDryRunArg,
  resolveMemPalaceMCPUrl,
  runDrawerBatch,
  summarizeFailures,
  type BatchResultRow,
} from "../core/substrate.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

type DeleteScriptRow = BatchResultRow & {
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
  source_wing?: string;
  source_wings?: string[];
  source_room?: string;
  [key: string]: unknown;
};


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
    source_wing: tool.schema
      .string()
      .optional()
      .describe("Source wing to delete from (can be used with source_room)."),
    source_wings: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Source wings to delete from (union of all matched drawers)."),
    source_room: tool.schema
      .string()
      .optional()
      .describe("Optional source room filter when selecting by source_wing/source_wings."),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("Preview without writing (default true). Pass false only after explicit operator confirmation."),
    fail_fast: tool.schema
      .boolean()
      .default(false)
      .describe("When true, stop on first failed delete."),
    tool_prefix: tool.schema
      .string()
      .optional()
      .describe("Optional MCP tool prefix override (example: mygateway_<prefix>)."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({
      cwd,
      env: process.env,
    });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const sourceWing = normalizeOptional(args.source_wing);
    const sourceWings = normalizeWingList(args.source_wings);
    const sourceRoom = normalizeOptional(args.source_room);

    const ids = new Set<string>();
    for (const id of normalizeIDs(args.drawer_ids)) ids.add(id);

    const idsFile = normalizeOptional(args.ids_file);
    if (idsFile) {
      for (const id of parseIDsFromFile(idsFile, cwd)) ids.add(id);
    }

    const scopeWings = new Set<string>(sourceWings);
    if (sourceWing) scopeWings.add(sourceWing);
    const useScope = scopeWings.size > 0;
    if (!useScope && ids.size === 0) {
      throw new Error("Provide either drawer_ids/ids_file or source_wing/source_wings.");
    }
    if (useScope && ids.size > 0) {
      throw new Error("Use either drawer_ids/ids_file OR source_wing/source_wings/source_room, not both.");
    }

    const toolPrefix = String(args.tool_prefix || runtimeConfig.valuesByPath.mcp?.toolPrefix || DEFAULT_MCP_TOOL_PREFIX).trim();
    const listTool = `${toolPrefix}list_drawers`;
    const deleteTool = `${toolPrefix}delete_drawer`;

    let drawerIDs = [...ids];

    try {
      // Endpoint: direct MemPalace server by default. The shared docker/.env sets
      // MEMPALACE_MCP_URL to the LiteLLM gateway, which enforces per-key tool
      // allowlists and can deny delete_drawer. ESHEPHERD_DELETE_MCP_URL overrides.
      const mcpURL = resolveMemPalaceMCPUrl(process.env, "ESHEPHERD_DELETE_MCP_URL", String(runtimeConfig.valuesByPath.mcp?.url || DEFAULT_MCP_URL));
      // Construct through the core/ seam (Check A2): it owns transport + initialize
      // and resolves headers for the effective URL (loopback stays unauthenticated).
      const { client: mcp } = await createSubstrateClient({
        env: process.env,
        clientName: "electric-shepherd-delete-drawers-tool",
        urlOverride: mcpURL,
        requestTimeoutMs: Number(runtimeConfig.valuesByPath.mcp?.requestTimeoutMs || "60000"),
        maxRetries: Number(runtimeConfig.valuesByPath.mcp?.maxRetries || "2"),
        retryBackoffMs: Number(runtimeConfig.valuesByPath.mcp?.retryBackoffMs || "800"),
        retryMaxBackoffMs: Number(runtimeConfig.valuesByPath.mcp?.retryMaxBackoffMs || "8000"),
      });

      if (useScope) {
        const scoped = new Set<string>();
        for (const wing of scopeWings) {
          for (
            const id of await collectDrawerIDsByScope(
              (payload) => mcp.callTool(listTool, payload) as Promise<Record<string, unknown>>,
              wing,
              sourceRoom,
            )
          ) {
            scoped.add(id);
          }
        }
        drawerIDs = [...scoped];
      }

      const dryRun = normalizeDryRunArg(args);

      if (drawerIDs.length === 0) {
        return JSON.stringify(
          {
            ok: true,
            dry_run: dryRun,
            requested: 0,
            source_wing: sourceWing || undefined,
            source_wings: useScope ? [...scopeWings] : undefined,
            source_room: sourceRoom || undefined,
            message: "No drawers matched the request.",
          },
          null,
          2,
        );
      }

      if (dryRun) {
        return JSON.stringify(
          {
            ok: true,
            dry_run: true,
            requested: drawerIDs.length,
            source_wing: sourceWing || undefined,
            source_wings: useScope ? [...scopeWings] : undefined,
            source_room: sourceRoom || undefined,
            drawer_ids: drawerIDs,
          },
          null,
          2,
        );
      }

      const failFast = Boolean(args.fail_fast);

      let chunksDeletedTotal = 0;
      const { results, failed } = await runDrawerBatch<DeleteScriptRow & BatchResultRow>(
        drawerIDs,
        failFast,
        async (drawerID) => {
          const res = (await mcp.callTool(deleteTool, { drawer_id: drawerID })) as Record<string, unknown>;
          if (res && res.success === true) {
            const chunksDeleted = Number(res.chunks_deleted ?? 0);
            if (Number.isFinite(chunksDeleted)) chunksDeletedTotal += chunksDeleted;
            return {
              drawer_id: drawerID,
              ok: true,
              chunks_deleted: Number.isFinite(chunksDeleted) ? chunksDeleted : 0,
            };
          }
          const errorText = String((res && res.error) || "delete_drawer returned success=false");
          return {
            drawer_id: drawerID,
            ok: false,
            error: errorText,
            error_kind: classifyErrorKind(errorText),
          };
        },
      );

      const payload: DeleteScriptResult = {
        ok: failed === 0,
        dry_run: false,
        tool: deleteTool,
        requested: drawerIDs.length,
        attempted: results.length,
        deleted: results.length - failed,
        chunks_deleted_total: chunksDeletedTotal,
        failed,
        source_wing: sourceWing || undefined,
        source_wings: useScope ? [...scopeWings] : undefined,
        source_room: sourceRoom || undefined,
        results,
      };

      if (failed > 0) {
        const summary = summarizeFailures(payload.results || [], payload.error || "", "delete_drawers failed");
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
        source_wing: sourceWing || undefined,
        source_wings: useScope ? [...scopeWings] : undefined,
        source_room: sourceRoom || undefined,
        error: errorText,
        error_kind: kind,
        failure_kinds: { [kind]: 1 },
      };
      const summary = summarizeFailures(payload.results || [], payload.error || "", "delete_drawers failed");
      return JSON.stringify({ ...payload, ...summary }, null, 2);
    }
  },
});
