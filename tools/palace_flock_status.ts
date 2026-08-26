import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  asText,
  createPalaceClient,
  isTranscriptLikeRoom,
  parseFacts,
  parseRows,
  parseTaxonomy,
} from "../adapter/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

const DEFAULT_THRESHOLD = 12;

// Phase 7 (unified memory): re-synthesis candidate rule. A closet accumulating
// `revise` outcomes is a re-synthesis candidate — surfaced here at parent-drawer
// granularity, the same way provisional backlog is surfaced. Approved threshold:
// revise_count >= 2 AND revise_count > accept_count over a bounded recent window
// (outcome edges carry valid_from; facts without a parseable timestamp count as in-
// window rather than being dropped — conservative toward surfacing). Count-based and
// capped, never an unbounded closet listing.
const RE_SYNTHESIS_REVISE_MIN = 2;
export const RE_OUTCOME_WINDOW_DAYS = 30;
export const RE_OUTCOME_CANDIDATE_SAMPLE_CAP = 10;

export type OutcomeCounts = { accept: number; revise: number; failed: number; unused: number };

/** Pure re-synthesis candidate predicate (approved Phase 7 rule). */
export function isReSynthesisCandidate(counts: OutcomeCounts): boolean {
  return counts.revise >= RE_SYNTHESIS_REVISE_MIN && counts.revise > counts.accept;
}

/** Parse one node's es-outcome facts into windowed counts. Pure, exported for tests. */
export function countOutcomesInWindow(
  factsRaw: unknown,
  windowStartIso: string,
): OutcomeCounts {
  const counts: OutcomeCounts = { accept: 0, revise: 0, failed: 0, unused: 0 };
  for (const fact of parseFacts(factsRaw)) {
    if (fact.current === false) continue;
    const value = asText(fact.object).trim();
    if (value !== "accept" && value !== "revise" && value !== "failed" && value !== "unused") continue;
    // Window by the edge's valid_from when present; untimestamped edges count in-window.
    const stamped = asText(fact.valid_from || fact.created_at).trim();
    if (stamped && stamped < windowStartIso) continue;
    counts[value] += 1;
  }
  return counts;
}

export default tool({
  description:
    "Fast flock status counts at parent-drawer granularity (not chunk rows): unconsolidated sources, consolidated summaries, provisional summaries, backlog estimate, and threshold decision.",
  args: {
    wing: tool.schema.string().optional().describe("Wing to inspect. Defaults to this project's wing."),
    source_rooms: tool.schema
      .string()
      .optional()
      .describe("Comma-separated explicit source rooms. Default: transcript-like rooms in the wing."),
    exact_scan_cap: tool.schema
      .number()
      .optional()
      .describe("If total source parents <= this, scan all source IDs exactly (default 300)."),
    sample_cap: tool.schema
      .number()
      .optional()
      .describe("When above exact cap, max source IDs to edge-check for estimation (default 120)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || process.env.ESHEPHERD_PROJECT_WING || "").trim();
    if (!wing) throw new Error("palace_flock_status: wing is required (no project wing resolved)");

    const exactScanCap = clampNumber(args.exact_scan_cap, 300, 20, 5000);
    const sampleCap = clampNumber(args.sample_cap, 120, 20, 2000);

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-flock-status",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const taxonomy = parseTaxonomy(await call("get_taxonomy", {}));
    const wingEntry = taxonomy.find((entry) => entry.wing === wing);
    if (!wingEntry) {
      return json({ wing, exists: false, source_rooms: [], counts: {}, note: "Wing not found in taxonomy." });
    }

    const explicitRooms = String(args.source_rooms || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const sourceRooms =
      explicitRooms.length > 0
        ? wingEntry.rooms.filter((entry) => explicitRooms.includes(entry.room)).map((entry) => entry.room)
        : wingEntry.rooms.filter((entry) => isTranscriptLikeRoom(entry.room)).map((entry) => entry.room);

    if (sourceRooms.length === 0) {
      return json({
        wing,
        exists: true,
        source_rooms: [],
        counts: {
          source_parent_units_total: 0,
          unconsolidated_source_drawers: 0,
          consolidated_source_drawers: 0,
          consolidated_summary_nodes: 0,
          provisional_summary_nodes: 0,
          backlog_approx: 0,
        },
        threshold: thresholdReport(0),
        note: "No transcript-like source rooms found in this wing.",
      });
    }

    const roomTotals: { room: string; total: number }[] = [];
    for (const room of sourceRooms) {
      const response = await call("list_drawers", { wing, room, limit: 1, offset: 0 });
      roomTotals.push({ room, total: Number(asObject(response).total) || 0 });
    }

    const totalSourceParents = roomTotals.reduce((sum, item) => sum + item.total, 0);
    if (totalSourceParents === 0) {
      return json({
        wing,
        exists: true,
        source_rooms: roomTotals,
        counts: {
          source_parent_units_total: 0,
          unconsolidated_source_drawers: 0,
          consolidated_source_drawers: 0,
          consolidated_summary_nodes: 0,
          provisional_summary_nodes: 0,
          backlog_approx: 0,
        },
        sampling: { mode: "none", checked_source_ids: 0, sample_fraction: 0 },
        threshold: thresholdReport(0),
      });
    }

    const idsToCheck =
      totalSourceParents <= exactScanCap
        ? await collectExactSourceIds(call, wing, roomTotals)
        : await collectSampleSourceIds(call, wing, roomTotals, sampleCap);

    const consolidatedTargetsBySource = new Map<string, string[]>();
    const consolidationChecks = await mapLimit(idsToCheck, 8, async (sourceId) => {
      const facts = parseFacts(
        await call("kg_query", {
          entity: sourceId,
          direction: "outgoing",
          predicate: "consolidated-into",
          recurse: false,
          max_depth: 1,
        }).catch(() => ({})),
      );
      const targets = extractOutgoingObjects(sourceId, facts);
      consolidatedTargetsBySource.set(sourceId, targets);
      return targets.length > 0;
    });

    const checked = idsToCheck.length;
    const consolidatedChecked = consolidationChecks.filter(Boolean).length;
    const pendingChecked = checked - consolidatedChecked;
    const pendingRatio = checked > 0 ? pendingChecked / checked : 0;

    const exactMode = totalSourceParents <= exactScanCap;
    const unconsolidatedEstimate = exactMode ? pendingChecked : Math.round(totalSourceParents * pendingRatio);
    const consolidatedEstimate = Math.max(0, totalSourceParents - unconsolidatedEstimate);

    const consolidatedTargets = new Set<string>();
    for (const targets of consolidatedTargetsBySource.values()) {
      for (const target of targets) {
        if (target.startsWith(`drawer_${wing}_`)) consolidatedTargets.add(target);
      }
    }

    const targetStatuses = await mapLimit([...consolidatedTargets], 8, async (drawerId) => {
      const facts = parseFacts(
        await call("kg_query", {
          entity: drawerId,
          direction: "outgoing",
          predicate: "es-status",
          recurse: false,
          max_depth: 1,
        }).catch(() => ({})),
      );
      const values = extractOutgoingObjects(drawerId, facts);
      return values.includes("provisional");
    });

    const provisionalCount = targetStatuses.filter(Boolean).length;

    // Phase 7: re-synthesis candidates among the ALREADY-COLLECTED consolidated summary
    // nodes (parent-drawer granularity, bounded by the existing sampling — no new room
    // scans). One one-hop es-outcome kg_query per summary node, same concurrency pool.
    const windowStartIso = new Date(Date.now() - RE_OUTCOME_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const reSynthesisCandidates: { node_id: string; accept: number; revise: number }[] = [];
    await mapLimit([...consolidatedTargets], 8, async (drawerId) => {
      const facts = parseFacts(
        await call("kg_query", {
          entity: drawerId,
          direction: "outgoing",
          predicate: "es-outcome",
          recurse: false,
          max_depth: 1,
        }).catch(() => ({})),
      );
      const counts = countOutcomesInWindow(facts, windowStartIso);
      if (isReSynthesisCandidate(counts)) {
        reSynthesisCandidates.push({ node_id: drawerId, accept: counts.accept, revise: counts.revise });
      }
    });

    const threshold = thresholdReport(unconsolidatedEstimate);

    return json({
      wing,
      exists: true,
      source_rooms: roomTotals,
      counting_basis: {
        source: "parent drawer units from list_drawers totals",
        warning: "Do not use status/taxonomy chunk counts for consolidation backlog sizing.",
      },
      counts: {
        source_parent_units_total: totalSourceParents,
        unconsolidated_source_drawers: unconsolidatedEstimate,
        unconsolidated_source_drawers_is_estimate: !exactMode,
        consolidated_source_drawers: consolidatedEstimate,
        consolidated_summary_nodes: consolidatedTargets.size,
        consolidated_summary_nodes_is_partial_sample: !exactMode,
        provisional_summary_nodes: provisionalCount,
        provisional_summary_nodes_is_partial_sample: !exactMode,
        // Phase 7: closets accumulating revise outcomes — a re-synthesis candidate is
        // one with >= 2 revise AND more revise than accept over the recent window.
        re_synthesis_candidates: reSynthesisCandidates.length,
        re_synthesis_candidates_is_partial_sample: !exactMode,
        backlog_approx: unconsolidatedEstimate,
      },
      re_synthesis: {
        rule: `revise_count >= ${RE_SYNTHESIS_REVISE_MIN} AND revise_count > accept_count over recent window`,
        window_days: RE_OUTCOME_WINDOW_DAYS,
        checked_summary_nodes: consolidatedTargets.size,
        candidates: reSynthesisCandidates.slice(0, RE_OUTCOME_CANDIDATE_SAMPLE_CAP),
      },
      sampling: {
        mode: exactMode ? "exact" : "sampled",
        checked_source_ids: checked,
        total_source_parent_units: totalSourceParents,
        sample_fraction: Number((checked / totalSourceParents).toFixed(4)),
        pending_ratio_in_sample: Number(pendingRatio.toFixed(4)),
      },
      threshold,
      next_action: threshold.above_threshold ? "/consolidate-deep" : "none",
    });
  },
});

type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

async function collectExactSourceIds(
  call: CallTool,
  wing: string,
  rooms: { room: string; total: number }[],
): Promise<string[]> {
  const out: string[] = [];
  for (const room of rooms) {
    if (room.total <= 0) continue;
    const pageSize = 100;
    for (let offset = 0; offset < room.total; offset += pageSize) {
      const response = await call("list_drawers", { wing, room: room.room, limit: pageSize, offset });
      const ids = parseRows(response)
        .map((row) => asText(row.drawer_id || row.id).trim())
        .filter(Boolean);
      out.push(...ids);
      if (ids.length < pageSize) break;
    }
  }
  return dedupe(out);
}

async function collectSampleSourceIds(
  call: CallTool,
  wing: string,
  rooms: { room: string; total: number }[],
  sampleCap: number,
): Promise<string[]> {
  const out: string[] = [];
  let remaining = sampleCap;
  const active = rooms.filter((room) => room.total > 0);
  for (let i = 0; i < active.length; i += 1) {
    if (remaining <= 0) break;
    const roomsLeft = active.length - i;
    const room = active[i];
    const target = Math.max(1, Math.min(room.total, Math.floor(remaining / roomsLeft)));
    const response = await call("list_drawers", { wing, room: room.room, limit: Math.min(100, target), offset: 0 });
    const ids = parseRows(response)
      .map((row) => asText(row.drawer_id || row.id).trim())
      .filter(Boolean)
      .slice(0, target);
    out.push(...ids);
    remaining -= ids.length;
  }
  return dedupe(out);
}

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

// Exported so other tools can reuse the same fixed-slot pool for per-drawer KG
// traffic (concurrency 8 is the only validated level in this repo).
export async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  };

  const slots = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: slots }, () => run()));
  return results;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function thresholdReport(backlog: number) {
  const raw = Number(process.env.ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD);
  const threshold = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD;
  return {
    variable: "ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD",
    threshold,
    above_threshold: backlog >= threshold,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
