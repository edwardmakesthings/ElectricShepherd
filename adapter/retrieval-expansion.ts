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
  // Phase 7 (unified memory): outcome-feedback term. Weighted BELOW authority by
  // construction — see the clamp in computeNodeScore and DEFAULT_WEIGHTS below.
  outcome: number;
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
  // Phase 3 close-out: admit standalone doc-stamped drawers directly into the pool
  // (bounded room scan) when no concerns edge links them yet. On factual intent this
  // is implied — the flag only matters for non-factual intents that want docs in the
  // ranked pool explicitly.
  include_docs?: boolean;
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
  // target of a synthesis already in the pool (its authority doc); "refined" =
  // admitted as a one-hop `refined-by` neighbor of a pool node on procedural
  // intent (the skill that points at it, or its evidence); "doc" = admitted directly
  // by the Phase 3 close-out bounded room scan (standalone doc-stamped drawer with no
  // lineage edge yet).
  via?: "scoped" | "concern" | "refined" | "doc";
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
    // Phase 5: envelope honesty for refined-by neighbor expansion (procedural intent).
    refined_expansion?: { enabled: boolean; targets_admitted: number };
    // Phase 3 close-out: envelope honesty for the direct doc room scan.
    doc_scan?: {
      enabled: boolean;
      rooms_scanned: string[];
      drawers_scanned: number;
      targets_admitted: number;
      truncated: boolean;
    };
    // Phase 7 (unified memory): envelope honesty for the outcome-feedback ranking
    // term. `applied` is true only when at least one ranked node carried es-outcome
    // history that moved its score; `nodes_with_history` counts how many did.
    outcome_expansion?: {
      enabled: boolean;
      applied: boolean;
      nodes_with_history: number;
      weight: number;
    };
  };
  seeds: {
    query: string;
    raw_seed_ids: string[];
    canonical_seed_ids: string[];
    neighborhood_node_ids: string[];
    // Phase 4: one-hop `concerns` targets admitted into the pool this run.
    concern_neighbor_ids: string[];
    // Phase 5: one-hop `refined-by` neighbors seen on procedural intent (admitted or not).
    refined_neighbor_ids?: string[];
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
  // Phase 7: outcome term. The raw net (accepts − revises − failures) is clamped to
  // ±2 before weighting, so the maximum outcome contribution is 2 * 0.5 = 1 — strictly
  // below the authority boost range (±2 * 1). A node with zero outcome history gets
  // exactly 0 from this term (neutral), and a doc with no history still outranks a
  // synthesis with two accepts on a factual query (the spec's worked example).
  outcome: 0.5,
};

// Phase 7 (unified memory): es-outcome axis. Values are written ONLY by the
// human-authoritative record_outcome path (no automatic failed/accept writes from
// test or reviewer signals). Ranking semantics: accept is positive; revise and
// failed are negative (repeated revise penalises); unused is neutral — a loop/spiral
// intervention alone maps toward "unused" unless a hard failure was human-confirmed.
export const OUTCOME_VALUES = ["accept", "revise", "failed", "unused"] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

export type OutcomeCounts = {
  accept: number;
  revise: number;
  failed: number;
  unused: number;
  total: number;
};

/** Empty outcome history — the neutral state. */
export function emptyOutcomeCounts(): OutcomeCounts {
  return { accept: 0, revise: 0, failed: 0, unused: 0, total: 0 };
}

/**
 * Phase 7 ranking term. Net = accepts − (revises + failures); `unused` is neutral by
 * policy (evidence only, no signal of its own). The net is clamped to ±2 so outcome
 * ACCUMULATION can never overwhelm authority: max contribution is 2 * weights.outcome
 * (= 1 at defaults), strictly below the authority boost range (±2 * weights.authority).
 * Zero history returns exactly 0 — nodes without es-outcome edges are unaffected.
 */
export function outcomeScoreTerm(counts: OutcomeCounts, weight: number): number {
  const net = counts.accept - (counts.revise + counts.failed);
  const clamped = Math.max(-2, Math.min(2, net));
  return clamped * weight;
}

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

// Tolerant list_drawers wrapper for the Phase 3 doc scan: a failed page probe or
// fetch degrades to an empty result instead of aborting retrieval. (The `as` cast
// cannot sit inside a .catch() arrow — Node's type-stripping rejects it — so the
// fallback is shaped here.)
async function safeListDrawers(
  client: MemgraphClient,
  args: { wing?: string; room?: string; limit: number; offset: number },
): Promise<Record<string, unknown>> {
  try {
    return (await client.listDrawers(args)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function computeNodeScore(args: {
  node: RankedScopedNode;
  weights: RetrievalWeights;
  wantedLabels: Set<string>;
  canonicalSeedIDs: Set<string>;
  neighborhoodIDs: Set<string>;
  alwaysIncludeLabels: Set<string>;
  authorityBoost: number;
  outcomeCounts?: OutcomeCounts;
}): number {
  const {
    node,
    weights,
    wantedLabels,
    canonicalSeedIDs,
    neighborhoodIDs,
    alwaysIncludeLabels,
    authorityBoost,
    outcomeCounts,
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

  // Phase 7: outcome-feedback term. Weighted below authority (clamped net * weight,
  // max magnitude strictly under one full authority boost) and added BEFORE the
  // factual floor clamp, so the doc-over-provisional-synthesis invariant is intact.
  // Zero-history nodes get exactly 0 here — neutral by construction.
  if (outcomeCounts && outcomeCounts.total > 0) {
    score += outcomeScoreTerm(outcomeCounts, weights.outcome);
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

  // Phase 3 close-out: direct doc admission. Standalone docs have no lineage edge, so
  // listScopedDerivedDrawers never admits them; before a concerns edge exists they are
  // invisible to scoped retrieval. On factual intent (or explicit include_docs), scan
  // the scope room(s) for doc-stamped drawers and admit those not already in the pool
  // (via: "doc"). Bounded by construction: at most max_pages pages of page_size per
  // scanned room — same shape as ingest_docs' boundedIdSnapshot; never pages to
  // exhaustion. Scope guard mirrors listScopedDerivedDrawers: wing/room must match.
  const includeDocs = Boolean(options.include_docs) || intent === "factual";
  let docScanReport: { rooms_scanned: string[]; drawers_scanned: number; truncated: boolean } | undefined;
  if (includeDocs && typeof client.listDrawers === "function") {
    // Same room resolution as listScopedDerivedDrawers (memgraph.ts): options.room wins,
    // else scope_room. Wing filter mirrors it too: options.wing wins, else scope_wing.
    const roomsToScan = [options.room?.trim() || scope_room];
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
        if (scope_room && room && room !== scope_room) return;
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

  // Phase 5: refined-by-neighbor expansion (procedural intent only). Skills are
  // leaves with no synthesized-from lineage, so they never enter the scoped pool;
  // the one-hop `refined-by` edge is the bridge. Two directions, both bounded by
  // construction (one one-hop kg_query per pool node, ≤ limit):
  //   - incoming refined-by on every pool node: skills that point at this
  //     session/synthesis/apprenticeship drawer as evidence;
  //   - outgoing refined-by on skill-typed pool nodes: the sessions/syntheses it
  //     was refined by (admitted only when they pass the scope guard below).
  // Candidates are hard-filtered to es-source-type: skill (one get_drawer +
  // getClosetSourceType each — retrieve-then-filter, never a room scan), and
  // scope-guarded exactly like the concerns block. The synthesized-from gate in
  // listScopedDerivedDrawers is untouched — skills enter by expansion, not by
  // loosening it. Gated on intent + client capability so non-procedural paths
  // and older clients degrade to pre-Phase-5 behavior with zero extra calls.
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

  // Phase 7 (unified memory): outcome-feedback ranking term. Read the accumulated
  // es-outcome counts for the (already bounded) pool and add a net-positive/negative
  // term to each node's score. Capability-gated like concerns/refined: clients without
  // getOutcomeCounts degrade to pre-Phase-7 scoring with zero extra calls. Bounded by
  // construction — one one-hop kg_query per pool node (≤ limit), same cost profile as
  // the P2-2 fan-out; read failures degrade to "no history" (neutral), never abort.
  const outcomeEnabled = typeof client.getOutcomeCounts === "function";
  let outcomeCountsByNode: Map<string, OutcomeCounts> | undefined;
  if (outcomeEnabled && scopedNodes.length > 0) {
    outcomeCountsByNode = await client
      .getOutcomeCounts(scopedNodes.map((n) => n.node_id))
      .catch(() => new Map<string, OutcomeCounts>());
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
      outcomeCounts: outcomeCountsByNode?.get(node.node_id),
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
      refined_expansion: intent === "procedural"
        ? {
            enabled: refinedEnabled,
            targets_admitted: scopedNodes.filter((n) => n.via === "refined").length,
          }
        : undefined,
      doc_scan: includeDocs && typeof client.listDrawers === "function"
        ? {
            enabled: true,
            rooms_scanned: docScanReport?.rooms_scanned ?? [],
            drawers_scanned: docScanReport?.drawers_scanned ?? 0,
            targets_admitted: scopedNodes.filter((n) => n.via === "doc").length,
            truncated: docScanReport?.truncated ?? false,
          }
        : undefined,
      // Phase 7 envelope honesty: state whether the outcome term was applied.
      // `applied` is true only when some node's score actually moved (non-zero net),
      // so a pool with history that nets to zero reports applied: false.
      outcome_expansion: outcomeEnabled && scopedNodes.length > 0
        ? {
            enabled: true,
            applied: [...(outcomeCountsByNode?.values() ?? [])].some((c) => c.total > 0 && c.accept !== c.revise + c.failed),
            nodes_with_history: [...(outcomeCountsByNode?.values() ?? [])].filter((c) => c.total > 0).length,
            weight: weights.outcome,
          }
        : undefined,
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
      ...(refinedNeighborIds.length > 0 ? { refined_neighbor_ids: [...new Set(refinedNeighborIds)].sort() } : {}),
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
