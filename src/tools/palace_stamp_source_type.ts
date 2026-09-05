/**
 * Bounded, dry-run-first backfill of the `es-source-type`
 * KG axis for existing drawers.
 *
 * Inference rules:
 *   - transcript-like rooms (isTranscriptLikeRoom) → `transcript` (room name is the signal; no KG call)
 *   - drawers with outgoing `synthesized-from` edges → `synthesis` (one-hop kg_query per drawer)
 *   - everything else → left UNSTAMPED ("unknown authority"), never guessed
 *
 * Bounded by construction: each room is probed for its total, then walked with at
 * most `max_pages` pages of `page_size` drawers. Drawers beyond the cap are counted
 * as not_covered_by_page_cap and never fetched — a room can never be paged to
 * exhaustion (spec L138-139). Mutating path is dry-run by default, like every other
 * mutating tool in this project.
 */

import { tool } from "@opencode-ai/plugin";
import {
  runKgAddWrites,
  runKgSupersedeWrites,
} from "../core/operation.ts";
import {
  asObject,
  asText,
  createPalaceClient,
  isTranscriptLikeRoom,
  parseFacts,
  parseRows,
  parseTaxonomy,
} from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { normalizeDryRunArg } from "../core/substrate.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import { mapLimit } from "./palace_flock_status.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 4;
const MAX_MAX_PAGES = 40;
const DEFAULT_MAX_ROOMS = 25;
const MAX_MAX_ROOMS = 200;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;

export type SourceTypeInference = "transcript" | "synthesis" | "unknown";

export type StampPlanEntry = {
  drawer_id: string;
  room: string;
  inferred: SourceTypeInference;
  current: string | null;
  action: "stamp" | "already-stamped" | "leave-unstamped";
};

export type RoomStampReport = {
  room: string;
  transcript_like: boolean;
  total: number;
  covered: number;
  not_covered_by_page_cap: number;
  inferred_transcript: number;
  inferred_synthesis: number;
  unknown: number;
  check_failed: number;
  already_stamped: number;
  would_stamp: number;
};

export type StampReport = {
  wing: string;
  dry_run: boolean;
  rooms: RoomStampReport[];
  totals: {
    covered: number;
    inferred_transcript: number;
    inferred_synthesis: number;
    unknown: number;
    check_failed: number;
    already_stamped: number;
    stamped: number;
    stamp_failed: number;
  };
  next_step?: string;
};

type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

/** One-hop outgoing objects for a predicate; tolerant of failure (reads as "no edges"). */
function extractOutgoingObjects(entity: string, facts: Record<string, unknown>[]): string[] {
  const out = new Set<string>();
  for (const fact of facts) {
    const subject = asText(fact.subject || fact.source || fact.from || fact.head || fact.entity).trim();
    const object = asText(fact.object || fact.target || fact.to || fact.tail || fact.value).trim();
    if (!object) continue;
    if (!subject || subject === entity) out.add(object);
  }
  return [...out];
}

/** Current es-source-type value on a drawer, or null when unstamped/unreadable. */
async function readCurrentSourceType(call: CallTool, drawerId: string): Promise<string | null> {
  let facts: Record<string, unknown>[];
  try {
    facts = parseFacts(
      await call("kg_query", {
        entity: drawerId,
        direction: "outgoing",
        predicate: "es-source-type",
        recurse: false,
        max_depth: 1,
      }),
    );
  } catch {
    return null;
  }
  const values = extractOutgoingObjects(drawerId, facts);
  for (const value of values) {
    if (value === "transcript" || value === "doc" || value === "synthesis" || value === "skill") return value;
  }
  return null;
}

/**
 * Does the drawer have outgoing `synthesized-from` edges? Returns:
 *   "yes" — at least one current edge (infer synthesis)
 *   "no"  — query succeeded, zero edges (leave unstamped)
 *   "failed" — the query itself failed (leave unstamped; counted separately so a
 *              flaky server never masquerades as "no edges")
 */
async function hasOutgoingSynthesizedFrom(call: CallTool, drawerId: string): Promise<"yes" | "no" | "failed"> {
  try {
    const facts = parseFacts(
      await call("kg_query", {
        entity: drawerId,
        direction: "outgoing",
        predicate: "synthesized-from",
        recurse: false,
        max_depth: 1,
      }),
    );
    return extractOutgoingObjects(drawerId, facts).length > 0 ? "yes" : "no";
  } catch {
    return "failed";
  }
}

/**
 * Classify one drawer's inferred source type. Transcript-like rooms are the signal
 * (no KG call); everything else gets a one-hop outgoing synthesized-from check.
 */
export async function inferSourceType(
  call: CallTool,
  room: string,
  drawerId: string,
): Promise<{ inference: SourceTypeInference; checkFailed: boolean }> {
  if (isTranscriptLikeRoom(room)) return { inference: "transcript", checkFailed: false };
  const edge = await hasOutgoingSynthesizedFrom(call, drawerId);
  if (edge === "yes") return { inference: "synthesis", checkFailed: false };
  if (edge === "failed") return { inference: "unknown", checkFailed: true };
  return { inference: "unknown", checkFailed: false };
}

/**
 * Walk up to `maxPages` pages of a room and classify every drawer on them.
 * Returns the covered drawer ids, per-drawer inferences, and how many drawers
 * sit beyond the page cap (reported, never fetched).
 */
async function collectRoomInferences(
  call: CallTool,
  wing: string,
  room: string,
  pageSize: number,
  maxPages: number,
  concurrency: number,
): Promise<{ entries: { drawer_id: string; inference: SourceTypeInference; checkFailed: boolean }[]; total: number; notCovered: number }> {
  const probe = asObject(await call("list_drawers", { wing, room, limit: 1, offset: 0 }));
  const total = Number(probe.total) || 0;

  const ids: string[] = [];
  for (let page = 0; page < maxPages && ids.length < total; page += 1) {
    const response = await call("list_drawers", { wing, room, limit: pageSize, offset: page * pageSize });
    const pageIds = parseRows(response)
      .map((row) => asText(row.drawer_id || row.id).trim())
      .filter(Boolean);
    ids.push(...pageIds);
    if (pageIds.length < pageSize) break;
  }

  const seen = new Set<string>();
  const uniqueIds = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  const results = await mapLimit(uniqueIds, concurrency, async (drawerId) => {
    const { inference, checkFailed } = await inferSourceType(call, room, drawerId);
    return { drawer_id: drawerId, inference, checkFailed };
  });

  return { entries: results, total, notCovered: Math.max(0, total - uniqueIds.length) };
}

/**
 * The backfill core (exported for unit testing): plan + optionally apply.
 *
 * Dry-run (dryRun=true) performs only READS — taxonomy probe, bounded paging,
 * per-drawer edge checks, idempotency reads — and returns what WOULD be stamped.
 * Apply issues one atomic kg_supersede (only when the current value differs)
 * or kg_add (when unstamped) per drawer that needs stamping; unknown drawers are never written.
 */
export async function runSourceTypeBackfill(args: {
  call: CallTool;
  wing: string;
  rooms?: string[];
  excludeRooms?: string[];
  pageSize?: number;
  maxPages?: number;
  maxRooms?: number;
  concurrency?: number;
  dry_run?: boolean;
  dryRun?: boolean;
}): Promise<StampReport> {
  const pageSize = clampNumber(args.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const maxPages = clampNumber(args.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
  const maxRooms = clampNumber(args.maxRooms, DEFAULT_MAX_ROOMS, 1, MAX_MAX_ROOMS);
  const concurrency = clampNumber(args.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const dryRun = normalizeDryRunArg(args);

  const taxonomy = parseTaxonomy(await args.call("get_taxonomy", {}));
  const wingEntry = taxonomy.find((entry) => entry.wing === args.wing);
  if (!wingEntry) {
    return {
      wing: args.wing,
      dry_run: dryRun,
      rooms: [],
      totals: emptyTotals(),
      next_step: "Wing not found in taxonomy — check the name and retry.",
    };
  }

  const exclude = new Set((args.excludeRooms || []).map((item) => item.trim()).filter(Boolean));
  let rooms = wingEntry.rooms.map((entry) => entry.room).filter((room) => !exclude.has(room));
  if (args.rooms && args.rooms.length > 0) {
    const explicit = new Set(args.rooms.map((item) => item.trim()).filter(Boolean));
    rooms = rooms.filter((room) => explicit.has(room));
  }
  rooms = rooms.slice(0, maxRooms);

  const roomReports: RoomStampReport[] = [];
  const plans: { entry: StampPlanEntry; room: string }[] = [];

  for (const room of rooms) {
    const transcriptLike = isTranscriptLikeRoom(room);
    const collected = await collectRoomInferences(args.call, args.wing, room, pageSize, maxPages, concurrency);

    let inferredTranscript = 0;
    let inferredSynthesis = 0;
    let unknown = 0;
    let checkFailed = 0;

    for (const item of collected.entries) {
      if (item.inference === "transcript") inferredTranscript += 1;
      else if (item.inference === "synthesis") inferredSynthesis += 1;
      else unknown += 1;
      if (item.checkFailed) checkFailed += 1;

      // Idempotency read for drawers with an inferred type (read-only, safe in dry-run).
      const current = item.inference === "unknown" ? null : await readCurrentSourceType(args.call, item.drawer_id);
      const action: StampPlanEntry["action"] =
        item.inference === "unknown"
          ? "leave-unstamped"
          : current === item.inference
            ? "already-stamped"
            : "stamp";
      plans.push({ entry: { drawer_id: item.drawer_id, room, inferred: item.inference, current, action }, room });

    }

    const alreadyStamped = plans.filter((p) => p.room === room && p.entry.action === "already-stamped").length;
    const wouldStamp = plans.filter((p) => p.room === room && p.entry.action === "stamp").length;

    roomReports.push({
      room,
      transcript_like: transcriptLike,
      total: collected.total,
      covered: collected.entries.length,
      not_covered_by_page_cap: collected.notCovered,
      inferred_transcript: inferredTranscript,
      inferred_synthesis: inferredSynthesis,
      unknown,
      check_failed: checkFailed,
      already_stamped: alreadyStamped,
      would_stamp: dryRun ? wouldStamp : 0,
    });
  }

  const totals = emptyTotals();
  for (const report of roomReports) {
    totals.covered += report.covered;
    totals.inferred_transcript += report.inferred_transcript;
    totals.inferred_synthesis += report.inferred_synthesis;
    totals.unknown += report.unknown;
    totals.check_failed += report.check_failed;
    totals.already_stamped += report.already_stamped;
  }

  if (dryRun) {
    return {
      wing: args.wing,
      dry_run: true,
      rooms: roomReports,
      totals: { ...totals, stamped: 0, stamp_failed: 0 },
      next_step: "Re-run with dry_run:false to apply the stamps.",
    };
  }

  // Apply: best-effort per drawer — one failed stamp never aborts the pass.
  const toStamp = plans.filter((p) => p.entry.action === "stamp");
  await mapLimit(toStamp, concurrency, async ({ entry }) => {
    try {
      if (entry.current && entry.current !== entry.inferred) {
        const [result] = await runKgSupersedeWrites(args.call, [{
          payload: {
            subject: entry.drawer_id,
            predicate: "es-source-type",
            old_object: entry.current,
            new_object: entry.inferred,
            source_closet: entry.drawer_id,
          },
        }]);
        if (!result?.ok) throw new Error(result?.error || "kg_supersede failed");
      } else {
        const [result] = await runKgAddWrites(args.call, [{
          payload: {
            subject: entry.drawer_id,
            predicate: "es-source-type",
            object: entry.inferred,
            source_closet: entry.drawer_id,
          },
        }]);
        if (!result?.ok) throw new Error(result?.error || "kg_add failed");
      }
      totals.stamped += 1;
    } catch {
      totals.stamp_failed += 1;
    }
  });

  return { wing: args.wing, dry_run: false, rooms: roomReports, totals };
}

function emptyTotals(): StampReport["totals"] {
  return {
    covered: 0,
    inferred_transcript: 0,
    inferred_synthesis: 0,
    unknown: 0,
    check_failed: 0,
    already_stamped: 0,
    stamped: 0,
    stamp_failed: 0,
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export default tool({
  description:
    "Bounded, dry-run-first backfill of the `es-source-type` KG axis for existing drawers. Infers `transcript` for transcript-like rooms (isTranscriptLikeRoom) and `synthesis` for drawers with outgoing synthesized-from edges; everything else is left unstamped (unknown), never guessed. Each room is probed for its total then walked with at most max_pages pages of page_size drawers — a room can never be paged to exhaustion. Dry-run by default: pass dry_run:false to apply.",
  args: {
    wing: tool.schema.string().optional().describe("Wing to backfill. Defaults to this project's wing."),
    rooms: tool.schema
      .string()
      .optional()
      .describe("Comma-separated explicit rooms. Default: every room in the wing (capped by max_rooms)."),
    exclude_rooms: tool.schema.string().optional().describe("Comma-separated rooms to skip."),
    page_size: tool.schema.number().optional().describe("Drawers per page request (default 50, max 100)."),
    max_pages: tool.schema.number().optional().describe("Maximum pages per room (default 4, max 40)."),
    max_rooms: tool.schema.number().optional().describe("Maximum rooms to process (default 25, max 200)."),
    concurrency: tool.schema.number().optional().describe("Parallel KG checks per drawer (default 8, max 16)."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
    if (!wing) throw new Error("palace_stamp_source_type: wing is required (no project wing resolved)");

    const rooms = String(args.rooms || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const excludeRooms = String(args.exclude_rooms || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-stamp-source-type",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const report = await runSourceTypeBackfill({
      call,
      wing,
      rooms,
      excludeRooms,
      pageSize: args.page_size,
      maxPages: args.max_pages,
      maxRooms: args.max_rooms,
      concurrency: args.concurrency,
      dryRun: args.dry_run,
    });

    return JSON.stringify(report, null, 2);
  },
});
