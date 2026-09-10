/**
 * Electric Shepherd as an oh-my-pi extension.
 *
 * Registering this directory as an omp extension root also makes omp discover
 * the bundled `agents/`, `commands/` and `skills/` beside it, so the asset
 * injection OpenCode needs (src/surface/asset-loader.ts) has no counterpart here.
 *
 * Tools only, for now. The policy hooks that OpenCode drives through
 * `src/surface/plugin/session-policy.ts` (config, event, tool.execute.before)
 * map onto omp's `session_start`, `message_end`/`turn_end`/`session_stop`/
 * `session_compact` and `tool_call` events, and are not wired yet.
 */

import { registerEsTools, type OmpExtensionApi } from "./tool-adapter.ts";

export default function electricShepherd(pi: OmpExtensionApi) {
  registerEsTools(pi);
}
