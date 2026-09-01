/**
 * Phase 3 (unified memory): `/ingest-docs <path>` — mine a docs directory into the
 * project wing's `reference` room and stamp every ingested drawer
 * `es-source-type: doc`.
 *
 * Mining is delegated to the substrate mine tool (mode "projects", wing pinned),
 * which stamps absolute `source_file` so the substrate sync tool can prune deletions later.
 * What ES adds on top (the miner knows nothing about the source-type axis):
 *   1. room selection under the naming contract — `get_taxonomy`, reuse an existing
 *      reference-like room before minting `reference`;
 *   2. staleness handling on re-ingest — drawer IDs are content-stable across re-mines
 *      of unchanged files, so a bounded pre/post ID snapshot around the mine call gives
 *      the changed set by construction; every OPEN outgoing KG fact on a changed drawer
 *      is invalidated (the miner purges drawers but never touches the separate KG store),
 *      then the owned axis is re-stamped `es-source-type: doc`;
 *   2b. Phase 11 synthesis staleness — for each changed doc, incoming `concerns` edges
 *       identify syntheses that reference it; those syntheses are SOFT-flagged
 *       `es-staleness: source-changed`. Flag only: the pass NEVER invalidates or deletes
 *       a synthesis node or any of its lineage (the synthesis may still be correct).
 *   3. dry-run by default — the first call makes NO mutating MCP call (no mine, no KG).
 *
 * Bounded by construction: each snapshot walks at most `max_pages` pages of
 * `page_size` drawers; invalidation fan-out is capped by `max_changed` and
 * `mapLimit` concurrency. A room can never be paged to exhaustion.
 *
 * Failure semantics (convergence-on-retry, no cross-call transaction):
 *   - mine fails  → stop immediately, nothing else ran;
 *   - per-fact kg_invalidate failures are counted, never abort the pass;
 *   - re-running is safe: the mtime gate skips unchanged files, invalidation only
 *     targets open facts (already-closed ones are absent), kg_add of an identical
 *     triple is a no-op.
 *
 * `es-status` is intentionally NOT touched — it stays orthogonal to es-source-type.
 */

import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  asText,
  createPalaceClient,
  parseFacts,
  parseRows,
  parseTaxonomy,
} from "../adapter/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import { mapLimit } from "./palace_flock_status.ts";
import { roomNameIssue } from "./palace_organize_memories.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 4;
const MAX_MAX_PAGES = 40;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
const DEFAULT_MAX_CHANGED = 500;
const MAX_MAX_CHANGED = 5000;

const REFERENCE_ROOM = "reference";
// Purpose-named stems that count as an existing reference room (checked against the
// kebab-case/purpose contract via roomNameIssue before reuse).
const REFERENCE_LIKE_STEMS = ["reference", "references", "docs", "documentation", "api-reference"];

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type IdSnapshot = {
  ids: string[];
  rows: Record<string, unknown>[];
  total: number;
  incomplete: boolean;
};

export type IngestReport = {
  ok: boolean;
  wing: string;
  room: string;
  path: string;
  dry_run: boolean;
  error?: string;
  mine_output?: string;
  pre_snapshot?: { total: number; covered: number; incomplete: boolean };
  post_snapshot?: { total: number; covered: number; incomplete: boolean };
  changed?: { new: number; remined_by_output: number; remined_by_fallback: number };
  facts_invalidated?: number;
  invalidate_failed?: number;
  fact_check_failed?: number;
  restamped_doc?: number;
  stamp_failed?: number;
  concerns_checked?: number;
  synthesis_flagged?: number;
  flag_failures?: number;
  skipped_non_synthesis?: number;
  not_covered_by_page_cap?: number;
  truncated?: boolean;
  next_step?: string;
};

/**
 * Room selection under the naming contract: reuse an existing purpose-named room
 * whose name matches one of `likeStems` (checked via roomNameIssue first), else
 * mint `canonicalName`. Taxonomy rooms arrive sorted by drawer count desc — the
 * first match wins. Shared by `pickReferenceRoom` (Phase 3) and `file_skill.ts`
 * (Phase 5, the `skills` room) so there is exactly one picker in the codebase.
 */
export function pickPurposeRoom(
  rooms: { room: string; drawers: number }[],
  canonicalName: string,
  likeStems: string[],
): { room: string; reused: boolean } {
  const candidates = rooms.filter(
    (entry) => !roomNameIssue(entry.room) && likeStems.some((stem) => entry.room === stem || entry.room.endsWith(`-${stem}`)),
  );
  if (candidates.length > 0) return { room: candidates[0].room, reused: true };
  return { room: canonicalName, reused: false };
}

/** Room selection: reuse an existing reference-like room, else mint `reference`. */
export function pickReferenceRoom(rooms: { room: string; drawers: number }[]): { room: string; reused: boolean } {
  return pickPurposeRoom(rooms, REFERENCE_ROOM, REFERENCE_LIKE_STEMS);
}

/** Bounded ID snapshot of one room: probe total, then walk at most maxPages pages. */
export async function boundedIdSnapshot(
  call: CallTool,
  wing: string,
  room: string,
  pageSize: number,
  maxPages: number,
): Promise<IdSnapshot> {
  const probe = asObject(await call("list_drawers", { wing, room, limit: 1, offset: 0 }));
  const total = Number(probe.total) || 0;

  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < maxPages && rows.length < total; page += 1) {
    const pageRows = parseRows(await call("list_drawers", { wing, room, limit: pageSize, offset: page * pageSize }));
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  const seen = new Set<string>();
  const uniqueRows = rows.filter((row) => {
    const id = asText(row.drawer_id || row.id).trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const ids = uniqueRows.map((row) => asText(row.drawer_id || row.id).trim());
  return { ids, rows: uniqueRows, total, incomplete: total > uniqueRows.length };
}

/**
 * Best-effort parse of re-mined file names out of the miner's human summary.
 * The output is a capped, not-stable-API string — this is an optimization only;
 * callers fall back to conservative invalidation when it yields nothing.
 */
export function parseReminedFilesFromMineOutput(output: unknown): string[] {
  const text = asText(output);
  if (!text) return [];
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    // Per-file miner lines look like "[DRY RUN] name -> room:x (n drawers)" or
    // "name -> room:x (n drawers)" — take the token before the first " -> ".
    const arrow = line.indexOf(" -> ");
    if (arrow <= 0) continue;
    let name = line.slice(0, arrow).trim();
    name = name.replace(/^\[DRY RUN\]\s*/i, "").replace(/^\[MINE\]\s*/i, "");
    // Keep only plausible file names (has a dot extension, no spaces).
    if (!name || /\s/.test(name) || !/\.[A-Za-z0-9]{1,8}$/.test(name)) continue;
    names.add(name);
  }
  return [...names];
}

/** Open outgoing facts for one entity (all predicates), tolerant of failure. */
async function openOutgoingFacts(call: CallTool, drawerId: string): Promise<Record<string, unknown>[] | null> {
  let facts: Record<string, unknown>[];
  try {
    facts = parseFacts(
      await call("kg_query", { entity: drawerId, direction: "outgoing", recurse: false }),
    );
  } catch {
    return null; // query failed — count as fact_check_failed, never guess
  }
  return facts.filter((fact) => {
    const subject = asText(fact.subject || fact.source || fact.from || fact.head || fact.entity).trim();
    if (subject !== drawerId) return false;
    return fact.current === true;
  });
}

/**
 * Staleness pass for one changed drawer: invalidate every open outgoing fact
 * (broad predicate scope — the content changed, so any fact derived from it is
 * suspect), then re-stamp the owned axis `es-source-type: doc`. Best-effort
 * throughout; counts are returned, never thrown.
 */
export async function invalidateAndRestamp(
  call: CallTool,
  drawerId: string,
): Promise<{ invalidated: number; invalidateFailed: number; factCheckFailed: boolean; restamped: boolean; stampFailed: boolean }> {
  const facts = await openOutgoingFacts(call, drawerId);
  if (facts === null) return { invalidated: 0, invalidateFailed: 0, factCheckFailed: true, restamped: false, stampFailed: false };

  let invalidated = 0;
  let invalidateFailed = 0;
  for (const fact of facts) {
    const predicate = asText(fact.predicate || fact.relation || fact.type).trim();
    const object = asText(fact.object || fact.target || fact.to || fact.tail || fact.value).trim();
    if (!predicate || !object) continue;
    try {
      await call("kg_invalidate", { subject: drawerId, predicate, object });
      invalidated += 1;
    } catch {
      invalidateFailed += 1;
    }
  }

  let restamped = false;
  let stampFailed = false;
  try {
    await call("kg_add", { subject: drawerId, predicate: "es-source-type", object: "doc", source_closet: drawerId });
    restamped = true;
  } catch {
    stampFailed = true;
  }

  return { invalidated, invalidateFailed, factCheckFailed: false, restamped, stampFailed };
}

// ── Phase 11: es-staleness axis (soft flagging of concerned syntheses) ────────
// `es-staleness` is a cross-type KG edge, NOT lineage: it must never count toward
// height or feed any lineage traversal. One-hop by design — a staleness flag is a
// single marker on the node whose basis moved. The subject is the flagged synthesis;
// the object is the flag value (`source-changed`). Flagging is SOFT: this pass NEVER
// invalidates or deletes a synthesis node or any of its lineage (the synthesis may
// still be correct — silent deletion of possibly-good knowledge is worse than a flag).

export const STALENESS_PREDICATE = "es-staleness";
export const STALENESS_SOURCE_CHANGED = "source-changed";

/**
 * Read a node's current es-staleness value (single-marker axis), tolerant of
 * failure. Mirrors `setStalenessFlag`'s read side in adapter/memgraph.ts: one-hop
 * outgoing, predicate-scoped to `es-staleness`, open facts only; the first value
 * wins. Returns null when unflagged OR when the query itself failed — the writer
 * treats both as "no known prior", which is safe: a stale read can at worst leave
 * one extra retired marker, never invalidate anything but es-staleness.
 */
export async function currentStalenessValue(call: CallTool, nodeId: string): Promise<string | null> {
  let facts: Record<string, unknown>[];
  try {
    facts = parseFacts(
      await call("kg_query", { entity: nodeId, direction: "outgoing", predicate: STALENESS_PREDICATE, recurse: false }),
    );
  } catch {
    return null; // read failure degrades to "no known prior" — never aborts the pass
  }
  for (const fact of facts) {
    if (fact.current !== true) continue;
    const predicate = asText(fact.predicate || fact.relation || fact.type).trim();
    if (predicate !== STALENESS_PREDICATE) continue;
    const subject = asText(fact.subject || fact.source || fact.from || fact.head || fact.entity).trim();
    if (subject !== nodeId) continue;
    const value = asText(fact.object || fact.target || fact.to || fact.tail || fact.value).trim();
    if (value) return value;
  }
  return null;
}

/**
 * Open incoming `concerns` targets for one doc drawer (the syntheses that reference
 * it), tolerant of failure. Returns null when the query itself failed — callers must
 * treat that as "unknown", never as "no concerns". Deduped, order-preserving.
 */
export async function openIncomingConcerns(call: CallTool, docDrawerId: string): Promise<string[] | null> {
  let facts: Record<string, unknown>[];
  try {
    facts = parseFacts(
      await call("kg_query", { entity: docDrawerId, direction: "incoming", predicate: "concerns", recurse: false }),
    );
  } catch {
    return null; // query failed — count as concerns_check_failed, never guess
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.current !== true) continue;
    const predicate = asText(fact.predicate || fact.relation || fact.type).trim();
    if (predicate !== "concerns") continue;
    // Incoming: the doc is the object; the synthesis is the subject.
    const target = asText(fact.subject || fact.source || fact.from || fact.head || fact.entity).trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * Phase 11 synthesis staleness pass for ONE changed doc drawer: find incoming
 * `concerns` edges (syntheses referencing this doc) and soft-flag each one
 * `es-staleness: source-changed`.
 *
 * Single-marker discipline (mirrors `setStalenessFlag` in adapter/memgraph.ts, which
 * the tool-level call transport cannot invoke directly): read the node's current
 * es-staleness value first; if it already equals `source-changed`, do NOTHING
 * (idempotent re-run — no duplicate write); if a DIFFERENT open value exists,
 * invalidate ONLY that prior `es-staleness` fact before adding. The invalidation is
 * scoped to predicate `es-staleness` alone — never synthesis lineage or any other
 * axis. Best-effort throughout; counts are returned, never thrown.
 */
export async function flagConcernedSyntheses(
  call: CallTool,
  docDrawerId: string,
  sourceRunId?: string,
): Promise<{ concernsChecked: number; flagged: number; flagFailed: number; skippedNonSynthesis: number }> {
  const targets = await openIncomingConcerns(call, docDrawerId);
  if (targets === null) return { concernsChecked: 0, flagged: 0, flagFailed: 1, skippedNonSynthesis: 0 };

  let flagged = 0;
  let flagFailed = 0;
  let skippedNonSynthesis = 0;
  for (const synthesisId of targets) {
    // A synthesis node is drawer-shaped (`drawer_…`). Anything else that points at
    // the doc via `concerns` is not a valid staleness subject — skip, don't flag.
    if (!synthesisId.startsWith("drawer_")) {
      skippedNonSynthesis += 1;
      continue;
    }
    try {
      const previous = await currentStalenessValue(call, synthesisId);
      if (previous === STALENESS_SOURCE_CHANGED) {
        // Already current — no invalidation, no duplicate write.
        flagged += 1;
        continue;
      }
      if (previous) {
        // A different open marker exists: retire ONLY the prior es-staleness fact.
        await call("kg_invalidate", { subject: synthesisId, predicate: STALENESS_PREDICATE, object: previous });
      }
      await call("kg_add", {
        subject: synthesisId,
        predicate: STALENESS_PREDICATE,
        object: STALENESS_SOURCE_CHANGED,
        source_closet: synthesisId,
        ...(sourceRunId ? { source_run_id: sourceRunId } : {}),
      });
      flagged += 1;
    } catch {
      flagFailed += 1; // counted, never aborts the pass
    }
  }
  return { concernsChecked: targets.length, flagged, flagFailed, skippedNonSynthesis };
}

/**
 * The ingest core (exported for unit testing).
 *
 * Dry-run (default): READS ONLY — taxonomy, bounded pre-snapshot of the destination
 * room. No mine call, no KG writes. Returns a plan + next_step.
 *
 * Apply: pre-snapshot → `mine {source, mode:"projects", wing, dry_run:false}` →
 * post-snapshot → invalidate open outgoing facts on changed drawer IDs (bounded) →
 * re-stamp `es-source-type: doc` on them → soft-flag syntheses whose `concerns`
 * target a changed doc with `es-staleness: source-changed` (flag only, never
 * invalidates a synthesis or its lineage).
 */
export async function runDocIngest(args: {
  call: CallTool;
  path: string;
  wing?: string;
  room?: string;
  pageSize?: number;
  maxPages?: number;
  concurrency?: number;
  maxChanged?: number;
  dryRun?: boolean;
}): Promise<IngestReport> {
  const wing = String(args.wing || "").trim();
  if (!wing) throw new Error("ingest_docs: wing is required (no project wing resolved)");
  const path = resolvePath(String(args.path || "").trim());
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`ingest_docs: path must be an existing directory: ${path}`);
  }

  const pageSize = clampNumber(args.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const maxPages = clampNumber(args.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
  const concurrency = clampNumber(args.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const maxChanged = clampNumber(args.maxChanged, DEFAULT_MAX_CHANGED, 1, MAX_MAX_CHANGED);
  const dryRun = args.dryRun !== false;

  const taxonomy = parseTaxonomy(await args.call("get_taxonomy", {}));
  const wingEntry = taxonomy.find((entry) => entry.wing === wing);
  if (!wingEntry) {
    return {
      ok: false,
      wing,
      room: REFERENCE_ROOM,
      path,
      dry_run: dryRun,
      error: "Wing not found in taxonomy — check the name and retry.",
      next_step: "Fix the wing name (or set ESHEPHERD_PROJECT_WING) and re-run.",
    };
  }

  const explicitRoom = String(args.room || "").trim();
  const { room, reused } = explicitRoom ? { room: explicitRoom, reused: true } : pickReferenceRoom(wingEntry.rooms);

  if (dryRun) {
    // READS ONLY. The pre-snapshot is what a re-ingest would diff against; it costs
    // the same bounded page walk as the apply path and tells the user how much of
    // the destination room the run can see.
    const pre = await boundedIdSnapshot(args.call, wing, room, pageSize, maxPages);
    return {
      ok: true,
      wing,
      room,
      path,
      dry_run: true,
      pre_snapshot: { total: pre.total, covered: pre.ids.length, incomplete: pre.incomplete },
      next_step:
        `Apply will mine ${path} into ${wing}/${room} (reused=${reused}), re-mine changed files ` +
        `(mtime-detected by the substrate; unchanged files are skipped), invalidate KG facts on drawers whose content changed, ` +
        `re-stamp es-source-type: doc, and soft-flag syntheses that concern a changed doc with es-staleness: source-changed. ` +
        `Re-run with dry_run:false to apply.`,
    };
  }

  // ---- APPLY: mine first, then invalidate (never the reverse). ----
  const pre = await boundedIdSnapshot(args.call, wing, room, pageSize, maxPages);

  let mineResult: unknown;
  try {
    mineResult = await args.call("mine", { source: path, mode: "projects", wing, dry_run: false });
  } catch (error) {
    return {
      ok: false,
      wing,
      room,
      path,
      dry_run: false,
      pre_snapshot: snapshotSummary(pre),
      error: `mine failed: ${asText((error as Error | undefined)?.message || error).slice(0, 500)}`,
      next_step: "Mine aborted — nothing else ran. Re-run /ingest-docs to retry.",
    };
  }

  const mineObj = asObject(mineResult);
  if (mineObj.success === false) {
    return {
      ok: false,
      wing,
      room,
      path,
      dry_run: false,
      pre_snapshot: snapshotSummary(pre),
      error: `mine failed: ${asText(mineObj.error || mineResult).slice(0, 500)}`,
      next_step: "Mine aborted — nothing else ran. Re-run /ingest-docs to retry.",
    };
  }

  let post: IdSnapshot;
  try {
    post = await boundedIdSnapshot(args.call, wing, room, pageSize, maxPages);
  } catch (error) {
    return {
      ok: false,
      wing,
      room,
      path,
      dry_run: false,
      pre_snapshot: snapshotSummary(pre),
      error: `post-snapshot failed after mine succeeded: ${asText((error as Error | undefined)?.message || error).slice(0, 300)}`,
      next_step: "New content is live; stale-fact invalidation was skipped. Re-run to complete the staleness pass.",
    };
  }

  // CHANGED = NEW ∪ REMINED. NEW is exact by construction (POST \ PRE). REMINED
  // (same ID, new content) comes from mine-output parsing when possible; otherwise
  // fall back conservatively to all surviving IDs — over-broad, never under-broad.
  const preSet = new Set(pre.ids);
  const postSet = new Set(post.ids);
  const newIds = post.ids.filter((id) => !preSet.has(id));

  const reminedNames = parseReminedFilesFromMineOutput(mineObj.output ?? mineResult);
  let reminedByOutput: string[] = [];
  if (reminedNames.length > 0) {
    // Map re-mined file basenames → post-snapshot drawer IDs. Basename matching is
    // the only cheap enumeration path (MCP responses reduce source_file to basename).
    const bySource = new Map<string, string[]>();
    for (const row of post.rows) {
      const meta = asObject(row.metadata);
      const source = asText(meta.source_file || row.source_file).trim();
      const id = asText(row.drawer_id || row.id).trim();
      if (!source || !id) continue;
      const list = bySource.get(source) || [];
      list.push(id);
      bySource.set(source, list);
    }
    reminedByOutput = [...postSet].filter((id) => {
      for (const [source, ids] of bySource) {
        if (reminedNames.some((name) => source === name || source.endsWith(`/${name}`)) && ids.includes(id)) return true;
      }
      return false;
    });
  }

  const survived = [...postSet].filter((id) => preSet.has(id));
  const useFallback = reminedNames.length === 0;
  const reminedByFallback = useFallback ? survived : [];

  const changedSet = new Set<string>([...newIds, ...reminedByOutput, ...reminedByFallback]);
  let changed = [...changedSet];
  let truncated = false;
  if (changed.length > maxChanged) {
    changed = changed.slice(0, maxChanged);
    truncated = true;
  }

  const totals = { factsInvalidated: 0, invalidateFailed: 0, factCheckFailed: 0, restampedDoc: 0, stampFailed: 0 };
  await mapLimit(changed, concurrency, async (drawerId) => {
    const result = await invalidateAndRestamp(args.call, drawerId);
    totals.factsInvalidated += result.invalidated;
    totals.invalidateFailed += result.invalidateFailed;
    if (result.factCheckFailed) totals.factCheckFailed += 1;
    if (result.restamped) totals.restampedDoc += 1;
    if (result.stampFailed) totals.stampFailed += 1;
  });

  // PHASE 11: soft-flag syntheses whose `concerns` target a changed doc. Runs AFTER
  // the hard invalidation pass so the flag is never swept up in it; bounded by the
  // same maxChanged cap and concurrency pool (one incoming query + one kg_add per
  // hit, no further fan-out). Flag only — no synthesis node or lineage is ever
  // invalidated here.
  const stalenessTotals = { concernsChecked: 0, flagged: 0, flagFailed: 0, skippedNonSynthesis: 0 };
  await mapLimit(changed, concurrency, async (drawerId) => {
    const result = await flagConcernedSyntheses(args.call, drawerId);
    stalenessTotals.concernsChecked += result.concernsChecked;
    stalenessTotals.flagged += result.flagged;
    stalenessTotals.flagFailed += result.flagFailed;
    stalenessTotals.skippedNonSynthesis += result.skippedNonSynthesis;
  });

  const report: IngestReport = {
    ok: true,
    wing,
    room,
    path,
    dry_run: false,
    mine_output: asText(mineObj.output ?? "").slice(0, 400),
    pre_snapshot: snapshotSummary(pre),
    post_snapshot: snapshotSummary(post),
    changed: { new: newIds.length, remined_by_output: reminedByOutput.length, remined_by_fallback: reminedByFallback.length },
    facts_invalidated: totals.factsInvalidated,
    invalidate_failed: totals.invalidateFailed,
    fact_check_failed: totals.factCheckFailed,
    restamped_doc: totals.restampedDoc,
    stamp_failed: totals.stampFailed,
    concerns_checked: stalenessTotals.concernsChecked,
    synthesis_flagged: stalenessTotals.flagged,
    flag_failures: stalenessTotals.flagFailed,
    skipped_non_synthesis: stalenessTotals.skippedNonSynthesis,
    not_covered_by_page_cap: Math.max(0, post.total - post.ids.length),
    truncated,
  };
  if (totals.invalidateFailed > 0 || totals.stampFailed > 0 || totals.factCheckFailed > 0 || stalenessTotals.flagFailed > 0) {
    report.next_step = `Re-run /ingest-docs to retry ${totals.invalidateFailed} failed invalidation(s), ${totals.factCheckFailed} unread drawer(s), ${totals.stampFailed} failed stamp(s), and ${stalenessTotals.flagFailed} failed staleness flag(s).`;
  }
  return report;
}

function snapshotSummary(snapshot: IdSnapshot): { total: number; covered: number; incomplete: boolean } {
  return { total: snapshot.total, covered: snapshot.ids.length, incomplete: snapshot.incomplete };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export default tool({
  description:
    "Phase 3 doc ingestion: mine a docs directory into the project wing's `reference` room via the substrate mine tool (projects mode), stamp every ingested drawer es-source-type: doc, and on re-ingest invalidate stale KG facts on changed drawers (bounded pre/post ID snapshot + id-diff) and soft-flag syntheses that concern a changed doc with es-staleness: source-changed (flag only — never invalidates a synthesis). Reuses an existing reference-like room via get_taxonomy before minting one. Dry-run by default — the first call makes no mutating MCP call; pass dry_run:false to apply.",
  args: {
    path: tool.schema.string().describe("Directory of docs to mine (required)."),
    wing: tool.schema.string().optional().describe("Wing to mine into. Defaults to this project's wing."),
    room: tool.schema.string().optional().describe("Explicit destination room. Default: reuse an existing reference-like room, else `reference`."),
    page_size: tool.schema.number().optional().describe("Drawers per snapshot page (default 50, max 100)."),
    max_pages: tool.schema.number().optional().describe("Maximum snapshot pages per pass (default 4, max 40)."),
    concurrency: tool.schema.number().optional().describe("Parallel staleness checks per changed drawer (default 8, max 16)."),
    max_changed: tool.schema.number().optional().describe("Cap on drawers to invalidate/re-stamp per run (default 500, max 5000)."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
    if (!wing) throw new Error("ingest_docs: wing is required (no project wing resolved)");

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-ingest-docs",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const report = await runDocIngest({
      call,
      path: String(args.path || ""),
      wing,
      room: args.room,
      pageSize: args.page_size,
      maxPages: args.max_pages,
      concurrency: args.concurrency,
      maxChanged: args.max_changed,
      dryRun: args.dry_run,
    });

    return JSON.stringify(report, null, 2);
  },
});
