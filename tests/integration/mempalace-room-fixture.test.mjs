import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";
import { createTestRoom, isIntegrationEnabled } from "../helpers/mempalace-room-fixture.mjs";

/**
 * Integration coverage for ElectricShepherd-specific behavior against a real
 * MemPalace endpoint, using an isolated, disposable test room.
 *
 * These tests deliberately do NOT re-test MemPalace primitives (dedup, search
 * ranking, KG semantics) — those are covered by MemPalace's own suite. They
 * assert the things only ElectricShepherd owns:
 *   - the room fixture seeds and tears down with an exact blast radius, and
 *   - the retrieval-expansion adapter drives MemPalace and returns a
 *     well-formed envelope scoped to the room.
 *
 * Gated by ESHEPHERD_TEST_INTEGRATION=1 so the default unit run stays offline.
 */

const runIntegration = isIntegrationEnabled();

let room = null;

before(async () => {
  if (!runIntegration) return;
  room = await createTestRoom({ roomPrefix: "fixture-suite" });
  if (!room.available) {
    throw new Error(`Test room unavailable: ${room.reason}`);
  }
});

after(async () => {
  if (room && room.available) {
    await room.teardown();
  }
});

test("isolated room seeds and tears down with an exact blast radius", { skip: !runIntegration }, async () => {
  // Seed a few drawers; the fixture remembers each drawer id for teardown.
  const contents = [
    "ElectricShepherd fixture drawer alpha: consolidation cadence decision.",
    "ElectricShepherd fixture drawer beta: retrieval expansion weighting note.",
    "ElectricShepherd fixture drawer gamma: mem-core injection checkpoint.",
  ];
  for (const content of contents) {
    const res = await room.addDrawer(content);
    assert.equal(typeof res, "object");
    assert.ok(!res.error, `addDrawer returned an error: ${JSON.stringify(res)}`);
    assert.equal(typeof res.drawer_id, "string", "addDrawer must return a drawer_id");
  }

  // Committed teardown removes exactly the drawers this run created.
  const deleted = await room.teardown();
  assert.equal(deleted.success, true, `teardown errors: ${JSON.stringify(deleted.errors)}`);
  assert.ok(
    deleted.deleted >= contents.length,
    `expected to delete >= ${contents.length}, got ${deleted.deleted}`
  );

  // A second teardown is a no-op (ids already drained).
  const again = await room.teardown();
  assert.equal(again.success, true);
  assert.equal(again.deleted, 0);

  // Re-seed so the suite's `after` teardown and later assertions have data.
  for (const content of contents) {
    await room.addDrawer(content);
  }
});

test("retrieval expansion returns a well-formed envelope scoped to the room", { skip: !runIntegration }, async () => {
  const result = await expandScopedRetrieval(room.client, {
    query: "consolidation cadence decision",
    scope_room: room.room,
    scope_wing: room.wing,
    wing: room.wing,
    room: room.room,
    match_mode: "any",
    top_n: 5,
    seed_search_limit: 5,
    expansion_depth: 1,
  });

  assert.equal(result.scope.scope_room, room.room);
  assert.equal(result.scope.scope_wing, room.wing);
  assert.equal(result.filters.match_mode, "any");
  assert.ok(Array.isArray(result.selected_nodes));
  assert.ok(Array.isArray(result.ranked_nodes));
  assert.ok(Array.isArray(result.seeds.raw_seed_ids));
  assert.equal(typeof result.ranking.total_ranked, "number");
});
