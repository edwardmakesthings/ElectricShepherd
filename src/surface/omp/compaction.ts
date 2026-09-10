/**
 * Compaction handling for oh-my-pi.
 *
 * omp fires `session.compacting` BEFORE the summarization request and lets a
 * handler append entries to the summarizer's context. OpenCode had no
 * pre-compaction hook at all: it ran after the fact, reconstructed the folded
 * region by scanning backwards for summary markers, then wrote the raw messages
 * to `.electric-shepherd/compaction-archive/`.
 *
 * That archive is not ported — omp persists the folded region itself as a
 * `CompactionEntry`, so re-writing the bytes duplicates the harness.
 *
 * Mem-core is deliberately NOT injected here. It belongs in the system prompt,
 * which the fold never touches: `before_agent_start` sets a per-turn override
 * that omp preserves across base-prompt rebuilds "landing in the prompt window
 * (compaction/promotion, ...)", so durable state is already present on every
 * turn including the one after a fold. Putting it in the SUMMARIZER's prompt
 * would instead invite the summary to copy it back into the conversation,
 * leaving mem-core in context twice.
 *
 * Nor does this subscribe to `session_before_compact`: omp disables speculative
 * and deferred compaction whenever that event has handlers, since an extension
 * there may veto or replace the fold. Subscribing would silently make every
 * compaction synchronous and blocking.
 *
 * What is left is the one thing only this hook can do: tell the summarizer which
 * signals must survive the fold.
 */

import type { OmpExtensionApi, OmpExtensionContext, OmpSessionCompactingEvent } from "./api.ts";
import { isTrue, log, resolveEnv } from "./runtime.ts";

/**
 * Addressed to the summarizer, not the agent. The checkpoint at `session_stop`
 * can only save work it can still see, so a fold that drops the evidence of
 * unsaved work loses it silently — naming the signals keeps them in the summary.
 */
const RETENTION_NOTE = [
  "Electric Shepherd — retain across this compaction:",
  "- decisions made and their reasons (not just the outcome)",
  "- root causes found, and dead ends ruled out",
  "- anything learned that a future session would want to retrieve",
  "- whether that work has been saved to memory yet",
  "Summarize these; do not drop them as conversational detail.",
].join("\n");

export function registerCompaction(pi: OmpExtensionApi): void {
  pi.on("session.compacting", (event: OmpSessionCompactingEvent, ctx: OmpExtensionContext) => {
    const env = resolveEnv(ctx.cwd || process.cwd(), import.meta.url);
    if (!isTrue(env.ESHEPHERD_COMPACT_ARCHIVE)) return;

    log(pi, `compaction retention note applied to session=${event.sessionId}`);
    return {
      context: [RETENTION_NOTE],
      preserveData: {
        electricShepherd: { retentionNoteApplied: true, at: new Date().toISOString() },
      },
    };
  });
}
