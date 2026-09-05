/**
 * Derived-closet creation — the lineage-authority write path.
 *
 * Creates one synthesis drawer and its full lineage: `synthesized-from` edges from
 * the new node to every distinct source drawer (the authority chain) plus a
 * forward `consolidated-into` edge per source for cheap worklist exclusion, then
 * stamps the new closet `provisional` on es-status and `synthesis` on
 * es-source-type. Each stamp is independent best-effort: a failed stamp leaves
 * the axis "unknown" but never fails closet creation — an unstamped closet reads
 * as "unknown" and stays visible.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { addDrawer } from "../../core/memgraph-drawers.ts";
import { asString, uniq } from "../../core/memgraph-transport.ts";

export async function createDerivedDrawer(core: MemgraphInternals, args: {
  wing: string;
  room: string;
  content: string;
  source_drawer_ids: string[];
  desc: string;
  height?: number;
  source_file?: string;
  added_by?: string;
  labels?: string[];
  // P2-3: provenance — the run_id of the consolidation execution
  source_run_id?: string;
}) {
  const sourceDrawerIds = uniq(args.source_drawer_ids || []);
  if (sourceDrawerIds.length === 0) {
    return {
      success: false,
      error: "createDerivedDrawer: at least one source_drawer_id is required",
      lineage_edges_added: 0,
      lineage_errors: ["createDerivedDrawer: at least one source_drawer_id is required"],
    };
  }
  const addResult = await addDrawer(core, {
    wing: args.wing,
    room: args.room,
    content: args.content,
    source_file: args.source_file,
    added_by: args.added_by,
  });
  const id = asString(addResult.drawer_id || addResult.node_id || addResult.id).trim();
  if (!id) {
    return {
      success: false,
      error: "createDerivedDrawer: add_drawer returned no drawer id",
      add_result: addResult,
    };
  }

  const lineageErrors: string[] = [];
  let lineageEdgesAdded = 0;
  for (const sourceId of sourceDrawerIds) {
    // Explicit per-edge failure handling: a failed edge is recorded in
    // `lineageErrors` (operator-visible, returned to the caller) rather than
    // silently dropped. Both edges are attempted independently so one failure
    // never masks the other.
    const synthRes = await core.invoke("kgAdd", {
      subject: id,
      predicate: "synthesized-from",
      object: sourceId,
      source_closet: id,
      source_run_id: args.source_run_id,
    });
    if (synthRes.ok === false) {
      lineageErrors.push(`synthesized-from edge ${id} -> ${sourceId}: ${synthRes.kind}: ${synthRes.detail}`);
      continue;
    }
    // P1-3: forward edge — source drawer → new closet (cheap worklist exclusion)
    const fwdRes = await core.invoke("kgAdd", {
      subject: sourceId,
      predicate: "consolidated-into",
      object: id,
      source_closet: id,
      source_run_id: args.source_run_id,
    });
    if (fwdRes.ok === false) {
      lineageErrors.push(`consolidated-into edge ${sourceId} -> ${id}: ${fwdRes.kind}: ${fwdRes.detail}`);
      continue;
    }
    lineageEdgesAdded += 1;
  }

  // P2-2: stamp the new closet `provisional`. Validation promotes it to `active`
  // once it has >= 2 direct sources; until then it is filtered from default
  // retrieval. Vanilla-only (kg_add). Best-effort: a failed stamp must not fail
  // closet creation — an unstamped closet reads as "unknown" and stays visible.
  const statusStamp = await core.invoke("kgAdd", {
    subject: id,
    predicate: "es-status",
    object: "provisional",
    source_closet: id,
    source_run_id: args.source_run_id,
  });
  if (statusStamp.ok === false) {
    // non-fatal: leave the closet unstamped rather than fail creation (logged).
    console.warn(`[memgraph] es-status stamp failed for ${id} (kind=${statusStamp.kind}), leaving closet unstamped: ${statusStamp.detail}`);
  }

  // Phase 1: stamp the new closet `synthesis` on the es-source-type axis.
  // Independent of the es-status stamp above — one failure never masks the other;
  // a failed stamp leaves the axis "unknown".
  const typeStamp = await core.invoke("kgAdd", {
    subject: id,
    predicate: "es-source-type",
    object: "synthesis",
    source_closet: id,
    source_run_id: args.source_run_id,
  });
  if (typeStamp.ok === false) {
    // non-fatal: leave the closet unstamped rather than fail creation (logged).
    console.warn(`[memgraph] es-source-type stamp failed for ${id} (kind=${typeStamp.kind}), leaving axis unknown: ${typeStamp.detail}`);
  }

  return {
    success: lineageErrors.length === 0,
    node_id: id,
    drawer_id: id,
    lineage_edges_added: lineageEdgesAdded,
    lineage_errors: lineageErrors,
    add_result: addResult,
  };
}
