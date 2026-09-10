/**
 * oh-my-pi binding for harness-neutral tool definitions.
 *
 * Mirrors `src/surface/opencode/tool-adapter.ts`: same definitions from
 * `src/tools/index.ts`, bound to omp's `ExtensionAPI` instead of OpenCode's
 * `tool()`. The `pi` shape it binds to is declared in `./api.ts`.
 */

import type { EsToolDefinition } from "../../tools/contract.ts";
import { ES_TOOLS } from "../../tools/index.ts";
import type { OmpExtensionApi, OmpToolContext, OmpToolResult } from "./api.ts";

export type { OmpExtensionApi } from "./api.ts";

/** Turn a snake_case tool name into the label omp shows in its UI. */
function labelFor(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function toOmpTool(pi: OmpExtensionApi, definition: EsToolDefinition) {
  return {
    name: definition.name,
    label: labelFor(definition.name),
    description: definition.description,
    parameters: pi.zod.object(definition.args(pi.zod)),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: OmpToolContext,
    ): Promise<OmpToolResult> {
      const text = await definition.execute(params, {
        cwd: context.cwd,
        sessionID: context.sessionManager?.getSessionId?.(),
      });
      return { content: [{ type: "text", text }] };
    },
  };
}

export function registerEsTools(pi: OmpExtensionApi): number {
  for (const definition of ES_TOOLS) {
    pi.registerTool(toOmpTool(pi, definition));
  }
  return ES_TOOLS.length;
}
