import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCondition,
  globMatch,
  matchReminder,
  matchRemindersForScope,
  renderPendingLines,
} from "../../adapter/prospective.ts";

/**
 * Unit coverage for Phase 8 (unified memory): the pure prospective-memory matcher.
 * No MCP, no fs — this is the CONSUME half of "pushed by circumstance", and the
 * spec's PROVE (reminder present in an in-glob render, absent out-of-glob) reduces
 * to these assertions. Pins: condition classification, glob semantics (including
 * ancestor firing), topic/scope matching, render-time expiry drop, status gating,
 * and the hard cap on the [pending] block.
 */

const NOW = () => new Date("2026-08-26T12:00:00.000Z");

function reminder(overrides = {}) {
  return {
    drawer_id: "drawer_proj_reminders_x",
    what: "watch PR #25165 for Laguna support",
    conditions: ["web/src/**"],
    status: "active",
    expires_at: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

test("classifyCondition: path/glob, wing/room scope, and topic kinds", () => {
  assert.equal(classifyCondition("web/src/features/controlPanel/**"), "path");
  assert.equal(classifyCondition("web/src/*.ts"), "path");
  assert.equal(classifyCondition("docs/??.md"), "path");
  assert.equal(classifyCondition("opencode/synthesis"), "scope");
  // Multi-word phrases classify as `path` (no separators) but the matcher treats
  // them as topics — pinned by the matching tests below; classify stays conservative.
  assert.equal(classifyCondition("llama.cpp"), "topic");
  assert.equal(classifyCondition("web/src/deep/nested/path"), "path");
});

test("globMatch: ** crosses segments, * stays within a segment", () => {
  assert.equal(globMatch("web/src/features/x", "web/src/**"), true);
  assert.equal(globMatch("web/src", "web/src/**"), true, "a trailing /** also matches the base dir itself");
  assert.equal(globMatch("web/srcx/features", "web/src/**"), false, "** must not match a sibling prefix (web/srcx is not under web/src)");
  assert.equal(globMatch("docs/readme.md", "docs/*.md"), true);
  assert.equal(globMatch("docs/sub/readme.md", "docs/*.md"), false, "* must not cross segments");
  assert.equal(globMatch("a/b/c", "**/b/**"), true);
  assert.equal(globMatch("web/src/features/controlPanel", "web/src/features/controlPanel/**"), true);
});

test("PROVE core: a path-glob reminder fires for a dir inside the glob and not outside", () => {
  const scopeInside = { relScopes: ["", "web", "web/src", "web/src/features"], wing: "opencode", room: "synthesis" };
  const scopeOutside = { relScopes: ["", "docs"], wing: "opencode", room: "synthesis" };

  const inside = matchReminder(reminder(), scopeInside, NOW());
  assert.ok(inside, "in-glob scope must fire the reminder");
  assert.deepEqual(inside.via, [{ condition: "web/src/**", kind: "path" }]);

  const outside = matchReminder(reminder(), scopeOutside, NOW());
  assert.equal(outside, null, "out-of-glob scope must NOT fire the reminder");
});

test("ancestor firing: a trigger on an ancestor path fires for every directory beneath it", () => {
  const deepScope = { relScopes: ["", "web", "web/src", "web/src/features", "web/src/features/x"], wing: "w", room: "r" };
  assert.ok(matchReminder(reminder({ conditions: ["web"] }), deepScope, NOW()));
  assert.ok(matchReminder(reminder({ conditions: ["web/src"] }), deepScope, NOW()));
  assert.equal(matchReminder(reminder({ conditions: ["docs"] }), deepScope, NOW()), null);
});

test("topic keyword fires on query containment only", () => {
  const scope = { relScopes: [""], wing: "w", room: "synthesis", query: "prompt caching rollout" };
  assert.ok(matchReminder(reminder({ conditions: ["prompt caching"] }), scope, NOW()));
  assert.equal(matchReminder(reminder({ conditions: ["llama.cpp"] }), scope, NOW()), null);
  // Topic also matches the target room name (room names are kebab-case).
  const roomScope = { relScopes: [""], wing: "w", room: "llama_cpp" };
  assert.ok(matchReminder(reminder({ conditions: ["llama.cpp"] }), roomScope, NOW()));
});

test("wing/room scope kind fires on equality", () => {
  const r = reminder({ conditions: ["opencode/synthesis"] });
  assert.ok(matchReminder(r, { relScopes: [""], wing: "opencode", room: "synthesis" }, NOW()));
  assert.equal(matchReminder(r, { relScopes: [""], wing: "opencode", room: "other" }, NOW()), null);
  assert.equal(matchReminder(r, { relScopes: [""], wing: "elsewhere", room: "synthesis" }, NOW()), null);
});

test("expired reminders are dropped at match time; unexpired kept", () => {
  const expired = reminder({ expires_at: "2026-08-01T00:00:00.000Z" });
  assert.equal(matchReminder(expired, { relScopes: ["web/src"], wing: "w", room: "r" }, NOW()), null);

  const unexpired = reminder({ expires_at: "2026-12-31T00:00:00.000Z" });
  assert.ok(matchReminder(unexpired, { relScopes: ["web/src"], wing: "w", room: "r" }, NOW()));

  // Expiry boundary: now >= expiry is expired.
  const atBoundary = reminder({ expires_at: "2026-08-26T12:00:00.000Z" });
  assert.equal(matchReminder(atBoundary, { relScopes: ["web/src"], wing: "w", room: "r" }, NOW()), null);
});

test("non-active reminders never fire (satisfied and expired statuses)", () => {
  const scope = { relScopes: ["web/src"], wing: "w", room: "r" };
  assert.equal(matchReminder(reminder({ status: "satisfied" }), scope, NOW()), null);
  assert.equal(matchReminder(reminder({ status: "expired" }), scope, NOW()), null);
});

test("multiple conditions: any one firing is enough; deterministic via order", () => {
  const r = reminder({ conditions: ["docs/**", "prompt caching"] });
  const m1 = matchReminder(r, { relScopes: ["docs/x"], wing: "w", room: "r" }, NOW());
  assert.ok(m1);
  assert.deepEqual(m1.via, [{ condition: "docs/**", kind: "path" }]);

  const m2 = matchReminder(r, { relScopes: [""], wing: "w", room: "r", query: "prompt caching" }, NOW());
  assert.ok(m2);
  assert.deepEqual(m2.via, [{ condition: "prompt caching", kind: "topic" }]);

  const both = matchReminder(r, { relScopes: ["docs/x"], wing: "w", room: "r", query: "prompt caching" }, NOW());
  assert.equal(both.via.length, 2);
});

test("matchRemindersForScope preserves input order and filters non-matches", () => {
  const scope = { relScopes: ["web/src"], wing: "w", room: "r" };
  const matches = matchRemindersForScope(
    [
      reminder({ drawer_id: "a", conditions: ["docs/**"] }),
      reminder({ drawer_id: "b", conditions: ["web/src/**"] }),
      reminder({ drawer_id: "c", status: "satisfied", conditions: ["web/src/**"] }),
      reminder({ drawer_id: "d", conditions: ["web/src/**"] }),
    ],
    scope,
    NOW(),
  );
  assert.deepEqual(matches.map((m) => m.reminder.drawer_id), ["b", "d"]);
});

test("renderPendingLines: capped at a handful, omits the block when empty, notes overflow", () => {
  const matches = Array.from({ length: 5 }, (_, i) => ({
    reminder: reminder({ drawer_id: `r${i}`, what: `do thing ${i}` }),
    via: [{ condition: "web/src/**", kind: "path" }],
  }));

  const empty = renderPendingLines([], 3);
  assert.deepEqual(empty, [], "no matches -> no block (no per-prompt tax)");

  const capped = renderPendingLines(matches, 3);
  // Header 2 lines + 3 bullets + 1 overflow line.
  assert.equal(capped.length, 6, JSON.stringify(capped));
  assert.equal(capped[0], "## [pending]");
  assert.match(capped[2], /do thing 0/);
  assert.match(capped[4], /do thing 2/);
  assert.match(capped[5], /\(2 more pending; see \/reminders\)/);

  // cap=0 disables the section entirely.
  assert.deepEqual(renderPendingLines(matches, 0), []);

  // Bullet shape: text + trigger kind:value + expiry date.
  const one = renderPendingLines([matches[0]], 3);
  assert.match(one[2], /^- do thing 0 \(trigger path:web\/src\/\*\* .*expires 2026-09-30\)$/);
});
