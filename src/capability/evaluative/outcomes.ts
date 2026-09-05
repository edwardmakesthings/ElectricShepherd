/**
 * Outcome axis — `es-outcome` (human-authoritative outcome feedback).
 *
 * `es-outcome` edges record whether a closet actually helped a unit of work that
 * consulted it. Values: accept | revise | failed | unused. They ACCUMULATE —
 * multiple edges per closet are expected and meaningful (6 accepts + 1 revise is
 * different from 1 accept), so nothing here ever invalidates or collapses them.
 * Writes go through recordOutcome only (the human-authoritative path); this module
 * exposes the read side plus a validated single-edge writer for that path.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { asBoolean, asString, parseKgFacts, uniq } from "../../core/memgraph-transport.ts";

export const OUTCOME_VALUES: readonly string[] = ["accept", "revise", "failed", "unused"];

/**
 * Aggregate es-outcome counts for a bounded set of candidate node ids. One one-hop
 * outgoing kg_query per id, run with bounded concurrency (8 — the only validated
 * level in this repo), never more than `maxNodes` ids. Read failures degrade to
 * zero counts (neutral) per node, matching getClosetSourceType's discipline.
 */
export async function getOutcomeCounts(
  core: MemgraphInternals,
  nodeIds: string[],
  options?: { maxNodes?: number; concurrency?: number },
): Promise<Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>> {
  const ids = uniq(nodeIds).slice(0, Math.max(1, Number(options?.maxNodes ?? 50)));
  const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
  const empty = () => ({ accept: 0, revise: 0, failed: 0, unused: 0, total: 0 });

  const out = new Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>();
  let cursor = 0;
  const run = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      // Degrade to "no history" on read failure (logged).
      const result = await core.kgQueryIgnoringFailure({
        entity: id,
        direction: "outgoing",
        predicate: "es-outcome",
        recurse: false,
        max_depth: 1,
      }, `getOutcomeCounts(${id}) read failure degrades to no history`);
      const counts = empty();
      for (const fact of parseKgFacts(result)) {
        if (!asBoolean(fact.current, true)) continue;
        const value = asString(fact.object).trim();
        if (value === "accept") counts.accept += 1;
        else if (value === "revise") counts.revise += 1;
        else if (value === "failed") counts.failed += 1;
        else if (value === "unused") counts.unused += 1;
        // unknown values are ignored — the axis is closed by construction
      }
      counts.total = counts.accept + counts.revise + counts.failed + counts.unused;
      out.set(id, counts);
    }
  };
  const slots = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: slots }, () => run()));
  return out;
}

/**
 * Record ONE es-outcome edge for a closet (accumulation — never invalidates or
 * overwrites existing edges). `validFrom` timestamps the edge so consumers can
 * window recent history. Throws on an invalid outcome value: the axis is closed to
 * exactly accept | revise | failed | unused, and nothing else may enter it.
 */
export async function recordOutcome(core: MemgraphInternals, nodeId: string, outcome: string, validFrom?: string): Promise<void> {
  const id = asString(nodeId).trim();
  if (!id) throw new Error("recordOutcome: nodeId is required");
  if (!(OUTCOME_VALUES as readonly string[]).includes(outcome)) {
    throw new Error(
      `recordOutcome: invalid outcome "${outcome}" — must be one of ${OUTCOME_VALUES.join(" | ")}`,
    );
  }
  await core.call("kgAdd", {
    subject: id,
    predicate: "es-outcome",
    object: outcome,
    valid_from: validFrom,
    source_closet: id,
  });
}
