/**
 * Turn-quality predicates: "did this assistant turn actually finish, and did it
 * produce anything?"
 *
 * Harness-neutral. Both surfaces answer the same question about a settled turn —
 * OpenCode over `{ info, parts }` messages, omp over `AgentMessage` normalized to
 * the same shape — so the judgement lives here rather than in either adapter.
 * `src/surface/plugin/session-policy/pure-helpers.ts` re-exports these so its
 * existing importers keep working unchanged.
 */

/** Minimum text length that counts as a substantive answer on its own. */
export const MIN_USEFUL_TEXT = 24;

/** Neutral message view: a role/finish header plus typed parts. */
export type TurnMessage = {
  info?: { role?: string; finish?: string } & Record<string, unknown>;
  parts?: Array<{ type?: string; text?: string } & Record<string, unknown>>;
};

export function getText(parts: any[]): string {
  return parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function hasActionPart(msg: TurnMessage | null | undefined): boolean {
  const parts = msg?.parts ?? [];
  return parts.some((p: any) => {
    const type = String(p?.type ?? "");
    return type === "tool" || type === "patch" || type === "file" || type === "subtask";
  });
}

export function hasUsefulPayload(msg: TurnMessage): boolean {
  const parts = msg.parts ?? [];
  const text = getText(parts);
  if (text.length >= MIN_USEFUL_TEXT) return true;
  // Short but still useful status/blocker responses should not trigger retries.
  if (/no files found|not found|blocked|error|unable|cannot|next step|i will/i.test(text)) return true;
  if (text.length >= 8) return true;
  if (parts.some((p) => p?.type === "patch")) return true;
  if (parts.some((p) => p?.type === "file")) return true;
  return false;
}

// Mode B premature stop: the model announced an action (or trailed off on a
// colon) but emitted finish=stop with no tool/patch/file part executing it.
// e.g. "Now let me verify the delete button in the Control Panel:" then nothing.
export function endsMidIntent(msg: TurnMessage): boolean {
  const parts = msg.parts ?? [];
  if (hasActionPart(msg)) return false;
  const text = getText(parts).trim();
  if (!text) return false;
  const lastLine = (text.split(/\n/).pop() ?? "").trim();
  const danglingColon = /[:\uFF1A]\s*$/.test(text);
  const announcesAction =
    /\b(let me|let's|now (?:i|we)|i'?ll|i will|i'm going to|going to|next,?\s+i|then i|first,? i|i need to|i'?m going to|let me now)\b/i.test(
      lastLine,
    );
  return danglingColon || announcesAction;
}

export function isAssistantStop(msg: TurnMessage): boolean {
  return msg?.info?.role === "assistant" && msg?.info?.finish === "stop";
}
