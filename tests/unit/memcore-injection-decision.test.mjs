import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMemcoreSignature,
  decideMemcoreInjection,
} from "../../adapter/turn-guard-helpers.ts";

/**
 * Unit coverage for the mem-core re-injection decision — the throttling rule
 * that governs whether scoped mem-core gets re-pushed into a live session on
 * idle. This is the part that decides whether a session sees fresh resident
 * memory after consolidation, without spamming identical payloads.
 *
 * The decision is pure; we test it directly instead of driving the whole
 * plugin handler (which does session I/O).
 */

const COOLDOWN = 15000;

test("computeMemcoreSignature is stable for same scope+content and differs otherwise", () => {
  const a = computeMemcoreSignature("pkg/sub", "hello world");
  const b = computeMemcoreSignature("pkg/sub", "hello world");
  const c = computeMemcoreSignature("pkg/sub", "hello there");
  const d = computeMemcoreSignature("pkg/other", "hello world");

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test("injects on the first call when there is no prior record", () => {
  const sig = computeMemcoreSignature("scope", "payload");
  const decision = decideMemcoreInjection({
    scopeDir: "scope",
    signature: sig,
    now: 1000,
    previous: null,
    cooldownMs: COOLDOWN,
  });

  assert.equal(decision.shouldInject, true);
  assert.equal(decision.changed, true);
  assert.equal(decision.cooldownElapsed, true);
});

test("suppresses an identical payload while the cooldown is still active", () => {
  const sig = computeMemcoreSignature("scope", "payload");
  const previous = { signature: sig, at: 1000, scopeDir: "scope" };
  const decision = decideMemcoreInjection({
    scopeDir: "scope",
    signature: sig,
    now: 1000 + COOLDOWN - 1, // not yet elapsed
    previous,
    cooldownMs: COOLDOWN,
  });

  assert.equal(decision.changed, false);
  assert.equal(decision.cooldownElapsed, false);
  assert.equal(decision.shouldInject, false);
});

test("re-injects changed content only after the cooldown elapses", () => {
  const previous = {
    signature: computeMemcoreSignature("scope", "old payload"),
    at: 1000,
    scopeDir: "scope",
  };
  const newSig = computeMemcoreSignature("scope", "new payload");

  // Changed but cooldown not elapsed -> still suppressed.
  const tooSoon = decideMemcoreInjection({
    scopeDir: "scope",
    signature: newSig,
    now: 1000 + COOLDOWN - 1,
    previous,
    cooldownMs: COOLDOWN,
  });
  assert.equal(tooSoon.changed, true);
  assert.equal(tooSoon.cooldownElapsed, false);
  assert.equal(tooSoon.shouldInject, false);

  // Changed and cooldown elapsed -> inject.
  const ready = decideMemcoreInjection({
    scopeDir: "scope",
    signature: newSig,
    now: 1000 + COOLDOWN,
    previous,
    cooldownMs: COOLDOWN,
  });
  assert.equal(ready.changed, true);
  assert.equal(ready.cooldownElapsed, true);
  assert.equal(ready.shouldInject, true);
});

test("force always injects, even for unchanged content within cooldown", () => {
  const sig = computeMemcoreSignature("scope", "payload");
  const previous = { signature: sig, at: 1000, scopeDir: "scope" };
  const decision = decideMemcoreInjection({
    scopeDir: "scope",
    signature: sig,
    now: 1000 + 1, // well within cooldown
    previous,
    cooldownMs: COOLDOWN,
    force: true,
  });

  assert.equal(decision.changed, false);
  assert.equal(decision.cooldownElapsed, false);
  assert.equal(decision.shouldInject, true);
});

test("treats a scope change as changed content", () => {
  const previous = {
    signature: computeMemcoreSignature("scope-a", "payload"),
    at: 1000,
    scopeDir: "scope-a",
  };
  // Same hashed text, different scope -> different signature AND scope change.
  const sig = computeMemcoreSignature("scope-b", "payload");
  const decision = decideMemcoreInjection({
    scopeDir: "scope-b",
    signature: sig,
    now: 1000 + COOLDOWN,
    previous,
    cooldownMs: COOLDOWN,
  });

  assert.equal(decision.changed, true);
  assert.equal(decision.shouldInject, true);
});
