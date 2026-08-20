import { createMemgraphClient, type SourceDrawerWorkItem } from "../adapter/memgraph.ts";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts";
// @ts-expect-error runtime script package does not include node typings
import { execFileSync } from "node:child_process";
// @ts-expect-error runtime script package does not include node typings
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// @ts-expect-error runtime script package does not include node typings
import { dirname, join, relative, resolve } from "node:path";
// @ts-expect-error runtime script package does not include node typings
import { fileURLToPath } from "node:url";
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
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
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

const NATIVE_COORD_HELPER_PATH = fileURLToPath(new URL("./native-consolidation-coord.py", import.meta.url));

// Project root whose shared consolidation lock this process currently holds (null when it
// does not hold one, e.g. the lock was inherited from the spawning plugin). Used
// so both the success path and the top-level catch can release it.
let heldConsolidationLockRoot: string | null = null;
let heldNativeConsolidationLease: { projectRoot: string; runId: string } | null = null;

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isFalsyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
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

function runNativeCoordinator(args: string[], env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  if (!existsSync(NATIVE_COORD_HELPER_PATH)) return undefined;

  const pythonBin = (env.ESHEPHERD_PYTHON_BIN || "python").trim() || "python";
  try {
    const raw = execFileSync(pythonBin, [NATIVE_COORD_HELPER_PATH, ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const parsed = asObject(parseEmbeddedJSON(raw));
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tryAcquireNativeConsolidationLease(args: {
  projectRoot: string;
  runId: string;
  staleMs: number;
  env: Record<string, string | undefined>;
}): NativeCoordAcquireResult {
  const cmdArgs = [
    "acquire",
    "--project-root",
    args.projectRoot,
    "--owner-pid",
    String(process.pid),
    "--run-id",
    args.runId,
    "--stale-ms",
    String(Math.max(1, Math.floor(args.staleMs))),
  ];

  const queuePath = (args.env.ESHEPHERD_CONSOLIDATION_NATIVE_COORD_PATH || "").trim();
  if (queuePath) {
    cmdArgs.push("--queue-path", queuePath);
  }

  const payload = runNativeCoordinator(cmdArgs, args.env);
  if (!payload) {
    return { state: "unavailable" };
  }
  if (payload.acquired === true) {
    return { state: "acquired" };
  }
  if (payload.acquired === false) {
    return {
      state: "held",
      reason: asString(payload.reason || payload.holder_run_id || payload.holder_pid) || "held",
    };
  }
  return { state: "unavailable" };
}

function releaseNativeConsolidationLease(args: {
  projectRoot: string;
  runId: string;
  env: Record<string, string | undefined>;
}): void {
  const cmdArgs = [
    "release",
    "--project-root",
    args.projectRoot,
    "--owner-pid",
    String(process.pid),
    "--run-id",
    args.runId,
  ];

  const queuePath = (args.env.ESHEPHERD_CONSOLIDATION_NATIVE_COORD_PATH || "").trim();
  if (queuePath) {
    cmdArgs.push("--queue-path", queuePath);
  }

  runNativeCoordinator(cmdArgs, args.env);
}

function releaseHeldConsolidationGuards(): void {
  if (heldNativeConsolidationLease) {
    releaseNativeConsolidationLease({
      projectRoot: heldNativeConsolidationLease.projectRoot,
      runId: heldNativeConsolidationLease.runId,
      env: process.env,
    });
    heldNativeConsolidationLease = null;
  }
  if (heldConsolidationLockRoot) {
    releaseConsolidationLock(heldConsolidationLockRoot);
    heldConsolidationLockRoot = null;
  }
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

type DiscoveredMCPConfig = {
  url: string;
  bearerToken?: string;
};

type NativeCoordAcquireResult = {
  state: "acquired" | "held" | "unavailable";
  reason?: string;
};

type ConsolidationCoordMode = "native-queue" | "lockfile" | "bypassed";

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

  const defaultSourceWing =
    (process.env.ESHEPHERD_SOURCE_CAPTURE_WING || "").trim() ||
    (process.env.ESHEPHERD_PROJECT_WING || "").trim() ||
    "opencode";
  const defaultSourceRoom =
    (process.env.ESHEPHERD_SOURCE_CAPTURE_ROOM || "").trim() ||
    "source-transcripts";

  let query = getArg(argv, "--query") || "memory consolidation candidates";
  let targetWing = getArg(argv, "--wing") || getArg(argv, "--target-wing") || getArg(argv, "--scope-wing") || defaultSourceWing;
  let targetRoom = getArg(argv, "--room") || getArg(argv, "--target-room") || getArg(argv, "--scope-room") || defaultSourceRoom;

  if ((!query || !targetWing || !targetRoom) && runCadence) {
    query = query || "memory consolidation candidates";
    targetWing = targetWing || defaultSourceWing;
    targetRoom = targetRoom || defaultSourceRoom;
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
): Promise<{ entries: Array<{ id: string; text: string }>; skipped: Array<{ drawer_id: string; reason: string }> }> {
  const out: Array<{ id: string; text: string }> = [];
  const skipped: Array<{ drawer_id: string; reason: string }> = [];
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
      else skipped.push({ drawer_id: item.drawer_id, reason: "empty-content" });
    } catch {
      // P3-3: record fetch failure instead of silently dropping
      skipped.push({ drawer_id: item.drawer_id, reason: "drawer-fetch-failed" });
    }
  }
  return { entries: out, skipped };
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

function discoverLiveMCPConfig(env: Record<string, string | undefined>): DiscoveredMCPConfig | undefined {
  if (isFalsyFlag(env.ESHEPHERD_MCP_AUTO_DISCOVER)) return undefined;
  if ((env.MEMPALACE_MCP_URL || "").trim()) return undefined;

  const pythonBin = (env.ESHEPHERD_PYTHON_BIN || "python").trim() || "python";
  const script = [
    "import json, os",
    "try:",
    "    from mempalace.config import MempalaceConfig",
    "    from mempalace.server_registry import read_live_serverinfo, server_token_path",
    "except Exception:",
    "    print('{}')",
    "    raise SystemExit(0)",
    "palace_path = (os.environ.get('MEMPALACE_PALACE_PATH') or MempalaceConfig().palace_path or '').strip()",
    "if not palace_path:",
    "    print('{}')",
    "    raise SystemExit(0)",
    "info = read_live_serverinfo(palace_path)",
    "if not info:",
    "    print('{}')",
    "    raise SystemExit(0)",
    "scheme = str(info.get('scheme') or 'http').strip() or 'http'",
    "host = str(info.get('host') or '127.0.0.1').strip() or '127.0.0.1'",
    "port = info.get('port')",
    "if isinstance(port, str) and port.strip().isdigit():",
    "    port = int(port.strip())",
    "if not isinstance(port, int):",
    "    print('{}')",
    "    raise SystemExit(0)",
    "token = ''",
    "try:",
    "    token_file = server_token_path(palace_path)",
    "    if token_file.exists():",
    "        token = token_file.read_text(encoding='utf-8').strip()",
    "except Exception:",
    "    token = ''",
    "print(json.dumps({'url': f'{scheme}://{host}:{port}/mcp', 'bearer_token': token}))",
  ].join("\n");

  try {
    const raw = execFileSync(pythonBin, ["-c", script], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const parsed = asObject(parseEmbeddedJSON(raw));
    const url = asString(parsed.url).trim();
    if (!url) return undefined;
    const bearerToken = asString(parsed.bearer_token).trim();
    return bearerToken ? { url, bearerToken } : { url };
  } catch {
    return undefined;
  }
}

function pointerBullets(values: string[], formatter: (value: string) => string, max = 40): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return ["- (none)"];
  const out = unique.slice(0, max).map((value) => `- ${formatter(value)}`);
  if (unique.length > max) out.push(`- ... (${unique.length - max} more)`);
  return out;
}

// A bare id is not retrievable knowledge; the description is what makes a pointer worth keeping.
function pointerDescription(value: string | undefined, fallback: string): string {
  const text = asString(value).replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function factBullets(values: string[], max: number): string[] {
  const unique = [...new Set(values.map((value) => asString(value).replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (unique.length === 0) return ["- (none)"];
  const out = unique.slice(0, max).map((value) => `- ${value.length > 200 ? `${value.slice(0, 197)}...` : value}`);
  if (unique.length > max) out.push(`- ... (${unique.length - max} more; see pointers below)`);
  return out;
}

function buildMemcoreMarkdown(args: {
  query: string;
  consolidation: SynthesisConsolidationResult;
  validation: ValidationMergeReviewResult;
  auditor?: AuditorEnvelope;
  sourceDescriptions?: Record<string, string>;
  includeFacts?: boolean;
  includePointers?: boolean;
  maxFactsPerSection?: number;
}): string {
  const includeFacts = args.includeFacts !== false;
  const includePointers = args.includePointers !== false;
  const maxFacts = Math.max(1, Number(args.maxFactsPerSection) || 8);
  const runId = asString(args.consolidation.runId).trim();
  const runPointer = runId ? `.electric-shepherd/journal/${runId}.jsonl` : "(none)";
  const draftTitle = pointerDescription(args.consolidation.consolidationDraft.title, "latest synthesis");
  const sourceDescriptions = args.sourceDescriptions || {};
  const verdictByNode = new Map(args.validation.downwardValidation.map((item) => [item.nodeId, item.verdict]));
  const createdNodePointers = args.consolidation.createdNodeId ? [args.consolidation.createdNodeId] : [];
  const sourceDrawerPointers = args.consolidation.sourceDrawerIds || [];
  const validationNodePointers = args.validation.downwardValidation.map((item) => item.nodeId);
  const escalationNodePointers = args.validation.escalations.nodeIds || [];
  const mergePairPointers = args.validation.escalations.mergePairs.map(
    (pair) => `${pair.sourceNodeId} -> ${pair.canonicalNodeId} (score=${Number(pair.score).toFixed(3)})`,
  );
  const auditorPointer = args.auditor ? `available in run trace (via=${args.auditor.via})` : "(not-run)";

  const lines: string[] = ["# Labeled memory blocks (always in context)", ""];

  if (includeFacts) {
    lines.push(
      "Facts below are resident: use them directly, no retrieval call needed.",
      "",
      "## [project-state]",
      `- Latest synthesis: ${draftTitle}`,
      ...factBullets(args.consolidation.consolidationDraft.durableFacts || [], maxFacts),
      "",
      "## [active-conventions]",
      ...factBullets(args.consolidation.consolidationDraft.decisions || [], maxFacts),
      "",
      "## [open-items]",
      ...factBullets(args.consolidation.consolidationDraft.openItems || [], maxFacts),
      "",
    );
  }

  if (includePointers) {
    lines.push(
      "Pointer index: open with `get_drawer` only when a description matches the current task.",
      "",
      "## [pointers]",
      `- Consolidation run log: ${runPointer}`,
      "- Latest synthesis:",
      ...pointerBullets(createdNodePointers, (id) => `node_id:${id} — ${draftTitle}`),
      "- Source transcripts consolidated in the latest run:",
      ...pointerBullets(sourceDrawerPointers, (id) => `drawer_id:${id} — ${pointerDescription(sourceDescriptions[id], "source transcript")}`),
      "- Synthesis nodes reviewed by validation:",
      ...pointerBullets(validationNodePointers, (id) => `node_id:${id} — validation ${verdictByNode.get(id) ?? "reviewed"}`),
      "- Nodes escalated for human review:",
      ...pointerBullets(escalationNodePointers, (id) => `node_id:${id} — needs review`),
      "- Merge pairs escalated:",
      ...pointerBullets(mergePairPointers, (entry) => entry),
      "",
      "## [auditor-findings]",
      `- Auditor review: ${auditorPointer}`,
    );
  }

  return lines.join("\n");
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
    "  --no-native-coord                (force standalone lockfile path; bypass MemPalace native coordinator)",
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
  const startTime = Date.now();
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env });

  // The plugin spawns this script with cwd=plugin install dir (for module/env
  // resolution); ESHEPHERD_PROJECT_ROOT is the actual consumer project, and
  // config/wing/room must resolve against THAT, not this script's own cwd.
  const configCwd = process.env.ESHEPHERD_PROJECT_ROOT || process.cwd();
  const runtimeConfig = loadRuntimeConfig({
    cwd: configCwd,
    env: process.env,
  });
  applyRuntimeConfigToEnv(process.env, runtimeConfig);

  // P2-1 + P2-3: generate run_id at startup
  const runId = "eshepherd-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 17) + "-" + Math.random().toString(36).slice(2, 6);

  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let consolidationCoordMode: ConsolidationCoordMode = "bypassed";

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

    const nativeCoordDisabled =
      isTruthyFlag(process.env.ESHEPHERD_CONSOLIDATION_NATIVE_COORD_DISABLED) || hasFlag(argv, "--no-native-coord");

    if (!nativeCoordDisabled) {
      const nativeLease = tryAcquireNativeConsolidationLease({
        projectRoot: lockRoot,
        runId,
        staleMs,
        env: process.env,
      });
      if (nativeLease.state === "acquired") {
        heldNativeConsolidationLease = { projectRoot: lockRoot, runId };
        consolidationCoordMode = "native-queue";
      } else if (nativeLease.state === "held") {
        process.stdout.write(
          `${JSON.stringify({ skipped: true, reason: "consolidation-native-coord-held", detail: nativeLease.reason }, null, 2)}\n`,
        );
        return;
      }
    }

    if (consolidationCoordMode !== "native-queue") {
      if (!acquireConsolidationLock(lockRoot, { source: "run-memory-consolidation-and-validation", runId }, staleMs)) {
        process.stdout.write(`${JSON.stringify({ skipped: true, reason: "consolidation-lock-held" }, null, 2)}\n`);
        return;
      }
      heldConsolidationLockRoot = lockRoot;
      consolidationCoordMode = "lockfile";
    }
  }

  const consolidationOptions = parseConsolidationOptions(argv);
  const validationOptions = parseValidationOptions(argv, consolidationOptions);
  const cadenceOptions = parseCadenceOptions(argv, consolidationOptions);
  const worklistOptions = parseWorklistOptions(argv);
  const memcoreApply = parseMemcoreApply(argv);

  const discoveredMCP = discoverLiveMCPConfig(process.env);
  if (!(process.env.MEMPALACE_MCP_BEARER_TOKEN || "").trim() && discoveredMCP?.bearerToken) {
    process.env.MEMPALACE_MCP_BEARER_TOKEN = discoveredMCP.bearerToken;
  }

  const mcpURL = (process.env.MEMPALACE_MCP_URL || discoveredMCP?.url || "http://localhost:8093/mcp").trim();
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
  const allSkipped: Array<{ drawer_id: string; reason: string }> = [];
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
    releaseHeldConsolidationGuards();
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
    releaseHeldConsolidationGuards();
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

      const { entries: rawEntries, skipped: chunkSkipped } = await ensureRawEntriesForChunk(client, chunk);
      if (chunkSkipped.length > 0) allSkipped.push(...chunkSkipped);
      const chunkConsolidation = await runSynthesisConsolidation(client, {
        ...consolidationOptions,
        mapperSummaries: chunkMapper && chunkMapper.summaries.length > 0 ? chunkMapper.summaries : undefined,
        rawEntries,
        runId,
      });
      // Record the chunk's result so downstream stages can see it. Without this
      // push, consolidationBatches stays empty: `consolidation` never gets set,
      // touchedNodeIds is empty so validation-merge-review is skipped, mem-core
      // apply is skipped (it is gated on `consolidation`), and the trace envelope
      // reports createdNodeCount: 0 even though closets were actually written.
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
      sourceDescriptions: Object.fromEntries(worklist.map((item) => [item.drawer_id, asString(item.desc)])),
      includeFacts: !isFalsyFlag(process.env.ESHEPHERD_MEMCORE_RENDER_INCLUDE_FACTS),
      includePointers: !isFalsyFlag(process.env.ESHEPHERD_MEMCORE_RENDER_INCLUDE_POINTERS),
      maxFactsPerSection: Number(process.env.ESHEPHERD_MEMCORE_RENDER_MAX_FACTS) || 8,
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

  // P2-1: trace envelope — wrap output with run metadata
  const durationMs = Date.now() - startTime;
  const examinedCount = worklist.length;
  const createdNodes = consolidationBatches.map((c) => c.createdNodeId).filter(Boolean) as string[];

  // P3-4: collect warnings for mapper/auditor fallbacks
  const traceWarnings: string[] = [];
  if (mapper && mapper.via === "none") traceWarnings.push("mapper-unavailable");
  if (auditor && auditor.via === "none") traceWarnings.push("auditor-unavailable");

  const output: Record<string, unknown> = {
    trace: {
      runId,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      pid: process.pid,
      examinedCount,
      createdNodeCount: createdNodes.length,
      createdNodeIds: createdNodes,
      consolidationBatchCount: consolidationBatches.length,
      skipped: allSkipped.length > 0 ? allSkipped : undefined,
      warnings: traceWarnings.length > 0 ? traceWarnings : undefined,
      consolidationCoordMode,
      mcpEndpointSource: (process.env.MEMPALACE_MCP_URL || "").trim()
        ? "env"
        : discoveredMCP
          ? "server-registry"
          : "default",
    },
    mode: includeBasePipeline ? "full-pipeline" : "cadence-only",
    worklistMode: worklistOptions.mode,
    worklist: worklistOutput,
  };

  // P2-1: write trace envelope to stdout
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  // P1-2: append run journal entry for crash-safe resume
  try {
    const journalRoot = process.env.ESHEPHERD_PROJECT_ROOT || process.cwd();
    const journalDir = join(journalRoot, ".electric-shepherd", "journal");
    mkdirSync(journalDir, { recursive: true });
    const journalPath = join(journalDir, `${runId}.jsonl`);
    const journalLine = JSON.stringify({
      runId,
      completedAt: new Date().toISOString(),
      durationMs,
      examinedCount,
      createdNodeIds: createdNodes,
      consolidationBatchCount: consolidationBatches.length,
    });
    appendFileSync(journalPath, `${journalLine}\n`, "utf8");
  } catch (err) {
    // Journal append failure is non-fatal; the stdout trace is the primary record
    process.stderr.write(`[memory-consolidation-validation] journal append failed: ${String(err)}\n`);
  }

  releaseHeldConsolidationGuards();
}

main().catch((err) => {
  releaseHeldConsolidationGuards();
  process.stderr.write(`[memory-consolidation-validation] ${String(err)}\n`);
  process.exit(1);
});
