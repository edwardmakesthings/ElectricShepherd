/**
 * MemgraphClient lineage / merge / hall method group (Criterion 2 split).
 *
 * Moved verbatim from adapter/memgraph.ts: one-hop edge readers, source-drawer
 * consolidation checks, lineage traversal wrappers, merge review helpers, the
 * scoped derived-drawer listing, and hall labels. Each function takes a
 * `MemgraphInternals` context; the MemgraphClient facade delegates to them.
 */

import type { JsonMap } from "./memgraph-structure.ts";
import { asArray, asBoolean, asNumber, asObject, asString, parseDrawerRows, parseKgFacts, uniq, uniqueFromFactsByDirection } from "./memgraph-transport.ts";
import type { MemgraphInternals } from "./memgraph-internals.ts";

export async function getOutgoingObjects(core: MemgraphInternals, entity: string, predicate: string): Promise<string[]> {
  // Degrade to "no facts" on read failure — the same neutral reading as an empty
  // result for every caller of this helper. The failure is logged (not silent) so a
  // broken substrate cannot masquerade as "this entity has no edges".
  const result = await core.kgQueryIgnoringFailure({
    entity,
    direction: "outgoing",
    predicate,
    recurse: false,
    max_depth: 1,
  }, `getOutgoingObjects(${entity}, ${predicate}) read failure degrades to no facts`);
  return uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
}

export async function isSourceDrawerConsolidated(core: MemgraphInternals, drawerId: string): Promise<boolean> {
  const forward = await getOutgoingObjects(core, drawerId, "consolidated-into");
  if (forward.length > 0) return true;

  // Degrade to "not consolidated" on read failure — the conservative reading for a
  // consolidation worklist (a missed check re-surfaces the drawer next pass). The
  // failure is logged, not silent.
  const incoming = await core.kgQueryIgnoringFailure({
    entity: drawerId,
    direction: "incoming",
    predicate: "synthesized-from",
    recurse: false,
    max_depth: 1,
  }, `isSourceDrawerConsolidated(${drawerId}) read failure degrades to unconsolidated`);
  const incomingSynth = uniqueFromFactsByDirection(parseKgFacts(incoming), "incoming");
  return incomingSynth.length > 0;
}

export async function getLineageSources(core: MemgraphInternals, nodeId: string, maxDepth = 20) {
  const result = await core.kgQuery({
    entity: nodeId,
    direction: "outgoing",
    predicate: "synthesized-from",
    recurse: true,
    max_depth: maxDepth,
  });
  const ancestorIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter((id) => id !== nodeId);
  return {
    node_id: nodeId,
    max_depth: maxDepth,
    ancestors: ancestorIds.map((id) => ({ node_id: id })),
    count: ancestorIds.length,
    facts: result.facts,
  };
}

export async function getLineageDerivatives(core: MemgraphInternals, nodeId: string, maxDepth = 20) {
  const result = await core.kgQuery({
    entity: nodeId,
    direction: "incoming",
    predicate: "synthesized-from",
    recurse: true,
    max_depth: maxDepth,
  });
  const descendantIds = uniqueFromFactsByDirection(parseKgFacts(result), "incoming").filter(
    (id) => id !== nodeId,
  );
  return {
    node_id: nodeId,
    max_depth: maxDepth,
    descendants: descendantIds.map((id) => ({ node_id: id })),
    count: descendantIds.length,
    facts: result.facts,
  };
}

export function applyMerge(core: MemgraphInternals, args: {
  source_node_id: string;
  canonical_node_id: string;
  ended?: string;
  invalidate_source_edges?: boolean;
}) {
  return core.call("applyMerge", args as unknown as JsonMap);
}

export function resolveCanonical(core: MemgraphInternals, nodeId: string, maxHops = 50) {
  return core.call("resolveCanonical", { node_id: nodeId, max_hops: maxHops });
}

export function getHeight(core: MemgraphInternals, nodeId: string) {
  return core.call("getHeight", { node_id: nodeId });
}

export function findMergeCandidates(core: MemgraphInternals, args: {
  drawer_id?: string;
  threshold?: number;
  limit?: number;
  max_nodes?: number;
  max_depth?: number;
  wing?: string;
  room?: string;
  require_topological_distance?: boolean;
}) {
  return core.call("findMergeCandidates", args as unknown as JsonMap);
}

export function findClosetLineageIssues(core: MemgraphInternals, args: {
  wing?: string;
  room?: string;
  include_merged?: boolean;
  limit?: number;
  offset?: number;
}) {
  return core.call("findClosetLineageIssues", args as unknown as JsonMap);
}

export async function getLineageIssues(core: MemgraphInternals, args: {
  wing?: string;
  room?: string;
  include_merged?: boolean;
  limit?: number;
  offset?: number;
}) {
  const result = await findClosetLineageIssues(core, args);
  const rows = asArray((result as JsonMap).orphans).map((row) => asObject(row));
  const normalized = rows.map((row) => ({
    node_id: asString(row.node_id || row.drawer_id || row.id),
    reasons: asArray(row.reasons).map((reason) => asString(reason)).filter(Boolean),
    ...row,
  }));
  return {
    ...result,
    orphans: normalized,
  };
}

export async function listScopedDerivedDrawers(core: MemgraphInternals, args: {
  scope_room: string;
  scope_wing?: string;
  wing?: string;
  room?: string;
  match_labels?: string[];
  match_mode?: "any" | "all";
  labeled_only?: boolean;
  include_merged?: boolean;
  max_depth?: number;
  limit?: number;
  offset?: number;
}) {
  const scopeRoom = args.scope_room?.trim();
  const scopeWing = args.scope_wing?.trim();
  const roomFilter = args.room?.trim() || scopeRoom;
  const wingFilter = args.wing?.trim() || scopeWing;
  const limit = Math.max(1, Number(args.limit ?? 50));
  const offset = Math.max(0, Number(args.offset ?? 0));
  const maxDepth = Math.max(1, Number(args.max_depth ?? 20));

  const listed = await core.call("listDrawers", {
    wing: wingFilter,
    room: roomFilter,
    limit,
    offset,
  });

  const requestedLabels = uniq((args.match_labels || []).map((label) => asString(label).toLowerCase()));
  const matchMode: "any" | "all" = args.match_mode === "all" ? "all" : "any";
  const labeledOnly = Boolean(args.labeled_only);
  const includeMerged = Boolean(args.include_merged);

  const nodes: JsonMap[] = [];
  for (const row of parseDrawerRows(listed)) {
    const nodeId = asString(row.drawer_id || row.node_id || row.id).trim();
    if (!nodeId) continue;

    const rowWing = asString(row.wing || row.closet || row.namespace).trim();
    const rowRoom = asString(row.room).trim();
    if (scopeWing && rowWing && rowWing !== scopeWing) continue;
    if (scopeRoom && rowRoom && rowRoom !== scopeRoom) continue;

    let canonicalNodeId = nodeId;
    if (!includeMerged) {
      // Degrade to "not merged" on read failure (logged): an unreadable node is
      // kept in the listing rather than silently dropped.
      const resolved = asObject(
        await core.callIgnoringFailure("resolveCanonical", { node_id: nodeId }, `listScopedDerivedDrawers canonical check for ${nodeId} degrades to not-merged`),
      );
      canonicalNodeId = asString(resolved.canonical_node_id || nodeId).trim() || nodeId;
      if (canonicalNodeId !== nodeId) continue;
    }

    // Degrade to "no sources" on read failure (logged): an unreadable node is
    // skipped from the derived-drawer listing rather than silently dropped.
    const outgoingSynth = asObject(
      await core.kgQueryIgnoringFailure({
        entity: nodeId,
        direction: "outgoing",
        predicate: "synthesized-from",
        recurse: false,
        max_depth: 1,
      }, `listScopedDerivedDrawers lineage read for ${nodeId} degrades to no sources`),
    );
    const sourceIds = uniqueFromFactsByDirection(parseKgFacts(outgoingSynth), "outgoing");
    if (sourceIds.length === 0) continue;

    // Degrade to "no labels" on read failure (logged).
    const hallFacts = asObject(
      await core.kgQueryIgnoringFailure({
        entity: nodeId,
        direction: "outgoing",
        predicate: "in-hall",
        recurse: false,
        max_depth: 1,
      }, `listScopedDerivedDrawers hall read for ${nodeId} degrades to no labels`),
    );

    const labels = uniqueFromFactsByDirection(parseKgFacts(hallFacts), "outgoing").map((v) => v.toLowerCase());
    if (labeledOnly && labels.length === 0) continue;
    if (requestedLabels.length > 0) {
      const matchCount = labels.filter((label) => requestedLabels.includes(label)).length;
      const passes = matchMode === "all" ? matchCount === requestedLabels.length : matchCount > 0;
      if (!passes) continue;
    }

    // Degrade to height 0 on read failure (logged).
    const heightRes = asObject(
      await core.callIgnoringFailure("getHeight", { node_id: nodeId }, `listScopedDerivedDrawers height read for ${nodeId} degrades to 0`),
    );
    // Degrade to "no connections" on read failure (logged).
    const graphFacts = asObject(
      await core.kgQueryIgnoringFailure({
        entity: nodeId,
        direction: "both",
        recurse: false,
        max_depth: maxDepth,
      }, `listScopedDerivedDrawers graph read for ${nodeId} degrades to no connections`),
    );
    const graphFactCount = parseKgFacts(graphFacts).filter((fact) => asBoolean(fact.current, true)).length;

    nodes.push({
      node_id: nodeId,
      canonical_node_id: canonicalNodeId,
      wing: rowWing || undefined,
      room: rowRoom || undefined,
      desc: asString(row.desc || row.title || row.summary).trim() || undefined,
      content: asString(row.content).trim() || undefined,
      labels,
      height: asNumber(heightRes.height, 0),
      retrieval_count: asNumber(row.retrieval_count || asObject(row.metadata).retrieval_count, 0),
      connection_degree: graphFactCount,
      lineage_match_count: sourceIds.length,
    });
  }

  return {
    nodes,
    count: nodes.length,
    limit,
    offset,
    scope_room: scopeRoom,
    scope_wing: scopeWing,
  };
}

export async function setHallLabels(core: MemgraphInternals, args: {
  node_id: string;
  labels?: string[];
}) {
  const labels = uniq((args.labels || []).map((label) => asString(label).toLowerCase()));
  // Degrade to "no current labels" on read failure (logged): an unreadable node
  // gets the requested labels added rather than being silently left untouched.
  const current = await core.kgQueryIgnoringFailure({
    entity: args.node_id,
    direction: "outgoing",
    predicate: "in-hall",
    recurse: false,
    max_depth: 1,
  }, `setHallLabels current-read for ${args.node_id} degrades to no labels`);

  const currentLabels = uniqueFromFactsByDirection(parseKgFacts(current), "outgoing");
  const toRemove = currentLabels.filter((label) => !labels.includes(label.toLowerCase()));
  const toAdd = labels.filter((label) => !currentLabels.map((v) => v.toLowerCase()).includes(label));

  // Explicit per-label failure handling: failed invalidations/adds are reported in
  // `errors` (operator-visible), never silently dropped. `success` is false if any
  // label operation failed.
  const errors: string[] = [];
  for (const label of toRemove) {
    const res = await core.invoke("kgInvalidate", {
      subject: args.node_id,
      predicate: "in-hall",
      object: label,
    });
    if (res.ok === false) errors.push(`invalidate in-hall ${args.node_id}/${label}: ${res.kind}: ${res.detail}`);
  }

  for (const label of toAdd) {
    const res = await core.invoke("kgAdd", {
      subject: args.node_id,
      predicate: "in-hall",
      object: label,
      source_closet: args.node_id,
    });
    if (res.ok === false) errors.push(`add in-hall ${args.node_id}/${label}: ${res.kind}: ${res.detail}`);
  }

  return {
    success: errors.length === 0,
    node_id: args.node_id,
    labels,
    invalidated_labels: toRemove,
    added_labels: toAdd,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function getHallPolicy(): Promise<{ enforced: boolean; allowed_labels: string[] }> {
  return {
    enforced: false,
    allowed_labels: [
      "hall_facts",
      "hall_events",
      "hall_discoveries",
      "hall_preferences",
      "hall_advice",
    ],
  };
}
