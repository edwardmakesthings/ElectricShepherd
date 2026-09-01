// @ts-nocheck

/**
 * Environment / process-plumbing helpers extracted from turn-guard.ts.
 *
 * These functions build the `env` object passed to child processes (the
 * mem-core loader, source-capture script, and auto-consolidation runner).
 * They are pure: given the same inputs they produce the same env object, with
 * no side effects beyond reading `process.env` / `process.platform`.
 */

export interface SourceCaptureEnvArgs {
  sid: string;
  eventType: string;
  projectRoot: string;
}

export interface ConsolidationEnvArgs {
  sid: string;
  trigger: string;
  projectRoot: string;
  agent?: string;
  modelProviderID?: string;
  modelID?: string;
}

/**
 * Build the env for the source-capture verification command. The script runs
 * with cwd = ESHEPHERD_ROOT (the plugin install) and sources its env from
 * there, so we pass the consumer project root explicitly via
 * ESHEPHERD_PROJECT_ROOT to keep wing/room config resolving against the real
 * project rather than the plugin's own directory.
 */
export function buildSourceCaptureEnv(args: SourceCaptureEnvArgs): Record<string, string> {
  return {
    ...process.env,
    ESHEPHERD_SESSION_ID: args.sid,
    ESHEPHERD_EVENT_TYPE: args.eventType,
    // Script cwd is the plugin install (see above); tell it where the real
    // consumer project lives so wing/room config resolves against THAT
    // project, not the plugin's own directory.
    ESHEPHERD_PROJECT_ROOT: args.projectRoot,
  }
}

/**
 * Build the env for the auto-consolidation child process. The plugin already
 * holds the shared lock; ESHEPHERD_CONSOLIDATION_LOCK_INHERITED tells the
 * child runner not to re-acquire (or release) it so the plugin->script
 * handoff doesn't deadlock against itself. Standalone cron/n8n runs lack this
 * flag and take the lock themselves. cwd is the plugin install; the consumer
 * project owns the memory artifacts, hence ESHEPHERD_PROJECT_ROOT.
 */
export function buildConsolidationEnv(args: ConsolidationEnvArgs): Record<string, string> {
  return {
    ...process.env,
    ESHEPHERD_SESSION_ID: args.sid,
    ESHEPHERD_EVENT_TYPE: `auto-consolidation:${args.trigger}`,
    // The plugin already holds the shared lock; tell the child runner not to
    // re-acquire (or release) it so the plugin->script handoff doesn't
    // deadlock against itself. Standalone cron/n8n runs lack this flag and
    // take the lock themselves.
    ESHEPHERD_CONSOLIDATION_LOCK_INHERITED: "1",
    // cwd is the plugin install; the consumer project owns the memory artifacts.
    ESHEPHERD_PROJECT_ROOT: args.projectRoot,
    ESHEPHERD_ACTIVE_AGENT: args.agent,
    ESHEPHERD_ACTIVE_MODEL_PROVIDER_ID: args.modelProviderID,
    ESHEPHERD_ACTIVE_MODEL_ID: args.modelID,
  }
}
