/**
 * Closet source-type axis — `es-source-type`.
 *
 * The `es-source-type` KG fact records what KIND of material a closet holds
 * (transcript | doc | synthesis | skill). It is stamped at write time, never
 * conflated with `es-status` — each setter scopes its kg_invalidate to its own
 * predicate, so the two axes are independently settable by construction.
 */

import type { ClosetSourceType } from "../../core/memgraph-structure.ts";
import { CLOSET_SOURCE_TYPES } from "../../core/memgraph-structure.ts";
import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { parseKgFacts, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

/** Read a closet's es-source-type. Returns null when unstamped or on read failure. */
export async function getClosetSourceType(core: MemgraphInternals, closetId: string): Promise<ClosetSourceType | null> {
  // Degrade to "unstamped" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "es-source-type",
    recurse: false,
    max_depth: 1,
  }, `getClosetSourceType(${closetId}) read failure degrades to unstamped`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  for (const value of values) {
    if ((CLOSET_SOURCE_TYPES as readonly string[]).includes(value)) return value as ClosetSourceType;
  }
  return null;
}

/**
 * Set a closet's es-source-type, invalidating any previous value first
 * (best-effort). Returns true on success, false on failure — never throws in
 * the normal flow. Does not touch `es-status` facts.
 */
export async function setClosetSourceType(core: MemgraphInternals, closetId: string, sourceType: ClosetSourceType, sourceRunId?: string): Promise<boolean> {
  const previous = await getClosetSourceType(core, closetId);
  if (previous === sourceType) return true;
  if (previous && previous !== sourceType) {
    const supersedeRes = await core.invoke("kgSupersede", {
      subject: closetId,
      predicate: "es-source-type",
      old_object: previous,
      new_object: sourceType,
      source_closet: closetId,
      source_run_id: sourceRunId,
    });
    if (supersedeRes.ok === false) {
      console.warn(`[memgraph] es-source-type supersede for ${closetId} (${previous} -> ${sourceType}) failed (kind=${supersedeRes.kind}), leaving axis unchanged: ${supersedeRes.detail}`);
      return false;
    }
    return true;
  }
  const addRes = await core.invoke("kgAdd", {
    subject: closetId,
    predicate: "es-source-type",
    object: sourceType,
    source_closet: closetId,
    source_run_id: sourceRunId,
  });
  if (addRes.ok === false) {
    // non-fatal: leave the closet unstamped rather than fail the caller (logged).
    console.warn(`[memgraph] es-source-type set for ${closetId} failed (kind=${addRes.kind}), leaving axis unknown: ${addRes.detail}`);
    return false;
  }
  return true;
}
