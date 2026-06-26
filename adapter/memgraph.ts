export type JsonMap = Record<string, unknown>;

export type ToolCaller = (name: string, args?: JsonMap) => Promise<JsonMap>;

export type MemgraphToolMap = {
  createSynthesisNode: string;
  applyMerge: string;
  resolveCanonical: string;
  getAncestors: string;
  getDescendants: string;
  getHeight: string;
  findMergeCandidates: string;
  findOrphanSynthesisNodes: string;
  findScopedSynthesisNodes: string;
  setSynthesisLabels: string;
  getLabelPolicy: string;
  addDrawer: string;
  updateDrawer: string;
  kgAdd: string;
  kgInvalidate: string;
  search: string;
  listDrawers: string;
  getDrawer: string;
};

export type RawMemoryWorkItem = {
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
  createSynthesisNode: "create_synthesis_node",
  applyMerge: "apply_merge",
  resolveCanonical: "resolve_canonical",
  getAncestors: "get_ancestors",
  getDescendants: "get_descendants",
  getHeight: "get_height",
  findMergeCandidates: "find_merge_candidates",
  findOrphanSynthesisNodes: "find_orphan_synthesis_nodes",
  findScopedSynthesisNodes: "find_scoped_synthesis_nodes",
  setSynthesisLabels: "set_synthesis_labels",
  getLabelPolicy: "get_label_policy",
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

  private parseRawMemoryItems(payload: unknown): RawMemoryWorkItem[] {
    const root = this.asObject(payload);
    const pools = [
      ...this.asArray(root.drawers),
      ...this.asArray(root.results),
      ...this.asArray(root.items),
      ...this.asArray(root.nodes),
      ...this.asArray(root.data),
    ];

    const out: RawMemoryWorkItem[] = [];
    const seen = new Set<string>();

    for (const raw of pools) {
      const row = this.asObject(raw);
      const drawer_id = this.asString(row.drawer_id || row.node_id || row.id).trim();
      if (!drawer_id || seen.has(drawer_id)) continue;

      const nodeKind = this.asString(row.node_kind || row.kind || row.type).trim().toLowerCase();
      const labels = this.asArray(row.labels).map((v) => this.asString(v).toLowerCase());
      const isSynthesis =
        nodeKind === "synthesis" ||
        labels.includes("synthesis") ||
        labels.includes("mem-synth") ||
        labels.includes("node_kind:synthesis");
      if (isSynthesis) continue;

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

  private parseDescendantIds(payload: unknown): string[] {
    const root = this.asObject(payload);
    const pools = [
      ...this.asArray(root.descendants),
      ...this.asArray(root.nodes),
      ...this.asArray(root.results),
      ...this.asArray(root.items),
      ...this.asArray(root.data),
    ];
    const out: string[] = [];
    for (const raw of pools) {
      const row = this.asObject(raw);
      const id = this.asString(row.node_id || row.drawer_id || row.id).trim();
      if (id) out.push(id);
    }
    return [...new Set(out)];
  }

  createSynthesisNode(args: {
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
    return this.call("createSynthesisNode", args as unknown as JsonMap);
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

  getAncestors(nodeId: string, maxDepth = 20) {
    return this.call("getAncestors", { node_id: nodeId, max_depth: maxDepth });
  }

  getDescendants(nodeId: string, maxDepth = 20) {
    return this.call("getDescendants", { node_id: nodeId, max_depth: maxDepth });
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

  findOrphanSynthesisNodes(args: {
    wing?: string;
    room?: string;
    include_merged?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return this.call("findOrphanSynthesisNodes", args as unknown as JsonMap);
  }

  findScopedSynthesisNodes(args: {
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
    return this.call("findScopedSynthesisNodes", args as unknown as JsonMap);
  }

  setSynthesisLabels(args: {
    node_id: string;
    labels?: string[];
  }) {
    return this.call("setSynthesisLabels", args as unknown as JsonMap);
  }

  getLabelPolicy() {
    return this.call("getLabelPolicy", {});
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

  async listRawMemoriesByScope(args: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }): Promise<RawMemoryWorkItem[]> {
    const res = await this.listDrawers({
      wing: args.wing,
      room: args.room,
      limit: args.limit,
      offset: args.offset,
    });
    return this.parseRawMemoryItems(res);
  }

  async findUnsynthesizedRawMemories(args: {
    wing?: string;
    room?: string;
    limit?: number;
    offset?: number;
  }): Promise<RawMemoryWorkItem[]> {
    const rawItems = await this.listRawMemoriesByScope(args);
    const out: RawMemoryWorkItem[] = [];

    for (const item of rawItems) {
      try {
        const desc = await this.getDescendants(item.drawer_id, 1);
        const descendantIds = this.parseDescendantIds(desc).filter((id) => id !== item.drawer_id);
        if (descendantIds.length === 0) {
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
