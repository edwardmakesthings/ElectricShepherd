/**
 * Source-scope worklist listing — the read side of consolidation intake.
 *
 * Lists source drawers in a wing/room scope (with chunked-source collapsing) and
 * filters out those already consolidated into a derived closet. The filter is a
 * one-hop lineage inspection per drawer; a failed inspection keeps the item in
 * the worklist so consolidation does not silently miss evidence.
 */

import type { ListSourceScopeArgs, SourceDrawerWorkItem } from "../../core/memgraph-structure.ts";
import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { asNumber, collapseChunkedSourceItems, parseKgFacts, parseRawMemoryItems, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";
import { listDrawers } from "../../core/memgraph-drawers.ts";
import { isSourceDrawerConsolidated } from "./memgraph-lineage.ts";

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
