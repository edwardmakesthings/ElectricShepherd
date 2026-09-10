/**
 * oh-my-pi binding for harness-neutral tool definitions.
 *
 * Mirrors `src/surface/opencode/tool-adapter.ts`: same definitions from
 * `src/tools/index.ts`, bound to omp's `ExtensionAPI` instead of OpenCode's
 * `tool()`.
 *
 * The `pi` shape below is declared structurally rather than imported from
 * `@oh-my-pi/pi-coding-agent`. omp injects `pi` at runtime, and the package is a
 * large dependency with native addons; typing only what we call keeps Electric
 * Shepherd from depending on the harness it is being adapted to. Swap these for
 * the real `ExtensionAPI` / `ToolDefinition` types if that dependency is ever added.
 */

import type { EsToolDefinition, SchemaBuilder } from "../../tools/contract.ts";
import { ES_TOOLS } from "../../tools/index.ts";

interface OmpToolResult {
  content: { type: "text"; text: string }[];
}

interface OmpToolContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string | undefined };
}

export interface OmpExtensionApi {
  zod: SchemaBuilder & { object(shape: Record<string, unknown>): unknown };
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: OmpToolContext,
    ): Promise<OmpToolResult>;
  }): void;
}

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
