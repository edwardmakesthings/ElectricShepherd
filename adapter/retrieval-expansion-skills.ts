/**
 * Phase 5 + Phase 10/12/P2-1 (unified memory): SKILL admission for scoped retrieval.
 *
 * Two blocks, extracted verbatim from expandScopedRetrieval (retrieval-expansion.ts)
 * so the orchestrator stays a thin pipeline:
 *   - refined-by expansion (procedural intent only): skills are leaves with no
 *     synthesized-from lineage, so they never enter the scoped pool; the one-hop
 *     `refined-by` edge is the bridge. Incoming refined-by on every pool node plus
 *     outgoing refined-by on skill-typed pool nodes; candidates hard-filtered to
 *     es-source-type: skill and scope-guarded (wing only — skills are filed in the
 *     canonical `skills` room, so no room gate). Admitted via: "refined" with a
 *     neighborhood boost.
 *   - shared-skills-wing admission (procedural intent only): promoted skills cross
 *     projects and have no edges into the querying project, so a bounded scan of the
 *     shared wing's `skills` room is the primary admission path (via: "shared").
 *     Phase 12 domain filter + P2-1 promoted-from provenance ride in here too, with
 *     their reporting counters.
 *
 * Both blocks are retrieve-then-filter (one get_drawer + getClosetSourceType per
 * candidate, proportional to edge/page count, never to room size), capability-gated
 * like every expansion (read failures degrade to pre-phase behavior with zero extra
 * calls), and never page past their bounded shape. The synthesized-from gate in
 * listScopedDerivedDrawers is untouched — skills enter by expansion/scan, not by
 * loosening it. Call order and per-node work are unchanged from the original inline
 * blocks, so ranking/filter/envelope behavior is preserved.
 */
import type { MemgraphClient } from "./memgraph.ts";
import { asArray, asNumber, asObject, asString } from "./retrieval-scoring.ts";
import type { RankedScopedNode, RetrievalIntent } from "./retrieval-scoring.ts";
import type { RetrievalExpansionOptions } from "./retrieval-expansion-types.ts";
import { safeListDrawers } from "./retrieval-expansion-core.ts";

/**
 * Phase 5: refined-by-neighbor expansion (procedural intent only). Skills are
 * leaves with no synthesized-from lineage, so they never enter the scoped pool;
 * the one-hop `refined-by` edge is the bridge. Two directions, both bounded by
 * construction (one one-hop kg_query per pool node, ≤ limit):
 *   - incoming refined-by on every pool node: skills that point at this
 *     session/synthesis/apprenticeship drawer as evidence;
 *   - outgoing refined-by on skill-typed pool nodes: the sessions/syntheses it
 *     was refined by (admitted only when they pass the scope guard below).
 * Candidates are hard-filtered to es-source-type: skill (one get_drawer +
 * getClosetSourceType each — retrieve-then-filter, never a room scan), and
 * scope-guarded exactly like the concerns block. The synthesized-from gate in
 * listScopedDerivedDrawers is untouched — skills enter by expansion, not by
 * loosening it. Gated on intent + client capability so non-procedural paths
 * and older clients degrade to pre-Phase-5 behavior with zero extra calls.
 */
export async function expandRefinedNeighbors(
  client: MemgraphClient,
  options: RetrievalExpansionOptions,
  intent: RetrievalIntent | undefined,
  scopedNodes: RankedScopedNode[],
  neighborhoodSet: Set<string>,
): Promise<string[]> {
  const refinedEnabled = typeof client.getRefinedBy === "function";
  let refinedNeighborIds: string[] = [];
  if (intent === "procedural" && refinedEnabled && scopedNodes.length > 0) {
    const candidates = new Set<string>();
    for (const node of scopedNodes) {
      if (node.source_type === "skill" && typeof client.getRefines === "function") {
        const res = await client.getRefines(node.node_id).catch(() => ({ node_ids: [] as string[] }));
        for (const id of res.node_ids ?? []) candidates.add(id);
      }
      const res = await client.getRefinedBy(node.node_id).catch(() => ({ node_ids: [] as string[] }));
      for (const id of res.node_ids ?? []) candidates.add(id);
    }
    const fresh = [...candidates].filter((id) => !scopedNodes.some((n) => n.node_id === id));
    if (fresh.length > 0) {
      refinedNeighborIds = fresh;
      // Retrieve-then-filter: fetch each candidate once (wing/room/desc), keep only
      // skill-stamped candidates that pass the scope filter. Proportional to edge
      // count, never to room size.
      const drawerResults = await Promise.all(
        fresh.map((id) => {
          const drawerP = client.getDrawer({ drawer_id: id }).catch(() => ({}));
          const typeP = client.getClosetSourceType(id).then((t) => t ?? "unknown");
          return Promise.all([drawerP, typeP]);
        }),
      );
      drawerResults.forEach(([drawerRaw, sourceType], i) => {
        const id = fresh[i];
        if (sourceType !== "skill") return; // hard check: only skill-stamped targets qualify
        const drawer = asObject(drawerRaw);
        const wing = asString(drawer.wing || asObject(drawer.metadata).wing);
        const room = asString(drawer.room || asObject(drawer.metadata).room);
        if (options.scope_wing && wing && wing !== options.scope_wing) return;
        // Skills are filed in the canonical `skills` room and should still be
        // admitted for procedural intent even when scope_room is task-specific.
        // Keep the wing guard, but do not room-gate refined skill neighbors.
        scopedNodes.push({
          node_id: id,
          labels: [],
          wing,
          room,
          desc: asString(drawer.desc || drawer.title || drawer.summary),
          height: 0, // refined-by is not lineage — height stays pure synthesized-from
          retrieval_count: asNumber(drawer.retrieval_count || asObject(drawer.metadata).retrieval_count),
          connection_degree: 0,
          lineage_match_count: 0,
          source_type: "skill",
          score: 0,
          selected: false,
          via: "refined",
        });
        neighborhoodSet.add(id); // +neighborhoodBoost, same as concerns neighbors
      });
    }
  }
  return refinedNeighborIds;
}

export type SharedSkillsReport = { wing: string; room: string; drawers_scanned: number; truncated: boolean };

/** Reporting counters for the shared-skills-wing scan (Phase 12 + P2-1). */
export type SharedSkillsCounters = {
  checked: number; // admitted shared skills the promoted-from reader was called for
  withOrigin: number; // of those, how many returned at least one origin
  domainFiltered: number; // skill-eligible candidates dropped by the domain filter
};

/**
 * Phase 10 (unified memory): shared-skills-wing admission (procedural intent ONLY).
 * Skills that cross projects are promoted into a shared skills wing; a "how do I do
 * X" query from ANY project wing must reach them. A freshly promoted skill has no
 * edges into the querying project, so edge-based expansion (refined-by) cannot see it
 * — this bounded room scan is the primary admission path: one page of the shared
 * wing's `skills` room, retrieve-then-filter to es-source-type: skill.
 *
 * The gate is structural and sits at the TOP of the block: non-procedural intents
 * (factual/historical/default) never pay a single shared-wing call and can admit no
 * cross-wing node — a cross-wing search for episodic memory would surface another
 * project's transcripts, the exact failure mode wing-scoping exists to prevent. The
 * hard es-source-type: skill check is the safety net even on procedural intent: an
 * unstamped or transcript-stamped drawer in the shared room is never admitted.
 * Capability-gated like every expansion (listDrawers/getDrawer/getClosetSourceType);
 * read failures degrade to pre-Phase-10 behavior with zero extra calls. Never pages
 * past one bounded page (spec guardrail: no room exhaustion).
 */
export async function admitSharedSkills(
  client: MemgraphClient,
  options: RetrievalExpansionOptions,
  intent: RetrievalIntent | undefined,
  scopedNodes: RankedScopedNode[],
): Promise<{ ids: string[]; report: SharedSkillsReport | undefined; counters: SharedSkillsCounters }> {
  const sharedWing = intent === "procedural" ? String(options.shared_wing || "").trim() : "";
  // Phase 12: domain filter. Capability-gated like every expansion — clients without
  // getClosetDomain degrade to pre-Phase-12 behavior (no filtering, zero extra calls).
  const sharedDomainFilterEnabled = typeof client.getClosetDomain === "function";
  // P2-1: promoted-from provenance reader. Capability-gated like every expansion —
  // clients without getPromotedFrom degrade to pre-P2-1 behavior with zero extra calls.
  const promotedFromEnabled = typeof client.getPromotedFrom === "function";
  const requestingDomain: string = String(options.domain || "").trim();
  let sharedSkillIds: string[] = [];
  let sharedPromotedChecked = 0; // admitted shared skills the reader was called for
  let sharedPromotedWithOrigin = 0; // of those, how many returned at least one origin
  let sharedScanReport: SharedSkillsReport | undefined;
  let sharedDomainFiltered = 0; // skill-eligible candidates dropped by the domain filter
  if (sharedWing && typeof client.listDrawers === "function" && typeof client.getClosetSourceType === "function") {
    const sharedRoom = "skills"; // canonical skills room in the shared wing (Phase 5 convention)
    const pageSize = 50; // same bounded-page shape as the Phase 3 doc scan
    const probe = asObject(await safeListDrawers(client, { wing: sharedWing, room: sharedRoom, limit: 1, offset: 0 }));
    const total = Math.max(0, Number(probe.total) || 0);
    const pageRows = await safeListDrawers(client, { wing: sharedWing, room: sharedRoom, limit: pageSize, offset: 0 });
    const pool = [
      ...asArray(pageRows.drawers),
      ...asArray(pageRows.results),
      ...asArray(pageRows.items),
      ...asArray(pageRows.nodes),
      ...asArray(pageRows.data),
    ];

    // Dedupe by id, drop anything already in the pool.
    const seenRows = new Set<string>(scopedNodes.map((n) => n.node_id));
    const candidates: { id: string; row: Record<string, unknown> }[] = [];
    for (const raw of pool) {
      const row = asObject(raw);
      const id = asString(row.drawer_id || row.node_id || row.id).trim();
      if (!id || seenRows.has(id)) continue;
      seenRows.add(id);
      candidates.push({ id, row });
    }
    sharedScanReport = { wing: sharedWing, room: sharedRoom, drawers_scanned: candidates.length, truncated: total > pool.length };

    const fresh = candidates.filter((c) => !scopedNodes.some((n) => n.node_id === c.id));
    if (fresh.length > 0) {
      // Retrieve-then-filter: fetch each candidate once (wing/room/desc), keep only
      // skill-stamped rows. The wing must be the shared wing — a row claiming any
      // other wing is dropped (no accidental cross-wing leakage from the seed path).
      const results = await Promise.all(
        fresh.map((c) => {
          const drawerP = typeof client.getDrawer === "function" ? client.getDrawer({ drawer_id: c.id }).catch(() => ({})) : Promise.resolve({});
          const typeP = client.getClosetSourceType(c.id).then((t) => t ?? "unknown");
          // Phase 12: one extra one-hop read per candidate, same cost profile as the
          // source-type read above. Read failures degrade to null (unstamped → admitted).
          const domainP = sharedDomainFilterEnabled ? client.getClosetDomain(c.id).catch(() => null) : Promise.resolve(null);
          // P2-1: promoted-from provenance for a (shared) skill candidate. Same cost
          // profile as the source-type read above; read failures degrade to "no origin"
          // (empty list), matching getConcerns' discipline. Metadata only — never feeds
          // admission, scoring, or ranking.
          const promotedP = promotedFromEnabled ? client.getPromotedFrom(c.id).catch(() => ({ node_ids: [] as string[] })) : Promise.resolve({ node_ids: [] as string[] });
          return Promise.all([drawerP, typeP, domainP, promotedP]);
        }),
      );
      results.forEach(([drawerRaw, sourceType, skillDomain, promotedRes], i) => {
        const c = fresh[i];
        if (sourceType !== "skill") return; // hard check: only skill-stamped drawers qualify
        const drawer = asObject(drawerRaw);
        const row = c.row;
        const wing = asString(drawer.wing || asObject(drawer.metadata).wing || row.wing || row.closet || row.namespace);
        if (wing && wing !== sharedWing) return; // must be the shared wing — never another project
        // Phase 12: admit iff unstamped (null), `general`, or matching the requesting
        // domain. An unknown/absent requesting domain admits ONLY null/general — a
        // specific-domain skill is never surfaced to an unclassified project.
        if (sharedDomainFilterEnabled && skillDomain !== null && skillDomain !== "general" && skillDomain !== requestingDomain) {
          sharedDomainFiltered += 1;
          return;
        }
        const room = asString(drawer.room || asObject(drawer.metadata).room || row.room);
        scopedNodes.push({
          node_id: c.id,
          labels: [], // foreign hall labels are deliberately ignored (no cross-wing label leakage)
          wing,
          room,
          desc: asString(drawer.desc || drawer.title || drawer.summary || row.desc || row.title || row.summary),
          height: 0, // shared admission is not lineage — height stays pure synthesized-from
          retrieval_count: asNumber(drawer.retrieval_count || asObject(drawer.metadata).retrieval_count || row.retrieval_count),
          connection_degree: 0,
          lineage_match_count: 0,
          source_type: "skill",
          score: 0,
          selected: false,
          via: "shared",
          // P2-1: provenance metadata — the originating project skill drawer(s) this
          // shared copy was promoted from. Absent when the reader is unavailable or
          // returned nothing (byte-identical to pre-P2-1 nodes).
          ...(promotedFromEnabled && promotedRes.node_ids.length > 0 ? { promoted_from: [...promotedRes.node_ids] } : {}),
        });
        sharedSkillIds.push(c.id);
        if (promotedFromEnabled) {
          sharedPromotedChecked += 1;
          if (promotedRes.node_ids.length > 0) sharedPromotedWithOrigin += 1;
        }
      });
    }
  }
  return {
    ids: sharedSkillIds,
    report: sharedScanReport,
    counters: { checked: sharedPromotedChecked, withOrigin: sharedPromotedWithOrigin, domainFiltered: sharedDomainFiltered },
  };
}
