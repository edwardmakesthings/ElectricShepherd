import assert from "node:assert/strict";
import test from "node:test";

import { decideAutoSynth } from "../../adapter/turn-guard-helpers.ts";

/**
 * Unit coverage for the automatic-synthesis decision — the opt-in gate that
 * decides whether the plugin spawns a background consolidation run. The decision
 * is pure (no timers, no child processes), so we test the gating logic directly:
 * the master switch, the in-flight guard, the cooldown throttle, and the
 * per-trigger activity requirements.
 */

const COOLDOWN = 600000; // 10 min
const THRESHOLD = 12;

function base(overrides = {}) {
  return {
    enabled: true,
    now: 1_000_000,
    lastRunAt: null,
    cooldownMs: COOLDOWN,
    messagesSinceRun: 0,
    messageThreshold: THRESHOLD,
    trigger: "idle-timer",
    inFlight: false,
    ...overrides,
  };
}

test("never runs when disabled", () => {
  const d = decideAutoSynth(base({ enabled: false, trigger: "compacted", messagesSinceRun: 999 }));
  assert.equal(d.shouldRun, false);
  assert.equal(d.reason, "disabled");
});

test("never runs while a previous run is in flight", () => {
  const d = decideAutoSynth(base({ inFlight: true, trigger: "compacted", messagesSinceRun: 999 }));
  assert.equal(d.shouldRun, false);
  assert.equal(d.reason, "in-flight");
});

test("respects the cooldown window", () => {
  const d = decideAutoSynth(
    base({ trigger: "volume", lastRunAt: 1_000_000 - (COOLDOWN - 1), messagesSinceRun: THRESHOLD }),
  );
  assert.equal(d.shouldRun, false);
  assert.equal(d.reason, "cooldown");
});

test("runs once the cooldown window has elapsed", () => {
  const d = decideAutoSynth(
    base({ trigger: "volume", lastRunAt: 1_000_000 - COOLDOWN, messagesSinceRun: THRESHOLD }),
  );
  assert.equal(d.shouldRun, true);
  assert.equal(d.reason, "volume-threshold");
});

test("volume trigger waits for the message threshold", () => {
  const below = decideAutoSynth(base({ trigger: "volume", messagesSinceRun: THRESHOLD - 1 }));
  assert.equal(below.shouldRun, false);
  assert.equal(below.reason, "below-threshold");

  const at = decideAutoSynth(base({ trigger: "volume", messagesSinceRun: THRESHOLD }));
  assert.equal(at.shouldRun, true);
  assert.equal(at.reason, "volume-threshold");
});

test("idle-timer requires at least one new turn since the last run", () => {
  const noActivity = decideAutoSynth(base({ trigger: "idle-timer", messagesSinceRun: 0 }));
  assert.equal(noActivity.shouldRun, false);
  assert.equal(noActivity.reason, "no-activity");

  const withActivity = decideAutoSynth(base({ trigger: "idle-timer", messagesSinceRun: 1 }));
  assert.equal(withActivity.shouldRun, true);
  assert.equal(withActivity.reason, "idle-timer");
});

test("compacted trigger always runs when enabled", () => {
  const d = decideAutoSynth(
    base({ trigger: "compacted", messagesSinceRun: 0, lastRunAt: 1_000_000 - (COOLDOWN - 1) }),
  );
  assert.equal(d.shouldRun, true);
  assert.equal(d.reason, "compacted");
});
