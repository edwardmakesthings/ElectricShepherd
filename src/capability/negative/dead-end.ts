/**
 * Dead-end filing — the negative-knowledge write path.
 *
 * Files ONE dead end as a negative-polarity synthesis drawer with its `rules-out`
 * edge(s). The drawer is created via createDerivedDrawer (which stamps
 * es-source-type: synthesis and es-status: provisional — dead ends are syntheses,
 * NOT a fourth source type) then gets one outgoing rules-out edge per ruled-out
 * statement plus an optional polarity token. `source_drawer_ids` carry the
 * synthesized-from lineage so the merge/height machinery can reason about it.
 * Best-effort per edge: a failed edge is reported, never aborts the filing.
 */

import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { asString, uniq } from "../../core/memgraph-transport.ts";
import { createDerivedDrawer } from "../episodic/derived-drawer.ts";

export async function fileDeadEnd(core: MemgraphInternals, args: {
  wing: string;
  room: string;
  /** The dead-end line(s), verbatim (tried + outcome clause + reason). One drawer per call. */
  content: string;
  /** Ruled-out statement text(s) — the topic/approach the edge points at. */
  statements: string[];
  /** "tried-failed" | "considered-rejected" (default tried-failed when omitted). */
  polarity?: string;
  source_drawer_ids?: string[];
  desc?: string;
  added_by?: string;
  source_run_id?: string;
}): Promise<{ success: boolean; node_id?: string; rules_out_edges_added: number; errors: string[] }> {
  const statements = uniq(args.statements);
  if (statements.length === 0) {
    return { success: false, rules_out_edges_added: 0, errors: ["fileDeadEnd: at least one ruled-out statement is required"] };
  }

  const created = await createDerivedDrawer(core, {
    wing: args.wing,
    room: args.room,
    content: args.content,
    source_drawer_ids: args.source_drawer_ids || [],
    desc: args.desc || statements[0],
    added_by: args.added_by || "electric-shepherd-dead-ends",
    source_run_id: args.source_run_id,
  });

  const nodeId = asString(created.node_id || created.drawer_id).trim();
  if (!created.success && !nodeId) {
    return { success: false, rules_out_edges_added: 0, errors: [...(created.lineage_errors || []), "fileDeadEnd: drawer creation failed"] };
  }

  const errors: string[] = [];
  let added = 0;
  for (const statement of statements) {
    // Explicit per-edge failure handling: a failed edge is reported in `errors`
    // (operator-visible, returned to the caller), never silently dropped.
    const res = await core.invoke("kgAdd", {
      subject: nodeId,
      predicate: "rules-out",
      object: statement,
      source_closet: nodeId,
      source_run_id: args.source_run_id,
    });
    if (res.ok === false) {
      errors.push(`rules-out edge ${nodeId} -> ${statement}: ${res.kind}: ${res.detail}`);
      continue;
    }
    added += 1;
  }
  const polarity = asString(args.polarity).trim();
  if (polarity === "tried-failed" || polarity === "considered-rejected") {
    const res = await core.invoke("kgAdd", {
      subject: nodeId,
      predicate: "rules-out",
      object: polarity,
      source_closet: nodeId,
      source_run_id: args.source_run_id,
    });
    if (res.ok === false) {
      errors.push(`rules-out edge ${nodeId} -> ${polarity}: ${res.kind}: ${res.detail}`);
    } else {
      added += 1;
    }
  }

  return { success: errors.length === 0 && created.success, node_id: nodeId, rules_out_edges_added: added, errors };
}
