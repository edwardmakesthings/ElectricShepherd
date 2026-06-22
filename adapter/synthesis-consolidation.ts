import type { MemgraphClient } from "./memgraph.ts";

/**
 * Confidence level for one map-stage transcript summary.
 */
export type ConsolidationConfidence = "high" | "medium" | "low";

/**
 * Structured transcript summary used as reduce input for synthesis creation.
 */
export type TranscriptInsightSummary = {
  transcriptId: string;
  confidence: ConsolidationConfidence;
  durableFacts: string[];
  decisions: string[];
  rootCausesAndWorkedExamples: string[];
  subsystemsAndFiles: string[];
  openItems: string[];
  rawExcerpt?: string;
};

/**
 * Options for synthesis consolidation (map/reduce + inflation guard).
 */
export type SynthesisConsolidationOptions = {
  query: string;
  targetWing: string;
  targetRoom: string;
  searchLimit?: number;
  minimumDistinctSources?: number;
  minimumContentCharacters?: number;
  minimumPopulatedSections?: number;
  minimumMapperConfidence?: ConsolidationConfidence;
  labels?: string[];
  applyWrites?: boolean;
  mapperSummaries?: TranscriptInsightSummary[];
};

/**
 * Deterministic checks used to reject weak syntheses before write.
 */
export type InflationGuardResult = {
  passed: boolean;
  reasons: string[];
};

/**
 * Result produced by synthesis consolidation.
 */
export type SynthesisConsolidationResult = {
  phase: "synthesis-consolidation";
  query: string;
  usedProvidedMapperSummaries: boolean;
  mapperSummaryCount: number;
  includedSummaryIds: string[];
  droppedSummaryIds: string[];
  sourceDrawerIds: string[];
  synthesisDraft: {
    title: string;
    content: string;
    contentCharacters: number;
    populatedSectionCount: number;
    labels: string[];
  };
  inflationGuard: InflationGuardResult;
  createdNodeId?: string;
  createResult?: Record<string, unknown>;
};

type GenericObject = Record<string, unknown>;

const CONFIDENCE_SCORE: Record<ConsolidationConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function asObject(value: unknown): GenericObject {
  return value && typeof value === "object" ? (value as GenericObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeConfidence(value: unknown): ConsolidationConfidence {
  const raw = asString(value).trim().toLowerCase();
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "low";
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function toBullets(items: string[]): string {
  if (items.length === 0) return "- (none)";
  return items.map((item) => `- ${item}`).join("\n");
}

function sentenceSplit(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function compactLineSplit(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\s]+/, "").trim())
    .filter(Boolean);
}

function keywordMatch(lines: string[], pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line));
}

function parseSearchItems(rawResult: unknown): Array<{ id: string; text: string }> {
  const result = asObject(rawResult);
  const merged = [
    ...asArray(result.results),
    ...asArray(result.drawers),
    ...asArray(result.matches),
    ...asArray(result.items),
    ...asArray(result.nodes),
  ];

  const out: Array<{ id: string; text: string }> = [];
  for (const item of merged) {
    const obj = asObject(item);
    const id = asString(obj.drawer_id || obj.node_id || obj.id || obj.canonical_node_id).trim();
    if (!id) continue;

    const textCandidates = [
      asString(obj.content),
      asString(obj.text),
      asString(obj.snippet),
      asString(obj.preview),
      asString(obj.desc),
    ].filter(Boolean);

    const text = textCandidates.join("\n").trim();
    if (!text) continue;
    out.push({ id, text });
  }

  const seen = new Set<string>();
  const deduped: Array<{ id: string; text: string }> = [];
  for (const entry of out) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    deduped.push(entry);
  }
  return deduped;
}

function inferConfidence(
  text: string,
  sections: Omit<TranscriptInsightSummary, "transcriptId" | "confidence">,
): ConsolidationConfidence {
  const textLen = text.trim().length;
  const populatedSections = [
    sections.durableFacts,
    sections.decisions,
    sections.rootCausesAndWorkedExamples,
    sections.subsystemsAndFiles,
    sections.openItems,
  ].filter((s) => s.length > 0).length;

  if (textLen >= 240 && populatedSections >= 3) return "high";
  if (textLen >= 120 && populatedSections >= 2) return "medium";
  return "low";
}

function mapEntryToSummary(entry: { id: string; text: string }): TranscriptInsightSummary {
  const bySentence = sentenceSplit(entry.text);
  const byLine = compactLineSplit(entry.text);
  const lines = uniqSorted([...bySentence, ...byLine]);

  const durableFacts = keywordMatch(lines, /\b(is|are|was|were|has|have|always|never|uses|supports|requires)\b/i).slice(0, 8);
  const decisions = keywordMatch(lines, /\b(decid|choose|chose|prefer|plan|policy|will|should|must)\b/i).slice(0, 8);
  const rootCauses = keywordMatch(lines, /\b(root cause|because|due to|caused by|failed|failure|bug|regression|fixed by)\b/i).slice(0, 8);
  const subsystems = keywordMatch(lines, /\b(adapter|plugin|script|mcp|memgraph|dreamer|validator|queue|cadence|merge)\b/i).slice(0, 8);
  const openItems = keywordMatch(lines, /\b(todo|next|pending|open|follow-up|needs|remaining|blocked)\b/i).slice(0, 8);

  const sections = {
    durableFacts,
    decisions,
    rootCausesAndWorkedExamples: rootCauses,
    subsystemsAndFiles: subsystems,
    openItems,
  };

  return {
    transcriptId: entry.id,
    confidence: inferConfidence(entry.text, sections),
    ...sections,
    rawExcerpt: entry.text.slice(0, 600),
  };
}

function parseProvidedMapperSummaries(value: unknown): TranscriptInsightSummary[] {
  const arr = asArray(value);
  const out: TranscriptInsightSummary[] = [];
  for (const raw of arr) {
    const obj = asObject(raw);
    const transcriptId = asString(obj.transcriptId || obj.transcript_id).trim();
    if (!transcriptId) continue;

    const pickStringList = (camel: string, snake: string): string[] => {
      const list = asArray(obj[camel] ?? obj[snake]).map((v) => asString(v).trim()).filter(Boolean);
      return uniqSorted(list);
    };

    out.push({
      transcriptId,
      confidence: normalizeConfidence(obj.confidence),
      durableFacts: pickStringList("durableFacts", "durable_facts"),
      decisions: pickStringList("decisions", "decisions"),
      rootCausesAndWorkedExamples: pickStringList("rootCausesAndWorkedExamples", "root_causes_and_worked_examples"),
      subsystemsAndFiles: pickStringList("subsystemsAndFiles", "subsystems_and_files"),
      openItems: pickStringList("openItems", "open_items"),
      rawExcerpt: asString(obj.rawExcerpt || obj.raw_excerpt).trim() || undefined,
    });
  }
  return out;
}

function confidenceAllows(confidence: ConsolidationConfidence, floor: ConsolidationConfidence): boolean {
  return CONFIDENCE_SCORE[confidence] >= CONFIDENCE_SCORE[floor];
}

function chooseTitle(decisions: string[], durableFacts: string[], query: string): string {
  const first = decisions[0] || durableFacts[0] || query;
  const trimmed = first.replace(/\s+/g, " ").trim();
  return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
}

function buildSynthesisDraft(args: {
  query: string;
  summaries: TranscriptInsightSummary[];
}): {
  title: string;
  content: string;
  contentCharacters: number;
  populatedSectionCount: number;
} {
  const durableFacts = uniqSorted(args.summaries.flatMap((s) => s.durableFacts));
  const decisions = uniqSorted(args.summaries.flatMap((s) => s.decisions));
  const rootCauses = uniqSorted(args.summaries.flatMap((s) => s.rootCausesAndWorkedExamples));
  const subsystems = uniqSorted(args.summaries.flatMap((s) => s.subsystemsAndFiles));
  const openItems = uniqSorted(args.summaries.flatMap((s) => s.openItems));

  const populatedSectionCount = [durableFacts, decisions, rootCauses, subsystems, openItems].filter((s) => s.length > 0).length;
  const title = chooseTitle(decisions, durableFacts, args.query);

  const content = [
    `# Synthesis: ${title}`,
    "",
    `Query focus: ${args.query}`,
    "",
    "## Durable Facts",
    toBullets(durableFacts),
    "",
    "## Decisions",
    toBullets(decisions),
    "",
    "## Root Causes And Worked Examples",
    toBullets(rootCauses),
    "",
    "## Subsystems And Files",
    toBullets(subsystems),
    "",
    "## Open Items",
    toBullets(openItems),
  ].join("\n");

  return {
    title,
    content,
    contentCharacters: content.length,
    populatedSectionCount,
  };
}

function evaluateInflationGuard(args: {
  sourceDrawerIds: string[];
  contentCharacters: number;
  populatedSectionCount: number;
  minimumDistinctSources: number;
  minimumContentCharacters: number;
  minimumPopulatedSections: number;
}): InflationGuardResult {
  const reasons: string[] = [];
  if (args.sourceDrawerIds.length < args.minimumDistinctSources) {
    reasons.push(`requires at least ${args.minimumDistinctSources} distinct source drawers`);
  }
  if (args.contentCharacters < args.minimumContentCharacters) {
    reasons.push(`requires synthesis content length >= ${args.minimumContentCharacters} chars`);
  }
  if (args.populatedSectionCount < args.minimumPopulatedSections) {
    reasons.push(`requires at least ${args.minimumPopulatedSections} populated synthesis sections`);
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

/**
 * Consolidate candidate transcript evidence into a synthesis draft, then optionally persist it.
 *
 * Behavior:
 * - Map: normalize and confidence-score per-source summaries.
 * - Reduce: produce a single synthesis draft from included summaries.
 * - Guard: block writes if deterministic inflation checks fail.
 */
export async function runSynthesisConsolidation(
  client: MemgraphClient,
  options: SynthesisConsolidationOptions,
): Promise<SynthesisConsolidationResult> {
  const query = options.query.trim();
  const targetWing = options.targetWing.trim();
  const targetRoom = options.targetRoom.trim();

  if (!query) throw new Error("Consolidation requires query");
  if (!targetWing) throw new Error("Consolidation requires targetWing");
  if (!targetRoom) throw new Error("Consolidation requires targetRoom");

  const confidenceFloor = options.minimumMapperConfidence || "medium";
  const minimumDistinctSources = Math.max(2, Number(options.minimumDistinctSources ?? 2));
  const minimumContentCharacters = Math.max(120, Number(options.minimumContentCharacters ?? 220));
  const minimumPopulatedSections = Math.max(2, Number(options.minimumPopulatedSections ?? 3));
  const applyWrites = Boolean(options.applyWrites);

  let summaries: TranscriptInsightSummary[] = [];
  let usedProvidedMapperSummaries = false;

  if (Array.isArray(options.mapperSummaries) && options.mapperSummaries.length > 0) {
    summaries = parseProvidedMapperSummaries(options.mapperSummaries);
    usedProvidedMapperSummaries = true;
  } else {
    const searchLimit = Math.max(3, Number(options.searchLimit ?? 12));
    const searchResult = await client.search(query, searchLimit, targetWing, targetRoom);
    summaries = parseSearchItems(searchResult).map(mapEntryToSummary);
  }

  const included = summaries.filter((summary) => confidenceAllows(summary.confidence, confidenceFloor));
  const dropped = summaries.filter((summary) => !confidenceAllows(summary.confidence, confidenceFloor));

  const sourceDrawerIds = uniqSorted(included.map((summary) => summary.transcriptId));
  const synthesisDraft = buildSynthesisDraft({ query, summaries: included });

  const inflationGuard = evaluateInflationGuard({
    sourceDrawerIds,
    contentCharacters: synthesisDraft.contentCharacters,
    populatedSectionCount: synthesisDraft.populatedSectionCount,
    minimumDistinctSources,
    minimumContentCharacters,
    minimumPopulatedSections,
  });

  let createdNodeId: string | undefined;
  let createResult: Record<string, unknown> | undefined;

  if (applyWrites && inflationGuard.passed) {
    const create = await client.createSynthesisNode({
      wing: targetWing,
      room: targetRoom,
      content: synthesisDraft.content,
      source_drawer_ids: sourceDrawerIds,
      desc: synthesisDraft.title,
      labels: options.labels || [],
      added_by: "electric-shepherd-consolidation",
    });
    createResult = create;

    const createObj = asObject(create);
    const id = asString(createObj.node_id || createObj.drawer_id || createObj.id).trim();
    if (id) createdNodeId = id;
  }

  return {
    phase: "synthesis-consolidation",
    query,
    usedProvidedMapperSummaries,
    mapperSummaryCount: summaries.length,
    includedSummaryIds: included.map((summary) => summary.transcriptId),
    droppedSummaryIds: dropped.map((summary) => summary.transcriptId),
    sourceDrawerIds,
    synthesisDraft: {
      title: synthesisDraft.title,
      content: synthesisDraft.content,
      contentCharacters: synthesisDraft.contentCharacters,
      populatedSectionCount: synthesisDraft.populatedSectionCount,
      labels: options.labels || [],
    },
    inflationGuard,
    createdNodeId,
    createResult,
  };
}
