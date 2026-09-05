/**
 * Concerns axis — `concerns` (synthesis → doc authority pointer).
 *
 * `concerns` is a cross-type KG edge, NOT lineage: it must never count toward
 * height or feed getLineageSources/getLineageDerivatives. One-hop by design —
 * recursive concerns would create cycles through unrelated syntheses.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { parseKgFacts, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

/**
 * One-hop outgoing `concerns` targets for a synthesis node (its authority docs).
 * Degrades to "no concerns" on read failure, matching getOutgoingObjects.
 */
export async function getConcerns(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no concerns" on read failure (logged), matching getOutgoingObjects.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "concerns",
    recurse: false,
    max_depth: 1,
  }, `getConcerns(${nodeId}) read failure degrades to no concerns`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}
