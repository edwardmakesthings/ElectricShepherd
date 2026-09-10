/**
 * `before_agent_start` context injection for oh-my-pi.
 *
 * omp fires this once per user prompt, before the agent loop starts, and hands
 * over both the prompt text and the turn's system prompt. That is the seam the
 * OpenCode surface never had: it could only inject a synthetic conversation turn
 * after the fact, keyed on the previous turn rather than the actual request. Here
 * the memory block is appended to the SYSTEM prompt (leaving the conversation
 * prefix — and its provider-side cache — untouched) and the worked-example query
 * is keyed on what the user actually asked.
 *
 * Two independently gated blocks:
 *   - mem-core   (`memcore.reinject.enabled`)   — scoped memory.md files, read in
 *     process. OpenCode shelled out to run-mem-core-loader.ts under a timeout.
 *   - worked examples (`taskWatchdog.workedExampleInjection.enabled`) — MemPalace
 *     retrieval over the prompt.
 *
 * Injection is best-effort by design: a slow or unreachable palace must never
 * block the turn, so every failure degrades to "inject nothing" with a logged
 * reason rather than throwing into the agent loop.
 */

import { loadMemcoreForDirectory } from "../../capability/memcore/mem-core-loader.ts";
import { createMemgraphClient } from "../../core/memgraph.ts";
import { resolveMCPHeadersFromEnv } from "../../core/mcp-transport.ts";
import {
  DEFAULT_MCP_TOOL_PREFIX,
  DEFAULT_MCP_URL,
  getRuntimeConfigEnvMap,
  loadRuntimeConfig,
} from "../../core/runtime-config.ts";
import { createSubstrateClient } from "../../core/substrate-client.ts";
import {
  formatWorkedExampleDemonstration,
  retrieveSimilarWorkedExamples,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_RELEVANCE_FLOOR,
} from "../../policy/retrieval.ts";
import { loadRuntimeEnv } from "../../scripts/runtime-env.ts";
import type { OmpBeforeAgentStartEvent, OmpExtensionApi, OmpExtensionContext } from "./api.ts";

const MEMCORE_HEADING = "## Mem-core: durable state for this project";

type Env = Record<string, string | undefined>;

function isTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toList(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function warn(pi: OmpExtensionApi, message: string): void {
  if (pi.logger) pi.logger.warn(`[electric-shepherd] ${message}`);
  else console.warn(`[electric-shepherd] ${message}`);
}

/** Scoped memory.md files, broad scope to narrow, capped at the configured budget. */
function buildMemcoreBlock(env: Env, cwd: string): string | undefined {
  const loaded = loadMemcoreForDirectory({
    startDir: cwd,
    directFileName: env.ESHEPHERD_MEMCORE_DIRECT_FILE,
    storeRoots: toList(env.ESHEPHERD_MEMCORE_STORE_ROOTS),
    maxScopes: toNumber(env.ESHEPHERD_MEMCORE_MAX_SCOPES, 6),
  });
  const merged = loaded.mergedMarkdown.trim();
  if (!merged) return undefined;

  const maxChars = toNumber(env.ESHEPHERD_MEMCORE_MAX_CHARS, 12000);
  const body = merged.length > maxChars ? `${merged.slice(0, maxChars)}\n\n[truncated]` : merged;
  return `${MEMCORE_HEADING}\n\n${body}`;
}

async function buildWorkedExampleBlock(
  pi: OmpExtensionApi,
  env: Env,
  prompt: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const url = String(env.MEMPALACE_MCP_URL || "").trim() || DEFAULT_MCP_URL;
  const toolPrefix = String(env.MEMGRAPH_TOOL_PREFIX || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  const { client } = await createSubstrateClient({
    env,
    clientName: "electric-shepherd-omp-context",
    urlOverride: url,
    headersOverride: resolveMCPHeadersFromEnv(env),
    requestTimeoutMs: timeoutMs,
    maxRetries: 0,
  });
  const memgraph = createMemgraphClient({
    callTool: async (name: string, args?: Record<string, unknown>) => client.callToolResult(name, args),
    toolPrefix,
  });

  const examples = await retrieveSimilarWorkedExamples(memgraph, {
    query: prompt,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });
  if (examples.length === 0) return undefined;
  warn(pi, `injecting ${examples.length} worked example(s) (top relevance ${examples[0].relevance.toFixed(2)})`);
  return formatWorkedExampleDemonstration(examples).trim() || undefined;
}

export function registerContextInjection(pi: OmpExtensionApi): void {
  pi.on("before_agent_start", async (event: OmpBeforeAgentStartEvent, ctx: OmpExtensionContext) => {
    const prompt = String(event.prompt || "").trim();
    if (!prompt) return;

    const cwd = ctx.cwd || process.cwd();
    const env: Env = { ...process.env };
    loadRuntimeEnv({ scriptUrl: import.meta.url, env, cwd });
    const config = loadRuntimeConfig({ cwd, env });
    Object.assign(env, getRuntimeConfigEnvMap(config));

    const blocks: string[] = [];

    if (isTrue(env.ESHEPHERD_MEMCORE_REINJECT_ENABLED)) {
      try {
        const block = buildMemcoreBlock(env, cwd);
        if (block) blocks.push(block);
      } catch (err) {
        warn(pi, `mem-core injection skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (isTrue(env.ESHEPHERD_TASK_WATCHDOG_WORKED_EXAMPLE_INJECTION_ENABLED)) {
      const timeoutMs = toNumber(env.ESHEPHERD_TASK_WATCHDOG_WORKED_EXAMPLE_SEARCH_TIMEOUT_MS, 4000);
      try {
        const block = await Promise.race([
          buildWorkedExampleBlock(pi, env, prompt, timeoutMs),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
        ]);
        if (block) blocks.push(block);
      } catch (err) {
        warn(pi, `worked-example injection skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (blocks.length === 0) return;
    return { systemPrompt: [...event.systemPrompt, ...blocks] };
  });
}
