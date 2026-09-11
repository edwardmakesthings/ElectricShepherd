/**
 * Recognise which named agent, if any, is currently active from the system
 * prompt's identity sentence ("You are the X." / "You are X.").
 *
 * Shared by the synthesis boundary (an allow-list: only the dreamer may write
 * derived nodes) and the checkpoint gate (a deny-list: utility agents should
 * not trigger the memory checkpoint) so both read the same signal the same
 * way. Matching the identity sentence rather than a loose keyword means a
 * transcript that merely discusses an agent by name cannot trip either gate.
 */
export function matchesAgentIdentity(systemPrompt: readonly string[], names: readonly string[]): boolean {
  const text = systemPrompt.join("\n").toLowerCase();
  return names.some((name) => {
    const agent = name.trim().toLowerCase();
    if (!agent) return false;
    return text.includes(`you are the ${agent}.`) || text.includes(`you are ${agent}.`);
  });
}
