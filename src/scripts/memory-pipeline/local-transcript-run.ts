import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { loadRuntimeConfig } from "../../core/runtime-config.ts";
import { getArg } from "./cli-options.ts";
import { getActivePromptRoutingFromEnv, parseModelSelector } from "./runtime-utils.ts";
import { formatPromptModelArg, resolveSubagentRunner, resolveSubagentTimeoutMs, runSubagent } from "./subagent.ts";
import { loadLocalTranscript } from "./source-loading.ts";
import { runSourceDraft } from "./source-draft.ts";

/** No substrate construction or shared coordination on the local-only route. */
export async function runLocalTranscript(args: {
  file: string; checkpointDirectory: string; argv: string[]; runtimeConfig: ReturnType<typeof loadRuntimeConfig>;
  esRoot: string; runId: string; deadlineMs: number;
}) {
  const source = loadLocalTranscript(args.file); // Fail closed before resolving or invoking a model.
  process.env.ESHEPHERD_SOURCE_CAPTURE_ENABLED = "false";
  const configuredModel = String(process.env.ESHEPHERD_CONSOLIDATION_MAPPER_MODEL ||
    args.runtimeConfig.valuesByPath.consolidation?.mapperModel || "").trim();
  const activeRouting = getActivePromptRoutingFromEnv(process.env);
  const model = configuredModel ? parseModelSelector(configuredModel) : activeRouting.model;
  if (configuredModel && !model) throw new Error("invalid-local-mapper-model");
  const runner = resolveSubagentRunner({
    explicitBin: getArg(args.argv, "--subagent-bin") || getArg(args.argv, "--opencode-bin"), env: process.env,
    preferKind: String(args.runtimeConfig.valuesByPath.consolidation?.subagentHarness || "").trim().toLowerCase() as "opencode" | "omp" | undefined,
  });
  if (!runner) throw new Error("mapper-unavailable");
  const agent = getArg(args.argv, "--mapper-agent") || "dream-mapper";
  const definition = resolve(args.esRoot, "agents", `${agent}.md`);
  const promptHash = createHash("sha256").update(existsSync(definition) ? readFileSync(definition) : agent).digest("hex");
  const modelArg = formatPromptModelArg(model);
  const result = await runSourceDraft({ source, query: getArg(args.argv, "--query") || "local transcript consolidation",
    runId: args.runId, checkpointDirectory: resolve(args.checkpointDirectory), deadlineMs: args.deadlineMs,
    timeoutMs: resolveSubagentTimeoutMs(process.env),
    extractorVersion: JSON.stringify({ contract: "drawer-text-batches-v10", model, agent, promptHash }),
    reducerVersion: JSON.stringify({ contract: "drawer-text-reconciliation-v6", model, agent, promptHash }),
    mapChunk: async (prompt, identity) => runSubagent({ runner, esRoot: args.esRoot, mapperRuntime: true,
      agentName: agent, modelArg, prompt, timeoutMs: identity.timeoutMs, workerAttempt: identity.attempt,
      keepSession: true, sessionTitle: `es-local-mapper ${args.runId} ${identity.chunkId}` }),
    reconcileTopic: async (prompt, identity) => runSubagent({ runner, esRoot: args.esRoot, mapperRuntime: true,
      agentName: agent, modelArg, prompt, timeoutMs: identity.timeoutMs, workerAttempt: identity.attempt,
      keepSession: true, sessionTitle: `es-local-reconcile ${args.runId} ${identity.stepIndex}` }),
  });
  if (result.error) throw new Error(result.error);
  return { runId: args.runId, worklistMode: "local-transcript", localSource: source.inventory.localSource,
    drafts: result.drafts, extraction: result.extraction, reconciliation: result.reconciliation,
    readOnly: { substrateInitialized: false, palaceReads: 0, palaceWrites: 0, memCoreApply: false, capture: false } };
}
