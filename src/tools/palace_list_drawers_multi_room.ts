import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  createPalaceClient,
  isTranscriptLikeRoom,
  parseRows,
  parseTaxonomy,
  summarizeDrawerRows,
} from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export default tool({
  description:
    "List drawers across multiple rooms in one call. Returns per-room totals and bounded samples so agents do not need one list_drawers call per room.",
  args: {
    wing: tool.schema.string().describe("Wing to inspect."),
    rooms: tool.schema.array(tool.schema.string()).optional().describe("Specific rooms to inspect. Omit to auto-select from taxonomy."),
    exclude_transcript_like: tool.schema
      .boolean()
      .optional()
      .describe("When true, skips transcript-like rooms (default false)."),
    since: tool.schema.string().optional().describe("Only drawers filed on/after this ISO date (inclusive)."),
    before: tool.schema.string().optional().describe("Only drawers filed before this ISO date (exclusive)."),
    limit_per_room: tool.schema.number().optional().describe("Rows to sample per room (default 20, max 100)."),
    max_rooms: tool.schema.number().optional().describe("Maximum rooms when rooms[] is omitted (default 25)."),
    samples_per_room: tool.schema.number().optional().describe("Sample previews to return per room (default 5)."),
    preview_chars: tool.schema.number().optional().describe("Preview width for samples (default 160)."),
    count_only: tool.schema.boolean().optional().describe("When true, skip per-row sampling and return only counts."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || "").trim();
    if (!wing) throw new Error("palace_list_drawers_multi_room: wing is required");

    const limitPerRoom = clampNumber(args.limit_per_room, 20, 1, 100);
    const maxRooms = clampNumber(args.max_rooms, 25, 1, 200);
    const samplesPerRoom = clampNumber(args.samples_per_room, 5, 0, 25);
    const previewChars = clampNumber(args.preview_chars, 160, 40, 1000);
    const excludeTranscriptLike = args.exclude_transcript_like === true;
    const countOnly = args.count_only === true;

    const requestedRooms = uniqueRooms(args.rooms);

    const { client, prefix, url } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-list-drawers-multi-room",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const taxonomy = parseTaxonomy(await call("get_taxonomy", {}));
    const wingEntry = taxonomy.find((entry) => entry.wing === wing);

    if (!wingEntry) {
      return json({
        scope: "wing",
        endpoint: url,
        wing,
        exists: false,
        rooms_requested: requestedRooms,
        rooms_resolved: [],
        room_reports: [],
      });
    }

    let rooms = requestedRooms.length > 0 ? requestedRooms : wingEntry.rooms.map((entry) => entry.room).slice(0, maxRooms);
    if (excludeTranscriptLike) rooms = rooms.filter((room) => !isTranscriptLikeRoom(room));

    const roomReports: Record<string, unknown>[] = [];
    let totalAcrossRooms = 0;

    for (const room of rooms) {
      try {
        const payload: Record<string, unknown> = { wing, room, limit: countOnly ? 1 : limitPerRoom, offset: 0 };
        if (args.since) payload.since = String(args.since);
        if (args.before) payload.before = String(args.before);
        const listed = await call("list_drawers", payload);
        const total = Number(asObject(listed).total) || 0;
        totalAcrossRooms += total;

        if (countOnly) {
          roomReports.push({ room, total, sampled: 0, samples: [] });
          continue;
        }

        const rows = parseRows(listed);
        const summary = summarizeDrawerRows(rows, previewChars);
        roomReports.push({
          room,
          total,
          sampled: summary.count,
          filed_at: { earliest: summary.filedAtEarliest, latest: summary.filedAtLatest },
          sources: summary.sources.slice(0, 8),
          samples: summary.samples.slice(0, samplesPerRoom),
        });
      } catch (err) {
        roomReports.push({ room, error: String(err) });
      }
    }

    return json({
      scope: "multi-room",
      endpoint: url,
      wing,
      count_only: countOnly,
      exclude_transcript_like: excludeTranscriptLike,
      rooms_requested: requestedRooms,
      rooms_resolved: rooms,
      rooms_considered: rooms.length,
      totals: {
        drawers: totalAcrossRooms,
        rooms_with_errors: roomReports.filter((row) => String((row as Record<string, unknown>).error || "")).length,
      },
      room_reports: roomReports.sort((a, b) => Number((b as Record<string, unknown>).total || 0) - Number((a as Record<string, unknown>).total || 0)),
    });
  },
});

function uniqueRooms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    const room = String(raw || "").trim();
    if (room) seen.add(room);
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
