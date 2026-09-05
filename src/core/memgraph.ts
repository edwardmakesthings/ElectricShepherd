import type { SubstrateResult } from "./mcp-http-client.ts";

import {
  buildToolMap,
  resolveToolPrefix,
  type ClosetSourceType,
  type JsonMap,
  type ListSourceScopeArgs,
  type MemgraphClientOptions,
  type MemgraphToolMap,
  type SkillDomain,
  type SourceDrawerWorkItem,
  type ToolCaller,
} from "./memgraph-structure.ts";

import {
  asString,
  callIgnoringFailure,
  callSubstrate,
  invokeSubstrate,
  parseKgFacts,
  uniqueFromFactsByDirection,
} from "./memgraph-transport.ts";

import type { KGQueryArgs, MemgraphInternals } from "./memgraph-internals.ts";

import * as axes from "./memgraph-axes.ts";
import * as lineage from "./memgraph-lineage.ts";
import * as drawers from "./memgraph-drawers.ts";
import * as capability from "./memgraph-capability.ts";

export {
  SKILL_DOMAINS,
  type ClosetSourceType,
  type JsonMap,
  type MemgraphClientOptions,
  type MemgraphToolMap,
  type SkillDomain,
  type SourceDrawerWorkItem,
  type ToolCaller,
} from "./memgraph-structure.ts";

/**
 * Typed client over the MemPalace substrate.
 *
 * Criterion 2 decomposition: the method bodies live in four domain modules —
 * memgraph-axes (es-* axes + cross-type edge reads), memgraph-lineage (lineage /
 * merge / hall), memgraph-drawers (drawer CRUD + KG writes + source-scope
 * worklists), memgraph-capability (Phases 14/15/16 learned routing, failure-mode
 * memory, calibration). This class is the thin facade: it owns the transport
 * helpers and delegates every public method verbatim. The public API — method
 * names, signatures, static members, error messages — is unchanged.
 */
export class MemgraphClient {
  private readonly callTool: ToolCaller;
  private readonly tools: MemgraphToolMap;
  private readonly core: MemgraphInternals;

  constructor(options: MemgraphClientOptions) {
    this.callTool = options.callTool;
    this.tools = buildToolMap(resolveToolPrefix(options.toolPrefix), options.toolMap);
    const self = this;
    this.core = {
      invoke: (name, args) => self.invoke(name, args),
      call: (name, args) => self.call(name, args),
      kgQuery: (args) => self.kgQuery(args),
      kgQueryIgnoringFailure: (args, reason) => self.kgQueryIgnoringFailure(args, reason),
      callIgnoringFailure: (name, args, reason) => self.callIgnoringFailure(name, args, reason),
    };
  }

  private async invoke(name: keyof MemgraphToolMap | string, args: JsonMap | undefined): Promise<SubstrateResult<JsonMap>> {
    return invokeSubstrate(this.tools, this.callTool, name, args);
  }

  /**
   * Explicitly ignore a substrate failure and degrade to an empty result. This is the
   * ONLY sanctioned place in this class where a failed call becomes `{}`: every caller
   * must route through it, so each degradation is a named decision with a reason that
   * is logged operator-visible (spec §4.1). The returned object carries `__esError` so
   * callers that need to distinguish "empty" from "failed" can still see the failure.
   */
  private async callIgnoringFailure(
    name: keyof MemgraphToolMap,
    args: JsonMap | undefined,
    reason: string,
  ): Promise<JsonMap> {
    return callIgnoringFailure(this.tools, this.callTool, name, args, reason);
  }

  /**
   * Run a kg_query through the public `kgQuery()` method (which handles param
   * stripping and the -32602 fallback) and degrade to an empty result on failure.
   * The reason is logged operator-visible so a broken substrate cannot masquerade as
   * "this entity has no facts".
   */
  private async kgQueryIgnoringFailure(args: KGQueryArgs, reason: string): Promise<JsonMap> {
    try {
      return await this.kgQuery(args);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[memgraph] kg_query failed (${reason}), ignoring by design: ${detail}`);
      return { __esError: detail };
    }
  }

  private async call(name: keyof MemgraphToolMap, args?: JsonMap): Promise<JsonMap> {
    return callSubstrate(this.tools, this.callTool, name, args);
  }

  /**
   * True once the server has rejected the graph-traversal parameters, meaning we
   * are talking to a build older than `179c613 feat: align graph tools to closet
   * lineage model`. Cached so one rejection costs one wasted round trip, not one
   * per call.
   */
  private kgQueryTraversalUnsupported = false;

  private isUnknownParameterError(err: unknown): boolean {
    const message = String(err || "").toLowerCase();
    return message.includes("-32602") || message.includes("unknown parameter");
  }

  /**
   * Current MemPalace `kg_query` supports server-side `predicate` filtering and
   * recursive traversal (`recurse` / `max_depth`); see `mcp_server.py`'s
   * `mempalace_kg_query` schema.
   *
   * Older deployed builds accept only `entity` / `direction` / `as_of` and reject
   * the whole call with `-32602 Unknown parameters`. Callers that wrap this in a
   * neutral-degrade helper would surface the rejection as "this entity has no
   * facts" and make every consolidated source look permanently unconsolidated. That
   * silent-false-negative is why we degrade explicitly (and log) instead of assuming
   * a fixed contract.
   *
   * So: prefer the server, and fall back to a client-side predicate filter when
   * it can't. The fallback is single-hop only — `recurse` / `max_depth` cannot be
   * emulated here — so a stale server yields shallow lineage rather than none.
   */
  async kgQuery(args: KGQueryArgs): Promise<JsonMap> {
    const predicate = asString(args.predicate).trim();
    const wireArgs: JsonMap = { entity: args.entity };
    if (args.direction) wireArgs.direction = args.direction;
    if (args.as_of) wireArgs.as_of = args.as_of;

    let result: JsonMap | undefined;

    if (!this.kgQueryTraversalUnsupported) {
      const fullArgs: JsonMap = { ...wireArgs };
      if (predicate) fullArgs.predicate = predicate;
      if (args.recurse) fullArgs.recurse = true;
      if (typeof args.max_depth === "number") fullArgs.max_depth = args.max_depth;

      const fullRes = await this.invoke("kgQuery", fullArgs);
      if (fullRes.ok === false) {
        if (this.isUnknownParameterError(new Error(fullRes.detail))) {
          // Explicit degrade: a pre-179c613 server rejected the traversal parameters.
          // Fall back to a single-hop client-side filter below (logged, cached).
          console.warn(`[memgraph] kg_query rejected traversal params for ${args.entity} (${fullRes.kind}), degrading to single-hop client-side filter: ${fullRes.detail}`);
          this.kgQueryTraversalUnsupported = true;
        } else {
          throw new Error(`substrate call failed (kg_query, kind=${fullRes.kind}): ${fullRes.detail}`);
        }
      } else {
        result = fullRes.value;
      }
    }

    if (result === undefined) result = await this.call("kgQuery", wireArgs);
    if (!predicate) return result;

    // Re-filter even when the server already did: it keeps both paths behaving
    // identically, so a traversal-capable server can't quietly widen what
    // callers like `isSourceDrawerConsolidated` treat as a match.
    const facts = parseKgFacts(result).filter((fact) => asString(fact.predicate).trim() === predicate);
    return { ...result, facts, count: facts.length };
  }

  // ── Static members: closed vocabularies / predicate names (unchanged API) ──

  static readonly OUTCOME_VALUES: readonly string[] = capability.OUTCOME_VALUES;

  static readonly CAPABILITY_OUTCOME_PREDICATE = capability.CAPABILITY_OUTCOME_PREDICATE;
  static readonly CAPABILITY_SHAPE_PREDICATE = capability.CAPABILITY_SHAPE_PREDICATE;
  static readonly CAPABILITY_TIER_PREDICATE = capability.CAPABILITY_TIER_PREDICATE;

  static readonly FAILURE_EVENT_PREDICATE = capability.FAILURE_EVENT_PREDICATE;
  static readonly FAILURE_SHAPE_PREDICATE = capability.FAILURE_SHAPE_PREDICATE;
  static readonly INTERVENTION_LABEL_PREDICATE = capability.INTERVENTION_LABEL_PREDICATE;
  static readonly INTERVENTION_TEXT_PREDICATE = capability.INTERVENTION_TEXT_PREDICATE;

  static readonly CALIBRATION_OUTCOME_PREDICATE = capability.CALIBRATION_OUTCOME_PREDICATE;
  /** Minimum pairs per (model, confidence-level) cell before any figure is reported/used. */
  static readonly MIN_CALIBRATION_SAMPLE = capability.MIN_CALIBRATION_SAMPLE;
  /** Closed confidence vocabulary for calibration cells (self-reported levels). */
  static readonly CALIBRATION_CONFIDENCE_VALUES: readonly string[] = capability.CALIBRATION_CONFIDENCE_VALUES;

  // ── Lineage / merge / hall (memgraph-lineage.ts) ───────────────────────────

  getOutgoingObjects(entity: string, predicate: string): Promise<string[]> {
    return lineage.getOutgoingObjects(this.core, entity, predicate);
  }

  isSourceDrawerConsolidated(drawerId: string): Promise<boolean> {
    return lineage.isSourceDrawerConsolidated(this.core, drawerId);
  }

  getLineageSources(nodeId: string, maxDepth = 20) {
    return lineage.getLineageSources(this.core, nodeId, maxDepth);
  }

  getLineageDerivatives(nodeId: string, maxDepth = 20) {
    return lineage.getLineageDerivatives(this.core, nodeId, maxDepth);
  }

  applyMerge(args: {
    source_node_id: string;
    canonical_node_id: string;
    ended?: string;
    invalidate_source_edges?: boolean;
  }) {
    return lineage.applyMerge(this.core, args);
  }

  resolveCanonical(nodeId: string, maxHops = 50) {
    return lineage.resolveCanonical(this.core, nodeId, maxHops);
  }

  getHeight(nodeId: string) {
    return lineage.getHeight(this.core, nodeId);
  }

  findMergeCandidates(args: {
    drawer_id?: string;
    threshold?: number;
    limit?: number;
    max_nodes?: number;
    max_depth?: number;
    wing?: string;
    room?: string;
    require_topological_distance?: boolean;
  }) {
    return lineage.findMergeCandidates(this.core, args);
  }

  findClosetLineageIssues(args: {
    wing?: string;
    room?: string;
    include_merged?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return lineage.findClosetLineageIssues(this.core, args);
  }

  getLineageIssues(args: {
    wing?: string;
    room?: string;
    include_merged?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return lineage.getLineageIssues(this.core, args);
  }

  listScopedDerivedDrawers(args: {
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
    return lineage.listScopedDerivedDrawers(this.core, args);
  }

  setHallLabels(args: {
    node_id: string;
    labels?: string[];
  }) {
    return lineage.setHallLabels(this.core, args);
  }

  getHallPolicy() {
    return lineage.getHallPolicy();
  }

  // ── Drawer CRUD + KG writes + source scope (memgraph-drawers.ts) ───────────

  addDrawer(args: {
    wing: string;
    room: string;
    content: string;
    source_file?: string;
    added_by?: string;
    desc?: string;
  }) {
    return drawers.addDrawer(this.core, args);
  }

  checkpoint(args: {
    items: Array<{
      wing: string;
      room: string;
      content: string;
      source_file?: string;
      added_by?: string;
      desc?: string;
    }>;
    dedup_threshold?: number;
    added_by?: string;
    diary?: {
      agent_name?: string;
      entry?: string;
      topic?: string;
      wing?: string;
    };
  }) {
    return drawers.checkpoint(this.core, args);
  }

  updateDrawer(args: {
    drawer_id: string;
    content?: string;
    wing?: string;
    room?: string;
  }) {
    return drawers.updateDrawer(this.core, args);
  }

  kgAdd(args: {
    subject: string;
    predicate: string;
    object: string;
    valid_from?: string;
    source_closet?: string;
    // P2-3: provenance — the run_id of the consolidation execution
    source_run_id?: string;
  }) {
    return drawers.kgAdd(this.core, args);
  }

  kgSupersede(args: {
    subject: string;
    predicate: string;
    old_object: string;
    new_object: string;
    source_closet?: string;
    source_run_id?: string;
  }) {
    return drawers.kgSupersede(this.core, args);
  }

  kgInvalidate(args: {
    subject: string;
    predicate: string;
    object: string;
    ended?: string;
  }) {
    return drawers.kgInvalidate(this.core, args);
  }

  createDerivedDrawer(args: {
    wing: string;
    room: string;
    content: string;
    source_drawer_ids: string[];
    desc: string;
    height?: number;
    source_file?: string;
    added_by?: string;
    labels?: string[];
    // P2-3: provenance — the run_id of the consolidation execution
    source_run_id?: string;
  }) {
    return drawers.createDerivedDrawer(this.core, args);
  }

  fileDeadEnd(args: {
    wing: string;
    room: string;
    content: string;
    statements: string[];
    polarity?: string;
    source_drawer_ids?: string[];
    desc?: string;
    added_by?: string;
    source_run_id?: string;
  }) {
    return drawers.fileDeadEnd(this.core, args);
  }

  search(query: string, limit = 5, wing?: string, room?: string) {
    return drawers.search(this.core, query, limit, wing, room);
  }

  listDrawers(args: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }) {
    return drawers.listDrawers(this.core, args);
  }

  getDrawer(args: {
    drawer_id: string;
  }) {
    return drawers.getDrawer(this.core, args);
  }

  listSourceDrawersByScope(args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
    return drawers.listSourceDrawersByScope(this.core, args);
  }

  findUnconsolidatedSourceDrawers(args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
    return drawers.findUnconsolidatedSourceDrawers(this.core, args);
  }

  // ── es-* axes + cross-type edge reads (memgraph-axes.ts) ───────────────────

  countDirectSources(closetId: string): Promise<number> {
    return axes.countDirectSources(this.core, closetId);
  }

  getClosetStatus(closetId: string): Promise<"provisional" | "active" | "unknown"> {
    return axes.getClosetStatus(this.core, closetId);
  }

  setClosetStatus(closetId: string, status: "provisional" | "active", sourceRunId?: string): Promise<void> {
    return axes.setClosetStatus(this.core, closetId, status, sourceRunId);
  }

  getClosetSourceType(closetId: string): Promise<ClosetSourceType | null> {
    return axes.getClosetSourceType(this.core, closetId);
  }

  getClosetDomain(closetId: string): Promise<SkillDomain | null> {
    return axes.getClosetDomain(this.core, closetId);
  }

  setClosetSourceType(closetId: string, sourceType: ClosetSourceType, sourceRunId?: string): Promise<boolean> {
    return axes.setClosetSourceType(this.core, closetId, sourceType, sourceRunId);
  }

  getStaleness(nodeId: string): Promise<string | null> {
    return axes.getStaleness(this.core, nodeId);
  }

  getStalenessFlags(
    nodeIds: string[],
    options?: { maxNodes?: number; concurrency?: number },
  ): Promise<Map<string, string | null>> {
    return axes.getStalenessFlags(this.core, nodeIds, options);
  }

  setStalenessFlag(nodeId: string, value: string, sourceRunId?: string): Promise<boolean> {
    return axes.setStalenessFlag(this.core, nodeId, value, sourceRunId);
  }

  getOutcomeCounts(
    nodeIds: string[],
    options?: { maxNodes?: number; concurrency?: number },
  ): Promise<Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>> {
    return axes.getOutcomeCounts(this.core, nodeIds, options);
  }

  recordOutcome(nodeId: string, outcome: string, validFrom?: string): Promise<void> {
    return axes.recordOutcome(this.core, nodeId, outcome, validFrom);
  }

  getConcerns(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    return axes.getConcerns(this.core, nodeId);
  }

  getRefinedBy(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    return axes.getRefinedBy(this.core, nodeId);
  }

  getRefines(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    return axes.getRefines(this.core, nodeId);
  }

  getPromotedFrom(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    return axes.getPromotedFrom(this.core, nodeId);
  }

  getRulesOut(nodeId: string): Promise<{ statements: string[]; polarities: string[]; count: number }> {
    return axes.getRulesOut(this.core, nodeId);
  }

  listReminders(
    args: { wing: string; room?: string; limit?: number },
  ): Promise<
    Array<{
      drawer_id: string;
      what: string;
      status: string;
      conditions: string[];
      expires_at?: string;
      satisfied_at?: string;
    }>
  > {
    return axes.listReminders(this.core, args);
  }

  // ── Phase 14/15/16 (memgraph-capability.ts) ────────────────────────────────

  recordCapabilityOutcome(bucketId: string, outcome: string, validFrom?: string): Promise<void> {
    return capability.recordCapabilityOutcome(this.core, bucketId, outcome, validFrom);
  }

  setCapabilityShape(bucketId: string, canonicalShape: string): Promise<boolean> {
    return capability.setCapabilityShape(this.core, bucketId, canonicalShape);
  }

  setCapabilityTier(bucketId: string, tier: string): Promise<boolean> {
    return capability.setCapabilityTier(this.core, bucketId, tier);
  }

  getCapabilityRoutingEvidence(
    shapeKeyOrCanonical: string,
    options?: { minSample?: number; concurrency?: number },
  ): Promise<{
    tiers: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }>;
    recommendation: string;
    fallback: boolean;
    threshold: number;
  }> {
    return capability.getCapabilityRoutingEvidence(this.core, shapeKeyOrCanonical, options);
  }

  recordFailureEvent(bucketId: string, event: string, validFrom?: string): Promise<void> {
    return capability.recordFailureEvent(this.core, bucketId, event, validFrom);
  }

  setFailureShape(bucketId: string, canonicalShape: string): Promise<boolean> {
    return capability.setFailureShape(this.core, bucketId, canonicalShape);
  }

  recordIntervention(patchId: string, label: string, text: string): Promise<boolean> {
    return capability.recordIntervention(this.core, patchId, label, text);
  }

  getFailureCounts(
    bucketId: string,
  ): Promise<{ spiral: number; loop: number; total: number }> {
    return capability.getFailureCounts(this.core, bucketId);
  }

  getFailureInterventions(
    modelId: string,
    shapeKey: string,
    options?: { maxPatches?: number },
  ): Promise<string[]> {
    return capability.getFailureInterventions(this.core, modelId, shapeKey, options);
  }

  getFailureAdjustedRouting(
    shapeKey: string,
    modelByTier: Record<string, string | null>,
    options?: { minSample?: number; minFailureSample?: number },
  ): Promise<{
    recommendation: string;
    fallback: boolean;
    threshold: number;
    tiers: Record<string, { baseRate: number | null; failureTotal: number; adjustedScore: number | null }>;
  }> {
    return capability.getFailureAdjustedRouting(this.core, shapeKey, modelByTier, options);
  }

  getCalibrationCell(
    modelId: string,
    shapeKey: string,
    confidence: string,
    options?: { minSample?: number },
  ): Promise<{
    bucketId: string;
    accept: number;
    revise: number;
    failed: number;
    unused: number;
    total: number;
    hitRate: number | null;
    sufficient: boolean;
    threshold: number;
  }> {
    return capability.getCalibrationCell(this.core, modelId, shapeKey, confidence, options);
  }

  getCalibrationTable(
    modelId: string,
    shapeKeys: string[],
    options?: { minSample?: number; maxShapes?: number; concurrency?: number },
  ): Promise<{
    model: string;
    threshold: number;
    rows: Array<{
      shapeKey: string;
      confidence: string;
      accept: number;
      revise: number;
      failed: number;
      unused: number;
      total: number;
      hitRate: number | null;
      sufficient: boolean;
    }>;
  }> {
    return capability.getCalibrationTable(this.core, modelId, shapeKeys, options);
  }

  decideCalibratedEscalation(args: {
    modelId: string;
    shapeKey: string;
    reportedConfidence: string;
    defaultAction?: "trust" | "escalate";
    minHitRate?: number;
    minSample?: number;
  }): Promise<{
    action: "trust" | "escalate";
    reason: string;
    hitRate: number | null;
    total: number;
    threshold: number;
  }> {
    return capability.decideCalibratedEscalation(this.core, args);
  }
}

export function createMemgraphClient(options: MemgraphClientOptions) {
  return new MemgraphClient(options);
}
