import { asArray, asObject, asString } from "./cli-options.ts";

/** Read authoritative completed messages, not OMP's mutable text-mode context tail. */
export function ompCompletionText(stdout: string, emit: (record: Record<string, unknown>) => void): string {
  let terminal: Record<string, unknown> | undefined;
  let ended = false;
  const textFrom = (message: Record<string, unknown>): string => asArray(message.content)
    .map(asObject).filter((block) => block.type === "text").map((block) => asString(block.text)).join("\n");
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    const event = asObject(JSON.parse(line));
    const message = asObject(event.message);
    if (event.type === "message_end" && message.role === "assistant") {
      terminal = message;
      const text = textFrom(message);
      const thinkingCharacters = asArray(message.content).map(asObject)
        .filter((block) => block.type === "thinking").reduce((sum, block) => sum + asString(block.thinking).length, 0);
      const usage: Record<string, number> = {};
      for (const key of ["input", "output", "reasoningTokens", "cacheRead", "cacheWrite", "totalTokens"]) {
        const value = asObject(message.usage)[key];
        if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
      }
      emit({ event: "completion", provider: message.provider, model: message.model,
        finish: message.stopReason, textPresent: text.length > 0, textCharacters: text.length, thinkingCharacters, usage });
    }
    if (event.type === "agent_end") ended = true;
  }
  if (!ended || !terminal) throw new Error("mapper-incomplete-event-stream");
  if (terminal.stopReason !== "stop") throw new Error("mapper-terminal-" + String(terminal.stopReason));
  if (!Array.isArray(terminal.content) || terminal.content.some((block) => asObject(block).type === "toolCall")) {
    throw new Error("mapper-terminal-tool-call");
  }
  return textFrom(terminal);
}
