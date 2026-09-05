import { mergeWeights, normalizeLabelList, type RetrievalWeights } from "../../policy/retrieval-scoring.ts";
import type { MemgraphClient } from "../../core/memgraph.ts";
import type { RetrievalExpansionOptions } from "./retrieval-expansion-types.ts";

export type ParsedExpansionInputs = {
  query: string;
  scope_room: string;
  requestedMatchLabels: string[];
  alwaysIncludeLabels: string[];
  weights: RetrievalWeights;
  seedSearchLimit: number;
  maxDepth: number;
  expansionDepth: number;
  limit: number;
  offset: number;
  topN: number;
  matchMode: "any" | "all";
  labeledOnly: boolean;
  includeMerged: boolean;
};

export function parseExpansionInputs(options: RetrievalExpansionOptions): ParsedExpansionInputs {
  const query = options.query?.trim() ?? "";
  if (!query) throw new Error("query is required");

  const scope_room = options.scope_room?.trim() ?? "";
  if (!scope_room) throw new Error("scope_room is required");

  return {
    query,
    scope_room,
    requestedMatchLabels: normalizeLabelList(options.match_labels || []),
    alwaysIncludeLabels: normalizeLabelList(options.always_include_labels || ["pinned"]),
    weights: mergeWeights(options.weights),
    seedSearchLimit: Math.max(1, Number(options.seed_search_limit ?? 10)),
    maxDepth: Math.max(1, Number(options.max_depth ?? 20)),
    expansionDepth: Math.max(1, Number(options.expansion_depth ?? 2)),
    limit: Math.max(1, Number(options.limit ?? 50)),
    offset: Math.max(0, Number(options.offset ?? 0)),
    topN: Math.max(1, Number(options.top_n ?? 12)),
    matchMode: options.match_mode === "all" ? "all" : "any",
    labeledOnly: Boolean(options.labeled_only),
    includeMerged: Boolean(options.include_merged),
  };
}

export async function safeListDrawers(
  client: MemgraphClient,
  args: { wing?: string; room?: string; limit: number; offset: number },
): Promise<Record<string, unknown>> {
  try {
    return (await client.listDrawers(args)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
