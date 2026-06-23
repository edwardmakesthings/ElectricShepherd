import { createMemgraphClient, type JsonMap } from "../adapter/memgraph.ts";
// @ts-expect-error runtime script package does not include node typings
import { execFileSync } from "node:child_process";
// @ts-expect-error runtime script package does not include node typings
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
  exit: (code: number) => never;
};

type MCPMessage = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type MCPResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

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

class MCPHttpClient {
  private url: string;
  private sessionId: string | null;
  private idCounter: number;
  private staticHeaders: Record<string, string>;

  constructor(url: string, staticHeaders: Record<string, string> = {}) {
    this.url = url;
    this.sessionId = null;
    this.idCounter = 0;
    this.staticHeaders = staticHeaders;
  }

  private nextID(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private parseResponsePayload(raw: string): MCPResponse {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Empty MCP response");
    }
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed) as MCPResponse;
    }

    let lastData: string | null = null;
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const clean = line.trim();
      if (clean.startsWith("data:")) {
        lastData = clean.slice(5).trim();
      }
    }
    if (!lastData) {
      throw new Error(`Unable to parse MCP response: ${trimmed.slice(0, 200)}`);
    }
    return JSON.parse(lastData) as MCPResponse;
  }

  private async post(payload: MCPMessage): Promise<MCPResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.staticHeaders,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const sessionHeader = response.headers.get("Mcp-Session-Id");
    if (sessionHeader) {
      this.sessionId = sessionHeader;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return this.parseResponsePayload(text);
  }

  async initialize(): Promise<void> {
    const init: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "electric-shepherd-memory-system", version: "0.1.0" },
      },
    };

    const response = await this.post(init);
    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    const notify: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "notifications/initialized",
      params: {},
    };
    await this.post(notify).catch(() => {
      // Some MCP servers reject this style; safe to ignore.
    });
  }

  async callTool(name: string, args?: JsonMap): Promise<JsonMap> {
    const payload: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "tools/call",
      params: { name, arguments: args || {} },
    };

    const response = await this.post(payload);
    if (response.error) {
      throw new Error(`Tool call failed (${name}): ${response.error.message}`);
    }

    const result = response.result || {};
    const content = (result.content || []) as Array<Record<string, unknown>>;

    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          return JSON.parse(item.text) as JsonMap;
        } catch {
          // Continue to fallback.
        }
      }
    }

    return result as JsonMap;
  }
}

function resolveMCPHeadersFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};

  const hasHeader = (name: string): boolean =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

  const rawHeadersJSON = (env.MEMPALACE_MCP_HEADERS_JSON || "").trim();
  if (rawHeadersJSON) {
    try {
      const parsed = JSON.parse(rawHeadersJSON) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed || {})) {
        if (typeof value === "string" && key) {
          headers[key] = value;
        }
      }
    } catch {
      // Ignore malformed override headers and keep known-safe defaults.
    }
  }

  const rawBearerToken = (env.MEMPALACE_MCP_BEARER_TOKEN || "").trim();
  if (rawBearerToken && !hasHeader("Authorization")) {
    headers.Authorization = /^Bearer\s+/i.test(rawBearerToken)
      ? rawBearerToken
      : `Bearer ${rawBearerToken}`;
  }

  const rawAPIKey = (env.MEMPALACE_MCP_API_KEY || "").trim();

  const authHeader = (env.MEMPALACE_MCP_AUTH_HEADER || "Authorization").trim();
  const authScheme = (env.MEMPALACE_MCP_AUTH_SCHEME || "").trim();
  const resolvedHeaderName = authHeader || "Authorization";

  if (rawAPIKey && !hasHeader(resolvedHeaderName)) {
    let authValue = rawAPIKey;
    if (authScheme) {
      authValue = authScheme.toLowerCase() === "none" ? rawAPIKey : `${authScheme} ${rawAPIKey}`;
    } else if (resolvedHeaderName.toLowerCase() === "authorization") {
      authValue = /^[A-Za-z][A-Za-z0-9_-]*\s+/.test(rawAPIKey)
        ? rawAPIKey
        : `Bearer ${rawAPIKey}`;
    }
    headers[resolvedHeaderName] = authValue;
  }

  return headers;
}

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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
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
  const candidates = [configured, resolve("eshepherd/memory"), resolve("memory")].filter(Boolean) as string[];
  const existing = candidates.find((dir) => existsSync(dir));
  const base = existing || resolve("eshepherd/memory");

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
  limit: number;
  opencodeBin: string;
}): Promise<MapperEnvelope> {
  const searchTool = `${args.toolPrefix}search`;
  const taskPrompt = [
    "Read relevant transcript memory and produce mapper summaries as JSON array.",
    `Use tool: ${searchTool} with query='${args.query}', wing='${args.wing}', room='${args.room}', limit=${args.limit}.`,
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
    "Audit synthesis consolidation and validation outputs.",
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

  let query = getArg(argv, "--query") || "";
  let targetWing = getArg(argv, "--wing") || getArg(argv, "--target-wing") || "";
  let targetRoom = getArg(argv, "--room") || getArg(argv, "--target-room") || "";

  if ((!query || !targetWing || !targetRoom) && runCadence) {
    query = query || "memory consolidation candidates";
    targetWing = targetWing || "context-blocks";
    targetRoom = targetRoom || "context-blocks";
  }

  if (!query || !targetWing || !targetRoom) {
    throw new Error("Consolidation requires --query, --wing/--target-wing, --room/--target-room");
  }

  const mapperSummaries = parseMapperSummariesFromFile(getArg(argv, "--mapper-summaries-file"));

  return {
    query,
    targetWing,
    targetRoom,
    searchLimit: Number(getArg(argv, "--search-limit") || "12"),
    minimumDistinctSources: Number(getArg(argv, "--min-sources") || "2"),
    minimumContentCharacters: Number(getArg(argv, "--min-content-chars") || "220"),
    minimumPopulatedSections: Number(getArg(argv, "--min-section-count") || "3"),
    minimumMapperConfidence: (getArg(argv, "--mapper-confidence-floor") as "high" | "medium" | "low" | undefined) || "medium",
    labels: parseCSV(getArg(argv, "--labels")),
    applyWrites: hasFlag(argv, "--apply"),
    mapperSummaries,
  };
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
    `- Latest synthesis title: ${args.consolidation.synthesisDraft.title}`,
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
    "  node scripts/run-memory-consolidation-and-validation.ts --query <text> --wing <wing> --room <room> [flags]",
    "",
    "Synthesis Consolidation flags:",
    "  --search-limit <n>",
    "  --min-sources <n>",
    "  --min-content-chars <n>",
    "  --min-section-count <n>",
    "  --mapper-confidence-floor <high|medium|low>",
    "  --mapper-summaries-file <path-to-json-array>",
    "  --use-live-mapper                (invoke dream-mapper via task tool)",
    "  --mapper-agent <name>            (default: dream-mapper)",
    "  --labels <csv>",
    "  --apply                          (creates synthesis node if checks pass)",
    "",
    "Validation + Merge Review flags:",
    "  --scope-room <room>",
    "  --scope-wing <wing>",
    "  --validation-depth <n>",
    "  --validation-limit <n>",
    "  --merge-threshold <float>",
    "  --merge-limit <n>",
    "  --allow-auto-merge-score <float>",
    "  --apply-merges                   (applies auto-merge decisions)",
    "  --ntfy-url <url>",
    "  --escalation-topic <topic>",
    "  --use-live-auditor               (invoke dream-auditor via task tool)",
    "  --auditor-agent <name>           (default: dream-auditor)",
    "",
    "Mem-core apply flags:",
    "  --apply-mem-core                 (legacy explicit flag; mem-core auto write is on by default)",
    "  --no-mem-core-auto               (disable automatic mem-core file output)",
    "  --mem-core-dir <path>            (base dir; default: ./eshepherd/memory or ./memory)",
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
    "  JSON envelope: { consolidation, validationMergeReview, mapper?, auditor?, memCoreApply?, cadence?, cadenceState? }",
  ].join("\n");
}

async function main(): Promise<void> {
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env });

  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const consolidationOptions = parseConsolidationOptions(argv);
  const validationOptions = parseValidationOptions(argv, consolidationOptions);
  const cadenceOptions = parseCadenceOptions(argv, consolidationOptions);
  const memcoreApply = parseMemcoreApply(argv);

  const mcpURL = process.env.MEMPALACE_MCP_URL || "http://localhost:8093/mcp";
  const toolPrefix = process.env.MEMGRAPH_TOOL_PREFIX || "mempalace_";
  const mcpHeaders = resolveMCPHeadersFromEnv(process.env);

  const mcp = new MCPHttpClient(mcpURL, mcpHeaders);
  await mcp.initialize();

  const client = createMemgraphClient({
    callTool: (name, args) => mcp.callTool(name, args),
    toolPrefix,
  });

  const runCadence = hasFlag(argv, "--run-cadence");
  const includeBasePipeline = !runCadence || hasFlag(argv, "--include-base-pipeline");
  const opencodeBin = getArg(argv, "--opencode-bin") || "opencode";

  let mapper: MapperEnvelope | undefined;
  let consolidation: SynthesisConsolidationResult | undefined;
  let validationMergeReview: ValidationMergeReviewResult | undefined;

  if (includeBasePipeline && hasFlag(argv, "--use-live-mapper")) {
    mapper = await callSubagentMapper({
      mcp,
      toolPrefix,
      mapperAgentName: getArg(argv, "--mapper-agent") || "dream-mapper",
      query: consolidationOptions.query,
      wing: consolidationOptions.targetWing,
      room: consolidationOptions.targetRoom,
      limit: consolidationOptions.searchLimit || 12,
      opencodeBin,
    });
    if (mapper.summaries.length > 0) {
      consolidationOptions.mapperSummaries = mapper.summaries;
    }
  }

  if (includeBasePipeline) {
    consolidation = await runSynthesisConsolidation(client, consolidationOptions);
    validationMergeReview = await runValidationMergeReview(client, validationOptions);
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
  if (memcoreApply.enabled && includeBasePipeline && consolidation && validationMergeReview) {
    const markdown = buildMemcoreMarkdown({
      query: consolidation.query,
      consolidation,
      validation: validationMergeReview,
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
      reason: "missing consolidation/validation outputs",
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
  };

  if (consolidation) output.consolidation = consolidation;
  if (validationMergeReview) output.validationMergeReview = validationMergeReview;

  if (mapper) output.mapper = mapper;
  if (auditor) output.auditor = auditor;
  if (memCoreApplyResult) output.memCoreApply = memCoreApplyResult;
  if (cadence) output.cadence = cadence;
  if (cadenceStateOut) output.cadenceState = cadenceStateOut;

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[memory-consolidation-validation] ${String(err)}\n`);
  process.exit(1);
});
