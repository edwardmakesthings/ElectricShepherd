import { createMemgraphClient, type SourceDrawerWorkItem } from "../adapter/memgraph.ts";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../adapter/mcp-http-client.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
import { DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { parseDeadEndDrawerContent, renderDeadEndsBlock } from "../adapter/dead-ends.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";
import { acquireConsolidationLock, releaseConsolidationLock } from "./consolidation-lock.ts";

let activeRunId = "";

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

// Raw subagent stdout is written here when it cannot be parsed, so an unusable
// answer can be diagnosed without re-running a multi-minute mapper pass.
const SUBAGENT_DEBUG_DIR = ".electric-shepherd/scratch/subagent-output";

// Project root whose shared consolidation lock this process currently holds (null when it
// does not hold one, e.g. the lock was inherited from the spawning plugin). Used
// so both the success path and the top-level catch can release it.
let heldConsolidationLockRoot: string | null = null;
let heldNativeConsolidationLease: { projectRoot: string; runId: string } | null = null;
let configuredPythonBin = "python";
let configuredNativeCoordinatorPath = "";

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
  via: "opencode-run" | "none";
};

type AuditorEnvelope = {
  verdict: "pass" | "revise" | "escalate";
  findings: string[];
  recommendedActions: string[];
  raw: unknown;
  via: "opencode-run" | "none";
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
  sourceRoom: string;
  processedRoom: string;
  failedRoom: string;
  retryFailedOnly: boolean;
  moveAlreadyConsolidated: boolean;
};

type PromptModelRouting = {
  providerID: string;
  modelID: string;
};

type PromptRouting = {
  agent?: string;
  model?: PromptModelRouting;
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

function parsePositiveInt(value: unknown, fallback: number, min = 1): number {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function resolveConsolidationMCPURLs(baseURL: string): { readURL: string; writeURL: string } {
  const readURL = baseURL.trim();
  if (!readURL) return { readURL, writeURL: readURL };
  if (!/\/toolset\/thinking\/mcp\/?$/i.test(readURL)) return { readURL, writeURL: readURL };
  const writeURL = readURL.replace(/\/toolset\/thinking\/mcp\/?$/i, "/toolset/dreaming/mcp");
  return { readURL, writeURL };
}

const GRAPH_WRITE_TOOL_BASES = new Set([
  "apply_merge",
  "resolve_canonical",
  "kg_query",
  "get_height",
  "find_merge_candidates",
  "find_closet_lineage_issues",
  "update_drawer",
  "kg_add",
  "kg_invalidate",
]);

function isGraphWriteToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  for (const base of GRAPH_WRITE_TOOL_BASES) {
    if (normalized === base || normalized.endsWith(`_${base}`) || normalized.endsWith(`-${base}`)) return true;
  }
  return false;
}

function getActivePromptRoutingFromEnv(env: Record<string, string | undefined>): PromptRouting {
  const agent = (env.ESHEPHERD_ACTIVE_AGENT || "").trim() || undefined;
  const providerID = (env.ESHEPHERD_ACTIVE_MODEL_PROVIDER_ID || "").trim();
  const modelID = (env.ESHEPHERD_ACTIVE_MODEL_ID || "").trim();
  const model = providerID && modelID ? { providerID, modelID } : undefined;
  return { agent, model };
}

function formatPromptModelArg(model: PromptModelRouting | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.providerID},${model.modelID}`;
}

function parseMCPHttpOptions(config: Record<string, any>): {
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
} {
  return {
    requestTimeoutMs: parsePositiveInt(config.requestTimeoutMs, 60000),
    maxRetries: parsePositiveInt(config.maxRetries, 2, 0),
    retryBackoffMs: parsePositiveInt(config.retryBackoffMs, 800),
    retryMaxBackoffMs: parsePositiveInt(config.retryMaxBackoffMs, 8000),
  };
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

function resolveRunEventLogPath(): string {
  const projectRoot = process.env.ESHEPHERD_PROJECT_ROOT || process.cwd();
  return join(projectRoot, ".electric-shepherd", "consolidation-runs.ndjson");
}

function appendRunEvent(path: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
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
    // Mappers emit the agreed field names in whatever casing their prompt
    // template used — camelCase, snake_case, or UPPER_SNAKE. Match on the
    // letters only so casing and separators stop being a parse failure.
    const obj = asObject(item);
    const byNormalizedKey = new Map<string, unknown>();
    for (const [key, value] of Object.entries(obj)) {
      byNormalizedKey.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), value);
    }
    const field = (name: string): unknown => byNormalizedKey.get(name);

    const transcriptId = asString(field("transcriptid") ?? field("id")).trim();
    if (!transcriptId) continue;

    const pickList = (name: string): string[] =>
      asArray(field(name))
        .map((v) => asString(v).trim())
        .filter(Boolean);

    const confidenceRaw = asString(field("confidence")).trim().toLowerCase();
    const confidence =
      confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
        ? (confidenceRaw as "high" | "medium" | "low")
        : "low";

    out.push({
      transcriptId,
      confidence,
      durableFacts: pickList("durablefacts"),
      decisions: pickList("decisions"),
      rootCausesAndWorkedExamples: pickList("rootcausesandworkedexamples"),
      subsystemsAndFiles: pickList("subsystemsandfiles"),
      openItems: pickList("openitems"),
      // Phase 9 (negative knowledge): DEAD_ENDS lines flow through the same
      // normalization as every other section, so deadEnds / dead_ends / DEAD_ENDS
      // all collapse to `deadends`. Lines are kept verbatim — outcome-clause
      // validation happens at file/render time, not here.
      deadEnds: pickList("deadends"),
      rawExcerpt: asString(field("rawexcerpt")) || undefined,
    });
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Extract the agent's JSON answer from opencode stdout.
 *
 * `accept` is what makes this safe: subagent stdout is full of incidental JSON
 * (the turn-guard startup banner alone contains `["dreamer"]`), and any of it
 * can parse successfully *before* the real payload. Without a shape check the
 * first valid fragment wins and the answer is silently discarded.
 */
function parseEmbeddedJSON(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  // opencode writes ANSI-coloured chrome around the agent's answer. Those escape
  // sequences contain "[", which the bracket scan below would otherwise latch
  // onto instead of the real payload.
  const trimmed = text.replace(ANSI_ESCAPE_PATTERN, "").trim();
  if (!trimmed) return undefined;

  const tryParse = (candidate: string): { value: unknown } | undefined => {
    try {
      const value = JSON.parse(candidate);
      return accept(value) ? { value } : undefined;
    } catch {
      return undefined;
    }
  };

  const whole = tryParse(trimmed);
  if (whole) return whole.value;

  // Agents commonly wrap the answer in a ```json fence and follow it with prose.
  for (const match of trimmed.matchAll(FENCED_BLOCK_PATTERN)) {
    const body = (match[1] ?? "").trim();
    if (!body) continue;
    const fenced = tryParse(body);
    if (fenced) return fenced.value;
  }

  // Last resort: scan structural openers from the END backwards. The agent's
  // final answer is the last thing printed, while log chrome precedes it.
  for (let start = trimmed.length - 1; start >= 0; start -= 1) {
    const openChar = trimmed[start];
    if (openChar !== "[" && openChar !== "{") continue;
    const endChar = openChar === "[" ? "]" : "}";
    for (let end = trimmed.lastIndexOf(endChar); end > start; end = trimmed.lastIndexOf(endChar, end - 1)) {
      const scanned = tryParse(trimmed.slice(start, end + 1));
      if (scanned) return scanned.value;
    }
  }

  return undefined;
}

function runNativeCoordinator(
  args: string[],
  env: Record<string, string | undefined>,
  options?: { pythonBin?: string },
): Record<string, unknown> | undefined {
  if (!existsSync(NATIVE_COORD_HELPER_PATH)) return undefined;

  const pythonBin = String(options?.pythonBin || "python").trim() || "python";
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
  nativeCoordinatorPath?: string;
  pythonBin?: string;
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

  const queuePath = String(args.nativeCoordinatorPath || "").trim();
  if (queuePath) {
    cmdArgs.push("--queue-path", queuePath);
  }

  const payload = runNativeCoordinator(cmdArgs, args.env, { pythonBin: args.pythonBin });
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
  nativeCoordinatorPath?: string;
  pythonBin?: string;
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

  const queuePath = String(args.nativeCoordinatorPath || "").trim();
  if (queuePath) {
    cmdArgs.push("--queue-path", queuePath);
  }

  runNativeCoordinator(cmdArgs, args.env, { pythonBin: args.pythonBin });
}

function releaseHeldConsolidationGuards(): void {
  if (heldNativeConsolidationLease) {
    releaseNativeConsolidationLease({
      projectRoot: heldNativeConsolidationLease.projectRoot,
      runId: heldNativeConsolidationLease.runId,
      env: process.env,
      nativeCoordinatorPath: configuredNativeCoordinatorPath,
      pythonBin: configuredPythonBin,
    });
    heldNativeConsolidationLease = null;
  }
  if (heldConsolidationLockRoot) {
    releaseConsolidationLock(heldConsolidationLockRoot);
    heldConsolidationLockRoot = null;
  }
}

/**
 * Environment for one-shot subagent runs.
 *
 * These runs must be clean of external context: the mapper/auditor see only the
 * prompt we hand them. It is also what makes them terminate — mem-core
 * reinjection on idle injects a fresh user turn after every completed turn, so
 * a non-interactive `opencode run` never reaches a final state and dies on the
 * spawn timeout instead of returning output.
 */
function buildIsolatedSubagentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    // No external context injected into the subagent session.
    ESHEPHERD_MEMCORE_REINJECT_ENABLED: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_IDLE: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_START: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT: "false",
    // A consolidation run must not recursively trigger consolidation.
    ESHEPHERD_AUTO_CONSOLIDATION_ENABLED: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT: "false",
  };
}

function runSubagentViaOpenCode(args: {
  opencodeBin: string;
  agentName?: string;
  modelArg?: string;
  prompt: string;
  timeoutMs: number;
}): string {
  const commandArgs = ["run", args.prompt];
  if (args.agentName) {
    commandArgs.push("--agent", args.agentName);
  }
  if (args.modelArg) {
    commandArgs.push("--model", args.modelArg);
  }
  return execFileSync(args.opencodeBin, commandArgs, {
    encoding: "utf8",
    timeout: args.timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildIsolatedSubagentEnv(process.env),
  });
}

// A mapper pass reads every worklist drawer over MCP before it answers; a
// two-drawer batch measured ~250s, so 180s guaranteed a timeout kill on work
// that was progressing normally. Budget for real batches, not the empty case.
function resolveSubagentTimeoutMs(env: Record<string, string | undefined>): number {
  return parsePositiveInt(env.ESHEPHERD_SUBAGENT_TIMEOUT_MS, 900000, 1000);
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
  toolPrefix: string;
  mapperAgentName: string;
  activeModel?: PromptModelRouting;
  query: string;
  wing: string;
  room: string;
  worklistIds: string[];
  opencodeBin: string;
  timeoutMs: number;
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
    "{ transcriptId, confidence, durableFacts[], decisions[], rootCausesAndWorkedExamples[], subsystemsAndFiles[], openItems[], deadEnds[], rawExcerpt? }",
    "deadEnds[]: one line each for approaches TRIED AND FAILED or CONSIDERED AND REJECTED in this transcript, shaped `- <what was tried> | outcome: <what happened> | because: \"<why abandoned>\" | polarity: tried-failed|considered-rejected`. Each line MUST carry its outcome clause. Write an empty array when nothing qualifies — do not manufacture dead ends.",
  ].join("\n");

  try {
    const startedAt = Date.now();
    process.stderr.write(
      `[memory-consolidation-validation] mapper opencode-run start agent=${args.mapperAgentName} timeoutMs=${args.timeoutMs}\n`,
    );
    const output = runSubagentViaOpenCode({
      opencodeBin: args.opencodeBin,
      agentName: args.mapperAgentName,
      modelArg: formatPromptModelArg(args.activeModel),
      prompt: taskPrompt,
      timeoutMs: args.timeoutMs,
    });
    // Only accept a fragment that actually yields mapper summaries; incidental
    // JSON in the log chrome (e.g. `["dreamer"]`) parses fine but is not the answer.
    const parsedJSON = parseEmbeddedJSON(output, (value) => toSummaryFromRaw(value).length > 0);
    if (parsedJSON) {
      const summaries = toSummaryFromRaw(parsedJSON);
      if (summaries.length > 0) {
        process.stderr.write(
          `[memory-consolidation-validation] mapper opencode-run done summaries=${summaries.length} durationMs=${Date.now() - startedAt}\n`,
        );
        return { summaries, raw: output, via: "opencode-run" };
      }
    }
    // The mapper ran but we could not use its answer. Persist the raw stdout —
    // without it "mapper unavailable" is indistinguishable from a crash, and the
    // run costs minutes to reproduce.
    const debugPath = `${SUBAGENT_DEBUG_DIR}/mapper-${Date.now()}.txt`;
    try {
      mkdirSync(SUBAGENT_DEBUG_DIR, { recursive: true });
      writeFileSync(debugPath, output, "utf8");
      process.stderr.write(
        `[memory-consolidation-validation] mapper output unusable parsed=${parsedJSON ? "yes" : "no"} raw=${debugPath}\n`,
      );
    } catch {
      // Debug capture is best-effort.
    }
  } catch (err) {
    process.stderr.write(
      `[memory-consolidation-validation] mapper opencode-run failed err=${String(err)}\n`,
    );
  }

  process.stderr.write("[memory-consolidation-validation] mapper unavailable (no parseable opencode output)\n");

  return { summaries: [], raw: null, via: "none" };
}

async function callSubagentAuditor(args: {
  auditorAgentName: string;
  activeModel?: PromptModelRouting;
  consolidationResult: unknown;
  validationResult: unknown;
  opencodeBin: string;
  timeoutMs: number;
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
    const startedAt = Date.now();
    process.stderr.write(
      `[memory-consolidation-validation] auditor opencode-run start agent=${args.auditorAgentName} timeoutMs=${args.timeoutMs}\n`,
    );
    const output = runSubagentViaOpenCode({
      opencodeBin: args.opencodeBin,
      agentName: args.auditorAgentName,
      modelArg: formatPromptModelArg(args.activeModel),
      prompt: taskPrompt,
      timeoutMs: args.timeoutMs,
    });
    // Same trap as the mapper: require the fragment to carry a real verdict
    // rather than accepting the first parseable JSON in the log chrome.
    const parsed = asObject(
      parseEmbeddedJSON(output, (value) => {
        const candidate = asString(asObject(value).verdict).toLowerCase();
        return candidate === "pass" || candidate === "revise" || candidate === "escalate";
      }),
    );
    if (Object.keys(parsed).length > 0) {
      const parsedVerdict = asString(parsed.verdict).toLowerCase();
      if (parsedVerdict === "pass" || parsedVerdict === "revise" || parsedVerdict === "escalate") {
        verdict = parsedVerdict;
      }
      findings = asArray(parsed.findings).map((v) => asString(v)).filter(Boolean);
      recommendedActions = asArray(parsed.recommendedActions || parsed.recommended_actions)
        .map((v) => asString(v))
        .filter(Boolean);
      process.stderr.write(
        `[memory-consolidation-validation] auditor opencode-run done verdict=${verdict} findings=${findings.length} durationMs=${Date.now() - startedAt}\n`,
      );
      return { verdict, findings, recommendedActions, raw: output, via: "opencode-run" };
    }
  } catch (err) {
    process.stderr.write(
      `[memory-consolidation-validation] auditor opencode-run failed err=${String(err)}\n`,
    );
  }

  process.stderr.write("[memory-consolidation-validation] auditor unavailable (no parseable opencode output)\n");

  return {
    verdict: "escalate",
    findings: ["auditor output unavailable; no parseable subagent output"],
    recommendedActions: ["retry with --use-live-auditor after confirming agent output format"],
    raw: null,
    via: "none",
  };
}

function parseConsolidationOptions(argv: string[], runtimeConfig: ReturnType<typeof loadRuntimeConfig>): SynthesisConsolidationOptions {
  const runCadence = hasFlag(argv, "--run-cadence");

  const defaultSourceWing =
    String(runtimeConfig.valuesByPath.sourceCapture?.wing || runtimeConfig.valuesByPath.memory?.projectWing || "opencode").trim() ||
    "opencode";
  const defaultSourceRoom =
    String(runtimeConfig.valuesByPath.sourceCapture?.room || "source-transcripts").trim() ||
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
    searchLimit: Number(getArg(argv, "--search-limit") || runtimeConfig.valuesByPath.consolidation?.searchLimit || "12"),
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

function parseWorklistOptions(argv: string[], runtimeConfig: ReturnType<typeof loadRuntimeConfig>): WorklistOptions {
  const allMode = hasFlag(argv, "--all") || hasFlag(argv, "--full-scope") || hasFlag(argv, "--reprocess-all");
  const limit = Number(getArg(argv, "--worklist-limit") || getArg(argv, "--search-limit") || "200");
  // Default 1: one transcript family per subagent run. A single desktop runs one
  // agent at a time, so larger batches buy no parallelism -- they only widen the
  // blast radius, since a timeout loses the entire batch rather than one item.
  const batchSize = Math.max(1, Number(getArg(argv, "--batch-size") || "1"));
  const defaultSourceRoom =
    String(runtimeConfig.valuesByPath.sourceCapture?.room || "source-transcripts").trim() ||
    "source-transcripts";
  const scopeRoom = getArg(argv, "--room") || getArg(argv, "--target-room") || getArg(argv, "--scope-room") || defaultSourceRoom;
  const processedRoom = getArg(argv, "--processed-room") || `${scopeRoom}-processed`;
  const failedRoom = getArg(argv, "--failed-room") || `${scopeRoom}-failed`;
  const retryFailedOnly = hasFlag(argv, "--retry-failed-only");
  const moveAlreadyConsolidated = !hasFlag(argv, "--no-move-already-consolidated");
  return {
    mode: allMode ? "all" : "unconsolidated",
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200,
    batchSize,
    sourceRoom: scopeRoom,
    processedRoom,
    failedRoom,
    retryFailedOnly,
    moveAlreadyConsolidated,
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
  const seen = new Set<string>();
  for (const item of items) {
    const familyIds = getFamilyDrawerIds(item);
    for (const drawerId of familyIds) {
      if (seen.has(drawerId)) continue;
      seen.add(drawerId);

      const existing = drawerId === item.drawer_id ? asString(item.content).trim() : "";
      if (existing) {
        out.push({ id: drawerId, text: existing });
        continue;
      }
      try {
        const raw = await client.getDrawer({ drawer_id: drawerId });
        const parsed = parseDrawerPayload(raw);
        const text = asString(parsed?.content).trim();
        if (text) out.push({ id: drawerId, text });
        else skipped.push({ drawer_id: drawerId, reason: "empty-content" });
      } catch {
        // P3-3: record fetch failure instead of silently dropping
        skipped.push({ drawer_id: drawerId, reason: "drawer-fetch-failed" });
      }
    }
  }
  return { entries: out, skipped };
}

function getFamilyDrawerIds(item: SourceDrawerWorkItem): string[] {
  const family = asArray(item.family_drawer_ids)
    .map((value) => asString(value).trim())
    .filter(Boolean);
  if (family.length > 0) return [...new Set(family)];
  return [item.drawer_id];
}

async function moveDrawerFamily(
  client: ReturnType<typeof createMemgraphClient>,
  args: {
    item: SourceDrawerWorkItem;
    targetRoom: string;
    targetWing: string;
    applyWrites: boolean;
  },
): Promise<{ moved: string[]; attempted: string[]; errors: Array<{ drawer_id: string; error: string }> }> {
  const attempted = getFamilyDrawerIds(args.item);
  if (!args.applyWrites) return { moved: [], attempted, errors: [] };

  const moved: string[] = [];
  const errors: Array<{ drawer_id: string; error: string }> = [];
  for (const drawerId of attempted) {
    try {
      await client.updateDrawer({
        drawer_id: drawerId,
        wing: (args.item.wing || "").trim() || args.targetWing,
        room: args.targetRoom,
      });
      moved.push(drawerId);
    } catch (err) {
      errors.push({ drawer_id: drawerId, error: String(err) });
    }
  }

  return { moved, attempted, errors };
}

async function getConsolidatedIdsForFamily(
  client: ReturnType<typeof createMemgraphClient>,
  item: SourceDrawerWorkItem,
): Promise<{ consolidated: string[]; unconsolidated: string[] }> {
  const consolidated: string[] = [];
  const unconsolidated: string[] = [];
  for (const drawerId of getFamilyDrawerIds(item)) {
    try {
      if (await client.isSourceDrawerConsolidated(drawerId)) consolidated.push(drawerId);
      else unconsolidated.push(drawerId);
    } catch {
      unconsolidated.push(drawerId);
    }
  }
  return { consolidated, unconsolidated };
}

function parseValidationOptions(
  argv: string[],
  consolidation: SynthesisConsolidationOptions,
  runtimeConfig: ReturnType<typeof loadRuntimeConfig>,
): ValidationMergeReviewOptions {
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
    notificationURL: getArg(argv, "--ntfy-url") || String(runtimeConfig.valuesByPath.notifications?.ntfyUrl || ""),
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
    // Phase 16: calibration summary in the cadence envelope. --calibration-models a,b,c
    // (comma-separated canonical model ids) + optional --calibration-shapes s1,s2.
    ...(parseCalibrationOptions(argv) ? { calibration: parseCalibrationOptions(argv)! } : {}),
  };
}

function parseCalibrationOptions(argv: string[]): CadenceOrchestratorOptions["calibration"] | undefined {
  const modelsRaw = getArg(argv, "--calibration-models") || "";
  const models = modelsRaw.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) return undefined;
  const shapesRaw = getArg(argv, "--calibration-shapes") || "";
  const shapeKeys = shapesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const minSampleRaw = getArg(argv, "--calibration-min-sample") || "";
  const minSample = minSampleRaw ? Number(minSampleRaw) : undefined;
  return { models, ...(shapeKeys.length > 0 ? { shapeKeys } : {}), ...(minSample && Number.isFinite(minSample) ? { minSample } : {}) };
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

function discoverLiveMCPConfig(env: Record<string, string | undefined>, pythonBin: string): DiscoveredMCPConfig | undefined {
  if ((env.MEMPALACE_MCP_URL || "").trim()) return undefined;

  const resolvedPythonBin = String(pythonBin || "python").trim() || "python";
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
    const raw = execFileSync(resolvedPythonBin, ["-c", script], {
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
  if (looksLikeToolOutputFragment(text)) return fallback;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function normalizeSummaryLine(value: string): string {
  return asString(value).replace(/\s+/g, " ").trim();
}

function looksLikeToolOutputFragment(text: string): boolean {
  const line = normalizeSummaryLine(text);
  if (!line) return true;
  if (/^"(?:output|text)"\s*:/.test(line)) return true;
  if (/^\{\s*"(?:info|output|drawers|messages|tool|time)"\s*:/.test(line)) return true;
  if (/^\{b\[\d+:\d+\]\}/.test(line)) return true;
  if (/\b(nudge\s+\d+\/\d+\s+this\s+session)\b/i.test(line)) return true;
  if (line.includes('"id":"prt_') || line.includes('"sessionID":"ses_')) return true;
  if ((line.includes('\\n') || line.includes('\\"')) && line.includes("{") && line.includes("}")) return true;
  return false;
}

function factBullets(values: string[], max: number): string[] {
  const unique = [
    ...new Set(
      values
        .map((value) => normalizeSummaryLine(value))
        .filter(Boolean)
        .filter((value) => !looksLikeToolOutputFragment(value)),
    ),
  ];
  if (unique.length === 0) return ["- (none)"];
  const out = unique.slice(0, max).map((value) => `- ${value.length > 200 ? `${value.slice(0, 197)}...` : value}`);
  if (unique.length > max) out.push(`- ... (${unique.length - max} more; see pointers below)`);
  return out;
}

// Deterministic, idempotent fact source: real synthesis nodes (synthesized-from
// >= 2 distinct sources) scoped to a wing/room, filtered to height >= minHeight,
// ranked by height desc (tie-break connection_degree then retrieval_count), capped
// at `limit`. This replaces the raw per-drawer heuristic fallback for facts, which
// has height 0 (never synthesized) and is the source of garbled mem-core bullets.
async function fetchHighHeightFacts(
  client: ReturnType<typeof createMemgraphClient>,
  args: { wing: string; room: string; minHeight?: number; limit?: number },
): Promise<string[]> {
  const minHeight = Math.max(0, Number(args.minHeight) || 2);
  const limit = Math.max(1, Number(args.limit) || 8);
  try {
    const result = await client.listScopedDerivedDrawers({
      scope_wing: args.wing,
      scope_room: args.room,
      limit: 200,
    });
    const nodes = asArray((result as Record<string, unknown>).nodes) as Array<Record<string, unknown>>;
    const ranked = nodes
      .map((node) => ({
        text: normalizeSummaryLine(asString(node.desc || node.content)),
        height: Number(node.height) || 0,
        connectionDegree: Number(node.connection_degree) || 0,
        retrievalCount: Number(node.retrieval_count) || 0,
      }))
      .filter((node) => node.text && node.height >= minHeight && !looksLikeToolOutputFragment(node.text))
      .sort((a, b) => b.height - a.height || b.connectionDegree - a.connectionDegree || b.retrievalCount - a.retrievalCount);
    return [...new Set(ranked.map((node) => node.text))].slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Exported (not just module-local) so the [pending] block's cap/disable behavior
 * is unit-testable without running the whole pipeline — the render is on the hot
 * path of every prompt, and "every new mem-core render addition must be capped"
 * (spec L232-233) needs a test that pins the bound.
 */
export function buildMemcoreMarkdown(args: {
  query: string;
  consolidation: SynthesisConsolidationResult;
  validation: ValidationMergeReviewResult;
  auditor?: AuditorEnvelope;
  sourceDescriptions?: Record<string, string>;
  includeFacts?: boolean;
  includePointers?: boolean;
  maxFactsPerSection?: number;
  highHeightFacts?: string[];
  /** Phase 8: pre-matched pending-reminder bullets (see adapter/prospective.ts). */
  pendingReminderLines?: string[];
  includePending?: boolean;
  /** Phase 9: dead-end lines (tried-and-failed / considered-and-rejected approaches),
   * verbatim with outcome clauses. Rendered as a bounded [dead-ends] block via
   * renderDeadEndsBlock; an empty list omits the whole section. */
  deadEndLines?: string[];
  includeDeadEnds?: boolean;
  maxDeadEnds?: number;
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

  const highHeightFacts = args.highHeightFacts || [];
  const projectStateFacts = highHeightFacts.length > 0 ? highHeightFacts : args.consolidation.consolidationDraft.durableFacts || [];

  const lines: string[] = ["# Labeled memory blocks (always in context)", ""];

  if (includeFacts) {
    lines.push(
      "Facts below are resident: use them directly, no retrieval call needed.",
      "",
      "## [project-state]",
      `- Latest synthesis: ${draftTitle}`,
      ...factBullets(projectStateFacts, maxFacts),
      "",
      "## [active-conventions]",
      ...factBullets(args.consolidation.consolidationDraft.decisions || [], maxFacts),
      "",
      "## [open-items]",
      ...factBullets(args.consolidation.consolidationDraft.openItems || [], maxFacts),
      "",
    );

    // Phase 8 (prospective memory): the [pending] block. Reminders that fire in
    // this scope are pushed here by circumstance, not pulled by query — this
    // render is their only consumer. The lines arrive pre-matched and hard-capped
    // (adapter/prospective.ts renderPendingLines); an empty list omits the whole
    // section so there is no per-prompt tax when nothing is pending.
    if (args.includePending !== false && Array.isArray(args.pendingReminderLines) && args.pendingReminderLines.length > 0) {
      lines.push(...args.pendingReminderLines, "");
    }

    // Phase 9 (negative knowledge): the [dead-ends] block. Approaches that were tried
    // and failed or considered and rejected for this scope — every bullet carries the
    // hard "[RULED OUT ...]" marker via renderDeadEndsBlock (an unlabelled dead end
    // reads as a suggestion; the label is enforced at render, not left to inference).
    // Bounded like [pending]: capped at maxDeadEnds (default 3), and an empty list
    // omits the whole section so there is no per-prompt tax when nothing was ruled out.
    if (args.includeDeadEnds !== false && Array.isArray(args.deadEndLines) && args.deadEndLines.length > 0) {
      const maxDeadEnds = Math.max(0, Number(args.maxDeadEnds) || 3);
      const block = renderDeadEndsBlock(args.deadEndLines, maxDeadEnds);
      if (block.length > 0) lines.push(...block, "");
    }
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
    "  --use-live-mapper                (invoke dream-mapper via opencode run)",
    "  --mapper-agent <name>            (default: dream-mapper)",
    "  --all | --full-scope             (worklist mode: reprocess all source drawers in scope)",
    "  --room <room>                    (source room; default: ESHEPHERD_SOURCE_CAPTURE_ROOM or source-transcripts)",
    "  --retry-failed-only              (source room becomes <room>-failed or --failed-room)",
    "  --batch-size <n>                 (transcript families per subagent run; default: 1)",
    "  --worklist-limit <n>             (max source drawers enumerated; default: 200)",
    "  --processed-room <room>          (default: <room>-processed)",
    "  --failed-room <room>             (default: <room>-failed)",
    "  --no-move-already-consolidated   (do not auto-move already-consolidated sources)",
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
    "  --use-live-auditor               (invoke dream-auditor via opencode run)",
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

  const mcpAutoDiscover = !isFalsyFlag(String(runtimeConfig.valuesByPath.mcp?.autoDiscover));
  const pythonBin = String(runtimeConfig.valuesByPath.mcp?.pythonBin || "python").trim() || "python";
  const nativeCoordinatorPath = String(runtimeConfig.valuesByPath.consolidation?.lock?.nativeCoordinatorPath || "").trim();
  const worklistPageSize = parsePositiveInt(String(runtimeConfig.valuesByPath.consolidation?.worklist?.pageSize || ""), 50);
  const memcoreMinFactHeight = Number(runtimeConfig.valuesByPath.memcore?.render?.minFactHeight) || 2;
  configuredPythonBin = pythonBin;
  configuredNativeCoordinatorPath = nativeCoordinatorPath;

  // P2-1 + P2-3: generate run_id at startup
  const runId = "eshepherd-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 17) + "-" + Math.random().toString(36).slice(2, 6);

  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const runEventLogPath = resolveRunEventLogPath();
  activeRunId = runId;
  const runProgressState: Record<string, unknown> = {
    runId,
    status: "running",
    phase: "startup",
    startedAt: new Date(startTime).toISOString(),
    updatedAt: new Date().toISOString(),
    counters: {
      examinedCount: 0,
      processedCount: 0,
      failedCount: 0,
      errorCount: 0,
      createdNodeCount: 0,
      chunkIndex: 0,
      chunkTotal: 0,
    },
  };
  const flushRunProgress = (patch: Record<string, unknown> = {}, counterPatch?: Record<string, number>) => {
    const currentCounters = asObject(runProgressState.counters);
    if (counterPatch && Object.keys(counterPatch).length > 0) {
      runProgressState.counters = { ...currentCounters, ...counterPatch };
    }
    Object.assign(runProgressState, patch, { updatedAt: new Date().toISOString() });
    appendRunEvent(runEventLogPath, {
      ts: new Date().toISOString(),
      runId,
      event: "progress",
      status: runProgressState.status,
      phase: runProgressState.phase,
      counters: runProgressState.counters,
      ...(runProgressState.noWorkReason ? { noWorkReason: runProgressState.noWorkReason } : {}),
    });
  };
  appendRunEvent(runEventLogPath, {
    ts: new Date(startTime).toISOString(),
    runId,
    event: "start",
    mode: hasFlag(argv, "--run-cadence") ? "cadence" : "full-pipeline",
  });
  flushRunProgress({ phase: "lock-acquire" });

  let consolidationCoordMode: ConsolidationCoordMode = "bypassed";

  // Cross-process lock so a plugin-triggered run, a cron run, and an n8n run can
  // never overlap. The turn-guard plugin sets ESHEPHERD_CONSOLIDATION_LOCK_INHERITED when
  // it spawns us (it already holds the lock), so we skip acquire/release in that
  // case to avoid deadlocking against the parent. --no-lock /
  // ESHEPHERD_CONSOLIDATION_LOCK_DISABLED bypass it for tests.
  const lockInherited =
    isTruthyFlag(process.env.ESHEPHERD_CONSOLIDATION_LOCK_INHERITED) ||
    isTruthyFlag(runtimeConfig.valuesByPath.consolidation?.lock?.disabled) ||
    hasFlag(argv, "--no-lock");
  if (!lockInherited) {
    const staleMs = Number(runtimeConfig.valuesByPath.commands?.autoConsolidation?.timeoutMs) || 300000;
    const lockRoot = process.cwd();

    const nativeCoordDisabled =
      isTruthyFlag(runtimeConfig.valuesByPath.consolidation?.lock?.nativeCoordinatorDisabled) || hasFlag(argv, "--no-native-coord");

    if (!nativeCoordDisabled) {
      const nativeLease = tryAcquireNativeConsolidationLease({
        projectRoot: lockRoot,
        runId,
        staleMs,
        env: process.env,
        nativeCoordinatorPath,
        pythonBin,
      });
      if (nativeLease.state === "acquired") {
        heldNativeConsolidationLease = { projectRoot: lockRoot, runId };
        consolidationCoordMode = "native-queue";
      } else if (nativeLease.state === "held") {
        flushRunProgress({ status: "skipped", phase: "blocked-native-coordination", reason: "consolidation-native-coord-held" });
        process.stdout.write(
          `${JSON.stringify({ skipped: true, reason: "consolidation-native-coord-held", detail: nativeLease.reason }, null, 2)}\n`,
        );
        return;
      }
    }

    if (consolidationCoordMode !== "native-queue") {
      if (
        !acquireConsolidationLock(
          lockRoot,
          { source: "run-memory-consolidation-and-validation", runId },
          staleMs,
          {
            pythonBin,
            nativePidProbeDisabled: isTruthyFlag(String(runtimeConfig.valuesByPath.consolidation?.lock?.nativePidProbeDisabled)),
          },
        )
      ) {
        flushRunProgress({ status: "skipped", phase: "blocked-lock-held", reason: "consolidation-lock-held" });
        process.stdout.write(`${JSON.stringify({ skipped: true, reason: "consolidation-lock-held" }, null, 2)}\n`);
        return;
      }
      heldConsolidationLockRoot = lockRoot;
      consolidationCoordMode = "lockfile";
    }
  }

  const consolidationOptions = parseConsolidationOptions(argv, runtimeConfig);
  const validationOptions = parseValidationOptions(argv, consolidationOptions, runtimeConfig);
  const cadenceOptions = parseCadenceOptions(argv, consolidationOptions);
  const worklistOptions = parseWorklistOptions(argv, runtimeConfig);
  const memcoreApply = parseMemcoreApply(argv);

  const discoveredMCP = mcpAutoDiscover ? discoverLiveMCPConfig(process.env, pythonBin) : undefined;
  if (!(process.env.MEMPALACE_MCP_BEARER_TOKEN || "").trim() && discoveredMCP?.bearerToken) {
    process.env.MEMPALACE_MCP_BEARER_TOKEN = discoveredMCP.bearerToken;
  }

  const mcpURL = String(runtimeConfig.valuesByPath.mcp?.url || discoveredMCP?.url || DEFAULT_MCP_URL).trim();
  const { readURL: readMCPURL, writeURL: writeMCPURL } = resolveConsolidationMCPURLs(mcpURL);
  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  const mcpHeaders = resolveMCPHeadersFromEnv(process.env);
  const mcpHttpOptions = parseMCPHttpOptions((runtimeConfig.valuesByPath.mcp || {}) as Record<string, any>);
  const activeRouting = getActivePromptRoutingFromEnv(process.env);
  const subagentTimeoutMs = resolveSubagentTimeoutMs(process.env);

  const readMCP = new MCPHttpClient(readMCPURL, mcpHeaders, {
    clientName: "electric-shepherd-memory-system",
    requestTimeoutMs: mcpHttpOptions.requestTimeoutMs,
    maxRetries: mcpHttpOptions.maxRetries,
    retryBackoffMs: mcpHttpOptions.retryBackoffMs,
    retryMaxBackoffMs: mcpHttpOptions.retryMaxBackoffMs,
  });
  await readMCP.initialize();

  const writeMCP = writeMCPURL === readMCPURL
    ? readMCP
    : new MCPHttpClient(writeMCPURL, mcpHeaders, {
        clientName: "electric-shepherd-memory-system-write",
        requestTimeoutMs: mcpHttpOptions.requestTimeoutMs,
        maxRetries: mcpHttpOptions.maxRetries,
        retryBackoffMs: mcpHttpOptions.retryBackoffMs,
        retryMaxBackoffMs: mcpHttpOptions.retryMaxBackoffMs,
      });
  if (writeMCP !== readMCP) await writeMCP.initialize();

  const client = createMemgraphClient({
    callTool: (name, args) =>
      (isGraphWriteToolName(name) ? writeMCP : readMCP).callTool(name, args),
    toolPrefix,
  });

  const runCadence = hasFlag(argv, "--run-cadence");
  const includeBasePipeline = !runCadence || hasFlag(argv, "--include-base-pipeline");
  const opencodeBin = getArg(argv, "--opencode-bin") || "opencode";
  flushRunProgress({ phase: "discovering-worklist" });

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
    const sourceRoom = worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom;
    worklist = enumerateAll
      ? await client.listSourceDrawersByScope({
          wing: consolidationOptions.targetWing,
          room: sourceRoom,
          limit: worklistOptions.limit,
          pageSize: worklistPageSize,
        })
      : await client.findUnconsolidatedSourceDrawers({
          wing: consolidationOptions.targetWing,
          room: sourceRoom,
          limit: worklistOptions.limit,
          pageSize: worklistPageSize,
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
        : worklistOptions.retryFailedOnly
          ? "retry mode: unconsolidated source drawers selected from failed room"
          : "default mode: unconsolidated source drawers selected from source room"
      : "cadence-only run: base worklist pipeline not executed",
    sourceRoom: worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom,
    processedRoom: worklistOptions.processedRoom,
    failedRoom: worklistOptions.failedRoom,
    retryFailedOnly: worklistOptions.retryFailedOnly,
    moveAlreadyConsolidated: worklistOptions.moveAlreadyConsolidated,
    items: worklist.map((item) => ({
      drawer_id: item.drawer_id,
      wing: item.wing,
      room: item.room,
      desc: item.desc,
      filed_at: item.filed_at,
      source_file: item.source_file,
      added_by: item.added_by,
    })),
  };

  flushRunProgress(
    {
      phase: includeBasePipeline ? "consolidation" : "cadence-only",
      includeBasePipeline,
      worklistMode: worklistOptions.mode,
    },
    {
      examinedCount: worklist.length,
    },
  );

  if (includeBasePipeline) {
    const worklistChunks = chunkItems(worklist, worklistOptions.batchSize);
    const useLiveMapper = hasFlag(argv, "--use-live-mapper");
    const movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
    const movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
    const moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> = [];

    if (worklistChunks.length === 0) {
      // Even with no new source drawers selected, render mem-core from the
      // current synthesized memory state so refreshes are not blocked on
      // creating new closets.
      const emptyConsolidation = await runSynthesisConsolidation(client, {
        ...consolidationOptions,
        rawEntries: [],
        runId,
      });
      consolidationBatches.push(emptyConsolidation);
      flushRunProgress(
        {
          phase: "consolidation-empty-worklist",
          noWorkReason:
            worklistOptions.retryFailedOnly
              ? `no-items-in-${worklistOptions.failedRoom}`
              : `no-items-in-${worklistOptions.sourceRoom}`,
        },
        {
          chunkIndex: 0,
          chunkTotal: 0,
          createdNodeCount: consolidationBatches.map((c) => asString(c.createdNodeId).trim()).filter(Boolean).length,
        },
      );
    }


    for (const [chunkIndex, chunk] of worklistChunks.entries()) {
      flushRunProgress(
        {
          phase: "chunk-processing",
          currentChunk: chunkIndex + 1,
          totalChunks: worklistChunks.length,
          chunkItems: chunk.length,
        },
        {
          chunkIndex: chunkIndex + 1,
          chunkTotal: worklistChunks.length,
          processedCount: movedToProcessed.length,
          failedCount: movedToFailed.length,
          errorCount: moveErrors.length,
          createdNodeCount: consolidationBatches.map((c) => asString(c.createdNodeId).trim()).filter(Boolean).length,
        },
      );
      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} start (items=${chunk.length})\n`,
      );
      const actionable: SourceDrawerWorkItem[] = [];

      for (const item of chunk) {
        const consolidated = await getConsolidatedIdsForFamily(client, item);
        if (consolidated.unconsolidated.length === 0) {
          if (worklistOptions.moveAlreadyConsolidated) {
            const moveResult = await moveDrawerFamily(client, {
              item,
              targetRoom: worklistOptions.processedRoom,
              targetWing: consolidationOptions.targetWing,
              applyWrites: consolidationOptions.applyWrites,
            });
            movedToProcessed.push({
              drawer_id: item.drawer_id,
              family_drawer_ids: moveResult.attempted,
              reason: "already-consolidated",
            });
            moveErrors.push(
              ...moveResult.errors.map((entry) => ({
                drawer_id: entry.drawer_id,
                phase: "processed" as const,
                error: entry.error,
              })),
            );
          }
          continue;
        }
        actionable.push({
          ...item,
          family_drawer_ids: consolidated.unconsolidated,
        });
      }

      if (actionable.length === 0) continue;

      flushRunProgress({ phase: "chunk-actionable", actionableCount: actionable.length });

      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} actionable=${actionable.length}\n`,
      );

      let chunkMapper: MapperEnvelope | undefined;

      if (useLiveMapper) {
        chunkMapper = await callSubagentMapper({
          toolPrefix,
          mapperAgentName: getArg(argv, "--mapper-agent") || "dream-mapper",
          activeModel: activeRouting.model,
          query: consolidationOptions.query,
          wing: consolidationOptions.targetWing,
          room: worklistOptions.retryFailedOnly ? worklistOptions.failedRoom : worklistOptions.sourceRoom,
          worklistIds: actionable.map((item) => item.drawer_id),
          opencodeBin,
          timeoutMs: subagentTimeoutMs,
        });
        mapperBatches.push(chunkMapper);
      }

      const { entries: rawEntries, skipped: chunkSkipped } = await ensureRawEntriesForChunk(client, actionable);
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
      flushRunProgress(
        {
          phase: "chunk-consolidated",
          lastCreatedNodeId: asString(chunkConsolidation.createdNodeId).trim() || undefined,
        },
        {
          createdNodeCount: consolidationBatches.map((c) => asString(c.createdNodeId).trim()).filter(Boolean).length,
        },
      );
      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} consolidation createdNodeId=${asString(chunkConsolidation.createdNodeId).trim() || "<none>"}\n`,
      );

      if (!consolidationOptions.applyWrites) continue;

      const createdNodeId = asString(chunkConsolidation.createdNodeId).trim();
      if (!createdNodeId) {
        for (const item of actionable) {
          const moveResult = await moveDrawerFamily(client, {
            item,
            targetRoom: worklistOptions.failedRoom,
            targetWing: consolidationOptions.targetWing,
            applyWrites: true,
          });
          movedToFailed.push({ drawer_id: item.drawer_id, family_drawer_ids: moveResult.attempted, reason: "no-created-node" });
          moveErrors.push(
            ...moveResult.errors.map((entry) => ({
              drawer_id: entry.drawer_id,
              phase: "failed" as const,
              error: entry.error,
            })),
          );
        }
        process.stderr.write(
          `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} moved-to-failed=${actionable.length} reason=no-created-node\n`,
        );
        flushRunProgress(
          { phase: "chunk-move-failed-no-created-node" },
          {
            processedCount: movedToProcessed.length,
            failedCount: movedToFailed.length,
            errorCount: moveErrors.length,
          },
        );
        continue;
      }

      for (const item of actionable) {
        const consolidated = await getConsolidatedIdsForFamily(client, item);
        const targetRoom = consolidated.unconsolidated.length === 0 ? worklistOptions.processedRoom : worklistOptions.failedRoom;
        const phase = targetRoom === worklistOptions.processedRoom ? "processed" : "failed";
        const reason = phase === "processed" ? "edge-verified" : "missing-consolidated-edge";
        const moveResult = await moveDrawerFamily(client, {
          item,
          targetRoom,
          targetWing: consolidationOptions.targetWing,
          applyWrites: true,
        });
        if (phase === "processed") {
          movedToProcessed.push({ drawer_id: item.drawer_id, family_drawer_ids: moveResult.attempted, reason });
        } else {
          movedToFailed.push({ drawer_id: item.drawer_id, family_drawer_ids: moveResult.attempted, reason });
        }
        moveErrors.push(
          ...moveResult.errors.map((entry) => ({
            drawer_id: entry.drawer_id,
            phase: phase as "processed" | "failed",
            error: entry.error,
          })),
        );
      }
      process.stderr.write(
        `[memory-consolidation-validation] chunk ${chunkIndex + 1}/${worklistChunks.length} post-verify moves processed=${movedToProcessed.length} failed=${movedToFailed.length} errors=${moveErrors.length}\n`,
      );
      flushRunProgress(
        { phase: "chunk-post-verify" },
        {
          processedCount: movedToProcessed.length,
          failedCount: movedToFailed.length,
          errorCount: moveErrors.length,
        },
      );
    }

    if (consolidationBatches.length > 0) {
      consolidation = consolidationBatches[consolidationBatches.length - 1];
    }

    if (mapperBatches.length > 0) {
      const mergedSummaries = mapperBatches.flatMap((batch) => batch.summaries);
      mapper = {
        summaries: mergedSummaries,
        raw: mapperBatches.map((batch) => batch.raw),
        via: mapperBatches.some((batch) => batch.via === "opencode-run") ? "opencode-run" : "none",
      };
    }

    (worklistOutput as Record<string, unknown>).moves = {
      processed: movedToProcessed,
      failed: movedToFailed,
      errors: moveErrors.length > 0 ? moveErrors : undefined,
      applyWrites: consolidationOptions.applyWrites,
    };

    const touchedNodeIds = [...new Set(consolidationBatches.map((c) => c.createdNodeId).filter(Boolean))] as string[];
    flushRunProgress({ phase: "validation-merge-review", touchedNodeCount: touchedNodeIds.length });
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
      auditorAgentName: getArg(argv, "--auditor-agent") || "dream-auditor",
      activeModel: activeRouting.model,
      consolidationResult: consolidation,
      validationResult: validationMergeReview,
      opencodeBin,
      timeoutMs: subagentTimeoutMs,
    });
  }

  let memCoreApplyResult: Record<string, unknown> | undefined;
  if (memcoreApply.enabled && includeBasePipeline && consolidation) {
    flushRunProgress({ phase: "memcore-apply" });
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

    const highHeightFacts = await fetchHighHeightFacts(client, {
      wing: consolidationOptions.targetWing,
      room: consolidationOptions.targetRoom,
      minHeight: memcoreMinFactHeight,
      limit: Number(runtimeConfig.valuesByPath.memcore?.render?.maxFactsPerSection) || 8,
    });

    // Phase 8 (prospective memory): fetch live reminders for this wing, match
    // them against the scope being rendered, and pass capped [pending] lines to
    // the render. Bounded fetch (<= max), degrades to "no pending section" on any
    // read failure — the render must never throw or stall on the KG.
    let pendingReminderLines: string[] = [];
    if (!isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includePending))) {
      try {
        const maxPending = Math.max(0, Number(runtimeConfig.valuesByPath.memcore?.render?.maxPendingReminders) || 3);
        if (maxPending > 0 && typeof client.listReminders === "function") {
          const scopeDir = resolve(memcoreApply.scopeDir || process.cwd());
          const workspaceRoot = findWorkspaceRoot(scopeDir);
          const relScope = relative(workspaceRoot, scopeDir);
          // Broad-to-narrow ancestor chain of the rendered scope ("" = root),
          // mirroring the loader's buildScopeDirectories so a trigger on an
          // ancestor path fires for every directory beneath it.
          const relScopes: string[] = [];
          let current = relScope;
          while (true) {
            relScopes.push(current === "." ? "" : current);
            if (!current || current === ".") break;
            const parent = dirname(current);
            if (parent === current || parent === ".") break;
            current = parent;
          }
          const reminders = await client.listReminders({
            wing: consolidationOptions.targetWing,
            limit: Math.min(50, Math.max(maxPending * 3, 12)),
          });
          const { matchRemindersForScope, renderPendingLines } = await import("../adapter/prospective.ts");
          const matches = matchRemindersForScope(
            reminders.map((reminder) => ({ ...reminder, status: String(reminder.status || "active") as "active" | "satisfied" | "expired" })),
            {
              relScopes,
              wing: consolidationOptions.targetWing,
              room: consolidationOptions.targetRoom,
              query: consolidation.query,
            },
          );
          pendingReminderLines = renderPendingLines(matches, maxPending);
        }
      } catch (err) {
        // Degrade gracefully: a reminder read failure costs the pending section,
        // never the whole render.
        process.stderr.write(`[memory-consolidation-validation] pending-reminder fetch failed: ${String(err)}\n`);
        pendingReminderLines = [];
      }
    }

    // Phase 9 (negative knowledge): dead-end lines for the [dead-ends] block. Primary
    // source is THIS run's consolidation draft (the mapper just extracted them, outcome
    // clauses included) — cheap and already in hand. When the draft has none, fall back
    // to a bounded read of recently-filed dead-end drawers (synthesis-stamped nodes with
    // an outgoing rules-out edge) so a run with no fresh dead ends still surfaces the
    // ones on file for this scope. Bounded by construction (one page, ≤ maxDeadEnds*3),
    // degrades to "no dead-ends section" on any read failure — the render must never
    // throw or stall on the KG.
    let deadEndLines: string[] = [...(consolidation.consolidationDraft.deadEnds || [])];
    if (deadEndLines.length === 0 && !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includeDeadEnds))) {
      try {
        const maxDeadEnds = Math.max(0, Number(runtimeConfig.valuesByPath.memcore?.render?.maxDeadEnds) || 3);
        if (maxDeadEnds > 0 && typeof client.listScopedDerivedDrawers === "function" && typeof client.getRulesOut === "function") {
          const scopeResult = await client.listScopedDerivedDrawers({
            scope_wing: consolidationOptions.targetWing,
            scope_room: consolidationOptions.targetRoom,
            limit: Math.min(50, maxDeadEnds * 3),
          });
          const nodes = asArray((scopeResult as Record<string, unknown>).nodes) as Array<Record<string, unknown>>;
          for (const node of nodes) {
            if (deadEndLines.length >= maxDeadEnds) break;
            const nodeId = asString(node.node_id || node.drawer_id || node.id).trim();
            if (!nodeId) continue;
            const rulesOut = await client.getRulesOut(nodeId).catch(() => ({ statements: [] as string[], polarities: [] as string[] }));
            if (rulesOut.statements.length === 0) continue; // not a dead end
            const drawer = await client.getDrawer({ drawer_id: nodeId }).catch(() => ({}));
            const content = asString((drawer as Record<string, unknown>).content || (drawer as Record<string, unknown>).text).trim();
            const lines = parseDeadEndDrawerContent(content);
            for (const line of lines) {
              if (deadEndLines.length >= maxDeadEnds * 3) break;
              deadEndLines.push(line);
            }
          }
        }
      } catch (err) {
        // Degrade gracefully: a dead-end read failure costs the section, never the render.
        process.stderr.write(`[memory-consolidation-validation] dead-end fetch failed: ${String(err)}\n`);
        deadEndLines = [];
      }
    }

    const markdown = buildMemcoreMarkdown({
      query: consolidation.query,
      consolidation,
      validation: validationForRender,
      auditor,
      sourceDescriptions: Object.fromEntries(worklist.map((item) => [item.drawer_id, asString(item.desc)])),
      includeFacts: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includeFacts)),
      includePointers: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includePointers)),
      maxFactsPerSection: Number(runtimeConfig.valuesByPath.memcore?.render?.maxFactsPerSection) || 8,
      highHeightFacts,
      pendingReminderLines,
      includePending: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includePending)),
      deadEndLines,
      includeDeadEnds: !isFalsyFlag(String(runtimeConfig.valuesByPath.memcore?.render?.includeDeadEnds)),
      maxDeadEnds: Number(runtimeConfig.valuesByPath.memcore?.render?.maxDeadEnds) || 3,
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
      mcpEndpointSource: String(runtimeConfig.valuesByPath.mcp?.url || "").trim()
        ? "env"
        : discoveredMCP
          ? "server-registry"
          : "default",
    },
    mode: includeBasePipeline ? "full-pipeline" : "cadence-only",
    worklistMode: worklistOptions.mode,
    worklist: worklistOutput,
    // Phase 16: confidence-calibration tables (per model) — surfaced when the cadence
    // run was asked for them via --calibration-models. Absent otherwise (backward-compat).
    ...(cadence?.calibration ? { calibration: cadence.calibration } : {}),
  };

  // P2-1: write trace envelope to stdout
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const moveSummary = asObject((worklistOutput as Record<string, unknown>).moves);
  flushRunProgress(
    {
      status: "completed",
      phase: "completed",
      completedAt: new Date().toISOString(),
      durationMs,
    },
    {
      examinedCount,
      processedCount: asArray(moveSummary.processed).length,
      failedCount: asArray(moveSummary.failed).length,
      createdNodeCount: createdNodes.length,
    },
  );
  appendRunEvent(runEventLogPath, {
    ts: new Date().toISOString(),
    runId,
    event: "finish",
    status: "completed",
    durationMs,
    examinedCount,
    createdNodeCount: createdNodes.length,
  });

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
  activeRunId = "";
}

main().catch((err) => {
  try {
    appendRunEvent(resolveRunEventLogPath(), {
      ts: new Date().toISOString(),
      runId: activeRunId || undefined,
      event: "finish",
      status: "failed",
      error: String(err),
    });
  } catch {
    // best-effort
  }
  releaseHeldConsolidationGuards();
  process.stderr.write(`[memory-consolidation-validation] ${String(err)}\n`);
  process.exit(1);
});
