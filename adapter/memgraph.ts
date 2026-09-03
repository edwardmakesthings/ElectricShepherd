import { DEFAULT_MCP_TOOL_PREFIX } from "./runtime-config.ts";
import type { SubstrateResult } from "./mcp-http-client.ts";
// The namespaced update-drawer fallback names carry the `mempalace_` literal, so
// they live in core/ (binding rule: the prefix appears only there). Imported here.
import { UPDATE_DRAWER_FALLBACK_NAMES } from "../core/substrate-client.ts";

export type JsonMap = Record<string, unknown>;

/**
 * A substrate tool call. Returns `SubstrateResult` (slice 1) so a failed call is
 * distinguishable from an empty result — the transport never collapses errors into
 * `{}`. Callers that intentionally ignore a failure must do so explicitly and name
 * a reason (spec §4.1: "A caller that wants to ignore an error must say so
 * explicitly and name a reason").
 */
export type ToolCaller = (name: string, args?: JsonMap) => Promise<SubstrateResult<JsonMap>>;

export type MemgraphToolMap = {
  applyMerge: string;
  resolveCanonical: string;
  kgQuery: string;
  getHeight: string;
  findMergeCandidates: string;
  findClosetLineageIssues: string;
  addDrawer: string;
  checkpoint: string;
  updateDrawer: string;
  kgAdd: string;
  kgSupersede: string;
  kgInvalidate: string;
  search: string;
  listDrawers: string;
  getDrawer: string;
};

// Phase 1 (unified memory): the `es-source-type` axis — orthogonal to `es-status`.
export type ClosetSourceType = "transcript" | "doc" | "synthesis" | "skill";

const CLOSET_SOURCE_TYPES: readonly string[] = ["transcript", "doc", "synthesis", "skill"];

// Phase 12 (unified memory): the `es-domain` axis on skill drawers — a CLOSED
// vocabulary so domain drift cannot become room-sprawl wearing different clothes.
export type SkillDomain = "code" | "writing" | "infra" | "research" | "general";

export const SKILL_DOMAINS: readonly string[] = ["code", "writing", "infra", "research", "general"];

export type SourceDrawerWorkItem = {
  drawer_id: string;
  family_drawer_ids?: string[];
  wing?: string;
  room?: string;
  desc?: string;
  filed_at?: string;
  content?: string;
  source_file?: string;
  added_by?: string;
};

// Short base names — no prefix. MemPalace natively exposes these as `mempalace_<base>`.
// Some MCP gateways prepend a namespace, producing `<namespace>mempalace_<base>`. So:
//   Direct MCP (:8093):      prefix = "mempalace_"     (default)
//   Namespaced gateway:      prefix = "<namespace>mempalace_"
// The prefix is resolved once (constructor option > MEMGRAPH_TOOL_PREFIX env var > default).
const TOOL_BASE_NAMES: MemgraphToolMap = {
  applyMerge: "apply_merge",
  resolveCanonical: "resolve_canonical",
  kgQuery: "kg_query",
  getHeight: "get_height",
  findMergeCandidates: "find_merge_candidates",
  findClosetLineageIssues: "find_closet_lineage_issues",
  addDrawer: "add_drawer",
  checkpoint: "checkpoint",
  updateDrawer: "update_drawer",
  kgAdd: "kg_add",
  kgSupersede: "kg_supersede",
  kgInvalidate: "kg_invalidate",
  search: "search",
  listDrawers: "list_drawers",
  getDrawer: "get_drawer",
};

function resolveToolPrefix(explicit?: string): string {
  if (typeof explicit === "string") return explicit;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const fromEnv = env?.MEMGRAPH_TOOL_PREFIX;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : DEFAULT_MCP_TOOL_PREFIX;
}

function buildToolMap(prefix: string, overrides?: Partial<MemgraphToolMap>): MemgraphToolMap {
  const map = {} as MemgraphToolMap;
  for (const key of Object.keys(TOOL_BASE_NAMES) as (keyof MemgraphToolMap)[]) {
    map[key] = `${prefix}${TOOL_BASE_NAMES[key]}`;
  }
  return { ...map, ...(overrides || {}) };
}

export type MemgraphClientOptions = {
  callTool: ToolCaller;
  // Prefix applied to every MemPalace tool name. Falls back to the
  // MEMGRAPH_TOOL_PREFIX env var, then "mempalace_". Set this to
  // "<namespace>mempalace_" when calling through a namespaced MCP gateway.
  toolPrefix?: string;
  // Per-tool overrides win over the prefix-built names. Values are FULL tool
  // names (prefix included), for the rare case where one tool is exposed oddly.
  toolMap?: Partial<MemgraphToolMap>;
};

type ListSourceScopeArgs = {
  wing?: string;
  room?: string;
  limit?: number;
  offset?: number;
  pageSize?: number;
};

export class MemgraphClient {
  private readonly callTool: ToolCaller;
  private readonly tools: MemgraphToolMap;

  constructor(options: MemgraphClientOptions) {
    this.callTool = options.callTool;
    this.tools = buildToolMap(resolveToolPrefix(options.toolPrefix), options.toolMap);
  }

  /**
   * Normalize a ToolCaller result to a `SubstrateResult`. Real callers (turn-guard,
   * the consolidation/policy scripts) return a proper `SubstrateResult` via
   * `mcp.callToolResult`. Test fakes and any legacy caller may still return a raw
   * JsonMap — that is treated as an implicit success so existing fixtures keep
   * working without a mass rewrite. The boundary normalization lives here, in one
   * place, so the typed-failure contract holds for every real substrate call.
   */
  private async invoke(name: keyof MemgraphToolMap | string, args: JsonMap | undefined): Promise<SubstrateResult<JsonMap>> {
    const toolName = typeof name === "string" && !(name in this.tools) ? name : this.tools[name as keyof MemgraphToolMap];
    let raw: unknown;
    try {
      raw = await this.callTool(toolName, args || {});
    } catch (err) {
      // A throwing caller (e.g. mcp.callTool, which throws SubstrateError on failure)
      // is converted to an explicit failed result here so the degrade/propagate logic
      // in callIgnoringFailure / call can branch on it instead of receiving a throw.
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "protocol", detail };
    }
    if (raw && typeof raw === "object" && "ok" in raw) return raw as SubstrateResult<JsonMap>;
    // Legacy / test fake: a plain JsonMap with no `ok` discriminator is an implicit success.
    return { ok: true, value: (raw || {}) as JsonMap };
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
    const result = await this.invoke(name, args);
    if (result.ok === false) {
      console.warn(`[memgraph] ${this.tools[name]} failed (${result.kind}), ignoring by design — ${reason}: ${result.detail}`);
      return { __esError: `${result.kind}: ${result.detail}` };
    }
    return result.value;
  }

  /**
   * Run a kg_query through the public `kgQuery()` method (which handles param
   * stripping and the -32602 fallback) and degrade to an empty result on failure.
   * The reason is logged operator-visible so a broken substrate cannot masquerade as
   * "this entity has no facts".
   */
  private async kgQueryIgnoringFailure(
    args: {
      entity: string;
      as_of?: string;
      direction?: "incoming" | "outgoing" | "both";
      predicate?: string;
      recurse?: boolean;
      max_depth?: number;
    },
    reason: string,
  ): Promise<JsonMap> {
    try {
      return await this.kgQuery(args);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[memgraph] kg_query failed (${reason}), ignoring by design: ${detail}`);
      return { __esError: detail };
    }
  }

  private async call(name: keyof MemgraphToolMap, args?: JsonMap): Promise<JsonMap> {
    const result = await this.invoke(name, args);
    if (result.ok === false) {
      throw new Error(`substrate call failed (${this.tools[name]}, kind=${result.kind}): ${result.detail}`);
    }
    return result.value;
  }

  private shouldRetryWithDreamNamespacedTool(err: unknown): boolean {
    const message = String(err || "").toLowerCase();
    if (!message) return false;
    return (
      message.includes("not allowed") ||
      message.includes("not found") ||
      message.includes("unknown tool") ||
      message.includes("no such tool")
    );
  }

  private asObject(value: unknown): JsonMap {
    return value && typeof value === "object" ? (value as JsonMap) : {};
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private asString(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private asNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  private asBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    }
    if (typeof value === "number") return value !== 0;
    return fallback;
  }

  private uniq(values: string[]): string[] {
    return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  }

  private parseDrawerRows(payload: unknown): JsonMap[] {
    const root = this.asObject(payload);
    const pools = [
      ...this.asArray(root.drawers),
      ...this.asArray(root.results),
      ...this.asArray(root.items),
      ...this.asArray(root.nodes),
      ...this.asArray(root.data),
    ];
    return pools.map((row) => this.asObject(row)).filter((row) => Object.keys(row).length > 0);
  }

  private parseKgFacts(payload: unknown): JsonMap[] {
    const root = this.asObject(payload);
    const facts = this.asArray(root.facts);
    return facts.map((fact) => this.asObject(fact)).filter((fact) => Object.keys(fact).length > 0);
  }

  private uniqueFromFactsByDirection(facts: JsonMap[], direction: "incoming" | "outgoing"): string[] {
    const values: string[] = [];
    for (const fact of facts) {
      const current = this.asBoolean(fact.current, true);
      if (!current) continue;
      const next =
        direction === "incoming"
          ? this.asString(fact.subject || fact.node_id || fact.drawer_id || fact.id)
          : this.asString(fact.object || fact.node_id || fact.drawer_id || fact.id);
      const id = next.trim();
      if (id) values.push(id);
    }
    return this.uniq(values);
  }

  private parseRawMemoryItems(payload: unknown): SourceDrawerWorkItem[] {
    const pools = this.parseDrawerRows(payload);

    const out: SourceDrawerWorkItem[] = [];
    const seen = new Set<string>();

    for (const raw of pools) {
      const row = this.asObject(raw);
      const drawer_id = this.asString(row.drawer_id || row.node_id || row.id).trim();
      if (!drawer_id || seen.has(drawer_id)) continue;

      seen.add(drawer_id);
      out.push({
        drawer_id,
        wing: this.asString(row.wing || row.closet || row.namespace).trim() || undefined,
        room: this.asString(row.room).trim() || undefined,
        desc: this.asString(row.desc || row.title || row.summary).trim() || undefined,
        filed_at: this.asString(row.filed_at || row.created_at).trim() || undefined,
        content: this.asString(row.content || row.text).trim() || undefined,
        source_file: this.asString(row.source_file || this.asObject(row.metadata).source_file).trim() || undefined,
        added_by: this.asString(row.added_by || this.asObject(row.metadata).added_by).trim() || undefined,
      });
    }

    return out;
  }

  private normalizeSourceFileKey(sourceFile?: string): string {
    const value = this.asString(sourceFile).trim();
    if (!value) return "";
    return value.replace(/#chunk-\d+-of-\d+$/, "");
  }

  private collapseChunkedSourceItems(items: SourceDrawerWorkItem[]): SourceDrawerWorkItem[] {
    const out: SourceDrawerWorkItem[] = [];
    const byBase = new Map<string, SourceDrawerWorkItem>();
    const familyByBase = new Map<string, Set<string>>();

    for (const item of items) {
      const rawSource = this.asString(item.source_file).trim();
      const baseSource = this.normalizeSourceFileKey(rawSource);
      if (!baseSource) {
        out.push({
          ...item,
          family_drawer_ids: [item.drawer_id],
        });
        continue;
      }

      if (!familyByBase.has(baseSource)) familyByBase.set(baseSource, new Set<string>());
      familyByBase.get(baseSource)?.add(item.drawer_id);

      const existing = byBase.get(baseSource);
      if (!existing) {
        byBase.set(baseSource, item);
        continue;
      }

      const existingRaw = this.asString(existing.source_file).trim();
      const existingIsRoot = existingRaw === baseSource;
      const itemIsRoot = rawSource === baseSource;
      if (!existingIsRoot && itemIsRoot) {
        byBase.set(baseSource, item);
        continue;
      }

      const existingFiledAt = this.asString(existing.filed_at).trim();
      const itemFiledAt = this.asString(item.filed_at).trim();
      if (itemFiledAt && (!existingFiledAt || itemFiledAt < existingFiledAt)) {
        byBase.set(baseSource, item);
      }
    }

    const grouped = [...byBase.entries()].map(([baseSource, representative]) => ({
      ...representative,
      family_drawer_ids: [...(familyByBase.get(baseSource) || new Set<string>([representative.drawer_id]))],
    }));

    return [...out, ...grouped];
  }

  async getOutgoingObjects(entity: string, predicate: string): Promise<string[]> {
    // Degrade to "no facts" on read failure — the same neutral reading as an empty
    // result for every caller of this helper. The failure is logged (not silent) so a
    // broken substrate cannot masquerade as "this entity has no edges".
    const result = await this.kgQueryIgnoringFailure({
      entity,
      direction: "outgoing",
      predicate,
      recurse: false,
      max_depth: 1,
    }, `getOutgoingObjects(${entity}, ${predicate}) read failure degrades to no facts`);
    return this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
  }

  async isSourceDrawerConsolidated(drawerId: string): Promise<boolean> {
    const forward = await this.getOutgoingObjects(drawerId, "consolidated-into");
    if (forward.length > 0) return true;

    // Degrade to "not consolidated" on read failure — the conservative reading for a
    // consolidation worklist (a missed check re-surfaces the drawer next pass). The
    // failure is logged, not silent.
    const incoming = await this.kgQueryIgnoringFailure({
      entity: drawerId,
      direction: "incoming",
      predicate: "synthesized-from",
      recurse: false,
      max_depth: 1,
    }, `isSourceDrawerConsolidated(${drawerId}) read failure degrades to unconsolidated`);
    const incomingSynth = this.uniqueFromFactsByDirection(this.parseKgFacts(incoming), "incoming");
    return incomingSynth.length > 0;
  }

  async createDerivedDrawer(args: {
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
    const sourceDrawerIds = this.uniq(args.source_drawer_ids || []);
    const addResult = await this.addDrawer({
      wing: args.wing,
      room: args.room,
      content: args.content,
      source_file: args.source_file,
      added_by: args.added_by,
    });
    const id = this.asString(addResult.drawer_id || addResult.node_id || addResult.id).trim();
    if (!id) {
      return {
        success: false,
        error: "createDerivedDrawer: add_drawer returned no drawer id",
        add_result: addResult,
      };
    }

    const lineageErrors: string[] = [];
    let lineageEdgesAdded = 0;
    for (const sourceId of sourceDrawerIds) {
      // Explicit per-edge failure handling: a failed edge is recorded in
      // `lineageErrors` (operator-visible, returned to the caller) rather than
      // silently dropped. Both edges are attempted independently so one failure
      // never masks the other.
      const synthRes = await this.invoke("kgAdd", {
        subject: id,
        predicate: "synthesized-from",
        object: sourceId,
        source_closet: id,
        source_run_id: args.source_run_id,
      });
      if (synthRes.ok === false) {
        lineageErrors.push(`synthesized-from edge ${id} -> ${sourceId}: ${synthRes.kind}: ${synthRes.detail}`);
        continue;
      }
      // P1-3: forward edge — source drawer → new closet (cheap worklist exclusion)
      const fwdRes = await this.invoke("kgAdd", {
        subject: sourceId,
        predicate: "consolidated-into",
        object: id,
        source_closet: id,
        source_run_id: args.source_run_id,
      });
      if (fwdRes.ok === false) {
        lineageErrors.push(`consolidated-into edge ${sourceId} -> ${id}: ${fwdRes.kind}: ${fwdRes.detail}`);
        continue;
      }
      lineageEdgesAdded += 1;
    }

    // P2-2: stamp the new closet `provisional`. Validation promotes it to `active`
    // once it has >= 2 direct sources; until then it is filtered from default
    // retrieval. Vanilla-only (kg_add). Best-effort: a failed stamp must not fail
    // closet creation — an unstamped closet reads as "unknown" and stays visible.
    const statusStamp = await this.invoke("kgAdd", {
      subject: id,
      predicate: "es-status",
      object: "provisional",
      source_closet: id,
      source_run_id: args.source_run_id,
    });
    if (statusStamp.ok === false) {
      // non-fatal: leave the closet unstamped rather than fail creation (logged).
      console.warn(`[memgraph] es-status stamp failed for ${id} (kind=${statusStamp.kind}), leaving closet unstamped: ${statusStamp.detail}`);
    }

    // Phase 1: stamp the new closet `synthesis` on the es-source-type axis.
    // Independent of the es-status stamp above — one failure never masks the other;
    // a failed stamp leaves the axis "unknown".
    const typeStamp = await this.invoke("kgAdd", {
      subject: id,
      predicate: "es-source-type",
      object: "synthesis",
      source_closet: id,
      source_run_id: args.source_run_id,
    });
    if (typeStamp.ok === false) {
      // non-fatal: leave the closet unstamped rather than fail creation (logged).
      console.warn(`[memgraph] es-source-type stamp failed for ${id} (kind=${typeStamp.kind}), leaving axis unknown: ${typeStamp.detail}`);
    }

    return {
      success: lineageErrors.length === 0,
      node_id: id,
      drawer_id: id,
      lineage_edges_added: lineageEdgesAdded,
      lineage_errors: lineageErrors,
      add_result: addResult,
    };
  }

  applyMerge(args: {
    source_node_id: string;
    canonical_node_id: string;
    ended?: string;
    invalidate_source_edges?: boolean;
  }) {
    return this.call("applyMerge", args as unknown as JsonMap);
  }

  resolveCanonical(nodeId: string, maxHops = 50) {
    return this.call("resolveCanonical", { node_id: nodeId, max_hops: maxHops });
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
  async kgQuery(args: {
    entity: string;
    as_of?: string;
    direction?: "incoming" | "outgoing" | "both";
    predicate?: string;
    recurse?: boolean;
    max_depth?: number;
  }) {
    const predicate = this.asString(args.predicate).trim();
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
    const facts = this.parseKgFacts(result).filter((fact) => this.asString(fact.predicate).trim() === predicate);
    return { ...this.asObject(result), facts, count: facts.length };
  }

  async getLineageSources(nodeId: string, maxDepth = 20) {
    const result = await this.kgQuery({
      entity: nodeId,
      direction: "outgoing",
      predicate: "synthesized-from",
      recurse: true,
      max_depth: maxDepth,
    });
    const ancestorIds = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing").filter((id) => id !== nodeId);
    return {
      node_id: nodeId,
      max_depth: maxDepth,
      ancestors: ancestorIds.map((id) => ({ node_id: id })),
      count: ancestorIds.length,
      facts: result.facts,
    };
  }

  async getLineageDerivatives(nodeId: string, maxDepth = 20) {
    const result = await this.kgQuery({
      entity: nodeId,
      direction: "incoming",
      predicate: "synthesized-from",
      recurse: true,
      max_depth: maxDepth,
    });
    const descendantIds = this
      .uniqueFromFactsByDirection(this.parseKgFacts(result), "incoming")
      .filter((id) => id !== nodeId);
    return {
      node_id: nodeId,
      max_depth: maxDepth,
      descendants: descendantIds.map((id) => ({ node_id: id })),
      count: descendantIds.length,
      facts: result.facts,
    };
  }

  // ── Phase 4: concerns (synthesis -> doc authority pointer) ────────────────
  // `concerns` is a cross-type KG edge, NOT lineage: it must never count toward
  // height or feed getLineageSources/getLineageDerivatives. One-hop by design —
  // recursive concerns would create cycles through unrelated syntheses.

  /**
   * One-hop outgoing `concerns` targets for a synthesis node (its authority docs).
   * Degrades to "no concerns" on read failure, matching getOutgoingObjects.
   */
  async getConcerns(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    // Degrade to "no concerns" on read failure (logged), matching getOutgoingObjects.
    const result = await this.kgQueryIgnoringFailure({
      entity: nodeId,
      direction: "outgoing",
      predicate: "concerns",
      recurse: false,
      max_depth: 1,
    }, `getConcerns(${nodeId}) read failure degrades to no concerns`);
    const nodeIds = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing").filter(
      (id) => id !== nodeId,
    );
    return { node_ids: nodeIds, count: nodeIds.length };
  }

  // ── Phase 5: refined-by (skill -> evidence pointer) ───────────────────────
  // `refined-by` is a cross-type KG edge, NOT lineage: it must never count toward
  // height or feed getLineageSources/getLineageDerivatives. One-hop by design —
  // recursive refined-by would create cycles through unrelated sessions/syntheses.

  /**
   * One-hop incoming `refined-by` subjects for a session/synthesis/apprenticeship
   * node (the skills that point at it as evidence). Degrades to "no refined-by"
   * on read failure, matching getConcerns.
   */
  async getRefinedBy(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    // Degrade to "no refined-by" on read failure (logged), matching getConcerns.
    const result = await this.kgQueryIgnoringFailure({
      entity: nodeId,
      direction: "incoming",
      predicate: "refined-by",
      recurse: false,
      max_depth: 1,
    }, `getRefinedBy(${nodeId}) read failure degrades to no refined-by`);
    const nodeIds = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "incoming").filter(
      (id) => id !== nodeId,
    );
    return { node_ids: nodeIds, count: nodeIds.length };
  }

  /**
   * One-hop outgoing `refined-by` targets for a skill node (the sessions/syntheses/
   * apprenticeship worked examples that changed how it should work). Degrades to
   * "no refined-by" on read failure, matching getConcerns.
   */
  async getRefines(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    // Degrade to "no refined-by" on read failure (logged), matching getConcerns.
    const result = await this.kgQueryIgnoringFailure({
      entity: nodeId,
      direction: "outgoing",
      predicate: "refined-by",
      recurse: false,
      max_depth: 1,
    }, `getRefines(${nodeId}) read failure degrades to no refined-by`);
    const nodeIds = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing").filter(
      (id) => id !== nodeId,
    );
    return { node_ids: nodeIds, count: nodeIds.length };
  }


  // ── Phase 9: rules-out (dead-end / negative-knowledge pointer) ─────────────
  // `rules-out` is a cross-type KG edge, NOT lineage: it must never count toward
  // height or feed getLineageSources/getLineageDerivatives. One-hop by design —
  // recursive rules-out would create cycles through unrelated syntheses. The
  // subject is the dead-end drawer (a synthesis with negative polarity); the object
  // is the ruled-out statement text (free-text by approved Phase 9 design).

  // ── Phase 10: promoted-from (shared skill -> origin project skill) ───────────
  // `promoted-from` is a cross-type KG edge, NOT lineage: it must never count toward
  // height or feed getLineageSources/getLineageDerivatives. One-hop by design — the
  // origin drawer is a single, stable pointer (a skill is promoted at most once; the
  // duplicate guard in tools/promote_skill.ts keeps exactly one shared copy). The
  // subject is the SHARED wing's skill drawer; the object is the originating project
  // skill drawer, so provenance stays traceable after promotion.

  /**
   * One-hop `promoted-from` origin for a (shared) skill node: the originating
   * project skill drawer id(s). Degrades to "no origin" on read failure, matching
   * getConcerns. Read-only — promotion itself is written by tools/promote_skill.ts.
   */
  async getPromotedFrom(nodeId: string): Promise<{ node_ids: string[]; count: number }> {
    // Degrade to "no origin" on read failure (logged), matching getConcerns.
    const result = await this.kgQueryIgnoringFailure({
      entity: nodeId,
      direction: "outgoing",
      predicate: "promoted-from",
      recurse: false,
      max_depth: 1,
    }, `getPromotedFrom(${nodeId}) read failure degrades to no origin`);
    const nodeIds = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing").filter(
      (id) => id !== nodeId,
    );
    return { node_ids: nodeIds, count: nodeIds.length };
  }

  /**
   * One-hop outgoing `rules-out` facts for a dead-end node: the ruled-out statement
   * texts plus any polarity tokens ("tried-failed" | "considered-rejected"). Degrades
   * to "no rules-out" on read failure, matching getConcerns.
   */
  async getRulesOut(nodeId: string): Promise<{ statements: string[]; polarities: string[]; count: number }> {
    // Degrade to "no rules-out" on read failure (logged), matching getConcerns.
    const result = await this.kgQueryIgnoringFailure({
      entity: nodeId,
      direction: "outgoing",
      predicate: "rules-out",
      recurse: false,
      max_depth: 1,
    }, `getRulesOut(${nodeId}) read failure degrades to no rules-out`);
    const statements: string[] = [];
    const polarities: string[] = [];
    for (const fact of this.parseKgFacts(result)) {
      if (!this.asBoolean(fact.current, true)) continue;
      const object = this.asString(fact.object).trim();
      if (!object) continue;
      if (object === "tried-failed" || object === "considered-rejected") polarities.push(object);
      else statements.push(object);
    }
    return { statements: this.uniq(statements), polarities: this.uniq(polarities), count: this.uniq([...statements, ...polarities]).length };
  }

  /**
   * File ONE dead end as a negative-polarity synthesis drawer with its `rules-out`
   * edge(s). The drawer is created via createDerivedDrawer (which stamps
   * es-source-type: synthesis and es-status: provisional — dead ends are syntheses,
   * NOT a fourth source type) then gets one outgoing rules-out edge per ruled-out
   * statement plus an optional polarity token. `source_drawer_ids` carry the
   * synthesized-from lineage so the merge/height machinery can reason about it.
   * Best-effort per edge: a failed edge is reported, never aborts the filing.
   */
  async fileDeadEnd(args: {
    wing: string;
    room: string;
    /** The dead-end line(s), verbatim (tried + outcome clause + reason). One drawer per call. */
    content: string;
    /** Ruled-out statement text(s) — the topic/approach the edge points at. */
    statements: string[];
    /** "tried-failed" | "considered-rejected" (default tried-failed when omitted). */
    polarity?: string;
    source_drawer_ids?: string[];
    desc?: string;
    added_by?: string;
    source_run_id?: string;
  }): Promise<{ success: boolean; node_id?: string; rules_out_edges_added: number; errors: string[] }> {
    const statements = this.uniq(args.statements);
    if (statements.length === 0) {
      return { success: false, rules_out_edges_added: 0, errors: ["fileDeadEnd: at least one ruled-out statement is required"] };
    }

    const created = await this.createDerivedDrawer({
      wing: args.wing,
      room: args.room,
      content: args.content,
      source_drawer_ids: args.source_drawer_ids || [],
      desc: args.desc || statements[0],
      added_by: args.added_by || "electric-shepherd-dead-ends",
      source_run_id: args.source_run_id,
    });

    const nodeId = this.asString(created.node_id || created.drawer_id).trim();
    if (!created.success && !nodeId) {
      return { success: false, rules_out_edges_added: 0, errors: [...(created.lineage_errors || []), "fileDeadEnd: drawer creation failed"] };
    }

    const errors: string[] = [];
    let added = 0;
    for (const statement of statements) {
      // Explicit per-edge failure handling: a failed edge is reported in `errors`
      // (operator-visible, returned to the caller), never silently dropped.
      const res = await this.invoke("kgAdd", {
        subject: nodeId,
        predicate: "rules-out",
        object: statement,
        source_closet: nodeId,
        source_run_id: args.source_run_id,
      });
      if (res.ok === false) {
        errors.push(`rules-out edge ${nodeId} -> ${statement}: ${res.kind}: ${res.detail}`);
        continue;
      }
      added += 1;
    }
    const polarity = this.asString(args.polarity).trim();
    if (polarity === "tried-failed" || polarity === "considered-rejected") {
      const res = await this.invoke("kgAdd", {
        subject: nodeId,
        predicate: "rules-out",
        object: polarity,
        source_closet: nodeId,
        source_run_id: args.source_run_id,
      });
      if (res.ok === false) {
        errors.push(`rules-out edge ${nodeId} -> ${polarity}: ${res.kind}: ${res.detail}`);
      } else {
        added += 1;
      }
    }

    return { success: errors.length === 0 && created.success, node_id: nodeId, rules_out_edges_added: added, errors };
  }

  getHeight(nodeId: string) {
    return this.call("getHeight", { node_id: nodeId });
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
    return this.call("findMergeCandidates", args as unknown as JsonMap);
  }

  findClosetLineageIssues(args: {
    wing?: string;
    room?: string;
    include_merged?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return this.call("findClosetLineageIssues", args as unknown as JsonMap);
  }

  async getLineageIssues(args: {
    wing?: string;
    room?: string;
    include_merged?: boolean;
    limit?: number;
    offset?: number;
  }) {
    const result = await this.findClosetLineageIssues(args);
    const rows = this.asArray((result as JsonMap).orphans).map((row) => this.asObject(row));
    const normalized = rows.map((row) => ({
      node_id: this.asString(row.node_id || row.drawer_id || row.id),
      reasons: this.asArray(row.reasons).map((reason) => this.asString(reason)).filter(Boolean),
      ...row,
    }));
    return {
      ...result,
      orphans: normalized,
    };
  }

  async listScopedDerivedDrawers(args: {
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

    const listed = await this.listDrawers({
      wing: wingFilter,
      room: roomFilter,
      limit,
      offset,
    });

    const requestedLabels = this.uniq((args.match_labels || []).map((label) => this.asString(label).toLowerCase()));
    const matchMode: "any" | "all" = args.match_mode === "all" ? "all" : "any";
    const labeledOnly = Boolean(args.labeled_only);
    const includeMerged = Boolean(args.include_merged);

    const nodes: JsonMap[] = [];
    for (const row of this.parseDrawerRows(listed)) {
      const nodeId = this.asString(row.drawer_id || row.node_id || row.id).trim();
      if (!nodeId) continue;

      const rowWing = this.asString(row.wing || row.closet || row.namespace).trim();
      const rowRoom = this.asString(row.room).trim();
      if (scopeWing && rowWing && rowWing !== scopeWing) continue;
      if (scopeRoom && rowRoom && rowRoom !== scopeRoom) continue;

      let canonicalNodeId = nodeId;
      if (!includeMerged) {
        // Degrade to "not merged" on read failure (logged): an unreadable node is
        // kept in the listing rather than silently dropped.
        const resolved = this.asObject(
          await this.callIgnoringFailure("resolveCanonical", { node_id: nodeId }, `listScopedDerivedDrawers canonical check for ${nodeId} degrades to not-merged`),
        );
        canonicalNodeId = this.asString(resolved.canonical_node_id || nodeId).trim() || nodeId;
        if (canonicalNodeId !== nodeId) continue;
      }

      // Degrade to "no sources" on read failure (logged): an unreadable node is
      // skipped from the derived-drawer listing rather than silently dropped.
      const outgoingSynth = this.asObject(
        await this.kgQueryIgnoringFailure({
          entity: nodeId,
          direction: "outgoing",
          predicate: "synthesized-from",
          recurse: false,
          max_depth: 1,
        }, `listScopedDerivedDrawers lineage read for ${nodeId} degrades to no sources`),
      );
      const sourceIds = this.uniqueFromFactsByDirection(this.parseKgFacts(outgoingSynth), "outgoing");
      if (sourceIds.length === 0) continue;

      // Degrade to "no labels" on read failure (logged).
      const hallFacts = this.asObject(
        await this.kgQueryIgnoringFailure({
          entity: nodeId,
          direction: "outgoing",
          predicate: "in-hall",
          recurse: false,
          max_depth: 1,
        }, `listScopedDerivedDrawers hall read for ${nodeId} degrades to no labels`),
      );

      const labels = this.uniqueFromFactsByDirection(this.parseKgFacts(hallFacts), "outgoing").map((v) => v.toLowerCase());
      if (labeledOnly && labels.length === 0) continue;
      if (requestedLabels.length > 0) {
        const matchCount = labels.filter((label) => requestedLabels.includes(label)).length;
        const passes = matchMode === "all" ? matchCount === requestedLabels.length : matchCount > 0;
        if (!passes) continue;
      }

      // Degrade to height 0 on read failure (logged).
      const heightRes = this.asObject(
        await this.callIgnoringFailure("getHeight", { node_id: nodeId }, `listScopedDerivedDrawers height read for ${nodeId} degrades to 0`),
      );
      // Degrade to "no connections" on read failure (logged).
      const graphFacts = this.asObject(
        await this.kgQueryIgnoringFailure({
          entity: nodeId,
          direction: "both",
          recurse: false,
          max_depth: maxDepth,
        }, `listScopedDerivedDrawers graph read for ${nodeId} degrades to no connections`),
      );
      const graphFactCount = this.parseKgFacts(graphFacts).filter((fact) => this.asBoolean(fact.current, true)).length;

      nodes.push({
        node_id: nodeId,
        canonical_node_id: canonicalNodeId,
        wing: rowWing || undefined,
        room: rowRoom || undefined,
        desc: this.asString(row.desc || row.title || row.summary).trim() || undefined,
        content: this.asString(row.content).trim() || undefined,
        labels,
        height: this.asNumber(heightRes.height, 0),
        retrieval_count: this.asNumber(row.retrieval_count || this.asObject(row.metadata).retrieval_count, 0),
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

  async setHallLabels(args: {
    node_id: string;
    labels?: string[];
  }) {
    const labels = this.uniq((args.labels || []).map((label) => this.asString(label).toLowerCase()));
    // Degrade to "no current labels" on read failure (logged): an unreadable node
    // gets the requested labels added rather than being silently left untouched.
    const current = await this.kgQueryIgnoringFailure({
      entity: args.node_id,
      direction: "outgoing",
      predicate: "in-hall",
      recurse: false,
      max_depth: 1,
    }, `setHallLabels current-read for ${args.node_id} degrades to no labels`);

    const currentLabels = this.uniqueFromFactsByDirection(this.parseKgFacts(current), "outgoing");
    const toRemove = currentLabels.filter((label) => !labels.includes(label.toLowerCase()));
    const toAdd = labels.filter((label) => !currentLabels.map((v) => v.toLowerCase()).includes(label));

    // Explicit per-label failure handling: failed invalidations/adds are reported in
    // `errors` (operator-visible), never silently dropped. `success` is false if any
    // label operation failed.
    const errors: string[] = [];
    for (const label of toRemove) {
      const res = await this.invoke("kgInvalidate", {
        subject: args.node_id,
        predicate: "in-hall",
        object: label,
      });
      if (res.ok === false) errors.push(`invalidate in-hall ${args.node_id}/${label}: ${res.kind}: ${res.detail}`);
    }

    for (const label of toAdd) {
      const res = await this.invoke("kgAdd", {
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

  async getHallPolicy() {
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

  addDrawer(args: {
    wing: string;
    room: string;
    content: string;
    source_file?: string;
    added_by?: string;
    desc?: string;
  }) {
    return this.call("addDrawer", args as unknown as JsonMap);
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
    return this.call("checkpoint", args as unknown as JsonMap);
  }

  updateDrawer(args: {
    drawer_id: string;
    content?: string;
    wing?: string;
    room?: string;
  }) {
    return this.callWithUpdateDrawerFallback(args as unknown as JsonMap);
  }

  private async callWithUpdateDrawerFallback(args: JsonMap): Promise<JsonMap> {
    const primary = await this.invoke("updateDrawer", args);
    if (primary.ok === false) {
      let lastDetail: string;
      if (!this.shouldRetryWithDreamNamespacedTool(new Error(primary.detail))) throw new Error(`substrate call failed (${this.tools.updateDrawer}, kind=${primary.kind}): ${primary.detail}`);
      // The server rejected the prefixed name (not-found / not-allowed): try the
      // namespaced fallback tool names. Each failure is explicit; the last one wins.
      const fallbackNames: string[] = [...UPDATE_DRAWER_FALLBACK_NAMES];
      lastDetail = primary.detail;
      for (const toolName of fallbackNames) {
        const res = await this.invoke(toolName, args);
        if (res.ok === false) {
          lastDetail = res.detail;
        } else {
          return res.value;
        }
      }
      throw new Error(`update_drawer failed via all names (${this.tools.updateDrawer} + ${fallbackNames.join(", ")}): ${lastDetail}`);
    }
    return primary.value;
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
    return this.call("kgAdd", args as unknown as JsonMap);
  }

  kgSupersede(args: {
    subject: string;
    predicate: string;
    old_object: string;
    new_object: string;
    source_closet?: string;
    source_run_id?: string;
  }) {
    return this.call("kgSupersede", args as unknown as JsonMap);
  }

  kgInvalidate(args: {
    subject: string;
    predicate: string;
    object: string;
    ended?: string;
  }) {
    return this.call("kgInvalidate", args as unknown as JsonMap);
  }

  // ── P2-2: provisional -> active closet status ───────────────────────────────
  // Status is an `es-status` KG fact on the closet, NOT a hall/label (halls are
  // categorization). Written `provisional` at creation, promoted to `active` by
  // validation once the closet has enough DIRECT source support. Every operation
  // here is one-hop kg_query/kg_add/kg_invalidate — vanilla MemPalace only, no
  // dependency on the graph-tools PR — so behavior is identical with or without it.

  /** Count a closet's DIRECT sources via its outgoing one-hop synthesized-from edges. */
  async countDirectSources(closetId: string): Promise<number> {
    // Degrade to "no direct sources" on read failure (logged).
    const result = await this.kgQueryIgnoringFailure({
      entity: closetId,
      direction: "outgoing",
      predicate: "synthesized-from",
      recurse: false,
      max_depth: 1,
    }, `countDirectSources(${closetId}) read failure degrades to zero`);
    return this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing")
      .filter((id) => id !== closetId).length;
  }

  /** Read a closet's es-status. "provisional" | "active" | "unknown" (no stamp / legacy). */
  async getClosetStatus(closetId: string): Promise<"provisional" | "active" | "unknown"> {
    // Degrade to "unknown" on read failure (logged).
    const result = await this.kgQueryIgnoringFailure({
      entity: closetId,
      direction: "outgoing",
      predicate: "es-status",
      recurse: false,
      max_depth: 1,
    }, `getClosetStatus(${closetId}) read failure degrades to unknown`);
    const values = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
    if (values.includes("active")) return "active";
    if (values.includes("provisional")) return "provisional";
    return "unknown";
  }

  /** Set a closet's es-status, invalidating the opposite value first. Idempotent-safe. */
  async setClosetStatus(closetId: string, status: "provisional" | "active", sourceRunId?: string): Promise<void> {
    const opposite = status === "active" ? "provisional" : "active";
    // Best-effort invalidation of the opposite value (logged on failure): a stale
    // opposite fact does not block setting the new status — the add below is the
    // authoritative write. The add itself is NOT best-effort: it throws on failure.
    const invalidateRes = await this.invoke("kgInvalidate", { subject: closetId, predicate: "es-status", object: opposite });
    if (invalidateRes.ok === false) {
    console.warn(`[memgraph] es-status invalidation of ${closetId}/${opposite} failed (kind=${invalidateRes.kind}), continuing to set new status: ${invalidateRes.detail}`);
    }
    await this.kgAdd({
      subject: closetId,
      predicate: "es-status",
      object: status,
      source_closet: closetId,
      source_run_id: sourceRunId,
    });
  }

  // ── Phase 1: es-source-type stamp (orthogonal to es-status) ────────────────
  // The `es-source-type` KG fact records what KIND of material a closet holds
  // (transcript | doc | synthesis | skill). It is stamped at write time, never
  // conflated with `es-status` — each setter scopes its kg_invalidate to its own
  // predicate, so the two axes are independently settable by construction.

  /** Read a closet's es-source-type. Returns null when unstamped or on read failure. */
  async getClosetSourceType(closetId: string): Promise<ClosetSourceType | null> {
    // Degrade to "unstamped" on read failure (logged).
    const result = await this.kgQueryIgnoringFailure({
      entity: closetId,
      direction: "outgoing",
      predicate: "es-source-type",
      recurse: false,
      max_depth: 1,
    }, `getClosetSourceType(${closetId}) read failure degrades to unstamped`);
    const values = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
    for (const value of values) {
      if ((CLOSET_SOURCE_TYPES as readonly string[]).includes(value)) return value as ClosetSourceType;
    }
    return null;
  }

  // ── Phase 12: es-domain axis (skill drawers only) ───────────────────────────
  // `es-domain` records which project domain a skill belongs to. Written at skill
  // creation (file_skill / promote_skill); read by procedural retrieval to filter
  // shared-skill admission. Same one-hop read discipline as es-source-type.

  /** Read a closet's es-domain. Returns null when unstamped, out-of-vocabulary, or on read failure. */
  async getClosetDomain(closetId: string): Promise<SkillDomain | null> {
    // Degrade to "unstamped" on read failure (logged).
    const result = await this.kgQueryIgnoringFailure({
      entity: closetId,
      direction: "outgoing",
      predicate: "es-domain",
      recurse: false,
      max_depth: 1,
    }, `getClosetDomain(${closetId}) read failure degrades to unstamped`);
    const values = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
    for (const value of values) {
      if ((SKILL_DOMAINS as readonly string[]).includes(value)) return value as SkillDomain;
    }
    return null;
  }

  /**
   * Set a closet's es-source-type, invalidating any previous value first
   * (best-effort). Returns true on success, false on failure — never throws in
   * the normal flow. Does not touch `es-status` facts.
   */
  async setClosetSourceType(closetId: string, sourceType: ClosetSourceType, sourceRunId?: string): Promise<boolean> {
    const previous = await this.getClosetSourceType(closetId);
    if (previous === sourceType) return true;
    if (previous && previous !== sourceType) {
      const supersedeRes = await this.invoke("kgSupersede", {
        subject: closetId,
        predicate: "es-source-type",
        old_object: previous,
        new_object: sourceType,
        source_closet: closetId,
        source_run_id: sourceRunId,
      });
      if (supersedeRes.ok === false) {
        console.warn(`[memgraph] es-source-type supersede for ${closetId} (${previous} -> ${sourceType}) failed (kind=${supersedeRes.kind}), leaving axis unchanged: ${supersedeRes.detail}`);
        return false;
      }
      return true;
    }
    const addRes = await this.invoke("kgAdd", {
      subject: closetId,
      predicate: "es-source-type",
      object: sourceType,
      source_closet: closetId,
      source_run_id: sourceRunId,
    });
    if (addRes.ok === false) {
      // non-fatal: leave the closet unstamped rather than fail the caller (logged).
      console.warn(`[memgraph] es-source-type set for ${closetId} failed (kind=${addRes.kind}), leaving axis unknown: ${addRes.detail}`);
      return false;
    }
    return true;
  }


  // ── Phase 11: es-staleness axis (temporal validity flag) ───────────────────
  // `es-staleness` is a cross-type KG edge, NOT lineage: it must never count toward
  // height or feed getLineageSources/getLineageDerivatives. One-hop by design — a
  // staleness flag is a single marker on the node whose basis moved. The subject is
  // the flagged node (typically a synthesis whose `concerns` target changed); the
  // object is the flag value (`source-changed`). Flagging is soft: this axis NEVER
  // invalidates or mutates `es-status`, `es-source-type`, `es-outcome`, `rules-out`,
  // or any lineage predicate — its setter scopes kg_invalidate to `es-staleness`
  // only, same discipline as es-status / es-source-type.

  /** Read a node's es-staleness flag. Returns the current value (e.g. "source-changed") or null when unflagged or on read failure. */
  async getStaleness(nodeId: string): Promise<string | null> {
    // Degrade to "unflagged" on read failure (logged).
    const result = await this.kgQueryIgnoringFailure({
      entity: nodeId,
      direction: "outgoing",
      predicate: "es-staleness",
      recurse: false,
      max_depth: 1,
    }, `getStaleness(${nodeId}) read failure degrades to unflagged`);
    const values = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
    return values.length > 0 ? values[0] : null;
  }

  /**
   * Aggregate es-staleness flags for a bounded set of node ids. One one-hop outgoing
   * kg_query per id, run with bounded concurrency (8 — the only validated level in
   * this repo), never more than `maxNodes` ids. Read failures degrade to null
   * (unflagged) per node, matching getClosetSourceType's discipline.
   */
  async getStalenessFlags(
    nodeIds: string[],
    options?: { maxNodes?: number; concurrency?: number },
  ): Promise<Map<string, string | null>> {
    const ids = this.uniq(nodeIds).slice(0, Math.max(1, Number(options?.maxNodes ?? 50)));
    const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));

    const out = new Map<string, string | null>();
    let cursor = 0;
    const run = async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        // getStaleness already degrades a failed read to null (logged) and never
        // throws, so no wrapper is needed — the aggregate stays neutral per node.
        out.set(id, await this.getStaleness(id));
      }
    };
    const slots = Math.max(1, Math.min(concurrency, ids.length));
    if (ids.length > 0) await Promise.all(Array.from({ length: slots }, () => run()));
    return out;
  }

  /**
   * Set a node's es-staleness flag. If a previous `es-staleness` value exists and
   * differs, invalidate ONLY the prior `es-staleness` fact(s) for that node — never
   * `es-status`, `es-source-type`, `es-outcome`, `rules-out`, or lineage predicates.
   * Idempotent: when the current value already matches, no invalidation and no
   * duplicate kg_add are issued. Returns true on success, false on failure — never
   * throws in the normal flow.
   */
  async setStalenessFlag(nodeId: string, value: string, sourceRunId?: string): Promise<boolean> {
    const id = this.asString(nodeId).trim();
    if (!id) return false;
    const previous = await this.getStaleness(id);
    if (previous === value) {
      // Already current — no invalidation, no duplicate write.
      return true;
    }
    if (previous && previous !== value) {
      const supersedeRes = await this.invoke("kgSupersede", {
        subject: id,
        predicate: "es-staleness",
        old_object: previous,
        new_object: value,
        source_closet: id,
        source_run_id: sourceRunId,
      });
      if (supersedeRes.ok === false) {
        console.warn(`[memgraph] es-staleness supersede for ${id} (${previous} -> ${value}) failed (kind=${supersedeRes.kind}), leaving node unchanged: ${supersedeRes.detail}`);
        return false;
      }
      return true;
    }
    const addRes = await this.invoke("kgAdd", {
      subject: id,
      predicate: "es-staleness",
      object: value,
      source_closet: id,
      source_run_id: sourceRunId,
    });
    if (addRes.ok === false) {
      // non-fatal: leave the node unflagged rather than fail the caller (logged).
      console.warn(`[memgraph] es-staleness set for ${id} failed (kind=${addRes.kind}), leaving node unflagged: ${addRes.detail}`);
      return false;
    }
    return true;
  }


  // ── Phase 7: es-outcome axis (human-authoritative outcome feedback) ───────────
  // `es-outcome` edges record whether a closet actually helped a unit of work that
  // consulted it. Values: accept | revise | failed | unused. They ACCUMULATE —
  // multiple edges per closet are expected and meaningful (6 accepts + 1 revise is
  // different from 1 accept), so nothing here ever invalidates or collapses them.
  // Writes go through recordOutcome only (the human-authoritative path); this class
  // exposes the read side plus a validated single-edge writer for that path.

  static readonly OUTCOME_VALUES: readonly string[] = ["accept", "revise", "failed", "unused"];

  /**
   * Aggregate es-outcome counts for a bounded set of candidate node ids. One one-hop
   * outgoing kg_query per id, run with bounded concurrency (8 — the only validated
   * level in this repo), never more than `maxNodes` ids. Read failures degrade to
   * zero counts (neutral) per node, matching getClosetSourceType's discipline.
   */
  async getOutcomeCounts(
    nodeIds: string[],
    options?: { maxNodes?: number; concurrency?: number },
  ): Promise<Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>> {
    const ids = this.uniq(nodeIds).slice(0, Math.max(1, Number(options?.maxNodes ?? 50)));
    const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
    const empty = () => ({ accept: 0, revise: 0, failed: 0, unused: 0, total: 0 });

    const out = new Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>();
    let cursor = 0;
    const run = async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        // Degrade to "no history" on read failure (logged).
        const result = await this.kgQueryIgnoringFailure({
          entity: id,
          direction: "outgoing",
          predicate: "es-outcome",
          recurse: false,
          max_depth: 1,
        }, `getOutcomeCounts(${id}) read failure degrades to no history`);
        const counts = empty();
        for (const fact of this.parseKgFacts(result)) {
          if (!this.asBoolean(fact.current, true)) continue;
          const value = this.asString(fact.object).trim();
          if (value === "accept") counts.accept += 1;
          else if (value === "revise") counts.revise += 1;
          else if (value === "failed") counts.failed += 1;
          else if (value === "unused") counts.unused += 1;
          // unknown values are ignored — the axis is closed by construction
        }
        counts.total = counts.accept + counts.revise + counts.failed + counts.unused;
        out.set(id, counts);
      }
    };
    const slots = Math.max(1, Math.min(concurrency, ids.length));
    await Promise.all(Array.from({ length: slots }, () => run()));
    return out;
  }

  /**
   * Record ONE es-outcome edge for a closet (accumulation — never invalidates or
   * overwrites existing edges). `validFrom` timestamps the edge so consumers can
   * window recent history. Throws on an invalid outcome value: the axis is closed to
   * exactly accept | revise | failed | unused, and nothing else may enter it.
   */
  async recordOutcome(nodeId: string, outcome: string, validFrom?: string): Promise<void> {
    const id = this.asString(nodeId).trim();
    if (!id) throw new Error("recordOutcome: nodeId is required");
    if (!(MemgraphClient.OUTCOME_VALUES as readonly string[]).includes(outcome)) {
      throw new Error(
        `recordOutcome: invalid outcome "${outcome}" — must be one of ${MemgraphClient.OUTCOME_VALUES.join(" | ")}`,
      );
    }
    await this.kgAdd({
      subject: id,
      predicate: "es-outcome",
      object: outcome,
      valid_from: validFrom,
      source_closet: id,
    });
  }

  // ── Phase 14: capability memory (learned routing) axes ───────────────────────
  // `es-capability-outcome` edges record the outcome of one unit of work run at a
  // given tier for a given task shape. The subject is the deterministic capability
  // bucket id (`capability::<shapeKey>::<tier>`); the object is one of accept |
  // revise | failed | unused (the same closed set as es-outcome). Edges ACCUMULATE —
  // multiple edges per bucket are expected and meaningful, so nothing here ever
  // invalidates or collapses them.
  //
  // `es-capability-shape` / `es-capability-tier` carry the explainable metadata
  // (canonical shape summary string, tier value) on the same bucket node so a
  // human can read WHY a tier was chosen without re-deriving the shape. These are
  // best-effort: a failed stamp leaves the axis "unknown" but does not invalidate
  // the recorded outcome.
  //
  // NOTE: `es-capability-*` predicates are NEW and deliberately distinct from the
  // reserved set (synthesized-from, consolidated-into, merged-into, in-hall,
  // es-status, es-source-type, es-outcome, concerns, triggers-on, rules-out,
  // es-staleness). They must never count toward height or feed lineage traversal.

  static readonly CAPABILITY_OUTCOME_PREDICATE = "es-capability-outcome";
  static readonly CAPABILITY_SHAPE_PREDICATE = "es-capability-shape";
  static readonly CAPABILITY_TIER_PREDICATE = "es-capability-tier";

  /**
   * Record ONE capability outcome edge for a (shape, tier) bucket. Accumulation —
   * never invalidates or overwrites existing edges. `validFrom` timestamps the edge
   * so consumers can window recent history. Throws on an invalid outcome value:
   * the axis is closed to exactly accept | revise | failed | unused.
   */
  async recordCapabilityOutcome(bucketId: string, outcome: string, validFrom?: string): Promise<void> {
    const id = this.asString(bucketId).trim();
    if (!id) throw new Error("recordCapabilityOutcome: bucketId is required");
    if (!(MemgraphClient.OUTCOME_VALUES as readonly string[]).includes(outcome)) {
      throw new Error(
        `recordCapabilityOutcome: invalid outcome "${outcome}" — must be one of ${MemgraphClient.OUTCOME_VALUES.join(" | ")}`,
      );
    }
    await this.kgAdd({
      subject: id,
      predicate: MemgraphClient.CAPABILITY_OUTCOME_PREDICATE,
      object: outcome,
      valid_from: validFrom,
      source_closet: id,
    });
  }

  /**
   * Best-effort stamp of the canonical shape summary on a capability bucket.
   * Returns true on success, false on failure — never throws in the normal flow.
   */
  async setCapabilityShape(bucketId: string, canonicalShape: string): Promise<boolean> {
    const id = this.asString(bucketId).trim();
    const shape = this.asString(canonicalShape).trim();
    if (!id || !shape) return false;
    const res = await this.invoke("kgAdd", {
      subject: id,
      predicate: MemgraphClient.CAPABILITY_SHAPE_PREDICATE,
      object: shape,
      source_closet: id,
    });
    if (res.ok === false) {
      // non-fatal: leave the axis "unknown" rather than fail the caller (logged).
      console.warn(`[memgraph] es-capability-shape set for ${id} failed (kind=${res.kind}), leaving axis unknown: ${res.detail}`);
      return false;
    }
    return true;
  }

  /**
   * Best-effort stamp of the tier value on a capability bucket. Returns true on
   * success, false on failure — never throws in the normal flow.
   */
  async setCapabilityTier(bucketId: string, tier: string): Promise<boolean> {
    const id = this.asString(bucketId).trim();
    const value = this.asString(tier).trim();
    if (!id || !value) return false;
    const res = await this.invoke("kgAdd", {
      subject: id,
      predicate: MemgraphClient.CAPABILITY_TIER_PREDICATE,
      object: value,
      source_closet: id,
    });
    if (res.ok === false) {
      // non-fatal: leave the axis "unknown" rather than fail the caller (logged).
      console.warn(`[memgraph] es-capability-tier set for ${id} failed (kind=${res.kind}), leaving axis unknown: ${res.detail}`);
      return false;
    }
    return true;
  }

  /**
   * Phase 14 CONSUME: aggregate capability evidence per tier for a shape bucket.
   * One one-hop outgoing kg_query per tier bucket (local, cloud, deep), run with
   * bounded concurrency (8 — the only validated level in this repo). Read failures
   * degrade to zero counts (neutral) per tier, matching getOutcomeCounts' discipline.
   *
   * Returns per-tier counts plus a recommendation:
   *   - Only tiers with total >= minSample (default 5) are eligible.
   *   - Pick the highest accept_rate (accept/total); deterministic tie-break order:
   *     local, cloud, deep.
   *   - If none eligible => recommendation "no-data", fallback true.
   */
  async getCapabilityRoutingEvidence(
    shapeKeyOrCanonical: string,
    options?: { minSample?: number; concurrency?: number },
  ): Promise<{
    tiers: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }>;
    recommendation: string;
    fallback: boolean;
    threshold: number;
  }> {
    const shapeKey = this.asString(shapeKeyOrCanonical).trim();
    if (!shapeKey) {
      return {
        tiers: {},
        recommendation: "no-data",
        fallback: true,
        threshold: Math.max(1, Number(options?.minSample ?? 5)),
      };
    }

    const minSample = Math.max(1, Number(options?.minSample ?? 5));
    const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
    const tiers: Array<{ tier: string; bucketId: string }> = [
      { tier: "local", bucketId: `capability::${shapeKey}::local` },
      { tier: "cloud", bucketId: `capability::${shapeKey}::cloud` },
      { tier: "deep", bucketId: `capability::${shapeKey}::deep` },
    ];

    const empty = () => ({ accept: 0, revise: 0, failed: 0, unused: 0, total: 0 });
    const countsByTier = new Map<string, ReturnType<typeof empty>>();
    let cursor = 0;
    const run = async () => {
      while (cursor < tiers.length) {
        const index = cursor;
        cursor += 1;
        const { tier, bucketId } = tiers[index];
        const counts = empty();
        // Degrade to "no history" on read failure (logged).
        const result = await this.kgQueryIgnoringFailure({
          entity: bucketId,
          direction: "outgoing",
          predicate: MemgraphClient.CAPABILITY_OUTCOME_PREDICATE,
          recurse: false,
          max_depth: 1,
        }, `getCapabilityRoutingEvidence(${bucketId}) read failure degrades to no history`);
        for (const fact of this.parseKgFacts(result)) {
          if (!this.asBoolean(fact.current, true)) continue;
          const value = this.asString(fact.object).trim();
          if (value === "accept") counts.accept += 1;
          else if (value === "revise") counts.revise += 1;
          else if (value === "failed") counts.failed += 1;
          else if (value === "unused") counts.unused += 1;
          // unknown values are ignored — the axis is closed by construction
        }
        counts.total = counts.accept + counts.revise + counts.failed + counts.unused;
        countsByTier.set(tier, counts);
      }
    };
    const slots = Math.max(1, Math.min(concurrency, tiers.length));
    await Promise.all(Array.from({ length: slots }, () => run()));

    const tierCounts: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }> = {};
    for (const { tier } of tiers) {
      const counts = countsByTier.get(tier) || empty();
      tierCounts[tier] = {
        accept: counts.accept,
        revise: counts.revise,
        failed: counts.failed,
        unused: counts.unused,
        total: counts.total,
        sufficient_sample: counts.total >= minSample,
      };
    }

    // Recommendation: highest accept_rate among eligible tiers; deterministic tie-break.
    let recommendation = "no-data";
    let fallback = true;
    let bestRate = -1;
    for (const { tier } of tiers) {
      const counts = tierCounts[tier];
      if (!counts.sufficient_sample || counts.total === 0) continue;
      const rate = counts.accept / counts.total;
      if (rate > bestRate) {
        bestRate = rate;
        recommendation = tier;
        fallback = false;
      }
    }

    return { tiers: tierCounts, recommendation, fallback, threshold: minSample };
  }
  // ── Phase 15: per-model failure-mode memory axes ────────────────────────────
  // `es-failure-event` edges record one turn-guard intervention (spiral / loop)
  // attributed to a (model, task-shape) bucket. The subject is the deterministic
  // failure bucket id (`failure::<provider/model>::<shapeKey>`, shapeKey from the
  // SAME Phase 14/13 shape function — no second shape system); the object is one
  // of spiral | loop. Edges ACCUMULATE like es-capability-outcome: multiple edges
  // per bucket are expected and meaningful, nothing here invalidates them.
  //
  // `es-failure-shape` carries the canonical shape summary on the same bucket for
  // explainability (best-effort). `es-intervention-label` / `es-intervention-text`
  // live on patch nodes (`failure-patch::<model>::<shapeKey>::<label>`) and record
  // the prompt intervention that broke the loop for that (model, shape) — durable
  // procedural knowledge about a specific model.
  //
  // NOTE: `es-failure-*` / `es-intervention-*` predicates are NEW and deliberately
  // distinct from the reserved set (synthesized-from, consolidated-into, merged-into,
  // in-hall, es-status, es-source-type, es-outcome, concerns, triggers-on, rules-out,
  // es-staleness) and from Phase 14's `es-capability-*`. They must never count toward
  // height or feed lineage traversal.

  static readonly FAILURE_EVENT_PREDICATE = "es-failure-event";
  static readonly FAILURE_SHAPE_PREDICATE = "es-failure-shape";
  static readonly INTERVENTION_LABEL_PREDICATE = "es-intervention-label";
  static readonly INTERVENTION_TEXT_PREDICATE = "es-intervention-text";

  /**
   * Record ONE failure event edge for a (model, shape) bucket. Accumulation —
   * never invalidates or overwrites existing edges. `validFrom` timestamps the
   * edge so consumers can window recent history. Throws on an invalid event value:
   * the axis is closed to exactly spiral | loop.
   */
  async recordFailureEvent(bucketId: string, event: string, validFrom?: string): Promise<void> {
    const id = this.asString(bucketId).trim();
    if (!id) throw new Error("recordFailureEvent: bucketId is required");
    if (event !== "spiral" && event !== "loop") {
      throw new Error(`recordFailureEvent: invalid event "${event}" — must be spiral | loop`);
    }
    await this.kgAdd({
      subject: id,
      predicate: MemgraphClient.FAILURE_EVENT_PREDICATE,
      object: event,
      valid_from: validFrom,
      source_closet: id,
    });
  }

  /**
   * Best-effort stamp of the canonical shape summary on a failure bucket. Returns
   * true on success, false on failure — never throws in the normal flow.
   */
  async setFailureShape(bucketId: string, canonicalShape: string): Promise<boolean> {
    const id = this.asString(bucketId).trim();
    const shape = this.asString(canonicalShape).trim();
    if (!id || !shape) return false;
    const res = await this.invoke("kgAdd", {
      subject: id,
      predicate: MemgraphClient.FAILURE_SHAPE_PREDICATE,
      object: shape.slice(0, 200),
      source_closet: id,
    });
    if (res.ok === false) {
      // non-fatal: leave the axis "unknown" rather than fail the caller (logged).
      console.warn(`[memgraph] es-failure-shape set for ${id} failed (kind=${res.kind}), leaving axis unknown: ${res.detail}`);
      return false;
    }
    return true;
  }

  /**
   * Record a successful intervention (prompt patch) for a (model, shape, label)
   * node. The label is stamped on every write (idempotent — repeated identical
   * writes are harmless); the text is bounded by the caller before being passed.
   * Never throws in the normal flow.
   */
  async recordIntervention(patchId: string, label: string, text: string): Promise<boolean> {
    const id = this.asString(patchId).trim();
    const lbl = this.asString(label).trim();
    if (!id || !lbl) return false;
    const labelRes = await this.invoke("kgAdd", { subject: id, predicate: MemgraphClient.INTERVENTION_LABEL_PREDICATE, object: lbl, source_closet: id });
    if (labelRes.ok === false) {
      // non-fatal: an intervention write failure degrades to "no known patch" (logged).
      console.warn(`[memgraph] intervention label write for ${id} failed (kind=${labelRes.kind}), degrading to no known patch: ${labelRes.detail}`);
      return false;
    }
    const clipped = this.asString(text).trim().slice(0, 500);
    if (clipped) {
      const textRes = await this.invoke("kgAdd", { subject: id, predicate: MemgraphClient.INTERVENTION_TEXT_PREDICATE, object: clipped, source_closet: id });
      if (textRes.ok === false) {
        // non-fatal: the label is already stamped; a failed text write degrades to a
        // patch with no text (logged).
        console.warn(`[memgraph] intervention text write for ${id} failed (kind=${textRes.kind}), leaving patch without text: ${textRes.detail}`);
      }
    }
    return true;
  }

  /**
   * Phase 15 CONSUME (routing signal): aggregate failure events for a
   * (model, shape) bucket. One one-hop outgoing kg_query on es-failure-event.
   * Read failures degrade to zero counts (neutral) — a failed read must never look
   * like "this model is bad" or "this model is fine"; it looks like "no data".
   */
  async getFailureCounts(
    bucketId: string,
  ): Promise<{ spiral: number; loop: number; total: number }> {
    const id = this.asString(bucketId).trim();
    if (!id) return { spiral: 0, loop: 0, total: 0 };
    // Degrade to "no history" on read failure (logged). A failed read must never look
    // like "this model is bad" or "fine".
    const result = await this.kgQueryIgnoringFailure({
      entity: id,
      direction: "outgoing",
      predicate: MemgraphClient.FAILURE_EVENT_PREDICATE,
      recurse: false,
      max_depth: 1,
    }, `getFailureCounts(${id}) read failure degrades to no history`);
    let spiral = 0;
    let loop = 0;
    for (const fact of this.parseKgFacts(result)) {
      if (!this.asBoolean(fact.current, true)) continue;
      const value = this.asString(fact.object).trim();
      if (value === "spiral") spiral += 1;
      else if (value === "loop") loop += 1;
      // unknown values are ignored — the axis is closed by construction
    }
    return { spiral, loop, total: spiral + loop };
  }

  /**
   * Phase 15 CONSUME (prompt patches): fetch known successful intervention texts
   * for every patch node of a (model, shape). Bounded by maxPatches (default 4) —
   * one one-hop kg_query per candidate label. Read failures degrade to no patches;
   * absent data yields an empty list (no injection, no prompt bloat).
   */
  async getFailureInterventions(
    modelId: string,
    shapeKey: string,
    options?: { maxPatches?: number },
  ): Promise<string[]> {
    const model = this.asString(modelId).trim();
    const shape = this.asString(shapeKey).trim();
    if (!model || !shape) return [];
    const maxPatches = Math.max(1, Math.min(8, Number(options?.maxPatches ?? 4)));
    // Closed label vocabulary — the only patch nodes that can exist.
    const labels = ["spiral-nudge", "retry-nudge", "loop-block"];
    const out: string[] = [];
    for (const label of labels.slice(0, maxPatches)) {
      const patchId = `failure-patch::${model}::${shape}::${label}`;
      // Degrade to "no patch text" on read failure (logged). Absent data yields no
      // injection, no prompt bloat.
      const result = await this.kgQueryIgnoringFailure({
        entity: patchId,
        direction: "outgoing",
        predicate: MemgraphClient.INTERVENTION_TEXT_PREDICATE,
        recurse: false,
        max_depth: 1,
      }, `getFailureInterventions(${patchId}) read failure skips label`);
      for (const fact of this.parseKgFacts(result)) {
        if (!this.asBoolean(fact.current, true)) continue;
        const text = this.asString(fact.object).trim();
        if (text && !out.includes(text)) out.push(text);
      }
    }
    return out.slice(0, maxPatches);
  }

  /**
   * Phase 15 CONSUME (routing signal): combine Phase 14 capability evidence with
   * Phase 15 per-model failure counts into an ADJUSTED tier recommendation.
   *
   * This repo has no in-repo tier SELECTOR — the orchestrator that delegates units
   * to tiers lives outside this codebase (the task tool is invoked by the agent, not
   * by a routing function here). So the penalty integration is exposed as a
   * deterministic composed API: an external consumer calls this once before
   * choosing a tier and reads `recommendation` + `evidence`.
   * TODO(external-consumer): wire this into orchestrate-cloud's tier selection.
   *
   * Deterministic scoring (no LLM, no embeddings):
   *   base(tier)      = accept / total            (Phase 14 evidence; undefined if total < minSample)
   *   failureRate(m,s)= failures / max(failures, MIN_FAILURE_SAMPLE)
   *                    where failures = es-failure-event count for `failure::<model>::<shapeKey>`;
   *                    the denominator is clamped at MIN_FAILURE_SAMPLE so a single nudge
   *                    cannot dominate (mirrors Phase 14's min-sample discipline).
   *   score(tier)     = base(tier) - failureRate(modelOf(tier), shape)
   *   pick            = highest score among tiers with base defined; deterministic
   *                     tie-break order: local, cloud, deep. No eligible tier => "no-data".
   *
   * A model whose outputs get REVISE'd / nudged on a task class loses to a sibling
   * on that class independent of overall capability — exactly the spec's CONSUME #1.
   */
  async getFailureAdjustedRouting(
    shapeKey: string,
    modelByTier: Record<string, string | null>,
    options?: { minSample?: number; minFailureSample?: number },
  ): Promise<{
    recommendation: string;
    fallback: boolean;
    threshold: number;
    tiers: Record<string, { baseRate: number | null; failureTotal: number; adjustedScore: number | null }>;
  }> {
    const key = this.asString(shapeKey).trim();
    const minSample = Math.max(1, Number(options?.minSample ?? 5));
    const minFailureSample = Math.max(1, Number(options?.minFailureSample ?? 5));

    if (!key) {
      return { recommendation: "no-data", fallback: true, threshold: minSample, tiers: {} };
    }

    const evidence = await this.getCapabilityRoutingEvidence(key, { minSample });
    const tierNames = ["local", "cloud", "deep"];
    const tiers: Record<string, { baseRate: number | null; failureTotal: number; adjustedScore: number | null }> = {};

    for (const tier of tierNames) {
      const counts = evidence.tiers[tier];
      const total = counts?.total ?? 0;
      const sufficient = Boolean(counts?.sufficient_sample);
      const baseRate = sufficient && total > 0 ? counts.accept / total : null;

      // Failure propensity of the model pinned to this tier for THIS shape.
      // Unknown model (null/empty) => no penalty: an unattributable bucket must not
      // look like "this model is bad" or "fine" — it looks like no data.
      const modelId = this.asString(modelByTier?.[tier] ?? "").trim();
      let failureTotal = 0;
      if (modelId) {
        const counts2 = await this.getFailureCounts(`failure::${modelId}::${key}`);
        failureTotal = counts2.total;
      }
      const failureRate = failureTotal / Math.max(failureTotal, minFailureSample);
      tiers[tier] = {
        baseRate,
        failureTotal,
        adjustedScore: baseRate === null ? null : baseRate - failureRate,
      };
    }

    let recommendation = "no-data";
    let fallback = true;
    let bestScore = -Infinity;
    for (const tier of tierNames) {
      const score = tiers[tier].adjustedScore;
      if (score === null) continue;
      if (score > bestScore) {
        bestScore = score;
        recommendation = tier;
        fallback = false;
      }
    }

    return { recommendation, fallback, threshold: minSample, tiers };
  }



  // ── Phase 16: confidence calibration axes ─────────────────────────────────
  // `es-calibration-outcome` edges record one completed unit's tuple: the
  // self-reported confidence level (high | medium | low) paired with the ACTUAL
  // outcome — Phase 7's es-outcome value (accept | revise | failed | unused),
  // written ONLY by the human-authoritative record_outcome path. The subject is
  // the deterministic calibration bucket id (`calibration::<model>::<shapeKey>::<confidence>`,
  // model from Phase 15's canonicalModelId, shapeKey from the SAME Phase 14/13 shape
  // function — no second shape system). Edges ACCUMULATE like es-capability-outcome:
  // multiple edges per bucket are expected and meaningful; nothing here ever
  // invalidates or collapses them.
  //
  // MINIMUM SAMPLE GATE (spec's most dangerous failure mode): a calibration figure
  // is only reported/used once its (model, confidence-level) cell holds >= 20 pairs.
  // Below that, every consumer must report "insufficient data" and fall back to
  // default behaviour — an undersampled curve looks quantitative and gets believed.
  //
  // NOTE: `es-calibration-outcome` is NEW and deliberately distinct from the reserved
  // set (synthesized-from, consolidated-into, merged-into, in-hall, es-status,
  // es-source-type, es-outcome, concerns, triggers-on, rules-out, es-staleness) and
  // from Phase 14's `es-capability-*` / Phase 15's `es-failure-*` /
  // `es-intervention-*`. It must never count toward height or feed lineage traversal.

  static readonly CALIBRATION_OUTCOME_PREDICATE = "es-calibration-outcome";
  /** Minimum pairs per (model, confidence-level) cell before any figure is reported/used. */
  static readonly MIN_CALIBRATION_SAMPLE = 20;
  /** Closed confidence vocabulary for calibration cells (self-reported levels). */
  static readonly CALIBRATION_CONFIDENCE_VALUES: readonly string[] = ["high", "medium", "low"];

  /**
   * Phase 16 CONSUME: read one calibration cell — the (model, shapeKey, confidence)
   * bucket's outcome counts plus hit rate. One one-hop outgoing kg_query on
   * es-calibration-outcome. Read failures degrade to zero counts (neutral): a failed
   * read must look like "no data", never like "this model is miscalibrated".
   *
   * Hit rate = accept / total over the cell's tuples (the only positive outcome in
   * Phase 7's closed set). `sufficient` enforces the 20-pair minimum: below it,
   * `hitRate` is still computed for reporting transparency but consumers MUST treat
   * the cell as unusable and fall back to default behaviour.
   */
  async getCalibrationCell(
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
    const model = this.asString(modelId).trim();
    const shape = this.asString(shapeKey).trim();
    const level = this.asString(confidence).trim().toLowerCase();
    const minSample = Math.max(1, Number(options?.minSample ?? MemgraphClient.MIN_CALIBRATION_SAMPLE));
    if (!model || !shape || !(MemgraphClient.CALIBRATION_CONFIDENCE_VALUES as readonly string[]).includes(level)) {
      return { bucketId: "", accept: 0, revise: 0, failed: 0, unused: 0, total: 0, hitRate: null, sufficient: false, threshold: minSample };
    }

    const bucketId = `calibration::${model}::${shape}::${level}`;
    let accept = 0;
    let revise = 0;
    let failed = 0;
    let unused = 0;
    // Degrade to "no history" on read failure (logged). A failed read must look like
    // "no data", never like "this model is miscalibrated".
    const result = await this.kgQueryIgnoringFailure({
      entity: bucketId,
      direction: "outgoing",
      predicate: MemgraphClient.CALIBRATION_OUTCOME_PREDICATE,
      recurse: false,
      max_depth: 1,
    }, `getCalibrationCell(${bucketId}) read failure degrades to no history`);
    for (const fact of this.parseKgFacts(result)) {
      if (!this.asBoolean(fact.current, true)) continue;
      const value = this.asString(fact.object).trim();
      if (value === "accept") accept += 1;
      else if (value === "revise") revise += 1;
      else if (value === "failed") failed += 1;
      else if (value === "unused") unused += 1;
      // unknown values are ignored — the axis is closed by construction
    }
    const total = accept + revise + failed + unused;
    return {
      bucketId,
      accept,
      revise,
      failed,
      unused,
      total,
      hitRate: total > 0 ? accept / total : null,
      sufficient: total >= minSample,
      threshold: minSample,
    };
  }

  /**
   * Phase 16 CONSUME (reporting): the calibration table for one model across a
   * BOUNDED set of shape keys — rows of (shapeKey x confidence-level) with counts,
   * hit rate, and the 20-pair sufficiency flag. maxShapes caps the query fan-out
   * (default 8); concurrency is capped at 8 (the only validated level in this repo).
   * No shape keys => empty table with a note — there is deliberately no unbounded
   * enumeration of shapes (a room-paging-to-exhaustion analogue for graph nodes).
   */
  async getCalibrationTable(
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
    const model = this.asString(modelId).trim();
    const minSample = Math.max(1, Number(options?.minSample ?? MemgraphClient.MIN_CALIBRATION_SAMPLE));
    const maxShapes = Math.max(1, Math.min(16, Number(options?.maxShapes ?? 8)));
    const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
    if (!model) {
      return { model: "", threshold: minSample, rows: [] };
    }

    const shapes = this.uniq(shapeKeys).slice(0, maxShapes);
    const confidences = [...MemgraphClient.CALIBRATION_CONFIDENCE_VALUES];
    const cells: Array<{ shapeKey: string; confidence: string }> = [];
    for (const shape of shapes) {
      for (const level of confidences) {
        cells.push({ shapeKey: shape, confidence: level });
      }
    }

    const rows: Array<{
      shapeKey: string;
      confidence: string;
      accept: number;
      revise: number;
      failed: number;
      unused: number;
      total: number;
      hitRate: number | null;
      sufficient: boolean;
    }> = [];
    let cursor = 0;
    const run = async () => {
      while (cursor < cells.length) {
        const index = cursor;
        cursor += 1;
        const cell = cells[index];
        const result = await this.getCalibrationCell(model, cell.shapeKey, cell.confidence, { minSample });
        rows.push({
          shapeKey: cell.shapeKey,
          confidence: cell.confidence,
          accept: result.accept,
          revise: result.revise,
          failed: result.failed,
          unused: result.unused,
          total: result.total,
          hitRate: result.hitRate,
          sufficient: result.sufficient,
        });
      }
    };
    const slots = Math.max(1, Math.min(concurrency, cells.length || 1));
    if (cells.length > 0) {
      await Promise.all(Array.from({ length: slots }, () => run()));
    }

    // Deterministic row order: shapeKey ascending, then confidence high/medium/low.
    const levelRank = new Map(confidences.map((level, i) => [level, i]));
    rows.sort((a, b) => (a.shapeKey === b.shapeKey ? levelRank.get(a.confidence)! - levelRank.get(b.confidence)! : a.shapeKey.localeCompare(b.shapeKey)));
    return { model, threshold: minSample, rows };
  }

  /**
   * Phase 16 CONSUME (escalation triggers): the composed API for orchestrate-cloud.
   * This repo has no in-repo tier SELECTOR — the orchestrator that delegates units
   * lives outside this codebase — so the calibration decision is exposed as a
   * deterministic composed call: an external consumer invokes it once with the
   * unit's model, shape, and the self-reported confidence, and reads `action` +
   * `reason`. TODO(external-consumer): wire into orchestrate-cloud's escalation logic.
   *
   * Decision rule (deterministic, no LLM):
   *   - Cell insufficient (< 20 pairs) or unreadable => action = defaultAction,
   *     reason "insufficient-data" — fall back to current behaviour. A calibration
   *     curve built on five points is confidently wrong about confidence.
   *   - Cell sufficient: hitRate >= minHitRate (default 0.6) => "trust" the reported
   *     confidence (no escalation forced by calibration); hitRate < minHitRate =>
   *     "escalate" — the model's self-report at this level on this shape is measured
   *     unreliable, so a "high" report is weak evidence, not a green light.
   */
  async decideCalibratedEscalation(args: {
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
    const defaultAction = args.defaultAction === "escalate" ? "escalate" : "trust";
    const minHitRate = Math.max(0, Math.min(1, Number(args.minHitRate ?? 0.6)));
    const cell = await this.getCalibrationCell(args.modelId, args.shapeKey, args.reportedConfidence, {
      minSample: args.minSample,
    });

    if (!cell.sufficient || cell.hitRate === null) {
      return {
        action: defaultAction,
        reason: `insufficient-data (${cell.total}/${cell.threshold} pairs on ${args.modelId || "unknown-model"} / ${this.asString(args.reportedConfidence).trim().toLowerCase() || "unknown-level"})`,
        hitRate: cell.hitRate,
        total: cell.total,
        threshold: cell.threshold,
      };
    }

    if (cell.hitRate >= minHitRate) {
      return {
        action: "trust",
        reason: `measured-reliable (${(cell.hitRate * 100).toFixed(0)}% hit rate >= ${Math.round(minHitRate * 100)}% floor across ${cell.total} pairs on this shape)`,
        hitRate: cell.hitRate,
        total: cell.total,
        threshold: cell.threshold,
      };
    }
    return {
      action: "escalate",
      reason: `measured-unreliable (${(cell.hitRate * 100).toFixed(0)}% hit rate < ${Math.round(minHitRate * 100)}% floor on this shape)`,
      hitRate: cell.hitRate,
      total: cell.total,
      threshold: cell.threshold,
    };
  }

  /**
   * Phase 8 (unified memory): prospective-memory read side. One bounded page of
   * the reminders room + per-drawer one-hop kg_query for the reminder axes
   * (triggers-on / es-reminder-status / es-reminder-expires-at /
   * es-reminder-satisfied-at). Concurrency 8 — the only validated level in this
   * repo. Read failures degrade to empty facts per drawer (the render drops the
   * pending section rather than throwing); a failed room page degrades to [].
   */
  async listReminders(
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
    const wing = this.asString(args.wing).trim();
    if (!wing) return [];
    const room = this.asString(args.room).trim() || "reminders";
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));

    const pageRes = await this.invoke("listDrawers", { wing, room, limit, offset: 0 });
    if (pageRes.ok === false) {
      // non-fatal: the render degrades to "no pending section" (logged). A failed
      // room page must not look like "there are no reminders".
      console.warn(`[memgraph] listReminders room page (${wing}/${room}) failed (kind=${pageRes.kind}), rendering no pending section: ${pageRes.detail}`);
      return [];
    }
    const root = this.asObject(pageRes.value);
    const pool = Array.isArray(root.drawers)
      ? (root.drawers as unknown[])
      : Array.isArray(root.results)
        ? (root.results as unknown[])
        : [];
    const rows = pool.slice(0, limit).map((row) => this.asObject(row));

    const ids = rows
      .map((row) => this.asString(row.drawer_id || row.node_id || row.id).trim())
      .filter(Boolean);
    const byId = new Map<string, JsonMap>();
    for (const row of rows) {
      const id = this.asString(row.drawer_id || row.node_id || row.id).trim();
      if (id) byId.set(id, row);
    }

    const out: Array<{
      drawer_id: string;
      what: string;
      status: string;
      conditions: string[];
      expires_at?: string;
      satisfied_at?: string;
    }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        const row = byId.get(id) || {};
        const item: {
          drawer_id: string;
          what: string;
          status: string;
          conditions: string[];
          expires_at?: string;
          satisfied_at?: string;
        } = {
          drawer_id: id,
          what: this.asString(row.content || row.text).trim(),
          status: "unknown",
          conditions: [],
        };
        // Degrade to "no facts" on edge-read failure (logged).
        const result = await this.kgQueryIgnoringFailure(
          { entity: id, direction: "outgoing" },
          `listReminders(${id}) edge read failure degrades to no facts`,
        );
        for (const fact of this.parseKgFacts(result)) {
          if (!this.asBoolean(fact.current, true)) continue;
          const predicate = this.asString(fact.predicate).trim();
          const object = this.asString(fact.object).trim();
          if (!object) continue;
          if (predicate === "triggers-on") item.conditions.push(object);
          else if (predicate === "es-reminder-status") item.status = object.toLowerCase();
          else if (predicate === "es-reminder-expires-at") item.expires_at = object;
          else if (predicate === "es-reminder-satisfied-at") item.satisfied_at = object;
        }
        out.push(item);
      }
    };
    const slots = Math.max(1, Math.min(8, ids.length));
    if (ids.length > 0) await Promise.all(Array.from({ length: slots }, () => worker()));
    return out;
  }

  search(query: string, limit = 5, wing?: string, room?: string) {
    return this.call("search", { query, limit, wing, room });
  }

  listDrawers(args: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }) {
    return this.call("listDrawers", args as unknown as JsonMap);
  }

  getDrawer(args: {
    drawer_id: string;
  }) {
    return this.call("getDrawer", args as unknown as JsonMap);
  }

  async listSourceDrawersByScope(args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
    const limit = Math.max(1, Math.floor(this.asNumber(args.limit, 200)));
    const offsetStart = Math.max(0, Math.floor(this.asNumber(args.offset, 0)));
    const configuredPageSize = Math.max(1, Math.floor(this.asNumber(args.pageSize, 50)));
    const pageSize = Math.min(limit, configuredPageSize);
    const candidates: SourceDrawerWorkItem[] = [];
    let offset = offsetStart;

    while (candidates.length < limit) {
      const remaining = limit - candidates.length;
      const requestLimit = Math.max(1, Math.min(pageSize, remaining));
      const res = await this.listDrawers({
        wing: args.wing,
        room: args.room,
        limit: requestLimit,
        offset,
      });
      const pageCandidates = this.parseRawMemoryItems(res);
      if (pageCandidates.length === 0) break;
      candidates.push(...pageCandidates);
      if (pageCandidates.length < requestLimit) break;
      offset += requestLimit;
    }

    const out: SourceDrawerWorkItem[] = [];

    for (const item of candidates) {
      // Conservative fallback (logged): if lineage inspection fails, keep the item in
      // the raw worklist so consolidation does not silently miss evidence.
      const result = await this.kgQueryIgnoringFailure({
        entity: item.drawer_id,
        direction: "outgoing",
        predicate: "synthesized-from",
        recurse: false,
        max_depth: 1,
      }, `listSourceDrawersByScope(${item.drawer_id}) lineage read failure keeps item in worklist`);
      const sourceIds = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
      if (sourceIds.length === 0) {
        out.push(item);
      }
    }

    return this.collapseChunkedSourceItems(out);
  }

  async findUnconsolidatedSourceDrawers(args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
    const rawItems = await this.listSourceDrawersByScope(args);
    const out: SourceDrawerWorkItem[] = [];

    for (const item of rawItems) {
      // isSourceDrawerConsolidated already degrades read failures to "unconsolidated"
      // (logged), so a broken substrate re-surfaces the drawer rather than dropping it.
      if (!(await this.isSourceDrawerConsolidated(item.drawer_id))) out.push(item);
    }

    return out;
  }
}

export function createMemgraphClient(options: MemgraphClientOptions) {
  return new MemgraphClient(options);
}
