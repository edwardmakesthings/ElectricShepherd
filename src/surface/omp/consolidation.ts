/**
 * Auto-consolidation trigger for oh-my-pi.
 *
 * Runs the derived-memory pipeline over the raw session transcript after a
 * compaction folds a region, and again at settle for sessions that never grew
 * enough to compact.
 *
 * Reads the RAW entries, never the fold's own summary. `CompactionEntry.summary`
 * is lossy, so consolidating from it would build durable memory out of a
 * paraphrase — the verbatim rule forbids that. omp's session store is an
 * append-only JSONL log and compaction only moves the provider replay boundary,
 * so the original messages are still on disk; `firstKeptEntryId` is used purely
 * as a watermark saying which region just became eligible.
 *
 * The pipeline is a multi-minute subprocess and omp aborts an extension handler
 * after 30s, so the child is spawned DETACHED and the handler returns
 * immediately.
 *
 * Mutual exclusion is the SCRIPT's job, not this driver's:
 * run-memory-consolidation-and-validation.ts acquires and releases
 * `.electric-shepherd/auto-consolidation.lock` around its own run. Taking that
 * same lock here would make every launch self-deadlock — the child would find
 * the lock held by its own parent and exit with `consolidation-lock-held`. This
 * driver therefore only rate-limits, via a cooldown so successive folds in one
 * session do not queue runs back to back.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  OmpExtensionApi,
  OmpExtensionContext,
  OmpSessionCompactEvent,
  OmpSessionStopEvent,
} from "./api.ts";
import { isTrue, log, resolveEnv, toNumber, type EsEnv } from "./runtime.ts";

const ES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONSOLIDATION_SCRIPT = join(ES_ROOT, "src", "scripts", "run-memory-consolidation-and-validation.ts");

/** Walk up from cwd to the nearest package.json/.git, matching the memcore loader. */
function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "package.json")) || existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

/** Launch the pipeline detached. The script takes its own lock and reports the outcome. */
function launch(pi: OmpExtensionApi, env: EsEnv, projectRoot: string, sessionID: string, trigger: string): void {
  const storeRoot = env.ESHEPHERD_MEMCORE_STORE_ROOTS?.split(",")[0]?.trim();
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      CONSOLIDATION_SCRIPT,
      "--run-cadence",
      "--cadence-mode",
      "execute",
      "--include-base-pipeline",
      "--apply",
      "--mem-core-file",
      storeRoot ? join(storeRoot, "memory.md") : ".electric-shepherd/memory/memory.md",
    ],
    {
      cwd: projectRoot,
      // The run must outlive this handler (and this session), so it is fully
      // detached and unref'd: the lock, not the parent, bounds it.
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...env,
        // Keep the harnesses independent: an omp session must not drive its
        // mapper through opencode just because that binary resolves first.
        ESHEPHERD_SUBAGENT_BIN: env.ESHEPHERD_SUBAGENT_BIN || process.execPath,
        ESHEPHERD_CONSOLIDATION_TRIGGER: trigger,
        ESHEPHERD_CONSOLIDATION_SESSION: sessionID,
      },
    },
  );
  child.unref();
  log(pi, `consolidation launched (${trigger}) pid=${child.pid} session=${sessionID}`);
}

export function registerConsolidation(pi: OmpExtensionApi): void {
  const consolidatedSessions = new Set<string>();
  let lastLaunchedAtMs = 0;

  const maybeRun = (ctx: OmpExtensionContext, sessionID: string, trigger: string, onCompact: boolean): void => {
    const cwd = ctx.cwd || process.cwd();
    const env = resolveEnv(cwd, import.meta.url);
    if (!isTrue(env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED)) return;
    if (onCompact && !isTrue(env.ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT)) return;
    if (!onCompact && !isTrue(env.ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE)) return;

    // Nothing releases a lock on this side, so the cooldown is what stops
    // successive folds from queueing runs the moment the previous one exits.
    const cooldownMs = toNumber(env.ESHEPHERD_AUTO_CONSOLIDATION_COOLDOWN_MS, 600000);
    const sinceLast = Date.now() - lastLaunchedAtMs;
    if (lastLaunchedAtMs && sinceLast < cooldownMs) {
      log(pi, `consolidation skipped (${trigger}): ${Math.ceil((cooldownMs - sinceLast) / 1000)}s left on cooldown`);
      return;
    }

    try {
      launch(pi, env, findProjectRoot(cwd), sessionID, trigger);
      lastLaunchedAtMs = Date.now();
      consolidatedSessions.add(sessionID);
    } catch (err) {
      // Named degradation: consolidation is background bookkeeping. A failure to
      // spawn must not surface in the session or block the fold/settle.
      log(pi, `consolidation launch failed (${trigger}): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // After the fold: the region behind firstKeptEntryId is now eligible, and its
  // raw entries are still on disk.
  pi.on("session_compact", (event: OmpSessionCompactEvent, ctx: OmpExtensionContext) => {
    maybeRun(ctx, String(event.compactionEntry?.firstKeptEntryId || "unknown"), "compact", true);
  });

  // Settle: covers sessions that did real work but never grew enough to compact.
  // Registered BEFORE the checkpoint handler and always returns undefined — omp
  // short-circuits `session_stop` dispatch on the first result carrying a
  // continuation, so a handler that returned one here would suppress the
  // checkpoint entirely.
  pi.on("session_stop", (event: OmpSessionStopEvent, ctx: OmpExtensionContext) => {
    if (event.stop_hook_active) return;
    const sessionID = String(event.session_id || "").trim();
    if (!sessionID || consolidatedSessions.has(sessionID)) return;
    maybeRun(ctx, sessionID, "settle", false);
  });
}
