/**
 * Promoted-from axis — `promoted-from` (shared skill → origin project skill).
 *
 * `promoted-from` is a cross-type KG edge, NOT lineage: it must never count toward
 * height or feed getLineageSources/getLineageDerivatives. One-hop by design — the
 * origin drawer is a single, stable pointer (a skill is promoted at most once; the
 * duplicate guard in tools/promote_skill.ts keeps exactly one shared copy). The
 * subject is the SHARED wing's skill drawer; the object is the originating project
 * skill drawer, so provenance stays traceable after promotion.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { parseKgFacts, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

/**
 * One-hop `promoted-from` origin for a (shared) skill node: the originating
 * project skill drawer id(s). Degrades to "no origin" on read failure, matching
 * getConcerns. Read-only — promotion itself is written by tools/promote_skill.ts.
 */
export async function getPromotedFrom(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no origin" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "promoted-from",
    recurse: false,
    max_depth: 1,
  }, `getPromotedFrom(${nodeId}) read failure degrades to no origin`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}
