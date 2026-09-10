/**
 * The synthesis boundary, as data.
 *
 * Derived memory nodes carry lineage: a synthesis node records which source
 * drawers it came from, and the consolidation pipeline creates them over MCP
 * from its own script. A live session that calls `add_drawer` or `kg_add`
 * directly produces a node with no lineage and no provenance, which then
 * competes with real syntheses in retrieval.
 *
 * The checkpoint prompt already tells agents this in prose ("derived memory
 * writes ... require lineage-bearing node creation through the synthesis
 * boundary, so this agent should use diary_write"). These constants let a
 * surface enforce it instead of asking.
 */

/** Substrate tools that create or mutate derived memory. Matched as name suffixes. */
export const CONSOLIDATION_WRITE_TOOL_NAMES = [
  "add_drawer",
  "update_drawer",
  "kg_add",
  "kg_invalidate",
  "apply_merge",
] as const;

/** Agents permitted to cross the boundary. */
export const DEFAULT_ALLOWED_CONSOLIDATION_WRITERS = ["dreamer"];

/**
 * Identify an allowed writer from the active system prompt.
 *
 * The dreamer creates derived nodes through the model's tool surface by design —
 * `add_drawer` then `kg_add` for the `synthesized-from` edge — and that is also
 * how higher-height syntheses (syntheses of syntheses) get built. Blocking it
 * would break `/consolidate-deep`.
 *
 * omp's `tool_call` event carries no agent identity, and its session manager
 * does not expose the active agent, so the system prompt is the only signal
 * available. Matching is on the agent's identity sentence rather than a loose
 * keyword, so a transcript that merely discusses the dreamer cannot unlock it.
 */
export function isAllowedConsolidationWriter(
  systemPrompt: readonly string[],
  allowed: readonly string[] = DEFAULT_ALLOWED_CONSOLIDATION_WRITERS,
): boolean {
  const text = systemPrompt.join("\n").toLowerCase();
  return allowed.some((name) => {
    const agent = name.trim().toLowerCase();
    if (!agent) return false;
    return text.includes(`you are the ${agent}.`) || text.includes(`you are ${agent}.`);
  });
}

/** True when a tool name is a derived-memory write, whatever gateway prefix it carries. */
export function isConsolidationWriteTool(toolName: string): boolean {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (!normalized) return false;
  return CONSOLIDATION_WRITE_TOOL_NAMES.some((tail) => normalized.endsWith(tail));
}

/** What the model is told when a write is refused, including the way through. */
export function consolidationWriteRefusal(toolName: string): string {
  return (
    `${toolName} is blocked by Electric Shepherd's synthesis boundary. ` +
    `Derived memory nodes must carry lineage back to their sources, which only the ` +
    `consolidation pipeline can create. Writing one directly produces an orphan node ` +
    `that competes with real syntheses in retrieval.\n\n` +
    `Use diary_write instead — a consolidation pass will formalize it into the derived ` +
    `layer with its lineage intact.`
  );
}
