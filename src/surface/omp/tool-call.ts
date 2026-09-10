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
 * The dreamer is exempt — it builds derived nodes, including higher-height
 * syntheses of syntheses, through exactly these tools. `ToolCallEvent` carries
 * no agent identity and omp's session manager does not expose the active agent,
 * so the exemption is recognised from the system prompt.
 */

import { isAllowedConsolidationWriter, consolidationWriteRefusal, isConsolidationWriteTool } from "../../policy/synthesis-boundary.ts";
import type { OmpExtensionApi, OmpExtensionContext, OmpToolCallEvent } from "./api.ts";
import { log } from "./runtime.ts";

export function registerToolCallGuard(pi: OmpExtensionApi): void {
  pi.on("tool_call", (event: OmpToolCallEvent, ctx: OmpExtensionContext) => {
    const toolName = String(event.toolName || "").trim();
    if (!isConsolidationWriteTool(toolName)) return;
    if (isAllowedConsolidationWriter(ctx.getSystemPrompt?.() ?? [])) return;

    log(pi, `synthesis boundary: blocked ${toolName}`);
    return { block: true, reason: consolidationWriteRefusal(toolName) };
  });
}
