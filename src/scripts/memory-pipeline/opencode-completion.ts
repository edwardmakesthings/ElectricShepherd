import { asObject, asString } from "./cli-options.ts";
import { WorkerFailure } from "./omp-completion.ts";

/** OpenCode v2 run --format json emits completed text parts and authoritative step endings. */
export function opencodeCompletionText(stdout: string, emit: (record: Record<string, unknown>) => void,
  providerCompletion?: { finish: string; usage: Record<string, number> }): string {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n").filter(line => line.trim())) {
    try { events.push(asObject(JSON.parse(line))); } catch { throw new WorkerFailure("invalid-stream"); }
  }
  if (events.some(event => event.type === "tool_use" || asObject(event.part).type === "tool")) {
    emit({ event: "unexpected-tool", phase: "opencode-stream", inputPresent: true });
    throw new WorkerFailure("tool-use", false, "toolUse");
  }
  if (events.some(event => event.type === "error")) throw new WorkerFailure("error", true, "error");
  const endings = events.filter(event => event.type === "step_finish");
  if (endings.length > 1 || (!endings.length && !providerCompletion)) throw new WorkerFailure("invalid-stream");
  const part = asObject(endings[0]?.part);
  const finish = endings.length ? asString(part.reason) : providerCompletion!.finish;
  if (providerCompletion && finish !== providerCompletion.finish) throw new WorkerFailure("invalid-stream");
  const text = events.filter(event => event.type === "text").map(event => asString(asObject(event.part).text)).join("");
  const tokens = asObject(part.tokens), cache = asObject(tokens.cache);
  const usage: Record<string, number> = { ...providerCompletion?.usage };
  for (const [name, value] of Object.entries({ input: tokens.input, output: tokens.output, reasoningTokens: tokens.reasoning,
    cacheRead: cache.read, cacheWrite: cache.write, totalTokens: tokens.total })) {
    if (typeof value === "number" && Number.isFinite(value)) usage[name] = value;
  }
  emit({ event: "completion", runner: "opencode", finish, textPresent: Boolean(text), textCharacters: text.length, usage });
  if (finish === "length" || finish === "error") throw new WorkerFailure(finish, true, finish);
  if (finish === "tool-calls" || finish === "toolUse") throw new WorkerFailure("tool-use", false, "toolUse");
  if (finish !== "stop") throw new WorkerFailure("invalid-stream", false, finish);
  return text;
}
