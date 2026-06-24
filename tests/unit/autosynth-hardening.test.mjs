import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneAutoSynthTracking } from "../../adapter/turn-guard-helpers.ts";
import {
  acquireSynthLock,
  isSynthLockFresh,
  releaseSynthLock,
  SYNTH_LOCK_DIR,
  SYNTH_LOCK_FILE,
} from "../../scripts/synth-lock.ts";

/**
 * Unit coverage for the orphan/leak-hardening helpers:
 *  - pruneAutoSynthTracking bounds the per-session tracking maps so a long-lived
 *    process cannot leak memory across thousands of sessions.
 *  - the shared synth-lock (acquire/release/freshness) coordinates plugin, cron,
 *    and n8n runs through one lockfile and self-heals orphaned locks.
 */

test("pruneAutoSynthTracking evicts oldest sessions from both maps to the limit", () => {
  const activity = new Map();
  const lastRun = new Map();
  for (let i = 0; i < 10; i += 1) {
    activity.set(`s${i}`, i);
    lastRun.set(`s${i}`, i * 1000);
  }

  pruneAutoSynthTracking(activity, lastRun, 4);

  assert.equal(activity.size, 4);
  assert.equal(lastRun.size, 4);
  // Oldest (s0..s5) evicted; newest retained.
  assert.ok(!activity.has("s0"));
  assert.ok(!lastRun.has("s0"));
  assert.ok(activity.has("s9"));
  assert.ok(lastRun.has("s9"));
});

test("pruneAutoSynthTracking is a no-op when under the limit or limit<=0", () => {
  const activity = new Map([["a", 1]]);
  const lastRun = new Map([["a", 1]]);

  pruneAutoSynthTracking(activity, lastRun, 8);
  assert.equal(activity.size, 1);

  pruneAutoSynthTracking(activity, lastRun, 0);
  assert.equal(activity.size, 1);
});

test("pruneAutoSynthTracking also trims orphan keys left only in lastRun", () => {
  const activity = new Map();
  const lastRun = new Map();
  for (let i = 0; i < 6; i += 1) lastRun.set(`s${i}`, i);

  pruneAutoSynthTracking(activity, lastRun, 2);

  assert.equal(lastRun.size, 2);
});

test("isSynthLockFresh: fresh within window, stale past it, false for empty", () => {
  const now = 1_000_000;
  assert.equal(isSynthLockFresh(now - 1000, now, 5000), true);
  assert.equal(isSynthLockFresh(now - 9000, now, 5000), false);
  assert.equal(isSynthLockFresh(0, now, 5000), false);
});

test("acquireSynthLock: holds, blocks a second fresh acquire, releases", () => {
  const root = mkdtempSync(join(tmpdir(), "es-synth-lock-"));
  try {
    const lockPath = join(root, SYNTH_LOCK_DIR, SYNTH_LOCK_FILE);

    assert.equal(acquireSynthLock(root, { source: "test" }, 300000), true);
    assert.ok(existsSync(lockPath));

    // A second acquire while the lock is fresh is refused.
    assert.equal(acquireSynthLock(root, { source: "test2" }, 300000), false);

    releaseSynthLock(root);
    assert.ok(!existsSync(lockPath));

    // After release a new acquire succeeds again.
    assert.equal(acquireSynthLock(root, { source: "test3" }, 300000), true);
    releaseSynthLock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireSynthLock reclaims an orphaned (stale) lock", () => {
  const root = mkdtempSync(join(tmpdir(), "es-synth-lock-"));
  try {
    const lockPath = join(root, SYNTH_LOCK_DIR, SYNTH_LOCK_FILE);
    acquireSynthLock(root, { source: "owner" }, 300000);

    // Backdate the lock so it is older than the staleness window.
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    raw.startedAtMs = Date.now() - 10_000;
    writeFileSync(lockPath, JSON.stringify(raw), "utf8");

    // staleMs=1000 => the existing lock is stale and gets reclaimed.
    assert.equal(acquireSynthLock(root, { source: "reclaimer" }, 1000), true);
    releaseSynthLock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
