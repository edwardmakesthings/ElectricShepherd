import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  asText,
  createPalaceClient,
  isTranscriptLikeRoom,
  parseFacts,
  parseRows,
  parseTaxonomy,
  summarizeDrawerRows,
} from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

const MAX_PAGE_LIMIT = 100;

export default tool({
  description:
    "Survey MemPalace and return a compact digest instead of raw content. With no arguments it reports every wing and its rooms; with a wing it reports that wing's rooms; with wing+room it pages the room and reports counts, date range, sources, sample previews, and how many drawers are still unconsolidated. Use this to answer 'what is actually in my memory?' without pulling drawer contents into context.",
  args: {
    wing: tool.schema.string().optional().describe("Wing to inspect. Omit for a palace-wide overview."),
    room: tool.schema.string().optional().describe("Room to inspect. Requires wing."),
    since: tool.schema.string().optional().describe("Only drawers filed on/after this ISO date (inclusive)."),
    before: tool.schema.string().optional().describe("Only drawers filed before this ISO date (exclusive)."),
    sample_limit: tool.schema.number().optional().describe("How many drawer previews to return (default 8, max 50)."),
    preview_chars: tool.schema.number().optional().describe("Characters per preview (default 160)."),
    page_limit: tool.schema.number().optional().describe("Drawers per page request (default 50, max 100)."),
    max_pages: tool.schema.number().optional().describe("Maximum pages to walk (default 4)."),
    check_consolidation: tool.schema
      .boolean()
      .optional()
      .describe("Check consolidated-into edges to count pending vs consumed drawers (default true)."),
    consolidation_sample: tool.schema
      .number()
      .optional()
      .describe("How many drawers to check for consolidation edges (default 25)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override (example: mygateway_<prefix>)."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || "").trim();
    const room = String(args.room || "").trim();
    if (room && !wing) {
      throw new Error("palace_report: room requires wing");
    }

    const sampleLimit = clampNumber(args.sample_limit, 8, 1, 50);
    const previewChars = clampNumber(args.preview_chars, 160, 40, 1000);
    const pageLimit = clampNumber(args.page_limit, 50, 1, MAX_PAGE_LIMIT);
    const maxPages = clampNumber(args.max_pages, 4, 1, 40);
    const consolidationSample = clampNumber(args.consolidation_sample, 25, 0, 100);
    const checkConsolidation = args.check_consolidation !== false;

    const { client, prefix, url } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-report",
      toolPrefix: args.tool_prefix,
    });

    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const defaultWing = String(runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
    const defaultRoom = String(runtimeConfig.valuesByPath.sourceCapture?.room || "").trim();

    if (!wing) {
      const taxonomy = parseTaxonomy(await call("get_taxonomy", {}));
      return json({
        scope: "palace",
        endpoint: url,
        project_defaults: { wing: defaultWing, room: defaultRoom },
        wings: taxonomy.map((entry) => ({
          wing: entry.wing,
          drawers: entry.drawers,
          rooms: entry.rooms.length,
          top_rooms: entry.rooms.slice(0, 6),
        })),
        next_step: "Call palace_report again with a wing to see its rooms, then wing+room for drawer detail.",
      });
    }

    const taxonomy = parseTaxonomy(await call("get_taxonomy", {}));
    const wingEntry = taxonomy.find((entry) => entry.wing === wing);

    if (!room) {
      const similar = taxonomy
        .filter((entry) => entry.wing !== wing && sharesStem(entry.wing, wing))
        .map((entry) => ({ wing: entry.wing, drawers: entry.drawers }));

      return json({
        scope: "wing",
        endpoint: url,
        wing,
        exists: Boolean(wingEntry),
        drawers: wingEntry?.drawers ?? 0,
        rooms: wingEntry?.rooms ?? [],
        transcript_like_rooms: (wingEntry?.rooms ?? [])
          .filter((entry) => isTranscriptLikeRoom(entry.room))
          .map((entry) => entry.room),
        similar_wings: similar,
        next_step: "Call palace_report with wing+room for counts, date range, samples, and consolidation status.",
      });
    }

    const rows: Record<string, unknown>[] = [];
    let reportedTotal = 0;
    let pagesWalked = 0;
    let truncated = false;

    for (let page = 0; page < maxPages; page += 1) {
      const payload: Record<string, unknown> = { wing, room, limit: pageLimit, offset: page * pageLimit };
      if (args.since) payload.since = String(args.since);
      if (args.before) payload.before = String(args.before);

      const response = await call("list_drawers", payload);
      const pageRows = parseRows(response);
      pagesWalked += 1;
      reportedTotal = Number(asObject(response).total) || reportedTotal;
      rows.push(...pageRows);

      if (pageRows.length < pageLimit) break;
      if (page === maxPages - 1) truncated = true;
    }

    const summary = summarizeDrawerRows(rows, previewChars);

    let consolidation: Record<string, unknown> = { checked: false };
    if (checkConsolidation && consolidationSample > 0 && rows.length > 0) {
      const ids = summary.samples.map((item) => item.drawer_id).filter(Boolean).slice(0, consolidationSample);
      const pending: string[] = [];
      let consumed = 0;
      let failed = 0;

      for (const id of ids) {
        try {
          const facts = parseFacts(
            await call("kg_query", {
              entity: id,
              direction: "outgoing",
              predicate: "consolidated-into",
              recurse: false,
              max_depth: 1,
            }),
          );
          if (facts.length > 0) consumed += 1;
          else pending.push(id);
        } catch {
          failed += 1;
        }
      }

      consolidation = {
        checked: true,
        sampled: ids.length,
        consumed,
        pending: pending.length,
        failed,
        pending_ids: pending.slice(0, 25),
        note: "Sampled over the drawers walked by this call, not the whole room.",
      };
    }

    return json({
      scope: "room",
      endpoint: url,
      wing,
      room,
      total_in_room: reportedTotal || summary.count,
      walked: summary.count,
      pages_walked: pagesWalked,
      more_pages_available: truncated,
      filed_at: { earliest: summary.filedAtEarliest, latest: summary.filedAtLatest },
      distinct_sources: summary.sources.length,
      sources: summary.sources.slice(0, 10),
      consolidation,
      samples: summary.samples.slice(0, sampleLimit),
      next_step:
        "Use export_drawer for any drawer whose full content you need; it writes to a file and returns metadata instead of flooding context.",
    });
  },
});

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sharesStem(a: string, b: string): boolean {
  const stem = (value: string) => asText(value).toLowerCase().replace(/^\d+[_-]+/, "").replace(/[^a-z0-9]/g, "");
  const left = stem(a);
  const right = stem(b);
  return Boolean(left) && left === right;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
