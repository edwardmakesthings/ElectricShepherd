/**
 * B1: probabilistic entry + deterministic expansion over scoped lineage.
 *
 * Entry uses semantic search to find seeds, then expansion deterministically walks
 * canonical lineage neighborhoods and ranks scoped derived drawers with
 * stable tie-breaks. The scoring engine (weights, node extraction, factual floor)
 * lives in retrieval-scoring.ts; worked-example retrieval/formatting/shape and the
 * Phase 14/15/16 bucket helpers live in retrieval-worked-examples.ts — both are
 * re-exported here so existing importers keep their single entry point.
 */
import type { MemgraphClient } from "./memgraph.ts";

export {
  DEFAULT_WEIGHTS,
  INTENT_AUTHORITY_BOOSTS,
  OUTCOME_VALUES,
  applyFactualFloor,
  asArray,
  asNumber,
  asObject,
  asString,
  collectIdsFromObjects,
  computeNodeScore,
  emptyOutcomeCounts,
  extractNeighborIDs,
  extractScopedNodes,
  extractSearchSeedIDs,
  mergeWeights,
  normalizeLabel,
  normalizeLabelList,
  outcomeScoreTerm,
  staleScoreTerm,
  type NodeAuthority,
  type OutcomeCounts,
  type OutcomeValue,
  type RankedScopedNode,
  type RetrievalIntent,
  type RetrievalWeights,
} from "./retrieval-scoring.ts";

export {
  buildCalibrationBucketId,
  buildCapabilityBucketId,
  buildCapabilityCanonicalShape,
  buildFailureBucketId,
  buildFailurePatchId,
  buildWorkedExampleEntry,
  canonicalModelId,
  classifyUnitSize,
  extractWorkedExampleShape,
  formatInterventionBlock,
  formatWorkedExampleDemonstration,
  mapTaskStatusToCapabilityOutcome,
  parseSelfReportedConfidence,
  retrieveSimilarWorkedExamples,
  CAPABILITY_OUTCOME_VALUES,
  CAPABILITY_SUBAGENT_BY_TIER,
  CAPABILITY_TIERS,
  CAPABILITY_TIER_BY_SUBAGENT,
  CONFIDENCE_VALUES,
  FAILURE_EVENT_VALUES,
  FAILURE_PATCH_TEXT_MAX_CHARS,
  INTERVENTION_LABELS,
  INTERVENTION_REPLAY_HEADING,
  UNIT_SIZE_BUCKETS,
  WORKED_EXAMPLE_ENTRY_MAX_CHARS,
  WORKED_EXAMPLE_FILE_AGENT_TYPES,
  WORKED_EXAMPLE_HARD_AREAS,
  WORKED_EXAMPLE_MAX_CHARS,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
  WORKED_EXAMPLE_RELEVANCE_FLOOR,
  WORKED_EXAMPLE_WORK_CLASSES,
  type CapabilityOutcome,
  type CapabilityTier,
  type FailureEvent,
  type InterventionLabel,
  type RetrieveWorkedExamplesOptions,
  type SelfReportedConfidence,
  type UnitSizeBucket,
  type WorkedExampleHardArea,
  type WorkedExampleMatch,
  type WorkedExampleShape,
  type WorkedExampleWorkClass,
} from "./retrieval-worked-examples.ts";

import {
  INTENT_AUTHORITY_BOOSTS,
  applyFactualFloor,
  asObject,
  asString,
  computeNodeScore,
  extractNeighborIDs,
  extractScopedNodes,
  extractSearchSeedIDs,
  normalizeLabelList,
} from "./retrieval-scoring.ts";
import type { NodeAuthority, OutcomeCounts } from "./retrieval-scoring.ts";
import type { RetrievalExpansionOptions, RetrievalExpansionResult } from "./retrieval-expansion-types.ts";
export type { RetrievalExpansionOptions, RetrievalExpansionResult } from "./retrieval-expansion-types.ts";
import { parseExpansionInputs } from "./retrieval-expansion-core.ts";
import { admitDirectDocs, expandConcernNeighbors } from "./retrieval-expansion-docs.ts";
import { admitSharedSkills, expandRefinedNeighbors } from "./retrieval-expansion-skills.ts";

/**
 * B1: probabilistic entry + deterministic expansion.
 *
 * Entry uses semantic search to find seeds, then expansion deterministically walks
 * canonical lineage neighborhoods and ranks scoped derived drawers with
 * stable tie-breaks. DOC admission (concerns neighbors + direct doc scan) lives in
 * retrieval-expansion-docs.ts; SKILL admission (refined-by + shared-skills-wing)
 * lives in retrieval-expansion-skills.ts — this function is the orchestrator only:
 * entry, neighborhood, pool assembly, capability reads, scoring/sort/selection, and
 * the result envelope. Inputs/outputs are unchanged from the pre-decomposition file.
 */
export async function expandScopedRetrieval(
  client: MemgraphClient,
  options: RetrievalExpansionOptions,
): Promise<RetrievalExpansionResult> {
  const {
    query,
    scope_room,
    requestedMatchLabels,
    alwaysIncludeLabels,
    weights,
    seedSearchLimit,
    maxDepth,
    expansionDepth,
    limit,
    offset,
    topN,
    matchMode,
    labeledOnly,
    includeMerged,
  } = parseExpansionInputs(options);

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

  // Phase 4 + Phase 3 close-out: DOC admission — concerns-neighbor expansion and the
  // direct doc scan. Extracted to retrieval-expansion-docs.ts; call order and
  // per-node work are unchanged (see that module for the full phase rationale).
  const concernNeighborIds = await expandConcernNeighbors(client, options, scope_room, scopedNodes, neighborhoodSet);
  const includeDocs = Boolean(options.include_docs) || intent === "factual";
  const docScanReport = await admitDirectDocs(client, options, scope_room, intent, scopedNodes);

  // Phase 5 + Phase 10/12/P2-1: SKILL admission — refined-by expansion and the
  // shared-skills-wing scan (domain filter + promoted-from provenance). Extracted to
  // retrieval-expansion-skills.ts; call order and per-node work are unchanged (see
  // that module for the full phase rationale).
  const refinedNeighborIds = await expandRefinedNeighbors(client, options, intent, scopedNodes, neighborhoodSet);
  const sharedResult = await admitSharedSkills(client, options, intent, scopedNodes);
  const sharedSkillIds = sharedResult.ids;
  const sharedScanReport = sharedResult.report;
  const sharedDomainFiltered = sharedResult.counters.domainFiltered;
  const sharedPromotedChecked = sharedResult.counters.checked;
  const sharedPromotedWithOrigin = sharedResult.counters.withOrigin;

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
        enabled: typeof client.getConcerns === "function",
        targets_admitted: scopedNodes.filter((n) => n.via === "concern").length,
      },
      refined_expansion: intent === "procedural"
        ? {
            enabled: typeof client.getRefinedBy === "function",
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
      shared_skills_expansion: sharedScanReport
        ? {
            enabled: true,
            wing: sharedScanReport.wing,
            room: sharedScanReport.room,
            drawers_scanned: sharedScanReport.drawers_scanned,
            targets_admitted: scopedNodes.filter((n) => n.via === "shared").length,
            truncated: sharedScanReport.truncated,
            // Phase 12 envelope honesty: state what the domain filter did. Present only
            // when the client supports getClosetDomain; otherwise pre-Phase-12 output.
            ...(typeof client.getClosetDomain === "function"
              ? {
                  domain_filter: {
                    enabled: true,
                    requesting_domain: String(options.domain || "").trim() || null,
                    matched: scopedNodes.filter((n) => n.via === "shared").length,
                    filtered: sharedDomainFiltered,
                  },
                }
              : {}),
            // P2-1 envelope honesty: state what the promoted-from provenance read did.
            // Present only when the capability exists AND at least one admitted shared
            // skill was checked — otherwise pre-P2-1 output (no new field).
            ...(typeof client.getPromotedFrom === "function" && sharedPromotedChecked > 0
              ? {
                  promoted_from: {
                    enabled: true,
                    checked: sharedPromotedChecked,
                    with_origin: sharedPromotedWithOrigin,
                  },
                }
              : {}),
          }
        : undefined,
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
