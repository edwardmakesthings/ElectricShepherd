import { DEFAULT_MCP_TOOL_PREFIX } from "./runtime-config.ts";
import type { SubstrateResult } from "./mcp-http-client.ts";

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

export const CLOSET_SOURCE_TYPES: readonly string[] = ["transcript", "doc", "synthesis", "skill"];

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

export function resolveToolPrefix(explicit?: string): string {
  if (typeof explicit === "string") return explicit;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const fromEnv = env?.MEMGRAPH_TOOL_PREFIX;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : DEFAULT_MCP_TOOL_PREFIX;
}

export function buildToolMap(prefix: string, overrides?: Partial<MemgraphToolMap>): MemgraphToolMap {
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

export type ListSourceScopeArgs = {
  wing?: string;
  room?: string;
  limit?: number;
  offset?: number;
  pageSize?: number;
};
