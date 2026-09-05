/**
 * Closet status axis — the `es-status` fact on a synthesis closet.
 *
 * Status is an `es-status` KG fact on the closet, NOT a hall/label (halls are
 * categorization). Written `provisional` at creation, promoted to `active` by
 * validation once the closet has enough DIRECT source support. Every operation
 * here is one-hop kg_query/kg_add/kg_invalidate — vanilla MemPalace only, no
 * dependency on the graph-tools PR — so behavior is identical with or without it.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { parseKgFacts, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

/** Count a closet's DIRECT sources via its outgoing one-hop synthesized-from edges. */
export async function countDirectSources(core: MemgraphInternals, closetId: string): Promise<number> {
  // Degrade to "no direct sources" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "synthesized-from",
    recurse: false,
    max_depth: 1,
  }, `countDirectSources(${closetId}) read failure degrades to zero`);
  return uniqueFromFactsByDirection(parseKgFacts(result), "outgoing")
    .filter((id) => id !== closetId).length;
}

/** Read a closet's es-status. "provisional" | "active" | "unknown" (no stamp / legacy). */
export async function getClosetStatus(core: MemgraphInternals, closetId: string): Promise<"provisional" | "active" | "unknown"> {
  // Degrade to "unknown" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "es-status",
    recurse: false,
    max_depth: 1,
  }, `getClosetStatus(${closetId}) read failure degrades to unknown`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  if (values.includes("active")) return "active";
  if (values.includes("provisional")) return "provisional";
  return "unknown";
}

/** Set a closet's es-status, invalidating the opposite value first. Idempotent-safe. */
export async function setClosetStatus(core: MemgraphInternals, closetId: string, status: "provisional" | "active", sourceRunId?: string): Promise<void> {
  const opposite = status === "active" ? "provisional" : "active";
  // Best-effort invalidation of the opposite value (logged on failure): a stale
  // opposite fact does not block setting the new status — the add below is the
  // authoritative write. The add itself is NOT best-effort: it throws on failure.
  const invalidateRes = await core.invoke("kgInvalidate", { subject: closetId, predicate: "es-status", object: opposite });
  if (invalidateRes.ok === false) {
    console.warn(`[memgraph] es-status invalidation of ${closetId}/${opposite} failed (kind=${invalidateRes.kind}), continuing to set new status: ${invalidateRes.detail}`);
  }
  await core.call("kgAdd", {
    subject: closetId,
    predicate: "es-status",
    object: status,
    source_closet: closetId,
    source_run_id: sourceRunId,
  });
}
