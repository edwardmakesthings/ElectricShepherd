/**
 * Electric Shepherd as an oh-my-pi extension.
 *
 * Registering this directory as an omp extension root also makes omp discover
 * the bundled `agents/`, `commands/` and `skills/` beside it, so the asset
 * injection OpenCode needs (src/surface/asset-loader.ts) has no counterpart here.
 *
 * Wired so far: the tool surface, `before_agent_start` context injection, and
 * the `session_stop` memory checkpoint. Still unwired: `session.compacting`
 * (preserveData) and `tool_call` (approval, failure patches).
 *
 * Deliberately NOT ported: the loop guard, stall retry, task watchdog and
 * compaction archive. omp implements all four natively
 * (`model.toolCallLoopGuard.*`, `session/turn-recovery`, `task.maxConcurrency`,
 * `CompactionEntry`), and running both layers double-fires their correctives.
 */

import type { OmpExtensionApi } from "./api.ts";
import { registerContextInjection } from "./context-injection.ts";
import { registerCheckpoint } from "./session-stop.ts";
import { registerEsTools } from "./tool-adapter.ts";

export default function electricShepherd(pi: OmpExtensionApi) {
  registerEsTools(pi);
  registerContextInjection(pi);
  registerCheckpoint(pi);
}
