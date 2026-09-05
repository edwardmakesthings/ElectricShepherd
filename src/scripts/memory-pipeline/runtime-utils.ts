import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type PromptModelRouting = {
  providerID: string;
  modelID: string;
};

export type PromptRouting = {
  agent?: string;
  model?: PromptModelRouting;
};

export function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isFalsyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export function getActivePromptRoutingFromEnv(env: Record<string, string | undefined>): PromptRouting {
  const agent = (env.ESHEPHERD_ACTIVE_AGENT || "").trim() || undefined;
  const providerID = (env.ESHEPHERD_ACTIVE_MODEL_PROVIDER_ID || "").trim();
  const modelID = (env.ESHEPHERD_ACTIVE_MODEL_ID || "").trim();
  const model = providerID && modelID ? { providerID, modelID } : undefined;
  return { agent, model };
}

export function parseMCPHttpOptions(config: Record<string, any>, parsePositiveInt: (value: unknown, fallback: number, min?: number) => number): {
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

export function tryWriteFile(path: string, content: string, pid: number): void {
  const { writeFileSync: wf, renameSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${pid}.tmp`;
  wf(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

export function resolveRunEventLogPath(env: Record<string, string | undefined>, cwd: string): string {
  const projectRoot = env.ESHEPHERD_PROJECT_ROOT || cwd;
  return join(projectRoot, ".electric-shepherd", "consolidation-runs.ndjson");
}

export function appendRunEvent(path: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function resolveConsolidationMCPURLs(baseURL: string): { readURL: string; writeURL: string } {
  const readURL = baseURL.trim();
  if (!readURL) return { readURL, writeURL: readURL };
  if (!/\/toolset\/thinking\/mcp\/?$/i.test(readURL)) return { readURL, writeURL: readURL };
  const writeURL = readURL.replace(/\/toolset\/thinking\/mcp\/?$/i, "/toolset/dreaming/mcp");
  return { readURL, writeURL };
}

export function appendRunJournalEntry(args: {
  env: Record<string, string | undefined>;
  cwd: string;
  runId: string;
  completedAt: string;
  durationMs: number;
  examinedCount: number;
  createdNodeIds: string[];
  consolidationBatchCount: number;
}): void {
  const journalRoot = args.env.ESHEPHERD_PROJECT_ROOT || args.cwd;
  const journalDir = join(journalRoot, ".electric-shepherd", "journal");
  mkdirSync(journalDir, { recursive: true });
  const journalPath = join(journalDir, `${args.runId}.jsonl`);
  const journalLine = JSON.stringify({
    runId: args.runId,
    completedAt: args.completedAt,
    durationMs: args.durationMs,
    examinedCount: args.examinedCount,
    createdNodeIds: args.createdNodeIds,
    consolidationBatchCount: args.consolidationBatchCount,
  });
  appendFileSync(journalPath, `${journalLine}\n`, "utf8");
}
