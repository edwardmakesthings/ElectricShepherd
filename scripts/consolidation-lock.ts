/**
 * Shared cross-process lock for memory consolidation runs.
 *
 * This is the *standalone* (CLI / cron / n8n) counterpart to the inline lock the
 * turn-guard plugin holds. Both write the SAME file
 * (`.electric-shepherd/auto-consolidation.lock`) with the SAME shape (`{ pid, startedAtMs,
 * ... }`), so a plugin-triggered run, a cron run, and an n8n run all coordinate
 * through one lock and can never overlap.
 *
 * The format must stay byte-compatible with the copy in `plugin/turn-guard.ts`
 * (which cannot import this module because it is constrained to a single file with
 * node built-ins only). If you change the field names here, change them there too.
 *
 * When the plugin spawns this script it sets `ESHEPHERD_CONSOLIDATION_LOCK_INHERITED=1`;
 * the caller is responsible for skipping acquire/release in that case so the
 * plugin->script handoff does not deadlock against the lock the plugin already
 * holds.
 */

// @ts-expect-error runtime script package does not include node typings
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error runtime script package does not include node typings
import { join } from "node:path";

declare const process: { pid: number };

export const CONSOLIDATION_LOCK_DIR = ".electric-shepherd";
export const CONSOLIDATION_LOCK_FILE = "auto-consolidation.lock";

/** A lock is fresh (still owned) while it is younger than the staleness window. */
export function isConsolidationLockFresh(startedAtMs: number, nowMs: number, staleMs: number): boolean {
  return startedAtMs > 0 && nowMs - startedAtMs < staleMs;
}

/**
 * Try to take the shared consolidation lock using atomic exclusive file creation.
 * Returns false when a still-fresh lock is held by another run. An orphaned lock
 * (older than `staleMs`, e.g. the owner crashed) is reclaimed via unlink + retry.
 * Fails CLOSED on unexpected filesystem errors: a skipped consolidation is recoverable;
 * a double-write race is not.
 */
export function acquireConsolidationLock(
  projectRoot: string,
  payload: Record<string, unknown>,
  staleMs: number,
): boolean {
  const dir = join(projectRoot, CONSOLIDATION_LOCK_DIR);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, CONSOLIDATION_LOCK_FILE);

  // Atomic exclusive create — fails with EEXIST if another process already holds it.
  try {
    const content = `${JSON.stringify({ ...payload, pid: process.pid, startedAtMs: Date.now() }, null, 2)}\n`;
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, content, "utf8");
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== "EEXIST") {
      // Unexpected FS error — fail closed to prevent double-write races.
      throw err;
    }

    // Lock file exists — check if it is stale before backing off.
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8"));
      const startedAtMs = Number(raw?.startedAtMs || 0);
      if (isConsolidationLockFresh(startedAtMs, Date.now(), staleMs)) {
        return false; // fresh lock held by another process
      }
    } catch {
      // unreadable/corrupt lock -> treat as stale
    }

    // Stale lock — reclaim it atomically: unlink first, then retry wx-create.
    // If the retry fails with EEXIST, another process won the race; back off.
    try {
      unlinkSync(lockPath);
    } catch {
      // Could not remove stale lock — fail closed.
      throw new Error(`Failed to reclaim stale consolidation lock at ${lockPath}`);
    }

    try {
      const content = `${JSON.stringify({ ...payload, pid: process.pid, startedAtMs: Date.now() }, null, 2)}\n`;
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, content, "utf8");
      closeSync(fd);
      return true;
    } catch (retryErr: unknown) {
      if ((retryErr as { code?: string }).code === "EEXIST") {
        return false; // another process won the race during our reclaim window
      }
      throw retryErr; // fail closed on unexpected errors
    }
  }
}

export function releaseConsolidationLock(projectRoot: string): void {
  try {
    const lockPath = join(projectRoot, CONSOLIDATION_LOCK_DIR, CONSOLIDATION_LOCK_FILE);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // best-effort release; a leftover lock self-heals after the staleness window
  }
}
