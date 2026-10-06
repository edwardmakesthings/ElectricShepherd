/** Explicit OMP request hook, loaded only by mapper invocations; no discovered extensions. */
import { assertWorkerModel, resolveMapperBudget } from "./worker-model.mjs";
export const TELEMETRY_PREFIX = "[eshepherd-mapper-runtime] ";

export function mapperRequest(payload, model) {
  if (model?.api !== "openai-completions") throw new Error("mapper-budget-unsupported-api: use an OpenAI-compatible completions model");
  const fields = ["max_tokens", "max_completion_tokens"].filter((key) => Object.hasOwn(payload, key));
  if (fields.length !== 1 || !Number.isSafeInteger(payload[fields[0]])) throw new Error("mapper-budget-unknown-wire-field");
  const budget = resolveMapperBudget(model.maxTokens, model.contextWindow, process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS);
  const field = fields[0];
  return {
    payload: { ...payload, [field]: budget },
    telemetry: { event: "request", provider: model.provider, model: model.id, field,
      originalBudget: payload[field], budget, contextWindow: model.contextWindow, outputLimit: model.maxTokens,
      reasoningEffort: typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : null },
  };
}

export default function mapperRuntime(pi, failClosed = () => process.exit(70)) {
  let unexpectedTool = false;
  let requests = 0;
  const emit = (record) => process.stderr.write(TELEMETRY_PREFIX + JSON.stringify(record) + "\n");
  const fatal = (phase, reason, counts = {}) => {
    emit({ event: "isolation-failure", runner: "omp", phase, reason, ...counts });
    failClosed(); // OMP catches extension exceptions; terminating this owned worker is fail-closed.
  };
  const disable = phase => async () => {
    if (typeof pi.setActiveTools !== "function" || typeof pi.getActiveTools !== "function") {
      fatal(phase, "missing-isolation-api"); return;
    }
    try {
      await pi.setActiveTools([]); // Supported OMP API disables built-in, MCP and extension tools.
    } catch { fatal(phase, "disable-api-error"); return; }
    let active;
    try { active = pi.getActiveTools(); } catch { fatal(phase, "get-active-api-error"); return; }
    if (!Array.isArray(active)) { fatal(phase, "invalid-active-tools"); return; }
    if (active.length) fatal(phase, "active-tools-after-disable", { activeTools: active.length });
  };
  const rejectTool = (name, phase, inputPresent, ctx) => {
    unexpectedTool = true;
    emit({ event: "unexpected-tool", name: typeof name === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(name) ? name : "unavailable", phase, inputPresent });
    ctx.abort();
  };
  pi.on("session_start", disable("session_start"));
  pi.on("before_agent_start", disable("before_agent_start"));
  pi.on("tool_call", (event, ctx) => {
    rejectTool(event.toolName, "blocked-before-execution", event.input !== undefined, ctx);
    return { block: true, reason: "Mapper and reducer tools are disabled" };
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    for (const block of event.message.content || []) {
      if (block.type === "toolCall") rejectTool(block.name, "assistant", block.arguments !== undefined, ctx);
    }
    if (event.message.stopReason === "toolUse" && !unexpectedTool) rejectTool(undefined, "assistant-toolUse", false, ctx);
    const finish = event.message.stopReason;
    const empty = finish === "stop" && !(event.message.content || []).some(block => block.type === "text" && block.text?.trim());
    if (!unexpectedTool && (empty || finish === "length" || finish === "error")) {
      emit({ event: "worker-failure", category: empty ? "empty" : finish, finish });
      process.exit(71); // Authoritative failure; do not let OMP auto-continue/retry behind the host's budget.
    }
  });
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (++requests !== 1) { fatal("before_provider_request", "unobserved-native-retry"); return; }
    const toolCount = (Array.isArray(payload?.tools) ? payload.tools.length : 0) + (Array.isArray(payload?.functions) ? payload.functions.length : 0);
    let active;
    try { active = pi.getActiveTools(); } catch { fatal("before_provider_request", "get-active-api-error"); return; }
    if (!Array.isArray(active)) { fatal("before_provider_request", "invalid-active-tools"); return; }
    if (unexpectedTool) { fatal("before_provider_request", "unexpected-tool"); return; }
    if (active.length) { fatal("before_provider_request", "active-tools", { activeTools: active.length, requestTools: toolCount }); return; }
    if (toolCount) { fatal("before_provider_request", "wire-tools", { activeTools: 0, requestTools: toolCount }); return; }
    if ([payload?.tools, payload?.functions].some(value => value != null && !Array.isArray(value))) {
      fatal("before_provider_request", "invalid-wire-tools"); return;
    }
    emit({ event: "tool-isolation", activeTools: 0, requestTools: toolCount });
    let result;
    try {
      assertWorkerModel(ctx.model?.provider, ctx.model?.id, process.env.ESHEPHERD_WORKER_MODEL);
      result = mapperRequest(payload, ctx.model);
    } catch (error) { fatal("before_provider_request", error.message); return; }
    emit(result.telemetry);
    return result.payload;
  });
}
