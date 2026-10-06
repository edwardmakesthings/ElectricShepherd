/** Output budgets reserve at least half the configured context for the source. */
export const DEFAULT_MAPPER_OUTPUT_TOKENS = 8192;

/** @param {number} outputLimit @param {number} contextWindow @param {string | undefined} override */
export function resolveMapperBudget(outputLimit, contextWindow, override) {
  if (!Number.isSafeInteger(outputLimit) || outputLimit <= 0 || !Number.isSafeInteger(contextWindow) || contextWindow < 2) {
    throw new Error("mapper-model-limits-required: configure positive output and context limits");
  }
  const ceiling = Math.min(outputLimit, Math.floor(contextWindow / 2));
  if (!override || override === "0") return Math.min(DEFAULT_MAPPER_OUTPUT_TOKENS, ceiling);
  const budget = Number(override);
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > ceiling) {
    throw new Error("mapper-budget-outside-model-limits: lower ESHEPHERD_MAPPER_OUTPUT_TOKENS or correct the model limits");
  }
  return budget;
}

/** @param {string} provider @param {string} model @param {string | undefined} selected */
export function assertWorkerModel(provider, model, selected) {
  if (!provider || !model || selected !== provider + "/" + model) {
    throw new Error("mapper-selected-model-mismatch");
  }
}
