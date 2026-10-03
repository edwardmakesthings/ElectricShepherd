/** Explicit OMP request hook, loaded only by mapper invocations; no discovered extensions. */
export const MAPPER_OUTPUT_TOKENS = 24_576;
export const MAPPER_MODEL = "implementer-swift-qwen3.8-27b";
export const TELEMETRY_PREFIX = "[eshepherd-mapper-runtime] ";

export function mapperRequest(payload, model) {
  if (model?.provider !== "litellm" || model?.id !== MAPPER_MODEL) return undefined;
  if (model.api !== "openai-completions") throw new Error("mapper-budget-unsupported-api");
  const fields = ["max_tokens", "max_completion_tokens"].filter((key) => Object.hasOwn(payload, key));
  if (fields.length !== 1 || !Number.isSafeInteger(payload[fields[0]])) throw new Error("mapper-budget-unknown-wire-field");
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 2 * MAPPER_OUTPUT_TOKENS) {
    throw new Error("mapper-budget-insufficient-model-headroom");
  }
  const field = fields[0];
  return {
    payload: { ...payload, [field]: MAPPER_OUTPUT_TOKENS },
    telemetry: { event: "request", provider: model.provider, model: model.id, field,
      originalBudget: payload[field], budget: MAPPER_OUTPUT_TOKENS, contextWindow: model.contextWindow,
      reasoningEffort: typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : null },
  };
}

export default function mapperRuntime(pi) {
  pi.on("before_provider_request", (event, ctx) => {
    const result = mapperRequest(event.payload, ctx.model);
    if (!result) return undefined;
    process.stderr.write(TELEMETRY_PREFIX + JSON.stringify(result.telemetry) + "\n");
    return result.payload;
  });
}
