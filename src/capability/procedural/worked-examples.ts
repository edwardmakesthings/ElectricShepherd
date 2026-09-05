/**
 * Worked-example retrieval, formatting, and deterministic problem-shape
 * extraction (shared with capability routing and calibration). Extracted from
 * retrieval-expansion.ts — behavior and all public exports are unchanged.
 */
import type { MemgraphClient } from "../../core/memgraph.ts";
import type { CapabilityTier } from "../evaluative/capability-shape.ts";
import { asArray, asNumber, asObject, asString } from "../../policy/retrieval-scoring.ts";
// ---------------------------------------------------------------------------
// Worked-example injection.
//
// The `apprenticeship` room holds worked examples filed after hard problems were
// solved. This is the CONSUME side: given a delegation prompt, find the most
// similar examples and return them as demonstrations for in-context injection.
//
// Relevance is computed with a deterministic token-overlap score so the floor is
// stable across runs (no embedding dependency). The hard cap of 2 examples bounds
// prompt growth; below the relevance floor, nothing is returned rather than
// padding the delegation prompt.
// ---------------------------------------------------------------------------

/** Hard cap on worked examples injected into a delegation prompt. */
export const WORKED_EXAMPLE_MAX_INJECT = 2;

/**
 * Minimum relevance score for a worked example to be injected.
 * Score is in [0, 1] (token-overlap / query-token-count). A floor of 0.25 means
 * at least a quarter of the prompt's informative tokens must appear in the
 * example — below that, the match is too weak to be useful as a demonstration.
 */
export const WORKED_EXAMPLE_RELEVANCE_FLOOR = 0.25;

/** Max chars per injected example (bounds prompt growth). */
export const WORKED_EXAMPLE_MAX_CHARS = 800;

/**
 * CONSUME: source types admitted as worked examples by retrieval.
 * `worked-example` is the stamp this pass writes (a distinct knowledge class —
 * solved task demonstrations, not procedural skills). `skill` stays admitted for
 * backward compatibility with any pre-existing apprenticeship drawers that were
 * stamped `skill`; new filings must never use `skill`.
 */
const WORKED_EXAMPLE_SOURCE_TYPES: ReadonlySet<string> = new Set(["worked-example", "skill"]);

export type WorkedExampleMatch = {
  drawer_id: string;
  wing: string;
  room: string;
  content: string;
  relevance: number;
};

export type RetrieveWorkedExamplesOptions = {
  query: string;
  limit?: number;
  relevanceFloor?: number;
  maxChars?: number;
};

/**
 * Tokenize text into lowercase alphanumeric tokens, dropping common stopwords
 * so the overlap score reflects task-specific vocabulary. Deterministic — no
 * randomness, no network calls.
 */
function tokenizeWorkedExampleText(text: string): Set<string> {
  const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "it", "its",
    "this", "that", "these", "those", "as", "if", "then", "else", "when",
    "where", "how", "what", "which", "who", "whom", "why", "not", "no", "yes",
    "so", "such", "than", "too", "very", "just", "also", "into", "out",
    "up", "down", "over", "under", "between", "during", "before", "after",
  ]);
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/**
 * Deterministic relevance score: |queryTokens ∩ exampleTokens| / |queryTokens|.
 * Returns 0 when queryTokens is empty. Bounded in [0, 1].
 */
function computeWorkedExampleRelevance(queryTokens: Set<string>, exampleTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (exampleTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

/**
 * CONSUME: retrieve the most relevant worked examples from the
 * `apprenticeship` room for a given delegation prompt.
 *
 * Returns at most `limit` (default WORKED_EXAMPLE_MAX_INJECT = 2) examples,
 * each with relevance >= `relevanceFloor` (default WORKED_EXAMPLE_RELEVANCE_FLOOR).
 * If no examples meet the floor, returns an empty array — the caller injects nothing.
 *
 * The search is capability-gated: clients without `search` degrade to "no
 * examples" with zero extra calls.
 */
export async function retrieveSimilarWorkedExamples(
  client: {
    search?: (query: string, limit?: number, wing?: string, room?: string) => Promise<unknown>;
    getDrawer?: (args: { drawer_id: string }) => Promise<unknown>;
    getClosetSourceType?: (nodeId: string) => Promise<string | null>;
  },
  options: RetrieveWorkedExamplesOptions,
): Promise<WorkedExampleMatch[]> {
  const query = String(options.query || "").trim();
  if (!query) return [];

  const limit = Math.max(1, Number(options.limit ?? WORKED_EXAMPLE_MAX_INJECT));
  const floor = Number(options.relevanceFloor ?? WORKED_EXAMPLE_RELEVANCE_FLOOR);
  const maxChars = Math.max(100, Number(options.maxChars ?? WORKED_EXAMPLE_MAX_CHARS));

  if (typeof client.search !== "function") return [];

  // Search the apprenticeship room for candidate examples.
  let searchResult: unknown;
  try {
    searchResult = await client.search(query, Math.min(10, limit * 3), undefined, "apprenticeship");
  } catch {
    return [];
  }

  const queryTokens = tokenizeWorkedExampleText(query);
  if (queryTokens.size === 0) return [];

  // Extract candidate drawer IDs from the search result.
  const obj = asObject(searchResult);
  const rows = [
    ...asArray(obj.results),
    ...asArray(obj.drawers),
    ...asArray(obj.matches),
    ...asArray(obj.items),
    ...asArray(obj.nodes),
  ];

  const seen = new Set<string>();
  const candidates: { id: string; text: string }[] = [];
  for (const raw of rows) {
    const row = asObject(raw);
    const id = asString(row.drawer_id || row.node_id || row.id || row.canonical_node_id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = [
      asString(row.content),
      asString(row.text),
      ...[...asArray(row.lines)].map(asString),
      asString(row.snippet),
      asString(row.preview),
      asString(row.desc),
    ].filter(Boolean).join("\n").trim();
    if (!text) continue;
    candidates.push({ id, text });
  }

  // Score each candidate.
  const scored: WorkedExampleMatch[] = [];
  for (const { id, text } of candidates) {
    const exampleTokens = tokenizeWorkedExampleText(text);
    const relevance = computeWorkedExampleRelevance(queryTokens, exampleTokens);
    if (relevance < floor) continue;

    // Fetch full content via getDrawer for richer demonstration text.
    let content = text.slice(0, maxChars);
    let wing = "";
    let room = "apprenticeship";
    if (typeof client.getDrawer === "function") {
      try {
        const drawerRaw = await client.getDrawer({ drawer_id: id });
        const drawer = asObject(drawerRaw);
        const fullContent = asString(
          drawer.content || drawer.text || drawer.desc || drawer.title,
        ).trim();
        if (fullContent) content = fullContent.slice(0, maxChars);
        wing = asString(drawer.wing || asObject(drawer.metadata).wing);
        room = asString(drawer.room || asObject(drawer.metadata).room) || "apprenticeship";
      } catch (err) {
        // keep search-result text
        void err;
      }
    }

    // Optional source-type filter: only admit worked-example/skill stamped drawers
    // (skill kept for backward compatibility — see WORKED_EXAMPLE_SOURCE_TYPES).
    if (typeof client.getClosetSourceType === "function") {
      try {
        const srcType = await client.getClosetSourceType(id);
        if (srcType && !WORKED_EXAMPLE_SOURCE_TYPES.has(srcType)) continue;
      } catch (err) {
        // unreadable source type: admit (absence of stamp is not a rejection)
        void err;
      }
    }

    scored.push({ drawer_id: id, wing, room, content, relevance });
  }

  // Sort by relevance descending, then by drawer_id for deterministic tie-breaking.
  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a.drawer_id.localeCompare(b.drawer_id);
  });

  return scored.slice(0, limit);
}

/**
 * Format retrieved worked examples as a delimited demonstration section
 * for injection into a delegation prompt. Returns "" when no examples are provided.
 */
export function formatWorkedExampleDemonstration(examples: WorkedExampleMatch[]): string {
  if (examples.length === 0) return "";
  const parts = [
    "\n\n---\n",
    "## Demonstrations: how this class of problem was solved in this codebase before\n",
    "",
    "The following worked examples are directly relevant to your task. Use them as demonstrations — match their approach, style, and structure.\n",
  ];
  for (let i = 0; i < examples.length; i += 1) {
    const ex = examples[i];
    parts.push(`### Example ${i + 1} (relevance: ${ex.relevance.toFixed(2)})\n`);
    parts.push(ex.content.trim());
    if (i < examples.length - 1) parts.push("\n");
  }
  parts.push("\n---\n");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// CREATE: deterministic problem-shape extraction (shared with capability routing and calibration).
//
// The shape is WHAT MADE THE TASK HARD / what class of task it was — not the
// answer. Retrieval matches on the problem, not the solution. Capability routing
// and calibration reuse this exact helper for capability-memory tuples (task
// shape → tier → outcome), so it must stay cheap and deterministic: no embeddings,
// no LLM calls, stable across phrasings of the same task class.
// ---------------------------------------------------------------------------

/** Work-class vocabulary — deliberately small and closed. */
export const WORKED_EXAMPLE_WORK_CLASSES = [
  "bug-fix",
  "new-feature",
  "refactor",
  "test",
  "config",
  "migration",
  "performance",
  "type-system",
] as const;

export type WorkedExampleWorkClass = (typeof WORKED_EXAMPLE_WORK_CLASSES)[number];

/** Known-hard area vocabulary — deliberately small and closed. */
export const WORKED_EXAMPLE_HARD_AREAS = [
  "concurrency",
  "async",
  "type-system",
  "migration",
  "network",
  "state-machine",
  "performance",
] as const;

export type WorkedExampleHardArea = (typeof WORKED_EXAMPLE_HARD_AREAS)[number];

/** Deterministic problem shape for a task description/prompt. */
export type WorkedExampleShape = {
  /** Coarse work class inferred from the prompt text. */
  workClass: WorkedExampleWorkClass;
  /** File extensions mentioned in the prompt (e.g. [".ts", ".py"]). */
  fileTypes: string[];
  /** Known-hard areas detected in the prompt text. */
  hardAreas: WorkedExampleHardArea[];
  /** Top informative tokens from the prompt (stopwords removed, capped). */
  keyTokens: string[];
  /** Unit-size bucket (single-file / few-file / cross-cutting). */
  sizeBucket: UnitSizeBucket;
  /** Stable hash of the shape fields — used for near-duplicate suppression. */
  shapeKey: string;
};

/** Max chars for a compact worked-example entry filed to the palace. */
export const WORKED_EXAMPLE_ENTRY_MAX_CHARS = 800;

/** Minimum chars of substantive output before filing is worthwhile. */
export const WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS = 200;

/**
 * CREATE: subagent types whose successful completion warrants a worked
 * example. Cloud flows only (implement-cloud, build-cloud): the examples are filed
 * so that later cloud delegations can be injected with them as demonstrations.
 * The apprentice/local flows (implement-local, build) deliberately do NOT file —
 * they are the consumers of these demonstrations, not producers, and filing from
 * them would let a small model's own output back into its own prompt on the next
 * run.
 */
export const WORKED_EXAMPLE_FILE_AGENT_TYPES = new Set([
  "implement-cloud",
  "build-cloud",
]);

const SHAPE_TOKEN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "it", "its",
  "this", "that", "these", "those", "as", "if", "then", "else", "when",
  "where", "how", "what", "which", "who", "whom", "why", "not", "no", "yes",
  "so", "such", "than", "too", "very", "just", "also", "into", "out",
  "up", "down", "over", "under", "between", "during", "before", "after",
  "add", "added", "adding", "make", "made", "making", "fix", "fixed",
  "implement", "implemented", "implementing", "create", "created",
  "update", "updated", "change", "changed", "ensure", "ensures",
  "please", "task", "work", "file", "files", "code", "function",
]);

const WORK_CLASS_PATTERNS: Array<[WorkedExampleWorkClass, RegExp]> = [
  ["bug-fix", /\b(bug|fix|broken|error|fail|failing|failure|regression|crash|incorrect|wrong)\b/i],
  ["migration", /\b(migrat\w+|upgrade|convert\w*|migrate\w*)\b/i],
  ["performance", /\b(performance|slow|optimize\w*|latency|throughput|speed|benchmark)\b/i],
  ["type-system", /\b(type.?system|typescript|typing|generics?|union type|narrowing)\b/i],
  ["refactor", /\b(refactor\w+|restructure|reorganize|cleanup|clean up|simplif\w+)\b/i],
  ["test", /\b(test\w*|spec\w*|coverage|assertion)\b/i],
  ["config", /\b(config\w*|setting\w*|option\w*|flag\w*|env var|environment variable)\b/i],
  ["new-feature", /\b(feature|add|implement|create|build|support|enable|allow)\b/i],
];

const HARD_AREA_PATTERNS: Array<[WorkedExampleHardArea, RegExp]> = [
  ["concurrency", /\b(concurren\w+|race condition|deadlock|parallel|thread\w*|worker)\b/i],
  ["async", /\b(async|await|promise|callback|event loop|non.?blocking)\b/i],
  ["type-system", /\b(type.?system|typescript|typing|generics?|union type|narrowing)\b/i],
  ["migration", /\b(migrat\w+|upgrade|schema change|data migration)\b/i],
  ["network", /\b(network|http|websocket|socket|api call|fetch|request|response)\b/i],
  ["state-machine", /\b(state.?machine|finite state|transitions?|lifecycle)\b/i],
  ["performance", /\b(performance|slow|optimize\w*|latency|throughput|speed)\b/i],
];

/**
 * Extract a deterministic problem shape from a task description/prompt.
 *
 * Cheap and stable — no embeddings, no LLM. Returns a compact object whose
 * `shapeKey` is a stable hash usable for near-duplicate suppression in-session.
 */
export function extractWorkedExampleShape(promptOrDescription: string): WorkedExampleShape {
  const text = String(promptOrDescription || "").trim();

  // Work class: first matching pattern wins (order matters — bug-fix before new-feature).
  let workClass: WorkedExampleWorkClass = "new-feature";
  for (const [cls, re] of WORK_CLASS_PATTERNS) {
    if (re.test(text)) {
      workClass = cls;
      break;
    }
  }

  // File types: extract extensions from the text.
  const fileTypes = new Set<string>();
  for (const match of text.matchAll(/\.\b([a-z0-9]{1,8})\b/gi)) {
    const ext = "." + match[1].toLowerCase();
    // Filter out common non-file tokens (e.g. "e.g", "i.e", version numbers).
    if (!/^\.(e|g|i|v|ts\.js|js\.ts)$/.test(ext) && !/^\.\d+$/.test(ext)) {
      fileTypes.add(ext);
    }
  }

  // Hard areas: all matching patterns.
  const hardAreas: WorkedExampleHardArea[] = [];
  for (const [area, re] of HARD_AREA_PATTERNS) {
    if (re.test(text) && !hardAreas.includes(area)) {
      hardAreas.push(area);
    }
  }

  // Key tokens: informative words from the prompt (stopwords removed, capped at 12).
  const keyTokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3) continue;
    if (SHAPE_TOKEN_STOPWORDS.has(raw)) continue;
    if (!keyTokens.includes(raw)) keyTokens.push(raw);
    if (keyTokens.length >= 12) break;
  }

  // Unit-size bucket — a required shape component for capability routing.
  const sizeBucket = classifyUnitSize(text, fileTypes.size);

  // Shape key: stable hash of the shape fields (not the raw text).
  const shapeKey = computeShapeKey({ workClass, fileTypes: [...fileTypes].sort(), hardAreas, keyTokens, sizeBucket });

  return { workClass, fileTypes: [...fileTypes].sort(), hardAreas, keyTokens, sizeBucket, shapeKey };
}

/** Deterministic hash of shape fields (simple FNV-1a over a canonical string). */
function computeShapeKey(shape: { workClass: string; fileTypes: string[]; hardAreas: string[]; keyTokens: string[]; sizeBucket?: string }): string {
  const canonical = [shape.workClass, shape.fileTypes.join(","), shape.hardAreas.join(","), shape.keyTokens.slice(0, 6).join(","), shape.sizeBucket || ""].join("|");
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Unit-size bucket vocabulary — deliberately small and closed. */
export const UNIT_SIZE_BUCKETS = ["single-file", "few-file", "cross-cutting"] as const;

export type UnitSizeBucket = (typeof UNIT_SIZE_BUCKETS)[number];

/**
 * Classify a task prompt into a unit-size bucket (single-file / few-file /
 * cross-cutting). Cheap and deterministic — no embeddings, no LLM. Used by the
 * capability-memory CREATE path so routing evidence can be keyed on scope as well
 * as work class; the bucket is part of the canonical shape string.
 */
export function classifyUnitSize(promptOrDescription: string, fileTypeCount = 0): UnitSizeBucket {
  const text = String(promptOrDescription || "").toLowerCase();

  // Cross-cutting signals: explicit multi-file/multi-module language or many file types.
  if (fileTypeCount >= 3) return "cross-cutting";
  if (/\b(cross.?cutting|multi.?file|multiple files?|across the codebase|across modules?|several files?)\b/.test(text)) {
    return "cross-cutting";
  }

  // Few-file signals: explicit 2-3 file language.
  if (/\b(two files?|three files?|a few files?|2 files?|3 files?)\b/.test(text)) {
    return "few-file";
  }

  // Single-file signals: explicit single-file language or exactly one file type mentioned.
  if (/\b(single.?file|one file|the file)\b/.test(text) || fileTypeCount === 1) {
    return "single-file";
  }

  // Default: treat an unspecified scope as few-file (the middle bucket).
  return "few-file";
}

/** Subagent types that map to a routing tier. Only the three
 * implementation tiers are recorded — utility/analysis subagents (explore,
 * review-diff, run-tests, build, etc.) do not run units of work and are skipped.
 */
export const CAPABILITY_TIER_BY_SUBAGENT: Readonly<Record<string, CapabilityTier>> = {
  "implement-local": "local",
  "implement-cloud": "cloud",
  "implement-deep-cloud": "deep",
  "solve-deep-cloud": "deep",
};

/**
 * CONSUME (live routing): the canonical subagent for each routing tier.
 * The inverse of CAPABILITY_TIER_BY_SUBAGENT, used by the turn-guard delegation
 * hook to re-route a unit to a different tier when capability/failure evidence
 * recommends it. `deep` maps to implement-deep-cloud (the canonical deep-tier
 * implementation agent; solve-deep-cloud is an alternate alias for the same tier).
 */
export const CAPABILITY_SUBAGENT_BY_TIER: Readonly<Record<CapabilityTier, string>> = {
  local: "implement-local",
  cloud: "implement-cloud",
  deep: "implement-deep-cloud",
};


/** Deterministic capability bucket id for a (shape, tier) pair. */
export function buildCapabilityBucketId(shapeKey: string, tier: CapabilityTier): string {
  return `capability::${shapeKey}::${tier}`;
}
/** Closed failure-event vocabulary for per-model failure-mode memory. */
export const FAILURE_EVENT_VALUES = ["spiral", "loop"] as const;

export type FailureEvent = (typeof FAILURE_EVENT_VALUES)[number];

/** Closed intervention-label vocabulary (the guard that issued the nudge). */
export const INTERVENTION_LABELS = ["spiral-nudge", "retry-nudge", "loop-block"] as const;

export type InterventionLabel = (typeof INTERVENTION_LABELS)[number];

/**
 * Canonical model identity for failure attribution. Deterministic and
 * cheap — `provider/model` lowercased, exactly the pair used by turn-guard routing
 * pins (getPromptRouting / resolveLoopGuardRouting), so failure events key to the
 * same model id that capability routing looks up. Returns null when either half is
 * missing: unknown model => skip recording rather than guess a bucket.
 */
export function canonicalModelId(providerID?: string, modelID?: string): string | null {
  const provider = String(providerID ?? "").trim().toLowerCase();
  const model = String(modelID ?? "").trim().toLowerCase();
  if (!provider || !model) return null;
  return `${provider}/${model}`;
}

/**
 * Deterministic intervention-patch id for a (model, shapeKey, label)
 * triple. One node per (model, shape, guard) so repeated identical interventions
 * accumulate on the same node instead of minting new ones.
 */
export function buildFailurePatchId(modelId: string, shapeKey: string, label: InterventionLabel): string {
  return `failure-patch::${modelId}::${shapeKey}::${label}`;
}

/** Bound intervention text stored as a KG fact (kg object field). */
export const FAILURE_PATCH_TEXT_MAX_CHARS = 500;

/**
 * CONSUME (intervention replay): the prompt block appended to an outgoing
 * delegation when getFailureInterventions returns patches for this (model, shape).
 * The HEADING is load-bearing: the live hook checks args.prompt against it before
 * appending (idempotency guard — a re-fired hook must not double the block), and
 * tests assert on it. Keep in sync with the INTERVENTION_REPLAY_MAX_PATCHES constant
 * in plugin/session-policy.ts that bounds how many patches are injected.
 */
export const INTERVENTION_REPLAY_HEADING = "## Known interventions for this model on this class of task";

/**
 * CONSUME (intervention replay): format the recorded intervention texts
 * as the prompt block appended to an outgoing delegation. Returns "" when there is
 * nothing to inject (empty list) — the caller leaves the prompt EXACTLY as-is.
 */
export function formatInterventionBlock(interventions: string[]): string {
  const items = (Array.isArray(interventions) ? interventions : [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
  if (items.length === 0) return "";
  return (
    `\n\n---\n${INTERVENTION_REPLAY_HEADING}\n\n` +
    "This model has previously failed on this class of task. The interventions below " +
    "broke the loop last time — apply them proactively:\n" +
    items.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n---\n"
  );
}

/** Closed self-reported-confidence vocabulary (dream-mapper, drawer-digest, build end-of-loop line). */
export const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;

export type SelfReportedConfidence = (typeof CONFIDENCE_VALUES)[number];

/**
 * CREATE: parse a self-reported confidence label out of an agent's final
 * output text. Agents are instructed to end with `CONFIDENCE: high|medium|low`
 * (agents/dream-mapper.md and the build end-of-loop line).
 * Returns null when no such line is present — the caller then skips calibration
 * recording rather than guessing a level. Only the LAST occurrence counts (the
 * terminal self-report), matching how the label is produced.
 */
export function parseSelfReportedConfidence(outputText: string): SelfReportedConfidence | null {
  const text = String(outputText || "");
  const matches = [...text.matchAll(/\**CONFIDENCE\**:\s*(high|medium|low)\b/gi)];
  if (matches.length === 0) return null;
  const value = String(matches[matches.length - 1][1]).toLowerCase();
  return (CONFIDENCE_VALUES as readonly string[]).includes(value) ? (value as SelfReportedConfidence) : null;
}

/**
 * Deterministic calibration bucket id for a (model, shapeKey, confidence)
 * triple. Mirrors buildCapabilityBucketId / buildFailureBucketId naming under a
 * distinct `calibration::` namespace — never colliding with capability buckets,
 * failure buckets, or reserved predicates. The per-model node is the
 * `<model>` segment: tuples accumulate on it across sessions so the curve builds up.
 */
export function buildCalibrationBucketId(modelId: string, shapeKey: string, confidence: SelfReportedConfidence): string {
  return `calibration::${modelId}::${shapeKey}::${confidence}`;
}




/**
 * Build a compact worked-example entry for filing to the palace.
 *
 * The entry is bounded to WORKED_EXAMPLE_ENTRY_MAX_CHARS and leads with a DESC
 * line (repo convention) so it's discoverable without loading the body. The
 * problem shape is embedded as metadata lines so retrieval can match on the
 * problem, not just the solution.
 */
export function buildWorkedExampleEntry(params: {
  subagentType: string;
  description: string;
  output: string;
  shape: WorkedExampleShape;
}): string {
  const { subagentType, description, output, shape } = params;
  const desc = String(description || "").trim().slice(0, 120);
  const body = String(output || "").trim();

  // Truncate the body to fit within the max chars, leaving room for headers.
  const headerLen = 300; // approximate size of DESC + shape metadata lines
  const maxBody = Math.max(100, WORKED_EXAMPLE_ENTRY_MAX_CHARS - headerLen);
  const clippedBody = body.length > maxBody ? body.slice(0, maxBody) + "…" : body;

  const parts: string[] = [
    `DESC: Worked example — ${desc || subagentType} task solved by ${subagentType}. Relevant when delegating a similar ${shape.workClass} problem.`,
    "",
    `SHAPE: work-class=${shape.workClass}; file-types=${shape.fileTypes.join(",") || "n/a"}; hard-areas=${shape.hardAreas.join(",") || "none"}; size-bucket=${shape.sizeBucket}; key-tokens=${shape.keyTokens.slice(0, 6).join(", ")}`,
    "",
    clippedBody,
  ];

  return parts.join("\n").slice(0, WORKED_EXAMPLE_ENTRY_MAX_CHARS);
}

