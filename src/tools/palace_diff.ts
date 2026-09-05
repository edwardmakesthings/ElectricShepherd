import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  createPalaceClient,
  parseFacts,
  parseRows,
  parseTaxonomy,
  resolveDiffWindows,
  summarizeDrawerRows,
} from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export default tool({
  description:
    "Compare a recent time window against the one immediately before it, per room, and report what changed: new drawers, growth or silence, new sources, and how much of the new material is still unconsolidated. Answers 'what has my memory picked up lately?' without loading drawer content.",
  args: {
    wing: tool.schema.string().optional().describe("Wing to diff. Defaults to this project's wing."),
    room: tool.schema.string().optional().describe("Restrict the diff to one room."),
    since: tool.schema
      .string()
      .optional()
      .describe("Start of the current window: relative (7d, 24h, 2w, 1m) or an ISO date. Default 7d."),
    until: tool.schema.string().optional().describe("End of the current window (ISO). Defaults to now."),
    max_rooms: tool.schema.number().optional().describe("Maximum rooms to compare (default 8)."),
    sample_limit: tool.schema.number().optional().describe("Sample previews of new drawers per room (default 3)."),
    preview_chars: tool.schema.number().optional().describe("Characters per preview (default 140)."),
    check_consolidation: tool.schema
      .boolean()
      .optional()
      .describe("Check consolidated-into edges on the new drawers (default true)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
    if (!wing) throw new Error("palace_diff: wing is required (no project wing resolved)");

    const windows = resolveDiffWindows({
      now: new Date(),
      since: String(args.since || "7d"),
      until: args.until ? String(args.until) : undefined,
    });

    const maxRooms = clampNumber(args.max_rooms, 8, 1, 25);
    const sampleLimit = clampNumber(args.sample_limit, 3, 0, 20);
    const previewChars = clampNumber(args.preview_chars, 140, 40, 600);
    const checkConsolidation = args.check_consolidation !== false;

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-diff",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const explicitRoom = String(args.room || "").trim();
    let rooms: string[];
    if (explicitRoom) {
      rooms = [explicitRoom];
    } else {
      const wingEntry = parseTaxonomy(await call("get_taxonomy", {})).find((entry) => entry.wing === wing);
      if (!wingEntry) {
        return json({ wing, exists: false, windows, rooms: [], note: "Wing not found in taxonomy." });
      }
      rooms = wingEntry.rooms.slice(0, maxRooms).map((entry) => entry.room);
    }

    // list_drawers reports `total` AFTER the date filter, so limit=1 buys an exact
    // window count for the price of one row.
    const countIn = async (room: string, since: string, before: string): Promise<number> => {
      const response = await call("list_drawers", { wing, room, since, before, limit: 1, offset: 0 });
      return Number(asObject(response).total) || 0;
    };

    const roomReports: Record<string, unknown>[] = [];
    let totalCurrent = 0;
    let totalPrevious = 0;
    const pendingIDs: string[] = [];

    for (const room of rooms) {
      try {
        const current = await countIn(room, windows.current.since, windows.current.before);
        const previous = await countIn(room, windows.previous.since, windows.previous.before);
        totalCurrent += current;
        totalPrevious += previous;

        let samples: unknown[] = [];
        let sources: string[] = [];
        let consolidation: Record<string, unknown> = { checked: false };

        if (current > 0 && sampleLimit > 0) {
          const page = await call("list_drawers", {
            wing,
            room,
            since: windows.current.since,
            before: windows.current.before,
            limit: Math.min(50, Math.max(sampleLimit, 10)),
            offset: 0,
          });
          const summary = summarizeDrawerRows(parseRows(page), previewChars);
          samples = summary.samples.slice(0, sampleLimit);
          sources = summary.sources.slice(0, 5);

          if (checkConsolidation) {
            let consumed = 0;
            const pending: string[] = [];
            for (const sample of summary.samples.slice(0, 25)) {
              if (!sample.drawer_id) continue;
              try {
                const facts = parseFacts(
                  await call("kg_query", {
                    entity: sample.drawer_id,
                    direction: "outgoing",
                    predicate: "consolidated-into",
                    recurse: false,
                    max_depth: 1,
                  }),
                );
                if (facts.length > 0) consumed += 1;
                else pending.push(sample.drawer_id);
              } catch {
                // A failed edge lookup must not drop the room from the diff.
              }
            }
            pendingIDs.push(...pending);
            consolidation = { checked: true, consumed, pending: pending.length };
          }
        }

        roomReports.push({
          room,
          current,
          previous,
          delta: current - previous,
          status: describeDelta(current, previous),
          new_sources: sources,
          consolidation,
          samples,
        });
      } catch (err) {
        roomReports.push({ room, error: String(err), status: "blocked" });
      }
    }

    return json({
      wing,
      windows: {
        current: windows.current,
        previous: windows.previous,
        length_days: Number((windows.durationMs / 86400000).toFixed(2)),
      },
      totals: { current: totalCurrent, previous: totalPrevious, delta: totalCurrent - totalPrevious },
      rooms: roomReports.sort((a, b) => Number(b.current || 0) - Number(a.current || 0)),
      unconsolidated_new_ids: pendingIDs.slice(0, 25),
      next_step:
        pendingIDs.length > 0
          ? "Run /consolidate-deep to consolidate the new material, or palace_report for a fuller room view."
          : "Nothing new is waiting on consolidation in the sampled rooms.",
    });
  },
});

function describeDelta(current: number, previous: number): string {
  if (current === 0 && previous === 0) return "quiet";
  if (current === 0) return "went-quiet";
  if (previous === 0) return "newly-active";
  if (current > previous) return "growing";
  if (current < previous) return "slowing";
  return "steady";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
