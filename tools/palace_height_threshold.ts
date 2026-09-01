import { tool } from "@opencode-ai/plugin";
import { asObject, createPalaceClient, parseRows } from "../adapter/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export default tool({
  description:
    "Return drawers whose synthesis DAG height is at least min_height. Can scope by wing, room, or explicit drawer IDs.",
  args: {
    min_height: tool.schema.number().describe("Minimum height to include (inclusive)."),
    wing: tool.schema.string().optional().describe("Wing scope for list_drawers enumeration."),
    room: tool.schema.string().optional().describe("Optional room scope (requires wing)."),
    drawer_ids: tool.schema.array(tool.schema.string()).optional().describe("Explicit drawer IDs to evaluate."),
    limit: tool.schema.number().optional().describe("Max drawers to evaluate from list scope (default 200)."),
    include_zero: tool.schema.boolean().optional().describe("Include zero-height rows in evaluated output (default false)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const minHeight = Math.max(0, Math.floor(Number(args.min_height)));
    if (!Number.isFinite(minHeight)) throw new Error("palace_height_threshold: min_height must be a finite number");

    const wing = String(args.wing || "").trim();
    const room = String(args.room || "").trim();
    if (room && !wing) throw new Error("palace_height_threshold: room requires wing");

    const explicitIds = uniqueIDs(args.drawer_ids);
    if (!wing && explicitIds.length === 0) {
      throw new Error("palace_height_threshold: provide drawer_ids or wing (optionally room)");
    }

    const evalLimit = clampNumber(args.limit, 200, 1, 2000);
    const includeZero = args.include_zero === true;

    const { client, prefix, url } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-height-threshold",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const drawerIDs = explicitIds.length > 0 ? explicitIds : await collectScopedDrawerIDs(call, wing, room, evalLimit);

    const evaluated: Record<string, unknown>[] = [];
    const matches: Record<string, unknown>[] = [];
    let failed = 0;

    for (const drawerID of drawerIDs) {
      try {
        const heightPayload = asObject(await call("get_height", { node_id: drawerID }));
        const height = Number(heightPayload.height) || 0;

        const metaPayload = asObject(await call("get_drawer", { drawer_id: drawerID }));
        const meta = asObject(metaPayload.metadata);
        const row = {
          drawer_id: drawerID,
          height,
          wing: String(metaPayload.wing || meta.wing || ""),
          room: String(metaPayload.room || meta.room || ""),
          retrieval_count: Number(meta.retrieval_count) || 0,
          filed_at: String(meta.filed_at || ""),
        };
        if (includeZero || height > 0) evaluated.push(row);
        if (height >= minHeight) matches.push(row);
      } catch (err) {
        failed += 1;
        evaluated.push({ drawer_id: drawerID, error: String(err) });
      }
    }

    return json({
      endpoint: url,
      min_height: minHeight,
      scope: explicitIds.length > 0 ? { drawer_ids: explicitIds } : { wing, room },
      evaluated_count: drawerIDs.length,
      failed,
      match_count: matches.length,
      matches: matches.sort((a, b) => Number((b as Record<string, unknown>).height || 0) - Number((a as Record<string, unknown>).height || 0)),
      evaluated: evaluated.slice(0, 200),
      note: "Height comes from the substrate get-height tool (synthesized-from DAG).",
    });
  },
});

async function collectScopedDrawerIDs(
  call: (name: string, payload: Record<string, unknown>) => Promise<unknown>,
  wing: string,
  room: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  const pageSize = Math.min(100, limit);

  while (ids.length < limit) {
    const listed = await call("list_drawers", { wing, room: room || undefined, limit: pageSize, offset });
    const rows = parseRows(listed);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = String((row as Record<string, unknown>).drawer_id || "").trim();
      if (!id) continue;
      ids.push(id);
      if (ids.length >= limit) break;
    }
    if (rows.length < pageSize) break;
    offset += rows.length;
  }

  return [...new Set(ids)];
}

function uniqueIDs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
