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
import {
  asNumber,
  classifySourceDrawer,
  collapseChunkedSourceItems,
  parseKgFacts,
  parseRawMemoryItems,
  sourceTypeFromFacts,
  uniqueFromFactsByDirection,
} from "../../core/memgraph-transport.ts";
import { listDrawers } from "../../core/memgraph-drawers.ts";
import { getConsolidationStateForDrawers } from "./memgraph-lineage.ts";

function chunkIds(ids: string[], size: number): string[][] {
  if (ids.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
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

  const drawerIds = [...new Set(candidates.map((item) => item.drawer_id).filter(Boolean))];
  const sourceTypeById = new Map<string, ReturnType<typeof sourceTypeFromFacts>>();
  const hasOutgoingSynthById = new Map<string, boolean>();

  for (const chunk of chunkIds(drawerIds, 500)) {
    const sourceTypeResults = await core.kgQueryMany({
      entities: chunk,
      direction: "outgoing",
      predicate: "es-source-type",
      recurse: false,
      max_depth: 1,
    });
    const lineageResults = await core.kgQueryMany({
      entities: chunk,
      direction: "outgoing",
      predicate: "synthesized-from",
      recurse: false,
      max_depth: 1,
    });

    for (const drawerId of chunk) {
      sourceTypeById.set(drawerId, sourceTypeFromFacts(sourceTypeResults[drawerId] || {}));
      const outgoing = uniqueFromFactsByDirection(parseKgFacts(lineageResults[drawerId] || {}), "outgoing");
      hasOutgoingSynthById.set(drawerId, outgoing.length > 0);
    }
  }

  const out: SourceDrawerWorkItem[] = [];
  for (const item of candidates) {
    const sourceType = sourceTypeById.get(item.drawer_id) || null;
    const classification = classifySourceDrawer({
      sourceType,
      hasOutgoingSynthesizedFrom: Boolean(hasOutgoingSynthById.get(item.drawer_id)),
    });

    if (classification.invariantViolation) {
      console.warn(
        "[memory-consolidation-validation] excluding source drawer " + item.drawer_id + ": transcript category with outgoing synthesized-from lineage",
      );
      continue;
    }
    if (sourceType === "skill" || sourceType === null) continue;

    out.push({
      ...item,
      source_class: classification.sourceClass,
    });
  }

  return collapseChunkedSourceItems(out);
}

export async function findUnconsolidatedSourceDrawers(core: MemgraphInternals, args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
  const rawItems = await listSourceDrawersByScope(core, args);
  const familyMemberIds = [...new Set(rawItems.flatMap((item) => (item.family_drawer_ids && item.family_drawer_ids.length > 0
    ? item.family_drawer_ids
    : [item.drawer_id]))
    .filter(Boolean))];
  const consolidated = await getConsolidationStateForDrawers(core, familyMemberIds);
  const out: SourceDrawerWorkItem[] = [];

  for (const item of rawItems) {
    const familyIds = (item.family_drawer_ids && item.family_drawer_ids.length > 0
      ? item.family_drawer_ids
      : [item.drawer_id]);
    const anyUnconsolidated = familyIds.some((memberId) => !consolidated.get(memberId));
    if (anyUnconsolidated) out.push(item);
  }

  return out;
}
