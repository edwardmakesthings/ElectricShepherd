import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createTestRoom, isIntegrationEnabled, reportSkippedIntegrationTests } from "../helpers/mempalace-room-fixture.mjs";

/**
 * Rung 1 bootstrap — integration slice (spec §6.1), the "write-read" atoms of the
 * write-read-fail cycle verified end-to-end against a live MemPalace:
 *
 *   1. write a drawer and read it back verbatim,
 *   2. add a KG fact and query it back.
 *
 * Both run inside the isolated fixture room (dedicated `eshepherd-test` wing +
 * per-run room) so they never touch live user data; teardown removes exactly the
 * rows this run created. Gated by ESHEPHERD_TEST_INTEGRATION=1 like every other
 * endpoint-gated integration file, so the default unit run stays offline (exit 0).
 *
 * The "fail" atom (-32005 / transport surfacing) is covered deterministically in
 * tests/unit/rung1-bootstrap.test.mjs.
 */

const runIntegration = isIntegrationEnabled();
if (!runIntegration) reportSkippedIntegrationTests();

let room = null;

before(async () => {
  if (!runIntegration) return;
  room = await createTestRoom({ roomPrefix: "rung1" });
  if (!room.available) {
    throw new Error(`Test room unavailable: ${room.reason}`);
  }
});

after(async () => {
  if (room && room.available) {
    await room.teardown();
  }
});

test("rung1: write a drawer and read it back verbatim", { skip: !runIntegration }, async () => {
  const content = `Rung 1 bootstrap atom ${room.runId}: the drawer round-trips byte for byte.\nSecond line with special chars: "quotes", \\backslash\\, tabs\tand unicode é/ü.`;

  const added = await room.addDrawer(content);
  assert.equal(typeof added, "object");
  assert.ok(!added.error, `addDrawer returned an error: ${JSON.stringify(added)}`);
  assert.equal(typeof added.drawer_id, "string", "addDrawer must return a drawer_id");

  const read = await room.client.getDrawer({ drawer_id: added.drawer_id });
  assert.ok(read && typeof read === "object", "getDrawer returned no object");
  assert.ok(!read.error, `getDrawer returned an error: ${JSON.stringify(read)}`);
  assert.equal(typeof read.content, "string", "getDrawer must return content");
  assert.equal(read.content, content, "drawer content did not round-trip verbatim");
});

test("rung1: add a KG fact and query it back", { skip: !runIntegration }, async () => {
  // The subject is an entity unique to this run so the query-back can only match
  // the fact we just wrote, regardless of anything else in the palace.
  const subject = `rung1-subject-${room.runId}`;
  const predicate = "rung1-bootstrap";
  const object = `rung1-object-${room.runId}`;

  const added = await room.client.kgAdd({ subject, predicate, object });
  assert.ok(added === undefined || (typeof added === "object" && !added.error), `kgAdd failed: ${JSON.stringify(added)}`);

  const result = await room.client.kgQuery({ entity: subject, direction: "both" });
  const facts = Array.isArray(result?.facts) ? result.facts : [];
  assert.ok(
    facts.some((fact) => fact.subject === subject && fact.predicate === predicate && fact.object === object),
    `KG fact was not retrieved. facts: ${JSON.stringify(facts)}`
  );
});
