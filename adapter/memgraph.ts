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

export type SourceDrawerWorkItem = {
  drawer_id: string;
  wing?: string;
  room?: string;
  desc?: string;
  filed_at?: string;
  content?: string;
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
      });
    }

    return out;
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
        });
        lineageEdgesAdded += 1;
      } catch (err) {
        lineageErrors.push(String(err));
      }
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

  kgQuery(args: {
    entity: string;
    as_of?: string;
    direction?: "incoming" | "outgoing" | "both";
    predicate?: string;
    recurse?: boolean;
    max_depth?: number;
  }) {
    return this.call("kgQuery", args as unknown as JsonMap);
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
    return this.call("updateDrawer", args as unknown as JsonMap);
  }

  kgAdd(args: {
    subject: string;
    predicate: string;
    object: string;
    valid_from?: string;
    source_closet?: string;
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

  async listSourceDrawersByScope(args: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }): Promise<SourceDrawerWorkItem[]> {
    const res = await this.listDrawers({
      wing: args.wing,
      room: args.room,
      limit: args.limit,
      offset: args.offset,
    });
    const candidates = this.parseRawMemoryItems(res);
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

    return out;
  }

  async findUnconsolidatedSourceDrawers(args: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }): Promise<SourceDrawerWorkItem[]> {
    const rawItems = await this.listSourceDrawersByScope(args);
    const out: SourceDrawerWorkItem[] = [];

    for (const item of rawItems) {
      try {
        const incoming = await this.kgQuery({
          entity: item.drawer_id,
          direction: "incoming",
          predicate: "synthesized-from",
          recurse: false,
          max_depth: 1,
        });
        const incomingSynth = this.uniqueFromFactsByDirection(this.parseKgFacts(incoming), "incoming");
        if (incomingSynth.length === 0) {
          out.push(item);
        }
      } catch {
        // Conservative fallback: if descendant traversal fails, keep the item in
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
