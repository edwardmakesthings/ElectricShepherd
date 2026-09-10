/**
 * Structural declaration of the slice of omp's `ExtensionAPI` Electric Shepherd uses.
 *
 * Declared structurally rather than imported from `@oh-my-pi/pi-coding-agent`: omp
 * injects `pi` at runtime, and the package is a large dependency with native addons.
 * Typing only what we call keeps Electric Shepherd from depending on the harness it
 * is being adapted to. Shapes mirror `dist/types/extensibility/` in omp 18.1.16 —
 * swap these for the real `ExtensionAPI` types if that dependency is ever added.
 */

import type { SchemaBuilder } from "../../tools/contract.ts";

export interface OmpToolResult {
  content: { type: "text"; text: string }[];
}

export interface OmpExtensionContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string | undefined };
}

export interface OmpToolContext extends OmpExtensionContext {}

export interface OmpToolRegistration {
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
}

/** Fired once per user prompt, before the agent loop starts. */
export interface OmpBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string[];
}

/** Returning `systemPrompt` replaces it for this turn; omp chains multiple extensions. */
export interface OmpBeforeAgentStartResult {
  systemPrompt?: string[];
}

export interface OmpExtensionApi {
  zod: SchemaBuilder & { object(shape: Record<string, unknown>): unknown };
  logger?: { warn(message: string): void };
  registerTool(definition: OmpToolRegistration): void;
  on(
    event: "before_agent_start",
    handler: (
      event: OmpBeforeAgentStartEvent,
      ctx: OmpExtensionContext,
    ) => Promise<OmpBeforeAgentStartResult | void> | OmpBeforeAgentStartResult | void,
  ): void;
}
