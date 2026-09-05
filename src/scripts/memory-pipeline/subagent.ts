/**
 * Subagent invocation helpers (mapper + auditor) for the consolidation pipeline.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { TranscriptInsightSummary } from "../../capability/episodic/synthesis-consolidation.ts";
import { asObject, asArray, asString, parsePositiveInt } from "./cli-options.ts";
import type { PromptModelRouting } from "./runtime-utils.ts";

export type MapperEnvelope = {
  summaries: TranscriptInsightSummary[];
  raw: unknown;
  via: "opencode-run" | "none";
};

export type AuditorEnvelope = {
  verdict: "pass" | "revise" | "escalate";
  findings: string[];
  recommendedActions: string[];
  raw: unknown;
  via: "opencode-run" | "none";
};

export type { PromptModelRouting } from "./runtime-utils.ts";

// Raw subagent stdout is written here when it cannot be parsed, so an unusable
// answer can be diagnosed without re-running a multi-minute mapper pass.
const SUBAGENT_DEBUG_DIR = ".electric-shepherd/scratch/subagent-output";

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/g;

export function formatPromptModelArg(model: PromptModelRouting | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.providerID},${model.modelID}`;
}

export function parseEmbeddedJSON(text: string, accept: (value: unknown) => boolean = () => true): unknown {
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

  for (const match of trimmed.matchAll(FENCED_BLOCK_PATTERN)) {
    const body = (match[1] ?? "").trim();
    if (!body) continue;
    const fenced = tryParse(body);
    if (fenced) return fenced.value;
  }

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

export function toSummaryFromRaw(raw: unknown): TranscriptInsightSummary[] {
  const out: TranscriptInsightSummary[] = [];
  const arr = asArray(raw);
  for (const item of arr) {
    const obj = asObject(item);
    const byNormalizedKey = new Map<string, unknown>();
    for (const [key, value] of Object.entries(obj)) {
      byNormalizedKey.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), value);
    }
    const field = (name: string): unknown => byNormalizedKey.get(name);

    const transcriptId = asString(field("transcriptid") ?? field("id")).trim();
    if (!transcriptId) continue;

    const pickList = (name: string): string[] =>
      asArray(field(name)).map((v) => asString(v).trim()).filter(Boolean);

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
      deadEnds: pickList("deadends"),
      rawExcerpt: asString(field("rawexcerpt")) || undefined,
    });
  }
  return out;
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
export function buildIsolatedSubagentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ESHEPHERD_MEMCORE_REINJECT_ENABLED: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_IDLE: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_START: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ENABLED: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT: "false",
  };
}

export function runSubagentViaOpenCode(args: {
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
export function resolveSubagentTimeoutMs(env: Record<string, string | undefined>): number {
  return parsePositiveInt(env.ESHEPHERD_SUBAGENT_TIMEOUT_MS, 900000, 1000);
}

export async function callSubagentMapper(args: {
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

export async function callSubagentAuditor(args: {
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

  process.stderr.write("[memory-consolidation-validation] auditor unavailable (no parseable subagent output)\n");

  return {
    verdict: "escalate",
    findings: ["auditor output unavailable; no parseable subagent output"],
    recommendedActions: ["retry with --use-live-auditor after confirming agent output format"],
    raw: null,
    via: "none",
  };
}
