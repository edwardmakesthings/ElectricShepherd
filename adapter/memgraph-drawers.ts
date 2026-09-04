/**
 * MemgraphClient drawer CRUD + KG write + source-scope method group (Criterion 2 split).
 *
 * Moved verbatim from adapter/memgraph.ts: add/checkpoint/update drawer, the
 * namespaced update-drawer fallback, kgAdd/kgSupersede/kgInvalidate wrappers,
 * createDerivedDrawer / fileDeadEnd, search/listDrawers/getDrawer, and the
 * source-scope worklist listing. Each function takes a `MemgraphInternals`
 * context; the MemgraphClient facade delegates to them.
 */

import type { JsonMap, ListSourceScopeArgs, SourceDrawerWorkItem } from "./memgraph-structure.ts";
import { asNumber, asString, collapseChunkedSourceItems, parseRawMemoryItems, uniq, uniqueFromFactsByDirection, parseKgFacts } from "./memgraph-transport.ts";
import type { MemgraphInternals } from "./memgraph-internals.ts";
import { UPDATE_DRAWER_FALLBACK_NAMES } from "../core/substrate-client.ts";
import { isSourceDrawerConsolidated } from "./memgraph-lineage.ts";

export function addDrawer(core: MemgraphInternals, args: {
  wing: string;
  room: string;
  content: string;
  source_file?: string;
  added_by?: string;
  desc?: string;
}) {
  return core.call("addDrawer", args as unknown as JsonMap);
}

export function checkpoint(core: MemgraphInternals, args: {
  items: Array<{
    wing: string;
    room: string;
    content: string;
    source_file?: string;
    added_by?: string;
    desc?: string;
  }>;
  dedup_threshold?: number;
  added_by?: string;
  diary?: {
    agent_name?: string;
    entry?: string;
    topic?: string;
    wing?: string;
  };
}) {
  return core.call("checkpoint", args as unknown as JsonMap);
}

export function updateDrawer(core: MemgraphInternals, args: {
  drawer_id: string;
  content?: string;
  wing?: string;
  room?: string;
}) {
  return callWithUpdateDrawerFallback(core, args as unknown as JsonMap);
}

async function callWithUpdateDrawerFallback(core: MemgraphInternals, args: JsonMap): Promise<JsonMap> {
  const primary = await core.invoke("updateDrawer", args);
  if (primary.ok === false) {
    let lastDetail: string;
    if (!shouldRetryWithDreamNamespacedTool(new Error(primary.detail))) throw new Error(`substrate call failed (update_drawer, kind=${primary.kind}): ${primary.detail}`);
    // The server rejected the prefixed name (not-found / not-allowed): try the
    // namespaced fallback tool names. Each failure is explicit; the last one wins.
    const fallbackNames: string[] = [...UPDATE_DRAWER_FALLBACK_NAMES];
    lastDetail = primary.detail;
    for (const toolName of fallbackNames) {
      const res = await core.invoke(toolName, args);
      if (res.ok === false) {
        lastDetail = res.detail;
      } else {
        return res.value;
      }
    }
    throw new Error(`update_drawer failed via all names (${fallbackNames.join(", ")}): ${lastDetail}`);
  }
  return primary.value;
}

function shouldRetryWithDreamNamespacedTool(err: unknown): boolean {
  const message = String(err || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("not allowed") ||
    message.includes("not found") ||
    message.includes("unknown tool") ||
    message.includes("no such tool")
  );
}

export function kgAdd(core: MemgraphInternals, args: {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;
  source_closet?: string;
  // P2-3: provenance — the run_id of the consolidation execution
  source_run_id?: string;
}) {
  return core.call("kgAdd", args as unknown as JsonMap);
}

export function kgSupersede(core: MemgraphInternals, args: {
  subject: string;
  predicate: string;
  old_object: string;
  new_object: string;
  source_closet?: string;
  source_run_id?: string;
}) {
  return core.call("kgSupersede", args as unknown as JsonMap);
}

export function kgInvalidate(core: MemgraphInternals, args: {
  subject: string;
  predicate: string;
  object: string;
  ended?: string;
}) {
  return core.call("kgInvalidate", args as unknown as JsonMap);
}

export async function createDerivedDrawer(core: MemgraphInternals, args: {
  wing: string;
  room: string;
  content: string;
  source_drawer_ids: string[];
  desc: string;
  height?: number;
  source_file?: string;
  added_by?: string;
  labels?: string[];
  // P2-3: provenance — the run_id of the consolidation execution
  source_run_id?: string;
}) {
  const sourceDrawerIds = uniq(args.source_drawer_ids || []);
  if (sourceDrawerIds.length === 0) {
    return {
      success: false,
      error: "createDerivedDrawer: at least one source_drawer_id is required",
      lineage_edges_added: 0,
      lineage_errors: ["createDerivedDrawer: at least one source_drawer_id is required"],
    };
  }
  const addResult = await addDrawer(core, {
    wing: args.wing,
    room: args.room,
    content: args.content,
    source_file: args.source_file,
    added_by: args.added_by,
  });
  const id = asString(addResult.drawer_id || addResult.node_id || addResult.id).trim();
  if (!id) {
    return {
      success: false,
      error: "createDerivedDrawer: add_drawer returned no drawer id",
      add_result: addResult,
    };
  }

  const lineageErrors: string[] = [];
  let lineageEdgesAdded = 0;
  for (const sourceId of sourceDrawerIds) {
    // Explicit per-edge failure handling: a failed edge is recorded in
    // `lineageErrors` (operator-visible, returned to the caller) rather than
    // silently dropped. Both edges are attempted independently so one failure
    // never masks the other.
    const synthRes = await core.invoke("kgAdd", {
      subject: id,
      predicate: "synthesized-from",
      object: sourceId,
      source_closet: id,
      source_run_id: args.source_run_id,
    });
    if (synthRes.ok === false) {
      lineageErrors.push(`synthesized-from edge ${id} -> ${sourceId}: ${synthRes.kind}: ${synthRes.detail}`);
      continue;
    }
    // P1-3: forward edge — source drawer → new closet (cheap worklist exclusion)
    const fwdRes = await core.invoke("kgAdd", {
      subject: sourceId,
      predicate: "consolidated-into",
      object: id,
      source_closet: id,
      source_run_id: args.source_run_id,
    });
    if (fwdRes.ok === false) {
      lineageErrors.push(`consolidated-into edge ${sourceId} -> ${id}: ${fwdRes.kind}: ${fwdRes.detail}`);
      continue;
    }
    lineageEdgesAdded += 1;
  }

  // P2-2: stamp the new closet `provisional`. Validation promotes it to `active`
  // once it has >= 2 direct sources; until then it is filtered from default
  // retrieval. Vanilla-only (kg_add). Best-effort: a failed stamp must not fail
  // closet creation — an unstamped closet reads as "unknown" and stays visible.
  const statusStamp = await core.invoke("kgAdd", {
    subject: id,
    predicate: "es-status",
    object: "provisional",
    source_closet: id,
    source_run_id: args.source_run_id,
  });
  if (statusStamp.ok === false) {
    // non-fatal: leave the closet unstamped rather than fail creation (logged).
    console.warn(`[memgraph] es-status stamp failed for ${id} (kind=${statusStamp.kind}), leaving closet unstamped: ${statusStamp.detail}`);
  }

  // Phase 1: stamp the new closet `synthesis` on the es-source-type axis.
  // Independent of the es-status stamp above — one failure never masks the other;
  // a failed stamp leaves the axis "unknown".
  const typeStamp = await core.invoke("kgAdd", {
    subject: id,
    predicate: "es-source-type",
    object: "synthesis",
    source_closet: id,
    source_run_id: args.source_run_id,
  });
  if (typeStamp.ok === false) {
    // non-fatal: leave the closet unstamped rather than fail creation (logged).
    console.warn(`[memgraph] es-source-type stamp failed for ${id} (kind=${typeStamp.kind}), leaving axis unknown: ${typeStamp.detail}`);
  }

  return {
    success: lineageErrors.length === 0,
    node_id: id,
    drawer_id: id,
    lineage_edges_added: lineageEdgesAdded,
    lineage_errors: lineageErrors,
    add_result: addResult,
  };
}

/**
 * File ONE dead end as a negative-polarity synthesis drawer with its `rules-out`
 * edge(s). The drawer is created via createDerivedDrawer (which stamps
 * es-source-type: synthesis and es-status: provisional — dead ends are syntheses,
 * NOT a fourth source type) then gets one outgoing rules-out edge per ruled-out
 * statement plus an optional polarity token. `source_drawer_ids` carry the
 * synthesized-from lineage so the merge/height machinery can reason about it.
 * Best-effort per edge: a failed edge is reported, never aborts the filing.
 */
export async function fileDeadEnd(core: MemgraphInternals, args: {
  wing: string;
  room: string;
  /** The dead-end line(s), verbatim (tried + outcome clause + reason). One drawer per call. */
  content: string;
  /** Ruled-out statement text(s) — the topic/approach the edge points at. */
  statements: string[];
  /** "tried-failed" | "considered-rejected" (default tried-failed when omitted). */
  polarity?: string;
  source_drawer_ids?: string[];
  desc?: string;
  added_by?: string;
  source_run_id?: string;
}): Promise<{ success: boolean; node_id?: string; rules_out_edges_added: number; errors: string[] }> {
  const statements = uniq(args.statements);
  if (statements.length === 0) {
    return { success: false, rules_out_edges_added: 0, errors: ["fileDeadEnd: at least one ruled-out statement is required"] };
  }

  const created = await createDerivedDrawer(core, {
    wing: args.wing,
    room: args.room,
    content: args.content,
    source_drawer_ids: args.source_drawer_ids || [],
    desc: args.desc || statements[0],
    added_by: args.added_by || "electric-shepherd-dead-ends",
    source_run_id: args.source_run_id,
  });

  const nodeId = asString(created.node_id || created.drawer_id).trim();
  if (!created.success && !nodeId) {
    return { success: false, rules_out_edges_added: 0, errors: [...(created.lineage_errors || []), "fileDeadEnd: drawer creation failed"] };
  }

  const errors: string[] = [];
  let added = 0;
  for (const statement of statements) {
    // Explicit per-edge failure handling: a failed edge is reported in `errors`
    // (operator-visible, returned to the caller), never silently dropped.
    const res = await core.invoke("kgAdd", {
      subject: nodeId,
      predicate: "rules-out",
      object: statement,
      source_closet: nodeId,
      source_run_id: args.source_run_id,
    });
    if (res.ok === false) {
      errors.push(`rules-out edge ${nodeId} -> ${statement}: ${res.kind}: ${res.detail}`);
      continue;
    }
    added += 1;
  }
  const polarity = asString(args.polarity).trim();
  if (polarity === "tried-failed" || polarity === "considered-rejected") {
    const res = await core.invoke("kgAdd", {
      subject: nodeId,
      predicate: "rules-out",
      object: polarity,
      source_closet: nodeId,
      source_run_id: args.source_run_id,
    });
    if (res.ok === false) {
      errors.push(`rules-out edge ${nodeId} -> ${polarity}: ${res.kind}: ${res.detail}`);
    } else {
      added += 1;
    }
  }

  return { success: errors.length === 0 && created.success, node_id: nodeId, rules_out_edges_added: added, errors };
}

export function search(core: MemgraphInternals, query: string, limit = 5, wing?: string, room?: string) {
  return core.call("search", { query, limit, wing, room });
}

export function listDrawers(core: MemgraphInternals, args: {
  wing?: string;
  room?: string;
  limit?: number;
  offset?: number;
}) {
  return core.call("listDrawers", args as unknown as JsonMap);
}

export function getDrawer(core: MemgraphInternals, args: {
  drawer_id: string;
}) {
  return core.call("getDrawer", args as unknown as JsonMap);
}

export async function listSourceDrawersByScope(core: MemgraphInternals, args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
  const limit = Math.max(1, Math.floor(asNumber(args.limit, 200)));
  const offsetStart = Math.max(0, Math.floor(asNumber(args.offset, 0)));
  const configuredPageSize = Math.max(1, Math.floor(asNumber(args.pageSize, 50)));
  const pageSize = Math.min(limit, configuredPageSize);
  const candidates: SourceDrawerWorkItem[] = [];
  let offset = offsetStart;

  while (candidates.length < limit) {
    const remaining = limit - candidates.length;
    const requestLimit = Math.max(1, Math.min(pageSize, remaining));
    const res = await listDrawers(core, {
      wing: args.wing,
      room: args.room,
      limit: requestLimit,
      offset,
    });
    const pageCandidates = parseRawMemoryItems(res);
    if (pageCandidates.length === 0) break;
    candidates.push(...pageCandidates);
    if (pageCandidates.length < requestLimit) break;
    offset += requestLimit;
  }

  const out: SourceDrawerWorkItem[] = [];

  for (const item of candidates) {
    // Conservative fallback (logged): if lineage inspection fails, keep the item in
    // the raw worklist so consolidation does not silently miss evidence.
    const result = await core.kgQueryIgnoringFailure({
      entity: item.drawer_id,
      direction: "outgoing",
      predicate: "synthesized-from",
      recurse: false,
      max_depth: 1,
    }, `listSourceDrawersByScope(${item.drawer_id}) lineage read failure keeps item in worklist`);
    const sourceIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
    if (sourceIds.length === 0) {
      out.push(item);
    }
  }

  return collapseChunkedSourceItems(out);
}

export async function findUnconsolidatedSourceDrawers(core: MemgraphInternals, args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
  const rawItems = await listSourceDrawersByScope(core, args);
  const out: SourceDrawerWorkItem[] = [];

  for (const item of rawItems) {
    // isSourceDrawerConsolidated already degrades read failures to "unconsolidated"
    // (logged), so a broken substrate re-surfaces the drawer rather than dropping it.
    if (!(await isSourceDrawerConsolidated(core, item.drawer_id))) out.push(item);
  }

  return out;
}
