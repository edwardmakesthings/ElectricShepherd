/**
 * Staleness axis — `es-staleness`.
 *
 * `es-staleness` is a cross-type KG edge, NOT lineage: it must never count toward
 * height or feed getLineageSources/getLineageDerivatives. One-hop by design — a
 * staleness flag is a single marker on the node whose basis moved. The subject is
 * the flagged node (typically a synthesis whose `concerns` target changed); the
 * object is the flag value (`source-changed`). Flagging is soft: this axis NEVER
 * invalidates or mutates `es-status`, `es-source-type`, `es-outcome`, `rules-out`,
 * or any lineage predicate — its setter scopes kg_invalidate to `es-staleness`
 * only, same discipline as es-status / es-source-type.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { asString, parseKgFacts, uniq, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

/** Read a node's es-staleness flag. Returns the current value (e.g. "source-changed") or null when unflagged or on read failure. */
export async function getStaleness(core: MemgraphInternals, nodeId: string): Promise<string | null> {
  // Degrade to "unflagged" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "es-staleness",
    recurse: false,
    max_depth: 1,
  }, `getStaleness(${nodeId}) read failure degrades to unflagged`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  return values.length > 0 ? values[0] : null;
}

/**
 * Aggregate es-staleness flags for a bounded set of node ids. One one-hop outgoing
 * kg_query per id, run with bounded concurrency (8 — the only validated level in
 * this repo), never more than `maxNodes` ids. Read failures degrade to null
 * (unflagged) per node, matching getClosetSourceType's discipline.
 */
export async function getStalenessFlags(
  core: MemgraphInternals,
  nodeIds: string[],
  options?: { maxNodes?: number; concurrency?: number },
): Promise<Map<string, string | null>> {
  const ids = uniq(nodeIds).slice(0, Math.max(1, Number(options?.maxNodes ?? 50)));
  const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));

  const out = new Map<string, string | null>();
  let cursor = 0;
  const run = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      // getStaleness already degrades a failed read to null (logged) and never
      // throws, so no wrapper is needed — the aggregate stays neutral per node.
      out.set(id, await getStaleness(core, id));
    }
  };
  const slots = Math.max(1, Math.min(concurrency, ids.length));
  if (ids.length > 0) await Promise.all(Array.from({ length: slots }, () => run()));
  return out;
}

/**
 * Set a node's es-staleness flag. If a previous `es-staleness` value exists and
 * differs, invalidate ONLY the prior `es-staleness` fact(s) for that node — never
 * `es-status`, `es-source-type`, `es-outcome`, `rules-out`, or lineage predicates.
 * Idempotent: when the current value already matches, no invalidation and no
 * duplicate kg_add are issued. Returns true on success, false on failure — never
 * throws in the normal flow.
 */
export async function setStalenessFlag(core: MemgraphInternals, nodeId: string, value: string, sourceRunId?: string): Promise<boolean> {
  const id = asString(nodeId).trim();
  if (!id) return false;
  const previous = await getStaleness(core, id);
  if (previous === value) {
    // Already current — no invalidation, no duplicate write.
    return true;
  }
  if (previous && previous !== value) {
    const supersedeRes = await core.invoke("kgSupersede", {
      subject: id,
      predicate: "es-staleness",
      old_object: previous,
      new_object: value,
      source_closet: id,
      source_run_id: sourceRunId,
    });
    if (supersedeRes.ok === false) {
      console.warn(`[memgraph] es-staleness supersede for ${id} (${previous} -> ${value}) failed (kind=${supersedeRes.kind}), leaving node unchanged: ${supersedeRes.detail}`);
      return false;
    }
    return true;
  }
  const addRes = await core.invoke("kgAdd", {
    subject: id,
    predicate: "es-staleness",
    object: value,
    source_closet: id,
    source_run_id: sourceRunId,
  });
  if (addRes.ok === false) {
    // non-fatal: leave the node unflagged rather than fail the caller (logged).
    console.warn(`[memgraph] es-staleness set for ${id} failed (kind=${addRes.kind}), leaving node unflagged: ${addRes.detail}`);
    return false;
  }
  return true;
}
