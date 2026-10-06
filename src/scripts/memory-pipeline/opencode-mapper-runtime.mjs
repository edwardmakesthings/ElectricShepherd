/** Private-worker-only OpenCode v2 plugin. No inherited plugins/configuration are loaded. */
const PREFIX = "[eshepherd-mapper-runtime] ";
import { assertWorkerModel, resolveMapperBudget } from "./worker-model.mjs";
const emit = record => process.stderr.write(PREFIX + JSON.stringify({ runner: "opencode", ...record }) + "\n");
const fatal = (phase, reason, counts = {}) => {
  emit({ event: "isolation-failure", phase, reason, ...counts });
  process.exit(70);
};
const toolUse = phase => {
  emit({ event: "unexpected-tool", phase, inputPresent: true });
  process.exit(70);
};

export default {
  id: "eshepherd.raw-worker",
  async setup(ctx) {
    await ctx.tool.transform(editor => { for (const tool of editor.list()) editor.remove(tool.id); });
    await ctx.mcp.transform(editor => { for (const [name] of editor.list()) editor.remove(name); });
    await ctx.tool.hook("execute.before", () => toolUse("blocked-before-execution"));
    await ctx.session.hook("retry", event => { event.decision = { retry: false }; });
    await ctx.session.hook("title", event => { event.result = "Raw text worker"; });
    let activeTools, budget, limits;
    await ctx.session.hook("context", async event => {
      // tool.list() is the registry, not the permission-filtered executable request snapshot.
      activeTools = Object.keys(event.tools).length;
      if (activeTools) fatal("context", "active-tools", { activeTools });
      try { assertWorkerModel(event.model.providerID, event.model.id, process.env.ESHEPHERD_WORKER_MODEL); }
      catch (error) { fatal("context", error.message); return; }
      try {
        const result = await ctx.model.list();
        const models = Array.isArray(result) ? result : result.data;
        limits = models.find(model => model.providerID === event.model.providerID && model.id === event.model.id)?.limit;
      } catch { fatal("context", "model-metadata-unavailable"); return; }
      try { budget = resolveMapperBudget(limits?.output, limits?.context, process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS); }
      catch (error) { fatal("context", error.message); return; }
      event.options.maxTokens = budget;
    });
    let requests = 0;
    await ctx.session.hook("http.request", async event => {
      if (event.kind !== "primary") fatal("http.request", "unexpected-request-kind");
      if (++requests !== 1) fatal("http.request", "unexpected-continuation");
      if (!new URL(event.request.url).pathname.endsWith("/chat/completions")) {
        fatal("http.request", "mapper-budget-unsupported-api: use an OpenAI-compatible chat-completions model");
      }
      let payload;
      try { payload = await event.request.clone().json(); } catch { fatal("http.request", "invalid-request-body"); }
      if (activeTools !== 0) fatal("http.request", "missing-zero-tool-context");
      const requestTools = (Array.isArray(payload.tools) ? payload.tools.length : 0) + (Array.isArray(payload.functions) ? payload.functions.length : 0);
      if (activeTools || requestTools || [payload.tools, payload.functions].some(v => v != null && !Array.isArray(v))) {
        fatal("http.request", "wire-tools", { activeTools, requestTools });
      }
      const fields = ["max_tokens", "max_completion_tokens"].filter(key => Object.hasOwn(payload, key));
      try { assertWorkerModel(event.model.providerID, event.model.id, process.env.ESHEPHERD_WORKER_MODEL); }
      catch (error) { fatal("http.request", error.message); }
      if (fields.length !== 1 || payload[fields[0]] !== budget) fatal("http.request", "unsupported-request-budget: use an OpenAI-compatible completions model");
      emit({ event: "tool-isolation", activeTools, requestTools });
      emit({ event: "request", provider: event.model.providerID, model: event.model.id, field: fields[0], budget: payload[fields[0]], outputLimit: limits.output, contextWindow: limits.context,
        reasoningEffort: typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : null });
    });
    await ctx.session.hook("experimental.ws.handshake", () => fatal("websocket", "unsupported-transport"));
    await ctx.session.hook("http.response", event => {
      if (!event.response.body) return;
      // Inspect before provider lowering/tool dispatch. No arguments, content or reasoning are logged.
      let buffer = "";
      let finish, emitted = false, usage = {};
      const decoder = new TextDecoder();
      const inspect = line => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim(); if (!data) return;
        if (data === "[DONE]") return;
        let parsed; try { parsed = JSON.parse(data); } catch { fatal("http.response", "invalid-sse"); }
        for (const choice of parsed.choices || []) {
          if (choice.delta?.tool_calls?.length || choice.delta?.function_call || choice.message?.tool_calls?.length ||
            choice.message?.function_call || ["tool_calls", "function_call"].includes(choice.finish_reason)) toolUse("provider-stream");
          if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
        }
        if (parsed.usage) {
          const u = parsed.usage;
          for (const [key, value] of Object.entries({ input: u.prompt_tokens, output: u.completion_tokens, totalTokens: u.total_tokens,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens, cacheRead: u.prompt_tokens_details?.cached_tokens })) {
            if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
          }
        }
      };
      const stream = event.response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          let end; while ((end = buffer.indexOf("\n")) !== -1) { inspect(buffer.slice(0, end).replace(/\r$/, "")); buffer = buffer.slice(end + 1); }
          if (buffer.length > 1000000) fatal("http.response", "unbounded-sse-line");
          if (finish && !emitted) { emitted = true; emit({ event: "provider-completion", finish, usage }); }
          controller.enqueue(chunk);
        },
        flush() {
          buffer += decoder.decode(); if (buffer) inspect(buffer);
          if (finish && !emitted) emit({ event: "provider-completion", finish, usage });
        },
      }));
      event.response = new Response(stream, { status: event.response.status, statusText: event.response.statusText, headers: event.response.headers });
    });
    emit({ event: "worker-controls", configuration: "private-model-only", tools: "deny-permissions-and-request-snapshot", retries: "host-only" });
  },
};
