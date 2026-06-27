import type { MemgraphClient } from "./memgraph.ts";

export type RetrievalWeights = {
  height: number;
  retrieval: number;
  connection: number;
  lineage: number;
  labelMatch: number;
  seedBoost: number;
  neighborhoodBoost: number;
  alwaysLabeledBoost: number;
};

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
  max_depth?: number;
  limit?: number;
  offset?: number;
  seed_search_limit?: number;
  expansion_depth?: number;
  top_n?: number;
  always_include_labels?: string[];
  weights?: Partial<RetrievalWeights>;
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
  score: number;
  selected: boolean;
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
    max_depth: number;
    limit: number;
    offset: number;
  };
  policy: {
    enforced: boolean;
    allowed_labels: string[];
  };
  seeds: {
    query: string;
    raw_seed_ids: string[];
    canonical_seed_ids: string[];
    neighborhood_node_ids: string[];
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
};

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
}): number {
  const { node, weights, wantedLabels, canonicalSeedIDs, neighborhoodIDs, alwaysIncludeLabels } = args;

  let score = 0;
  score += node.height * weights.height;
  score += Math.log1p(Math.max(0, node.retrieval_count)) * weights.retrieval;
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

  const rankedNodes = extractScopedNodes(scopedResult).map((node) => {
    node.score = computeNodeScore({
      node,
      weights,
      wantedLabels: wantedLabelSet,
      canonicalSeedIDs,
      neighborhoodIDs: neighborhoodSet,
      alwaysIncludeLabels: alwaysIncludeLabelSet,
    });
    return node;
  });

  rankedNodes.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
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
      max_depth: maxDepth,
      limit,
      offset,
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
