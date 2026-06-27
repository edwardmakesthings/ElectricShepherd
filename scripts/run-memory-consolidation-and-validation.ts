import { createMemgraphClient, type SourceDrawerWorkItem } from "../adapter/memgraph.ts";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts";
// @ts-expect-error runtime script package does not include node typings
import { execFileSync } from "node:child_process";
// @ts-expect-error runtime script package does not include node typings
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// @ts-expect-error runtime script package does not include node typings
import { dirname, join, relative, resolve } from "node:path";
import {
  runSynthesisConsolidation,
  type SynthesisConsolidationOptions,
  type SynthesisConsolidationResult,
  type TranscriptInsightSummary,
} from "../adapter/synthesis-consolidation.ts";
import {
  runValidationMergeReview,
  type ValidationMergeReviewOptions,
  type ValidationMergeReviewResult,
} from "../adapter/validation-merge-review.ts";
import {
  runCadenceOrchestrator,
  type CadenceArea,
  type CadenceOrchestratorOptions,
  type CadenceOrchestratorResult,
} from "../adapter/cadence-orchestrator.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";
import { acquireConsolidationLock, releaseConsolidationLock } from "./consolidation-lock.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  pid: number;
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
  exit: (code: number) => never;
};

// Project root whose shared consolidation lock this process currently holds (null when it
// does not hold one, e.g. the lock was inherited from the spawning plugin). Used
// so both the success path and the top-level catch can release it.
let heldConsolidationLockRoot: string | null = null;

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

type MapperEnvelope = {
  summaries: TranscriptInsightSummary[];
  raw: unknown;
  via: "task-tool" | "opencode-run" | "none";
};

type AuditorEnvelope = {
  verdict: "pass" | "revise" | "escalate";
  findings: string[];
  recommendedActions: string[];
  raw: unknown;
  via: "task-tool" | "opencode-run" | "none";
};

type CadenceState = {
  lastRunISO: string;
  areas: Record<string, { lastCandidateCount: number; lastTriggeredISO?: string }>;
};

type WorklistMode = "unconsolidated" | "all";

type WorklistOptions = {
  mode: WorklistMode;
  limit: number;
  batchSize: number;
};

function getArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseCSV(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tryReadFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

function tryWriteFile(path: string, content: string): void {
  // Atomic write: render to a sibling temp file then rename over the target.
  // rename(2) is atomic on the same filesystem (and overwrites on Windows via
  // Node's fs), so a process killed mid-write can never leave a half-rendered
  // mem-core file — a reader sees either the old file or the complete new one.
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

function parseMapperSummariesFromFile(path: string | undefined): TranscriptInsightSummary[] | undefined {
  if (!path) return undefined;
  const raw = tryReadFile(path);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as TranscriptInsightSummary[]) : undefined;
}

function parseCadenceAreas(path: string | undefined): CadenceArea[] {
  if (!path) return [];
  const raw = tryReadFile(path);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as CadenceArea[]) : [];
}

function parseCadenceState(path: string): CadenceState {
  const raw = tryReadFile(path);
  if (!raw) {
    return { lastRunISO: "", areas: {} };
  }
  const parsed = JSON.parse(raw);
  const obj = asObject(parsed);
  return {
    lastRunISO: asString(obj.lastRunISO),
    areas: asObject(obj.areas) as Record<string, { lastCandidateCount: number; lastTriggeredISO?: string }>,
  };
}

function toSummaryFromRaw(raw: unknown): TranscriptInsightSummary[] {
  const out: TranscriptInsightSummary[] = [];
  const arr = asArray(raw);
  for (const item of arr) {
    const obj = asObject(item);
    const transcriptId = asString(obj.transcriptId || obj.transcript_id || obj.id).trim();
    if (!transcriptId) continue;

    const pickList = (camel: string, snake: string): string[] => {
      const src = asArray(obj[camel] ?? obj[snake]);
      return src.map((v) => asString(v).trim()).filter(Boolean);
    };

    const confidenceRaw = asString(obj.confidence).trim().toLowerCase();
    const confidence =
      confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
        ? (confidenceRaw as "high" | "medium" | "low")
        : "low";

    out.push({
      transcriptId,
      confidence,
      durableFacts: pickList("durableFacts", "durable_facts"),
      decisions: pickList("decisions", "decisions"),
      rootCausesAndWorkedExamples: pickList("rootCausesAndWorkedExamples", "root_causes_and_worked_examples"),
      subsystemsAndFiles: pickList("subsystemsAndFiles", "subsystems_and_files"),
      openItems: pickList("openItems", "open_items"),
      rawExcerpt: asString(obj.rawExcerpt || obj.raw_excerpt) || undefined,
    });
  }
  return out;
}

function parseEmbeddedJSON(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to bracket scan fallback.
  }

  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const candidates = [firstBrace, firstBracket].filter((n) => n >= 0).sort((a, b) => a - b);
  for (const start of candidates) {
    const endChar = trimmed[start] === "[" ? "]" : "}";
    const end = trimmed.lastIndexOf(endChar);
    if (end <= start) continue;
    const snippet = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(snippet);
    } catch {
      // Keep trying other candidates.
    }
  }

  return undefined;
}

function runSubagentViaOpenCode(args: {
  opencodeBin: string;
  agentName: string;
  prompt: string;
}): string {
  return execFileSync(args.opencodeBin, ["run", args.prompt, "--agent", args.agentName], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type MemcoreApplyOptions = {
  enabled: boolean;
  filePath?: string;
  baseDir?: string;
  scopeDir?: string;
};

function findWorkspaceRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "package.json")) || existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function resolveMemcoreFilePath(args: {
  explicitFilePath?: string;
  explicitBaseDir?: string;
  scopeDir?: string;
}): string {
  if (args.explicitFilePath) {
    return resolve(args.explicitFilePath);
  }

  const configured = args.explicitBaseDir ? resolve(args.explicitBaseDir) : undefined;
  const candidates = [configured, resolve(".electric-shepherd/memory")].filter(Boolean) as string[];
  const existing = candidates.find((dir) => existsSync(dir));
  const base = existing || resolve(".electric-shepherd/memory");
  const scopeDir = resolve(args.scopeDir || process.cwd());
  const workspaceRoot = findWorkspaceRoot(scopeDir);
  const relScope = relative(workspaceRoot, scopeDir);
  if (!relScope || relScope === ".") {
    return resolve(base, "memory.md");
  }
  if (relScope.startsWith("..")) {
    return resolve(base, "memory.md");
  }
  return resolve(base, relScope, "memory.md");
}

async function callSubagentMapper(args: {
  mcp: MCPHttpClient;
  toolPrefix: string;
  mapperAgentName: string;
  query: string;
  wing: string;
  room: string;
  worklistIds: string[];
  opencodeBin: string;
}): Promise<MapperEnvelope> {
  const getDrawerTool = `${args.toolPrefix}get_drawer`;
  const orderedIds = args.worklistIds.filter(Boolean);
  const serializedIds = orderedIds.join(", ");
  const taskPrompt = [
    "Read the exact worklist transcripts and produce mapper summaries as JSON array.",
    `Scope context: wing='${args.wing}', room='${args.room}', query='${args.query}'.`,
    `Use tool: ${getDrawerTool} for EACH drawer id in this exact order: ${serializedIds}.`,
    "Do not use search or any broad query tools. Process only the provided IDs.",
    "Return ONLY valid JSON array with items shaped as:",
    "{ transcriptId, confidence, durableFacts[], decisions[], rootCausesAndWorkedExamples[], subsystemsAndFiles[], openItems[], rawExcerpt? }",
  ].join("\n");

  try {
    const response = await args.mcp.callTool("task", {
      description: `Mapper summaries for ${args.query}`,
      prompt: taskPrompt,
      subagent_type: args.mapperAgentName,
    });

    const parsed = toSummaryFromRaw(response);
    if (parsed.length > 0) {
      return { summaries: parsed, raw: response, via: "task-tool" };
    }

    const text = asString((response as Record<string, unknown>).text || (response as Record<string, unknown>).result);
    if (text) {
      const parsedJSON = parseEmbeddedJSON(text);
      if (parsedJSON) {
        const summaries = toSummaryFromRaw(parsedJSON);
        if (summaries.length > 0) {
          return { summaries, raw: response, via: "task-tool" };
        }
      }
    }
  } catch {
    // Fall through to opencode-run fallback.
  }

  try {
    const output = runSubagentViaOpenCode({
      opencodeBin: args.opencodeBin,
      agentName: args.mapperAgentName,
      prompt: taskPrompt,
    });
    const parsedJSON = parseEmbeddedJSON(output);
    if (parsedJSON) {
      const summaries = toSummaryFromRaw(parsedJSON);
      if (summaries.length > 0) {
        return { summaries, raw: output, via: "opencode-run" };
      }
    }
  } catch {
    // Keep empty and let caller continue with non-subagent flow.
  }

  return { summaries: [], raw: null, via: "none" };
}

async function callSubagentAuditor(args: {
  mcp: MCPHttpClient;
  auditorAgentName: string;
  consolidationResult: unknown;
  validationResult: unknown;
  opencodeBin: string;
}): Promise<AuditorEnvelope> {
  const taskPrompt = [
    "Audit consolidation and validation outputs.",
    "Return ONLY valid JSON object shaped as:",
    "{ verdict: pass|revise|escalate, findings: string[], recommendedActions: string[] }",
    "Consolidation result:",
    JSON.stringify(args.consolidationResult),
    "Validation result:",
    JSON.stringify(args.validationResult),
  ].join("\n");

  let verdict: "pass" | "revise" | "escalate" = "pass";
  let findings: string[] = [];
  let recommendedActions: string[] = [];

  try {
    const response = await args.mcp.callTool("task", {
      description: "Audit consolidation and validation outputs",
      prompt: taskPrompt,
      subagent_type: args.auditorAgentName,
    });

    const directObj = asObject(response);
    const maybeVerdict = asString(directObj.verdict).toLowerCase();
    if (maybeVerdict === "pass" || maybeVerdict === "revise" || maybeVerdict === "escalate") {
      verdict = maybeVerdict;
      findings = asArray(directObj.findings).map((v) => asString(v)).filter(Boolean);
      recommendedActions = asArray(directObj.recommendedActions || directObj.recommended_actions)
        .map((v) => asString(v))
        .filter(Boolean);
      return { verdict, findings, recommendedActions, raw: response, via: "task-tool" };
    }

    const text = asString(directObj.text || directObj.result);
    if (text) {
      const parsed = asObject(parseEmbeddedJSON(text));
      const parsedVerdict = asString(parsed.verdict).toLowerCase();
      if (parsedVerdict === "pass" || parsedVerdict === "revise" || parsedVerdict === "escalate") {
        verdict = parsedVerdict;
      }
      findings = asArray(parsed.findings).map((v) => asString(v)).filter(Boolean);
      recommendedActions = asArray(parsed.recommendedActions || parsed.recommended_actions)
        .map((v) => asString(v))
        .filter(Boolean);
      return { verdict, findings, recommendedActions, raw: response, via: "task-tool" };
    }
  } catch {
    // Fall through to opencode-run fallback.
  }

  try {
    const output = runSubagentViaOpenCode({
      opencodeBin: args.opencodeBin,
      agentName: args.auditorAgentName,
      prompt: taskPrompt,
    });
    const parsed = asObject(parseEmbeddedJSON(output));
    if (Object.keys(parsed).length > 0) {
      const parsedVerdict = asString(parsed.verdict).toLowerCase();
      if (parsedVerdict === "pass" || parsedVerdict === "revise" || parsedVerdict === "escalate") {
        verdict = parsedVerdict;
      }
      findings = asArray(parsed.findings).map((v) => asString(v)).filter(Boolean);
      recommendedActions = asArray(parsed.recommendedActions || parsed.recommended_actions)
        .map((v) => asString(v))
        .filter(Boolean);
      return { verdict, findings, recommendedActions, raw: output, via: "opencode-run" };
    }
  } catch {
    // Return a structured fallback so pipeline remains usable.
  }

  return {
    verdict: "escalate",
    findings: ["auditor output unavailable; no task tool or parseable subagent output"],
    recommendedActions: ["retry with --use-live-auditor once subagent runtime is available"],
    raw: null,
    via: "none",
  };
}

function parseConsolidationOptions(argv: string[]): SynthesisConsolidationOptions {
  const runCadence = hasFlag(argv, "--run-cadence");

  let query = getArg(argv, "--query") || "memory consolidation candidates";
  let targetWing = getArg(argv, "--wing") || getArg(argv, "--target-wing") || getArg(argv, "--scope-wing") || "context-blocks";
  let targetRoom = getArg(argv, "--room") || getArg(argv, "--target-room") || getArg(argv, "--scope-room") || "context-blocks";

  if ((!query || !targetWing || !targetRoom) && runCadence) {
    query = query || "memory consolidation candidates";
    targetWing = targetWing || "context-blocks";
    targetRoom = targetRoom || "context-blocks";
  }

  const mapperSummaries = parseMapperSummariesFromFile(getArg(argv, "--mapper-summaries-file"));

  return {
    query,
    targetWing,
    targetRoom,
    targetHall: getArg(argv, "--target-hall") || getArg(argv, "--hall") || undefined,
    searchLimit: Number(getArg(argv, "--search-limit") || "12"),
    minimumDistinctSources: Number(getArg(argv, "--min-sources") || "2"),
    minimumContentCharacters: Number(getArg(argv, "--min-content-chars") || "220"),
    minimumPopulatedSections: Number(getArg(argv, "--min-section-count") || "3"),
    minimumMapperConfidence: (getArg(argv, "--mapper-confidence-floor") as "high" | "medium" | "low" | undefined) || "medium",
    labels: parseCSV(getArg(argv, "--labels")),
    writeDurableFactsToKg: !hasFlag(argv, "--no-kg-durable-facts"),
    applyWrites: hasFlag(argv, "--apply"),
    mapperSummaries,
  };
}

function parseWorklistOptions(argv: string[]): WorklistOptions {
  const allMode = hasFlag(argv, "--all") || hasFlag(argv, "--full-scope") || hasFlag(argv, "--reprocess-all");
  const limit = Number(getArg(argv, "--worklist-limit") || getArg(argv, "--search-limit") || "200");
  const batchSize = Math.max(1, Number(getArg(argv, "--batch-size") || "25"));
  return {
    mode: allMode ? "all" : "unconsolidated",
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200,
    batchSize,
  };
}

function chunkItems<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function parseDrawerPayload(raw: unknown): SourceDrawerWorkItem | null {
  const root = asObject(raw);
  const candidates = [
    asObject(root.drawer),
    asObject(root.result),
    asObject(root.data),
    asObject(asArray(root.drawers)[0]),
    asObject(asArray(root.results)[0]),
    root,
  ];
  const candidate = candidates.find((obj) => Object.keys(obj).length > 0) || {};
  const drawerId = asString(candidate.drawer_id || candidate.node_id || candidate.id).trim();
  if (!drawerId) return null;
  return {
    drawer_id: drawerId,
    wing: asString(candidate.wing || candidate.closet || candidate.namespace).trim() || undefined,
    room: asString(candidate.room).trim() || undefined,
    desc: asString(candidate.desc || candidate.title || candidate.summary).trim() || undefined,
    filed_at: asString(candidate.filed_at || candidate.created_at).trim() || undefined,
    content: asString(candidate.content || candidate.text).trim() || undefined,
  };
}

async function ensureRawEntriesForChunk(
  client: ReturnType<typeof createMemgraphClient>,
  items: SourceDrawerWorkItem[],
): Promise<Array<{ id: string; text: string }>> {
  const out: Array<{ id: string; text: string }> = [];
  for (const item of items) {
    const existing = asString(item.content).trim();
    if (existing) {
      out.push({ id: item.drawer_id, text: existing });
      continue;
    }
    try {
      const raw = await client.getDrawer({ drawer_id: item.drawer_id });
      const parsed = parseDrawerPayload(raw);
      const text = asString(parsed?.content).trim();
      if (text) out.push({ id: item.drawer_id, text });
    } catch {
      // Keep going; missing drawer text should not fail the whole batch.
    }
  }
  return out;
}

function parseValidationOptions(argv: string[], consolidation: SynthesisConsolidationOptions): ValidationMergeReviewOptions {
  const scopeRoom = getArg(argv, "--scope-room") || consolidation.targetRoom;
  return {
    scopeRoom,
    scopeWing: getArg(argv, "--scope-wing") || consolidation.targetWing,
    filterWing: getArg(argv, "--wing") || getArg(argv, "--target-wing") || consolidation.targetWing,
    filterRoom: getArg(argv, "--room") || getArg(argv, "--target-room") || consolidation.targetRoom,
    includeMergedNodes: hasFlag(argv, "--include-merged"),
    validationDepth: Number(getArg(argv, "--validation-depth") || "6"),
    validationLimit: Number(getArg(argv, "--validation-limit") || "50"),
    mergeSimilarityThreshold: Number(getArg(argv, "--merge-threshold") || "0.82"),
    mergeLimit: Number(getArg(argv, "--merge-limit") || "20"),
    mergeMaxNodes: Number(getArg(argv, "--merge-max-nodes") || "300"),
    mergeMaxDepth: Number(getArg(argv, "--merge-max-depth") || "20"),
    applyMerges: hasFlag(argv, "--apply-merges"),
    automaticMergeScore: Number(getArg(argv, "--allow-auto-merge-score") || "0.92"),
    notificationURL: getArg(argv, "--ntfy-url") || process.env.NTFY_URL,
    escalationTopic: getArg(argv, "--escalation-topic") || "electric-shepherd-escalations",
  };
}

function parseCadenceOptions(argv: string[], consolidation: SynthesisConsolidationOptions): CadenceOrchestratorOptions {
  const fromFile = parseCadenceAreas(getArg(argv, "--areas-file"));
  const fallbackArea: CadenceArea = {
    areaId: getArg(argv, "--area-id") || "default-area",
    query: consolidation.query,
    targetWing: consolidation.targetWing,
    targetRoom: consolidation.targetRoom,
    scopeRoom: getArg(argv, "--scope-room") || consolidation.targetRoom,
    scopeWing: getArg(argv, "--scope-wing") || consolidation.targetWing,
    volumeThreshold: Number(getArg(argv, "--volume-threshold") || "8"),
  };

  return {
    areas: fromFile.length > 0 ? fromFile : [fallbackArea],
    executionMode: (getArg(argv, "--cadence-mode") as "plan" | "execute" | undefined) || "plan",
    defaultVolumeThreshold: Number(getArg(argv, "--volume-threshold") || "8"),
    defaultSearchLimit: Number(getArg(argv, "--search-limit") || "20"),
    idleWindowMinutes: Number(getArg(argv, "--idle-window-minutes") || "20"),
    currentIdleMinutes: Number(getArg(argv, "--current-idle-minutes") || "0"),
    runNightlyBackstop: hasFlag(argv, "--nightly-backstop"),
    applyWrites: hasFlag(argv, "--apply"),
    applyMerges: hasFlag(argv, "--apply-merges"),
  };
}

function parseMemcoreApply(argv: string[]): MemcoreApplyOptions {
  const disabled = hasFlag(argv, "--no-mem-core-auto");
  const enabled = !disabled || hasFlag(argv, "--apply-mem-core");

  return {
    enabled,
    filePath: getArg(argv, "--mem-core-file") || undefined,
    baseDir: getArg(argv, "--mem-core-dir") || undefined,
    scopeDir: getArg(argv, "--mem-core-scope-dir") || undefined,
  };
}

function buildMemcoreMarkdown(args: {
  query: string;
  consolidation: SynthesisConsolidationResult;
  validation: ValidationMergeReviewResult;
  auditor?: AuditorEnvelope;
}): string {
  const validationSummary = {
    totalNodes: args.validation.downwardValidation.length,
    reviseCount: args.validation.downwardValidation.filter((x) => x.verdict === "revise").length,
    mergeEscalations: args.validation.mergeAdjudications.filter((x) => x.decision === "escalate").length,
  };

  const auditorLine = args.auditor
    ? `- Auditor verdict: ${args.auditor.verdict}`
    : "- Auditor verdict: not-run";

  const findings = args.auditor?.findings || [];
  const findingSection = findings.length > 0 ? findings.map((f) => `- ${f}`).join("\n") : "- (none)";

  return [
    "# Labeled memory blocks (always in context)",
    "",
    "## [project-state]",
    `- Latest consolidation title: ${args.consolidation.consolidationDraft.title}`,
    `- Consolidation query: ${args.query}`,
    auditorLine,
    "",
    "## [active-conventions]",
    `- Validation nodes reviewed: ${validationSummary.totalNodes}`,
    `- Validation revise count: ${validationSummary.reviseCount}`,
    `- Merge escalations: ${validationSummary.mergeEscalations}`,
    "",
    "## [user-preferences]",
    "- Keep prompts concise, actionable, and testable.",
    "- Prefer one end-of-pass validation sweep over repetitive incremental checks unless debugging.",
    "- Keep memory entries high-signal: durable decisions, root causes, and reusable patterns.",
    "",
    "## [auditor-findings]",
    findingSection,
  ].join("\n");
}

function usage(): string {
  return [
    "Usage:",
    "  node scripts/run-memory-consolidation-and-validation.ts [--query <text>] [--wing <wing>] [--room <room>] [flags]",
    "",
    "Consolidation flags:",
    "  --search-limit <n>",
    "  --min-sources <n>",
    "  --min-content-chars <n>",
    "  --min-section-count <n>",
    "  --mapper-confidence-floor <high|medium|low>",
    "  --mapper-summaries-file <path-to-json-array>",
    "  --use-live-mapper                (invoke dream-mapper via task tool)",
    "  --mapper-agent <name>            (default: dream-mapper)",
    "  --all | --full-scope             (worklist mode: reprocess all source drawers in scope)",
    "  --batch-size <n>                 (chunk worklist into batch consolidation calls; default: 25)",
    "  --worklist-limit <n>             (max source drawers enumerated; default: 200)",
    "  --labels <csv>",
    "  --apply                          (creates derived drawers if checks pass; default is dry-run)",
    "",
    "Validation + Merge Review flags:",
    "  --scope-room <room>",
    "  --scope-wing <wing>",
    "  --validation-depth <n>",
    "  --validation-limit <n>",
    "  --merge-threshold <float>",
    "  --merge-limit <n>",
    "  --allow-auto-merge-score <float>",
    "  --apply-merges                   (applies auto-merge decisions; default is read-only)",
    "  --ntfy-url <url>",
    "  --escalation-topic <topic>",
    "  --use-live-auditor               (invoke dream-auditor via task tool)",
    "  --auditor-agent <name>           (default: dream-auditor)",
    "",
    "Mem-core apply flags:",
    "  --apply-mem-core                 (legacy explicit flag; mem-core auto write is on by default)",
    "  --no-mem-core-auto               (disable automatic mem-core file output)",
    "  --mem-core-dir <path>            (base dir; default: ./.electric-shepherd/memory)",
    "  --mem-core-scope-dir <path>      (scope directory used to place layered memory.md under the base dir)",
    "  --mem-core-file <path>           (full override path for one output file)",
    "",
    "Cadence Orchestrator flags:",
    "  --run-cadence                    (include cadence orchestration in output)",
    "  --cadence-mode <plan|execute>",
    "  --areas-file <path-to-json-array>",
    "  --area-id <id>                   (fallback area id when no areas file)",
    "  --volume-threshold <n>",
    "  --idle-window-minutes <n>",
    "  --current-idle-minutes <n>",
    "  --nightly-backstop",
    "  --cadence-state-file <path>      (persist area counters/trigger timestamps)",
    "  --include-base-pipeline          (also run top-level consolidation+validation when --run-cadence is set)",
    "  --opencode-bin <path>            (default: opencode; used for live subagent fallback)",
    "",
    "Output:",
    "  JSON envelope: { worklist, worklistMode, consolidation, validationMergeReview, mapper?, auditor?, memCoreApply?, cadence?, cadenceState? }",
    "",
    "Read-only defaults:",
    "  Without --apply and --apply-merges, the run proposes consolidation/merge decisions but does not write them to MemPalace.",
    "  mem-core render remains enabled by default and writes local files only.",
  ].join("\n");
}

async function main(): Promise<void> {
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env });

  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  // Cross-process lock so a plugin-triggered run, a cron run, and an n8n run can
  // never overlap. The turn-guard plugin sets ESHEPHERD_CONSOLIDATION_LOCK_INHERITED when
  // it spawns us (it already holds the lock), so we skip acquire/release in that
  // case to avoid deadlocking against the parent. --no-lock /
  // ESHEPHERD_CONSOLIDATION_LOCK_DISABLED bypass it for tests.
  const lockInherited =
    isTruthyFlag(process.env.ESHEPHERD_CONSOLIDATION_LOCK_INHERITED) ||
    isTruthyFlag(process.env.ESHEPHERD_CONSOLIDATION_LOCK_DISABLED) ||
    hasFlag(argv, "--no-lock");
  if (!lockInherited) {
    const staleMs = Number(process.env.ESHEPHERD_AUTO_CONSOLIDATION_TIMEOUT_MS) || 300000;
    const lockRoot = process.cwd();
    if (!acquireConsolidationLock(lockRoot, { source: "run-memory-consolidation-and-validation" }, staleMs)) {
      process.stdout.write(`${JSON.stringify({ skipped: true, reason: "consolidation-lock-held" }, null, 2)}\n`);
      return;
    }
    heldConsolidationLockRoot = lockRoot;
  }

  const consolidationOptions = parseConsolidationOptions(argv);
  const validationOptions = parseValidationOptions(argv, consolidationOptions);
  const cadenceOptions = parseCadenceOptions(argv, consolidationOptions);
  const worklistOptions = parseWorklistOptions(argv);
  const memcoreApply = parseMemcoreApply(argv);

  const mcpURL = process.env.MEMPALACE_MCP_URL || "http://localhost:8093/mcp";
  const toolPrefix = process.env.MEMGRAPH_TOOL_PREFIX || "mempalace_";
  const mcpHeaders = resolveMCPHeadersFromEnv(process.env);

  const mcp = new MCPHttpClient(mcpURL, mcpHeaders, {
    clientName: "electric-shepherd-memory-system",
  });
  await mcp.initialize();

  const client = createMemgraphClient({
    callTool: (name, args) => mcp.callTool(name, args),
    toolPrefix,
  });

  const runCadence = hasFlag(argv, "--run-cadence");
  const includeBasePipeline = !runCadence || hasFlag(argv, "--include-base-pipeline");
  const opencodeBin = getArg(argv, "--opencode-bin") || "opencode";

  let mapper: MapperEnvelope | undefined;
  const mapperBatches: MapperEnvelope[] = [];
  let consolidation: SynthesisConsolidationResult | undefined;
  const consolidationBatches: SynthesisConsolidationResult[] = [];
  let validationMergeReview: ValidationMergeReviewResult | undefined;
  let validationSkippedReason: string | undefined;

  const enumerateAll = worklistOptions.mode === "all";
  let worklist: SourceDrawerWorkItem[] = [];
  if (includeBasePipeline) {
    worklist = enumerateAll
      ? await client.listSourceDrawersByScope({
          wing: consolidationOptions.targetWing,
          room: consolidationOptions.targetRoom,
          limit: worklistOptions.limit,
        })
      : await client.findUnconsolidatedSourceDrawers({
          wing: consolidationOptions.targetWing,
          room: consolidationOptions.targetRoom,
          limit: worklistOptions.limit,
        });
  }

  const worklistOutput = {
    mode: worklistOptions.mode,
    count: worklist.length,
    limit: worklistOptions.limit,
    batchSize: worklistOptions.batchSize,
    note: includeBasePipeline
      ? enumerateAll
        ? "full-scope override active: this run may reprocess already-consolidated source drawers"
        : "default mode: source drawers with no incoming synthesized-from edges"
      : "cadence-only run: base worklist pipeline not executed",
    items: worklist.map((item) => ({
      drawer_id: item.drawer_id,
      wing: item.wing,
      room: item.room,
      desc: item.desc,
      filed_at: item.filed_at,
    })),
  };

  if (!enumerateAll && worklist.length === 0 && includeBasePipeline) {
    const output = {
      skipped: true,
      reason: "nothing-unconsolidated",
      mode: includeBasePipeline ? "full-pipeline" : "cadence-only",
      worklistMode: worklistOptions.mode,
      worklist: worklistOutput,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (heldConsolidationLockRoot) {
      releaseConsolidationLock(heldConsolidationLockRoot);
      heldConsolidationLockRoot = null;
    }
    return;
  }

  if (enumerateAll && worklist.length === 0 && includeBasePipeline) {
    const output = {
      skipped: true,
      reason: "scope-empty",
      mode: includeBasePipeline ? "full-pipeline" : "cadence-only",
      worklistMode: worklistOptions.mode,
      worklist: worklistOutput,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (heldConsolidationLockRoot) {
      releaseConsolidationLock(heldConsolidationLockRoot);
      heldConsolidationLockRoot = null;
    }
    return;
  }

  if (includeBasePipeline) {
    const worklistChunks = chunkItems(worklist, worklistOptions.batchSize);
    const useLiveMapper = hasFlag(argv, "--use-live-mapper");

    for (const chunk of worklistChunks) {
      const chunkIds = chunk.map((item) => item.drawer_id);
      let chunkMapper: MapperEnvelope | undefined;

      if (useLiveMapper) {
        chunkMapper = await callSubagentMapper({
          mcp,
          toolPrefix,
          mapperAgentName: getArg(argv, "--mapper-agent") || "dream-mapper",
          query: consolidationOptions.query,
          wing: consolidationOptions.targetWing,
          room: consolidationOptions.targetRoom,
          worklistIds: chunkIds,
          opencodeBin,
        });
        mapperBatches.push(chunkMapper);
      }

      const rawEntries = await ensureRawEntriesForChunk(client, chunk);
      const chunkConsolidation = await runSynthesisConsolidation(client, {
        ...consolidationOptions,
        mapperSummaries: chunkMapper && chunkMapper.summaries.length > 0 ? chunkMapper.summaries : undefined,
        rawEntries,
      });
      consolidationBatches.push(chunkConsolidation);
    }

    if (consolidationBatches.length > 0) {
      consolidation = consolidationBatches[consolidationBatches.length - 1];
    }

    if (mapperBatches.length > 0) {
      const mergedSummaries = mapperBatches.flatMap((batch) => batch.summaries);
      mapper = {
        summaries: mergedSummaries,
        raw: mapperBatches.map((batch) => batch.raw),
        via: mapperBatches.every((batch) => batch.via === "task-tool")
          ? "task-tool"
          : mapperBatches.some((batch) => batch.via === "opencode-run")
            ? "opencode-run"
            : "none",
      };
    }

    const touchedNodeIds = [...new Set(consolidationBatches.map((c) => c.createdNodeId).filter(Boolean))] as string[];
    if (touchedNodeIds.length > 0) {
      validationMergeReview = await runValidationMergeReview(client, {
        ...validationOptions,
        candidateNodeIds: touchedNodeIds,
      });
    } else {
      validationSkippedReason = "no-created-nodes";
    }
  }

  let auditor: AuditorEnvelope | undefined;
  if (includeBasePipeline && hasFlag(argv, "--use-live-auditor") && consolidation && validationMergeReview) {
    auditor = await callSubagentAuditor({
      mcp,
      auditorAgentName: getArg(argv, "--auditor-agent") || "dream-auditor",
      consolidationResult: consolidation,
      validationResult: validationMergeReview,
      opencodeBin,
    });
  }

  let memCoreApplyResult: Record<string, unknown> | undefined;
  if (memcoreApply.enabled && includeBasePipeline && consolidation) {
    const validationForRender: ValidationMergeReviewResult = validationMergeReview || {
      phase: "validation-merge-review",
      downwardValidation: [],
      mergeAdjudications: [],
      escalations: {
        reasons: validationSkippedReason ? [validationSkippedReason] : [],
        nodeIds: [],
        mergePairs: [],
        notified: false,
      },
    };

    const markdown = buildMemcoreMarkdown({
      query: consolidation.query,
      consolidation,
      validation: validationForRender,
      auditor,
    });

    const targetFilePath = resolveMemcoreFilePath({
      explicitFilePath: memcoreApply.filePath,
      explicitBaseDir: memcoreApply.baseDir,
      scopeDir: memcoreApply.scopeDir,
    });

    tryWriteFile(targetFilePath, markdown);

    memCoreApplyResult = {
      applied: true,
      mode: "auto",
      fileWritten: true,
      filePath: targetFilePath,
      markdownPreview: markdown.slice(0, 320),
    };
  } else if (!memcoreApply.enabled) {
    memCoreApplyResult = {
      applied: false,
      reason: "disabled by --no-mem-core-auto",
    };
  } else if (!includeBasePipeline) {
    memCoreApplyResult = {
      applied: false,
      reason: "cadence-only run (use --include-base-pipeline for mem-core render)",
    };
  } else {
    memCoreApplyResult = {
      applied: false,
      reason: "missing consolidation outputs",
    };
  }

  let cadence: CadenceOrchestratorResult | undefined;
  let cadenceStateOut: CadenceState | undefined;
  if (hasFlag(argv, "--run-cadence")) {
    cadence = await runCadenceOrchestrator(client, cadenceOptions);

    const cadenceStatePath = getArg(argv, "--cadence-state-file") || "./.electric-shepherd-cadence-state.json";
    const prior = parseCadenceState(cadenceStatePath);
    const next: CadenceState = {
      lastRunISO: new Date().toISOString(),
      areas: { ...prior.areas },
    };

    for (const area of cadence.plan) {
      const prev = next.areas[area.areaId];
      next.areas[area.areaId] = {
        lastCandidateCount: area.candidateCount,
        lastTriggeredISO: area.triggered ? next.lastRunISO : prev?.lastTriggeredISO,
      };
    }

    tryWriteFile(cadenceStatePath, JSON.stringify(next, null, 2));
    cadenceStateOut = next;
  }

  const output: Record<string, unknown> = {
    mode: includeBasePipeline ? "full-pipeline" : "cadence-only",
    worklistMode: worklistOptions.mode,
    worklist: worklistOutput,
  };

  if (consolidation) output.consolidation = consolidation;
  if (consolidationBatches.length > 0) output.consolidationBatches = consolidationBatches;
  if (validationMergeReview) output.validationMergeReview = validationMergeReview;
  if (validationSkippedReason && !validationMergeReview) output.validationSkipped = { reason: validationSkippedReason };

  if (mapper) output.mapper = mapper;
  if (auditor) output.auditor = auditor;
  if (memCoreApplyResult) output.memCoreApply = memCoreApplyResult;
  if (cadence) output.cadence = cadence;
  if (cadenceStateOut) output.cadenceState = cadenceStateOut;

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (heldConsolidationLockRoot) {
    releaseConsolidationLock(heldConsolidationLockRoot);
    heldConsolidationLockRoot = null;
  }
}

main().catch((err) => {
  if (heldConsolidationLockRoot) releaseConsolidationLock(heldConsolidationLockRoot);
  process.stderr.write(`[memory-consolidation-validation] ${String(err)}\n`);
  process.exit(1);
});
