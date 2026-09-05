/**
 * Rules-out axis — `rules-out` (dead-end / negative-knowledge pointer).
 *
 * `rules-out` is a cross-type KG edge, NOT lineage: it must never count toward
 * height or feed getLineageSources/getLineageDerivatives. One-hop by design —
 * recursive rules-out would create cycles through unrelated syntheses. The
 * subject is the dead-end drawer (a synthesis with negative polarity); the object
 * is the ruled-out statement text (free-text by approved Phase 9 design).
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { asBoolean, asString, parseKgFacts, uniq } from "../../core/memgraph-transport.ts";

/**
 * One-hop outgoing `rules-out` facts for a dead-end node: the ruled-out statement
 * texts plus any polarity tokens ("tried-failed" | "considered-rejected"). Degrades
 * to "no rules-out" on read failure, matching getConcerns.
 */
export async function getRulesOut(core: MemgraphInternals, nodeId: string): Promise<{ statements: string[]; polarities: string[]; count: number }> {
  // Degrade to "no rules-out" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "rules-out",
    recurse: false,
    max_depth: 1,
  }, `getRulesOut(${nodeId}) read failure degrades to no rules-out`);
  const statements: string[] = [];
  const polarities: string[] = [];
  for (const fact of parseKgFacts(result)) {
    if (!asBoolean(fact.current, true)) continue;
    const object = asString(fact.object).trim();
    if (!object) continue;
    if (object === "tried-failed" || object === "considered-rejected") polarities.push(object);
    else statements.push(object);
  }
  return { statements: uniq(statements), polarities: uniq(polarities), count: uniq([...statements, ...polarities]).length };
}
