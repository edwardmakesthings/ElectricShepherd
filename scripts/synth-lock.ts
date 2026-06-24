/**
 * Shared cross-process lock for memory synthesis runs.
 *
 * This is the *standalone* (CLI / cron / n8n) counterpart to the inline lock the
 * turn-guard plugin holds. Both write the SAME file
 * (`.electric-shepherd/auto-synth.lock`) with the SAME shape (`{ pid, startedAtMs,
 * ... }`), so a plugin-triggered run, a cron run, and an n8n run all coordinate
 * through one lock and can never overlap.
 *
 * The format must stay byte-compatible with the copy in `plugin/turn-guard.ts`
 * (which cannot import this module because it is constrained to a single file with
 * node built-ins only). If you change the field names here, change them there too.
 *
 * When the plugin spawns this script it sets `ESHEPHERD_SYNTH_LOCK_INHERITED=1`;
 * the caller is responsible for skipping acquire/release in that case so the
 * plugin->script handoff does not deadlock against the lock the plugin already
 * holds.
 */

// @ts-expect-error runtime script package does not include node typings
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error runtime script package does not include node typings
import { join } from "node:path";

declare const process: { pid: number };

export const SYNTH_LOCK_DIR = ".electric-shepherd";
export const SYNTH_LOCK_FILE = "auto-synth.lock";

/** A lock is fresh (still owned) while it is younger than the staleness window. */
export function isSynthLockFresh(startedAtMs: number, nowMs: number, staleMs: number): boolean {
  return startedAtMs > 0 && nowMs - startedAtMs < staleMs;
}

/**
 * Try to take the shared synthesis lock. Returns false when a still-fresh lock is
 * held by another run. An orphaned lock (older than `staleMs`, e.g. the owner
 * crashed) is reclaimed. Fails OPEN on filesystem errors: a disk hiccup must not
 * permanently wedge synthesis.
 */
export function acquireSynthLock(
  projectRoot: string,
  payload: Record<string, unknown>,
  staleMs: number,
): boolean {
  try {
    const dir = join(projectRoot, SYNTH_LOCK_DIR);
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, SYNTH_LOCK_FILE);
    if (existsSync(lockPath)) {
      try {
        const raw = JSON.parse(readFileSync(lockPath, "utf8"));
        const startedAtMs = Number(raw?.startedAtMs || 0);
        if (isSynthLockFresh(startedAtMs, Date.now(), staleMs)) {
          return false;
        }
      } catch {
        // unreadable/corrupt lock -> treat as stale and reclaim
      }
    }
    writeFileSync(
      lockPath,
      `${JSON.stringify({ ...payload, pid: process.pid, startedAtMs: Date.now() }, null, 2)}\n`,
      "utf8",
    );
    return true;
  } catch {
    return true;
  }
}

export function releaseSynthLock(projectRoot: string): void {
  try {
    const lockPath = join(projectRoot, SYNTH_LOCK_DIR, SYNTH_LOCK_FILE);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // best-effort release; a leftover lock self-heals after the staleness window
  }
}
