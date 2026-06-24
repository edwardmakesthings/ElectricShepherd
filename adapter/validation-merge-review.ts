import type { MemgraphClient } from "./memgraph.ts";

/**
 * Options for the validation + merge review phase (formerly "B3").
 */
export type ValidationMergeReviewOptions = {
  scopeRoom: string;
  scopeWing?: string;
  filterWing?: string;
  filterRoom?: string;
  includeMergedNodes?: boolean;
  validationDepth?: number;
  validationLimit?: number;
  mergeSimilarityThreshold?: number;
  mergeLimit?: number;
  mergeMaxNodes?: number;
  mergeMaxDepth?: number;
  applyMerges?: boolean;
  automaticMergeScore?: number;
  notificationURL?: string;
  escalationTopic?: string;
  candidateNodeIds?: string[];
};

/**
 * Downward validation result for one synthesis node.
 */
export type DownwardSupportReview = {
  nodeId: string;
  verdict: "pass" | "revise";
  reasons: string[];
  ancestorCount: number;
};

/**
 * Merge adjudication decision for one candidate pair.
 */
export type MergeAdjudication = {
  sourceNodeId: string;
  canonicalNodeId: string;
  score: number;
  decision: "merge" | "escalate";
  reasons: string[];
  applied: boolean;
};

/**
 * Output of validation and merge review phase.
 */
export type ValidationMergeReviewResult = {
  phase: "validation-merge-review";
  downwardValidation: DownwardSupportReview[];
  mergeAdjudications: MergeAdjudication[];
  escalations: {
    reasons: string[];
    nodeIds: string[];
    mergePairs: Array<{ sourceNodeId: string; canonicalNodeId: string; score: number }>;
    notified: boolean;
    notifyError?: string;
  };
};

type GenericObject = Record<string, unknown>;

function asObject(value: unknown): GenericObject {
  return value && typeof value === "object" ? (value as GenericObject) : {};
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

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((v) => v.trim()).filter(Boolean))];
}

function parseNodeIdsFromScoped(result: unknown): string[] {
  const obj = asObject(result);
  const nodes = asArray(obj.nodes);
  const out: string[] = [];
  for (const raw of nodes) {
    const node = asObject(raw);
    const id = asString(node.node_id || node.drawer_id || node.id).trim();
    if (id) out.push(id);
  }
  return uniq(out);
}

function parseAncestorIds(result: unknown): string[] {
  const obj = asObject(result);
  const nodes = [...asArray(obj.ancestors), ...asArray(obj.nodes)];
  const out: string[] = [];
  for (const raw of nodes) {
    const node = asObject(raw);
    const id = asString(node.node_id || node.drawer_id || node.id).trim();
    if (id) out.push(id);
  }
  return uniq(out);
}

function parseMergeCandidates(result: unknown): Array<{ sourceNodeId: string; canonicalNodeId: string; score: number }> {
  const obj = asObject(result);
  const pools = [
    ...asArray(obj.candidates),
    ...asArray(obj.results),
    ...asArray(obj.pairs),
    ...asArray(obj.items),
  ];

  const out: Array<{ sourceNodeId: string; canonicalNodeId: string; score: number }> = [];
  for (const raw of pools) {
    const row = asObject(raw);

    const left = asString(
      row.source_node_id || row.node_a || row.left_node_id || row.left || row.drawer_id,
    ).trim();
    const right = asString(
      row.canonical_node_id || row.node_b || row.right_node_id || row.right || row.match_node_id,
    ).trim();

    if (!left || !right || left === right) continue;

    const score = asNumber(
      row.score ?? row.similarity ?? row.distance_score ?? row.match_score,
      0,
    );

    out.push({
      sourceNodeId: left,
      canonicalNodeId: right,
      score,
    });
  }

  const dedup = new Map<string, { sourceNodeId: string; canonicalNodeId: string; score: number }>();
  for (const item of out) {
    const key = `${item.sourceNodeId}|${item.canonicalNodeId}`;
    const prev = dedup.get(key);
    if (!prev || item.score > prev.score) dedup.set(key, item);
  }
  return [...dedup.values()];
}

async function maybeNotify(args: {
  notificationURL?: string;
  topic?: string;
  body: string;
}): Promise<{ notified: boolean; error?: string }> {
  if (!args.notificationURL) return { notified: false };
  try {
    const url = args.topic ? `${args.notificationURL.replace(/\/$/, "")}/${args.topic}` : args.notificationURL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: args.body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return { notified: false, error: `notify http ${response.status}` };
    }
    return { notified: true };
  } catch (err) {
    return { notified: false, error: String(err) };
  }
}

/**
 * Perform deterministic downward support checks and merge adjudication.
 *
 * Policy choices:
 * - Nodes with too little source ancestry are flagged for revision/escalation.
 * - Merge candidates above the automatic threshold can be auto-applied.
 * - Ambiguous cases are escalated and optionally notified via ntfy.
 */
export async function runValidationMergeReview(
  client: MemgraphClient,
  options: ValidationMergeReviewOptions,
): Promise<ValidationMergeReviewResult> {
  const scopeRoom = options.scopeRoom?.trim();
  if (!scopeRoom) throw new Error("Validation requires scopeRoom");

  const validationDepth = Math.max(1, Number(options.validationDepth ?? 6));
  const validationLimit = Math.max(1, Number(options.validationLimit ?? 50));
  const mergeSimilarityThreshold = Number(options.mergeSimilarityThreshold ?? 0.82);
  const mergeLimit = Math.max(1, Number(options.mergeLimit ?? 20));
  const mergeMaxNodes = Math.max(1, Number(options.mergeMaxNodes ?? 300));
  const mergeMaxDepth = Math.max(1, Number(options.mergeMaxDepth ?? 20));
  const applyMerges = Boolean(options.applyMerges);
  const automaticMergeScore = Number(options.automaticMergeScore ?? 0.92);

  let nodeIds = uniq(options.candidateNodeIds || []);
  if (nodeIds.length === 0) {
    const scoped = await client.findScopedSynthesisNodes({
      scope_room: scopeRoom,
      scope_wing: options.scopeWing,
      wing: options.filterWing,
      room: options.filterRoom,
      include_merged: options.includeMergedNodes ?? false,
      limit: validationLimit,
      offset: 0,
      max_depth: validationDepth,
    });
    nodeIds = parseNodeIdsFromScoped(scoped);
  }

  const downwardValidation: DownwardSupportReview[] = [];
  const escalationNodeIds = new Set<string>();
  const escalationReasons = new Set<string>();

  for (const nodeId of nodeIds) {
    const ancestors = await client.getAncestors(nodeId, validationDepth).catch(() => ({}));
    const ancestorIds = parseAncestorIds(ancestors);

    const reasons: string[] = [];
    let verdict: "pass" | "revise" = "pass";

    if (ancestorIds.length < 2) {
      verdict = "revise";
      reasons.push("downward-check: synthesis has fewer than 2 ancestor/source nodes");
      escalationNodeIds.add(nodeId);
      escalationReasons.add("downward validation failed: insufficient source support");
    }

    downwardValidation.push({
      nodeId,
      verdict,
      reasons,
      ancestorCount: ancestorIds.length,
    });
  }

  const mergeResult = await client.findMergeCandidates({
    wing: options.filterWing,
    room: options.filterRoom,
    threshold: mergeSimilarityThreshold,
    limit: mergeLimit,
    max_nodes: mergeMaxNodes,
    max_depth: mergeMaxDepth,
    require_topological_distance: true,
  }).catch(() => ({}));

  const parsedCandidates = parseMergeCandidates(mergeResult);
  const mergeAdjudications: MergeAdjudication[] = [];
  const escalationPairs: Array<{ sourceNodeId: string; canonicalNodeId: string; score: number }> = [];

  for (const candidate of parsedCandidates) {
    const reasons: string[] = [];
    let decision: "merge" | "escalate" = "escalate";
    if (candidate.score >= automaticMergeScore) {
      decision = "merge";
      reasons.push(`score ${candidate.score.toFixed(3)} >= automatic merge threshold ${automaticMergeScore.toFixed(3)}`);
    } else {
      reasons.push(`score ${candidate.score.toFixed(3)} below automatic merge threshold ${automaticMergeScore.toFixed(3)}`);
      escalationReasons.add("merge adjudication requires frontier review");
      escalationPairs.push(candidate);
    }

    let applied = false;
    if (decision === "merge" && applyMerges) {
      await client.applyMerge({
        source_node_id: candidate.sourceNodeId,
        canonical_node_id: candidate.canonicalNodeId,
        invalidate_source_edges: true,
      });
      applied = true;
    }

    mergeAdjudications.push({
      sourceNodeId: candidate.sourceNodeId,
      canonicalNodeId: candidate.canonicalNodeId,
      score: candidate.score,
      decision,
      reasons,
      applied,
    });
  }

  const escalationBody = [
    "Electric Shepherd validation-merge-review escalation",
    "",
    `Nodes needing review: ${[...escalationNodeIds].join(", ") || "none"}`,
    `Merge pairs needing review: ${escalationPairs.length}`,
    ...escalationPairs.map((p) => `- ${p.sourceNodeId} -> ${p.canonicalNodeId} (score=${p.score.toFixed(3)})`),
    "",
    `Reasons: ${[...escalationReasons].join("; ") || "none"}`,
  ].join("\n");

  const notify = await maybeNotify({
    notificationURL: options.notificationURL,
    topic: options.escalationTopic || "electric-shepherd-escalations",
    body: escalationBody,
  });

  return {
    phase: "validation-merge-review",
    downwardValidation,
    mergeAdjudications,
    escalations: {
      reasons: [...escalationReasons],
      nodeIds: [...escalationNodeIds],
      mergePairs: escalationPairs,
      notified: notify.notified,
      notifyError: notify.error,
    },
  };
}
