import { tool } from "@opencode-ai/plugin";
// Substrate transport is constructed ONLY through the core/ seam (Check A2).
import { createSubstrateClient } from "../core/substrate-client.ts";
import { applyRuntimeConfigToEnv, DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import {
  collectDrawerIDsByScope,
  classifyErrorKind,
  normalizeDryRunArg,
  normalizeIDs,
  normalizeOptional,
  normalizeWingList,
  parseIDsFromFile,
  resolveMemPalaceMCPUrl,
  runDrawerBatch,
  summarizeFailures,
  type BatchResultRow,
} from "../core/substrate.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

type MoveScriptRow = BatchResultRow & {
  drawer_id?: string;
  ok?: boolean;
  from_wing?: string;
  from_room?: string;
  to_wing?: string;
  to_room?: string;
  skipped?: boolean;
  via_bridge?: boolean;
  bridge_wing?: string;
};

type MoveScriptResult = {
  ok?: boolean;
  dry_run?: boolean;
  tool?: string;
  requested?: number;
  attempted?: number;
  moved?: number;
  failed?: number;
  skipped?: number;
  fatal?: boolean;
  source_wing?: string;
  source_room?: string;
  target_wing?: string;
  target_room?: string;
  source_wings?: string[];
  plans?: {
    source_wing?: string;
    source_room?: string;
    target_wing: string;
    target_room?: string;
    requested: number;
    attempted: number;
    moved: number;
    skipped: number;
    failed: number;
  }[];
  bridge_wing?: string;
  error?: string;
  error_kind?: string;
  results?: MoveScriptRow[];
  failure_kinds?: Record<string, number>;
  overlap_skipped?: number;
  overlap_samples?: { drawer_id: string; first_plan: number; skipped_plan: number }[];
  [key: string]: unknown;
};

function sameFold(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "variant" }) === 0;
}

function sameIgnoreCase(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
}

export default tool({
  description:
    "Move MemPalace drawers in bulk via update_drawer. Supports explicit IDs, source wing scopes (single or list), or a list of source→target mappings, with optional dry-run and case-only bridge moves.",
  args: {
    drawer_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Drawer IDs to move."),
    ids_file: tool.schema
      .string()
      .optional()
      .describe("Path to a file containing drawer IDs (newline/csv/json array)."),
    source_wing: tool.schema
      .string()
      .optional()
      .describe("Source wing to move from (can be used with source_room for scoped mass move)."),
    source_wings: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Source wings to move from (fan-in merge into one target_wing)."),
    source_room: tool.schema
      .string()
      .optional()
      .describe("Optional source room filter when selecting by source_wing."),
    target_wing: tool.schema
      .string()
      .optional()
      .describe("Target wing to move into (required unless using moves[] mapping mode)."),
    target_room: tool.schema
      .string()
      .optional()
      .describe("Optional target room override (default preserves each drawer room)."),
    moves: tool.schema
      .array(
        tool.schema.object({
          source_wing: tool.schema.string(),
          source_room: tool.schema.string().optional(),
          target_wing: tool.schema.string(),
          target_room: tool.schema.string().optional(),
        }),
      )
      .optional()
      .describe("Explicit source→target mappings. Use this to run many merges in one call."),
    dry_run: tool.schema
      .boolean()
      .default(true)
      .describe("When true, prints planned moves without writing."),
    fail_fast: tool.schema
      .boolean()
      .default(false)
      .describe("When true, stop on first failed move."),
    bridge_wing: tool.schema
      .string()
      .default("move-drawer-hop")
      .describe("Intermediate wing for case-only source→target moves (e.g., Armet→armet)."),
    tool_prefix: tool.schema
      .string()
      .optional()
      .describe("Optional MCP tool prefix override (example: mygateway_<prefix>)."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const sourceWing = normalizeOptional(args.source_wing);
    const sourceWings = normalizeWingList(args.source_wings);
    const sourceRoom = normalizeOptional(args.source_room);
    const targetWing = normalizeOptional(args.target_wing);
    const targetRoomOverride = normalizeOptional(args.target_room);
    const moveMappings = Array.isArray(args.moves)
      ? args.moves
          .map((row) => ({
            source_wing: normalizeOptional((row as { source_wing?: unknown }).source_wing),
            source_room: normalizeOptional((row as { source_room?: unknown }).source_room),
            target_wing: normalizeOptional((row as { target_wing?: unknown }).target_wing),
            target_room: normalizeOptional((row as { target_room?: unknown }).target_room),
          }))
          .filter((row) => row.source_wing && row.target_wing)
      : [];
    const bridgeWing = normalizeOptional(args.bridge_wing) || "move-drawer-hop";
    const failFast = Boolean(args.fail_fast);
    const dryRun = normalizeDryRunArg(args);

    const ids = new Set<string>();
    for (const id of normalizeIDs(args.drawer_ids)) ids.add(id);
    const idsFile = normalizeOptional(args.ids_file);
    if (idsFile) {
      for (const id of parseIDsFromFile(idsFile, cwd)) ids.add(id);
    }

    const scopeWings = new Set<string>(sourceWings);
    if (sourceWing) scopeWings.add(sourceWing);
    const hasMappings = moveMappings.length > 0;
    const useScope = scopeWings.size > 0;

    if (hasMappings) {
      if (ids.size > 0 || useScope || sourceRoom || targetWing || targetRoomOverride) {
        throw new Error(
          "move_drawers: moves[] cannot be combined with drawer_ids/ids_file/source_wing/source_wings/source_room/target_wing/target_room.",
        );
      }
    } else {
      if (!targetWing) throw new Error("move_drawers: target_wing is required unless using moves[].");
      if (!useScope && ids.size === 0) {
        throw new Error("move_drawers: provide drawer_ids/ids_file or source_wing/source_wings.");
      }
      if (useScope && ids.size > 0) {
        throw new Error("move_drawers: use either explicit IDs OR source_wing/source_wings/source_room, not both.");
      }
    }

    const toolPrefix = String(args.tool_prefix || runtimeConfig.valuesByPath.mcp?.toolPrefix || DEFAULT_MCP_TOOL_PREFIX).trim();
    const listTool = `${toolPrefix}list_drawers`;
    const getTool = `${toolPrefix}get_drawer`;
    const updateTool = `${toolPrefix}update_drawer`;

    try {
      const mcpURL = resolveMemPalaceMCPUrl(process.env, "ESHEPHERD_MOVE_MCP_URL", String(runtimeConfig.valuesByPath.mcp?.url || DEFAULT_MCP_URL));
      // Construct through the core/ seam (Check A2): it owns transport + initialize
      // and resolves headers for the effective URL (loopback stays unauthenticated).
      const { client: mcp } = await createSubstrateClient({
        env: process.env,
        clientName: "electric-shepherd-move-drawers-tool",
        urlOverride: mcpURL,
        requestTimeoutMs: Number(runtimeConfig.valuesByPath.mcp?.requestTimeoutMs || "60000"),
        maxRetries: Number(runtimeConfig.valuesByPath.mcp?.maxRetries || "2"),
        retryBackoffMs: Number(runtimeConfig.valuesByPath.mcp?.retryBackoffMs || "800"),
        retryMaxBackoffMs: Number(runtimeConfig.valuesByPath.mcp?.retryMaxBackoffMs || "8000"),
      });

      const runPlan = async (plan: {
        drawerIDs: string[];
        sourceWing?: string;
        sourceRoom?: string;
        targetWing: string;
        targetRoomOverride?: string;
      }) => {
        const runRow = async (drawerID: string): Promise<MoveScriptRow> => {
        const got = (await mcp.callTool(getTool, { drawer_id: drawerID })) as Record<string, unknown>;
        if (got && got.error) {
          const errorText = `get_drawer failed: ${String(got.error)}`;
          return {
            drawer_id: drawerID,
            ok: false,
            error: errorText,
            error_kind: classifyErrorKind(errorText),
          };
        }

        const fromWing = normalizeOptional((got as { wing?: unknown }).wing);
        const fromRoom = normalizeOptional((got as { room?: unknown }).room);
        const toRoom = plan.targetRoomOverride || fromRoom;
        if (!fromWing || !toRoom) {
          const errorText = "missing source wing/room on drawer";
          return {
            drawer_id: drawerID,
            ok: false,
            from_wing: fromWing || undefined,
            from_room: fromRoom || undefined,
            to_wing: plan.targetWing,
            to_room: toRoom || undefined,
            error: errorText,
            error_kind: classifyErrorKind(errorText),
          };
        }

        if (sameFold(fromWing, plan.targetWing) && sameFold(fromRoom, toRoom)) {
          return {
            drawer_id: drawerID,
            ok: true,
            from_wing: fromWing,
            from_room: fromRoom,
            to_wing: plan.targetWing,
            to_room: toRoom,
            skipped: true,
          };
        }

        const needsBridge = sameIgnoreCase(fromWing, plan.targetWing) && !sameFold(fromWing, plan.targetWing);
        const applyMove = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
          const doUpdate = async (wing: string, room: string) => {
            return (await mcp.callTool(updateTool, {
              drawer_id: drawerID,
              wing,
              room,
            })) as Record<string, unknown>;
          };

          if (needsBridge) {
            if (sameIgnoreCase(bridgeWing, plan.targetWing)) {
              return { ok: false, error: "bridge_wing must differ from target_wing when using case-change bridge" };
            }
            const bridgeRes = await doUpdate(bridgeWing, toRoom);
            if (bridgeRes && bridgeRes.error) {
              return { ok: false, error: `bridge move failed: ${String(bridgeRes.error)}` };
            }
          }

          const finalRes = await doUpdate(plan.targetWing, toRoom);
          if (finalRes && finalRes.error) {
            return { ok: false, error: `final move failed: ${String(finalRes.error)}` };
          }

          const verify = (await mcp.callTool(getTool, { drawer_id: drawerID })) as Record<string, unknown>;
          if (verify && verify.error) {
            return { ok: false, error: `verification failed: ${String(verify.error)}` };
          }

          const vWing = normalizeOptional((verify as { wing?: unknown }).wing);
          const vRoom = normalizeOptional((verify as { room?: unknown }).room);
          if (!sameFold(vWing, plan.targetWing) || !sameFold(vRoom, toRoom)) {
            return {
              ok: false,
              error: `verification mismatch: now wing=${vWing || "(empty)"} room=${vRoom || "(empty)"}`,
            };
          }

          return { ok: true };
        };

        if (dryRun) {
          return {
            drawer_id: drawerID,
            ok: true,
            from_wing: fromWing,
            from_room: fromRoom,
            to_wing: plan.targetWing,
            to_room: toRoom,
            via_bridge: needsBridge,
            bridge_wing: needsBridge ? bridgeWing : undefined,
          };
        }

        const moved = await applyMove();
        if (moved.ok === false) {
          const moveError: string = moved.error;
          return {
            drawer_id: drawerID,
            ok: false,
            from_wing: fromWing,
            from_room: fromRoom,
            to_wing: plan.targetWing,
            to_room: toRoom,
            via_bridge: needsBridge,
            bridge_wing: needsBridge ? bridgeWing : undefined,
            error: moveError,
            error_kind: classifyErrorKind(moveError),
          };
        }

        return {
          drawer_id: drawerID,
          ok: true,
          from_wing: fromWing,
          from_room: fromRoom,
          to_wing: plan.targetWing,
          to_room: toRoom,
          via_bridge: needsBridge,
          bridge_wing: needsBridge ? bridgeWing : undefined,
        };
      };

        const { results, failed } = await runDrawerBatch<MoveScriptRow>(plan.drawerIDs, failFast, runRow);
        const skipped = results.filter((row) => row && row.ok === true && Boolean(row.skipped)).length;
        const moved = results.filter((row) => row && row.ok === true && !Boolean(row.skipped)).length;
        return { results, failed, moved, skipped };
      };

      const plans: {
        drawerIDs: string[];
        sourceWing?: string;
        sourceRoom?: string;
        targetWing: string;
        targetRoomOverride?: string;
      }[] = [];

      if (hasMappings) {
        for (const mapping of moveMappings) {
          plans.push({
            drawerIDs: await collectDrawerIDsByScope(
              (payload) => mcp.callTool(listTool, payload) as Promise<Record<string, unknown>>,
              mapping.source_wing,
              mapping.source_room,
            ),
            sourceWing: mapping.source_wing,
            sourceRoom: mapping.source_room || undefined,
            targetWing: mapping.target_wing,
            targetRoomOverride: mapping.target_room || undefined,
          });
        }
      } else if (useScope) {
        for (const wing of scopeWings) {
          plans.push({
            drawerIDs: await collectDrawerIDsByScope(
              (payload) => mcp.callTool(listTool, payload) as Promise<Record<string, unknown>>,
              wing,
              sourceRoom,
            ),
            sourceWing: wing,
            sourceRoom: sourceRoom || undefined,
            targetWing,
            targetRoomOverride: targetRoomOverride || undefined,
          });
        }
      } else {
        plans.push({
          drawerIDs: [...ids],
          targetWing,
          targetRoomOverride: targetRoomOverride || undefined,
        });
      }

      const overlapSamples: { drawer_id: string; first_plan: number; skipped_plan: number }[] = [];
      let overlapSkipped = 0;
      const firstPlanByDrawer = new Map<string, number>();
      for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
        const plan = plans[planIndex];
        const dedupedWithinPlan = [...new Set(plan.drawerIDs)];
        const filtered: string[] = [];
        for (const drawerID of dedupedWithinPlan) {
          const prior = firstPlanByDrawer.get(drawerID);
          if (prior !== undefined) {
            overlapSkipped += 1;
            if (overlapSamples.length < 25) {
              overlapSamples.push({
                drawer_id: drawerID,
                first_plan: prior + 1,
                skipped_plan: planIndex + 1,
              });
            }
            continue;
          }
          firstPlanByDrawer.set(drawerID, planIndex);
          filtered.push(drawerID);
        }
        plan.drawerIDs = filtered;
      }

      const plannedCount = plans.reduce((sum, plan) => sum + plan.drawerIDs.length, 0);
      if (plannedCount === 0) {
        return JSON.stringify(
          {
            ok: true,
            dry_run: dryRun,
            requested: 0,
            source_wing: sourceWing || undefined,
            source_wings: useScope ? [...scopeWings] : undefined,
            source_room: sourceRoom || undefined,
            target_wing: targetWing || undefined,
            target_room: targetRoomOverride || undefined,
            overlap_skipped: overlapSkipped,
            overlap_samples: overlapSamples,
            message: "No drawers matched the request.",
          },
          null,
          2,
        );
      }

      const allResults: MoveScriptRow[] = [];
      const planSummaries: NonNullable<MoveScriptResult["plans"]> = [];
      let failed = 0;
      let moved = 0;
      let skipped = 0;

      for (const plan of plans) {
        const planOutcome = await runPlan(plan);
        allResults.push(...planOutcome.results);
        failed += planOutcome.failed;
        moved += planOutcome.moved;
        skipped += planOutcome.skipped;
        planSummaries.push({
          source_wing: plan.sourceWing,
          source_room: plan.sourceRoom,
          target_wing: plan.targetWing,
          target_room: plan.targetRoomOverride,
          requested: plan.drawerIDs.length,
          attempted: planOutcome.results.length,
          moved: planOutcome.moved,
          skipped: planOutcome.skipped,
          failed: planOutcome.failed,
        });
      }

      const payload: MoveScriptResult = {
        ok: failed === 0,
        dry_run: dryRun,
        tool: updateTool,
        requested: plannedCount,
        attempted: allResults.length,
        moved,
        skipped,
        failed,
        source_wing: sourceWing || undefined,
        source_wings: useScope ? [...scopeWings] : undefined,
        source_room: sourceRoom || undefined,
        target_wing: targetWing || undefined,
        target_room: targetRoomOverride || undefined,
        plans: planSummaries,
        bridge_wing: bridgeWing,
        overlap_skipped: overlapSkipped,
        overlap_samples: overlapSamples,
        results: allResults,
      };

      if (failed > 0) {
        const summary = summarizeFailures(payload.results || [], payload.error || "", "move_drawers failed");
        return JSON.stringify({ ...payload, ...summary }, null, 2);
      }

      return JSON.stringify(payload, null, 2);
    } catch (err) {
      const errorText = String(err);
      const kind = classifyErrorKind(errorText);
      const payload: MoveScriptResult = {
        ok: false,
        dry_run: dryRun,
        fatal: true,
        source_wing: sourceWing || undefined,
        source_wings: useScope ? [...scopeWings] : undefined,
        source_room: sourceRoom || undefined,
        target_wing: targetWing || undefined,
        target_room: targetRoomOverride || undefined,
        bridge_wing: bridgeWing,
        error: errorText,
        error_kind: kind,
        failure_kinds: { [kind]: 1 },
      };
      const summary = summarizeFailures(payload.results || [], payload.error || "", "move_drawers failed");
      return JSON.stringify({ ...payload, ...summary }, null, 2);
    }
  },
});
