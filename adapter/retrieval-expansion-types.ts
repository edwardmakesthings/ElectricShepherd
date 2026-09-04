import type { RankedScopedNode, RetrievalIntent, RetrievalWeights } from "./retrieval-scoring.ts";

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
  include_docs?: boolean;
  shared_wing?: string;
  domain?: string;
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
    concerns_expansion?: { enabled: boolean; targets_admitted: number };
    refined_expansion?: { enabled: boolean; targets_admitted: number };
    doc_scan?: {
      enabled: boolean;
      rooms_scanned: string[];
      drawers_scanned: number;
      targets_admitted: number;
      truncated: boolean;
    };
    outcome_expansion?: {
      enabled: boolean;
      applied: boolean;
      nodes_with_history: number;
      weight: number;
    };
    ruled_out_expansion?: {
      enabled: boolean;
      nodes_labeled: number;
      weight: number;
    };
    stale_expansion?: {
      enabled: boolean;
      applied: boolean;
      nodes_flagged: number;
      weight: number;
    };
    shared_skills_expansion?: {
      enabled: boolean;
      wing: string;
      room: string;
      drawers_scanned: number;
      targets_admitted: number;
      truncated: boolean;
      promoted_from?: {
        enabled: boolean;
        checked: number;
        with_origin: number;
      };
      domain_filter?: {
        enabled: boolean;
        requesting_domain: string | null;
        matched: number;
        filtered: number;
      };
    };
  };
  seeds: {
    query: string;
    raw_seed_ids: string[];
    canonical_seed_ids: string[];
    neighborhood_node_ids: string[];
    concern_neighbor_ids: string[];
    refined_neighbor_ids?: string[];
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
