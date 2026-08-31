import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createTestRoom, isIntegrationEnabled, reportSkippedIntegrationTests } from "../helpers/mempalace-room-fixture.mjs";

/**
 * Rung 1 bootstrap — integration slice (spec §6.1), the "write-read" atoms of the
 * write-read-fail cycle verified end-to-end against a live MemPalace:
 *
 *   1. write a drawer and read it back verbatim,
 *   2. add a KG fact and query it back,
 *   3. resolve a canonical id and compute a height over a real synthesized-from edge,
 *   4. iterate every page of the room with a bounded page size and an explicit
 *      termination condition (short page), without unbounded memory growth or timeout.
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

test("rung1: resolve a canonical id and compute a height", { skip: !runIntegration }, async () => {
  // Build the smallest real synthesis DAG in the fixture room: one source drawer,
  // one derived (synthesis) node with a single synthesized-from edge to it. A
  // non-merged node resolves canonically to itself; its height is 1 (one hop
  // above a source leaf). Both reads go through the memgraph client boundary, so
  // any substrate failure surfaces as a throw — never an empty result.
  const source = await room.addDrawer(`Rung 1 canonical/height atom ${room.runId}: source drawer for the lineage edge.`);
  assert.ok(!source?.error, `addDrawer(source) failed: ${JSON.stringify(source)}`);
  const sourceId = source.drawer_id;

  const synthId = `rung1-synth-${room.runId}`;
  await room.client.kgAdd({ subject: synthId, predicate: "synthesized-from", object: sourceId });

  // Resolve the canonical id: no merged-into chain exists for this run's node, so
  // the resolution must come back to the node itself.
  const resolved = room.client.resolveCanonical(synthId);
  assert.ok(resolved && typeof resolved === "object", "resolveCanonical returned no object");
  const canonicalId = String(resolved.canonical_node_id || resolved.node_id || "").trim();
  assert.equal(canonicalId, synthId, `expected canonical resolution to return the node itself, got ${JSON.stringify(resolved)}`);

  // Compute the height: exactly one synthesized-from parent (a source leaf) → 1.
  const heightRes = room.client.getHeight(synthId);
  assert.ok(heightRes && typeof heightRes === "object", "getHeight returned no object");
  const height = Number(heightRes.height);
  assert.ok(Number.isFinite(height), `height was not numeric: ${JSON.stringify(heightRes)}`);
  assert.equal(height, 1, `expected height 1 for a single synthesized-from edge, got ${height}`);
});

test("rung1: iterate every page of a room with bounded page size and explicit termination", { skip: !runIntegration }, async () => {
  // Seed exactly N drawers into the (unique per run) fixture room, then walk it
  // with a deliberately small page size. Termination is EXPLICIT and two-fold:
  //   - a short page (fewer rows than requested) ends the walk — the normal path;
  //   - a hard max-page cap guards against an unbounded loop (it must never fire).
  // The accumulator holds only drawer ids, so memory stays bounded regardless of
  // row payload size. No timing assumptions: pure request/response paging.
  const N = 5;
  const pageSize = 2;
  const maxPages = Math.ceil(N / pageSize) + 1; // one page past the theoretical minimum

  const seededIds = [];
  for (let i = 0; i < N; i += 1) {
    const added = await room.addDrawer(`Rung 1 paging atom ${room.runId}: row ${i} of ${N}.`);
    assert.ok(!added?.error, `addDrawer(row ${i}) failed: ${JSON.stringify(added)}`);
    seededIds.push(added.drawer_id);
  }

  const seen = new Set();
  let offset = 0;
  let pagesFetched = 0;
  let terminatedOnShortPage = false;

  while (pagesFetched < maxPages) {
    const page = room.client.listDrawers({ wing: room.wing, room: room.room, limit: pageSize, offset });
    assert.ok(page && typeof page === "object", "listDrawers returned no object");
    pagesFetched += 1;

    const rows = Array.isArray(page.drawers) ? page.drawers : [];
    for (const row of rows) {
      const id = String(row.drawer_id || row.node_id || row.id || "").trim();
      if (id) seen.add(id);
    }

    // Explicit termination: a short page means the room is exhausted.
    if (rows.length < pageSize) {
      terminatedOnShortPage = true;
      break;
    }
    offset += rows.length;
  }

  assert.ok(terminatedOnShortPage, `walk did not terminate on a short page (fetched ${pagesFetched} of the ${maxPages}-page cap)`);
  assert.equal(pagesFetched, Math.ceil(N / pageSize), `expected exactly ${Math.ceil(N / pageSize)} pages for ${N} rows at page size ${pageSize}, fetched ${pagesFetched}`);

  // Every seeded row was seen exactly once (Set dedupes; the fixture room is unique to this run).
  for (const id of seededIds) {
    assert.ok(seen.has(id), `seeded drawer ${id} was not returned by any page`);
  }
  assert.equal(seen.size, N, `expected exactly ${N} distinct rows in the room, saw ${seen.size}: ${[...seen].join(", ")}`);
});
