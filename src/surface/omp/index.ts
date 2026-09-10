/**
 * Electric Shepherd as an oh-my-pi extension.
 *
 * Registering this directory as an omp extension root also makes omp discover
 * the bundled `agents/`, `commands/` and `skills/` beside it, so the asset
 * injection OpenCode needs (src/surface/asset-loader.ts) has no counterpart here.
 *
 * Wired so far: the tool surface, `before_agent_start` context injection,
 * `session.compacting` retention, and a `session_stop` chain of source capture,
 * auto-consolidation and the memory checkpoint. Still unwired: `tool_call`
 * (approval, failure patches).
 *
 * Deliberately NOT ported: the loop guard, stall retry, task watchdog and the
 * compaction archive. omp implements all four natively
 * (`model.toolCallLoopGuard.*`, `session/turn-recovery`, `task.maxConcurrency`,
 * `CompactionEntry`), and running both layers double-fires their correctives.
 */

import type { OmpExtensionApi } from "./api.ts";
import { registerCompaction } from "./compaction.ts";
import { registerConsolidation } from "./consolidation.ts";
import { registerContextInjection } from "./context-injection.ts";
import { registerCheckpoint } from "./session-stop.ts";
import { registerSourceCapture } from "./source-capture.ts";
import { registerEsTools } from "./tool-adapter.ts";

export default function electricShepherd(pi: OmpExtensionApi) {
  registerEsTools(pi);
  registerContextInjection(pi);
  registerCompaction(pi);
  // session_stop order is load-bearing. Handlers run in registration order and
  // omp stops dispatching at the first one returning a continuation, so the two
  // silent handlers must precede the checkpoint. Capture also has to land before
  // consolidation, which would otherwise find nothing to consolidate.
  registerSourceCapture(pi);
  registerConsolidation(pi);
  registerCheckpoint(pi);
}
