import { asArray, asObject, asString } from "./cli-options.ts";

export type WorkerFailureCategory = "transport" | "timeout" | "empty" | "length" | "error" | "deadline" | "tool-use" | "invalid-stream" | "process" | "insubstantial";
/** Only known read-only inference failures are retryable; never used around palace writes. */
export class WorkerFailure extends Error {
  readonly category: WorkerFailureCategory;
  readonly retryable: boolean;
  readonly finish?: string;
  constructor(category: WorkerFailureCategory, retryable = false, finish?: string) {
    super("worker-" + category);
    this.category = category; this.retryable = retryable; this.finish = finish;
  }
}
function safeToolName(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : "unavailable";
}
/** Inspect completed event lines even when a timeout truncates the stream. No arguments/results are logged. */
export function ompUnexpectedTools(stdout: string, emit: (record: Record<string, unknown>) => void): boolean {
  let found = false;
  for (const line of stdout.split("\n")) {
    let event: Record<string, unknown>;
    try { event = asObject(JSON.parse(line)); } catch { continue; }
    const message = asObject(event.message);
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      found = true;
      emit({ event: "unexpected-tool", name: safeToolName(event.toolName), phase: event.type, inputPresent: event.args !== undefined });
    }
    if (message.role === "assistant") {
      const calls = asArray(message.content).map(asObject).filter(block => block.type === "toolCall");
      if (message.stopReason === "toolUse" || calls.length) {
        found = true;
        for (const block of calls.length ? calls : [{}]) emit({ event: "unexpected-tool", name: safeToolName(block.name), phase: "assistant", inputPresent: block.arguments !== undefined });
      }
    }
  }
  return found;
}
/** Reject ANY tool turn, not merely the final assistant message. Never return thinking. */
export function ompCompletionText(stdout: string, emit: (record: Record<string, unknown>) => void): string {
  let terminal: Record<string, unknown> | undefined;
  let ended = false;
  const unexpectedTool = ompUnexpectedTools(stdout, emit);
  const textFrom = (message: Record<string, unknown>): string => asArray(message.content)
    .map(asObject).filter((block) => block.type === "text").map((block) => asString(block.text)).join("");
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    let event: Record<string, unknown>;
    try { event = asObject(JSON.parse(line)); } catch { throw new WorkerFailure(unexpectedTool ? "tool-use" : "invalid-stream"); }
    const message = asObject(event.message);
    if (event.type === "message_end" && message.role === "assistant") {
      terminal = message;
      const text = textFrom(message);
      const blocks = asArray(message.content).map(asObject);
      const usage: Record<string, number> = {};
      for (const key of ["input", "output", "reasoningTokens", "cacheRead", "cacheWrite", "totalTokens"]) {
        const value = asObject(message.usage)[key];
        if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
      }
      emit({ event: "completion", finish: asString(message.stopReason), textPresent: text.length > 0, textCharacters: text.length,
        thinkingCharacters: blocks.filter((block) => block.type === "thinking").reduce((sum, block) => sum + asString(block.thinking).length, 0), usage });
    }
    if (event.type === "agent_end") ended = true;
  }
  if (unexpectedTool) throw new WorkerFailure("tool-use", false, "toolUse");
  if (!ended || !terminal) throw new WorkerFailure("invalid-stream");
  const finish = asString(terminal.stopReason);
  if (finish === "length" || finish === "error") throw new WorkerFailure(finish, true, finish);
  if (finish !== "stop" || !Array.isArray(terminal.content)) throw new WorkerFailure("invalid-stream", false, finish);
  return textFrom(terminal);
}
