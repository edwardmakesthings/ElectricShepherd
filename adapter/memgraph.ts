export type JsonMap = Record<string, unknown>;

export type ToolCaller = (name: string, args?: JsonMap) => Promise<JsonMap>;

export type MemgraphToolMap = {
  applyMerge: string;
  resolveCanonical: string;
  kgQuery: string;
  getHeight: string;
  findMergeCandidates: string;
  findClosetLineageIssues: string;
  addDrawer: string;
  updateDrawer: string;
  kgAdd: string;
  kgInvalidate: string;
  search: string;
  listDrawers: string;
  getDrawer: string;
};

// Phase 1 (unified memory): the `es-source-type` axis — orthogonal to `es-status`.
export type ClosetSourceType = "transcript" | "doc" | "synthesis" | "skill";

const CLOSET_SOURCE_TYPES: readonly string[] = ["transcript", "doc", "synthesis", "skill"];

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
  updateDrawer: "update_drawer",
  kgAdd: "kg_add",
  kgInvalidate: "kg_invalidate",
  search: "search",
  listDrawers: "list_drawers",
  getDrawer: "get_drawer",
};

const DEFAULT_TOOL_PREFIX = "mempalace_";

function resolveToolPrefix(explicit?: string): string {
  if (typeof explicit === "string") return explicit;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const fromEnv = env?.MEMGRAPH_TOOL_PREFIX;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : DEFAULT_TOOL_PREFIX;
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

  private async call(name: keyof MemgraphToolMap, args?: JsonMap): Promise<JsonMap> {
    return this.callTool(this.tools[name], args || {});
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
    const result = await this.kgQuery({
      entity,
      direction: "outgoing",
      predicate,
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
    return this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
  }

  async isSourceDrawerConsolidated(drawerId: string): Promise<boolean> {
    const forward = await this.getOutgoingObjects(drawerId, "consolidated-into");
    if (forward.length > 0) return true;

    const incoming = await this.kgQuery({
      entity: drawerId,
      direction: "incoming",
      predicate: "synthesized-from",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
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
      try {
        await this.kgAdd({
          subject: id,
          predicate: "synthesized-from",
          object: sourceId,
          source_closet: id,
          source_run_id: args.source_run_id,
        });
        // P1-3: forward edge — source drawer → new closet (cheap worklist exclusion)
        await this.kgAdd({
          subject: sourceId,
          predicate: "consolidated-into",
          object: id,
          source_closet: id,
          source_run_id: args.source_run_id,
        });
        lineageEdgesAdded += 1;
      } catch (err) {
        lineageErrors.push(String(err));
      }
    }

    // P2-2: stamp the new closet `provisional`. Validation promotes it to `active`
    // once it has >= 2 direct sources; until then it is filtered from default
    // retrieval. Vanilla-only (kg_add). Best-effort: a failed stamp must not fail
    // closet creation — an unstamped closet reads as "unknown" and stays visible.
    try {
      await this.kgAdd({
        subject: id,
        predicate: "es-status",
        object: "provisional",
        source_closet: id,
        source_run_id: args.source_run_id,
      });
    } catch {
      // non-fatal: leave the closet unstamped rather than fail creation
    }

    // Phase 1: stamp the new closet `synthesis` on the es-source-type axis.
    // Independent of the es-status stamp above — separate try/catch so one
    // failure never masks the other; a failed stamp leaves the axis "unknown".
    try {
      await this.kgAdd({
        subject: id,
        predicate: "es-source-type",
        object: "synthesis",
        source_closet: id,
        source_run_id: args.source_run_id,
      });
    } catch {
      // non-fatal: leave the closet unstamped rather than fail creation
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
   * the whole call with `-32602 Unknown parameters`. Every caller here wraps this
   * in `.catch(() => ({}))`, so against such a server the rejection surfaced as
   * "this entity has no facts" and made every consolidated source look
   * permanently unconsolidated. That silent-false-negative is why we degrade
   * explicitly instead of assuming a fixed contract.
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

      try {
        result = await this.call("kgQuery", fullArgs);
      } catch (err) {
        if (!this.isUnknownParameterError(err)) throw err;
        this.kgQueryTraversalUnsupported = true;
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
    const result = await this.kgQuery({
      entity: nodeId,
      direction: "outgoing",
      predicate: "concerns",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
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
    const result = await this.kgQuery({
      entity: nodeId,
      direction: "incoming",
      predicate: "refined-by",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
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
    const result = await this.kgQuery({
      entity: nodeId,
      direction: "outgoing",
      predicate: "refined-by",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
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

  /**
   * One-hop outgoing `rules-out` facts for a dead-end node: the ruled-out statement
   * texts plus any polarity tokens ("tried-failed" | "considered-rejected"). Degrades
   * to "no rules-out" on read failure, matching getConcerns.
   */
  async getRulesOut(nodeId: string): Promise<{ statements: string[]; polarities: string[]; count: number }> {
    const result = await this.kgQuery({
      entity: nodeId,
      direction: "outgoing",
      predicate: "rules-out",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
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
      try {
        await this.kgAdd({
          subject: nodeId,
          predicate: "rules-out",
          object: statement,
          source_closet: nodeId,
          source_run_id: args.source_run_id,
        });
        added += 1;
      } catch (err) {
        errors.push(String(err));
      }
    }
    const polarity = this.asString(args.polarity).trim();
    if (polarity === "tried-failed" || polarity === "considered-rejected") {
      try {
        await this.kgAdd({
          subject: nodeId,
          predicate: "rules-out",
          object: polarity,
          source_closet: nodeId,
          source_run_id: args.source_run_id,
        });
        added += 1;
      } catch (err) {
        errors.push(String(err));
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
        const resolved = this.asObject(await this.resolveCanonical(nodeId).catch(() => ({ canonical_node_id: nodeId })));
        canonicalNodeId = this.asString(resolved.canonical_node_id || nodeId).trim() || nodeId;
        if (canonicalNodeId !== nodeId) continue;
      }

      const outgoingSynth = this.asObject(
        await this.kgQuery({
          entity: nodeId,
          direction: "outgoing",
          predicate: "synthesized-from",
          recurse: false,
          max_depth: 1,
        }).catch(() => ({})),
      );
      const sourceIds = this.uniqueFromFactsByDirection(this.parseKgFacts(outgoingSynth), "outgoing");
      if (sourceIds.length === 0) continue;

      const hallFacts = this.asObject(
        await this.kgQuery({
          entity: nodeId,
          direction: "outgoing",
          predicate: "in-hall",
          recurse: false,
          max_depth: 1,
        }).catch(() => ({})),
      );

      const labels = this.uniqueFromFactsByDirection(this.parseKgFacts(hallFacts), "outgoing").map((v) => v.toLowerCase());
      if (labeledOnly && labels.length === 0) continue;
      if (requestedLabels.length > 0) {
        const matchCount = labels.filter((label) => requestedLabels.includes(label)).length;
        const passes = matchMode === "all" ? matchCount === requestedLabels.length : matchCount > 0;
        if (!passes) continue;
      }

      const heightRes = this.asObject(await this.getHeight(nodeId).catch(() => ({ height: 0 })));
      const graphFacts = this.asObject(
        await this.kgQuery({
          entity: nodeId,
          direction: "both",
          recurse: false,
          max_depth: maxDepth,
        }).catch(() => ({})),
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
    const current = await this.kgQuery({
      entity: args.node_id,
      direction: "outgoing",
      predicate: "in-hall",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));

    const currentLabels = this.uniqueFromFactsByDirection(this.parseKgFacts(current), "outgoing");
    const toRemove = currentLabels.filter((label) => !labels.includes(label.toLowerCase()));
    const toAdd = labels.filter((label) => !currentLabels.map((v) => v.toLowerCase()).includes(label));

    for (const label of toRemove) {
      await this.kgInvalidate({
        subject: args.node_id,
        predicate: "in-hall",
        object: label,
      }).catch(() => ({}));
    }

    for (const label of toAdd) {
      await this.kgAdd({
        subject: args.node_id,
        predicate: "in-hall",
        object: label,
        source_closet: args.node_id,
      }).catch(() => ({}));
    }

    return {
      success: true,
      node_id: args.node_id,
      labels,
      invalidated_labels: toRemove,
      added_labels: toAdd,
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
  }) {
    return this.call("addDrawer", args as unknown as JsonMap);
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
    try {
      return await this.call("updateDrawer", args);
    } catch (err) {
      if (!this.shouldRetryWithDreamNamespacedTool(err)) throw err;
      const fallbackNames = [
        "mempalace-mempalace_update_drawer",
        "dream_mempalace-mempalace_update_drawer",
      ];
      let lastErr: unknown = err;
      for (const toolName of fallbackNames) {
        try {
          return await this.callTool(toolName, args);
        } catch (fallbackErr) {
          lastErr = fallbackErr;
        }
      }
      throw lastErr;
    }
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
    const result = await this.kgQuery({
      entity: closetId,
      direction: "outgoing",
      predicate: "synthesized-from",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
    return this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing")
      .filter((id) => id !== closetId).length;
  }

  /** Read a closet's es-status. "provisional" | "active" | "unknown" (no stamp / legacy). */
  async getClosetStatus(closetId: string): Promise<"provisional" | "active" | "unknown"> {
    const result = await this.kgQuery({
      entity: closetId,
      direction: "outgoing",
      predicate: "es-status",
      recurse: false,
      max_depth: 1,
    }).catch(() => ({}));
    const values = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
    if (values.includes("active")) return "active";
    if (values.includes("provisional")) return "provisional";
    return "unknown";
  }

  /** Set a closet's es-status, invalidating the opposite value first. Idempotent-safe. */
  async setClosetStatus(closetId: string, status: "provisional" | "active", sourceRunId?: string): Promise<void> {
    const opposite = status === "active" ? "provisional" : "active";
    await this.kgInvalidate({ subject: closetId, predicate: "es-status", object: opposite }).catch(() => ({}));
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
    try {
      const result = await this.kgQuery({
        entity: closetId,
        direction: "outgoing",
        predicate: "es-source-type",
        recurse: false,
        max_depth: 1,
      });
      const values = this.uniqueFromFactsByDirection(this.parseKgFacts(result), "outgoing");
      for (const value of values) {
        if ((CLOSET_SOURCE_TYPES as readonly string[]).includes(value)) return value as ClosetSourceType;
      }
      return null;
    } catch {
      // non-fatal: a failed read reads as "unstamped", not an error
      return null;
    }
  }

  /**
   * Set a closet's es-source-type, invalidating any previous value first
   * (best-effort). Returns true on success, false on failure — never throws in
   * the normal flow. Does not touch `es-status` facts.
   */
  async setClosetSourceType(closetId: string, sourceType: ClosetSourceType, sourceRunId?: string): Promise<boolean> {
    try {
      const previous = await this.getClosetSourceType(closetId);
      if (previous && previous !== sourceType) {
        await this.kgInvalidate({ subject: closetId, predicate: "es-source-type", object: previous }).catch(() => ({}));
      }
      await this.kgAdd({
        subject: closetId,
        predicate: "es-source-type",
        object: sourceType,
        source_closet: closetId,
        source_run_id: sourceRunId,
      });
      return true;
    } catch {
      // non-fatal: leave the closet unstamped rather than fail the caller
      return false;
    }
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
        try {
          const result = await this.kgQuery({
            entity: id,
            direction: "outgoing",
            predicate: "es-outcome",
            recurse: false,
            max_depth: 1,
          });
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
        } catch {
          out.set(id, empty()); // non-fatal: a failed read reads as "no history" (neutral)
        }
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

    let rows: JsonMap[];
    try {
      const payload = await this.listDrawers({ wing, room, limit, offset: 0 });
      const root = this.asObject(payload);
      const pool = Array.isArray(root.drawers)
        ? (root.drawers as unknown[])
        : Array.isArray(root.results)
          ? (root.results as unknown[])
          : [];
      rows = pool.slice(0, limit).map((row) => this.asObject(row));
    } catch {
      return []; // non-fatal: the render degrades to "no pending section"
    }

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
        try {
          const result = await this.kgQuery({ entity: id, direction: "outgoing" });
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
        } catch {
          // non-fatal: a failed edge read reads as "no facts" for this drawer
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
      try {
        const outgoing = await this.kgQuery({
          entity: item.drawer_id,
          direction: "outgoing",
          predicate: "synthesized-from",
          recurse: false,
          max_depth: 1,
        });
        const sourceIds = this.uniqueFromFactsByDirection(this.parseKgFacts(outgoing), "outgoing");
        if (sourceIds.length === 0) {
          out.push(item);
        }
      } catch {
        // Conservative fallback: if lineage inspection fails, keep the item in
        // the raw worklist so consolidation does not silently miss evidence.
        out.push(item);
      }
    }

    return this.collapseChunkedSourceItems(out);
  }

  async findUnconsolidatedSourceDrawers(args: ListSourceScopeArgs): Promise<SourceDrawerWorkItem[]> {
    const rawItems = await this.listSourceDrawersByScope(args);
    const out: SourceDrawerWorkItem[] = [];

    for (const item of rawItems) {
      try {
        if (!(await this.isSourceDrawerConsolidated(item.drawer_id))) out.push(item);
      } catch {
        // Conservative fallback: if lineage inspection fails, keep the item in
        // the worklist so consolidation does not silently miss a raw memory.
        out.push(item);
      }
    }

    return out;
  }
}

export function createMemgraphClient(options: MemgraphClientOptions) {
  return new MemgraphClient(options);
}
