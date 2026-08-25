import type { ClosetSourceType, MemgraphClient } from "./memgraph.ts";

export type RetrievalWeights = {
  height: number;
  retrieval: number;
  connection: number;
  lineage: number;
  labelMatch: number;
  seedBoost: number;
  neighborhoodBoost: number;
  alwaysLabeledBoost: number;
  authority: number;
};

// Phase 2 (unified memory): optional retrieval intent. Omitted = no preference.
export type RetrievalIntent = "factual" | "historical" | "procedural";

// Authority dimension: the es-source-type axis, with "unknown" for unstamped nodes
// or read failures (spec: unstamped is never a default type).
export type NodeAuthority = ClosetSourceType | "unknown";

export type RetrievalExpansionOptions = {
  query: string;
  scope_room: string;
  scope_wing?: string;
  wing?: string;
  room?: string;
  match_labels?: string[];
  match_mode?: "any" | "all";
  labeled_only?: boolean;
  include_merged?: boolean;
  include_provisional?: boolean;
  max_depth?: number;
  limit?: number;
  offset?: number;
  seed_search_limit?: number;
  expansion_depth?: number;
  top_n?: number;
  always_include_labels?: string[];
  weights?: Partial<RetrievalWeights>;
  intent?: RetrievalIntent;
};

export type RankedScopedNode = {
  node_id: string;
  labels: string[];
  wing: string;
  room: string;
  desc: string;
  height: number;
  retrieval_count: number;
  connection_degree: number;
  lineage_match_count: number;
  source_type: NodeAuthority;
  score: number;
  selected: boolean;
  // Phase 4: how this node entered the ranked pool. "scoped" = admitted by the
  // derived-drawer scope query; "concern" = admitted as a one-hop `concerns`
  // target of a synthesis already in the pool (its authority doc).
  via?: "scoped" | "concern";
};


export type RetrievalExpansionResult = {
  scope: {
    scope_room: string;
    scope_wing?: string;
    wing?: string;
    room?: string;
  };
  filters: {
    requested_match_labels: string[];
    effective_match_labels: string[];
    dropped_labels_by_policy: string[];
    match_mode: "any" | "all";
    labeled_only: boolean;
    include_merged: boolean;
    include_provisional: boolean;
    intent?: RetrievalIntent;
    max_depth: number;
    limit: number;
    offset: number;
    // Phase 4: envelope honesty for concerns-neighbor expansion.
    concerns_expansion?: { enabled: boolean; targets_admitted: number };
  };
  seeds: {
    query: string;
    raw_seed_ids: string[];
    canonical_seed_ids: string[];
    neighborhood_node_ids: string[];
    // Phase 4: one-hop `concerns` targets admitted into the pool this run.
    concern_neighbor_ids: string[];
  };

  ranking: {
    weights: RetrievalWeights;
    top_n: number;
    always_include_labels: string[];
    total_ranked: number;
  };
  selected_nodes: RankedScopedNode[];
  ranked_nodes: RankedScopedNode[];
};

const DEFAULT_WEIGHTS: RetrievalWeights = {
  height: 3,
  retrieval: 1,
  connection: 1,
  lineage: 2,
  labelMatch: 0.75,
  seedBoost: 2,
  neighborhoodBoost: 1,
  alwaysLabeledBoost: 2,
  authority: 1,
};

// Phase 2 (unified memory): intent -> per-authority-type boost table.
// Magnitudes are secondary to the factual floor below; they only shape ordering
// within what the floor permits. Spec: factual boosts doc then synthesis with
// transcript weakest; historical boosts synthesis and transcript; procedural
// boosts skill then synthesis.
const INTENT_AUTHORITY_BOOSTS: Record<RetrievalIntent, Record<NodeAuthority, number>> = {
  factual: { doc: 2, synthesis: 1, transcript: -1, skill: 0, unknown: 0 },
  historical: { doc: 0, synthesis: 2, transcript: 1, skill: 0, unknown: 0 },
  procedural: { doc: 0, synthesis: 1, transcript: 0, skill: 2, unknown: 0 },
};

/**
 * Phase 2 hard rule (spec): on a factual query a provisional synthesis must never
 * outrank a doc. Encoded as a floor, not a weight — weights can be overwhelmed by a
 * high-height node, so this clamps AFTER all score terms are summed.
 *
 * - FLOOR class: source_type === "doc" (docs are authoritative on arrival; status is
 *   irrelevant for docs).
 * - CEILING class: source_type === "synthesis" && es-status === "provisional".
 * - If both classes are non-empty, every CEILING node scoring above the minimum FLOOR
 *   score is clamped down to that floor. Within-class ordering and all tie-breaks are
 *   untouched; a provisional synth still ranks first when no doc is in the candidate set.
 * - Unstamped ("unknown") nodes are neither class — they rank by score as today.
 *
 * Returns the set of node_ids whose effective sort score was clamped (envelope honesty).
 */
function applyFactualFloor(
  nodes: RankedScopedNode[],
  statuses: ReadonlyMap<string, string>,
): Set<string> {
  const applied = new Set<string>();
  if (nodes.length === 0) return applied;

  let floorMin = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node.source_type === "doc" && node.score < floorMin) {
      floorMin = node.score;
    }
  }
  if (!Number.isFinite(floorMin)) return applied; // no doc in candidates -> nothing to outrank

  for (const node of nodes) {
    const isCeiling = node.source_type === "synthesis" && statuses.get(node.node_id) === "provisional";
    if (isCeiling && node.score > floorMin) {
      node.score = floorMin;
      applied.add(node.node_id);
    }
  }
  return applied;
}

function normalizeLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const cleaned = label.trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeLabelList(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out = new Set<string>();
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (label) out.add(label);
  }
  return [...out].sort();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function collectIdsFromObjects(objects: unknown[]): string[] {
  const out = new Set<string>();
  for (const raw of objects) {
    const obj = asObject(raw);
    for (const key of ["node_id", "drawer_id", "canonical_node_id", "id"]) {
      const val = asString(obj[key]).trim();
      if (val) out.add(val);
    }
  }
  return [...out].sort();
}

function extractSearchSeedIDs(searchResult: unknown): string[] {
  const result = asObject(searchResult);
  const arrays = [
    asArray(result.results),
    asArray(result.nodes),
    asArray(result.drawers),
    asArray(result.matches),
    asArray(result.items),
  ];
  const merged: unknown[] = [];
  for (const arr of arrays) merged.push(...arr);
  return collectIdsFromObjects(merged);
}

function extractNeighborIDs(result: unknown): string[] {
  const obj = asObject(result);
  const arrays = [asArray(obj.ancestors), asArray(obj.descendants), asArray(obj.nodes)];
  const merged: unknown[] = [];
  for (const arr of arrays) merged.push(...arr);
  return collectIdsFromObjects(merged);
}

function extractScopedNodes(result: unknown): RankedScopedNode[] {
  const obj = asObject(result);
  const nodes = asArray(obj.nodes);
  const out: RankedScopedNode[] = [];
  for (const raw of nodes) {
    const n = asObject(raw);
    const node_id = asString(n.node_id).trim();
    if (!node_id) continue;
    out.push({
      node_id,
      labels: normalizeLabelList(n.labels),
      wing: asString(n.wing),
      room: asString(n.room),
      desc: asString(n.desc),
      height: asNumber(n.height),
      retrieval_count: asNumber(n.retrieval_count),
      connection_degree: asNumber(n.connection_degree),
      lineage_match_count: asNumber(n.lineage_match_count),
      source_type: "unknown",
      score: 0,
      selected: false,
    });
  }
  return out;
}

function mergeWeights(overrides: Partial<RetrievalWeights> | undefined): RetrievalWeights {
  return { ...DEFAULT_WEIGHTS, ...(overrides || {}) };
}

function computeNodeScore(args: {
  node: RankedScopedNode;
  weights: RetrievalWeights;
  wantedLabels: Set<string>;
  canonicalSeedIDs: Set<string>;
  neighborhoodIDs: Set<string>;
  alwaysIncludeLabels: Set<string>;
  authorityBoost: number;
}): number {
  const {
    node,
    weights,
    wantedLabels,
    canonicalSeedIDs,
    neighborhoodIDs,
    alwaysIncludeLabels,
    authorityBoost,
  } = args;

  let score = 0;
  score += node.height * weights.height;
  score += Math.log(1 + Math.max(0, node.retrieval_count)) * weights.retrieval;
  score += Math.max(0, node.connection_degree) * weights.connection;
  score += Math.max(0, node.lineage_match_count) * weights.lineage;

  if (wantedLabels.size > 0) {
    const matched = node.labels.filter((label) => wantedLabels.has(label)).length;
    score += matched * weights.labelMatch;
  }

  if (canonicalSeedIDs.has(node.node_id)) {
    score += weights.seedBoost;
  } else if (neighborhoodIDs.has(node.node_id)) {
    score += weights.neighborhoodBoost;
  }

  if (node.labels.some((label) => alwaysIncludeLabels.has(label))) {
    score += weights.alwaysLabeledBoost;
  }

  // Phase 2: intent-based authority term. Zero when no intent is set, so the
  // default path stays byte-identical to the pre-Phase-2 formula.
  score += authorityBoost * weights.authority;

  return score;
}

/**
 * B1: probabilistic entry + deterministic expansion.
 *
 * Entry uses semantic search to find seeds, then expansion deterministically walks
 * canonical lineage neighborhoods and ranks scoped derived drawers with
 * stable tie-breaks.
 */
export async function expandScopedRetrieval(
  client: MemgraphClient,
  options: RetrievalExpansionOptions,
): Promise<RetrievalExpansionResult> {
  const query = options.query?.trim() ?? "";
  if (!query) {
    throw new Error("query is required");
  }
  const scope_room = options.scope_room?.trim() ?? "";
  if (!scope_room) {
    throw new Error("scope_room is required");
  }

  const requestedMatchLabels = normalizeLabelList(options.match_labels || []);
  const alwaysIncludeLabels = normalizeLabelList(options.always_include_labels || ["pinned"]);
  const weights = mergeWeights(options.weights);

  const seedSearchLimit = Math.max(1, Number(options.seed_search_limit ?? 10));
  const maxDepth = Math.max(1, Number(options.max_depth ?? 20));
  const expansionDepth = Math.max(1, Number(options.expansion_depth ?? 2));
  const limit = Math.max(1, Number(options.limit ?? 50));
  const offset = Math.max(0, Number(options.offset ?? 0));
  const topN = Math.max(1, Number(options.top_n ?? 12));
  const matchMode: "any" | "all" = options.match_mode === "all" ? "all" : "any";
  const labeledOnly = Boolean(options.labeled_only);
  const includeMerged = Boolean(options.include_merged);

  const policyResult = asObject(await client.getHallPolicy().catch(() => ({})));
  const allowedLabels = normalizeLabelList(policyResult.allowed_labels);
  const enforced = Boolean(policyResult.enforced);

  let effectiveMatchLabels = requestedMatchLabels;
  let droppedByPolicy: string[] = [];
  if (enforced && allowedLabels.length > 0 && requestedMatchLabels.length > 0) {
    const allowed = new Set(allowedLabels);
    effectiveMatchLabels = requestedMatchLabels.filter((l) => allowed.has(l));
    droppedByPolicy = requestedMatchLabels.filter((l) => !allowed.has(l));
  }

  const searchResult = await client.search(query, seedSearchLimit);
  const rawSeedIDs = extractSearchSeedIDs(searchResult);

  const canonicalSeedSet = new Set<string>();
  for (const seedID of rawSeedIDs) {
    const resolved = asObject(await client.resolveCanonical(seedID).catch(() => ({})));
    const canonical = asString(resolved.canonical_node_id || seedID).trim();
    if (canonical) canonicalSeedSet.add(canonical);
  }

  const neighborhoodSet = new Set<string>();
  for (const canonicalID of canonicalSeedSet) {
    neighborhoodSet.add(canonicalID);
    const [ancestors, descendants] = await Promise.all([
      client.getLineageSources(canonicalID, expansionDepth).catch(() => ({})),
      client.getLineageDerivatives(canonicalID, expansionDepth).catch(() => ({})),
    ]);
    for (const id of extractNeighborIDs(ancestors)) neighborhoodSet.add(id);
    for (const id of extractNeighborIDs(descendants)) neighborhoodSet.add(id);
  }

  const scopedResult = await client.listScopedDerivedDrawers({
    scope_room,
    scope_wing: options.scope_wing,
    wing: options.wing,
    room: options.room,
    match_labels: effectiveMatchLabels,
    match_mode: matchMode,
    labeled_only: labeledOnly,
    include_merged: includeMerged,
    max_depth: maxDepth,
    limit,
    offset,
  });

  const wantedLabelSet = new Set(effectiveMatchLabels);
  const canonicalSeedIDs = new Set([...canonicalSeedSet]);
  const alwaysIncludeLabelSet = new Set(alwaysIncludeLabels);

  const includeProvisional = Boolean(options.include_provisional);
  const intent = options.intent;
  let scopedNodes = extractScopedNodes(scopedResult);
  // P2-2: drop provisional closets before ranking so top-N is computed over active
  // (+ legacy/unstamped "unknown") nodes only. One-hop es-status query per node,
  // run in parallel — vanilla-only. include_provisional=true skips it entirely (zero
  // cost). "unknown" (pre-P2-2 closets) is kept: absence of a stamp is not provisional.
  // Phase 2: the factual floor also needs es-status when provisionals are included, so
  // the status fetch runs whenever intent === "factual". es-source-type is fetched for
  // every node (one parallel one-hop kg_query each, same pattern/cost profile as the
  // existing P2-2 fan-out) so ranked_nodes always expose the authority attribute.
  const needStatuses = !includeProvisional || intent === "factual";
  const statusMap = new Map<string, string>();
  if (scopedNodes.length > 0) {
    const [statuses, sourceTypes] = await Promise.all([
      needStatuses
        ? Promise.all(
            scopedNodes.map((node) => client.getClosetStatus(node.node_id).catch(() => "unknown" as const)),
          )
        : Promise.resolve([]),
      Promise.all(
        scopedNodes.map((node) =>
          client.getClosetSourceType(node.node_id).then((t) => (t ?? "unknown") as NodeAuthority),
        ),
      ),
    ]);
    scopedNodes.forEach((node, i) => {
      node.source_type = sourceTypes[i];
      if (needStatuses) statusMap.set(node.node_id, statuses[i]);
    });
  }
  if (!includeProvisional) {
    scopedNodes = scopedNodes.filter((node) => statusMap.get(node.node_id) !== "provisional");
  }

  // Phase 4: concerns-neighbor expansion. A hit on a synthesis should surface its
  // authority docs, so one-hop `concerns` targets of synthesis-typed pool nodes are
  // admitted into the ranked pool (via: "concern") and get the neighborhood boost.
  // Bounded by construction: one one-hop kg_query per synthesis node in the already-
  // bounded pool (≤ limit, default 50) — same cost profile as the P2-2 fan-out above.
  // Scope guard mirrors listScopedDerivedDrawers (memgraph.ts): a concern target in
  // another wing/room must not leak into this scope's results. The `listScopedDerivedDrawers`
  // gate itself is untouched — docs never enter the pool by loosening it.
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
          if (scope_room && room && room !== scope_room) return;
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

  const rankedNodes = scopedNodes.map((node) => {
    node.score = computeNodeScore({
      node,
      weights,
      wantedLabels: wantedLabelSet,
      canonicalSeedIDs,
      neighborhoodIDs: neighborhoodSet,
      alwaysIncludeLabels: alwaysIncludeLabelSet,
      authorityBoost: intent ? INTENT_AUTHORITY_BOOSTS[intent][node.source_type] : 0,
    });
    return node;
  });

  // Phase 2 hard rule: on factual intent a provisional synthesis must never outrank a
  // doc. Applied AFTER scoring (a floor, not a weight) and BEFORE the sort so all
  // within-class ordering and tie-breaks are preserved. The clamped set doubles as a
  // tie-break guard: when a provisional synth is clamped to EXACTLY a doc's score the two
  // tie, and without this the height tie-break would present the (wrong) synthesis above
  // the actual API reference — precisely the failure mode the rule exists to prevent. So
  // on an equal score, docs sort before clamped provisional synths.
  let clampedFloorIds: ReadonlySet<string> = new Set<string>();
  if (intent === "factual") {
    clampedFloorIds = applyFactualFloor(rankedNodes, statusMap);
  }

  rankedNodes.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Factual floor tie-break: a clamped provisional synth must not present above a doc.
    const aClamped = clampedFloorIds.has(a.node_id);
    const bClamped = clampedFloorIds.has(b.node_id);
    if (aClamped !== bClamped) return aClamped ? 1 : -1;
    if (b.height !== a.height) return b.height - a.height;
    if (b.retrieval_count !== a.retrieval_count) return b.retrieval_count - a.retrieval_count;
    if (b.connection_degree !== a.connection_degree) return b.connection_degree - a.connection_degree;
    return a.node_id.localeCompare(b.node_id);
  });

  const selectedByRank = rankedNodes.slice(0, topN);
  const selectedIDs = new Set(selectedByRank.map((n) => n.node_id));

  for (const node of rankedNodes) {
    if (node.labels.some((l) => alwaysIncludeLabelSet.has(l))) {
      selectedIDs.add(node.node_id);
    }
  }

  const selectedNodes = rankedNodes
    .filter((node) => selectedIDs.has(node.node_id))
    .map((node) => ({ ...node, selected: true }));

  const withSelectionFlag = rankedNodes.map((node) => ({
    ...node,
    selected: selectedIDs.has(node.node_id),
  }));

  return {
    scope: {
      scope_room,
      scope_wing: options.scope_wing,
      wing: options.wing,
      room: options.room,
    },
    filters: {
      requested_match_labels: requestedMatchLabels,
      effective_match_labels: effectiveMatchLabels,
      dropped_labels_by_policy: droppedByPolicy,
      match_mode: matchMode,
      labeled_only: labeledOnly,
      include_merged: includeMerged,
      include_provisional: includeProvisional,
      intent,
      max_depth: maxDepth,
      limit,
      offset,
      concerns_expansion: {
        enabled: concernsEnabled,
        targets_admitted: scopedNodes.filter((n) => n.via === "concern").length,
      },
    },
    policy: {
      enforced,
      allowed_labels: allowedLabels,
    },
    seeds: {
      query,
      raw_seed_ids: rawSeedIDs,
      canonical_seed_ids: [...canonicalSeedSet].sort(),
      neighborhood_node_ids: [...neighborhoodSet].sort(),
      concern_neighbor_ids: [...new Set(concernNeighborIds)].sort(),
    },

    ranking: {
      weights,
      top_n: topN,
      always_include_labels: alwaysIncludeLabels,
      total_ranked: withSelectionFlag.length,
    },
    selected_nodes: selectedNodes,
    ranked_nodes: withSelectionFlag,
  };
}
