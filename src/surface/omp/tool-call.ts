/**
 * Synthesis-boundary enforcement for oh-my-pi.
 *
 * omp's `tool_call` fires at arg-prep time, before scheduling and before the
 * approval gate, and a handler may block the call or revise its input.
 *
 * What it blocks: direct derived-memory writes from a live session. Those nodes
 * are supposed to be created by the consolidation pipeline, which alone can
 * attach lineage; one written straight from a session is an orphan that still
 * competes in retrieval. The checkpoint prompt already asks agents not to do
 * this — this makes the rule load-bearing rather than advisory.
 *
 * What it does NOT block: the OpenCode `tool.execute.before` also carried the
 * loop guard and task watchdog. omp implements both natively
 * (`model.toolCallLoopGuard.*`, `task.maxConcurrency`), so re-adding them here
 * would double-fire their correctives.
 *
 * `ToolCallEvent` carries no agent identity, so the allowed-writers list cannot
 * be applied per-caller here. Anything reaching this hook is a session agent by
 * construction — the pipeline calls the substrate over MCP from its own script,
 * never through the model's tool surface, and so do Electric Shepherd's own
 * tools. There is deliberately no off switch: an env-settable one could be
 * cleared by any inherited environment, and a config-settable one would be an
 * escape hatch on an invariant the checkpoint prompt already states as a rule.
 */

import { consolidationWriteRefusal, isConsolidationWriteTool } from "../../policy/synthesis-boundary.ts";
import type { OmpExtensionApi, OmpExtensionContext, OmpToolCallEvent } from "./api.ts";
import { log } from "./runtime.ts";

export function registerToolCallGuard(pi: OmpExtensionApi): void {
  pi.on("tool_call", (event: OmpToolCallEvent, _ctx: OmpExtensionContext) => {
    const toolName = String(event.toolName || "").trim();
    if (!isConsolidationWriteTool(toolName)) return;

    log(pi, `synthesis boundary: blocked ${toolName}`);
    return { block: true, reason: consolidationWriteRefusal(toolName) };
  });
}
