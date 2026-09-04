/**
 * Phase 4 + Phase 3 close-out (unified memory): DOC admission for scoped retrieval.
 *
 * Two blocks, extracted verbatim from expandScopedRetrieval (retrieval-expansion.ts)
 * so the orchestrator stays a thin pipeline:
 *   - concerns-neighbor expansion: a hit on a synthesis surfaces its one-hop
 *     `concerns` authority docs (via: "concern", neighborhood boost).
 *   - direct doc scan: standalone docs have no lineage edge, so listScopedDerivedDrawers
 *     never admits them; on factual intent (or explicit include_docs) the scope room(s)
 *     are scanned (bounded pages) and doc-stamped drawers admitted (via: "doc").
 *
 * Both blocks are retrieve-then-filter (one get_drawer + getClosetSourceType per
 * candidate, proportional to edge/page count, never to room size), hard-filtered to
 * es-source-type: doc, and scope-guarded exactly like listScopedDerivedDrawers. The
 * synthesized-from gate in listScopedDerivedDrawers is untouched — docs enter by
 * expansion/scan, not by loosening it. Call order and per-node work are unchanged from
 * the original inline blocks, so ranking/filter/envelope behavior is preserved.
 */
import type { MemgraphClient } from "./memgraph.ts";
import { asArray, asNumber, asObject, asString } from "./retrieval-scoring.ts";
import type { RankedScopedNode, RetrievalIntent } from "./retrieval-scoring.ts";
import type { RetrievalExpansionOptions } from "./retrieval-expansion-types.ts";
import { safeListDrawers } from "./retrieval-expansion-core.ts";

export type DocScanReport = { rooms_scanned: string[]; drawers_scanned: number; truncated: boolean };

/**
 * Phase 4: concerns-neighbor expansion. A hit on a synthesis should surface its
 * authority docs, so one-hop `concerns` targets of synthesis-typed pool nodes are
 * admitted into the ranked pool (via: "concern") and get the neighborhood boost.
 * Bounded by construction: one one-hop kg_query per synthesis node in the already-
 * bounded pool (≤ limit, default 50) — same cost profile as the P2-2 fan-out.
 * Scope guard mirrors listScopedDerivedDrawers (memgraph.ts): a concern target in
 * another wing/room must not leak into this scope's results. The `listScopedDerivedDrawers`
 * gate itself is untouched — docs never enter the pool by loosening it.
 */
export async function expandConcernNeighbors(
  client: MemgraphClient,
  options: RetrievalExpansionOptions,
  scopeRoom: string,
  scopedNodes: RankedScopedNode[],
  neighborhoodSet: Set<string>,
): Promise<string[]> {
  const concernsEnabled = typeof client.getConcerns === "function";
  let concernNeighborIds: string[] = [];
  if (concernsEnabled && scopedNodes.length > 0) {
    const synthesisIndices = scopedNodes
      .map((node, i) => (node.source_type === "synthesis" ? i : -1))
      .filter((i) => i >= 0);
    if (synthesisIndices.length > 0) {
      const targets = await Promise.all(
        synthesisIndices.map((i) => client.getConcerns(scopedNodes[i].node_id).catch(() => ({ node_ids: [] as string[] }))),
      );
      const seen = new Set<string>();
      for (const t of targets) {
        for (const id of t.node_ids) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          concernNeighborIds.push(id);
        }
      }

      const fresh = concernNeighborIds.filter((id) => !scopedNodes.some((n) => n.node_id === id));
      if (fresh.length > 0) {
        // Retrieve-then-filter: fetch each target once (wing/room/desc), keep only
        // doc-stamped targets that pass the scope filter. No room scan — one get_drawer
        // per candidate, proportional to edge count, never to room size.
        const drawerResults = await Promise.all(
          fresh.map((id) => {
            const drawerP = client.getDrawer({ drawer_id: id }).catch(() => ({}));
            const typeP = client.getClosetSourceType(id).then((t) => t ?? "unknown");
            return Promise.all([drawerP, typeP]);
          }),
        );
        drawerResults.forEach(([drawerRaw, sourceType], i) => {
          const id = fresh[i];
          if (sourceType !== "doc") return; // hard check: only doc-stamped targets qualify
          const drawer = asObject(drawerRaw);
          const wing = asString(drawer.wing || asObject(drawer.metadata).wing);
          const room = asString(drawer.room || asObject(drawer.metadata).room);
          if (options.scope_wing && wing && wing !== options.scope_wing) return;
          if (scopeRoom && room && room !== scopeRoom) return;
          scopedNodes.push({
            node_id: id,
            labels: [],
            wing,
            room,
            desc: asString(drawer.desc || drawer.title || drawer.summary),
            height: 0, // concerns is not lineage — height stays pure synthesized-from
            retrieval_count: asNumber(drawer.retrieval_count || asObject(drawer.metadata).retrieval_count),
            connection_degree: 0,
            lineage_match_count: 0,
            source_type: "doc",
            score: 0,
            selected: false,
            via: "concern",
          });
          neighborhoodSet.add(id); // +neighborhoodBoost, same as lineage neighbors
        });
      }
    }
  }
  return concernNeighborIds;
}

/**
 * Phase 3 close-out: direct doc admission. Standalone docs have no lineage edge, so
 * listScopedDerivedDrawers never admits them; before a concerns edge exists they are
 * invisible to scoped retrieval. On factual intent (or explicit include_docs), scan
 * the scope room(s) for doc-stamped drawers and admit those not already in the pool
 * (via: "doc"). Bounded by construction: at most max_pages pages of page_size per
 * scanned room — same shape as ingest_docs' boundedIdSnapshot; never pages to
 * exhaustion. Scope guard mirrors listScopedDerivedDrawers: wing/room must match.
 */
export async function admitDirectDocs(
  client: MemgraphClient,
  options: RetrievalExpansionOptions,
  scopeRoom: string,
  intent: RetrievalIntent | undefined,
  scopedNodes: RankedScopedNode[],
): Promise<DocScanReport | undefined> {
  const includeDocs = Boolean(options.include_docs) || intent === "factual";
  let docScanReport: DocScanReport | undefined;
  if (includeDocs && typeof client.listDrawers === "function") {
    // Same room resolution as listScopedDerivedDrawers (memgraph.ts): options.room wins,
    // else scope_room. Wing filter mirrors it too: options.wing wins, else scope_wing.
    const roomsToScan = [options.room?.trim() || scopeRoom];
    const wingFilter = options.wing?.trim() || options.scope_wing?.trim();

    const docPageSize = 50; // same defaults as ingest_docs' boundedIdSnapshot
    const docMaxPages = 4;
    const allRows: unknown[] = [];
    let truncated = false;
    for (const room of roomsToScan) {
      const probe = asObject(await safeListDrawers(client, { wing: wingFilter, room, limit: 1, offset: 0 }));
      const total = Math.max(0, Number(probe.total) || 0);
      for (let page = 0; page < docMaxPages && allRows.length < total; page += 1) {
        const res = await safeListDrawers(client, { wing: wingFilter, room, limit: docPageSize, offset: page * docPageSize });
        const pool = [
          ...asArray(res.drawers),
          ...asArray(res.results),
          ...asArray(res.items),
          ...asArray(res.nodes),
          ...asArray(res.data),
        ];
        allRows.push(...pool);
        if (pool.length < docPageSize) break;
      }
      if (total > allRows.length) truncated = true;
    }

    // Dedupe by id, then hard-filter to doc-stamped drawers in scope. One
    // getClosetSourceType per candidate (one-hop kg_query each) — proportional to the
    // bounded page count, never to palace size.
    const seenRows = new Set<string>();
    const candidates: { id: string; row: Record<string, unknown> }[] = [];
    for (const raw of allRows) {
      const row = asObject(raw);
      const id = asString(row.drawer_id || row.node_id || row.id).trim();
      if (!id || seenRows.has(id)) continue;
      seenRows.add(id);
      candidates.push({ id, row });
    }
    docScanReport = { rooms_scanned: roomsToScan, drawers_scanned: candidates.length, truncated };

    const fresh = candidates.filter((c) => !scopedNodes.some((n) => n.node_id === c.id));
    if (fresh.length > 0) {
      // Retrieve-then-filter: fetch each candidate once (wing/room/desc), keep only
      // doc-stamped rows that pass the scope guard. Unstamped/"unknown" is never a
      // default type — hard filter, same discipline as the concerns block.
      const results = await Promise.all(
        fresh.map((c) => {
          const drawerP = typeof client.getDrawer === "function" ? client.getDrawer({ drawer_id: c.id }).catch(() => ({})) : Promise.resolve({});
          const typeP = client.getClosetSourceType(c.id).then((t) => t ?? "unknown");
          return Promise.all([drawerP, typeP]);
        }),
      );
      results.forEach(([drawerRaw, sourceType], i) => {
        const c = fresh[i];
        if (sourceType !== "doc") return; // hard check: only doc-stamped drawers qualify
        const drawer = asObject(drawerRaw);
        const row = c.row;
        const wing = asString(drawer.wing || asObject(drawer.metadata).wing || row.wing || row.closet || row.namespace);
        const room = asString(drawer.room || asObject(drawer.metadata).room || row.room);
        if (options.scope_wing && wing && wing !== options.scope_wing) return;
        if (scopeRoom && room && room !== scopeRoom) return;
        scopedNodes.push({
          node_id: c.id,
          labels: [],
          wing,
          room,
          desc: asString(drawer.desc || drawer.title || drawer.summary || row.desc || row.title || row.summary),
          height: 0, // doc is not lineage — height stays pure synthesized-from
          retrieval_count: asNumber(drawer.retrieval_count || asObject(drawer.metadata).retrieval_count || row.retrieval_count),
          connection_degree: 0,
          lineage_match_count: 0,
          source_type: "doc",
          score: 0,
          selected: false,
          via: "doc",
        });
        // Deliberately NOT added to neighborhoodSet: no seed/lineage relationship
        // exists. Doc authority comes from the Phase 2 boost table + factual floor,
        // not a free neighborhoodBoost that edge-based paths earn.
      });
    }
  }
  return docScanReport;
}
