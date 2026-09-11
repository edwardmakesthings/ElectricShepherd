/**
 * End-of-session memory checkpoint for oh-my-pi.
 *
 * omp fires `session_stop` when a main-agent turn is about to settle and lets a
 * handler request one continuation turn with model-visible context. That is a
 * native fit for the checkpoint: OpenCode had to inject a whole follow-up prompt
 * through `client.session.prompt` and then teach its retry guard to recognise the
 * reply as terminal, which is why the OpenCode path carries CHECKPOINT_MARKER.
 * Here the continuation IS the mechanism, so no marker is needed.
 *
 * `session_stop` only fires on the TOP-level session (`session/agent-session.ts`,
 * `session-maintenance.ts` are the only emit sites) — a `task`-tool subagent (the
 * dreamer invoked from a command's delegation instruction, for example) never
 * gets its own `session_stop`. So a one-shot command that delegates to a
 * subagent and reports its answer still settles as an ordinary top-level turn,
 * indistinguishable by content from real interactive work, and used to
 * checkpoint every time — turning a 2-minute status report into a 15-minute
 * hang while the local model ran the checkpoint's own search-and-save turn.
 *
 * Two independent gates fix that instead of guessing from message content:
 *   - mode: `"print"`/`"json"` (`omp -p`) is documented as "process prompt and
 *     exit"; a continuation there runs a turn the invocation has no way to
 *     read and no reason to expect. `checkpoint.interactiveOnly` (default true)
 *     restricts checkpointing to `"tui"`/`"rpc"` sessions.
 *   - agent identity: `checkpoint.disabledAgents` (existing OpenCode config key,
 *     unused on this surface until now) skips checkpointing for named utility
 *     agents, recognised the same way the synthesis boundary recognises the
 *     dreamer — from the system prompt's identity sentence.
 *
 * Beyond those, fires at most once per session, only after a genuinely complete
 * turn — a real stop with useful output that is not mid-intent — so it never
 * lands on a stall. `stop_hook_active` guards against re-entering on our own
 * continuation.
 */

import { matchesAgentIdentity } from "../../policy/agent-identity.ts";
import { CHECKPOINT_PROMPT, MIN_TURNS_BEFORE_CHECKPOINT } from "../../policy/checkpoint-prompt.ts";
import { endsMidIntent, hasUsefulPayload, isAssistantStop, type TurnMessage } from "../../policy/turn-quality.ts";
import type { OmpAgentMessage, OmpExtensionApi, OmpExtensionContext, OmpSessionStopEvent } from "./api.ts";
import { isTrue, log, resolveEnv, toList } from "./runtime.ts";

/** Map an omp `AgentMessage` onto the neutral shape the turn-quality predicates read. */
function toTurnMessage(message: OmpAgentMessage | undefined): TurnMessage | undefined {
  if (!message) return undefined;
  const parts = (message.content ?? []).map((part) => {
    if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
    // Any tool call counts as an action part, which is what endsMidIntent tests for.
    if (part.type === "toolCall") return { type: "tool" };
    return { type: String(part.type ?? "") };
  });
  return { info: { role: message.role, finish: message.stopReason }, parts };
}

function lastAssistant(messages: OmpAgentMessage[]): OmpAgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

export function registerCheckpoint(pi: OmpExtensionApi): void {
  const checkpointed = new Set<string>();

  pi.on("session_stop", (event: OmpSessionStopEvent, ctx: OmpExtensionContext) => {
    if (event.stop_hook_active) return;

    const sessionID = String(event.session_id || "").trim();
    if (!sessionID || checkpointed.has(sessionID)) return;

    const cwd = ctx.cwd || process.cwd();
    const env = resolveEnv(cwd, import.meta.url);
    if (!isTrue(env.ESHEPHERD_CHECKPOINT_ENABLED)) return;

    const interactiveOnly = env.ESHEPHERD_CHECKPOINT_INTERACTIVE_ONLY !== "false";
    const mode = ctx.mode;
    if (interactiveOnly && mode !== undefined && mode !== "tui" && mode !== "rpc") {
      log(pi, `checkpoint skipped for session=${sessionID}: mode=${mode} is not interactive`);
      return;
    }

    const disabledAgents = toList(env.ESHEPHERD_CHECKPOINT_DISABLED_AGENTS);
    if (disabledAgents.length > 0 && matchesAgentIdentity(ctx.getSystemPrompt?.() ?? [], disabledAgents)) {
      log(pi, `checkpoint skipped for session=${sessionID}: active agent is in checkpoint.disabledAgents`);
      return;
    }

    const messages = event.messages ?? [];
    const assistantTurns = messages.filter((message) => message?.role === "assistant").length;
    if (assistantTurns < MIN_TURNS_BEFORE_CHECKPOINT) return;

    const last = toTurnMessage(event.last_assistant_message ?? lastAssistant(messages));
    if (!last) return;
    if (!isAssistantStop(last)) return;
    if (endsMidIntent(last)) return;
    if (!hasUsefulPayload(last)) return;

    checkpointed.add(sessionID);
    log(pi, `memory checkpoint requested for session=${sessionID} after ${assistantTurns} assistant turns`);
    return { continue: true, additionalContext: CHECKPOINT_PROMPT };
  });
}
