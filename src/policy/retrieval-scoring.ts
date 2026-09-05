/**
 * Deterministic scoring + node-extraction engine for scoped retrieval.
 * Extracted from retrieval-expansion.ts (criterion 2 decomposition) — behavior
 * and all public exports are unchanged; expandScopedRetrieval re-exports them.
 */
import type { ClosetSourceType } from "../core/memgraph.ts";

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
  // Phase 9 (unified memory): negative-knowledge presentation term. ZERO by default
  // and NOT a ranking weight in this phase — dead ends are surfaced alongside positive
  // knowledge with an explicit label, not re-ranked. The field exists so the envelope
  // can report the (zero) contribution honestly; a future phase may give it magnitude.
  ruledOut: number;
  // Phase 11 (unified memory): temporal-validity deprioritisation term. Weighted
  // BELOW authority by construction — the flag is binary, so its maximum magnitude
  // is exactly weights.staleness (0.5 at defaults), strictly under one full authority
  // boost (±2 * weights.authority). A stale doc therefore still outranks an unflagged
  // provisional synthesis on a factual query (the floor invariant stays intact).
  staleness: number;
};

// Phase 2 (unified memory): optional retrieval intent. Omitted = no preference.
export type RetrievalIntent = "factual" | "historical" | "procedural";

// Authority dimension: the es-source-type axis, with "unknown" for unstamped nodes
// or read failures (spec: unstamped is never a default type).
export type NodeAuthority = ClosetSourceType | "unknown";

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
  // lineage edge yet); "shared" = admitted by the Phase 10 bounded scan of the shared
  // skills wing (promoted skill, procedural intent only).
  via?: "scoped" | "concern" | "refined" | "doc" | "shared";
  // Phase 9 (unified memory): negative-knowledge marker. Present ONLY when this node
  // carries an outgoing `rules-out` edge — a dead end, i.e. an approach that was tried
  // and failed or considered and rejected. Downstream renderers MUST attach the hard
  // "[RULED OUT ...]" label to any node with this field; an unlabelled dead end reads
  // as a suggestion (the spec's main risk). `polarity` preserves the two-valued
  // distinction: tried-failed is stronger evidence than considered-rejected.
  ruled_out?: {
    polarity: "tried-failed" | "considered-rejected";
    /** The ruled-out statement(s) this node points at (its topic/approach). */
    statements: string[];
  };
  // Phase 11 (unified memory): temporal-validity marker. Present ONLY when this node
  // carries an open es-staleness fact — its basis moved (the doc it was synthesised
  // from changed since). Downstream renderers MUST surface the value so the reader
  // knows the basis moved; unlike ruled_out this field ALSO affects score (the
  // deprioritisation term in computeNodeScore), so a flagged node is both labelled
  // and lowered — penalised, never filtered out.
  stale?: { value: string };
  // Phase 10 (unified memory): provenance marker for shared-wing skills that carry an
  // outgoing `promoted-from` edge (written by tools/promote_skill.ts at promotion).
  // Present ONLY when the reader is available AND the read returns at least one origin
  // — unstamped/unpromoted skills and clients without getPromotedFrom keep their nodes
  // byte-identical to pre-P2-1 output. Metadata only: it never feeds computeNodeScore,
  // admission, or ranking in any way.
  promoted_from?: string[];
};

export const DEFAULT_WEIGHTS: RetrievalWeights = {
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
  // Phase 9: negative-knowledge presentation. ZERO by construction — dead ends are
  // surfaced with an explicit label, not re-ranked. A future phase may change this;
  // until then the score formula is byte-identical to pre-Phase-9 for every node.
  ruledOut: 0,
  // Phase 11: temporal-validity deprioritisation. The flag is binary (no accumulation),
  // so the maximum contribution is exactly this weight — strictly below one full
  // authority boost (±2 * weights.authority). A stale doc therefore still outranks an
  // unflagged provisional synthesis on a factual query; unflagged nodes get exactly 0
  // from this term (neutral by construction, like the outcome term).
  staleness: 0.5,
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

/**
 * Phase 11 ranking term. The es-staleness flag is BINARY — a node either carries an
 * open `es-staleness` fact (its basis moved) or not — so there is no accumulation and
 * no clamp: flagged returns exactly −weight, unflagged returns exactly 0 (neutral by
 * construction). Weighted below authority by DEFAULT_WEIGHTS (max magnitude 0.5 < one
 * full authority boost of ±2), so a stale doc still outranks an unflagged provisional
 * synthesis on a factual query (the floor invariant stays intact). The value itself is
 * not part of the score — any open flag deprioritises equally; it is surfaced verbatim
 * in the result for the reader to interpret.
 */
export function staleScoreTerm(flagged: boolean, weight: number): number {
  return flagged ? -weight : 0;
}

// Phase 2 (unified memory): intent -> per-authority-type boost table.
// Magnitudes are secondary to the factual floor below; they only shape ordering
// within what the floor permits. Spec: factual boosts doc then synthesis with
// transcript weakest; historical boosts synthesis and transcript; procedural
// boosts skill then synthesis.
export const INTENT_AUTHORITY_BOOSTS: Record<RetrievalIntent, Record<NodeAuthority, number>> = {
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
export function applyFactualFloor(
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

export function normalizeLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const cleaned = label.trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeLabelList(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const out = new Set<string>();
  for (const raw of labels) {
    const label = normalizeLabel(raw);
    if (label) out.add(label);
  }
  return [...out].sort();
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function collectIdsFromObjects(objects: unknown[]): string[] {
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

export function extractSearchSeedIDs(searchResult: unknown): string[] {
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

export function extractNeighborIDs(result: unknown): string[] {
  const obj = asObject(result);
  const arrays = [asArray(obj.ancestors), asArray(obj.descendants), asArray(obj.nodes)];
  const merged: unknown[] = [];
  for (const arr of arrays) merged.push(...arr);
  return collectIdsFromObjects(merged);
}

export function extractScopedNodes(result: unknown): RankedScopedNode[] {
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

export function mergeWeights(overrides: Partial<RetrievalWeights> | undefined): RetrievalWeights {
  return { ...DEFAULT_WEIGHTS, ...(overrides || {}) };
}

/**
 * B1: deterministic node scoring over the ranked pool. One call site —
 * expandScopedRetrieval's ranking pass.
 */
export function computeNodeScore(args: {
  node: RankedScopedNode;
  weights: RetrievalWeights;
  wantedLabels: Set<string>;
  canonicalSeedIDs: Set<string>;
  neighborhoodIDs: Set<string>;
  alwaysIncludeLabels: Set<string>;
  authorityBoost: number;
  outcomeCounts?: OutcomeCounts;
  staleValue?: string | null;
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
    staleValue,
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

  // Phase 11: temporal-validity deprioritisation. Binary flag, no accumulation — a
  // node either carries an open es-staleness fact (its basis moved) or not. Weighted
  // below authority by construction (max magnitude = weights.staleness = 0.5 < one
  // full authority boost of ±2), and added BEFORE the factual floor clamp, exactly
  // like the outcome term: a stale doc lowers the floor class's score, and clamped
  // provisional synths pin to that (penalised) floor — "stale basis → less trust".
  // Unflagged nodes get exactly 0 here — neutral by construction. The penalty lowers
  // rank but NEVER removes the node: nothing in this term feeds a filter.
  if (staleValue) {
    score += staleScoreTerm(true, weights.staleness);
  }

  return score;
}
