/**
 * Refined-by axis — `refined-by` (skill → evidence pointer).
 *
 * `refined-by` is a cross-type KG edge, NOT lineage: it must never count toward
 * height or feed getLineageSources/getLineageDerivatives. One-hop by design —
 * recursive refined-by would create cycles through unrelated sessions/syntheses.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { parseKgFacts, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

/**
 * One-hop incoming `refined-by` subjects for a session/synthesis/apprenticeship
 * node (the skills that point at it as evidence). Degrades to "no refined-by"
 * on read failure, matching getConcerns.
 */
export async function getRefinedBy(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no refined-by" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "incoming",
    predicate: "refined-by",
    recurse: false,
    max_depth: 1,
  }, `getRefinedBy(${nodeId}) read failure degrades to no refined-by`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "incoming").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}

/**
 * One-hop outgoing `refined-by` targets for a skill node (the sessions/syntheses/
 * apprenticeship worked examples that changed how it should work). Degrades to
 * "no refined-by" on read failure, matching getConcerns.
 */
export async function getRefines(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no refined-by" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "refined-by",
    recurse: false,
    max_depth: 1,
  }, `getRefines(${nodeId}) read failure degrades to no refined-by`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}
