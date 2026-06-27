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
  targetHall?: string;
  searchLimit?: number;
  minimumDistinctSources?: number;
  minimumContentCharacters?: number;
  minimumPopulatedSections?: number;
  minimumMapperConfidence?: ConsolidationConfidence;
  labels?: string[];
  writeDurableFactsToKg?: boolean;
  applyWrites?: boolean;
  mapperSummaries?: TranscriptInsightSummary[];
  rawEntries?: Array<{ id: string; text: string }>;
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
  phase: "source-derived-consolidation";
  query: string;
  usedProvidedMapperSummaries: boolean;
  mapperSummaryCount: number;
  includedSummaryIds: string[];
  droppedSummaryIds: string[];
  sourceDrawerIds: string[];
  consolidationDraft: {
    title: string;
    content: string;
    contentCharacters: number;
    populatedSectionCount: number;
    labels: string[];
  };
  inflationGuard: InflationGuardResult;
  selectedHall?: string;
  kgWrites?: {
    attempted: number;
    succeeded: number;
    failed: number;
    errors: string[];
  };
  createdNodeId?: string;
  createResult?: Record<string, unknown>;
};

type DurableFactTriple = {
  subject: string;
  predicate: string;
  object: string;
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

function normalizeHall(value: string | undefined): string | undefined {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return undefined;
  const allowed = new Set([
    "hall_facts",
    "hall_events",
    "hall_discoveries",
    "hall_preferences",
    "hall_advice",
  ]);
  if (allowed.has(raw)) return raw;
  return undefined;
}

function inferHallFromSummary(summary: TranscriptInsightSummary): string {
  const lines = [
    ...summary.durableFacts,
    ...summary.decisions,
    ...summary.rootCausesAndWorkedExamples,
    ...summary.subsystemsAndFiles,
    ...summary.openItems,
  ].join("\n").toLowerCase();

  if (/\b(prefer|preference|like|avoid|habit|style)\b/.test(lines)) return "hall_preferences";
  if (/\b(should|must|recommend|advice|best practice|tip)\b/.test(lines)) return "hall_advice";
  if (/\b(root cause|because|fixed|regression|incident|learned)\b/.test(lines)) return "hall_discoveries";
  if (/\b(today|yesterday|timeline|happened|occurred|session|run)\b/.test(lines)) return "hall_events";
  return "hall_facts";
}

function selectTargetHall(args: {
  summaries: TranscriptInsightSummary[];
  labels?: string[];
  targetHall?: string;
}): string {
  const explicitTarget = normalizeHall(args.targetHall);
  if (explicitTarget) return explicitTarget;
  const explicit = (args.labels || []).map((label) => normalizeHall(label)).find(Boolean);
  if (explicit) return explicit;

  const counts = new Map<string, number>();
  for (const summary of args.summaries) {
    const hall = inferHallFromSummary(summary);
    counts.set(hall, (counts.get(hall) || 0) + 1);
  }
  if (counts.size === 0) return "hall_discoveries";
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function normalizePredicate(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "is" || normalized === "are" || normalized === "was" || normalized === "were") return "is";
  if (normalized === "has" || normalized === "have") return "has";
  if (normalized === "uses" || normalized === "use") return "uses";
  if (normalized === "supports" || normalized === "support") return "supports";
  if (normalized === "requires" || normalized === "require") return "requires";
  if (normalized === "prefers" || normalized === "prefer") return "prefers";
  if (normalized === "must" || normalized === "should" || normalized === "will") return "policy";
  return normalized.replace(/\s+/g, "-");
}

function extractDurableFactTriples(summaries: TranscriptInsightSummary[], fallbackSubject: string): DurableFactTriple[] {
  const out: DurableFactTriple[] = [];
  const seen = new Set<string>();

  for (const summary of summaries) {
    for (const fact of summary.durableFacts) {
      const text = fact.trim().replace(/[\s]+/g, " ");
      if (!text) continue;

      const simple = text.match(/^(.+?)\s+(is|are|was|were|has|have|uses|supports|requires|prefers|must|should|will)\s+(.+)$/i);
      const triple: DurableFactTriple = simple
        ? {
            subject: simple[1].trim(),
            predicate: normalizePredicate(simple[2]),
            object: simple[3].trim().replace(/[.]+$/, ""),
          }
        : {
            subject: fallbackSubject,
            predicate: "durable-fact",
            object: text,
          };

      const key = `${triple.subject}|${triple.predicate}|${triple.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(triple);
    }
  }

  return out;
}

function chooseTitle(decisions: string[], durableFacts: string[], query: string): string {
  const first = decisions[0] || durableFacts[0] || query;
  const trimmed = first.replace(/\s+/g, " ").trim();
  return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
}

function buildConsolidationDraft(args: {
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
    `# Consolidation: ${title}`,
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
    reasons.push(`requires consolidation content length >= ${args.minimumContentCharacters} chars`);
  }
  if (args.populatedSectionCount < args.minimumPopulatedSections) {
    reasons.push(`requires at least ${args.minimumPopulatedSections} populated consolidation sections`);
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
  const writeDurableFactsToKg = options.writeDurableFactsToKg ?? true;

  let summaries: TranscriptInsightSummary[] = [];
  let usedProvidedMapperSummaries = false;

  if (Array.isArray(options.mapperSummaries) && options.mapperSummaries.length > 0) {
    summaries = parseProvidedMapperSummaries(options.mapperSummaries);
    usedProvidedMapperSummaries = true;
  } else if (Array.isArray(options.rawEntries) && options.rawEntries.length > 0) {
    summaries = options.rawEntries.map((entry) => mapEntryToSummary(entry));
  } else {
    const searchLimit = Math.max(3, Number(options.searchLimit ?? 12));
    const searchResult = await client.search(query, searchLimit, targetWing, targetRoom);
    summaries = parseSearchItems(searchResult).map(mapEntryToSummary);
  }

  const included = summaries.filter((summary) => confidenceAllows(summary.confidence, confidenceFloor));
  const dropped = summaries.filter((summary) => !confidenceAllows(summary.confidence, confidenceFloor));

  const sourceDrawerIds = uniqSorted(included.map((summary) => summary.transcriptId));
  const consolidationDraft = buildConsolidationDraft({ query, summaries: included });

  const inflationGuard = evaluateInflationGuard({
    sourceDrawerIds,
    contentCharacters: consolidationDraft.contentCharacters,
    populatedSectionCount: consolidationDraft.populatedSectionCount,
    minimumDistinctSources,
    minimumContentCharacters,
    minimumPopulatedSections,
  });

  let createdNodeId: string | undefined;
  let createResult: Record<string, unknown> | undefined;
  let selectedHall: string | undefined;
  let kgWrites: SynthesisConsolidationResult["kgWrites"];

  if (applyWrites && inflationGuard.passed) {
    const create = await client.createDerivedDrawer({
      wing: targetWing,
      room: targetRoom,
      content: consolidationDraft.content,
      source_drawer_ids: sourceDrawerIds,
      desc: consolidationDraft.title,
      labels: options.labels || [],
      added_by: "electric-shepherd-consolidation",
    });
    createResult = create;

    const createObj = asObject(create);
    const id = asString(createObj.node_id || createObj.drawer_id || createObj.id).trim();
    if (id) {
      createdNodeId = id;
      selectedHall = selectTargetHall({
        summaries: included,
        labels: options.labels,
        targetHall: options.targetHall,
      });

      const writes: Array<{ subject: string; predicate: string; object: string; source_closet?: string; valid_from?: string }> = [];
      const writeErrors: string[] = [];
      let writeSuccess = 0;

      writes.push({
        subject: id,
        predicate: "in-hall",
        object: selectedHall,
        source_closet: id,
      });

      for (const summary of included) {
        const hall = inferHallFromSummary(summary);
        writes.push({
          subject: summary.transcriptId,
          predicate: "in-hall",
          object: hall,
          source_closet: id,
        });
      }

      if (writeDurableFactsToKg) {
        const now = new Date().toISOString().slice(0, 10);
        for (const triple of extractDurableFactTriples(included, id)) {
          writes.push({
            subject: triple.subject,
            predicate: triple.predicate,
            object: triple.object,
            source_closet: id,
            valid_from: now,
          });
        }
      }

      const dedup = new Set<string>();
      for (const write of writes) {
        const key = `${write.subject}|${write.predicate}|${write.object}`;
        if (dedup.has(key)) continue;
        dedup.add(key);

        try {
          await client.kgAdd(write);
          writeSuccess += 1;
        } catch (err) {
          writeErrors.push(String(err));
        }
      }

      kgWrites = {
        attempted: dedup.size,
        succeeded: writeSuccess,
        failed: dedup.size - writeSuccess,
        errors: writeErrors,
      };
    }
  }

  return {
    phase: "source-derived-consolidation",
    query,
    usedProvidedMapperSummaries,
    mapperSummaryCount: summaries.length,
    includedSummaryIds: included.map((summary) => summary.transcriptId),
    droppedSummaryIds: dropped.map((summary) => summary.transcriptId),
    sourceDrawerIds,
    consolidationDraft: {
      title: consolidationDraft.title,
      content: consolidationDraft.content,
      contentCharacters: consolidationDraft.contentCharacters,
      populatedSectionCount: consolidationDraft.populatedSectionCount,
      labels: options.labels || [],
    },
    inflationGuard,
    selectedHall,
    kgWrites,
    createdNodeId,
    createResult,
  };
}
