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

/** omp's `AgentMessage`, narrowed to the fields turn-quality judgement reads. */
export interface OmpAgentMessage {
  role: string;
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
}

/** Fired when a main-agent turn is about to settle. */
export interface OmpSessionStopEvent {
  type: "session_stop";
  messages: OmpAgentMessage[];
  turn_id: number;
  last_assistant_message?: OmpAgentMessage;
  session_id: string;
  /** True while a continuation issued by a previous stop handler is still settling. */
  stop_hook_active: boolean;
}

/** Requesting `continue` runs one more turn with `additionalContext` visible to the model. */
export interface OmpSessionStopResult {
  continue?: boolean;
  additionalContext?: string;
}

/** Fired before the compaction summary is requested, with the messages being folded. */
export interface OmpSessionCompactingEvent {
  type: "session.compacting";
  sessionId: string;
  messages: OmpAgentMessage[];
}

/** `context` entries are appended to the summarization prompt; `prompt` would replace it. */
export interface OmpSessionCompactingResult {
  context?: string[];
  prompt?: string;
  preserveData?: Record<string, unknown>;
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
  on(
    event: "session_stop",
    handler: (
      event: OmpSessionStopEvent,
      ctx: OmpExtensionContext,
    ) => Promise<OmpSessionStopResult | void> | OmpSessionStopResult | void,
  ): void;
  on(
    event: "session.compacting",
    handler: (
      event: OmpSessionCompactingEvent,
      ctx: OmpExtensionContext,
    ) => Promise<OmpSessionCompactingResult | void> | OmpSessionCompactingResult | void,
  ): void;
}
