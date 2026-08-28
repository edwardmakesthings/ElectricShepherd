import type { ClosetSourceType, MemgraphClient, SkillDomain } from "./memgraph.ts";

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
  // Phase 10 (unified memory): procedural scope — skills that cross projects live in a
  // shared skills wing, and a "how do I do X" query from ANY project wing must reach
  // them. On `intent === "procedural"` ONLY, the bounded scan of this wing's `skills`
  // room admits skill-stamped drawers into the pool (via: "shared"). Every other intent
  // is byte-identical to pre-Phase-10 behavior: no shared-wing calls, no cross-wing nodes.
  // Omitted = off (default path stays single-wing).
  shared_wing?: string;
  // Phase 12 (unified memory): the requesting project's es-domain. On procedural intent
  // with a shared wing, shared-skill admission filters on it: a candidate is admitted iff
  // its domain is unstamped (null), `general`, or equals this value. Omitted = unknown
  // requester — only null/`general` candidates are admitted; specific-domain skills are
  // never surfaced to an unclassified project.
  domain?: string;
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
    // Phase 9 (unified memory): envelope honesty for negative-knowledge labelling.
    // `nodes_labeled` counts ranked nodes that carry a `rules-out` edge and were
    // therefore returned with the explicit ruled_out marker. `weight` is ZERO in this
    // phase — dead ends are labelled, not re-ranked (the spec does not ask for a weight).
    ruled_out_expansion?: {
      enabled: boolean;
      nodes_labeled: number;
      weight: number;
    };
    // Phase 11 (unified memory): envelope honesty for the staleness deprioritisation
    // term. `nodes_flagged` counts ranked nodes carrying an open es-staleness fact
    // (their basis moved); `applied` is true only when at least one of them had its
    // score lowered. Present ONLY when some node was flagged — unflagged pools keep
    // their envelopes byte-identical to pre-Phase-11 output (same empty-envelope rule
    // as shared_skills_expansion / outcome_expansion).
    stale_expansion?: {
      enabled: boolean;
      applied: boolean;
      nodes_flagged: number;
      weight: number;
    };
    // Phase 10 (unified memory): envelope honesty for the shared-skills-wing scan.
    // Present ONLY on procedural intent with `shared_wing` configured — non-procedural
    // intents never run the scan and report nothing, keeping their envelopes
    // byte-identical to pre-Phase-10 output.
    shared_skills_expansion?: {
      enabled: boolean;
      wing: string;
      room: string;
      drawers_scanned: number;
      targets_admitted: number;
      truncated: boolean;
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
    // Phase 10: shared-skills-wing drawers admitted into the pool this run.
    shared_skill_ids?: string[];
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


// ---------------------------------------------------------------------------
// Phase 13 (unified memory): worked-example injection.
//
// The `apprenticeship` room holds worked examples filed after hard problems were
// solved. This is the CONSUME side: given a delegation prompt, find the most
// similar examples and return them as demonstrations for in-context injection.
//
// Relevance is computed with a deterministic token-overlap score so the floor is
// stable across runs (no embedding dependency). The hard cap of 2 examples bounds
// prompt growth; below the relevance floor, nothing is returned rather than
// padding the delegation prompt.
// ---------------------------------------------------------------------------

/** Phase 13: hard cap on worked examples injected into a delegation prompt. */
export const WORKED_EXAMPLE_MAX_INJECT = 2;

/**
 * Phase 13: minimum relevance score for a worked example to be injected.
 * Score is in [0, 1] (token-overlap / query-token-count). A floor of 0.25 means
 * at least a quarter of the prompt's informative tokens must appear in the
 * example — below that, the match is too weak to be useful as a demonstration.
 */
export const WORKED_EXAMPLE_RELEVANCE_FLOOR = 0.25;

/** Phase 13: max chars per injected example (bounds prompt growth). */
export const WORKED_EXAMPLE_MAX_CHARS = 800;

/**
 * Phase 13 CONSUME: source types admitted as worked examples by retrieval.
 * `worked-example` is the stamp this phase writes (a distinct knowledge class —
 * solved task demonstrations, not procedural skills). `skill` stays admitted for
 * backward compatibility with any pre-existing apprenticeship drawers that were
 * stamped `skill`; new filings must never use `skill`.
 */
const WORKED_EXAMPLE_SOURCE_TYPES: ReadonlySet<string> = new Set(["worked-example", "skill"]);

export type WorkedExampleMatch = {
  drawer_id: string;
  wing: string;
  room: string;
  content: string;
  relevance: number;
};

export type RetrieveWorkedExamplesOptions = {
  query: string;
  limit?: number;
  relevanceFloor?: number;
  maxChars?: number;
};

/**
 * Tokenize text into lowercase alphanumeric tokens, dropping common stopwords
 * so the overlap score reflects task-specific vocabulary. Deterministic — no
 * randomness, no network calls.
 */
function tokenizeWorkedExampleText(text: string): Set<string> {
  const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "it", "its",
    "this", "that", "these", "those", "as", "if", "then", "else", "when",
    "where", "how", "what", "which", "who", "whom", "why", "not", "no", "yes",
    "so", "such", "than", "too", "very", "just", "also", "into", "out",
    "up", "down", "over", "under", "between", "during", "before", "after",
  ]);
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/**
 * Deterministic relevance score: |queryTokens ∩ exampleTokens| / |queryTokens|.
 * Returns 0 when queryTokens is empty. Bounded in [0, 1].
 */
function computeWorkedExampleRelevance(queryTokens: Set<string>, exampleTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (exampleTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

/**
 * Phase 13 CONSUME: retrieve the most relevant worked examples from the
 * `apprenticeship` room for a given delegation prompt.
 *
 * Returns at most `limit` (default WORKED_EXAMPLE_MAX_INJECT = 2) examples,
 * each with relevance >= `relevanceFloor` (default WORKED_EXAMPLE_RELEVANCE_FLOOR).
 * If no examples meet the floor, returns an empty array — the caller injects nothing.
 *
 * The search is capability-gated: clients without `search` degrade to "no
 * examples" with zero extra calls.
 */
export async function retrieveSimilarWorkedExamples(
  client: {
    search?: (query: string, limit?: number, wing?: string, room?: string) => Promise<unknown>;
    getDrawer?: (args: { drawer_id: string }) => Promise<unknown>;
    getClosetSourceType?: (nodeId: string) => Promise<string | null>;
  },
  options: RetrieveWorkedExamplesOptions,
): Promise<WorkedExampleMatch[]> {
  const query = String(options.query || "").trim();
  if (!query) return [];

  const limit = Math.max(1, Number(options.limit ?? WORKED_EXAMPLE_MAX_INJECT));
  const floor = Number(options.relevanceFloor ?? WORKED_EXAMPLE_RELEVANCE_FLOOR);
  const maxChars = Math.max(100, Number(options.maxChars ?? WORKED_EXAMPLE_MAX_CHARS));

  if (typeof client.search !== "function") return [];

  // Search the apprenticeship room for candidate examples.
  let searchResult: unknown;
  try {
    searchResult = await client.search(query, Math.min(10, limit * 3), undefined, "apprenticeship");
  } catch {
    return [];
  }

  const queryTokens = tokenizeWorkedExampleText(query);
  if (queryTokens.size === 0) return [];

  // Extract candidate drawer IDs from the search result.
  const obj = asObject(searchResult);
  const rows = [
    ...asArray(obj.results),
    ...asArray(obj.drawers),
    ...asArray(obj.matches),
    ...asArray(obj.items),
    ...asArray(obj.nodes),
  ];

  const seen = new Set<string>();
  const candidates: { id: string; text: string }[] = [];
  for (const raw of rows) {
    const row = asObject(raw);
    const id = asString(row.drawer_id || row.node_id || row.id || row.canonical_node_id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = [
      asString(row.content),
      asString(row.text),
      ...[...asArray(row.lines)].map(asString),
      asString(row.snippet),
      asString(row.preview),
      asString(row.desc),
    ].filter(Boolean).join("\n").trim();
    if (!text) continue;
    candidates.push({ id, text });
  }

  // Score each candidate.
  const scored: WorkedExampleMatch[] = [];
  for (const { id, text } of candidates) {
    const exampleTokens = tokenizeWorkedExampleText(text);
    const relevance = computeWorkedExampleRelevance(queryTokens, exampleTokens);
    if (relevance < floor) continue;

    // Fetch full content via getDrawer for richer demonstration text.
    let content = text.slice(0, maxChars);
    let wing = "";
    let room = "apprenticeship";
    if (typeof client.getDrawer === "function") {
      try {
        const drawerRaw = await client.getDrawer({ drawer_id: id });
        const drawer = asObject(drawerRaw);
        const fullContent = asString(
          drawer.content || drawer.text || drawer.desc || drawer.title,
        ).trim();
        if (fullContent) content = fullContent.slice(0, maxChars);
        wing = asString(drawer.wing || asObject(drawer.metadata).wing);
        room = asString(drawer.room || asObject(drawer.metadata).room) || "apprenticeship";
      } catch {
        // keep search-result text
      }
    }

    // Optional source-type filter: only admit worked-example/skill stamped drawers
    // (skill kept for backward compatibility — see WORKED_EXAMPLE_SOURCE_TYPES).
    if (typeof client.getClosetSourceType === "function") {
      try {
        const srcType = await client.getClosetSourceType(id);
        if (srcType && !WORKED_EXAMPLE_SOURCE_TYPES.has(srcType)) continue;
      } catch {
        // unreadable source type: admit (absence of stamp is not a rejection)
      }
    }

    scored.push({ drawer_id: id, wing, room, content, relevance });
  }

  // Sort by relevance descending, then by drawer_id for deterministic tie-breaking.
  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a.drawer_id.localeCompare(b.drawer_id);
  });

  return scored.slice(0, limit);
}

/**
 * Phase 13: format retrieved worked examples as a delimited demonstration section
 * for injection into a delegation prompt. Returns "" when no examples are provided.
 */
export function formatWorkedExampleDemonstration(examples: WorkedExampleMatch[]): string {
  if (examples.length === 0) return "";
  const parts = [
    "\n\n---\n",
    "## Demonstrations: how this class of problem was solved in this codebase before\n",
    "",
    "The following worked examples are directly relevant to your task. Use them as demonstrations — match their approach, style, and structure.\n",
  ];
  for (let i = 0; i < examples.length; i += 1) {
    const ex = examples[i];
    parts.push(`### Example ${i + 1} (relevance: ${ex.relevance.toFixed(2)})\n`);
    parts.push(ex.content.trim());
    if (i < examples.length - 1) parts.push("\n");
  }
  parts.push("\n---\n");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Phase 13 CREATE: deterministic problem-shape extraction (shared with phases 14/15/16).
//
// The shape is WHAT MADE THE TASK HARD / what class of task it was — not the
// answer. Retrieval matches on the problem, not the solution. Phases 14/15/16
// will reuse this exact helper for capability-memory tuples (task shape → tier
// → outcome), so it must stay cheap and deterministic: no embeddings, no LLM
// calls, stable across phrasings of the same task class.
// ---------------------------------------------------------------------------

/** Phase 13: work-class vocabulary — deliberately small and closed. */
export const WORKED_EXAMPLE_WORK_CLASSES = [
  "bug-fix",
  "new-feature",
  "refactor",
  "test",
  "config",
  "migration",
  "performance",
  "type-system",
] as const;

export type WorkedExampleWorkClass = (typeof WORKED_EXAMPLE_WORK_CLASSES)[number];

/** Phase 13: known-hard area vocabulary — deliberately small and closed. */
export const WORKED_EXAMPLE_HARD_AREAS = [
  "concurrency",
  "async",
  "type-system",
  "migration",
  "network",
  "state-machine",
  "performance",
] as const;

export type WorkedExampleHardArea = (typeof WORKED_EXAMPLE_HARD_AREAS)[number];

/** Phase 13: deterministic problem shape for a task description/prompt. */
export type WorkedExampleShape = {
  /** Coarse work class inferred from the prompt text. */
  workClass: WorkedExampleWorkClass;
  /** File extensions mentioned in the prompt (e.g. [".ts", ".py"]). */
  fileTypes: string[];
  /** Known-hard areas detected in the prompt text. */
  hardAreas: WorkedExampleHardArea[];
  /** Top informative tokens from the prompt (stopwords removed, capped). */
  keyTokens: string[];
  /** Phase 14: unit-size bucket (single-file / few-file / cross-cutting). */
  sizeBucket: UnitSizeBucket;
  /** Stable hash of the shape fields — used for near-duplicate suppression. */
  shapeKey: string;
};

/** Phase 13: max chars for a compact worked-example entry filed to the palace. */
export const WORKED_EXAMPLE_ENTRY_MAX_CHARS = 800;

/** Phase 13: minimum chars of substantive output before filing is worthwhile. */
export const WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS = 200;

/**
 * Phase 13 CREATE: subagent types whose successful completion warrants a worked
 * example. Cloud flows only (implement-cloud, build-cloud): the examples are filed
 * so that later cloud delegations can be injected with them as demonstrations.
 * The apprentice/local flows (implement-local, build) deliberately do NOT file —
 * they are the consumers of these demonstrations, not producers, and filing from
 * them would let a small model's own output back into its own prompt on the next
 * run.
 */
export const WORKED_EXAMPLE_FILE_AGENT_TYPES = new Set([
  "implement-cloud",
  "build-cloud",
]);

const SHAPE_TOKEN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "it", "its",
  "this", "that", "these", "those", "as", "if", "then", "else", "when",
  "where", "how", "what", "which", "who", "whom", "why", "not", "no", "yes",
  "so", "such", "than", "too", "very", "just", "also", "into", "out",
  "up", "down", "over", "under", "between", "during", "before", "after",
  "add", "added", "adding", "make", "made", "making", "fix", "fixed",
  "implement", "implemented", "implementing", "create", "created",
  "update", "updated", "change", "changed", "ensure", "ensures",
  "please", "task", "work", "file", "files", "code", "function",
]);

const WORK_CLASS_PATTERNS: Array<[WorkedExampleWorkClass, RegExp]> = [
  ["bug-fix", /\b(bug|fix|broken|error|fail|failing|failure|regression|crash|incorrect|wrong)\b/i],
  ["migration", /\b(migrat\w+|upgrade|convert\w*|migrate\w*)\b/i],
  ["performance", /\b(performance|slow|optimize\w*|latency|throughput|speed|benchmark)\b/i],
  ["type-system", /\b(type.?system|typescript|typing|generics?|union type|narrowing)\b/i],
  ["refactor", /\b(refactor\w+|restructure|reorganize|cleanup|clean up|simplif\w+)\b/i],
  ["test", /\b(test\w*|spec\w*|coverage|assertion)\b/i],
  ["config", /\b(config\w*|setting\w*|option\w*|flag\w*|env var|environment variable)\b/i],
  ["new-feature", /\b(feature|add|implement|create|build|support|enable|allow)\b/i],
];

const HARD_AREA_PATTERNS: Array<[WorkedExampleHardArea, RegExp]> = [
  ["concurrency", /\b(concurren\w+|race condition|deadlock|parallel|thread\w*|worker)\b/i],
  ["async", /\b(async|await|promise|callback|event loop|non.?blocking)\b/i],
  ["type-system", /\b(type.?system|typescript|typing|generics?|union type|narrowing)\b/i],
  ["migration", /\b(migrat\w+|upgrade|schema change|data migration)\b/i],
  ["network", /\b(network|http|websocket|socket|api call|fetch|request|response)\b/i],
  ["state-machine", /\b(state.?machine|finite state|transitions?|lifecycle)\b/i],
  ["performance", /\b(performance|slow|optimize\w*|latency|throughput|speed)\b/i],
];

/**
 * Phase 13: extract a deterministic problem shape from a task description/prompt.
 *
 * Cheap and stable — no embeddings, no LLM. Returns a compact object whose
 * `shapeKey` is a stable hash usable for near-duplicate suppression in-session.
 */
export function extractWorkedExampleShape(promptOrDescription: string): WorkedExampleShape {
  const text = String(promptOrDescription || "").trim();

  // Work class: first matching pattern wins (order matters — bug-fix before new-feature).
  let workClass: WorkedExampleWorkClass = "new-feature";
  for (const [cls, re] of WORK_CLASS_PATTERNS) {
    if (re.test(text)) {
      workClass = cls;
      break;
    }
  }

  // File types: extract extensions from the text.
  const fileTypes = new Set<string>();
  for (const match of text.matchAll(/\.\b([a-z0-9]{1,8})\b/gi)) {
    const ext = "." + match[1].toLowerCase();
    // Filter out common non-file tokens (e.g. "e.g", "i.e", version numbers).
    if (!/^\.(e|g|i|v|ts\.js|js\.ts)$/.test(ext) && !/^\.\d+$/.test(ext)) {
      fileTypes.add(ext);
    }
  }

  // Hard areas: all matching patterns.
  const hardAreas: WorkedExampleHardArea[] = [];
  for (const [area, re] of HARD_AREA_PATTERNS) {
    if (re.test(text) && !hardAreas.includes(area)) {
      hardAreas.push(area);
    }
  }

  // Key tokens: informative words from the prompt (stopwords removed, capped at 12).
  const keyTokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3) continue;
    if (SHAPE_TOKEN_STOPWORDS.has(raw)) continue;
    if (!keyTokens.includes(raw)) keyTokens.push(raw);
    if (keyTokens.length >= 12) break;
  }

  // Phase 14: unit-size bucket — a required shape component for capability routing.
  const sizeBucket = classifyUnitSize(text, fileTypes.size);

  // Shape key: stable hash of the shape fields (not the raw text).
  const shapeKey = computeShapeKey({ workClass, fileTypes: [...fileTypes].sort(), hardAreas, keyTokens, sizeBucket });

  return { workClass, fileTypes: [...fileTypes].sort(), hardAreas, keyTokens, sizeBucket, shapeKey };
}

/** Phase 13: deterministic hash of shape fields (simple FNV-1a over a canonical string). */
function computeShapeKey(shape: { workClass: string; fileTypes: string[]; hardAreas: string[]; keyTokens: string[]; sizeBucket?: string }): string {
  const canonical = [shape.workClass, shape.fileTypes.join(","), shape.hardAreas.join(","), shape.keyTokens.slice(0, 6).join(","), shape.sizeBucket || ""].join("|");
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Phase 14: unit-size bucket vocabulary — deliberately small and closed. */
export const UNIT_SIZE_BUCKETS = ["single-file", "few-file", "cross-cutting"] as const;

export type UnitSizeBucket = (typeof UNIT_SIZE_BUCKETS)[number];

/**
 * Phase 14: classify a task prompt into a unit-size bucket (single-file / few-file /
 * cross-cutting). Cheap and deterministic — no embeddings, no LLM. Used by the
 * capability-memory CREATE path so routing evidence can be keyed on scope as well
 * as work class; the bucket is part of the canonical shape string.
 */
export function classifyUnitSize(promptOrDescription: string, fileTypeCount = 0): UnitSizeBucket {
  const text = String(promptOrDescription || "").toLowerCase();

  // Cross-cutting signals: explicit multi-file/multi-module language or many file types.
  if (fileTypeCount >= 3) return "cross-cutting";
  if (/\b(cross.?cutting|multi.?file|multiple files?|across the codebase|across modules?|several files?)\b/.test(text)) {
    return "cross-cutting";
  }

  // Few-file signals: explicit 2-3 file language.
  if (/\b(two files?|three files?|a few files?|2 files?|3 files?)\b/.test(text)) {
    return "few-file";
  }

  // Single-file signals: explicit single-file language or exactly one file type mentioned.
  if (/\b(single.?file|one file|the file)\b/.test(text) || fileTypeCount === 1) {
    return "single-file";
  }

  // Default: treat an unspecified scope as few-file (the middle bucket).
  return "few-file";
}

/** Phase 14: routing tier vocabulary for capability memory (learned routing). */
export const CAPABILITY_TIERS = ["local", "cloud", "deep"] as const;

export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

/**
 * Phase 14 CREATE: subagent types that map to a routing tier. Only the three
 * implementation tiers are recorded — utility/analysis subagents (explore,
 * review-diff, run-tests, build, etc.) do not run units of work and are skipped.
 */
export const CAPABILITY_TIER_BY_SUBAGENT: Readonly<Record<string, CapabilityTier>> = {
  "implement-local": "local",
  "implement-cloud": "cloud",
  "implement-deep-cloud": "deep",
  "solve-deep-cloud": "deep",
};

/** Phase 14: closed outcome vocabulary for capability tuples (matches es-outcome). */
export const CAPABILITY_OUTCOME_VALUES = ["accept", "revise", "failed", "unused"] as const;

export type CapabilityOutcome = (typeof CAPABILITY_OUTCOME_VALUES)[number];

/**
 * Phase 14 CREATE: map a task tool part status to a capability outcome.
 * Returns null for unknown statuses — the caller skips recording rather than
 * guessing, keeping the closed set honest.
 */
export function mapTaskStatusToCapabilityOutcome(status: string): CapabilityOutcome | null {
  const s = String(status || "").trim().toLowerCase();
  if (s === "success" || s === "completed" || s === "ok") return "accept";
  if (s === "failed" || s === "error") return "failed";
  if (s === "aborted" || s === "cancelled" || s === "canceled") return "unused";
  return null;
}

/**
 * Phase 14: canonical shape summary string for a capability bucket. Deterministic
 * and cheap — the same fields that feed computeShapeKey, joined in a fixed order
 * so two runs over the same prompt produce byte-identical strings (and ids).
 */
export function buildCapabilityCanonicalShape(shape: WorkedExampleShape): string {
  return [
    shape.workClass,
    `files=${shape.fileTypes.join(",") || "n/a"}`,
    `hard=${shape.hardAreas.join(",") || "none"}`,
    `size=${shape.sizeBucket}`,
    `tokens=${shape.keyTokens.slice(0, 6).join(",")}`,
  ].join("|");
}

/** Phase 14: deterministic capability bucket id for a (shape, tier) pair. */
export function buildCapabilityBucketId(shapeKey: string, tier: CapabilityTier): string {
  return `capability::${shapeKey}::${tier}`;
}

/**
 * Phase 13: build a compact worked-example entry for filing to the palace.
 *
 * The entry is bounded to WORKED_EXAMPLE_ENTRY_MAX_CHARS and leads with a DESC
 * line (repo convention) so it's discoverable without loading the body. The
 * problem shape is embedded as metadata lines so retrieval can match on the
 * problem, not just the solution.
 */
export function buildWorkedExampleEntry(params: {
  subagentType: string;
  description: string;
  output: string;
  shape: WorkedExampleShape;
}): string {
  const { subagentType, description, output, shape } = params;
  const desc = String(description || "").trim().slice(0, 120);
  const body = String(output || "").trim();

  // Truncate the body to fit within the max chars, leaving room for headers.
  const headerLen = 300; // approximate size of DESC + shape metadata lines
  const maxBody = Math.max(100, WORKED_EXAMPLE_ENTRY_MAX_CHARS - headerLen);
  const clippedBody = body.length > maxBody ? body.slice(0, maxBody) + "…" : body;

  const parts: string[] = [
    `DESC: Worked example — ${desc || subagentType} task solved by ${subagentType}. Relevant when delegating a similar ${shape.workClass} problem.`,
    "",
    `SHAPE: work-class=${shape.workClass}; file-types=${shape.fileTypes.join(",") || "n/a"}; hard-areas=${shape.hardAreas.join(",") || "none"}; size-bucket=${shape.sizeBucket}; key-tokens=${shape.keyTokens.slice(0, 6).join(", ")}`,
    "",
    clippedBody,
  ];

  return parts.join("\n").slice(0, WORKED_EXAMPLE_ENTRY_MAX_CHARS);
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

  // Phase 10 (unified memory): shared-skills-wing admission (procedural intent ONLY).
  // Skills that cross projects are promoted into a shared skills wing; a "how do I do
  // X" query from ANY project wing must reach them. A freshly promoted skill has no
  // edges into the querying project, so edge-based expansion (refined-by) cannot see it
  // — this bounded room scan is the primary admission path: one page of the shared
  // wing's `skills` room, retrieve-then-filter to es-source-type: skill.
  //
  // The gate is structural and sits at the TOP of the block: non-procedural intents
  // (factual/historical/default) never pay a single shared-wing call and can admit no
  // cross-wing node — a cross-wing search for episodic memory would surface another
  // project's transcripts, the exact failure mode wing-scoping exists to prevent. The
  // hard es-source-type: skill check is the safety net even on procedural intent: an
  // unstamped or transcript-stamped drawer in the shared room is never admitted.
  // Capability-gated like every expansion (listDrawers/getDrawer/getClosetSourceType);
  // read failures degrade to pre-Phase-10 behavior with zero extra calls. Never pages
  // past one bounded page (spec guardrail: no room exhaustion).
  const sharedWing = intent === "procedural" ? String(options.shared_wing || "").trim() : "";
  // Phase 12: domain filter. Capability-gated like every expansion — clients without
  // getClosetDomain degrade to pre-Phase-12 behavior (no filtering, zero extra calls).
  const sharedDomainFilterEnabled = typeof client.getClosetDomain === "function";
  const requestingDomain = String(options.domain || "").trim();
  let sharedSkillIds: string[] = [];
  let sharedScanReport: { wing: string; room: string; drawers_scanned: number; truncated: boolean } | undefined;
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
          return Promise.all([drawerP, typeP, domainP]);
        }),
      );
      results.forEach(([drawerRaw, sourceType, skillDomain], i) => {
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
        });
        sharedSkillIds.push(c.id);
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

  // Phase 9 (unified memory): negative-knowledge labelling. A dead end is a synthesis
  // with an outgoing `rules-out` edge; when such a node is in the ranked pool it must be
  // returned EXPLICITLY LABELLED as ruled out — "an unlabelled dead end reads as a
  // suggestion" (spec's main risk). Capability-gated like concerns/refined/outcome:
  // clients without getRulesOut degrade to pre-Phase-9 output with zero extra calls.
  // Bounded by construction — one one-hop kg_query per pool node (≤ limit), same cost
  // profile as the P2-2 fan-out; read failures degrade to "no rules-out" (unlabelled),
  // never abort. This phase does NOT alter ranking: weights.ruledOut is 0 and the score
  // formula below is untouched — labelling only, presentation not re-ranking.
  const ruledOutEnabled = typeof client.getRulesOut === "function";
  let ruledOutNodesLabeled = 0;
  if (ruledOutEnabled && scopedNodes.length > 0) {
    const results = await Promise.all(
      scopedNodes.map((node) =>
        node.source_type === "synthesis"
          ? client.getRulesOut(node.node_id).catch(() => ({ statements: [] as string[], polarities: [] as string[] }))
          : Promise.resolve({ statements: [] as string[], polarities: [] as string[] }),
      ),
    );
    results.forEach((res, i) => {
      const node = scopedNodes[i];
      if (!res || res.statements.length === 0) return; // no rules-out edge -> not a dead end
      const polarity = res.polarities.includes("considered-rejected") ? "considered-rejected" : "tried-failed";
      node.ruled_out = { polarity, statements: res.statements };
      ruledOutNodesLabeled += 1;
    });
  }

  // Phase 11 (unified memory): es-staleness flag read. Capability-gated like
  // concerns/refined/outcome/rules-out: clients without getStalenessFlags degrade to
  // pre-Phase-11 scoring with zero extra calls. One batch reader over the already-
  // bounded pool (concurrency 8 + maxNodes enforced inside the client, same shape as
  // getOutcomeCounts); read failures degrade to "unflagged" (neutral) per node, never
  // abort. The flag applies to ANY node type that carries it — the CREATE path flags
  // syntheses, but a doc drawer could in principle carry one too, and a flagged doc
  // can enter the pool via the concerns block or the direct doc scan; the read side
  // stays type-agnostic. The surfaced `stale` field is set BEFORE scoring so it rides
  // into selected_nodes/ranked_nodes (the spread copies) automatically.
  const stalenessEnabled = typeof client.getStalenessFlags === "function";
  let staleValueByNode: Map<string, string> | undefined;
  if (stalenessEnabled && scopedNodes.length > 0) {
    const raw = await client
      .getStalenessFlags(scopedNodes.map((n) => n.node_id))
      .catch(() => new Map<string, string | null>());
    staleValueByNode = new Map([...raw].filter(([, v]) => v !== null));
  }
  if (staleValueByNode && staleValueByNode.size > 0) {
    for (const node of scopedNodes) {
      const value = staleValueByNode.get(node.node_id);
      if (value) node.stale = { value };
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
      outcomeCounts: outcomeCountsByNode?.get(node.node_id),
      staleValue: staleValueByNode?.get(node.node_id) ?? null,
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
      // Phase 9 envelope honesty: state how many ranked nodes carried a rules-out edge
      // and were therefore returned with the explicit ruled_out marker. `weight` is 0 —
      // this phase labels, it does not re-rank.
      ruled_out_expansion: ruledOutEnabled && scopedNodes.length > 0
        ? {
            enabled: true,
            nodes_labeled: ruledOutNodesLabeled,
            weight: weights.ruledOut,
          }
        : undefined,
      // Phase 11 envelope honesty: state what the staleness read did. Present ONLY when
      // some node was flagged — unflagged pools (and clients without the reader) keep
      // their envelopes byte-identical to pre-Phase-11 output, so this block never adds
      // noise to the common case. `applied` is true whenever a node was flagged: the
      // flag is binary and strictly negative, so any flag moved that node's score.
      stale_expansion: stalenessEnabled && scopedNodes.length > 0 && staleValueByNode && staleValueByNode.size > 0
        ? {
            enabled: true,
            applied: true,
            nodes_flagged: staleValueByNode.size,
            weight: weights.staleness,
          }
        : undefined,
      // Phase 10 envelope honesty: state what the shared-skills scan did. Present only
      // when the scan actually ran (procedural intent + shared_wing configured), so
      // non-procedural envelopes stay byte-identical to pre-Phase-10 output.
      shared_skills_expansion: sharedWing && sharedScanReport
        ? {
            enabled: true,
            wing: sharedScanReport.wing,
            room: sharedScanReport.room,
            drawers_scanned: sharedScanReport.drawers_scanned,
            targets_admitted: scopedNodes.filter((n) => n.via === "shared").length,
            truncated: sharedScanReport.truncated,
            // Phase 12 envelope honesty: state what the domain filter did. Present only
            // when the client supports getClosetDomain; otherwise pre-Phase-12 output.
            ...(sharedDomainFilterEnabled
              ? {
                  domain_filter: {
                    enabled: true,
                    requesting_domain: requestingDomain || null,
                    matched: scopedNodes.filter((n) => n.via === "shared").length,
                    filtered: sharedDomainFiltered,
                  },
                }
              : {}),
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
      ...(sharedSkillIds.length > 0 ? { shared_skill_ids: [...new Set(sharedSkillIds)].sort() } : {}),
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
